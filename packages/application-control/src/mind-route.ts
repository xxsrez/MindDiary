import type { ActorContext } from "@mind-diary/application-contracts";
import { AuthorizedHandleReader, CapabilityAuthorizer } from "@mind-diary/application-ports";
import type { AuthorizationDecision, AuthorizationGrant, AuthorizationStateQuery, AuthorizationStamp, CurrentAuthorizationState, MindRouteMetadataStore, OrdinaryMindRouteSnapshot, OrdinaryMindSnapshot, PersonalMindProfileSnapshot, VerifiedSpaceHost } from "@mind-diary/application-ports";
import { capabilitiesForRole, capabilitiesForVisibilityGrant, isReservedTopLevelHandle, isReservedTopLevelRoute, parseCanonicalSpaceHandle } from "@mind-diary/domain";
import type { Capability, PrincipalId, SpaceId, Role } from "@mind-diary/domain";
import { registeredSitesPrincipal } from "./personal-mind-control.js";
import { safeBootstrapRequestId } from "./account-bootstrap.js";

export type MindRouteFailureCode =
  | "authentication_required"
  | "invalid_route"
  | "mind_not_found";

/** Stable safe route failure without target metadata or routing internals. */
export class MindRouteFailure extends Error {
  readonly code: MindRouteFailureCode;

  constructor(code: MindRouteFailureCode, message: string) {
    super(message);
    this.name = "MindRouteFailure";
    this.code = code;
  }
}

export type MindRouteAccess =
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

export interface PersonalMindRouteDescriptor {
  readonly mindId: SpaceId;
  readonly route: "/me";
  readonly name: string;
  readonly isPersonal: true;
  readonly visibility: "private";
  readonly discovery: "personal";
  readonly access: Readonly<MindRouteAccess>;
  readonly metadataVersion: number;
  readonly headRevisionId: PersonalMindProfileSnapshot["personalMind"]["headRevisionId"];
}

export interface OrdinaryMindRouteDescriptor {
  readonly mindId: SpaceId;
  readonly route: `/${string}`;
  readonly handle: string;
  readonly name: string;
  readonly isPersonal: false;
  readonly visibility: "private" | "unlisted" | "public";
  readonly discovery: "membership" | "exact_handle" | "public_catalog";
  readonly access: Readonly<MindRouteAccess>;
  readonly metadataVersion: number;
  readonly headRevisionId: OrdinaryMindSnapshot["space"]["headRevisionId"];
}

export type MindRouteDescriptor =
  | PersonalMindRouteDescriptor
  | OrdinaryMindRouteDescriptor;

export interface MindRouteSafeEvent {
  readonly event:
    | "mind_route_resolved"
    | "mind_list_returned"
    | "mind_route_denied"
    | "mind_route_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface MindRouteSafeLogger {
  record(event: Readonly<MindRouteSafeEvent>): void | Promise<void>;
}

export interface MindRouteDependencies {
  readonly routes: MindRouteMetadataStore;
  readonly host: VerifiedSpaceHost;
  readonly logger?: MindRouteSafeLogger;
}

const CONSISTENT_MIND_ROUTE_READ = Symbol("consistent_mind_route_read");
type MindRouteConstruction = MindRouteDependencies & {
  readonly [CONSISTENT_MIND_ROUTE_READ]?: true;
};

const ROUTE_READ_CAPABILITY = "content:browse" as const;

