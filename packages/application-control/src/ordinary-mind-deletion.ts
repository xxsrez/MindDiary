import type { ActorContext } from "@mind-diary/application-contracts";
import type { AuditSink, Clock, ExportArchiveStore, BundleFileObjectStore, OrdinaryMindDeletionCleanupWorkItem, OrdinaryMindDeletionIdGenerator, OrdinaryMindStore, SearchIndex, VerifiedSpaceHost } from "@mind-diary/application-ports";
import { isReservedTopLevelHandle, isReservedTopLevelRoute, parseCanonicalSpaceHandle } from "@mind-diary/domain";
import type { UtcInstant } from "@mind-diary/domain";
import { OrdinaryMindControlFailure, ordinaryMindActor, recordOrdinaryMindEvent, ordinaryMindIdempotencyKey } from "./ordinary-mind-control.js";
import type { OrdinaryMindControlSafeLogger } from "./ordinary-mind-control.js";
import { safeBootstrapRequestId } from "./account-bootstrap.js";
import { parseUtcInstant, canonicalUtcInstant } from "./token-lifecycle.js";

export const MIND_DELETION_IMPACT_LIFETIME_MINUTES = 15 as const;
export const DELETION_IMPACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface GetOrdinaryMindDeletionImpactQuery {
  readonly handle: string;
}

export interface OrdinaryMindDeletionImpactDescriptor {
  readonly impactId: string;
  readonly expiresAt: UtcInstant;
  readonly mind: Readonly<{
    readonly route: `/${string}`;
    readonly name: string;
  }>;
  readonly revisionCount: number;
  readonly membershipCount: number;
  readonly pendingInvitationCount: number;
  readonly backgroundJobCount: number;
  readonly exportJobCount: number;
  readonly irreversible: true;
  readonly recoveryAvailable: false;
  readonly forensicReceiptRetained: false;
  readonly confirmation: `delete-mind:${string}`;
}

export interface DeleteOrdinaryMindCommand {
  readonly handle: string;
  readonly impactId: string;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export interface OrdinaryMindDeletionResult {
  readonly replayed: boolean;
  readonly canonicalObjectsDeleted: number;
  readonly canonicalObjectsRetained: number;
  readonly indexedRevisionsDeleted: number;
  readonly deliveredAuditEventsDeleted: number;
  readonly exportArchivesDeleted: number;
}

export interface OrdinaryMindDeletionDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: BundleFileObjectStore;
  readonly index: SearchIndex;
  readonly audit: AuditSink;
  readonly exportArchives: ExportArchiveStore;
  readonly ids: OrdinaryMindDeletionIdGenerator;
  readonly clock: Clock;
  readonly host: VerifiedSpaceHost;
  readonly logger?: OrdinaryMindControlSafeLogger;
}

function deletionHandle(value: unknown): string | null {
  if (isReservedTopLevelRoute(value)) return null;
  const parsed = parseCanonicalSpaceHandle(value);
  return parsed.kind === "valid" &&
    !isReservedTopLevelHandle(parsed.canonicalHandle) &&
    parsed.canonicalHandle === value
    ? parsed.canonicalHandle
    : null;
}

function deletionImpactId(value: unknown): string {
  if (typeof value !== "string" || !DELETION_IMPACT_ID_PATTERN.test(value)) {
    throw new OrdinaryMindControlFailure(
      "invalid_deletion_impact_id",
      "A valid deletion impact ID is required.",
    );
  }
  return value;
}

function deletionConfirmation(handle: string): `delete-mind:${string}` {
  return `delete-mind:${handle}`;
}

