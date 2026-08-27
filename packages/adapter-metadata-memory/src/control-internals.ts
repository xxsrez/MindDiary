import {
  PrincipalAccount,
  SpaceAggregate,
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
  roleHasCapability,
  version,
  type AccountBootstrapRecordSet,
  type AccountDeletionCleanupWorkItem,
  type AccountDeletionImpactSnapshot,
  type AuditEvent,
  type AuditOutboxMessage,
  type AuthorizationStateQuery,
  type ChangeOrdinaryMindVisibilityRequest,
  type CreateInvitationRequest,
  type ExternalIdentityBinding,
  type ExternalIdentityBindingLookup,
  type InvitationLifecycleSnapshot,
  type InvitationSnapshot,
  type KnowledgeSpace,
  type MembershipMutationReplayRequest,
  type MembershipMutationReplayResult,
  type OrdinaryMindDeletionCleanupWorkItem,
  type OrdinaryMindDeletionImpactSnapshot,
  type OrdinaryMindRecordSet,
  type OrdinaryMindSnapshot,
  type OwnershipTransferSnapshot,
  type PersonalMindProfileSnapshot,
  type PersonalSpaceBinding,
  type Principal,
  type PrincipalAccountSnapshot,
  type RegisteredPrincipalSnapshot,
  type ReissueInvitationRequest,
  type RenameOrdinaryMindRequest,
  type RenamePersonalProfileRequest,
  type SpaceInvitation,
  type SpaceMembership,
  type TransferOrdinaryMindOwnershipRequest,
  type TransitionInvitationRequest,
} from "@mind-diary/application-ports";

import {
  SHA256_PATTERN,
  cloneAuditEvent,
  cloneAuditOutbox,
  BOUNDED_OPAQUE_ID,
  type AuditEventId,
  type OutboxMessageId,
  type AuthorizationState,
} from "./revision-internals.js";

export type PrincipalMap = Map<Principal["principalId"], Readonly<Principal>>;
export type ExternalBindingMap = Map<string, Readonly<ExternalIdentityBinding>>;
export type KnowledgeSpaceMap = Map<KnowledgeSpace["spaceId"], Readonly<KnowledgeSpace>>;
export type PersonalBindingMap = Map<
  PersonalSpaceBinding["principalId"],
  Readonly<PersonalSpaceBinding>
>;
export type MembershipMap = Map<
  SpaceMembership["membershipId"],
  Readonly<SpaceMembership>
>;
export type InvitationMap = Map<
  SpaceInvitation["invitationId"],
  Readonly<SpaceInvitation>
>;

export interface PersonalProfileIdempotencyRecord {
  readonly principalId: Principal["principalId"];
  readonly key: RenamePersonalProfileRequest["idempotencyKey"];
  readonly canonicalRequestHash: RenamePersonalProfileRequest["canonicalRequestHash"];
  readonly profile: Readonly<PersonalMindProfileSnapshot>;
}

export function externalBindingKey(
  lookup: Readonly<ExternalIdentityBindingLookup>,
): string {
  return `${lookup.provider}\u0000${lookup.normalizedBinding}`;
}

export function freezePrincipal(record: Readonly<Principal>): Readonly<Principal> {
  return Object.freeze({ ...record });
}

export function freezeExternalBinding(
  record: Readonly<ExternalIdentityBinding>,
): Readonly<ExternalIdentityBinding> {
  return Object.freeze({ ...record });
}

export function freezeKnowledgeSpace(
  record: Readonly<KnowledgeSpace>,
): Readonly<KnowledgeSpace> {
  return Object.freeze({ ...record });
}

export function freezePersonalBinding(
  record: Readonly<PersonalSpaceBinding>,
): Readonly<PersonalSpaceBinding> {
  return Object.freeze({ ...record });
}

export function freezeMembership(
  record: Readonly<SpaceMembership>,
): Readonly<SpaceMembership> {
  return Object.freeze({ ...record });
}

export function freezeInvitation(
  record: Readonly<SpaceInvitation>,
): Readonly<SpaceInvitation> {
  return Object.freeze({ ...record });
}

export function freezeRegisteredPrincipalSnapshot(
  principal: Readonly<RegisteredPrincipalSnapshot>,
): Readonly<RegisteredPrincipalSnapshot> {
  return Object.freeze({ ...principal });
}

export function freezeInvitationSnapshot(
  snapshot: Readonly<InvitationSnapshot>,
): Readonly<InvitationSnapshot> {
  return Object.freeze({
    invitation: freezeInvitation(snapshot.invitation),
    target: freezeRegisteredPrincipalSnapshot(snapshot.target),
  });
}

export function freezeInvitationLifecycleSnapshot(
  snapshot: Readonly<InvitationLifecycleSnapshot>,
): Readonly<InvitationLifecycleSnapshot> {
  return Object.freeze({
    invitation: freezeInvitationSnapshot(snapshot.invitation),
    membership: snapshot.membership === null ? null : freezeMembership(snapshot.membership),
  });
}

export function cloneRecordMap<Key, Value extends object>(
  source: ReadonlyMap<Key, Readonly<Value>>,
  clone: (value: Readonly<Value>) => Readonly<Value>,
): Map<Key, Readonly<Value>> {
  return new Map([...source].map(([key, value]) => [key, clone(value)]));
}

