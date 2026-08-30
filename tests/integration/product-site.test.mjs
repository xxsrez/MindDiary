import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  createProductBundleFileDownloadHttpHandler,
  createProductExportDownloadHttpHandler,
  createProductWebHttpHandler,
  resolveProductSitesIdentity,
} from "../../packages/adapter-web/dist/index.js";
import {
  ordinaryUiMind,
  publicUiMind,
  uiMind,
} from "../../packages/adapter-web/dist/product-http-request-helpers.js";
import {
  MCP_TOOL_DEFINITIONS,
  ProductMcpContentApplication,
} from "../../packages/adapter-mcp/dist/index.js";

const origin = "https://mind-diary.example";

function pngDimensions(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

test("product web origin accepts exact loopback dev without weakening hosted HTTPS", async () => {
  const local = createProductWebHttpHandler({
    applicationOrigin: "http://localhost:3000",
    resolveIdentity: () => ({ kind: "denied" }),
    csrf: { issue: () => "unused", verify: () => false },
    control: { execute: () => { throw new Error("must not execute"); } },
  });
  assert.equal((await local(new Request("http://localhost:3000/"))).status, 200);
  assert.throws(() => createProductWebHttpHandler({
    applicationOrigin: "http://mind-diary.example",
    resolveIdentity: () => ({ kind: "denied" }),
    csrf: { issue: () => "unused", verify: () => false },
    control: { execute: () => { throw new Error("must not execute"); } },
  }), /canonical HTTPS or loopback HTTP origin/u);
});

test("signed-out UI gets one safe Sites entry while REST and identity outages remain machine errors", async () => {
  let csrfIssues = 0;
  let controlCalls = 0;
  const denied = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "denied" }),
    csrf: {
      issue: () => { csrfIssues += 1; return "must-not-be-issued"; },
      verify: () => false,
    },
    control: { execute: () => { controlCalls += 1; throw new Error("must not execute"); } },
  });

  let canonicalShell;
  for (const path of [
    "/", "/me", "/minds", "/public", "/invitations", "/settings/account",
    "/settings/connections", "/settings/developer/mcp", "/settings/mcp",
    "/help/codex", "/help", "/unknown-handle",
  ]) {
    const response = await denied(new Request(`${origin}${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.match(response.headers.get("content-security-policy"), /form-action 'self'/u, path);
    const body = await response.text();
    canonicalShell ??= body;
    assert.equal(body, canonicalShell, path);
    assert.match(body, /data-session-state="anonymous"/u, path);
    assert.match(body, /href="\/signin-with-chatgpt"/u, path);
    assert.doesNotMatch(body, /mind-diary-csrf-token|data-control-plane|principal_one|revision_personal|unknown-handle|return_to|\/auth\/sign-in/u, path);

    const head = await denied(new Request(`${origin}${path}`, { method: "HEAD" }));
    assert.equal(head.status, 200, `${path} HEAD`);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8", `${path} HEAD`);
    assert.equal(await head.text(), "", `${path} HEAD`);
  }

  const api = await denied(new Request(`${origin}/api/v1/session`));
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal((await api.json()).error.code, "authentication_required");

  const deniedUiMutation = await denied(new Request(`${origin}/me`, { method: "POST" }));
  assert.equal(deniedUiMutation.status, 401);
  assert.equal((await deniedUiMutation.json()).error.code, "authentication_required");
  assert.equal(csrfIssues, 0);
  assert.equal(controlCalls, 0);

  for (const platformPath of ["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback", "/auth/sign-in"]) {
    assert.equal(await denied(new Request(`${origin}${platformPath}`)), null, platformPath);
  }

  const unavailable = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "unavailable" }),
    csrf: { issue: () => "unused", verify: () => false },
    control: { execute: () => { throw new Error("must not execute"); } },
  });
  for (const path of ["/", "/api/v1/session"]) {
    const response = await unavailable(new Request(`${origin}${path}`));
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", path);
    assert.equal((await response.json()).error.code, "identity_binding_unavailable", path);
  }
});
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
  description: null,
  isPersonal: false,
  visibility: "private",
  discovery: "membership",
  access: Object.freeze({ kind: "membership", role: "owner", capabilities: ["content:read", "content:write"] }),
  metadataVersion: 7,
  headRevisionId: "revision_research",
});

test("ordinary web projections require description while Personal intentionally omits it", () => {
  assert.equal("description" in personalRoute, false);
  assert.notEqual(uiMind(personalRoute), null);

  const { description: _description, ...ordinaryWithoutDescription } = ordinaryOwnerRoute;
  assert.equal(uiMind(ordinaryWithoutDescription), null);
  assert.equal(ordinaryUiMind(ordinaryWithoutDescription), null);

  const publicMind = {
    ...ordinaryOwnerRoute,
    visibility: "public",
    discovery: "public_catalog",
    access: { kind: "visibility", role: null, capabilities: ["content:read"] },
  };
  assert.notEqual(publicUiMind(publicMind), null);
  const { description: _publicDescription, ...publicWithoutDescription } = publicMind;
  assert.equal(publicUiMind(publicWithoutDescription), null);
});

test("authenticated home emits correlated privacy-safe performance stages", async () => {
  const events = [];
  const dependencies = {
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-performance", verify: () => true },
    control: {
      execute(request) {
        if (request.operation === "list_minds") return [personalRoute];
        throw new Error("unexpected control operation");
      },
    },
  };
  const handler = createProductWebHttpHandler({
    ...dependencies,
    performance: { record: (event) => events.push(event) },
  });

  assert.equal((await handler(new Request(`${origin}/`))).status, 200);
  assert.deepEqual(
    events.map(({ operation }) => operation),
    ["stage_authentication", "stage_application", "stage_total", "home"],
  );
  assert.deepEqual(new Set(events.map(({ requestId }) => requestId)), new Set(["request_one"]));
  assert.equal(events.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0), true);
  assert.equal(events.every(({ outcome }) => outcome === "success"), true);
  assert.deepEqual(Object.keys(events[0]).sort(), [
    "benchmarkCorrelationId",
    "durationMs",
    "operation",
    "outcome",
    "requestId",
  ]);
  assert.equal(events.every(({ benchmarkCorrelationId }) => benchmarkCorrelationId === null), true);

  const failingRecorder = createProductWebHttpHandler({
    ...dependencies,
    performance: { record() { throw new Error("telemetry unavailable"); } },
  });
  assert.equal((await failingRecorder(new Request(`${origin}/`))).status, 200);
});

test("internal operator UI/API are read-only, fail closed and record only successful web use", async () => {
  const activity = [];
  const calls = [];
  const operatorPage = Object.freeze({
    principals: Object.freeze([Object.freeze({
      principalId: "principal_support_target",
      displayName: "<script>Target</script>",
      verifiedEmail: "target@example.com",
      state: "active",
      registeredAt: "2026-08-22T09:00:00.000Z",
      activity: null,
      ownedMindCount: 0,
      participatingMindCount: 0,
      activeMcpCredentialCount: 0,
    })]),
    nextCursor: null,
  });
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-operator", verify: () => true },
    activity: { recordSuccessful(actor, surface, kind) { activity.push({ actor, surface, kind }); } },
    control: { async execute(request) {
      calls.push(request);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_service_operator_principals") return operatorPage;
      throw Object.assign(new Error("missing"), { code: "not_found" });
    } },
  });

  const page = await handler(new Request(`${origin}/internal/operators/users?neverActive=true`));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /UAT users/u);
  assert.match(html, /target@example\.com/u);
  assert.doesNotMatch(html, /<script>Target<\/script>/u);
  assert.match(html, /&lt;script&gt;Target&lt;\/script&gt;/u);
  assert.deepEqual(calls.at(-1).input, { neverActive: "true" });
  assert.deepEqual(activity.at(-1), { actor: registeredActor, surface: "web", kind: "page" });

  const api = await handler(new Request(`${origin}/api/v1/internal/operators/users?query=target%40example.com`));
  assert.equal(api.status, 200);
  assert.equal((await api.json()).data.principals[0].verified_email, "target@example.com");
  assert.equal(activity.at(-1).kind, "control_read");

  const hidden = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-hidden", verify: () => true },
    activity: { recordSuccessful() { throw new Error("must not record denied reads"); } },
    control: { async execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      throw Object.assign(new Error("hidden"), { code: "not_found" });
    } },
  });
  assert.equal((await hidden(new Request(`${origin}/internal/operators/users`))).status, 404);
  assert.equal((await hidden(new Request(`${origin}/api/v1/internal/operators/users`))).status, 404);

  const anonymous = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "denied" }),
    csrf: { issue: () => "unused", verify: () => false },
    control: { execute() { throw new Error("must not execute"); } },
  });
  assert.equal((await anonymous(new Request(`${origin}/internal/operators/users`))).status, 404);
  assert.equal((await anonymous(new Request(`${origin}/api/v1/internal/operators/users`))).status, 404);
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
  assert.match(pageHtml, /data-markdown-import data-head-revision="revision_personal" data-import-handle="me"/);
  assert.match(pageHtml, /data-export-workflow data-export-mind-ref="me" data-export-route="\/me"/);
  assert.match(pageHtml, /Target Mind:[\s\S]*Product Owner[\s\S]*<code data-export-target-route>\/me<\/code>/);
  assert.doesNotMatch(pageHtml, /principal_one|Bearer must-not-be-used-by-web/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const onboardingAsset = await handler(new Request(`${origin}/ui/mind-diary-onboarding-client.js`));
  const onboardingJavaScript = await onboardingAsset.text();
  assert.match(onboardingJavaScript, /markdown-import-plans/);
  assert.match(onboardingJavaScript, /export-jobs/);
  assert.match(onboardingJavaScript, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.doesNotThrow(() => new vm.Script(onboardingJavaScript));

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

test("authenticated UI reuses the identity session snapshot instead of rereading it", async () => {
  const calls = [];
  const catalogInputs = [];
  const nextCursor = "mdc1_eyJ2IjoxLCJxIjoicHVibGljX21pbmRzIiwiZyI6MSwibyI6MjR9";
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-session-snapshot", verify: () => true },
    control: { execute(request) {
      calls.push(request.operation);
      if (request.operation === "list_public_minds") {
        catalogInputs.push(request.input);
        return { minds: [
        {
          mindId: "space_public_notes",
          route: "/public-notes",
          name: "Public Notes",
          description: "A public\nplain-text description.",
          isPersonal: false,
          visibility: "public",
          discovery: "public_catalog",
          principalId: "principal_must_not_render",
          privateContent: "PRIVATE CATALOG CONTENT",
        },
        {
          mindId: "space_schema_drift",
          route: "/schema-drift",
          name: "Missing required description",
          isPersonal: false,
          visibility: "public",
          discovery: "public_catalog",
        },
      ], nextCursor };
      }
      throw new Error(`unexpected control operation: ${request.operation}`);
    } },
  });

  const personal = await handler(new Request(`${origin}/me`));
  assert.equal(personal.status, 200);
  assert.match(await personal.text(), /<h1>My Mind<\/h1>/u);
  assert.deepEqual(calls, []);

  const catalog = await handler(new Request(`${origin}/public`));
  assert.equal(catalog.status, 200);
  assert.match(await catalog.text(), /data-public-catalog-collection/u);
  assert.deepEqual(calls, []);

  const catalogData = await handler(new Request(`${origin}/api/v1/public-minds`));
  assert.equal(catalogData.status, 200);
  const catalogPayload = await catalogData.json();
  assert.deepEqual(catalogPayload.data.minds, [{
    mind_id: "space_public_notes",
    route: "/public-notes",
    name: "Public Notes",
    description: "A public\nplain-text description.",
    summary: "A public plain-text description.",
    visibility: "public",
    is_personal: false,
    discovery: "public_catalog",
  }]);
  assert.equal(JSON.stringify(catalogPayload).includes("principal_must_not_render"), false);
  assert.equal(JSON.stringify(catalogPayload).includes("PRIVATE CATALOG CONTENT"), false);
  assert.equal(catalogPayload.next_cursor, nextCursor);
  assert.deepEqual(catalogInputs, [{ limit: 24 }]);

  const nextPage = await handler(new Request(
    `${origin}/api/v1/public-minds?limit=1&cursor=${nextCursor}`,
  ));
  assert.equal(nextPage.status, 200);
  assert.deepEqual(catalogInputs.at(-1), { limit: 1, cursor: nextCursor });
  assert.deepEqual(calls, ["list_public_minds", "list_public_minds"]);
});

test("Public Minds HTTP pagination rejects malformed query before application access", async () => {
  let controlCalls = 0;
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-public-query", verify: () => true },
    control: { execute() { controlCalls += 1; throw new Error("must not execute"); } },
  });

  for (const query of [
    "?limit=0",
    "?limit=51",
    "?limit=1.5",
    "?cursor=",
    "?cursor=not-a-catalog-cursor",
    "?limit=1&limit=2",
    "?filter=public",
  ]) {
    const response = await handler(new Request(`${origin}/api/v1/public-minds${query}`));
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "invalid_request", query);
  }
  assert.equal(controlCalls, 0);
});

test("successful web activity can run after the response through host deferral", async () => {
  let finishActivity;
  let activityFinished = false;
  const pendingActivity = new Promise((resolve) => { finishActivity = resolve; })
    .then(() => { activityFinished = true; });
  const deferred = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-deferred-activity", verify: () => true },
    control: { execute() { throw new Error("must not execute"); } },
    activity: { recordSuccessful() { return pendingActivity; } },
  });

  const response = await handler(
    new Request(`${origin}/me`),
    (promise) => { deferred.push(promise); },
  );
  assert.equal(response.status, 200);
  assert.equal(activityFinished, false);
  assert.equal(deferred.length, 1);
  finishActivity();
  await Promise.all(deferred);
  assert.equal(activityFinished, true);
});

test("rapid successful pages coalesce one deferred activity write per principal", async () => {
  const activityCalls = [];
  const deferred = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-coalesced-activity", verify: () => true },
    control: { execute() { throw new Error("must not execute"); } },
    activity: {
      recordSuccessful(actor, surface, kind) {
        activityCalls.push({ actor, surface, kind });
      },
    },
    activityCoalesceWindowMs: 25,
  });

  for (let index = 0; index < 3; index += 1) {
    const response = await handler(
      new Request(`${origin}/me`),
      (promise) => { deferred.push(promise); },
    );
    assert.equal(response.status, 200);
  }
  assert.equal(deferred.length, 1);
  await Promise.all(deferred);
  assert.deepEqual(activityCalls, [{ actor: registeredActor, surface: "web", kind: "page" }]);
});

test("product root, Connections, and Advanced MCP render safe live projections and fixed assets", async () => {
  const calls = [];
  const personalTokenRef = `ptok_v1_${"1".repeat(32)}`;
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-ui", verify: () => true },
    control: { async execute(request) {
      calls.push(request.operation);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_minds") return [personalRoute];
      throw Object.assign(new Error("unexpected operation"), { code: "not_found" });
    } },
    personalTokens: {
      async listPage() {
        return { items: [{
          personalTokenRef,
          bindingOwnerId: "token_internal_must_not_render",
          name: "Codex on Mac",
          displayPrefix: "mdp_v1_Abc123…",
          scopes: ["content:read", "content:write"],
          state: "active",
          createdAt: "2026-08-08T00:00:00.000Z",
          expiresAt: "2026-11-06T00:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        }], nextCursor: null };
      },
      async read() { return null; },
    },
    writableTargets: {
      async listResolved(_actor, credentials) {
        return credentials.map((credential) => ({
          ownerId: credential.ownerId,
          credentialKind: credential.credentialKind,
          lifecycleState: "active",
          targetVersion: 0,
          targetMindId: null,
        }));
      },
      async mutateResolved() { throw new Error("unused"); },
    },
  });

  const root = await handler(new Request(`${origin}/`));
  assert.equal(root.status, 200);
  const rootHtml = await root.text();
  assert.match(rootHtml, /data-mind-diary-shell/);
  assert.match(rootHtml, /data-home-minds-collection/);
  assert.match(rootHtml, /data-ia-nav="primary"[\s\S]*href="\/me"[\s\S]*href="\/minds"/);
  assert.match(rootHtml, /data-ia-settings-item[\s\S]*href="\/settings\/account"|href="\/settings\/account"[\s\S]*data-ia-settings-item/);
  assert.doesNotMatch(rootHtml, /Product Owner/);
  assert.doesNotMatch(rootHtml, /href="\/settings\/connections"/);
  assert.match(rootHtml, /rel="icon" href="\/favicon\.ico" sizes="16x16 32x32"/);
  assert.match(rootHtml, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any"/);
  assert.match(rootHtml, /rel="icon" href="\/favicon-32x32\.png" type="image\/png" sizes="32x32"/);
  assert.match(rootHtml, /rel="apple-touch-icon" href="\/apple-touch-icon\.png" type="image\/png" sizes="180x180"/);
  assert.doesNotMatch(rootHtml, /principal_one|revision_personal/);

  const legacy = await handler(new Request(`${origin}/settings/mcp`));
  assert.equal(legacy.status, 308);
  assert.equal(legacy.headers.get("location"), "/settings/developer/mcp");
  const legacyHead = await handler(new Request(`${origin}/settings/mcp`, { method: "HEAD" }));
  assert.equal(legacyHead.status, 308);
  assert.equal(legacyHead.headers.get("location"), "/settings/developer/mcp");
  assert.equal(await legacyHead.text(), "");

  const tokens = await handler(new Request(`${origin}/settings/developer/mcp`));
  assert.equal(tokens.status, 200);
  assert.equal(tokens.headers.get("cache-control"), "no-store");
  const tokenHtml = await tokens.text();
  assert.match(tokenHtml, /data-advanced-mcp/);
  assert.match(tokenHtml, /Codex on Mac/);
  assert.match(tokenHtml, /mdp_v1_Abc123…/);
  assert.match(tokenHtml, /mind-diary-connections-client\.js/);
  assert.match(tokenHtml, /data-mcp-self-check/);
  assert.match(tokenHtml, /data-run-mcp-self-check disabled/);
  assert.match(tokenHtml, /data-copy-code="mind-diary-modern-config"/);
  assert.match(tokenHtml, /https:\/\/mind-diary\.example\/api\/mcp\/2025-11-25/);
  assert.match(tokenHtml, /https:\/\/mind-diary\.example\/api\/mcp/);
  assert.doesNotMatch(tokenHtml, /&lt;your-mind-diary-site&gt;/);
  assert.doesNotMatch(tokenHtml, /synthetic-show-once-value|verifier|principal_one|token_internal_must_not_render/i);
  assert.doesNotMatch(tokenHtml, /token_id|binding_owner|target_generation|space_/u);
  assert.doesNotMatch(tokenHtml, /data-personal-token-ref/u);

  for (const [path, contentType, marker] of [
    ["/favicon.svg", "image/svg+xml; charset=utf-8", "#6C4BB6"],
    ["/ui/mind-diary-shell.css", "text/css; charset=utf-8", "md-token-grid"],
    ["/brand/mind-diary-lockup.svg", "image/svg+xml; charset=utf-8", "Mind Diary logo"],
    ["/brand/mind-diary-mark.svg", "image/svg+xml; charset=utf-8", "Mind Diary mark"],
    ["/ui/mind-diary-onboarding-client.js", "text/javascript; charset=utf-8", "/api/v1/account"],
    ["/ui/mind-diary-token-client.js", "text/javascript; charset=utf-8", "/api/mcp/2025-11-25"],
    ["/ui/mind-diary-ordinary-minds-list-client.js", "text/javascript; charset=utf-8", "/api/v1/minds"],
    ["/ui/mind-diary-connections-client.js", "text/javascript; charset=utf-8", "data-revoke-connection"],
    ["/ui/mind-diary-visibility-client.js", "text/javascript; charset=utf-8", "data-public-catalog-retry"],
  ]) {
    const response = await handler(new Request(`${origin}${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=60, stale-while-revalidate=300",
    );
    const body = await response.text();
    assert.match(body, new RegExp(marker.replaceAll("/", "\\/")));
    if (path.endsWith(".js")) assert.doesNotThrow(() => new vm.Script(body));
    if (path === "/ui/mind-diary-ordinary-minds-list-client.js") {
      assert.match(body, /principal-mind-usage\/v1/u);
      assert.match(body, /\/api\/v1\/mind-usage/u);
    }
    if (path === "/ui/mind-diary-connections-client.js") {
      assert.doesNotMatch(body, /mind-access|api\/v1\/oauth-connections|api\/v1\/mind-bindings/);
      assert.match(body, /cache:\s*"no-store"/u);
      assert.doesNotMatch(body, /readable_mind_count|writable_mind|mind-access|read selector|attach_read|detach_read|data-access-action/iu);
      assert.doesNotMatch(body, /console\.|localStorage|sessionStorage|sendBeacon/u);
    }
  }
  const hostedShellCss = await (await handler(new Request(`${origin}/ui/mind-diary-shell.css`))).text();
  assert.equal(
    hostedShellCss,
    await readFile(new URL("../../packages/adapter-web/src/ui-shell.css", import.meta.url), "utf8"),
  );
  for (const [path, contentType, expectedDimensions] of [
    ["/favicon-32x32.png", "image/png", [32, 32]],
    ["/apple-touch-icon.png", "image/png", [180, 180]],
    ["/apple-touch-icon-precomposed.png", "image/png", [180, 180]],
  ]) {
    const response = await handler(new Request(`${origin}${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.deepEqual(pngDimensions(new Uint8Array(await response.arrayBuffer())), expectedDimensions);
    const hardRefresh = await handler(new Request(`${origin}${path}`, {
      headers: { "cache-control": "no-cache" },
    }));
    assert.equal(hardRefresh.status, 200);
  }
  const icon = await handler(new Request(`${origin}/favicon.ico`, {
    headers: { "cache-control": "no-cache" },
  }));
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/x-icon");
  const iconBytes = new Uint8Array(await icon.arrayBuffer());
  assert.deepEqual([...iconBytes.subarray(0, 6)], [0, 0, 1, 0, 2, 0]);
  const iconHead = await handler(new Request(`${origin}/favicon.ico`, { method: "HEAD" }));
  assert.equal(iconHead.status, 200);
  assert.equal((await iconHead.arrayBuffer()).byteLength, 0);
  const wrongAssetMethod = await handler(new Request(`${origin}/ui/mind-diary-shell.css`, { method: "POST" }));
  assert.equal(wrongAssetMethod.status, 405);
  assert.deepEqual(calls, []);
});

test("account settings wires profile CAS, fresh deletion impact, same-key retry client, and privacy-safe recovery", async () => {
  const calls = [];
  const deletionImpact = {
    impactId: "impact_account_product_1",
    expiresAt: "2099-08-10T20:00:00.000Z",
    personalMind: { route: "/me", name: "Product Owner" },
    ownedMinds: [{ route: "/research-notes", name: "Research Notes" }],
    foreignMembershipCount: 2,
    pendingInvitationCount: 1,
    activeMcpTokenCount: 3,
    irreversible: true,
    recoveryAvailable: false,
    forensicReceiptRetained: false,
    confirmation: "delete-account",
    verifiedEmail: "must-not-render@example.com",
    privateContent: "PRIVATE ACCOUNT CONTENT MUST NOT RENDER",
  };
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-account", verify: (_actor, token) => token === "csrf-account" },
    control: { execute(request) {
      calls.push(request);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "get_account_deletion_impact") return deletionImpact;
      if (request.operation === "rename_account") return { replayed: false };
      if (request.operation === "delete_account") {
        return {
          replayed: false,
          spacesDeleted: 2,
          tokensRevoked: 3,
          canonicalObjectsDeleted: 4,
          canonicalObjectsRetained: 1,
          indexedRevisionsDeleted: 4,
          deliveredAuditEventsDeleted: 2,
          deliveredAuditActorsTombstoned: 1,
          exportArchivesDeleted: 0,
        };
      }
      throw Object.assign(new Error("unexpected operation"), { code: "not_found" });
    } },
  });

  const page = await handler(new Request(`${origin}/settings/account`));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Account and profile — Mind Diary UAT<\/title>/);
  assert.match(html, /data-profile-form data-profile-version="3"/);
  assert.match(html, /data-current-account-identity/);
  assert.match(html, /ChatGPT through OpenAI Sites/);
  assert.match(html, /does not create or store a separate password/);
  assert.match(html, /href="\/help\/codex">Install and connect Mind Diary<\/a>/);
  assert.match(html, /href="\/settings\/connections">View Connections<\/a>/);
  assert.match(html, /data-identity-recovery-handoff/);
  assert.match(html, /same trusted channel that admitted you/);
  assert.match(html, /data-account-deletion-panel/);
  assert.match(html, /Loading the exact deletion preview/);
  assert.doesNotMatch(html, /Research Notes/);
  assert.match(html, /mind-diary-account-client\.js/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /must-not-render@example\.com|PRIVATE ACCOUNT CONTENT|principal_one|revision_personal/);

  const impactResponse = await handler(new Request(`${origin}/api/v1/account/deletion-impact`));
  assert.equal(impactResponse.status, 200);
  const impactPayload = await impactResponse.json();
  assert.equal(impactPayload.data.impact_id, deletionImpact.impactId);
  assert.equal(impactPayload.data.owned_minds[0].name, "Research Notes");
  assert.equal(impactPayload.data.foreign_membership_count, 2);
  assert.equal(impactPayload.data.pending_invitation_count, 1);
  assert.equal(impactPayload.data.active_mcp_token_count, 3);
  assert.equal(JSON.stringify(impactPayload).includes("must-not-render@example.com"), false);
  assert.equal(JSON.stringify(impactPayload).includes("PRIVATE ACCOUNT CONTENT"), false);

  const asset = await handler(new Request(`${origin}/ui/mind-diary-account-client.js`));
  assert.equal(asset.status, 200);
  const assetBody = await asset.text();
  assert.match(assetBody, /DELETE","\/api\/v1\/account"/);
  assert.match(assetBody, /deletion_impact_changed/);
  assert.match(assetBody, /Retry sends the exact same deletion command/);
  assert.match(assetBody, /account_bootstrap_conflict/);
  assert.match(assetBody, /data-profile-conflict|profileConflict/);
  assert.match(assetBody, /data-ia-impact|iaImpact/);
  assert.match(assetBody, /location\.replace\("\/"\)/);

  const renamed = await handler(new Request(`${origin}/api/v1/account`, {
    method: "PATCH",
    headers: {
      origin,
      "content-type": "application/json",
      "x-csrf-token": "csrf-account",
      "idempotency-key": "profile:product-account",
    },
    body: JSON.stringify({ display_name: "Renamed Owner", expected_profile_version: 3 }),
  }));
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls.at(-1).input, {
    displayName: "Renamed Owner",
    expectedProfileVersion: 3,
    idempotencyKey: "profile:product-account",
  });

  const deleted = await handler(new Request(`${origin}/api/v1/account`, {
    method: "DELETE",
    headers: {
      origin,
      "content-type": "application/json",
      "x-csrf-token": "csrf-account",
      "idempotency-key": "account-delete:product-account",
    },
    body: JSON.stringify({
      impact_id: deletionImpact.impactId,
      confirmation: deletionImpact.confirmation,
    }),
  }));
  assert.equal(deleted.status, 200);
  assert.deepEqual(calls.at(-1).input, {
    impactId: deletionImpact.impactId,
    confirmation: "delete-account",
    idempotencyKey: "account-delete:product-account",
  });

  deletionImpact.expiresAt = "2000-01-01T00:00:00.000Z";
  const stalePage = await handler(new Request(`${origin}/settings/account`));
  assert.equal(stalePage.status, 200);
  const staleHtml = await stalePage.text();
  assert.match(staleHtml, /Loading the exact deletion preview/);
  assert.doesNotMatch(staleHtml, /data-account-deletion-form/);
  const staleImpact = await handler(new Request(`${origin}/api/v1/account/deletion-impact`));
  assert.equal(staleImpact.status, 200);
  assert.equal((await staleImpact.json()).data.expires_at, deletionImpact.expiresAt);
});

test("an unlinked authenticated identity gets only isolated creation or a non-secret manual recovery handoff", async () => {
  let controlCalls = 0;
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "registration_required",
      actor: {
        kind: "sites_identity_before_registration",
        authentication: { kind: "sites_identity", verifiedByPlatform: true },
        provider: "openai_sites",
        normalizedBinding: "must-not-render@example.com",
        suggestedDisplayName: "Unknown Person",
        deploymentCapabilities: [],
        requestId: "request_unknown_identity",
        occurredAtUtc: "2026-08-10T00:00:00.000Z",
      },
    }),
    csrf: { issue: () => "csrf-unlinked", verify: () => true },
    control: { execute() { controlCalls += 1; throw new Error("must not read earlier account state"); } },
  });

  const page = await handler(new Request(`${origin}/settings/account`));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Create a new isolated account/);
  assert.match(html, /do not create an isolated account/i);
  assert.match(html, /same trusted channel that admitted you/);
  assert.match(html, /Nothing is relinked, merged, or transferred automatically/);
  assert.match(html, /Never send an MCP token, private Mind content, query, export URL, or download URL/);
  assert.doesNotMatch(html, /must-not-render@example\.com|principal_one|space_personal/);
  assert.equal(controlCalls, 0);
});

test("pilot Product Site route map keeps one UAT shell, exact active navigation, and fail-closed deep links", async () => {
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-pilot", verify: () => true },
    control: { execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_minds") return [personalRoute, ordinaryOwnerRoute];
      if (request.operation === "list_mcp_tokens") return [];
      if (request.operation === "get_invitations_overview") {
        return {
          invitations: { invitations: [] },
          minds: [personalRoute, ordinaryOwnerRoute],
        };
      }
      if (request.operation === "get_capacity_usage") return {
        kind: "found",
        usage: {
          logicalHeadBytes: 1_024,
          logicalRetainedBytes: 2_048,
          physicalCanonicalBytes: 1_536,
          temporaryBytes: 0,
          d1MetadataBytes: 4_096,
          reservedBytes: 0,
          storageAmplification: 1.5,
        },
        principalUsage: { physicalCanonicalBytes: 2_048 },
        mindCanonicalHeadroomBytes: 2_147_482_112,
        principalCanonicalHeadroomBytes: 8_589_932_544,
        utilization: "normal",
      };
      if (request.operation === "list_public_minds") {
        return { minds: [{ ...ordinaryOwnerRoute, visibility: "public", discovery: "public_catalog", access: { kind: "visibility", role: null, capabilities: ["content:read"] } }], nextCursor: null };
      }
      if (request.operation === "list_members") {
        return { members: [{ memberId: "membership_owner", displayName: "Product Owner", role: "owner", membershipVersion: 1, isSelf: true }] };
      }
      if (request.operation === "get_mind_info" && request.input.mind_ref === "research-notes") {
        return ordinaryOwnerRoute;
      }
      throw Object.assign(new Error("not found"), { code: "not_found" });
    } },
    oauthConnections: {
      async listPage() { return { items: [], nextCursor: null }; },
      async read() { return null; },
      async revoke() { return false; },
    },
    personalTokens: {
      async listPage() { return { items: [], nextCursor: null }; },
      async read() { return null; },
    },
    writableTargets: {
      async listResolved() { return []; },
      async mutateResolved() { throw new Error("unused"); },
    },
  });

  const routeMap = [
    ["/", /<title>Home — Mind Diary UAT<\/title>/],
    ["/me", /<h1>My Mind<\/h1>/],
    ["/minds", /data-management-view="list"/],
    ["/research-notes", /data-mind-handle="research-notes"/],
    ["/public", /data-mind-diary-visibility-catalog/],
    ["/invitations", /data-people-collection/],
    ["/settings/account", /data-mind-diary-account-deletion/],
    ["/settings/connections", /data-connections-page/],
    ["/settings/developer/mcp", /data-advanced-mcp/],
    ["/help/codex", /data-codex-help/],
    ["/help", /data-route-page="help"/],
  ];
  for (const [path, marker] of routeMap) {
    const response = await handler(new Request(`${origin}${path}`));
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, marker, path);
    assert.match(html, /data-mind-diary-shell/, path);
    assert.match(html, /Hosted environment: UAT/, path);
    assert.match(html, /href="\/me"/, path);
    assert.match(html, /href="\/minds"/, path);
    assert.match(html, /href="\/public"/, path);
    assert.match(html, /href="\/invitations"/, path);
    assert.match(html, /href="\/settings\/account"/, path);
    assert.match(html, /href="\/help\/codex"[^>]+data-ia-codex-help-link/, path);
    const settingsRoute = path.startsWith("/settings/");
    assert.equal(/data-ia-nav="settings"/.test(html), settingsRoute, path);
    if (settingsRoute) {
      assert.match(html, /href="\/settings\/connections"/, path);
      assert.match(html, /href="\/settings\/developer\/mcp"/, path);
      assert.deepEqual(
        [...html.matchAll(/data-ia-settings-section="([^"]+)"/gu)].map((match) => match[1]),
        ["account", "connections", "advanced-mcp"],
        path,
      );
    }
    const expectedCurrentCount = path === "/help"
      ? 0
      : path === "/settings/developer/mcp"
      ? 3
      : path === "/" || settingsRoute ? 2 : 1;
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, expectedCurrentCount, path);
    assert.doesNotMatch(html, /owner-only production Site|current Site is production/i, path);
  }

  const legacyMcp = await handler(new Request(`${origin}/settings/mcp`));
  assert.equal(legacyMcp.status, 308);
  assert.equal(legacyMcp.headers.get("location"), "/settings/developer/mcp");

  const help = await handler(new Request(`${origin}/help`));
  const helpHtml = await help.text();
  assert.match(helpHtml, /no production SLA or guaranteed recovery/u);
  assert.match(helpHtml, /Keep your own export before risky work/u);
  assert.match(helpHtml, /Report only the symptom, UTC time, and safe request ID/u);
  assert.match(helpHtml, /data-copy-ready-guide="mind-diary-help-starter-playbook"/u);
  assert.match(helpHtml, /data-copy-code="mind-diary-help-concierge-playbook"/u);
  assert.match(helpHtml, /one Mind whose effective mode is Read and write/u);
  assert.match(helpHtml, /concierge work, not a product import/u);
  assert.match(helpHtml, /href="\/settings\/developer\/mcp"[^>]*>Open Advanced MCP<\/a>/u);
  assert.equal((helpHtml.match(/aria-current="page"/gu) ?? []).length, 0);

  const codexHelp = await handler(new Request(`${origin}/help/codex`));
  const codexHelpHtml = await codexHelp.text();
  assert.match(codexHelpHtml, /Authenticate for reading/);
  assert.match(codexHelpHtml, /Srez Marketplace/);
  assert.match(codexHelpHtml, /Mind Diary UAT/);
  assert.match(codexHelpHtml, /OAuth-on-first-use/);
  assert.match(codexHelpHtml, /https:\/\/github\.com\/xxsrez\/marketplace/);
  assert.match(codexHelpHtml, /codex plugin marketplace add xxsrez\/marketplace/);
  assert.match(codexHelpHtml, /codex plugin add mind-diary@srez-marketplace/);
  assert.match(codexHelpHtml, /Use Mind Diary to list the Minds I can read\. Do not create or change any Memory\./);
  assert.match(codexHelpHtml, /data-codex-client-tab="desktop"/);
  assert.match(codexHelpHtml, /data-codex-client-tab="cli"/);
  assert.match(codexHelpHtml, /data-copy-code="codex-help-cli-install"/);
  assert.match(codexHelpHtml, /Choose readable Minds and start/u);
  assert.match(codexHelpHtml, /current rights and credential scope checks/u);
  assert.match(codexHelpHtml, /Writing is optional/u);
  assert.match(codexHelpHtml, /choose Read and write for exactly one described Mind/u);
  assert.match(codexHelpHtml, /one account-wide choice is shared by every Connection and personal token/u);
  assert.match(codexHelpHtml, /Create the first useful Memory/);
  assert.match(codexHelpHtml, /href="\/me#first-result-title">Open the starter card/);
  assert.match(codexHelpHtml, /href="\/settings\/developer\/mcp">Advanced MCP/);
  assert.doesNotMatch(
    codexHelpHtml,
    /MIND_DIARY_TOKEN|api\/mcp|client secret|PKCE|DCR|content:read|binding_version|write_binding_id/i,
  );
  assert.doesNotMatch(codexHelpHtml, /attach at least one Mind|select, switch, or clear this target/u);

  for (const path of ["/api", "/mcp", "/settings", "/settings/unknown", "/minds/extra"]) {
    assert.equal(await handler(new Request(`${origin}${path}`)), null, path);
  }
  const missingMind = await handler(new Request(`${origin}/unknown-handle`));
  assert.equal(missingMind.status, 200);
  const missingHtml = await missingMind.text();
  assert.match(missingHtml, /Mind settings unavailable/);
  assert.doesNotMatch(missingHtml, /not found|principal_one|space_research/i);
});

test("authenticated Home and Minds both defer collection work behind their safe API", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-home-projection", verify: () => true },
    control: { execute(request) {
      calls.push(request.operation);
      if (request.operation === "list_minds") return [personalRoute, ordinaryOwnerRoute];
      throw new Error(`unexpected operation: ${request.operation}`);
    } },
  });

  const home = await handler(new Request(`${origin}/`));
  assert.equal(home.status, 200);
  assert.match(await home.text(), /data-home-minds-collection/u);
  assert.deepEqual(calls, []);

  calls.length = 0;
  const minds = await handler(new Request(`${origin}/minds`));
  assert.equal(minds.status, 200);
  const mindsHtml = await minds.text();
  assert.match(mindsHtml, /data-management-view="list"/u);
  assert.match(mindsHtml, /mind-diary-ordinary-minds-list-client\.js/u);
  assert.deepEqual(calls, []);

  const listed = await handler(new Request(`${origin}/api/v1/minds`));
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.length, 2);
  assert.deepEqual(calls, ["list_minds"]);
});

test("principal-wide Mind usage Web API is safe, atomic, versioned, and independent of credentials", async () => {
  const personal = Object.freeze({
    ...personalRoute,
    description: "Personal decisions and durable preferences discussed with me.",
  });
  const research = Object.freeze({
    ...ordinaryOwnerRoute,
    description: "Research decisions, evidence, and reusable conclusions.",
  });
  const archive = Object.freeze({
    ...ordinaryOwnerRoute,
    mindId: "space_archive_internal",
    route: "/archive",
    handle: "archive",
    name: "Archive",
    description: null,
    access: Object.freeze({
      kind: "membership",
      role: "reader",
      capabilities: ["content:read"],
    }),
  });
  const byRef = new Map([
    ["me", personal],
    ["research-notes", research],
    ["archive", archive],
  ]);
  let usage = null;
  const commands = [];
  const descriptionCommands = [];
  let descriptionConflict = false;
  const mindUsage = {
    async read(actor) {
      assert.equal(actor, registeredActor);
      return usage;
    },
    async mutate(command) {
      commands.push(command);
      const currentVersion = usage?.usageVersion ?? 0;
      if (command.expectedUsageVersion !== currentVersion) {
        return { kind: "usage_version_conflict" };
      }
      const entries = new Map((usage?.entries ?? []).map((entry) => [
        entry.spaceId,
        entry.usageMode,
      ]));
      if (command.usageMode === "disabled") entries.delete(command.spaceId);
      else {
        if (command.usageMode === "read_write") {
          for (const [spaceId, mode] of entries) {
            if (mode === "read_write" && spaceId !== command.spaceId) {
              entries.set(spaceId, "read");
            }
          }
        }
        entries.set(command.spaceId, command.usageMode);
      }
      usage = Object.freeze({
        contractVersion: "principal-mind-usage/v1",
        principalId: registeredActor.principalId,
        usageVersion: currentVersion + 1,
        entries: Object.freeze([...entries].map(([spaceId, usageMode]) =>
          Object.freeze({ spaceId, usageMode }))),
      });
      return { kind: "applied", state: usage, changed: true, replayed: false };
    },
  };
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-usage", verify: (_actor, token) => token === "csrf-usage" },
    control: { async execute(request) {
      if (request.operation === "get_session") return {
        ...sessionProjection,
        personalMind: { ...sessionProjection.personalMind, description: personal.description },
      };
      if (request.operation === "list_minds") return [personal, research, archive];
      if (request.operation === "get_mind_info") return byRef.get(request.input.mind_ref) ?? null;
      if (request.operation === "update_personal_mind_description") {
        descriptionCommands.push(request.input);
        if (descriptionConflict) throw Object.assign(new Error("stale"), { code: "metadata_conflict" });
        return {
          principal: { principalId: "principal_must_not_escape", displayName: "Product Owner", profileVersion: 3 },
          personalMind: {
            mindId: "space_personal_must_not_escape",
            route: "/me",
            name: "Product Owner",
            description: request.input.description,
            metadataVersion: 3,
            headRevisionId: "revision_must_not_escape",
          },
          replayed: false,
        };
      }
      throw new Error(`unexpected operation: ${request.operation}`);
    } },
    mindUsage,
    writableTargets: {
      async listResolved() { throw new Error("usage must not depend on credentials"); },
      async mutateResolved() { throw new Error("usage must not mutate credentials"); },
    },
  });

  const initial = await handler(new Request(`${origin}/api/v1/mind-usage`));
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.data.contract_version, "principal-mind-usage/v1");
  assert.equal(initialBody.data.usage_version, 0);
  assert.deepEqual(initialBody.data.items.map((item) => item.usage_mode), [
    "disabled", "disabled", "disabled",
  ]);
  assert.equal(initialBody.data.items[2].description, null);
  assert.equal(initialBody.data.items[2].eligibility.can_read, true);
  assert.equal(initialBody.data.items[2].eligibility.can_write, false);
  assert.equal(initialBody.data.items[2].eligibility.description_required, true);
  assert.doesNotMatch(JSON.stringify(initialBody), /principal_one|space_|revision_|mind_id|generation/iu);

  const denied = await handler(new Request(`${origin}/api/v1/minds/archive/usage`, {
    method: "PUT",
    headers: { origin, "x-csrf-token": "wrong", "content-type": "application/json" },
    body: JSON.stringify({ usage_mode: "read", expected_usage_version: 0 }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(commands.length, 0);

  const set = async (mindRef, usageMode, expectedUsageVersion, key) => {
    const response = await handler(new Request(`${origin}/api/v1/minds/${mindRef}/usage`, {
      method: "PUT",
      headers: {
        origin,
        "x-csrf-token": "csrf-usage",
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ usage_mode: usageMode, expected_usage_version: expectedUsageVersion }),
    }));
    return { response, body: await response.json() };
  };

  const archiveRead = await set("archive", "read", 0, "usage:archive-read");
  assert.equal(archiveRead.response.status, 200);
  assert.equal(archiveRead.body.data.projection.items.find((item) =>
    item.mind_ref === "/archive").usage_mode, "read");
  assert.equal(archiveRead.body.data.projection.items.find((item) =>
    item.mind_ref === "/archive").effective.can_write, false);

  const researchWrite = await set("research-notes", "read_write", 1, "usage:research-write");
  assert.equal(researchWrite.response.status, 200);
  assert.equal(researchWrite.body.data.projection.usage_version, 2);
  assert.equal(researchWrite.body.data.projection.items.find((item) =>
    item.mind_ref === "/research-notes").effective.can_write, true);

  const personalWrite = await set("me", "read_write", 2, "usage:personal-write");
  assert.equal(personalWrite.response.status, 200);
  assert.deepEqual(personalWrite.body.data.projection.items.map((item) => [
    item.mind_ref,
    item.usage_mode,
  ]), [
    ["/me", "read_write"],
    ["/research-notes", "read"],
    ["/archive", "read"],
  ]);
  assert.equal(personalWrite.body.data.projection.items.filter((item) =>
    item.usage_mode === "read_write").length, 1);
  assert.doesNotMatch(JSON.stringify(personalWrite.body), /principal_one|space_|revision_|mind_id|generation/iu);
  assert.deepEqual(commands.map((command) => ({
    spaceId: command.spaceId,
    usageMode: command.usageMode,
    expectedUsageVersion: command.expectedUsageVersion,
    idempotencyKey: command.idempotencyKey,
  })), [
    { spaceId: "space_archive_internal", usageMode: "read", expectedUsageVersion: 0, idempotencyKey: "usage:archive-read" },
    { spaceId: "space_research", usageMode: "read_write", expectedUsageVersion: 1, idempotencyKey: "usage:research-write" },
    { spaceId: "space_personal", usageMode: "read_write", expectedUsageVersion: 2, idempotencyKey: "usage:personal-write" },
  ]);

  const conflict = await set("research-notes", "read_write", 1, "usage:stale");
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "usage_conflict");
  const refreshed = await (await handler(new Request(
    `${origin}/api/v1/minds/research-notes/usage`,
  ))).json();
  assert.equal(refreshed.data.usage_version, 3);
  assert.equal(refreshed.data.items[0].usage_mode, "read");

  const description = await handler(new Request(`${origin}/api/v1/minds/me/description`, {
    method: "PATCH",
    headers: {
      origin,
      "x-csrf-token": "csrf-usage",
      "content-type": "application/json",
      "idempotency-key": "description:personal",
    },
    body: JSON.stringify({
      description: "Private durable preferences discussed with me.",
      expected_metadata_version: 2,
    }),
  }));
  assert.equal(description.status, 200);
  const descriptionBody = await description.json();
  assert.deepEqual(descriptionBody.data, {
    personal_mind: {
      route: "/me",
      name: "Product Owner",
      description: "Private durable preferences discussed with me.",
      metadata_version: 3,
    },
    replayed: false,
  });
  assert.deepEqual(descriptionCommands[0], {
    description: "Private durable preferences discussed with me.",
    expectedMetadataVersion: 2,
    idempotencyKey: "description:personal",
    mind_ref: "me",
  });
  assert.doesNotMatch(JSON.stringify(descriptionBody), /principal|space_|revision_|mind_id/iu);

  descriptionConflict = true;
  const staleDescription = await handler(new Request(`${origin}/api/v1/minds/me/description`, {
    method: "PATCH",
    headers: {
      origin,
      "x-csrf-token": "csrf-usage",
      "content-type": "application/json",
      "idempotency-key": "description:stale",
    },
    body: JSON.stringify({ description: null, expected_metadata_version: 2 }),
  }));
  assert.equal(staleDescription.status, 409);
  assert.equal((await staleDescription.json()).error.code, "metadata_conflict");
});

test("ordinary Mind list and exact route wire the UAT management and deletion controls", async () => {
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
      if (request.operation === "list_members") return {
        members: [
          { memberId: "membership_owner", displayName: "Product Owner", role: "owner", membershipVersion: 1, isSelf: true },
          { memberId: "membership_editor", displayName: "Editor & <Person>", role: "editor", membershipVersion: 1, isSelf: false },
        ],
      };
      if (request.operation === "list_invitations") return { invitations: [] };
      if (request.operation === "get_capacity_usage") return {
        kind: "found",
        usage: {
          logicalHeadBytes: 1_024,
          logicalRetainedBytes: 2_048,
          physicalCanonicalBytes: 1_536,
          temporaryBytes: 0,
          d1MetadataBytes: 4_096,
          reservedBytes: 0,
          storageAmplification: 1.5,
        },
        principalUsage: { physicalCanonicalBytes: 2_048 },
        mindCanonicalHeadroomBytes: 2_147_482_112,
        principalCanonicalHeadroomBytes: 8_589_932_544,
        utilization: "normal",
      };
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
  assert.match(listHtml, /aria-busy="true"/);
  assert.doesNotMatch(listHtml, /data-mind-card=/);

  const detail = await handler(new Request(`${origin}/research-notes`));
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /data-mind-route data-mind-handle="research-notes"[^>]*data-mind-visibility="private"/);
  assert.match(detailHtml, /data-owner-delete-controls/);
  assert.match(detailHtml, /data-owner-visibility-controls/);
  assert.match(detailHtml, /data-owner-transfer-controls/);
  assert.match(detailHtml, /data-markdown-import data-head-revision="revision_research"/);
  assert.match(detailHtml, /Snapshot replacement:/);
  assert.match(detailHtml, /data-export-workflow data-export-mind-ref="research-notes" data-export-route="\/research-notes"/);
  assert.match(detailHtml, /Target Mind:[\s\S]*Research Notes/);
  assert.match(detailHtml, /every current Markdown file omitted/);
  assert.match(detailHtml, /data-capacity-state="normal"/);
  assert.match(detailHtml, /Counts come from immutable manifest and job metadata/);
  assert.match(detailHtml, /Owner headroom/);
  assert.match(detailHtml, /data-invitations-membership-root/);
  assert.match(detailHtml, /<h2 id="collaboration-heading">Access<\/h2>/);
  assert.match(detailHtml, /data-access-summary/);
  assert.match(detailHtml, /data-invitation-form/);
  assert.match(detailHtml, /data-member-role-form/);
  assert.match(detailHtml, /data-membership-confirmation-dialog/);
  assert.match(detailHtml, /I reviewed the current participant, role, and access consequences/);
  const ownershipForm = /<form\b[^>]*data-ownership-transfer-form[^>]*>[\s\S]*?<\/form>/u.exec(detailHtml)?.[0];
  assert.ok(ownershipForm);
  assert.match(ownershipForm, /\bdata-source-membership-version="1"/u);
  const targetOption = [...ownershipForm.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gu)]
    .find((match) => /\bvalue="membership_editor"/u.test(match[1] ?? ""));
  assert.ok(targetOption);
  assert.match(targetOption[1], /\bvalue="membership_editor"/u);
  assert.match(targetOption[1], /\bdata-membership-version="1"/u);
  assert.match(targetOption[1], /\bdata-display-name="Editor &amp; &lt;Person&gt;"/u);
  assert.equal(targetOption[2], "Editor &amp; &lt;Person&gt; — Editor");
  assert.doesNotMatch(ownershipForm, /<Person>|<script|onerror=/u);
  assert.match(detailHtml, /mind-diary-ordinary-minds-client\.js/);

  const capacity = await handler(new Request(
    `${origin}/api/v1/minds/research-notes/capacity`,
  ));
  assert.equal(capacity.status, 200);
  const capacityBody = await capacity.json();
  assert.equal(capacityBody.data.kind, "found");
  assert.equal(capacityBody.data.usage.physical_canonical_bytes, 1_536);
  assert.equal(JSON.stringify(capacityBody).includes("path"), false);

  const asset = await handler(new Request(`${origin}/ui/mind-diary-ordinary-minds-client.js`));
  const ordinaryJavaScript = await asset.text();
  assert.match(ordinaryJavaScript, /export-jobs/);
  assert.match(ordinaryJavaScript, /MD-BUNDLE-ZIP-1/);
  assert.doesNotThrow(() => new vm.Script(ordinaryJavaScript));
  assert.equal(asset.status, 200);
  const assetBody = ordinaryJavaScript;
  assert.match(assetBody, /deletion-impact/);
  assert.match(assetBody, /delete-mind:/);
  assert.match(assetBody, /ownership-transfer/);
  assert.match(assetBody, /acknowledge_live_head_and_history_exposure/);
  assert.match(assetBody, /expected_invitation_version/);
  assert.match(assetBody, /expected_membership_version/);
  assert.match(assetBody, /Confirm access revocation/);
  assert.match(assetBody, /membership_version_conflict/);
  assert.match(assetBody, /Public visibility may still allow signed-in read access/);
  assert.match(assetBody, /route\?\.querySelectorAll\("button,input,select,textarea"\)/);
  assert.match(assetBody, /request\("GET","\/api\/v1\/minds"\)/);
  assert.match(assetBody, /validPersonalMind/);
  assert.match(assetBody, /createAttempt/);
  assert.match(assetBody, /metadataAttempt/);
  assert.match(assetBody, /description=createDescription\?\.value\.trim\(\)\|\|null/);
  assert.match(assetBody, /\{name,handle,description\}/);
  assert.match(assetBody, /description:renameForm\.elements\.description/);
  assert.match(assetBody, /markdown-import-plans/);
  assert.match(assetBody, /markdown-import-mind/);
  assert.match(assetBody, /history\.replaceState/);
  assert.doesNotMatch(assetBody, /localStorage/);
  assert.match(assetBody, /sessionStorage/);
  assert.match(assetBody, /`sha256:\$\{hex/);
  assert.match(assetBody, /descriptor_hash !== descriptorHash/);
  assert.match(assetBody, /Uploading bounded batches/);
  assert.match(assetBody, /promotion_checkpoint/);
  assert.doesNotThrow(() => new vm.Script(assetBody));

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

test("ordinary Mind detail uses one consistent read session when the control plane provides it", async () => {
  let sessions = 0;
  let escapedCalls = 0;
  const readControl = {
    execute(request) {
      if (request.operation === "get_mind_info") return ordinaryOwnerRoute;
      if (request.operation === "list_members") return {
        members: [{
          memberId: "membership_owner",
          displayName: "Product Owner",
          role: "owner",
          membershipVersion: 1,
          isSelf: true,
        }],
      };
      if (request.operation === "list_invitations") return { invitations: [] };
      if (request.operation === "get_capacity_usage") return {
        kind: "found",
        usage: {
          logicalHeadBytes: 1_024,
          logicalRetainedBytes: 2_048,
          physicalCanonicalBytes: 1_536,
          temporaryBytes: 0,
          d1MetadataBytes: 4_096,
          reservedBytes: 0,
          storageAmplification: 1.5,
        },
        principalUsage: { physicalCanonicalBytes: 2_048 },
        mindCanonicalHeadroomBytes: 2_147_482_112,
        principalCanonicalHeadroomBytes: 8_589_932_544,
        utilization: "normal",
      };
      throw new Error(`unexpected read operation: ${request.operation}`);
    },
  };
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: registeredActor,
      session: sessionProjection,
    }),
    csrf: { issue: () => "csrf-consistent", verify: () => true },
    control: {
      execute() {
        escapedCalls += 1;
        throw new Error("detail read escaped the consistent session");
      },
      withConsistentRead(operation) {
        sessions += 1;
        return operation(readControl);
      },
    },
  });

  const response = await handler(new Request(`${origin}/research-notes`));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data-mind-route data-mind-handle="research-notes"/u);
  assert.equal(sessions, 1);
  assert.equal(escapedCalls, 0);
});

