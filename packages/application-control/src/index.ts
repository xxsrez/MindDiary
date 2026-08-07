import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  AccountBootstrapIdGenerator,
  AccountBootstrapStore,
  Clock,
  ExternalIdentityBindingLookup,
  IssuedTokenSecret,
  McpTokenMetadata,
  McpTokenStore,
  MetadataStore,
  ObjectStore,
  TokenHasher,
  TokenIdGenerator,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  isReservedTopLevelHandle,
  normalizeTokenScopes,
  parseCanonicalSpaceHandle,
  serializeRevisionManifest,
  version,
  type AccessTokenState,
  type EffectiveTokenScopes,
  type PrincipalId,
  type PrincipalAccountSnapshot,
  type SensitiveExternalBinding,
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

export const ACCOUNT_BOOTSTRAP_ACTION = "create_isolated_account" as const;
export function createInitialPersonalMindFiles(
  occurredAtUtc: UtcInstant,
): readonly Readonly<{ readonly path: string; readonly text: string }>[] {
  const date = occurredAtUtc.slice(0, 10);
  return Object.freeze([
    Object.freeze({
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# My Mind\n\nAdd the first Memory.\n`,
    }),
    Object.freeze({
      path: "log.md",
      text: `# Log\n\n## ${date}\n\n- **Create**: Created Personal Mind.\n`,
    }),
  ]);
}

export interface SitesIdentityBeforeRegistration {
  readonly kind: "sites_identity_before_registration";
  readonly authentication: {
    readonly kind: "sites_identity";
    readonly verifiedByPlatform: true;
  };
  readonly provider: string;
  /** Exact server-normalized binding; sensitive and never returned/logged. */
  readonly normalizedBinding: SensitiveExternalBinding;
  readonly suggestedDisplayName?: string;
  readonly deploymentCapabilities: readonly string[];
  readonly requestId: ActorContext["requestId"];
  readonly occurredAtUtc: UtcInstant;
}

export interface BootstrapAccountCommand {
  readonly action: typeof ACCOUNT_BOOTSTRAP_ACTION;
  readonly displayName?: string;
}

export interface PersonalMindControlDescriptor {
  readonly mindId: PrincipalAccountSnapshot["personalMind"]["space"]["spaceId"];
  readonly route: "/me";
  readonly visibility: "private";
  readonly headRevisionId: PrincipalAccountSnapshot["personalMind"]["space"]["headRevisionId"];
}

export interface BootstrapAccountResult {
  readonly principalId: PrincipalId;
  readonly personalMind: Readonly<PersonalMindControlDescriptor>;
  readonly replayed: boolean;
}

export type AccountBootstrapFailureCode =
  | "authentication_required"
  | "invalid_action"
  | "display_name_required"
  | "account_bootstrap_conflict"
  | "account_bootstrap_unavailable"
  | "personal_mind_not_found";

/** Stable safe failure without external binding, profile, or hidden handle. */
export class AccountBootstrapFailure extends Error {
  readonly code: AccountBootstrapFailureCode;

  constructor(code: AccountBootstrapFailureCode, message: string) {
    super(message);
    this.name = "AccountBootstrapFailure";
    this.code = code;
  }
}

export interface AccountBootstrapSafeEvent {
  readonly event:
    | "account_bootstrap_succeeded"
    | "account_bootstrap_replayed"
    | "account_bootstrap_denied"
    | "account_bootstrap_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface AccountBootstrapSafeLogger {
  record(event: Readonly<AccountBootstrapSafeEvent>): void | Promise<void>;
}

export interface AccountBootstrapDependencies {
  readonly accounts: AccountBootstrapStore;
  readonly objects: ObjectStore;
  readonly ids: AccountBootstrapIdGenerator;
  readonly logger?: AccountBootstrapSafeLogger;
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

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function safeBootstrapRequestId(
  value: unknown,
): AccountBootstrapSafeEvent["requestId"] {
  return (
    typeof value === "string" && SAFE_REQUEST_ID_PATTERN.test(value)
      ? value
      : "request_invalid"
  ) as AccountBootstrapSafeEvent["requestId"];
}

function recordBootstrapEvent(
  logger: AccountBootstrapSafeLogger | undefined,
  event: AccountBootstrapSafeEvent["event"],
  requestId: AccountBootstrapSafeEvent["requestId"],
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
    // Safe observability is never part of the metadata transaction.
  }
}

