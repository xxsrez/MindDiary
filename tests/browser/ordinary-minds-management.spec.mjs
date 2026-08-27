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

async function resetFixture() {
  const response = await fetch(`${origin}/_fixture/reset`, { method: "POST" });
  if (!response.ok) throw new Error("ordinary Minds fixture reset failed");
}

async function setConflict(mode) {
  const response = await fetch(`${origin}/_fixture/conflict`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error("ordinary Minds fixture conflict setup failed");
}

async function fixtureCalls() {
  const response = await fetch(`${origin}/_fixture/calls`);
  return (await response.json()).calls;
}

async function expectFreshAuthority(page, role) {
  await expect(page.locator("[data-route-role]")).toHaveText(role);
  await expect(page.locator("[data-rename-mind-form]")).toHaveCount(0);
  await expect(page.locator("[data-owner-delete-controls], [data-delete-mind-dialog]")).toHaveCount(0);
  await expect(page.locator("[data-owner-visibility-controls]")).toHaveCount(0);
  await expect(page.locator("[data-owner-transfer-controls], [data-ownership-transfer-form]")).toHaveCount(0);
  await expect(page.locator("[data-markdown-import]")).toHaveCount(0);
  await expect(page.locator("[data-capacity-state], [data-capacity-unavailable]")).toHaveCount(0);
  await expect(page.locator("[data-invitation-form], [data-member-role-form]")).toHaveCount(0);
  await expect(page.locator("[data-visibility-readonly]")).toBeVisible();
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

test.beforeEach(async () => {
  await resetFixture();
});

test.afterAll(async () => {
  if (fixture.exitCode !== null) return;
  fixture.kill("SIGTERM");
  await new Promise((resolveExit) => fixture.once("exit", resolveExit));
});

test("shipped client keeps Personal first and creates private metadata", async ({ page }) => {
  await page.goto(`${origin}/minds`);
  await expect(page.locator('script[src="/ui/mind-diary-ordinary-minds-client.js"]')).toHaveCount(1);
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

  await expect(page).toHaveURL(`${origin}/delivery-notes`);
  await expect(page.locator("[data-route-description]")).toHaveText("Release decisions and evidence.");
  const createCall = (await fixtureCalls()).find(({ operation }) => operation === "createMind");
  expect(createCall.command).toEqual({
    name: "Delivery Notes",
    handle: "delivery-notes",
    description: "Release decisions and evidence.",
  });
  expect(createCall.csrf).toBe("fixture-csrf-token");
  expect(createCall.idempotencyKey).toMatch(/^mind:[0-9a-f-]{36}$/u);
});

test("shipped direct route saves name and description under one metadata version", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await expect(page.locator("[data-route-description]")).toHaveText(
    "Research decisions and supporting notes.",
  );
  await page.getByLabel("Mind name").fill("Research Library");
  await page.getByLabel("Description (optional)").fill("Curated evidence.");
  await page.getByRole("button", { name: "Save metadata" }).click();

  await expect(page.locator("[data-route-mind-name]")).toHaveText("Research Library");
  await expect(page.locator("[data-route-description]")).toHaveText("Curated evidence.");
  const updateCall = (await fixtureCalls()).find(({ operation }) => operation === "updateMetadata");
  expect(updateCall.command).toEqual({
    handle: "research-notes",
    name: "Research Library",
    description: "Curated evidence.",
    expected_metadata_version: 7,
  });
  expect(updateCall.csrf).toBe("fixture-csrf-token");
  expect(updateCall.idempotencyKey).toMatch(/^metadata:[0-9a-f-]{36}$/u);
});

test("shipped Access reveals exact-email invite, cancel, and seven-day reissue with current readback", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await expect(page.locator("[data-access-summary]")).toContainText("1 pending");
  await expect(page.locator("[data-access-participant-summary]")).toContainText("Morgan Editor");
  await expect(page.locator("[data-invitation-form]")).not.toBeVisible();

  await page.locator("[data-access-invitations] summary").click();
  const email = page.getByLabel("Exact verified email");
  await expect(email).toHaveAttribute("autocomplete", "off");
  await email.fill("registered@example.com");
  await page.getByLabel("Role after acceptance").selectOption("editor");
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "Send in-app invitation" }).click(),
  ]);

  await expect(page.locator("[data-access-summary]")).toContainText("2 pending");
  await page.locator("[data-access-invitations] summary").click();
  const created = page.locator('[data-invitation-card="invitation-fixture-created"]');
  await expect(created).toContainText("Registered Person");
  await expect(created).toContainText("Sep 4, 2026");
  await Promise.all([
    page.waitForNavigation(),
    created.getByRole("button", { name: "Cancel invitation" }).click(),
  ]);

  await expect(page.locator("[data-access-summary]")).toContainText("1 pending");
  await page.locator("[data-access-invitations] summary").click();
  const cancelled = page.locator('[data-invitation-card="invitation-fixture-created"]');
  await expect(cancelled).toHaveAttribute("data-invitation-state", "cancelled");
  await Promise.all([
    page.waitForNavigation(),
    cancelled.getByRole("button", { name: "Reissue for 7 days" }).click(),
  ]);

  await expect(page.locator("[data-access-summary]")).toContainText("2 pending");
  const calls = await fixtureCalls();
  expect(calls.find(({ operation }) => operation === "createInvitation").command).toMatchObject({
    handle: "research-notes",
    target_verified_email: "registered@example.com",
    role: "editor",
    expected_metadata_version: 7,
  });
  expect(calls.find(({ operation }) => operation === "cancelInvitation").command)
    .toMatchObject({ expected_invitation_version: 1 });
  expect(calls.find(({ operation }) => operation === "reissueInvitation").command)
    .toMatchObject({ expected_invitation_version: 2 });
});

