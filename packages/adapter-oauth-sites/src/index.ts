import {
  MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
  type McpBearerAuthenticationResult,
  type McpBearerAuthenticator,
} from "@mind-diary/application-content";
import type { McpTokenStore, TokenVerifier } from "@mind-diary/application-ports";
import type {
  EffectiveTokenScopes,
  MindBindingOwnerId,
  PrincipalId,
  TokenId,
  UtcInstant,
} from "@mind-diary/domain";

type RequestId = Parameters<McpBearerAuthenticator["authenticate"]>[1];

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const OAUTH_AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const OAUTH_REFRESH_REUSE_GRACE_SECONDS = 30;
export const OAUTH_ACCESS_TOKEN_PREFIX = "mdo_access_" as const;
export const OAUTH_AUTHORIZATION_CODE_PREFIX = "mdo_code_" as const;
export const OAUTH_REFRESH_TOKEN_PREFIX = "mdo_refresh_" as const;
export const OAUTH_CLIENT_PREFIX = "md_oauth_client_" as const;
export const OAUTH_ACCESS_RECORD_PREFIX = "md_oauth_access_record_" as const;
export const OAUTH_SCOPES = Object.freeze([
  "content:read",
  "content:write",
  "personal:configure",
] as const);

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export interface D1ResultLike<Row = Record<string, unknown>> {
  readonly success?: boolean;
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  all<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  first?<Row = Record<string, unknown>>(): Promise<Row | null>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike[]>;
}

export type OAuthIdentityResolution =
  | { readonly kind: "authenticated"; readonly principalId: string }
  | { readonly kind: "registration_required" }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

export interface OAuthConnectionRecord {
  readonly connectionRef: string;
  /** Server-only binding owner. Never serialize this record directly to a browser response. */
  readonly bindingOwnerId: string;
  readonly clientName: string;
  readonly scopes: readonly OAuthScope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface OAuthConnectionPageQuery {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface OAuthConnectionPage {
  readonly items: readonly Readonly<OAuthConnectionRecord>[];
  readonly nextCursor: string | null;
}

export interface SitesOAuthConnectorOptions {
  readonly database: D1DatabaseLike;
  readonly publicOrigin: string;
  readonly verifierKey: Uint8Array;
  readonly authorizationTokens?: Pick<
    McpTokenStore,
    "createMcpToken" | "revokeMcpToken"
  >;
  readonly revokeWriteTargetOwner?: (input: Readonly<{
    bindingOwnerId: string;
    principalId: string;
    occurredAt: string;
  }>) => void | Promise<void>;
  readonly registerWriteTargetOwner?: (input: Readonly<{
    bindingOwnerId: string;
    principalId: string;
    credentialScopes: readonly OAuthScope[];
    occurredAt: string;
  }>) => void | Promise<void>;
  readonly resolveIdentity: (
    request: Request,
  ) => OAuthIdentityResolution | Promise<OAuthIdentityResolution>;
  readonly allowedClientOrigins?: readonly string[];
  readonly fetchClientMetadata?: typeof fetch;
  readonly now?: () => Date;
}

export interface SitesOAuthConnector {
  readonly resource: string;
  readonly protectedResourceMetadataUrl: string;
  readonly authenticator: McpBearerAuthenticator;
  readonly fetch: (request: Request) => Promise<Response | null>;
  readonly listConnectionPage: (
    principalId: string,
    query?: OAuthConnectionPageQuery,
  ) => Promise<Readonly<OAuthConnectionPage>>;
  readonly readConnection: (
    principalId: string,
    connectionRef: string,
  ) => Promise<Readonly<OAuthConnectionRecord> | null>;
  readonly revokeConnection: (
    principalId: string,
    connectionRef: string,
  ) => Promise<boolean>;
  readonly revokePrincipalConnections: (principalId: string) => Promise<void>;
}

type DbRow = Record<string, unknown>;

type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_target"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "access_denied"
  | "server_error";

export class OAuthProtocolError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "OAuthProtocolError";
  }
}

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  pragma: "no-cache",
  "content-type": "application/json; charset=utf-8",
});
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const OAUTH_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CLIENT_ID_PATTERN = /^md_oauth_client_[0-9a-f-]{36}$/iu;
const REQUEST_ID_PATTERN = /^md_oauth_request_[0-9a-f-]{36}$/iu;
const CONNECTION_REF_PATTERN = /^conn_v1_[0-9a-f]{32}$/u;
const SECRET_DOMAIN = new TextEncoder().encode("mind-diary:oauth-secret:v1\0");