function routeAuthorizationStateQuery(
  actor: ActorContext,
  spaceId: SpaceId,
): AuthorizationStateQuery {
  if (actor.kind !== "registered_principal") {
    throw new MindRouteFailure(
      "authentication_required",
      "A registered Sites principal is required.",
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

function sameRouteAuthorizationStamp(
  left: AuthorizationStamp,
  right: AuthorizationStamp,
): boolean {
  return (
    left.accessVersion === right.accessVersion &&
    left.membershipVersion === right.membershipVersion &&
    left.tokenVersion === right.tokenVersion
  );
}

function routeContentCapabilities(
  capabilities: readonly Capability[],
): readonly Capability[] {
  return Object.freeze(
    capabilities.filter((capability) => capability.startsWith("content:")),
  );
}

function routeAccess(grant: AuthorizationGrant): Readonly<MindRouteAccess> {
  if (grant.kind === "membership") {
    return Object.freeze({
      kind: "membership",
      role: grant.role,
      capabilities: routeContentCapabilities(capabilitiesForRole(grant.role)),
    });
  }
  return Object.freeze({
    kind: "visibility",
    role: null,
    capabilities: routeContentCapabilities(
      capabilitiesForVisibilityGrant(grant.visibility),
    ),
  });
}

function personalRouteDescriptor(
  profile: Readonly<PersonalMindProfileSnapshot>,
): Readonly<PersonalMindRouteDescriptor> {
  return Object.freeze({
    mindId: profile.personalMind.spaceId,
    route: "/me",
    name: profile.personalMind.name,
    isPersonal: true,
    visibility: "private",
    discovery: "personal",
    access: Object.freeze({
      kind: "membership",
      role: "owner",
      capabilities: routeContentCapabilities(capabilitiesForRole("owner")),
    }),
    metadataVersion: profile.personalMind.metadataVersion,
    headRevisionId: profile.personalMind.headRevisionId,
  });
}

function recordMindRouteEvent(
  logger: MindRouteSafeLogger | undefined,
  event: MindRouteSafeEvent["event"],
  requestId: ActorContext["requestId"],
): void {
  if (!logger) return;
  try {
    const pending = logger.record(Object.freeze({ event, requestId }));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Safe observability remains outside route reads.
  }
}

/** Authenticated `/me`, membership list, and exact ordinary management routes. */
export class MindRouteService {
  readonly #routes: MindRouteMetadataStore;
  readonly #host: VerifiedSpaceHost;
  readonly #logger: MindRouteSafeLogger | undefined;
  readonly #consistentRead: boolean;
  readonly #authorizer: CapabilityAuthorizer;
  readonly #handleReader: AuthorizedHandleReader<
    Readonly<OrdinaryMindRouteSnapshot>
  >;

  constructor(dependencies: MindRouteConstruction) {
    this.#routes = dependencies.routes;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
    this.#consistentRead = dependencies[CONSISTENT_MIND_ROUTE_READ] === true;
    this.#authorizer = new CapabilityAuthorizer(dependencies.routes);
    this.#handleReader = new AuthorizedHandleReader({
      handles: dependencies.routes,
      authorizer: this.#authorizer,
      targets: dependencies.routes,
    });
  }

  async resolveRoute(
    actor: ActorContext,
    route: unknown,
  ): Promise<Readonly<MindRouteDescriptor>> {
    const principalId = this.#requireActor(actor);
    if (route === "/me") return this.#resolvePersonal(principalId, actor.requestId);
    if (
      typeof route !== "string" ||
      !route.startsWith("/") ||
      route.length < 2 ||
      route.slice(1).includes("/")
    ) {
      throw new MindRouteFailure("invalid_route", "A canonical Mind route is required.");
    }
    return this.#resolveExact(actor, route.slice(1));
  }

  async resolveExactMind(
    actor: ActorContext,
    handle: unknown,
  ): Promise<Readonly<OrdinaryMindRouteDescriptor>> {
    this.#requireActor(actor);
    return this.#resolveExact(actor, handle);
  }

  async listMinds(
    actor: ActorContext,
  ): Promise<readonly Readonly<MindRouteDescriptor>[]> {
    if (this.#routes.withConsistentRead !== undefined) {
      return this.#routes.withConsistentRead((routes) =>
        new MindRouteService({
          routes,
          host: this.#host,
          [CONSISTENT_MIND_ROUTE_READ]: true,
          ...(this.#logger === undefined ? {} : { logger: this.#logger }),
        }).listMinds(actor));
    }
    const principalId = this.#requireActor(actor);
    const personal = await this.#routes.readPersonalMindProfile(principalId);
    if (personal === null || personal.principalId !== principalId) {
      throw new MindRouteFailure("mind_not_found", "Mind was not found.");
    }
    const descriptors: MindRouteDescriptor[] = [personalRouteDescriptor(personal)];
    const candidateIds = [...new Set(
      await this.#routes.listActiveMembershipMindIds(principalId),
    )].sort();
    const batched = await this.#listMindsBatch(actor, candidateIds);
    descriptors.push(...batched);
    descriptors.sort((left, right) => {
      if (left.isPersonal !== right.isPersonal) return left.isPersonal ? -1 : 1;
      const routeOrder = left.route.localeCompare(right.route, "en");
      return routeOrder === 0 ? left.mindId.localeCompare(right.mindId, "en") : routeOrder;
    });
    recordMindRouteEvent(this.#logger, "mind_list_returned", actor.requestId);
    return Object.freeze(descriptors);
  }

  async #listMindsBatch(
    actor: ActorContext,
    candidateIds: readonly SpaceId[],
  ): Promise<readonly Readonly<OrdinaryMindRouteDescriptor>[]> {
    const readStates = this.#routes.readCurrentAuthorizationStates;
    const readSnapshots = this.#routes.readResolvedSpaces;
    if (readStates === undefined || readSnapshots === undefined) {
      const descriptors: OrdinaryMindRouteDescriptor[] = [];
      for (const spaceId of candidateIds) {
        const first = await this.#authorizer.authorize({
          actor,
          spaceId,
          capability: ROUTE_READ_CAPABILITY,
          revisionMode: "head",
        });
        if (first.kind === "denied" || first.grant.kind !== "membership") continue;
        const snapshot = await this.#routes.readResolvedSpace(spaceId);
        if (!this.#validSnapshot(snapshot, spaceId, null, null)) continue;
        const final = await this.#finalAuthorize(actor, snapshot!);
        if (final.kind === "denied" || final.grant.kind !== "membership") continue;
        if (!this.#validSnapshot(snapshot, spaceId, null, final.stamp.accessVersion)) continue;
        descriptors.push(this.#ordinaryDescriptor(snapshot!, final.grant, "membership"));
      }
      return Object.freeze(descriptors);
    }

    const queries = candidateIds.map((spaceId) =>
      routeAuthorizationStateQuery(actor, spaceId));
    const initialStates = await readStates.call(this.#routes, queries);
    if (!Array.isArray(initialStates) || initialStates.length !== candidateIds.length) {
      throw new MindRouteFailure("mind_not_found", "Mind was not found.");
    }
    const initial = await Promise.all(
      candidateIds.map((spaceId, index) =>
        this.#authorizeRouteFromState(actor, spaceId, initialStates[index] ?? null)),
    );
    const authorized = candidateIds
      .map((spaceId, index) => ({ spaceId, index }))
      .filter(({ index }) => {
        const decision = initial[index];
        return decision?.kind === "allowed" && decision.grant.kind === "membership";
      });
    if (authorized.length === 0) return Object.freeze([]);
    const snapshots = await readSnapshots.call(
      this.#routes,
      authorized.map(({ spaceId }) => spaceId),
    );
    if (!Array.isArray(snapshots) || snapshots.length !== authorized.length) {
      throw new MindRouteFailure("mind_not_found", "Mind was not found.");
    }
    if (this.#consistentRead) {
      const descriptors: OrdinaryMindRouteDescriptor[] = [];
      for (const [offset, item] of authorized.entries()) {
        const snapshot = snapshots[offset] ?? null;
        const decision = initial[item.index];
        if (
          snapshot === null ||
          decision?.kind !== "allowed" ||
          decision.grant.kind !== "membership" ||
          !this.#validSnapshot(snapshot, item.spaceId, null, decision.stamp.accessVersion)
        ) continue;
        descriptors.push(this.#ordinaryDescriptor(snapshot, decision.grant, "membership"));
      }
      return Object.freeze(descriptors);
    }
    const finalStates = await readStates.call(
      this.#routes,
      authorized.map(({ spaceId }) => routeAuthorizationStateQuery(actor, spaceId)),
    );
    if (!Array.isArray(finalStates) || finalStates.length !== authorized.length) {
      throw new MindRouteFailure("mind_not_found", "Mind was not found.");
    }
    const descriptors: OrdinaryMindRouteDescriptor[] = [];
    for (const [offset, item] of authorized.entries()) {
      const snapshot = snapshots[offset] ?? null;
      const first = initial[item.index];
      const final = await this.#authorizeRouteFromState(
        actor,
        item.spaceId,
        finalStates[offset] ?? null,
      );
      if (
        snapshot === null ||
        first?.kind !== "allowed" ||
        first.grant.kind !== "membership" ||
        final.kind !== "allowed" ||
        final.grant.kind !== "membership" ||
        !sameRouteAuthorizationStamp(first.stamp, final.stamp) ||
        !this.#validSnapshot(snapshot, item.spaceId, null, final.stamp.accessVersion)
      ) continue;
      descriptors.push(this.#ordinaryDescriptor(snapshot, final.grant, "membership"));
    }
    return Object.freeze(descriptors);
  }

  async #authorizeRouteFromState(
    actor: ActorContext,
    spaceId: SpaceId,
    state: Readonly<CurrentAuthorizationState> | null,
  ): Promise<AuthorizationDecision> {
    const [decision] = await this.#authorizer.authorizeCapabilitiesFromState(
      {
        actor,
        spaceId,
        capabilities: [ROUTE_READ_CAPABILITY],
        revisionMode: "head",
      },
      state,
    );
    return decision ?? { kind: "denied", code: "authorization_state_unavailable", retryable: false };
  }

  /**
   * Resolves one opaque catalog candidate through current canonical state.
   * The initial authorization intentionally precedes all route metadata reads.
   */
  async resolvePublicCatalogMind(
    actor: ActorContext,
    spaceId: unknown,
  ): Promise<Readonly<OrdinaryMindRouteDescriptor>> {
    this.#requireActor(actor);
    if (typeof spaceId !== "string" || spaceId.length === 0) {
      return this.#notFound(actor.requestId);
    }
    const candidateSpaceId = spaceId as SpaceId;
    const initial = await this.#authorizer.authorize({
      actor,
      spaceId: candidateSpaceId,
      capability: ROUTE_READ_CAPABILITY,
      revisionMode: "head",
    });
    if (initial.kind === "denied") return this.#notFound(actor.requestId);
    const snapshot = await this.#routes.readResolvedSpace(candidateSpaceId);
    if (
      !this.#validSnapshot(snapshot, candidateSpaceId, null, null) ||
      snapshot!.space.visibility !== "public"
    ) {
      return this.#notFound(actor.requestId);
    }
    const final = await this.#finalAuthorize(actor, snapshot!);
    if (
      final.kind === "denied" ||
      snapshot!.space.visibility !== "public" ||
      !this.#validSnapshot(
        snapshot,
        candidateSpaceId,
        snapshot!.canonicalHandle,
        final.stamp.accessVersion,
      )
    ) {
      return this.#notFound(actor.requestId);
    }
    recordMindRouteEvent(this.#logger, "mind_route_resolved", actor.requestId);
    return this.#ordinaryDescriptor(
      snapshot!,
      final.grant,
      "public_catalog",
    );
  }

  #requireActor(actor: ActorContext): PrincipalId {
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordMindRouteEvent(
        this.#logger,
        "mind_route_denied",
        safeBootstrapRequestId(actor?.requestId),
      );
      throw new MindRouteFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    return principalId;
  }

  async #resolvePersonal(
    principalId: PrincipalId,
    requestId: ActorContext["requestId"],
  ): Promise<Readonly<PersonalMindRouteDescriptor>> {
    const profile = await this.#routes.readPersonalMindProfile(principalId);
    if (profile === null || profile.principalId !== principalId) {
      throw new MindRouteFailure("mind_not_found", "Mind was not found.");
    }
    recordMindRouteEvent(this.#logger, "mind_route_resolved", requestId);
    return personalRouteDescriptor(profile);
  }

  async #resolveExact(
    actor: ActorContext,
    handle: unknown,
  ): Promise<Readonly<OrdinaryMindRouteDescriptor>> {
    if (isReservedTopLevelRoute(handle)) {
      throw new MindRouteFailure("invalid_route", "A canonical Mind route is required.");
    }
    const parsed = parseCanonicalSpaceHandle(handle);
    if (parsed.kind !== "valid" || isReservedTopLevelHandle(parsed.canonicalHandle)) {
      throw new MindRouteFailure("invalid_route", "A canonical Mind route is required.");
    }
    try {
      const initial = await this.#handleReader.read({
        actor,
        host: this.#host,
        handle: parsed.canonicalHandle,
        capability: ROUTE_READ_CAPABILITY,
        revisionMode: "head",
      });
      if (initial.kind === "not_found") return this.#notFound(actor.requestId);
      const snapshot = initial.value;
      if (!this.#validSnapshot(snapshot, initial.spaceId, parsed.canonicalHandle, null)) {
        return this.#notFound(actor.requestId);
      }
      const final = await this.#finalAuthorize(actor, snapshot);
      if (final.kind === "denied") return this.#notFound(actor.requestId);
      if (
        !this.#validSnapshot(
          snapshot,
          initial.spaceId,
          parsed.canonicalHandle,
          final.stamp.accessVersion,
        )
      ) {
        return this.#notFound(actor.requestId);
      }
      const discovery =
        final.grant.kind === "membership" ? "membership" : "exact_handle";
      recordMindRouteEvent(this.#logger, "mind_route_resolved", actor.requestId);
      return this.#ordinaryDescriptor(snapshot, final.grant, discovery);
    } catch (error) {
      if (error instanceof MindRouteFailure) throw error;
      recordMindRouteEvent(this.#logger, "mind_route_failed", actor.requestId);
      throw error;
    }
  }

  #validSnapshot(
    snapshot: Readonly<OrdinaryMindRouteSnapshot> | null,
    spaceId: SpaceId,
    expectedHandle: string | null,
    expectedAccessVersion: number | null,
  ): boolean {
    if (
      snapshot === null ||
      snapshot.host !== this.#host ||
      snapshot.space.spaceId !== spaceId ||
      snapshot.space.state !== "active" ||
      snapshot.canonicalHandle !== snapshot.space.spaceHandle ||
      snapshot.canonicalHandle !== snapshot.space.normalizedHandle ||
      (expectedHandle !== null && snapshot.canonicalHandle !== expectedHandle) ||
      (expectedAccessVersion !== null &&
        snapshot.space.accessVersion !== expectedAccessVersion)
    ) {
      return false;
    }
    const parsed = parseCanonicalSpaceHandle(snapshot.space.spaceHandle);
    return (
      parsed.kind === "valid" &&
      !isReservedTopLevelHandle(parsed.canonicalHandle)
    );
  }

  #ordinaryDescriptor(
    snapshot: Readonly<OrdinaryMindRouteSnapshot>,
    grant: AuthorizationGrant,
    discovery: OrdinaryMindRouteDescriptor["discovery"],
  ): Readonly<OrdinaryMindRouteDescriptor> {
    const space = snapshot.space;
    return Object.freeze({
      mindId: space.spaceId,
      route: `/${snapshot.canonicalHandle}`,
      handle: snapshot.canonicalHandle,
      name: space.name,
      isPersonal: false,
      visibility: space.visibility,
      discovery,
      access: routeAccess(grant),
      metadataVersion: space.metadataVersion,
      headRevisionId: space.headRevisionId,
    });
  }

  #finalAuthorize(
    actor: ActorContext,
    snapshot: Readonly<OrdinaryMindRouteSnapshot>,
  ) {
    const finalAuthorizer = new CapabilityAuthorizer({
      readCurrentAuthorizationState: (query) =>
        this.#routes.readCurrentRouteAuthorizationState({
          ...query,
          host: snapshot.host,
          handle: snapshot.canonicalHandle,
        }),
    });
    return finalAuthorizer.authorize({
      actor,
      spaceId: snapshot.space.spaceId,
      capability: ROUTE_READ_CAPABILITY,
      revisionMode: "head",
    });
  }

  #notFound(requestId: ActorContext["requestId"]): never {
    recordMindRouteEvent(this.#logger, "mind_route_denied", requestId);
    throw new MindRouteFailure("mind_not_found", "Mind was not found.");
  }
}
