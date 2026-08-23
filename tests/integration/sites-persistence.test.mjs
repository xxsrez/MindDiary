import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import {
  DEFAULT_CAPACITY_LIMITS,
  MindDiscoveryService,
} from "@mind-diary/application-content";
import {
  AccountDeletionService,
  AccountBootstrapService,
  InvitationControlService,
  OrdinaryMindDeletionService,
  OrdinaryMindControlService,
  OwnershipTransferService,
} from "@mind-diary/application-control";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  idempotencyKey,
  opaqueId,
  verifiedSpaceHost,
} from "@mind-diary/domain";
import {
  COMPOSITION_SELECTION,
  createSitesPersistenceBoundary,
} from "@mind-diary/composition-root";
import {
  CapabilityAuthorizer,
  REVISION_MANIFEST_MEDIA_TYPE,
} from "@mind-diary/application-ports";

import {
  createSitesMetadataStore,
} from "../../packages/adapter-metadata-sites/dist/index.js";

const T0 = "2026-08-08T08:00:00.000Z";
const T1 = "2026-08-08T08:05:00.000Z";
const T2 = "2026-08-08T08:10:00.000Z";
const T3 = "2026-08-08T08:15:00.000Z";
const T4 = "2026-08-08T08:20:00.000Z";
const T5 = "2026-08-08T08:25:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const SHA_A = `sha256:${"a".repeat(64)}`;

