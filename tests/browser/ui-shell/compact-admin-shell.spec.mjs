import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const fixtureServer = resolve(import.meta.dirname, "fixture-server.mjs");
const contract = JSON.parse(await readFile(
  resolve(root, "tests/fixtures/compact-admin-ia/contract.v1.json"),
  "utf8",
));
let fixture;
let origin;

function acceptance(id, title, body) {
  test(`[${id}] ${title}`, {
    annotation: { type: "mind-diary-assertion", description: id },
  }, body);
}

async function acceptanceStep({ route, viewport, assertion }, body) {
  const viewportLabel = viewport === undefined
    ? "current"
    : `${viewport.width}x${viewport.height}`;
  await test.step(
    `route=${route} viewport=${viewportLabel} assertion=${assertion}`,
    body,
  );
}

async function waitForFixture(child) {
  let output = "";
  const started = new Promise((resolveStarted, rejectStarted) => {
    const timeout = setTimeout(
      () => rejectStarted(new Error(`compact shell fixture start timed out: ${output.slice(0, 500)}`)),
      10_000,
    );
    const inspect = (chunk) => {
      output += chunk.toString("utf8");
      const match = /Mind Diary UI fixture: (http:\/\/127\.0\.0\.1:\d+)\/minds/u.exec(output);
      if (match === null) return;
      clearTimeout(timeout);
      resolveStarted(match[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectStarted(new Error(`compact shell fixture exited early (${code}): ${output.slice(0, 500)}`));
    });
  });
  const fixtureOrigin = await started;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("compact shell fixture exited before health check");
    try {
      if ((await fetch(`${fixtureOrigin}/_fixture/health`, { cache: "no-store" })).ok) {
        return fixtureOrigin;
      }
    } catch {
      // The loopback listener may have printed its address just before accepting requests.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`compact shell fixture health check timed out: ${output.slice(0, 500)}`);
}

async function stopFixture(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((_, rejectExit) => setTimeout(
      () => rejectExit(new Error("compact shell fixture did not terminate")),
      5_000,
    )),
  ]);
}

async function visibleMetrics(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      display: style.display,
      visibility: style.visibility,
    };
  });
}

async function geometry(page) {
  return page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    mainWidth: document.querySelector("[data-ia-main]")?.getBoundingClientRect().width ?? 0,
    regions: [...document.querySelectorAll([
      "main",
      "[data-ia-rail]",
      "[data-ia-mobile-drawer]",
      "[data-ia-collection]",
      "[data-ia-row]",
      "[data-ia-route-state]",
      "[data-ia-disclosure]",
      "dialog[open]",
    ].join(", "))]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => ({
        role: element.getAttribute("data-ia-route-state") ??
          (element.hasAttribute("data-ia-row") ? "row" : element.tagName.toLowerCase()),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      })),
  }));
}

async function expectBounded(page, label) {
  const result = await geometry(page);
  expect(result.documentWidth, `${label}: ${JSON.stringify(result)}`)
    .toBeLessThanOrEqual(result.viewport + contract.geometry.pageOverflowTolerancePx);
  expect(result.bodyWidth, `${label}: ${JSON.stringify(result)}`)
    .toBeLessThanOrEqual(result.viewport + contract.geometry.pageOverflowTolerancePx);
  expect(
    result.regions.filter((region) =>
      region.scrollWidth > region.clientWidth + contract.geometry.pageOverflowTolerancePx),
    `${label}: ${JSON.stringify(result)}`,
  ).toEqual([]);
  expect(result.mainWidth, `${label}: main exceeds accepted content width`)
    .toBeLessThanOrEqual(contract.geometry.contentMaxWidthPx);
}

async function expectMinimumTarget(locator, label) {
  const box = await locator.boundingBox();
  expect(box, `${label}: target has no geometry`).not.toBeNull();
  expect(box.width, `${label}: target width`).toBeGreaterThanOrEqual(
    contract.geometry.minimumHitTargetPx,
  );
  expect(box.height, `${label}: target height`).toBeGreaterThanOrEqual(
    contract.geometry.minimumHitTargetPx,
  );
}

async function expectVisibleFocus(locator, label) {
  await expect(locator, `${label}: expected focus`).toBeFocused();
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineOffset: Number.parseFloat(style.outlineOffset),
    };
  });
  expect(focus.outlineStyle, `${label}: ${JSON.stringify(focus)}`).not.toBe("none");
  expect(focus.outlineWidth, `${label}: ${JSON.stringify(focus)}`).toBeGreaterThanOrEqual(3);
}

