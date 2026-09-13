import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { createRevisionManifest, serializeRevisionManifest } from
  "../../packages/domain/dist/index.js";
import { SYSTEM_BACKUP_EXACT_FIELDS, systemBackupSha256 } from
  "../../packages/composition-root/dist/system-backup-format.js";
import { SitesSystemBackupService } from
  "../../packages/composition-root/dist/system-backup-sites.js";
import { createSystemBackupHttpHandler } from
  "../../packages/composition-root/dist/system-backup-http.js";
import { backupObjectPath, runBackup } from
  "../../scripts/lib/system-backup-client.mjs";
import { createRecoveryKit, recoveryKitPath, verifyRecoveryKit } from
  "../../scripts/lib/system-backup-kit.mjs";
import { inspectRestoredTarget, restoreBackup } from
  "../../scripts/lib/system-backup-restore.mjs";
import { startRestoredViewer } from
  "../../scripts/lib/system-backup-viewer.mjs";

const ORIGIN = "https://backup.test";
const KEY_BYTES = Buffer.alloc(32, 7);
const KEY = `mdb_v1_${KEY_BYTES.toString("base64url")}`;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NETWORK_BLOCK = fileURLToPath(new URL(
  "../fixtures/system-backup-no-network.mjs", import.meta.url));

class SyntheticR2 {
  objects = new Map();
  putBytes(key, bytes, mediaType, sha256) {
    this.objects.set(key, { bytes, customMetadata: { sha256, mediaType,
      state: "active" } });
  }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { key, size: item.bytes.byteLength,
      customMetadata: item.customMetadata } : null;
  }
  async get(key, options) {
    const item = this.objects.get(key);
    if (!item) return null;
    const offset = options.range.offset;
    const bytes = item.bytes.subarray(offset, offset + options.range.length);
    return { key, size: item.bytes.byteLength,
      customMetadata: item.customMetadata,
      range: { offset, length: bytes.byteLength },
      body: new ReadableStream({ start(controller) {
        controller.enqueue(bytes); controller.close();
      } }) };
  }
  async list() {
    return { objects: [], truncated: false,
      delimitedPrefixes: [...new Set([...this.objects.keys()]
        .map((key) => `${key.split("/")[0]}/`))] };
  }
}

function snapshot() {
  const result = { v: 5 };
  for (const field of SYSTEM_BACKUP_EXACT_FIELDS) result[field] = new Map();
  const now = "2026-09-13T00:00:00.000Z";
  for (const id of ["p1", "p2"]) {
    result.principals.set(id, { principalId: id, displayName: id,
      state: "active", profileVersion: 1, createdAt: now, updatedAt: now });
    result.personalBindings.set(id, { principalId: id,
      spaceId: `s_${id}`, version: 1, createdAt: now });
    result.externalBindings.set(`e_${id}`, { bindingId: `e_${id}`,
      principalId: id, provider: "sites", normalizedBinding: `${id}@example.test`,
      state: "active", version: 1, verifiedAt: now,
      createdAt: now, updatedAt: now });
    result.principalMindUsageOwners.set(id, { principalId: id,
      generation: 1, entries: new Map() });
  }
  const minds = [
    ["s_p1", "p1", "r_p1", "personal-p1"],
    ["s_p2", "p2", "r_p2", "personal-p2"],
    ["s_shared", "p1", "r_shared_2", "shared"],
  ];
  for (const [spaceId, owner, head, handle] of minds) {
    result.spaces.set(spaceId, { head, revisions: new Map() });
    result.knowledgeSpaces.set(spaceId, { spaceId, spaceHandle: handle,
      normalizedHandle: handle, name: handle, visibility: "private",
      state: "active", metadataVersion: 1, accessVersion: 1,
      headRevisionId: head, createdAt: now, updatedAt: now });
    result.memberships.set(`m_${spaceId}`, { membershipId: `m_${spaceId}`,
      spaceId, principalId: owner, role: "owner", state: "active",
      version: 1, createdAt: now, createdBy: owner,
      updatedAt: now, updatedBy: owner });
    const reservation = { host: "test.local", canonicalHandle: handle, spaceId };
    result.activeHandlesByKey.set(`test.local\0${handle}`, reservation);
    result.activeHandlesBySpace.set(spaceId, reservation);
  }
  return result;
}

