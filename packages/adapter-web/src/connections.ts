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

export interface SafeConnectionMind {
  readonly name: string;
  readonly route: string;
  readonly visibility: "private" | "unlisted" | "public";
  readonly canWrite: boolean;
}

export interface SafeCredentialAccess {
  readonly targetVersion: number;
  readonly readableMinds: readonly SafeConnectionMind[];
  readonly writableMind?: SafeConnectionMind | null;
  readonly writableTargetState:
    | "not_selected"
    | "selected"
    | "unavailable"
    | "reconsent_required"
    | "reissue_required";
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
  return `<article class="md-token-card md-entity-row" data-ia-row>
    <div class="md-token-card__heading">
      <div><h3><a href="${href}">${escapeUntrustedText(item.clientName)}</a></h3><p>Connected app</p></div>
      <span class="md-token-state md-token-state--active">● Connected</span>
    </div>
    <dl class="md-token-card__metadata">
      <div><dt>Can read</dt><dd>${item.canRead ? `${item.readableMindCount} available` : "No"}</dd></div>
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
    collection = `<section class="md-state md-state--loading" aria-busy="true" data-connections-collection data-collection-state="loading" data-ia-route-state="loading"><h2>Loading connections</h2><p role="status" aria-live="polite">Opening current access…</p></section>`;
  } else if (model.collection.kind === "error") {
    collection = `<section class="md-state md-state--error" role="alert" data-connections-collection data-collection-state="error" data-ia-route-state="error"><h2>Connections are unavailable</h2><p>${escapeUntrustedText(model.collection.message)}</p><a class="md-button md-button--secondary" href="/settings/connections">Try again</a></section>`;
  } else if (model.collection.kind === "empty") {
    collection = `<section class="md-state md-state--empty" data-connections-collection data-collection-state="empty" data-ia-route-state="empty"><h2>No active connections</h2><p>Install Mind Diary from the available Marketplace, then ask Codex to use one of your Minds. Codex will open the read consent when it first needs access.</p><a class="md-button md-button--primary" href="${MIND_DIARY_CODEX_HELP_ROUTE}" data-ia-primary-action>Open the three-step guide</a></section>`;
  } else {
    collection = `<section aria-labelledby="connections-heading" data-connections-collection data-collection-state="ready" data-ia-collection><h2 id="connections-heading">Active connections</h2><div class="md-token-grid">${model.collection.items.map(renderConnectionCard).join("")}</div>${nextLink("/settings/connections", model.collection.nextCursor, "Next connections")}</section>`;
  }
  return document("Connections", `<div class="md-shell" data-mind-diary-shell data-ia-shell data-connections-page data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "connections")}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Codex access</p><h1>Connections</h1><p>See what is connected, which Minds it can read, and whether one writable Mind is selected.</p></div></div>
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

