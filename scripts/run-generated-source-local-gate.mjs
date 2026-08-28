#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  candidateSha,
  canonical,
  digest,
  fail,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CONTRACT_PATH = resolve(ROOT, "tests/fixtures/generated-source-uat/contract.v1.json");
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PRIVATE_TEXT = /(?:mdp_v1_|mdo_(?:code|access|refresh)_|authorization|cookie|download_url|https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}|\/(?:Users|private|tmp)\/)/iu;

async function git(...args) {
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun(Buffer.concat(stdout).toString("utf8").trim())
      : rejectRun(new Error("git_read_failed")));
  });
  return result;
}

async function exactCandidate(requested) {
  const current = candidateSha(await git("rev-parse", "HEAD"));
  const expected = requested === undefined ? current : candidateSha(requested);
  if (expected !== current) fail("candidate_sha_not_head");
  if ((await git("status", "--porcelain", "--untracked-files=all")) !== "") {
    fail("candidate_worktree_not_clean");
  }
  return current;
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

function runTests(paths) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--test", ...paths], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function validateContract(value) {
  if (value?.schema !== "mind-diary/generated-source-uat-contract/v1" ||
      value.task !== "MD-290" || !Array.isArray(value.local_suites) ||
      !Array.isArray(value.required_test_names) || !Array.isArray(value.assertion_ids) ||
      value.policy?.local_hosted_evidence !== false ||
      value.policy?.join_can_assert_hosted_pass !== false) fail("invalid_generated_source_contract");
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

export function createLocalEvidence({ candidate, contract, suiteReceipts, startedAt, completedAt }) {
  const unsigned = Object.freeze({
    schema: contract.local_receipt_schema,
    status: "passed",
    hosted_evidence: false,
    acceptance: "local-deterministic-only",
    provenance: "exact-candidate-local-execution",
    candidate_sha: candidate,
    fixture: Object.freeze({
      bounded_exact_bytes: 4_194_304,
      bounded_plus_one_bytes: 4_194_305,
      server_stream_class: "deterministic-synthetic-binary",
      corpus_class: "synthetic-no-user-data",
    }),
    suites: Object.freeze(suiteReceipts),
    assertions: Object.freeze(contract.assertion_ids.map((id) => Object.freeze({ id, status: "passed" }))),
    hosted_rows_remaining: Object.freeze([
      "exact Sites candidate/deployment lineage",
      "restricted UAT private run-owned Mind and short credential",
      "same-run actor-owned Web target, export and cleanup",
      "distinct redeploy exact path/size/SHA/bytes read-back",
    ]),
    public_capability_claim: "not_available",
    started_at: startedAt,
    completed_at: completedAt,
  });
  const evidence = Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
  const serialized = JSON.stringify(evidence);
  if (PRIVATE_TEXT.test(serialized) || !SHA256.test(evidence.artifact_sha256)) {
    fail("unsafe_generated_source_evidence");
  }
  return evidence;
}

export async function run(options, { now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const candidate = await exactCandidate(options.candidate_sha);
  const contract = validateContract(JSON.parse(await readFile(CONTRACT_PATH, "utf8")));
  const result = await runTests(contract.local_suites);
  if (result.code !== 0) fail("generated_source_local_matrix_failed");
  for (const name of contract.required_test_names) {
    if (!result.stdout.includes(name)) fail("generated_source_test_evidence_missing");
  }
  const suiteReceipts = await Promise.all(contract.local_suites.map(async (path) => Object.freeze({
    path,
    sha256: await fileSha256(resolve(ROOT, path)),
    status: "passed",
  })));
  const evidence = createLocalEvidence({
    candidate,
    contract,
    suiteReceipts,
    startedAt,
    completedAt: now().toISOString(),
  });
  const output = await reservePrivateTempOutput(options.evidence_out, {
    repositoryRoot: ROOT,
    errorCode: "unsafe_evidence_output",
  });
  try {
    await output.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await output.abort();
  }
  return evidence;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run gate:generated-source-local -- --candidate-sha <exact-clean-HEAD-sha> --evidence-out <new-private-temp-file>\n");
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