export function currentSitesAuthorizationStateFromMaps(
  query: AuthorizationStateQuery,
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  knowledgeSpaces: ReadonlyMap<
    KnowledgeSpace["spaceId"],
    Readonly<KnowledgeSpace>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): AuthorizationState | null {
  if (query.tokenId !== null) return null;
  const principal = principals.get(query.principalId);
  const space = knowledgeSpaces.get(query.spaceId);
  if (!principal || !space) return null;
  const matchingMemberships = [...memberships.values()]
    .filter(
      (membership) =>
        membership.principalId === query.principalId &&
        membership.spaceId === query.spaceId,
    )
    .sort((left, right) => right.version - left.version);
  const activeMemberships = matchingMemberships.filter(
    (membership) => membership.state === "active",
  );
  if (activeMemberships.length > 1) return null;
  const membership = activeMemberships[0] ?? matchingMemberships[0] ?? null;
  return Object.freeze({
    principal: Object.freeze({
      principalId: principal.principalId,
      state: principal.state,
    }),
    space: Object.freeze({
      spaceId: space.spaceId,
      state: space.state,
      visibility: space.visibility,
      accessVersion: space.accessVersion,
    }),
    membership:
      membership === null
        ? null
        : Object.freeze({
            principalId: membership.principalId,
            spaceId: membership.spaceId,
            role: membership.role,
            state: membership.state,
            version: membership.version,
          }),
    token: null,
  });
}

