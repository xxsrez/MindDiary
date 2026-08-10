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
      ...(body.method === "tools/call" && typeof body.params?.name === "string"
        ? { "mcp-name": body.params.name }
        : {}),
    },
    body: JSON.stringify(body),
  }));
}

test("durable product runtime carries a Sites account token through Codex MCP and revokes it", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const runtimeOptions = {
    database,
    bucket,
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
  };
  let runtime = await createProductSiteRuntime(runtimeOptions);

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
  const settingsHtml = await settings.text();
  assert.match(settingsHtml, new RegExp(`${ORIGIN.replaceAll(".", "\\.")}\\/api\\/mcp\\/2025-11-25`, "u"));
  assert.match(settingsHtml, new RegExp(`${ORIGIN.replaceAll(".", "\\.")}\\/api\\/mcp`, "u"));
  assert.match(settingsHtml, /data-run-mcp-self-check disabled/u);
  assert.doesNotMatch(settingsHtml, /&lt;your-mind-diary-site&gt;/u);
  const registeredCsrf = csrfFromHtml(settingsHtml);

  const createdMind = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registeredCsrf,
      "idempotency-key": "mind:product-runtime-e2e",
    },
    body: JSON.stringify({ name: "Runtime Shared", handle: "runtime-shared" }),
  }));
  assert.equal(createdMind.status, 200);
  assert.equal((await createdMind.json()).data.route, "/runtime-shared");

  runtime = await createProductSiteRuntime(runtimeOptions);
  const reconstructedMinds = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds`),
  );
  assert.equal(reconstructedMinds.status, 200);
  assert.deepEqual(
    (await reconstructedMinds.json()).data.map(({ route }) => route),
    ["/me", "/runtime-shared"],
  );
  const reconstructedExact = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/runtime-shared`),
  );
  assert.equal(reconstructedExact.status, 200);
  const reconstructedExactBody = await reconstructedExact.json();
  assert.equal(reconstructedExactBody.data.access.role, "owner");

  const renamedMind = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/runtime-shared`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "rename:product-runtime-e2e",
      },
      body: JSON.stringify({
        name: "Runtime Library",
        expected_metadata_version: reconstructedExactBody.data.metadata_version,
      }),
    },
  ));
  assert.equal(renamedMind.status, 200);
  const renamedMindBody = await renamedMind.json();
  assert.equal(renamedMindBody.data.name, "Runtime Library");
  assert.equal(renamedMindBody.data.route, "/runtime-shared");
  assert.equal(renamedMindBody.data.head_revision_id, reconstructedExactBody.data.head_revision_id);

  runtime = await createProductSiteRuntime(runtimeOptions);
  const renamedAfterRestart = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/runtime-shared`),
  );
  assert.equal(renamedAfterRestart.status, 200);
  const renamedAfterRestartBody = await renamedAfterRestart.json();
  assert.equal(renamedAfterRestartBody.data.name, "Runtime Library");
  assert.equal(renamedAfterRestartBody.data.route, "/runtime-shared");
  assert.equal(renamedAfterRestartBody.data.head_revision_id, reconstructedExactBody.data.head_revision_id);

  const exactManagementPage = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/runtime-shared`),
  );
  assert.equal(exactManagementPage.status, 200);
  const exactManagementHtml = await exactManagementPage.text();
  assert.match(exactManagementHtml, /data-mind-handle="runtime-shared"/u);
  assert.match(exactManagementHtml, /Runtime Library/u);
  assert.doesNotMatch(exactManagementHtml, /Runtime Shared/u);

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
  assert.equal(listedBody.result.structuredContent.data.minds.length, 2);
  const ordinaryMind = listedBody.result.structuredContent.data.minds.find(
    ({ route }) => route === "/runtime-shared",
  );
  assert.ok(ordinaryMind);
  assert.equal(ordinaryMind.name, "Runtime Library");
  const personalMind = listedBody.result.structuredContent.data.minds.find(
    ({ route }) => route === "/me",
  );
  assert.ok(personalMind);
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
  const advancedMind = listedAfterCommitBody.result.structuredContent.data.minds.find(
    ({ route }) => route === "/me",
  );
  assert.ok(advancedMind);
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

  const deletionImpact = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/runtime-shared/deletion-impact`,
  ));
  assert.equal(deletionImpact.status, 200);
  const deletionImpactBody = await deletionImpact.json();
  assert.equal(deletionImpactBody.data.mind.route, "/runtime-shared");
  assert.equal(deletionImpactBody.data.irreversible, true);
  assert.equal(deletionImpactBody.data.recovery_available, false);
  assert.equal(deletionImpactBody.data.forensic_receipt_retained, false);
  assert.equal(deletionImpactBody.data.confirmation, "delete-mind:runtime-shared");

  const deletedMind = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/runtime-shared`,
    {
      method: "DELETE",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "delete:product-runtime-e2e",
      },
      body: JSON.stringify({
        impact_id: deletionImpactBody.data.impact_id,
        confirmation: deletionImpactBody.data.confirmation,
      }),
    },
  ));
  assert.equal(deletedMind.status, 200);
  assert.equal((await deletedMind.json()).data.replayed, false);

  runtime = await createProductSiteRuntime(runtimeOptions);
  const mindsAfterDeletion = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds`),
  );
  assert.equal(mindsAfterDeletion.status, 200);
  assert.deepEqual(
    (await mindsAfterDeletion.json()).data.map(({ route }) => route),
    ["/me"],
  );

  const retiredExact = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/runtime-shared`),
  );
  assert.equal(retiredExact.status, 404);
  const retiredExactBody = await retiredExact.json();
  assert.equal(retiredExactBody.error.code, "mind_not_found");
  assert.equal("name" in retiredExactBody.error, false);

  const retiredManagementPage = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/runtime-shared`),
  );
  assert.equal(retiredManagementPage.status, 200);
  const retiredManagementHtml = await retiredManagementPage.text();
  assert.match(retiredManagementHtml, /Mind settings unavailable/u);
  assert.doesNotMatch(retiredManagementHtml, /Runtime Library|Runtime Shared/u);

  const postDeletionMindsPage = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/minds`),
  );
  assert.equal(postDeletionMindsPage.status, 200);
  const postDeletionCsrf = csrfFromHtml(await postDeletionMindsPage.text());

  const recreateRetiredHandle = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": postDeletionCsrf,
        "idempotency-key": "mind:recreate-retired-runtime-e2e",
      },
      body: JSON.stringify({ name: "Reused Route", handle: "runtime-shared" }),
    },
  ));
  const recreateRetiredHandleBody = await recreateRetiredHandle.json();
  assert.equal(recreateRetiredHandle.status, 409, JSON.stringify(recreateRetiredHandleBody));
  assert.equal(recreateRetiredHandleBody.error.code, "handle_unavailable");

  const beforeProfileRename = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/session`),
  );
  assert.equal(beforeProfileRename.status, 200);
  const beforeProfileRenameBody = await beforeProfileRename.json();
  const stablePersonalMindId = beforeProfileRenameBody.data.personal_mind.mind_id;
  const stablePersonalHead = beforeProfileRenameBody.data.personal_mind.head_revision_id;
  const renamedAccount = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/account`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": postDeletionCsrf,
        "idempotency-key": "profile:product-runtime-account",
      },
      body: JSON.stringify({
        display_name: "Runtime Owner Renamed",
        expected_profile_version: beforeProfileRenameBody.data.principal.profile_version,
      }),
    },
  ));
  assert.equal(renamedAccount.status, 200);
  const renamedAccountBody = await renamedAccount.json();
  assert.equal(renamedAccountBody.data.principal.display_name, "Runtime Owner Renamed");
  assert.equal(renamedAccountBody.data.personal_mind.route, "/me");
  assert.equal(renamedAccountBody.data.personal_mind.mind_id, stablePersonalMindId);
  assert.equal(renamedAccountBody.data.personal_mind.head_revision_id, stablePersonalHead);

  runtime = await createProductSiteRuntime(runtimeOptions);
  const accountPage = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/settings/account`),
  );
  assert.equal(accountPage.status, 200);
  const accountPageHtml = await accountPage.text();
  assert.match(accountPageHtml, /data-mind-diary-account-deletion/u);
  assert.match(accountPageHtml, /Runtime Owner Renamed/u);
  assert.match(accountPageHtml, /data-account-deletion-impact/u);
  assert.match(accountPageHtml, /Type <code>delete-account<\/code> exactly/u);
  assert.match(accountPageHtml, /same trusted channel that admitted you/u);
  assert.doesNotMatch(accountPageHtml, /Runtime\.Owner@Example\.COM|runtime\.owner@example\.com/u);
  const accountCsrf = csrfFromHtml(accountPageHtml);

  const accountImpact = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/account/deletion-impact`),
  );
  assert.equal(accountImpact.status, 200);
  const accountImpactBody = await accountImpact.json();
  assert.equal(accountImpactBody.data.personal_mind.route, "/me");
  assert.equal(accountImpactBody.data.owned_minds.length, 0);
  assert.equal(accountImpactBody.data.active_mcp_token_count, 0);
  assert.equal(accountImpactBody.data.confirmation, "delete-account");

  const deletedAccount = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/account`,
    {
      method: "DELETE",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": accountCsrf,
        "idempotency-key": "account-delete:product-runtime-e2e",
      },
      body: JSON.stringify({
        impact_id: accountImpactBody.data.impact_id,
        confirmation: "delete-account",
      }),
    },
  ));
  assert.equal(deletedAccount.status, 200);
  assert.equal((await deletedAccount.json()).data.replayed, false);

  runtime = await createProductSiteRuntime(runtimeOptions);
  const sessionAfterAccountDeletion = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/session`),
  );
  assert.equal(sessionAfterAccountDeletion.status, 409);
  assert.equal((await sessionAfterAccountDeletion.json()).error.code, "registration_required");
  const pageAfterAccountDeletion = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/settings/account`),
  );
  assert.equal(pageAfterAccountDeletion.status, 200);
  const pageAfterAccountDeletionHtml = await pageAfterAccountDeletion.text();
  assert.match(pageAfterAccountDeletionHtml, /Create a new isolated account/u);
  assert.match(pageAfterAccountDeletionHtml, /same trusted channel that admitted you/u);
  assert.doesNotMatch(pageAfterAccountDeletionHtml, /data-account-deletion-impact|Runtime Owner Renamed/u);
});

