import type { ActorContext } from "@mind-diary/application-contracts";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import type { ObjectStore, OrdinaryMindStore, VisibilityAuditIdGenerator } from "@mind-diary/application-ports";
import type { SpaceId, Visibility } from "@mind-diary/domain";
import { OrdinaryMindControlFailure, ordinaryMindActor, ordinaryMindMetadataVersion, ordinaryMindIdempotencyKey, ordinaryMindDescriptor } from "./ordinary-mind-control.js";
import type { OrdinaryMindControlDescriptor } from "./ordinary-mind-control.js";
import { safeBootstrapRequestId } from "./account-bootstrap.js";
import { PERSONAL_PROFILE_ENCODER } from "./personal-mind-control.js";

export interface ChangeVisibilityCommand {
  readonly mindId: SpaceId;
  readonly visibility: Visibility;
  readonly acknowledgeLiveHeadAndHistoryExposure?: boolean;
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface VisibilityMutationResult extends OrdinaryMindControlDescriptor {
  readonly changed: boolean;
  readonly replayed: boolean;
}

export interface VisibilityControlSafeEvent {
  readonly event:
    | "visibility_changed"
    | "visibility_noop"
    | "visibility_replayed"
    | "visibility_conflict"
    | "visibility_denied"
    | "visibility_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface VisibilityControlSafeLogger {
  record(event: Readonly<VisibilityControlSafeEvent>): void | Promise<void>;
}

export interface VisibilityControlDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: ObjectStore;
  readonly auditIds: VisibilityAuditIdGenerator;
  readonly logger?: VisibilityControlSafeLogger;
}

function visibilityValue(value: unknown): Visibility | null {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : null;
}

function recordVisibilityEvent(
  logger: VisibilityControlSafeLogger | undefined,
  event: VisibilityControlSafeEvent["event"],
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
    // Safe observability is outside the authoritative metadata transaction.
  }
}

function visibilityAuthorizationFailure(
  code: string,
): OrdinaryMindControlFailure {
  if (
    code === "authorization_state_unavailable" ||
    code === "access_denied"
  ) {
    return new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
  }
  return new OrdinaryMindControlFailure(
    "forbidden",
    "Current active Owner visibility access is required.",
  );
}

/** Owner-only visibility transitions and baseline-grant epoch changes. */
export class VisibilityControlService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: ObjectStore;
  readonly #auditIds: VisibilityAuditIdGenerator;
  readonly #logger: VisibilityControlSafeLogger | undefined;

  constructor(dependencies: VisibilityControlDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#auditIds = dependencies.auditIds;
    this.#logger = dependencies.logger;
  }

  async changeVisibility(
    actor: ActorContext,
    command: ChangeVisibilityCommand,
  ): Promise<Readonly<VisibilityMutationResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordVisibilityEvent(this.#logger, "visibility_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0
    ) {
      throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
    }
    const visibility = visibilityValue(command.visibility);
    if (visibility === null) {
      throw new OrdinaryMindControlFailure(
        "invalid_visibility",
        "Visibility must be private, unlisted, or public.",
      );
    }
    if (
      command.acknowledgeLiveHeadAndHistoryExposure !== undefined &&
      typeof command.acknowledgeLiveHeadAndHistoryExposure !== "boolean"
    ) {
      throw new OrdinaryMindControlFailure(
        "invalid_exposure_acknowledgement",
        "The exposure acknowledgement must be a boolean.",
      );
    }
    const expectedMetadataVersion = ordinaryMindMetadataVersion(
      command.expectedMetadataVersion,
    );
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command.idempotencyKey,
    );
    const acknowledgeLiveHeadAndHistoryExposure =
      command.acknowledgeLiveHeadAndHistoryExposure ?? false;

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-visibility-change-v1",
          mind_id: command.mindId,
          visibility,
          expected_metadata_version: expectedMetadataVersion,
          acknowledge_live_head_and_history_exposure:
            acknowledgeLiveHeadAndHistoryExposure,
        })}\n`),
      );
      const changed = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        async (transaction) => {
          const authorization = await new CapabilityAuthorizer(
            transaction,
          ).authorize({
            actor,
            spaceId: command.mindId,
            capability: "visibility:change",
            revisionMode: "head",
          });
          if (authorization.kind === "denied") {
            throw visibilityAuthorizationFailure(authorization.code);
          }
          if (
            authorization.grant.kind !== "membership" ||
            authorization.grant.role !== "owner"
          ) {
            throw new OrdinaryMindControlFailure(
              "forbidden",
              "Current active Owner visibility access is required.",
            );
          }
          return transaction.changeOrdinaryMindVisibility({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            visibility,
            acknowledgeLiveHeadAndHistoryExposure:
              acknowledgeLiveHeadAndHistoryExposure,
            expectedMetadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
            requestId,
            auditEventId: this.#auditIds.nextAuditEventId(),
            auditOutboxMessageId: this.#auditIds.nextOutboxMessageId(),
          });
        },
      );
      if (changed.kind === "visibility_changed") {
        recordVisibilityEvent(
          this.#logger,
          changed.replayed
            ? "visibility_replayed"
            : changed.changed
              ? "visibility_changed"
              : "visibility_noop",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(changed.mind),
          changed: changed.changed,
          replayed: changed.replayed,
        });
      }
      if (changed.kind === "metadata_conflict") {
        throw new OrdinaryMindControlFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (changed.kind === "exposure_acknowledgement_required") {
        throw new OrdinaryMindControlFailure(
          "exposure_acknowledgement_required",
          "Acknowledge exposure of live HEAD and immutable history.",
        );
      }
      if (changed.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (changed.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind visibility cannot change.",
        );
      }
      if (changed.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
      }
      if (changed.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current active Owner visibility access is required.",
        );
      }
      if (changed.kind === "effect_conflict") {
        throw new OrdinaryMindControlFailure(
          "visibility_effect_conflict",
          "Visibility audit effects conflict.",
        );
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Visibility change is unavailable.",
      );
    } catch (error) {
      if (error instanceof OrdinaryMindControlFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "idempotency_conflict" ||
          error.code === "visibility_effect_conflict"
        ) {
          recordVisibilityEvent(this.#logger, "visibility_conflict", requestId);
        } else if (
          error.code === "forbidden" ||
          error.code === "mind_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "exposure_acknowledgement_required"
        ) {
          recordVisibilityEvent(this.#logger, "visibility_denied", requestId);
        }
      } else {
        recordVisibilityEvent(this.#logger, "visibility_failed", requestId);
      }
      throw error;
    }
  }
}
