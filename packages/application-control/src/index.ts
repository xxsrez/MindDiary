import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  AuthorizationGrant,
  AuthorizationStamp,
  AuthorizationTransaction,
  AuditSink,
  AccountBootstrapIdGenerator,
  AccountBootstrapStore,
  AccountDeletionCleanupWorkItem,
  AccountDeletionIdGenerator,
  AccountDeletionStore,
  Clock,
  ExternalIdentityBindingLookup,
  ExportArchiveStore,
  IssuedTokenSecret,
  InvitationLifecycleIdGenerator,
  InvitationSnapshot,
  McpTokenMetadata,
  McpTokenStore,
  MetadataStore,
  MindRouteMetadataStore,
  ObjectStore,
  OrdinaryMindIdGenerator,
  OrdinaryMindDeletionCleanupWorkItem,
  OrdinaryMindDeletionIdGenerator,
  OrdinaryMindRouteSnapshot,
  OrdinaryMindSnapshot,
  OrdinaryMindStore,
  OwnershipTransferAuditIdGenerator,
  PersonalMindProfileSnapshot,
  PersonalMindStore,
  PublicMindCatalogStore,
  SearchIndex,
  TokenHasher,
  TokenIdGenerator,
  VerifiedSpaceHost,
  VisibilityAuditIdGenerator,
} from "@mind-diary/application-ports";
import { AuthorizedHandleReader, CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  capabilitiesForRole,
  capabilitiesForVisibilityGrant,
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  idempotencyKey,
  normalizeTokenScopes,
  parseCanonicalSpaceHandle,
  serializeRevisionManifest,
  version,
  type AccessTokenState,
  type Capability,
  type EffectiveTokenScopes,
  type AuditEventId,
  type DeletedPrincipalId,
  type IdempotencyKey,
  type InvitationRole,
  type MembershipId,
  type OutboxMessageId,
  type PrincipalId,
  type PrincipalAccountSnapshot,
  type SensitiveExternalBinding,
  type SpaceId,
  type Role,
  type Sha256Digest,
  type SpaceMembership,
  type TokenId,
  type TokenScope,
  type UtcInstant,
  type Visibility,
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
  "reissue_invitation",
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

export function createInitialOrdinaryMindFiles(
  occurredAtUtc: UtcInstant,
): readonly Readonly<{ readonly path: string; readonly text: string }>[] {
  const date = occurredAtUtc.slice(0, 10);
  return Object.freeze([
    Object.freeze({
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# Mind\n\nAdd the first Memory.\n`,
    }),
    Object.freeze({
      path: "log.md",
      text: `# Log\n\n## ${date}\n\n- **Create**: Created Mind.\n`,
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

export const PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS = [
  "rename_space",
  "create_invitation",
  "accept_invitation",
  "reject_invitation",
  "cancel_invitation",
  "reissue_invitation",
  "add_participant",
  "change_membership_role",
  "revoke_membership",
  "leave_space",
  "change_visibility",
  "publish",
  "transfer_ownership",
  "delete_space",
] as const;

export type PersonalMindForbiddenLifecycleOperation =
  (typeof PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS)[number];

export type PersonalMindControlFailureCode =
  | "authentication_required"
  | "invalid_display_name"
  | "invalid_profile_version"
  | "invalid_idempotency_key"
  | "invalid_lifecycle_operation"
  | "mind_not_found"
  | "personal_mind_not_found"
  | "personal_mind_operation_forbidden"
  | "profile_conflict"
  | "idempotency_conflict"
  | "personal_mind_unavailable";

/** Stable safe error: it never includes a target ID, display name, or hidden handle. */
export class PersonalMindControlFailure extends Error {
  readonly code: PersonalMindControlFailureCode;

  constructor(code: PersonalMindControlFailureCode, message: string) {
    super(message);
    this.name = "PersonalMindControlFailure";
    this.code = code;
  }
}

export interface RenameAccountCommand {
  readonly displayName: string;
  readonly expectedProfileVersion: number;
  readonly idempotencyKey: string;
}

export interface PersonalMindProfileDescriptor {
  readonly principal: {
    readonly principalId: PrincipalId;
    readonly displayName: string;
    readonly profileVersion: number;
  };
  readonly personalMind: {
    readonly mindId: SpaceId;
    readonly route: "/me";
    readonly name: string;
    readonly visibility: "private";
    readonly metadataVersion: number;
    readonly headRevisionId: PersonalMindProfileSnapshot["personalMind"]["headRevisionId"];
  };
}

export interface RenameAccountResult extends PersonalMindProfileDescriptor {
  readonly replayed: boolean;
}

export interface GuardOrdinaryLifecycleCommand {
  readonly mindId: SpaceId;
  readonly operation: PersonalMindForbiddenLifecycleOperation;
}

export interface OrdinaryLifecycleTarget {
  readonly kind: "ordinary";
  readonly mindId: SpaceId;
}

export interface PersonalMindControlSafeEvent {
  readonly event:
    | "personal_mind_resolved"
    | "personal_profile_renamed"
    | "personal_profile_replayed"
    | "personal_profile_conflict"
    | "personal_lifecycle_denied"
    | "personal_control_denied"
    | "personal_control_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface PersonalMindControlSafeLogger {
  record(event: Readonly<PersonalMindControlSafeEvent>): void | Promise<void>;
}

export interface PersonalMindControlDependencies {
  readonly personalMinds: PersonalMindStore;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
  readonly logger?: PersonalMindControlSafeLogger;
}

const PERSONAL_PROFILE_IDEMPOTENCY_MAX_BYTES = 256;
const PERSONAL_PROFILE_IDEMPOTENCY_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const PERSONAL_PROFILE_ENCODER = new TextEncoder();

function registeredSitesPrincipal(actor: ActorContext): PrincipalId | null {
  return actor?.kind === "registered_principal" &&
    actor.authentication?.kind === "sites_identity" &&
    typeof actor.principalId === "string" &&
    actor.principalId.length > 0
    ? actor.principalId
    : null;
}

function personalProfileIdempotencyKey(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    PERSONAL_PROFILE_IDEMPOTENCY_FORBIDDEN.test(value) ||
    PERSONAL_PROFILE_ENCODER.encode(value).byteLength >
      PERSONAL_PROFILE_IDEMPOTENCY_MAX_BYTES
  ) {
    throw new PersonalMindControlFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
  return idempotencyKey(value);
}

function personalProfileVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new PersonalMindControlFailure(
      "invalid_profile_version",
      "A valid expected profile version is required.",
    );
  }
}

function personalProfileDescriptor(
  profile: Readonly<PersonalMindProfileSnapshot>,
): Readonly<PersonalMindProfileDescriptor> {
  return Object.freeze({
    principal: Object.freeze({
      principalId: profile.principalId,
      displayName: profile.displayName,
      profileVersion: profile.profileVersion,
    }),
    personalMind: Object.freeze({
      mindId: profile.personalMind.spaceId,
      route: "/me",
      name: profile.personalMind.name,
      visibility: "private",
      metadataVersion: profile.personalMind.metadataVersion,
      headRevisionId: profile.personalMind.headRevisionId,
    }),
  });
}

function recordPersonalMindEvent(
  logger: PersonalMindControlSafeLogger | undefined,
  event: PersonalMindControlSafeEvent["event"],
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
    // Safe observability remains outside the metadata transaction.
  }
}

/** `/me`, profile sync, and pre-mutation Personal Mind lifecycle policy. */
export class PersonalMindControlService {
  readonly #personalMinds: PersonalMindStore;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #logger: PersonalMindControlSafeLogger | undefined;

  constructor(dependencies: PersonalMindControlDependencies) {
    this.#personalMinds = dependencies.personalMinds;
    this.#digest = dependencies.digest;
    this.#logger = dependencies.logger;
  }

  async resolveMyMind(
    actor: ActorContext,
  ): Promise<Readonly<PersonalMindProfileDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordPersonalMindEvent(
        this.#logger,
        "personal_control_denied",
        requestId,
      );
      throw new PersonalMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const profile = await this.#personalMinds.readPersonalMindProfile(principalId);
    if (profile === null) {
      throw new PersonalMindControlFailure(
        "personal_mind_not_found",
        "Personal Mind is unavailable.",
      );
    }
    recordPersonalMindEvent(
      this.#logger,
      "personal_mind_resolved",
      requestId,
    );
    return personalProfileDescriptor(profile);
  }

  async renameAccount(
    actor: ActorContext,
    command: RenameAccountCommand,
  ): Promise<Readonly<RenameAccountResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordPersonalMindEvent(
        this.#logger,
        "personal_control_denied",
        requestId,
      );
      throw new PersonalMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const displayName = normalizedDisplayName(command?.displayName);
    if (displayName === null) {
      throw new PersonalMindControlFailure(
        "invalid_display_name",
        "A valid display name is required.",
      );
    }
    const expectedProfileVersion = personalProfileVersion(
      command?.expectedProfileVersion,
    );
    const checkedIdempotencyKey = personalProfileIdempotencyKey(
      command?.idempotencyKey,
    );
    const preflight = await this.#personalMinds.readPersonalMindProfile(principalId);
    if (preflight === null) {
      throw new PersonalMindControlFailure(
        "personal_mind_not_found",
        "Personal Mind is unavailable.",
      );
    }
    const canonicalRequestHash = await this.#digest.calculateSha256(
      PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-personal-profile-rename-v1",
        display_name: displayName,
        expected_profile_version: expectedProfileVersion,
      })}\n`),
    );
    try {
      const renamed = await this.#personalMinds.runPersonalMindTransaction(
        (transaction) =>
          transaction.renamePersonalProfile({
            principalId,
            displayName,
            expectedProfileVersion,
            expectedPersonalMetadataVersion:
              preflight.personalMind.metadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: actor.occurredAtUtc,
          }),
      );
      if (renamed.kind === "renamed") {
        recordPersonalMindEvent(
          this.#logger,
          renamed.replayed
            ? "personal_profile_replayed"
            : "personal_profile_renamed",
          requestId,
        );
        return Object.freeze({
          ...personalProfileDescriptor(renamed.profile),
          replayed: renamed.replayed,
        });
      }
      if (renamed.kind === "profile_conflict") {
        recordPersonalMindEvent(
          this.#logger,
          "personal_profile_conflict",
          requestId,
        );
        throw new PersonalMindControlFailure(
          "profile_conflict",
          "Profile metadata changed; re-read and retry.",
        );
      }
      if (renamed.kind === "idempotency_conflict") {
        throw new PersonalMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      throw new PersonalMindControlFailure(
        renamed.kind === "not_found"
          ? "personal_mind_not_found"
          : "personal_mind_unavailable",
        "Personal Mind profile update is unavailable.",
      );
    } catch (error) {
      if (!(error instanceof PersonalMindControlFailure)) {
        recordPersonalMindEvent(
          this.#logger,
          "personal_control_failed",
          requestId,
        );
      }
      throw error;
    }
  }

  /** Must run before any ordinary lifecycle command stages mutations. */
  async guardOrdinaryLifecycle(
    actor: ActorContext,
    command: GuardOrdinaryLifecycleCommand,
  ): Promise<Readonly<OrdinaryLifecycleTarget>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      throw new PersonalMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      !PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS.includes(command.operation) ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0
    ) {
      throw new PersonalMindControlFailure(
        "invalid_lifecycle_operation",
        "The lifecycle operation is invalid.",
      );
    }
    const target = await this.#personalMinds.classifyPersonalMindTarget({
      principalId,
      spaceId: command.mindId,
    });
    if (target.kind === "own_personal") {
      recordPersonalMindEvent(
        this.#logger,
        "personal_lifecycle_denied",
        requestId,
      );
      throw new PersonalMindControlFailure(
        "personal_mind_operation_forbidden",
        "This operation is unavailable for Personal Mind.",
      );
    }
    if (target.kind === "not_found") {
      throw new PersonalMindControlFailure(
        "mind_not_found",
        "Mind was not found.",
      );
    }
    return Object.freeze({ kind: "ordinary", mindId: target.spaceId });
  }
}

export type OrdinaryMindControlFailureCode =
  | "authentication_required"
  | "invalid_display_name"
  | "invalid_handle"
  | "invalid_visibility"
  | "invalid_exposure_acknowledgement"
  | "invalid_metadata_version"
  | "invalid_idempotency_key"
  | "handle_unavailable"
  | "mind_not_found"
  | "personal_mind_operation_forbidden"
  | "forbidden"
  | "exposure_acknowledgement_required"
  | "metadata_conflict"
  | "idempotency_conflict"
  | "visibility_effect_conflict"
  | "invalid_deletion_impact_id"
  | "invalid_confirmation"
  | "deletion_impact_expired"
  | "deletion_impact_changed"
  | "deletion_cleanup_incomplete"
  | "ordinary_mind_conflict"
  | "ordinary_mind_unavailable";

/** Safe failure without private profile, hidden handle, content, or authority claims. */
export class OrdinaryMindControlFailure extends Error {
  readonly code: OrdinaryMindControlFailureCode;

  constructor(code: OrdinaryMindControlFailureCode, message: string) {
    super(message);
    this.name = "OrdinaryMindControlFailure";
    this.code = code;
  }
}

export interface CreateOrdinaryMindCommand {
  readonly name: string;
  readonly handle: string;
  readonly idempotencyKey: string;
}

export interface RenameOrdinaryMindCommand {
  readonly mindId: SpaceId;
  readonly name: string;
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface OrdinaryMindControlDescriptor {
  readonly mindId: SpaceId;
  readonly route: `/${string}`;
  readonly handle: string;
  readonly name: string;
  readonly visibility: "private" | "unlisted" | "public";
  readonly metadataVersion: number;
  readonly accessVersion: number;
  readonly headRevisionId: OrdinaryMindSnapshot["space"]["headRevisionId"];
}

export interface OrdinaryMindMutationResult extends OrdinaryMindControlDescriptor {
  readonly replayed: boolean;
}

export interface OrdinaryMindControlSafeEvent {
  readonly event:
    | "ordinary_mind_created"
    | "ordinary_mind_create_replayed"
    | "ordinary_mind_renamed"
    | "ordinary_mind_rename_replayed"
    | "ordinary_mind_deletion_previewed"
    | "ordinary_mind_deleted"
    | "ordinary_mind_delete_replayed"
    | "ordinary_mind_delete_cleanup_incomplete"
    | "ordinary_mind_conflict"
    | "ordinary_mind_denied"
    | "ordinary_mind_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface OrdinaryMindControlSafeLogger {
  record(event: Readonly<OrdinaryMindControlSafeEvent>): void | Promise<void>;
}

export interface OrdinaryMindControlDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: ObjectStore;
  readonly ids: OrdinaryMindIdGenerator;
  readonly host: VerifiedSpaceHost;
  readonly logger?: OrdinaryMindControlSafeLogger;
}

function ordinaryMindIdempotencyKey(value: unknown) {
  try {
    return personalProfileIdempotencyKey(value);
  } catch (error) {
    if (
      error instanceof PersonalMindControlFailure &&
      error.code === "invalid_idempotency_key"
    ) {
      throw new OrdinaryMindControlFailure(
        "invalid_idempotency_key",
        "A valid idempotency key is required.",
      );
    }
    throw error;
  }
}

function ordinaryMindMetadataVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new OrdinaryMindControlFailure(
      "invalid_metadata_version",
      "A valid expected metadata version is required.",
    );
  }
}

function ordinaryMindActor(actor: ActorContext): Readonly<{
  principalId: PrincipalId;
  occurredAtUtc: UtcInstant;
}> | null {
  const principalId = registeredSitesPrincipal(actor);
  if (principalId === null || parseUtcInstant(actor.occurredAtUtc) === null) {
    return null;
  }
  return Object.freeze({ principalId, occurredAtUtc: actor.occurredAtUtc });
}

function ordinaryMindDescriptor(
  mind: Readonly<OrdinaryMindSnapshot>,
): Readonly<OrdinaryMindControlDescriptor> {
  const space = mind.space;
  return Object.freeze({
    mindId: space.spaceId,
    route: `/${space.spaceHandle}`,
    handle: space.spaceHandle,
    name: space.name,
    visibility: space.visibility,
    metadataVersion: space.metadataVersion,
    accessVersion: space.accessVersion,
    headRevisionId: space.headRevisionId,
  });
}

function recordOrdinaryMindEvent(
  logger: OrdinaryMindControlSafeLogger | undefined,
  event: OrdinaryMindControlSafeEvent["event"],
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
    // Safe observability remains outside the metadata transaction.
  }
}

/** Ordinary Mind create/rename use cases for the trusted Sites control plane. */
export class OrdinaryMindControlService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: ObjectStore;
  readonly #ids: OrdinaryMindIdGenerator;
  readonly #host: VerifiedSpaceHost;
  readonly #logger: OrdinaryMindControlSafeLogger | undefined;

  constructor(dependencies: OrdinaryMindControlDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#ids = dependencies.ids;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
  }

  async createSpaceWithOwner(
    actor: ActorContext,
    command: CreateOrdinaryMindCommand,
  ): Promise<Readonly<OrdinaryMindMutationResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const displayName = normalizedDisplayName(command?.name);
    if (displayName === null) {
      throw new OrdinaryMindControlFailure(
        "invalid_display_name",
        "A valid display name is required.",
      );
    }
    if (isReservedTopLevelRoute(command?.handle)) {
      throw new OrdinaryMindControlFailure(
        "handle_unavailable",
        "The Mind handle is unavailable.",
      );
    }
    const parsedHandle = parseCanonicalSpaceHandle(command?.handle);
    if (parsedHandle.kind !== "valid") {
      throw new OrdinaryMindControlFailure(
        "invalid_handle",
        "A canonical Mind handle is required.",
      );
    }
    if (isReservedTopLevelHandle(parsedHandle.canonicalHandle)) {
      throw new OrdinaryMindControlFailure(
        "handle_unavailable",
        "The Mind handle is unavailable.",
      );
    }
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command?.idempotencyKey,
    );

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-ordinary-mind-create-v1",
          host: this.#host,
          handle: parsedHandle.canonicalHandle,
          display_name: displayName,
        })}\n`),
      );
      const spaceId = this.#ids.nextSpaceId();
      const membershipId = this.#ids.nextMembershipId();
      const revisionId = this.#ids.nextRevisionId();
      const initialFiles = createInitialOrdinaryMindFiles(
        trustedActor.occurredAtUtc,
      );
      const storedObjects = await Promise.all(
        initialFiles.map(async (file) =>
          this.#objects.putImmutable({
            bytes: PERSONAL_PROFILE_ENCODER.encode(file.text),
            mediaType: MARKDOWN_MEDIA_TYPE,
            createdAt: trustedActor.occurredAtUtc,
          }),
        ),
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
        PERSONAL_PROFILE_ENCODER.encode(serializeRevisionManifest(manifest)),
      );
      const initialRevision = createCanonicalRevisionEnvelope({
        revisionId,
        spaceId,
        revisionNumber: 1,
        parentRevisionId: null,
        committedAt: trustedActor.occurredAtUtc,
        committedBy: {
          kind: "principal",
          principalId: trustedActor.principalId,
        },
        manifest,
        manifestHash,
        summary: "Create Mind",
      });
      const records = Object.freeze({
        host: this.#host,
        space: Object.freeze({
          spaceId,
          spaceHandle: parsedHandle.canonicalHandle,
          normalizedHandle: parsedHandle.canonicalHandle,
          name: displayName,
          visibility: "private" as const,
          state: "active" as const,
          metadataVersion: version(1),
          accessVersion: version(1),
          headRevisionId: revisionId,
          createdAt: trustedActor.occurredAtUtc,
          updatedAt: trustedActor.occurredAtUtc,
        }),
        ownerMembership: Object.freeze({
          membershipId,
          spaceId,
          principalId: trustedActor.principalId,
          role: "owner" as const,
          state: "active" as const,
          version: version(1),
          createdAt: trustedActor.occurredAtUtc,
          createdBy: trustedActor.principalId,
          updatedAt: trustedActor.occurredAtUtc,
          updatedBy: trustedActor.principalId,
        }),
        initialRevision,
        idempotencyKey: checkedIdempotencyKey,
        canonicalRequestHash,
      });
      const created = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) => transaction.createOrdinaryMind(records),
      );
      if (created.kind === "created") {
        recordOrdinaryMindEvent(
          this.#logger,
          created.replayed
            ? "ordinary_mind_create_replayed"
            : "ordinary_mind_created",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(created.mind),
          replayed: created.replayed,
        });
      }
      if (created.kind === "handle_unavailable") {
        throw new OrdinaryMindControlFailure(
          "handle_unavailable",
          "The Mind handle is unavailable.",
        );
      }
      if (created.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (created.kind === "principal_not_found") {
        throw new OrdinaryMindControlFailure(
          "authentication_required",
          "A registered Sites principal is required.",
        );
      }
      if (created.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure(
          "mind_not_found",
          "Mind was not found.",
        );
      }
      if (created.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current Mind settings access is required.",
        );
      }
      throw new OrdinaryMindControlFailure(
        created.kind === "record_conflict"
          ? "ordinary_mind_conflict"
          : "ordinary_mind_unavailable",
        "Mind creation is unavailable.",
      );
    } catch (error) {
      if (error instanceof OrdinaryMindControlFailure) {
        if (
          error.code === "handle_unavailable" ||
          error.code === "idempotency_conflict" ||
          error.code === "ordinary_mind_conflict"
        ) {
          recordOrdinaryMindEvent(
            this.#logger,
            "ordinary_mind_conflict",
            requestId,
          );
        }
      } else {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }

  async renameSpace(
    actor: ActorContext,
    command: RenameOrdinaryMindCommand,
  ): Promise<Readonly<OrdinaryMindMutationResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0
    ) {
      throw new OrdinaryMindControlFailure(
        "mind_not_found",
        "Mind was not found.",
      );
    }
    const displayName = normalizedDisplayName(command.name);
    if (displayName === null) {
      throw new OrdinaryMindControlFailure(
        "invalid_display_name",
        "A valid display name is required.",
      );
    }
    const expectedMetadataVersion = ordinaryMindMetadataVersion(
      command.expectedMetadataVersion,
    );
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command.idempotencyKey,
    );

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-ordinary-mind-rename-v1",
          mind_id: command.mindId,
          display_name: displayName,
          expected_metadata_version: expectedMetadataVersion,
        })}\n`),
      );
      const renamed = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.renameOrdinaryMind({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            displayName,
            expectedMetadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
          }),
      );
      if (renamed.kind === "renamed") {
        recordOrdinaryMindEvent(
          this.#logger,
          renamed.replayed
            ? "ordinary_mind_rename_replayed"
            : "ordinary_mind_renamed",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(renamed.mind),
          replayed: renamed.replayed,
        });
      }
      if (renamed.kind === "metadata_conflict") {
        throw new OrdinaryMindControlFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (renamed.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (renamed.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "This operation is unavailable for Personal Mind.",
        );
      }
      if (renamed.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure(
          "mind_not_found",
          "Mind was not found.",
        );
      }
      if (renamed.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current Mind settings access is required.",
        );
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind rename is unavailable.",
      );
    } catch (error) {
      if (error instanceof OrdinaryMindControlFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "idempotency_conflict"
        ) {
          recordOrdinaryMindEvent(
            this.#logger,
            "ordinary_mind_conflict",
            requestId,
          );
        } else if (
          error.code === "forbidden" ||
          error.code === "personal_mind_operation_forbidden"
        ) {
          recordOrdinaryMindEvent(
            this.#logger,
            "ordinary_mind_denied",
            requestId,
          );
        }
      } else {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }
}

export const MIND_DELETION_IMPACT_LIFETIME_MINUTES = 15 as const;
const DELETION_IMPACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface GetOrdinaryMindDeletionImpactQuery {
  readonly handle: string;
}

export interface OrdinaryMindDeletionImpactDescriptor {
  readonly impactId: string;
  readonly expiresAt: UtcInstant;
  readonly mind: Readonly<{
    readonly route: `/${string}`;
    readonly name: string;
  }>;
  readonly revisionCount: number;
  readonly membershipCount: number;
  readonly pendingInvitationCount: number;
  readonly backgroundJobCount: number;
  readonly exportJobCount: number;
  readonly irreversible: true;
  readonly recoveryAvailable: false;
  readonly forensicReceiptRetained: false;
  readonly confirmation: `delete-mind:${string}`;
}

export interface DeleteOrdinaryMindCommand {
  readonly handle: string;
  readonly impactId: string;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export interface OrdinaryMindDeletionResult {
  readonly replayed: boolean;
  readonly canonicalObjectsDeleted: number;
  readonly canonicalObjectsRetained: number;
  readonly indexedRevisionsDeleted: number;
  readonly deliveredAuditEventsDeleted: number;
  readonly exportArchivesDeleted: number;
}

export interface OrdinaryMindDeletionDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: ObjectStore;
  readonly index: SearchIndex;
  readonly audit: AuditSink;
  readonly exportArchives: ExportArchiveStore;
  readonly ids: OrdinaryMindDeletionIdGenerator;
  readonly clock: Clock;
  readonly host: VerifiedSpaceHost;
  readonly logger?: OrdinaryMindControlSafeLogger;
}

function deletionHandle(value: unknown): string | null {
  if (isReservedTopLevelRoute(value)) return null;
  const parsed = parseCanonicalSpaceHandle(value);
  return parsed.kind === "valid" &&
    !isReservedTopLevelHandle(parsed.canonicalHandle) &&
    parsed.canonicalHandle === value
    ? parsed.canonicalHandle
    : null;
}

function deletionImpactId(value: unknown): string {
  if (typeof value !== "string" || !DELETION_IMPACT_ID_PATTERN.test(value)) {
    throw new OrdinaryMindControlFailure(
      "invalid_deletion_impact_id",
      "A valid deletion impact ID is required.",
    );
  }
  return value;
}

function deletionConfirmation(handle: string): `delete-mind:${string}` {
  return `delete-mind:${handle}`;
}

/** Owner-only irreversible ordinary-Mind deletion and crash-resumable cleanup. */
export class OrdinaryMindDeletionService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: ObjectStore;
  readonly #index: SearchIndex;
  readonly #audit: AuditSink;
  readonly #exportArchives: ExportArchiveStore;
  readonly #ids: OrdinaryMindDeletionIdGenerator;
  readonly #clock: Clock;
  readonly #host: VerifiedSpaceHost;
  readonly #logger: OrdinaryMindControlSafeLogger | undefined;

  constructor(dependencies: OrdinaryMindDeletionDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#index = dependencies.index;
    this.#audit = dependencies.audit;
    this.#exportArchives = dependencies.exportArchives;
    this.#ids = dependencies.ids;
    this.#clock = dependencies.clock;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
  }

  async getDeletionImpact(
    actor: ActorContext,
    query: GetOrdinaryMindDeletionImpactQuery,
  ): Promise<Readonly<OrdinaryMindDeletionImpactDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (query?.handle === "me") {
      throw new OrdinaryMindControlFailure(
        "personal_mind_operation_forbidden",
        "Personal Mind cannot be deleted separately.",
      );
    }
    const handle = deletionHandle(query?.handle);
    if (handle === null) {
      throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
    }
    const now = parseUtcInstant(this.#clock.now());
    if (now === null) {
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion impact is unavailable.",
      );
    }
    const impactId = deletionImpactId(this.#ids.nextImpactId());
    const occurredAt = canonicalUtcInstant(now);
    const expiresAt = canonicalUtcInstant(
      now + MIND_DELETION_IMPACT_LIFETIME_MINUTES * 60_000,
    );
    try {
      const created = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.createOrdinaryMindDeletionImpact({
            principalId: trustedActor.principalId,
            host: this.#host,
            handle,
            impactId,
            occurredAt,
            expiresAt,
          }),
      );
      if (created.kind === "created") {
        const impact = created.impact;
        recordOrdinaryMindEvent(
          this.#logger,
          "ordinary_mind_deletion_previewed",
          requestId,
        );
        return Object.freeze({
          impactId: impact.impactId,
          expiresAt: impact.expiresAt,
          mind: Object.freeze({ route: `/${handle}`, name: impact.name }),
          revisionCount: impact.revisionCount,
          membershipCount: impact.membershipCount,
          pendingInvitationCount: impact.invitationCount,
          backgroundJobCount: impact.backgroundJobCount,
          exportJobCount: impact.exportJobCount,
          irreversible: true,
          recoveryAvailable: false,
          forensicReceiptRetained: false,
          confirmation: deletionConfirmation(handle),
        });
      }
      if (created.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind cannot be deleted separately.",
        );
      }
      if (created.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current active Owner deletion access is required.",
        );
      }
      if (created.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion impact is unavailable.",
      );
    } catch (error) {
      if (!(error instanceof OrdinaryMindControlFailure)) {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }

  async deleteSpace(
    actor: ActorContext,
    command: DeleteOrdinaryMindCommand,
  ): Promise<Readonly<OrdinaryMindDeletionResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (command?.handle === "me") {
      throw new OrdinaryMindControlFailure(
        "personal_mind_operation_forbidden",
        "Personal Mind cannot be deleted separately.",
      );
    }
    const handle = deletionHandle(command?.handle);
    if (handle === null) {
      throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
    }
    const impactId = deletionImpactId(command?.impactId);
    if (command?.confirmation !== deletionConfirmation(handle)) {
      throw new OrdinaryMindControlFailure(
        "invalid_confirmation",
        "The exact Mind deletion confirmation is required.",
      );
    }
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command?.idempotencyKey,
    );
    const nowValue = this.#clock.now();
    if (parseUtcInstant(nowValue) === null) {
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion is unavailable.",
      );
    }
    try {
      const deleted = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.deleteOrdinaryMind({
            principalId: trustedActor.principalId,
            host: this.#host,
            handle,
            impactId,
            idempotencyKey: checkedIdempotencyKey,
            occurredAt: nowValue,
          }),
      );
      if (deleted.kind === "already_absent") {
        return Object.freeze({
          replayed: true,
          canonicalObjectsDeleted: 0,
          canonicalObjectsRetained: 0,
          indexedRevisionsDeleted: 0,
          deliveredAuditEventsDeleted: 0,
          exportArchivesDeleted: 0,
        });
      }
      if (deleted.kind === "deleted" || deleted.kind === "cleanup_pending") {
        const cleanupResult = await this.#completeCleanup(deleted.cleanup);
        recordOrdinaryMindEvent(
          this.#logger,
          deleted.kind === "cleanup_pending"
            ? "ordinary_mind_delete_replayed"
            : "ordinary_mind_deleted",
          requestId,
        );
        return Object.freeze({
          replayed: deleted.kind === "cleanup_pending",
          ...cleanupResult,
        });
      }
      if (deleted.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind cannot be deleted separately.",
        );
      }
      if (deleted.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current active Owner deletion access is required.",
        );
      }
      if (deleted.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
      }
      if (deleted.kind === "deletion_impact_expired") {
        throw new OrdinaryMindControlFailure(
          "deletion_impact_expired",
          "Deletion impact expired; request a new preview.",
        );
      }
      if (deleted.kind === "deletion_impact_changed") {
        throw new OrdinaryMindControlFailure(
          "deletion_impact_changed",
          "Deletion impact changed; request a new preview.",
        );
      }
      if (deleted.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind deletion is unavailable.",
      );
    } catch (error) {
      if (
        error instanceof OrdinaryMindControlFailure &&
        error.code === "deletion_cleanup_incomplete"
      ) {
        recordOrdinaryMindEvent(
          this.#logger,
          "ordinary_mind_delete_cleanup_incomplete",
          requestId,
        );
      } else if (!(error instanceof OrdinaryMindControlFailure)) {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }

  async #completeCleanup(
    work: Readonly<OrdinaryMindDeletionCleanupWorkItem>,
  ): Promise<Omit<OrdinaryMindDeletionResult, "replayed">> {
    try {
      const indexedRevisionsDeleted = await this.#index.purgeSpace(work.spaceId);
      const deliveredAuditEventsDeleted = await this.#audit.purgeSpace(work.spaceId);
      const exportArchivesDeleted =
        await this.#exportArchives.deleteExportArchivesForSpace(work.spaceId);
      const reachable = new Set(
        await this.#ordinaryMinds.listReachableObjectDigests(),
      );
      let canonicalObjectsDeleted = 0;
      let canonicalObjectsRetained = 0;
      for (const digest of work.objectDigests) {
        if (reachable.has(digest)) {
          canonicalObjectsRetained += 1;
          continue;
        }
        const object = await this.#objects.getImmutable(digest);
        if (object === null) continue;
        if (Date.parse(object.protectedAt) >= Date.parse(work.deleteBefore)) {
          canonicalObjectsRetained += 1;
          continue;
        }
        const removed = await this.#objects.deleteImmutableObject({
          sha256: digest,
          expectedProtectedAt: object.protectedAt,
          createdBefore: work.deleteBefore,
        });
        if (removed) canonicalObjectsDeleted += 1;
        else canonicalObjectsRetained += 1;
      }
      const completed = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.completeOrdinaryMindDeletionCleanup({
            impactId: work.impactId,
            spaceId: work.spaceId,
            host: work.host,
            handle: work.canonicalHandle,
          }),
      );
      if (completed.kind !== "completed") {
        throw new Error("deletion cleanup work item changed");
      }
      return Object.freeze({
        canonicalObjectsDeleted,
        canonicalObjectsRetained,
        indexedRevisionsDeleted,
        deliveredAuditEventsDeleted,
        exportArchivesDeleted,
      });
    } catch (error) {
      throw new OrdinaryMindControlFailure(
        "deletion_cleanup_incomplete",
        "Mind deletion cleanup is incomplete; retry the exact command.",
      );
    }
  }
}

export const ACCOUNT_DELETION_IMPACT_LIFETIME_MINUTES = 15 as const;
export const ACCOUNT_DELETION_CONFIRMATION = "delete-account" as const;

export type AccountDeletionFailureCode =
  | "authentication_required"
  | "invalid_deletion_impact_id"
  | "invalid_confirmation"
  | "invalid_idempotency_key"
  | "account_not_found"
  | "deletion_impact_expired"
  | "deletion_impact_changed"
  | "idempotency_conflict"
  | "deletion_cleanup_incomplete"
  | "account_deletion_unavailable";

/** Safe failure without identity binding, email, profile or content. */
export class AccountDeletionFailure extends Error {
  readonly code: AccountDeletionFailureCode;

  constructor(code: AccountDeletionFailureCode, message: string) {
    super(message);
    this.name = "AccountDeletionFailure";
    this.code = code;
  }
}

export interface AccountDeletionImpactDescriptor {
  readonly impactId: string;
  readonly expiresAt: UtcInstant;
  readonly personalMind: Readonly<{ readonly route: "/me"; readonly name: string }>;
  readonly ownedMinds: readonly Readonly<{
    readonly route: `/${string}`;
    readonly name: string;
  }>[];
  readonly foreignMembershipCount: number;
  readonly pendingInvitationCount: number;
  readonly activeMcpTokenCount: number;
  readonly irreversible: true;
  readonly recoveryAvailable: false;
  readonly forensicReceiptRetained: false;
  readonly confirmation: typeof ACCOUNT_DELETION_CONFIRMATION;
}

export interface DeleteAccountCommand {
  readonly impactId: string;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export interface AccountDeletionResult {
  readonly replayed: boolean;
  readonly spacesDeleted: number;
  readonly tokensRevoked: number;
  readonly canonicalObjectsDeleted: number;
  readonly canonicalObjectsRetained: number;
  readonly indexedRevisionsDeleted: number;
  readonly deliveredAuditEventsDeleted: number;
  readonly deliveredAuditActorsTombstoned: number;
  readonly exportArchivesDeleted: number;
}

export interface AccountDeletionSafeEvent {
  readonly event:
    | "account_deletion_previewed"
    | "account_deleted"
    | "account_delete_replayed"
    | "account_delete_conflict"
    | "account_delete_cleanup_incomplete"
    | "account_delete_denied"
    | "account_delete_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface AccountDeletionSafeLogger {
  record(event: Readonly<AccountDeletionSafeEvent>): void | Promise<void>;
}

export interface AccountDeletionDependencies {
  readonly accounts: AccountDeletionStore;
  readonly tokens: McpTokenStore;
  readonly objects: ObjectStore;
  readonly index: SearchIndex;
  readonly audit: AuditSink;
  readonly exportArchives: ExportArchiveStore;
  readonly ids: AccountDeletionIdGenerator;
  readonly clock: Clock;
  readonly host: VerifiedSpaceHost;
  readonly logger?: AccountDeletionSafeLogger;
}

function accountDeletionImpactId(value: unknown): string {
  if (typeof value !== "string" || !DELETION_IMPACT_ID_PATTERN.test(value)) {
    throw new AccountDeletionFailure(
      "invalid_deletion_impact_id",
      "A valid account deletion impact ID is required.",
    );
  }
  return value;
}

function accountDeletedPrincipalId(value: unknown): DeletedPrincipalId {
  if (typeof value !== "string" || !DELETION_IMPACT_ID_PATTERN.test(value)) {
    throw new AccountDeletionFailure(
      "account_deletion_unavailable",
      "Account deletion identity is unavailable.",
    );
  }
  return value as DeletedPrincipalId;
}

function accountDeletionIdempotencyKey(value: unknown): IdempotencyKey {
  try {
    return ordinaryMindIdempotencyKey(value);
  } catch (error) {
    if (
      error instanceof OrdinaryMindControlFailure &&
      error.code === "invalid_idempotency_key"
    ) {
      throw new AccountDeletionFailure(
        "invalid_idempotency_key",
        "A valid account deletion idempotency key is required.",
      );
    }
    throw error;
  }
}

function recordAccountDeletionEvent(
  logger: AccountDeletionSafeLogger | undefined,
  event: AccountDeletionSafeEvent["event"],
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
    // Safe observability is outside the authoritative cascade.
  }
}

/** Irreversible account preview/cascade with retryable external cleanup. */
export class AccountDeletionService {
  readonly #accounts: AccountDeletionStore;
  readonly #tokens: McpTokenStore;
  readonly #objects: ObjectStore;
  readonly #index: SearchIndex;
  readonly #audit: AuditSink;
  readonly #exportArchives: ExportArchiveStore;
  readonly #ids: AccountDeletionIdGenerator;
  readonly #clock: Clock;
  readonly #host: VerifiedSpaceHost;
  readonly #logger: AccountDeletionSafeLogger | undefined;

  constructor(dependencies: AccountDeletionDependencies) {
    this.#accounts = dependencies.accounts;
    this.#tokens = dependencies.tokens;
    this.#objects = dependencies.objects;
    this.#index = dependencies.index;
    this.#audit = dependencies.audit;
    this.#exportArchives = dependencies.exportArchives;
    this.#ids = dependencies.ids;
    this.#clock = dependencies.clock;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
  }

  async getAccountDeletionImpact(
    actor: ActorContext,
  ): Promise<Readonly<AccountDeletionImpactDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordAccountDeletionEvent(this.#logger, "account_delete_denied", requestId);
      throw new AccountDeletionFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const now = parseUtcInstant(this.#clock.now());
    if (now === null) {
      throw new AccountDeletionFailure(
        "account_deletion_unavailable",
        "Account deletion impact is unavailable.",
      );
    }
    const occurredAt = canonicalUtcInstant(now);
    const tokenSnapshot = await this.#tokens.readPrincipalTokenDeletionSnapshot(
      principalId,
      occurredAt,
    );
    const impactId = accountDeletionImpactId(this.#ids.nextImpactId());
    const deletedPrincipalId = accountDeletedPrincipalId(
      this.#ids.nextDeletedPrincipalId(),
    );
    const expiresAt = canonicalUtcInstant(
      now + ACCOUNT_DELETION_IMPACT_LIFETIME_MINUTES * 60_000,
    );
    try {
      const created = await this.#accounts.runAccountDeletionTransaction(
        (transaction) =>
          transaction.createAccountDeletionImpact({
            principalId,
            host: this.#host,
            impactId,
            deletedPrincipalId,
            occurredAt,
            expiresAt,
            activeTokenCount: tokenSnapshot.activeTokenCount,
            tokenStateFingerprint: tokenSnapshot.stateFingerprint,
          }),
      );
      if (created.kind !== "created") {
        throw new AccountDeletionFailure(
          created.kind === "account_not_found"
            ? "account_not_found"
            : "account_deletion_unavailable",
          "Account deletion impact is unavailable.",
        );
      }
      const impact = created.impact;
      recordAccountDeletionEvent(
        this.#logger,
        "account_deletion_previewed",
        requestId,
      );
      return Object.freeze({
        impactId: impact.impactId,
        expiresAt: impact.expiresAt,
        personalMind: Object.freeze({
          route: "/me" as const,
          name: impact.personalMind.name,
        }),
        ownedMinds: Object.freeze(
          impact.ownedMinds.map((mind) =>
            Object.freeze({ route: `/${mind.canonicalHandle}` as const, name: mind.name }),
          ),
        ),
        foreignMembershipCount: impact.foreignMembershipCount,
        pendingInvitationCount: impact.pendingInvitationCount,
        activeMcpTokenCount: impact.activeTokenCount,
        irreversible: true,
        recoveryAvailable: false,
        forensicReceiptRetained: false,
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
      });
    } catch (error) {
      if (!(error instanceof AccountDeletionFailure)) {
        recordAccountDeletionEvent(this.#logger, "account_delete_failed", requestId);
      }
      throw error;
    }
  }

  async deleteAccount(
    actor: ActorContext,
    command: DeleteAccountCommand,
  ): Promise<Readonly<AccountDeletionResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordAccountDeletionEvent(this.#logger, "account_delete_denied", requestId);
      throw new AccountDeletionFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const impactId = accountDeletionImpactId(command?.impactId);
    if (command?.confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
      throw new AccountDeletionFailure(
        "invalid_confirmation",
        "The exact account deletion confirmation is required.",
      );
    }
    const checkedIdempotencyKey = accountDeletionIdempotencyKey(
      command?.idempotencyKey,
    );
    const now = parseUtcInstant(this.#clock.now());
    if (now === null) {
      throw new AccountDeletionFailure(
        "account_deletion_unavailable",
        "Account deletion is unavailable.",
      );
    }
    const occurredAt = canonicalUtcInstant(now);
    const context = await this.#accounts.readAccountDeletionContext(
      principalId,
      impactId,
    );
    if (context === null) {
      throw new AccountDeletionFailure(
        "deletion_impact_changed",
        "Deletion impact changed; request a new preview.",
      );
    }
    const tokenStateFingerprint =
      context.kind === "impact"
        ? context.impact.tokenStateFingerprint
        : context.cleanup.tokenStateFingerprint;
    const deletedPrincipalId =
      context.kind === "cleanup"
        ? context.cleanup.deletedPrincipalId
        : context.impact.deletedPrincipalId;
    const tokenReservation = await this.#tokens.beginPrincipalTokenDeletion({
      principalId,
      expectedStateFingerprint: tokenStateFingerprint,
      occurredAt,
    });
    if (
      tokenReservation.kind === "state_changed" ||
      (tokenReservation.kind === "principal_deleted" && context.kind !== "cleanup")
    ) {
      recordAccountDeletionEvent(this.#logger, "account_delete_conflict", requestId);
      throw new AccountDeletionFailure(
        "deletion_impact_changed",
        "Deletion impact changed; request a new preview.",
      );
    }
    let metadataCommitted = context.kind === "cleanup";
    try {
      const deleted = await this.#accounts.runAccountDeletionTransaction(
        (transaction) =>
          transaction.deleteAccountCascade({
            principalId,
            impactId,
            idempotencyKey: checkedIdempotencyKey,
            deletedPrincipalId,
            tokenStateFingerprint,
            occurredAt,
          }),
      );
      if (deleted.kind === "deleted" || deleted.kind === "cleanup_pending") {
        metadataCommitted = true;
        const cleanup = await this.#completeCleanup(deleted.cleanup, occurredAt);
        recordAccountDeletionEvent(
          this.#logger,
          deleted.kind === "cleanup_pending"
            ? "account_delete_replayed"
            : "account_deleted",
          requestId,
        );
        return Object.freeze({
          replayed: deleted.kind === "cleanup_pending" || cleanup.tokenReplay,
          spacesDeleted: deleted.cleanup.deletedSpaceIds.length,
          tokensRevoked: cleanup.tokensRevoked,
          canonicalObjectsDeleted: cleanup.canonicalObjectsDeleted,
          canonicalObjectsRetained: cleanup.canonicalObjectsRetained,
          indexedRevisionsDeleted: cleanup.indexedRevisionsDeleted,
          deliveredAuditEventsDeleted: cleanup.deliveredAuditEventsDeleted,
          deliveredAuditActorsTombstoned:
            cleanup.deliveredAuditActorsTombstoned,
          exportArchivesDeleted: cleanup.exportArchivesDeleted,
        });
      }
      if (!metadataCommitted) {
        await this.#tokens.cancelPrincipalTokenDeletion({
          principalId,
          expectedStateFingerprint: tokenStateFingerprint,
        });
      }
      if (deleted.kind === "deletion_impact_expired") {
        throw new AccountDeletionFailure(
          "deletion_impact_expired",
          "Deletion impact expired; request a new preview.",
        );
      }
      if (deleted.kind === "deletion_impact_changed") {
        throw new AccountDeletionFailure(
          "deletion_impact_changed",
          "Deletion impact changed; request a new preview.",
        );
      }
      if (deleted.kind === "idempotency_conflict") {
        throw new AccountDeletionFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      throw new AccountDeletionFailure(
        deleted.kind === "account_not_found"
          ? "account_not_found"
          : "account_deletion_unavailable",
        "Account deletion is unavailable.",
      );
    } catch (error) {
      if (!metadataCommitted) {
        await this.#tokens.cancelPrincipalTokenDeletion({
          principalId,
          expectedStateFingerprint: tokenStateFingerprint,
        });
      }
      if (
        error instanceof AccountDeletionFailure &&
        error.code === "deletion_cleanup_incomplete"
      ) {
        recordAccountDeletionEvent(
          this.#logger,
          "account_delete_cleanup_incomplete",
          requestId,
        );
      } else if (!(error instanceof AccountDeletionFailure)) {
        recordAccountDeletionEvent(this.#logger, "account_delete_failed", requestId);
      }
      throw error;
    }
  }

  async #completeCleanup(
    work: Readonly<AccountDeletionCleanupWorkItem>,
    occurredAt: UtcInstant,
  ): Promise<Readonly<{
    tokenReplay: boolean;
    tokensRevoked: number;
    canonicalObjectsDeleted: number;
    canonicalObjectsRetained: number;
    indexedRevisionsDeleted: number;
    deliveredAuditEventsDeleted: number;
    deliveredAuditActorsTombstoned: number;
    exportArchivesDeleted: number;
  }>> {
    try {
      const tokenResult = await this.#tokens.completePrincipalTokenDeletion({
        principalId: work.principalId,
        expectedStateFingerprint: work.tokenStateFingerprint,
        revokedAt: occurredAt,
      });
      if (tokenResult.kind !== "completed") {
        throw new Error("account token deletion reservation changed");
      }
      let indexedRevisionsDeleted = 0;
      let deliveredAuditEventsDeleted = 0;
      let exportArchivesDeleted = 0;
      for (const spaceId of work.deletedSpaceIds) {
        indexedRevisionsDeleted += await this.#index.purgeSpace(spaceId);
        deliveredAuditEventsDeleted += await this.#audit.purgeSpace(spaceId);
        exportArchivesDeleted +=
          await this.#exportArchives.deleteExportArchivesForSpace(spaceId);
      }
      const deliveredAuditActorsTombstoned =
        await this.#audit.tombstonePrincipal(
          work.principalId,
          work.deletedPrincipalId,
        );
      for (const jobId of work.foreignExportJobIds) {
        exportArchivesDeleted +=
          await this.#exportArchives.deleteExportArchivesForJob(jobId);
      }
      const reachable = new Set(await this.#accounts.listReachableObjectDigests());
      let canonicalObjectsDeleted = 0;
      let canonicalObjectsRetained = 0;
      for (const digest of work.objectDigests) {
        if (reachable.has(digest)) {
          canonicalObjectsRetained += 1;
          continue;
        }
        const object = await this.#objects.getImmutable(digest);
        if (object === null) continue;
        if (Date.parse(object.protectedAt) >= Date.parse(work.deleteBefore)) {
          canonicalObjectsRetained += 1;
          continue;
        }
        const removed = await this.#objects.deleteImmutableObject({
          sha256: digest,
          expectedProtectedAt: object.protectedAt,
          createdBefore: work.deleteBefore,
        });
        if (removed) canonicalObjectsDeleted += 1;
        else canonicalObjectsRetained += 1;
      }
      const completed = await this.#accounts.runAccountDeletionTransaction(
        (transaction) =>
          transaction.completeAccountDeletionCleanup({
            impactId: work.impactId,
            principalId: work.principalId,
          }),
      );
      if (completed.kind !== "completed") {
        const [context, account] = await Promise.all([
          this.#accounts.readAccountDeletionContext(
            work.principalId,
            work.impactId,
          ),
          this.#accounts.readAccount(work.principalId),
        ]);
        if (context !== null || account !== null) {
          throw new Error("account deletion cleanup work item changed");
        }
      }
      return Object.freeze({
        tokenReplay: tokenResult.replayed,
        tokensRevoked: tokenResult.revokedCount,
        canonicalObjectsDeleted,
        canonicalObjectsRetained,
        indexedRevisionsDeleted,
        deliveredAuditEventsDeleted,
        deliveredAuditActorsTombstoned,
        exportArchivesDeleted,
      });
    } catch {
      throw new AccountDeletionFailure(
        "deletion_cleanup_incomplete",
        "Account deletion cleanup is incomplete; retry the exact command.",
      );
    }
  }
}

export interface ChangeVisibilityCommand {
  readonly mindId: SpaceId;
  readonly visibility: Visibility;
  readonly acknowledgeLiveHeadAndHistoryExposure?: boolean;
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface VisibilityMutationResult extends OrdinaryMindControlDescriptor {
  readonly changed: boolean;
  readonly replayed: boolean;
}

export interface VisibilityControlSafeEvent {
  readonly event:
    | "visibility_changed"
    | "visibility_noop"
    | "visibility_replayed"
    | "visibility_conflict"
    | "visibility_denied"
    | "visibility_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface VisibilityControlSafeLogger {
  record(event: Readonly<VisibilityControlSafeEvent>): void | Promise<void>;
}

export interface VisibilityControlDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: ObjectStore;
  readonly auditIds: VisibilityAuditIdGenerator;
  readonly logger?: VisibilityControlSafeLogger;
}

function visibilityValue(value: unknown): Visibility | null {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : null;
}

function recordVisibilityEvent(
  logger: VisibilityControlSafeLogger | undefined,
  event: VisibilityControlSafeEvent["event"],
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
    // Safe observability is outside the authoritative metadata transaction.
  }
}

function visibilityAuthorizationFailure(
  code: string,
): OrdinaryMindControlFailure {
  if (
    code === "authorization_state_unavailable" ||
    code === "access_denied"
  ) {
    return new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
  }
  return new OrdinaryMindControlFailure(
    "forbidden",
    "Current active Owner visibility access is required.",
  );
}

/** Owner-only visibility transitions and baseline-grant epoch changes. */
export class VisibilityControlService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: ObjectStore;
  readonly #auditIds: VisibilityAuditIdGenerator;
  readonly #logger: VisibilityControlSafeLogger | undefined;

  constructor(dependencies: VisibilityControlDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#auditIds = dependencies.auditIds;
    this.#logger = dependencies.logger;
  }

  async changeVisibility(
    actor: ActorContext,
    command: ChangeVisibilityCommand,
  ): Promise<Readonly<VisibilityMutationResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordVisibilityEvent(this.#logger, "visibility_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0
    ) {
      throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
    }
    const visibility = visibilityValue(command.visibility);
    if (visibility === null) {
      throw new OrdinaryMindControlFailure(
        "invalid_visibility",
        "Visibility must be private, unlisted, or public.",
      );
    }
    if (
      command.acknowledgeLiveHeadAndHistoryExposure !== undefined &&
      typeof command.acknowledgeLiveHeadAndHistoryExposure !== "boolean"
    ) {
      throw new OrdinaryMindControlFailure(
        "invalid_exposure_acknowledgement",
        "The exposure acknowledgement must be a boolean.",
      );
    }
    const expectedMetadataVersion = ordinaryMindMetadataVersion(
      command.expectedMetadataVersion,
    );
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command.idempotencyKey,
    );
    const acknowledgeLiveHeadAndHistoryExposure =
      command.acknowledgeLiveHeadAndHistoryExposure ?? false;

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-visibility-change-v1",
          mind_id: command.mindId,
          visibility,
          expected_metadata_version: expectedMetadataVersion,
          acknowledge_live_head_and_history_exposure:
            acknowledgeLiveHeadAndHistoryExposure,
        })}\n`),
      );
      const changed = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        async (transaction) => {
          const authorization = await new CapabilityAuthorizer(
            transaction,
          ).authorize({
            actor,
            spaceId: command.mindId,
            capability: "visibility:change",
            revisionMode: "head",
          });
          if (authorization.kind === "denied") {
            throw visibilityAuthorizationFailure(authorization.code);
          }
          if (
            authorization.grant.kind !== "membership" ||
            authorization.grant.role !== "owner"
          ) {
            throw new OrdinaryMindControlFailure(
              "forbidden",
              "Current active Owner visibility access is required.",
            );
          }
          return transaction.changeOrdinaryMindVisibility({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            visibility,
            acknowledgeLiveHeadAndHistoryExposure:
              acknowledgeLiveHeadAndHistoryExposure,
            expectedMetadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
            requestId,
            auditEventId: this.#auditIds.nextAuditEventId(),
            auditOutboxMessageId: this.#auditIds.nextOutboxMessageId(),
          });
        },
      );
      if (changed.kind === "visibility_changed") {
        recordVisibilityEvent(
          this.#logger,
          changed.replayed
            ? "visibility_replayed"
            : changed.changed
              ? "visibility_changed"
              : "visibility_noop",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(changed.mind),
          changed: changed.changed,
          replayed: changed.replayed,
        });
      }
      if (changed.kind === "metadata_conflict") {
        throw new OrdinaryMindControlFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (changed.kind === "exposure_acknowledgement_required") {
        throw new OrdinaryMindControlFailure(
          "exposure_acknowledgement_required",
          "Acknowledge exposure of live HEAD and immutable history.",
        );
      }
      if (changed.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (changed.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind visibility cannot change.",
        );
      }
      if (changed.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure("mind_not_found", "Mind was not found.");
      }
      if (changed.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current active Owner visibility access is required.",
        );
      }
      if (changed.kind === "effect_conflict") {
        throw new OrdinaryMindControlFailure(
          "visibility_effect_conflict",
          "Visibility audit effects conflict.",
        );
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Visibility change is unavailable.",
      );
    } catch (error) {
      if (error instanceof OrdinaryMindControlFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "idempotency_conflict" ||
          error.code === "visibility_effect_conflict"
        ) {
          recordVisibilityEvent(this.#logger, "visibility_conflict", requestId);
        } else if (
          error.code === "forbidden" ||
          error.code === "mind_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "exposure_acknowledgement_required"
        ) {
          recordVisibilityEvent(this.#logger, "visibility_denied", requestId);
        }
      } else {
        recordVisibilityEvent(this.#logger, "visibility_failed", requestId);
      }
      throw error;
    }
  }
}

