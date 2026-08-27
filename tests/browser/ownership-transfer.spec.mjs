import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const fixtureServer = resolve(
  import.meta.dirname,
  "invitations-membership/fixture-server.mjs",
);
const port = 4282;
const origin = `http://127.0.0.1:${port}`;
let fixture;

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) throw new Error("ownership fixture exited early");
    try {
      if ((await fetch(`${origin}/_fixture/health`)).ok) return;
    } catch {
      // The deterministic listener may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("ownership fixture health check timed out");
}

test.beforeAll(async () => {
  fixture = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: { ...process.env, MIND_DIARY_AND82_UI_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFixture();
});

test.afterAll(async () => {
  if (fixture.exitCode !== null) return;
  fixture.kill("SIGTERM");
  await new Promise((resolveExit) => fixture.once("exit", resolveExit));
});

test("Owner confirms the exact participant and both role consequences before atomic transfer", async ({ page }) => {
  await page.goto(`${origin}/invitations`);
  const form = page.locator("[data-transfer-form]");
  const target = form.locator("select[name=target_member_id]");
  const submit = form.getByRole("button", { name: "Transfer ownership" });

  await expect(target.locator("option")).toHaveCount(3);
  await expect(target.locator('option:has-text("Pending participant")')).toHaveCount(0);
  await expect(submit).toBeDisabled();
  await target.selectOption("member_editor");
  await expect(form.locator("[data-transfer-target-name]")).toHaveText("Eva Editor");
  await expect(form.locator("[data-transfer-consequences]")).toContainText("sole Owner immediately");
  await expect(form.locator("[data-transfer-consequences]")).toContainText("You will become Admin");
  await expect(submit).toBeDisabled();
  await form.locator("[name=confirm_source_admin]").check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.locator('[data-member-card="member_owner"]')).toHaveAttribute("data-member-role", "admin");
  await expect(page.locator('[data-member-card="member_editor"]')).toHaveAttribute("data-member-role", "owner");
  await expect(page.getByRole("button", { name: "Ownership transfer unavailable" })).toBeDisabled();
});

test("revoked target race reloads authoritative roles and leaves the prior Owner intact", async ({ page }) => {
  await page.goto(`${origin}/invitations?scenario=ownership-conflict`);
  const form = page.locator("[data-transfer-form]");
  await form.locator("select[name=target_member_id]").selectOption("member_editor");
  await form.locator("[name=confirm_source_admin]").check();
  await form.getByRole("button", { name: "Transfer ownership" }).click();

  await expect(page.locator('[data-member-card="member_owner"]')).toHaveAttribute("data-member-role", "owner");
  await expect(page.locator('[data-member-card="member_editor"]')).toHaveAttribute("data-member-state", "revoked");
  await expect(page.locator("[data-page-announcement]")).toContainText("latest state is shown");
  await expect(page.locator('[data-transfer-form] option[value="member_editor"]')).toHaveCount(0);
});
