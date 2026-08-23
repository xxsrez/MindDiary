import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  BundleFileMediaType,
  Sha256Digest,
  SpaceId,
} from "@mind-diary/domain";
import type { StagedBundleFileRecord } from "@mind-diary/application-ports";
import {
  BUNDLE_FILE_LIMITS,
  BundleFileStagingService,
  detectBundleFileMediaType,
  type StageBundleFileResult,
} from "./bundle-files.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

/**
 * The local companion is deliberately an adapter boundary.  A local path is
 * accepted only by `LocalCompanionFileSystem`; this application-facing input
 * never contains that path.  This keeps local filesystem details out of the
 * staged record, idempotency payload and hosted transport.
 */
export type LocalCompanionSourceKind =
  | "local_path"
  | "workspace/generated_artifact"
  | "bounded_in_memory";

export type LocalCompanionFileKind =
  | "regular"
  | "directory"
  | "symlink"
  | "special"
  | "missing";

export interface LocalCompanionFileInspection {
  /** Internal adapter value. It must never be copied to an upload request. */
  readonly canonicalPath: string;
  readonly displayFilename: string;
  readonly kind: LocalCompanionFileKind;
  /** Opaque local snapshot identity used only for before/after comparison. */
  readonly snapshotId: string;
  readonly size: number;
  /** Explicit path authority established by the local companion adapter. */
  readonly authority: "local" | "workspace" | "none";
  /** False for a lexical path containing a symlink or unresolved traversal. */
  readonly canonical: boolean;
}

export interface LocalCompanionFileReadOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

/**
 * Minimal filesystem port for a local companion process.  A Node/macOS
 * adapter can implement this with `lstat`/`realpath`/`open(O_NOFOLLOW)`;
 * the application core does not import a host filesystem or receive paths.
 */
export interface LocalCompanionFileSystem {
  inspect(path: string): Promise<Readonly<LocalCompanionFileInspection>>;
  read(
    path: string,
    options: Readonly<LocalCompanionFileReadOptions>,
  ): Promise<readonly Uint8Array[]>;
}

export interface VerifiedLocalCompanionFileInput {
  readonly sourceKind: LocalCompanionSourceKind;
  readonly bytes: Uint8Array;
  readonly safeDisplayFilename: string;
  readonly detectedMediaType: BundleFileMediaType;
  readonly size: number;
  readonly sha256: Sha256Digest;
}

