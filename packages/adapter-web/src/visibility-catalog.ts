import {
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
} from "./ui-shell.js";

export type VisibilityCatalogVisibility = "private" | "unlisted" | "public";
export type VisibilityCatalogRole = "reader" | "editor" | "admin" | "owner";
export type VisibilityCatalogDiscovery =
  | "personal"
  | "membership"
  | "exact_handle"
  | "public_catalog";

export interface VisibilityCatalogMind {
  readonly mindId: string;
  readonly route: string;
  readonly name: string;
  readonly summary: string;
  readonly visibility: VisibilityCatalogVisibility;
  readonly isPersonal: boolean;
  readonly discovery: VisibilityCatalogDiscovery;
  readonly accessKind: "membership" | "visibility";
  readonly role: VisibilityCatalogRole | null;
  readonly metadataVersion: number;
}

export interface PublicMindCatalogItem {
  readonly mindId: string;
  readonly route: string;
  readonly name: string;
  readonly summary: string;
  readonly visibility: VisibilityCatalogVisibility;
  readonly isPersonal: boolean;
  readonly discovery: VisibilityCatalogDiscovery;
}

export type PublicMindCatalogCollection =
  | { readonly kind: "ready"; readonly minds: readonly PublicMindCatalogItem[] }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export interface VisibilityMindRoutePage {
  readonly kind: "mind";
  readonly displayName: string;
  readonly mind: VisibilityCatalogMind;
  readonly announcement?: string;
}

export interface PublicMindCatalogPage {
  readonly kind: "catalog";
  readonly displayName: string;
  readonly authenticated: boolean;
  readonly collection: PublicMindCatalogCollection;
  readonly announcement?: string;
}

export type VisibilityCatalogPageModel =
  | VisibilityMindRoutePage
  | PublicMindCatalogPage;

