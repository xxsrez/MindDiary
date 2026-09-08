import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPerformanceCredentialBinding, createPerformanceProfileReadbackReceipt, performanceRequestArgumentsDigest } from "./performance-profile-readback.mjs";
import { validatePerformanceScenario } from "./performance-gate.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

export async function createAcceptancePerformanceFixture(client, identity, bindingKey) {
  const startedAt = new Date().toISOString(), run = client.state.run ?? await client.setup();
  const savedTransport = client.transport;
  let requestId;
  client.transport = async (...args) => { const response = await savedTransport(...args); requestId = response.headers.get("x-mind-diary-request-id"); return response; };
  const profiles = [], credentials = {};
  try {
    for (const [index, scale] of [1, 10].entries()) {
      const actor = run.actors[index], prefix = `performance:${scale}`, handle = `perf-${scale}-${run.run_id}`;
      await client.session(actor.actor_id);
      const csrf = async () => {
        const response = await client.request("/", { headers: { cookie: client.state.actors[actor.actor_id].cookie } });
        const value = /name="mind-diary-csrf-token" content="([^\"]+)"/.exec(await response.text())?.[1];
        assert.ok(value); return value;
      };
      const mutate = async (name, path, body, method = "POST") => client.mutation(`${prefix}:${name}`, actor.actor_id, { path, body, method, csrf: await csrf() });
      await client.reconcileBootstrap(`${prefix}:bootstrap`, actor.actor_id);
      await mutate("bootstrap", "/api/v1/account", { action: "create_isolated_account" });
      await mutate("mind", "/api/v1/minds", { name: "Synthetic performance", handle, description: "Synthetic performance fixtures only." });
      const provisioningId = client.state.operations[`${prefix}:mind`].key;
      await mutate("ordinary-mode", `/api/v1/minds/${handle}/usage`, { usage_mode: "read_write", expected_usage_version: 0 }, "PUT");
      await mutate("personal-mode", "/api/v1/minds/me/usage", { usage_mode: "read_write", expected_usage_version: 1 }, "PUT");
      const issued = await mutate("token", "/api/v1/mcp-tokens", { name: "Synthetic performance", scopes: ["content:write"] });
      const token = issued.data.secret;
      for (const mind of ["/me", `/${handle}`]) {
        let head = (await client.mcp(token, "get_mind_info", { mind })).resolved_revision?.revision_id;
        if (!head) head = (await client.mcp(token, "list_minds")).minds.find(m => m.route === mind).head.revision_id;
        for (let revision = 2; revision <= scale; revision++) {
          const result = await client.commit(`${prefix}:${mind}:${revision}`, token, { mind, expected_revision: head, summary: "Advance synthetic performance history",
            operations: [{ type: revision === 2 ? "create_file" : "replace_file", path: "concepts/performance.md", text: `---\ntype: Reference\n---\n\nSynthetic performance history ${revision}.\n` }] });
          head = result.revision.revision_id;
        }
      }
      const minds = (await client.mcp(token, "list_minds")).minds;
      assert.equal(minds.length, 2);
      let files = 0, bytes = 0;
      for (const mind of minds) {
        const history = await client.mcp(token, "list_revisions", { mind: mind.route });
        assert.equal(history.revisions.length, scale);
        const head = await client.mcp(token, "get_revision", { mind: mind.route, revision_id: mind.head.revision_id });
        files += head.manifest_summary.file_count; bytes += head.manifest_summary.total_bytes;
      }
      const readbackId = requestId;
      assert.ok(provisioningId && readbackId && provisioningId !== readbackId);
      const browse = await client.mcp(token, "browse_entries", { mind: "/me" });
      assert.ok(browse.entries.length > 0);
      const args = { list_minds: {}, browse_entries: { mind: "/me" },
        list_files: { mind: "/me", revision_selector: { kind: "head" }, limit: 16 },
        grep_files: { mind: "/me", revision_selector: { kind: "head" }, patterns: ["Mind"], output: "count" },
        read_files: { mind: "/me", revision_selector: { kind: "head" }, requests: [{ path: "index.md", mode: "head", count: 8 }] },
        search: { mind: "/me", query: "Mind" }, fetch: { id: browse.entries[0].entry_id },
        get_revision: { mind: "/me", revision_id: minds.find(m => m.route === "/me").head.revision_id } };
      await client.mcp(token, "fetch", args.fetch);
      const fingerprint = "sha256:" + createHash("sha256").update(JSON.stringify(minds.map(m => ({ id: m.mind_id, head: m.head.revision_id })).sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
      for (const id of scale === 1 ? ["starter", "history1"] : ["history10"]) {
        const operations = id === "starter"
          ? ["list_minds", "browse_entries", "list_files", "grep_files", "read_files", "search", "fetch"]
          : ["get_revision"];
        const observed = { minds: 2, revisions: scale, files, bytes };
        // Each profile has a distinct real read request even when it shares the starter fixture.
        await client.mcp(token, "get_revision", args.get_revision);
        profiles.push({ id, kind: id === "starter" ? "starter_small" : "small_history", fixture_fingerprint: fingerprint,
          credential_binding: { scheme: "hmac-sha256-v1", digest: createPerformanceCredentialBinding({ key: bindingKey, profileId: id, credential: token }) },
          request_bindings: operations.map(operation => ({ operation, arguments_sha256: performanceRequestArgumentsDigest(args[operation]) })),
          provisioning_request_id: id === "history1" ? client.state.operations[`${prefix}:token`].key : provisioningId, readback_request_id: requestId, expected: observed, observed });
        credentials[id] = { token, args, cookie: client.state.actors[actor.actor_id].cookie };
      }
    }
    const deployment = { site_project_id: identity.project_id, site_version_id: identity.site_version_id, deployment_id: identity.deployment_id, archive_sha256: "sha256:" + identity.archive_sha256 };
    const profileReadback = createPerformanceProfileReadbackReceipt({ status: "passed", candidate_sha: identity.candidate_sha, environment: "uat", target_url: ACCEPTANCE_ORIGIN,
      deployment, started_at: startedAt, completed_at: new Date().toISOString(), generator: "mind-diary/uat-profile-provision-readback/v2", profiles });
    const requests = [{ id: "web.home", profile: "web", fixture_profile_id: null, operation: "home", method: "GET", path: "/", expected_status: 200,
      sites_authorization_env: "MD_PERF_PLATFORM", cookie_env: "MD_PERF_COOKIE" }];
    for (const profile of ["mcp_modern", "mcp_compatibility"]) for (const fixture of profiles) {
      for (const { operation } of fixture.request_bindings) {
        const id = `${profile}.${fixture.id}.${operation}`, modern = profile === "mcp_modern";
        requests.push({ id, profile, fixture_profile_id: fixture.id, operation, method: "POST", path: modern ? "/api/mcp" : "/api/mcp/2025-11-25", expected_status: 200,
          headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": modern ? "2026-07-28" : "2025-11-25", "x-md-acceptance-run": run.run_id,
            ...(modern ? { "mcp-method": "tools/call", "mcp-name": operation } : {}) }, bearer_token_env: `MD_PERF_${fixture.id.toUpperCase()}`, sites_authorization_env: "MD_PERF_PLATFORM",
          body: { jsonrpc: "2.0", id, method: "tools/call", params: { name: operation, arguments: credentials[fixture.id].args[operation], ...(modern ? { _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "acceptance-performance", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } },
          ...(fixture.kind === "small_history" ? { history_comparison: { group: profile, scale: fixture.observed.revisions } } : {}) });
      }
    }
    const scenario = validatePerformanceScenario({ schema: "mind-diary/performance-scenario/v3", target_url: ACCEPTANCE_ORIGIN, environment: "uat", candidate_sha: identity.candidate_sha,
      deployment_id: identity.deployment_id, warm_samples: 20, telemetry_wait_seconds: 0, credential_binding_key_env: "MD_PERF_BINDING_KEY", performance_correlation_key_env: "MD_PERF_CORRELATION_KEY", requests }, profileReadback);
    return { profileReadback, scenario, credentials };
  } finally { client.transport = savedTransport; }
}
