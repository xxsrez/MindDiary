import {
  createFreshCredentialWriteTargetState,
  type ApplyCredentialWriteTargetResult,
  type AuditEventId,
  type AuditEvent,
  type AuditOutboxMessage,
  type CredentialWriteTargetSnapshot,
  type CredentialWriteTargetState,
  type LegacyCredentialWriteTargetUpgradeSnapshot,
  type ApplyCredentialWriteTargetRequest,
  type MindBindingOwnerId,
  type MindBindingSetSnapshot,
  type OutboxMessageId,
  type PrincipalId,
  type RevokeCredentialWriteTargetOwnerRequest,
  type SpaceId,
  type UtcInstant,
  type WriteMindBindingId,
} from "@mind-diary/application-ports";
import { version } from "@mind-diary/application-ports";

import type { MutableMindBindingOwnerState } from "./binding-capacity-internals.js";
import {
  BOUNDED_OPAQUE_ID,
  SHA256_PATTERN,
  cloneAuditEvent,
  cloneAuditOutbox,
} from "./revision-internals.js";
import { copyOnWriteMap, isCopyOnWriteMap } from "./copy-on-write.js";

export type AppliedCredentialWriteTargetResult = Readonly<
  Extract<ApplyCredentialWriteTargetResult, { readonly kind: "applied" }>
>;

export interface StoredCredentialWriteTargetMutation {
  readonly canonicalRequestHash: ApplyCredentialWriteTargetRequest["canonicalRequestHash"];
  readonly result: AppliedCredentialWriteTargetResult;
}

export interface MutableCredentialWriteTargetOwnerState {
  state: Readonly<CredentialWriteTargetState>;
  retiredGenerationIds: Set<string>;
  idempotency: Map<string, StoredCredentialWriteTargetMutation>;
}

export function cloneCredentialWriteTargetState(
  state: Readonly<CredentialWriteTargetState>,
): Readonly<CredentialWriteTargetState> {
  return Object.freeze({
    ...state,
    activeGeneration:
      state.activeGeneration === null
        ? null
        : Object.freeze({ ...state.activeGeneration }),
  });
}

export function cloneCredentialWriteTargetOwnerState(
  owner: MutableCredentialWriteTargetOwnerState,
): MutableCredentialWriteTargetOwnerState {
  return {
    state: cloneCredentialWriteTargetState(owner.state),
    retiredGenerationIds: new Set(owner.retiredGenerationIds),
    idempotency: new Map(
      [...owner.idempotency].map(([key, record]) => [
        key,
        {
          canonicalRequestHash: record.canonicalRequestHash,
          result: Object.freeze({
            ...record.result,
            state: cloneCredentialWriteTargetState(record.result.state),
          }),
        },
      ]),
    ),
  };
}

export function cloneCredentialWriteTargetOwners(
  owners: ReadonlyMap<MindBindingOwnerId, MutableCredentialWriteTargetOwnerState>,
): Map<MindBindingOwnerId, MutableCredentialWriteTargetOwnerState> {
  if (isCopyOnWriteMap(owners)) {
    return copyOnWriteMap(owners, cloneCredentialWriteTargetOwnerState);
  }
  return new Map(
    [...owners].map(([ownerId, state]) => [
      ownerId,
      cloneCredentialWriteTargetOwnerState(state),
    ]),
  );
}