export function accountFromMaps(
  principalId: Principal["principalId"],
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  externalBindings: ReadonlyMap<string, Readonly<ExternalIdentityBinding>>,
  knowledgeSpaces: ReadonlyMap<KnowledgeSpace["spaceId"], Readonly<KnowledgeSpace>>,
  personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<PrincipalAccountSnapshot> | null {
  const principal = principals.get(principalId);
  const personalBinding = personalBindings.get(principalId);
  if (!principal || !personalBinding) return null;
  const personalSpace = knowledgeSpaces.get(personalBinding.spaceId);
  if (!personalSpace) return null;
  const accountBindings = [...externalBindings.values()].filter(
    (binding) => binding.principalId === principalId,
  );
  const personalMemberships = [...memberships.values()].filter(
    (membership) => membership.spaceId === personalSpace.spaceId,
  );
  if (personalMemberships.length !== 1) return null;
  const personal = SpaceAggregate.restorePersonal({
    space: personalSpace,
    binding: personalBinding,
    membership: personalMemberships[0]!,
  });
  return PrincipalAccount.restore({
    principal,
    externalBindings: accountBindings,
    personalMind: personal,
  }).snapshot();
}

export function accountByBindingFromMaps(
  lookup: Readonly<ExternalIdentityBindingLookup>,
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  externalBindings: ReadonlyMap<string, Readonly<ExternalIdentityBinding>>,
  knowledgeSpaces: ReadonlyMap<KnowledgeSpace["spaceId"], Readonly<KnowledgeSpace>>,
  personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<PrincipalAccountSnapshot> | null {
  const binding = externalBindings.get(externalBindingKey(lookup));
  if (!binding || binding.state !== "active") return null;
  return accountFromMaps(
    binding.principalId,
    principals,
    externalBindings,
    knowledgeSpaces,
    personalBindings,
    memberships,
  );
}

export function freezePersonalMindProfile(
  profile: Readonly<PersonalMindProfileSnapshot>,
): Readonly<PersonalMindProfileSnapshot> {
  return Object.freeze({
    principalId: profile.principalId,
    displayName: profile.displayName,
    profileVersion: profile.profileVersion,
    personalMind: Object.freeze({ ...profile.personalMind }),
  });
}

export function personalMindProfileFromAccount(
  account: Readonly<PrincipalAccountSnapshot>,
): Readonly<PersonalMindProfileSnapshot> {
  const space = account.personalMind.space;
  return freezePersonalMindProfile({
    principalId: account.principal.principalId,
    displayName: account.principal.displayName,
    profileVersion: account.principal.profileVersion,
    personalMind: {
      spaceId: space.spaceId,
      name: space.name,
      visibility: "private",
      metadataVersion: space.metadataVersion,
      headRevisionId: space.headRevisionId,
    },
  });
}

export function personalProfileIdempotencyKey(
  principalId: Principal["principalId"],
  key: RenamePersonalProfileRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000rename_account\u0000${key}`;
}

export function clonePersonalProfileIdempotencyRecords(
  records: ReadonlyMap<string, Readonly<PersonalProfileIdempotencyRecord>>,
): Map<string, Readonly<PersonalProfileIdempotencyRecord>> {
  return new Map(
    [...records].map(([key, record]) => [
      key,
      Object.freeze({
        ...record,
        profile: freezePersonalMindProfile(record.profile),
      }),
    ]),
  );
}

export function validateAccountBootstrapRecords(
  records: Readonly<AccountBootstrapRecordSet>,
): Readonly<PrincipalAccountSnapshot> | null {
  try {
    const { principal, externalBinding, personalSpace, personalBinding } = records;
    const ownerMembership = records.ownerMembership;
    const revision = records.initialRevision.revision;
    const parsedHandle = parseCanonicalSpaceHandle(personalSpace.spaceHandle);
    if (
      parsedHandle.kind !== "valid" ||
      isReservedTopLevelHandle(parsedHandle.canonicalHandle) ||
      personalSpace.normalizedHandle !== parsedHandle.canonicalHandle ||
      externalBinding.principalId !== principal.principalId ||
      personalBinding.principalId !== principal.principalId ||
      personalBinding.spaceId !== personalSpace.spaceId ||
      ownerMembership.spaceId !== personalSpace.spaceId ||
      ownerMembership.principalId !== principal.principalId ||
      revision.spaceId !== personalSpace.spaceId ||
      revision.revisionId !== personalSpace.headRevisionId ||
      revision.revisionNumber !== 1 ||
      revision.parentRevisionId !== null ||
      revision.committedBy.kind !== "principal" ||
      revision.committedBy.principalId !== principal.principalId ||
      records.initialRevision.manifest.entries.length === 0
    ) {
      return null;
    }
    const personal = SpaceAggregate.restorePersonal({
      space: personalSpace,
      binding: personalBinding,
      membership: ownerMembership,
    });
    return PrincipalAccount.restore({
      principal,
      externalBindings: [externalBinding],
      personalMind: personal,
    }).snapshot();
  } catch {
    return null;
  }
}

export type OrdinaryMindIdempotencyRecord =
  | {
      readonly operation: "create_space_with_owner";
      readonly principalId: Principal["principalId"];
      readonly key: OrdinaryMindRecordSet["idempotencyKey"];
      readonly canonicalRequestHash: OrdinaryMindRecordSet["canonicalRequestHash"];
      readonly mind: Readonly<OrdinaryMindSnapshot>;
    }
  | {
      readonly operation: "rename_space";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: RenameOrdinaryMindRequest["idempotencyKey"];
      readonly canonicalRequestHash: RenameOrdinaryMindRequest["canonicalRequestHash"];
      readonly mind: Readonly<OrdinaryMindSnapshot>;
    }
  | {
      readonly operation: "change_visibility";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: ChangeOrdinaryMindVisibilityRequest["idempotencyKey"];
      readonly canonicalRequestHash: ChangeOrdinaryMindVisibilityRequest["canonicalRequestHash"];
      readonly mind: Readonly<OrdinaryMindSnapshot>;
      readonly changed: boolean;
    }
  | {
      readonly operation: "transfer_ownership";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: TransferOrdinaryMindOwnershipRequest["idempotencyKey"];
      readonly canonicalRequestHash: TransferOrdinaryMindOwnershipRequest["canonicalRequestHash"];
      readonly transfer: Readonly<OwnershipTransferSnapshot>;
    }
  | {
      readonly operation: "create_invitation";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: CreateInvitationRequest["idempotencyKey"];
      readonly canonicalRequestHash: CreateInvitationRequest["canonicalRequestHash"];
      readonly invitation: Readonly<InvitationSnapshot>;
    }
  | {
      readonly operation: "accept_invitation" | "reject_invitation" | "cancel_invitation";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: TransitionInvitationRequest["idempotencyKey"];
      readonly canonicalRequestHash: TransitionInvitationRequest["canonicalRequestHash"];
      readonly lifecycle: Readonly<InvitationLifecycleSnapshot>;
    }
  | {
      readonly operation: "reissue_invitation";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: ReissueInvitationRequest["idempotencyKey"];
      readonly canonicalRequestHash: ReissueInvitationRequest["canonicalRequestHash"];
      readonly invitation: Readonly<InvitationSnapshot>;
    };

export type OrdinaryMindDeletionImpactMap = Map<
  OrdinaryMindDeletionImpactSnapshot["impactId"],
  Readonly<OrdinaryMindDeletionImpactSnapshot>
>;

export type OrdinaryMindDeletionCleanupMap = Map<
  OrdinaryMindDeletionCleanupWorkItem["impactId"],
  Readonly<OrdinaryMindDeletionCleanupWorkItem>
>;

export type AccountDeletionImpactMap = Map<
  AccountDeletionImpactSnapshot["impactId"],
  Readonly<AccountDeletionImpactSnapshot>
>;

export type AccountDeletionCleanupMap = Map<
  AccountDeletionCleanupWorkItem["impactId"],
  Readonly<AccountDeletionCleanupWorkItem>
>;

export function cloneAccountDeletionImpact(
  impact: Readonly<AccountDeletionImpactSnapshot>,
): Readonly<AccountDeletionImpactSnapshot> {
  return Object.freeze({
    ...impact,
    personalMind: Object.freeze({ ...impact.personalMind }),
    ownedMinds: Object.freeze(
      impact.ownedMinds.map((mind) => Object.freeze({ ...mind })),
    ),
  });
}

export function cloneAccountDeletionImpacts(
  source: ReadonlyMap<
    AccountDeletionImpactSnapshot["impactId"],
    Readonly<AccountDeletionImpactSnapshot>
  >,
): AccountDeletionImpactMap {
  return new Map(
    [...source].map(([impactId, impact]) => [
      impactId,
      cloneAccountDeletionImpact(impact),
    ]),
  );
}

export function cloneAccountDeletionCleanup(
  work: Readonly<AccountDeletionCleanupWorkItem>,
): Readonly<AccountDeletionCleanupWorkItem> {
  return Object.freeze({
    ...work,
    deletedSpaceIds: Object.freeze([...work.deletedSpaceIds]),
    objectDigests: Object.freeze([...work.objectDigests]),
    foreignExportJobIds: Object.freeze([...work.foreignExportJobIds]),
  });
}

export function cloneAccountDeletionCleanups(
  source: ReadonlyMap<
    AccountDeletionCleanupWorkItem["impactId"],
    Readonly<AccountDeletionCleanupWorkItem>
  >,
): AccountDeletionCleanupMap {
  return new Map(
    [...source].map(([impactId, work]) => [
      impactId,
      cloneAccountDeletionCleanup(work),
    ]),
  );
}

export function cloneOrdinaryMindDeletionImpact(
  impact: Readonly<OrdinaryMindDeletionImpactSnapshot>,
): Readonly<OrdinaryMindDeletionImpactSnapshot> {
  return Object.freeze({ ...impact });
}

export function cloneOrdinaryMindDeletionImpacts(
  source: ReadonlyMap<
    OrdinaryMindDeletionImpactSnapshot["impactId"],
    Readonly<OrdinaryMindDeletionImpactSnapshot>
  >,
): OrdinaryMindDeletionImpactMap {
  return new Map(
    [...source].map(([impactId, impact]) => [
      impactId,
      cloneOrdinaryMindDeletionImpact(impact),
    ]),
  );
}

export function cloneOrdinaryMindDeletionCleanup(
  work: Readonly<OrdinaryMindDeletionCleanupWorkItem>,
): Readonly<OrdinaryMindDeletionCleanupWorkItem> {
  return Object.freeze({ ...work, objectDigests: Object.freeze([...work.objectDigests]) });
}

export function cloneOrdinaryMindDeletionCleanups(
  source: ReadonlyMap<
    OrdinaryMindDeletionCleanupWorkItem["impactId"],
    Readonly<OrdinaryMindDeletionCleanupWorkItem>
  >,
): OrdinaryMindDeletionCleanupMap {
  return new Map(
    [...source].map(([impactId, work]) => [
      impactId,
      cloneOrdinaryMindDeletionCleanup(work),
    ]),
  );
}

export function freezeOrdinaryMindSnapshot(
  snapshot: Readonly<OrdinaryMindSnapshot>,
): Readonly<OrdinaryMindSnapshot> {
  return Object.freeze({
    space: freezeKnowledgeSpace(snapshot.space),
    ownerMembership: freezeMembership(snapshot.ownerMembership),
  });
}

export function freezeOwnershipTransferSnapshot(
  snapshot: Readonly<OwnershipTransferSnapshot>,
): Readonly<OwnershipTransferSnapshot> {
  return Object.freeze({
    mind: freezeOrdinaryMindSnapshot(snapshot.mind),
    sourceMembership: freezeMembership(snapshot.sourceMembership),
    targetMembership: freezeMembership(snapshot.targetMembership),
  });
}

export function sameKnowledgeSpaceRecord(
  left: Readonly<KnowledgeSpace>,
  right: Readonly<KnowledgeSpace>,
): boolean {
  return (
    left.spaceId === right.spaceId &&
    left.spaceHandle === right.spaceHandle &&
    left.normalizedHandle === right.normalizedHandle &&
    left.name === right.name &&
    (left.description ?? null) === (right.description ?? null) &&
    left.visibility === right.visibility &&
    left.state === right.state &&
    left.metadataVersion === right.metadataVersion &&
    left.accessVersion === right.accessVersion &&
    left.headRevisionId === right.headRevisionId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

export function sameMembershipRecord(
  left: Readonly<SpaceMembership>,
  right: Readonly<SpaceMembership>,
): boolean {
  return (
    left.membershipId === right.membershipId &&
    left.spaceId === right.spaceId &&
    left.principalId === right.principalId &&
    left.role === right.role &&
    left.state === right.state &&
    left.version === right.version &&
    left.createdAt === right.createdAt &&
    left.createdBy === right.createdBy &&
    left.updatedAt === right.updatedAt &&
    left.updatedBy === right.updatedBy
  );
}

export function sameOwnershipTransferSnapshot(
  left: Readonly<OwnershipTransferSnapshot>,
  right: Readonly<OwnershipTransferSnapshot>,
): boolean {
  return (
    sameKnowledgeSpaceRecord(left.mind.space, right.mind.space) &&
    sameMembershipRecord(
      left.mind.ownerMembership,
      right.mind.ownerMembership,
    ) &&
    sameMembershipRecord(left.sourceMembership, right.sourceMembership) &&
    sameMembershipRecord(left.targetMembership, right.targetMembership)
  );
}

export function ordinaryMindSnapshotFromMaps(
  spaceId: KnowledgeSpace["spaceId"],
  knowledgeSpaces: ReadonlyMap<
    KnowledgeSpace["spaceId"],
    Readonly<KnowledgeSpace>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<OrdinaryMindSnapshot> | null {
  const space = knowledgeSpaces.get(spaceId);
  if (!space) return null;
  try {
    const aggregate = SpaceAggregate.restoreOrdinary({
      space,
      memberships: [...memberships.values()].filter(
        (membership) => membership.spaceId === spaceId,
      ),
    }).snapshot();
    const owner = aggregate.memberships.find(
      (membership) =>
        membership.state === "active" && membership.role === "owner",
    );
    return owner
      ? freezeOrdinaryMindSnapshot({
          space: aggregate.space,
          ownerMembership: owner,
        })
      : null;
  } catch {
    return null;
  }
}

export function ownershipTransferSnapshotFromMaps(
  spaceId: KnowledgeSpace["spaceId"],
  sourceMembershipId: SpaceMembership["membershipId"],
  targetMembershipId: SpaceMembership["membershipId"],
  knowledgeSpaces: ReadonlyMap<
    KnowledgeSpace["spaceId"],
    Readonly<KnowledgeSpace>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<OwnershipTransferSnapshot> | null {
  const mind = ordinaryMindSnapshotFromMaps(
    spaceId,
    knowledgeSpaces,
    memberships,
  );
  const sourceMembership = memberships.get(sourceMembershipId);
  const targetMembership = memberships.get(targetMembershipId);
  if (
    mind === null ||
    !sourceMembership ||
    !targetMembership ||
    sourceMembership.spaceId !== spaceId ||
    targetMembership.spaceId !== spaceId ||
    sourceMembership.state !== "active" ||
    sourceMembership.role !== "admin" ||
    targetMembership.state !== "active" ||
    targetMembership.role !== "owner" ||
    mind.ownerMembership.membershipId !== targetMembership.membershipId
  ) {
    return null;
  }
  return freezeOwnershipTransferSnapshot({
    mind,
    sourceMembership,
    targetMembership,
  });
}

export function ordinaryMindCreateIdempotencyKey(
  principalId: Principal["principalId"],
  key: OrdinaryMindRecordSet["idempotencyKey"],
): string {
  return `${principalId}\u0000create_space_with_owner\u0000${key}`;
}

export function ordinaryMindRenameIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: RenameOrdinaryMindRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000rename_space\u0000${key}`;
}

export function ordinaryMindVisibilityIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: ChangeOrdinaryMindVisibilityRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000change_visibility\u0000${key}`;
}

export function ownershipTransferIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: TransferOrdinaryMindOwnershipRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000transfer_ownership\u0000${key}`;
}

export function invitationIdempotencyRecordKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: CreateInvitationRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000create_invitation\u0000${key}`;
}

export function invitationLifecycleIdempotencyRecordKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  operation: "accept_invitation" | "reject_invitation" | "cancel_invitation" | "reissue_invitation",
  key: TransitionInvitationRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000${operation}\u0000${key}`;
}