export interface VisibilityChangeCommand {
  readonly mindId: string;
  readonly visibility: VisibilityCatalogVisibility;
  readonly acknowledgeLiveHeadAndHistoryExposure: boolean;
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface VisibilityChangeResult {
  readonly mindId: string;
  readonly visibility: VisibilityCatalogVisibility;
  readonly metadataVersion: number;
  readonly changed: boolean;
  readonly replayed: boolean;
}

export interface VisibilityCatalogAdapter {
  changeVisibility?(
    command: Readonly<VisibilityChangeCommand>,
  ): Promise<Readonly<VisibilityChangeResult>>;
  listPublicMinds?(): Promise<readonly PublicMindCatalogItem[]>;
}

export interface VisibilityCatalogInstallOptions {
  readonly nextIdempotencyKey?: () => string;
}

export interface VisibilityChangeDisclosure {
  readonly kind: "none" | "exposure" | "return_private";
  readonly requiresAcknowledgement: boolean;
  readonly message: string;
}

const SAFE_MIND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ORDINARY_ROUTE = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

const VISIBILITY_LABELS: Readonly<
  Record<VisibilityCatalogVisibility, string>
> = Object.freeze({
  private: "Private — participants only",
  unlisted: "Unlisted — exact URL, not catalogued",
  public: "Public — listed for signed-in people",
});

const VISIBILITY_DESCRIPTIONS: Readonly<
  Record<VisibilityCatalogVisibility, string>
> = Object.freeze({
  private: "Only accepted participants can open this Mind.",
  unlisted:
    "Any signed-in person with the exact URL can read the live Mind and its history.",
  public:
    "Any signed-in person can find this Mind in Public Minds and read the live Mind and its history.",
});

function isVisibility(value: unknown): value is VisibilityCatalogVisibility {
  return value === "private" || value === "unlisted" || value === "public";
}

function isRole(value: unknown): value is VisibilityCatalogRole {
  return value === "reader" || value === "editor" || value === "admin" || value === "owner";
}

function safeMindId(value: unknown): value is string {
  return typeof value === "string" && SAFE_MIND_ID.test(value);
}

function safeOrdinaryRoute(value: unknown): value is string {
  return typeof value === "string" && SAFE_ORDINARY_ROUTE.test(value) && value !== "/me";
}

function safeRoute(value: unknown, personal: boolean): string {
  if (personal) return value === "/me" ? "/me" : "#";
  return safeOrdinaryRoute(value) ? value : "#";
}

function hiddenAttributes(hidden: boolean): string {
  return hidden ? ' hidden style="display: none"' : "";
}

function safeMetadataVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function activeAttribute(active: "minds" | "public", item: "minds" | "public"): string {
  return active === item ? ' aria-current="page"' : "";
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function visibilityChangeDisclosure(
  current: VisibilityCatalogVisibility,
  target: VisibilityCatalogVisibility,
): Readonly<VisibilityChangeDisclosure> {
  if (current === "private" && target !== "private") {
    return Object.freeze({
      kind: "exposure",
      requiresAcknowledgement: true,
      message:
        "This opens the live HEAD and the entire immutable history to any signed-in person. New successful commits become visible immediately.",
    });
  }
  if (current !== "private" && target === "private") {
    return Object.freeze({
      kind: "return_private",
      requiresAcknowledgement: false,
      message:
        "Returning to private stops future access for non-members. It does not undo copies or disclosure that already happened.",
    });
  }
  return Object.freeze({
    kind: "none",
    requiresAcknowledgement: false,
    message: "",
  });
}

function hasOwnerVisibilityAuthority(mind: VisibilityCatalogMind): boolean {
  return (
    mind.isPersonal === false &&
    mind.accessKind === "membership" &&
    mind.role === "owner" &&
    safeMindId(mind.mindId) &&
    safeOrdinaryRoute(mind.route) &&
    safeMetadataVersion(mind.metadataVersion) &&
    isVisibility(mind.visibility)
  );
}

export function createVisibilityChangeCommand(
  mind: VisibilityCatalogMind,
  target: VisibilityCatalogVisibility,
  acknowledged: boolean,
  idempotencyKey: string,
): Readonly<VisibilityChangeCommand> {
  if (!hasOwnerVisibilityAuthority(mind)) {
    throw new Error("Current active Owner visibility access is required.");
  }
  if (!isVisibility(target) || target === mind.visibility) {
    throw new Error("Choose a different valid visibility mode.");
  }
  if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error("Visibility request identity is invalid.");
  }
  const disclosure = visibilityChangeDisclosure(mind.visibility, target);
  if (disclosure.requiresAcknowledgement && acknowledged !== true) {
    throw new Error("Acknowledge exposure of the live HEAD and entire history.");
  }
  return Object.freeze({
    mindId: mind.mindId,
    visibility: target,
    acknowledgeLiveHeadAndHistoryExposure:
      disclosure.requiresAcknowledgement && acknowledged === true,
    expectedMetadataVersion: mind.metadataVersion,
    idempotencyKey,
  });
}

function isDiscoverablePublicMind(
  mind: PublicMindCatalogItem,
): boolean {
  return (
    mind !== null &&
    typeof mind === "object" &&
    mind.isPersonal === false &&
    mind.visibility === "public" &&
    mind.discovery === "public_catalog" &&
    safeMindId(mind.mindId) &&
    safeOrdinaryRoute(mind.route) &&
    typeof mind.name === "string" &&
    typeof mind.summary === "string"
  );
}

/**
 * Applies a fail-closed presentation filter even when a caller accidentally
 * supplies private, unlisted, Personal, exact-handle, duplicate, or malformed
 * descriptors. The server remains the authorization boundary.
 */
export function publicMindsForCatalog(
  minds: readonly PublicMindCatalogItem[],
): readonly PublicMindCatalogItem[] {
  const seen = new Set<string>();
  const visible: PublicMindCatalogItem[] = [];
  for (const mind of minds) {
    if (!isDiscoverablePublicMind(mind)) continue;
    const identity = `${mind.mindId}\u0000${mind.route}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    visible.push(mind);
  }
  return Object.freeze(visible);
}

function renderHeader(displayName: string, active: "minds" | "public"): string {
  const safeName = escapeUntrustedText(displayName);
  const initial = escapeUntrustedText(displayName.slice(0, 1).toUpperCase());
  return `<header class="md-header">
    <a class="md-brand" href="/" aria-label="Mind Diary home">
      <img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48">
    </a>
    <button class="md-menu-button" type="button" aria-expanded="false" aria-controls="primary-navigation" data-menu-button>
      <span aria-hidden="true">Menu</span><span>Navigation</span>
    </button>
    <nav id="primary-navigation" class="md-navigation" aria-label="Primary" data-navigation>
      <a href="/me"><span aria-hidden="true">●</span> My Mind</a>
      <a href="/minds"${activeAttribute(active, "minds")}><span aria-hidden="true">▤</span> Minds</a>
      <a href="/public"${activeAttribute(active, "public")}><span aria-hidden="true">◎</span> Public Minds</a>
      <a href="/invitations"><span aria-hidden="true">✉</span> Invitations</a>
      <a href="/settings/mcp"><span aria-hidden="true">⌁</span> MCP setup</a>
    </nav>
    <button class="md-profile" type="button" aria-label="Open account menu for ${safeName}">
      <span class="md-profile__initial" aria-hidden="true">${initial}</span>
      <span>${safeName}</span>
    </button>
  </header>`;
}

function renderAnnouncement(announcement: string | undefined): string {
  return announcement
    ? `<p class="md-announcement" role="status" aria-live="polite" data-page-announcement><span aria-hidden="true">✓</span> ${escapeUntrustedText(announcement)}</p>`
    : '<p class="md-announcement" role="status" aria-live="polite" data-page-announcement hidden style="display: none"></p>';
}

function renderOwnerVisibilityControls(mind: VisibilityCatalogMind): string {
  return `<section class="md-setup-card" aria-labelledby="visibility-controls-heading" data-visibility-control-route>
    <div>
      <p class="md-eyebrow">Owner control</p>
      <h2 id="visibility-controls-heading">Choose who can find and read this Mind</h2>
      <p>Visibility grants never create membership or allow changes. Public and unlisted access still requires a signed-in Mind Diary account.</p>
    </div>
    <form class="md-form" data-visibility-form data-mind-id="${escapeUntrustedText(mind.mindId)}" data-mind-route="${safeRoute(mind.route, false)}" data-metadata-version="${mind.metadataVersion}" data-current-visibility="${mind.visibility}" aria-describedby="visibility-exposure-warning visibility-private-warning">
      <div class="md-field">
        <label for="mind-visibility">Visibility</label>
        <select id="mind-visibility" name="visibility" data-visibility-selector aria-describedby="visibility-mode-help">
          <option value="private"${mind.visibility === "private" ? " selected" : ""}>${VISIBILITY_LABELS.private}</option>
          <option value="unlisted"${mind.visibility === "unlisted" ? " selected" : ""}>${VISIBILITY_LABELS.unlisted}</option>
          <option value="public"${mind.visibility === "public" ? " selected" : ""}>${VISIBILITY_LABELS.public}</option>
        </select>
        <p id="visibility-mode-help"><strong>The exact URL is not a secret.</strong> Unlisted removes catalog discovery, but that URL still opens the Mind for signed-in people.</p>
      </div>
      <section class="md-caveat" id="visibility-exposure-warning" data-exposure-warning hidden style="display: none">
        <h3>Live content and all history become readable</h3>
        <p>${visibilityChangeDisclosure("private", "public").message}</p>
        <label for="visibility-exposure-acknowledgement">
          <input id="visibility-exposure-acknowledgement" name="acknowledge_exposure" type="checkbox" data-exposure-acknowledgement disabled>
          I understand that live HEAD and the entire immutable history will be exposed to signed-in non-members.
        </label>
      </section>
      <section class="md-caveat" id="visibility-private-warning" data-private-warning hidden style="display: none">
        <h3>Private stops future access only</h3>
        <p>${visibilityChangeDisclosure("public", "private").message}</p>
      </section>
      <p class="md-form__status" role="status" aria-live="polite" data-visibility-form-status></p>
      <div class="md-dialog__actions">
        <a class="md-button md-button--secondary" href="${safeRoute(mind.route, false)}">Cancel</a>
        <button class="md-button md-button--primary" type="submit" data-save-visibility disabled>Save visibility</button>
      </div>
    </form>
  </section>`;
}

function renderReadOnlyVisibility(mind: VisibilityCatalogMind): string {
  let reason = "Only the current Owner can change visibility.";
  if (mind.isPersonal) {
    reason = "My Mind is always private and cannot be published or shared.";
  } else if (mind.accessKind === "visibility") {
    reason = "Visibility access is read-only and never grants management controls.";
  } else if (isRole(mind.role)) {
    reason = `${titleCase(mind.role)} access does not include visibility changes. Only the current Owner can change it.`;
  }
  return `<section class="md-setup-card" aria-labelledby="visibility-readonly-heading" data-visibility-readonly>
    <div>
      <p class="md-eyebrow">Visibility</p>
      <h2 id="visibility-readonly-heading">${isVisibility(mind.visibility) ? VISIBILITY_LABELS[mind.visibility] : "Visibility unavailable"}</h2>
      <p>${escapeUntrustedText(reason)}</p>
    </div>
  </section>`;
}

function renderMindPage(model: VisibilityMindRoutePage): string {
  const mind = model.mind;
  const visibility = isVisibility(mind.visibility) ? mind.visibility : "private";
  const route = safeRoute(mind.route, mind.isPersonal);
  const exactUnlisted =
    mind.isPersonal === false &&
    visibility === "unlisted" &&
    mind.discovery === "exact_handle";
  const canMutate = hasOwnerVisibilityAuthority(mind);
  return `<div class="md-shell" data-mind-diary-visibility-catalog data-nav-open="false" data-page-kind="mind">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderHeader(model.displayName, "minds")}
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading">
        <div>
          <p class="md-eyebrow">Mind visibility</p>
          <h1>${escapeUntrustedText(mind.name)}</h1>
          <p>${escapeUntrustedText(mind.summary)}</p>
        </div>
        ${renderAnnouncement(model.announcement)}
      </div>
      <section class="md-card" aria-labelledby="current-visibility-heading" ${exactUnlisted ? "data-exact-unlisted-opening" : ""}>
        <p class="md-eyebrow">Current access</p>
        <h2 id="current-visibility-heading" data-current-visibility-label>${VISIBILITY_LABELS[visibility]}</h2>
        <p data-current-visibility-description>${VISIBILITY_DESCRIPTIONS[visibility]}</p>
        <p><strong>Address:</strong> <a href="${route}">${escapeUntrustedText(route)}</a></p>
        <p class="md-caveat" data-unlisted-not-secret${hiddenAttributes(visibility !== "unlisted")}><strong>This URL is not a secret.</strong> Anyone signed in who learns it can open the live HEAD and the entire history, even though this Mind is absent from Public Minds.</p>
        <p class="md-caveat" data-public-authenticated-notice${hiddenAttributes(visibility !== "public")}><strong>Authenticated only.</strong> Public does not mean anonymous access.</p>
      </section>
      ${canMutate ? renderOwnerVisibilityControls(mind) : renderReadOnlyVisibility(mind)}
    </main>
    <footer class="md-footer">
      <p><strong>Mind Diary</strong> makes access boundaries explicit before they change.</p>
      <a href="/help">Help and accessibility</a>
    </footer>
  </div>`;
}

function renderPublicMindCard(mind: PublicMindCatalogItem): string {
  return `<article class="md-card" data-public-mind-card="${escapeUntrustedText(mind.mindId)}">
    <div class="md-card__topline">
      <span class="md-status md-status--public"><span class="md-status__icon" aria-hidden="true">Globe</span> Public — signed-in readers</span>
    </div>
    <h3><a href="${safeRoute(mind.route, false)}">${escapeUntrustedText(mind.name)}</a></h3>
    <p class="md-card__description">${escapeUntrustedText(mind.summary)}</p>
    <p class="md-caveat">Live HEAD and immutable history are readable. Content changes remain unavailable without Editor membership.</p>
  </article>`;
}

function renderCatalogCollection(collection: PublicMindCatalogCollection): string {
  switch (collection.kind) {
    case "loading":
      return `<section class="md-state md-state--loading" aria-labelledby="public-minds-heading" aria-busy="true" data-public-catalog-collection>
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="public-minds-heading">Opening Public Minds</h2>
        <p role="status" aria-live="polite">Loading catalog entries…</p>
      </section>`;
    case "empty":
      return `<section class="md-state md-state--empty" aria-labelledby="public-minds-heading" data-public-catalog-collection>
        <span class="md-state__symbol" aria-hidden="true">◎</span>
        <h2 id="public-minds-heading">No Public Minds yet</h2>
        <p>Private, unlisted, and Personal Minds never appear here.</p>
      </section>`;
    case "error":
      return `<section class="md-state md-state--error" aria-labelledby="public-minds-heading" role="alert" data-public-catalog-collection>
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="public-minds-heading">We couldn’t open Public Minds</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-public-catalog-retry>Try again</button>
      </section>`;
    case "ready": {
      const minds = publicMindsForCatalog(collection.minds);
      if (minds.length === 0) return renderCatalogCollection({ kind: "empty" });
      return `<section aria-labelledby="public-minds-heading" data-public-catalog-collection>
        <div class="md-section-heading">
          <div><p class="md-eyebrow">Authenticated catalog</p><h2 id="public-minds-heading">Public Minds</h2></div>
        </div>
        <div class="md-card-grid" data-public-mind-list>${minds.map(renderPublicMindCard).join("")}</div>
      </section>`;
    }
  }
}

function renderCatalogPage(model: PublicMindCatalogPage): string {
  const collection = model.authenticated
    ? renderCatalogCollection(model.collection)
    : `<section class="md-state md-state--error" role="alert" data-authentication-required>
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2>Sign in to open Public Minds</h2>
        <p>Public Minds are available to registered, signed-in people. Anonymous access is not available.</p>
      </section>`;
  return `<div class="md-shell" data-mind-diary-visibility-catalog data-nav-open="false" data-page-kind="catalog">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderHeader(model.displayName, "public")}
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading">
        <div>
          <p class="md-eyebrow">Discover shared knowledge</p>
          <h1>Public Minds</h1>
          <p>Find Minds that Owners made discoverable to signed-in people. Public access is read-only unless you are also a participant with a writing role.</p>
        </div>
        ${renderAnnouncement(model.announcement)}
      </div>
      ${collection}
    </main>
    <footer class="md-footer">
      <p><strong>Mind Diary</strong> never lists private, unlisted, or Personal Minds here.</p>
      <a href="/help">Help and accessibility</a>
    </footer>
  </div>`;
}

export function renderVisibilityCatalogUi(
  model: VisibilityCatalogPageModel,
): string {
  return model.kind === "catalog" ? renderCatalogPage(model) : renderMindPage(model);
}

function safeClientScript(value: string | undefined): string | null {
  return typeof value === "string" &&
    /^\/[A-Za-z0-9][A-Za-z0-9/_-]*\.(?:js|mjs)$/u.test(value)
    ? value
    : null;
}

export function renderVisibilityCatalogDocument(
  model: VisibilityCatalogPageModel,
  clientScript?: string,
): string {
  const scriptPath = safeClientScript(clientScript);
  const script = scriptPath
    ? `\n  <script type="module" src="${escapeUntrustedText(scriptPath)}"></script>`
    : "";
  const title = model.kind === "catalog" ? "Public Minds" : "Mind visibility";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${title} — Mind Diary</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderVisibilityCatalogUi(model)}${script}
</body>
</html>`;
}