export const OWNERSHIP_TRANSFER_CONFIRMATION = "transfer-ownership" as const;

export interface TransferOwnershipCommand {
  readonly mindId: SpaceId;
  readonly targetMemberId: MembershipId;
  readonly expectedMetadataVersion: number;
  readonly confirmation: typeof OWNERSHIP_TRANSFER_CONFIRMATION;
  readonly idempotencyKey: string;
}

export interface OwnershipTransferDescriptor
  extends OrdinaryMindControlDescriptor {
  readonly sourceMemberId: MembershipId;
  readonly sourceRole: "admin";
  readonly sourceMembershipVersion: number;
  readonly targetMemberId: MembershipId;
  readonly targetRole: "owner";
  readonly targetMembershipVersion: number;
  readonly replayed: boolean;
}

export type OwnershipTransferFailureCode =
  | "authentication_required"
  | "invalid_target_member_id"
  | "invalid_metadata_version"
  | "invalid_confirmation"
  | "invalid_idempotency_key"
  | "mind_not_found"
  | "personal_mind_operation_forbidden"
  | "forbidden"
  | "ownership_target_invalid"
  | "metadata_conflict"
  | "ownership_state_changed"
  | "idempotency_conflict"
  | "ownership_effect_conflict"
  | "ownership_transfer_unavailable";

