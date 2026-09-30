import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { loadPrivateOperations, privateEnvironment } from "../../scripts/lib/private-operations.mjs";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "mind-private-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = realpathSync(base), directory = join(repo, ".private/config");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (name, value) => writeFileSync(join(directory, name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  write("operations.json", { schema: "mind-diary/private-operations/v1", uat_origin: "https://uat.example.invalid", acceptance_origin: "https://acceptance.example.invalid" });
  for (const name of ["product", "acceptance", "probe"]) write(`hosting.${name}.json`, { project_id: `appgprj_fixture${name}`, d1: "DB", r2: "MIND_DIARY_BUCKET" });
  const secret = randomBytes(32).toString("base64url");
  write("development.vars", "MIND_DIARY_PUBLIC_ORIGIN=https://localhost\n" +
    ["TOKEN_VERIFIER", "LOCATOR", "EXPORT_DOWNLOAD_VERIFIER", "CSRF"].map((key) => `MIND_DIARY_${key}_KEY=${secret}`).join("\n"));
  return { repo, directory, write, secret, load: () => loadPrivateOperations({ directory, repositoryRoot: repo }) };
}
test("private settings remain inside the workspace and never enter the command environment as dev secrets", (t) => {
  const f = fixture(t); const settings = f.load();
  const environment = privateEnvironment(settings, {});
  assert.equal(environment.MIND_DIARY_UAT_ORIGIN, "https://uat.example.invalid");
  assert.equal(environment.MIND_DIARY_HOSTING_CONFIG, join(realpathSync(f.directory), "hosting.product.json"));
  assert.ok(!JSON.stringify(environment).includes(f.secret));
  assert.throws(() => loadPrivateOperations({ directory: f.directory, repositoryRoot: f.directory }), /values withheld/);
});
test("external private directories and symlinked credentials are rejected", (t) => {
  const f = fixture(t);
  const outside = join(f.repo, "elsewhere");
  renameSync(f.directory, outside);
  assert.throws(() => loadPrivateOperations({ directory: outside, repositoryRoot: f.repo }), /values withheld/);
  symlinkSync(outside, f.directory);
  assert.throws(f.load, /values withheld/);
  rmSync(f.directory); renameSync(outside, f.directory);
  const original = join(f.directory, "development.vars");
  renameSync(original, join(f.repo, "external.vars"));
  symlinkSync(join(f.repo, "external.vars"), original);
  assert.throws(f.load, /values withheld/);
});
test("insecure, missing and malformed settings fail closed without printing private values", (t) => {
  const f = fixture(t);
  chmodSync(join(f.directory, "development.vars"), 0o644);
  assert.throws(f.load, /values withheld/);
  chmodSync(join(f.directory, "development.vars"), 0o600);
  f.write("operations.json", "private-value-that-must-not-be-logged");
  assert.throws(f.load, (error) => !error.message.includes("private-value") && /values withheld/.test(error.message));
});
test("acceptance and ordinary UAT cannot share a target", (t) => {
  const f = fixture(t);
  f.write("hosting.acceptance.json", { project_id: "appgprj_fixtureproduct", d1: "DB", r2: "MIND_DIARY_BUCKET" });
  assert.throws(f.load, /values withheld/);
});
test("hosting manifests cannot carry arbitrary secret fields", (t) => {
  const f = fixture(t);
  f.write("hosting.product.json", { project_id: "appgprj_fixtureproduct", d1: "DB", r2: "MIND_DIARY_BUCKET", credential: f.secret });
  assert.throws(f.load, /values withheld/);
});

test("a retired capability probe is not required for product and acceptance operations", (t) => {
  const f = fixture(t);
  rmSync(join(f.directory, "hosting.probe.json"));
  const config = f.load();
  assert.deepEqual(Object.keys(config.manifests), ["product", "acceptance"]);
  assert.ok(!("MIND_DIARY_PROBE_HOSTING_CONFIG" in privateEnvironment(config, {})));
});
test("acceptance runner pin uses configured target and still rejects request target substitution", () => {
  const module = new URL("../../apps/mind-diary-acceptance/runtime-target.mjs", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {ACCEPTANCE_ORIGIN,ACCEPTANCE_PROJECT,assertAcceptanceTarget} from ${JSON.stringify(module)};
    const env={MIND_DIARY_PUBLIC_ORIGIN:ACCEPTANCE_ORIGIN,MD_ACCEPTANCE_PROJECT_ID:ACCEPTANCE_PROJECT};
    assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN),env);
    let rejected=false;try{assertAcceptanceTarget(new Request('https://wrong.example.invalid'),env);}catch{rejected=true;}
    console.log(JSON.stringify({origin:ACCEPTANCE_ORIGIN,project:ACCEPTANCE_PROJECT,rejected}));
  `], { encoding: "utf8", env: { ...process.env, MIND_DIARY_ACCEPTANCE_ORIGIN: "https://configured.example.invalid", MIND_DIARY_ACCEPTANCE_PROJECT: "appgprj_fixtureacceptance" } });
  assert.deepEqual(JSON.parse(output), { origin: "https://configured.example.invalid", project: "appgprj_fixtureacceptance", rejected: true });
});

test("compiled acceptance pin cannot be changed by the runtime process environment", async () => {
  const result = await build({ entryPoints: [resolve(import.meta.dirname, "../../apps/mind-diary-acceptance/runtime-target.mjs")],
    bundle: true, format: "cjs", platform: "node", write: false,
    define: { __MD_ACCEPTANCE_ORIGIN__: JSON.stringify("https://pinned.example.invalid"),
      __MD_ACCEPTANCE_PROJECT__: JSON.stringify("appgprj_pinnedfixture") } });
  const context = { module: { exports: {} }, process: { env: {
    MIND_DIARY_ACCEPTANCE_ORIGIN: "https://wrong.example.invalid", MIND_DIARY_ACCEPTANCE_PROJECT: "appgprj_wrongfixture",
  } } };
  runInNewContext(result.outputFiles[0].text, context);
  assert.equal(context.module.exports.ACCEPTANCE_ORIGIN, "https://pinned.example.invalid");
  assert.equal(context.module.exports.ACCEPTANCE_PROJECT, "appgprj_pinnedfixture");
});
