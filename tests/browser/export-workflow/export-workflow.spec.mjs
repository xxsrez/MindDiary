import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const fixtureServer = resolve(import.meta.dirname, "fixture-server.mjs");
const port = 4327;
const origin = `http://127.0.0.1:${port}`;
let child;

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/_fixture/health`)).ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("export fixture health check timed out");
}

async function reset(mode = "normal") {
  await fetch(`${origin}/_fixture/reset?mode=${encodeURIComponent(mode)}`, { method: "POST" });
}

async function state() {
  return (await (await fetch(`${origin}/_fixture/state`)).json());
}

async function ready(page) {
  await expect(page.getByText("Archive ready. Verify its size and SHA-256 while downloading.")).toBeVisible();
  await expect(page.locator("[data-export-job-state]")).toHaveText("Ready");
}

test.beforeAll(async () => {
  child = spawn(process.execPath, [fixtureServer], { cwd: root, env: { ...process.env, MIND_DIARY_EXPORT_UI_PORT: String(port) }, stdio: "ignore" });
  await waitForFixture();
});

test.afterAll(async () => {
  if (child.exitCode === null) child.kill("SIGTERM");
});

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  await reset();
});

test("current revision recovers without duplicate and independently verifies saved bytes", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await expect(page.locator("[data-export-target-name]")).toHaveText("Research Notes");
  await expect(page.locator("[data-export-target-route]")).toHaveText("/research-notes");
  await expect(page.getByLabel("Current HEAD")).toBeChecked();
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);

  expect((await state()).uniqueJobs).toBe(1);
  await page.reload();
  await ready(page);
  expect((await state()).startRequests).toBe(1);
  const stored = await page.evaluate(() => Object.values(sessionStorage));
  expect(stored).toHaveLength(1);
  expect(stored[0]).not.toMatch(/download|grant-|sha256|filename|\/api\/v1\/exports/);

  const receiptSize = Number((await page.locator("[data-export-receipt-size]").textContent()).replace(/[^0-9]/g, ""));
  const receiptSha = await page.locator("[data-export-receipt-sha]").textContent();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Verify and save archive" }).click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  expect(bytes.byteLength).toBe(receiptSize);
  expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(receiptSha);
  await expect(page.locator("[data-export-download-status]")).toContainText("Verified");
});

test("historical mixed revision requires explicit bundle and unknown start replays once", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await page.getByLabel("Exact historical revision").check();
  await page.getByLabel("Historical revision ID").fill("revision_mixed");
  await page.getByLabel("Archive content").selectOption("MD-OKF-ZIP-1");
  await page.getByRole("button", { name: "Start export" }).click();
  await expect(page.locator("[data-export-status]")).toContainText("contains attachments");
  await expect(page.getByLabel("Archive content")).toHaveValue("MD-BUNDLE-ZIP-1");
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);
  expect((await state()).jobs[0]).toMatchObject({ revision_id: "revision_mixed", profile: "MD-BUNDLE-ZIP-1" });

  await reset("unknown_once");
  await page.getByRole("button", { name: "Start another export" }).click();
  await page.getByLabel("Exact historical revision").check();
  await page.getByLabel("Historical revision ID").fill("revision_history_2");
  await page.getByRole("button", { name: "Start export" }).click();
  await expect(page.locator("[data-export-status]")).toContainText("same idempotent request");
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);
  const replay = await state();
  expect(replay.startRequests).toBe(2);
  expect(replay.uniqueJobs).toBe(1);
  expect(replay.jobs[0].revision_id).toBe("revision_history_2");
});

test("expired and access-tightened states fail closed; mobile keyboard flow stays bounded", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await reset("expired");
  await page.goto(`${origin}/research-notes`);
  await page.keyboard.press("Tab");
  for (let index = 0; index < 30 && !(await page.getByLabel("Current HEAD").evaluate((node) => node === document.activeElement)); index += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(page.getByLabel("Current HEAD")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("Exact historical revision")).toBeChecked();
  await expect(page.getByLabel("Historical revision ID")).toBeEnabled();
  await expect(page.getByLabel("Historical revision ID")).toBeFocused();
  await page.getByLabel("Historical revision ID").fill("revision_old");
  await page.getByRole("button", { name: "Start export" }).click();
  await expect(page.locator("[data-export-job-state]")).toHaveText("Expired");
  await expect(page.getByRole("button", { name: "Start another export" })).toBeVisible();
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, panel: document.querySelector("[data-export-workflow]").scrollWidth, panelClient: document.querySelector("[data-export-workflow]").clientWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.panel).toBeLessThanOrEqual(widths.panelClient + 1);

  for (const deniedMode of ["revoked", "tightened"]) {
    await reset(deniedMode);
    await page.getByRole("button", { name: "Start another export" }).click();
    await page.getByRole("button", { name: "Start export" }).click();
    await expect(page.locator("[data-export-status]")).toHaveText("This export is no longer available. Reload the Mind and start a fresh export if you still have access.");
    await expect(page.locator("[data-export-receipt]")).toBeHidden();
  }
  await context.close();
});

test("checksum mismatch never produces a browser download", async ({ page }) => {
  await reset("corrupt");
  await page.goto(`${origin}/research-notes`);
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await page.getByRole("button", { name: "Verify and save archive" }).click();
  await expect(page.locator("[data-export-download-status]")).toContainText("Archive not saved");
  expect(downloads).toBe(0);
});