function renderOrdinaryConnectionAccess(
  access: SafeCredentialAccess,
  connectionRef: string,
  canWrite: boolean,
): string {
  if (
    !CONNECTION_REF.test(connectionRef) ||
    !Number.isSafeInteger(access.targetVersion) ||
    access.targetVersion < 0
  ) {
    return `<section class="md-state md-state--error" role="alert"><h2>Mind access is unavailable</h2><p>Reload before changing this connection.</p></section>`;
  }
  const endpoint = `/api/v1/connections/${connectionRef}/mind-access`;
  const readableCount = access.readableMinds.length;
  const readableSummary = readableCount === 0
    ? "No Minds are readable with your current access."
    : `${readableCount} ${readableCount === 1 ? "Mind is" : "Minds are"} readable with your current access.`;
  const writableOptions = access.eligibleMinds
    .filter((mind) => mind.canWrite)
    .map((mind) => {
      const route = safeMindRoute(mind.route);
      return route === null
        ? ""
        : `<option value="${escapeUntrustedText(route)}">${escapeUntrustedText(mind.name)} — ${escapeUntrustedText(route)}</option>`;
    })
    .join("");
  const targetSummary =
    access.writableTargetState === "selected" &&
    access.writableMind !== null && access.writableMind !== undefined
      ? renderMind(access.writableMind)
      : access.writableTargetState === "unavailable"
        ? '<p><strong>Unavailable</strong></p><p>The former target is disabled because current access no longer permits it. Its metadata stays hidden.</p>'
        : access.writableTargetState === "reconsent_required"
          ? '<p><strong>Reconnect required</strong></p><p>Reconnect this app before choosing a new writable Mind. The former target is not used.</p>'
          : '<p><strong>Not selected</strong></p><p>No Mind receives changes. My Mind is never selected automatically.</p>';
  const targetMutable = access.writableTargetState !== "reconsent_required" &&
    access.writableTargetState !== "reissue_required";
  const hasSelectedTarget = access.writableTargetState === "selected" ||
    access.writableTargetState === "unavailable";
  const selector = canWrite && targetMutable && writableOptions.length > 0
    ? `<form data-access-form data-access-action="select_write"><label>${hasSelectedTarget ? "Switch" : "Select"} writable Mind<select name="mind_ref" required><option value="">Choose a Mind</option>${writableOptions}</select></label><button class="md-button md-button--secondary" type="submit">${hasSelectedTarget ? "Switch" : "Select"}</button></form>`
    : canWrite && targetMutable
      ? '<p>No currently writable Minds are available.</p>'
      : "";
  const clear = hasSelectedTarget && targetMutable
    ? '<button class="md-button md-button--secondary" type="button" data-access-action="clear_write">Clear writable Mind</button>'
    : "";
  const writable = canWrite
    ? `<section aria-labelledby="connection-write-access-heading"><h2 id="connection-write-access-heading">Can add and change</h2>${targetSummary}<div class="md-binding-controls">${selector}${clear}</div></section>`
    : hasSelectedTarget
      ? `<section aria-labelledby="connection-write-recovery-heading"><h2 id="connection-write-recovery-heading">Previous writable Mind</h2>${targetSummary}<p>This connection cannot write now. Clearing only removes the disabled selection.</p>${clear}</section>`
      : '<section aria-labelledby="connection-write-access-heading"><h2 id="connection-write-access-heading">Can add and change</h2><p>No. Ask Codex to add or change a Memory to start the separate write permission step.</p></section>';

  return `<section class="md-binding-panel" data-access-panel data-access-endpoint="${endpoint}" data-target-version="${access.targetVersion}">
    <section aria-labelledby="connection-read-access-heading"><h2 id="connection-read-access-heading">Can read</h2><p>${escapeUntrustedText(readableSummary)} Access follows current membership and visibility automatically.</p></section>
    ${writable}
    <p class="md-form__status" role="status" aria-live="polite" data-access-status></p>
  </section>`;
}

