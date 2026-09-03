import {
  PRINCIPAL_MIND_USAGE_CONTRACT_VERSION,
  createFreshPrincipalMindUsageState,
  freezePrincipalMindUsageState,
  mindUsageVersion,
  setPrincipalMindUsageMode,
  version,
  type AuditEvent,
  type AuditEventId,
  type AuditOutboxMessage,
  type MindUsageEntry,
  type MindUsageMode,
  type OutboxMessageId,
  type PrincipalId,
  type PrincipalMindUsageGenerationId,
  type PrincipalMindUsageState,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/application-ports";
import type {
  SetPrincipalMindUsageModeRequest,
  SetPrincipalMindUsageModeResult,
} from "@mind-diary/application-ports";
import type {
  KnowledgeSpaceMap,
  MembershipMap,
  PersonalBindingMap,
} from "./control-internals.js";
import { BOUNDED_OPAQUE_ID, SHA256_PATTERN } from "./revision-internals.js";
import type { MutableCredentialWriteTargetOwnerState } from "./credential-write-target-internals.js";
import type { LegacyCredentialWriteTargetUpgradeSnapshot } from "@mind-diary/application-ports";

export type AppliedPrincipalMindUsageResult = Readonly<
  Extract<SetPrincipalMindUsageModeResult, { readonly kind: "applied" }>
>;

export interface StoredPrincipalMindUsageMutation {
  readonly canonicalRequestHash: SetPrincipalMindUsageModeRequest["canonicalRequestHash"];
  readonly result: AppliedPrincipalMindUsageResult;
}

export interface MutablePrincipalMindUsageOwnerState {
  state: Readonly<PrincipalMindUsageState>;
  retiredGenerationIds: Set<PrincipalMindUsageGenerationId>;
  idempotency: Map<string, Readonly<StoredPrincipalMindUsageMutation>>;
}

export function clonePrincipalMindUsageOwners(
  owners: ReadonlyMap<PrincipalId, MutablePrincipalMindUsageOwnerState>,
): Map<PrincipalId, MutablePrincipalMindUsageOwnerState> {
  return new Map(
    [...owners].map(([principalId, owner]) => [
      principalId,
      {
        state: freezePrincipalMindUsageState(owner.state),
        retiredGenerationIds: new Set(owner.retiredGenerationIds),
        idempotency: new Map(
          [...owner.idempotency].map(([key, record]) => [
            key,
            Object.freeze({
              canonicalRequestHash: record.canonicalRequestHash,
              result: Object.freeze({
                ...record.result,
                state: freezePrincipalMindUsageState(record.result.state),
              }),
            }),
          ]),
        ),
      },
    ]),
  );
}

function validInstant(value: unknown): value is UtcInstant {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validEntry(principalId: PrincipalId, value: unknown): value is MindUsageEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as MindUsageEntry;
  return entry.principalId === principalId &&
    typeof entry.spaceId === "string" && entry.spaceId.length > 0 &&
    (entry.usageMode === "read" || entry.usageMode === "read_write") &&
    Number.isSafeInteger(entry.entryVersion) && entry.entryVersion >= 1 &&
    validInstant(entry.updatedAt) &&
    (entry.usageMode === "read"
      ? entry.writeGeneration === null
      : entry.writeGeneration !== null &&
        entry.writeGeneration.principalId === principalId &&
        entry.writeGeneration.spaceId === entry.spaceId &&
        typeof entry.writeGeneration.generationId === "string" &&
        entry.writeGeneration.generationId.length > 0 &&
        Number.isSafeInteger(entry.writeGeneration.generation) &&
        entry.writeGeneration.generation >= 1 &&
        validInstant(entry.writeGeneration.selectedAt));
}

export function validPrincipalMindUsageOwnersSnapshot(
  owners: ReadonlyMap<PrincipalId, unknown>,
): boolean {
  const generationOwners = new Map<string, PrincipalId>();
  const generationSignatures = new Map<string, string>();
  const registerGeneration = (
    principalId: PrincipalId,
    generation: MindUsageEntry["writeGeneration"],
  ): boolean => {
    if (generation === null) return true;
    const previousOwner = generationOwners.get(generation.generationId);
    if (previousOwner !== undefined && previousOwner !== principalId) return false;
    const signature = JSON.stringify([
      generation.principalId,
      generation.spaceId,
      generation.generation,
      generation.selectedAt,
    ]);
    const previousSignature = generationSignatures.get(generation.generationId);
    if (previousSignature !== undefined && previousSignature !== signature) return false;
    generationOwners.set(generation.generationId, principalId);
    generationSignatures.set(generation.generationId, signature);
    return true;
  };
  for (const [principalId, raw] of owners) {
    if (typeof principalId !== "string" || principalId.length === 0 ||
      typeof raw !== "object" || raw === null) return false;
    const owner = raw as MutablePrincipalMindUsageOwnerState;
    const state = owner.state;
    if (
      typeof state !== "object" || state === null ||
      state.principalId !== principalId ||
      state.contractVersion !== PRINCIPAL_MIND_USAGE_CONTRACT_VERSION ||
      !Number.isSafeInteger(state.usageVersion) || state.usageVersion < 0 ||
      !Array.isArray(state.entries) ||
      !validInstant(state.createdAt) || !validInstant(state.updatedAt) ||
      !(owner.retiredGenerationIds instanceof Set) ||
      !(owner.idempotency instanceof Map)
    ) return false;
    const seenSpaces = new Set<string>();
    for (const entry of state.entries) {
      if (!validEntry(principalId, entry) || seenSpaces.has(entry.spaceId)) return false;
      seenSpaces.add(entry.spaceId);
      if (!registerGeneration(principalId, entry.writeGeneration)) return false;
    }
    try {
      freezePrincipalMindUsageState(state);
    } catch {
      return false;
    }
    for (const generationId of owner.retiredGenerationIds) {
      if (!BOUNDED_OPAQUE_ID.test(generationId) ||
        generationId === owner.state.activeWriteGeneration?.generationId) return false;
      const previousOwner = generationOwners.get(generationId);
      if (previousOwner !== undefined && previousOwner !== principalId) return false;
      generationOwners.set(generationId, principalId);
    }
    for (const [key, record] of owner.idempotency) {
      if (typeof key !== "string" || key.length === 0 ||
        key.length > 512 ||
        typeof record !== "object" || record === null ||
        !SHA256_PATTERN.test(record.canonicalRequestHash) ||
        record.result.kind !== "applied" ||
        typeof record.result.changed !== "boolean" ||
        typeof record.result.replayed !== "boolean" ||
        record.result.state.principalId !== principalId) return false;
      let replayState: Readonly<PrincipalMindUsageState>;
      try {
        replayState = freezePrincipalMindUsageState(record.result.state);
      } catch {
        return false;
      }
      if (!registerGeneration(principalId, replayState.activeWriteGeneration)) return false;
    }
  }
  return true;
}

export function replayPrincipalMindUsageMutation(
  owner: MutablePrincipalMindUsageOwnerState,
  request: Readonly<SetPrincipalMindUsageModeRequest>,
): SetPrincipalMindUsageModeResult | null {
  const previous = owner.idempotency.get(request.idempotencyKey);
  if (previous === undefined) return null;
  if (previous.canonicalRequestHash !== request.canonicalRequestHash) {
    return Object.freeze({ kind: "idempotency_conflict" });
  }
  return Object.freeze({
    ...previous.result,
    state: freezePrincipalMindUsageState(previous.result.state),
    replayed: true,
  });
}

export function recordPrincipalMindUsageMutation(
  owner: MutablePrincipalMindUsageOwnerState,
  request: Readonly<SetPrincipalMindUsageModeRequest>,
  result: AppliedPrincipalMindUsageResult,
): void {
  owner.idempotency.set(
    request.idempotencyKey,
    Object.freeze({
      canonicalRequestHash: request.canonicalRequestHash,
      result: Object.freeze({
        ...result,
        state: freezePrincipalMindUsageState(result.state),
      }),
    }),
  );
}

export function stagePrincipalMindUsageAudit(
  request: Readonly<SetPrincipalMindUsageModeRequest>,
  result: AppliedPrincipalMindUsageResult,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): void {
  const event = Object.freeze({
    auditEventId: request.auditEventId,
    actor: Object.freeze({ kind: "principal" as const, principalId: request.principalId }),
    requestId: request.requestId,
    eventType: "principal_mind_usage.mode_set",
    outcome: "succeeded" as const,
    spaceId: request.spaceId,
    occurredAt: request.occurredAt,
    safeMetadata: Object.freeze({
      usage_mode: request.usageMode,
      usage_version: result.state.usageVersion,
      changed: result.changed,
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
  auditEvents.set(event.auditEventId, event);
  auditOutbox.set(outbox.outboxMessageId, outbox);
}

function currentWriter(
  principalId: PrincipalId,
  spaceId: SpaceId,
  memberships: MembershipMap,
): boolean {
  return [...memberships.values()].some((membership) =>
    membership.principalId === principalId &&
    membership.spaceId === spaceId &&
    membership.state === "active" &&
    (membership.role === "editor" || membership.role === "admin" ||
      membership.role === "owner"));
}

/** Fail-closed v1/v2 snapshot migration. Legacy generation IDs are never reused. */
export function migrateLegacyCredentialTargetsToPrincipalUsage(
  credentialOwners: ReadonlyMap<string, MutableCredentialWriteTargetOwnerState>,
  legacyOwners: ReadonlyMap<string, Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>>,
  spaces: KnowledgeSpaceMap,
  memberships: MembershipMap,
  personalBindings: PersonalBindingMap,
): Map<PrincipalId, MutablePrincipalMindUsageOwnerState> {
  const candidates = new Map<PrincipalId, Set<SpaceId>>();
  const blockedPrincipals = new Set<PrincipalId>();
  for (const owner of credentialOwners.values()) {
    const generation = owner.state.lifecycleState === "active"
      ? owner.state.activeGeneration
      : null;
    if (generation === null) continue;
    const set = candidates.get(owner.state.principalId) ?? new Set<SpaceId>();
    set.add(generation.spaceId);
    candidates.set(owner.state.principalId, set);
  }
  for (const evidence of legacyOwners.values()) {
    if (!evidence.unambiguous || evidence.candidateSpaceId === null) {
      blockedPrincipals.add(evidence.principalId);
      continue;
    }
    const set = candidates.get(evidence.principalId) ?? new Set<SpaceId>();
    set.add(evidence.candidateSpaceId);
    candidates.set(evidence.principalId, set);
  }

  const migrated = new Map<PrincipalId, MutablePrincipalMindUsageOwnerState>();
  for (const [principalId, spaceIds] of candidates) {
    if (blockedPrincipals.has(principalId) || spaceIds.size !== 1) continue;
    const spaceId = [...spaceIds][0]!;
    const space = spaces.get(spaceId);
    const linkedPersonalBinding = [...personalBindings.values()].find(
      (binding) => binding.spaceId === spaceId,
    );
    const isOwnPersonal = linkedPersonalBinding?.principalId === principalId &&
      personalBindings.get(principalId)?.spaceId === spaceId;
    if (
      space?.state !== "active" ||
      (linkedPersonalBinding !== undefined && !isOwnPersonal) ||
      (!isOwnPersonal &&
        (typeof space.description !== "string" || space.description.length === 0)) ||
      !currentWriter(principalId, spaceId, memberships)
    ) continue;
    const occurredAt = space.updatedAt;
    const generationId =
      `pmu_migrated_v2:${principalId.length}:${principalId}:${spaceId.length}:${spaceId}` as
        PrincipalMindUsageGenerationId;
    const fresh = createFreshPrincipalMindUsageState({ principalId, occurredAt });
    const transition = setPrincipalMindUsageMode(fresh, {
      principalId,
      spaceId,
      usageMode: "read_write",
      expectedUsageVersion: 0,
      generationId,
      authority: {
        canRead: true,
        currentRole: "owner",
        description: space.description ?? null,
        routingProfile: isOwnPersonal ? "personal_default" : "description_based",
      },
      occurredAt,
    });
    if (transition.kind !== "applied") continue;
    migrated.set(principalId, {
      state: transition.state,
      retiredGenerationIds: new Set(),
      idempotency: new Map(),
    });
  }
  return migrated;
}

export function purgePrincipalMindUsageForSpace(
  owners: Map<PrincipalId, MutablePrincipalMindUsageOwnerState>,
  spaceId: SpaceId,
  occurredAt: UtcInstant,
): void {
  for (const owner of owners.values()) {
    const entry = owner.state.entries.find((candidate) => candidate.spaceId === spaceId);
    if (entry === undefined) continue;
    if (entry.writeGeneration !== null) {
      owner.retiredGenerationIds.add(entry.writeGeneration.generationId);
    }
    owner.state = freezePrincipalMindUsageState({
      ...owner.state,
      usageVersion: mindUsageVersion(owner.state.usageVersion + 1),
      entries: owner.state.entries.filter((candidate) => candidate.spaceId !== spaceId),
      activeWriteGeneration:
        owner.state.activeWriteGeneration?.spaceId === spaceId
          ? null
          : owner.state.activeWriteGeneration,
      updatedAt: occurredAt,
    });
  }
}

export function purgePrincipalMindUsageForPrincipal(
  owners: Map<PrincipalId, MutablePrincipalMindUsageOwnerState>,
  principalId: PrincipalId,
): void {
  owners.delete(principalId);
}

export function usageModeIsEnabled(mode: MindUsageMode): boolean {
  return mode === "read" || mode === "read_write";
}
