import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 as TestSqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { AccountBootstrapService } from "@mind-diary/application-control";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { CAPABILITIES } from "@mind-diary/domain";
import { SystemBackupCleanupBarrier } from "../../packages/composition-root/dist/system-backup-cleanup-barrier.js";
import {
  SYSTEM_BACKUP_EXACT_FIELDS,
  systemBackupRecords,
  systemBackupObjectSeeds,
  decodeSystemBackupValue,
  systemBackupSha256,
} from "../../packages/composition-root/dist/system-backup-format.js";
import {
  SitesSystemBackupService,
} from "../../packages/composition-root/dist/system-backup-sites.js";
import { createSystemBackupHttpHandler } from "../../packages/composition-root/dist/system-backup-http.js";

class SqliteD1 extends TestSqliteD1 {
  get database() { return this.sqlite; }
  prepare(sql) {
    if (/pragma_table_info\s*\(/iu.test(sql)) {
      throw new Error("D1_ERROR: not authorized: SQLITE_AUTH");
    }
    return super.prepare(sql);
  }
}

class SyntheticR2 {
  objects = new Map();

  putBytes(key, bytes, metadata) {
    this.objects.set(key, { bytes, metadata });
  }

  async head(key) {
    const item = this.objects.get(key);
    return item === undefined ? null : {
      key, size: item.bytes.byteLength, etag: "synthetic-etag",
      customMetadata: item.metadata,
    };
  }

  async get(key, options) {
    const item = this.objects.get(key);
    if (item === undefined) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? item.bytes.byteLength;
    const bytes = item.bytes.subarray(offset, offset + length);
    return {
      key, size: item.bytes.byteLength, etag: "synthetic-etag",
      customMetadata: item.metadata,
      range: { offset, length: bytes.byteLength },
      body: new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      }),
      async arrayBuffer() { return new Uint8Array(bytes).buffer; },
    };
  }

  async list() {
    return {
      objects: [],
      truncated: false,
      delimitedPrefixes: [...new Set([...this.objects.keys()]
        .map((key) => `${key.split("/")[0]}/`))],
    };
  }
}

function snapshot(principalIds = []) {
  const value = { v: 5 };
  for (const field of SYSTEM_BACKUP_EXACT_FIELDS) value[field] = new Map();
  for (const id of principalIds) value.principals.set(id, { principalId: id, name: id });
  return value;
}

async function setup() {
  const database = new SqliteD1();
  await createSitesMetadataStore(database);
  const bucket = new SyntheticR2();
  let currentSnapshot = snapshot(["principal_a"]);
  let now = new Date("2026-09-13T12:00:00.000Z");
  const service = new SitesSystemBackupService({
    database,
    bucket,
    metadata: { captureSystemBackupState: async () => ({
      eventSequence: database.database.prepare(
        "SELECT backup_sequence FROM md_backup_control WHERE singleton_id = 1",
      ).get().backup_sequence,
      snapshot: currentSnapshot,
    }) },
    now: () => now,
  });
  return {
    database, bucket, service,
    setSnapshot(value) { currentSnapshot = value; },
    advance() { database.database.exec(
      "UPDATE md_backup_control SET backup_sequence = backup_sequence + 1",
    ); },
    setNow(value) { now = new Date(value); },
  };
}

