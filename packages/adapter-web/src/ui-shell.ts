export const MIND_DIARY_UI_ASSETS = Object.freeze({
  lockup: "/brand/mind-diary-lockup.svg",
  mark: "/brand/mind-diary-mark.svg",
  faviconIco: "/favicon.ico",
  faviconSvg: "/favicon.svg",
  faviconPng: "/favicon-32x32.png",
  appleTouchIcon: "/apple-touch-icon.png",
  tokens: "/brand/mind-diary-tokens.css",
  shellStyles: "/ui/mind-diary-shell.css",
  shellClient: "/ui/mind-diary-shell-client.js",
});

export const MIND_DIARY_FAVICON_LINKS = `<link rel="icon" href="${MIND_DIARY_UI_ASSETS.faviconIco}" sizes="16x16 32x32">
  <link rel="icon" href="${MIND_DIARY_UI_ASSETS.faviconSvg}" type="image/svg+xml" sizes="any">
  <link rel="icon" href="${MIND_DIARY_UI_ASSETS.faviconPng}" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="${MIND_DIARY_UI_ASSETS.appleTouchIcon}" type="image/png" sizes="180x180">` as const;

/**
 * Fraunces and Inter files are not shipped by the current repository. The UI
 * deliberately uses the canonical brand stacks, whose Georgia and system-ui
 * fallbacks work without an external font request.
 */
export const MIND_DIARY_FONT_DELIVERY = Object.freeze({
  mode: "system-fallback",
  productionDeliveryVerified: false,
  externalRequests: false,
  displayStack: '"Fraunces", Georgia, serif',
  uiStack: '"Inter", system-ui, sans-serif',
});

export type MindVisibility = "private" | "unlisted" | "public";

export interface UiMindCard {
  readonly id: string;
  readonly name: string;
  readonly route: string;
  readonly description: string;
  readonly visibility: MindVisibility;
  readonly role: "Reader" | "Editor" | "Admin" | "Owner";
  readonly updatedLabel: string;
  readonly isPersonal?: boolean;
}

export type UiCollectionState =
  | { readonly kind: "ready"; readonly minds: readonly UiMindCard[] }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export interface MindDiaryUiShellModel {
  readonly displayName: string;
  readonly activeNavigation: MindDiaryNavigationTarget;
  readonly collection: UiCollectionState;
  readonly announcement?: string;
}

export type MindDiaryNavigationTarget =
  | "home"
  | "my-mind"
  | "minds"
  | "public"
  | "invitations"
  | "account"
  | "connections"
  | "tokens"
  | "help";

export const DEFAULT_UI_SHELL_MODEL: MindDiaryUiShellModel = Object.freeze({
  displayName: "Andrey",
  activeNavigation: "home",
  announcement: "Your Minds are ready.",
  collection: {
    kind: "ready",
    minds: [
      {
        id: "mind_personal",
        name: "Andrey",
        route: "/me",
        description: "Your private place for personal Memories.",
        visibility: "private",
        role: "Owner",
        updatedLabel: "Updated today",
        isPersonal: true,
      },
      {
        id: "mind_research",
        name: "Research Notes",
        route: "/research-notes",
        description: "Sources, decisions, and open questions for the project.",
        visibility: "private",
        role: "Editor",
        updatedLabel: "Updated yesterday",
      },
    ],
  } as const,
});

