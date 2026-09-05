import {
  MIND_DIARY_FAVICON_LINKS,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  renderMindDiaryAuthenticatedFooter,
  renderMindDiaryAuthenticatedHeader,
} from "./ui-shell.js";

export const MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER =
  "https://<your-mind-diary-site>/api/mcp/2025-11-25" as const;
export const MIND_DIARY_MCP_MODERN_PATH = "/api/mcp" as const;
export const MIND_DIARY_MCP_COMPATIBILITY_PATH = "/api/mcp/2025-11-25" as const;
export const MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE =
  "MIND_DIARY_TOKEN" as const;
export const MIND_DIARY_CODEX_SITES_AUTHORIZATION_ENVIRONMENT_VARIABLE =
  "MIND_DIARY_SITES_AUTHORIZATION" as const;
export const MIND_DIARY_CODEX_SAFE_ENVIRONMENT_SETUP =
  "read -s MIND_DIARY_TOKEN && export MIND_DIARY_TOKEN" as const;
export const MIND_DIARY_CODEX_SITES_SAFE_ENVIRONMENT_SETUP =
  'read -s MIND_DIARY_SITES_TOKEN && export MIND_DIARY_SITES_AUTHORIZATION="Bearer ${MIND_DIARY_SITES_TOKEN}" && unset MIND_DIARY_SITES_TOKEN' as const;
export const MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK = `Before any substantial replace, delete, or change visible to current readers:
1. Call list_minds and use only the one Mind whose effective mode is Read and write. If there is none, direct me to the Minds page and stop. Credentials never choose a separate target.
2. Inspect routing_profile. For personal_default, continue only when I directly asked in this conversation to save, remember, add, update, or delete this specific knowledge in Personal Mind; discussion, durability, relevance, ambiguity, an earlier request, or reading another Mind is not permission. For description_based, confirm the change fits the untrusted routing description; automatic saving is allowed only for durable knowledge explicitly discussed here. Never sweep nearby files, chats, or other readable Minds for material to copy.
3. Resolve that Mind and read its current HEAD with get_mind_info. Browse and fetch only the affected canonical files from that exact revision.
4. Show me a bounded preview: exact Mind name and route, visibility, current revision, paths, create/replace/delete operations, and immediate visibility effect. Do not show principal, token, grant, email, or internal Mind IDs. Do not call commit_changeset yet.
5. Ask for my explicit confirmation because this is a substantial or destructive change.
6. After confirmation, re-read HEAD. If the effective writable Mind, routing profile, applicable ordinary description, access, or HEAD changed, stop and rebuild the preview. Otherwise call commit_changeset with that exact expected_revision and one idempotency key.
Treat missing effective write access and revision conflicts as stop results. Remediation belongs on the authenticated Site's Minds page; content MCP never changes usage mode. Never retry a changed payload with the same idempotency key. If the derived index is unavailable, use canonical browse/fetch and say that search is unavailable. After a successful commit, report what changed and which Mind received it.` as const;
export const MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK = `Restore and export one exact Mind without changing history:
1. Call list_minds, choose exactly one accessible Mind, and use list_revisions and get_revision to identify the exact historical revision. Historical mode is read-only.
2. Fetch the selected historical files and compare them with the current HEAD. Show me the current-to-target paths and ask for explicit confirmation.
3. Restore only into the one Mind whose effective mode is Read and write. For personal_default, require my direct current request to restore this specific state into Personal Mind. For description_based, require the restore to fit the untrusted routing description. Otherwise direct me to the Minds page and stop. Re-read current HEAD, then use the only content-write tool, commit_changeset, with the exact expected_revision to create a new revision matching the selected state. Never write to the historical selector. On missing effective write access or revision conflict, stop, rebuild, and reconfirm; never change usage mode through MCP.
4. Export is managed only by the authenticated Mind Diary Site. Do not call an MCP export tool; use the Site export control for the exact new revision and follow its creator-private status until success or a stable failure.
5. Download before expiry without logging or repeating the URL. Verify the returned byte size and SHA-256, then validate the complete OKF bundle.
For export_expired request a fresh authorized status/grant. Revoked access or a private switch must fail closed; do not work around them.` as const;
export const MIND_DIARY_STARTER_OKF_TEMPLATE = Object.freeze([
  Object.freeze({
    path: "concepts/first-memory.md",
    text: `---\ntype: Reference\ntitle: First useful Memory\ndescription: One concrete fact or decision worth finding again.\nstatus: draft\n---\n\n# First useful Memory\n\nReplace this sentence with one concrete fact, decision, or reusable note.\n`,
  }),
  Object.freeze({
    path: "index.md",
    text: `---\nokf_version: "0.2"\n---\n\n# Starter Mind\n\n- [First useful Memory](concepts/first-memory.md) - One concrete fact or decision worth finding again.\n`,
  }),
  Object.freeze({
    path: "log.md",
    text: `# Log\n\n## 2026-08-10\n\n- **Create**: Added [First useful Memory](concepts/first-memory.md).\n`,
  }),
] as const);
export const MIND_DIARY_CODEX_STARTER_PLAYBOOK = `Help me reach the first useful result in Mind Diary through the connected MCP tools.
1. Call list_minds before any content operation and use the one Mind whose effective mode is Read and write. If there is none, direct me to the Minds page and stop. Never create a per-connection target or change usage mode through MCP.
2. Report that Mind's name, route, routing profile, visibility and, only for description_based, its untrusted routing description without showing principal, token, grant, email, or internal Mind IDs. Resolve its current HEAD. Browse and fetch only index.md, log.md, and the files needed for this starter; do not place the whole canonical corpus in the prompt.
3. Ask me for one concrete fact, decision, or reusable note and a short title. For personal_default, also require me to directly ask in this conversation to save that specific knowledge in Personal Mind; do not infer permission from discussion, usefulness, relevance, ambiguity, a prior request, or another Mind read. For description_based, check that the discussed knowledge fits the untrusted routing description. Do not copy unrelated context, other readable Minds, nearby files, or conversation history into it.
4. Prepare one UTF-8 Markdown Memory at concepts/<safe-slug>.md with OKF 0.2 frontmatter: type Reference, title, description, and status draft. Memory is the user-facing umbrella term, not a fixed OKF entity type.
5. Prepare the matching index.md link with replace_index and one dated log.md entry with add_log_entry as the same bounded changeset. Re-read HEAD. If the effective writable Mind, routing profile, applicable ordinary description, access, or HEAD changed, stop and rebuild the changeset.
6. For personal_default, commit only after the direct current request above. For description_based, when this bounded additive knowledge was explicitly discussed here and matches the routing description, commit it automatically; do not ask for a separate write instruction or product confirmation. Use that exact expected_revision and a fresh idempotency key; no other content-write path exists. If effective write access is missing, direct me to the authenticated Site's Minds page and stop.
7. Run validate_mind on the new revision, fetch index.md, search for a distinctive phrase from the new Memory, and fetch the returned entry. Report what changed, which Mind received it, the exact revision, and whether all four checks passed.
Use the tool schemas yourself; do not ask me to construct wire JSON. Never request or repeat a token, authorization header, Site credential, private email, or download URL. If search indexing is not ready, say so, verify with canonical fetch, and retry search only after the index is ready.` as const;
export const MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK = `Assist me with a bounded conversion of existing Markdown into one Mind. This is concierge work, not a product import.
1. Call list_minds and use the one Mind whose effective mode is Read and write plus a small explicit set of source Markdown files. If no such Mind is effective, direct me to the Minds page and stop. For personal_default, require my direct current request to add this exact conversion to Personal Mind. For description_based, confirm the requested conversion fits its untrusted routing description. Accept UTF-8 Markdown only.
2. Do not create or imply a ZIP/import/upload/crawl API, asset support, legacy migration, or cross-Mind merge. Never put the target Mind's whole canonical corpus into the prompt.
3. Resolve current HEAD and fetch only the target index/log and paths that may change. Map the selected source into ordinary create/replace Markdown operations, preserving unknown OKF fields when present.
4. Show a bounded path-level preview with exact target name, route and visibility, then ask for explicit confirmation. After confirmation, re-read HEAD and commit with exact expected_revision plus a fresh idempotency key; stop if effective write access, routing profile, applicable ordinary description, rights, or revision changed and never change usage mode through MCP.
5. Validate the complete resulting bundle, then search and fetch one converted Memory as evidence. Keep tokens, credentials, email, private queries, content not selected for conversion, and download URLs out of the report.` as const;
export type MindDiaryMcpClientProfile = "modern" | "compatibility";

