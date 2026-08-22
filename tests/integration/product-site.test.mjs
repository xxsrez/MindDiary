import test from "node:test";
import assert from "node:assert/strict";
import {
  createProductBundleFileDownloadHttpHandler,
  createProductExportDownloadHttpHandler,
  createProductWebHttpHandler,
  resolveProductSitesIdentity,
} from "../../packages/adapter-web/dist/index.js";
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
  for (const path of ["/", "/me", "/minds", "/public", "/invitations", "/settings/account", "/settings/mcp", "/help", "/unknown-handle"]) {
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
  assert.match(rootHtml, /rel="icon" href="\/favicon\.ico" sizes="16x16 32x32"/);
  assert.match(rootHtml, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any"/);
  assert.match(rootHtml, /rel="icon" href="\/favicon-32x32\.png" type="image\/png" sizes="32x32"/);
  assert.match(rootHtml, /rel="apple-touch-icon" href="\/apple-touch-icon\.png" type="image\/png" sizes="180x180"/);
  assert.doesNotMatch(rootHtml, /principal_one|revision_personal/);

  const tokens = await handler(new Request(`${origin}/settings/mcp`));
  assert.equal(tokens.status, 200);
  const tokenHtml = await tokens.text();
  assert.match(tokenHtml, /data-mind-diary-token-management/);
  assert.match(tokenHtml, /Codex on Mac/);
  assert.match(tokenHtml, /mdp_v1_Abc123…/);
  assert.match(tokenHtml, /mind-diary-token-client\.js/);
  assert.match(tokenHtml, /https:\/\/mind-diary\.example\/api\/mcp\/2025-11-25/);
  assert.match(tokenHtml, /https:\/\/mind-diary\.example\/api\/mcp/);
  assert.match(tokenHtml, /data-run-mcp-self-check disabled/);
  assert.match(tokenHtml, /Preview, restore and export with Codex/);
  assert.match(tokenHtml, /data-copy-code="mind-diary-safe-write-playbook"/);
  assert.match(tokenHtml, /data-copy-code="mind-diary-restore-export-playbook"/);
  assert.match(tokenHtml, /data-copy-code="mind-diary-starter-playbook"/);
  assert.match(tokenHtml, /data-copy-code="mind-diary-concierge-playbook"/);
  assert.match(tokenHtml, /Start one valid Mind with Codex/);
  assert.match(tokenHtml, /A restore is an ordinary confirmed changeset that creates a new HEAD/);
  assert.match(tokenHtml, /Download URLs and credentials are bearer material/);
  assert.doesNotMatch(tokenHtml, /&lt;your-mind-diary-site&gt;/);
  assert.doesNotMatch(tokenHtml, /synthetic-show-once-value|verifier|principal_one/i);

  for (const [path, contentType, marker] of [
    ["/favicon.svg", "image/svg+xml; charset=utf-8", "#6C4BB6"],
    ["/ui/mind-diary-shell.css", "text/css; charset=utf-8", "md-token-grid"],
    ["/brand/mind-diary-lockup.svg", "image/svg+xml; charset=utf-8", "Mind Diary logo"],
    ["/ui/mind-diary-onboarding-client.js", "text/javascript; charset=utf-8", "/api/v1/account"],
    ["/ui/mind-diary-token-client.js", "text/javascript; charset=utf-8", "/api/mcp/2025-11-25"],
    ["/ui/mind-diary-visibility-client.js", "text/javascript; charset=utf-8", "data-public-catalog-retry"],
  ]) {
    const response = await handler(new Request(`${origin}${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.match(await response.text(), new RegExp(marker.replaceAll("/", "\\/")));
  }
  const hostedShellCss = await (await handler(new Request(`${origin}/ui/mind-diary-shell.css`))).text();
  assert.match(hostedShellCss, /\.md-setup-card--single\{grid-template-columns:minmax\(0,1fr\)\}/u);
  assert.match(hostedShellCss, /\.md-setup-card pre\{[^}]*max-width:100%[^}]*overflow:auto[^}]*white-space:pre-wrap[^}]*overflow-wrap:anywhere/u);
  assert.match(hostedShellCss, /@media\(max-width:52rem\)/u);
  assert.match(hostedShellCss, /\.md-setup-card\{grid-template-columns:minmax\(0,1fr\)\}/u);
  for (const [path, contentType, expectedDimensions] of [
    ["/favicon-32x32.png", "image/png", [32, 32]],
    ["/apple-touch-icon.png", "image/png", [180, 180]],
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
  assert.deepEqual(calls, ["get_session", "list_minds", "get_session", "list_mcp_tokens"]);
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
  assert.match(html, /data-identity-recovery-handoff/);
  assert.match(html, /same trusted channel that admitted you/);
  assert.match(html, /data-account-deletion-impact/);
  assert.match(html, /Research Notes/);
  assert.match(html, /Memberships[\s\S]*<h3>2<\/h3>/);
  assert.match(html, /Pending invitations[\s\S]*<h3>1<\/h3>/);
  assert.match(html, /Active MCP tokens[\s\S]*<h3>3<\/h3>/);
  assert.match(html, /mind-diary-account-client\.js/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /must-not-render@example\.com|PRIVATE ACCOUNT CONTENT|principal_one|revision_personal/);

  const asset = await handler(new Request(`${origin}/ui/mind-diary-account-client.js`));
  assert.equal(asset.status, 200);
  const assetBody = await asset.text();
  assert.match(assetBody, /DELETE","\/api\/v1\/account"/);
  assert.match(assetBody, /deletion_impact_changed/);
  assert.match(assetBody, /Retry sends the exact same deletion command/);
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
  assert.match(staleHtml, /A fresh deletion preview is required/);
  assert.match(staleHtml, /data-refresh-deletion-impact/);
  assert.doesNotMatch(staleHtml, /data-account-deletion-form/);
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
  });

  const routeMap = [
    ["/", /<title>Home — Mind Diary UAT<\/title>/],
    ["/me", /<h1>My Mind<\/h1>/],
    ["/minds", /data-management-view="list"/],
    ["/research-notes", /data-mind-handle="research-notes"/],
    ["/public", /data-mind-diary-visibility-catalog/],
    ["/invitations", /data-global-invitations/],
    ["/settings/account", /data-mind-diary-account-deletion/],
    ["/settings/mcp", /data-mind-diary-token-management/],
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
    assert.match(html, /href="\/settings\/mcp"/, path);
    assert.match(html, /href="\/help"/, path);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1, path);
    assert.doesNotMatch(html, /owner-only production Site|current Site is production/i, path);
  }

  const help = await handler(new Request(`${origin}/help`));
  const helpHtml = await help.text();
  assert.match(helpHtml, /no production SLA or guaranteed recovery/u);
  assert.match(helpHtml, /Keep your own export before risky work/u);
  assert.match(helpHtml, /Report only the symptom, UTC time, and safe request ID/u);
  assert.match(helpHtml, /data-copy-ready-guide="mind-diary-help-starter-playbook"/u);
  assert.match(helpHtml, /data-copy-code="mind-diary-help-concierge-playbook"/u);
  assert.match(helpHtml, /exactly one target/u);
  assert.match(helpHtml, /concierge work, not a product import/u);

  for (const path of ["/api", "/mcp", "/settings", "/settings/unknown", "/minds/extra"]) {
    assert.equal(await handler(new Request(`${origin}${path}`)), null, path);
  }
  const missingMind = await handler(new Request(`${origin}/unknown-handle`));
  assert.equal(missingMind.status, 200);
  const missingHtml = await missingMind.text();
  assert.match(missingHtml, /Mind settings unavailable/);
  assert.doesNotMatch(missingHtml, /not found|principal_one|space_research/i);
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
          { memberId: "membership_editor", displayName: "Editor Person", role: "editor", membershipVersion: 1, isSelf: false },
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
  assert.match(listHtml, /data-mind-card="research-notes"/);
  assert.match(listHtml, /href="\/research-notes"[^>]*data-manage-mind/);
  assert.doesNotMatch(listHtml, /data-mind-card="me"/);

  const detail = await handler(new Request(`${origin}/research-notes`));
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /data-mind-route data-mind-handle="research-notes"/);
  assert.match(detailHtml, /data-owner-delete-controls/);
  assert.match(detailHtml, /data-owner-visibility-controls/);
  assert.match(detailHtml, /data-owner-transfer-controls/);
  assert.match(detailHtml, /data-capacity-state="normal"/);
  assert.match(detailHtml, /Counts come from immutable manifest and job metadata/);
  assert.match(detailHtml, /Owner headroom/);
  assert.match(detailHtml, /data-invitations-membership-root/);
  assert.match(detailHtml, /Participants and invitations/);
  assert.match(detailHtml, /data-invitation-form/);
  assert.match(detailHtml, /data-member-role-form/);
  assert.match(detailHtml, /value="membership_editor">Editor Person — Editor/);
  assert.match(detailHtml, /mind-diary-ordinary-minds-client\.js/);
  assert.doesNotMatch(detailHtml, /revision_research/);

  const capacity = await handler(new Request(
    `${origin}/api/v1/minds/research-notes/capacity`,
  ));
  assert.equal(capacity.status, 200);
  const capacityBody = await capacity.json();
  assert.equal(capacityBody.data.kind, "found");
  assert.equal(capacityBody.data.usage.physical_canonical_bytes, 1_536);
  assert.equal(JSON.stringify(capacityBody).includes("path"), false);

  const asset = await handler(new Request(`${origin}/ui/mind-diary-ordinary-minds-client.js`));
  assert.equal(asset.status, 200);
  const assetBody = await asset.text();
  assert.match(assetBody, /deletion-impact/);
  assert.match(assetBody, /delete-mind:/);
  assert.match(assetBody, /ownership-transfer/);
  assert.match(assetBody, /acknowledge_live_head_and_history_exposure/);
  assert.match(assetBody, /expected_invitation_version/);
  assert.match(assetBody, /expected_membership_version/);

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

test("collaboration pages expose safe invitation metadata and map every browser action to server-owned commands", async () => {
  const calls = [];
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-collaboration", verify: (_actor, token) => token === "csrf-collaboration" },
    control: { execute(request) {
      calls.push(request);
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_minds") return [personalRoute, ordinaryOwnerRoute];
      if (request.operation === "list_invitations") return {
        invitations: [
          {
            invitationId: "invitation_incoming",
            mindId: "space_external",
            mindName: "External Collaboration",
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
  assert.match(html, /data-global-invitations/);
  assert.match(html, /External Collaboration/);
  assert.match(html, /Research Notes/);
  assert.match(html, /href="\/research-notes"/);
  assert.match(html, /data-invitation-action="accept"/);
  assert.match(html, /data-invitation-action="reject"/);
  assert.match(html, /data-invitation-action="reissue"/);
  assert.doesNotMatch(html, /must-not-render@example\.com|principal_must_not_render/);

  const asset = await handler(new Request(`${origin}/ui/mind-diary-collaboration-client.js`));
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /registered_principal_not_found/);

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

test("Product Site projects and mutates exact credential bindings with CSRF, CAS, and inaccessible-Mind redaction", async () => {
  const bindingCalls = [];
  let conflict = false;
  const handler = createProductWebHttpHandler({
    applicationOrigin: origin,
    resolveIdentity: () => ({ kind: "authenticated", actor: registeredActor }),
    csrf: { issue: () => "csrf-bindings", verify: (_actor, token) => token === "csrf-bindings" },
    control: { execute(request) {
      if (request.operation === "get_session") return sessionProjection;
      if (request.operation === "list_mcp_tokens") return [{
        tokenId: "tok_binding",
        name: "Bound Codex",
        displayPrefix: "mdp_v1_Abc123…",
        scopes: ["content:read", "content:write"],
        state: "active",
        createdAt: "2026-08-08T00:00:00.000Z",
        expiresAt: "2026-11-06T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      }];
      if (request.operation === "list_minds") return [personalRoute, {
        ...ordinaryOwnerRoute,
        visibility: "unlisted",
      }];
      throw Object.assign(new Error("unexpected operation"), { code: "not_found" });
    } },
    mindBindings: {
      async list(actor, ownerIds) {
        assert.equal(actor, registeredActor);
        assert.deepEqual(ownerIds, ["tok_binding"]);
        return [{
          ownerId: "tok_binding",
          bindingVersion: 8,
          state: "active",
          readBindings: [
            { readBindingId: "read-binding-personal", mindId: "space_personal" },
            { readBindingId: "read-binding-hidden", mindId: "space_hidden" },
          ],
          writeBinding: { writeBindingId: "write-binding-research", mindId: "space_research" },
          automaticCapture: {
            mode: "disabled",
            writeBindingId: null,
            updatedAt: null,
          },
        }];
      },
      async mutate(actor, input) {
        bindingCalls.push({ actor, input });
        if (conflict) {
          throw Object.assign(new Error("stale"), { code: "binding_version_conflict" });
        }
        return { changed: true, replayed: false, bindingVersion: 9 };
      },
    },
  });

  const page = await handler(new Request(`${origin}/settings/mcp`));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Bound Codex/);
  assert.match(html, /Version 8/);
  assert.match(html, /Product Owner[\s\S]*\/me[\s\S]*private/);
  assert.match(html, /Research Notes[\s\S]*\/research-notes[\s\S]*unlisted/);
  assert.match(html, /Access unavailable/);
  assert.match(html, /data-binding-action="detach_read"/);
  assert.match(html, /data-binding-form="bind_write"/);
  assert.match(html, /Automatic knowledge capture/);
  assert.match(html, /available only while the writable Mind is private/);
  assert.match(html, /data-binding-action="enable_capture"[^>]*disabled/);
  assert.doesNotMatch(html, /space_hidden|space_personal|space_research/);

  const denied = await handler(new Request(`${origin}/api/v1/mind-bindings/tok_binding`, {
    method: "PATCH",
    headers: { origin, "x-csrf-token": "wrong", "content-type": "application/json" },
    body: JSON.stringify({ action: "bind_write", mind_ref: "/research-notes", expected_binding_version: 8 }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(bindingCalls.length, 0);

  const applied = await handler(new Request(`${origin}/api/v1/mind-bindings/tok_binding`, {
    method: "PATCH",
    headers: {
      origin,
      "x-csrf-token": "csrf-bindings",
      "content-type": "application/json",
      "idempotency-key": "binding:product-site",
    },
    body: JSON.stringify({
      action: "bind_write",
      mind_ref: "/research-notes",
      expected_binding_version: 8,
    }),
  }));
  assert.equal(applied.status, 200);
  assert.deepEqual((await applied.json()).data, {
    changed: true,
    replayed: false,
    binding_version: 9,
  });
  assert.equal(bindingCalls[0].actor, registeredActor);
  assert.deepEqual(bindingCalls[0].input, {
    action: "bind_write",
    mindRef: "/research-notes",
    expectedBindingVersion: 8,
    idempotencyKey: "binding:product-site",
    binding_owner_id: "tok_binding",
  });

  conflict = true;
  const stale = await handler(new Request(`${origin}/api/v1/mind-bindings/tok_binding`, {
    method: "PATCH",
    headers: {
      origin,
      "x-csrf-token": "csrf-bindings",
      "content-type": "application/json",
      "idempotency-key": "binding:stale",
    },
    body: JSON.stringify({ action: "unbind_write", expected_binding_version: 8 }),
  }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "binding_version_conflict");
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
            bytes: Uint8Array.from([1, 2, 3]),
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
  assert.deepEqual(tools.map(({ name }) => name), MCP_TOOL_DEFINITIONS.map(({ name }) => name));
  assert.equal(tools.some(({ name }) => String(name).includes("member") || String(name).includes("token")), false);
  const roots = await application.listRootResources({ actor });
  assert.equal(roots.resources.length, 1);
  assert.equal(roots.resources[0].uri, "okf://spaces/space_one/revisions/revision_one/index");
});
