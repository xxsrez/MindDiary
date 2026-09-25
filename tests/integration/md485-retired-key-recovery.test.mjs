import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { DEFAULT_CAPACITY_LIMITS } from "../../packages/application-content/dist/index.js";
import { AcceptanceSessionStore } from "../../apps/mind-diary-acceptance/session-store.mjs";
import { recoverMd485RetiredKey } from "../../apps/mind-diary-acceptance/md485-retired-key-recovery.mjs";

const runId = "c9520f86-1879-46a6-81ff-d1b5a5f92db2";
const spaceId = "space_f631d87d-b34a-4bf2-94e7-53f6cc38f653";
const hash = "01d91ab7a09b83c2ab09ea27fc224a2d9aaf0c8604892e50cb943df4010c1ba4";
const key = `spaces/${spaceId}/objects/sha256/${hash}`;
const sidecar = `spaces/${spaceId}/integrity/${encodeURIComponent(key)}`;

async function fixture() {
  const database = new SqliteD1();
  await createSitesMetadataStore(database);
  const store = new AcceptanceSessionStore(database);
  await store.ready();
  await database.prepare(`INSERT INTO md_acceptance_runs
    (id, request_key, actor_count, profile, created_at, expires_at, state)
    VALUES (?, 'synthetic', 4, 'collaboration', 1, 2, 'cleaning')`).bind(runId).run();
  await database.prepare(`INSERT INTO md_acceptance_actors
    (id, run_id, ordinal, subject, principal_id)
    VALUES ('actor', ?, 0, 'synthetic@example.invalid', 'deleted_principal')`).bind(runId).run();
  await database.prepare(`CREATE TABLE md_acceptance_cleanup_journal
    (actor_id TEXT PRIMARY KEY, command_json TEXT, result_json TEXT,
     done INTEGER NOT NULL DEFAULT 0)`).run();
  await database.prepare(`CREATE TABLE md_acceptance_cleanup_receipts
    (run_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL)`).run();
  await database.prepare(`INSERT INTO md_acceptance_cleanup_journal
    (actor_id, done) VALUES ('actor', 0)`).run();
  await database.prepare(`INSERT INTO md_canonical_key_gates
    (key_digest, operation_id, acquired_at) VALUES
    ('d773c772d58519ef94f1099579ffe64f4be9db93af1f2d58f0164b351743fe57',
     'e21698c6-8e4c-4bfa-86c3-080d45711b9c', '2026-09-25T19:07:30.743Z')`).run();
  await database.prepare(`INSERT INTO md_backup_cleanup_ops
    (operation_id, started_at) VALUES
    ('66467e32-39a4-4ada-aec2-c0627352710f', '2026-09-25T19:07:31.285Z')`).run();
  const objects = new Map([
    [key, { size: 61, customMetadata: { spaceId,
      kind: "markdown", sha256: `sha256:${hash}` } }],
    [sidecar, { size: 406, customMetadata: { spaceId,
      objectKey: key, sha256: `sha256:${hash}` } }],
  ]);
  let failSidecar = true;
  const bucket = {
    async head(address) { return objects.get(address) ?? null; },
    async list() { return { objects: [...objects].map(([address, item]) =>
      ({ key: address, size: item.size, customMetadata: item.customMetadata })), truncated: false }; },
    async delete(address) {
      if (address === sidecar && failSidecar) {
        failSidecar = false;
        throw new Error("synthetic lost sidecar response");
      }
      objects.delete(address);
    },
  };
  return { database, objects, environment: { DB: database, MIND_DIARY_BUCKET: bucket } };
}

test("exact retired-key cleanup retries physical deletion and conditionally releases only its gate", async () => {
  const f = await fixture();
  try {
    const initial = await recoverMd485RetiredKey(f.environment, "inspect");
    assert.equal(initial.eligible, true);
    assert.deepEqual(initial.residual_objects.map(({ key, bytes }) => ({ key, bytes })), [
      { key, bytes: 61 }, { key: sidecar, bytes: 406 },
    ]);
    assert.equal(initial.residual_objects[0].metadata.space_id, spaceId);
    await f.database.prepare(
      "UPDATE md_canonical_key_gates SET operation_id = 'different'",
    ).run();
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "delete"),
      /recovery_preflight_failed/u);
    await f.database.prepare(
      "UPDATE md_canonical_key_gates SET operation_id = 'e21698c6-8e4c-4bfa-86c3-080d45711b9c'",
    ).run();
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "delete"),
      /synthetic lost sidecar response/u);
    assert.equal(f.objects.has(key), false);
    assert.equal((await recoverMd485RetiredKey(f.environment, "inspect")).eligible, true);
    assert.deepEqual(await recoverMd485RetiredKey(f.environment, "delete"), { deleted: true });
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "release"),
      /recovery_release_preflight_failed/u);
    await f.database.prepare(
      "UPDATE md_acceptance_cleanup_journal SET done = 1 WHERE actor_id = 'actor'",
    ).run();
    const originalPrepare = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes("DELETE FROM md_canonical_key_gates")) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          f.database.prepare = originalPrepare;
          await originalPrepare(
            "UPDATE md_backup_control SET backup_sequence = backup_sequence + 1",
          ).run();
          return run();
        };
      }
      return statement;
    };
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "release"),
      /recovery_release_unconfirmed/u);
    await originalPrepare(
      "UPDATE md_backup_control SET backup_sequence = backup_sequence - 1",
    ).run();
    assert.deepEqual(await recoverMd485RetiredKey(f.environment, "release"), { released: true });
    assert.deepEqual(await recoverMd485RetiredKey(f.environment, "release"),
      { released: true, replayed: true });
    await f.database.prepare("DELETE FROM md_acceptance_cleanup_journal").run();
    await f.database.prepare("DELETE FROM md_acceptance_actors").run();
    await f.database.prepare("DELETE FROM md_backup_cleanup_ops").run();
    await f.database.prepare(
      "UPDATE md_acceptance_runs SET state = 'cleaned' WHERE id = ?",
    ).bind(runId).run();
    await f.database.prepare(`INSERT INTO md_acceptance_cleanup_receipts
      (run_id, receipt_json) VALUES (?, ?)`).bind(runId,
      JSON.stringify({ run_id: runId, state: "cleaned" })).run();
    assert.deepEqual(await recoverMd485RetiredKey(f.environment, "release"),
      { released: true, replayed: true });
  } finally { f.database.close(); }
});

