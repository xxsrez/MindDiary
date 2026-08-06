import type { ActorContext } from "@mind-diary/application-contracts";
import {
  ACCESS_TOKEN_STATES,
  CAPABILITIES,
  MEMBERSHIP_STATES,
  PRINCIPAL_STATES,
  ROLES,
  SPACE_LIFECYCLE_STATES,
  VISIBILITIES,
  capabilitiesForRole,
  capabilitiesForVisibilityGrant,
  revisionModeAllowsCapability,
  tokenScopesAllowCapability,
  type AccessTokenState,
  type Capability,
  type CanonicalRevisionEnvelope,
  type CanonicalSpaceHandle,
  type EffectiveTokenScopes,
  type HandlePolicyFailureReason,
  type MarkdownMediaType,
  type MembershipState,
  type PrincipalId,
  type PrincipalState,
  type RevisionId,
  type RevisionMode,
  type Role,
  type Sha256Digest,
  type SpaceId,
  type SpaceLifecycleState,
  type TokenId,
  type UtcInstant,
  type VerifiedSpaceHost,
  type Version,
  type Visibility,
} from "@mind-diary/domain";

export type { CanonicalRevisionEnvelope } from "@mind-diary/domain";
export {
  RESERVED_TOP_LEVEL_HANDLES,
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  normalizeSpaceHandle,
  parseCanonicalSpaceHandle,
  verifiedSpaceHost,
  type CanonicalSpaceHandle,
  type HandlePolicyFailureReason,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";

export interface Clock {
  now(): UtcInstant;
}

export interface MetadataStore {
  readonly kind: "metadata-store";
}

export interface HandleReservationSnapshot {
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
  readonly spaceId: SpaceId;
}

export interface RetiredHandleMarker {
  readonly host: VerifiedSpaceHost;
  readonly canonicalHandle: CanonicalSpaceHandle;
}

export interface HandleReservationRequest {
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
  readonly spaceId: SpaceId;
}

export type HandleReservationResult =
  | {
      readonly kind: "reserved";
      readonly reservation: Readonly<HandleReservationSnapshot>;
      readonly replayed: boolean;
    }
  | { readonly kind: "handle_unavailable" }
  | { readonly kind: "immutable_handle" }
  | {
      readonly kind: "invalid_handle";
      readonly reason: HandlePolicyFailureReason;
    };

export interface HandleResolutionRequest {
  readonly host: VerifiedSpaceHost;
  readonly handle: string;
}

export type HandleResolutionResult =
  | { readonly kind: "resolved"; readonly spaceId: SpaceId }
  | { readonly kind: "not_found" };

export interface HandleRetirementRequest extends HandleResolutionRequest {
  readonly spaceId: SpaceId;
}

export type HandleRetirementResult =
  | {
      readonly kind: "retired";
      readonly marker: Readonly<RetiredHandleMarker>;
    }
  | { readonly kind: "not_found" };

/** Transactional host-scoped handle ownership and permanent retirement. */
export interface HandleRegistry extends MetadataStore {
  reserveHandle(request: HandleReservationRequest): Promise<HandleReservationResult>;
  resolveHandle(request: HandleResolutionRequest): Promise<HandleResolutionResult>;
  retireHandle(request: HandleRetirementRequest): Promise<HandleRetirementResult>;
}

export interface ImmutableObjectWriteRequest {
  readonly bytes: Uint8Array;
  readonly mediaType: MarkdownMediaType;
  /** Server-supplied UTC time used only for bounded unreachable-object GC. */
  readonly createdAt: UtcInstant;
}

export interface ImmutableObjectMetadata {
  readonly sha256: Sha256Digest;
  readonly mediaType: MarkdownMediaType;
  readonly size: number;
  readonly createdAt: UtcInstant;
  /** Mutable GC lease metadata; canonical bytes and digest remain immutable. */
  readonly protectedAt: UtcInstant;
}

export interface ImmutableObject extends ImmutableObjectMetadata {
  readonly bytes: Uint8Array;
}

export interface ImmutableObjectPutResult {
  readonly object: Readonly<ImmutableObjectMetadata>;
  readonly status: "stored" | "already_exists";
}

export interface ImmutableObjectListRequest {
  /** Only objects whose GC protection is strictly older are candidates. */
  readonly createdBefore: UtcInstant;
  /** Reachable digests are excluded before applying limit, preventing starvation. */
  readonly excludedDigests: readonly Sha256Digest[];
  readonly limit: number;
}

export interface ImmutableObjectDeleteRequest {
  readonly sha256: Sha256Digest;
  /** Candidate lease observed by list; a concurrent put changes it. */
  readonly expectedProtectedAt: UtcInstant;
  /** The delete is refused when current protection is at or after this boundary. */
  readonly createdBefore: UtcInstant;
}

export type ObjectStoreFailureCode =
  | "invalid_digest"
  | "invalid_media_type"
  | "invalid_utf8"
  | "invalid_timestamp"
  | "invalid_limit"
  | "digest_collision"
  | "object_tampered";

/** Stable port-level failure used without coupling application code to an adapter. */
export class ObjectStoreFailure extends Error {
  readonly code: ObjectStoreFailureCode;

  constructor(code: ObjectStoreFailureCode, message: string) {
    super(message);
    this.name = "ObjectStoreFailure";
    this.code = code;
  }
}

export interface ObjectStore {
  readonly kind: "object-store";
  calculateSha256(bytes: Uint8Array): Promise<Sha256Digest>;
  putImmutable(request: ImmutableObjectWriteRequest): Promise<ImmutableObjectPutResult>;
  getImmutable(sha256: Sha256Digest): Promise<Readonly<ImmutableObject> | null>;
  listImmutableObjects(
    request: ImmutableObjectListRequest,
  ): Promise<readonly Readonly<ImmutableObjectMetadata>[]>;
  deleteImmutableObject(request: ImmutableObjectDeleteRequest): Promise<boolean>;
}

export type RevisionCommitResult =
  | {
      readonly kind: "committed";
      readonly envelope: Readonly<CanonicalRevisionEnvelope>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "stale_head";
      readonly currentHeadRevisionId: RevisionId | null;
    }
  | { readonly kind: "revision_id_collision" }
  | {
      readonly kind: "invalid_revision_chain";
      readonly reason:
        | "missing_parent"
        | "parent_mismatch"
        | "revision_number_mismatch"
        | "manifest_hash_mismatch";
    };

export interface RevisionCommitRequest {
  readonly expectedHeadRevisionId: RevisionId | null;
  readonly envelope: Readonly<CanonicalRevisionEnvelope>;
}

/** Transactional revision metadata and HEAD; object bytes remain in ObjectStore. */
export interface RevisionMetadataStore extends MetadataStore {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  listRevisions(
    spaceId: SpaceId,
  ): Promise<readonly Readonly<CanonicalRevisionEnvelope>[]>;
  commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult>;
  /** Includes every historical revision, not only each Mind's current HEAD. */
  listReachableObjectDigests(): Promise<readonly Sha256Digest[]>;
}

export interface SearchIndex {
  readonly kind: "search-index";
}

export interface CurrentAuthorizationMembership {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly role: Role;
  readonly state: MembershipState;
  readonly version: Version;
}

export interface CurrentAuthorizationToken {
  readonly tokenId: TokenId;
  readonly principalId: PrincipalId;
  readonly state: AccessTokenState;
  readonly scopes: EffectiveTokenScopes;
  readonly version: Version;
  readonly expiresAt: UtcInstant;
}

/**
 * Minimal trusted state required for one authorization decision. Implementations
 * must produce a fresh immutable snapshot for every read.
 */
export interface CurrentAuthorizationState {
  readonly principal: {
    readonly principalId: PrincipalId;
    readonly state: PrincipalState;
  };
  readonly space: {
    readonly spaceId: SpaceId;
    readonly state: SpaceLifecycleState;
    readonly visibility: Visibility;
    readonly accessVersion: Version;
  };
  readonly membership: CurrentAuthorizationMembership | null;
  readonly token: Readonly<CurrentAuthorizationToken> | null;
}

export interface AuthorizationStateQuery {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly tokenId: TokenId | null;
}

export interface AuthorizationStateReader {
  readCurrentAuthorizationState(
    query: AuthorizationStateQuery,
  ): Promise<CurrentAuthorizationState | null>;
}

/** A state reader whose reads participate in the caller's metadata transaction. */
export interface AuthorizationTransaction extends AuthorizationStateReader {
  readonly kind: "authorization-transaction";
}

export interface AuthorizationRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly capability: Capability;
  readonly revisionMode: RevisionMode;
}

