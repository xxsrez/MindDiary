import type { ActorContext } from "@mind-diary/application-contracts";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import type { AuthorizationStamp, AuthorizationTransaction, ObjectStore } from "@mind-diary/application-ports";
import { idempotencyKey, version } from "@mind-diary/domain";
import type { AuditEventId, IdempotencyKey, MembershipId, OutboxMessageId, PrincipalId, SpaceId, Role, Sha256Digest, SpaceMembership, UtcInstant } from "@mind-diary/domain";
import { CONTROL_OR_SEPARATOR, safeBootstrapRequestId } from "./account-bootstrap.js";
import { ordinaryMindActor } from "./ordinary-mind-control.js";
import { PERSONAL_PROFILE_ENCODER } from "./personal-mind-control.js";

export type MembershipMutationRole = Exclude<Role, "owner">;
export type MembershipControlOperation =
  | "change_membership_role"
  | "revoke_membership"
  | "leave_space";

export interface ChangeMembershipRoleCommand {
  readonly mindId: SpaceId;
  readonly memberId: MembershipId;
  readonly role: Role;
  readonly expectedMembershipVersion: number;
  readonly idempotencyKey: string;
}

export interface RevokeMembershipCommand {
  readonly mindId: SpaceId;
  readonly memberId: MembershipId;
  readonly expectedMembershipVersion: number;
  readonly idempotencyKey: string;
}

export interface LeaveSpaceCommand {
  readonly mindId: SpaceId;
  readonly expectedMembershipVersion: number;
  readonly idempotencyKey: string;
}

export interface MembershipControlDescriptor {
  readonly memberId: MembershipId;
  readonly mindId: SpaceId;
  readonly principalId: PrincipalId;
  readonly role: Role;
  readonly state: SpaceMembership["state"];
  readonly membershipVersion: number;
  readonly changed: boolean;
  readonly replayed: boolean;
}

export type MembershipControlFailureCode =
  | "authentication_required"
  | "invalid_member_id"
  | "invalid_role"
  | "owner_role_requires_transfer"
  | "invalid_membership_version"
  | "invalid_idempotency_key"
  | "mind_not_found"
  | "membership_not_found"
  | "personal_mind_operation_forbidden"
  | "forbidden"
  | "owner_membership_protected"
  | "membership_version_conflict"
  | "membership_state_changed"
  | "idempotency_conflict"
  | "membership_effect_conflict"
  | "membership_control_unavailable";

/** Stable control-plane failure without target profile or private Mind metadata. */
export class MembershipControlFailure extends Error {
  readonly code: MembershipControlFailureCode;

  constructor(code: MembershipControlFailureCode, message: string) {
    super(message);
    this.name = "MembershipControlFailure";
    this.code = code;
  }
}

export interface MembershipControlSafeEvent {
  readonly event:
    | "membership_changed"
    | "membership_revoked"
    | "membership_left"
    | "membership_noop"
    | "membership_replayed"
    | "membership_conflict"
    | "membership_denied"
    | "membership_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface MembershipControlSafeLogger {
  record(event: Readonly<MembershipControlSafeEvent>): void | Promise<void>;
}

export interface MembershipAuditIdGenerator {
  nextAuditEventId(): AuditEventId;
  nextOutboxMessageId(): OutboxMessageId;
}

export interface MembershipControlTargetQuery {
  readonly spaceId: SpaceId;
  readonly memberId?: MembershipId;
  readonly principalId?: PrincipalId;
}

export type MembershipControlTargetResult =
  | {
      readonly kind: "found";
      readonly mindKind: "ordinary" | "personal";
      readonly membership: Readonly<SpaceMembership>;
    }
  | { readonly kind: "mind_not_found" }
  | { readonly kind: "membership_not_found" };

export interface MembershipMutationReplayRequest {
  readonly operation: MembershipControlOperation;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
}

export type MembershipMutationReplayResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "idempotency_conflict" }
  | {
      readonly kind: "replayed";
      readonly membership: Readonly<SpaceMembership>;
      readonly changed: boolean;
      readonly requiredCapability: ApplyMembershipMutationRequest["requiredCapability"];
    };

