import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, opendir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const FORMAT = "MD-SYSTEM-BACKUP-1";
const PREFIX = "/api/v1/internal/system-backup";
const PART_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const DIGEST = /^sha256:([0-9a-f]{64})$/u;

export class BackupClientError extends Error {
  constructor(code) { super(code); this.name = "BackupClientError"; this.code = code; }
}

function fail(code) { throw new BackupClientError(code); }
function exact(a, b, code) { if (a !== b) fail(code); }
function integer(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}
function digest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("invalid_digest");
  return value;
}
function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function backupObjectPath(directory, hash) {
  const hex = DIGEST.exec(digest(hash))[1];
  return join(directory, "objects", "sha256", hex.slice(0, 2), hex);
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { digest: `sha256:${hash.digest("hex")}`, bytes };
}

async function existingVerified(path, expectedDigest, expectedBytes) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== expectedBytes) return false;
    return (await hashFile(path)).digest === expectedDigest;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function openCatalog(directory) {
  const db = new DatabaseSync(join(directory, "catalog.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    db.exec(`
    CREATE TABLE IF NOT EXISTS backup_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      checkpoint_json TEXT NOT NULL, manifest_digest TEXT NOT NULL,
      inventory_digest TEXT NOT NULL,
      record_count INTEGER NOT NULL, object_count INTEGER NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backup_records (
      record_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL,
      part_count INTEGER NOT NULL CHECK(part_count > 0)
    );
    CREATE TABLE IF NOT EXISTS backup_record_parts (
      record_key TEXT NOT NULL, part_index INTEGER NOT NULL,
      data BLOB NOT NULL, PRIMARY KEY(record_key, part_index),
      FOREIGN KEY(record_key) REFERENCES backup_records(record_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS backup_inventory (
      object_index INTEGER PRIMARY KEY, namespace TEXT NOT NULL,
      object_key TEXT NOT NULL, sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL, media_type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backup_pending (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      request_id TEXT NOT NULL, base_json TEXT NOT NULL,
      descriptor_json TEXT, phase TEXT NOT NULL,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS backup_pending_pages (
      page_index INTEGER PRIMARY KEY, sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backup_pending_inventory (
      object_index INTEGER PRIMARY KEY, namespace TEXT NOT NULL,
      object_key TEXT NOT NULL, sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL, media_type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backup_partial (
      sha256 TEXT PRIMARY KEY, byte_size INTEGER NOT NULL,
      received_bytes INTEGER NOT NULL
    );
    `);
    const columns = db.prepare("PRAGMA table_info(backup_state)").all()
      .map((row) => row.name);
    if (!["checkpoint_json", "manifest_digest", "inventory_digest",
      "record_count", "object_count", "completed_at"]
      .every((name) => columns.includes(name))) fail("unsupported_catalog");
    return db;
  } catch (error) { db.close(); throw error; }
}

export async function openBackupCatalog(directory) {
  const oldUmask = process.umask(0o077);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink() ||
      (root.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && root.uid !== process.getuid())) {
      fail("insecure_directory");
    }
    await mkdir(join(directory, "objects", "sha256"), { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "staging"), { recursive: true, mode: 0o700 });
    for (const child of ["objects", join("objects", "sha256"), "staging"]) {
      const info = await lstat(join(directory, child));
      if (!info.isDirectory() || info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0) fail("insecure_directory");
    }
    try {
      const existing = await lstat(join(directory, "catalog.sqlite"));
      if (!existing.isFile() || existing.isSymbolicLink() ||
        (existing.mode & 0o077) !== 0) fail("insecure_catalog");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const db = openCatalog(directory);
    return { db, close() { db.close(); process.umask(oldUmask); } };
  } catch (error) { process.umask(oldUmask); throw error; }
}

function current(db) {
  const row = db.prepare("SELECT * FROM backup_state WHERE singleton=1").get();
  return row ? { ...row, checkpoint: JSON.parse(row.checkpoint_json) } : null;
}

export function backupStatus(db) {
  const state = current(db);
  const pending = db.prepare("SELECT phase, last_error FROM backup_pending WHERE singleton=1").get();
  return {
    last_success: state ? {
      sequence: state.checkpoint.sequence,
      captured_at: state.checkpoint.captured_at,
      completed_at: state.completed_at,
      record_count: state.record_count,
      object_count: state.object_count,
    } : null,
    integrity: state ? "not_checked" : "no_backup",
    pending: pending ? { phase: pending.phase, error: pending.last_error } : null,
  };
}

function endpoint(origin, suffix) {
  const base = new URL(origin);
  if (base.username || base.password || base.search || base.hash ||
    base.pathname !== "/" || !(
      base.protocol === "https:" ||
      (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    fail("invalid_origin");
  }
  return new URL(PREFIX + suffix, base).href;
}

async function boundedBody(response, limit) {
  if (!response.body) fail("empty_response");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) fail("response_too_large");
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

function transport({ origin, key, fetchImpl = fetch, metrics }) {
  if (!/^mdb_v1_[A-Za-z0-9_-]{43}$/u.test(key ?? "")) fail("invalid_operator_key");
  return async (method, suffix, body, maxBytes = MAX_JSON_BYTES) => {
    let response;
    try {
      response = await fetchImpl(endpoint(origin, suffix), {
        method, redirect: "error", cache: "no-store",
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { fail("transport_unavailable"); }
    if (!response.ok) {
      let code = "source_unavailable";
      try {
        const bytes = await boundedBody(response, 2048);
        const parsed = JSON.parse(bytes.toString("utf8"));
        if (/^[a-z_]{1,64}$/u.test(parsed?.code)) code = parsed.code;
      } catch { /* Preserve a safe error code. */ }
      fail(code);
    }
    if (response.status === 204) return { response, bytes: Buffer.alloc(0) };
    const bytes = await boundedBody(response, maxBytes);
    metrics.largestResponseBytes = Math.max(metrics.largestResponseBytes,
      bytes.byteLength);
    return { response, bytes };
  };
}

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("invalid_source_json"); }
}

function validateCheckpoint(value) {
  if (!value || typeof value !== "object" ||
    !/^[0-9a-f]{32}$/u.test(value.origin_id) ||
    !integer(value.generation, 1) || !integer(value.sequence) ||
    typeof value.session_id !== "string" ||
    typeof value.captured_at !== "string") fail("invalid_checkpoint");
  digest(value.digest); digest(value.schema_digest);
  return value;
}

function validateDescriptor(value, base, requestId) {
  if (!value || value.format !== FORMAT || value.session_id !== requestId ||
    !["baseline", "incremental", "rebaseline"].includes(value.mode) ||
    !integer(value.page_count, 1) || !integer(value.record_count) ||
    !integer(value.object_count) || typeof value.expires_at !== "string") {
    fail("invalid_descriptor");
  }
  validateCheckpoint(value.target_checkpoint);
  exact(value.target_checkpoint.session_id, requestId, "invalid_descriptor");
  exact(value.schema_digest, value.target_checkpoint.schema_digest, "invalid_descriptor");
  digest(value.manifest_digest);
  if (value.mode === "incremental") {
    if (!base || !sameJson(value.base_checkpoint, base)) fail("invalid_base");
  } else if (value.base_checkpoint !== null) fail("invalid_base");
  return value;
}

function pendingRow(db) {
  const row = db.prepare("SELECT * FROM backup_pending WHERE singleton=1").get();
  return row ? {
    ...row, base: JSON.parse(row.base_json),
    descriptor: row.descriptor_json ? JSON.parse(row.descriptor_json) : null,
  } : null;
}

function beginPending(db, base) {
  const requestId = randomUUID();
  db.prepare(`INSERT INTO backup_pending
    (singleton, request_id, base_json, descriptor_json, phase, last_error)
    VALUES (1, ?, ?, NULL, 'creating', NULL)`)
    .run(requestId, JSON.stringify(base));
  return pendingRow(db);
}

function clearPending(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DELETE FROM backup_pending_pages;
      DELETE FROM backup_pending_inventory;
      DELETE FROM backup_pending;`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

async function abandonPending(db, request) {
  const pending = pendingRow(db);
  if (pending?.descriptor?.session_id) {
    try { await request("DELETE", `/sessions/${pending.descriptor.session_id}`); }
    catch { /* A server lease expires even if release cannot be delivered. */ }
  }
  clearPending(db);
}

async function ensureDescriptor(db, request, pending) {
  if (pending.descriptor) return pending.descriptor;
  const { bytes } = await request("POST", "/sessions", {
    base_checkpoint: pending.base,
    request_id: pending.request_id,
  });
  const value = validateDescriptor(parseJson(bytes), pending.base, pending.request_id);
  db.prepare(`UPDATE backup_pending
    SET descriptor_json=?, phase='downloading', last_error=NULL WHERE singleton=1`)
    .run(JSON.stringify(value));
  return value;
}

async function fetchPages(db, request, descriptor) {
  const saved = db.prepare(`SELECT sha256, byte_size, payload_json
    FROM backup_pending_pages WHERE page_index=?`);
  const insert = db.prepare(`INSERT INTO backup_pending_pages
    (page_index, sha256, byte_size, payload_json) VALUES (?, ?, ?, ?)`);
  for (let index = 0; index < descriptor.page_count; index += 1) {
    const previous = saved.get(index);
    if (previous && Buffer.byteLength(previous.payload_json) === previous.byte_size &&
      sha(Buffer.from(previous.payload_json, "utf8")) === previous.sha256) continue;
    if (previous) db.prepare("DELETE FROM backup_pending_pages WHERE page_index=?").run(index);
    const { response, bytes } = await request("GET",
      `/sessions/${descriptor.session_id}/pages/${index}`, undefined, 128 * 1024);
    const expectedDigest = digest(response.headers.get("x-md-backup-sha256"));
    const expectedBytes = Number(response.headers.get("x-md-backup-byte-size"));
    if (!integer(expectedBytes) || expectedBytes !== bytes.byteLength ||
      sha(bytes) !== expectedDigest) fail("page_digest_mismatch");
    const payload = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const changes = parseJson(bytes);
    if (!Array.isArray(changes)) fail("invalid_page");
    insert.run(index, expectedDigest, expectedBytes, payload);
  }
  exact(db.prepare("SELECT COUNT(*) AS n FROM backup_pending_pages").get().n,
    descriptor.page_count, "page_count_mismatch");
}

function validateInventoryItem(item, index) {
  if (!item || item.object_index !== index ||
    !["immutable", "space_canonical", "bundle_file"].includes(item.namespace) ||
    typeof item.object_key !== "string" || item.object_key.length === 0 ||
    !integer(item.byte_size) || typeof item.media_type !== "string") {
    fail("invalid_inventory");
  }
  digest(item.sha256);
  return item;
}

async function fetchInventory(db, request, descriptor) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM backup_pending_inventory").get().n;
  if (count === descriptor.object_count) return;
  let cursor = count;
  const insert = db.prepare(`INSERT INTO backup_pending_inventory
    (object_index, namespace, object_key, sha256, byte_size, media_type)
    VALUES (?, ?, ?, ?, ?, ?)`);
  while (cursor < descriptor.object_count) {
    const { bytes } = await request("GET",
      `/sessions/${descriptor.session_id}/inventory?cursor=${cursor}&limit=128`);
    const result = parseJson(bytes);
    if (!result || !Array.isArray(result.items) ||
      result.items.length < 1 || result.items.length > 128 ||
      cursor + result.items.length > descriptor.object_count) fail("invalid_inventory");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of result.items) {
        validateInventoryItem(item, cursor);
        insert.run(item.object_index, item.namespace, item.object_key,
          item.sha256, item.byte_size, item.media_type);
        cursor += 1;
      }
      if (result.next_cursor !== (cursor < descriptor.object_count ? cursor : null)) {
        fail("invalid_inventory_cursor");
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  exact(cursor, descriptor.object_count, "inventory_count_mismatch");
}

async function downloadObject(db, request, directory, descriptor, item, onStage) {
  const target = backupObjectPath(directory, item.sha256);
  if (await existingVerified(target, item.sha256, item.byte_size)) return false;
  const hex = DIGEST.exec(item.sha256)[1];
  const partial = join(directory, "staging", `${hex}.partial`);
  let progress = db.prepare("SELECT * FROM backup_partial WHERE sha256=?").get(item.sha256);
  if (progress && progress.byte_size !== item.byte_size) fail("object_identity_conflict");
  if (!progress) {
    db.prepare("INSERT INTO backup_partial VALUES (?, ?, 0)")
      .run(item.sha256, item.byte_size);
    progress = { received_bytes: 0, byte_size: item.byte_size };
  }
  let handle;
  try { handle = await open(partial, "r+"); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    handle = await open(partial, "w+", 0o600);
  }
  try {
    const info = await handle.stat();
    if (info.size < progress.received_bytes) {
      await handle.truncate(0);
      await handle.sync();
      db.prepare("UPDATE backup_partial SET received_bytes=0 WHERE sha256=?")
        .run(item.sha256);
      progress = { ...progress, received_bytes: 0 };
    }
    if (info.size > progress.received_bytes) {
      await handle.truncate(progress.received_bytes);
      await handle.sync();
    }
    let offset = progress.received_bytes;
    while (offset < item.byte_size) {
      const length = Math.min(PART_BYTES, item.byte_size - offset);
      const { response, bytes } = await request("GET",
        `/sessions/${descriptor.session_id}/objects/${item.object_index}` +
        `?offset=${offset}&length=${length}`, undefined, PART_BYTES);
      exact(response.status, 206, "invalid_part_status");
      exact(bytes.byteLength, length, "invalid_part_length");
      exact(response.headers.get("content-range"),
        `bytes ${offset}-${offset + length - 1}/${item.byte_size}`,
        "invalid_part_range");
      exact(digest(response.headers.get("x-md-backup-object-sha256")),
        item.sha256, "invalid_part_object");
      exact(sha(bytes), digest(response.headers.get("x-md-backup-part-sha256")),
        "part_digest_mismatch");
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(bytes, written, bytes.byteLength - written,
          offset + written);
        if (result.bytesWritten < 1) fail("partial_write_failed");
        written += result.bytesWritten;
      }
      await handle.sync();
      await onStage("after_part_fsync");
      offset += length;
      db.prepare("UPDATE backup_partial SET received_bytes=? WHERE sha256=?")
        .run(offset, item.sha256);
    }
    await handle.sync();
  } finally { await handle.close(); }
  if (!(await existingVerified(partial, item.sha256, item.byte_size))) {
    await unlink(partial);
    await fsyncDirectory(join(directory, "staging"));
    db.prepare("DELETE FROM backup_partial WHERE sha256=?").run(item.sha256);
    fail("object_digest_mismatch");
  }
  const parent = join(directory, "objects", "sha256", hex.slice(0, 2));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await onStage("before_object_rename");
  await rename(partial, target);
  await fsyncDirectory(parent);
  db.prepare("DELETE FROM backup_partial WHERE sha256=?").run(item.sha256);
  return true;
}

async function fetchObjects(db, request, directory, descriptor, onStage) {
  let downloaded = 0;
  const rows = db.prepare(`SELECT * FROM backup_pending_inventory
    ORDER BY object_index`).iterate();
  for (const item of rows) {
    if (await downloadObject(db, request, directory, descriptor, item, onStage)) downloaded += 1;
  }
  return downloaded;
}

function manifestDigest(db, descriptor) {
  const target = descriptor.target_checkpoint;
  const base = descriptor.base_checkpoint;
  const hash = createHash("sha256");
  const prefix = {
    format: FORMAT,
    schema_digest: descriptor.schema_digest,
    origin_id: target.origin_id,
    generation: target.generation,
    captured_at: target.captured_at,
    base_sequence: base?.sequence ?? null,
    base_digest: base?.digest ?? null,
    base_session_id: base?.session_id ?? null,
    target_sequence: target.sequence,
    target_digest: target.digest,
    record_count: descriptor.record_count,
  };
  hash.update(JSON.stringify(prefix).slice(0, -1));
  hash.update(',"page_hashes":[');
  let index = 0;
  for (const row of db.prepare(`SELECT page_index, sha256 FROM backup_pending_pages
      ORDER BY page_index`).iterate()) {
    exact(row.page_index, index, "page_count_mismatch");
    hash.update((index ? "," : "") + JSON.stringify(row.sha256));
    index += 1;
  }
  exact(index, descriptor.page_count, "page_count_mismatch");
  hash.update('],"inventory":[');
  index = 0;
  for (const row of db.prepare(`SELECT * FROM backup_pending_inventory
      ORDER BY object_index`).iterate()) {
    exact(row.object_index, index, "inventory_count_mismatch");
    hash.update((index ? "," : "") + JSON.stringify([
      row.namespace, row.object_key, row.sha256, row.byte_size, row.media_type,
    ]));
    index += 1;
  }
  exact(index, descriptor.object_count, "inventory_count_mismatch");
  hash.update("]}");
  return `sha256:${hash.digest("hex")}`;
}

function rootDigest(db) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ format: FORMAT }).slice(0, -1));
  hash.update(',"records":[');
  let index = 0;
  for (const row of db.prepare(`SELECT record_key, sha256 FROM backup_records
      ORDER BY record_key COLLATE BINARY`).iterate()) {
    hash.update((index ? "," : "") + JSON.stringify([row.record_key, row.sha256]));
    index += 1;
  }
  hash.update("]}");
  return { digest: `sha256:${hash.digest("hex")}`, count: index };
}

function inventoryDigest(db) {
  const hash = createHash("sha256");
  hash.update("[");
  let index = 0;
  for (const item of db.prepare(`SELECT * FROM backup_inventory
      ORDER BY object_index`).iterate()) {
    exact(item.object_index, index, "inventory_count_mismatch");
    hash.update((index ? "," : "") + JSON.stringify([
      item.object_index, item.namespace, item.object_key,
      item.sha256, item.byte_size, item.media_type,
    ]));
    index += 1;
  }
  hash.update("]");
  return { digest: `sha256:${hash.digest("hex")}`, count: index };
}

function verifyRecordParts(db) {
  for (const record of db.prepare(`SELECT record_key, sha256, part_count
      FROM backup_records ORDER BY record_key`).iterate()) {
    recordKey(record.record_key);
    digest(record.sha256);
    if (!integer(record.part_count, 1)) fail("record_parts_incomplete");
    const hash = createHash("sha256");
    let index = 0;
    for (const part of db.prepare(`SELECT part_index, data
        FROM backup_record_parts WHERE record_key=? ORDER BY part_index`)
      .iterate(record.record_key)) {
      exact(part.part_index, index, "record_parts_incomplete");
      hash.update(part.data);
      index += 1;
    }
    exact(index, record.part_count, "record_parts_incomplete");
    exact(`sha256:${hash.digest("hex")}`, record.sha256,
      "record_digest_mismatch");
  }
}

function verifyCatalogMetadata(db, state) {
  const root = rootDigest(db);
  exact(root.digest, state.checkpoint.digest, "root_digest_mismatch");
  exact(root.count, state.record_count, "record_count_mismatch");
  const inventory = inventoryDigest(db);
  exact(inventory.digest, state.inventory_digest, "inventory_digest_mismatch");
  exact(inventory.count, state.object_count, "inventory_count_mismatch");
  verifyRecordParts(db);
}

function recordKey(value) {
  if (typeof value !== "string") fail("invalid_record_key");
  let parts;
  try { parts = JSON.parse(value); } catch { fail("invalid_record_key"); }
  if (!Array.isArray(parts) || parts.length !== 2 ||
    typeof parts[0] !== "string" || typeof parts[1] !== "string" ||
    ![
      "spaces", "revisionsById", "auditEvents", "principals",
      "externalBindings", "knowledgeSpaces", "personalBindings",
      "memberships", "principalMindUsageOwners", "activeHandlesByKey",
      "activeHandlesBySpace", "retiredHandles",
    ].includes(parts[0]) || JSON.stringify(parts) !== value) fail("invalid_record_key");
  return value;
}

function decodedPart(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("invalid_record_part");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.byteLength > 64 * 1024) {
    fail("invalid_record_part");
  }
  return bytes;
}

function applyVerifiedPages(db, descriptor, receipt, onStage) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (descriptor.mode !== "incremental") db.exec("DELETE FROM backup_records");
    db.exec(`DROP TABLE IF EXISTS temp.backup_change_parts;
      DROP TABLE IF EXISTS temp.backup_deletes;
      CREATE TEMP TABLE backup_change_parts (
        record_key TEXT NOT NULL, part_index INTEGER NOT NULL,
        part_count INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(record_key, part_index)
      );
      CREATE TEMP TABLE backup_deletes (record_key TEXT PRIMARY KEY);`);
    for (const page of db.prepare(`SELECT * FROM backup_pending_pages
        ORDER BY page_index`).iterate()) {
      exact(sha(Buffer.from(page.payload_json, "utf8")), page.sha256,
        "page_digest_mismatch");
      exact(Buffer.byteLength(page.payload_json), page.byte_size,
        "page_length_mismatch");
      let changes;
      try { changes = JSON.parse(page.payload_json); }
      catch { fail("invalid_page"); }
      if (!Array.isArray(changes)) fail("invalid_page");
      for (const change of changes) {
        if (!change || typeof change !== "object") fail("invalid_page");
        const key = recordKey(change.key);
        if (change.kind === "delete") {
          db.prepare("INSERT INTO temp.backup_deletes VALUES (?)").run(key);
        } else if (change.kind === "upsert" &&
          integer(change.part_index) && integer(change.part_count, 1) &&
          change.part_index < change.part_count) {
          db.prepare(`INSERT INTO temp.backup_change_parts
            VALUES (?, ?, ?, ?, ?)`)
            .run(key, change.part_index, change.part_count,
              digest(change.sha256), decodedPart(change.data_base64));
        } else fail("invalid_page");
      }
    }
    if (db.prepare(`SELECT 1 FROM temp.backup_deletes d
      JOIN temp.backup_change_parts p ON p.record_key=d.record_key LIMIT 1`).get()) {
      fail("conflicting_record_change");
    }
    for (const row of db.prepare("SELECT record_key FROM temp.backup_deletes").iterate()) {
      db.prepare("DELETE FROM backup_records WHERE record_key=?").run(row.record_key);
    }
    const groups = db.prepare(`SELECT record_key, MIN(part_count) AS part_count,
      MAX(part_count) AS max_parts, MIN(sha256) AS sha256,
      MAX(sha256) AS max_sha, COUNT(*) AS n
      FROM temp.backup_change_parts GROUP BY record_key ORDER BY record_key`);
    for (const group of groups.iterate()) {
      if (group.part_count !== group.max_parts || group.sha256 !== group.max_sha ||
        group.n !== group.part_count) fail("record_parts_incomplete");
      const hash = createHash("sha256");
      let index = 0;
      for (const part of db.prepare(`SELECT part_index, data
        FROM temp.backup_change_parts WHERE record_key=? ORDER BY part_index`)
        .iterate(group.record_key)) {
        exact(part.part_index, index, "record_parts_incomplete");
        hash.update(part.data);
        index += 1;
      }
      exact(`sha256:${hash.digest("hex")}`, group.sha256, "record_digest_mismatch");
      db.prepare("DELETE FROM backup_records WHERE record_key=?").run(group.record_key);
      db.prepare("INSERT INTO backup_records VALUES (?, ?, ?)")
        .run(group.record_key, group.sha256, group.part_count);
      db.prepare(`INSERT INTO backup_record_parts (record_key, part_index, data)
        SELECT record_key, part_index, data FROM temp.backup_change_parts
        WHERE record_key=? ORDER BY part_index`).run(group.record_key);
    }
    const root = rootDigest(db);
    exact(root.count, descriptor.record_count, "record_count_mismatch");
    exact(root.digest, descriptor.target_checkpoint.digest, "root_digest_mismatch");
    db.exec("DELETE FROM backup_inventory");
    db.exec(`INSERT INTO backup_inventory
      SELECT object_index, namespace, object_key, sha256, byte_size, media_type
      FROM backup_pending_inventory ORDER BY object_index`);
    const inventory = inventoryDigest(db);
    exact(inventory.count, descriptor.object_count, "inventory_count_mismatch");
    db.prepare(`INSERT INTO backup_state
      (singleton, checkpoint_json, manifest_digest, inventory_digest, record_count,
        object_count, completed_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        checkpoint_json=excluded.checkpoint_json,
        manifest_digest=excluded.manifest_digest,
        inventory_digest=excluded.inventory_digest,
        record_count=excluded.record_count,
        object_count=excluded.object_count,
        completed_at=excluded.completed_at`)
      .run(JSON.stringify(receipt.checkpoint), descriptor.manifest_digest,
        inventory.digest,
        descriptor.record_count, descriptor.object_count, receipt.completed_at);
    db.exec(`DELETE FROM backup_pending_pages;
      DELETE FROM backup_pending_inventory;
      DELETE FROM backup_pending;`);
    onStage("before_catalog_commit");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

async function verifyStaged(db, directory, descriptor) {
  exact(manifestDigest(db, descriptor), descriptor.manifest_digest,
    "manifest_digest_mismatch");
  for (const page of db.prepare(`SELECT sha256, byte_size, payload_json
      FROM backup_pending_pages ORDER BY page_index`).iterate()) {
    exact(Buffer.byteLength(page.payload_json), page.byte_size,
      "page_length_mismatch");
    exact(sha(Buffer.from(page.payload_json, "utf8")), page.sha256,
      "page_digest_mismatch");
  }
  for (const row of db.prepare(`SELECT sha256, byte_size
      FROM backup_pending_inventory ORDER BY object_index`).iterate()) {
    if (!(await existingVerified(backupObjectPath(directory, row.sha256),
      row.sha256, row.byte_size))) fail("object_closure_incomplete");
  }
}

export async function runBackup({ directory, origin, key, fetchImpl = fetch,
  onStage = () => {} }) {
  const catalog = await openBackupCatalog(directory);
  const db = catalog.db;
  const metrics = { largestResponseBytes: 0,
    observedPeakRssBytes: process.memoryUsage().rss };
  const sample = () => { metrics.observedPeakRssBytes = Math.max(
    metrics.observedPeakRssBytes, process.memoryUsage().rss); };
  const sampler = setInterval(sample, 10);
  sampler.unref();
  try {
    const request = transport({ origin, key, fetchImpl, metrics });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const stored = current(db);
        let base = stored?.checkpoint ?? null;
        if (stored) {
          try { verifyCatalogMetadata(db, stored); }
          catch (error) {
            if (!(error instanceof BackupClientError)) throw error;
            base = null;
          }
        }
        let pending = pendingRow(db);
        if (pending && !sameJson(pending.base, base)) {
          await abandonPending(db, request);
          pending = null;
        }
        if (!pending) pending = beginPending(db, base);
        const descriptor = await ensureDescriptor(db, request, pending);
        // A completion response can be lost after the source committed it.
        // Once every byte is staged, repeat completion without reading pages.
        if (pending.phase !== "ready_to_complete") {
          await fetchPages(db, request, descriptor);
          await fetchInventory(db, request, descriptor);
        }
        const downloaded = pending.phase === "ready_to_complete" ? 0
          : await fetchObjects(db, request, directory, descriptor, onStage);
        await verifyStaged(db, directory, descriptor);
        db.prepare(`UPDATE backup_pending SET phase='ready_to_complete',
          last_error=NULL WHERE singleton=1`).run();
        const { bytes } = await request("POST",
          `/sessions/${descriptor.session_id}/complete`);
        const receipt = parseJson(bytes);
        if (!receipt || !sameJson(receipt.checkpoint, descriptor.target_checkpoint) ||
          receipt.manifest_digest !== descriptor.manifest_digest ||
          typeof receipt.completed_at !== "string") fail("invalid_receipt");
        await onStage("after_receipt_before_catalog");
        applyVerifiedPages(db, descriptor, receipt, onStage);
        sample();
        return { ...backupStatus(db), downloaded_objects: downloaded,
          transferred_pages: descriptor.page_count, mode: descriptor.mode,
          largest_response_bytes: metrics.largestResponseBytes,
          observed_peak_rss_bytes: metrics.observedPeakRssBytes };
      } catch (error) {
        if (attempt === 0 && error instanceof BackupClientError &&
          ["backup_session_inactive", "backup_session_not_found",
            "backup_session_invalidated", "backup_target_changed",
            "page_digest_mismatch", "page_length_mismatch",
            "manifest_digest_mismatch"].includes(error.code)) {
          await abandonPending(db, request);
          continue;
        }
        throw error;
      }
    }
    fail("backup_retry_exhausted");
  } catch (error) {
    const code = error instanceof BackupClientError ? error.code : "local_failure";
    db.prepare("UPDATE backup_pending SET last_error=? WHERE singleton=1").run(code);
    throw error;
  } finally { clearInterval(sampler); catalog.close(); }
}

export async function checkBackupIntegrity({ directory }) {
  const catalog = await openBackupCatalog(directory);
  try {
    const state = current(catalog.db);
    if (!state) fail("no_successful_backup");
    verifyCatalogMetadata(catalog.db, state);
    const root = rootDigest(catalog.db);
    let objects = 0;
    for (const item of catalog.db.prepare(`SELECT * FROM backup_inventory
        ORDER BY object_index`).iterate()) {
      exact(item.object_index, objects, "inventory_count_mismatch");
      if (!(await existingVerified(backupObjectPath(directory, item.sha256),
        item.sha256, item.byte_size))) fail("object_closure_incomplete");
      objects += 1;
    }
    exact(objects, state.object_count, "inventory_count_mismatch");
    return { ok: true, record_count: root.count, object_count: objects,
      sequence: state.checkpoint.sequence };
  } finally { catalog.close(); }
}

export async function collectBackupGarbage({ directory, onStage = () => {} }) {
  const catalog = await openBackupCatalog(directory);
  const db = catalog.db;
  try {
    if (pendingRow(db)) fail("pending_backup_exists");
    // Only the content-addressed tree created by this client is traversed.
    let removed = 0;
    for await (const entry of await opendir(join(directory, "objects", "sha256"))) {
      if (!entry.isDirectory() || !/^[0-9a-f]{2}$/u.test(entry.name)) {
        fail("unknown_object_directory");
      }
      const parent = join(directory, "objects", "sha256", entry.name);
      for await (const file of await opendir(parent)) {
        const name = file.name;
        if (!file.isFile() || !/^[0-9a-f]{64}$/u.test(name) ||
          !name.startsWith(entry.name)) {
          fail("unknown_object_file");
        }
        if (!db.prepare("SELECT 1 FROM backup_inventory WHERE sha256=? LIMIT 1")
          .get(`sha256:${name}`)) {
          await onStage("before_gc_delete");
          await unlink(join(parent, name));
          removed += 1;
        }
      }
      await fsyncDirectory(parent);
    }
    for await (const entry of await opendir(join(directory, "staging"))) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.partial$/u.test(entry.name)) {
        fail("unknown_staging_file");
      }
      await unlink(join(directory, "staging", entry.name));
      db.prepare("DELETE FROM backup_partial WHERE sha256=?")
        .run(`sha256:${entry.name.slice(0, 64)}`);
    }
    db.exec("DELETE FROM backup_partial");
    await fsyncDirectory(join(directory, "staging"));
    return { removed_objects: removed };
  } finally { catalog.close(); }
}
