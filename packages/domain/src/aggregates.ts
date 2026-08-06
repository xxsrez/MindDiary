import type { PrincipalId, SpaceId, UtcInstant } from "./ids.js";
import type {
  ExternalIdentityBinding,
  KnowledgeSpace,
  PersonalSpaceBinding,
  Principal,
  SpaceInvitation,
  SpaceMembership,
  Version,
  Visibility,
} from "./records.js";
import {
  INVITATION_STATES,
  MEMBERSHIP_STATES,
  ROLES,
  SPACE_LIFECYCLE_STATES,
  VISIBILITIES,
  version,
} from "./records.js";

export type DomainInvariantCode =
  | "record_space_mismatch"
  | "invalid_record"
  | "duplicate_active_membership"
  | "duplicate_pending_invitation"
  | "ordinary_owner_count"
  | "personal_binding_mismatch"
  | "personal_visibility"
  | "personal_membership"
  | "personal_invitation"
  | "duplicate_personal_binding"
  | "principal_binding_mismatch"
  | "principal_not_active"
  | "space_not_active"
  | "membership_not_active"
  | "owner_required"
  | "ownership_target_invalid"
  | "invitation_not_pending"
  | "invitation_target_mismatch"
  | "invitation_expired"
  | "invitation_role_mismatch"
  | "stale_version";

export class DomainInvariantError extends Error {
  readonly code: DomainInvariantCode;

  constructor(code: DomainInvariantCode, message: string) {
    super(message);
    this.name = "DomainInvariantError";
    this.code = code;
  }
}

export interface SpaceAggregateSnapshot {
  readonly kind: "ordinary" | "personal";
  readonly space: Readonly<KnowledgeSpace>;
  readonly personalBinding: Readonly<PersonalSpaceBinding> | null;
  readonly memberships: readonly Readonly<SpaceMembership>[];
  readonly invitations: readonly Readonly<SpaceInvitation>[];
}

function freezeRecord<T extends object>(record: T): Readonly<T> {
  return Object.freeze({ ...record });
}

function sameSpace(actual: SpaceId, expected: SpaceId): boolean {
  return actual === expected;
}

function activeMembershipForPrincipal(
  memberships: readonly Readonly<SpaceMembership>[],
  principalId: PrincipalId,
): Readonly<SpaceMembership> | undefined {
  return memberships.find(
    (membership) =>
      membership.principalId === principalId && membership.state === "active",
  );
}

function ensureVersion(actual: Version, expected: Version, subject: string): void {
  if (actual !== expected) {
    throw new DomainInvariantError(
      "stale_version",
      `${subject} version ${String(expected)} is stale; current is ${String(actual)}`,
    );
  }
}

function validateCommon(
  space: KnowledgeSpace,
  memberships: readonly SpaceMembership[],
  invitations: readonly SpaceInvitation[],
): void {
  if (
    !SPACE_LIFECYCLE_STATES.includes(space.state) ||
    !VISIBILITIES.includes(space.visibility)
  ) {
    throw new DomainInvariantError("invalid_record", "Mind lifecycle or visibility is invalid");
  }
  assertVersion(space.metadataVersion, "Mind metadata");
  assertVersion(space.accessVersion, "Mind access");
  const activePrincipals = new Set<PrincipalId>();
  for (const membership of memberships) {
    if (!MEMBERSHIP_STATES.includes(membership.state) || !ROLES.includes(membership.role)) {
      throw new DomainInvariantError("invalid_record", "membership state or role is invalid");
    }
    assertVersion(membership.version, "membership");
    if (!sameSpace(membership.spaceId, space.spaceId)) {
      throw new DomainInvariantError(
        "record_space_mismatch",
        "membership belongs to a different Mind",
      );
    }
    if (membership.state === "active") {
      if (activePrincipals.has(membership.principalId)) {
        throw new DomainInvariantError(
          "duplicate_active_membership",
          "a principal may have only one active membership in a Mind",
        );
      }
      activePrincipals.add(membership.principalId);
    }
  }

  const pendingTargets = new Set<PrincipalId>();
  for (const invitation of invitations) {
    if (
      !INVITATION_STATES.includes(invitation.state) ||
      !["reader", "editor", "admin"].includes(invitation.proposedRole) ||
      !Number.isFinite(Date.parse(invitation.expiresAt))
    ) {
      throw new DomainInvariantError("invalid_record", "invitation lifecycle or role is invalid");
    }
    assertVersion(invitation.version, "invitation");
    if (!sameSpace(invitation.spaceId, space.spaceId)) {
      throw new DomainInvariantError(
        "record_space_mismatch",
        "invitation belongs to a different Mind",
      );
    }
    if (invitation.state === "pending") {
      if (pendingTargets.has(invitation.targetPrincipalId)) {
        throw new DomainInvariantError(
          "duplicate_pending_invitation",
          "a principal may have only one pending invitation to a Mind",
        );
      }
      pendingTargets.add(invitation.targetPrincipalId);
    }
  }
}