/** Owner-only irreversible ordinary-Mind deletion and crash-resumable cleanup. */
export class OrdinaryMindDeletionService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: BundleFileObjectStore;
  readonly #index: SearchIndex;
  readonly #audit: AuditSink;
  readonly #exportArchives: ExportArchiveStore;
  readonly #ids: OrdinaryMindDeletionIdGenerator;
  readonly #clock: Clock;
  readonly #host: VerifiedSpaceHost;
  readonly #logger: OrdinaryMindControlSafeLogger | undefined;

  constructor(dependencies: OrdinaryMindDeletionDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#index = dependencies.index;
    this.#audit = dependencies.audit;
    this.#exportArchives = dependencies.exportArchives;
    this.#ids = dependencies.ids;
    this.#clock = dependencies.clock;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
  }

  async getDeletionImpact(
    actor: ActorContext,
    query: GetOrdinaryMindDeletionImpactQuery,
  ): Promise<Readonly<OrdinaryMindDeletionImpactDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (query?.handle === "me") {
      throw new OrdinaryMindControlFailure(
        "personal_mind_operation_forbidden",
        "Personal Mind cannot be deleted separately.",
      );
    }
    const handle = deletionHandle(query?.handle);
    if (handle === null) {
      throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
    }
    const now = parseUtcInstant(this.#clock.now());
    if (now === null) {
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion impact is unavailable.",
      );
    }
    const impactId = deletionImpactId(this.#ids.nextImpactId());
    const occurredAt = canonicalUtcInstant(now);
    const expiresAt = canonicalUtcInstant(
      now + MIND_DELETION_IMPACT_LIFETIME_MINUTES * 60_000,
    );
    try {
      const created = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.createOrdinaryMindDeletionImpact({
            principalId: trustedActor.principalId,
            host: this.#host,
            handle,
            impactId,
            occurredAt,
            expiresAt,
          }),
      );
      if (created.kind === "created") {
        const impact = created.impact;
        recordOrdinaryMindEvent(
          this.#logger,
          "ordinary_mind_deletion_previewed",
          requestId,
        );
        return Object.freeze({
          impactId: impact.impactId,
          expiresAt: impact.expiresAt,
          mind: Object.freeze({ route: `/${handle}`, name: impact.name }),
          revisionCount: impact.revisionCount,
          membershipCount: impact.membershipCount,
          pendingInvitationCount: impact.invitationCount,
          backgroundJobCount: impact.backgroundJobCount,
          exportJobCount: impact.exportJobCount,
          irreversible: true,
          recoveryAvailable: false,
          forensicReceiptRetained: false,
          confirmation: deletionConfirmation(handle),
        });
      }
      if (created.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind cannot be deleted separately.",
        );
      }
      if (created.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current active Owner deletion access is required.",
        );
      }
      if (created.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion impact is unavailable.",
      );
    } catch (error) {
      if (!(error instanceof OrdinaryMindControlFailure)) {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }

  async deleteSpace(
    actor: ActorContext,
    command: DeleteOrdinaryMindCommand,
  ): Promise<Readonly<OrdinaryMindDeletionResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (command?.handle === "me") {
      throw new OrdinaryMindControlFailure(
        "personal_mind_operation_forbidden",
        "Personal Mind cannot be deleted separately.",
      );
    }
    const handle = deletionHandle(command?.handle);
    if (handle === null) {
      throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
    }
    const impactId = deletionImpactId(command?.impactId);
    if (command?.confirmation !== deletionConfirmation(handle)) {
      throw new OrdinaryMindControlFailure(
        "invalid_confirmation",
        "The exact Mind deletion confirmation is required.",
      );
    }
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command?.idempotencyKey,
    );
    const nowValue = this.#clock.now();
    if (parseUtcInstant(nowValue) === null) {
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion is unavailable.",
      );
    }
    try {
      const deleted = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.deleteOrdinaryMind({
            principalId: trustedActor.principalId,
            host: this.#host,
            handle,
            impactId,
            idempotencyKey: checkedIdempotencyKey,
            occurredAt: nowValue,
          }),
      );
      if (deleted.kind === "already_absent") {
        return Object.freeze({
          replayed: true,
          canonicalObjectsDeleted: 0,
          canonicalObjectsRetained: 0,
          indexedRevisionsDeleted: 0,
          deliveredAuditEventsDeleted: 0,
          exportArchivesDeleted: 0,
        });
      }
      if (deleted.kind === "deleted" || deleted.kind === "cleanup_pending") {
        const cleanupResult = await this.#completeCleanup(deleted.cleanup);
        recordOrdinaryMindEvent(
          this.#logger,
          deleted.kind === "cleanup_pending"
            ? "ordinary_mind_delete_replayed"
            : "ordinary_mind_deleted",
          requestId,
        );
        return Object.freeze({
          replayed: deleted.kind === "cleanup_pending",
          ...cleanupResult,
        });
      }
      if (deleted.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind cannot be deleted separately.",
        );
      }
      if (deleted.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current active Owner deletion access is required.",
        );
      }
      if (deleted.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
      }
      if (deleted.kind === "deletion_impact_expired") {
        throw new OrdinaryMindControlFailure(
          "deletion_impact_expired",
          "Deletion impact expired; request a new preview.",
        );
      }
      if (deleted.kind === "deletion_impact_changed") {
        throw new OrdinaryMindControlFailure(
          "deletion_impact_changed",
          "Deletion impact changed; request a new preview.",
        );
      }
      if (deleted.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion is unavailable.",
      );
    } catch (error) {
      if (
        error instanceof OrdinaryMindControlFailure &&
        error.code === "deletion_cleanup_incomplete"
      ) {
        recordOrdinaryMindEvent(
          this.#logger,
          "ordinary_mind_delete_cleanup_incomplete",
          requestId,
        );
      } else if (!(error instanceof OrdinaryMindControlFailure)) {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }

  async #completeCleanup(
    work: Readonly<OrdinaryMindDeletionCleanupWorkItem>,
  ): Promise<Omit<OrdinaryMindDeletionResult, "replayed">> {
    try {
      const indexedRevisionsDeleted = await this.#index.purgeSpace(work.spaceId);
      const deliveredAuditEventsDeleted = await this.#audit.purgeSpace(work.spaceId);
      const exportArchivesDeleted =
        await this.#exportArchives.deleteExportArchivesForSpace(work.spaceId);
      const reachable = new Set(
        await this.#ordinaryMinds.listReachableObjectDigests(),
      );
      let canonicalObjectsDeleted = 0;
      let canonicalObjectsRetained = 0;
      for (const digest of work.objectDigests) {
        if (reachable.has(digest)) {
          canonicalObjectsRetained += 1;
          continue;
        }
        const object = await this.#objects.getImmutable(digest);
        if (object === null) continue;
        if (Date.parse(object.protectedAt) >= Date.parse(work.deleteBefore)) {
          canonicalObjectsRetained += 1;
          continue;
        }
        const removed = await this.#objects.deleteImmutableObject({
          sha256: digest,
          expectedProtectedAt: object.protectedAt,
          createdBefore: work.deleteBefore,
        });
        if (removed) canonicalObjectsDeleted += 1;
        else canonicalObjectsRetained += 1;
      }
      const reachableSpaceCanonical =
        await this.#ordinaryMinds.listReachableSpaceCanonicalObjects();
      for (;;) {
        const candidates = await this.#objects.listSpaceCanonicalObjects({
          spaceId: work.spaceId,
          createdBefore: work.deleteBefore,
          excluded: reachableSpaceCanonical,
          limit: 1_000,
        });
        if (candidates.length === 0) break;
        for (const candidate of candidates) {
          const removed = await this.#objects.deleteSpaceCanonicalObject({
            kind: candidate.kind,
            spaceId: candidate.spaceId,
            sha256: candidate.sha256,
            expectedProtectedAt: candidate.protectedAt,
            createdBefore: work.deleteBefore,
          });
          if (removed) canonicalObjectsDeleted += 1;
          else canonicalObjectsRetained += 1;
        }
        if (candidates.length < 1_000) break;
      }
      const completed = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.completeOrdinaryMindDeletionCleanup({
            impactId: work.impactId,
            spaceId: work.spaceId,
            host: work.host,
            handle: work.canonicalHandle,
          }),
      );
      if (completed.kind !== "completed") {
        throw new Error("deletion cleanup work item changed");
      }
      return Object.freeze({
        canonicalObjectsDeleted,
        canonicalObjectsRetained,
        indexedRevisionsDeleted,
        deliveredAuditEventsDeleted,
        exportArchivesDeleted,
      });
    } catch (error) {
      throw new OrdinaryMindControlFailure(
        "deletion_cleanup_incomplete",
        "Mind deletion cleanup is incomplete; retry the exact command.",
      );
    }
  }
}
