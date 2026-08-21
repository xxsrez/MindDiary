import type {
  AccountDeletionImpactDescriptor,
  AccountDeletionResult,
  DeleteAccountCommand,
} from "@mind-diary/application-control";

import {
  MIND_DIARY_FAVICON_LINKS,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  renderMindDiaryAuthenticatedFooter,
  renderMindDiaryAuthenticatedHeader,
} from "./ui-shell.js";

export const MIND_DIARY_ACCOUNT_DELETION_CONFIRMATION =
  "delete-account" as const;

const ACCOUNT_DELETION_CONFIRMATION =
  MIND_DIARY_ACCOUNT_DELETION_CONFIRMATION;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ORDINARY_MIND_ROUTE = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const MAX_PREVIEW_MINDS = 1_000;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_TIMER_DELAY = 2_147_000_000;

type AccountDeletionErrorCode =
  | "authentication_required"
  | "invalid_deletion_impact_id"
  | "invalid_confirmation"
  | "invalid_idempotency_key"
  | "account_not_found"
  | "deletion_impact_expired"
  | "deletion_impact_changed"
  | "idempotency_conflict"
  | "deletion_cleanup_incomplete"
  | "account_deletion_unavailable";

interface PreviewState {
  readonly impact: Readonly<AccountDeletionImpactDescriptor>;
  readonly idempotencyKey: string;
}

interface ConfirmedDeletionState extends PreviewState {
  readonly command: Readonly<DeleteAccountCommand>;
}

export type AccountDeletionViewState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "load_error";
      readonly reason: "denied" | "unavailable" | "invalid";
    }
  | (PreviewState & {
      readonly kind: "preview";
      readonly feedback?: "invalid_confirmation";
    })
  | (ConfirmedDeletionState & { readonly kind: "deleting" })
  | (ConfirmedDeletionState & {
      readonly kind: "retryable_failure";
      readonly cleanupIncomplete: boolean;
    })
  | {
      readonly kind: "stale";
      readonly reason: "changed" | "expired" | "invalid";
    }
  | { readonly kind: "denied" }
  | { readonly kind: "ending_session" }
  | { readonly kind: "deleted" }
  | { readonly kind: "session_end_error" };

export interface AccountDeletionPageModel {
  readonly displayName: string;
  readonly profile?: {
    readonly profileVersion: number;
    readonly personalMindName: string;
    readonly idempotencyKey: string;
  };
  readonly state: AccountDeletionViewState;
}

export interface AccountDeletionUiAdapter {
  getAccountDeletionImpact(): Promise<unknown>;
  deleteAccount(
    command: Readonly<DeleteAccountCommand>,
  ): Promise<unknown>;
  endSessionAfterDeletion(): Promise<void> | void;
}

export interface AccountDeletionControllerOptions {
  readonly now?: () => Date;
  readonly createIdempotencyKey?: () => string;
  readonly setTimer?: (callback: () => void, delayMilliseconds: number) => number;
  readonly clearTimer?: (timer: number) => void;
  readonly onState?: (state: AccountDeletionViewState) => void;
}

