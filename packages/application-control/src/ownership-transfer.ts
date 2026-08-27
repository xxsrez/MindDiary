import type { ActorContext } from "@mind-diary/application-contracts";
import type { CapacityLimits, ObjectStore, OrdinaryMindStore, OwnershipTransferAuditIdGenerator } from "@mind-diary/application-ports";
import { idempotencyKey, version } from "@mind-diary/domain";
import type { IdempotencyKey, MembershipId, SpaceId } from "@mind-diary/domain";
import { ordinaryMindActor, ordinaryMindDescriptor } from "./ordinary-mind-control.js";
import type { OrdinaryMindControlDescriptor } from "./ordinary-mind-control.js";
import { CONTROL_OR_SEPARATOR, safeBootstrapRequestId } from "./account-bootstrap.js";
import { PERSONAL_PROFILE_ENCODER } from "./personal-mind-control.js";

export const OWNERSHIP_TRANSFER_CONFIRMATION = "transfer-ownership" as const;

export interface TransferOwnershipCommand {
  readonly mindId: SpaceId;
  readonly targetMemberId: MembershipId;
  readonly expectedMetadataVersion: number;
  readonly expectedSourceMembershipVersion: number;
  readonly expectedTargetMembershipVersion: number;
  readonly confirmation: typeof OWNERSHIP_TRANSFER_CONFIRMATION;
  readonly idempotencyKey: string;
}

export interface OwnershipTransferDescriptor
  extends OrdinaryMindControlDescriptor {
  readonly sourceMemberId: MembershipId;
  readonly sourceRole: "admin";
  readonly sourceMembershipVersion: number;
  readonly targetMemberId: MembershipId;
  readonly targetRole: "owner";
  readonly targetMembershipVersion: number;
  readonly replayed: boolean;
}

export type OwnershipTransferFailureCode =
  | "authentication_required"
  | "invalid_target_member_id"
  | "invalid_metadata_version"
  | "invalid_membership_version"
  | "invalid_confirmation"
  | "invalid_idempotency_key"
  | "mind_not_found"
  | "personal_mind_operation_forbidden"
  | "forbidden"
  | "ownership_target_invalid"
  | "ownership_target_capacity_exceeded"
  | "capacity_accounting_untrusted"
  | "metadata_conflict"
  | "ownership_state_changed"
  | "idempotency_conflict"
  | "ownership_effect_conflict"
  | "ownership_transfer_unavailable";

/** Stable control-plane failure without target profile or private Mind data. */
export class OwnershipTransferFailure extends Error {
  readonly code: OwnershipTransferFailureCode;

  constructor(code: OwnershipTransferFailureCode, message: string) {
    super(message);
    this.name = "OwnershipTransferFailure";
    this.code = code;
  }
}

export interface OwnershipTransferSafeEvent {
  readonly event:
    | "ownership_transferred"
    | "ownership_replayed"
    | "ownership_conflict"
    | "ownership_denied"
    | "ownership_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface OwnershipTransferSafeLogger {
  record(event: Readonly<OwnershipTransferSafeEvent>): void | Promise<void>;
}

export interface OwnershipTransferDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: Pick<ObjectStore, "calculateSha256">;
  readonly auditIds: OwnershipTransferAuditIdGenerator;
  readonly logger?: OwnershipTransferSafeLogger;
  readonly capacityLimits: Readonly<CapacityLimits>;
}

function ownershipTargetMemberId(value: unknown): MembershipId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    CONTROL_OR_SEPARATOR.test(value)
  ) {
    throw new OwnershipTransferFailure(
      "invalid_target_member_id",
      "Target membership identifier is invalid.",
    );
  }
  return value as MembershipId;
}

function ownershipMetadataVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new OwnershipTransferFailure(
      "invalid_metadata_version",
      "A valid expected metadata version is required.",
    );
  }
}

function ownershipMembershipVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new OwnershipTransferFailure(
      "invalid_membership_version",
      "Valid source and target membership versions are required.",
    );
  }
}