function replaceCatalogCollection(
  shell: HTMLElement,
  collection: PublicMindCatalogCollection,
): void {
  const current = shell.querySelector<HTMLElement>("[data-public-catalog-collection]");
  if (!current) return;
  const template = shell.ownerDocument.createElement("template");
  template.innerHTML = renderCatalogCollection(collection);
  const next = template.content.firstElementChild;
  if (next) current.replaceWith(next);
}

function setAnnouncement(shell: HTMLElement, message: string): void {
  const announcement = shell.querySelector<HTMLElement>("[data-page-announcement]");
  if (!announcement) return;
  announcement.hidden = false;
  announcement.style.removeProperty("display");
  announcement.textContent = message;
}

function setElementHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
  if (hidden) element.style.display = "none";
  else element.style.removeProperty("display");
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 240);
  }
  return fallback;
}

let fallbackRequestSequence = 0;
function nextDefaultIdempotencyKey(): string {
  fallbackRequestSequence += 1;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `visibility-${globalThis.crypto.randomUUID()}`;
  }
  return `visibility-ui-${Date.now().toString(36)}-${fallbackRequestSequence}`;
}

export function installVisibilityCatalogUi(
  adapter: VisibilityCatalogAdapter,
  root: Document | HTMLElement = document,
  options: VisibilityCatalogInstallOptions = {},
): () => void {
  const shell = root.querySelector<HTMLElement>("[data-mind-diary-visibility-catalog]");
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
  if (menuButton && navigation) {
    on<MouseEvent>(menuButton, "click", () => {
      const open = shell.dataset.navOpen !== "true";
      shell.dataset.navOpen = String(open);
      menuButton.setAttribute("aria-expanded", String(open));
      if (open) navigation.querySelector<HTMLAnchorElement>("a")?.focus();
    });
  }

  const form = shell.querySelector<HTMLFormElement>("[data-visibility-form]");
  const status = shell.querySelector<HTMLElement>("[data-visibility-form-status]");
  const submit = shell.querySelector<HTMLButtonElement>("[data-save-visibility]");
  const acknowledgement = shell.querySelector<HTMLInputElement>("[data-exposure-acknowledgement]");
  const exposureWarning = shell.querySelector<HTMLElement>("[data-exposure-warning]");
  const privateWarning = shell.querySelector<HTMLElement>("[data-private-warning]");
  const selector = form?.querySelector<HTMLSelectElement>("[data-visibility-selector]") ?? null;
  let pending = false;
  let locked = false;
  let retry:
    | { readonly signature: string; readonly command: Readonly<VisibilityChangeCommand> }
    | null = null;

  const selectedVisibility = (): VisibilityCatalogVisibility | null => {
    return isVisibility(selector?.value) ? selector.value : null;
  };

  const syncVisibilityForm = () => {
    if (!form || !submit || !acknowledgement || !exposureWarning || !privateWarning) return;
    const current = form.dataset.currentVisibility;
    const target = selectedVisibility();
    if (!isVisibility(current) || target === null) {
      locked = true;
    }
    const disclosure =
      isVisibility(current) && target !== null
        ? visibilityChangeDisclosure(current, target)
        : visibilityChangeDisclosure("private", "private");
    const changed = isVisibility(current) && target !== null && target !== current;
    setElementHidden(exposureWarning, disclosure.kind !== "exposure");
    setElementHidden(privateWarning, disclosure.kind !== "return_private");
    if (!disclosure.requiresAcknowledgement) acknowledgement.checked = false;
    acknowledgement.disabled = pending || locked || !disclosure.requiresAcknowledgement;
    if (selector) selector.disabled = pending || locked;
    submit.disabled =
      pending ||
      locked ||
      !changed ||
      (disclosure.requiresAcknowledgement && !acknowledgement.checked);
  };

  if (form && status && submit && acknowledgement && exposureWarning && privateWarning) {
    if (typeof adapter.changeVisibility !== "function") {
      locked = true;
      status.textContent = "Visibility changes are unavailable on this page.";
    }
    if (selector) {
      on<Event>(selector, "change", () => {
          retry = null;
          status.textContent = "";
          status.dataset.state = "idle";
          syncVisibilityForm();
        });
    }
    on<Event>(acknowledgement, "change", syncVisibilityForm);
    on<SubmitEvent>(form, "submit", async (event) => {
      event.preventDefault();
      if (pending || locked || typeof adapter.changeVisibility !== "function") return;
      const current = form.dataset.currentVisibility;
      const target = selectedVisibility();
      const metadataVersion = Number(form.dataset.metadataVersion);
      if (!isVisibility(current) || target === null || !safeMetadataVersion(metadataVersion)) {
        locked = true;
        status.textContent = "Visibility state is unavailable. Reload the page.";
        status.dataset.state = "error";
        syncVisibilityForm();
        return;
      }
      const mind: VisibilityCatalogMind = {
        mindId: form.dataset.mindId ?? "",
        route: form.dataset.mindRoute ?? "#",
        name: "",
        summary: "",
        visibility: current,
        isPersonal: false,
        discovery: "membership",
        accessKind: "membership",
        role: "owner",
        metadataVersion,
      };
      const signature = `${mind.mindId}\u0000${current}\u0000${target}\u0000${metadataVersion}\u0000${acknowledgement.checked}`;
      let command: Readonly<VisibilityChangeCommand>;
      try {
        command = retry?.signature === signature
          ? retry.command
          : createVisibilityChangeCommand(
              mind,
              target,
              acknowledgement.checked,
              (options.nextIdempotencyKey ?? nextDefaultIdempotencyKey)(),
            );
      } catch (error) {
        status.textContent = errorMessage(error, "Visibility request is invalid.");
        status.dataset.state = "error";
        syncVisibilityForm();
        return;
      }
      retry = { signature, command };
      pending = true;
      status.textContent = "Saving visibility…";
      status.dataset.state = "saving";
      syncVisibilityForm();
      try {
        const result = await adapter.changeVisibility(command);
        if (
          result.mindId !== command.mindId ||
          result.visibility !== command.visibility ||
          !safeMetadataVersion(result.metadataVersion) ||
          result.metadataVersion < command.expectedMetadataVersion
        ) {
          throw new Error("Visibility response did not match the requested Mind.");
        }
        form.dataset.currentVisibility = result.visibility;
        form.dataset.metadataVersion = String(result.metadataVersion);
        retry = null;
        const label = shell.querySelector<HTMLElement>("[data-current-visibility-label]");
        if (label) label.textContent = VISIBILITY_LABELS[result.visibility];
        const description = shell.querySelector<HTMLElement>("[data-current-visibility-description]");
        if (description) description.textContent = VISIBILITY_DESCRIPTIONS[result.visibility];
        const unlistedNotice = shell.querySelector<HTMLElement>("[data-unlisted-not-secret]");
        if (unlistedNotice) setElementHidden(unlistedNotice, result.visibility !== "unlisted");
        const publicNotice = shell.querySelector<HTMLElement>("[data-public-authenticated-notice]");
        if (publicNotice) setElementHidden(publicNotice, result.visibility !== "public");
        status.textContent = `Visibility is now ${result.visibility}.`;
        status.dataset.state = "saved";
        setAnnouncement(
          shell,
          result.visibility === "unlisted"
            ? "Unlisted is active. The exact URL is not a secret."
            : `Visibility changed to ${result.visibility}.`,
        );
      } catch (error) {
        const code = errorCode(error);
        if (code === "metadata_conflict") {
          locked = true;
          retry = null;
          status.textContent = "This Mind changed in another session. Reload before retrying.";
        } else if (code === "forbidden" || code === "mind_not_found") {
          locked = true;
          retry = null;
          status.textContent = "Owner access is no longer available. Visibility was not changed.";
        } else if (code === "exposure_acknowledgement_required") {
          acknowledgement.checked = false;
          retry = null;
          status.textContent = "Acknowledge exposure of the live HEAD and entire history.";
        } else {
          status.textContent = errorMessage(
            error,
            "Visibility could not be saved. Its final state has not changed; try again.",
          );
        }
        status.dataset.state = "error";
      } finally {
        pending = false;
        syncVisibilityForm();
      }
    });
    syncVisibilityForm();
  }

  let catalogPending = false;
  on<MouseEvent>(shell, "click", async (event) => {
    const retryButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-public-catalog-retry]")
      : null;
    if (!retryButton || catalogPending || typeof adapter.listPublicMinds !== "function") return;
    catalogPending = true;
    replaceCatalogCollection(shell, { kind: "loading" });
    try {
      const minds = await adapter.listPublicMinds();
      replaceCatalogCollection(shell, minds.length === 0 ? { kind: "empty" } : { kind: "ready", minds });
    } catch (error) {
      replaceCatalogCollection(shell, {
        kind: "error",
        message: errorMessage(error, "Public Minds are unavailable."),
      });
    } finally {
      catalogPending = false;
    }
  });

  on<KeyboardEvent>(shell, "keydown", (event) => {
    if (event.key !== "Escape" || shell.dataset.navOpen !== "true") return;
    shell.dataset.navOpen = "false";
    menuButton?.setAttribute("aria-expanded", "false");
    menuButton?.focus();
  });

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
