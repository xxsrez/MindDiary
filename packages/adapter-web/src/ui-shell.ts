export const MIND_DIARY_UI_ASSETS = Object.freeze({
  lockup: "/brand/mind-diary-lockup.svg",
  mark: "/brand/mind-diary-mark.svg",
  tokens: "/brand/mind-diary-tokens.css",
  shellStyles: "/ui/mind-diary-shell.css",
  shellClient: "/ui/mind-diary-shell-client.js",
});

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
  readonly activeNavigation: "my-mind" | "minds" | "invitations" | "tokens";
  readonly collection: UiCollectionState;
  readonly announcement?: string;
}

export const DEFAULT_UI_SHELL_MODEL: MindDiaryUiShellModel = Object.freeze({
  displayName: "Andrey",
  activeNavigation: "minds",
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
  current: MindDiaryUiShellModel["activeNavigation"],
  item: MindDiaryUiShellModel["activeNavigation"],
): string {
  return current === item ? ' aria-current="page"' : "";
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
  return `<article class="md-card" data-mind-card="${escapeUntrustedText(mind.id)}">
    <div class="md-card__topline">
      ${personalLabel}
      <span class="md-status md-status--${mind.visibility}">
        <span class="md-status__icon" aria-hidden="true">${visibility.icon}</span>
        ${visibility.label}
      </span>
    </div>
    <h3><a href="${safeMindRoute(mind.route)}">${escapeUntrustedText(mind.name)}</a></h3>
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
      return `<section class="md-state md-state--loading" aria-labelledby="minds-heading" aria-busy="true">
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="minds-heading">Opening your Minds</h2>
        <p role="status" aria-live="polite">Loading Mind summaries…</p>
      </section>`;
    case "empty":
      return `<section class="md-state md-state--empty" aria-labelledby="minds-heading">
        <span class="md-state__symbol" aria-hidden="true">+</span>
        <h2 id="minds-heading">Create your first shared Mind</h2>
        <p>My Mind is always yours. Create another Mind when you want to build from Memories with other people.</p>
        <button class="md-button md-button--primary" type="button" data-open-create-dialog>Create a Mind</button>
      </section>`;
    case "error":
      return `<section class="md-state md-state--error" aria-labelledby="minds-heading" role="alert">
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="minds-heading">We couldn’t open your Minds</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-retry>Try again</button>
      </section>`;
    case "ready":
      return `<section aria-labelledby="minds-heading">
        <div class="md-section-heading">
          <div>
            <p class="md-eyebrow">Your library</p>
            <h2 id="minds-heading">Minds</h2>
          </div>
          <button class="md-button md-button--primary" type="button" data-open-create-dialog>Create a Mind</button>
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

  return `<div class="md-shell" data-mind-diary-shell data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    <header class="md-header">
      <a class="md-brand" href="/" aria-label="Mind Diary home">
        <img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48">
      </a>
      <button class="md-menu-button" type="button" aria-expanded="false" aria-controls="primary-navigation" data-menu-button>
        <span aria-hidden="true">Menu</span><span>Navigation</span>
      </button>
      <nav id="primary-navigation" class="md-navigation" aria-label="Primary" data-navigation>
        <a href="/me"${activeAttribute(model.activeNavigation, "my-mind")}><span aria-hidden="true">●</span> My Mind</a>
        <a href="/minds"${activeAttribute(model.activeNavigation, "minds")}><span aria-hidden="true">▤</span> Minds</a>
        <a href="/invitations"${activeAttribute(model.activeNavigation, "invitations")}><span aria-hidden="true">✉</span> Invitations</a>
        <a href="/settings/mcp"${activeAttribute(model.activeNavigation, "tokens")}><span aria-hidden="true">⌁</span> MCP setup</a>
      </nav>
      <button class="md-profile" type="button" aria-label="Open account menu for ${escapeUntrustedText(model.displayName)}">
        <span class="md-profile__initial" aria-hidden="true">${escapeUntrustedText(model.displayName.slice(0, 1).toUpperCase())}</span>
        <span>${escapeUntrustedText(model.displayName)}</span>
      </button>
    </header>

    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading">
        <div>
          <p class="md-eyebrow">Build a Mind from Memories</p>
          <h1>Welcome back, ${escapeUntrustedText(model.displayName)}</h1>
          <p>Open a Mind to manage who can use it, or connect Codex to work with its Memories.</p>
        </div>
        ${announcement}
      </div>
      ${renderCollection(model.collection)}
    </main>

    <footer class="md-footer">
      <p><strong>Mind Diary</strong> keeps the knowledge you choose in versioned Minds.</p>
      <a href="/help">Help and accessibility</a>
    </footer>

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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Minds — Mind Diary</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderMindDiaryUiShell(model)}
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
    for (const link of Array.from(navigation.querySelectorAll("a"))) {
      on(link, "click", closeNavigation);
    }
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
    if (event.key !== "Escape") return;
    if (dialog && isDialogOpen(dialog)) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (shell.dataset.navOpen === "true") {
      closeNavigation();
      menuButton?.focus();
    }
  });

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
