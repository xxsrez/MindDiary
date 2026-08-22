import type { ObjectStore } from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  BUNDLE_FILE_MEDIA_TYPES,
  canonicalBundleFilePath,
  canonicalMarkdownPath,
  type CanonicalRevisionEnvelope,
  type MarkdownMediaType,
  type CanonicalObjectMediaType,
  type RevisionId,
  type Sha256Digest,
  type SpaceId,
} from "@mind-diary/domain";
import {
  OKF_VERSION,
  validateOkfBundle,
  type OkfDiagnostic,
} from "@mind-diary/okf-codec";

export const OKF_EXPORT_CONFIG = Object.freeze({
  archiveFormat: "MD-OKF-ZIP-1",
  mediaType: "application/zip",
  filename: "mind-diary-okf-bundle.zip",
  contentDisposition:
    'attachment; filename="mind-diary-okf-bundle.zip"',
} as const);

export const BUNDLE_EXPORT_CONFIG = Object.freeze({
  archiveFormat: "MD-BUNDLE-ZIP-1",
  mediaType: "application/zip",
  filename: "mind-diary-bundle.zip",
  contentDisposition: 'attachment; filename="mind-diary-bundle.zip"',
} as const);

export type ExportProfile =
  | typeof OKF_EXPORT_CONFIG.archiveFormat
  | typeof BUNDLE_EXPORT_CONFIG.archiveFormat;

export type OkfExportErrorCode =
  | "invalid_request"
  | "revision_not_found"
  | "revision_integrity_failure"
  | "okf_validation_failed"
  | "export_profile_required"
  | "archive_limit_exceeded";

export class OkfExportError extends Error {
  readonly code: OkfExportErrorCode;
  readonly diagnostics: readonly OkfDiagnostic[];

