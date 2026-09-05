import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { AcceptanceSessionStore, SESSION_COOKIE } from "../../apps/mind-diary-acceptance/session-store.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

const request = (token, run) => new Request(ACCEPTANCE_ORIGIN + "/api/v1/session", { headers: {
  cookie: `${SESSION_COOKIE}=${token}`, ...(run ? { "x-md-acceptance-run": run } : {}),
} });
async function fixture(t) {
  const database = new SqliteD1(); t.after(() => database.close());
  let time = 1788642000000;
  const store = new AcceptanceSessionStore(database, () => time);
  return { store, database, advance: (milliseconds) => { time += milliseconds; } };
}
const create = (store, key = "test-run-idempotency-0001", input = {}) => store.create(input, key);
const session = async (store, run, actor = run.actors[0]) => store.exchange((await store.mintExchange(run.id, actor.id)).code, ACCEPTANCE_ORIGIN);

test("run creation is atomic, idempotent, bounded and never accepts caller identity", async (t) => {
  const { store } = await fixture(t);
  const [a, b] = await Promise.all([create(store), create(store)]);
  assert.equal(a.id, b.id); assert.equal(a.actors.length, 4);
  assert.equal(new Set(a.actors.map((v) => v.subject)).size, 4);
  assert.ok(a.actors.every((v) => v.principal_id === null));
  await assert.rejects(create(store, "test-run-idempotency-0001", { actor_count: 5 }), /idempotency_conflict/);
  await assert.rejects(create(store, "test-run-idempotency-0002", { email: "user@example.com" }), /invalid_run_request/);
  const attempts = await Promise.allSettled([create(store, "test-run-idempotency-0002"), create(store, "test-run-idempotency-0003")]);
  assert.equal(attempts.filter((v) => v.status === "fulfilled").length, 1);
});

test("one-time exchange permits one winner, rotation invalidates the old session", async (t) => {
  const { store } = await fixture(t); const run = await create(store);
  const { code } = await store.mintExchange(run.id, run.actors[0].id);
  const results = await Promise.allSettled([store.exchange(code, ACCEPTANCE_ORIGIN), store.exchange(code, ACCEPTANCE_ORIGIN)]);
  assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
  const old = results.find((v) => v.status === "fulfilled").value;
  assert.match(old.cookie, /Path=\/; Secure; HttpOnly; SameSite=Lax/);
  assert.equal((await store.actorForRequest(request(old.token))).id, run.actors[0].id);
  const next = await session(store, run);
  assert.equal(await store.actorForRequest(request(old.token)), null);
  assert.equal((await store.actorForRequest(request(next.token))).id, run.actors[0].id);
});

test("wrong audience and wrong run are denied without consuming a valid exchange", async (t) => {
  const { store } = await fixture(t); const a = await create(store), b = await create(store, "test-run-idempotency-0002");
  await assert.rejects(store.mintExchange(a.id, b.actors[0].id), /exchange_denied/);
  const { code } = await store.mintExchange(a.id, a.actors[0].id);
  await assert.rejects(store.exchange(code, "https://other.invalid"), /exchange_denied/);
  const current = await store.exchange(code, ACCEPTANCE_ORIGIN);
  assert.equal(await store.actorForRequest(request(current.token, b.id)), null);
  assert.ok(await store.actorForRequest(request(current.token, a.id)));
});

test("exchange expiry, session expiry and run revocation survive reconstruction", async (t) => {
  const { store, database, advance } = await fixture(t); const run = await create(store);
  const { code } = await store.mintExchange(run.id, run.actors[0].id);
  advance(60001); await assert.rejects(store.exchange(code, ACCEPTANCE_ORIGIN), /exchange_denied/);
  const current = await session(store, run); advance(900001);
  assert.equal(await store.actorForRequest(request(current.token)), null);
  const fresh = await session(store, run); await store.revoke(run.id);
  const restored = new AcceptanceSessionStore(database, store.now);
  assert.equal(await restored.actorForRequest(request(fresh.token)), null);
  await assert.rejects(restored.mintExchange(run.id, run.actors[0].id), /exchange_denied/);
});

test("principal admission only narrows real bearer auth to the active bound run", async (t) => {
  const { store, advance } = await fixture(t); const run = await create(store, undefined, { ttl_seconds: 60 });
  await store.bindPrincipal(run.actors[0], "principal_test");
  const current = await session(store, run);
  assert.equal(await store.admitPrincipal("principal_test", request(current.token, run.id)), true);
  assert.equal(await store.admitPrincipal("principal_other", request(current.token, run.id)), false);
  assert.equal(await store.admitPrincipal("principal_test", request(current.token)), false);
  await assert.rejects(store.bindPrincipal(run.actors[0], "principal_other"), /actor_binding_conflict/);
  advance(60001);
  assert.equal(await store.admitPrincipal("principal_test", request(current.token, run.id)), false);
  assert.equal(await store.actorForRequest(request(current.token)), null);
});

test("operator profile is exclusive and exposes only its server-selected first actor", async (t) => {
  const { store } = await fixture(t); const run = await create(store, undefined, { profile: "operator" });
  await assert.rejects(create(store, "test-run-idempotency-0002"), /run_capacity_reached/);
  await store.bindPrincipal(run.actors[1], "principal_second");
  assert.deepEqual(await store.operatorPrincipalIds(), []);
  await store.bindPrincipal(run.actors[0], "principal_first");
  assert.deepEqual(await store.operatorPrincipalIds(), ["principal_first"]);
  await store.revoke(run.id);
  assert.deepEqual(await store.operatorPrincipalIds(), []);
});
