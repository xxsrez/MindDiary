import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const fixtureServer = resolve(import.meta.dirname, "fixture-server.mjs");
const fixtureDefinitions = Object.freeze([
  Object.freeze({ count: 0, port: 4310 }),
  Object.freeze({ count: 1, port: 4311 }),
  Object.freeze({ count: 21, port: 4312 }),
]);
const processes = [];

async function waitForFixture(origin, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`browser fixture exited before health check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/_fixture/health`, { cache: "no-store" });
      if (response.status === 200) return;
    } catch {
      // The deterministic loopback listener may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("browser fixture health check timed out");
}

async function startFixture(definition) {
  const child = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: {
      ...process.env,
      MIND_DIARY_BROWSER_FIXTURE_COUNT: String(definition.count),
      MIND_DIARY_BROWSER_FIXTURE_PORT: String(definition.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString("utf8"); });
  const origin = `http://127.0.0.1:${definition.port}`;
  try {
    await waitForFixture(origin, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}; fixture diagnostics: ${diagnostics.slice(0, 500)}`);
  }
  processes.push(child);
  return Object.freeze({ ...definition, origin, child });
}

async function stopFixture(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("browser fixture did not terminate")),
      5_000,
    )),
  ]);
}

async function expectNoHorizontalOverflow(page) {
  const result = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    panels: [...document.querySelectorAll(
      "main, .md-token-card, .md-setup-card, .md-binding-panel, dialog",
    )]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      .filter((entry) => entry.scrollWidth > entry.clientWidth + 1),
  }));
  expect(result.documentWidth, JSON.stringify(result)).toBeLessThanOrEqual(result.viewport + 1);
  expect(result.bodyWidth, JSON.stringify(result)).toBeLessThanOrEqual(result.viewport + 1);
  expect(result.panels, JSON.stringify(result)).toEqual([]);
}

async function tabUntil(page, selector, maximumTabs = 100) {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press("Tab");
    const matches = await page.evaluate((candidate) =>
      document.activeElement?.matches(candidate) === true, selector);
    if (matches) return;
  }
  throw new Error(`keyboard focus did not reach ${selector}`);
}

async function assertPageHasNoBrowserErrors(page, action) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.name}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console:${message.text().slice(0, 200) || message.type()}`);
    }
  });
  await action();
  expect(errors).toEqual([]);
}

let fixtures;

test.beforeAll(async () => {
  fixtures = [];
  for (const definition of fixtureDefinitions) {
    fixtures.push(await startFixture(definition));
  }
});

test.afterAll(async () => {
  await Promise.all(processes.map(stopFixture));
});

