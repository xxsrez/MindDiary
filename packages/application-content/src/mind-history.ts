import type { ActorContext } from "@mind-diary/application-contracts";
import {
  CapabilityAuthorizer,
  type AuthorizationDecision,
  type Authorizer,
  type CredentialContentAccessAuthorizer,
} from "@mind-diary/application-ports";
import {
  utcInstant,
  type CanonicalRevisionEnvelope,
  type RevisionId,
  type RevisionMode,
  type SpaceId,
  type UtcInstant,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";

import {
  MindDiscoveryFailure,
  MindDiscoveryService,
  type MindDiscoveryDescriptor,
  type MindDiscoveryFailureCode,
  type MindDiscoveryRevisionDescriptor,
  type MindDiscoveryStore,
  type MindInfoCapability,
  type MindRevisionSelector,
} from "./mind-discovery.js";

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;

type AllowedAuthorization = Extract<
  AuthorizationDecision,
  { readonly kind: "allowed" }
>;

export type MindHistoryFailureCode =
  | MindDiscoveryFailureCode
  | "invalid_request"
  | "invalid_limit"
  | "forbidden"
  | "read_conflict"
  | "revision_integrity_failure"
  | "mind_binding_required"
  | "binding_owner_revoked"
  | "binding_state_unavailable";

/** Safe history failure that never embeds canonical paths, bodies, or private metadata. */
export class MindHistoryFailure extends Error {
  readonly code: MindHistoryFailureCode;
  readonly retryable: boolean;

  constructor(code: MindHistoryFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "MindHistoryFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ResolveSnapshotViewQuery {
  readonly mind: unknown;
  readonly revisionSelector?: unknown;
}

export interface MindSnapshotViewResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevisionId: RevisionId;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly revisionMode: RevisionMode;
  readonly readOnly: boolean;
  readonly contentCapabilities: readonly MindInfoCapability[];
}

export interface RevisionManifestSummary {
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface MindHistoryEntry {
  readonly revision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly manifestSummary: Readonly<RevisionManifestSummary>;
}

export interface ListMindRevisionsQuery {
  readonly mind: unknown;
  readonly before?: unknown;
  readonly limit?: unknown;
}

export interface ListMindRevisionsResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly revisions: readonly Readonly<MindHistoryEntry>[];
  readonly nextBefore: RevisionId | null;
}

export interface GetMindRevisionQuery {
  readonly mind: unknown;
  readonly revisionId: unknown;
}

export interface GetMindRevisionResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly revision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly manifestSummary: Readonly<RevisionManifestSummary>;
  readonly revisionMode: "historical";
  readonly readOnly: true;
}

export interface MindHistoryDependencies {
  readonly store: MindDiscoveryStore;
  readonly host: VerifiedSpaceHost;
  readonly authorizer?: Authorizer;
  readonly credentialAccess?: CredentialContentAccessAuthorizer;
}

interface NormalizedListQuery {
  readonly mind: unknown;
  readonly before: RevisionId | null;
  readonly limit: number;
}

interface NormalizedGetQuery {
  readonly mind: unknown;
  readonly revisionId: RevisionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function opaqueRevisionId(value: unknown): RevisionId | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? (value as RevisionId)
    : null;
}

function parseRevisionSelector(value: unknown): Readonly<MindRevisionSelector> {
  if (value === undefined) return Object.freeze({ kind: "head" });
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new MindHistoryFailure(
      "invalid_revision_selector",
      "Revision selector is invalid.",
    );
  }
  if (value.kind === "head" && hasExactKeys(value, ["kind"])) {
    return Object.freeze({ kind: "head" });
  }
  if (value.kind === "revision" && hasExactKeys(value, ["kind", "revisionId"])) {
    const revisionId = opaqueRevisionId(value.revisionId);
    if (revisionId !== null) {
      return Object.freeze({ kind: "revision", revisionId });
    }
  }
  if (
    value.kind === "as_of" &&
    hasExactKeys(value, ["kind", "asOf"]) &&
    typeof value.asOf === "string"
  ) {
    try {
      return Object.freeze({ kind: "as_of", asOf: utcInstant(value.asOf) });
    } catch {
      // Mapped to the stable public selector error below.
    }
  }
  throw new MindHistoryFailure(
    "invalid_revision_selector",
    "Revision selector is invalid.",
  );
}

function normalizeSnapshotQuery(value: unknown): Readonly<ResolveSnapshotViewQuery> {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      Object.hasOwn(value, "revisionSelector")
        ? ["mind", "revisionSelector"]
        : ["mind"],
    )
  ) {
    throw new MindHistoryFailure("invalid_request", "Snapshot request is invalid.");
  }
  return Object.freeze({
    mind: value.mind,
    ...(Object.hasOwn(value, "revisionSelector")
      ? { revisionSelector: value.revisionSelector }
      : {}),
  });
}