function validCredentialWriteTargetState(
  ownerId: MindBindingOwnerId,
  value: unknown,
): value is Readonly<CredentialWriteTargetState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as CredentialWriteTargetState;
  const generation = state.activeGeneration;
  const validGeneration = generation === null || (
    typeof generation === "object" &&
    generation !== null &&
    BOUNDED_OPAQUE_ID.test(generation.generationId) &&
    generation.bindingOwnerId === ownerId &&
    BOUNDED_OPAQUE_ID.test(generation.spaceId) &&
    Number.isSafeInteger(generation.generation) &&
    generation.generation >= 1 &&
    generation.generation <= state.targetVersion &&
    Number.isFinite(Date.parse(generation.selectedAt))
  );
  const captureValid = state.automaticCaptureMode === "disabled"
    ? state.captureGenerationId === null
    : state.automaticCaptureMode === "routine_non_sensitive" &&
      generation !== null &&
      state.captureGenerationId === generation.generationId;
  const lifecycleValid =
    state.lifecycleState === "active" ||
    state.lifecycleState === "pending_upgrade" ||
    state.lifecycleState === "revoked" ||
    state.lifecycleState === "deleted";
  const terminalValid = state.lifecycleState === "active"
    ? state.revokedAt === null
    : generation === null &&
      state.automaticCaptureMode === "disabled" &&
      state.captureGenerationId === null &&
      (state.lifecycleState === "pending_upgrade" ||
        Number.isFinite(Date.parse(state.revokedAt ?? "")));
  return (
    state.bindingOwnerId === ownerId &&
    BOUNDED_OPAQUE_ID.test(state.principalId) &&
    (state.credentialKind === "oauth_grant" || state.credentialKind === "personal_token") &&
    state.contractVersion === "credential-write-target/v1" &&
    lifecycleValid &&
    Number.isSafeInteger(state.targetVersion) &&
    state.targetVersion >= 0 &&
    validGeneration &&
    captureValid &&
    Number.isFinite(Date.parse(state.createdAt)) &&
    (state.upgradedAt === null || Number.isFinite(Date.parse(state.upgradedAt))) &&
    Number.isFinite(Date.parse(state.updatedAt)) &&
    terminalValid
  );
}

export function validCredentialWriteTargetOwnersSnapshot(
  owners: ReadonlyMap<MindBindingOwnerId, unknown>,
): boolean {
  const generations = new Map<string, MindBindingOwnerId>();
  for (const [ownerId, raw] of owners) {
    if (
      !BOUNDED_OPAQUE_ID.test(ownerId) ||
      typeof raw !== "object" ||
      raw === null ||
      !("state" in raw) ||
      !("idempotency" in raw) ||
      !("retiredGenerationIds" in raw) ||
      !validCredentialWriteTargetState(ownerId, raw.state) ||
      !(raw.idempotency instanceof Map) ||
      !(raw.retiredGenerationIds instanceof Set)
    ) return false;
    const owner = raw as MutableCredentialWriteTargetOwnerState;
    for (const generationId of owner.retiredGenerationIds) {
      if (
        !BOUNDED_OPAQUE_ID.test(generationId) ||
        generationId === owner.state.activeGeneration?.generationId
      ) return false;
      const priorOwner = generations.get(generationId);
      if (priorOwner !== undefined && priorOwner !== ownerId) return false;
      generations.set(generationId, ownerId);
    }
    const allStates = [
      owner.state,
      ...[...owner.idempotency.values()].map((record) => record.result?.state),
    ];
    for (const [key, record] of owner.idempotency) {
      if (
        typeof key !== "string" || key.length === 0 || key.length > 512 ||
        typeof record !== "object" || record === null ||
        !SHA256_PATTERN.test(record.canonicalRequestHash) ||
        record.result?.kind !== "applied" ||
        typeof record.result.changed !== "boolean" ||
        typeof record.result.replayed !== "boolean" ||
        !validCredentialWriteTargetState(ownerId, record.result.state)
      ) return false;
    }
    for (const state of allStates) {
      const generationId = state?.activeGeneration?.generationId;
      if (generationId === undefined) continue;
      const priorOwner = generations.get(generationId);
      if (priorOwner !== undefined && priorOwner !== ownerId) return false;
      generations.set(generationId, ownerId);
    }
  }
  return true;
}

