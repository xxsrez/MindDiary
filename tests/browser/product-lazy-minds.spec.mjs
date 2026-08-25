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

test("Minds navigation renders its shell before the deferred collection read finishes", async ({
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
  await expect(page.getByRole("heading", { name: "No shared Minds yet" })).toBeVisible();
});
