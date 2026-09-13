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
import { backupObjectPath, backupStatus, openBackupCatalog, runBackup } from
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
  return { directory, database, bucket, value, current, old, p1,
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
    if (child.status !== 0) {
      try {
        await restoreBackup({ directory: f.directory,
          target: `${target}-diagnostic`,
          verifyKit: () => verifyRecoveryKit(f.directory, schemaDigest) });
      } catch (error) {
        assert.fail(`offline kit CLI: ${child.stderr}\nrestore cause: ${error.stack}`);
      }
    }
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

test("one source-bound delta resumes a large file and restores the new HEAD with old history offline", async (context) => {
  const f = await fixture();
  try {
    const drillStarted = performance.now();
    let schemaDigest;
    const kitStage = async (stage, details) => {
      if (stage === "after_receipt_before_catalog") {
        schemaDigest = details.schemaDigest;
        await createRecoveryKit({ directory: f.directory, schemaDigest,
          sourceRoot: ROOT, allowDirty: true });
      }
    };
    const initial = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch, onStage: kitStage });
    assert.equal(initial.last_success.sequence, 0);
    assert.equal(initial.last_success.object_count, 9);
    const large = await attachRevision(f.value, f.bucket, {
      id: "r_shared_3", spaceId: "s_shared", parent: "r_shared_2",
      number: 3, markdown: `# New HEAD needle\n${"x".repeat(4 * 1024 * 1024)}`,
    });
    f.value.spaces.get("s_shared").head = "r_shared_3";
    f.value.knowledgeSpaces.get("s_shared").headRevisionId = "r_shared_3";
    f.value.knowledgeSpaces.get("s_shared").metadataVersion += 1;
    f.database.sqlite.exec(`UPDATE md_backup_control
      SET backup_sequence=backup_sequence+1`);
    let interrupted = false;
    const requested = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/objects/")) {
        const index = Number(parsed.pathname.split("/").at(-1));
        const offset = Number(parsed.searchParams.get("offset"));
        if (!interrupted && offset === 4 * 1024 * 1024) {
          interrupted = true;
          throw new Error("synthetic network loss");
        }
        const response = await f.fetch(url, init);
        const range = /^bytes (\d+)-(\d+)\/\d+$/u.exec(
          response.headers.get("content-range") ?? "");
        assert.ok(range);
        requested.push({ index, offset,
          bytes: Number(range[2]) - Number(range[1]) + 1 });
        return response;
      }
      return f.fetch(url, init);
    };
    await assert.rejects(runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl, onStage: kitStage }), /transport_unavailable/u);
    assert.equal(interrupted, true);
    let catalog = await openBackupCatalog(f.directory);
    try {
      assert.equal(backupStatus(catalog.db).last_success.sequence, 0);
      assert.equal(backupStatus(catalog.db).pending.phase, "downloading");
    } finally { catalog.close(); }
    const updated = await runBackup({ directory: f.directory,
      origin: ORIGIN, key: KEY, fetchImpl, onStage: kitStage });
    assert.equal(updated.last_success.sequence, 1);
    assert.equal(updated.last_success.object_count, 11);
    assert.equal(updated.downloaded_objects <= 2, true);
    assert.equal(Math.max(...requested.map((part) => part.bytes)),
      4 * 1024 * 1024);
    assert.equal(requested.filter((part) =>
      part.bytes === 4 * 1024 * 1024).length, 1);
    catalog = await openBackupCatalog(f.directory);
    try {
      const inventory = catalog.db.prepare(`SELECT object_index, sha256
        FROM backup_inventory`).all();
      const hashes = new Map(inventory.map((row) =>
        [row.object_index, row.sha256]));
      assert.equal(requested.length >= 3, true);
      assert.equal(requested.every((part) => [large.markdownHash,
        large.manifestHash].includes(hashes.get(part.index))), true);
    } finally { catalog.close(); }
    const noChange = await runBackup({ directory: f.directory,
      origin: ORIGIN, key: KEY, fetchImpl: f.fetch, onStage: kitStage });
    assert.equal(noChange.downloaded_objects, 0);
    const kit = await verifyRecoveryKit(f.directory, schemaDigest);
    const target = join(f.directory, "delta-restored");
    const restored = spawnSync(join(kit.path, "runtime/node"),
      [join(kit.path, "scripts/system-backup-restore.mjs"), "restore",
        "--directory", f.directory, "--target", target], {
        env: { ...process.env, NODE_OPTIONS: `--import=${NETWORK_BLOCK}` },
        encoding: "utf8" });
    assert.equal(restored.status, 0, restored.stderr);
    const receipt = JSON.parse(restored.stdout);
    assert.equal(receipt.mind_count, 3);
    assert.equal(receipt.revision_count, 5);
    assert.equal(receipt.file_count, 6);
    assert.equal(receipt.object_count, 11);
    const viewer = await startRestoredViewer({ target });
    try {
      const key = await readFile(join(target, "operator-key"), "utf8");
      const get = (path) => fetch(`${viewer.url}${path}`,
        { headers: { authorization: `Bearer ${key}` } });
      const minds = await (await get("/minds")).json();
      assert.equal(minds.minds.find((item) => item.space_id === "s_shared")
        .head_revision_id, "r_shared_3");
      const history = await (await get("/minds/s_shared/revisions")).json();
      assert.deepEqual(history.revisions.map((item) => item.revision_id),
        ["r_shared_1", "r_shared_2", "r_shared_3"]);
      const headFiles = await (await get(
        "/minds/s_shared/revisions/r_shared_3/files")).json();
      assert.equal(headFiles.files.length, 1);
      const oldBinary = Buffer.from(await (await get(
        "/minds/s_shared/revisions/r_shared_2/files/0")).arrayBuffer());
      assert.deepEqual(oldBinary, Buffer.from([0, 1, 2, 255]));
      const newBytes = Buffer.from(await (await get(
        "/minds/s_shared/revisions/r_shared_3/files/0")).arrayBuffer());
      assert.equal(await systemBackupSha256(newBytes), large.markdownHash);
    } finally { await viewer.close(); }
    const sha = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"],
      { encoding: "utf8" }).stdout.trim();
    context.diagnostic(JSON.stringify({ candidate_sha: sha,
      format: "MD-SYSTEM-BACKUP-1", minds: receipt.mind_count,
      revisions: receipt.revision_count, files: receipt.file_count,
      objects: receipt.object_count, sequence: updated.last_success.sequence,
      transferred_object_parts: requested.length,
      transferred_object_bytes: requested.reduce((sum, part) =>
        sum + part.bytes, 0),
      largest_object_part_bytes: Math.max(...requested.map((part) =>
        part.bytes)),
      observed_peak_rss_bytes: updated.observed_peak_rss_bytes,
      duration_ms: Math.round(performance.now() - drillStarted),
      offline_restore: true }));
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
    const manifestPath = join(kit, "kit.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest,
      platform: "incompatible" }));
    await assert.rejects(restoreBackup({ directory: f.directory, target,
      verifyKit: () => verifyRecoveryKit(f.directory, schemaDigest) }),
    /kit_incompatible/u);
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