test("Markdown import REST maps exact plan, resumable multipart checkpoints and terminal commands", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-import", verify: (_actor, token) => token === "csrf-import" },
    control: { execute(request) {
      calls.push(request);
      if (request.operation === "plan_markdown_import") return {
        kind: "planned",
        plan: { planId: "plan_import", expectedRevisionId: "revision_research", additions: 1 },
        replayed: false,
      };
      if (request.operation === "start_markdown_import") return {
        kind: "started",
        session: { importId: "import_one", state: "active", version: 1, checkpoint: 0 },
        replayed: false,
      };
      if (request.operation === "get_markdown_import") return {
        kind: "found",
        session: { importId: "import_one", state: "active", version: 1, checkpoint: 0 },
      };
      if (request.operation === "stage_markdown_import_batch") return {
        kind: "staged",
        session: { importId: "import_one", state: "active", version: 2, checkpoint: 1 },
        replayed: false,
      };
      if (request.operation === "validate_markdown_import") return {
        kind: "validated",
        session: { importId: "import_one", state: "validated", version: 3, checkpoint: 1 },
      };
      if (request.operation === "commit_markdown_import") return {
        kind: "committed", revisionId: "revision_imported", replayed: false,
      };
      if (request.operation === "cancel_markdown_import") return {
        kind: "canceled", session: { importId: "import_one", state: "canceled", version: 4 }, replayed: false,
      };
      throw Object.assign(new Error("unexpected operation"), { code: "not_found" });
    } },
  });
  const mutationHeaders = {
    origin,
    "x-csrf-token": "csrf-import",
    "content-type": "application/json",
  };

  const plan = await handler(new Request(`${origin}/api/v1/minds/research-notes/markdown-import-plans`, {
    method: "POST",
    headers: { ...mutationHeaders, "idempotency-key": "import-plan:12345678" },
    body: JSON.stringify({
      expected_revision_id: "revision_research",
      files: [{ path: "index.md", sha256: "a".repeat(64), size: 7 }],
    }),
  }));
  assert.equal(plan.status, 200);
  assert.equal((await plan.json()).data.plan.plan_id, "plan_import");
  assert.deepEqual(calls.at(-1).input, {
    expectedRevisionId: "revision_research",
    files: [{ path: "index.md", sha256: "a".repeat(64), size: 7 }],
    idempotencyKey: "import-plan:12345678",
    mind_ref: "research-notes",
  });

  const brainScaleFiles = Array.from({ length: 1_741 }, (_unused, index) => ({
    path: `concepts/note-${String(index).padStart(4, "0")}.md`,
    sha256: `sha256:${String(index).padStart(64, "0")}`,
    size: 3_264,
  }));
  const brainScaleBody = JSON.stringify({
    expected_revision_id: "revision_research",
    files: brainScaleFiles,
  });
  assert.ok(Buffer.byteLength(brainScaleBody) > 64 * 1024);
  const brainScalePlan = await handler(new Request(
    `${origin}/api/v1/minds/research-notes/markdown-import-plans`,
    {
      method: "POST",
      headers: { ...mutationHeaders, "idempotency-key": "import-plan:brain-scale" },
      body: brainScaleBody,
    },
  ));
  assert.equal(brainScalePlan.status, 200);
  assert.equal(calls.at(-1).input.files.length, 1_741);

  const oversizedPlan = await handler(new Request(
    `${origin}/api/v1/minds/research-notes/markdown-import-plans`,
    {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "content-length": String(16 * 1024 * 1024 + 1),
        "idempotency-key": "import-plan:oversized",
      },
      body: "{}",
    },
  ));
  assert.equal(oversizedPlan.status, 400);
  assert.equal((await oversizedPlan.json()).error.code, "invalid_request");

  await handler(new Request(`${origin}/api/v1/minds/research-notes/markdown-imports`, {
    method: "POST",
    headers: { ...mutationHeaders, "idempotency-key": "import-session:12345678" },
    body: JSON.stringify({ plan_id: "plan_import" }),
  }));
  assert.equal(calls.at(-1).operation, "start_markdown_import");
  assert.equal(calls.at(-1).input.planId, "plan_import");

  await handler(new Request(`${origin}/api/v1/markdown-imports/import_one`));
  assert.equal(calls.at(-1).operation, "get_markdown_import");
  assert.equal(calls.at(-1).input.import_id, "import_one");

  const multipart = new FormData();
  multipart.append("manifest", JSON.stringify({
    expected_version: 1,
    files: [{ field: "file_0", path: "index.md", sha256: "b".repeat(64), size: 7 }],
  }));
  multipart.append("file_0", new Blob(["# Mind\n"], { type: "text/markdown" }), "index.md");
  const batch = await handler(new Request(`${origin}/api/v1/markdown-imports/import_one/batches/1`, {
    method: "PUT",
    headers: { origin, "x-csrf-token": "csrf-import" },
    body: multipart,
  }));
  assert.equal(batch.status, 200);
  const batchCall = calls.at(-1);
  assert.equal(batchCall.operation, "stage_markdown_import_batch");
  assert.equal(batchCall.input.import_id, "import_one");
  assert.equal(batchCall.input.checkpoint, "1");
  assert.equal(batchCall.input.expectedVersion, 1);
  assert.equal(batchCall.input.files[0].path, "index.md");
  assert.equal(batchCall.input.files[0].bytes instanceof Uint8Array, true);
  assert.equal(new TextDecoder().decode(batchCall.input.files[0].bytes), "# Mind\n");

  for (const [method, suffix, operation, body] of [
    ["POST", "validate", "validate_markdown_import", { expected_version: 2 }],
    ["POST", "commit", "commit_markdown_import", { expected_version: 3, summary: "Import" }],
    ["DELETE", "", "cancel_markdown_import", { expected_version: 3 }],
  ]) {
    const response = await handler(new Request(
      `${origin}/api/v1/markdown-imports/import_one${suffix ? `/${suffix}` : ""}`,
      { method, headers: mutationHeaders, body: JSON.stringify(body) },
    ));
    assert.equal(response.status, 200, operation);
    assert.equal(calls.at(-1).operation, operation);
    assert.equal(calls.at(-1).input.expectedVersion, body.expected_version);
  }

  const before = calls.length;
  const deniedBatch = await handler(new Request(`${origin}/api/v1/markdown-imports/import_one/batches/2`, {
    method: "PUT",
    headers: { origin, "x-csrf-token": "wrong" },
    body: new FormData(),
  }));
  assert.equal(deniedBatch.status, 403);
  assert.equal(calls.length, before);

  const oversizedBatch = await handler(new Request(
    `${origin}/api/v1/markdown-imports/import_one/batches/2`,
    {
      method: "PUT",
      headers: {
        origin,
        "x-csrf-token": "csrf-import",
        "content-type": "multipart/form-data; boundary=bounded-import-test",
      },
      body: new Uint8Array(5 * 1024 * 1024 + 1),
    },
  ));
  assert.equal(oversizedBatch.status, 400);
  assert.equal(calls.length, before);
});

