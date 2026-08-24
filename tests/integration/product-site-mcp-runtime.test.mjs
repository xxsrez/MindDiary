import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  MCP_ENDPOINT,
  MCP_LEGACY_CODEX_ENDPOINT,
  MCP_LEGACY_CODEX_PROTOCOL,
  MCP_RETIRED_SITES_ENDPOINT,
  MCP_TARGET_PROTOCOL,
} from "../../packages/adapter-mcp/dist/index.js";
import { MIND_DIARY_STARTER_OKF_TEMPLATE } from "../../packages/adapter-web/dist/index.js";
import { createProductSiteRuntime } from "../../packages/composition-root/dist/index.js";
import {
  createMindDiaryProductWorker,
  RequestRecoveryCoordinator,
} from "../../apps/mind-diary-site/worker/request-recovery.js";

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
  metadataSnapshot = null;
  metadataSnapshotHead = null;
  metadataSnapshotChunks = new Map();
  search = new Map();
  searchDocuments = new Map();
  searchMemberships = new Map();
  searchLexical = new Map();
  audit = new Map();
  locatorHandles = new Map();

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
    if (sql.includes("/*md-oauth-principal-")) {
      return { success: true, meta: { changes: 0 } };
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
    if (sql.includes("/*md-metadata-snapshot-write*/")) {
      const sequence = Number(values[0]);
      if (this.metadataSnapshotHead !== null && this.metadataSnapshotHead.sequence >= sequence) {
        return { success: true, meta: { changes: 0 } };
      }
      this.metadataSnapshotHead = {
        sequence,
        chunk_count: Number(values[1]),
        payload_chars: Number(values[2]),
      };
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-snapshot-chunk-write*/")) {
      this.metadataSnapshotChunks.set(`${values[0]}:${values[1]}`, {
        sequence: Number(values[0]),
        chunk_index: Number(values[1]),
        payload_json: values[2],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-snapshot-cleanup*/")) {
      const headSequence = this.metadataSnapshotHead?.sequence ?? 0;
      let changes = 0;
      for (const [key, row] of this.metadataSnapshotChunks) {
        if (row.sequence >= headSequence) continue;
        this.metadataSnapshotChunks.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-locator-create*/")) {
      this.locatorHandles.set(values[0], {
        encrypted_payload: values[1],
        expires_at: values[2],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-locator-cleanup*/")) {
      const expired = [...this.locatorHandles.entries()]
        .filter(([, row]) => row.expires_at <= values[0])
        .slice(0, 64);
      for (const [key] of expired) this.locatorHandles.delete(key);
      return { success: true, meta: { changes: expired.length } };
    }
    if (sql.includes("/*md-locator-delete*/")) {
      return { success: true, meta: { changes: this.locatorHandles.delete(values[0]) ? 1 : 0 } };
    }
    if (sql.includes("/*md-search-membership-delete*/")) {
      let changes = 0;
      for (const [key, row] of this.searchMemberships) {
        if (row.space_id !== values[0] || row.revision_id !== values[1]) continue;
        this.searchMemberships.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-document-upsert*/")) {
      let changes = 0;
      for (let index = 0; index < values.length; index += 4) {
        const key = `${values[index]}\u0000${values[index + 1]}`;
        if (this.searchDocuments.has(key)) continue;
        this.searchDocuments.set(key, {
          space_id: values[index], digest: values[index + 1], text: values[index + 2], byte_size: Number(values[index + 3]),
        });
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-lexical-upsert*/")) {
      let changes = 0;
      for (let index = 0; index < values.length; index += 4) {
        const key = `${values[index]}\u0000${values[index + 1]}`;
        if (this.searchLexical.has(key)) continue;
        this.searchLexical.set(key, {
          space_id: values[index], digest: values[index + 1], normalized_text: values[index + 2], byte_size: Number(values[index + 3]),
        });
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-membership-insert*/")) {
      for (let index = 0; index < values.length; index += 5) {
        const row = {
          space_id: values[index], revision_id: values[index + 1], ordinal: Number(values[index + 2]),
          path: values[index + 3], digest: values[index + 4],
        };
        this.searchMemberships.set(`${row.space_id}\u0000${row.revision_id}\u0000${row.path}`, row);
      }
      return { success: true, meta: { changes: values.length / 5 } };
    }
    if (sql.includes("/*md-search-legacy-delete*/")) {
      return { success: true, meta: { changes: this.search.delete(`${values[0]}\u0000${values[1]}`) ? 1 : 0 } };
    }
    if (sql.includes("/*md-search-orphan-document-cleanup*/")) {
      let changes = 0;
      const used = new Set([...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0])
        .map((row) => row.digest));
      for (const [key, row] of this.searchDocuments) {
        if (row.space_id !== values[0] || used.has(row.digest)) continue;
        this.searchDocuments.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-orphan-lexical-cleanup*/")) {
      let changes = 0;
      const used = new Set([...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0])
        .map((row) => row.digest));
      for (const [key, row] of this.searchLexical) {
        if (row.space_id !== values[0] || used.has(row.digest)) continue;
        this.searchLexical.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-purge-memberships*/")) {
      let changes = 0;
      for (const [key, row] of this.searchMemberships) {
        if (row.space_id !== values[0]) continue;
        this.searchMemberships.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-purge-documents*/")) {
      let changes = 0;
      for (const [key, row] of this.searchDocuments) {
        if (row.space_id !== values[0]) continue;
        this.searchDocuments.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-purge-lexical*/")) {
      let changes = 0;
      for (const [key, row] of this.searchLexical) {
        if (row.space_id !== values[0]) continue;
        this.searchLexical.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-purge-legacy*/")) {
      let changes = 0;
      for (const key of [...this.search.keys()]) {
        if (!key.startsWith(`${values[0]}\u0000`)) continue;
        this.search.delete(key);
        changes += 1;
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
    if (sql.includes("/*md-metadata-snapshot-head-read*/")) {
      return {
        success: true,
        results: this.metadataSnapshotHead === null
          ? []
          : [{ ...this.metadataSnapshotHead }],
      };
    }
    if (sql.includes("/*md-metadata-snapshot-chunks-read*/")) {
      return {
        success: true,
        results: [...this.metadataSnapshotChunks.values()]
          .filter((row) =>
            row.sequence === Number(values[0]) &&
            row.chunk_index >= Number(values[1]))
          .sort((left, right) => left.chunk_index - right.chunk_index)
          .slice(0, Number(values[2]))
          .map((row) => ({
            chunk_index: row.chunk_index,
            payload_json: row.payload_json,
          })),
      };
    }
    if (sql.includes("/*md-metadata-snapshot-read*/")) {
      return {
        success: true,
        results: this.metadataSnapshot === null ? [] : [{ ...this.metadataSnapshot }],
      };
    }
    if (sql.includes("/*md-metadata-events-tail*/")) {
      return {
        success: true,
        results: this.metadataEvents
          .filter((row) => row.sequence > Number(values[0]))
          .map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-metadata-events-migration*/")) {
      return {
        success: true,
        results: this.metadataEvents.map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-locator-read*/")) {
      const row = this.locatorHandles.get(values[0]);
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-search-read-normalized*/")) {
      const results = [...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0] && row.revision_id === values[1])
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((row) => ({
          path: row.path,
          text: this.searchDocuments.get(`${row.space_id}\u0000${row.digest}`)?.text,
        }));
      return { success: true, results };
    }
    if (sql.includes("/*md-search-read-legacy*/")) {
      const documents_json = this.search.get(`${values[0]}\u0000${values[1]}`);
      return {
        success: true,
        results: documents_json === undefined ? [] : [{ documents_json }],
      };
    }
    if (sql.includes("/*md-search-projection-count*/")) {
      const memberships = [...this.searchMemberships.values()].filter(
        (row) => row.space_id === values[0] && row.revision_id === values[1],
      );
      const indexed = memberships.filter((row) =>
        this.searchDocuments.has(`${row.space_id}\u0000${row.digest}`) &&
        this.searchLexical.has(`${row.space_id}\u0000${row.digest}`));
      return { success: true, results: [{
        membership_count: memberships.length,
        indexed_count: indexed.length,
      }] };
    }
    if (sql.includes("/*md-search-query-normalized*/")) {
      const terms = values.slice(2).map(String);
      const results = [...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0] && row.revision_id === values[1])
        .filter((row) => {
          const text = this.searchLexical.get(`${row.space_id}\u0000${row.digest}`)?.normalized_text;
          return typeof text === "string" && terms.every((term) => text.includes(term));
        })
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((row) => ({
          path: row.path,
          text: this.searchDocuments.get(`${row.space_id}\u0000${row.digest}`)?.text,
        }));
      return { success: true, results };
    }
    if (sql.includes("/*md-search-count-revisions*/")) {
      const revisions = new Set([...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0])
        .map((row) => row.revision_id));
      return { success: true, results: [{ revision_count: revisions.size }] };
    }
    if (sql.includes("/*md-search-storage-metrics*/")) {
      const documents = [...this.searchDocuments.values()].filter((row) => row.space_id === values[0]);
      const memberships = [...this.searchMemberships.values()].filter((row) => row.space_id === values[0]);
      const lexical = [...this.searchLexical.values()].filter((row) => row.space_id === values[0]);
      return { success: true, results: [{
        document_count: documents.length,
        document_bytes: documents.reduce((total, row) => total + row.byte_size, 0),
        lexical_bytes: lexical.reduce((total, row) => total + row.byte_size, 0),
        membership_count: memberships.length,
      }] };
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

const PERFORMANCE_CORRELATION_KEY = key(201);

function performanceCorrelationSignature(id) {
  const hmac = createHmac("sha256", PERFORMANCE_CORRELATION_KEY);
  hmac.update("mind-diary/performance-correlation/v1\0", "utf8");
  hmac.update(id, "utf8");
  return `hmac-sha256:${hmac.digest("hex")}`;
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

async function modernMcp(runtime, secret, body, benchmarkCorrelationId) {
  return responseFrom(runtime, new Request(`${ORIGIN}${MCP_ENDPOINT}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": body.method,
      "mcp-protocol-version": MCP_TARGET_PROTOCOL,
      ...(benchmarkCorrelationId === undefined
        ? {}
        : {
            "x-mind-diary-performance-correlation-id": benchmarkCorrelationId,
            "x-mind-diary-performance-correlation-signature":
              performanceCorrelationSignature(benchmarkCorrelationId),
          }),
      ...(body.method === "tools/call" && typeof body.params?.name === "string"
        ? { "mcp-name": body.params.name }
        : {}),
    },
    body: JSON.stringify(body),
  }));
}

async function modernTool(runtime, secret, id, name, args, benchmarkCorrelationId) {
  const response = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-starter-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }, benchmarkCorrelationId);
  assert.equal(response.status, 200, name);
  assert.match(response.headers.get("x-mind-diary-request-id") ?? "", /^request_/u);
  if (benchmarkCorrelationId !== undefined) {
    assert.equal(
      response.headers.get("x-mind-diary-performance-correlation-id"),
      benchmarkCorrelationId,
    );
  }
  const body = await response.json();
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  assert.equal(body.result?.structuredContent?.ok, true, name);
  return body.result.structuredContent.data;
}

test("Product Site persists success-only web/MCP activity and hides the UAT directory from non-operators", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const scheduled = [];
  let currentTime = new Date("2026-08-22T10:00:00.000Z");
  let currentIdentity = {
    verifiedEmail: "operator.activity@example.com",
    verifiedFullName: "Activity Operator",
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
    tokenVerifierKey: key(23),
    locatorKey: key(63),
    exportDownloadVerifierKey: key(103),
    csrfKey: key(143),
    now: () => currentTime,
    observabilityWriter: { write() {} },
    schedule(work) { scheduled.push(work); },
  };
  let runtime = await createProductSiteRuntime(runtimeOptions);

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrap = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:operator-activity",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrap.status, 200);
  const operatorPrincipalId = (await bootstrap.json()).data.principal_id;

  currentTime = new Date("2026-08-22T10:10:00.000Z");
  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const csrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:operator-activity",
    },
    body: JSON.stringify({ name: "Activity token", scopes: ["content:read"] }),
  }));
  const secret = (await issued.json()).data.secret;

  currentTime = new Date("2026-08-22T10:20:00.000Z");
  const listed = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "activity-tools-list",
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-activity-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(listed.status, 200);

  runtime = await createProductSiteRuntime({
    ...runtimeOptions,
    serviceOperatorPrincipalIds: [operatorPrincipalId],
  });
  const directory = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/internal/operators/users`,
  ));
  assert.equal(directory.status, 200);
  const operatorRow = (await directory.json()).data.principals.find(
    ({ principal_id }) => principal_id === operatorPrincipalId,
  );
  assert.equal(operatorRow.verified_email, "operator.activity@example.com");
  assert.equal(operatorRow.activity.last_web_seen_at, "2026-08-22T10:10:00.000Z");
  assert.equal(operatorRow.activity.last_mcp_seen_at, "2026-08-22T10:20:00.000Z");

  currentTime = new Date("2026-08-22T10:30:00.000Z");
  const deniedMcp = await modernMcp(runtime, "mdp_v1_invalid", {
    jsonrpc: "2.0",
    id: "activity-denied",
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-activity-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(deniedMcp.status, 401);
  const afterDenied = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/internal/operators/users`,
  ));
  const afterDeniedRow = (await afterDenied.json()).data.principals.find(
    ({ principal_id }) => principal_id === operatorPrincipalId,
  );
  assert.equal(afterDeniedRow.activity.last_mcp_seen_at, "2026-08-22T10:20:00.000Z");

  currentIdentity = {
    verifiedEmail: "never.active@example.com",
    verifiedFullName: "Never Active",
  };
  const secondRegistration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const secondCsrf = csrfFromHtml(await secondRegistration.text());
  const secondBootstrap = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": secondCsrf,
      "idempotency-key": "bootstrap:never-active",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(secondBootstrap.status, 200);
  const secondPrincipalId = (await secondBootstrap.json()).data.principal_id;
  assert.equal(
    (await responseFrom(runtime, new Request(`${ORIGIN}/internal/operators/users`))).status,
    404,
  );

  currentIdentity = {
    verifiedEmail: "operator.activity@example.com",
    verifiedFullName: "Activity Operator",
  };
  const never = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/internal/operators/users?never_active=true`,
  ));
  assert.equal(never.status, 200);
  const neverRows = (await never.json()).data.principals;
  assert.deepEqual(neverRows.map(({ principal_id }) => principal_id), [secondPrincipalId]);
  assert.equal(neverRows[0].activity, null);
  assert.ok(scheduled.some(({ kind }) => kind === "audit_outbox"));
});

test("empty account reaches a strict starter commit and first useful search/fetch with safe timing", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const scheduled = [];
  const telemetryLines = [];
  const runtime = await createProductSiteRuntime({
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "starter.e2e@example.com",
          verifiedFullName: "Starter E2E",
        };
      },
    },
    tokenVerifierKey: key(11),
    locatorKey: key(51),
    exportDownloadVerifierKey: key(91),
    csrfKey: key(131),
    performanceCorrelationKey: PERFORMANCE_CORRELATION_KEY,
    observabilityWriter: { write(line) { telemetryLines.push(line); } },
    schedule(work) { scheduled.push(work); },
  });

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`, {
    headers: {
      "x-mind-diary-performance-correlation-id": "benchmark_starter_home",
      "x-mind-diary-performance-correlation-signature":
        performanceCorrelationSignature("benchmark_starter_home"),
    },
  }));
  assert.equal(registration.status, 200);
  assert.equal(
    registration.headers.get("x-mind-diary-performance-correlation-id"),
    "benchmark_starter_home",
  );
  assert.match(registration.headers.get("x-mind-diary-request-id") ?? "", /^request_/u);
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrapped = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:starter-e2e",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrapped.status, 200);

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  assert.equal(settings.status, 200);
  const settingsCsrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": settingsCsrf,
      "idempotency-key": "token:starter-e2e",
    },
    body: JSON.stringify({
      name: "Starter E2E",
      scopes: ["content:write"],
    }),
  }));
  assert.equal(issued.status, 200);
  const secret = (await issued.json()).data.secret;

  const minds = await modernTool(
    runtime,
    secret,
    "starter-list",
    "list_minds",
    {},
    "benchmark_starter_list",
  );
  const personal = minds.minds.find(({ route }) => route === "/me");
  assert.ok(personal);
  const unboundRead = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-unbound-read",
    method: "tools/call",
    params: {
      name: "browse_entries",
      arguments: { mind: "/me" },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-starter-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(unboundRead.status, 200);
  const unboundReadBody = await unboundRead.json();
  assert.equal(unboundReadBody.result.isError, true);
  assert.equal(
    unboundReadBody.result.structuredContent.error.code,
    "mind_binding_required",
  );
  const unboundCommit = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-unbound-commit",
    method: "tools/call",
    params: {
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        write_binding_id: "write_binding_not_active",
        expected_revision: personal.head.revision_id,
        idempotency_key: "commit:starter-unbound",
        summary: "Must not commit without a binding",
        operations: [{
          type: "create_file",
          path: "concepts/must-not-exist.md",
          text: "---\ntype: Reference\n---\n\nMust not exist.\n",
        }],
      },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-starter-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(unboundCommit.status, 200);
  const unboundCommitBody = await unboundCommit.json();
  assert.equal(unboundCommitBody.result.isError, true);
  assert.equal(
    unboundCommitBody.result.structuredContent.error.code,
    "write_binding_required",
  );
  const unboundExport = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-unbound-export",
    method: "tools/call",
    params: {
      name: "start_export",
      arguments: {
        mind: "/me",
        revision_selector: {
          kind: "revision",
          revision_id: personal.head.revision_id,
        },
        idempotency_key: "export:starter-unbound",
      },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-starter-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(unboundExport.status, 200);
  const unboundExportBody = await unboundExport.json();
  assert.equal(unboundExportBody.result.isError, true);
  assert.equal(
    unboundExportBody.result.structuredContent.error.code,
    "mind_binding_required",
  );
  const writeBinding = await modernTool(
    runtime,
    secret,
    "starter-bind-write",
    "set_write_mind_binding",
    {
      action: "bind",
      mind: "/me",
      expected_binding_version: 0,
      idempotency_key: "binding:starter-e2e",
    },
  );
  const writeBindingId = writeBinding.current.write_binding_id;
  const initialRevisionId = personal.head.revision_id;
  const initialBrowse = await modernTool(
    runtime,
    secret,
    "starter-browse-initial",
    "browse_entries",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: initialRevisionId } },
  );
  const initialIndexDigest = initialBrowse.entries.find(({ path }) => path === "index.md")?.sha256;
  assert.match(initialIndexDigest, /^sha256:[0-9a-f]{64}$/u);
  const operations = MIND_DIARY_STARTER_OKF_TEMPLATE.map((file) => {
    if (file.path === "index.md") {
      return {
        type: "replace_index",
        path: file.path,
        text: file.text,
        expected_sha256: initialIndexDigest,
      };
    }
    if (file.path === "log.md") {
      return {
        type: "add_log_entry",
        path: file.path,
        category: "Create",
        message: "Added [First useful Memory](concepts/first-memory.md).",
      };
    }
    return { type: "create_file", path: file.path, text: file.text };
  });
  const committed = await modernTool(
    runtime,
    secret,
    "starter-commit",
    "commit_changeset",
    {
      mind: "/me",
      write_binding_id: writeBindingId,
      expected_revision: initialRevisionId,
      idempotency_key: "commit:starter-e2e",
      summary: "Create strict starter Mind",
      operations,
    },
  );
  assert.equal(committed.previous_revision_id, initialRevisionId);
  const starterRevisionId = committed.revision.revision_id;
  const indexWork = scheduled.findLast((work) => work.kind === "revision_index");
  assert.ok(indexWork);
  const queuedInfo = await modernTool(
    runtime,
    secret,
    "starter-index-queued",
    "get_mind_info",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: starterRevisionId } },
  );
  assert.equal(queuedInfo.index_status.status, "queued");
  assert.equal(queuedInfo.index_status.retryable, true);
  const recovery = await runtime.recoverBackground();
  assert.ok(recovery.dispatched >= 2);
  const readyInfo = await modernTool(
    runtime,
    secret,
    "starter-index-ready",
    "get_mind_info",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: starterRevisionId } },
  );
  assert.equal(readyInfo.index_status.status, "ready");
  assert.equal(readyInfo.index_status.retryable, false);

  for (const [id, digest, expectedStatus, expectedCode] of [
    ["starter-index-stale-digest", initialIndexDigest, 200, "file_digest_mismatch"],
    ["starter-index-malformed-digest", "sha256:not-a-digest", 200, "invalid_operation"],
  ]) {
    const rejected = await modernMcp(runtime, secret, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "commit_changeset",
        arguments: {
          mind: "/me",
          write_binding_id: writeBindingId,
          expected_revision: starterRevisionId,
          idempotency_key: `commit:${id}`,
          summary: "Reject invalid index precondition",
          operations: [{
            type: "replace_index",
            path: "index.md",
            text: MIND_DIARY_STARTER_OKF_TEMPLATE.find(({ path }) => path === "index.md").text,
            expected_sha256: digest,
          }],
        },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "mind-diary-starter-e2e",
            version: "0.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, expectedStatus, JSON.stringify(rejectedBody));
    if (expectedStatus === 200) {
      assert.equal(rejectedBody.result.isError, true);
      assert.equal(rejectedBody.result.structuredContent.error.code, expectedCode);
    } else {
      assert.equal(rejectedBody.error.code, expectedCode);
    }
  }

  const validation = await modernTool(
    runtime,
    secret,
    "starter-validate",
    "validate_mind",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: starterRevisionId } },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  assert.deepEqual(validation.conformance_errors, []);
  assert.deepEqual(validation.quality_warnings, []);

  const browsed = await modernTool(
    runtime,
    secret,
    "starter-browse-index",
    "browse_entries",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: starterRevisionId } },
  );
  const indexEntry = browsed.entries.find(({ path }) => path === "index.md");
  assert.ok(indexEntry);
  const fetchedIndex = await modernTool(
    runtime,
    secret,
    "starter-fetch-index",
    "fetch",
    { id: indexEntry.entry_id },
  );
  assert.match(fetchedIndex.text, /First useful Memory/u);

  const usefulSearch = await modernTool(
    runtime,
    secret,
    "starter-search",
    "search",
    { mind: "/me", query: "concrete reusable note" },
  );
  assert.equal(usefulSearch.index_status, "ready");
  assert.equal(usefulSearch.results.length, 1);
  assert.equal(usefulSearch.results[0].entry.path, "concepts/first-memory.md");
  const fetchedMemory = await modernTool(
    runtime,
    secret,
    "starter-fetch-memory",
    "fetch",
    { id: usefulSearch.results[0].entry.entry_id },
  );
  assert.match(fetchedMemory.text, /one concrete fact, decision, or reusable note/u);

  await modernTool(
    runtime,
    secret,
    "starter-search-again",
    "search",
    { mind: "/me", query: "concrete reusable note" },
  );
  const forgedCorrelation = await responseFrom(runtime, new Request(`${ORIGIN}/`, {
    headers: {
      "x-mind-diary-performance-correlation-id": "benchmark_forged_without_signature",
    },
  }));
  assert.equal(forgedCorrelation.status, 200);
  assert.equal(
    forgedCorrelation.headers.get("x-mind-diary-performance-correlation-id"),
    null,
  );
  assert.equal(
    (await responseFrom(runtime, new Request(`${ORIGIN}/`, {
      headers: {
        "x-mind-diary-performance-correlation-id": "benchmark_starter_home",
        "x-mind-diary-performance-correlation-signature":
          performanceCorrelationSignature("benchmark_starter_home"),
      },
    }))).status,
    200,
  );
  const telemetry = telemetryLines.map((line) => JSON.parse(line));
  assert.ok(telemetry.some(({ benchmarkCorrelationId }) =>
    benchmarkCorrelationId === "benchmark_starter_home"));
  assert.ok(telemetry.some(({ benchmarkCorrelationId }) =>
    benchmarkCorrelationId === "benchmark_starter_list"));
  assert.equal(telemetry.some(({ benchmarkCorrelationId }) =>
    benchmarkCorrelationId === "benchmark_forged_without_signature"), false);
  assert.equal(telemetry.filter(({ metric }) => metric === "setup_completion").length, 1);
  const firstUseful = telemetry.filter(
    ({ metric }) => metric === "time_to_first_useful_search_ms",
  );
  assert.equal(firstUseful.length, 1);
  assert.equal(firstUseful[0].unit, "milliseconds");
  assert.equal(firstUseful[0].operation, "search");
  assert.equal(firstUseful[0].outcome, "resolved");
  assert.equal(Number.isSafeInteger(firstUseful[0].value), true);
  assert.ok(firstUseful[0].value >= 0);
  const performanceOperations = new Set(
    telemetry
      .filter(({ metric }) => metric === "request_latency_ms")
      .map(({ operation }) => operation),
  );
  for (const operation of [
    "home",
    "mcp_modern",
    "stage_authentication",
    "stage_application",
    "stage_total",
    "recovery_index_gaps",
    "recovery_index_dispatch",
    "recovery_export_dispatch",
    "recovery_staging_cleanup",
    "recovery_import_cleanup",
    "recovery_object_cleanup",
    "recovery_total",
    "browse_entries",
    "search",
    "fetch",
    "commit_changeset",
  ]) {
    assert.ok(performanceOperations.has(operation), `missing performance operation ${operation}`);
  }
  const webPerformance = telemetry.filter(({ metric, surface, operation, benchmarkCorrelationId }) =>
    metric === "request_latency_ms" &&
    surface === "control" &&
    benchmarkCorrelationId === "benchmark_starter_home" &&
    ["home", "stage_authentication", "stage_application", "stage_total"].includes(operation));
  assert.deepEqual(
    webPerformance.map(({ operation }) => operation),
    ["stage_authentication", "stage_application", "stage_total", "home"],
  );
  assert.equal(new Set(webPerformance.map(({ requestId }) => requestId)).size, 1);
  assert.notEqual(webPerformance[0].requestId, null);
  assert.deepEqual(Object.keys(firstUseful[0]).sort(), [
    "benchmarkCorrelationId",
    "cohort",
    "event",
    "jobId",
    "kind",
    "metric",
    "occurredAtUtc",
    "operation",
    "outcome",
    "requestId",
    "schema",
    "surface",
    "unit",
    "value",
  ]);
  const serializedTelemetry = JSON.stringify(telemetry);
  for (const forbidden of [
    "starter.e2e@example.com",
    secret,
    "concrete reusable note",
    "concepts/first-memory.md",
    "First useful Memory",
  ]) {
    assert.equal(serializedTelemetry.includes(forbidden), false, forbidden);
  }

  const exportStarted = await modernTool(
    runtime,
    secret,
    "starter-export-before-unbind",
    "start_export",
    {
      mind: "/me",
      revision_selector: {
        kind: "revision",
        revision_id: starterRevisionId,
      },
      idempotency_key: "export:starter-before-unbind",
    },
  );

  await modernTool(
    runtime,
    secret,
    "starter-unbind-write",
    "set_write_mind_binding",
    {
      action: "unbind",
      expected_binding_version: 1,
      idempotency_key: "binding:starter-unbind",
    },
  );
  const detachedFetch = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-fetch-after-unbind",
    method: "tools/call",
    params: {
      name: "fetch",
      arguments: { id: usefulSearch.results[0].entry.entry_id },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-starter-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(detachedFetch.status, 200);
  const detachedFetchBody = await detachedFetch.json();
  assert.equal(detachedFetchBody.result.isError, true);
  assert.equal(
    detachedFetchBody.result.structuredContent.error.code,
    "mind_binding_required",
  );
  const detachedExportStatus = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-export-status-after-unbind",
    method: "tools/call",
    params: {
      name: "get_export_status",
      arguments: { job_id: exportStarted.job.job_id },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-starter-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(detachedExportStatus.status, 200);
  const detachedExportStatusBody = await detachedExportStatus.json();
  assert.equal(detachedExportStatusBody.result.isError, true);
  assert.equal(
    detachedExportStatusBody.result.structuredContent.error.code,
    "not_found",
  );
});

test("durable Product Site controls one token binding with ownership, CAS, read-back, and revoke fencing", async () => {
  let currentTime = new Date("2026-08-22T11:00:00.000Z");
  const runtime = await createProductSiteRuntime({
    database: new FakeD1Database(),
    bucket: new FakeR2Bucket(),
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "web.binding.e2e@example.com",
          verifiedFullName: "Web Binding E2E",
        };
      },
    },
    tokenVerifierKey: key(17),
    locatorKey: key(57),
    exportDownloadVerifierKey: key(97),
    csrfKey: key(137),
    now: () => currentTime,
    observabilityWriter: { write() {} },
    schedule() {},
  });

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrapped = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:web-binding-e2e",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrapped.status, 200);

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const csrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:web-binding-e2e",
    },
    body: JSON.stringify({ name: "Web binding token", scopes: ["content:write"] }),
  }));
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  const personalTokenRef = issuedBody.data.token.personal_token_ref;
  const secret = issuedBody.data.secret;
  assert.match(personalTokenRef, /^ptok_v1_[0-9a-f]{32}$/u);
  assert.equal(JSON.stringify(issuedBody).includes("token_id"), false);

  const emptyPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const emptyHtml = await emptyPage.text();
  assert.match(emptyHtml, /Web binding token/u);
  assert.match(emptyHtml, /data-binding-version="0"/u);
  assert.match(emptyHtml, /No readable Minds selected/u);
  assert.match(emptyHtml, /Can add and change[\s\S]*Not selected/u);
  assert.doesNotMatch(emptyHtml, /Automatic knowledge capture/u);

  const mutate = (body, idempotencyKey) => responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}/mind-access`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  ));

  const bound = await mutate({
    action: "select_write",
    mind_ref: "/me",
    expected_binding_version: 0,
  }, "binding:web-bind-write");
  assert.equal(bound.status, 200, await bound.clone().text());
  const boundBody = await bound.json();
  assert.equal(boundBody.data.changed, true);
  assert.equal(boundBody.data.replayed, false);
  assert.equal(boundBody.data.access.binding_version, 1);

  const boundPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const boundHtml = await boundPage.text();
  assert.match(boundHtml, /data-binding-version="1"/u);
  assert.match(boundHtml, /Can add and change[\s\S]*Web Binding E2E[\s\S]*\/me[\s\S]*private/u);
  assert.doesNotMatch(boundHtml, /Automatic knowledge capture|data-binding-action/u);
  assert.doesNotMatch(boundHtml, /principal_|space_personal/u);

  const bindingReadResponse = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "web-binding-read-back",
    method: "tools/call",
    params: {
      name: "get_mind_bindings",
      arguments: {},
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "web-binding-runtime-e2e", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(bindingReadResponse.status, 200, await bindingReadResponse.clone().text());
  const bindingReadBody = await bindingReadResponse.json();
  assert.equal(bindingReadBody.result?.isError, false, JSON.stringify(bindingReadBody));
  const bindings = bindingReadBody.result.structuredContent.data;
  assert.equal(bindings.binding_version, 1);
  assert.equal(bindings.write_binding.mind.route, "/me");
  assert.equal(typeof bindings.write_binding.write_binding_id, "string");
  assert.deepEqual(bindings.automatic_capture, {
    mode: "disabled",
    write_binding_id: null,
    updated_at: null,
  });

  const stale = await mutate({
    action: "clear_write",
    expected_binding_version: 0,
  }, "binding:web-stale");
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "binding_version_conflict");
  const afterStale = await modernTool(runtime, secret, "web-binding-after-stale", "get_mind_bindings", {});
  assert.equal(afterStale.binding_version, 1);
  assert.equal(afterStale.write_binding.mind.route, "/me");

  const unknownField = await mutate({
    action: "clear_write",
    expected_binding_version: 1,
    principal_id: "must-not-be-accepted",
  }, "binding:web-unknown-field");
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).error.code, "invalid_request");

  const readOnlyIssued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:web-binding-read-only",
    },
    body: JSON.stringify({ name: "Read-only binding token", scopes: ["content:read"] }),
  }));
  assert.equal(readOnlyIssued.status, 200);
  const readOnlyTokenRef = (await readOnlyIssued.json()).data.token.personal_token_ref;
  const readOnlyWrite = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(readOnlyTokenRef)}/mind-access`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "binding:web-read-only-write",
      },
      body: JSON.stringify({
        action: "select_write",
        mind_ref: "/me",
        expected_binding_version: 0,
      }),
    },
  ));
  assert.equal(readOnlyWrite.status, 409);
  assert.equal((await readOnlyWrite.json()).error.code, "write_step_up_required");
  const readOnlyPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const readOnlyHtml = await readOnlyPage.text();
  const panelFor = (html, tokenRef) => {
    const marker = `data-personal-token-ref="${tokenRef}"`;
    const markerStart = html.indexOf(marker);
    assert.notEqual(markerStart, -1, `missing personal-token panel for ${tokenRef}`);
    const articleStart = html.lastIndexOf("<article", markerStart);
    const articleEnd = html.indexOf("</article>", markerStart);
    assert.notEqual(articleStart, -1);
    assert.notEqual(articleEnd, -1);
    return html.slice(articleStart, articleEnd + "</article>".length);
  };
  const readOnlyPanel = panelFor(readOnlyHtml, readOnlyTokenRef);
  assert.match(readOnlyPanel, /data-access-action="attach_read"/u);
  assert.doesNotMatch(readOnlyPanel, /data-access-action="select_write"|Select one writable Mind/u);

  const revoked = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}`,
    {
      method: "DELETE",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrf,
        "idempotency-key": "revoke:web-binding-e2e",
      },
    },
  ));
  assert.equal(revoked.status, 200);
  const revokedPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp?state=revoked`));
  const revokedHtml = await revokedPage.text();
  assert.match(revokedHtml, /Web binding token/u);
  const revokedPanel = panelFor(revokedHtml, personalTokenRef);
  assert.doesNotMatch(revokedPanel, /data-access-form|data-access-action/u);

  const afterRevoke = await mutate({
    action: "select_write",
    mind_ref: "/me",
    expected_binding_version: 2,
  }, "binding:web-after-revoke");
  assert.equal(afterRevoke.status, 404);
  assert.equal((await afterRevoke.json()).error.code, "personal_token_not_found");

  currentTime = new Date("2027-01-22T11:00:00.000Z");
  const expiredPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp?state=expired`));
  const expiredHtml = await expiredPage.text();
  const expiredReadOnlyPanel = panelFor(expiredHtml, readOnlyTokenRef);
  assert.match(expiredReadOnlyPanel, /expired/u);
  assert.doesNotMatch(expiredReadOnlyPanel, /data-access-form|data-access-action/u);
  const expiredMutation = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(readOnlyTokenRef)}/mind-access`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "binding:web-expired-read",
      },
      body: JSON.stringify({
        action: "attach_read",
        mind_ref: "/me",
        expected_binding_version: 0,
      }),
    },
  ));
  assert.equal(expiredMutation.status, 404);
  assert.equal((await expiredMutation.json()).error.code, "personal_token_not_found");
});

test("durable product runtime carries a Sites account token through Codex MCP and revokes it", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const scheduled = [];
  const telemetryLines = [];
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
    observabilityWriter: { write(line) { telemetryLines.push(line); } },
    schedule(work) { scheduled.push(work); },
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

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  assert.equal(settings.status, 200);
  const settingsHtml = await settings.text();
  assert.match(settingsHtml, new RegExp(`${ORIGIN.replaceAll(".", "\\.")}\\/api\\/mcp\\/2025-11-25`, "u"));
  assert.match(settingsHtml, new RegExp(`${ORIGIN.replaceAll(".", "\\.")}\\/api\\/mcp`, "u"));
  assert.match(settingsHtml, /data-run-mcp-self-check disabled/u);
  assert.doesNotMatch(settingsHtml, /Create the first useful Memory|Restore as a new revision and export/u);
  assert.doesNotMatch(settingsHtml, /&lt;your-mind-diary-site&gt;/u);
  const registeredCsrf = csrfFromHtml(settingsHtml);
  const codexHelp = await responseFrom(runtime, new Request(`${ORIGIN}/help/codex`));
  assert.equal(codexHelp.status, 200);
  const codexHelpHtml = await codexHelp.text();
  assert.match(codexHelpHtml, /Create the first useful Memory/u);
  assert.match(codexHelpHtml, /Preview and confirm a substantial change/u);
  assert.match(codexHelpHtml, /Restore as a new revision and export/u);
  assert.match(codexHelpHtml, /Convert a bounded Markdown set/u);

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
  const personalTokenRef = issuedBody.data.token.personal_token_ref;
  assert.match(secret, /^mdp_v1_/u);
  assert.match(personalTokenRef, /^ptok_v1_[0-9a-f]{32}$/u);
  assert.equal(JSON.stringify(issuedBody).includes("token_id"), false);

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
  const boundWrite = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "bind-write",
    method: "tools/call",
    params: {
      _meta: { progressToken: "bind-write" },
      name: "set_write_mind_binding",
      arguments: {
        action: "bind",
        mind: "/me",
        expected_binding_version: 0,
        idempotency_key: "binding:product-runtime-e2e",
      },
    },
  });
  assert.equal(boundWrite.status, 200);
  const boundWriteBody = await boundWrite.json();
  assert.equal(boundWriteBody.result.isError, false, JSON.stringify(boundWriteBody));
  const writeBindingId =
    boundWriteBody.result.structuredContent.data.current.write_binding_id;
  const committed = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      _meta: { progressToken: 2 },
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        write_binding_id: writeBindingId,
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
  assert.equal(
    committedBody.result.structuredContent.data.previous_revision_id,
    previousRevisionId,
  );
  assert.equal(committedBody.result.structuredContent.data.index_status, "queued");
  const committedIndexWork = scheduled.findLast((work) => work.kind === "revision_index");
  assert.ok(committedIndexWork);
  await runtime.recoverBackground();

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
    committedBody.result.structuredContent.data.revision.revision_id,
  );

  const revisions = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "history-after-write",
    method: "tools/call",
    params: {
      _meta: { progressToken: "history" },
      name: "list_revisions",
      arguments: { mind: "/me", limit: 10 },
    },
  });
  assert.equal(revisions.status, 200);
  const revisionsBody = await revisions.json();
  assert.equal(revisionsBody.result.isError, false, JSON.stringify(revisionsBody));
  const revisionRows = revisionsBody.result.structuredContent.data.revisions;
  assert.deepEqual(
    revisionRows.slice(0, 2).map(({ revision }) => revision.revision_id),
    [advancedMind.head.revision_id, previousRevisionId],
  );

  const historical = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "exact-history-before-restore",
    method: "tools/call",
    params: {
      _meta: { progressToken: "historical" },
      name: "get_revision",
      arguments: { mind: "/me", revision_id: previousRevisionId },
    },
  });
  assert.equal(historical.status, 200);
  const historicalBody = await historical.json();
  assert.equal(historicalBody.result.isError, false, JSON.stringify(historicalBody));
  assert.equal(
    historicalBody.result.structuredContent.data.revision.revision_id,
    previousRevisionId,
  );

  const staleRestore = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "stale-restore",
    method: "tools/call",
    params: {
      _meta: { progressToken: "stale-restore" },
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        write_binding_id: writeBindingId,
        expected_revision: previousRevisionId,
        idempotency_key: "restore-stale:product-runtime-e2e",
        summary: "Attempt stale historical restore",
        operations: [{ type: "delete_file", path: "concepts/runtime-proof.md" }],
      },
    },
  });
  assert.equal(staleRestore.status, 200);
  const staleRestoreBody = await staleRestore.json();
  assert.equal(staleRestoreBody.result.isError, true);
  assert.equal(
    staleRestoreBody.result.structuredContent.error.code,
    "revision_conflict",
  );
  assert.equal(
    staleRestoreBody.result.structuredContent.error.details.current_revision_id,
    advancedMind.head.revision_id,
  );

  const restored = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "confirmed-restore",
    method: "tools/call",
    params: {
      _meta: { progressToken: "confirmed-restore" },
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        write_binding_id: writeBindingId,
        expected_revision: advancedMind.head.revision_id,
        idempotency_key: "restore-fresh:product-runtime-e2e",
        summary: "Restore the selected historical state as a new revision",
        operations: [{ type: "delete_file", path: "concepts/runtime-proof.md" }],
      },
    },
  });
  assert.equal(restored.status, 200);
  const restoredBody = await restored.json();
  assert.equal(restoredBody.result.isError, false, JSON.stringify(restoredBody));
  const restoredRevisionId =
    restoredBody.result.structuredContent.data.revision.revision_id;
  assert.notEqual(restoredRevisionId, previousRevisionId);
  assert.notEqual(restoredRevisionId, advancedMind.head.revision_id);

  const validatedRestore = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "validate-restored-revision",
    method: "tools/call",
    params: {
      _meta: { progressToken: "validate-restored" },
      name: "validate_mind",
      arguments: {
        mind: "/me",
        revision_selector: { kind: "revision", revision_id: restoredRevisionId },
      },
    },
  });
  assert.equal(validatedRestore.status, 200);
  const validatedRestoreBody = await validatedRestore.json();
  assert.equal(validatedRestoreBody.result.isError, false);
  assert.equal(validatedRestoreBody.result.structuredContent.data.valid, true);

  const exportStarted = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "export-restored-revision",
    method: "tools/call",
    params: {
      _meta: { progressToken: "export-start" },
      name: "start_export",
      arguments: {
        mind: "/me",
        revision_selector: { kind: "revision", revision_id: restoredRevisionId },
        idempotency_key: "export-restored:product-runtime-e2e",
      },
    },
  });
  assert.equal(exportStarted.status, 200);
  const exportStartedBody = await exportStarted.json();
  assert.equal(exportStartedBody.result.isError, false, JSON.stringify(exportStartedBody));
  const exportJob = exportStartedBody.result.structuredContent.data.job;
  assert.equal(exportJob.revision_id, restoredRevisionId);
  const exportWork = scheduled.findLast(
    (work) => work.kind === "export" && work.id === exportJob.job_id,
  );
  assert.ok(exportWork);
  const exportRecovery = await runtime.recoverBackground();
  assert.ok(exportRecovery.dispatched >= 1);

  const exportStatus = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "status-restored-export",
    method: "tools/call",
    params: {
      _meta: { progressToken: "export-status" },
      name: "get_export_status",
      arguments: { job_id: exportJob.job_id },
    },
  });
  assert.equal(exportStatus.status, 200);
  const exportStatusBody = await exportStatus.json();
  assert.equal(exportStatusBody.result.isError, false, JSON.stringify(exportStatusBody));
  const completedExport = exportStatusBody.result.structuredContent.data.job;
  assert.equal(completedExport.status, "succeeded");
  assert.equal(completedExport.revision_id, restoredRevisionId);
  assert.equal(completedExport.archive_format, "MD-OKF-ZIP-1");

  const downloaded = await responseFrom(runtime, new Request(completedExport.download_url));
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "application/zip");
  assert.equal(downloaded.headers.get("cache-control"), "no-store");
  assert.equal(
    downloaded.headers.get("content-disposition"),
    'attachment; filename="mind-diary-okf-bundle.zip"',
  );
  const archive = new Uint8Array(await downloaded.arrayBuffer());
  assert.equal(archive.byteLength, completedExport.size);
  assert.equal(
    `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    completedExport.sha256,
  );
  const archiveText = new TextDecoder().decode(archive);
  assert.doesNotMatch(
    archiveText,
    /principal_|token_|membership|audit|idempotency|runtime-proof/u,
  );

  const revoked = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}`,
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

  const telemetry = telemetryLines.map((line) => JSON.parse(line));
  assert.ok(telemetry.length > 0);
  assert.ok(telemetry.every((event) =>
    event.event === "mind-diary.privacy-safe-observability" &&
    event.schema === "mind-diary/privacy-safe-observability/v2"
  ));
  const metrics = new Set(telemetry.map((event) => event.metric));
  for (const metric of [
    "setup_completion",
    "request_latency_ms",
    "authentication_outcome",
    "token_outcome",
    "deletion_outcome",
    "cas_conflict",
    "index_lag_ms",
    "export_lag_ms",
  ]) {
    assert.ok(metrics.has(metric), `missing deployable telemetry metric ${metric}`);
  }
  const serializedTelemetry = JSON.stringify(telemetry);
  for (const forbidden of [
    "Runtime.Owner@Example.COM",
    "runtime.owner@example.com",
    secret,
    completedExport.download_url,
    "concepts/runtime-proof.md",
    "Runtime proof",
  ]) {
    assert.equal(serializedTelemetry.includes(forbidden), false, forbidden);
  }
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
    observabilityWriter: { write() {} },
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

  const outsiderCsrf = await pageCsrf("/settings/developer/mcp");
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
    observabilityWriter: { write() {} },
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
  const memberSettingsCsrf = await csrf("/settings/developer/mcp");
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

test("request-triggered recovery reclaims a revision after an injected index dispatch failure", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const scheduled = [];
  const telemetryLines = [];
  let failNextIndexDispatch = false;
  let injectedFailureCount = 0;
  const recoveryMarker = "recovery-dispatch-marker";
  const runtime = await createProductSiteRuntime({
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "recovery.owner@example.com",
          verifiedFullName: "Recovery Owner",
        };
      },
    },
    tokenVerifierKey: key(171),
    locatorKey: key(211),
    exportDownloadVerifierKey: key(251),
    csrfKey: key(35),
    observabilityWriter: { write(line) { telemetryLines.push(line); } },
    schedule(work) {
      if (work.kind === "revision_index" && failNextIndexDispatch) {
        failNextIndexDispatch = false;
        injectedFailureCount += 1;
        throw new Error("injected revision index dispatch failure");
      }
      scheduled.push(work);
    },
  });

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrapped = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:request-recovery",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrapped.status, 200);

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const settingsCsrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": settingsCsrf,
      "idempotency-key": "token:request-recovery",
    },
    body: JSON.stringify({ name: "Request recovery", scopes: ["content:write"] }),
  }));
  assert.equal(issued.status, 200);
  const secret = (await issued.json()).data.secret;

  const personal = (await modernTool(
    runtime,
    secret,
    "request-recovery-list",
    "list_minds",
    {},
  )).minds.find(({ route }) => route === "/me");
  assert.ok(personal);
  const writeBinding = await modernTool(
    runtime,
    secret,
    "request-recovery-bind-write",
    "set_write_mind_binding",
    {
      action: "bind",
      mind: "/me",
      expected_binding_version: 0,
      idempotency_key: "binding:request-recovery",
    },
  );
  const initialRevisionId = personal.head.revision_id;
  const initialBrowse = await modernTool(
    runtime,
    secret,
    "request-recovery-browse-initial",
    "browse_entries",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: initialRevisionId } },
  );
  const initialIndexDigest = initialBrowse.entries.find(({ path }) => path === "index.md")?.sha256;
  assert.match(initialIndexDigest, /^sha256:[0-9a-f]{64}$/u);

  failNextIndexDispatch = true;
  const failedCommit = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "request-recovery-injected-failure",
    method: "tools/call",
    params: {
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        write_binding_id: writeBinding.current.write_binding_id,
        expected_binding_version: writeBinding.binding_version,
        expected_revision: initialRevisionId,
        idempotency_key: "commit:request-recovery",
        summary: "Recovery dispatch fixture",
        operations: [{
          type: "create_file",
          path: "concepts/recovery-marker.md",
          text: `---\ntype: Reference\n---\n\n${recoveryMarker}.\n`,
        }],
      },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-request-recovery-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(injectedFailureCount, 1);
  assert.equal(failedCommit.status, 500);
  const failedCommitBody = await failedCommit.json();
  assert.deepEqual(failedCommitBody, {
    code: "internal_error",
    request_id: failedCommitBody.request_id,
  });
  assert.equal(JSON.stringify(failedCommitBody).includes(recoveryMarker), false);
  assert.equal(JSON.stringify(failedCommitBody).includes("recovery.owner@example.com"), false);

  const afterFailureMinds = await modernTool(
    runtime,
    secret,
    "request-recovery-head-after-failure",
    "list_minds",
    {},
  );
  const failedHead = afterFailureMinds.minds.find(({ route }) => route === "/me");
  assert.ok(failedHead);
  const failedRevisionId = failedHead.head.revision_id;
  assert.notEqual(failedRevisionId, initialRevisionId);
  const queuedInfo = await modernTool(
    runtime,
    secret,
    "request-recovery-queued",
    "get_mind_info",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: failedRevisionId } },
  );
  assert.equal(queuedInfo.resolved_revision.revision_id, failedRevisionId);
  assert.equal(queuedInfo.index_status.status, "queued");
  assert.equal(queuedInfo.index_status.retryable, true);

  const unavailableSearch = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "request-recovery-search-before",
    method: "tools/call",
    params: {
      name: "search",
      arguments: { mind: "/me", query: "dispatch marker" },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-request-recovery-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(unavailableSearch.status, 200);
  const unavailableSearchBody = await unavailableSearch.json();
  assert.equal(unavailableSearchBody.result.isError, true);
  assert.equal(
    unavailableSearchBody.result.structuredContent.error.code,
    "search_index_unavailable",
  );
  assert.equal(JSON.stringify(unavailableSearchBody).includes(recoveryMarker), false);

  // Simulate an isolate/redeploy boundary through the same exported Worker
  // fetch factory used by the deployed default export. Its cache, coordinator
  // and composed runtime are fresh; only D1/R2 durable state is shared.
  let restartedRuntime;
  const recoveryWaits = [];
  const recoveryEnvironment = {
    DB: database,
    MIND_DIARY_BUCKET: bucket,
    MIND_DIARY_PUBLIC_ORIGIN: ORIGIN,
  };
  const restartedWorker = createMindDiaryProductWorker({
    async createRuntime(options) {
      restartedRuntime = await createProductSiteRuntime({
        ...options,
        observabilityWriter: { write(line) { telemetryLines.push(line); } },
      });
      return restartedRuntime;
    },
    readConfig() {
      return {
        publicOrigin: ORIGIN,
        tokenVerifierKey: key(171),
        locatorKey: key(211),
        exportDownloadVerifierKey: key(251),
        csrfKey: key(35),
        serviceOperatorPrincipalIds: [],
      };
    },
    async fallbackFetch() {
      return new Response("not found", { status: 404 });
    },
    recoveryCoordinator: new RequestRecoveryCoordinator({
      cadenceMs: 30_000,
      idleMs: 1,
      delay: async () => undefined,
      now: () => 1_000,
    }),
  });
  const documentRequest = new Request(`${ORIGIN}/`, {
    headers: {
      accept: "text/html",
      "user-agent": "request-recovery-test",
      "oai-authenticated-user-email": "recovery.owner@example.com",
      "oai-authenticated-user-full-name": "Recovery%20Owner",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
      "x-mind-diary-performance-correlation-id": "benchmark_forged_worker_identity",
    },
  });
  const documentResponse = await restartedWorker.fetch(
    documentRequest,
    recoveryEnvironment,
    {
      waitUntil: (promise) => recoveryWaits.push(promise),
      passThroughOnException() {},
    },
  );
  assert.equal(documentResponse.status, 200);
  assert.equal(
    documentResponse.headers.get("x-mind-diary-performance-correlation-id"),
    null,
  );
  assert.equal(recoveryWaits.length, 1);
  await Promise.all(recoveryWaits);
  assert.ok(restartedRuntime);

  const readyInfo = await modernTool(
    restartedRuntime,
    secret,
    "request-recovery-ready",
    "get_mind_info",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: failedRevisionId } },
  );
  assert.equal(readyInfo.resolved_revision.revision_id, failedRevisionId);
  assert.equal(readyInfo.index_status.status, "ready");
  assert.equal(readyInfo.index_status.retryable, false);

  const searchable = await modernTool(
    restartedRuntime,
    secret,
    "request-recovery-search-after",
    "search",
    { mind: "/me", query: "dispatch marker" },
  );
  assert.equal(searchable.index_status, "ready");
  assert.equal(searchable.results.length, 1);
  assert.equal(searchable.results[0].entry.revision_id, failedRevisionId);
  assert.equal(searchable.results[0].entry.path, "concepts/recovery-marker.md");
  const noHit = await modernTool(
    restartedRuntime,
    secret,
    "request-recovery-search-no-hit",
    "search",
    { mind: "/me", query: "synthetic definitely absent recovery phrase" },
  );
  assert.equal(noHit.index_status, "ready");
  assert.deepEqual(noHit.results, []);

  const finalMinds = await modernTool(
    restartedRuntime,
    secret,
    "request-recovery-final-head",
    "list_minds",
    {},
  );
  assert.equal(
    finalMinds.minds.find(({ route }) => route === "/me").head.revision_id,
    failedRevisionId,
  );

  await modernTool(
    restartedRuntime,
    secret,
    "request-recovery-unbind-write",
    "set_write_mind_binding",
    {
      action: "unbind",
      expected_binding_version: writeBinding.binding_version,
      idempotency_key: "binding:request-recovery-unbind",
    },
  );

  const unboundRead = await modernMcp(restartedRuntime, secret, {
    jsonrpc: "2.0",
    id: "request-recovery-unbound-read",
    method: "tools/call",
    params: {
      name: "browse_entries",
      arguments: { mind: "/me" },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-request-recovery-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(unboundRead.status, 200);
  const unboundReadBody = await unboundRead.json();
  assert.equal(unboundReadBody.result.isError, true);
  assert.equal(
    unboundReadBody.result.structuredContent.error.code,
    "mind_binding_required",
  );
  assert.equal(JSON.stringify(unboundReadBody).includes(recoveryMarker), false);

  assert.ok(scheduled.some(({ kind }) => kind === "revision_index"));
  for (const line of telemetryLines) {
    assert.equal(line.includes(recoveryMarker), false);
    assert.equal(line.includes("recovery.owner@example.com"), false);
  }
});
