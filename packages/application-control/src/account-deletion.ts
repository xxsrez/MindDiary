import type { ActorContext } from "@mind-diary/application-contracts";
import type { AuditSink, AccountDeletionCleanupWorkItem, AccountDeletionIdGenerator, AccountDeletionStore, Clock, ExportArchiveStore, McpTokenStore, BundleFileObjectStore, SearchIndex, VerifiedSpaceHost } from "@mind-diary/application-ports";
import type { DeletedPrincipalId, IdempotencyKey, UtcInstant } from "@mind-diary/domain";
import { DELETION_IMPACT_ID_PATTERN } from "./ordinary-mind-deletion.js";
import { ordinaryMindIdempotencyKey, OrdinaryMindControlFailure } from "./ordinary-mind-control.js";
import { safeBootstrapRequestId } from "./account-bootstrap.js";
import { registeredSitesPrincipal } from "./personal-mind-control.js";
import { parseUtcInstant, canonicalUtcInstant } from "./token-lifecycle.js";

export const ACCOUNT_DELETION_IMPACT_LIFETIME_MINUTES = 15 as const;
export const ACCOUNT_DELETION_CONFIRMATION = "delete-account" as const;

export type AccountDeletionFailureCode =
  | "authentication_required"
  | "invalid_deletion_impact_id"
  | "invalid_confirmation"
  | "invalid_idempotency_key"
  | "account_not_found"
  | "deletion_impact_expired"
  | "deletion_impact_changed"
  | "idempotency_conflict"
  | "deletion_cleanup_incomplete"
  | "account_deletion_unavailable";

/** Safe failure without identity binding, email, profile or content. */
export class AccountDeletionFailure extends Error {
  readonly code: AccountDeletionFailureCode;

  constructor(code: AccountDeletionFailureCode, message: string) {
    super(message);
    this.name = "AccountDeletionFailure";
    this.code = code;
  }
}

export interface AccountDeletionImpactDescriptor {
  readonly impactId: string;
  readonly expiresAt: UtcInstant;
  readonly personalMind: Readonly<{ readonly route: "/me"; readonly name: string }>;
  readonly ownedMinds: readonly Readonly<{
    readonly route: `/${string}`;
    readonly name: string;
  }>[];
  readonly foreignMembershipCount: number;
  readonly pendingInvitationCount: number;
  readonly activeMcpTokenCount: number;
  readonly irreversible: true;
  readonly recoveryAvailable: false;
  readonly forensicReceiptRetained: false;
  readonly confirmation: typeof ACCOUNT_DELETION_CONFIRMATION;
}

export interface DeleteAccountCommand {
  readonly impactId: string;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export interface AccountDeletionResult {
  readonly replayed: boolean;
  readonly spacesDeleted: number;
  readonly tokensRevoked: number;
  readonly canonicalObjectsDeleted: number;
  readonly canonicalObjectsRetained: number;
  readonly indexedRevisionsDeleted: number;
  readonly deliveredAuditEventsDeleted: number;
  readonly deliveredAuditActorsTombstoned: number;
  readonly exportArchivesDeleted: number;
}

export interface AccountDeletionSafeEvent {
  readonly event:
    | "account_deletion_previewed"
    | "account_deleted"
    | "account_delete_replayed"
    | "account_delete_conflict"
    | "account_delete_cleanup_incomplete"
    | "account_delete_denied"
    | "account_delete_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface AccountDeletionSafeLogger {
  record(event: Readonly<AccountDeletionSafeEvent>): void | Promise<void>;
}

export interface AccountDeletionDependencies {
  readonly accounts: AccountDeletionStore;
  readonly tokens: McpTokenStore;
  readonly objects: BundleFileObjectStore;
  readonly index: SearchIndex;
  readonly audit: AuditSink;
  readonly exportArchives: ExportArchiveStore;
  readonly ids: AccountDeletionIdGenerator;
  readonly clock: Clock;
  readonly host: VerifiedSpaceHost;
  readonly logger?: AccountDeletionSafeLogger;
}

function accountDeletionImpactId(value: unknown): string {
  if (typeof value !== "string" || !DELETION_IMPACT_ID_PATTERN.test(value)) {
    throw new AccountDeletionFailure(
      "invalid_deletion_impact_id",
      "A valid account deletion impact ID is required.",
    );
  }
  return value;
}

function accountDeletedPrincipalId(value: unknown): DeletedPrincipalId {
  if (typeof value !== "string" || !DELETION_IMPACT_ID_PATTERN.test(value)) {
    throw new AccountDeletionFailure(
      "account_deletion_unavailable",
      "Account deletion identity is unavailable.",
    );
  }
  return value as DeletedPrincipalId;
}

function accountDeletionIdempotencyKey(value: unknown): IdempotencyKey {
  try {
    return ordinaryMindIdempotencyKey(value);
  } catch (error) {
    if (
      error instanceof OrdinaryMindControlFailure &&
      error.code === "invalid_idempotency_key"
    ) {
      throw new AccountDeletionFailure(
        "invalid_idempotency_key",
        "A valid account deletion idempotency key is required.",
      );
    }
    throw error;
  }
}

function recordAccountDeletionEvent(
  logger: AccountDeletionSafeLogger | undefined,
  event: AccountDeletionSafeEvent["event"],
  requestId: ActorContext["requestId"],
): void {
  if (!logger) return;
  try {
    const pending = logger.record(Object.freeze({ event, requestId }));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Safe observability is outside the authoritative cascade.
  }
}

/** Irreversible account preview/cascade with retryable external cleanup. */
export class AccountDeletionService {
  readonly #accounts: AccountDeletionStore;
  readonly #tokens: McpTokenStore;
  readonly #objects: BundleFileObjectStore;
  readonly #index: SearchIndex;
  readonly #audit: AuditSink;
  readonly #exportArchives: ExportArchiveStore;
  readonly #ids: AccountDeletionIdGenerator;
  readonly #clock: Clock;
  readonly #host: VerifiedSpaceHost;
  readonly #logger: AccountDeletionSafeLogger | undefined;

