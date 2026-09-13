import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat,
  writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BackupClientError, backupObjectPath, checkBackupIntegrity,
  openBackupCatalog } from "./system-backup-client.mjs";

const FORMAT = "MD-SYSTEM-BACKUP-1";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FIELDS = Object.freeze([
  "spaces", "revisionsById", "auditEvents", "principals",
  "externalBindings", "knowledgeSpaces", "personalBindings", "memberships",
  "principalMindUsageOwners", "activeHandlesByKey",
  "activeHandlesBySpace", "retiredHandles",
]);
const MARKDOWN = "text/markdown; charset=utf-8";
const MANIFEST = "application/vnd.mind-diary.revision-manifest+json; charset=utf-8";

function fail(code) { throw new BackupClientError(code); }
function required(condition, code) { if (!condition) fail(code); }
function isObject(value) { return value !== null && typeof value === "object" &&
  !Array.isArray(value); }
function safeDigest(value) { required(typeof value === "string" && DIGEST.test(value),
  "restore_invalid_digest"); return value; }
function safeId(value) { required(typeof value === "string" && value.length > 0 &&
  value.length <= 512, "restore_invalid_id"); return value; }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  const type = value.__md_backup_type;
  if (type === "undefined" && keys.length === 1) return undefined;
  if (type === "uint8array" && keys.length === 2 &&
    Array.isArray(value.bytes) && value.bytes.every((byte) =>
      Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return new Uint8Array(value.bytes);
  }
  if (type === "set" && keys.length === 2 && Array.isArray(value.values)) {
    const items = value.values.map(decode);
    required(new Set(items).size === items.length, "restore_invalid_value");
    return new Set(items);
  }
  if ((type === "map" || type === "object") && keys.length === 2 &&
    Array.isArray(value.entries)) {
    const pairs = value.entries.map((entry) => {
      required(Array.isArray(entry) && entry.length === 2, "restore_invalid_value");
      return [decode(entry[0]), decode(entry[1])];
    });
    if (type === "map") {
      const result = new Map(pairs);
      required(result.size === pairs.length, "restore_invalid_value");
      return result;
    }
    const result = {};
    for (const [key, item] of pairs) {
      required(typeof key === "string" && !Object.hasOwn(result, key),
        "restore_invalid_value");
      Object.defineProperty(result, key, { value: item, enumerable: true,
        writable: true, configurable: true });
    }
    return result;
  }
  fail("restore_invalid_value");
}

function recordPayload(db, key) {
  const row = db.prepare("SELECT sha256, part_count FROM backup_records WHERE record_key=?")
    .get(key);
  required(row, "restore_missing_record");
  const hash = createHash("sha256");
  const parts = [];
  let index = 0;
  for (const part of db.prepare(`SELECT part_index, data FROM backup_record_parts
      WHERE record_key=? ORDER BY part_index`).iterate(key)) {
    required(part.part_index === index, "restore_record_parts_incomplete");
    hash.update(part.data);
    parts.push(part.data);
    index += 1;
  }
  required(index === row.part_count && `sha256:${hash.digest("hex")}` === row.sha256,
    "restore_record_digest_mismatch");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.concat(parts))); }
  catch { fail("restore_record_invalid_json"); }
  return decode(parsed);
}

function loadRecords(db) {
  const result = Object.fromEntries(FIELDS.map((field) => [field, new Map()]));
  for (const row of db.prepare(`SELECT record_key FROM backup_records
      ORDER BY record_key`).iterate()) {
    let pair;
    try { pair = JSON.parse(row.record_key); }
    catch { fail("restore_invalid_record_key"); }
    required(Array.isArray(pair) && pair.length === 2 &&
      FIELDS.includes(pair[0]) && typeof pair[1] === "string" &&
      JSON.stringify(pair) === row.record_key, "restore_invalid_record_key");
    result[pair[0]].set(pair[1], recordPayload(db, row.record_key));
  }
  return result;
}

