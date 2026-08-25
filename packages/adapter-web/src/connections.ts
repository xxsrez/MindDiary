import {
  MIND_DIARY_FAVICON_LINKS,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  renderMindDiaryAuthenticatedFooter,
  renderMindDiaryAuthenticatedHeader,
} from "./ui-shell.js";
import {
  MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
  MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK,
  MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK,
  MIND_DIARY_CODEX_STARTER_PLAYBOOK,
  MIND_DIARY_MCP_COMPATIBILITY_PATH,
  MIND_DIARY_MCP_MODERN_PATH,
  mindDiaryCodexConfig,
} from "./token-management.js";

export interface SafeConnectionMind {
  readonly name: string;
  readonly route: string;
  readonly visibility: "private" | "unlisted" | "public";
  readonly canWrite: boolean;
}

export type SafeConnectionReadTarget =
  | { readonly kind: "available"; readonly mind: SafeConnectionMind }
  | { readonly kind: "unavailable"; readonly staleAccessRef: string };

export interface SafeCredentialAccess {
  readonly bindingVersion: number;
  readonly readableMinds: readonly SafeConnectionReadTarget[];
  readonly writableMind?: SafeConnectionMind | null;
  readonly eligibleMinds: readonly SafeConnectionMind[];
}

export interface ConnectionListItem {
  readonly connectionRef: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly readableMindCount: number;
  readonly writableMindSelected: boolean;
}

export interface ConnectionDetail extends ConnectionListItem {
  readonly access: SafeCredentialAccess;
}

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
  readonly scopes: readonly ("content:read" | "content:write")[];
  readonly state: "active" | "revoked" | "expired";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly access?: SafeCredentialAccess;
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
const STALE_ACCESS_REF = /^stale_v1_[0-9a-f]{32}$/u;

function safeMindRoute(value: string): string | null {
  return /^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(value) ? value : null;
}

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
  return `<article class="md-token-card">
    <div class="md-token-card__heading">
      <div><h3><a href="${href}">${escapeUntrustedText(item.clientName)}</a></h3><p>Connected app</p></div>
      <span class="md-token-state md-token-state--active">● Connected</span>
    </div>
    <dl class="md-token-card__metadata">
      <div><dt>Can read</dt><dd>${item.canRead ? `${item.readableMindCount} selected` : "No"}</dd></div>
      <div><dt>Can add and change</dt><dd>${item.canWrite ? (item.writableMindSelected ? "One Mind selected" : "Not selected") : "No"}</dd></div>
      <div><dt>Connected</dt><dd>${escapeUntrustedText(dateLabel(item.createdAt))}</dd></div>
      <div><dt>Last used</dt><dd>${escapeUntrustedText(dateLabel(item.lastUsedAt))}</dd></div>
    </dl>
    <p><a class="md-button md-button--secondary" href="${href}">Manage access</a></p>
  </article>`;
}

export function renderConnectionsPageDocument(model: ConnectionsPageModel): string {
  let collection: string;
  if (model.collection.kind === "loading") {
    collection = `<section class="md-state md-state--loading" aria-busy="true" data-connections-collection data-collection-state="loading"><h2>Loading connections</h2><p role="status" aria-live="polite">Opening current access…</p></section>`;
  } else if (model.collection.kind === "error") {
    collection = `<section class="md-state md-state--error" role="alert" data-connections-collection data-collection-state="error"><h2>Connections are unavailable</h2><p>${escapeUntrustedText(model.collection.message)}</p><a class="md-button md-button--secondary" href="/settings/connections">Try again</a></section>`;
  } else if (model.collection.kind === "empty") {
    collection = `<section class="md-state md-state--empty" data-connections-collection data-collection-state="empty"><h2>No active connections</h2><p>Install Mind Diary from the available Marketplace, then ask Codex to use one of your Minds. Codex will open the read consent when it first needs access.</p><a class="md-button md-button--primary" href="/help/codex">Open the three-step guide</a></section>`;
  } else {
    collection = `<section aria-labelledby="connections-heading" data-connections-collection data-collection-state="ready"><h2 id="connections-heading">Active connections</h2><div class="md-token-grid">${model.collection.items.map(renderConnectionCard).join("")}</div>${nextLink("/settings/connections", model.collection.nextCursor, "Next connections")}</section>`;
  }
  return document("Connections", `<div class="md-shell" data-mind-diary-shell data-connections-page data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "connections")}
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading"><div><p class="md-eyebrow">Codex access</p><h1>Connections</h1><p>See what is connected, which Minds it can read, and whether one writable Mind is selected.</p></div></div>
      ${collection}
      <p class="md-caveat"><a href="/settings/developer/mcp">Advanced MCP</a> is for personal tokens, endpoints, and diagnostics.</p>
    </main>
    ${renderMindDiaryAuthenticatedFooter("connections")}
  </div>`);
}