function canonicalSiteOrigin(value: string): string {
  const candidate = new URL(value);
  const localhost = candidate.hostname === "localhost" || candidate.hostname === "127.0.0.1";
  if (
    candidate.origin !== value ||
    candidate.username.length > 0 ||
    candidate.password.length > 0 ||
    candidate.search.length > 0 ||
    candidate.hash.length > 0 ||
    !(candidate.protocol === "https:" || (candidate.protocol === "http:" && localhost))
  ) {
    throw new TypeError("site origin must be canonical HTTPS or loopback HTTP");
  }
  return candidate.origin;
}

export function mindDiaryMcpEndpoint(
  siteOrigin: string,
  profile: MindDiaryMcpClientProfile,
): string {
  return `${canonicalSiteOrigin(siteOrigin)}${profile === "modern"
    ? MIND_DIARY_MCP_MODERN_PATH
    : MIND_DIARY_MCP_COMPATIBILITY_PATH}`;
}

export function mindDiaryCodexConfig(
  siteOrigin: string,
  profile: MindDiaryMcpClientProfile,
): string {
  return `[mcp_servers.mind_diary]
url = "${mindDiaryMcpEndpoint(siteOrigin, profile)}"
bearer_token_env_var = "${MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE}"
required = true

[mcp_servers.mind_diary.env_http_headers]
OAI-Sites-Authorization = "${MIND_DIARY_CODEX_SITES_AUTHORIZATION_ENVIRONMENT_VARIABLE}"`;
}

export const MIND_DIARY_CODEX_CONFIG = `[mcp_servers.mind_diary]
url = "${MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER}"
bearer_token_env_var = "${MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE}"
required = true

[mcp_servers.mind_diary.env_http_headers]
OAI-Sites-Authorization = "${MIND_DIARY_CODEX_SITES_AUTHORIZATION_ENVIRONMENT_VARIABLE}"` as const;

export type McpTokenUiState = "active" | "expired" | "revoked";
export type McpTokenUiScope = "content:read" | "content:write" | "personal:configure";