test("fixed target gives exact incremental, no-change, deletion and rebaseline pages", async () => {
  const fixture = await setup();
  try {
    const baseline = await fixture.service.createSession();
    assert.equal(baseline.mode, "baseline");
    assert.equal(baseline.page_count, 1);
    const page = await fixture.service.readPage(baseline.session_id, 0);
    assert.equal(page.sha256, (await fixture.service.readPage(baseline.session_id, 0)).sha256);
    assert.match(page.payload, /principal_a/u);
    const firstReceipt = await fixture.service.complete(baseline.session_id);
    assert.deepEqual(await fixture.service.complete(baseline.session_id), firstReceipt);
    assert.deepEqual(await fixture.service.createSession(null, baseline.session_id), baseline);

    fixture.setSnapshot(snapshot(["principal_a", "principal_b"]));
    fixture.advance();
    const second = await fixture.service.createSession(firstReceipt.checkpoint);
    assert.equal(second.mode, "incremental");
    assert.match((await fixture.service.readPage(second.session_id, 0)).payload, /principal_b/u);
    assert.doesNotMatch((await fixture.service.readPage(second.session_id, 0)).payload, /principal_a/u);
    const secondReceipt = await fixture.service.complete(second.session_id);

    const unchanged = await fixture.service.createSession(secondReceipt.checkpoint);
    assert.equal((await fixture.service.readPage(unchanged.session_id, 0)).payload, "[]");
    const unchangedReceipt = await fixture.service.complete(unchanged.session_id);

    fixture.setSnapshot(snapshot(["principal_a"]));
    fixture.advance();
    const deleted = await fixture.service.createSession(unchangedReceipt.checkpoint);
    assert.ok(JSON.parse((await fixture.service.readPage(deleted.session_id, 0)).payload)
      .some((change) => change.kind === "delete" &&
        change.key === JSON.stringify(["principals", "principal_b"])));

    const stale = await fixture.service.createSession({
      ...firstReceipt.checkpoint, digest: `sha256:${"0".repeat(64)}`,
    });
    assert.equal(stale.mode, "rebaseline");
    assert.match((await fixture.service.readPage(stale.session_id, 0)).payload, /principal_a/u);
  } finally { fixture.database.close(); }
});

test("R2 object ranges are bounded and a deletion epoch rejects completion", async () => {
  const fixture = await setup();
  try {
    const bytes = new TextEncoder().encode("0123456789");
    const digest = await systemBackupSha256(bytes);
    const manifestBytes = new TextEncoder().encode("manifest");
    const manifestDigest = await systemBackupSha256(manifestBytes);
    const value = snapshot(["principal_a"]);
    value.revisionsById.set("revision_1", {
      revision: {
        spaceId: "space_1", manifestHash: manifestDigest,
        manifestSize: manifestBytes.byteLength,
      },
      manifest: {
        format: "mind-diary-revision-manifest-v4",
        entries: [{ kind: "markdown", sha256: digest,
          size: bytes.byteLength, mediaType: "text/markdown; charset=utf-8" }],
      },
    });
    fixture.setSnapshot(value);
    const manifestKey = `spaces/space_1/manifests/sha256/${manifestDigest.slice(7)}`;
    const objectKey = `spaces/space_1/objects/sha256/${digest.slice(7)}`;
    fixture.bucket.putBytes(manifestKey, manifestBytes, {
      sha256: manifestDigest,
      mediaType: "application/vnd.mind-diary.revision-manifest+json; charset=utf-8",
      state: "active",
    });
    fixture.bucket.putBytes(objectKey, bytes, {
      sha256: digest, mediaType: "text/markdown; charset=utf-8", state: "active",
    });
    const session = await fixture.service.createSession();
    assert.equal(session.object_count, 2);
    const inventory = await fixture.service.listInventory(session.session_id);
    assert.equal(inventory.items.length, 2);
    const objectIndex = inventory.items.find((item) => item.object_key === objectKey).object_index;
    const part = await fixture.service.readPart(session.session_id, objectIndex, 3, 4);
    assert.equal(new TextDecoder().decode(part.bytes), "3456");
    assert.equal(part.sha256, await systemBackupSha256("3456"));
    await assert.rejects(() => fixture.service.readPart(session.session_id,
      objectIndex, 0, 4 * 1024 * 1024 + 1), /invalid_range/u);

    fixture.database.database.exec(
      "UPDATE md_backup_control SET invalidation_epoch = invalidation_epoch + 1",
    );
    fixture.database.database.exec(
      "UPDATE md_backup_sessions SET status = 'invalidated' WHERE status = 'ready'",
    );
    await assert.rejects(() => fixture.service.complete(session.session_id),
      /backup_session_inactive/u);
    await assert.rejects(() => fixture.service.readPage(session.session_id, 0),
      /backup_session_inactive/u);
  } finally { fixture.database.close(); }
});