export function validLegacyCredentialWriteTargetUpgradesSnapshot(
  owners: ReadonlyMap<MindBindingOwnerId, unknown>,
): boolean {
  for (const [ownerId, raw] of owners) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const evidence = raw as LegacyCredentialWriteTargetUpgradeSnapshot;
    if (
      !BOUNDED_OPAQUE_ID.test(ownerId) ||
      evidence.bindingOwnerId !== ownerId ||
      !BOUNDED_OPAQUE_ID.test(evidence.principalId) ||
      (evidence.candidateSpaceId !== null &&
        !BOUNDED_OPAQUE_ID.test(evidence.candidateSpaceId)) ||
      (evidence.candidateGeneration !== null &&
        (!Number.isSafeInteger(evidence.candidateGeneration) ||
          evidence.candidateGeneration < 0)) ||
      typeof evidence.unambiguous !== "boolean" ||
      typeof evidence.automaticCaptureWasEnabled !== "boolean" ||
      !Number.isFinite(Date.parse(evidence.observedAt)) ||
      (evidence.unambiguous !==
        (evidence.candidateSpaceId !== null && evidence.candidateGeneration !== null))
    ) return false;
  }
  return true;
}

export function cloneLegacyCredentialWriteTargetUpgrades(
  owners: ReadonlyMap<MindBindingOwnerId, Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>>,
): Map<MindBindingOwnerId, Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>> {
  if (isCopyOnWriteMap(owners)) {
    return copyOnWriteMap(owners, (evidence) => Object.freeze({ ...evidence }));
  }
  return new Map(
    [...owners].map(([ownerId, evidence]) => [
      ownerId,
      Object.freeze({ ...evidence }),
    ]),
  );
}

export function credentialWriteTargetSnapshot(
  current: MutableCredentialWriteTargetOwnerState | undefined,
  legacy: Readonly<LegacyCredentialWriteTargetUpgradeSnapshot> | undefined,
): Readonly<CredentialWriteTargetSnapshot> | null {
  if (current !== undefined) {
    return Object.freeze({
      kind: "current" as const,
      state: cloneCredentialWriteTargetState(current.state),
    });
  }
  return legacy === undefined
    ? null
    : Object.freeze({
        kind: "pending_upgrade" as const,
        legacy: Object.freeze({ ...legacy }),
      });
}

/**
 * Transitional projection for the pre-cutover content authorizer. The
 * credential target remains the sole authority; no legacy record is read or
 * persisted to construct this view.
 */
export function credentialWriteTargetLegacyProjection(
  state: Readonly<CredentialWriteTargetState>,
): Readonly<MindBindingSetSnapshot> {
  const active = state.lifecycleState === "active"
    ? state.activeGeneration
    : null;
  return Object.freeze({
    bindingSet: Object.freeze({
      bindingOwnerId: state.bindingOwnerId,
      principalId: state.principalId,
      state: state.lifecycleState === "active" ? "active" as const : "revoked" as const,
      bindingVersion: state.targetVersion,
      automaticCaptureMode: state.automaticCaptureMode,
      captureWriteBindingId:
        state.captureGenerationId as unknown as WriteMindBindingId | null,
      captureUpdatedAt:
        state.automaticCaptureMode === "disabled" ? null : state.updatedAt,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    }),
    readBindings: Object.freeze([]),
    writeBinding: active === null
      ? null
      : Object.freeze({
          writeBindingId: active.generationId as unknown as WriteMindBindingId,
          bindingOwnerId: state.bindingOwnerId,
          spaceId: active.spaceId,
          generation: state.targetVersion,
          state: "active" as const,
          createdAt: active.selectedAt,
          invalidatedAt: null,
        }),
  });
}

