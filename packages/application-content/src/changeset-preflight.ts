import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  AuthorizationDecision,
  Authorizer,
  Clock,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  RevisionEnvelopeError,
  canonicalMarkdownPath,
  sha256Digest,
  type RevisionId,
  type RevisionMode,
  type Sha256Digest,
  type SpaceId,
  type UtcInstant,
  type WriteMindBindingId,
} from "@mind-diary/domain";
import {
  okfFileKind,
  validateOkfBundle,
  type OkfBundleValidation,
  type OkfDiagnostic,
} from "@mind-diary/okf-codec";
import type { HeadRevisionReader } from "./index.js";
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

export type ChangesetOperation =
  | CreateFileOperation
  | ReplaceFileOperation
  | DeleteFileOperation
  | ReplaceIndexOperation
  | AddLogEntryOperation;

export interface ChangesetPreflightLimits {
  readonly maxOperations: number;
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
  readonly maxLogCategoryBytes: number;
  readonly maxLogMessageBytes: number;
  readonly maxChangesetBytes: number;
  readonly maxResultingFiles: number;
  readonly maxResultingBundleBytes: number;
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
  });

export interface ChangesetPreflightRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly revisionMode: RevisionMode;
  readonly expectedRevisionId: RevisionId | null;
  readonly writeBindingId?: WriteMindBindingId;
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
  | "okf_validation_failed";

export interface ChangesetValidationFailure {
  readonly code: ChangesetValidationCode;
  readonly message: string;
  readonly operationIndex?: number;
  readonly path?: string;
  readonly diagnostics?: readonly OkfDiagnostic[];
}

export interface ChangesetCandidateFile {
  readonly path: string;
  readonly mediaType: typeof MARKDOWN_MEDIA_TYPE;
  readonly text: string;
}

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
      readonly candidateFiles: readonly Readonly<ChangesetCandidateFile>[];
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
  readonly path: string;
  readonly text: string;
  readonly sha256: Sha256Digest | null;
}

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
): string | Extract<ChangesetPreflightResult, { readonly kind: "invalid" }> {
  if (typeof value !== "string") {
    return invalid("invalid_path", "operation path must be a string", {
      operationIndex,
    });
  }
  try {
    const path = canonicalMarkdownPath(value);
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
      return invalid("invalid_path", "operation path is not canonical Markdown", {
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
  let totalBytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    const candidate: unknown = source[index];
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      return invalid("invalid_operation", "operation must be a tagged object", {
        operationIndex: index,
      });
    }
    const pathResult = canonicalPath(candidate.path, index, limits);
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
  operation: ReplaceFileOperation | DeleteFileOperation | ReplaceIndexOperation,
  file: WorkingFile,
): boolean {
  return operation.expected_sha256 === undefined || operation.expected_sha256 === file.sha256;
}

function comparePaths(left: ChangesetCandidateFile, right: ChangesetCandidateFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export class ChangesetPreflightService {
  readonly #authorizer: Authorizer;
  readonly #revisions: HeadRevisionReader;
  readonly #clock: Clock;
  readonly #limits: Readonly<ChangesetPreflightLimits>;

  constructor(dependencies: ChangesetPreflightDependencies) {
    this.#authorizer = dependencies.authorizer;
    this.#revisions = dependencies.revisions;
    this.#clock = dependencies.clock;
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
              kind: "write" as const,
              writeBindingId: request.writeBindingId,
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

    const head = await this.#revisions.readHeadRevision(request.spaceId);
    const currentRevisionId = head?.envelope.revision.revisionId ?? null;
    if (currentRevisionId !== request.expectedRevisionId) {
      return Object.freeze({
        kind: "revision_conflict",
        currentRevisionId,
      });
    }

    const working = new Map<string, WorkingFile>();
    for (const file of head?.files ?? []) {
      working.set(
        file.path,
        Object.freeze({ path: file.path, text: file.text, sha256: file.sha256 }),
      );
    }

    const committedAt = this.#clock.now();

    for (let index = 0; index < operationSet.operations.length; index += 1) {
      const operation = operationSet.operations[index]!;
      const current = working.get(operation.path);
      if (operation.type === "create_file") {
        if (current) {
          return invalid("file_exists", "create_file target already exists", {
            operationIndex: index,
            path: operation.path,
          });
        }
        working.set(
          operation.path,
          Object.freeze({ path: operation.path, text: operation.text, sha256: null }),
        );
      } else if (
        operation.type === "replace_file" ||
        operation.type === "replace_index"
      ) {
        if (!current) {
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
          Object.freeze({ path: operation.path, text: operation.text, sha256: null }),
        );
      } else if (operation.type === "delete_file") {
        if (!current) {
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
        if (!current) {
          return invalid("file_not_found", "log target does not exist", {
            operationIndex: index,
            path: operation.path,
          });
        }
        const materialized = materializeLogEntry({
          path: operation.path,
          text: current.text,
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
            path: operation.path,
            text: materialized.text,
            sha256: null,
          }),
        );
      }
    }

    if (working.size > this.#limits.maxResultingFiles) {
      return invalid(
        "resulting_file_limit_exceeded",
        "resulting bundle file count exceeds its limit",
      );
    }
    let resultingBytes = 0;
    const candidateFiles = [...working.values()]
      .map((file) => {
        resultingBytes += ENCODER.encode(file.text).byteLength;
        return Object.freeze({
          path: file.path,
          mediaType: MARKDOWN_MEDIA_TYPE,
          text: file.text,
        });
      })
      .sort(comparePaths);
    if (resultingBytes > this.#limits.maxResultingBundleBytes) {
      return invalid(
        "resulting_bundle_size_limit_exceeded",
        "resulting bundle bytes exceed their limit",
      );
    }

    const validation = validateOkfBundle(candidateFiles);
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
      validation,
      committedAt,
    });
  }
}
