import type { ActorContext } from "@mind-diary/application-contracts";
import {
  AuthorizedHandleReader,
  type BackgroundWorkStore,
  CapabilityAuthorizer,
  type CredentialContentAccessAuthorizer,
  type AuthorizationDecision,
  type AuthorizationGrant,
  type AuthorizationStateQuery,
  type AuthorizationStamp,
  type CurrentAuthorizationState,
  type OrdinaryMindRouteSnapshot,
  type PersonalMindProfileSnapshot,
  type PrincipalMindUsageStore,
  type PublicMindCatalogStore,
  type RevisionMetadataStore,
} from "@mind-diary/application-ports";
import {
  capabilitiesForRole,
  capabilitiesForVisibilityGrant,
  freezePrincipalMindUsageState,
  isRevisionIndexTerminalFailureCode,
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
  principalMindUsageWriteGeneration,
  utcInstant,
  type CanonicalRevisionEnvelope,
  type Capability,
  type PrincipalId,
  type PrincipalMindUsageGenerationId,
  type PrincipalMindUsageState,
  type RevisionId,
  type RevisionMode,
  type Role,
  type SpaceRevision,
  type SpaceId,
  type UtcInstant,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const CATALOG_PAGE_LIMIT = 100;
const MAX_CATALOG_PAGES = 100;
const CURSOR_PREFIX = "mdm1";
const READ_CAPABILITY = "content:browse" as const;
const CONTENT_CAPABILITIES = Object.freeze([
  "content:browse",
  "content:search",
  "content:fetch",
  "content:history",
  "content:validate",
  "content:export",
  "content:write",
] as const satisfies readonly Capability[]);

export type MindInfoCapability =
  | "browse"
  | "search"
  | "fetch"
  | "history"
  | "validate"
  | "export"
  | "commit";

export type MindDiscoveryFailureCode =
  | "authentication_required"
  | "invalid_query"
  | "invalid_cursor"
  | "invalid_limit"
  | "invalid_mind_selector"
  | "invalid_revision_selector"
  | "mind_not_found"
  | "revision_not_found"
  | "credential_access_upgrade_required"
  | "binding_owner_revoked"
  | "binding_state_unavailable"
  | "discovery_unavailable";

/** Safe application failure that never carries private Mind metadata. */
export class MindDiscoveryFailure extends Error {
  readonly code: MindDiscoveryFailureCode;

  constructor(code: MindDiscoveryFailureCode, message: string) {
    super(message);
    this.name = "MindDiscoveryFailure";
    this.code = code;
  }
}

export interface MindDiscoveryRevisionDescriptor {
  readonly revisionId: RevisionId;
  readonly revisionNumber: number;
  readonly parentRevisionId: RevisionId | null;
  readonly committedAt: UtcInstant;
  readonly committedBy: Readonly<
    | { readonly kind: "principal"; readonly id: string }
    | { readonly kind: "deleted-principal"; readonly id: string }
  >;
  readonly summary: string;
  readonly manifestHash: string;
  readonly isHead: boolean;
}

export type MindDiscoveryAccess =
  | {
      readonly kind: "membership";
      readonly role: Role;
      readonly capabilities: readonly Capability[];
    }
  | {
      readonly kind: "visibility";
      readonly role: null;
      readonly capabilities: readonly Capability[];
    };

export interface MindDiscoveryDescriptor {
  readonly mindId: SpaceId;
  readonly route: string;
  readonly handle: string | null;
  readonly name: string;
  /** Authorized untrusted routing category. Personal Mind intentionally omits it. */
  readonly description?: string | null;
  /** Model-visible selection/write policy derived only from the server-owned Mind kind. */
  readonly routingProfile: "personal_default" | "description_based";
  readonly isPersonal: boolean;
  readonly visibility: "private" | "unlisted" | "public";
  readonly discovery:
    | "personal"
    | "membership"
    | "public_catalog"
    | "exact_handle";
  readonly access: Readonly<MindDiscoveryAccess>;
  readonly metadataVersion: number;
  /** Present on the principal-owned MCP projection; trusted internal readers may omit it. */
  readonly usageMode?: "read" | "read_write";
  readonly effective?: Readonly<{
    readonly canRead: true;
    readonly canWrite: boolean;
  }>;
  readonly settingsVersion?: number;
  readonly writableMount?: Readonly<{
    readonly active: boolean;
    /** Principal-owned mount generation. It is never a credential binding ID. */
    readonly generation: PrincipalMindUsageGenerationId | null;
  }>;
  readonly head: Readonly<MindDiscoveryRevisionDescriptor>;
}

export interface EnabledMindUsageProjection {
  readonly usageMode: "read" | "read_write";
  readonly settingsVersion: number;
  readonly writableMount: Readonly<{
    readonly active: boolean;
    readonly generation: PrincipalMindUsageGenerationId | null;
  }>;
}

export interface ListMindsQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListMindsResult {
  readonly minds: readonly Readonly<MindDiscoveryDescriptor>[];
  readonly nextCursor: string | null;
}

export type MindRevisionSelector =
  | { readonly kind: "head" }
  | { readonly kind: "revision"; readonly revisionId: RevisionId }
  | { readonly kind: "as_of"; readonly asOf: UtcInstant };

export interface MindInfoResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly revisionMode: RevisionMode;
  readonly contentCapabilities: readonly MindInfoCapability[];
  readonly indexStatus: Readonly<{
    readonly status: "missing" | "queued" | "ready" | "failed";
    readonly retryable: boolean;
    readonly retryAfterMs: number | null;
    readonly failureCode: string | null;
  }>;
}

export interface RevisionIndexStatusReader {
  read(request: {
    readonly spaceId: SpaceId;
    readonly revisionId: RevisionId;
    readonly currentHeadRevisionId: RevisionId | null;
  }): Promise<Readonly<{
    readonly status: "queued" | "ready" | "failed";
    readonly attempts: number;
    readonly lastFailureCode: string | null;
  }> | null>;
}

