import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const fixtureServer = resolve(
  import.meta.dirname,
  "../ui-shell/product-control-fixture-server.mjs",
);
const port = 4324;
const origin = `http://127.0.0.1:${port}`;
let fixture;

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) throw new Error("account lifecycle fixture exited early");
    try {
      if ((await fetch(`${origin}/_fixture/health`)).ok) return;
    } catch {
      // The deterministic listener may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("account lifecycle fixture health check timed out");
}

test.beforeAll(async () => {
  fixture = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: {
      ...process.env,
      MIND_DIARY_UI_PORT: String(port),
      MIND_DIARY_UI_IDENTITY_STATE: "signed_out",
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

test.beforeEach(async () => {
  const reset = await fetch(`${origin}/_fixture/reset?state=signed_out`);
  if (reset.status !== 204) throw new Error("account lifecycle fixture reset failed");
});

test("signed-out entry, isolated bootstrap, reopen, conflict, and exact deletion stay safe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/private-target-that-must-not-leak`);

  await expect(page.locator('[data-session-state="anonymous"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with ChatGPT" }))
    .toHaveAttribute("href", "/signin-with-chatgpt");
  await expect(page.locator("[data-ia-shell], [data-ia-nav], input, meta[name=mind-diary-csrf-token]"))
    .toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("private-target-that-must-not-leak");
  await expect(page.locator("body")).not.toContainText("fixture@example.invalid");

  await page.getByRole("link", { name: "Sign in with ChatGPT" }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.getByRole("heading", { level: 1, name: "Choose how to continue" }))
    .toBeVisible();
  await expect(page.locator('[data-session-state="registration_required"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByText("Mind Diary does not create or store a separate password"))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Request account recovery" })).toBeVisible();
  await expect(page.locator("[data-ia-shell], [data-ia-nav]"))
    .toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("fixture@example.invalid");

  const displayName = page.getByLabel("Display name");
  await displayName.fill("Lifecycle Fixture");
  const create = page.getByRole("button", { name: "Create isolated account" });
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${origin}/me`);
  await expect(page.getByRole("heading", { level: 1, name: "My Mind" })).toBeVisible();
  await expect(page.getByText("Account and My Mind are ready.")).toBeVisible();
  await expect(page.locator("[data-optional-codex-setup]")).toContainText(
    "no setup wizard is required",
  );
  await expect(page.locator("[data-marketplace-install-guide]"))
    .toHaveAttribute("href", "/help/codex");

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "My Mind" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.getByRole("heading", { level: 1, name: "Minds" })).toBeVisible();
  await expect(page.locator('[data-session-state="registration_required"]')).toHaveCount(0);
  await page.goto(`${origin}/me`);

  await page.locator("[data-ia-mobile-trigger]").click();
  await expect(page.locator('[data-ia-nav-item="my-mind"]')).toBeFocused();
  await page.locator("[data-ia-settings-item]").click();
  await expect(page).toHaveURL(`${origin}/settings/account`);
  await expect(page.getByRole("heading", { level: 1, name: "Account and profile" }))
    .toBeVisible();
  await expect(page.locator("[data-current-account-identity]")).toContainText(
    "ChatGPT through OpenAI Sites",
  );
  await expect(page.locator("[data-current-account-identity]")).toContainText(
    "does not create or store a separate password",
  );
  await expect(page.locator("[data-current-account-identity]")
    .getByRole("link", { name: "Install and connect Mind Diary" }))
    .toHaveAttribute("href", "/help/codex");
  await expect(page.locator("body")).not.toContainText("fixture@example.invalid");
  const accountWidths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(accountWidths.document, JSON.stringify(accountWidths))
    .toBeLessThanOrEqual(accountWidths.viewport + 1);
  expect(accountWidths.body, JSON.stringify(accountWidths))
    .toBeLessThanOrEqual(accountWidths.viewport + 1);

  const bump = await page.evaluate(() => fetch("/_fixture/bump-profile").then((response) => response.status));
  expect(bump).toBe(204);
  await page.getByRole("textbox", { name: "Display name" }).fill("Stale Lifecycle Fixture");
  await page.getByRole("button", { name: "Save profile name" }).click();
  await expect(page.locator("[data-profile-status]")).toContainText(
    "profile changed in another session",
  );
  await expect(page.locator("[data-profile-form]")).toHaveAttribute("data-profile-conflict", "");
  await expect(page.getByRole("button", { name: "Save profile name" })).toBeDisabled();

  await page.reload();
  await expect(page.locator("[data-account-deletion-panel]")).toBeHidden();
  await page.locator("[data-account-deletion-disclosure] > summary").focus();
  await page.keyboard.press("Enter");
  const impact = page.locator('[data-ia-impact="account-delete"]');
  await expect(impact).toBeVisible();
  await expect(impact).toContainText("Browser Shared");
  await expect(page.locator("body")).not.toContainText("must-not-render@example.invalid");
  await expect(page.locator("body")).not.toContainText("PRIVATE BROWSER FIXTURE CONTENT");
  const ordered = await page.locator([
    '[data-ia-disclosure="account-delete"]',
    '[data-ia-impact="account-delete"]',
    '[data-ia-confirmation="account-delete"]',
    '[data-ia-destructive-action="account-delete"]',
  ].join(",")).evaluateAll((nodes) => nodes.map((node) => node.getAttributeNames()
    .find((name) => name.startsWith("data-ia-"))));
  expect(ordered).toEqual([
    "data-ia-disclosure",
    "data-ia-impact",
    "data-ia-confirmation",
    "data-ia-destructive-action",
  ]);

  const confirmation = page.getByLabel(/Type delete-account exactly/u);
  const deleteButton = page.getByRole("button", { name: "Delete account permanently" });
  await confirmation.fill("delete-accoun");
  await expect(deleteButton).toBeDisabled();
  await confirmation.fill("delete-account");
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.getByRole("heading", { level: 1, name: "Choose how to continue" }))
    .toBeVisible();
  await expect(page.locator("[data-current-account-identity], [data-account-deletion-panel]"))
    .toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Browser Shared");
});