test("Sites metadata reconstructs durable capacity reservations after isolate restart", async () => {
  const database = new FakeD1Database();
  const first = await createSitesMetadataStore(database);
  const admitted = await first.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation({
      reservationId: "capacity:restart:one",
      requestedByPrincipalId: opaqueId("principal_capacity_restart"),
      spaceId: opaqueId("space_capacity_restart"),
      operation: "import",
      operationRef: "import_capacity_restart",
      baseRevisionId: null,
      idempotencyKey: idempotencyKey("capacity-restart"),
      requested: {
        physicalCanonicalBytes: 1_024,
        temporaryBytes: 2_048,
        d1MetadataBytes: 512,
      },
      bulk: false,
      heavy: false,
      createdAt: T0,
      expiresAt: T5,
    }, DEFAULT_CAPACITY_LIMITS));
  assert.equal(admitted.kind, "admitted");

  const restarted = await createSitesMetadataStore(database);
  const reservations = await restarted.listCapacityReservationsForTest();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].reservationId, "capacity:restart:one");
  assert.equal(reservations[0].state, "active");
});

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
  metadataSnapshotWriteCount = 0;
  metadataReadLog = [];
  maxBoundStringLength = Number.POSITIVE_INFINITY;
  searchWriteParameterCounts = [];
  search = new Map();
  searchDocuments = new Map();
  searchMemberships = new Map();
  searchLexical = new Map();
  audit = new Map();
  locatorHandles = new Map();
  #failTag = null;
  #batchTail = Promise.resolve();

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    const previous = this.#batchTail;
    let release;
    this.#batchTail = new Promise((resolve) => { release = resolve; });
    await previous;
    const before = {
      metadataEvents: structuredClone(this.metadataEvents),
      metadataSnapshot: structuredClone(this.metadataSnapshot),
      metadataSnapshotHead: structuredClone(this.metadataSnapshotHead),
      metadataSnapshotChunks: new Map(this.metadataSnapshotChunks),
      search: new Map(this.search),
      searchDocuments: new Map([...this.searchDocuments].map(([key, value]) => [key, { ...value }])),
      searchMemberships: new Map([...this.searchMemberships].map(([key, value]) => [key, { ...value }])),
      searchLexical: new Map([...this.searchLexical].map(([key, value]) => [key, { ...value }])),
      audit: new Map([...this.audit].map(([key, value]) => [key, { ...value }])),
      locatorHandles: new Map([...this.locatorHandles].map(([key, value]) => [key, { ...value }])),
    };
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.metadataEvents = before.metadataEvents;
      this.metadataSnapshot = before.metadataSnapshot;
      this.metadataSnapshotHead = before.metadataSnapshotHead;
      this.metadataSnapshotChunks = before.metadataSnapshotChunks;
      this.search = before.search;
      this.searchDocuments = before.searchDocuments;
      this.searchMemberships = before.searchMemberships;
      this.searchLexical = before.searchLexical;
      this.audit = before.audit;
      this.locatorHandles = before.locatorHandles;
      throw error;
    } finally {
      release();
    }
  }

  failNext(tag) {
    this.#failTag = tag;
  }

  #maybeFail(sql) {
    if (this.#failTag && sql.includes(this.#failTag)) {
      const tag = this.#failTag;
      this.#failTag = null;
      throw new Error(`synthetic D1 failure at ${tag}`);
    }
  }

  async run(sql, values) {
    this.#maybeFail(sql);
    if (values.some((value) =>
      typeof value === "string" && value.length > this.maxBoundStringLength)) {
      throw new Error("synthetic D1 bound string is too large");
    }
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
    if (sql.includes("/*md-metadata-snapshot-write*/")) {
      const sequence = Number(values[0]);
      if (this.metadataSnapshotHead !== null && this.metadataSnapshotHead.sequence >= sequence) {
        return { success: true, meta: { changes: 0 } };
      }
      this.metadataSnapshotWriteCount += 1;
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
      let changed = 0;
      for (const [key, row] of this.metadataSnapshotChunks) {
        if (row.sequence >= headSequence) continue;
        this.metadataSnapshotChunks.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
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
      let changed = 0;
      for (const [key, row] of this.searchMemberships) {
        if (row.space_id !== values[0] || row.revision_id !== values[1]) continue;
        this.searchMemberships.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-document-upsert*/")) {
      this.searchWriteParameterCounts.push({ kind: "document", count: values.length });
      let changed = 0;
      for (let index = 0; index < values.length; index += 4) {
        const key = `${values[index]}\u0000${values[index + 1]}`;
        if (this.searchDocuments.has(key)) continue;
        this.searchDocuments.set(key, {
          space_id: values[index], digest: values[index + 1], text: values[index + 2], byte_size: Number(values[index + 3]),
        });
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-lexical-upsert*/")) {
      this.searchWriteParameterCounts.push({ kind: "lexical", count: values.length });
      let changed = 0;
      for (let index = 0; index < values.length; index += 4) {
        const key = `${values[index]}\u0000${values[index + 1]}`;
        if (this.searchLexical.has(key)) continue;
        this.searchLexical.set(key, {
          space_id: values[index], digest: values[index + 1], normalized_text: values[index + 2], byte_size: Number(values[index + 3]),
        });
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-membership-insert*/")) {
      this.searchWriteParameterCounts.push({ kind: "membership", count: values.length });
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
      let changed = 0;
      const used = new Set([...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0])
        .map((row) => row.digest));
      for (const [key, row] of this.searchDocuments) {
        if (row.space_id !== values[0] || used.has(row.digest)) continue;
        this.searchDocuments.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-orphan-lexical-cleanup*/")) {
      let changed = 0;
      const used = new Set([...this.searchMemberships.values()]
        .filter((row) => row.space_id === values[0])
        .map((row) => row.digest));
      for (const [key, row] of this.searchLexical) {
        if (row.space_id !== values[0] || used.has(row.digest)) continue;
        this.searchLexical.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-purge-memberships*/")) {
      let changed = 0;
      for (const [key, row] of this.searchMemberships) {
        if (row.space_id !== values[0]) continue;
        this.searchMemberships.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-purge-documents*/")) {
      let changed = 0;
      for (const [key, row] of this.searchDocuments) {
        if (row.space_id !== values[0]) continue;
        this.searchDocuments.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-purge-lexical*/")) {
      let changed = 0;
      for (const [key, row] of this.searchLexical) {
        if (row.space_id !== values[0]) continue;
        this.searchLexical.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-search-purge-legacy*/")) {
      let changed = 0;
      for (const key of [...this.search.keys()]) {
        if (!key.startsWith(`${values[0]}\u0000`)) continue;
        this.search.delete(key);
        changed += 1;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-audit-deliver*/")) {
      const id = values[0];
      if (this.audit.has(id)) return { success: true, meta: { changes: 0 } };
      this.audit.set(id, {
        audit_event_id: id,
        space_id: values[1],
        actor_kind: values[2],
        principal_id: values[3],
        event_json: values[4],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-audit-purge*/")) {
      let changed = 0;
      for (const [id, row] of [...this.audit]) {
        if (row.space_id === values[0]) {
          this.audit.delete(id);
          changed += 1;
        }
      }
      return { success: true, meta: { changes: changed } };
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
    this.#maybeFail(sql);
    if (sql.includes("/*md-metadata-snapshot-head-read*/")) {
      this.metadataReadLog.push("snapshot-head");
      return {
        success: true,
        results: this.metadataSnapshotHead === null
          ? []
          : [{ ...this.metadataSnapshotHead }],
      };
    }
    if (sql.includes("/*md-metadata-snapshot-chunks-read*/")) {
      this.metadataReadLog.push("snapshot-chunks");
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
      this.metadataReadLog.push("snapshot");
      return {
        success: true,
        results: this.metadataSnapshot === null ? [] : [{ ...this.metadataSnapshot }],
      };
    }
    if (sql.includes("/*md-metadata-events-tail*/")) {
      this.metadataReadLog.push("tail");
      return {
        success: true,
        results: this.metadataEvents
          .filter((row) => row.sequence > Number(values[0]))
          .map((row) => ({ ...row })),
      };
    }
    if (sql.includes("/*md-metadata-events-migration*/")) {
      this.metadataReadLog.push("migration");
      return { success: true, results: this.metadataEvents.map((row) => ({ ...row })) };
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
  constructor(record) {
    this.key = record.key;
    this.size = record.bytes.byteLength;
    this.etag = record.etag;
    this.customMetadata = { ...record.customMetadata };
    this.#bytes = new Uint8Array(record.bytes);
  }

  #bytes;

  async arrayBuffer() {
    return new Uint8Array(this.#bytes).buffer;
  }
}

class FakeR2Bucket {
  records = new Map();
  #version = 0;
  #failDelete = false;

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
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
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
    if (this.#failDelete) {
      this.#failDelete = false;
      throw new Error("synthetic R2 delete failure");
    }
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

  failNextDelete() {
    this.#failDelete = true;
  }
}

function preRegistrationActor(index, occurredAtUtc = T0) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `sites.persistence.${index}@example.invalid`,
    suggestedDisplayName: `Sites Principal ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_sites_bootstrap_${index}`,
    occurredAtUtc,
  };
}

function actor(principalId, requestId, occurredAtUtc) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function ids() {
  let account = 0;
  let ordinary = 0;
  let ownerMembership = 0;
  let revision = 0;
  let invitation = 0;
  let invitationMembership = 0;
  let invitationJob = 0;
  let audit = 0;
  let outbox = 0;
  return {
    account: {
      nextPrincipalId: () => `principal_sites_${++account}`,
      nextExternalBindingId: () => `binding_sites_${account}`,
      nextSpaceId: () => `space_personal_sites_${account}`,
      nextMembershipId: () => `membership_personal_sites_${account}`,
      nextRevisionId: () => `revision_personal_sites_${account}`,
      nextPersonalSpaceHandle: () => `personal-sites-${account}`,
    },
    ordinary: {
      nextSpaceId: () => `space_sites_${++ordinary}`,
      nextMembershipId: () => `membership_owner_sites_${++ownerMembership}`,
      nextRevisionId: () => `revision_ordinary_sites_${++revision}`,
    },
    invitation: {
      nextInvitationId: () => `invitation_sites_${++invitation}`,
      nextMembershipId: () => `membership_invited_sites_${++invitationMembership}`,
      nextInvitationExpiryJobId: () => `job_invitation_sites_${++invitationJob}`,
    },
    audit: {
      nextAuditEventId: () => `audit_sites_${++audit}`,
      nextOutboxMessageId: () => `outbox_sites_${++outbox}`,
    },
  };
}

function services(boundary, generators) {
  return {
    bootstrap: new AccountBootstrapService({
      accounts: boundary.metadata,
      objects: boundary.objects,
      ids: generators.account,
    }),
    ordinary: new OrdinaryMindControlService({
      ordinaryMinds: boundary.metadata,
      objects: boundary.objects,
      host: HOST,
      ids: generators.ordinary,
    }),
    invitations: new InvitationControlService({
      invitations: boundary.metadata,
      objects: boundary.objects,
      ids: generators.invitation,
    }),
    ownership: new OwnershipTransferService({
      ordinaryMinds: boundary.metadata,
      objects: boundary.objects,
      auditIds: generators.audit,
    }),
  };
}

function nextEnvelope(base, revisionId, committedAt) {
  return Object.freeze({
    manifest: base.manifest,
    revision: Object.freeze({
      ...base.revision,
      revisionId,
      revisionNumber: base.revision.revisionNumber + 1,
      parentRevisionId: base.revision.revisionId,
      committedAt,
      summary: `Sites CAS ${revisionId}`,
    }),
  });
}

function deletionIds() {
  let impacts = 0;
  let deletedPrincipals = 0;
  return {
    nextImpactId: () => `impact_sites_${++impacts}`,
    nextDeletedPrincipalId: () => `deleted_principal_sites_${++deletedPrincipals}`,
  };
}

async function idempotentCommitRecord(store, namespace, revisionId) {
  return store.runContentCommitTransaction(async (transaction) => {
    const check = await transaction.checkIdempotency({
      namespace,
      canonicalRequestHash: SHA_A,
    });
    if (check.kind !== "missing") return check;
    return transaction.completeIdempotency({
      namespace,
      canonicalRequestHash: SHA_A,
      result: {
        kind: "commit_changeset",
        previousRevisionId: null,
        revisionId,
      },
      completedAt: T5,
    });
  });
}

test("legacy active HEAD without index effects replays and is backfilled exactly once", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  const app = services(boundary, generators);
  const created = await app.bootstrap.bootstrapAccount(preRegistrationActor(1), {
    action: "create_isolated_account",
  });
  const bootstrapEvent = database.metadataEvents.find(
    (event) => event.operation === "runAccountBootstrapTransaction",
  );
  assert.ok(bootstrapEvent);
  const payload = JSON.parse(bootstrapEvent.payload_json);
  const createCall = payload.calls.find((call) => call.method === "createAccountBootstrap");
  assert.ok(createCall);
  delete createCall.args[0].initialIndexJob;
  delete createCall.args[0].initialIndexState;
  bootstrapEvent.payload_json = JSON.stringify(payload);
  database.metadataSnapshot = null;
  database.metadataSnapshotHead = null;
  database.metadataSnapshotChunks.clear();

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  const personal = await boundary.metadata.resolvePersonalMind(created.principalId);
  assert.ok(personal);
  assert.equal(
    await boundary.metadata.readRevisionIndexState(
      personal.spaceId,
      personal.headRevisionId,
    ),
    null,
  );
  assert.deepEqual(
    await boundary.metadata.listActiveRevisionIndexGaps(10),
    [{ spaceId: personal.spaceId, revisionId: personal.headRevisionId }],
  );

  const recoveryState = {
    spaceId: personal.spaceId,
    revisionId: personal.headRevisionId,
    status: "queued",
    attempts: 0,
    queuedAt: T1,
    updatedAt: T1,
    readyAt: null,
    lastFailureCode: null,
  };
  const makeJob = (jobId) => ({
    jobId,
    target: {
      kind: "revision_index",
      spaceId: personal.spaceId,
      revisionId: personal.headRevisionId,
    },
    state: "queued",
    version: 1,
    attempts: 0,
    availableAt: T1,
    claimExpiresAt: null,
    createdAt: T1,
    updatedAt: T1,
  });
  const [first, second] = await Promise.all([
    boundary.metadata.ensureRevisionIndexQueued(makeJob("job_recovery_a"), recoveryState),
    boundary.metadata.ensureRevisionIndexQueued(makeJob("job_recovery_b"), recoveryState),
  ]);
  assert.deepEqual(
    [first.kind, second.kind].sort(),
    ["already_present", "queued"],
  );
  const due = await boundary.metadata.listRecoverableIndexJobs(T1, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].target.revisionId, personal.headRevisionId);
});

test("materialized metadata snapshot removes full-log replay from warm and restart reads", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  const created = await services(boundary, ids()).bootstrap.bootstrapAccount(
    preRegistrationActor(1),
    { action: "create_isolated_account" },
  );
  assert.ok(database.metadataSnapshotHead);
  const durableEvent = structuredClone(database.metadataEvents.at(-1));
  for (let sequence = 2; sequence <= 10_000; sequence += 1) {
    database.metadataEvents.push({ ...durableEvent, sequence });
  }
  database.metadataSnapshotHead.sequence = 10_000;
  database.metadataSnapshotChunks = new Map(
    [...database.metadataSnapshotChunks].map(([key, row]) => [
      key.replace(/^\d+:/u, "10000:"),
      { ...row, sequence: 10_000 },
    ]),
  );

  database.metadataReadLog = [];
  boundary = await createSitesPersistenceBoundary({ database, bucket });
  assert.deepEqual(database.metadataReadLog, ["snapshot-head", "snapshot-chunks", "tail"]);
  database.metadataReadLog = [];
  assert.ok(await boundary.metadata.readAccount(created.principalId));
  assert.ok(await boundary.metadata.resolvePersonalMind(created.principalId));
  assert.deepEqual(database.metadataReadLog, ["tail", "tail"]);

  database.metadataReadLog = [];
  boundary = await createSitesPersistenceBoundary({ database, bucket });
  assert.ok(await boundary.metadata.readAccount(created.principalId));
  assert.equal(database.metadataReadLog.filter((kind) => kind === "migration").length, 0);
  assert.equal(database.metadataReadLog.filter((kind) => kind === "snapshot-head").length, 1);
  assert.equal(database.metadataReadLog.filter((kind) => kind === "snapshot-chunks").length, 1);
  assert.equal(database.metadataReadLog.filter((kind) => kind === "tail").length, 2);
});

test("snapshot write failure after fenced append self-heals from canonical tail", async () => {
  const database = new FakeD1Database();
  const store = await createSitesMetadataStore(database);
  database.failNext("/*md-metadata-snapshot-write*/");
  assert.equal(
    (await store.reserveHandle({
      host: HOST,
      handle: "snapshot-recovery",
      spaceId: "space_snapshot_recovery",
    })).kind,
    "reserved",
  );
  assert.equal(database.metadataEvents.length, 1);
  assert.equal(database.metadataSnapshotHead.sequence, 0);

  const restarted = await createSitesMetadataStore(database);
  assert.deepEqual(
    await restarted.resolveHandle({ host: HOST, handle: "snapshot-recovery" }),
    { kind: "resolved", spaceId: "space_snapshot_recovery" },
  );
  assert.equal(database.metadataSnapshotHead.sequence, 1);
});

test("chunked metadata snapshots stay below one D1 bound value and survive restart", async () => {
  const database = new FakeD1Database();
  database.maxBoundStringLength = 300_000;
  const store = await createSitesMetadataStore(database);
  for (let planIndex = 0; planIndex < 4; planIndex += 1) {
    const files = Object.freeze(Array.from({ length: 500 }, (_, fileIndex) =>
      Object.freeze({
        path: `knowledge/${planIndex}/${String(fileIndex).padStart(4, "0")}-${"x".repeat(96)}.md`,
        sha256: SHA_A,
        size: 1,
      })));
    const result = await store.runMarkdownImportTransaction((transaction) =>
      transaction.createMarkdownImportPlan(Object.freeze({
        planId: `import-plan_chunked_${planIndex}`,
        principalId: opaqueId("principal_chunked_snapshot"),
        spaceId: opaqueId("space_chunked_snapshot"),
        expectedRevisionId: opaqueId("revision_chunked_snapshot"),
        idempotencyKey: idempotencyKey(`chunked-snapshot-${planIndex}`),
        canonicalRequestHash: `sha256:${String(planIndex + 1).repeat(64).slice(0, 64)}`,
        descriptorHash: `sha256:${String(planIndex + 5).repeat(64).slice(0, 64)}`,
        files,
        logicalBytes: files.length,
        additions: files.length,
        replacements: 0,
        deletions: 0,
        unchanged: 0,
        projectedUtilization: "normal",
        createdAt: T0,
        expiresAt: T5,
      }), 10_000_000));
    assert.equal(result.kind, "created");
  }
  assert.ok(database.metadataSnapshotHead.payload_chars > database.maxBoundStringLength);
  const currentChunks = [...database.metadataSnapshotChunks.values()].filter(
    (row) => row.sequence === database.metadataSnapshotHead.sequence,
  );
  assert.equal(currentChunks.length, database.metadataSnapshotHead.chunk_count);
  assert.ok(currentChunks.every((row) =>
    row.payload_json.length <= database.maxBoundStringLength));

  const restarted = await createSitesMetadataStore(database);
  assert.ok(await restarted.readMarkdownImportPlan("import-plan_chunked_3"));
});

test("high-frequency principal activity keeps a large snapshot durable without rewriting it per read", async () => {
  const database = new FakeD1Database();
  database.maxBoundStringLength = 300_000;
  const boundary = await createSitesPersistenceBoundary({
    database,
    bucket: new FakeR2Bucket(),
  });
  const created = await services(boundary, ids()).bootstrap.bootstrapAccount(
    preRegistrationActor(91),
    { action: "create_isolated_account" },
  );
  for (let planIndex = 0; planIndex < 4; planIndex += 1) {
    const files = Object.freeze(Array.from({ length: 500 }, (_, fileIndex) =>
      Object.freeze({
        path: `knowledge/activity/${planIndex}/${String(fileIndex).padStart(4, "0")}-${"x".repeat(96)}.md`,
        sha256: SHA_A,
        size: 1,
      })));
    const result = await boundary.metadata.runMarkdownImportTransaction((transaction) =>
      transaction.createMarkdownImportPlan(Object.freeze({
        planId: `import-plan_activity_${planIndex}`,
        principalId: created.principalId,
        spaceId: opaqueId("space_activity_snapshot"),
        expectedRevisionId: opaqueId("revision_activity_snapshot"),
        idempotencyKey: idempotencyKey(`activity-snapshot-${planIndex}`),
        canonicalRequestHash: `sha256:${String(planIndex + 1).repeat(64).slice(0, 64)}`,
        descriptorHash: `sha256:${String(planIndex + 5).repeat(64).slice(0, 64)}`,
        files,
        logicalBytes: files.length,
        additions: files.length,
        replacements: 0,
        deletions: 0,
        unchanged: 0,
        projectedUtilization: "normal",
        createdAt: T0,
        expiresAt: T5,
      }), 10_000_000));
    assert.equal(result.kind, "created");
  }
  assert.ok(database.metadataSnapshotHead.payload_chars > database.maxBoundStringLength);
  const writesBeforeActivity = database.metadataSnapshotWriteCount;
  const sequenceBeforeActivity = database.metadataEvents.at(-1).sequence;

  for (let index = 1; index <= 20; index += 1) {
    await boundary.metadata.recordPrincipalActivity({
      principalId: created.principalId,
      surface: "web",
      kind: "page",
      observedAt: new Date(Date.parse(T0) + index * 1_000).toISOString(),
    });
  }

  assert.equal(database.metadataEvents.at(-1).sequence, sequenceBeforeActivity + 20);
  assert.ok(database.metadataSnapshotWriteCount - writesBeforeActivity <= 1);
  const restarted = await createSitesMetadataStore(database);
  const activity = await restarted.readPrincipalActivity(created.principalId);
  assert.equal(activity.lastWebSeenAt, new Date(Date.parse(T0) + 20_000).toISOString());
  assert.ok(database.metadataSnapshotHead.sequence < database.metadataEvents.at(-1).sequence);
  assert.equal((await restarted.reserveHandle({
    host: HOST,
    handle: "activity-snapshot-checkpoint",
    spaceId: "space_activity_snapshot_checkpoint",
  })).kind, "reserved");
  assert.equal(database.metadataSnapshotHead.sequence, database.metadataEvents.at(-1).sequence);
  const checkpointRestart = await createSitesMetadataStore(database);
  assert.equal(
    (await checkpointRestart.readPrincipalActivity(created.principalId)).lastWebSeenAt,
    new Date(Date.parse(T0) + 20_000).toISOString(),
  );
});

test("corrupt materialized metadata snapshot fails closed", async () => {
  const database = new FakeD1Database();
  const store = await createSitesMetadataStore(database);
  await store.reserveHandle({
    host: HOST,
    handle: "snapshot-corrupt",
    spaceId: "space_snapshot_corrupt",
  });
  const corruptChunkKey = `${database.metadataSnapshotHead.sequence}:0`;
  database.metadataSnapshotChunks.set(corruptChunkKey, {
    ...database.metadataSnapshotChunks.get(corruptChunkKey),
    payload_json: JSON.stringify({ v: 999 }),
  });
  database.metadataSnapshotHead.payload_chars = JSON.stringify({ v: 999 }).length;
  await assert.rejects(createSitesMetadataStore(database), /snapshot is invalid/u);
});

test("list_minds resolves a scaled candidate set from one D1 read-session", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  const boundary = await createSitesPersistenceBoundary({ database, bucket });
  const app = services(boundary, generators);
  const owner = await app.bootstrap.bootstrapAccount(preRegistrationActor(1), {
    action: "create_isolated_account",
  });
  for (let index = 0; index < 24; index += 1) {
    await app.ordinary.createSpaceWithOwner(
      actor(owner.principalId, `request_scaled_${index}`, T1),
      {
        name: `Scaled ${index}`,
        handle: `scaled-${String(index).padStart(2, "0")}`,
        idempotencyKey: `scaled-${index}`,
      },
    );
  }
  const discovery = new MindDiscoveryService({ store: boundary.metadata, host: HOST });
  database.metadataReadLog = [];
  const listed = await discovery.listMinds(actor(owner.principalId, "request_scaled_list", T2), {
    limit: 100,
  });
  assert.equal(listed.minds.length, 25);
  assert.equal(listed.minds[0].route, "/me");
  assert.deepEqual(database.metadataReadLog, ["tail"]);
  const eventCount = database.metadataEvents.length;
  await assert.rejects(
    boundary.metadata.withConsistentRead((view) => view.reserveHandle({
      host: HOST,
      handle: "read-session-mutation",
      spaceId: "space_read_session_mutation",
    })),
    /read-session is read-only/u,
  );
  assert.equal(database.metadataEvents.length, eventCount);
});

test("get_mind_info resolves one exact Mind from one D1 read-session", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  const boundary = await createSitesPersistenceBoundary({ database, bucket });
  const app = services(boundary, generators);
  const owner = await app.bootstrap.bootstrapAccount(preRegistrationActor(1), {
    action: "create_isolated_account",
  });
  const mind = await app.ordinary.createSpaceWithOwner(
    actor(owner.principalId, "request_info_create", T1),
    {
      name: "Exact read session",
      handle: "exact-read-session",
      idempotencyKey: "exact-read-session",
    },
  );
  const discovery = new MindDiscoveryService({ store: boundary.metadata, host: HOST });

  database.metadataReadLog = [];
  const info = await discovery.getMindInfo(
    actor(owner.principalId, "request_info_read", T2),
    "/exact-read-session",
    { kind: "head" },
  );

  assert.equal(info.mind.mindId, mind.mindId);
  assert.equal(info.resolvedRevision.revisionId, mind.headRevisionId);
  assert.deepEqual(database.metadataReadLog, ["tail"]);

  let indexStatusReads = 0;
  const discoveryWithIndexStatus = new MindDiscoveryService({
    store: boundary.metadata,
    host: HOST,
    indexStatus: {
      async read() {
        indexStatusReads += 1;
        await boundary.metadata.readHead(mind.mindId);
        return null;
      },
    },
  });
  database.metadataReadLog = [];
  await discoveryWithIndexStatus.getMindInfo(
    actor(owner.principalId, "request_info_status", T2),
    "/exact-read-session",
    { kind: "head" },
  );
  assert.equal(indexStatusReads, 1);
  assert.deepEqual(database.metadataReadLog, ["tail", "tail"]);

  const discoveryWithSessionIndexStatus = new MindDiscoveryService({
    store: boundary.metadata,
    host: HOST,
    indexStatusForStore: (store) => ({
      async read(request) {
        indexStatusReads += 1;
        await store.readHead(request.spaceId);
        return {
          status: "ready",
          attempts: 1,
          lastFailureCode: null,
        };
      },
    }),
  });
  database.metadataReadLog = [];
  const sessionInfo = await discoveryWithSessionIndexStatus.getMindInfo(
    actor(owner.principalId, "request_info_session_status", T2),
    "/exact-read-session",
    { kind: "head" },
  );
  assert.equal(sessionInfo.indexStatus.status, "ready");
  assert.equal(indexStatusReads, 2);
  assert.deepEqual(database.metadataReadLog, ["tail"]);
});

test("Sites composition persists account, invitation, ownership, HEAD CAS, idempotency and token state across isolates", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  let app = services(boundary, generators);

  const owner = await app.bootstrap.bootstrapAccount(preRegistrationActor(1), {
    action: "create_isolated_account",
  });
  const target = await app.bootstrap.bootstrapAccount(preRegistrationActor(2), {
    action: "create_isolated_account",
  });
  const mind = await app.ordinary.createSpaceWithOwner(
    actor(owner.principalId, "request_sites_create", T1),
    { name: "Durable Mind", handle: "durable-mind", idempotencyKey: "create-durable" },
  );
  const invitation = await app.invitations.createInvitation(
    actor(owner.principalId, "request_sites_invite", T2),
    {
      mindId: mind.mindId,
      targetVerifiedEmail: "sites.persistence.2@example.invalid",
      role: "editor",
      expectedMetadataVersion: 1,
      idempotencyKey: "invite-durable",
    },
  );

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  app = services(boundary, generators);
  const accepted = await app.invitations.acceptInvitation(
    actor(target.principalId, "request_sites_accept", T3),
    {
      invitationId: invitation.invitationId,
      expectedInvitationVersion: 1,
      idempotencyKey: "accept-durable",
    },
  );
  const beforeTransfer = await boundary.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(beforeTransfer);
  const transferred = await app.ownership.transferOwnership(
    actor(owner.principalId, "request_sites_transfer", T4),
    {
      mindId: mind.mindId,
      targetMemberId: accepted.membershipId,
      expectedMetadataVersion: beforeTransfer.space.metadataVersion,
      confirmation: "transfer-ownership",
      idempotencyKey: "transfer-durable",
    },
  );
  assert.equal(transferred.targetRole, "owner");

  const restarted = await createSitesPersistenceBoundary({ database, bucket });
  const finalMind = await restarted.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(finalMind);
  assert.deepEqual(
    finalMind.memberships
      .filter((membership) => membership.state === "active" && membership.role === "owner")
      .map((membership) => membership.principalId),
    [target.principalId],
  );
  assert.ok(await restarted.metadata.readAccount(owner.principalId));
  assert.ok(await restarted.metadata.readAccount(target.principalId));

  const base = await restarted.metadata.readRevision(mind.mindId, mind.headRevisionId);
  assert.ok(base);
  const first = await createSitesMetadataStore(database);
  const second = await createSitesMetadataStore(database);
  const race = await Promise.all([
    first.commitRevision({
      expectedHeadRevisionId: mind.headRevisionId,
      envelope: nextEnvelope(base, "revision_sites_race_a", T5),
    }),
    second.commitRevision({
      expectedHeadRevisionId: mind.headRevisionId,
      envelope: nextEnvelope(base, "revision_sites_race_b", T5),
    }),
  ]);
  assert.deepEqual(race.map((result) => result.kind).sort(), ["committed", "stale_head"]);
  const winningRevision = race.find((result) => result.kind === "committed").envelope.revision.revisionId;
  assert.equal((await createSitesMetadataStore(database)).readHead instanceof Function, true);
  assert.equal(await (await createSitesMetadataStore(database)).readHead(mind.mindId), winningRevision);

  const namespace = {
    principalId: owner.principalId,
    spaceId: mind.mindId,
    operation: "commit_changeset",
    key: "sites-idempotency-race",
  };
  const idempotencyRace = await Promise.all([
    idempotentCommitRecord(await createSitesMetadataStore(database), namespace, winningRevision),
    idempotentCommitRecord(await createSitesMetadataStore(database), namespace, winningRevision),
  ]);
  assert.deepEqual(
    idempotencyRace.map((result) => result.kind).sort(),
    ["completed", "replay"],
  );
  assert.equal((await (await createSitesMetadataStore(database)).listIdempotencyRecordsForTest()).length, 1);

  const tokenStore = await createSitesMetadataStore(database);
  const createdToken = await tokenStore.createMcpToken({
    tokenId: "token_sites_durable",
    principalId: owner.principalId,
    name: "Codex durable fixture",
    verifier: `hmac-sha256:v1:${"b".repeat(64)}`,
    displayPrefix: "mdp_v1_abcdef…",
    scopes: ["content:read", "content:write"],
    createdAt: T0,
    expiresAt: "2026-11-06T08:00:00.000Z",
  });
  assert.equal(createdToken.kind, "created");
  assert.equal(
    (await (await createSitesMetadataStore(database)).listMcpTokenMetadata(owner.principalId)).length,
    1,
  );

  const currentAuthorization = await tokenStore.readCurrentAuthorizationState({
    principalId: owner.principalId,
    spaceId: mind.mindId,
    tokenId: "token_sites_durable",
  });
  assert.equal(currentAuthorization?.token?.tokenId, "token_sites_durable");
  assert.equal(currentAuthorization?.membership?.principalId, owner.principalId);
  const routeAuthorization = await tokenStore.readCurrentRouteAuthorizationState({
    principalId: owner.principalId,
    spaceId: mind.mindId,
    tokenId: "token_sites_durable",
    host: HOST,
    handle: mind.handle,
  });
  assert.equal(routeAuthorization?.token?.tokenId, "token_sites_durable");

  const mcpActor = {
    kind: "registered_principal",
    principalId: owner.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: "token_sites_durable",
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_sites_mcp_authorization",
    occurredAtUtc: T5,
  };
  const authorizationRequest = {
    actor: mcpActor,
    spaceId: mind.mindId,
    capability: "content:browse",
    revisionMode: "head",
  };
  const authorizer = new CapabilityAuthorizer(tokenStore);
  const authorized = await authorizer.authorize(authorizationRequest);
  assert.equal(authorized.kind, "allowed");
  const transactionAuthorization = await tokenStore.runContentCommitTransaction(
    (transaction) =>
      authorizer.reauthorizeInTransaction(
        authorizationRequest,
        transaction,
        authorized.stamp,
      ),
  );
  assert.equal(transactionAuthorization.kind, "allowed");

  const concurrentRevoker = await createSitesMetadataStore(database);
  let authorizationAttempts = 0;
  const revokedDuringTransaction = await tokenStore.runContentCommitTransaction(
    async (transaction) => {
      authorizationAttempts += 1;
      const decision = await authorizer.reauthorizeInTransaction(
        authorizationRequest,
        transaction,
        authorized.stamp,
      );
      if (authorizationAttempts === 1) {
        assert.equal(decision.kind, "allowed");
        const revocation = await concurrentRevoker.revokeMcpToken({
          principalId: owner.principalId,
          tokenId: "token_sites_durable",
          revokedAt: "2026-08-08T08:26:00.000Z",
        });
        assert.equal(revocation.kind, "revoked");
      }
      return decision;
    },
  );
  assert.equal(authorizationAttempts, 2);
  assert.deepEqual(revokedDuringTransaction, {
    kind: "denied",
    code: "token_inactive",
    retryable: false,
  });

  const winning = await tokenStore.readRevision(mind.mindId, winningRevision);
  assert.ok(winning);
  const effects = {
    auditEvent: {
      auditEventId: "audit_sites_retry",
      actor: { kind: "principal", principalId: owner.principalId },
      requestId: "request_sites_retry",
      eventType: "content.changeset_committed",
      outcome: "succeeded",
      spaceId: mind.mindId,
      occurredAt: T5,
      safeMetadata: {
        revision_id: winning.revision.revisionId,
        previous_revision_id: winning.revision.parentRevisionId,
        revision_number: winning.revision.revisionNumber,
        manifest_hash: winning.revision.manifestHash,
      },
    },
    auditOutbox: {
      outboxMessageId: "outbox_sites_retry",
      auditEventId: "audit_sites_retry",
      state: "pending",
      version: 1,
      attempts: 0,
      availableAt: T5,
      claimExpiresAt: null,
      createdAt: T5,
      updatedAt: T5,
    },
    indexJob: {
      jobId: "index_job_sites_retry",
      target: {
        kind: "revision_index",
        spaceId: mind.mindId,
        revisionId: winning.revision.revisionId,
      },
      state: "queued",
      version: 1,
      attempts: 0,
      availableAt: T5,
      claimExpiresAt: null,
      createdAt: T5,
      updatedAt: T5,
    },
    indexState: {
      spaceId: mind.mindId,
      revisionId: winning.revision.revisionId,
      status: "queued",
      attempts: 0,
      queuedAt: T5,
      updatedAt: T5,
      readyAt: null,
      lastFailureCode: null,
    },
  };
  assert.deepEqual(
    await tokenStore.runContentCommitTransaction((transaction) =>
      transaction.stageContentCommitEffects(effects),
    ),
    { kind: "staged" },
  );

  const indexClaim = await tokenStore.claimIndexJob(
    "index_job_sites_retry",
    T5,
    "2026-08-08T08:29:00.000Z",
  );
  const auditClaim = await tokenStore.claimAuditOutbox(
    "outbox_sites_retry",
    T5,
    "2026-08-08T08:29:00.000Z",
  );
  assert.equal(indexClaim.kind, "claimed");
  assert.equal(auditClaim.kind, "claimed");
  assert.equal(
    await tokenStore.failIndexJob(
      "index_job_sites_retry",
      indexClaim.job.version,
      "synthetic_retry",
      "2026-08-08T08:26:00.000Z",
      "2026-08-08T08:27:00.000Z",
    ),
    true,
  );
  assert.equal(
    await tokenStore.failAuditOutbox(
      "outbox_sites_retry",
      auditClaim.message.version,
      "2026-08-08T08:26:00.000Z",
      "2026-08-08T08:27:00.000Z",
    ),
    true,
  );

  const retryStore = await createSitesMetadataStore(database);
  const retryIndexClaim = await retryStore.claimIndexJob(
    "index_job_sites_retry",
    "2026-08-08T08:27:00.000Z",
    "2026-08-08T08:31:00.000Z",
  );
  const retryAuditClaim = await retryStore.claimAuditOutbox(
    "outbox_sites_retry",
    "2026-08-08T08:27:00.000Z",
    "2026-08-08T08:31:00.000Z",
  );
  assert.equal(retryIndexClaim.kind, "claimed");
  assert.equal(retryAuditClaim.kind, "claimed");
  assert.equal(retryIndexClaim.job.attempts, 2);
  assert.equal(retryAuditClaim.message.attempts, 2);
  assert.equal(
    await retryStore.completeIndexJob(
      "index_job_sites_retry",
      retryIndexClaim.job.version,
      "2026-08-08T08:28:00.000Z",
    ),
    true,
  );
  assert.equal(
    await retryStore.completeAuditOutbox(
      "outbox_sites_retry",
      retryAuditClaim.message.version,
      "2026-08-08T08:28:00.000Z",
    ),
    true,
  );
  const completedStore = await createSitesMetadataStore(database);
  assert.equal(
    (await completedStore.readRevisionIndexState(mind.mindId, winningRevision)).status,
    "ready",
  );
  assert.deepEqual(
    await completedStore.claimAuditOutbox(
      "outbox_sites_retry",
      "2026-08-08T08:29:00.000Z",
      "2026-08-08T08:30:00.000Z",
    ),
    { kind: "completed" },
  );
});

test("D1 mutation failure exposes no process-memory success and retry survives restart", async () => {
  const database = new FakeD1Database();
  const store = await createSitesMetadataStore(database);
  database.failNext("/*md-metadata-append*/");
  await assert.rejects(
    store.reserveHandle({ host: HOST, handle: "retry-handle", spaceId: "space_retry" }),
    /synthetic D1 failure/u,
  );
  assert.deepEqual(
    await (await createSitesMetadataStore(database)).resolveHandle({
      host: HOST,
      handle: "retry-handle",
    }),
    { kind: "not_found" },
  );
  assert.equal(
    (await store.reserveHandle({
      host: HOST,
      handle: "retry-handle",
      spaceId: "space_retry",
    })).kind,
    "reserved",
  );
  assert.deepEqual(
    await (await createSitesMetadataStore(database)).resolveHandle({
      host: HOST,
      handle: "retry-handle",
    }),
    { kind: "resolved", spaceId: "space_retry" },
  );
});

test("whole-Mind and account cleanup resume from durable deletion state after restart", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  const app = services(boundary, generators);
  const owner = await app.bootstrap.bootstrapAccount(preRegistrationActor(10), {
    action: "create_isolated_account",
  });
  const mind = await app.ordinary.createSpaceWithOwner(
    actor(owner.principalId, "request_sites_delete_create", T1),
    {
      name: "Restartable deletion",
      handle: "restartable-deletion",
      idempotencyKey: "create-restartable-deletion",
    },
  );

  let failMindIndexPurge = true;
  const failingMindIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => boundary.index.replaceExactRevision(request),
    readExactRevision: (spaceId, revisionId) =>
      boundary.index.readExactRevision(spaceId, revisionId),
    purgeSpace: async (spaceId) => {
      if (failMindIndexPurge) {
        failMindIndexPurge = false;
        throw new Error("synthetic Mind index cleanup failure");
      }
      return boundary.index.purgeSpace(spaceId);
    },
  };
  const mindDeletionIds = deletionIds();
  const mindDeletionOptions = {
    ordinaryMinds: boundary.metadata,
    objects: boundary.objects,
    index: failingMindIndex,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
    ids: mindDeletionIds,
    clock: { now: () => T5 },
    host: HOST,
  };
  const mindDeletion = new OrdinaryMindDeletionService(mindDeletionOptions);
  const mindImpact = await mindDeletion.getDeletionImpact(
    actor(owner.principalId, "request_sites_delete_preview", T5),
    { handle: mind.handle },
  );
  const mindCommand = {
    handle: mind.handle,
    impactId: mindImpact.impactId,
    confirmation: mindImpact.confirmation,
    idempotencyKey: "delete-sites-mind-restart",
  };
  await assert.rejects(
    mindDeletion.deleteSpace(
      actor(owner.principalId, "request_sites_delete_fail", T5),
      mindCommand,
    ),
    /deletion cleanup is incomplete/iu,
  );
  assert.equal(await boundary.metadata.inspectOrdinaryMindStateForTest(mind.mindId), null);
  assert.equal((await boundary.metadata.inspectDeletionCleanupForTest()).length, 1);

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  const resumedMindDeletion = new OrdinaryMindDeletionService({
    ...mindDeletionOptions,
    ordinaryMinds: boundary.metadata,
    objects: boundary.objects,
    index: boundary.index,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
  });
  const mindResult = await resumedMindDeletion.deleteSpace(
    actor(owner.principalId, "request_sites_delete_resume", T5),
    mindCommand,
  );
  assert.equal(mindResult.replayed, true);
  assert.deepEqual(await boundary.metadata.inspectDeletionCleanupForTest(), []);

  let failAccountIndexPurge = true;
  const failingAccountIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => boundary.index.replaceExactRevision(request),
    readExactRevision: (spaceId, revisionId) =>
      boundary.index.readExactRevision(spaceId, revisionId),
    purgeSpace: async (spaceId) => {
      if (failAccountIndexPurge) {
        failAccountIndexPurge = false;
        throw new Error("synthetic account index cleanup failure");
      }
      return boundary.index.purgeSpace(spaceId);
    },
  };
  const accountDeletionIds = deletionIds();
  const accountDeletionOptions = {
    accounts: boundary.metadata,
    tokens: boundary.tokens,
    objects: boundary.objects,
    index: failingAccountIndex,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
    ids: accountDeletionIds,
    clock: { now: () => T5 },
    host: HOST,
  };
  const accountDeletion = new AccountDeletionService(accountDeletionOptions);
  const accountImpact = await accountDeletion.getAccountDeletionImpact(
    actor(owner.principalId, "request_sites_account_preview", T5),
  );
  const accountCommand = {
    impactId: accountImpact.impactId,
    confirmation: accountImpact.confirmation,
    idempotencyKey: "delete-sites-account-restart",
  };
  await assert.rejects(
    accountDeletion.deleteAccount(
      actor(owner.principalId, "request_sites_account_fail", T5),
      accountCommand,
    ),
    /deletion cleanup is incomplete/iu,
  );
  assert.equal(await boundary.metadata.readAccount(owner.principalId), null);
  assert.equal((await boundary.metadata.inspectAccountDeletionCleanupForTest()).length, 1);

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  const resumedAccountDeletion = new AccountDeletionService({
    ...accountDeletionOptions,
    accounts: boundary.metadata,
    tokens: boundary.tokens,
    objects: boundary.objects,
    index: boundary.index,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
  });
  const accountResult = await resumedAccountDeletion.deleteAccount(
    actor(owner.principalId, "request_sites_account_resume", T5),
    accountCommand,
  );
  assert.equal(accountResult.replayed, true);
  assert.equal(await boundary.metadata.readAccount(owner.principalId), null);
  assert.deepEqual(await boundary.metadata.inspectAccountDeletionCleanupForTest(), []);
});

async function runObjectContract(name, factory) {
  await test(name, async () => {
    const store = await factory();
    const bytes = new TextEncoder().encode("# Durable canonical bytes\n");
    const put = await store.putImmutable({ bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: T0 });
    assert.equal(put.status, "stored");
    assert.deepEqual((await store.getImmutable(put.object.sha256)).bytes, bytes);
    const listed = await store.listImmutableObjects({
      createdBefore: T2,
      excludedDigests: [],
      limit: 10,
    });
    assert.equal(listed.length, 1);
    assert.equal(
      await store.deleteImmutableObject({
        sha256: put.object.sha256,
        expectedProtectedAt: put.object.protectedAt,
        createdBefore: T2,
      }),
      true,
    );
    assert.equal(await store.getImmutable(put.object.sha256), null);

    const scoped = await store.putSpaceCanonicalObject({
      kind: "markdown",
      spaceId: "space_object_contract",
      bytes,
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: T0,
    });
    assert.equal(scoped.status, "stored");
    assert.deepEqual(
      (await store.getSpaceCanonicalObject(
        "markdown",
        "space_object_contract",
        scoped.object.sha256,
      )).bytes,
      bytes,
    );
    assert.equal(
      await store.getSpaceCanonicalObject(
        "markdown",
        "space_object_contract_foreign",
        scoped.object.sha256,
      ),
      null,
    );
    const manifestBytes = new TextEncoder().encode(
      '{"format":"mind-diary-revision-manifest-v3","entries":[]}\n',
    );
    const manifest = await store.putSpaceCanonicalObject({
      kind: "revision_manifest",
      spaceId: "space_object_contract",
      bytes: manifestBytes,
      mediaType: REVISION_MANIFEST_MEDIA_TYPE,
      createdAt: T0,
    });
    assert.equal(manifest.status, "stored");
    const scopedList = await store.listSpaceCanonicalObjects({
      createdBefore: T2,
      excluded: [{
        kind: "markdown",
        spaceId: "space_object_contract",
        sha256: scoped.object.sha256,
      }],
      limit: 10,
    });
    assert.deepEqual(scopedList.map((object) => object.kind), ["revision_manifest"]);
    assert.equal(
      await store.deleteSpaceCanonicalObject({
        kind: "revision_manifest",
        spaceId: "space_object_contract",
        sha256: manifest.object.sha256,
        expectedProtectedAt: manifest.object.protectedAt,
        createdBefore: T2,
      }),
      true,
    );
  });
}

await runObjectContract("memory object contract baseline", async () => new InMemoryObjectStore());
await runObjectContract("Sites R2 object contract", async () => {
  const boundary = await createSitesPersistenceBoundary({
    database: new FakeD1Database(),
    bucket: new FakeR2Bucket(),
  });
  return boundary.objects;
});

test("Sites Space-canonical cleanup resumes after crash between delete mark and physical delete", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const put = await store.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId: "space_cleanup_resume",
    bytes: new TextEncoder().encode("# Cleanup resume\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: T0,
  });

  bucket.failNextDelete();
  await assert.rejects(
    store.deleteSpaceCanonicalObject({
      kind: "markdown",
      spaceId: "space_cleanup_resume",
      sha256: put.object.sha256,
      expectedProtectedAt: put.object.protectedAt,
      createdBefore: T1,
    }),
    /synthetic R2 delete failure/u,
  );
  assert.equal([...bucket.records.values()][0].customMetadata.state, "deleting");
  await bucket.put(
    "spaces/space_cleanup_resume/indexes/revision/schema/page",
    new TextEncoder().encode("derived"),
    { customMetadata: { state: "active", schema: "derived-index-v1" } },
  );

  store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const resumable = await store.listSpaceCanonicalObjects({
    spaceId: "space_cleanup_resume",
    createdBefore: T2,
    excluded: [],
    limit: 10,
  });
  assert.equal(resumable.length, 1);
  assert.equal(
    await store.deleteSpaceCanonicalObject({
      kind: resumable[0].kind,
      spaceId: resumable[0].spaceId,
      sha256: resumable[0].sha256,
      expectedProtectedAt: resumable[0].protectedAt,
      createdBefore: T2,
    }),
    true,
  );
  assert.equal(
    await store.getSpaceCanonicalObject(
      "markdown",
      "space_cleanup_resume",
      put.object.sha256,
    ),
    null,
  );
});

test("R2 cleanup is lease-safe, restartable after failure, and export cleanup is durable", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const bytes = new TextEncoder().encode("# Restartable cleanup\n");
  const initial = await store.putImmutable({ bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: T0 });
  const protectedWrite = await store.putImmutable({ bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: T2 });
  assert.equal(
    await store.deleteImmutableObject({
      sha256: initial.object.sha256,
      expectedProtectedAt: initial.object.protectedAt,
      createdBefore: T3,
    }),
    false,
  );
  bucket.failNextDelete();
  await assert.rejects(
    store.deleteImmutableObject({
      sha256: initial.object.sha256,
      expectedProtectedAt: protectedWrite.object.protectedAt,
      createdBefore: T3,
    }),
    /synthetic R2 delete failure/u,
  );
  store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const resumed = await store.listImmutableObjects({
    createdBefore: T3,
    excludedDigests: [],
    limit: 10,
  });
  assert.equal(resumed.length, 1);
  assert.equal(
    await store.deleteImmutableObject({
      sha256: resumed[0].sha256,
      expectedProtectedAt: resumed[0].protectedAt,
      createdBefore: T3,
    }),
    true,
  );

  const archiveBytes = Uint8Array.from([80, 75, 5, 6]);
  const archiveSha = await store.calculateSha256(archiveBytes);
  const archive = await store.putExportArchive({
    jobId: "export_sites_restart",
    spaceId: "space_sites_export",
    claimVersion: 1,
    bytes: archiveBytes,
    sha256: archiveSha,
    createdAt: T4,
  });
  assert.equal(archive.kind, "stored");
  const restarted = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  assert.deepEqual(await restarted.readExportArchive(archive.archive.objectKey), archiveBytes);
  assert.equal(await restarted.deleteExportArchivesForJob("export_sites_restart"), 1);

  const bundleRequest = {
    jobId: "export_sites_bundle_restart",
    spaceId: "space_sites_export",
    claimVersion: 2,
    bytes: archiveBytes,
    sha256: archiveSha,
    archiveFormat: "MD-BUNDLE-ZIP-1",
    filename: "mind-diary-bundle.zip",
    contentDisposition: 'attachment; filename="mind-diary-bundle.zip"',
    createdAt: T4,
  };
  const bundleArchive = await restarted.putExportArchive(bundleRequest);
  assert.equal(bundleArchive.kind, "stored");
  assert.equal(bundleArchive.archive.archiveFormat, "MD-BUNDLE-ZIP-1");
  const bundleRestart = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const bundleReplay = await bundleRestart.putExportArchive(bundleRequest);
  assert.equal(bundleReplay.kind, "already_exists");
  assert.equal(bundleReplay.archive.filename, "mind-diary-bundle.zip");
  await assert.rejects(
    bundleRestart.putExportArchive({
      ...bundleRequest,
      jobId: "export_sites_invalid_profile",
      archiveFormat: "MD-UNKNOWN-ZIP-1",
    }),
    /export profile metadata is invalid/u,
  );
  assert.equal(await bundleRestart.deleteExportArchivesForJob(bundleRequest.jobId), 1);
});