export interface AuthorizationStamp {
  readonly accessVersion: Version;
  readonly membershipVersion: Version | null;
  readonly tokenVersion: Version | null;
}

export type AuthorizationGrant =
  | { readonly kind: "membership"; readonly role: Role }
  | {
      readonly kind: "baseline_visibility";
      readonly visibility: "public" | "unlisted";
    };

export type AuthorizationDenialCode =
  | "authentication_required"
  | "invalid_authorization_request"
  | "authorization_state_unavailable"
  | "token_inactive"
  | "access_denied"
  | "capability_denied"
  | "insufficient_scope"
  | "deployment_capability_disabled"
  | "historical_read_only"
  | "authorization_state_changed";

export type AuthorizationDecision =
  | {
      readonly kind: "allowed";
      readonly capability: Capability;
      readonly grant: AuthorizationGrant;
      readonly stamp: AuthorizationStamp;
    }
  | {
      readonly kind: "denied";
      readonly code: AuthorizationDenialCode;
      readonly retryable: boolean;
    };

export interface Authorizer {
  /** Must complete before any target metadata, object, or index read. */
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;

  /**
   * Re-reads authorization state inside a race-sensitive metadata transaction.
   * A changed-but-still-allowed state forces a retry instead of using a stale
   * preflight decision.
   */
  reauthorizeInTransaction(
    request: AuthorizationRequest,
    transaction: AuthorizationTransaction,
    expected: AuthorizationStamp,
  ): Promise<AuthorizationDecision>;
}

