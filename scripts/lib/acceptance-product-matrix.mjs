import assert from "node:assert/strict";

// Same assertions run against the real local composition and the hosted test Worker.
export async function verifyProductMatrix(client, fixture) {
  const owner = fixture.actors.owner.actor_id;
  const token = client.state.operations["token:owner"].result.data.secret;
  const read = async path => {
    const response = await client.request(path, { headers: { cookie: client.state.actors[owner].cookie } });
    assert.equal(response.status, 200); return (await response.json()).data;
  };
  const setMode = async mode => {
    const projection = await read("/api/v1/mind-usage");
    const page = await client.request("/settings/account", { headers: { cookie: client.state.actors[owner].cookie } });
    const csrf = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await page.text())?.[1]; assert.ok(csrf);
    const response = await client.mutation(`matrix:mode:${crypto.randomUUID()}`, owner, { path: "/api/v1/minds/me/usage", method: "PUT", csrf,
      body: { usage_mode: mode, expected_usage_version: projection.usage_version } });
    assert.equal(response.ok, true);
  };
  const checked = [];
  for (const [kind, description] of [["null", null], ["empty", "   "], ["described", "Synthetic acceptance engineering decisions; exclude daily activity logs."]]) {
    for (const mode of ["disabled", "read", "read_write"]) {
      const before = await client.mcp(token, "get_personal_mind_configuration");
      const configuration = { description, expected_metadata_version: before.metadata_version, idempotency_key: `matrix:configuration:${crypto.randomUUID()}` };
      const configured = await client.mcp(token, "set_personal_mind_description", configuration);
      assert.equal(configured.description, kind === "described" ? description : null);
      const replayedConfiguration = await client.mcp(token, "set_personal_mind_description", configuration);
      assert.equal(replayedConfiguration.metadata_version, configured.metadata_version);
      assert.equal((await client.mcp(token, "get_personal_mind_configuration")).description, configured.description);
      await setMode(mode);
      const projection = await client.mcp(token, "list_minds");
      const personal = projection.minds.find(mind => mind.route === "/me");
      assert.equal(Boolean(personal), mode !== "disabled");
      if (personal) assert.equal(personal.description, configured.description);
      const info = await client.mcpEnvelope(token, "tools/call", { name: "get_mind_info", arguments: { mind: "/me" } });
      assert.equal(info.result.isError, mode === "disabled");
      if (mode !== "disabled") {
        const head = personal.head.revision_id;
        const request = { mind: "/me", expected_revision: head, idempotency_key: `matrix:commit:${crypto.randomUUID()}`, summary: "Synthetic mode matrix",
          operations: [{ type: "create_file", path: `concepts/matrix-${kind}.md`, text: `---\ntype: Reference\n---\n\nSynthetic ${kind} mode decision.\n` }] };
        const committed = await client.mcpEnvelope(token, "tools/call", { name: "commit_changeset", arguments: request });
        assert.equal(committed.result.isError, mode !== "read_write");
        if (mode === "read_write") {
          const replay = await client.mcp(token, "reconcile_changeset", request); assert.equal(replay.status, "committed");
          const conflict = await client.mcpEnvelope(token, "tools/call", { name: "commit_changeset", arguments: { ...request, idempotency_key: request.idempotency_key + "-stale" } });
          assert.equal(conflict.result.isError, true);
          const historical = await client.mcp(token, "get_revision", { mind: "/me", revision_id: head }); assert.ok(historical);
          const validation = await client.mcp(token, "validate_mind", { mind: "/me" }); assert.equal(validation.valid, true);
        }
      }
      checked.push(`${kind}:${mode}`);
    }
  }
  // Separate credential scope still narrows a writable principal-owned lane.
  const page = await client.request("/settings/account", { headers: { cookie: client.state.actors[owner].cookie } });
  const csrf = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await page.text())[1];
  const issued = await client.mutation("matrix:read-token", owner, { path: "/api/v1/mcp-tokens", csrf, body: { name: "Synthetic scope matrix", scopes: ["content:read"] } });
  const readToken = issued.data.secret;
  const denied = await client.mcpEnvelope(readToken, "tools/call", { name: "get_personal_mind_configuration", arguments: {} });
  assert.equal(denied.result.isError, true);
  const personal = (await client.mcp(readToken, "list_minds")).minds.find(mind => mind.route === "/me");
  const deniedWrite = await client.mcpEnvelope(readToken, "tools/call", { name: "commit_changeset", arguments: { mind: "/me", expected_revision: personal.head.revision_id,
    idempotency_key: `matrix:read-denied:${crypto.randomUUID()}`, summary: "Must remain forbidden", operations: [{ type: "create_file", path: "concepts/forbidden.md", text: "---\ntype: Reference\n---\n\nMust not be committed.\n" }] } });
  assert.equal(deniedWrite.result.isError, true);
  const oldConfig = await client.mcp(token, "get_personal_mind_configuration");
  await client.mcp(token, "set_personal_mind_description", { description: null, expected_metadata_version: oldConfig.metadata_version, idempotency_key: `matrix:reset:${crypto.randomUUID()}` });
  const stale = await client.mcpEnvelope(token, "tools/call", { name: "set_personal_mind_description", arguments: { description: "Stale configuration", expected_metadata_version: oldConfig.metadata_version, idempotency_key: `matrix:stale:${crypto.randomUUID()}` } });
  assert.equal(stale.result.structuredContent.error.code, "metadata_conflict");
  return { schema: "mind-diary/acceptance-product-matrix/v1", status: "passed", personal_mode_description_cells: checked, scope_narrowing: true, committed_reconciliation: true, stale_revision_denied: true };
}