export const SITES_OAUTH_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS md_oauth_registered_clients (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris_json TEXT NOT NULL,
    grant_types_json TEXT NOT NULL,
    response_types_json TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS md_oauth_authorization_requests (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    state TEXT,
    code_challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS md_oauth_grants (
    id TEXT PRIMARY KEY,
    connection_ref TEXT NOT NULL UNIQUE,
    principal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE(principal_id, client_id, resource)
  )`,
  `CREATE TABLE IF NOT EXISTS md_oauth_authorization_codes (
    id TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS md_oauth_access_tokens (
    id TEXT PRIMARY KEY,
    token_verifier TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS md_oauth_refresh_tokens (
    id TEXT PRIMARY KEY,
    token_verifier TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    parent_id TEXT,
    principal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS md_oauth_grants_principal_idx
    ON md_oauth_grants(principal_id, revoked_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS md_oauth_grants_principal_connection_idx
    ON md_oauth_grants(principal_id, connection_ref)`,
  `CREATE INDEX IF NOT EXISTS md_oauth_refresh_family_idx
    ON md_oauth_refresh_tokens(family_id)`,
]);

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("publicOrigin must be a canonical HTTPS or loopback origin");
  }
  return url.origin;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function oauthErrorResponse(error: unknown): Response {
  const failure =
    error instanceof OAuthProtocolError
      ? error
      : new OAuthProtocolError(
          "server_error",
          "The authorization server could not complete the request",
          500,
        );
  return json(failure.status, {
    error: failure.code,
    error_description: failure.message,
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function createSecret(
  prefix:
    | typeof OAUTH_ACCESS_TOKEN_PREFIX
    | typeof OAUTH_AUTHORIZATION_CODE_PREFIX
    | typeof OAUTH_REFRESH_TOKEN_PREFIX,
): string {
  return `${prefix}${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function createConnectionRef(): string {
  return `conn_v1_${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

interface OAuthConnectionPosition {
  readonly createdAt: string;
  readonly connectionRef: string;
}

interface OAuthConnectionCursorPayload {
  readonly v: 1;
  readonly actor: string;
  readonly filter: "active";
  readonly limit: number;
  readonly upperBound: OAuthConnectionPosition;
  readonly after: OAuthConnectionPosition;
}

const OAUTH_CONNECTION_CURSOR_MAX_BYTES = 2_048;

function encodeConnectionCursor(payload: OAuthConnectionCursorPayload): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeConnectionCursor(value: string): unknown {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > OAUTH_CONNECTION_CURSOR_MAX_BYTES ||
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

function isConnectionPosition(value: unknown): value is OAuthConnectionPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.connectionRef === "string" &&
    CONNECTION_REF_PATTERN.test(record.connectionRef);
}

function isConnectionCursorPayload(value: unknown): value is OAuthConnectionCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 6 &&
    record.v === 1 &&
    typeof record.actor === "string" &&
    /^[0-9a-f]{64}$/u.test(record.actor) &&
    record.filter === "active" &&
    Number.isInteger(record.limit) &&
    Number(record.limit) >= 1 &&
    Number(record.limit) <= 50 &&
    isConnectionPosition(record.upperBound) &&
    isConnectionPosition(record.after);
}

async function connectionCursorActor(principalId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mind-diary:oauth-connection-cursor:v1\0${principalId}`),
  );
  return bytesToHex(new Uint8Array(digest));
}

function connectionRecord(row: DbRow): Readonly<OAuthConnectionRecord> {
  const connectionRef = String(row.connection_ref);
  if (!CONNECTION_REF_PATTERN.test(connectionRef)) {
    throw new Error("OAuth connection presentation metadata is invalid");
  }
  return Object.freeze({
    connectionRef,
    bindingOwnerId: String(row.id),
    clientName: String(row.client_name),
    scopes: storedScopes(row.scopes_json),
    createdAt: String(row.created_at),
    lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : null,
  });
}

function parseSecret(
  value: unknown,
  prefix:
    | typeof OAUTH_ACCESS_TOKEN_PREFIX
    | typeof OAUTH_AUTHORIZATION_CODE_PREFIX
    | typeof OAUTH_REFRESH_TOKEN_PREFIX,
): string | null {
  if (typeof value !== "string" || !value.startsWith(prefix)) return null;
  const body = value.slice(prefix.length);
  return OAUTH_SECRET_PATTERN.test(body) ? value : null;
}

function normalizeScopes(
  value: string | null | undefined,
  defaults: readonly OAuthScope[] = ["content:read"],
): readonly OAuthScope[] {
  const requested = value?.trim() ? value.trim().split(/\s+/u) : [...defaults];
  if (
    requested.length === 0 ||
    requested.some((scope) => !OAUTH_SCOPES.includes(scope as OAuthScope))
  ) {
    throw new OAuthProtocolError("invalid_scope", "Requested scopes are not supported");
  }
  const scopes = new Set<OAuthScope>(requested as OAuthScope[]);
  if (scopes.has("content:write")) scopes.add("content:read");
  return Object.freeze(
    OAUTH_SCOPES.filter((scope) => scopes.has(scope)),
  );
}

function storedScopes(value: unknown): readonly OAuthScope[] {
  if (typeof value !== "string") return Object.freeze([]);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) {
      return Object.freeze([]);
    }
    return normalizeScopes(parsed.join(" "), []);
  } catch {
    return Object.freeze([]);
  }
}

function storedStrings(value: unknown): readonly string[] {
  if (typeof value !== "string") return Object.freeze([]);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? Object.freeze([...parsed])
      : Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
}

function single(
  parameters: URLSearchParams,
  name: string,
  options: { readonly optional?: boolean; readonly max?: number } = {},
): string | null {
  const values = parameters.getAll(name);
  if (values.length === 0 && options.optional) return null;
  if (values.length !== 1 || !values[0]?.trim()) {
    throw new OAuthProtocolError("invalid_request", `${name} is required exactly once`);
  }
  if (values[0].length > (options.max ?? 4_096)) {
    throw new OAuthProtocolError("invalid_request", `${name} is too long`);
  }
  return values[0];
}

function absoluteUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthProtocolError("invalid_request", `${field} must be an absolute URL`);
  }
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.hash) {
    throw new OAuthProtocolError("invalid_request", `${field} must be HTTPS without credentials or a fragment`);
  }
  return url.toString();
}

async function statementFirst<Row>(statement: D1PreparedStatementLike): Promise<Row | null> {
  if (statement.first) return statement.first<Row>();
  return (await statement.all<Row>()).results?.[0] ?? null;
}

