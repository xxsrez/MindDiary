import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";

// Playwright error messages can include callback URLs or show-once values.
// Publish the bounded phase only; never serialize assertion inputs or raw errors.
let phase = "configuration";
const diagnostics = [];
process.once("uncaughtException", error => {
  const kind = error.message?.includes("strict mode violation") ? "ambiguous_locator" : error.name === "TimeoutError" ? "timeout" : error.name === "AssertionError" ? "assertion" : "runtime";
  console.error(JSON.stringify({ status: "failed", phase, kind, diagnostics: diagnostics.slice(-12) })); process.exit(1);
});

const origin = "https://mind-diary-acceptance.example.invalid";
const platformToken = process.env.MD_ACCEPTANCE_PLATFORM_TOKEN;
const controllerKey = process.env.MD_ACCEPTANCE_CONTROLLER_KEY;
const clientId = process.env.MD_ACCEPTANCE_OAUTH_CLIENT_ID;
const expected = process.env.MD_ACCEPTANCE_EXPECTED_SHA;
if (!platformToken || !controllerKey || !clientId || !/^[a-f0-9]{40}$/.test(expected ?? "")) throw new Error("acceptance_configuration_missing");
const client = await new AcceptanceClient({ directory: await mkdtemp(join(tmpdir(), "md-browser-")), platformToken, controllerKey }).open();
if (/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) {
  client.state.runKey = `github:acceptance-browser:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
  await client.save();
}
const build = await (await client.request("/_acceptance/build")).json();
assert.equal(build.candidate_sha, expected);
const baseline = await client.control("/_acceptance/inventory");
assert.equal(baseline.complete, true);
const browser = await chromium.launch({ headless: true });
const contexts = [];
const callback = "http://127.0.0.1:1455/auth/callback";
let callbackUrl;
const formRequest = async (path, fields) => {
  const response = await fetch(origin + path, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(45000),
    headers: { "OAI-Sites-Authorization": `Bearer ${platformToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  let body; try { body = await response.clone().json(); } catch {}
  diagnostics.push({ path, status: response.status, ...(typeof body?.error === "string" && /^[a-z_]{1,80}$/.test(body.error) ? { code: body.error } : {}) });
  return response;
};
let verified = false;
try {
  const run = await client.setup();
  console.log(JSON.stringify({ phase: "run_created", run_id: run.run_id, candidate: expected }));
  phase = "bootstrap_forms";
  for (const actor of run.actors) {
    const context = await browser.newContext({ serviceWorkers: "block" }); contexts.push(context);
    context.setDefaultTimeout(30000);
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue({ headers: { ...route.request().headers(), "OAI-Sites-Authorization": `Bearer ${platformToken}`,
        ...(url.pathname.startsWith("/api/mcp") ? { "x-md-acceptance-run": run.run_id } : {}) } });
      if (url.origin + url.pathname === callback) {
        callbackUrl = url;
        return route.fulfill({ status: 200, contentType: "text/plain", body: "Callback received by isolated acceptance runner" });
      }
      return route.abort();
    });
    const cookie = await client.session(actor.actor_id);
    const split = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin, secure: true, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    page.on("response", async response => {
      const url = new URL(response.url());
      if (url.origin !== origin || !["/api/v1/account", "/api/v1/mcp-tokens", "/api/v1/session", "/api/mcp", "/api/mcp/2025-11-25"].includes(url.pathname)) return;
      let body; try { body = await response.json(); } catch {}
      const code = body?.error?.code ?? body?.result?.structuredContent?.error?.code;
      diagnostics.push({ path: url.pathname, status: response.status(), ...(typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? { code } : {}) });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const created = page.waitForResponse(r => r.url() === origin + "/api/v1/account" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Create isolated account", exact: true }).click();
    assert.equal((await created).status(), 200);
    await page.waitForURL(origin + "/");
  }
  // A fresh context has no product session, even though the platform route is reachable.
  const firstCookies = await contexts[0].cookies(origin);
  const secondCookies = await contexts[1].cookies(origin);
  assert.notEqual(firstCookies.find(c => c.name === "__Host-md-acceptance").value, secondCookies.find(c => c.name === "__Host-md-acceptance").value);
  const page = contexts[0].pages()[0];
  phase = "token_forms";
  for (const configure of [false, true]) {
    await page.goto(origin + "/settings/connections", { waitUntil: "domcontentloaded" });
    await page.getByRole("main").getByRole("link", { name: "Advanced MCP", exact: true }).click();
    const form = page.locator("[data-token-form]");
    await form.waitFor();
    assert.equal(await form.locator('[name="personal_configure"]').isChecked(), false);
    await form.getByLabel("Token name", { exact: true }).fill(configure ? "Synthetic configure" : "Synthetic read");
    if (configure) await form.locator('[name="personal_configure"]').check();
    const issued = page.waitForResponse(r => r.url() === origin + "/api/v1/mcp-tokens" && r.request().method() === "POST");
    await form.getByRole("button", { name: "Create token", exact: true }).click();
    const response = await issued; assert.equal(response.status(), 200);
    const body = await response.json();
    phase = "token_scope_readback";
    assert.equal(body.data.token.scopes.includes("personal:configure"), configure);
    phase = "token_secret_dialog";
    await page.locator("[data-secret-dialog][open]").waitFor();
    phase = "token_self_check";
    // The product starts this check automatically when the token is revealed.
    await page.locator('[data-mcp-self-check][data-diagnostic-state="passed"], [data-mcp-self-check][data-diagnostic-state="failed"]').waitFor();
    const diagnostic = await page.locator('[data-mcp-self-check]').getAttribute('data-diagnostic-state');
    console.log(JSON.stringify({ phase, diagnostic }));
    assert.equal(diagnostic, "passed");
    phase = "token_secret_close";
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.getByRole("button", { name: "Close permanently", exact: true }).click()]);
    assert.doesNotMatch(await page.locator("[data-secret-value]").textContent(), /mdp_v1_/);
  }
  const verifier = randomBytes(32).toString("base64url");
  phase = "oauth_consent";
  const state = randomBytes(24).toString("base64url");
  const authorize = new URL(origin + "/oauth/authorize");
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", resource: origin + "/api/mcp", scope: "content:read personal:configure", state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  await page.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForURL(callback + "?**");
  phase = "oauth_callback_state";
  assert.equal(callbackUrl.searchParams.get("state"), state);
  const exchange = { grant_type: "authorization_code", client_id: clientId, redirect_uri: callback, resource: origin + "/api/mcp", code: callbackUrl.searchParams.get("code"), code_verifier: verifier };
  phase = "oauth_code_exchange";
  const issued = await formRequest("/oauth/token", exchange); assert.equal(issued.status, 200);
  phase = "oauth_tokens";
  const tokens = await issued.json();
  assert.equal(tokens.scope.split(" ").includes("personal:configure"), true);
  await client.mcp(tokens.access_token, "list_minds");
  assert.equal((await formRequest("/oauth/token", exchange)).status, 400);
  const refreshed = await formRequest("/oauth/token", { grant_type: "refresh_token", client_id: clientId, resource: origin + "/api/mcp", refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json(); assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  await client.mcp(rotated.access_token, "list_minds");
  assert.equal((await formRequest("/oauth/revoke", { client_id: clientId, token: rotated.refresh_token, token_type_hint: "refresh_token" })).status, 200);
  await assert.rejects(client.mcp(rotated.access_token, "list_minds"), /mcp_http_401/);
  verified = true;
} finally {
  await browser.close();
  const cleanup = await client.cleanup();
  assert.equal(cleanup.state, "cleaned");
  const final = await client.control("/_acceptance/inventory");
  if (JSON.stringify(final) !== JSON.stringify(baseline)) console.error(JSON.stringify({ phase: "cleanup_inventory", baseline, final }));
  assert.deepEqual(final, baseline);
  console.log(JSON.stringify({ schema: "mind-diary/acceptance-product-browser/v1", status: verified ? "passed" : "failed", candidate: expected, runner_sha: process.env.GITHUB_SHA, contexts: contexts.length,
    bootstrap_forms: verified, token_opt_in_forms: verified, modern_compat_self_check: verified, oauth_pkce_consent_rotation_revoke: verified, cleanup: "baseline_restored" }));
}
