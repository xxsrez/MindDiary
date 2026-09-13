// Bounded synthetic collaboration fixture, built exclusively by product APIs.
export async function createCollaborationFixture(client, { revisionsPerMind = 2 } = {}) {
  if (revisionsPerMind !== 1 && revisionsPerMind !== 2) throw new Error("invalid_fixture_revision_count");
  const run = client.state.run ?? await client.setup();
  const roles = ["owner", "editor", "reader", "outsider"];
  if (run.actors.length !== 4) throw new Error("fixture_requires_four_actors");
  const actors = Object.fromEntries(roles.map((role, index) => [role, run.actors[index]]));
  const read = async (actor, path) => {
    const response = await client.request(path, { headers: { cookie: client.state.actors[actor.actor_id].cookie } });
    if (!response.ok) throw new Error(`fixture_read_http_${response.status}`);
    return response.json();
  };
  const csrf = async (actor, path = "/settings/account") => {
    const response = await client.request(path, { headers: { cookie: client.state.actors[actor.actor_id].cookie } });
    if (!response.ok) throw new Error(`fixture_page_http_${response.status}`);
    const token = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await response.text())?.[1];
    if (!token) throw new Error("fixture_csrf_missing");
    return token;
  };
  const mutate = async (name, actor, request, page) => {
    if (client.state.operations[name]?.phase === "completed") return client.state.operations[name].result;
    const pending = client.state.operations[name]?.payload;
    if (pending) request = { path: pending.path, method: pending.method, body: pending.body };
    return client.mutation(name, actor.actor_id, { ...request, csrf: await csrf(actor, page) });
  };
  for (const [role, actor] of Object.entries(actors)) {
    await client.session(actor.actor_id);
    await client.reconcileBootstrap(`bootstrap:${role}`, actor.actor_id);
    await mutate(`bootstrap:${role}`, actor, { path: "/api/v1/account", body: { action: "create_isolated_account" } }, "/");
  }
  const handle = `uat-${run.run_id}`;
  await mutate("create:shared", actors.owner, { path: "/api/v1/minds", body: { name: "Synthetic collaboration", handle, description: "Synthetic acceptance fixtures and shared engineering decisions." } });
  for (const role of ["editor", "reader"]) {
    const actor = actors[role];
    if (client.state.operations[`accept:${role}`]?.phase === "completed") continue;
    const mind = await read(actors.owner, `/api/v1/minds/${handle}`);
    await mutate(`invite:${role}`, actors.owner, { path: `/api/v1/minds/${handle}/invitations`, body: { target_verified_email: actor.subject, role, expected_metadata_version: mind.data.metadata_version } });
    const incoming = await read(actor, "/api/v1/invitations");
    const invitation = incoming.data.invitations.find(item => item.direction === "incoming" && item.mind_name === "Synthetic collaboration");
    const saved = client.state.operations[`accept:${role}`]?.payload;
    if (!invitation && !saved) throw new Error("fixture_invitation_missing");
    await mutate(`accept:${role}`, actor, saved ?? { path: `/api/v1/invitations/${encodeURIComponent(invitation.invitation_id)}/accept`, body: { expected_invitation_version: invitation.invitation_version } }, "/invitations");
  }
  await mutate("usage:shared", actors.owner, { path: `/api/v1/minds/${handle}/usage`, method: "PUT", body: { usage_mode: "read_write", expected_usage_version: 0 } });
  await mutate("usage:personal", actors.owner, { path: "/api/v1/minds/me/usage", method: "PUT", body: { usage_mode: "read_write", expected_usage_version: 1 } });
  const issued = await mutate("token:owner", actors.owner, { path: "/api/v1/mcp-tokens", body: { name: "Synthetic acceptance", scopes: ["content:write", "personal:configure"] } });
  const token = issued.data.secret;
  const revisions = {};
  for (const mind of ["/me", `/${handle}`]) {
    const listed = await client.mcp(token, "list_minds");
    const selected = listed.minds.find(item => item.route === mind);
    if (!selected) throw new Error("fixture_mind_missing");
    const first = await client.commit(`create:${mind}`, token, { mind, expected_revision: selected.head.revision_id,
      summary: "Create synthetic acceptance fixture", operations: [{ type: "create_file", path: "concepts/acceptance.md", text: "---\ntype: Reference\n---\n\nSynthetic acceptance decision version one.\n" }] });
    revisions[mind] = [first.revision.revision_id];
    if (revisionsPerMind === 2) {
      const second = await client.commit(`replace:${mind}`, token, { mind, expected_revision: first.revision.revision_id,
        summary: "Revise synthetic acceptance fixture", operations: [{ type: "replace_file", path: "concepts/acceptance.md", text: "---\ntype: Reference\n---\n\nSynthetic acceptance decision version two.\n" }] });
      revisions[mind].push(second.revision.revision_id);
    }
  }
  const fixture = { schema: "mind-diary/acceptance-fixture/v1", run_id: run.run_id, handle, actors, revisions };
  client.state.fixture = fixture; await client.save();
  return fixture;
}
