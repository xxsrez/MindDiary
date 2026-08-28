#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { chromium } from "@playwright/test";

import {
  assertRedactedDocument,
  candidateSha,
  canonical,
  digest,
  fail,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";
import { observeSettingsConnectionsPlugin } from "./lib/settings-connections-plugin-observation.mjs";
import { verifyToolchainObservation } from "./run-admin-shell-browser-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMA = "mind-diary/settings-connections-local-evidence/v1";
const CONTRACT_PATH = "tests/fixtures/settings-connections-uat/contract.v1.json";
const PLAYWRIGHT_CLI = resolve(ROOT, "node_modules/@playwright/test/cli.js");
const PLAYWRIGHT_CONFIG = resolve(ROOT, "playwright.md358.config.mjs");
const PLAYWRIGHT_TEST = "tests/browser/connections/connections.spec.mjs";
const execFileAsync = promisify(execFile);

export const SETTINGS_CONNECTIONS_RUNTIME_SUITES = Object.freeze([
  "tests/unit/connections-experience-ui.test.mjs",
  "tests/unit/mcp-token-management-ui.test.mjs",
  "tests/integration/oauth-connector.test.mjs",
  "tests/integration/mind-binding-state.test.mjs",
  "tests/integration/product-site-mcp-runtime.test.mjs",
  "tests/conformance/mcp-bundle-file-staging.test.mjs",
  "tests/conformance/oauth-direct-plugin-gate.test.mjs",
]);

export const SETTINGS_CONNECTIONS_LOCAL_ASSERTION_IDS = Object.freeze([
  "SC-NAV-01",
  "SC-OAUTH-01",
  "SC-OAUTH-02",
  "SC-TOKEN-01",
  "SC-TOKEN-02",
  "SC-PRIVACY-01",
  "SC-FAIL-CLOSED-01",
]);

export const SETTINGS_CONNECTIONS_SOURCE_PATHS = Object.freeze([
  CONTRACT_PATH,
  "playwright.md358.config.mjs",
  "scripts/lib/settings-connections-browser-reporter.mjs",
  "scripts/lib/settings-connections-plugin-observation.mjs",
  "scripts/run-settings-connections-local-gate.mjs",
  PLAYWRIGHT_TEST,
  "tests/browser/connections/fixture-server.mjs",
]);

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(path);
    stream.once("error", rejectRead);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolveRead);
  });
  return `sha256:${hash.digest("hex")}`;
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || Object.hasOwn(options, key)) {
      fail("invalid_cli_argument");
    }
    options[key] = value;
    index += 1;
  }
  const allowed = new Set(["candidate_sha", "evidence_out", "marketplace_root"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) fail("unsupported_cli_argument");
  if (typeof options.evidence_out !== "string") fail("missing_evidence_out");
  return options;
}

async function git(...args) {
  try {
    return (await execFileAsync("git", args, { cwd: ROOT, encoding: "utf8" })).stdout.trim();
  } catch {
    fail("git_read_failed");
  }
}

async function exactCandidate(requested) {
  const head = candidateSha(await git("rev-parse", "HEAD"));
  const candidate = requested === undefined ? head : candidateSha(requested);
  if (candidate !== head) fail("candidate_sha_not_head");
  if ((await git("status", "--porcelain=v1", "--untracked-files=all")).length !== 0) {
    fail("candidate_worktree_not_clean");
  }
  return candidate;
}