export interface LocalCompanionUploadRequest {
  readonly input: Readonly<VerifiedLocalCompanionFileInput>;
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

/**
 * Out-of-band upload boundary.  The path is intentionally absent.  A local
 * implementation can call BundleFileStagingService directly; a hosted
 * companion implementation can replace this with an expiring upload-intent
 * or binary stream without changing the local path verifier.
 */
export interface LocalCompanionUploadTransport {
  upload(request: Readonly<LocalCompanionUploadRequest>): Promise<StageBundleFileResult>;
}

export interface LocalCompanionAuthorizationRequest {
  readonly operation: "upload_local_file" | "upload_bytes";
  readonly sourceKind: LocalCompanionSourceKind;
  readonly displayFilename: string | null;
}

export type LocalCompanionAuthorizationResult =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{ kind: "denied"; code?: string }>;

export interface LocalCompanionLogger {
  /** Only closed, privacy-safe dimensions are allowed in this callback. */
  record(event: Readonly<{
    readonly operation: "upload_local_file" | "upload_bytes";
    readonly sourceKind: LocalCompanionSourceKind;
    readonly outcome: "started" | "success" | "failure" | "retry";
    readonly code?: string;
    readonly attempt: number;
    readonly size?: number;
  }>): void | Promise<void>;
}

export interface LocalCompanionCleanupRequest {
  /** Cleanup is explicitly opt-in; user-selected source files are untouched. */
  readonly cleanup?: () => void | Promise<void>;
  readonly cleanupMode?: "always" | "success";
}

export interface LocalCompanionTarget {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
}

export interface LocalCompanionMetadata extends LocalCompanionCleanupRequest {
  readonly displayFilename?: unknown;
  readonly claimedMediaType?: unknown;
  readonly expectedSize?: unknown;
  readonly expectedSha256?: unknown;
  readonly idempotencyKey: unknown;
  readonly signal?: AbortSignal;
}

export interface UploadLocalFileRequest
  extends LocalCompanionTarget, LocalCompanionMetadata {
  readonly path: unknown;
  readonly sourceKind?: unknown;
}

export interface UploadBytesRequest
  extends LocalCompanionTarget, LocalCompanionMetadata {
  readonly bytes: unknown;
  /** Bytes are local/generated only; server_generated is owned by MD-273. */
  readonly sourceKind?: unknown;
}

export type LocalCompanionInvalidCode =
  | "authentication_required"
  | "forbidden"
  | "invalid_path"
  | "file_ingress_source_unavailable"
  | "file_ingress_source_unsupported"
  | "file_ingress_transport_unavailable"
  | "file_ingress_intent_expired"
  | "file_ingress_intent_conflict"
  | "bundle_file_size_limit_exceeded"
  | "bundle_file_media_mismatch"
  | "unsupported_bundle_file_type"
  | "invalid_bundle_file_name"
  | "expected_size_mismatch"
  | "expected_sha256_mismatch"
  | "local_companion_file_changed"
  | "local_companion_cancelled"
  | "local_companion_concurrency_limit"
  | "local_companion_invalid_bytes"
  | "local_companion_invalid_source_kind"
  | "local_companion_invalid_media_type"
  | "local_companion_authorization_denied";

export type LocalCompanionResult =
  | StageBundleFileResult
  | Readonly<{ kind: "invalid"; code: LocalCompanionInvalidCode }>;

export class LocalCompanionTransportFailure extends Error {
  readonly name = "LocalCompanionTransportFailure";

  constructor(
    readonly code:
      | "file_ingress_transport_unavailable"
      | "file_ingress_intent_expired"
      | "file_ingress_intent_conflict"
      | "file_ingress_source_unavailable"
      | "file_ingress_source_unsupported",
    message = "Local companion upload transport failed.",
    readonly retryable = code === "file_ingress_transport_unavailable",
    readonly unknownOutcome = false,
  ) {
    super(message);
  }
}

export const LOCAL_COMPANION_LIMITS = Object.freeze({
  maxFileBytes: BUNDLE_FILE_LIMITS.maxFileBytes,
  maxBoundedBytes: 4_194_304,
  defaultMaxAttempts: 3,
  defaultMaxConcurrentUploads: 2,
});

const CONTROL = /[\u0000-\u001f\u007f]/u;
const GLOB = /[*?\[\]{}]/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ABSOLUTE_POSIX = /^\//u;
const ABSOLUTE_WINDOWS = /^[A-Za-z]:[\\/]/u;
const MIME_TYPES = new Set<BundleFileMediaType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
]);
const EXTENSIONS: Readonly<Record<BundleFileMediaType, readonly string[]>> = Object.freeze({
  "image/png": Object.freeze([".png"]),
  "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
  "image/gif": Object.freeze([".gif"]),
  "image/webp": Object.freeze([".webp"]),
  "application/pdf": Object.freeze([".pdf"]),
  "application/zip": Object.freeze([".zip"]),
});

function invalid(code: LocalCompanionInvalidCode): Readonly<{ kind: "invalid"; code: LocalCompanionInvalidCode }> {
  return Object.freeze({ kind: "invalid", code });
}

function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_POSIX.test(path) || ABSOLUTE_WINDOWS.test(path);
}

function hasTraversal(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => segment === "..");
}

function validPathInput(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !CONTROL.test(value) &&
    !GLOB.test(value) &&
    !hasTraversal(value) &&
    isAbsolutePath(value);
}

