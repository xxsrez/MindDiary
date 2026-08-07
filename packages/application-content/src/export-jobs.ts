import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  AuthorizationDecision,
  Clock,
  ExportJobIdGenerator,
  ExportJobStore,
  ExportStartTransaction,
  IdempotencyNamespace,
  ObjectStore,
} from "@mind-diary/application-ports";
import {
  version,
  utcInstant,
  type ExportJob,
  type IdempotencyKey,
  type JobId,
  type RevisionId,
  type RevisionMode,
  type Sha256Digest,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";
import {
  DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
  normalizeIdempotencyKeyMaxBytes,
  validateIdempotencyKey,
} from "./idempotency.js";

export const DEFAULT_EXPORT_JOB_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_EXPORT_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type ExportRevisionSelector =
  | { readonly kind: "head" }
  | { readonly kind: "revision"; readonly revisionId: RevisionId }
  | { readonly kind: "as_of"; readonly asOf: UtcInstant };

export interface StartExportRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly revisionSelector?: unknown;
  readonly idempotencyKey: unknown;
}

export interface SafeExportArchiveMetadata {
  readonly archiveFormat: "MD-OKF-ZIP-1";
  readonly mediaType: "application/zip";
  readonly filename: "mind-diary-okf-bundle.zip";
  readonly contentDisposition: 'attachment; filename="mind-diary-okf-bundle.zip"';
  readonly sha256: Sha256Digest;
  readonly size: number;
}

export interface SafeExportJobStatus {
  readonly jobId: JobId;
  readonly status: ExportJob["state"];
  readonly revisionId: RevisionId;
  readonly attempts: number;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly completedAt: UtcInstant | null;
  readonly lastFailureCode: string | null;
  readonly archiveCleanedAt: UtcInstant | null;
  /** Never includes archive bytes, object keys, download URLs or grants. */
  readonly archive: Readonly<SafeExportArchiveMetadata> | null;
}

export type StartExportResult =
  | {
      readonly kind: "started";
      readonly job: Readonly<SafeExportJobStatus>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "denied";
      readonly decision: Extract<AuthorizationDecision, { readonly kind: "denied" }>;
    }
  | { readonly kind: "invalid"; readonly code: string; readonly message: string }
  | { readonly kind: "revision_not_found" | "idempotency_conflict" };

export type GetExportStatusResult =
  | { readonly kind: "found"; readonly job: Readonly<SafeExportJobStatus> }
  | { readonly kind: "not_found" };

export class ExportJobInvariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExportJobInvariantError";
  }
}

interface ParsedStart {
  readonly selector: Readonly<ExportRevisionSelector>;
  readonly revisionMode: RevisionMode;
  readonly idempotencyKey: IdempotencyKey;
}

const ENCODER = new TextEncoder();
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(code: string, message: string): StartExportResult {
  return Object.freeze({ kind: "invalid", code, message });
}

function parseSelector(value: unknown): Readonly<ExportRevisionSelector> | null {
  if (value === undefined) return Object.freeze({ kind: "head" });
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const keys = Object.keys(value).sort();
  if (value.kind === "head" && keys.length === 1 && keys[0] === "kind") {
    return Object.freeze({ kind: "head" });
  }
  if (
    value.kind === "revision" &&
    keys.length === 2 &&
    keys[0] === "kind" &&
    keys[1] === "revisionId" &&
    typeof value.revisionId === "string" &&
    value.revisionId.length > 0 &&
    value.revisionId.length <= 512 &&
    !CONTROL_CHARACTER.test(value.revisionId)
  ) {
    return Object.freeze({
      kind: "revision",
      revisionId: value.revisionId as RevisionId,
    });
  }
  if (
    value.kind === "as_of" &&
    keys.length === 2 &&
    keys[0] === "asOf" &&
    keys[1] === "kind" &&
    typeof value.asOf === "string"
  ) {
    try {
      return Object.freeze({ kind: "as_of", asOf: utcInstant(value.asOf) });
    } catch {
      return null;
    }
  }
  return null;
}

function canonicalSelector(selector: Readonly<ExportRevisionSelector>): object {
  switch (selector.kind) {
    case "head":
      return { kind: "head" };
    case "revision":
      return { kind: "revision", revision_id: selector.revisionId };
    case "as_of":
      return { kind: "as_of", as_of: selector.asOf };
  }
}