test("Sites export upload resumes deterministic parts and downloads one verified R2 part at a time", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const bytes = Uint8Array.from(
    { length: 9 * 1_048_576 + 137 },
    (_value, index) => index % 251,
  );
  const sha256 = await store.calculateSha256(bytes);
  const request = {
    jobId: "export_sites_stream_restart",
    spaceId: "space_sites_stream",
    claimVersion: 3,
    archiveFormat: "MD-BUNDLE-ZIP-1",
    filename: "mind-diary-bundle.zip",
    contentDisposition: 'attachment; filename="mind-diary-bundle.zip"',
    createdAt: T0,
  };

  const interrupted = await store.beginExportArchiveUpload(request);
  await interrupted.write(bytes.subarray(0, 5 * 1_048_576));
  await interrupted.abort();
  const partsAfterInterruption = [...bucket.records].filter(([key]) =>
    key.includes("/stream/parts/"));
  assert.equal(partsAfterInterruption.length, 1);

  store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const resumed = await store.beginExportArchiveUpload(request);
  for (let offset = 0; offset < bytes.byteLength; offset += 777_777) {
    await resumed.write(bytes.subarray(offset, offset + 777_777));
  }
  const completed = await resumed.complete({ sha256, size: bytes.byteLength });
  assert.equal(completed.kind, "stored");
  assert.equal(
    [...bucket.records].filter(([key]) => key.includes("/stream/parts/")).length,
    3,
  );

  const restarted = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const opened = await restarted.openExportArchive(completed.archive.objectKey);
  assert.ok(opened);
  assert.equal(opened.sha256, sha256);
  assert.equal(opened.size, bytes.byteLength);
  assert.equal(opened.body instanceof Uint8Array, false);
  const reader = opened.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    assert.ok(next.value.byteLength <= 4_194_304);
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  const downloaded = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    downloaded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert.deepEqual(downloaded, bytes);

  const [firstPartKey] = [...bucket.records.keys()].filter((key) =>
    key.includes("/stream/parts/"));
  const tampered = bucket.records.get(firstPartKey);
  tampered.bytes[0] ^= 0xff;
  const reopened = await restarted.openExportArchive(completed.archive.objectKey);
  await assert.rejects(
    reopened.body.getReader().read(),
    /R2 export part is invalid/u,
  );
});

