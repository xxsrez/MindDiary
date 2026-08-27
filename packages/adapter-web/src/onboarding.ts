import {
  MIND_DIARY_FAVICON_LINKS,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  installMindDiaryUiShell,
  renderMindDiaryAuthenticatedFooter,
  renderMindDiaryAuthenticatedHeader,
} from "./ui-shell.js";
import {
  MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
  MIND_DIARY_CODEX_STARTER_PLAYBOOK,
} from "./token-management.js";
import { renderMarkdownImportPanel } from "./ordinary-minds-management.js";

export const MIND_DIARY_ONBOARDING_ASSETS = Object.freeze({
  shellStyles: MIND_DIARY_UI_ASSETS.shellStyles,
  client: "/ui/mind-diary-onboarding-client.js",
});

export const MIND_DIARY_ISOLATED_ACCOUNT_ACTION =
  "create_isolated_account" as const;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_LOCAL_PATH = /^\/(?!\/)[A-Za-z0-9/_.?&=%:-]*$/;

export type ManualRecoveryUiStatus =
  | "available"
  | "requested"
  | "unavailable";

export type ProfileUpdateUiState =
  | {
      readonly kind: "idle" | "saving";
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "saved";
      readonly message: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly retryable: boolean;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "conflict";
      readonly message: string;
    };

export type AuthenticatedOnboardingModel =
  | {
      readonly kind: "anonymous";
      readonly authEntryPath: string;
    }
  | {
      readonly kind: "registration_required";
      readonly suggestedDisplayName?: string;
      readonly bootstrapIdempotencyKey: string;
      readonly manualRecoveryStatus: ManualRecoveryUiStatus;
    }
  | {
      readonly kind: "bootstrapping";
    }
  | {
      readonly kind: "bootstrap_error";
      readonly displayName: string;
      readonly bootstrapIdempotencyKey: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly kind: "authenticated";
      readonly displayName: string;
      readonly profileVersion: number;
      readonly personalMind: {
        readonly route: "/me";
        readonly name: string;
        readonly headRevisionId: string;
        readonly updatedLabel: string;
      };
      readonly profileUpdate: ProfileUpdateUiState;
    };

function safeLocalPath(path: string): string {
  return SAFE_LOCAL_PATH.test(path) ? path : "#";
}

function safeIdempotencyKey(value: string): string | null {
  return IDEMPOTENCY_KEY.test(value) ? value : null;
}

function renderBrandHeader(): string {
  return `<header class="md-auth-header">
    <div class="md-brand-lockup">
      <a class="md-brand" href="/" aria-label="Mind Diary home">
        <img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48">
      </a>
      <span class="md-environment" aria-label="Hosted environment: UAT" data-ia-uat-marker>UAT</span>
    </div>
  </header>`;
}

function renderAnonymous(model: Extract<AuthenticatedOnboardingModel, { kind: "anonymous" }>): string {
  return `<div class="md-auth-page" data-authenticated-onboarding data-session-state="anonymous">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main" tabindex="-1" data-ia-main>
      <section class="md-auth-card md-auth-card--entry" aria-labelledby="auth-entry-title">
        <img class="md-auth-mark" src="${MIND_DIARY_UI_ASSETS.mark}" alt="" width="88" height="88">
        <p class="md-eyebrow">Your Minds, ready when you are</p>
        <h1 id="auth-entry-title">Sign in to Mind Diary</h1>
        <p>Use your ChatGPT account to open your private Mind Diary workspace. Mind management is available only after sign-in.</p>
        <a class="md-button md-button--primary md-auth-entry" href="${safeLocalPath(model.authEntryPath)}" data-sites-auth-entry>Sign in with ChatGPT</a>
        <p class="md-auth-note">Your session is checked by the server before any account or Mind details are shown.</p>
      </section>
    </main>
  </div>`;
}

