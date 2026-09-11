import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { createSitesMetadataStore } from "@mind-diary/adapter-metadata-sites";
import { createSitesObjectStore } from "@mind-diary/adapter-object-sites";
import { REVISION_MANIFEST_MEDIA_TYPE } from "@mind-diary/application-ports";
import {
  REVISION_MANIFEST_FORMAT_V4,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
} from "@mind-diary/domain";
import {
  FILE_INGRESS_WIDGET_URI,
  MCP_APPS_ENDPOINT,
  MCP_APPS_RESOURCE_MIME_TYPE,
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
  metadataSchemaVersion = 4;
  metadataEvents = [];
  metadataTailReads = 0;
  metadataSnapshot = null;
  metadataSnapshotHead = null;
  metadataSnapshotChunks = new Map();
  principalActivities = new Map();
  localFileUploadIntents = new Map();
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
    if (sql.includes("/*md-metadata-migration*/")) {
      this.metadataSchemaVersion = Math.max(this.metadataSchemaVersion, Number(values[0]));
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-upload-intent-create*/")) {
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
      const row = this.localFileUploadIntents.get(values[0]);
      if (!row || row.expires_at !== values[1] || row.expires_at > values[2]) {
        return { success: true, meta: { changes: 0 } };
      }
      this.localFileUploadIntents.delete(values[0]);
      return { success: true, meta: { changes: 1 } };
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
    if (sql.includes("/*md-principal-activity-upsert*/")) {
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
      return {
        success: true,
        meta: { changes: this.principalActivities.delete(values[0]) ? 1 : 0 },
      };
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
    if (sql.includes("/*md-upload-intent-read-namespace*/")) {
      const row = [...this.localFileUploadIntents.values()].find(
        (candidate) => candidate.namespace_hash === values[0],
      );
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-upload-intent-read*/")) {
      const row = this.localFileUploadIntents.get(values[0]);
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-upload-intent-collect-expired*/")) {
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
    if (sql.includes("/*md-metadata-cold-load*/")) {
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
            schema_version: this.metadataSchemaVersion,
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
          schema_version: this.metadataSchemaVersion,
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
          schema_version: this.metadataSchemaVersion,
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
          schema_version: this.metadataSchemaVersion,
        });
      }
      return { success: true, results: rows };
    }
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
      this.metadataTailReads += 1;
      return {
        success: true,
        results: this.metadataEvents
          .filter((row) => row.sequence > Number(values[0]))
          .map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-metadata-append-readback*/")) {
      const row = this.metadataEvents.find((event) =>
        event.sequence === Number(values[0]));
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-metadata-events-migration*/")) {
      return {
        success: true,
        results: this.metadataEvents.map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-principal-activity-read-one*/")) {
      const row = this.principalActivities.get(values[0]);
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-principal-activity-read-all*/")) {
      return {
        success: true,
        results: [...this.principalActivities.values()].map((row) => ({ ...row })),
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

  get body() {
    const bytes = new Uint8Array(this.#bytes);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
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
    let bytes;
    if (value instanceof ReadableStream) {
      const reader = value.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          assert.ok(next.value instanceof Uint8Array);
          const chunk = new Uint8Array(next.value);
          chunks.push(chunk);
          size += chunk.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      bytes = new Uint8Array(value);
    }
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

async function seedMixedExactRevision({
  database,
  bucket,
  spaceId,
  parentRevisionId,
  revisionId,
  committedAt,
}) {
  const metadata = await createSitesMetadataStore(database);
  const objects = await createSitesObjectStore(bucket);
  const parent = await metadata.readRevision(spaceId, parentRevisionId);
  assert.ok(parent);
  const opaqueBytes = new TextEncoder().encode("%PDF-1.7\n% synthetic REST export fixture\n");
  const opaque = await objects.putBundleFile({
    spaceId,
    bytes: opaqueBytes,
    mediaType: "application/pdf",
    createdAt: committedAt,
  });
  const manifest = createRevisionManifest([
    ...parent.manifest.entries,
    {
      kind: "opaque",
      path: "assets/export-proof.pdf",
      sha256: opaque.object.sha256,
      mediaType: opaque.object.mediaType,
      size: opaque.object.size,
    },
  ], REVISION_MANIFEST_FORMAT_V4);
  const manifestBytes = new TextEncoder().encode(serializeRevisionManifest(manifest));
  const manifestObject = await objects.putSpaceCanonicalObject({
    kind: "revision_manifest",
    spaceId,
    bytes: manifestBytes,
    mediaType: REVISION_MANIFEST_MEDIA_TYPE,
    createdAt: committedAt,
  });
  const envelope = createCanonicalRevisionEnvelope({
    revisionId,
    spaceId,
    revisionNumber: parent.revision.revisionNumber + 1,
    parentRevisionId,
    committedAt,
    committedBy: parent.revision.committedBy,
    manifest,
    manifestHash: manifestObject.object.sha256,
    manifestSize: manifestObject.object.size,
    summary: "Synthetic mixed exact-revision REST export fixture",
  });
  const committed = await metadata.commitRevision({
    expectedHeadRevisionId: parentRevisionId,
    envelope,
  });
  assert.equal(committed.kind, "committed");
  return { metadata, envelope };
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

async function legacyTool(runtime, secret, id, progressToken, name, args) {
  const response = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      _meta: { progressToken },
      name,
      arguments: args,
    },
  });
  assert.equal(response.status, 200, name);
  const body = await response.json();
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  assert.equal(body.result?.structuredContent?.ok, true, name);
  return body.result.structuredContent.data;
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

async function appsMcp(runtime, secret, body) {
  const name = body.method === "resources/read"
    ? body.params?.uri
    : body.method === "tools/call"
      ? body.params?.name
      : undefined;
  return responseFrom(runtime, new Request(`${ORIGIN}${MCP_APPS_ENDPOINT}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": body.method,
      "mcp-protocol-version": MCP_TARGET_PROTOCOL,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
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

async function mutateMindUsage(
  runtime,
  csrf,
  mindRef,
  usageMode,
  expectedUsageVersion,
  idempotencyKey,
) {
  const routeRef = mindRef === "/me" ? "me" : mindRef.replace(/^\//u, "");
  return responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/${encodeURIComponent(routeRef)}/usage`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        usage_mode: usageMode,
        expected_usage_version: expectedUsageVersion,
      }),
    },
  ));
}

test("Product Site activates native staging only for an exact verified route composition", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const nativeBytes = Uint8Array.from([0x4d, 0x44, 0x33, 0x31, 0x35]);
  const nativeSha256 = `sha256:${createHash("sha256").update(nativeBytes).digest("hex")}`;
  const baseOptions = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "native.route.e2e@example.com",
          verifiedFullName: "Native Route E2E",
        };
      },
    },
    tokenVerifierKey: key(24),
    locatorKey: key(64),
    exportDownloadVerifierKey: key(104),
    csrfKey: key(144),
    now: () => new Date("2026-08-28T00:10:00.000Z"),
    observabilityWriter: { write() {} },
    schedule() {},
  };

  await assert.rejects(
    createProductSiteRuntime({
      ...baseOptions,
      verifiedNativeFileParameterRoute: {
        mcpProfiles: ["modern"],
        assertion: {
          profileId: "test-product-site-native-v1",
          assertionId: "test-receipt:product-site-native:v1",
          observedAtUtc: "invalid",
          toolName: "stage_bundle_file",
          parameterName: "file",
          sourceKind: "session_attachment",
          transport: "native_file_parameter",
        },
      },
    }),
    /exact host rewrite assertion/u,
  );
  await assert.rejects(
    createProductSiteRuntime({
      ...baseOptions,
      verifiedNativeFileParameterRoute: {
        mcpProfiles: [],
        assertion: {
          profileId: "test-product-site-native-v1",
          assertionId: "test-receipt:product-site-native:v1",
          observedAtUtc: "2026-08-28T00:00:00.000Z",
          toolName: "stage_bundle_file",
          parameterName: "file",
          sourceKind: "session_attachment",
          transport: "native_file_parameter",
        },
      },
    }),
    /exact unique MCP profiles/u,
  );

  const directRuntime = await createProductSiteRuntime(baseOptions);
  const registration = await responseFrom(directRuntime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrap = await responseFrom(directRuntime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:native-route-e2e",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrap.status, 200);

  const settings = await responseFrom(
    directRuntime,
    new Request(`${ORIGIN}/settings/developer/mcp`),
  );
  const settingsCsrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(directRuntime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": settingsCsrf,
      "idempotency-key": "token:native-route-e2e",
    },
    body: JSON.stringify({ name: "Native route E2E", scopes: ["content:write"] }),
  }));
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  const secret = issuedBody.data.secret;
  const selected = await mutateMindUsage(
    directRuntime,
    settingsCsrf,
    "/me",
    "read_write",
    0,
    "usage:native-route-e2e",
  );
  assert.equal(selected.status, 200, await selected.clone().text());

  const meta = {
    "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
    "io.modelcontextprotocol/clientInfo": {
      name: "mind-diary-native-route-e2e",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const listTools = async (runtime, id) => {
    const response = await modernMcp(runtime, secret, {
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: { _meta: meta },
    });
    assert.equal(response.status, 200);
    return (await response.json()).result.tools;
  };

  const exactStageArguments = {
    mind: "/me",
    file: {
      file_id: "provider-issued-test-file",
      download_url: "https://files.oaiusercontent.com/file/native-route-test",
      file_name: "fixture.bin",
      mime_type: "application/octet-stream",
    },
    idempotency_key: "stage:native-route-e2e",
    expected_size: nativeBytes.byteLength,
    expected_sha256: nativeSha256,
  };
  const directTools = await listTools(directRuntime, "native-direct-list");
  assert.equal(directTools.some(({ name }) => name === "stage_bundle_file"), false);
  const directStage = await modernMcp(directRuntime, secret, {
    jsonrpc: "2.0",
    id: "native-direct-stage",
    method: "tools/call",
    params: {
      name: "stage_bundle_file",
      arguments: exactStageArguments,
      _meta: meta,
    },
  });
  const directStageBody = await directStage.json();
  assert.equal(directStageBody.result.isError, true);
  assert.equal(
    directStageBody.result.structuredContent.error.code,
    "native_file_input_unsupported",
  );

  const appsList = await appsMcp(directRuntime, secret, {
    jsonrpc: "2.0",
    id: "native-apps-list",
    method: "tools/list",
    params: { _meta: meta },
  });
  assert.equal(appsList.status, 200);
  const appsTools = (await appsList.json()).result.tools;
  assert.equal(appsTools.some(({ name }) => name === "open_bundle_file_picker"), true);
  assert.equal(appsTools.some(({ name }) => name === "stage_bundle_file"), true);

  const appsCapabilities = await appsMcp(directRuntime, secret, {
    jsonrpc: "2.0",
    id: "native-apps-capabilities",
    method: "tools/call",
    params: {
      name: "get_file_ingress_capabilities",
      arguments: {},
      _meta: meta,
    },
  });
  assert.equal(appsCapabilities.status, 200);
  assert.deepEqual(
    (await appsCapabilities.json()).result.structuredContent.data.native_file_parameter,
    {
      source_kind: "session_attachment",
      transport: "native_file_parameter",
      status: "available",
      route_profile_id: "openai-mcp-apps-v1",
      verification_status: "declared_unverified",
      host_rewrite_assertion_id: null,
      host_rewrite_observed_at_utc: null,
    },
  );

  const appsResource = await appsMcp(directRuntime, secret, {
    jsonrpc: "2.0",
    id: "native-apps-resource",
    method: "resources/read",
    params: { uri: FILE_INGRESS_WIDGET_URI, _meta: meta },
  });
  assert.equal(appsResource.status, 200);
  const appsResourceBody = await appsResource.json();
  assert.equal(appsResourceBody.result.contents[0].mimeType, MCP_APPS_RESOURCE_MIME_TYPE);
  assert.equal(appsResourceBody.result.contents[0]._meta.ui.prefersBorder, true);

  let nativeFetches = 0;
  let nativeFetchRequest = null;
  const configuredRuntime = await createProductSiteRuntime({
    ...baseOptions,
    verifiedNativeFileParameterRoute: {
      mcpProfiles: ["modern"],
      assertion: {
        profileId: "test-product-site-native-v1",
        assertionId: "test-receipt:product-site-native:v1",
        observedAtUtc: "2026-08-28T00:00:00.000Z",
        toolName: "stage_bundle_file",
        parameterName: "file",
        sourceKind: "session_attachment",
        transport: "native_file_parameter",
      },
      async fetcher(input, init) {
        nativeFetches += 1;
        nativeFetchRequest = { input: String(input), init };
        return new Response(nativeBytes, { status: 200 });
      },
    },
  });
  const configuredTools = await listTools(configuredRuntime, "native-configured-list");
  const stageDefinition = configuredTools.find(({ name }) => name === "stage_bundle_file");
  assert.deepEqual(stageDefinition._meta, {
    "openai/fileParams": ["file"],
  });

  const legacyInitialize = await legacyMcp(configuredRuntime, secret, {
    jsonrpc: "2.0",
    id: "native-compat-initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "native-route-compat-test", version: "0.0.0" },
    },
  });
  assert.equal(legacyInitialize.status, 200);
  const legacyList = await legacyMcp(configuredRuntime, secret, {
    jsonrpc: "2.0",
    id: "native-compat-list",
    method: "tools/list",
    params: {},
  });
  const legacyTools = (await legacyList.json()).result.tools;
  assert.equal(legacyTools.some(({ name }) => name === "stage_bundle_file"), false);

  const capabilities = await modernTool(
    configuredRuntime,
    secret,
    "native-configured-capabilities",
    "get_file_ingress_capabilities",
    {},
  );
  assert.deepEqual(capabilities.native_file_parameter, {
    source_kind: "session_attachment",
    transport: "native_file_parameter",
    status: "available",
    route_profile_id: "test-product-site-native-v1",
    verification_status: "verified",
    host_rewrite_assertion_id: "test-receipt:product-site-native:v1",
    host_rewrite_observed_at_utc: "2026-08-28T00:00:00.000Z",
  });

  const staged = await modernTool(
    configuredRuntime,
    secret,
    "native-configured-stage",
    "stage_bundle_file",
    exactStageArguments,
  );
  assert.equal(nativeFetches, 1);
  assert.equal(nativeFetchRequest.input, exactStageArguments.file.download_url);
  assert.equal(nativeFetchRequest.init.credentials, "omit");
  assert.equal(nativeFetchRequest.init.redirect, "manual");
  assert.equal(nativeFetchRequest.init.cache, "no-store");
  assert.equal(nativeFetchRequest.init.referrerPolicy, "no-referrer");
  assert.equal(staged.staged_file.sha256, nativeSha256);
  assert.equal(staged.staged_file.size, nativeBytes.byteLength);
  assert.equal(staged.staged_file.display_filename, "fixture.bin");
  assert.doesNotMatch(
    JSON.stringify(staged),
    /provider-issued-test-file|native-route-test|download_url|file_id/iu,
  );

  const reconciled = await modernTool(
    configuredRuntime,
    secret,
    "native-configured-reconcile",
    "reconcile_file_stage",
    {
      mind: "/me",
      source_kind: "session_attachment",
      display_filename: staged.staged_file.display_filename,
      claimed_media_type: "application/octet-stream",
      media_type: staged.staged_file.media_type,
      sha256: staged.staged_file.sha256,
      size: staged.staged_file.size,
      idempotency_key: exactStageArguments.idempotency_key,
      expected_size: exactStageArguments.expected_size,
      expected_sha256: exactStageArguments.expected_sha256,
    },
  );
  assert.equal(reconciled.status, "staged");
  assert.equal(
    reconciled.staged_file.staged_file_ref,
    staged.staged_file.staged_file_ref,
  );
});

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
  const deferredActivity = [];
  const listed = await modernMcp({
    fetch: (request) => runtime.fetch(request, (promise) => deferredActivity.push(promise)),
  }, secret, {
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
  assert.equal(deferredActivity.length, 1);
  await Promise.all(deferredActivity);

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
  const issuedBody = await issued.json();
  const secret = issuedBody.data.secret;
  const starterSession = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/session`));
  assert.equal(starterSession.status, 200);
  const disabledPersonalRevisionId = (await starterSession.json()).data.personal_mind.head_revision_id;

  const minds = await modernTool(
    runtime,
    secret,
    "starter-list",
    "list_minds",
    {},
    "benchmark_starter_list",
  );
  assert.deepEqual(minds.minds, []);
  const disabledRead = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-disabled-read",
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
  assert.equal(disabledRead.status, 200);
  const disabledReadBody = await disabledRead.json();
  assert.equal(disabledReadBody.result.isError, true);
  assert.equal(disabledReadBody.result.structuredContent.error.code, "mind_not_found");
  const disabledCommit = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-disabled-commit",
    method: "tools/call",
    params: {
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        expected_revision: disabledPersonalRevisionId,
        idempotency_key: "commit:starter-disabled",
        summary: "Must not commit while the principal mode is disabled",
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
  assert.equal(disabledCommit.status, 200);
  const disabledCommitBody = await disabledCommit.json();
  assert.equal(disabledCommitBody.result.isError, true);
  assert.equal(
    disabledCommitBody.result.structuredContent.error.code,
    "writable_mind_required",
  );
  const selectedUsage = await mutateMindUsage(
    runtime,
    settingsCsrf,
    "/me",
    "read_write",
    0,
    "usage:starter-e2e",
  );
  assert.equal(selectedUsage.status, 200, await selectedUsage.clone().text());
  const enabledMinds = await modernTool(
    runtime,
    secret,
    "starter-list-enabled",
    "list_minds",
    {},
  );
  const personal = enabledMinds.minds.find(({ route }) => route === "/me");
  assert.ok(personal);
  assert.equal(personal.description, null);
  assert.equal(personal.routing_profile, "personal_default");
  assert.equal(personal.usage_mode, "read_write");

  const unboundExport = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": settingsCsrf,
        "idempotency-key": "export:starter-disabled-mode",
      },
      body: JSON.stringify({
        revision_selector: {
          kind: "revision",
          revision_id: personal.head.revision_id,
        },
      }),
    },
  ));
  assert.equal(unboundExport.status, 202);
  const unboundExportBody = await unboundExport.json();
  assert.equal(unboundExportBody.ok, true);
  assert.equal(unboundExportBody.data.job.revision_id, personal.head.revision_id);
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
  const warningCommit = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-producer-warning",
    method: "tools/call",
    params: {
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        expected_revision: initialRevisionId,
        idempotency_key: "commit:starter-producer-warning",
        summary: "Reject warning-bearing generated OKF",
        operations: [{
          type: "create_file",
          path: "concepts/generated-warning.md",
          text: "---\ntype: Generated Knowledge\nstatus: reviewed\n---\n\n# Warning\n",
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
  const warningCommitBody = await warningCommit.json();
  assert.equal(warningCommit.status, 200, JSON.stringify(warningCommitBody));
  assert.equal(warningCommitBody.result.isError, true);
  assert.equal(
    warningCommitBody.result.structuredContent.error.code,
    "okf_validation_failed",
  );
  const afterWarning = await modernTool(
    runtime,
    secret,
    "starter-list-after-producer-warning",
    "list_minds",
    {},
  );
  assert.equal(
    afterWarning.minds.find(({ route }) => route === "/me").head.revision_id,
    initialRevisionId,
  );
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
    return {
      type: "create_file",
      path: file.path,
      text: file.path === "concepts/first-memory.md"
        ? file.text.replace(
            /^---\n/u,
            "---\nfooBar: camel-case\nfoo_bar: snake-case\nwireShape:\n  fooBar: camel-case\n  foo_bar: snake-case\n",
          )
        : file.text,
    };
  });
  const committed = await modernTool(
    runtime,
    secret,
    "starter-commit",
    "commit_changeset",
    {
      mind: "/me",
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

  const telemetryBeforeRequestRecovery = telemetryLines.length;
  const requestRecovery = await runtime.recoverBackground(1, "request");
  assert.equal(requestRecovery.failed, 0);
  const requestRecoveryOperations = telemetryLines
    .slice(telemetryBeforeRequestRecovery)
    .map((line) => JSON.parse(line).operation)
    .filter((operation) => operation?.startsWith("recovery_"));
  assert.deepEqual(
    requestRecoveryOperations.sort(),
    [
      "recovery_index_dispatch",
      "recovery_index_gaps",
      "recovery_invitation_expiry_dispatch",
      "recovery_total",
    ].sort(),
  );

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

  const tailReadsBeforeBrowse = database.metadataTailReads;
  const browsed = await modernTool(
    runtime,
    secret,
    "starter-browse-index",
    "browse_entries",
    { mind: "/me", revision_selector: { kind: "revision", revision_id: starterRevisionId } },
  );
  assert.equal(database.metadataTailReads - tailReadsBeforeBrowse, 2);
  const indexEntry = browsed.entries.find(({ path }) => path === "index.md");
  assert.ok(indexEntry);
  const listedFiles = await modernTool(
    runtime,
    secret,
    "starter-list-files",
    "list_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: starterRevisionId },
      include_globs: ["**/*.md"],
      aggregate: { kind: "count" },
    },
  );
  assert.deepEqual(listedFiles.files.map(({ path }) => path), [
    "concepts/first-memory.md",
    "index.md",
    "log.md",
  ]);
  assert.equal(listedFiles.aggregate.count, 3);
  const metadataWireShape = await modernTool(
    runtime,
    secret,
    "starter-list-files-metadata-wire-shape",
    "list_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: starterRevisionId },
      paths: ["concepts/first-memory.md"],
      where: {
        field: "metadata.wireShape",
        op: "eq",
        value: { fooBar: "camel-case", foo_bar: "snake-case" },
      },
      select_metadata_fields: [
        "metadata.fooBar",
        "metadata.foo_bar",
        "metadata.wireShape",
      ],
      aggregate: { kind: "distinct", field: "metadata.wireShape" },
    },
  );
  assert.deepEqual(metadataWireShape.files.map(({ path, metadata }) => ({ path, metadata })), [{
    path: "concepts/first-memory.md",
    metadata: {
      "metadata.fooBar": "camel-case",
      "metadata.foo_bar": "snake-case",
      "metadata.wireShape": { fooBar: "camel-case", foo_bar: "snake-case" },
    },
  }]);
  assert.deepEqual(metadataWireShape.aggregate, {
    kind: "distinct",
    field: "metadata.wireShape",
    values: [{ fooBar: "camel-case", foo_bar: "snake-case" }],
  });
  const greppedFiles = await modernTool(
    runtime,
    secret,
    "starter-grep-files",
    "grep_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: starterRevisionId },
      paths: ["concepts/first-memory.md"],
      patterns: ["concrete fact", "reusable note"],
      output: "count",
      count_unit: "occurrences",
    },
  );
  assert.equal(greppedFiles.count_unit, "occurrences");
  assert.equal(greppedFiles.files[0].count, 3);
  const rangedFiles = await modernTool(
    runtime,
    secret,
    "starter-read-files",
    "read_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: starterRevisionId },
      requests: [
        { path: "index.md", mode: "head", count: 3 },
        { path: "log.md", mode: "lines", start_line: 1, end_line: 3 },
      ],
    },
  );
  assert.equal(rangedFiles.items.length, 2);
  assert.match(rangedFiles.items[0].file.text, /okf_version/u);
  assert.match(rangedFiles.items[1].file.text, /# Log/u);
  const tailReadsBeforeFetch = database.metadataTailReads;
  const locatorHandlesBeforeFetch = database.locatorHandles.size;
  const fetchedIndex = await modernTool(
    runtime,
    secret,
    "starter-fetch-index",
    "fetch",
    { id: indexEntry.entry_id },
  );
  assert.equal(database.metadataTailReads - tailReadsBeforeFetch, 2);
  assert.equal(database.locatorHandles.size, locatorHandlesBeforeFetch);
  assert.equal(fetchedIndex.entry.entry_id, indexEntry.entry_id);
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

  const tailReadsBeforeRepeatedSearch = database.metadataTailReads;
  await modernTool(
    runtime,
    secret,
    "starter-search-again",
    "search",
    { mind: "/me", query: "concrete reusable note" },
  );
  assert.equal(database.metadataTailReads - tailReadsBeforeRepeatedSearch, 2);
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
    "recovery_invitation_expiry_dispatch",
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

  const exportStartedResponse = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": settingsCsrf,
        "idempotency-key": "export:starter-before-disable",
      },
      body: JSON.stringify({
        revision_selector: {
          kind: "revision",
          revision_id: starterRevisionId,
        },
      }),
    },
  ));
  assert.equal(exportStartedResponse.status, 202);
  const exportStarted = (await exportStartedResponse.json()).data;

  const clearedTarget = await mutateMindUsage(
    runtime,
    settingsCsrf,
    "/me",
    "disabled",
    1,
    "usage:starter-disabled",
  );
  assert.equal(clearedTarget.status, 200, await clearedTarget.clone().text());
  const disabledFetch = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-fetch-after-disable",
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
  assert.equal(disabledFetch.status, 200);
  const disabledFetchBody = await disabledFetch.json();
  assert.equal(disabledFetchBody.result.isError, true);
  assert.equal(disabledFetchBody.result.structuredContent.error.code, "locator_not_found");
  const disabledResources = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "starter-resources-after-disable",
    method: "resources/list",
    params: {
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
  assert.equal(disabledResources.status, 200);
  const disabledResourcesBody = await disabledResources.json();
  assert.deepEqual(disabledResourcesBody.result.resources, []);
  const detachedExportStatus = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/export-jobs/${encodeURIComponent(exportStarted.job.job_id)}`,
  ));
  assert.equal(detachedExportStatus.status, 200);
  const detachedExportStatusBody = await detachedExportStatus.json();
  assert.equal(detachedExportStatusBody.ok, true);
  assert.equal(detachedExportStatusBody.data.job.revision_id, starterRevisionId);
});