function ownershipIdempotencyKey(value: unknown): IdempotencyKey {
  try {
    return idempotencyKey(value as string);
  } catch {
    throw new OwnershipTransferFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
}

function recordOwnershipTransferEvent(
  logger: OwnershipTransferSafeLogger | undefined,
  event: OwnershipTransferSafeEvent["event"],
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

/** Atomic current-Owner transfer to one already accepted active participant. */
export class OwnershipTransferService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: Pick<ObjectStore, "calculateSha256">;
  readonly #auditIds: OwnershipTransferAuditIdGenerator;
  readonly #logger: OwnershipTransferSafeLogger | undefined;
  readonly #capacityLimits: Readonly<CapacityLimits>;

  constructor(dependencies: OwnershipTransferDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#auditIds = dependencies.auditIds;
    this.#logger = dependencies.logger;
    this.#capacityLimits = dependencies.capacityLimits;
  }

  async transferOwnership(
    actor: ActorContext,
    command: TransferOwnershipCommand,
  ): Promise<Readonly<OwnershipTransferDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOwnershipTransferEvent(
        this.#logger,
        "ownership_denied",
        requestId,
      );
      throw new OwnershipTransferFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      !Array.isArray(actor.deploymentCapabilities) ||
      !actor.deploymentCapabilities.includes("ownership:transfer")
    ) {
      recordOwnershipTransferEvent(
        this.#logger,
        "ownership_denied",
        requestId,
      );
      throw new OwnershipTransferFailure(
        "forbidden",
        "Ownership transfer is unavailable in this deployment.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0 ||
      command.mindId.length > 128 ||
      CONTROL_OR_SEPARATOR.test(command.mindId)
    ) {
      throw new OwnershipTransferFailure("mind_not_found", "Mind was not found.");
    }
    const targetMemberId = ownershipTargetMemberId(command.targetMemberId);
    const expectedMetadataVersion = ownershipMetadataVersion(
      command.expectedMetadataVersion,
    );
    const expectedSourceMembershipVersion = ownershipMembershipVersion(
      command.expectedSourceMembershipVersion,
    );
    const expectedTargetMembershipVersion = ownershipMembershipVersion(
      command.expectedTargetMembershipVersion,
    );
    if (command.confirmation !== OWNERSHIP_TRANSFER_CONFIRMATION) {
      throw new OwnershipTransferFailure(
        "invalid_confirmation",
        "Ownership transfer confirmation is required.",
      );
    }
    const checkedIdempotencyKey = ownershipIdempotencyKey(
      command.idempotencyKey,
    );

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-ownership-transfer-v1",
          mind_id: command.mindId,
          target_member_id: targetMemberId,
          expected_metadata_version: expectedMetadataVersion,
          expected_source_membership_version: expectedSourceMembershipVersion,
          expected_target_membership_version: expectedTargetMembershipVersion,
          confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
        })}\n`),
      );
      const transferred = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.transferOrdinaryMindOwnership({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            targetMembershipId: targetMemberId,
            expectedMetadataVersion,
            expectedSourceMembershipVersion,
            expectedTargetMembershipVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
            requestId,
            auditEventId: this.#auditIds.nextAuditEventId(),
            auditOutboxMessageId: this.#auditIds.nextOutboxMessageId(),
            capacityLimits: this.#capacityLimits,
          }),
      );
      if (transferred.kind === "transferred") {
        const { mind, sourceMembership, targetMembership } =
          transferred.transfer;
        if (
          sourceMembership.role !== "admin" ||
          targetMembership.role !== "owner"
        ) {
          throw new OwnershipTransferFailure(
            "ownership_transfer_unavailable",
            "Ownership transfer is unavailable.",
          );
        }
        recordOwnershipTransferEvent(
          this.#logger,
          transferred.replayed
            ? "ownership_replayed"
            : "ownership_transferred",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(mind),
          sourceMemberId: sourceMembership.membershipId,
          sourceRole: "admin" as const,
          sourceMembershipVersion: sourceMembership.version,
          targetMemberId: targetMembership.membershipId,
          targetRole: "owner" as const,
          targetMembershipVersion: targetMembership.version,
          replayed: transferred.replayed,
        });
      }
      if (transferred.kind === "metadata_conflict") {
        throw new OwnershipTransferFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (transferred.kind === "idempotency_conflict") {
        throw new OwnershipTransferFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (transferred.kind === "ownership_target_invalid") {
        throw new OwnershipTransferFailure(
          "ownership_target_invalid",
          "Ownership target must be an existing active participant.",
        );
      }
      if (transferred.kind === "ownership_target_capacity_exceeded") {
        throw new OwnershipTransferFailure(
          "ownership_target_capacity_exceeded",
          "The target Owner does not have enough aggregate storage headroom.",
        );
      }
      if (transferred.kind === "capacity_accounting_untrusted") {
        throw new OwnershipTransferFailure(
          "capacity_accounting_untrusted",
          "Ownership cannot move until aggregate capacity accounting is trustworthy.",
        );
      }
      if (transferred.kind === "ownership_state_changed") {
        throw new OwnershipTransferFailure(
          "ownership_state_changed",
          "Ownership state changed; re-read before retrying.",
        );
      }
      if (transferred.kind === "personal_mind") {
        throw new OwnershipTransferFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind ownership cannot be transferred.",
        );
      }
      if (transferred.kind === "mind_not_found") {
        throw new OwnershipTransferFailure("mind_not_found", "Mind was not found.");
      }
      if (transferred.kind === "forbidden") {
        throw new OwnershipTransferFailure(
          "forbidden",
          "Current active Owner access is required.",
        );
      }
      if (transferred.kind === "effect_conflict") {
        throw new OwnershipTransferFailure(
          "ownership_effect_conflict",
          "Ownership transfer audit effects conflict.",
        );
      }
      throw new OwnershipTransferFailure(
        "ownership_transfer_unavailable",
        "Ownership transfer is unavailable.",
      );
    } catch (error) {
      if (error instanceof OwnershipTransferFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "ownership_state_changed" ||
          error.code === "idempotency_conflict" ||
          error.code === "ownership_effect_conflict"
        ) {
          recordOwnershipTransferEvent(
            this.#logger,
            "ownership_conflict",
            requestId,
          );
        } else if (
          error.code === "authentication_required" ||
          error.code === "mind_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "forbidden" ||
          error.code === "ownership_target_invalid" ||
          error.code === "ownership_target_capacity_exceeded"
        ) {
          recordOwnershipTransferEvent(
            this.#logger,
            "ownership_denied",
            requestId,
          );
        } else if (error.code === "capacity_accounting_untrusted") {
          recordOwnershipTransferEvent(
            this.#logger,
            "ownership_failed",
            requestId,
          );
        }
      } else {
        recordOwnershipTransferEvent(
          this.#logger,
          "ownership_failed",
          requestId,
        );
      }
      throw error;
    }
  }
}
