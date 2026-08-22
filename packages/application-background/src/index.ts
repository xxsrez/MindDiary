import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  AuditSink,
  BackgroundAuthorizer,
  BackgroundWorkStore,
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
} from "@mind-diary/application-ports";
import type {
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
import type { OkfBundleFixture } from "@mind-diary/okf-codec";

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
    readonly outcome: "success" | "failure" | "retry" | "unavailable";
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

export class RevisionIndexJobHandler {
  readonly #work: BackgroundWorkStore;
  readonly #revisions: ExactRevisionMaterializer;
  readonly #index: SearchIndex;
  readonly #clock: Clock;
  readonly #retryDelayMs: number;
  readonly #claimLeaseMs: number;

  constructor(dependencies: {
    readonly work: BackgroundWorkStore;
    readonly revisions: ExactRevisionMaterializer;
    readonly index: SearchIndex;
    readonly clock: Clock;
    readonly retryDelayMs?: number;
    readonly claimLeaseMs?: number;
  }) {
    this.#work = dependencies.work;
    this.#revisions = dependencies.revisions;
    this.#index = dependencies.index;
    this.#clock = dependencies.clock;
    this.#retryDelayMs = boundedDuration(
      dependencies.retryDelayMs ?? 1_000,
      "index retry delay",
      24 * 60 * 60 * 1_000,
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
    try {
      const materialized = await this.#revisions.materialize(
        target.spaceId,
        target.revisionId,
      );
      if (
        materialized.envelope.revision.spaceId !== target.spaceId ||
        materialized.envelope.revision.revisionId !== target.revisionId
      ) {
        throw new ExactRevisionMismatchError();
      }
      await this.#index.replaceExactRevision({
        spaceId: target.spaceId,
        revisionId: target.revisionId,
        documents: materialized.files
          .filter(
            (file): file is typeof file & { readonly text: string } =>
              file.kind !== "opaque" && typeof file.text === "string",
          )
          .map((file) => Object.freeze({ path: file.path, text: file.text })),
      });
      const completed = await this.#work.completeIndexJob(
        request.jobId,
        claim.job.version,
        this.#clock.now(),
      );
      if (!completed) throw new Error("index job completion race");
      return Object.freeze({ kind: "completed" });
    } catch (error) {
      const failedAt = this.#clock.now();
      const failureCode =
        error instanceof ExactRevisionMismatchError
          ? "exact_revision_mismatch"
          : "index_rebuild_failed";
      await this.#work.failIndexJob(
        request.jobId,
        claim.job.version,
        failureCode,
        failedAt,
        retryAt(failedAt, this.#retryDelayMs),
      );
      return Object.freeze({ kind: "failed", failureCode });
    }
  }
}

class ExactRevisionMismatchError extends Error {}

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
  readonly #retryDelayMs: number;
  readonly #claimLeaseMs: number;

  constructor(dependencies: {
    readonly jobs: InvitationExpiryJobStore;
    readonly clock: Clock;
    readonly retryDelayMs?: number;
    readonly claimLeaseMs?: number;
  }) {
    this.#jobs = dependencies.jobs;
    this.#clock = dependencies.clock;
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
    if (claim.kind !== "claimed") return mapClaim(claim.kind);
    try {
      const completed = await this.#jobs.completeInvitationExpiryJob(
        request.jobId,
        claim.job.version,
        this.#clock.now(),
      );
      if (completed.kind === "expired" || completed.kind === "already_terminal") {
        return Object.freeze({ kind: "completed" });
      }
      return Object.freeze({ kind: completed.kind });
    } catch {
      const failedAt = this.#clock.now();
      await this.#jobs.failInvitationExpiryJob(
        request.jobId,
        claim.job.version,
        failedAt,
        retryAt(failedAt, this.#retryDelayMs),
      );
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
  readonly #work: BackgroundWorkStore;

  constructor(work: BackgroundWorkStore) {
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

  async query(spaceId: SpaceId, revisionId: RevisionId, normalizedTerms: readonly string[]) {
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
  }): Promise<{
    readonly revisionId: RevisionId;
    readonly archiveFormat: "MD-OKF-ZIP-1";
    readonly mediaType: "application/zip";
    readonly filename: "mind-diary-okf-bundle.zip";
    readonly contentDisposition: 'attachment; filename="mind-diary-okf-bundle.zip"';
    readonly bytes: Uint8Array;
    readonly sha256: Sha256Digest;
    readonly size: number;
  }>;
}