test("Sites object cleanup checkpoint persists cursor and reclaims only an expired lease", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  let store = boundary.objects;
  for (const text of ["# cleanup a\n", "# cleanup b\n"]) {
    await store.putImmutable({
      bytes: new TextEncoder().encode(text),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: T0,
    });
  }
  const first = await boundary.metadata.claimObjectCleanup({ now: T0, leaseExpiresAt: T1 });
  assert.equal(first.kind, "claimed");
  assert.equal(first.reclaimedLease, false);
  assert.equal(
    (await boundary.metadata.claimObjectCleanup({ now: T0, leaseExpiresAt: T1 })).kind,
    "busy",
  );
  const page = await store.listObjectCleanupPage({
    namespace: "immutable",
    cursor: null,
    limit: 1,
  });
  assert.equal(page.listed, 1);
  assert.ok(page.nextCursor);
  assert.equal(await boundary.metadata.completeObjectCleanupBatch({
    expectedVersion: first.checkpoint.version,
    namespace: "immutable",
    cursor: page.nextCursor,
    cycleStartedAt: first.checkpoint.cycleStartedAt,
    completedAt: T1,
  }), true);

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  store = boundary.objects;
  const resumed = await boundary.metadata.claimObjectCleanup({ now: T2, leaseExpiresAt: T3 });
  assert.equal(resumed.kind, "claimed");
  assert.equal(resumed.checkpoint.cursor, page.nextCursor);
  assert.equal(resumed.checkpoint.retries, 0);
  const secondPage = await store.listObjectCleanupPage({
    namespace: resumed.checkpoint.namespace,
    cursor: resumed.checkpoint.cursor,
    limit: 1,
  });
  assert.equal(secondPage.listed, 1);

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  const reclaimed = await boundary.metadata.claimObjectCleanup({ now: T4, leaseExpiresAt: T5 });
  assert.equal(reclaimed.kind, "claimed");
  assert.equal(reclaimed.reclaimedLease, true);
  assert.equal(reclaimed.checkpoint.cursor, page.nextCursor);
  assert.equal(reclaimed.checkpoint.retries, 1);
});