export interface ApplyMembershipMutationRequest
  extends MembershipMutationReplayRequest {
  readonly targetMembershipId: MembershipId;
  readonly role: MembershipMutationRole | null;
  readonly expectedMembershipVersion: SpaceMembership["version"];
  readonly requiredCapability: "content:browse" | "members:manage-basic" | "members:manage-admin";
  readonly authorizationStamp: Readonly<AuthorizationStamp>;
  readonly occurredAt: UtcInstant;
  readonly requestId: ActorContext["requestId"];
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
}

export type ApplyMembershipMutationResult =
  | {
      readonly kind: "applied";
      readonly membership: Readonly<SpaceMembership>;
      readonly changed: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "mind_not_found"
        | "membership_not_found"
        | "personal_mind"
        | "forbidden"
        | "owner_membership"
        | "membership_version_conflict"
        | "authorization_state_changed"
        | "idempotency_conflict"
        | "effect_conflict"
        | "invalid_record";
    };

/** Atomic authority, membership CAS, access epoch, idempotency and audit boundary. */
export interface MembershipControlTransaction extends AuthorizationTransaction {
  readMembershipControlTarget(
    query: Readonly<MembershipControlTargetQuery>,
  ): Promise<MembershipControlTargetResult>;
  applyMembershipMutation(
    request: Readonly<ApplyMembershipMutationRequest>,
  ): Promise<ApplyMembershipMutationResult>;
}

export interface MembershipControlStore {
  readMembershipMutationReplay(
    request: Readonly<MembershipMutationReplayRequest>,
  ): Promise<MembershipMutationReplayResult>;
  runMembershipControlTransaction<Result>(
    operation: (transaction: MembershipControlTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface MembershipControlDependencies {
  readonly memberships: MembershipControlStore;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
  readonly auditIds: MembershipAuditIdGenerator;
  readonly logger?: MembershipControlSafeLogger;
}

export function membershipVersion(value: unknown): SpaceMembership["version"] {
  try {
    return version(value as number);
  } catch {
    throw new MembershipControlFailure(
      "invalid_membership_version",
      "A valid expected membership version is required.",
    );
  }
}

function membershipKey(value: unknown): IdempotencyKey {
  try {
    return idempotencyKey(value as string);
  } catch {
    throw new MembershipControlFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
}

function membershipMindId(value: unknown): SpaceId {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new MembershipControlFailure("mind_not_found", "Mind was not found.");
  }
  return value as SpaceId;
}

function membershipMemberId(value: unknown): MembershipId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    CONTROL_OR_SEPARATOR.test(value)
  ) {
    throw new MembershipControlFailure(
      "invalid_member_id",
      "Membership identifier is invalid.",
    );
  }
  return value as MembershipId;
}

function membershipRole(value: unknown): MembershipMutationRole {
  if (value === "owner") {
    throw new MembershipControlFailure(
      "owner_role_requires_transfer",
      "Owner can only be assigned through ownership transfer.",
    );
  }
  if (value !== "reader" && value !== "editor" && value !== "admin") {
    throw new MembershipControlFailure(
      "invalid_role",
      "Membership role must be reader, editor, or admin.",
    );
  }
  return value;
}

function membershipDescriptor(
  membership: Readonly<SpaceMembership>,
  changed: boolean,
  replayed: boolean,
): Readonly<MembershipControlDescriptor> {
  return Object.freeze({
    memberId: membership.membershipId,
    mindId: membership.spaceId,
    principalId: membership.principalId,
    role: membership.role,
    state: membership.state,
    membershipVersion: membership.version,
    changed,
    replayed,
  });
}

function sameMembershipSnapshot(
  current: Readonly<SpaceMembership>,
  recorded: Readonly<SpaceMembership>,
): boolean {
  return (
    current.membershipId === recorded.membershipId &&
    current.spaceId === recorded.spaceId &&
    current.principalId === recorded.principalId &&
    current.role === recorded.role &&
    current.state === recorded.state &&
    current.version === recorded.version &&
    current.createdAt === recorded.createdAt &&
    current.createdBy === recorded.createdBy &&
    current.updatedAt === recorded.updatedAt &&
    current.updatedBy === recorded.updatedBy
  );
}

function recordMembershipEvent(
  logger: MembershipControlSafeLogger | undefined,
  event: MembershipControlSafeEvent["event"],
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

function membershipAuthorizationFailure(code: string): MembershipControlFailure {
  if (code === "authentication_required") {
    return new MembershipControlFailure(
      "authentication_required",
      "A registered Sites principal is required.",
    );
  }
  if (code === "authorization_state_changed") {
    return new MembershipControlFailure(
      "membership_state_changed",
      "Membership authority changed; re-read and retry.",
    );
  }
  if (code === "authorization_state_unavailable" || code === "access_denied") {
    return new MembershipControlFailure("mind_not_found", "Mind was not found.");
  }
  return new MembershipControlFailure(
    "forbidden",
    "Current membership-management access is required.",
  );
}

interface PreparedMembershipMutation {
  readonly operation: MembershipControlOperation;
  readonly mindId: SpaceId;
  readonly memberId: MembershipId | null;
  readonly role: MembershipMutationRole | null;
  readonly expectedMembershipVersion: SpaceMembership["version"];
  readonly idempotencyKey: IdempotencyKey;
}

/** Trusted Sites role mutation, revoke and non-owner leave use cases. */
export class MembershipControlService {
  readonly #memberships: MembershipControlStore;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #auditIds: MembershipAuditIdGenerator;
  readonly #logger: MembershipControlSafeLogger | undefined;

  constructor(dependencies: MembershipControlDependencies) {
    this.#memberships = dependencies.memberships;
    this.#digest = dependencies.digest;
    this.#auditIds = dependencies.auditIds;
    this.#logger = dependencies.logger;
  }

  async changeMembershipRole(
    actor: ActorContext,
    command: ChangeMembershipRoleCommand,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    return this.#execute(actor, {
      operation: "change_membership_role",
      mindId: membershipMindId(command?.mindId),
      memberId: membershipMemberId(command?.memberId),
      role: membershipRole(command?.role),
      expectedMembershipVersion: membershipVersion(
        command?.expectedMembershipVersion,
      ),
      idempotencyKey: membershipKey(command?.idempotencyKey),
    });
  }

