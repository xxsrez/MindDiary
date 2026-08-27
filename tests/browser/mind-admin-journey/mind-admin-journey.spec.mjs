import { createServer } from "node:http";

import { expect, test } from "@playwright/test";

import { createSyntheticBrowserComposition } from "../../../scripts/lib/synthetic-browser-composition.mjs";

const ASSERTIONS = Object.freeze([
  "admin.personal-projection",
  "admin.create-private-run-owned",
  "admin.metadata-update-clear",
  "admin.metadata-two-context-conflict",
  "admin.visibility-warning-unlisted",
  "admin.visibility-public-catalog",
  "admin.visibility-private-nondisclosure",
  "admin.role-projections",
  "admin.persistence-reconstruction",
  "admin.personal-invariants",
  "admin.deletion-impact-confirmation",
  "admin.cleanup-absence-readback",
]);

const nonce = process.env.MIND_DIARY_MD351_RUN_NONCE;
if (typeof nonce !== "string" || !/^[a-f0-9]{12}$/u.test(nonce)) {
  throw new Error("MD-351 requires a bounded run nonce");
}

const handle = `md351-${nonce}`;
const ownerEmail = `md351-owner-${nonce}@example.invalid`;
const participantEmail = `md351-participant-${nonce}@example.invalid`;
let composition;
let owner;
let participant;
let ownerOrigin;
let participantOrigin;
const proxies = [];

