import type {
  CredentialWriteTargetGenerationId,
  MindBindingOwnerId,
  PrincipalId,
  SpaceId,
  UtcInstant,
} from "./ids.js";
import {
  CREDENTIAL_WRITE_TARGET_CONTRACT_VERSION,
  bindingVersion,
  type AutomaticCaptureMode,
  type CredentialKind,
  type CredentialWriteTargetState,
  type Role,
  type WritableTargetGeneration,
} from "./records.js";

export interface CredentialWriteAuthority {
  readonly hasContentWriteScope: boolean;
  readonly currentRole: Role | null;
}

export interface LegacyCredentialWriteTargetEvidence {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly candidateSpaceId: SpaceId | null;
  readonly candidateGeneration: number | null;
  readonly unambiguous: boolean;
  readonly automaticCaptureWasEnabled: boolean;
  readonly observedAt: UtcInstant;
}

export type CredentialWriteTargetTransition =
  | {
      readonly kind: "applied";
      readonly state: Readonly<CredentialWriteTargetState>;
      readonly changed: boolean;
    }
  | {
      readonly kind:
        | "owner_mismatch"
        | "credential_inactive"
        | "target_version_conflict"
        | "write_scope_required"
        | "writer_access_required"
        | "generation_mismatch"
        | "upgrade_not_supported"
        | "legacy_evidence_mismatch";
    };

function writerRole(role: Role | null): boolean {
  return role === "editor" || role === "admin" || role === "owner";
}

function frozenGeneration(
  bindingOwnerId: MindBindingOwnerId,
  spaceId: SpaceId,
  generationId: CredentialWriteTargetGenerationId,
  generation: number,
  selectedAt: UtcInstant,
): Readonly<WritableTargetGeneration> {
  return Object.freeze({
    generationId,
    bindingOwnerId,
    spaceId,
    generation,
    selectedAt,
  });
}

function freezeState(
  state: CredentialWriteTargetState,
): Readonly<CredentialWriteTargetState> {
  return Object.freeze({
    ...state,
    activeGeneration:
      state.activeGeneration === null
        ? null
        : Object.freeze({ ...state.activeGeneration }),
  });
}

export function createFreshCredentialWriteTargetState(input: Readonly<{
  bindingOwnerId: MindBindingOwnerId;
  principalId: PrincipalId;
  credentialKind: CredentialKind;
  occurredAt: UtcInstant;
}>): Readonly<CredentialWriteTargetState> {
  return freezeState({
    bindingOwnerId: input.bindingOwnerId,
    principalId: input.principalId,
    credentialKind: input.credentialKind,
    contractVersion: CREDENTIAL_WRITE_TARGET_CONTRACT_VERSION,
    lifecycleState: "active",
    targetVersion: bindingVersion(0),
    activeGeneration: null,
    automaticCaptureMode: "disabled",
    captureGenerationId: null,
    createdAt: input.occurredAt,
    upgradedAt: null,
    updatedAt: input.occurredAt,
    revokedAt: null,
  });
}

export function selectCredentialWriteTarget(
  current: Readonly<CredentialWriteTargetState>,
  input: Readonly<{
    principalId: PrincipalId;
    spaceId: SpaceId;
    expectedTargetVersion: number;
    generationId: CredentialWriteTargetGenerationId;
    authority: CredentialWriteAuthority;
    occurredAt: UtcInstant;
  }>,
): CredentialWriteTargetTransition {
  if (current.principalId !== input.principalId) return { kind: "owner_mismatch" };
  if (current.lifecycleState !== "active") return { kind: "credential_inactive" };
  if (current.targetVersion !== input.expectedTargetVersion) {
    return { kind: "target_version_conflict" };
  }
  if (!input.authority.hasContentWriteScope) return { kind: "write_scope_required" };
  if (!writerRole(input.authority.currentRole)) return { kind: "writer_access_required" };
  if (current.activeGeneration?.spaceId === input.spaceId) {
    return { kind: "applied", state: freezeState(current), changed: false };
  }
  const targetVersion = bindingVersion(current.targetVersion + 1);
  return {
    kind: "applied",
    state: freezeState({
      ...current,
      targetVersion,
      activeGeneration: frozenGeneration(
        current.bindingOwnerId,
        input.spaceId,
        input.generationId,
        targetVersion,
        input.occurredAt,
      ),
      automaticCaptureMode: "disabled",
      captureGenerationId: null,
      updatedAt: input.occurredAt,
    }),
    changed: true,
  };
}