test("pending physical cleanup blocks target registration; expiry rejects old pages", async () => {
  const fixture = await setup();
  try {
    const barrier = new SystemBackupCleanupBarrier(fixture.database);
    let release;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const cleanup = barrier.run(async () => {
      started();
      await held;
      return true;
    });
    await startedPromise;
    await assert.rejects(() => fixture.service.createSession(), /backup_target_changed/u);
    release();
    assert.equal(await cleanup, true);
    const session = await fixture.service.createSession();
    fixture.setNow("2026-09-21T12:00:00.000Z");
    await assert.rejects(() => fixture.service.readPage(session.session_id, 0),
      /backup_session_inactive/u);
    await assert.rejects(() => fixture.service.complete(session.session_id),
      /backup_session_inactive/u);
  } finally { fixture.database.close(); }
});

test("an active target pins physical cleanup until deletion invalidates it", async () => {
  const fixture = await setup();
  try {
    const barrier = new SystemBackupCleanupBarrier(fixture.database);
    const session = await fixture.service.createSession();
    let deleted = false;
    assert.equal(await barrier.run(async () => { deleted = true; return true; }), false);
    assert.equal(deleted, false);
    fixture.database.database.exec(
      "UPDATE md_backup_control SET invalidation_epoch = invalidation_epoch + 1",
    );
    fixture.database.database.exec(
      "UPDATE md_backup_sessions SET status = 'invalidated' WHERE status = 'ready'",
    );
    assert.equal(await barrier.run(async () => { deleted = true; return true; }), true);
    assert.equal(deleted, true);
    await assert.rejects(() => fixture.service.complete(session.session_id),
      /backup_session_inactive/u);
  } finally { fixture.database.close(); }
});

test("operator HTTP requires independent bearer and does not accept Sites identity", async () => {
  const fixture = await setup();
  try {
    const key = new Uint8Array(32).fill(7);
    const handler = createSystemBackupHttpHandler({
      service: fixture.service, operatorKey: key,
      publicOrigin: "https://mind-diary.example",
    });
    const route = "https://mind-diary.example/api/v1/internal/system-backup/sessions";
    assert.equal((await handler(new Request(route, {
      method: "POST", headers: { "oai-authenticated-user-email": "operator@example.com" },
    }))).status, 404);
    const secret = Buffer.from(key).toString("base64url");
    const authorized = await handler(new Request(route, {
      method: "POST",
      headers: { authorization: `Bearer mdb_v1_${secret}` },
      body: JSON.stringify({ request_id: crypto.randomUUID() }),
    }));
    assert.equal(authorized.status, 201);
    assert.equal((await authorized.json()).format, "MD-SYSTEM-BACKUP-1");
  } finally { fixture.database.close(); }
});

test("a committed registration with a lost D1 response still publishes its exact target", async () => {
  const fixture = await setup();
  try {
    const prepare = fixture.database.prepare.bind(fixture.database);
    let rejected = false;
    fixture.database.prepare = (sql) => {
      const statement = prepare(sql);
      if (!rejected && sql.includes("/*md-backup-session-register*/")) {
        rejected = true;
        const run = statement.run.bind(statement);
        statement.run = async () => {
          await run();
          fixture.database.prepare = prepare;
          throw new Error("synthetic response lost after D1 commit");
        };
      }
      return statement;
    };
    const requestId = crypto.randomUUID();
    const session = await fixture.service.createSession(null, requestId);
    assert.equal(session.session_id, requestId);
    assert.equal(session.page_count, 1);
    assert.deepEqual(await fixture.service.createSession(null, requestId), session);
  } finally { fixture.database.close(); }
});

test("unknown durable D1 table fails closed before session registration", async () => {
  const fixture = await setup();
  try {
    fixture.database.database.exec("CREATE TABLE new_private_state (content TEXT)");
    await assert.rejects(() => fixture.service.createSession(),
      /schema mismatch/u);
    assert.equal(fixture.database.database.prepare(
      "SELECT COUNT(*) AS count FROM md_backup_sessions",
    ).get().count, 0);
  } finally { fixture.database.close(); }
});

