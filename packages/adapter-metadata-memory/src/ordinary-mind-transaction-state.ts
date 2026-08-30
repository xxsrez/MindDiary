import type {
  AuditEvent,
  AuditOutboxMessage,
  BackgroundJob,
  BundleFileDownloadGrant,
  ExportDownloadGrant,
  ExportJob,
  JobId,
  LegacyCredentialWriteTargetUpgradeSnapshot,
  MindBindingOwnerId,
  PrincipalActivitySummary,
  PrincipalId,
  RevisionIndexState,
} from "@mind-diary/application-ports";
import type {
  ActiveHandleByKeyMap,
  ActiveHandleBySpaceMap,
  RetiredHandleMap,
} from "./handle-registry.js";
import type {
  AccountDeletionCleanupMap,
  AccountDeletionImpactMap,
  AccountDeletionState,
  AuditEventId,
  AuthorizationState,
  CompletedIdempotencyRecord,
  Envelope,
  ExternalBindingMap,
  InvitationMap,
  KnowledgeSpaceMap,
  MembershipMap,
  MembershipMutationRecord,
  MutableMindBindingOwnerState,
  MutableCredentialWriteTargetOwnerState,
  MutablePrincipalMindUsageOwnerState,
  OrdinaryMindDeletionCleanupMap,
  OrdinaryMindDeletionImpactMap,
  OrdinaryMindDeletionState,
  OrdinaryMindIdempotencyRecord,
  OutboxMessageId,
  PersonalBindingMap,
  PersonalProfileIdempotencyRecord,
  PrincipalMap,
  RevisionId,
  SpaceId,
  SpaceState,
} from "./metadata-store-internals.js";

export interface OrdinaryMindTransactionState {
  principals: PrincipalMap;
  principalActivities: Map<PrincipalId, Readonly<PrincipalActivitySummary>>;
  externalBindings: ExternalBindingMap;
  personalBindings: PersonalBindingMap;
  knowledgeSpaces: KnowledgeSpaceMap;
  memberships: MembershipMap;
  invitations: InvitationMap;
  revisionSpaces: Map<SpaceId, SpaceState>;
  revisionsById: Map<RevisionId, Envelope>;
  idempotencyRecords: Map<string, Readonly<OrdinaryMindIdempotencyRecord>>;
  membershipMutationRecords: Map<string, Readonly<MembershipMutationRecord>>;
  personalProfileIdempotencyRecords: Map<
    string,
    Readonly<PersonalProfileIdempotencyRecord>
  >;
  activeByHandle: ActiveHandleByKeyMap;
  activeBySpace: ActiveHandleBySpaceMap;
  retired: RetiredHandleMap;
  publicCatalogGeneration: number;
  publicCatalogSpaceIds: Set<SpaceId>;
  publicCatalogSnapshots: Map<number, readonly SpaceId[]>;
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>;
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>;
  contentIdempotencyRecords: Map<string, CompletedIdempotencyRecord>;
  backgroundJobs: Map<JobId, Readonly<BackgroundJob>>;
  exportJobs: Map<JobId, Readonly<ExportJob>>;
  exportDownloadGrants: Map<string, Readonly<ExportDownloadGrant>>;
  bundleFileDownloadGrants: Map<string, Readonly<BundleFileDownloadGrant>>;
  indexStates: Map<string, Readonly<RevisionIndexState>>;
  deletionImpacts: OrdinaryMindDeletionImpactMap;
  deletionCleanup: OrdinaryMindDeletionCleanupMap;
  accountDeletionImpacts: AccountDeletionImpactMap;
  accountDeletionCleanup: AccountDeletionCleanupMap;
  authorizationStates: Map<string, AuthorizationState>;
  mindBindingOwners: Map<MindBindingOwnerId, MutableMindBindingOwnerState>;
  credentialWriteTargetOwners: Map<
    MindBindingOwnerId,
    MutableCredentialWriteTargetOwnerState
  >;
  legacyCredentialWriteTargetUpgrades: Map<
    MindBindingOwnerId,
    Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>
  >;
  principalMindUsageOwners: Map<PrincipalId, MutablePrincipalMindUsageOwnerState>;
}

export function ordinaryMindDeletionState(
  state: OrdinaryMindTransactionState,
): OrdinaryMindDeletionState {
  return {
    knowledgeSpaces: state.knowledgeSpaces,
    memberships: state.memberships,
    invitations: state.invitations,
    revisionSpaces: state.revisionSpaces,
    ordinaryIdempotency: state.idempotencyRecords,
    contentIdempotency: state.contentIdempotencyRecords,
    auditEvents: state.auditEvents,
    auditOutbox: state.auditOutbox,
    backgroundJobs: state.backgroundJobs,
    exportJobs: state.exportJobs,
    exportDownloadGrants: state.exportDownloadGrants,
    bundleFileDownloadGrants: state.bundleFileDownloadGrants,
    indexStates: state.indexStates,
    activeBySpace: state.activeBySpace,
  };
}

export function accountDeletionState(
  state: OrdinaryMindTransactionState,
): AccountDeletionState {
  return {
    ...ordinaryMindDeletionState(state),
    principals: state.principals,
    externalBindings: state.externalBindings,
    personalBindings: state.personalBindings,
    personalProfileIdempotency: state.personalProfileIdempotencyRecords,
  };
}