  constructor(
    code: OkfExportErrorCode,
    message: string,
    diagnostics: readonly OkfDiagnostic[] = [],
  ) {
    super(message);
    this.name = "OkfExportError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export interface ExactRevisionExportRequest {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly profile?: ExportProfile;
}

export interface ExportMaterializedRevisionFile {
  readonly kind?: "markdown" | "opaque";
  readonly path: string;
  readonly mediaType: CanonicalObjectMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface ExportMaterializedRevision {
  readonly envelope: Readonly<CanonicalRevisionEnvelope>;
  readonly files: readonly Readonly<ExportMaterializedRevisionFile>[];
}

export interface ExactRevisionMaterializer {
  materialize(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<ExportMaterializedRevision>>;
}

export interface DeterministicOkfExport {
  readonly revisionId: RevisionId;
  readonly archiveFormat: ExportProfile;
  readonly mediaType: typeof OKF_EXPORT_CONFIG.mediaType;
  readonly filename:
    | typeof OKF_EXPORT_CONFIG.filename
    | typeof BUNDLE_EXPORT_CONFIG.filename;
  readonly contentDisposition:
    | typeof OKF_EXPORT_CONFIG.contentDisposition
    | typeof BUNDLE_EXPORT_CONFIG.contentDisposition;
  readonly validatedOkfVersion: typeof OKF_VERSION;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Digest;
  readonly size: number;
}

interface PreparedZipEntry {
  readonly path: string;
  readonly nameBytes: Uint8Array;
  readonly bytes: Uint8Array;
  readonly crc32: number;
  localOffset: number;
}

const ENCODER = new TextEncoder();
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORED_METHOD = 0;
const ZIP_FIXED_TIME = 0;
const ZIP_FIXED_DATE = 0x0021; // 1980-01-01, the earliest DOS date.
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY_UNIX = 0x0314;
const ZIP_REGULAR_FILE_0644 = 0x81a40000;
const ZIP_LOCAL_HEADER_SIZE = 30;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP_END_SIZE = 22;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRequest(value: unknown): ExactRevisionExportRequest & { readonly profile: ExportProfile } {
  if (!isRecord(value)) {
    throw new OkfExportError("invalid_request", "export request must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = Object.hasOwn(value, "profile")
    ? ["profile", "revisionId", "spaceId"]
    : ["revisionId", "spaceId"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new OkfExportError(
      "invalid_request",
      "export request must contain only spaceId, revisionId and optional profile",
    );
  }
  const validOpaqueId = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 512 &&
    !CONTROL_CHARACTER.test(candidate);
  if (!validOpaqueId(value.spaceId) || !validOpaqueId(value.revisionId)) {
    throw new OkfExportError(
      "invalid_request",
      "spaceId and revisionId must be bounded non-empty opaque IDs",
    );
  }
  const profile = value.profile ?? OKF_EXPORT_CONFIG.archiveFormat;
  if (profile !== OKF_EXPORT_CONFIG.archiveFormat && profile !== BUNDLE_EXPORT_CONFIG.archiveFormat) {
    throw new OkfExportError("invalid_request", "export profile is invalid");
  }
  return Object.freeze({
    spaceId: value.spaceId as SpaceId,
    revisionId: value.revisionId as RevisionId,
    profile,
  });
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function calculateCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checkedZipTotal(current: number, increment: number): number {
  const total = current + increment;
  if (!Number.isSafeInteger(total) || total > ZIP_UINT32_MAX) {
    throw new OkfExportError(
      "archive_limit_exceeded",
      "deterministic export exceeds classic ZIP size or offset limits",
    );
  }
  return total;
}

function prepareEntries(
  files: readonly Readonly<ExportMaterializedRevisionFile>[],
  profile: ExportProfile,
): PreparedZipEntry[] {
  if (!Array.isArray(files) || files.length > ZIP_UINT16_MAX) {
    throw new OkfExportError(
      "archive_limit_exceeded",
      "deterministic export supports at most 65535 entries",
    );
  }
  const seen = new Set<string>();
  const entries = files.map((file) => {
    let path: string;
    try {
      path = file.path === ".mind-diary/manifest.json"
        ? file.path
        : file.kind === "opaque"
          ? canonicalBundleFilePath(file.path)
          : canonicalMarkdownPath(file.path);
    } catch {
      throw new OkfExportError(
        "revision_integrity_failure",
        "materialized revision contains a non-canonical export path",
      );
    }
    if (seen.has(path)) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "materialized revision contains duplicate Markdown paths",
      );
    }
    seen.add(path);
    if (
      profile === OKF_EXPORT_CONFIG.archiveFormat &&
      file.mediaType !== MARKDOWN_MEDIA_TYPE
    ) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "materialized revision contains a non-Markdown object",
      );
    }
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== file.size) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "materialized revision object size does not match its manifest",
      );
    }
    if (file.bytes.byteLength > ZIP_UINT32_MAX) {
      throw new OkfExportError(
        "archive_limit_exceeded",
        "MD-OKF-ZIP-1 does not use ZIP64 file sizes",
      );
    }
    const nameBytes = ENCODER.encode(path);
    if (nameBytes.byteLength === 0 || nameBytes.byteLength > ZIP_UINT16_MAX) {
      throw new OkfExportError(
        "archive_limit_exceeded",
        "MD-OKF-ZIP-1 entry path exceeds the classic ZIP name limit",
      );
    }
    const bytes = new Uint8Array(file.bytes);
    return {
      path,
      nameBytes,
      bytes,
      crc32: calculateCrc32(bytes),
      localOffset: 0,
    };
  });
  entries.sort((left, right) => compareBytes(left.nameBytes, right.nameBytes));
  return entries;
}

function writeLocalHeader(
  view: DataView,
  output: Uint8Array,
  offset: number,
  entry: PreparedZipEntry,
): number {
  view.setUint32(offset, 0x04034b50, true);
  view.setUint16(offset + 4, ZIP_VERSION_NEEDED, true);
  view.setUint16(offset + 6, ZIP_UTF8_FLAG, true);
  view.setUint16(offset + 8, ZIP_STORED_METHOD, true);
  view.setUint16(offset + 10, ZIP_FIXED_TIME, true);
  view.setUint16(offset + 12, ZIP_FIXED_DATE, true);
  view.setUint32(offset + 14, entry.crc32, true);
  view.setUint32(offset + 18, entry.bytes.byteLength, true);
  view.setUint32(offset + 22, entry.bytes.byteLength, true);
  view.setUint16(offset + 26, entry.nameBytes.byteLength, true);
  view.setUint16(offset + 28, 0, true);
  output.set(entry.nameBytes, offset + ZIP_LOCAL_HEADER_SIZE);
  output.set(
    entry.bytes,
    offset + ZIP_LOCAL_HEADER_SIZE + entry.nameBytes.byteLength,
  );
  return offset + ZIP_LOCAL_HEADER_SIZE + entry.nameBytes.byteLength +
    entry.bytes.byteLength;
}