export interface MindDiscoveryStore
  extends PublicMindCatalogStore,
    RevisionMetadataStore,
    Pick<PrincipalMindUsageStore, "readPrincipalMindUsage">,
    Pick<BackgroundWorkStore, "readRevisionIndexState"> {
  /**
   * Optional adapter-level consistent view. Persistent adapters use this to
   * refresh one materialized snapshot/tail before resolving a whole list,
   * rather than issuing one storage refresh per candidate.
   */
  withConsistentRead?<Result>(
    operation: (store: MindDiscoveryStore) => Promise<Result>,
  ): Promise<Result>;
  /** Optional authorization page projection for bounded list reads. */
  readonly readCurrentAuthorizationStates?: (
    queries: readonly AuthorizationStateQuery[],
  ) => Promise<readonly (Readonly<CurrentAuthorizationState> | null)[]>;
  /** Optional post-authorization route snapshot page projection. */
  readonly readResolvedSpaces?: (
    spaceIds: readonly SpaceId[],
  ) => Promise<readonly (Readonly<OrdinaryMindRouteSnapshot> | null)[]>;
}

export interface MindDiscoveryDependencies {
  readonly store: MindDiscoveryStore;
  readonly host: VerifiedSpaceHost;
  readonly indexStatus?: RevisionIndexStatusReader;
  /** Binds index-status reads to the adapter's already refreshed read-session. */
  readonly indexStatusForStore?: (
    store: MindDiscoveryStore,
  ) => RevisionIndexStatusReader;
  /** MCP-only profile gate. Omit for trusted Sites and isolated fixtures. */
  readonly credentialAccess?: CredentialContentAccessAuthorizer;
  /** Internal propagation for a consistent MCP read-session after the outer credential gate. */
  readonly principalUsageRequired?: boolean;
}

interface NormalizedListQuery {
  readonly offset: number;
  readonly fingerprint: string | null;
  readonly limit: number;
}

interface EffectiveAccess {
  readonly grant: AuthorizationGrant;
  readonly stamp: AuthorizationStamp;
  readonly capabilities: readonly Capability[];
}

const MAX_DISCOVERY_CONCURRENCY = 8;

async function mapDiscoveryBounded<Input, Output>(
  values: readonly Input[],
  operation: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_DISCOVERY_CONCURRENCY, values.length) },
      async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= values.length) return;
          results[index] = await operation(values[index]!);
        }
      },
    ),
  );
  return Object.freeze(results);
}

function authorizationStateQuery(
  actor: ActorContext,
  spaceId: SpaceId,
): AuthorizationStateQuery {
  if (actor.kind !== "registered_principal") {
    throw new MindDiscoveryFailure(
      "authentication_required",
      "An authenticated principal is required.",
    );
  }
  return Object.freeze({
    principalId: actor.principalId,
    spaceId,
    tokenId: actor.authentication.kind === "mcp_token"
      ? actor.authentication.tokenId
      : null,
  });
}

function effectiveAccessFromDecisions(
  decisions: readonly AuthorizationDecision[],
): Readonly<EffectiveAccess> | null {
  const allowed: Capability[] = [];
  let anchor: Extract<AuthorizationDecision, { readonly kind: "allowed" }> | null = null;
  for (const [index, capability] of CONTENT_CAPABILITIES.entries()) {
    const decision = decisions[index];
    if (decision === undefined || decision.kind === "denied") continue;
    if (anchor !== null && !sameStamp(anchor.stamp, decision.stamp)) return null;
    anchor ??= decision;
    allowed.push(capability);
  }
  const finalRead = decisions[CONTENT_CAPABILITIES.indexOf(READ_CAPABILITY)];
  if (
    finalRead === undefined ||
    finalRead.kind === "denied" ||
    anchor === null ||
    !sameStamp(anchor.stamp, finalRead.stamp) ||
    !allowed.includes(READ_CAPABILITY)
  ) {
    return null;
  }
  const granted = contentCapabilitiesForGrant(finalRead.grant);
  return Object.freeze({
    grant: finalRead.grant,
    stamp: finalRead.stamp,
    capabilities: Object.freeze(
      allowed.filter((capability) => granted.includes(capability)),
    ),
  });
}

interface ResolvedMind {
  readonly descriptor: Readonly<MindDiscoveryDescriptor>;
  readonly expectedAccessVersion: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function principalId(actor: ActorContext): PrincipalId | null {
  if (
    actor?.kind !== "registered_principal" ||
    typeof actor.principalId !== "string" ||
    actor.principalId.length === 0 ||
    (actor.authentication.kind !== "sites_identity" &&
      actor.authentication.kind !== "mcp_token")
  ) {
    return null;
  }
  return actor.principalId;
}

function sameStamp(left: AuthorizationStamp, right: AuthorizationStamp): boolean {
  return (
    left.accessVersion === right.accessVersion &&
    left.membershipVersion === right.membershipVersion &&
    left.tokenVersion === right.tokenVersion
  );
}

function sameGrant(left: AuthorizationGrant, right: AuthorizationGrant): boolean {
  return left.kind === "membership" && right.kind === "membership"
    ? left.role === right.role
    : left.kind === "baseline_visibility" && right.kind === "baseline_visibility"
      ? left.visibility === right.visibility
      : false;
}

function sameEffectiveAccess(
  left: EffectiveAccess,
  right: EffectiveAccess,
): boolean {
  return (
    sameStamp(left.stamp, right.stamp) &&
    sameGrant(left.grant, right.grant) &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => capability === right.capabilities[index])
  );
}

function revisionDescriptor(
  envelope: Readonly<CanonicalRevisionEnvelope>,
  headRevisionId: RevisionId,
): Readonly<MindDiscoveryRevisionDescriptor> {
  return revisionDescriptorFromRevision(envelope.revision, headRevisionId);
}

