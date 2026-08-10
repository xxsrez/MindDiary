import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MIND_DIARY_CODEX_CONFIG,
  MIND_DIARY_CODEX_SAFE_ENVIRONMENT_SETUP,
  MIND_DIARY_CODEX_SITES_AUTHORIZATION_ENVIRONMENT_VARIABLE,
  MIND_DIARY_CODEX_SITES_SAFE_ENVIRONMENT_SETUP,
  MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE,
  MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER,
  renderMcpTokenManagement,
  renderMcpTokenManagementDocument,
} from "../../packages/adapter-web/dist/index.js";

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
  assert.match(
    MIND_DIARY_CODEX_CONFIG,
    /OAI-Sites-Authorization = "MIND_DIARY_SITES_AUTHORIZATION"/,
  );
  assert.doesNotMatch(MIND_DIARY_CODEX_CONFIG, /mdp_v1_[A-Za-z0-9_-]{20,}/);

  const html = renderMcpTokenManagement(model({ kind: "empty" }));
  assert.match(html, /Keep the secret outside your repository and Codex config/);
  assert.match(html, /complete <code>Bearer &lt;secret&gt;<\/code> header value/);
  assert.match(html, /Historical UAT baseline/);
  assert.match(html, /hosted environment is UAT, not production/);
  assert.match(html, /OAuth\/PKCE and public plugin support remain outside/);
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
  assert.match(shellCss, /@media \(max-width: 36rem\)/);
  assert.match(shellCss, /@media \(forced-colors: active\)/);
});
