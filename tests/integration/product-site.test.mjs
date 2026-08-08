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

const sessionProjection = Object.freeze({
  principal: Object.freeze({
    principalId: "principal_one",
    displayName: "Product Owner",
    profileVersion: 3,
  }),
  personalMind: Object.freeze({
    mindId: "space_personal",
    route: "/me",
    name: "Product Owner",
    visibility: "private",
    metadataVersion: 2,
    headRevisionId: "revision_personal",
  }),
});

const personalRoute = Object.freeze({
  mindId: "space_personal",
  route: "/me",
  name: "Product Owner",
  isPersonal: true,
  visibility: "private",
  discovery: "personal",
  access: Object.freeze({ kind: "membership", role: "owner", capabilities: ["content:read"] }),
  metadataVersion: 2,
  headRevisionId: "revision_personal",
});

const ordinaryOwnerRoute = Object.freeze({
  mindId: "space_research",
  route: "/research-notes",
  handle: "research-notes",
  name: "Research Notes",
  isPersonal: false,
  visibility: "private",
  discovery: "membership",
  access: Object.freeze({ kind: "membership", role: "owner", capabilities: ["content:read", "content:write"] }),
  metadataVersion: 7,
  headRevisionId: "revision_research",
});

test("product web authenticates UI and fail-closes browser mutations", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: async () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ok", verify: (_actor, token) => token === "csrf-ok" },
    control: { async execute(request) {
      calls.push(request);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_minds") return [personalRoute];
      return { accepted: true };
    } },
  });

  const page = await handler(new Request(`${origin}/me`, {
    headers: { authorization: "Bearer must-not-be-used-by-web" },
  }));
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /data-authenticated-onboarding/);
  assert.match(pageHtml, /data-profile-form/);
  assert.match(pageHtml, /mind-diary-onboarding-client\.js/);
  assert.match(pageHtml, /mind-diary-csrf-token/);
  assert.doesNotMatch(pageHtml, /principal_one|revision_personal|Bearer must-not-be-used-by-web/);
  assert.equal(page.headers.get("cache-control"), "no-store");

  const denied = await handler(new Request(`${origin}/api/v1/minds`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "x-csrf-token": "csrf-ok", "content-type": "application/json" },
    body: JSON.stringify({ name: "Friends", handle: "friends" }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 1);

  const accepted = await handler(new Request(`${origin}/api/v1/minds`, {
    method: "POST",
    headers: { origin, "x-csrf-token": "csrf-ok", "content-type": "application/json" },
    body: JSON.stringify({ name: "Friends", handle: "friends" }),
  }));
  assert.equal(accepted.status, 200);
  assert.equal(calls.at(-1).operation, "create_space_with_owner");
  assert.equal(calls.at(-1).actor, registeredActor);
});

