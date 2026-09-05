import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 4192;
const origin = `http://127.0.0.1:${port}`;
let fixture;
let fixtureFiles;

const directory = (name) => join(fixtureFiles, name);

async function waitForFixture(request) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await request.get(`${origin}/_fixture/health`)).ok()) return;
    } catch {
      // The fixture is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Markdown import fixture did not start");
}

async function reset(request, scenario) {
  const response = await request.post(`${origin}/_fixture/reset?scenario=${scenario}`);
  expect(response.ok()).toBeTruthy();
}

test.beforeAll(async ({ request }) => {
  fixtureFiles = await mkdtemp(join(tmpdir(), "mind-diary-markdown-import-ui-"));
  for (const name of ["valid", "one", "bad-path", "bad-utf8", "changed", "changed-again"]) {
    await mkdir(directory(name));
  }
  await writeFile(join(directory("valid"), "index.md"), "# Index\n");
  await writeFile(join(directory("valid"), "notes.md"), "# Notes\n");
  await writeFile(join(directory("one"), "index.md"), "# Index\n");
  await writeFile(join(directory("bad-path"), "notes.txt"), "not markdown");
  await writeFile(join(directory("bad-utf8"), "broken.md"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(directory("changed"), "index.md"), "# Changed\n");
  await writeFile(join(directory("changed-again"), "index.md"), "# Changed again\n");
  fixture = spawn(process.execPath, ["tests/browser/markdown-import/fixture-server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, MIND_DIARY_MARKDOWN_IMPORT_UI_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFixture(request);
});

test.afterAll(async () => {
  fixture?.kill("SIGTERM");
  await rm(fixtureFiles, { recursive: true, force: true });
});

test("writer reviews exact changes and commits one mobile-safe revision receipt", async ({ page, request }) => {
  await reset(request, "fresh");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/research-notes`);
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();

  await expect(page.locator("[data-import-target]")).toHaveText("/research-notes");
  await expect(page.locator("[data-import-base-revision]")).toHaveText("revision_import_base");
  await expect(page.locator("[data-start-markdown-import]")).toBeDisabled();
  await page.locator("[data-import-files]").setInputFiles(directory("valid"));
  await page.locator("[data-plan-markdown-import]").click();

  await expect(page.locator("[data-import-additions]")).toHaveText("1");
  await expect(page.locator("[data-import-replacements]")).toHaveText("1");
  await expect(page.locator("[data-import-deletions]")).toHaveText("2");
  await expect(page.locator("[data-import-path-check]")).toHaveAttribute("data-check-state", "passed");
  await expect(page.locator("[data-import-format-check]")).toHaveAttribute("data-check-state", "passed");
  await expect(page.locator("[data-import-capacity-check]")).toHaveAttribute("data-check-state", "passed");
  await expect(page.locator("[data-import-plan]")).toContainText("every current Markdown file omitted");

  await page.locator("[data-import-confirm]").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("[data-start-markdown-import]")).toBeEnabled();
  await page.locator("[data-start-markdown-import]").click();

  await expect(page.locator("[data-import-receipt]")).toBeVisible();
  await expect(page.locator("[data-import-receipt-revision]")).toHaveText("revision_import_fixture");
  await expect(page.locator("[data-import-base-revision]")).toHaveText("revision_import_fixture");
  await expect(page.locator("[data-import-progress]")).toHaveAttribute("value", "100");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  const state = await (await request.get(`${origin}/_fixture/state`)).json();
  expect(state.start_calls).toBe(1);
  expect(state.commit_calls).toBe(1);
});

test("empty, path, UTF-8 and capacity conflicts stay before confirmation", async ({ page, request }) => {
  await reset(request, "fresh");
  await page.goto(`${origin}/research-notes`);
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-path-check]")).toContainText("Select at least one");

  await page.locator("[data-import-files]").setInputFiles(directory("bad-path"));
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-path-check]")).toHaveAttribute("data-check-state", "failed");

  await page.locator("[data-import-files]").setInputFiles(directory("bad-utf8"));
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-format-check]")).toHaveAttribute("data-check-state", "failed");

  await reset(request, "capacity");
  await page.reload();
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await page.locator("[data-import-files]").setInputFiles(directory("one"));
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-capacity-check]")).toHaveAttribute("data-check-state", "failed");
  await expect(page.locator("[data-start-markdown-import]")).toBeDisabled();
});

test("refresh and navigation recover the actor-owned checkpoint without duplicate start, then cancel", async ({ page, request }) => {
  await reset(request, "open");
  const resume = "#markdown-import=import_recovery&markdown-import-mind=research-notes";
  await page.goto(`${origin}/research-notes${resume}`);
  await expect(page.locator("[data-import-status]")).toContainText("recovered");
  await expect(page.locator("[data-cancel-markdown-import]")).toBeVisible();

  await page.reload();
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await expect(page.locator("[data-import-status]")).toContainText("recovered");
  await page.goto(`${origin}/help`);
  await page.goBack();
  await expect(page.locator("[data-import-status]")).toContainText("recovered");
  await page.locator("[data-cancel-markdown-import]").click();
  await expect(page.locator("[data-import-status]")).toContainText("current revision was unchanged");
  expect(page.url()).not.toContain("markdown-import=");
  const state = await (await request.get(`${origin}/_fixture/state`)).json();
  expect(state.start_calls).toBe(0);
  expect(state.session.state).toBe("canceled");
});

test("a durable validation checkpoint resumes to one receipt without a second start", async ({ page, request }) => {
  await reset(request, "validating");
  await page.goto(`${origin}/research-notes#markdown-import=import_recovery&markdown-import-mind=research-notes`);
  await expect(page.locator("[data-import-status]")).toContainText("validation can resume");
  await expect(page.locator("[data-import-progress]")).toBeVisible();
  await page.locator("[data-import-confirm]").check();
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-import-receipt-revision]")).toHaveText("revision_import_fixture");
  const state = await (await request.get(`${origin}/_fixture/state`)).json();
  expect(state.start_calls).toBe(0);
  expect(state.commit_calls).toBe(1);
});

test("a transient 503 keeps the exact locator and resumes safely after refresh", async ({ page, request }) => {
  await reset(request, "transient-once");
  const resume = "#markdown-import=import_recovery&markdown-import-mind=research-notes";
  await page.goto(`${origin}/research-notes${resume}`);
  await expect(page.locator("[data-import-status]")).toContainText("temporarily unavailable");
  await expect(page.locator("[data-retry-markdown-import-status]")).toBeVisible();
  await expect(page.locator("[data-import-files]")).toBeDisabled();
  expect(page.url()).toContain(resume);
  await expect(page.locator("body")).not.toContainText("private/redeploy/storage-shard");

  await page.reload();
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await expect(page.locator("[data-import-status]")).toContainText("validation can resume");
  await expect(page.locator("[data-retry-markdown-import-status]")).toBeHidden();
  expect(page.url()).toContain(resume);
  await page.locator("[data-import-confirm]").check();
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-import-receipt-revision]")).toHaveText("revision_import_fixture");
  expect(page.url()).not.toContain("markdown-import=");
  const state = await (await request.get(`${origin}/_fixture/state`)).json();
  expect(state.status_read_calls).toBeGreaterThanOrEqual(2);
  expect(state.start_calls).toBe(0);
  expect(state.commit_calls).toBe(1);
});

test("concurrent HEAD change requires a fresh plan before or during commit", async ({ page, request }) => {
  await reset(request, "head-plan");
  await page.goto(`${origin}/research-notes`);
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await page.locator("[data-import-files]").setInputFiles(directory("changed"));
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-replan-markdown-import]")).toBeVisible();
  await expect(page.locator("[data-import-status]")).toContainText("older revision");

  await reset(request, "head-commit");
  await page.reload();
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await page.locator("[data-import-files]").setInputFiles(directory("changed-again"));
  await page.locator("[data-plan-markdown-import]").click();
  await page.locator("[data-import-confirm]").check();
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-replan-markdown-import]")).toBeVisible();
  await expect(page.locator("[data-import-receipt]")).toBeHidden();
});

test("readers and revoked actors cannot see import controls or private operation data", async ({ page, request }) => {
  await reset(request, "fresh");
  await page.goto(`${origin}/reader`);
  await expect(page.locator("[data-markdown-import]")).toHaveCount(0);

  await reset(request, "open");
  await request.post(`${origin}/_fixture/revoke`);
  await page.goto(`${origin}/research-notes#markdown-import=import_recovery&markdown-import-mind=research-notes`);
  await expect(page.locator("[data-import-status]")).toContainText("unavailable to this account");
  await expect(page.locator("body")).not.toContainText("private/secret.md");
  await expect(page.locator("body")).not.toContainText("import_recovery");
  expect(page.url()).not.toContain("markdown-import=");
});

test("server failures are summarized without technical storage disclosure", async ({ page, request }) => {
  await reset(request, "server-error");
  await page.goto(`${origin}/research-notes`);
  if (!page.url().includes("#markdown-import=")) await page.locator("summary").filter({ hasText: /^Import Markdown$/ }).click();
  await page.locator("[data-import-files]").setInputFiles(directory("one"));
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-status]")).toContainText("could not finish");
  await expect(page.locator("body")).not.toContainText("d1/private/shard");
});
