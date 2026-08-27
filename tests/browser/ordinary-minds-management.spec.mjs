import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const fixtureServer = resolve(
  import.meta.dirname,
  "ordinary-minds-management/fixture-server.mjs",
);
const port = 4384;
const origin = `http://127.0.0.1:${port}`;
let fixture;

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) throw new Error("ordinary Minds fixture exited early");
    try {
      if ((await fetch(`${origin}/_fixture/health`)).ok) return;
    } catch {
      // The deterministic listener may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("ordinary Minds fixture health check timed out");
}

test.beforeAll(async () => {
  fixture = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: {
      ...process.env,
      MIND_DIARY_ORDINARY_MINDS_UI_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFixture();
});

test.afterAll(async () => {
  if (fixture.exitCode !== null) return;
  fixture.kill("SIGTERM");
  await new Promise((resolveExit) => fixture.once("exit", resolveExit));
});

test("Personal Mind stays first and ordinary create carries private metadata", async ({ page }) => {
  await page.goto(`${origin}/minds`);
  await expect(page.locator("[data-minds-list] [data-mind-card]").first()).toHaveAttribute(
    "data-mind-card",
    "me",
  );
  await expect(page.locator("[data-personal-mind]")).toContainText("Private, always");
  await expect(page.locator("[data-personal-mind]")).toContainText("no separate rename");

  await page.getByRole("button", { name: "Create a Mind" }).first().click();
  await page.getByLabel("Mind name").fill("Delivery Notes");
  await expect(page.getByLabel("Web address")).toHaveValue("delivery-notes");
  await page.getByLabel("Description (optional)").fill("Release decisions and evidence.");
  await page.getByRole("button", { name: "Create Mind" }).click();

  await expect(page.locator('[data-mind-card="delivery-notes"]')).toContainText(
    "Release decisions and evidence.",
  );
  const createCall = await page.evaluate(() =>
    globalThis.__ordinaryMindsCalls.find(({ operation }) => operation === "createMind"));
  expect(createCall.command).toMatchObject({
    name: "Delivery Notes",
    handle: "delivery-notes",
    description: "Release decisions and evidence.",
  });
  expect(createCall.command.idempotencyKey).toMatch(/^fixture-key-/u);
});

test("direct route saves name and description under one metadata version", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await expect(page.locator("[data-route-description]")).toHaveText(
    "Research decisions and supporting notes.",
  );
  await page.getByLabel("Mind name").fill("Research Library");
  await page.getByLabel("Description (optional)").fill("Curated evidence.");
  await page.getByRole("button", { name: "Save metadata" }).click();

  await expect(page.locator("[data-rename-status]")).toContainText("Metadata saved");
  await expect(page.locator("[data-route-mind-name]")).toHaveText("Research Library");
  await expect(page.locator("[data-route-description]")).toHaveText("Curated evidence.");
  const updateCall = await page.evaluate(() =>
    globalThis.__ordinaryMindsCalls.find(({ operation }) => operation === "renameMind"));
  expect(updateCall.command).toMatchObject({
    handle: "research-notes",
    name: "Research Library",
    description: "Curated evidence.",
    expectedMetadataVersion: 7,
  });
});

test("stale metadata and deletion both require a fresh conscious read", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await page.getByLabel("Mind name").fill("Conflicting name");
  await page.getByRole("button", { name: "Save metadata" }).click();
  await expect(page.locator("[data-rename-status]")).toContainText("changed in another session");
  await expect(page.getByRole("button", { name: "Reload current settings" })).toBeVisible();

  await page.getByRole("button", { name: "Review deletion impact" }).click();
  await expect(page.locator("[data-impact-revisions]")).toHaveText("12");
  await expect(page.locator("[data-impact-members]")).toHaveText("3");
  const phrase = "delete-mind:research-notes";
  await page.getByLabel("Confirmation phrase").fill(phrase);
  await page.getByLabel(/recovery is unavailable/u).check();
  await expect(page.getByRole("button", { name: "Delete Mind permanently" })).toBeEnabled();
  await page.getByRole("button", { name: "Delete Mind permanently" }).click();
  await expect(page.getByRole("heading", { name: "Mind deleted" })).toBeVisible();
  await expect(page.getByText("permanently retired")).toBeVisible();
});
