import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  SitesMetadataStore,
} from "@mind-diary/adapter-metadata-sites";
import type {
  R2BucketLike,
  R2ListedObjectLike,
} from "@mind-diary/adapter-object-sites";
import {
  SYSTEM_BACKUP_FORMAT,
  SYSTEM_BACKUP_EXACT_FIELDS,
  systemBackupDelta,
  systemBackupObjectSeeds,
  systemBackupRecords,
  systemBackupSha256,
  systemBackupTargetDigest,
  type SystemBackupObjectSeed,
} from "./system-backup-format.js";
import { assertSystemBackupD1Schema } from "./system-backup-schema.js";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_PART_BYTES = 4 * 1_024 * 1_024;
const MAX_INVENTORY_PAGE = 128;
const KNOWN_R2_PREFIXES = new Set([
  "canonical/", "spaces/", "bundle-files/", "staged-bundle-files/", "exports/",
]);

interface BackupControlRow {
  readonly origin_id: string;
  readonly generation: number;
  readonly backup_sequence: number;
  readonly invalidation_epoch: number;
}

interface BackupSessionRow {
  readonly session_id: string;
  readonly origin_id: string;
  readonly generation: number;
  readonly base_sequence: number | null;
  readonly base_digest: string | null;
  readonly base_session_id: string | null;
  readonly base_captured_at: string | null;
  readonly base_schema_digest: string | null;
  readonly mode: SystemBackupSessionDescriptor["mode"];
  readonly target_sequence: number;
  readonly target_digest: string;
  readonly invalidation_epoch: number;
  readonly status: "building" | "ready" | "invalidated" | "completed" | "released";
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly expires_at: string;
  readonly page_count: number;
  readonly record_count: number;
  readonly object_count: number;
  readonly manifest_digest: string;
  readonly schema_digest: string;
}

export interface SystemBackupCheckpoint {
  readonly origin_id: string;
  readonly generation: number;
  readonly sequence: number;
  readonly digest: string;
  readonly session_id: string;
  readonly captured_at: string;
  readonly schema_digest: string;
}

export interface SystemBackupInventoryItem {
  readonly object_index: number;
  readonly namespace: string;
  readonly object_key: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly media_type: string;
}

export interface SystemBackupSessionDescriptor {
  readonly format: typeof SYSTEM_BACKUP_FORMAT;
  readonly session_id: string;
  readonly mode: "baseline" | "incremental" | "rebaseline";
  readonly base_checkpoint: SystemBackupCheckpoint | null;
  readonly target_checkpoint: SystemBackupCheckpoint;
  readonly page_count: number;
  readonly record_count: number;
  readonly object_count: number;
  readonly manifest_digest: string;
  readonly schema_digest: string;
  readonly expires_at: string;
}

export class SystemBackupFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SystemBackupFailure";
    this.code = code;
  }
}

function changes(result: Readonly<{ meta?: Readonly<{ changes?: number }> }>): number {
  return result.meta?.changes ?? 0;
}

function safeSessionId(value: unknown): string {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new SystemBackupFailure("invalid_session");
  }
  return value;
}

function safeIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SystemBackupFailure("invalid_index");
  }
  return value as number;
}

function targetCheckpoint(row: BackupSessionRow): SystemBackupCheckpoint {
  return Object.freeze({
    origin_id: row.origin_id,
    generation: row.generation,
    sequence: row.target_sequence,
    digest: row.target_digest,
    session_id: row.session_id,
    captured_at: row.created_at,
    schema_digest: row.schema_digest,
  });
}

function descriptor(
  row: BackupSessionRow,
  mode: SystemBackupSessionDescriptor["mode"],
  base: SystemBackupCheckpoint | null,
): SystemBackupSessionDescriptor {
  return Object.freeze({
    format: SYSTEM_BACKUP_FORMAT,
    session_id: row.session_id,
    mode,
    base_checkpoint: base,
    target_checkpoint: targetCheckpoint(row),
    page_count: row.page_count,
    record_count: row.record_count,
    object_count: row.object_count,
    manifest_digest: row.manifest_digest,
    schema_digest: row.schema_digest,
    expires_at: row.expires_at,
  });
}

