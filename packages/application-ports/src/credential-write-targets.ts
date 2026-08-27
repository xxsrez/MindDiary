import type { RequestId } from "@mind-diary/application-contracts";
import type {
  AuditEventId,
  CredentialKind,
  CredentialWriteTargetGenerationId,
  CredentialWriteTargetState,
  IdempotencyKey,
  MindBindingOwnerId,
  OutboxMessageId,
  PrincipalId,
  Sha256Digest,
  SpaceId,
  UtcInstant,
} from "@mind-diary/domain";

import type { AuthorizationStateReader } from "./authorization.js";
import type { MetadataStore } from "./runtime.js";

export interface LegacyCredentialWriteTargetUpgradeSnapshot {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly candidateSpaceId: SpaceId | null;
  readonly candidateGeneration: number | null;
  readonly unambiguous: boolean;
  readonly automaticCaptureWasEnabled: boolean;
  readonly observedAt: UtcInstant;
}

export type CredentialWriteTargetSnapshot =
  | {
      readonly kind: "current";
      readonly state: Readonly<CredentialWriteTargetState>;
    }
  | {
      readonly kind: "pending_upgrade";
      readonly legacy: Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>;
    };

interface CredentialWriteTargetMutationBase {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export interface RegisterCredentialWriteTargetOwnerRequest {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly credentialKind: CredentialKind;
  readonly occurredAt: UtcInstant;
}

export type RegisterCredentialWriteTargetOwnerResult =
  | {
      readonly kind: "registered";
      readonly state: Readonly<CredentialWriteTargetState>;
      readonly replayed: boolean;
    }
  | { readonly kind: "owner_conflict" | "invalid_record" };

export type SelectCredentialWriteTargetRequest =
  CredentialWriteTargetMutationBase & {
    readonly operation: "select";
    readonly spaceId: SpaceId;
    readonly expectedTargetVersion: number;
    readonly generationId: CredentialWriteTargetGenerationId;
    readonly credentialHasWriteScope: boolean;
  };

export type ClearCredentialWriteTargetRequest =
  CredentialWriteTargetMutationBase & {
    readonly operation: "clear";
    readonly expectedTargetVersion: number;
  };

export type ConfigureCredentialAutomaticCaptureRequest =
  CredentialWriteTargetMutationBase & {
    readonly operation: "configure_capture";
    readonly mode: "disabled" | "routine_non_sensitive";
    readonly expectedTargetVersion: number;
    readonly expectedGenerationId: CredentialWriteTargetGenerationId | null;
    readonly credentialHasWriteScope: boolean;
  };

export type UpgradeLegacyCredentialWriteTargetRequest =
  CredentialWriteTargetMutationBase & {
    readonly operation: "upgrade_legacy";
    readonly credentialKind: CredentialKind;
    readonly generationId: CredentialWriteTargetGenerationId;
    readonly credentialHasWriteScope: boolean;
  };

export type ApplyCredentialWriteTargetRequest =
  | SelectCredentialWriteTargetRequest
  | ClearCredentialWriteTargetRequest
  | ConfigureCredentialAutomaticCaptureRequest
  | UpgradeLegacyCredentialWriteTargetRequest;

export type ApplyCredentialWriteTargetResult =
  | {
      readonly kind: "applied";
      readonly state: Readonly<CredentialWriteTargetState>;
      readonly changed: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "not_found"
        | "pending_upgrade"
        | "owner_mismatch"
        | "credential_inactive"
        | "target_version_conflict"
        | "write_scope_required"
        | "writer_access_required"
        | "generation_mismatch"
        | "upgrade_not_supported"
        | "legacy_evidence_mismatch"
        | "idempotency_conflict"
        | "effect_conflict"
        | "invalid_record";
    };

export interface RevokeCredentialWriteTargetOwnerRequest {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export type RevokeCredentialWriteTargetOwnerResult =
  | { readonly kind: "revoked"; readonly changed: boolean; readonly replayed: boolean }
  | { readonly kind: "not_found" | "owner_mismatch" | "effect_conflict" | "invalid_record" };

export interface CredentialWriteTargetTransaction {
  readonly kind: "credential-write-target-transaction";
  readCredentialWriteTarget(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
  ): Promise<Readonly<CredentialWriteTargetSnapshot> | null>;
  registerCredentialWriteTargetOwner(
    request: Readonly<RegisterCredentialWriteTargetOwnerRequest>,
  ): Promise<RegisterCredentialWriteTargetOwnerResult>;
  applyCredentialWriteTarget(
    request: Readonly<ApplyCredentialWriteTargetRequest>,
  ): Promise<ApplyCredentialWriteTargetResult>;
}

export interface CredentialWriteTargetStore
  extends MetadataStore,
    AuthorizationStateReader {
  readCredentialWriteTarget(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
  ): Promise<Readonly<CredentialWriteTargetSnapshot> | null>;
  runCredentialWriteTargetTransaction<Result>(
    operation: (transaction: CredentialWriteTargetTransaction) => Promise<Result>,
  ): Promise<Result>;
  revokeCredentialWriteTargetOwner(
    request: Readonly<RevokeCredentialWriteTargetOwnerRequest>,
  ): Promise<RevokeCredentialWriteTargetOwnerResult>;
}