export interface AuthorizedHandleReadRequest extends HandleResolutionRequest {
  readonly actor: ActorContext;
  readonly capability: Capability;
  readonly revisionMode: RevisionMode;
}

/** Reads target metadata/objects only after exact handle resolution and access. */
export interface ResolvedSpaceReader<Value> {
  readResolvedSpace(spaceId: SpaceId): Promise<Value | null>;
}

export type AuthorizedHandleReadResult<Value> =
  | {
      readonly kind: "found";
      readonly spaceId: SpaceId;
      readonly value: Value;
    }
  | { readonly kind: "not_found" };

const HANDLE_TARGET_NOT_FOUND = Object.freeze({ kind: "not_found" } as const);

/**
 * Keeps missing handles and access denial externally indistinguishable while
 * enforcing resolve -> authorize -> target read ordering.
 */
export class AuthorizedHandleReader<Value> {
  readonly #handles: HandleRegistry;
  readonly #authorizer: Authorizer;
  readonly #targets: ResolvedSpaceReader<Value>;

  constructor(dependencies: {
    readonly handles: HandleRegistry;
    readonly authorizer: Authorizer;
    readonly targets: ResolvedSpaceReader<Value>;
  }) {
    this.#handles = dependencies.handles;
    this.#authorizer = dependencies.authorizer;
    this.#targets = dependencies.targets;
  }

