import type { ActorContext } from "@mind-diary/application-contracts";
import {
  AuthorizedHandleReader,
  CapabilityAuthorizer,
  type AuthorizationGrant,
  type AuthorizationStamp,
  type OrdinaryMindRouteSnapshot,
  type PersonalMindProfileSnapshot,
  type PublicMindCatalogStore,
  type RevisionMetadataStore,
} from "@mind-diary/application-ports";
import {
  capabilitiesForRole,
  capabilitiesForVisibilityGrant,
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
  utcInstant,
  type CanonicalRevisionEnvelope,
  type Capability,
  type PrincipalId,
  type RevisionId,
  type RevisionMode,
  type Role,
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
  readonly isPersonal: boolean;
  readonly visibility: "private" | "unlisted" | "public";
  readonly discovery:
    | "personal"
    | "membership"
    | "public_catalog"
    | "exact_handle";
  readonly access: Readonly<MindDiscoveryAccess>;
  readonly metadataVersion: number;
  readonly head: Readonly<MindDiscoveryRevisionDescriptor>;
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
    RevisionMetadataStore {
  /**
   * Optional adapter-level consistent view. Persistent adapters use this to
   * refresh one materialized snapshot/tail before resolving a whole list,
   * rather than issuing one storage refresh per candidate.
   */
  withConsistentRead?<Result>(
    operation: (store: MindDiscoveryStore) => Promise<Result>,
  ): Promise<Result>;
}

export interface MindDiscoveryDependencies {
  readonly store: MindDiscoveryStore;
  readonly host: VerifiedSpaceHost;
  readonly indexStatus?: RevisionIndexStatusReader;
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
    .map((mind) => `${mind.mindId}\u001f${mind.route}\u001f${mind.head.revisionId}\u001f${mind.discovery}`)
    .join("\u001e");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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
  readonly #authorizer: CapabilityAuthorizer;
  readonly #handles: AuthorizedHandleReader<Readonly<OrdinaryMindRouteSnapshot>>;

  constructor(dependencies: MindDiscoveryDependencies) {
    this.#store = dependencies.store;
    this.#host = dependencies.host;
    this.#indexStatus = dependencies.indexStatus;
    this.#authorizer = new CapabilityAuthorizer(dependencies.store);
    this.#handles = new AuthorizedHandleReader({
      handles: dependencies.store,
      authorizer: this.#authorizer,
      targets: dependencies.store,
    });
  }

  async listMinds(actor: ActorContext, query?: unknown): Promise<Readonly<ListMindsResult>> {
    if (this.#store.withConsistentRead !== undefined) {
      return this.#store.withConsistentRead((store) =>
        new MindDiscoveryService({ store, host: this.#host }).listMinds(actor, query));
    }
    const actorPrincipalId = this.#requireActor(actor);
    const normalized = normalizeListQuery(query);
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
    const resolvedCandidates = await mapDiscoveryBounded(candidates, (candidate) =>
      this.#ordinaryById(actor, candidate.spaceId, candidate));
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

  async resolveMind(
    actor: ActorContext,
    handle: unknown,
  ): Promise<Readonly<MindDiscoveryDescriptor>> {
    this.#requireActor(actor);
    return (await this.#exactHandle(actor, handle)).descriptor;
  }

  async getMindInfo(
    actor: ActorContext,
    mind: unknown,
    revisionSelector?: unknown,
  ): Promise<Readonly<MindInfoResult>> {
    if (this.#store.withConsistentRead !== undefined) {
      const info = await this.#store.withConsistentRead((store) =>
        new MindDiscoveryService({
          store,
          host: this.#host,
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
      return Object.freeze({
        mind: resolved.descriptor,
        resolvedRevision: revisionDescriptor(envelope, currentHead),
        revisionMode,
        contentCapabilities: infoCapabilities(access.capabilities),
        indexStatus,
      });
    }
    throw new MindDiscoveryFailure(
      "discovery_unavailable",
      "Mind changed while it was being resolved.",
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
    return Object.freeze({
      status: raw.status,
      retryable: raw.status !== "ready" && raw.attempts < 5,
      retryAfterMs:
        raw.status !== "ready" && raw.attempts < 5
          ? Math.min(30_000, 1_000 * (2 ** Math.min(raw.attempts, 5)))
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
    if (mind === "/me") return this.#personal(actor, actorPrincipalId);
    if (mind.startsWith("/")) {
      if (mind.slice(1).includes("/")) {
        throw new MindDiscoveryFailure("invalid_mind_selector", "Mind selector is invalid.");
      }
      return this.#exactHandle(actor, mind.slice(1));
    }

    const parsed = parseCanonicalSpaceHandle(mind);
    if (parsed.kind === "valid" && !isReservedTopLevelHandle(parsed.canonicalHandle)) {
      try {
        return await this.#exactHandle(actor, parsed.canonicalHandle);
      } catch (error) {
        if (!(error instanceof MindDiscoveryFailure) || error.code !== "mind_not_found") {
          throw error;
        }
      }
    }

    const personal = await this.#store.readPersonalMindProfile(actorPrincipalId);
    if (personal?.personalMind.spaceId === mind) {
      return this.#personal(actor, actorPrincipalId, personal);
    }
    const ordinary = await this.#ordinaryById(actor, mind as SpaceId, {
      discovery: "exact_handle",
      requireMembership: false,
      requirePublic: false,
    });
    if (ordinary === null) {
      throw new MindDiscoveryFailure("mind_not_found", "Mind was not found.");
    }
    return ordinary;
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
    const initial = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability: READ_CAPABILITY,
      revisionMode: "head",
    });
    if (
      initial.kind === "denied" ||
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
    return this.#ordinarySnapshot(actor, snapshot!, policy.discovery, policy);
  }

  async #ordinarySnapshot(
    actor: ActorContext,
    snapshot: Readonly<OrdinaryMindRouteSnapshot>,
    discovery: "membership" | "public_catalog" | "exact_handle",
    policy?: Readonly<{ readonly requireMembership: boolean; readonly requirePublic: boolean }>,
  ): Promise<Readonly<ResolvedMind> | null> {
    if (policy?.requirePublic && snapshot.space.visibility !== "public") return null;
    const head = await this.#readRevision(snapshot.space.spaceId, snapshot.space.headRevisionId);
    if (head === null) return null;
    const access = await this.#effectiveAccess(
      actor,
      snapshot.space.spaceId,
      "head",
      snapshot.space.accessVersion,
    );
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
        isPersonal: false,
        visibility: space.visibility,
        discovery: effectiveDiscovery,
        access: accessDescriptor(access),
        metadataVersion: space.metadataVersion,
        head: revisionDescriptor(head, space.headRevisionId),
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
  ): Promise<Readonly<EffectiveAccess> | null> {
    const first = await this.#capabilityPass(actor, spaceId, revisionMode);
    const second = await this.#capabilityPass(actor, spaceId, revisionMode);
    if (
      first === null ||
      second === null ||
      !sameStamp(first.stamp, second.stamp) ||
      !sameGrant(first.grant, second.grant) ||
      first.capabilities.length !== second.capabilities.length ||
      first.capabilities.some((capability, index) => capability !== second.capabilities[index]) ||
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
    const allowed: Capability[] = [];
    let anchor: Extract<
      Awaited<ReturnType<CapabilityAuthorizer["authorize"]>>,
      { readonly kind: "allowed" }
    > | null = null;
    const decisions = await this.#authorizer.authorizeCapabilities({
      actor,
      spaceId,
      capabilities: CONTENT_CAPABILITIES,
      revisionMode,
    });
    for (const [index, capability] of CONTENT_CAPABILITIES.entries()) {
      const decision = decisions[index]!;
      if (decision.kind === "denied") continue;
      if (anchor !== null && !sameStamp(anchor.stamp, decision.stamp)) return null;
      anchor ??= decision;
      allowed.push(capability);
    }
    const finalRead = decisions[CONTENT_CAPABILITIES.indexOf(READ_CAPABILITY)]!;
    if (
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