test("portable records project the real Sites metadata snapshot without duplicating history", async () => {
  const database = new SqliteD1();
  try {
    const metadata = await createSitesMetadataStore(database);
    const bootstrap = new AccountBootstrapService({
      accounts: metadata,
      objects: new InMemoryObjectStore(),
      ids: {
        nextPrincipalId: () => "principal_backup_fixture",
        nextExternalBindingId: () => "binding_backup_fixture",
        nextSpaceId: () => "space_backup_fixture",
        nextMembershipId: () => "membership_backup_fixture",
        nextRevisionId: () => "revision_backup_fixture",
        nextPersonalSpaceHandle: () => "personal-backup-fixture",
      },
    });
    await bootstrap.bootstrapAccount({
      kind: "sites_identity_before_registration",
      authentication: { kind: "sites_identity", verifiedByPlatform: true },
      provider: "openai-sites",
      normalizedBinding: "backup.fixture@example.invalid",
      suggestedDisplayName: "Backup Fixture",
      deploymentCapabilities: CAPABILITIES,
      requestId: "request_backup_fixture",
      occurredAtUtc: "2026-09-13T12:00:00.000Z",
    }, { action: "create_isolated_account" });
    const capture = await metadata.captureSystemBackupState();
    const records = await systemBackupRecords(capture.snapshot);
    const spaces = records.filter((record) => JSON.parse(record.key)[0] === "spaces");
    assert.equal(spaces.length, 1);
    assert.deepEqual(Object.keys(decodeSystemBackupValue(JSON.parse(spaces[0].payload))), ["head"]);
    assert.ok(records.some((record) => JSON.parse(record.key)[0] === "revisionsById"));
    assert.ok(systemBackupObjectSeeds(capture.snapshot).length > 0);
  } finally { database.close(); }
});

test("thousands of metadata records use bounded D1 write statements and page reads", async () => {
  const fixture = await setup();
  try {
    fixture.setSnapshot(snapshot(Array.from({ length: 5_000 }, (_, index) =>
      `principal_${String(index).padStart(5, "0")}`)));
    const prepare = fixture.database.prepare.bind(fixture.database);
    let writes = 0;
    fixture.database.prepare = (sql) => {
      if (/\/\*md-backup-(?:page|digest|inventory)-write\*\//u.test(sql)) writes += 1;
      return prepare(sql);
    };
    const session = await fixture.service.createSession();
    assert.ok(session.page_count > 1);
    assert.ok(writes <= 30, `unexpected D1 write count: ${writes}`);
    for (let index = 0; index < session.page_count; index += 1) {
      const page = await fixture.service.readPage(session.session_id, index);
      assert.ok(page.byte_size <= 128 * 1024);
    }
  } finally { fixture.database.close(); }
});

test("a truncated completed base cannot silently become an incremental delta", async () => {
  const fixture = await setup();
  try {
    const initial = await fixture.service.createSession();
    const receipt = await fixture.service.complete(initial.session_id);
    fixture.database.database.prepare(
      "DELETE FROM md_backup_record_digests WHERE session_id = ?",
    ).run(initial.session_id);
    await assert.rejects(() => fixture.service.createSession(receipt.checkpoint),
      /backup_base_corrupt/u);
  } finally { fixture.database.close(); }
});

test("expired server retention prunes old checkpoint state and safely rebaselines", async () => {
  const fixture = await setup();
  try {
    const initial = await fixture.service.createSession();
    const receipt = await fixture.service.complete(initial.session_id);
    fixture.setNow("2026-10-15T12:00:00.000Z");
    const next = await fixture.service.createSession(receipt.checkpoint);
    assert.equal(next.mode, "rebaseline");
    assert.equal(fixture.database.database.prepare(
      "SELECT COUNT(*) AS count FROM md_backup_sessions WHERE session_id = ?",
    ).get(initial.session_id).count, 0);
    assert.equal(fixture.database.database.prepare(
      "SELECT COUNT(*) AS count FROM md_backup_record_digests WHERE session_id = ?",
    ).get(initial.session_id).count, 0);
  } finally { fixture.database.close(); }
});

test("portable typed encoding keeps ordinary marker-shaped data distinct from Maps", async () => {
  const value = snapshot();
  value.principals.set("principal_marker", {
    __md_backup_type: "map",
    entries: [["user", "data"]],
    nested: new Map([["key", new Uint8Array([0, 1, 255])]]),
  });
  const record = (await systemBackupRecords(value)).find((item) =>
    item.key === JSON.stringify(["principals", "principal_marker"]));
  const decoded = decodeSystemBackupValue(JSON.parse(record.payload));
  assert.equal(decoded.__md_backup_type, "map");
  assert.deepEqual(decoded.entries, [["user", "data"]]);
  assert.deepEqual(decoded.nested.get("key"), new Uint8Array([0, 1, 255]));
});
