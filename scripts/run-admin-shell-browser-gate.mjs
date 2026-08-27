#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const ROOT = resolve(import.meta.dirname, "..");
const EVIDENCE_SCHEMA = "mind-diary/admin-shell-browser-evidence/v1";
const PLAYWRIGHT_CLI = resolve(ROOT, "node_modules/@playwright/test/cli.js");
const PLAYWRIGHT_CONFIG = resolve(ROOT, "playwright.md347.config.mjs");
const TEST_FILE = "tests/browser/ui-shell/compact-admin-shell.spec.mjs";
const execFileAsync = promisify(execFile);

const EXPECTED_TOOLCHAIN = Object.freeze({
  playwright: "1.62.1",
  browserPackage: "1.62.1",
  core: "1.62.1",
  chromiumRevision: "1234",
  chromiumVersion: "151.0.7922.34",
  integrity: Object.freeze({
    playwright: "sha512-DTcUc8qii+cpHvtOwggMtBRMjKZHXYWdw8syRYu2vtzuq4Wxphqq4NfCs5Zt44L6mA8rfDfj+PHnxFc/FeK6mQ==",
    browserPackage: "sha512-DU/t4TSqHvAc+uFMt972forQYqBTh/ul7lZ8U81HYGyxnf6vSPPz9NzuE0OR3x/elqvvGm+n4gcny+QSKT+FDw==",
    core: "sha512-wPYSwEBJY9GHraISXqyqtx0na0LpO3XEX7jNDhntbex7tzUS7kLnZsOlFruFJB4Hi/rhDMjXGqHewDZ68nYZVw==",
  }),
});

export const ADMIN_SHELL_BROWSER_ASSERTION_IDS = Object.freeze([
  "IA-SESSION-01",
  "IA-SESSION-02",
  "IA-NAV-01",
  "IA-NAV-02",
  "IA-NAV-03",
  "IA-GEOMETRY-01",
  "IA-GEOMETRY-02",
  "IA-DENSITY-01",
  "IA-FIRST-01",
  "IA-A11Y-01",
  "IA-A11Y-02",
  "IA-STATE-01",
  "IA-PERSONAL-01",
  "IA-PRIVACY-01",
]);

export const ADMIN_SHELL_BROWSER_VIEWPORTS = Object.freeze([
  Object.freeze({ id: "minimum", width: 320, height: 568 }),
  Object.freeze({ id: "mobile", width: 390, height: 844 }),
  Object.freeze({ id: "medium", width: 768, height: 1024 }),
  Object.freeze({ id: "wide-minimum", width: 1024, height: 768 }),
  Object.freeze({ id: "wide", width: 1440, height: 900 }),
]);

function required(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
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
  for (const key of Object.keys(options)) {
    if (!["candidate_sha", "evidence_out"].includes(key)) fail("unsupported_cli_argument");
  }
  if (!options.evidence_out) fail("missing_evidence_out");
  return options;
}

async function git(...args) {
  try {
    const result = await execFileAsync("git", args, { cwd: ROOT, encoding: "utf8" });
    return result.stdout.trim();
  } catch {
    fail("git_read_failed");
  }
}