function renderRecovery(status: ManualRecoveryUiStatus): string {
  if (status === "requested") {
    return `<section class="md-auth-choice" aria-labelledby="recovery-title">
      <p class="md-eyebrow">Manual recovery</p>
      <h2 id="recovery-title">Recovery review requested</h2>
      <p role="status">Access remains unchanged while identity is checked independently.</p>
    </section>`;
  }
  if (status === "unavailable") {
    return `<section class="md-auth-choice" aria-labelledby="recovery-title">
      <p class="md-eyebrow">Manual recovery</p>
      <h2 id="recovery-title">Recovery is unavailable right now</h2>
      <p role="status">No account link or access transfer has been attempted. Try again later.</p>
    </section>`;
  }
  return `<section class="md-auth-choice" aria-labelledby="recovery-title">
    <p class="md-eyebrow">Recognize an older account?</p>
    <h2 id="recovery-title">Request account recovery</h2>
    <p>If you expect earlier access, do not create an isolated account. Contact the pilot operator through the same trusted channel that admitted you.</p>
    <p data-recovery-safety>Say only that this authenticated identity is unlinked. Never send an MCP token, private Mind content, query, export URL, or download URL.</p>
    <p>Recovery verifies identity independently before any operator action. Nothing is relinked, merged, or transferred automatically, and access remains unchanged during review.</p>
    <button class="md-button md-button--secondary" type="button" data-manual-recovery>Acknowledge recovery instructions</button>
    <p class="md-form__status" role="status" aria-live="polite" data-recovery-status></p>
  </section>`;
}

function renderRegistration(
  model: Extract<AuthenticatedOnboardingModel, { kind: "registration_required" }>,
): string {
  const key = safeIdempotencyKey(model.bootstrapIdempotencyKey);
  const disabled = key === null ? " disabled" : "";
  const status = key === null
    ? "This session needs to be refreshed before an account can be created."
    : "";
  return `<div class="md-auth-page" data-authenticated-onboarding data-session-state="registration_required">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main md-auth-main--wide" tabindex="-1" data-ia-main>
      <div class="md-auth-intro">
        <p class="md-eyebrow">Signed in with ChatGPT</p>
        <h1>Choose how to continue</h1>
        <p>This verified sign-in is not linked to a Mind Diary account. For safety, Mind Diary will never guess which earlier account might be yours.</p>
      </div>
      <section class="md-auth-choice" aria-labelledby="uat-pilot-boundaries-title" data-uat-pilot-boundaries>
        <p class="md-eyebrow">Restricted UAT pilot</p>
        <h2 id="uat-pilot-boundaries-title">Keep your own recoverable copy</h2>
        <ul>
          <li>Use only data you are willing to place in this restricted UAT; do not keep the only copy here.</li>
          <li>This is not production and has no production SLA, guaranteed recovery, or accepted legal-retention promise.</li>
          <li>Export an exact revision before risky changes. Mind and account deletion are immediate and irreversible.</li>
          <li>Never share an MCP token, Sites credential, authorization header, or export/download URL — including with the pilot operator.</li>
        </ul>
        <p>Support needs only the symptom, UTC time, and a safe request ID. Never send private content, a raw query, email, credential, or download URL.</p>
      </section>
      <div class="md-auth-choice-grid">
        <section class="md-auth-choice md-auth-choice--primary" aria-labelledby="isolated-account-title">
          <p class="md-eyebrow">Start separately</p>
          <h2 id="isolated-account-title">Create a new isolated account</h2>
          <p>This creates one new account and one private My Mind. It does not inherit, relink, or merge earlier access.</p>
          <form data-isolated-account-form data-bootstrap-key="${escapeUntrustedText(key ?? "")}">
            <div class="md-field">
              <label for="onboarding-display-name">Display name</label>
              <input id="onboarding-display-name" name="display_name" type="text" required minlength="1" maxlength="80" autocomplete="name" value="${escapeUntrustedText(model.suggestedDisplayName ?? "")}">
              <p>This becomes your profile name and the name shown on My Mind.</p>
            </div>
            <button class="md-button md-button--primary" type="submit"${disabled}>Create isolated account</button>
            <p class="md-form__status" role="status" aria-live="polite" data-bootstrap-status>${status}</p>
          </form>
        </section>
        ${renderRecovery(model.manualRecoveryStatus)}
      </div>
    </main>
  </div>`;
}

function renderBootstrapping(): string {
  return `<div class="md-auth-page" data-authenticated-onboarding data-session-state="bootstrapping">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main" tabindex="-1" data-ia-main>
      <section class="md-auth-card md-auth-card--progress" aria-labelledby="bootstrap-progress-title" aria-busy="true">
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <p class="md-eyebrow">Setting up your workspace</p>
        <h1 id="bootstrap-progress-title">Creating your account and My Mind</h1>
        <p role="status" aria-live="polite">Account, private My Mind, and owner access are being created together…</p>
      </section>
    </main>
  </div>`;
}