for (const definition of fixtureDefinitions) {
  test(`real DOM exposes four canonical routes for the ${definition.count}-item fixture`, async ({
    browser,
  }) => {
    const fixture = fixtures.find((candidate) => candidate.count === definition.count);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await assertPageHasNoBrowserErrors(page, async () => {
      await page.goto(`${fixture.origin}/settings/connections`);
      await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
      await expect(page.locator("[data-ia-codex-help-link]")).toHaveAttribute(
        "href",
        "/help/codex",
      );
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await expect(page.locator("[data-connections-page] .md-token-card")).toHaveCount(
        Math.min(definition.count, 20),
      );
      await expect(page.getByRole("link", { name: "Next connections" })).toHaveCount(
        definition.count === 21 ? 1 : 0,
      );
      await expect(page.locator("[data-connections-collection]")).toHaveAttribute(
        "data-collection-state",
        definition.count === 0 ? "empty" : "ready",
      );
      if (definition.count === 0) {
        await expect(page.getByRole("link", { name: "Open the three-step guide" }))
          .toHaveAttribute("href", "/help/codex");
      }
      await expectNoHorizontalOverflow(page);

      if (definition.count > 0) {
        const hydratedCard = page.locator("[data-connections-collection] .md-token-card").first();
        const hydratedReadSummary = hydratedCard
          .locator("dt", { hasText: /^Can read$/u })
          .locator("..").locator("dd");
        await expect(hydratedReadSummary).toHaveText("1 available");
        await expect(hydratedReadSummary).not.toContainText("selected");
        await expect(page.locator("[data-connections-collection]")).not.toContainText(
          /read selector|attach|detach/iu,
        );

        const ref = `conn_v1_${"1".padStart(32, "0")}`;
        await page.goto(`${fixture.origin}/settings/connections/${ref}`);
        await expect(page.locator("[data-ia-codex-help-link]")).toHaveAttribute(
          "href",
          "/help/codex",
        );
        await expect(page.getByRole("heading", {
          level: 1,
          name: "Codex Marketplace on a deliberately narrow mobile viewport",
        })).toBeVisible();
        const readHeading = page.getByRole("heading", { level: 2, name: "Can read" });
        await expect(readHeading).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "Can add and change" })).toBeVisible();
        await expect(page.getByText("3 Minds are readable with your current access.", { exact: false })).toBeVisible();
        const readSummary = readHeading.locator("..");
        await expect(readSummary).toContainText("Access follows current membership and visibility automatically.");
        await expect(readSummary.locator("li, select, button")).toHaveCount(0);
        await expect(readSummary).not.toContainText(/read selector|attach|detach/iu);
        await expect(page.getByRole("button", { name: "Revoke connection" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }

      await page.goto(`${fixture.origin}/settings/developer/mcp`);
      await expect(page.getByRole("heading", { level: 1, name: "Advanced MCP" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Personal token state" })).toBeVisible();
      await expect(page.locator("[data-personal-token]")).toHaveCount(
        Math.min(definition.count, 20),
      );
      await expect(page.getByRole("link", { name: "Next tokens" })).toHaveCount(
        definition.count === 21 ? 1 : 0,
      );
      await expect(page.getByRole("dialog", { name: "Copy your token now" })).toBeHidden();
      await expectNoHorizontalOverflow(page);

      await page.goto(`${fixture.origin}/help/codex`);
      await expect(page.getByRole("heading", {
        level: 1,
        name: "Use Mind Diary with Codex",
      })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "Install Mind Diary" })).toBeVisible();
      await expect(page.getByRole("heading", {
        level: 2,
        name: "Discover readable Minds and start",
      })).toBeVisible();
      await expect(page.getByLabel("Desktop").getByText(
        "Readable Minds follow your current memberships and visibility automatically; there is no read attachment step.",
      )).toBeVisible();
      await expect(page.getByText("Writing is optional.", { exact: false })).toBeVisible();
      await expect(page.getByText("select at most one writable Mind", { exact: false })).toBeVisible();
      await expect(page.getByText(
        "Only the Mind Diary Site can select, switch, or clear this target; Codex cannot manage it through content MCP.",
      )).toBeVisible();
      await expect(page.getByText(/Choose readable Minds|attach at least one Mind/u)).toHaveCount(0);
      await expect(page.getByText("Revoke and reconnect only when the existing connection is no longer usable.")).toBeVisible();
      const accessibilityTree = await page.locator("main").ariaSnapshot();
      expect(accessibilityTree).toContain('heading "Use Mind Diary with Codex"');
      expect(accessibilityTree).toContain('link "Connections"');
      await expectNoHorizontalOverflow(page);
    });
    await context.close();
  });
}

test("mobile viewport keeps every route bounded and opens primary navigation by keyboard", async ({
  browser,
}) => {
  const fixture = fixtures.find((candidate) => candidate.count === 21);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  for (const path of [
    "/settings/connections",
    `/settings/connections/conn_v1_${"1".padStart(32, "0")}`,
    "/settings/developer/mcp",
    "/help/codex",
  ]) {
    await page.goto(`${fixture.origin}${path}`);
    await expectNoHorizontalOverflow(page);
  }
  await page.goto(`${fixture.origin}/settings/connections`);
  await tabUntil(page, "[data-menu-button]");
  await expect(page.getByRole("button", { name: "Navigation" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Navigation" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("link", { name: "My Mind" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Navigation" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("button", { name: "Navigation" })).toBeFocused();
  await context.close();
});

test("ordinary Connections and Help never load personal-token history or diagnostics", async ({
  browser,
}) => {
  const fixture = fixtures.find((candidate) => candidate.count === 1);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const requested = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  const ref = `conn_v1_${"1".padStart(32, "0")}`;

  for (const path of [
    "/settings/connections",
    `/settings/connections/${ref}`,
    "/help/codex",
  ]) {
    await page.goto(`${fixture.origin}${path}`);
    await expect(page.locator("main")).toBeVisible();
  }

  expect(requested.some((path) => path.startsWith("/api/v1/mcp-tokens"))).toBe(false);
  expect(requested.some((path) => path === "/api/mcp" || path.startsWith("/api/mcp/")))
    .toBe(false);
  await expect(page.locator("body")).not.toContainText(/content:(?:read|write)/u);
  await expect(page.locator("body")).not.toContainText(/Modern MCP|Compatibility MCP/u);
  await context.close();
});

test("Codex guide switches Desktop and CLI paths by keyboard and copies exact current inputs", async ({
  browser,
}) => {
  const fixture = fixtures.find((candidate) => candidate.count === 1);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/help/codex`);

  const desktop = page.getByRole("tab", { name: "Desktop" });
  const cli = page.getByRole("tab", { name: "CLI" });
  const desktopPanel = page.locator("#codex-client-desktop-panel");
  const cliPanel = page.locator("#codex-client-cli-panel");
  await expect(desktop).toHaveAttribute("aria-selected", "true");
  await expect(desktopPanel).toBeVisible();
  await expect(cliPanel).toBeHidden();
  await expect(page.getByText("Srez Marketplace").first()).toBeVisible();
  await expect(desktopPanel.getByText("Mind Diary UAT")).toBeVisible();
  await expect(page.getByText("Installed", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Copy Marketplace URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://github.com/xxsrez/marketplace",
  );

  await desktop.focus();
  await page.keyboard.press("ArrowRight");
  await expect(cli).toBeFocused();
  await expect(cli).toHaveAttribute("aria-selected", "true");
  await expect(desktopPanel).toBeHidden();
  await expect(cliPanel).toBeVisible();
  await expect(page.locator("#codex-help-cli-install")).toHaveText(
    "codex plugin marketplace add xxsrez/marketplace\n" +
      "codex plugin add mind-diary@srez-marketplace",
  );
  await expect(page.getByText("/new", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Copy CLI install commands" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "codex plugin marketplace add xxsrez/marketplace\n" +
      "codex plugin add mind-diary@srez-marketplace",
  );
  await page.getByRole("button", { name: "Copy read-only check" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Use Mind Diary to list the Minds I can read. Do not create or change any Memory.",
  );
  await expect(page.getByRole("link", { name: "Open the starter card" }))
    .toHaveAttribute("href", "/me#first-result-title");

  const accessibilityTree = await page.locator("main").ariaSnapshot();
  expect(accessibilityTree).toContain('tablist "Choose a Codex setup path"');
  expect(accessibilityTree).toContain('tab "Desktop"');
  expect(accessibilityTree).toContain('tab "CLI" [selected]');
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await context.close();
});

test("keyboard-only connection journey exposes progress, revoke, and reconnect states", async ({
  browser,
}) => {
  const fixture = fixtures.find((candidate) => candidate.count === 1);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/settings/connections`);
  await expect(page.locator("[data-connections-collection]"))
    .toHaveAttribute("data-collection-state", "ready");
  await expect(page.locator("[data-ia-codex-help-link]")).toHaveAttribute(
    "href",
    "/help/codex",
  );

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await tabUntil(page, 'a[href^="/settings/connections/conn_v1_"]');
  const openConnection = page.waitForURL(/\/settings\/connections\/conn_v1_/u);
  await page.keyboard.press("Enter");
  await openConnection;

  await tabUntil(page, '[data-access-action="clear_write"]');
  const accessReload = page.waitForNavigation({ waitUntil: "load" });
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-access-panel]")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status").filter({ hasText: "Saving current Mind access" })).toBeVisible();
  await accessReload;

  await tabUntil(page, "[data-revoke-connection]");
  const returnToConnections = page.waitForURL(`${fixture.origin}/settings/connections`);
  await page.keyboard.press("Enter");
  await returnToConnections;
  await expect(page.getByRole("heading", { level: 2, name: "No active connections" })).toBeVisible();
  await expect(page.locator("[data-ia-codex-help-link]")).toHaveAttribute(
    "href",
    "/help/codex",
  );

  const reconnect = await context.request.post(`${fixture.origin}/_fixture/reconnect`);
  expect(reconnect.status()).toBe(200);
  await page.reload();
  await expect(page.locator("[data-connections-page] .md-token-card")).toHaveCount(1);
  await expect(page.locator("[data-ia-codex-help-link]")).toHaveAttribute(
    "href",
    "/help/codex",
  );
  await context.close();
});