function addMilliseconds(now: UtcInstant, durationMs: number): UtcInstant {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new ExportJobInvariantError("invalid_clock", "export clock returned invalid UTC");
  }
  return new Date(timestamp + durationMs).toISOString() as UtcInstant;
}

function safeStatus(job: Readonly<ExportJob>): Readonly<SafeExportJobStatus> {
  const archive =
    job.state === "succeeded" && job.archive !== null
      ? Object.freeze({
          archiveFormat: job.archive.archiveFormat,
          mediaType: job.archive.mediaType,
          filename: job.archive.filename,
          contentDisposition: job.archive.contentDisposition,
          sha256: job.archive.sha256,
          size: job.archive.size,
        })
      : null;
  return Object.freeze({
    jobId: job.jobId,
    status: job.state,
    revisionId: job.revisionId,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    completedAt: job.completedAt,
    lastFailureCode: job.lastFailureCode,
    archiveCleanedAt: job.archiveCleanedAt,
    archive,
  });
}

export class ExportJobApplicationService {
  readonly #authorizer: Authorizer;
  readonly #metadata: ExportJobStore;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #clock: Clock;
  readonly #jobIds: ExportJobIdGenerator;
  readonly #retentionMs: number;
  readonly #idempotencyKeyMaxBytes: number;

  constructor(dependencies: {
    readonly authorizer: Authorizer;
    readonly metadata: ExportJobStore;
    readonly digest: Pick<ObjectStore, "calculateSha256">;
    readonly clock: Clock;
    readonly jobIds: ExportJobIdGenerator;
    readonly retentionMs?: number;
    readonly idempotencyKeyMaxBytes?: number;
  }) {
    this.#authorizer = dependencies.authorizer;
    this.#metadata = dependencies.metadata;
    this.#digest = dependencies.digest;
    this.#clock = dependencies.clock;
    this.#jobIds = dependencies.jobIds;
    this.#retentionMs = dependencies.retentionMs ?? DEFAULT_EXPORT_JOB_RETENTION_MS;
    if (
      !Number.isSafeInteger(this.#retentionMs) ||
      this.#retentionMs < 1 ||
      this.#retentionMs > MAX_EXPORT_JOB_RETENTION_MS
    ) {
      throw new TypeError("export retention must be a positive bounded duration");
    }
    this.#idempotencyKeyMaxBytes = normalizeIdempotencyKeyMaxBytes(
      dependencies.idempotencyKeyMaxBytes ?? DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
    );
  }