async function attachRevision(value, bucket, { id, spaceId, parent = null,
  number = 1, markdown, binary = null }) {
  const entries = [];
  const markdownBytes = Buffer.from(markdown);
  const markdownHash = await systemBackupSha256(markdownBytes);
  entries.push({ kind: "markdown", path: "wiki/main.md",
    sha256: markdownHash, size: markdownBytes.byteLength,
    mediaType: "text/markdown; charset=utf-8" });
  bucket.putBytes(`spaces/${spaceId}/objects/sha256/${markdownHash.slice(7)}`,
    markdownBytes, "text/markdown; charset=utf-8", markdownHash);
  if (binary) {
    const binaryHash = await systemBackupSha256(binary);
    entries.push({ kind: "opaque", path: "assets/picture.bin",
      sha256: binaryHash, size: binary.byteLength,
      mediaType: "application/octet-stream" });
    bucket.putBytes(`bundle-files/${spaceId}/sha256/${binaryHash.slice(7)}`,
      binary, "application/octet-stream", binaryHash);
  }
  const manifest = createRevisionManifest(entries,
    "mind-diary-revision-manifest-v4");
  const manifestBytes = Buffer.from(serializeRevisionManifest(manifest));
  const manifestHash = await systemBackupSha256(manifestBytes);
  bucket.putBytes(`spaces/${spaceId}/manifests/sha256/${manifestHash.slice(7)}`,
    manifestBytes,
    "application/vnd.mind-diary.revision-manifest+json; charset=utf-8",
    manifestHash);
  const envelope = { revision: { revisionId: id, spaceId,
    revisionNumber: number, parentRevisionId: parent,
    committedAt: "2026-09-13T00:00:00.000Z",
    committedBy: { kind: "principal", principalId: "p1" },
    manifestHash, manifestSize: manifestBytes.byteLength, summary: "fixture" },
  manifest };
  value.revisionsById.set(id, envelope);
  value.spaces.get(spaceId).revisions.set(id, envelope);
  return { markdownBytes, markdownHash, manifestBytes, manifestHash };
}

async function fixture() {
  const database = new SqliteD1();
  await createSitesMetadataStore(database);
  const bucket = new SyntheticR2();
  const value = snapshot();
  const p1 = await attachRevision(value, bucket, { id: "r_p1",
    spaceId: "s_p1", markdown: "# Personal one\n" });
  await attachRevision(value, bucket, { id: "r_p2", spaceId: "s_p2",
    markdown: "# Personal two\n" });
  const old = await attachRevision(value, bucket, { id: "r_shared_1",
    spaceId: "s_shared", markdown: "# Before\n" });
  const current = await attachRevision(value, bucket, { id: "r_shared_2",
    spaceId: "s_shared", parent: "r_shared_1", number: 2,
    markdown: "# After needle\n", binary: Buffer.from([0, 1, 2, 255]) });
  const service = new SitesSystemBackupService({ database, bucket,
    metadata: { captureSystemBackupState: async () => ({
      eventSequence: database.sqlite.prepare(`SELECT backup_sequence
        FROM md_backup_control WHERE singleton_id=1`).get().backup_sequence,
      snapshot: value,
    }) }, now: () => new Date("2026-09-13T12:00:00.000Z") });
  const handler = createSystemBackupHttpHandler({ service,
    operatorKey: KEY_BYTES, publicOrigin: ORIGIN });
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-restore-"));
  return { directory, database, current, old, p1,
    fetch: (url, init) => handler(new Request(url, init)),
    async close() { database.close(); await rm(directory,
      { recursive: true, force: true }); } };
}