function revisionDescriptorFromRevision(
  revision: Readonly<SpaceRevision>,
  headRevisionId: RevisionId,
): Readonly<MindDiscoveryRevisionDescriptor> {
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

function revisionDescriptorForHead(
  value: Readonly<CanonicalRevisionEnvelope> | Readonly<SpaceRevision>,
  headRevisionId: RevisionId,
): Readonly<MindDiscoveryRevisionDescriptor> {
  return "revision" in value
    ? revisionDescriptor(value, headRevisionId)
    : revisionDescriptorFromRevision(value, headRevisionId);
}

function accessDescriptor(access: EffectiveAccess): Readonly<MindDiscoveryAccess> {
  if (access.grant.kind === "membership") {
    return Object.freeze({
      kind: "membership",
      role: access.grant.role,
      capabilities: access.capabilities,
    });
  }
  return Object.freeze({
    kind: "visibility",
    role: null,
    capabilities: access.capabilities,
  });
}

function contentCapabilitiesForGrant(grant: AuthorizationGrant): readonly Capability[] {
  return Object.freeze(
    (grant.kind === "membership"
      ? capabilitiesForRole(grant.role)
      : capabilitiesForVisibilityGrant(grant.visibility)
    ).filter((capability) => capability.startsWith("content:")),
  );
}

function normalizeListQuery(value: unknown): Readonly<NormalizedListQuery> {
  if (value === undefined) {
    return Object.freeze({ offset: 0, fingerprint: null, limit: DEFAULT_PAGE_LIMIT });
  }
  if (!isRecord(value)) {
    throw new MindDiscoveryFailure("invalid_query", "Mind list query is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "cursor" && key !== "limit")) {
    throw new MindDiscoveryFailure("invalid_query", "Mind list query is invalid.");
  }
  const limit = value.limit === undefined ? DEFAULT_PAGE_LIMIT : value.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE_LIMIT) {
    throw new MindDiscoveryFailure("invalid_limit", "Mind list limit is invalid.");
  }
  if (value.cursor === undefined) {
    return Object.freeze({ offset: 0, fingerprint: null, limit: limit as number });
  }
  if (typeof value.cursor !== "string") {
    throw new MindDiscoveryFailure("invalid_cursor", "Mind list cursor is invalid.");
  }
  const match = /^mdm1_([1-9][0-9a-z]*)_([0-9a-f]{8})$/u.exec(value.cursor);
  if (!match) {
    throw new MindDiscoveryFailure("invalid_cursor", "Mind list cursor is invalid.");
  }
  const offset = Number.parseInt(match[1]!, 36);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    offset.toString(36) !== match[1]
  ) {
    throw new MindDiscoveryFailure("invalid_cursor", "Mind list cursor is invalid.");
  }
  return Object.freeze({ offset, fingerprint: match[2]!, limit: limit as number });
}

function listFingerprint(minds: readonly Readonly<MindDiscoveryDescriptor>[]): string {
  let hash = 0x811c9dc5;
  const input = minds
    .map((mind) => [
      mind.mindId,
      mind.route,
      mind.head.revisionId,
      mind.discovery,
      mind.usageMode ?? "internal",
      String(mind.settingsVersion ?? "internal"),
      mind.writableMount?.generation ?? "none",
    ].join("\u001f"))
    .join("\u001e");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function enabledUsageProjection(
  state: Readonly<PrincipalMindUsageState>,
  spaceId: SpaceId,
): Readonly<EnabledMindUsageProjection> | null {
  const entry = state.entries.find((candidate) => candidate.spaceId === spaceId);
  if (entry === undefined) return null;
  if (entry.principalId !== state.principalId) {
    throw new MindDiscoveryFailure(
      "discovery_unavailable",
      "Mind usage state is unavailable.",
    );
  }
  if (entry.usageMode === "read") {
    if (entry.writeGeneration !== null) {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Mind usage state is unavailable.",
      );
    }
    return Object.freeze({
      usageMode: "read" as const,
      settingsVersion: state.usageVersion,
      writableMount: Object.freeze({ active: false, generation: null }),
    });
  }
  const generation = entry.writeGeneration;
  const active = principalMindUsageWriteGeneration(state, spaceId);
  if (
    entry.usageMode !== "read_write" ||
    generation === null ||
    active === null ||
    generation.principalId !== state.principalId ||
    generation.spaceId !== spaceId ||
    active.principalId !== state.principalId ||
    active.spaceId !== spaceId ||
    active.generationId !== generation.generationId
  ) {
    throw new MindDiscoveryFailure(
      "discovery_unavailable",
      "Mind usage state is unavailable.",
    );
  }
  return Object.freeze({
    usageMode: "read_write" as const,
    settingsVersion: state.usageVersion,
    writableMount: Object.freeze({
      active: true,
      generation: generation.generationId,
    }),
  });
}

function encodeCursor(offset: number, fingerprint: string): string {
  return `${CURSOR_PREFIX}_${offset.toString(36)}_${fingerprint}`;
}

function parseRevisionSelector(value: unknown): Readonly<MindRevisionSelector> {
  if (value === undefined) return Object.freeze({ kind: "head" });
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new MindDiscoveryFailure(
      "invalid_revision_selector",
      "Revision selector is invalid.",
    );
  }
  const keys = Object.keys(value).sort();
  if (value.kind === "head" && keys.length === 1 && keys[0] === "kind") {
    return Object.freeze({ kind: "head" });
  }
  if (
    value.kind === "revision" &&
    keys.length === 2 &&
    keys[0] === "kind" &&
    keys[1] === "revisionId" &&
    typeof value.revisionId === "string" &&
    value.revisionId.length > 0 &&
    value.revisionId.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value.revisionId)
  ) {
    return Object.freeze({
      kind: "revision",
      revisionId: value.revisionId as RevisionId,
    });
  }
  if (
    value.kind === "as_of" &&
    keys.length === 2 &&
    keys[0] === "asOf" &&
    keys[1] === "kind" &&
    typeof value.asOf === "string"
  ) {
    try {
      return Object.freeze({ kind: "as_of", asOf: utcInstant(value.asOf) });
    } catch {
      // Mapped to the public selector error below.
    }
  }
  throw new MindDiscoveryFailure(
    "invalid_revision_selector",
    "Revision selector is invalid.",
  );
}

