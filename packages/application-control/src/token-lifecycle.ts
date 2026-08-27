import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Clock,
  CredentialWriteTargetIdGenerator,
  CredentialWriteTargetStore,
  IssuedTokenSecret,
  McpTokenMetadata,
  McpTokenPagePosition,
  McpTokenPageState,
  McpTokenStore,
  PersonalTokenRefGenerator,
  TokenHasher,
  TokenIdGenerator,
} from "@mind-diary/application-ports";
import { normalizeTokenScopes } from "@mind-diary/domain";
import type {
  AccessTokenState,
  AuditEventId,
  EffectiveTokenScopes,
  MindBindingOwnerId,
  OutboxMessageId,
  PersonalTokenRef,
  PrincipalId,
  TokenId,
  TokenScope,
  UtcInstant,
} from "@mind-diary/domain";
import { safeBootstrapRequestId } from "./account-bootstrap.js";

export const MCP_TOKEN_DEFAULT_LIFETIME_DAYS = 90 as const;
export const MCP_TOKEN_MAXIMUM_LIFETIME_DAYS = 90 as const;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MCP_TOKEN_MAXIMUM_LIFETIME_MILLISECONDS =
  MCP_TOKEN_MAXIMUM_LIFETIME_DAYS * DAY_MILLISECONDS;
const RFC3339_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

export type TokenLifecycleFailureCode =
  | "authentication_required"
  | "invalid_token_page"
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
  readonly personalTokenRef: PersonalTokenRef | null;
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

