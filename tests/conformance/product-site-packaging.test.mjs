import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const app = resolve(root, "apps/mind-diary-site");

test("product Site packaging binds only the created project and durable resources", async () => {
  const hosting = JSON.parse(await readFile(resolve(app, ".openai/hosting.json"), "utf8"));
  assert.deepEqual(hosting, {
    project_id: "appgprj_example1428fe59b5d8381c",
    d1: "DB",
    r2: "MIND_DIARY_BUCKET",
  });
  await stat(resolve(app, "worker/index.ts"));
  await stat(resolve(app, "drizzle/0000_product_site.sql"));
  await stat(resolve(app, "package-lock.json"));
});

test("runtime package is product composition, not capability probe or fallback", async () => {
  const sources = await Promise.all([
    readFile(resolve(app, "worker/index.ts"), "utf8"),
    readFile(resolve(app, "worker/runtime-config.ts"), "utf8"),
    readFile(resolve(root, "packages/composition-root/src/product-site.ts"), "utf8"),
  ]);
  const joined = sources.join("\n");
  assert.match(joined, /createProductSiteRuntime/);
  assert.match(joined, /MIND_DIARY_TOKEN_VERIFIER_KEY/);
  assert.doesNotMatch(joined, /sites-probe|PROBE_BUCKET|AgentCore|DynamoDB|S3Client|OpenSearch/);
  assert.doesNotMatch(await readFile(resolve(app, ".openai/hosting.json"), "utf8"), /VERIFIER|SECRET|TOKEN/);
});

test("product composition routes the Sites-safe modern and versioned Codex MCP endpoints", async () => {
  const [mcp, composition, tokenUi] = await Promise.all([
    readFile(resolve(root, "packages/adapter-mcp/src/index.ts"), "utf8"),
    readFile(resolve(root, "packages/composition-root/src/product-site.ts"), "utf8"),
    readFile(resolve(root, "packages/adapter-web/src/token-management.ts"), "utf8"),
  ]);
  assert.match(mcp, /MCP_ENDPOINT = "\/api\/mcp"/u);
  assert.match(mcp, /MCP_LEGACY_CODEX_ENDPOINT = "\/api\/mcp\/2025-11-25"/u);
  assert.match(mcp, /MCP_RETIRED_SITES_ENDPOINT = "\/mcp"/u);
  assert.match(composition, /path === MCP_ENDPOINT/u);
  assert.match(composition, /path === MCP_LEGACY_CODEX_ENDPOINT/u);
  assert.match(composition, /path === MCP_RETIRED_SITES_ENDPOINT/u);
  assert.match(tokenUi, /\/api\/mcp\/2025-11-25/u);
});

test("product Worker owns the operable UI and scopes the one-time Bearer to MCP self-check", async () => {
  const [http, assets, composition] = await Promise.all([
    readFile(resolve(root, "packages/adapter-web/src/product-http.ts"), "utf8"),
    readFile(resolve(root, "packages/adapter-web/src/product-ui-assets.ts"), "utf8"),
    readFile(resolve(root, "packages/composition-root/src/product-site.ts"), "utf8"),
  ]);
  assert.match(http, /renderAuthenticatedOnboardingDocument/);
  assert.match(http, /renderMindDiaryUiShellDocument/);
  assert.match(http, /renderMcpTokenManagementDocument/);
  assert.match(http, /\/settings\/mcp/);
  assert.match(assets, /\/api\/v1\/account/);
  assert.match(assets, /\/api\/v1\/mcp-tokens/);
  assert.equal((assets.match(/authorization:"Bearer "\+token/gu) ?? []).length, 1);
  assert.doesNotMatch(assets, /authorization:"Bearer mdp_v1_/u);
  assert.doesNotMatch(
    assets,
    /console\.|localStorage|sessionStorage|sendBeacon|analytics\.|dataLayer/iu,
  );
  assert.match(assets, /diagnosticAbort\?\.abort\(\)/u);
  assert.match(assets, /token=""/u);
  assert.match(composition, /revokeMcpToken\(actor as never, input\.token_id as never\)/);
});

test("standalone lock describes the exact product package dependencies", async () => {
  const manifest = JSON.parse(await readFile(resolve(app, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(app, "package-lock.json"), "utf8"));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
});