function renderMind(mind: SafeConnectionMind): string {
  const route = safeMindRoute(mind.route);
  if (route === null) return "<strong>Access unavailable</strong>";
  return `<span class="md-binding-target"><strong>${escapeUntrustedText(mind.name)}</strong><code>${escapeUntrustedText(route)}</code><span>${escapeUntrustedText(mind.visibility)}</span></span>`;
}

function renderAccess(
  access: SafeCredentialAccess,
  input: { readonly kind: "connection" | "personal_token"; readonly ref: string; readonly canWrite: boolean },
): string {
  const safeRef = input.kind === "connection"
    ? (CONNECTION_REF.test(input.ref) ? input.ref : null)
    : (PERSONAL_TOKEN_REF.test(input.ref) ? input.ref : null);
  if (safeRef === null || !Number.isSafeInteger(access.bindingVersion) || access.bindingVersion < 0) {
    return `<section class="md-state md-state--error" role="alert"><h2>Mind access is unavailable</h2><p>Reload before changing this credential.</p></section>`;
  }
  const base = input.kind === "connection"
    ? `/api/v1/connections/${safeRef}`
    : `/api/v1/mcp-tokens/${safeRef}`;
  const reads = access.readableMinds.length === 0
    ? `<li>No readable Minds selected.</li>`
    : access.readableMinds.map((target) => {
        if (target.kind === "unavailable") {
          const stale = STALE_ACCESS_REF.test(target.staleAccessRef) ? target.staleAccessRef : null;
          return `<li><span class="md-binding-target md-binding-target--unavailable"><strong>Access unavailable</strong><span>Mind metadata is hidden because current access no longer permits it.</span></span>${stale === null ? "" : `<button class="md-button md-button--secondary" type="button" data-access-action="detach_read" data-stale-access-ref="${stale}">Remove</button>`}</li>`;
        }
        const route = safeMindRoute(target.mind.route);
        return `<li>${renderMind(target.mind)}${route === null ? "" : `<button class="md-button md-button--secondary" type="button" data-access-action="detach_read" data-mind-ref="${escapeUntrustedText(route)}">Remove</button>`}</li>`;
      }).join("");
  const readableOptions = access.eligibleMinds.map((mind) => {
    const route = safeMindRoute(mind.route);
    return route === null ? "" : `<option value="${escapeUntrustedText(route)}">${escapeUntrustedText(mind.name)} — ${escapeUntrustedText(route)}</option>`;
  }).join("");
  const writableOptions = access.eligibleMinds.filter((mind) => mind.canWrite).map((mind) => {
    const route = safeMindRoute(mind.route);
    return route === null ? "" : `<option value="${escapeUntrustedText(route)}">${escapeUntrustedText(mind.name)} — ${escapeUntrustedText(route)}</option>`;
  }).join("");
  const write = input.canWrite
    ? `<section aria-labelledby="write-access-heading"><h3 id="write-access-heading">Can add and change</h3>${access.writableMind === null || access.writableMind === undefined ? "<p><strong>Not selected</strong></p>" : renderMind(access.writableMind)}<div class="md-binding-controls"><form data-access-form data-access-action="select_write"><label>Select one writable Mind<select name="mind_ref" required><option value="">Choose a Mind</option>${writableOptions}</select></label><button class="md-button md-button--secondary" type="submit">Select</button></form>${access.writableMind === null || access.writableMind === undefined ? "" : `<button class="md-button md-button--secondary" type="button" data-access-action="clear_write">Clear writable Mind</button>`}</div></section>`
    : "";
  return `<section class="md-binding-panel" data-access-panel data-access-endpoint="${base}/mind-access" data-binding-version="${access.bindingVersion}">
    <section aria-labelledby="read-access-heading"><h3 id="read-access-heading">Can read</h3><ul class="md-binding-list">${reads}</ul><form data-access-form data-access-action="attach_read"><label>Add a readable Mind<select name="mind_ref" required><option value="">Choose a Mind</option>${readableOptions}</select></label><button class="md-button md-button--secondary" type="submit">Add</button></form></section>
    ${write}
    <p class="md-form__status" role="status" aria-live="polite" data-access-status></p>
  </section>`;
}