function expectedInventory(records) {
  const expected = new Map();
  const add = (key, namespace, sha256, byteSize, mediaType, fallback = null) => {
    safeDigest(sha256);
    required((count(byteSize) || byteSize === -1) && typeof mediaType === "string" &&
      mediaType.length > 0, "restore_invalid_inventory");
    const prior = expected.get(key);
    if (prior) {
      required(prior.sha256 === sha256 && prior.byte_size === byteSize &&
        prior.media_type === mediaType && prior.namespace === namespace,
      "restore_conflicting_inventory");
    } else expected.set(key, { namespace, object_key: key, sha256,
      byte_size: byteSize, media_type: mediaType, fallback });
  };
  for (const envelope of records.revisionsById.values()) {
    required(isObject(envelope) && isObject(envelope.revision) &&
      isObject(envelope.manifest) && Array.isArray(envelope.manifest.entries),
    "restore_invalid_revision");
    const revision = envelope.revision;
    const manifest = envelope.manifest;
    const modern = manifest.format === "mind-diary-revision-manifest-v3" ||
      manifest.format === "mind-diary-revision-manifest-v4";
    if (modern) {
      add(`spaces/${encodeURIComponent(revision.spaceId)}/manifests/sha256/` +
        revision.manifestHash.slice(7), "space_canonical", revision.manifestHash,
      revision.manifestSize, MANIFEST);
    }
    for (const entry of manifest.entries) {
      if (entry.kind === "opaque") {
        add(`bundle-files/${encodeURIComponent(revision.spaceId)}/sha256/` +
          entry.sha256.slice(7), "bundle_file", entry.sha256,
        entry.size, entry.mediaType);
      } else if (modern) {
        add(`spaces/${encodeURIComponent(revision.spaceId)}/objects/sha256/` +
          entry.sha256.slice(7), "space_canonical", entry.sha256,
        entry.size, MARKDOWN,
        `canonical/sha256/${entry.sha256.slice(7)}`);
      } else {
        add(`canonical/sha256/${entry.sha256.slice(7)}`, "immutable",
          entry.sha256, entry.size, MARKDOWN);
      }
    }
  }
  return expected;
}