export function invitationLifecycleActorIsCurrentlyAuthorized(
  operation: "accept_invitation" | "reject_invitation" | "cancel_invitation" | "reissue_invitation",
  principalId: Principal["principalId"],
  invitation: Readonly<SpaceInvitation>,
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  memberships: ReadonlyMap<SpaceMembership["membershipId"], Readonly<SpaceMembership>>,
): boolean {
  const principal = principals.get(principalId);
  if (!principal || principal.state !== "active") return false;
  if (operation === "accept_invitation" || operation === "reject_invitation") {
    return invitation.targetPrincipalId === principalId;
  }
  const membership = [...memberships.values()].find(
    (candidate) =>
      candidate.spaceId === invitation.spaceId &&
      candidate.principalId === principalId &&
      candidate.state === "active",
  );
  const capability = invitation.proposedRole === "admin"
    ? "members:manage-admin"
    : "members:manage-basic";
  return (
    invitation.createdBy === principalId &&
    membership !== undefined &&
    roleHasCapability(membership.role, capability)
  );
}

export function ordinaryMindIdempotencySpaceId(
  record: Readonly<OrdinaryMindIdempotencyRecord>,
): KnowledgeSpace["spaceId"] {
  return record.operation === "create_space_with_owner"
    ? record.mind.space.spaceId
    : record.spaceId;
}

