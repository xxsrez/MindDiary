import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const fixtureServer = resolve(
  import.meta.dirname,
  "ui-shell/product-control-fixture-server.mjs",
);
const port = 4313;
const origin = `http://127.0.0.1:${port}`;
let fixture;

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) throw new Error("product fixture exited early");
    try {
      if ((await fetch(`${origin}/_fixture/health`)).ok) return;
    } catch {
      // The deterministic listener may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("product fixture health check timed out");
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

test("heavy navigation pages render their shell before deferred collection reads finish", async ({
  page,
}) => {
  await page.goto(origin);
  await page.locator("[data-isolated-account-form]").evaluate((form) => form.requestSubmit());
  await page.waitForURL("**/me");

  await page.route("**/api/v1/minds", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.continue();
  });
  await page.goto(`${origin}/minds`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Loading your Minds" })).toBeVisible();
  await expect(page.locator("[data-minds-collection]")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("[data-minds-list] [data-mind-card]").first()).toHaveAttribute(
    "data-mind-card",
    "me",
  );
  await expect(page.locator("[data-personal-mind]")).toContainText("Private, always");

  await page.unroute("**/api/v1/minds");
  await page.route("**/api/v1/minds", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.continue();
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Opening your Minds" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Minds", exact: true })).toBeVisible();

  await page.route("**/api/v1/public-minds*", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.continue();
  });
  await page.goto(`${origin}/public`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Opening Public Minds" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browser Public One" })).toBeVisible();
  await expect(page.getByText("First bounded Public Minds page.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Browser Public Two" })).toHaveCount(0);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("link", { name: "Browser Public Two" })).toBeVisible();
  await expect(page.getByText("Second bounded Public Minds page.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  await page.getByRole("link", { name: "Browser Public One" }).click();
  await expect(page).toHaveURL(`${origin}/browser-public-one`);
  await expect(page.getByRole("heading", { level: 1, name: "Browser Public One", exact: true })).toBeVisible();
  await expect(page.locator("[data-visibility-readonly]")).toContainText("baseline access is read-only");
  await expect(page.locator("[data-owner-visibility-controls]")).toHaveCount(0);
  await expect(page.locator("[data-member-role-form], [data-owner-transfer-controls]")).toHaveCount(0);

  await page.route("**/api/v1/invitations-overview", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.continue();
  });
  await page.goto(`${origin}/invitations`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Loading participants and invitations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incoming invitations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sent invitations" })).toBeVisible();

  await page.route("**/api/v1/account/deletion-impact", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.continue();
  });
  await page.goto(`${origin}/settings/account`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Loading the exact deletion preview" })).toBeVisible();
  await expect(page.locator("[data-account-deletion-impact]")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review the deletion cascade" })).toBeVisible();

  await page.route("**/api/v1/connections", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.continue();
  });
  await page.goto(`${origin}/settings/connections`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Loading connections" })).toBeVisible();
  await expect(page.locator("[data-connections-collection]")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("heading", { name: "No active connections" })).toBeVisible();
});

test("Public Minds stops repeated cursors and deduplicates immutable Mind IDs across routes", async ({
  page,
}) => {
  await page.goto(origin);
  const registration = page.locator("[data-isolated-account-form]");
  if (await registration.count() > 0) {
    await registration.evaluate((form) => form.requestSubmit());
    await page.waitForURL("**/me");
  }
  const repeatedCursor = "mdc1_eyJ2IjoxLCJxIjoicHVibGljX21pbmRzIiwiZyI6OSwibyI6MjR9";
  let catalogRequests = 0;
  await page.route("**/api/v1/public-minds*", async (route) => {
    catalogRequests += 1;
    const changedRoute = catalogRequests > 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          minds: [{
            mind_id: "space_browser_repeated",
            route: changedRoute ? "/browser-public-renamed" : "/browser-public-stable",
            name: changedRoute ? "Browser Public Renamed" : "Browser Public Stable",
            description: changedRoute ? "Changed route page." : "Stable first page.",
            summary: changedRoute ? "Changed route page." : "Stable first page.",
            visibility: "public",
            is_personal: false,
            discovery: "public_catalog",
          }],
        },
        next_cursor: repeatedCursor,
      }),
    });
  });

  await page.goto(`${origin}/public`);
  await expect(page.getByRole("link", { name: "Browser Public Stable" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();

  await expect(page.locator('[data-public-mind-card="space_browser_repeated"]')).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Browser Public Stable" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Browser Public Renamed" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(catalogRequests).toBe(2);
});