test("durable Product Site enforces public baseline access, atomic ownership transfer, and immediate private revoke", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let currentIdentity = {
    verifiedEmail: "visibility.owner@example.com",
    verifiedFullName: "Visibility Owner",
  };
  const runtimeOptions = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return { kind: "authenticated", ...currentIdentity };
      },
    },
    tokenVerifierKey: key(2),
    locatorKey: key(42),
    exportDownloadVerifierKey: key(82),
    csrfKey: key(122),
    schedule() {},
  };
  let runtime = await createProductSiteRuntime(runtimeOptions);

  const switchIdentity = (verifiedEmail, verifiedFullName) => {
    currentIdentity = { verifiedEmail, verifiedFullName };
  };
  const pageCsrf = async (path = "/minds") => {
    const response = await responseFrom(runtime, new Request(`${ORIGIN}${path}`));
    assert.equal(response.status, 200);
    return csrfFromHtml(await response.text());
  };
  const registerCurrent = async () => {
    const csrf = await pageCsrf("/");
    const response = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": `bootstrap:${currentIdentity.verifiedEmail}`,
      },
      body: JSON.stringify({ action: "create_isolated_account" }),
    }));
    assert.equal(response.status, 200, await response.text());
  };

  await registerCurrent();
  const ownerCsrf = await pageCsrf();
  const created = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": ownerCsrf,
      "idempotency-key": "mind:visibility-runtime",
    },
    body: JSON.stringify({ name: "Visibility Runtime", handle: "visibility-runtime" }),
  }));
  assert.equal(created.status, 200);

  const madePublic = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/visibility`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": ownerCsrf,
        "idempotency-key": "visibility:public-runtime",
      },
      body: JSON.stringify({
        visibility: "public",
        acknowledge_live_head_and_history_exposure: true,
        expected_metadata_version: 1,
      }),
    },
  ));
  assert.equal(madePublic.status, 200, await madePublic.text());

  switchIdentity("visibility.target@example.com", "Target Owner");
  await registerCurrent();
  switchIdentity("visibility.outsider@example.com", "Baseline Reader");
  await registerCurrent();

  const outsiderCsrf = await pageCsrf("/settings/mcp");
  const publicCatalog = await responseFrom(runtime, new Request(`${ORIGIN}/public`));
  assert.equal(publicCatalog.status, 200);
  const publicCatalogHtml = await publicCatalog.text();
  assert.match(publicCatalogHtml, /data-public-mind-card/);
  assert.match(publicCatalogHtml, /Visibility Runtime/);
  assert.doesNotMatch(publicCatalogHtml, /private|unlisted Mind metadata is unavailable/iu);

  const baselineExact = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  assert.equal(baselineExact.status, 200);
  const baselineExactBody = await baselineExact.json();
  assert.equal(baselineExactBody.data.access.kind, "visibility");
  assert.equal(baselineExactBody.data.access.role, null);
  const baselinePage = await responseFrom(runtime, new Request(`${ORIGIN}/visibility-runtime`));
  assert.equal(baselinePage.status, 200);
  const baselineHtml = await baselinePage.text();
  assert.match(baselineHtml, /data-visibility-readonly/);
  assert.doesNotMatch(baselineHtml, /data-owner-visibility-controls|data-owner-transfer-controls/);

  switchIdentity("visibility.owner@example.com", "Visibility Owner");
  const unlistedOwnerCsrf = await pageCsrf();
  const publicOwnerMind = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  const publicOwnerMindBody = await publicOwnerMind.json();
  const madeUnlisted = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/visibility`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": unlistedOwnerCsrf,
        "idempotency-key": "visibility:unlisted-runtime",
      },
      body: JSON.stringify({
        visibility: "unlisted",
        acknowledge_live_head_and_history_exposure: false,
        expected_metadata_version: publicOwnerMindBody.data.metadata_version,
      }),
    },
  ));
  assert.equal(madeUnlisted.status, 200, await madeUnlisted.text());

  switchIdentity("visibility.outsider@example.com", "Baseline Reader");
  const unlistedCatalog = await responseFrom(runtime, new Request(`${ORIGIN}/public`));
  assert.doesNotMatch(await unlistedCatalog.text(), /Visibility Runtime/);
  const unlistedExact = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  assert.equal(unlistedExact.status, 200);
  const unlistedExactBody = await unlistedExact.json();
  assert.equal(unlistedExactBody.data.visibility, "unlisted");
  assert.equal(unlistedExactBody.data.discovery, "exact_handle");

  switchIdentity("visibility.owner@example.com", "Visibility Owner");
  const republishCsrf = await pageCsrf();
  const republished = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/visibility`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": republishCsrf,
        "idempotency-key": "visibility:republish-runtime",
      },
      body: JSON.stringify({
        visibility: "public",
        acknowledge_live_head_and_history_exposure: false,
        expected_metadata_version: unlistedExactBody.data.metadata_version,
      }),
    },
  ));
  assert.equal(republished.status, 200, await republished.text());
  switchIdentity("visibility.outsider@example.com", "Baseline Reader");

  const tokenIssued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": outsiderCsrf,
      "idempotency-key": "token:visibility-outsider",
    },
    body: JSON.stringify({
      name: "Visibility outsider",
      scopes: ["content:read"],
      expires_at: "2026-09-01T00:00:00.000Z",
    }),
  }));
  assert.equal(tokenIssued.status, 200);
  const outsiderSecret = (await tokenIssued.json()).data.secret;
  const mcpBeforePrivate = await modernMcp(runtime, outsiderSecret, {
    jsonrpc: "2.0",
    id: 71,
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "visibility-runtime-e2e", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
      name: "list_minds",
      arguments: {},
    },
  });
  assert.equal(mcpBeforePrivate.status, 200, await mcpBeforePrivate.clone().text());
  const mcpBeforePrivateBody = await mcpBeforePrivate.json();
  assert.equal(
    mcpBeforePrivateBody.result.structuredContent.data.minds.some(({ route }) => route === "/visibility-runtime"),
    true,
  );

  switchIdentity("visibility.owner@example.com", "Visibility Owner");
  const ownerControlCsrf = await pageCsrf();
  const currentOwnerMind = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  const currentOwnerMindBody = await currentOwnerMind.json();
  const invitation = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime/invitations`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": ownerControlCsrf,
      "idempotency-key": "invite:visibility-target",
    },
    body: JSON.stringify({
      target_verified_email: "visibility.target@example.com",
      role: "editor",
      expected_metadata_version: currentOwnerMindBody.data.metadata_version,
    }),
  }));
  assert.equal(invitation.status, 200, await invitation.text());

  switchIdentity("visibility.target@example.com", "Target Owner");
  const targetCsrf = await pageCsrf("/invitations");
  const incoming = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/invitations`));
  assert.equal(incoming.status, 200);
  const incomingBody = await incoming.json();
  const incomingInvitation = incomingBody.data.invitations.find(({ direction }) => direction === "incoming");
  assert.ok(incomingInvitation);
  const accepted = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/invitations/${encodeURIComponent(incomingInvitation.invitation_id)}/accept`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": targetCsrf,
        "idempotency-key": "accept:visibility-target",
      },
      body: JSON.stringify({ expected_invitation_version: incomingInvitation.invitation_version }),
    },
  ));
  assert.equal(accepted.status, 200, await accepted.text());

  switchIdentity("visibility.owner@example.com", "Visibility Owner");
  const transferCsrf = await pageCsrf();
  const beforeTransfer = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  const beforeTransferBody = await beforeTransfer.json();
  const members = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime/members`));
  assert.equal(members.status, 200);
  const membersBody = await members.json();
  const targetMember = membersBody.data.members.find(({ display_name }) => display_name === "Target Owner");
  assert.ok(targetMember);
  const transferred = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/ownership-transfer`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": transferCsrf,
        "idempotency-key": "ownership:visibility-target",
      },
      body: JSON.stringify({
        target_member_id: targetMember.member_id,
        expected_metadata_version: beforeTransferBody.data.metadata_version,
        confirmation: "transfer-ownership",
      }),
    },
  ));
  assert.equal(transferred.status, 200, await transferred.clone().text());
  const transferredBody = await transferred.json();
  assert.equal(transferredBody.data.source_role, "admin");
  assert.equal(transferredBody.data.target_role, "owner");

  const sourceAfterTransfer = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  assert.equal((await sourceAfterTransfer.json()).data.access.role, "admin");
  switchIdentity("visibility.target@example.com", "Target Owner");
  const targetOwnerCsrf = await pageCsrf();
  const targetAfterTransfer = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  const targetAfterTransferBody = await targetAfterTransfer.json();
  assert.equal(targetAfterTransferBody.data.access.role, "owner");

  const madePrivate = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/visibility`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": targetOwnerCsrf,
        "idempotency-key": "visibility:private-runtime",
      },
      body: JSON.stringify({
        visibility: "private",
        acknowledge_live_head_and_history_exposure: false,
        expected_metadata_version: targetAfterTransferBody.data.metadata_version,
      }),
    },
  ));
  assert.equal(madePrivate.status, 200, await madePrivate.text());

  runtime = await createProductSiteRuntime(runtimeOptions);
  switchIdentity("visibility.outsider@example.com", "Baseline Reader");
  const privateExact = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  assert.equal(privateExact.status, 404);
  assert.equal((await privateExact.json()).error.code, "mind_not_found");
  const privateCatalog = await responseFrom(runtime, new Request(`${ORIGIN}/public`));
  const privateCatalogHtml = await privateCatalog.text();
  assert.doesNotMatch(privateCatalogHtml, /Visibility Runtime/);
  const mcpAfterPrivate = await modernMcp(runtime, outsiderSecret, {
    jsonrpc: "2.0",
    id: 72,
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "visibility-runtime-e2e", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
      name: "list_minds",
      arguments: {},
    },
  });
  assert.equal(mcpAfterPrivate.status, 200, await mcpAfterPrivate.clone().text());
  const mcpAfterPrivateBody = await mcpAfterPrivate.json();
  assert.equal(
    mcpAfterPrivateBody.result.structuredContent.data.minds.some(({ route }) => route === "/visibility-runtime"),
    false,
  );

  switchIdentity("visibility.target@example.com", "Target Owner");
  const durableOwner = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  assert.equal(durableOwner.status, 200);
  const durableOwnerBody = await durableOwner.json();
  assert.equal(durableOwnerBody.data.access.role, "owner");
  assert.equal(durableOwnerBody.data.visibility, "private");
});

test("durable collaboration accepts exactly once, rejects stale role state, and revokes Web and MCP access immediately", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let currentIdentity = {
    verifiedEmail: "collaboration.owner@example.com",
    verifiedFullName: "Collaboration Owner",
  };
  const runtimeOptions = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return { kind: "authenticated", ...currentIdentity };
      },
    },
    tokenVerifierKey: key(3),
    locatorKey: key(43),
    exportDownloadVerifierKey: key(83),
    csrfKey: key(123),
    schedule() {},
  };
  let runtime = await createProductSiteRuntime(runtimeOptions);
  const switchIdentity = (verifiedEmail, verifiedFullName) => {
    currentIdentity = { verifiedEmail, verifiedFullName };
  };
  const csrf = async (path = "/minds") => {
    const response = await responseFrom(runtime, new Request(`${ORIGIN}${path}`));
    assert.equal(response.status, 200, path);
    return csrfFromHtml(await response.text());
  };
  const mutation = async (path, method, token, idempotencyKey, body) =>
    responseFrom(runtime, new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": token,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }));
  const registerCurrent = async () => {
    const token = await csrf("/");
    const response = await mutation(
      "/api/v1/account",
      "POST",
      token,
      `bootstrap:${currentIdentity.verifiedEmail}`,
      { action: "create_isolated_account" },
    );
    assert.equal(response.status, 200, await response.text());
  };

  await registerCurrent();
  const ownerCsrf = await csrf();
  const created = await mutation(
    "/api/v1/minds",
    "POST",
    ownerCsrf,
    "mind:collaboration-runtime",
    { name: "Collaboration Runtime", handle: "collaboration-runtime" },
  );
  assert.equal(created.status, 200, await created.text());

  switchIdentity("collaboration.member@example.com", "Collaboration Member");
  await registerCurrent();
  switchIdentity("collaboration.owner@example.com", "Collaboration Owner");

  const ownerMind = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/collaboration-runtime`),
  );
  assert.equal(ownerMind.status, 200);
  const ownerMindBody = await ownerMind.json();
  const freshOwnerCsrf = await csrf("/collaboration-runtime");

  const unknown = await mutation(
    "/api/v1/minds/collaboration-runtime/invitations",
    "POST",
    freshOwnerCsrf,
    "invite:collaboration-unknown",
    {
      target_verified_email: "unknown.collaboration@example.com",
      role: "reader",
      expected_metadata_version: ownerMindBody.data.metadata_version,
    },
  );
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error.code, "registered_principal_not_found");
  assert.equal(JSON.stringify(unknownBody).includes("collaboration.member@example.com"), false);

  const inviteBody = {
    target_verified_email: "collaboration.member@example.com",
    role: "editor",
    expected_metadata_version: ownerMindBody.data.metadata_version,
  };
  const invited = await mutation(
    "/api/v1/minds/collaboration-runtime/invitations",
    "POST",
    freshOwnerCsrf,
    "invite:collaboration-member",
    inviteBody,
  );
  assert.equal(invited.status, 200, await invited.clone().text());
  const invitedBody = await invited.json();
  assert.equal(invitedBody.data.replayed, false);
  const replayedInvite = await mutation(
    "/api/v1/minds/collaboration-runtime/invitations",
    "POST",
    freshOwnerCsrf,
    "invite:collaboration-member",
    inviteBody,
  );
  assert.equal(replayedInvite.status, 200, await replayedInvite.clone().text());
  assert.equal((await replayedInvite.json()).data.replayed, true);

  switchIdentity("collaboration.member@example.com", "Collaboration Member");
  const pendingExact = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/collaboration-runtime`),
  );
  assert.equal(pendingExact.status, 404);
  const invitationPage = await responseFrom(runtime, new Request(`${ORIGIN}/invitations`));
  assert.equal(invitationPage.status, 200);
  const invitationPageHtml = await invitationPage.text();
  assert.match(invitationPageHtml, /Collaboration Runtime/);
  assert.match(invitationPageHtml, /data-invitation-action="accept"/);
  assert.doesNotMatch(invitationPageHtml, /collaboration\.owner@example\.com/);

  const memberCsrf = csrfFromHtml(invitationPageHtml);
  const incoming = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/invitations`));
  assert.equal(incoming.status, 200);
  const incomingBody = await incoming.json();
  const pendingInvitation = incomingBody.data.invitations.find(
    ({ direction, mind_name: mindName }) => direction === "incoming" && mindName === "Collaboration Runtime",
  );
  assert.ok(pendingInvitation);
  const acceptBody = {
    expected_invitation_version: pendingInvitation.invitation_version,
  };
  const accepted = await mutation(
    `/api/v1/invitations/${encodeURIComponent(pendingInvitation.invitation_id)}/accept`,
    "POST",
    memberCsrf,
    "accept:collaboration-member",
    acceptBody,
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await accepted.json()).data.replayed, false);
  const replayedAccept = await mutation(
    `/api/v1/invitations/${encodeURIComponent(pendingInvitation.invitation_id)}/accept`,
    "POST",
    memberCsrf,
    "accept:collaboration-member",
    acceptBody,
  );
  assert.equal(replayedAccept.status, 200, await replayedAccept.clone().text());
  assert.equal((await replayedAccept.json()).data.replayed, true);

  const acceptedExact = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/collaboration-runtime`),
  );
  assert.equal(acceptedExact.status, 200);
  assert.equal((await acceptedExact.json()).data.access.role, "editor");
  const memberSettingsCsrf = await csrf("/settings/mcp");
  const issued = await mutation(
    "/api/v1/mcp-tokens",
    "POST",
    memberSettingsCsrf,
    "token:collaboration-member",
    { name: "Collaboration member access", scopes: ["content:read"] },
  );
  assert.equal(issued.status, 200, await issued.clone().text());
  const memberSecret = (await issued.json()).data.secret;
  const mcpBeforeRevoke = await modernMcp(runtime, memberSecret, {
    jsonrpc: "2.0",
    id: 81,
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "collaboration-runtime-e2e", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
      name: "list_minds",
      arguments: {},
    },
  });
  assert.equal(mcpBeforeRevoke.status, 200, await mcpBeforeRevoke.clone().text());
  assert.equal(
    (await mcpBeforeRevoke.json()).result.structuredContent.data.minds
      .some(({ route }) => route === "/collaboration-runtime"),
    true,
  );

  switchIdentity("collaboration.owner@example.com", "Collaboration Owner");
  const ownerMembersCsrf = await csrf("/collaboration-runtime");
  const members = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/collaboration-runtime/members`),
  );
  assert.equal(members.status, 200);
  const membersBody = await members.json();
  const targetMembers = membersBody.data.members.filter(
    ({ display_name: displayName }) => displayName === "Collaboration Member",
  );
  assert.equal(targetMembers.length, 1);
  const targetMember = targetMembers[0];
  const roleChanged = await mutation(
    `/api/v1/minds/collaboration-runtime/members/${encodeURIComponent(targetMember.member_id)}`,
    "PATCH",
    ownerMembersCsrf,
    "role:collaboration-member-reader",
    { role: "reader", expected_membership_version: targetMember.membership_version },
  );
  assert.equal(roleChanged.status, 200, await roleChanged.clone().text());
  const roleChangedBody = await roleChanged.json();
  assert.equal(roleChangedBody.data.role, "reader");

  const staleRole = await mutation(
    `/api/v1/minds/collaboration-runtime/members/${encodeURIComponent(targetMember.member_id)}`,
    "PATCH",
    ownerMembersCsrf,
    "role:collaboration-member-stale",
    { role: "editor", expected_membership_version: targetMember.membership_version },
  );
  assert.equal(staleRole.status, 409);
  assert.equal((await staleRole.json()).error.code, "membership_version_conflict");

  runtime = await createProductSiteRuntime(runtimeOptions);
  const durableMembers = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/collaboration-runtime/members`),
  );
  assert.equal(durableMembers.status, 200);
  const durableTarget = (await durableMembers.json()).data.members.find(
    ({ display_name: displayName }) => displayName === "Collaboration Member",
  );
  assert.ok(durableTarget);
  assert.equal(durableTarget.role, "reader");
  const durableOwnerCsrf = await csrf("/collaboration-runtime");
  const revoked = await mutation(
    `/api/v1/minds/collaboration-runtime/members/${encodeURIComponent(durableTarget.member_id)}`,
    "DELETE",
    durableOwnerCsrf,
    "revoke:collaboration-member",
    { expected_membership_version: durableTarget.membership_version },
  );
  assert.equal(revoked.status, 200, await revoked.text());

  switchIdentity("collaboration.member@example.com", "Collaboration Member");
  const revokedExact = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/collaboration-runtime`),
  );
  assert.equal(revokedExact.status, 404);
  const revokedPage = await responseFrom(runtime, new Request(`${ORIGIN}/collaboration-runtime`));
  assert.equal(revokedPage.status, 200);
  assert.match(await revokedPage.text(), /Mind settings unavailable/);
  const mcpAfterRevoke = await modernMcp(runtime, memberSecret, {
    jsonrpc: "2.0",
    id: 82,
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "collaboration-runtime-e2e", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
      name: "list_minds",
      arguments: {},
    },
  });
  assert.equal(mcpAfterRevoke.status, 200, await mcpAfterRevoke.clone().text());
  assert.equal(
    (await mcpAfterRevoke.json()).result.structuredContent.data.minds
      .some(({ route }) => route === "/collaboration-runtime"),
    false,
  );
});
