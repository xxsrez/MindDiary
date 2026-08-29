import { InMemoryLocalFileUploadIntentStore } from "@mind-diary/adapter-metadata-memory";
import type {
  ClaimLocalFileUploadIntentResult,
  CreateLocalFileUploadIntentResult,
  LocalFileUploadIntentRecord,
  LocalFileUploadIntentStore,
  MindBindingOwnerId,
  PrincipalId,
  StagedBundleFileId,
  UtcInstant,
} from "@mind-diary/application-ports";

interface D1ResultLike<Row = Record<string, unknown>> {
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  all<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
}

export interface LocalFileUploadIntentD1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike[]>;
}

export const SITES_LOCAL_FILE_UPLOAD_INTENT_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS md_local_file_upload_intents (
    intent_id TEXT PRIMARY KEY,
    namespace_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    record_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS md_local_file_upload_intents_expiry
   ON md_local_file_upload_intents (expires_at, intent_id)`,
]);

interface IntentRow {
  readonly intent_id: string;
  readonly namespace_hash: string;
  readonly expires_at: string;
  readonly record_version: number;
  readonly record_json: string;
}

interface SchemaObjectRow {
  readonly name?: string;
}

function changes(result: D1ResultLike): number {
  return Number(result.meta?.changes ?? 0);
}

function decodeRecord(row: Readonly<IntentRow>): Readonly<LocalFileUploadIntentRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record_json);
  } catch {
    throw new Error("Sites upload intent record is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { formatVersion?: unknown }).formatVersion !== 1 ||
    (parsed as { intentId?: unknown }).intentId !== row.intent_id ||
    (parsed as { namespaceHash?: unknown }).namespaceHash !== row.namespace_hash ||
    (parsed as { expiresAt?: unknown }).expiresAt !== row.expires_at
  ) {
    throw new Error("Sites upload intent record is invalid");
  }
  const record = Object.freeze({ ...(parsed as LocalFileUploadIntentRecord) });
  try {
    InMemoryLocalFileUploadIntentStore.fromDurableSnapshot({
      v: 1,
      records: new Map([[record.intentId, record]]),
    });
  } catch {
    throw new Error("Sites upload intent record is invalid");
  }
  return record;
}

function encodeRecord(record: Readonly<LocalFileUploadIntentRecord>): string {
  return JSON.stringify(record);
}

function isolatedStore(
  record: Readonly<LocalFileUploadIntentRecord>,
): InMemoryLocalFileUploadIntentStore {
  return InMemoryLocalFileUploadIntentStore.fromDurableSnapshot({
    v: 1,
    records: new Map([[record.intentId, record]]),
  });
}

/** Dedicated D1 persistence with per-record optimistic concurrency. */
export class SitesLocalFileUploadIntentStore implements LocalFileUploadIntentStore {
  readonly #database: LocalFileUploadIntentD1DatabaseLike;
  #ready: Promise<void> | null = null;

  constructor(database: LocalFileUploadIntentD1DatabaseLike) {
    this.#database = database;
  }

  async ready(): Promise<this> {
    this.#ready ??= this.#ensureReady().catch((error) => {
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    return this;
  }

  async #ensureReady(): Promise<void> {
    try {
      const result = await this.#database
        .prepare(
          `/*md-upload-intent-schema-probe*/ SELECT name FROM sqlite_master
           WHERE type IN ('table', 'index')
             AND name IN ('md_local_file_upload_intents',
                          'md_local_file_upload_intents_expiry')`,
        )
        .all<SchemaObjectRow>();
      const names = new Set((result.results ?? []).map((row) => row.name));
      if (
        names.has("md_local_file_upload_intents") &&
        names.has("md_local_file_upload_intents_expiry")
      ) return;
    } catch {
      // The schema is absent or an older D1 adapter does not expose sqlite_master.
      // Fall through to the idempotent schema batch below.
    }
    await this.#database.batch(SITES_LOCAL_FILE_UPLOAD_INTENT_SCHEMA.map((sql) =>
      this.#database.prepare(sql)));
  }

  async #readByIntentId(intentId: string): Promise<IntentRow | null> {
    await this.ready();
    const result = await this.#database
      .prepare(
        `/*md-upload-intent-read*/ SELECT intent_id, namespace_hash, expires_at,
         record_version, record_json FROM md_local_file_upload_intents
         WHERE intent_id = ?1`,
      )
      .bind(intentId)
      .all<IntentRow>();
    return result.results?.[0] ?? null;
  }

  async #readByNamespace(namespaceHash: string): Promise<IntentRow | null> {
    await this.ready();
    const result = await this.#database
      .prepare(
        `/*md-upload-intent-read-namespace*/ SELECT intent_id, namespace_hash,
         expires_at, record_version, record_json FROM md_local_file_upload_intents
         WHERE namespace_hash = ?1`,
      )
      .bind(namespaceHash)
      .all<IntentRow>();
    return result.results?.[0] ?? null;
  }

  async readLocalFileUploadIntent(
    intentId: string,
  ): Promise<Readonly<LocalFileUploadIntentRecord> | null> {
    const row = await this.#readByIntentId(intentId);
    return row === null ? null : decodeRecord(row);
  }

  async createLocalFileUploadIntent(
    record: Readonly<LocalFileUploadIntentRecord>,
  ): Promise<CreateLocalFileUploadIntentResult> {
    const validation = await new InMemoryLocalFileUploadIntentStore()
      .createLocalFileUploadIntent(record);
    if (validation.kind !== "created") return Object.freeze({ kind: "conflict" });
    await this.ready();
    const inserted = await this.#database
      .prepare(
        `/*md-upload-intent-create*/ INSERT OR IGNORE INTO md_local_file_upload_intents
         (intent_id, namespace_hash, expires_at, record_version, record_json)
         VALUES (?1, ?2, ?3, 1, ?4)`,
      )
      .bind(
        record.intentId,
        record.namespaceHash,
        record.expiresAt,
        encodeRecord(record),
      )
      .run();
    if (changes(inserted) === 1) {
      return Object.freeze({ kind: "created", record: Object.freeze({ ...record }) });
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const existing = await this.#readByNamespace(record.namespaceHash);
      if (existing === null) return Object.freeze({ kind: "conflict" });
      const before = decodeRecord(existing);
      const replayStore = isolatedStore(before);
      const replay = await replayStore.createLocalFileUploadIntent(record);
      if (replay.kind === "conflict") return replay;
      const after = await replayStore.readLocalFileUploadIntent(before.intentId);
      if (after === null || encodeRecord(after) === encodeRecord(before)) {
        return replay;
      }
      const updated = await this.#database
        .prepare(
          `/*md-upload-intent-update*/ UPDATE md_local_file_upload_intents
           SET expires_at = ?1, record_version = record_version + 1, record_json = ?2
           WHERE intent_id = ?3 AND record_version = ?4`,
        )
        .bind(
          after.expiresAt,
          encodeRecord(after),
          before.intentId,
          existing.record_version,
        )
        .run();
      if (changes(updated) === 1) {
        return Object.freeze({ kind: "replayed", record: after });
      }
    }
    throw new Error("Sites upload intent CAS retry budget exhausted");
  }

  async #mutate<Result>(
    intentId: string,
    operation: (store: InMemoryLocalFileUploadIntentStore) => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.#readByIntentId(intentId);
      if (row === null) return operation(new InMemoryLocalFileUploadIntentStore());
      const before = decodeRecord(row);
      const store = isolatedStore(before);
      const result = await operation(store);
      const after = await store.readLocalFileUploadIntent(intentId);
      if (after === null || encodeRecord(after) === encodeRecord(before)) return result;
      const updated = await this.#database
        .prepare(
          `/*md-upload-intent-update*/ UPDATE md_local_file_upload_intents
           SET expires_at = ?1, record_version = record_version + 1, record_json = ?2
           WHERE intent_id = ?3 AND record_version = ?4`,
        )
        .bind(after.expiresAt, encodeRecord(after), intentId, row.record_version)
        .run();
      if (changes(updated) === 1) return result;
    }
    throw new Error("Sites upload intent CAS retry budget exhausted");
  }

  claimLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    principalId: PrincipalId;
    bindingOwnerId: MindBindingOwnerId;
    claimId: string;
    occurredAt: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<ClaimLocalFileUploadIntentResult> {
    return this.#mutate(request.intentId, (store) =>
      store.claimLocalFileUploadIntent(request));
  }

  renewLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    occurredAt: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<"renewed" | "claim_lost" | "expired" | "not_found"> {
    return this.#mutate(request.intentId, (store) =>
      store.renewLocalFileUploadIntent(request));
  }

  completeLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    stagedFileId: StagedBundleFileId;
    replayed: boolean;
    completedAt: UtcInstant;
  }>): Promise<"completed" | "claim_lost" | "expired" | "not_found"> {
    return this.#mutate(request.intentId, (store) =>
      store.completeLocalFileUploadIntent(request));
  }

  rejectLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    code: string;
    rejectedAt: UtcInstant;
  }>): Promise<"rejected" | "claim_lost" | "not_found"> {
    return this.#mutate(request.intentId, (store) =>
      store.rejectLocalFileUploadIntent(request));
  }

  releaseLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
  }>): Promise<"released" | "claim_lost" | "not_found"> {
    return this.#mutate(request.intentId, (store) =>
      store.releaseLocalFileUploadIntent(request));
  }

  async collectExpiredLocalFileUploadIntents(request: Readonly<{
    expiredBefore: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<LocalFileUploadIntentRecord>[]> {
    if (
      !Number.isFinite(Date.parse(request.expiredBefore)) ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    ) throw new TypeError("upload intent cleanup request is invalid");
    await this.ready();
    const result = await this.#database
      .prepare(
        `/*md-upload-intent-collect-expired*/ SELECT intent_id, namespace_hash,
         expires_at, record_version, record_json FROM md_local_file_upload_intents
         WHERE expires_at <= ?1 ORDER BY expires_at, intent_id LIMIT ?2`,
      )
      .bind(request.expiredBefore, request.limit)
      .all<IntentRow>();
    return Object.freeze([...(result.results ?? [])].map(decodeRecord));
  }

  async deleteExpiredLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    expectedExpiresAt: UtcInstant;
    expiredBefore: UtcInstant;
  }>): Promise<boolean> {
    if (
      !Number.isFinite(Date.parse(request.expectedExpiresAt)) ||
      !Number.isFinite(Date.parse(request.expiredBefore))
    ) return false;
    await this.ready();
    const result = await this.#database
      .prepare(
        `/*md-upload-intent-delete-expired*/ DELETE FROM md_local_file_upload_intents
         WHERE intent_id = ?1 AND expires_at = ?2 AND expires_at <= ?3`,
      )
      .bind(request.intentId, request.expectedExpiresAt, request.expiredBefore)
      .run();
    return changes(result) === 1;
  }
}

export async function createSitesLocalFileUploadIntentStore(
  database: LocalFileUploadIntentD1DatabaseLike,
): Promise<SitesLocalFileUploadIntentStore> {
  return new SitesLocalFileUploadIntentStore(database);
}
