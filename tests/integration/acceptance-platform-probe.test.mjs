import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../apps/mind-diary-acceptance/worker.mjs";

const secret = "a".repeat(43);
const env = { MD_ACCEPTANCE_CONTROLLER_KEY: secret, DB: { prepare() { throw new Error("must not reach storage"); } } };
const request = (body, key = secret, origin) => new Request("https://acceptance.invalid/api/probe", {
  method: "POST", headers: { authorization: `Bearer ${key}`, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});

test("platform probe rejects missing/wrong controller authority before storage", async () => {
  for (const key of ["", "b".repeat(43)]) assert.equal((await worker.fetch(request({ phase: "reserve" }, key), env)).status, 401);
  assert.equal((await worker.fetch(request({ phase: "reserve" }), {})).status, 401);
});

test("platform probe rejects foreign Origin and caller-selected paths", async () => {
  assert.equal((await worker.fetch(request({ phase: "reserve" }, secret, "https://other.invalid"), env)).status, 403);
  for (const body of [{ phase: "reserve", id: "anything" }, { phase: "cleanup", id: "../../user" }, { phase: "setup", principal_id: "user" }]) {
    assert.equal((await worker.fetch(request(body), env)).status, 400);
  }
});

test("reserve returns independent recovery IDs without touching durable storage", async () => {
  const a = await (await worker.fetch(request({ phase: "reserve" }), env)).json();
  const b = await (await worker.fetch(request({ phase: "reserve" }), env)).json();
  assert.match(a.id, /^probe-[a-f0-9-]{36}$/);
  assert.notEqual(a.id, b.id);
  assert.equal(a.status, "reserved");
});
