import {
  bundleFileMediaType,
  type BundleFileMediaType,
  type Sha256Digest,
} from "@mind-diary/domain";
import {
  BUNDLE_FILE_LIMITS,
  detectBundleFileMediaType,
} from "./bundle-files.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

export type LocalCompanionSourceKind =
  | "local_path"
  | "workspace/generated_artifact";

export type LocalCompanionFileKind =
  | "regular"
  | "directory"
  | "symlink"
  | "special"
  | "missing";

export interface LocalCompanionFileInspection {
  readonly displayFilename: string;
  readonly kind: LocalCompanionFileKind;
  /** Opaque adapter-owned dev/inode/size/time snapshot. */
  readonly snapshotId: string;
  readonly size: number;
  readonly authority: "local" | "workspace" | "none";
  readonly canonical: boolean;
}

export interface LocalCompanionOpenFile {
  readonly inspection: Readonly<LocalCompanionFileInspection>;
  inspect(): Promise<Readonly<LocalCompanionFileInspection>>;
  stream(options: Readonly<{
    maxBytes: number;
    signal?: AbortSignal;
  }>): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

export type LocalCompanionOpenResult =
  | Readonly<{ kind: "opened"; file: LocalCompanionOpenFile }>
  | Readonly<{
      kind: "invalid";
      code:
        | "file_ingress_source_unavailable"
        | "file_ingress_source_unsupported"
        | "invalid_path";
    }>;

/** The absolute path stops at this local adapter boundary. */
export interface LocalCompanionFileSystem {
  open(path: string): Promise<LocalCompanionOpenResult>;
}

export interface LocalCompanionPreparedReceipt {
  readonly local_file_ref: string;
  readonly source_kind: LocalCompanionSourceKind;
  readonly display_filename: string;
  readonly claimed_media_type: BundleFileMediaType;
  readonly expected_size: number;
  readonly expected_sha256: Sha256Digest;
  readonly expires_at: string;
}

export interface LocalCompanionStagedReceipt {
  readonly staged_file_ref: string;
  readonly state: "verified";
  readonly source_kind: LocalCompanionSourceKind;
  readonly display_filename: string;
  readonly media_type: BundleFileMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly expires_at: string;
  readonly replayed: boolean;
}

export interface LocalCompanionHostedUploadRequest {
  readonly uploadUrl: string;
  readonly stream: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

/** Path-free MD-305 GET-before-PUT/reconcile transport. */
export interface LocalCompanionHostedUploadTransport {
  upload(
    request: Readonly<LocalCompanionHostedUploadRequest>,
  ): Promise<Readonly<LocalCompanionStagedReceipt>>;
}

export type LocalCompanionHostedFailureCode =
  | "invalid_upload_url"
  | "file_ingress_source_unavailable"
  | "file_ingress_intent_expired"
  | "file_ingress_intent_conflict"
  | "file_ingress_transport_unavailable"
  | "invalid_request"
  | "bundle_file_size_limit_exceeded"
  | "bundle_file_size_mismatch"
  | "bundle_file_digest_mismatch"
  | "invalid_bundle_file_name"
  | "staging_quota_exceeded"
  | "capacity_soft_limit"
  | "capacity_hard_limit"
  | "capacity_fairness_limit"
  | "capacity_accounting_untrusted";

export class LocalCompanionHostedFailure extends Error {
  readonly name = "LocalCompanionHostedFailure";