  async read(
    request: AuthorizedHandleReadRequest,
  ): Promise<AuthorizedHandleReadResult<Value>> {
    const resolution = await this.#handles.resolveHandle({
      host: request.host,
      handle: request.handle,
    });
    if (resolution.kind === "not_found") return HANDLE_TARGET_NOT_FOUND;

    const authorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: resolution.spaceId,
      capability: request.capability,
      revisionMode: request.revisionMode,
    });
    if (authorization.kind === "denied") return HANDLE_TARGET_NOT_FOUND;

    const value = await this.#targets.readResolvedSpace(resolution.spaceId);
    if (value === null) return HANDLE_TARGET_NOT_FOUND;
    return Object.freeze({
      kind: "found",
      spaceId: resolution.spaceId,
      value,
    });
  }
}

function denied(
  code: AuthorizationDenialCode,
  retryable = false,
): AuthorizationDecision {
  return Object.freeze({ kind: "denied", code, retryable });
}

function isRegisteredActor(
  actor: unknown,
): actor is Extract<ActorContext, { kind: "registered_principal" }> {
  return isRecord(actor) && actor.kind === "registered_principal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isKnownCapability(capability: unknown): capability is Capability {
  return (
    typeof capability === "string" &&
    (CAPABILITIES as readonly string[]).includes(capability)
  );
}

function isValidRevisionMode(mode: unknown): mode is RevisionMode {
  return mode === "head" || mode === "historical";
}

function isValidVersion(value: unknown): value is Version {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isValidTokenScopes(value: unknown): value is EffectiveTokenScopes {
  if (!Array.isArray(value)) return false;
  return (
    (value.length === 1 && value[0] === "content:read") ||
    (value.length === 2 &&
      value[0] === "content:read" &&
      value[1] === "content:write")
  );
}

function isValidMembership(
  value: unknown,
): value is CurrentAuthorizationMembership | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.principalId === "string" &&
    typeof value.spaceId === "string" &&
    isOneOf(value.role, ROLES) &&
    isOneOf(value.state, MEMBERSHIP_STATES) &&
    isValidVersion(value.version)
  );
}

function isValidToken(
  value: unknown,
): value is Readonly<CurrentAuthorizationToken> | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.tokenId === "string" &&
    typeof value.principalId === "string" &&
    isOneOf(value.state, ACCESS_TOKEN_STATES) &&
    isValidTokenScopes(value.scopes) &&
    isValidVersion(value.version) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

function isValidCurrentAuthorizationState(
  value: unknown,
): value is CurrentAuthorizationState {
  if (!isRecord(value) || !isRecord(value.principal) || !isRecord(value.space)) {
    return false;
  }
  return (
    typeof value.principal.principalId === "string" &&
    isOneOf(value.principal.state, PRINCIPAL_STATES) &&
    typeof value.space.spaceId === "string" &&
    isOneOf(value.space.state, SPACE_LIFECYCLE_STATES) &&
    isOneOf(value.space.visibility, VISIBILITIES) &&
    isValidVersion(value.space.accessVersion) &&
    isValidMembership(value.membership) &&
    isValidToken(value.token)
  );
}

function sameStamp(left: AuthorizationStamp, right: AuthorizationStamp): boolean {
  return (
    left.accessVersion === right.accessVersion &&
    left.membershipVersion === right.membershipVersion &&
    left.tokenVersion === right.tokenVersion
  );
}

function isExpired(expiresAt: UtcInstant, occurredAt: UtcInstant): boolean | null {
  const expiry = Date.parse(expiresAt);
  const current = Date.parse(occurredAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(current)) return null;
  return expiry <= current;
}

export class CapabilityAuthorizer implements Authorizer {
  readonly #states: AuthorizationStateReader;

