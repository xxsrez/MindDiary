import type {
  ActorContext,
  RequestId,
} from "@mind-diary/application-contracts";
import {
  ACCESS_TOKEN_STATES,
  CAPABILITIES,
  MEMBERSHIP_STATES,
  PRINCIPAL_STATES,
  ROLES,
  SPACE_LIFECYCLE_STATES,
  VISIBILITIES,
  capabilitiesForRole,
  capabilitiesForVisibilityGrant,
  revisionModeAllowsCapability,
  tokenScopesAllowCapability,
  version,
  type AccessTokenState,
  type AutomaticCaptureMode,
  type AuditEvent,
  type AuditEventId,
  type AuditOutboxMessage,
  type BackgroundJob,
  type BindingVersion,
  type BundleFileMediaType,
  type BundleFileDownloadGrant,
  type Capability,
  type CanonicalRevisionEnvelope,
  type CanonicalSpaceHandle,
  type EffectiveTokenScopes,
  type DeletedPrincipalId,
  type ExternalBindingId,
  type InvitationId,
  type ExportArchiveRecord,
  type ExportDownloadGrant,
  type ExportDownloadSecretVerifier,
  type ExportJob,
  type HandlePolicyFailureReason,
  type MarkdownMediaType,
  type MindBindingOwnerId,
  type MindBindingSet,
  type MembershipId,
  type MembershipState,
  type IdempotencyKey,
  type IdempotencyOperation,
  type IdempotencyRecord,
  type IdempotencyResult,
  type ExternalIdentityBinding,
  type KnowledgeSpace,
  type PersonalSpaceBinding,
  type Principal,
  type PrincipalAccountSnapshot,
  type PrincipalId,
  type JobId,
  type OutboxMessageId,
  type PrincipalState,
  type RevisionId,
  type ReadMindBinding,
  type ReadMindBindingId,
  type RevisionIndexState,
  type RevisionMode,
  type Role,
  type SensitiveExternalBinding,
  type Sha256Digest,
  type SpaceId,
  type SpaceInvitation,
  type SpaceMembership,
  type StagedBundleFileId,
  type SpaceLifecycleState,
  type TokenId,
  type UtcInstant,
  type VerifiedSpaceHost,
  type Version,
  type Visibility,
  type WriteMindBinding,
  type WriteMindBindingId,
} from "@mind-diary/domain";

export type { CanonicalRevisionEnvelope } from "@mind-diary/domain";
export type {
  AuditEvent,
  AuditOutboxMessage,
  BackgroundJob,
  CommitChangesetIdempotencyResult,
  IdempotencyOperation,
  IdempotencyRecord,
  IdempotencyResult,
  JobId,
  ExportArchiveRecord,
  ExportDownloadGrant,
  BundleFileDownloadGrant,
  ExportDownloadSecretVerifier,
  ExportJob,
  OutboxMessageId,
  RevisionIndexState,
  StartExportIdempotencyResult,
} from "@mind-diary/domain";
export {
  DomainInvariantError,
  PrincipalAccount,
  REVISION_MANIFEST_FORMAT_V3,
  RESERVED_TOP_LEVEL_HANDLES,
  SpaceAggregate,
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  normalizeSpaceHandle,
  parseCanonicalSpaceHandle,
  version,
  verifiedSpaceHost,
  revisionEnvelopesEqual,
  serializeRevisionManifest,
  roleHasCapability,
  bindingVersion,
  compareUnicodeScalarValues,
  type CanonicalSpaceHandle,
  type HandlePolicyFailureReason,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";
export type {
  ExternalIdentityBinding,
  AutomaticCaptureMode,
  BindingVersion,
  SpaceInvitation,
  KnowledgeSpace,
  MindBindingOwnerId,
  MindBindingSet,
  PersonalSpaceBinding,
  Principal,
  PrincipalId,
  PrincipalAccountSnapshot,
  ReadMindBinding,
  ReadMindBindingId,
  SensitiveExternalBinding,
  SpaceMembership,
  WriteMindBinding,
  WriteMindBindingId,
  StagedBundleFileId,
  UtcInstant,
} from "@mind-diary/domain";

export interface Clock {
  now(): UtcInstant;
}

/** Server-side source of opaque immutable revision identities. */
export interface RevisionIdGenerator {
  nextRevisionId(): RevisionId;
}

/** Server-owned identifiers and hidden handle for one isolated account. */
export interface AccountBootstrapIdGenerator {
  nextPrincipalId(): PrincipalId;
  nextExternalBindingId(): ExternalBindingId;
  nextSpaceId(): SpaceId;
  nextMembershipId(): MembershipId;
  nextRevisionId(): RevisionId;
  /** Optional only for legacy test generators; production must provide it. */
  nextIndexJobId?(): JobId;
  nextPersonalSpaceHandle(): string;
}

/** Server-owned IDs for effects staged with one successful content commit. */
export interface CommitEffectIdGenerator {
  nextAuditEventId(): AuditEventId;
  nextOutboxMessageId(): OutboxMessageId;
  nextIndexJobId(): JobId;
}

/** Server-side source of opaque export job locators. */
export interface ExportJobIdGenerator {
  nextExportJobId(): JobId;
}

/** Secret-bearing issuance result; the raw bearer can be consumed exactly once. */
export interface IssuedExportDownloadSecret {
  consumeSecret(): string | null;
  verifier(): ExportDownloadSecretVerifier;
}

export type ExportDownloadVerifierLookupResult<Value> =
  | {
      readonly kind: "found";
      readonly verifier: ExportDownloadSecretVerifier;
      readonly value: Value;
    }
  | { readonly kind: "not_found" };

export interface ExportDownloadVerifierLookup<Value> {
  findByVerifier(
    verifier: ExportDownloadSecretVerifier,
  ): Promise<ExportDownloadVerifierLookupResult<Value>>;
}

export type ExportDownloadSecretVerificationResult<Value> =
  | { readonly kind: "verified"; readonly value: Value }
  | { readonly kind: "invalid" };

/** Dedicated crypto boundary for canonical export-download bearer secrets. */
export interface ExportDownloadSecretCrypto {
  readonly kind: "export-download-secret-crypto";
  issueSecret(): Promise<IssuedExportDownloadSecret>;
  verifySecret<Value>(
    candidate: unknown,
    lookup: ExportDownloadVerifierLookup<Value>,
  ): Promise<ExportDownloadSecretVerificationResult<Value>>;
}

export interface MetadataStore {
  readonly kind: "metadata-store";
}

/** Server-owned immutable IDs for Mind binding generations. */
export interface MindBindingIdGenerator {
  nextReadMindBindingId(): ReadMindBindingId;
  nextWriteMindBindingId(): WriteMindBindingId;
  nextMindBindingAuditEventId(): AuditEventId;
  nextMindBindingOutboxMessageId(): OutboxMessageId;
}

export interface ExternalIdentityBindingLookup {
  readonly provider: string;
  /** Sensitive exact-match material. It must never enter logs or public results. */
  readonly normalizedBinding: SensitiveExternalBinding;
}

/**
 * Complete metadata aggregate staged by account bootstrap. Canonical object
 * bytes are prepared before this transaction and become reachable only through
 * the initial revision committed with this record set.
 */
export interface AccountBootstrapRecordSet {
  readonly principal: Readonly<Principal>;
  readonly externalBinding: Readonly<ExternalIdentityBinding>;
  readonly personalSpace: Readonly<KnowledgeSpace>;
  readonly personalBinding: Readonly<PersonalSpaceBinding>;
  readonly ownerMembership: Readonly<SpaceMembership>;
  readonly initialRevision: Readonly<CanonicalRevisionEnvelope>;
  readonly initialIndexJob: Readonly<BackgroundJob>;
  readonly initialIndexState: Readonly<RevisionIndexState>;
}

export type CreateAccountBootstrapResult =
  | {
      readonly kind: "created";
      readonly account: Readonly<PrincipalAccountSnapshot>;
    }
  | {
      readonly kind: "exact_binding_exists";
      readonly account: Readonly<PrincipalAccountSnapshot>;
    }
  | { readonly kind: "record_conflict" | "invalid_record" };

export interface PersonalMindResolution {
  readonly spaceId: SpaceId;
  readonly headRevisionId: RevisionId;
}

/** Narrow rollback-on-error transaction for the indivisible account aggregate. */
export interface AccountBootstrapTransaction {
  readAccountByExternalBinding(
    lookup: Readonly<ExternalIdentityBindingLookup>,
  ): Promise<Readonly<PrincipalAccountSnapshot> | null>;
  createAccountBootstrap(
    records: Readonly<AccountBootstrapRecordSet>,
  ): Promise<CreateAccountBootstrapResult>;
}

export interface AccountBootstrapStore extends MetadataStore {
  runAccountBootstrapTransaction<Result>(
    operation: (transaction: AccountBootstrapTransaction) => Promise<Result>,
  ): Promise<Result>;
  readAccount(
    principalId: PrincipalId,
  ): Promise<Readonly<PrincipalAccountSnapshot> | null>;
  readAccountByExternalBinding(
    lookup: Readonly<ExternalIdentityBindingLookup>,
  ): Promise<Readonly<PrincipalAccountSnapshot> | null>;
  resolvePersonalMind(
    principalId: PrincipalId,
  ): Promise<Readonly<PersonalMindResolution> | null>;
}

/** Safe metadata projection for Personal Mind control flows. Hidden handles are excluded. */
export interface PersonalMindProfileSnapshot {
  readonly principalId: PrincipalId;
  readonly displayName: string;
  readonly profileVersion: Version;
  readonly personalMind: {
    readonly spaceId: SpaceId;
    readonly name: string;
    readonly visibility: "private";
    readonly metadataVersion: Version;
    readonly headRevisionId: RevisionId;
  };
}

export interface PersonalMindTargetRequest {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
}

/**
 * Server-side target classification for ordinary lifecycle commands. A foreign
 * Personal Mind is deliberately indistinguishable from a missing target.
 */
export type PersonalMindTargetClassification =
  | { readonly kind: "own_personal"; readonly spaceId: SpaceId }
  | { readonly kind: "ordinary"; readonly spaceId: SpaceId }
  | { readonly kind: "not_found" };

export interface RenamePersonalProfileRequest {
  readonly principalId: PrincipalId;
  readonly displayName: string;
  readonly expectedProfileVersion: Version;
  readonly expectedPersonalMetadataVersion: Version;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
}

export type RenamePersonalProfileResult =
  | {
      readonly kind: "renamed";
      readonly profile: Readonly<PersonalMindProfileSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "profile_conflict";
      readonly currentProfileVersion: Version;
      readonly currentPersonalMetadataVersion: Version;
    }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "not_found" | "invalid_record" };

export interface PersonalMindMetadataTransaction {
  renamePersonalProfile(
    request: RenamePersonalProfileRequest,
  ): Promise<RenamePersonalProfileResult>;
}

