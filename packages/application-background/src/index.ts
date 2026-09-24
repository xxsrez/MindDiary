import type { ActorContext } from "@mind-diary/application-contracts";
import { OBJECT_CLEANUP_NAMESPACES } from "@mind-diary/application-ports";
import type {
  AuditSink,
  BackgroundAuthorizer,
  BackgroundWorkStore,
  BoundedObjectCleanupStore,
  BundleFileStagingStore,
  CanonicalObjectReachabilityReader,
  Clock,
  ExportArchiveStore,
  ExportJobStore,
  InvitationExpiryJobStore,
  PilotCohort,
  PrivacySafeObservabilityEvent,
  PrivacySafeObservabilitySink,
  SearchIndex,
  SpaceTargetRecordPurger,
  SpaceTargetPurgeResult,
  ObjectCleanupCandidate,
  ObjectCleanupCheckpointStore,
  ObjectCleanupNamespace,
} from "@mind-diary/application-ports";
import type {
  CanonicalRevisionEnvelope,
  JobId,
  OutboxMessageId,
  PrincipalId,
  RevisionId,
  RevisionIndexState,
  Sha256Digest,
  SpaceId,
  UtcInstant,
  Version,
} from "@mind-diary/domain";
import { parseOkfFile, type OkfBundleFixture } from "@mind-diary/okf-codec";

export const BACKGROUND_HANDLERS = [
  "rebuild_revision_index",
  "complete_export",
  "collect_unreachable_objects",
  "deliver_audit_outbox",
  "expire_invitations",
  "expire_export_grants",
  "continue_deletion",
] as const;

function recordBackgroundMetric(
  sink: PrivacySafeObservabilitySink,
  event: Readonly<PrivacySafeObservabilityEvent>,
): void {
  try {
    const pending = sink.record(Object.freeze(event));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Background telemetry is best-effort and cannot affect durable jobs.
  }
}

/** Safe job/cost boundary: job correlation is opaque and payload-free. */
export class BackgroundPrivacySafeObservability {
  readonly #sink: PrivacySafeObservabilitySink;
  readonly #cohort: PilotCohort;

  constructor(dependencies: {
    readonly sink: PrivacySafeObservabilitySink;
    readonly cohort: PilotCohort;
  }) {
    this.#sink = dependencies.sink;
    this.#cohort = dependencies.cohort;
  }

  recordJob(event: {
    readonly actor: Pick<ActorContext, "requestId">;
    readonly jobId: JobId;
    readonly occurredAtUtc: UtcInstant;
    readonly job: "revision_index" | "export";
    readonly outcome: "success" | "failure" | "retry" | "unavailable" | "unresolved";
    readonly lagMs: number;
  }): void {
    recordBackgroundMetric(this.#sink, {
      kind: "operational",
      metric: event.job === "revision_index" ? "index_lag_ms" : "export_lag_ms",
      surface: "background",
      operation: event.job,
      outcome: event.outcome,
      unit: "milliseconds",
      value: event.lagMs,
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: event.jobId,
      cohort: null,
    });
  }

  recordCost(event: {
    readonly actor: Pick<ActorContext, "requestId">;
    readonly jobId: JobId;
    readonly occurredAtUtc: UtcInstant;
    readonly metric: "storage_cost_bytes" | "query_cost_units";
    readonly value: number;
  }): void {
    recordBackgroundMetric(this.#sink, {
      kind: "operational",
      metric: event.metric,
      surface: "background",
      operation: event.metric === "storage_cost_bytes" ? "storage" : "search",
      outcome: "success",
      unit: event.metric === "storage_cost_bytes" ? "bytes" : "query_units",
      value: event.value,
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: event.jobId,
      cohort: null,
    });
  }

  recordExportUsage(event: {
    readonly actor: Pick<ActorContext, "requestId">;
    readonly jobId: JobId;
    readonly occurredAtUtc: UtcInstant;
    readonly count: number;
  }): void {
    recordBackgroundMetric(this.#sink, {
      kind: "pilot",
      metric: "usage",
      surface: "background",
      operation: "export",
      outcome: "completed",
      unit: "count",
      value: event.count,
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: event.jobId,
      cohort: this.#cohort,
    });
  }

  recordInvitationExpiry(event: {
    readonly actor: Pick<ActorContext, "requestId">;
    readonly jobId: JobId;
    readonly occurredAtUtc: UtcInstant;
    readonly outcome:
      | "due"
      | "claimed"
      | "completed"
      | "retried"
      | "unavailable"
      | "resolved";
    readonly lagMs: number | null;
  }): void {
    recordBackgroundMetric(this.#sink, {
      kind: "operational",
      metric: "invitation_outcome",
      surface: "background",
      operation: "invitation",
      outcome: event.outcome,
      unit: "count",
      value: 1,
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: event.jobId,
      cohort: null,
    });
    if (event.lagMs === null) return;
    recordBackgroundMetric(this.#sink, {
      kind: "operational",
      metric: "invitation_expiry_lag_ms",
      surface: "background",
      operation: "invitation",
      outcome: event.outcome,
      unit: "milliseconds",
      value: Math.max(0, event.lagMs),
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: event.jobId,
      cohort: null,
    });
  }

  recordCleanup(event: {
    readonly actor: Pick<ActorContext, "requestId">;
    readonly occurredAtUtc: UtcInstant;
    readonly outcome: "success" | "failure" | "retry" | "unavailable";
    readonly queueAgeMs: number;
    readonly reclaimedBytes: number;
    readonly orphanCount: number;
    readonly retries: number;
    readonly failures: number;
  }): void {
    const values = Object.freeze([
      ["cleanup_queue_age_ms", "milliseconds", event.queueAgeMs],
      ["cleanup_reclaimed_bytes", "bytes", event.reclaimedBytes],
      ["cleanup_orphan_count", "count", event.orphanCount],
      ["cleanup_retry_count", "count", event.retries],
      ["cleanup_failure_count", "count", event.failures],
    ] as const);
    for (const [metric, unit, value] of values) recordBackgroundMetric(this.#sink, {
      kind: "operational",
      metric,
      surface: "background",
      operation: "cleanup",
      outcome: event.outcome,
      unit,
      value,
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: null,
      cohort: null,
    });
  }

  recordRecoveryStage(event: {
    readonly actor: Pick<ActorContext, "requestId">;
    readonly occurredAtUtc: UtcInstant;
    readonly stage:
      | "recovery_index_gaps"
      | "recovery_index_dispatch"
      | "recovery_invitation_expiry_dispatch"
      | "recovery_export_expiry_dispatch"
      | "recovery_export_dispatch"
      | "recovery_staging_cleanup"
      | "recovery_import_cleanup"
      | "recovery_object_cleanup"
      | "recovery_total";
    readonly outcome: "success" | "failure";
    readonly durationMs: number;
  }): void {
    recordBackgroundMetric(this.#sink, {
      kind: "operational",
      metric: "request_latency_ms",
      surface: "background",
      operation: event.stage,
      outcome: event.outcome,
      unit: "milliseconds",
      value: Math.max(0, event.durationMs),
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: null,
      cohort: null,
    });
  }
}