test("durable Product Site controls account-wide Mind usage with CAS, shared credentials, and revoke fencing", async () => {
  let currentTime = new Date("2026-08-22T11:00:00.000Z");
  const runtime = await createProductSiteRuntime({
    database: new FakeD1Database(),
    bucket: new FakeR2Bucket(),
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "web.usage.e2e@example.com",
          verifiedFullName: "Web Usage E2E",
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
      "idempotency-key": "bootstrap:web-usage-e2e",
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
      "idempotency-key": "token:web-usage-e2e",
    },
    body: JSON.stringify({ name: "Web usage token", scopes: ["content:write"] }),
  }));
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  const personalTokenRef = issuedBody.data.token.personal_token_ref;
  const secret = issuedBody.data.secret;
  assert.match(personalTokenRef, /^ptok_v1_[0-9a-f]{32}$/u);
  assert.equal(JSON.stringify(issuedBody).includes("token_id"), false);

  const emptyPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const emptyHtml = await emptyPage.text();
  assert.match(emptyHtml, /Web usage token/u);
  assert.match(emptyHtml, /Account-wide Mind modes/u);
  assert.match(emptyHtml, /does not own separate Mind choices/u);
  assert.match(emptyHtml, /Manage Mind modes/u);
  assert.doesNotMatch(emptyHtml, /data-target-version|Writable target|Automatic knowledge capture/u);

  const mutate = (body, idempotencyKey) => responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/usage`,
    {
      method: "PUT",
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
    usage_mode: "read_write",
    expected_usage_version: 0,
  }, "usage:web-enable-write");
  assert.equal(bound.status, 200, await bound.clone().text());
  const boundBody = await bound.json();
  assert.equal(boundBody.data.changed, true);
  assert.equal(boundBody.data.replayed, false);
  assert.equal(boundBody.data.projection.usage_version, 1);
  assert.equal(boundBody.data.projection.items[0].usage_mode, "read_write");

  const boundPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const boundHtml = await boundPage.text();
  assert.match(boundHtml, /Account-wide Mind modes/u);
  assert.doesNotMatch(boundHtml, /Writable target|data-binding-action|data-target-version/u);
  assert.doesNotMatch(boundHtml, /principal_|space_personal/u);

  assert.equal(boundBody.data.projection.items[0].mind_ref, "/me");
  assert.equal(JSON.stringify(boundBody).includes("space_id"), false);

  const stale = await mutate({
    usage_mode: "disabled",
    expected_usage_version: 0,
  }, "usage:web-stale");
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "usage_conflict");

  const unknownField = await mutate({
    usage_mode: "disabled",
    expected_usage_version: 1,
    principal_id: "must-not-be-accepted",
  }, "usage:web-unknown-field");
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).error.code, "invalid_request");

  const readOnlyIssued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:web-usage-read-only",
    },
    body: JSON.stringify({ name: "Read-only usage token", scopes: ["content:read"] }),
  }));
  assert.equal(readOnlyIssued.status, 200);
  const readOnlyIssuedBody = await readOnlyIssued.json();
  const readOnlySecret = readOnlyIssuedBody.data.secret;
  const readOnlyMinds = await modernTool(
    runtime,
    readOnlySecret,
    "shared-usage-read-only-list",
    "list_minds",
    {},
  );
  const sharedPersonal = readOnlyMinds.minds.find(({ route }) => route === "/me");
  assert.ok(sharedPersonal);
  assert.equal(sharedPersonal.usage_mode, "read_write");
  assert.equal(sharedPersonal.effective.can_write, false);
  const readOnlyWrite = await modernMcp(runtime, readOnlySecret, {
    jsonrpc: "2.0",
    id: "shared-usage-read-only-write",
    method: "tools/call",
    params: {
      name: "commit_changeset",
      arguments: {
        mind: "/me",
        expected_revision: sharedPersonal.head.revision_id,
        idempotency_key: "commit:shared-usage-read-only-denied",
        summary: "Credential scope must still deny this write",
        operations: [],
      },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-shared-usage-e2e",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(readOnlyWrite.status, 200);
  const readOnlyWriteBody = await readOnlyWrite.json();
  assert.equal(readOnlyWriteBody.result.isError, true);
  assert.equal(readOnlyWriteBody.result.structuredContent.error.code, "insufficient_scope");
  const readOnlyPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const readOnlyHtml = await readOnlyPage.text();
  const panelFor = (html, tokenName) => {
    const marker = `<h3>${tokenName}</h3>`;
    const markerStart = html.indexOf(marker);
    assert.notEqual(markerStart, -1, `missing personal-token panel for ${tokenName}`);
    const articleStart = html.lastIndexOf("<article", markerStart);
    const articleEnd = html.indexOf("</article>", markerStart);
    assert.notEqual(articleStart, -1);
    assert.notEqual(articleEnd, -1);
    return html.slice(articleStart, articleEnd + "</article>".length);
  };
  assert.doesNotMatch(readOnlyHtml, /data-personal-token-ref/u);
  const readOnlyPanel = panelFor(readOnlyHtml, "Read-only usage token");
  assert.match(readOnlyPanel, /This token can read\. It cannot write/u);
  assert.match(readOnlyPanel, /Account-wide Mind modes/u);
  assert.doesNotMatch(readOnlyPanel, /data-access-action|Select one writable Mind/u);

  const revoked = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}`,
    {
      method: "DELETE",
      headers: {
        origin: ORIGIN,
        "x-csrf-token": csrf,
        "idempotency-key": "revoke:web-usage-e2e",
      },
    },
  ));
  assert.equal(revoked.status, 200);
  const revokedPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp?state=revoked`));
  const revokedHtml = await revokedPage.text();
  assert.match(revokedHtml, /Web usage token/u);
  const revokedPanel = panelFor(revokedHtml, "Web usage token");
  assert.doesNotMatch(revokedPanel, /data-access-form|data-access-action/u);

  const revokedCredential = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "shared-usage-revoked-write-token",
    method: "tools/list",
    params: { _meta: {} },
  });
  assert.equal(revokedCredential.status, 401);
  assert.equal((await revokedCredential.json()).code, "authentication_required");
  const stillShared = await modernTool(
    runtime,
    readOnlySecret,
    "shared-usage-after-other-revoke",
    "list_minds",
    {},
  );
  assert.equal(stillShared.minds.some(({ route }) => route === "/me"), true);

  currentTime = new Date("2027-01-22T11:00:00.000Z");
  const expiredPage = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp?state=expired`));
  const expiredHtml = await expiredPage.text();
  const expiredReadOnlyPanel = panelFor(expiredHtml, "Read-only usage token");
  assert.match(expiredReadOnlyPanel, /expired/u);
  assert.doesNotMatch(expiredReadOnlyPanel, /data-access-form|data-access-action/u);
  const expiredCredential = await modernMcp(runtime, readOnlySecret, {
    jsonrpc: "2.0",
    id: "shared-usage-expired-read-token",
    method: "tools/list",
    params: { _meta: {} },
  });
  assert.equal(expiredCredential.status, 401);
  assert.equal((await expiredCredential.json()).code, "authentication_required");
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

  const tailReadsBeforePersonalPage = database.metadataTailReads;
  const deferredPersonalActivity = [];
  const personalPage = await runtime.fetch(
    new Request(`${ORIGIN}/me`),
    (promise) => { deferredPersonalActivity.push(promise); },
  );
  assert.ok(personalPage instanceof Response);
  assert.equal(personalPage.status, 200);
  assert.match(await personalPage.text(), /<h1>My Mind<\/h1>/u);
  assert.equal(deferredPersonalActivity.length, 1);
  await Promise.all(deferredPersonalActivity);
  assert.equal(database.metadataTailReads - tailReadsBeforePersonalPage, 1);

  const tailReadsBeforeInvitationsPage = database.metadataTailReads;
  const deferredInvitationsActivity = [];
  const invitationsPage = await runtime.fetch(
    new Request(`${ORIGIN}/invitations`),
    (promise) => { deferredInvitationsActivity.push(promise); },
  );
  assert.ok(invitationsPage instanceof Response);
  assert.equal(invitationsPage.status, 200);
  assert.match(await invitationsPage.text(), /data-people-collection/u);
  const invitationOverview = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/invitations-overview`),
  );
  assert.equal(invitationOverview.status, 200);
  const invitationOverviewBody = await invitationOverview.json();
  assert.deepEqual(invitationOverviewBody.data.invitations, []);
  assert.equal(deferredInvitationsActivity.length, 1);
  await Promise.all(deferredInvitationsActivity);
  // Page read, expiry reconciliation, consistent overview read, and deferred activity.
  assert.equal(database.metadataTailReads - tailReadsBeforeInvitationsPage, 4);

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
  assert.match(codexHelpHtml, /data-codex-client-tab="desktop"/u);
  assert.match(codexHelpHtml, /data-codex-client-tab="cli"/u);
  assert.match(codexHelpHtml, /https:\/\/github\.com\/xxsrez\/marketplace/u);
  assert.match(
    codexHelpHtml,
    /Use Mind Diary to list the Minds I can read\. Do not create or change any Memory\./u,
  );
  assert.match(codexHelpHtml, /Choose readable Minds and start/u);
  assert.match(codexHelpHtml, /only enabled Minds that still pass current rights and credential scope checks/u);
  assert.match(codexHelpHtml, /Writing is optional/u);
  assert.match(codexHelpHtml, /choose Read and write independently for every ordinary or Personal Mind/u);
  assert.match(codexHelpHtml, /This account-wide set is shared by every Connection and personal token/u);
  assert.match(codexHelpHtml, /automatically save each durable fact or decision discussed now to every matching Mind/u);
  assert.match(codexHelpHtml, /Refresh list_minds before writing/u);
  assert.match(codexHelpHtml, /Updating this help page does not replace Custom Instructions you already saved/u);
  assert.match(codexHelpHtml, /Copy isolated routing check/u);
  assert.doesNotMatch(codexHelpHtml, /\b(?:bind|unbind)\b|writable target|attach at least one Mind/iu);
  assert.doesNotMatch(codexHelpHtml, /This instruction permits reading, not writing|at most one ordinary Mind/u);
  assert.match(codexHelpHtml, /Create the first useful Memory/u);
  assert.match(codexHelpHtml, /href="\/me#first-result-title">Open the starter card/u);

  const createdMind = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registeredCsrf,
      "idempotency-key": "mind:product-runtime-e2e",
    },
    body: JSON.stringify({
      name: "Runtime Shared",
      handle: "runtime-shared",
      description: "  Runtime Ｍind\r\ndescription  ",
    }),
  }));
  assert.equal(createdMind.status, 200);
  const createdMindBody = await createdMind.json();
  assert.equal(createdMindBody.data.route, "/runtime-shared");
  assert.equal(createdMindBody.data.description, "Runtime Mind\ndescription");

  const rejectedPersonalCreate = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "mind:rejected-personal-description",
      },
      body: JSON.stringify({
        name: "Injected Personal",
        handle: "injected-personal",
        description: "Must not exist",
        is_personal: true,
      }),
    },
  ));
  assert.equal(rejectedPersonalCreate.status, 400);
  assert.equal((await rejectedPersonalCreate.json()).error.code, "invalid_request");

  runtime = await createProductSiteRuntime(runtimeOptions);
  const reconstructedMinds = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds`),
  );
  assert.equal(reconstructedMinds.status, 200);
  const reconstructedMindsBody = await reconstructedMinds.json();
  assert.deepEqual(
    reconstructedMindsBody.data.map(({ route }) => route),
    ["/me", "/runtime-shared"],
  );
  assert.equal(reconstructedMindsBody.data[0].description, null);
  assert.equal(
    reconstructedMindsBody.data[1].description,
    "Runtime Mind\ndescription",
  );
  const reconstructedExact = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/runtime-shared`),
  );
  assert.equal(reconstructedExact.status, 200);
  const reconstructedExactBody = await reconstructedExact.json();
  assert.equal(reconstructedExactBody.data.access.role, "owner");
  assert.equal(reconstructedExactBody.data.description, "Runtime Mind\ndescription");

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
        description: "Updated runtime description",
        expected_metadata_version: reconstructedExactBody.data.metadata_version,
      }),
    },
  ));
  assert.equal(renamedMind.status, 200);
  const renamedMindBody = await renamedMind.json();
  assert.equal(renamedMindBody.data.name, "Runtime Library");
  assert.equal(renamedMindBody.data.description, "Updated runtime description");
  assert.equal(
    renamedMindBody.data.metadata_version,
    reconstructedExactBody.data.metadata_version + 1,
  );
  assert.equal(
    renamedMindBody.data.access_version,
    createdMindBody.data.access_version,
  );
  assert.equal(renamedMindBody.data.route, "/runtime-shared");
  assert.equal(renamedMindBody.data.head_revision_id, reconstructedExactBody.data.head_revision_id);

  const noOpDescription = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/runtime-shared`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "description-no-op:product-runtime-e2e",
      },
      body: JSON.stringify({
        description: " Updated runtime description ",
        expected_metadata_version: renamedMindBody.data.metadata_version,
      }),
    },
  ));
  assert.equal(noOpDescription.status, 200);
  const noOpDescriptionBody = await noOpDescription.json();
  assert.equal(
    noOpDescriptionBody.data.metadata_version,
    renamedMindBody.data.metadata_version,
  );
  assert.equal(
    noOpDescriptionBody.data.head_revision_id,
    reconstructedExactBody.data.head_revision_id,
  );

  const personalDescription = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "description-personal:product-runtime-e2e",
      },
      body: JSON.stringify({
        description: "Must stay absent",
        expected_metadata_version: sessionBody.data.personal_mind.metadata_version,
      }),
    },
  ));
  assert.equal(personalDescription.status, 403);
  assert.equal(
    (await personalDescription.json()).error.code,
    "personal_mind_operation_forbidden",
  );

  runtime = await createProductSiteRuntime(runtimeOptions);
  const renamedAfterRestart = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/minds/runtime-shared`),
  );
  assert.equal(renamedAfterRestart.status, 200);
  const renamedAfterRestartBody = await renamedAfterRestart.json();
  assert.equal(renamedAfterRestartBody.data.name, "Runtime Library");
  assert.equal(
    renamedAfterRestartBody.data.description,
    "Updated runtime description",
  );
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
  assert.match(exactManagementHtml, /Updated runtime description/u);
  assert.match(exactManagementHtml, /id="ordinary-mind-edit-description"/u);
  assert.match(exactManagementHtml, /Save metadata/u);
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
  const enabledOrdinary = await mutateMindUsage(
    runtime,
    registeredCsrf,
    "/runtime-shared",
    "read",
    0,
    "usage:product-runtime-shared-read",
  );
  assert.equal(enabledOrdinary.status, 200, await enabledOrdinary.clone().text());
  const enabledPersonal = await mutateMindUsage(
    runtime,
    registeredCsrf,
    "/me",
    "read_write",
    1,
    "usage:product-runtime-personal-write",
  );
  assert.equal(enabledPersonal.status, 200, await enabledPersonal.clone().text());

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
  assert.equal(ordinaryMind.description, "Updated runtime description");
  assert.equal(ordinaryMind.routing_profile, "description_based");
  assert.equal(ordinaryMind.usage_mode, "read");
  const personalMind = listedBody.result.structuredContent.data.minds.find(
    ({ route }) => route === "/me",
  );
  assert.ok(personalMind);
  assert.equal(personalMind.route, "/me");
  assert.equal(personalMind.discovery, "personal");
  assert.equal(personalMind.description, null);
  assert.equal(personalMind.routing_profile, "personal_default");
  assert.equal(personalMind.usage_mode, "read_write");
  assert.equal(
    typeof personalMind.head.revision_id,
    "string",
    JSON.stringify(personalMind),
  );

  const compatibilityRevision = personalMind.head.revision_id;
  const compatibilityList = await legacyTool(
    runtime,
    secret,
    "compatibility-list-files",
    20,
    "list_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: compatibilityRevision },
      include_globs: ["**/*.md"],
    },
  );
  assert.ok(compatibilityList.files.some(({ path }) => path === "index.md"));
  const compatibilityGrep = await legacyTool(
    runtime,
    secret,
    "compatibility-grep-files",
    21,
    "grep_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: compatibilityRevision },
      paths: ["index.md"],
      patterns: ["first Memory"],
      output: "files_with_matches",
    },
  );
  assert.deepEqual(compatibilityGrep.files.map(({ path }) => path), ["index.md"]);
  const compatibilityRead = await legacyTool(
    runtime,
    secret,
    "compatibility-read-files",
    22,
    "read_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: compatibilityRevision },
      requests: [{ path: "index.md", mode: "head", count: 2 }],
    },
  );
  assert.equal(compatibilityRead.items.length, 1);
  assert.match(compatibilityRead.items[0].file.text, /okf_version/u);

  const previousRevisionId = compatibilityRevision;
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
  assert.equal(
    committedBody.result.structuredContent.data.previous_revision_id,
    previousRevisionId,
  );
  assert.equal(committedBody.result.structuredContent.data.index_status, "queued");
  assert.equal(committedBody.result.structuredContent.data.replayed, false);
  const committedIndexWork = scheduled.findLast((work) => work.kind === "revision_index");
  assert.ok(committedIndexWork);
  await runtime.recoverBackground();

  const scheduledCountBeforeReplay = scheduled.length;
  const replay = await legacyMcp(runtime, secret, {
    jsonrpc: "2.0", id: "commit-replay-after-index", method: "tools/call",
    params: { name: "commit_changeset", arguments: {
      mind: "/me", expected_revision: previousRevisionId,
      idempotency_key: "commit:product-runtime-e2e",
      summary: "Prove production transaction authorization",
      operations: [{ type: "create_file", path: "concepts/runtime-proof.md",
        text: "---\ntype: Reference\n---\n\nRuntime authorization proof.\n" }],
    } },
  });
  const replayData = (await replay.json()).result.structuredContent.data;
  assert.equal(replayData.replayed, true);
  assert.equal(replayData.index_status, "ready");
  assert.equal(replayData.revision.revision_id, committedBody.result.structuredContent.data.revision.revision_id);
  assert.equal(scheduled.length, scheduledCountBeforeReplay);

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

  const exportStarted = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "export-restored:product-runtime-e2e",
      },
      body: JSON.stringify({
        revision_selector: { kind: "revision", revision_id: restoredRevisionId },
      }),
    },
  ));
  assert.equal(exportStarted.status, 202);
  const exportStartedBody = await exportStarted.json();
  assert.equal(exportStartedBody.ok, true, JSON.stringify(exportStartedBody));
  const exportJob = exportStartedBody.data.job;
  assert.equal(exportJob.revision_id, restoredRevisionId);
  runtime = await createProductSiteRuntime(runtimeOptions);
  const exportReplay = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": registeredCsrf,
        "idempotency-key": "export-restored:product-runtime-e2e",
      },
      body: JSON.stringify({
        revision_selector: { kind: "revision", revision_id: restoredRevisionId },
      }),
    },
  ));
  assert.equal(exportReplay.status, 202);
  const exportReplayBody = await exportReplay.json();
  assert.equal(exportReplayBody.data.replayed, true);
  assert.equal(exportReplayBody.data.job.job_id, exportJob.job_id);
  const exportWork = scheduled.findLast(
    (work) => work.kind === "export" && work.id === exportJob.job_id,
  );
  assert.ok(exportWork);
  const exportRecovery = await runtime.recoverBackground();
  assert.ok(exportRecovery.dispatched >= 1);

  const exportStatus = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/export-jobs/${encodeURIComponent(exportJob.job_id)}`,
  ));
  assert.equal(exportStatus.status, 200);
  const exportStatusBody = await exportStatus.json();
  assert.equal(exportStatusBody.ok, true, JSON.stringify(exportStatusBody));
  const completedExport = exportStatusBody.data.job;
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
    /principal_|token_|membership|\bacl\b|audit|service_id|download_url|grant|idempotency|runtime-proof/iu,
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
  assert.match(accountPageHtml, /data-account-deletion-panel/u);
  assert.match(accountPageHtml, /Loading the exact deletion preview/u);
  assert.doesNotMatch(accountPageHtml, /Type <code>delete-account<\/code> exactly/u);
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

