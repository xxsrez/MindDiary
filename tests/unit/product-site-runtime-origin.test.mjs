import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const moduleUrl = pathToFileURL(resolve(
  new URL("../..", import.meta.url).pathname,
  "apps/mind-diary-site/worker/runtime-config.ts",
)).href;

test("product Site origin policy permits only exact HTTPS hosting or loopback HTTP dev", () => {
  const source = `
    import { resolveRuntimePublicOrigin as resolveOrigin } from ${JSON.stringify(moduleUrl)};
    const results = {
      hosted: resolveOrigin("https://mind-diary.example", "https://mind-diary.example"),
      local: resolveOrigin("http://localhost:3000", "https://localhost"),
      localExact: resolveOrigin("http://127.0.0.1:4173", "http://127.0.0.1:4173"),
    };
    for (const [request, configured] of [
      ["http://mind-diary.example", undefined],
      ["http://localhost:3000", "https://mind-diary.example"],
      ["https://mind-diary.example", "https://other.example"],
    ]) {
      try { resolveOrigin(request, configured); throw new Error("accepted unsafe origin"); }
      catch (error) { if (error.message === "accepted unsafe origin") throw error; }
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    source,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    hosted: "https://mind-diary.example",
    local: "http://localhost:3000",
    localExact: "http://127.0.0.1:4173",
  });
});

test("deployed Product Worker config cannot activate the constructor-only native route", () => {
  const source = `
    import { readRuntimeConfig } from ${JSON.stringify(moduleUrl)};
    const key = "A".repeat(43);
    const environment = {
      ASSETS: {},
      DB: {},
      MIND_DIARY_BUCKET: {},
      MIND_DIARY_TOKEN_VERIFIER_KEY: key,
      MIND_DIARY_LOCATOR_KEY: key,
      MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY: key,
      MIND_DIARY_CSRF_KEY: key,
      // Unknown configuration must not become native-file runtime authority.
      MIND_DIARY_NATIVE_FILE_HOST_REWRITE_ASSERTION: JSON.stringify({ status: "passed" }),
    };
    const config = readRuntimeConfig(
      new Request("https://mind-diary.example/api/mcp"),
      environment,
    );
    process.stdout.write(JSON.stringify({
      hasNativeRoute: Object.hasOwn(config, "verifiedNativeFileParameterRoute"),
      keys: Object.keys(config).sort(),
    }));
  `;
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    source,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hasNativeRoute, false);
  assert.deepEqual(parsed.keys, [
    "csrfKey",
    "exportDownloadVerifierKey",
    "locatorKey",
    "publicOrigin",
    "serviceOperatorPrincipalIds",
    "tokenVerifierKey",
  ]);
});
