import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createCollaborationFixture } from "../../scripts/lib/acceptance-fixture.mjs";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

for (const mode of ["normal", "interrupted", "legacy-orphan"]) test(`real OAuth deletion and recovery: ${mode}`, async t => {
  const runtime = await acceptanceRuntime(t);
  const client = await new AcceptanceClient({ directory: join(runtime.directory, "oauth"), controllerKey: runtime.controllerKey, platformToken: "synthetic", fetch: runtime.fetch }).open();
  const fixture = await createCollaborationFixture(client);
  const cookie = client.state.actors[fixture.actors.owner.actor_id].cookie;
  const redirect = "http://127.0.0.1:1455/auth/callback";
  const registered = await client.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: { client_name: "Synthetic OAuth", redirect_uris: [redirect], token_endpoint_auth_method: "none" } });
  assert.equal(registered.status, 201);
  const registration = await registered.json();
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirect, response_type: "code", scope: "content:read personal:configure", resource: ACCEPTANCE_ORIGIN + "/api/mcp", state: "synthetic-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const consent = await client.request("/oauth/authorize?" + authorize, { headers: { cookie } }); assert.equal(consent.status, 200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())[1];
  const form = async (path, fields, headers = {}) => runtime.fetch(ACCEPTANCE_ORIGIN + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const approved = await form("/oauth/authorize", { request_id: requestId, decision: "approve" }, { cookie }); assert.equal(approved.status, 303);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const exchanged = await form("/oauth/token", { grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: redirect, resource: ACCEPTANCE_ORIGIN + "/api/mcp", code, code_verifier: verifier });
  const tokens = await exchanged.json();
  assert.equal(exchanged.status, 200, typeof tokens.error === "string" ? tokens.error : "OAuth exchange failed");
  await client.mcp(tokens.access_token, "list_minds");
  const activeRecovery = await client.control("/_acceptance/recover", "POST", {});
  assert.equal(activeRecovery.oauth.purged, 0);
  await client.mcp(tokens.access_token, "list_minds");
  const prepare = runtime.db.prepare.bind(runtime.db);
  let failures = 2;
  if (mode !== "normal") runtime.db.prepare = sql => {
    const statement = prepare(sql), execute = statement.execute;
    if (/md-oauth-principal-[a-z]+-purge/.test(sql)) statement.execute = () => {
      if (mode === "legacy-orphan") return { success: true, results: [], meta: { changes: 0 } };
      if (failures-- > 0) throw new Error("injected_oauth_cleanup_unavailable");
      return execute();
    };
    return statement;
  };
  if (mode === "interrupted") await assert.rejects(client.cleanup({ retryTransient: false }), /acceptance_control_http_503/);
  assert.equal((await client.cleanup()).state, "cleaned");
  runtime.db.prepare = prepare;
  if (mode === "legacy-orphan") {
    assert.equal((await runtime.db.prepare("SELECT COUNT(*) AS count FROM md_oauth_grants").first()).count, 1);
    const recovered = await client.control("/_acceptance/recover", "POST", {});
    assert.equal(recovered.oauth.purged, 1);
    assert.equal((await client.control("/_acceptance/recover", "POST", {})).oauth.purged, 0);
  }
  await assert.rejects(client.mcp(tokens.access_token, "list_minds"), /mcp_http_401/);
  for (const table of ["md_oauth_grants", "md_oauth_authorization_requests", "md_oauth_authorization_codes", "md_oauth_access_tokens", "md_oauth_refresh_tokens"]) {
    assert.equal((await runtime.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0, table);
  }
});
