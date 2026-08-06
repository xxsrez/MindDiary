import type {
  AuditEventId,
  DeletedPrincipalId,
  ExternalBindingId,
  IdempotencyKey,
  IdempotencyRecordId,
  InvitationId,
  JobId,
  MembershipId,
  OutboxMessageId,
  PrincipalId,
  RequestId,
  RevisionId,
  SecretVerifier,
  SensitiveExternalBinding,
  Sha256Digest,
  SpaceId,
  TokenId,
  UtcInstant,
} from "./ids.js";

declare const versionBrand: unique symbol;

export type Version = number & { readonly [versionBrand]: "version" };

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
export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "expired",
] as const;
export const IDEMPOTENCY_STATES = ["started", "completed", "failed"] as const;
export const OUTBOX_STATES = ["pending", "delivering", "delivered", "failed"] as const;
export const ROLES = ["reader", "editor", "admin", "owner"] as const;
export const VISIBILITIES = ["private", "unlisted", "public"] as const;
export const TOKEN_SCOPES = ["content:read", "content:write"] as const;
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
export type JobState = (typeof JOB_STATES)[number];
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];
export type OutboxState = (typeof OUTBOX_STATES)[number];
export type Role = (typeof ROLES)[number];
export type InvitationRole = Exclude<Role, "owner">;
export type Visibility = (typeof VISIBILITIES)[number];
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type EffectiveTokenScopes =
  | readonly ["content:read"]
  | readonly ["content:read", "content:write"];
export type Capability = (typeof CAPABILITIES)[number];

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
  readonly revisionNumber: number;
  readonly parentRevisionId: RevisionId | null;
  readonly committedAt: UtcInstant;
  readonly committedBy: RevisionAuthorReference;
  readonly manifestHash: Sha256Digest;
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
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface IdempotencyRecord {
  readonly idempotencyRecordId: IdempotencyRecordId;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId | null;
  readonly operation: string;
  readonly key: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly state: IdempotencyState;
  readonly resultReference: string | null;
  readonly version: Version;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

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
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export function version(value: number): Version {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("versions must be positive safe integers");
  }
  return value as Version;
}