  async start(request: StartExportRequest): Promise<StartExportResult> {
    const parsed = this.#parseStart(request);
    if ("kind" in parsed) return parsed;
    const initial = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:export",
      revisionMode: parsed.revisionMode,
    });
    if (initial.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initial });
    }
    if (request.actor.kind !== "registered_principal") {
      throw new ExportJobInvariantError(
        "invalid_actor",
        "an authorized export request must belong to a registered principal",
      );
    }
    const actor = request.actor;
    const canonicalRequestHash = await this.#digest.calculateSha256(
      ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-start-export-request-v1",
        revision_selector: canonicalSelector(parsed.selector),
      })}\n`),
    );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "start_export" }
    > = Object.freeze({
      principalId: actor.principalId,
      spaceId: request.spaceId,
      operation: "start_export",
      key: parsed.idempotencyKey,
    });
    const createdAt = this.#clock.now();
    const jobId = this.#jobIds.nextExportJobId();

    return this.#metadata.runExportStartTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction(
        {
          actor,
          spaceId: request.spaceId,
          capability: "content:export",
          revisionMode: parsed.revisionMode,
        },
        transaction,
        initial.stamp,
      );
      if (current.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: current });
      }
      const checked = await transaction.checkIdempotency({
        namespace,
        canonicalRequestHash,
      });
      if (checked.kind === "conflict") {
        return Object.freeze({ kind: "idempotency_conflict" });
      }
      if (checked.kind === "replay") {
        const result = checked.record.result;
        if (result.kind !== "start_export") {
          throw new ExportJobInvariantError(
            "invalid_idempotency_result",
            "start_export namespace resolved to another operation",
          );
        }
        const replayed = await transaction.readExportJob(result.jobId);
        if (
          replayed === null ||
          replayed.spaceId !== request.spaceId ||
          replayed.revisionId !== result.revisionId ||
          replayed.requestedByPrincipalId !== actor.principalId
        ) {
          throw new ExportJobInvariantError(
            "invalid_idempotency_result",
            "start_export result does not resolve to its durable job",
          );
        }
        return Object.freeze({
          kind: "started",
          job: safeStatus(replayed),
          replayed: true,
        });
      }

      const revisionId = await this.#resolveRevision(transaction, request.spaceId, parsed.selector);
      if (revisionId === null) return Object.freeze({ kind: "revision_not_found" });
      const job: Readonly<ExportJob> = Object.freeze({
        jobId,
        requestedByPrincipalId: actor.principalId,
        spaceId: request.spaceId,
        revisionId,
        idempotencyKey: parsed.idempotencyKey,
        state: "queued",
        version: version(1),
        attempts: 0,
        availableAt: createdAt,
        claimExpiresAt: null,
        expiresAt: addMilliseconds(createdAt, this.#retentionMs),
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        lastFailureCode: null,
        archive: null,
        archiveCleanedAt: null,
      });
      const created = await transaction.createExportJob(job);
      if (created.kind !== "created") {
        throw new ExportJobInvariantError(
          created.kind,
          "export metadata rejected a new durable job",
        );
      }
      const completed = await transaction.completeIdempotency({
        namespace,
        canonicalRequestHash,
        result: Object.freeze({ kind: "start_export", jobId, revisionId }),
        completedAt: createdAt,
      });
      if (completed.kind !== "completed") {
        throw new ExportJobInvariantError(
          "invalid_idempotency_state",
          "start_export idempotency changed inside its transaction",
        );
      }
      return Object.freeze({
        kind: "started",
        job: safeStatus(created.job),
        replayed: false,
      });
    });
  }

  async getStatus(request: {
    readonly actor: ActorContext;
    readonly jobId: JobId;
  }): Promise<GetExportStatusResult> {
    if (typeof request.jobId !== "string" || request.jobId.length === 0) {
      return Object.freeze({ kind: "not_found" });
    }
    const job = await this.#metadata.readExportJob(request.jobId);
    if (job === null) return Object.freeze({ kind: "not_found" });
    const authorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: job.spaceId,
      capability: "content:export",
      revisionMode: "historical",
    });
    if (authorization.kind === "denied") {
      return Object.freeze({ kind: "not_found" });
    }
    return Object.freeze({ kind: "found", job: safeStatus(job) });
  }

  #parseStart(request: StartExportRequest): ParsedStart | StartExportResult {
    const selector = parseSelector(request.revisionSelector);
    if (selector === null) {
      return invalid("invalid_revision_selector", "revision selector is invalid");
    }
    const key = validateIdempotencyKey(
      request.idempotencyKey,
      this.#idempotencyKeyMaxBytes,
    );
    if (key.kind === "invalid") {
      return invalid("invalid_idempotency_key", "idempotency key is invalid");
    }
    return Object.freeze({
      selector,
      revisionMode: selector.kind === "head" ? "head" : "historical",
      idempotencyKey: key.key,
    });
  }

  async #resolveRevision(
    transaction: ExportStartTransaction,
    spaceId: SpaceId,
    selector: Readonly<ExportRevisionSelector>,
  ): Promise<RevisionId | null> {
    if (selector.kind === "head") return transaction.readHead(spaceId);
    if (selector.kind === "revision") {
      const revision = await transaction.readRevision(spaceId, selector.revisionId);
      return revision?.revision.revisionId ?? null;
    }
    const requestedAt = Date.parse(selector.asOf);
    const revisions = await transaction.listRevisions(spaceId);
    let selected: RevisionId | null = null;
    let selectedNumber = -1;
    for (const envelope of revisions) {
      if (
        Date.parse(envelope.revision.committedAt) <= requestedAt &&
        envelope.revision.revisionNumber > selectedNumber
      ) {
        selected = envelope.revision.revisionId;
        selectedNumber = envelope.revision.revisionNumber;
      }
    }
    return selected;
  }
}
