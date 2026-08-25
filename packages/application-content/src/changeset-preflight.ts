import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  AuthorizationDecision,
  Authorizer,
  Clock,
  BundleFileStagingStore,
  StagedBundleFileRecord,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  RevisionEnvelopeError,
  canonicalMarkdownPath,
  canonicalBundleFilePath,
  sha256Digest,
  type RevisionId,
  type RevisionMode,
  type BindingVersion,
  type Sha256Digest,
  type SpaceId,
  type UtcInstant,
  type WriteMindBindingId,
  type BundleFileMediaType,
  type StagedBundleFileId,
} from "@mind-diary/domain";
import {
  collectOkfCrossLinkWarnings,
  okfFileKind,
  parseOkfFile,
  validateOkfBundle,
  type OkfBundleValidation,
  type OkfDiagnostic,
} from "@mind-diary/okf-codec";
import type { DeltaRevisionReader, HeadRevisionReader } from "./index.js";
import { analyzeBundleFileReferences } from "./bundle-file-references.js";
import { materializeLogEntry } from "./reserved-content.js";

export interface CreateFileOperation {
  readonly type: "create_file";
  readonly path: string;
  readonly text: string;
}

export interface ReplaceFileOperation {
  readonly type: "replace_file";
  readonly path: string;
  readonly text: string;
  readonly expected_sha256?: string;
}

export interface DeleteFileOperation {
  readonly type: "delete_file";
  readonly path: string;
  readonly expected_sha256?: string;
}

export interface ReplaceIndexOperation {
  readonly type: "replace_index";
  readonly path: string;
  readonly text: string;
  readonly expected_sha256?: string;
}

export interface AddLogEntryOperation {
  readonly type: "add_log_entry";
  readonly path: string;
  readonly category: string;
  readonly message: string;
}

export interface CreateBundleFileOperation {
  readonly type: "create_bundle_file";
  readonly path: string;
  readonly staged_file_id: StagedBundleFileId;
}

export interface ReplaceBundleFileOperation {
  readonly type: "replace_bundle_file";
  readonly path: string;
  readonly staged_file_id: StagedBundleFileId;
  readonly expected_sha256?: string;
}

export interface DeleteBundleFileOperation {
  readonly type: "delete_bundle_file";
  readonly path: string;
  readonly expected_sha256?: string;
}

export type ChangesetOperation =
  | CreateFileOperation
  | ReplaceFileOperation
  | DeleteFileOperation
  | ReplaceIndexOperation
  | AddLogEntryOperation
  | CreateBundleFileOperation
  | ReplaceBundleFileOperation
  | DeleteBundleFileOperation;

export interface ChangesetPreflightLimits {
  readonly maxOperations: number;
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
  readonly maxLogCategoryBytes: number;
  readonly maxLogMessageBytes: number;
  readonly maxChangesetBytes: number;
  readonly maxResultingFiles: number;
  readonly maxResultingBundleBytes: number;
  readonly maxBundleFileOperations: number;
  readonly maxStagedBundleFileBytes: number;
  readonly maxResultingRevisionBytes: number;
}

export const DEFAULT_CHANGESET_PREFLIGHT_LIMITS: Readonly<ChangesetPreflightLimits> =
  Object.freeze({
    maxOperations: 100,
    maxPathBytes: 1_024,
    maxFileBytes: 1_048_576,
    maxLogCategoryBytes: 256,
    maxLogMessageBytes: 16_384,
    maxChangesetBytes: 4_194_304,
    maxResultingFiles: 10_000,
    maxResultingBundleBytes: 67_108_864,
    maxBundleFileOperations: 20,
    maxStagedBundleFileBytes: 268_435_456,
    maxResultingRevisionBytes: 1_073_741_824,
  });

export interface ChangesetPreflightRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly revisionMode: RevisionMode;
  readonly expectedRevisionId: RevisionId | null;
  readonly writeBindingId?: WriteMindBindingId;
  readonly automaticCaptureExpectedBindingVersion?: BindingVersion;
  /** Untrusted adapter input is deliberately validated inside the service. */
  readonly operations: unknown;
}

export type ChangesetValidationCode =
  | "invalid_expected_revision"
  | "invalid_write_binding_id"
  | "invalid_idempotency_key"
  | "invalid_summary"
  | "operations_required"
  | "operation_limit_exceeded"
  | "invalid_operation"
  | "invalid_path"
  | "reserved_path_requires_special_operation"
  | "duplicate_operation_path"
  | "duplicate_staged_bundle_file_reference"
  | "invalid_utf8"
  | "path_size_limit_exceeded"
  | "file_size_limit_exceeded"
  | "log_category_size_limit_exceeded"
  | "log_message_size_limit_exceeded"
  | "changeset_size_limit_exceeded"
  | "resulting_file_limit_exceeded"
  | "resulting_bundle_size_limit_exceeded"
  | "file_exists"
  | "file_not_found"
  | "file_digest_mismatch"
  | "okf_validation_failed"
  | "bundle_file_operation_limit_exceeded"
  | "staged_bundle_file_byte_limit_exceeded"
  | "resulting_revision_size_limit_exceeded"
  | "staged_bundle_file_not_found"
  | "staged_bundle_file_not_verified"
  | "staged_bundle_file_expired"
  | "staged_bundle_file_binding_mismatch"
  | "retained_bundle_file_quota_exceeded"
  | "capacity_accounting_untrusted"
  | "capacity_soft_limit"
  | "capacity_hard_limit"
  | "capacity_fairness_limit";

