import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { AcceptanceSessionStore } from "../../apps/mind-diary-acceptance/session-store.mjs";
import { cleanupRun } from "../../apps/mind-diary-acceptance/cleanup.mjs";
import { handleAcceptanceSession } from "../../apps/mind-diary-acceptance/session-http.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

for (const point of ["after_revoke", "before_delete", "after_delete", "after_actor"]) {
  test(`cleanup journal resumes ${point} without repeating a committed deletion`, async (t) => {
    const db = new SqliteD1(); t.after(() => db.close());
    const store = new AcceptanceSessionStore(db);
    const run = await store.create({}, "journal-first-run-0001");
    const other = await store.create({}, "journal-other-run-0001");
    const active = new Set(run.actors.map(a => a.id)); let deletes = 0;
    const product = async (actor, request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/session") return active.has(actor.id)
        ? Response.json({ data: { principal: { principal_id: `principal_${actor.id}` } } })
        : Response.json({ error: { code: "registration_required" } }, { status: 409 });
      if (path === "/api/v1/account/deletion-impact") return Response.json({ data: { impact_id: `impact_${actor.id}`, confirmation: "delete-account" } });
      if (path === "/settings/account") return new Response('<meta name="mind-diary-csrf-token" content="test-csrf">');
      assert.equal(request.method, "DELETE");
      assert.ok(active.delete(actor.id)); deletes++;
      return Response.json({ data: { spaces_deleted: 1 } });
    };
    let injected = false;
    await assert.rejects(cleanupRun(store, run.id, product, async () => ({ pending: false }), async stage => {
      if (!injected && stage === point) { injected = true; throw new Error("interruption"); }
    }, 4), /interruption/);
    const restored = new AcceptanceSessionStore(db);
    const receipt = await cleanupRun(restored, run.id, product, async () => ({ pending: false }), undefined, 4);
    assert.equal(receipt.state, "cleaned"); assert.equal(deletes, 4); assert.equal(active.size, 0);
    assert.deepEqual(await cleanupRun(restored, run.id, product, async () => {}), receipt);
    assert.equal((await restored.run(other.id)).state, "active");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM md_acceptance_cleanup_journal").first()).count, 0);
  });
}

test("reaper skips active runs and selects only expired or revoked runs", async (t) => {
  const db = new SqliteD1(); t.after(() => db.close()); let now = 100000;
  const store = new AcceptanceSessionStore(db, () => now);
  const active = await store.create({}, "reaper-active-run-0001");
  const expired = await store.create({ ttl_seconds: 60 }, "reaper-expired-run-0001"); now += 60001;
  const visited = [];
  const response = await handleAcceptanceSession(new Request(ACCEPTANCE_ORIGIN + "/_acceptance/recover", {
    method: "POST", headers: { "x-md-acceptance-controller": "a".repeat(43) }, body: "{}",
  }), store, "a".repeat(43), async id => { visited.push(id); return { state: "cleaned" }; });
  assert.equal(response.status, 200); assert.deepEqual(visited, [expired.id]);
  assert.equal((await store.run(active.id)).state, "active");
});