/** Stable control-plane failure without target profile or private Mind data. */
export class OwnershipTransferFailure extends Error {
  readonly code: OwnershipTransferFailureCode;

  constructor(code: OwnershipTransferFailureCode, message: string) {
    super(message);
    this.name = "OwnershipTransferFailure";
    this.code = code;
  }
}

export interface OwnershipTransferSafeEvent {
  readonly event:
    | "ownership_transferred"
    | "ownership_replayed"
    | "ownership_conflict"
    | "ownership_denied"
    | "ownership_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface OwnershipTransferSafeLogger {
  record(event: Readonly<OwnershipTransferSafeEvent>): void | Promise<void>;
}

export interface OwnershipTransferDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: Pick<ObjectStore, "calculateSha256">;
  readonly auditIds: OwnershipTransferAuditIdGenerator;
  readonly logger?: OwnershipTransferSafeLogger;
}

function ownershipTargetMemberId(value: unknown): MembershipId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    CONTROL_OR_SEPARATOR.test(value)
  ) {
    throw new OwnershipTransferFailure(
      "invalid_target_member_id",
      "Target membership identifier is invalid.",
    );
  }
  return value as MembershipId;
}

function ownershipMetadataVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new OwnershipTransferFailure(
      "invalid_metadata_version",
      "A valid expected metadata version is required.",
    );
  }
}

