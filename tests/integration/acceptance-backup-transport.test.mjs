import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { join } from "node:path";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createCollaborationFixture } from "../../scripts/lib/acceptance-fixture.mjs";

test("acceptance controller can complete a synthetic backup without a Product key", async (t) => {
  const { fetch, controllerKey, bucket, db } = await acceptanceRuntime(t);
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => ({ ...await list(options), delimitedPrefixes: [] });
  const started = await fetch(`${ACCEPTANCE_ORIGIN}/_acceptance/runs`, {
    method: "POST", headers: { authorization: `Bearer ${controllerKey}`,
      "content-type": "application/json", "idempotency-key": `backup-test-${randomUUID()}` },
    body: JSON.stringify({ profile: "operator", actor_count: 4 }),
  });
  assert.equal(started.status, 200);
  const run = await started.json();
  const url = `${ACCEPTANCE_ORIGIN}/api/v1/internal/system-backup/sessions`;
  const request = { method: "POST", body: JSON.stringify({ request_id: randomUUID() }),
    headers: { "content-type": "application/json", "x-md-acceptance-run": run.run_id } };
  assert.equal((await fetch(url, request)).status, 404);
  const authorized = { ...request, headers: { ...request.headers,
    authorization: `Bearer mdb_v1_${controllerKey}` } };
  assert.equal((await fetch(url, { ...authorized, headers: {
    "content-type": "application/json", authorization: authorized.headers.authorization,
  } })).status, 404);
  const created = await fetch(url, authorized);
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const descriptor = await created.json();
  assert.equal(descriptor.format, "MD-SYSTEM-BACKUP-1");
  assert.equal(descriptor.mode, "baseline");
  assert.ok(descriptor.page_count > 0);
  for (let index = 0; index < descriptor.page_count; index++) {
    const page = await fetch(`${url}/${descriptor.session_id}/pages/${index}`, {
      headers: authorized.headers,
    });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("x-md-backup-sha256"), /^sha256:[0-9a-f]{64}$/u);
  }
  const inventory = await fetch(`${url}/${descriptor.session_id}/inventory?cursor=0&limit=128`, {
    headers: authorized.headers,
  });
  assert.equal(inventory.status, 200);
  const receipt = await fetch(`${url}/${descriptor.session_id}/complete`, {
    method: "POST", headers: authorized.headers,
  });
  assert.equal(receipt.status, 200);
  const value = await receipt.json();
  assert.deepEqual(value.checkpoint, descriptor.target_checkpoint);
  assert.equal(value.manifest_digest, descriptor.manifest_digest);
  await db.prepare("INSERT INTO md_backup_cleanup_ops (operation_id, started_at) VALUES (?1, ?2)")
    .bind(randomUUID(), new Date().toISOString()).run();
  let cleaned;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${ACCEPTANCE_ORIGIN}/_acceptance/runs/${run.run_id}/cleanup`, {
      method: "POST", headers: { authorization: `Bearer ${controllerKey}`,
        "content-type": "application/json" }, body: "{}",
    });
    if (attempt === 3) {
      assert.equal(response.status, 503);
      await db.prepare("UPDATE md_backup_cleanup_ops SET started_at = ?1")
        .bind(new Date(Date.now() - 600_000).toISOString()).run();
      continue;
    }
    assert.equal(response.status, 200);
    cleaned = await response.json();
    if (cleaned.state === "cleaned") break;
  }
  if (cleaned?.state !== "cleaned") {
    const response = await fetch(`${ACCEPTANCE_ORIGIN}/_acceptance/runs/${run.run_id}/cleanup`, {
      method: "POST", headers: { authorization: `Bearer ${controllerKey}`,
        "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 200);
    cleaned = await response.json();
  }
  assert.equal(cleaned.state, "cleaned");
  const inventoryResponse = await fetch(`${ACCEPTANCE_ORIGIN}/_acceptance/inventory`, {
    headers: { authorization: `Bearer ${controllerKey}` },
  });
  assert.equal(inventoryResponse.status, 200);
  const postCleanup = await inventoryResponse.json();
  assert.equal(postCleanup.rows.md_backup_sessions, 0);
  assert.equal(postCleanup.rows.md_backup_pages, 0);
  assert.equal(postCleanup.rows.md_backup_inventory, 0);
});

test("synthetic multi-principal fixture can start a hosted backup session", async (t) => {
  const runtime = await acceptanceRuntime(t);
  const list = runtime.bucket.list.bind(runtime.bucket);
  runtime.bucket.list = async (options) => ({ ...await list(options), delimitedPrefixes: [] });
  const client = await new AcceptanceClient({
    directory: join(runtime.directory, "backup-fixture"),
    platformToken: "test-platform", controllerKey: runtime.controllerKey,
    fetch: runtime.fetch,
  }).open();
  await client.setup({ profile: "operator" });
  await createCollaborationFixture(client);
  const response = await runtime.fetch(`${ACCEPTANCE_ORIGIN}/api/v1/internal/system-backup/sessions`, {
    method: "POST", headers: { authorization: `Bearer mdb_v1_${runtime.controllerKey}`,
      "content-type": "application/json", "x-md-acceptance-run": client.state.run.run_id },
    body: JSON.stringify({ request_id: randomUUID() }),
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const descriptor = await response.json();
  assert.ok(descriptor.record_count > 0);
});