  constructor(dependencies: AccountDeletionDependencies) {
    this.#accounts = dependencies.accounts;
    this.#tokens = dependencies.tokens;
    this.#objects = dependencies.objects;
    this.#index = dependencies.index;
    this.#audit = dependencies.audit;
    this.#exportArchives = dependencies.exportArchives;
    this.#ids = dependencies.ids;
    this.#clock = dependencies.clock;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
  }

  async getAccountDeletionImpact(
    actor: ActorContext,
  ): Promise<Readonly<AccountDeletionImpactDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordAccountDeletionEvent(this.#logger, "account_delete_denied", requestId);
      throw new AccountDeletionFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const now = parseUtcInstant(this.#clock.now());
    if (now === null) {
      throw new AccountDeletionFailure(
        "account_deletion_unavailable",
        "Account deletion impact is unavailable.",
      );
    }
    const occurredAt = canonicalUtcInstant(now);
    const tokenSnapshot = await this.#tokens.readPrincipalTokenDeletionSnapshot(
      principalId,
      occurredAt,
    );
    const impactId = accountDeletionImpactId(this.#ids.nextImpactId());
    const deletedPrincipalId = accountDeletedPrincipalId(
      this.#ids.nextDeletedPrincipalId(),
    );
    const expiresAt = canonicalUtcInstant(
      now + ACCOUNT_DELETION_IMPACT_LIFETIME_MINUTES * 60_000,
    );
    try {
      const created = await this.#accounts.runAccountDeletionTransaction(
        (transaction) =>
          transaction.createAccountDeletionImpact({
            principalId,
            host: this.#host,
            impactId,
            deletedPrincipalId,
            occurredAt,
            expiresAt,
            activeTokenCount: tokenSnapshot.activeTokenCount,
            tokenStateFingerprint: tokenSnapshot.stateFingerprint,
          }),
      );
      if (created.kind !== "created") {
        throw new AccountDeletionFailure(
          created.kind === "account_not_found"
            ? "account_not_found"
            : "account_deletion_unavailable",
          "Account deletion impact is unavailable.",
        );
      }
      const impact = created.impact;
      recordAccountDeletionEvent(
        this.#logger,
        "account_deletion_previewed",
        requestId,
      );
      return Object.freeze({
        impactId: impact.impactId,
        expiresAt: impact.expiresAt,
        personalMind: Object.freeze({
          route: "/me" as const,
          name: impact.personalMind.name,
        }),
        ownedMinds: Object.freeze(
          impact.ownedMinds.map((mind) =>
            Object.freeze({ route: `/${mind.canonicalHandle}` as const, name: mind.name }),
          ),
        ),
        foreignMembershipCount: impact.foreignMembershipCount,
        pendingInvitationCount: impact.pendingInvitationCount,
        activeMcpTokenCount: impact.activeTokenCount,
        irreversible: true,
        recoveryAvailable: false,
        forensicReceiptRetained: false,
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
      });
    } catch (error) {
      if (!(error instanceof AccountDeletionFailure)) {
        recordAccountDeletionEvent(this.#logger, "account_delete_failed", requestId);
      }
      throw error;
    }
  }

  async deleteAccount(
    actor: ActorContext,
    command: DeleteAccountCommand,
  ): Promise<Readonly<AccountDeletionResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordAccountDeletionEvent(this.#logger, "account_delete_denied", requestId);
      throw new AccountDeletionFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const impactId = accountDeletionImpactId(command?.impactId);
    if (command?.confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
      throw new AccountDeletionFailure(
        "invalid_confirmation",
        "The exact account deletion confirmation is required.",
      );
    }
    const checkedIdempotencyKey = accountDeletionIdempotencyKey(
      command?.idempotencyKey,
    );
    const now = parseUtcInstant(this.#clock.now());
    if (now === null) {
      throw new AccountDeletionFailure(
        "account_deletion_unavailable",
        "Account deletion is unavailable.",
      );
    }
    const occurredAt = canonicalUtcInstant(now);
    const context = await this.#accounts.readAccountDeletionContext(
      principalId,
      impactId,
    );
    if (context === null) {
      throw new AccountDeletionFailure(
        "deletion_impact_changed",
        "Deletion impact changed; request a new preview.",
      );
    }
    const tokenStateFingerprint =
      context.kind === "impact"
        ? context.impact.tokenStateFingerprint
        : context.cleanup.tokenStateFingerprint;
    const deletedPrincipalId =
      context.kind === "cleanup"
        ? context.cleanup.deletedPrincipalId
        : context.impact.deletedPrincipalId;
    const tokenReservation = await this.#tokens.beginPrincipalTokenDeletion({
      principalId,
      expectedStateFingerprint: tokenStateFingerprint,
      occurredAt,
    });
    if (
      tokenReservation.kind === "state_changed" ||
      (tokenReservation.kind === "principal_deleted" && context.kind !== "cleanup")
    ) {
      recordAccountDeletionEvent(this.#logger, "account_delete_conflict", requestId);
      throw new AccountDeletionFailure(
        "deletion_impact_changed",
        "Deletion impact changed; request a new preview.",
      );
    }
    let metadataCommitted = context.kind === "cleanup";
    try {
      const deleted = await this.#accounts.runAccountDeletionTransaction(
        (transaction) =>
          transaction.deleteAccountCascade({
            principalId,
            impactId,
            idempotencyKey: checkedIdempotencyKey,
            deletedPrincipalId,
            tokenStateFingerprint,
            occurredAt,
          }),
      );
      if (deleted.kind === "deleted" || deleted.kind === "cleanup_pending") {
        metadataCommitted = true;
        const cleanup = await this.#completeCleanup(deleted.cleanup, occurredAt);
        recordAccountDeletionEvent(
          this.#logger,
          deleted.kind === "cleanup_pending"
            ? "account_delete_replayed"
            : "account_deleted",
          requestId,
        );
        return Object.freeze({
          replayed: deleted.kind === "cleanup_pending" || cleanup.tokenReplay,
          spacesDeleted: deleted.cleanup.deletedSpaceIds.length,
          tokensRevoked: cleanup.tokensRevoked,
          canonicalObjectsDeleted: cleanup.canonicalObjectsDeleted,
          canonicalObjectsRetained: cleanup.canonicalObjectsRetained,
          indexedRevisionsDeleted: cleanup.indexedRevisionsDeleted,
          deliveredAuditEventsDeleted: cleanup.deliveredAuditEventsDeleted,
          deliveredAuditActorsTombstoned:
            cleanup.deliveredAuditActorsTombstoned,
          exportArchivesDeleted: cleanup.exportArchivesDeleted,
        });
      }
      if (!metadataCommitted) {
        await this.#tokens.cancelPrincipalTokenDeletion({
          principalId,
          expectedStateFingerprint: tokenStateFingerprint,
        });
      }
      if (deleted.kind === "deletion_impact_expired") {
        throw new AccountDeletionFailure(
          "deletion_impact_expired",
          "Deletion impact expired; request a new preview.",
        );
      }
      if (deleted.kind === "deletion_impact_changed") {
        throw new AccountDeletionFailure(
          "deletion_impact_changed",
          "Deletion impact changed; request a new preview.",
        );
      }
      if (deleted.kind === "idempotency_conflict") {
        throw new AccountDeletionFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      throw new AccountDeletionFailure(
        deleted.kind === "account_not_found"
          ? "account_not_found"
          : "account_deletion_unavailable",
        "Account deletion is unavailable.",
      );
    } catch (error) {
      if (!metadataCommitted) {
        await this.#tokens.cancelPrincipalTokenDeletion({
          principalId,
          expectedStateFingerprint: tokenStateFingerprint,
        });
      }
      if (
        error instanceof AccountDeletionFailure &&
        error.code === "deletion_cleanup_incomplete"
      ) {
        recordAccountDeletionEvent(
          this.#logger,
          "account_delete_cleanup_incomplete",
          requestId,
        );
      } else if (!(error instanceof AccountDeletionFailure)) {
        recordAccountDeletionEvent(this.#logger, "account_delete_failed", requestId);
      }
      throw error;
    }
  }

  async #completeCleanup(
    work: Readonly<AccountDeletionCleanupWorkItem>,
    occurredAt: UtcInstant,
  ): Promise<Readonly<{
    tokenReplay: boolean;
    tokensRevoked: number;
    canonicalObjectsDeleted: number;
    canonicalObjectsRetained: number;
    indexedRevisionsDeleted: number;
    deliveredAuditEventsDeleted: number;
    deliveredAuditActorsTombstoned: number;
    exportArchivesDeleted: number;
  }>> {
    try {
      const tokenResult = await this.#tokens.completePrincipalTokenDeletion({
        principalId: work.principalId,
        expectedStateFingerprint: work.tokenStateFingerprint,
        revokedAt: occurredAt,
      });
      if (tokenResult.kind !== "completed") {
        throw new Error("account token deletion reservation changed");
      }
      let indexedRevisionsDeleted = 0;
      let deliveredAuditEventsDeleted = 0;
      let exportArchivesDeleted = 0;
      for (const spaceId of work.deletedSpaceIds) {
        indexedRevisionsDeleted += await this.#index.purgeSpace(spaceId);
        deliveredAuditEventsDeleted += await this.#audit.purgeSpace(spaceId);
        exportArchivesDeleted +=
          await this.#exportArchives.deleteExportArchivesForSpace(spaceId);
      }
      const deliveredAuditActorsTombstoned =
        await this.#audit.tombstonePrincipal(
          work.principalId,
          work.deletedPrincipalId,
        );
      for (const jobId of work.foreignExportJobIds) {
        exportArchivesDeleted +=
          await this.#exportArchives.deleteExportArchivesForJob(jobId);
      }
      const reachable = new Set(await this.#accounts.listReachableObjectDigests());
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
        await this.#accounts.listReachableSpaceCanonicalObjects();
      for (const spaceId of work.deletedSpaceIds) {
        for (;;) {
          const candidates = await this.#objects.listSpaceCanonicalObjects({
            spaceId,
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
        for (;;) {
          const candidates = await this.#objects.listBundleFileObjects({
            spaceId,
            createdBefore: work.deleteBefore,
            excluded: [],
            limit: 1_000,
          });
          if (candidates.length === 0) break;
          for (const candidate of candidates) {
            const removed = await this.#objects.deleteBundleFileObject({
              spaceId: candidate.spaceId,
              sha256: candidate.sha256,
              expectedProtectedAt: candidate.protectedAt,
              createdBefore: work.deleteBefore,
            });
            if (!removed) throw new Error("BundleFile erasure changed during cleanup");
            canonicalObjectsDeleted += 1;
          }
        }
        for (;;) {
          const stagedIds = await this.#accounts.listDeletionStagedBundleFiles(spaceId, 1_000);
          if (stagedIds.length === 0) break;
          for (const stagedId of stagedIds) {
            await this.#objects.deleteStagedBundleFile(stagedId);
            if (await this.#objects.getStagedBundleFile(stagedId) !== null ||
                !(await this.#accounts.deleteDeletionStagedBundleFileRecord(spaceId, stagedId))) {
              throw new Error("staged BundleFile erasure changed during cleanup");
            }
          }
        }
      }
      const completed = await this.#accounts.runAccountDeletionTransaction(
        (transaction) =>
          transaction.completeAccountDeletionCleanup({
            impactId: work.impactId,
            principalId: work.principalId,
          }),
      );
      if (completed.kind !== "completed") {
        const [context, account] = await Promise.all([
          this.#accounts.readAccountDeletionContext(
            work.principalId,
            work.impactId,
          ),
          this.#accounts.readAccount(work.principalId),
        ]);
        if (context !== null || account !== null) {
          throw new Error("account deletion cleanup work item changed");
        }
      }
      return Object.freeze({
        tokenReplay: tokenResult.replayed,
        tokensRevoked: tokenResult.revokedCount,
        canonicalObjectsDeleted,
        canonicalObjectsRetained,
        indexedRevisionsDeleted,
        deliveredAuditEventsDeleted,
        deliveredAuditActorsTombstoned,
        exportArchivesDeleted,
      });
    } catch {
      throw new AccountDeletionFailure(
        "deletion_cleanup_incomplete",
        "Account deletion cleanup is incomplete; retry the exact command.",
      );
    }
  }
}