test("Advanced MCP owns the personal-token target, history, and revoke journey", async ({
  browser,
}) => {
  const fixture = fixtures.find((candidate) => candidate.count === 1);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/settings/developer/mcp?state=active`);

  const token = page.locator("[data-personal-token]").first();
  await expect(token.getByRole("heading", { name: "Readable access" })).toBeVisible();
  await expect(token.getByText("there is no read selector", { exact: false })).toBeVisible();
  await expect(token.getByRole("heading", { name: "Writable target" })).toBeVisible();
  await tabUntil(page, '[data-personal-token] [data-access-action="clear_write"]');
  const clearReload = page.waitForNavigation({ waitUntil: "load" });
  await page.keyboard.press("Enter");
  await clearReload;
  await expect(page.locator("[data-personal-token]").first()).toContainText("Not selected");
  await expect(page.locator("[data-personal-token]").first()).toContainText(
    "My Mind is never selected automatically.",
  );

  const selector = page.locator('[data-personal-token] select[name="mind_ref"]').first();
  await selector.selectOption("/me");
  await selector.focus();
  await page.keyboard.press("Tab");
  const selectReload = page.waitForNavigation({ waitUntil: "load" });
  await page.keyboard.press("Enter");
  await selectReload;
  await expect(page.locator("[data-personal-token]").first()).toContainText(
    "Personal notes with a deliberately long mobile label",
  );

  const revoke = page.locator("[data-personal-token]").first()
    .getByRole("button", { name: "Revoke token" });
  const revokeReload = page.waitForNavigation({ waitUntil: "load" });
  await revoke.click();
  await revokeReload;
  await expect(page.locator("[data-personal-token]")).toHaveCount(0);

  await page.goto(`${fixture.origin}/settings/developer/mcp?state=revoked`);
  await expect(page.locator("[data-personal-token]")).toHaveCount(1);
  await expect(page.locator("[data-personal-token]").first()).toContainText("revoked");
  await expect(page.locator("[data-access-panel]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Revoke token" })).toHaveCount(0);

  await page.goto(`${fixture.origin}/settings/developer/mcp?state=expired`);
  await expect(page.locator("[data-personal-token]")).toHaveCount(1);
  await expect(page.locator("[data-personal-token]").first()).toContainText("expired");
  await expect(page.locator("[data-access-panel]")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await context.close();
});

test("Advanced MCP dialog receives and restores focus without exposing raw identifiers", async ({
  browser,
}) => {
  const fixture = fixtures.find((candidate) => candidate.count === 1);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/settings/developer/mcp`);
  await tabUntil(page, "#token-name");
  await page.keyboard.type("Keyboard-created fixture token");
  await page.locator("#token-access").selectOption("content:write");
  await tabUntil(page, "[data-token-submit]");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Copy your token now" });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() =>
    document.activeElement?.closest("dialog")?.hasAttribute("data-secret-dialog") === true)).toBe(true);
  const snapshot = await dialog.ariaSnapshot();
  expect(snapshot).toContain('heading "Copy your token now"');
  await tabUntil(page, "dialog [data-close-secret]");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-secret-value]")).toHaveText("Secret is not available.");
  await expect(page.locator("[data-personal-token]").first()).toContainText(
    "Keyboard-created fixture token",
  );
  await expect(page.locator("[data-personal-token]").first()).toContainText("Not selected");
  await expect(page.locator("[data-personal-token]").first()).toContainText(
    "My Mind is never selected automatically.",
  );
  await expect(page.locator("body")).not.toContainText("[deterministic one-time fixture value]");
  await expect(page.locator("body")).not.toContainText(/(?:token|grant|binding)_[A-Za-z0-9._:-]{8,}/u);
  expect(page.url()).not.toMatch(/ptok_v1_|mdp_v1_|secret|token_id|binding_owner/u);
  await context.close();
});

test("deterministic error fixtures keep actions unavailable on both credential surfaces", async ({
  browser,
}) => {
  const fixture = fixtures.find((candidate) => candidate.count === 1);
  const context = await browser.newContext();
  await context.addCookies([{
    name: "fixture_view",
    value: "error",
    domain: "127.0.0.1",
    path: "/",
  }]);
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/settings/connections`);
  await expect(page.getByRole("alert")).toContainText("Connections are unavailable");
  await expect(page.getByRole("link", { name: "Manage access" })).toHaveCount(0);
  await page.goto(`${fixture.origin}/settings/developer/mcp`);
  await expect(page.getByRole("alert")).toContainText("Personal tokens are unavailable");
  await expect(page.locator("[data-personal-token]")).toHaveCount(0);
  await context.close();
});
