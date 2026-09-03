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

test("three account-wide modes enforce one writable Mind and reload server state on conflict", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/minds`);

  await expect(page.getByRole("heading", { name: "How Codex uses your Minds" })).toBeVisible();
  await expect(page.locator("[data-mind-usage-card]")).toHaveCount(3);
  await expect(page.getByText("My Mind accepts writes only when you directly ask Codex", { exact: false })).toBeVisible();
  await expect(card(page, "/archive").locator('input[value="read_write"]')).toBeDisabled();
  await expect(card(page, "/archive")).toContainText("Add a routing description");
  await expect(card(page, "/archive")).toContainText("Read only still works when you name this Mind directly");
  await expect(card(page, "/research-notes")).toContainText("Unlisted — signed-in readers with the exact link");

  await card(page, "/research-notes").locator('input[value="read_write"]').check();
  await card(page, "/research-notes").getByRole("button", { name: "Save agent mode" }).click();
  await expect(page.getByText("Agent intent saved and read back from the server.")).toBeVisible();
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read and write/u);

  await card(page, "/me").locator('input[value="read_write"]').check();
  await expect(card(page, "/me").getByRole("status")).toContainText(
    "atomically move Research notes to Read only",
  );
  await card(page, "/me").getByRole("button", { name: "Save agent mode" }).click();
  await expect(card(page, "/me")).toContainText(/Configured intent\s*Read and write/u);
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read only/u);
  await expect(page.locator('input[value="read_write"]:checked')).toHaveCount(1);

  await card(page, "/research-notes").locator('input[value="read_write"]').check();
  expect((await context.request.post(`${origin}/_fixture/conflict`)).ok()).toBe(true);
  await card(page, "/research-notes").getByRole("button", { name: "Save agent mode" }).click();
  await expect(page.getByText(
    "Intent changed in another session. Current server settings were reloaded.",
  )).toBeVisible();
  await expect(card(page, "/me")).toContainText(/Configured intent\s*Read and write/u);
  await expect(card(page, "/research-notes")).toContainText(/Configured intent\s*Read only/u);
  await expect(page.getByText("After an automatic write, Codex should report what changed", {
    exact: false,
  }).first()).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