async function readBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function proxyFor(context) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readBody(incoming);
      const headers = { ...incoming.headers };
      delete headers.host;
      delete headers["content-length"];
      const result = await context.request(incoming.url ?? "/", {
        method: incoming.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      });
      outgoing.statusCode = result.status;
      result.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "content-encoding") outgoing.setHeader(name, value);
      });
      outgoing.end(result.text);
    } catch {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json; charset=utf-8");
      outgoing.end(JSON.stringify({ ok: false, error: { code: "browser_proxy_failure" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  proxies.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function register(page, origin, displayName) {
  await page.goto(`${origin}/`);
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Create isolated account" }).click();
  await expect(page).toHaveURL(`${origin}/me`);
}

async function browserApi(page, path, options = {}) {
  return page.evaluate(async ({ path, options }) => {
    const headers = { accept: "application/json", ...(options.headers ?? {}) };
    if (options.method && !["GET", "HEAD"].includes(options.method)) {
      headers["content-type"] = "application/json";
      headers["x-csrf-token"] = document.querySelector('meta[name="mind-diary-csrf-token"]')?.content ?? "";
      headers["idempotency-key"] = options.idempotencyKey ?? crypto.randomUUID();
    }
    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    return { status: response.status, payload };
  }, { path, options });
}

test.beforeAll(async () => {
  composition = await createSyntheticBrowserComposition();
  owner = composition.createContext({
    name: "md351-owner",
    identity: { kind: "authenticated", verifiedEmail: ownerEmail, verifiedFullName: "MD 351 Owner" },
  });
  participant = composition.createContext({
    name: "md351-participant",
    identity: { kind: "authenticated", verifiedEmail: participantEmail, verifiedFullName: "MD 351 Participant" },
  });
  await Promise.all([owner.ready(), participant.ready()]);
  [ownerOrigin, participantOrigin] = await Promise.all([proxyFor(owner), proxyFor(participant)]);
});

test.afterAll(async () => {
  await Promise.all(proxies.splice(0).map(closeServer));
  await composition?.close();
});

test("complete ordinary and Personal Mind admin journey", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const assertion of ASSERTIONS) {
    test.info().annotations.push({ type: "mind-diary-assertion", description: assertion });
  }
  const ownerContext = await browser.newContext();
  const participantContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const stalePage = await ownerContext.newPage();
  const participantPage = await participantContext.newPage();
  try {
    await test.step("route=/me actor=owner assertion=admin.personal-projection", async () => {
      await register(ownerPage, ownerOrigin, "MD 351 Owner");
      await ownerPage.goto(`${ownerOrigin}/minds`);
      await expect(ownerPage.locator("[data-minds-list] [data-mind-card]").first()).toHaveAttribute("data-mind-card", "me");
      await expect(ownerPage.locator("[data-personal-mind]")).toContainText("Private, always");
      await expect(ownerPage.locator("[data-personal-mind]")).toContainText("no separate rename");
      await ownerPage.goto(`${ownerOrigin}/me`);
      await expect(ownerPage.locator("[data-rename-mind-form], [data-owner-visibility-controls], [data-owner-delete-controls]")).toHaveCount(0);
    });

    await test.step(`route=/${handle} actor=owner assertion=admin.create-private-run-owned`, async () => {
      await ownerPage.goto(`${ownerOrigin}/minds`);
      await ownerPage.getByRole("button", { name: "Create a Mind" }).first().click();
      await ownerPage.getByLabel("Mind name").fill("MD 351 Run Mind");
      await ownerPage.getByLabel("Web address").fill(handle);
      await ownerPage.getByLabel("Description (optional)").fill("Run-owned browser evidence.");
      await ownerPage.getByRole("button", { name: "Create Mind" }).click();
      await expect(ownerPage).toHaveURL(`${ownerOrigin}/${handle}`);
      await expect(ownerPage.locator("[data-route-visibility]")).toHaveText("Private");
      await register(participantPage, participantOrigin, "MD 351 Participant");
      const hidden = await browserApi(participantPage, `/api/v1/minds/${handle}`);
      expect(hidden.status).toBe(404);
      expect(JSON.stringify(hidden.payload)).not.toContain("Run-owned browser evidence");
    });

    await test.step(`route=/${handle} actor=owner-two-context assertion=admin.metadata-two-context-conflict`, async () => {
      await stalePage.goto(`${ownerOrigin}/${handle}`);
      await ownerPage.getByLabel("Mind name").fill("MD 351 Renamed Mind");
      await ownerPage.getByLabel("Description (optional)").fill("Updated run-owned description.");
      await ownerPage.getByRole("button", { name: "Save metadata" }).click();
      await expect(ownerPage.locator("[data-route-mind-name]")).toHaveText("MD 351 Renamed Mind");
      await stalePage.getByLabel("Mind name").fill("Stale overwrite");
      await stalePage.getByRole("button", { name: "Save metadata" }).click();
      await expect(stalePage.locator("[data-rename-status]")).toContainText("changed in another session");
      await stalePage.getByRole("button", { name: "Reload current settings" }).click();
      await expect(stalePage.locator("[data-route-mind-name]")).toHaveText("MD 351 Renamed Mind");
    });

    await test.step(`route=/${handle} actor=owner assertion=admin.metadata-update-clear`, async () => {
      await ownerPage.getByLabel("Description (optional)").fill("");
      await ownerPage.getByRole("button", { name: "Save metadata" }).click();
      await expect(ownerPage.locator("[data-route-description]")).toHaveText("No description yet.");
    });

    await test.step(`route=/${handle} actor=owner assertion=admin.visibility-warning-unlisted`, async () => {
      const form = ownerPage.locator("[data-visibility-form]");
      await form.locator("[data-visibility-selector]").selectOption("unlisted");
      await expect(form.locator("[data-visibility-exposure]")).toBeVisible();
      await expect(form.locator("[data-save-visibility]")).toBeDisabled();
      await form.locator("[data-visibility-ack]").check();
      await form.locator("[data-save-visibility]").click();
      await expect(ownerPage.locator("[data-route-visibility]")).toHaveText("Unlisted");
      await participantPage.goto(`${participantOrigin}/${handle}`);
      await expect(participantPage.locator("[data-route-role]")).toHaveText("Reader");
      await participantPage.goto(`${participantOrigin}/public`);
      await expect(participantPage.locator("body")).not.toContainText("MD 351 Renamed Mind");
    });

    await test.step(`route=/public actor=participant assertion=admin.visibility-public-catalog`, async () => {
      await ownerPage.goto(`${ownerOrigin}/${handle}`);
      const form = ownerPage.locator("[data-visibility-form]");
      await form.locator("[data-visibility-selector]").selectOption("public");
      await form.locator("[data-save-visibility]").click();
      await expect(ownerPage.locator("[data-route-visibility]")).toHaveText("Public");
      await participantPage.goto(`${participantOrigin}/public`);
      await expect(participantPage.getByRole("heading", { level: 1, name: "Public Minds" })).toBeVisible();
      await expect(participantPage.locator("[data-public-mind-card]").filter({ hasText: "MD 351 Renamed Mind" })).toHaveCount(1);
    });

    await test.step(`route=/${handle} actor=owner-and-participant assertion=admin.visibility-private-nondisclosure`, async () => {
      const form = ownerPage.locator("[data-visibility-form]");
      await form.locator("[data-visibility-selector]").selectOption("private");
      await expect(form.locator("[data-visibility-private]")).toContainText("future access");
      await form.locator("[data-save-visibility]").click();
      await expect(ownerPage.locator("[data-route-visibility]")).toHaveText("Private");
      await participantPage.goto(`${participantOrigin}/public`);
      await expect(participantPage.locator("body")).not.toContainText("MD 351 Renamed Mind");
      const hidden = await browserApi(participantPage, `/api/v1/minds/${handle}`);
      expect(hidden.status).toBe(404);
      expect(JSON.stringify(hidden.payload)).not.toContain("MD 351 Renamed Mind");
    });

    await test.step(`route=/${handle} actor=owner-and-participant assertion=admin.role-projections`, async () => {
      await ownerPage.goto(`${ownerOrigin}/${handle}`);
      const invitation = ownerPage.locator("[data-invitation-form]");
      await invitation.getByLabel("Exact verified email").fill(participantEmail);
      await invitation.getByLabel("Role after acceptance").selectOption("reader");
      await Promise.all([
        ownerPage.waitForNavigation(),
        invitation.getByRole("button", { name: "Send in-app invitation" }).click(),
      ]);
      await participantPage.goto(`${participantOrigin}/invitations`);
      await Promise.all([
        participantPage.waitForNavigation(),
        participantPage.getByRole("button", { name: "Accept" }).click(),
      ]);
      await participantPage.goto(`${participantOrigin}/${handle}`);
      await expect(participantPage.locator("[data-route-role]")).toHaveText("Reader");
      await expect(participantPage.locator("[data-rename-mind-form], [data-owner-delete-controls]")).toHaveCount(0);
      await ownerPage.reload();
      const member = ownerPage.locator("[data-member-card]").filter({ hasText: "MD 351 Participant" });
      await member.getByLabel("Role").selectOption("admin");
      await Promise.all([
        ownerPage.waitForNavigation(),
        member.getByRole("button", { name: "Update role" }).click(),
      ]);
      await participantPage.reload();
      await expect(participantPage.locator("[data-route-role]")).toHaveText("Admin");
      await expect(participantPage.locator("[data-rename-mind-form]")).toBeVisible();
      await expect(participantPage.locator("[data-owner-delete-controls], [data-owner-visibility-controls]")).toHaveCount(0);
    });

    await test.step(`route=/${handle} actor=owner-and-participant assertion=admin.persistence-reconstruction`, async () => {
      await composition.restart();
      await ownerPage.reload();
      await participantPage.reload();
      await expect(ownerPage.locator("[data-route-mind-name]")).toHaveText("MD 351 Renamed Mind");
      await expect(ownerPage.locator("[data-route-description]")).toHaveText("No description yet.");
      await expect(ownerPage.locator("[data-route-visibility]")).toHaveText("Private");
      await expect(ownerPage.locator("[data-route-role]")).toHaveText("Owner");
      await expect(participantPage.locator("[data-route-role]")).toHaveText("Admin");
    });

    await test.step("route=/me actor=owner-and-participant assertion=admin.personal-invariants", async () => {
      await ownerPage.goto(`${ownerOrigin}/me`);
      await expect(ownerPage.locator("[data-rename-mind-form], [data-owner-visibility-controls], [data-owner-delete-controls]")).toHaveCount(0);
      const forbiddenMetadata = await browserApi(ownerPage, "/api/v1/minds/me", {
        method: "PATCH",
        body: { name: "Forbidden", description: "Forbidden", expected_metadata_version: 1 },
      });
      expect(forbiddenMetadata.status).toBe(403);
      expect(forbiddenMetadata.payload?.error?.code).toBe("personal_mind_operation_forbidden");
      await participantPage.goto(`${participantOrigin}/minds`);
      await expect(participantPage.locator("[data-mind-card=me]")).toContainText("MD 351 Participant");
      await expect(participantPage.locator("[data-minds-list]")).not.toContainText("MD 351 Owner");
    });

    await test.step(`route=/${handle} actor=owner assertion=admin.deletion-impact-confirmation`, async () => {
      await ownerPage.goto(`${ownerOrigin}/${handle}`);
      await ownerPage.getByRole("button", { name: "Review deletion impact" }).click();
      await expect(ownerPage.locator("[data-impact-revisions]")).toHaveText(/^[1-9][0-9]*$/u);
      await expect(ownerPage.locator("[data-impact-members]")).toHaveText("2");
      await ownerPage.getByLabel("Confirmation phrase").fill(`delete-mind:${handle}`);
      await ownerPage.getByLabel(/recovery is unavailable/u).check();
      await ownerPage.getByRole("button", { name: "Delete Mind permanently" }).click();
      await expect(ownerPage).toHaveURL(`${ownerOrigin}/minds`);
    });

    await test.step(`route=/${handle} actor=owner-and-participant assertion=admin.cleanup-absence-readback`, async () => {
      await expect(ownerPage.locator(`[data-mind-card="${handle}"]`)).toHaveCount(0);
      const ownerAbsent = await browserApi(ownerPage, `/api/v1/minds/${handle}`);
      const participantAbsent = await browserApi(participantPage, `/api/v1/minds/${handle}`);
      expect(ownerAbsent.status).toBe(404);
      expect(participantAbsent.status).toBe(404);
      expect(JSON.stringify([ownerAbsent.payload, participantAbsent.payload])).not.toContain("MD 351 Renamed Mind");
    });
  } finally {
    await Promise.all([ownerContext.close(), participantContext.close()]);
  }
});