export class SitesSystemBackupService {
  readonly #database: D1DatabaseLike;
  readonly #bucket: R2BucketLike;
  readonly #metadata: SitesMetadataStore;
  readonly #now: () => Date;
  readonly #runtimeExtraD1Schema: Readonly<Record<string, string>>;

  constructor(options: Readonly<{
    database: D1DatabaseLike;
    bucket: R2BucketLike;
    metadata: SitesMetadataStore;
    now?: () => Date;
    runtimeExtraD1Schema?: Readonly<Record<string, string>>;
  }>) {
    this.#database = options.database;
    this.#bucket = options.bucket;
    this.#metadata = options.metadata;
    this.#now = options.now ?? (() => new Date());
    this.#runtimeExtraD1Schema = options.runtimeExtraD1Schema ?? {};
  }

  async #one<Row>(sql: string, ...args: unknown[]): Promise<Row | null> {
    const result = await this.#database.prepare(sql).bind(...args).all<Row>();
    const rows = result.results ?? [];
    if (rows.length > 1) throw new SystemBackupFailure("backup_storage_inconsistent");
    return rows[0] ?? null;
  }

  async #control(): Promise<BackupControlRow> {
    const row = await this.#one<BackupControlRow>(
      `/*md-backup-control-read*/ SELECT origin_id, generation,
       backup_sequence, invalidation_epoch FROM md_backup_control
       WHERE singleton_id = 1`,
    );
    if (row === null || !/^[0-9a-f]{32}$/u.test(row.origin_id) ||
      !Number.isSafeInteger(row.generation) || row.generation < 1 ||
      !Number.isSafeInteger(row.backup_sequence) || row.backup_sequence < 0 ||
      !Number.isSafeInteger(row.invalidation_epoch) || row.invalidation_epoch < 0) {
      throw new SystemBackupFailure("backup_control_unavailable");
    }
    return row;
  }

  async #session(sessionId: string): Promise<BackupSessionRow> {
    const row = await this.#one<BackupSessionRow>(
      `/*md-backup-session-read*/ SELECT session_id, origin_id, generation,
       base_sequence, base_digest, base_session_id,
       base_captured_at, base_schema_digest, mode,
       target_sequence, target_digest,
       invalidation_epoch, status, created_at, completed_at, expires_at,
       page_count, record_count, object_count, manifest_digest, schema_digest
       FROM md_backup_sessions WHERE session_id = ?1`,
      safeSessionId(sessionId),
    );
    if (row === null) throw new SystemBackupFailure("backup_session_not_found");
    return row;
  }

  async #active(sessionId: string): Promise<BackupSessionRow> {
    const row = await this.#session(sessionId);
    const control = await this.#control();
    if (row.status !== "ready" || row.expires_at <= this.#now().toISOString() ||
      row.origin_id !== control.origin_id ||
      row.generation !== control.generation ||
      row.invalidation_epoch !== control.invalidation_epoch) {
      throw new SystemBackupFailure("backup_session_inactive");
    }
    return row;
  }

  async #validateRuntimeInventory(): Promise<string> {
    const schema = await this.#database.prepare(
      `/*md-backup-schema-inventory*/ SELECT m.name AS table_name,
       p.name AS column_name FROM sqlite_schema AS m
       JOIN pragma_table_info(m.name) AS p
       WHERE m.type = 'table'
       ORDER BY m.name, p.cid`,
    ).all<{ table_name: string; column_name: string }>();
    const applicationSchema = (schema.results ?? []).filter((row) =>
      !row.table_name.startsWith("sqlite_") &&
      row.table_name !== "_cf_KV" && row.table_name !== "d1_migrations");
    assertSystemBackupD1Schema(applicationSchema, this.#runtimeExtraD1Schema);
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({
        delimiter: "/", limit: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!Array.isArray(page.delimitedPrefixes) ||
        page.objects.some((object) => ![...KNOWN_R2_PREFIXES]
          .some((prefix) => object.key.startsWith(prefix))) ||
        page.delimitedPrefixes.some((prefix) => !KNOWN_R2_PREFIXES.has(prefix))) {
        throw new SystemBackupFailure("backup_r2_namespace_unknown");
      }
      if (page.truncated && !page.cursor) {
        throw new SystemBackupFailure("backup_r2_inventory_incomplete");
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return systemBackupSha256(JSON.stringify({
      format: SYSTEM_BACKUP_FORMAT,
      exact_fields: SYSTEM_BACKUP_EXACT_FIELDS,
      d1: applicationSchema,
      r2_prefixes: [...KNOWN_R2_PREFIXES].sort(),
    }));
  }

  async #base(
    candidate: SystemBackupCheckpoint | null,
    control: BackupControlRow,
    schemaDigest: string,
  ): Promise<Readonly<{
    checkpoint: SystemBackupCheckpoint | null;
    digests: ReadonlyMap<string, string>;
    mode: SystemBackupSessionDescriptor["mode"];
  }>> {
    if (candidate === null) {
      return { checkpoint: null, digests: new Map(), mode: "baseline" };
    }
    if (candidate.origin_id !== control.origin_id ||
      candidate.generation !== control.generation ||
      !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 0) {
      return { checkpoint: null, digests: new Map(), mode: "rebaseline" };
    }
    let row: BackupSessionRow;
    try { row = await this.#session(candidate.session_id); }
    catch (error) {
      if (error instanceof SystemBackupFailure &&
        error.code === "backup_session_not_found") {
        return { checkpoint: null, digests: new Map(), mode: "rebaseline" };
      }
      throw error;
    }
    if (row.status !== "completed" ||
      row.origin_id !== candidate.origin_id ||
      row.generation !== candidate.generation ||
      row.target_sequence !== candidate.sequence ||
      row.target_digest !== candidate.digest ||
      row.created_at !== candidate.captured_at ||
      row.schema_digest !== candidate.schema_digest ||
      row.schema_digest !== schemaDigest ||
      row.target_sequence > control.backup_sequence) {
      return { checkpoint: null, digests: new Map(), mode: "rebaseline" };
    }
    const rows = await this.#database.prepare(
      `/*md-backup-base-digests*/ SELECT record_key, sha256
       FROM md_backup_record_digests WHERE session_id = ?1
       ORDER BY record_key`,
    ).bind(candidate.session_id).all<{ record_key: string; sha256: string }>();
    const digests = new Map((rows.results ?? []).map((item) =>
      [item.record_key, item.sha256]));
    if (digests.size !== row.record_count ||
      await systemBackupTargetDigest(digests) !== row.target_digest) {
      throw new SystemBackupFailure("backup_base_corrupt");
    }
    return {
      checkpoint: candidate,
      digests,
      mode: "incremental",
    };
  }

  async #head(key: string): Promise<R2ListedObjectLike | null> {
    if (this.#bucket.head !== undefined) return this.#bucket.head(key);
    const object = await this.#bucket.get(key);
    if (object === null) return null;
    await object.body.cancel();
    return object;
  }

  async #inventory(seeds: readonly SystemBackupObjectSeed[]):
    Promise<readonly SystemBackupInventoryItem[]> {
    const items: SystemBackupInventoryItem[] = [];
    for (const seed of seeds) {
      let key = seed.key;
      let metadata = await this.#head(key);
      if (metadata === null && seed.fallbackKey !== null) {
        key = seed.fallbackKey;
        metadata = await this.#head(key);
      }
      if (metadata === null ||
        (seed.size >= 0 && metadata.size !== seed.size) ||
        metadata.customMetadata?.sha256 !== seed.sha256 ||
        metadata.customMetadata?.mediaType !== seed.mediaType ||
        (metadata.customMetadata?.state !== undefined &&
          metadata.customMetadata.state !== "active")) {
        throw new SystemBackupFailure("backup_object_closure_invalid");
      }
      items.push(Object.freeze({
        object_index: items.length,
        namespace: key.startsWith("canonical/") ? "immutable" : seed.namespace,
        object_key: key,
        sha256: seed.sha256,
        byte_size: metadata.size,
        media_type: seed.mediaType,
      }));
    }
    return Object.freeze(items);
  }

  async #writeStatements(statements: readonly D1PreparedStatementLike[]): Promise<void> {
    for (let start = 0; start < statements.length; start += 8) {
      await this.#database.batch(statements.slice(start, start + 8));
    }
  }

  async #pruneOneSession(): Promise<void> {
    const now = this.#now();
    const cutoff = new Date(now.getTime() - SESSION_RETENTION_MS).toISOString();
    const candidate = await this.#one<{ session_id: string }>(
      `/*md-backup-prune-select*/ SELECT session_id FROM md_backup_sessions
       WHERE created_at < ?1 AND
         (status IN ('released', 'invalidated', 'completed') OR expires_at <= ?2)
       ORDER BY created_at, session_id LIMIT 1`,
      cutoff, now.toISOString(),
    );
    if (candidate === null) return;
    await this.#database.batch([
      this.#database.prepare(
        `/*md-backup-prune-pages*/ DELETE FROM md_backup_pages WHERE session_id = ?1`,
      ).bind(candidate.session_id),
      this.#database.prepare(
        `/*md-backup-prune-digests*/ DELETE FROM md_backup_record_digests
         WHERE session_id = ?1`,
      ).bind(candidate.session_id),
      this.#database.prepare(
        `/*md-backup-prune-inventory*/ DELETE FROM md_backup_inventory
         WHERE session_id = ?1`,
      ).bind(candidate.session_id),
      this.#database.prepare(
        `/*md-backup-prune-session*/ DELETE FROM md_backup_sessions
         WHERE session_id = ?1 AND created_at < ?2 AND
           (status IN ('released', 'invalidated', 'completed') OR expires_at <= ?3)`,
      ).bind(candidate.session_id, cutoff, now.toISOString()),
    ]);
  }

  async createSession(
    baseCheckpoint: SystemBackupCheckpoint | null = null,
    requestId: string = crypto.randomUUID(),
  ):
    Promise<SystemBackupSessionDescriptor> {
    const sessionId = safeSessionId(requestId);
    const existing = await this.#one<BackupSessionRow>(
      `/*md-backup-session-read*/ SELECT session_id, origin_id, generation,
       base_sequence, base_digest, base_session_id,
       base_captured_at, base_schema_digest, mode,
       target_sequence, target_digest,
       invalidation_epoch, status, created_at, completed_at, expires_at,
       page_count, record_count, object_count, manifest_digest, schema_digest
       FROM md_backup_sessions WHERE session_id = ?1`,
      sessionId,
    );
    if (existing !== null) return this.#replaySession(existing, baseCheckpoint);
    await this.#pruneOneSession();
    const schemaDigest = await this.#validateRuntimeInventory();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const capture = await this.#metadata.captureSystemBackupState();
      const control = await this.#control();
      if (control.backup_sequence !== capture.eventSequence) continue;
      const base = await this.#base(baseCheckpoint, control, schemaDigest);
      const records = await systemBackupRecords(capture.snapshot);
      const delta = await systemBackupDelta(records, base.digests);
      const seeds = systemBackupObjectSeeds(capture.snapshot);
      const createdAt = this.#now().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + SESSION_LIFETIME_MS).toISOString();
      let inserted: Readonly<{ meta?: Readonly<{ changes?: number }> }>;
      try { inserted = await this.#database.prepare(
        `/*md-backup-session-register*/ INSERT INTO md_backup_sessions
         (session_id, origin_id, generation, base_sequence, base_digest,
          base_session_id, base_captured_at, base_schema_digest,
          mode, target_sequence, target_digest,
          invalidation_epoch, status,
          created_at, completed_at, expires_at, page_count, record_count, object_count,
          manifest_digest, schema_digest)
         SELECT ?1, origin_id, generation, ?2, ?3, ?4, ?17, ?18, ?5, ?6, ?7,
           invalidation_epoch, 'building', ?8, NULL, ?9, ?10, ?16, ?11, '', ?15
         FROM md_backup_control WHERE singleton_id = 1
           AND origin_id = ?12 AND generation = ?13 AND backup_sequence = ?6
           AND invalidation_epoch = ?14
           AND NOT EXISTS (SELECT 1 FROM md_backup_cleanup_ops)`,
      ).bind(sessionId, base.checkpoint?.sequence ?? null,
        base.checkpoint?.digest ?? null,
        base.checkpoint?.session_id ?? null, base.mode,
        capture.eventSequence, delta.targetDigest, createdAt, expiresAt,
        delta.pages.length, seeds.length, control.origin_id,
        control.generation, control.invalidation_epoch, schemaDigest,
        delta.recordDigests.size,
        base.checkpoint?.captured_at ?? null,
        base.checkpoint?.schema_digest ?? null).run(); }
      catch (error) {
        const prior = await this.#one<BackupSessionRow>(
          `/*md-backup-session-read*/ SELECT session_id, origin_id, generation,
           base_sequence, base_digest, base_session_id,
           base_captured_at, base_schema_digest, mode,
           target_sequence, target_digest,
           invalidation_epoch, status, created_at, completed_at, expires_at,
           page_count, record_count, object_count, manifest_digest, schema_digest
           FROM md_backup_sessions WHERE session_id = ?1`,
          sessionId,
        );
        if (prior !== null && prior.status === "building" &&
          prior.created_at === createdAt &&
          prior.target_sequence === capture.eventSequence &&
          prior.target_digest === delta.targetDigest &&
          prior.schema_digest === schemaDigest &&
          prior.base_session_id === (base.checkpoint?.session_id ?? null)) {
          // D1 may commit the registration and reject its response. Continue
          // constructing this exact target instead of stranding the pin.
          inserted = { meta: { changes: 1 } };
        } else if (prior !== null) {
          return this.#replaySession(prior, baseCheckpoint);
        } else {
          throw error;
        }
      }
      if (changes(inserted) !== 1) continue;
      try {
        const inventory = await this.#inventory(seeds);
        const manifestDigest = await systemBackupSha256(JSON.stringify({
          format: SYSTEM_BACKUP_FORMAT,
          schema_digest: schemaDigest,
          origin_id: control.origin_id,
          generation: control.generation,
          captured_at: createdAt,
          base_sequence: base.checkpoint?.sequence ?? null,
          base_digest: base.checkpoint?.digest ?? null,
          base_session_id: base.checkpoint?.session_id ?? null,
          target_sequence: capture.eventSequence,
          target_digest: delta.targetDigest,
          record_count: delta.recordDigests.size,
          page_hashes: delta.pages.map((page) => page.sha256),
          inventory: inventory.map((item) => [
            item.namespace, item.object_key, item.sha256,
            item.byte_size, item.media_type,
          ]),
        }));
        const statements: D1PreparedStatementLike[] = [];
        for (let start = 0; start < delta.pages.length; start += 6) {
          const chunk = delta.pages.slice(start, start + 6).map((page) => ({
            i: page.index, p: page.payload, h: page.sha256, b: page.byteSize,
          }));
          statements.push(this.#database.prepare(
            `/*md-backup-page-write*/ INSERT OR IGNORE INTO md_backup_pages
             (session_id, page_index, payload_json, sha256, byte_size)
             SELECT ?1, json_extract(value, '$.i'), json_extract(value, '$.p'),
               json_extract(value, '$.h'), json_extract(value, '$.b')
             FROM json_each(?2)`,
          ).bind(sessionId, JSON.stringify(chunk)));
        }
        const digests = [...delta.recordDigests];
        for (let start = 0; start < digests.length; start += 512) {
          const chunk = digests.slice(start, start + 512);
          statements.push(this.#database.prepare(
            `/*md-backup-digest-write*/ INSERT OR IGNORE INTO md_backup_record_digests
             (session_id, record_key, sha256)
             SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]')
             FROM json_each(?2)`,
          ).bind(sessionId, JSON.stringify(chunk)));
        }
        for (let start = 0; start < inventory.length; start += 256) {
          const chunk = inventory.slice(start, start + 256).map((item) => [
            item.object_index, item.namespace, item.object_key, item.sha256,
            item.byte_size, item.media_type,
          ]);
          statements.push(this.#database.prepare(
            `/*md-backup-inventory-write*/ INSERT OR IGNORE INTO md_backup_inventory
             (session_id, object_index, namespace, object_key,
              sha256, byte_size, media_type)
             SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
               json_extract(value, '$[2]'), json_extract(value, '$[3]'),
               json_extract(value, '$[4]'), json_extract(value, '$[5]')
             FROM json_each(?2)`,
          ).bind(sessionId, JSON.stringify(chunk)));
        }
        await this.#writeStatements(statements);
        const published = await this.#database.prepare(
          `/*md-backup-session-publish*/ UPDATE md_backup_sessions
           SET status = 'ready', manifest_digest = ?1
           WHERE session_id = ?2 AND status = 'building'
             AND expires_at > ?3 AND invalidation_epoch = (
               SELECT invalidation_epoch FROM md_backup_control WHERE singleton_id = 1
             )
             AND page_count = (SELECT COUNT(*) FROM md_backup_pages
               WHERE session_id = ?2)
             AND record_count = (SELECT COUNT(*) FROM md_backup_record_digests
               WHERE session_id = ?2)
             AND object_count = (SELECT COUNT(*) FROM md_backup_inventory
               WHERE session_id = ?2)
             AND NOT EXISTS (SELECT 1 FROM md_backup_cleanup_ops)`,
        ).bind(manifestDigest, sessionId, this.#now().toISOString()).run();
        if (changes(published) !== 1) {
          throw new SystemBackupFailure("backup_session_invalidated");
        }
        return descriptor(await this.#active(sessionId), base.mode, base.checkpoint);
      } catch (error) {
        await this.#database.prepare(
          `/*md-backup-session-abort*/ UPDATE md_backup_sessions
           SET status = 'invalidated' WHERE session_id = ?1 AND status = 'building'`,
        ).bind(sessionId).run().catch(() => undefined);
        throw error;
      }
    }
    throw new SystemBackupFailure("backup_target_changed");
  }

  async #replaySession(
    row: BackupSessionRow,
    requestedBase: SystemBackupCheckpoint | null,
  ): Promise<SystemBackupSessionDescriptor> {
    if (row.status === "building") {
      throw new SystemBackupFailure("backup_session_building");
    }
    if (row.status !== "ready" && row.status !== "completed") {
      throw new SystemBackupFailure("backup_session_inactive");
    }
    if (row.status === "ready") await this.#active(row.session_id);
    const base = await this.#baseCheckpoint(row);
    if (requestedBase === null && row.mode !== "baseline" ||
      requestedBase !== null && row.mode === "baseline" ||
      base !== null && requestedBase !== null &&
      (base.origin_id !== requestedBase.origin_id ||
       base.generation !== requestedBase.generation ||
       base.sequence !== requestedBase.sequence ||
       base.digest !== requestedBase.digest ||
       base.session_id !== requestedBase.session_id ||
       base.captured_at !== requestedBase.captured_at ||
       base.schema_digest !== requestedBase.schema_digest)) {
      throw new SystemBackupFailure("invalid_request_id_reuse");
    }
    return descriptor(row, row.mode, base);
  }

  async readSession(sessionId: string): Promise<SystemBackupSessionDescriptor> {
    const row = await this.#active(sessionId);
    return descriptor(row, row.mode, await this.#baseCheckpoint(row));
  }

  async #baseCheckpoint(row: BackupSessionRow): Promise<SystemBackupCheckpoint | null> {
    if (row.base_sequence === null) return null;
    if (row.base_session_id === null || row.base_digest === null ||
      row.base_captured_at === null || row.base_schema_digest === null) {
      throw new SystemBackupFailure("backup_base_corrupt");
    }
    return Object.freeze({
      origin_id: row.origin_id,
      generation: row.generation,
      sequence: row.base_sequence,
      digest: row.base_digest,
      session_id: row.base_session_id,
      captured_at: row.base_captured_at,
      schema_digest: row.base_schema_digest,
    });
  }

  async readPage(sessionId: string, index: number): Promise<Readonly<{
    index: number; payload: string; sha256: string; byte_size: number;
  }>> {
    const row = await this.#active(sessionId);
    if (safeIndex(index) >= row.page_count) throw new SystemBackupFailure("invalid_index");
    const page = await this.#one<{
      page_index: number; payload_json: string; sha256: string; byte_size: number;
    }>(`/*md-backup-page-read*/ SELECT page_index, payload_json, sha256, byte_size
       FROM md_backup_pages WHERE session_id = ?1 AND page_index = ?2`,
      row.session_id, index);
    if (page === null ||
      await systemBackupSha256(page.payload_json) !== page.sha256 ||
      new TextEncoder().encode(page.payload_json).byteLength !== page.byte_size) {
      throw new SystemBackupFailure("backup_page_corrupt");
    }
    await this.#active(sessionId);
    return Object.freeze({
      index, payload: page.payload_json,
      sha256: page.sha256, byte_size: page.byte_size,
    });
  }

  async listInventory(sessionId: string, cursor = 0, limit = MAX_INVENTORY_PAGE):
    Promise<Readonly<{ items: readonly SystemBackupInventoryItem[]; next_cursor: number | null }>> {
    const row = await this.#active(sessionId);
    if (safeIndex(cursor) > row.object_count || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > MAX_INVENTORY_PAGE) {
      throw new SystemBackupFailure("invalid_cursor");
    }
    const result = await this.#database.prepare(
      `/*md-backup-inventory-read*/ SELECT object_index, namespace,
       object_key, sha256, byte_size, media_type FROM md_backup_inventory
       WHERE session_id = ?1 AND object_index >= ?2
       ORDER BY object_index LIMIT ?3`,
    ).bind(sessionId, cursor, limit).all<SystemBackupInventoryItem>();
    const items = result.results ?? [];
    if (items.some((item, index) => item.object_index !== cursor + index)) {
      throw new SystemBackupFailure("backup_inventory_corrupt");
    }
    await this.#active(sessionId);
    return Object.freeze({
      items: Object.freeze([...items]),
      next_cursor: cursor + items.length < row.object_count
        ? cursor + items.length : null,
    });
  }

  async readPart(sessionId: string, index: number, offset: number, length: number):
    Promise<Readonly<{
      bytes: Uint8Array; sha256: string; object_sha256: string;
      offset: number; length: number; object_size: number;
    }>> {
    const row = await this.#active(sessionId);
    if (safeIndex(index) >= row.object_count || safeIndex(offset) < 0 ||
      !Number.isSafeInteger(length) || length < 1 || length > MAX_PART_BYTES) {
      throw new SystemBackupFailure("invalid_range");
    }
    const item = await this.#one<SystemBackupInventoryItem>(
      `/*md-backup-object-read*/ SELECT object_index, namespace, object_key,
       sha256, byte_size, media_type FROM md_backup_inventory
       WHERE session_id = ?1 AND object_index = ?2`,
      sessionId, index,
    );
    if (item === null || offset + length > item.byte_size) {
      throw new SystemBackupFailure("invalid_range");
    }
    const object = await this.#bucket.get(item.object_key, {
      range: { offset, length },
    });
    if (object === null || object.size !== item.byte_size ||
      object.range?.offset !== offset || object.range.length !== length ||
      object.customMetadata?.sha256 !== item.sha256) {
      await object?.body.cancel().catch(() => undefined);
      throw new SystemBackupFailure("backup_object_range_invalid");
    }
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > length) {
          await reader.cancel();
          throw new SystemBackupFailure("backup_object_range_invalid");
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    if (total !== length) throw new SystemBackupFailure("backup_object_range_invalid");
    const bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    await this.#active(sessionId);
    return Object.freeze({
      bytes, sha256: await systemBackupSha256(bytes),
      object_sha256: item.sha256,
      offset, length, object_size: item.byte_size,
    });
  }

  async complete(sessionId: string): Promise<Readonly<{
    checkpoint: SystemBackupCheckpoint; completed_at: string;
    manifest_digest: string;
  }>> {
    const row = await this.#session(sessionId);
    if (row.status === "completed" && row.completed_at !== null) {
      return Object.freeze({
        checkpoint: targetCheckpoint(row), completed_at: row.completed_at,
        manifest_digest: row.manifest_digest,
      });
    }
    const completedAt = this.#now().toISOString();
    const outcome = await this.#database.prepare(
      `/*md-backup-session-complete*/ UPDATE md_backup_sessions
       SET status = 'completed', completed_at = ?1
       WHERE session_id = ?2 AND status = 'ready' AND expires_at > ?1
         AND invalidation_epoch = (SELECT invalidation_epoch
           FROM md_backup_control WHERE singleton_id = 1)`,
    ).bind(completedAt, safeSessionId(sessionId)).run();
    if (changes(outcome) !== 1) {
      throw new SystemBackupFailure("backup_session_inactive");
    }
    const committed = await this.#session(sessionId);
    return Object.freeze({
      checkpoint: targetCheckpoint(committed), completed_at: completedAt,
      manifest_digest: committed.manifest_digest,
    });
  }

  async release(sessionId: string): Promise<void> {
    await this.#database.prepare(
      `/*md-backup-session-release*/ UPDATE md_backup_sessions
       SET status = 'released' WHERE session_id = ?1
         AND status IN ('building', 'ready')`,
    ).bind(safeSessionId(sessionId)).run();
  }
}