function writeCentralHeader(
  view: DataView,
  output: Uint8Array,
  offset: number,
  entry: PreparedZipEntry,
): number {
  view.setUint32(offset, 0x02014b50, true);
  view.setUint16(offset + 4, ZIP_VERSION_MADE_BY_UNIX, true);
  view.setUint16(offset + 6, ZIP_VERSION_NEEDED, true);
  view.setUint16(offset + 8, ZIP_UTF8_FLAG, true);
  view.setUint16(offset + 10, ZIP_STORED_METHOD, true);
  view.setUint16(offset + 12, ZIP_FIXED_TIME, true);
  view.setUint16(offset + 14, ZIP_FIXED_DATE, true);
  view.setUint32(offset + 16, entry.crc32, true);
  view.setUint32(offset + 20, entry.bytes.byteLength, true);
  view.setUint32(offset + 24, entry.bytes.byteLength, true);
  view.setUint16(offset + 28, entry.nameBytes.byteLength, true);
  view.setUint16(offset + 30, 0, true);
  view.setUint16(offset + 32, 0, true);
  view.setUint16(offset + 34, 0, true);
  view.setUint16(offset + 36, 0, true);
  view.setUint32(offset + 38, ZIP_REGULAR_FILE_0644, true);
  view.setUint32(offset + 42, entry.localOffset, true);
  output.set(entry.nameBytes, offset + ZIP_CENTRAL_HEADER_SIZE);
  return offset + ZIP_CENTRAL_HEADER_SIZE + entry.nameBytes.byteLength;
}

function createDeterministicZip(
  files: readonly Readonly<ExportMaterializedRevisionFile>[],
  profile: ExportProfile,
): Uint8Array {
  const entries = prepareEntries(files, profile);
  let localSize = 0;
  for (const entry of entries) {
    entry.localOffset = localSize;
    localSize = checkedZipTotal(
      localSize,
      ZIP_LOCAL_HEADER_SIZE + entry.nameBytes.byteLength + entry.bytes.byteLength,
    );
  }
  let centralSize = 0;
  for (const entry of entries) {
    centralSize = checkedZipTotal(
      centralSize,
      ZIP_CENTRAL_HEADER_SIZE + entry.nameBytes.byteLength,
    );
  }
  const endOffset = checkedZipTotal(localSize, centralSize);
  const totalSize = checkedZipTotal(endOffset, ZIP_END_SIZE);
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);

  let offset = 0;
  for (const entry of entries) {
    offset = writeLocalHeader(view, output, offset, entry);
  }
  for (const entry of entries) {
    offset = writeCentralHeader(view, output, offset, entry);
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, localSize, true);
  view.setUint16(offset + 20, 0, true);
  return output;
}

const MATERIALIZATION_INTEGRITY_CODES = new Set([
  "invalid_file",
  "invalid_utf8",
  "manifest_integrity_failure",
  "object_not_found",
  "object_integrity_failure",
]);

function mapMaterializationFailure(error: unknown): never {
  if (isRecord(error) && error.code === "revision_not_found") {
    throw new OkfExportError(
      "revision_not_found",
      "exact revision does not exist in this Mind",
    );
  }
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    MATERIALIZATION_INTEGRITY_CODES.has(error.code)
  ) {
    throw new OkfExportError(
      "revision_integrity_failure",
      "exact revision could not be materialized with verified immutable bytes",
    );
  }
  throw error;
}

function sortedByUnsignedUtf8(
  files: readonly Readonly<ExportMaterializedRevisionFile>[],
): readonly Readonly<ExportMaterializedRevisionFile>[] {
  return Object.freeze([...files].sort((left, right) =>
    compareBytes(ENCODER.encode(left.path), ENCODER.encode(right.path))));
}

function bundleManifestBytes(
  files: readonly Readonly<ExportMaterializedRevisionFile>[],
): Uint8Array {
  const manifest = {
    format: "mind-diary-bundle-export-manifest-v1",
    okf_version: OKF_VERSION,
    files: sortedByUnsignedUtf8(files).map((file) => ({
      path: file.path,
      kind: file.kind ?? "markdown",
      media_type: file.mediaType,
      sha256: file.sha256,
      size: file.size,
    })),
  };
  return ENCODER.encode(`${JSON.stringify(manifest)}\n`);
}

export class DeterministicOkfExportService {
  readonly #materializer: ExactRevisionMaterializer;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;

  constructor(dependencies: {
    readonly materializer: ExactRevisionMaterializer;
    readonly digest: Pick<ObjectStore, "calculateSha256">;
  }) {
    this.#materializer = dependencies.materializer;
    this.#digest = dependencies.digest;
  }

