import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_UI_SHELL_MODEL,
  MIND_DIARY_FONT_DELIVERY,
  MIND_DIARY_ISOLATED_ACCOUNT_ACTION,
  MIND_DIARY_ONBOARDING_ASSETS,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  renderAuthenticatedOnboarding,
  renderAuthenticatedOnboardingDocument,
  renderMindDiaryUiShell,
  renderMindDiaryUiShellDocument,
  renderMindDiaryRoutePage,
} from "../../packages/adapter-web/dist/index.js";

const shellCss = await readFile(
  new URL("../../packages/adapter-web/src/ui-shell.css", import.meta.url),
  "utf8",
);
const brandTokens = await readFile(
  new URL("../../docs/assets/brand/mind-diary-tokens.css", import.meta.url),
  "utf8",
);

function tokenHex(name) {
  const match = brandTokens.match(new RegExp(`--mind-diary-${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `missing brand token ${name}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test("shell uses canonical brand assets and an honest no-network font fallback", () => {
  assert.deepEqual(MIND_DIARY_UI_ASSETS, {
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
  assert.deepEqual(MIND_DIARY_FONT_DELIVERY, {
    mode: "system-fallback",
    productionDeliveryVerified: false,
    externalRequests: false,
    displayStack: '"Fraunces", Georgia, serif',
    uiStack: '"Inter", system-ui, sans-serif',
  });
  assert.match(shellCss, /^@import url\("\/brand\/mind-diary-tokens\.css"\);/);
  assert.doesNotMatch(shellCss, /@font-face|https?:\/\/|fonts\.(?:googleapis|gstatic)/i);
});

test("canonical text pairs meet contrast baseline and low-contrast accents are non-text cues", () => {
  const paper = tokenHex("paper");
  const ink = tokenHex("ink");
  const plum = tokenHex("memory-plum");
  const white = tokenHex("white");

  assert.ok(contrastRatio(ink, paper) >= 4.5);
  assert.ok(contrastRatio(plum, paper) >= 4.5);
  assert.ok(contrastRatio(white, ink) >= 4.5);
  assert.ok(contrastRatio(white, plum) >= 4.5);
  assert.doesNotMatch(
    shellCss,
    /(?:^|\n)\s*color:\s*var\(--mind-diary-(?:living-coral|quiet-brass|quiet-sage)/,
  );
});

test("untrusted display text is escaped in text and attribute positions", () => {
  const malicious = `<img src=x onerror="globalThis.pwned=1">&'`;
  assert.equal(
    escapeUntrustedText(malicious),
    "&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt;&amp;&#39;",
  );

  const html = renderMindDiaryUiShell({
    displayName: malicious,
    activeNavigation: "minds",
    announcement: `<script>globalThis.pwned=2</script>`,
    collection: {
      kind: "ready",
      minds: [
        {
          id: `mind\" onmouseover=\"globalThis.pwned=3`,
          name: `<svg onload="globalThis.pwned=4">`,
          route: `javascript:globalThis.pwned=5`,
          description: `<script>globalThis.pwned=6</script>`,
          visibility: "private",
          role: "Reader",
          updatedLabel: `<b>now</b>`,
        },
      ],
    },
  });

  assert.doesNotMatch(html, /<(?:script|svg|img)\b[^>]*(?:onerror|onload|pwned)/i);
  assert.doesNotMatch(html, /\son(?:click|error|load|mouseover)\s*=\s*["']/i);
  assert.match(html, /<h3><a href="#">/);
  assert.match(html, /&lt;script&gt;globalThis\.pwned=6&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=&quot;globalThis\.pwned=4&quot;&gt;/);
});

test("ready shell has semantic navigation, product language, form and modal contracts", () => {
  const html = renderMindDiaryUiShell(DEFAULT_UI_SHELL_MODEL);
  assert.match(html, /<header\b/);
  assert.match(html, /<nav[^>]+aria-label="Primary"[^>]+data-ia-nav="primary"/);
  assert.match(html, /<nav[^>]+aria-label="Utility"[^>]+data-ia-nav="utility"/);
  assert.match(html, /<main id="main-content"[^>]+tabindex="-1"[^>]+data-ia-main/);
  assert.match(html, /<footer\b/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, />My Mind</);
  assert.match(html, />Minds</);
  assert.match(html, /Public Minds<\/a>/);
  assert.match(html, /href="\/settings\/account"/);
  assert.match(html, /Hosted environment: UAT/);
  assert.match(html, /data-ia-settings-item/);
  assert.match(html, /data-ia-mobile-drawer/);
  const drawerMarkup = html.match(/<aside[^>]*data-ia-mobile-drawer[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(drawerMarkup, /\s(?:inert|aria-hidden)(?:=|\s|>)/);
  assert.match(html, /data-ia-collection/);
  assert.match(html, /data-ia-row/);
  assert.match(html, /Memories/);
  assert.match(html, /Create a Mind/);
  assert.match(html, /<dialog[^>]+aria-labelledby="create-mind-title"[^>]+aria-describedby=/);
  assert.match(html, /<label for="mind-name">Mind name<\/label>/);
  assert.match(html, /<label for="mind-handle">Web address<\/label>/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /<(?:textarea|iframe)\b|contenteditable|type="file"/i);
  assert.doesNotMatch(
    html.match(/<nav[^>]+data-ia-nav="primary"[\s\S]*?<\/nav>/)?.[0] ?? "",
    /settings\/connections|Advanced MCP/,
  );
  assert.doesNotMatch(html, /\b(?:brain|robot|neon|train your mind|knows everything)\b/i);
});

test("pilot route shell keeps exact links, active state, safe route states, and UAT wording", () => {
  const routes = [
    ["home", "/"],
    ["my-mind", "/me"],
    ["minds", "/minds"],
    ["public", "/public"],
    ["invitations", "/invitations"],
    ["account", "/settings/account"],
    ["connections", "/settings/connections"],
    ["help", "/help/codex"],
  ];
  for (const [activeNavigation, expectedRoute] of routes) {
    const html = renderMindDiaryRoutePage({
      displayName: "Pilot User",
      activeNavigation,
      eyebrow: "Pilot route",
      title: "Safe page",
      description: "Server-rendered control state.",
      state: { kind: "ready", message: "No private content is rendered." },
      links: [{ href: expectedRoute, label: "Current route" }],
    });
    const expectedCurrent = activeNavigation === "home"
      ? 2
      : activeNavigation === "account" || activeNavigation === "connections"
        ? 2
        : 1;
    assert.equal(
      (html.match(/aria-current="page"/g) ?? []).length,
      expectedCurrent,
      activeNavigation,
    );
    assert.match(html, new RegExp(`href="${expectedRoute.replaceAll("/", "\\/")}"`));
    assert.match(html, /Hosted environment: UAT/);
    assert.match(html, /href="\/public"/);
    assert.match(html, /href="\/settings\/account"/);
    assert.match(html, /href="\/help\/codex"/);
  }

  for (const kind of ["loading", "empty", "error", "forbidden"]) {
    const html = renderMindDiaryRoutePage({
      displayName: "Pilot User",
      activeNavigation: "help",
      eyebrow: "Pilot route",
      title: "Safe page",
      description: "Server-rendered control state.",
      state: { kind, message: `<script>globalThis.pwned=true</script>` },
      links: [{ href: "javascript:globalThis.pwned=true", label: `<img src=x>` }],
    });
    assert.match(html, /data-mind-diary-shell/);
    assert.match(html, new RegExp(`data-route-state="${kind}"`));
    assert.doesNotMatch(html, /<script\b|href="javascript:/i);
    assert.doesNotMatch(html, /aria-label="Page actions">.*<img\b/is);
    assert.match(html, /&lt;script&gt;globalThis\.pwned=true&lt;\/script&gt;/);
    assert.match(html, /href="#"/);
  }

  const deepHelp = renderMindDiaryRoutePage({
    displayName: "Pilot User",
    activeNavigation: "help",
    shellCurrent: null,
    eyebrow: "Pilot help",
    title: "Help and accessibility",
    description: "Server-rendered help.",
    state: { kind: "ready", message: "No private content is rendered." },
    links: [{ href: "/settings/developer/mcp", label: "Open Advanced MCP" }],
  });
  assert.match(deepHelp, /href="\/settings\/developer\/mcp"[^>]*>Open Advanced MCP<\/a>/);
  assert.equal((deepHelp.match(/aria-current="page"/g) ?? []).length, 0);
});

test("loading, empty and error views communicate state without color alone", () => {
  const base = {
    displayName: "Andrey",
    activeNavigation: "minds",
  };
  const loading = renderMindDiaryUiShell({ ...base, collection: { kind: "loading" } });
  const empty = renderMindDiaryUiShell({ ...base, collection: { kind: "empty" } });
  const error = renderMindDiaryUiShell({
    ...base,
    collection: { kind: "error", message: "The service is unavailable." },
  });

  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading Mind summaries…/);
  assert.match(empty, /Create your first shared Mind/);
  assert.match(empty, /data-open-create-dialog/);
  assert.match(error, /role="alert"/);
  assert.match(error, /We couldn’t open your Minds/);
  assert.match(error, /data-retry/);
});

test("document and CSS provide responsive keyboard and high-contrast foundations", () => {
  const document = renderMindDiaryUiShellDocument(DEFAULT_UI_SHELL_MODEL);
  assert.match(document, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(document, /<html lang="en">/);
  assert.match(document, /mind-diary-lockup\.svg/);
  assert.match(document, /rel="icon" href="\/favicon\.ico" sizes="16x16 32x32"/);
  assert.match(document, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any"/);
  assert.match(document, /rel="apple-touch-icon" href="\/apple-touch-icon\.png" type="image\/png" sizes="180x180"/);
  assert.match(document, /mind-diary-tokens\.css/);
  assert.match(document, /<script type="module" src="\/ui\/mind-diary-shell-client\.js"><\/script>/);

  assert.match(shellCss, /:focus-visible\s*{/);
  assert.match(shellCss, /outline:\s*3px solid var\(--mind-diary-memory-plum/);
  assert.match(shellCss, /min-height:\s*2\.75rem/);
  assert.match(shellCss, /@media \(max-width: 36rem\)/);
  assert.match(shellCss, /@media \(min-width: 64rem\)/);
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shellCss, /@media \(forced-colors: active\)/);
  assert.match(shellCss, /\.md-status__icon/);
  assert.match(shellCss, /\.md-state--error/);
  assert.match(shellCss, /\.md-environment/);
  assert.match(shellCss, /\.md-navigation-surface/);
  assert.match(shellCss, /\.md-context-navigation a\[aria-current="page"\]/);
});

test("anonymous onboarding exposes only the Sites auth entry, never the control plane", () => {
  const html = renderAuthenticatedOnboarding({
    kind: "anonymous",
    authEntryPath: "/signin-with-chatgpt",
  });

  assert.match(html, /data-session-state="anonymous"/);
  assert.match(html, /data-sites-auth-entry/);
  assert.match(html, />Sign in with ChatGPT</);
  assert.match(html, /href="\/signin-with-chatgpt"/);
  assert.doesNotMatch(html, /return_to|\/auth\/sign-in/u);
  assert.doesNotMatch(html, /data-control-plane|primary-navigation|data-personal-mind-card|data-profile-form/);

  const unsafe = renderAuthenticatedOnboarding({
    kind: "anonymous",
    authEntryPath: `javascript:globalThis.pwned=1`,
  });
  assert.match(unsafe, /data-sites-auth-entry[^>]*href="#"|href="#"[^>]*data-sites-auth-entry/);
  assert.doesNotMatch(unsafe, /javascript:|globalThis\.pwned/);
});

test("unknown identity offers explicit isolated creation and categorical manual recovery only", () => {
  const html = renderAuthenticatedOnboarding({
    kind: "registration_required",
    suggestedDisplayName: "Andrey",
    bootstrapIdempotencyKey: "bootstrap-attempt-0001",
    manualRecoveryStatus: "available",
  });

  assert.equal(MIND_DIARY_ISOLATED_ACCOUNT_ACTION, "create_isolated_account");
  assert.match(html, /data-session-state="registration_required"/);
  assert.match(html, /Create a new isolated account/);
  assert.match(html, /does not inherit, relink, or merge earlier access/i);
  assert.match(html, /data-bootstrap-key="bootstrap-attempt-0001"/);
  assert.match(html, /data-manual-recovery/);
  assert.match(html, /Nothing is relinked, merged, or transferred automatically/);
  assert.match(html, /same trusted channel that admitted you/);
  assert.match(html, /Never send an MCP token, private Mind content, query, export URL, or download URL/);
  assert.match(html, /access remains unchanged during review/);
  assert.doesNotMatch(html, /@[a-z0-9.-]+|verified[_ -]?email|data-control-plane/i);

  for (const status of ["requested", "unavailable"]) {
    const statusHtml = renderAuthenticatedOnboarding({
      kind: "registration_required",
      bootstrapIdempotencyKey: "bootstrap-attempt-0001",
      manualRecoveryStatus: status,
    });
    assert.match(statusHtml, /role="status"/);
    assert.doesNotMatch(statusHtml, /data-manual-recovery/);
  }
});

test("bootstrap progress and retry keep one stable request identity and explicit final state", () => {
  const progress = renderAuthenticatedOnboarding({ kind: "bootstrapping" });
  const failure = renderAuthenticatedOnboarding({
    kind: "bootstrap_error",
    displayName: "Andrey",
    bootstrapIdempotencyKey: "bootstrap-attempt-0001",
    message: "Setup storage is temporarily unavailable.",
    retryable: true,
  });

  assert.match(progress, /aria-busy="true"/);
  assert.match(progress, /Account, private My Mind, and owner access are being created together/);
  assert.match(failure, /role="alert"/);
  assert.match(failure, /data-bootstrap-retry/);
  assert.match(failure, /data-bootstrap-key="bootstrap-attempt-0001"/);
  assert.match(failure, /cannot intentionally create a second account or My Mind/);

  const invalidKey = renderAuthenticatedOnboarding({
    kind: "bootstrap_error",
    displayName: "Andrey",
    bootstrapIdempotencyKey: `bad\" onmouseover=\"globalThis.pwned=1`,
    message: "Unavailable.",
    retryable: true,
  });
  assert.doesNotMatch(invalidKey, /data-bootstrap-retry|onmouseover|globalThis\.pwned/);
});

function authenticatedModel(profileUpdate = { kind: "idle", idempotencyKey: "profile-attempt-0001" }) {
  return {
    kind: "authenticated",
    displayName: "Andrey",
    profileVersion: 3,
    personalMind: {
      route: "/me",
      name: "Andrey",
      headRevisionId: "revision_personal",
      updatedLabel: "Updated today",
    },
    profileUpdate,
  };
}

test("authenticated My Mind card exposes only /me and Personal-safe management", () => {
  const html = renderAuthenticatedOnboarding(authenticatedModel());

  assert.match(html, /data-session-state="authenticated"/);
  assert.match(html, /data-control-plane/);
  assert.match(html, /data-personal-mind-card/);
  assert.match(html, /<a href="\/me">\/me<\/a>/);
  assert.match(html, /Private — only you/);
  assert.match(html, /Owner — only you/);
  assert.match(html, /data-profile-form/);
  assert.match(html, /data-profile-version="3"/);
  assert.match(html, /does not edit Memories or create a content revision/i);
  assert.match(html, /Create your first useful Memory/u);
  assert.match(html, /href="\/help\/codex">Open the Codex setup guide<\/a>/u);
  assert.match(html, /class="md-setup-card md-setup-card--single"/u);
  assert.match(html, /data-copy-code="mind-diary-onboarding-starter-playbook"/u);
  assert.match(html, /data-copy-code="mind-diary-onboarding-concierge-playbook"/u);
  assert.match(html, /data-markdown-import[^>]+data-import-handle="me"/u);
  assert.match(html, /type="file"[^>]+data-import-files/u);
  assert.match(html, /only UTF-8 Markdown/u);
  assert.match(html, /Never store a token in a repository/u);
  assert.doesNotMatch(html, /space_handle|hidden handle|data-(?:share|visibility|transfer|delete)/i);
  assert.doesNotMatch(html, /<(?:textarea|iframe)\b|contenteditable/i);
  assert.doesNotMatch(html, /<button[^>]*>[^<]*(?:Share|Visibility|Transfer|Delete)/i);

  assert.match(shellCss, /\.md-setup-card > \*\s*\{\s*min-width:\s*0;/u);
  assert.match(shellCss, /\.md-setup-card--single\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(shellCss, /\.md-setup-card pre\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/su);
  assert.match(shellCss, /@media \(max-width: 58rem\)[\s\S]*?\.md-setup-card\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/u);
});

test("profile states distinguish saving, success, transient failure, and stale conflict", () => {
  const saving = renderAuthenticatedOnboarding(
    authenticatedModel({ kind: "saving", idempotencyKey: "profile-attempt-0001" }),
  );
  const saved = renderAuthenticatedOnboarding(
    authenticatedModel({ kind: "saved", message: "Profile name saved.", idempotencyKey: "profile-attempt-0001" }),
  );
  const error = renderAuthenticatedOnboarding(
    authenticatedModel({ kind: "error", message: "Profile storage is unavailable.", retryable: true, idempotencyKey: "profile-attempt-0001" }),
  );
  const conflict = renderAuthenticatedOnboarding(
    authenticatedModel({ kind: "conflict", message: "Your profile changed in another session." }),
  );

  assert.match(saving, /Saving your profile name…/);
  assert.match(saving, /id="profile-display-name"[^>]+disabled/);
  assert.match(saved, /Profile name saved\./);
  assert.match(error, /role="alert"/);
  assert.match(error, /submit the same change again/);
  assert.match(conflict, /data-refresh-session/);
  assert.match(conflict, /Reload account state/);
  assert.doesNotMatch(conflict, /data-profile-key=/);
});

test("onboarding escapes all profile text and loads only a safe local client", () => {
  const malicious = `<img src=x onerror="globalThis.pwned=1">`;
  const html = renderAuthenticatedOnboarding({
    ...authenticatedModel(),
    displayName: malicious,
    personalMind: {
      route: "/me",
      name: `<svg onload="globalThis.pwned=2">`,
      headRevisionId: "revision_personal",
      updatedLabel: `<script>globalThis.pwned=3</script>`,
    },
  });

  assert.doesNotMatch(html, /<(?:script|svg|img)\b[^>]*(?:onerror|onload|pwned)/i);
  assert.doesNotMatch(html, /\son(?:error|load|mouseover)\s*=\s*["']/i);
  assert.match(html, /&lt;svg onload=&quot;globalThis\.pwned=2&quot;&gt;/);

  assert.deepEqual(MIND_DIARY_ONBOARDING_ASSETS, {
    shellStyles: "/ui/mind-diary-shell.css",
    client: "/ui/mind-diary-onboarding-client.js",
  });
  const safe = renderAuthenticatedOnboardingDocument(
    authenticatedModel(),
    "/fixture/onboarding-client.mjs",
  );
  const unsafe = renderAuthenticatedOnboardingDocument(
    authenticatedModel(),
    `javascript:globalThis.pwned=4`,
  );
  assert.match(safe, /src="\/fixture\/onboarding-client\.mjs"/);
  assert.doesNotMatch(unsafe, /javascript:|globalThis\.pwned|<script type="module"/);
  assert.match(shellCss, /\.md-auth-choice-grid/);
  assert.match(shellCss, /\.md-my-mind-layout/);
  assert.match(shellCss, /\.md-personal-summary/);
});
