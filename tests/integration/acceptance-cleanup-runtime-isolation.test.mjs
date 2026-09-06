import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createProductSiteRuntime } from "../../packages/composition-root/dist/index.js";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createCollaborationFixture } from "../../scripts/lib/acceptance-fixture.mjs";

test("cleanup retry escapes an abandoned product runtime and fences the late attempt", async t => {
  let armed = false, injected = false, release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const runtime = await acceptanceRuntime(t, { createRuntime: async options => {
    const product = await createProductSiteRuntime(options);
    const stalled = armed && !injected;
    if (stalled) injected = true;
    return { ...product, async fetch(request, ...rest) {
      if (stalled && new URL(request.url).pathname === "/api/v1/session") {
        entered(); await held;
      }
      return product.fetch(request, ...rest);
    } };
  } });
  const client = await new AcceptanceClient({ directory: join(runtime.directory, "run"), platformToken: "test", controllerKey: runtime.controllerKey, fetch: runtime.fetch, sleep: async () => {} }).open();
  const baseline = await client.control("/_acceptance/inventory");
  await createCollaborationFixture(client); await runtime.drain();
  armed = true;
  const path = `/_acceptance/runs/${client.state.run.run_id}/cleanup`;
  const abandoned = client.control(path, "POST", {}).then(value => ({ value }), error => ({ error }));
  let retried;
  try {
    await started;
    // Advance only the durable cleanup lease in this local fault-injection test.
    // No elapsed-time claim is made for the separate hosted recovery contract.
    await runtime.db.prepare("UPDATE md_acceptance_cleanup_locks SET expires_at = 0 WHERE run_id = ?").bind(client.state.run.run_id).run();
    retried = client.cleanup({ retryTransient: false });
    let timer;
    try {
      const receipt = await Promise.race([retried, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("retry_inherited_abandoned_runtime")), 5000); })]);
      assert.equal(receipt.state, "cleaned");
      assert.equal(receipt.actors_cleaned, 4);
      assert.deepEqual(await client.control("/_acceptance/inventory"), baseline);
    } finally { clearTimeout(timer); }
  } finally {
    release(); await retried?.catch(() => {});
    const late = await abandoned;
    assert.match(late.error?.message ?? "", /acceptance_control_http_503/);
    await runtime.drain();
  }
  assert.equal(injected, true);
  assert.deepEqual(await client.control("/_acceptance/inventory"), baseline);
});