async function expectHeadingOrder(page, label) {
  const levels = await page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((headings) =>
    headings
      .filter((heading) => {
        const rect = heading.getBoundingClientRect();
        const style = getComputedStyle(heading);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
      })
      .map((heading) => Number(heading.tagName.slice(1))));
  expect(levels[0], `${label}: first heading`).toBe(1);
  expect(levels.filter((level) => level === 1), `${label}: one h1`).toHaveLength(1);
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index], `${label}: heading level skip ${levels.join(",")}`)
      .toBeLessThanOrEqual(levels[index - 1] + 1);
  }
}

test.beforeAll(async () => {
  fixture = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: { ...process.env, MIND_DIARY_UI_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await waitForFixture(fixture);
});

test.afterAll(async () => {
  await stopFixture(fixture);
});

acceptance("IA-SESSION-01", "signed-out routes share one data-free entry shell", async ({ page }) => {
  let baseline;
  for (const route of ["/", "/minds", "/fixture-private", "/settings/mcp"]) {
    await acceptanceStep({ route, assertion: "route-agnostic signed-out shell" }, async () => {
      await page.goto(`${origin}${route}?session=signed_out`);
      await expect(page.locator('[data-session-state="anonymous"]')).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Sign in with ChatGPT" })).toHaveAttribute(
        "href",
        "/signin-with-chatgpt",
      );
      await expect(page.locator("[data-ia-uat-marker]")).toBeVisible();
      await expect(page.locator("[data-ia-shell], [data-ia-nav], [data-ia-rail]")).toHaveCount(0);
      await expect(page.locator('meta[name="mind-diary-csrf-token"]')).toHaveCount(0);
      const body = await page.locator("body").innerHTML();
      expect(body).not.toContain("fixture-private");
      if (baseline === undefined) baseline = body;
      else expect(body, `signed-out DOM drift on ${route}`).toBe(baseline);
    });
  }
});

acceptance("IA-SESSION-02", "registration lifecycle remains isolated and retry-safe", async ({ page }) => {
  const rows = [
    ["registration_required", "registration_required", false, "Create isolated account"],
    ["bootstrapping", "bootstrapping", true, null],
    ["bootstrap_error", "bootstrap_error", false, "Try setup again"],
  ];
  for (const [session, expectedState, busy, action] of rows) {
    const viewport = { width: 320, height: 568 };
    await page.setViewportSize(viewport);
    await acceptanceStep({ route: "/", viewport, assertion: expectedState }, async () => {
      await page.goto(`${origin}/?session=${session}`);
      await expect(page.locator(`[data-session-state="${expectedState}"]`)).toBeVisible();
      await expect(page.locator("[data-ia-shell], [data-ia-nav]")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator("[aria-busy=true]")).toHaveCount(busy ? 1 : 0);
      if (action === null) {
        await expect(page.getByRole("button")).toHaveCount(0);
      } else {
        await expect(page.getByRole("button", { name: action })).toBeVisible();
      }
      if (session === "bootstrap_error") {
        await expect(page.getByRole("button", { name: action }))
          .toHaveAttribute("data-bootstrap-key", "bootstrap-fixture-0001");
      }
      await expectBounded(page, `registration ${session}`);
    });
  }
});