export function renderConnectionDetailDocument(model: ConnectionDetailModel): string {
  const connection = model.connection;
  if (!CONNECTION_REF.test(connection.connectionRef)) throw new TypeError("connection ref is invalid");
  return document(`${connection.clientName} connection`, `<div class="md-shell" data-mind-diary-shell data-connection-detail data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "connections")}
    <main id="main-content" class="md-main" tabindex="-1">
      <p><a href="/settings/connections">← Connections</a></p>
      <div class="md-page-heading"><div><p class="md-eyebrow">Connected app</p><h1>${escapeUntrustedText(connection.clientName)}</h1><p>Connected ${escapeUntrustedText(dateLabel(connection.createdAt))}; last used ${escapeUntrustedText(dateLabel(connection.lastUsedAt))}.</p></div><span class="md-token-state md-token-state--active">● Connected</span></div>
      ${renderAccess(connection.access, { kind: "connection", ref: connection.connectionRef, canWrite: connection.canWrite })}
      ${connection.canWrite ? "" : '<p class="md-caveat"><strong>Can add and change:</strong> No. Ask Codex to add or change a Memory to start the separate write permission step.</p>'}
      <section class="md-setup-card" aria-labelledby="disconnect-heading"><h2 id="disconnect-heading">Disconnect</h2><p>Revoking stops this app immediately and removes it from Connections.</p><button class="md-button md-button--danger" type="button" data-revoke-connection data-revoke-endpoint="/api/v1/connections/${connection.connectionRef}">Revoke connection</button><p class="md-form__status" role="status" aria-live="polite" data-revoke-status></p></section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("connections")}
  </div>`);
}

function renderPersonalToken(token: PersonalTokenItem): string {
  if (!PERSONAL_TOKEN_REF.test(token.personalTokenRef)) return "";
  const canWrite = token.scopes.includes("content:write");
  return `<article class="md-token-card" data-personal-token-ref="${token.personalTokenRef}">
    <div class="md-token-card__heading"><div><h3>${escapeUntrustedText(token.name)}</h3><p><code>${escapeUntrustedText(token.displayPrefix)}</code></p></div><span class="md-token-state md-token-state--${token.state}">${escapeUntrustedText(token.state)}</span></div>
    <dl class="md-token-card__metadata"><div><dt>Scopes</dt><dd>${canWrite ? "content:read, content:write" : "content:read"}</dd></div><div><dt>Expires</dt><dd>${escapeUntrustedText(dateLabel(token.expiresAt))}</dd></div><div><dt>Last used</dt><dd>${escapeUntrustedText(dateLabel(token.lastUsedAt))}</dd></div></dl>
    ${token.state === "active" && token.access !== undefined ? renderAccess(token.access, { kind: "personal_token", ref: token.personalTokenRef, canWrite }) : ""}
    ${token.state === "active" ? `<button class="md-button md-button--danger" type="button" data-revoke-personal-token data-revoke-endpoint="/api/v1/mcp-tokens/${token.personalTokenRef}">Revoke token</button><p class="md-form__status" role="status" aria-live="polite" data-revoke-status></p>` : ""}
  </article>`;
}