export interface ChangesetValidationFailure {
  readonly code: ChangesetValidationCode;
  readonly message: string;
  readonly operationIndex?: number;
  readonly path?: string;
  readonly diagnostics?: readonly OkfDiagnostic[];
}

export interface ChangesetCandidateFile {
  readonly kind: "markdown";
  readonly path: string;
  readonly mediaType: typeof MARKDOWN_MEDIA_TYPE;
  readonly text?: string;
  readonly sha256: Sha256Digest | null;
  readonly size: number;
  readonly writeRequired: boolean;
}

export interface ChangesetCandidateBundleFile {
  readonly kind: "opaque";
  readonly path: string;
  readonly mediaType: BundleFileMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly stagedFileId: StagedBundleFileId | null;
}

export type ChangesetCandidateRevisionFile =
  | ChangesetCandidateFile
  | ChangesetCandidateBundleFile;

type AllowedAuthorizationDecision = Extract<
  AuthorizationDecision,
  { readonly kind: "allowed" }
>;

export type ChangesetPreflightResult =
  | {
      readonly kind: "ready";
      readonly authorization: AllowedAuthorizationDecision;
      readonly baseRevisionId: RevisionId | null;
      readonly operations: readonly Readonly<ChangesetOperation>[];
      readonly candidateFiles: readonly Readonly<ChangesetCandidateRevisionFile>[];
      readonly stagedBundleFileRecords: readonly Readonly<StagedBundleFileRecord>[];
      readonly validation: OkfBundleValidation;
      readonly committedAt: UtcInstant;
    }
  | {
      readonly kind: "denied";
      readonly decision: Exclude<AuthorizationDecision, { readonly kind: "allowed" }>;
    }
  | {
      readonly kind: "revision_conflict";
      readonly currentRevisionId: RevisionId | null;
    }
  | {
      readonly kind: "invalid";
      readonly error: Readonly<ChangesetValidationFailure>;
    };

export interface ChangesetPreflightDependencies {
  readonly authorizer: Authorizer;
  readonly revisions: HeadRevisionReader;
  readonly clock: Clock;
  readonly stagedBundleFiles?: Pick<BundleFileStagingStore, "readStagedBundleFile">;
  readonly limits?: Readonly<ChangesetPreflightLimits>;
}

interface ValidatedOperationSet {
  readonly operations: readonly Readonly<ChangesetOperation>[];
  readonly totalBytes: number;
}

export type ChangesetOperationValidationResult =
  | ({ readonly kind: "valid" } & ValidatedOperationSet)
  | Extract<ChangesetPreflightResult, { readonly kind: "invalid" }>;

interface WorkingFile {
  readonly kind: "markdown";
  readonly path: string;
  readonly text?: string;
  readonly sha256: Sha256Digest | null;
  readonly size: number;
  readonly writeRequired: boolean;
}


interface WorkingBundleFile {
  readonly kind: "opaque";
  readonly path: string;
  readonly mediaType: BundleFileMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly stagedFileId: StagedBundleFileId | null;
}

