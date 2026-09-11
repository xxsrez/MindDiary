import type {
  AuditEventId,
  CredentialWriteTargetGenerationId,
  DeletedPrincipalId,
  ExternalBindingId,
  IdempotencyKey,
  IdempotencyRecordId,
  InvitationId,
  JobId,
  MembershipId,
  MindBindingOwnerId,
  OutboxMessageId,
  PrincipalMindUsageGenerationId,
  PrincipalId,
  RequestId,
  RevisionId,
  ReadMindBindingId,
  SecretVerifier,
  SensitiveExternalBinding,
  Sha256Digest,
  SpaceId,
  StagedBundleFileId,
  TokenId,
  UtcInstant,
  WriteMindBindingId,
} from "./ids.js";
import type { BundleFileMediaType } from "./revisions.js";

declare const versionBrand: unique symbol;
declare const bindingVersionBrand: unique symbol;
declare const revisionNumberBrand: unique symbol;
declare const mindUsageVersionBrand: unique symbol;
declare const exportDownloadSecretVerifierBrand: unique symbol;

export type Version = number & { readonly [versionBrand]: "version" };
export type BindingVersion = number & {
  readonly [bindingVersionBrand]: "binding-version";
};
export type RevisionNumber = number & {
  readonly [revisionNumberBrand]: "revision-number";
};
export type MindUsageVersion = number & {
  readonly [mindUsageVersionBrand]: "mind-usage-version";
};
export type ExportDownloadSecretVerifier = string & {
  readonly [exportDownloadSecretVerifierBrand]: "export-download-secret-verifier";
};

export const PRINCIPAL_STATES = ["active", "deleted"] as const;
export const EXTERNAL_BINDING_STATES = ["active", "revoked"] as const;
export const SPACE_LIFECYCLE_STATES = ["active", "deleting"] as const;
export const MEMBERSHIP_STATES = ["active", "revoked"] as const;
export const INVITATION_STATES = [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
  "expired",
] as const;
export const ACCESS_TOKEN_STATES = ["active", "revoked", "expired"] as const;
export const CREDENTIAL_WRITE_TARGET_CONTRACT_VERSION =
  "credential-write-target/v1" as const;
export const PRINCIPAL_MIND_USAGE_CONTRACT_VERSION =
  "principal-mind-usage/v3" as const;
export const MIND_USAGE_MODES = ["disabled", "read", "read_write"] as const;
export const CREDENTIAL_KINDS = ["oauth_grant", "personal_token"] as const;
export const CREDENTIAL_WRITE_TARGET_LIFECYCLE_STATES = [
  "active",
  "pending_upgrade",
  "revoked",
  "deleted",
] as const;
export const MIND_BINDING_SET_STATES = ["active", "revoked", "deleted"] as const;
export const MIND_BINDING_STATES = ["active", "invalidated"] as const;
export const AUTOMATIC_CAPTURE_MODES = ["disabled", "routine_non_sensitive"] as const;
export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "expired",
] as const;
export const IDEMPOTENCY_STATES = ["started", "completed", "failed"] as const;
export const OUTBOX_STATES = ["pending", "delivering", "delivered", "failed"] as const;
export const REVISION_INDEX_STATES = ["queued", "ready", "failed"] as const;
export const ROLES = ["reader", "editor", "admin", "owner"] as const;
export const VISIBILITIES = ["private", "unlisted", "public"] as const;
export const TOKEN_SCOPES = ["content:read", "content:write", "personal:configure"] as const;
export const CAPABILITIES = [
  "content:browse",
  "content:search",
  "content:fetch",
  "content:history",
  "content:validate",
  "content:export",
  "content:write",
  "members:manage-basic",
  "settings:configure",
  "members:manage-admin",
  "visibility:change",
  "ownership:transfer",
  "space:delete",
] as const;

