import type {
  PrincipalMindUsageGenerationId,
  PrincipalId,
  SpaceId,
  UtcInstant,
} from "./ids.js";
import {
  PRINCIPAL_MIND_USAGE_CONTRACT_VERSION,
  mindUsageVersion,
  version,
  type MindUsageEntry,
  type MindUsageMode,
  type PrincipalMindUsageState,
  type PrincipalMindWriteGeneration,
  type Role,
} from "./records.js";
import { normalizeOrdinaryMindDescription } from "./aggregates.js";

export interface PrincipalMindUsageAuthority {
  readonly canRead: boolean;
  readonly currentRole: Role | null;
  readonly description: string | null;
}

export type PrincipalMindUsageTransition =
  | {
      readonly kind: "applied";
      readonly state: Readonly<PrincipalMindUsageState>;
      readonly changed: boolean;
    }
  | {
      readonly kind:
        | "principal_mismatch"
        | "usage_version_conflict"
        | "read_access_required"
        | "writer_access_required"
        | "description_required";
    };

function writerRole(role: Role | null): boolean {
  return role === "editor" || role === "admin" || role === "owner";
}

function freezeGeneration(
  generation: Readonly<PrincipalMindWriteGeneration>,
): Readonly<PrincipalMindWriteGeneration> {
  return Object.freeze({ ...generation });
}

function freezeEntry(entry: Readonly<MindUsageEntry>): Readonly<MindUsageEntry> {
  return Object.freeze({
    ...entry,
    writeGeneration:
      entry.writeGeneration === null
        ? null
        : freezeGeneration(entry.writeGeneration),
  });
}

export function freezePrincipalMindUsageState(
  state: Readonly<PrincipalMindUsageState>,
): Readonly<PrincipalMindUsageState> {
  const entries = Object.freeze(
    [...state.entries]
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId))
      .map(freezeEntry),
  );
  const writable = entries.filter((entry) => entry.usageMode === "read_write");
  const seenSpaces = new Set<SpaceId>();
  const structurallyValid =
    state.contractVersion === PRINCIPAL_MIND_USAGE_CONTRACT_VERSION &&
    Number.isSafeInteger(state.usageVersion) && state.usageVersion >= 0 &&
    Number.isFinite(Date.parse(state.createdAt)) &&
    Number.isFinite(Date.parse(state.updatedAt)) &&
    entries.every((entry) => {
      if (
        entry.principalId !== state.principalId ||
        seenSpaces.has(entry.spaceId) ||
        !Number.isSafeInteger(entry.entryVersion) ||
        entry.entryVersion < 1 ||
        !Number.isFinite(Date.parse(entry.updatedAt)) ||
        (entry.usageMode !== "read" && entry.usageMode !== "read_write")
      ) return false;
      seenSpaces.add(entry.spaceId);
      const generation = entry.writeGeneration;
      return entry.usageMode === "read"
        ? generation === null
        : generation !== null &&
          generation.principalId === state.principalId &&
          generation.spaceId === entry.spaceId &&
          generation.generationId.length > 0 &&
          Number.isSafeInteger(generation.generation) &&
          generation.generation >= 1 &&
          Number.isFinite(Date.parse(generation.selectedAt));
    });
  const writableGeneration = writable[0]?.writeGeneration ?? null;
  const active = state.activeWriteGeneration;
  if (
    !structurallyValid ||
    writable.length > 1 ||
    (writable.length === 0) !== (active === null) ||
    (writableGeneration !== null && active !== null &&
      (writableGeneration.generationId !== active.generationId ||
        writableGeneration.principalId !== active.principalId ||
        writableGeneration.spaceId !== active.spaceId ||
        writableGeneration.generation !== active.generation ||
        writableGeneration.selectedAt !== active.selectedAt))
  ) {
    throw new TypeError("Principal Mind usage singleton invariant is invalid");
  }
  return Object.freeze({
    ...state,
    entries,
    activeWriteGeneration:
      state.activeWriteGeneration === null
        ? null
        : freezeGeneration(state.activeWriteGeneration),
  });
}

export function createFreshPrincipalMindUsageState(input: Readonly<{
  principalId: PrincipalId;
  occurredAt: UtcInstant;
}>): Readonly<PrincipalMindUsageState> {
  return freezePrincipalMindUsageState({
    principalId: input.principalId,
    contractVersion: PRINCIPAL_MIND_USAGE_CONTRACT_VERSION,
    usageVersion: mindUsageVersion(0),
    entries: [],
    activeWriteGeneration: null,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  });
}