export function cloneOrdinaryMindIdempotencyRecords(
  records: ReadonlyMap<string, Readonly<OrdinaryMindIdempotencyRecord>>,
): Map<string, Readonly<OrdinaryMindIdempotencyRecord>> {
  const cloned = new Map<string, Readonly<OrdinaryMindIdempotencyRecord>>();
  for (const [key, record] of records) {
    if (record.operation === "transfer_ownership") {
      cloned.set(key, Object.freeze({
        ...record,
        transfer: freezeOwnershipTransferSnapshot(record.transfer),
      }));
      continue;
    }
    if (record.operation === "create_invitation" || record.operation === "reissue_invitation") {
      cloned.set(key, Object.freeze({
        ...record,
        invitation: freezeInvitationSnapshot(record.invitation),
      }));
      continue;
    }
    if (
      record.operation === "accept_invitation" ||
      record.operation === "reject_invitation" ||
      record.operation === "cancel_invitation"
    ) {
      cloned.set(key, Object.freeze({
        ...record,
        lifecycle: freezeInvitationLifecycleSnapshot(record.lifecycle),
      }));
      continue;
    }
    if (!("mind" in record)) throw new TypeError("invalid ordinary idempotency record");
    cloned.set(key, Object.freeze({
      ...record,
      mind: freezeOrdinaryMindSnapshot(record.mind),
    }));
  }
  return cloned;
}

export type MembershipMutationRecord = Readonly<{
  canonicalRequestHash: MembershipMutationReplayRequest["canonicalRequestHash"];
  membership: Readonly<SpaceMembership>;
  changed: boolean;
  requiredCapability: Extract<
    MembershipMutationReplayResult,
    { readonly kind: "replayed" }
  >["requiredCapability"];
}>;

export function membershipMutationKey(
  request: Pick<
    MembershipMutationReplayRequest,
    "principalId" | "spaceId" | "operation" | "idempotencyKey"
  >,
): string {
  return [
    request.principalId,
    request.spaceId,
    request.operation,
    request.idempotencyKey,
  ].join("\u0000");
}

export function cloneMembershipMutationRecords(
  records: ReadonlyMap<string, MembershipMutationRecord>,
): Map<string, MembershipMutationRecord> {
  return new Map(
    [...records].map(([key, record]) => [
      key,
      Object.freeze({
        ...record,
        membership: freezeMembership(record.membership),
      }),
    ]),
  );
}

