import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MIND_DIARY_CODEX_CONFIG,
  MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
  MIND_DIARY_CODEX_SAFE_ENVIRONMENT_SETUP,
  MIND_DIARY_CODEX_STARTER_PLAYBOOK,
  MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK,
  MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK,
  MIND_DIARY_CODEX_SITES_AUTHORIZATION_ENVIRONMENT_VARIABLE,
  MIND_DIARY_CODEX_SITES_SAFE_ENVIRONMENT_SETUP,
  MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE,
  MIND_DIARY_MCP_COMPATIBILITY_PATH,
  MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER,
  MIND_DIARY_MCP_MODERN_PATH,
  mindDiaryCodexConfig,
  mindDiaryMcpEndpoint,
  renderMcpTokenManagement,
  renderMcpTokenManagementDocument,
} from "../../packages/adapter-web/dist/index.js";
import {
  PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
  PRODUCT_UI_CLIENT_JAVASCRIPT,
} from "../../packages/adapter-web/dist/product-ui-assets.js";

const implementation = await readFile(
  new URL("../../packages/adapter-web/src/token-management.ts", import.meta.url),
  "utf8",
);
const shellCss = await readFile(
  new URL("../../packages/adapter-web/src/ui-shell.css", import.meta.url),
  "utf8",
);

const TOKENS = Object.freeze([
  Object.freeze({
    tokenId: "tok_active",
    name: "Codex on Mac",
    displayPrefix: "mdp_v1_Ab12cd…",
    scopes: Object.freeze(["content:read", "content:write"]),
    state: "active",
    createdAt: "2026-08-05T22:00:00.000Z",
    expiresAt: "2026-11-03T22:00:00.000Z",
    lastUsedAt: "2026-08-06T12:00:00.000Z",
    revokedAt: null,
  }),
  Object.freeze({
    tokenId: "tok_revoked",
    name: "Old laptop",
    displayPrefix: "mdp_v1_Zy98xw…",
    scopes: Object.freeze(["content:read"]),
    state: "revoked",
    createdAt: "2026-07-01T08:00:00.000Z",
    expiresAt: "2026-09-29T08:00:00.000Z",
    lastUsedAt: null,
    revokedAt: "2026-08-01T08:00:00.000Z",
  }),
]);

function model(collection) {
  return {
    displayName: "Andrey",
    collection,
    siteOrigin: "https://mind-diary.example",
  };
}

test("ready UI lists safe token metadata, effective access, expiry, and immediate-state actions", () => {
  const html = renderMcpTokenManagement(model({ kind: "ready", tokens: TOKENS }));

  assert.match(html, /Codex on Mac/);
  assert.match(html, /mdp_v1_Ab12cd…/);
  assert.match(html, /Read and write/);
  assert.match(html, /Nov 3, 2026/);
  assert.match(html, /data-token-state="active"/);
  assert.match(html, /data-revoke-token="tok_active"/);
  assert.match(html, /data-token-state="revoked"/);
  assert.doesNotMatch(html, /data-revoke-token="tok_revoked"/);
  assert.doesNotMatch(html, /secret_verifier|hmac|token_hash|full lookup material/i);
});

test("create form offers read-only or effective read-and-write, never write-only", () => {
  const html = renderMcpTokenManagement(model({ kind: "empty" }));

  assert.match(html, /<option value="content:read">Read only<\/option>/);
  assert.match(html, /<option value="content:write">Read and write<\/option>/);
  assert.match(html, /A write-only token is not available/);
  assert.doesNotMatch(html, />\s*Write only\s*</i);
  assert.match(html, /<option value="90" selected>90 days<\/option>/);
  assert.match(html, /shown once and cannot be recovered/i);
});

