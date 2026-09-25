import test from "node:test";
import assert from "node:assert/strict";
import { handleAcceptanceSession } from "../../apps/mind-diary-acceptance/session-http.mjs";
import { AcceptanceSessionStore } from "../../apps/mind-diary-acceptance/session-store.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";

test("controller and browser exchange reject forged identity, origin and oversized bodies", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const store = new AcceptanceSessionStore(db), key = "a".repeat(43);
  const call = (path, body, headers = {}) => handleAcceptanceSession(new Request(ACCEPTANCE_ORIGIN + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  }), store, key);
  const controller = { authorization: `Bearer ${key}`, "idempotency-key": "http-test-run-0001" };
  assert.equal((await call("/_acceptance/runs", {})).status, 401);
  assert.equal((await call("/_acceptance/runs", {}, { ...controller, origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await call("/_acceptance/runs", { email: "owner@example.com" }, controller)).status, 400);
  assert.equal((await call("/_acceptance/runs", "x".repeat(16385), controller)).status, 400);
  const run = await (await call("/_acceptance/runs", {}, controller)).json();
  const external = `/_acceptance/runs/${run.run_id}/external-mcp`;
  assert.equal((await call(external, { ttl_seconds: 60 })).status, 401);
  assert.equal((await call(external, { ttl_seconds: 60 }, { ...controller, origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await call(external, { ttl_seconds: 901 }, controller)).status, 400);
  assert.equal((await call(external, { ttl_seconds: 60 }, controller)).status, 403);
  await store.bindPrincipal({ id: run.actors[0].actor_id, run_id: run.run_id }, "test-owner");
  assert.equal((await call(external, { ttl_seconds: 60 }, controller)).status, 200);
  const exchange = await (await call(`/_acceptance/runs/${run.run_id}/exchanges`, { actor_id: run.actors[0].actor_id }, controller)).json();
  assert.equal((await call("/_acceptance/session", { code: exchange.code })).status, 403);
  assert.equal((await call("/_acceptance/session", { code: exchange.code }, { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await call("/_acceptance/session", { code: exchange.code, principal_id: "forged" }, { origin: ACCEPTANCE_ORIGIN })).status, 400);
  const accepted = await call("/_acceptance/session", { code: exchange.code }, { origin: ACCEPTANCE_ORIGIN });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { status: "authenticated" });
  assert.match(accepted.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await call("/_acceptance/session", { code: exchange.code }, { origin: ACCEPTANCE_ORIGIN })).status, 401);
});

test("canonical gate probe requires the acceptance controller", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const store = new AcceptanceSessionStore(db), key = "a".repeat(43);
  let reads = 0;
  const call = (headers = {}) => handleAcceptanceSession(
    new Request(ACCEPTANCE_ORIGIN + "/_acceptance/canonical-gate-probe", { headers }),
    store, key, undefined, undefined, undefined, undefined,
    async () => { reads += 1; return { gate_count: 0, probe_complete: true }; },
  );
  assert.equal((await call()).status, 401);
  assert.equal((await call({ origin: "https://foreign.invalid", authorization: `Bearer ${key}` })).status, 403);
  assert.equal(reads, 0);
  const response = await call({ authorization: `Bearer ${key}` });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { gate_count: 0, probe_complete: true });
  assert.equal(reads, 1);
});
