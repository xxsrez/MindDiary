import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  AuditSink,
  BackgroundWorkStore,
  Clock,
  SearchIndex,
  SpaceTargetRecordPurger,
  SpaceTargetPurgeResult,
} from "@mind-diary/application-ports";
import type {
  JobId,
  OutboxMessageId,
  RevisionId,
  RevisionIndexState,
  Sha256Digest,
  SpaceId,
  UtcInstant,
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
    readonly text: string;
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
        documents: materialized.files.map((file) =>
          Object.freeze({ path: file.path, text: file.text }),
        ),
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

  constructor(dependencies: {
    readonly metadata: SpaceTargetRecordPurger;
    readonly index: SearchIndex;
    readonly audit: AuditSink;
  }) {
    this.#metadata = dependencies.metadata;
    this.#index = dependencies.index;
    this.#audit = dependencies.audit;
  }

  async purge(request: {
    readonly actor: ActorContext;
    readonly spaceId: SpaceId;
  }): Promise<
    Readonly<
      SpaceTargetPurgeResult & {
        readonly indexedRevisions: number;
        readonly deliveredAuditEvents: number;
      }
    >
  > {
    assertServiceActor(request.actor);
    const metadata = await this.#metadata.purgeSpaceTargetRecords(request.spaceId);
    const indexedRevisions = await this.#index.purgeSpace(request.spaceId);
    const deliveredAuditEvents = await this.#audit.purgeSpace(request.spaceId);
    return Object.freeze({ ...metadata, indexedRevisions, deliveredAuditEvents });
  }
}

export interface BackgroundBoundaryMarker {
  readonly actor: ServiceActorContext;
  readonly revisionId?: RevisionId;
  readonly searchIndex: SearchIndex;
  readonly auditSink: AuditSink;
  readonly fixtureOnlyBundle?: OkfBundleFixture;
}
