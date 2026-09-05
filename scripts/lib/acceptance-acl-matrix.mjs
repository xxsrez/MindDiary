import assert from "node:assert/strict";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

export async function verifyAclMatrix(client, fixture) {
  const route = `/${fixture.handle}`;
  const checked = [];
  for (const role of ["editor", "reader", "outsider"]) {
    const actorId = fixture.actors[role].actor_id;
    const cookie = await client.session(actorId);
    const page = await client.request("/settings/account", { headers: { cookie } });
    const csrf = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await page.text())[1];
    const issued = await client.mutation(`acl:token:${role}`, actorId, { path: "/api/v1/mcp-tokens", csrf, body: { name: `Synthetic ${role} permission check`, scopes: ["content:write"] } });
    const token = issued.data.secret;
    const setUsage = async mode => client.request(`/api/v1/minds/${fixture.handle}/usage`, { method: "PUT", headers: { cookie, origin: ACCEPTANCE_ORIGIN,
      "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `acl-mode:${crypto.randomUUID()}` }, body: { usage_mode: mode, expected_usage_version: 0 } });
    if (role === "reader" || role === "outsider") {
      const denied = await setUsage("read_write"); assert.equal(denied.ok, false);
      assert.equal((await denied.json()).error.code, role === "reader" ? "usage_not_allowed" : "mind_not_found");
    }
    if (role !== "outsider") {
      const enabled = await setUsage(role === "editor" ? "read_write" : "read"); assert.equal(enabled.status, 200);
    }
    const projection = await client.mcp(token, "list_minds");
    const shared = projection.minds.find(m => m.route === route);
    assert.equal(Boolean(shared), role !== "outsider");
    if (role === "outsider") {
      const denied = await client.mcpEnvelope(token, "tools/call", { name: "get_mind_info", arguments: { mind: route } });
      assert.equal(denied.result.isError, true);
    } else {
      const requested = { mind: route, expected_revision: shared.head.revision_id, idempotency_key: `acl-commit:${crypto.randomUUID()}`, summary: "Synthetic role verification",
        operations: [{ type: "create_file", path: `concepts/acl-${role}.md`, text: "---\ntype: Reference\n---\n\nSynthetic role verification entry.\n" }] };
      const result = await client.mcpEnvelope(token, "tools/call", { name: "commit_changeset", arguments: requested });
      assert.equal(result.result.isError, role === "reader");
      if (role === "editor") assert.equal((await client.mcp(token, "validate_mind", { mind: route })).valid, true);
    }
    checked.push(role);
  }
  return { schema: "mind-diary/acceptance-acl-matrix/v1", status: "passed", roles: checked, outsider_private_mind_denied: true, reader_write_denied: true, editor_commit_validated: true };
}