function renderBootstrapError(
  model: Extract<AuthenticatedOnboardingModel, { kind: "bootstrap_error" }>,
): string {
  const key = safeIdempotencyKey(model.bootstrapIdempotencyKey);
  const canRetry = model.retryable && key !== null;
  const retry = canRetry
    ? `<button class="md-button md-button--primary" type="button" data-bootstrap-retry data-bootstrap-key="${escapeUntrustedText(key)}" data-bootstrap-display-name="${escapeUntrustedText(model.displayName)}">Try setup again</button>`
    : "";
  return `<div class="md-auth-page" data-authenticated-onboarding data-session-state="bootstrap_error">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main" tabindex="-1" data-ia-main>
      <section class="md-auth-card md-auth-card--error" aria-labelledby="bootstrap-error-title" role="alert">
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <p class="md-eyebrow">Setup paused safely</p>
        <h1 id="bootstrap-error-title">Your workspace is not ready yet</h1>
        <p>${escapeUntrustedText(model.message)}</p>
        <p>No partial account is presented as complete. A retry uses the same setup request so it cannot intentionally create a second account or My Mind.</p>
        ${retry}
        <p class="md-form__status" role="status" aria-live="polite" data-bootstrap-status></p>
      </section>
    </main>
  </div>`;
}

function renderProfileStatus(state: ProfileUpdateUiState): string {
  switch (state.kind) {
    case "idle":
      return '<p class="md-form__status" role="status" aria-live="polite" data-profile-status></p>';
    case "saving":
      return '<p class="md-form__status" role="status" aria-live="polite" data-profile-status>Saving your profile name…</p>';
    case "saved":
      return `<p class="md-inline-status md-inline-status--success" role="status" aria-live="polite" data-profile-status>${escapeUntrustedText(state.message)}</p>`;
    case "error":
      return `<p class="md-inline-status md-inline-status--error" role="alert" data-profile-status>${escapeUntrustedText(state.message)}${state.retryable ? " You can submit the same change again." : ""}</p>`;
    case "conflict":
      return `<div class="md-inline-status md-inline-status--error" role="alert" data-profile-status>
        <p>${escapeUntrustedText(state.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-refresh-session>Reload account state</button>
      </div>`;
  }
}

function renderAuthenticated(
  model: Extract<AuthenticatedOnboardingModel, { kind: "authenticated" }>,
): string {
  const state = model.profileUpdate;
  const key = state.kind === "conflict" ? null : safeIdempotencyKey(state.idempotencyKey);
  const profileVersion = Number.isSafeInteger(model.profileVersion) && model.profileVersion > 0
    ? model.profileVersion
    : null;
  const canSubmit = key !== null && profileVersion !== null && state.kind !== "saving" && state.kind !== "conflict";
  const profileKeyAttribute = key === null
    ? ""
    : ` data-profile-key="${escapeUntrustedText(key)}"`;
  return `<div class="md-shell" data-mind-diary-shell data-ia-shell data-authenticated-onboarding data-session-state="authenticated" data-control-plane data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "my-mind")}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header>
        <div>
          <p class="md-eyebrow">Signed in with ChatGPT</p>
          <h1>My Mind</h1>
          <p>Your private Mind is created with your account and always opens at <strong>/me</strong>.</p>
        </div>
        <p class="md-announcement" role="status"><span aria-hidden="true">✓</span> Account and My Mind are ready.</p>
      </div>
      <p class="md-caveat" data-ia-disclosure="personal-mind"><strong>Private — only you.</strong> My Mind cannot be shared, published, transferred, or deleted separately from your account.</p>
      <div class="md-my-mind-layout">
        <section class="md-personal-card" aria-labelledby="personal-mind-title" data-personal-mind-card>
          <div class="md-card__topline">
            <span class="md-card__personal">My Mind</span>
            <span class="md-status md-status--private"><span class="md-status__icon" aria-hidden="true">Lock</span> Private — only you</span>
          </div>
          <h2 id="personal-mind-title">${escapeUntrustedText(model.personalMind.name)}</h2>
          <p>Your personal place for versioned Memories. Content work happens through your authorized MCP connection.</p>
          <dl class="md-personal-summary">
            <div><dt>Address</dt><dd><a href="/me">/me</a></dd></div>
            <div><dt>Access</dt><dd>Owner — only you</dd></div>
            <div><dt>Activity</dt><dd>${escapeUntrustedText(model.personalMind.updatedLabel)}</dd></div>
          </dl>
        </section>
        <section class="md-profile-card" aria-labelledby="profile-name-title">
          <p class="md-eyebrow">Account profile</p>
          <h2 id="profile-name-title">Display name</h2>
          <p>Changing this name also changes the name shown on My Mind. It does not edit Memories or create a content revision.</p>
          <form data-profile-form data-profile-version="${profileVersion ?? ""}"${profileKeyAttribute}>
            <div class="md-field">
              <label for="profile-display-name">Display name</label>
              <input id="profile-display-name" name="display_name" type="text" required minlength="1" maxlength="80" autocomplete="name" value="${escapeUntrustedText(model.displayName)}"${state.kind === "saving" ? " disabled" : ""}>
            </div>
            <button class="md-button md-button--primary" type="submit"${canSubmit ? "" : " disabled"}>Save profile name</button>
            ${renderProfileStatus(state)}
          </form>
        </section>
      </div>
      ${renderMarkdownImportPanel({
        mindRef: "me",
        headRevisionId: model.personalMind.headRevisionId,
      })}
      <section class="md-setup-card md-setup-card--single" aria-labelledby="first-result-title" data-starter-mind-guide>
        <p class="md-eyebrow">About 15 minutes</p>
        <h2 id="first-result-title">Create your first useful Memory</h2>
        <p><a href="/help/codex">Open the Codex setup guide</a> if Mind Diary is not installed and connected yet. Then copy this prompt. It selects exactly one Personal or ordinary Mind, creates only UTF-8 Markdown, validates the complete OKF 0.2 bundle, and proves the result with index, search, and fetch.</p>
        <pre><code id="mind-diary-onboarding-starter-playbook" tabindex="-1" data-code-value>${escapeUntrustedText(MIND_DIARY_CODEX_STARTER_PLAYBOOK)}</code></pre>
        <button class="md-button md-button--primary" type="button" data-copy-code="mind-diary-onboarding-starter-playbook">Copy starter playbook</button>
        <p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p>
        <details>
          <summary>Have existing Markdown?</summary>
          <p>Use the bounded import above for an exact UTF-8 Markdown snapshot. The assisted Codex path remains useful for conversion; ZIP, assets, crawling, legacy migration, and cross-Mind merge remain unavailable.</p>
          <pre><code id="mind-diary-onboarding-concierge-playbook" tabindex="-1" data-code-value>${escapeUntrustedText(MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK)}</code></pre>
          <button class="md-button md-button--secondary" type="button" data-copy-code="mind-diary-onboarding-concierge-playbook">Copy concierge playbook</button>
        </details>
        <p><a href="/settings/developer/mcp">Open Advanced MCP</a> for personal-token and endpoint instructions. Never store a token in a repository or paste the full canonical corpus into a prompt.</p>
      </section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("my-mind")}
  </div>`;
}

