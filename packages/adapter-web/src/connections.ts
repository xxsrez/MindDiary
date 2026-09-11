import {
  MIND_DIARY_CODEX_HELP_ROUTE,
  MIND_DIARY_FAVICON_LINKS,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  renderMindDiaryAuthenticatedFooter,
  renderMindDiaryAuthenticatedHeader,
} from "./ui-shell.js";
import {
  MIND_DIARY_MCP_COMPATIBILITY_PATH,
  MIND_DIARY_MCP_MODERN_PATH,
  mindDiaryCodexConfig,
} from "./token-management.js";

export interface ConnectionListItem {
  readonly connectionRef: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly canRead: boolean;
  readonly canWrite: boolean;
}

export interface ConnectionDetail extends ConnectionListItem {}

export type ConnectionsCollection =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly ConnectionListItem[]; readonly nextCursor: string | null }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export interface ConnectionsPageModel {
  readonly displayName: string;
  readonly collection: ConnectionsCollection;
}

export interface ConnectionDetailModel {
  readonly displayName: string;
  readonly connection: ConnectionDetail;
}

export interface PersonalTokenItem {
  readonly personalTokenRef: string;
  readonly name: string;
  readonly displayPrefix: string;
  readonly scopes: readonly ("content:read" | "content:write" | "personal:configure")[];
  readonly state: "active" | "revoked" | "expired";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export type PersonalTokenCollection =
  | { readonly kind: "ready"; readonly items: readonly PersonalTokenItem[]; readonly nextCursor: string | null }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export interface AdvancedMcpPageModel {
  readonly displayName: string;
  readonly siteOrigin: string;
  readonly state: "active" | "revoked" | "expired";
  readonly collection: PersonalTokenCollection;
}

const CONNECTION_REF = /^conn_v1_[0-9a-f]{32}$/u;
const PERSONAL_TOKEN_REF = /^ptok_v1_[0-9a-f]{32}$/u;

function dateLabel(value: string | null): string {
  if (value === null) return "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function document(title: string, body: string, client = true): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  ${MIND_DIARY_FAVICON_LINKS}
  <title>${escapeUntrustedText(title)} — Mind Diary</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${body}${client ? '\n  <script type="module" src="/ui/mind-diary-connections-client.js"></script>' : ""}
</body>
</html>`;
}

function nextLink(path: string, cursor: string | null, label: string): string {
  if (cursor === null || !/^[A-Za-z0-9_-]{1,2048}$/u.test(cursor)) return "";
  return `<p><a class="md-button md-button--secondary" href="${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}">${escapeUntrustedText(label)}</a></p>`;
}

function renderConnectionCard(item: ConnectionListItem): string {
  if (!CONNECTION_REF.test(item.connectionRef)) return "";
  const href = `/settings/connections/${encodeURIComponent(item.connectionRef)}`;
  return `<article class="md-token-card md-entity-row md-connection-row" data-ia-row>
    <div class="md-token-card__heading">
      <div><h3><a href="${href}">${escapeUntrustedText(item.clientName)}</a></h3></div>
      <span class="md-token-state md-token-state--active">● Connected</span>
    </div>
    <dl class="md-token-card__metadata">
      <div><dt>Read scope</dt><dd>${item.canRead ? "Granted" : "No"}</dd></div>
      <div><dt>Write scope</dt><dd>${item.canWrite ? "Granted" : "No"}</dd></div>
      <div><dt>Connected</dt><dd>${escapeUntrustedText(dateLabel(item.createdAt))}</dd></div>
      <div><dt>Last used</dt><dd>${escapeUntrustedText(dateLabel(item.lastUsedAt))}</dd></div>
    </dl>
    <p><a class="md-button md-button--secondary" href="${href}">View connection</a></p>
  </article>`;
}

export function renderConnectionsPageDocument(model: ConnectionsPageModel): string {
  let collection: string;
  if (model.collection.kind === "loading") {
    collection = `<section class="md-state md-state--loading" aria-busy="true" data-connections-collection data-collection-state="loading" data-ia-route-state="loading"><h2>Loading connections</h2><p role="status" aria-live="polite">Opening current access…</p></section>`;
  } else if (model.collection.kind === "error") {
    collection = `<section class="md-state md-state--error" role="alert" data-connections-collection data-collection-state="error" data-ia-route-state="error"><h2>Connections are unavailable</h2><p>${escapeUntrustedText(model.collection.message)}</p><a class="md-button md-button--secondary" href="/settings/connections">Try again</a></section>`;
  } else if (model.collection.kind === "empty") {
    collection = `<section class="md-state md-state--empty" data-connections-collection data-collection-state="empty" data-ia-route-state="empty"><h2>No active connections</h2><p>Install Mind Diary from the available Marketplace, then ask Codex to use one of your Minds. Codex will open the read consent when it first needs access.</p><a class="md-button md-button--primary" href="${MIND_DIARY_CODEX_HELP_ROUTE}" data-ia-primary-action>Open the three-step guide</a></section>`;
  } else {
    collection = `<section aria-labelledby="connections-heading" data-connections-collection data-collection-state="ready" data-ia-collection><h2 id="connections-heading">Active connections</h2><div class="md-token-grid md-settings-collection">${model.collection.items.map(renderConnectionCard).join("")}</div>${nextLink("/settings/connections", model.collection.nextCursor, "Next connections")}</section>`;
  }
  return document("Connections", `<div class="md-shell" data-mind-diary-shell data-ia-shell data-connections-page data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "connections")}
    <main id="main-content" class="md-main md-settings-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Codex access</p><h1>Connections</h1><p>Manage connected apps. Choose which Minds they can use on the <a href="/minds#mind-usage-heading">Minds page</a>.</p></div></div>
      ${collection}

    </main>
    ${renderMindDiaryAuthenticatedFooter("connections")}
  </div>`);
}

function renderOrdinaryConnectionAccess(
  connectionRef: string,
  canWrite: boolean,
  canRead: boolean,
): string {
  if (!CONNECTION_REF.test(connectionRef)) {
    return `<section class="md-state md-state--error" role="alert"><h2>Mind access is unavailable</h2><p>Reload before changing this connection.</p></section>`;
  }
  return `<section class="md-credential-mode-panel" data-principal-mind-usage-notice>
    <section aria-labelledby="connection-read-access-heading"><h2 id="connection-read-access-heading">Credential scopes</h2><p>${canRead ? "Read scope is available." : "Read scope is not available."} ${canWrite ? "Write scope is also available." : "Write scope is not available."} Scopes only narrow the account-wide Mind modes and never choose a destination.</p></section>
    <section aria-labelledby="connection-mind-intent-heading"><h2 id="connection-mind-intent-heading">Mind modes belong to your account</h2><p>Every Connection and personal token sees the same independent “Off”, “Read only”, or “Read and write” mode for each Mind. Current rights, each Mind’s description and this credential’s scopes are checked again on every call. A Mind without a description requires your direct request; described Minds follow matching topics within their modes. Several matching writable Minds can receive independent commits.</p><p><a class="md-button md-button--secondary" href="/minds#mind-usage-heading">Manage Mind modes</a></p></section>
  </section>`;
}

function renderAdvancedTokenAccess(
  input: {
    readonly personalTokenRef: string;
    readonly canWrite: boolean;
    readonly canRead: boolean;
    readonly headingSuffix: string;
  },
): string {
  if (!PERSONAL_TOKEN_REF.test(input.personalTokenRef) || !/^[a-z0-9-]{1,40}$/u.test(input.headingSuffix)) {
    return `<section class="md-state md-state--error" role="alert"><h2>Mind access is unavailable</h2><p>Reload before changing this credential.</p></section>`;
  }
  const readHeading = `token-read-access-${input.headingSuffix}`;
  const writeHeading = `token-write-access-${input.headingSuffix}`;
  return `<section class="md-credential-mode-panel" data-principal-mind-usage-notice>
    <section aria-labelledby="${readHeading}"><h4 id="${readHeading}">Credential scope</h4><p>${input.canRead ? "This token can read." : "This token cannot read content."} ${input.canWrite ? "It can also write when the account-wide Mind mode and current rights allow it." : "It cannot write."}</p></section>
    <section aria-labelledby="${writeHeading}"><h4 id="${writeHeading}">Account-wide Mind modes</h4><p>This token does not own separate Mind choices. Manage the independent modes shared by all credentials on the Minds page.</p><p><a href="/minds#mind-usage-heading">Manage Mind modes</a></p></section>
  </section>`;
}

export function renderConnectionDetailDocument(model: ConnectionDetailModel): string {
  const connection = model.connection;
  if (!CONNECTION_REF.test(connection.connectionRef)) throw new TypeError("connection ref is invalid");
  return document(`${connection.clientName} connection`, `<div class="md-shell" data-mind-diary-shell data-ia-shell data-connection-detail data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "connections")}
    <main id="main-content" class="md-main md-settings-main" tabindex="-1" data-ia-main>
      <p><a href="/settings/connections">← Connections</a></p>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Connected app</p><h1>${escapeUntrustedText(connection.clientName)}</h1><p>Connected ${escapeUntrustedText(dateLabel(connection.createdAt))}; last used ${escapeUntrustedText(dateLabel(connection.lastUsedAt))}.</p></div><span class="md-token-state md-token-state--active">● Connected</span></div>
      ${renderOrdinaryConnectionAccess(connection.connectionRef, connection.canWrite, connection.canRead)}
      <section class="md-setup-card" aria-labelledby="disconnect-heading"><h2 id="disconnect-heading">Disconnect</h2><p>Revoking stops this app immediately and removes it from Connections.</p><button class="md-button md-button--danger" type="button" data-revoke-connection data-revoke-endpoint="/api/v1/connections/${connection.connectionRef}">Revoke connection</button><p class="md-form__status" role="status" aria-live="polite" data-revoke-status></p></section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("connections")}
  </div>`);
}

function renderPersonalToken(token: PersonalTokenItem, index: number): string {
  if (!PERSONAL_TOKEN_REF.test(token.personalTokenRef)) return "";
  const canWrite = token.scopes.includes("content:write");
  return `<article class="md-token-card md-settings-token" data-personal-token>
    <div class="md-token-card__heading"><div><h3>${escapeUntrustedText(token.name)}</h3><p><code>${escapeUntrustedText(token.displayPrefix)}</code></p></div><span class="md-token-state md-token-state--${token.state}">${escapeUntrustedText(token.state)}</span></div>
    <dl class="md-token-card__metadata"><div><dt>Scopes</dt><dd>${escapeUntrustedText(token.scopes.join(", "))}</dd></div><div><dt>Expires</dt><dd>${escapeUntrustedText(dateLabel(token.expiresAt))}</dd></div><div><dt>Last used</dt><dd>${escapeUntrustedText(dateLabel(token.lastUsedAt))}</dd></div></dl>
    ${token.state === "active" ? `<details class="md-settings-token-access"><summary>Access details</summary>${renderAdvancedTokenAccess({ personalTokenRef: token.personalTokenRef, canWrite, canRead: token.scopes.includes("content:read"), headingSuffix: `item-${index + 1}` })}</details>` : ""}
    ${token.state === "active" ? `<button class="md-button md-button--danger" type="button" data-revoke-personal-token data-revoke-endpoint="/api/v1/mcp-tokens/${token.personalTokenRef}">Revoke token</button><p class="md-form__status" role="status" aria-live="polite" data-revoke-status></p>` : ""}
  </article>`;
}

function renderPersonalTokenCreation(): string {
  return `<section class="md-setup-card" id="create-token" aria-labelledby="create-token-heading"><div><p class="md-eyebrow">Personal access</p><h2 id="create-token-heading">Create a personal token</h2><p>Name the device or client so you can revoke it later. The secret is shown once and cannot be recovered.</p></div><form class="md-token-form" data-token-form><div class="md-field"><label for="token-name">Token name</label><input id="token-name" name="name" type="text" required maxlength="80" autocomplete="off" placeholder="Codex on Mac"></div><div class="md-field"><label for="token-access">Access</label><select id="token-access" name="access" required><option value="content:read">Read only</option><option value="content:write">Read and write</option></select><p>Read and write always includes read access. A write-only token is not available.</p></div><div class="md-field"><label><input type="checkbox" name="personal_configure"> Allow Codex to configure My Mind topics when I ask</label></div><div class="md-field"><label for="token-expiry">Expires after</label><select id="token-expiry" name="expiry_days" required><option value="7">7 days</option><option value="30">30 days</option><option value="90" selected>90 days</option></select></div><p class="md-form__status" role="status" aria-live="polite" data-token-form-status></p><button class="md-button md-button--primary" type="submit" data-token-submit>Create token</button></form></section>`;
}

function renderPersonalTokenSecretDialog(): string {
  return `<dialog class="md-dialog md-secret-dialog" id="mcp-token-secret-dialog" aria-labelledby="token-secret-title" aria-describedby="token-secret-description" data-secret-dialog><div class="md-form"><div class="md-dialog__heading"><div><p class="md-eyebrow">Shown once</p><h2 id="token-secret-title">Copy your token now</h2></div><button class="md-icon-button" type="button" aria-label="Close one-time token" data-close-secret>×</button></div><p id="token-secret-description">After you close this window, Mind Diary cannot show or recover this secret.</p><code class="md-secret-value" tabindex="-1" data-secret-value>Secret is not available.</code><p class="md-form__status" role="status" aria-live="polite" data-copy-status></p><section class="md-setup-card" aria-labelledby="mcp-self-check-title" data-mcp-self-check data-diagnostic-state="idle"><div><p class="md-eyebrow">Redacted connection check</p><h3 id="mcp-self-check-title">Test this token before closing</h3><p>The check uses the current authenticated account, modern discovery and read-only <code>list_minds</code> on both profiles. It never renders or retains email, Mind names, IDs, queries, content, credentials or raw responses.</p></div><button class="md-button md-button--secondary" type="button" data-run-mcp-self-check disabled>Run redacted self-check</button><p class="md-form__status" role="status" aria-live="polite" data-mcp-self-check-status>Available only while the one-time secret is visible.</p></section><div class="md-dialog__actions"><button class="md-button md-button--secondary" type="button" data-close-secret>Close permanently</button><button class="md-button md-button--primary" type="button" data-copy-secret>Copy token</button></div><p class="md-caveat">Do not paste this value into a repository, Codex config, issue, chat, log, analytics field, or screenshot.</p></div></dialog>`;
}

export function renderAdvancedMcpPageDocument(model: AdvancedMcpPageModel): string {
  const origin = new URL(model.siteOrigin).origin;
  const modern = mindDiaryCodexConfig(origin, "modern");
  const compatibility = mindDiaryCodexConfig(origin, "compatibility");
  const tokens = model.collection.kind === "error"
    ? `<section class="md-state md-state--error" role="alert"><h2>Personal tokens are unavailable</h2><p>${escapeUntrustedText(model.collection.message)}</p></section>`
    : model.collection.kind === "empty"
      ? `<section class="md-state md-state--empty"><h2>No ${model.state} personal tokens</h2><p>Create a token only for direct MCP setup or recovery.</p></section>`
      : `<div class="md-token-grid md-settings-collection">${model.collection.items.map(renderPersonalToken).join("")}</div>${nextLink(`/settings/developer/mcp?state=${model.state}`, model.collection.nextCursor, "Next tokens")}`;
  return document("Advanced MCP", `<div class="md-shell" data-mind-diary-shell data-ia-shell data-advanced-mcp data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "tokens")}
    <main id="main-content" class="md-main md-settings-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Advanced</p><h1>Advanced MCP</h1><p>Tokens and configuration for direct MCP clients. Connected apps live under <a href="/settings/connections">Connections</a>.</p></div></div>
      <nav class="md-settings-filters" aria-label="Personal token state"><a href="?state=active"${model.state === "active" ? ' aria-current="page"' : ""}>Active</a><a href="?state=revoked"${model.state === "revoked" ? ' aria-current="page"' : ""}>Revoked</a><a href="?state=expired"${model.state === "expired" ? ' aria-current="page"' : ""}>Expired</a></nav>
      <section aria-labelledby="personal-tokens-heading"><div class="md-section-heading"><div><h2 id="personal-tokens-heading">Personal tokens</h2></div></div>${tokens}</section>
      <details class="md-settings-disclosure md-settings-create" id="new-token"><summary><span><strong>Create a personal token</strong><small>For a direct MCP client.</small></span><span class="md-settings-disclosure-action" aria-hidden="true">New token</span></summary>${renderPersonalTokenCreation()}</details>
      ${renderPersonalTokenSecretDialog()}
      <details class="md-settings-disclosure md-settings-config"><summary><span><strong>Client configuration</strong><small>Endpoints and copyable Codex configuration.</small></span><span class="md-settings-disclosure-action" aria-hidden="true">View setup</span></summary><section class="md-setup-card md-settings-endpoints"><h2>Endpoints and Codex config</h2><dl class="md-card__metadata"><div><dt>Modern MCP 2026-07-28</dt><dd><code>${escapeUntrustedText(`${origin}${MIND_DIARY_MCP_MODERN_PATH}`)}</code></dd></div><div><dt>Compatibility MCP 2025-11-25</dt><dd><code>${escapeUntrustedText(`${origin}${MIND_DIARY_MCP_COMPATIBILITY_PATH}`)}</code></dd></div></dl><h3>Modern</h3><pre><code id="mind-diary-modern-config" tabindex="-1" data-code-value>${escapeUntrustedText(modern)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-modern-config">Copy modern config</button><h3>Compatibility</h3><pre><code id="mind-diary-compatibility-config" tabindex="-1" data-code-value>${escapeUntrustedText(compatibility)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-compatibility-config">Copy compatibility config</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p class="md-caveat"><strong>UAT:</strong> this is not production. Personal tokens are for direct setup and recovery; Marketplace connections use OAuth.</p></section></details>
    </main>
    ${renderMindDiaryAuthenticatedFooter("tokens")}
  </div>`);
}

export function renderCodexHelpPageDocument(displayName: string, siteOrigin: string): string {
  const mcpUrl = `${new URL(siteOrigin).origin}${MIND_DIARY_MCP_COMPATIBILITY_PATH}`;
  const marketplaceUrl = "https://github.com/xxsrez/marketplace";
  const cliInstall = "codex plugin marketplace add xxsrez/marketplace\ncodex plugin add mind-diary@srez-marketplace";
  const chatgptInstructions = "Before any web search or use of web sources, first check Mind Diary (the connected Mind Diary UAT app): even when I have not mentioned or selected it. If its tools are not loaded, find Mind Diary UAT using the available app or plugin search and load its tools, then actually call list_minds. Missing tools in the initial list do not by themselves mean the connection is unavailable. If you already listed Minds in this conversation, use that list to select relevant topics. Read Minds whose descriptions match my request and use their relevant evidence as the primary source and basis of your answer. Use the web to supplement it and verify changing facts. If no relevant evidence is available, continue with the web. If finding or calling the connection fails, briefly say so and suggest selecting @Mind Diary UAT; never claim to have checked Minds without a real tool call. Resolve conflicts using dates and evidence quality; explain discrepancies and never present outdated information as current. Respect access permissions and Personal Mind restrictions. This instruction permits reading, not writing. Never send private Mind contents to web searches.";
  const readOnlySmoke = "Use Mind Diary to list the Minds I can read. Do not create or change any Memory.";
  return document("Connect to ChatGPT", `<div class="md-shell" data-mind-diary-shell data-ia-shell data-codex-help data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(displayName, "help")}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Connection guide</p><h1>Connect to ChatGPT</h1><p>Choose Codex Desktop, Codex CLI, or ChatGPT. Each guide starts with read-only access to your enabled Minds.</p></div></div>
      <div class="md-client-tabs" role="tablist" aria-label="Choose your client">
        <button class="md-button md-button--secondary" id="codex-client-desktop-tab" type="button" role="tab" aria-selected="true" aria-controls="codex-client-desktop-panel" tabindex="0" data-codex-client-tab="desktop">Codex Desktop</button>
        <button class="md-button md-button--secondary" id="codex-client-cli-tab" type="button" role="tab" aria-selected="false" aria-controls="codex-client-cli-panel" tabindex="-1" data-codex-client-tab="cli">Codex CLI</button>
        <button class="md-button md-button--secondary" id="codex-client-chatgpt-tab" type="button" role="tab" aria-selected="false" aria-controls="codex-client-chatgpt-panel" tabindex="-1" data-codex-client-tab="chatgpt">ChatGPT</button>
      </div>
      <section class="md-client-panel" id="codex-client-desktop-panel" role="tabpanel" aria-labelledby="codex-client-desktop-tab" data-codex-client-panel="desktop">
        <ol class="md-setup-steps">
          <li data-copy-region><h2>Install Mind Diary</h2><p>Open <strong>Plugins</strong>, choose <strong>Add marketplace</strong>, paste this repository, and add it. In <strong>Srez Marketplace</strong>, open <strong>Mind Diary UAT</strong> and choose <strong>Install</strong>.</p><pre><code id="codex-help-desktop-marketplace" tabindex="-1" data-code-value>${escapeUntrustedText(marketplaceUrl)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-desktop-marketplace">Copy Marketplace URL</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p><strong>Success:</strong> the plugin card says <strong>Installed</strong>. This confirms the plugin package, not an account connection.</p></li>
          <li data-copy-region><h2>Authenticate for reading</h2><p>Start a new Task and send the read-only check below. The first read opens <strong>Authenticate</strong> or <strong>Connect</strong>. Sign in with the same account and workspace you use for this Mind Diary Site, then approve reading.</p><pre><code id="codex-help-desktop-smoke" tabindex="-1" data-code-value>${escapeUntrustedText(readOnlySmoke)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-desktop-smoke">Copy read-only check</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p><strong>Success:</strong> Mind Diary appears in <a href="/settings/connections">Connections</a>. That connection is created only after consent.</p></li>
          <li><h2>Choose readable Minds and start</h2><p>Open <a href="/minds#mind-usage-heading">Minds</a> and choose Read only or Read and write for the Minds Codex should use. A fresh Task receives only enabled Minds that still pass current rights and credential scope checks.</p></li>
        </ol>
      </section>
      <section class="md-client-panel" id="codex-client-cli-panel" role="tabpanel" aria-labelledby="codex-client-cli-tab" data-codex-client-panel="cli">
        <ol class="md-setup-steps">
          <li data-copy-region><h2>Install Mind Diary</h2><p>Run these commands as written. The first adds <strong>Srez Marketplace</strong>; the second installs the <strong>Mind Diary</strong> plugin.</p><pre><code id="codex-help-cli-install" tabindex="-1" data-code-value>${escapeUntrustedText(cliInstall)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-cli-install">Copy CLI install commands</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p><strong>Success:</strong> <code>codex plugin list</code> shows <code>mind-diary@srez-marketplace</code> as installed and enabled. This is still separate from the account connection.</p></li>
          <li><h2>Authenticate for reading</h2><p>Run <code>codex</code> and ask Mind Diary to read. The first read opens <strong>Authenticate</strong>. Sign in with the same account and workspace you use for this Mind Diary Site, then approve reading.</p></li>
          <li data-copy-region><h2>Choose readable Minds and start</h2><p>Open <a href="/minds#mind-usage-heading">Minds</a> and choose Read only or Read and write. Enter <code>/new</code>, then send this safe check. Success is a bounded list of enabled Minds that still pass current rights and scope checks; no Memory is changed.</p><pre><code id="codex-help-cli-smoke" tabindex="-1" data-code-value>${escapeUntrustedText(readOnlySmoke)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-cli-smoke">Copy read-only check</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p></li>
        </ol>
      </section>
      <section class="md-client-panel" id="codex-client-chatgpt-panel" role="tabpanel" aria-labelledby="codex-client-chatgpt-tab" data-codex-client-panel="chatgpt">
        <ol class="md-setup-steps">
          <li><h2>Sign in to Mind Diary</h2><p>Open this Mind Diary Site in the same browser you will use for ChatGPT. Choose <strong>Sign in with ChatGPT</strong> and use your Mind Diary account. On <a href="/minds#mind-usage-heading">Minds</a>, enable Read only or Read and write for the Minds you want to use.</p></li>
          <li data-copy-region><h2>Create the ChatGPT connection</h2><p>This setup uses a custom MCP app and Custom Instructions. You do not need to publish it publicly or install a Codex package with skills and hooks.</p><p>Open <a href="https://chatgpt.com/plugins">ChatGPT Plugins</a> and choose <strong>Create app</strong>. If it is unavailable, check <strong>Settings → Security and login → Developer mode</strong>; availability depends on your account and workspace.</p><p>Name the connection <strong>Mind Diary UAT</strong>, choose <strong>Server URL</strong>, paste this address, and select <strong>OAuth</strong>.</p><pre><code id="chatgpt-help-mcp-url" tabindex="-1" data-code-value>${escapeUntrustedText(mcpUrl)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="chatgpt-help-mcp-url">Copy MCP server URL</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p>Open <strong>Advanced OAuth settings</strong>. Keep <strong>Dynamic Client Registration (DCR)</strong> and the discovered endpoints. Set default scopes to <code>content:read</code> only; leave base scopes empty. Turn <strong>OIDC enabled</strong> off. The discovered Resource should end in <code>/api/mcp</code>, without the version suffix. No client secret or personal token is needed.</p><p>Review the custom-server notice, choose <strong>Create</strong>, then <strong>Sign in with Mind Diary UAT</strong>. On <strong>Connect ChatGPT?</strong>, review read access and choose <strong>Connect</strong>.</p></li>
          <li data-copy-region><h2>Refresh tools and check reading</h2><p>In the plugin settings, confirm <strong>Connected</strong>. If Actions is empty, choose <strong>Refresh</strong> and wait for tools such as <code>list_minds</code> to appear. Start a new ChatGPT chat, select <strong>Mind Diary UAT</strong> from the tools menu, and send this check.</p><pre><code id="chatgpt-help-smoke" tabindex="-1" data-code-value>${escapeUntrustedText(readOnlySmoke)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="chatgpt-help-smoke">Copy read-only check</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p><strong>Success:</strong> ChatGPT returns your enabled Minds through the plugin. Connected and a tool list alone do not prove a successful read.</p></li>
          <li data-copy-region><h2>Add Custom Instructions</h2><p>The connection gives ChatGPT access; Custom Instructions tell it to check Mind Diary before the web. Open <strong>Settings → Personalization → Custom instructions</strong>, add the text below alongside your existing instructions, and choose <strong>Save</strong>. Keep the app name in this text consistent with your connection.</p><pre><code id="chatgpt-help-instructions" tabindex="-1" data-code-value>${escapeUntrustedText(chatgptInstructions)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="chatgpt-help-instructions">Copy Custom Instructions</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p></li>
          <li><h2>Check automatic source selection</h2><p>Start a new ordinary Chat and ask a question about a topic in an enabled Mind without mentioning Mind Diary. Open the tool-call details: ChatGPT should read the relevant Mind before searching the web and use its evidence in the answer. A promise to check is not a successful read.</p><p>Automatic selection is not guaranteed. If ChatGPT skips Mind Diary, confirm the instructions were saved, start a new chat, and explicitly ask it to use Mind Diary. Saved information takes priority as context, but changing facts still need an up-to-date check.</p></li>
        </ol>
        <h2>If ChatGPT cannot connect</h2><p><strong>Sign in to Mind Diary before connecting:</strong> sign in to the Mind Diary Site in the same browser, then reload the authorization tab. If the request has expired, start Sign in again from the existing plugin.</p><p><strong>No readable Minds:</strong> check your account and the modes on Minds. <strong>Reconnect needed</strong> on write actions is expected with read-only consent. Writing needs separate approval for <code>content:write</code>, a Read and write Mind, and current writer rights. Do not enable extra scopes just to fix a read failure.</p><p>This is a UAT connection. Test the same read-only check separately on your phone before relying on mobile access.</p>
      </section>
      <section class="md-setup-card md-setup-card--single" aria-labelledby="codex-help-troubleshooting"><div><p class="md-eyebrow">Checkpoint help</p><h2 id="codex-help-troubleshooting">If a step does not finish</h2><ul><li><strong>Marketplace:</strong> compare the repository exactly. Add it once, then reload Plugins once.</li><li><strong>Install:</strong> confirm the plugin says Installed and start a fresh Task. Installed does not mean connected.</li><li><strong>Authenticate:</strong> repeat the read-only check in a fresh Task and confirm the same account and workspace. Then check <a href="/settings/connections">Connections</a>.</li><li><strong>Readable Minds:</strong> check the account-wide mode on <a href="/minds#mind-usage-heading">Minds</a>, plus current membership or visibility and credential read scope.</li></ul><p>Revoke and reconnect only when the existing connection is no longer usable.</p></div></section>
      <section class="md-setup-card md-setup-card--single" aria-labelledby="codex-help-first-memory"><p class="md-eyebrow">After the read-only check</p><h2 id="codex-help-first-memory">Create the first useful Memory</h2><p>Writing is optional. On <a href="/minds#mind-usage-heading">Minds</a>, choose Read and write for at most one ordinary Mind and independently for Personal Mind. That one account-wide choice is shared by every Connection and personal token; each credential’s scope and current Mind rights can only narrow it. Personal Mind without a description needs your direct request for each specific write. With a description, both Personal and ordinary Minds automatically preserve matching durable knowledge discussed with you. When both descriptions match, each Mind receives an independent commit.</p><p>Open My Mind and use its existing starter card. It keeps the first content change separate from installation and connection checks.</p><p><a class="md-button md-button--primary" href="/me#first-result-title">Open the starter card</a></p></section>
      <section class="md-setup-card md-setup-card--single"><h2>Advanced setup</h2><p><a href="/settings/developer/mcp">Advanced MCP</a> is the separate place for direct client setup and diagnostics. The guided setup above does not require this diagnostics page.</p></section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("help")}
  </div>`);
}