function assertVersion(actual: Version, subject: string): void {
  try {
    version(actual);
  } catch {
    throw new DomainInvariantError("invalid_record", `${subject} version is invalid`);
  }
}

function validateOrdinary(
  space: KnowledgeSpace,
  memberships: readonly SpaceMembership[],
): void {
  if (space.state !== "active") return;
  const owners = memberships.filter(
    (membership) => membership.state === "active" && membership.role === "owner",
  );
  if (owners.length !== 1) {
    throw new DomainInvariantError(
      "ordinary_owner_count",
      "an active ordinary Mind must have exactly one active Owner",
    );
  }
}

function validatePersonal(
  space: KnowledgeSpace,
  binding: PersonalSpaceBinding,
  memberships: readonly SpaceMembership[],
  invitations: readonly SpaceInvitation[],
): void {
  if (!sameSpace(binding.spaceId, space.spaceId)) {
    throw new DomainInvariantError(
      "personal_binding_mismatch",
      "Personal Mind binding points to a different Mind",
    );
  }
  if (space.visibility !== "private") {
    throw new DomainInvariantError("personal_visibility", "Personal Mind must be private");
  }
  const validMembership =
    memberships.length === 1 &&
    memberships[0]?.state === "active" &&
    memberships[0].role === "owner" &&
    memberships[0].principalId === binding.principalId;
  if (!validMembership) {
    throw new DomainInvariantError(
      "personal_membership",
      "Personal Mind must have its bound principal as sole active Owner",
    );
  }
  if (invitations.length > 0) {
    throw new DomainInvariantError(
      "personal_invitation",
      "Personal Mind cannot have invitations",
    );
  }
}

export class SpaceAggregate {
  readonly #kind: "ordinary" | "personal";
  readonly #space: Readonly<KnowledgeSpace>;
  readonly #binding: Readonly<PersonalSpaceBinding> | null;
  readonly #memberships: readonly Readonly<SpaceMembership>[];
  readonly #invitations: readonly Readonly<SpaceInvitation>[];

  private constructor(snapshot: SpaceAggregateSnapshot) {
    validateCommon(snapshot.space, snapshot.memberships, snapshot.invitations);
    if (snapshot.kind === "ordinary") {
      if (snapshot.personalBinding !== null) {
        throw new DomainInvariantError(
          "personal_binding_mismatch",
          "ordinary Mind cannot carry a Personal binding",
        );
      }
      validateOrdinary(snapshot.space, snapshot.memberships);
    } else {
      if (snapshot.personalBinding === null) {
        throw new DomainInvariantError(
          "personal_binding_mismatch",
          "Personal Mind requires a Personal binding",
        );
      }
      validatePersonal(
        snapshot.space,
        snapshot.personalBinding,
        snapshot.memberships,
        snapshot.invitations,
      );
    }

    this.#kind = snapshot.kind;
    this.#space = freezeRecord(snapshot.space);
    this.#binding =
      snapshot.personalBinding === null ? null : freezeRecord(snapshot.personalBinding);
    this.#memberships = Object.freeze(snapshot.memberships.map(freezeRecord));
    this.#invitations = Object.freeze(snapshot.invitations.map(freezeRecord));
    Object.freeze(this);
  }

  static restoreOrdinary(input: {
    readonly space: KnowledgeSpace;
    readonly memberships: readonly SpaceMembership[];
    readonly invitations?: readonly SpaceInvitation[];
  }): SpaceAggregate {
    return new SpaceAggregate({
      kind: "ordinary",
      space: input.space,
      personalBinding: null,
      memberships: input.memberships,
      invitations: input.invitations ?? [],
    });
  }

  static restorePersonal(input: {
    readonly space: KnowledgeSpace;
    readonly binding: PersonalSpaceBinding;
    readonly membership: SpaceMembership;
  }): SpaceAggregate {
    return new SpaceAggregate({
      kind: "personal",
      space: input.space,
      personalBinding: input.binding,
      memberships: [input.membership],
      invitations: [],
    });
  }

  snapshot(): SpaceAggregateSnapshot {
    return Object.freeze({
      kind: this.#kind,
      space: this.#space,
      personalBinding: this.#binding,
      memberships: this.#memberships,
      invitations: this.#invitations,
    });
  }