function runProcess(command, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("error", rejectPromise);
    child.stdout.on("data", (chunk) => {
      if (capture) stdout.push(Buffer.from(chunk));
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (capture) stderr.push(Buffer.from(chunk));
      else process.stderr.write(chunk);
    });
    child.once("exit", (code, signal) => resolvePromise({
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function exactCandidate(requestedCandidate) {
  const current = candidateSha(await git("rev-parse", "HEAD"));
  const requested = requestedCandidate === undefined
    ? current
    : candidateSha(requestedCandidate);
  if (current !== requested) fail("candidate_sha_not_head");
  if ((await git("status", "--porcelain", "--untracked-files=all")).length !== 0) {
    fail("candidate_worktree_not_clean");
  }
  return current;
}

function packageLockEntry(lockfile, name) {
  return lockfile.packages?.[`node_modules/${name}`];
}

function actualVersion(output, prefix, code) {
  const value = output.trim();
  if (!value.startsWith(prefix)) fail(code);
  const version = value.slice(prefix.length).trim();
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(version)) fail(code);
  return version;
}

export function verifyToolchainObservation(observation) {
  const rootPlaywright = observation.rootPackage.devDependencies?.["@playwright/test"];
  const rootBrowser = observation.rootPackage.devDependencies?.["@playwright/browser-chromium"];
  const lockPlaywright = packageLockEntry(observation.lockfile, "@playwright/test");
  const lockBrowser = packageLockEntry(observation.lockfile, "@playwright/browser-chromium");
  const lockCore = packageLockEntry(observation.lockfile, "playwright-core");
  const chromiumEntry = observation.browserManifest.browsers?.find(
    (entry) => entry.name === "chromium",
  );
  const cliVersion = actualVersion(
    observation.cliVersionOutput,
    "Version ",
    "playwright_runtime_version_mismatch",
  );
  const browserVersion = actualVersion(
    observation.browserVersionOutput,
    "Google Chrome for Testing ",
    "chromium_runtime_version_mismatch",
  );
  if (
    rootPlaywright !== EXPECTED_TOOLCHAIN.playwright ||
    rootBrowser !== EXPECTED_TOOLCHAIN.browserPackage ||
    observation.rootPackage.allowScripts?.[
      `@playwright/browser-chromium@${EXPECTED_TOOLCHAIN.browserPackage}`
    ] !== true ||
    lockPlaywright?.version !== EXPECTED_TOOLCHAIN.playwright ||
    lockPlaywright?.integrity !== EXPECTED_TOOLCHAIN.integrity.playwright ||
    lockBrowser?.version !== EXPECTED_TOOLCHAIN.browserPackage ||
    lockBrowser?.integrity !== EXPECTED_TOOLCHAIN.integrity.browserPackage ||
    lockCore?.version !== EXPECTED_TOOLCHAIN.core ||
    lockCore?.integrity !== EXPECTED_TOOLCHAIN.integrity.core ||
    observation.installedPlaywright.version !== EXPECTED_TOOLCHAIN.playwright ||
    observation.installedBrowser.version !== EXPECTED_TOOLCHAIN.browserPackage ||
    observation.installedCore.version !== EXPECTED_TOOLCHAIN.core
  ) fail("unpinned_browser_toolchain");
  if (cliVersion !== EXPECTED_TOOLCHAIN.playwright) {
    fail("playwright_runtime_version_mismatch");
  }
  if (
    chromiumEntry?.revision !== EXPECTED_TOOLCHAIN.chromiumRevision ||
    chromiumEntry?.browserVersion !== EXPECTED_TOOLCHAIN.chromiumVersion ||
    browserVersion !== EXPECTED_TOOLCHAIN.chromiumVersion ||
    !observation.executablePath.includes(
      `/chromium-${EXPECTED_TOOLCHAIN.chromiumRevision}/`,
    )
  ) fail("chromium_runtime_version_mismatch");
  return Object.freeze({
    playwright_package_version: EXPECTED_TOOLCHAIN.playwright,
    playwright_cli_version: cliVersion,
    chromium_package_version: EXPECTED_TOOLCHAIN.browserPackage,
    playwright_core_version: EXPECTED_TOOLCHAIN.core,
    chromium_revision: EXPECTED_TOOLCHAIN.chromiumRevision,
    chromium_browser_version: browserVersion,
    executable_path: observation.executablePath,
  });
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.once("error", rejectStream);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolveStream);
  });
  return `sha256:${hash.digest("hex")}`;
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
    execFileAsync(process.execPath, [PLAYWRIGHT_CLI, "--version"], {
      cwd: ROOT,
      encoding: "utf8",
    }),
  ]);
  const executablePath = chromium.executablePath();
  const browserResult = await execFileAsync(executablePath, ["--version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const verified = verifyToolchainObservation({
    rootPackage,
    lockfile,
    installedPlaywright,
    installedBrowser,
    installedCore,
    browserManifest,
    cliVersionOutput: cliResult.stdout,
    browserVersionOutput: browserResult.stdout,
    executablePath,
  });
  return Object.freeze({
    ...verified,
    chromium_executable_sha256: await fileSha256(executablePath),
  });
}

