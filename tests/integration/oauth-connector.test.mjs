import assert from "node:assert/strict";
import test from "node:test";

import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  createSitesOAuthConnector,
} from "../../packages/adapter-oauth-sites/dist/index.js";
import { InMemoryMcpTokenStore } from "../../packages/adapter-metadata-memory/dist/index.js";

const ORIGIN = "https://mind-diary.example";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

class Statement {
  values = [];
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  run() {
    return this.database.run(this.sql, this.values);
  }
  all() {
    return this.database.all(this.sql, this.values);
  }
  async first() {
    return (await this.all()).results?.[0] ?? null;
  }
}

class OAuthD1 {
  clients = new Map();
  requests = new Map();
  grants = new Map();
  codes = new Map();
  access = new Map();
  refresh = new Map();

  prepare(sql) {
    return new Statement(this, sql);
  }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  result(changes = 1) {
    return { success: true, meta: { changes } };
  }
  async run(sql, values) {
    if (/^CREATE (?:TABLE|INDEX)/u.test(sql.trim())) return this.result(0);
    if (sql.includes("/*md-oauth-client-create*/")) {
      this.clients.set(values[0], {
        id: values[0], client_name: values[1], redirect_uris_json: values[2],
        grant_types_json: values[3], response_types_json: values[4],
        token_endpoint_auth_method: values[5], created_at: values[6], last_used_at: null,
      });
      return this.result();
    }
    if (sql.includes("/*md-oauth-request-create*/")) {
      this.requests.set(values[0], {
        id: values[0], principal_id: values[1], client_id: values[2],
        client_name: values[3], redirect_uri: values[4], resource: values[5],
        scopes_json: values[6], state: values[7], code_challenge: values[8],
        expires_at: values[9], created_at: values[10],
      });
      return this.result();
    }
    if (sql.includes("/*md-oauth-grant-upsert*/")) {
      const existing = [...this.grants.values()].find(
        (row) => row.principal_id === values[1] && row.client_id === values[2] && row.resource === values[4],
      );
      const row = existing ?? {
        id: values[0], principal_id: values[1], client_id: values[2],
        resource: values[4], created_at: values[6], last_used_at: null,
      };
      Object.assign(row, {
        client_name: values[3], scopes_json: values[5], revoked_at: null,
        updated_at: values[7],
      });
      this.grants.set(row.id, row);
      return this.result();
    }
    if (sql.includes("/*md-oauth-code-create*/")) {
      this.codes.set(values[0], {
        id: values[0], code_verifier: values[1], grant_id: values[2],
        principal_id: values[3], client_id: values[4], redirect_uri: values[5],
        resource: values[6], scopes_json: values[7], code_challenge: values[8],
        expires_at: values[9], consumed_at: null,
      });
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-create*/")) {
      this.access.set(values[0], {
        id: values[0], token_verifier: values[1], grant_id: values[2],
        principal_id: values[3], client_id: values[4], resource: values[5],
        scopes_json: values[6], expires_at: values[7], created_at: values[8],
        last_used_at: null, revoked_at: null,
      });
      return this.result();
    }
    if (sql.includes("/*md-oauth-refresh-create*/")) {
      this.refresh.set(values[0], {
        id: values[0], token_verifier: values[1], grant_id: values[2], family_id: values[3],
        parent_id: values[4], principal_id: values[5], client_id: values[6],
        resource: values[7], scopes_json: values[8], expires_at: values[9],
        created_at: values[10], used_at: null, revoked_at: null,
      });
      return this.result();
    }
    if (sql.includes("/*md-oauth-grant-touch*/")) {
      const row = this.grants.get(values[2]);
      if (row) Object.assign(row, { last_used_at: values[0], updated_at: values[1] });
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-access-touch*/")) {
      const row = this.access.get(values[1]);
      if (row) row.last_used_at = values[0];
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-grant-revoke*/")) {
      const row = this.grants.get(values[2]);
      if (row) Object.assign(row, { revoked_at: values[0], updated_at: values[1] });
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-family-revoke*/")) {
      for (const row of this.refresh.values()) if (row.family_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-grant-revoke*/")) {
      for (const row of this.access.values()) if (row.grant_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-refresh-grant-revoke*/")) {
      for (const row of this.refresh.values()) if (row.grant_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-revoke*/")) {
      for (const row of this.access.values()) if (row.token_verifier === values[1] && row.client_id === values[2]) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-record-revoke*/")) {
      const row = this.access.get(values[1]);
      if (row && !row.revoked_at) row.revoked_at = values[0];
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-refresh-record-revoke*/")) {
      const row = this.refresh.get(values[1]);
      if (row && !row.revoked_at) row.revoked_at = values[0];
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-principal-grants-revoke*/")) {
      for (const row of this.grants.values()) if (row.principal_id === values[2] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-principal-access-revoke*/")) {
      for (const row of this.access.values()) if (row.principal_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-principal-refresh-revoke*/")) {
      for (const row of this.refresh.values()) if (row.principal_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-principal-requests-delete*/")) {
      for (const [id, row] of this.requests) if (row.principal_id === values[0]) this.requests.delete(id);
      return this.result();
    }
    throw new Error(`unsupported OAuth run: ${sql}`);
  }
  async all(sql, values) {
    if (sql.includes("/*md-oauth-client-read*/")) {
      return { results: this.clients.has(values[0]) ? [this.clients.get(values[0])] : [] };
    }
    if (sql.includes("/*md-oauth-request-consume*/")) {
      const row = this.requests.get(values[0]);
      if (!row || row.principal_id !== values[1] || row.expires_at <= values[2]) return { results: [] };
      this.requests.delete(values[0]);
      return { results: [{ ...row }] };
    }
    if (sql.includes("/*md-oauth-grant-read*/")) {
      const row = [...this.grants.values()].find(
        (item) => item.principal_id === values[0] && item.client_id === values[1] && item.resource === values[2],
      );
      return { results: row ? [{ id: row.id, scopes_json: row.scopes_json, revoked_at: row.revoked_at }] : [] };
    }
    if (sql.includes("/*md-oauth-code-read*/")) {
      const row = [...this.codes.values()].find(
        (item) => item.code_verifier === values[0] && !item.consumed_at && item.expires_at > values[1],
      );
      return { results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-oauth-code-consume*/")) {
      const row = this.codes.get(values[1]);
      if (!row || row.consumed_at) return { results: [] };
      row.consumed_at = values[0];
      return { results: [{ id: row.id }] };
    }
    if (sql.includes("/*md-oauth-access-authenticate*/")) {
      const row = [...this.access.values()].find((item) => item.token_verifier === values[0]);
      if (!row) return { results: [] };
      return { results: [{ ...row, grant_revoked_at: this.grants.get(row.grant_id)?.revoked_at ?? null }] };
    }
    if (sql.includes("/*md-oauth-access-grant-list*/")) {
      return { results: [...this.access.values()].filter((row) => row.grant_id === values[0] && !row.revoked_at).map((row) => ({ id: row.id, principal_id: row.principal_id })) };
    }
    if (sql.includes("/*md-oauth-access-principal-list*/")) {
      return { results: [...this.access.values()].filter((row) => row.principal_id === values[0] && !row.revoked_at).map((row) => ({ id: row.id, principal_id: row.principal_id })) };
    }
    if (sql.includes("/*md-oauth-access-owner*/")) {
      const row = [...this.access.values()].find((item) => item.token_verifier === values[0] && item.client_id === values[1]);
      return { results: row ? [{ id: row.id, principal_id: row.principal_id }] : [] };
    }
    if (sql.includes("/*md-oauth-refresh-read*/")) {
      const row = [...this.refresh.values()].find((item) => item.token_verifier === values[0]);
      if (!row) return { results: [] };
      return { results: [{ ...row, grant_revoked_at: this.grants.get(row.grant_id)?.revoked_at ?? null }] };
    }
    if (sql.includes("/*md-oauth-refresh-consume*/")) {
      const row = this.refresh.get(values[1]);
      if (!row || row.used_at || row.revoked_at) return { results: [] };
      row.used_at = values[0];
      return { results: [{ id: row.id }] };
    }
    if (sql.includes("/*md-oauth-refresh-owner*/")) {
      const row = [...this.refresh.values()].find((item) => item.token_verifier === values[0] && item.client_id === values[1]);
      return { results: row ? [{ grant_id: row.grant_id, family_id: row.family_id }] : [] };
    }
    if (sql.includes("/*md-oauth-connections-list*/")) {
      return { results: [...this.grants.values()].filter((row) => row.principal_id === values[0] && !row.revoked_at) };
    }
    if (sql.includes("/*md-oauth-connection-owner*/")) {
      const row = this.grants.get(values[0]);
      return { results: row && row.principal_id === values[1] && !row.revoked_at ? [{ id: row.id }] : [] };
    }
    throw new Error(`unsupported OAuth all: ${sql}`);
  }
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce(value) {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function environment(options = {}) {
  const database = new OAuthD1();
  const authorizationTokens = new InMemoryMcpTokenStore();
  const connector = await createSitesOAuthConnector({
    database,
    publicOrigin: ORIGIN,
    verifierKey: Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
    authorizationTokens,
    ...(options.now ? { now: options.now } : {}),
    resolveIdentity: async () => ({ kind: "authenticated", principalId: "principal_1" }),
  });
  return { database, connector, authorizationTokens };
}

async function register(connector) {
  const response = await connector.fetch(new Request(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT Mind Diary",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }));
  assert.equal(response.status, 201);
  return response.json();
}

async function authorize(connector, clientId, scopes = "content:read") {
  const codeVerifier = "v".repeat(64);
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    resource: `${ORIGIN}/api/mcp`, scope: scopes, state: "state-1",
    code_challenge: await pkce(codeVerifier), code_challenge_method: "S256",
  }).toString();
  const consent = await connector.fetch(new Request(url));
  assert.equal(consent.status, 200);
  const requestId = /name="request_id" value="([^"]+)"/u.exec(await consent.text())?.[1];
  assert.ok(requestId);
  const completed = await connector.fetch(new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, decision: "approve" }),
  }));
  assert.equal(completed.status, 303);
  const redirect = new URL(completed.headers.get("location"));
  assert.equal(redirect.searchParams.get("state"), "state-1");
  const tokens = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: redirect.searchParams.get("code"),
      client_id: clientId, redirect_uri: REDIRECT, resource: `${ORIGIN}/api/mcp`,
      code_verifier: codeVerifier,
    }),
  }));
  assert.equal(tokens.status, 200);
  return tokens.json();
}

