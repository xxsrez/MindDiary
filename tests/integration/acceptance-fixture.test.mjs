import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createCollaborationFixture } from "../../scripts/lib/acceptance-fixture.mjs";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";

test("SDK fixture creates real memberships, resumes without duplicate Minds and cleans both overlapping runs", async t => {
  const runtime = await acceptanceRuntime(t);
  const clients = [];
  for (const name of ["first", "second"]) {
    const config = { directory: join(runtime.directory, name), platformToken: "test-platform", controllerKey: runtime.controllerKey, fetch: runtime.fetch };
    let client = await new AcceptanceClient(config).open();
    if (name === "first") {
      const baseline = await client.control("/_acceptance/inventory");
      assert.equal(baseline.complete, true); assert.equal(baseline.principals, 0); assert.equal(baseline.object_count, 0);
    }
    for (const failurePoint of name === "first" ? ["bootstrap", "commit"] : []) {
      let lost = false;
      client.transport = async (url, options) => {
        const response = await runtime.fetch(url, options);
        const body = options.body ? JSON.parse(options.body) : null;
        const matches = failurePoint === "bootstrap" ? body?.action === "create_isolated_account" : body?.params?.name === "commit_changeset";
        if (!lost && matches) {
          assert.equal(response.status, 200);
          if (failurePoint === "commit") assert.equal((await response.clone().json()).result.isError, false);
          lost = true; throw new Error("lost_" + failurePoint + "_response");
        }
        return response;
      };
      await assert.rejects(createCollaborationFixture(client), new RegExp("lost_" + failurePoint + "_response"));
      client = await new AcceptanceClient(config).open();
    }
    clients.push(client);
    const fixture = await createCollaborationFixture(client);
    for (const [role, actor] of Object.entries(fixture.actors)) {
      const response = await client.request(`/api/v1/minds/${fixture.handle}`, { headers: { cookie: client.state.actors[actor.actor_id].cookie } });
      assert.equal(response.status, role === "outsider" ? 404 : 200);
      if (role !== "outsider") assert.equal((await response.json()).data.access.role, role);
    }
    const repeated = await createCollaborationFixture(client);
    assert.equal(repeated.handle, fixture.handle);
    const token = client.state.operations["token:owner"].result.data.secret;
    for (const mind of ["/me", `/${fixture.handle}`]) {
      const history = await client.mcp(token, "list_revisions", { mind });
      assert.equal(history.revisions.length, 3);
    }
  }
  await runtime.drain();
  const populated = await clients[0].control("/_acceptance/inventory");
  assert.equal(populated.complete, true); assert.equal(populated.principals, 8); assert.ok(populated.object_count > 0);
  const first = await clients[0].cleanup(); assert.equal(first.state, "cleaned");
  const active = clients[1].state.fixture;
  const intact = await clients[1].request(`/api/v1/minds/${active.handle}`, { headers: { cookie: clients[1].state.actors[active.actors.owner.actor_id].cookie } });
  assert.equal(intact.status, 200);
  const second = await clients[1].cleanup(); assert.equal(second.state, "cleaned");
  await runtime.drain(); assert.equal(runtime.bucket.records.size, 0);
  const final = await clients[1].control("/_acceptance/inventory");
  assert.equal(final.complete, true); assert.equal(final.principals, 0); assert.equal(final.owned_minds, 0); assert.equal(final.object_count, 0);
  assert.ok(Object.values(final.rows).every(count => count === 0));
});
