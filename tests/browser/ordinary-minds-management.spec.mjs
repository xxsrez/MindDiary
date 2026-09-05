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

function participantCard(page, name = "Morgan Editor") {
  return page.locator("[data-member-card]").filter({ has: page.getByRole("heading", { name }) });
}

async function revealParticipants(page) {
  const details = page.locator("[data-access-participants]");
  await expect(details).toHaveCount(1);
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator("summary").click();
  }
  await expect(details).toHaveJSProperty("open", true);
}

async function confirmMembershipAction(page, buttonName) {
  const dialog = page.locator("[data-membership-confirmation-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: buttonName })).toBeDisabled();
  await dialog.getByLabel(/reviewed the current participant, role, and access consequences/u).check();
  await Promise.all([
    page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame()),
    dialog.getByRole("button", { name: buttonName }).click(),
  ]);
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
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await expect(page.locator('script[src="/ui/mind-diary-ordinary-minds-list-client.js"]')).toHaveCount(1);
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
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await expect(page.locator("[data-mind-usage-panel]")).toContainText(
    "For an ordinary Mind, Read and write permits automatic saving only for explicitly discussed durable knowledge that matches the Mind description; My Mind is controlled independently.",
  );
  await expect(page.locator("[data-mind-usage-panel]")).not.toContainText(
    "For My Mind, Read and write permits only the specific writes",
  );
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

test("shipped Access removes a cancelled invite and reinvites through the normal form", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
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
  const created = page.locator('[data-invitation-card="invitation-fixture-created-1"]');
  await expect(created).toContainText("Registered Person");
  await expect(created).toContainText("Sep 4, 2026");
  await Promise.all([
    page.waitForNavigation(),
    created.getByRole("button", { name: "Cancel invitation" }).click(),
  ]);

  await expect(page.locator("[data-access-summary]")).toContainText("1 pending");
  await page.locator("[data-access-invitations] summary").click();
  await expect(page.locator('[data-invitation-card="invitation-fixture-created-1"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reissue for 7 days" })).toHaveCount(0);
  await page.getByLabel("Exact verified email").fill("registered@example.com");
  await page.getByLabel("Role after acceptance").selectOption("editor");
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "Send in-app invitation" }).click(),
  ]);

  await expect(page.locator("[data-access-summary]")).toContainText("2 pending");
  await page.locator("[data-access-invitations] summary").click();
  await expect(page.locator('[data-invitation-card="invitation-fixture-created-2"]'))
    .toContainText("Registered Person");
  const calls = await fixtureCalls();
  const createCalls = calls.filter(({ operation }) => operation === "createInvitation");
  expect(createCalls).toHaveLength(2);
  expect(createCalls[0].command).toMatchObject({
    handle: "research-notes",
    target_verified_email: "registered@example.com",
    role: "editor",
    expected_metadata_version: 7,
  });
  expect(calls.find(({ operation }) => operation === "cancelInvitation").command)
    .toMatchObject({ expected_invitation_version: 1 });
  expect(calls.some(({ operation }) => operation === "reissueInvitation")).toBe(false);
});

test("shipped late-action conflict announces expiry and reloads without a terminal card", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await page.locator("[data-access-invitations] summary").click();
  const pending = page.locator('[data-invitation-card="invitation-fixture-pending"]');
  await expect(pending).toHaveAttribute("data-invitation-state", "pending");
  await setConflict("invitation-expiry");

  const navigation = page.waitForNavigation();
  await pending.getByRole("button", { name: "Cancel invitation" })
    .evaluate((button) => button.click());
  await expect(page.locator("[data-page-announcement]"))
    .toContainText("expired. Reloading current state");
  await navigation;

  await expect(page.locator("[data-access-summary]")).toContainText("No pending invitations");
  await page.locator("[data-access-invitations] summary").click();
  await expect(page.locator('[data-invitation-card="invitation-fixture-pending"]')).toHaveCount(0);
  await expect(page.locator('[data-invitation-state="expired"]')).toHaveCount(0);
});

test("metadata conflict reload removes every stale control after role downgrade", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await expect(page.locator("[data-owner-delete-controls]")).toBeVisible();
  await expect(page.locator("[data-owner-visibility-controls]")).toBeVisible();
  await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await page.locator("summary").filter({ hasText: /^Storage details$/ }).click();
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
  await page.locator("[data-rename-mind-form] [data-refresh-mind]").click();

  await expectFreshAuthority(page, "Reader");
  await expect(page.getByRole("heading", { name: "Settings are read-only" })).toBeVisible();
});

test("metadata conflict reload fails closed after access revocation", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await setConflict("revoke");
  await page.getByLabel("Mind name").fill("Conflicting name");
  await page.getByRole("button", { name: "Save metadata" }).click();
  const metadataReload = page.locator("[data-rename-mind-form] [data-refresh-mind]");
  await expect(metadataReload).toBeVisible();
  await metadataReload.click();

  await expect(page.getByRole("heading", { name: "Mind settings unavailable" })).toBeVisible();
  await expect(page.locator("[data-mind-route]")).toHaveCount(0);
  await expect(page.locator("[data-control-action], [data-owner-delete-controls], [data-markdown-import]")).toHaveCount(0);
});

