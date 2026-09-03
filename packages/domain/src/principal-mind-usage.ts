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
  const ordinaryWritable = entries.filter((entry) =>
    entry.routingProfile === "description_based" && entry.usageMode === "read_write"
  );
  const personalWritable = entries.filter((entry) =>
    entry.routingProfile === "personal_default" && entry.usageMode === "read_write"
  );
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
        (entry.routingProfile !== "personal_default" &&
          entry.routingProfile !== "description_based") ||
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
  const ordinaryGeneration = ordinaryWritable[0]?.writeGeneration ?? null;
  const personalGeneration = personalWritable[0]?.writeGeneration ?? null;
  const ordinary = state.ordinaryWriteGeneration;
  const personal = state.personalWriteGeneration;
  if (
    !structurallyValid ||
    ordinaryWritable.length > 1 ||
    personalWritable.length > 1 ||
    (ordinaryWritable.length === 0) !== (ordinary === null) ||
    (personalWritable.length === 0) !== (personal === null) ||
    !sameGeneration(ordinaryGeneration, ordinary) ||
    !sameGeneration(personalGeneration, personal)
  ) {
    throw new TypeError("Principal Mind usage write-lane invariant is invalid");
  }
  return Object.freeze({
    ...state,
    entries,
    ordinaryWriteGeneration:
      state.ordinaryWriteGeneration === null
        ? null
        : freezeGeneration(state.ordinaryWriteGeneration),
    personalWriteGeneration:
      state.personalWriteGeneration === null
        ? null
        : freezeGeneration(state.personalWriteGeneration),
  });
}

function sameGeneration(
  entry: Readonly<PrincipalMindWriteGeneration> | null,
  lane: Readonly<PrincipalMindWriteGeneration> | null,
): boolean {
  return entry === null && lane === null ||
    entry !== null && lane !== null &&
      entry.generationId === lane.generationId &&
      entry.principalId === lane.principalId &&
      entry.spaceId === lane.spaceId &&
      entry.generation === lane.generation &&
      entry.selectedAt === lane.selectedAt;
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
    ordinaryWriteGeneration: null,
    personalWriteGeneration: null,
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
    if (input.authority.routingProfile === "description_based") {
      const normalized = input.authority.description === null
        ? Object.freeze({ kind: "valid" as const, value: null })
        : normalizeOrdinaryMindDescription(input.authority.description);
      if (normalized.kind !== "valid" || normalized.value === null) {
        return { kind: "description_required" };
      }
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
    if (
      input.usageMode === "read_write" &&
      input.authority.routingProfile === "description_based" &&
      entry.routingProfile === "description_based" &&
      entry.usageMode === "read_write"
    ) {
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

  const ordinaryWriteGeneration = nextEntries.find((entry) =>
    entry.routingProfile === "description_based" && entry.usageMode === "read_write"
  )?.writeGeneration ?? null;
  const personalWriteGeneration = nextEntries.find((entry) =>
    entry.routingProfile === "personal_default" && entry.usageMode === "read_write"
  )?.writeGeneration ?? null;

  return {
    kind: "applied",
    state: freezePrincipalMindUsageState({
      ...current,
      usageVersion: nextUsageVersion,
      entries: nextEntries,
      ordinaryWriteGeneration,
      personalWriteGeneration,
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

/** Resolves the exact current write generation in either independent lane. */
export function principalMindUsageWriteGeneration(
  state: Readonly<PrincipalMindUsageState> | null,
  spaceId: SpaceId,
): Readonly<PrincipalMindWriteGeneration> | null {
  const entry = state?.entries?.find((candidate) =>
    candidate.spaceId === spaceId && candidate.usageMode === "read_write"
  );
  if (entry?.writeGeneration !== undefined && entry.writeGeneration !== null) {
    return entry.writeGeneration;
  }
  const lane = state?.ordinaryWriteGeneration?.spaceId === spaceId
    ? state.ordinaryWriteGeneration
    : state?.personalWriteGeneration?.spaceId === spaceId
      ? state.personalWriteGeneration
      : null;
  return lane ?? null;
}
