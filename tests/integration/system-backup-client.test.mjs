import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import {
  SYSTEM_BACKUP_EXACT_FIELDS, systemBackupSha256,
} from "../../packages/composition-root/dist/system-backup-format.js";
import { SitesSystemBackupService } from "../../packages/composition-root/dist/system-backup-sites.js";
import { createSystemBackupHttpHandler } from "../../packages/composition-root/dist/system-backup-http.js";
import {
  backupObjectPath, backupStatus, checkBackupIntegrity, collectBackupGarbage,
  openBackupCatalog, runBackup,
} from "../../scripts/lib/system-backup-client.mjs";

const ORIGIN = "https://backup.test";
const KEY_BYTES = Buffer.alloc(32, 7);
const KEY = `mdb_v1_${KEY_BYTES.toString("base64url")}`;

class SyntheticR2 {
  objects = new Map();
  putBytes(key, bytes, metadata) { this.objects.set(key, { bytes, metadata }); }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { key, size: item.bytes.byteLength,
      customMetadata: item.metadata } : null;
  }
  async get(key, options) {
    const item = this.objects.get(key);
    if (!item) return null;
    const offset = options.range.offset;
    const length = options.range.length;
    const bytes = item.bytes.subarray(offset, offset + length);
    return { key, size: item.bytes.byteLength, customMetadata: item.metadata,
      range: { offset, length: bytes.byteLength },
      body: new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      }) };
  }
  async list() {
    return { objects: [], truncated: false,
      delimitedPrefixes: [...new Set([...this.objects.keys()]
        .map((key) => `${key.split("/")[0]}/`))] };
  }
}

function snapshot(ids) {
  const value = { v: 5 };
  for (const field of SYSTEM_BACKUP_EXACT_FIELDS) value[field] = new Map();
  for (const id of ids) value.principals.set(id, { principalId: id, name: id });
  return value;
}