export function configuredMindUsageMode(
  state: Readonly<PrincipalMindUsageState>,
  spaceId: SpaceId,
): MindUsageMode {
  return state.entries.find((entry) => entry.spaceId === spaceId)?.usageMode ??
    "disabled";
}

export function setPrincipalMindUsageMode(
  current: Readonly<PrincipalMindUsageState>,
  input: Readonly<{
    principalId: PrincipalId;
    spaceId: SpaceId;
    usageMode: MindUsageMode;
    expectedUsageVersion: number;
    generationId: PrincipalMindUsageGenerationId;
    authority: PrincipalMindUsageAuthority;
    occurredAt: UtcInstant;
  }>,
): PrincipalMindUsageTransition {
  if (current.principalId !== input.principalId) {
    return { kind: "principal_mismatch" };
  }
  if (current.usageVersion !== input.expectedUsageVersion) {
    return { kind: "usage_version_conflict" };
  }
  if (!input.authority.canRead) return { kind: "read_access_required" };
  if (input.usageMode === "read_write") {
    if (!writerRole(input.authority.currentRole)) {
      return { kind: "writer_access_required" };
    }
    const normalized = input.authority.description === null
      ? Object.freeze({ kind: "valid" as const, value: null })
      : normalizeOrdinaryMindDescription(input.authority.description);
    if (normalized.kind !== "valid" || normalized.value === null) {
      return { kind: "description_required" };
    }
  }

  const existing = current.entries.find((entry) => entry.spaceId === input.spaceId);
  if ((existing?.usageMode ?? "disabled") === input.usageMode) {
    return {
      kind: "applied",
      state: freezePrincipalMindUsageState(current),
      changed: false,
    };
  }

  const nextUsageVersion = mindUsageVersion(current.usageVersion + 1);
  const nextEntries: MindUsageEntry[] = [];
  for (const entry of current.entries) {
    if (entry.spaceId === input.spaceId) continue;
    if (input.usageMode === "read_write" && entry.usageMode === "read_write") {
      nextEntries.push({
        ...entry,
        usageMode: "read",
        entryVersion: version(entry.entryVersion + 1),
        writeGeneration: null,
        updatedAt: input.occurredAt,
      });
    } else {
      nextEntries.push(entry);
    }
  }

  let activeWriteGeneration =
    input.usageMode === "read_write"
      ? Object.freeze({
          generationId: input.generationId,
          principalId: current.principalId,
          spaceId: input.spaceId,
          generation: nextUsageVersion,
          selectedAt: input.occurredAt,
        })
      : input.spaceId === current.activeWriteGeneration?.spaceId
        ? null
        : current.activeWriteGeneration;

  if (input.usageMode !== "disabled") {
    const nextEntry: MindUsageEntry = {
      principalId: current.principalId,
      spaceId: input.spaceId,
      usageMode: input.usageMode,
      entryVersion: version((existing?.entryVersion ?? 0) + 1),
      writeGeneration:
        input.usageMode === "read_write" ? activeWriteGeneration : null,
      updatedAt: input.occurredAt,
    };
    nextEntries.push(nextEntry);
  }

  if (input.usageMode !== "read_write" && activeWriteGeneration !== null) {
    const stillWritable = nextEntries.find(
      (entry) => entry.spaceId === activeWriteGeneration?.spaceId,
    );
    if (stillWritable?.usageMode !== "read_write") activeWriteGeneration = null;
  }

  return {
    kind: "applied",
    state: freezePrincipalMindUsageState({
      ...current,
      usageVersion: nextUsageVersion,
      entries: nextEntries,
      activeWriteGeneration,
      updatedAt: input.occurredAt,
    }),
    changed: true,
  };
}

export function principalMindUsageWritePinMatches(
  state: Readonly<PrincipalMindUsageState>,
  input: Readonly<{
    principalId: PrincipalId;
    spaceId: SpaceId;
    generationId: PrincipalMindUsageGenerationId;
  }>,
): boolean {
  const generation = state.activeWriteGeneration;
  return state.principalId === input.principalId &&
    generation !== null &&
    generation.principalId === input.principalId &&
    generation.spaceId === input.spaceId &&
    generation.generationId === input.generationId;
}
