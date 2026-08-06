import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Clock,
  IssuedTokenSecret,
  McpTokenMetadata,
  McpTokenStore,
  MetadataStore,
  TokenHasher,
  TokenIdGenerator,
} from "@mind-diary/application-ports";
import {
  normalizeTokenScopes,
  type AccessTokenState,
  type EffectiveTokenScopes,
  type PrincipalId,
  type TokenId,
  type TokenScope,
  type UtcInstant,
} from "@mind-diary/domain";

export const CONTROL_QUERIES = [
  "get_session",
  "get_account_deletion_impact",
  "list_minds",
  "resolve_mind_metadata",
  "get_mind_info",
  "list_public_minds",
  "list_members",
  "list_invitations",
  "list_mcp_tokens",
] as const;

export const CONTROL_COMMANDS = [
  "bootstrap_account",
  "rename_account",
  "delete_account",
  "create_space_with_owner",
  "rename_space",
  "change_visibility",
  "delete_space",
  "create_invitation",
  "accept_invitation",
  "reject_invitation",
  "cancel_invitation",
  "change_membership_role",
  "revoke_membership",
  "leave_space",
  "transfer_ownership",
  "issue_mcp_token",
  "revoke_mcp_token",
] as const;

export interface ControlBoundaryMarker {
  readonly actor: ActorContext;
  readonly metadata: MetadataStore;
  readonly principalId?: PrincipalId;
}

export const MCP_TOKEN_DEFAULT_LIFETIME_DAYS = 90 as const;
export const MCP_TOKEN_MAXIMUM_LIFETIME_DAYS = 90 as const;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MCP_TOKEN_MAXIMUM_LIFETIME_MILLISECONDS =
  MCP_TOKEN_MAXIMUM_LIFETIME_DAYS * DAY_MILLISECONDS;
const RFC3339_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

export type TokenLifecycleFailureCode =
  | "authentication_required"
  | "invalid_token_name"
  | "invalid_token_scopes"
  | "invalid_token_expiry"
  | "token_expiry_out_of_range"
  | "invalid_token_id"
  | "token_not_found"
  | "token_issue_conflict"
  | "principal_tokens_disabled"
  | "token_lifecycle_unavailable";

/** Stable safe failure without token secret or verifier details. */
export class TokenLifecycleFailure extends Error {
  readonly code: TokenLifecycleFailureCode;

  constructor(code: TokenLifecycleFailureCode, message: string) {
    super(message);
    this.name = "TokenLifecycleFailure";
    this.code = code;
  }
}

export interface McpTokenDescriptor {
  readonly tokenId: TokenId;
  readonly name: string;
  readonly displayPrefix: string;
  readonly scopes: EffectiveTokenScopes;
  readonly state: AccessTokenState;
  readonly version: number;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly lastUsedAt: UtcInstant | null;
  readonly revokedAt: UtcInstant | null;
}

/** Public issuance boundary: consume-once secret, with no verifier accessor. */
export interface OneTimeMcpTokenSecret {
  consumeSecret(): string | null;
}

class ConsumeOnceMcpTokenSecret implements OneTimeMcpTokenSecret {
  #source: IssuedTokenSecret | null;

  constructor(source: IssuedTokenSecret) {
    this.#source = source;
    Object.freeze(this);
  }

  consumeSecret(): string | null {
    const source = this.#source;
    this.#source = null;
    return source?.consumeSecret() ?? null;
  }

  toJSON(): Readonly<{ available: boolean }> {
    return Object.freeze({ available: this.#source !== null });
  }
}

export interface IssueMcpTokenCommand {
  readonly name: string;
  readonly scopes: readonly TokenScope[];
  readonly expiresAt?: UtcInstant;
}

export interface IssueMcpTokenResult {
  readonly token: Readonly<McpTokenDescriptor>;
  readonly secret: OneTimeMcpTokenSecret;
}

export interface RevokeMcpTokenControlResult {
  readonly token: Readonly<McpTokenDescriptor>;
  readonly replayed: boolean;
}

export interface AccountTokenRevocationResult {
  readonly revokedCount: number;
  readonly replayed: boolean;
}

export interface TokenLifecycleDependencies {
  readonly clock: Clock;
  readonly tokenHasher: TokenHasher;
  readonly tokenIds: TokenIdGenerator;
  readonly tokens: McpTokenStore;
}

function parseUtcInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  const fraction = Number((match[7] ?? "").padEnd(3, "0"));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== fraction
  ) {
    return null;
  }
  return milliseconds;
}

function canonicalUtcInstant(milliseconds: number): UtcInstant {
  return new Date(milliseconds).toISOString() as UtcInstant;
}

function descriptor(
  token: Readonly<McpTokenMetadata>,
  currentTime: number,
): Readonly<McpTokenDescriptor> {
  const scopes = Object.freeze([...token.scopes]) as EffectiveTokenScopes;
  const expiresAt = parseUtcInstant(token.expiresAt);
  const state =
    token.state === "active" &&
    expiresAt !== null &&
    expiresAt <= currentTime
      ? "expired"
      : token.state;
  return Object.freeze({
    tokenId: token.tokenId,
    name: token.name,
    displayPrefix: token.displayPrefix,
    scopes,
    state,
    version: token.version,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
  });
}

function requireSitesPrincipal(actor: ActorContext): PrincipalId {
  if (
    actor.kind !== "registered_principal" ||
    actor.authentication.kind !== "sites_identity" ||
    typeof actor.principalId !== "string" ||
    actor.principalId.length === 0
  ) {
    throw new TokenLifecycleFailure(
      "authentication_required",
      "A registered Sites principal is required.",
    );
  }
  return actor.principalId;
}