export function readMembershipReplay(
  records: ReadonlyMap<string, MembershipMutationRecord>,
  request: Readonly<MembershipMutationReplayRequest>,
): MembershipMutationReplayResult {
  const record = records.get(membershipMutationKey(request));
  if (!record) return Object.freeze({ kind: "not_found" });
  if (record.canonicalRequestHash !== request.canonicalRequestHash) {
    return Object.freeze({ kind: "idempotency_conflict" });
  }
  return Object.freeze({
    kind: "replayed",
    membership: freezeMembership(record.membership),
    changed: record.changed,
    requiredCapability: record.requiredCapability,
  });
}

export const VISIBILITY_AUDIT_METADATA_KEYS = [
  "access_version",
  "from_visibility",
  "metadata_version",
  "to_visibility",
] as const;

export function visibilityAuditEffects(
  request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
  previous: Readonly<KnowledgeSpace>,
  current: Readonly<KnowledgeSpace>,
): Readonly<{
  event: Readonly<AuditEvent>;
  outbox: Readonly<AuditOutboxMessage>;
}> {
  return Object.freeze({
    event: Object.freeze({
      auditEventId: request.auditEventId,
      actor: Object.freeze({
        kind: "principal" as const,
        principalId: request.principalId,
      }),
      requestId: request.requestId,
      eventType: "space.visibility_changed",
      outcome: "succeeded" as const,
      spaceId: request.spaceId,
      occurredAt: request.occurredAt,
      safeMetadata: Object.freeze({
        access_version: current.accessVersion,
        from_visibility: previous.visibility,
        metadata_version: current.metadataVersion,
        to_visibility: current.visibility,
      }),
    }),
    outbox: Object.freeze({
      outboxMessageId: request.auditOutboxMessageId,
      auditEventId: request.auditEventId,
      state: "pending" as const,
      version: version(1),
      attempts: 0,
      availableAt: request.occurredAt,
      claimExpiresAt: null,
      createdAt: request.occurredAt,
      updatedAt: request.occurredAt,
    }),
  });
}

export function validVisibilityAuditEffects(
  request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
  previous: Readonly<KnowledgeSpace>,
  current: Readonly<KnowledgeSpace>,
  effects: ReturnType<typeof visibilityAuditEffects>,
): boolean {
  const { event, outbox } = effects;
  const keys = Object.keys(event.safeMetadata).sort();
  return (
    typeof event.auditEventId === "string" &&
    BOUNDED_OPAQUE_ID.test(event.auditEventId) &&
    event.auditEventId === request.auditEventId &&
    event.actor.kind === "principal" &&
    BOUNDED_OPAQUE_ID.test(event.actor.principalId) &&
    event.actor.principalId === request.principalId &&
    BOUNDED_OPAQUE_ID.test(event.requestId) &&
    event.requestId === request.requestId &&
    event.eventType === "space.visibility_changed" &&
    event.outcome === "succeeded" &&
    event.spaceId !== null &&
    BOUNDED_OPAQUE_ID.test(event.spaceId) &&
    event.spaceId === request.spaceId &&
    event.occurredAt === request.occurredAt &&
    Number.isFinite(Date.parse(event.occurredAt)) &&
    keys.length === VISIBILITY_AUDIT_METADATA_KEYS.length &&
    keys.every((key, index) => key === VISIBILITY_AUDIT_METADATA_KEYS[index]) &&
    event.safeMetadata.from_visibility === previous.visibility &&
    event.safeMetadata.to_visibility === current.visibility &&
    event.safeMetadata.metadata_version === current.metadataVersion &&
    event.safeMetadata.access_version === current.accessVersion &&
    previous.visibility !== current.visibility &&
    current.metadataVersion === previous.metadataVersion + 1 &&
    current.accessVersion === previous.accessVersion + 1 &&
    typeof outbox.outboxMessageId === "string" &&
    BOUNDED_OPAQUE_ID.test(outbox.outboxMessageId) &&
    outbox.outboxMessageId === request.auditOutboxMessageId &&
    outbox.auditEventId === event.auditEventId &&
    outbox.state === "pending" &&
    outbox.version === 1 &&
    outbox.attempts === 0 &&
    outbox.availableAt === request.occurredAt &&
    outbox.claimExpiresAt === null &&
    outbox.createdAt === request.occurredAt &&
    outbox.updatedAt === request.occurredAt
  );
}

export function stageVisibilityAuditEffects(
  request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
  previous: Readonly<KnowledgeSpace>,
  current: Readonly<KnowledgeSpace>,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): boolean {
  const effects = visibilityAuditEffects(request, previous, current);
  if (!validVisibilityAuditEffects(request, previous, current, effects)) {
    return false;
  }
  if (
    auditEvents.has(effects.event.auditEventId) ||
    auditOutbox.has(effects.outbox.outboxMessageId) ||
    [...auditOutbox.values()].some(
      (candidate) => candidate.auditEventId === effects.event.auditEventId,
    )
  ) {
    return false;
  }
  auditEvents.set(effects.event.auditEventId, cloneAuditEvent(effects.event));
  auditOutbox.set(
    effects.outbox.outboxMessageId,
    cloneAuditOutbox(effects.outbox),
  );
  return true;
}

export const OWNERSHIP_TRANSFER_AUDIT_METADATA_KEYS = [
  "access_version",
  "metadata_version",
  "source_member_id",
  "source_membership_version",
  "target_member_id",
  "target_membership_version",
] as const;