test("OAuth discovery, DCR, PKCE, read grant, step-up, and revoke are durable", async () => {
  const { connector, authorizationTokens } = await environment();
  const protectedMetadata = await connector.fetch(
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`),
  );
  assert.deepEqual(await protectedMetadata.json(), {
    resource: `${ORIGIN}/api/mcp`,
    authorization_servers: [ORIGIN],
    scopes_supported: ["content:read", "content:write"],
    resource_name: "Mind Diary",
    resource_documentation: `${ORIGIN}/settings/mcp`,
  });
  const serverMetadata = await connector.fetch(
    new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
  );
  const serverMetadataBody = await serverMetadata.json();
  assert.equal(serverMetadataBody.code_challenge_methods_supported[0], "S256");
  const openIdCompatibilityMetadata = await connector.fetch(
    new Request(`${ORIGIN}/.well-known/openid-configuration`),
  );
  assert.deepEqual(await openIdCompatibilityMetadata.json(), serverMetadataBody);

  const client = await register(connector);
  const readTokens = await authorize(connector, client.client_id);
  assert.match(readTokens.access_token, new RegExp(`^${OAUTH_ACCESS_TOKEN_PREFIX}`));
  assert.equal(readTokens.scope, "content:read");
  const authenticatedRead = await connector.authenticator.authenticate(readTokens.access_token, "request_1");
  assert.equal(authenticatedRead.kind, "authenticated");
  assert.deepEqual(authenticatedRead.actor.authentication.effectiveScopes, ["content:read"]);
  assert.equal(
    (await authorizationTokens.readMcpTokenForAuthorization(
      authenticatedRead.actor.authentication.tokenId,
    )).state,
    "active",
  );

  const writeTokens = await authorize(connector, client.client_id, "content:write");
  assert.equal(writeTokens.scope, "content:read content:write");
  const authenticatedWrite = await connector.authenticator.authenticate(writeTokens.access_token, "request_2");
  assert.deepEqual(authenticatedWrite.actor.authentication.effectiveScopes, ["content:read", "content:write"]);
  const connections = await connector.listConnections("principal_1");
  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0].scopes, ["content:read", "content:write"]);
  assert.equal(await connector.revokeConnection("principal_1", connections[0].grantId), true);
  assert.deepEqual(await connector.authenticator.authenticate(writeTokens.access_token, "request_3"), { kind: "invalid" });
  assert.equal(
    (await authorizationTokens.readMcpTokenForAuthorization(
      authenticatedWrite.actor.authentication.tokenId,
    )).state,
    "revoked",
  );

  const reconnectedRead = await authorize(connector, client.client_id);
  assert.equal(reconnectedRead.scope, "content:read");
  assert.deepEqual(
    (await connector.listConnections("principal_1"))[0].scopes,
    ["content:read"],
  );
  const reconnectedActor = await connector.authenticator.authenticate(
    reconnectedRead.access_token,
    "request_reconnected",
  );
  assert.deepEqual(
    reconnectedActor.actor.authentication.effectiveScopes,
    ["content:read"],
  );
});

test("refresh rotation detects reuse and revokes the entire connection", async () => {
  const { connector } = await environment();
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const refreshForm = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: issued.refresh_token,
    client_id: client.client_id, resource: `${ORIGIN}/api/mcp`,
  });
  const rotated = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshForm,
  }));
  assert.equal(rotated.status, 200);
  const rotatedBody = await rotated.json();
  assert.notEqual(rotatedBody.refresh_token, issued.refresh_token);

  const reused = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshForm,
  }));
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, "invalid_grant");
  assert.deepEqual(await connector.authenticator.authenticate(rotatedBody.access_token, "request_reuse"), { kind: "invalid" });
});

test("OAuth rejects redirect/resource confusion and expires access tokens", async () => {
  let current = new Date("2026-08-17T20:00:00.000Z");
  const { connector } = await environment({ now: () => new Date(current) });
  const client = await register(connector);
  const verifier = "x".repeat(64);
  const authorization = async (overrides = {}) => {
    const url = new URL(`${ORIGIN}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      resource: `${ORIGIN}/api/mcp`,
      scope: "content:read",
      code_challenge: await pkce(verifier),
      code_challenge_method: "S256",
      ...overrides,
    }).toString();
    return connector.fetch(new Request(url));
  };
  const wrongRedirect = await authorization({ redirect_uri: "https://chatgpt.com/not-registered" });
  assert.equal(wrongRedirect.status, 400);
  assert.equal((await wrongRedirect.json()).error, "invalid_client");
  const wrongResource = await authorization({ resource: "https://other.example/api/mcp" });
  assert.equal(wrongResource.status, 400);
  assert.equal((await wrongResource.json()).error, "invalid_target");

  const tokens = await authorize(connector, client.client_id);
  current = new Date(current.getTime() + 16 * 60 * 1_000);
  assert.deepEqual(
    await connector.authenticator.authenticate(tokens.access_token, "request_expired"),
    { kind: "invalid" },
  );
});
