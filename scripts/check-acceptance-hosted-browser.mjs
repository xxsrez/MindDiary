import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Dedicated CI test browser, never a connection to the user's browser/profile.
// The exact private test origin is fixed; no caller-selected URL or redirects.
const origin = "https://mind-diary-acceptance.example.invalid";
const token = process.env.MD_ACCEPTANCE_PLATFORM_TOKEN;
if (!token) throw new Error("missing_platform_token");
const browser = await chromium.launch({ headless: true });
try {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({
    extraHTTPHeaders: { "OAI-Sites-Authorization": `Bearer ${token}` },
    serviceWorkers: "block",
  })));
  for (const context of contexts) {
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== origin) await route.abort();
      else await route.continue();
    });
  }
  await contexts[0].addCookies([{ name: "md_capability_context", value: "first", url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
  assert.equal((await contexts[1].cookies(origin)).some((c) => c.name === "md_capability_context"), false);
  for (const context of contexts) {
    const page = await context.newPage();
    const response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
    assert.equal(response.status(), 200);
    assert.equal(new URL(page.url()).origin, origin);
    await page.getByRole("heading", { name: "Тестовая среда Mind Diary", exact: true }).waitFor();
  }
  assert.equal((await contexts[0].cookies(origin)).some((c) => c.name === "md_capability_context"), true);
  console.log(JSON.stringify({ schema: "mind-diary/acceptance-browser-capability/v1", status: "passed", isolated_contexts: 2, cross_context_cookie_absent: true, private_page_rendered: true, runner_sha: process.env.GITHUB_SHA ?? null }));
} finally {
  await browser.close();
}