export function clearCredentialWriteTarget(
  current: Readonly<CredentialWriteTargetState>,
  input: Readonly<{
    principalId: PrincipalId;
    expectedTargetVersion: number;
    occurredAt: UtcInstant;
  }>,
): CredentialWriteTargetTransition {
  if (current.principalId !== input.principalId) return { kind: "owner_mismatch" };
  if (current.lifecycleState !== "active") return { kind: "credential_inactive" };
  if (current.targetVersion !== input.expectedTargetVersion) {
    return { kind: "target_version_conflict" };
  }
  if (current.activeGeneration === null && current.automaticCaptureMode === "disabled") {
    return { kind: "applied", state: freezeState(current), changed: false };
  }
  return {
    kind: "applied",
    state: freezeState({
      ...current,
      targetVersion: bindingVersion(current.targetVersion + 1),
      activeGeneration: null,
      automaticCaptureMode: "disabled",
      captureGenerationId: null,
      updatedAt: input.occurredAt,
    }),
    changed: true,
  };
}

export function configureCredentialAutomaticCapture(
  current: Readonly<CredentialWriteTargetState>,
  input: Readonly<{
    principalId: PrincipalId;
    expectedTargetVersion: number;
    expectedGenerationId: CredentialWriteTargetGenerationId | null;
    mode: AutomaticCaptureMode;
    authority: CredentialWriteAuthority;
    occurredAt: UtcInstant;
  }>,
): CredentialWriteTargetTransition {
  if (current.principalId !== input.principalId) return { kind: "owner_mismatch" };
  if (current.lifecycleState !== "active") return { kind: "credential_inactive" };
  if (current.targetVersion !== input.expectedTargetVersion) {
    return { kind: "target_version_conflict" };
  }
  if (input.mode !== "disabled") {
    if (!input.authority.hasContentWriteScope) return { kind: "write_scope_required" };
    if (!writerRole(input.authority.currentRole)) return { kind: "writer_access_required" };
    if (
      current.activeGeneration === null ||
      input.expectedGenerationId !== current.activeGeneration.generationId
    ) return { kind: "generation_mismatch" };
  }
  const captureGenerationId = input.mode === "disabled"
    ? null
    : current.activeGeneration!.generationId;
  if (
    current.automaticCaptureMode === input.mode &&
    current.captureGenerationId === captureGenerationId
  ) return { kind: "applied", state: freezeState(current), changed: false };
  return {
    kind: "applied",
    state: freezeState({
      ...current,
      automaticCaptureMode: input.mode,
      captureGenerationId,
      updatedAt: input.occurredAt,
    }),
    changed: true,
  };
}

export function revokeCredentialWriteTarget(
  current: Readonly<CredentialWriteTargetState>,
  principalId: PrincipalId,
  occurredAt: UtcInstant,
): CredentialWriteTargetTransition {
  if (current.principalId !== principalId) return { kind: "owner_mismatch" };
  if (current.lifecycleState === "revoked" || current.lifecycleState === "deleted") {
    return { kind: "applied", state: freezeState(current), changed: false };
  }
  return {
    kind: "applied",
    state: freezeState({
      ...current,
      lifecycleState: "revoked",
      targetVersion: bindingVersion(current.targetVersion + 1),
      activeGeneration: null,
      automaticCaptureMode: "disabled",
      captureGenerationId: null,
      updatedAt: occurredAt,
      revokedAt: occurredAt,
    }),
    changed: true,
  };
}

export function upgradeLegacyCredentialWriteTarget(input: Readonly<{
  evidence: LegacyCredentialWriteTargetEvidence;
  bindingOwnerId: MindBindingOwnerId;
  principalId: PrincipalId;
  credentialKind: CredentialKind;
  generationId: CredentialWriteTargetGenerationId;
  authority: CredentialWriteAuthority;
  occurredAt: UtcInstant;
}>): CredentialWriteTargetTransition {
  if (
    input.evidence.bindingOwnerId !== input.bindingOwnerId ||
    input.evidence.principalId !== input.principalId
  ) return { kind: "legacy_evidence_mismatch" };
  if (input.credentialKind !== "oauth_grant") return { kind: "upgrade_not_supported" };

  const fresh = createFreshCredentialWriteTargetState({
    bindingOwnerId: input.bindingOwnerId,
    principalId: input.principalId,
    credentialKind: input.credentialKind,
    occurredAt: input.occurredAt,
  });
  const canPreserve =
    input.evidence.unambiguous &&
    input.evidence.candidateSpaceId !== null &&
    input.authority.hasContentWriteScope &&
    writerRole(input.authority.currentRole);
  if (!canPreserve) {
    return {
      kind: "applied",
      state: freezeState({
        ...fresh,
        upgradedAt: input.occurredAt,
      }),
      changed: true,
    };
  }
  return {
    kind: "applied",
    state: freezeState({
      ...fresh,
      targetVersion: bindingVersion(1),
      activeGeneration: frozenGeneration(
        input.bindingOwnerId,
        input.evidence.candidateSpaceId!,
        input.generationId,
        1,
        input.occurredAt,
      ),
      // Legacy capture is never transferred implicitly, even if the target is.
      automaticCaptureMode: "disabled",
      captureGenerationId: null,
      upgradedAt: input.occurredAt,
      updatedAt: input.occurredAt,
    }),
    changed: true,
  };
}
