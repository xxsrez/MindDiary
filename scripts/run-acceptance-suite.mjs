import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { ACCEPTANCE_COMPONENTS, verifyAcceptanceComponent, joinAcceptanceSuite, acceptanceDigest } from "./lib/acceptance-evidence.mjs";
import { verifyAcceptanceApplicability } from "./lib/acceptance-applicability.mjs";

// The same command resumes a private journal. Only Sites connector operations
// yield to the controlling agent; routine fixture/CI/model work runs here.
const [tag, configurationPath] = process.argv.slice(2);
assert.match(tag ?? "", /^[a-zA-Z0-9_-]{1,48}$/);
const root = join(homedir(), ".codex/private/mind-diary-acceptance");
const directory = join(root, "suites", tag);
await mkdir(directory, { recursive: true, mode: 0o700 });
assert.equal((await lstat(directory)).mode & 0o077, 0);
const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
assert.deepEqual(Object.keys(configuration).sort(), ["identity", "applicability", "package_path"].sort());
verifyAcceptanceApplicability(configuration.applicability);
assert.equal(configuration.applicability.policy, "autonomous-v1");
assert.equal(configuration.applicability.candidate_sha, configuration.identity.candidate_sha);
assert.ok(configuration.package_path.startsWith(join(homedir(), ".codex/plugins/cache/")));
const runnerSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "clean_runner_required");
const journalPath = join(directory, "suite.json");
async function optional(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
let state = await optional(journalPath);
if (!state) {
  const probe = await new AcceptanceClient({ directory: join(directory, "preflight"),
    platformToken: JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token,
    controllerKey: await readFile(join(root, "controller-key"), "utf8") }).open();
  const inventory = await probe.control("/_acceptance/inventory");
  assert.equal(inventory.complete, true);
  assert.ok([inventory.principals, inventory.owned_minds, inventory.object_count, inventory.object_bytes, ...Object.values(inventory.rows)].every(count => count === 0), "clean_environment_required");
}
if (!state) state = { schema: "mind-diary/acceptance-coordinator/v1", configuration_digest: acceptanceDigest(configuration), runner_sha: runnerSha,
  identity: configuration.identity, stage: "persistence_prepare", components: {}, attempts: {}, events: [] };
assert.equal(state.configuration_digest, acceptanceDigest(configuration), "suite_configuration_changed");
assert.equal(state.runner_sha, runnerSha, "suite_runner_changed");
async function save() { const tmp = journalPath + ".tmp"; await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, journalPath); }
async function write(name, value) { const path = join(directory, name); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return path; }
await save();
function checkpoint(action, details) { console.log(JSON.stringify({ status: "agent_checkpoint", stage: state.stage, directory, action, ...details })); }
function execute(executable, args, env = {}, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { stdio: [input ? "pipe" : "ignore", "inherit", "inherit"], env: { ...process.env, ...env } });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolveRun() : reject(Error("component_process_failed")));
    if (input) child.stdin.end(input);
  });
}
const runTag = kind => `${tag}-${kind}-${state.attempts[kind] ?? 1}`;
async function run(kind, script, args, env = {}) {
  state.active = { kind, run_tag: runTag(kind), started_at: new Date().toISOString() }; await save();
  await execute(process.execPath, [resolve("scripts", script), ...args], env);
  state.events.push({ ...state.active, completed_at: new Date().toISOString() }); delete state.active; await save();
}
async function add(kind, path) {
  const component = verifyAcceptanceComponent(JSON.parse(await readFile(path, "utf8")));
  assert.equal(component.kind, kind); assert.deepEqual(component.identity, state.identity); assert.equal(component.runner_sha, runnerSha);
  state.components[kind] = { path, hash: component.artifact_sha256 }; await save();
}
const componentPath = kind => join(root, "runs", runTag(kind), `${kind}-component.json`);
async function recoverInterrupted() {
  if (!state.active) return;
  const active = state.active;
  const component = await optional(join(root, "runs", active.run_tag, `${active.kind}-component.json`));
  if (component) {
    await add(active.kind, join(root, "runs", active.run_tag, `${active.kind}-component.json`));
    state.stage = { persistence: "product", product: "browser", model: "recovery", recovery: "performance", performance: "platform" }[active.kind];
    delete state.active; await save(); return;
  }
  const runJournal = await optional(join(root, "runs", active.run_tag, "run.json"));
  if (active.kind === "persistence" && state.stage === "persistence_prepare" && runJournal?.persistence?.ready && runJournal.phase !== "cleaned") {
    state.stage = "deployment"; delete state.active; await save(); return;
  }
  if (active.kind === "performance" && runJournal?.performance?.samples && runJournal.phase !== "cleaned") {
    state.stage = "provider_logs"; delete state.active; await save(); return;
  }
  const credentials = { platformToken: JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token,
    controllerKey: await readFile(join(root, "controller-key"), "utf8") };
  const baseline = runJournal?.baseline ?? runJournal?.modelBaseline ?? runJournal?.performance?.baseline ?? runJournal?.persistence?.baseline ?? runJournal?.recovery?.baseline;
  let lastClient;
  for (const suffix of active.kind === "recovery" ? ["-ttl", ""] : [""]) {
    const path = join(root, "runs", active.run_tag + suffix);
    if (!await optional(join(path, "run.json"))) continue;
    const client = await new AcceptanceClient({ ...credentials, directory: path }).open(); await client.cleanup(); lastClient = client;
  }
  if (baseline && lastClient) assert.deepEqual(await lastClient.control("/_acceptance/inventory"), baseline);
  if (active.kind === "persistence") state.stage = "persistence_prepare";
  if (active.kind === "performance") state.stage = "performance";
  state.attempts[active.kind] = (state.attempts[active.kind] ?? 1) + 1;
  state.events.push({ recovered: active.kind, at: new Date().toISOString() }); delete state.active; await save();
}
await recoverInterrupted();
for (;;) {
  const identityPath = await write("identity.json", state.identity);
  if (state.stage === "persistence_prepare") {
    await run("persistence", "check-acceptance-persistence-hosted.mjs", [runTag("persistence"), "prepare", identityPath]);
    state.stage = "deployment"; await save();
  } else if (state.stage === "deployment") {
    const deployment = await optional(join(directory, "deployment-readback.json"));
    if (!deployment) {
      checkpoint("redeploy_exact_saved_version_with_sites_then_save_terminal_readback", { project_id: state.identity.project_id, version_id: state.identity.site_version_id,
        output: join(directory, "deployment-readback.json") }); break;
    }
    assert.equal(deployment.status, "succeeded"); assert.equal(deployment.project_id, state.identity.project_id);
    assert.equal(deployment.version_id, state.identity.site_version_id); assert.notEqual(deployment.id, state.identity.deployment_id);
    state.identity = { ...state.identity, deployment_id: deployment.id }; state.deployment_receipt = acceptanceDigest(deployment);
    state.stage = "persistence_verify"; await save();
  } else if (state.stage === "persistence_verify") {
    await run("persistence", "check-acceptance-persistence-hosted.mjs", [runTag("persistence"), "verify", identityPath]);
    await add("persistence", componentPath("persistence")); state.stage = "product"; await save();
  } else if (state.stage === "product") {
    await run("product", "check-acceptance-fixture-hosted.mjs", [runTag("product")], { MD_ACCEPTANCE_EXPECTED_SHA: state.identity.candidate_sha,
      MD_ACCEPTANCE_IDENTITY_FILE: identityPath, MD_ACCEPTANCE_PRODUCT_MATRIX: "1", MD_ACCEPTANCE_INJECT_LOST_COMMIT: "1" });
    await add("product", componentPath("product")); state.stage = "browser"; await save();
  } else if (state.stage === "browser") {
    // CI uses stored repository secrets. The coordinator receives aggregate
    // evidence only, never CI browser cookies or credentials.
    const browserDirectory = join(directory, "browser");
    if (!state.browser_run_id) {
      const browserTag = tag + "-browser";
      if (!state.browser_dispatched) {
        await execute("gh", ["workflow", "run", "acceptance-product-browser.yml", "--ref", "main", "--json"], {},
          JSON.stringify({ candidate: state.identity.candidate_sha, identity_json: JSON.stringify(state.identity), run_tag: browserTag }));
        state.browser_dispatched = true; await save();
      }
      const runs = JSON.parse(execFileSync("gh", ["run", "list", "--workflow", "acceptance-product-browser.yml", "--limit", "20", "--json", "databaseId,headSha,displayTitle"], { encoding: "utf8" }));
      const match = runs.filter(r => r.displayTitle === "Acceptance " + browserTag && r.headSha === runnerSha);
      if (match.length === 0) { checkpoint("resume_after_ci_run_is_visible", {}); break; }
      assert.equal(match.length, 1, "ambiguous_browser_run"); state.browser_run_id = match[0].databaseId; await save();
    }
    await execute("gh", ["run", "watch", String(state.browser_run_id), "--exit-status"]);
    await execute("gh", ["run", "download", String(state.browser_run_id), "--name", "acceptance-browser-evidence", "--dir", browserDirectory]);
    await add("browser", join(browserDirectory, "browser-component.json")); state.stage = "model"; await save();
  } else if (state.stage === "model") {
    await run("model", "check-acceptance-model-hosted.mjs", [runTag("model")], { MD_ACCEPTANCE_EXPECTED_SHA: state.identity.candidate_sha,
      MD_ACCEPTANCE_IDENTITY_FILE: identityPath, MD_ACCEPTANCE_PLUGIN_PATH: configuration.package_path, MD_ACCEPTANCE_MODEL_CASES: "" });
    await add("model", componentPath("model")); state.stage = "recovery"; await save();
  } else if (state.stage === "recovery") {
    await run("recovery", "check-acceptance-recovery-hosted.mjs", [runTag("recovery"), identityPath]);
    await add("recovery", componentPath("recovery")); state.stage = "performance"; await save();
  } else if (state.stage === "performance") {
    const captureReady = await optional(join(directory, "capture-started.json"));
    if (!captureReady || captureReady.project_id !== state.identity.project_id || !Number.isFinite(Date.parse(captureReady.started_at)) ||
      Date.now() - Date.parse(captureReady.started_at) > 60000 || Date.parse(captureReady.started_at) > Date.now()) {
      checkpoint("start_bounded_sites_log_capture_before_samples", { project_id: state.identity.project_id, interval_seconds: 12, limit: 100,
        output: join(directory, "capture-started.json"), logs_output: join(directory, "performance-sites-logs.json") }); break;
    }
    await run("performance", "check-acceptance-performance-hosted.mjs", [runTag("performance"), "sample", identityPath]);
    state.stage = "provider_logs"; await save();
  } else if (state.stage === "provider_logs") {
    const path = join(directory, "performance-sites-logs.json");
    if (!await optional(path)) { checkpoint("capture_actual_sites_logs_and_save_private_result", { project_id: state.identity.project_id,
      run_directory: join(root, "runs", runTag("performance")), output: path }); break; }
    await run("performance", "check-acceptance-performance-hosted.mjs", [runTag("performance"), "finalize", path]);
    await add("performance", componentPath("performance")); state.stage = "platform"; await save();
  } else if (state.stage === "platform") {
    const required = Object.entries(configuration.applicability.required).filter(([, required]) => required).map(([surface]) => surface);
    const receipts = await optional(join(directory, "platform-receipts.json")) ?? [];
    if (receipts.length !== required.length) { checkpoint("collect_applicable_ordinary_uat_platform_receipts", { required, output: join(directory, "platform-receipts.json") }); break; }
    const components = await Promise.all(ACCEPTANCE_COMPONENTS.map(async kind => {
      const c = JSON.parse(await readFile(state.components[kind].path, "utf8")); assert.equal(c.artifact_sha256, state.components[kind].hash); return c;
    }));
    const manifest = { schema: "mind-diary/acceptance-manifest/v1", identity: state.identity, runner_sha: runnerSha,
      package_sha256: components.find(c => c.kind === "model").details.package_sha256,
      component_hashes: Object.fromEntries(ACCEPTANCE_COMPONENTS.map(kind => [kind, state.components[kind].hash])), applicability: configuration.applicability,
      platform_receipt_hashes: Object.fromEntries(receipts.map(r => [r.surface, r.artifact_sha256])) };
    const report = joinAcceptanceSuite(manifest, components, receipts);
    await write("manifest.json", manifest); await write("report.json", report); state.stage = "complete"; state.report_sha256 = report.artifact_sha256; await save();
  } else if (state.stage === "complete") {
    console.log(JSON.stringify({ status: "passed", report: join(directory, "report.json"), artifact_sha256: state.report_sha256 })); break;
  } else throw Error("unknown_coordinator_stage");
}