function isSitesIdentityBeforeRegistration(
  actor: SitesIdentityBeforeRegistration | ActorContext,
): actor is SitesIdentityBeforeRegistration {
  return (
    actor?.kind === "sites_identity_before_registration" &&
    actor.authentication?.kind === "sites_identity" &&
    actor.authentication.verifiedByPlatform === true &&
    typeof actor.provider === "string" &&
    SAFE_PROVIDER_PATTERN.test(actor.provider) &&
    typeof actor.normalizedBinding === "string" &&
    actor.normalizedBinding.length > 0 &&
    actor.normalizedBinding.length <= 320 &&
    !CONTROL_OR_SEPARATOR.test(actor.normalizedBinding) &&
    typeof actor.requestId === "string" &&
    SAFE_REQUEST_ID_PATTERN.test(actor.requestId) &&
    parseUtcInstant(actor.occurredAtUtc) !== null &&
    Array.isArray(actor.deploymentCapabilities) &&
    actor.deploymentCapabilities.every(
      (capability) => typeof capability === "string" && capability.length > 0,
    )
  );
}

function normalizedDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized: string;
  try {
    normalized = value.normalize("NFKC").trim();
  } catch {
    return null;
  }
  return normalized.length > 0 &&
    [...normalized].length <= 128 &&
    !CONTROL_OR_SEPARATOR.test(normalized)
    ? normalized
    : null;
}

function bootstrapDisplayName(
  actor: SitesIdentityBeforeRegistration,
  command: BootstrapAccountCommand,
): string {
  const trustedProfile = normalizedDisplayName(actor.suggestedDisplayName);
  if (trustedProfile !== null) return trustedProfile;
  const explicit = normalizedDisplayName(command.displayName);
  if (explicit !== null) return explicit;
  throw new AccountBootstrapFailure(
    "display_name_required",
    "A valid display name is required for first account creation.",
  );
}

function personalMindDescriptor(
  account: Readonly<PrincipalAccountSnapshot>,
): Readonly<PersonalMindControlDescriptor> {
  const space = account.personalMind.space;
  return Object.freeze({
    mindId: space.spaceId,
    route: "/me",
    visibility: "private",
    headRevisionId: space.headRevisionId,
  });
}

function bootstrapResult(
  account: Readonly<PrincipalAccountSnapshot>,
  replayed: boolean,
): Readonly<BootstrapAccountResult> {
  return Object.freeze({
    principalId: account.principal.principalId,
    personalMind: personalMindDescriptor(account),
    replayed,
  });
}

function exactBindingLookup(
  actor: SitesIdentityBeforeRegistration,
): Readonly<ExternalIdentityBindingLookup> {
  return Object.freeze({
    provider: actor.provider,
    normalizedBinding: actor.normalizedBinding,
  });
}

export class AccountBootstrapService {
  readonly #accounts: AccountBootstrapStore;
  readonly #objects: ObjectStore;
  readonly #ids: AccountBootstrapIdGenerator;
  readonly #logger: AccountBootstrapSafeLogger | undefined;

  constructor(dependencies: AccountBootstrapDependencies) {
    this.#accounts = dependencies.accounts;
    this.#objects = dependencies.objects;
    this.#ids = dependencies.ids;
    this.#logger = dependencies.logger;
  }