export type PrincipalState = (typeof PRINCIPAL_STATES)[number];
export type ExternalBindingState = (typeof EXTERNAL_BINDING_STATES)[number];
export type SpaceLifecycleState = (typeof SPACE_LIFECYCLE_STATES)[number];
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];
export type InvitationState = (typeof INVITATION_STATES)[number];
export type AccessTokenState = (typeof ACCESS_TOKEN_STATES)[number];
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export type CredentialWriteTargetLifecycleState =
  (typeof CREDENTIAL_WRITE_TARGET_LIFECYCLE_STATES)[number];
export type MindBindingSetState = (typeof MIND_BINDING_SET_STATES)[number];
export type MindBindingState = (typeof MIND_BINDING_STATES)[number];
export type AutomaticCaptureMode = (typeof AUTOMATIC_CAPTURE_MODES)[number];
export type MindUsageMode = (typeof MIND_USAGE_MODES)[number];
export type JobState = (typeof JOB_STATES)[number];
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];
export type OutboxState = (typeof OUTBOX_STATES)[number];
export type RevisionIndexStatus = (typeof REVISION_INDEX_STATES)[number];
export type Role = (typeof ROLES)[number];
export type InvitationRole = Exclude<Role, "owner">;
export type Visibility = (typeof VISIBILITIES)[number];
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type EffectiveTokenScopes =
  | readonly ["content:read"]
  | readonly ["content:read", "content:write"]
  | readonly ["personal:configure"]
  | readonly ["content:read", "personal:configure"]
  | readonly ["content:read", "content:write", "personal:configure"];
export type Capability = (typeof CAPABILITIES)[number];
export type RevisionMode = "head" | "historical";

