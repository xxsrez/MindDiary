import type { ActorContext } from "@mind-diary/application-contracts";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import type { InvitationLifecycleIdGenerator, InvitationSnapshot, ObjectStore, OrdinaryMindStore } from "@mind-diary/application-ports";
import { idempotencyKey, version } from "@mind-diary/domain";
import type { InvitationRole, PrincipalId, SensitiveExternalBinding, SpaceId, UtcInstant } from "@mind-diary/domain";
import { safeBootstrapRequestId } from "./account-bootstrap.js";
import { ordinaryMindActor } from "./ordinary-mind-control.js";
import { PERSONAL_PROFILE_ENCODER } from "./personal-mind-control.js";

export const INVITATION_SITES_IDENTITY_PROVIDER = "openai-sites" as const;
export const INVITATION_EXPIRY_DAYS = 7 as const;
const INVITATION_EXPIRY_MILLISECONDS =
  INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1_000;
const INVITATION_ASCII_PATTERN = /^[\u0020-\u007e]+$/u;
const INVITATION_LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const INVITATION_DOMAIN_LABEL_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface CreateInvitationCommand {
  readonly mindId: SpaceId;
  readonly targetVerifiedEmail: string;
  readonly role: InvitationRole | "owner";
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface InvitationControlDescriptor {
  readonly invitationId: InvitationSnapshot["invitation"]["invitationId"];
  readonly mindId: SpaceId;
  readonly target: Readonly<{
    readonly principalId: PrincipalId;
    readonly displayName: string;
  }>;
  readonly proposedRole: InvitationRole;
  readonly state: "pending";
  readonly expiresAt: UtcInstant;
  readonly invitationVersion: number;
  readonly replayed: boolean;
}

export type InvitationControlFailureCode =
  | "authentication_required"
  | "invalid_target_verified_email"
  | "invalid_role"
  | "invalid_metadata_version"
  | "invalid_invitation_version"
  | "invalid_idempotency_key"
  | "mind_not_found"
  | "personal_mind_operation_forbidden"
  | "registered_principal_not_found"
  | "forbidden"
  | "active_membership_exists"
  | "pending_invitation_exists"
  | "metadata_conflict"
  | "idempotency_conflict"
  | "invitation_conflict"
  | "invitation_expired"
  | "invitation_unavailable";

export interface InvitationLifecycleCommand {
  readonly invitationId: string;
  readonly expectedInvitationVersion: number;
  readonly idempotencyKey: string;
}

export interface InvitationLifecycleDescriptor {
  readonly invitationId: string;
  readonly mindId: SpaceId;
  readonly proposedRole: InvitationRole;
  readonly state: "accepted" | "rejected" | "cancelled";
  readonly invitationVersion: number;
  readonly membershipId: string | null;
  readonly replayed: boolean;
}

export interface ReissueInvitationDescriptor {
  readonly previousInvitationId: string;
  readonly invitation: Readonly<InvitationControlDescriptor>;
}

/** Safe failure that never includes a verified email or fuzzy alternatives. */
export class InvitationControlFailure extends Error {
  readonly code: InvitationControlFailureCode;

  constructor(code: InvitationControlFailureCode, message: string) {
    super(message);
    this.name = "InvitationControlFailure";
    this.code = code;
  }
}

export interface InvitationControlSafeEvent {
  readonly event:
    | "invitation_created"
    | "invitation_replayed"
    | "invitation_conflict"
    | "invitation_denied"
    | "invitation_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface InvitationControlSafeLogger {
  record(event: Readonly<InvitationControlSafeEvent>): void | Promise<void>;
}

export interface InvitationControlDependencies {
  readonly invitations: OrdinaryMindStore;
  readonly objects: ObjectStore;
  readonly ids: InvitationLifecycleIdGenerator;
  readonly identityProvider?: string;
  readonly logger?: InvitationControlSafeLogger;
}

function normalizeInvitationVerifiedEmail(
  input: unknown,
): SensitiveExternalBinding | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 320) {
    return null;
  }
  const trimmed = input.trim();
  if (!INVITATION_ASCII_PATTERN.test(trimmed)) return null;
  const normalized = trimmed.toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 254 ||
    /\s|[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  const parts = normalized.split("@");
  if (parts.length !== 2) return null;
  const local = parts[0];
  const domain = parts[1];
  if (
    local === undefined ||
    domain === undefined ||
    local.length === 0 ||
    local.length > 64 ||
    domain.length === 0 ||
    domain.length > 253 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !INVITATION_LOCAL_PART_PATTERN.test(local)
  ) {
    return null;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !INVITATION_DOMAIN_LABEL_PATTERN.test(label))
  ) {
    return null;
  }
  return normalized as SensitiveExternalBinding;
}

