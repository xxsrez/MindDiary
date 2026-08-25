import type {
  AssignPersonalTokenRefRequest,
  BeginPrincipalTokenDeletionRequest,
  BeginPrincipalTokenDeletionResult,
  CancelPrincipalTokenDeletionRequest,
  CompletePrincipalTokenDeletionRequest,
  CompletePrincipalTokenDeletionResult,
  CreateMcpTokenRequest,
  CreateMcpTokenResult,
  CurrentAuthorizationToken,
  ListMcpTokenMetadataPageRequest,
  McpTokenMetadata,
  McpTokenMetadataPage,
  McpTokenStore,
  PrincipalTokenDeletionSnapshot,
  RevokeMcpTokenRequest,
  RevokeMcpTokenResult,
  RevokePrincipalTokensForAccountDeletionRequest,
  RevokePrincipalTokensForAccountDeletionResult,
  TokenVerifier,
} from "@mind-diary/application-ports";
import {
  version,
} from "@mind-diary/application-ports";
import {
  compareUnicodeScalarValues,
} from "./metadata-store-internals.js";

interface StoredMcpToken extends McpTokenMetadata {
  readonly verifier: TokenVerifier;
}

const TOKEN_VERIFIER_PATTERN = /^hmac-sha256:v1:[0-9a-f]{64}$/u;
const TOKEN_DISPLAY_PREFIX_PATTERN = /^mdp_v1_[A-Za-z0-9_-]{6}…$/u;
const PERSONAL_TOKEN_REF_PATTERN = /^ptok_v1_[0-9a-f]{32}$/u;
// OAuth access authorization mirrors share the authorization token table but
// are not user-managed personal tokens and must never receive presentation refs.
const OAUTH_ACCESS_RECORD_TOKEN_ID_PREFIX = "md_oauth_access_record_";

function isPersonalMcpToken(token: Pick<McpTokenMetadata, "tokenId">): boolean {
  return !String(token.tokenId).startsWith(OAUTH_ACCESS_RECORD_TOKEN_ID_PREFIX);
}

function validEffectiveScopes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    ((value.length === 1 && value[0] === "content:read") ||
      (value.length === 2 &&
        value[0] === "content:read" &&
        value[1] === "content:write"))
  );
}

function cloneTokenMetadata(
  token: Readonly<McpTokenMetadata>,
): Readonly<McpTokenMetadata> {
  return Object.freeze({
    tokenId: token.tokenId,
    personalTokenRef: token.personalTokenRef ?? null,
    principalId: token.principalId,
    name: token.name,
    displayPrefix: token.displayPrefix,
    scopes: Object.freeze([...token.scopes]) as McpTokenMetadata["scopes"],
    state: token.state,
    version: token.version,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
  });
}

function authorizationToken(
  token: Readonly<StoredMcpToken>,
): Readonly<CurrentAuthorizationToken> {
  return Object.freeze({
    tokenId: token.tokenId,
    principalId: token.principalId,
    state: token.state,
    scopes: Object.freeze([...token.scopes]) as CurrentAuthorizationToken["scopes"],
    version: token.version,
    expiresAt: token.expiresAt,
  });
}

function validTokenCreateRequest(request: CreateMcpTokenRequest): boolean {
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  return (
    typeof request.tokenId === "string" &&
    request.tokenId.length > 0 &&
    (request.personalTokenRef === undefined ||
      PERSONAL_TOKEN_REF_PATTERN.test(request.personalTokenRef)) &&
    typeof request.principalId === "string" &&
    request.principalId.length > 0 &&
    typeof request.name === "string" &&
    request.name.trim().length > 0 &&
    TOKEN_VERIFIER_PATTERN.test(request.verifier) &&
    TOKEN_DISPLAY_PREFIX_PATTERN.test(request.displayPrefix) &&
    validEffectiveScopes(request.scopes) &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > createdAt
  );
}