async function fixture() {
  const database = new SqliteD1();
  await createSitesMetadataStore(database);
  const bucket = new SyntheticR2();
  let value = snapshot(["principal_a"]);
  let now = new Date("2026-09-13T12:00:00.000Z");
  const service = new SitesSystemBackupService({ database, bucket,
    metadata: { captureSystemBackupState: async () => ({
      eventSequence: database.sqlite.prepare(
        "SELECT backup_sequence FROM md_backup_control WHERE singleton_id=1",
      ).get().backup_sequence,
      snapshot: value,
    }) },
    now: () => now,
  });
  const handler = createSystemBackupHttpHandler({ service,
    operatorKey: KEY_BYTES, publicOrigin: ORIGIN });
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-backup-client-"));
  return {
    directory, database, bucket, service,
    fetch: (url, init) => handler(new Request(url, init)),
    setSnapshot(next) { value = next; },
    setNow(iso) { now = new Date(iso); },
    advance() { database.sqlite.exec(
      "UPDATE md_backup_control SET backup_sequence=backup_sequence+1"); },
    async close() { database.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function attachRevision(value, bucket, bytes) {
  const objectHash = await systemBackupSha256(bytes);
  const manifestBytes = new TextEncoder().encode("manifest");
  const manifestHash = await systemBackupSha256(manifestBytes);
  value.revisionsById.set("revision_1", {
    revision: { spaceId: "space_1", manifestHash,
      manifestSize: manifestBytes.byteLength },
    manifest: { format: "mind-diary-revision-manifest-v4",
      entries: [{ kind: "markdown", sha256: objectHash,
        size: bytes.byteLength, mediaType: "text/markdown; charset=utf-8" }] },
  });
  bucket.putBytes(`spaces/space_1/manifests/sha256/${manifestHash.slice(7)}`,
    manifestBytes, { sha256: manifestHash,
      mediaType: "application/vnd.mind-diary.revision-manifest+json; charset=utf-8",
      state: "active" });
  bucket.putBytes(`spaces/space_1/objects/sha256/${objectHash.slice(7)}`,
    bytes, { sha256: objectHash,
      mediaType: "text/markdown; charset=utf-8", state: "active" });
}

test("malformed source error code cannot replace the last backup error", async () => {
  const f = await fixture();
  try {
    const options = { directory: f.directory, origin: ORIGIN, key: KEY };
    await assert.rejects(runBackup({ ...options,
      fetchImpl: async () => Response.json({ code: ["backup_r2_namespace_unknown"] },
        { status: 503 }) }), /source_unavailable/u);
    let catalog = await openBackupCatalog(f.directory);
    try { assert.equal(backupStatus(catalog.db).pending.error, "source_unavailable"); }
    finally { catalog.close(); }
    await assert.rejects(runBackup({ ...options,
      fetchImpl: async () => Response.json({ code: "backup_r2_namespace_unknown" },
        { status: 503 }) }), /backup_r2_namespace_unknown/u);
    catalog = await openBackupCatalog(f.directory);
    try { assert.equal(backupStatus(catalog.db).pending.error, "backup_r2_namespace_unknown"); }
    finally { catalog.close(); }
    await assert.rejects(runBackup({ ...options,
      fetchImpl: async () => Response.json({ ok: false,
        error: { code: "request_timeout", retryable: true } }, { status: 503 }) }),
    /request_timeout/u);
  } finally { await f.close(); }
});

test("client commits one exact current copy and transfers only changed metadata and missing objects", async () => {
  const f = await fixture();
  try {
    const value = snapshot(["principal_a"]);
    await attachRevision(value, f.bucket, new TextEncoder().encode("first bytes"));
    f.setSnapshot(value);
    let parts = 0;
    const fetchImpl = async (url, init) => {
      if (new URL(url).pathname.includes("/objects/")) parts += 1;
      return f.fetch(url, init);
    };
    const first = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl });
    assert.equal(first.mode, "baseline");
    assert.equal(first.downloaded_objects, 2);
    assert.equal(parts, 2);
    assert.deepEqual(await checkBackupIntegrity({ directory: f.directory }), {
      ok: true, record_count: 2, object_count: 2, sequence: 0,
    });
    const unchanged = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl });
    assert.equal(unchanged.mode, "incremental");
    assert.equal(unchanged.downloaded_objects, 0);
    assert.equal(parts, 2);

    const next = snapshot(["principal_b"]);
    await attachRevision(next, f.bucket, new TextEncoder().encode("first bytes"));
    f.setSnapshot(next);
    f.advance();
    const changed = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl });
    assert.equal(changed.mode, "incremental");
    assert.equal(changed.downloaded_objects, 0);
    const catalog = await openBackupCatalog(f.directory);
    try {
      assert.equal(catalog.db.prepare("SELECT COUNT(*) n FROM backup_records").get().n, 2);
      assert.equal(catalog.db.prepare(`SELECT COUNT(*) n FROM backup_records
        WHERE record_key=?`).get(JSON.stringify(["principals", "principal_a"])).n, 0);
      assert.equal(backupStatus(catalog.db).last_success.sequence, 1);
    } finally { catalog.close(); }
    assert.equal((await collectBackupGarbage({ directory: f.directory })).removed_objects, 0);
  } finally { await f.close(); }
});

test("failed second part and lost completion response resume without advancing the old checkpoint", async () => {
  const f = await fixture();
  try {
    const value = snapshot(["principal_a"]);
    await attachRevision(value, f.bucket, Buffer.alloc(4 * 1024 * 1024 + 19, 42));
    f.setSnapshot(value);
    let partRequests = 0;
    let failPart = true;
    let loseCompletion = true;
    const fetchImpl = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.includes("/objects/")) {
        partRequests += 1;
        if (failPart && new URL(url).searchParams.get("offset") === String(4 * 1024 * 1024)) {
          failPart = false;
          throw new Error("synthetic transport interruption");
        }
      }
      const response = await f.fetch(url, init);
      if (path.endsWith("/complete") && loseCompletion) {
        loseCompletion = false;
        throw new Error("synthetic lost completion response");
      }
      return response;
    };
    await assert.rejects(runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl }), /transport_unavailable/u);
    let catalog = await openBackupCatalog(f.directory);
    try {
      assert.equal(backupStatus(catalog.db).last_success, null);
      assert.equal(backupStatus(catalog.db).pending.phase, "downloading");
    } finally { catalog.close(); }
    await assert.rejects(runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl }), /transport_unavailable/u);
    catalog = await openBackupCatalog(f.directory);
    try {
      assert.equal(backupStatus(catalog.db).last_success, null);
      assert.equal(backupStatus(catalog.db).pending.phase, "ready_to_complete");
    } finally { catalog.close(); }
    const before = partRequests;
    const result = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl });
    assert.equal(result.last_success.sequence, 0);
    assert.equal(partRequests, before);
    assert.equal((await checkBackupIntegrity({ directory: f.directory })).object_count, 2);
  } finally { await f.close(); }
});