  constructor(
    readonly code: LocalCompanionHostedFailureCode,
    readonly retryable = code === "file_ingress_transport_unavailable",
    readonly unknownOutcome = false,
  ) {
    super("The hosted file upload operation did not complete.");
  }
}

export interface LocalCompanionLogger {
  /** This closed record intentionally cannot contain paths, refs, URLs or names. */
  record(event: Readonly<{
    operation: "prepare_local_file" | "upload_prepared_file";
    source_kind: LocalCompanionSourceKind;
    outcome: "success" | "failure" | "retry";
    code?: LocalCompanionInvalidCode;
    size?: number;
  }>): void | Promise<void>;
}

export type LocalCompanionInvalidCode =
  | "invalid_path"
  | "file_ingress_source_unavailable"
  | "file_ingress_source_unsupported"
  | "file_ingress_transport_unavailable"
  | "file_ingress_intent_expired"
  | "file_ingress_intent_conflict"
  | "bundle_file_size_limit_exceeded"
  | "bundle_file_size_mismatch"
  | "bundle_file_digest_mismatch"
  | "invalid_bundle_file_name"
  | "staging_quota_exceeded"
  | "capacity_soft_limit"
  | "capacity_hard_limit"
  | "capacity_fairness_limit"
  | "capacity_accounting_untrusted"
  | "local_companion_file_changed"
  | "local_companion_cancelled"
  | "local_companion_concurrency_limit"
  | "local_companion_invalid_source_kind"
  | "local_companion_ref_not_found"
  | "local_companion_ref_expired"
  | "local_companion_ref_in_use"
  | "invalid_request"
  | "invalid_upload_url";

export type PrepareLocalFileResult =
  | Readonly<{ kind: "prepared"; prepared_file: LocalCompanionPreparedReceipt }>
  | Readonly<{ kind: "invalid"; code: LocalCompanionInvalidCode }>;

export type UploadPreparedFileResult =
  | Readonly<{ kind: "staged"; staged_file: LocalCompanionStagedReceipt }>
  | Readonly<{
      kind: "invalid";
      code: LocalCompanionInvalidCode;
      retryable?: boolean;
    }>;

export interface PrepareLocalFileRequest {
  readonly path: unknown;
  readonly source_kind?: unknown;
  readonly display_filename?: unknown;
  readonly claimed_media_type?: unknown;
  readonly expected_size?: unknown;
  readonly expected_sha256?: unknown;
  readonly signal?: AbortSignal;
}

export interface UploadPreparedFileRequest {
  readonly local_file_ref: unknown;
  readonly upload_url: unknown;
  readonly signal?: AbortSignal;
}

export const LOCAL_COMPANION_LIMITS = Object.freeze({
  maxFileBytes: BUNDLE_FILE_LIMITS.maxFileBytes,
  preparedTtlMilliseconds: 600_000,
  defaultMaxPreparedFiles: 8,
  prefixBytes: 64,
});

const CONTROL = /[\u0000-\u001f\u007f]/u;
const GLOB = /[*?\[\]{}]/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ABSOLUTE_POSIX = /^\//u;
const ABSOLUTE_WINDOWS = /^[A-Za-z]:[\\/]/u;
const LOCAL_REF = /^mdlocal_v1_[A-Za-z0-9_-]{16,256}$/u;

function invalid(
  code: LocalCompanionInvalidCode,
  retryable?: boolean,
): Readonly<{
  kind: "invalid";
  code: LocalCompanionInvalidCode;
  retryable?: boolean;
}> {
  return Object.freeze({
    kind: "invalid",
    code,
    ...(retryable === undefined ? {} : { retryable }),
  });
}

function validPathInput(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !CONTROL.test(value) &&
    !GLOB.test(value) &&
    !value.split(/[\\/]/u).includes("..") &&
    (ABSOLUTE_POSIX.test(value) || ABSOLUTE_WINDOWS.test(value));
}

function validFilename(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !CONTROL.test(value) &&
    new TextEncoder().encode(value).byteLength <= 255;
}

function sourceKind(value: unknown): LocalCompanionSourceKind | null {
  if (value === undefined || value === "local_path") return "local_path";
  return value === "workspace/generated_artifact" ? value : null;
}

function expectedSize(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
      (value as number) <= LOCAL_COMPANION_LIMITS.maxFileBytes
    ? value as number
    : null;
}

function expectedSha256(value: unknown): Sha256Digest | null {
  return typeof value === "string" && SHA256.test(value)
    ? value as Sha256Digest
    : null;
}

function sameSnapshot(
  left: Readonly<LocalCompanionFileInspection>,
  right: Readonly<LocalCompanionFileInspection>,
): boolean {
  return left.kind === "regular" &&
    right.kind === "regular" &&
    left.snapshotId === right.snapshotId &&
    left.size === right.size &&
    left.authority === right.authority &&
    left.canonical === right.canonical;
}

function recordLog(
  logger: LocalCompanionLogger | undefined,
  event: Parameters<LocalCompanionLogger["record"]>[0],
): void {
  if (logger === undefined) return;
  try {
    const result = logger.record(event);
    if (result instanceof Promise) void result.catch(() => undefined);
  } catch {
    // Telemetry cannot affect the local file result.
  }
}

type StreamDigest = Readonly<{
  sha256: Sha256Digest;
  size: number;
  prefix: Uint8Array;
}>;

async function digestStream(
  stream: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<StreamDigest> {
  const digest = new IncrementalSha256();
  const prefix = new Uint8Array(LOCAL_COMPANION_LIMITS.prefixBytes);
  let prefixSize = 0;
  let size = 0;
  for await (const chunk of stream) {
    if (signal?.aborted) throw new LocalCompanionReadFailure("cancelled");
    if (!(chunk instanceof Uint8Array)) {
      throw new LocalCompanionReadFailure("unavailable");
    }
    if (size + chunk.byteLength > LOCAL_COMPANION_LIMITS.maxFileBytes) {
      throw new LocalCompanionReadFailure("oversize");
    }
    if (prefixSize < prefix.byteLength) {
      const copied = Math.min(prefix.byteLength - prefixSize, chunk.byteLength);
      prefix.set(chunk.subarray(0, copied), prefixSize);
      prefixSize += copied;
    }
    size += chunk.byteLength;
    digest.update(chunk);
  }
  return Object.freeze({
    sha256: digest.digest(),
    size,
    prefix: prefix.subarray(0, prefixSize),
  });
}

class LocalCompanionReadFailure extends Error {
  readonly name = "LocalCompanionReadFailure";
  constructor(readonly reason: "cancelled" | "oversize" | "unavailable") {
    super("The local file could not be read.");
  }
}

function mapReadFailure(error: unknown): LocalCompanionInvalidCode {
  if (error instanceof LocalCompanionReadFailure) {
    if (error.reason === "cancelled") return "local_companion_cancelled";
    if (error.reason === "oversize") return "bundle_file_size_limit_exceeded";
  }
  return "file_ingress_source_unavailable";
}

function advisoryMediaType(
  claimed: unknown,
  prefix: Uint8Array,
): BundleFileMediaType {
  if (typeof claimed === "string") return bundleFileMediaType(claimed);
  return detectBundleFileMediaType(prefix) ??
    bundleFileMediaType("application/octet-stream");
}

function validReceipt(
  value: unknown,
): value is Readonly<LocalCompanionStagedReceipt> {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.staged_file_ref === "string" &&
    receipt.staged_file_ref.length > 0 &&
    receipt.staged_file_ref.length <= 512 &&
    !CONTROL.test(receipt.staged_file_ref) &&
    receipt.state === "verified" &&
    (receipt.source_kind === "local_path" ||
      receipt.source_kind === "workspace/generated_artifact") &&
    validFilename(receipt.display_filename) &&
    typeof receipt.media_type === "string" &&
    bundleFileMediaType(receipt.media_type) === receipt.media_type &&
    typeof receipt.sha256 === "string" && SHA256.test(receipt.sha256) &&
    Number.isSafeInteger(receipt.size) && (receipt.size as number) >= 0 &&
    (receipt.size as number) <= LOCAL_COMPANION_LIMITS.maxFileBytes &&
    typeof receipt.expires_at === "string" &&
    Number.isFinite(Date.parse(receipt.expires_at)) &&
    typeof receipt.replayed === "boolean";
}

interface PreparedFile {
  readonly file: LocalCompanionOpenFile;
  readonly inspection: Readonly<LocalCompanionFileInspection>;
  readonly receipt: LocalCompanionPreparedReceipt;
  state: "ready" | "uploading";
}

/**
 * Two-step local companion used by the installable connector:
 * prepare_local_file -> hosted create_file_upload_intent ->
 * upload_prepared_file. The stable handle and path never cross this process.
 */
export class LocalFileCompanion {
  readonly #filesystem: LocalCompanionFileSystem;
  readonly #transport: LocalCompanionHostedUploadTransport;
  readonly #clock: { now(): number };
  readonly #nextRef: () => string;
  readonly #logger: LocalCompanionLogger | undefined;
  readonly #ttl: number;
  readonly #maxPrepared: number;
  readonly #prepared = new Map<string, PreparedFile>();

  constructor(dependencies: Readonly<{
    filesystem: LocalCompanionFileSystem;
    transport: LocalCompanionHostedUploadTransport;
    clock?: { now(): number };
    nextLocalFileRef?: () => string;
    logger?: LocalCompanionLogger;
    preparedTtlMilliseconds?: number;
    maxPreparedFiles?: number;
  }>) {
    this.#filesystem = dependencies.filesystem;
    this.#transport = dependencies.transport;
    this.#clock = dependencies.clock ?? { now: () => Date.now() };
    this.#nextRef = dependencies.nextLocalFileRef ??
      (() => `mdlocal_v1_${crypto.randomUUID().replaceAll("-", "")}`);
    this.#logger = dependencies.logger;
    this.#ttl = dependencies.preparedTtlMilliseconds ??
      LOCAL_COMPANION_LIMITS.preparedTtlMilliseconds;
    this.#maxPrepared = dependencies.maxPreparedFiles ??
      LOCAL_COMPANION_LIMITS.defaultMaxPreparedFiles;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 1 ||
      !Number.isSafeInteger(this.#maxPrepared) || this.#maxPrepared < 1) {
      throw new TypeError("Local companion limits are invalid.");
    }
  }

  prepare_local_file(request: PrepareLocalFileRequest): Promise<PrepareLocalFileResult> {
    return this.prepareLocalFile(request);
  }

  upload_prepared_file(request: UploadPreparedFileRequest): Promise<UploadPreparedFileResult> {
    return this.uploadPreparedFile(request);
  }

  async prepareLocalFile(request: PrepareLocalFileRequest): Promise<PrepareLocalFileResult> {
    await this.#expirePrepared();
    const selectedSourceKind = sourceKind(request.source_kind);
    if (selectedSourceKind === null) {
      return invalid("local_companion_invalid_source_kind");
    }
    if (!validPathInput(request.path)) return invalid("invalid_path");
    if (request.display_filename !== undefined &&
      !validFilename(request.display_filename)) {
      return invalid("invalid_bundle_file_name");
    }
    if (request.expected_size !== undefined &&
      expectedSize(request.expected_size) === null) {
      return invalid("bundle_file_size_mismatch");
    }
    if (request.expected_sha256 !== undefined &&
      expectedSha256(request.expected_sha256) === null) {
      return invalid("bundle_file_digest_mismatch");
    }
    if (this.#prepared.size >= this.#maxPrepared) {
      return invalid("local_companion_concurrency_limit");
    }

    let opened: LocalCompanionOpenResult;
    try {
      opened = await this.#filesystem.open(request.path);
    } catch {
      return invalid("file_ingress_source_unavailable");
    }
    if (opened.kind === "invalid") return invalid(opened.code);
    const file = opened.file;
    const before = file.inspection;
    const closeInvalid = async (code: LocalCompanionInvalidCode) => {
      await file.close().catch(() => undefined);
      recordLog(this.#logger, {
        operation: "prepare_local_file",
        source_kind: selectedSourceKind,
        outcome: "failure",
        code,
      });
      return invalid(code);
    };
    if (before.kind !== "regular") {
      return await closeInvalid("file_ingress_source_unsupported");
    }
    if (!before.canonical ||
      before.authority !== (selectedSourceKind === "local_path" ? "local" : "workspace")) {
      return await closeInvalid("file_ingress_source_unsupported");
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 ||
      before.size > LOCAL_COMPANION_LIMITS.maxFileBytes) {
      return await closeInvalid("bundle_file_size_limit_exceeded");
    }
    if (request.expected_size !== undefined && request.expected_size !== before.size) {
      return await closeInvalid("bundle_file_size_mismatch");
    }

    let digest: StreamDigest;
    try {
      digest = await digestStream(file.stream({
        maxBytes: LOCAL_COMPANION_LIMITS.maxFileBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }), request.signal);
    } catch (error) {
      return await closeInvalid(mapReadFailure(error));
    }
    let after: Readonly<LocalCompanionFileInspection>;
    try {
      after = await file.inspect();
    } catch {
      return await closeInvalid("file_ingress_source_unavailable");
    }
    if (!sameSnapshot(before, after) || digest.size !== before.size) {
      return await closeInvalid("local_companion_file_changed");
    }
    if (request.expected_sha256 !== undefined &&
      request.expected_sha256 !== digest.sha256) {
      return await closeInvalid("bundle_file_digest_mismatch");
    }
    const displayFilename = request.display_filename ?? before.displayFilename;
    if (!validFilename(displayFilename)) {
      return await closeInvalid("invalid_bundle_file_name");
    }
    const now = this.#clock.now();
    const expiresAt = new Date(now + this.#ttl).toISOString();
    let localFileRef = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = this.#nextRef();
      if (LOCAL_REF.test(candidate) && !this.#prepared.has(candidate)) {
        localFileRef = candidate;
        break;
      }
    }
    if (localFileRef === "") {
      return await closeInvalid("file_ingress_transport_unavailable");
    }
    const receipt = Object.freeze({
      local_file_ref: localFileRef,
      source_kind: selectedSourceKind,
      display_filename: displayFilename,
      claimed_media_type: advisoryMediaType(
        request.claimed_media_type,
        digest.prefix,
      ),
      expected_size: digest.size,
      expected_sha256: digest.sha256,
      expires_at: expiresAt,
    });
    this.#prepared.set(localFileRef, {
      file,
      inspection: before,
      receipt,
      state: "ready",
    });
    recordLog(this.#logger, {
      operation: "prepare_local_file",
      source_kind: selectedSourceKind,
      outcome: "success",
      size: digest.size,
    });
    return Object.freeze({ kind: "prepared", prepared_file: receipt });
  }

  async uploadPreparedFile(
    request: UploadPreparedFileRequest,
  ): Promise<UploadPreparedFileResult> {
    await this.#expirePrepared();
    if (typeof request.local_file_ref !== "string" ||
      !LOCAL_REF.test(request.local_file_ref)) {
      return invalid("local_companion_ref_not_found");
    }
    if (typeof request.upload_url !== "string") {
      return invalid("invalid_upload_url");
    }
    const prepared = this.#prepared.get(request.local_file_ref);
    if (prepared === undefined) return invalid("local_companion_ref_not_found");
    if (Date.parse(prepared.receipt.expires_at) <= this.#clock.now()) {
      await this.#discard(request.local_file_ref, prepared);
      return invalid("local_companion_ref_expired");
    }
    if (prepared.state !== "ready") return invalid("local_companion_ref_in_use");
    if (request.signal?.aborted) return invalid("local_companion_cancelled");
    let current: Readonly<LocalCompanionFileInspection>;
    try {
      current = await prepared.file.inspect();
    } catch {
      await this.#discard(request.local_file_ref, prepared);
      return invalid("file_ingress_source_unavailable");
    }
    if (!sameSnapshot(prepared.inspection, current)) {
      await this.#discard(request.local_file_ref, prepared);
      return invalid("local_companion_file_changed");
    }
    prepared.state = "uploading";

    let streamStarted = false;
    let streamOutcome: Promise<"verified" | "changed" | "incomplete"> =
      Promise.resolve("incomplete");
    const verifiedStream = (): AsyncIterable<Uint8Array> => {
      return (async function* () {
        streamStarted = true;
        let resolveOutcome!: (value: "verified" | "changed" | "incomplete") => void;
        streamOutcome = new Promise((resolve) => { resolveOutcome = resolve; });
        const source = prepared.file.stream({
          maxBytes: LOCAL_COMPANION_LIMITS.maxFileBytes,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const digest = new IncrementalSha256();
        let size = 0;
        let completed = false;
        try {
          for await (const chunk of source) {
            if (request.signal?.aborted) {
              throw new LocalCompanionReadFailure("cancelled");
            }
            if (!(chunk instanceof Uint8Array)) {
              throw new LocalCompanionReadFailure("unavailable");
            }
            size += chunk.byteLength;
            if (size > LOCAL_COMPANION_LIMITS.maxFileBytes) {
              throw new LocalCompanionReadFailure("oversize");
            }
            digest.update(chunk);
            yield chunk;
          }
          const after = await prepared.file.inspect();
          completed = sameSnapshot(prepared.inspection, after) &&
            size === prepared.receipt.expected_size &&
            digest.digest() === prepared.receipt.expected_sha256;
          resolveOutcome(completed ? "verified" : "changed");
          if (!completed) throw new LocalCompanionReadFailure("unavailable");
        } finally {
          if (!completed) resolveOutcome("incomplete");
        }
      })();
    };

    try {
      const staged = await this.#transport.upload({
        uploadUrl: request.upload_url,
        stream: verifiedStream(),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const localVerification = streamStarted ? await streamOutcome : "verified";
      if (localVerification !== "verified") {
        await this.#discard(request.local_file_ref, prepared);
        return invalid("local_companion_file_changed");
      }
      if (!validReceipt(staged) ||
        staged.source_kind !== prepared.receipt.source_kind ||
        staged.display_filename !== prepared.receipt.display_filename ||
        staged.sha256 !== prepared.receipt.expected_sha256 ||
        staged.size !== prepared.receipt.expected_size) {
        await this.#discard(request.local_file_ref, prepared);
        return invalid("file_ingress_intent_conflict");
      }
      await this.#discard(request.local_file_ref, prepared);
      recordLog(this.#logger, {
        operation: "upload_prepared_file",
        source_kind: prepared.receipt.source_kind,
        outcome: "success",
        size: staged.size,
      });
      return Object.freeze({ kind: "staged", staged_file: staged });
    } catch (error) {
      const localVerification = streamStarted ? await streamOutcome : "incomplete";
      if (localVerification === "changed") {
        await this.#discard(request.local_file_ref, prepared);
        return invalid("local_companion_file_changed");
      }
      const hosted = error instanceof LocalCompanionHostedFailure
        ? error
        : new LocalCompanionHostedFailure(
            "file_ingress_transport_unavailable",
            true,
            true,
          );
      const retain = hosted.retryable || hosted.unknownOutcome;
      if (retain) prepared.state = "ready";
      else await this.#discard(request.local_file_ref, prepared);
      recordLog(this.#logger, {
        operation: "upload_prepared_file",
        source_kind: prepared.receipt.source_kind,
        outcome: retain ? "retry" : "failure",
        code: hosted.code,
        size: prepared.receipt.expected_size,
      });
      return invalid(hosted.code, retain);
    }
  }

  async close(): Promise<void> {
    const entries = [...this.#prepared.entries()];
    this.#prepared.clear();
    await Promise.all(entries.map(([, prepared]) =>
      prepared.file.close().catch(() => undefined)));
  }

  async #expirePrepared(): Promise<void> {
    const now = this.#clock.now();
    for (const [ref, prepared] of this.#prepared) {
      if (prepared.state === "ready" &&
        Date.parse(prepared.receipt.expires_at) <= now) {
        await this.#discard(ref, prepared);
      }
    }
  }

  async #discard(ref: string, prepared: PreparedFile): Promise<void> {
    if (this.#prepared.get(ref) === prepared) this.#prepared.delete(ref);
    await prepared.file.close().catch(() => undefined);
  }
}
