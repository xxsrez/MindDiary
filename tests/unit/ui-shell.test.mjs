import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_UI_SHELL_MODEL,
  MIND_DIARY_FONT_DELIVERY,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  renderMindDiaryUiShell,
  renderMindDiaryUiShellDocument,
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
  assert.match(html, /<nav[^>]+aria-label="Primary"/);
  assert.match(html, /<main id="main-content"[^>]+tabindex="-1"/);
  assert.match(html, /<footer\b/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, />My Mind</);
  assert.match(html, />Minds</);
  assert.match(html, /Memories/);
  assert.match(html, /Create a Mind/);
  assert.match(html, /<dialog[^>]+aria-labelledby="create-mind-title"[^>]+aria-describedby=/);
  assert.match(html, /<label for="mind-name">Mind name<\/label>/);
  assert.match(html, /<label for="mind-handle">Web address<\/label>/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /<(?:textarea|iframe)\b|contenteditable|type="file"/i);
  assert.doesNotMatch(html, /\b(?:brain|robot|neon|train your mind|knows everything)\b/i);
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
  assert.match(document, /mind-diary-tokens\.css/);
  assert.match(document, /<script type="module" src="\/ui\/mind-diary-shell-client\.js"><\/script>/);

  assert.match(shellCss, /:focus-visible\s*{/);
  assert.match(shellCss, /outline:\s*3px solid var\(--mind-diary-memory-plum/);
  assert.match(shellCss, /min-height:\s*2\.75rem/);
  assert.match(shellCss, /@media \(max-width: 36rem\)/);
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shellCss, /@media \(forced-colors: active\)/);
  assert.match(shellCss, /\.md-status__icon/);
  assert.match(shellCss, /\.md-state--error/);
});