function principalTokenFingerprint(
  tokens: ReadonlyMap<McpTokenMetadata["tokenId"], Readonly<StoredMcpToken>>,
  principalId: McpTokenMetadata["principalId"],
): string {
  return JSON.stringify({
    format: "mind-diary-principal-token-deletion-v1",
    tokens: [...tokens.values()]
      .filter((token) => token.principalId === principalId)
      .sort((left, right) =>
        compareUnicodeScalarValues(left.tokenId, right.tokenId),
      )
      .map((token) => [
        token.tokenId,
        token.state,
        token.version,
        token.createdAt,
        token.expiresAt,
        token.revokedAt,
      ]),
  });
}

/** Deterministic transactional token adapter for local/unit execution. */
export class InMemoryMcpTokenStore implements McpTokenStore {
  readonly kind = "metadata-store" as const;
  readonly #tokensById = new Map<McpTokenMetadata["tokenId"], StoredMcpToken>();
  readonly #tokenIdByVerifier = new Map<TokenVerifier, McpTokenMetadata["tokenId"]>();
  readonly #tokenIdByPresentationRef = new Map<string, McpTokenMetadata["tokenId"]>();
  readonly #deletedPrincipals = new Set<McpTokenMetadata["principalId"]>();
  readonly #accountDeletionReservations = new Map<
    McpTokenMetadata["principalId"],
    string
  >();