function ownershipIdempotencyKey(value: unknown): IdempotencyKey {
  try {
    return idempotencyKey(value as string);
  } catch {
    throw new OwnershipTransferFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
}

function recordOwnershipTransferEvent(
  logger: OwnershipTransferSafeLogger | undefined,
  event: OwnershipTransferSafeEvent["event"],
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
    // Safe observability is outside the authoritative metadata transaction.
  }
}

/** Atomic current-Owner transfer to one already accepted active participant. */
export class OwnershipTransferService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: Pick<ObjectStore, "calculateSha256">;
  readonly #auditIds: OwnershipTransferAuditIdGenerator;
  readonly #logger: OwnershipTransferSafeLogger | undefined;

  constructor(dependencies: OwnershipTransferDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#auditIds = dependencies.auditIds;
    this.#logger = dependencies.logger;
  }

  async transferOwnership(
    actor: ActorContext,
    command: TransferOwnershipCommand,
  ): Promise<Readonly<OwnershipTransferDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOwnershipTransferEvent(
        this.#logger,
        "ownership_denied",
        requestId,
      );
      throw new OwnershipTransferFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      !Array.isArray(actor.deploymentCapabilities) ||
      !actor.deploymentCapabilities.includes("ownership:transfer")
    ) {
      recordOwnershipTransferEvent(
        this.#logger,
        "ownership_denied",
        requestId,
      );
      throw new OwnershipTransferFailure(
        "forbidden",
        "Ownership transfer is unavailable in this deployment.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0 ||
      command.mindId.length > 128 ||
      CONTROL_OR_SEPARATOR.test(command.mindId)
    ) {
      throw new OwnershipTransferFailure("mind_not_found", "Mind was not found.");
    }
    const targetMemberId = ownershipTargetMemberId(command.targetMemberId);
    const expectedMetadataVersion = ownershipMetadataVersion(
      command.expectedMetadataVersion,
    );
    if (command.confirmation !== OWNERSHIP_TRANSFER_CONFIRMATION) {
      throw new OwnershipTransferFailure(
        "invalid_confirmation",
        "Ownership transfer confirmation is required.",
      );
    }
    const checkedIdempotencyKey = ownershipIdempotencyKey(
      command.idempotencyKey,
    );

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-ownership-transfer-v1",
          mind_id: command.mindId,
          target_member_id: targetMemberId,
          expected_metadata_version: expectedMetadataVersion,
          confirmation: OWNERSHIP_TRANSFER_CONFIRMATION,
        })}\n`),
      );
      const transferred = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.transferOrdinaryMindOwnership({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            targetMembershipId: targetMemberId,
            expectedMetadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
            requestId,
            auditEventId: this.#auditIds.nextAuditEventId(),
            auditOutboxMessageId: this.#auditIds.nextOutboxMessageId(),
          }),
      );
      if (transferred.kind === "transferred") {
        const { mind, sourceMembership, targetMembership } =
          transferred.transfer;
        if (
          sourceMembership.role !== "admin" ||
          targetMembership.role !== "owner"
        ) {
          throw new OwnershipTransferFailure(
            "ownership_transfer_unavailable",
            "Ownership transfer is unavailable.",
          );
        }
        recordOwnershipTransferEvent(
          this.#logger,
          transferred.replayed
            ? "ownership_replayed"
            : "ownership_transferred",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(mind),
          sourceMemberId: sourceMembership.membershipId,
          sourceRole: "admin" as const,
          sourceMembershipVersion: sourceMembership.version,
          targetMemberId: targetMembership.membershipId,
          targetRole: "owner" as const,
          targetMembershipVersion: targetMembership.version,
          replayed: transferred.replayed,
        });
      }
      if (transferred.kind === "metadata_conflict") {
        throw new OwnershipTransferFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (transferred.kind === "idempotency_conflict") {
        throw new OwnershipTransferFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (transferred.kind === "ownership_target_invalid") {
        throw new OwnershipTransferFailure(
          "ownership_target_invalid",
          "Ownership target must be an existing active participant.",
        );
      }
      if (transferred.kind === "ownership_state_changed") {
        throw new OwnershipTransferFailure(
          "ownership_state_changed",
          "Ownership state changed; re-read before retrying.",
        );
      }
      if (transferred.kind === "personal_mind") {
        throw new OwnershipTransferFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind ownership cannot be transferred.",
        );
      }
      if (transferred.kind === "mind_not_found") {
        throw new OwnershipTransferFailure("mind_not_found", "Mind was not found.");
      }
      if (transferred.kind === "forbidden") {
        throw new OwnershipTransferFailure(
          "forbidden",
          "Current active Owner access is required.",
        );
      }
      if (transferred.kind === "effect_conflict") {
        throw new OwnershipTransferFailure(
          "ownership_effect_conflict",
          "Ownership transfer audit effects conflict.",
        );
      }
      throw new OwnershipTransferFailure(
        "ownership_transfer_unavailable",
        "Ownership transfer is unavailable.",
      );
    } catch (error) {
      if (error instanceof OwnershipTransferFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "ownership_state_changed" ||
          error.code === "idempotency_conflict" ||
          error.code === "ownership_effect_conflict"
        ) {
          recordOwnershipTransferEvent(
            this.#logger,
            "ownership_conflict",
            requestId,
          );
        } else if (
          error.code === "authentication_required" ||
          error.code === "mind_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "forbidden" ||
          error.code === "ownership_target_invalid"
        ) {
          recordOwnershipTransferEvent(
            this.#logger,
            "ownership_denied",
            requestId,
          );
        }
      } else {
        recordOwnershipTransferEvent(
          this.#logger,
          "ownership_failed",
          requestId,
        );
      }
      throw error;
    }
  }
}

export type MembershipMutationRole = Exclude<Role, "owner">;
export type MembershipControlOperation =
  | "change_membership_role"
  | "revoke_membership"
  | "leave_space";

export interface ChangeMembershipRoleCommand {
  readonly mindId: SpaceId;
  readonly memberId: MembershipId;
  readonly role: Role;
  readonly expectedMembershipVersion: number;
  readonly idempotencyKey: string;
}

export interface RevokeMembershipCommand {
  readonly mindId: SpaceId;
  readonly memberId: MembershipId;
  readonly expectedMembershipVersion: number;
  readonly idempotencyKey: string;
}

export interface LeaveSpaceCommand {
  readonly mindId: SpaceId;
  readonly expectedMembershipVersion: number;
  readonly idempotencyKey: string;
}

export interface MembershipControlDescriptor {
  readonly memberId: MembershipId;
  readonly mindId: SpaceId;
  readonly principalId: PrincipalId;
  readonly role: Role;
  readonly state: SpaceMembership["state"];
  readonly membershipVersion: number;
  readonly changed: boolean;
  readonly replayed: boolean;
}

export type MembershipControlFailureCode =
  | "authentication_required"
  | "invalid_member_id"
  | "invalid_role"
  | "owner_role_requires_transfer"
  | "invalid_membership_version"
  | "invalid_idempotency_key"
  | "mind_not_found"
  | "membership_not_found"
  | "personal_mind_operation_forbidden"
  | "forbidden"
  | "owner_membership_protected"
  | "membership_version_conflict"
  | "membership_state_changed"
  | "idempotency_conflict"
  | "membership_effect_conflict"
  | "membership_control_unavailable";

/** Stable control-plane failure without target profile or private Mind metadata. */
export class MembershipControlFailure extends Error {
  readonly code: MembershipControlFailureCode;

  constructor(code: MembershipControlFailureCode, message: string) {
    super(message);
    this.name = "MembershipControlFailure";
    this.code = code;
  }
}

export interface MembershipControlSafeEvent {
  readonly event:
    | "membership_changed"
    | "membership_revoked"
    | "membership_left"
    | "membership_noop"
    | "membership_replayed"
    | "membership_conflict"
    | "membership_denied"
    | "membership_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface MembershipControlSafeLogger {
  record(event: Readonly<MembershipControlSafeEvent>): void | Promise<void>;
}

export interface MembershipAuditIdGenerator {
  nextAuditEventId(): AuditEventId;
  nextOutboxMessageId(): OutboxMessageId;
}

export interface MembershipControlTargetQuery {
  readonly spaceId: SpaceId;
  readonly memberId?: MembershipId;
  readonly principalId?: PrincipalId;
}

export type MembershipControlTargetResult =
  | {
      readonly kind: "found";
      readonly mindKind: "ordinary" | "personal";
      readonly membership: Readonly<SpaceMembership>;
    }
  | { readonly kind: "mind_not_found" }
  | { readonly kind: "membership_not_found" };

export interface MembershipMutationReplayRequest {
  readonly operation: MembershipControlOperation;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
}

export type MembershipMutationReplayResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "idempotency_conflict" }
  | {
      readonly kind: "replayed";
      readonly membership: Readonly<SpaceMembership>;
      readonly changed: boolean;
      readonly requiredCapability: ApplyMembershipMutationRequest["requiredCapability"];
    };

export interface ApplyMembershipMutationRequest
  extends MembershipMutationReplayRequest {
  readonly targetMembershipId: MembershipId;
  readonly role: MembershipMutationRole | null;
  readonly expectedMembershipVersion: SpaceMembership["version"];
  readonly requiredCapability: "content:browse" | "members:manage-basic" | "members:manage-admin";
  readonly authorizationStamp: Readonly<AuthorizationStamp>;
  readonly occurredAt: UtcInstant;
  readonly requestId: ActorContext["requestId"];
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
}

export type ApplyMembershipMutationResult =
  | {
      readonly kind: "applied";
      readonly membership: Readonly<SpaceMembership>;
      readonly changed: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "mind_not_found"
        | "membership_not_found"
        | "personal_mind"
        | "forbidden"
        | "owner_membership"
        | "membership_version_conflict"
        | "authorization_state_changed"
        | "idempotency_conflict"
        | "effect_conflict"
        | "invalid_record";
    };

/** Atomic authority, membership CAS, access epoch, idempotency and audit boundary. */
export interface MembershipControlTransaction extends AuthorizationTransaction {
  readMembershipControlTarget(
    query: Readonly<MembershipControlTargetQuery>,
  ): Promise<MembershipControlTargetResult>;
  applyMembershipMutation(
    request: Readonly<ApplyMembershipMutationRequest>,
  ): Promise<ApplyMembershipMutationResult>;
}

export interface MembershipControlStore {
  readMembershipMutationReplay(
    request: Readonly<MembershipMutationReplayRequest>,
  ): Promise<MembershipMutationReplayResult>;
  runMembershipControlTransaction<Result>(
    operation: (transaction: MembershipControlTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface MembershipControlDependencies {
  readonly memberships: MembershipControlStore;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
  readonly auditIds: MembershipAuditIdGenerator;
  readonly logger?: MembershipControlSafeLogger;
}

function membershipVersion(value: unknown): SpaceMembership["version"] {
  try {
    return version(value as number);
  } catch {
    throw new MembershipControlFailure(
      "invalid_membership_version",
      "A valid expected membership version is required.",
    );
  }
}

function membershipKey(value: unknown): IdempotencyKey {
  try {
    return idempotencyKey(value as string);
  } catch {
    throw new MembershipControlFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
}

function membershipMindId(value: unknown): SpaceId {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new MembershipControlFailure("mind_not_found", "Mind was not found.");
  }
  return value as SpaceId;
}

function membershipMemberId(value: unknown): MembershipId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    CONTROL_OR_SEPARATOR.test(value)
  ) {
    throw new MembershipControlFailure(
      "invalid_member_id",
      "Membership identifier is invalid.",
    );
  }
  return value as MembershipId;
}

function membershipRole(value: unknown): MembershipMutationRole {
  if (value === "owner") {
    throw new MembershipControlFailure(
      "owner_role_requires_transfer",
      "Owner can only be assigned through ownership transfer.",
    );
  }
  if (value !== "reader" && value !== "editor" && value !== "admin") {
    throw new MembershipControlFailure(
      "invalid_role",
      "Membership role must be reader, editor, or admin.",
    );
  }
  return value;
}

function membershipDescriptor(
  membership: Readonly<SpaceMembership>,
  changed: boolean,
  replayed: boolean,
): Readonly<MembershipControlDescriptor> {
  return Object.freeze({
    memberId: membership.membershipId,
    mindId: membership.spaceId,
    principalId: membership.principalId,
    role: membership.role,
    state: membership.state,
    membershipVersion: membership.version,
    changed,
    replayed,
  });
}

function sameMembershipSnapshot(
  current: Readonly<SpaceMembership>,
  recorded: Readonly<SpaceMembership>,
): boolean {
  return (
    current.membershipId === recorded.membershipId &&
    current.spaceId === recorded.spaceId &&
    current.principalId === recorded.principalId &&
    current.role === recorded.role &&
    current.state === recorded.state &&
    current.version === recorded.version &&
    current.createdAt === recorded.createdAt &&
    current.createdBy === recorded.createdBy &&
    current.updatedAt === recorded.updatedAt &&
    current.updatedBy === recorded.updatedBy
  );
}

function recordMembershipEvent(
  logger: MembershipControlSafeLogger | undefined,
  event: MembershipControlSafeEvent["event"],
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
    // Safe observability is outside the authoritative metadata transaction.
  }
}

function membershipAuthorizationFailure(code: string): MembershipControlFailure {
  if (code === "authentication_required") {
    return new MembershipControlFailure(
      "authentication_required",
      "A registered Sites principal is required.",
    );
  }
  if (code === "authorization_state_changed") {
    return new MembershipControlFailure(
      "membership_state_changed",
      "Membership authority changed; re-read and retry.",
    );
  }
  if (code === "authorization_state_unavailable" || code === "access_denied") {
    return new MembershipControlFailure("mind_not_found", "Mind was not found.");
  }
  return new MembershipControlFailure(
    "forbidden",
    "Current membership-management access is required.",
  );
}

interface PreparedMembershipMutation {
  readonly operation: MembershipControlOperation;
  readonly mindId: SpaceId;
  readonly memberId: MembershipId | null;
  readonly role: MembershipMutationRole | null;
  readonly expectedMembershipVersion: SpaceMembership["version"];
  readonly idempotencyKey: IdempotencyKey;
}

/** Trusted Sites role mutation, revoke and non-owner leave use cases. */
export class MembershipControlService {
  readonly #memberships: MembershipControlStore;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #auditIds: MembershipAuditIdGenerator;
  readonly #logger: MembershipControlSafeLogger | undefined;

  constructor(dependencies: MembershipControlDependencies) {
    this.#memberships = dependencies.memberships;
    this.#digest = dependencies.digest;
    this.#auditIds = dependencies.auditIds;
    this.#logger = dependencies.logger;
  }

  async changeMembershipRole(
    actor: ActorContext,
    command: ChangeMembershipRoleCommand,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    return this.#execute(actor, {
      operation: "change_membership_role",
      mindId: membershipMindId(command?.mindId),
      memberId: membershipMemberId(command?.memberId),
      role: membershipRole(command?.role),
      expectedMembershipVersion: membershipVersion(
        command?.expectedMembershipVersion,
      ),
      idempotencyKey: membershipKey(command?.idempotencyKey),
    });
  }

  async revokeMembership(
    actor: ActorContext,
    command: RevokeMembershipCommand,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    return this.#execute(actor, {
      operation: "revoke_membership",
      mindId: membershipMindId(command?.mindId),
      memberId: membershipMemberId(command?.memberId),
      role: null,
      expectedMembershipVersion: membershipVersion(
        command?.expectedMembershipVersion,
      ),
      idempotencyKey: membershipKey(command?.idempotencyKey),
    });
  }

  async leaveSpace(
    actor: ActorContext,
    command: LeaveSpaceCommand,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    return this.#execute(actor, {
      operation: "leave_space",
      mindId: membershipMindId(command?.mindId),
      memberId: null,
      role: null,
      expectedMembershipVersion: membershipVersion(
        command?.expectedMembershipVersion,
      ),
      idempotencyKey: membershipKey(command?.idempotencyKey),
    });
  }

  async #execute(
    actor: ActorContext,
    command: PreparedMembershipMutation,
  ): Promise<Readonly<MembershipControlDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordMembershipEvent(this.#logger, "membership_denied", requestId);
      throw new MembershipControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    try {
      const canonicalRequestHash = await this.#digest.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-membership-control-v1",
          operation: command.operation,
          mind_id: command.mindId,
          member_id: command.memberId,
          role: command.role,
          expected_membership_version: command.expectedMembershipVersion,
        })}\n`),
      );
      const replayRequest = Object.freeze({
        operation: command.operation,
        principalId: trustedActor.principalId,
        spaceId: command.mindId,
        idempotencyKey: command.idempotencyKey,
        canonicalRequestHash,
      });
      const prior = await this.#memberships.readMembershipMutationReplay(
        replayRequest,
      );
      if (prior.kind === "idempotency_conflict") {
        throw new MembershipControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (prior.kind === "replayed") {
        if (
          command.operation === "leave_space" &&
          (prior.membership.principalId !== trustedActor.principalId ||
            prior.requiredCapability !== "content:browse")
        ) {
          throw new MembershipControlFailure(
            "membership_control_unavailable",
            "Membership control is unavailable.",
          );
        }
        const replayedMembership =
          await this.#memberships.runMembershipControlTransaction(
            async (transaction): Promise<Readonly<SpaceMembership>> => {
              if (command.operation !== "leave_space") {
                const authorization = await new CapabilityAuthorizer(
                  transaction,
                ).authorize({
                  actor,
                  spaceId: command.mindId,
                  capability: prior.requiredCapability,
                  revisionMode: "head",
                });
                if (authorization.kind === "denied") {
                  throw membershipAuthorizationFailure(authorization.code);
                }
                if (authorization.grant.kind !== "membership") {
                  throw new MembershipControlFailure(
                    "forbidden",
                    "Current membership-management access is required.",
                  );
                }
              }
              const current = await transaction.readMembershipControlTarget({
                spaceId: command.mindId,
                memberId: prior.membership.membershipId,
              });
              if (
                current.kind !== "found" ||
                current.mindKind !== "ordinary" ||
                !sameMembershipSnapshot(current.membership, prior.membership)
              ) {
                throw new MembershipControlFailure(
                  "membership_state_changed",
                  "Membership state changed; re-read before retrying.",
                );
              }
              return current.membership;
            },
          );
        recordMembershipEvent(this.#logger, "membership_replayed", requestId);
        return membershipDescriptor(replayedMembership, prior.changed, true);
      }

      const result = await this.#memberships.runMembershipControlTransaction(
        async (transaction) => {
          const authorizer = new CapabilityAuthorizer(transaction);
          const initialCapability: ApplyMembershipMutationRequest["requiredCapability"] =
            command.operation === "leave_space"
              ? "content:browse"
              : "members:manage-basic";
          let authorization = await authorizer.authorize({
            actor,
            spaceId: command.mindId,
            capability: initialCapability,
            revisionMode: "head",
          });
          if (authorization.kind === "denied") {
            throw membershipAuthorizationFailure(authorization.code);
          }
          if (authorization.grant.kind !== "membership") {
            throw new MembershipControlFailure(
              command.operation === "leave_space"
                ? "membership_not_found"
                : "forbidden",
              "An active membership is required.",
            );
          }
          const target = await transaction.readMembershipControlTarget(
            command.operation === "leave_space"
              ? {
                  spaceId: command.mindId,
                  principalId: trustedActor.principalId,
                }
              : {
                  spaceId: command.mindId,
                  memberId: command.memberId!,
                },
          );
          if (target.kind === "mind_not_found") {
            throw new MembershipControlFailure("mind_not_found", "Mind was not found.");
          }
          if (target.kind === "membership_not_found" || target.membership.state !== "active") {
            throw new MembershipControlFailure(
              "membership_not_found",
              "Active membership was not found.",
            );
          }
          if (target.mindKind === "personal") {
            throw new MembershipControlFailure(
              "personal_mind_operation_forbidden",
              "Personal Mind membership cannot change.",
            );
          }
          if (target.membership.role === "owner") {
            throw new MembershipControlFailure(
              "owner_membership_protected",
              "Owner must transfer ownership before leaving or being changed.",
            );
          }
          if (target.membership.version !== command.expectedMembershipVersion) {
            throw new MembershipControlFailure(
              "membership_version_conflict",
              "Membership changed; re-read and retry.",
            );
          }

          let requiredCapability: ApplyMembershipMutationRequest["requiredCapability"] =
            initialCapability;
          if (
            command.operation !== "leave_space" &&
            (target.membership.role === "admin" || command.role === "admin")
          ) {
            requiredCapability = "members:manage-admin";
            authorization = await authorizer.authorize({
              actor,
              spaceId: command.mindId,
              capability: requiredCapability,
              revisionMode: "head",
            });
            if (authorization.kind === "denied") {
              throw membershipAuthorizationFailure(authorization.code);
            }
            if (authorization.grant.kind !== "membership") {
              throw new MembershipControlFailure(
                "forbidden",
                "Current Owner membership-management access is required.",
              );
            }
          }

          const finalAuthorization = await authorizer.reauthorizeInTransaction(
            {
              actor,
              spaceId: command.mindId,
              capability: requiredCapability,
              revisionMode: "head",
            },
            transaction,
            authorization.stamp,
          );
          if (finalAuthorization.kind === "denied") {
            throw membershipAuthorizationFailure(finalAuthorization.code);
          }
          return transaction.applyMembershipMutation({
            ...replayRequest,
            targetMembershipId: target.membership.membershipId,
            role: command.role,
            expectedMembershipVersion: command.expectedMembershipVersion,
            requiredCapability,
            authorizationStamp: finalAuthorization.stamp,
            occurredAt: trustedActor.occurredAtUtc,
            requestId,
            auditEventId: this.#auditIds.nextAuditEventId(),
            auditOutboxMessageId: this.#auditIds.nextOutboxMessageId(),
          });
        },
      );
      if (result.kind === "applied") {
        recordMembershipEvent(
          this.#logger,
          result.replayed
            ? "membership_replayed"
            : !result.changed
              ? "membership_noop"
              : command.operation === "change_membership_role"
                ? "membership_changed"
                : command.operation === "revoke_membership"
                  ? "membership_revoked"
                  : "membership_left",
          requestId,
        );
        return membershipDescriptor(
          result.membership,
          result.changed,
          result.replayed,
        );
      }
      if (result.kind === "membership_version_conflict") {
        throw new MembershipControlFailure(
          "membership_version_conflict",
          "Membership changed; re-read and retry.",
        );
      }
      if (result.kind === "authorization_state_changed") {
        throw new MembershipControlFailure(
          "membership_state_changed",
          "Membership authority changed; re-read and retry.",
        );
      }
      if (result.kind === "idempotency_conflict") {
        throw new MembershipControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (result.kind === "owner_membership") {
        throw new MembershipControlFailure(
          "owner_membership_protected",
          "Owner must transfer ownership before leaving or being changed.",
        );
      }
      if (result.kind === "personal_mind") {
        throw new MembershipControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind membership cannot change.",
        );
      }
      if (result.kind === "mind_not_found") {
        throw new MembershipControlFailure("mind_not_found", "Mind was not found.");
      }
      if (result.kind === "membership_not_found") {
        throw new MembershipControlFailure(
          "membership_not_found",
          "Active membership was not found.",
        );
      }
      if (result.kind === "forbidden") {
        throw new MembershipControlFailure(
          "forbidden",
          "Current membership-management access is required.",
        );
      }
      if (result.kind === "effect_conflict") {
        throw new MembershipControlFailure(
          "membership_effect_conflict",
          "Membership audit effects conflict.",
        );
      }
      throw new MembershipControlFailure(
        "membership_control_unavailable",
        "Membership control is unavailable.",
      );
    } catch (error) {
      if (error instanceof MembershipControlFailure) {
        if (
          error.code === "membership_version_conflict" ||
          error.code === "membership_state_changed" ||
          error.code === "idempotency_conflict" ||
          error.code === "membership_effect_conflict"
        ) {
          recordMembershipEvent(this.#logger, "membership_conflict", requestId);
        } else if (
          error.code === "authentication_required" ||
          error.code === "mind_not_found" ||
          error.code === "membership_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "forbidden" ||
          error.code === "owner_membership_protected"
        ) {
          recordMembershipEvent(this.#logger, "membership_denied", requestId);
        }
      } else {
        recordMembershipEvent(this.#logger, "membership_failed", requestId);
      }
      throw error;
    }
  }
}

export const INVITATION_SITES_IDENTITY_PROVIDER = "openai-sites" as const;
export const INVITATION_EXPIRY_DAYS = 7 as const;
const INVITATION_EXPIRY_MILLISECONDS =
  INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1_000;
const INVITATION_ASCII_PATTERN = /^[\u0020-\u007e]+$/u;
const INVITATION_LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const INVITATION_DOMAIN_LABEL_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface CreateInvitationCommand {
  readonly mindId: SpaceId;
  readonly targetVerifiedEmail: string;
  readonly role: InvitationRole | "owner";
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface InvitationControlDescriptor {
  readonly invitationId: InvitationSnapshot["invitation"]["invitationId"];
  readonly mindId: SpaceId;
  readonly target: Readonly<{
    readonly principalId: PrincipalId;
    readonly displayName: string;
  }>;
  readonly proposedRole: InvitationRole;
  readonly state: "pending";
  readonly expiresAt: UtcInstant;
  readonly invitationVersion: number;
  readonly replayed: boolean;
}

export type InvitationControlFailureCode =
  | "authentication_required"
  | "invalid_target_verified_email"
  | "invalid_role"
  | "invalid_metadata_version"
  | "invalid_invitation_version"
  | "invalid_idempotency_key"
  | "mind_not_found"
  | "personal_mind_operation_forbidden"
  | "registered_principal_not_found"
  | "forbidden"
  | "active_membership_exists"
  | "pending_invitation_exists"
  | "metadata_conflict"
  | "idempotency_conflict"
  | "invitation_conflict"
  | "invitation_expired"
  | "invitation_unavailable";

export interface InvitationLifecycleCommand {
  readonly invitationId: string;
  readonly expectedInvitationVersion: number;
  readonly idempotencyKey: string;
}

export interface InvitationLifecycleDescriptor {
  readonly invitationId: string;
  readonly mindId: SpaceId;
  readonly proposedRole: InvitationRole;
  readonly state: "accepted" | "rejected" | "cancelled";
  readonly invitationVersion: number;
  readonly membershipId: string | null;
  readonly replayed: boolean;
}

export interface ReissueInvitationDescriptor {
  readonly previousInvitationId: string;
  readonly invitation: Readonly<InvitationControlDescriptor>;
}

/** Safe failure that never includes a verified email or fuzzy alternatives. */
export class InvitationControlFailure extends Error {
  readonly code: InvitationControlFailureCode;

  constructor(code: InvitationControlFailureCode, message: string) {
    super(message);
    this.name = "InvitationControlFailure";
    this.code = code;
  }
}

export interface InvitationControlSafeEvent {
  readonly event:
    | "invitation_created"
    | "invitation_replayed"
    | "invitation_conflict"
    | "invitation_denied"
    | "invitation_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface InvitationControlSafeLogger {
  record(event: Readonly<InvitationControlSafeEvent>): void | Promise<void>;
}

export interface InvitationControlDependencies {
  readonly invitations: OrdinaryMindStore;
  readonly objects: ObjectStore;
  readonly ids: InvitationLifecycleIdGenerator;
  readonly logger?: InvitationControlSafeLogger;
}

function normalizeInvitationVerifiedEmail(
  input: unknown,
): SensitiveExternalBinding | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 320) {
    return null;
  }
  const trimmed = input.trim();
  if (!INVITATION_ASCII_PATTERN.test(trimmed)) return null;
  const normalized = trimmed.toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 254 ||
    /\s|[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  const parts = normalized.split("@");
  if (parts.length !== 2) return null;
  const local = parts[0];
  const domain = parts[1];
  if (
    local === undefined ||
    domain === undefined ||
    local.length === 0 ||
    local.length > 64 ||
    domain.length === 0 ||
    domain.length > 253 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !INVITATION_LOCAL_PART_PATTERN.test(local)
  ) {
    return null;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !INVITATION_DOMAIN_LABEL_PATTERN.test(label))
  ) {
    return null;
  }
  return normalized as SensitiveExternalBinding;
}

