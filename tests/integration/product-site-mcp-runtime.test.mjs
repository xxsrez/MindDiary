import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_ENDPOINT,
  MCP_LEGACY_CODEX_ENDPOINT,
  MCP_LEGACY_CODEX_PROTOCOL,
  MCP_RETIRED_SITES_ENDPOINT,
  MCP_TARGET_PROTOCOL,
} from "../../packages/adapter-mcp/dist/index.js";
import { createProductSiteRuntime } from "../../packages/composition-root/dist/index.js";

const ORIGIN = "https://mind-diary.example";

class FakeD1Statement {
  #database;
  #sql;
  #values = [];

  constructor(database, sql) {
    this.#database = database;
    this.#sql = sql;
  }

  bind(...values) {
    this.#values = values;
    return this;
  }

  async run() {
    return this.#database.run(this.#sql, this.#values);
  }

  async all() {
    return this.#database.all(this.#sql, this.#values);
  }

  async first() {
    return (await this.all()).results?.[0] ?? null;
  }
}

class FakeD1Database {
  metadataEvents = [];
  search = new Map();
  audit = new Map();

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async run(sql, values) {
    if (/^\s*(?:CREATE TABLE|CREATE INDEX)/u.test(sql)) {
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("migration*/")) {
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-append*/")) {
      const expected = Number(values[5]);
      const current = this.metadataEvents.at(-1)?.sequence ?? 0;
      if (current !== expected) return { success: true, meta: { changes: 0 } };
      this.metadataEvents.push({
        sequence: Number(values[0]),
        target: values[1],
        operation: values[2],
        payload_json: values[3],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-search-replace*/")) {
      this.search.set(`${values[0]}\u0000${values[1]}`, values[2]);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-search-purge*/")) {
      let changes = 0;
      for (const key of [...this.search.keys()]) {
        if (key.startsWith(`${values[0]}\u0000`)) {
          this.search.delete(key);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-audit-deliver*/")) {
      if (this.audit.has(values[0])) return { success: true, meta: { changes: 0 } };
      this.audit.set(values[0], {
        audit_event_id: values[0],
        space_id: values[1],
        actor_kind: values[2],
        principal_id: values[3],
        event_json: values[4],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-audit-purge*/")) {
      let changes = 0;
      for (const [id, row] of [...this.audit]) {
        if (row.space_id === values[0]) {
          this.audit.delete(id);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-audit-tombstone*/")) {
      const row = this.audit.get(values[1]);
      if (!row || row.principal_id !== values[2]) {
        return { success: true, meta: { changes: 0 } };
      }
      this.audit.set(values[1], {
        ...row,
        actor_kind: "deleted-principal",
        principal_id: null,
        event_json: values[0],
      });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`unsupported FakeD1 run statement: ${sql}`);
  }

  async all(sql, values) {
    if (sql.includes("/*md-metadata-events*/")) {
      return {
        success: true,
        results: this.metadataEvents.map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-search-read*/")) {
      const documents_json = this.search.get(`${values[0]}\u0000${values[1]}`);
      return {
        success: true,
        results: documents_json === undefined ? [] : [{ documents_json }],
      };
    }
    if (sql.includes("/*md-audit-by-principal*/")) {
      return {
        success: true,
        results: [...this.audit.values()]
          .filter((row) => row.principal_id === values[0])
          .sort((left, right) => left.audit_event_id.localeCompare(right.audit_event_id))
          .map((row) => ({
            audit_event_id: row.audit_event_id,
            event_json: row.event_json,
          })),
      };
    }
    throw new Error(`unsupported FakeD1 all statement: ${sql}`);
  }
}

class FakeR2Body {
  #bytes;

  constructor(record) {
    this.key = record.key;
    this.size = record.bytes.byteLength;
    this.etag = record.etag;
    this.customMetadata = { ...record.customMetadata };
    this.#bytes = new Uint8Array(record.bytes);
  }

  async arrayBuffer() {
    return new Uint8Array(this.#bytes).buffer;
  }
}

class FakeR2Bucket {
  records = new Map();
  #version = 0;

  async get(key) {
    const record = this.records.get(key);
    return record ? new FakeR2Body(record) : null;
  }

  async put(key, value, options = {}) {
    const current = this.records.get(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) {
      return null;
    }
    const bytes = value instanceof Uint8Array
      ? new Uint8Array(value)
      : new Uint8Array(value);
    const record = {
      key,
      bytes,
      etag: `etag-${++this.#version}`,
      customMetadata: { ...(options.customMetadata ?? {}) },
    };
    this.records.set(key, record);
    return new FakeR2Body(record);
  }

  async delete(keyOrKeys) {
    for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
      this.records.delete(key);
    }
  }

  async list(options = {}) {
    const all = [...this.records.values()]
      .filter((record) => record.key.startsWith(options.prefix ?? ""))
      .sort((left, right) => left.key.localeCompare(right.key));
    const offset = Number(options.cursor ?? 0);
    const limit = options.limit ?? 1000;
    const page = all.slice(offset, offset + limit).map((record) => new FakeR2Body(record));
    const next = offset + page.length;
    return {
      objects: page,
      truncated: next < all.length,
      ...(next < all.length ? { cursor: String(next) } : {}),
    };
  }
}

function key(seed) {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) % 256);
}

function csrfFromHtml(html) {
  const match = /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(html);
  assert.ok(match, "server-rendered page must include a CSRF token");
  return match[1];
}

async function responseFrom(runtime, request) {
  const response = await runtime.fetch(request);
  assert.ok(response instanceof Response);
  return response;
}

async function legacyMcp(runtime, secret, body) {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${secret}`,
    "content-type": "application/json; charset=utf-8",
    ...(body.method === "initialize"
      ? {}
      : { "mcp-protocol-version": MCP_LEGACY_CODEX_PROTOCOL }),
  });
  return responseFrom(runtime, new Request(`${ORIGIN}${MCP_LEGACY_CODEX_ENDPOINT}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

async function modernMcp(runtime, secret, body) {
  return responseFrom(runtime, new Request(`${ORIGIN}${MCP_ENDPOINT}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": body.method,
      "mcp-protocol-version": MCP_TARGET_PROTOCOL,
    },
    body: JSON.stringify(body),
  }));
}

test("durable product runtime carries a Sites account token through Codex MCP and revokes it", async () => {
  const runtime = await createProductSiteRuntime({
    database: new FakeD1Database(),
    bucket: new FakeR2Bucket(),
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: " Runtime.Owner@Example.COM ",
          verifiedFullName: "Runtime Owner",
        };
      },
    },
    tokenVerifierKey: key(1),
    locatorKey: key(41),
    exportDownloadVerifierKey: key(81),
    csrfKey: key(121),
    schedule() {},
  });

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  assert.equal(registration.status, 200);
  const registrationCsrf = csrfFromHtml(await registration.text());

  const preBootstrapSession = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/session`),
  );
  assert.equal(preBootstrapSession.status, 409);
  assert.equal((await preBootstrapSession.json()).error.code, "registration_required");

  const bootstrapped = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:product-runtime-e2e",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrapped.status, 200);
  assert.equal((await bootstrapped.json()).data.replayed, false);

  const session = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/session`));
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.data.principal.display_name, "Runtime Owner");
  assert.equal(sessionBody.data.personal_mind.route, "/me");

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/mcp`));
  assert.equal(settings.status, 200);
  const registeredCsrf = csrfFromHtml(await settings.text());

  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registeredCsrf,
      "idempotency-key": "issue:product-runtime-e2e",
    },
    body: JSON.stringify({
      name: "Codex runtime proof",
      scopes: ["content:write"],
    }),
  }));
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  const secret = issuedBody.data.secret;
  const tokenId = issuedBody.data.token.token_id;
  assert.match(secret, /^mdp_v1_/u);
  assert.equal(typeof tokenId, "string");

  const discovery = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "discover-runtime-profile",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-runtime-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(discovery.status, 200);
  const discoveryResult = (await discovery.json()).result;
  assert.equal(discoveryResult.resultType, "complete");
  assert.deepEqual(discoveryResult.supportedVersions, [MCP_TARGET_PROTOCOL]);
  assert.deepEqual(discoveryResult.capabilities, { tools: {}, resources: {} });
  assert.equal(discoveryResult.cacheScope, "private");

  const retired = await responseFrom(runtime, new Request(
    `${ORIGIN}${MCP_RETIRED_SITES_ENDPOINT}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
  ));
  assert.equal(retired.status, 404);
  assert.equal(retired.headers.get("www-authenticate"), null);
  assert.match(retired.headers.get("content-type"), /^application\/problem\+json/u);
  assert.equal((await retired.json()).code, "route_not_found");
  assert.equal(await runtime.fetch(new Request(`${ORIGIN}${MCP_RETIRED_SITES_ENDPOINT}/`)), null);
  assert.equal(await runtime.fetch(new Request(`${ORIGIN}/MCP`)), null);

  const initialize = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: { form: {}, url: {} } },
      clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.147.0" },
    },
  });
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.protocolVersion, MCP_LEGACY_CODEX_PROTOCOL);

  const initialized = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(initialized.status, 202);

  const tools = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: { progressToken: 0 } },
  });
  assert.equal(tools.status, 200);
  assert.equal((await tools.json()).result.tools.some((tool) => tool.name === "list_minds"), true);

  const listed = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      _meta: { progressToken: 1 },
      name: "list_minds",
      arguments: {},
    },
  });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.result.isError, false);
  assert.equal(listedBody.result.structuredContent.ok, true);
  assert.equal(listedBody.result.structuredContent.data.minds.length, 1);
  const personalMind = listedBody.result.structuredContent.data.minds[0];
  assert.equal(personalMind.route, "/me");
  assert.equal(personalMind.discovery, "personal");
  assert.equal(
    typeof personalMind.head.revision_id,
    "string",
    JSON.stringify(personalMind),
  );

  const previousRevisionId = personalMind.head.revision_id;
  const committed = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      _meta: { progressToken: 2 },
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        expected_revision: previousRevisionId,
        idempotency_key: "commit:product-runtime-e2e",
        summary: "Prove production transaction authorization",
        operations: [{
          type: "create_file",
          path: "concepts/runtime-proof.md",
          text: "---\ntype: Reference\n---\n\nRuntime authorization proof.\n",
        }],
      },
    },
  });
  assert.equal(committed.status, 200);
  const committedBody = await committed.json();
  assert.equal(committedBody.result.isError, false, JSON.stringify(committedBody));
  assert.equal(committedBody.result.structuredContent.ok, true);
  assert.equal(committedBody.result.structuredContent.data.kind, "committed");

  const listedAfterCommit = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      _meta: { progressToken: 3 },
      name: "list_minds",
      arguments: {},
    },
  });
  assert.equal(listedAfterCommit.status, 200);
  const listedAfterCommitBody = await listedAfterCommit.json();
  assert.equal(listedAfterCommitBody.result.isError, false);
  const advancedMind = listedAfterCommitBody.result.structuredContent.data.minds[0];
  assert.notEqual(advancedMind.head.revision_id, previousRevisionId);
  assert.equal(
    advancedMind.head.revision_id,
    committedBody.result.structuredContent.data.envelope.revision.revision_id,
  );

  const revoked = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(tokenId)}`,
    {
      method: "DELETE",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "revoke:product-runtime-e2e",
      },
    },
  ));
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).data.token.state, "revoked");

  const afterRevoke = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: { _meta: { progressToken: 4 } },
  });
  assert.equal(afterRevoke.status, 401);
  assert.equal((await afterRevoke.json()).code, "authentication_required");
});