  async bootstrapAccount(
    actor: SitesIdentityBeforeRegistration | ActorContext,
    command: BootstrapAccountCommand,
  ): Promise<Readonly<BootstrapAccountResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    if (!isSitesIdentityBeforeRegistration(actor)) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_denied", requestId);
      throw new AccountBootstrapFailure(
        "authentication_required",
        "A verified Sites identity before registration is required.",
      );
    }
    if (command?.action !== ACCOUNT_BOOTSTRAP_ACTION) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_denied", requestId);
      throw new AccountBootstrapFailure(
        "invalid_action",
        "Only explicit isolated account creation is supported.",
      );
    }

    const lookup = exactBindingLookup(actor);

    try {
      const existing = await this.#accounts.readAccountByExternalBinding(lookup);
      if (existing !== null) {
        recordBootstrapEvent(this.#logger, "account_bootstrap_replayed", requestId);
        return bootstrapResult(existing, true);
      }
    } catch (error) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_failed", requestId);
      throw error;
    }

    let displayName: string;
    try {
      displayName = bootstrapDisplayName(actor, command);
    } catch (error) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_denied", requestId);
      throw error;
    }

    try {
      const principalId = this.#ids.nextPrincipalId();
      const bindingId = this.#ids.nextExternalBindingId();
      const spaceId = this.#ids.nextSpaceId();
      const membershipId = this.#ids.nextMembershipId();
      const revisionId = this.#ids.nextRevisionId();
      const hiddenHandle = this.#ids.nextPersonalSpaceHandle();
      const parsedHandle = parseCanonicalSpaceHandle(hiddenHandle);
      if (
        parsedHandle.kind !== "valid" ||
        isReservedTopLevelHandle(parsedHandle.canonicalHandle)
      ) {
        throw new AccountBootstrapFailure(
          "account_bootstrap_conflict",
          "Server-owned account identifiers are unavailable.",
        );
      }

      const encoder = new TextEncoder();
      const initialFiles = createInitialPersonalMindFiles(actor.occurredAtUtc);
      const storedObjects = await Promise.all(
        initialFiles.map(async (file) =>
          this.#objects.putImmutable({
            bytes: encoder.encode(file.text),
            mediaType: MARKDOWN_MEDIA_TYPE,
            createdAt: actor.occurredAtUtc,
          })),
      );
      const manifest = createRevisionManifest(
        initialFiles.map((file, index) => {
          const object = storedObjects[index]!.object;
          return {
            path: file.path,
            sha256: object.sha256,
            mediaType: MARKDOWN_MEDIA_TYPE,
            size: object.size,
          };
        }),
      );
      const manifestHash = await this.#objects.calculateSha256(
        encoder.encode(serializeRevisionManifest(manifest)),
      );
      const initialRevision = createCanonicalRevisionEnvelope({
        revisionId,
        spaceId,
        revisionNumber: 1,
        parentRevisionId: null,
        committedAt: actor.occurredAtUtc,
        committedBy: { kind: "principal", principalId },
        manifest,
        manifestHash,
        summary: "Create Personal Mind",
      });
      const records = Object.freeze({
        principal: Object.freeze({
          principalId,
          displayName,
          state: "active" as const,
          profileVersion: version(1),
          createdAt: actor.occurredAtUtc,
          updatedAt: actor.occurredAtUtc,
        }),
        externalBinding: Object.freeze({
          bindingId,
          principalId,
          provider: actor.provider,
          normalizedBinding: actor.normalizedBinding,
          state: "active" as const,
          version: version(1),
          verifiedAt: actor.occurredAtUtc,
          createdAt: actor.occurredAtUtc,
          updatedAt: actor.occurredAtUtc,
        }),
        personalSpace: Object.freeze({
          spaceId,
          spaceHandle: parsedHandle.canonicalHandle,
          normalizedHandle: parsedHandle.canonicalHandle,
          name: displayName,
          visibility: "private" as const,
          state: "active" as const,
          metadataVersion: version(1),
          accessVersion: version(1),
          headRevisionId: revisionId,
          createdAt: actor.occurredAtUtc,
          updatedAt: actor.occurredAtUtc,
        }),
        personalBinding: Object.freeze({
          principalId,
          spaceId,
          version: version(1),
          createdAt: actor.occurredAtUtc,
        }),
        ownerMembership: Object.freeze({
          membershipId,
          spaceId,
          principalId,
          role: "owner" as const,
          state: "active" as const,
          version: version(1),
          createdAt: actor.occurredAtUtc,
          createdBy: principalId,
          updatedAt: actor.occurredAtUtc,
          updatedBy: principalId,
        }),
        initialRevision,
      });

      const created = await this.#accounts.runAccountBootstrapTransaction(
        async (transaction) => {
          const replay = await transaction.readAccountByExternalBinding(lookup);
          if (replay !== null) {
            return Object.freeze({ kind: "exact_binding_exists", account: replay } as const);
          }
          return transaction.createAccountBootstrap(records);
        },
      );
      if (created.kind === "created") {
        recordBootstrapEvent(this.#logger, "account_bootstrap_succeeded", requestId);
        return bootstrapResult(created.account, false);
      }
      if (created.kind === "exact_binding_exists") {
        recordBootstrapEvent(this.#logger, "account_bootstrap_replayed", requestId);
        return bootstrapResult(created.account, true);
      }
      throw new AccountBootstrapFailure(
        "account_bootstrap_conflict",
        "Account creation conflicted with current state.",
      );
    } catch (error) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_failed", requestId);
      throw error;
    }
  }

  async resolveMyMind(
    actor: ActorContext,
  ): Promise<Readonly<PersonalMindControlDescriptor>> {
    if (
      actor?.kind !== "registered_principal" ||
      actor.authentication.kind !== "sites_identity"
    ) {
      throw new AccountBootstrapFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const resolution = await this.#accounts.resolvePersonalMind(actor.principalId);
    if (resolution === null) {
      throw new AccountBootstrapFailure(
        "personal_mind_not_found",
        "Personal Mind is unavailable.",
      );
    }
    return Object.freeze({
      mindId: resolution.spaceId,
      route: "/me",
      visibility: "private",
      headRevisionId: resolution.headRevisionId,
    });
  }
}