test("Sites export REST maps exact revision/profile and keeps idempotency in the header", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-export", verify: (_actor, token) => token === "csrf-export" },
    control: { execute(request) {
      calls.push(request);
      return request.operation === "start_export"
        ? {
            job: {
              jobId: "export_one",
              status: "queued",
              revisionId: "revision_historical",
              createdAt: "2026-08-27T20:00:00.000Z",
            },
            replayed: false,
          }
        : {
            job: {
              jobId: "export_one",
              status: "succeeded",
              revisionId: "revision_historical",
              sha256: `sha256:${"a".repeat(64)}`,
              size: 123,
            },
          };
    } },
  });

  const start = await handler(new Request(`${origin}/api/v1/minds/research-notes/exports`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-csrf-token": "csrf-export",
      "idempotency-key": "export:historical",
    },
    body: JSON.stringify({
      revision_selector: { kind: "revision", revision_id: "revision_historical" },
      profile: "MD-BUNDLE-ZIP-1",
    }),
  }));
  assert.equal(start.status, 202);
  assert.deepEqual(calls.at(-1), {
    operation: "start_export",
    actor: registeredActor,
    input: {
      revisionSelector: { kind: "revision", revisionId: "revision_historical" },
      profile: "MD-BUNDLE-ZIP-1",
      idempotencyKey: "export:historical",
      mind_ref: "research-notes",
    },
  });

  const bodyKey = await handler(new Request(`${origin}/api/v1/minds/research-notes/exports`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-csrf-token": "csrf-export",
      "idempotency-key": "export:header",
    },
    body: JSON.stringify({ idempotency_key: "export:body" }),
  }));
  assert.equal(bodyKey.status, 400);
  assert.equal(calls.length, 1);

  const status = await handler(new Request(`${origin}/api/v1/export-jobs/export_one`));
  assert.equal(status.status, 200);
  assert.equal(calls.at(-1).operation, "get_export_status");
  assert.deepEqual(calls.at(-1).input, { job_id: "export_one" });
  const statusBody = await status.json();
  assert.equal(statusBody.data.job.revision_id, "revision_historical");
  assert.equal(statusBody.data.job.size, 123);
});