test("Sites export REST rejects an implicit legacy profile for one exact mixed revision without side effects", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const scheduled = [];
  const committedAt = "2026-08-27T21:30:00.000Z";
  const runtime = await createProductSiteRuntime({
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "mixed.export.rest@example.com",
          verifiedFullName: "Mixed Export REST",
        };
      },
    },
    tokenVerifierKey: key(5),
    locatorKey: key(45),
    exportDownloadVerifierKey: key(85),
    csrfKey: key(125),
    now: () => new Date(committedAt),
    observabilityWriter: { write() {} },
    schedule(work) { scheduled.push(work); },
  });

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const csrf = csrfFromHtml(await registration.text());
  const bootstrap = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "bootstrap:mixed-export-rest",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrap.status, 200);
  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const exportCsrf = csrfFromHtml(await settings.text());
  const session = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/session`));
  const sessionBody = await session.json();
  const spaceId = sessionBody.data.personal_mind.mind_id;
  const parentRevisionId = sessionBody.data.personal_mind.head_revision_id;
  const mixedRevisionId = "revision_sites_mixed_export_rest";
  const { metadata } = await seedMixedExactRevision({
    database,
    bucket,
    spaceId,
    parentRevisionId,
    revisionId: mixedRevisionId,
    committedAt,
  });

  const jobsBefore = await metadata.listExportJobsForTest();
  const grantsBefore = await metadata.listExportDownloadGrantsForTest();
  const reservationsBefore = await metadata.listCapacityReservationsForTest();
  const scheduledExportsBefore = scheduled.filter(({ kind }) => kind === "export").length;
  const idempotencyKey = "export:mixed-profile-required-rest";
  const implicitProfile = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": exportCsrf,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        revision_selector: { kind: "revision", revision_id: mixedRevisionId },
      }),
    },
  ));
  assert.equal(implicitProfile.status, 422, await implicitProfile.clone().text());
  const implicitProfileBody = await implicitProfile.json();
  assert.equal(implicitProfileBody.error.code, "export_profile_required");
  assert.equal(implicitProfileBody.error.retryable, false);
  assert.deepEqual(await metadata.listExportJobsForTest(), jobsBefore);
  assert.deepEqual(await metadata.listExportDownloadGrantsForTest(), grantsBefore);
  assert.deepEqual(await metadata.listCapacityReservationsForTest(), reservationsBefore);
  assert.equal(
    scheduled.filter(({ kind }) => kind === "export").length,
    scheduledExportsBefore,
  );

  const explicitProfile = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": exportCsrf,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        revision_selector: { kind: "revision", revision_id: mixedRevisionId },
        profile: "MD-BUNDLE-ZIP-1",
      }),
    },
  ));
  assert.equal(explicitProfile.status, 202, await explicitProfile.clone().text());
  const explicitProfileBody = await explicitProfile.json();
  assert.equal(explicitProfileBody.data.replayed, false);
  assert.equal(explicitProfileBody.data.job.revision_id, mixedRevisionId);
  assert.equal((await metadata.listExportJobsForTest()).length, jobsBefore.length + 1);
  assert.equal(
    scheduled.filter(({ kind }) => kind === "export").length,
    scheduledExportsBefore + 1,
  );
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

  const exportWithoutCsrf = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "idempotency-key": "export:visibility-runtime-denied",
      },
      body: JSON.stringify({ revision_selector: { kind: "head" } }),
    },
  ));
  assert.equal(exportWithoutCsrf.status, 403);
  const publicExport = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": ownerCsrf,
        "idempotency-key": "export:visibility-runtime",
      },
      body: JSON.stringify({ revision_selector: { kind: "head" } }),
    },
  ));
  assert.equal(publicExport.status, 202, await publicExport.clone().text());
  const publicExportJob = (await publicExport.json()).data.job;
  const ownerExportStatus = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/export-jobs/${encodeURIComponent(publicExportJob.job_id)}`,
  ));
  assert.equal(ownerExportStatus.status, 200);
  assert.equal((await ownerExportStatus.json()).data.job.revision_id, publicExportJob.revision_id);

  switchIdentity("visibility.target@example.com", "Target Owner");
  await registerCurrent();
  switchIdentity("visibility.outsider@example.com", "Baseline Reader");
  await registerCurrent();

  const outsiderCsrf = await pageCsrf("/settings/developer/mcp");
  const publicCatalog = await responseFrom(runtime, new Request(`${ORIGIN}/public`));
  assert.equal(publicCatalog.status, 200);
  const publicCatalogHtml = await publicCatalog.text();
  assert.match(publicCatalogHtml, /data-public-catalog-collection/);
  const publicCatalogData = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/public-minds`),
  );
  assert.equal(publicCatalogData.status, 200);
  const publicCatalogBody = await publicCatalogData.json();
  assert.equal(publicCatalogBody.data.minds.length, 1);
  assert.equal(publicCatalogBody.data.minds[0].route, "/visibility-runtime");
  assert.equal(publicCatalogBody.data.minds[0].name, "Visibility Runtime");
  assert.doesNotMatch(publicCatalogHtml, /private|unlisted Mind metadata is unavailable/iu);

  const baselineExact = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  assert.equal(baselineExact.status, 200);
  const baselineExactBody = await baselineExact.json();
  assert.equal(baselineExactBody.data.access.kind, "visibility");
  assert.equal(baselineExactBody.data.access.role, null);
  const foreignExportStatus = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/export-jobs/${encodeURIComponent(publicExportJob.job_id)}`,
  ));
  assert.equal(foreignExportStatus.status, 404);
  assert.equal((await foreignExportStatus.json()).error.code, "export_job_not_found");
  const publicOwnerExportRecovery = await runtime.recoverBackground();
  assert.ok(publicOwnerExportRecovery.dispatched >= 1);
  const baselineReaderExport = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": outsiderCsrf,
        "idempotency-key": "export:visibility-baseline-reader",
      },
      body: JSON.stringify({ revision_selector: { kind: "head" } }),
    },
  ));
  assert.equal(baselineReaderExport.status, 202, await baselineReaderExport.clone().text());
  const baselineReaderExportJob = (await baselineReaderExport.json()).data.job;
  const baselineExportRecovery = await runtime.recoverBackground();
  assert.ok(baselineExportRecovery.dispatched >= 1);
  const baselineReaderExportStatus = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/export-jobs/${encodeURIComponent(baselineReaderExportJob.job_id)}`,
  ));
  assert.equal(baselineReaderExportStatus.status, 200);
  const baselineReaderExportStatusBody = await baselineReaderExportStatus.json();
  const baselineReaderCompletedExport = baselineReaderExportStatusBody.data.job;
  assert.equal(baselineReaderCompletedExport.status, "succeeded");
  assert.equal(
    baselineReaderCompletedExport.revision_id,
    baselineReaderExportJob.revision_id,
  );
  assert.match(baselineReaderCompletedExport.download_url, /^https:\/\/mind-diary\.example\/api\/v1\/exports\//u);
  const visibilityMetadata = await createSitesMetadataStore(database);
  const grantsBeforePrivate = await visibilityMetadata.listExportDownloadGrantsForTest();
  const baselineReaderGrant = grantsBeforePrivate.find(
    ({ jobId }) => jobId === baselineReaderExportJob.job_id,
  );
  assert.ok(baselineReaderGrant);
  assert.equal(baselineReaderGrant.state, "active");
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
      expires_at: "2026-11-01T00:00:00.000Z",
    }),
  }));
  assert.equal(tokenIssued.status, 200);
  const outsiderSecret = (await tokenIssued.json()).data.secret;
  const enabledPublicMind = await mutateMindUsage(
    runtime,
    outsiderCsrf,
    "/visibility-runtime",
    "read",
    0,
    "usage:visibility-outsider-read",
  );
  assert.equal(enabledPublicMind.status, 200, await enabledPublicMind.clone().text());
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
  const sourceMember = membersBody.data.members.find(({ is_self }) => is_self === true);
  assert.ok(targetMember);
  assert.ok(sourceMember);
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
        expected_source_membership_version: sourceMember.membership_version,
        expected_target_membership_version: targetMember.membership_version,
        confirmation: "transfer-ownership",
      }),
    },
  ));
  assert.equal(transferred.status, 200, await transferred.clone().text());
  const transferredBody = await transferred.json();
  assert.equal(transferredBody.data.source_role, "admin");
  assert.equal(transferredBody.data.target_role, "owner");

  const sourceAfterTransfer = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds/visibility-runtime`));
  const sourceAfterTransferBody = await sourceAfterTransfer.json();
  assert.equal(sourceAfterTransferBody.data.access.role, "admin");
  const formerOwnerVisibility = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/visibility-runtime/visibility`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": transferCsrf,
        "idempotency-key": "visibility:former-owner-denied",
      },
      body: JSON.stringify({
        visibility: "private",
        acknowledge_live_head_and_history_exposure: false,
        expected_metadata_version: sourceAfterTransferBody.data.metadata_version,
      }),
    },
  ));
  assert.equal(formerOwnerVisibility.status, 403, await formerOwnerVisibility.text());
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
  const grantsBeforeDeniedStatus = await visibilityMetadata.listExportDownloadGrantsForTest();
  const deniedCreatorStatus = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/export-jobs/${encodeURIComponent(baselineReaderExportJob.job_id)}`,
  ));
  assert.equal(deniedCreatorStatus.status, 404);
  const deniedCreatorStatusText = await deniedCreatorStatus.text();
  assert.equal(JSON.parse(deniedCreatorStatusText).error.code, "export_job_not_found");
  for (const forbidden of [
    baselineReaderExportJob.job_id,
    baselineReaderExportJob.revision_id,
    baselineReaderCompletedExport.sha256,
    "download_url",
    "archive_format",
    "\"size\"",
  ]) {
    assert.equal(deniedCreatorStatusText.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(
    await visibilityMetadata.listExportDownloadGrantsForTest(),
    grantsBeforeDeniedStatus,
  );

  const deniedStaleDownload = await responseFrom(
    runtime,
    new Request(baselineReaderCompletedExport.download_url),
  );
  assert.equal(deniedStaleDownload.status, 404);
  assert.equal(deniedStaleDownload.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(deniedStaleDownload.headers.get("content-disposition"), null);
  assert.equal(
    await deniedStaleDownload.text(),
    '{"ok":false,"error":{"code":"not_found","message":"The resource was not found.","retryable":false}}\n',
  );
  const grantsAfterDeniedDownload = await visibilityMetadata.listExportDownloadGrantsForTest();
  assert.equal(grantsAfterDeniedDownload.length, grantsBeforePrivate.length);
  assert.equal(
    grantsAfterDeniedDownload.find(({ jobId }) => jobId === baselineReaderExportJob.job_id)?.state,
    "revoked",
  );
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
  assert.match(invitationPageHtml, /data-people-collection/);
  assert.doesNotMatch(invitationPageHtml, /collaboration\.owner@example\.com/);

  const invitationOverview = await responseFrom(
    runtime,
    new Request(`${ORIGIN}/api/v1/invitations-overview`),
  );
  assert.equal(invitationOverview.status, 200);
  const invitationOverviewBody = await invitationOverview.json();
  const overviewInvitation = invitationOverviewBody.data.invitations.find(
    ({ direction, mind_name: mindName }) =>
      direction === "incoming" && mindName === "Collaboration Runtime",
  );
  assert.ok(overviewInvitation);
  assert.equal(JSON.stringify(invitationOverviewBody).includes("collaboration.owner@example.com"), false);

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
  const enabledCollaborationMind = await mutateMindUsage(
    runtime,
    memberSettingsCsrf,
    "/collaboration-runtime",
    "read",
    0,
    "usage:collaboration-member-read",
  );
  assert.equal(
    enabledCollaborationMind.status,
    200,
    await enabledCollaborationMind.clone().text(),
  );
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
  const issuedBody = await issued.json();
  const secret = issuedBody.data.secret;
  const enabled = await mutateMindUsage(
    runtime,
    settingsCsrf,
    "/me",
    "read_write",
    0,
    "usage:request-recovery",
  );
  assert.equal(enabled.status, 200, await enabled.clone().text());

  const personal = (await modernTool(
    runtime,
    secret,
    "request-recovery-list",
    "list_minds",
    {},
  )).minds.find(({ route }) => route === "/me");
  assert.ok(personal);
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
  assert.equal(unavailableSearchBody.result.isError, false);
  assert.match(
    unavailableSearchBody.result.structuredContent.error.request_id,
    /^request_/u,
  );
  assert.deepEqual(
    {
      ...unavailableSearchBody.result.structuredContent.error,
      request_id: "request_opaque",
    },
    {
      code: "search_index_unavailable",
      message: "Search is unavailable for the exact requested revision; continue with list_files, grep_files, and read_files for the same Mind and revision.",
      retryable: true,
      request_id: "request_opaque",
      details: {
        category: "service_state",
        state: "index_unavailable",
        recovery: {
          action: "use_file_workflow_same_revision",
          retry_policy: "bounded",
          preserve: ["mind", "revision"],
          tools: ["list_files", "grep_files", "read_files"],
        },
      },
    },
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
        webActivityEnabled: true,
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
  assert.equal(recoveryWaits.length, 2);
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

  assert.ok(scheduled.some(({ kind }) => kind === "revision_index"));
  for (const line of telemetryLines) {
    assert.equal(line.includes(recoveryMarker), false);
    assert.equal(line.includes("recovery.owner@example.com"), false);
  }
});

test("Personal configuration MCP is scoped, metadata-only, CAS protected and shared by both profiles", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const options = { database, bucket, publicOrigin: ORIGIN, schedule() {}, observabilityWriter: { write() {} },
    identity: { readVerifiedIdentity: () => ({ kind: "authenticated",
      verifiedEmail: "configuration@example.com", verifiedFullName: "Configuration Owner" }) },
    tokenVerifierKey: key(1), locatorKey: key(41), exportDownloadVerifierKey: key(81), csrfKey: key(121) };
  let runtime = await createProductSiteRuntime(options);
  let csrf = csrfFromHtml(await (await responseFrom(runtime, new Request(`${ORIGIN}/`))).text());
  const mutate = (path, body, id) => responseFrom(runtime, new Request(`${ORIGIN}${path}`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json",
      "x-csrf-token": csrf, "idempotency-key": id }, body: JSON.stringify(body) }));
  const bootstrapResponse = await mutate("/api/v1/account", { action: "create_isolated_account" }, "configuration-bootstrap");
  assert.equal(bootstrapResponse.status, 200, await bootstrapResponse.text());
  csrf = csrfFromHtml(await (await responseFrom(runtime, new Request(`${ORIGIN}/me`))).text());
  const issue = async (scopes, id) => {
    const response = await mutate("/api/v1/mcp-tokens", { name: id, scopes }, id);
    assert.equal(response.status, 200);
    return (await response.json()).data.secret;
  };
  const oldToken = await issue(["content:write"], "configuration-old");
  const token = await issue(["personal:configure"], "configuration-only");
  const call = async (secret, name, args, compat = false) => {
    const response = await (compat ? legacyMcp : modernMcp)(runtime, secret, {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args,
        _meta: { "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "configuration-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {} } } });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const denied = await call(oldToken, "get_personal_mind_configuration", {});
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "insufficient_scope");
  const initial = await call(token, "get_personal_mind_configuration", {});
  assert.equal(initial.isError, false, JSON.stringify(initial));
  assert.deepEqual(Object.keys(initial.structuredContent.data).sort(), ["description", "metadata_version"]);
  assert.equal(initial.structuredContent.data.description, null);
  const request = { description: "Engineering decisions; exclude daily logs",
    expected_metadata_version: initial.structuredContent.data.metadata_version,
    idempotency_key: "configuration-set" };
  const updated = await call(token, "set_personal_mind_description", request);
  assert.equal(updated.isError, false, JSON.stringify(updated));
  assert.equal(updated.structuredContent.data.description, request.description);
  assert.equal((await call(token, "set_personal_mind_description", { ...request, mind: "foreign" })).isError, true);
  const stale = await call(token, "set_personal_mind_description", { ...request, description: "Other", idempotency_key: "configuration-stale" });
  assert.equal(stale.structuredContent.error.code, "metadata_conflict");
  runtime = await createProductSiteRuntime(options);
  const replay = await call(token, "set_personal_mind_description", request, true);
  assert.equal(replay.isError, false, JSON.stringify(replay));
  assert.equal(replay.structuredContent.data.replayed, true);
  const readBack = await call(token, "get_personal_mind_configuration", {}, true);
  assert.equal(readBack.structuredContent.data.description, request.description);
  const cleared = await call(token, "set_personal_mind_description", {
    description: "   ", expected_metadata_version: readBack.structuredContent.data.metadata_version,
    idempotency_key: "configuration-clear" });
  assert.equal(cleared.structuredContent.data.description, null);
  const content = await call(token, "commit_changeset", {});
  assert.equal(content.isError, true);
  const metadata = await createSitesMetadataStore(database);
  const account = await metadata.readAccountByExternalBinding({ provider: "openai-sites", normalizedBinding: "configuration@example.com" });
  assert.equal(await metadata.readPrincipalMindUsage(account.principal.principalId), null);
  const combinedRead = await issue(["content:read", "personal:configure"], "configuration-combined-read");
  const combinedWrite = await issue(["content:write", "personal:configure"], "configuration-combined-write");
  const mode = await mutateMindUsage(runtime, csrf, "/me", "read_write", 0, "configuration-enable");
  assert.equal(mode.status, 200);
  for (const compat of [false, true]) {
    for (const [credential, canWrite] of [[combinedRead, false], [combinedWrite, true]]) {
      const listed = await call(credential, "list_minds", {}, compat);
      assert.equal(listed.isError, false);
      const minds = listed.structuredContent.data.minds;
      assert.equal(minds.length, 1, "adding configuration scope must preserve content discovery");
      assert.equal(minds[0].route, "/me");
      assert.equal(minds[0].effective.can_read, true);
      assert.equal(minds[0].effective.can_write, canWrite);
      const info = await call(credential, "get_mind_info", { mind: "/me" }, compat);
      assert.equal(info.isError, false, "combined scopes must preserve exact Mind authorization");
    }
    const configOnlyList = await call(token, "list_minds", {}, compat);
    assert.deepEqual(configOnlyList.structuredContent.data.minds, []);
  }
});