async function runSearchContract(name, factory) {
  await test(name, async () => {
    const index = await factory();
    await index.replaceExactRevision({
      spaceId: "space_search_contract",
      revisionId: "revision_search_contract",
      documents: [{ path: "concepts/private.md", text: "private fixture body" }],
    });
    const result = await index.readExactRevision(
      "space_search_contract",
      "revision_search_contract",
    );
    assert.equal(result.kind, "ready");
    assert.deepEqual(result.documents, [
      { path: "concepts/private.md", text: "private fixture body" },
    ]);
    assert.equal(await index.purgeSpace("space_search_contract"), 1);
    assert.deepEqual(
      await index.readExactRevision("space_search_contract", "revision_search_contract"),
      { kind: "unavailable" },
    );
  });
}

await runSearchContract(
  "memory exact-revision search contract baseline",
  async () => new InMemoryExactRevisionSearchIndex(),
);
await runSearchContract("Sites D1 exact-revision search contract", async () => {
  const boundary = await createSitesPersistenceBoundary({
    database: new FakeD1Database(),
    bucket: new FakeR2Bucket(),
  });
  return boundary.index;
});

test("Sites search reuses digest rows across exact revisions and migrates legacy rows", async () => {
  const database = new FakeD1Database();
  const index = (await createSitesPersistenceBoundary({
    database,
    bucket: new FakeR2Bucket(),
  })).index;
  await index.replaceExactRevision({
    spaceId: "space_search_reuse",
    revisionId: "revision_search_reuse_1",
    documents: [
      { path: "a.md", text: "unchanged" },
      { path: "b.md", text: "unchanged" },
    ],
  });
  await index.replaceExactRevision({
    spaceId: "space_search_reuse",
    revisionId: "revision_search_reuse_2",
    documents: [
      { path: "a.md", text: "unchanged" },
      { path: "b.md", text: "modified" },
      { path: "c.md", text: "unchanged" },
    ],
  });
  assert.deepEqual(await index.readStorageMetricsForTest("space_search_reuse"), {
    documentCount: 2,
    documentBytes: Buffer.byteLength("unchanged") + Buffer.byteLength("modified"),
    lexicalBytes: Buffer.byteLength("unchanged") + Buffer.byteLength("modified"),
    membershipCount: 5,
  });
  assert.deepEqual(
    (await index.readExactRevision("space_search_reuse", "revision_search_reuse_1")).documents,
    [
      { path: "a.md", text: "unchanged" },
      { path: "b.md", text: "unchanged" },
    ],
  );
  assert.deepEqual(
    (await index.readExactRevision("space_search_reuse", "revision_search_reuse_2")).documents,
    [
      { path: "a.md", text: "unchanged" },
      { path: "b.md", text: "modified" },
      { path: "c.md", text: "unchanged" },
    ],
  );
  assert.deepEqual(
    await index.queryExactRevision(
      "space_search_reuse",
      "revision_search_reuse_2",
      ["modified"],
    ),
    {
      kind: "ready",
      spaceId: "space_search_reuse",
      revisionId: "revision_search_reuse_2",
      totalDocuments: 3,
      documents: [{ path: "b.md", text: "modified" }],
    },
  );
  database.searchLexical.clear();
  assert.deepEqual(
    (await index.queryExactRevision(
      "space_search_reuse",
      "revision_search_reuse_2",
      ["modified"],
    )).documents,
    [{ path: "b.md", text: "modified" }],
  );
  assert.equal(database.searchLexical.size, 2);

  database.search.set(
    "space_search_reuse\u0000revision_search_legacy",
    JSON.stringify([{ path: "legacy.md", text: "legacy text" }]),
  );
  assert.deepEqual(
    (await index.readExactRevision("space_search_reuse", "revision_search_legacy")).documents,
    [{ path: "legacy.md", text: "legacy text" }],
  );
  assert.equal(database.search.has("space_search_reuse\u0000revision_search_legacy"), false);
  assert.equal(
    [...database.searchMemberships.values()].some(
      (row) => row.revision_id === "revision_search_legacy",
    ),
    true,
  );
});