function validFilename(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    !CONTROL.test(value) &&
    new TextEncoder().encode(value).byteLength <= 255;
}

function validExpectedSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validExpectedSha256(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256.test(value);
}

function validSourceKind(value: unknown): LocalCompanionSourceKind | null {
  return value === "local_path" ||
      value === "workspace/generated_artifact" ||
      value === "bounded_in_memory"
    ? value
    : null;
}

function extensionMatches(filename: string, mediaType: BundleFileMediaType): boolean {
  const lower = filename.toLocaleLowerCase("en-US");
  return EXTENSIONS[mediaType].some((extension) => lower.endsWith(extension));
}

function sameInspection(
  before: Readonly<LocalCompanionFileInspection>,
  after: Readonly<LocalCompanionFileInspection>,
): boolean {
  return before.kind === "regular" &&
    after.kind === "regular" &&
    before.canonicalPath === after.canonicalPath &&
    before.snapshotId === after.snapshotId &&
    before.size === after.size &&
    before.authority === after.authority &&
    before.canonical === after.canonical;
}

function safeLoggerRecord(logger: LocalCompanionLogger | undefined, event: Parameters<LocalCompanionLogger["record"]>[0]): void {
  if (logger === undefined) return;
  try {
    const result = logger.record(event);
    if (typeof result === "object" && result !== null && "catch" in result && typeof result.catch === "function") {
      void result.catch(() => undefined);
    }
  } catch {
    // Local telemetry cannot alter an upload outcome.
  }
}

function authorizationAllowed(result: LocalCompanionAuthorizationResult): boolean {
  return result.kind === "allowed";
}

function transportCode(error: unknown): LocalCompanionInvalidCode {
  if (error instanceof LocalCompanionTransportFailure) return error.code;
  return "file_ingress_transport_unavailable";
}

function transportRetryable(error: unknown): boolean {
  return error instanceof LocalCompanionTransportFailure
    ? error.retryable || error.unknownOutcome
    : true;
}

function transportUnknownOutcome(error: unknown): boolean {
  return error instanceof LocalCompanionTransportFailure && error.unknownOutcome;
}

/**
 * Local companion application boundary for disk/workspace/generated files.
 * It performs a bounded, two-snapshot read and delegates the final stage gate
 * to the same BundleFile staging service as native and generated sources.
 */
