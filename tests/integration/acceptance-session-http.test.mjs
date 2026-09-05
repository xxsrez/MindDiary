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
  const controller = { "x-md-acceptance-controller": key, "idempotency-key": "http-test-run-0001" };
  assert.equal((await call("/_acceptance/runs", {})).status, 401);
  assert.equal((await call("/_acceptance/runs", {}, { ...controller, origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await call("/_acceptance/runs", { email: "owner@example.com" }, controller)).status, 400);
  assert.equal((await call("/_acceptance/runs", "x".repeat(16385), controller)).status, 400);
  const run = await (await call("/_acceptance/runs", {}, controller)).json();
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