test("normalized search rebuild is atomic under failure and concurrent replacement", async () => {
  const database = new FakeD1Database();
  const index = (await createSitesPersistenceBoundary({
    database,
    bucket: new FakeR2Bucket(),
  })).index;
  const target = {
    spaceId: "space_search_atomic",
    revisionId: "revision_search_atomic",
  };
  await index.replaceExactRevision({
    ...target,
    documents: [{ path: "index.md", text: "before" }],
  });
  database.failNext("/*md-search-membership-insert*/");
  await assert.rejects(
    index.replaceExactRevision({
      ...target,
      documents: [{ path: "index.md", text: "failed" }],
    }),
    /synthetic D1 failure/u,
  );
  assert.deepEqual((await index.readExactRevision(target.spaceId, target.revisionId)).documents, [
    { path: "index.md", text: "before" },
  ]);

  const candidates = ["winner-a", "winner-b"];
  await Promise.all(candidates.map((text) => index.replaceExactRevision({
    ...target,
    documents: [
      { path: "a.md", text },
      { path: "b.md", text },
    ],
  })));
  const current = (await index.readExactRevision(target.spaceId, target.revisionId)).documents;
  assert.equal(current.length, 2);
  assert.equal(current[0].text, current[1].text);
  assert.equal(candidates.includes(current[0].text), true);
});