export interface AccountDeletionController {
  getState(): AccountDeletionViewState;
  loadPreview(): Promise<void>;
  submitConfirmation(confirmation: string): Promise<void>;
  retryDeletion(): Promise<void>;
  retrySessionEnd(): Promise<void>;
  dispose(): void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function safeName(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DISPLAY_NAME_LENGTH
    ? value
    : null;
}

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

/**
 * Accepts only the safe deletion-impact projection. Extra fields are ignored,
 * so private content can never enter the view model by object spreading.
 */
export function normalizeAccountDeletionImpact(
  value: unknown,
): Readonly<AccountDeletionImpactDescriptor> | null {
  if (!isRecord(value)) return null;
  if (typeof value.impactId !== "string" || !OPAQUE_ID.test(value.impactId)) {
    return null;
  }
  if (
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  if (
    value.irreversible !== true ||
    value.recoveryAvailable !== false ||
    value.forensicReceiptRetained !== false ||
    value.confirmation !== ACCOUNT_DELETION_CONFIRMATION
  ) {
    return null;
  }
  if (!isRecord(value.personalMind) || value.personalMind.route !== "/me") {
    return null;
  }
  const personalMindName = safeName(value.personalMind.name);
  if (personalMindName === null) return null;
  if (
    !Array.isArray(value.ownedMinds) ||
    value.ownedMinds.length > MAX_PREVIEW_MINDS
  ) {
    return null;
  }
  const ownedMinds: Array<Readonly<{ route: `/${string}`; name: string }>> = [];
  for (const candidate of value.ownedMinds) {
    if (!isRecord(candidate)) return null;
    const name = safeName(candidate.name);
    if (
      name === null ||
      typeof candidate.route !== "string" ||
      !ORDINARY_MIND_ROUTE.test(candidate.route) ||
      candidate.route === "/me"
    ) {
      return null;
    }
    ownedMinds.push(
      Object.freeze({ route: candidate.route as `/${string}`, name }),
    );
  }
  const foreignMembershipCount = safeCount(value.foreignMembershipCount);
  const pendingInvitationCount = safeCount(value.pendingInvitationCount);
  const activeMcpTokenCount = safeCount(value.activeMcpTokenCount);
  if (
    foreignMembershipCount === null ||
    pendingInvitationCount === null ||
    activeMcpTokenCount === null
  ) {
    return null;
  }
  return Object.freeze({
    impactId: value.impactId,
    expiresAt: value.expiresAt as AccountDeletionImpactDescriptor["expiresAt"],
    personalMind: Object.freeze({
      route: "/me" as const,
      name: personalMindName,
    }),
    ownedMinds: Object.freeze(ownedMinds),
    foreignMembershipCount,
    pendingInvitationCount,
    activeMcpTokenCount,
    irreversible: true as const,
    recoveryAvailable: false as const,
    forensicReceiptRetained: false as const,
    confirmation: ACCOUNT_DELETION_CONFIRMATION,
  });
}

function validDeletionResult(value: unknown): value is Readonly<AccountDeletionResult> {
  if (!isRecord(value) || typeof value.replayed !== "boolean") return false;
  for (const field of [
    "spacesDeleted",
    "tokensRevoked",
    "canonicalObjectsDeleted",
    "canonicalObjectsRetained",
    "indexedRevisionsDeleted",
    "deliveredAuditEventsDeleted",
    "deliveredAuditActorsTombstoned",
    "exportArchivesDeleted",
  ] as const) {
    if (safeCount(value[field]) === null) return false;
  }
  return true;
}

function errorCode(error: unknown): AccountDeletionErrorCode | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  switch (error.code) {
    case "authentication_required":
    case "invalid_deletion_impact_id":
    case "invalid_confirmation":
    case "invalid_idempotency_key":
    case "account_not_found":
    case "deletion_impact_expired":
    case "deletion_impact_changed":
    case "idempotency_conflict":
    case "deletion_cleanup_incomplete":
    case "account_deletion_unavailable":
      return error.code;
    default:
      return null;
  }
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function renderLoading(): string {
  return `<section class="md-state md-state--loading" aria-labelledby="deletion-state-title" aria-busy="true">
    <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
    <h2 id="deletion-state-title">Loading the exact deletion preview</h2>
    <p role="status" aria-live="polite">Checking the current account cascade…</p>
  </section>`;
}

function renderLoadError(
  reason: Extract<AccountDeletionViewState, { kind: "load_error" }>["reason"],
): string {
  const copy = reason === "denied"
    ? "This signed-in session cannot load an account deletion preview. No deletion command was sent."
    : reason === "invalid"
      ? "Mind Diary could not verify the deletion preview contract. No deletion command was sent."
      : "The deletion preview is unavailable. No deletion command was sent.";
  return `<section class="md-state md-state--error" aria-labelledby="deletion-state-title" role="alert">
    <span class="md-state__symbol" aria-hidden="true">!</span>
    <h2 id="deletion-state-title">Account deletion is paused</h2>
    <p>${copy}</p>
    <button class="md-button md-button--secondary" type="button" data-refresh-deletion-impact>Try preview again</button>
  </section>`;
}

function renderOwnedMinds(
  minds: AccountDeletionImpactDescriptor["ownedMinds"],
): string {
  if (minds.length === 0) {
    return "<p data-owned-minds-empty>You do not currently own an ordinary Mind.</p>";
  }
  return `<ul data-owned-minds>${minds.map((mind) => `<li><strong>${escapeUntrustedText(mind.name)}</strong> <code>${escapeUntrustedText(mind.route)}</code></li>`).join("")}</ul>`;
}

function renderImpactPreview(
  state:
    | Extract<AccountDeletionViewState, { kind: "preview" }>
    | Extract<AccountDeletionViewState, { kind: "deleting" }>
    | Extract<AccountDeletionViewState, { kind: "retryable_failure" }>,
): string {
  const impact = normalizeAccountDeletionImpact(state.impact);
  if (impact === null || !IDEMPOTENCY_KEY.test(state.idempotencyKey)) {
    return renderLoadError("invalid");
  }
  const deleting = state.kind === "deleting";
  const retrying = state.kind === "retryable_failure";
  const feedback = state.kind === "preview" && state.feedback === "invalid_confirmation"
    ? `<p class="md-inline-status md-inline-status--error" role="alert">Type <code>${ACCOUNT_DELETION_CONFIRMATION}</code> exactly. The confirmation is case-sensitive.</p>`
    : "";
  const operationStatus = deleting
    ? "Deleting the account and completing the exact cascade…"
    : retrying
      ? state.cleanupIncomplete
        ? "The cascade started, but cleanup was not confirmed complete. Retry the same request; its idempotency key is unchanged."
        : "Mind Diary did not confirm completion. Retry the same request; its idempotency key is unchanged."
      : "";
  const action = retrying
    ? `<div>
        <p class="md-caveat" role="alert">${operationStatus}</p>
        <button class="md-button md-button--danger" type="button" data-retry-account-deletion>Retry exact deletion</button>
      </div>`
    : `<form class="md-token-form" data-account-deletion-form${deleting ? ' aria-busy="true"' : ""}>
        <div class="md-field">
          <label for="account-deletion-confirmation">Type <code>${ACCOUNT_DELETION_CONFIRMATION}</code> exactly</label>
          <input id="account-deletion-confirmation" name="confirmation" type="text" required pattern="delete-account" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="account-deletion-confirmation-help"${deleting ? ` value="${ACCOUNT_DELETION_CONFIRMATION}" disabled` : ""}>
          <p id="account-deletion-confirmation-help">This phrase is case-sensitive and authorizes only the preview shown above.</p>
        </div>
        ${feedback}
        <p class="md-form__status" role="status" aria-live="polite" data-account-deletion-status>${deleting ? operationStatus : ""}</p>
        <button class="md-button md-button--danger" type="submit" data-confirm-account-deletion disabled>${deleting ? "Deleting account…" : "Delete account permanently"}</button>
      </form>`;
  return `<div class="md-token-layout" data-account-deletion-impact data-impact-id="${escapeUntrustedText(impact.impactId)}" data-impact-expires-at="${escapeUntrustedText(impact.expiresAt)}" data-idempotency-key="${escapeUntrustedText(state.idempotencyKey)}">
    <section class="md-setup-card" aria-labelledby="cascade-heading">
      <div>
        <p class="md-eyebrow">Exact, expiring preview</p>
        <h2 id="cascade-heading">Review the deletion cascade</h2>
        <p>This preview expires at <time datetime="${escapeUntrustedText(impact.expiresAt)}">${escapeUntrustedText(formatExpiry(impact.expiresAt))}</time>. Any account, Mind, invitation, membership, or token change can make it stale.</p>
      </div>
      <div>
        <h3>Personal Mind</h3>
        <p><strong>${escapeUntrustedText(impact.personalMind.name)}</strong> <code>/me</code></p>
        <h3>Owned Minds (${impact.ownedMinds.length})</h3>
        ${renderOwnedMinds(impact.ownedMinds)}
      </div>
    </section>
    <div class="md-card-grid" aria-label="Other account records in this cascade">
      <article class="md-card"><p class="md-eyebrow">Memberships</p><h3>${impact.foreignMembershipCount}</h3><p>Memberships in Minds owned by other people will be removed.</p></article>
      <article class="md-card"><p class="md-eyebrow">Pending invitations</p><h3>${impact.pendingInvitationCount}</h3><p>Your pending invitations will be removed.</p></article>
      <article class="md-card"><p class="md-eyebrow">Active MCP tokens</p><h3>${impact.activeMcpTokenCount}</h3><p>Your active personal MCP tokens will be revoked.</p></article>
    </div>
    <section class="md-setup-card md-state--error" aria-labelledby="irreversible-heading">
      <div>
        <p class="md-eyebrow">Immediate and irreversible</p>
        <h2 id="irreversible-heading">Owned Minds are deleted for everyone</h2>
        <p>Every owned Mind above is deleted with its full history even when other participants use it.</p>
        <p>Your commits in Minds owned by someone else stay. Their author becomes an opaque, non-PII <code>deleted-principal</code> marker.</p>
      </div>
      <div>
        <p class="md-caveat"><strong>No recovery path:</strong> this prototype has no soft delete or recovery, and it retains no forensic deletion receipt.</p>
        ${action}
      </div>
    </section>
  </div>`;
}

function renderAccountProfile(
  model: AccountDeletionPageModel,
): string {
  const profile = model.profile;
  if (
    profile === undefined ||
    !Number.isSafeInteger(profile.profileVersion) ||
    profile.profileVersion < 1 ||
    safeName(profile.personalMindName) === null ||
    !IDEMPOTENCY_KEY.test(profile.idempotencyKey)
  ) {
    return `<section class="md-profile-card md-state--error" aria-labelledby="account-profile-title">
      <p class="md-eyebrow">Account profile</p>
      <h2 id="account-profile-title">Profile state is unavailable</h2>
      <p role="alert">Reload this page before changing the display name. No profile command is available from incomplete state.</p>
    </section>`;
  }
  return `<section class="md-profile-card" aria-labelledby="account-profile-title">
    <p class="md-eyebrow">Account profile</p>
    <h2 id="account-profile-title">Display name</h2>
    <p>This name is also shown on <strong>${escapeUntrustedText(profile.personalMindName)}</strong> at <a href="/me">/me</a>. Renaming it does not change the Mind address, identity, history, or content HEAD.</p>
    <form data-profile-form data-profile-version="${profile.profileVersion}" data-profile-key="${escapeUntrustedText(profile.idempotencyKey)}">
      <div class="md-field">
        <label for="profile-display-name">Display name</label>
        <input id="profile-display-name" name="display_name" type="text" required minlength="1" maxlength="80" autocomplete="name" value="${escapeUntrustedText(model.displayName)}">
      </div>
      <button class="md-button md-button--primary" type="submit">Save profile name</button>
      <p class="md-form__status" role="status" aria-live="polite" data-profile-status></p>
    </form>
  </section>`;
}

function renderRecoveryHandoff(): string {
  return `<section class="md-profile-card" aria-labelledby="identity-recovery-title" data-identity-recovery-handoff>
    <p class="md-eyebrow">Fail-closed identity recovery</p>
    <h2 id="identity-recovery-title">If a later sign-in is not linked</h2>
    <ol>
      <li>Do not create an isolated account if you expect access from an earlier account.</li>
      <li>Contact the pilot operator through the same trusted channel that admitted you.</li>
      <li>Say only that the authenticated identity is unlinked. Never send an MCP token, private Mind content, query, export URL, or download URL.</li>
    </ol>
    <p>The operator must verify identity independently. Mind Diary does not relink, merge, or transfer access automatically, and access remains unchanged during review.</p>
  </section>`;
}

function renderStale(
  reason: Extract<AccountDeletionViewState, { kind: "stale" }>["reason"],
): string {
  const detail = reason === "expired"
    ? "The preview expired before a successful deletion."
    : reason === "changed"
      ? "The server found that the account cascade changed."
      : "The preview or command contract could not be verified.";
  return `<section class="md-state md-state--error" aria-labelledby="deletion-state-title" role="alert">
    <span class="md-state__symbol" aria-hidden="true">↻</span>
    <h2 id="deletion-state-title">A fresh deletion preview is required</h2>
    <p>${detail} No deletion is started from the stale preview.</p>
    <button class="md-button md-button--secondary" type="button" data-refresh-deletion-impact>Load the current cascade</button>
  </section>`;
}

export function renderAccountDeletionPanel(
  state: AccountDeletionViewState,
): string {
  switch (state.kind) {
    case "loading":
      return renderLoading();
    case "load_error":
      return renderLoadError(state.reason);
    case "preview":
    case "deleting":
    case "retryable_failure":
      return renderImpactPreview(state);
    case "stale":
      return renderStale(state.reason);
    case "denied":
      return `<section class="md-state md-state--error" aria-labelledby="deletion-state-title" role="alert">
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="deletion-state-title">Deletion was not authorized</h2>
        <p>No successful deletion was reported. This page has not ended the session.</p>
        <a class="md-button md-button--secondary" href="/settings/account">Return to account settings</a>
      </section>`;
    case "ending_session":
      return `<section class="md-state md-state--loading" aria-labelledby="deletion-state-title" aria-busy="true">
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="deletion-state-title">Account deletion completed</h2>
        <p role="status" aria-live="polite">Ending this session now that the cascade succeeded…</p>
      </section>`;
    case "deleted":
      return `<section class="md-state" aria-labelledby="deletion-state-title" data-account-deletion-complete>
        <span class="md-state__symbol" aria-hidden="true">✓</span>
        <h2 id="deletion-state-title">Account deleted</h2>
        <p role="status">The deletion cascade completed and this session ended.</p>
        <a class="md-button md-button--secondary" href="/">Return to Mind Diary</a>
      </section>`;
    case "session_end_error":
      return `<section class="md-state md-state--error" aria-labelledby="deletion-state-title" role="alert">
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="deletion-state-title">Account deleted; sign-out needs another try</h2>
        <p>The deletion cascade completed, but this page could not finish ending the local session.</p>
        <button class="md-button md-button--secondary" type="button" data-retry-session-end>Retry sign-out</button>
      </section>`;
  }
}

export function renderAccountDeletion(
  model: AccountDeletionPageModel,
): string {
  return `<div class="md-shell" data-mind-diary-shell data-mind-diary-account-deletion data-deletion-state="${model.state.kind}" data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "account")}
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading">
        <div>
          <p class="md-eyebrow">Account settings</p>
          <h1>Account and profile</h1>
          <p>Manage the profile attached to My Mind, review the recovery boundary, and inspect the exact deletion cascade.</p>
        </div>
      </div>
      <div class="md-my-mind-layout" data-account-lifecycle>
        ${renderAccountProfile(model)}
        ${renderRecoveryHandoff()}
      </div>
      <section aria-labelledby="delete-account-title">
        <div class="md-section-heading">
          <div>
            <p class="md-eyebrow">Danger zone</p>
            <h2 id="delete-account-title">Delete account</h2>
            <p>Review the server’s current cascade before authorizing this irreversible action.</p>
          </div>
        </div>
        <div data-account-deletion-panel>${renderAccountDeletionPanel(model.state)}</div>
      </section>
    </main>
    ${renderMindDiaryAuthenticatedFooter("account")}
  </div>`;
}

export function renderAccountDeletionDocument(
  model: AccountDeletionPageModel,
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
  <title>Account and profile — Mind Diary UAT</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderAccountDeletion(model)}${script}
</body>
</html>`;
}

let fallbackIdempotencyCounter = 0;

function defaultIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `account-delete-${uuid}`;
  fallbackIdempotencyCounter += 1;
  return `account-delete-${Date.now().toString(36)}-${fallbackIdempotencyCounter.toString(36)}`;
}

function immutableState<State extends AccountDeletionViewState>(state: State): State {
  return Object.freeze(state);
}

export function createAccountDeletionController(
  adapter: AccountDeletionUiAdapter,
  options: AccountDeletionControllerOptions = {},
): AccountDeletionController {
  const now = options.now ?? (() => new Date());
  const createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
  const setTimer = options.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));
  const onState = options.onState ?? (() => undefined);
  let state: AccountDeletionViewState = immutableState({ kind: "loading" });
  let disposed = false;
  let previewGeneration = 0;
  let deletionGeneration = 0;
  let expiryTimer: number | null = null;

  const emit = (next: AccountDeletionViewState) => {
    if (disposed) return;
    state = immutableState(next);
    onState(state);
  };
  const clearExpiry = () => {
    if (expiryTimer === null) return;
    clearTimer(expiryTimer);
    expiryTimer = null;
  };
  const nowValue = () => now().valueOf();
  const scheduleExpiry = (impact: Readonly<AccountDeletionImpactDescriptor>) => {
    clearExpiry();
    const check = () => {
      expiryTimer = null;
      if (disposed || state.kind !== "preview") return;
      const remaining = Date.parse(impact.expiresAt) - nowValue();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        emit({ kind: "stale", reason: "expired" });
        return;
      }
      expiryTimer = setTimer(check, Math.min(remaining + 1, MAX_TIMER_DELAY));
    };
    check();
  };

  const loadPreview = async (): Promise<void> => {
    if (disposed || state.kind === "deleting" || state.kind === "ending_session") {
      return;
    }
    const generation = ++previewGeneration;
    clearExpiry();
    emit({ kind: "loading" });
    try {
      const candidate = await adapter.getAccountDeletionImpact();
      if (disposed || generation !== previewGeneration) return;
      const impact = normalizeAccountDeletionImpact(candidate);
      if (impact === null) {
        emit({ kind: "load_error", reason: "invalid" });
        return;
      }
      if (Date.parse(impact.expiresAt) <= nowValue()) {
        emit({ kind: "stale", reason: "expired" });
        return;
      }
      const idempotencyKey = createIdempotencyKey();
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        emit({ kind: "load_error", reason: "invalid" });
        return;
      }
      emit({ kind: "preview", impact, idempotencyKey });
      scheduleExpiry(impact);
    } catch (error) {
      if (disposed || generation !== previewGeneration) return;
      const code = errorCode(error);
      emit({
        kind: "load_error",
        reason: code === "authentication_required" || code === "account_not_found"
          ? "denied"
          : "unavailable",
      });
    }
  };

  const finishSession = async (generation: number): Promise<void> => {
    if (disposed || generation !== deletionGeneration) return;
    emit({ kind: "ending_session" });
    try {
      await adapter.endSessionAfterDeletion();
      if (disposed || generation !== deletionGeneration) return;
      emit({ kind: "deleted" });
    } catch {
      if (disposed || generation !== deletionGeneration) return;
      emit({ kind: "session_end_error" });
    }
  };

  const runDeletion = async (
    confirmed: ConfirmedDeletionState,
  ): Promise<void> => {
    if (disposed || state.kind === "deleting" || state.kind === "ending_session") {
      return;
    }
    clearExpiry();
    const generation = ++deletionGeneration;
    emit({ kind: "deleting", ...confirmed });
    try {
      const result = await adapter.deleteAccount(confirmed.command);
      if (disposed || generation !== deletionGeneration) return;
      if (!validDeletionResult(result)) {
        emit({
          kind: "retryable_failure",
          ...confirmed,
          cleanupIncomplete: false,
        });
        return;
      }
      await finishSession(generation);
    } catch (error) {
      if (disposed || generation !== deletionGeneration) return;
      const code = errorCode(error);
      if (code === "deletion_impact_expired" || code === "deletion_impact_changed") {
        emit({
          kind: "stale",
          reason: code === "deletion_impact_expired" ? "expired" : "changed",
        });
        return;
      }
      if (code === "authentication_required" || code === "account_not_found") {
        emit({ kind: "denied" });
        return;
      }
      if (
        code === "invalid_deletion_impact_id" ||
        code === "invalid_confirmation" ||
        code === "invalid_idempotency_key" ||
        code === "idempotency_conflict"
      ) {
        emit({ kind: "stale", reason: "invalid" });
        return;
      }
      emit({
        kind: "retryable_failure",
        ...confirmed,
        cleanupIncomplete: code === "deletion_cleanup_incomplete",
      });
    }
  };

  return Object.freeze({
    getState: () => state,
    loadPreview,
    submitConfirmation: async (confirmation: string) => {
      if (disposed || state.kind !== "preview") return;
      if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
        clearExpiry();
        const feedbackState = immutableState({
          kind: "preview" as const,
          impact: state.impact,
          idempotencyKey: state.idempotencyKey,
          feedback: "invalid_confirmation" as const,
        });
        emit(feedbackState);
        scheduleExpiry(feedbackState.impact);
        return;
      }
      if (Date.parse(state.impact.expiresAt) <= nowValue()) {
        clearExpiry();
        emit({ kind: "stale", reason: "expired" });
        return;
      }
      const confirmed: ConfirmedDeletionState = Object.freeze({
        impact: state.impact,
        idempotencyKey: state.idempotencyKey,
        command: Object.freeze({
          impactId: state.impact.impactId,
          confirmation: ACCOUNT_DELETION_CONFIRMATION,
          idempotencyKey: state.idempotencyKey,
        }),
      });
      await runDeletion(confirmed);
    },
    retryDeletion: async () => {
      if (disposed || state.kind !== "retryable_failure") return;
      await runDeletion({
        impact: state.impact,
        idempotencyKey: state.idempotencyKey,
        command: state.command,
      });
    },
    retrySessionEnd: async () => {
      if (disposed || state.kind !== "session_end_error") return;
      const generation = deletionGeneration;
      await finishSession(generation);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      previewGeneration += 1;
      deletionGeneration += 1;
      clearExpiry();
    },
  });
}

export function installAccountDeletionUi(
  adapter: AccountDeletionUiAdapter,
  root: Document | HTMLElement = document,
  options: Omit<AccountDeletionControllerOptions, "onState"> = {},
): () => void {
  const shell = root.querySelector<HTMLElement>("[data-mind-diary-account-deletion]");
  const panel = shell?.querySelector<HTMLElement>("[data-account-deletion-panel]");
  if (!shell || !panel) return () => undefined;

  const renderState = (next: AccountDeletionViewState) => {
    shell.dataset.deletionState = next.kind;
    panel.innerHTML = renderAccountDeletionPanel(next);
  };
  const controller = createAccountDeletionController(adapter, {
    ...options,
    onState: renderState,
  });
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

  on<InputEvent>(shell, "input", (event) => {
    const input = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("#account-deletion-confirmation")
      : null;
    if (!input) return;
    const form = input.closest<HTMLFormElement>("[data-account-deletion-form]");
    const button = form?.querySelector<HTMLButtonElement>("[data-confirm-account-deletion]");
    if (button) button.disabled = input.value !== ACCOUNT_DELETION_CONFIRMATION;
    const status = form?.querySelector<HTMLElement>("[data-account-deletion-status]");
    if (status) status.textContent = input.value.length === 0 || input.value === ACCOUNT_DELETION_CONFIRMATION
      ? ""
      : `Type ${ACCOUNT_DELETION_CONFIRMATION} exactly.`;
  });

  on<SubmitEvent>(shell, "submit", (event) => {
    const form = event.target instanceof Element
      ? event.target.closest<HTMLFormElement>("[data-account-deletion-form]")
      : null;
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>("#account-deletion-confirmation");
    void controller.submitConfirmation(input?.value ?? "");
  });

  on<MouseEvent>(shell, "click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-refresh-deletion-impact]")) {
      void controller.loadPreview();
      return;
    }
    if (target.closest("[data-retry-account-deletion]")) {
      void controller.retryDeletion();
      return;
    }
    if (target.closest("[data-retry-session-end]")) {
      void controller.retrySessionEnd();
    }
  });

  on<KeyboardEvent>(shell, "keydown", (event) => {
    if (event.key === "Enter") {
      const input = event.target instanceof Element
        ? event.target.closest<HTMLInputElement>("#account-deletion-confirmation")
        : null;
      if (input && !input.disabled) {
        event.preventDefault();
        void controller.submitConfirmation(input.value);
      }
      return;
    }
    if (event.key === "Escape" && shell.dataset.navOpen === "true") {
      closeNavigation();
      menuButton?.focus();
    }
  });

  void controller.loadPreview();
  return () => {
    controller.dispose();
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
