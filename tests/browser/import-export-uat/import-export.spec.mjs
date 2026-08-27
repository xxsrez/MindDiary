import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const fixtureServer = resolve(import.meta.dirname, "fixture-server.mjs");
const fixtureRoot = process.env.MIND_DIARY_MD363_FIXTURE_ROOT;
if (typeof fixtureRoot !== "string") throw new Error("MD-363 fixture root is required");
const port = 4363;
const origin = `http://127.0.0.1:${port}`;
let child;

function acceptance(id, title, body) {
  test(`[${id}] ${title}`, {
    annotation: { type: "mind-diary-assertion", description: id },
  }, async ({ page, request, browser, context }) =>
    test.step(`matrix=${id}`, () => body({ page, request, browser, context })));
}

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MD-363 fixture exited: ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/_fixture/health`, { cache: "no-store" })).ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("MD-363 fixture health check timed out");
}

async function reset(request, scenario = "fresh") {
  const response = await request.post(`${origin}/_fixture/reset?scenario=${encodeURIComponent(scenario)}`);
  expect(response.ok()).toBeTruthy();
}

async function state(request) {
  return (await request.get(`${origin}/_fixture/state`)).json();
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function selectImportFolder(page) {
  await page.locator("[data-import-files]").setInputFiles(resolve(fixtureRoot, "import"));
}

async function reviewAndConfirm(page) {
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-path-check]")).toHaveAttribute("data-check-state", "passed");
  await expect(page.locator("[data-import-format-check]")).toHaveAttribute("data-check-state", "passed");
  await expect(page.locator("[data-import-capacity-check]")).toHaveAttribute("data-check-state", "passed");
  await page.locator("[data-import-confirm]").check();
}

async function injectRelativeFiles(page, files) {
  await page.locator("[data-import-files]").evaluate((input, definitions) => {
    const transfer = new DataTransfer();
    for (const definition of definitions) {
      const file = new File([new TextEncoder().encode(definition.text)], definition.name, {
        type: "text/markdown",
      });
      Object.defineProperty(file, "webkitRelativePath", { value: definition.relativePath });
      transfer.items.add(file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, files);
}

async function injectDiskFile(page, path, { name, relativePath }) {
  const bytes = await readFile(path);
  await page.locator("[data-import-files]").evaluate((input, definition) => {
    const transfer = new DataTransfer();
    const file = new File([Uint8Array.from(definition.bytes)], definition.name, {
      type: "application/octet-stream",
    });
    Object.defineProperty(file, "webkitRelativePath", { value: definition.relativePath });
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { bytes: [...bytes], name, relativePath });
}

async function injectSizedFile(page, size) {
  await page.locator("[data-import-files]").evaluate((input, fileSize) => {
    const transfer = new DataTransfer();
    const file = new File([new Uint8Array(fileSize).fill(0x61)], "size-plus-one.md", {
      type: "text/markdown",
    });
    Object.defineProperty(file, "webkitRelativePath", { value: "snapshot/size-plus-one.md" });
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, size);
}

async function ready(page) {
  await expect(page.locator("[data-export-job-state]")).toHaveText("Ready");
  await expect(page.locator("[data-export-receipt]")).toBeVisible();
}

async function verifiedDownload(page) {
  const expectedSize = Number((await page.locator("[data-export-receipt-size]").textContent()).replace(/[^0-9]/gu, ""));
  const expectedSha256 = await page.locator("[data-export-receipt-sha]").textContent();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Verify and save archive" }).click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  expect(bytes.byteLength).toBe(expectedSize);
  expect(sha256(bytes)).toBe(expectedSha256);
  await expect(page.locator("[data-export-download-status]")).toContainText("Verified");
  return bytes;
}

function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(
      bytes.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      bytes.subarray(dataStart, dataStart + size),
    );
    offset = dataStart + size;
  }
  return entries;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  child = spawn(process.execPath, [fixtureServer], {
    cwd: root,
    env: { ...process.env, MIND_DIARY_MD363_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFixture();
});

test.afterAll(async () => {
  if (child?.exitCode === null) child.kill("SIGTERM");
});

acceptance("IE-FIXTURE-01", "generated bytes and boundaries are pinned before browser work", async ({ request }) => {
  const remote = await (await request.get(`${origin}/_fixture/manifest`)).json();
  const local = JSON.parse(await readFile(resolve(fixtureRoot, "fixture-manifest.json"), "utf8"));
  expect(remote).toEqual(local);
  expect(remote.known_opaque_bytes_hex).toBe("00017f80ff4d443336330a");
  expect(remote.size_plus_one_bytes).toBe(1_048_577);
  expect(remote.files.find((file) => file.id === "known-opaque").sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
});

acceptance("IE-IMPORT-01", "plan and confirmation publish exactly one immutable revision", async ({ page, request }) => {
  await reset(request);
  await page.goto(`${origin}/transfer-matrix`);
  await selectImportFolder(page);
  await reviewAndConfirm(page);
  await expect(page.locator("[data-import-additions]")).toHaveText("1");
  await expect(page.locator("[data-import-replacements]")).toHaveText("1");
  await expect(page.locator("[data-import-deletions]")).toHaveText("1");
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-import-receipt-revision]")).toHaveText("revision_md363_import_3");
  const observed = await state(request);
  expect(observed.current_head).toBe("revision_md363_import_3");
  expect(observed.revision_count).toBe(3);
  expect(observed.start_attempts).toHaveLength(1);
  expect(observed.session.state).toBe("committed");
});

acceptance("IE-IMPORT-02", "invalid profile, duplicate path and invalid UTF-8 fail before staging", async ({ page, request }) => {
  await reset(request);
  await page.goto(`${origin}/transfer-matrix`);
  await injectRelativeFiles(page, [
    { name: "same-a.md", relativePath: "snapshot/same.md", text: "# A\n" },
    { name: "same-b.md", relativePath: "snapshot/same.md", text: "# B\n" },
  ]);
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-path-check]")).toHaveAttribute("data-check-state", "failed");

  await injectDiskFile(page, resolve(fixtureRoot, "invalid/notes.txt"), {
    name: "notes.txt",
    relativePath: "snapshot/notes.txt",
  });
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-path-check]")).toHaveAttribute("data-check-state", "failed");

  await injectDiskFile(page, resolve(fixtureRoot, "invalid/broken.md"), {
    name: "broken.md",
    relativePath: "snapshot/broken.md",
  });
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-format-check]")).toHaveAttribute("data-check-state", "failed");
  expect((await state(request)).revision_count).toBe(2);
  expect((await state(request)).start_attempts).toHaveLength(0);
});

acceptance("IE-IMPORT-03", "accepted size plus one and quota denial create no session", async ({ page, request }) => {
  await reset(request);
  await page.goto(`${origin}/transfer-matrix`);
  await injectSizedFile(page, 1_048_577);
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-capacity-check]")).toHaveAttribute("data-check-state", "failed");
  expect((await state(request)).start_attempts).toHaveLength(0);

  await reset(request, "quota");
  await page.reload();
  await selectImportFolder(page);
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-import-capacity-check]")).toHaveAttribute("data-check-state", "failed");
  await expect(page.locator("[data-start-markdown-import]")).toBeDisabled();
  expect((await state(request)).revision_count).toBe(2);
});

acceptance("IE-IMPORT-04", "unknown start and interrupted validation resume with exact idempotency", async ({ page, request }) => {
  await reset(request, "unknown-start");
  await page.goto(`${origin}/transfer-matrix`);
  await selectImportFolder(page);
  await reviewAndConfirm(page);
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-import-status]")).toContainText("could not finish");
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-import-receipt-revision]")).toHaveText("revision_md363_import_3");
  let observed = await state(request);
  expect(observed.start_attempts).toHaveLength(2);
  expect(new Set(observed.start_attempts.map((attempt) => attempt.key)).size).toBe(1);
  expect(observed.revision_count).toBe(3);

  await reset(request, "interrupt");
  await page.goto(`${origin}/transfer-matrix`);
  await selectImportFolder(page);
  await reviewAndConfirm(page);
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-import-status]")).toContainText("could not finish");
  expect(page.url()).toContain("markdown-import=import_md363");
  await page.reload();
  await expect(page.locator("[data-import-status]")).toContainText("recovered");
  await selectImportFolder(page);
  await page.locator("[data-plan-markdown-import]").click();
  await page.locator("[data-import-confirm]").check();
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-import-receipt-revision]")).toHaveText("revision_md363_import_3");
  observed = await state(request);
  expect(observed.start_attempts).toHaveLength(1);
  expect(observed.revision_count).toBe(3);
});

acceptance("IE-IMPORT-05", "cancel after interruption preserves HEAD and removes staged bytes", async ({ page, request }) => {
  await reset(request, "cancel");
  await page.goto(`${origin}/transfer-matrix`);
  await selectImportFolder(page);
  await reviewAndConfirm(page);
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-cancel-markdown-import]")).toBeVisible();
  await page.locator("[data-cancel-markdown-import]").click();
  await expect(page.locator("[data-import-status]")).toContainText("current revision was unchanged");
  const observed = await state(request);
  expect(observed.current_head).toBe("revision_md363_head_2");
  expect(observed.revision_count).toBe(2);
  expect(observed.session.state).toBe("canceled");
  expect(observed.session.staged_file_count).toBe(0);
});

acceptance("IE-IMPORT-06", "HEAD conflicts require replan before and during commit", async ({ page, request }) => {
  await reset(request, "head-plan");
  await page.goto(`${origin}/transfer-matrix`);
  await selectImportFolder(page);
  await page.locator("[data-plan-markdown-import]").click();
  await expect(page.locator("[data-replan-markdown-import]")).toBeVisible();
  expect((await state(request)).revision_count).toBe(2);

  await reset(request, "head-commit");
  await page.reload();
  await selectImportFolder(page);
  await reviewAndConfirm(page);
  await page.locator("[data-start-markdown-import]").click();
  await expect(page.locator("[data-replan-markdown-import]")).toBeVisible();
  await expect(page.locator("[data-import-receipt]")).toBeHidden();
  const observed = await state(request);
  expect(observed.current_head).toBe("revision_md363_head_2");
  expect(observed.revision_count).toBe(2);
});

acceptance("IE-HISTORY-01", "prior history and non-conflicting opaque bytes survive import", async ({ request }) => {
  await reset(request, "imported");
  const observed = await state(request);
  expect(observed.revision_count).toBe(3);
  const historical = observed.revisions.find((value) => value.revision_id === "revision_md363_history_1");
  const baseline = observed.revisions.find((value) => value.revision_id === "revision_md363_head_2");
  const imported = observed.revisions.find((value) => value.revision_id === "revision_md363_import_3");
  expect(historical.files.map((file) => file.path)).toEqual(["index.md"]);
  const beforeOpaque = baseline.files.find((file) => file.path === "assets/known.bin");
  const afterOpaque = imported.files.find((file) => file.path === "assets/known.bin");
  expect(afterOpaque).toEqual(beforeOpaque);
});

acceptance("IE-EXPORT-01", "current exact revision downloads the independently verified archive", async ({ page, request }) => {
  await reset(request, "imported");
  await page.goto(`${origin}/transfer-matrix`);
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);
  const bytes = await verifiedDownload(page);
  const observed = await state(request);
  expect(observed.jobs).toHaveLength(1);
  expect(observed.jobs[0]).toMatchObject({ revision_id: "revision_md363_import_3", profile: "MD-BUNDLE-ZIP-1" });
  expect(observed.jobs[0].size).toBe(bytes.byteLength);
  expect(observed.jobs[0].sha256).toBe(sha256(bytes));
});

acceptance("IE-EXPORT-02", "historical Markdown-only revision stays exact after HEAD movement", async ({ page, request }) => {
  await reset(request, "imported");
  await page.goto(`${origin}/transfer-matrix`);
  await page.getByLabel("Exact historical revision").check();
  await page.getByLabel("Historical revision ID").fill("revision_md363_history_1");
  await page.getByLabel("Archive content").selectOption("MD-OKF-ZIP-1");
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);
  const bytes = await verifiedDownload(page);
  const observed = await state(request);
  expect(observed.current_head).toBe("revision_md363_import_3");
  expect(observed.jobs[0]).toMatchObject({ revision_id: "revision_md363_history_1", profile: "MD-OKF-ZIP-1" });
  expect(observed.jobs[0].sha256).toBe(sha256(bytes));
});

acceptance("IE-EXPORT-03", "mixed revision requires bundle and preserves known opaque bytes", async ({ page, request }) => {
  await reset(request, "imported");
  await page.goto(`${origin}/transfer-matrix`);
  await page.getByLabel("Exact historical revision").check();
  await page.getByLabel("Historical revision ID").fill("revision_md363_head_2");
  await page.getByLabel("Archive content").selectOption("MD-OKF-ZIP-1");
  await page.getByRole("button", { name: "Start export" }).click();
  await expect(page.locator("[data-export-status]")).toContainText("contains attachments");
  await expect(page.getByLabel("Archive content")).toHaveValue("MD-BUNDLE-ZIP-1");
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);
  const bytes = await verifiedDownload(page);
  const entries = zipEntries(bytes);
  expect(entries.get("assets/known.bin").toString("hex")).toBe("00017f80ff4d443336330a");
  expect(entries.has(".mind-diary/manifest.json")).toBeTruthy();
  const observed = await state(request);
  expect(observed.jobs[0]).toMatchObject({ revision_id: "revision_md363_head_2", profile: "MD-BUNDLE-ZIP-1" });
});

acceptance("IE-ACCESS-01", "expired, revoked and visibility-tightened grants fail closed", async ({ page, request }) => {
  for (const scenario of ["export-expired", "export-revoked", "export-tightened"]) {
    await reset(request, "imported");
    await page.goto(`${origin}/transfer-matrix`);
    await page.getByRole("button", { name: "Start export" }).click();
    await ready(page);
    const transition = await request.post(
      `${origin}/_fixture/set-scenario?scenario=${encodeURIComponent(scenario)}`,
    );
    expect(transition.ok()).toBeTruthy();
    await page.getByRole("button", { name: "Verify and save archive" }).click();
    await expect(page.locator("[data-export-download-status]")).toContainText("not saved");
    await expect(page.locator("[data-export-download-status]")).toContainText("unavailable");
    expect((await state(request)).downloads).toHaveLength(0);
  }
});

acceptance("IE-CLEANUP-01", "run cleanup closes operations, removes grants and proves absence", async ({ page, request }) => {
  await reset(request, "imported");
  await page.goto(`${origin}/transfer-matrix`);
  await page.getByRole("button", { name: "Start export" }).click();
  await ready(page);
  const cleanupResponse = await request.delete(`${origin}/_fixture/cleanup`);
  expect(cleanupResponse.ok()).toBeTruthy();
  const observed = await state(request);
  expect(observed.cleanup).toEqual({
    requested: true,
    sessions_closed: true,
    grants_removed: true,
    mind_absent: true,
  });
  expect(observed.mind_present).toBe(false);
  expect(observed.jobs).toHaveLength(0);
  expect(observed.grants).toBe(0);
  expect((await request.get(`${origin}/transfer-matrix`)).status()).toBe(404);
});