test("unsettled canonical writer blocks retired-key recovery before any R2 delete", async () => {
  const f = await fixture();
  try {
    const metadata = await createSitesMetadataStore(f.database);
    const request = {
      reservationId: "capacity:commit:unsettled-md485", requestedByPrincipalId: "principal_synthetic",
      spaceId, operation: "commit", operationRef: "synthetic-unsettled",
      baseRevisionId: null, idempotencyKey: "synthetic-unsettled",
      requested: { physicalCanonicalBytes: 61, temporaryBytes: 0, d1MetadataBytes: 512 },
      bulk: false, heavy: false, createdAt: "2026-09-25T19:07:00.000Z",
      expiresAt: "2026-09-25T19:22:00.000Z",
    };
    const admitted = await metadata.runCapacityTransaction((transaction) =>
      transaction.admitCapacityReservation(request, DEFAULT_CAPACITY_LIMITS));
    assert.equal(admitted.kind, "admitted");
    assert.equal((await recoverMd485RetiredKey(f.environment, "inspect")).eligible, false);
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "delete"),
      /recovery_preflight_failed/u);
    assert.equal(f.objects.has(key), true);
    await metadata.runCapacityTransaction((transaction) =>
      transaction.cancelCapacityReservation({ reservationId: request.reservationId,
        canceledAt: "2026-09-25T19:08:00.000Z" }));
    const pending = (await metadata.listCapacityReservationsForSpace(spaceId))[0];
    assert.equal(pending.state, "cleanup_pending");
    assert.equal(pending.writerClosedAt ?? null, null);
    assert.equal((await recoverMd485RetiredKey(f.environment, "inspect")).eligible, false);
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "delete"),
      /recovery_preflight_failed/u);
    assert.equal(f.objects.has(key), true);
  } finally { f.database.close(); }
});

test("staging recovery rejects foreign metadata before deletion and safely replays", async () => {
  const f = await fixture();
  const ids = [
    ["import-file_082b0fa6-b42a-4e68-9f07-7bbfbf7b74b8", 75],
    ["import-file_9f913556-f976-45ba-af28-d60417278ea9", 61],
    ["import-file_cece5305-7fea-4bbe-98a3-a3cdeba20f51", 59],
  ];
  try {
    f.objects.clear();
    for (const [id, size] of ids) f.objects.set(`staged-bundle-files/${id}`, {
      size, customMetadata: { schema: "md-r2-staged-bundle-file-v1",
        stagedFileId: id, spaceId, size: String(size),
        bindingOwnerId: "import-owner_import_02d9cd7c-c7d8-4928-877f-a69e10df7fa0",
        createdAt: "2026-09-25T19:03:11.134Z" },
    });
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "delete_staging"),
      /recovery_staging_preflight_failed/u);
    await f.database.prepare("UPDATE md_acceptance_cleanup_journal SET done = 1").run();
    const last = f.objects.get(`staged-bundle-files/${ids[2][0]}`);
    last.customMetadata.spaceId = "foreign-space";
    await assert.rejects(() => recoverMd485RetiredKey(f.environment, "delete_staging"),
      /recovery_staging_preflight_failed/u);
    assert.equal(f.objects.size, 3);
    last.customMetadata.spaceId = spaceId;
    assert.deepEqual(await recoverMd485RetiredKey(f.environment, "delete_staging"),
      { staging_deleted: true });
    assert.equal(f.objects.size, 0);
    assert.deepEqual(await recoverMd485RetiredKey(f.environment, "delete_staging"),
      { staging_deleted: true });
    assert.deepEqual(await recoverMd485RetiredKey(f.environment, "release"), { released: true });
  } finally { f.database.close(); }
});