export function migrateLegacyMindBindingOwners(
  owners: ReadonlyMap<MindBindingOwnerId, MutableMindBindingOwnerState>,
): Map<MindBindingOwnerId, Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>> {
  const migrated = new Map<
    MindBindingOwnerId,
    Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>
  >();
  for (const [bindingOwnerId, owner] of owners) {
    const principalId = owner?.bindingSet?.principalId;
    const observedAt = owner?.bindingSet?.updatedAt ?? owner?.bindingSet?.createdAt;
    if (
      !BOUNDED_OPAQUE_ID.test(bindingOwnerId) ||
      !BOUNDED_OPAQUE_ID.test(principalId) ||
      !Number.isFinite(Date.parse(observedAt))
    ) {
      continue;
    }
    const activeWrites = [...owner.writeBindingsById.values()].filter(
      (binding) =>
        binding.state === "active" &&
        binding.bindingOwnerId === bindingOwnerId &&
        BOUNDED_OPAQUE_ID.test(binding.spaceId),
    );
    const selected = owner.activeWriteBindingId === null
      ? null
      : owner.writeBindingsById.get(owner.activeWriteBindingId) ?? null;
    const unambiguous =
      owner.bindingSet.state === "active" &&
      activeWrites.length === 1 &&
      selected !== null &&
      selected.state === "active" &&
      activeWrites[0]!.writeBindingId === selected.writeBindingId &&
      Number.isSafeInteger(selected.generation) &&
      selected.generation >= 0;
    migrated.set(bindingOwnerId, Object.freeze({
      bindingOwnerId,
      principalId,
      candidateSpaceId: unambiguous ? selected!.spaceId : null,
      candidateGeneration: unambiguous ? selected!.generation : null,
      unambiguous,
      automaticCaptureWasEnabled:
        owner.bindingSet.automaticCaptureMode !== "disabled",
      observedAt,
    }));
  }
  return migrated;
}

export function validCredentialWriteTargetMutation(
  request: Readonly<ApplyCredentialWriteTargetRequest>,
): boolean {
  return (
    BOUNDED_OPAQUE_ID.test(request.bindingOwnerId) &&
    BOUNDED_OPAQUE_ID.test(request.principalId) &&
    typeof request.idempotencyKey === "string" &&
    request.idempotencyKey.length > 0 &&
    request.idempotencyKey.length <= 512 &&
    SHA256_PATTERN.test(request.canonicalRequestHash) &&
    BOUNDED_OPAQUE_ID.test(request.requestId) &&
    BOUNDED_OPAQUE_ID.test(request.auditEventId) &&
    BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) &&
    Number.isFinite(Date.parse(request.occurredAt)) &&
    (request.operation === "upgrade_legacy" ||
      (Number.isSafeInteger(request.expectedTargetVersion) &&
        request.expectedTargetVersion >= 0))
  );
}

export function replayCredentialWriteTargetMutation(
  owner: MutableCredentialWriteTargetOwnerState,
  request: Readonly<ApplyCredentialWriteTargetRequest>,
): ApplyCredentialWriteTargetResult | null {
  const record = owner.idempotency.get(request.idempotencyKey);
  if (record === undefined) return null;
  if (record.canonicalRequestHash !== request.canonicalRequestHash) {
    return Object.freeze({ kind: "idempotency_conflict" });
  }
  return Object.freeze({
    ...record.result,
    state: cloneCredentialWriteTargetState(record.result.state),
    replayed: true,
  });
}

export function recordCredentialWriteTargetMutation(
  owner: MutableCredentialWriteTargetOwnerState,
  request: Readonly<ApplyCredentialWriteTargetRequest>,
  result: AppliedCredentialWriteTargetResult,
): void {
  owner.idempotency.set(request.idempotencyKey, {
    canonicalRequestHash: request.canonicalRequestHash,
    result: Object.freeze({
      ...result,
      state: cloneCredentialWriteTargetState(result.state),
    }),
  });
}

export function credentialWriteTargetEffectsAvailable(
  request: Readonly<{
    auditEventId: RevokeCredentialWriteTargetOwnerRequest["auditEventId"];
    auditOutboxMessageId: RevokeCredentialWriteTargetOwnerRequest["auditOutboxMessageId"];
  }>,
  auditEvents: ReadonlyMap<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: ReadonlyMap<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): boolean {
  return !auditEvents.has(request.auditEventId) &&
    !auditOutbox.has(request.auditOutboxMessageId) &&
    ![...auditOutbox.values()].some(
      (message) => message.auditEventId === request.auditEventId,
    );
}