test("metadata conflict reload removes every stale control after role downgrade", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await expect(page.locator("[data-owner-delete-controls]")).toBeVisible();
  await expect(page.locator("[data-owner-visibility-controls]")).toBeVisible();
  await expect(page.locator("[data-markdown-import]")).toBeVisible();
  await expect(page.locator("[data-capacity-state]")).toBeVisible();
  await expect(page.locator('script[src="/ui/mind-diary-ordinary-minds-client.js"]')).toHaveCount(1);
  await expect(page.locator('script[src="/ui/mind-diary-collaboration-client.js"]')).toHaveCount(0);
  await expect(page.locator("[data-access-summary]")).toContainText("Private");
  await expect(page.locator("[data-invitation-form]")).not.toBeVisible();
  await expect(page.locator("[data-member-role-form]")).not.toBeVisible();
  await page.locator("[data-access-invitations] summary").click();
  await page.locator("[data-access-participants] summary").click();
  await expect(page.locator("[data-invitation-form]")).toBeVisible();
  await expect(page.locator("[data-member-role-form]")).toBeVisible();
  await expect(page.locator("[data-ownership-transfer-form]")).toBeVisible();

  await setConflict("downgrade");
  await page.getByLabel("Mind name").fill("Conflicting name");
  await page.getByRole("button", { name: "Save metadata" }).click();
  await expect(page.locator("[data-rename-status]")).toContainText("changed in another session");
  await page.getByRole("button", { name: "Reload current settings" }).click();

  await expectFreshAuthority(page, "Reader");
  await expect(page.getByRole("heading", { name: "Settings are read-only" })).toBeVisible();
});