function infoCapabilities(capabilities: readonly Capability[]): readonly MindInfoCapability[] {
  const allowed = new Set(capabilities);
  const result: MindInfoCapability[] = [];
  if (allowed.has("content:browse")) result.push("browse");
  if (allowed.has("content:search")) result.push("search");
  if (allowed.has("content:fetch")) result.push("fetch");
  if (allowed.has("content:history")) result.push("history");
  if (allowed.has("content:validate")) result.push("validate");
  if (allowed.has("content:export")) result.push("export");
  if (allowed.has("content:write")) result.push("commit");
  return Object.freeze(result);
}

/** MCP-neutral discovery and exact revision selection for one authenticated principal. */
export class MindDiscoveryService {
  readonly #store: MindDiscoveryStore;
  readonly #host: VerifiedSpaceHost;
  readonly #indexStatus: RevisionIndexStatusReader | undefined;
  readonly #indexStatusForStore:
    | ((store: MindDiscoveryStore) => RevisionIndexStatusReader)
    | undefined;
  readonly #authorizer: CapabilityAuthorizer;
  readonly #credentialAccess: CredentialContentAccessAuthorizer | undefined;
  readonly #principalUsageRequired: boolean;
  readonly #handles: AuthorizedHandleReader<Readonly<OrdinaryMindRouteSnapshot>>;