  /** Trusted adapter checkpoint; callers must protect the serialized value. */
  exportDurableSnapshot(): unknown {
    return {
      v: 1,
      tokensById: new Map(this.#tokensById),
      tokenIdByVerifier: new Map(this.#tokenIdByVerifier),
      deletedPrincipals: new Set(this.#deletedPrincipals),
      accountDeletionReservations: new Map(this.#accountDeletionReservations),
    };
  }

  /** Restores a checkpoint produced by exportDurableSnapshot, failing closed on corruption. */
  static fromDurableSnapshot(value: unknown): InMemoryMcpTokenStore {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("MCP token durable snapshot is invalid");
    }
    const snapshot = value as Record<string, unknown>;
    if (
      snapshot.v !== 1 ||
      !(snapshot.tokensById instanceof Map) ||
      !(snapshot.tokenIdByVerifier instanceof Map) ||
      !(snapshot.deletedPrincipals instanceof Set) ||
      !(snapshot.accountDeletionReservations instanceof Map)
    ) {
      throw new TypeError("MCP token durable snapshot is invalid");
    }
    const restored = new InMemoryMcpTokenStore();
    for (const [key, item] of snapshot.tokensById) {
      const stored = Object.freeze({
        ...(item as StoredMcpToken),
        personalTokenRef:
          typeof (item as { personalTokenRef?: unknown }).personalTokenRef === "string" &&
          PERSONAL_TOKEN_REF_PATTERN.test(String((item as { personalTokenRef?: unknown }).personalTokenRef))
            ? (item as StoredMcpToken).personalTokenRef
            : null,
      }) as StoredMcpToken;
      restored.#tokensById.set(key as McpTokenMetadata["tokenId"], stored);
      if (stored.personalTokenRef !== null) {
        if (restored.#tokenIdByPresentationRef.has(stored.personalTokenRef)) {
          throw new TypeError("MCP token durable snapshot is invalid");
        }
        restored.#tokenIdByPresentationRef.set(stored.personalTokenRef, stored.tokenId);
      }
    }
    for (const [key, item] of snapshot.tokenIdByVerifier) {
      restored.#tokenIdByVerifier.set(
        key as TokenVerifier,
        item as McpTokenMetadata["tokenId"],
      );
    }
    for (const item of snapshot.deletedPrincipals) {
      restored.#deletedPrincipals.add(item as McpTokenMetadata["principalId"]);
    }
    for (const [key, item] of snapshot.accountDeletionReservations) {
      restored.#accountDeletionReservations.set(
        key as McpTokenMetadata["principalId"],
        item as string,
      );
    }
    return restored;
  }

  async createMcpToken(
    request: CreateMcpTokenRequest,
  ): Promise<CreateMcpTokenResult> {
    if (!validTokenCreateRequest(request)) {
      return Object.freeze({ kind: "invalid_record" });
    }
    if (
      this.#deletedPrincipals.has(request.principalId) ||
      this.#accountDeletionReservations.has(request.principalId)
    ) {
      return Object.freeze({ kind: "principal_deleted" });
    }
    if (this.#tokensById.has(request.tokenId)) {
      return Object.freeze({ kind: "token_id_conflict" });
    }
    if (this.#tokenIdByVerifier.has(request.verifier)) {
      return Object.freeze({ kind: "verifier_conflict" });
    }

    const stored = Object.freeze({
      tokenId: request.tokenId,
      personalTokenRef: request.personalTokenRef ?? null,
      principalId: request.principalId,
      name: request.name,
      verifier: request.verifier,
      displayPrefix: request.displayPrefix,
      scopes: Object.freeze([...request.scopes]) as McpTokenMetadata["scopes"],
      state: "active" as const,
      version: version(1),
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    // Adjacent synchronous mutations are the in-memory transaction boundary.
    this.#tokensById.set(stored.tokenId, stored);
    this.#tokenIdByVerifier.set(stored.verifier, stored.tokenId);
    if (stored.personalTokenRef !== null) {
      if (this.#tokenIdByPresentationRef.has(stored.personalTokenRef)) {
        this.#tokensById.delete(stored.tokenId);
        this.#tokenIdByVerifier.delete(stored.verifier);
        return Object.freeze({ kind: "token_id_conflict" });
      }
      this.#tokenIdByPresentationRef.set(stored.personalTokenRef, stored.tokenId);
    }
    return Object.freeze({
      kind: "created",
      token: cloneTokenMetadata(stored),
    });
  }

  async listMcpTokenMetadata(
    principalId: McpTokenMetadata["principalId"],
  ): Promise<readonly Readonly<McpTokenMetadata>[]> {
    const tokens = [...this.#tokensById.values()]
      .filter((token) => token.principalId === principalId)
      .sort((left, right) => {
        const byCreatedAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        return byCreatedAt !== 0
          ? byCreatedAt
          : compareUnicodeScalarValues(left.tokenId, right.tokenId);
      })
      .map(cloneTokenMetadata);
    return Object.freeze(tokens);
  }

  async listMcpTokenMetadataPage(
    request: ListMcpTokenMetadataPageRequest,
  ): Promise<Readonly<McpTokenMetadataPage>> {
    const asOf = Date.parse(request.asOf);
    if (
      !Number.isFinite(asOf) ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 50
    ) {
      throw new TypeError("MCP token page request is invalid");
    }
    const position = (token: StoredMcpToken) => Object.freeze({
      createdAt: token.createdAt,
      personalTokenRef: token.personalTokenRef!,
    });
    const comparePosition = (
      left: { readonly createdAt: string; readonly personalTokenRef: string },
      right: { readonly createdAt: string; readonly personalTokenRef: string },
    ) => {
      const byCreatedAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return byCreatedAt !== 0
        ? byCreatedAt
        : compareUnicodeScalarValues(right.personalTokenRef, left.personalTokenRef);
    };
    const effectiveState = (token: StoredMcpToken) =>
      token.state === "active" && Date.parse(token.expiresAt) <= asOf
        ? "expired"
        : token.state;
    const tokens = [...this.#tokensById.values()]
      .filter((token): token is StoredMcpToken & {
        readonly personalTokenRef: NonNullable<StoredMcpToken["personalTokenRef"]>;
      } =>
        token.principalId === request.principalId &&
        isPersonalMcpToken(token) &&
        token.personalTokenRef !== null &&
        effectiveState(token) === request.state
      )
      .sort(comparePosition);
    const upperBound = request.upperBound ?? (tokens[0] ? position(tokens[0]) : null);
    const bounded = upperBound === null
      ? []
      : tokens.filter((token) => comparePosition(position(token), upperBound) >= 0);
    const after = request.after;
    const continuation = after === undefined
      ? bounded
      : bounded.filter((token) => comparePosition(position(token), after) > 0);
    const window = continuation.slice(0, request.limit + 1);
    const page = window.slice(0, request.limit);
    const next = window.length > request.limit && page.length > 0
      ? position(page[page.length - 1]!)
      : null;
    return Object.freeze({
      tokens: Object.freeze(page.map(cloneTokenMetadata)),
      upperBound,
      next,
    });
  }

  async readMcpTokenMetadataByPresentationRef(
    principalId: McpTokenMetadata["principalId"],
    personalTokenRef: NonNullable<McpTokenMetadata["personalTokenRef"]>,
  ): Promise<Readonly<McpTokenMetadata> | null> {
    const tokenId = this.#tokenIdByPresentationRef.get(personalTokenRef);
    const token = tokenId === undefined ? undefined : this.#tokensById.get(tokenId);
    return token !== undefined && token.principalId === principalId
      ? cloneTokenMetadata(token)
      : null;
  }

  async listMcpTokensMissingPresentationRefs(): Promise<readonly McpTokenMetadata["tokenId"][]> {
    return Object.freeze([...this.#tokensById.values()]
      .filter((token) => isPersonalMcpToken(token) && token.personalTokenRef === null)
      .map((token) => token.tokenId)
      .sort(compareUnicodeScalarValues));
  }

  async assignPersonalTokenRefs(
    assignments: readonly AssignPersonalTokenRefRequest[],
  ): Promise<number> {
    const seen = new Set<string>();
    for (const assignment of assignments) {
      if (
        !PERSONAL_TOKEN_REF_PATTERN.test(assignment.personalTokenRef) ||
        seen.has(assignment.personalTokenRef)
      ) throw new TypeError("Personal token ref assignment is invalid");
      seen.add(assignment.personalTokenRef);
      const existing = this.#tokenIdByPresentationRef.get(assignment.personalTokenRef);
      if (existing !== undefined && existing !== assignment.tokenId) {
        throw new TypeError("Personal token ref assignment conflicts");
      }
      const token = this.#tokensById.get(assignment.tokenId);
      if (token !== undefined && !isPersonalMcpToken(token)) {
        throw new TypeError("OAuth authorization mirrors cannot receive personal token refs");
      }
    }
    let changed = 0;
    for (const assignment of assignments) {
      const token = this.#tokensById.get(assignment.tokenId);
      if (token === undefined || token.personalTokenRef !== null) continue;
      const updated = Object.freeze({ ...token, personalTokenRef: assignment.personalTokenRef });
      this.#tokensById.set(updated.tokenId, updated);
      this.#tokenIdByPresentationRef.set(assignment.personalTokenRef, updated.tokenId);
      changed += 1;
    }
    return changed;
  }

  async readMcpTokenForAuthorization(
    tokenId: McpTokenMetadata["tokenId"],
  ): Promise<Readonly<CurrentAuthorizationToken> | null> {
    const token = this.#tokensById.get(tokenId);
    return token ? authorizationToken(token) : null;
  }

  async findByVerifier(verifier: TokenVerifier) {
    const tokenId = this.#tokenIdByVerifier.get(verifier);
    const token = tokenId ? this.#tokensById.get(tokenId) : undefined;
    if (!token) return Object.freeze({ kind: "not_found" } as const);
    if (this.#accountDeletionReservations.has(token.principalId)) {
      return Object.freeze({ kind: "denied" } as const);
    }
    return Object.freeze({
      kind: "found" as const,
      verifier: token.verifier,
      value: authorizationToken(token),
    });
  }

  async revokeMcpToken(
    request: RevokeMcpTokenRequest,
  ): Promise<RevokeMcpTokenResult> {
    if (this.#accountDeletionReservations.has(request.principalId)) {
      return Object.freeze({ kind: "not_found" });
    }
    const current = this.#tokensById.get(request.tokenId);
    if (!current || current.principalId !== request.principalId) {
      return Object.freeze({ kind: "not_found" });
    }
    if (current.state === "revoked") {
      return Object.freeze({
        kind: "revoked",
        token: cloneTokenMetadata(current),
        replayed: true,
      });
    }
    const revoked = Object.freeze({
      ...current,
      state: "revoked" as const,
      version: version(current.version + 1),
      revokedAt: request.revokedAt,
    });
    this.#tokensById.set(revoked.tokenId, revoked);
    return Object.freeze({
      kind: "revoked",
      token: cloneTokenMetadata(revoked),
      replayed: false,
    });
  }

  async revokePrincipalTokensForAccountDeletion(
    request: RevokePrincipalTokensForAccountDeletionRequest,
  ): Promise<RevokePrincipalTokensForAccountDeletionResult> {
    const replayed = this.#deletedPrincipals.has(request.principalId);
    this.#deletedPrincipals.add(request.principalId);
    this.#accountDeletionReservations.delete(request.principalId);
    let revokedCount = 0;
    for (const current of this.#tokensById.values()) {
      if (
        current.principalId !== request.principalId ||
        current.state === "revoked"
      ) {
        continue;
      }
      const revoked = Object.freeze({
        ...current,
        state: "revoked" as const,
        version: version(current.version + 1),
        revokedAt: request.revokedAt,
      });
      this.#tokensById.set(revoked.tokenId, revoked);
      revokedCount += 1;
    }
    return Object.freeze({ revokedCount, replayed });
  }

  async readPrincipalTokenDeletionSnapshot(
    principalId: McpTokenMetadata["principalId"],
    occurredAt: BeginPrincipalTokenDeletionRequest["occurredAt"],
  ): Promise<Readonly<PrincipalTokenDeletionSnapshot>> {
    const now = Date.parse(occurredAt);
    const activeTokenCount = [...this.#tokensById.values()].filter(
      (token) =>
        token.principalId === principalId &&
        token.state === "active" &&
        Number.isFinite(now) &&
        Date.parse(token.expiresAt) > now,
    ).length;
    return Object.freeze({
      principalId,
      activeTokenCount,
      stateFingerprint: principalTokenFingerprint(this.#tokensById, principalId),
    });
  }

  async beginPrincipalTokenDeletion(
    request: BeginPrincipalTokenDeletionRequest,
  ): Promise<BeginPrincipalTokenDeletionResult> {
    if (this.#deletedPrincipals.has(request.principalId)) {
      return Object.freeze({ kind: "principal_deleted" });
    }
    const pending = this.#accountDeletionReservations.get(request.principalId);
    if (pending !== undefined) {
      return pending === request.expectedStateFingerprint
        ? Object.freeze({ kind: "reserved", replayed: true })
        : Object.freeze({ kind: "state_changed" });
    }
    if (
      principalTokenFingerprint(this.#tokensById, request.principalId) !==
      request.expectedStateFingerprint
    ) {
      return Object.freeze({ kind: "state_changed" });
    }
    this.#accountDeletionReservations.set(
      request.principalId,
      request.expectedStateFingerprint,
    );
    return Object.freeze({ kind: "reserved", replayed: false });
  }

  async completePrincipalTokenDeletion(
    request: CompletePrincipalTokenDeletionRequest,
  ): Promise<CompletePrincipalTokenDeletionResult> {
    if (this.#deletedPrincipals.has(request.principalId)) {
      return Object.freeze({ kind: "completed", revokedCount: 0, replayed: true });
    }
    const pending = this.#accountDeletionReservations.get(request.principalId);
    if (pending === undefined) {
      return Object.freeze({ kind: "reservation_not_found" });
    }
    if (pending !== request.expectedStateFingerprint) {
      return Object.freeze({ kind: "state_changed" });
    }
    let revokedCount = 0;
    for (const current of this.#tokensById.values()) {
      if (
        current.principalId !== request.principalId ||
        current.state === "revoked"
      ) {
        continue;
      }
      this.#tokensById.set(
        current.tokenId,
        Object.freeze({
          ...current,
          state: "revoked" as const,
          version: version(current.version + 1),
          revokedAt: request.revokedAt,
        }),
      );
      revokedCount += 1;
    }
    this.#accountDeletionReservations.delete(request.principalId);
    this.#deletedPrincipals.add(request.principalId);
    return Object.freeze({ kind: "completed", revokedCount, replayed: false });
  }

  async cancelPrincipalTokenDeletion(
    request: CancelPrincipalTokenDeletionRequest,
  ): Promise<boolean> {
    if (
      this.#accountDeletionReservations.get(request.principalId) !==
      request.expectedStateFingerprint
    ) {
      return false;
    }
    return this.#accountDeletionReservations.delete(request.principalId);
  }
}