async function readLimitedText(request: Request, maximum: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) {
    throw new OAuthProtocolError("invalid_request", "Request body is too large");
  }
  const text = await request.text();
  if (text.length > maximum) {
    throw new OAuthProtocolError("invalid_request", "Request body is too large");
  }
  return text;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MIND_DIARY_FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any"><link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png" type="image/png" sizes="180x180">` as const;

function consentPage(input: {
  readonly requestId: string;
  readonly clientName: string;
  readonly scopes: readonly OAuthScope[];
  readonly redirectOrigin: string;
}): Response {
  const contentAccess = input.scopes.includes("content:write")
    ? "Read and write Memory content in the Minds you can currently access. Writes commit a new immutable revision immediately."
    : input.scopes.includes("content:read")
      ? "Read Memory content in your enabled Minds." : "No Memory content access.";
  const access = contentAccess + (input.scopes.includes("personal:configure")
    ? " Configure the topics for automatic use of your Personal Mind when you ask. This does not change content access modes." : "");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${MIND_DIARY_FAVICON_LINKS}<title>Connect Mind Diary</title><style>body{margin:0;background:#fffaf2;color:#182642;font:16px/1.5 system-ui,sans-serif}main{width:min(38rem,calc(100% - 2rem));margin:8vh auto;padding:2rem;border:1px solid #c9c0b6;border-radius:1rem;background:white}h1{font:700 2rem/1.1 Georgia,serif}p{margin:1rem 0}.scope{padding:1rem;border-radius:.75rem;background:#f3edf9}.actions{display:flex;gap:.75rem;justify-content:flex-end;margin-top:2rem}button{min-height:2.75rem;padding:.6rem 1rem;border:2px solid #182642;border-radius:.65rem;font:inherit;font-weight:700;background:white;cursor:pointer}.approve{color:white;background:#6e3b8f;border-color:#6e3b8f}</style></head><body><main><p>Mind Diary connector</p><h1>Connect ${escapeHtml(input.clientName)}?</h1><p class="scope">${escapeHtml(access)}</p><p>You can revoke this connection later from <strong>Connections</strong>. Membership and general account settings are never granted.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}"><div class="actions"><button name="decision" value="deny">Cancel</button><button class="approve" name="decision" value="approve">Connect</button></div></form></main></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' ${input.redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function createSitesOAuthConnector(
  options: SitesOAuthConnectorOptions,
): Promise<Readonly<SitesOAuthConnector>> {
  if (!(options.verifierKey instanceof Uint8Array) || options.verifierKey.byteLength < 32) {
    throw new TypeError("OAuth verifierKey must contain at least 32 bytes");
  }
  const origin = canonicalOrigin(options.publicOrigin);
  const resource = `${origin}/api/mcp`;
  const protectedResourceMetadataUrl =
    `${origin}/.well-known/oauth-protected-resource/api/mcp`;
  const now = options.now ?? (() => new Date());
  const fetchClientMetadata = options.fetchClientMetadata ?? fetch;
  const allowedClientOrigins = new Set(
    (options.allowedClientOrigins ?? ["https://chatgpt.com"])
      .map((entry) => new URL(entry).origin),
  );
  const keyMaterial = Uint8Array.from(options.verifierKey);
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyMaterial.fill(0);
  let schemaReady: Promise<void> | null = null;

  const ensureSchema = (): Promise<void> => {
    schemaReady ??= options.database
      .batch(SITES_OAUTH_SCHEMA.map((sql) => options.database.prepare(sql)))
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
    return schemaReady;
  };

  const verifier = async (
    value: string,
    prefix:
      | typeof OAUTH_ACCESS_TOKEN_PREFIX
      | typeof OAUTH_AUTHORIZATION_CODE_PREFIX
      | typeof OAUTH_REFRESH_TOKEN_PREFIX,
  ): Promise<string | null> => {
    const parsed = parseSecret(value, prefix);
    if (parsed === null) return null;
    const material = new Uint8Array(
      SECRET_DOMAIN.byteLength + new TextEncoder().encode(parsed).byteLength,
    );
    material.set(SECRET_DOMAIN);
    material.set(new TextEncoder().encode(parsed), SECRET_DOMAIN.byteLength);
    const signature = await crypto.subtle.sign("HMAC", key, material);
    material.fill(0);
    return `hmac-sha256:oauth:v1:${bytesToHex(new Uint8Array(signature))}`;
  };

  const authorizationServerMetadata = () => Object.freeze({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: Object.freeze(["code"]),
    grant_types_supported: Object.freeze(["authorization_code", "refresh_token"]),
    code_challenge_methods_supported: Object.freeze(["S256"]),
    token_endpoint_auth_methods_supported: Object.freeze(["none"]),
    scopes_supported: OAUTH_SCOPES,
    resource_parameter_supported: true,
  });

  const protectedResourceMetadata = () => Object.freeze({
    resource,
    authorization_servers: Object.freeze([origin]),
    scopes_supported: OAUTH_SCOPES,
    resource_name: "Mind Diary",
    resource_documentation: `${origin}/settings/developer/mcp`,
  });

  const parseRegistration = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new OAuthProtocolError("invalid_client", "Client registration must be a JSON object");
    }
    const data = value as Record<string, unknown>;
    if (
      !Array.isArray(data.redirect_uris) ||
      data.redirect_uris.length < 1 ||
      data.redirect_uris.length > 10 ||
      !data.redirect_uris.every((entry) => typeof entry === "string")
    ) {
      throw new OAuthProtocolError("invalid_client", "redirect_uris must contain between one and ten URLs");
    }
    const redirectUris = data.redirect_uris.map((entry) => {
      const value = absoluteUrl(entry as string, "redirect_uri");
      const url = new URL(value);
      const loopback =
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (!loopback && !allowedClientOrigins.has(url.origin)) {
        throw new OAuthProtocolError("invalid_client", "This redirect_uri origin is not allowed");
      }
      return value;
    });
    if (new Set(redirectUris).size !== redirectUris.length) {
      throw new OAuthProtocolError("invalid_client", "redirect_uris must not contain duplicates");
    }
    const grantTypes = data.grant_types === undefined
      ? ["authorization_code", "refresh_token"]
      : data.grant_types;
    if (
      !Array.isArray(grantTypes) ||
      !grantTypes.includes("authorization_code") ||
      grantTypes.some((entry) => entry !== "authorization_code" && entry !== "refresh_token")
    ) {
      throw new OAuthProtocolError("invalid_client", "Only authorization_code and refresh_token grants are supported");
    }
    const responseTypes = data.response_types === undefined ? ["code"] : data.response_types;
    if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") {
      throw new OAuthProtocolError("invalid_client", "Only response_type=code is supported");
    }
    if (
      data.token_endpoint_auth_method !== undefined &&
      data.token_endpoint_auth_method !== "none"
    ) {
      throw new OAuthProtocolError("invalid_client", "Only public clients are supported");
    }
    return Object.freeze({
      clientName:
        typeof data.client_name === "string" && data.client_name.trim()
          ? data.client_name.trim().slice(0, 120)
          : "ChatGPT",
      redirectUris: Object.freeze(redirectUris),
      grantTypes: Object.freeze([...new Set(grantTypes as string[])]),
      responseTypes: Object.freeze(["code"]),
      tokenEndpointAuthMethod: "none",
    });
  };

  const validateClientMetadata = (
    clientId: string,
    redirectUri: string,
    metadata: unknown,
  ): { readonly clientId: string; readonly clientName: string } => {
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new OAuthProtocolError("invalid_client", "Client metadata must be a JSON object");
    }
    const data = metadata as Record<string, unknown>;
    if (data.client_id !== undefined && data.client_id !== clientId) {
      throw new OAuthProtocolError("invalid_client", "Client metadata does not match client_id");
    }
    if (
      !Array.isArray(data.redirect_uris) ||
      !data.redirect_uris.every((entry) => typeof entry === "string") ||
      !data.redirect_uris.includes(redirectUri)
    ) {
      throw new OAuthProtocolError("invalid_client", "redirect_uri is not registered by the client");
    }
    return Object.freeze({
      clientId,
      clientName:
        typeof data.client_name === "string" && data.client_name.trim()
          ? data.client_name.trim().slice(0, 120)
          : "ChatGPT",
    });
  };

  const resolveClient = async (clientId: string, redirectUri: string) => {
    await ensureSchema();
    if (CLIENT_ID_PATTERN.test(clientId)) {
      const row = await statementFirst<DbRow>(
        options.database
          .prepare(`/*md-oauth-client-read*/ SELECT * FROM md_oauth_registered_clients WHERE id = ? LIMIT 1`)
          .bind(clientId),
      );
      if (row === null) {
        throw new OAuthProtocolError("invalid_client", "The registered OAuth client is unknown");
      }
      const metadata = {
        client_id: clientId,
        client_name: String(row.client_name),
        redirect_uris: storedStrings(row.redirect_uris_json),
      };
      return validateClientMetadata(clientId, redirectUri, metadata);
    }

    let clientUrl: URL;
    try {
      clientUrl = new URL(clientId);
    } catch {
      throw new OAuthProtocolError("invalid_client", "client_id must be a registered ID or HTTPS metadata URL");
    }
    const loopback =
      clientUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(clientUrl.hostname);
    if (
      (clientUrl.protocol !== "https:" && !loopback) ||
      clientUrl.username ||
      clientUrl.password ||
      clientUrl.hash ||
      (!loopback && !allowedClientOrigins.has(clientUrl.origin))
    ) {
      throw new OAuthProtocolError("invalid_client", "Client metadata URL is not allowed");
    }
    const response = await fetchClientMetadata(clientUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
    }).catch(() => null);
    if (!response?.ok) {
      throw new OAuthProtocolError("invalid_client", "Client metadata could not be verified");
    }
    const text = await response.text();
    if (text.length > 65_536) {
      throw new OAuthProtocolError("invalid_client", "Client metadata is too large");
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(text);
    } catch {
      throw new OAuthProtocolError("invalid_client", "Client metadata is not valid JSON");
    }
    return validateClientMetadata(clientId, redirectUri, metadata);
  };

  const registerClient = async (request: Request): Promise<Response> => {
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new OAuthProtocolError("invalid_request", "Client registration requires application/json");
    }
    const text = await readLimitedText(request, 65_536);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthProtocolError("invalid_request", "Client registration is not valid JSON");
    }
    const registration = parseRegistration(body);
    await ensureSchema();
    const clientId = `${OAUTH_CLIENT_PREFIX}${crypto.randomUUID()}`;
    const createdAt = now().toISOString();
    await options.database
      .prepare(`/*md-oauth-client-create*/ INSERT INTO md_oauth_registered_clients
        (id, client_name, redirect_uris_json, grant_types_json, response_types_json,
         token_endpoint_auth_method, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
      .bind(
        clientId,
        registration.clientName,
        JSON.stringify(registration.redirectUris),
        JSON.stringify(registration.grantTypes),
        JSON.stringify(registration.responseTypes),
        registration.tokenEndpointAuthMethod,
        createdAt,
      )
      .run();
    return json(201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now().getTime() / 1_000),
      client_name: registration.clientName,
      redirect_uris: registration.redirectUris,
      grant_types: registration.grantTypes,
      response_types: registration.responseTypes,
      token_endpoint_auth_method: registration.tokenEndpointAuthMethod,
    });
  };

  const prepareAuthorization = async (request: Request): Promise<Response> => {
    const identity = await options.resolveIdentity(request);
    if (identity.kind === "denied") {
      return oauthErrorResponse(new OAuthProtocolError("access_denied", "Sign in to Mind Diary before connecting", 401));
    }
    if (identity.kind === "registration_required") {
      return oauthErrorResponse(new OAuthProtocolError("access_denied", "Create your Mind Diary account before connecting", 409));
    }
    if (identity.kind === "unavailable") {
      return oauthErrorResponse(new OAuthProtocolError("server_error", "Mind Diary identity is temporarily unavailable", 503));
    }
    const url = new URL(request.url);
    const responseType = single(url.searchParams, "response_type");
    if (responseType !== "code") {
      throw new OAuthProtocolError("unsupported_response_type", "Only response_type=code is supported");
    }
    const clientId = single(url.searchParams, "client_id")!;
    const redirectUri = absoluteUrl(single(url.searchParams, "redirect_uri")!, "redirect_uri");
    const resources = url.searchParams.getAll("resource");
    if (resources.length < 1 || resources.some((entry) => entry !== resources[0])) {
      throw new OAuthProtocolError("invalid_request", "resource is required and repeated values must match");
    }
    if (absoluteUrl(resources[0]!, "resource") !== resource) {
      throw new OAuthProtocolError("invalid_target", "The requested resource is not this Mind Diary connector");
    }
    const challenge = single(url.searchParams, "code_challenge")!;
    if (!BASE64URL_PATTERN.test(challenge)) {
      throw new OAuthProtocolError("invalid_request", "code_challenge must be an S256 base64url digest");
    }
    if (single(url.searchParams, "code_challenge_method") !== "S256") {
      throw new OAuthProtocolError("invalid_request", "Only code_challenge_method=S256 is supported");
    }
    const state = single(url.searchParams, "state", { optional: true, max: 2_048 });
    const scopes = normalizeScopes(single(url.searchParams, "scope", { optional: true, max: 500 }));
    const client = await resolveClient(clientId, redirectUri);
    const requestId = `md_oauth_request_${crypto.randomUUID()}`;
    const createdAt = now();
    await options.database
      .prepare(`/*md-oauth-request-create*/ INSERT INTO md_oauth_authorization_requests
        (id, principal_id, client_id, client_name, redirect_uri, resource,
         scopes_json, state, code_challenge, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        requestId,
        identity.principalId,
        client.clientId,
        client.clientName,
        redirectUri,
        resource,
        JSON.stringify(scopes),
        state,
        challenge,
        new Date(createdAt.getTime() + OAUTH_AUTHORIZATION_REQUEST_TTL_SECONDS * 1_000).toISOString(),
        createdAt.toISOString(),
      )
      .run();
    return consentPage({
      requestId,
      clientName: client.clientName,
      scopes,
      redirectOrigin: new URL(redirectUri).origin,
    });
  };

  const mergeScopes = (
    left: readonly OAuthScope[],
    right: readonly OAuthScope[],
  ): readonly OAuthScope[] => {
    const merged = new Set<OAuthScope>([...left, ...right]);
    return Object.freeze(OAUTH_SCOPES.filter((scope) => merged.has(scope)));
  };

  const completeAuthorization = async (request: Request): Promise<Response> => {
    const identity = await options.resolveIdentity(request);
    if (identity.kind !== "authenticated") {
      return oauthErrorResponse(new OAuthProtocolError("access_denied", "The authenticated Mind Diary account is unavailable", 401));
    }
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/x-www-form-urlencoded")) {
      throw new OAuthProtocolError("invalid_request", "Authorization decision must be form encoded");
    }
    const form = new URLSearchParams(await readLimitedText(request, 16_384));
    const requestId = single(form, "request_id")!;
    const decision = single(form, "decision")!;
    if (!REQUEST_ID_PATTERN.test(requestId) || !["approve", "deny"].includes(decision)) {
      throw new OAuthProtocolError("invalid_request", "Authorization decision is invalid");
    }
    await ensureSchema();
    const pending = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-request-consume*/ DELETE FROM md_oauth_authorization_requests
          WHERE id = ? AND principal_id = ? AND expires_at > ? RETURNING *`)
        .bind(requestId, identity.principalId, now().toISOString()),
    );
    if (pending === null) {
      throw new OAuthProtocolError("invalid_request", "Authorization request is missing or expired");
    }
    const redirect = new URL(String(pending.redirect_uri));
    const state = typeof pending.state === "string" ? pending.state : null;
    if (decision === "deny") {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "The user declined Mind Diary access");
      if (state !== null) redirect.searchParams.set("state", state);
      return new Response(null, { status: 303, headers: { location: redirect.toString(), "cache-control": "no-store" } });
    }

    const existing = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-grant-read*/ SELECT id, connection_ref, scopes_json, revoked_at FROM md_oauth_grants
          WHERE principal_id = ? AND client_id = ? AND resource = ? LIMIT 1`)
        .bind(identity.principalId, pending.client_id, pending.resource),
    );
    const grantId = existing === null || existing.revoked_at
      ? `md_oauth_grant_${crypto.randomUUID()}`
      : String(existing.id);
    const connectionRef = existing !== null && !existing.revoked_at &&
        typeof existing.connection_ref === "string" &&
        CONNECTION_REF_PATTERN.test(existing.connection_ref)
      ? existing.connection_ref
      : createConnectionRef();
    const requestedScopes = storedScopes(pending.scopes_json);
    const existingScopes = existing?.revoked_at
      ? Object.freeze([]) as readonly OAuthScope[]
      : storedScopes(existing?.scopes_json);
    const grantedScopes = mergeScopes(existingScopes, requestedScopes);
    const code = createSecret(OAUTH_AUTHORIZATION_CODE_PREFIX);
    const codeVerifier = await verifier(code, OAUTH_AUTHORIZATION_CODE_PREFIX);
    if (codeVerifier === null) throw new Error("OAuth authorization code generation failed");
    const timestamp = now();
    // Initialize the owner before publishing a usable credential. A later D1
    // failure can leave only an empty orphan profile, which has no capability;
    // the inverse ordering could expose an active grant without its fail-closed
    // target profile.
    await options.registerWriteTargetOwner?.({
      bindingOwnerId: grantId,
      principalId: identity.principalId,
      credentialScopes: grantedScopes,
      occurredAt: timestamp.toISOString(),
    });
    await options.database.batch([
      options.database
        .prepare(`/*md-oauth-grant-upsert*/ INSERT INTO md_oauth_grants
          (id, connection_ref, principal_id, client_id, client_name, resource, scopes_json,
           revoked_at, created_at, updated_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
          ON CONFLICT(principal_id, client_id, resource) DO UPDATE SET
            id = excluded.id,
            connection_ref = CASE
              WHEN md_oauth_grants.revoked_at IS NULL AND md_oauth_grants.connection_ref IS NOT NULL
                THEN md_oauth_grants.connection_ref
              ELSE excluded.connection_ref
            END,
            client_name = excluded.client_name,
            scopes_json = excluded.scopes_json,
            created_at = CASE
              WHEN md_oauth_grants.revoked_at IS NULL
                THEN md_oauth_grants.created_at
              ELSE excluded.created_at
            END,
            revoked_at = NULL,
            updated_at = excluded.updated_at,
            last_used_at = CASE
              WHEN md_oauth_grants.revoked_at IS NULL
                THEN md_oauth_grants.last_used_at
              ELSE NULL
            END`)
        .bind(
          grantId,
          connectionRef,
          identity.principalId,
          pending.client_id,
          pending.client_name,
          pending.resource,
          JSON.stringify(grantedScopes),
          timestamp.toISOString(),
          timestamp.toISOString(),
        ),
      options.database
        .prepare(`/*md-oauth-code-create*/ INSERT INTO md_oauth_authorization_codes
          (id, code_verifier, grant_id, principal_id, client_id, redirect_uri,
           resource, scopes_json, code_challenge, expires_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .bind(
          `md_oauth_code_${crypto.randomUUID()}`,
          codeVerifier,
          grantId,
          identity.principalId,
          pending.client_id,
          pending.redirect_uri,
          pending.resource,
          JSON.stringify(requestedScopes),
          pending.code_challenge,
          new Date(timestamp.getTime() + OAUTH_AUTHORIZATION_CODE_TTL_SECONDS * 1_000).toISOString(),
        ),
    ]);
    redirect.searchParams.set("code", code);
    if (state !== null) redirect.searchParams.set("state", state);
    return new Response(null, { status: 303, headers: { location: redirect.toString(), "cache-control": "no-store" } });
  };

  const formValue = (form: URLSearchParams, name: string): string => single(form, name)!;

  const revokeMirroredRows = async (
    rows: readonly DbRow[],
    revokedAt: string,
  ): Promise<void> => {
    if (options.authorizationTokens === undefined) return;
    for (const row of rows) {
      await options.authorizationTokens.revokeMcpToken({
        principalId: String(row.principal_id) as PrincipalId,
        tokenId: String(row.id) as TokenId,
        revokedAt: revokedAt as UtcInstant,
      });
    }
  };

  const revokeMirroredGrant = async (
    grantId: string,
    revokedAt: string,
  ): Promise<void> => {
    if (options.authorizationTokens === undefined) return;
    const rows = await options.database
      .prepare(`/*md-oauth-access-grant-list*/ SELECT id, principal_id
        FROM md_oauth_access_tokens WHERE grant_id = ? AND revoked_at IS NULL`)
      .bind(grantId)
      .all<DbRow>();
    await revokeMirroredRows(rows.results ?? [], revokedAt);
  };

  const revokeGrantAndFamily = async (
    grantId: string,
    familyId: string,
    principalId: string,
  ): Promise<void> => {
    const timestamp = now().toISOString();
    await revokeMirroredGrant(grantId, timestamp);
    await options.revokeWriteTargetOwner?.({
      bindingOwnerId: grantId,
      principalId,
      occurredAt: timestamp,
    });
    await options.database.batch([
      options.database
        .prepare(`/*md-oauth-grant-revoke*/ UPDATE md_oauth_grants
          SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`)
        .bind(timestamp, timestamp, grantId),
      options.database
        .prepare(`/*md-oauth-family-revoke*/ UPDATE md_oauth_refresh_tokens
          SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`)
        .bind(timestamp, familyId),
      options.database
        .prepare(`/*md-oauth-access-grant-revoke*/ UPDATE md_oauth_access_tokens
          SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
        .bind(timestamp, grantId),
    ]);
  };

  const rejectRefreshReuse = async (
    row: DbRow,
    observedAt: Date,
  ): Promise<never> => {
    const usedAt = typeof row.used_at === "string"
      ? Date.parse(row.used_at)
      : Number.NaN;
    const elapsedMs = observedAt.getTime() - usedAt;
    if (
      !row.revoked_at &&
      Number.isFinite(usedAt) &&
      elapsedMs >= 0 &&
      elapsedMs <= OAUTH_REFRESH_REUSE_GRACE_SECONDS * 1_000
    ) {
      throw new OAuthProtocolError(
        "invalid_grant",
        "Refresh token was already rotated; reload the latest stored credentials",
      );
    }
    await revokeGrantAndFamily(
      String(row.grant_id),
      String(row.family_id),
      String(row.principal_id),
    );
    throw new OAuthProtocolError(
      "invalid_grant",
      "Refresh token reuse was detected and the connection was revoked",
    );
  };

  const issueTokens = async (input: {
    readonly grantId: string;
    readonly principalId: string;
    readonly clientId: string;
    readonly resource: string;
    readonly scopes: readonly OAuthScope[];
    readonly familyId?: string;
    readonly parentId?: string;
  }) => {
    const accessToken = createSecret(OAUTH_ACCESS_TOKEN_PREFIX);
    const refreshToken = createSecret(OAUTH_REFRESH_TOKEN_PREFIX);
    const [accessVerifier, refreshVerifier] = await Promise.all([
      verifier(accessToken, OAUTH_ACCESS_TOKEN_PREFIX),
      verifier(refreshToken, OAUTH_REFRESH_TOKEN_PREFIX),
    ]);
    if (accessVerifier === null || refreshVerifier === null) throw new Error("OAuth token generation failed");
    const timestamp = now();
    const familyId = input.familyId ?? `md_oauth_family_${crypto.randomUUID()}`;
    const accessId = `${OAUTH_ACCESS_RECORD_PREFIX}${crypto.randomUUID()}`;
    const refreshId = `md_oauth_refresh_record_${crypto.randomUUID()}`;
    const accessExpiresAt = new Date(
      timestamp.getTime() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1_000,
    ).toISOString();
    await options.database.batch([
      options.database
        .prepare(`/*md-oauth-access-create*/ INSERT INTO md_oauth_access_tokens
          (id, token_verifier, grant_id, principal_id, client_id, resource,
           scopes_json, expires_at, created_at, last_used_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .bind(
          accessId,
          accessVerifier,
          input.grantId,
          input.principalId,
          input.clientId,
          input.resource,
          JSON.stringify(input.scopes),
          accessExpiresAt,
          timestamp.toISOString(),
        ),
      options.database
        .prepare(`/*md-oauth-refresh-create*/ INSERT INTO md_oauth_refresh_tokens
          (id, token_verifier, grant_id, family_id, parent_id, principal_id,
           client_id, resource, scopes_json, expires_at, created_at, used_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .bind(
          refreshId,
          refreshVerifier,
          input.grantId,
          familyId,
          input.parentId ?? null,
          input.principalId,
          input.clientId,
          input.resource,
          JSON.stringify(input.scopes),
          new Date(timestamp.getTime() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1_000).toISOString(),
          timestamp.toISOString(),
        ),
      options.database
        .prepare(`/*md-oauth-grant-touch*/ UPDATE md_oauth_grants
          SET last_used_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`)
        .bind(timestamp.toISOString(), timestamp.toISOString(), input.grantId),
    ]);
    if (options.authorizationTokens !== undefined) {
      const verifierHex = accessVerifier.slice(accessVerifier.lastIndexOf(":") + 1);
      const mirrored = await options.authorizationTokens.createMcpToken({
        tokenId: accessId as TokenId,
        principalId: input.principalId as PrincipalId,
        name: "OAuth connector authorization",
        verifier: `hmac-sha256:v1:${verifierHex}` as TokenVerifier,
        displayPrefix: "mdp_v1_OAuth0…",
        scopes: Object.freeze([...input.scopes]) as EffectiveTokenScopes,
        createdAt: timestamp.toISOString() as UtcInstant,
        expiresAt: accessExpiresAt as UtcInstant,
      });
      if (mirrored.kind !== "created") {
        const revokedAt = now().toISOString();
        await options.database.batch([
          options.database
            .prepare(`/*md-oauth-access-record-revoke*/ UPDATE md_oauth_access_tokens
              SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
            .bind(revokedAt, accessId),
          options.database
            .prepare(`/*md-oauth-refresh-record-revoke*/ UPDATE md_oauth_refresh_tokens
              SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
            .bind(revokedAt, refreshId),
        ]);
        throw new Error("OAuth authorization token mirror could not be created");
      }
    }
    return Object.freeze({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: input.scopes.join(" "),
      resource: input.resource,
    });
  };

  const exchangeCode = async (form: URLSearchParams) => {
    const code = formValue(form, "code");
    const codeVerifierValue = formValue(form, "code_verifier");
    if (!CODE_VERIFIER_PATTERN.test(codeVerifierValue)) {
      throw new OAuthProtocolError("invalid_grant", "code_verifier is invalid");
    }
    const codeVerifier = await verifier(code, OAUTH_AUTHORIZATION_CODE_PREFIX);
    if (codeVerifier === null) {
      throw new OAuthProtocolError("invalid_grant", "Authorization code is invalid or expired");
    }
    const row = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-code-read*/ SELECT * FROM md_oauth_authorization_codes
          WHERE code_verifier = ? AND consumed_at IS NULL AND expires_at > ? LIMIT 1`)
        .bind(codeVerifier, now().toISOString()),
    );
    const clientId = formValue(form, "client_id");
    const redirectUri = absoluteUrl(formValue(form, "redirect_uri"), "redirect_uri");
    const requestedResource = absoluteUrl(formValue(form, "resource"), "resource");
    const pkce = base64Url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifierValue)),
      ),
    );
    if (
      row === null ||
      String(row.client_id) !== clientId ||
      String(row.redirect_uri) !== redirectUri ||
      String(row.resource) !== requestedResource ||
      String(row.code_challenge) !== pkce
    ) {
      throw new OAuthProtocolError("invalid_grant", "Authorization code is invalid, expired, or does not match the request");
    }
    const consumed = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-code-consume*/ UPDATE md_oauth_authorization_codes
          SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id`)
        .bind(now().toISOString(), row.id),
    );
    if (consumed === null) {
      throw new OAuthProtocolError("invalid_grant", "Authorization code has already been used");
    }
    return issueTokens({
      grantId: String(row.grant_id),
      principalId: String(row.principal_id),
      clientId,
      resource: requestedResource,
      scopes: storedScopes(row.scopes_json),
    });
  };

  const rotateRefresh = async (form: URLSearchParams) => {
    const token = formValue(form, "refresh_token");
    const tokenVerifier = await verifier(token, OAUTH_REFRESH_TOKEN_PREFIX);
    if (tokenVerifier === null) {
      throw new OAuthProtocolError("invalid_grant", "Refresh token is invalid or revoked");
    }
    const row = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-refresh-read*/ SELECT t.*, g.revoked_at AS grant_revoked_at
          FROM md_oauth_refresh_tokens t JOIN md_oauth_grants g ON g.id = t.grant_id
          WHERE t.token_verifier = ? LIMIT 1`)
        .bind(tokenVerifier),
    );
    const clientId = formValue(form, "client_id");
    if (row === null || String(row.client_id) !== clientId || row.grant_revoked_at) {
      throw new OAuthProtocolError("invalid_grant", "Refresh token is invalid or revoked");
    }
    if (row.used_at || row.revoked_at) await rejectRefreshReuse(row, now());
    if (Date.parse(String(row.expires_at)) <= now().getTime()) {
      throw new OAuthProtocolError("invalid_grant", "Refresh token has expired");
    }
    const requestedResource = single(form, "resource", { optional: true });
    if (requestedResource !== null && absoluteUrl(requestedResource, "resource") !== row.resource) {
      throw new OAuthProtocolError("invalid_target", "Refresh token is bound to another resource");
    }
    const originalScopes = storedScopes(row.scopes_json);
    const requestedScope = single(form, "scope", { optional: true, max: 500 });
    const scopes = requestedScope === null ? originalScopes : normalizeScopes(requestedScope);
    if (scopes.some((scope) => !originalScopes.includes(scope))) {
      throw new OAuthProtocolError("invalid_scope", "Refresh cannot add scopes that were not granted");
    }
    const consumed = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-refresh-consume*/ UPDATE md_oauth_refresh_tokens
          SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL RETURNING id`)
        .bind(now().toISOString(), row.id),
    );
    if (consumed === null) {
      const current = await statementFirst<DbRow>(
        options.database
          .prepare(`/*md-oauth-refresh-read*/ SELECT t.*, g.revoked_at AS grant_revoked_at
            FROM md_oauth_refresh_tokens t JOIN md_oauth_grants g ON g.id = t.grant_id
            WHERE t.token_verifier = ? LIMIT 1`)
          .bind(tokenVerifier),
      );
      if (
        current === null ||
        String(current.client_id) !== clientId ||
        current.grant_revoked_at
      ) {
        throw new OAuthProtocolError("invalid_grant", "Refresh token is invalid or revoked");
      }
      await rejectRefreshReuse(current, now());
    }
    return issueTokens({
      grantId: String(row.grant_id),
      principalId: String(row.principal_id),
      clientId,
      resource: String(row.resource),
      scopes,
      familyId: String(row.family_id),
      parentId: String(row.id),
    });
  };

  const tokenRequest = async (request: Request): Promise<Response> => {
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/x-www-form-urlencoded")) {
      throw new OAuthProtocolError("invalid_request", "Token request must be form encoded");
    }
    const form = new URLSearchParams(await readLimitedText(request, 16_384));
    if (form.has("client_secret") || form.has("client_assertion")) {
      throw new OAuthProtocolError("invalid_client", "Only public PKCE clients are supported");
    }
    await ensureSchema();
    const grantType = formValue(form, "grant_type");
    if (grantType === "authorization_code") return json(200, await exchangeCode(form));
    if (grantType === "refresh_token") return json(200, await rotateRefresh(form));
    throw new OAuthProtocolError("unsupported_grant_type", "Only authorization_code and refresh_token grants are supported");
  };

  const revokeToken = async (request: Request): Promise<Response> => {
    try {
      if (!request.headers.get("content-type")?.toLowerCase().includes("application/x-www-form-urlencoded")) {
        throw new OAuthProtocolError("invalid_request", "Revocation request must be form encoded");
      }
      const form = new URLSearchParams(await readLimitedText(request, 16_384));
      const token = formValue(form, "token");
      const clientId = formValue(form, "client_id");
      await ensureSchema();
      if (token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
        const tokenVerifier = await verifier(token, OAUTH_REFRESH_TOKEN_PREFIX);
        const row = tokenVerifier === null ? null : await statementFirst<DbRow>(
          options.database
            .prepare(`/*md-oauth-refresh-owner*/ SELECT grant_id, family_id, principal_id FROM md_oauth_refresh_tokens
              WHERE token_verifier = ? AND client_id = ? LIMIT 1`)
            .bind(tokenVerifier, clientId),
        );
        if (row !== null) {
          await revokeGrantAndFamily(
            String(row.grant_id),
            String(row.family_id),
            String(row.principal_id),
          );
        }
      } else if (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
        const tokenVerifier = await verifier(token, OAUTH_ACCESS_TOKEN_PREFIX);
        if (tokenVerifier !== null) {
          const row = await statementFirst<DbRow>(
            options.database
              .prepare(`/*md-oauth-access-owner*/ SELECT id, principal_id FROM md_oauth_access_tokens
                WHERE token_verifier = ? AND client_id = ? LIMIT 1`)
              .bind(tokenVerifier, clientId),
          );
          const revokedAt = now().toISOString();
          if (row !== null) await revokeMirroredRows([row], revokedAt);
          await options.database
            .prepare(`/*md-oauth-access-revoke*/ UPDATE md_oauth_access_tokens
              SET revoked_at = ? WHERE token_verifier = ? AND client_id = ?`)
            .bind(revokedAt, tokenVerifier, clientId)
            .run();
        }
      }
    } catch {
      // RFC 7009 makes revocation responses indistinguishable.
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache" } });
  };

  const authenticate = async (
    candidate: unknown,
    requestId: RequestId,
  ): Promise<McpBearerAuthenticationResult> => {
    if (typeof candidate !== "string") return Object.freeze({ kind: "invalid" });
    const tokenVerifier = await verifier(candidate, OAUTH_ACCESS_TOKEN_PREFIX);
    if (tokenVerifier === null) return Object.freeze({ kind: "invalid" });
    await ensureSchema();
    const timestamp = now();
    const row = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-access-authenticate*/ SELECT t.*, g.revoked_at AS grant_revoked_at
          FROM md_oauth_access_tokens t JOIN md_oauth_grants g ON g.id = t.grant_id
          WHERE t.token_verifier = ? LIMIT 1`)
        .bind(tokenVerifier),
    );
    if (
      row === null ||
      row.revoked_at ||
      row.grant_revoked_at ||
      String(row.resource) !== resource ||
      Date.parse(String(row.expires_at)) <= timestamp.getTime()
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    const scopes = storedScopes(row.scopes_json);
    if (scopes.length === 0) return Object.freeze({ kind: "invalid" });
    await options.database.batch([
      options.database
        .prepare(`/*md-oauth-access-touch*/ UPDATE md_oauth_access_tokens SET last_used_at = ? WHERE id = ?`)
        .bind(timestamp.toISOString(), row.id),
      options.database
        .prepare(`/*md-oauth-grant-touch*/ UPDATE md_oauth_grants SET last_used_at = ?, updated_at = ? WHERE id = ?`)
        .bind(timestamp.toISOString(), timestamp.toISOString(), row.grant_id),
    ]);
    const effectiveScopes = Object.freeze([...scopes]) as EffectiveTokenScopes;
    return Object.freeze({
      kind: "authenticated",
      actor: Object.freeze({
        kind: "registered_principal",
        principalId: String(row.principal_id) as PrincipalId,
        authentication: Object.freeze({
          kind: "mcp_token",
          tokenId: String(row.id) as TokenId,
          bindingOwnerId: String(row.grant_id) as MindBindingOwnerId,
          effectiveScopes,
        }),
        deploymentCapabilities: MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
        requestId,
        occurredAtUtc: timestamp.toISOString() as UtcInstant,
      }),
    });
  };

  const listConnectionPage = async (
    principalId: string,
    query: OAuthConnectionPageQuery = {},
  ): Promise<Readonly<OAuthConnectionPage>> => {
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      throw new TypeError("OAuth connection page is invalid");
    }
    const requestedLimit = query.limit ?? 20;
    if (
      !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50 ||
      (query.cursor !== undefined && query.cursor !== null && typeof query.cursor !== "string")
    ) {
      throw new TypeError("OAuth connection page is invalid");
    }
    const actor = await connectionCursorActor(principalId);
    let limit = requestedLimit;
    let cursor: OAuthConnectionCursorPayload | null = null;
    if (query.cursor !== undefined && query.cursor !== null) {
      const decoded = decodeConnectionCursor(query.cursor);
      if (
        !isConnectionCursorPayload(decoded) ||
        decoded.actor !== actor ||
        (query.limit !== undefined && query.limit !== decoded.limit)
      ) {
        throw new TypeError("OAuth connection page cursor is invalid");
      }
      limit = decoded.limit;
      cursor = decoded;
    }
    await ensureSchema();
    const select = `SELECT id, connection_ref, client_name, scopes_json, created_at, last_used_at
      FROM md_oauth_grants`;
    const result = cursor === null
      ? await options.database
          .prepare(`/*md-oauth-connections-page-first*/ ${select}
            WHERE principal_id = ? AND revoked_at IS NULL
            ORDER BY created_at DESC, connection_ref DESC LIMIT ?`)
          .bind(principalId, limit + 1)
          .all<DbRow>()
      : await options.database
          .prepare(`/*md-oauth-connections-page-after*/ ${select}
            WHERE principal_id = ? AND revoked_at IS NULL
              AND (created_at < ? OR (created_at = ? AND connection_ref <= ?))
              AND (created_at < ? OR (created_at = ? AND connection_ref < ?))
            ORDER BY created_at DESC, connection_ref DESC LIMIT ?`)
          .bind(
            principalId,
            cursor.upperBound.createdAt,
            cursor.upperBound.createdAt,
            cursor.upperBound.connectionRef,
            cursor.after.createdAt,
            cursor.after.createdAt,
            cursor.after.connectionRef,
            limit + 1,
          )
          .all<DbRow>();
    const rows = [...(result.results ?? [])];
    const pageRows = rows.slice(0, limit);
    const items = Object.freeze(pageRows.map(connectionRecord));
    const last = pageRows.at(-1);
    const upper = cursor?.upperBound ?? (pageRows[0] === undefined
      ? null
      : Object.freeze({
          createdAt: String(pageRows[0].created_at),
          connectionRef: String(pageRows[0].connection_ref),
        }));
    const nextCursor = rows.length > limit && last !== undefined && upper !== null
      ? encodeConnectionCursor({
          v: 1,
          actor,
          filter: "active",
          limit,
          upperBound: upper,
          after: Object.freeze({
            createdAt: String(last.created_at),
            connectionRef: String(last.connection_ref),
          }),
        })
      : null;
    return Object.freeze({ items, nextCursor });
  };

  const readConnection = async (
    principalId: string,
    connectionRef: string,
  ): Promise<Readonly<OAuthConnectionRecord> | null> => {
    if (!CONNECTION_REF_PATTERN.test(connectionRef)) return null;
    await ensureSchema();
    const row = await statementFirst<DbRow>(
      options.database
        .prepare(`/*md-oauth-connection-read*/ SELECT id, connection_ref, client_name,
          scopes_json, created_at, last_used_at FROM md_oauth_grants
          WHERE principal_id = ? AND connection_ref = ? AND revoked_at IS NULL LIMIT 1`)
        .bind(principalId, connectionRef),
    );
    return row === null ? null : connectionRecord(row);
  };

  const revokeConnection = async (
    principalId: string,
    connectionRef: string,
  ): Promise<boolean> => {
    const connection = await readConnection(principalId, connectionRef);
    if (connection === null) return false;
    const grantId = connection.bindingOwnerId;
    const timestamp = now().toISOString();
    await revokeMirroredGrant(grantId, timestamp);
    await options.revokeWriteTargetOwner?.({
      bindingOwnerId: grantId,
      principalId,
      occurredAt: timestamp,
    });
    await options.database.batch([
      options.database
        .prepare(`/*md-oauth-grant-revoke*/ UPDATE md_oauth_grants SET revoked_at = ?, updated_at = ? WHERE id = ?`)
        .bind(timestamp, timestamp, grantId),
      options.database
        .prepare(`/*md-oauth-access-grant-revoke*/ UPDATE md_oauth_access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
        .bind(timestamp, grantId),
      options.database
        .prepare(`/*md-oauth-refresh-grant-revoke*/ UPDATE md_oauth_refresh_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
        .bind(timestamp, grantId),
    ]);
    return true;
  };

  const revokePrincipalConnections = async (principalId: string): Promise<void> => {
    await ensureSchema();
    const timestamp = now().toISOString();
    if (options.authorizationTokens !== undefined) {
      const rows = await options.database
        .prepare(`/*md-oauth-access-principal-list*/ SELECT id, principal_id
          FROM md_oauth_access_tokens WHERE principal_id = ? AND revoked_at IS NULL`)
        .bind(principalId)
        .all<DbRow>();
      await revokeMirroredRows(rows.results ?? [], timestamp);
    }
    await options.database.batch([
      options.database
        .prepare(`/*md-oauth-principal-grants-revoke*/ UPDATE md_oauth_grants SET revoked_at = ?, updated_at = ? WHERE principal_id = ? AND revoked_at IS NULL`)
        .bind(timestamp, timestamp, principalId),
      options.database
        .prepare(`/*md-oauth-principal-access-revoke*/ UPDATE md_oauth_access_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL`)
        .bind(timestamp, principalId),
      options.database
        .prepare(`/*md-oauth-principal-refresh-revoke*/ UPDATE md_oauth_refresh_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL`)
        .bind(timestamp, principalId),
      options.database
        .prepare(`/*md-oauth-principal-requests-delete*/ DELETE FROM md_oauth_authorization_requests WHERE principal_id = ?`)
        .bind(principalId),
    ]);
  };

  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    try {
      if (
        request.method === "GET" &&
        (url.pathname === "/.well-known/oauth-protected-resource/api/mcp" ||
          url.pathname === "/.well-known/oauth-protected-resource")
      ) {
        return json(200, protectedResourceMetadata());
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/.well-known/oauth-authorization-server" ||
          url.pathname === "/.well-known/openid-configuration")
      ) {
        return json(200, authorizationServerMetadata());
      }
      if (request.method === "POST" && url.pathname === "/oauth/register") {
        return await registerClient(request);
      }
      if (url.pathname === "/oauth/authorize") {
        if (request.method === "GET") return await prepareAuthorization(request);
        if (request.method === "POST") return await completeAuthorization(request);
        return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        return await tokenRequest(request);
      }
      if (request.method === "POST" && url.pathname === "/oauth/revoke") {
        return await revokeToken(request);
      }
      if (
        url.pathname.startsWith("/.well-known/oauth-") ||
        url.pathname.startsWith("/oauth/")
      ) {
        return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
      }
      return null;
    } catch (error) {
      return oauthErrorResponse(error);
    }
  };

  return Object.freeze({
    resource,
    protectedResourceMetadataUrl,
    authenticator: Object.freeze({ authenticate }),
    fetch: handle,
    listConnectionPage,
    readConnection,
    revokeConnection,
    revokePrincipalConnections,
  });
}