export interface PersonalTokenUiDescriptor {
  readonly personalTokenRef: PersonalTokenRef;
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

export interface PersonalTokenPageResult {
  readonly items: readonly Readonly<PersonalTokenUiDescriptor>[];
  readonly nextCursor: string | null;
}

export interface PersonalTokenPageQuery {
  readonly state?: McpTokenPageState;
  readonly limit?: number;
  readonly cursor?: string | null;
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

export interface RevokePersonalTokenControlResult {
  readonly token: Readonly<PersonalTokenUiDescriptor>;
  readonly replayed: boolean;
}

export interface AccountTokenRevocationResult {
  readonly revokedCount: number;
  readonly replayed: boolean;
}

export interface TokenLifecycleSafeEvent {
  readonly event:
    | "token_issued"
    | "token_revoked"
    | "token_revoke_replayed"
    | "token_denied"
    | "token_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface TokenLifecycleSafeLogger {
  record(event: Readonly<TokenLifecycleSafeEvent>): void | Promise<void>;
}

export interface TokenLifecycleDependencies {
  readonly clock: Clock;
  readonly tokenHasher: TokenHasher;
  readonly tokenIds: TokenIdGenerator;
  readonly personalTokenRefs?: PersonalTokenRefGenerator;
  readonly tokens: McpTokenStore;
  readonly writeTargets?: Pick<
    CredentialWriteTargetStore,
    "runCredentialWriteTargetTransaction" | "revokeCredentialWriteTargetOwner"
  >;
  readonly writeTargetIds?: Pick<
    CredentialWriteTargetIdGenerator,
    "nextCredentialWriteTargetAuditEventId" | "nextCredentialWriteTargetOutboxMessageId"
  >;
  readonly logger?: TokenLifecycleSafeLogger;
}

function recordTokenLifecycleEvent(
  logger: TokenLifecycleSafeLogger | undefined,
  event: TokenLifecycleSafeEvent["event"],
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
    // Token telemetry never changes issuance/revocation semantics.
  }
}

export function parseUtcInstant(value: unknown): number | null {
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

export function canonicalUtcInstant(milliseconds: number): UtcInstant {
  return new Date(milliseconds).toISOString() as UtcInstant;
}

export function descriptor(
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
    personalTokenRef: token.personalTokenRef,
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

function personalTokenUiDescriptor(
  token: Readonly<McpTokenMetadata>,
  currentTime: number,
): Readonly<PersonalTokenUiDescriptor> {
  return personalTokenUiDescriptorFromLifecycle(descriptor(token, currentTime));
}

function personalTokenUiDescriptorFromLifecycle(
  result: Readonly<McpTokenDescriptor>,
): Readonly<PersonalTokenUiDescriptor> {
  if (result.personalTokenRef === null) {
    throw new TokenLifecycleFailure(
      "token_lifecycle_unavailable",
      "Token presentation metadata is unavailable.",
    );
  }
  return Object.freeze({
    personalTokenRef: result.personalTokenRef,
    name: result.name,
    displayPrefix: result.displayPrefix,
    scopes: result.scopes,
    state: result.state,
    version: result.version,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
    lastUsedAt: result.lastUsedAt,
    revokedAt: result.revokedAt,
  });
}

interface PersonalTokenCursorPayload {
  readonly v: 1;
  readonly actor: string;
  readonly state: McpTokenPageState;
  readonly limit: number;
  readonly asOf: UtcInstant;
  readonly upperBound: McpTokenPagePosition | null;
  readonly after: McpTokenPagePosition;
}

const PERSONAL_TOKEN_CURSOR_MAX_BYTES = 2_048;
const PERSONAL_TOKEN_REF_PATTERN = /^ptok_v1_[0-9a-f]{32}$/u;

function encodePersonalTokenCursor(payload: PersonalTokenCursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodePersonalTokenCursor(value: string): unknown {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > PERSONAL_TOKEN_CURSOR_MAX_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function isMcpTokenPageState(value: unknown): value is McpTokenPageState {
  return value === "active" || value === "revoked" || value === "expired";
}

function isPersonalTokenPagePosition(value: unknown): value is McpTokenPagePosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    parseUtcInstant(record.createdAt) !== null &&
    typeof record.personalTokenRef === "string" &&
    PERSONAL_TOKEN_REF_PATTERN.test(record.personalTokenRef);
}

function isPersonalTokenCursorPayload(value: unknown): value is PersonalTokenCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 7 &&
    record.v === 1 &&
    typeof record.actor === "string" &&
    /^[0-9a-f]{64}$/u.test(record.actor) &&
    isMcpTokenPageState(record.state) &&
    Number.isInteger(record.limit) &&
    Number(record.limit) >= 1 &&
    Number(record.limit) <= 50 &&
    parseUtcInstant(record.asOf) !== null &&
    (record.upperBound === null || isPersonalTokenPagePosition(record.upperBound)) &&
    isPersonalTokenPagePosition(record.after);
}

async function personalTokenCursorActor(principalId: PrincipalId): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mind-diary:personal-token-cursor:v1\0${principalId}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  readonly #personalTokenRefs: PersonalTokenRefGenerator;
  readonly #tokens: McpTokenStore;
  readonly #writeTargets: Pick<
    CredentialWriteTargetStore,
    "runCredentialWriteTargetTransaction" | "revokeCredentialWriteTargetOwner"
  > | undefined;
  readonly #writeTargetIds: Pick<
    CredentialWriteTargetIdGenerator,
    "nextCredentialWriteTargetAuditEventId" | "nextCredentialWriteTargetOutboxMessageId"
  > | undefined;
  readonly #logger: TokenLifecycleSafeLogger | undefined;

  constructor(dependencies: TokenLifecycleDependencies) {
    if (
      (dependencies.writeTargets === undefined) !==
      (dependencies.writeTargetIds === undefined)
    ) {
      throw new TypeError(
        "Token write-target store and identifier generator must be configured together.",
      );
    }
    this.#clock = dependencies.clock;
    this.#tokenHasher = dependencies.tokenHasher;
    this.#tokenIds = dependencies.tokenIds;
    this.#personalTokenRefs = dependencies.personalTokenRefs ?? Object.freeze({
      nextPersonalTokenRef: () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return `ptok_v1_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` as PersonalTokenRef;
      },
    });
    this.#tokens = dependencies.tokens;
    this.#writeTargets = dependencies.writeTargets;
    this.#writeTargetIds = dependencies.writeTargetIds;
    this.#logger = dependencies.logger;
  }

  async issueMcpToken(
    actor: ActorContext,
    command: IssueMcpTokenCommand,
  ): Promise<Readonly<IssueMcpTokenResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    try {
      const result = await this.#issueMcpToken(actor, command);
      recordTokenLifecycleEvent(this.#logger, "token_issued", requestId);
      return result;
    } catch (error) {
      recordTokenLifecycleEvent(
        this.#logger,
        error instanceof TokenLifecycleFailure &&
          error.code === "authentication_required"
          ? "token_denied"
          : "token_failed",
        requestId,
      );
      throw error;
    }
  }

  async #issueMcpToken(
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
    const personalTokenRef = this.#personalTokenRefs.nextPersonalTokenRef();
    if (!/^ptok_v1_[0-9a-f]{32}$/u.test(personalTokenRef)) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token presentation identifier generation is unavailable.",
      );
    }
    let registeredNewWriteTarget = false;
    let cleanupAuditEventId: AuditEventId | null = null;
    let cleanupAuditOutboxMessageId: OutboxMessageId | null = null;
    if (this.#writeTargets !== undefined) {
      if (this.#writeTargetIds === undefined) {
        throw new TokenLifecycleFailure(
          "token_lifecycle_unavailable",
          "Token write-target cleanup is unavailable.",
        );
      }
      // Allocate every cleanup dependency before the durable owner can exist.
      cleanupAuditEventId =
        this.#writeTargetIds.nextCredentialWriteTargetAuditEventId();
      cleanupAuditOutboxMessageId =
        this.#writeTargetIds.nextCredentialWriteTargetOutboxMessageId();
      const registered = await this.#writeTargets.runCredentialWriteTargetTransaction(
        (transaction) => transaction.registerCredentialWriteTargetOwner({
          bindingOwnerId: tokenId as unknown as MindBindingOwnerId,
          principalId,
          credentialKind: "personal_token",
          occurredAt: canonicalUtcInstant(createdAtMilliseconds),
        }),
      );
      if (registered.kind !== "registered") {
        throw new TokenLifecycleFailure(
          "token_lifecycle_unavailable",
          "Token write-target profile could not be initialized.",
        );
      }
      registeredNewWriteTarget = !registered.replayed;
    }
    try {
      const issuedSecret = await this.#tokenHasher.issueSecret();
      const persistence = issuedSecret.persistence();
      const created = await this.#tokens.createMcpToken({
        tokenId,
        personalTokenRef,
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
    } catch (error) {
      if (registeredNewWriteTarget) {
        if (cleanupAuditEventId === null || cleanupAuditOutboxMessageId === null) {
          throw new TokenLifecycleFailure(
            "token_lifecycle_unavailable",
            "Token write-target cleanup is unavailable.",
          );
        }
        await this.#cleanupFailedIssuanceWriteTarget(
          tokenId,
          principalId,
          actor.requestId,
          canonicalUtcInstant(createdAtMilliseconds),
          cleanupAuditEventId,
          cleanupAuditOutboxMessageId,
        );
      }
      throw error;
    }
  }

  async #cleanupFailedIssuanceWriteTarget(
    tokenId: TokenId,
    principalId: PrincipalId,
    requestId: ActorContext["requestId"],
    occurredAt: UtcInstant,
    auditEventId: AuditEventId,
    auditOutboxMessageId: OutboxMessageId,
  ): Promise<void> {
    if (this.#writeTargets === undefined) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token write-target cleanup is unavailable.",
      );
    }
    const result = await this.#writeTargets.revokeCredentialWriteTargetOwner({
      bindingOwnerId: tokenId as unknown as MindBindingOwnerId,
      principalId,
      requestId,
      auditEventId,
      auditOutboxMessageId,
      occurredAt,
    });
    if (result.kind !== "revoked" && result.kind !== "not_found") {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token write-target cleanup could not be completed.",
      );
    }
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

  async listPersonalTokenPage(
    actor: ActorContext,
    query: PersonalTokenPageQuery = {},
  ): Promise<Readonly<PersonalTokenPageResult>> {
    const principalId = requireSitesPrincipal(actor);
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      throw new TokenLifecycleFailure("invalid_token_page", "Token page is invalid.");
    }
    const requestedState = query.state ?? "active";
    const requestedLimit = query.limit ?? 20;
    if (
      !isMcpTokenPageState(requestedState) ||
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > 50 ||
      (query.cursor !== undefined && query.cursor !== null && typeof query.cursor !== "string")
    ) {
      throw new TokenLifecycleFailure("invalid_token_page", "Token page is invalid.");
    }

    const actorBinding = await personalTokenCursorActor(principalId);
    let state = requestedState;
    let limit = requestedLimit;
    let asOf = this.#clock.now();
    let upperBound: McpTokenPagePosition | undefined;
    let after: McpTokenPagePosition | undefined;
    if (query.cursor !== undefined && query.cursor !== null) {
      const decoded = decodePersonalTokenCursor(query.cursor);
      if (
        !isPersonalTokenCursorPayload(decoded) ||
        decoded.actor !== actorBinding ||
        (query.state !== undefined && query.state !== decoded.state) ||
        (query.limit !== undefined && query.limit !== decoded.limit)
      ) {
        throw new TokenLifecycleFailure("invalid_token_page", "Token page cursor is invalid.");
      }
      state = decoded.state;
      limit = decoded.limit;
      asOf = decoded.asOf;
      upperBound = decoded.upperBound ?? undefined;
      after = decoded.after;
    }
    const asOfMilliseconds = parseUtcInstant(asOf);
    if (asOfMilliseconds === null) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token lifecycle time is unavailable.",
      );
    }
    let page;
    try {
      page = await this.#tokens.listMcpTokenMetadataPage({
        principalId,
        state,
        asOf: canonicalUtcInstant(asOfMilliseconds),
        limit,
        ...(upperBound === undefined ? {} : { upperBound }),
        ...(after === undefined ? {} : { after }),
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TokenLifecycleFailure("invalid_token_page", "Token page cursor is invalid.");
      }
      throw error;
    }
    const items = Object.freeze(
      page.tokens.map((token) => personalTokenUiDescriptor(token, asOfMilliseconds)),
    );
    const nextCursor = page.next === null
      ? null
      : encodePersonalTokenCursor({
          v: 1,
          actor: actorBinding,
          state,
          limit,
          asOf: canonicalUtcInstant(asOfMilliseconds),
          upperBound: page.upperBound,
          after: page.next,
        });
    return Object.freeze({ items, nextCursor });
  }

  async readPersonalToken(
    actor: ActorContext,
    personalTokenRef: PersonalTokenRef,
  ): Promise<Readonly<PersonalTokenUiDescriptor>> {
    const principalId = requireSitesPrincipal(actor);
    if (typeof personalTokenRef !== "string" || !PERSONAL_TOKEN_REF_PATTERN.test(personalTokenRef)) {
      throw new TokenLifecycleFailure("invalid_token_id", "Token identifier is invalid.");
    }
    const currentTime = parseUtcInstant(this.#clock.now());
    if (currentTime === null) {
      throw new TokenLifecycleFailure(
        "token_lifecycle_unavailable",
        "Token lifecycle time is unavailable.",
      );
    }
    const token = await this.#tokens.readMcpTokenMetadataByPresentationRef(
      principalId,
      personalTokenRef,
    );
    if (token === null) {
      throw new TokenLifecycleFailure("token_not_found", "Token was not found.");
    }
    return personalTokenUiDescriptor(token, currentTime);
  }

  async revokePersonalToken(
    actor: ActorContext,
    personalTokenRef: PersonalTokenRef,
  ): Promise<Readonly<RevokePersonalTokenControlResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    try {
      const principalId = requireSitesPrincipal(actor);
      if (
        typeof personalTokenRef !== "string" ||
        !PERSONAL_TOKEN_REF_PATTERN.test(personalTokenRef)
      ) {
        throw new TokenLifecycleFailure("invalid_token_id", "Token identifier is invalid.");
      }
      const token = await this.#tokens.readMcpTokenMetadataByPresentationRef(
        principalId,
        personalTokenRef,
      );
      if (token === null) {
        throw new TokenLifecycleFailure("token_not_found", "Token was not found.");
      }
      const result = await this.#revokeMcpToken(actor, token.tokenId);
      recordTokenLifecycleEvent(
        this.#logger,
        result.replayed ? "token_revoke_replayed" : "token_revoked",
        requestId,
      );
      return Object.freeze({
        "token": personalTokenUiDescriptorFromLifecycle(result.token),
        replayed: result.replayed,
      });
    } catch (error) {
      recordTokenLifecycleEvent(
        this.#logger,
        error instanceof TokenLifecycleFailure &&
          (error.code === "authentication_required" || error.code === "token_not_found")
          ? "token_denied"
          : "token_failed",
        requestId,
      );
      throw error;
    }
  }

  async revokeMcpToken(
    actor: ActorContext,
    tokenId: TokenId,
  ): Promise<Readonly<RevokeMcpTokenControlResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    try {
      const result = await this.#revokeMcpToken(actor, tokenId);
      recordTokenLifecycleEvent(
        this.#logger,
        result.replayed ? "token_revoke_replayed" : "token_revoked",
        requestId,
      );
      return result;
    } catch (error) {
      recordTokenLifecycleEvent(
        this.#logger,
        error instanceof TokenLifecycleFailure &&
          (error.code === "authentication_required" ||
            error.code === "token_not_found")
          ? "token_denied"
          : "token_failed",
        requestId,
      );
      throw error;
    }
  }

  async #revokeMcpToken(
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
    if (this.#writeTargets !== undefined && this.#writeTargetIds !== undefined) {
      const bindingResult = await this.#writeTargets.revokeCredentialWriteTargetOwner({
        bindingOwnerId: tokenId as unknown as MindBindingOwnerId,
        principalId,
        requestId: actor.requestId,
        auditEventId: this.#writeTargetIds.nextCredentialWriteTargetAuditEventId(),
        auditOutboxMessageId: this.#writeTargetIds.nextCredentialWriteTargetOutboxMessageId(),
        occurredAt: canonicalUtcInstant(revokedAtMilliseconds),
      });
      if (bindingResult.kind !== "revoked" && bindingResult.kind !== "not_found") {
        throw new TokenLifecycleFailure(
          "token_lifecycle_unavailable",
          "Token binding revocation could not be completed.",
        );
      }
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