export function stageCredentialWriteTargetAudit(
  request: Readonly<ApplyCredentialWriteTargetRequest>,
  result: AppliedCredentialWriteTargetResult,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): void {
  const spaceId = result.state.activeGeneration?.spaceId ?? null;
  const event = Object.freeze({
    auditEventId: request.auditEventId,
    actor: Object.freeze({ kind: "principal" as const, principalId: request.principalId }),
    requestId: request.requestId,
    eventType: `credential_write_target.${request.operation}`,
    outcome: "succeeded" as const,
    spaceId,
    occurredAt: request.occurredAt,
    safeMetadata: Object.freeze({
      target_version: result.state.targetVersion,
      changed: result.changed,
      operation: request.operation,
      capture_enabled: result.state.automaticCaptureMode !== "disabled",
    }),
  });
  const outbox = Object.freeze({
    outboxMessageId: request.auditOutboxMessageId,
    auditEventId: request.auditEventId,
    state: "pending" as const,
    version: version(1),
    attempts: 0,
    availableAt: request.occurredAt,
    claimExpiresAt: null,
    createdAt: request.occurredAt,
    updatedAt: request.occurredAt,
  });
  auditEvents.set(event.auditEventId, cloneAuditEvent(event));
  auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
}

export function stageCredentialWriteTargetRevokeAudit(
  request: Readonly<RevokeCredentialWriteTargetOwnerRequest>,
  changed: boolean,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): void {
  const event = Object.freeze({
    auditEventId: request.auditEventId,
    actor: Object.freeze({ kind: "principal" as const, principalId: request.principalId }),
    requestId: request.requestId,
    eventType: "credential_write_target.owner_revoked",
    outcome: "succeeded" as const,
    spaceId: null,
    occurredAt: request.occurredAt,
    safeMetadata: Object.freeze({ changed }),
  });
  const outbox = Object.freeze({
    outboxMessageId: request.auditOutboxMessageId,
    auditEventId: request.auditEventId,
    state: "pending" as const,
    version: version(1),
    attempts: 0,
    availableAt: request.occurredAt,
    claimExpiresAt: null,
    createdAt: request.occurredAt,
    updatedAt: request.occurredAt,
  });
  auditEvents.set(event.auditEventId, cloneAuditEvent(event));
  auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
}

export function purgeCredentialWriteTargetsForSpace(
  owners: Map<MindBindingOwnerId, MutableCredentialWriteTargetOwnerState>,
  legacy: Map<MindBindingOwnerId, Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>>,
  spaceId: SpaceId,
  occurredAt: UtcInstant,
): void {
  for (const owner of owners.values()) {
    if (owner.state.activeGeneration?.spaceId !== spaceId) continue;
    const retiredGenerationId = owner.state.activeGeneration.generationId;
    owner.state = Object.freeze({
      ...owner.state,
      targetVersion: (owner.state.targetVersion + 1) as typeof owner.state.targetVersion,
      activeGeneration: null,
      automaticCaptureMode: "disabled",
      captureGenerationId: null,
      updatedAt: occurredAt,
    });
    owner.retiredGenerationIds.add(retiredGenerationId);
    owner.idempotency.clear();
  }
  for (const [ownerId, evidence] of legacy) {
    if (evidence.candidateSpaceId !== spaceId) continue;
    legacy.set(ownerId, Object.freeze({
      ...evidence,
      candidateSpaceId: null,
      candidateGeneration: null,
      unambiguous: false,
      automaticCaptureWasEnabled: false,
      observedAt: occurredAt,
    }));
  }
}

export function purgeCredentialWriteTargetsForPrincipal(
  owners: Map<MindBindingOwnerId, MutableCredentialWriteTargetOwnerState>,
  legacy: Map<MindBindingOwnerId, Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>>,
  principalId: PrincipalId,
): void {
  for (const [ownerId, owner] of owners) {
    if (owner.state.principalId === principalId) owners.delete(ownerId);
  }
  for (const [ownerId, evidence] of legacy) {
    if (evidence.principalId === principalId) legacy.delete(ownerId);
  }
}

export function freshCredentialWriteTargetOwnerState(input: Readonly<{
  bindingOwnerId: MindBindingOwnerId;
  principalId: PrincipalId;
  credentialKind: "oauth_grant" | "personal_token";
  occurredAt: UtcInstant;
}>): MutableCredentialWriteTargetOwnerState {
  return {
    state: createFreshCredentialWriteTargetState(input),
    retiredGenerationIds: new Set(),
    idempotency: new Map(),
  };
}