function runProcess(command, args, { env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("error", rejectRun);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("exit", (code, signal) => resolveRun({
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
  });
}

function lockEntry(lockfile, name) {
  return lockfile.packages?.[`node_modules/${name}`];
}

async function installedToolchain() {
  const [
    rootPackage,
    lockfile,
    installedPlaywright,
    installedBrowser,
    installedCore,
    browserManifest,
    cliResult,
  ] = await Promise.all([
    readFile(resolve(ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/@playwright/test/package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/@playwright/browser-chromium/package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/playwright-core/package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/playwright-core/browsers.json"), "utf8").then(JSON.parse),
    execFileAsync(process.execPath, [PLAYWRIGHT_CLI, "--version"], { cwd: ROOT, encoding: "utf8" }),
  ]);
  const executablePath = chromium.executablePath();
  const browserResult = await execFileAsync(executablePath, ["--version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const observed = verifyToolchainObservation({
    rootPackage,
    lockfile: {
      packages: {
        "node_modules/@playwright/test": lockEntry(lockfile, "@playwright/test"),
        "node_modules/@playwright/browser-chromium": lockEntry(lockfile, "@playwright/browser-chromium"),
        "node_modules/playwright-core": lockEntry(lockfile, "playwright-core"),
      },
    },
    installedPlaywright,
    installedBrowser,
    installedCore,
    browserManifest,
    cliVersionOutput: cliResult.stdout,
    browserVersionOutput: browserResult.stdout,
    executablePath,
  });
  return Object.freeze({
    ...observed,
    chromium_executable_sha256: await fileSha256(executablePath),
  });
}

function validatePluginObservation(value, candidate) {
  if (
    value?.schema !== "mind-diary/settings-connections-plugin-observation/v1" ||
    value.status !== "passed" ||
    value.candidate_sha !== candidate ||
    typeof value.plugin_version !== "string" ||
    typeof value.client !== "string" ||
    typeof value.client_version !== "string" ||
    value.fresh_context?.marketplace_added !== true ||
    value.fresh_context?.plugin_installed !== true ||
    value.fresh_context?.mcp_resolved !== true ||
    value.catalog_profiles?.default_product_site_write !== 17 ||
    value.catalog_profiles?.read_only !== 16 ||
    value.catalog_profiles?.verified_native !== 18 ||
    value.cleanup?.temporary_codex_home_removed !== true ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.artifact_sha256 ?? "")
  ) fail("invalid_plugin_observation");
  const { artifact_sha256: supplied, ...unsigned } = value;
  if (supplied !== digest(canonical(unsigned))) fail("invalid_plugin_observation");
  return Object.freeze({
    artifact_sha256: supplied,
    marketplace_candidate_sha: value.marketplace_candidate_sha,
    marketplace_tree_sha: value.marketplace_tree_sha,
    plugin_version: value.plugin_version,
    plugin_snapshot_sha256: value.plugin_snapshot_sha256,
    client: value.client,
    client_version: value.client_version,
    routes: value.routes,
    catalog_profiles: value.catalog_profiles,
  });
}

function verifiedBrowserAssertions(report, contract) {
  if (report?.status !== "passed" || !Array.isArray(report.tests)) {
    fail("playwright_report_not_passed");
  }
  const expectedTitles = Object.keys(contract.browser_test_titles);
  if (report.tests.length !== expectedTitles.length) fail("playwright_test_registry_mismatch");
  const seen = new Set();
  const ids = new Set();
  for (const result of report.tests) {
    const expectedId = contract.browser_test_titles[result.title];
    if (result.status !== "passed" || result.assertion_id !== expectedId || seen.has(result.title)) {
      fail("playwright_test_registry_mismatch");
    }
    seen.add(result.title);
    ids.add(expectedId);
  }
  if (expectedTitles.some((title) => !seen.has(title)) ||
      contract.local_assertion_ids.some((id) => !ids.has(id)) ||
      ids.size !== contract.local_assertion_ids.length) {
    fail("playwright_assertion_registry_mismatch");
  }
  return Object.freeze(contract.local_assertion_ids.map((id) =>
    Object.freeze({ id, status: "passed" })));
}

function validateRuntimeSuites(value) {
  if (!Array.isArray(value) || value.length !== SETTINGS_CONNECTIONS_RUNTIME_SUITES.length ||
      value.some((entry, index) =>
        entry.path !== SETTINGS_CONNECTIONS_RUNTIME_SUITES[index] ||
        entry.status !== "passed" ||
        !/^sha256:[0-9a-f]{64}$/u.test(entry.source_sha256) ||
        !/^sha256:[0-9a-f]{64}$/u.test(entry.stdout_sha256))) {
    fail("runtime_suite_registry_mismatch");
  }
  return value;
}

function validateSourceHashes(value) {
  const keys = Object.keys(value ?? {});
  if (keys.length !== SETTINGS_CONNECTIONS_SOURCE_PATHS.length ||
      keys.some((path, index) => path !== SETTINGS_CONNECTIONS_SOURCE_PATHS[index]) ||
      keys.some((path) => !/^sha256:[0-9a-f]{64}$/u.test(value[path]))) {
    fail("source_hash_registry_mismatch");
  }
  return value;
}

function validateAssertions(value) {
  if (!Array.isArray(value) || value.length !== SETTINGS_CONNECTIONS_LOCAL_ASSERTION_IDS.length ||
      value.some((entry, index) =>
        entry?.id !== SETTINGS_CONNECTIONS_LOCAL_ASSERTION_IDS[index] ||
        entry?.status !== "passed")) {
    fail("local_assertion_registry_mismatch");
  }
  return value;
}

export function createEvidence({
  candidate,
  contractSha256,
  oauth,
  toolchain,
  runtimeSuites,
  sourceHashes,
  assertions,
  startedAt,
  completedAt,
}) {
  validateRuntimeSuites(runtimeSuites);
  validateSourceHashes(sourceHashes);
  validateAssertions(assertions);
  const unsigned = Object.freeze({
    schema: SCHEMA,
    status: "passed",
    hosted_evidence: false,
    hosted_status: "not-run",
    acceptance: "local-deterministic-only",
    provenance: "exact-candidate-local-execution",
    candidate_sha: candidateSha(candidate),
    deployment_id: null,
    contract_sha256: contractSha256,
    plugin: oauth,
    browser: Object.freeze({
      playwright_package_version: toolchain.playwright_package_version,
      playwright_cli_version: toolchain.playwright_cli_version,
      chromium_package_version: toolchain.chromium_package_version,
      playwright_core_version: toolchain.playwright_core_version,
      chromium_revision: toolchain.chromium_revision,
      chromium_browser_version: toolchain.chromium_browser_version,
      chromium_executable_sha256: toolchain.chromium_executable_sha256,
      fixture: "server-bound-synthetic-connections",
      workers: 1,
      locale: "en-US",
      timezone: "UTC",
    }),
    runtime_suites: runtimeSuites,
    source_hashes: sourceHashes,
    assertions,
    cleanup: Object.freeze({
      fixture_processes_closed: true,
      browser_contexts_closed: true,
      oauth_synthetic_adapters_destroyed: true,
      private_temporary_inputs_removed: true,
    }),
    unresolved_hosted_rows: Object.freeze([
      "exact-sites-deployment",
      "in-app-browser-settings-journey",
      "fresh-hosted-codex-plugin-observation",
      "controlled-redeploy-persistence",
      "provider-and-product-cleanup-readback",
    ]),
    started_at: startedAt,
    completed_at: completedAt,
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

async function sourceHashes() {
  return Object.freeze(Object.fromEntries(await Promise.all(
    SETTINGS_CONNECTIONS_SOURCE_PATHS.map(async (path) => [
      path,
      await fileSha256(resolve(ROOT, path)),
    ]),
  )));
}

export async function run(options, { now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const candidate = await exactCandidate(options.candidate_sha);
  const output = await reservePrivateTempOutput(options.evidence_out, {
    repositoryRoot: ROOT,
    errorCode: "unsafe_settings_connections_output",
  });
  const temporary = await mkdtemp(join(tmpdir(), "mind-diary-md358-gate-"));
  try {
    const [contractBytes, toolchain] = await Promise.all([
      readFile(resolve(ROOT, CONTRACT_PATH)),
      installedToolchain(),
    ]);
    const contract = JSON.parse(contractBytes.toString("utf8"));
    const oauth = validatePluginObservation(await observeSettingsConnectionsPlugin({
      candidate,
      marketplaceRoot: options.marketplace_root ?? resolve(ROOT, "..", "Srez Marketplace"),
    }), candidate);

    const runtimeSuites = [];
    for (const path of SETTINGS_CONNECTIONS_RUNTIME_SUITES) {
      const result = await runProcess(process.execPath, ["--test", path]);
      if (result.code !== 0) fail("settings_connections_runtime_suite_failed");
      runtimeSuites.push(Object.freeze({
        path,
        status: "passed",
        source_sha256: await fileSha256(resolve(ROOT, path)),
        stdout_sha256: sha256Bytes(result.stdout),
      }));
    }

    const reportPath = resolve(temporary, "playwright-report.json");
    const browser = await runProcess(process.execPath, [
      PLAYWRIGHT_CLI,
      "test",
      PLAYWRIGHT_TEST,
      `--config=${PLAYWRIGHT_CONFIG}`,
      "--workers=1",
    ], {
      env: {
        ...process.env,
        MIND_DIARY_MD358_REPORT: reportPath,
        MIND_DIARY_MD358_DIAGNOSTICS: resolve(temporary, "diagnostics"),
        MIND_DIARY_MD358_CHROMIUM_EXECUTABLE: toolchain.executable_path,
      },
    });
    if (browser.code !== 0) fail("settings_connections_playwright_failed");
    const assertions = verifiedBrowserAssertions(
      JSON.parse(await readFile(reportPath, "utf8")),
      contract,
    );
    await exactCandidate(candidate);
    const evidence = createEvidence({
      candidate,
      contractSha256: sha256Bytes(contractBytes),
      oauth,
      toolchain,
      runtimeSuites: Object.freeze(runtimeSuites),
      sourceHashes: await sourceHashes(),
      assertions,
      startedAt,
      completedAt: now().toISOString(),
    });
    await output.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } catch (error) {
    await output.abort();
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run gate:settings-connections-local -- --candidate-sha <exact-clean-HEAD-sha> --evidence-out <private-temp-path> [--marketplace-root <clean-checkout>]\n");
      return;
    }
    const evidence = await run(options);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      hosted_status: evidence.hosted_status,
      candidate_sha: evidence.candidate_sha,
      artifact_sha256: evidence.artifact_sha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProbeFailure ? error.code : safeCode(error?.code),
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