acceptance("IA-NAV-01", "wide route map keeps Personal first and Settings pinned", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
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
  for (const [route, nav, current, contextCurrent] of routes) {
    await acceptanceStep({ route, viewport: { width: 1440, height: 900 }, assertion: "current route" }, async () => {
      await page.goto(`${origin}${route}`);
      if (current === null) {
        await expect(page.locator("[data-ia-rail] [aria-current=page]")).toHaveCount(0);
      } else {
        await expect(page.locator(`[data-ia-nav="${nav}"]`).getByRole("link", {
          name: current,
          exact: true,
        })).toHaveAttribute("aria-current", "page");
      }
      if (contextCurrent === null) {
        await expect(page.locator('[data-ia-nav="settings"]')).toHaveCount(0);
      } else {
        await expect(page.getByRole("navigation", { name: "Settings sections" }))
          .toBeVisible();
        await expect(page.locator('[data-ia-nav="settings"]')
          .getByRole("link", { name: contextCurrent, exact: true }))
          .toHaveAttribute("aria-current", "page");
      }
      expect(await page.locator('[data-ia-nav="primary"] a').evaluateAll((links) =>
        links.map((link) => link.getAttribute("href"))))
        .toEqual(["/me", "/minds", "/public", "/invitations"]);
      expect(await page.locator('[data-ia-nav="utility"] a').evaluateAll((links) =>
        links.map((link) => link.getAttribute("href"))))
        .toEqual(["/help/codex", "/settings/account"]);
      expect(await page.locator('[data-ia-nav="utility"] a').evaluateAll((links) =>
        links.map((link) => link.getAttribute("data-ia-nav-item"))))
        .toEqual(["help", "settings"]);
      if (contextCurrent !== null) {
        expect(await page.locator("[data-ia-settings-section]").evaluateAll((links) =>
          links.map((link) => link.getAttribute("data-ia-settings-section"))))
          .toEqual(["account", "connections", "advanced-mcp"]);
      }
      const setting = await page.locator("[data-ia-settings-item]").boundingBox();
      expect(setting.y + setting.height, `${route}: Settings is not pinned in viewport`)
        .toBeLessThanOrEqual(892);
      await expectBounded(page, `wide route ${route}`);
    });
  }

  const noScript = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled: false,
  });
  const noScriptPage = await noScript.newPage();
  await acceptanceStep({
    route: "/minds -> /me",
    viewport: { width: 1440, height: 900 },
    assertion: "JavaScript-off navigation",
  }, async () => {
    await noScriptPage.goto(`${origin}/minds`);
    await expect(noScriptPage.locator("[data-ia-rail]")).toBeVisible();
    await expect(noScriptPage.locator("[data-ia-rail]")).not.toHaveAttribute("inert", "");
    await expect(noScriptPage.locator("[data-ia-rail]")).not.toHaveAttribute("aria-hidden", "true");
    await expect(noScriptPage.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const personalLink = noScriptPage.getByRole("link", { name: "My Mind", exact: true });
    await personalLink.focus();
    await expect(personalLink).toBeFocused();
    await personalLink.click();
    await expect(noScriptPage).toHaveURL(`${origin}/me`);
    await expect(noScriptPage.getByRole("heading", { level: 1, name: "My Mind" })).toBeVisible();
  });
  await noScript.close();
  await context.close();
});

acceptance("IA-NAV-02", "compact drawer traps focus and returns it on Escape", async ({ page }) => {
  const viewport = { width: 390, height: 844 };
  await acceptanceStep({
    route: "/settings/connections",
    viewport,
    assertion: "keyboard focus trap and Escape return",
  }, async () => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/settings/connections`);
    const trigger = page.locator("[data-ia-mobile-trigger]");
    const drawer = page.locator("[data-ia-mobile-drawer]");
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-ia-skip-link]")).toBeFocused();
    await expect(drawer).toHaveAttribute("inert", "");
    await expect(drawer.getByRole("link")).toHaveCount(0);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
    expect(await page.locator('[data-ia-nav="utility"] a').evaluateAll((links) =>
      links.map((link) => link.getAttribute("data-ia-nav-item"))))
      .toEqual(["help", "settings"]);
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("[data-ia-settings-item]")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
    await expect(page.locator("[data-ia-page-header]")).toBeAttached();
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().width)).toBe(320);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(drawer).toHaveAttribute("inert", "");
    await expectBounded(page, "compact drawer focus return");
  });
});

acceptance("IA-NAV-03", "Settings context survives direct navigation and browser Back", async ({ page }) => {
  const viewport = { width: 1024, height: 768 };
  await acceptanceStep({
    route: "/minds -> /settings/developer/mcp -> Back",
    viewport,
    assertion: "direct and history current state",
  }, async () => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/minds`);
    await page.goto(`${origin}/settings/developer/mcp`);
    await expect(page.locator("[data-ia-settings-item]")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Advanced MCP" }))
      .toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/minds`);
    await expect(page.getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Minds", exact: true }))
      .toHaveAttribute("aria-current", "page");
  });
  await acceptanceStep({ route: "/help", viewport, assertion: "neutral current state" }, async () => {
    await page.goto(`${origin}/help`);
    await expect(page.locator("[data-ia-rail] [aria-current=page]")).toHaveCount(0);
  });
  await acceptanceStep({
    route: "/settings/account -> /settings/connections -> Back -> /help/codex",
    viewport,
    assertion: "click navigation, history, and no onboarding state",
  }, async () => {
    await page.goto(`${origin}/minds`);
    await page.locator("[data-ia-settings-item]").click();
    await expect(page).toHaveURL(`${origin}/settings/account`);
    await expect(page.locator('[data-ia-settings-section="account"]'))
      .toHaveAttribute("aria-current", "page");
    await page.locator('[data-ia-settings-section="connections"]').click();
    await expect(page).toHaveURL(`${origin}/settings/connections`);
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/settings/account`);
    await page.goto(`${origin}/help/codex`);
    await expect(page.locator("[data-ia-codex-help-link]")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator('[data-ia-nav="settings"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/setup complete|checklist progress/i);
  });
});