  async exportExactRevision(request: unknown): Promise<DeterministicOkfExport> {
    const parsed = parseRequest(request);
    let materialized: Readonly<ExportMaterializedRevision>;
    try {
      materialized = await this.#materializer.materialize(
        parsed.spaceId,
        parsed.revisionId,
      );
    } catch (error) {
      mapMaterializationFailure(error);
    }
    if (
      materialized.envelope.revision.spaceId !== parsed.spaceId ||
      materialized.envelope.revision.revisionId !== parsed.revisionId
    ) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "materializer returned a different immutable revision than requested",
      );
    }
    for (const file of materialized.files) {
      if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== file.size) {
        throw new OkfExportError(
          "revision_integrity_failure",
          "materialized revision object size does not match its manifest",
        );
      }
    }

    const unsupported = materialized.files.find(
      (file) =>
        file.mediaType !== MARKDOWN_MEDIA_TYPE &&
        !(BUNDLE_FILE_MEDIA_TYPES as readonly string[]).includes(file.mediaType),
    );
    if (unsupported !== undefined) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "exact revision contains an unsupported canonical object media type",
      );
    }
    if (
      parsed.profile === OKF_EXPORT_CONFIG.archiveFormat &&
      materialized.files.some((file) => file.mediaType !== MARKDOWN_MEDIA_TYPE)
    ) {
      throw new OkfExportError(
        "export_profile_required",
        "mixed revisions require the explicit MD-BUNDLE-ZIP-1 export profile",
      );
    }
    const markdownFiles = materialized.files as readonly Readonly<
      ExportMaterializedRevisionFile & { readonly mediaType: MarkdownMediaType }
    >[];
    const exactMarkdownFiles = materialized.files.filter(
      (file): file is ExportMaterializedRevisionFile & { readonly mediaType: MarkdownMediaType } =>
        file.mediaType === MARKDOWN_MEDIA_TYPE,
    );
    const validation = validateOkfBundle(
      exactMarkdownFiles.map((file) => ({
        path: file.path,
        bytes: new Uint8Array(file.bytes),
      })),
    );
    if (!validation.valid) {
      throw new OkfExportError(
        "okf_validation_failed",
        "exact revision does not pass full-bundle OKF 0.2 validation",
        [...validation.conformanceErrors, ...validation.envelopeErrors],
      );
    }

    let archiveFiles: readonly Readonly<ExportMaterializedRevisionFile>[];
    const config = parsed.profile === BUNDLE_EXPORT_CONFIG.archiveFormat
      ? BUNDLE_EXPORT_CONFIG
      : OKF_EXPORT_CONFIG;
    if (parsed.profile === BUNDLE_EXPORT_CONFIG.archiveFormat) {
      if (materialized.files.some((file) => file.path === ".mind-diary/manifest.json")) {
        throw new OkfExportError(
          "revision_integrity_failure",
          "exact revision collides with the reserved producer manifest path",
        );
      }
      for (const file of materialized.files) {
        const kind = file.kind ?? "markdown";
        if (
          (kind === "markdown" && file.mediaType !== MARKDOWN_MEDIA_TYPE) ||
          (kind === "opaque" && !(BUNDLE_FILE_MEDIA_TYPES as readonly string[]).includes(file.mediaType))
        ) {
          throw new OkfExportError(
            "revision_integrity_failure",
            "materialized revision kind and media type do not match",
          );
        }
        try {
          kind === "markdown" ? canonicalMarkdownPath(file.path) : canonicalBundleFilePath(file.path);
        } catch {
          throw new OkfExportError(
            "revision_integrity_failure",
            "materialized revision contains a non-canonical path",
          );
        }
      }
      const manifestBytes = bundleManifestBytes(materialized.files);
      archiveFiles = Object.freeze([
        ...materialized.files,
        Object.freeze({
          kind: "opaque" as const,
          path: ".mind-diary/manifest.json",
          mediaType: MARKDOWN_MEDIA_TYPE,
          sha256: await this.#digest.calculateSha256(manifestBytes),
          size: manifestBytes.byteLength,
          bytes: manifestBytes,
        }),
      ]);
    } else {
      archiveFiles = markdownFiles;
    }
    const bytes = createDeterministicZip(archiveFiles, parsed.profile);
    const sha256 = await this.#digest.calculateSha256(bytes);
    return Object.freeze({
      revisionId: parsed.revisionId,
      archiveFormat: config.archiveFormat,
      mediaType: config.mediaType,
      filename: config.filename,
      contentDisposition: config.contentDisposition,
      validatedOkfVersion: OKF_VERSION,
      bytes,
      sha256,
      size: bytes.byteLength,
    });
  }
}