  constructor(dependencies: MindDiscoveryDependencies) {
    this.#store = dependencies.store;
    this.#host = dependencies.host;
    this.#indexStatus = dependencies.indexStatus;
    this.#indexStatusForStore = dependencies.indexStatusForStore;
    this.#credentialAccess = dependencies.credentialAccess;
    this.#principalUsageRequired =
      dependencies.principalUsageRequired === true ||
      dependencies.credentialAccess !== undefined;
    this.#authorizer = new CapabilityAuthorizer(dependencies.store);
    this.#handles = new AuthorizedHandleReader({
      handles: dependencies.store,
      authorizer: this.#authorizer,
      targets: dependencies.store,
    });
  }

  async listMinds(actor: ActorContext, query?: unknown): Promise<Readonly<ListMindsResult>> {
    await this.#requireCredentialAccess(actor);
    if (this.#store.withConsistentRead !== undefined) {
      return this.#store.withConsistentRead((store) =>
        new MindDiscoveryService({
          store,
          host: this.#host,
          principalUsageRequired: this.#principalUsageRequired,
        }).listMinds(actor, query));
    }
    const actorPrincipalId = this.#requireActor(actor);
    const normalized = normalizeListQuery(query);
    if (this.#principalUsageRequired) {
      return this.#listEnabledMinds(actor, actorPrincipalId, normalized);
    }
    const byId = new Map<SpaceId, Readonly<MindDiscoveryDescriptor>>();

    const personal = await this.#personal(actor, actorPrincipalId);
    byId.set(personal.descriptor.mindId, personal.descriptor);

    const membershipIds = [...new Set(
      await this.#store.listActiveMembershipMindIds(actorPrincipalId),
    )].sort();

    let catalogCursor: string | null = null;
    const seenCursors = new Set<string>();
    const catalogIds = new Set<SpaceId>();
    let completed = false;
    for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES; pageNumber += 1) {
      const page = await this.#store.listPublicMindCatalogPage({
        cursor: catalogCursor,
        limit: CATALOG_PAGE_LIMIT,
      });
      if (page.kind !== "page") {
        throw new MindDiscoveryFailure(
          "discovery_unavailable",
          "Public Mind discovery is unavailable.",
        );
      }
      for (const spaceId of page.spaceIds) {
        if (!membershipIds.includes(spaceId)) catalogIds.add(spaceId);
      }
      if (page.nextCursor === null) {
        completed = true;
        break;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new MindDiscoveryFailure(
          "discovery_unavailable",
          "Public Mind discovery is unavailable.",
        );
      }
      seenCursors.add(page.nextCursor);
      catalogCursor = page.nextCursor;
    }
    if (!completed) {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Public Mind discovery is unavailable.",
      );
    }
    const candidates = [
      ...membershipIds.map((spaceId) => Object.freeze({
        spaceId,
        discovery: "membership" as const,
        requireMembership: true,
        requirePublic: false,
      })),
      ...[...catalogIds].sort().map((spaceId) => Object.freeze({
        spaceId,
        discovery: "public_catalog" as const,
        requireMembership: false,
        requirePublic: true,
      })),
    ];
    const resolvedCandidates = await this.#resolveCandidates(actor, candidates);
    for (const [index, resolved] of resolvedCandidates.entries()) {
      if (resolved !== null) byId.set(candidates[index]!.spaceId, resolved.descriptor);
    }

    const minds = [...byId.values()].sort((left, right) => {
      if (left.isPersonal !== right.isPersonal) return left.isPersonal ? -1 : 1;
      const routeOrder = left.route.localeCompare(right.route, "en");
      return routeOrder === 0
        ? left.mindId.localeCompare(right.mindId, "en")
        : routeOrder;
    });
    const fingerprint = listFingerprint(minds);
    if (
      normalized.fingerprint !== null &&
      (normalized.fingerprint !== fingerprint || normalized.offset >= minds.length)
    ) {
      throw new MindDiscoveryFailure("invalid_cursor", "Mind list cursor is invalid.");
    }
    const page = minds.slice(normalized.offset, normalized.offset + normalized.limit);
    const nextOffset = normalized.offset + page.length;
    return Object.freeze({
      minds: Object.freeze(page),
      nextCursor:
        nextOffset < minds.length ? encodeCursor(nextOffset, fingerprint) : null,
    });
  }

  async #listEnabledMinds(
    actor: ActorContext,
    actorPrincipalId: PrincipalId,
    normalized: Readonly<NormalizedListQuery>,
  ): Promise<Readonly<ListMindsResult>> {
    const usageState = await this.#readPrincipalUsageState(actorPrincipalId);
    if (usageState === null) {
      if (normalized.fingerprint !== null) {
        throw new MindDiscoveryFailure("invalid_cursor", "Mind list cursor is invalid.");
      }
      return Object.freeze({ minds: Object.freeze([]), nextCursor: null });
    }

    const personal = await this.#store.readPersonalMindProfile(actorPrincipalId);
    const resolved = await mapDiscoveryBounded(usageState.entries, async (entry) => {
      const usage = enabledUsageProjection(usageState, entry.spaceId);
      if (usage === null) return null;
      let mind: Readonly<ResolvedMind> | null;
      if (personal?.personalMind.spaceId === entry.spaceId) {
        try {
          mind = await this.#personal(actor, actorPrincipalId, personal);
        } catch (error) {
          if (error instanceof MindDiscoveryFailure && error.code === "mind_not_found") {
            return null;
          }
          throw error;
        }
      } else {
        mind = await this.#ordinaryById(actor, entry.spaceId, {
          discovery: "exact_handle",
          requireMembership: false,
          requirePublic: false,
        });
      }
      return mind === null ? null : this.#projectEnabledUsage(mind.descriptor, usage);
    });
    const minds = resolved
      .filter((mind): mind is Readonly<MindDiscoveryDescriptor> => mind !== null)
      .sort((left, right) => {
        if (left.isPersonal !== right.isPersonal) return left.isPersonal ? -1 : 1;
        const routeOrder = left.route.localeCompare(right.route, "en");
        return routeOrder === 0
          ? left.mindId.localeCompare(right.mindId, "en")
          : routeOrder;
      });
    const fingerprint = listFingerprint(minds);
    if (
      normalized.fingerprint !== null &&
      (normalized.fingerprint !== fingerprint || normalized.offset >= minds.length)
    ) {
      throw new MindDiscoveryFailure("invalid_cursor", "Mind list cursor is invalid.");
    }
    const page = minds.slice(normalized.offset, normalized.offset + normalized.limit);
    const nextOffset = normalized.offset + page.length;
    return Object.freeze({
      minds: Object.freeze(page),
      nextCursor:
        nextOffset < minds.length ? encodeCursor(nextOffset, fingerprint) : null,
    });
  }

  /**
   * Rechecks principal-owned usage before locator/resource paths that do not
   * carry a model-visible Mind descriptor. Disabled is indistinguishable from
   * an unavailable content target.
   */
  async requireEnabledMindUsage(
    actor: ActorContext,
    spaceId: SpaceId,
  ): Promise<Readonly<EnabledMindUsageProjection> | null> {
    if (!this.#principalUsageRequired) return null;
    await this.#requireCredentialAccess(actor);
    const actorPrincipalId = this.#requireActor(actor);
    const state = await this.#readPrincipalUsageState(actorPrincipalId);
    const usage = state === null ? null : enabledUsageProjection(state, spaceId);
    if (usage === null) {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    return usage;
  }

  async #readPrincipalUsageState(
    actorPrincipalId: PrincipalId,
  ): Promise<Readonly<PrincipalMindUsageState> | null> {
    let state: Readonly<PrincipalMindUsageState> | null;
    try {
      state = await this.#store.readPrincipalMindUsage(actorPrincipalId);
    } catch {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Mind usage state is unavailable.",
      );
    }
    if (state === null) return null;
    if (state.principalId !== actorPrincipalId) {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Mind usage state is unavailable.",
      );
    }
    let validated: Readonly<PrincipalMindUsageState>;
    try {
      validated = freezePrincipalMindUsageState(state);
    } catch {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Mind usage state is unavailable.",
      );
    }
    return validated;
  }

  #projectEnabledUsage(
    descriptor: Readonly<MindDiscoveryDescriptor>,
    usage: Readonly<EnabledMindUsageProjection>,
  ): Readonly<MindDiscoveryDescriptor> {
    const canWrite = usage.usageMode === "read_write" &&
      descriptor.access.capabilities.includes("content:write");
    return Object.freeze({
      ...descriptor,
      usageMode: usage.usageMode,
      effective: Object.freeze({ canRead: true as const, canWrite }),
      settingsVersion: usage.settingsVersion,
      writableMount: usage.writableMount,
    });
  }

  async #resolveCandidates(
    actor: ActorContext,
    candidates: readonly Readonly<{
      readonly spaceId: SpaceId;
      readonly discovery: "membership" | "public_catalog";
      readonly requireMembership: boolean;
      readonly requirePublic: boolean;
    }>[],
  ): Promise<readonly (Readonly<ResolvedMind> | null)[]> {
    const readStates = this.#store.readCurrentAuthorizationStates;
    const readSnapshots = this.#store.readResolvedSpaces;
    if (readStates === undefined || readSnapshots === undefined) {
      return mapDiscoveryBounded(candidates, (candidate) =>
        this.#ordinaryById(actor, candidate.spaceId, candidate));
    }

    const queries = candidates.map((candidate) =>
      authorizationStateQuery(actor, candidate.spaceId));
    const initialStates = await readStates.call(this.#store, queries);
    if (!Array.isArray(initialStates) || initialStates.length !== candidates.length) {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Mind discovery is unavailable.",
      );
    }
    const initialAccess = await Promise.all(
      candidates.map((candidate, index) =>
        this.#accessFromState(actor, candidate.spaceId, initialStates[index] ?? null)),
    );
    const authorized = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => {
        const access = initialAccess[index];
        return access !== null && access !== undefined &&
          (!candidate.requireMembership || access.grant.kind === "membership");
      });
    if (authorized.length === 0) return Object.freeze(candidates.map(() => null));

    const snapshots = await readSnapshots.call(
      this.#store,
      authorized.map(({ candidate }) => candidate.spaceId),
    );
    if (!Array.isArray(snapshots) || snapshots.length !== authorized.length) {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Mind discovery is unavailable.",
      );
    }

    const finalStates = await readStates.call(
      this.#store,
      authorized.map(({ candidate }) =>
        authorizationStateQuery(actor, candidate.spaceId)),
    );
    if (!Array.isArray(finalStates) || finalStates.length !== authorized.length) {
      throw new MindDiscoveryFailure(
        "discovery_unavailable",
        "Mind discovery is unavailable.",
      );
    }
    const resolved = new Array<Readonly<ResolvedMind> | null>(candidates.length).fill(null);
    for (const [offset, item] of authorized.entries()) {
      const snapshot = snapshots[offset] ?? null;
      if (snapshot === null) continue;
      const final = await this.#accessFromState(
        actor,
        item.candidate.spaceId,
        finalStates[offset] ?? null,
      );
      resolved[item.index] = await this.#ordinarySnapshot(
        actor,
        snapshot,
        item.candidate.discovery,
        item.candidate,
        initialAccess[item.index] ?? undefined,
        final ?? undefined,
      );
    }
    return Object.freeze(resolved);
  }

  async resolveMind(
    actor: ActorContext,
    handle: unknown,
  ): Promise<Readonly<MindDiscoveryDescriptor>> {
    await this.#requireCredentialAccess(actor);
    this.#requireActor(actor);
    const resolved = await this.#exactHandle(actor, handle);
    const usage = await this.requireEnabledMindUsage(actor, resolved.descriptor.mindId);
    return usage === null
      ? resolved.descriptor
      : this.#projectEnabledUsage(resolved.descriptor, usage);
  }

  async getMindInfo(
    actor: ActorContext,
    mind: unknown,
    revisionSelector?: unknown,
  ): Promise<Readonly<MindInfoResult>> {
    await this.#requireCredentialAccess(actor);
    if (this.#store.withConsistentRead !== undefined) {
      const indexStatusForStore = this.#indexStatusForStore;
      if (indexStatusForStore !== undefined) {
        return this.#store.withConsistentRead((store) =>
          new MindDiscoveryService({
            store,
            host: this.#host,
            indexStatus: indexStatusForStore(store),
            principalUsageRequired: this.#principalUsageRequired,
          }).getMindInfo(actor, mind, revisionSelector));
      }
      const info = await this.#store.withConsistentRead((store) =>
        new MindDiscoveryService({
          store,
          host: this.#host,
          principalUsageRequired: this.#principalUsageRequired,
        }).getMindInfo(actor, mind, revisionSelector));
      return Object.freeze({
        ...info,
        indexStatus: await this.#readIndexStatus(
          info.mind.mindId,
          info.resolvedRevision.revisionId,
          info.mind.head.revisionId,
        ),
      });
    }
    const actorPrincipalId = this.#requireActor(actor);
    const selector = parseRevisionSelector(revisionSelector);
    const revisionMode: RevisionMode = selector.kind === "head" ? "head" : "historical";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolved = await this.#mindSelector(actor, actorPrincipalId, mind);
      const spaceId = resolved.descriptor.mindId;
      const envelope = await this.#resolveRevision(spaceId, selector);
      if (envelope === null) {
        throw new MindDiscoveryFailure("revision_not_found", "Revision was not found.");
      }
      const currentHead = await this.#store.readHead(spaceId);
      if (currentHead === null) {
        throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
      }
      if (
        currentHead !== resolved.descriptor.head.revisionId ||
        (selector.kind === "head" && envelope.revision.revisionId !== currentHead)
      ) {
        continue;
      }
      const access = await this.#effectiveAccess(
        actor,
        spaceId,
        revisionMode,
        resolved.expectedAccessVersion,
      );
      if (access === null) {
        throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
      }
      if ((await this.#store.readHead(spaceId)) !== currentHead) continue;
      const indexStatus = await this.#readIndexStatus(
        spaceId,
        envelope.revision.revisionId,
        currentHead,
      );
      const capabilities = infoCapabilities(access.capabilities);
      return Object.freeze({
        mind: resolved.descriptor,
        resolvedRevision: revisionDescriptor(envelope, currentHead),
        revisionMode,
        contentCapabilities:
          resolved.descriptor.usageMode !== undefined &&
          resolved.descriptor.effective?.canWrite !== true
            ? Object.freeze(capabilities.filter((capability) => capability !== "commit"))
            : capabilities,
        indexStatus,
      });
    }
    throw new MindDiscoveryFailure(
      "discovery_unavailable",
      "Mind changed while it was being resolved.",
    );
  }

  async #requireCredentialAccess(actor: ActorContext): Promise<void> {
    if (this.#credentialAccess === undefined) return;
    const decision = await this.#credentialAccess.authorizeCredentialContentAccess(actor);
    if (decision.kind === "allowed") return;
    throw new MindDiscoveryFailure(
      decision.code,
      decision.code === "credential_access_upgrade_required"
        ? "Credential access must be upgraded before content discovery or read."
        : "Credential access is unavailable.",
    );
  }

  #requireActor(actor: ActorContext): PrincipalId {
    const id = principalId(actor);
    if (id === null) {
      throw new MindDiscoveryFailure(
        "authentication_required",
        "An authenticated principal is required.",
      );
    }
    return id;
  }

  async #readIndexStatus(
    spaceId: SpaceId,
    revisionId: RevisionId,
    currentHeadRevisionId: RevisionId,
  ): Promise<Readonly<MindInfoResult["indexStatus"]>> {
    const raw = await this.#indexStatus?.read({
      spaceId,
      revisionId,
      currentHeadRevisionId,
    });
    if (raw === undefined || raw === null) {
      return Object.freeze({
        status: "missing",
        retryable: true,
        retryAfterMs: 1_000,
        failureCode: null,
      });
    }
    const retryable = raw.status !== "ready" &&
      raw.attempts < 5 &&
      !isRevisionIndexTerminalFailureCode(raw.lastFailureCode);
    return Object.freeze({
      status: raw.status,
      retryable,
      retryAfterMs:
        retryable
          ? Math.min(
              30_000,
              1_000 * (2 ** Math.max(0, Math.min(raw.attempts - 1, 5))),
            )
          : null,
      failureCode: raw.lastFailureCode,
    });
  }

  async #mindSelector(
    actor: ActorContext,
    actorPrincipalId: PrincipalId,
    mind: unknown,
  ): Promise<Readonly<ResolvedMind>> {
    if (typeof mind !== "string" || mind.length === 0 || mind.length > 512) {
      throw new MindDiscoveryFailure("invalid_mind_selector", "Mind selector is invalid.");
    }
    let resolved: Readonly<ResolvedMind>;
    if (mind === "/me") {
      resolved = await this.#personal(actor, actorPrincipalId);
      return this.#withRequiredUsage(actor, resolved);
    }
    if (mind.startsWith("/")) {
      if (mind.slice(1).includes("/")) {
        throw new MindDiscoveryFailure("invalid_mind_selector", "Mind selector is invalid.");
      }
      resolved = await this.#exactHandle(actor, mind.slice(1));
      return this.#withRequiredUsage(actor, resolved);
    }

    const parsed = parseCanonicalSpaceHandle(mind);
    if (parsed.kind === "valid" && !isReservedTopLevelHandle(parsed.canonicalHandle)) {
      try {
        resolved = await this.#exactHandle(actor, parsed.canonicalHandle);
        return this.#withRequiredUsage(actor, resolved);
      } catch (error) {
        if (!(error instanceof MindDiscoveryFailure) || error.code !== "mind_not_found") {
          throw error;
        }
      }
    }

    const personal = await this.#store.readPersonalMindProfile(actorPrincipalId);
    if (personal?.personalMind.spaceId === mind) {
      resolved = await this.#personal(actor, actorPrincipalId, personal);
      return this.#withRequiredUsage(actor, resolved);
    }
    const ordinary = await this.#ordinaryById(actor, mind as SpaceId, {
      discovery: "exact_handle",
      requireMembership: false,
      requirePublic: false,
    });
    if (ordinary === null) {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    return this.#withRequiredUsage(actor, ordinary);
  }

  async #withRequiredUsage(
    actor: ActorContext,
    resolved: Readonly<ResolvedMind>,
  ): Promise<Readonly<ResolvedMind>> {
    const usage = await this.requireEnabledMindUsage(actor, resolved.descriptor.mindId);
    if (usage === null) return resolved;
    return Object.freeze({
      ...resolved,
      descriptor: this.#projectEnabledUsage(resolved.descriptor, usage),
    });
  }

  async #personal(
    actor: ActorContext,
    actorPrincipalId: PrincipalId,
    existing?: Readonly<PersonalMindProfileSnapshot>,
  ): Promise<Readonly<ResolvedMind>> {
    const profile = existing ?? (await this.#store.readPersonalMindProfile(actorPrincipalId));
    if (profile === null || profile.principalId !== actorPrincipalId) {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    const head = await this.#readRevision(
      profile.personalMind.spaceId,
      profile.personalMind.headRevisionId,
    );
    const access = await this.#effectiveAccess(
      actor,
      profile.personalMind.spaceId,
      "head",
      null,
    );
    if (head === null || access === null || access.grant.kind !== "membership") {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    return Object.freeze({
      descriptor: Object.freeze({
        mindId: profile.personalMind.spaceId,
        route: "/me",
        handle: null,
        name: profile.personalMind.name,
        routingProfile: "personal_default",
        isPersonal: true,
        visibility: "private",
        discovery: "personal",
        access: accessDescriptor(access),
        metadataVersion: profile.personalMind.metadataVersion,
        head: revisionDescriptor(head, profile.personalMind.headRevisionId),
      }),
      expectedAccessVersion: null,
    });
  }

  async #exactHandle(actor: ActorContext, handle: unknown): Promise<Readonly<ResolvedMind>> {
    if (typeof handle !== "string") {
      throw new MindDiscoveryFailure("invalid_mind_selector", "Mind handle is invalid.");
    }
    const parsed = parseCanonicalSpaceHandle(handle);
    if (parsed.kind !== "valid" || isReservedTopLevelHandle(parsed.canonicalHandle)) {
      throw new MindDiscoveryFailure("invalid_mind_selector", "Mind handle is invalid.");
    }
    const initial = await this.#handles.read({
      actor,
      host: this.#host,
      handle: parsed.canonicalHandle,
      capability: READ_CAPABILITY,
      revisionMode: "head",
    });
    if (initial.kind === "not_found") {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    const snapshot = initial.value;
    if (!this.#validOrdinary(snapshot, initial.spaceId, parsed.canonicalHandle)) {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    const resolved = await this.#ordinarySnapshot(
      actor,
      snapshot,
      "exact_handle",
    );
    if (resolved === null) {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    return resolved;
  }

  async #ordinaryById(
    actor: ActorContext,
    spaceId: SpaceId,
    policy: Readonly<{
      discovery: "membership" | "public_catalog" | "exact_handle";
      requireMembership: boolean;
      requirePublic: boolean;
    }>,
  ): Promise<Readonly<ResolvedMind> | null> {
    const initial = await this.#capabilityPass(actor, spaceId, "head");
    if (
      initial === null ||
      (policy.requireMembership && initial.grant.kind !== "membership")
    ) {
      return null;
    }
    const snapshot = await this.#store.readResolvedSpace(spaceId);
    if (
      !this.#validOrdinary(snapshot, spaceId, null) ||
      (policy.requirePublic && snapshot!.space.visibility !== "public")
    ) {
      return null;
    }
    return this.#ordinarySnapshot(
      actor,
      snapshot!,
      policy.discovery,
      policy,
      initial,
    );
  }

  async #accessFromState(
    actor: ActorContext,
    spaceId: SpaceId,
    state: Readonly<CurrentAuthorizationState> | null,
  ): Promise<Readonly<EffectiveAccess> | null> {
    const decisions = await this.#authorizer.authorizeCapabilitiesFromState(
      {
        actor,
        spaceId,
        capabilities: CONTENT_CAPABILITIES,
        revisionMode: "head",
      },
      state,
    );
    return effectiveAccessFromDecisions(decisions);
  }

  async #ordinarySnapshot(
    actor: ActorContext,
    snapshot: Readonly<OrdinaryMindRouteSnapshot>,
    discovery: "membership" | "public_catalog" | "exact_handle",
    policy?: Readonly<{ readonly requireMembership: boolean; readonly requirePublic: boolean }>,
    initialAccess?: Readonly<EffectiveAccess>,
    finalAccess?: Readonly<EffectiveAccess>,
  ): Promise<Readonly<ResolvedMind> | null> {
    if (policy?.requirePublic && snapshot.space.visibility !== "public") return null;
    const head = snapshot.headRevision === undefined
      ? await this.#readRevision(snapshot.space.spaceId, snapshot.space.headRevisionId)
      : snapshot.headRevision;
    if (head === null) return null;
    const access = finalAccess === undefined
      ? await this.#effectiveAccess(
          actor,
          snapshot.space.spaceId,
          "head",
          snapshot.space.accessVersion,
          initialAccess,
        )
      : initialAccess !== undefined &&
          sameEffectiveAccess(initialAccess, finalAccess) &&
          finalAccess.stamp.accessVersion === snapshot.space.accessVersion
        ? finalAccess
        : null;
    if (
      access === null ||
      (policy?.requireMembership && access.grant.kind !== "membership") ||
      (policy?.requirePublic && snapshot.space.visibility !== "public")
    ) {
      return null;
    }
    const space = snapshot.space;
    const effectiveDiscovery =
      access.grant.kind === "membership" ? "membership" : discovery;
    return Object.freeze({
      descriptor: Object.freeze({
        mindId: space.spaceId,
        route: `/${snapshot.canonicalHandle}`,
        handle: snapshot.canonicalHandle,
        name: space.name,
        description: space.description ?? null,
        routingProfile: "description_based",
        isPersonal: false,
        visibility: space.visibility,
        discovery: effectiveDiscovery,
        access: accessDescriptor(access),
        metadataVersion: space.metadataVersion,
        head: revisionDescriptorForHead(head, space.headRevisionId),
      }),
      expectedAccessVersion: space.accessVersion,
    });
  }

  #validOrdinary(
    snapshot: Readonly<OrdinaryMindRouteSnapshot> | null,
    spaceId: SpaceId,
    expectedHandle: string | null,
  ): boolean {
    if (
      snapshot === null ||
      snapshot.host !== this.#host ||
      snapshot.space.spaceId !== spaceId ||
      snapshot.space.state !== "active" ||
      snapshot.canonicalHandle !== snapshot.space.spaceHandle ||
      snapshot.canonicalHandle !== snapshot.space.normalizedHandle ||
      (expectedHandle !== null && snapshot.canonicalHandle !== expectedHandle)
    ) {
      return false;
    }
    const parsed = parseCanonicalSpaceHandle(snapshot.canonicalHandle);
    return parsed.kind === "valid" && !isReservedTopLevelHandle(parsed.canonicalHandle);
  }

  async #effectiveAccess(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
    expectedAccessVersion: number | null,
    initialAccess?: Readonly<EffectiveAccess>,
  ): Promise<Readonly<EffectiveAccess> | null> {
    const first = initialAccess ?? (await this.#capabilityPass(actor, spaceId, revisionMode));
    const second = await this.#capabilityPass(actor, spaceId, revisionMode);
    if (
      first === null ||
      second === null ||
      !sameEffectiveAccess(first, second) ||
      (expectedAccessVersion !== null && second.stamp.accessVersion !== expectedAccessVersion)
    ) {
      return null;
    }
    return second;
  }

  async #capabilityPass(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
  ): Promise<Readonly<EffectiveAccess> | null> {
    const decisions = await this.#authorizer.authorizeCapabilities({
      actor,
      spaceId,
      capabilities: CONTENT_CAPABILITIES,
      revisionMode,
    });
    return effectiveAccessFromDecisions(decisions);
  }

  async #readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null> {
    const envelope = await this.#store.readRevision(spaceId, revisionId);
    return envelope?.revision.spaceId === spaceId ? envelope : null;
  }

  async #resolveRevision(
    spaceId: SpaceId,
    selector: Readonly<MindRevisionSelector>,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null> {
    if (selector.kind === "head") {
      const head = await this.#store.readHead(spaceId);
      return head === null ? null : this.#readRevision(spaceId, head);
    }
    if (selector.kind === "revision") {
      return this.#readRevision(spaceId, selector.revisionId);
    }
    const requestedAt = Date.parse(selector.asOf);
    const revisions = await this.#store.listRevisions(spaceId);
    let selected: Readonly<CanonicalRevisionEnvelope> | null = null;
    for (const envelope of revisions) {
      if (
        envelope.revision.spaceId === spaceId &&
        Date.parse(envelope.revision.committedAt) <= requestedAt &&
        (selected === null ||
          envelope.revision.revisionNumber > selected.revision.revisionNumber)
      ) {
        selected = envelope;
      }
    }
    return selected;
  }
}