export interface Principal {
  readonly principalId: PrincipalId;
  readonly displayName: string;
  readonly state: PrincipalState;
  readonly profileVersion: Version;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface ExternalIdentityBinding {
  readonly bindingId: ExternalBindingId;
  readonly principalId: PrincipalId;
  readonly provider: string;
  readonly normalizedBinding: SensitiveExternalBinding;
  readonly state: ExternalBindingState;
  readonly version: Version;
  readonly verifiedAt: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** Personal status is represented by this service binding, not a space type. */
export interface PersonalSpaceBinding {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly version: Version;
  readonly createdAt: UtcInstant;
}

export interface KnowledgeSpace {
  readonly spaceId: SpaceId;
  readonly spaceHandle: string;
  readonly normalizedHandle: string;
  readonly name: string;
  /**
   * Routing category metadata shared by ordinary and Personal Minds. Legacy
   * records may omit the field and are reconstructed as null.
   */
  readonly description?: string | null;
  readonly visibility: Visibility;
  readonly state: SpaceLifecycleState;
  readonly metadataVersion: Version;
  readonly accessVersion: Version;
  readonly headRevisionId: RevisionId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface SpaceMembership {
  readonly membershipId: MembershipId;
  readonly spaceId: SpaceId;
  readonly principalId: PrincipalId;
  readonly role: Role;
  readonly state: MembershipState;
  readonly version: Version;
  readonly createdAt: UtcInstant;
  readonly createdBy: PrincipalId;
  readonly updatedAt: UtcInstant;
  readonly updatedBy: PrincipalId;
}

export interface SpaceInvitation {
  readonly invitationId: InvitationId;
  readonly spaceId: SpaceId;
  readonly targetPrincipalId: PrincipalId;
  readonly proposedRole: InvitationRole;
  readonly state: InvitationState;
  readonly expiresAt: UtcInstant;
  readonly version: Version;
  readonly createdAt: UtcInstant;
  readonly createdBy: PrincipalId;
  readonly updatedAt: UtcInstant;
  readonly updatedBy: PrincipalId;
}

export type RevisionAuthorReference =
  | { readonly kind: "principal"; readonly principalId: PrincipalId }
  | {
      readonly kind: "deleted-principal";
      readonly tombstoneId: DeletedPrincipalId;
    };

export interface SpaceRevision {
  readonly revisionId: RevisionId;
  readonly spaceId: SpaceId;
  readonly revisionNumber: RevisionNumber;
  readonly parentRevisionId: RevisionId | null;
  readonly committedAt: UtcInstant;
  readonly committedBy: RevisionAuthorReference;
  readonly manifestHash: Sha256Digest;
  /** Present for separately stored v3 manifests; absent on embedded legacy v1/v2. */
  readonly manifestSize?: number;
  readonly summary: string;
}

export interface AccessTokenMetadata {
  readonly tokenId: TokenId;
  readonly principalId: PrincipalId;
  readonly name: string;
  readonly secretVerifier: SecretVerifier;
  readonly displayPrefix: string;
  readonly scopes: EffectiveTokenScopes;
  readonly state: AccessTokenState;
  readonly version: Version;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly lastUsedAt: UtcInstant | null;
  readonly revokedAt: UtcInstant | null;
}

/**
 * The only durable write selection accepted by credential-write-target/v1.
 * Generation identifiers are opaque, owner-scoped and never reused.
 */
export interface WritableTargetGeneration {
  readonly generationId: CredentialWriteTargetGenerationId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly generation: number;
  readonly selectedAt: UtcInstant;
}

/**
 * Credential-owned write profile. Content reads deliberately have no binding
 * projection: they are derived from the current ACL and explicit target only.
 */
export interface CredentialWriteTargetState {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly credentialKind: CredentialKind;
  readonly contractVersion: typeof CREDENTIAL_WRITE_TARGET_CONTRACT_VERSION;
  readonly lifecycleState: CredentialWriteTargetLifecycleState;
  readonly targetVersion: BindingVersion;
  readonly activeGeneration: Readonly<WritableTargetGeneration> | null;
  readonly automaticCaptureMode: AutomaticCaptureMode;
  readonly captureGenerationId: CredentialWriteTargetGenerationId | null;
  readonly createdAt: UtcInstant;
  readonly upgradedAt: UtcInstant | null;
  readonly updatedAt: UtcInstant;
  readonly revokedAt: UtcInstant | null;
}

/** Principal-owned write generation; credential and legacy binding IDs are never authority. */
export interface PrincipalMindWriteGeneration {
  readonly generationId: PrincipalMindUsageGenerationId;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly generation: number;
  readonly selectedAt: UtcInstant;
}

export interface MindUsageEntry {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly routingProfile: "personal_default" | "description_based";
  readonly usageMode: Exclude<MindUsageMode, "disabled">;
  readonly entryVersion: Version;
  readonly writeGeneration: Readonly<PrincipalMindWriteGeneration> | null;
  readonly updatedAt: UtcInstant;
}

/** One authoritative usage snapshot shared by every credential of a principal. */
export interface PrincipalMindUsageState {
  readonly principalId: PrincipalId;
  readonly contractVersion: typeof PRINCIPAL_MIND_USAGE_CONTRACT_VERSION;
  readonly usageVersion: MindUsageVersion;
  readonly entries: readonly Readonly<MindUsageEntry>[];
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** @deprecated Compatibility-only record for pre credential-write-target/v1 replay. */
export interface MindBindingSet {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly state: MindBindingSetState;
  readonly bindingVersion: BindingVersion;
  readonly automaticCaptureMode: AutomaticCaptureMode;
  readonly captureWriteBindingId: WriteMindBindingId | null;
  readonly captureUpdatedAt: UtcInstant | null;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** @deprecated Compatibility-only record for pre credential-write-target/v1 replay. */
export interface ReadMindBinding {
  readonly readBindingId: ReadMindBindingId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly state: MindBindingState;
  readonly createdAt: UtcInstant;
  readonly invalidatedAt: UtcInstant | null;
}

/** @deprecated Compatibility-only record for pre credential-write-target/v1 replay. */
export interface WriteMindBinding {
  readonly writeBindingId: WriteMindBindingId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly generation: BindingVersion;
  readonly state: MindBindingState;
  readonly createdAt: UtcInstant;
  readonly invalidatedAt: UtcInstant | null;
}

export type BackgroundJobTarget =
  | {
      readonly kind: "revision_index" | "export";
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
    }
  | { readonly kind: "audit_delivery"; readonly outboxMessageId: OutboxMessageId }
  | { readonly kind: "continue_deletion"; readonly spaceId: SpaceId }
  | { readonly kind: "expire_invitation"; readonly invitationId: InvitationId };

export interface BackgroundJob {
  readonly jobId: JobId;
  readonly target: BackgroundJobTarget;
  readonly state: JobState;
  readonly version: Version;
  readonly attempts: number;
  readonly availableAt: UtcInstant;
  /** Running claim lease; expired work may be reclaimed with a new version. */
  readonly claimExpiresAt: UtcInstant | null;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/**
 * Durable asynchronous export state. The request stores only stable authority
 * inputs; token and role snapshots are deliberately absent so a worker must
 * re-read current authorization before using the exact revision.
 */
export interface ExportArchiveRecord {
  /** Internal object-store locator. Safe status projections must omit it. */
  readonly objectKey: string;
  readonly archiveFormat: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  readonly mediaType: "application/zip";
  readonly filename: "mind-diary-okf-bundle.zip" | "mind-diary-bundle.zip";
  readonly contentDisposition:
    | 'attachment; filename="mind-diary-okf-bundle.zip"'
    | 'attachment; filename="mind-diary-bundle.zip"';
  readonly sha256: Sha256Digest;
  readonly size: number;
}

export interface ExportJob {
  readonly jobId: JobId;
  readonly requestedByPrincipalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  /** Missing only on legacy persisted snapshots and normalizes to MD-OKF-ZIP-1. */
  readonly profile?: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  readonly idempotencyKey: IdempotencyKey;
  readonly state: JobState;
  readonly version: Version;
  readonly attempts: number;
  readonly availableAt: UtcInstant;
  readonly claimExpiresAt: UtcInstant | null;
  readonly expiresAt: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly completedAt: UtcInstant | null;
  /** Bounded machine code only; content and exception messages are forbidden. */
  readonly lastFailureCode: string | null;
  /** Metadata only. Archive bytes live exclusively in object storage. */
  readonly archive: Readonly<ExportArchiveRecord> | null;
  readonly archiveCleanedAt: UtcInstant | null;
}

export type ExportDownloadGrantState = "active" | "revoked" | "expired";

/**
 * Short-lived bearer locator for one already-built exact-revision archive.
 * Only the one-way verifier is durable; the URL and secret are response-only.
 * This record never replaces current access authorization.
 */
export interface ExportDownloadGrant {
  readonly secretVerifier: ExportDownloadSecretVerifier;
  readonly jobId: JobId;
  readonly requestedByPrincipalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  /** Internal object-store locator. It is never part of safe status. */
  readonly objectKey: string;
  readonly state: ExportDownloadGrantState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly revokedAt: UtcInstant | null;
}

export type BundleFileDownloadGrantState = "active" | "consumed" | "expired";

/**
 * One-use exact-revision BundleFile bearer. The secret is response-only; only
 * its verifier and the originating credential authority are durable.
 */
export interface BundleFileDownloadGrant {
  readonly secretVerifier: ExportDownloadSecretVerifier;
  readonly requestedByPrincipalId: PrincipalId;
  readonly tokenId: TokenId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly path: string;
  readonly mediaType: BundleFileMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly state: BundleFileDownloadGrantState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly consumedAt: UtcInstant | null;
}

/** Durable exact-revision state; it must never be inferred from current HEAD. */
export interface RevisionIndexState {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly status: RevisionIndexStatus;
  readonly attempts: number;
  readonly queuedAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly readyAt: UtcInstant | null;
  /** Bounded machine code only; private query/content never belongs here. */
  readonly lastFailureCode: string | null;
}

/** Closed terminal reasons for bounded exact-revision index recovery. */
export const REVISION_INDEX_TERMINAL_FAILURE_CODES = Object.freeze([
  "index_retry_attempt_limit",
  "index_retry_age_limit",
] as const);

export type RevisionIndexTerminalFailureCode =
  (typeof REVISION_INDEX_TERMINAL_FAILURE_CODES)[number];

export function isRevisionIndexTerminalFailureCode(
  value: unknown,
): value is RevisionIndexTerminalFailureCode {
  return typeof value === "string" &&
    (REVISION_INDEX_TERMINAL_FAILURE_CODES as readonly string[]).includes(value);
}

export interface CommitChangesetIdempotencyResult {
  readonly kind: "commit_changeset";
  readonly previousRevisionId: RevisionId | null;
  readonly revisionId: RevisionId;
}

export interface StageBundleFileIdempotencyResult {
  readonly kind: "stage_bundle_file";
  readonly stagedFileId: StagedBundleFileId;
}

export interface StartExportIdempotencyResult {
  readonly kind: "start_export";
  readonly jobId: JobId;
  readonly revisionId: RevisionId;
}

export type IdempotencyOperation =
  | CommitChangesetIdempotencyResult["kind"]
  | StageBundleFileIdempotencyResult["kind"]
  | StartExportIdempotencyResult["kind"];

export type IdempotencyResult =
  | CommitChangesetIdempotencyResult
  | StageBundleFileIdempotencyResult
  | StartExportIdempotencyResult;

interface IdempotencyRecordBase {
  readonly idempotencyRecordId: IdempotencyRecordId;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly operation: IdempotencyOperation;
  readonly key: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly version: Version;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export type IdempotencyRecord =
  | (IdempotencyRecordBase & {
      readonly state: "started" | "failed";
      readonly result: null;
    })
  | (IdempotencyRecordBase & {
      readonly operation: "commit_changeset";
      readonly state: "completed";
      readonly result: Readonly<CommitChangesetIdempotencyResult>;
    })
  | (IdempotencyRecordBase & {
      readonly operation: "stage_bundle_file";
      readonly state: "completed";
      readonly result: Readonly<StageBundleFileIdempotencyResult>;
    })
  | (IdempotencyRecordBase & {
      readonly operation: "start_export";
      readonly state: "completed";
      readonly result: Readonly<StartExportIdempotencyResult>;
    });

export type AuditActor =
  | { readonly kind: "principal"; readonly principalId: PrincipalId }
  | { readonly kind: "deleted-principal"; readonly opaqueId: DeletedPrincipalId }
  | { readonly kind: "service"; readonly serviceId: string };

export interface AuditEvent {
  readonly auditEventId: AuditEventId;
  readonly actor: AuditActor;
  readonly requestId: RequestId;
  readonly eventType: string;
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly spaceId: SpaceId | null;
  readonly occurredAt: UtcInstant;
  readonly safeMetadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditOutboxMessage {
  readonly outboxMessageId: OutboxMessageId;
  readonly auditEventId: AuditEventId;
  readonly state: OutboxState;
  readonly version: Version;
  readonly attempts: number;
  readonly availableAt: UtcInstant;
  /** Delivering claim lease; expired work may be reclaimed with a new version. */
  readonly claimExpiresAt: UtcInstant | null;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export function version(value: number): Version {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("versions must be positive safe integers");
  }
  return value as Version;
}

export function bindingVersion(value: number): BindingVersion {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("binding versions must be non-negative safe integers");
  }
  return value as BindingVersion;
}

export function mindUsageVersion(value: number): MindUsageVersion {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Mind usage versions must be non-negative safe integers");
  }
  return value as MindUsageVersion;
}

export function revisionNumber(value: number): RevisionNumber {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("revision numbers must be positive safe integers");
  }
  return value as RevisionNumber;
}