function verifiedAssertions(report) {
  if (report?.status !== "passed" || !Array.isArray(report.tests)) {
    fail("playwright_report_not_passed");
  }
  const counts = new Map();
  for (const test of report.tests) {
    if (typeof test?.assertion_id !== "string") fail("playwright_assertion_id_missing");
    if (test.status !== "passed") fail("playwright_assertion_failed");
    counts.set(test.assertion_id, (counts.get(test.assertion_id) ?? 0) + 1);
  }
  const unexpected = [...counts.keys()].filter(
    (id) => !ADMIN_SHELL_BROWSER_ASSERTION_IDS.includes(id),
  );
  const missingOrDuplicate = ADMIN_SHELL_BROWSER_ASSERTION_IDS.filter(
    (id) => counts.get(id) !== 1,
  );
  if (unexpected.length > 0 || missingOrDuplicate.length > 0) {
    fail("playwright_assertion_registry_mismatch");
  }
  return Object.freeze(ADMIN_SHELL_BROWSER_ASSERTION_IDS.map((id) =>
    Object.freeze({ id, status: "passed" })));
}

export function createEvidence({ candidate, toolchain, assertions, startedAt, completedAt }) {
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: candidate,
    runner: Object.freeze({
      name: "Playwright",
      package_version: toolchain.playwright_package_version,
      executed_cli_version: toolchain.playwright_cli_version,
      browser: "Chromium",
      browser_package_version: toolchain.chromium_package_version,
      playwright_core_version: toolchain.playwright_core_version,
      browser_revision: toolchain.chromium_revision,
      executed_browser_version: toolchain.chromium_browser_version,
      browser_executable_sha256: toolchain.chromium_executable_sha256,
      workers: 1,
      locale: "en-US",
      timezone: "UTC",
    }),
    fixture: Object.freeze({
      kind: "synthetic-compact-admin-shell",
      listener: "ephemeral-loopback",
      browser_state: "isolated-no-user-profile",
    }),
    viewports: ADMIN_SHELL_BROWSER_VIEWPORTS,
    assertions,
    diagnostics: Object.freeze({
      screenshots: "failure-only-synthetic-fixture",
      trace: "disabled",
      video: "disabled",
      acceptance_source: "dom-accessibility-geometry-assertions",
    }),
    started_at: startedAt,
    completed_at: completedAt,
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export async function run(options, { now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const candidate = await exactCandidate(options.candidate_sha);
  const toolchain = await installedToolchain();
  const diagnosticsDirectory = await mkdtemp(join(tmpdir(), "mind-diary-md347-browser-"));
  const reporterOutput = join(diagnosticsDirectory, "playwright-assertions.json");
  const child = await runProcess(process.execPath, [
    PLAYWRIGHT_CLI,
    "test",
    TEST_FILE,
    `--config=${PLAYWRIGHT_CONFIG}`,
    "--workers=1",
  ], {
    env: {
      ...process.env,
      MIND_DIARY_MD347_DIAGNOSTICS: diagnosticsDirectory,
      MIND_DIARY_MD347_REPORT: reporterOutput,
      MIND_DIARY_MD347_CHROMIUM_EXECUTABLE: toolchain.executable_path,
    },
  });
  if (child.code !== 0) {
    process.stderr.write(`MD-347 synthetic-only browser diagnostics: ${diagnosticsDirectory}\n`);
    fail("playwright_gate_failed");
  }
  const report = JSON.parse(await readFile(reporterOutput, "utf8"));
  const assertions = verifiedAssertions(report);
  const evidence = createEvidence({
    candidate,
    toolchain,
    assertions,
    startedAt,
    completedAt: now().toISOString(),
  });
  await writeFile(required(options.evidence_out, "missing_evidence_out"),
    `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  await rm(diagnosticsDirectory, { recursive: true, force: true });
  return evidence;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run gate:admin-shell-browser -- --evidence-out <private-temp-path> [--candidate-sha <exact-clean-HEAD-sha>]\n");
      return;
    }
    const evidence = await run(options);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
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