export type ServiceActorContext = Extract<ActorContext, { kind: "service" }>;

export interface ExactRevisionMaterialization {
  readonly envelope: {
    readonly revision: {
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
    };
  };
  readonly files: readonly {
    readonly path: string;
    readonly kind?: "markdown" | "opaque";
    readonly text?: string;
  }[];
}

export interface ExactRevisionMaterializer {
  materialize(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<ExactRevisionMaterialization>>;
  /** Optional selective reader used to reject opaque entries before object bytes are loaded. */
  readRevisionEnvelope?(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope>>;
  readRevisionFile?(
    spaceId: SpaceId,
    revisionId: RevisionId,
    path: string,
  ): Promise<Readonly<{
    readonly kind: "markdown" | "opaque";
    readonly path: string;
    readonly mediaType: string;
    readonly sha256: Sha256Digest;
    readonly size: number;
    readonly text?: string;
  }> | null>;
  openRevisionSession?(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<{
    readonly envelope: Readonly<CanonicalRevisionEnvelope>;
    readRevisionFile(path: string): Promise<Readonly<{
      readonly kind: "markdown" | "opaque";
      readonly path: string;
      readonly mediaType: string;
      readonly sha256: Sha256Digest;
      readonly size: number;
      readonly text?: string;
    }> | null>;
  }>>;
}

export interface UnreachableObjectCollector {
  collectUnreachableObjects(request: {
    readonly createdBefore: UtcInstant | string;
    readonly limit: number;
  }): Promise<{
    readonly scanned: number;
    readonly deleted: number;
    readonly deletedDigests: readonly Sha256Digest[];
  }>;
}

export type BackgroundHandleResult =
  | { readonly kind: "completed" | "already_completed" | "not_available" }
  | { readonly kind: "not_found" }
  | { readonly kind: "failed"; readonly failureCode: string };

function assertServiceActor(actor: ActorContext): asserts actor is ServiceActorContext {
  if (
    actor.kind !== "service" ||
    typeof actor.serviceId !== "string" ||
    actor.serviceId.length === 0
  ) {
    throw new TypeError("background handlers require a trusted service ActorContext");
  }
}

function retryAt(now: UtcInstant, retryDelayMs: number): UtcInstant {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new TypeError("background clock returned invalid UTC");
  return new Date(timestamp + retryDelayMs).toISOString() as UtcInstant;
}

export const DEFAULT_BACKGROUND_CLAIM_LEASE_MS = 30_000;
export const MAX_BACKGROUND_CLAIM_LEASE_MS = 5 * 60 * 1_000;
export const DEFAULT_EXPORT_CLAIM_LEASE_MS = MAX_BACKGROUND_CLAIM_LEASE_MS;
export const DEFAULT_INDEX_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_INDEX_RETRY_MAX_DELAY_MS = 30_000;
export const DEFAULT_INDEX_RETRY_MAX_ATTEMPTS = 5;
export const DEFAULT_INDEX_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function boundedDuration(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive bounded millisecond duration`);
  }
  return value;
}

function mapClaim(kind: "not_found" | "not_available" | "completed"): BackgroundHandleResult {
  return kind === "completed"
    ? Object.freeze({ kind: "already_completed" })
    : Object.freeze({ kind });
}

function searchFields(path: string, text: string) {
  const parsed = parseOkfFile({ path, text });
  if (!parsed.valid || parsed.file === null) throw new ExactRevisionMismatchError();
  const frontmatter = parsed.file.kind === "concept" || parsed.file.kind === "index"
    ? parsed.file.frontmatter
    : null;
  const defaultTitle = (path.split("/").at(-1) ?? path).replace(/\.md$/u, "");
  const explicitTitle = frontmatter !== null && typeof frontmatter.title === "string" &&
      frontmatter.title.trim().length > 0
    ? frontmatter.title.trim()
    : null;
  const title = explicitTitle
    ? explicitTitle
    : defaultTitle;
  const description = frontmatter !== null &&
      typeof frontmatter.description === "string" &&
      frontmatter.description.trim().length > 0
    ? [frontmatter.description.trim()]
    : [];
  const tags = frontmatter !== null && Array.isArray(frontmatter.tags) &&
      frontmatter.tags.every((tag) => typeof tag === "string")
    ? frontmatter.tags as string[]
    : [];
  const source = parsed.file.kind === "log" ? parsed.file.sourceText : parsed.file.body;
  const headings: string[] = [];
  const body: string[] = [];
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match?.[1] !== undefined) headings.push(match[1].trim());
    else body.push(line);
  }
  return Object.freeze({
    titleDerivedFromPath: explicitTitle === null,
    fields: Object.freeze({
      title: Object.freeze([title]),
      description: Object.freeze(description),
      tags: Object.freeze([...tags]),
      headings: Object.freeze(headings),
      body: Object.freeze([body.join("\n")]),
    }),
  });
}

export class RevisionIndexJobHandler {
  readonly #work: BackgroundWorkStore;
  readonly #revisions: ExactRevisionMaterializer;
  readonly #index: SearchIndex;
  readonly #clock: Clock;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #retryMaxAttempts: number;
  readonly #retryMaxAgeMs: number;
  readonly #claimLeaseMs: number;

  constructor(dependencies: {
    readonly work: BackgroundWorkStore;
    readonly revisions: ExactRevisionMaterializer;
    readonly index: SearchIndex;
    readonly clock: Clock;
    readonly retryDelayMs?: number;
    readonly maxRetryDelayMs?: number;
    readonly maxAttempts?: number;
    readonly maxAgeMs?: number;
    readonly claimLeaseMs?: number;
  }) {
    this.#work = dependencies.work;
    this.#revisions = dependencies.revisions;
    this.#index = dependencies.index;
    this.#clock = dependencies.clock;
    this.#retryBaseDelayMs = boundedDuration(
      dependencies.retryDelayMs ?? DEFAULT_INDEX_RETRY_BASE_DELAY_MS,
      "index retry delay",
      24 * 60 * 60 * 1_000,
    );
    this.#retryMaxDelayMs = boundedDuration(
      dependencies.maxRetryDelayMs ?? DEFAULT_INDEX_RETRY_MAX_DELAY_MS,
      "index maximum retry delay",
      24 * 60 * 60 * 1_000,
    );
    if (this.#retryMaxDelayMs < this.#retryBaseDelayMs) {
      throw new TypeError("index maximum retry delay cannot be less than the base delay");
    }
    this.#retryMaxAttempts = dependencies.maxAttempts ?? DEFAULT_INDEX_RETRY_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(this.#retryMaxAttempts) ||
        this.#retryMaxAttempts < 1 ||
        this.#retryMaxAttempts > DEFAULT_INDEX_RETRY_MAX_ATTEMPTS) {
      throw new TypeError("index retry attempt limit must be between one and five");
    }
    this.#retryMaxAgeMs = boundedDuration(
      dependencies.maxAgeMs ?? DEFAULT_INDEX_RETRY_MAX_AGE_MS,
      "index retry age limit",
      30 * 24 * 60 * 60 * 1_000,
    );
    this.#claimLeaseMs = boundedDuration(
      dependencies.claimLeaseMs ?? DEFAULT_BACKGROUND_CLAIM_LEASE_MS,
      "index claim lease",
      MAX_BACKGROUND_CLAIM_LEASE_MS,
    );
  }

  async handle(request: {
    readonly actor: ActorContext;
    readonly jobId: JobId;
  }): Promise<BackgroundHandleResult> {
    assertServiceActor(request.actor);
    const claimedAt = this.#clock.now();
    const claim = await this.#work.claimIndexJob(
      request.jobId,
      claimedAt,
      retryAt(claimedAt, this.#claimLeaseMs),
    );
    if (claim.kind !== "claimed") return mapClaim(claim.kind);
    const target = claim.job.target;
    if (target.kind !== "revision_index") {
      return Object.freeze({ kind: "not_found" });
    }
    const claimedAtMs = Date.parse(claimedAt);
    const createdAtMs = Date.parse(claim.job.createdAt);
    if (!Number.isFinite(createdAtMs) || claimedAtMs - createdAtMs >= this.#retryMaxAgeMs) {
      const failedAt = this.#clock.now();
      const persisted = await this.#work.failIndexJob(
        request.jobId,
        claim.job.version,
        "index_retry_age_limit",
        failedAt,
        failedAt,
      );
      return persisted
        ? Object.freeze({ kind: "failed", failureCode: "index_retry_age_limit" })
        : Object.freeze({ kind: "not_available" });
    }
    try {
      const projection = typeof this.#revisions.readRevisionEnvelope === "function" &&
          typeof this.#revisions.readRevisionFile === "function"
        ? await this.#readIndexableFiles(target.spaceId, target.revisionId)
        : await this.#materializeIndexableFiles(target.spaceId, target.revisionId);
      await this.#index.replaceExactRevision({
        spaceId: target.spaceId,
        revisionId: target.revisionId,
        ...(projection.entries === undefined ? {} : { entries: projection.entries }),
        documents: projection.documents,
      });
      const completed = await this.#work.completeIndexJob(
        request.jobId,
        claim.job.version,
        this.#clock.now(),
      );
      if (!completed) throw new IndexClaimFencedError();
      return Object.freeze({ kind: "completed" });
    } catch (error) {
      if (error instanceof IndexClaimFencedError) {
        return Object.freeze({ kind: "not_available" });
      }
      const failedAt = this.#clock.now();
      const failedAtMs = Date.parse(failedAt);
      const terminalByAge = !Number.isFinite(failedAtMs) ||
        failedAtMs - createdAtMs >= this.#retryMaxAgeMs;
      const failureCode = terminalByAge
        ? "index_retry_age_limit"
        : claim.job.attempts >= this.#retryMaxAttempts
          ? "index_retry_attempt_limit"
          : error instanceof ExactRevisionMismatchError
            ? "exact_revision_mismatch"
            : "index_rebuild_failed";
      const retryDelayMs = Math.min(
        this.#retryMaxDelayMs,
        this.#retryBaseDelayMs * (2 ** Math.max(0, claim.job.attempts - 1)),
      );
      const persisted = await this.#work.failIndexJob(
        request.jobId,
        claim.job.version,
        failureCode,
        failedAt,
        failureCode === "index_retry_attempt_limit" || failureCode === "index_retry_age_limit"
          ? failedAt
          : retryAt(failedAt, retryDelayMs),
      );
      return persisted
        ? Object.freeze({ kind: "failed", failureCode })
        : Object.freeze({ kind: "not_available" });
    }
  }

  async #readIndexableFiles(spaceId: SpaceId, revisionId: RevisionId) {
    const readEnvelope = this.#revisions.readRevisionEnvelope;
    const readFile = this.#revisions.readRevisionFile;
    if (typeof readEnvelope !== "function" || typeof readFile !== "function") {
      throw new TypeError("selective revision reader is incomplete");
    }
    const session = typeof this.#revisions.openRevisionSession === "function"
      ? await this.#revisions.openRevisionSession(spaceId, revisionId)
      : null;
    const envelope = session?.envelope ??
      await readEnvelope.call(this.#revisions, spaceId, revisionId);
    if (
      envelope.revision.spaceId !== spaceId ||
      envelope.revision.revisionId !== revisionId
    ) {
      throw new ExactRevisionMismatchError();
    }
    const entries = envelope.manifest.entries
      .filter((entry) => entry.kind === "markdown")
      .map((entry) => Object.freeze({ path: entry.path, sha256: entry.sha256 }));
    const missing = this.#index.findMissingDigests === undefined
      ? entries.map((entry) => entry.sha256)
      : await this.#index.findMissingDigests(
          spaceId,
          entries.map((entry) => entry.sha256),
        );
    const missingDigests = new Set(missing);
    const documents = [];
    for (const entry of envelope.manifest.entries) {
      if (entry.kind !== "markdown" || !missingDigests.has(entry.sha256)) continue;
      const file = session === null
        ? await readFile.call(this.#revisions, spaceId, revisionId, entry.path)
        : await session.readRevisionFile(entry.path);
      if (
        file === null ||
        file.kind !== "markdown" ||
        file.path !== entry.path ||
        file.sha256 !== entry.sha256 ||
        file.mediaType !== entry.mediaType ||
        file.size !== entry.size ||
        typeof file.text !== "string"
      ) {
        throw new ExactRevisionMismatchError();
      }
      const projection = searchFields(file.path, file.text);
      documents.push(Object.freeze({
        path: file.path,
        text: file.text,
        sha256: file.sha256,
        titleDerivedFromPath: projection.titleDerivedFromPath,
        fields: projection.fields,
      }));
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      documents: Object.freeze(documents),
    });
  }

  async #materializeIndexableFiles(spaceId: SpaceId, revisionId: RevisionId) {
    const materialized = await this.#revisions.materialize(spaceId, revisionId);
    if (
      materialized.envelope.revision.spaceId !== spaceId ||
      materialized.envelope.revision.revisionId !== revisionId
    ) {
      throw new ExactRevisionMismatchError();
    }
    const documents = materialized.files
      .filter(
        (file): file is typeof file & { readonly text: string } =>
          file.kind !== "opaque" && typeof file.text === "string",
      )
      .map((file) => {
        const projection = searchFields(file.path, file.text);
        return Object.freeze({
          path: file.path,
          text: file.text,
          titleDerivedFromPath: projection.titleDerivedFromPath,
          fields: projection.fields,
        });
      });
    return Object.freeze({ entries: undefined, documents: Object.freeze(documents) });
  }
}

class ExactRevisionMismatchError extends Error {}
class IndexClaimFencedError extends Error {}

export class AuditOutboxDeliveryHandler {
  readonly #work: BackgroundWorkStore;
  readonly #audit: AuditSink;
  readonly #clock: Clock;
  readonly #retryDelayMs: number;
  readonly #claimLeaseMs: number;

  constructor(dependencies: {
    readonly work: BackgroundWorkStore;
    readonly audit: AuditSink;
    readonly clock: Clock;
    readonly retryDelayMs?: number;
    readonly claimLeaseMs?: number;
  }) {
    this.#work = dependencies.work;
    this.#audit = dependencies.audit;
    this.#clock = dependencies.clock;
    this.#retryDelayMs = boundedDuration(
      dependencies.retryDelayMs ?? 1_000,
      "audit retry delay",
      24 * 60 * 60 * 1_000,
    );
    this.#claimLeaseMs = boundedDuration(
      dependencies.claimLeaseMs ?? DEFAULT_BACKGROUND_CLAIM_LEASE_MS,
      "audit claim lease",
      MAX_BACKGROUND_CLAIM_LEASE_MS,
    );
  }

  async handle(request: {
    readonly actor: ActorContext;
    readonly outboxMessageId: OutboxMessageId;
  }): Promise<BackgroundHandleResult> {
    assertServiceActor(request.actor);
    const claimedAt = this.#clock.now();
    const claim = await this.#work.claimAuditOutbox(
      request.outboxMessageId,
      claimedAt,
      retryAt(claimedAt, this.#claimLeaseMs),
    );
    if (claim.kind !== "claimed") return mapClaim(claim.kind);
    try {
      await this.#audit.deliver(claim.event);
      const completed = await this.#work.completeAuditOutbox(
        request.outboxMessageId,
        claim.message.version,
        this.#clock.now(),
      );
      if (!completed) throw new Error("audit outbox completion race");
      return Object.freeze({ kind: "completed" });
    } catch {
      const failedAt = this.#clock.now();
      await this.#work.failAuditOutbox(
        request.outboxMessageId,
        claim.message.version,
        failedAt,
        retryAt(failedAt, this.#retryDelayMs),
      );
      return Object.freeze({
        kind: "failed",
        failureCode: "audit_delivery_failed",
      });
    }
  }
}

/** Durable expiry handler; job payload carries only invitation_id. */
export class InvitationExpiryJobHandler {
  readonly #jobs: InvitationExpiryJobStore;
  readonly #clock: Clock;
  readonly #observability: BackgroundPrivacySafeObservability | undefined;
  readonly #retryDelayMs: number;
  readonly #claimLeaseMs: number;

  constructor(dependencies: {
    readonly jobs: InvitationExpiryJobStore;
    readonly clock: Clock;
    readonly retryDelayMs?: number;
    readonly claimLeaseMs?: number;
    readonly observability?: BackgroundPrivacySafeObservability;
  }) {
    this.#jobs = dependencies.jobs;
    this.#clock = dependencies.clock;
    this.#observability = dependencies.observability;
    this.#retryDelayMs = boundedDuration(dependencies.retryDelayMs ?? 1_000, "invitation retry delay", 24 * 60 * 60 * 1_000);
    this.#claimLeaseMs = boundedDuration(dependencies.claimLeaseMs ?? DEFAULT_BACKGROUND_CLAIM_LEASE_MS, "invitation claim lease", MAX_BACKGROUND_CLAIM_LEASE_MS);
  }

  async handle(request: { readonly actor: ActorContext; readonly jobId: JobId }): Promise<BackgroundHandleResult> {
    assertServiceActor(request.actor);
    const claimedAt = this.#clock.now();
    const claim = await this.#jobs.claimInvitationExpiryJob(
      request.jobId,
      claimedAt,
      retryAt(claimedAt, this.#claimLeaseMs),
    );
    if (claim.kind !== "claimed") {
      this.#observability?.recordInvitationExpiry({
        actor: request.actor,
        jobId: request.jobId,
        occurredAtUtc: claimedAt,
        outcome: claim.kind === "not_available" ? "unavailable" : "resolved",
        lagMs: null,
      });
      return mapClaim(claim.kind);
    }
    this.#observability?.recordInvitationExpiry({
      actor: request.actor,
      jobId: request.jobId,
      occurredAtUtc: claimedAt,
      outcome: "claimed",
      lagMs: null,
    });
    try {
      const completed = await this.#jobs.completeInvitationExpiryJob(
        request.jobId,
        claim.job.version,
        this.#clock.now(),
      );
      if (completed.kind === "expired" || completed.kind === "already_terminal") {
        this.#observability?.recordInvitationExpiry({
          actor: request.actor,
          jobId: request.jobId,
          occurredAtUtc: this.#clock.now(),
          outcome: "completed",
          lagMs: null,
        });
        return Object.freeze({ kind: "completed" });
      }
      this.#observability?.recordInvitationExpiry({
        actor: request.actor,
        jobId: request.jobId,
        occurredAtUtc: this.#clock.now(),
        outcome: "unavailable",
        lagMs: null,
      });
      return Object.freeze({ kind: completed.kind });
    } catch {
      const failedAt = this.#clock.now();
      await this.#jobs.failInvitationExpiryJob(
        request.jobId,
        claim.job.version,
        failedAt,
        retryAt(failedAt, this.#retryDelayMs),
      );
      this.#observability?.recordInvitationExpiry({
        actor: request.actor,
        jobId: request.jobId,
        occurredAtUtc: failedAt,
        outcome: "retried",
        lagMs: null,
      });
      return Object.freeze({ kind: "failed", failureCode: "invitation_expiry_failed" });
    }
  }
}

export interface ExposedRevisionIndexStatus {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly status: RevisionIndexState["status"];
  readonly attempts: number;
  readonly lagging: boolean;
  readonly isCurrentHead: boolean;
  readonly lastFailureCode: string | null;
}

export class RevisionIndexStatusService {
  readonly #work: Pick<BackgroundWorkStore, "readRevisionIndexState">;

  constructor(work: Pick<BackgroundWorkStore, "readRevisionIndexState">) {
    this.#work = work;
  }

  async read(request: {
    readonly spaceId: SpaceId;
    readonly revisionId: RevisionId;
    readonly currentHeadRevisionId: RevisionId | null;
  }): Promise<Readonly<ExposedRevisionIndexStatus> | null> {
    const state = await this.#work.readRevisionIndexState(
      request.spaceId,
      request.revisionId,
    );
    if (!state) return null;
    return Object.freeze({
      spaceId: state.spaceId,
      revisionId: state.revisionId,
      status: state.status,
      attempts: state.attempts,
      lagging: state.status !== "ready",
      isCurrentHead: request.currentHeadRevisionId === state.revisionId,
      lastFailureCode: state.lastFailureCode,
    });
  }
}

/** Read gate used after authorization; it never substitutes another revision or HEAD. */
export class ReadyExactRevisionIndexService {
  readonly #work: BackgroundWorkStore;
  readonly #index: SearchIndex;

  constructor(dependencies: {
    readonly work: BackgroundWorkStore;
    readonly index: SearchIndex;
  }) {
    this.#work = dependencies.work;
    this.#index = dependencies.index;
  }

  async read(spaceId: SpaceId, revisionId: RevisionId) {
    const state = await this.#work.readRevisionIndexState(spaceId, revisionId);
    if (!state || state.status !== "ready") {
      return Object.freeze({ kind: "unavailable" as const });
    }
    const indexed = await this.#index.readExactRevision(spaceId, revisionId);
    if (
      indexed.kind !== "ready" ||
      indexed.spaceId !== spaceId ||
      indexed.revisionId !== revisionId
    ) {
      return Object.freeze({ kind: "unavailable" as const });
    }
    return indexed;
  }

  async query(
    spaceId: SpaceId,
    revisionId: RevisionId,
    normalizedTerms: readonly string[],
    page?: Readonly<{ readonly offset: number; readonly limit: number }>,
  ) {
    const state = await this.#work.readRevisionIndexState(spaceId, revisionId);
    if (!state || state.status !== "ready") {
      return Object.freeze({ kind: "unavailable" as const });
    }
    if (this.#index.queryExactRevision === undefined) {
      const indexed = await this.#index.readExactRevision(spaceId, revisionId);
      return indexed.kind === "ready"
        ? Object.freeze({ ...indexed, totalDocuments: indexed.documents.length })
        : indexed;
    }
    const indexed = await this.#index.queryExactRevision(
      spaceId,
      revisionId,
      normalizedTerms,
      page,
    );
    if (
      indexed.kind !== "ready" ||
      indexed.spaceId !== spaceId ||
      indexed.revisionId !== revisionId
    ) {
      return Object.freeze({ kind: "unavailable" as const });
    }
    return indexed;
  }
}

export class UnreachableObjectGcHandler {
  readonly #collector: UnreachableObjectCollector;

  constructor(collector: UnreachableObjectCollector) {
    this.#collector = collector;
  }

  async handle(request: {
    readonly actor: ActorContext;
    readonly createdBefore: UtcInstant | string;
    readonly limit: number;
  }) {
    assertServiceActor(request.actor);
    return this.#collector.collectUnreachableObjects({
      createdBefore: request.createdBefore,
      limit: request.limit,
    });
  }
}

export interface BoundedObjectCleanupResult {
  readonly kind: "completed" | "busy" | "fenced";
  readonly scanned: number;
  readonly examined: number;
  readonly deleted: number;
  readonly reclaimedBytes: number;
  readonly orphanCount: number;
  readonly queueAgeMs: number;
  readonly retries: number;
  readonly failures: number;
  readonly namespace: ObjectCleanupNamespace;
  readonly cursor: string | null;
  readonly cycleCompleted: boolean;
  readonly budgetExhausted: boolean;
}

function cleanupNamespaceAfter(namespace: ObjectCleanupNamespace): ObjectCleanupNamespace | null {
  const index = OBJECT_CLEANUP_NAMESPACES.indexOf(namespace);
  return index < 0 || index === OBJECT_CLEANUP_NAMESPACES.length - 1
    ? null
    : OBJECT_CLEANUP_NAMESPACES[index + 1]!;
}

/** Cursor-paged, lease-fenced GC for canonical, staging and export R2 namespaces. */
export class BoundedObjectCleanupHandler {
  readonly #objects: BoundedObjectCleanupStore &
    Pick<ExportArchiveStore, "hasExportArchivesForJob">;
  readonly #checkpoints: ObjectCleanupCheckpointStore;
  readonly #reachability: CanonicalObjectReachabilityReader;
  readonly #staging: Pick<BundleFileStagingStore, "readStagedBundleFile">;
  readonly #exports: Pick<
    ExportJobStore,
    "readExportJob" | "completeExpiredExportCleanup"
  >;
  readonly #clock: Clock;
  readonly #observability: BackgroundPrivacySafeObservability | null;
  readonly #monotonicNow: () => number;

  constructor(dependencies: {
    readonly objects: BoundedObjectCleanupStore &
      Pick<ExportArchiveStore, "hasExportArchivesForJob">;
    readonly checkpoints: ObjectCleanupCheckpointStore;
    readonly reachability: CanonicalObjectReachabilityReader;
    readonly staging: Pick<BundleFileStagingStore, "readStagedBundleFile">;
    readonly exports: Pick<
      ExportJobStore,
      "readExportJob" | "completeExpiredExportCleanup"
    >;
    readonly clock: Clock;
    readonly observability?: BackgroundPrivacySafeObservability;
    readonly monotonicNow?: () => number;
  }) {
    this.#objects = dependencies.objects;
    this.#checkpoints = dependencies.checkpoints;
    this.#reachability = dependencies.reachability;
    this.#staging = dependencies.staging;
    this.#exports = dependencies.exports;
    this.#clock = dependencies.clock;
    this.#observability = dependencies.observability ?? null;
    this.#monotonicNow = dependencies.monotonicNow ?? Date.now;
  }

  async handle(request: {
    readonly actor: ActorContext;
    readonly createdBefore: UtcInstant | string;
    readonly maxObjects?: number;
    readonly maxBytes?: number;
    readonly maxDurationMs?: number;
  }): Promise<Readonly<BoundedObjectCleanupResult>> {
    assertServiceActor(request.actor);
    const createdBeforeMs = Date.parse(request.createdBefore);
    if (!Number.isFinite(createdBeforeMs)) throw new TypeError("cleanup boundary is invalid");
    const maxObjects = request.maxObjects ?? 100;
    const maxBytes = request.maxBytes ?? 268_435_456;
    const maxDurationMs = request.maxDurationMs ?? 20_000;
    if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 1_000) {
      throw new TypeError("cleanup object budget is invalid");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("cleanup byte budget is invalid");
    }
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60_000) {
      throw new TypeError("cleanup time budget is invalid");
    }
    const startedAt = this.#monotonicNow();
    const now = this.#clock.now();
    const claim = await this.#checkpoints.claimObjectCleanup({
      now,
      leaseExpiresAt: retryAt(now, maxDurationMs + 10_000),
    });
    if (claim.kind === "busy") {
      this.#observability?.recordCleanup({
        actor: request.actor,
        occurredAtUtc: now,
        outcome: "unavailable",
        queueAgeMs: 0,
        reclaimedBytes: 0,
        orphanCount: 0,
        retries: 0,
        failures: 0,
      });
      return Object.freeze({
        kind: "busy",
        scanned: 0,
        examined: 0,
        deleted: 0,
        reclaimedBytes: 0,
        orphanCount: 0,
        queueAgeMs: 0,
        retries: 0,
        failures: 0,
        namespace: "immutable",
        cursor: null,
        cycleCompleted: false,
        budgetExhausted: false,
      });
    }

    const checkpoint = claim.checkpoint;
    let namespace = checkpoint.namespace;
    let cursor = checkpoint.cursor;
    let cycleStartedAt = checkpoint.cycleStartedAt;
    let scanned = 0;
    let examined = 0;
    let deleted = 0;
    let reclaimedBytes = 0;
    let orphanCount = 0;
    let queueAgeMs = 0;
    let cycleCompleted = false;
    let budgetExhausted = false;
    try {
      while (scanned < maxObjects && this.#monotonicNow() - startedAt < maxDurationMs) {
        const page = await this.#objects.listObjectCleanupPage({
          namespace,
          cursor,
          limit: Math.min(16, maxObjects - scanned),
        });
        scanned += page.listed;
        const collectable = await Promise.all(page.candidates.map((candidate) =>
          this.#isCollectable(candidate, now, createdBeforeMs)
        ));
        let pageCompleted = true;
        for (let index = 0; index < page.candidates.length; index += 1) {
          const candidate = page.candidates[index]!;
          if (this.#monotonicNow() - startedAt >= maxDurationMs) {
            budgetExhausted = true;
            pageCompleted = false;
            break;
          }
          examined += 1;
          if (collectable[index]) {
            orphanCount += 1;
            queueAgeMs = Math.max(queueAgeMs, Date.parse(now) - Date.parse(candidate.createdAt));
            if (reclaimedBytes + candidate.size > maxBytes) {
              budgetExhausted = true;
              pageCompleted = false;
              break;
            }
            if (await this.#objects.deleteObjectCleanupCandidate({
              candidate,
              createdBefore: candidate.namespace === "staged_bundle" ||
                  candidate.namespace === "export"
                ? now
                : request.createdBefore as UtcInstant,
            })) {
              deleted += 1;
              reclaimedBytes += candidate.size;
              if (candidate.namespace === "export") {
                await this.#finishExpiredExportIfEmpty(candidate, now);
              }
            }
          }
        }
        if (!pageCompleted) break;
        cursor = page.nextCursor;
        if (cursor === null) {
          const next = cleanupNamespaceAfter(namespace);
          if (next === null) {
            namespace = "immutable";
            cycleStartedAt = this.#clock.now();
            cycleCompleted = true;
            break;
          }
          namespace = next;
        }
      }
      if (
        scanned >= maxObjects || reclaimedBytes >= maxBytes ||
        this.#monotonicNow() - startedAt >= maxDurationMs
      ) budgetExhausted = true;
      const completedAt = this.#clock.now();
      const persisted = await this.#checkpoints.completeObjectCleanupBatch({
        expectedVersion: checkpoint.version,
        namespace,
        cursor,
        cycleStartedAt,
        completedAt,
      });
      const result = Object.freeze({
        kind: persisted ? "completed" as const : "fenced" as const,
        scanned,
        examined,
        deleted,
        reclaimedBytes,
        orphanCount,
        queueAgeMs,
        retries: checkpoint.retries,
        failures: checkpoint.failures,
        namespace,
        cursor,
        cycleCompleted,
        budgetExhausted,
      });
      this.#observability?.recordCleanup({
        actor: request.actor,
        occurredAtUtc: completedAt,
        outcome: persisted ? (claim.reclaimedLease ? "retry" : "success") : "unavailable",
        queueAgeMs,
        reclaimedBytes,
        orphanCount,
        retries: checkpoint.retries,
        failures: checkpoint.failures,
      });
      return result;
    } catch (error) {
      const failedAt = this.#clock.now();
      await this.#checkpoints.failObjectCleanupBatch({
        expectedVersion: checkpoint.version,
        failedAt,
      }).catch(() => false);
      this.#observability?.recordCleanup({
        actor: request.actor,
        occurredAtUtc: failedAt,
        outcome: "failure",
        queueAgeMs,
        reclaimedBytes,
        orphanCount,
        retries: checkpoint.retries,
        failures: checkpoint.failures + 1,
      });
      throw error;
    }
  }

  async #isCollectable(
    candidate: Readonly<ObjectCleanupCandidate>,
    now: UtcInstant,
    canonicalCreatedBeforeMs: number,
  ): Promise<boolean> {
    const oldEnough = Date.parse(candidate.createdAt) < canonicalCreatedBeforeMs;
    if (candidate.namespace === "immutable") {
      return oldEnough && !(await this.#reachability.isImmutableObjectReachable(candidate.sha256));
    }
    if (candidate.namespace === "bundle_file") {
      return oldEnough && !(await this.#reachability.isBundleFileObjectReachable(
        candidate.spaceId,
        candidate.sha256,
      ));
    }
    if (candidate.namespace === "space_canonical") {
      return oldEnough && !(await this.#reachability.isSpaceCanonicalObjectReachable(
        candidate.kind,
        candidate.spaceId,
        candidate.sha256,
      ));
    }
    if (candidate.namespace === "staged_bundle") {
      return oldEnough &&
        (await this.#staging.readStagedBundleFile(candidate.stagedFileId)) === null;
    }
    const job = await this.#exports.readExportJob(candidate.jobId);
    if (job === null) return oldEnough;
    return job.spaceId === candidate.spaceId &&
      (job.archiveCleanedAt !== null || job.state === "expired" ||
        Date.parse(job.expiresAt) <= Date.parse(now));
  }

  async #finishExpiredExportIfEmpty(
    candidate: Extract<ObjectCleanupCandidate, { readonly namespace: "export" }>,
    now: UtcInstant,
  ): Promise<void> {
    if (await this.#objects.hasExportArchivesForJob(candidate.jobId, candidate.spaceId)) return;
    const job = await this.#exports.readExportJob(candidate.jobId);
    if (
      job === null || job.spaceId !== candidate.spaceId || job.state !== "expired" ||
      job.archiveCleanedAt !== null
    ) return;
    await this.#exports.completeExpiredExportCleanup(
      candidate.jobId,
      job.version,
      now,
    );
  }
}

export class SpaceTargetRecordPurgeService {
  readonly #metadata: SpaceTargetRecordPurger;
  readonly #index: SearchIndex;
  readonly #audit: AuditSink;
  readonly #exportArchives: ExportArchiveStore | null;

  constructor(dependencies: {
    readonly metadata: SpaceTargetRecordPurger;
    readonly index: SearchIndex;
    readonly audit: AuditSink;
    readonly exportArchives?: ExportArchiveStore;
  }) {
    this.#metadata = dependencies.metadata;
    this.#index = dependencies.index;
    this.#audit = dependencies.audit;
    this.#exportArchives = dependencies.exportArchives ?? null;
  }

  async purge(request: {
    readonly actor: ActorContext;
    readonly spaceId: SpaceId;
  }): Promise<
    Readonly<
      SpaceTargetPurgeResult & {
        readonly indexedRevisions: number;
        readonly deliveredAuditEvents: number;
        readonly exportArchives: number;
      }
    >
  > {
    assertServiceActor(request.actor);
    const metadata = await this.#metadata.purgeSpaceTargetRecords(request.spaceId);
    const indexedRevisions = await this.#index.purgeSpace(request.spaceId);
    const deliveredAuditEvents = await this.#audit.purgeSpace(request.spaceId);
    const exportArchives = this.#exportArchives === null
      ? 0
      : await this.#exportArchives.deleteExportArchivesForSpace(request.spaceId);
    return Object.freeze({
      ...metadata,
      indexedRevisions,
      deliveredAuditEvents,
      exportArchives,
    });
  }
}

export interface DeterministicExportBuilder {
  exportExactRevision(request: {
    readonly spaceId: SpaceId;
    readonly revisionId: RevisionId;
    readonly profile?: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  }): Promise<{
    readonly revisionId: RevisionId;
    readonly archiveFormat: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
    readonly mediaType: "application/zip";
    readonly filename: "mind-diary-okf-bundle.zip" | "mind-diary-bundle.zip";
    readonly contentDisposition:
      | 'attachment; filename="mind-diary-okf-bundle.zip"'
      | 'attachment; filename="mind-diary-bundle.zip"';
    readonly bytes: Uint8Array;
    readonly sha256: Sha256Digest;
    readonly size: number;
  }>;
  writeExactRevision?(request: {
    readonly spaceId: SpaceId;
    readonly revisionId: RevisionId;
    readonly profile?: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  }, sink: Readonly<{
    write(chunk: Uint8Array): Promise<void>;
  }>, onProgress?: (progress: Readonly<{
    phase: "inspect" | "write";
    completedEntries: number;
    totalEntries: number;
  }>) => void | PromiseLike<void>): Promise<{
    readonly revisionId: RevisionId;
    readonly archiveFormat: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
    readonly mediaType: "application/zip";
    readonly filename: "mind-diary-okf-bundle.zip" | "mind-diary-bundle.zip";
    readonly contentDisposition:
      | 'attachment; filename="mind-diary-okf-bundle.zip"'
      | 'attachment; filename="mind-diary-bundle.zip"';
    readonly sha256: Sha256Digest;
    readonly size: number;
  }>;
}

export type ExportJobProgressStage =
  | "claimed" | "authorized" | "upload_opened"
  | "inspect" | "write" | "archive_built"
  | "archive_stored" | "completed" | "failed";

export type ExportJobProgressEvent = Readonly<{
  jobId: JobId;
  claimVersion: Version;
  stage: ExportJobProgressStage;
  completedEntries: number;
  totalEntries: number;
  failureKind?: "type_error" | "range_error" | "object_error" | "revision_error" | "other_error";
  failureCode?: string;
}>;

const SAFE_EXPORT_FAILURE_CODES = new Set([
  "revision_not_found",
  "revision_integrity_failure",
  "okf_validation_failed",
  "archive_limit_exceeded",
  "export_profile_required",
]);

function isMetadataTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "metadata_queue_timeout" || error.code === "metadata_d1_timeout");
}

function safeExportFailureCode(error: unknown): string {
  if (isMetadataTimeout(error)) return "transient_storage_failure";
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    SAFE_EXPORT_FAILURE_CODES.has(error.code)
  ) {
    return error.code;
  }
  return "export_build_failed";
}

function safeExportFailureDiagnostic(error: unknown): Pick<ExportJobProgressEvent, "failureKind" | "failureCode"> {
  const failureKind = error instanceof TypeError ? "type_error" as const
    : error instanceof RangeError ? "range_error" as const
    : error instanceof Error && error.name === "ObjectStoreFailure" ? "object_error" as const
    : error instanceof Error && (error.name === "CanonicalRevisionError" || error.name === "OkfExportError")
      ? "revision_error" as const
      : "other_error" as const;
  const rawCode = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const failureCode = typeof rawCode === "string" && [
    "digest_collision", "object_read_timeout", "object_tampered", "range_unavailable",
    "object_not_found", "object_integrity_failure", "manifest_integrity_failure",
    "revision_integrity_failure", "okf_validation_failed", "archive_limit_exceeded",
  ].includes(rawCode)
    ? rawCode
    : rawCode === null ? "uncoded" : "other_code";
  return { failureKind, failureCode };
}

/** Lease-fenced durable complete_export handler. */
export class ExportJobHandler {
  readonly #jobs: ExportJobStore;
  readonly #backgroundAuthorizer: BackgroundAuthorizer;
  readonly #builder: DeterministicExportBuilder;
  readonly #archives: ExportArchiveStore;
  readonly #clock: Clock;
  readonly #retryDelayMs: number;
  readonly #claimLeaseMs: number;
  readonly #onProgress: ((event: ExportJobProgressEvent) => void | PromiseLike<void>) | null;

  constructor(dependencies: {
    readonly jobs: ExportJobStore;
    readonly backgroundAuthorizer: BackgroundAuthorizer;
    readonly builder: DeterministicExportBuilder;
    readonly archives: ExportArchiveStore;
    readonly clock: Clock;
    readonly retryDelayMs?: number;
    readonly claimLeaseMs?: number;
    readonly onProgress?: (event: ExportJobProgressEvent) => void | PromiseLike<void>;
  }) {
    this.#jobs = dependencies.jobs;
    this.#backgroundAuthorizer = dependencies.backgroundAuthorizer;
    this.#builder = dependencies.builder;
    this.#archives = dependencies.archives;
    this.#clock = dependencies.clock;
    this.#onProgress = dependencies.onProgress ?? null;
    this.#retryDelayMs = boundedDuration(
      dependencies.retryDelayMs ?? 1_000,
      "export retry delay",
      24 * 60 * 60 * 1_000,
    );
    this.#claimLeaseMs = boundedDuration(
      dependencies.claimLeaseMs ?? DEFAULT_EXPORT_CLAIM_LEASE_MS,
      "export claim lease",
      MAX_BACKGROUND_CLAIM_LEASE_MS,
    );
  }

  async handle(request: {
    readonly actor: ActorContext;
    readonly jobId: JobId;
  }): Promise<BackgroundHandleResult> {
    assertServiceActor(request.actor);
    const claimedAt = this.#clock.now();
    const claim = await this.#jobs.claimExportJob(
      request.jobId,
      claimedAt,
      retryAt(claimedAt, this.#claimLeaseMs),
    );
    if (claim.kind !== "claimed") {
      if (claim.kind === "completed") return Object.freeze({ kind: "already_completed" });
      if (claim.kind === "expired") return Object.freeze({ kind: "not_available" });
      return Object.freeze({ kind: claim.kind });
    }
    const job = claim.job;
    const report = (
      stage: ExportJobProgressStage,
      completedEntries = 0,
      totalEntries = 0,
      diagnostic?: Pick<ExportJobProgressEvent, "failureKind" | "failureCode">,
    ) => {
      try {
        const observation = this.#onProgress?.(Object.freeze({
          jobId: job.jobId,
          claimVersion: job.version,
          stage,
          completedEntries,
          totalEntries,
          ...diagnostic,
        }));
        if (observation !== undefined) void Promise.resolve(observation).catch(() => undefined);
      } catch { /* Diagnostics cannot affect a durable export. */ }
    };
    report("claimed");
    let authorized: boolean;
    try {
      authorized = await this.#authorizeCurrentWithRetry(request.actor, job);
    } catch {
      report("failed");
      return this.#failClaim(job.jobId, job.version, "transient_storage_failure");
    }
    if (!authorized) {
      report("failed");
      return this.#failClaim(job.jobId, job.version, "export_access_denied");
    }
    report("authorized");

    let objectKey: string | null = null;
    let upload: { abort(): Promise<void> } | null = null;
    try {
      const exportRequest = {
        spaceId: job.spaceId,
        revisionId: job.revisionId,
        profile: job.profile ?? "MD-OKF-ZIP-1",
      } as const;
      const expectedBundle = (job.profile ?? "MD-OKF-ZIP-1") === "MD-BUNDLE-ZIP-1";
      let built: Awaited<ReturnType<DeterministicExportBuilder["exportExactRevision"]>> |
        Awaited<ReturnType<NonNullable<DeterministicExportBuilder["writeExactRevision"]>>>;
      let put;
      if (this.#builder.writeExactRevision !== undefined) {
        const streamingUpload = await this.#archives.beginExportArchiveUpload({
          jobId: job.jobId,
          spaceId: job.spaceId,
          claimVersion: job.version,
          archiveFormat: expectedBundle ? "MD-BUNDLE-ZIP-1" : "MD-OKF-ZIP-1",
          filename: expectedBundle ? "mind-diary-bundle.zip" : "mind-diary-okf-bundle.zip",
          contentDisposition: expectedBundle
            ? 'attachment; filename="mind-diary-bundle.zip"'
            : 'attachment; filename="mind-diary-okf-bundle.zip"',
          createdAt: this.#clock.now(),
        });
        upload = streamingUpload;
        report("upload_opened");
        built = await this.#builder.writeExactRevision(exportRequest, {
          write: (chunk) => streamingUpload.write(chunk),
        }, (progress) => report(progress.phase, progress.completedEntries, progress.totalEntries));
        report("archive_built");
        put = await streamingUpload.complete({
          sha256: built.sha256,
          size: built.size,
        });
        upload = null;
      } else {
        const buffered = await this.#builder.exportExactRevision(exportRequest);
        if (!(buffered.bytes instanceof Uint8Array) || buffered.bytes.byteLength !== buffered.size) {
          throw Object.assign(new Error("invalid deterministic export result"), {
            code: "revision_integrity_failure",
          });
        }
        built = buffered;
        report("archive_built");
        put = await this.#archives.putExportArchive({
          jobId: job.jobId,
          spaceId: job.spaceId,
          claimVersion: job.version,
          bytes: buffered.bytes,
          sha256: buffered.sha256,
          archiveFormat: buffered.archiveFormat,
          filename: buffered.filename,
          contentDisposition: buffered.contentDisposition,
          createdAt: this.#clock.now(),
        });
      }
      if (
        built.revisionId !== job.revisionId ||
        built.archiveFormat !== (expectedBundle ? "MD-BUNDLE-ZIP-1" : "MD-OKF-ZIP-1") ||
        built.mediaType !== "application/zip" ||
        built.filename !== (expectedBundle ? "mind-diary-bundle.zip" : "mind-diary-okf-bundle.zip") ||
        built.contentDisposition !==
          (expectedBundle
            ? 'attachment; filename="mind-diary-bundle.zip"'
            : 'attachment; filename="mind-diary-okf-bundle.zip"')
      ) {
        throw Object.assign(new Error("invalid deterministic export result"), {
          code: "revision_integrity_failure",
        });
      }
      if (!("archive" in put)) {
        throw new Error(`export archive object write rejected: ${put.kind}`);
      }
      const storedObjectKey = put.archive.objectKey;
      objectKey = storedObjectKey;
      report("archive_stored");

      // Current access is rebuilt again after the potentially long build.
      if (!(await this.#authorizeCurrentWithRetry(request.actor, job))) {
        await this.#archives.deleteExportArchive(storedObjectKey);
        objectKey = null;
        report("failed");
        return this.#failClaim(job.jobId, job.version, "export_access_denied");
      }
      const completed = await this.#jobs.completeExportJob(
        job.jobId,
        job.version,
        Object.freeze({
          objectKey: put.archive.objectKey,
          archiveFormat: put.archive.archiveFormat,
          mediaType: put.archive.mediaType,
          filename: put.archive.filename,
          contentDisposition: put.archive.contentDisposition,
          sha256: put.archive.sha256,
          size: put.archive.size,
        }),
        this.#clock.now(),
      );
      if (!completed) {
        await this.#archives.deleteExportArchive(storedObjectKey);
        return Object.freeze({ kind: "not_available" });
      }
      report("completed");
      return Object.freeze({ kind: "completed" });
    } catch (error) {
      if (upload !== null) await upload.abort().catch(() => undefined);
      if (objectKey !== null) await this.#archives.deleteExportArchive(objectKey);
      report("failed", 0, 0, safeExportFailureDiagnostic(error));
      return this.#failClaim(
        job.jobId,
        job.version,
        safeExportFailureCode(error),
      );
    }
  }

  async #authorizeCurrent(
    actor: ServiceActorContext,
    job: { readonly requestedByPrincipalId: PrincipalId; readonly spaceId: SpaceId },
  ): Promise<boolean> {
    const decision = await this.#backgroundAuthorizer.authorize({
      actor,
      principalId: job.requestedByPrincipalId,
      spaceId: job.spaceId,
      capability: "content:export",
      revisionMode: "historical",
    });
    return decision.kind === "allowed";
  }

  async #authorizeCurrentWithRetry(
    actor: ServiceActorContext,
    job: { readonly requestedByPrincipalId: PrincipalId; readonly spaceId: SpaceId },
  ): Promise<boolean> {
    try {
      return await this.#authorizeCurrent(actor, job);
    } catch (error) {
      if (!isMetadataTimeout(error)) throw error;
      return this.#authorizeCurrent(actor, job);
    }
  }

  async #failClaim(
    jobId: JobId,
    version: Version,
    failureCode: string,
  ): Promise<BackgroundHandleResult> {
    const fail = () => {
      const failedAt = this.#clock.now();
      return this.#jobs.failExportJob(
        jobId,
        version,
        failureCode,
        failedAt,
        retryAt(failedAt, this.#retryDelayMs),
      );
    };
    let failed: boolean;
    try {
      failed = await fail();
    } catch (error) {
      if (!isMetadataTimeout(error)) throw error;
      failed = await fail();
    }
    return failed
      ? Object.freeze({ kind: "failed", failureCode })
      : Object.freeze({ kind: "not_available" });
  }
}

/** Expiry and object cleanup remain repeatable after service reconstruction. */
export class ExportJobExpiryHandler {
  readonly #jobs: ExportJobStore;
  readonly #archives: ExportArchiveStore;
  readonly #clock: Clock;

  constructor(dependencies: {
    readonly jobs: ExportJobStore;
    readonly archives: ExportArchiveStore;
    readonly clock: Clock;
  }) {
    this.#jobs = dependencies.jobs;
    this.#archives = dependencies.archives;
    this.#clock = dependencies.clock;
  }

  async handle(request: {
    readonly actor: ActorContext;
    readonly jobId: JobId;
  }): Promise<BackgroundHandleResult> {
    assertServiceActor(request.actor);
    const expired = await this.#jobs.expireExportJob(
      request.jobId,
      this.#clock.now(),
    );
    if (expired.kind !== "expired") {
      return Object.freeze({ kind: expired.kind === "not_due" ? "not_available" : "not_found" });
    }
    if (expired.job.archiveCleanedAt !== null) {
      return Object.freeze({ kind: "already_completed" });
    }
    if (await this.#archives.hasExportArchivesForJob(request.jobId, expired.job.spaceId)) {
      // The shared persisted-cursor cleanup owns bounded physical deletion and
      // completes this metadata record after the final per-job object is gone.
      return Object.freeze({ kind: "not_available" });
    }
    const completed = await this.#jobs.completeExpiredExportCleanup(
      request.jobId,
      expired.job.version,
      this.#clock.now(),
    );
    return completed
      ? Object.freeze({ kind: "completed" })
      : Object.freeze({ kind: "not_available" });
  }
}

export interface BackgroundBoundaryMarker {
  readonly actor: ServiceActorContext;
  readonly revisionId?: RevisionId;
  readonly searchIndex: SearchIndex;
  readonly auditSink: AuditSink;
  readonly fixtureOnlyBundle?: OkfBundleFixture;
}