function normalizeListQuery(value: unknown): Readonly<NormalizedListQuery> {
  if (!isRecord(value) || !("mind" in value)) {
    throw new MindHistoryFailure("invalid_request", "Revision list request is invalid.");
  }
  const allowed = new Set(["mind", "before", "limit"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    throw new MindHistoryFailure("invalid_request", "Revision list request is invalid.");
  }
  const limit = value.limit ?? DEFAULT_HISTORY_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_HISTORY_LIMIT
  ) {
    throw new MindHistoryFailure("invalid_limit", "Revision list limit is invalid.");
  }
  const before = value.before === undefined ? null : opaqueRevisionId(value.before);
  if (value.before !== undefined && before === null) {
    throw new MindHistoryFailure("invalid_request", "Revision boundary is invalid.");
  }
  return Object.freeze({ mind: value.mind, before, limit: limit as number });
}

function normalizeGetQuery(value: unknown): Readonly<NormalizedGetQuery> {
  if (!isRecord(value) || !hasExactKeys(value, ["mind", "revisionId"])) {
    throw new MindHistoryFailure("invalid_request", "Revision request is invalid.");
  }
  const revisionId = opaqueRevisionId(value.revisionId);
  if (revisionId === null) {
    throw new MindHistoryFailure("invalid_request", "Revision request is invalid.");
  }
  return Object.freeze({ mind: value.mind, revisionId });
}

function normalizedInstant(value: UtcInstant): string {
  const withoutZone = value.slice(0, -1);
  const separator = withoutZone.lastIndexOf(".");
  const seconds = separator === -1 ? withoutZone : withoutZone.slice(0, separator);
  const fraction = separator === -1 ? "" : withoutZone.slice(separator + 1);
  return `${seconds}.${fraction.padEnd(9, "0")}Z`;
}

function atOrBefore(committedAt: UtcInstant, requestedAt: UtcInstant): boolean {
  return normalizedInstant(committedAt) <= normalizedInstant(requestedAt);
}

function sameAuthorization(
  left: AllowedAuthorization,
  right: AllowedAuthorization,
): boolean {
  const sameGrant =
    left.grant.kind === "membership" && right.grant.kind === "membership"
      ? left.grant.role === right.grant.role
      : left.grant.kind === "baseline_visibility" &&
          right.grant.kind === "baseline_visibility"
        ? left.grant.visibility === right.grant.visibility
        : false;
  return (
    sameGrant &&
    left.stamp.accessVersion === right.stamp.accessVersion &&
    left.stamp.membershipVersion === right.stamp.membershipVersion &&
    left.stamp.tokenVersion === right.stamp.tokenVersion
  );
}

function revisionDescriptor(
  envelope: Readonly<CanonicalRevisionEnvelope>,
  headRevisionId: RevisionId,
): Readonly<MindDiscoveryRevisionDescriptor> {
  const revision = envelope.revision;
  const committedBy =
    revision.committedBy.kind === "principal"
      ? Object.freeze({
          kind: "principal" as const,
          id: revision.committedBy.principalId,
        })
      : Object.freeze({
          kind: "deleted-principal" as const,
          id: revision.committedBy.tombstoneId,
        });
  return Object.freeze({
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    parentRevisionId: revision.parentRevisionId,
    committedAt: revision.committedAt,
    committedBy,
    summary: revision.summary,
    manifestHash: revision.manifestHash,
    isHead: revision.revisionId === headRevisionId,
  });
}

function historyEntry(
  envelope: Readonly<CanonicalRevisionEnvelope>,
  spaceId: SpaceId,
  headRevisionId: RevisionId,
): Readonly<MindHistoryEntry> {
  if (
    envelope.revision.spaceId !== spaceId ||
    envelope.manifest.entries.some(
      (entry) => !Number.isSafeInteger(entry.size) || entry.size < 0,
    )
  ) {
    throw new MindHistoryFailure(
      "revision_integrity_failure",
      "Revision metadata failed integrity verification.",
    );
  }
  let totalBytes = 0;
  for (const entry of envelope.manifest.entries) {
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new MindHistoryFailure(
        "revision_integrity_failure",
        "Revision metadata failed integrity verification.",
      );
    }
  }
  return Object.freeze({
    revision: revisionDescriptor(envelope, headRevisionId),
    manifestSummary: Object.freeze({
      fileCount: envelope.manifest.entries.length,
      totalBytes,
    }),
  });
}

function snapshotResult(
  info: Readonly<{
    readonly mind: Readonly<MindDiscoveryDescriptor>;
    readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
    readonly revisionMode: RevisionMode;
    readonly contentCapabilities: readonly MindInfoCapability[];
  }>,
): Readonly<MindSnapshotViewResult> {
  return Object.freeze({
    mind: info.mind,
    resolvedRevisionId: info.resolvedRevision.revisionId,
    resolvedRevision: info.resolvedRevision,
    revisionMode: info.revisionMode,
    readOnly: info.revisionMode === "historical",
    contentCapabilities: info.contentCapabilities,
  });
}

