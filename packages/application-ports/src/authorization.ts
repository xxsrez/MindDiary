import type {
  ActorContext,
  RequestId,
} from "@mind-diary/application-contracts";

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
  type AuditEventId,
  type BindingVersion,
  type Capability,
  type CredentialWriteTargetState,
  type EffectiveTokenScopes,
  type MindBindingOwnerId,
  type MindBindingSet,
  type MembershipState,
  type IdempotencyKey,
  type PrincipalId,
  type OutboxMessageId,
  type PrincipalState,
  type ReadMindBinding,
  type ReadMindBindingId,
  type RevisionMode,
  type Role,
  type Sha256Digest,
  type SpaceId,
  type SpaceLifecycleState,
  type TokenId,
  type UtcInstant,
  type Version,
  type Visibility,
  type WriteMindBinding,
  type WriteMindBindingId,
} from "@mind-diary/domain";

import {
  type MetadataStore,
} from "./runtime.js";

import {
  type HandleResolutionRequest,
  type HandleRegistry,
} from "./control.js";

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

/**
 * Optional batch form for read-only authorization projections.  Adapters may
 * resolve a page of states from one refreshed metadata view; callers must keep
 * query order and must still treat every returned state as a current,
 * fail-closed snapshot.
 */
export interface BatchAuthorizationStateReader extends AuthorizationStateReader {
  readCurrentAuthorizationStates(
    queries: readonly AuthorizationStateQuery[],
  ): Promise<readonly (Readonly<CurrentAuthorizationState> | null)[]>;
}