function validateRecords(records, inventory) {
  const { principals, knowledgeSpaces, spaces, revisionsById, memberships,
    personalBindings, externalBindings, principalMindUsageOwners,
    activeHandlesByKey, activeHandlesBySpace } = records;
  required(spaces.size === knowledgeSpaces.size, "restore_space_count_mismatch");
  for (const [id, principal] of principals) {
    required(isObject(principal) && principal.principalId === id &&
      principal.state === "active", "restore_invalid_principal");
  }
  for (const [id, binding] of externalBindings) {
    required(isObject(binding) && binding.bindingId === id &&
      principals.has(binding.principalId) &&
      ["active", "revoked"].includes(binding.state),
    "restore_invalid_identity_binding");
  }
  for (const [id, space] of knowledgeSpaces) {
    required(isObject(space) && space.spaceId === id && space.state === "active" &&
      ["private", "unlisted", "public"].includes(space.visibility) &&
      typeof space.name === "string" && space.name.length > 0 &&
      safeId(space.headRevisionId) &&
      spaces.get(id)?.head === space.headRevisionId,
    "restore_invalid_space");
  }
  const bySpace = new Map([...knowledgeSpaces.keys()].map((id) => [id, new Map()]));
  for (const [id, envelope] of revisionsById) {
    required(isObject(envelope) && isObject(envelope.revision) &&
      isObject(envelope.manifest), "restore_invalid_revision");
    const revision = envelope.revision;
    const manifest = envelope.manifest;
    required(revision.revisionId === id && knowledgeSpaces.has(revision.spaceId) &&
      count(revision.revisionNumber) && revision.revisionNumber > 0 &&
      (revision.parentRevisionId === null ||
        typeof revision.parentRevisionId === "string") &&
      safeDigest(revision.manifestHash) &&
      ["mind-diary-revision-manifest-v1", "mind-diary-revision-manifest-v2",
        "mind-diary-revision-manifest-v3", "mind-diary-revision-manifest-v4"]
        .includes(manifest.format) && Array.isArray(manifest.entries),
    "restore_invalid_revision");
    const paths = new Set();
    for (const entry of manifest.entries) {
      required(isObject(entry) && ["markdown", "opaque"].includes(entry.kind) &&
        typeof entry.path === "string" && entry.path.length > 0 &&
        !entry.path.startsWith("/") &&
        !entry.path.split("/").some((piece) =>
          piece === "" || piece === "." || piece === "..") &&
        !entry.path.includes("\\") && !entry.path.includes("\0") &&
        !paths.has(entry.path) && safeDigest(entry.sha256) &&
        count(entry.size) && typeof entry.mediaType === "string" &&
        (entry.kind !== "markdown" || entry.mediaType === MARKDOWN),
      "restore_invalid_file_entry");
      paths.add(entry.path);
    }
    bySpace.get(revision.spaceId).set(id, revision);
  }
  for (const [spaceId, revisions] of bySpace) {
    const head = knowledgeSpaces.get(spaceId).headRevisionId;
    let current = head;
    const seen = new Set();
    while (current !== null) {
      const revision = revisions.get(current);
      required(revision && !seen.has(current), "restore_invalid_revision_chain");
      seen.add(current);
      const parent = revision.parentRevisionId;
      if (parent !== null) {
        const predecessor = revisions.get(parent);
        required(predecessor &&
          predecessor.revisionNumber + 1 === revision.revisionNumber,
          "restore_invalid_revision_chain");
      } else required(revision.revisionNumber === 1,
        "restore_invalid_revision_chain");
      current = parent;
    }
    required(seen.size === revisions.size, "restore_invalid_revision_chain");
  }
  const owners = new Map([...knowledgeSpaces.keys()].map((id) => [id, []]));
  for (const [id, member] of memberships) {
    required(isObject(member) && member.membershipId === id &&
      knowledgeSpaces.has(member.spaceId) && principals.has(member.principalId) &&
      ["active", "revoked"].includes(member.state) &&
      ["reader", "editor", "admin", "owner"].includes(member.role),
    "restore_invalid_membership");
    if (member.state === "active" && member.role === "owner") {
      owners.get(member.spaceId).push(member.principalId);
    }
  }
  for (const ownerIds of owners.values()) {
    required(ownerIds.length === 1, "restore_invalid_owner");
  }
  const personalSpaces = new Set();
  required(personalBindings.size === principals.size,
    "restore_invalid_personal_binding");
  for (const [principalId, binding] of personalBindings) {
    required(principals.has(principalId) && isObject(binding) &&
      binding.principalId === principalId && knowledgeSpaces.has(binding.spaceId) &&
      !personalSpaces.has(binding.spaceId) &&
      knowledgeSpaces.get(binding.spaceId).visibility === "private" &&
      owners.get(binding.spaceId)[0] === principalId,
    "restore_invalid_personal_binding");
    personalSpaces.add(binding.spaceId);
  }
  for (const [principalId, usage] of principalMindUsageOwners) {
    required(principals.has(principalId) && isObject(usage),
      "restore_invalid_usage");
  }
  required(activeHandlesByKey.size === activeHandlesBySpace.size,
    "restore_invalid_handle_registry");
  for (const [spaceId, reservation] of activeHandlesBySpace) {
    required(knowledgeSpaces.has(spaceId) && isObject(reservation) &&
      reservation.spaceId === spaceId &&
      typeof reservation.host === "string" && reservation.host.length > 0 &&
      reservation.canonicalHandle === knowledgeSpaces.get(spaceId).spaceHandle &&
      activeHandlesByKey.get(`${reservation.host}\0${reservation.canonicalHandle}`)
        ?.spaceId === spaceId,
    "restore_invalid_handle_registry");
  }
  for (const [key, reservation] of activeHandlesByKey) {
    required(isObject(reservation) &&
      key === `${reservation.host}\0${reservation.canonicalHandle}` &&
      activeHandlesBySpace.get(reservation.spaceId)?.spaceId ===
        reservation.spaceId, "restore_invalid_handle_registry");
  }
  const expected = expectedInventory(records);
  const sorted = [...expected.values()].sort((left, right) =>
    left.object_key < right.object_key ? -1
      : left.object_key > right.object_key ? 1 : 0);
  required(sorted.length === inventory.length, "restore_object_closure_mismatch");
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    const actual = inventory[index];
    required(actual && actual.object_index === index &&
      (actual.object_key === item.object_key ||
        actual.object_key === item.fallback) &&
      actual.sha256 === item.sha256 &&
      (item.byte_size === -1 || actual.byte_size === item.byte_size) &&
      actual.media_type === item.media_type &&
      actual.namespace === (actual.object_key === item.fallback
        ? "immutable" : item.namespace),
    "restore_object_closure_mismatch");
  }
}