function mapDiscoveryFailure(error: unknown): never {
  if (error instanceof MindDiscoveryFailure) {
    throw new MindHistoryFailure(error.code, error.message);
  }
  throw error;
}

/** Immutable history queries and one-time Snapshot View resolution. */
export class MindHistoryService {
  readonly #store: MindDiscoveryStore;
  readonly #discovery: MindDiscoveryService;
  readonly #authorizer: Authorizer;

  constructor(dependencies: MindHistoryDependencies) {
    this.#store = dependencies.store;
    this.#discovery = new MindDiscoveryService(dependencies);
    this.#authorizer =
      dependencies.authorizer ?? new CapabilityAuthorizer(dependencies.store);
  }

  async resolveSnapshotView(
    actor: ActorContext,
    queryValue: unknown,
  ): Promise<Readonly<MindSnapshotViewResult>> {
    const query = normalizeSnapshotQuery(queryValue);
    const selector = parseRevisionSelector(query.revisionSelector);
    if (selector.kind === "head") {
      try {
        return snapshotResult(
          await this.#discovery.getMindInfo(actor, query.mind, selector),
        );
      } catch (error) {
        mapDiscoveryFailure(error);
      }
    }

    let anchor;
    try {
      anchor = await this.#discovery.getMindInfo(actor, query.mind, { kind: "head" });
    } catch (error) {
      mapDiscoveryFailure(error);
    }
    const initialAuthorization = await this.#requireHistoryAuthorization(
      actor,
      anchor.mind.mindId,
      false,
    );