test("offline kit restores all Minds, exact history and bytes with a new loopback-only credential", async () => {
  const f = await fixture();
  try {
    let schemaDigest;
    await runBackup({ directory: f.directory, origin: ORIGIN, key: KEY,
      fetchImpl: f.fetch, onStage: async (stage, details) => {
        if (stage === "after_receipt_before_catalog") {
          schemaDigest = details.schemaDigest;
          await createRecoveryKit({ directory: f.directory, schemaDigest,
            sourceRoot: ROOT, allowDirty: true });
        }
      } });
    const kit = await verifyRecoveryKit(f.directory, schemaDigest);
    const target = join(f.directory, "restored");
    const child = spawnSync(join(kit.path, "runtime/node"),
      [join(kit.path, "scripts/system-backup-restore.mjs"), "restore",
        "--directory", f.directory, "--target", target], {
        env: { ...process.env, NODE_OPTIONS: `--import=${NETWORK_BLOCK}` },
        encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(child.stdout);
    assert.equal(receipt.mind_count, 3);
    assert.equal(receipt.revision_count, 4);
    assert.equal(receipt.repeated, false);
    const verified = await inspectRestoredTarget(target);
    assert.equal(verified.object_count, 9);
    const firstKey = await readFile(join(target, "operator-key"), "utf8");
    assert.match(firstKey, /^mdr_v1_/u);
    assert.notEqual(firstKey, KEY);
    assert.equal((await restoreBackup({ directory: f.directory, target,
      verifyKit: () => verifyRecoveryKit(f.directory, schemaDigest) })).repeated,
    true);
    assert.equal(await readFile(join(target, "operator-key"), "utf8"), firstKey);
    const viewer = await startRestoredViewer({ target });
    try {
      const request = (path, key) => fetch(`${viewer.url}${path}`,
        { headers: { authorization: `Bearer ${key}` } });
      assert.equal((await request("/minds", KEY)).status, 401);
      const minds = await (await request("/minds", firstKey)).json();
      assert.equal(minds.minds.length, 3);
      const revisions = await (await request(
        "/minds/s_shared/revisions", firstKey)).json();
      assert.deepEqual(revisions.revisions.map((row) => row.revision_id),
        ["r_shared_1", "r_shared_2"]);
      const files = await (await request(
        "/minds/s_shared/revisions/r_shared_2/files", firstKey)).json();
      assert.equal(files.files.length, 2);
      const markdown = await (await request(
        "/minds/s_shared/revisions/r_shared_2/files/1", firstKey)).text();
      assert.equal(markdown, "# After needle\n");
      const binary = Buffer.from(await (await request(
        "/minds/s_shared/revisions/r_shared_2/files/0", firstKey))
        .arrayBuffer());
      assert.deepEqual(binary, Buffer.from([0, 1, 2, 255]));
      const matches = await (await request("/search?q=needle", firstKey)).json();
      assert.equal(matches.matches.length, 1);
    } finally { await viewer.close(); }
    assert.equal((await stat(target)).isDirectory(), true);
    await writeFile(join(target, "restored.sqlite.sha256"),
      `sha256:${"0".repeat(64)}\n`);
    await assert.rejects(restoreBackup({ directory: f.directory, target,
      verifyKit: () => verifyRecoveryKit(f.directory, schemaDigest) }),
    /restore_target_database_corrupt/u);
  } finally { await f.close(); }
});

test("corrupt object or kit is rejected before creating a new restore target", async () => {
  const f = await fixture();
  try {
    let schemaDigest;
    await runBackup({ directory: f.directory, origin: ORIGIN, key: KEY,
      fetchImpl: f.fetch, onStage: async (stage, details) => {
        if (stage === "after_receipt_before_catalog") {
          schemaDigest = details.schemaDigest;
          await createRecoveryKit({ directory: f.directory, schemaDigest,
            sourceRoot: ROOT, allowDirty: true });
        }
      } });
    const target = join(f.directory, "no-target");
    const kit = recoveryKitPath(f.directory, schemaDigest);
    await writeFile(join(kit, "source.tar"), "corrupt");
    await assert.rejects(restoreBackup({ directory: f.directory, target,
      verifyKit: () => verifyRecoveryKit(f.directory, schemaDigest) }),
    /kit_file_corrupt/u);
    await assert.rejects(stat(target), { code: "ENOENT" });
    await rm(kit, { recursive: true });
    await createRecoveryKit({ directory: f.directory, schemaDigest,
      sourceRoot: ROOT, allowDirty: true });
    await writeFile(backupObjectPath(f.directory, f.current.markdownHash),
      "corrupt");
    await assert.rejects(restoreBackup({ directory: f.directory, target,
      verifyKit: () => verifyRecoveryKit(f.directory, schemaDigest) }),
    /object_closure_incomplete/u);
    await assert.rejects(stat(target), { code: "ENOENT" });
  } finally { await f.close(); }
});