async function validateManifestBytes(directory, records) {
  for (const envelope of records.revisionsById.values()) {
    const { revision, manifest } = envelope;
    const entries = manifest.entries.map((entry) => ({
      path: entry.path,
      ...(manifest.format === "mind-diary-revision-manifest-v1"
        ? {} : { kind: entry.kind }),
      sha256: entry.sha256, media_type: entry.mediaType, size: entry.size,
    }));
    const canonical = Buffer.from(`${JSON.stringify({
      format: manifest.format, entries })}\n`);
    required(digestBytes(canonical) === revision.manifestHash &&
      (revision.manifestSize === undefined ||
        revision.manifestSize === canonical.byteLength),
    "restore_manifest_record_mismatch");
    if (["mind-diary-revision-manifest-v3",
      "mind-diary-revision-manifest-v4"].includes(manifest.format)) {
      const stored = await readFile(backupObjectPath(directory,
        revision.manifestHash));
      required(stored.equals(canonical), "restore_manifest_bytes_mismatch");
    }
  }
}

function inventoryFrom(db) {
  const items = [];
  for (const item of db.prepare(`SELECT * FROM backup_inventory
      ORDER BY object_index`).iterate()) {
    required(item.object_index === items.length &&
      ["immutable", "space_canonical", "bundle_file"].includes(item.namespace) &&
      typeof item.object_key === "string" && safeDigest(item.sha256) &&
      count(item.byte_size) && typeof item.media_type === "string",
    "restore_invalid_inventory");
    items.push(item);
  }
  return items;
}

async function fsyncPath(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const part of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(part);
    bytes += part.byteLength;
  }
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}