function normalizeRequestedScopes(value: unknown): EffectiveTokenScopes {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (scope) => scope === "content:read" || scope === "content:write",
    )
  ) {
    throw new TokenLifecycleFailure(
      "invalid_token_scopes",
      "Token scopes must contain only supported content scopes.",
    );
  }
  return normalizeTokenScopes(value as readonly TokenScope[]);
}

export class TokenLifecycleService {
  readonly #clock: Clock;
  readonly #tokenHasher: TokenHasher;
  readonly #tokenIds: TokenIdGenerator;
  readonly #tokens: McpTokenStore;

  constructor(dependencies: TokenLifecycleDependencies) {
    this.#clock = dependencies.clock;
    this.#tokenHasher = dependencies.tokenHasher;
    this.#tokenIds = dependencies.tokenIds;
    this.#tokens = dependencies.tokens;
  }

  async issueMcpToken(
    actor: ActorContext,
    command: IssueMcpTokenCommand,
  ): Promise<Readonly<IssueMcpTokenResult>> {
    const principalId = requireSitesPrincipal(actor);
    if (typeof command?.name !== "string" || command.name.trim().length === 0) {
      throw new TokenLifecycleFailure(
        "invalid_token_name",
        "Token name must not be empty.",
      );
    }
    const name = command.name.trim();
    const scopes = normalizeRequestedScopes(command.scopes);
    const createdAtMilliseconds = parseUtcInstant(this.#clock.now());
    if (createdAtMilliseconds === null) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token lifecycle time is unavailable.",
      );
    }
    const maximumExpiry =
      createdAtMilliseconds + MCP_TOKEN_MAXIMUM_LIFETIME_MILLISECONDS;
    let expiresAtMilliseconds = maximumExpiry;
    if (command.expiresAt !== undefined) {
      const requestedExpiry = parseUtcInstant(command.expiresAt);
      if (requestedExpiry === null) {
        throw new TokenLifecycleFailure(
          "invalid_token_expiry",
          "Token expiry must be a valid UTC timestamp.",
        );
      }
      if (
        requestedExpiry <= createdAtMilliseconds ||
        requestedExpiry > maximumExpiry
      ) {
        throw new TokenLifecycleFailure(
          "token_expiry_out_of_range",
          "Token expiry must be in the future and within the server maximum.",
        );
      }
      expiresAtMilliseconds = requestedExpiry;
    }

    const tokenId = this.#tokenIds.nextTokenId();
    if (typeof tokenId !== "string" || tokenId.length === 0) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token identifier generation is unavailable.",
      );
    }
    const issuedSecret = await this.#tokenHasher.issueSecret();
    const persistence = issuedSecret.persistence();
    const created = await this.#tokens.createMcpToken({
      tokenId,
      principalId,
      name,
      verifier: persistence.verifier,
      displayPrefix: persistence.displayPrefix,
      scopes,
      createdAt: canonicalUtcInstant(createdAtMilliseconds),
      expiresAt: canonicalUtcInstant(expiresAtMilliseconds),
    });
    if (created.kind === "principal_deleted") {
      throw new TokenLifecycleFailure(
        "principal_tokens_disabled",
        "Token issuance is disabled for this principal.",
      );
    }
    if (created.kind !== "created") {
      throw new TokenLifecycleFailure(
        "token_issue_conflict",
        "Token issuance conflicted with current state.",
      );
    }
    return Object.freeze({
      token: descriptor(created.token, createdAtMilliseconds),
      secret: new ConsumeOnceMcpTokenSecret(issuedSecret),
    });
  }

  async listMcpTokens(
    actor: ActorContext,
  ): Promise<readonly Readonly<McpTokenDescriptor>[]> {
    const principalId = requireSitesPrincipal(actor);
    const currentTime = parseUtcInstant(this.#clock.now());
    if (currentTime === null) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token lifecycle time is unavailable.",
      );
    }
    const tokens = await this.#tokens.listMcpTokenMetadata(principalId);
    return Object.freeze(tokens.map((token) => descriptor(token, currentTime)));
  }

  async revokeMcpToken(
    actor: ActorContext,
    tokenId: TokenId,
  ): Promise<Readonly<RevokeMcpTokenControlResult>> {
    const principalId = requireSitesPrincipal(actor);
    if (typeof tokenId !== "string" || tokenId.length === 0) {
      throw new TokenLifecycleFailure(
        "invalid_token_id",
        "Token identifier is invalid.",
      );
    }
    const revokedAtMilliseconds = parseUtcInstant(this.#clock.now());
    if (revokedAtMilliseconds === null) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token lifecycle time is unavailable.",
      );
    }
    const result = await this.#tokens.revokeMcpToken({
      principalId,
      tokenId,
      revokedAt: canonicalUtcInstant(revokedAtMilliseconds),
    });
    if (result.kind === "not_found") {
      throw new TokenLifecycleFailure(
        "token_not_found",
        "Token was not found.",
      );
    }
    return Object.freeze({
      token: descriptor(result.token, revokedAtMilliseconds),
      replayed: result.replayed,
    });
  }

  /** Called from the account-deletion transaction boundary, never from MCP. */
  async revokeTokensForAccountDeletion(
    principalId: PrincipalId,
  ): Promise<Readonly<AccountTokenRevocationResult>> {
    if (typeof principalId !== "string" || principalId.length === 0) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Account token lifecycle is unavailable.",
      );
    }
    const revokedAtMilliseconds = parseUtcInstant(this.#clock.now());
    if (revokedAtMilliseconds === null) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token lifecycle time is unavailable.",
      );
    }
    return Object.freeze(
      await this.#tokens.revokePrincipalTokensForAccountDeletion({
        principalId,
        revokedAt: canonicalUtcInstant(revokedAtMilliseconds),
      }),
    );
  }
}