test("part fsync, object rename, catalog transaction and GC faults never publish an incomplete copy", async () => {
  const f = await fixture();
  try {
    const value = snapshot(["principal_a"]);
    await attachRevision(value, f.bucket, new TextEncoder().encode("durable object"));
    f.setSnapshot(value);
    for (const stage of ["after_part_fsync", "before_object_rename",
      "before_catalog_commit"]) {
      let injected = false;
      await assert.rejects(runBackup({ directory: f.directory, origin: ORIGIN,
        key: KEY, fetchImpl: f.fetch,
        onStage: (actual) => {
          if (actual === stage && !injected) {
            injected = true;
            throw new Error(`injected ${stage}`);
          }
        },
      }), new RegExp(`injected ${stage}`, "u"));
      assert.equal(injected, true);
      const catalog = await openBackupCatalog(f.directory);
      try { assert.equal(backupStatus(catalog.db).last_success, null); }
      finally { catalog.close(); }
    }
    const first = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch });
    assert.equal(first.last_success.object_count, 2);
    const removed = snapshot(["principal_a"]);
    f.setSnapshot(removed);
    f.advance();
    const second = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch });
    assert.equal(second.last_success.object_count, 0);
    let once = false;
    await assert.rejects(collectBackupGarbage({ directory: f.directory,
      onStage: () => { if (!once) { once = true; throw new Error("injected GC"); } },
    }), /injected GC/u);
    assert.equal((await collectBackupGarbage({ directory: f.directory })).removed_objects, 2);
    assert.equal((await checkBackupIntegrity({ directory: f.directory })).object_count, 0);
  } finally { await f.close(); }
});

test("a lost local commit can use an idempotent server receipt after session expiry", async () => {
  const f = await fixture();
  try {
    const first = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch });
    assert.equal(first.last_success.sequence, 0);
    const next = snapshot(["principal_a", "principal_b"]);
    f.setSnapshot(next);
    f.advance();
    await assert.rejects(runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch,
      onStage: (stage) => {
        if (stage === "after_receipt_before_catalog") throw new Error("crash");
      },
    }), /crash/u);
    const catalog = await openBackupCatalog(f.directory);
    try {
      assert.equal(backupStatus(catalog.db).last_success.sequence, 0);
      assert.equal(backupStatus(catalog.db).pending.phase, "ready_to_complete");
    } finally { catalog.close(); }
    // The old completion is idempotent even after session expiry; the already
    // staged exact target can still finish without reading the source again.
    f.setNow("2026-09-21T12:00:00.000Z");
    const recovered = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch });
    assert.equal(recovered.last_success.sequence, 1);
    assert.equal((await checkBackupIntegrity({ directory: f.directory })).record_count, 2);
  } finally { await f.close(); }
});

test("an expired incomplete session is replaced without advancing the old checkpoint", async () => {
  const f = await fixture();
  try {
    await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch });
    f.setSnapshot(snapshot(["principal_a", "principal_b"]));
    f.advance();
    let interrupted = false;
    const firstFetch = async (url, init) => {
      if (!interrupted && new URL(url).pathname.endsWith("/pages/0")) {
        interrupted = true;
        throw new Error("interrupted");
      }
      return f.fetch(url, init);
    };
    await assert.rejects(runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: firstFetch }), /transport_unavailable/u);
    let catalog = await openBackupCatalog(f.directory);
    try { assert.equal(backupStatus(catalog.db).last_success.sequence, 0); }
    finally { catalog.close(); }
    f.setNow("2026-09-21T12:00:00.000Z");
    const result = await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch });
    assert.equal(result.mode, "incremental");
    assert.equal(result.last_success.sequence, 1);
    catalog = await openBackupCatalog(f.directory);
    try { assert.equal(backupStatus(catalog.db).pending, null); }
    finally { catalog.close(); }
  } finally { await f.close(); }
});