const ESCAPED_TEXT = /[&<>"']/g;
const TEXT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/** Escapes untrusted text for both HTML text and quoted attribute contexts. */
export function escapeUntrustedText(value: string): string {
  return value.replace(ESCAPED_TEXT, (character) => TEXT_ESCAPES[character] ?? character);
}

function activeAttribute(
  current: MindDiaryNavigationTarget | null,
  item: MindDiaryNavigationTarget,
): string {
  return current === item ? ' aria-current="page"' : "";
}

/** Shared authenticated Product Site header for the accepted pilot route map. */
export function renderMindDiaryAuthenticatedHeader(
  displayName: string,
  activeNavigation: MindDiaryNavigationTarget | null,
): string {
  void displayName;
  const settingsCurrent = activeNavigation === "account" ||
    activeNavigation === "connections" || activeNavigation === "tokens";
  const settingsContext = settingsCurrent
    ? `<nav class="md-context-navigation" aria-label="Settings sections" data-ia-nav="settings">
        <a href="/settings/account"${activeAttribute(activeNavigation, "account")}>Account</a>
        <a href="/settings/connections"${activeAttribute(activeNavigation, "connections")}>Connections</a>
        <a href="/settings/developer/mcp"${activeAttribute(activeNavigation, "tokens")}>Advanced MCP</a>
      </nav>`
    : "";
  const settingsCurrentAttribute = settingsCurrent ? ' aria-current="page"' : "";
  return `<header class="md-app-bar">
    <a class="md-app-bar__brand" href="/" aria-label="Mind Diary home"${activeAttribute(activeNavigation, "home")}>
      <img src="${MIND_DIARY_UI_ASSETS.mark}" alt="" width="36" height="36">
      <span>Mind Diary</span>
    </a>
    <span class="md-environment" aria-label="Hosted environment: UAT" data-ia-uat-marker>UAT</span>
    <button class="md-menu-button" type="button" aria-expanded="false" aria-controls="application-navigation" aria-label="Navigation" data-menu-button data-ia-mobile-trigger>
      <span aria-hidden="true">☰</span><span>Menu</span>
    </button>
  </header>
  <div class="md-navigation-backdrop" data-navigation-backdrop hidden></div>
  <aside id="application-navigation" class="md-navigation-surface" aria-label="Application navigation" data-navigation data-ia-rail data-ia-mobile-drawer>
    <div class="md-rail-brand">
      <a class="md-brand" href="/" aria-label="Mind Diary home"${activeAttribute(activeNavigation, "home")}>
        <img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48">
      </a>
      <span class="md-environment" aria-label="Hosted environment: UAT" data-ia-uat-marker>UAT</span>
    </div>
    <nav class="md-navigation md-navigation--primary" aria-label="Primary" data-ia-nav="primary">
      <a href="/me" data-ia-nav-item="my-mind"${activeAttribute(activeNavigation, "my-mind")}><span aria-hidden="true">●</span> My Mind</a>
      <span class="md-navigation-divider" aria-hidden="true"></span>
      <a href="/minds" data-ia-nav-item="minds"${activeAttribute(activeNavigation, "minds")}><span aria-hidden="true">▤</span> Minds</a>
      <a href="/public" data-ia-nav-item="public"${activeAttribute(activeNavigation, "public")}><span aria-hidden="true">◎</span> Public Minds</a>
      <a href="/invitations" data-ia-nav-item="invitations"${activeAttribute(activeNavigation, "invitations")}><span aria-hidden="true">✉</span> Invitations</a>
    </nav>
    <nav class="md-navigation md-navigation--utility" aria-label="Utility" data-ia-nav="utility">
      <a href="/help/codex" data-ia-nav-item="help"${activeAttribute(activeNavigation, "help")}><span aria-hidden="true">?</span> Help with Codex</a>
      <a href="/settings/account" data-ia-nav-item="settings" data-ia-settings-item${settingsCurrentAttribute}><span aria-hidden="true">⚙</span> Settings</a>
    </nav>
  </aside>
  ${settingsContext}`;
}

/** Shared footer keeps Help reachable and names the hosted surface as UAT. */
export function renderMindDiaryAuthenticatedFooter(
  activeNavigation: MindDiaryNavigationTarget,
): string {
  void activeNavigation;
  return `<footer class="md-footer">
    <a href="/help">Support and UAT boundaries</a>
  </footer>`;
}

const VISIBILITY_COPY: Readonly<
  Record<MindVisibility, { readonly icon: string; readonly label: string }>
> = Object.freeze({
  private: { icon: "Lock", label: "Private — participants only" },
  unlisted: { icon: "Link", label: "Unlisted — anyone signed in with the link" },
  public: { icon: "Globe", label: "Public — listed for signed-in people" },
});

function safeMindRoute(route: string): string {
  return /^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(route) ? route : "#";
}

function renderMindCard(mind: UiMindCard): string {
  const visibility = VISIBILITY_COPY[mind.visibility];
  const personalLabel = mind.isPersonal
    ? '<span class="md-card__personal">My Mind</span>'
    : "";
  return `<article class="md-card md-entity-row" data-mind-card="${escapeUntrustedText(mind.id)}" data-ia-row>
    <h3><a href="${safeMindRoute(mind.route)}">${escapeUntrustedText(mind.name)}</a></h3>
    <div class="md-card__topline">
      ${personalLabel}
      <span class="md-status md-status--${mind.visibility}">
        <span class="md-status__icon" aria-hidden="true">${visibility.icon}</span>
        ${visibility.label}
      </span>
    </div>
    <p class="md-card__description">${escapeUntrustedText(mind.description)}</p>
    <dl class="md-card__metadata">
      <div><dt>Access</dt><dd>${mind.role}</dd></div>
      <div><dt>Activity</dt><dd>${escapeUntrustedText(mind.updatedLabel)}</dd></div>
    </dl>
  </article>`;
}

function renderCollection(collection: UiCollectionState): string {
  switch (collection.kind) {
    case "loading":
      return `<section class="md-state md-state--loading" aria-labelledby="minds-heading" aria-busy="true" data-home-minds-collection data-ia-route-state="loading">
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="minds-heading">Opening your Minds</h2>
        <p role="status" aria-live="polite">Loading Mind summaries…</p>
      </section>`;
    case "empty":
      return `<section class="md-state md-state--empty" aria-labelledby="minds-heading" data-home-minds-collection data-ia-route-state="empty">
        <span class="md-state__symbol" aria-hidden="true">+</span>
        <h2 id="minds-heading">Create your first shared Mind</h2>
        <p>My Mind is always yours. Create another Mind when you want to build from Memories with other people.</p>
        <button class="md-button md-button--primary" type="button" data-open-create-dialog data-ia-primary-action>Create a Mind</button>
      </section>`;
    case "error":
      return `<section class="md-state md-state--error" aria-labelledby="minds-heading" role="alert" data-home-minds-collection data-ia-route-state="error">
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="minds-heading">We couldn’t open your Minds</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-retry>Try again</button>
      </section>`;
    case "ready":
      return `<section aria-labelledby="minds-heading" data-home-minds-collection data-ia-collection>
        <div class="md-section-heading">
          <div>
            <p class="md-eyebrow">Your library</p>
            <h2 id="minds-heading">Minds</h2>
          </div>
          <button class="md-button md-button--primary" type="button" data-open-create-dialog data-ia-primary-action>Create a Mind</button>
        </div>
        <div class="md-card-grid">${collection.minds.map(renderMindCard).join("")}</div>
      </section>`;
  }
}

export function renderMindDiaryUiShell(model: MindDiaryUiShellModel): string {
  const announcement = model.announcement
    ? `<p class="md-announcement" role="status" aria-live="polite">
        <span aria-hidden="true">✓</span> ${escapeUntrustedText(model.announcement)}
      </p>`
    : "";

  return `<div class="md-shell" data-mind-diary-shell data-ia-shell data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, model.activeNavigation)}

    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header>
        <div>
          <p class="md-eyebrow">Workspace</p>
          <h1>Minds</h1>
          <p>Manage access and open the Mind you need.</p>
        </div>
        ${announcement}
      </div>
      ${renderCollection(model.collection)}
    </main>

    ${renderMindDiaryAuthenticatedFooter(model.activeNavigation)}

    <dialog class="md-dialog" id="create-mind-dialog" aria-labelledby="create-mind-title" aria-describedby="create-mind-description">
      <form class="md-form" method="dialog" data-create-mind-form>
        <div class="md-dialog__heading">
          <div>
            <p class="md-eyebrow">New shared space</p>
            <h2 id="create-mind-title">Create a Mind</h2>
          </div>
          <button class="md-icon-button" type="button" aria-label="Close create Mind dialog" data-close-dialog>×</button>
        </div>
        <p id="create-mind-description">Give this Mind a clear name. You can choose its participants and visibility after it is created.</p>
        <div class="md-field">
          <label for="mind-name">Mind name</label>
          <input id="mind-name" name="name" type="text" required maxlength="80" autocomplete="off" aria-describedby="mind-name-help">
          <p id="mind-name-help">For example, Research Notes or Family Recipes.</p>
        </div>
        <div class="md-field">
          <label for="mind-handle">Web address</label>
          <div class="md-handle-input"><span aria-hidden="true">/</span><input id="mind-handle" name="handle" type="text" required minlength="3" maxlength="63" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off" spellcheck="false" aria-describedby="mind-handle-help"></div>
          <p id="mind-handle-help">Use 3–63 lowercase letters, numbers, and single hyphens. The address cannot be changed in this prototype.</p>
        </div>
        <p class="md-form__status" role="status" aria-live="polite" data-form-status></p>
        <div class="md-dialog__actions">
          <button class="md-button md-button--secondary" type="button" data-close-dialog>Cancel</button>
          <button class="md-button md-button--primary" type="submit">Continue</button>
        </div>
      </form>
    </dialog>
  </div>`;
}

export function renderMindDiaryUiShellDocument(model: MindDiaryUiShellModel): string {
  const title = model.activeNavigation === "home" ? "Home" : "Minds";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  ${MIND_DIARY_FAVICON_LINKS}
  <title>${title} — Mind Diary UAT</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderMindDiaryUiShell(model)}
  <script type="module" src="${MIND_DIARY_UI_ASSETS.shellClient}"></script>
</body>
</html>`;
}

export type MindDiaryRoutePageState =
  | { readonly kind: "ready"; readonly message: string }
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "empty"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string };

export interface MindDiaryRoutePageModel {
  readonly displayName: string;
  readonly activeNavigation: MindDiaryNavigationTarget;
  readonly shellCurrent?: MindDiaryNavigationTarget | null;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly state: MindDiaryRoutePageState;
  readonly links?: readonly Readonly<{ readonly href: string; readonly label: string }>[];
  readonly guides?: readonly Readonly<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly prompt: string;
    readonly copyLabel: string;
  }>[];
}

const SAFE_PRODUCT_ROUTES = new Set<string>([
  "/",
  "/me",
  "/minds",
  "/public",
  "/invitations",
  "/help",
  "/help/codex",
  "/settings/account",
  "/settings/connections",
  "/settings/developer/mcp",
  "/settings/mcp",
]);

function safeProductRoute(value: string): string {
  return SAFE_PRODUCT_ROUTES.has(value) || /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
    ? value
    : "#";
}

function renderRoutePageState(state: MindDiaryRoutePageState): string {
  const message = escapeUntrustedText(state.message);
  switch (state.kind) {
    case "ready":
      return `<section class="md-state" data-route-state="ready" data-ia-route-state="ready"><span class="md-state__symbol" aria-hidden="true">✓</span><h2>Ready in this UAT workspace</h2><p>${message}</p></section>`;
    case "loading":
      return `<section class="md-state md-state--loading" aria-busy="true" data-route-state="loading" data-ia-route-state="loading"><div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div><h2>Loading current state</h2><p role="status" aria-live="polite">${message}</p></section>`;
    case "empty":
      return `<section class="md-state md-state--empty" data-route-state="empty" data-ia-route-state="empty"><span class="md-state__symbol" aria-hidden="true">○</span><h2>Nothing to show yet</h2><p>${message}</p></section>`;
    case "error":
      return `<section class="md-state md-state--error" role="alert" data-route-state="error" data-ia-route-state="error"><span class="md-state__symbol" aria-hidden="true">!</span><h2>Current state is unavailable</h2><p>${message}</p></section>`;
    case "forbidden":
      return `<section class="md-state md-state--error" role="alert" data-route-state="forbidden" data-ia-route-state="forbidden"><span class="md-state__symbol" aria-hidden="true">Lock</span><h2>This route is not available to your account</h2><p>${message}</p></section>`;
  }
}

function renderRoutePageGuides(model: MindDiaryRoutePageModel): string {
  if (!model.guides?.length) return "";
  const guides = model.guides.map((guide) => {
    const id = /^[a-z][a-z0-9-]{0,63}$/u.test(guide.id)
      ? guide.id
      : "unavailable-guide";
    return `<section class="md-setup-card" aria-labelledby="${id}-title" data-copy-ready-guide="${id}">
      <h2 id="${id}-title">${escapeUntrustedText(guide.title)}</h2>
      <p>${escapeUntrustedText(guide.description)}</p>
      <pre><code id="${id}" tabindex="-1" data-code-value>${escapeUntrustedText(guide.prompt)}</code></pre>
      <button class="md-button md-button--secondary" type="button" data-copy-code="${id}">${escapeUntrustedText(guide.copyLabel)}</button>
      <p class="md-form__status" role="status" aria-live="polite" data-code-copy-status></p>
    </section>`;
  }).join("");
  return `<div class="md-token-layout" data-route-guides>${guides}</div>`;
}

export function renderMindDiaryRoutePage(model: MindDiaryRoutePageModel): string {
  const shellCurrent = model.shellCurrent === undefined
    ? model.activeNavigation
    : model.shellCurrent;
  const links = model.links?.length
    ? `<nav class="md-route-links" aria-label="Page actions">${model.links.map((link) => `<a class="md-button md-button--secondary" href="${safeProductRoute(link.href)}">${escapeUntrustedText(link.label)}</a>`).join("")}</nav>`
    : "";
  return `<div class="md-shell" data-mind-diary-shell data-ia-shell data-mind-diary-route-page data-route-page="${escapeUntrustedText(model.activeNavigation)}" data-nav-open="false">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, shellCurrent)}
    <main id="main-content" class="md-main" tabindex="-1" data-ia-main>
      <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">${escapeUntrustedText(model.eyebrow)}</p><h1>${escapeUntrustedText(model.title)}</h1><p>${escapeUntrustedText(model.description)}</p></div></div>
      ${renderRoutePageState(model.state)}
      ${renderRoutePageGuides(model)}
      ${links}
    </main>
    ${renderMindDiaryAuthenticatedFooter(model.activeNavigation)}
  </div>`;
}

export function renderMindDiaryRoutePageDocument(model: MindDiaryRoutePageModel): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  ${MIND_DIARY_FAVICON_LINKS}
  <title>${escapeUntrustedText(model.title)} — Mind Diary UAT</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderMindDiaryRoutePage(model)}
  <script type="module" src="${MIND_DIARY_UI_ASSETS.shellClient}"></script>
</body>
</html>`;
}