test("collaboration pages expose safe invitation metadata and map every browser action to server-owned commands", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-collaboration", verify: (_actor, token) => token === "csrf-collaboration" },
    control: { execute(request) {
      calls.push(request);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "get_invitations_overview") return {
        invitations: [
          {
            invitationId: "invitation_incoming",
            mindId: "space_external",
            mindName: "External Collaboration",
            mindRoute: "/external-collaboration",
            direction: "incoming",
            counterpartyDisplayName: "External Owner",
            proposedRole: "editor",
            state: "pending",
            expiresAt: "2026-08-17T00:00:00.000Z",
            invitationVersion: 2,
            targetVerifiedEmail: "must-not-render@example.com",
            principalId: "principal_must_not_render",
          },
          {
            invitationId: "invitation_outgoing",
            mindId: "space_research",
            mindName: "Research Notes",
            mindRoute: "/research-notes",
            direction: "outgoing",
            counterpartyDisplayName: "Invited Person",
            proposedRole: "reader",
            state: "expired",
            expiresAt: "2026-08-09T00:00:00.000Z",
            invitationVersion: 3,
          },
        ],
      };
      return { applied: true };
    } },
  });

  const page = await handler(new Request(`${origin}/invitations`));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-people-collection/);
  assert.match(html, /Loading participants and invitations/);
  assert.doesNotMatch(html, /External Collaboration|Research Notes/);
  assert.doesNotMatch(html, /must-not-render@example\.com|principal_must_not_render/);
  assert.equal(calls.filter(({ operation }) => operation === "get_invitations_overview").length, 0);

  const overview = await handler(new Request(`${origin}/api/v1/invitations-overview`));
  assert.equal(overview.status, 200);
  const overviewPayload = await overview.json();
  assert.equal(overviewPayload.data.invitations.length, 1);
  assert.equal(overviewPayload.data.invitations[0].direction, "incoming");
  assert.equal(overviewPayload.data.invitations[0].mind_route, "/external-collaboration");
  assert.equal(JSON.stringify(overviewPayload).includes("invitation_outgoing"), false);
  assert.equal(JSON.stringify(overviewPayload).includes("must-not-render@example.com"), false);
  assert.equal(JSON.stringify(overviewPayload).includes("principal_must_not_render"), false);
  assert.equal(calls.filter(({ operation }) => operation === "get_invitations_overview").length, 1);
  assert.equal(calls.some(({ operation }) => operation === "list_minds"), false);
  assert.equal(calls.some(({ operation }) => operation === "list_invitations"), false);

  const asset = await handler(new Request(`${origin}/ui/mind-diary-collaboration-client.js`));
  assert.equal(asset.status, 200);
  const collaborationClient = await asset.text();
  assert.match(collaborationClient, /registered_principal_not_found/);
  assert.match(collaborationClient, /api\/v1\/invitations-overview/);
  assert.match(collaborationClient, /data-invitation-action/);
  assert.match(collaborationClient, /exactEmail/);

  const cases = [
    ["POST", "/api/v1/minds/research-notes/invitations", {
      target_verified_email: "person@example.com",
      role: "editor",
      expected_metadata_version: 7,
    }, "create_invitation"],
    ["POST", "/api/v1/invitations/invitation_incoming/accept", {
      expected_invitation_version: 2,
    }, "accept_invitation"],
    ["POST", "/api/v1/invitations/invitation_incoming/reject", {
      expected_invitation_version: 2,
    }, "reject_invitation"],
    ["DELETE", "/api/v1/invitations/invitation_outgoing", {
      expected_invitation_version: 3,
    }, "cancel_invitation"],
    ["POST", "/api/v1/invitations/invitation_outgoing/reissue", {
      expected_invitation_version: 3,
    }, "reissue_invitation"],
    ["PATCH", "/api/v1/minds/research-notes/members/membership_editor", {
      role: "reader",
      expected_membership_version: 4,
    }, "change_membership_role"],
    ["DELETE", "/api/v1/minds/research-notes/members/membership_editor", {
      expected_membership_version: 5,
    }, "revoke_membership"],
    ["POST", "/api/v1/minds/research-notes/leave", {
      expected_membership_version: 6,
    }, "leave_space"],
  ];
  for (const [method, path, body, operation] of cases) {
    const response = await handler(new Request(`${origin}${path}`, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        "x-csrf-token": "csrf-collaboration",
        "idempotency-key": `collaboration:${operation}`,
      },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200, operation);
    const call = calls.at(-1);
    assert.equal(call.operation, operation);
    assert.equal(call.input.idempotencyKey, `collaboration:${operation}`);
  }
  assert.deepEqual(calls.at(-1).input, {
    expectedMembershipVersion: 6,
    idempotencyKey: "collaboration:leave_space",
    mind_ref: "research-notes",
  });
});

