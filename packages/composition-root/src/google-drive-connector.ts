import {
  AuthorizedConnectorIngressService,
  CONNECTOR_OBJECT_LIMITS,
  IncrementalSha256,
  type AuthorizedConnectorObjectSource,
  type BundleFileStagingService,
  type ConnectorObjectReadLimits,
  type ConnectorObjectReadResult,
  type ConnectorObjectRepresentation,
  type VerifiedFileInput,
} from "@mind-diary/application-content";
import type { Sha256Digest } from "@mind-diary/domain";

export const GOOGLE_DRIVE_CONNECTOR_LIMITS = Object.freeze({
  maxObjectBytes: CONNECTOR_OBJECT_LIMITS.maxBytes,
  fetchTimeoutMilliseconds: CONNECTOR_OBJECT_LIMITS.fetchTimeoutMilliseconds,
  maxRedirects: 0,
  maxMetadataBytes: 65_536,
  maxSelectionCharacters: 1_024,
  maxBindingCharacters: 512,
  maxAccessTokenCharacters: 8_192,
  maxGrantFingerprintCharacters: 512,
  /** Google Drive `files.export` has a provider-owned 10 MB response limit. */
  maxNativeExportBytes: 10_000_000,
});

export const GOOGLE_DRIVE_NATIVE_MEDIA_TYPES = Object.freeze({
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
});

export const GOOGLE_DRIVE_EXPORT_FORMATS = Object.freeze({
  "google-drive/docx": Object.freeze({
    source: GOOGLE_DRIVE_NATIVE_MEDIA_TYPES.document,
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
  }),
  "google-drive/xlsx": Object.freeze({
    source: GOOGLE_DRIVE_NATIVE_MEDIA_TYPES.spreadsheet,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  }),
  "google-drive/pptx": Object.freeze({
    source: GOOGLE_DRIVE_NATIVE_MEDIA_TYPES.presentation,
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: ".pptx",
  }),
  "google-drive/pdf": Object.freeze({
    source: Object.freeze([
      GOOGLE_DRIVE_NATIVE_MEDIA_TYPES.document,
      GOOGLE_DRIVE_NATIVE_MEDIA_TYPES.spreadsheet,
      GOOGLE_DRIVE_NATIVE_MEDIA_TYPES.presentation,
    ]),
    mediaType: "application/pdf",
    extension: ".pdf",
  }),
});

export interface GoogleDriveObjectSelection {
  /** Actor-owned connector grant/binding reference; never crosses this adapter. */
  readonly bindingRef: string;
  /** One exact Drive file ID. URL, folder, query and wildcard selectors are forbidden. */
  readonly objectId: string;
}

export type GoogleDriveGrantResolution =
  | Readonly<{
      kind: "authorized";
      accessToken: string;
      /** Stable opaque generation for one grant; token rotation must not change it. */
      grantFingerprint: string;
    }>
  | Readonly<{ kind: "missing" | "revoked" | "foreign" }>
  | Readonly<{ kind: "unavailable"; retryable: boolean }>;

/** Connector-control port. It resolves only the current actor-owned grant. */
export interface GoogleDriveGrantResolver {
  resolve(request: Readonly<{
    actor: ConnectorActor;
    bindingRef: string;
  }>): Promise<GoogleDriveGrantResolution>;
}

export interface GoogleDriveConnectorObjectSourceOptions {
  readonly grants: GoogleDriveGrantResolver;
  readonly fetcher?: typeof fetch;
}

type ExportFormat = keyof typeof GOOGLE_DRIVE_EXPORT_FORMATS;
type ConnectorActor = Parameters<
  AuthorizedConnectorObjectSource["readVerifiedSnapshot"]
>[0]["actor"];

type DriveSnapshot = Readonly<{
  objectId: string;
  name: string;
  mediaType: string;
  version: string;
  ownershipFingerprint: string;
  headRevisionId: string | null;
  size: number | null;
  sha256: Sha256Digest | null;
}>;

type CurrentGrant = Readonly<{
  accessToken: string;
  fingerprint: string;
}>;

type ExportSpec = Readonly<{
  format: ExportFormat;
  mediaType: string;
  extension: string;
}>;