type WorkingRevisionFile = WorkingFile | WorkingBundleFile;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const SINGLE_LINE_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LIMIT_KEYS = [
  "maxOperations",
  "maxPathBytes",
  "maxFileBytes",
  "maxLogCategoryBytes",
  "maxLogMessageBytes",
  "maxChangesetBytes",
  "maxResultingFiles",
  "maxResultingBundleBytes",
  "maxBundleFileOperations",
  "maxStagedBundleFileBytes",
  "maxResultingRevisionBytes",
] as const satisfies readonly (keyof ChangesetPreflightLimits)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function safeUtf8(value: string): Uint8Array | null {
  const bytes = ENCODER.encode(value);
  try {
    return DECODER.decode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function invalid(
  code: ChangesetValidationCode,
  message: string,
  context: {
    readonly operationIndex?: number;
    readonly path?: string;
    readonly diagnostics?: readonly OkfDiagnostic[];
  } = {},
): Extract<ChangesetPreflightResult, { readonly kind: "invalid" }> {
  return Object.freeze({
    kind: "invalid",
    error: Object.freeze({
      code,
      message,
      ...(context.operationIndex === undefined
        ? {}
        : { operationIndex: context.operationIndex }),
      ...(context.path === undefined ? {} : { path: context.path }),
      ...(context.diagnostics === undefined
        ? {}
        : { diagnostics: Object.freeze([...context.diagnostics]) }),
    }),
  });
}

function normalizeLimits(
  limits: Readonly<ChangesetPreflightLimits>,
): Readonly<ChangesetPreflightLimits> {
  if (!isRecord(limits) || !hasExactKeys(limits, LIMIT_KEYS)) {
    throw new TypeError("changeset preflight limits must provide the exact limit set");
  }
  for (const name of LIMIT_KEYS) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return Object.freeze({ ...limits });
}

function canonicalPath(
  value: unknown,
  operationIndex: number,
  limits: Readonly<ChangesetPreflightLimits>,
  pathKind: "markdown" | "opaque" = "markdown",
): string | Extract<ChangesetPreflightResult, { readonly kind: "invalid" }> {
  if (typeof value !== "string") {
    return invalid("invalid_path", "operation path must be a string", {
      operationIndex,
    });
  }
  try {
    const path = pathKind === "markdown"
      ? canonicalMarkdownPath(value)
      : canonicalBundleFilePath(value);
    const pathBytes = safeUtf8(path);
    if (pathBytes === null) {
      return invalid("invalid_utf8", "operation path must be canonical UTF-8", {
        operationIndex,
      });
    }
    if (pathBytes.byteLength > limits.maxPathBytes) {
      return invalid("path_size_limit_exceeded", "operation path exceeds its limit", {
        operationIndex,
        path,
      });
    }
    return path;
  } catch (error) {
    if (error instanceof RevisionEnvelopeError) {
      return invalid("invalid_path", `operation path is not canonical ${pathKind}`, {
        operationIndex,
      });
    }
    throw error;
  }
}

function expectedDigest(
  value: unknown,
  operationIndex: number,
  path: string,
): Sha256Digest | null | Extract<ChangesetPreflightResult, { readonly kind: "invalid" }> {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    return invalid("invalid_operation", "expected_sha256 must be a canonical digest", {
      operationIndex,
      path,
    });
  }
  try {
    return sha256Digest(value);
  } catch (error) {
    if (error instanceof RevisionEnvelopeError) {
      return invalid("invalid_operation", "expected_sha256 must be a canonical digest", {
        operationIndex,
        path,
      });
    }
    throw error;
  }
}

function stagedFileId(
  value: unknown,
  operationIndex: number,
  path: string,
): StagedBundleFileId | Extract<ChangesetPreflightResult, { readonly kind: "invalid" }> {
  if (
    typeof value !== "string" || value.length === 0 ||
    ENCODER.encode(value).byteLength > 255 || SINGLE_LINE_FORBIDDEN.test(value)
  ) return invalid("invalid_operation", "staged_file_id must be a bounded opaque ID", {
    operationIndex,
    path,
  });
  return value as StagedBundleFileId;
}

function checkedText(
  value: unknown,
  operationIndex: number,
  path: string,
  limits: Readonly<ChangesetPreflightLimits>,
): { readonly text: string; readonly bytes: number } | Extract<
  ChangesetPreflightResult,
  { readonly kind: "invalid" }
> {
  if (typeof value !== "string") {
    return invalid("invalid_operation", "Markdown text must be a string", {
      operationIndex,
      path,
    });
  }
  const bytes = safeUtf8(value);
  if (bytes === null) {
    return invalid("invalid_utf8", "Markdown text must be canonical UTF-8", {
      operationIndex,
      path,
    });
  }
  if (bytes.byteLength > limits.maxFileBytes) {
    return invalid("file_size_limit_exceeded", "Markdown text exceeds its limit", {
      operationIndex,
      path,
    });
  }
  return Object.freeze({ text: value, bytes: bytes.byteLength });
}

function checkedLogField(
  value: unknown,
  label: "category" | "message",
  operationIndex: number,
  path: string,
  maxBytes: number,
): { readonly value: string; readonly bytes: number } | Extract<
  ChangesetPreflightResult,
  { readonly kind: "invalid" }
> {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    SINGLE_LINE_FORBIDDEN.test(value)
  ) {
    return invalid(
      "invalid_operation",
      `add_log_entry ${label} must be non-empty single-line UTF-8 text`,
      { operationIndex, path },
    );
  }
  const bytes = safeUtf8(value);
  if (bytes === null) {
    return invalid("invalid_utf8", `add_log_entry ${label} must be canonical UTF-8`, {
      operationIndex,
      path,
    });
  }
  if (bytes.byteLength > maxBytes) {
    return invalid(
      label === "category"
        ? "log_category_size_limit_exceeded"
        : "log_message_size_limit_exceeded",
      `add_log_entry ${label} exceeds its byte limit`,
      { operationIndex, path },
    );
  }
  return Object.freeze({ value, bytes: bytes.byteLength });
}

