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

export interface PrincipalMindUsageAuthority {
  readonly canRead: boolean;
  readonly currentRole: Role | null;
  readonly description: string | null;
  /** Trusted server-side classification; it is never accepted from a client. */
  readonly routingProfile: "personal_default" | "description_based";
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
  const seenSpaces = new Set<SpaceId>();
  const seenGenerations = new Set<PrincipalMindUsageGenerationId>();
  let personalEntries = 0;
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
        (entry.routingProfile !== "personal_default" &&
          entry.routingProfile !== "description_based") ||
        (entry.usageMode !== "read" && entry.usageMode !== "read_write")
      ) return false;
      seenSpaces.add(entry.spaceId);
      if (entry.routingProfile === "personal_default") personalEntries += 1;
      const generation = entry.writeGeneration;
      return entry.usageMode === "read"
        ? generation === null
        : generation !== null &&
          generation.principalId === state.principalId &&
          generation.spaceId === entry.spaceId &&
          generation.generationId.length > 0 &&
          Number.isSafeInteger(generation.generation) &&
          generation.generation >= 1 &&
          Number.isFinite(Date.parse(generation.selectedAt)) &&
          !seenGenerations.has(generation.generationId) &&
          Boolean(seenGenerations.add(generation.generationId));
    });
  if (!structurallyValid || personalEntries > 1) {
    throw new TypeError("Principal Mind usage write-lane invariant is invalid");
  }
  return Object.freeze({
    ...state,
    entries,
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
  }

  const existing = current.entries.find((entry) => entry.spaceId === input.spaceId);
  if (
    existing !== undefined &&
    existing.routingProfile !== input.authority.routingProfile
  ) {
    return { kind: "principal_mismatch" };
  }
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
    nextEntries.push(entry);
  }

  const selectedGeneration = input.usageMode === "read_write"
    ? Object.freeze({
        generationId: input.generationId,
        principalId: current.principalId,
        spaceId: input.spaceId,
        generation: nextUsageVersion,
        selectedAt: input.occurredAt,
      })
    : null;

  if (input.usageMode !== "disabled") {
    const nextEntry: MindUsageEntry = {
      principalId: current.principalId,
      spaceId: input.spaceId,
      routingProfile: input.authority.routingProfile,
      usageMode: input.usageMode,
      entryVersion: version((existing?.entryVersion ?? 0) + 1),
      writeGeneration:
        input.usageMode === "read_write" ? selectedGeneration : null,
      updatedAt: input.occurredAt,
    };
    nextEntries.push(nextEntry);
  }

  return {
    kind: "applied",
    state: freezePrincipalMindUsageState({
      ...current,
      usageVersion: nextUsageVersion,
      entries: nextEntries,
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
  const generation = principalMindUsageWriteGeneration(state, input.spaceId);
  return state.principalId === input.principalId &&
    generation !== null &&
    generation.principalId === input.principalId &&
    generation.spaceId === input.spaceId &&
    generation.generationId === input.generationId;
}

/** Resolves the exact current write generation for one principal+Mind entry. */
export function principalMindUsageWriteGeneration(
  state: Readonly<PrincipalMindUsageState> | null,
  spaceId: SpaceId,
): Readonly<PrincipalMindWriteGeneration> | null {
  const entry = state?.entries?.find((candidate) =>
    candidate.spaceId === spaceId && candidate.usageMode === "read_write"
  );
  return entry?.writeGeneration ?? null;
}