function renderAdvancedTokenAccess(
  access: SafeCredentialAccess,
  input: {
    readonly personalTokenRef: string;
    readonly canWrite: boolean;
    readonly headingSuffix: string;
  },
): string {
  if (
    !PERSONAL_TOKEN_REF.test(input.personalTokenRef) ||
    !/^[a-z0-9-]{1,40}$/u.test(input.headingSuffix) ||
    !Number.isSafeInteger(access.targetVersion) || access.targetVersion < 0
  ) {
    return `<section class="md-state md-state--error" role="alert"><h2>Mind access is unavailable</h2><p>Reload before changing this credential.</p></section>`;
  }
  const base = `/api/v1/mcp-tokens/${input.personalTokenRef}`;
  const readableCount = access.readableMinds.length;
  const readableSummary = readableCount === 0
    ? "No Minds are currently readable."
    : `${readableCount} ${readableCount === 1 ? "Mind is" : "Minds are"} currently readable.`;
  const writableOptions = access.eligibleMinds.filter((mind) => mind.canWrite).map((mind) => {
    const route = safeMindRoute(mind.route);
    return route === null ? "" : `<option value="${escapeUntrustedText(route)}">${escapeUntrustedText(mind.name)} — ${escapeUntrustedText(route)}</option>`;
  }).join("");
  const targetSummary = access.writableTargetState === "selected" && access.writableMind !== null && access.writableMind !== undefined
    ? renderMind(access.writableMind)
    : access.writableTargetState === "unavailable"
      ? '<p><strong>Access unavailable</strong></p><p>Mind metadata is hidden because current access no longer permits it. You can still clear this selection.</p>'
      : access.writableTargetState === "reconsent_required"
        ? '<p><strong>Reconnect required</strong></p><p>Reconnect this app to upgrade its write access. The existing target is not used until that succeeds.</p>'
        : access.writableTargetState === "reissue_required"
          ? '<p><strong>Reissue required</strong></p><p>Create a new personal token. Legacy write access is not transferred to the new token.</p>'
          : '<p><strong>Not selected</strong></p><p>No Mind receives changes. My Mind is never selected automatically.</p>';
  const targetMutable = access.writableTargetState !== "reconsent_required" && access.writableTargetState !== "reissue_required";
  const hasSelectedTarget = access.writableTargetState === "selected" || access.writableTargetState === "unavailable";
  const readHeading = `token-read-access-${input.headingSuffix}`;
  const writeHeading = `token-write-access-${input.headingSuffix}`;
  const selector = targetMutable && writableOptions.length > 0
    ? `<form data-access-form data-access-action="select_write"><label>${hasSelectedTarget ? "Switch" : "Select"} writable Mind<select name="mind_ref" required><option value="">Choose a Mind</option>${writableOptions}</select></label><button class="md-button md-button--secondary" type="submit">${hasSelectedTarget ? "Switch" : "Select"}</button></form>`
    : targetMutable
      ? '<p>No currently writable Minds are available.</p>'
      : "";
  const write = input.canWrite
    ? `<section aria-labelledby="${writeHeading}"><h4 id="${writeHeading}">Writable target</h4>${targetSummary}${targetMutable ? `<div class="md-binding-controls">${selector}${hasSelectedTarget ? `<button class="md-button md-button--secondary" type="button" data-access-action="clear_write">Clear writable Mind</button>` : ""}</div>` : ""}</section>`
    : hasSelectedTarget
      ? `<section aria-labelledby="${writeHeading}"><h4 id="${writeHeading}">Previous writable target</h4>${targetSummary}<p>This token can no longer write, but you can clear the old selection.</p><button class="md-button md-button--secondary" type="button" data-access-action="clear_write">Clear writable Mind</button></section>`
      : "";
  return `<section class="md-binding-panel" data-access-panel data-access-endpoint="${base}/mind-access" data-target-version="${access.targetVersion}">
    <section aria-labelledby="${readHeading}"><h4 id="${readHeading}">Readable access</h4><p>${escapeUntrustedText(readableSummary)} This always follows current membership and visibility; there is no read selector.</p></section>
    ${write}
    <p class="md-form__status" role="status" aria-live="polite" data-access-status></p>
  </section>`;
}

export function renderConnectionDetailDocument(model: ConnectionDetailModel): string {
  const connection = model.connection;
  if (!CONNECTION_REF.test(connection.connectionRef)) throw new TypeError("connection ref is invalid");
  return document(`${connection.clientName} connection`, `<div class="md-shell" data-mind-diary-shell data-ia-shell data-connection-detail data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "connections")}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <p><a href="/settings/connections">← Connections</a></p>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Connected app</p><h1>${escapeUntrustedText(connection.clientName)}</h1><p>Connected ${escapeUntrustedText(dateLabel(connection.createdAt))}; last used ${escapeUntrustedText(dateLabel(connection.lastUsedAt))}.</p></div><span class="md-token-state md-token-state--active">● Connected</span></div>
      ${renderOrdinaryConnectionAccess(connection.access, connection.connectionRef, connection.canWrite)}
      <section class="md-setup-card" aria-labelledby="disconnect-heading"><h2 id="disconnect-heading">Disconnect</h2><p>Revoking stops this app immediately and removes it from Connections.</p><button class="md-button md-button--danger" type="button" data-revoke-connection data-revoke-endpoint="/api/v1/connections/${connection.connectionRef}">Revoke connection</button><p class="md-form__status" role="status" aria-live="polite" data-revoke-status></p></section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("connections")}
  </div>`);
}