test("Codex instructions reference bearer_token_env_var without placing a token in config", () => {
  assert.equal(MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE, "MIND_DIARY_TOKEN");
  assert.equal(
    MIND_DIARY_CODEX_SITES_AUTHORIZATION_ENVIRONMENT_VARIABLE,
    "MIND_DIARY_SITES_AUTHORIZATION",
  );
  assert.equal(
    MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER,
    "https://<your-mind-diary-site>/api/mcp/2025-11-25",
  );
  assert.equal(
    MIND_DIARY_CODEX_SAFE_ENVIRONMENT_SETUP,
    "read -s MIND_DIARY_TOKEN && export MIND_DIARY_TOKEN",
  );
  assert.match(
    MIND_DIARY_CODEX_SITES_SAFE_ENVIRONMENT_SETUP,
    /MIND_DIARY_SITES_AUTHORIZATION="Bearer \$\{MIND_DIARY_SITES_TOKEN\}"/,
  );
  assert.match(MIND_DIARY_CODEX_CONFIG, /bearer_token_env_var = "MIND_DIARY_TOKEN"/);
  assert.equal(MIND_DIARY_MCP_MODERN_PATH, "/api/mcp");
  assert.equal(MIND_DIARY_MCP_COMPATIBILITY_PATH, "/api/mcp/2025-11-25");
  assert.match(
    MIND_DIARY_CODEX_CONFIG,
    /OAI-Sites-Authorization = "MIND_DIARY_SITES_AUTHORIZATION"/,
  );
  assert.doesNotMatch(MIND_DIARY_CODEX_CONFIG, /mdp_v1_[A-Za-z0-9_-]{20,}/);

  const html = renderMcpTokenManagement(model({ kind: "empty" }));
  assert.match(html, /https:\/\/mind-diary\.example\/api\/mcp\/2025-11-25/);
  assert.match(html, /https:\/\/mind-diary\.example\/api\/mcp/);
  assert.doesNotMatch(html, /&lt;your-mind-diary-site&gt;/);
  assert.equal((html.match(/required = true/gu) ?? []).length, 2);
  assert.match(html, /data-copy-code="mind-diary-compatibility-config"/);
  assert.match(html, /data-copy-code="mind-diary-modern-config"/);
  assert.match(html, /Keep the secret outside your repository and Codex config/);
  assert.match(html, /complete <code>Bearer &lt;secret&gt;<\/code> header value/);
  assert.match(html, /UAT connector baseline/);
  assert.match(html, /hosted environment is UAT, not production/);
  assert.match(html, /OAuth Authorization Code with PKCE/);
});

