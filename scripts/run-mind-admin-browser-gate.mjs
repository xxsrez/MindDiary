#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { chromium } from "@playwright/test";

import { verifyToolchainObservation } from "./run-admin-shell-browser-gate.mjs";
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
const EVIDENCE_SCHEMA = "mind-diary/mind-admin-browser-evidence/v1";
const PLAYWRIGHT_CLI = resolve(ROOT, "node_modules/@playwright/test/cli.js");
const PLAYWRIGHT_CONFIG = resolve(ROOT, "playwright.md351.config.mjs");
const TEST_FILE = "tests/browser/mind-admin-journey/mind-admin-journey.spec.mjs";
const execFileAsync = promisify(execFile);

export const MIND_ADMIN_BROWSER_ASSERTION_IDS = Object.freeze([
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

export const MIND_ADMIN_BROWSER_SOURCE_FILES = Object.freeze([
  "docs/operations/mind-admin-browser-uat-runbook.md",
  "docs/operations/ship-work-release-profile.md",
  "docs/specs/release-0.3-traceability.md",
  "package.json",
  "playwright.md351.config.mjs",
  "scripts/join-mind-admin-uat-readback.mjs",
  "scripts/lib/mind-admin-browser-reporter.mjs",
  "scripts/run-mind-admin-browser-gate.mjs",
  "tests/conformance/mind-admin-browser-gate.test.mjs",
  "tests/conformance/mind-admin-uat-readback-join.test.mjs",
  "tests/conformance/release-0.3-traceability-contract.test.mjs",
  "tests/fixtures/release-0.3-traceability/contract.v1.json",
  TEST_FILE,
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
    return (await execFileAsync("git", args, { cwd: ROOT, encoding: "utf8" })).stdout.trim();
  } catch {
    fail("git_read_failed");
  }
}

function runProcess(command, args, { env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.once("error", rejectPromise);
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code, signal) => resolvePromise({ code: code ?? 1, signal }));
  });
}

async function exactCandidate(requestedCandidate) {
  const current = candidateSha(await git("rev-parse", "HEAD"));
  const requested = requestedCandidate === undefined ? current : candidateSha(requestedCandidate);
  if (current !== requested) fail("candidate_sha_not_head");
  if ((await git("status", "--porcelain", "--untracked-files=all")).length !== 0) {
    fail("candidate_worktree_not_clean");
  }
  return Object.freeze({ sha: current, tree: candidateSha(await git("rev-parse", "HEAD^{tree}")) });
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
  const [rootPackage, lockfile, installedPlaywright, installedBrowser, installedCore,
    browserManifest, cliResult] = await Promise.all([
    readFile(resolve(ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/@playwright/test/package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/@playwright/browser-chromium/package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/playwright-core/package.json"), "utf8").then(JSON.parse),
    readFile(resolve(ROOT, "node_modules/playwright-core/browsers.json"), "utf8").then(JSON.parse),
    execFileAsync(process.execPath, [PLAYWRIGHT_CLI, "--version"], { cwd: ROOT, encoding: "utf8" }),
  ]);
  const executablePath = chromium.executablePath();
  const browserResult = await execFileAsync(executablePath, ["--version"], { cwd: ROOT, encoding: "utf8" });
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
  return Object.freeze({ ...verified, chromium_executable_sha256: await fileSha256(executablePath) });
}

function verifiedAssertions(report) {
  if (report?.status !== "passed" || !Array.isArray(report.tests)) fail("playwright_report_not_passed");
  const counts = new Map();
  for (const row of report.tests) {
    if (typeof row?.assertion_id !== "string") fail("playwright_assertion_id_missing");
    if (row.status !== "passed") fail("playwright_assertion_failed");
    counts.set(row.assertion_id, (counts.get(row.assertion_id) ?? 0) + 1);
  }
  if (
    [...counts.keys()].some((id) => !MIND_ADMIN_BROWSER_ASSERTION_IDS.includes(id)) ||
    MIND_ADMIN_BROWSER_ASSERTION_IDS.some((id) => counts.get(id) !== 1)
  ) fail("playwright_assertion_registry_mismatch");
  return Object.freeze(MIND_ADMIN_BROWSER_ASSERTION_IDS.map((id) => Object.freeze({ id, status: "passed" })));
}

export function createEvidence({ candidate, tree, toolchain, sourceHashes, assertions, startedAt, completedAt }) {
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    hosted_evidence: false,
    acceptance: "local-only",
    provenance: "exact-local-playwright-composition",
    candidate_sha: candidate,
    candidate_tree_sha: tree,
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
      kind: "synthetic-product-site-run-owned-admin-journey",
      identity: "server-bound-isolated-actors",
      storage: "isolated-fake-d1-r2",
      listener: "ephemeral-loopback",
      cleanup: "ordinary-mind-deleted-and-absence-read-back",
    }),
    executed_sources: sourceHashes,
    assertions,
    limitations: Object.freeze([
      "local runtime and synthetic storage do not prove hosted deployment behavior",
      "receipt contains no provider or in-app Browser observation provenance",
    ]),
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
  const sourceHashes = Object.freeze(Object.fromEntries(await Promise.all(
    MIND_ADMIN_BROWSER_SOURCE_FILES.map(async (path) => [path, await fileSha256(resolve(ROOT, path))]),
  )));
  const diagnosticsDirectory = await mkdtemp(join(tmpdir(), "mind-diary-md351-browser-"));
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
      MIND_DIARY_MD351_DIAGNOSTICS: diagnosticsDirectory,
      MIND_DIARY_MD351_REPORT: reporterOutput,
      MIND_DIARY_MD351_CHROMIUM_EXECUTABLE: toolchain.executable_path,
      MIND_DIARY_MD351_RUN_NONCE: randomBytes(6).toString("hex"),
    },
  });
  if (child.code !== 0) {
    process.stderr.write(`MD-351 synthetic-only browser diagnostics: ${diagnosticsDirectory}\n`);
    fail("playwright_gate_failed");
  }
  const assertions = verifiedAssertions(JSON.parse(await readFile(reporterOutput, "utf8")));
  const evidence = createEvidence({
    candidate: candidate.sha,
    tree: candidate.tree,
    toolchain,
    sourceHashes,
    assertions,
    startedAt,
    completedAt: now().toISOString(),
  });
  await writeFile(required(options.evidence_out, "missing_evidence_out"), `${JSON.stringify(evidence, null, 2)}\n`, {
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
      process.stdout.write("Usage: npm run gate:mind-admin-browser -- --evidence-out <private-temp-path> [--candidate-sha <exact-clean-HEAD-sha>]\n");
      return;
    }
    const evidence = await run(options);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, candidate_sha: evidence.candidate_sha, artifact_sha256: evidence.artifact_sha256 })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProbeFailure ? error.code : safeCode(error?.code),
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
