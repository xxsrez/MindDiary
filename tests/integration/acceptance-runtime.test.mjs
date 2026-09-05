import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { FakeR2Bucket } from "../../scripts/lib/fake-sites-storage.mjs";
import { ACCEPTANCE_ORIGIN, ACCEPTANCE_PROJECT } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

test("four real bootstraps and normal bearer auth remain constrained by the run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "md-acceptance-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const compiled = await build({ absWorkingDir: resolve(import.meta.dirname, "../.."), entryPoints: ["apps/mind-diary-acceptance/entry.mjs"], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent", define: { __MD_ACCEPTANCE_BUILD__: "null" } });
  await writeFile(join(directory, "worker.mjs"), compiled.outputFiles[0].contents);
  const worker = (await import(pathToFileURL(join(directory, "worker.mjs")).href)).default;
  const database = new SqliteD1(); t.after(() => database.close());
  const env = { DB: database, MIND_DIARY_BUCKET: new FakeR2Bucket(), MIND_DIARY_PUBLIC_ORIGIN: ACCEPTANCE_ORIGIN, MD_ACCEPTANCE_PROJECT_ID: ACCEPTANCE_PROJECT, MD_ACCEPTANCE_CONTROLLER_KEY: "a".repeat(43) };
  for (const [i, name] of ["TOKEN_VERIFIER", "LOCATOR", "EXPORT_DOWNLOAD_VERIFIER", "CSRF"].entries()) env[`MIND_DIARY_${name}_KEY`] = Buffer.alloc(32, i + 1).toString("base64url");
  const pending = [];
  const call = (path, options = {}) => worker.fetch(new Request(ACCEPTANCE_ORIGIN + path, options), env, { waitUntil(p) { pending.push(p); } });
  const control = (path, method = "GET", body) => call(path, { method, headers: { "x-md-acceptance-controller": env.MD_ACCEPTANCE_CONTROLLER_KEY, "idempotency-key": "runtime-test-run-0001", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const runResponse = await control("/_acceptance/runs", "POST", {});
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json(), principals = new Set(), minds = new Set();
  const actors = [];
  for (const actor of run.actors) {
    const exchangeResponse = await control(`/_acceptance/runs/${run.run_id}/exchanges`, "POST", { actor_id: actor.actor_id });
    const { code } = await exchangeResponse.json();
    const loggedIn = await call("/_acceptance/session", { method: "POST", headers: { origin: ACCEPTANCE_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    assert.equal(loggedIn.status, 200);
    const cookie = loggedIn.headers.get("set-cookie").split(";")[0];
    const page = await call("/", { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /registration_required/);
    const csrf = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    const bootstrap = await call("/api/v1/account", { method: "POST", headers: { cookie, origin: ACCEPTANCE_ORIGIN, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `bootstrap:${actor.actor_id}` }, body: JSON.stringify({ action: "create_isolated_account" }) });
    assert.equal(bootstrap.status, 200);
    const session = (await bootstrap.json()).data;
    principals.add(session.principal_id); minds.add(session.personal_mind.mind_id);
    actors.push({ cookie, principal: session.principal_id });
  }
  assert.equal(principals.size, 4); assert.equal(minds.size, 4);
  const bound = await (await control(`/_acceptance/runs/${run.run_id}`)).json();
  assert.ok(bound.actors.every((actor) => actor.registered));
  const cookie = actors[0].cookie;
  const settings = await (await call("/settings/developer/mcp", { headers: { cookie } })).text();
  const csrf = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(settings)?.[1];
  const minted = await call("/api/v1/mcp-tokens", { method: "POST", headers: { cookie, origin: ACCEPTANCE_ORIGIN, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": "runtime-test-token-0001" }, body: JSON.stringify({ name: "Acceptance fixture", scopes: ["content:read"] }) });
  assert.equal(minted.status, 200);
  const credential = (await minted.json()).data.secret;
  const mcp = (runId, token = credential) => call("/api/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-md-acceptance-run": runId, "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list", accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "acceptance-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  const accepted = await mcp(run.run_id);
  assert.equal(accepted.status, 200, await accepted.text());
  assert.equal((await mcp(crypto.randomUUID())).status, 401);
  assert.equal((await mcp(run.run_id, "invalid")).status, 401);
  assert.equal((await control(`/_acceptance/runs/${run.run_id}`, "DELETE")).status, 200);
  assert.equal((await mcp(run.run_id)).status, 401);
  assert.equal((await call("/api/v1/session", { headers: { cookie } })).status, 401);
  await Promise.allSettled(pending);
  const bucketDelete = env.MIND_DIARY_BUCKET.delete.bind(env.MIND_DIARY_BUCKET);
  let failedDelete = false;
  env.MIND_DIARY_BUCKET.delete = async (...args) => {
    if (!failedDelete) { failedDelete = true; throw new Error("Injected object cleanup failure"); }
    return bucketDelete(...args);
  };
  let interrupted;
  for (let attempt = 0; attempt < 4; attempt++) {
    interrupted = await control(`/_acceptance/runs/${run.run_id}/cleanup`, "POST", {});
    if (interrupted.status === 503) break;
  }
  assert.equal(interrupted.status, 503);
  assert.equal(failedDelete, true);
  let cleaned;
  for (let attempt = 0; attempt < 5; attempt++) {
    cleaned = await control(`/_acceptance/runs/${run.run_id}/cleanup`, "POST", {});
    if ((await cleaned.clone().json()).state === "cleaned") break;
  }
  assert.equal(cleaned.status, 200, await cleaned.clone().text());
  const receipt = await cleaned.json();
  assert.equal(receipt.state, "cleaned"); assert.equal(receipt.actors_cleaned, 4);
  const repeated = await control(`/_acceptance/runs/${run.run_id}/cleanup`, "POST", {});
  assert.deepEqual(await repeated.json(), receipt);
  assert.equal((await mcp(run.run_id)).status, 401);
  await Promise.allSettled(pending);
  assert.equal(env.MIND_DIARY_BUCKET.records.size, 0);
});