test("token controls preserve CSRF and expose a one-time secret only in the issuance response", async () => {
  const calls = [];
  const personalTokenRef = `ptok_v1_${"2".repeat(32)}`;
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ui", verify: (_actor, token) => token === "csrf-ui" },
    control: { execute(request) {
      calls.push(request);
      if (request.operation === "issue_mcp_token") return {
        token: { personalTokenRef, displayPrefix: "mdp_v1_Safe12…" },
        secret: "synthetic-show-once-value",
      };
      if (request.operation === "revoke_personal_token") return {
        token: { personalTokenRef, state: "revoked" },
        replayed: false,
      };
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
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const issuedBody = await issued.json();
  assert.equal(issuedBody.data.secret, "synthetic-show-once-value");
  assert.equal(issuedBody.data.token.personal_token_ref, personalTokenRef);
  assert.equal(JSON.stringify(issuedBody).includes("token_id"), false);
  assert.equal(JSON.stringify(issuedBody).includes("tok_created"), false);
  assert.equal(calls[0].input.idempotencyKey, "token:12345678");

  const revoked = await handler(new Request(`${origin}/api/v1/mcp-tokens/${personalTokenRef}`, {
    method: "DELETE",
    headers: { origin, "x-csrf-token": "csrf-ui", "idempotency-key": "revoke:12345678" },
  }));
  assert.equal(revoked.status, 200);
  const revokedBody = await revoked.json();
  assert.equal(calls[1].operation, "revoke_personal_token");
  assert.equal(calls[1].input.personal_token_ref, personalTokenRef);
  assert.equal("token_id" in calls[1].input, false);
  assert.equal(JSON.stringify(revokedBody).includes("token_id"), false);
});

test("Connections expose credential scopes only and reject retired per-credential Mind mutations", async () => {
  let targetReads = 0;
  let targetMutations = 0;
  const connectionRef = `conn_v1_${"3".repeat(32)}`;
  const bindingOwnerId = "md_oauth_grant_internal_must_not_render";
  const oauthConnection = Object.freeze({
    connectionRef,
    bindingOwnerId,
    clientName: "Codex Marketplace",
    scopes: Object.freeze(["content:read", "content:write"]),
    createdAt: "2026-08-08T00:00:00.000Z",
    lastUsedAt: null,
  });
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-target", verify: (_actor, token) => token === "csrf-target" },
    control: { execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      throw Object.assign(new Error("unexpected operation"), { code: "not_found" });
    } },
    oauthConnections: {
      async listPage(principalId) {
        assert.equal(principalId, registeredActor.principalId);
        return { items: [oauthConnection], nextCursor: null };
      },
      async read(principalId, presentedRef) {
        assert.equal(principalId, registeredActor.principalId);
        return presentedRef === connectionRef ? oauthConnection : null;
      },
      async revoke() { return true; },
    },
    writableTargets: {
      async listResolved() { targetReads += 1; return []; },
      async mutateResolved() { targetMutations += 1; throw new Error("retired"); },
    },
  });

  const collection = await handler(new Request(`${origin}/api/v1/connections`));
  assert.equal(collection.status, 200);
  const collectionBody = await collection.json();
  assert.deepEqual(collectionBody.data.items[0], {
    connection_ref: connectionRef,
    client_name: "Codex Marketplace",
    created_at: "2026-08-08T00:00:00.000Z",
    last_used_at: null,
    can_read: true,
    can_write: true,
  });
  assert.equal(JSON.stringify(collectionBody).includes(bindingOwnerId), false);
  assert.doesNotMatch(JSON.stringify(collectionBody), /mind_(?:count|selected)|target|binding/iu);

  const detail = await handler(new Request(`${origin}/settings/connections/${connectionRef}`));
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Credential scopes/);
  assert.match(detailHtml, /Mind modes belong to your account/);
  assert.match(detailHtml, /shared by all your Connections and personal tokens|Every Connection and personal token sees the same configured/u);
  assert.match(detailHtml, /href="\/minds#mind-usage-heading"/);
  assert.doesNotMatch(detailHtml, /data-access-action|mind-access|select_write|clear_write|attach_read|detach_read|writable target|binding-version/iu);
  assert.doesNotMatch(detailHtml, /md_oauth_grant_internal_must_not_render|space_(?:personal|research)/);

  const removed = await handler(new Request(`${origin}/api/v1/connections/${connectionRef}/mind-access`, {
    method: "PATCH",
    headers: {
      origin,
      "x-csrf-token": "csrf-target",
      "content-type": "application/json",
      "idempotency-key": "target:removed-read",
    },
    body: JSON.stringify({ action: "attach_read", mind_ref: "/me", expected_target_version: 8 }),
  }));
  assert.equal(removed.status, 404);
  assert.equal((await removed.json()).error.code, "not_found");
  assert.equal(targetReads, 0);
  assert.equal(targetMutations, 0);
});