function invitationRole(value: unknown): InvitationRole | null {
  return value === "reader" || value === "editor" || value === "admin"
    ? value
    : null;
}

function invitationMetadataVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new InvitationControlFailure(
      "invalid_metadata_version",
      "A valid expected metadata version is required.",
    );
  }
}

function invitationIdempotencyKey(value: unknown) {
  try {
    return idempotencyKey(value as string);
  } catch {
    throw new InvitationControlFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
}

function invitationExpiry(occurredAt: UtcInstant): UtcInstant | null {
  const current = Date.parse(occurredAt);
  const expiry = current + INVITATION_EXPIRY_MILLISECONDS;
  if (!Number.isFinite(current) || !Number.isFinite(expiry)) return null;
  try {
    return new Date(expiry).toISOString() as UtcInstant;
  } catch {
    return null;
  }
}

function invitationDescriptor(
  snapshot: Readonly<InvitationSnapshot>,
  replayed: boolean,
): Readonly<InvitationControlDescriptor> {
  return Object.freeze({
    invitationId: snapshot.invitation.invitationId,
    mindId: snapshot.invitation.spaceId,
    target: Object.freeze({ ...snapshot.target }),
    proposedRole: snapshot.invitation.proposedRole,
    state: "pending",
    expiresAt: snapshot.invitation.expiresAt,
    invitationVersion: snapshot.invitation.version,
    replayed,
  });
}

function recordInvitationEvent(
  logger: InvitationControlSafeLogger | undefined,
  event: InvitationControlSafeEvent["event"],
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
    // Safe observability is outside the authoritative metadata transaction.
  }
}