function renderPersonalToken(token: PersonalTokenItem, index: number): string {
  if (!PERSONAL_TOKEN_REF.test(token.personalTokenRef)) return "";
  const canWrite = token.scopes.includes("content:write");
  return `<article class="md-token-card" data-personal-token>
    <div class="md-token-card__heading"><div><h3>${escapeUntrustedText(token.name)}</h3><p><code>${escapeUntrustedText(token.displayPrefix)}</code></p></div><span class="md-token-state md-token-state--${token.state}">${escapeUntrustedText(token.state)}</span></div>
    <dl class="md-token-card__metadata"><div><dt>Scopes</dt><dd>${canWrite ? "content:read, content:write" : "content:read"}</dd></div><div><dt>Expires</dt><dd>${escapeUntrustedText(dateLabel(token.expiresAt))}</dd></div><div><dt>Last used</dt><dd>${escapeUntrustedText(dateLabel(token.lastUsedAt))}</dd></div></dl>
    ${token.state === "active" && token.access !== undefined ? renderAdvancedTokenAccess(token.access, { personalTokenRef: token.personalTokenRef, canWrite, headingSuffix: `item-${index + 1}` }) : ""}
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
  return document("Advanced MCP", `<div class="md-shell" data-mind-diary-shell data-ia-shell data-advanced-mcp data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "tokens")}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Advanced</p><h1>Advanced MCP</h1><p>Personal tokens, exact endpoints, and protocol-oriented recovery. Marketplace connections live under <a href="/settings/connections">Connections</a>.</p></div></div>
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
  const marketplaceUrl = "https://github.com/xxsrez/marketplace";
  const cliInstall = "codex plugin marketplace add xxsrez/marketplace\ncodex plugin add mind-diary@srez-marketplace";
  const readOnlySmoke = "Use Mind Diary to list the Minds I can read. Do not create or change any Memory.";
  return document("Help with Codex", `<div class="md-shell" data-mind-diary-shell data-ia-shell data-codex-help data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(displayName, "help")}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Three steps</p><h1>Use Mind Diary with Codex</h1><p>Install the plugin first. Your account connection is a separate OAuth-on-first-use step.</p></div></div>
      <div class="md-client-tabs" role="tablist" aria-label="Choose a Codex setup path">
        <button class="md-button md-button--secondary" id="codex-client-desktop-tab" type="button" role="tab" aria-selected="true" aria-controls="codex-client-desktop-panel" tabindex="0" data-codex-client-tab="desktop">Desktop</button>
        <button class="md-button md-button--secondary" id="codex-client-cli-tab" type="button" role="tab" aria-selected="false" aria-controls="codex-client-cli-panel" tabindex="-1" data-codex-client-tab="cli">CLI</button>
      </div>
      <section class="md-client-panel" id="codex-client-desktop-panel" role="tabpanel" aria-labelledby="codex-client-desktop-tab" data-codex-client-panel="desktop">
        <ol class="md-setup-steps">
          <li data-copy-region><h2>Install Mind Diary</h2><p>Open <strong>Plugins</strong>, choose <strong>Add marketplace</strong>, paste this repository, and add it. In <strong>Srez Marketplace</strong>, open <strong>Mind Diary UAT</strong> and choose <strong>Install</strong>.</p><pre><code id="codex-help-desktop-marketplace" tabindex="-1" data-code-value>${escapeUntrustedText(marketplaceUrl)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-desktop-marketplace">Copy Marketplace URL</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p><strong>Success:</strong> the plugin card says <strong>Installed</strong>. This confirms the plugin package, not an account connection.</p></li>
          <li data-copy-region><h2>Authenticate for reading</h2><p>Start a new Task and send the read-only check below. The first read opens <strong>Authenticate</strong> or <strong>Connect</strong>. Sign in with the same account and workspace you use for this Mind Diary Site, then approve reading.</p><pre><code id="codex-help-desktop-smoke" tabindex="-1" data-code-value>${escapeUntrustedText(readOnlySmoke)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-desktop-smoke">Copy read-only check</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p><strong>Success:</strong> Mind Diary appears in <a href="/settings/connections">Connections</a>. That connection is created only after consent.</p></li>
          <li><h2>Discover readable Minds and start</h2><p>Readable Minds follow your current memberships and visibility automatically; there is no read attachment step. In a fresh Task, run the same read-only check. Success is a bounded list of currently readable Minds; no Memory is created or changed.</p></li>
        </ol>
      </section>
      <section class="md-client-panel" id="codex-client-cli-panel" role="tabpanel" aria-labelledby="codex-client-cli-tab" data-codex-client-panel="cli">
        <ol class="md-setup-steps">
          <li data-copy-region><h2>Install Mind Diary</h2><p>Run these commands as written. The first adds <strong>Srez Marketplace</strong>; the second installs the <strong>Mind Diary</strong> plugin.</p><pre><code id="codex-help-cli-install" tabindex="-1" data-code-value>${escapeUntrustedText(cliInstall)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-cli-install">Copy CLI install commands</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p><p><strong>Success:</strong> <code>codex plugin list</code> shows <code>mind-diary@srez-marketplace</code> as installed and enabled. This is still separate from the account connection.</p></li>
          <li><h2>Authenticate for reading</h2><p>Run <code>codex</code> and ask Mind Diary to read. The first read opens <strong>Authenticate</strong>. Sign in with the same account and workspace you use for this Mind Diary Site, then approve reading.</p></li>
          <li data-copy-region><h2>Discover readable Minds and start</h2><p>Readable Minds follow your current memberships and visibility automatically; there is no read attachment step. Enter <code>/new</code>, then send this safe check. Success is a bounded list of currently readable Minds; no Memory is created or changed.</p><pre><code id="codex-help-cli-smoke" tabindex="-1" data-code-value>${escapeUntrustedText(readOnlySmoke)}</code></pre><button class="md-button md-button--secondary" type="button" data-copy-code="codex-help-cli-smoke">Copy read-only check</button><p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p></li>
        </ol>
      </section>
      <section class="md-setup-card md-setup-card--single" aria-labelledby="codex-help-troubleshooting"><div><p class="md-eyebrow">Checkpoint help</p><h2 id="codex-help-troubleshooting">If a step does not finish</h2><ul><li><strong>Marketplace:</strong> compare the repository exactly. Add it once, then reload Plugins once.</li><li><strong>Install:</strong> confirm the plugin says Installed and start a fresh Task. Installed does not mean connected.</li><li><strong>Authenticate:</strong> repeat the read-only check in a fresh Task and confirm the same account and workspace. Then check <a href="/settings/connections">Connections</a>.</li><li><strong>Readable Minds:</strong> check your current membership or visibility on the Mind Diary Site. Read access is derived automatically and is never attached in Connections.</li></ul><p>Revoke and reconnect only when the existing connection is no longer usable.</p></div></section>
      <section class="md-setup-card md-setup-card--single" aria-labelledby="codex-help-first-memory"><p class="md-eyebrow">After the read-only check</p><h2 id="codex-help-first-memory">Create the first useful Memory</h2><p>Writing is optional. Before a content change, open <a href="/settings/connections">Connections</a> and select at most one writable Mind there. Only the Mind Diary Site can select, switch, or clear this target; Codex cannot manage it through content MCP.</p><p>Open My Mind and use its existing starter card. It keeps the first content change separate from installation and connection checks.</p><p><a class="md-button md-button--primary" href="/me#first-result-title">Open the starter card</a></p></section>
      <section class="md-setup-card md-setup-card--single"><h2>Advanced setup</h2><p><a href="/settings/developer/mcp">Advanced MCP</a> is the separate place for direct client setup and diagnostics. The ordinary plugin flow above does not require it.</p></section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("help")}
  </div>`);
}
