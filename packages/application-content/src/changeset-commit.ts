import type { ActorContext } from "@mind-diary/application-contracts";
import {
  REVISION_MANIFEST_MEDIA_TYPE,
  type Authorizer,
  type AuthorizationStamp,
  type Clock,
  type CapacityLimits,
  type CommitEffectIdGenerator,
  type ContentCommitMetadataStore,
  type ContentCommitMetadataTransaction,
  type FileIngressSourceKind,
  type IdempotencyNamespace,
  type BundleFileObjectStore,
  type PrincipalMindUsageWritePin,
  type RevisionIdGenerator,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V5,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  canonicalBundleFilePath,
  canonicalMarkdownPath,
  opaqueId,
  principalMindUsageWriteGeneration,
  serializeRevisionManifest,
  version,
  type CanonicalRevisionEnvelope,
  type IdempotencyKey,
  type PrincipalId,
  type RevisionId,
  type Sha256Digest,
  type SpaceId,
} from "@mind-diary/domain";
import {
  ChangesetPreflightService,
  DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
  validateChangesetOperations,
  type ChangesetOperation,
  type ChangesetPreflightLimits,
  type ChangesetPreflightResult,
  type ChangesetValidationCode,
} from "./changeset-preflight.js";
import {
  DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
  normalizeIdempotencyKeyMaxBytes,
  validateIdempotencyKey,
} from "./idempotency.js";
import type { HeadRevisionReader } from "./index.js";
import {
  CapacityAdmissionService,
  capacityReservationId,
} from "./capacity.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

export interface CommitChangesetRequest {
  /** Trusted queued-work fence; never populated from untrusted MCP arguments. */
  readonly requiredWritePin?: Readonly<PrincipalMindUsageWritePin>;
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId | null;
  readonly idempotencyKey: unknown;
  readonly summary: string;
  /** Adapter-resolved exact sources; untrusted shape is validated here. */
  readonly sourceReferences?: unknown;
  /** Trusted application-only policy for agent/service-produced OKF. */
  readonly producerProfile?: boolean;
  /** Untrusted adapter input is validated by changeset preflight. */
  readonly operations: unknown;
}

export interface PreflightChangesetRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId | null;
  /** Adapter-resolved exact sources; untrusted shape is validated here. */
  readonly sourceReferences?: unknown;
  /** Trusted application-only policy for agent/service-produced OKF. */
  readonly producerProfile?: boolean;
  /** Untrusted adapter input is validated by the shared changeset preflight. */
  readonly operations: unknown;
}

type NonReadyPreflightResult = Exclude<
  ChangesetPreflightResult,
  { readonly kind: "ready" }
>;

export type CommitChangesetResult =
  | {
      readonly kind: "committed";
      readonly previousRevisionId: RevisionId | null;
      readonly envelope: Readonly<CanonicalRevisionEnvelope>;
      readonly replayed: boolean;
    }
  | { readonly kind: "idempotency_conflict" }
  | NonReadyPreflightResult;

export type ReconcileChangesetResult =
  | { readonly kind: "missing" }
  | { readonly kind: "idempotency_conflict" }
  | Extract<CommitChangesetResult, { readonly kind: "committed" | "denied" | "invalid" }>;

export type PreflightChangesetResult =
  | (Extract<ChangesetPreflightResult, { readonly kind: "ready" }> & {
      readonly changesetIdentity: Sha256Digest;
      readonly producerProfile: boolean;
    })
  | NonReadyPreflightResult;

export type ChangesetCommitFailureCode =
  | "invalid_actor"
  | "invalid_idempotency_result"
  | "invalid_idempotency_state"
  | "missing_parent"
  | "revision_id_collision"
  | "invalid_revision_chain"
  | "invalid_commit_effects";

export class ChangesetCommitFailure extends Error {
  readonly code: ChangesetCommitFailureCode;

  constructor(code: ChangesetCommitFailureCode, message: string) {
    super(message);
    this.name = "ChangesetCommitFailure";
    this.code = code;
  }
}

export interface ChangesetCommitDependencies {
  readonly authorizer: Authorizer;
  readonly metadata: ContentCommitMetadataStore;
  readonly revisions: HeadRevisionReader;
  readonly objects: BundleFileObjectStore;
  readonly clock: Clock;
  readonly revisionIds: RevisionIdGenerator;
  readonly effectIds?: CommitEffectIdGenerator;
  readonly preflightLimits?: Readonly<ChangesetPreflightLimits>;
  readonly idempotencyKeyMaxBytes?: number;
  readonly maxRetainedBundleFileBytes?: number;
  readonly capacityLimits?: Readonly<CapacityLimits>;
}

export const DEFAULT_MAX_RETAINED_BUNDLE_FILE_BYTES = 2_147_483_648;

interface ValidatedCommitPayload {
  readonly idempotencyKey: IdempotencyKey;
  readonly operations: readonly Readonly<ChangesetOperation>[];
  readonly sourceReferences: readonly Readonly<ValidatedSourceReference>[];
  readonly producerProfile: boolean;
}

interface ValidatedSourceReference {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly path: string;
}

interface AuthorizedSourceReference {
  readonly source: Readonly<ValidatedSourceReference>;
  readonly stamp: Readonly<AuthorizationStamp>;
}

type WritePinResolution =
  | { readonly kind: "resolved"; readonly pin: Readonly<PrincipalMindUsageWritePin> }
  | { readonly kind: "required" | "stale" };

type SourceAuthorizationResult =
  | {
      readonly kind: "authorized";
      readonly sources: readonly Readonly<AuthorizedSourceReference>[];
    }
  | Extract<CommitChangesetResult, { readonly kind: "denied" | "invalid" }>;

interface StagedSourceAuditReceipt {
  readonly source_kind: FileIngressSourceKind;
  readonly sha256: Sha256Digest;
}

type InvalidResult = Extract<
  ChangesetPreflightResult,
  { readonly kind: "invalid" }
>;

const ENCODER = new TextEncoder();
const MAX_SOURCE_REFERENCES = 8;

function canonicalSourcePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return canonicalMarkdownPath(value);
  } catch {
    try {
      return canonicalBundleFilePath(value);
    } catch {
      return null;
    }
  }
}

function compareSourceReferences(
  left: Readonly<ValidatedSourceReference>,
  right: Readonly<ValidatedSourceReference>,
): number {
  return left.spaceId.localeCompare(right.spaceId) ||
    left.revisionId.localeCompare(right.revisionId) ||
    left.path.localeCompare(right.path);
}

function validateSourceReferences(
  value: unknown,
): readonly Readonly<ValidatedSourceReference>[] | null {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFERENCES) return null;
  const sources: ValidatedSourceReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const source = item as Readonly<Record<string, unknown>>;
    if (
      Object.keys(source).sort().join(",") !== "path,revisionId,spaceId" ||
      typeof source.spaceId !== "string" || source.spaceId.length === 0 ||
      typeof source.revisionId !== "string" || source.revisionId.length === 0
    ) return null;
    const path = canonicalSourcePath(source.path);
    if (path === null) return null;
    const normalized: ValidatedSourceReference = {
      spaceId: source.spaceId as SpaceId,
      revisionId: source.revisionId as RevisionId,
      path,
    };
    const key = `${normalized.spaceId}\u0000${normalized.revisionId}\u0000${path}`;
    if (seen.has(key)) return null;
    seen.add(key);
    sources.push(Object.freeze(normalized));
  }
  return Object.freeze(sources.sort(compareSourceReferences));
}

function canonicalStagedSourceAuditReceipts(
  records: readonly Readonly<{
    sourceKind: FileIngressSourceKind;
    sha256: Sha256Digest;
  }>[],
): string | null {
  if (records.length === 0) return null;
  const receipts: StagedSourceAuditReceipt[] = records.map((record) => ({
    source_kind: record.sourceKind,
    sha256: record.sha256,
  }));
  receipts.sort((left, right) =>
    left.source_kind < right.source_kind
      ? -1
      : left.source_kind > right.source_kind
        ? 1
        : left.sha256 < right.sha256
          ? -1
          : left.sha256 > right.sha256
            ? 1
            : 0
  );
  return JSON.stringify(receipts);
}

async function verifiedStagedStream(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  expectedSha256: Sha256Digest,
): Promise<boolean> {
  const reader = body.getReader();
  const digest = new IncrementalSha256();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      if (!(chunk instanceof Uint8Array) || size + chunk.byteLength > expectedSize) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      size += chunk.byteLength;
      digest.update(chunk);
    }
    return size === expectedSize && digest.digest() === expectedSha256;
  } finally {
    reader.releaseLock();
  }
}

const MAX_COMMIT_OBJECT_CONCURRENCY = 8;

/**
 * Materialize independent candidate objects with a fixed worker count while
 * retaining the input order in the returned values.  Workers record failures
 * and finish the current batch before the first failure is rethrown; this
 * keeps the object phase bounded and leaves the commit transaction unreachable
 * until every candidate has completed successfully.
 */
