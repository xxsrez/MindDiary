import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const fixtureServer = resolve(import.meta.dirname, "fixture-server.mjs");
const port = 4320;
const origin = `http://127.0.0.1:${port}`;
let fixture;

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) throw new Error("compact shell fixture exited early");
    try {
      if ((await fetch(`${origin}/_fixture/health`)).ok) return;
    } catch {
      // The deterministic listener may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("compact shell fixture health check timed out");
}

async function geometry(page) {
  return page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    regions: [...document.querySelectorAll(
      "main, [data-ia-rail], [data-ia-collection], [data-ia-row], [data-ia-route-state]",
    )]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => ({
        selector: element.getAttribute("data-ia-row") !== null
          ? "row"
          : element.tagName.toLowerCase(),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      })),
  }));
}

async function expectBounded(page) {
  const result = await geometry(page);
  expect(result.documentWidth, JSON.stringify(result)).toBeLessThanOrEqual(result.viewport + 1);
  expect(result.bodyWidth, JSON.stringify(result)).toBeLessThanOrEqual(result.viewport + 1);
  expect(
    result.regions.filter((region) => region.scrollWidth > region.clientWidth + 1),
    JSON.stringify(result),
  ).toEqual([]);
}

test.beforeAll(async () => {
  fixture = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: { ...process.env, MIND_DIARY_UI_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFixture();
});

test.afterAll(async () => {
  if (fixture.exitCode !== null) return;
  fixture.kill("SIGTERM");
  await new Promise((resolveExit) => fixture.once("exit", resolveExit));
});

test("server-resolved route map keeps one compact hierarchy and exact current states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const routes = [
    ["/me", "primary", "My Mind", null],
    ["/minds", "primary", "Minds", null],
    ["/public", "primary", "Public Minds", null],
    ["/invitations", "primary", "Invitations", null],
    ["/help/codex", "utility", "Help with Codex", null],
    ["/help", null, null, null],
    ["/settings/account", "utility", "Settings", "Account"],
    ["/settings/connections", "utility", "Settings", "Connections"],
    ["/settings/connections/conn_v1_fixture", "utility", "Settings", "Connections"],
    ["/settings/developer/mcp", "utility", "Settings", "Advanced MCP"],
    ["/shared-research", "primary", "Minds", null],
  ];
  for (const [path, nav, current, context] of routes) {
    await page.goto(`${origin}${path}`);
    if (current === null) {
      await expect(page.locator("[data-ia-rail] [aria-current=page]")).toHaveCount(0);
    } else {
      await expect(page.locator(`[data-ia-nav="${nav}"]`).getByRole("link", {
        name: current,
        exact: true,
      }))
        .toHaveAttribute("aria-current", "page");
    }
    if (context === null) {
      await expect(page.locator('[data-ia-nav="settings"]')).toHaveCount(0);
    } else {
      await expect(page.getByRole("navigation", { name: "Settings sections" }))
        .toBeVisible();
      await expect(page.locator('[data-ia-nav="settings"]')
        .getByRole("link", { name: context, exact: true }))
        .toHaveAttribute("aria-current", "page");
    }
    await expect(page.locator('[data-ia-nav="primary"] a').nth(0))
      .toHaveAttribute("href", "/me");
    await expect(page.locator("[data-ia-settings-item]")).toHaveAttribute(
      "href",
      "/settings/account",
    );
    await expectBounded(page);
  }
});

test("wide rail remains accessible and navigable when client JavaScript is unavailable", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  await page.goto(`${origin}/minds`);
  const rail = page.locator("[data-ia-rail]");
  await expect(rail).toBeVisible();
  await expect(rail).not.toHaveAttribute("inert", "");
  await expect(rail).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.locator('[data-ia-nav-item="my-mind"]').focus();
  await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
  await page.locator('[data-ia-nav-item="my-mind"]').click();
  await expect(page).toHaveURL(`${origin}/me`);
  await expect(page.getByRole("heading", { level: 1, name: "My Mind" })).toBeVisible();
  await context.close();
});

test("accepted viewports keep the rail, first action or row, and document inside budget", async ({
  browser,
}) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${origin}/minds`);
    await expect(page.locator("[data-ia-page-header]")).toBeVisible();
    await expect(page.locator("[data-ia-primary-action]")).toBeVisible();
    await expect(page.locator("[data-ia-row]").first()).toBeVisible();
    await expectBounded(page);
    const firstViewport = await page.evaluate(() => ({
      headerBottom: document.querySelector("[data-ia-page-header]")?.getBoundingClientRect().bottom,
      actionBottom: document.querySelector("[data-ia-primary-action]")?.getBoundingClientRect().bottom,
      rowTop: document.querySelector("[data-ia-row]")?.getBoundingClientRect().top,
      height: window.innerHeight,
    }));
    expect(firstViewport.headerBottom).toBeLessThanOrEqual(firstViewport.height);
    expect(firstViewport.actionBottom).toBeLessThanOrEqual(firstViewport.height);
    expect(firstViewport.rowTop).toBeLessThan(firstViewport.height);
    if (viewport.width >= 1024) {
      await expect(page.locator("[data-ia-rail]")).toBeVisible();
      expect(await page.locator("[data-ia-rail]").evaluate((node) => node.getBoundingClientRect().width))
        .toBe(240);
      for (const height of await page.locator("[data-ia-row]")
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))) {
        expect(height).toBeGreaterThanOrEqual(44);
        expect(height).toBeLessThanOrEqual(56);
      }
      const setting = await page.locator("[data-ia-settings-item]").boundingBox();
      expect(setting?.y + setting?.height).toBeLessThanOrEqual(viewport.height - 8);
    } else {
      await expect(page.locator("[data-ia-mobile-trigger]")).toBeVisible();
      await expect(page.locator("[data-ia-mobile-drawer]")).toHaveAttribute("inert", "");
    }
    await context.close();
  }
});

test("compact drawer traps focus, closes safely, and preserves the visible page heading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/settings/connections`);
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-ia-skip-link]")).toBeFocused();
  await page.locator("[data-ia-mobile-trigger]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-ia-mobile-trigger]")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
  await expect(page.locator("[data-ia-page-header]")).toBeAttached();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("[data-ia-settings-item]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
  const drawerWidth = await page.locator("[data-ia-mobile-drawer]")
    .evaluate((node) => node.getBoundingClientRect().width);
  expect(drawerWidth).toBe(320);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-ia-mobile-trigger]")).toBeFocused();
  await expect(page.locator("[data-ia-mobile-trigger]")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-ia-mobile-drawer]")).toHaveAttribute("inert", "");
  await expectBounded(page);
});

test("forced colors and reduced motion retain current, focus, and controls", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${origin}/settings/developer/mcp`);
  await expect(page.locator("[data-ia-mobile-trigger]")).toBeVisible();
  await page.locator("[data-ia-mobile-trigger]").click();
  await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
  await expect(page.locator("[data-ia-settings-item]")).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-ia-nav="settings"] a[aria-current="page"]')).toHaveText(
    "Advanced MCP",
  );
  await expectBounded(page);
  await context.close();
});