acceptance("IA-GEOMETRY-01", "all accepted viewports and major regions stay within overflow budget", async ({ browser }) => {
  for (const viewport of contract.viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    for (const route of [
      "/minds",
      "/minds?state=loading",
      "/minds?state=empty",
      "/minds?state=error",
      "/settings/connections?state=forbidden",
    ]) {
      await acceptanceStep({ route, viewport, assertion: "overflow <= 1px" }, async () => {
        await page.goto(`${origin}${route}`);
        await expectBounded(page, `${route} ${viewport.width}x${viewport.height}`);
      });
    }
    await context.close();
  }
});

acceptance("IA-GEOMETRY-02", "rail drawer content and controls match measurable geometry", async ({ browser }) => {
  for (const viewport of contract.viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await acceptanceStep({
      route: "/minds",
      viewport,
      assertion: "rail drawer and minimum hit targets",
    }, async () => {
      await page.goto(`${origin}/minds`);
      if (viewport.width >= contract.breakpoints.wide.minWidthPx) {
        const rail = await visibleMetrics(page.locator("[data-ia-rail]"));
        expect(rail.width, `${viewport.width}: rail width`).toBe(contract.geometry.railWidthPx);
        await expectMinimumTarget(page.locator('[data-ia-nav-item="my-mind"]'), "wide My Mind");
        await expectMinimumTarget(page.locator("[data-ia-settings-item]"), "wide Settings");
      } else {
        const trigger = page.locator("[data-ia-mobile-trigger]");
        await expectMinimumTarget(trigger, "compact menu trigger");
        await trigger.click();
        const drawer = await visibleMetrics(page.locator("[data-ia-mobile-drawer]"));
        expect(drawer.width, `${viewport.width}: drawer width`).toBeCloseTo(
          Math.min(contract.geometry.drawerMaxWidthPx,
            viewport.width * contract.geometry.drawerViewportWidthRatio),
          1,
        );
        await expectMinimumTarget(page.locator('[data-ia-nav-item="my-mind"]'), "drawer My Mind");
        await page.keyboard.press("Escape");
      }
      await expectMinimumTarget(page.locator("[data-ia-primary-action]"), "primary action");
    });
    await context.close();
  }
});

acceptance("IA-DENSITY-01", "collection rows preserve density and reading order", async ({ browser }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await acceptanceStep({
      route: "/minds",
      viewport,
      assertion: "row density and DOM reading order",
    }, async () => {
      await page.goto(`${origin}/minds`);
      const rows = page.locator("[data-ia-row]");
      await expect(rows).toHaveCount(2);
      const heights = await rows.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height));
      if (viewport.width >= contract.breakpoints.wide.minWidthPx) {
        for (const height of heights) {
          expect(height).toBeGreaterThanOrEqual(contract.geometry.wideRowMinHeightPx);
          expect(height).toBeLessThanOrEqual(contract.geometry.wideRowMaxHeightPx);
        }
      } else {
        for (const height of heights) {
          expect(height).toBeGreaterThanOrEqual(contract.geometry.compactRowMinHeightPx);
        }
      }
      const order = await rows.first().evaluate((row) => [...row.children].map((child) => {
        if (child.matches("h3")) return "label";
        if (child.matches(".md-card__topline")) return "status";
        if (child.matches(".md-card__description")) return "metadata";
        if (child.matches(".md-card__metadata")) return "actions";
        return "other";
      }));
      expect(order).toEqual(["label", "status", "metadata", "actions"]);
    });
    await context.close();
  }
});