test("legacy mixed renderer is not backed by an actionable raw OAuth browser route", () => {
  const html = renderMcpTokenManagement({
    ...model({ kind: "empty" }),
    oauthConnections: {
      kind: "ready",
      connections: [{
        grantId: "md_oauth_grant_12345678-1234-1234-1234-123456789abc",
        clientName: "ChatGPT Mind Diary <unsafe>",
        scopes: ["content:read", "content:write"],
        createdAt: "2026-08-17T20:00:00.000Z",
        lastUsedAt: null,
      }],
    },
  });
  assert.match(html, /Connected apps/);
  assert.match(html, /ChatGPT Mind Diary &lt;unsafe&gt;/);
  assert.match(html, /Read and write/);
  assert.match(html, /data-revoke-oauth="md_oauth_grant_12345678-1234-1234-1234-123456789abc"/);
  assert.doesNotMatch(PRODUCT_UI_CLIENT_JAVASCRIPT, /\/api\/v1\/oauth-connections\//);
});

test("binding UI separates attached read-only Minds from one writable Mind without leaking inaccessible metadata", () => {
  const html = renderMcpTokenManagement({
    ...model({ kind: "ready", tokens: TOKENS }),
    bindingOwners: [{
      kind: "ready",
      ownerId: "tok_active",
      bindingVersion: 4,
      state: "active",
      readBindings: [
        {
          readBindingId: "read-binding-safe",
          mind: { name: "Personal Notes", route: "/me", visibility: "private", canWrite: true },
        },
        { readBindingId: "read-binding-hidden", mind: null },
      ],
      writeBinding: {
        writeBindingId: "write-binding-safe",
        mind: { name: "Shared Research", route: "/research", visibility: "unlisted", canWrite: true },
      },
      automaticCapture: {
        mode: "routine_non_sensitive",
        writeBindingId: "write-binding-safe",
        updatedAt: "2026-08-22T10:00:00.000Z",
      },
      eligibleMinds: [
        { name: "Personal Notes", route: "/me", visibility: "private", canWrite: true },
        { name: "Shared Research", route: "/research", visibility: "unlisted", canWrite: true },
        { name: "Public Reader", route: "/public-reader", visibility: "public", canWrite: false },
      ],
    }],
  });

  assert.match(html, /Attached Minds are read-only/);
  assert.match(html, /Active writable Mind/);
  assert.match(html, /Version 4/);
  assert.match(html, /Personal Notes[\s\S]*\/me[\s\S]*private/);
  assert.match(html, /Shared Research[\s\S]*\/research[\s\S]*unlisted/);
  assert.match(html, /Access unavailable/);
  assert.match(html, /Mind metadata is hidden because current access no longer permits it/);
  assert.match(html, /data-binding-action="detach_read"/);
  assert.match(html, /data-binding-action="unbind_write"/);
  assert.match(html, /data-binding-form="attach_read"/);
  assert.match(html, /data-binding-form="bind_write"/);
  assert.match(html, /Switching makes the previous Mind no longer writable/);
  assert.match(html, /Unlisted\/public readers see committed live HEAD and history immediately/);
  assert.match(html, /Automatic knowledge capture/);
  assert.match(html, /Paused: the pinned writable generation or private-target requirement is no longer current/);
  assert.match(html, /data-binding-action="disable_capture"/);
  assert.match(html, /Sensitive, cross-Mind, external, destructive, and substantial content/);
  assert.doesNotMatch(html, /principal_|space_|private@example\.com/);
});

test("revoked credentials expose recovery guidance but no binding mutation controls", () => {
  const html = renderMcpTokenManagement({
    ...model({ kind: "ready", tokens: [TOKENS[1]] }),
    bindingOwners: [{
      kind: "ready",
      ownerId: "tok_revoked",
      bindingVersion: 7,
      state: "revoked",
      readBindings: [],
      writeBinding: null,
      automaticCapture: {
        mode: "disabled",
        writeBindingId: null,
        updatedAt: null,
      },
      eligibleMinds: [],
    }],
  });
  assert.match(html, /expired or revoked/);
  assert.match(html, /choose bindings explicitly/);
  assert.doesNotMatch(html, /data-binding-form|data-binding-action/);
});

test("exact-origin Codex configs keep modern and compatibility lifecycles separate", () => {
  assert.equal(
    mindDiaryMcpEndpoint("https://mind-diary.example", "modern"),
    "https://mind-diary.example/api/mcp",
  );
  assert.equal(
    mindDiaryMcpEndpoint("http://localhost:3000", "compatibility"),
    "http://localhost:3000/api/mcp/2025-11-25",
  );
  const modern = mindDiaryCodexConfig("https://mind-diary.example", "modern");
  const compatibility = mindDiaryCodexConfig(
    "https://mind-diary.example",
    "compatibility",
  );
  assert.match(modern, /url = "https:\/\/mind-diary\.example\/api\/mcp"/);
  assert.doesNotMatch(modern, /2025-11-25/);
  assert.match(compatibility, /api\/mcp\/2025-11-25/);
  for (const config of [modern, compatibility]) {
    assert.match(config, /required = true/);
    assert.match(config, /bearer_token_env_var = "MIND_DIARY_TOKEN"/);
    assert.doesNotMatch(config, /mdp_v1_[A-Za-z0-9_-]{20,}/);
  }
  for (const unsafe of [
    "http://mind-diary.example",
    "https://mind-diary.example/path",
    "https://user:password@mind-diary.example",
  ]) {
    assert.throws(() => mindDiaryCodexConfig(unsafe, "modern"), /canonical HTTPS/u);
  }
});

test("Codex recovery playbooks require preview, confirmation, fresh CAS, immutable restore, and verified export", () => {
  const html = renderMcpTokenManagement(model({ kind: "empty" }));

  assert.match(MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK, /Show me a bounded preview/u);
  assert.match(MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK, /Ask for my explicit confirmation/u);
  assert.match(MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK, /re-read HEAD/u);
  assert.match(MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK, /Never retry a changed payload with the same idempotency key/u);
  assert.match(MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK, /Historical mode is read-only/u);
  assert.match(MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK, /create a new revision/u);
  assert.match(MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK, /Verify the returned byte size and SHA-256/u);
  assert.match(MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK, /Revoked access or a private switch must fail closed/u);
  assert.match(html, /Preview, restore and export with Codex/u);
  assert.match(html, /data-copy-code="mind-diary-safe-write-playbook"/u);
  assert.match(html, /data-copy-code="mind-diary-restore-export-playbook"/u);
  assert.match(html, /Stale HEAD[\s\S]*Stop, re-read, rebuild and reconfirm/u);
  assert.match(html, /Index unavailable[\s\S]*canonical browse\/fetch/u);
  assert.match(html, /Export expired[\s\S]*fresh authorized status\/grant/u);
  assert.match(html, /Access revoked[\s\S]*Fail closed/u);
  assert.doesNotMatch(html, /mdp_v1_[A-Za-z0-9_-]{20,}/u);
});

test("starter and concierge playbooks render as secret-free copy-ready guidance", () => {
  const html = renderMcpTokenManagement(model({ kind: "empty" }));

  assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, /choose exactly one target/u);
  assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, /validate_mind/u);
  assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, /search for a distinctive phrase/u);
  assert.match(MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK, /not a product import/u);
  assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, /Call list_minds before any content operation/u);
  assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, /Never infer a target/u);
  assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, /Connection \/ Advanced MCP/u);
  assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, /never mutate the target through MCP/u);
  assert.match(MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK, /Content MCP never selects, clears, or transfers/u);
  assert.match(MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK, /writable_target_required/u);
  assert.match(MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK, /ZIP\/import\/upload\/crawl API/u);
  assert.match(html, /Start one valid Mind with Codex/u);
  assert.match(html, /data-copy-code="mind-diary-starter-playbook"/u);
  assert.match(html, /data-copy-code="mind-diary-concierge-playbook"/u);
  assert.match(html, /one selected Mind/u);
  assert.doesNotMatch(html, /mdp_v1_[A-Za-z0-9_-]{20,}/u);
});

