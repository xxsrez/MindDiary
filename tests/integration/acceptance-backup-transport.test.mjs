import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

test("acceptance controller can complete a synthetic backup without a Product key", async (t) => {
  const { fetch, controllerKey, bucket } = await acceptanceRuntime(t);
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
  let cleaned;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${ACCEPTANCE_ORIGIN}/_acceptance/runs/${run.run_id}/cleanup`, {
      method: "POST", headers: { authorization: `Bearer ${controllerKey}`,
        "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 200);
    cleaned = await response.json();
    if (cleaned.state === "cleaned") break;
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
