import type { ObjectStore } from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
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
  collectOkfCrossLinkWarnings,
  OKF_VERSION,
  parseOkfFile,
  validateOkfBundle,
  type OkfDiagnostic,
} from "@mind-diary/okf-codec";
import { IncrementalSha256 } from "./incremental-sha256.js";

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

export interface ExactRevisionStreamReader {
  openRevisionSession?(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<ExactRevisionStreamSession>>;
  readRevisionEnvelope(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope>>;
  readRevisionFile(
    spaceId: SpaceId,
    revisionId: RevisionId,
    path: string,
  ): Promise<Readonly<ExportMaterializedRevisionFile> | null>;
  openRevisionFile(
    spaceId: SpaceId,
    revisionId: RevisionId,
    path: string,
  ): Promise<Readonly<Omit<ExportMaterializedRevisionFile, "bytes"> & {
    readonly body: ReadableStream<Uint8Array>;
  }> | null>;
}

export interface ExactRevisionStreamSession {
  readonly envelope: Readonly<CanonicalRevisionEnvelope>;
  readRevisionFile(
    path: string,
  ): Promise<Readonly<ExportMaterializedRevisionFile> | null>;
  openRevisionFile(
    path: string,
  ): Promise<Readonly<Omit<ExportMaterializedRevisionFile, "bytes"> & {
    readonly body: ReadableStream<Uint8Array>;
  }> | null>;
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

export interface DeterministicExportChunkSink {
  write(chunk: Uint8Array): Promise<void>;
}

export type StreamedDeterministicOkfExport = Omit<
  DeterministicOkfExport,
  "bytes"
>;

interface PreparedZipEntry {
  readonly path: string;
  readonly nameBytes: Uint8Array;
  readonly bytes: Uint8Array;
  readonly crc32: number;
  localOffset: number;
}

interface StreamedZipEntry {
  readonly path: string;
  readonly nameBytes: Uint8Array;
  readonly kind: "markdown" | "opaque" | "producer_manifest";
  readonly mediaType: CanonicalObjectMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly crc32: number;
  readonly generatedBytes: Uint8Array | null;
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
const EXPORT_STREAM_CHUNK_BYTES = 1_048_576;
const EXPORT_OBJECT_IO_CONCURRENCY = 8;
/** Canonical Markdown is already limited to 1 MiB; each export batch retains at most eight files. */
const MAX_EXPORT_MARKDOWN_FILE_BYTES = 1_048_576;

async function settleExportBatch<Value>(pending: readonly (Promise<Value> | Value)[]): Promise<Value[]> {
  const settled = await Promise.allSettled(pending);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<Value>).value);
}

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

class IncrementalCrc32 {
  #crc = 0xffffffff;

  update(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.#crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        this.#crc = (this.#crc >>> 1) ^ ((this.#crc & 1) === 0 ? 0 : 0xedb88320);
      }
    }
  }

