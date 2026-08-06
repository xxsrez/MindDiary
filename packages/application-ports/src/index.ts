import type { ActorContext } from "@mind-diary/application-contracts";
import {
  CAPABILITIES,
  capabilitiesForRole,
  capabilitiesForVisibilityGrant,
  revisionModeAllowsCapability,
  tokenScopesAllowCapability,
  type AccessTokenState,
  type Capability,
  type EffectiveTokenScopes,
  type MembershipState,
  type PrincipalId,
  type PrincipalState,
  type RevisionMode,
  type Role,
  type SpaceId,
  type SpaceLifecycleState,
  type TokenId,
  type UtcInstant,
  type Version,
  type Visibility,
} from "@mind-diary/domain";

export interface Clock {
  now(): UtcInstant;
}

export interface MetadataStore {
  readonly kind: "metadata-store";
}

export interface ObjectStore {
  readonly kind: "object-store";
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

function denied(
  code: AuthorizationDenialCode,
  retryable = false,
): AuthorizationDecision {
  return Object.freeze({ kind: "denied", code, retryable });
}

function isRegisteredActor(
  actor: ActorContext,
): actor is Extract<ActorContext, { kind: "registered_principal" }> {
  return actor.kind === "registered_principal";
}

function isKnownCapability(capability: Capability): boolean {
  return (CAPABILITIES as readonly string[]).includes(capability);
}

function isValidRevisionMode(mode: RevisionMode): boolean {
  return mode === "head" || mode === "historical";
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
    if (state === null) return denied("authorization_state_unavailable");
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
