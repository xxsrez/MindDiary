#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { resolvePrivateTempOutputPath } from "./lib/private-evidence-output.mjs";
import { verifyToolchainObservation } from "./run-admin-shell-browser-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const EVIDENCE_SCHEMA = "mind-diary/import-export-browser-evidence/v1";
const FIXTURE_SCHEMA = "mind-diary/import-export-generated-fixtures/v1";
const PLAYWRIGHT_CLI = resolve(ROOT, "node_modules/@playwright/test/cli.js");
const PLAYWRIGHT_CONFIG = resolve(ROOT, "playwright.md363.config.mjs");
const TEST_FILE = "tests/browser/import-export-uat/import-export.spec.mjs";
const execFileAsync = promisify(execFile);

export const IMPORT_EXPORT_ASSERTION_IDS = Object.freeze([
  "IE-FIXTURE-01",
  "IE-IMPORT-01",
  "IE-IMPORT-02",
  "IE-IMPORT-03",
  "IE-IMPORT-04",
  "IE-IMPORT-05",
  "IE-IMPORT-06",
  "IE-HISTORY-01",
  "IE-EXPORT-01",
  "IE-EXPORT-02",
  "IE-EXPORT-03",
  "IE-ACCESS-01",
  "IE-CLEANUP-01",
]);

export const RUNTIME_SUITES = Object.freeze([
  "tests/unit/markdown-import-ui.test.mjs",
  "tests/unit/export-workflow-ui.test.mjs",
  "tests/integration/markdown-imports.test.mjs",
  "tests/integration/export-exact-revision.test.mjs",
  "tests/integration/durable-export-jobs.test.mjs",
  "tests/integration/export-download-grants.test.mjs",
  "tests/conformance/export-contract.test.mjs",
  "tests/conformance/export-job-contract.test.mjs",
]);

const text = (value) => Buffer.from(value, "utf8");
const knownOpaque = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0x4d, 0x44, 0x33, 0x36, 0x33, 0x0a]);
const oversize = Buffer.alloc(1_048_577, 0x61);

const FIXTURES = Object.freeze([
  Object.freeze({
    id: "historical-index",
    path: "historical/index.md",
    bytes: text("---\nokf_version: \"0.2\"\n---\n\n# Historical fixture\n"),
  }),
  Object.freeze({
    id: "baseline-index",
    path: "baseline/index.md",
    bytes: text("---\nokf_version: \"0.2\"\n---\n\n# Baseline fixture\n\n- [Before](concepts/before.md)\n"),
  }),
  Object.freeze({
    id: "baseline-concept",
    path: "baseline/concepts/before.md",
    bytes: text("---\ntype: Concept\ntitle: Before\n---\n\n# Before\n\nPreserved in immutable history.\n"),
  }),
  Object.freeze({ id: "known-opaque", path: "baseline/assets/known.bin", bytes: knownOpaque }),
  Object.freeze({
    id: "import-index",
    path: "import/index.md",
    bytes: text("---\nokf_version: \"0.2\"\n---\n\n# Imported fixture\n\n- [Alpha](concepts/alpha.md)\n"),
  }),
  Object.freeze({
    id: "import-concept",
    path: "import/concepts/alpha.md",
    bytes: text("---\ntype: Concept\ntitle: Alpha\nunknown_field: exact\n---\n\n# Alpha\n\nImported byte-for-byte.\n"),
  }),
  Object.freeze({ id: "invalid-utf8", path: "invalid/broken.md", bytes: Buffer.from([0xff, 0xfe, 0x00]) }),
  Object.freeze({ id: "invalid-profile", path: "invalid/notes.txt", bytes: text("not Markdown\n") }),
  Object.freeze({ id: "size-plus-one", path: "limits/size-plus-one.md", bytes: oversize }),
]);

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

async function exactCandidate(requestedCandidate) {
  const current = candidateSha(await git("rev-parse", "HEAD"));
  const requested = requestedCandidate === undefined ? current : candidateSha(requestedCandidate);
  if (requested !== current) fail("candidate_sha_not_head");
  if ((await git("status", "--porcelain", "--untracked-files=all")).length !== 0) {
    fail("candidate_worktree_not_clean");
  }
  return current;
}