acceptance("IA-FIRST-01", "first viewport keeps the contracted shell and key route content visible", async ({ browser }) => {
  for (const viewport of contract.viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await acceptanceStep({
      route: "/minds",
      viewport,
      assertion: "MD-345 first-viewport density",
    }, async () => {
      await page.goto(`${origin}/minds`);
      for (const selector of viewport.requiredFirstVisibleSelectors) {
        const locator = page.locator(`${selector}:visible`).first();
        await expect(locator, `${viewport.id}: ${selector}`).toBeVisible();
        const metrics = await visibleMetrics(locator);
        expect(metrics.top, `${viewport.id}: ${selector} starts below viewport`)
          .toBeLessThan(viewport.height);
      }
      const complete = [];
      for (const selector of viewport.completeOneOfSelectors) {
        const locator = page.locator(`${selector}:visible`).first();
        if (await locator.count() === 0) continue;
        const metrics = await visibleMetrics(locator);
        if (metrics.bottom <= viewport.height) complete.push(selector);
      }
      expect(complete, `${viewport.id}: no required complete region in first viewport`)
        .not.toHaveLength(0);
      const firstRow = page.locator("[data-ia-row]:visible").first();
      if (viewport.firstRowStartsInViewport) {
        expect((await visibleMetrics(firstRow)).top, `${viewport.id}: first row start`)
          .toBeLessThan(viewport.height);
      }
      if (viewport.minimumCompleteRowsWhenReady > 0) {
        const completeRows = await page.locator("[data-ia-row]:visible").evaluateAll(
          (rows, height) => rows.filter((row) => row.getBoundingClientRect().bottom <= height).length,
          viewport.height,
        );
        expect(completeRows, `${viewport.id}: complete rows`)
          .toBeGreaterThanOrEqual(viewport.minimumCompleteRowsWhenReady);
      }
    });
    await context.close();
  }
});