function invitationRole(value: unknown): InvitationRole | null {
  return value === "reader" || value === "editor" || value === "admin"
    ? value
    : null;
}

function invitationMetadataVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new InvitationControlFailure(
      "invalid_metadata_version",
      "A valid expected metadata version is required.",
    );
  }
}

function invitationIdempotencyKey(value: unknown) {
  try {
    return idempotencyKey(value as string);
  } catch {
    throw new InvitationControlFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
}

function invitationExpiry(occurredAt: UtcInstant): UtcInstant | null {
  const current = Date.parse(occurredAt);
  const expiry = current + INVITATION_EXPIRY_MILLISECONDS;
  if (!Number.isFinite(current) || !Number.isFinite(expiry)) return null;
  try {
    return new Date(expiry).toISOString() as UtcInstant;
  } catch {
    return null;
  }
}

function invitationDescriptor(
  snapshot: Readonly<InvitationSnapshot>,
  replayed: boolean,
): Readonly<InvitationControlDescriptor> {
  return Object.freeze({
    invitationId: snapshot.invitation.invitationId,
    mindId: snapshot.invitation.spaceId,
    target: Object.freeze({ ...snapshot.target }),
    proposedRole: snapshot.invitation.proposedRole,
    state: "pending",
    expiresAt: snapshot.invitation.expiresAt,
    invitationVersion: snapshot.invitation.version,
    replayed,
  });
}

function recordInvitationEvent(
  logger: InvitationControlSafeLogger | undefined,
  event: InvitationControlSafeEvent["event"],
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

function invitationAuthorizationFailure(code: string): InvitationControlFailure {
  if (code === "authentication_required") {
    return new InvitationControlFailure(
      "authentication_required",
      "A registered Sites principal is required.",
    );
  }
  if (code === "authorization_state_unavailable" || code === "access_denied") {
    return new InvitationControlFailure("mind_not_found", "Mind was not found.");
  }
  return new InvitationControlFailure(
    "forbidden",
    "Current membership-management access is required.",
  );
}

/** Registered-principal invitation creation for the trusted Sites control plane. */
export class InvitationControlService {
  readonly #invitations: OrdinaryMindStore;
  readonly #objects: ObjectStore;
  readonly #ids: InvitationLifecycleIdGenerator;
  readonly #identityProvider: string;
  readonly #logger: InvitationControlSafeLogger | undefined;

  constructor(dependencies: InvitationControlDependencies) {
    this.#invitations = dependencies.invitations;
    this.#objects = dependencies.objects;
    this.#ids = dependencies.ids;
    this.#identityProvider =
      dependencies.identityProvider ?? INVITATION_SITES_IDENTITY_PROVIDER;
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(this.#identityProvider)) {
      throw new TypeError("identity provider is invalid");
    }
    this.#logger = dependencies.logger;
  }

  async createInvitation(
    actor: ActorContext,
    command: CreateInvitationCommand,
  ): Promise<Readonly<InvitationControlDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordInvitationEvent(this.#logger, "invitation_denied", requestId);
      throw new InvitationControlFailure(
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
      throw new InvitationControlFailure("mind_not_found", "Mind was not found.");
    }
    const normalizedBinding = normalizeInvitationVerifiedEmail(
      command.targetVerifiedEmail,
    );
    if (normalizedBinding === null) {
      throw new InvitationControlFailure(
        "invalid_target_verified_email",
        "A valid exact verified email is required.",
      );
    }
    const proposedRole = invitationRole(command.role);
    if (proposedRole === null) {
      throw new InvitationControlFailure(
        "invalid_role",
        "Invitation role must be reader, editor, or admin.",
      );
    }
    const expectedMetadataVersion = invitationMetadataVersion(
      command.expectedMetadataVersion,
    );
    const checkedIdempotencyKey = invitationIdempotencyKey(
      command.idempotencyKey,
    );
    const expiresAt = invitationExpiry(trustedActor.occurredAtUtc);
    if (expiresAt === null) {
      throw new InvitationControlFailure(
        "invitation_unavailable",
        "Invitation creation is unavailable.",
      );
    }

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-create-invitation-v1",
          mind_id: command.mindId,
          target_verified_email: normalizedBinding,
          proposed_role: proposedRole,
          expected_metadata_version: expectedMetadataVersion,
        })}\n`),
      );
      const created = await this.#invitations.runOrdinaryMindTransaction(
        async (transaction) => {
          const targetMind = await transaction.classifyPersonalMindTarget({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
          });
          if (targetMind.kind === "own_personal") {
            throw new InvitationControlFailure(
              "personal_mind_operation_forbidden",
              "Personal Mind cannot have invitations.",
            );
          }
          if (targetMind.kind === "not_found") {
            throw new InvitationControlFailure("mind_not_found", "Mind was not found.");
          }
          const authorization = await new CapabilityAuthorizer(
            transaction,
          ).authorize({
            actor,
            spaceId: command.mindId,
            capability:
              proposedRole === "admin"
                ? "members:manage-admin"
                : "members:manage-basic",
            revisionMode: "head",
          });
          if (authorization.kind === "denied") {
            throw invitationAuthorizationFailure(authorization.code);
          }
          if (authorization.grant.kind !== "membership") {
            throw new InvitationControlFailure(
              "forbidden",
              "Current membership-management access is required.",
            );
          }
          const target = await transaction.readRegisteredPrincipalByExternalBinding({
            provider: this.#identityProvider,
            normalizedBinding,
          });
          if (target === null) {
            throw new InvitationControlFailure(
              "registered_principal_not_found",
              "Registered principal was not found.",
            );
          }
          const invitationId = this.#ids.nextInvitationId();
          const expiryJobId = this.#ids.nextInvitationExpiryJobId();
          return transaction.createInvitation({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            target,
            invitation: Object.freeze({
              invitationId,
              spaceId: command.mindId,
              targetPrincipalId: target.principalId,
              proposedRole,
              state: "pending" as const,
              expiresAt,
              version: version(1),
              createdAt: trustedActor.occurredAtUtc,
              createdBy: trustedActor.principalId,
              updatedAt: trustedActor.occurredAtUtc,
              updatedBy: trustedActor.principalId,
            }),
            expectedMetadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
            expiryJob: Object.freeze({
              jobId: expiryJobId,
              target: Object.freeze({ kind: "expire_invitation" as const, invitationId }),
              state: "queued" as const,
              version: version(1),
              attempts: 0,
              availableAt: expiresAt,
              claimExpiresAt: null,
              createdAt: trustedActor.occurredAtUtc,
              updatedAt: trustedActor.occurredAtUtc,
            }),
          });
        },
      );
      if (created.kind === "created") {
        recordInvitationEvent(
          this.#logger,
          created.replayed ? "invitation_replayed" : "invitation_created",
          requestId,
        );
        return invitationDescriptor(created.invitation, created.replayed);
      }
      if (created.kind === "metadata_conflict") {
        throw new InvitationControlFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (created.kind === "personal_mind") {
        throw new InvitationControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind cannot have invitations.",
        );
      }
      if (created.kind === "mind_not_found") {
        throw new InvitationControlFailure("mind_not_found", "Mind was not found.");
      }
      if (created.kind === "forbidden") {
        throw new InvitationControlFailure(
          "forbidden",
          "Current membership-management access is required.",
        );
      }
      if (created.kind === "active_membership_exists") {
        throw new InvitationControlFailure(
          "active_membership_exists",
          "The registered principal is already an active participant.",
        );
      }
      if (created.kind === "pending_invitation_exists") {
        throw new InvitationControlFailure(
          "pending_invitation_exists",
          "A pending invitation already exists for the registered principal.",
        );
      }
      if (created.kind === "idempotency_conflict") {
        throw new InvitationControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (created.kind === "record_conflict") {
        throw new InvitationControlFailure(
          "invitation_conflict",
          "Invitation creation conflicted with current state.",
        );
      }
      if (created.kind === "expiry_job_conflict") {
        throw new InvitationControlFailure(
          "invitation_conflict",
          "Invitation expiry scheduling conflicted with current state.",
        );
      }
      throw new InvitationControlFailure(
        "invitation_unavailable",
        "Invitation creation is unavailable.",
      );
    } catch (error) {
      if (error instanceof InvitationControlFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "idempotency_conflict" ||
          error.code === "invitation_conflict" ||
          error.code === "pending_invitation_exists" ||
          error.code === "active_membership_exists"
        ) {
          recordInvitationEvent(this.#logger, "invitation_conflict", requestId);
        } else if (
          error.code === "authentication_required" ||
          error.code === "mind_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "registered_principal_not_found" ||
          error.code === "forbidden"
        ) {
          recordInvitationEvent(this.#logger, "invitation_denied", requestId);
        }
      } else {
        recordInvitationEvent(this.#logger, "invitation_failed", requestId);
      }
      throw error;
    }
  }

  acceptInvitation(actor: ActorContext, command: InvitationLifecycleCommand) {
    return this.#transitionInvitation(actor, command, "accept_invitation");
  }

  rejectInvitation(actor: ActorContext, command: InvitationLifecycleCommand) {
    return this.#transitionInvitation(actor, command, "reject_invitation");
  }

  cancelInvitation(actor: ActorContext, command: InvitationLifecycleCommand) {
    return this.#transitionInvitation(actor, command, "cancel_invitation");
  }

  async #transitionInvitation(
    actor: ActorContext,
    command: InvitationLifecycleCommand,
    operation: "accept_invitation" | "reject_invitation" | "cancel_invitation",
  ): Promise<Readonly<InvitationLifecycleDescriptor>> {
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      throw new InvitationControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      !command ||
      typeof command.invitationId !== "string" ||
      command.invitationId.length === 0 ||
      command.invitationId.length > 128
    ) {
      throw new InvitationControlFailure("invitation_unavailable", "Invitation is unavailable.");
    }
    let expectedInvitationVersion;
    try {
      expectedInvitationVersion = version(command.expectedInvitationVersion);
    } catch {
      throw new InvitationControlFailure(
        "invalid_invitation_version",
        "A valid expected invitation version is required.",
      );
    }
    const checkedKey = invitationIdempotencyKey(command.idempotencyKey);
    const canonicalRequestHash = await this.#objects.calculateSha256(
      PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-invitation-transition-v1",
        operation,
        invitation_id: command.invitationId,
        expected_invitation_version: expectedInvitationVersion,
      })}\n`),
    );
    const membershipId = operation === "accept_invitation"
      ? this.#ids.nextMembershipId()
      : null;
    const transitioned = await this.#invitations.runOrdinaryMindTransaction(
      (transaction) => transaction.transitionInvitation({
        operation,
        principalId: trustedActor.principalId,
        invitationId: command.invitationId as InvitationSnapshot["invitation"]["invitationId"],
        expectedInvitationVersion,
        membershipId,
        idempotencyKey: checkedKey,
        canonicalRequestHash,
        occurredAt: trustedActor.occurredAtUtc,
      }),
    );
    if (transitioned.kind !== "transitioned") {
      const mapped = transitioned.kind === "invitation_expired"
        ? "invitation_expired"
        : transitioned.kind === "idempotency_conflict"
          ? "idempotency_conflict"
          : transitioned.kind === "invitation_version_conflict" ||
              transitioned.kind === "record_conflict" ||
              transitioned.kind === "active_membership_exists"
            ? "invitation_conflict"
            : transitioned.kind === "forbidden"
              ? "forbidden"
              : "invitation_unavailable";
      throw new InvitationControlFailure(mapped, "Invitation transition was not applied.");
    }
    const result = transitioned.result;
    return Object.freeze({
      invitationId: result.invitation.invitation.invitationId,
      mindId: result.invitation.invitation.spaceId,
      proposedRole: result.invitation.invitation.proposedRole,
      state: result.invitation.invitation.state as "accepted" | "rejected" | "cancelled",
      invitationVersion: result.invitation.invitation.version,
      membershipId: result.membership?.membershipId ?? null,
      replayed: transitioned.replayed,
    });
  }

  async reissueInvitation(
    actor: ActorContext,
    command: InvitationLifecycleCommand,
  ): Promise<Readonly<ReissueInvitationDescriptor>> {
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      throw new InvitationControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (!command || typeof command.invitationId !== "string" || command.invitationId.length === 0) {
      throw new InvitationControlFailure("invitation_unavailable", "Invitation is unavailable.");
    }
    let expectedInvitationVersion;
    try {
      expectedInvitationVersion = version(command.expectedInvitationVersion);
    } catch {
      throw new InvitationControlFailure(
        "invalid_invitation_version",
        "A valid expected invitation version is required.",
      );
    }
    const checkedKey = invitationIdempotencyKey(command.idempotencyKey);
    const expiresAt = invitationExpiry(trustedActor.occurredAtUtc);
    if (expiresAt === null) {
      throw new InvitationControlFailure("invitation_unavailable", "Invitation is unavailable.");
    }
    const canonicalRequestHash = await this.#objects.calculateSha256(
      PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-reissue-invitation-v1",
        invitation_id: command.invitationId,
        expected_invitation_version: expectedInvitationVersion,
      })}\n`),
    );
    const replacementInvitationId = this.#ids.nextInvitationId();
    const expiryJobId = this.#ids.nextInvitationExpiryJobId();
    const result = await this.#invitations.runOrdinaryMindTransaction(
      (transaction) => transaction.reissueInvitation({
        principalId: trustedActor.principalId,
        invitationId: command.invitationId as InvitationSnapshot["invitation"]["invitationId"],
        expectedInvitationVersion,
        replacementInvitationId,
        expiryJobId,
        expiresAt,
        idempotencyKey: checkedKey,
        canonicalRequestHash,
        occurredAt: trustedActor.occurredAtUtc,
      }),
    );
    if (result.kind !== "reissued") {
      const mapped = result.kind === "idempotency_conflict"
        ? "idempotency_conflict"
        : result.kind === "forbidden"
          ? "forbidden"
          : result.kind === "pending_invitation_exists" ||
              result.kind === "invitation_version_conflict" ||
              result.kind === "record_conflict" ||
              result.kind === "expiry_job_conflict"
            ? "invitation_conflict"
            : "invitation_unavailable";
      throw new InvitationControlFailure(mapped, "Invitation reissue was not applied.");
    }
    return Object.freeze({
      previousInvitationId: command.invitationId,
      invitation: invitationDescriptor(result.invitation, result.replayed),
    });
  }
}