    let revisionId: RevisionId;
    if (selector.kind === "revision") {
      revisionId = selector.revisionId;
    } else {
      const revisions = await this.#store.listRevisions(anchor.mind.mindId);
      let selected: Readonly<CanonicalRevisionEnvelope> | null = null;
      for (const envelope of revisions) {
        if (
          envelope.revision.spaceId === anchor.mind.mindId &&
          atOrBefore(envelope.revision.committedAt, selector.asOf) &&
          (selected === null ||
            envelope.revision.revisionNumber > selected.revision.revisionNumber)
        ) {
          selected = envelope;
        }
      }
      if (selected === null) {
        await this.#requireSameHistoryAuthorization(
          actor,
          anchor.mind.mindId,
          initialAuthorization,
        );
        throw new MindHistoryFailure("revision_not_found", "Revision was not found.");
      }
      revisionId = selected.revision.revisionId;
    }

    let info;
    try {
      info = await this.#discovery.getMindInfo(actor, query.mind, {
        kind: "revision",
        revisionId,
      });
    } catch (error) {
      await this.#requireSameHistoryAuthorization(
        actor,
        anchor.mind.mindId,
        initialAuthorization,
      );
      mapDiscoveryFailure(error);
    }
    await this.#requireSameHistoryAuthorization(
      actor,
      anchor.mind.mindId,
      initialAuthorization,
    );
    return snapshotResult(info);
  }

  async listRevisions(
    actor: ActorContext,
    queryValue: unknown,
  ): Promise<Readonly<ListMindRevisionsResult>> {
    const query = normalizeListQuery(queryValue);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await this.resolveSnapshotView(actor, {
        mind: query.mind,
        revisionSelector: { kind: "head" },
      });
      const spaceId = snapshot.mind.mindId;
      const initialAuthorization = await this.#requireHistoryAuthorization(
        actor,
        spaceId,
        false,
      );
      const envelopes = await this.#store.listRevisions(spaceId);
      if ((await this.#store.readHead(spaceId)) !== snapshot.resolvedRevisionId) {
        await this.#requireSameHistoryAuthorization(
          actor,
          spaceId,
          initialAuthorization,
        );
        continue;
      }
      let entries: Readonly<MindHistoryEntry>[];
      try {
        entries = envelopes.map((envelope) =>
          historyEntry(envelope, spaceId, snapshot.resolvedRevisionId),
        );
        const revisionIds = new Set(
          entries.map((entry) => entry.revision.revisionId),
        );
        const revisionNumbers = new Set(
          entries.map((entry) => entry.revision.revisionNumber),
        );
        if (
          revisionIds.size !== entries.length ||
          revisionNumbers.size !== entries.length ||
          !revisionIds.has(snapshot.resolvedRevisionId)
        ) {
          throw new MindHistoryFailure(
            "revision_integrity_failure",
            "Revision metadata failed integrity verification.",
          );
        }
      } catch (error) {
        await this.#requireSameHistoryAuthorization(
          actor,
          spaceId,
          initialAuthorization,
        );
        throw error;
      }
      entries.sort(
        (left, right) =>
          right.revision.revisionNumber - left.revision.revisionNumber,
      );
      let candidates = entries;
      if (query.before !== null) {
        const boundary = entries.find(
          (entry) => entry.revision.revisionId === query.before,
        );
        if (boundary === undefined) {
          await this.#requireSameHistoryAuthorization(
            actor,
            spaceId,
            initialAuthorization,
          );
          throw new MindHistoryFailure("revision_not_found", "Revision was not found.");
        }
        candidates = entries.filter(
          (entry) =>
            entry.revision.revisionNumber < boundary.revision.revisionNumber,
        );
      }
      const page = candidates.slice(0, query.limit);
      const nextBefore =
        candidates.length > page.length
          ? (page.at(-1)?.revision.revisionId ?? null)
          : null;
      await this.#requireSameHistoryAuthorization(
        actor,
        spaceId,
        initialAuthorization,
      );
      return Object.freeze({
        mind: snapshot.mind,
        revisions: Object.freeze(page),
        nextBefore,
      });
    }
    throw new MindHistoryFailure(
      "read_conflict",
      "Mind HEAD changed during the history read; retry from a fresh descriptor.",
      true,
    );
  }

  async getRevision(
    actor: ActorContext,
    queryValue: unknown,
  ): Promise<Readonly<GetMindRevisionResult>> {
    const query = normalizeGetQuery(queryValue);
    const snapshot = await this.resolveSnapshotView(actor, {
      mind: query.mind,
      revisionSelector: { kind: "revision", revisionId: query.revisionId },
    });
    const initialAuthorization = await this.#requireHistoryAuthorization(
      actor,
      snapshot.mind.mindId,
      false,
    );
    const envelope = await this.#store.readRevision(
      snapshot.mind.mindId,
      snapshot.resolvedRevisionId,
    );
    if (
      envelope === null ||
      envelope.revision.spaceId !== snapshot.mind.mindId ||
      envelope.revision.revisionId !== snapshot.resolvedRevisionId ||
      envelope.revision.manifestHash !== snapshot.resolvedRevision.manifestHash
    ) {
      await this.#requireSameHistoryAuthorization(
        actor,
        snapshot.mind.mindId,
        initialAuthorization,
      );
      throw new MindHistoryFailure("revision_not_found", "Revision was not found.");
    }
    let entry: Readonly<MindHistoryEntry>;
    try {
      entry = historyEntry(
        envelope,
        snapshot.mind.mindId,
        snapshot.mind.head.revisionId,
      );
    } catch (error) {
      await this.#requireSameHistoryAuthorization(
        actor,
        snapshot.mind.mindId,
        initialAuthorization,
      );
      throw error;
    }
    await this.#requireSameHistoryAuthorization(
      actor,
      snapshot.mind.mindId,
      initialAuthorization,
    );
    return Object.freeze({
      mind: snapshot.mind,
      revision: entry.revision,
      manifestSummary: entry.manifestSummary,
      revisionMode: "historical",
      readOnly: true,
    });
  }

  async #requireHistoryAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    concealCapabilityDenial: boolean,
  ): Promise<AllowedAuthorization> {
    try {
      await this.#discovery.requireEnabledMindUsage(actor, spaceId);
    } catch (error) {
      if (error instanceof MindDiscoveryFailure) {
        throw new MindHistoryFailure("mind_not_found", "Mind was not found.");
      }
      throw error;
    }
    const decision = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability: "content:history",
      revisionMode: "historical",
    });
    if (decision.kind === "allowed") return decision;
    if (
      decision.code === "mind_binding_required" ||
      decision.code === "binding_owner_revoked" ||
      decision.code === "binding_state_unavailable"
    ) {
      throw new MindHistoryFailure(
        decision.code,
        "The current MCP credential cannot use this Mind binding.",
        decision.retryable,
      );
    }
    if (decision.code === "authorization_state_changed") {
      throw new MindHistoryFailure(
        "read_conflict",
        "Mind binding changed during the history read; retry from a fresh descriptor.",
        true,
      );
    }
    if (
      !concealCapabilityDenial &&
      (decision.code === "capability_denied" ||
        decision.code === "insufficient_scope" ||
        decision.code === "deployment_capability_disabled")
    ) {
      throw new MindHistoryFailure("forbidden", "History access is not allowed.");
    }
    throw new MindHistoryFailure("mind_not_found", "Mind was not found.");
  }

  async #requireSameHistoryAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    expected: AllowedAuthorization,
  ): Promise<void> {
    const current = await this.#requireHistoryAuthorization(actor, spaceId, true);
    if (!sameAuthorization(expected, current)) {
      throw new MindHistoryFailure(
        "read_conflict",
        "Mind access changed during the history read; retry from a fresh descriptor.",
        true,
      );
    }
  }
}