test("Brain-scale Markdown rebuild stays within D1 parameter bounds and query loads one candidate", async () => {
  const database = new FakeD1Database();
  const index = (await createSitesPersistenceBoundary({
    database,
    bucket: new FakeR2Bucket(),
  })).index;
  const fileCount = 1_741;
  const targetBytes = 5_681_704;
  const bodySize = Math.ceil(targetBytes / fileCount);
  const documents = Array.from({ length: fileCount }, (_, item) => {
    const marker = `marker-${String(item).padStart(5, "0")}`;
    return {
      path: `concepts/item-${String(item).padStart(5, "0")}.md`,
      text: `${marker}\n${"x".repeat(Math.max(0, bodySize - marker.length - 1))}`,
    };
  });
  assert.ok(documents.reduce((total, document) => total + Buffer.byteLength(document.text), 0) >= targetBytes);
  await index.replaceExactRevision({
    spaceId: "space_search_brain_scale",
    revisionId: "revision_search_brain_scale",
    documents,
  });
  assert.ok(database.searchWriteParameterCounts.length > 3);
  assert.ok(database.searchWriteParameterCounts.every(({ count }) => count <= 100));
  const result = await index.queryExactRevision(
    "space_search_brain_scale",
    "revision_search_brain_scale",
    ["marker-01740"],
  );
  assert.equal(result.totalDocuments, fileCount);
  assert.deepEqual(result.documents.map(({ path }) => path), ["concepts/item-01740.md"]);
});