/** A state reader whose reads participate in the caller's metadata transaction. */
export interface AuthorizationTransaction extends AuthorizationStateReader {
  readonly kind: "authorization-transaction";
  /** Optional binding snapshot available to binding-aware content transactions. */
  readMindBindingSet?(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<MindBindingSetSnapshot> | null>;
  /** Credential profile snapshot from this exact transaction/read-session. */
  readCredentialWriteTarget?(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
  ): Promise<Readonly<CredentialContentAccessProfileSnapshot> | null>;
}

export type CredentialContentAccessProfileSnapshot =
  | {
      readonly kind: "current";
      readonly state: Readonly<CredentialWriteTargetState>;
    }
  | { readonly kind: "pending_upgrade" };

export interface MindBindingSetSnapshot {
  readonly bindingSet: Readonly<MindBindingSet>;
  readonly readBindings: readonly Readonly<ReadMindBinding>[];
  readonly writeBinding: Readonly<WriteMindBinding> | null;
}

interface MindBindingMutationRequestBase {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly expectedBindingVersion: BindingVersion;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export type ApplyReadMindBindingRequest =
  | (MindBindingMutationRequestBase & {
      readonly action: "attach";
      readonly spaceId: SpaceId;
      readonly readBindingId: ReadMindBindingId;
    })
  | (MindBindingMutationRequestBase & {
      readonly action: "detach";
      readonly spaceId: SpaceId;
      readonly readBindingId: null;
    });

export type ApplyWriteMindBindingRequest =
  | (MindBindingMutationRequestBase & {
      readonly action: "bind";
      readonly spaceId: SpaceId;
      readonly writeBindingId: WriteMindBindingId;
    })
  | (MindBindingMutationRequestBase & {
      readonly action: "unbind";
      readonly spaceId: null;
      readonly writeBindingId: null;
    });

export type ApplyAutomaticCapturePolicyRequest =
  | (MindBindingMutationRequestBase & {
      readonly action: "enable";
      readonly spaceId: SpaceId;
      readonly writeBindingId: WriteMindBindingId;
      readonly mode: "routine_non_sensitive";
    })
  | (MindBindingMutationRequestBase & {
      readonly action: "disable";
      readonly spaceId: SpaceId | null;
      readonly writeBindingId: null;
      readonly mode: "disabled";
    });

export type ApplyMindBindingMutationResult =
  | {
      readonly kind: "applied";
      readonly bindings: Readonly<MindBindingSetSnapshot>;
      readonly previousWriteBinding: Readonly<WriteMindBinding> | null;
      readonly changed: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "binding_version_conflict";
      readonly currentBindingVersion: BindingVersion;
    }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "binding_owner_revoked" }
  | { readonly kind: "owner_mismatch" | "effect_conflict" | "invalid_record" };

export interface RevokeMindBindingOwnerRequest {
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export type RevokeMindBindingOwnerResult =
  | {
      readonly kind: "revoked";
      readonly invalidatedReadBindings: number;
      readonly invalidatedWriteBindings: number;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "not_found"
        | "owner_mismatch"
        | "effect_conflict"
        | "invalid_record";
    };

/** Atomic binding mutation plus fresh authorization transaction. */
export interface MindBindingTransaction extends AuthorizationTransaction {
  readMindBindingSet(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<MindBindingSetSnapshot> | null>;
  applyReadMindBinding(
    request: Readonly<ApplyReadMindBindingRequest>,
  ): Promise<ApplyMindBindingMutationResult>;
  applyWriteMindBinding(
    request: Readonly<ApplyWriteMindBindingRequest>,
  ): Promise<ApplyMindBindingMutationResult>;
  applyAutomaticCapturePolicy(
    request: Readonly<ApplyAutomaticCapturePolicyRequest>,
  ): Promise<ApplyMindBindingMutationResult>;
}

export interface MindBindingStore
  extends MetadataStore,
    AuthorizationStateReader {
  readMindBindingSet(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<MindBindingSetSnapshot> | null>;
  runMindBindingTransaction<Result>(
    operation: (transaction: MindBindingTransaction) => Promise<Result>,
  ): Promise<Result>;
  revokeMindBindingOwner(
    request: Readonly<RevokeMindBindingOwnerRequest>,
  ): Promise<RevokeMindBindingOwnerResult>;
}

export interface AuthorizationRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly capability: Capability;
  readonly revisionMode: RevisionMode;
  /** Exact immutable generation required by a binding-aware write boundary. */
  readonly bindingRequirement?:
    | { readonly kind: "read" }
    | {
      readonly kind: "write";
      readonly writeBindingId: WriteMindBindingId;
    }
    | {
        readonly kind: "automatic_capture";
        readonly writeBindingId: WriteMindBindingId;
        readonly expectedBindingVersion: BindingVersion;
      };
}

export interface AuthorizationStamp {
  readonly accessVersion: Version;
  readonly membershipVersion: Version | null;
  readonly tokenVersion: Version | null;
  /** Present only on the MCP binding-aware content boundary. */
  readonly bindingVersion?: BindingVersion;
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
  | "authorization_state_changed"
  | "credential_access_upgrade_required"
  | "writable_mind_required"
  | "writable_mind_stale"
  | "mind_binding_required"
  | "write_binding_required"
  | "write_binding_stale"
  | "binding_owner_revoked"
  | "binding_state_unavailable";

/** Credential-wide MCP compatibility gate evaluated before any Mind lookup. */
export type CredentialContentAccessDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "denied";
      readonly code:
        | "authentication_required"
        | "credential_access_upgrade_required"
        | "binding_owner_revoked"
        | "binding_state_unavailable";
      readonly retryable: boolean;
    };

export interface CredentialContentAccessAuthorizer {
  /** Must complete before discovery metadata, canonical objects, or indexes. */
  authorizeCredentialContentAccess(
    actor: ActorContext,
  ): Promise<CredentialContentAccessDecision>;
}

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

export interface BackgroundAuthorizationRequest {
  readonly actor: ActorContext;
  /** Durable principal identity captured by the originating command. */
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly capability: Capability;
  readonly revisionMode: RevisionMode;
}

export interface BackgroundAuthorizer {
  /**
   * Rebuilds authority from trusted deployment context and current metadata.
   * Serialized token, role, membership and visibility claims are not inputs.
   */
  authorize(
    request: BackgroundAuthorizationRequest,
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

  /** One current-state read for a closed capability set on the same target. */
  async authorizeCapabilities(request: {
    readonly actor: ActorContext;
    readonly spaceId: SpaceId;
    readonly capabilities: readonly Capability[];
    readonly revisionMode: RevisionMode;
  }): Promise<readonly AuthorizationDecision[]> {
    const registered = isRegisteredActor(request.actor) ? request.actor : null;
    const authentication = registered?.authentication ?? null;
    const canReadOnce =
      authentication !== null &&
      (authentication.kind === "sites_identity" || authentication.kind === "mcp_token") &&
      request.capabilities.every(isKnownCapability) &&
      isValidRevisionMode(request.revisionMode) &&
      registered !== null &&
      Array.isArray(registered.deploymentCapabilities) &&
      registered.deploymentCapabilities.every(isKnownCapability);
    const currentState = canReadOnce
      ? this.#states.readCurrentAuthorizationState({
          principalId: registered!.principalId,
          spaceId: request.spaceId,
          tokenId:
            authentication.kind === "mcp_token" ? authentication.tokenId : null,
        })
      : undefined;
    return Object.freeze(
      await Promise.all(
        request.capabilities.map((capability) =>
          this.#authorizeWith(
            this.#states,
            {
              actor: request.actor,
              spaceId: request.spaceId,
              capability,
              revisionMode: request.revisionMode,
            },
            currentState,
          )),
      ),
    );
  }