export function renderAuthenticatedOnboarding(model: AuthenticatedOnboardingModel): string {
  switch (model.kind) {
    case "anonymous":
      return renderAnonymous(model);
    case "registration_required":
      return renderRegistration(model);
    case "bootstrapping":
      return renderBootstrapping();
    case "bootstrap_error":
      return renderBootstrapError(model);
    case "authenticated":
      return renderAuthenticated(model);
  }
}

function safeClientPath(path: string): string | null {
  return /^\/[A-Za-z0-9/_-]+\.(?:js|mjs)$/.test(path) ? path : null;
}

export function renderAuthenticatedOnboardingDocument(
  model: AuthenticatedOnboardingModel,
  clientPath: string = MIND_DIARY_ONBOARDING_ASSETS.client,
): string {
  const safeClient = safeClientPath(clientPath);
  const title = model.kind === "authenticated" ? "My Mind" : "Welcome";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  ${MIND_DIARY_FAVICON_LINKS}
  <title>${title} — Mind Diary</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_ONBOARDING_ASSETS.shellStyles}">
</head>
<body>
  ${renderAuthenticatedOnboarding(model)}
  ${safeClient ? `<script type="module" src="${safeClient}"></script>` : ""}
</body>
</html>`;
}

function setPending(button: HTMLButtonElement, status: HTMLElement | null, message: string): void {
  button.disabled = true;
  button.setAttribute("aria-disabled", "true");
  if (status) status.textContent = message;
}

function dispatchBootstrap(
  shell: HTMLElement,
  button: HTMLButtonElement,
  status: HTMLElement | null,
  displayName: string,
  idempotencyKey: string,
): boolean {
  const name = displayName.trim();
  const key = safeIdempotencyKey(idempotencyKey);
  if (name.length === 0 || name.length > 80 || key === null) {
    if (status) status.textContent = "Refresh the session and check the display name.";
    return false;
  }
  setPending(button, status, "Creating your account and My Mind…");
  shell.dispatchEvent(new CustomEvent("mind-diary:bootstrap-account", {
    bubbles: true,
    detail: Object.freeze({
      action: MIND_DIARY_ISOLATED_ACCOUNT_ACTION,
      displayName: name,
      idempotencyKey: key,
    }),
  }));
  return true;
}

export function installAuthenticatedOnboarding(
  root: Document | HTMLElement = document,
): () => void {
  const shell = root.querySelector<HTMLElement>("[data-authenticated-onboarding]");
  if (!shell) return () => undefined;
  const cleanupShell = installMindDiaryUiShell(root);
  const cleanups: Array<() => void> = [cleanupShell];
  const on = <EventType extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: EventType) => void,
  ) => {
    const genericListener = listener as EventListener;
    target.addEventListener(type, genericListener);
    cleanups.push(() => target.removeEventListener(type, genericListener));
  };

  let bootstrapDispatched = false;
  const registrationForm = shell.querySelector<HTMLFormElement>("[data-isolated-account-form]");
  if (registrationForm) {
    on<SubmitEvent>(registrationForm, "submit", (event) => {
      event.preventDefault();
      if (bootstrapDispatched || !registrationForm.reportValidity()) return;
      const button = registrationForm.querySelector<HTMLButtonElement>('button[type="submit"]');
      const input = registrationForm.querySelector<HTMLInputElement>('[name="display_name"]');
      const status = registrationForm.querySelector<HTMLElement>("[data-bootstrap-status]");
      if (!button || !input) return;
      bootstrapDispatched = dispatchBootstrap(
        shell,
        button,
        status,
        input.value,
        registrationForm.dataset.bootstrapKey ?? "",
      );
    });
  }

  const retry = shell.querySelector<HTMLButtonElement>("[data-bootstrap-retry]");
  if (retry) {
    on<MouseEvent>(retry, "click", () => {
      if (bootstrapDispatched) return;
      bootstrapDispatched = dispatchBootstrap(
        shell,
        retry,
        shell.querySelector<HTMLElement>("[data-bootstrap-status]"),
        retry.dataset.bootstrapDisplayName ?? "",
        retry.dataset.bootstrapKey ?? "",
      );
    });
  }

  const recovery = shell.querySelector<HTMLButtonElement>("[data-manual-recovery]");
  if (recovery) {
    on<MouseEvent>(recovery, "click", () => {
      if (recovery.disabled) return;
      setPending(
        recovery,
        shell.querySelector<HTMLElement>("[data-recovery-status]"),
        "Recovery review requested. Access remains unchanged.",
      );
      shell.dispatchEvent(new CustomEvent("mind-diary:manual-recovery", { bubbles: true }));
    });
  }

  let profileDispatched = false;
  const profileForm = shell.querySelector<HTMLFormElement>("[data-profile-form]");
  if (profileForm) {
    on<SubmitEvent>(profileForm, "submit", (event) => {
      event.preventDefault();
      if (profileDispatched || !profileForm.reportValidity()) return;
      const button = profileForm.querySelector<HTMLButtonElement>('button[type="submit"]');
      const input = profileForm.querySelector<HTMLInputElement>('[name="display_name"]');
      const status = profileForm.querySelector<HTMLElement>("[data-profile-status]");
      const expectedProfileVersion = Number.parseInt(profileForm.dataset.profileVersion ?? "", 10);
      const idempotencyKey = safeIdempotencyKey(profileForm.dataset.profileKey ?? "");
      const displayName = input?.value.trim() ?? "";
      if (
        !button || !input || idempotencyKey === null ||
        !Number.isSafeInteger(expectedProfileVersion) || expectedProfileVersion < 1 ||
        displayName.length === 0 || displayName.length > 80
      ) {
        if (status) status.textContent = "Reload the account state and check the display name.";
        return;
      }
      profileDispatched = true;
      input.disabled = true;
      setPending(button, status, "Saving your profile name…");
      shell.dispatchEvent(new CustomEvent("mind-diary:update-profile", {
        bubbles: true,
        detail: Object.freeze({ displayName, expectedProfileVersion, idempotencyKey }),
      }));
    });
  }

  const refresh = shell.querySelector<HTMLButtonElement>("[data-refresh-session]");
  if (refresh) {
    on<MouseEvent>(refresh, "click", () => {
      if (refresh.disabled) return;
      setPending(refresh, shell.querySelector<HTMLElement>("[data-profile-status]"), "Reloading account state…");
      shell.dispatchEvent(new CustomEvent("mind-diary:refresh-session", { bubbles: true }));
    });
  }

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
