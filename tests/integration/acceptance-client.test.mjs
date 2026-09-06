import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";

test("private client recovers unknown creation and mutation using the original keys", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-client-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = [], mutations = []; let failedCreate = false, failedMutation = false;
  const transport = async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (url.endsWith("/_acceptance/runs")) {
      keys.push(options.headers["idempotency-key"]);
      if (!failedCreate) { failedCreate = true; throw new Error("lost_response"); }
      return Response.json({ run_id: "run", actors: [{ actor_id: "actor" }] });
    }
    mutations.push(options.headers["idempotency-key"]);
    const journal = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
    assert.equal(journal.operations.bootstrap.phase, "pending");
    if (!failedMutation) { failedMutation = true; throw new Error("lost_response"); }
    return Response.json({ data: { created: true } });
  };
  const config = { directory, platformToken: "test-platform", controllerKey: "test-controller", fetch: transport };
  const first = await new AcceptanceClient(config).open();
  await assert.rejects(first.setup(), /lost_response/);
  const restored = await new AcceptanceClient(config).open(); await restored.setup(); assert.equal(keys[0], keys[1]);
  restored.state.actors.actor = { cookie: "test-cookie" }; await restored.save();
  const command = { path: "/api/v1/account", body: { action: "create_isolated_account" }, csrf: "csrf" };
  await assert.rejects(restored.mutation("bootstrap", "actor", command), /lost_response/);
  const next = await new AcceptanceClient(config).open();
  assert.deepEqual(await next.mutation("bootstrap", "actor", command), { data: { created: true } });
  assert.equal(mutations[0], mutations[1]);
  assert.deepEqual(await next.mutation("bootstrap", "actor", command), { data: { created: true } });
  assert.equal(mutations.length, 2);
  await assert.rejects(next.mutation("bootstrap", "actor", { ...command, body: {} }), /operation_payload_changed/);
  await assert.rejects(next.request("//foreign.invalid/"), /foreign_target_denied/);
});

test("recovery resumes bounded 503 cleanup chunks and preserves another active run", async t => {
  const runtime = await acceptanceRuntime(t);
  const config = directory => ({ directory: join(runtime.directory, directory), platformToken: "test-platform", controllerKey: runtime.controllerKey, fetch: runtime.fetch, sleep: async () => {} });
  const first = await new AcceptanceClient(config("sweep-first")).open();
  const second = await new AcceptanceClient(config("sweep-second")).open();
  await first.setup(); await second.setup();
  await second.control(`/_acceptance/runs/${second.state.run.run_id}`, "DELETE");
  const recovered = await first.recoverDueRuns([second.state.run.run_id]);
  assert.ok(recovered.attempts > 1);
  assert.equal(recovered.runs[0].state, "cleaned");
  assert.equal((await first.control(`/_acceptance/runs/${first.state.run.run_id}`)).state, "active");
  await first.cleanup(); await second.cleanup();
});
