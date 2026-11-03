import assert from "node:assert/strict";
import test from "node:test";

import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_REUSE_GRACE_SECONDS,
  createSitesOAuthConnector,
} from "../../packages/adapter-oauth-sites/dist/index.js";
import { InMemoryMcpTokenStore } from "../../packages/adapter-metadata-memory/dist/index.js";
import { createProductWebHttpHandler } from "../../packages/adapter-web/dist/index.js";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";

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
  pendingRevocations = new Set();
  codes = new Map();
  access = new Map();
  refresh = new Map();
  connectionPageLimits = [];

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
    if (/^CREATE (?:UNIQUE )?(?:TABLE|INDEX)/u.test(sql.trim())) return this.result(0);
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
        (row) => row.principal_id === values[2] && row.client_id === values[3] && row.resource === values[5],
      );
      if (existing && values.length > 9 &&
          (existing.id !== values[9] || (existing.revoked_at ?? null) !== values[10] ||
           existing.scopes_json !== values[11])) return this.result(0);
      if (existing && this.pendingRevocations.has(existing.id)) return this.result(0);
      if (existing?.revoked_at && sql.includes("NOT EXISTS") &&
          [...this.access.values()].some((row) => row.grant_id === existing.id && !row.revoked_at)) return this.result(0);
      const reconnecting = existing?.revoked_at != null;
      const row = existing ?? {
        id: values[0], connection_ref: values[1], principal_id: values[2], client_id: values[3],
        resource: values[5], created_at: values[7], last_used_at: null,
      };
      if (reconnecting) {
        this.grants.delete(row.id);
        Object.assign(row, {
          id: values[0], connection_ref: values[1], created_at: values[7], last_used_at: null,
        });
      }
      Object.assign(row, {
        client_name: values[4], scopes_json: values[6], revoked_at: null,
        updated_at: values[8],
      });
      this.grants.set(row.id, row);
      return this.result();
    }
    if (sql.includes("/*md-oauth-code-create*/")) {
      if (values.length > 10 && (!this.grants.get(values[10]) || this.grants.get(values[10]).revoked_at)) return this.result(0);
      this.codes.set(values[0], {
        id: values[0], code_verifier: values[1], grant_id: values[2],
        principal_id: values[3], client_id: values[4], redirect_uri: values[5],
        resource: values[6], scopes_json: values[7], code_challenge: values[8],
        expires_at: values[9], consumed_at: null,
      });
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-create*/")) {
      if (values.length > 9 && (!this.grants.get(values[9]) || this.grants.get(values[9]).revoked_at)) return this.result(0);
      this.access.set(values[0], {
        id: values[0], token_verifier: values[1], grant_id: values[2],
        principal_id: values[3], client_id: values[4], resource: values[5],
        scopes_json: values[6], expires_at: values[7], created_at: values[8],
        last_used_at: null, revoked_at: null,
      });
      return this.result();
    }
    if (sql.includes("/*md-oauth-refresh-create*/")) {
      if (values.length > 11 && (!this.grants.get(values[11]) || this.grants.get(values[11]).revoked_at)) return this.result(0);
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
      if (sql.includes("revoked_at IS NULL") && row?.revoked_at) return this.result(0);
      if (row) Object.assign(row, { last_used_at: values[0], updated_at: values[1] });
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-revocation-pending*/")) {
      if (this.grants.has(values[0])) this.pendingRevocations.add(values[0]);
      return this.result();
    }
    if (sql.includes("/*md-oauth-revocation-complete*/")) {
      return this.result(this.pendingRevocations.delete(values[0]) ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-access-touch*/")) {
      const row = this.access.get(values[1]);
      if (row) row.last_used_at = values[0];
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-grant-revoke*/")) {
      const row = this.grants.get(values[2]);
      if (sql.includes("NOT EXISTS") && [...this.access.values()].some((item) => item.grant_id === values[2] && !item.revoked_at)) return this.result(0);
      if (sql.includes("revoked_at IS NULL") && row?.revoked_at) return this.result(0);
      if (row) Object.assign(row, { revoked_at: values[0], updated_at: values[1] });
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-grant-freeze*/")) {
      const row = this.grants.get(values[2]);
      if (!row || row.revoked_at) return this.result(0);
      Object.assign(row, { revoked_at: values[0], updated_at: values[1] });
      return this.result(1);
    }
    if (sql.includes("/*md-oauth-family-revoke*/")) {
      if (values.length > 2 && !this.grants.get(values[2])?.revoked_at) return this.result(0);
      for (const row of this.refresh.values()) if (row.family_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-grant-revoke*/")) {
      for (const row of this.access.values()) if (row.grant_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-refresh-grant-revoke*/")) {
      if (values.length > 2 && !this.grants.get(values[2])?.revoked_at) return this.result(0);
      for (const row of this.refresh.values()) if (row.grant_id === values[1] && !row.revoked_at) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-revoke*/")) {
      for (const row of this.access.values()) if (row.token_verifier === values[1] && row.client_id === values[2]) row.revoked_at = values[0];
      return this.result();
    }
    if (sql.includes("/*md-oauth-access-record-revoke*/")) {
      const row = this.access.get(values[1]);
      if (row && !row.revoked_at && (values.length < 3 || row.token_verifier === values[2])) row.revoked_at = values[0];
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-refresh-record-revoke*/")) {
      const row = this.refresh.get(values[1]);
      if (row && !row.revoked_at && (values.length < 3 || row.token_verifier === values[2])) row.revoked_at = values[0];
      return this.result(row ? 1 : 0);
    }
    if (sql.includes("/*md-oauth-refresh-unconsume*/")) {
      const row = this.refresh.get(values[0]);
      const grant = row && this.grants.get(row.grant_id);
      if (!row || row.used_at !== values[1] || row.revoked_at || !grant || grant.revoked_at) return this.result(0);
      row.used_at = null;
      return this.result(1);
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
      return { results: row ? [{
        id: row.id,
        connection_ref: row.connection_ref,
        scopes_json: row.scopes_json,
        revoked_at: row.revoked_at,
      }] : [] };
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
    if (sql.includes("/*md-oauth-issued-access-current*/")) {
      const row = this.access.get(values[0]);
      const grant = row && this.grants.get(row.grant_id);
      return { results: row && !row.revoked_at && grant && !grant.revoked_at ? [{ id: row.id }] : [] };
    }
    if (sql.includes("/*md-oauth-access-grant-list*/")) {
      return { results: [...this.access.values()].filter((row) => row.grant_id === values[0] && !row.revoked_at).map((row) => ({ id: row.id, principal_id: row.principal_id })) };
    }
    if (sql.includes("/*md-oauth-access-principal-list*/")) {
      return { results: [...this.access.values()].filter((row) => row.principal_id === values[0] && !row.revoked_at &&
        (!sql.includes("EXISTS") || this.grants.get(row.grant_id)?.revoked_at)).map((row) => ({ id: row.id, principal_id: row.principal_id })) };
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
      return { results: row ? [{
        grant_id: row.grant_id,
        family_id: row.family_id,
        principal_id: row.principal_id,
      }] : [] };
    }
    if (sql.includes("/*md-oauth-connections-page-first*/")) {
      this.connectionPageLimits.push(values[1]);
      const rows = [...this.grants.values()]
        .filter((row) => row.principal_id === values[0] && !row.revoked_at)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) ||
          right.connection_ref.localeCompare(left.connection_ref));
      return { results: rows.slice(0, values[1]) };
    }
    if (sql.includes("/*md-oauth-connections-page-after*/")) {
      const [principalId, upperAt, _upperAtAgain, upperRef, afterAt, _afterAtAgain, afterRef, limit] = values;
      this.connectionPageLimits.push(limit);
      const atOrBelow = (row, createdAt, connectionRef, inclusive) =>
        row.created_at < createdAt ||
        (row.created_at === createdAt && (inclusive
          ? row.connection_ref <= connectionRef
          : row.connection_ref < connectionRef));
      const rows = [...this.grants.values()]
        .filter((row) => row.principal_id === principalId && !row.revoked_at)
        .filter((row) => atOrBelow(row, upperAt, upperRef, true))
        .filter((row) => atOrBelow(row, afterAt, afterRef, false))
        .sort((left, right) => right.created_at.localeCompare(left.created_at) ||
          right.connection_ref.localeCompare(left.connection_ref));
      return { results: rows.slice(0, limit) };
    }
    if (sql.includes("/*md-oauth-connection-revoke-read*/")) {
      const row = [...this.grants.values()].find((item) => item.principal_id === values[0] && item.connection_ref === values[1] &&
        (!item.revoked_at || this.pendingRevocations.has(item.id) || [...this.access.values()].some((access) => access.grant_id === item.id && !access.revoked_at)));
      return { results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-oauth-connection-read*/")) {
      const row = [...this.grants.values()].find((item) =>
        item.principal_id === values[0] && item.connection_ref === values[1] && !item.revoked_at);
      return { results: row ? [{ ...row }] : [] };
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
  const database = options.database ?? new OAuthD1();
  const authorizationTokens = new InMemoryMcpTokenStore();
  const targetRegistrations = [];
  const targetRevocations = [];
  const connector = await createSitesOAuthConnector({
    database,
    publicOrigin: ORIGIN,
    verifierKey: Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
    authorizationTokens,
    registerWriteTargetOwner: options.registerWriteTargetOwner ?? ((input) => {
      targetRegistrations.push(input);
    }),
    revokeWriteTargetOwner: options.revokeWriteTargetOwner ?? ((input) => {
      targetRevocations.push(input);
    }),
    ...(options.now ? { now: options.now } : {}),
    resolveIdentity: async () => ({ kind: "authenticated", principalId: "principal_1" }),
  });
  return {
    database,
    connector,
    authorizationTokens,
    targetRegistrations,
    targetRevocations,
  };
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
  assert.equal(
    consent.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
  );
  const consentBody = await consent.text();
  assert.match(consentBody, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any"/u);
  assert.match(consentBody, /rel="apple-touch-icon" href="\/apple-touch-icon\.png" type="image\/png" sizes="180x180"/u);
  const requestId = /name="request_id" value="([^"]+)"/u.exec(consentBody)?.[1];
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
  const {
    connector,
    authorizationTokens,
    targetRegistrations,
    targetRevocations,
  } = await environment();
  const protectedMetadata = await connector.fetch(
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`),
  );
  assert.deepEqual(await protectedMetadata.json(), {
    resource: `${ORIGIN}/api/mcp`,
    authorization_servers: [ORIGIN],
    scopes_supported: ["content:read", "content:write", "personal:configure"],
    resource_name: "Mind Diary",
    resource_documentation: `${ORIGIN}/settings/developer/mcp`,
  });
  const serverMetadata = await connector.fetch(
    new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
  );
  const serverMetadataBody = await serverMetadata.json();
  assert.equal(serverMetadataBody.code_challenge_methods_supported[0], "S256");
  assert.equal("client_id_metadata_document_supported" in serverMetadataBody, false);
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
  assert.deepEqual(targetRegistrations.map(({ bindingOwnerId, principalId }) => ({
    bindingOwnerId,
    principalId,
  })), [{
    bindingOwnerId: authenticatedRead.actor.authentication.bindingOwnerId,
    principalId: "principal_1",
  }]);
  assert.deepEqual(authenticatedRead.actor.authentication.effectiveScopes, ["content:read"]);
  assert.equal(
    (await authorizationTokens.readMcpTokenForAuthorization(
      authenticatedRead.actor.authentication.tokenId,
    )).state,
    "active",
  );
  assert.deepEqual(await authorizationTokens.listMcpTokensMissingPresentationRefs(), []);
  assert.deepEqual((await authorizationTokens.listMcpTokenMetadataPage({
    principalId: "principal_1",
    state: "active",
    asOf: new Date().toISOString(),
    limit: 20,
  })).tokens, []);

  const writeTokens = await authorize(connector, client.client_id, "content:write");
  assert.equal(writeTokens.scope, "content:read content:write");
  const authenticatedWrite = await connector.authenticator.authenticate(writeTokens.access_token, "request_2");
  assert.deepEqual(authenticatedWrite.actor.authentication.effectiveScopes, ["content:read", "content:write"]);
  assert.equal(targetRegistrations.length, 2);
  assert.equal(
    targetRegistrations[1].bindingOwnerId,
    targetRegistrations[0].bindingOwnerId,
  );
  const connections = (await connector.listConnectionPage("principal_1")).items;
  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0].scopes, ["content:read", "content:write"]);
  assert.match(connections[0].connectionRef, /^conn_v1_[0-9a-f]{32}$/u);
  assert.equal(
    await connector.revokeConnection("principal_1", connections[0].connectionRef),
    true,
  );
  assert.equal(targetRevocations.length, 1);
  assert.deepEqual(
    {
      bindingOwnerId: targetRevocations[0].bindingOwnerId,
      principalId: targetRevocations[0].principalId,
    },
    { bindingOwnerId: connections[0].bindingOwnerId, principalId: "principal_1" },
  );
  assert.equal(Number.isFinite(Date.parse(targetRevocations[0].occurredAt)), true);
  assert.deepEqual(await connector.authenticator.authenticate(writeTokens.access_token, "request_3"), { kind: "invalid" });
  assert.equal(
    (await authorizationTokens.readMcpTokenForAuthorization(
      authenticatedWrite.actor.authentication.tokenId,
    )).state,
    "revoked",
  );

  const reconnectedRead = await authorize(connector, client.client_id);
  assert.equal(reconnectedRead.scope, "content:read");
  assert.equal(targetRegistrations.length, 3);
  assert.notEqual(
    targetRegistrations[2].bindingOwnerId,
    targetRegistrations[0].bindingOwnerId,
  );
  assert.deepEqual(
    (await connector.listConnectionPage("principal_1")).items[0].scopes,
    ["content:read"],
  );
  assert.notEqual(
    (await connector.listConnectionPage("principal_1")).items[0].connectionRef,
    connections[0].connectionRef,
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

test("connection refs and bounded cursors preserve actor-safe stable traversal", async () => {
  const fixed = new Date("2026-08-24T17:00:00.000Z");
  const { connector, database } = await environment({ now: () => new Date(fixed) });
  for (let index = 1; index <= 5; index += 1) {
    const client = await register(connector);
    database.clients.get(client.client_id).client_name = `Client ${index}`;
    await authorize(connector, client.client_id);
  }
  const before = [...database.grants.values()]
    .filter((row) => row.principal_id === "principal_1" && !row.revoked_at)
    .sort((left, right) => right.created_at.localeCompare(left.created_at) ||
      right.connection_ref.localeCompare(left.connection_ref))
    .map((row) => row.connection_ref);

  const first = await connector.listConnectionPage("principal_1", { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.nextCursor !== null, true);
  assert.equal(first.nextCursor.includes("conn_v1_"), false);
  assert.equal(first.items.every((item) => !("clientId" in item) && !("grantId" in item)), true);
  assert.deepEqual(first.items.map((item) => item.connectionRef), before.slice(0, 2));

  database.grants.set("md_oauth_grant_inserted_after_page", {
    id: "md_oauth_grant_inserted_after_page",
    connection_ref: `conn_v1_${"f".repeat(32)}`,
    principal_id: "principal_1",
    client_id: "md_oauth_client_inserted_after_page",
    client_name: "Inserted after page one",
    resource: `${ORIGIN}/api/mcp`,
    scopes_json: JSON.stringify(["content:read"]),
    revoked_at: null,
    created_at: fixed.toISOString(),
    updated_at: fixed.toISOString(),
    last_used_at: null,
  });
  const second = await connector.listConnectionPage("principal_1", { cursor: first.nextCursor });
  const third = await connector.listConnectionPage("principal_1", { cursor: second.nextCursor });
  assert.deepEqual(
    [...first.items, ...second.items, ...third.items].map((item) => item.connectionRef),
    before,
  );
  assert.equal(third.nextCursor, null);
  assert.equal(database.connectionPageLimits.every((limit) => limit === 3), true);

  await assert.rejects(
    connector.listConnectionPage("principal_2", { cursor: first.nextCursor }),
    TypeError,
  );
  await assert.rejects(
    connector.listConnectionPage("principal_1", { limit: 3, cursor: first.nextCursor }),
    TypeError,
  );
  const target = first.items[0];
  assert.equal(await connector.readConnection("principal_2", target.connectionRef), null);
  assert.equal(await connector.readConnection("principal_1", "conn_v1_invalid"), null);
  assert.equal(
    (await connector.readConnection("principal_1", target.connectionRef)).clientName,
    target.clientName,
  );
  assert.equal(await connector.revokeConnection("principal_2", target.connectionRef), false);
  assert.equal(await connector.revokeConnection("principal_1", target.connectionRef), true);
  assert.equal(await connector.readConnection("principal_1", target.connectionRef), null);
  assert.equal(await connector.revokeConnection("principal_1", target.connectionRef), false);
});

test("refresh rotation tolerates bounded concurrent reuse without revoking the connection", async () => {
  const current = new Date("2026-08-26T20:00:00.000Z");
  const { connector, targetRevocations } = await environment({ now: () => new Date(current) });
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const grantId = (await connector.listConnectionPage("principal_1")).items[0].bindingOwnerId;
  const refresh = () => connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: issued.refresh_token,
      client_id: client.client_id, resource: `${ORIGIN}/api/mcp`,
    }),
  }));
  const responses = await Promise.all([refresh(), refresh()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  const rotated = responses.find((response) => response.status === 200);
  const concurrent = responses.find((response) => response.status === 400);
  const rotatedBody = await rotated.json();
  const concurrentBody = await concurrent.json();
  assert.notEqual(rotatedBody.refresh_token, issued.refresh_token);
  assert.equal(concurrentBody.error, "invalid_grant");
  assert.match(concurrentBody.error_description, /reload the latest stored credentials/u);
  assert.equal(targetRevocations.length, 0);
  assert.equal((await connector.listConnectionPage("principal_1")).items[0].bindingOwnerId, grantId);
  assert.equal(
    (await connector.authenticator.authenticate(rotatedBody.access_token, "request_concurrent")).kind,
    "authenticated",
  );
});

test("refresh reuse after the bounded grace revokes the entire connection", async () => {
  let current = new Date("2026-08-26T20:00:00.000Z");
  const { connector, targetRevocations } = await environment({ now: () => new Date(current) });
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const grantId = (await connector.listConnectionPage("principal_1")).items[0].bindingOwnerId;
  const refreshForm = () => new URLSearchParams({
    grant_type: "refresh_token", refresh_token: issued.refresh_token,
    client_id: client.client_id, resource: `${ORIGIN}/api/mcp`,
  });
  const rotated = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshForm(),
  }));
  assert.equal(rotated.status, 200);
  const rotatedBody = await rotated.json();
  current = new Date(current.getTime() + OAUTH_REFRESH_REUSE_GRACE_SECONDS * 1_000 + 1);

  const reused = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshForm(),
  }));
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, "invalid_grant");
  assert.equal(targetRevocations.length, 1);
  assert.equal(targetRevocations[0].principalId, "principal_1");
  assert.equal(targetRevocations[0].bindingOwnerId, grantId);
  assert.deepEqual(await connector.authenticator.authenticate(rotatedBody.access_token, "request_reuse"), { kind: "invalid" });
});

test("refresh can be retried after token mirror creation fails before credentials are returned", async () => {
  let current = new Date("2026-08-26T20:00:00.000Z");
  const { connector, authorizationTokens, database } = await environment({ now: () => new Date(current) });
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const create = authorizationTokens.createMcpToken.bind(authorizationTokens);
  authorizationTokens.createMcpToken = async () => { throw new Error("synthetic mirror outage"); };
  const request = () => new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token,
      client_id: client.client_id, resource: `${ORIGIN}/api/mcp` }),
  });
  assert.equal((await connector.fetch(request())).status, 500);
  authorizationTokens.createMcpToken = create;
  current = new Date(current.getTime() + (OAUTH_REFRESH_REUSE_GRACE_SECONDS + 1) * 1_000);
  const retried = await connector.fetch(request());
  assert.equal(retried.status, 200, await retried.clone().text());
  const result = await retried.json();
  assert.equal((await connector.authenticator.authenticate(result.access_token, "request_retry")).kind, "authenticated");
  assert.equal([...database.access.values()].filter((row) => row.revoked_at).length, 1);
  assert.equal([...database.refresh.values()].filter((row) => row.revoked_at).length, 1);
});

test("a definite mirror ID collision never revokes the pre-existing token", async () => {
  const { connector, authorizationTokens } = await environment();
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  let revocations = 0;
  authorizationTokens.createMcpToken = async () => ({ kind: "token_id_conflict" });
  authorizationTokens.revokeMcpToken = async () => { revocations += 1; return { kind: "not_found" }; };
  const failed = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token,
      client_id: client.client_id, resource: `${ORIGIN}/api/mcp` }),
  }));
  assert.equal(failed.status, 500);
  assert.equal(revocations, 0);
});

test("a partial connection revoke resumes after already fenced access rows", async () => {
  const { connector, authorizationTokens, database } = await environment();
  const client = await register(connector);
  await authorize(connector, client.client_id);
  await authorize(connector, client.client_id);
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  const revoke = authorizationTokens.revokeMcpToken.bind(authorizationTokens);
  const seen = [];
  authorizationTokens.revokeMcpToken = async (request) => {
    seen.push(request.tokenId);
    if (seen.length === 2) throw new Error("synthetic interruption");
    return revoke(request);
  };
  await assert.rejects(connector.revokeConnection("principal_1", connection.connectionRef), /synthetic interruption/u);
  assert.equal([...database.access.values()].filter((row) => row.revoked_at).length, 1);
  assert.equal((await connector.listConnectionPage("principal_1")).items.length, 0);
  authorizationTokens.revokeMcpToken = async (request) => { seen.push(request.tokenId); return revoke(request); };
  assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
  assert.equal(seen.filter((id) => id === seen[0]).length, 1);
  assert.equal([...database.access.values()].filter((row) => !row.revoked_at).length, 0);
});

test("explicit reconnect finishes an interrupted revoke before creating a new grant", async () => {
  const { connector, authorizationTokens } = await environment();
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  const revoke = authorizationTokens.revokeMcpToken.bind(authorizationTokens);
  authorizationTokens.revokeMcpToken = async () => { throw new Error("synthetic interruption"); };
  await assert.rejects(connector.revokeConnection("principal_1", connection.connectionRef), /synthetic interruption/u);
  authorizationTokens.revokeMcpToken = revoke;
  const reconnected = await authorize(connector, client.client_id);
  const current = (await connector.listConnectionPage("principal_1")).items[0];
  assert.notEqual(current.connectionRef, connection.connectionRef);
  assert.deepEqual(await connector.authenticator.authenticate(issued.access_token, "request_old_grant"), { kind: "invalid" });
  assert.equal((await connector.authenticator.authenticate(reconnected.access_token, "request_new_grant")).kind, "authenticated");
});

test("owner-fence failure freezes the connection and keeps revoke retryable", async () => {
  let fail = true;
  const { connector } = await environment({ revokeWriteTargetOwner: () => {
    if (fail) throw new Error("synthetic owner fence outage");
  } });
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  await assert.rejects(connector.revokeConnection("principal_1", connection.connectionRef), /owner fence outage/u);
  assert.equal((await connector.listConnectionPage("principal_1")).items.length, 0);
  assert.deepEqual(await connector.authenticator.authenticate(issued.access_token, "owner_outage"), { kind: "invalid" });
  fail = false;
  assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
});

test("a failed grant freeze leaves the connection active and revoke retryable", async () => {
  let ownerFenced = false;
  const { connector, authorizationTokens, database } = await environment({
    revokeWriteTargetOwner: () => { ownerFenced = true; },
  });
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const actor = await connector.authenticator.authenticate(issued.access_token, "request_before_freeze_failure");
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  const batch = database.batch.bind(database);
  let fail = true;
  database.batch = async (statements) => {
    if (fail && statements.some((statement) => statement.sql.includes("/*md-oauth-grant-freeze*/"))) {
      fail = false;
      throw new Error("synthetic freeze failure");
    }
    return batch(statements);
  };
  await assert.rejects(connector.revokeConnection("principal_1", connection.connectionRef), /freeze failure/u);
  assert.equal(ownerFenced, false);
  assert.equal((await connector.listConnectionPage("principal_1")).items.length, 1);
  assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
  assert.equal((await authorizationTokens.readMcpTokenForAuthorization(actor.actor.authentication.tokenId)).state, "revoked");
});

test("web DELETE resumes a partially failed revoke through the real connector", async () => {
  const { connector, authorizationTokens } = await environment();
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  const actor = { kind: "registered_principal", principalId: "principal_1",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    requestId: "request_web_retry", occurredAtUtc: new Date().toISOString(), deploymentCapabilities: [] };
  const handler = createProductWebHttpHandler({ applicationOrigin: ORIGIN,
    resolveIdentity: () => ({ kind: "authenticated", actor }),
    csrf: { issue: () => "csrf", verify: () => true },
    control: { execute() { throw new Error("unexpected operation"); } },
    oauthConnections: { listPage: connector.listConnectionPage,
      read: connector.readConnection, revoke: connector.revokeConnection },
  });
  const request = () => new Request(`${ORIGIN}/api/v1/connections/${connection.connectionRef}`, {
    method: "DELETE", headers: { origin: ORIGIN, "x-csrf-token": "csrf", "idempotency-key": "retry-web" },
  });
  const revoke = authorizationTokens.revokeMcpToken.bind(authorizationTokens);
  authorizationTokens.revokeMcpToken = async () => { throw new Error("synthetic interruption"); };
  assert.notEqual((await handler(request())).status, 200);
  assert.deepEqual(await connector.authenticator.authenticate(issued.access_token, "request_web_frozen"), { kind: "invalid" });
  authorizationTokens.revokeMcpToken = revoke;
  assert.equal((await handler(request())).status, 200);
});

test("not_found cannot falsely fence a still-present OAuth mirror", async () => {
  const { connector, authorizationTokens, database } = await environment();
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  authorizationTokens.revokeMcpToken = async () => ({ kind: "not_found" });
  await assert.rejects(connector.revokeConnection("principal_1", connection.connectionRef), /mirror is unavailable/u);
  assert.equal([...database.access.values()].filter((row) => !row.revoked_at).length, 1);
  assert.deepEqual(await connector.authenticator.authenticate(issued.access_token, "request_missing_mirror"), { kind: "invalid" });
  assert.equal((await connector.listConnectionPage("principal_1")).items.length, 0);
});

test("failed single-token revoke does not hide a live mirror from connection revoke", async () => {
  const { connector, authorizationTokens, database } = await environment();
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const actor = await connector.authenticator.authenticate(issued.access_token, "request_before_token_revoke");
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  const revoke = authorizationTokens.revokeMcpToken.bind(authorizationTokens);
  authorizationTokens.revokeMcpToken = async () => ({ kind: "not_found" });
  const response = await connector.fetch(new Request(`${ORIGIN}/oauth/revoke`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: issued.access_token, client_id: client.client_id }),
  }));
  assert.equal(response.status, 503);
  assert.equal([...database.access.values()].filter((row) => !row.revoked_at).length, 1);
  authorizationTokens.revokeMcpToken = revoke;
  assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
  assert.equal((await authorizationTokens.readMcpTokenForAuthorization(actor.actor.authentication.tokenId)).state, "revoked");
});

test("connection revoke cannot succeed while a concurrent issuance remains unfenced", async () => {
  const { connector, authorizationTokens } = await environment();
  const client = await register(connector);
  const initial = await authorize(connector, client.client_id);
  const actor = await connector.authenticator.authenticate(initial.access_token, "request_before_revoke");
  assert.equal(actor.kind, "authenticated");
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  const revoke = authorizationTokens.revokeMcpToken.bind(authorizationTokens);
  let release;
  let entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  authorizationTokens.revokeMcpToken = async (request) => {
    if (first) { first = false; entered(); await held; }
    return revoke(request);
  };
  const revoking = connector.revokeConnection("principal_1", connection.connectionRef);
  await paused;
  const concurrent = await authorize(connector, client.client_id).then((tokens) => tokens, (error) => error);
  release();
  const result = await revoking;
  const mirror = await authorizationTokens.readMcpTokenForAuthorization(actor.actor.authentication.tokenId);
  assert.equal(result, true);
  assert.equal(mirror.state, "revoked");
  if (!(concurrent instanceof Error)) {
    const newActor = await connector.authenticator.authenticate(concurrent.access_token, "request_new_connection");
    assert.equal(newActor.kind, "authenticated");
    assert.notEqual(newActor.actor.authentication.bindingOwnerId, actor.actor.authentication.bindingOwnerId);
  }
});

test("a mirror created after grant freeze cannot publish its credential", async () => {
  const { connector, authorizationTokens } = await environment();
  const client = await register(connector);
  const issued = await authorize(connector, client.client_id);
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  const create = authorizationTokens.createMcpToken.bind(authorizationTokens);
  let release;
  let entered;
  let lateTokenId;
  const paused = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  authorizationTokens.createMcpToken = async (input) => {
    lateTokenId = input.tokenId;
    entered();
    await held;
    return create(input);
  };
  const rotating = connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token,
      client_id: client.client_id, resource: `${ORIGIN}/api/mcp` }),
  }));
  await paused;
  assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
  release();
  assert.equal((await rotating).status, 500);
  assert.equal((await authorizationTokens.readMcpTokenForAuthorization(lateTokenId)).state, "revoked");
  assert.deepEqual(await connector.authenticator.authenticate(issued.access_token, "request_after_freeze"), { kind: "invalid" });
});

test("stale consent cannot reactivate a grant revoked while consent was pending", async () => {
  let pause = false;
  let entered;
  let release;
  const paused = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const { connector } = await environment({ registerWriteTargetOwner: async () => {
    if (pause) { entered(); await held; }
  } });
  const client = await register(connector);
  const original = await authorize(connector, client.client_id);
  const connection = (await connector.listConnectionPage("principal_1")).items[0];
  pause = true;
  const staleConsent = authorize(connector, client.client_id).then(() => null, (error) => error);
  await paused;
  assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
  release();
  assert.ok(await staleConsent instanceof Error);
  assert.equal((await connector.listConnectionPage("principal_1")).items.length, 0);
  assert.deepEqual(await connector.authenticator.authenticate(original.access_token, "request_stale_consent"), { kind: "invalid" });
});

test("guarded issuance, refresh and revoke execute on transactional SQLite", async () => {
  const database = new SqliteD1();
  try {
    const { connector } = await environment({ database });
    const client = await register(connector);
    const issued = await authorize(connector, client.client_id);
    const response = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token,
        client_id: client.client_id, resource: `${ORIGIN}/api/mcp` }),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    const rotated = await response.json();
    const connection = (await connector.listConnectionPage("principal_1")).items[0];
    assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
    assert.deepEqual(await connector.authenticator.authenticate(rotated.access_token, "request_sqlite"), { kind: "invalid" });
  } finally { database.close(); }
});

test("transactional SQLite fences a mirror created after grant freeze", async () => {
  const database = new SqliteD1();
  try {
    const { connector, authorizationTokens } = await environment({ database });
    const client = await register(connector);
    const issued = await authorize(connector, client.client_id);
    const connection = (await connector.listConnectionPage("principal_1")).items[0];
    const create = authorizationTokens.createMcpToken.bind(authorizationTokens);
    let release;
    let entered;
    let lateTokenId;
    const held = new Promise((resolve) => { release = resolve; });
    const paused = new Promise((resolve) => { entered = resolve; });
    authorizationTokens.createMcpToken = async (input) => {
      lateTokenId = input.tokenId;
      entered();
      await held;
      return create(input);
    };
    const rotating = connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token,
        client_id: client.client_id, resource: `${ORIGIN}/api/mcp` }),
    }));
    await paused;
    assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
    release();
    assert.equal((await rotating).status, 500);
    assert.equal((await authorizationTokens.readMcpTokenForAuthorization(lateTokenId)).state, "revoked");
  } finally { database.close(); }
});

test("transactional SQLite does not reopen a grant from stale consent", async () => {
  const database = new SqliteD1();
  try {
    let pause = false;
    let entered;
    let release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const { connector } = await environment({ database, registerWriteTargetOwner: async () => {
      if (pause) { entered(); await held; }
    } });
    const client = await register(connector);
    await authorize(connector, client.client_id);
    const connection = (await connector.listConnectionPage("principal_1")).items[0];
    pause = true;
    const staleConsent = authorize(connector, client.client_id).then(() => null, (error) => error);
    await paused;
    assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
    release();
    assert.ok(await staleConsent instanceof Error);
    assert.equal((await connector.listConnectionPage("principal_1")).items.length, 0);
  } finally { database.close(); }
});

test("transactional SQLite reconnect completes a partially revoked grant", async () => {
  const database = new SqliteD1();
  try {
    const { connector, authorizationTokens } = await environment({ database });
    const client = await register(connector);
    const issued = await authorize(connector, client.client_id);
    const old = (await connector.listConnectionPage("principal_1")).items[0];
    const revoke = authorizationTokens.revokeMcpToken.bind(authorizationTokens);
    authorizationTokens.revokeMcpToken = async () => { throw new Error("synthetic interruption"); };
    await assert.rejects(connector.revokeConnection("principal_1", old.connectionRef), /synthetic interruption/u);
    authorizationTokens.revokeMcpToken = revoke;
    const next = await authorize(connector, client.client_id);
    const current = (await connector.listConnectionPage("principal_1")).items[0];
    assert.notEqual(current.connectionRef, old.connectionRef);
    assert.deepEqual(await connector.authenticator.authenticate(issued.access_token, "request_sqlite_old"), { kind: "invalid" });
    assert.equal((await connector.authenticator.authenticate(next.access_token, "request_sqlite_new")).kind, "authenticated");
  } finally { database.close(); }
});

test("transactional SQLite freezes refresh reuse and explicit revoke despite an owner outage", async () => {
  for (const trigger of ["reuse", "rfc7009"]) {
    const database = new SqliteD1();
    try {
      let current = new Date("2026-08-26T20:00:00.000Z");
      let fail = false;
      const { connector } = await environment({ database, now: () => new Date(current),
        revokeWriteTargetOwner: () => { if (fail) throw new Error("synthetic owner outage"); } });
      const client = await register(connector);
      const issued = await authorize(connector, client.client_id);
      const connection = (await connector.listConnectionPage("principal_1")).items[0];
      const refresh = (token) => connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token,
          client_id: client.client_id, resource: `${ORIGIN}/api/mcp` }),
      }));
      const rotatedResponse = await refresh(issued.refresh_token);
      assert.equal(rotatedResponse.status, 200);
      const rotated = await rotatedResponse.json();
      current = new Date(current.getTime() + OAUTH_REFRESH_REUSE_GRACE_SECONDS * 1_000 + 1);
      fail = true;
      const response = trigger === "reuse"
        ? await refresh(issued.refresh_token)
        : await connector.fetch(new Request(`${ORIGIN}/oauth/revoke`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: rotated.refresh_token, client_id: client.client_id }),
          }));
      assert.equal(response.status, trigger === "reuse" ? 500 : 503);
      assert.deepEqual(await connector.authenticator.authenticate(rotated.access_token, "after_owner_outage"), { kind: "invalid" });
      assert.equal((await refresh(rotated.refresh_token)).status, 400);
      fail = false;
      assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
      assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), false);
    } finally { database.close(); }
  }
});

test("transactional SQLite retains a retry marker when no unrevoked access rows remain", async () => {
  const database = new SqliteD1();
  try {
    let fail = false;
    const { connector } = await environment({ database,
      revokeWriteTargetOwner: () => { if (fail) throw new Error("synthetic owner outage"); } });
    const client = await register(connector);
    const issued = await authorize(connector, client.client_id);
    const connection = (await connector.listConnectionPage("principal_1")).items[0];
    const accessRevoke = await connector.fetch(new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: issued.access_token, client_id: client.client_id }),
    }));
    assert.equal(accessRevoke.status, 200);
    fail = true;
    await assert.rejects(connector.revokeConnection("principal_1", connection.connectionRef), /owner outage/u);
    assert.equal((await connector.listConnectionPage("principal_1")).items.length, 0);
    fail = false;
    assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), true);
    assert.equal(await connector.revokeConnection("principal_1", connection.connectionRef), false);
  } finally { database.close(); }
});

test("transactional SQLite rejects stale consent without losing another consent's scopes", async () => {
  const database = new SqliteD1();
  try {
    let pause = false;
    let entered;
    let release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const { connector } = await environment({ database, registerWriteTargetOwner: async () => {
      if (pause) { pause = false; entered(); await held; }
    } });
    const client = await register(connector);
    await authorize(connector, client.client_id);
    pause = true;
    const stale = authorize(connector, client.client_id, "personal:configure").then(() => null, (error) => error);
    await paused;
    await authorize(connector, client.client_id, "content:write");
    release();
    assert.ok(await stale instanceof Error);
    assert.deepEqual((await connector.listConnectionPage("principal_1")).items[0].scopes, ["content:read", "content:write"]);
    await authorize(connector, client.client_id, "personal:configure");
    assert.deepEqual((await connector.listConnectionPage("principal_1")).items[0].scopes, ["content:read", "content:write", "personal:configure"]);
  } finally { database.close(); }
});

test("account cascade removes pending revocation markers with the principal's OAuth rows", async () => {
  const database = new SqliteD1();
  try {
    const { connector } = await environment({ database,
      revokeWriteTargetOwner: () => { throw new Error("synthetic owner outage"); } });
    const client = await register(connector);
    await authorize(connector, client.client_id);
    const connection = (await connector.listConnectionPage("principal_1")).items[0];
    await assert.rejects(connector.revokeConnection("principal_1", connection.connectionRef), /owner outage/u);
    assert.equal(database.sqlite.prepare("SELECT count(*) AS n FROM md_oauth_revocation_pending").get().n, 1);
    await connector.deletePrincipalConnections("principal_1");
    assert.equal(database.sqlite.prepare("SELECT count(*) AS n FROM md_oauth_revocation_pending").get().n, 0);
    assert.equal(database.sqlite.prepare("SELECT count(*) AS n FROM md_oauth_grants").get().n, 0);
  } finally { database.close(); }
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


test("Personal configuration scope is explicit, independent and preserved by refresh", async () => {
  const { connector } = await environment();
  const client = await register(connector);
  const old = await authorize(connector, client.client_id);
  assert.equal(old.scope, "content:read");
  const configured = await authorize(connector, client.client_id, "personal:configure");
  const authentication = await connector.authenticator.authenticate(configured.access_token, "request_configuration_scope");
  assert.equal(authentication.kind, "authenticated");
  assert.ok(authentication.actor.authentication.effectiveScopes.includes("personal:configure"));
  const oldAuthentication = await connector.authenticator.authenticate(old.access_token, "request_old_scope");
  assert.equal(oldAuthentication.kind, "authenticated");
  assert.deepEqual(oldAuthentication.actor.authentication.effectiveScopes, ["content:read"]);
  const response = await connector.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: configured.refresh_token,
      client_id: client.client_id, resource: `${ORIGIN}/api/mcp` }) }));
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  const freshAuthentication = await connector.authenticator.authenticate(refreshed.access_token, "request_refreshed_configuration");
  assert.equal(freshAuthentication.kind, "authenticated");
  assert.deepEqual(freshAuthentication.actor.authentication.effectiveScopes, authentication.actor.authentication.effectiveScopes);
});