export function ownershipTransferAuditEffects(
  request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  currentSpace: Readonly<KnowledgeSpace>,
  currentSource: Readonly<SpaceMembership>,
  currentTarget: Readonly<SpaceMembership>,
): Readonly<{
  event: Readonly<AuditEvent>;
  outbox: Readonly<AuditOutboxMessage>;
}> {
  return Object.freeze({
    event: Object.freeze({
      auditEventId: request.auditEventId,
      actor: Object.freeze({
        kind: "principal" as const,
        principalId: request.principalId,
      }),
      requestId: request.requestId,
      eventType: "space.ownership_transferred",
      outcome: "succeeded" as const,
      spaceId: request.spaceId,
      occurredAt: request.occurredAt,
      safeMetadata: Object.freeze({
        access_version: currentSpace.accessVersion,
        metadata_version: currentSpace.metadataVersion,
        source_member_id: currentSource.membershipId,
        source_membership_version: currentSource.version,
        target_member_id: currentTarget.membershipId,
        target_membership_version: currentTarget.version,
      }),
    }),
    outbox: Object.freeze({
      outboxMessageId: request.auditOutboxMessageId,
      auditEventId: request.auditEventId,
      state: "pending" as const,
      version: version(1),
      attempts: 0,
      availableAt: request.occurredAt,
      claimExpiresAt: null,
      createdAt: request.occurredAt,
      updatedAt: request.occurredAt,
    }),
  });
}

export function validOwnershipTransferAuditEffects(
  request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  previousSpace: Readonly<KnowledgeSpace>,
  currentSpace: Readonly<KnowledgeSpace>,
  previousSource: Readonly<SpaceMembership>,
  currentSource: Readonly<SpaceMembership>,
  previousTarget: Readonly<SpaceMembership>,
  currentTarget: Readonly<SpaceMembership>,
  effects: ReturnType<typeof ownershipTransferAuditEffects>,
): boolean {
  const { event, outbox } = effects;
  const keys = Object.keys(event.safeMetadata).sort();
  return (
    previousSpace.spaceId === currentSpace.spaceId &&
    previousSpace.spaceHandle === currentSpace.spaceHandle &&
    previousSpace.normalizedHandle === currentSpace.normalizedHandle &&
    previousSpace.name === currentSpace.name &&
    previousSpace.visibility === currentSpace.visibility &&
    previousSpace.state === currentSpace.state &&
    previousSpace.headRevisionId === currentSpace.headRevisionId &&
    previousSpace.createdAt === currentSpace.createdAt &&
    currentSpace.metadataVersion === previousSpace.metadataVersion + 1 &&
    currentSpace.accessVersion === previousSpace.accessVersion + 1 &&
    currentSpace.updatedAt === request.occurredAt &&
    previousSource.membershipId === currentSource.membershipId &&
    previousSource.spaceId === currentSource.spaceId &&
    previousSource.principalId === request.principalId &&
    previousSource.principalId === currentSource.principalId &&
    previousSource.role === "owner" &&
    currentSource.role === "admin" &&
    previousSource.state === "active" &&
    currentSource.state === "active" &&
    currentSource.version === previousSource.version + 1 &&
    currentSource.createdAt === previousSource.createdAt &&
    currentSource.createdBy === previousSource.createdBy &&
    currentSource.updatedAt === request.occurredAt &&
    currentSource.updatedBy === request.principalId &&
    previousTarget.membershipId === request.targetMembershipId &&
    previousTarget.membershipId === currentTarget.membershipId &&
    previousTarget.spaceId === currentTarget.spaceId &&
    previousTarget.principalId === currentTarget.principalId &&
    previousTarget.principalId !== request.principalId &&
    previousTarget.role !== "owner" &&
    currentTarget.role === "owner" &&
    previousTarget.state === "active" &&
    currentTarget.state === "active" &&
    currentTarget.version === previousTarget.version + 1 &&
    currentTarget.createdAt === previousTarget.createdAt &&
    currentTarget.createdBy === previousTarget.createdBy &&
    currentTarget.updatedAt === request.occurredAt &&
    currentTarget.updatedBy === request.principalId &&
    typeof event.auditEventId === "string" &&
    BOUNDED_OPAQUE_ID.test(event.auditEventId) &&
    event.auditEventId === request.auditEventId &&
    event.actor.kind === "principal" &&
    event.actor.principalId === request.principalId &&
    BOUNDED_OPAQUE_ID.test(event.actor.principalId) &&
    BOUNDED_OPAQUE_ID.test(event.requestId) &&
    event.requestId === request.requestId &&
    event.eventType === "space.ownership_transferred" &&
    event.outcome === "succeeded" &&
    event.spaceId === request.spaceId &&
    event.occurredAt === request.occurredAt &&
    Number.isFinite(Date.parse(event.occurredAt)) &&
    keys.length === OWNERSHIP_TRANSFER_AUDIT_METADATA_KEYS.length &&
    keys.every(
      (key, index) => key === OWNERSHIP_TRANSFER_AUDIT_METADATA_KEYS[index],
    ) &&
    event.safeMetadata.access_version === currentSpace.accessVersion &&
    event.safeMetadata.metadata_version === currentSpace.metadataVersion &&
    event.safeMetadata.source_member_id === currentSource.membershipId &&
    event.safeMetadata.source_membership_version === currentSource.version &&
    event.safeMetadata.target_member_id === currentTarget.membershipId &&
    event.safeMetadata.target_membership_version === currentTarget.version &&
    typeof outbox.outboxMessageId === "string" &&
    BOUNDED_OPAQUE_ID.test(outbox.outboxMessageId) &&
    outbox.outboxMessageId === request.auditOutboxMessageId &&
    outbox.auditEventId === event.auditEventId &&
    outbox.state === "pending" &&
    outbox.version === 1 &&
    outbox.attempts === 0 &&
    outbox.availableAt === request.occurredAt &&
    outbox.claimExpiresAt === null &&
    outbox.createdAt === request.occurredAt &&
    outbox.updatedAt === request.occurredAt
  );
}