function renderPersonalTokenCreation(): string {
  return `<section class="md-setup-card" id="create-token" aria-labelledby="create-token-heading"><div><p class="md-eyebrow">Personal access</p><h2 id="create-token-heading">Create a personal token</h2><p>Name the device or client so you can revoke it later. The secret is shown once and cannot be recovered.</p></div><form class="md-token-form" data-token-form><div class="md-field"><label for="token-name">Token name</label><input id="token-name" name="name" type="text" required maxlength="80" autocomplete="off" placeholder="Codex on Mac"></div><div class="md-field"><label for="token-access">Access</label><select id="token-access" name="access" required><option value="content:read">Read only</option><option value="content:write">Read and write</option></select><p>Read and write always includes read access. A write-only token is not available.</p></div><div class="md-field"><label for="token-expiry">Expires after</label><select id="token-expiry" name="expiry_days" required><option value="7">7 days</option><option value="30">30 days</option><option value="90" selected>90 days</option></select></div><p class="md-form__status" role="status" aria-live="polite" data-token-form-status></p><button class="md-button md-button--primary" type="submit" data-token-submit>Create token</button></form></section>`;
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
      : `<div class="md-token-grid">${model.collection.items.map(renderPersonalToken).join("")}</div>${nextLink(`/settings/developer/mcp?state=${model.state}`, model.collection.nextCursor, "Next tokens")}`;
  return document("Advanced MCP", `<div class="md-shell" data-mind-diary-shell data-advanced-mcp data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "tokens")}
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading"><div><p class="md-eyebrow">Advanced</p><h1>Advanced MCP</h1><p>Personal tokens, exact endpoints, and protocol-oriented recovery. Marketplace connections live under <a href="/settings/connections">Connections</a>.</p></div></div>
      <nav aria-label="Personal token state"><a href="?state=active"${model.state === "active" ? ' aria-current="page"' : ""}>Active</a> · <a href="?state=revoked"${model.state === "revoked" ? ' aria-current="page"' : ""}>Revoked</a> · <a href="?state=expired"${model.state === "expired" ? ' aria-current="page"' : ""}>Expired</a></nav>
      <section aria-labelledby="personal-tokens-heading"><div class="md-section-heading"><div><h2 id="personal-tokens-heading">Personal tokens</h2></div></div>${tokens}</section>
      ${renderPersonalTokenCreation()}
      ${renderPersonalTokenSecretDialog()}
      <section class="md-setup-card"><h2>Endpoints and Codex config</h2><dl class="md-card__metadata"><div><dt>Modern MCP 2026-07-28</dt><dd><code>${escapeUntrustedText(`${origin}${MIND_DIARY_MCP_MODERN_PATH}`)}</code></dd></div><div><dt>Compatibility MCP 2025-11-25</dt><dd><code>${escapeUntrustedText(`${origin}${MIND_DIARY_MCP_COMPATIBILITY_PATH}`)}</code></dd></div></dl><h3>Modern</h3><pre><code id="mind-diary-modern-config" tabindex="-1" data-code-value>${escapeUntrustedText(modern)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-modern-config">Copy modern config</button><h3>Compatibility</h3><pre><code id="mind-diary-compatibility-config" tabindex="-1" data-code-value>${escapeUntrustedText(compatibility)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-compatibility-config">Copy compatibility config</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p class="md-caveat"><strong>UAT:</strong> this is not production. Personal tokens are for direct setup and recovery; Marketplace connections use OAuth.</p></section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("tokens")}
  </div>`);
}

export function renderCodexHelpPageDocument(displayName: string): string {
  const scenarios = [
    ["starter", "Create the first useful Memory", MIND_DIARY_CODEX_STARTER_PLAYBOOK],
    ["safe-write", "Preview and confirm a substantial change", MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK],
    ["restore-export", "Restore as a new revision and export", MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK],
    ["bounded-conversion", "Convert a bounded Markdown set", MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK],
  ] as const;
  const playbooks = scenarios.map(([id, title, value]) => `<details class="md-setup-card"><summary><strong>${escapeUntrustedText(title)}</strong></summary><pre><code id="codex-help-${id}" tabindex="-1" data-code-value>${escapeUntrustedText(value)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-${id}">Copy this prompt</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p></details>`).join("");
  return document("Help with Codex", `<div class="md-shell" data-mind-diary-shell data-codex-help data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(displayName, "help")}
    <main id="main-content" class="md-main" tabindex="-1"><div class="md-page-heading"><div><p class="md-eyebrow">Three steps</p><h1>Use Mind Diary with Codex</h1><p>You do not need an endpoint, token, or identifier for the ordinary connection flow.</p></div></div><ol class="md-setup-steps"><li><h2>Install Mind Diary</h2><p>Install it from the available Marketplace.</p></li><li><h2>Authenticate for reading</h2><p>Ask Codex to read from Mind Diary. Approve the native read permission when it opens.</p></li><li><h2>Choose readable Minds and start</h2><p>Choose the Minds Codex may read, then use the starter prompt below. When you first ask Codex to add or change a Memory, it opens a separate write permission step; after approval, choose at most one writable Mind.</p></li></ol><section class="md-setup-card"><h2>If something does not work</h2><p>Open <a href="/settings/connections">Connections</a> to check current access. A read-only connection intentionally has no write selector. If Codex cannot write, ask it to add or change a Memory so the separate write permission can begin. Revoke and reconnect only when the connection is no longer usable.</p><p>Use <a href="/settings/developer/mcp">Advanced MCP</a> only for personal tokens, endpoint configuration, or protocol diagnostics.</p></section><section aria-labelledby="codex-scenarios-heading"><div class="md-section-heading"><div><p class="md-eyebrow">Choose one scenario</p><h2 id="codex-scenarios-heading">Starter and recovery prompts</h2></div></div>${playbooks}</section></main>
    ${renderMindDiaryAuthenticatedFooter("help")}
  </div>`);
}