function runProcess(command, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.once("error", rejectRun);
    child.stdout.on("data", (chunk) => {
      if (capture) stdout.push(Buffer.from(chunk));
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (capture) stderr.push(Buffer.from(chunk));
      else process.stderr.write(chunk);
    });
    child.once("exit", (code, signal) => resolveRun({
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
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

export async function generateFixtureWorkspace(directory) {
  const files = [];
  for (const fixture of FIXTURES) {
    const path = resolve(directory, fixture.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fixture.bytes, { flag: "wx" });
    files.push(Object.freeze({
      id: fixture.id,
      relative_path: fixture.path,
      size: fixture.bytes.byteLength,
      sha256: sha256Bytes(fixture.bytes),
    }));
  }
  const unsigned = Object.freeze({
    schema: FIXTURE_SCHEMA,
    generator: "mind-diary-md363-deterministic-v1",
    files,
    known_opaque_bytes_hex: knownOpaque.toString("hex"),
    import_file_limit_bytes: 1_048_576,
    size_plus_one_bytes: oversize.byteLength,
  });
  const manifest = Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
  await writeFile(resolve(directory, "fixture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

function verifiedAssertions(report) {
  if (report?.status !== "passed" || !Array.isArray(report.tests)) {
    fail("playwright_report_not_passed");
  }
  const counts = new Map();
  for (const value of report.tests) {
    if (typeof value?.assertion_id !== "string") fail("playwright_assertion_id_missing");
    if (value.status !== "passed") fail("playwright_assertion_failed");
    counts.set(value.assertion_id, (counts.get(value.assertion_id) ?? 0) + 1);
  }
  if ([...counts].some(([id]) => !IMPORT_EXPORT_ASSERTION_IDS.includes(id)) ||
      IMPORT_EXPORT_ASSERTION_IDS.some((id) => counts.get(id) !== 1)) {
    fail("playwright_assertion_registry_mismatch");
  }
  return Object.freeze(IMPORT_EXPORT_ASSERTION_IDS.map((id) =>
    Object.freeze({ id, status: "passed" })));
}

export function createEvidence({ candidate, toolchain, fixture, runtimeSuites, assertions, startedAt, completedAt }) {
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    hosted_evidence: false,
    acceptance: "local-deterministic-only",
    provenance: "exact-candidate-local-execution",
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
      kind: "generated-temporary-import-export-matrix",
      manifest_sha256: fixture.artifact_sha256,
      generator: fixture.generator,
      files: fixture.files,
      known_opaque_bytes_hex: fixture.known_opaque_bytes_hex,
      input_selection: "playwright-set-input-files",
      corpus_class: "synthetic-no-user-data",
    }),
    runtime_suites: runtimeSuites,
    assertions,
    diagnostics: Object.freeze({
      listener: "ephemeral-loopback",
      browser_state: "isolated-no-user-profile",
      screenshots: "failure-only-synthetic-fixture",
      trace: "disabled",
      video: "disabled",
      hosted_claim: "forbidden",
    }),
    started_at: startedAt,
    completed_at: completedAt,
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export async function finalizeGateWorkspace(directory, {
  preserveDiagnostics,
  now = () => new Date(),
} = {}) {
  if (!preserveDiagnostics) {
    await rm(directory, { recursive: true, force: true });
    return Object.freeze({ preserved: false });
  }
  const cleanupAfter = new Date(now().getTime() + 24 * 60 * 60 * 1_000).toISOString();
  const guidancePath = resolve(directory, "CLEANUP-GUIDANCE.txt");
  await writeFile(guidancePath, [
    "MD-363 generated-only Playwright diagnostics were preserved after a failed run.",
    `Inspect and delete this entire directory by ${cleanupAfter}.`,
    `Directory: ${directory}`,
    "Deletion command:",
    `node -e 'require(\"node:fs\").rmSync(process.argv[1], { recursive: true, force: true })' ${JSON.stringify(directory)}`,
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  return Object.freeze({ preserved: true, cleanupAfter, guidancePath });
}

export async function run(options, { now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const evidenceOutput = await resolvePrivateTempOutputPath(options.evidence_out, {
    repositoryRoot: ROOT,
    errorCode: "unsafe_evidence_output",
  });
  const candidate = await exactCandidate(options.candidate_sha);
  const toolchain = await installedToolchain();
  const temporary = await mkdtemp(join(tmpdir(), "mind-diary-md363-gate-"));
  const fixtureRoot = resolve(temporary, "fixtures");
  const reporterOutput = resolve(temporary, "playwright-assertions.json");
  let preserveDiagnostics = false;
  await mkdir(fixtureRoot);
  try {
    const fixture = await generateFixtureWorkspace(fixtureRoot);
    const runtime = await runProcess(process.execPath, ["--test", ...RUNTIME_SUITES]);
    if (runtime.code !== 0) fail("runtime_matrix_failed");
    const runtimeSuites = Object.freeze(await Promise.all(RUNTIME_SUITES.map(async (path) =>
      Object.freeze({ path, sha256: await fileSha256(resolve(ROOT, path)), status: "passed" }))));
    preserveDiagnostics = true;
    const browser = await runProcess(process.execPath, [
      PLAYWRIGHT_CLI,
      "test",
      TEST_FILE,
      `--config=${PLAYWRIGHT_CONFIG}`,
      "--workers=1",
    ], {
      env: {
        ...process.env,
        MIND_DIARY_MD363_DIAGNOSTICS: resolve(temporary, "diagnostics"),
        MIND_DIARY_MD363_REPORT: reporterOutput,
        MIND_DIARY_MD363_CHROMIUM_EXECUTABLE: toolchain.executable_path,
        MIND_DIARY_MD363_FIXTURE_ROOT: fixtureRoot,
      },
    });
    if (browser.code !== 0) {
      fail("playwright_gate_failed");
    }
    const assertions = verifiedAssertions(JSON.parse(await readFile(reporterOutput, "utf8")));
    preserveDiagnostics = false;
    const evidence = createEvidence({
      candidate,
      toolchain,
      fixture,
      runtimeSuites,
      assertions,
      startedAt,
      completedAt: now().toISOString(),
    });
    await writeFile(evidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return evidence;
  } finally {
    const disposition = await finalizeGateWorkspace(temporary, { preserveDiagnostics, now });
    if (disposition.preserved) {
      process.stderr.write(
        `MD-363 synthetic diagnostics preserved at ${temporary}; inspect and delete by ${disposition.cleanupAfter}.\n`,
      );
    }
  }
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run gate:import-export-browser -- --evidence-out <private-temp-path> [--candidate-sha <exact-clean-HEAD-sha>]\n");
      return;
    }
    const evidence = await run(options);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      hosted_evidence: evidence.hosted_evidence,
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