export class LocalFileCompanion {
  readonly #filesystem: LocalCompanionFileSystem;
  readonly #transport: LocalCompanionUploadTransport;
  readonly #authorize: (
    request: Readonly<LocalCompanionAuthorizationRequest>,
  ) => Promise<LocalCompanionAuthorizationResult>;
  readonly #logger: LocalCompanionLogger | undefined;
  readonly #maxAttempts: number;
  readonly #maxConcurrent: number;
  #activeUploads = 0;

  constructor(dependencies: {
    readonly filesystem: LocalCompanionFileSystem;
    readonly transport: LocalCompanionUploadTransport;
    readonly authorize: (
      request: Readonly<LocalCompanionAuthorizationRequest>,
    ) => Promise<LocalCompanionAuthorizationResult>;
    readonly logger?: LocalCompanionLogger;
    readonly maxAttempts?: number;
    readonly maxConcurrentUploads?: number;
  }) {
    if (!Number.isSafeInteger(dependencies.maxAttempts ?? LOCAL_COMPANION_LIMITS.defaultMaxAttempts) ||
      (dependencies.maxAttempts ?? LOCAL_COMPANION_LIMITS.defaultMaxAttempts) < 1 ||
      !Number.isSafeInteger(dependencies.maxConcurrentUploads ?? LOCAL_COMPANION_LIMITS.defaultMaxConcurrentUploads) ||
      (dependencies.maxConcurrentUploads ?? LOCAL_COMPANION_LIMITS.defaultMaxConcurrentUploads) < 1) {
      throw new TypeError("Local companion limits are invalid.");
    }
    this.#filesystem = dependencies.filesystem;
    this.#transport = dependencies.transport;
    this.#authorize = dependencies.authorize;
    this.#logger = dependencies.logger;
    this.#maxAttempts = dependencies.maxAttempts ?? LOCAL_COMPANION_LIMITS.defaultMaxAttempts;
    this.#maxConcurrent = dependencies.maxConcurrentUploads ?? LOCAL_COMPANION_LIMITS.defaultMaxConcurrentUploads;
  }

  /** Explicit operation name matching the local companion contract. */
  upload_local_file(request: UploadLocalFileRequest): Promise<LocalCompanionResult> {
    return this.uploadLocalFile(request);
  }

  /** Explicit operation name matching the local companion contract. */
  upload_bytes(request: UploadBytesRequest): Promise<LocalCompanionResult> {
    return this.uploadBytes(request);
  }

  async uploadLocalFile(request: UploadLocalFileRequest): Promise<LocalCompanionResult> {
    const sourceKind = request.sourceKind === undefined
      ? "local_path"
      : validSourceKind(request.sourceKind);
    if (sourceKind === null || sourceKind === "bounded_in_memory") {
      return invalid("local_companion_invalid_source_kind");
    }
    if (!validPathInput(request.path)) return invalid("invalid_path");
    const path = request.path;
    const maxBytes = LOCAL_COMPANION_LIMITS.maxFileBytes;
    const acquired = this.#acquire();
    if (!acquired) return invalid("local_companion_concurrency_limit");
    const cleanup = request.cleanup;
    let success = false;
    try {
      const authorized = await this.#authorize({
        operation: "upload_local_file",
        sourceKind,
        displayFilename: validFilename(request.displayFilename) ? request.displayFilename : null,
      });
      if (!authorizationAllowed(authorized)) return invalid("local_companion_authorization_denied");
      const before = await this.#inspect(path);
      if (before === null) return invalid("file_ingress_source_unavailable");
      if (before.kind === "missing") return invalid("file_ingress_source_unavailable");
      if (before.kind === "directory") return invalid("file_ingress_source_unsupported");
      if (before.kind === "symlink") return invalid("file_ingress_source_unsupported");
      if (before.kind === "special") return invalid("file_ingress_source_unsupported");
      if (!before.canonical) return invalid("invalid_path");
      const expectedAuthority = sourceKind === "workspace/generated_artifact"
        ? "workspace"
        : "local";
      if (before.authority !== expectedAuthority) return invalid("file_ingress_source_unsupported");
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
        return invalid("bundle_file_size_limit_exceeded");
      }
      const bytes = await this.#read(path, maxBytes, request.signal);
      if (bytes === null) return invalid(request.signal?.aborted ? "local_companion_cancelled" : "file_ingress_source_unavailable");
      if (bytes.byteLength !== before.size) return invalid("local_companion_file_changed");
      const after = await this.#inspect(path);
      if (after === null || !sameInspection(before, after)) return invalid("local_companion_file_changed");
      const result = await this.#stage({
        ...request,
        sourceKind,
        displayFilename: request.displayFilename ?? before.displayFilename,
        bytes,
      });
      success = result.kind === "staged";
      return result;
    } finally {
      await this.#cleanup(cleanup, request.cleanupMode, success, "upload_local_file", sourceKind);
      this.#release();
    }
  }

  async uploadBytes(request: UploadBytesRequest): Promise<LocalCompanionResult> {
    const sourceKind = request.sourceKind === undefined
      ? "bounded_in_memory"
      : validSourceKind(request.sourceKind);
    if (sourceKind !== "bounded_in_memory") return invalid("local_companion_invalid_source_kind");
    const acquired = this.#acquire();
    if (!acquired) return invalid("local_companion_concurrency_limit");
    let success = false;
    try {
      const displayFilename = validFilename(request.displayFilename)
        ? request.displayFilename
        : null;
      if (displayFilename === null) return invalid("invalid_bundle_file_name");
      const authorized = await this.#authorize({
        operation: "upload_bytes",
        sourceKind,
        displayFilename,
      });
      if (!authorizationAllowed(authorized)) return invalid("local_companion_authorization_denied");
      const bytes = this.#bytes(request.bytes, LOCAL_COMPANION_LIMITS.maxBoundedBytes);
      if (bytes === null) return invalid(request.signal?.aborted ? "local_companion_cancelled" : "local_companion_invalid_bytes");
      const result = await this.#stage({ ...request, sourceKind, displayFilename, bytes });
      success = result.kind === "staged";
      return result;
    } finally {
      await this.#cleanup(request.cleanup, request.cleanupMode, success, "upload_bytes", sourceKind);
      this.#release();
    }
  }

  #acquire(): boolean {
    if (this.#activeUploads >= this.#maxConcurrent) return false;
    this.#activeUploads += 1;
    return true;
  }

  #release(): void {
    this.#activeUploads -= 1;
  }

  async #inspect(path: string): Promise<Readonly<LocalCompanionFileInspection> | null> {
    try {
      return await this.#filesystem.inspect(path);
    } catch {
      return null;
    }
  }

  async #read(path: string, maxBytes: number, signal: AbortSignal | undefined): Promise<Uint8Array | null> {
    if (signal?.aborted) return null;
    let chunks: readonly Uint8Array[];
    try {
      chunks = await this.#filesystem.read(path, { maxBytes, ...(signal === undefined ? {} : { signal }) });
    } catch {
      return null;
    }
    let size = 0;
    const owned: Uint8Array[] = [];
    for (const chunk of chunks) {
      if (signal?.aborted) return null;
      if (!(chunk instanceof Uint8Array)) return null;
      const copy = new Uint8Array(chunk);
      size += copy.byteLength;
      if (size > maxBytes) return null;
      owned.push(copy);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of owned) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  #bytes(value: unknown, maxBytes: number): Uint8Array | null {
    if (!(value instanceof Uint8Array)) return null;
    if (value.byteLength > maxBytes) return null;
    return new Uint8Array(value);
  }

  async #stage(
    request: Readonly<LocalCompanionTarget & LocalCompanionMetadata & {
      readonly sourceKind: LocalCompanionSourceKind;
      readonly displayFilename: unknown;
      readonly bytes: Uint8Array;
    }>,
  ): Promise<LocalCompanionResult> {
    if (request.signal?.aborted) return invalid("local_companion_cancelled");
    const displayFilename = validFilename(request.displayFilename)
      ? request.displayFilename
      : null;
    if (displayFilename === null) return invalid("invalid_bundle_file_name");
    const detected = detectBundleFileMediaType(request.bytes);
    if (detected === null) return invalid("unsupported_bundle_file_type");
    if (!extensionMatches(displayFilename, detected)) return invalid("bundle_file_media_mismatch");
    if (request.claimedMediaType !== undefined &&
      (typeof request.claimedMediaType !== "string" || !MIME_TYPES.has(request.claimedMediaType as BundleFileMediaType))) {
      return invalid("local_companion_invalid_media_type");
    }
    if (request.claimedMediaType !== undefined && request.claimedMediaType !== detected) {
      return invalid("bundle_file_media_mismatch");
    }
    if (request.expectedSize !== undefined &&
      (!validExpectedSize(request.expectedSize) || request.expectedSize !== request.bytes.byteLength)) {
      return invalid("expected_size_mismatch");
    }
    const digest = new IncrementalSha256();
    digest.update(request.bytes);
    const sha256 = digest.digest();
    if (request.expectedSha256 !== undefined &&
      (!validExpectedSha256(request.expectedSha256) || request.expectedSha256 !== sha256)) {
      return invalid("expected_sha256_mismatch");
    }
    if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.length === 0 || CONTROL.test(request.idempotencyKey) || new TextEncoder().encode(request.idempotencyKey).byteLength > 256) {
      return invalid("file_ingress_intent_conflict");
    }
    const input: Readonly<VerifiedLocalCompanionFileInput> = Object.freeze({
      sourceKind: request.sourceKind,
      bytes: new Uint8Array(request.bytes),
      safeDisplayFilename: displayFilename,
      detectedMediaType: detected,
      size: request.bytes.byteLength,
      sha256,
    });
    safeLoggerRecord(this.#logger, {
      operation: request.sourceKind === "bounded_in_memory" ? "upload_bytes" : "upload_local_file",
      sourceKind: request.sourceKind,
      outcome: "started",
      attempt: 1,
      size: input.size,
    });
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (request.signal?.aborted) return invalid("local_companion_cancelled");
      try {
        const result = await this.#transport.upload(Object.freeze({
          input,
          actor: request.actor,
          spaceId: request.spaceId,
          writeBindingId: request.writeBindingId,
          idempotencyKey: request.idempotencyKey,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }));
        safeLoggerRecord(this.#logger, {
          operation: request.sourceKind === "bounded_in_memory" ? "upload_bytes" : "upload_local_file",
          sourceKind: request.sourceKind,
          outcome: result.kind === "staged" ? "success" : "failure",
          code: result.kind === "invalid" ? result.code : result.kind,
          attempt,
          size: input.size,
        });
        return result;
      } catch (error) {
        const code = transportCode(error);
        const retry = transportRetryable(error) && attempt < this.#maxAttempts && !request.signal?.aborted;
        safeLoggerRecord(this.#logger, {
          operation: request.sourceKind === "bounded_in_memory" ? "upload_bytes" : "upload_local_file",
          sourceKind: request.sourceKind,
          outcome: retry ? "retry" : "failure",
          code,
          attempt,
          size: input.size,
        });
        if (retry) continue;
        if (request.signal?.aborted) return invalid("local_companion_cancelled");
        if (transportUnknownOutcome(error) && code === "file_ingress_transport_unavailable") {
          return invalid("file_ingress_transport_unavailable");
        }
        return invalid(code);
      }
    }
    return invalid("file_ingress_transport_unavailable");
  }

  async #cleanup(
    cleanup: (() => void | Promise<void>) | undefined,
    mode: "always" | "success" | undefined,
    success: boolean,
    operation: "upload_local_file" | "upload_bytes",
    sourceKind: LocalCompanionSourceKind,
  ): Promise<void> {
    if (cleanup === undefined || (mode === "success" && !success)) return;
    try {
      await cleanup();
    } catch {
      safeLoggerRecord(this.#logger, {
        operation,
        sourceKind,
        outcome: "failure",
        code: "local_companion_cleanup_failed",
        attempt: 1,
      });
    }
  }
}

/**
 * Local deterministic transport used by dev/tests. It is intentionally a
 * narrow adapter: only verified bytes/metadata cross into BundleFile staging.
 */
export function createLocalCompanionStagingTransport(dependencies: {
  readonly staging: Pick<BundleFileStagingService, "stage">;
}): LocalCompanionUploadTransport {
  return Object.freeze({
    async upload(request: Readonly<LocalCompanionUploadRequest>): Promise<StageBundleFileResult> {
      if (request.signal?.aborted) {
        throw new LocalCompanionTransportFailure("file_ingress_transport_unavailable", "Upload cancelled.", false);
      }
      return dependencies.staging.stage({
        actor: request.actor,
        spaceId: request.spaceId,
        writeBindingId: request.writeBindingId,
        bytes: request.input.bytes,
        sourceKind: request.input.sourceKind,
        displayFilename: request.input.safeDisplayFilename,
        claimedMediaType: request.input.detectedMediaType,
        expectedSize: request.input.size,
        expectedSha256: request.input.sha256,
        idempotencyKey: request.idempotencyKey,
      });
    },
  });
}

export type LocalCompanionStagedRecord = Readonly<StagedBundleFileRecord>;