  constructor(states: AuthorizationStateReader) {
    this.#states = states;
  }

  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    return this.#authorizeWith(this.#states, request);
  }

  async reauthorizeInTransaction(
    request: AuthorizationRequest,
    transaction: AuthorizationTransaction,
    expected: AuthorizationStamp,
  ): Promise<AuthorizationDecision> {
    const decision = await this.#authorizeWith(transaction, request);
    if (decision.kind === "denied") return decision;
    if (!sameStamp(decision.stamp, expected)) {
      return denied("authorization_state_changed", true);
    }
    return decision;
  }

  async #authorizeWith(
    states: AuthorizationStateReader,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    if (!isRegisteredActor(request.actor)) {
      return denied("authentication_required");
    }
    if (
      !isKnownCapability(request.capability) ||
      !isValidRevisionMode(request.revisionMode) ||
      !Array.isArray(request.actor.deploymentCapabilities) ||
      !request.actor.deploymentCapabilities.every(isKnownCapability)
    ) {
      return denied("invalid_authorization_request");
    }

    const authentication = request.actor.authentication;
    if (
      authentication.kind !== "sites_identity" &&
      authentication.kind !== "mcp_token"
    ) {
      return denied("authentication_required");
    }
    const tokenId =
      authentication.kind === "mcp_token" ? authentication.tokenId : null;
    const state = await states.readCurrentAuthorizationState({
      principalId: request.actor.principalId,
      spaceId: request.spaceId,
      tokenId,
    });
    if (!isValidCurrentAuthorizationState(state)) {
      return denied("authorization_state_unavailable");
    }
    if (
      state.principal.principalId !== request.actor.principalId ||
      state.space.spaceId !== request.spaceId ||
      state.principal.state !== "active" ||
      state.space.state !== "active"
    ) {
      return denied("authorization_state_unavailable");
    }

    let tokenVersion: Version | null = null;
    if (authentication.kind === "mcp_token") {
      const token = state.token;
      const expired = token
        ? isExpired(token.expiresAt, request.actor.occurredAtUtc)
        : null;
      if (
        token === null ||
        token.tokenId !== authentication.tokenId ||
        token.principalId !== request.actor.principalId ||
        token.state !== "active" ||
        expired !== false
      ) {
        return token !== null && expired === null
          ? denied("invalid_authorization_request")
          : denied("token_inactive");
      }
      tokenVersion = token.version;
    }

    const membership = state.membership;
    const hasMatchingMembership =
      membership !== null &&
      membership.principalId === request.actor.principalId &&
      membership.spaceId === request.spaceId;
    if (membership !== null && !hasMatchingMembership) {
      return denied("authorization_state_unavailable");
    }

    let grant: AuthorizationGrant;
    let grantedCapabilities: readonly Capability[];
    let membershipVersion: Version | null = null;
    if (hasMatchingMembership && membership.state === "active") {
      grant = Object.freeze({ kind: "membership", role: membership.role });
      grantedCapabilities = capabilitiesForRole(membership.role);
      membershipVersion = membership.version;
    } else {
      const baselineCapabilities = capabilitiesForVisibilityGrant(
        state.space.visibility,
      );
      if (baselineCapabilities.length === 0) return denied("access_denied");
      grant = Object.freeze({
        kind: "baseline_visibility",
        visibility: state.space.visibility,
      }) as AuthorizationGrant;
      grantedCapabilities = baselineCapabilities;
    }

    if (!grantedCapabilities.includes(request.capability)) {
      return denied("capability_denied");
    }
    if (
      authentication.kind === "mcp_token" &&
      !tokenScopesAllowCapability(state.token!.scopes, request.capability)
    ) {
      return denied("insufficient_scope");
    }
    if (!request.actor.deploymentCapabilities.includes(request.capability)) {
      return denied("deployment_capability_disabled");
    }
    if (!revisionModeAllowsCapability(request.revisionMode, request.capability)) {
      return denied("historical_read_only");
    }

    return Object.freeze({
      kind: "allowed",
      capability: request.capability,
      grant,
      stamp: Object.freeze({
        accessVersion: state.space.accessVersion,
        membershipVersion,
        tokenVersion,
      }),
    });
  }
}

export interface TokenHasher {
  readonly kind: "token-hasher";
}

export interface AuditSink {
  readonly kind: "audit-sink";
}