export function stageOwnershipTransferAuditEffects(
  request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  previousSpace: Readonly<KnowledgeSpace>,
  currentSpace: Readonly<KnowledgeSpace>,
  previousSource: Readonly<SpaceMembership>,
  currentSource: Readonly<SpaceMembership>,
  previousTarget: Readonly<SpaceMembership>,
  currentTarget: Readonly<SpaceMembership>,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): boolean {
  const effects = ownershipTransferAuditEffects(
    request,
    currentSpace,
    currentSource,
    currentTarget,
  );
  if (
    !validOwnershipTransferAuditEffects(
      request,
      previousSpace,
      currentSpace,
      previousSource,
      currentSource,
      previousTarget,
      currentTarget,
      effects,
    ) ||
    auditEvents.has(effects.event.auditEventId) ||
    auditOutbox.has(effects.outbox.outboxMessageId) ||
    [...auditOutbox.values()].some(
      (candidate) => candidate.auditEventId === effects.event.auditEventId,
    )
  ) {
    return false;
  }
  auditEvents.set(effects.event.auditEventId, cloneAuditEvent(effects.event));
  auditOutbox.set(
    effects.outbox.outboxMessageId,
    cloneAuditOutbox(effects.outbox),
  );
  return true;
}

export function validateOrdinaryMindRecords(
  records: Readonly<OrdinaryMindRecordSet>,
): Readonly<OrdinaryMindSnapshot> | null {
  try {
    const parsedHandle = parseCanonicalSpaceHandle(records.space.spaceHandle);
    const revision = records.initialRevision.revision;
    if (
      parsedHandle.kind !== "valid" ||
      isReservedTopLevelHandle(parsedHandle.canonicalHandle) ||
      records.space.normalizedHandle !== parsedHandle.canonicalHandle ||
      records.space.visibility !== "private" ||
      records.space.state !== "active" ||
      records.space.metadataVersion !== 1 ||
      records.space.accessVersion !== 1 ||
      records.ownerMembership.spaceId !== records.space.spaceId ||
      records.ownerMembership.role !== "owner" ||
      records.ownerMembership.state !== "active" ||
      revision.spaceId !== records.space.spaceId ||
      revision.revisionId !== records.space.headRevisionId ||
      revision.revisionNumber !== 1 ||
      revision.parentRevisionId !== null ||
      revision.committedBy.kind !== "principal" ||
      revision.committedBy.principalId !== records.ownerMembership.principalId ||
      records.initialRevision.manifest.entries.length === 0 ||
      !SHA256_PATTERN.test(records.canonicalRequestHash)
    ) {
      return null;
    }
    const aggregate = SpaceAggregate.restoreOrdinary({
      space: records.space,
      memberships: [records.ownerMembership],
    }).snapshot();
    return freezeOrdinaryMindSnapshot({
      space: aggregate.space,
      ownerMembership: aggregate.memberships[0]!,
    });
  } catch {
    return null;
  }
}

export type AccountBootstrapFailureStage =
  | "after_principal"
  | "after_binding"
  | "after_space"
  | "after_membership"
  | "after_revision"
  | "before_commit";

export type PersonalProfileFailureStage =
  | "after_principal"
  | "after_space"
  | "before_commit";

export type OrdinaryMindFailureStage =
  | "create_after_handle"
  | "create_after_revision"
  | "create_after_space"
  | "create_after_membership"
  | "create_after_idempotency"
  | "create_before_commit"
  | "rename_after_space"
  | "rename_after_idempotency"
  | "rename_before_commit"
  | "visibility_after_space"
  | "visibility_after_catalog"
  | "visibility_after_audit"
  | "visibility_after_idempotency"
  | "visibility_before_commit"
  | "ownership_after_space"
  | "ownership_after_memberships"
  | "ownership_after_audit"
  | "ownership_after_idempotency"
  | "ownership_before_commit"
  | "invitation_after_record"
  | "invitation_after_idempotency"
  | "invitation_after_expiry_job"
  | "invitation_before_commit"
  | "invitation_lifecycle_after_record"
  | "invitation_lifecycle_after_membership"
  | "invitation_lifecycle_after_idempotency"
  | "invitation_lifecycle_before_commit"
  | "invitation_reissue_after_record"
  | "invitation_reissue_after_job"
  | "invitation_reissue_after_idempotency"
  | "invitation_reissue_before_commit"
  | "invitation_expiry_after_record"
  | "invitation_expiry_before_commit"
  | "deletion_impact_after_record"
  | "deletion_impact_before_commit"
  | "delete_after_handle_retirement"
  | "delete_after_target_records"
  | "delete_after_catalog"
  | "delete_after_cleanup_work"
  | "delete_before_commit"
  | "delete_cleanup_before_commit";

export type AccountDeletionFailureStage =
  | "impact_after_record"
  | "impact_before_commit"
  | "delete_after_handle_retirement"
  | "delete_after_target_records"
  | "delete_after_foreign_tombstones"
  | "delete_after_identity"
  | "delete_after_cleanup_work"
  | "delete_before_commit"
  | "cleanup_before_commit";