  async revokeMembership(
    actor: ActorContext,
    command: RevokeMembershipCommand,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    return this.#execute(actor, {
      operation: "revoke_membership",
      mindId: membershipMindId(command?.mindId),
      memberId: membershipMemberId(command?.memberId),
      role: null,
      expectedMembershipVersion: membershipVersion(
        command?.expectedMembershipVersion,
      ),
      idempotencyKey: membershipKey(command?.idempotencyKey),
    });
  }

  async leaveSpace(
    actor: ActorContext,
    command: LeaveSpaceCommand,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    return this.#execute(actor, {
      operation: "leave_space",
      mindId: membershipMindId(command?.mindId),
      memberId: null,
      role: null,
      expectedMembershipVersion: membershipVersion(
        command?.expectedMembershipVersion,
      ),
      idempotencyKey: membershipKey(command?.idempotencyKey),
    });
  }

  async #execute(
    actor: ActorContext,
    command: PreparedMembershipMutation,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordMembershipEvent(this.#logger, "membership_denied", requestId);
      throw new MembershipControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    try {
      const canonicalRequestHash = await this.#digest.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-membership-control-v1",
          operation: command.operation,
          mind_id: command.mindId,
          member_id: command.memberId,
          role: command.role,
          expected_membership_version: command.expectedMembershipVersion,
        })}\n`),
      );
      const replayRequest = Object.freeze({
        operation: command.operation,
        principalId: trustedActor.principalId,
        spaceId: command.mindId,
        idempotencyKey: command.idempotencyKey,
        canonicalRequestHash,
      });
      const prior = await this.#memberships.readMembershipMutationReplay(
        replayRequest,
      );
      if (prior.kind === "idempotency_conflict") {
        throw new MembershipControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (prior.kind === "replayed") {
        if (
          command.operation === "leave_space" &&
          (prior.membership.principalId !== trustedActor.principalId ||
            prior.requiredCapability !== "content:browse")
        ) {
          throw new MembershipControlFailure(
            "membership_control_unavailable",
            "Membership control is unavailable.",
          );
        }
        const replayedMembership =
          await this.#memberships.runMembershipControlTransaction(
            async (transaction): Promise<Readonly<SpaceMembership>> => {
              if (command.operation !== "leave_space") {
                const authorization = await new CapabilityAuthorizer(
                  transaction,
                ).authorize({
                  actor,
                  spaceId: command.mindId,
                  capability: prior.requiredCapability,
                  revisionMode: "head",
                });
                if (authorization.kind === "denied") {
                  throw membershipAuthorizationFailure(authorization.code);
                }
                if (authorization.grant.kind !== "membership") {
                  throw new MembershipControlFailure(
                    "forbidden",
                    "Current membership-management access is required.",
                  );
                }
              }
              const current = await transaction.readMembershipControlTarget({
                spaceId: command.mindId,
                memberId: prior.membership.membershipId,
              });
              if (
                current.kind !== "found" ||
                current.mindKind !== "ordinary" ||
                !sameMembershipSnapshot(current.membership, prior.membership)
              ) {
                throw new MembershipControlFailure(
                  "membership_state_changed",
                  "Membership state changed; re-read before retrying.",
                );
              }
              return current.membership;
            },
          );
        recordMembershipEvent(this.#logger, "membership_replayed", requestId);
        return membershipDescriptor(replayedMembership, prior.changed, true);
      }

      const result = await this.#memberships.runMembershipControlTransaction(
        async (transaction) => {
          const authorizer = new CapabilityAuthorizer(transaction);
          const initialCapability: ApplyMembershipMutationRequest["requiredCapability"] =
            command.operation === "leave_space"
              ? "content:browse"
              : "members:manage-basic";
          let authorization = await authorizer.authorize({
            actor,
            spaceId: command.mindId,
            capability: initialCapability,
            revisionMode: "head",
          });
          if (authorization.kind === "denied") {
            throw membershipAuthorizationFailure(authorization.code);
          }
          if (authorization.grant.kind !== "membership") {
            throw new MembershipControlFailure(
              command.operation === "leave_space"
                ? "membership_not_found"
                : "forbidden",
              "An active membership is required.",
            );
          }
          const target = await transaction.readMembershipControlTarget(
            command.operation === "leave_space"
              ? {
                  spaceId: command.mindId,
                  principalId: trustedActor.principalId,
                }
              : {
                  spaceId: command.mindId,
                  memberId: command.memberId!,
                },
          );
          if (target.kind === "mind_not_found") {
            throw new MembershipControlFailure("mind_not_found", "Mind was not found.");
          }
          if (target.kind === "membership_not_found" || target.membership.state !== "active") {
            throw new MembershipControlFailure(
              "membership_not_found",
              "Active membership was not found.",
            );
          }
          if (target.mindKind === "personal") {
            throw new MembershipControlFailure(
              "personal_mind_operation_forbidden",
              "Personal Mind membership cannot change.",
            );
          }
          if (target.membership.role === "owner") {
            throw new MembershipControlFailure(
              "owner_membership_protected",
              "Owner must transfer ownership before leaving or being changed.",
            );
          }
          if (target.membership.version !== command.expectedMembershipVersion) {
            throw new MembershipControlFailure(
              "membership_version_conflict",
              "Membership changed; re-read and retry.",
            );
          }

          let requiredCapability: ApplyMembershipMutationRequest["requiredCapability"] =
            initialCapability;
          if (
            command.operation !== "leave_space" &&
            (target.membership.role === "admin" || command.role === "admin")
          ) {
            requiredCapability = "members:manage-admin";
            authorization = await authorizer.authorize({
              actor,
              spaceId: command.mindId,
              capability: requiredCapability,
              revisionMode: "head",
            });
            if (authorization.kind === "denied") {
              throw membershipAuthorizationFailure(authorization.code);
            }
            if (authorization.grant.kind !== "membership") {
              throw new MembershipControlFailure(
                "forbidden",
                "Current Owner membership-management access is required.",
              );
            }
          }

          const finalAuthorization = await authorizer.reauthorizeInTransaction(
            {
              actor,
              spaceId: command.mindId,
              capability: requiredCapability,
              revisionMode: "head",
            },
            transaction,
            authorization.stamp,
          );
          if (finalAuthorization.kind === "denied") {
            throw membershipAuthorizationFailure(finalAuthorization.code);
          }
          return transaction.applyMembershipMutation({
            ...replayRequest,
            targetMembershipId: target.membership.membershipId,
            role: command.role,
            expectedMembershipVersion: command.expectedMembershipVersion,
            requiredCapability,
            authorizationStamp: finalAuthorization.stamp,
            occurredAt: trustedActor.occurredAtUtc,
            requestId,
            auditEventId: this.#auditIds.nextAuditEventId(),
            auditOutboxMessageId: this.#auditIds.nextOutboxMessageId(),
          });
        },
      );
      if (result.kind === "applied") {
        recordMembershipEvent(
          this.#logger,
          result.replayed
            ? "membership_replayed"
            : !result.changed
              ? "membership_noop"
              : command.operation === "change_membership_role"
                ? "membership_changed"
                : command.operation === "revoke_membership"
                  ? "membership_revoked"
                  : "membership_left",
          requestId,
        );
        return membershipDescriptor(
          result.membership,
          result.changed,
          result.replayed,
        );
      }
      if (result.kind === "membership_version_conflict") {
        throw new MembershipControlFailure(
          "membership_version_conflict",
          "Membership changed; re-read and retry.",
        );
      }
      if (result.kind === "authorization_state_changed") {
        throw new MembershipControlFailure(
          "membership_state_changed",
          "Membership authority changed; re-read and retry.",
        );
      }
      if (result.kind === "idempotency_conflict") {
        throw new MembershipControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (result.kind === "owner_membership") {
        throw new MembershipControlFailure(
          "owner_membership_protected",
          "Owner must transfer ownership before leaving or being changed.",
        );
      }
      if (result.kind === "personal_mind") {
        throw new MembershipControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind membership cannot change.",
        );
      }
      if (result.kind === "mind_not_found") {
        throw new MembershipControlFailure("mind_not_found", "Mind was not found.");
      }
      if (result.kind === "membership_not_found") {
        throw new MembershipControlFailure(
          "membership_not_found",
          "Active membership was not found.",
        );
      }
      if (result.kind === "forbidden") {
        throw new MembershipControlFailure(
          "forbidden",
          "Current membership-management access is required.",
        );
      }
      if (result.kind === "effect_conflict") {
        throw new MembershipControlFailure(
          "membership_effect_conflict",
          "Membership audit effects conflict.",
        );
      }
      throw new MembershipControlFailure(
        "membership_control_unavailable",
        "Membership control is unavailable.",
      );
    } catch (error) {
      if (error instanceof MembershipControlFailure) {
        if (
          error.code === "membership_version_conflict" ||
          error.code === "membership_state_changed" ||
          error.code === "idempotency_conflict" ||
          error.code === "membership_effect_conflict"
        ) {
          recordMembershipEvent(this.#logger, "membership_conflict", requestId);
        } else if (
          error.code === "authentication_required" ||
          error.code === "mind_not_found" ||
          error.code === "membership_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "forbidden" ||
          error.code === "owner_membership_protected"
        ) {
          recordMembershipEvent(this.#logger, "membership_denied", requestId);
        }
      } else {
        recordMembershipEvent(this.#logger, "membership_failed", requestId);
      }
      throw error;
    }
  }
}
