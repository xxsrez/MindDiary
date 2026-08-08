import test from "node:test";
import assert from "node:assert/strict";
import {
  createProductExportDownloadHttpHandler,
  createProductWebHttpHandler,
  resolveProductSitesIdentity,
} from "../../packages/adapter-web/dist/index.js";
import {
  MCP_TOOL_DEFINITIONS,
  ProductMcpContentApplication,
} from "../../packages/adapter-mcp/dist/index.js";

const origin = "https://mind-diary.example";
const registeredActor = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_one",
  authentication: Object.freeze({ kind: "sites_identity", verifiedByPlatform: true }),
  requestId: "request_one",
  occurredAtUtc: "2026-08-08T00:00:00.000Z",
  deploymentCapabilities: Object.freeze([]),
});

test("product web authenticates UI and fail-closes browser mutations", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: async () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ok", verify: (_actor, token) => token === "csrf-ok" },
    control: { async execute(request) { calls.push(request); return { accepted: true }; } },
  });

  const page = await handler(new Request(`${origin}/me`, {
    headers: { authorization: "Bearer must-not-be-used-by-web" },
  }));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /My Mind/);
  assert.equal(page.headers.get("cache-control"), "no-store");

  const denied = await handler(new Request(`${origin}/api/v1/minds`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "x-csrf-token": "csrf-ok", "content-type": "application/json" },
    body: JSON.stringify({ name: "Friends", handle: "friends" }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);

  const accepted = await handler(new Request(`${origin}/api/v1/minds`, {
    method: "POST",
    headers: { origin, "x-csrf-token": "csrf-ok", "content-type": "application/json" },
    body: JSON.stringify({ name: "Friends", handle: "friends" }),
  }));
  assert.equal(accepted.status, 200);
  assert.equal(calls[0].operation, "create_space_with_owner");
  assert.equal(calls[0].actor, registeredActor);
});

test("unbound verified Sites identity is bootstrap-only and remains server-owned", async () => {
  const resolution = await resolveProductSitesIdentity({
    snapshot: { kind: "authenticated", verifiedEmail: " Person@Example.COM " },
    bindings: { async readActiveBinding(lookup) {
      assert.equal(lookup.normalizedBinding, "person@example.com");
      return { kind: "unbound" };
    } },
    context: {
      requestId: "request_bootstrap",
      occurredAtUtc: "2026-08-08T00:00:00.000Z",
      deploymentCapabilities: [],
    },
  });
  assert.equal(resolution.kind, "registration_required");
  assert.equal(resolution.actor.normalizedBinding, "person@example.com");

  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => resolution,
    csrf: { issue: () => "bootstrap-csrf", verify: () => true },
    control: { execute(request) { calls.push(request.operation); return { created: true }; } },
  });
  const blocked = await handler(new Request(`${origin}/api/v1/minds`));
  assert.equal(blocked.status, 409);
  const bootstrapped = await handler(new Request(`${origin}/api/v1/account`, {
    method: "POST",
    headers: { origin, "x-csrf-token": "bootstrap-csrf", "content-type": "application/json" },
    body: JSON.stringify({ action: "create_isolated_account", display_name: "Person" }),
  }));
  assert.equal(bootstrapped.status, 200);
  assert.deepEqual(calls, ["bootstrap_account"]);
});

test("opaque export download route returns exact authorized bytes and generic misses", async () => {
  const seen = [];
  const handler = createProductExportDownloadHttpHandler({
    async download(secret) {
      seen.push(secret);
      return secret === "mdg_v1_valid"
        ? {
            kind: "download",
            response: {
              headers: {
                "content-type": "application/zip",
                "content-length": "3",
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
              },
              bytes: Uint8Array.from([1, 2, 3]),
            },
          }
        : { kind: "not_found" };
    },
  });
  assert.equal(await handler(new Request(`${origin}/api/v1/other`)), null);
  const found = await handler(new Request(`${origin}/api/v1/exports/mdg_v1_valid`));
  assert.equal(found.status, 200);
  assert.deepEqual(new Uint8Array(await found.arrayBuffer()), Uint8Array.from([1, 2, 3]));
  const missing = await handler(new Request(`${origin}/api/v1/exports/mdg_v1_missing`));
  assert.equal(missing.status, 404);
  const wrongMethod = await handler(new Request(`${origin}/api/v1/exports/mdg_v1_valid`, { method: "POST" }));
  assert.equal(wrongMethod.status, 404);
  assert.deepEqual(seen, ["mdg_v1_valid", "mdg_v1_missing"]);
});

test("product MCP facade advertises only canonical content tools and membership roots", async () => {
  const application = new ProductMcpContentApplication({
    discovery: {
      async listMinds() {
        const head = { revisionId: "revision_one" };
        const common = { mindId: "space_one", name: "Mine", head };
        return {
          minds: [
            { ...common, discovery: "personal" },
            { ...common, mindId: "space_public", name: "Public", discovery: "public_catalog" },
          ],
          nextCursor: null,
        };
      },
      async resolveMind() { return {}; },
      async getMindInfo() { return { mind: { mindId: "space_one" }, contentCapabilities: ["browse", "commit", "export"] }; },
    },
    browse: {
      async browseEntries() { return {}; },
      async fetch() { return {}; },
      async readResource(_actor, uri) { return { uri, mimeType: "text/markdown; charset=utf-8", text: "# Index", entry: {} }; },
    },
    search: { async searchEntries() { return {}; } },
    history: { async listRevisions() { return {}; }, async getRevision() { return {}; } },
    validation: { async validateMind() { return {}; } },
    commits: { async commit() { return { kind: "invalid" }; } },
    exports: { async start() { return { kind: "denied" }; }, async getStatus() { return { kind: "not_found" }; } },
  });
  const actor = { ...registeredActor, authentication: { kind: "mcp_token", tokenId: "token_one", scopes: ["content:read"] } };
  const tools = await application.listTools({ actor });
  assert.deepEqual(tools.map(({ name }) => name), MCP_TOOL_DEFINITIONS.map(({ name }) => name));
  assert.equal(tools.some(({ name }) => String(name).includes("member") || String(name).includes("token")), false);
  const roots = await application.listRootResources({ actor });
  assert.equal(roots.resources.length, 1);
  assert.equal(roots.resources[0].uri, "okf://spaces/space_one/revisions/revision_one/index");
});
