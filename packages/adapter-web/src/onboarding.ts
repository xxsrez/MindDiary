import {
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  installMindDiaryUiShell,
} from "./ui-shell.js";

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
    <a class="md-brand" href="/" aria-label="Mind Diary home">
      <img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48">
    </a>
  </header>`;
}

function renderAnonymous(model: Extract<AuthenticatedOnboardingModel, { kind: "anonymous" }>): string {
  return `<div class="md-auth-page" data-authenticated-onboarding data-session-state="anonymous">
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main">
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
    <p>Recovery verifies identity before any account link or access change. Nothing is merged automatically.</p>
    <button class="md-button md-button--secondary" type="button" data-manual-recovery>Request recovery review</button>
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
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main md-auth-main--wide">
      <div class="md-auth-intro">
        <p class="md-eyebrow">Signed in with ChatGPT</p>
        <h1>Choose how to continue</h1>
        <p>This verified sign-in is not linked to a Mind Diary account. For safety, Mind Diary will never guess which earlier account might be yours.</p>
      </div>
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
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main">
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
    ${renderBrandHeader()}
    <main id="main-content" class="md-auth-main">
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
  return `<div class="md-shell" data-mind-diary-shell data-authenticated-onboarding data-session-state="authenticated" data-control-plane data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    <header class="md-header">
      <a class="md-brand" href="/" aria-label="Mind Diary home">
        <img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48">
      </a>
      <button class="md-menu-button" type="button" aria-expanded="false" aria-controls="primary-navigation" data-menu-button><span aria-hidden="true">Menu</span><span>Navigation</span></button>
      <nav id="primary-navigation" class="md-navigation" aria-label="Primary" data-navigation>
        <a href="/me" aria-current="page"><span aria-hidden="true">●</span> My Mind</a>
        <a href="/minds"><span aria-hidden="true">▤</span> Minds</a>
        <a href="/invitations"><span aria-hidden="true">✉</span> Invitations</a>
        <a href="/settings/mcp"><span aria-hidden="true">⌁</span> MCP setup</a>
      </nav>
      <span class="md-profile" aria-label="Signed in account: ${escapeUntrustedText(model.displayName)}">
        <span class="md-profile__initial" aria-hidden="true">${escapeUntrustedText(model.displayName.slice(0, 1).toUpperCase())}</span>
        <span>${escapeUntrustedText(model.displayName)}</span>
      </span>
    </header>
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading">
        <div>
          <p class="md-eyebrow">Signed in with ChatGPT</p>
          <h1>My Mind</h1>
          <p>Your private Mind is created with your account and always opens at <strong>/me</strong>.</p>
        </div>
        <p class="md-announcement" role="status"><span aria-hidden="true">✓</span> Account and My Mind are ready.</p>
      </div>
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
    </main>
    <footer class="md-footer"><p><strong>Mind Diary</strong> keeps the knowledge you choose in versioned Minds.</p><a href="/help">Help and accessibility</a></footer>
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