function validateOperationsAgainstLimits(
  source: unknown,
  limits: Readonly<ChangesetPreflightLimits>,
): ValidatedOperationSet | Extract<ChangesetPreflightResult, { readonly kind: "invalid" }> {
  if (!Array.isArray(source) || source.length === 0) {
    return invalid("operations_required", "changeset operations must be a non-empty array");
  }
  if (source.length > limits.maxOperations) {
    return invalid("operation_limit_exceeded", "changeset operation count exceeds its limit");
  }

  const operations: Readonly<ChangesetOperation>[] = [];
  const seenPaths = new Set<string>();
  const seenStagedFileIds = new Set<StagedBundleFileId>();
  let totalBytes = 0;
  let bundleOperationCount = 0;
  for (let index = 0; index < source.length; index += 1) {
    const candidate: unknown = source[index];
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      return invalid("invalid_operation", "operation must be a tagged object", {
        operationIndex: index,
      });
    }
    const bundleOperation =
      candidate.type === "create_bundle_file" ||
      candidate.type === "replace_bundle_file" ||
      candidate.type === "delete_bundle_file";
    if (bundleOperation && ++bundleOperationCount > limits.maxBundleFileOperations) {
      return invalid(
        "bundle_file_operation_limit_exceeded",
        "BundleFile operation count exceeds its limit",
        { operationIndex: index },
      );
    }
    const pathResult = canonicalPath(
      candidate.path,
      index,
      limits,
      bundleOperation ? "opaque" : "markdown",
    );
    if (typeof pathResult !== "string") return pathResult;
    const path = pathResult;
    if (seenPaths.has(path)) {
      return invalid(
        "duplicate_operation_path",
        "changeset cannot contain duplicate or conflicting paths",
        { operationIndex: index, path },
      );
    }
    seenPaths.add(path);
    totalBytes += ENCODER.encode(path).byteLength;

    const kind = okfFileKind(path);
    let operation: Readonly<ChangesetOperation>;
    if (candidate.type === "create_file") {
      if (!hasExactKeys(candidate, ["type", "path", "text"])) {
        return invalid("invalid_operation", "create_file fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      if (kind !== "concept") {
        return invalid(
          "reserved_path_requires_special_operation",
          "ordinary file operations cannot target index.md or log.md",
          { operationIndex: index, path },
        );
      }
      const text = checkedText(candidate.text, index, path, limits);
      if ("kind" in text) return text;
      totalBytes += text.bytes;
      operation = Object.freeze({ type: "create_file", path, text: text.text });
    } else if (candidate.type === "replace_file") {
      if (
        !hasExactKeys(candidate, ["type", "path", "text"], ["expected_sha256"])
      ) {
        return invalid("invalid_operation", "replace_file fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      if (kind !== "concept") {
        return invalid(
          "reserved_path_requires_special_operation",
          "ordinary file operations cannot target index.md or log.md",
          { operationIndex: index, path },
        );
      }
      const text = checkedText(candidate.text, index, path, limits);
      if ("kind" in text) return text;
      const digest = expectedDigest(candidate.expected_sha256, index, path);
      if (typeof digest === "object" && digest !== null && "kind" in digest) {
        return digest;
      }
      totalBytes += text.bytes;
      operation = Object.freeze({
        type: "replace_file",
        path,
        text: text.text,
        ...(digest === null ? {} : { expected_sha256: digest }),
      });
    } else if (candidate.type === "delete_file") {
      if (!hasExactKeys(candidate, ["type", "path"], ["expected_sha256"])) {
        return invalid("invalid_operation", "delete_file fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      if (kind !== "concept") {
        return invalid(
          "reserved_path_requires_special_operation",
          "ordinary file operations cannot target index.md or log.md",
          { operationIndex: index, path },
        );
      }
      const digest = expectedDigest(candidate.expected_sha256, index, path);
      if (typeof digest === "object" && digest !== null && "kind" in digest) {
        return digest;
      }
      operation = Object.freeze({
        type: "delete_file",
        path,
        ...(digest === null ? {} : { expected_sha256: digest }),
      });
    } else if (candidate.type === "replace_index") {
      if (
        !hasExactKeys(candidate, ["type", "path", "text"], ["expected_sha256"])
      ) {
        return invalid("invalid_operation", "replace_index fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      if (kind !== "index") {
        return invalid("invalid_operation", "replace_index must target index.md", {
          operationIndex: index,
          path,
        });
      }
      const text = checkedText(candidate.text, index, path, limits);
      if ("kind" in text) return text;
      const digest = expectedDigest(candidate.expected_sha256, index, path);
      if (typeof digest === "object" && digest !== null && "kind" in digest) {
        return digest;
      }
      totalBytes += text.bytes;
      operation = Object.freeze({
        type: "replace_index",
        path,
        text: text.text,
        ...(digest === null ? {} : { expected_sha256: digest }),
      });
    } else if (candidate.type === "add_log_entry") {
      if (!hasExactKeys(candidate, ["type", "path", "category", "message"])) {
        return invalid("invalid_operation", "add_log_entry fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      if (kind !== "log") {
        return invalid("invalid_operation", "add_log_entry must target log.md", {
          operationIndex: index,
          path,
        });
      }
      const category = checkedLogField(
        candidate.category,
        "category",
        index,
        path,
        limits.maxLogCategoryBytes,
      );
      if ("kind" in category) return category;
      const message = checkedLogField(
        candidate.message,
        "message",
        index,
        path,
        limits.maxLogMessageBytes,
      );
      if ("kind" in message) return message;
      totalBytes += category.bytes + message.bytes;
      operation = Object.freeze({
        type: "add_log_entry",
        path,
        category: category.value,
        message: message.value,
      });
    } else if (candidate.type === "create_bundle_file") {
      if (!hasExactKeys(candidate, ["type", "path", "staged_file_id"])) {
        return invalid("invalid_operation", "create_bundle_file fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      const staged = stagedFileId(candidate.staged_file_id, index, path);
      if (typeof staged !== "string") return staged;
      if (seenStagedFileIds.has(staged)) {
        return invalid(
          "duplicate_staged_bundle_file_reference",
          "one staged BundleFile ref may be used by only one file operation",
          { operationIndex: index, path },
        );
      }
      seenStagedFileIds.add(staged);
      totalBytes += ENCODER.encode(staged).byteLength;
      operation = Object.freeze({
        type: "create_bundle_file",
        path,
        staged_file_id: staged,
      });
    } else if (candidate.type === "replace_bundle_file") {
      if (!hasExactKeys(
        candidate,
        ["type", "path", "staged_file_id"],
        ["expected_sha256"],
      )) {
        return invalid("invalid_operation", "replace_bundle_file fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      const staged = stagedFileId(candidate.staged_file_id, index, path);
      if (typeof staged !== "string") return staged;
      if (seenStagedFileIds.has(staged)) {
        return invalid(
          "duplicate_staged_bundle_file_reference",
          "one staged BundleFile ref may be used by only one file operation",
          { operationIndex: index, path },
        );
      }
      seenStagedFileIds.add(staged);
      const digest = expectedDigest(candidate.expected_sha256, index, path);
      if (typeof digest === "object" && digest !== null && "kind" in digest) return digest;
      totalBytes += ENCODER.encode(staged).byteLength;
      operation = Object.freeze({
        type: "replace_bundle_file",
        path,
        staged_file_id: staged,
        ...(digest === null ? {} : { expected_sha256: digest }),
      });
    } else if (candidate.type === "delete_bundle_file") {
      if (!hasExactKeys(candidate, ["type", "path"], ["expected_sha256"])) {
        return invalid("invalid_operation", "delete_bundle_file fields are invalid", {
          operationIndex: index,
          path,
        });
      }
      const digest = expectedDigest(candidate.expected_sha256, index, path);
      if (typeof digest === "object" && digest !== null && "kind" in digest) return digest;
      operation = Object.freeze({
        type: "delete_bundle_file",
        path,
        ...(digest === null ? {} : { expected_sha256: digest }),
      });
    } else {
      return invalid("invalid_operation", "operation type is not supported", {
        operationIndex: index,
        path,
      });
    }

    if (totalBytes > limits.maxChangesetBytes) {
      return invalid(
        "changeset_size_limit_exceeded",
        "changeset operation bytes exceed their limit",
        { operationIndex: index, path },
      );
    }
    operations.push(operation);
  }
  return Object.freeze({ operations: Object.freeze(operations), totalBytes });
}

/** Canonicalizes the request payload without reading target content or HEAD. */
export function validateChangesetOperations(
  source: unknown,
  limits: Readonly<ChangesetPreflightLimits> = DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
): ChangesetOperationValidationResult {
  const result = validateOperationsAgainstLimits(source, normalizeLimits(limits));
  if ("kind" in result) return result;
  return Object.freeze({ kind: "valid", ...result });
}

function digestMatches(
  operation:
    | ReplaceFileOperation
    | DeleteFileOperation
    | ReplaceIndexOperation
    | ReplaceBundleFileOperation
    | DeleteBundleFileOperation,
  file: WorkingRevisionFile,
): boolean {
  return operation.expected_sha256 === undefined || operation.expected_sha256 === file.sha256;
}

function comparePaths(
  left: ChangesetCandidateRevisionFile,
  right: ChangesetCandidateRevisionFile,
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isDeltaRevisionReader(reader: HeadRevisionReader): reader is DeltaRevisionReader {
  return (
    "readHeadRevisionEnvelope" in reader &&
    typeof reader.readHeadRevisionEnvelope === "function" &&
    "readRevisionFile" in reader &&
    typeof reader.readRevisionFile === "function"
  );
}

export class ChangesetPreflightService {
  readonly #authorizer: Authorizer;
  readonly #revisions: HeadRevisionReader;
  readonly #clock: Clock;
  readonly #limits: Readonly<ChangesetPreflightLimits>;
  readonly #stagedBundleFiles: Pick<BundleFileStagingStore, "readStagedBundleFile"> | null;

  constructor(dependencies: ChangesetPreflightDependencies) {
    this.#authorizer = dependencies.authorizer;
    this.#revisions = dependencies.revisions;
    this.#clock = dependencies.clock;
    this.#stagedBundleFiles = dependencies.stagedBundleFiles ?? null;
    this.#limits = normalizeLimits(
      dependencies.limits ?? DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
    );
  }

  async preflight(request: ChangesetPreflightRequest): Promise<ChangesetPreflightResult> {
    const authorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: request.revisionMode,
      ...(request.writeBindingId === undefined
        ? {}
        : {
            bindingRequirement: Object.freeze({
              ...(request.automaticCaptureExpectedBindingVersion === undefined
                ? {
                    kind: "write" as const,
                    writeBindingId: request.writeBindingId,
                  }
                : {
                    kind: "automatic_capture" as const,
                    writeBindingId: request.writeBindingId,
                    expectedBindingVersion:
                      request.automaticCaptureExpectedBindingVersion,
                  }),
            }),
          }),
    });
    if (authorization.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: authorization });
    }

    if (
      request.expectedRevisionId !== null &&
      (typeof request.expectedRevisionId !== "string" ||
        request.expectedRevisionId.length === 0)
    ) {
      return invalid(
        "invalid_expected_revision",
        "expected revision must be a non-empty opaque ID or null",
      );
    }
    const operationSet = validateChangesetOperations(
      request.operations,
      this.#limits,
    );
    if (operationSet.kind === "invalid") return operationSet;

    const deltaReader = isDeltaRevisionReader(this.#revisions)
      ? this.#revisions
      : null;
    const headEnvelope = deltaReader === null
      ? null
      : await deltaReader.readHeadRevisionEnvelope(request.spaceId);
    const head = deltaReader === null
      ? await this.#revisions.readHeadRevision(request.spaceId)
      : null;
    const currentRevisionId =
      headEnvelope?.revision.revisionId ?? head?.envelope.revision.revisionId ?? null;
    if (currentRevisionId !== request.expectedRevisionId) {
      return Object.freeze({
        kind: "revision_conflict",
        currentRevisionId,
      });
    }

    const working = new Map<string, WorkingRevisionFile>();
    if (headEnvelope !== null) {
      for (const entry of headEnvelope.manifest.entries) {
        working.set(entry.path, entry.kind === "markdown"
          ? Object.freeze({
              kind: "markdown" as const,
              path: entry.path,
              sha256: entry.sha256,
              size: entry.size,
              writeRequired: false,
            })
          : Object.freeze({
              kind: "opaque" as const,
              path: entry.path,
              mediaType: entry.mediaType,
              sha256: entry.sha256,
              size: entry.size,
              stagedFileId: null,
            }));
      }
    } else {
      for (const file of head?.files ?? []) {
        working.set(file.path, file.kind === "markdown"
          ? Object.freeze({
              kind: "markdown" as const,
              path: file.path,
              text: file.text,
              sha256: file.sha256,
              size: file.size,
              writeRequired: false,
            })
          : Object.freeze({
              kind: "opaque" as const,
              path: file.path,
              mediaType: file.mediaType,
              sha256: file.sha256,
              size: file.size,
              stagedFileId: null,
            }));
      }
    }

    const committedAt = this.#clock.now();
    const stagedRecords = new Map<StagedBundleFileId, Readonly<StagedBundleFileRecord>>();
    let stagedBytes = 0;

    for (let index = 0; index < operationSet.operations.length; index += 1) {
      const operation = operationSet.operations[index]!;
      let current = working.get(operation.path);
      if (operation.type === "create_file") {
        if (current) {
          return invalid("file_exists", "create_file target already exists", {
            operationIndex: index,
            path: operation.path,
          });
        }
        working.set(
          operation.path,
          Object.freeze({
            kind: "markdown" as const,
            path: operation.path,
            text: operation.text,
            sha256: null,
            size: ENCODER.encode(operation.text).byteLength,
            writeRequired: true,
          }),
        );
      } else if (
        operation.type === "replace_file" ||
        operation.type === "replace_index"
      ) {
        if (!current || current.kind !== "markdown") {
          return invalid("file_not_found", "replace target does not exist", {
            operationIndex: index,
            path: operation.path,
          });
        }
        if (!digestMatches(operation, current)) {
          return invalid("file_digest_mismatch", "replace target digest changed", {
            operationIndex: index,
            path: operation.path,
          });
        }
        working.set(
          operation.path,
          Object.freeze({
            kind: "markdown" as const,
            path: operation.path,
            text: operation.text,
            sha256: current.sha256,
            size: ENCODER.encode(operation.text).byteLength,
            writeRequired: true,
          }),
        );
      } else if (operation.type === "delete_file") {
        if (!current || current.kind !== "markdown") {
          return invalid("file_not_found", "delete target does not exist", {
            operationIndex: index,
            path: operation.path,
          });
        }
        if (!digestMatches(operation, current)) {
          return invalid("file_digest_mismatch", "delete target digest changed", {
            operationIndex: index,
            path: operation.path,
          });
        }
        working.delete(operation.path);
      } else if (operation.type === "add_log_entry") {
        if (!current || current.kind !== "markdown") {
          return invalid("file_not_found", "log target does not exist", {
            operationIndex: index,
            path: operation.path,
          });
        }
        if (current.text === undefined && deltaReader !== null && currentRevisionId !== null) {
          const loaded = await deltaReader.readRevisionFile(
            request.spaceId,
            currentRevisionId,
            operation.path,
          );
          if (!loaded || loaded.kind !== "markdown") {
            return invalid("file_not_found", "log target does not exist", {
              operationIndex: index,
              path: operation.path,
            });
          }
          current = Object.freeze({
            kind: "markdown" as const,
            path: loaded.path,
            text: loaded.text,
            sha256: loaded.sha256,
            size: loaded.size,
            writeRequired: false,
          });
          working.set(operation.path, current);
        }
        const materialized = materializeLogEntry({
          path: operation.path,
          text: current.text!,
          category: operation.category,
          message: operation.message,
          serverAssignedAt: committedAt,
        });
        if (materialized.kind === "invalid_log") {
          return invalid(
            "okf_validation_failed",
            "existing log is not a canonical date-grouped OKF log",
            {
              operationIndex: index,
              path: operation.path,
              diagnostics: materialized.diagnostics,
            },
          );
        }
        if (ENCODER.encode(materialized.text).byteLength > this.#limits.maxFileBytes) {
          return invalid(
            "file_size_limit_exceeded",
            "materialized log exceeds the Markdown file limit",
            { operationIndex: index, path: operation.path },
          );
        }
        working.set(
          operation.path,
          Object.freeze({
            kind: "markdown" as const,
            path: operation.path,
            text: materialized.text,
            sha256: current.sha256,
            size: ENCODER.encode(materialized.text).byteLength,
            writeRequired: true,
          }),
        );
      } else if (
        operation.type === "create_bundle_file" ||
        operation.type === "replace_bundle_file"
      ) {
        if (operation.type === "create_bundle_file" && current) {
          return invalid("file_exists", "create_bundle_file target already exists", {
            operationIndex: index,
            path: operation.path,
          });
        }
        if (
          operation.type === "replace_bundle_file" &&
          (!current || current.kind !== "opaque")
        ) return invalid("file_not_found", "replace BundleFile target does not exist", {
          operationIndex: index,
          path: operation.path,
        });
        if (
          operation.type === "replace_bundle_file" && current &&
          !digestMatches(operation, current)
        ) return invalid("file_digest_mismatch", "replace BundleFile digest changed", {
          operationIndex: index,
          path: operation.path,
        });
        const staged = await this.#stagedBundleFiles?.readStagedBundleFile(
          operation.staged_file_id,
        );
        if (!staged) return invalid(
          "staged_bundle_file_not_found",
          "staged BundleFile does not exist",
          { operationIndex: index, path: operation.path },
        );
        if (Date.parse(staged.expiresAt) <= Date.parse(committedAt)) {
          return invalid("staged_bundle_file_expired", "staged BundleFile expired", {
            operationIndex: index,
            path: operation.path,
          });
        }
        if (staged.state !== "verified") {
          return invalid(
            "staged_bundle_file_not_verified",
            "staged BundleFile is not verified",
            { operationIndex: index, path: operation.path },
          );
        }
        const bindingOwnerId =
          request.actor.kind === "registered_principal" &&
          request.actor.authentication.kind === "mcp_token"
            ? request.actor.authentication.bindingOwnerId
            : null;
        if (
          bindingOwnerId === null ||
          request.writeBindingId === undefined ||
          staged.bindingOwnerId !== bindingOwnerId ||
          staged.writeBindingId !== request.writeBindingId ||
          staged.spaceId !== request.spaceId
        ) return invalid(
          "staged_bundle_file_binding_mismatch",
          "staged BundleFile is pinned to another binding or Mind",
          { operationIndex: index, path: operation.path },
        );
        if (!stagedRecords.has(staged.stagedFileId)) {
          stagedBytes += staged.size;
          stagedRecords.set(staged.stagedFileId, staged);
        }
        if (stagedBytes > this.#limits.maxStagedBundleFileBytes) {
          return invalid(
            "staged_bundle_file_byte_limit_exceeded",
            "staged BundleFile bytes exceed the changeset limit",
            { operationIndex: index, path: operation.path },
          );
        }
        working.set(operation.path, Object.freeze({
          kind: "opaque",
          path: operation.path,
          mediaType: staged.mediaType,
          sha256: staged.sha256,
          size: staged.size,
          stagedFileId: staged.stagedFileId,
        }));
      } else if (operation.type === "delete_bundle_file") {
        if (!current || current.kind !== "opaque") {
          return invalid("file_not_found", "delete BundleFile target does not exist", {
            operationIndex: index,
            path: operation.path,
          });
        }
        if (!digestMatches(operation, current)) {
          return invalid("file_digest_mismatch", "delete BundleFile digest changed", {
            operationIndex: index,
            path: operation.path,
          });
        }
        working.delete(operation.path);
      }
    }

    if (working.size > this.#limits.maxResultingFiles) {
      return invalid(
        "resulting_file_limit_exceeded",
        "resulting bundle file count exceeds its limit",
      );
    }
    const fullReferenceScan = operationSet.operations.some((operation) =>
      operation.type === "create_bundle_file" ||
      operation.type === "replace_bundle_file" ||
      operation.type === "delete_bundle_file"
    );
    if (deltaReader !== null && currentRevisionId !== null && fullReferenceScan) {
      for (const [path, file] of working) {
        if (file.kind !== "markdown" || file.text !== undefined) continue;
        const loaded = await deltaReader.readRevisionFile(
          request.spaceId,
          currentRevisionId,
          path,
        );
        if (!loaded || loaded.kind !== "markdown" || loaded.sha256 !== file.sha256) {
          return invalid("okf_validation_failed", "exact parent file cannot be verified", {
            path,
          });
        }
        working.set(path, Object.freeze({ ...file, text: loaded.text }));
      }
    }
    let resultingBytes = 0;
    let resultingRevisionBytes = 0;
    const candidateFiles = [...working.values()]
      .map((file) => {
        resultingRevisionBytes += file.size;
        if (file.kind === "opaque") return Object.freeze({ ...file });
        resultingBytes += file.size;
        return Object.freeze({
          kind: "markdown" as const,
          path: file.path,
          mediaType: MARKDOWN_MEDIA_TYPE,
          ...(file.text === undefined ? {} : { text: file.text }),
          sha256: file.sha256,
          size: file.size,
          writeRequired: file.writeRequired,
        });
      })
      .sort(comparePaths);
    if (resultingBytes > this.#limits.maxResultingBundleBytes) {
      return invalid(
        "resulting_bundle_size_limit_exceeded",
        "resulting bundle bytes exceed their limit",
      );
    }
    if (resultingRevisionBytes > this.#limits.maxResultingRevisionBytes) {
      return invalid(
        "resulting_revision_size_limit_exceeded",
        "resulting revision bytes exceed their limit",
      );
    }

    const markdownCandidates = candidateFiles.filter(
      (file): file is ChangesetCandidateFile => file.kind === "markdown",
    );
    const okfValidation = deltaReader === null
      ? validateOkfBundle(markdownCandidates.map((file) => ({
          path: file.path,
          text: file.text!,
        })))
      : (() => {
          const parsed = markdownCandidates
            .filter((file) => file.writeRequired)
            .map((file) => parseOkfFile({ path: file.path, text: file.text! }));
          const files = parsed.flatMap((result) =>
            result.file === null ? [] : [result.file]);
          const diagnostics = [
            ...parsed.flatMap((result) => result.diagnostics),
            ...collectOkfCrossLinkWarnings(
              files,
              markdownCandidates.map((file) => file.path),
            ),
          ];
          const conformanceErrors = diagnostics.filter(
            (entry) => entry.category === "okf-conformance",
          );
          const envelopeErrors = diagnostics.filter(
            (entry) => entry.category === "mind-diary-envelope",
          );
          const qualityWarnings = diagnostics.filter(
            (entry) => entry.category === "quality",
          );
          const empty = validateOkfBundle([]);
          return Object.freeze({
            ...empty,
            valid: conformanceErrors.length === 0 && envelopeErrors.length === 0,
            conforms: conformanceErrors.length === 0,
            files: Object.freeze(files),
            diagnostics: Object.freeze(diagnostics),
            conformanceErrors: Object.freeze(conformanceErrors),
            envelopeErrors: Object.freeze(envelopeErrors),
            qualityWarnings: Object.freeze(qualityWarnings),
          });
        })();
    const referenceMarkdown = markdownCandidates
      .filter((file) =>
        file.text !== undefined &&
        (deltaReader === null || fullReferenceScan || file.writeRequired))
      .map((file) => Object.freeze({ path: file.path, text: file.text! }));
    const referenceAnalysis = analyzeBundleFileReferences({
      markdown: referenceMarkdown,
      bundleFiles: candidateFiles
        .filter((file) => file.kind === "opaque")
        .map((file) => Object.freeze({ path: file.path, mediaType: file.mediaType })),
    });
    const referenceErrors = referenceAnalysis.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    const referenceWarnings = referenceAnalysis.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    );
    const validation: Readonly<OkfBundleValidation> = Object.freeze({
      ...okfValidation,
      valid: okfValidation.valid && referenceErrors.length === 0,
      diagnostics: Object.freeze([
        ...okfValidation.diagnostics,
        ...referenceAnalysis.diagnostics,
      ]),
      envelopeErrors: Object.freeze([
        ...okfValidation.envelopeErrors,
        ...referenceErrors,
      ]),
      qualityWarnings: Object.freeze([
        ...okfValidation.qualityWarnings,
        ...referenceWarnings,
      ]),
    });
    if (!validation.valid) {
      return invalid(
        "okf_validation_failed",
        "resulting full bundle does not pass OKF 0.2 validation",
        {
          diagnostics: [...validation.conformanceErrors, ...validation.envelopeErrors],
        },
      );
    }

    return Object.freeze({
      kind: "ready",
      authorization,
      baseRevisionId: currentRevisionId,
      operations: operationSet.operations,
      candidateFiles: Object.freeze(candidateFiles),
      stagedBundleFileRecords: Object.freeze([...stagedRecords.values()]),
      validation,
      committedAt,
    });
  }
}