test("D1 search and privacy-safe audit survive instances without becoming sources of truth", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  await boundary.index.replaceExactRevision({
    spaceId: "space_sites_projection",
    revisionId: "revision_sites_projection",
    documents: [{ path: "index.md", text: "derived private query text" }],
  });
  const event = {
    auditEventId: "audit_sites_delivery",
    actor: { kind: "principal", principalId: "principal_sites_audit" },
    requestId: "request_sites_audit",
    eventType: "content_commit",
    outcome: "succeeded",
    spaceId: "space_sites_projection",
    occurredAt: T4,
    safeMetadata: { revision_number: 2 },
  };
  assert.equal(await boundary.audit.deliver(event), "delivered");
  assert.equal(await boundary.audit.deliver(event), "duplicate");

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  assert.equal(
    (await boundary.index.readExactRevision(
      "space_sites_projection",
      "revision_sites_projection",
    )).kind,
    "ready",
  );
  assert.equal(
    await boundary.audit.tombstonePrincipal(
      "principal_sites_audit",
      "deleted_principal_sites_audit",
    ),
    1,
  );
  assert.deepEqual(JSON.parse(database.audit.get("audit_sites_delivery").event_json).actor, {
    kind: "deleted-principal",
    opaqueId: "deleted_principal_sites_audit",
  });
  assert.equal(await boundary.audit.purgeSpace("space_sites_projection"), 1);
  assert.equal(await boundary.index.purgeSpace("space_sites_projection"), 1);
});

test("production outbound selection contains no process-memory adapter", () => {
  assert.deepEqual(COMPOSITION_SELECTION.productionOutbound, {
    metadata: "sites-d1-fenced-event-log",
    objects: "sites-r2-immutable-envelope",
    search: "sites-d1-exact-revision",
    audit: "sites-d1-privacy-safe-audit",
  });
  assert.equal(
    Object.values(COMPOSITION_SELECTION.productionOutbound).some((value) => value.includes("memory")),
    false,
  );
  assert.equal(COMPOSITION_SELECTION.deployableServiceImplemented, true);
});

test("memory audit contract baseline remains idempotent", async () => {
  const audit = new InMemoryAuditSink();
  const event = {
    auditEventId: "audit_memory_baseline",
    actor: { kind: "service", serviceId: "test" },
    requestId: "request_memory_baseline",
    eventType: "baseline",
    outcome: "succeeded",
    spaceId: null,
    occurredAt: T0,
    safeMetadata: {},
  };
  assert.equal(await audit.deliver(event), "delivered");
  assert.equal(await audit.deliver(event), "duplicate");
});