const SAFE_EXPORT_FAILURE_CODES = new Set([
  "revision_not_found",
  "revision_integrity_failure",
  "okf_validation_failed",
  "archive_limit_exceeded",
]);

function safeExportFailureCode(error: unknown): string {
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

/** Lease-fenced durable complete_export handler. */
export class ExportJobHandler {
  readonly #jobs: ExportJobStore;
  readonly #backgroundAuthorizer: BackgroundAuthorizer;
  readonly #builder: DeterministicExportBuilder;
  readonly #archives: ExportArchiveStore;
  readonly #clock: Clock;
  readonly #retryDelayMs: number;
  readonly #claimLeaseMs: number;

  constructor(dependencies: {
    readonly jobs: ExportJobStore;
    readonly backgroundAuthorizer: BackgroundAuthorizer;
    readonly builder: DeterministicExportBuilder;
    readonly archives: ExportArchiveStore;
    readonly clock: Clock;
    readonly retryDelayMs?: number;
    readonly claimLeaseMs?: number;
  }) {
    this.#jobs = dependencies.jobs;
    this.#backgroundAuthorizer = dependencies.backgroundAuthorizer;
    this.#builder = dependencies.builder;
    this.#archives = dependencies.archives;
    this.#clock = dependencies.clock;
    this.#retryDelayMs = boundedDuration(
      dependencies.retryDelayMs ?? 1_000,
      "export retry delay",
      24 * 60 * 60 * 1_000,
    );
    this.#claimLeaseMs = boundedDuration(
      dependencies.claimLeaseMs ?? DEFAULT_BACKGROUND_CLAIM_LEASE_MS,
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
    const authorized = await this.#authorizeCurrent(request.actor, job);
    if (!authorized) {
      return this.#failClaim(job.jobId, job.version, "export_access_denied");
    }

    let objectKey: string | null = null;
    try {
      const built = await this.#builder.exportExactRevision({
        spaceId: job.spaceId,
        revisionId: job.revisionId,
      });
      if (
        built.revisionId !== job.revisionId ||
        built.archiveFormat !== "MD-OKF-ZIP-1" ||
        built.mediaType !== "application/zip" ||
        built.filename !== "mind-diary-okf-bundle.zip" ||
        built.contentDisposition !==
          'attachment; filename="mind-diary-okf-bundle.zip"' ||
        !(built.bytes instanceof Uint8Array) ||
        built.bytes.byteLength !== built.size
      ) {
        throw Object.assign(new Error("invalid deterministic export result"), {
          code: "revision_integrity_failure",
        });
      }
      const put = await this.#archives.putExportArchive({
        jobId: job.jobId,
        spaceId: job.spaceId,
        claimVersion: job.version,
        bytes: built.bytes,
        sha256: built.sha256,
        createdAt: this.#clock.now(),
      });
      if (!("archive" in put)) {
        throw new Error(`export archive object write rejected: ${put.kind}`);
      }
      const storedObjectKey = put.archive.objectKey;
      objectKey = storedObjectKey;

      // Current access is rebuilt again after the potentially long build.
      if (!(await this.#authorizeCurrent(request.actor, job))) {
        await this.#archives.deleteExportArchive(storedObjectKey);
        objectKey = null;
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
      return Object.freeze({ kind: "completed" });
    } catch (error) {
      if (objectKey !== null) await this.#archives.deleteExportArchive(objectKey);
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

  async #failClaim(
    jobId: JobId,
    version: Version,
    failureCode: string,
  ): Promise<BackgroundHandleResult> {
    const failedAt = this.#clock.now();
    const failed = await this.#jobs.failExportJob(
      jobId,
      version,
      failureCode,
      failedAt,
      retryAt(failedAt, this.#retryDelayMs),
    );
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
      // A stale crashed worker may have left a later claim-scoped orphan.
      await this.#archives.deleteExportArchivesForJob(request.jobId);
      return Object.freeze({ kind: "already_completed" });
    }
    await this.#archives.deleteExportArchivesForJob(request.jobId);
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
