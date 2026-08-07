import {
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
} from "./ui-shell.js";

export const MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER =
  "https://<your-mind-diary-site>/mcp" as const;
export const MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE =
  "MIND_DIARY_TOKEN" as const;
export const MIND_DIARY_CODEX_SAFE_ENVIRONMENT_SETUP =
  "read -s MIND_DIARY_TOKEN && export MIND_DIARY_TOKEN" as const;
export const MIND_DIARY_CODEX_CONFIG = `[mcp_servers.mind_diary]
url = "${MIND_DIARY_MCP_ENDPOINT_PLACEHOLDER}"
bearer_token_env_var = "${MIND_DIARY_CODEX_TOKEN_ENVIRONMENT_VARIABLE}"` as const;

export type McpTokenUiState = "active" | "expired" | "revoked";
export type McpTokenUiScope = "content:read" | "content:write";

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

export interface McpTokenManagementModel {
  readonly displayName: string;
  readonly collection: McpTokenCollectionState;
  readonly announcement?: string;
}

export interface McpTokenIssueCommand {
  readonly name: string;
  readonly scopes: readonly ["content:read"] | readonly ["content:write"];
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
    <div class="md-token-card__action">${action}</div>
  </article>`;
}

function renderTokenCollection(collection: McpTokenCollectionState): string {
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

function renderPageHeader(displayName: string): string {
  const safeName = escapeUntrustedText(displayName);
  return `<header class="md-header">
    <a class="md-brand" href="/" aria-label="Mind Diary home">
      <img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48">
    </a>
    <button class="md-menu-button" type="button" aria-expanded="false" aria-controls="primary-navigation" data-menu-button>
      <span aria-hidden="true">Menu</span><span>Navigation</span>
    </button>
    <nav id="primary-navigation" class="md-navigation" aria-label="Primary" data-navigation>
      <a href="/me"><span aria-hidden="true">●</span> My Mind</a>
      <a href="/minds"><span aria-hidden="true">▤</span> Minds</a>
      <a href="/invitations"><span aria-hidden="true">✉</span> Invitations</a>
      <a href="/settings/mcp" aria-current="page"><span aria-hidden="true">⌁</span> MCP setup</a>
    </nav>
    <button class="md-profile" type="button" aria-label="Open account menu for ${safeName}">
      <span class="md-profile__initial" aria-hidden="true">${escapeUntrustedText(displayName.slice(0, 1).toUpperCase())}</span>
      <span>${safeName}</span>
    </button>
  </header>`;
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

function renderCodexSetup(): string {
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
        <h3>Reference the environment variable in Codex</h3>
        <pre><code>${escapeUntrustedText(MIND_DIARY_CODEX_CONFIG)}</code></pre>
        <p>Replace the endpoint placeholder only after you have the exact deployed Mind Diary URL. Never replace <code>bearer_token_env_var</code> with the token value.</p>
      </li>
    </ol>
    <p class="md-caveat"><strong>Release gate:</strong> this setup guide does not claim a live Sites deployment, OAuth/PKCE, public plugin support, or verified client compatibility.</p>
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
  return `<div class="md-shell md-token-shell" data-mind-diary-token-management data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderPageHeader(model.displayName)}
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading">
        <div>
          <p class="md-eyebrow">Codex-first access</p>
          <h1>MCP setup</h1>
          <p>Create and revoke personal tokens. Tokens follow your current access across Minds and never grant account or membership controls.</p>
        </div>
        ${announcement}
      </div>
      <div class="md-token-layout">
        ${renderTokenCollection(model.collection)}
        ${renderCreateForm()}
        ${renderCodexSetup()}
      </div>
    </main>
    <footer class="md-footer">
      <p><strong>Mind Diary</strong> stores token metadata, never a recoverable secret.</p>
      <a href="/help">Help and accessibility</a>
    </footer>
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

  const now = options.now ?? (() => new Date());
  const form = shell.querySelector<HTMLFormElement>("[data-token-form]");
  const formStatus = shell.querySelector<HTMLElement>("[data-token-form-status]");
  const submit = shell.querySelector<HTMLButtonElement>("[data-token-submit]");
  const secretDialog = shell.querySelector<HTMLDialogElement>("[data-secret-dialog]");
  const secretValueNode = shell.querySelector<HTMLElement>("[data-secret-value]");
  const copyStatus = shell.querySelector<HTMLElement>("[data-copy-status]");
  const copyButton = shell.querySelector<HTMLButtonElement>("[data-copy-secret]");
  let revealedSecret = "";
  let secretInvoker: HTMLElement | null = null;

  const wipeSecret = () => {
    revealedSecret = "";
    if (secretValueNode) secretValueNode.textContent = "Secret removed. It cannot be recovered.";
    if (copyStatus) copyStatus.textContent = "";
    if (copyButton) copyButton.disabled = true;
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
          scopes: access === "content:write" ? ["content:write"] : ["content:read"],
          expiresAt,
        });
        const secret = result.secret.consumeSecret();
        if (secret === null || secret.length === 0) {
          throw new Error("The one-time secret was unavailable. Revoke this token and create another one.");
        }
        revealedSecret = secret;
        secretValueNode.textContent = revealedSecret;
        copyButton.disabled = false;
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