async function mapBounded<Input, Output>(
  values: readonly Input[],
  operation: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  const results: Array<PromiseSettledResult<Output> | undefined> =
    new Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_COMMIT_OBJECT_CONCURRENCY, values.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        try {
          results[index] = {
            status: "fulfilled",
            value: await operation(values[index]!, index),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result?.status === "rejected",
  );
  if (rejected !== undefined) throw rejected.reason;
  return Object.freeze(results.map((result) => {
    if (result?.status !== "fulfilled") {
      throw new ChangesetCommitFailure(
        "invalid_revision_chain",
        "candidate object materialization did not complete",
      );
    }
    return result.value;
  }));
}

function invalid(code: ChangesetValidationCode, message: string): InvalidResult {
  return Object.freeze({
    kind: "invalid",
    error: Object.freeze({ code, message }),
  });
}

function canonicalOperation(operation: Readonly<ChangesetOperation>): object {
  switch (operation.type) {
    case "create_file":
      return { type: operation.type, path: operation.path, text: operation.text };
    case "replace_file":
    case "replace_index":
      return {
        type: operation.type,
        path: operation.path,
        text: operation.text,
        ...(operation.expected_sha256 === undefined
          ? {}
          : { expected_sha256: operation.expected_sha256 }),
      };
    case "delete_file":
      return {
        type: operation.type,
        path: operation.path,
        ...(operation.expected_sha256 === undefined
          ? {}
          : { expected_sha256: operation.expected_sha256 }),
      };
    case "add_log_entry":
      return {
        type: operation.type,
        path: operation.path,
        category: operation.category,
        message: operation.message,
      };
    case "create_bundle_file":
      return {
        type: operation.type,
        path: operation.path,
        staged_file_id: operation.staged_file_id,
      };
    case "replace_bundle_file":
      return {
        type: operation.type,
        path: operation.path,
        staged_file_id: operation.staged_file_id,
        ...(operation.expected_sha256 === undefined
          ? {}
          : { expected_sha256: operation.expected_sha256 }),
      };
    case "delete_bundle_file":
      return {
        type: operation.type,
        path: operation.path,
        ...(operation.expected_sha256 === undefined
          ? {}
          : { expected_sha256: operation.expected_sha256 }),
      };
    case "reclassify_bundle_file":
      return {
        type: operation.type,
        path: operation.path,
        media_type: operation.media_type,
        expected_sha256: operation.expected_sha256,
      };
  }
}

function canonicalRequestSource(
  request: CommitChangesetRequest,
  validated: ValidatedCommitPayload,
): string {
  // producerProfile and the principal-owned generation are server policy, not
  // caller payload. They are deliberately excluded from the idempotency hash.
  return `${JSON.stringify({
    format: "mind-diary-commit-changeset-request-v2",
    expected_revision_id: request.expectedRevisionId,
    summary: request.summary,
    operations: validated.operations.map(canonicalOperation),
    source_references: validated.sourceReferences.map((source) => ({
      space_id: source.spaceId,
      revision_id: source.revisionId,
      path: source.path,
    })),
  })}\n`;
}

function canonicalSourceReferencesSource(
  sources: readonly Readonly<ValidatedSourceReference>[],
): string {
  return `${JSON.stringify(sources.map((source) => ({
    space_id: source.spaceId,
    revision_id: source.revisionId,
    path: source.path,
  })))}\n`;
}

function sha256Source(value: string): Sha256Digest {
  const digest = new IncrementalSha256();
  digest.update(ENCODER.encode(value));
  return digest.digest() as Sha256Digest;
}

function preflightCandidateIdentity(
  result: Extract<ChangesetPreflightResult, { readonly kind: "ready" }>,
  producerProfile: boolean,
  sourceReferences: readonly Readonly<ValidatedSourceReference>[],
): Sha256Digest {
  return sha256Source(`${JSON.stringify({
    format: "mind-diary-preflight-changeset-result-v1",
    base_revision_id: result.baseRevisionId,
    producer_profile: producerProfile,
    files: result.candidateFiles.map((file) => ({
      kind: file.kind,
      path: file.path,
      media_type: file.mediaType,
      size: file.size,
      sha256: file.kind === "markdown" && file.text !== undefined
        ? sha256Source(file.text)
        : file.sha256,
    })),
    source_references: sourceReferences.map((source) => ({
      space_id: source.spaceId,
      revision_id: source.revisionId,
      path: source.path,
    })),
  })}\n`);
}

function deniedWritableMind(
  code: "writable_mind_required" | "writable_mind_stale",
  retryable = false,
) {
  return Object.freeze({
    kind: "denied" as const,
    code,
    retryable,
  });
}

/** Application-level immediate commit_changeset use case. */
export class ChangesetCommitService {
  readonly #authorizer: Authorizer;
  readonly #metadata: ContentCommitMetadataStore;
  readonly #objects: BundleFileObjectStore;
  readonly #revisionIds: RevisionIdGenerator;
  readonly #effectIds: CommitEffectIdGenerator | null;
  readonly #preflight: ChangesetPreflightService;
  readonly #preflightLimits: Readonly<ChangesetPreflightLimits>;
  readonly #idempotencyKeyMaxBytes: number;
  readonly #maxRetainedBundleFileBytes: number;
  readonly #capacity: CapacityAdmissionService;

  constructor(dependencies: ChangesetCommitDependencies) {
    this.#authorizer = dependencies.authorizer;
    this.#metadata = dependencies.metadata;
    this.#objects = dependencies.objects;
    this.#revisionIds = dependencies.revisionIds;
    this.#effectIds = dependencies.effectIds ?? null;
    this.#preflightLimits =
      dependencies.preflightLimits ?? DEFAULT_CHANGESET_PREFLIGHT_LIMITS;
    this.#idempotencyKeyMaxBytes = normalizeIdempotencyKeyMaxBytes(
      dependencies.idempotencyKeyMaxBytes ?? DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
    );
    const retainedLimit = dependencies.maxRetainedBundleFileBytes ??
      DEFAULT_MAX_RETAINED_BUNDLE_FILE_BYTES;
    if (!Number.isSafeInteger(retainedLimit) || retainedLimit < 1) {
      throw new TypeError("retained BundleFile byte limit must be positive");
    }
    this.#maxRetainedBundleFileBytes = retainedLimit;
    this.#capacity = new CapacityAdmissionService({
      metadata: dependencies.metadata,
      authorizer: dependencies.authorizer,
      clock: dependencies.clock,
      ...(dependencies.capacityLimits === undefined
        ? {}
        : { limits: dependencies.capacityLimits }),
    });
    this.#preflight = new ChangesetPreflightService({
      authorizer: dependencies.authorizer,
      revisions: dependencies.revisions,
      clock: dependencies.clock,
      limits: this.#preflightLimits,
      stagedBundleFiles: dependencies.metadata,
      producerProofs: dependencies.metadata,
    });
  }

  /**
   * Read-only commit-gate evaluation over the same preflight engine used by
   * commit(). It never reserves capacity, writes objects, consumes staged
   * files or idempotency state, or advances HEAD.
   */
  async preflight(request: PreflightChangesetRequest): Promise<PreflightChangesetResult> {
    const initialAuthorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (initialAuthorization.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initialAuthorization });
    }
    if (request.actor.kind !== "registered_principal") {
      throw new ChangesetCommitFailure(
        "invalid_actor",
        "an authorized content changeset must belong to a registered principal",
      );
    }
    const resolvedWritePin = await this.#resolveWritePin(
      request.actor.principalId,
      request.spaceId,
    );
    if (resolvedWritePin.kind !== "resolved") {
      return Object.freeze({
        kind: "denied",
        decision: deniedWritableMind(
          resolvedWritePin.kind === "required"
            ? "writable_mind_required"
            : "writable_mind_stale",
        ),
      });
    }
    const operations = validateChangesetOperations(
      request.operations,
      this.#preflightLimits,
    );
    if (operations.kind === "invalid") return operations;
    const sourceReferences = validateSourceReferences(request.sourceReferences);
    if (sourceReferences === null) {
      return invalid(
        "invalid_source_references",
        "source references must be at most eight distinct exact source locators",
      );
    }
    const sourceAuthorization = await this.#authorizeSourceReferences(
      request.actor,
      sourceReferences,
    );
    if (sourceAuthorization.kind !== "authorized") return sourceAuthorization;
    const producerProfile = request.producerProfile === true;
    const result = await this.#preflight.preflight({
      actor: request.actor,
      spaceId: request.spaceId,
      revisionMode: "head",
      expectedRevisionId: request.expectedRevisionId,
      writeUsagePin: resolvedWritePin.pin,
      operations: operations.operations,
      producerProfile,
    });
    if (result.kind !== "ready") return result;
    return Object.freeze({
      ...result,
      changesetIdentity: preflightCandidateIdentity(
        result,
        producerProfile,
        sourceReferences,
      ),
      producerProfile,
    });
  }

  /**
   * Read-only unknown-outcome resolution for an exact commit payload.  It
   * performs the same current authorization and canonical-payload checks as
   * commit(), but never preflights, reserves capacity, writes objects or moves
   * HEAD when the idempotency namespace is still missing.
   */
  async reconcile(request: CommitChangesetRequest): Promise<ReconcileChangesetResult> {
    const initialAuthorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (initialAuthorization.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initialAuthorization });
    }
    if (request.actor.kind !== "registered_principal") {
      throw new ChangesetCommitFailure(
        "invalid_actor",
        "an authorized content changeset must belong to a registered principal",
      );
    }
    const actor = request.actor;
    const resolvedWritePin = await this.#resolveWritePin(
      actor.principalId,
      request.spaceId,
    );
    if (resolvedWritePin.kind !== "resolved") {
      return Object.freeze({
        kind: "denied",
        decision: deniedWritableMind(
          resolvedWritePin.kind === "required"
            ? "writable_mind_required"
            : "writable_mind_stale",
        ),
      });
    }
    const writePin = resolvedWritePin.pin;
    if (request.requiredWritePin !== undefined &&
        (request.requiredWritePin.principalId !== writePin.principalId ||
         request.requiredWritePin.spaceId !== writePin.spaceId ||
         request.requiredWritePin.generationId !== writePin.generationId)) {
      return Object.freeze({ kind: "denied", decision: deniedWritableMind("writable_mind_stale") });
    }
    const validated = this.#validatePayload(request);
    if ("kind" in validated) return validated;
    const sourceAuthorization = await this.#authorizeSourceReferences(
      actor,
      validated.sourceReferences,
    );
    if (sourceAuthorization.kind !== "authorized") return sourceAuthorization;
    const canonicalRequestHash = await this.#objects.calculateSha256(
      ENCODER.encode(canonicalRequestSource(request, validated)),
    );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "commit_changeset" }
    > = Object.freeze({
      principalId: actor.principalId,
      spaceId: request.spaceId,
      operation: "commit_changeset",
      key: validated.idempotencyKey,
    });
    return this.#metadata.runContentCommitTransaction(async (transaction) => {
      const authorization = await this.#authorizer.reauthorizeInTransaction(
        {
          actor,
          spaceId: request.spaceId,
          capability: "content:write",
          revisionMode: "head",
        },
        transaction,
        initialAuthorization.stamp,
      );
      if (authorization.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: authorization });
      }
      if (!(await transaction.validatePrincipalMindUsageWritePin(writePin))) {
        return Object.freeze({
          kind: "denied",
          decision: deniedWritableMind("writable_mind_stale"),
        });
      }
      const sourceDenied = await this.#reauthorizeSourceReferences(
        actor,
        transaction,
        sourceAuthorization.sources,
      );
      if (sourceDenied !== null) return sourceDenied;
      return this.#resolveIdempotency(transaction, namespace, canonicalRequestHash);
    });
  }

  async commit(request: CommitChangesetRequest): Promise<CommitChangesetResult> {
    const initialAuthorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (initialAuthorization.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initialAuthorization });
    }
    if (request.actor.kind !== "registered_principal") {
      throw new ChangesetCommitFailure(
        "invalid_actor",
        "an authorized content changeset must belong to a registered principal",
      );
    }
    const actor = request.actor;
    const resolvedWritePin = await this.#resolveWritePin(
      actor.principalId,
      request.spaceId,
    );
    if (resolvedWritePin.kind !== "resolved") {
      return Object.freeze({
        kind: "denied",
        decision: deniedWritableMind(
          resolvedWritePin.kind === "required"
            ? "writable_mind_required"
            : "writable_mind_stale",
        ),
      });
    }
    const writePin = resolvedWritePin.pin;

    const validated = this.#validatePayload(request);
    if (request.requiredWritePin !== undefined &&
        (request.requiredWritePin.principalId !== writePin.principalId ||
         request.requiredWritePin.spaceId !== writePin.spaceId ||
         request.requiredWritePin.generationId !== writePin.generationId)) {
      return Object.freeze({ kind: "denied", decision: deniedWritableMind("writable_mind_stale") });
    }
    if ("kind" in validated) return validated;
    const sourceAuthorization = await this.#authorizeSourceReferences(
      actor,
      validated.sourceReferences,
    );
    if (sourceAuthorization.kind !== "authorized") return sourceAuthorization;
    const canonicalRequestHash = await this.#objects.calculateSha256(
      ENCODER.encode(canonicalRequestSource(request, validated)),
    );
    const sourceReferencesDigest = validated.sourceReferences.length === 0
      ? null
      : await this.#objects.calculateSha256(
          ENCODER.encode(canonicalSourceReferencesSource(validated.sourceReferences)),
        );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "commit_changeset" }
    > = Object.freeze({
      principalId: actor.principalId,
      spaceId: request.spaceId,
      operation: "commit_changeset",
      key: validated.idempotencyKey,
    });

    const early = await this.#metadata.runContentCommitTransaction(
      async (transaction) => {
        const authorization = await this.#authorizer.reauthorizeInTransaction(
          {
            actor,
            spaceId: request.spaceId,
            capability: "content:write",
            revisionMode: "head",
          },
          transaction,
          initialAuthorization.stamp,
        );
        if (authorization.kind === "denied") {
          return Object.freeze({ kind: "denied", decision: authorization });
        }
        if (!(await transaction.validatePrincipalMindUsageWritePin(writePin))) {
          return Object.freeze({
            kind: "denied",
            decision: deniedWritableMind("writable_mind_stale"),
          });
        }
        const sourceDenied = await this.#reauthorizeSourceReferences(
          actor,
          transaction,
          sourceAuthorization.sources,
        );
        if (sourceDenied !== null) return sourceDenied;
        return this.#resolveIdempotency(
          transaction,
          namespace,
          canonicalRequestHash,
        );
      },
    );
    if (early.kind !== "missing") return early;

    const preflight = await this.#preflight.preflight({
      actor,
      spaceId: request.spaceId,
      revisionMode: "head",
      expectedRevisionId: request.expectedRevisionId,
      writeUsagePin: writePin,
      operations: validated.operations,
      producerProfile: validated.producerProfile,
    });
    if (preflight.kind !== "ready") return preflight;

    const committedAt = preflight.committedAt;
    const stagedSourceReceipts = canonicalStagedSourceAuditReceipts(
      preflight.stagedBundleFileRecords,
    );
    const revisionId = this.#revisionIds.nextRevisionId();
    const reservationOperationRef = String(canonicalRequestHash);
    const reservationId = capacityReservationId(
      "commit",
      request.spaceId,
      reservationOperationRef,
    );
    const candidateWriteBytes = preflight.candidateFiles.reduce(
      (total, file) => total +
        (file.kind === "markdown"
          ? (file.writeRequired ? file.size : 0)
          : (file.stagedFileId === null ? 0 : file.size)),
      0,
    );
    const admission = await this.#capacity.reserve({
      actor,
      spaceId: request.spaceId,
      operation: "commit",
      operationRef: reservationOperationRef,
      baseRevisionId: preflight.baseRevisionId,
      idempotencyKey: validated.idempotencyKey,
      requested: Object.freeze({
        physicalCanonicalBytes:
          candidateWriteBytes + 512 + preflight.candidateFiles.reduce(
            (total, file) => total + ENCODER.encode(file.path).byteLength + 256,
            0,
          ),
        temporaryBytes: 0,
        d1MetadataBytes: 2_048 + preflight.candidateFiles.length * 160,
      }),
      bulk: false,
      heavy: candidateWriteBytes > 4_194_304,
      createdAt: committedAt,
    });
    if (admission.kind === "rejected") {
      const code = admission.reason === "hard_limit"
        ? "capacity_hard_limit"
        : admission.reason === "soft_limit"
          ? "capacity_soft_limit"
          : admission.reason === "fairness_limit"
            ? "capacity_fairness_limit"
            : "capacity_accounting_untrusted";
      return invalid(code, `capacity admission rejected: ${admission.reason}`);
    }
    try {
    const materialized = await mapBounded(
      preflight.candidateFiles,
      async (file) => {
        if (file.kind === "markdown") {
          if (!file.writeRequired) {
            if (file.sha256 === null) {
              throw new ChangesetCommitFailure(
                "invalid_revision_chain",
                "unchanged Markdown entry has no immutable digest",
              );
            }
            return Object.freeze({
              entry: Object.freeze({
                kind: "markdown" as const,
                path: file.path,
                sha256: file.sha256,
                mediaType: MARKDOWN_MEDIA_TYPE,
                size: file.size,
                ...(file.integrityRoot === undefined ? {} : { integrityRoot: file.integrityRoot }),
              }),
              physicalGrowth: 0,
            });
          }
          const bytes = ENCODER.encode(file.text!);
          const digest = await this.#objects.calculateSha256(bytes);
          if (file.sha256 !== null && digest === file.sha256 && bytes.byteLength === file.size) {
            return Object.freeze({
              entry: Object.freeze({
                kind: "markdown" as const,
                path: file.path,
                sha256: digest,
                mediaType: MARKDOWN_MEDIA_TYPE,
                size: bytes.byteLength,
                ...(file.integrityRoot === undefined ? {} : { integrityRoot: file.integrityRoot }),
              }),
              physicalGrowth: 0,
            });
          }
          const put = await this.#objects.putSpaceCanonicalObject({
            kind: "markdown",
            spaceId: request.spaceId,
            bytes,
            mediaType: MARKDOWN_MEDIA_TYPE,
            createdAt: committedAt,
          });
          return Object.freeze({
            entry: Object.freeze({
              kind: "markdown" as const,
              path: file.path,
              sha256: put.object.sha256,
              mediaType: MARKDOWN_MEDIA_TYPE,
              size: put.object.size,
              integrityRoot: put.integrityRoot,
            }),
            physicalGrowth: put.status === "stored" ? put.object.size : 0,
          });
        }
        if (file.stagedFileId === null) {
          return Object.freeze({
            entry: Object.freeze({
              kind: "opaque" as const,
              path: file.path,
              sha256: file.sha256,
              mediaType: file.mediaType,
              size: file.size,
              ...(file.integrityRoot === undefined ? {} : { integrityRoot: file.integrityRoot }),
            }),
            physicalGrowth: 0,
          });
        }
        const staged = await this.#objects.openStagedBundleFile(file.stagedFileId);
        if (
          staged === null || staged.spaceId !== request.spaceId ||
          staged.size !== file.size ||
          !(await verifiedStagedStream(staged.body, file.size, file.sha256))
        ) return invalid(
          "staged_bundle_file_not_verified",
          "staged BundleFile bytes failed integrity verification",
        );
        const put = await this.#objects.promoteStagedBundleFile({
          stagedFileId: file.stagedFileId,
          bindingOwnerId: staged.bindingOwnerId,
          spaceId: request.spaceId,
          sha256: file.sha256,
          size: file.size,
          mediaType: file.mediaType,
          createdAt: committedAt,
        });
        const promoted = await this.#objects.openBundleFile(request.spaceId, file.sha256);
        if (
          promoted === null || promoted.sha256 !== file.sha256 ||
          promoted.size !== file.size ||
          !(await verifiedStagedStream(promoted.body, file.size, file.sha256))
        ) return invalid(
          "staged_bundle_file_not_verified",
          "promoted BundleFile bytes failed integrity verification",
        );
        return Object.freeze({
          entry: Object.freeze({
            kind: "opaque" as const,
            path: file.path,
            sha256: file.sha256,
            mediaType: file.mediaType,
            size: file.size,
            ...(put.integrityRoot === undefined ? {} : { integrityRoot: put.integrityRoot }),
          }),
          physicalGrowth: put.status === "stored" ? put.object.size : 0,
        });
      },
    );
    const materializationFailure = materialized.find(
      (result): result is InvalidResult =>
        "kind" in result && result.kind === "invalid",
    );
    if (materializationFailure !== undefined) return materializationFailure;
    let actualPhysicalGrowth = 0;
    const entries = materialized.map((result) => {
      if ("kind" in result) {
        throw new ChangesetCommitFailure(
          "invalid_revision_chain",
          "candidate object materialization returned an invalid result",
        );
      }
      actualPhysicalGrowth += result.physicalGrowth;
      return result.entry;
    });
    const manifest = createRevisionManifest(entries, REVISION_MANIFEST_FORMAT_V5);
    const manifestBytes = ENCODER.encode(serializeRevisionManifest(manifest));
    const manifestPut = await this.#objects.putSpaceCanonicalObject({
      kind: "revision_manifest",
      spaceId: request.spaceId,
      bytes: manifestBytes,
      mediaType: REVISION_MANIFEST_MEDIA_TYPE,
      createdAt: committedAt,
    });
    if (manifestPut.status === "stored") {
      actualPhysicalGrowth += manifestPut.object.size;
    }
    const manifestHash = manifestPut.object.sha256;

    const result = await this.#metadata.runContentCommitTransaction(async (transaction) => {
      const authorization = await this.#authorizer.reauthorizeInTransaction(
        {
          actor,
          spaceId: request.spaceId,
          capability: "content:write",
          revisionMode: "head",
        },
        transaction,
        preflight.authorization.stamp,
      );
      if (authorization.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: authorization });
      }
      if (!(await transaction.validatePrincipalMindUsageWritePin(writePin))) {
        return Object.freeze({
          kind: "denied",
          decision: deniedWritableMind("writable_mind_stale"),
        });
      }
      const sourceDenied = await this.#reauthorizeSourceReferences(
        actor,
        transaction,
        sourceAuthorization.sources,
      );
      if (sourceDenied !== null) return sourceDenied;

      const idempotency = await this.#resolveIdempotency(
        transaction,
        namespace,
        canonicalRequestHash,
      );
      if (idempotency.kind !== "missing") return idempotency;

      const currentHeadRevisionId = await transaction.readHead(request.spaceId);
      if (currentHeadRevisionId !== preflight.baseRevisionId) {
        return Object.freeze({
          kind: "revision_conflict",
          currentRevisionId: currentHeadRevisionId,
        });
      }


      if (preflight.stagedBundleFileRecords.length > 0) {
        for (const expected of preflight.stagedBundleFileRecords) {
          const current = await transaction.readStagedBundleFile(expected.stagedFileId);
          if (
            current === null || current.state !== "verified" ||
            current.sha256 !== expected.sha256 || current.size !== expected.size ||
            current.mediaType !== expected.mediaType ||
            current.sourceKind !== expected.sourceKind ||
            current.principalId !== writePin.principalId ||
            current.principalMindUsageGenerationId !== writePin.generationId ||
            current.spaceId !== request.spaceId ||
            Date.parse(current.expiresAt) <= Date.parse(committedAt)
          ) return invalid(
            "staged_bundle_file_not_verified",
            "staged BundleFile state changed before commit",
          );
        }
      }
      const retainedQuotaAllowed = await transaction.checkBundleFileRetainedQuota({
        spaceId: request.spaceId,
        candidateEntries: preflight.candidateFiles
          .filter((file) => file.kind === "opaque")
          .map((file) => Object.freeze({ sha256: file.sha256, size: file.size })),
        maxRetainedBytes: this.#maxRetainedBundleFileBytes,
      });
      if (!retainedQuotaAllowed) return invalid(
        "retained_bundle_file_quota_exceeded",
        "retained unique BundleFile bytes exceed the Space quota",
      );

      let revisionNumber = 1;
      if (preflight.baseRevisionId !== null) {
        const parent = await transaction.readRevision(
          request.spaceId,
          preflight.baseRevisionId,
        );
        if (parent === null) {
          throw new ChangesetCommitFailure(
            "missing_parent",
            "current HEAD does not resolve to an immutable parent revision",
          );
        }
        revisionNumber = parent.revision.revisionNumber + 1;
      }

      const baseEnvelope = createCanonicalRevisionEnvelope({
        revisionId,
        spaceId: request.spaceId,
        revisionNumber,
        parentRevisionId: preflight.baseRevisionId,
        committedAt,
        committedBy: {
          kind: "principal",
          principalId: actor.principalId,
        },
        manifest,
        manifestHash,
        manifestSize: manifestPut.object.size,
        summary: request.summary,
      });
      const envelope = preflight.producerCertificate === undefined
        ? baseEnvelope
        : (() => {
            const entriesByPath = new Map(manifest.entries.map((entry) => [entry.path, entry] as const));
            if (
              preflight.producerCertificate.files.length !== manifest.entries.length ||
              preflight.producerCertificate.files.some((file) => {
                const entry = entriesByPath.get(file.path);
                return entry === undefined || entry.kind !== file.kind ||
                  entry.mediaType !== file.mediaType || entry.sha256 !== file.sha256 ||
                  entry.size !== file.size;
              })
            ) {
              throw new ChangesetCommitFailure(
                "invalid_revision_chain",
                "producer validation certificate does not match committed files",
              );
            }
            const producerCertificate = Object.freeze({
              ...preflight.producerCertificate,
              // The preflight certificate proves logical file digests. The
              // commit adds adapter-derived integrity roots and binds the
              // durable certificate to the resulting canonical v5 manifest.
              manifestFingerprint: manifestHash,
              revisionId,
            });
            return Object.freeze({
              ...baseEnvelope,
              revision: Object.freeze({
                ...baseEnvelope.revision,
                producerCertificate,
              }),
            });
          })();
      const committed = await transaction.commitRevision({
        expectedHeadRevisionId: preflight.baseRevisionId,
        envelope,
      });
      if (committed.kind === "committed") {
        if (committed.replayed) {
          throw new ChangesetCommitFailure(
            "invalid_idempotency_state",
            "revision-ID replay cannot substitute for namespaced idempotency",
          );
        }
        if (
          preflight.stagedBundleFileRecords.length > 0
        ) {
          const consumed = await transaction.consumeStagedBundleFiles({
            stagedFileIds: preflight.stagedBundleFileRecords.map(
              (record) => record.stagedFileId,
            ),
            principalId: writePin.principalId,
            principalMindUsageGenerationId: writePin.generationId,
            spaceId: request.spaceId,
            consumedAt: committedAt,
          });
          if (consumed.kind !== "consumed") {
            throw new ChangesetCommitFailure(
              "invalid_commit_effects",
              `staged BundleFiles were not consumed atomically: ${consumed.kind}`,
            );
          }
        }
        const completion = await transaction.completeIdempotency({
          namespace,
          canonicalRequestHash,
          result: Object.freeze({
            kind: "commit_changeset",
            previousRevisionId: preflight.baseRevisionId,
            revisionId: committed.envelope.revision.revisionId,
          }),
          completedAt: committedAt,
        });
        if (completion.kind !== "completed") {
          throw new ChangesetCommitFailure(
            "invalid_idempotency_state",
            "idempotency namespace changed inside the content transaction",
          );
        }
        const committedRevisionId = committed.envelope.revision.revisionId;
        const auditEventId = this.#effectIds?.nextAuditEventId() ??
          opaqueId<"audit-event">(`audit_${committedRevisionId}`);
        const outboxMessageId = this.#effectIds?.nextOutboxMessageId() ??
          opaqueId<"outbox-message">(`audit_outbox_${committedRevisionId}`);
        const indexJobId = this.#effectIds?.nextIndexJobId() ??
          opaqueId<"job">(`index_job_${committedRevisionId}`);
        const effects = await transaction.stageContentCommitEffects({
          auditEvent: Object.freeze({
            auditEventId,
            actor: Object.freeze({
              kind: "principal" as const,
              principalId: actor.principalId,
            }),
            requestId: actor.requestId,
            eventType: "content.changeset_committed",
            outcome: "succeeded",
            spaceId: request.spaceId,
            occurredAt: committedAt,
            safeMetadata: Object.freeze({
              revision_id: committedRevisionId,
              previous_revision_id: preflight.baseRevisionId,
              revision_number: committed.envelope.revision.revisionNumber,
              manifest_hash: committed.envelope.revision.manifestHash,
              ...(stagedSourceReceipts === null
                ? {}
                : { staged_source_receipts: stagedSourceReceipts }),
              ...(sourceReferencesDigest === null
                ? {}
                : {
                    source_reference_count: validated.sourceReferences.length,
                    source_reference_digest: sourceReferencesDigest,
                  }),
            }),
          }),
          auditOutbox: Object.freeze({
            outboxMessageId,
            auditEventId,
            state: "pending",
            version: version(1),
            attempts: 0,
            availableAt: committedAt,
            claimExpiresAt: null,
            createdAt: committedAt,
            updatedAt: committedAt,
          }),
          indexJob: Object.freeze({
            jobId: indexJobId,
            target: Object.freeze({
              kind: "revision_index" as const,
              spaceId: request.spaceId,
              revisionId: committedRevisionId,
            }),
            state: "queued",
            version: version(1),
            attempts: 0,
            availableAt: committedAt,
            claimExpiresAt: null,
            createdAt: committedAt,
            updatedAt: committedAt,
          }),
          indexState: Object.freeze({
            spaceId: request.spaceId,
            revisionId: committedRevisionId,
            status: "queued",
            attempts: 0,
            queuedAt: committedAt,
            updatedAt: committedAt,
            readyAt: null,
            lastFailureCode: null,
          }),
        });
        if (effects.kind !== "staged") {
          throw new ChangesetCommitFailure(
            "invalid_commit_effects",
            `commit effects were not staged atomically: ${effects.kind}`,
          );
        }
        const capacityConsumed = await transaction.consumeCapacityReservation({
          reservationId,
          actual: Object.freeze({
            physicalCanonicalBytes: actualPhysicalGrowth,
            temporaryBytes: 0,
            d1MetadataBytes: admission.reservation.requested.d1MetadataBytes,
          }),
          consumedAt: committedAt,
        });
        if (
          capacityConsumed !== "consumed" &&
          capacityConsumed !== "already_consumed"
        ) {
          throw new ChangesetCommitFailure(
            "invalid_commit_effects",
            `capacity reservation was not consumed atomically: ${capacityConsumed}`,
          );
        }
        return Object.freeze({
          kind: "committed",
          previousRevisionId: preflight.baseRevisionId,
          envelope: committed.envelope,
          replayed: false,
        });
      }
      if (committed.kind === "stale_head") {
        return Object.freeze({
          kind: "revision_conflict",
          currentRevisionId: committed.currentHeadRevisionId,
        });
      }
      if (committed.kind === "revision_id_collision") {
        throw new ChangesetCommitFailure(
          "revision_id_collision",
          "generated revision ID is already bound to different metadata",
        );
      }
      throw new ChangesetCommitFailure(
        "invalid_revision_chain",
        `metadata rejected the changeset revision: ${committed.reason}`,
      );
    });
    if (result.kind !== "committed") await this.#capacity.cancel(reservationId);
    return result;
    } catch (error) {
      await this.#capacity.cancel(reservationId).catch(() => undefined);
      throw error;
    }
  }

  #validatePayload(
    request: CommitChangesetRequest,
  ): ValidatedCommitPayload | InvalidResult {
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
    if (typeof request.summary !== "string") {
      return invalid("invalid_summary", "changeset summary must be a string");
    }
    const checkedKey = validateIdempotencyKey(
      request.idempotencyKey,
      this.#idempotencyKeyMaxBytes,
    );
    if (checkedKey.kind === "invalid") {
      const message =
        checkedKey.reason === "byte_limit_exceeded"
          ? "idempotency key exceeds its UTF-8 byte limit"
          : checkedKey.reason === "single_line_required"
            ? "idempotency key must not contain control or line-separator characters"
            : checkedKey.reason === "invalid_utf8"
              ? "idempotency key must be canonical UTF-8"
              : "idempotency key must be a non-empty string";
      return invalid(
        "invalid_idempotency_key",
        message,
      );
    }
    const operations = validateChangesetOperations(
      request.operations,
      this.#preflightLimits,
    );
    if (operations.kind === "invalid") return operations;
    const sourceReferences = validateSourceReferences(request.sourceReferences);
    if (sourceReferences === null) {
      return invalid(
        "invalid_source_references",
        "source references must be at most eight distinct exact source locators",
      );
    }
    return Object.freeze({
      idempotencyKey: checkedKey.key,
      operations: operations.operations,
      sourceReferences,
      producerProfile: request.producerProfile === true,
    });
  }

  async #resolveWritePin(
    principalId: PrincipalId,
    spaceId: SpaceId,
  ): Promise<WritePinResolution> {
    const state = await this.#metadata.readPrincipalMindUsage(principalId);
    const generation = principalMindUsageWriteGeneration(state, spaceId);
    if (
      generation === null ||
      generation.principalId !== principalId ||
      generation.spaceId !== spaceId
    ) return Object.freeze({ kind: "required" });
    const pin: Readonly<PrincipalMindUsageWritePin> = Object.freeze({
      principalId,
      spaceId,
      generationId: generation.generationId,
    });
    return await this.#metadata.validatePrincipalMindUsageWritePin(pin)
      ? Object.freeze({ kind: "resolved", pin })
      : Object.freeze({ kind: "stale" });
  }

  async #authorizeSourceReferences(
    actor: Extract<ActorContext, { readonly kind: "registered_principal" }>,
    sources: readonly Readonly<ValidatedSourceReference>[],
  ): Promise<SourceAuthorizationResult> {
    if (sources.length === 0) {
      return Object.freeze({ kind: "authorized", sources: Object.freeze([]) });
    }
    const usage = await this.#metadata.readPrincipalMindUsage(actor.principalId);
    const authorized: AuthorizedSourceReference[] = [];
    for (const source of sources) {
      if (!usage?.entries.some((entry) => entry.spaceId === source.spaceId)) {
        return Object.freeze({
          kind: "denied",
          decision: Object.freeze({
            kind: "denied" as const,
            code: "access_denied" as const,
            retryable: false,
          }),
        });
      }
      const decision = await this.#authorizer.authorize({
        actor,
        spaceId: source.spaceId,
        capability: "content:fetch",
        revisionMode: "historical",
      });
      if (decision.kind === "denied") {
        return Object.freeze({ kind: "denied", decision });
      }
      const envelope = await this.#metadata.readRevision(
        source.spaceId,
        source.revisionId,
      );
      if (
        envelope === null ||
        !envelope.manifest.entries.some((entry) => entry.path === source.path)
      ) {
        return invalid(
          "source_reference_unavailable",
          "an exact source reference is unavailable",
        );
      }
      authorized.push(Object.freeze({ source, stamp: decision.stamp }));
    }
    return Object.freeze({
      kind: "authorized",
      sources: Object.freeze(authorized),
    });
  }

  async #reauthorizeSourceReferences(
    actor: Extract<ActorContext, { readonly kind: "registered_principal" }>,
    transaction: ContentCommitMetadataTransaction,
    sources: readonly Readonly<AuthorizedSourceReference>[],
  ): Promise<Extract<CommitChangesetResult, { readonly kind: "denied" | "invalid" }> | null> {
    if (sources.length === 0) return null;
    const usage = await transaction.readPrincipalMindUsage(actor.principalId);
    for (const source of sources) {
      if (!usage?.entries.some((entry) => entry.spaceId === source.source.spaceId)) {
        return Object.freeze({
          kind: "denied",
          decision: Object.freeze({
            kind: "denied" as const,
            code: "access_denied" as const,
            retryable: false,
          }),
        });
      }
      const decision = await this.#authorizer.reauthorizeInTransaction(
        {
          actor,
          spaceId: source.source.spaceId,
          capability: "content:fetch",
          revisionMode: "historical",
        },
        transaction,
        source.stamp,
      );
      if (decision.kind === "denied") {
        return Object.freeze({ kind: "denied", decision });
      }
      const envelope = await transaction.readRevision(
        source.source.spaceId,
        source.source.revisionId,
      );
      if (
        envelope === null ||
        !envelope.manifest.entries.some(
          (entry) => entry.path === source.source.path,
        )
      ) {
        return invalid(
          "source_reference_unavailable",
          "an exact source reference is unavailable",
        );
      }
    }
    return null;
  }

  async #resolveIdempotency(
    transaction: ContentCommitMetadataTransaction,
    namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "commit_changeset" }
    >,
    canonicalRequestHash: Sha256Digest,
  ): Promise<
    | { readonly kind: "missing" }
    | { readonly kind: "idempotency_conflict" }
    | Extract<CommitChangesetResult, { readonly kind: "committed" }>
  > {
    const checked = await transaction.checkIdempotency({
      namespace,
      canonicalRequestHash,
    });
    if (checked.kind === "missing") return checked;
    if (checked.kind === "conflict") {
      return Object.freeze({ kind: "idempotency_conflict" });
    }
    if (
      checked.record.operation !== "commit_changeset" ||
      checked.record.result.kind !== "commit_changeset"
    ) {
      throw new ChangesetCommitFailure(
        "invalid_idempotency_result",
        "commit_changeset namespace resolved to a different typed result",
      );
    }
    const envelope = await transaction.readRevision(
      namespace.spaceId,
      checked.record.result.revisionId,
    );
    if (envelope === null) {
      throw new ChangesetCommitFailure(
        "invalid_idempotency_result",
        "completed idempotency result does not resolve to its immutable revision",
      );
    }
    return Object.freeze({
      kind: "committed",
      previousRevisionId: checked.record.result.previousRevisionId,
      envelope,
      replayed: true,
    });
  }
}
