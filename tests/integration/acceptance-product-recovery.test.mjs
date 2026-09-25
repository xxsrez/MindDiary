import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";

test("isolated controller recovery uses a bounded product clock without changing run time", async (t) => {
  const constructed = [];
  const runtime = await acceptanceRuntime(t, {
    createRuntime: async (options) => {
      constructed.push(options.now);
      return {
        fetch: async () => new Response(null, { status: 401 }),
        recoverBackground: async () => ({
          backfilled: 0, repaired: 0, dispatched: 0, failed: 0,
          cleanupDeleted: 0, cleanupReclaimedBytes: 0,
        }),
      };
    },
  });
  const client = await new AcceptanceClient({
    directory: join(runtime.directory, "product-recovery"),
    platformToken: "test",
    controllerKey: runtime.controllerKey,
    fetch: runtime.fetch,
  }).open();
  const run = await client.setup();
  const path = `/_acceptance/runs/${run.run_id}/product-recovery`;
  const system = await client.control(path, "POST", { advance_hours: 0 });
  assert.equal(system.clock, "system");
  assert.equal(constructed[0], undefined);
  const before = Date.now();
  const advanced = await client.control(path, "POST", { advance_hours: 25 });
  assert.equal(advanced.clock, "advanced_25_hours");
  const shifted = constructed[1]().getTime();
  assert.ok(shifted >= before + 25 * 3_600_000);
  assert.ok(shifted <= Date.now() + 25 * 3_600_000);
  const second = await new AcceptanceClient({
    directory: join(runtime.directory, "other-run"),
    platformToken: "test",
    controllerKey: runtime.controllerKey,
    fetch: runtime.fetch,
  }).open();
  await second.setup();
  await assert.rejects(client.control(path, "POST", { advance_hours: 25 }),
    /acceptance_control_http_503/);
  assert.equal(constructed.length, 2);
});