test("connection lookup makes unknown, foreign, and revoked presentation refs indistinguishable", async () => {
  const refs = ["7", "8", "9"].map((digit) => `conn_v1_${digit.repeat(32)}`);
  const reads = [];
  let bindingReads = 0;
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-missing-connection", verify: () => true },
    control: { execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      throw new Error("hidden state must not be read");
    } },
    oauthConnections: {
      async listPage() { return { items: [], nextCursor: null }; },
      async read(principalId, connectionRef) {
        reads.push({ principalId, connectionRef });
        return null;
      },
      async revoke() { throw new Error("must not revoke"); },
    },
    writableTargets: {
      async listResolved() { bindingReads += 1; return []; },
      async mutateResolved() { throw new Error("must not mutate"); },
    },
  });

  for (const connectionRef of refs) {
    const ui = await handler(new Request(`${origin}/settings/connections/${connectionRef}`));
    assert.equal(ui.status, 404);
    assert.equal((await ui.json()).error.code, "connection_not_found");
    const api = await handler(new Request(`${origin}/api/v1/connections/${connectionRef}`));
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error.code, "connection_not_found");
  }
  assert.deepEqual(reads.map((read) => read.principalId), Array(6).fill(registeredActor.principalId));
  assert.deepEqual(reads.map((read) => read.connectionRef), refs.flatMap((ref) => [ref, ref]));
  assert.equal(bindingReads, 0);
});