test("loading, empty, and error states are explicit and retryable", () => {
  const loading = renderMcpTokenManagement(model({ kind: "loading" }));
  const empty = renderMcpTokenManagement(model({ kind: "empty" }));
  const error = renderMcpTokenManagement(
    model({ kind: "error", message: "Token metadata is unavailable." }),
  );

  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Checking token metadata…/);
  assert.match(empty, /No MCP tokens yet/);
  assert.match(empty, /href="#create-token"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /data-token-retry/);
});

test("all server-provided metadata and failures are escaped before rendering", () => {
  const malicious = `<img src=x onerror="globalThis.pwned=1">`;
  const html = renderMcpTokenManagement({
    displayName: malicious,
    announcement: malicious,
    collection: {
      kind: "ready",
      tokens: [
        {
          ...TOKENS[0],
          tokenId: `tok\" onmouseover=\"globalThis.pwned=2`,
          name: `<svg onload="globalThis.pwned=3">`,
          displayPrefix: `<script>globalThis.pwned=4</script>`,
          state: `active\" onfocus=\"globalThis.pwned=5`,
        },
      ],
    },
  });

  assert.doesNotMatch(html, /<(?:script|svg|img)\b[^>]*(?:onerror|onload|pwned)/i);
  assert.doesNotMatch(html, /\son(?:click|error|focus|load|mouseover)\s*=\s*["']/i);
  assert.match(html, /&lt;svg onload=&quot;globalThis\.pwned=3&quot;&gt;/);
  assert.match(html, />Unavailable<\/code>/);
  assert.match(html, /data-token-state="revoked"/);
  assert.doesNotMatch(html, /data-revoke-token=/);
});

test("show-once and revoke dialogs have confirmation, live status, and keyboard-focus contracts", () => {
  const html = renderMcpTokenManagement(model({ kind: "ready", tokens: TOKENS }));

  assert.match(html, /<dialog[^>]+data-secret-dialog/);
  assert.match(html, /tabindex="-1" data-secret-value/);
  assert.match(html, /Close permanently/);
  assert.match(html, /data-copy-status/);
  assert.match(html, /data-mcp-self-check/);
  assert.match(html, /data-run-mcp-self-check disabled/);
  assert.match(html, /never renders or retains email, Mind names, IDs, queries, content, credentials or raw responses/i);
  assert.match(html, /<dialog[^>]+data-revoke-dialog/);
  assert.match(html, /Revoke this token\?/);
  assert.match(html, /will stop working immediately/);
  assert.match(html, /data-revoke-status/);
  assert.match(implementation, /revealedSecret = ""/);
  assert.match(implementation, /textContent = "Secret removed\. It cannot be recovered\."/);
  assert.doesNotMatch(
    implementation,
    /console\.|analytics\.|dataLayer|localStorage|sessionStorage|sendBeacon/i,
  );
});

test("production redacted self-check covers both auth boundaries and both MCP profiles without telemetry or raw output", () => {
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /fetch\("\/api\/v1\/session"/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /server\/discover/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /\/api\/mcp\/2025-11-25/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /name:"list_minds"/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /notifications\/initialized/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /method:"tools\/list"/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /Site audience access failed before Mind Diary/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /Token authentication failed/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /Token is missing content:read/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /Wrong MCP endpoint/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /AbortController/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /payload=null/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /insufficient_scope/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /cache:"no-store"/);
  assert.doesNotMatch(
    PRODUCT_UI_CLIENT_JAVASCRIPT,
    /console\.|localStorage|sessionStorage|sendBeacon|response\.text\(|analytics\.|dataLayer/i,
  );
  assert.doesNotMatch(PRODUCT_UI_CLIENT_JAVASCRIPT, /name:"(?:search|fetch|commit_changeset)"/);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /button\.closest\("section"\)/u);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /This text contains no token or Site credential/u);
  assert.doesNotMatch(PRODUCT_UI_CLIENT_JAVASCRIPT, /\/api\/v1\/mind-bindings\//u);
  assert.match(PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT, /expected_binding_version/u);
  assert.match(PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT, /Access changed in another session/u);
});

test("document loads only an explicitly safe local fixture client and CSS covers responsive token controls", () => {
  const safe = renderMcpTokenManagementDocument(
    model({ kind: "empty" }),
    "/fixture/token-management-client.mjs",
  );
  const unsafe = renderMcpTokenManagementDocument(
    model({ kind: "empty" }),
    `javascript:globalThis.pwned=1`,
  );

  assert.match(safe, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(safe, /src="\/fixture\/token-management-client\.mjs"/);
  assert.doesNotMatch(unsafe, /javascript:|globalThis\.pwned/);
  assert.match(shellCss, /\.md-token-grid/);
  assert.match(shellCss, /\.md-secret-value/);
  assert.match(shellCss, /\.md-button--danger/);
  assert.match(shellCss, /\.md-binding-controls/);
  assert.match(shellCss, /@media \(max-width: 36rem\)/);
  assert.match(shellCss, /@media \(forced-colors: active\)/);
});