type DigestReceipt = Readonly<{
  size: number;
  sha256: Sha256Digest;
}>;

const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files/";
const DRIVE_METADATA_FIELDS = [
  "id",
  "name",
  "mimeType",
  "size",
  "sha256Checksum",
  "trashed",
  "capabilities(canDownload)",
  "version",
  "headRevisionId",
  "ownedByMe",
  "driveId",
  "owners(permissionId)",
].join(",");
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DRIVE_ID = /^[A-Za-z0-9_-]+$/u;
const SAFE_OPAQUE = /^[A-Za-z0-9._:-]+$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/iu;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const SAFE_STREAM_ERROR = "Google Drive connector snapshot is unavailable";

class DriveAdapterFailure extends Error {
  readonly name = "DriveAdapterFailure";

  constructor(
    readonly boundary: "source" | "transport",
    readonly retryable: boolean,
  ) {
    super(SAFE_STREAM_ERROR);
  }
}

function sourceFailure(): never {
  throw new DriveAdapterFailure("source", false);
}

function transportFailure(retryable = true): never {
  throw new DriveAdapterFailure("transport", retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !CONTROL.test(value);
}

function parseSelection(value: unknown): Readonly<GoogleDriveObjectSelection> | null {
  if (!isRecord(value) || !exactKeys(value, ["bindingRef", "objectId"])) return null;
  if (
    !boundedString(value.bindingRef, GOOGLE_DRIVE_CONNECTOR_LIMITS.maxBindingCharacters) ||
    !SAFE_OPAQUE.test(value.bindingRef) ||
    !boundedString(value.objectId, GOOGLE_DRIVE_CONNECTOR_LIMITS.maxSelectionCharacters) ||
    !DRIVE_ID.test(value.objectId)
  ) return null;
  return Object.freeze({ bindingRef: value.bindingRef, objectId: value.objectId });
}

function safeFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.normalize("NFC") && value !== "." && value !== ".." &&
    !value.includes("/") && !value.includes("\\") && !CONTROL.test(value) &&
    new TextEncoder().encode(value).byteLength <= 255;
}

function safeMetadataName(value: unknown): value is string {
  return boundedString(value, GOOGLE_DRIVE_CONNECTOR_LIMITS.maxSelectionCharacters);
}

function canonicalMediaType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const essence = value.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  return essence.length <= 127 && MEDIA_TYPE.test(essence)
    ? essence
    : "application/octet-stream";
}

