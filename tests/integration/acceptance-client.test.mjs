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

test("fixture commits reconcile a deadline with the original payload while model transport never retries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const productError = { code: "request_timeout", message: "A write may still commit; reconcile using the original key.", retryable: true };
  const client = await new AcceptanceClient({ directory, platformToken: "synthetic", controllerKey: "synthetic", fetch: async (_url, options) => {
    const request = JSON.parse(options.body).params;
    calls.push(request);
    if (request.name === "commit_changeset") return Response.json({ ok: false, error: productError }, { status: 503 });
    assert.equal(request.name, "reconcile_changeset");
    assert.deepEqual(request.arguments, calls[0].arguments);
    return Response.json({ result: { isError: false, structuredContent: { ok: true, data: { status: "committed", revision: { revision_id: "revision-2" } } } } });
  } }).open();
  client.state.run = { run_id: "synthetic-run" };
  const result = await client.commit("fixture", "synthetic", { mind: "/me", expected_revision: "revision-1", operations: [] });
  assert.equal(result.status, "committed");
  assert.deepEqual(calls.map(c => c.name), ["commit_changeset", "reconcile_changeset"]);
  await assert.rejects(client.mcpEnvelope("synthetic", "tools/call", { name: "commit_changeset", arguments: {} }), error => {
    assert.equal(error.message, "mcp_http_503");
    assert.deepEqual(error.productError, productError);
    return true;
  });
  assert.equal(calls.length, 3, "model-facing transport must make exactly one attempt");
});

test("fixture deadline retries are bounded and retain a pending operation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-deadline-cap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const client = await new AcceptanceClient({ directory, platformToken: "synthetic", controllerKey: "synthetic", fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body).params);
    return Response.json({ ok: false, error: { code: "request_timeout", retryable: true } }, { status: 503 });
  } }).open();
  client.state.run = { run_id: "synthetic-run" };
  await assert.rejects(client.commit("fixture", "synthetic", { mind: "/me", operations: [] }), /mcp_http_503/);
  assert.deepEqual(calls.map(c => c.name), ["commit_changeset", "reconcile_changeset", "reconcile_changeset"]);
  for (const call of calls) assert.deepEqual(call.arguments, calls[0].arguments);
  assert.equal(client.state.operations["mcp:fixture"].phase, "pending");
});