test("corrupt local metadata forces full reconciliation; corrupt object bytes are redownloaded", async () => {
  const f = await fixture();
  try {
    const value = snapshot(["principal_a", "\uE000", "😀"]);
    const objectBytes = new TextEncoder().encode("original object bytes");
    const objectHash = await systemBackupSha256(objectBytes);
    await attachRevision(value, f.bucket, objectBytes);
    f.setSnapshot(value);
    await runBackup({ directory: f.directory, origin: ORIGIN,
      key: KEY, fetchImpl: f.fetch });
    await writeFile(backupObjectPath(f.directory, objectHash),
      new TextEncoder().encode("corrupted object byte"));
    await assert.rejects(checkBackupIntegrity({ directory: f.directory }),
      /object_closure_incomplete/u);
    let parts = 0;
    const observed = async (url, init) => {
      if (new URL(url).pathname.includes("/objects/")) parts += 1;
      return f.fetch(url, init);
    };
    const repairedObject = await runBackup({ directory: f.directory,
      origin: ORIGIN, key: KEY, fetchImpl: observed });
    assert.equal(repairedObject.mode, "incremental");
    assert.equal(repairedObject.downloaded_objects, 1);
    assert.equal(parts, 1);
    await checkBackupIntegrity({ directory: f.directory });

    let catalog = await openBackupCatalog(f.directory);
    try {
      catalog.db.prepare(`UPDATE backup_record_parts SET data=?
        WHERE record_key=? AND part_index=0`).run(Buffer.from("tampered"),
          JSON.stringify(["principals", "principal_a"]));
    } finally { catalog.close(); }
    await assert.rejects(checkBackupIntegrity({ directory: f.directory }),
      /record_digest_mismatch/u);
    f.setSnapshot(snapshot(["principal_b"]));
    f.advance();
    const reconciled = await runBackup({ directory: f.directory,
      origin: ORIGIN, key: KEY, fetchImpl: f.fetch });
    assert.equal(reconciled.mode, "baseline");
    assert.equal(reconciled.last_success.record_count, 1);
    catalog = await openBackupCatalog(f.directory);
    try {
      assert.equal(catalog.db.prepare("SELECT COUNT(*) n FROM backup_records").get().n, 1);
    } finally { catalog.close(); }
    await checkBackupIntegrity({ directory: f.directory });
  } finally { await f.close(); }
});

test("a separate Mac runner process keeps observed memory bounded across larger objects", async (t) => {
  const f = await fixture();
  let server;
  try {
    let origin;
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(key,
            Array.isArray(value) ? value.join(", ") : value);
        }
        const request = new Request(origin + incoming.url, {
          method: incoming.method, headers,
          ...(["GET", "HEAD"].includes(incoming.method) ? {} : {
            body: Buffer.concat(chunks),
          }),
        });
        const handler = createSystemBackupHttpHandler({ service: f.service,
          operatorKey: KEY_BYTES, publicOrigin: origin });
        const response = await handler(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch { outgoing.writeHead(503); outgoing.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const peaks = [];
    for (const mib of [8, 32, 64]) {
      const value = snapshot(["principal_a"]);
      await attachRevision(value, f.bucket, Buffer.alloc(mib * 1024 * 1024, 42));
      f.setSnapshot(value);
      const directory = await mkdtemp(join(tmpdir(), "mind-diary-backup-measure-"));
      try {
        const child = spawn(process.execPath, [
          join(process.cwd(), "scripts", "system-backup.mjs"),
          "run", "--directory", directory,
        ], { env: { ...process.env,
          MIND_DIARY_BACKUP_ORIGIN: origin,
          MIND_DIARY_BACKUP_OPERATOR_KEY: KEY,
        } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (part) => { stdout += part; });
        child.stderr.on("data", (part) => { stderr += part; });
        const code = await new Promise((resolve) => child.on("close", resolve));
        assert.equal(code, 0, stderr);
        const receipt = JSON.parse(stdout.trim());
        assert.equal(receipt.last_success.object_count, 2);
        assert.ok(receipt.largest_response_bytes <= 4 * 1024 * 1024);
        assert.ok(receipt.observed_peak_rss_bytes < 256 * 1024 * 1024);
        peaks.push(receipt.observed_peak_rss_bytes);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    assert.ok(peaks[2] - peaks[0] < 120 * 1024 * 1024);
    t.diagnostic(`observed runner RSS: 8 MiB object=${peaks[0]}, ` +
      `32 MiB object=${peaks[1]}, 64 MiB object=${peaks[2]}, ` +
      `delta=${peaks[2] - peaks[0]} bytes`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});
