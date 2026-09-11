import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const fixtureServer = resolve(import.meta.dirname, "fixture-server.mjs");
const origin = "http://127.0.0.1:4334";
let fixture;

test.beforeAll(async () => {
  fixture = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: { ...process.env, MIND_DIARY_BROWSER_FIXTURE_PORT: "4334" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) throw new Error("mind usage fixture exited early");
    try {
      if ((await fetch(`${origin}/_fixture/health`)).ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("mind usage fixture did not become ready");
});

test.afterAll(async () => {
  if (fixture.exitCode !== null) return;
  fixture.kill("SIGTERM");
  await new Promise((resolveExit) => fixture.once("exit", resolveExit));
});

function card(page, ref) {
  return page.locator(`[data-mind-usage-card="${ref}"]`);
}

test("Personal and ordinary write modes stay independent and reload server state on conflict", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/minds`);

  await page.locator("[data-agent-settings-disclosure] > summary").click();
  await expect(page.locator("[data-mind-usage-card]").first()).toBeVisible();
  await expect(page.locator("[data-mind-usage-card]")).toHaveCount(5);
  await expect(page.getByText("without one, it uses that Mind only when you ask", { exact: false })).toBeVisible();
  await expect(card(page, "/archive").locator('input[value="read_write"]')).toBeEnabled();
  await expect(card(page, "/archive")).toContainText("Codex uses this Mind only when you ask");
  await expect(card(page, "/archive")).toContainText("Allow only the specific saves, updates, or deletions you directly ask Codex to make");
  await expect(card(page, "/readonly").locator('input[value="read_write"]')).toBeDisabled();
  await expect(card(page, "/readonly")).toContainText("current Mind role does not allow content writes");
  await expect(card(page, "/research-notes")).toContainText("Unlisted — signed-in readers with the exact link");

  await card(page, "/research-notes").locator('input[value="read_write"]').check();
  await card(page, "/research-notes").getByRole("button", { name: "Save agent mode" }).click();
  await expect(page.getByText("Agent intent saved and read back from the server.")).toBeVisible();
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read and write/u);

  await card(page, "/archive").locator('input[value="read_write"]').check();
  await expect(card(page, "/archive").getByRole("status")).toBeEmpty();
  await card(page, "/archive").getByRole("button", { name: "Save agent mode" }).click();
  await expect(card(page, "/archive")).toContainText(/Configured intent\s*Read and write/u);
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read and write/u);

  await card(page, "/plans").locator('input[value="read_write"]').check();
  await expect(card(page, "/plans").getByRole("status")).toBeEmpty();
  await card(page, "/plans").getByRole("button", { name: "Save agent mode" }).click();
  await expect(card(page, "/plans")).toContainText(/Configured intent\s*Read and write/u);
  await expect(card(page, "/archive")).toContainText(/Configured intent\s*Read and write/u);
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read and write/u);

  await card(page, "/me").locator('input[value="read_write"]').check();
  await expect(card(page, "/me").getByRole("status")).toBeEmpty();
  await card(page, "/me").getByRole("button", { name: "Save agent mode" }).click();
  await expect(card(page, "/me")).toContainText(/Configured intent\s*Read and write/u);
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read and write/u);
  await expect(page.locator('input[value="read_write"]:checked')).toHaveCount(4);

  await card(page, "/research-notes").locator('input[value="read"]').check();
  expect((await context.request.post(`${origin}/_fixture/conflict`)).ok()).toBe(true);
  await card(page, "/research-notes").getByRole("button", { name: "Save agent mode" }).click();
  await expect(page.getByText(
    "Intent changed in another session. Current server settings were reloaded.",
  )).toBeVisible();
  await expect(card(page, "/me")).toContainText(/Configured intent\s*Read and write/u);
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read and write/u);
  await expect(page.getByText("After a write, Codex should report what changed", {
    exact: false,
  }).first()).toBeVisible();
  expect((await context.request.post(`${origin}/_fixture/topics`)).ok()).toBe(true);
  await page.reload();
  await page.locator("[data-agent-settings-disclosure] > summary").click();
  await expect(card(page, "/me")).toContainText("Research decisions; exclude daily logs.");
  await expect(card(page, "/me")).toContainText("Also save discussed durable knowledge that matches this description.");
  await expect(card(page, "/me").locator('input[value="read_write"]')).toBeChecked();
  expect(errors).toEqual([]);
  await context.close();
});