/** Metadata safe to list or render. Secret and verifier fields are absent by design. */
export interface McpTokenUiToken {
  readonly tokenId: string;
  readonly name: string;
  readonly displayPrefix: string;
  readonly scopes: readonly McpTokenUiScope[];
  readonly state: McpTokenUiState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export type McpTokenCollectionState =
  | { readonly kind: "ready"; readonly tokens: readonly McpTokenUiToken[] }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export interface OAuthConnectionUiItem {
  readonly grantId: string;
  readonly clientName: string;
  readonly scopes: readonly McpTokenUiScope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export type OAuthConnectionCollectionState =
  | { readonly kind: "ready"; readonly connections: readonly OAuthConnectionUiItem[] }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export interface McpTokenManagementModel {
  readonly displayName: string;
  readonly collection: McpTokenCollectionState;
  readonly oauthConnections?: OAuthConnectionCollectionState;
  readonly siteOrigin?: string;
  readonly announcement?: string;
}

export interface McpTokenIssueCommand {
  readonly name: string;
  readonly scopes: readonly McpTokenUiScope[];
  readonly expiresAt: string;
}

export interface OneTimeUiTokenSecret {
  consumeSecret(): string | null;
}

export interface McpTokenIssueResult {
  readonly token: McpTokenUiToken;
  readonly secret: OneTimeUiTokenSecret;
}

export interface McpTokenManagementAdapter {
  listTokens(): Promise<readonly McpTokenUiToken[]>;
  issueToken(command: McpTokenIssueCommand): Promise<McpTokenIssueResult>;
  revokeToken(tokenId: string): Promise<McpTokenUiToken>;
}

export interface McpTokenManagementInstallOptions {
  readonly now?: () => Date;
}

const TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PREFIX_PATTERN = /^mdp_v1_[A-Za-z0-9_-]{6}…$/u;

function safeTokenId(value: string): string | null {
  return TOKEN_ID_PATTERN.test(value) ? value : null;
}

function safeDisplayPrefix(value: string): string {
  return PREFIX_PATTERN.test(value) ? value : "Unavailable";
}

function effectiveScopeLabel(scopes: readonly McpTokenUiScope[]): string {
  return Array.isArray(scopes) && scopes.includes("content:write")
    ? "Read and write"
    : "Read only";
}

function safeTokenState(state: McpTokenUiState): McpTokenUiState {
  return state === "active" || state === "expired" || state === "revoked"
    ? state
    : "revoked";
}

function stateLabel(state: McpTokenUiState): string {
  switch (state) {
    case "active":
      return "Active";
    case "expired":
      return "Expired";
    case "revoked":
      return "Revoked";
  }
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

function renderPrincipalMindUsageNotice(
  scopes: readonly McpTokenUiScope[],
): string {
  const canWrite = scopes.includes("content:write");
  return `<section class="md-credential-mode-panel" data-principal-mind-usage-notice>
    <h4>Account-wide Mind modes</h4>
    <p>This credential can read. ${canWrite ? "Its write scope can also be used when the one account-wide Read and write mode and current rights allow it. Personal Mind still requires a direct request for each specific write; ordinary Minds keep description-based automatic saving." : "It has no write scope."}</p>
    <p>Credentials do not select Minds or own a separate automatic-save setting.</p>
    <p><a href="/minds#mind-usage-heading">Manage Mind modes</a></p>
  </section>`;
}

function renderTokenCard(token: McpTokenUiToken): string {
  const tokenId = safeTokenId(token.tokenId);
  const safeState = safeTokenState(token.state);
  const state = stateLabel(safeState);
  const action =
    safeState === "active" && tokenId !== null
      ? `<button class="md-button md-button--danger" type="button" data-revoke-token="${escapeUntrustedText(tokenId)}">Revoke</button>`
      : `<span class="md-token-card__final-state">${state}</span>`;
  return `<article class="md-token-card" tabindex="-1" data-token-card="${escapeUntrustedText(tokenId ?? "invalid-token-id")}" data-token-state="${safeState}">
    <div class="md-token-card__heading">
      <div>
        <h3>${escapeUntrustedText(token.name)}</h3>
        <code data-token-prefix>${escapeUntrustedText(safeDisplayPrefix(token.displayPrefix))}</code>
      </div>
      <span class="md-token-state md-token-state--${safeState}"><span aria-hidden="true">${safeState === "active" ? "●" : "○"}</span> ${state}</span>
    </div>
    <dl class="md-token-card__metadata">
      <div><dt>Access</dt><dd>${effectiveScopeLabel(token.scopes)}</dd></div>
      <div><dt>Expires</dt><dd>${dateLabel(token.expiresAt)}</dd></div>
      <div><dt>Last used</dt><dd>${dateLabel(token.lastUsedAt)}</dd></div>
    </dl>
    ${safeState === "active" ? renderPrincipalMindUsageNotice(token.scopes) : ""}
    <div class="md-token-card__action">${action}</div>
  </article>`;
}

function renderOAuthConnections(
  collection: OAuthConnectionCollectionState | undefined,
): string {
  if (collection === undefined) return "";
  if (collection.kind === "error") {
    return `<section class="md-setup-card" aria-labelledby="connected-apps-heading"><h2 id="connected-apps-heading">Connected apps</h2><p role="alert">${escapeUntrustedText(collection.message)}</p></section>`;
  }
  if (collection.kind === "empty") {
    return `<section class="md-setup-card" aria-labelledby="connected-apps-heading"><h2 id="connected-apps-heading">Connected apps</h2><p>No OAuth apps are connected. Installing Mind Diary from your marketplace will add one here after consent.</p></section>`;
  }
  const cards = collection.connections.map((connection) => {
    const grantId = /^md_oauth_grant_[0-9a-f-]{36}$/iu.test(connection.grantId)
      ? connection.grantId
      : null;
    const access = connection.scopes.includes("content:write") ? "Read and write" : "Read only";
    return `<article class="md-token-card" data-oauth-connection="${escapeUntrustedText(grantId ?? "invalid")}"><div class="md-token-card__heading"><div><h3>${escapeUntrustedText(connection.clientName)}</h3><p>${escapeUntrustedText(access)}</p></div><span class="md-token-state md-token-state--active">● Connected</span></div><dl class="md-token-card__metadata"><div><dt>Connected</dt><dd>${escapeUntrustedText(dateLabel(connection.createdAt))}</dd></div><div><dt>Last used</dt><dd>${escapeUntrustedText(dateLabel(connection.lastUsedAt))}</dd></div></dl>${renderPrincipalMindUsageNotice(connection.scopes)}<div class="md-token-card__action">${grantId === null ? "" : `<button class="md-button md-button--danger" type="button" data-revoke-oauth="${escapeUntrustedText(grantId)}">Revoke connection</button>`}<p class="md-form__status" role="status" aria-live="polite" data-oauth-revoke-status></p></div></article>`;
  }).join("");
  return `<section class="md-setup-card" aria-labelledby="connected-apps-heading"><div class="md-section-heading"><div><p class="md-eyebrow">OAuth</p><h2 id="connected-apps-heading">Connected apps</h2></div></div><p>Connections use short-lived access tokens and rotating refresh tokens. Revoking stops the app immediately.</p><div class="md-token-grid">${cards}</div></section>`;
}

function renderTokenCollection(
  collection: McpTokenCollectionState,
): string {
  switch (collection.kind) {
    case "loading":
      return `<section class="md-state md-state--loading" aria-labelledby="tokens-heading" aria-busy="true" data-token-collection>
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="tokens-heading">Loading MCP tokens</h2>
        <p role="status" aria-live="polite">Checking token metadata…</p>
      </section>`;
    case "empty":
      return `<section class="md-state md-state--empty" aria-labelledby="tokens-heading" data-token-collection>
        <span class="md-state__symbol" aria-hidden="true">⌁</span>
        <h2 id="tokens-heading">No MCP tokens yet</h2>
        <p>Create a named token when you are ready to connect Codex. A token works across the Minds you can currently access.</p>
        <a class="md-button md-button--primary" href="#create-token">Create a token</a>
      </section>`;
    case "error":
      return `<section class="md-state md-state--error" aria-labelledby="tokens-heading" role="alert" data-token-collection>
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="tokens-heading">We couldn’t load MCP tokens</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-token-retry>Try again</button>
      </section>`;
    case "ready":
      return `<section aria-labelledby="tokens-heading" data-token-collection>
        <div class="md-section-heading">
          <div>
            <p class="md-eyebrow">Safe metadata only</p>
            <h2 id="tokens-heading">Your tokens</h2>
          </div>
          <a class="md-button md-button--primary" href="#create-token">Create a token</a>
        </div>
        <div class="md-token-grid" data-token-list>${collection.tokens.map(renderTokenCard).join("")}</div>
      </section>`;
  }
}

function renderCreateForm(): string {
  return `<section class="md-setup-card" id="create-token" aria-labelledby="create-token-heading">
    <div>
      <p class="md-eyebrow">Personal access</p>
      <h2 id="create-token-heading">Create an MCP token</h2>
      <p>Name the device or client so you can revoke it later. The secret is shown once and cannot be recovered.</p>
    </div>
    <form class="md-token-form" data-token-form>
      <div class="md-field">
        <label for="token-name">Token name</label>
        <input id="token-name" name="name" type="text" required maxlength="80" autocomplete="off" placeholder="Codex on Mac">
      </div>
      <div class="md-field">
        <label for="token-access">Access</label>
        <select id="token-access" name="access" required>
          <option value="content:read">Read only</option>
          <option value="content:write">Read and write</option>
        </select>
        <p>Read and write always includes read access. A write-only token is not available.</p>
      </div>
      <div class="md-field">
        <label for="token-expiry">Expires after</label>
        <select id="token-expiry" name="expiry_days" required>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90" selected>90 days</option>
        </select>
      </div>
      <p class="md-form__status" role="status" aria-live="polite" data-token-form-status></p>
      <button class="md-button md-button--primary" type="submit" data-token-submit>Create token</button>
    </form>
  </section>`;
}

function setupOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return canonicalSiteOrigin(value);
  } catch {
    return null;
  }
}

function setupConfig(
  origin: string | null,
  profile: MindDiaryMcpClientProfile,
): string {
  if (origin !== null) return mindDiaryCodexConfig(origin, profile);
  const endpoint = profile === "modern"
    ? "https://<your-mind-diary-site>/api/mcp"
    : MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER;
  return MIND_DIARY_CODEX_CONFIG.replace(MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER, endpoint);
}

function renderCodexSetup(siteOrigin: string | undefined): string {
  const origin = setupOrigin(siteOrigin);
  const compatibility = setupConfig(origin, "compatibility");
  const modern = setupConfig(origin, "modern");
  return `<section class="md-setup-card" aria-labelledby="codex-setup-heading">
    <div>
      <p class="md-eyebrow">Setup guide</p>
      <h2 id="codex-setup-heading">Connect Codex without saving the token</h2>
      <p>Keep the secret outside your repository and Codex config. Put only the environment variable name in the config.</p>
    </div>
    <ol class="md-setup-steps">
      <li>
        <h3>Set the secret privately for this shell</h3>
        <pre><code>${escapeUntrustedText(MIND_DIARY_CODEX_SAFE_ENVIRONMENT_SETUP)}</code></pre>
        <p>Paste the secret only at the hidden prompt. For longer use, choose a trusted secret manager or a protected local profile outside the repository.</p>
      </li>
      <li>
        <h3>Set the Sites audience credential for a restricted Site</h3>
        <pre><code>${escapeUntrustedText(MIND_DIARY_CODEX_SITES_SAFE_ENVIRONMENT_SETUP)}</code></pre>
        <p>Ask the Site owner or release coordinator for this separate credential. The environment variable must contain the complete <code>Bearer &lt;secret&gt;</code> header value; it never replaces the Mind Diary token.</p>
      </li>
      <li>
        <h3>Default Codex 0.147 compatibility profile</h3>
        <pre><code id="mind-diary-compatibility-config" tabindex="-1" data-code-value>${escapeUntrustedText(compatibility)}</code></pre>
        <button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-compatibility-config">Copy compatibility config</button>
        <p>This profile uses isolated MCP <code>2025-11-25</code> lifecycle at the exact compatibility endpoint.</p>
      </li>
      <li>
        <h3>Modern MCP 2026-07-28 profile</h3>
        <pre><code id="mind-diary-modern-config" tabindex="-1" data-code-value>${escapeUntrustedText(modern)}</code></pre>
        <button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-modern-config">Copy modern config</button>
        <p>Codex 0.147 requires opt-in <code>--enable mcp_2026_07_28</code> for this endpoint. Do not enable it while using the compatibility URL.</p>
      </li>
    </ol>
    <p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p>
    <p>Both configurations contain only endpoint and environment-variable names. Never replace either variable name with a secret. A public Site may omit the <code>env_http_headers</code> table.</p>
    <p class="md-caveat"><strong>UAT connector baseline:</strong> marketplace connections use OAuth Authorization Code with PKCE and short-lived tokens. Personal tokens remain available for direct Codex setup and recovery. This hosted environment is UAT, not production.</p>
  </section>`;
}

function renderRecoveryPlaybooks(): string {
  return `<section class="md-setup-card" aria-labelledby="recovery-playbooks-heading">
    <div>
      <p class="md-eyebrow">Safe recovery</p>
      <h2 id="recovery-playbooks-heading">Preview, restore and export with Codex</h2>
      <p>These prompts compose the existing MCP tools. They do not create a server draft, approval artifact, writable history or a new restore tool.</p>
    </div>
    <ol class="md-setup-steps">
      <li>
        <h3>Preview and confirm an immediate write</h3>
        <pre><code id="mind-diary-safe-write-playbook" tabindex="-1" data-code-value>${escapeUntrustedText(MIND_DIARY_CODEX_SAFE_WRITE_PLAYBOOK)}</code></pre>
        <button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-safe-write-playbook">Copy safe-write playbook</button>
        <p>Confirmation guides the client. Current ACL, token scope, full-bundle validation, HEAD CAS and idempotency remain the server authority.</p>
      </li>
      <li>
        <h3>Restore as a new revision and export it</h3>
        <pre><code id="mind-diary-restore-export-playbook" tabindex="-1" data-code-value>${escapeUntrustedText(MIND_DIARY_CODEX_RESTORE_EXPORT_PLAYBOOK)}</code></pre>
        <button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-restore-export-playbook">Copy restore and export playbook</button>
        <p>The selected historical revision stays immutable. A restore is an ordinary confirmed changeset that creates a new HEAD.</p>
      </li>
    </ol>
    <p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p>
    <dl class="md-card__metadata">
      <div><dt>Stale HEAD</dt><dd>Stop, re-read, rebuild and reconfirm.</dd></div>
      <div><dt>Index unavailable</dt><dd>Use canonical browse/fetch; never substitute stale search results.</dd></div>
      <div><dt>Export expired</dt><dd>Request a fresh authorized status/grant; never reuse the URL.</dd></div>
      <div><dt>Access revoked</dt><dd>Fail closed. Do not retry around current authorization.</dd></div>
    </dl>
    <p class="md-caveat">Download URLs and credentials are bearer material. Keep them out of prompts, repositories, issues, screenshots, logs and telemetry sinks.</p>
  </section>`;
}

function renderStarterPlaybooks(): string {
  return `<section class="md-setup-card" aria-labelledby="starter-playbooks-heading" data-starter-mind-guide>
    <div>
      <p class="md-eyebrow">First useful result</p>
      <h2 id="starter-playbooks-heading">Start one valid Mind with Codex</h2>
      <p>The strict starter is three UTF-8 Markdown files: one Memory, <code>index.md</code>, and <code>log.md</code>. Choose Personal or ordinary Mind; every operation stays in that one selected Mind.</p>
    </div>
    <ol class="md-setup-steps">
      <li>
        <h3>Create and prove the starter</h3>
        <pre><code id="mind-diary-starter-playbook" tabindex="-1" data-code-value>${escapeUntrustedText(MIND_DIARY_CODEX_STARTER_PLAYBOOK)}</code></pre>
        <button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-starter-playbook">Copy starter playbook</button>
      </li>
      <li>
        <h3>Convert a bounded existing Markdown set</h3>
        <pre><code id="mind-diary-concierge-playbook" tabindex="-1" data-code-value>${escapeUntrustedText(MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK)}</code></pre>
        <button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-concierge-playbook">Copy concierge playbook</button>
      </li>
    </ol>
    <p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p>
    <p class="md-caveat">This composes existing MCP read, write, validate, search, and fetch tools. It does not add productized import, non-Markdown files, or server-paid AI.</p>
  </section>`;
}

function renderSecretDialog(): string {
  return `<dialog class="md-dialog md-secret-dialog" id="mcp-token-secret-dialog" aria-labelledby="token-secret-title" aria-describedby="token-secret-description" data-secret-dialog>
    <div class="md-form">
      <div class="md-dialog__heading">
        <div>
          <p class="md-eyebrow">Shown once</p>
          <h2 id="token-secret-title">Copy your token now</h2>
        </div>
        <button class="md-icon-button" type="button" aria-label="Close one-time token" data-close-secret>×</button>
      </div>
      <p id="token-secret-description">After you close this window, Mind Diary cannot show or recover this secret.</p>
      <code class="md-secret-value" tabindex="-1" data-secret-value>Secret is not available.</code>
      <p class="md-form__status" role="status" aria-live="polite" data-copy-status></p>
      <section class="md-setup-card" aria-labelledby="mcp-self-check-title" data-mcp-self-check data-diagnostic-state="idle">
        <div>
          <p class="md-eyebrow">Redacted connection check</p>
          <h3 id="mcp-self-check-title">Test this token before closing</h3>
          <p>The check uses the current authenticated account, modern discovery and read-only <code>list_minds</code> on both profiles. It never renders or retains email, Mind names, IDs, queries, content, credentials or raw responses.</p>
        </div>
        <button class="md-button md-button--secondary" type="button" data-run-mcp-self-check disabled>Run redacted self-check</button>
        <p class="md-form__status" role="status" aria-live="polite" data-mcp-self-check-status>Available only while the one-time secret is visible.</p>
      </section>
      <div class="md-dialog__actions">
        <button class="md-button md-button--secondary" type="button" data-close-secret>Close permanently</button>
        <button class="md-button md-button--primary" type="button" data-copy-secret>Copy token</button>
      </div>
      <p class="md-caveat">Do not paste this value into a repository, Codex config, issue, chat, log, analytics field, or screenshot.</p>
    </div>
  </dialog>`;
}

function renderRevokeDialog(): string {
  return `<dialog class="md-dialog" id="revoke-mcp-token-dialog" aria-labelledby="revoke-token-title" aria-describedby="revoke-token-description" data-revoke-dialog>
    <div class="md-form">
      <div class="md-dialog__heading">
        <div>
          <p class="md-eyebrow">Immediate action</p>
          <h2 id="revoke-token-title">Revoke this token?</h2>
        </div>
        <button class="md-icon-button" type="button" aria-label="Cancel token revocation" data-cancel-revoke>×</button>
      </div>
      <p id="revoke-token-description">Codex requests using <strong data-revoke-name>this token</strong> will stop working immediately.</p>
      <p class="md-form__status" role="status" aria-live="polite" data-revoke-status></p>
      <div class="md-dialog__actions">
        <button class="md-button md-button--secondary" type="button" data-cancel-revoke>Keep token</button>
        <button class="md-button md-button--danger" type="button" data-confirm-revoke>Revoke token</button>
      </div>
    </div>
  </dialog>`;
}

export function renderMcpTokenManagement(
  model: McpTokenManagementModel,
): string {
  const announcement = model.announcement
    ? `<p class="md-announcement" role="status" aria-live="polite" data-page-announcement><span aria-hidden="true">✓</span> ${escapeUntrustedText(model.announcement)}</p>`
    : `<p class="md-announcement" role="status" aria-live="polite" data-page-announcement hidden></p>`;
  return `<div class="md-shell md-token-shell" data-mind-diary-shell data-ia-shell data-mind-diary-token-management data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "tokens")}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header>
        <div>
          <p class="md-eyebrow">Codex-first access</p>
          <h1>MCP setup</h1>
          <p>Create and revoke personal tokens. Choose account-wide Off, Read only, or Read and write modes on the Minds page; credential scopes and current rights can only narrow them.</p>
        </div>
        ${announcement}
      </div>
      <div class="md-token-layout">
        ${renderOAuthConnections(model.oauthConnections)}
        ${renderTokenCollection(model.collection)}
        ${renderCreateForm()}
        ${renderCodexSetup(model.siteOrigin)}
        ${renderStarterPlaybooks()}
        ${renderRecoveryPlaybooks()}
      </div>
    </main>
    ${renderMindDiaryAuthenticatedFooter("tokens")}
    ${renderSecretDialog()}
    ${renderRevokeDialog()}
  </div>`;
}

export function renderMcpTokenManagementDocument(
  model: McpTokenManagementModel,
  clientScript?: string,
): string {
  const safeClientScript =
    typeof clientScript === "string" &&
    /^\/[A-Za-z0-9][A-Za-z0-9/_-]*\.(?:js|mjs)$/u.test(clientScript)
      ? clientScript
      : null;
  const script = safeClientScript
    ? `\n  <script type="module" src="${escapeUntrustedText(safeClientScript)}"></script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  ${MIND_DIARY_FAVICON_LINKS}
  <title>MCP setup — Mind Diary</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderMcpTokenManagement(model)}${script}
</body>
</html>`;
}

function showDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }
}