function invitationAuthorizationFailure(code: string): InvitationControlFailure {
  if (code === "authentication_required") {
    return new InvitationControlFailure(
      "authentication_required",
      "A registered Sites principal is required.",
    );
  }
  if (code === "authorization_state_unavailable" || code === "access_denied") {
    return new InvitationControlFailure("mind_not_found", "Mind was not found.");
  }
  return new InvitationControlFailure(
    "forbidden",
    "Current membership-management access is required.",
  );
}

/** Registered-principal invitation creation for the trusted Sites control plane. */
export class InvitationControlService {
  readonly #invitations: OrdinaryMindStore;
  readonly #objects: ObjectStore;
  readonly #ids: InvitationLifecycleIdGenerator;
  readonly #logger: InvitationControlSafeLogger | undefined;

  constructor(dependencies: InvitationControlDependencies) {
    this.#invitations = dependencies.invitations;
    this.#objects = dependencies.objects;
    this.#ids = dependencies.ids;
    this.#logger = dependencies.logger;
  }

  async createInvitation(
    actor: ActorContext,
    command: CreateInvitationCommand,
  ): Promise<Readonly<InvitationControlDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordInvitationEvent(this.#logger, "invitation_denied", requestId);
      throw new InvitationControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0
    ) {
      throw new InvitationControlFailure("mind_not_found", "Mind was not found.");
    }
    const normalizedBinding = normalizeInvitationVerifiedEmail(
      command.targetVerifiedEmail,
    );
    if (normalizedBinding === null) {
      throw new InvitationControlFailure(
        "invalid_target_verified_email",
        "A valid exact verified email is required.",
      );
    }
    const proposedRole = invitationRole(command.role);
    if (proposedRole === null) {
      throw new InvitationControlFailure(
        "invalid_role",
        "Invitation role must be reader, editor, or admin.",
      );
    }
    const expectedMetadataVersion = invitationMetadataVersion(
      command.expectedMetadataVersion,
    );
    const checkedIdempotencyKey = invitationIdempotencyKey(
      command.idempotencyKey,
    );
    const expiresAt = invitationExpiry(trustedActor.occurredAtUtc);
    if (expiresAt === null) {
      throw new InvitationControlFailure(
        "invitation_unavailable",
        "Invitation creation is unavailable.",
      );
    }

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: "mind-diary-create-invitation-v1",
          mind_id: command.mindId,
          target_verified_email: normalizedBinding,
          proposed_role: proposedRole,
          expected_metadata_version: expectedMetadataVersion,
        })}\n`),
      );
      const created = await this.#invitations.runOrdinaryMindTransaction(
        async (transaction) => {
          const targetMind = await transaction.classifyPersonalMindTarget({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
          });
          if (targetMind.kind === "own_personal") {
            throw new InvitationControlFailure(
              "personal_mind_operation_forbidden",
              "Personal Mind cannot have invitations.",
            );
          }
          if (targetMind.kind === "not_found") {
            throw new InvitationControlFailure("mind_not_found", "Mind was not found.");
          }
          const authorization = await new CapabilityAuthorizer(
            transaction,
          ).authorize({
            actor,
            spaceId: command.mindId,
            capability:
              proposedRole === "admin"
                ? "members:manage-admin"
                : "members:manage-basic",
            revisionMode: "head",
          });
          if (authorization.kind === "denied") {
            throw invitationAuthorizationFailure(authorization.code);
          }
          if (authorization.grant.kind !== "membership") {
            throw new InvitationControlFailure(
              "forbidden",
              "Current membership-management access is required.",
            );
          }
          const target = await transaction.readRegisteredPrincipalByExternalBinding({
            provider: INVITATION_SITES_IDENTITY_PROVIDER,
            normalizedBinding,
          });
          if (target === null) {
            throw new InvitationControlFailure(
              "registered_principal_not_found",
              "Registered principal was not found.",
            );
          }
          const invitationId = this.#ids.nextInvitationId();
          const expiryJobId = this.#ids.nextInvitationExpiryJobId();
          return transaction.createInvitation({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            target,
            invitation: Object.freeze({
              invitationId,
              spaceId: command.mindId,
              targetPrincipalId: target.principalId,
              proposedRole,
              state: "pending" as const,
              expiresAt,
              version: version(1),
              createdAt: trustedActor.occurredAtUtc,
              createdBy: trustedActor.principalId,
              updatedAt: trustedActor.occurredAtUtc,
              updatedBy: trustedActor.principalId,
            }),
            expectedMetadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
            expiryJob: Object.freeze({
              jobId: expiryJobId,
              target: Object.freeze({ kind: "expire_invitation" as const, invitationId }),
              state: "queued" as const,
              version: version(1),
              attempts: 0,
              availableAt: expiresAt,
              claimExpiresAt: null,
              createdAt: trustedActor.occurredAtUtc,
              updatedAt: trustedActor.occurredAtUtc,
            }),
          });
        },
      );
      if (created.kind === "created") {
        recordInvitationEvent(
          this.#logger,
          created.replayed ? "invitation_replayed" : "invitation_created",
          requestId,
        );
        return invitationDescriptor(created.invitation, created.replayed);
      }
      if (created.kind === "metadata_conflict") {
        throw new InvitationControlFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (created.kind === "personal_mind") {
        throw new InvitationControlFailure(
          "personal_mind_operation_forbidden",
          "Personal Mind cannot have invitations.",
        );
      }
      if (created.kind === "mind_not_found") {
        throw new InvitationControlFailure("mind_not_found", "Mind was not found.");
      }
      if (created.kind === "forbidden") {
        throw new InvitationControlFailure(
          "forbidden",
          "Current membership-management access is required.",
        );
      }
      if (created.kind === "active_membership_exists") {
        throw new InvitationControlFailure(
          "active_membership_exists",
          "The registered principal is already an active participant.",
        );
      }
      if (created.kind === "pending_invitation_exists") {
        throw new InvitationControlFailure(
          "pending_invitation_exists",
          "A pending invitation already exists for the registered principal.",
        );
      }
      if (created.kind === "idempotency_conflict") {
        throw new InvitationControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (created.kind === "record_conflict") {
        throw new InvitationControlFailure(
          "invitation_conflict",
          "Invitation creation conflicted with current state.",
        );
      }
      if (created.kind === "expiry_job_conflict") {
        throw new InvitationControlFailure(
          "invitation_conflict",
          "Invitation expiry scheduling conflicted with current state.",
        );
      }
      throw new InvitationControlFailure(
        "invitation_unavailable",
        "Invitation creation is unavailable.",
      );
    } catch (error) {
      if (error instanceof InvitationControlFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "idempotency_conflict" ||
          error.code === "invitation_conflict" ||
          error.code === "pending_invitation_exists" ||
          error.code === "active_membership_exists"
        ) {
          recordInvitationEvent(this.#logger, "invitation_conflict", requestId);
        } else if (
          error.code === "authentication_required" ||
          error.code === "mind_not_found" ||
          error.code === "personal_mind_operation_forbidden" ||
          error.code === "registered_principal_not_found" ||
          error.code === "forbidden"
        ) {
          recordInvitationEvent(this.#logger, "invitation_denied", requestId);
        }
      } else {
        recordInvitationEvent(this.#logger, "invitation_failed", requestId);
      }
      throw error;
    }
  }

  acceptInvitation(actor: ActorContext, command: InvitationLifecycleCommand) {
    return this.#transitionInvitation(actor, command, "accept_invitation");
  }

  rejectInvitation(actor: ActorContext, command: InvitationLifecycleCommand) {
    return this.#transitionInvitation(actor, command, "reject_invitation");
  }

  cancelInvitation(actor: ActorContext, command: InvitationLifecycleCommand) {
    return this.#transitionInvitation(actor, command, "cancel_invitation");
  }

  async #transitionInvitation(
    actor: ActorContext,
    command: InvitationLifecycleCommand,
    operation: "accept_invitation" | "reject_invitation" | "cancel_invitation",
  ): Promise<Readonly<InvitationLifecycleDescriptor>> {
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      throw new InvitationControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      !command ||
      typeof command.invitationId !== "string" ||
      command.invitationId.length === 0 ||
      command.invitationId.length > 128
    ) {
      throw new InvitationControlFailure("invitation_unavailable", "Invitation is unavailable.");
    }
    let expectedInvitationVersion;
    try {
      expectedInvitationVersion = version(command.expectedInvitationVersion);
    } catch {
      throw new InvitationControlFailure(
        "invalid_invitation_version",
        "A valid expected invitation version is required.",
      );
    }
    const checkedKey = invitationIdempotencyKey(command.idempotencyKey);
    const canonicalRequestHash = await this.#objects.calculateSha256(
      PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-invitation-transition-v1",
        operation,
        invitation_id: command.invitationId,
        expected_invitation_version: expectedInvitationVersion,
      })}\n`),
    );
    const membershipId = operation === "accept_invitation"
      ? this.#ids.nextMembershipId()
      : null;
    const transitioned = await this.#invitations.runOrdinaryMindTransaction(
      (transaction) => transaction.transitionInvitation({
        operation,
        principalId: trustedActor.principalId,
        invitationId: command.invitationId as InvitationSnapshot["invitation"]["invitationId"],
        expectedInvitationVersion,
        membershipId,
        idempotencyKey: checkedKey,
        canonicalRequestHash,
        occurredAt: trustedActor.occurredAtUtc,
      }),
    );
    if (transitioned.kind !== "transitioned") {
      const mapped = transitioned.kind === "invitation_expired"
        ? "invitation_expired"
        : transitioned.kind === "idempotency_conflict"
          ? "idempotency_conflict"
          : transitioned.kind === "invitation_version_conflict" ||
              transitioned.kind === "record_conflict" ||
              transitioned.kind === "active_membership_exists"
            ? "invitation_conflict"
            : transitioned.kind === "forbidden"
              ? "forbidden"
              : "invitation_unavailable";
      throw new InvitationControlFailure(mapped, "Invitation transition was not applied.");
    }
    const result = transitioned.result;
    return Object.freeze({
      invitationId: result.invitation.invitation.invitationId,
      mindId: result.invitation.invitation.spaceId,
      proposedRole: result.invitation.invitation.proposedRole,
      state: result.invitation.invitation.state as "accepted" | "rejected" | "cancelled",
      invitationVersion: result.invitation.invitation.version,
      membershipId: result.membership?.membershipId ?? null,
      replayed: transitioned.replayed,
    });
  }

  async reissueInvitation(
    actor: ActorContext,
    command: InvitationLifecycleCommand,
  ): Promise<Readonly<ReissueInvitationDescriptor>> {
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      throw new InvitationControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (!command || typeof command.invitationId !== "string" || command.invitationId.length === 0) {
      throw new InvitationControlFailure("invitation_unavailable", "Invitation is unavailable.");
    }
    let expectedInvitationVersion;
    try {
      expectedInvitationVersion = version(command.expectedInvitationVersion);
    } catch {
      throw new InvitationControlFailure(
        "invalid_invitation_version",
        "A valid expected invitation version is required.",
      );
    }
    const checkedKey = invitationIdempotencyKey(command.idempotencyKey);
    const expiresAt = invitationExpiry(trustedActor.occurredAtUtc);
    if (expiresAt === null) {
      throw new InvitationControlFailure("invitation_unavailable", "Invitation is unavailable.");
    }
    const canonicalRequestHash = await this.#objects.calculateSha256(
      PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-reissue-invitation-v1",
        invitation_id: command.invitationId,
        expected_invitation_version: expectedInvitationVersion,
      })}\n`),
    );
    const replacementInvitationId = this.#ids.nextInvitationId();
    const expiryJobId = this.#ids.nextInvitationExpiryJobId();
    const result = await this.#invitations.runOrdinaryMindTransaction(
      (transaction) => transaction.reissueInvitation({
        principalId: trustedActor.principalId,
        invitationId: command.invitationId as InvitationSnapshot["invitation"]["invitationId"],
        expectedInvitationVersion,
        replacementInvitationId,
        expiryJobId,
        expiresAt,
        idempotencyKey: checkedKey,
        canonicalRequestHash,
        occurredAt: trustedActor.occurredAtUtc,
      }),
    );
    if (result.kind !== "reissued") {
      const mapped = result.kind === "idempotency_conflict"
        ? "idempotency_conflict"
        : result.kind === "forbidden"
          ? "forbidden"
          : result.kind === "pending_invitation_exists" ||
              result.kind === "invitation_version_conflict" ||
              result.kind === "record_conflict" ||
              result.kind === "expiry_job_conflict"
            ? "invitation_conflict"
            : "invitation_unavailable";
      throw new InvitationControlFailure(mapped, "Invitation reissue was not applied.");
    }
    return Object.freeze({
      previousInvitationId: command.invitationId,
      invitation: invitationDescriptor(result.invitation, result.replayed),
    });
  }
}

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

const ROUTE_READ_CAPABILITY = "content:browse" as const;

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
  readonly #authorizer: CapabilityAuthorizer;
  readonly #handleReader: AuthorizedHandleReader<
    Readonly<OrdinaryMindRouteSnapshot>
  >;

  constructor(dependencies: MindRouteDependencies) {
    this.#routes = dependencies.routes;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
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
    const principalId = this.#requireActor(actor);
    const personal = await this.#routes.readPersonalMindProfile(principalId);
    if (personal === null || personal.principalId !== principalId) {
      throw new MindRouteFailure("mind_not_found", "Mind was not found.");
    }
    const descriptors: MindRouteDescriptor[] = [personalRouteDescriptor(personal)];
    const candidateIds = await this.#routes.listActiveMembershipMindIds(principalId);
    for (const spaceId of [...new Set(candidateIds)].sort()) {
      const first = await this.#authorizer.authorize({
        actor,
        spaceId,
        capability: ROUTE_READ_CAPABILITY,
        revisionMode: "head",
      });
      if (first.kind === "denied" || first.grant.kind !== "membership") continue;
      const snapshot = await this.#routes.readResolvedSpace(spaceId);
      if (!this.#validSnapshot(snapshot, spaceId, null, null)) {
        continue;
      }
      const final = await this.#finalAuthorize(actor, snapshot!);
      if (final.kind === "denied" || final.grant.kind !== "membership") continue;
      if (!this.#validSnapshot(snapshot, spaceId, null, final.stamp.accessVersion)) {
        continue;
      }
      descriptors.push(this.#ordinaryDescriptor(snapshot!, final.grant, "membership"));
    }
    descriptors.sort((left, right) => {
      if (left.isPersonal !== right.isPersonal) return left.isPersonal ? -1 : 1;
      const routeOrder = left.route.localeCompare(right.route, "en");
      return routeOrder === 0 ? left.mindId.localeCompare(right.mindId, "en") : routeOrder;
    });
    recordMindRouteEvent(this.#logger, "mind_list_returned", actor.requestId);
    return Object.freeze(descriptors);
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

export type PublicMindCatalogFailureCode =
  | "authentication_required"
  | "invalid_query"
  | "invalid_cursor"
  | "invalid_limit"
  | "catalog_unavailable";

/** Safe catalog failure without candidate IDs or target metadata. */
export class PublicMindCatalogFailure extends Error {
  readonly code: PublicMindCatalogFailureCode;

  constructor(code: PublicMindCatalogFailureCode, message: string) {
    super(message);
    this.name = "PublicMindCatalogFailure";
    this.code = code;
  }
}

export interface ListPublicMindsQuery {
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

interface NormalizedPublicMindCatalogQuery {
  readonly cursor: unknown;
  readonly limit: unknown;
}

export interface PublicMindCatalogResult {
  readonly minds: readonly Readonly<OrdinaryMindRouteDescriptor>[];
  readonly nextCursor: string | null;
}

export interface PublicMindCatalogSafeEvent {
  readonly event:
    | "public_minds_returned"
    | "public_minds_denied"
    | "public_minds_invalid_cursor"
    | "public_minds_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface PublicMindCatalogSafeLogger {
  record(event: Readonly<PublicMindCatalogSafeEvent>): void | Promise<void>;
}

export interface PublicMindCatalogDependencies {
  readonly catalog: PublicMindCatalogStore;
  readonly host: VerifiedSpaceHost;
  readonly logger?: PublicMindCatalogSafeLogger;
}

const PUBLIC_MIND_CATALOG_DEFAULT_LIMIT = 50;
const PUBLIC_MIND_CATALOG_MAX_LIMIT = 100;
const PUBLIC_MIND_CATALOG_MAX_CURSOR_BYTES = 256;

function normalizePublicMindCatalogQuery(
  query: unknown,
): Readonly<NormalizedPublicMindCatalogQuery> | null {
  try {
    if (
      typeof query !== "object" ||
      query === null ||
      Array.isArray(query) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(query))
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(query);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" || (key !== "cursor" && key !== "limit"),
      )
    ) {
      return null;
    }
    for (const key of ["cursor", "limit"] as const) {
      const descriptor = descriptors[key];
      if (descriptor && !("value" in descriptor)) return null;
    }
    return Object.freeze({
      cursor: descriptors.cursor?.value,
      limit: descriptors.limit?.value,
    });
  } catch {
    return null;
  }
}

function recordPublicMindCatalogEvent(
  logger: PublicMindCatalogSafeLogger | undefined,
  event: PublicMindCatalogSafeEvent["event"],
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
    // Safe observability remains outside catalog reads.
  }
}

/** Authenticated, fail-closed discovery over opaque public projection IDs. */
export class PublicMindCatalogService {
  readonly #catalog: PublicMindCatalogStore;
  readonly #routes: MindRouteService;
  readonly #logger: PublicMindCatalogSafeLogger | undefined;

  constructor(dependencies: PublicMindCatalogDependencies) {
    this.#catalog = dependencies.catalog;
    this.#routes = new MindRouteService({
      routes: dependencies.catalog,
      host: dependencies.host,
    });
    this.#logger = dependencies.logger;
  }

  async listPublicMinds(
    actor: ActorContext,
  ): Promise<Readonly<PublicMindCatalogResult>>;
  async listPublicMinds(
    actor: ActorContext,
    query: Readonly<ListPublicMindsQuery>,
  ): Promise<Readonly<PublicMindCatalogResult>>;
  async listPublicMinds(
    actor: ActorContext,
    query: unknown = {},
  ): Promise<Readonly<PublicMindCatalogResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordPublicMindCatalogEvent(this.#logger, "public_minds_denied", requestId);
      throw new PublicMindCatalogFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }

    // Prove that the actor still owns an active account before catalog state read,
    // including for an empty projection or a later-invalid cursor.
    let profile: Readonly<PersonalMindProfileSnapshot> | null;
    try {
      profile = await this.#catalog.readPersonalMindProfile(principalId);
    } catch {
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_failed",
        requestId,
      );
      throw new PublicMindCatalogFailure(
        "catalog_unavailable",
        "Public catalog is unavailable.",
      );
    }
    if (profile === null || profile.principalId !== principalId) {
      recordPublicMindCatalogEvent(this.#logger, "public_minds_denied", requestId);
      throw new PublicMindCatalogFailure(
        "authentication_required",
        "An active registered Sites principal is required.",
      );
    }

    const normalizedQuery = normalizePublicMindCatalogQuery(query);
    if (normalizedQuery === null) {
      throw new PublicMindCatalogFailure(
        "invalid_query",
        "Catalog query is invalid.",
      );
    }

    const cursor = normalizedQuery.cursor ?? null;
    if (
      cursor !== null &&
      (typeof cursor !== "string" ||
        cursor.length === 0 ||
        new TextEncoder().encode(cursor).byteLength >
          PUBLIC_MIND_CATALOG_MAX_CURSOR_BYTES)
    ) {
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_invalid_cursor",
        requestId,
      );
      throw new PublicMindCatalogFailure("invalid_cursor", "Cursor is invalid.");
    }
    const limit = normalizedQuery.limit ?? PUBLIC_MIND_CATALOG_DEFAULT_LIMIT;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PUBLIC_MIND_CATALOG_MAX_LIMIT
    ) {
      throw new PublicMindCatalogFailure(
        "invalid_limit",
        "Limit must be an integer between 1 and 100.",
      );
    }

    try {
      const page = await this.#catalog.listPublicMindCatalogPage({ cursor, limit });
      if (page.kind === "invalid_cursor") {
        recordPublicMindCatalogEvent(
          this.#logger,
          "public_minds_invalid_cursor",
          requestId,
        );
        throw new PublicMindCatalogFailure("invalid_cursor", "Cursor is invalid.");
      }
      if (
        page.kind !== "page" ||
        !Array.isArray(page.spaceIds) ||
        page.spaceIds.length > limit ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" ||
            page.nextCursor.length === 0 ||
            new TextEncoder().encode(page.nextCursor).byteLength >
              PUBLIC_MIND_CATALOG_MAX_CURSOR_BYTES))
      ) {
        throw new PublicMindCatalogFailure(
          "catalog_unavailable",
          "Public catalog is unavailable.",
        );
      }
      const minds: Readonly<OrdinaryMindRouteDescriptor>[] = [];
      for (const candidateId of new Set<unknown>(page.spaceIds)) {
        if (typeof candidateId !== "string" || candidateId.length === 0) {
          continue;
        }
        try {
          minds.push(
            await this.#routes.resolvePublicCatalogMind(actor, candidateId),
          );
        } catch (error) {
          if (error instanceof MindRouteFailure && error.code === "mind_not_found") {
            continue;
          }
          throw error;
        }
      }
      const finalProfile = await this.#catalog.readPersonalMindProfile(principalId);
      if (finalProfile === null || finalProfile.principalId !== principalId) {
        recordPublicMindCatalogEvent(
          this.#logger,
          "public_minds_denied",
          requestId,
        );
        throw new PublicMindCatalogFailure(
          "authentication_required",
          "An active registered Sites principal is required.",
        );
      }
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_returned",
        requestId,
      );
      return Object.freeze({
        minds: Object.freeze(minds),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof PublicMindCatalogFailure) {
        if (error.code === "catalog_unavailable") {
          recordPublicMindCatalogEvent(
            this.#logger,
            "public_minds_failed",
            requestId,
          );
        }
        throw error;
      }
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_failed",
        requestId,
      );
      throw new PublicMindCatalogFailure(
        "catalog_unavailable",
        "Public catalog is unavailable.",
      );
    }
  }
}