/** Atomic metadata-only Personal Mind profile and invariant boundary. */
export interface PersonalMindStore extends AccountBootstrapStore {
  readPersonalMindProfile(
    principalId: PrincipalId,
  ): Promise<Readonly<PersonalMindProfileSnapshot> | null>;
  classifyPersonalMindTarget(
    request: PersonalMindTargetRequest,
  ): Promise<PersonalMindTargetClassification>;
  runPersonalMindTransaction<Result>(
    operation: (transaction: PersonalMindMetadataTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface HandleReservationSnapshot {
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
  readonly spaceId: SpaceId;
}

export interface RetiredHandleMarker {
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
}

export interface HandleReservationRequest {
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
  readonly spaceId: SpaceId;
}

export type HandleReservationResult =
  | {
      readonly kind: "reserved";
      readonly reservation: Readonly<HandleReservationSnapshot>;
      readonly replayed: boolean;
    }
  | { readonly kind: "handle_unavailable" }
  | { readonly kind: "immutable_handle" }
  | {
      readonly kind: "invalid_handle";
      readonly reason: HandlePolicyFailureReason;
    };

export interface HandleResolutionRequest {
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
}

export type HandleResolutionResult =
  | { readonly kind: "resolved"; readonly spaceId: SpaceId }
  | { readonly kind: "not_found" };

export interface HandleRetirementRequest extends HandleResolutionRequest {
  readonly spaceId: SpaceId;
}

export type HandleRetirementResult =
  | {
      readonly kind: "retired";
      readonly marker: Readonly<RetiredHandleMarker>;
    }
  | { readonly kind: "not_found" };

/** Transactional host-scoped handle ownership and permanent retirement. */
export interface HandleRegistry extends MetadataStore {
  reserveHandle(request: HandleReservationRequest): Promise<HandleReservationResult>;
  resolveHandle(request: HandleResolutionRequest): Promise<HandleResolutionResult>;
  retireHandle(request: HandleRetirementRequest): Promise<HandleRetirementResult>;
}

/** Server-owned identifiers for one ordinary Mind aggregate. */
export interface OrdinaryMindIdGenerator {
  nextSpaceId(): SpaceId;
  nextMembershipId(): MembershipId;
  nextRevisionId(): RevisionId;
  /** Optional only for legacy test generators; production must provide it. */
  nextIndexJobId?(): JobId;
}

/** Server-owned identity for one pending invitation. */
export interface InvitationIdGenerator {
  nextInvitationId(): InvitationId;
}

/** Server-owned identities for invitation lifecycle effects. */
export interface InvitationLifecycleIdGenerator extends InvitationIdGenerator {
  nextMembershipId(): MembershipId;
  nextInvitationExpiryJobId(): JobId;
}

/** Safe projection returned by exact registered-principal lookup. */
export interface RegisteredPrincipalSnapshot {
  readonly principalId: PrincipalId;
  readonly displayName: string;
}

export interface CreateInvitationRequest {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly target: Readonly<RegisteredPrincipalSnapshot>;
  readonly invitation: Readonly<SpaceInvitation>;
  readonly expectedMetadataVersion: Version;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
  readonly expiryJob: Readonly<BackgroundJob>;
}

export interface InvitationSnapshot {
  readonly invitation: Readonly<SpaceInvitation>;
  readonly target: Readonly<RegisteredPrincipalSnapshot>;
}

export type CreateInvitationResult =
  | {
      readonly kind: "created";
      readonly invitation: Readonly<InvitationSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "metadata_conflict";
      readonly currentMetadataVersion: Version;
    }
  | {
      readonly kind:
        | "mind_not_found"
        | "personal_mind"
        | "forbidden"
        | "active_membership_exists"
        | "pending_invitation_exists"
        | "idempotency_conflict"
        | "expiry_job_conflict"
        | "record_conflict"
        | "invalid_record";
    };

export type InvitationLifecycleOperation =
  | "accept_invitation"
  | "reject_invitation"
  | "cancel_invitation";

export interface TransitionInvitationRequest {
  readonly operation: InvitationLifecycleOperation;
  readonly principalId: PrincipalId;
  readonly invitationId: InvitationId;
  readonly expectedInvitationVersion: Version;
  /** Server-generated ID only; the authoritative store constructs the record. */
  readonly membershipId: MembershipId | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
}

export interface InvitationLifecycleSnapshot {
  readonly invitation: Readonly<InvitationSnapshot>;
  readonly membership: Readonly<SpaceMembership> | null;
}

export type TransitionInvitationResult =
  | {
      readonly kind: "transitioned";
      readonly result: Readonly<InvitationLifecycleSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "invitation_not_found"
        | "personal_mind"
        | "forbidden"
        | "invitation_not_pending"
        | "invitation_expired"
        | "invitation_version_conflict"
        | "active_membership_exists"
        | "idempotency_conflict"
        | "record_conflict"
        | "invalid_record";
    };

export interface ReissueInvitationRequest {
  readonly principalId: PrincipalId;
  readonly invitationId: InvitationId;
  readonly expectedInvitationVersion: Version;
  readonly replacementInvitationId: InvitationId;
  readonly expiryJobId: JobId;
  readonly expiresAt: UtcInstant;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
}

export type ReissueInvitationResult =
  | {
      readonly kind: "reissued";
      readonly invitation: Readonly<InvitationSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "invitation_not_found"
        | "personal_mind"
        | "forbidden"
        | "accepted_invitation"
        | "invitation_version_conflict"
        | "active_membership_exists"
        | "pending_invitation_exists"
        | "idempotency_conflict"
        | "expiry_job_conflict"
        | "record_conflict"
        | "invalid_record";
    };

export interface OrdinaryMindSnapshot {
  readonly space: Readonly<KnowledgeSpace>;
  readonly ownerMembership: Readonly<SpaceMembership>;
}

/**
 * Complete ordinary-Mind aggregate staged with its host-scoped handle and
 * initial canonical revision. None of these records may become reachable
 * independently.
 */
export interface OrdinaryMindRecordSet {
  readonly host: VerifiedSpaceHost;
  readonly space: Readonly<KnowledgeSpace>;
  readonly ownerMembership: Readonly<SpaceMembership>;
  readonly initialRevision: Readonly<CanonicalRevisionEnvelope>;
  readonly initialIndexJob: Readonly<BackgroundJob>;
  readonly initialIndexState: Readonly<RevisionIndexState>;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
}

export type CreateOrdinaryMindResult =
  | {
      readonly kind: "created";
      readonly mind: Readonly<OrdinaryMindSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "principal_not_found"
        | "mind_not_found"
        | "forbidden"
        | "handle_unavailable"
        | "idempotency_conflict"
        | "record_conflict"
        | "invalid_record";
    };

export interface RenameOrdinaryMindRequest {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly displayName: string;
  readonly expectedMetadataVersion: Version;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
}

export type RenameOrdinaryMindResult =
  | {
      readonly kind: "renamed";
      readonly mind: Readonly<OrdinaryMindSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "metadata_conflict";
      readonly currentMetadataVersion: Version;
    }
  | {
      readonly kind:
        | "mind_not_found"
        | "personal_mind"
        | "forbidden"
        | "idempotency_conflict"
        | "invalid_record";
    };

/** Server-owned IDs for one committed visibility audit effect. */
export interface VisibilityAuditIdGenerator {
  nextAuditEventId(): AuditEventId;
  nextOutboxMessageId(): OutboxMessageId;
}

/** Server-owned IDs for one committed ownership-transfer audit effect. */
export interface OwnershipTransferAuditIdGenerator {
  nextAuditEventId(): AuditEventId;
  nextOutboxMessageId(): OutboxMessageId;
}

/** Server-owned locator for one short-lived destructive-action preview. */
export interface OrdinaryMindDeletionIdGenerator {
  nextImpactId(): string;
}

/** Server-owned locators for an account preview and its irreversible author tombstone. */
export interface AccountDeletionIdGenerator {
  nextImpactId(): string;
  nextDeletedPrincipalId(): DeletedPrincipalId;
}

export interface AccountDeletionOwnedMindSnapshot {
  readonly spaceId: SpaceId;
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
  readonly name: string;
  readonly revisionCount: number;
}

/**
 * Exact metadata and token-state preview for one account cascade. Fingerprints
 * contain only service IDs, versions and counts, never profile/content bytes.
 */
export interface AccountDeletionImpactSnapshot {
  readonly impactId: string;
  readonly principalId: PrincipalId;
  readonly host: VerifiedSpaceHost;
  readonly deletedPrincipalId: DeletedPrincipalId;
  readonly expiresAt: UtcInstant;
  readonly personalMind: Readonly<{
    readonly spaceId: SpaceId;
    readonly name: string;
    readonly revisionCount: number;
  }>;
  readonly ownedMinds: readonly Readonly<AccountDeletionOwnedMindSnapshot>[];
  readonly foreignMembershipCount: number;
  readonly pendingInvitationCount: number;
  readonly activeTokenCount: number;
  readonly metadataStateFingerprint: string;
  readonly tokenStateFingerprint: string;
}

export interface CreateAccountDeletionImpactRequest {
  readonly principalId: PrincipalId;
  readonly host: VerifiedSpaceHost;
  readonly impactId: string;
  readonly deletedPrincipalId: DeletedPrincipalId;
  readonly occurredAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly activeTokenCount: number;
  readonly tokenStateFingerprint: string;
}

export type CreateAccountDeletionImpactResult =
  | {
      readonly kind: "created";
      readonly impact: Readonly<AccountDeletionImpactSnapshot>;
    }
  | {
      readonly kind:
        | "account_not_found"
        | "impact_id_collision"
        | "invalid_record";
    };

/** Temporary cleanup plan removed after every external delete/tombstone succeeds. */
export interface AccountDeletionCleanupWorkItem {
  readonly impactId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly principalId: PrincipalId;
  readonly deletedPrincipalId: DeletedPrincipalId;
  readonly deletedSpaceIds: readonly SpaceId[];
  readonly objectDigests: readonly Sha256Digest[];
  readonly foreignExportJobIds: readonly JobId[];
  readonly tokenStateFingerprint: string;
  readonly deleteBefore: UtcInstant;
}

export interface DeleteAccountCascadeRequest {
  readonly principalId: PrincipalId;
  readonly impactId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly deletedPrincipalId: DeletedPrincipalId;
  readonly tokenStateFingerprint: string;
  readonly occurredAt: UtcInstant;
}

export interface AccountDeletedRecordCounts {
  readonly spaces: number;
  readonly revisions: number;
  readonly memberships: number;
  readonly invitations: number;
  readonly externalBindings: number;
  readonly foreignRevisionAuthorsTombstoned: number;
  readonly foreignAuditActorsTombstoned: number;
  readonly foreignExportJobs: number;
}

export type DeleteAccountCascadeResult =
  | {
      readonly kind: "deleted";
      readonly cleanup: Readonly<AccountDeletionCleanupWorkItem>;
      readonly counts: Readonly<AccountDeletedRecordCounts>;
    }
  | {
      readonly kind: "cleanup_pending";
      readonly cleanup: Readonly<AccountDeletionCleanupWorkItem>;
    }
  | {
      readonly kind:
        | "account_not_found"
        | "deletion_impact_expired"
        | "deletion_impact_changed"
        | "idempotency_conflict"
        | "invalid_record";
    };

export interface CompleteAccountDeletionCleanupRequest {
  readonly impactId: string;
  readonly principalId: PrincipalId;
}

export type CompleteAccountDeletionCleanupResult =
  | { readonly kind: "completed" }
  | { readonly kind: "not_found" | "invalid_record" };

export type AccountDeletionContext =
  | {
      readonly kind: "impact";
      readonly impact: Readonly<AccountDeletionImpactSnapshot>;
    }
  | {
      readonly kind: "cleanup";
      readonly cleanup: Readonly<AccountDeletionCleanupWorkItem>;
    };

/**
 * Exact pre-delete snapshot. `stateFingerprint` contains only service metadata
 * identities/versions and counts; it must never contain canonical content.
 */
export interface OrdinaryMindDeletionImpactSnapshot {
  readonly impactId: string;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
  readonly name: string;
  readonly expiresAt: UtcInstant;
  readonly metadataVersion: Version;
  readonly accessVersion: Version;
  readonly headRevisionId: RevisionId;
  readonly revisionCount: number;
  readonly membershipCount: number;
  readonly invitationCount: number;
  readonly backgroundJobCount: number;
  readonly exportJobCount: number;
  readonly stateFingerprint: string;
}

export interface CreateOrdinaryMindDeletionImpactRequest {
  readonly principalId: PrincipalId;
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
  readonly impactId: string;
  readonly occurredAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export type CreateOrdinaryMindDeletionImpactResult =
  | {
      readonly kind: "created";
      readonly impact: Readonly<OrdinaryMindDeletionImpactSnapshot>;
    }
  | {
      readonly kind:
        | "mind_not_found"
        | "personal_mind"
        | "forbidden"
        | "impact_id_collision"
        | "invalid_record";
    };

/**
 * Temporary crash-resumable cleanup plan. It exists only between logical
 * deletion and completed external cleanup and is not an audit/deletion receipt.
 */
export interface OrdinaryMindDeletionCleanupWorkItem {
  readonly impactId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
  readonly objectDigests: readonly Sha256Digest[];
  readonly deleteBefore: UtcInstant;
}

export interface DeleteOrdinaryMindRequest {
  readonly principalId: PrincipalId;
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
  readonly impactId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: UtcInstant;
}

export interface OrdinaryMindDeletedRecordCounts {
  readonly revisions: number;
  readonly memberships: number;
  readonly invitations: number;
  readonly backgroundJobs: number;
  readonly exportJobs: number;
  readonly exportDownloadGrants: number;
  readonly bundleFileDownloadGrants: number;
  readonly indexStates: number;
  readonly auditEvents: number;
  readonly auditOutboxMessages: number;
  readonly idempotencyRecords: number;
}

export type DeleteOrdinaryMindResult =
  | {
      readonly kind: "deleted";
      readonly cleanup: Readonly<OrdinaryMindDeletionCleanupWorkItem>;
      readonly counts: Readonly<OrdinaryMindDeletedRecordCounts>;
    }
  | {
      readonly kind: "cleanup_pending";
      readonly cleanup: Readonly<OrdinaryMindDeletionCleanupWorkItem>;
    }
  | { readonly kind: "already_absent" }
  | {
      readonly kind:
        | "mind_not_found"
        | "personal_mind"
        | "forbidden"
        | "deletion_impact_expired"
        | "deletion_impact_changed"
        | "idempotency_conflict"
        | "invalid_record";
    };

export interface CompleteOrdinaryMindDeletionCleanupRequest {
  readonly impactId: string;
  readonly spaceId: SpaceId;
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
}

export type CompleteOrdinaryMindDeletionCleanupResult =
  | { readonly kind: "completed" }
  | { readonly kind: "not_found" | "invalid_record" };

export interface ChangeOrdinaryMindVisibilityRequest {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly visibility: Visibility;
  readonly acknowledgeLiveHeadAndHistoryExposure: boolean;
  readonly expectedMetadataVersion: Version;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
  readonly requestId: ActorContext["requestId"];
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
}

export type ChangeOrdinaryMindVisibilityResult =
  | {
      readonly kind: "visibility_changed";
      readonly mind: Readonly<OrdinaryMindSnapshot>;
      readonly changed: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "metadata_conflict";
      readonly currentMetadataVersion: Version;
    }
  | {
      readonly kind:
        | "mind_not_found"
        | "personal_mind"
        | "forbidden"
        | "exposure_acknowledgement_required"
        | "idempotency_conflict"
        | "effect_conflict"
        | "invalid_record";
    };

export interface TransferOrdinaryMindOwnershipRequest {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly targetMembershipId: MembershipId;
  readonly expectedMetadataVersion: Version;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
  readonly requestId: ActorContext["requestId"];
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly capacityLimits?: Readonly<CapacityLimits>;
}

/** Exact post-transfer records persisted by one ownership transaction. */
export interface OwnershipTransferSnapshot {
  readonly mind: Readonly<OrdinaryMindSnapshot>;
  readonly sourceMembership: Readonly<SpaceMembership>;
  readonly targetMembership: Readonly<SpaceMembership>;
}

export type TransferOrdinaryMindOwnershipResult =
  | {
      readonly kind: "transferred";
      readonly transfer: Readonly<OwnershipTransferSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "metadata_conflict";
      readonly currentMetadataVersion: Version;
    }
  | {
      readonly kind:
        | "mind_not_found"
        | "personal_mind"
        | "forbidden"
        | "ownership_target_invalid"
        | "ownership_target_capacity_exceeded"
        | "ownership_state_changed"
        | "idempotency_conflict"
        | "effect_conflict"
        | "invalid_record";
    };

export type MembershipControlOperation =
  | "change_membership_role"
  | "revoke_membership"
  | "leave_space";
export type MembershipMutationRole = "reader" | "editor" | "admin";

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
      readonly requiredCapability:
        | "content:browse"
        | "members:manage-basic"
        | "members:manage-admin";
    };

export interface ApplyMembershipMutationRequest
  extends MembershipMutationReplayRequest {
  readonly targetMembershipId: MembershipId;
  readonly role: MembershipMutationRole | null;
  readonly expectedMembershipVersion: SpaceMembership["version"];
  readonly requiredCapability:
    | "content:browse"
    | "members:manage-basic"
    | "members:manage-admin";
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

export interface MembershipControlTransaction extends AuthorizationTransaction {
  readMembershipControlTarget(
    query: Readonly<MembershipControlTargetQuery>,
  ): Promise<MembershipControlTargetResult>;
  applyMembershipMutation(
    request: Readonly<ApplyMembershipMutationRequest>,
  ): Promise<ApplyMembershipMutationResult>;
}

export interface MembershipControlStore extends AuthorizationStateReader {
  readMembershipMutationReplay(
    request: Readonly<MembershipMutationReplayRequest>,
  ): Promise<MembershipMutationReplayResult>;
  runMembershipControlTransaction<Result>(
    operation: (transaction: MembershipControlTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface ControlMemberProjection {
  readonly memberId: MembershipId;
  readonly principalId: PrincipalId;
  readonly displayName: string;
  readonly role: Role;
  readonly state: MembershipState;
  readonly membershipVersion: Version;
}

export interface ControlInvitationProjection {
  readonly invitationId: InvitationId;
  readonly mindId: SpaceId;
  readonly mindName: string;
  readonly direction: "incoming" | "outgoing";
  readonly counterpartyPrincipalId: PrincipalId;
  readonly counterpartyDisplayName: string;
  readonly proposedRole: "reader" | "editor" | "admin";
  readonly state: SpaceInvitation["state"];
  readonly invitationVersion: Version;
  readonly expiresAt: UtcInstant;
}

/** Canonical control-plane projections; adapters must join current metadata. */
export interface ControlReadStore extends AuthorizationStateReader {
  listControlMembers(spaceId: SpaceId): Promise<readonly Readonly<ControlMemberProjection>[]>;
  listControlInvitations(principalId: PrincipalId): Promise<readonly Readonly<ControlInvitationProjection>[]>;
}

export const PRINCIPAL_ACTIVITY_SURFACES = ["web", "mcp"] as const;
export const PRINCIPAL_ACTIVITY_KINDS = [
  "page",
  "control_read",
  "control_write",
  "discovery",
  "content_read",
  "content_write",
] as const;
export type PrincipalActivitySurface = (typeof PRINCIPAL_ACTIVITY_SURFACES)[number];
export type PrincipalActivityKind = (typeof PRINCIPAL_ACTIVITY_KINDS)[number];

/** Bounded success-only projection; this is deliberately not a request log. */
export interface PrincipalActivitySummary {
  readonly principalId: PrincipalId;
  readonly lastWebSeenAt: UtcInstant | null;
  readonly lastMcpSeenAt: UtcInstant | null;
  readonly lastActivityAt: UtcInstant | null;
  readonly lastActivitySurface: PrincipalActivitySurface | null;
  readonly lastActivityKind: PrincipalActivityKind | null;
}

export interface RecordPrincipalActivityRequest {
  readonly principalId: PrincipalId;
  readonly surface: PrincipalActivitySurface;
  readonly kind: PrincipalActivityKind;
  readonly observedAt: UtcInstant;
}

export type ServiceOperatorDirectorySort =
  | "registered_at"
  | "last_activity_at"
  | "display_name";

export interface ServiceOperatorDirectoryQuery {
  readonly query?: string;
  readonly state?: PrincipalState;
  readonly registeredFrom?: UtcInstant;
  readonly registeredTo?: UtcInstant;
  readonly activityFrom?: UtcInstant;
  readonly activityTo?: UtcInstant;
  readonly neverActive?: boolean;
  readonly sort: ServiceOperatorDirectorySort;
  readonly direction: "asc" | "desc";
  readonly limit: number;
  readonly cursor?: string;
}

export interface ServiceOperatorPrincipalProjection {
  readonly principalId: PrincipalId;
  readonly displayName: string;
  /** Restricted support projection; never log or copy to audit metadata. */
  readonly verifiedEmail: string;
  readonly state: PrincipalState;
  readonly registeredAt: UtcInstant;
  readonly activity: Readonly<PrincipalActivitySummary> | null;
  readonly ownedMindCount: number;
  readonly participatingMindCount: number;
}

export interface ServiceOperatorDirectoryPage {
  readonly principals: readonly Readonly<ServiceOperatorPrincipalProjection>[];
  readonly nextCursor: string | null;
}

export interface StageServiceOperatorDirectoryAuditRequest {
  readonly operatorPrincipalId: PrincipalId;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export interface ServiceOperatorDirectoryStore extends MetadataStore {
  recordPrincipalActivity(request: Readonly<RecordPrincipalActivityRequest>): Promise<void>;
  readPrincipalActivity(
    principalId: PrincipalId,
  ): Promise<Readonly<PrincipalActivitySummary> | null>;
  listServiceOperatorPrincipals(
    query: Readonly<ServiceOperatorDirectoryQuery>,
  ): Promise<Readonly<ServiceOperatorDirectoryPage>>;
  stageServiceOperatorDirectoryAudit(
    request: Readonly<StageServiceOperatorDirectoryAuditRequest>,
  ): Promise<void>;
}

export interface ServiceOperatorAuditIdGenerator {
  nextAuditEventId(): AuditEventId;
  nextOutboxMessageId(): OutboxMessageId;
}

export interface OrdinaryMindMetadataTransaction
  extends AuthorizationTransaction,
    MembershipControlTransaction {
  /** Classifies own/foreign Personal Minds before any target-identity lookup. */
  classifyPersonalMindTarget(
    request: PersonalMindTargetRequest,
  ): Promise<PersonalMindTargetClassification>;
  /** Exact active binding lookup; implementations must not perform fuzzy search. */
  readRegisteredPrincipalByExternalBinding(
    lookup: Readonly<ExternalIdentityBindingLookup>,
  ): Promise<Readonly<RegisteredPrincipalSnapshot> | null>;
  createInvitation(
    request: Readonly<CreateInvitationRequest>,
  ): Promise<CreateInvitationResult>;
  transitionInvitation(
    request: Readonly<TransitionInvitationRequest>,
  ): Promise<TransitionInvitationResult>;
  reissueInvitation(
    request: Readonly<ReissueInvitationRequest>,
  ): Promise<ReissueInvitationResult>;
  createOrdinaryMind(
    records: Readonly<OrdinaryMindRecordSet>,
  ): Promise<CreateOrdinaryMindResult>;
  renameOrdinaryMind(
    request: Readonly<RenameOrdinaryMindRequest>,
  ): Promise<RenameOrdinaryMindResult>;
  changeOrdinaryMindVisibility(
    request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
  ): Promise<ChangeOrdinaryMindVisibilityResult>;
  transferOrdinaryMindOwnership(
    request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  ): Promise<TransferOrdinaryMindOwnershipResult>;
  createOrdinaryMindDeletionImpact(
    request: Readonly<CreateOrdinaryMindDeletionImpactRequest>,
  ): Promise<CreateOrdinaryMindDeletionImpactResult>;
  deleteOrdinaryMind(
    request: Readonly<DeleteOrdinaryMindRequest>,
  ): Promise<DeleteOrdinaryMindResult>;
  completeOrdinaryMindDeletionCleanup(
    request: Readonly<CompleteOrdinaryMindDeletionCleanupRequest>,
  ): Promise<CompleteOrdinaryMindDeletionCleanupResult>;
  createAccountDeletionImpact(
    request: Readonly<CreateAccountDeletionImpactRequest>,
  ): Promise<CreateAccountDeletionImpactResult>;
  deleteAccountCascade(
    request: Readonly<DeleteAccountCascadeRequest>,
  ): Promise<DeleteAccountCascadeResult>;
  completeAccountDeletionCleanup(
    request: Readonly<CompleteAccountDeletionCleanupRequest>,
  ): Promise<CompleteAccountDeletionCleanupResult>;
}

/** Global canonical-object reachability across every retained revision. */
export interface CanonicalObjectReachabilityReader {
  /** Includes every historical revision, not only each Mind's current HEAD. */
  listReachableObjectDigests(): Promise<readonly Sha256Digest[]>;
  listReachableBundleFileObjects(): Promise<readonly Readonly<{
    spaceId: SpaceId;
    sha256: Sha256Digest;
  }>[]>;
  listReachableSpaceCanonicalObjects(): Promise<readonly Readonly<{
    kind: SpaceCanonicalObjectKind;
    spaceId: SpaceId;
    sha256: Sha256Digest;
  }>[]>;
  /** Point checks let bounded GC avoid materializing the global reachability set. */
  isImmutableObjectReachable(sha256: Sha256Digest): Promise<boolean>;
  isBundleFileObjectReachable(spaceId: SpaceId, sha256: Sha256Digest): Promise<boolean>;
  isSpaceCanonicalObjectReachable(
    kind: SpaceCanonicalObjectKind,
    spaceId: SpaceId,
    sha256: Sha256Digest,
  ): Promise<boolean>;
}

/** Atomic handle, metadata, Owner, revision/HEAD and idempotency boundary. */
export interface OrdinaryMindStore
  extends HandleRegistry,
    CanonicalObjectReachabilityReader {
  runOrdinaryMindTransaction<Result>(
    operation: (transaction: OrdinaryMindMetadataTransaction) => Promise<Result>,
  ): Promise<Result>;
}

/** Serialized account cascade shares the same lifecycle transaction as Minds. */
export interface AccountDeletionStore
  extends OrdinaryMindStore,
    AccountBootstrapStore {
  readAccountDeletionContext(
    principalId: PrincipalId,
    impactId: string,
  ): Promise<Readonly<AccountDeletionContext> | null>;
  runAccountDeletionTransaction<Result>(
    operation: (transaction: OrdinaryMindMetadataTransaction) => Promise<Result>,
  ): Promise<Result>;
}

/** Safe ordinary metadata used only after current route authorization. */
export interface OrdinaryMindRouteSnapshot {
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
  readonly space: Readonly<KnowledgeSpace>;
}

export interface MindRouteAuthorizationQuery extends AuthorizationStateQuery {
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
}

/**
 * Current metadata source for management routes and membership-only listing.
 * Implementations must use the same principal, Space, membership, and handle
 * records as lifecycle commands; derived indexes and fixture ACLs are not a
 * routing source of truth.
 */
export interface MindRouteMetadataStore
  extends PersonalMindStore,
    HandleRegistry,
    AuthorizationStateReader,
    ResolvedSpaceReader<OrdinaryMindRouteSnapshot> {
  /** One refreshed, read-only view for a complete route projection. */
  readonly withConsistentRead?: <Result>(
    operation: (store: MindRouteMetadataStore) => Promise<Result>,
  ) => Promise<Result>;
  listActiveMembershipMindIds(
    principalId: PrincipalId,
  ): Promise<readonly SpaceId[]>;
  readCurrentRouteAuthorizationState(
    query: MindRouteAuthorizationQuery,
  ): Promise<CurrentAuthorizationState | null>;
}

export interface PublicMindCatalogPageRequest {
  /** Opaque adapter-issued cursor; null starts a new immutable snapshot. */
  readonly cursor: string | null;
  readonly limit: number;
}

export type PublicMindCatalogPageResult =
  | {
      readonly kind: "page";
      /** Opaque candidate identities only; callers must reauthorize every item. */
      readonly spaceIds: readonly SpaceId[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: "invalid_cursor" };

/**
 * Derived public-discovery projection over the canonical route/auth records.
 * Candidate IDs are not authorization evidence and contain no display metadata.
 */
export interface PublicMindCatalogStore extends MindRouteMetadataStore {
  listPublicMindCatalogPage(
    request: Readonly<PublicMindCatalogPageRequest>,
  ): Promise<PublicMindCatalogPageResult>;
}

export interface ImmutableObjectWriteRequest {
  readonly bytes: Uint8Array;
  readonly mediaType: MarkdownMediaType;
  /** Server-supplied UTC time used only for bounded unreachable-object GC. */
  readonly createdAt: UtcInstant;
}

export interface ImmutableObjectMetadata {
  readonly sha256: Sha256Digest;
  readonly mediaType: MarkdownMediaType;
  readonly size: number;
  readonly createdAt: UtcInstant;
  /** Mutable GC lease metadata; canonical bytes and digest remain immutable. */
  readonly protectedAt: UtcInstant;
}

export interface ImmutableObject extends ImmutableObjectMetadata {
  readonly bytes: Uint8Array;
}

export interface ImmutableObjectPutResult {
  readonly object: Readonly<ImmutableObjectMetadata>;
  readonly status: "stored" | "already_exists";
}

export interface ImmutableObjectListRequest {
  /** Only objects whose GC protection is strictly older are candidates. */
  readonly createdBefore: UtcInstant;
  /** Reachable digests are excluded before applying limit, preventing starvation. */
  readonly excludedDigests: readonly Sha256Digest[];
  readonly limit: number;
}

export interface ImmutableObjectDeleteRequest {
  readonly sha256: Sha256Digest;
  /** Candidate lease observed by list; a concurrent put changes it. */
  readonly expectedProtectedAt: UtcInstant;
  /** The delete is refused when current protection is at or after this boundary. */
  readonly createdBefore: UtcInstant;
}

export type ObjectStoreFailureCode =
  | "invalid_digest"
  | "invalid_media_type"
  | "invalid_utf8"
  | "invalid_timestamp"
  | "invalid_limit"
  | "digest_collision"
  | "object_tampered";

/** Stable port-level failure used without coupling application code to an adapter. */
export class ObjectStoreFailure extends Error {
  readonly code: ObjectStoreFailureCode;

  constructor(code: ObjectStoreFailureCode, message: string) {
    super(message);
    this.name = "ObjectStoreFailure";
    this.code = code;
  }
}

export interface ObjectStore {
  readonly kind: "object-store";
  calculateSha256(bytes: Uint8Array): Promise<Sha256Digest>;
  putImmutable(request: ImmutableObjectWriteRequest): Promise<ImmutableObjectPutResult>;
  getImmutable(sha256: Sha256Digest): Promise<Readonly<ImmutableObject> | null>;
  listImmutableObjects(
    request: ImmutableObjectListRequest,
  ): Promise<readonly Readonly<ImmutableObjectMetadata>[]>;
  deleteImmutableObject(request: ImmutableObjectDeleteRequest): Promise<boolean>;
}

export const REVISION_MANIFEST_MEDIA_TYPE =
  "application/vnd.mind-diary.revision-manifest+json; charset=utf-8" as const;

export type SpaceCanonicalObjectKind = "markdown" | "revision_manifest";
export type SpaceCanonicalObjectMediaType =
  | MarkdownMediaType
  | typeof REVISION_MANIFEST_MEDIA_TYPE;

export interface SpaceCanonicalObjectWriteRequest {
  readonly kind: SpaceCanonicalObjectKind;
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly mediaType: SpaceCanonicalObjectMediaType;
  readonly createdAt: UtcInstant;
}

export interface SpaceCanonicalObjectMetadata {
  readonly kind: SpaceCanonicalObjectKind;
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly mediaType: SpaceCanonicalObjectMediaType;
  readonly size: number;
  readonly createdAt: UtcInstant;
  readonly protectedAt: UtcInstant;
}

export interface SpaceCanonicalObject extends SpaceCanonicalObjectMetadata {
  readonly bytes: Uint8Array;
}

export interface SpaceCanonicalObjectPutResult {
  readonly object: Readonly<SpaceCanonicalObjectMetadata>;
  readonly status: "stored" | "already_exists";
}

export interface SpaceCanonicalObjectListRequest {
  readonly createdBefore: UtcInstant;
  /** Optional exact Space scope for lifecycle cleanup without global listing. */
  readonly spaceId?: SpaceId;
  readonly excluded: readonly Readonly<{
    kind: SpaceCanonicalObjectKind;
    spaceId: SpaceId;
    sha256: Sha256Digest;
  }>[];
  readonly limit: number;
}

export interface SpaceCanonicalObjectDeleteRequest {
  readonly kind: SpaceCanonicalObjectKind;
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly expectedProtectedAt: UtcInstant;
  readonly createdBefore: UtcInstant;
}

/** Space-isolated v3 Markdown and revision-manifest bytes. */
export interface SpaceCanonicalObjectStore {
  putSpaceCanonicalObject(
    request: Readonly<SpaceCanonicalObjectWriteRequest>,
  ): Promise<SpaceCanonicalObjectPutResult>;
  getSpaceCanonicalObject(
    kind: SpaceCanonicalObjectKind,
    spaceId: SpaceId,
    sha256: Sha256Digest,
  ): Promise<Readonly<SpaceCanonicalObject> | null>;
  listSpaceCanonicalObjects(
    request: Readonly<SpaceCanonicalObjectListRequest>,
  ): Promise<readonly Readonly<SpaceCanonicalObjectMetadata>[]>;
  deleteSpaceCanonicalObject(
    request: Readonly<SpaceCanonicalObjectDeleteRequest>,
  ): Promise<boolean>;
}

export interface BundleFileObjectWriteRequest {
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly mediaType: BundleFileMediaType;
  readonly createdAt: UtcInstant;
}

export interface BundleFileObjectMetadata {
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly mediaType: BundleFileMediaType;
  readonly size: number;
  readonly createdAt: UtcInstant;
  readonly protectedAt: UtcInstant;
}

export interface BundleFileObject extends BundleFileObjectMetadata {
  readonly bytes: Uint8Array;
}

export interface BundleFileObjectPutResult {
  readonly object: Readonly<BundleFileObjectMetadata>;
  readonly status: "stored" | "already_exists";
}

export interface BundleFileObjectListRequest {
  readonly createdBefore: UtcInstant;
  readonly excluded: readonly Readonly<{
    spaceId: SpaceId;
    sha256: Sha256Digest;
  }>[];
  readonly limit: number;
}

export interface BundleFileObjectDeleteRequest {
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly expectedProtectedAt: UtcInstant;
  readonly createdBefore: UtcInstant;
}

export interface StagedBundleFileObjectWriteRequest {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly createdAt: UtcInstant;
}

export interface StagedBundleFileObject {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly createdAt: UtcInstant;
}

/** Opaque bytes use Space-scoped canonical keys and a separate staging namespace. */
export interface BundleFileObjectStore extends ObjectStore, SpaceCanonicalObjectStore {
  putBundleFile(
    request: Readonly<BundleFileObjectWriteRequest>,
  ): Promise<BundleFileObjectPutResult>;
  getBundleFile(
    spaceId: SpaceId,
    sha256: Sha256Digest,
  ): Promise<Readonly<BundleFileObject> | null>;
  listBundleFileObjects(
    request: Readonly<BundleFileObjectListRequest>,
  ): Promise<readonly Readonly<BundleFileObjectMetadata>[]>;
  deleteBundleFileObject(
    request: Readonly<BundleFileObjectDeleteRequest>,
  ): Promise<boolean>;
  putStagedBundleFile(
    request: Readonly<StagedBundleFileObjectWriteRequest>,
  ): Promise<Readonly<StagedBundleFileObject>>;
  getStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileObject> | null>;
  deleteStagedBundleFile(stagedFileId: StagedBundleFileId): Promise<boolean>;
}

export type StagedBundleFileState =
  | "quarantined"
  | "verified"
  | "consumed"
  | "expired"
  | "rejected";

export interface StagedBundleFileRecord {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly writeBindingId: WriteMindBindingId;
  readonly writeBindingGeneration: BindingVersion;
  readonly spaceId: SpaceId;
  readonly displayFilename: string;
  readonly mediaType: BundleFileMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly state: StagedBundleFileState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly consumedAt: UtcInstant | null;
  readonly rejectionCode: string | null;
  /** Durable capacity linkage; absent only on legacy staged records. */
  readonly capacityReservationId?: string;
}

export type CreateStagedBundleFileResult =
  | { readonly kind: "created"; readonly record: Readonly<StagedBundleFileRecord> }
  | { readonly kind: "id_collision" | "outstanding_byte_limit_exceeded" };

export interface BundleFileStagingTransaction
  extends AuthorizationTransaction,
    IdempotencyTransaction,
    CapacityReservationTransaction {
  readStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileRecord> | null>;
  createStagedBundleFile(
    record: Readonly<StagedBundleFileRecord>,
    maxOutstandingBytes: number,
    occurredAt: UtcInstant,
  ): Promise<CreateStagedBundleFileResult>;
}

export interface ConsumeStagedBundleFilesRequest {
  readonly stagedFileIds: readonly StagedBundleFileId[];
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly writeBindingId: WriteMindBindingId;
  readonly writeBindingGeneration: BindingVersion;
  readonly spaceId: SpaceId;
  readonly consumedAt: UtcInstant;
}

export type ConsumeStagedBundleFilesResult =
  | {
      readonly kind: "consumed";
      readonly records: readonly Readonly<StagedBundleFileRecord>[];
    }
  | {
      readonly kind:
        | "not_found"
        | "not_verified"
        | "expired"
        | "binding_mismatch"
        | "duplicate_reference";
      readonly stagedFileId: StagedBundleFileId | null;
    };

export interface BundleFileStagingStore extends CapacityLedgerStore {
  runBundleFileStagingTransaction<Result>(
    operation: (transaction: BundleFileStagingTransaction) => Promise<Result>,
  ): Promise<Result>;
  readStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileRecord> | null>;
  collectStagedBundleFilesForGc(request: Readonly<{
    createdBefore: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<StagedBundleFileRecord>[]>;
  deleteExpiredStagedBundleFileRecord(
    stagedFileId: StagedBundleFileId,
  ): Promise<boolean>;
}

export interface ExportArchiveWriteRequest {
  readonly jobId: JobId;
  readonly spaceId: SpaceId;
  readonly claimVersion: Version;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Digest;
  readonly archiveFormat?: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  readonly filename?: "mind-diary-okf-bundle.zip" | "mind-diary-bundle.zip";
  readonly contentDisposition?:
    | 'attachment; filename="mind-diary-okf-bundle.zip"'
    | 'attachment; filename="mind-diary-bundle.zip"';
  readonly createdAt: UtcInstant;
}

export interface StoredExportArchive extends ExportArchiveRecord {
  readonly jobId: JobId;
  readonly spaceId: SpaceId;
  readonly claimVersion: Version;
  readonly createdAt: UtcInstant;
}

export type ExportArchivePutResult =
  | {
      readonly kind: "stored" | "already_exists";
      readonly archive: Readonly<StoredExportArchive>;
    }
  | { readonly kind: "digest_mismatch" | "object_key_collision" };

export interface ExportArchiveUploadRequest {
  readonly jobId: JobId;
  readonly spaceId: SpaceId;
  readonly claimVersion: Version;
  readonly archiveFormat: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  readonly filename: "mind-diary-okf-bundle.zip" | "mind-diary-bundle.zip";
  readonly contentDisposition:
    | 'attachment; filename="mind-diary-okf-bundle.zip"'
    | 'attachment; filename="mind-diary-bundle.zip"';
  readonly createdAt: UtcInstant;
}

/** Bounded writer; Sites persists deterministic parts instead of buffering one archive. */
export interface ExportArchiveUpload {
  write(chunk: Uint8Array): Promise<void>;
  complete(request: Readonly<{
    sha256: Sha256Digest;
    size: number;
  }>): Promise<ExportArchivePutResult>;
  abort(): Promise<void>;
}

export interface OpenedExportArchive {
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
}

/** Binary export namespace; it is intentionally separate from canonical Markdown. */
export interface ExportArchiveStore {
  readonly kind: "object-store";
  putExportArchive(
    request: ExportArchiveWriteRequest,
  ): Promise<ExportArchivePutResult>;
  beginExportArchiveUpload(
    request: Readonly<ExportArchiveUploadRequest>,
  ): Promise<ExportArchiveUpload>;
  openExportArchive(objectKey: string): Promise<Readonly<OpenedExportArchive> | null>;
  readExportArchive(objectKey: string): Promise<Uint8Array | null>;
  deleteExportArchive(objectKey: string): Promise<boolean>;
  /** One bounded prefix lookup; never scans the global export namespace. */
  hasExportArchivesForJob(jobId: JobId, spaceId: SpaceId): Promise<boolean>;
  /** Idempotent cleanup of completed and orphaned claim-scoped archives. */
  deleteExportArchivesForJob(jobId: JobId): Promise<number>;
  deleteExportArchivesForSpace(spaceId: SpaceId): Promise<number>;
}

export const OBJECT_CLEANUP_NAMESPACES = [
  "immutable",
  "bundle_file",
  "space_canonical",
  "staged_bundle",
  "export",
] as const;

export type ObjectCleanupNamespace = (typeof OBJECT_CLEANUP_NAMESPACES)[number];

interface ObjectCleanupCandidateBase {
  /** Adapter-owned locator. It is never emitted to telemetry or user surfaces. */
  readonly objectKey: string;
  /** CAS fence captured by the bounded listing operation. */
  readonly fence: string;
  readonly size: number;
  readonly createdAt: UtcInstant;
}

export type ObjectCleanupCandidate =
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "immutable";
      readonly sha256: Sha256Digest;
      readonly protectedAt: UtcInstant;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "bundle_file";
      readonly spaceId: SpaceId;
      readonly sha256: Sha256Digest;
      readonly protectedAt: UtcInstant;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "space_canonical";
      readonly kind: SpaceCanonicalObjectKind;
      readonly spaceId: SpaceId;
      readonly sha256: Sha256Digest;
      readonly protectedAt: UtcInstant;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "staged_bundle";
      readonly stagedFileId: StagedBundleFileId;
      readonly spaceId: SpaceId;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "export";
      readonly jobId: JobId;
      readonly spaceId: SpaceId;
    });

export interface ObjectCleanupPage {
  readonly candidates: readonly Readonly<ObjectCleanupCandidate>[];
  /** Opaque durable adapter cursor, or null when the namespace page cycle ended. */
  readonly nextCursor: string | null;
  readonly listed: number;
}

export interface ObjectCleanupCheckpoint {
  readonly version: Version;
  readonly namespace: ObjectCleanupNamespace;
  readonly cursor: string | null;
  readonly cycleStartedAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly leaseExpiresAt: UtcInstant | null;
  readonly retries: number;
  readonly failures: number;
}

export type ClaimObjectCleanupResult =
  | {
      readonly kind: "claimed";
      readonly checkpoint: Readonly<ObjectCleanupCheckpoint>;
      readonly reclaimedLease: boolean;
    }
  | { readonly kind: "busy" };

/**
 * Durable, cursor-paged object maintenance boundary. Implementations must keep
 * each list bounded and fence deletes against writes after the selected safety
 * boundary.
 */
export interface BoundedObjectCleanupStore {
  listObjectCleanupPage(request: Readonly<{
    namespace: ObjectCleanupNamespace;
    cursor: string | null;
    limit: number;
  }>): Promise<Readonly<ObjectCleanupPage>>;
  deleteObjectCleanupCandidate(request: Readonly<{
    candidate: Readonly<ObjectCleanupCandidate>;
    createdBefore: UtcInstant;
  }>): Promise<boolean>;
}

/** D1 authority for the singleton bounded-cleanup cursor and worker lease. */
export interface ObjectCleanupCheckpointStore {
  claimObjectCleanup(request: Readonly<{
    now: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<ClaimObjectCleanupResult>;
  completeObjectCleanupBatch(request: Readonly<{
    expectedVersion: Version;
    namespace: ObjectCleanupNamespace;
    cursor: string | null;
    cycleStartedAt: UtcInstant;
    completedAt: UtcInstant;
  }>): Promise<boolean>;
  failObjectCleanupBatch(request: Readonly<{
    expectedVersion: Version;
    failedAt: UtcInstant;
  }>): Promise<boolean>;
}

export type RevisionCommitResult =
  | {
      readonly kind: "committed";
      readonly envelope: Readonly<CanonicalRevisionEnvelope>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "stale_head";
      readonly currentHeadRevisionId: RevisionId | null;
    }
  | { readonly kind: "revision_id_collision" }
  | {
      readonly kind: "invalid_revision_chain";
      readonly reason:
        | "missing_parent"
        | "parent_mismatch"
        | "revision_number_mismatch"
        | "manifest_hash_mismatch";
    };

export interface RevisionCommitRequest {
  readonly expectedHeadRevisionId: RevisionId | null;
  readonly envelope: Readonly<CanonicalRevisionEnvelope>;
}

export interface IdempotencyNamespace {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly operation: IdempotencyOperation;
  readonly key: IdempotencyKey;
  /** Required by binding-owner-scoped operations such as native file staging. */
  readonly bindingOwnerId?: MindBindingOwnerId;
}

export interface CheckIdempotencyRequest {
  readonly namespace: Readonly<IdempotencyNamespace>;
  readonly canonicalRequestHash: Sha256Digest;
}

type CompletedIdempotencyRecord = Extract<
  IdempotencyRecord,
  { readonly state: "completed" }
>;

export type CheckIdempotencyResult =
  | { readonly kind: "missing" }
  | {
      readonly kind: "replay";
      readonly record: Readonly<CompletedIdempotencyRecord>;
    }
  | { readonly kind: "conflict" };

export type CompleteIdempotencyRequest = {
  [Operation in IdempotencyOperation]: {
    readonly namespace: Readonly<
      IdempotencyNamespace & { readonly operation: Operation }
    >;
    readonly canonicalRequestHash: Sha256Digest;
    readonly result: Readonly<Extract<IdempotencyResult, { kind: Operation }>>;
    readonly completedAt: UtcInstant;
  };
}[IdempotencyOperation];

export type CompleteIdempotencyResult =
  | {
      readonly kind: "completed";
      readonly record: Readonly<CompletedIdempotencyRecord>;
    }
  | { readonly kind: "already_exists" }
  | { readonly kind: "operation_result_mismatch" };

/** Common transaction slice shared by every namespaced idempotent operation. */
export interface IdempotencyTransaction {
  /**
   * Resolves the actor/Space/operation/key namespace inside this transaction.
   * Implementations must serialize this check with canonical effect staging
   * and completion so concurrent retries expose one canonical effect.
   */
  checkIdempotency(
    request: CheckIdempotencyRequest,
  ): Promise<CheckIdempotencyResult>;
  /** Completes only a namespace observed as missing in this same transaction. */
  completeIdempotency(
    request: CompleteIdempotencyRequest,
  ): Promise<CompleteIdempotencyResult>;
}

export type CreateExportJobResult =
  | { readonly kind: "created"; readonly job: Readonly<ExportJob> }
  | { readonly kind: "job_id_collision" | "invalid_job" };

export interface ExportStartTransaction
  extends AuthorizationTransaction,
    IdempotencyTransaction,
    CapacityReservationTransaction {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  listRevisions(
    spaceId: SpaceId,
  ): Promise<readonly Readonly<CanonicalRevisionEnvelope>[]>;
  readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null>;
  createExportJob(job: Readonly<ExportJob>): Promise<CreateExportJobResult>;
}

export type ClaimExportJobResult =
  | { readonly kind: "claimed"; readonly job: Readonly<ExportJob> }
  | { readonly kind: "not_found" | "not_available" | "completed" | "expired" };

export type ExpireExportJobResult =
  | {
      readonly kind: "expired";
      readonly job: Readonly<ExportJob>;
      readonly replayed: boolean;
    }
  | { readonly kind: "not_found" | "not_due" };

/** Durable export jobs and their lease/version-fenced state transitions. */
export interface ExportJobStore extends MetadataStore, AuthorizationStateReader {
  runExportStartTransaction<Result>(
    operation: (transaction: ExportStartTransaction) => Promise<Result>,
  ): Promise<Result>;
  readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null>;
  listRecoverableExportJobs(
    now: UtcInstant,
    limit: number,
  ): Promise<readonly Readonly<ExportJob>[]>;
  claimExportJob(
    jobId: JobId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimExportJobResult>;
  completeExportJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    archive: Readonly<ExportArchiveRecord>,
    completedAt: UtcInstant,
  ): Promise<boolean>;
  failExportJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    failureCode: string,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
  expireExportJob(jobId: JobId, now: UtcInstant): Promise<ExpireExportJobResult>;
  completeExpiredExportCleanup(
    jobId: JobId,
    expectedVersion: Version,
    cleanedAt: UtcInstant,
  ): Promise<boolean>;
}

export type CreateExportDownloadGrantResult =
  | {
      readonly kind: "created";
      readonly grant: Readonly<ExportDownloadGrant>;
    }
  | { readonly kind: "secret_collision" | "invalid_grant" };

export interface ExportDownloadGrantTransaction extends AuthorizationTransaction {
  readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null>;
  createExportDownloadGrant(
    grant: Readonly<ExportDownloadGrant>,
  ): Promise<CreateExportDownloadGrantResult>;
}

export type ReadExportDownloadGrantResult =
  | { readonly kind: "active"; readonly grant: Readonly<ExportDownloadGrant> }
  | { readonly kind: "not_found" | "expired" | "revoked" };

/** Temporary download capabilities remain separate from durable export jobs. */
export interface ExportDownloadGrantStore extends ExportJobStore {
  runExportDownloadGrantTransaction<Result>(
    operation: (transaction: ExportDownloadGrantTransaction) => Promise<Result>,
  ): Promise<Result>;
  readExportDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    now: UtcInstant,
  ): Promise<ReadExportDownloadGrantResult>;
  revokeExportDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    revokedAt: UtcInstant,
  ): Promise<boolean>;
}

export type CreateBundleFileDownloadGrantResult =
  | { readonly kind: "created"; readonly grant: Readonly<BundleFileDownloadGrant> }
  | { readonly kind: "secret_collision" | "invalid_grant" };

export type ConsumeBundleFileDownloadGrantResult =
  | { readonly kind: "consumed"; readonly grant: Readonly<BundleFileDownloadGrant> }
  | { readonly kind: "not_found" | "expired" | "consumed" };

export interface BundleFileDownloadGrantTransaction extends AuthorizationTransaction {
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  readBundleFileDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    now: UtcInstant,
  ): Promise<ConsumeBundleFileDownloadGrantResult | { readonly kind: "active"; readonly grant: Readonly<BundleFileDownloadGrant> }>;
  createBundleFileDownloadGrant(
    grant: Readonly<BundleFileDownloadGrant>,
  ): Promise<CreateBundleFileDownloadGrantResult>;
  consumeBundleFileDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    consumedAt: UtcInstant,
  ): Promise<ConsumeBundleFileDownloadGrantResult>;
}

export interface BundleFileDownloadGrantStore
  extends MetadataStore,
    AuthorizationStateReader {
  runBundleFileDownloadGrantTransaction<Result>(
    operation: (transaction: BundleFileDownloadGrantTransaction) => Promise<Result>,
  ): Promise<Result>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  readBundleFileDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    now: UtcInstant,
  ): Promise<ConsumeBundleFileDownloadGrantResult | { readonly kind: "active"; readonly grant: Readonly<BundleFileDownloadGrant> }>;
}

/** Transactional revision metadata and HEAD; object bytes remain in ObjectStore. */
export interface RevisionMetadataStore
  extends MetadataStore,
    CanonicalObjectReachabilityReader {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  listRevisions(
    spaceId: SpaceId,
  ): Promise<readonly Readonly<CanonicalRevisionEnvelope>[]>;
  commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult>;
}

export type MarkdownImportSessionState =
  | "active"
  | "validating"
  | "validated"
  | "validation_failed"
  | "finalizing"
  | "committed"
  | "canceled"
  | "expired";

export interface MarkdownImportPlanFile {
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly size: number;
}

export interface MarkdownImportPlan {
  readonly planId: string;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly descriptorHash: Sha256Digest;
  readonly files: readonly Readonly<MarkdownImportPlanFile>[];
  readonly logicalBytes: number;
  readonly additions: number;
  readonly replacements: number;
  readonly deletions: number;
  readonly unchanged: number;
  readonly projectedUtilization: CapacityUtilizationState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface MarkdownImportStagedFile {
  readonly stagedFileId: StagedBundleFileId;
  readonly importId: string;
  readonly checkpoint: number;
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly createdAt: UtcInstant;
}

export interface MarkdownImportSessionFailure {
  readonly path: string;
  readonly code: string;
}

export interface MarkdownImportSession {
  readonly importId: string;
  readonly planId: string;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly reservationId: string;
  readonly state: MarkdownImportSessionState;
  readonly version: Version;
  readonly checkpoint: number;
  readonly stagedFileCount: number;
  readonly stagedBytes: number;
  readonly validationCheckpoint: number;
  readonly validatedBytes: number;
  readonly promotionCheckpoint: number;
  readonly promotedBytes: number;
  readonly failures: readonly Readonly<MarkdownImportSessionFailure>[];
  readonly revisionId: RevisionId | null;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly cleanupCompletedAt: UtcInstant | null;
}

export type CreateMarkdownImportPlanResult =
  | { readonly kind: "created"; readonly plan: Readonly<MarkdownImportPlan>; readonly replayed: boolean }
  | { readonly kind: "idempotency_conflict" | "id_collision" | "capacity_rejected" };

export type CreateMarkdownImportSessionResult =
  | { readonly kind: "created"; readonly session: Readonly<MarkdownImportSession>; readonly replayed: boolean }
  | {
      readonly kind:
        | "plan_not_found"
        | "plan_expired"
        | "head_conflict"
        | "idempotency_conflict"
        | "id_collision";
    };

export type StageMarkdownImportBatchResult =
  | { readonly kind: "staged"; readonly session: Readonly<MarkdownImportSession>; readonly replayed: boolean }
  | {
      readonly kind:
        | "not_found"
        | "state_conflict"
        | "checkpoint_conflict"
        | "idempotency_conflict"
        | "file_conflict";
    };

export type TransitionMarkdownImportSessionResult =
  | { readonly kind: "updated"; readonly session: Readonly<MarkdownImportSession> }
  | { readonly kind: "not_found" | "state_conflict" | "version_conflict" };

export interface MarkdownImportMetadataTransaction
  extends ContentCommitMetadataTransaction {
  readMarkdownImportPlan(planId: string): Promise<Readonly<MarkdownImportPlan> | null>;
  createMarkdownImportPlan(
    plan: Readonly<MarkdownImportPlan>,
    siteD1MetadataLimit: number,
  ): Promise<CreateMarkdownImportPlanResult>;
  readMarkdownImportSession(importId: string): Promise<Readonly<MarkdownImportSession> | null>;
  readMarkdownImportSessionForPlan(
    planId: string,
  ): Promise<Readonly<MarkdownImportSession> | null>;
  createMarkdownImportSession(
    session: Readonly<MarkdownImportSession>,
  ): Promise<CreateMarkdownImportSessionResult>;
  listMarkdownImportStagedFiles(
    importId: string,
  ): Promise<readonly Readonly<MarkdownImportStagedFile>[]>;
  stageMarkdownImportBatch(request: Readonly<{
    importId: string;
    expectedVersion: Version;
    checkpoint: number;
    canonicalRequestHash: Sha256Digest;
    files: readonly Readonly<MarkdownImportStagedFile>[];
    failures: readonly Readonly<MarkdownImportSessionFailure>[];
    stagedAt: UtcInstant;
  }>): Promise<StageMarkdownImportBatchResult>;
  transitionMarkdownImportSession(request: Readonly<{
    importId: string;
    expectedVersion: Version;
    from: readonly MarkdownImportSessionState[];
    to: MarkdownImportSessionState;
    updatedAt: UtcInstant;
    failures?: readonly Readonly<MarkdownImportSessionFailure>[];
    validationCheckpoint?: number;
    validatedBytes?: number;
    promotionCheckpoint?: number;
    promotedBytes?: number;
    revisionId?: RevisionId | null;
  }>): Promise<TransitionMarkdownImportSessionResult>;
  claimMarkdownImportCleanup(request: Readonly<{
    now: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<{
    session: Readonly<MarkdownImportSession>;
    files: readonly Readonly<MarkdownImportStagedFile>[];
  }>[]>;
  deleteMarkdownImportStagedFile(stagedFileId: StagedBundleFileId): Promise<boolean>;
  completeMarkdownImportCleanup(request: Readonly<{
    importId: string;
    expectedVersion: Version;
    completedAt: UtcInstant;
  }>): Promise<boolean>;
  deleteExpiredMarkdownImportPlans(request: Readonly<{
    now: UtcInstant;
    limit: number;
  }>): Promise<number>;
}

export interface MarkdownImportMetadataStore extends ContentCommitMetadataStore {
  runMarkdownImportTransaction<Result>(
    operation: (transaction: MarkdownImportMetadataTransaction) => Promise<Result>,
  ): Promise<Result>;
  readMarkdownImportPlan(planId: string): Promise<Readonly<MarkdownImportPlan> | null>;
  readMarkdownImportSession(importId: string): Promise<Readonly<MarkdownImportSession> | null>;
  listMarkdownImportStagedFiles(
    importId: string,
  ): Promise<readonly Readonly<MarkdownImportStagedFile>[]>;
}

export type CapacityOperation = "commit" | "stage" | "export" | "import";
export type CapacityUtilizationState = "normal" | "warning" | "soft_limit" | "hard_limit";
export type CapacityReservationState =
  | "active"
  | "consumed"
  | "cleanup_pending"
  | "released";

export interface CapacityAmounts {
  readonly physicalCanonicalBytes: number;
  readonly temporaryBytes: number;
  readonly d1MetadataBytes: number;
}

export interface CapacityUsageSnapshot extends CapacityAmounts {
  readonly logicalHeadBytes: number;
  readonly logicalRetainedBytes: number;
  readonly reservedBytes: number;
  readonly storageAmplification: number;
  readonly trustworthy: boolean;
  readonly reconciledAt: UtcInstant | null;
}

export interface CapacityReservation {
  readonly reservationId: string;
  readonly requestedByPrincipalId: PrincipalId;
  readonly ownerPrincipalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly operation: CapacityOperation;
  readonly operationRef: string;
  readonly baseRevisionId: RevisionId | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly requested: Readonly<CapacityAmounts>;
  readonly actual: Readonly<CapacityAmounts> | null;
  readonly bulk: boolean;
  readonly heavy: boolean;
  readonly state: CapacityReservationState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface CapacityLimits {
  readonly mindPhysicalCanonicalBytes: number;
  readonly principalPhysicalCanonicalBytes: number;
  readonly sitePhysicalCanonicalBytes: number;
  readonly siteTemporaryBytes: number;
  readonly siteD1MetadataBytes: number;
  readonly ordinaryCommitSoftGrowthBytes: number;
  readonly activeHeavyPerMind: number;
  readonly activeHeavyPerPrincipal: number;
  readonly activeHeavyPerSite: number;
}

export interface CapacityAdmissionRequest {
  readonly reservationId: string;
  readonly requestedByPrincipalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly operation: CapacityOperation;
  readonly operationRef: string;
  readonly baseRevisionId: RevisionId | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly requested: Readonly<CapacityAmounts>;
  readonly bulk: boolean;
  readonly heavy: boolean;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export type CapacityAdmissionResult =
  | {
      readonly kind: "admitted";
      readonly reservation: Readonly<CapacityReservation>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "invalid_request"
        | "owner_not_found"
        | "accounting_untrusted"
        | "soft_limit"
        | "hard_limit"
        | "fairness_limit"
        | "idempotency_conflict";
      readonly utilization: CapacityUtilizationState;
    };

export interface CapacityReservationTransaction {
  readCapacityReservation(
    reservationId: string,
  ): Promise<Readonly<CapacityReservation> | null>;
  admitCapacityReservation(
    request: Readonly<CapacityAdmissionRequest>,
    limits: Readonly<CapacityLimits>,
  ): Promise<CapacityAdmissionResult>;
  consumeCapacityReservation(request: Readonly<{
    reservationId: string;
    actual: Readonly<CapacityAmounts>;
    consumedAt: UtcInstant;
  }>): Promise<"consumed" | "already_consumed" | "not_found" | "state_conflict">;
  cancelCapacityReservation(request: Readonly<{
    reservationId: string;
    canceledAt: UtcInstant;
  }>): Promise<"cleanup_pending" | "already_final" | "not_found">;
}

export interface CapacityReconcileResult {
  readonly spaceId: SpaceId | null;
  readonly scannedSpaces: number;
  readonly driftDetected: boolean;
  readonly usage: Readonly<CapacityUsageSnapshot>;
}

export interface CapacityTelemetrySnapshot {
  readonly canonicalHeadroomBytes: number;
  readonly temporaryHeadroomBytes: number;
  readonly d1HeadroomBytes: number;
  readonly storageAmplification: number;
  readonly quotaRejects: number;
  readonly staleReservations: number;
  readonly utilization: CapacityUtilizationState;
}

/**
 * Privacy-safe capacity authority. Implementations derive committed usage from
 * immutable revision metadata and temporary job/staging records; ledger events
 * and reservations are acceleration/protection state, never the sole source.
 */
export interface CapacityLedgerStore extends MetadataStore {
  runCapacityTransaction<Result>(
    operation: (transaction: CapacityReservationTransaction) => Promise<Result>,
  ): Promise<Result>;
  readMindCapacityUsage(spaceId: SpaceId): Promise<Readonly<CapacityUsageSnapshot> | null>;
  readPrincipalCapacityUsage(
    principalId: PrincipalId,
  ): Promise<Readonly<CapacityUsageSnapshot>>;
  readSiteCapacityUsage(): Promise<Readonly<CapacityUsageSnapshot>>;
  readCapacityTelemetry(
    limits: Readonly<CapacityLimits>,
    now: UtcInstant,
  ): Promise<Readonly<CapacityTelemetrySnapshot>>;
  reconcileCapacityUsage(request: Readonly<{
    spaceId?: SpaceId;
    reconciledAt: UtcInstant;
  }>): Promise<Readonly<CapacityReconcileResult>>;
  collectExpiredCapacityReservations(request: Readonly<{
    now: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<CapacityReservation>[]>;
  releaseCapacityReservation(request: Readonly<{
    reservationId: string;
    releasedAt: UtcInstant;
  }>): Promise<boolean>;
}

/**
 * Race-sensitive content commit view over one rollback-on-error metadata
 * transaction. This boundary intentionally has no provisional audit/outbox
 * hook; AND-66 can add explicit durable stage methods to the same transaction.
 */
export interface ContentCommitMetadataTransaction
  extends AuthorizationTransaction,
    IdempotencyTransaction,
    CapacityReservationTransaction {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult>;
  stageContentCommitEffects(
    request: StageContentCommitEffectsRequest,
  ): Promise<StageContentCommitEffectsResult>;
  readStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileRecord> | null>;
  consumeStagedBundleFiles(
    request: Readonly<ConsumeStagedBundleFilesRequest>,
  ): Promise<ConsumeStagedBundleFilesResult>;
  checkBundleFileRetainedQuota(request: Readonly<{
    spaceId: SpaceId;
    candidateEntries: readonly Readonly<{
      sha256: Sha256Digest;
      size: number;
    }>[];
    maxRetainedBytes: number;
  }>): Promise<boolean>;
}

/** Atomic metadata boundary for one application-level content commit. */
export interface ContentCommitMetadataStore
  extends RevisionMetadataStore,
    BackgroundWorkStore,
    BundleFileStagingStore,
    CapacityLedgerStore,
    SpaceTargetRecordPurger {
  runContentCommitTransaction<Result>(
    operation: (
      transaction: ContentCommitMetadataTransaction,
    ) => Promise<Result>,
  ): Promise<Result>;
}

export interface ExactRevisionIndexDocument {
  readonly path: string;
  /** Derived searchable text. Implementations must never log it. */
  readonly text: string;
}

export interface ReplaceExactRevisionIndexRequest {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly documents: readonly Readonly<ExactRevisionIndexDocument>[];
}

export type ReadExactRevisionIndexResult =
  | {
      readonly kind: "ready";
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
      readonly documents: readonly Readonly<ExactRevisionIndexDocument>[];
    }
  | { readonly kind: "unavailable" };

export type QueryExactRevisionIndexResult =
  | {
      readonly kind: "ready";
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
      /** Joined membership/document count for completeness verification. */
      readonly totalDocuments: number;
      /** Query-specific candidates only; application ranking remains authoritative. */
      readonly documents: readonly Readonly<ExactRevisionIndexDocument>[];
    }
  | { readonly kind: "unavailable" };

/** Revision-keyed derived index. There is deliberately no implicit HEAD API. */
export interface SearchIndex {
  readonly kind: "search-index";
  replaceExactRevision(
    request: ReplaceExactRevisionIndexRequest,
  ): Promise<void>;
  readExactRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<ReadExactRevisionIndexResult>;
  queryExactRevision?(
    spaceId: SpaceId,
    revisionId: RevisionId,
    normalizedTerms: readonly string[],
  ): Promise<QueryExactRevisionIndexResult>;
  purgeSpace(spaceId: SpaceId): Promise<number>;
}

export interface StageContentCommitEffectsRequest {
  readonly auditEvent: Readonly<AuditEvent>;
  readonly auditOutbox: Readonly<AuditOutboxMessage>;
  readonly indexJob: Readonly<BackgroundJob>;
  readonly indexState: Readonly<RevisionIndexState>;
}

export type StageContentCommitEffectsResult =
  | { readonly kind: "staged" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "effect_id_collision" }
  | { readonly kind: "invalid_effects" };

export type ClaimIndexJobResult =
  | {
      readonly kind: "claimed";
      readonly job: Readonly<BackgroundJob>;
      readonly indexState: Readonly<RevisionIndexState>;
    }
  | { readonly kind: "not_found" | "not_available" | "completed" };

export type ClaimAuditOutboxResult =
  | {
      readonly kind: "claimed";
      readonly message: Readonly<AuditOutboxMessage>;
      readonly event: Readonly<AuditEvent>;
    }
  | { readonly kind: "not_found" | "not_available" | "completed" };

export interface RevisionIndexRecoveryGap {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
}

export type EnsureRevisionIndexQueuedResult =
  | { readonly kind: "queued"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "already_present"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "revision_not_found" | "not_current_head" | "invalid_effects" };

export interface BackgroundWorkStore extends MetadataStore {
  listRecoverableIndexJobs(
    now: UtcInstant,
    limit: number,
  ): Promise<readonly Readonly<BackgroundJob>[]>;
  listActiveRevisionIndexGaps(
    limit: number,
  ): Promise<readonly Readonly<RevisionIndexRecoveryGap>[]>;
  ensureRevisionIndexQueued(
    job: Readonly<BackgroundJob>,
    state: Readonly<RevisionIndexState>,
  ): Promise<EnsureRevisionIndexQueuedResult>;
  claimIndexJob(
    jobId: JobId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimIndexJobResult>;
  completeIndexJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    completedAt: UtcInstant,
  ): Promise<boolean>;
  failIndexJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    failureCode: string,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
  readRevisionIndexState(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<RevisionIndexState> | null>;
  claimAuditOutbox(
    outboxMessageId: OutboxMessageId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimAuditOutboxResult>;
  completeAuditOutbox(
    outboxMessageId: OutboxMessageId,
    expectedClaimVersion: Version,
    completedAt: UtcInstant,
  ): Promise<boolean>;
  failAuditOutbox(
    outboxMessageId: OutboxMessageId,
    expectedClaimVersion: Version,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
}

export type ClaimInvitationExpiryJobResult =
  | { readonly kind: "claimed"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "not_found" | "not_available" | "completed" };

export type CompleteInvitationExpiryJobResult =
  | { readonly kind: "expired" | "already_terminal" }
  | { readonly kind: "not_found" | "not_available" };

/** Durable invitation expiry jobs carry only an invitation ID, never authority. */
export interface InvitationExpiryJobStore extends MetadataStore {
  claimInvitationExpiryJob(
    jobId: JobId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimInvitationExpiryJobResult>;
  completeInvitationExpiryJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    completedAt: UtcInstant,
  ): Promise<CompleteInvitationExpiryJobResult>;
  failInvitationExpiryJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
}

export interface SpaceTargetPurgeResult {
  readonly backgroundJobs: number;
  readonly indexStates: number;
  readonly auditEvents: number;
  readonly auditOutboxMessages: number;
  readonly idempotencyRecords: number;
}

/** Explicit delete-all hook for target-linked durable service records. */
export interface SpaceTargetRecordPurger {
  purgeSpaceTargetRecords(spaceId: SpaceId): Promise<SpaceTargetPurgeResult>;
}

export interface CurrentAuthorizationMembership {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly role: Role;
  readonly state: MembershipState;
  readonly version: Version;
}

export interface CurrentAuthorizationToken {
  readonly tokenId: TokenId;
  readonly principalId: PrincipalId;
  readonly state: AccessTokenState;
  readonly scopes: EffectiveTokenScopes;
  readonly version: Version;
  readonly expiresAt: UtcInstant;
}

/**
 * Minimal trusted state required for one authorization decision. Implementations
 * must produce a fresh immutable snapshot for every read.
 */
export interface CurrentAuthorizationState {
  readonly principal: {
    readonly principalId: PrincipalId;
    readonly state: PrincipalState;
  };
  readonly space: {
    readonly spaceId: SpaceId;
    readonly state: SpaceLifecycleState;
    readonly visibility: Visibility;
    readonly accessVersion: Version;
  };
  readonly membership: CurrentAuthorizationMembership | null;
  readonly token: Readonly<CurrentAuthorizationToken> | null;
}

export interface AuthorizationStateQuery {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly tokenId: TokenId | null;
}

export interface AuthorizationStateReader {
  readCurrentAuthorizationState(
    query: AuthorizationStateQuery,
  ): Promise<CurrentAuthorizationState | null>;
}

/** A state reader whose reads participate in the caller's metadata transaction. */
export interface AuthorizationTransaction extends AuthorizationStateReader {
  readonly kind: "authorization-transaction";
  /** Optional binding snapshot available to binding-aware content transactions. */
  readMindBindingSet?(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<MindBindingSetSnapshot> | null>;
}

export interface MindBindingSetSnapshot {
  readonly bindingSet: Readonly<MindBindingSet>;
  readonly readBindings: readonly Readonly<ReadMindBinding>[];
  readonly writeBinding: Readonly<WriteMindBinding> | null;
}

interface MindBindingMutationRequestBase {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly expectedBindingVersion: BindingVersion;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export type ApplyReadMindBindingRequest =
  | (MindBindingMutationRequestBase & {
      readonly action: "attach";
      readonly spaceId: SpaceId;
      readonly readBindingId: ReadMindBindingId;
    })
  | (MindBindingMutationRequestBase & {
      readonly action: "detach";
      readonly spaceId: SpaceId;
      readonly readBindingId: null;
    });

export type ApplyWriteMindBindingRequest =
  | (MindBindingMutationRequestBase & {
      readonly action: "bind";
      readonly spaceId: SpaceId;
      readonly writeBindingId: WriteMindBindingId;
    })
  | (MindBindingMutationRequestBase & {
      readonly action: "unbind";
      readonly spaceId: null;
      readonly writeBindingId: null;
    });

export type ApplyAutomaticCapturePolicyRequest =
  | (MindBindingMutationRequestBase & {
      readonly action: "enable";
      readonly spaceId: SpaceId;
      readonly writeBindingId: WriteMindBindingId;
      readonly mode: "routine_non_sensitive";
    })
  | (MindBindingMutationRequestBase & {
      readonly action: "disable";
      readonly spaceId: SpaceId | null;
      readonly writeBindingId: null;
      readonly mode: "disabled";
    });

export type ApplyMindBindingMutationResult =
  | {
      readonly kind: "applied";
      readonly bindings: Readonly<MindBindingSetSnapshot>;
      readonly previousWriteBinding: Readonly<WriteMindBinding> | null;
      readonly changed: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "binding_version_conflict";
      readonly currentBindingVersion: BindingVersion;
    }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "binding_owner_revoked" }
  | { readonly kind: "owner_mismatch" | "effect_conflict" | "invalid_record" };

export interface RevokeMindBindingOwnerRequest {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export type RevokeMindBindingOwnerResult =
  | {
      readonly kind: "revoked";
      readonly invalidatedReadBindings: number;
      readonly invalidatedWriteBindings: number;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "not_found"
        | "owner_mismatch"
        | "effect_conflict"
        | "invalid_record";
    };

/** Atomic binding mutation plus fresh authorization transaction. */
export interface MindBindingTransaction extends AuthorizationTransaction {
  readMindBindingSet(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<MindBindingSetSnapshot> | null>;
  applyReadMindBinding(
    request: Readonly<ApplyReadMindBindingRequest>,
  ): Promise<ApplyMindBindingMutationResult>;
  applyWriteMindBinding(
    request: Readonly<ApplyWriteMindBindingRequest>,
  ): Promise<ApplyMindBindingMutationResult>;
  applyAutomaticCapturePolicy(
    request: Readonly<ApplyAutomaticCapturePolicyRequest>,
  ): Promise<ApplyMindBindingMutationResult>;
}

export interface MindBindingStore
  extends MetadataStore,
    AuthorizationStateReader {
  readMindBindingSet(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<MindBindingSetSnapshot> | null>;
  runMindBindingTransaction<Result>(
    operation: (transaction: MindBindingTransaction) => Promise<Result>,
  ): Promise<Result>;
  revokeMindBindingOwner(
    request: Readonly<RevokeMindBindingOwnerRequest>,
  ): Promise<RevokeMindBindingOwnerResult>;
}

export interface AuthorizationRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly capability: Capability;
  readonly revisionMode: RevisionMode;
  /** Exact immutable generation required by a binding-aware write boundary. */
  readonly bindingRequirement?:
    | { readonly kind: "read" }
    | {
      readonly kind: "write";
      readonly writeBindingId: WriteMindBindingId;
    }
    | {
        readonly kind: "automatic_capture";
        readonly writeBindingId: WriteMindBindingId;
        readonly expectedBindingVersion: BindingVersion;
      };
}

export interface AuthorizationStamp {
  readonly accessVersion: Version;
  readonly membershipVersion: Version | null;
  readonly tokenVersion: Version | null;
  /** Present only on the MCP binding-aware content boundary. */
  readonly bindingVersion?: BindingVersion;
}

export type AuthorizationGrant =
  | { readonly kind: "membership"; readonly role: Role }
  | {
      readonly kind: "baseline_visibility";
      readonly visibility: "public" | "unlisted";
    };

export type AuthorizationDenialCode =
  | "authentication_required"
  | "invalid_authorization_request"
  | "authorization_state_unavailable"
  | "token_inactive"
  | "access_denied"
  | "capability_denied"
  | "insufficient_scope"
  | "deployment_capability_disabled"
  | "historical_read_only"
  | "authorization_state_changed"
  | "mind_binding_required"
  | "write_binding_required"
  | "write_binding_stale"
  | "binding_owner_revoked"
  | "binding_state_unavailable";

export type AuthorizationDecision =
  | {
      readonly kind: "allowed";
      readonly capability: Capability;
      readonly grant: AuthorizationGrant;
      readonly stamp: AuthorizationStamp;
    }
  | {
      readonly kind: "denied";
      readonly code: AuthorizationDenialCode;
      readonly retryable: boolean;
    };

export interface Authorizer {
  /** Must complete before any target metadata, object, or index read. */
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;

  /**
   * Re-reads authorization state inside a race-sensitive metadata transaction.
   * A changed-but-still-allowed state forces a retry instead of using a stale
   * preflight decision.
   */
  reauthorizeInTransaction(
    request: AuthorizationRequest,
    transaction: AuthorizationTransaction,
    expected: AuthorizationStamp,
  ): Promise<AuthorizationDecision>;
}

export interface BackgroundAuthorizationRequest {
  readonly actor: ActorContext;
  /** Durable principal identity captured by the originating command. */
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly capability: Capability;
  readonly revisionMode: RevisionMode;
}

export interface BackgroundAuthorizer {
  /**
   * Rebuilds authority from trusted deployment context and current metadata.
   * Serialized token, role, membership and visibility claims are not inputs.
   */
  authorize(
    request: BackgroundAuthorizationRequest,
  ): Promise<AuthorizationDecision>;
}

export interface AuthorizedHandleReadRequest extends HandleResolutionRequest {
  readonly actor: ActorContext;
  readonly capability: Capability;
  readonly revisionMode: RevisionMode;
}

/** Reads target metadata/objects only after exact handle resolution and access. */
export interface ResolvedSpaceReader<Value> {
  readResolvedSpace(spaceId: SpaceId): Promise<Value | null>;
}

export type AuthorizedHandleReadResult<Value> =
  | {
      readonly kind: "found";
      readonly spaceId: SpaceId;
      readonly value: Value;
    }
  | { readonly kind: "not_found" };

const HANDLE_TARGET_NOT_FOUND = Object.freeze({ kind: "not_found" } as const);

/**
 * Keeps missing handles and access denial externally indistinguishable while
 * enforcing resolve -> authorize -> target read ordering.
 */
export class AuthorizedHandleReader<Value> {
  readonly #handles: HandleRegistry;
  readonly #authorizer: Authorizer;
  readonly #targets: ResolvedSpaceReader<Value>;

  constructor(dependencies: {
    readonly handles: HandleRegistry;
    readonly authorizer: Authorizer;
    readonly targets: ResolvedSpaceReader<Value>;
  }) {
    this.#handles = dependencies.handles;
    this.#authorizer = dependencies.authorizer;
    this.#targets = dependencies.targets;
  }

  async read(
    request: AuthorizedHandleReadRequest,
  ): Promise<AuthorizedHandleReadResult<Value>> {
    const resolution = await this.#handles.resolveHandle({
      host: request.host,
      handle: request.handle,
    });
    if (resolution.kind === "not_found") return HANDLE_TARGET_NOT_FOUND;

    const authorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: resolution.spaceId,
      capability: request.capability,
      revisionMode: request.revisionMode,
    });
    if (authorization.kind === "denied") return HANDLE_TARGET_NOT_FOUND;

    const value = await this.#targets.readResolvedSpace(resolution.spaceId);
    if (value === null) return HANDLE_TARGET_NOT_FOUND;
    return Object.freeze({
      kind: "found",
      spaceId: resolution.spaceId,
      value,
    });
  }
}

function denied(
  code: AuthorizationDenialCode,
  retryable = false,
): AuthorizationDecision {
  return Object.freeze({ kind: "denied", code, retryable });
}

function isRegisteredActor(
  actor: unknown,
): actor is Extract<ActorContext, { kind: "registered_principal" }> {
  return isRecord(actor) && actor.kind === "registered_principal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isKnownCapability(capability: unknown): capability is Capability {
  return (
    typeof capability === "string" &&
    (CAPABILITIES as readonly string[]).includes(capability)
  );
}

function isValidRevisionMode(mode: unknown): mode is RevisionMode {
  return mode === "head" || mode === "historical";
}

function isValidVersion(value: unknown): value is Version {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isValidTokenScopes(value: unknown): value is EffectiveTokenScopes {
  if (!Array.isArray(value)) return false;
  return (
    (value.length === 1 && value[0] === "content:read") ||
    (value.length === 2 &&
      value[0] === "content:read" &&
      value[1] === "content:write")
  );
}

function isValidMembership(
  value: unknown,
): value is CurrentAuthorizationMembership | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.principalId === "string" &&
    typeof value.spaceId === "string" &&
    isOneOf(value.role, ROLES) &&
    isOneOf(value.state, MEMBERSHIP_STATES) &&
    isValidVersion(value.version)
  );
}

function isValidToken(
  value: unknown,
): value is Readonly<CurrentAuthorizationToken> | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.tokenId === "string" &&
    typeof value.principalId === "string" &&
    isOneOf(value.state, ACCESS_TOKEN_STATES) &&
    isValidTokenScopes(value.scopes) &&
    isValidVersion(value.version) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

function isValidCurrentAuthorizationState(
  value: unknown,
): value is CurrentAuthorizationState {
  if (!isRecord(value) || !isRecord(value.principal) || !isRecord(value.space)) {
    return false;
  }
  return (
    typeof value.principal.principalId === "string" &&
    isOneOf(value.principal.state, PRINCIPAL_STATES) &&
    typeof value.space.spaceId === "string" &&
    isOneOf(value.space.state, SPACE_LIFECYCLE_STATES) &&
    isOneOf(value.space.visibility, VISIBILITIES) &&
    isValidVersion(value.space.accessVersion) &&
    isValidMembership(value.membership) &&
    isValidToken(value.token)
  );
}

function sameStamp(left: AuthorizationStamp, right: AuthorizationStamp): boolean {
  return (
    left.accessVersion === right.accessVersion &&
    left.membershipVersion === right.membershipVersion &&
    left.tokenVersion === right.tokenVersion
  );
}

function isExpired(expiresAt: UtcInstant, occurredAt: UtcInstant): boolean | null {
  const expiry = Date.parse(expiresAt);
  const current = Date.parse(occurredAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(current)) return null;
  return expiry <= current;
}

export class CapabilityAuthorizer implements Authorizer {
  readonly #states: AuthorizationStateReader;

  constructor(states: AuthorizationStateReader) {
    this.#states = states;
  }

  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    return this.#authorizeWith(this.#states, request);
  }

  /** One current-state read for a closed capability set on the same target. */
  async authorizeCapabilities(request: {
    readonly actor: ActorContext;
    readonly spaceId: SpaceId;
    readonly capabilities: readonly Capability[];
    readonly revisionMode: RevisionMode;
  }): Promise<readonly AuthorizationDecision[]> {
    const registered = isRegisteredActor(request.actor) ? request.actor : null;
    const authentication = registered?.authentication ?? null;
    const canReadOnce =
      authentication !== null &&
      (authentication.kind === "sites_identity" || authentication.kind === "mcp_token") &&
      request.capabilities.every(isKnownCapability) &&
      isValidRevisionMode(request.revisionMode) &&
      registered !== null &&
      Array.isArray(registered.deploymentCapabilities) &&
      registered.deploymentCapabilities.every(isKnownCapability);
    const currentState = canReadOnce
      ? this.#states.readCurrentAuthorizationState({
          principalId: registered!.principalId,
          spaceId: request.spaceId,
          tokenId:
            authentication.kind === "mcp_token" ? authentication.tokenId : null,
        })
      : undefined;
    return Object.freeze(
      await Promise.all(
        request.capabilities.map((capability) =>
          this.#authorizeWith(
            this.#states,
            {
              actor: request.actor,
              spaceId: request.spaceId,
              capability,
              revisionMode: request.revisionMode,
            },
            currentState,
          )),
      ),
    );
  }

  async reauthorizeInTransaction(
    request: AuthorizationRequest,
    transaction: AuthorizationTransaction,
    expected: AuthorizationStamp,
  ): Promise<AuthorizationDecision> {
    const decision = await this.#authorizeWith(transaction, request);
    if (decision.kind === "denied") return decision;
    if (!sameStamp(decision.stamp, expected)) {
      return denied("authorization_state_changed", true);
    }
    return decision;
  }

  async #authorizeWith(
    states: AuthorizationStateReader,
    request: AuthorizationRequest,
    currentState?: Promise<Readonly<CurrentAuthorizationState> | null>,
  ): Promise<AuthorizationDecision> {
    if (!isRegisteredActor(request.actor)) {
      return denied("authentication_required");
    }
    if (
      !isKnownCapability(request.capability) ||
      !isValidRevisionMode(request.revisionMode) ||
      !Array.isArray(request.actor.deploymentCapabilities) ||
      !request.actor.deploymentCapabilities.every(isKnownCapability)
    ) {
      return denied("invalid_authorization_request");
    }

    const authentication = request.actor.authentication;
    if (
      authentication.kind !== "sites_identity" &&
      authentication.kind !== "mcp_token"
    ) {
      return denied("authentication_required");
    }
    const tokenId =
      authentication.kind === "mcp_token" ? authentication.tokenId : null;
    const state = await (currentState ?? states.readCurrentAuthorizationState({
      principalId: request.actor.principalId,
      spaceId: request.spaceId,
      tokenId,
    }));
    if (!isValidCurrentAuthorizationState(state)) {
      return denied("authorization_state_unavailable");
    }
    if (
      state.principal.principalId !== request.actor.principalId ||
      state.space.spaceId !== request.spaceId ||
      state.principal.state !== "active" ||
      state.space.state !== "active"
    ) {
      return denied("authorization_state_unavailable");
    }

    let tokenVersion: Version | null = null;
    if (authentication.kind === "mcp_token") {
      const token = state.token;
      const expired = token
        ? isExpired(token.expiresAt, request.actor.occurredAtUtc)
        : null;
      if (
        token === null ||
        token.tokenId !== authentication.tokenId ||
        token.principalId !== request.actor.principalId ||
        token.state !== "active" ||
        expired !== false
      ) {
        return token !== null && expired === null
          ? denied("invalid_authorization_request")
          : denied("token_inactive");
      }
      tokenVersion = token.version;
    }

    const membership = state.membership;
    const hasMatchingMembership =
      membership !== null &&
      membership.principalId === request.actor.principalId &&
      membership.spaceId === request.spaceId;
    if (membership !== null && !hasMatchingMembership) {
      return denied("authorization_state_unavailable");
    }

    let grant: AuthorizationGrant;
    let grantedCapabilities: readonly Capability[];
    let membershipVersion: Version | null = null;
    if (hasMatchingMembership && membership.state === "active") {
      grant = Object.freeze({ kind: "membership", role: membership.role });
      grantedCapabilities = capabilitiesForRole(membership.role);
      membershipVersion = membership.version;
    } else {
      const baselineCapabilities = capabilitiesForVisibilityGrant(
        state.space.visibility,
      );
      if (baselineCapabilities.length === 0) return denied("access_denied");
      grant = Object.freeze({
        kind: "baseline_visibility",
        visibility: state.space.visibility,
      }) as AuthorizationGrant;
      grantedCapabilities = baselineCapabilities;
    }

    if (!grantedCapabilities.includes(request.capability)) {
      return denied("capability_denied");
    }
    if (
      authentication.kind === "mcp_token" &&
      !tokenScopesAllowCapability(state.token!.scopes, request.capability)
    ) {
      return denied("insufficient_scope");
    }
    if (!request.actor.deploymentCapabilities.includes(request.capability)) {
      return denied("deployment_capability_disabled");
    }
    if (!revisionModeAllowsCapability(request.revisionMode, request.capability)) {
      return denied("historical_read_only");
    }

    return Object.freeze({
      kind: "allowed",
      capability: request.capability,
      grant,
      stamp: Object.freeze({
        accessVersion: state.space.accessVersion,
        membershipVersion,
        tokenVersion,
      }),
    });
  }
}

/** Current-access authorizer for trusted workers acting for a captured principal. */
export class CurrentAccessBackgroundAuthorizer implements BackgroundAuthorizer {
  readonly #states: AuthorizationStateReader;

  constructor(states: AuthorizationStateReader) {
    this.#states = states;
  }

  async authorize(
    request: BackgroundAuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    if (
      request.actor.kind !== "service" ||
      typeof request.actor.serviceId !== "string" ||
      request.actor.serviceId.length === 0
    ) {
      return denied("authentication_required");
    }
    if (
      !isKnownCapability(request.capability) ||
      !isValidRevisionMode(request.revisionMode)
    ) {
      return denied("invalid_authorization_request");
    }
    if (!request.actor.deploymentCapabilities.includes(request.capability)) {
      return denied("deployment_capability_disabled");
    }
    if (!revisionModeAllowsCapability(request.revisionMode, request.capability)) {
      return denied("historical_read_only");
    }

    const state = await this.#states.readCurrentAuthorizationState({
      principalId: request.principalId,
      spaceId: request.spaceId,
      tokenId: null,
    });
    if (
      !isValidCurrentAuthorizationState(state) ||
      state.principal.principalId !== request.principalId ||
      state.space.spaceId !== request.spaceId ||
      state.principal.state !== "active" ||
      state.space.state !== "active"
    ) {
      return denied("authorization_state_unavailable");
    }

    const membership = state.membership;
    if (
      membership !== null &&
      (membership.principalId !== request.principalId ||
        membership.spaceId !== request.spaceId)
    ) {
      return denied("authorization_state_unavailable");
    }
    let grant: AuthorizationGrant;
    let grantedCapabilities: readonly Capability[];
    let membershipVersion: Version | null = null;
    if (
      membership !== null &&
      membership.principalId === request.principalId &&
      membership.spaceId === request.spaceId &&
      membership.state === "active"
    ) {
      grant = Object.freeze({ kind: "membership", role: membership.role });
      grantedCapabilities = capabilitiesForRole(membership.role);
      membershipVersion = membership.version;
    } else {
      grantedCapabilities = capabilitiesForVisibilityGrant(state.space.visibility);
      if (grantedCapabilities.length === 0) return denied("access_denied");
      grant = Object.freeze({
        kind: "baseline_visibility",
        visibility: state.space.visibility,
      }) as AuthorizationGrant;
    }
    if (!grantedCapabilities.includes(request.capability)) {
      return denied("capability_denied");
    }
    return Object.freeze({
      kind: "allowed",
      capability: request.capability,
      grant,
      stamp: Object.freeze({
        accessVersion: state.space.accessVersion,
        membershipVersion,
        tokenVersion: null,
      }),
    });
  }
}

declare const tokenVerifierBrand: unique symbol;

/** Fixed-length, versioned cryptographic verifier. It is never a public token ID. */
export type TokenVerifier = string & {
  readonly [tokenVerifierBrand]: "TokenVerifier";
};

export interface PersistedTokenSecretMaterial {
  readonly format: "mdp_v1";
  readonly algorithm: "hmac-sha256";
  readonly verifierVersion: "v1";
  readonly verifier: TokenVerifier;
  readonly displayPrefix: string;
}

/**
 * Secret-bearing issuance boundary. Implementations expose the secret through
 * exactly one consume call and keep it out of enumerable/serializable fields.
 */
export interface IssuedTokenSecret {
  readonly displayPrefix: string;
  consumeSecret(): string | null;
  persistence(): Readonly<PersistedTokenSecretMaterial>;
}

export type TokenVerifierLookupResult<Value> =
  | {
      readonly kind: "found";
      readonly verifier: TokenVerifier;
      readonly value: Value;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" };

/** Exact indexed lookup; displayPrefix must never be used as the lookup key. */
export interface TokenVerifierLookup<Value> {
  findByVerifier(
    verifier: TokenVerifier,
  ): Promise<TokenVerifierLookupResult<Value>>;
}

export type TokenVerificationResult<Value> =
  | { readonly kind: "verified"; readonly value: Value }
  | { readonly kind: "invalid" };

export interface TokenHasher {
  readonly kind: "token-hasher";
  issueSecret(): Promise<IssuedTokenSecret>;
  verifySecret<Value>(
    candidate: unknown,
    lookup: TokenVerifierLookup<Value>,
  ): Promise<TokenVerificationResult<Value>>;
}

/** Safe lifecycle metadata. The cryptographic verifier is deliberately absent. */
export interface McpTokenMetadata {
  readonly tokenId: TokenId;
  readonly principalId: PrincipalId;
  readonly name: string;
  readonly displayPrefix: string;
  readonly scopes: EffectiveTokenScopes;
  readonly state: AccessTokenState;
  readonly version: Version;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly lastUsedAt: UtcInstant | null;
  readonly revokedAt: UtcInstant | null;
}

export interface CreateMcpTokenRequest {
  readonly tokenId: TokenId;
  readonly principalId: PrincipalId;
  readonly name: string;
  readonly verifier: TokenVerifier;
  readonly displayPrefix: string;
  readonly scopes: EffectiveTokenScopes;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export type CreateMcpTokenResult =
  | {
      readonly kind: "created";
      readonly token: Readonly<McpTokenMetadata>;
    }
  | {
      readonly kind:
        | "token_id_conflict"
        | "verifier_conflict"
        | "principal_deleted"
        | "invalid_record";
    };

export interface RevokeMcpTokenRequest {
  readonly principalId: PrincipalId;
  readonly tokenId: TokenId;
  readonly revokedAt: UtcInstant;
}

export type RevokeMcpTokenResult =
  | {
      readonly kind: "revoked";
      readonly token: Readonly<McpTokenMetadata>;
      readonly replayed: boolean;
    }
  | { readonly kind: "not_found" };

export interface RevokePrincipalTokensForAccountDeletionRequest {
  readonly principalId: PrincipalId;
  readonly revokedAt: UtcInstant;
}

export interface RevokePrincipalTokensForAccountDeletionResult {
  readonly revokedCount: number;
  readonly replayed: boolean;
}

/** Safe exact token-table state used to bind an account deletion preview. */
export interface PrincipalTokenDeletionSnapshot {
  readonly principalId: PrincipalId;
  readonly activeTokenCount: number;
  readonly stateFingerprint: string;
}

export interface BeginPrincipalTokenDeletionRequest {
  readonly principalId: PrincipalId;
  readonly expectedStateFingerprint: string;
  readonly occurredAt: UtcInstant;
}

export type BeginPrincipalTokenDeletionResult =
  | { readonly kind: "reserved"; readonly replayed: boolean }
  | { readonly kind: "state_changed" | "principal_deleted" };

export interface CompletePrincipalTokenDeletionRequest {
  readonly principalId: PrincipalId;
  readonly expectedStateFingerprint: string;
  readonly revokedAt: UtcInstant;
}

export type CompletePrincipalTokenDeletionResult =
  | {
      readonly kind: "completed";
      readonly revokedCount: number;
      readonly replayed: boolean;
    }
  | { readonly kind: "reservation_not_found" | "state_changed" };

export interface CancelPrincipalTokenDeletionRequest {
  readonly principalId: PrincipalId;
  readonly expectedStateFingerprint: string;
}

/** Server-side generator; token IDs are never accepted from browser input. */
export interface TokenIdGenerator {
  nextTokenId(): TokenId;
}

/**
 * Principal-scoped token persistence. Account deletion atomically prevents any
 * later issuance for that principal and revokes every existing token.
 */
export interface McpTokenStore
  extends MetadataStore,
    TokenVerifierLookup<Readonly<CurrentAuthorizationToken>> {
  createMcpToken(request: CreateMcpTokenRequest): Promise<CreateMcpTokenResult>;
  listMcpTokenMetadata(
    principalId: PrincipalId,
  ): Promise<readonly Readonly<McpTokenMetadata>[]>;
  readMcpTokenForAuthorization(
    tokenId: TokenId,
  ): Promise<Readonly<CurrentAuthorizationToken> | null>;
  revokeMcpToken(request: RevokeMcpTokenRequest): Promise<RevokeMcpTokenResult>;
  revokePrincipalTokensForAccountDeletion(
    request: RevokePrincipalTokensForAccountDeletionRequest,
  ): Promise<RevokePrincipalTokensForAccountDeletionResult>;
  readPrincipalTokenDeletionSnapshot(
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<PrincipalTokenDeletionSnapshot>>;
  beginPrincipalTokenDeletion(
    request: BeginPrincipalTokenDeletionRequest,
  ): Promise<BeginPrincipalTokenDeletionResult>;
  completePrincipalTokenDeletion(
    request: CompletePrincipalTokenDeletionRequest,
  ): Promise<CompletePrincipalTokenDeletionResult>;
  cancelPrincipalTokenDeletion(
    request: CancelPrincipalTokenDeletionRequest,
  ): Promise<boolean>;
}

export interface AuditSink {
  readonly kind: "audit-sink";
  /** Delivery is idempotent by auditEventId. */
  deliver(event: Readonly<AuditEvent>): Promise<"delivered" | "duplicate">;
  /** Delete-all policy removes delivered events still linked to the target Space. */
  purgeSpace(spaceId: SpaceId): Promise<number>;
  /** Retained foreign-Space events lose the deleted account's principal identity. */
  tombstonePrincipal(
    principalId: PrincipalId,
    deletedPrincipalId: DeletedPrincipalId,
  ): Promise<number>;
}

/**
 * Closed telemetry vocabulary. Events intentionally have no free-form labels,
 * payload, query, URL, email, token, principal, Space, or content fields.
 */
export const PRIVACY_SAFE_OPERATIONAL_METRICS = [
  "request_latency_ms",
  "request_error",
  "authentication_outcome",
  "cas_conflict",
  "index_lag_ms",
  "export_lag_ms",
  "invitation_outcome",
  "token_outcome",
  "deletion_outcome",
  "rate_limit",
  "storage_cost_bytes",
  "query_cost_units",
  "cleanup_queue_age_ms",
  "cleanup_reclaimed_bytes",
  "cleanup_orphan_count",
  "cleanup_retry_count",
  "cleanup_failure_count",
] as const;

export const PRIVACY_SAFE_PILOT_METRICS = [
  "setup_completion",
  "time_to_first_useful_search_ms",
  "time_to_first_meaningful_commit_ms",
  "usage",
  "retention",
  "lexical_search_effectiveness",
  "citation_success",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_SURFACES = [
  "control",
  "content",
  "background",
  "mcp",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_OPERATIONS = [
  "request",
  "home",
  "authentication",
  "mcp_modern",
  "mcp_compatibility",
  "stage_authentication",
  "stage_application",
  "stage_total",
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "get_mind_bindings",
  "browse_entries",
  "fetch",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "set_read_mind_binding",
  "set_write_mind_binding",
  "stage_bundle_file",
  "list_bundle_files",
  "get_bundle_file_download",
  "capture_knowledge",
  "start_export",
  "get_export_status",
  "commit_changeset",
  "revision_index",
  "export",
  "invitation",
  "token",
  "deletion",
  "rate_limit",
  "setup",
  "retention_week_1",
  "retention_week_4",
  "search",
  "read",
  "write",
  "history",
  "storage",
  "cleanup",
  "recovery_index_gaps",
  "recovery_index_dispatch",
  "recovery_export_dispatch",
  "recovery_staging_cleanup",
  "recovery_import_cleanup",
  "recovery_object_cleanup",
  "recovery_total",
  "citation",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_OUTCOMES = [
  "success",
  "failure",
  "denied",
  "conflict",
  "retry",
  "replayed",
  "rate_limited",
  "unavailable",
  "completed",
  "retained",
  "resolved",
  "unresolved",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_UNITS = [
  "count",
  "milliseconds",
  "bytes",
  "query_units",
  "ratio",
] as const;

export const PILOT_COHORTS = ["close_circle", "external"] as const;

export type PrivacySafeOperationalMetric =
  (typeof PRIVACY_SAFE_OPERATIONAL_METRICS)[number];
export type PrivacySafePilotMetric =
  (typeof PRIVACY_SAFE_PILOT_METRICS)[number];
export type PrivacySafeObservabilityMetric =
  | PrivacySafeOperationalMetric
  | PrivacySafePilotMetric;
export type PrivacySafeObservabilitySurface =
  (typeof PRIVACY_SAFE_OBSERVABILITY_SURFACES)[number];
export type PrivacySafeObservabilityOperation =
  (typeof PRIVACY_SAFE_OBSERVABILITY_OPERATIONS)[number];
export type PrivacySafeObservabilityOutcome =
  (typeof PRIVACY_SAFE_OBSERVABILITY_OUTCOMES)[number];
export type PrivacySafeObservabilityUnit =
  (typeof PRIVACY_SAFE_OBSERVABILITY_UNITS)[number];
export type PilotCohort = (typeof PILOT_COHORTS)[number];

export interface PrivacySafeObservabilityEvent {
  readonly kind: "operational" | "pilot";
  readonly metric: PrivacySafeObservabilityMetric;
  readonly surface: PrivacySafeObservabilitySurface;
  readonly operation: PrivacySafeObservabilityOperation;
  readonly outcome: PrivacySafeObservabilityOutcome;
  readonly unit: PrivacySafeObservabilityUnit;
  readonly value: number;
  readonly occurredAtUtc: UtcInstant;
  readonly requestId: ActorContext["requestId"] | null;
  readonly jobId: JobId | null;
  readonly cohort: PilotCohort | null;
}

/** Best-effort telemetry must never participate in an authoritative transaction. */
export interface PrivacySafeObservabilitySink {
  readonly kind: "privacy-safe-observability-sink";
  record(event: Readonly<PrivacySafeObservabilityEvent>): void | Promise<void>;
}