function parseDecimal(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 16 || !DECIMAL.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeInternalId(value: unknown, maximum = 1_024): value is string {
  return boundedString(value, maximum) && SAFE_OPAQUE.test(value);
}

function ownershipFingerprint(value: Record<string, unknown>): string | null {
  if (safeInternalId(value.driveId)) return `shared-drive:${value.driveId}`;
  if (typeof value.ownedByMe !== "boolean" || !Array.isArray(value.owners)) return null;
  const owners = value.owners.map((owner) =>
    isRecord(owner) && safeInternalId(owner.permissionId, 512)
      ? owner.permissionId
      : null
  );
  if (owners.length === 0 || owners.some((owner) => owner === null)) return null;
  const unique = [...new Set(owners.filter((owner): owner is string => owner !== null))]
    .sort();
  return `my-drive:${value.ownedByMe ? "owner" : "shared"}:${unique.join(",")}`;
}

function metadataSnapshot(
  value: unknown,
  expectedObjectId: string,
  maximumBytes: number,
): DriveSnapshot | null {
  if (
    !isRecord(value) || value.id !== expectedObjectId || value.trashed !== false ||
    !isRecord(value.capabilities) || value.capabilities.canDownload !== true ||
    !safeMetadataName(value.name) || typeof value.mimeType !== "string" ||
    !safeInternalId(value.version, 64)
  ) return null;
  const ownership = ownershipFingerprint(value);
  if (ownership === null) return null;
  const mediaType = canonicalMediaType(value.mimeType);
  if (mediaType === "application/octet-stream" && value.mimeType !== mediaType) return null;
  const native = Object.values(GOOGLE_DRIVE_NATIVE_MEDIA_TYPES).includes(
    mediaType as typeof GOOGLE_DRIVE_NATIVE_MEDIA_TYPES[keyof typeof GOOGLE_DRIVE_NATIVE_MEDIA_TYPES],
  );
  if (native) {
    return Object.freeze({
      objectId: expectedObjectId,
      name: value.name,
      mediaType,
      version: value.version,
      ownershipFingerprint: ownership,
      headRevisionId: null,
      size: null,
      sha256: null,
    });
  }
  const size = parseDecimal(value.size);
  if (
    size === null || size > maximumBytes ||
    typeof value.sha256Checksum !== "string" || !SHA256.test(value.sha256Checksum)
  ) return null;
  const headRevisionId = value.headRevisionId === undefined
    ? null
    : safeInternalId(value.headRevisionId) ? value.headRevisionId : null;
  return Object.freeze({
    objectId: expectedObjectId,
    name: value.name,
    mediaType,
    version: value.version,
    ownershipFingerprint: ownership,
    headRevisionId,
    size,
    sha256: `sha256:${value.sha256Checksum.toLocaleLowerCase("en-US")}` as Sha256Digest,
  });
}

function snapshotsEqual(left: DriveSnapshot, right: DriveSnapshot): boolean {
  return left.objectId === right.objectId && left.name === right.name &&
    left.mediaType === right.mediaType && left.version === right.version &&
    left.ownershipFingerprint === right.ownershipFingerprint &&
    left.headRevisionId === right.headRevisionId && left.size === right.size &&
    left.sha256 === right.sha256;
}

function exportSpec(
  representation: ConnectorObjectRepresentation,
  sourceMediaType: string,
): ExportSpec | null {
  if (representation.kind !== "export_snapshot") return null;
  if (!(representation.format in GOOGLE_DRIVE_EXPORT_FORMATS)) return null;
  const format = representation.format as ExportFormat;
  const configured = GOOGLE_DRIVE_EXPORT_FORMATS[format];
  const configuredSource: string | readonly string[] = configured.source;
  const allowed = Array.isArray(configuredSource)
    ? configuredSource.includes(sourceMediaType)
    : configuredSource === sourceMediaType;
  if (
    !allowed || representation.mediaType !== configured.mediaType ||
    !safeFilename(representation.displayFilename) ||
    !representation.displayFilename.toLocaleLowerCase("en-US")
      .endsWith(configured.extension)
  ) return null;
  return Object.freeze({
    format,
    mediaType: configured.mediaType,
    extension: configured.extension,
  });
}

function metadataUrl(objectId: string): string {
  const url = new URL(`${DRIVE_FILES_ENDPOINT}${encodeURIComponent(objectId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", DRIVE_METADATA_FIELDS);
  return url.href;
}

function binaryUrl(objectId: string): string {
  const url = new URL(`${DRIVE_FILES_ENDPOINT}${encodeURIComponent(objectId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("alt", "media");
  return url.href;
}

function exportUrl(objectId: string, mediaType: string): string {
  const url = new URL(
    `${DRIVE_FILES_ENDPOINT}${encodeURIComponent(objectId)}/export`,
  );
  url.searchParams.set("mimeType", mediaType);
  return url.href;
}

function requestInit(
  token: string,
  signal: AbortSignal | undefined,
  accept: string,
): RequestInit {
  const headers = new Headers({ accept, authorization: `Bearer ${token}` });
  return Object.freeze({
    method: "GET",
    headers,
    ...(signal === undefined ? {} : { signal }),
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
}

function responseFailure(response: Response): never {
  if (response.status >= 300 && response.status < 400) transportFailure(false);
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    transportFailure(true);
  }
  sourceFailure();
}

function parseContentLength(value: string | null): number | null {
  return value === null ? null : parseDecimal(value);
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== null && declared > maximum) sourceFailure();
  if (response.body === null) sourceFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || size + next.value.byteLength > maximum) {
        sourceFailure();
      }
      size += next.value.byteLength;
      chunks.push(new Uint8Array(next.value));
    }
  } catch (error) {
    if (error instanceof DriveAdapterFailure) throw error;
    transportFailure(true);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    sourceFailure();
  }
}

async function digestResponse(
  response: Response,
  maximumBytes: number,
  expectedMediaType: string,
  signal: AbortSignal | undefined,
): Promise<DigestReceipt> {
  const responseMedia = canonicalMediaType(response.headers.get("content-type"));
  const declaredHeader = response.headers.get("content-length");
  const declared = parseContentLength(declaredHeader);
  if (
    responseMedia !== expectedMediaType ||
    (declaredHeader !== null && declared === null) ||
    (declared !== null && declared > maximumBytes) ||
    response.body === null
  ) sourceFailure();
  const reader = response.body.getReader();
  const digest = new IncrementalSha256();
  let size = 0;
  let completed = false;
  try {
    while (true) {
      if (signal?.aborted) transportFailure(true);
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      if (!(next.value instanceof Uint8Array) || size + next.value.byteLength > maximumBytes) {
        sourceFailure();
      }
      size += next.value.byteLength;
      digest.update(next.value);
    }
  } catch (error) {
    if (error instanceof DriveAdapterFailure) throw error;
    transportFailure(true);
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (declared !== null && declared !== size) sourceFailure();
  return Object.freeze({ size, sha256: digest.digest() });
}

function unavailable(error: unknown): ConnectorObjectReadResult {
  if (error instanceof DriveAdapterFailure && error.boundary === "source") {
    return Object.freeze({ kind: "unavailable", failure: "source_unavailable" });
  }
  return Object.freeze({
    kind: "unavailable",
    failure: "transport_unavailable",
    retryable: error instanceof DriveAdapterFailure ? error.retryable : true,
  });
}

/**
 * One-object Google Drive adapter. The instance privately binds a grant and a
 * file ID; the portable application sees only `AuthorizedConnectorObjectSource`.
 */
export class GoogleDriveConnectorObjectSource implements AuthorizedConnectorObjectSource {
  readonly #selection: Readonly<GoogleDriveObjectSelection> | null;
  readonly #grants: GoogleDriveGrantResolver;
  readonly #fetcher: typeof fetch;

  constructor(
    selection: unknown,
    options: GoogleDriveConnectorObjectSourceOptions,
  ) {
    this.#selection = parseSelection(selection);
    this.#grants = options.grants;
    this.#fetcher = options.fetcher ?? globalThis.fetch;
  }

  async #grant(
    actor: ConnectorActor,
    expectedFingerprint?: string,
  ): Promise<CurrentGrant> {
    if (this.#selection === null) sourceFailure();
    let resolution: GoogleDriveGrantResolution;
    try {
      resolution = await this.#grants.resolve({
        actor,
        bindingRef: this.#selection.bindingRef,
      });
    } catch {
      transportFailure(true);
    }
    if (resolution.kind === "unavailable") transportFailure(resolution.retryable);
    if (resolution.kind !== "authorized") sourceFailure();
    if (
      !boundedString(
        resolution.accessToken,
        GOOGLE_DRIVE_CONNECTOR_LIMITS.maxAccessTokenCharacters,
      ) ||
      !boundedString(
        resolution.grantFingerprint,
        GOOGLE_DRIVE_CONNECTOR_LIMITS.maxGrantFingerprintCharacters,
      ) ||
      (expectedFingerprint !== undefined &&
        resolution.grantFingerprint !== expectedFingerprint)
    ) sourceFailure();
    return Object.freeze({
      accessToken: resolution.accessToken,
      fingerprint: resolution.grantFingerprint,
    });
  }

  async #response(
    url: string,
    grant: CurrentGrant,
    accept: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetcher(
        url,
        requestInit(grant.accessToken, signal, accept),
      );
    } catch {
      transportFailure(true);
    }
    if (!response.ok) responseFailure(response);
    return response;
  }

  async #metadata(
    grant: CurrentGrant,
    limits: Readonly<ConnectorObjectReadLimits>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ snapshot: DriveSnapshot }>> {
    if (this.#selection === null) sourceFailure();
    const response = await this.#response(
      metadataUrl(this.#selection.objectId),
      grant,
      "application/json",
      signal,
    );
    const snapshot = metadataSnapshot(
      await boundedJson(response, GOOGLE_DRIVE_CONNECTOR_LIMITS.maxMetadataBytes),
      this.#selection.objectId,
      Math.min(limits.maxBytes, GOOGLE_DRIVE_CONNECTOR_LIMITS.maxObjectBytes),
    );
    if (snapshot === null) sourceFailure();
    return Object.freeze({ snapshot });
  }

  async #verifiedAgain(
    actor: ConnectorActor,
    expectedGrant: string,
    expectedSnapshot: DriveSnapshot,
    limits: Readonly<ConnectorObjectReadLimits>,
    signal?: AbortSignal,
  ): Promise<CurrentGrant> {
    const grant = await this.#grant(actor, expectedGrant);
    const current = await this.#metadata(grant, limits, signal);
    if (!snapshotsEqual(expectedSnapshot, current.snapshot)) sourceFailure();
    return grant;
  }

  #verifiedStream(request: Readonly<{
    actor: ConnectorActor;
    limits: Readonly<ConnectorObjectReadLimits>;
    signal?: AbortSignal;
    grantFingerprint: string;
    snapshot: DriveSnapshot;
    expected: DigestReceipt;
    mediaType: string;
    exportSpec: ExportSpec | null;
  }>): AsyncIterable<Uint8Array> {
    const source = this;
    return Object.freeze({
      async *[Symbol.asyncIterator]() {
        if (source.#selection === null) throw new Error(SAFE_STREAM_ERROR);
        let response: Response | null = null;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let completed = false;
        try {
          const before = await source.#verifiedAgain(
            request.actor,
            request.grantFingerprint,
            request.snapshot,
            request.limits,
            request.signal,
          );
          const contentGrant = await source.#grant(
            request.actor,
            request.grantFingerprint,
          );
          const url = request.exportSpec === null
            ? binaryUrl(source.#selection.objectId)
            : exportUrl(source.#selection.objectId, request.exportSpec.mediaType);
          response = await source.#response(
            url,
            contentGrant,
            request.mediaType,
            request.signal,
          );
          const responseMedia = canonicalMediaType(response.headers.get("content-type"));
          const declaredHeader = response.headers.get("content-length");
          const declared = parseContentLength(declaredHeader);
          const maximum = request.exportSpec === null
            ? Math.min(request.limits.maxBytes, GOOGLE_DRIVE_CONNECTOR_LIMITS.maxObjectBytes)
            : Math.min(
                request.limits.maxBytes,
                GOOGLE_DRIVE_CONNECTOR_LIMITS.maxNativeExportBytes,
              );
          if (
            responseMedia !== request.mediaType ||
            (declaredHeader !== null && declared === null) ||
            (declared !== null && declared > maximum) ||
            response.body === null
          ) sourceFailure();
          reader = response.body.getReader();
          const digest = new IncrementalSha256();
          let size = 0;
          while (true) {
            if (request.signal?.aborted) transportFailure(true);
            const next = await reader.read();
            if (next.done) break;
            if (!(next.value instanceof Uint8Array) || size + next.value.byteLength > maximum) {
              sourceFailure();
            }
            size += next.value.byteLength;
            digest.update(next.value);
            yield new Uint8Array(next.value);
          }
          if (
            (declared !== null && declared !== size) ||
            size !== request.expected.size || digest.digest() !== request.expected.sha256
          ) sourceFailure();
          await source.#verifiedAgain(
            request.actor,
            before.fingerprint,
            request.snapshot,
            request.limits,
            request.signal,
          );
          completed = true;
        } catch {
          throw new Error(SAFE_STREAM_ERROR);
        } finally {
          if (!completed) await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
        }
      },
    });
  }

  async readVerifiedSnapshot(request: Readonly<{
    actor: ConnectorActor;
    representation: ConnectorObjectRepresentation;
    limits: Readonly<ConnectorObjectReadLimits>;
    signal?: AbortSignal;
  }>): Promise<ConnectorObjectReadResult> {
    try {
      if (
        this.#selection === null || request.limits.maxRedirects < 0 ||
        request.limits.maxRedirects > CONNECTOR_OBJECT_LIMITS.maxRedirects ||
        request.limits.fetchTimeoutMilliseconds <= 0 ||
        request.limits.fetchTimeoutMilliseconds >
          GOOGLE_DRIVE_CONNECTOR_LIMITS.fetchTimeoutMilliseconds ||
        request.limits.maxBytes <= 0 ||
        request.limits.maxBytes > GOOGLE_DRIVE_CONNECTOR_LIMITS.maxObjectBytes ||
        request.signal?.aborted
      ) sourceFailure();

      const grant = await this.#grant(request.actor);
      const initial = await this.#metadata(grant, request.limits, request.signal);
      const isNative = Object.values(GOOGLE_DRIVE_NATIVE_MEDIA_TYPES).includes(
        initial.snapshot.mediaType as typeof GOOGLE_DRIVE_NATIVE_MEDIA_TYPES[
          keyof typeof GOOGLE_DRIVE_NATIVE_MEDIA_TYPES
        ],
      );

      let representation: ConnectorObjectRepresentation;
      let displayFilename: string;
      let mediaType: string;
      let expected: DigestReceipt;
      let selectedExport: ExportSpec | null = null;

      if (!isNative && request.representation.kind === "binary") {
        if (
          initial.snapshot.size === null || initial.snapshot.sha256 === null ||
          !safeFilename(initial.snapshot.name)
        ) sourceFailure();
        representation = Object.freeze({ kind: "binary" });
        displayFilename = initial.snapshot.name;
        mediaType = initial.snapshot.mediaType;
        expected = Object.freeze({
          size: initial.snapshot.size,
          sha256: initial.snapshot.sha256,
        });
      } else if (isNative) {
        const selected = exportSpec(request.representation, initial.snapshot.mediaType);
        if (selected === null || request.representation.kind !== "export_snapshot") {
          sourceFailure();
        }
        selectedExport = selected;
        representation = request.representation;
        displayFilename = request.representation.displayFilename;
        mediaType = selected.mediaType;
        const exportGrant = await this.#grant(request.actor, grant.fingerprint);
        const response = await this.#response(
          exportUrl(this.#selection.objectId, selected.mediaType),
          exportGrant,
          selected.mediaType,
          request.signal,
        );
        expected = await digestResponse(
          response,
          Math.min(
            request.limits.maxBytes,
            GOOGLE_DRIVE_CONNECTOR_LIMITS.maxNativeExportBytes,
          ),
          selected.mediaType,
          request.signal,
        );
        await this.#verifiedAgain(
          request.actor,
          grant.fingerprint,
          initial.snapshot,
          request.limits,
          request.signal,
        );
      } else {
        sourceFailure();
      }

      const input: Readonly<VerifiedFileInput> = Object.freeze({
        sourceKind: "connector_object",
        representation,
        stream: this.#verifiedStream({
          actor: request.actor,
          limits: request.limits,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          grantFingerprint: grant.fingerprint,
          snapshot: initial.snapshot,
          expected,
          mediaType,
          exportSpec: selectedExport,
        }),
        displayFilename,
        advisoryMediaType: mediaType,
        size: expected.size,
        sha256: expected.sha256,
      });
      return Object.freeze({ kind: "ready", input });
    } catch (error) {
      return unavailable(error);
    }
  }
}

export function createGoogleDriveConnectorObjectSource(
  selection: unknown,
  options: GoogleDriveConnectorObjectSourceOptions,
): AuthorizedConnectorObjectSource {
  return new GoogleDriveConnectorObjectSource(selection, options);
}

/** Narrow construction seam; it does not enable a hosted provider capability. */
export function createGoogleDriveConnectorIngress(options: Readonly<{
  selection: unknown;
  grants: GoogleDriveGrantResolver;
  fetcher?: typeof fetch;
  staging: Pick<
    BundleFileStagingService,
    "authorizeSourceRead" | "stageStream"
  >;
  fetchTimeoutMilliseconds?: number;
}>): Readonly<{
  source: AuthorizedConnectorObjectSource;
  ingress: AuthorizedConnectorIngressService;
}> {
  const source = createGoogleDriveConnectorObjectSource(options.selection, {
    grants: options.grants,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  const ingress = new AuthorizedConnectorIngressService({
    staging: options.staging,
    ...(options.fetchTimeoutMilliseconds === undefined
      ? {}
      : { fetchTimeoutMilliseconds: options.fetchTimeoutMilliseconds }),
  });
  return Object.freeze({ source, ingress });
}
