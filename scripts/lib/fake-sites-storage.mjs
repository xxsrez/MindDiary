import { SITES_AUDIT_MIGRATIONS } from "../../packages/adapter-audit-sites/dist/index.js";
import { SITES_METADATA_MIGRATIONS } from "../../packages/adapter-metadata-sites/dist/index.js";
import { SITES_OAUTH_SCHEMA } from "../../packages/adapter-oauth-sites/dist/index.js";
import { SITES_SEARCH_MIGRATIONS } from "../../packages/adapter-search-sites/dist/index.js";

function canonicalSql(sql) {
  return sql.replace(/\s+/gu, " ").trim();
}

export const EXPECTED_D1_SCHEMA_GROUPS = Object.freeze({
  metadata: Object.freeze(
    SITES_METADATA_MIGRATIONS.flatMap((migration) => migration.statements).map(canonicalSql),
  ),
  search: Object.freeze(SITES_SEARCH_MIGRATIONS.map(canonicalSql)),
  audit: Object.freeze(SITES_AUDIT_MIGRATIONS.map(canonicalSql)),
  oauth: Object.freeze(SITES_OAUTH_SCHEMA.map(canonicalSql)),
});

const EXPECTED_D1_SCHEMA = new Set(Object.values(EXPECTED_D1_SCHEMA_GROUPS).flat());

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

  schemaSql() {
    return canonicalSql(this.#sql);
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

export class FakeD1Database {
  metadataEvents = [];
  search = new Map();
  audit = new Map();
  #appliedSchema = new Set();

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    const sql = statements.map((statement) => statement.schemaSql());
    for (const [group, expected] of Object.entries(EXPECTED_D1_SCHEMA_GROUPS)) {
      const present = expected.filter((statement) => sql.includes(statement));
      if (present.length > 0 && present.length !== expected.length) {
        throw new Error(`incomplete FakeD1 ${group} schema batch`);
      }
    }
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async run(sql, values) {
    const normalizedSql = canonicalSql(sql);
    if (/^(?:CREATE TABLE|CREATE INDEX)/u.test(normalizedSql)) {
      if (!EXPECTED_D1_SCHEMA.has(normalizedSql)) {
        throw new Error(`unexpected FakeD1 schema statement: ${normalizedSql}`);
      }
      this.#appliedSchema.add(normalizedSql);
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("/*md-metadata-migration*/")) {
      this.#assertSchema("metadata");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-search-migration*/")) {
      this.#assertSchema("search");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-audit-migration*/")) {
      this.#assertSchema("audit");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-")) this.#assertSchema("oauth");
    if (sql.includes("/*md-oauth-principal-")) {
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("/*md-metadata-append*/")) {
      this.#assertSchema("metadata");
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
      this.#assertSchema("search");
      this.search.set(`${values[0]}\u0000${values[1]}`, values[2]);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-search-purge*/")) {
      this.#assertSchema("search");
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
      this.#assertSchema("audit");
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
      this.#assertSchema("audit");
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
      this.#assertSchema("audit");
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
      this.#assertSchema("metadata");
      return {
        success: true,
        results: this.metadataEvents.map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-search-read*/")) {
      this.#assertSchema("search");
      const documents_json = this.search.get(`${values[0]}\u0000${values[1]}`);
      return {
        success: true,
        results: documents_json === undefined ? [] : [{ documents_json }],
      };
    }
    if (sql.includes("/*md-audit-by-principal*/")) {
      this.#assertSchema("audit");
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

  destroy() {
    this.metadataEvents.splice(0);
    this.search.clear();
    this.audit.clear();
    this.#appliedSchema.clear();
  }

  #assertSchema(group) {
    const missing = EXPECTED_D1_SCHEMA_GROUPS[group]
      .filter((statement) => !this.#appliedSchema.has(statement));
    if (missing.length > 0) {
      throw new Error(`FakeD1 ${group} schema is incomplete`);
    }
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

export class FakeR2Bucket {
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

  destroy() {
    this.records.clear();
  }
}

export function deterministicKey(seed) {
  return Uint8Array.from(
    { length: 32 },
    (_value, index) => (seed + index) % 256,
  );
}