function isDialogOpen(dialog: HTMLDialogElement): boolean {
  return dialog.open || dialog.hasAttribute("open");
}

export function installMindDiaryUiShell(
  root: Document | HTMLElement = document,
): () => void {
  const shell = root.querySelector<HTMLElement>("[data-mind-diary-shell]");
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
  const backdrop = shell.querySelector<HTMLElement>("[data-navigation-backdrop]");
  const view = shell.ownerDocument.defaultView;
  const wide = view?.matchMedia("(min-width: 1024px)") ?? null;
  const isWide = () => wide?.matches === true;
  const navigationFocusables = () => navigation === null
    ? []
    : Array.from(navigation.querySelectorAll<HTMLElement>("[data-ia-nav-item]"));
  const syncNavigation = (open = shell.dataset.navOpen === "true") => {
    if (!menuButton || !navigation) return;
    if (isWide()) {
      shell.dataset.navOpen = "false";
      menuButton.setAttribute("aria-expanded", "false");
      navigation.removeAttribute("inert");
      navigation.removeAttribute("aria-hidden");
      if (backdrop) backdrop.hidden = true;
      return;
    }
    shell.dataset.navOpen = String(open);
    menuButton.setAttribute("aria-expanded", String(open));
    navigation.toggleAttribute("inert", !open);
    navigation.setAttribute("aria-hidden", String(!open));
    if (backdrop) backdrop.hidden = !open;
  };
  const closeNavigation = (returnFocus = false) => {
    syncNavigation(false);
    if (returnFocus) menuButton?.focus();
  };
  if (menuButton && navigation) {
    syncNavigation(false);
    const toggleNavigation = () => {
      const open = shell.dataset.navOpen !== "true";
      syncNavigation(open);
      if (open) view?.requestAnimationFrame(() => view.requestAnimationFrame(() => {
        navigation.querySelector<HTMLAnchorElement>(
          '[data-ia-nav-item="my-mind"]',
        )?.focus({ preventScroll: true });
      }));
    };
    on<KeyboardEvent>(menuButton, "keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleNavigation();
    });
    on<MouseEvent>(menuButton, "click", toggleNavigation);
    for (const link of Array.from(navigation.querySelectorAll("a"))) {
      on(link, "click", () => {
        if (!isWide()) closeNavigation(false);
      });
    }
    if (backdrop) on<MouseEvent>(backdrop, "click", () => closeNavigation(true));
    if (wide) on<MediaQueryListEvent>(wide, "change", () => syncNavigation(false));
  }

  const dialog = shell.querySelector<HTMLDialogElement>("#create-mind-dialog");
  let dialogInvoker: HTMLElement | null = null;
  const closeDialog = () => {
    if (!dialog || !isDialogOpen(dialog)) return;
    if (typeof dialog.close === "function") dialog.close("cancel");
    else dialog.removeAttribute("open");
  };
  if (dialog) {
    for (const button of Array.from(
      shell.querySelectorAll<HTMLElement>("[data-open-create-dialog]"),
    )) {
      on<MouseEvent>(button, "click", () => {
        dialogInvoker = button;
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
        dialog.querySelector<HTMLInputElement>("#mind-name")?.focus();
      });
    }
    for (const button of Array.from(
      dialog.querySelectorAll<HTMLElement>("[data-close-dialog]"),
    )) {
      on<MouseEvent>(button, "click", closeDialog);
    }
    on(dialog, "close", () => {
      dialogInvoker?.focus();
      dialogInvoker = null;
    });
    on<MouseEvent>(dialog, "click", (event) => {
      if (event.target === dialog) closeDialog();
    });

    const form = dialog.querySelector<HTMLFormElement>("[data-create-mind-form]");
    const name = dialog.querySelector<HTMLInputElement>("#mind-name");
    const handle = dialog.querySelector<HTMLInputElement>("#mind-handle");
    const formStatus = dialog.querySelector<HTMLElement>("[data-form-status]");
    let handleWasEdited = false;
    if (name && handle) {
      on<InputEvent>(handle, "input", () => {
        handleWasEdited = handle.value.length > 0;
      });
      on<InputEvent>(name, "input", () => {
        if (handleWasEdited) return;
        handle.value = name.value
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 63);
      });
    }
    if (form && name && handle) {
      on<SubmitEvent>(form, "submit", (event) => {
        event.preventDefault();
        if (!form.reportValidity()) {
          if (formStatus) formStatus.textContent = "Check the highlighted fields.";
          return;
        }
        const detail = Object.freeze({ name: name.value, handle: handle.value });
        shell.dispatchEvent(
          new CustomEvent("mind-diary:create-mind", { bubbles: true, detail }),
        );
        if (formStatus) formStatus.textContent = "Mind details are ready to submit.";
      });
    }
  }

  const retry = shell.querySelector<HTMLButtonElement>("[data-retry]");
  if (retry) {
    on<MouseEvent>(retry, "click", () => {
      shell.dispatchEvent(new CustomEvent("mind-diary:retry", { bubbles: true }));
      retry.textContent = "Trying again…";
      retry.disabled = true;
    });
  }

  on<KeyboardEvent>(shell, "keydown", (event) => {
    if (event.key === "Escape" && dialog && isDialogOpen(dialog)) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (!isWide() && shell.dataset.navOpen === "true") {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation(true);
        return;
      }
      if (event.key === "Tab") {
        const items = navigationFocusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && shell.ownerDocument.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && shell.ownerDocument.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
  });

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
