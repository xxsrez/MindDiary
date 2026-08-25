import {
  type AccessTokenState,
  type EffectiveTokenScopes,
  type PersonalTokenRef,
  type PrincipalId,
  type TokenId,
  type UtcInstant,
  type Version,
} from "@mind-diary/domain";

import {
  type MetadataStore,
} from "./runtime.js";

import {
  type CurrentAuthorizationToken,
} from "./authorization.js";

declare const tokenVerifierBrand: unique symbol;

/** Fixed-length, versioned cryptographic verifier. It is never a public token ID. */
export type TokenVerifier = string & {
  readonly [tokenVerifierBrand]: "TokenVerifier";
};

export interface PersistedTokenSecretMaterial {
  readonly format: "mdp_v1";
  readonly algorithm: "hmac-sha256";
  readonly verifierVersion: "v1";
  readonly verifier: TokenVerifier;
  readonly displayPrefix: string;
}

/**
 * Secret-bearing issuance boundary. Implementations expose the secret through
 * exactly one consume call and keep it out of enumerable/serializable fields.
 */
export interface IssuedTokenSecret {
  readonly displayPrefix: string;
  consumeSecret(): string | null;
  persistence(): Readonly<PersistedTokenSecretMaterial>;
}

export type TokenVerifierLookupResult<Value> =
  | {
      readonly kind: "found";
      readonly verifier: TokenVerifier;
      readonly value: Value;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" };

/** Exact indexed lookup; displayPrefix must never be used as the lookup key. */
export interface TokenVerifierLookup<Value> {
  findByVerifier(
    verifier: TokenVerifier,
  ): Promise<TokenVerifierLookupResult<Value>>;
}

export type TokenVerificationResult<Value> =
  | { readonly kind: "verified"; readonly value: Value }
  | { readonly kind: "invalid" };

export interface TokenHasher {
  readonly kind: "token-hasher";
  issueSecret(): Promise<IssuedTokenSecret>;
  verifySecret<Value>(
    candidate: unknown,
    lookup: TokenVerifierLookup<Value>,
  ): Promise<TokenVerificationResult<Value>>;
}

/** Safe lifecycle metadata. The cryptographic verifier is deliberately absent. */
export interface McpTokenMetadata {
  readonly tokenId: TokenId;
  readonly personalTokenRef: PersonalTokenRef | null;
  readonly principalId: PrincipalId;
  readonly name: string;
  readonly displayPrefix: string;
  readonly scopes: EffectiveTokenScopes;
  readonly state: AccessTokenState;
  readonly version: Version;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly lastUsedAt: UtcInstant | null;
  readonly revokedAt: UtcInstant | null;
}

export interface CreateMcpTokenRequest {
  readonly tokenId: TokenId;
  readonly personalTokenRef?: PersonalTokenRef;
  readonly principalId: PrincipalId;
  readonly name: string;
  readonly verifier: TokenVerifier;
  readonly displayPrefix: string;
  readonly scopes: EffectiveTokenScopes;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export type CreateMcpTokenResult =
  | {
      readonly kind: "created";
      readonly token: Readonly<McpTokenMetadata>;
    }
  | {
      readonly kind:
        | "token_id_conflict"
        | "verifier_conflict"
        | "principal_deleted"
        | "invalid_record";
    };

export interface RevokeMcpTokenRequest {
  readonly principalId: PrincipalId;
  readonly tokenId: TokenId;
  readonly revokedAt: UtcInstant;
}

export type RevokeMcpTokenResult =
  | {
      readonly kind: "revoked";
      readonly token: Readonly<McpTokenMetadata>;
      readonly replayed: boolean;
    }
  | { readonly kind: "not_found" };

export interface RevokePrincipalTokensForAccountDeletionRequest {
  readonly principalId: PrincipalId;
  readonly revokedAt: UtcInstant;
}

export interface RevokePrincipalTokensForAccountDeletionResult {
  readonly revokedCount: number;
  readonly replayed: boolean;
}

/** Safe exact token-table state used to bind an account deletion preview. */
export interface PrincipalTokenDeletionSnapshot {
  readonly principalId: PrincipalId;
  readonly activeTokenCount: number;
  readonly stateFingerprint: string;
}

export interface BeginPrincipalTokenDeletionRequest {
  readonly principalId: PrincipalId;
  readonly expectedStateFingerprint: string;
  readonly occurredAt: UtcInstant;
}

export type BeginPrincipalTokenDeletionResult =
  | { readonly kind: "reserved"; readonly replayed: boolean }
  | { readonly kind: "state_changed" | "principal_deleted" };

export interface CompletePrincipalTokenDeletionRequest {
  readonly principalId: PrincipalId;
  readonly expectedStateFingerprint: string;
  readonly revokedAt: UtcInstant;
}

export type CompletePrincipalTokenDeletionResult =
  | {
      readonly kind: "completed";
      readonly revokedCount: number;
      readonly replayed: boolean;
    }
  | { readonly kind: "reservation_not_found" | "state_changed" };

export interface CancelPrincipalTokenDeletionRequest {
  readonly principalId: PrincipalId;
  readonly expectedStateFingerprint: string;
}

/** Server-side generator; token IDs are never accepted from browser input. */
export interface TokenIdGenerator {
  nextTokenId(): TokenId;
}

export interface PersonalTokenRefGenerator {
  nextPersonalTokenRef(): PersonalTokenRef;
}

export type McpTokenPageState = "active" | "revoked" | "expired";

export interface McpTokenPagePosition {
  readonly createdAt: UtcInstant;
  readonly personalTokenRef: PersonalTokenRef;
}

export interface ListMcpTokenMetadataPageRequest {
  readonly principalId: PrincipalId;
  readonly state: McpTokenPageState;
  readonly asOf: UtcInstant;
  readonly limit: number;
  readonly upperBound?: McpTokenPagePosition;
  readonly after?: McpTokenPagePosition;
}

export interface McpTokenMetadataPage {
  readonly tokens: readonly Readonly<McpTokenMetadata>[];
  readonly upperBound: McpTokenPagePosition | null;
  readonly next: McpTokenPagePosition | null;
}

export interface AssignPersonalTokenRefRequest {
  readonly tokenId: TokenId;
  readonly personalTokenRef: PersonalTokenRef;
}

/**
 * Principal-scoped token persistence. Account deletion atomically prevents any
 * later issuance for that principal and revokes every existing token.
 */
export interface McpTokenStore
  extends MetadataStore,
    TokenVerifierLookup<Readonly<CurrentAuthorizationToken>> {
  createMcpToken(request: CreateMcpTokenRequest): Promise<CreateMcpTokenResult>;
  listMcpTokenMetadata(
    principalId: PrincipalId,
  ): Promise<readonly Readonly<McpTokenMetadata>[]>;
  listMcpTokenMetadataPage(
    request: ListMcpTokenMetadataPageRequest,
  ): Promise<Readonly<McpTokenMetadataPage>>;
  readMcpTokenMetadataByPresentationRef(
    principalId: PrincipalId,
    personalTokenRef: PersonalTokenRef,
  ): Promise<Readonly<McpTokenMetadata> | null>;
  listMcpTokensMissingPresentationRefs(): Promise<readonly TokenId[]>;
  assignPersonalTokenRefs(
    assignments: readonly AssignPersonalTokenRefRequest[],
  ): Promise<number>;
  readMcpTokenForAuthorization(
    tokenId: TokenId,
  ): Promise<Readonly<CurrentAuthorizationToken> | null>;
  revokeMcpToken(request: RevokeMcpTokenRequest): Promise<RevokeMcpTokenResult>;
  revokePrincipalTokensForAccountDeletion(
    request: RevokePrincipalTokensForAccountDeletionRequest,
  ): Promise<RevokePrincipalTokensForAccountDeletionResult>;
  readPrincipalTokenDeletionSnapshot(
    principalId: PrincipalId,
    occurredAt: UtcInstant,
  ): Promise<Readonly<PrincipalTokenDeletionSnapshot>>;
  beginPrincipalTokenDeletion(
    request: BeginPrincipalTokenDeletionRequest,
  ): Promise<BeginPrincipalTokenDeletionResult>;
  completePrincipalTokenDeletion(
    request: CompletePrincipalTokenDeletionRequest,
  ): Promise<CompletePrincipalTokenDeletionResult>;
  cancelPrincipalTokenDeletion(
    request: CancelPrincipalTokenDeletionRequest,
  ): Promise<boolean>;
}