test("connection pages stay bounded to the requested page and reject ambiguous list queries", async () => {
  const refs = ["a", "b"].map((digit) => `conn_v1_${digit.repeat(32)}`);
  const ownerIds = ["page_owner_a", "page_owner_b"];
  const listCalls = [];
  const bindingCalls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-page", verify: () => true },
    control: { execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_minds") return [personalRoute];
      throw new Error("unexpected operation");
    } },
    oauthConnections: {
      async listPage(principalId, query) {
        listCalls.push({ principalId, query });
        return {
          items: refs.map((connectionRef, index) => ({
            connectionRef,
            bindingOwnerId: ownerIds[index],
            clientName: `Codex ${index + 1}`,
            scopes: ["content:read"],
            createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
            lastUsedAt: null,
          })),
          nextCursor: "next_page_cursor",
        };
      },
      async read() { return null; },
      async revoke() { return false; },
    },
    writableTargets: {
      async listResolved(_actor, credentials) {
        bindingCalls.push(credentials);
        return credentials.map((credential) => ({
          ownerId: credential.ownerId,
          credentialKind: credential.credentialKind,
          lifecycleState: "active",
          targetVersion: 0,
          targetMindId: null,
        }));
      },
      async mutateResolved() { throw new Error("unused"); },
    },
  });

  const page = await handler(new Request(`${origin}/api/v1/connections?limit=2&cursor=page_cursor`));
  assert.equal(page.status, 200);
  const pageBody = await page.json();
  assert.deepEqual(pageBody.data.items.map((item) => item.connection_ref), refs);
  assert.equal(pageBody.data.next_cursor, "next_page_cursor");
  assert.equal(JSON.stringify(pageBody).includes("page_owner_"), false);
  assert.deepEqual(bindingCalls, []);
  assert.deepEqual(listCalls[0], {
    principalId: registeredActor.principalId,
    query: { limit: 2, cursor: "page_cursor" },
  });

  for (const path of [
    "/api/v1/connections?state=active",
    "/api/v1/connections?limit=0",
    "/api/v1/connections?limit=2.5",
    "/api/v1/connections?limit=51",
    "/api/v1/connections?limit=2&limit=3",
    "/api/v1/connections?cursor=%2F",
    "/settings/connections?unknown=1",
    "/settings/developer/mcp?state=unknown",
  ]) {
    const invalid = await handler(new Request(`${origin}${path}`));
    assert.equal(invalid.status, 400, path);
    assert.equal((await invalid.json()).error.code, "invalid_request", path);
  }
  assert.equal(listCalls.length, 1);
});