function setupTarget(db) {
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE restore_info (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      format TEXT NOT NULL, checkpoint_json TEXT NOT NULL,
      manifest_digest TEXT NOT NULL, schema_digest TEXT NOT NULL,
      principal_count INTEGER NOT NULL, mind_count INTEGER NOT NULL,
      revision_count INTEGER NOT NULL, file_count INTEGER NOT NULL,
      object_count INTEGER NOT NULL
    );
    CREATE TABLE restore_records (
      field TEXT NOT NULL, record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, PRIMARY KEY(field, record_id)
    );
    CREATE TABLE restore_minds (
      space_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      handle TEXT NOT NULL, visibility TEXT NOT NULL,
      head_revision_id TEXT NOT NULL, personal_owner_id TEXT
    );
    CREATE TABLE restore_revisions (
      revision_id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL, parent_revision_id TEXT,
      committed_at TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE restore_files (
      revision_id TEXT NOT NULL, file_index INTEGER NOT NULL,
      path TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL, media_type TEXT NOT NULL,
      PRIMARY KEY(revision_id, file_index)
    );
    CREATE TABLE restore_inventory (
      object_index INTEGER PRIMARY KEY, namespace TEXT NOT NULL,
      object_key TEXT NOT NULL, sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL, media_type TEXT NOT NULL
    );
    CREATE TABLE restore_object_references (
      sha256 TEXT PRIMARY KEY, reference_count INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE restore_search USING fts5(
      space_id UNINDEXED, revision_id UNINDEXED,
      file_index UNINDEXED, content
    );
    CREATE INDEX restore_revisions_by_space ON restore_revisions
      (space_id, revision_number);
    CREATE INDEX restore_files_by_sha ON restore_files (sha256);
  `);
}

function insertTarget(db, source, records, inventory) {
  const state = source.prepare("SELECT * FROM backup_state WHERE singleton=1").get();
  required(state, "no_successful_backup");
  const checkpoint = JSON.parse(state.checkpoint_json);
  required(checkpoint && typeof checkpoint === "object" &&
    safeDigest(checkpoint.digest) && safeDigest(checkpoint.schema_digest),
  "restore_invalid_checkpoint");
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertRecord = db.prepare(`INSERT INTO restore_records
      (field, record_id, payload_json) VALUES (?, ?, ?)`);
    for (const row of source.prepare(`SELECT record_key FROM backup_records
        ORDER BY record_key`).iterate()) {
      const [field, id] = JSON.parse(row.record_key);
      const parts = [];
      for (const part of source.prepare(`SELECT data FROM backup_record_parts
          WHERE record_key=? ORDER BY part_index`).iterate(row.record_key)) {
        parts.push(part.data);
      }
      const payload = new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(parts));
      insertRecord.run(field, id, payload);
    }
    const personalBySpace = new Map([...records.personalBindings].map(
      ([principalId, binding]) => [binding.spaceId, principalId]));
    const insertMind = db.prepare(`INSERT INTO restore_minds VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [id, space] of records.knowledgeSpaces) {
      insertMind.run(id, space.name, space.spaceHandle, space.visibility,
        space.headRevisionId, personalBySpace.get(id) ?? null);
    }
    const insertRevision = db.prepare(`INSERT INTO restore_revisions
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertFile = db.prepare(`INSERT INTO restore_files VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let files = 0;
    for (const [id, envelope] of records.revisionsById) {
      const revision = envelope.revision;
      insertRevision.run(id, revision.spaceId, revision.revisionNumber,
        revision.parentRevisionId, revision.committedAt,
        revision.manifestHash, revision.summary ?? "");
      for (const [index, entry] of envelope.manifest.entries.entries()) {
        insertFile.run(id, index, entry.path, entry.kind,
          entry.sha256, entry.size, entry.mediaType);
        files += 1;
      }
    }
    const insertInventory = db.prepare(`INSERT INTO restore_inventory VALUES
      (?, ?, ?, ?, ?, ?)`);
    const references = new Map();
    for (const item of inventory) {
      insertInventory.run(item.object_index, item.namespace, item.object_key,
        item.sha256, item.byte_size, item.media_type);
      references.set(item.sha256, (references.get(item.sha256) ?? 0) + 1);
    }
    const insertReference = db.prepare(`INSERT INTO restore_object_references
      VALUES (?, ?)`);
    for (const [hash, n] of references) insertReference.run(hash, n);
    db.prepare(`INSERT INTO restore_info VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(FORMAT, state.checkpoint_json, state.manifest_digest,
        checkpoint.schema_digest, records.principals.size,
        records.knowledgeSpaces.size, records.revisionsById.size,
        files, inventory.length);
    db.exec("COMMIT");
    return { checkpoint, principal_count: records.principals.size,
      mind_count: records.knowledgeSpaces.size,
      revision_count: records.revisionsById.size,
      file_count: files, object_count: inventory.length };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

async function copyObjects(sourceDirectory, stage, inventory) {
  const copied = new Set();
  for (const item of inventory) {
    if (copied.has(item.sha256)) continue;
    copied.add(item.sha256);
    const from = backupObjectPath(sourceDirectory, item.sha256);
    const target = backupObjectPath(stage, item.sha256);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(from, target);
    const verified = await hashFile(target);
    required(verified.sha256 === item.sha256 && verified.bytes === item.byte_size,
      "restore_copied_object_corrupt");
    await fsyncPath(target);
    await fsyncPath(dirname(target));
  }
  await fsyncPath(join(stage, "objects", "sha256"));
  await fsyncPath(join(stage, "objects"));
}

async function rebuildSearch(stage) {
  const db = new DatabaseSync(join(stage, "restored.sqlite"));
  try {
    const nextFile = db.prepare(`SELECT r.space_id, f.revision_id,
      f.file_index, f.sha256 FROM restore_files f
      JOIN restore_revisions r ON r.revision_id=f.revision_id
      WHERE f.kind='markdown' AND
      (f.revision_id > ? OR
        (f.revision_id=? AND f.file_index > ?))
      ORDER BY f.revision_id, f.file_index LIMIT 1`);
    const insert = db.prepare(`INSERT INTO restore_search
      (space_id, revision_id, file_index, content) VALUES (?, ?, ?, ?)`);
    let revisionId = "";
    let fileIndex = -1;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let row = nextFile.get(revisionId, revisionId, fileIndex); row;
        row = nextFile.get(revisionId, revisionId, fileIndex)) {
        const bytes = await readFile(backupObjectPath(stage, row.sha256));
        let content;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { fail("restore_invalid_markdown_utf8"); }
        insert.run(row.space_id, row.revision_id, row.file_index, content);
        revisionId = row.revision_id;
        fileIndex = row.file_index;
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

export async function inspectRestoredTarget(target) {
  const file = join(target, "restored.sqlite");
  const anchor = (await readFile(join(target, "restored.sqlite.sha256"), "utf8"))
    .trim();
  required(safeDigest(anchor) === (await hashFile(file)).sha256,
    "restore_target_database_corrupt");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const info = db.prepare("SELECT * FROM restore_info WHERE singleton=1").get();
    required(info && info.format === FORMAT, "restore_target_incompatible");
    required(db.prepare("SELECT COUNT(*) n FROM restore_minds").get().n ===
      info.mind_count &&
      db.prepare("SELECT COUNT(*) n FROM restore_revisions").get().n ===
      info.revision_count &&
      db.prepare("SELECT COUNT(*) n FROM restore_files").get().n ===
      info.file_count, "restore_target_incomplete");
    const seen = new Set();
    const nextObject = db.prepare(`SELECT * FROM restore_inventory
      WHERE object_index > ? ORDER BY object_index LIMIT 1`);
    let objectIndex = -1;
    for (let item = nextObject.get(objectIndex); item;
      item = nextObject.get(objectIndex)) {
      objectIndex = item.object_index;
      if (seen.has(item.sha256)) continue;
      seen.add(item.sha256);
      const result = await hashFile(backupObjectPath(target, item.sha256));
      required(result.sha256 === item.sha256 && result.bytes === item.byte_size,
        "restore_target_object_corrupt");
    }
    required(db.prepare("SELECT COUNT(*) n FROM restore_search").get().n ===
      db.prepare("SELECT COUNT(*) n FROM restore_files WHERE kind='markdown'")
        .get().n, "restore_target_index_incomplete");
    return { checkpoint: JSON.parse(info.checkpoint_json),
      principal_count: info.principal_count, mind_count: info.mind_count,
      revision_count: info.revision_count, file_count: info.file_count,
      object_count: info.object_count };
  } finally { db.close(); }
}

export async function restoreBackup({ directory, target, verifyKit = async () => {} }) {
  const oldUmask = process.umask(0o077);
  let stage;
  try {
    required(typeof target === "string" && target.startsWith("/"),
      "restore_target_not_absolute");
    await verifyKit(directory);
    await checkBackupIntegrity({ directory });
    const source = await openBackupCatalog(directory);
    try {
      const state = source.db.prepare("SELECT checkpoint_json FROM backup_state WHERE singleton=1")
        .get();
      required(state, "no_successful_backup");
      try {
        const existing = await lstat(target);
        if (existing.isDirectory() && !existing.isSymbolicLink()) {
          const previous = await inspectRestoredTarget(target);
          required(JSON.stringify(previous.checkpoint) === state.checkpoint_json,
            "restore_target_occupied");
          return { ...previous, repeated: true };
        }
        fail("restore_target_occupied");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const records = loadRecords(source.db);
      const inventory = inventoryFrom(source.db);
      validateRecords(records, inventory);
      await validateManifestBytes(directory, records);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      stage = await mkdtemp(`${target}.restore-`);
      await mkdir(join(stage, "objects", "sha256"),
        { recursive: true, mode: 0o700 });
      const database = new DatabaseSync(join(stage, "restored.sqlite"));
      let receipt;
      try {
        setupTarget(database);
        receipt = insertTarget(database, source.db, records, inventory);
      } finally { database.close(); }
      await fsyncPath(join(stage, "restored.sqlite"));
      await copyObjects(directory, stage, inventory);
      await rebuildSearch(stage);
      await fsyncPath(join(stage, "restored.sqlite"));
      const databaseHash = (await hashFile(join(stage, "restored.sqlite")))
        .sha256;
      await writeFile(join(stage, "restored.sqlite.sha256"),
        `${databaseHash}\n`, { mode: 0o600 });
      await fsyncPath(join(stage, "restored.sqlite.sha256"));
      const operatorKey = `mdr_v1_${randomBytes(32).toString("base64url")}`;
      await writeFile(join(stage, "operator-key"), operatorKey, { mode: 0o600 });
      await fsyncPath(join(stage, "operator-key"));
      await fsyncPath(stage);
      await rename(stage, target);
      stage = undefined;
      await fsyncPath(dirname(target));
      return { ...receipt, repeated: false };
    } finally { source.close(); }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    process.umask(oldUmask);
  }
}
