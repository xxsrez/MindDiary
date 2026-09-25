import type {
  ActorContext,
  RequestId,
} from "@mind-diary/application-contracts";

import {
  type AuditEventId,
  type CredentialWriteTargetGenerationId,
  type BackgroundJob,
  type CanonicalRevisionEnvelope,
  type CanonicalSpaceHandle,
  type DeletedPrincipalId,
  type InvitationId,
  type HandlePolicyFailureReason,
  type MembershipId,
  type MembershipState,
  type IdempotencyKey,
  type ExternalIdentityBinding,
  type KnowledgeSpace,
  type PersonalSpaceBinding,
  type Principal,
  type PrincipalAccountSnapshot,
  type PrincipalId,
  type TokenId,
  type MindBindingOwnerId,
  type JobId,
  type OutboxMessageId,
  type PrincipalState,
  type RevisionId,
  type ReadMindBindingId,
  type RevisionIndexState,
  type Role,
  type SensitiveExternalBinding,
  type Sha256Digest,
  type SpaceId,
  type SpaceRevision,
  type SpaceInvitation,
  type SpaceMembership,
  type UtcInstant,
  type VerifiedSpaceHost,
  type Version,
  type Visibility,
  type WriteMindBindingId,
} from "@mind-diary/domain";

import {
  type MetadataStore,
} from "./runtime.js";

import {
  type SpaceCanonicalObjectKind,
} from "./objects.js";

import {
  type CapacityLimits,
} from "./revisions.js";

import {
  type CurrentAuthorizationState,
  type AuthorizationStateQuery,
  type AuthorizationStateReader,
  type BatchAuthorizationStateReader,
  type AuthorizationTransaction,
  type AuthorizationStamp,
  type ResolvedSpaceReader,
} from "./authorization.js";

export interface MindBindingIdGenerator {
  nextReadMindBindingId(): ReadMindBindingId;
  nextWriteMindBindingId(): WriteMindBindingId;
  nextMindBindingAuditEventId(): AuditEventId;
  nextMindBindingOutboxMessageId(): OutboxMessageId;
}

export interface CredentialWriteTargetIdGenerator {
  nextCredentialWriteTargetGenerationId(): CredentialWriteTargetGenerationId;
  nextCredentialWriteTargetAuditEventId(): AuditEventId;
  nextCredentialWriteTargetOutboxMessageId(): OutboxMessageId;
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
    readonly description: string | null;
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

export interface UpdatePersonalMindDescriptionRequest {
  readonly configurationCredential?: { readonly tokenId: TokenId; readonly bindingOwnerId: MindBindingOwnerId };
  readonly principalId: PrincipalId;
  readonly description: string | null;
  readonly expectedPersonalMetadataVersion: Version;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
}

export type UpdatePersonalMindDescriptionResult =
  | {
      readonly kind: "updated";
      readonly profile: Readonly<PersonalMindProfileSnapshot>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "metadata_conflict";
      readonly currentPersonalMetadataVersion: Version;
    }
  | {
      readonly kind:
        | "configuration_forbidden"
        | "description_required_for_write"
        | "idempotency_conflict"
        | "not_found"
        | "invalid_record";
    };

export interface PersonalMindMetadataTransaction {
  renamePersonalProfile(
    request: RenamePersonalProfileRequest,
  ): Promise<RenamePersonalProfileResult>;
  updatePersonalMindDescription(
    request: UpdatePersonalMindDescriptionRequest,
  ): Promise<UpdatePersonalMindDescriptionResult>;
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

/**
 * Request-time reconciliation for invitations visible to one principal.
 * The server timestamp is authoritative; clients never choose the expiry clock.
 */
export interface ReconcileInvitationExpiriesRequest {
  readonly principalId: PrincipalId;
  readonly occurredAt: UtcInstant;
}

export interface ReconcileInvitationExpiriesResult {
  readonly expiredCount: number;
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
  readonly displayName?: string;
  readonly description?: string | null;
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
        | "description_required_for_write"
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
  readonly expectedSourceMembershipVersion: Version;
  readonly expectedTargetMembershipVersion: Version;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly occurredAt: UtcInstant;
  readonly requestId: ActorContext["requestId"];
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly capacityLimits: Readonly<CapacityLimits>;
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
        | "capacity_accounting_untrusted"
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
  readonly mindRoute: `/${string}`;
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
  reconcileInvitationExpiries(
    request: Readonly<ReconcileInvitationExpiriesRequest>,
  ): Promise<Readonly<ReconcileInvitationExpiriesResult>>;
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
  /**
   * Metadata-only HEAD projection. Adapters may provide it so discovery can
   * avoid a second per-Mind envelope read; canonical object bytes remain out
   * of the route projection.
   */
  readonly headRevision?: Readonly<SpaceRevision>;
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
  /** Optional page projection; callers must preserve input order. */
  readonly readCurrentAuthorizationStates?: BatchAuthorizationStateReader["readCurrentAuthorizationStates"];
  /** Optional post-authorization route snapshot projection; no ACL bypass. */
  readonly readResolvedSpaces?: (
    spaceIds: readonly SpaceId[],
  ) => Promise<readonly (Readonly<OrdinaryMindRouteSnapshot> | null)[]>;
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