function replaceTokenCollection(
  shell: HTMLElement,
  collection: McpTokenCollectionState,
): void {
  const current = shell.querySelector<HTMLElement>("[data-token-collection]");
  if (!current) return;
  const template = shell.ownerDocument.createElement("template");
  template.innerHTML = renderTokenCollection(collection);
  const next = template.content.firstElementChild;
  if (next) current.replaceWith(next);
}

function replaceTokenCard(shell: HTMLElement, token: McpTokenUiToken): void {
  const tokenId = safeTokenId(token.tokenId);
  if (tokenId === null) return;
  const current = shell.querySelector<HTMLElement>(
    `[data-token-card="${CSS.escape(tokenId)}"]`,
  );
  if (!current) return;
  const template = shell.ownerDocument.createElement("template");
  template.innerHTML = renderTokenCard(token);
  const next = template.content.firstElementChild;
  if (next) current.replaceWith(next);
}

function setAnnouncement(shell: HTMLElement, message: string): void {
  const announcement = shell.querySelector<HTMLElement>("[data-page-announcement]");
  if (!announcement) return;
  announcement.hidden = false;
  announcement.textContent = message;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 240);
  }
  return fallback;
}

export function installMcpTokenManagement(
  adapter: McpTokenManagementAdapter,
  root: Document | HTMLElement = document,
  options: McpTokenManagementInstallOptions = {},
): () => void {
  const shell = root.querySelector<HTMLElement>("[data-mind-diary-token-management]");
  if (!shell) return () => undefined;

  const cleanups: Array<() => void> = [];
  const on = <EventType extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: EventType) => void,
  ) => {
    const genericListener = listener as EventListener;
    target.addEventListener(type, genericListener);
    cleanups.push(() => target.removeEventListener(type, genericListener));
  };

  const menuButton = shell.querySelector<HTMLButtonElement>("[data-menu-button]");
  const navigation = shell.querySelector<HTMLElement>("[data-navigation]");
  const closeNavigation = () => {
    shell.dataset.navOpen = "false";
    menuButton?.setAttribute("aria-expanded", "false");
  };
  if (menuButton && navigation) {
    on<MouseEvent>(menuButton, "click", () => {
      const open = shell.dataset.navOpen !== "true";
      shell.dataset.navOpen = String(open);
      menuButton.setAttribute("aria-expanded", String(open));
      if (open) navigation.querySelector<HTMLAnchorElement>("a")?.focus();
    });
  }

  for (const button of Array.from(shell.querySelectorAll<HTMLButtonElement>("[data-copy-code]"))) {
    on<MouseEvent>(button, "click", async () => {
      const codeId = button.dataset.copyCode ?? "";
      const code = codeId.length > 0
        ? shell.querySelector<HTMLElement>(`#${CSS.escape(codeId)}[data-code-value]`)
        : null;
      const codeCopyStatus = button
        .closest<HTMLElement>("section")
        ?.querySelector<HTMLElement>("[data-code-copy-status]");
      if (!code || !codeCopyStatus) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        codeCopyStatus.textContent = "Copied. This text contains no token or Site credential.";
      } catch {
        codeCopyStatus.textContent = "Copy was blocked. Select the text and copy it manually.";
        code.focus();
      }
    });
  }

  const now = options.now ?? (() => new Date());
  const form = shell.querySelector<HTMLFormElement>("[data-token-form]");
  const formStatus = shell.querySelector<HTMLElement>("[data-token-form-status]");
  const submit = shell.querySelector<HTMLButtonElement>("[data-token-submit]");
  const secretDialog = shell.querySelector<HTMLDialogElement>("[data-secret-dialog]");
  const secretValueNode = shell.querySelector<HTMLElement>("[data-secret-value]");
  const copyStatus = shell.querySelector<HTMLElement>("[data-copy-status]");
  const copyButton = shell.querySelector<HTMLButtonElement>("[data-copy-secret]");
  const selfCheck = shell.querySelector<HTMLElement>("[data-mcp-self-check]");
  const selfCheckButton = shell.querySelector<HTMLButtonElement>("[data-run-mcp-self-check]");
  const selfCheckStatus = shell.querySelector<HTMLElement>("[data-mcp-self-check-status]");
  let revealedSecret = "";
  let secretInvoker: HTMLElement | null = null;

  const wipeSecret = () => {
    revealedSecret = "";
    if (secretValueNode) secretValueNode.textContent = "Secret removed. It cannot be recovered.";
    if (copyStatus) copyStatus.textContent = "";
    if (copyButton) copyButton.disabled = true;
    if (selfCheck) selfCheck.dataset.diagnosticState = "idle";
    if (selfCheckButton) selfCheckButton.disabled = true;
    if (selfCheckStatus) {
      selfCheckStatus.textContent = "Available only while the one-time secret is visible.";
    }
  };
  const closeSecret = () => {
    wipeSecret();
    if (secretDialog?.open || secretDialog?.hasAttribute("open")) closeDialog(secretDialog);
  };
  if (secretDialog) {
    for (const button of Array.from(secretDialog.querySelectorAll<HTMLElement>("[data-close-secret]"))) {
      on<MouseEvent>(button, "click", closeSecret);
    }
    on(secretDialog, "close", () => {
      wipeSecret();
      secretInvoker?.focus();
      secretInvoker = null;
    });
    on<MouseEvent>(secretDialog, "click", (event) => {
      if (event.target === secretDialog) closeSecret();
    });
  }
  if (copyButton) {
    on<MouseEvent>(copyButton, "click", async () => {
      if (revealedSecret.length === 0) return;
      try {
        await navigator.clipboard.writeText(revealedSecret);
        if (copyStatus) copyStatus.textContent = "Token copied. Keep it outside repositories and config files.";
      } catch {
        if (copyStatus) copyStatus.textContent = "Copy was blocked. Select the token text and copy it manually.";
        secretValueNode?.focus();
      }
    });
  }

  let issuePending = false;
  if (form && formStatus && submit && secretDialog && secretValueNode && copyButton) {
    on<SubmitEvent>(form, "submit", async (event) => {
      event.preventDefault();
      if (issuePending || !form.reportValidity()) return;
      const formData = new FormData(form);
      const name = String(formData.get("name") ?? "").trim();
      const access = formData.get("access") === "content:write" ? "content:write" : "content:read";
      const expiryDays = Number.parseInt(String(formData.get("expiry_days") ?? "90"), 10);
      if (![7, 30, 90].includes(expiryDays)) {
        formStatus.textContent = "Choose a supported expiry.";
        return;
      }
      const currentTime = now().valueOf();
      if (!Number.isFinite(currentTime)) {
        formStatus.textContent = "Token expiry is unavailable. Try again.";
        return;
      }
      const expiresAt = new Date(currentTime + expiryDays * 24 * 60 * 60 * 1_000).toISOString();
      issuePending = true;
      submit.disabled = true;
      formStatus.textContent = "Creating token…";
      try {
        const result = await adapter.issueToken({
          name,
          scopes: [access, ...(formData.has("personal_configure") ? ["personal:configure" as const] : [])],
          expiresAt,
        });
        const secret = result.secret.consumeSecret();
        if (secret === null || secret.length === 0) {
          throw new Error("The one-time secret was unavailable. Revoke this token and create another one.");
        }
        revealedSecret = secret;
        secretValueNode.textContent = revealedSecret;
        copyButton.disabled = false;
        if (selfCheckButton) selfCheckButton.disabled = false;
        if (selfCheckStatus) {
          selfCheckStatus.textContent = "Use the deployed UI to run the redacted connection check.";
        }
        formStatus.textContent = "Token created. Copy the secret before closing the window.";
        form.reset();
        secretInvoker = submit;
        showDialog(secretDialog);
        secretValueNode.focus();
        try {
          const tokens = await adapter.listTokens();
          replaceTokenCollection(shell, tokens.length === 0 ? { kind: "empty" } : { kind: "ready", tokens });
        } catch {
          setAnnouncement(shell, "Token created. The metadata list could not refresh yet.");
        }
      } catch (error) {
        wipeSecret();
        formStatus.textContent = errorMessage(error, "The token could not be created.");
      } finally {
        issuePending = false;
        submit.disabled = false;
      }
    });
  }

  const revokeDialog = shell.querySelector<HTMLDialogElement>("[data-revoke-dialog]");
  const revokeName = shell.querySelector<HTMLElement>("[data-revoke-name]");
  const revokeStatus = shell.querySelector<HTMLElement>("[data-revoke-status]");
  const confirmRevoke = shell.querySelector<HTMLButtonElement>("[data-confirm-revoke]");
  let revokeTarget: { readonly tokenId: string; readonly trigger: HTMLButtonElement } | null = null;
  let revokePending = false;
  const closeRevoke = () => {
    if (revokePending) return;
    if (revokeDialog?.open || revokeDialog?.hasAttribute("open")) closeDialog(revokeDialog);
  };
  if (revokeDialog) {
    for (const button of Array.from(revokeDialog.querySelectorAll<HTMLElement>("[data-cancel-revoke]"))) {
      on<MouseEvent>(button, "click", closeRevoke);
    }
    on(revokeDialog, "close", () => {
      revokeTarget?.trigger.focus();
      revokeTarget = null;
      if (revokeStatus) revokeStatus.textContent = "";
    });
    on<MouseEvent>(revokeDialog, "click", (event) => {
      if (event.target === revokeDialog) closeRevoke();
    });
  }

  on<MouseEvent>(shell, "click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-revoke-token]")
      : null;
    if (!target || !revokeDialog || revokePending) return;
    const tokenId = target.dataset.revokeToken ?? "";
    if (safeTokenId(tokenId) === null) return;
    revokeTarget = { tokenId, trigger: target };
    const card = target.closest<HTMLElement>("[data-token-card]");
    const name = card?.querySelector("h3")?.textContent ?? "this token";
    if (revokeName) revokeName.textContent = name;
    showDialog(revokeDialog);
    confirmRevoke?.focus();
  });

  if (confirmRevoke && revokeDialog && revokeStatus) {
    on<MouseEvent>(confirmRevoke, "click", async () => {
      if (!revokeTarget || revokePending) return;
      const currentTarget = revokeTarget;
      revokePending = true;
      confirmRevoke.disabled = true;
      revokeStatus.textContent = "Revoking token…";
      try {
        const revoked = await adapter.revokeToken(currentTarget.tokenId);
        try {
          const tokens = await adapter.listTokens();
          replaceTokenCollection(shell, tokens.length === 0 ? { kind: "empty" } : { kind: "ready", tokens });
        } catch {
          replaceTokenCard(shell, revoked);
        }
        setAnnouncement(shell, `${revoked.name} is revoked. Requests using it now stop.`);
        revokeTarget = null;
        closeDialog(revokeDialog);
        shell.querySelector<HTMLElement>(`[data-token-card="${CSS.escape(currentTarget.tokenId)}"]`)?.focus();
      } catch (error) {
        revokeStatus.textContent = errorMessage(error, "The token could not be revoked. Its status has not changed.");
      } finally {
        revokePending = false;
        confirmRevoke.disabled = false;
      }
    });
  }

  let listPending = false;
  on<MouseEvent>(shell, "click", async (event) => {
    const retry = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-token-retry]")
      : null;
    if (!retry || listPending) return;
    listPending = true;
    replaceTokenCollection(shell, { kind: "loading" });
    try {
      const tokens = await adapter.listTokens();
      replaceTokenCollection(shell, tokens.length === 0 ? { kind: "empty" } : { kind: "ready", tokens });
    } catch (error) {
      replaceTokenCollection(shell, {
        kind: "error",
        message: errorMessage(error, "Token metadata is unavailable."),
      });
    } finally {
      listPending = false;
    }
  });

  on<KeyboardEvent>(shell, "keydown", (event) => {
    if (event.key !== "Escape") return;
    if (secretDialog?.open || secretDialog?.hasAttribute("open")) {
      event.preventDefault();
      closeSecret();
      return;
    }
    if (revokeDialog?.open || revokeDialog?.hasAttribute("open")) {
      event.preventDefault();
      closeRevoke();
      return;
    }
    if (shell.dataset.navOpen === "true") {
      closeNavigation();
      menuButton?.focus();
    }
  });

  return () => {
    wipeSecret();
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