  /**
   * Evaluates a closed capability set against a caller-supplied state that was
   * read in a batch projection.  The same validation and capability rules as
   * `authorizeCapabilities` apply; the supplied state is never trusted as a
   * role or scope claim and is only used as the already-read current snapshot.
   */
  async authorizeCapabilitiesFromState(
    request: {
      readonly actor: ActorContext;
      readonly spaceId: SpaceId;
      readonly capabilities: readonly Capability[];
      readonly revisionMode: RevisionMode;
    },
    currentState: Readonly<CurrentAuthorizationState> | null,
  ): Promise<readonly AuthorizationDecision[]> {
    return Object.freeze(
      await Promise.all(
        request.capabilities.map((capability) =>
          this.#authorizeWith(
            this.#states,
            {
              actor: request.actor,
              spaceId: request.spaceId,
              capability,
              revisionMode: request.revisionMode,
            },
            Promise.resolve(currentState),
          ),
        ),
      ),
    );
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
    currentState?: Promise<Readonly<CurrentAuthorizationState> | null>,
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
    const state = await (currentState ?? states.readCurrentAuthorizationState({
      principalId: request.actor.principalId,
      spaceId: request.spaceId,
      tokenId,
    }));
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

/** Current-access authorizer for trusted workers acting for a captured principal. */
export class CurrentAccessBackgroundAuthorizer implements BackgroundAuthorizer {
  readonly #states: AuthorizationStateReader;

  constructor(states: AuthorizationStateReader) {
    this.#states = states;
  }

  async authorize(
    request: BackgroundAuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    if (
      request.actor.kind !== "service" ||
      typeof request.actor.serviceId !== "string" ||
      request.actor.serviceId.length === 0
    ) {
      return denied("authentication_required");
    }
    if (
      !isKnownCapability(request.capability) ||
      !isValidRevisionMode(request.revisionMode)
    ) {
      return denied("invalid_authorization_request");
    }
    if (!request.actor.deploymentCapabilities.includes(request.capability)) {
      return denied("deployment_capability_disabled");
    }
    if (!revisionModeAllowsCapability(request.revisionMode, request.capability)) {
      return denied("historical_read_only");
    }

    const state = await this.#states.readCurrentAuthorizationState({
      principalId: request.principalId,
      spaceId: request.spaceId,
      tokenId: null,
    });
    if (
      !isValidCurrentAuthorizationState(state) ||
      state.principal.principalId !== request.principalId ||
      state.space.spaceId !== request.spaceId ||
      state.principal.state !== "active" ||
      state.space.state !== "active"
    ) {
      return denied("authorization_state_unavailable");
    }

    const membership = state.membership;
    if (
      membership !== null &&
      (membership.principalId !== request.principalId ||
        membership.spaceId !== request.spaceId)
    ) {
      return denied("authorization_state_unavailable");
    }
    let grant: AuthorizationGrant;
    let grantedCapabilities: readonly Capability[];
    let membershipVersion: Version | null = null;
    if (
      membership !== null &&
      membership.principalId === request.principalId &&
      membership.spaceId === request.spaceId &&
      membership.state === "active"
    ) {
      grant = Object.freeze({ kind: "membership", role: membership.role });
      grantedCapabilities = capabilitiesForRole(membership.role);
      membershipVersion = membership.version;
    } else {
      grantedCapabilities = capabilitiesForVisibilityGrant(state.space.visibility);
      if (grantedCapabilities.length === 0) return denied("access_denied");
      grant = Object.freeze({
        kind: "baseline_visibility",
        visibility: state.space.visibility,
      }) as AuthorizationGrant;
    }
    if (!grantedCapabilities.includes(request.capability)) {
      return denied("capability_denied");
    }
    return Object.freeze({
      kind: "allowed",
      capability: request.capability,
      grant,
      stamp: Object.freeze({
        accessVersion: state.space.accessVersion,
        membershipVersion,
        tokenVersion: null,
      }),
    });
  }
}
