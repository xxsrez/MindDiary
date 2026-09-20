import { SITES_AUDIT_MIGRATIONS } from "../../packages/adapter-audit-sites/dist/index.js";
import {
  SITES_LOCAL_FILE_UPLOAD_INTENT_SCHEMA,
  SITES_METADATA_MIGRATIONS,
} from "../../packages/adapter-metadata-sites/dist/index.js";
import { SITES_LOCATOR_MIGRATIONS } from "../../packages/adapter-locator-sites/dist/index.js";
import { SITES_OAUTH_SCHEMA } from "../../packages/adapter-oauth-sites/dist/index.js";
import { SITES_SEARCH_MIGRATIONS } from "../../packages/adapter-search-sites/dist/index.js";

function canonicalSql(sql) {
  return sql.replace(/\s+/gu, " ").trim();
}

export const EXPECTED_D1_SCHEMA_GROUPS = Object.freeze({
  metadata: Object.freeze(
    SITES_METADATA_MIGRATIONS.flatMap((migration) => migration.statements).map(canonicalSql),
  ),
  uploadIntents: Object.freeze(
    SITES_LOCAL_FILE_UPLOAD_INTENT_SCHEMA.map(canonicalSql),
  ),
  locator: Object.freeze(SITES_LOCATOR_MIGRATIONS.map(canonicalSql)),
  search: Object.freeze(SITES_SEARCH_MIGRATIONS.map(canonicalSql)),
  audit: Object.freeze(SITES_AUDIT_MIGRATIONS.map(canonicalSql)),
  oauth: Object.freeze(SITES_OAUTH_SCHEMA.map(canonicalSql)),
});