  digest(): number {
    return (this.#crc ^ 0xffffffff) >>> 0;
  }
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

function streamedLocalHeader(entry: StreamedZipEntry): Uint8Array {
  const output = new Uint8Array(ZIP_LOCAL_HEADER_SIZE + entry.nameBytes.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, ZIP_VERSION_NEEDED, true);
  view.setUint16(6, ZIP_UTF8_FLAG, true);
  view.setUint16(8, ZIP_STORED_METHOD, true);
  view.setUint16(10, ZIP_FIXED_TIME, true);
  view.setUint16(12, ZIP_FIXED_DATE, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.size, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.nameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  output.set(entry.nameBytes, ZIP_LOCAL_HEADER_SIZE);
  return output;
}

function streamedCentralHeader(entry: StreamedZipEntry): Uint8Array {
  const output = new Uint8Array(ZIP_CENTRAL_HEADER_SIZE + entry.nameBytes.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, ZIP_VERSION_MADE_BY_UNIX, true);
  view.setUint16(6, ZIP_VERSION_NEEDED, true);
  view.setUint16(8, ZIP_UTF8_FLAG, true);
  view.setUint16(10, ZIP_STORED_METHOD, true);
  view.setUint16(12, ZIP_FIXED_TIME, true);
  view.setUint16(14, ZIP_FIXED_DATE, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.nameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, ZIP_REGULAR_FILE_0644, true);
  view.setUint32(42, entry.localOffset, true);
  output.set(entry.nameBytes, ZIP_CENTRAL_HEADER_SIZE);
  return output;
}

function streamedEndRecord(
  entryCount: number,
  centralSize: number,
  localSize: number,
): Uint8Array {
  const output = new Uint8Array(ZIP_END_SIZE);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, localSize, true);
  view.setUint16(20, 0, true);
  return output;
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

function sortedByUnsignedUtf8<T extends Readonly<{ readonly path: string }>>(
  files: readonly T[],
): readonly T[] {
  return Object.freeze([...files].sort((left, right) =>
    compareBytes(ENCODER.encode(left.path), ENCODER.encode(right.path))));
}

function bundleManifestBytes(
  files: readonly Readonly<Pick<
    ExportMaterializedRevisionFile,
    "path" | "kind" | "mediaType" | "sha256" | "size"
  >>[],
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

function exactRevisionStreamReader(
  value: ExactRevisionMaterializer,
): ExactRevisionStreamReader | null {
  const candidate = value as Partial<ExactRevisionStreamReader>;
  return typeof candidate.readRevisionEnvelope === "function" &&
    typeof candidate.readRevisionFile === "function" &&
    typeof candidate.openRevisionFile === "function"
    ? candidate as ExactRevisionStreamReader
    : null;
}

export class DeterministicOkfExportService {
  readonly #materializer: ExactRevisionMaterializer;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #streamReader: ExactRevisionStreamReader | null;

  constructor(dependencies: {
    readonly materializer: ExactRevisionMaterializer;
    readonly digest: Pick<ObjectStore, "calculateSha256">;
  }) {
    this.#materializer = dependencies.materializer;
    this.#digest = dependencies.digest;
    this.#streamReader = exactRevisionStreamReader(dependencies.materializer);
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
      const kind = file.kind ?? "markdown";
      if (
        (kind === "markdown" && file.mediaType !== MARKDOWN_MEDIA_TYPE) ||
        (kind === "opaque" && file.mediaType === MARKDOWN_MEDIA_TYPE)
      ) throw new OkfExportError(
        "revision_integrity_failure",
        "materialized revision kind and media type do not match",
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
          (kind === "opaque" && file.mediaType === MARKDOWN_MEDIA_TYPE)
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

  async writeExactRevision(
    request: unknown,
    sink: DeterministicExportChunkSink,
  ): Promise<StreamedDeterministicOkfExport> {
    if (typeof sink?.write !== "function") {
      throw new OkfExportError("invalid_request", "export chunk sink is required");
    }
    if (this.#streamReader === null) {
      const built = await this.exportExactRevision(request);
      await sink.write(new Uint8Array(built.bytes));
      const { bytes: _bytes, ...metadata } = built;
      return Object.freeze(metadata);
    }

    const parsed = parseRequest(request);
    let envelope: Readonly<CanonicalRevisionEnvelope>;
    let session: Readonly<ExactRevisionStreamSession> | null = null;
    try {
      if (this.#streamReader.openRevisionSession !== undefined) {
        session = await this.#streamReader.openRevisionSession(
          parsed.spaceId,
          parsed.revisionId,
        );
        envelope = session.envelope;
      } else {
        envelope = await this.#streamReader.readRevisionEnvelope(
          parsed.spaceId,
          parsed.revisionId,
        );
      }
    } catch (error) {
      mapMaterializationFailure(error);
    }
    if (
      envelope.revision.spaceId !== parsed.spaceId ||
      envelope.revision.revisionId !== parsed.revisionId
    ) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "stream reader returned a different immutable revision than requested",
      );
    }
    const config = parsed.profile === BUNDLE_EXPORT_CONFIG.archiveFormat
      ? BUNDLE_EXPORT_CONFIG
      : OKF_EXPORT_CONFIG;
    if (
      parsed.profile === OKF_EXPORT_CONFIG.archiveFormat &&
      envelope.manifest.entries.some((entry) => entry.kind !== "markdown")
    ) {
      throw new OkfExportError(
        "export_profile_required",
        "mixed revisions require the explicit MD-BUNDLE-ZIP-1 export profile",
      );
    }
    if (
      parsed.profile === BUNDLE_EXPORT_CONFIG.archiveFormat &&
      envelope.manifest.entries.some((entry) => entry.path === ".mind-diary/manifest.json")
    ) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "exact revision collides with the reserved producer manifest path",
      );
    }

    const generatedManifest = parsed.profile === BUNDLE_EXPORT_CONFIG.archiveFormat
      ? bundleManifestBytes(envelope.manifest.entries)
      : null;
    const projected = [
      ...envelope.manifest.entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        mediaType: entry.mediaType,
        sha256: entry.sha256,
        size: entry.size,
        generatedBytes: null as Uint8Array | null,
      })),
      ...(generatedManifest === null
        ? []
        : [{
            path: ".mind-diary/manifest.json",
            kind: "producer_manifest" as const,
            mediaType: MARKDOWN_MEDIA_TYPE,
            sha256: await this.#digest.calculateSha256(generatedManifest),
            size: generatedManifest.byteLength,
            generatedBytes: generatedManifest,
          }]),
    ];
    if (projected.length > ZIP_UINT16_MAX) {
      throw new OkfExportError(
        "archive_limit_exceeded",
        "deterministic export supports at most 65535 entries",
      );
    }
    const markdownPaths = envelope.manifest.entries
      .filter((entry) => entry.kind === "markdown")
      .map((entry) => entry.path);
    const seen = new Set<string>();
    const namedEntries = projected.map((entry) => {
      let canonicalPath: string;
      try {
        canonicalPath = entry.kind === "producer_manifest"
          ? entry.path
          : entry.kind === "opaque"
            ? canonicalBundleFilePath(entry.path)
            : canonicalMarkdownPath(entry.path);
      } catch {
        throw new OkfExportError(
          "revision_integrity_failure",
          "exact revision contains a non-canonical export path",
        );
      }
      if (seen.has(canonicalPath)) {
        throw new OkfExportError(
          "revision_integrity_failure",
          "exact revision contains duplicate export paths",
        );
      }
      seen.add(canonicalPath);
      const nameBytes = ENCODER.encode(canonicalPath);
      if (nameBytes.byteLength === 0 || nameBytes.byteLength > ZIP_UINT16_MAX) {
        throw new OkfExportError(
          "archive_limit_exceeded",
          "deterministic export entry path exceeds the classic ZIP name limit",
        );
      }
      if (entry.size > ZIP_UINT32_MAX) {
        throw new OkfExportError(
          "archive_limit_exceeded",
          "deterministic export does not use ZIP64 file sizes",
        );
      }
      return { entry, canonicalPath, nameBytes };
    });
    const streamedEntries: StreamedZipEntry[] = [];
    const conformanceErrors: OkfDiagnostic[] = [];
    for (let offset = 0; offset < namedEntries.length; offset += EXPORT_OBJECT_IO_CONCURRENCY) {
      const batch = namedEntries.slice(offset, offset + EXPORT_OBJECT_IO_CONCURRENCY);
      const inspections = await settleExportBatch(batch.map(({ entry }) => entry.generatedBytes === null
        ? entry.kind === "markdown"
          ? this.#inspectBoundedMarkdownFile(parsed.spaceId, parsed.revisionId, entry, session)
          : this.#inspectStreamedFile(parsed.spaceId, parsed.revisionId, entry, session)
        : Object.freeze({
            crc32: calculateCrc32(entry.generatedBytes),
            markdownBytes: entry.generatedBytes,
          })));
      for (let index = 0; index < batch.length; index += 1) {
        const { entry, canonicalPath, nameBytes } = batch[index]!;
        const inspected = inspections[index]!;
        if (entry.kind === "markdown") {
          const result = parseOkfFile({ path: canonicalPath, bytes: inspected.markdownBytes! });
          conformanceErrors.push(...result.diagnostics.filter(
            (diagnostic) => diagnostic.severity === "error",
          ));
          if (result.file !== null) {
            // Cross-links are quality-only in OKF 0.2; evaluate them against
            // the complete manifest without retaining the whole corpus.
            collectOkfCrossLinkWarnings([result.file], markdownPaths);
          }
        }
        streamedEntries.push({
          path: canonicalPath,
          nameBytes,
          kind: entry.kind,
          mediaType: entry.mediaType,
          sha256: entry.sha256,
          size: entry.size,
          crc32: inspected.crc32,
          generatedBytes: entry.generatedBytes,
          localOffset: 0,
        });
      }
    }
    if (conformanceErrors.length > 0) {
      throw new OkfExportError(
        "okf_validation_failed",
        "exact revision does not pass full-bundle OKF 0.2 validation",
        conformanceErrors,
      );
    }

    streamedEntries.sort((left, right) => compareBytes(left.nameBytes, right.nameBytes));
    let localSize = 0;
    for (const entry of streamedEntries) {
      entry.localOffset = localSize;
      localSize = checkedZipTotal(
        localSize,
        ZIP_LOCAL_HEADER_SIZE + entry.nameBytes.byteLength + entry.size,
      );
    }
    let centralSize = 0;
    for (const entry of streamedEntries) {
      centralSize = checkedZipTotal(
        centralSize,
        ZIP_CENTRAL_HEADER_SIZE + entry.nameBytes.byteLength,
      );
    }
    const totalSize = checkedZipTotal(
      checkedZipTotal(localSize, centralSize),
      ZIP_END_SIZE,
    );
    const digest = new IncrementalSha256();
    let written = 0;
    const emit = async (chunk: Uint8Array) => {
      if (chunk.byteLength === 0) return;
      digest.update(chunk);
      written = checkedZipTotal(written, chunk.byteLength);
      await sink.write(new Uint8Array(chunk));
    };
    for (let offset = 0; offset < streamedEntries.length; offset += EXPORT_OBJECT_IO_CONCURRENCY) {
      const batch = streamedEntries.slice(offset, offset + EXPORT_OBJECT_IO_CONCURRENCY);
      const markdownFiles = await settleExportBatch(batch.map((entry) => entry.kind === "markdown"
        ? this.#inspectBoundedMarkdownFile(parsed.spaceId, parsed.revisionId, entry, session)
        : null));
      for (let index = 0; index < batch.length; index += 1) {
        const entry = batch[index]!;
        await emit(streamedLocalHeader(entry));
        const markdown = markdownFiles[index];
        if (markdown !== null && markdown !== undefined) {
          if (markdown.crc32 !== entry.crc32) {
            throw new OkfExportError(
              "revision_integrity_failure",
              "exact revision object changed between export passes",
            );
          }
          for (let byteOffset = 0; byteOffset < markdown.markdownBytes.byteLength; byteOffset += EXPORT_STREAM_CHUNK_BYTES) {
            await emit(markdown.markdownBytes.subarray(byteOffset, byteOffset + EXPORT_STREAM_CHUNK_BYTES));
          }
        } else if (entry.generatedBytes !== null) {
          for (let byteOffset = 0; byteOffset < entry.generatedBytes.byteLength; byteOffset += EXPORT_STREAM_CHUNK_BYTES) {
            await emit(entry.generatedBytes.subarray(byteOffset, byteOffset + EXPORT_STREAM_CHUNK_BYTES));
          }
        } else {
          await this.#emitStreamedFile(parsed.spaceId, parsed.revisionId, entry, emit, session);
        }
      }
    }
    for (const entry of streamedEntries) await emit(streamedCentralHeader(entry));
    await emit(streamedEndRecord(streamedEntries.length, centralSize, localSize));
    if (written !== totalSize) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "streamed deterministic ZIP size differs from its planned size",
      );
    }
    return Object.freeze({
      revisionId: parsed.revisionId,
      archiveFormat: config.archiveFormat,
      mediaType: config.mediaType,
      filename: config.filename,
      contentDisposition: config.contentDisposition,
      validatedOkfVersion: OKF_VERSION,
      sha256: digest.digest(),
      size: written,
    });
  }

  async #openStreamedFile(
    spaceId: SpaceId,
    revisionId: RevisionId,
    entry: Readonly<{
      path: string;
      kind: "markdown" | "opaque" | "producer_manifest";
      mediaType: CanonicalObjectMediaType;
      sha256: Sha256Digest;
      size: number;
    }>,
    session: Readonly<ExactRevisionStreamSession> | null,
  ): Promise<Readonly<Omit<ExportMaterializedRevisionFile, "bytes"> & {
    readonly body: ReadableStream<Uint8Array>;
  }>> {
    if (entry.kind === "producer_manifest" || this.#streamReader === null) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "producer manifest bytes must be supplied by the export planner",
      );
    }
    let file: Awaited<ReturnType<ExactRevisionStreamReader["openRevisionFile"]>>;
    try {
      file = session === null
        ? await this.#streamReader.openRevisionFile(spaceId, revisionId, entry.path)
        : await session.openRevisionFile(entry.path);
    } catch (error) {
      mapMaterializationFailure(error);
    }
    const kind = file?.kind ?? "markdown";
    if (
      file === null || kind !== entry.kind || file.path !== entry.path ||
      file.mediaType !== entry.mediaType || file.sha256 !== entry.sha256 ||
      file.size !== entry.size || !(file.body instanceof ReadableStream)
    ) {
      if (file?.body instanceof ReadableStream) {
        await file.body.cancel().catch(() => undefined);
      }
      throw new OkfExportError(
        "revision_integrity_failure",
        "exact revision object differs from its immutable manifest",
      );
    }
    return file;
  }

  async #inspectStreamedFile(
    spaceId: SpaceId,
    revisionId: RevisionId,
    entry: Readonly<Pick<StreamedZipEntry, "path" | "kind" | "mediaType" | "sha256" | "size">>,
    session: Readonly<ExactRevisionStreamSession> | null,
  ): Promise<Readonly<{ crc32: number; markdownBytes: Uint8Array | null }>> {
    const file = await this.#openStreamedFile(spaceId, revisionId, entry, session);
    const reader = file.body.getReader();
    const sha = new IncrementalSha256();
    const crc = new IncrementalCrc32();
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > entry.size) {
          throw new OkfExportError("revision_integrity_failure", "streamed revision object size differs from its manifest");
        }
        size += part.value.byteLength;
        sha.update(part.value);
        crc.update(part.value);
      }
      if (size !== entry.size || sha.digest() !== entry.sha256) {
        throw new OkfExportError("revision_integrity_failure", "streamed revision object differs from its immutable manifest");
      }
      return Object.freeze({ crc32: crc.digest(), markdownBytes: null });
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async #inspectBoundedMarkdownFile(
    spaceId: SpaceId,
    revisionId: RevisionId,
    entry: Readonly<Pick<StreamedZipEntry, "path" | "kind" | "mediaType" | "sha256" | "size">>,
    session: Readonly<ExactRevisionStreamSession> | null,
  ): Promise<Readonly<{ crc32: number; markdownBytes: Uint8Array }>> {
    if (this.#streamReader === null || entry.size > MAX_EXPORT_MARKDOWN_FILE_BYTES) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "canonical Markdown exceeds the bounded export validation limit",
      );
    }
    let file: Awaited<ReturnType<ExactRevisionStreamReader["readRevisionFile"]>>;
    try {
      file = session === null
        ? await this.#streamReader.readRevisionFile(spaceId, revisionId, entry.path)
        : await session.readRevisionFile(entry.path);
    } catch (error) {
      mapMaterializationFailure(error);
    }
    const kind = file?.kind ?? "markdown";
    if (
      file === null || kind !== "markdown" || entry.kind !== "markdown" ||
      file.path !== entry.path || file.mediaType !== entry.mediaType ||
      file.sha256 !== entry.sha256 || file.size !== entry.size ||
      !(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== entry.size
    ) throw new OkfExportError(
      "revision_integrity_failure",
      "bounded Markdown object differs from its immutable manifest",
    );
    const digest = new IncrementalSha256();
    digest.update(file.bytes);
    if (digest.digest() !== entry.sha256) {
      throw new OkfExportError(
        "revision_integrity_failure",
        "bounded Markdown object differs from its immutable manifest",
      );
    }
    return Object.freeze({
      crc32: calculateCrc32(file.bytes),
      markdownBytes: file.bytes,
    });
  }

  async #emitStreamedFile(
    spaceId: SpaceId,
    revisionId: RevisionId,
    entry: Readonly<Pick<StreamedZipEntry, "path" | "kind" | "mediaType" | "sha256" | "size">>,
    emit: (chunk: Uint8Array) => Promise<void>,
    session: Readonly<ExactRevisionStreamSession> | null,
  ): Promise<void> {
    const file = await this.#openStreamedFile(spaceId, revisionId, entry, session);
    const reader = file.body.getReader();
    const sha = new IncrementalSha256();
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > entry.size) {
          throw new OkfExportError("revision_integrity_failure", "streamed revision object size differs from its manifest");
        }
        size += part.value.byteLength;
        sha.update(part.value);
        for (let offset = 0; offset < part.value.byteLength; offset += EXPORT_STREAM_CHUNK_BYTES) {
          await emit(part.value.subarray(offset, offset + EXPORT_STREAM_CHUNK_BYTES));
        }
      }
      if (size !== entry.size || sha.digest() !== entry.sha256) {
        throw new OkfExportError("revision_integrity_failure", "streamed revision object differs from its immutable manifest");
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}