test("metadata conflict reload fails closed after access revocation", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await setConflict("revoke");
  await page.getByLabel("Mind name").fill("Conflicting name");
  await page.getByRole("button", { name: "Save metadata" }).click();
  await expect(page.getByRole("button", { name: "Reload current settings" })).toBeVisible();
  await page.getByRole("button", { name: "Reload current settings" }).click();

  await expect(page.getByRole("heading", { name: "Mind settings unavailable" })).toBeVisible();
  await expect(page.locator("[data-mind-route]")).toHaveCount(0);
  await expect(page.locator("[data-control-action], [data-owner-delete-controls], [data-markdown-import]")).toHaveCount(0);
});

test("shipped visibility flow requires exact disclosure acknowledgment", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const form = page.locator("[data-visibility-form]");
  await form.locator("[data-visibility-selector]").selectOption("public");
  await expect(form.locator("[data-visibility-exposure]")).toBeVisible();
  await expect(form.locator("[data-save-visibility]")).toBeDisabled();
  await form.locator("[data-visibility-ack]").check();
  await form.locator("[data-save-visibility]").click();

  await expect(page.locator("[data-route-visibility]")).toHaveText("Public");
  await expect(page.locator("[data-access-summary]")).toContainText(
    "Authenticated people can discover and read the live HEAD and history.",
  );
  const call = (await fixtureCalls()).find(({ operation }) => operation === "changeVisibility");
  expect(call.command).toMatchObject({
    handle: "research-notes",
    visibility: "public",
    acknowledge_live_head_and_history_exposure: true,
    expected_metadata_version: 7,
  });
  expect(call.csrf).toBe("fixture-csrf-token");
  expect(call.idempotencyKey).toMatch(/^visibility:[0-9a-f-]{36}$/u);
});

test("shipped ownership flow reloads the former Owner as Admin", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const form = page.locator("[data-ownership-transfer-form]");
  await form.getByLabel("New Owner").selectOption("member-fixture-editor");
  await form.getByLabel(/sole Owner/u).check();
  await form.getByRole("button", { name: "Transfer ownership" }).click();

  await expect(page.locator("[data-route-role]")).toHaveText("Admin");
  await expect(page.locator("[data-rename-mind-form]")).toBeVisible();
  await expect(page.locator("[data-owner-delete-controls], [data-owner-visibility-controls]")).toHaveCount(0);
  await expect(page.locator("[data-visibility-readonly]")).toBeVisible();
  const call = (await fixtureCalls()).find(({ operation }) => operation === "transferOwnership");
  expect(call.command).toEqual({
    handle: "research-notes",
    target_member_id: "member-fixture-editor",
    expected_metadata_version: 7,
    expected_source_membership_version: 3,
    expected_target_membership_version: 5,
    confirmation: "transfer-ownership",
  });
  expect(call.csrf).toBe("fixture-csrf-token");
  expect(call.idempotencyKey).toMatch(/^ownership:[0-9a-f-]{36}$/u);
});

test("shipped deletion uses a fresh preview and conscious confirmation", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  await page.getByRole("button", { name: "Review deletion impact" }).click();
  await expect(page.locator("[data-impact-revisions]")).toHaveText("12");
  await expect(page.locator("[data-impact-members]")).toHaveText("3");
  const phrase = "delete-mind:research-notes";
  await page.getByLabel("Confirmation phrase").fill(phrase);
  await page.getByLabel(/recovery is unavailable/u).check();
  await expect(page.getByRole("button", { name: "Delete Mind permanently" })).toBeEnabled();
  await page.getByRole("button", { name: "Delete Mind permanently" }).click();

  await expect(page).toHaveURL(`${origin}/minds`);
  await expect(page.locator('[data-mind-card="research-notes"]')).toHaveCount(0);
  const call = (await fixtureCalls()).find(({ operation }) => operation === "deleteMind");
  expect(call.command).toMatchObject({
    handle: "research-notes",
    impact_id: "impact_fixture_owner_0001",
    confirmation: phrase,
  });
  expect(call.csrf).toBe("fixture-csrf-token");
  expect(call.idempotencyKey).toMatch(/^delete:[0-9a-f-]{36}$/u);
});