test("product root and MCP setup render live control projections and fixed same-origin assets", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ui", verify: () => true },
    control: { async execute(request) {
      calls.push(request.operation);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_minds") return [personalRoute];
      if (request.operation === "list_mcp_tokens") return [{
        tokenId: "tok_safe",
        name: "Codex on Mac",
        displayPrefix: "mdp_v1_Abc123…",
        scopes: ["content:read", "content:write"],
        state: "active",
        version: 1,
        createdAt: "2026-08-08T00:00:00.000Z",
        expiresAt: "2026-11-06T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      }];
      throw Object.assign(new Error("unexpected operation"), { code: "not_found" });
    } },
  });

  const root = await handler(new Request(`${origin}/`));
  assert.equal(root.status, 200);
  const rootHtml = await root.text();
  assert.match(rootHtml, /data-mind-diary-shell/);
  assert.match(rootHtml, /Product Owner/);
  assert.match(rootHtml, /href="\/settings\/mcp"/);
  assert.doesNotMatch(rootHtml, /principal_one|revision_personal/);

  const tokens = await handler(new Request(`${origin}/settings/mcp`));
  assert.equal(tokens.status, 200);
  const tokenHtml = await tokens.text();
  assert.match(tokenHtml, /data-mind-diary-token-management/);
  assert.match(tokenHtml, /Codex on Mac/);
  assert.match(tokenHtml, /mdp_v1_Abc123…/);
  assert.match(tokenHtml, /mind-diary-token-client\.js/);
  assert.doesNotMatch(tokenHtml, /synthetic-show-once-value|verifier|principal_one/i);

  for (const [path, contentType, marker] of [
    ["/ui/mind-diary-shell.css", "text/css; charset=utf-8", "md-token-grid"],
    ["/brand/mind-diary-lockup.svg", "image/svg+xml; charset=utf-8", "Mind Diary logo"],
    ["/ui/mind-diary-onboarding-client.js", "text/javascript; charset=utf-8", "/api/v1/account"],
  ]) {
    const response = await handler(new Request(`${origin}${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.match(await response.text(), new RegExp(marker.replaceAll("/", "\\/")));
  }
  const wrongAssetMethod = await handler(new Request(`${origin}/ui/mind-diary-shell.css`, { method: "POST" }));
  assert.equal(wrongAssetMethod.status, 405);
  assert.deepEqual(calls, ["get_session", "list_minds", "get_session", "list_mcp_tokens"]);
});

test("ordinary Mind list and exact route wire the production management and deletion controls", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ui", verify: (_actor, token) => token === "csrf-ui" },
    control: { execute(request) {
      calls.push(request);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_minds") return [personalRoute, ordinaryOwnerRoute];
      if (request.operation === "get_mind_info") return ordinaryOwnerRoute;
      if (request.operation === "get_mind_deletion_impact") return {
        impactId: "impact_research",
        expiresAt: "2026-08-08T00:05:00.000Z",
        mind: { route: "/research-notes", name: "Research Notes" },
        revisionCount: 3,
        membershipCount: 1,
        pendingInvitationCount: 0,
        backgroundJobCount: 0,
        exportJobCount: 0,
        irreversible: true,
        recoveryAvailable: false,
        forensicReceiptRetained: false,
        confirmation: "delete-mind:research-notes",
      };
      if (request.operation === "delete_space") return { replayed: false };
      throw Object.assign(new Error("unexpected operation"), { code: "not_found" });
    } },
  });

  const list = await handler(new Request(`${origin}/minds`));
  assert.equal(list.status, 200);
  const listHtml = await list.text();
  assert.match(listHtml, /data-ordinary-minds-management/);
  assert.match(listHtml, /data-mind-card="research-notes"/);
  assert.match(listHtml, /href="\/research-notes"[^>]*data-manage-mind/);
  assert.doesNotMatch(listHtml, /data-mind-card="me"/);

  const detail = await handler(new Request(`${origin}/research-notes`));
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /data-mind-route data-mind-handle="research-notes"/);
  assert.match(detailHtml, /data-owner-delete-controls/);
  assert.match(detailHtml, /mind-diary-ordinary-minds-client\.js/);
  assert.doesNotMatch(detailHtml, /revision_research/);

  const asset = await handler(new Request(`${origin}/ui/mind-diary-ordinary-minds-client.js`));
  assert.equal(asset.status, 200);
  const assetBody = await asset.text();
  assert.match(assetBody, /deletion-impact/);
  assert.match(assetBody, /delete-mind:/);

  const impact = await handler(new Request(`${origin}/api/v1/minds/research-notes/deletion-impact`));
  assert.equal(impact.status, 200);
  assert.equal((await impact.json()).data.confirmation, "delete-mind:research-notes");

  const deleted = await handler(new Request(`${origin}/api/v1/minds/research-notes`, {
    method: "DELETE",
    headers: { origin, "x-csrf-token": "csrf-ui", "content-type": "application/json", "idempotency-key": "delete:12345678" },
    body: JSON.stringify({ impact_id: "impact_research", confirmation: "delete-mind:research-notes" }),
  }));
  assert.equal(deleted.status, 200);
  const deleteCall = calls.at(-1);
  assert.equal(deleteCall.operation, "delete_space");
  assert.equal(deleteCall.input.mind_ref, "research-notes");
  assert.equal(deleteCall.input.impactId, "impact_research");
  assert.equal(deleteCall.input.idempotencyKey, "delete:12345678");
});

test("token controls preserve CSRF and expose a one-time secret only in the issuance response", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ui", verify: (_actor, token) => token === "csrf-ui" },
    control: { execute(request) {
      calls.push(request);
      if (request.operation === "issue_mcp_token") return {
        token: { tokenId: "tok_created", displayPrefix: "mdp_v1_Safe12…" },
        secret: "synthetic-show-once-value",
      };
      if (request.operation === "revoke_mcp_token") return { token: { tokenId: "tok_created", state: "revoked" }, replayed: false };
      return sessionProjection;
    } },
  });

  const denied = await handler(new Request(`${origin}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: { origin, "x-csrf-token": "wrong", "content-type": "application/json" },
    body: JSON.stringify({ name: "Codex", scopes: ["content:read"] }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);

  const issued = await handler(new Request(`${origin}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: { origin, "x-csrf-token": "csrf-ui", "content-type": "application/json", "idempotency-key": "token:12345678" },
    body: JSON.stringify({ name: "Codex", scopes: ["content:write"], expires_at: "2026-08-15T00:00:00.000Z" }),
  }));
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  assert.equal(issuedBody.data.secret, "synthetic-show-once-value");
  assert.equal(calls[0].input.idempotencyKey, "token:12345678");

  const revoked = await handler(new Request(`${origin}/api/v1/mcp-tokens/tok_created`, {
    method: "DELETE",
    headers: { origin, "x-csrf-token": "csrf-ui", "idempotency-key": "revoke:12345678" },
  }));
  assert.equal(revoked.status, 200);
  assert.equal(calls[1].operation, "revoke_mcp_token");
  assert.equal(calls[1].input.token_id, "tok_created");
});

test("product UI keeps control read failures generic and still offers bounded retry states", async () => {
  const tokenListFailure = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ui", verify: () => true },
    control: { execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      throw new Error("private token table diagnostic");
    } },
  });
  const tokens = await tokenListFailure(new Request(`${origin}/settings/mcp`));
  assert.equal(tokens.status, 200);
  const tokenHtml = await tokens.text();
  assert.match(tokenHtml, /Token metadata is unavailable\. Try again\./);
  assert.doesNotMatch(tokenHtml, /private token table diagnostic/);

  const sessionFailure = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ui", verify: () => true },
    control: { execute() { throw new Error("private account diagnostic"); } },
  });
  const failed = await sessionFailure(new Request(`${origin}/me`));
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private account diagnostic/);
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
  const registration = await handler(new Request(`${origin}/`));
  assert.equal(registration.status, 200);
  const registrationHtml = await registration.text();
  assert.match(registrationHtml, /data-isolated-account-form/);
  assert.match(registrationHtml, /Create isolated account/);
  assert.match(registrationHtml, /mind-diary-onboarding-client\.js/);
  assert.doesNotMatch(registrationHtml, /person@example\.com/);
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