test("shipped visibility flow requires exact disclosure acknowledgment", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
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
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
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

test("role change waits for contextual confirmation and sends the rendered membership version", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await revealParticipants(page);
  const card = participantCard(page);
  await card.getByLabel("Role").selectOption("reader");
  await card.getByRole("button", { name: "Update role" }).click();

  const dialog = page.locator("[data-membership-confirmation-dialog]");
  await expect(dialog.getByRole("heading", { name: "Confirm role change" })).toBeVisible();
  await expect(dialog.locator("[data-membership-confirmation-summary]")).toHaveText(
    "Change Morgan Editor from editor to reader?",
  );
  expect((await fixtureCalls()).filter(({ operation }) => operation === "changeMembershipRole")).toHaveLength(0);
  await confirmMembershipAction(page, "Confirm role change");

  await revealParticipants(page);
  await expect(participantCard(page)).toHaveAttribute("data-member-role", "reader");
  const call = (await fixtureCalls()).find(({ operation }) => operation === "changeMembershipRole");
  expect(call.command).toEqual({
    handle: "research-notes",
    member_id: "member-fixture-editor",
    role: "reader",
    expected_membership_version: 5,
  });
  expect(call.csrf).toBe("fixture-csrf-token");
  expect(call.idempotencyKey).toMatch(/^membership-role:[0-9a-f-]{36}$/u);
});

test("membership conflict discards every stale action and renders the concurrent role", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await setConflict("membership");
  await revealParticipants(page);
  const card = participantCard(page);
  await card.getByLabel("Role").selectOption("reader");
  await card.getByRole("button", { name: "Update role" }).click();
  await confirmMembershipAction(page, "Confirm role change");

  await revealParticipants(page);
  const current = participantCard(page);
  await expect(current).toHaveAttribute("data-member-role", "admin");
  await expect(current.getByLabel("Role")).toHaveValue("admin");
  await expect(page.locator("[data-membership-confirmation-dialog]")).not.toBeVisible();
  const call = (await fixtureCalls()).find(({ operation }) => operation === "changeMembershipRole");
  expect(call.command.expected_membership_version).toBe(5);
});

test("public revoke explains and preserves visibility-only read without write or management", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  const visibility = page.locator("[data-visibility-form]");
  await visibility.locator("[data-visibility-selector]").selectOption("public");
  await visibility.locator("[data-visibility-ack]").check();
  await visibility.locator("[data-save-visibility]").click();
  await expect(page.locator("[data-route-visibility]")).toHaveText("Public");

  await revealParticipants(page);
  await participantCard(page).getByRole("button", { name: "Revoke access" }).click();
  const dialog = page.locator("[data-membership-confirmation-dialog]");
  await expect(dialog.locator("[data-membership-confirmation-impact]")).toContainText(
    "Public visibility may still allow signed-in read access to the live HEAD and history, but never content write or management.",
  );
  await confirmMembershipAction(page, "Revoke participant");

  await expect(participantCard(page)).toHaveCount(0);
  const call = (await fixtureCalls()).find(({ operation }) => operation === "revokeMembership");
  expect(call.command).toEqual({
    handle: "research-notes",
    member_id: "member-fixture-editor",
    expected_membership_version: 5,
  });
  expect(call.idempotencyKey).toMatch(/^membership-revoke:[0-9a-f-]{36}$/u);
});

test("unlisted leave reloads as exact-link baseline read with no membership controls", async ({ page }) => {
  await page.goto(`${origin}/shared-library`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await revealParticipants(page);
  await page.getByRole("button", { name: "Leave this Mind" }).click();
  const dialog = page.locator("[data-membership-confirmation-dialog]");
  await expect(dialog.locator("[data-membership-confirmation-impact]")).toContainText(
    "The exact link may still allow signed-in read access to the live HEAD and history, but never content write or management.",
  );
  await confirmMembershipAction(page, "Leave this Mind");

  await expect(page.locator('[data-membership-baseline="unlisted"]')).toBeVisible();
  await expect(page.locator("[data-route-role]")).toHaveText("Reader");
  await expect(page.locator("[data-member-role-form], [data-leave-mind], [data-membership-confirmation-dialog]")).toHaveCount(0);
  const call = (await fixtureCalls()).find(({ operation }) => operation === "leaveMind");
  expect(call.command).toEqual({ handle: "shared-library", expected_membership_version: 3 });
  expect(call.idempotencyKey).toMatch(/^membership-leave:[0-9a-f-]{36}$/u);
});

test("private leave reloads to a non-disclosing unavailable route", async ({ page }) => {
  await page.goto(`${origin}/private-room`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
  await revealParticipants(page);
  await page.getByRole("button", { name: "Leave this Mind" }).click();
  const dialog = page.locator("[data-membership-confirmation-dialog]");
  await expect(dialog.locator("[data-membership-confirmation-impact]")).toContainText(
    "all access ends immediately because this Mind is private",
  );
  await confirmMembershipAction(page, "Leave this Mind");

  await expect(page.getByRole("heading", { name: "Mind settings unavailable" })).toBeVisible();
  await expect(page.locator("[data-mind-route], [data-member-role-form], [data-leave-mind]")).toHaveCount(0);
});

test("shipped deletion uses a fresh preview and conscious confirmation", async ({ page }) => {
  await page.goto(`${origin}/research-notes`);
  const transferDisclosure = page.locator("summary").filter({ hasText: /^Transfer ownership$/ });
  if (await transferDisclosure.count()) await transferDisclosure.click();
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