acceptance("IA-A11Y-01", "landmarks keyboard order visible focus and dialog lifecycle are complete", async ({ page }) => {
  const viewport = { width: 1440, height: 900 };
  await acceptanceStep({
    route: "/minds",
    viewport,
    assertion: "landmarks headings tab order visible focus and dialog return",
  }, async () => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/minds`);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Utility" })).toHaveCount(1);
    await expectHeadingOrder(page, "Minds page");
    const snapshot = await page.locator("[data-ia-shell]").ariaSnapshot();
    expect(snapshot).toContain('navigation "Primary"');
    expect(snapshot).toContain('link "My Mind"');
    expect(snapshot).toContain('link "Settings"');
    expect(snapshot).toContain('heading "Minds" [level=1]');

    await page.keyboard.press("Tab");
    const skip = page.locator("[data-ia-skip-link]");
    await expectVisibleFocus(skip, "skip link");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-ia-main]")).toBeFocused();

    await page.goto(`${origin}/minds`);
    const expectedHrefs = ["#main-content", "/", "/me", "/minds", "/public", "/invitations", "/help/codex", "/settings/account"];
    for (const href of expectedHrefs) {
      await page.keyboard.press("Tab");
      expect(await page.locator(":focus").getAttribute("href"), `wide focus order at ${href}`)
        .toBe(href);
    }

    const invoker = page.locator("[data-ia-primary-action]");
    await invoker.click();
    const dialog = page.getByRole("dialog", { name: "Create a Mind" });
    await expect(dialog).toBeVisible();
    await expect(page.locator("#mind-name")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(invoker).toBeFocused();
    await expectVisibleFocus(invoker, "dialog invoker focus return");
  });
});

acceptance("IA-A11Y-02", "forced colors and reduced motion preserve current state focus and controls", async ({ browser }) => {
  const viewport = { width: 390, height: 844 };
  const context = await browser.newContext({
    viewport,
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await acceptanceStep({
    route: "/settings/developer/mcp",
    viewport,
    assertion: "forced colors and reduced motion",
  }, async () => {
    await page.goto(`${origin}/settings/developer/mcp`);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches))
      .toBe(true);
    const trigger = page.locator("[data-ia-mobile-trigger]");
    await trigger.focus();
    await expectVisibleFocus(trigger, "forced-colors menu focus");
    await trigger.click();
    await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
    await expect(page.locator("[data-ia-settings-item]")).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-ia-nav="settings"] a[aria-current="page"]'))
      .toHaveText("Advanced MCP");
    const transitionMs = await page.locator("[data-ia-mobile-drawer]").evaluate((element) =>
      getComputedStyle(element).transitionDuration.split(",").map((duration) =>
        duration.trim().endsWith("ms")
          ? Number.parseFloat(duration)
          : Number.parseFloat(duration) * 1000));
    expect(Math.max(...transitionMs)).toBeLessThanOrEqual(0.01);
    await expectBounded(page, "forced colors and reduced motion");
  });
  await context.close();
});

acceptance("IA-STATE-01", "loading empty forbidden not-found conflict and server-error remain bounded and causal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rows = [
    ["/minds?state=loading", 200, "loading", "status"],
    ["/minds?state=empty", 200, "empty", null],
    ["/minds?state=error", 200, "error", "alert"],
    ["/settings/connections?state=forbidden", 403, "forbidden", "alert"],
    ["/fixture-missing?state=not-found", 404, "error", "alert"],
    ["/settings/connections?state=conflict", 409, "error", "alert"],
    ["/settings/connections?state=server-error", 500, "error", "alert"],
  ];
  for (const [route, status, state, liveRole] of rows) {
    await acceptanceStep({ route, viewport: { width: 390, height: 844 }, assertion: state }, async () => {
      const response = await page.goto(`${origin}${route}`);
      expect(response.status(), `${route}: HTTP status`).toBe(status);
      await expect(page.locator("[data-ia-shell]")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      const region = page.locator(`[data-ia-route-state="${state}"]`);
      await expect(region).toBeVisible();
      if (liveRole === "alert") await expect(region).toHaveAttribute("role", "alert");
      if (liveRole === "status") await expect(region.getByRole("status")).toHaveCount(1);
      await expectBounded(page, `route state ${route}`);
    });
  }
});

acceptance("IA-PERSONAL-01", "Personal Mind keeps its adjacent private-only boundary", async ({ page }) => {
  const viewport = { width: 390, height: 844 };
  await acceptanceStep({
    route: "/me",
    viewport,
    assertion: "adjacent private-only disclosure and absent controls",
  }, async () => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/me`);
    await expect(page.getByRole("heading", { level: 1, name: "My Mind" })).toBeVisible();
    const disclosure = page.locator('[data-ia-disclosure="personal-mind"]');
    await expect(disclosure).toContainText("Private — only you");
    await expect(disclosure)
      .toContainText("cannot be shared, published, transferred, or deleted separately");
    await expect(page.getByRole("button", { name: /share|publish|transfer|delete mind/iu }))
      .toHaveCount(0);
    const headingBottom = (await visibleMetrics(page.locator("[data-ia-page-header]"))).bottom;
    const disclosureTop = (await visibleMetrics(disclosure)).top;
    expect(disclosureTop).toBeGreaterThanOrEqual(headingBottom);
    await expectBounded(page, "Personal Mind private boundary");
  });
});

acceptance("IA-PRIVACY-01", "malicious labels are inert and raw internal IDs stay out of DOM", async ({ page }) => {
  const viewport = { width: 1440, height: 900 };
  await acceptanceStep({
    route: "/minds",
    viewport,
    assertion: "escaped labels and no raw internal IDs",
  }, async () => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/minds`);
    expect(await page.evaluate(() => globalThis.__mindDiaryInjected === true)).toBe(false);
    const collection = await page.locator("[data-ia-collection]").innerHTML();
    expect(collection).not.toMatch(/<(?:img|svg|script)\b[^>]*(?:onerror|onload)/iu);
    expect(collection).not.toContain("mind_fixture_personal");
    expect(collection).not.toContain("mind_fixture_public");
    await expect(page.locator("[data-mind-card]")).toHaveCount(0);
  });
  await acceptanceStep({
    route: "/fixture-private?session=signed_out",
    viewport,
    assertion: "signed-out route secrecy",
  }, async () => {
    await page.goto(`${origin}/fixture-private?session=signed_out`);
    const signedOut = await page.locator("body").innerHTML();
    expect(signedOut).not.toContain("fixture-private");
    expect(signedOut).not.toMatch(/csrf|principal_|space_|revision_|mdp_v1_/iu);
  });
});