test("product UI keeps control read failures generic and still offers bounded retry states", async () => {
  const tokenListFailure = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-ui", verify: () => true },
    control: { execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      throw new Error("unexpected control operation");
    } },
    personalTokens: {
      async listPage() { throw new Error("private token table diagnostic"); },
      async read() { return null; },
    },
    writableTargets: {
      async listResolved() { return []; },
      async mutateResolved() { throw new Error("unused"); },
    },
  });
  const tokens = await tokenListFailure(new Request(`${origin}/settings/developer/mcp`));
  assert.equal(tokens.status, 200);
  const tokenHtml = await tokens.text();
  assert.match(tokenHtml, /Reload before using a personal token\./);
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
  assert.match(registrationHtml, /data-uat-pilot-boundaries/);
  assert.match(registrationHtml, /no production SLA, guaranteed recovery/u);
  assert.match(registrationHtml, /Export an exact revision before risky changes/u);
  assert.match(registrationHtml, /Never share an MCP token, Sites credential/u);
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

test("one-use BundleFile route serves exact headers and hides malformed or ranged requests", async () => {
  const seen = [];
  const handler = createProductBundleFileDownloadHttpHandler({
    async download(secret) {
      seen.push(secret);
      if (secret === "mdg_v1_throw") throw new Error("private download failure");
      return secret === "mdg_v1_valid"
        ? {
            kind: "download",
            headers: {
              "Content-Type": "image/png",
              "Content-Length": "3",
              "Content-Disposition": "inline; filename=\"image.png\"; filename*=UTF-8''image.png",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(Uint8Array.from([1, 2, 3]));
                controller.close();
              },
            }),
          }
        : { kind: "not_found" };
    },
  });
  assert.equal(await handler(new Request(`${origin}/api/other`)), null);
  const found = await handler(new Request(`${origin}/api/bundle-download/mdg_v1_valid`));
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("content-type"), "image/png");
  assert.equal(found.headers.get("content-disposition"),
    "inline; filename=\"image.png\"; filename*=UTF-8''image.png");
  assert.deepEqual(new Uint8Array(await found.arrayBuffer()), Uint8Array.from([1, 2, 3]));

  for (const request of [
    new Request(`${origin}/api/bundle-download/mdg_v1_missing`),
    new Request(`${origin}/api/bundle-download/mdg_v1_valid`, {
      headers: { range: "bytes=0-1" },
    }),
    new Request(`${origin}/api/bundle-download/mdg_v1_valid`, { method: "POST" }),
    new Request(`${origin}/api/bundle-download/mdg_v1_%2Fescape`),
    new Request(`${origin}/api/bundle-download/mdg_v1_throw`),
  ]) {
    const response = await handler(request);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /private|secret|range/iu);
  }
  assert.deepEqual(seen, ["mdg_v1_valid", "mdg_v1_missing", "mdg_v1_throw"]);
});

test("product MCP facade advertises only canonical content tools and current-access roots", async () => {
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
      async getMindInfo() {
        return {
          mind: { mindId: "space_one", name: "Mine" },
          resolvedRevision: { revisionId: "revision_one" },
          contentCapabilities: ["browse", "commit", "export"],
        };
      },
    },
    bindings: {
      async read() {
        return {
          kind: "ready",
          bindings: {
            bindingSet: {
              state: "active",
              bindingVersion: 1,
              automaticCaptureMode: "disabled",
              captureWriteBindingId: null,
              captureUpdatedAt: null,
            },
            readBindings: [{
              readBindingId: "read_one",
              bindingOwnerId: "binding_owner_one",
              spaceId: "space_one",
              state: "active",
            }],
            writeBinding: null,
          },
        };
      },
      async mutateRead() { return { kind: "invalid" }; },
      async mutateWrite() { return { kind: "invalid" }; },
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
    capture: { async capture() { return { kind: "capture_disabled" }; } },
    exports: { async start() { return { kind: "denied" }; }, async getStatus() { return { kind: "not_found" }; } },
  });
  const actor = {
    ...registeredActor,
    authentication: {
      kind: "mcp_token",
      tokenId: "token_one",
      bindingOwnerId: "binding_owner_one",
      scopes: ["content:read"],
    },
  };
  const tools = await application.listTools({ actor });
  assert.deepEqual(
    tools.map(({ name }) => name),
    MCP_TOOL_DEFINITIONS
      .filter(({ name }) =>
        name !== "create_file_upload_intent" &&
        name !== "stage_bundle_file" &&
        name !== "open_bundle_file_picker")
      .map(({ name }) => name),
  );
  assert.equal(tools.some(({ name }) => String(name).includes("member") || String(name).includes("token")), false);
  const roots = await application.listRootResources({ actor });
  assert.deepEqual(
    roots.resources.map(({ uri }) => uri),
    [
      "okf://spaces/space_one/revisions/revision_one/index",
      "okf://spaces/space_public/revisions/revision_one/index",
    ],
  );
});