const EXPECTED_METADATA_SCHEMA_BATCHES = Object.freeze(
  SITES_METADATA_MIGRATIONS.map((migration) =>
    Object.freeze(migration.statements.map(canonicalSql))),
);

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
  backupControl = null;
  backupSessions = new Map();
  backupCleanupOps = new Map();
  metadataSnapshot = null;
  metadataSnapshotHead = null;
  metadataSnapshotChunks = new Map();
  principalActivities = new Map();
  localFileUploadIntents = new Map();
  locatorHandles = new Map();
  search = new Map();
  searchDocuments = new Map();
  searchMemberships = new Map();
  searchLexical = new Map();
  searchFields = new Map();
  searchV6FieldProjectionsInvalidated = false;
  audit = new Map();
  oauthClients = new Map();
  oauthRequests = new Map();
  oauthGrants = new Map();
  oauthCodes = new Map();
  oauthAccess = new Map();
  oauthRefresh = new Map();
  #appliedSchema = new Set();

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    const sql = statements.map((statement) => statement.schemaSql());
    for (const [group, expected] of Object.entries(EXPECTED_D1_SCHEMA_GROUPS)) {
      if (group === "metadata") continue;
      const present = expected.filter((statement) => sql.includes(statement));
      if (present.length > 0 && present.length !== expected.length) {
        throw new Error(`incomplete FakeD1 ${group} schema batch`);
      }
    }
    for (const expected of EXPECTED_METADATA_SCHEMA_BATCHES) {
      const present = expected.filter((statement) => sql.includes(statement));
      if (present.length > 0 && present.length !== expected.length) {
        throw new Error("incomplete FakeD1 metadata schema batch");
      }
    }
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async run(sql, values) {
    const normalizedSql = canonicalSql(sql);
    if (/^(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE)/u.test(normalizedSql)) {
      if (!EXPECTED_D1_SCHEMA.has(normalizedSql)) {
        throw new Error(`unexpected FakeD1 schema statement: ${normalizedSql}`);
      }
      this.#appliedSchema.add(normalizedSql);
      return { success: true, meta: { changes: 0 } };
    }
    if (normalizedSql.startsWith("INSERT OR IGNORE INTO md_backup_control")) {
      this.#appliedSchema.add(normalizedSql);
      if (this.backupControl !== null) return { success: true, meta: { changes: 0 } };
      this.backupControl = {
        origin_id: "synthetic-origin", generation: 1,
        backup_sequence: this.metadataEvents.at(-1)?.sequence ?? 0,
        invalidation_epoch: 0,
      };
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-migration*/")) {
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-upload-intent-create*/")) {
      this.#assertSchema("uploadIntents");
      if (
        this.localFileUploadIntents.has(values[0]) ||
        [...this.localFileUploadIntents.values()].some(
          (row) => row.namespace_hash === values[1],
        )
      ) return { success: true, meta: { changes: 0 } };
      this.localFileUploadIntents.set(values[0], {
        intent_id: values[0],
        namespace_hash: values[1],
        expires_at: values[2],
        record_version: 1,
        record_json: values[3],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-upload-intent-update*/")) {
      this.#assertSchema("uploadIntents");
      const row = this.localFileUploadIntents.get(values[2]);
      if (!row || row.record_version !== Number(values[3])) {
        return { success: true, meta: { changes: 0 } };
      }
      Object.assign(row, {
        expires_at: values[0],
        record_version: row.record_version + 1,
        record_json: values[1],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-upload-intent-delete-expired*/")) {
      this.#assertSchema("uploadIntents");
      const row = this.localFileUploadIntents.get(values[0]);
      if (
        !row || row.expires_at !== values[1] || row.expires_at > values[2]
      ) return { success: true, meta: { changes: 0 } };
      this.localFileUploadIntents.delete(values[0]);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-locator-create*/")) {
      if (this.locatorHandles.has(values[0])) {
        throw new Error("duplicate FakeD1 locator verifier");
      }
      this.locatorHandles.set(values[0], {
        verifier: values[0],
        encrypted_payload: values[1],
        expires_at: values[2],
        created_at: values[3],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-locator-cleanup*/")) {
      const expired = [...this.locatorHandles.values()]
        .filter((row) => row.expires_at <= values[0])
        .sort((left, right) => left.expires_at.localeCompare(right.expires_at))
        .slice(0, 64);
      for (const row of expired) this.locatorHandles.delete(row.verifier);
      return { success: true, meta: { changes: expired.length } };
    }
    if (sql.includes("/*md-locator-delete*/")) {
      const removed = this.locatorHandles.delete(values[0]);
      return { success: true, meta: { changes: removed ? 1 : 0 } };
    }
    if (sql.includes("/*md-search-migration*/")) {
      this.#assertSchema("search");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-search-v6-invalidate-field-projections*/")) {
      if (this.searchV6FieldProjectionsInvalidated) {
        return { success: true, meta: { changes: 0 } };
      }
      const changes = this.searchFields.size;
      this.searchFields.clear();
      this.searchV6FieldProjectionsInvalidated = true;
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-audit-migration*/")) {
      this.#assertSchema("audit");
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-")) this.#assertSchema("oauth");
    if (sql.includes("/*md-oauth-client-create*/")) {
      this.oauthClients.set(values[0], {
        id: values[0],
        client_name: values[1],
        redirect_uris_json: values[2],
        grant_types_json: values[3],
        response_types_json: values[4],
        token_endpoint_auth_method: values[5],
        created_at: values[6],
        last_used_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-request-create*/")) {
      this.oauthRequests.set(values[0], {
        id: values[0],
        principal_id: values[1],
        client_id: values[2],
        client_name: values[3],
        redirect_uri: values[4],
        resource: values[5],
        scopes_json: values[6],
        state: values[7],
        code_challenge: values[8],
        expires_at: values[9],
        created_at: values[10],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-grant-upsert*/")) {
      const existing = [...this.oauthGrants.values()].find((row) =>
        row.principal_id === values[2] &&
        row.client_id === values[3] &&
        row.resource === values[5]);
      const reconnecting = existing?.revoked_at != null;
      const row = existing ?? {
        id: values[0],
        connection_ref: values[1],
        principal_id: values[2],
        client_id: values[3],
        resource: values[5],
        created_at: values[7],
        last_used_at: null,
      };
      if (reconnecting) {
        this.oauthGrants.delete(row.id);
        Object.assign(row, {
          id: values[0],
          connection_ref: values[1],
          created_at: values[7],
          last_used_at: null,
        });
      }
      Object.assign(row, {
        client_name: values[4],
        scopes_json: values[6],
        revoked_at: null,
        updated_at: values[8],
      });
      this.oauthGrants.set(row.id, row);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-code-create*/")) {
      this.oauthCodes.set(values[0], {
        id: values[0],
        code_verifier: values[1],
        grant_id: values[2],
        principal_id: values[3],
        client_id: values[4],
        redirect_uri: values[5],
        resource: values[6],
        scopes_json: values[7],
        code_challenge: values[8],
        expires_at: values[9],
        consumed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-access-create*/")) {
      this.oauthAccess.set(values[0], {
        id: values[0],
        token_verifier: values[1],
        grant_id: values[2],
        principal_id: values[3],
        client_id: values[4],
        resource: values[5],
        scopes_json: values[6],
        expires_at: values[7],
        created_at: values[8],
        last_used_at: null,
        revoked_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-refresh-create*/")) {
      this.oauthRefresh.set(values[0], {
        id: values[0],
        token_verifier: values[1],
        grant_id: values[2],
        family_id: values[3],
        parent_id: values[4],
        principal_id: values[5],
        client_id: values[6],
        resource: values[7],
        scopes_json: values[8],
        expires_at: values[9],
        created_at: values[10],
        used_at: null,
        revoked_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-oauth-grant-touch*/")) {
      const row = this.oauthGrants.get(values[2]);
      if (row) Object.assign(row, { last_used_at: values[0], updated_at: values[1] });
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("/*md-oauth-access-touch*/")) {
      const row = this.oauthAccess.get(values[1]);
      if (row) row.last_used_at = values[0];
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("/*md-oauth-grant-revoke*/")) {
      const row = this.oauthGrants.get(values[2]);
      if (row) Object.assign(row, { revoked_at: values[0], updated_at: values[1] });
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("/*md-oauth-family-revoke*/")) {
      let changes = 0;
      for (const row of this.oauthRefresh.values()) {
        if (row.family_id === values[1] && !row.revoked_at) {
          row.revoked_at = values[0];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-oauth-access-grant-revoke*/")) {
      let changes = 0;
      for (const row of this.oauthAccess.values()) {
        if (row.grant_id === values[1] && !row.revoked_at) {
          row.revoked_at = values[0];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-oauth-refresh-grant-revoke*/")) {
      let changes = 0;
      for (const row of this.oauthRefresh.values()) {
        if (row.grant_id === values[1] && !row.revoked_at) {
          row.revoked_at = values[0];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-oauth-access-revoke*/")) {
      let changes = 0;
      for (const row of this.oauthAccess.values()) {
        if (row.token_verifier === values[1] && row.client_id === values[2]) {
          row.revoked_at = values[0];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-oauth-access-record-revoke*/")) {
      const row = this.oauthAccess.get(values[1]);
      if (row && !row.revoked_at) row.revoked_at = values[0];
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("/*md-oauth-refresh-record-revoke*/")) {
      const row = this.oauthRefresh.get(values[1]);
      if (row && !row.revoked_at) row.revoked_at = values[0];
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("/*md-oauth-principal-grants-revoke*/")) {
      let changes = 0;
      for (const row of this.oauthGrants.values()) {
        if (row.principal_id === values[2] && !row.revoked_at) {
          Object.assign(row, { revoked_at: values[0], updated_at: values[1] });
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-oauth-principal-access-revoke*/")) {
      let changes = 0;
      for (const row of this.oauthAccess.values()) {
        if (row.principal_id === values[1] && !row.revoked_at) {
          row.revoked_at = values[0];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-oauth-principal-refresh-revoke*/")) {
      let changes = 0;
      for (const row of this.oauthRefresh.values()) {
        if (row.principal_id === values[1] && !row.revoked_at) {
          row.revoked_at = values[0];
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-oauth-principal-requests-delete*/")) {
      let changes = 0;
      for (const [id, row] of this.oauthRequests) {
        if (row.principal_id === values[0]) {
          this.oauthRequests.delete(id);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-metadata-append*/")) {
      this.#assertSchema("metadata");
      const expected = Number(values[5]);
      const current = this.metadataEvents.at(-1)?.sequence ?? 0;
      if (current !== expected || this.backupControl?.backup_sequence !== expected) {
        return { success: true, meta: { changes: 0 } };
      }
      this.metadataEvents.push({
        sequence: Number(values[0]),
        target: values[1],
        operation: values[2],
        payload_json: values[3],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-backup-sequence-advance*/")) {
      const [sequence, invalidates, expected, target, operation, payload] = values;
      const event = this.metadataEvents.find((row) => row.sequence === Number(sequence));
      if (this.backupControl?.backup_sequence !== Number(expected) ||
        event?.target !== target || event?.operation !== operation ||
        event?.payload_json !== payload) return { success: true, meta: { changes: 0 } };
      this.backupControl.backup_sequence = Number(sequence);
      this.backupControl.invalidation_epoch += Number(invalidates);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-backup-invalidate-deleted-state*/")) {
      let changes = 0;
      for (const session of this.backupSessions.values()) {
        if (session.status !== "building" && session.status !== "ready") continue;
        session.status = "invalidated";
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-backup-cleanup-admit*/")) {
      if ([...this.backupSessions.values()].some((session) =>
        ["building", "ready"].includes(session.status) &&
        session.expires_at > values[1])) {
        return { success: true, meta: { changes: 0 } };
      }
      this.backupCleanupOps.set(values[0], values[1]);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-backup-cleanup-finish*/")) {
      return { success: true,
        meta: { changes: this.backupCleanupOps.delete(values[0]) ? 1 : 0 } };
    }
    if (sql.includes("/*md-metadata-snapshot-write*/")) {
      this.#assertSchema("metadata");
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
      this.#assertSchema("metadata");
      this.metadataSnapshotChunks.set(`${values[0]}:${values[1]}`, {
        sequence: Number(values[0]),
        chunk_index: Number(values[1]),
        payload_json: values[2],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-snapshot-cleanup*/")) {
      this.#assertSchema("metadata");
      const headSequence = this.metadataSnapshotHead?.sequence ?? 0;
      let changes = 0;
      for (const [key, row] of this.metadataSnapshotChunks) {
        if (row.sequence >= headSequence) continue;
        this.metadataSnapshotChunks.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-principal-activity-upsert*/")) {
      this.#assertSchema("metadata");
      const expectedSequence = Number(values[6]);
      const currentSequence = this.metadataEvents.at(-1)?.sequence ?? 0;
      if (currentSequence !== expectedSequence) {
        return { success: true, meta: { changes: 0 } };
      }
      const current = this.principalActivities.get(values[0]);
      const next = {
        principal_id: values[0],
        last_web_seen_at: values[1],
        last_mcp_seen_at: values[2],
        last_activity_at: values[3],
        last_activity_surface: values[4],
        last_activity_kind: values[5],
      };
      if (current?.last_web_seen_at &&
          (!next.last_web_seen_at || current.last_web_seen_at >= next.last_web_seen_at)) {
        next.last_web_seen_at = current.last_web_seen_at;
      }
      if (current?.last_mcp_seen_at &&
          (!next.last_mcp_seen_at || current.last_mcp_seen_at >= next.last_mcp_seen_at)) {
        next.last_mcp_seen_at = current.last_mcp_seen_at;
      }
      if (current && current.last_activity_at >= next.last_activity_at) {
        next.last_activity_at = current.last_activity_at;
        next.last_activity_surface = current.last_activity_surface;
        next.last_activity_kind = current.last_activity_kind;
      }
      this.principalActivities.set(values[0], next);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-principal-activity-delete-committed*/")) {
      this.#assertSchema("metadata");
      const event = this.metadataEvents.find((row) => row.sequence === Number(values[1]));
      const committed = event !== undefined &&
        event.target === values[2] &&
        event.operation === values[3] &&
        event.payload_json === values[4];
      return {
        success: true,
        meta: {
          changes: committed && this.principalActivities.delete(values[0]) ? 1 : 0,
        },
      };
    }
    if (sql.includes("/*md-principal-activity-delete*/")) {
      this.#assertSchema("metadata");
      return {
        success: true,
        meta: { changes: this.principalActivities.delete(values[0]) ? 1 : 0 },
      };
    }
    if (sql.includes("/*md-search-membership-delete*/")) {
      this.#assertSchema("search");
      let changes = 0;
      for (const [key, row] of this.searchMemberships) {
        if (row.space_id !== values[0] || row.revision_id !== values[1]) continue;
        this.searchMemberships.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-document-upsert*/")) {
      this.#assertSchema("search");
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
    if (sql.includes("/*md-search-fields-upsert*/")) {
      let changes = 0;
      for (let index = 0; index < values.length; index += 8) {
        const key = `${values[index]}\u0000${values[index + 1]}`;
        if (this.searchFields.has(key)) continue;
        this.searchFields.set(key, {
          space_id: values[index],
          digest: values[index + 1],
          normalized_title: values[index + 2],
          normalized_description: values[index + 3],
          normalized_tags: values[index + 4],
          normalized_headings: values[index + 5],
          normalized_body: values[index + 6],
          title_from_path: Number(values[index + 7]),
        });
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("/*md-search-membership-insert*/")) {
      this.#assertSchema("search");
      for (let index = 0; index < values.length; index += 6) {
        const row = {
          space_id: values[index], revision_id: values[index + 1], ordinal: Number(values[index + 2]),
          path: values[index + 3], digest: values[index + 4],
          normalized_path_title: values[index + 5],
        };
        this.searchMemberships.set(`${row.space_id}\u0000${row.revision_id}\u0000${row.path}`, row);
      }
      return { success: true, meta: { changes: values.length / 6 } };
    }
    if (sql.includes("/*md-search-legacy-delete*/")) {
      const removed = this.search.delete(`${values[0]}\u0000${values[1]}`);
      return { success: true, meta: { changes: removed ? 1 : 0 } };
    }
    if (sql.includes("/*md-search-orphan-fields-cleanup*/")) {
      let changes = 0;
      const used = new Set([...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0])
        .map((row) => row.digest));
      for (const [key, row] of this.searchFields) {
        if (row.space_id !== values[0] || used.has(row.digest) || changes >= 100) continue;
        this.searchFields.delete(key);
        changes += 1;
      }
      return { success: true, meta: { changes } };
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
      this.#assertSchema("search");
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
    if (sql.includes("/*md-search-purge-fields*/")) {
      let changes = 0;
      for (const [key, row] of this.searchFields) {
        if (row.space_id !== values[0]) continue;
        this.searchFields.delete(key);
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
    if (sql.includes("/*md-upload-intent-read-namespace*/")) {
      this.#assertSchema("uploadIntents");
      const row = [...this.localFileUploadIntents.values()].find(
        (candidate) => candidate.namespace_hash === values[0],
      );
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-upload-intent-read*/")) {
      this.#assertSchema("uploadIntents");
      const row = this.localFileUploadIntents.get(values[0]);
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-upload-intent-collect-expired*/")) {
      this.#assertSchema("uploadIntents");
      return {
        success: true,
        results: [...this.localFileUploadIntents.values()]
          .filter((row) => row.expires_at <= values[0])
          .sort((left, right) =>
            left.expires_at.localeCompare(right.expires_at) ||
            left.intent_id.localeCompare(right.intent_id))
          .slice(0, Number(values[1]))
          .map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-oauth-")) this.#assertSchema("oauth");
    if (sql.includes("/*md-oauth-client-read*/")) {
      return { results: this.oauthClients.has(values[0]) ? [{ ...this.oauthClients.get(values[0]) }] : [] };
    }
    if (sql.includes("/*md-oauth-request-consume*/")) {
      const row = this.oauthRequests.get(values[0]);
      if (!row || row.principal_id !== values[1] || row.expires_at <= values[2]) {
        return { results: [] };
      }
      this.oauthRequests.delete(values[0]);
      return { results: [{ ...row }] };
    }
    if (sql.includes("/*md-oauth-grant-read*/")) {
      const row = [...this.oauthGrants.values()].find((item) =>
        item.principal_id === values[0] &&
        item.client_id === values[1] &&
        item.resource === values[2]);
      return {
        results: row
          ? [{
              id: row.id,
              connection_ref: row.connection_ref,
              scopes_json: row.scopes_json,
              revoked_at: row.revoked_at,
            }]
          : [],
      };
    }
    if (sql.includes("/*md-oauth-code-read*/")) {
      const row = [...this.oauthCodes.values()].find((item) =>
        item.code_verifier === values[0] && !item.consumed_at && item.expires_at > values[1]);
      return { results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-oauth-code-consume*/")) {
      const row = this.oauthCodes.get(values[1]);
      if (!row || row.consumed_at) return { results: [] };
      row.consumed_at = values[0];
      return { results: [{ id: row.id }] };
    }
    if (sql.includes("/*md-oauth-access-authenticate*/")) {
      const row = [...this.oauthAccess.values()].find((item) => item.token_verifier === values[0]);
      return {
        results: row
          ? [{ ...row, grant_revoked_at: this.oauthGrants.get(row.grant_id)?.revoked_at ?? null }]
          : [],
      };
    }
    if (sql.includes("/*md-oauth-access-grant-list*/")) {
      return {
        results: [...this.oauthAccess.values()]
          .filter((row) => row.grant_id === values[0] && !row.revoked_at)
          .map((row) => ({ id: row.id, principal_id: row.principal_id })),
      };
    }
    if (sql.includes("/*md-oauth-access-principal-list*/")) {
      return {
        results: [...this.oauthAccess.values()]
          .filter((row) => row.principal_id === values[0] && !row.revoked_at)
          .map((row) => ({ id: row.id, principal_id: row.principal_id })),
      };
    }
    if (sql.includes("/*md-oauth-access-owner*/")) {
      const row = [...this.oauthAccess.values()].find((item) =>
        item.token_verifier === values[0] && item.client_id === values[1]);
      return { results: row ? [{ id: row.id, principal_id: row.principal_id }] : [] };
    }
    if (sql.includes("/*md-oauth-refresh-read*/")) {
      const row = [...this.oauthRefresh.values()].find((item) => item.token_verifier === values[0]);
      return {
        results: row
          ? [{ ...row, grant_revoked_at: this.oauthGrants.get(row.grant_id)?.revoked_at ?? null }]
          : [],
      };
    }
    if (sql.includes("/*md-oauth-refresh-consume*/")) {
      const row = this.oauthRefresh.get(values[1]);
      if (!row || row.used_at || row.revoked_at) return { results: [] };
      row.used_at = values[0];
      return { results: [{ id: row.id }] };
    }
    if (sql.includes("/*md-oauth-refresh-owner*/")) {
      const row = [...this.oauthRefresh.values()].find((item) =>
        item.token_verifier === values[0] && item.client_id === values[1]);
      return {
        results: row ? [{
          grant_id: row.grant_id,
          family_id: row.family_id,
          principal_id: row.principal_id,
        }] : [],
      };
    }
    if (sql.includes("/*md-oauth-connections-page-first*/")) {
      const rows = [...this.oauthGrants.values()]
        .filter((row) => row.principal_id === values[0] && !row.revoked_at)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) ||
          right.connection_ref.localeCompare(left.connection_ref));
      return { results: rows.slice(0, values[1]) };
    }
    if (sql.includes("/*md-oauth-connections-page-after*/")) {
      const [principalId, upperAt, _upperAtAgain, upperRef, afterAt, _afterAtAgain, afterRef, limit] = values;
      const atOrBelow = (row, createdAt, connectionRef, inclusive) =>
        row.created_at < createdAt ||
        (row.created_at === createdAt && (inclusive
          ? row.connection_ref <= connectionRef
          : row.connection_ref < connectionRef));
      const rows = [...this.oauthGrants.values()]
        .filter((row) => row.principal_id === principalId && !row.revoked_at)
        .filter((row) => atOrBelow(row, upperAt, upperRef, true))
        .filter((row) => atOrBelow(row, afterAt, afterRef, false))
        .sort((left, right) => right.created_at.localeCompare(left.created_at) ||
          right.connection_ref.localeCompare(left.connection_ref));
      return { results: rows.slice(0, limit) };
    }
    if (sql.includes("/*md-oauth-connection-read*/")) {
      const row = [...this.oauthGrants.values()].find((item) =>
        item.principal_id === values[0] && item.connection_ref === values[1] && !item.revoked_at);
      return { results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-oauth-connections-list*/")) {
      return {
        results: [...this.oauthGrants.values()]
          .filter((row) => row.principal_id === values[0] && !row.revoked_at)
          .sort((left, right) => String(right.last_used_at ?? right.created_at)
            .localeCompare(String(left.last_used_at ?? left.created_at)))
          .map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-oauth-connection-owner*/")) {
      const row = this.oauthGrants.get(values[0]);
      return {
        results: row && row.principal_id === values[1] && !row.revoked_at
          ? [{ id: row.id }]
          : [],
      };
    }
    if (sql.includes("/*md-metadata-cold-load*/")) {
      this.#assertSchema("metadata");
      const schemaVersion = SITES_METADATA_MIGRATIONS.at(-1)?.version ?? 0;
      const rows = [];
      const baseSequence = this.metadataSnapshotHead?.sequence ??
        this.metadataSnapshot?.sequence ?? 0;
      if (this.metadataSnapshotHead !== null) {
        rows.push(...[...this.metadataSnapshotChunks.values()]
          .filter((row) => row.sequence === this.metadataSnapshotHead.sequence)
          .sort((left, right) => left.chunk_index - right.chunk_index)
          .map((row) => ({
            row_kind: 0,
            sequence: this.metadataSnapshotHead.sequence,
            chunk_count: this.metadataSnapshotHead.chunk_count,
            payload_chars: this.metadataSnapshotHead.payload_chars,
            chunk_index: row.chunk_index,
            target: null,
            operation: null,
            payload_json: row.payload_json,
            schema_version: schemaVersion,
          })));
      } else if (this.metadataSnapshot !== null) {
        rows.push({
          row_kind: 1,
          sequence: this.metadataSnapshot.sequence,
          chunk_count: 1,
          payload_chars: this.metadataSnapshot.payload_json.length,
          chunk_index: 0,
          target: null,
          operation: null,
          payload_json: this.metadataSnapshot.payload_json,
          schema_version: schemaVersion,
        });
      }
      rows.push(...this.metadataEvents
        .filter((row) => row.sequence > baseSequence)
        .map((row) => ({
          row_kind: 2,
          sequence: row.sequence,
          chunk_count: null,
          payload_chars: null,
          chunk_index: null,
          target: row.target,
          operation: row.operation,
          payload_json: row.payload_json,
          schema_version: schemaVersion,
        })));
      if (rows.length === 0) {
        rows.push({
          row_kind: 3,
          sequence: 0,
          chunk_count: null,
          payload_chars: null,
          chunk_index: null,
          target: null,
          operation: null,
          payload_json: "",
          schema_version: schemaVersion,
        });
      }
      return { success: true, results: rows };
    }
    if (sql.includes("/*md-metadata-snapshot-head-read*/")) {
      this.#assertSchema("metadata");
      return {
        success: true,
        results: this.metadataSnapshotHead === null
          ? []
          : [{ ...this.metadataSnapshotHead }],
      };
    }
    if (sql.includes("/*md-metadata-snapshot-chunks-read*/")) {
      this.#assertSchema("metadata");
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
      this.#assertSchema("metadata");
      return {
        success: true,
        results: this.metadataSnapshot === null ? [] : [{ ...this.metadataSnapshot }],
      };
    }
    if (sql.includes("/*md-metadata-append-readback*/")) {
      this.#assertSchema("metadata");
      const row = this.metadataEvents.find((event) =>
        event.sequence === Number(values[0]));
      return { success: true, results: row ? [{ ...row,
        backup_sequence: this.backupControl?.backup_sequence ?? -1 }] : [] };
    }
    if (sql.includes("/*md-metadata-events-tail*/")) {
      this.#assertSchema("metadata");
      return {
        success: true,
        results: this.metadataEvents
          .filter((row) => row.sequence > Number(values[0]))
          .map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-metadata-events-migration*/")) {
      this.#assertSchema("metadata");
      return {
        success: true,
        results: this.metadataEvents.map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-principal-activity-read-one*/")) {
      this.#assertSchema("metadata");
      const row = this.principalActivities.get(values[0]);
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-principal-activity-read-all*/")) {
      this.#assertSchema("metadata");
      return {
        success: true,
        results: [...this.principalActivities.values()].map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-metadata-events*/")) {
      this.#assertSchema("metadata");
      return {
        success: true,
        results: this.metadataEvents.map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-locator-read*/")) {
      const row = this.locatorHandles.get(values[0]);
      return { success: true, results: row ? [structuredClone(row)] : [] };
    }
    if (sql.includes("/*md-search-read-normalized*/")) {
      this.#assertSchema("search");
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
      this.#assertSchema("search");
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
        this.searchLexical.has(`${row.space_id}\u0000${row.digest}`) &&
        this.searchFields.has(`${row.space_id}\u0000${row.digest}`));
      return { success: true, results: [{
        membership_count: memberships.length,
        document_count: memberships.filter((row) =>
          this.searchDocuments.has(`${row.space_id}\u0000${row.digest}`)).length,
        lexical_count: memberships.filter((row) =>
          this.searchLexical.has(`${row.space_id}\u0000${row.digest}`)).length,
        fields_count: memberships.filter((row) =>
          this.searchFields.has(`${row.space_id}\u0000${row.digest}`)).length,
        indexed_count: indexed.length,
      }] };
    }
    if (sql.includes("/*md-search-existing-digests*/")) {
      const requested = new Set(values.slice(1));
      return {
        success: true,
        results: [...this.searchDocuments.values()]
          .filter((row) =>
            row.space_id === values[0] && requested.has(row.digest) &&
            this.searchFields.has(`${row.space_id}\u0000${row.digest}`))
          .map((row) => ({ digest: row.digest })),
      };
    }
    const rankedSearchRows = (spaceId, revisionId, terms) => {
      const columns = [
        ["normalized_title", 8],
        ["normalized_description", 4],
        ["normalized_tags", 6],
        ["normalized_headings", 5],
        ["normalized_body", 1],
      ];
      const occurrences = (value, term) => {
        let count = 0;
        let offset = 0;
        while (count < 20) {
          const found = value.indexOf(term, offset);
          if (found < 0) break;
          count += 1;
          offset = found + Math.max(1, term.length);
        }
        return count;
      };
      return [...this.searchMemberships.values()]
        .filter((row) => row.space_id === spaceId && row.revision_id === revisionId)
        .map((row) => {
          const stored = this.searchFields.get(`${row.space_id}\u0000${row.digest}`);
          return {
            row,
            fields: stored === undefined ? undefined : {
              ...stored,
              normalized_title: stored.title_from_path === 1
                ? row.normalized_path_title
                : stored.normalized_title,
            },
          };
        })
        .filter(({ fields }) => fields !== undefined && terms.every((term) =>
          columns.some(([column]) => fields[column].includes(term))))
        .map(({ row, fields }) => ({
          row,
          score: columns.reduce((total, [column, weight]) =>
            total + terms.reduce((sum, term) =>
              sum + weight * occurrences(fields[column], term), 0), 0),
        }))
        .sort((left, right) =>
          right.score - left.score || left.row.path.localeCompare(right.row.path));
    };
    if (sql.includes("/*md-search-match-count*/")) {
      const terms = JSON.parse(String(values[2]));
      return { success: true, results: [{
        total_matches: rankedSearchRows(values[0], values[1], terms).length,
      }] };
    }
    if (sql.includes("/*md-search-query-normalized*/")) {
      const paged = /\sLIMIT\s/u.test(sql);
      const terms = JSON.parse(String(values[2]));
      const ranked = rankedSearchRows(values[0], values[1], terms);
      const selected = paged
        ? ranked.slice(Number(values.at(-1)), Number(values.at(-1)) + Number(values.at(-2)))
        : ranked;
      const results = selected.map(({ row }) => ({
          path: row.path,
          text: this.searchDocuments.get(`${row.space_id}\u0000${row.digest}`)?.text,
        }));
      return { success: true, results };
    }
    if (sql.includes("/*md-search-count-revisions*/")) {
      const revisions = new Set(
        [...this.searchMemberships.values()]
          .filter((row) => row.space_id === values[0])
          .map((row) => row.revision_id),
      );
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
    this.metadataSnapshot = null;
    this.metadataSnapshotHead = null;
    this.metadataSnapshotChunks.clear();
    this.principalActivities.clear();
    this.localFileUploadIntents.clear();
    this.search.clear();
    this.searchDocuments.clear();
    this.searchMemberships.clear();
    this.searchLexical.clear();
    this.searchFields.clear();
    this.audit.clear();
    this.oauthClients.clear();
    this.oauthRequests.clear();
    this.oauthGrants.clear();
    this.oauthCodes.clear();
    this.oauthAccess.clear();
    this.oauthRefresh.clear();
    this.#appliedSchema.clear();
  }

  inspectOAuthTotals() {
    return Object.freeze({
      clients: this.oauthClients.size,
      requests: this.oauthRequests.size,
      grants: this.oauthGrants.size,
      codes: this.oauthCodes.size,
      access: this.oauthAccess.size,
      refresh: this.oauthRefresh.size,
    });
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
    this.body = new ReadableStream({
      start: (controller) => {
        controller.enqueue(new Uint8Array(this.#bytes));
        controller.close();
      },
    });
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