  transferOwnership(input: {
    readonly sourcePrincipalId: PrincipalId;
    readonly targetPrincipalId: PrincipalId;
    readonly expectedMetadataVersion: Version;
    readonly expectedSourceMembershipVersion: Version;
    readonly expectedTargetMembershipVersion: Version;
    readonly occurredAt: UtcInstant;
  }): SpaceAggregate {
    if (this.#kind !== "ordinary") {
      throw new DomainInvariantError(
        "ownership_target_invalid",
        "Personal Mind ownership cannot be transferred",
      );
    }
    if (this.#space.state !== "active") {
      throw new DomainInvariantError("space_not_active", "Mind is not active");
    }
    ensureVersion(this.#space.metadataVersion, input.expectedMetadataVersion, "Mind metadata");
    const source = activeMembershipForPrincipal(
      this.#memberships,
      input.sourcePrincipalId,
    );
    const target = activeMembershipForPrincipal(
      this.#memberships,
      input.targetPrincipalId,
    );
    if (source?.role !== "owner") {
      throw new DomainInvariantError("owner_required", "current active Owner is required");
    }
    if (target === undefined || target.role === "owner") {
      throw new DomainInvariantError(
        "ownership_target_invalid",
        "ownership target must be a different active participant",
      );
    }
    ensureVersion(source.version, input.expectedSourceMembershipVersion, "source membership");
    ensureVersion(target.version, input.expectedTargetMembershipVersion, "target membership");

    const memberships = this.#memberships.map((membership): SpaceMembership => {
      if (membership.membershipId === source.membershipId) {
        return {
          ...membership,
          role: "admin",
          version: version(membership.version + 1),
          updatedAt: input.occurredAt,
          updatedBy: input.sourcePrincipalId,
        };
      }
      if (membership.membershipId === target.membershipId) {
        return {
          ...membership,
          role: "owner",
          version: version(membership.version + 1),
          updatedAt: input.occurredAt,
          updatedBy: input.sourcePrincipalId,
        };
      }
      return membership;
    });
    return SpaceAggregate.restoreOrdinary({
      space: {
        ...this.#space,
        metadataVersion: version(this.#space.metadataVersion + 1),
        accessVersion: version(this.#space.accessVersion + 1),
        updatedAt: input.occurredAt,
      },
      memberships,
      invitations: this.#invitations,
    });
  }

  changeVisibility(input: {
    readonly actorPrincipalId: PrincipalId;
    readonly visibility: Visibility;
    readonly expectedMetadataVersion: Version;
    readonly occurredAt: UtcInstant;
  }): SpaceAggregate {
    if (this.#kind !== "ordinary") {
      throw new DomainInvariantError(
        "personal_visibility",
        "Personal Mind visibility cannot change",
      );
    }
    if (this.#space.state !== "active") {
      throw new DomainInvariantError("space_not_active", "Mind is not active");
    }
    ensureVersion(this.#space.metadataVersion, input.expectedMetadataVersion, "Mind metadata");
    const actorMembership = activeMembershipForPrincipal(
      this.#memberships,
      input.actorPrincipalId,
    );
    if (actorMembership?.role !== "owner") {
      throw new DomainInvariantError(
        "owner_required",
        "visibility change requires the current Owner from aggregate state",
      );
    }
    return SpaceAggregate.restoreOrdinary({
      space: {
        ...this.#space,
        visibility: input.visibility,
        metadataVersion: version(this.#space.metadataVersion + 1),
        accessVersion: version(this.#space.accessVersion + 1),
        updatedAt: input.occurredAt,
      },
      memberships: this.#memberships,
      invitations: this.#invitations,
    });
  }

  addInvitation(invitation: SpaceInvitation): SpaceAggregate {
    if (this.#kind !== "ordinary") {
      throw new DomainInvariantError(
        "personal_invitation",
        "Personal Mind cannot have invitations",
      );
    }
    return SpaceAggregate.restoreOrdinary({
      space: this.#space,
      memberships: this.#memberships,
      invitations: [...this.#invitations, invitation],
    });
  }

  acceptInvitation(input: {
    readonly invitationId: SpaceInvitation["invitationId"];
    readonly targetPrincipalId: PrincipalId;
    readonly expectedInvitationVersion: Version;
    readonly membership: SpaceMembership;
    readonly occurredAt: UtcInstant;
  }): SpaceAggregate {
    const invitation = this.#invitations.find(
      (candidate) => candidate.invitationId === input.invitationId,
    );
    if (invitation?.state !== "pending") {
      throw new DomainInvariantError(
        "invitation_not_pending",
        "invitation is not pending",
      );
    }
    ensureVersion(invitation.version, input.expectedInvitationVersion, "invitation");
    if (invitation.targetPrincipalId !== input.targetPrincipalId) {
      throw new DomainInvariantError(
        "invitation_target_mismatch",
        "only the invitation target can accept",
      );
    }
    if (Date.parse(invitation.expiresAt) <= Date.parse(input.occurredAt)) {
      throw new DomainInvariantError("invitation_expired", "invitation has expired");
    }
    if (
      input.membership.spaceId !== this.#space.spaceId ||
      input.membership.principalId !== invitation.targetPrincipalId ||
      input.membership.role !== invitation.proposedRole ||
      input.membership.state !== "active"
    ) {
      throw new DomainInvariantError(
        "invitation_role_mismatch",
        "accepted membership must match the pending invitation",
      );
    }
    const invitations = this.#invitations.map((candidate): SpaceInvitation =>
      candidate.invitationId === invitation.invitationId
        ? {
            ...candidate,
            state: "accepted",
            version: version(candidate.version + 1),
            updatedAt: input.occurredAt,
            updatedBy: input.targetPrincipalId,
          }
        : candidate,
    );
    return SpaceAggregate.restoreOrdinary({
      space: {
        ...this.#space,
        metadataVersion: version(this.#space.metadataVersion + 1),
        accessVersion: version(this.#space.accessVersion + 1),
        updatedAt: input.occurredAt,
      },
      memberships: [...this.#memberships, input.membership],
      invitations,
    });
  }
}

export class PersonalMindDirectory {
  readonly #bindings: readonly Readonly<PersonalSpaceBinding>[];

  private constructor(bindings: readonly PersonalSpaceBinding[]) {
    const principals = new Set<PrincipalId>();
    const spaces = new Set<SpaceId>();
    for (const binding of bindings) {
      assertVersion(binding.version, "Personal binding");
      if (principals.has(binding.principalId) || spaces.has(binding.spaceId)) {
        throw new DomainInvariantError(
          "duplicate_personal_binding",
          "a principal and a Mind may each have only one Personal binding",
        );
      }
      principals.add(binding.principalId);
      spaces.add(binding.spaceId);
    }
    this.#bindings = Object.freeze(bindings.map(freezeRecord));
    Object.freeze(this);
  }

  static restore(bindings: readonly PersonalSpaceBinding[]): PersonalMindDirectory {
    return new PersonalMindDirectory(bindings);
  }

  bind(binding: PersonalSpaceBinding): PersonalMindDirectory {
    return new PersonalMindDirectory([...this.#bindings, binding]);
  }

  forPrincipal(principalId: PrincipalId): Readonly<PersonalSpaceBinding> | null {
    return this.#bindings.find((binding) => binding.principalId === principalId) ?? null;
  }

  records(): readonly Readonly<PersonalSpaceBinding>[] {
    return this.#bindings;
  }
}

export interface PrincipalAccountSnapshot {
  readonly principal: Readonly<Principal>;
  readonly externalBindings: readonly Readonly<ExternalIdentityBinding>[];
  readonly personalMind: SpaceAggregateSnapshot;
}

export class PrincipalAccount {
  readonly #snapshot: PrincipalAccountSnapshot;

  private constructor(input: {
    readonly principal: Principal;
    readonly externalBindings: readonly ExternalIdentityBinding[];
    readonly personalMind: SpaceAggregate;
  }) {
    if (input.principal.state !== "active") {
      throw new DomainInvariantError("principal_not_active", "account principal must be active");
    }
    assertVersion(input.principal.profileVersion, "principal profile");
    const personal = input.personalMind.snapshot();
    if (
      personal.kind !== "personal" ||
      personal.personalBinding?.principalId !== input.principal.principalId
    ) {
      throw new DomainInvariantError(
        "principal_binding_mismatch",
        "account must contain exactly one Personal Mind bound to its principal",
      );
    }
    if (
      input.externalBindings.some(
        (binding) => binding.principalId !== input.principal.principalId,
      )
    ) {
      throw new DomainInvariantError(
        "principal_binding_mismatch",
        "external binding belongs to a different principal",
      );
    }
    if (!input.externalBindings.some((binding) => binding.state === "active")) {
      throw new DomainInvariantError(
        "principal_binding_mismatch",
        "active account requires an active external identity binding",
      );
    }
    for (const binding of input.externalBindings) {
      assertVersion(binding.version, "external identity binding");
    }
    this.#snapshot = Object.freeze({
      principal: freezeRecord(input.principal),
      externalBindings: Object.freeze(input.externalBindings.map(freezeRecord)),
      personalMind: personal,
    });
    Object.freeze(this);
  }

  static restore(input: {
    readonly principal: Principal;
    readonly externalBindings: readonly ExternalIdentityBinding[];
    readonly personalMind: SpaceAggregate;
  }): PrincipalAccount {
    return new PrincipalAccount(input);
  }

  snapshot(): PrincipalAccountSnapshot {
    return this.#snapshot;
  }
}
