#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  createGoogleDriveUatPlanReceipt,
} from "./lib/google-drive-connector-uat-evidence.mjs";
import {
  candidateSha,
  fail,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CONTRACT_PATH = resolve(
  ROOT,
  "tests/fixtures/google-drive-connector-uat/contract.v1.json",
);
const FIXTURE_PLAN_PATH = resolve(
  ROOT,
  "tests/fixtures/google-drive-connector-uat/synthetic-fixture-plan.v1.json",
);
const HOSTING_PATH = resolve(ROOT, "apps/mind-diary-site/.openai/hosting.json");
const execFileAsync = promisify(execFile);

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
    if (!["candidate_sha", "deployment_id", "pool_readiness_receipt", "evidence_out"].includes(key)) {
      fail("unsupported_cli_argument");
    }
  }
  for (const key of ["candidate_sha", "deployment_id", "pool_readiness_receipt", "evidence_out"]) {
    if (typeof options[key] !== "string") fail(`missing_${key}`);
  }
  return options;
}

async function git(...args) {
  try {
    return (await execFileAsync("git", args, { cwd: ROOT, encoding: "utf8" })).stdout.trim();
  } catch {
    fail("git_read_failed");
  }
}

async function exactCleanCandidate(requested) {
  const current = candidateSha(await git("rev-parse", "HEAD"));
  if (candidateSha(requested) !== current) fail("candidate_sha_not_head");
  if ((await git("status", "--porcelain", "--untracked-files=all")).length !== 0) {
    fail("candidate_worktree_not_clean");
  }
  return current;
}

async function json(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(code);
  }
}

export async function prepareGoogleDriveConnectorUat(options, {
  now = () => new Date().toISOString(),
} = {}) {
  const candidate = await exactCleanCandidate(options.candidate_sha);
  const [contract, fixturePlan, poolReadinessReceipt, hosting] = await Promise.all([
    json(CONTRACT_PATH, "invalid_google_drive_uat_contract_file"),
    json(FIXTURE_PLAN_PATH, "invalid_google_drive_uat_fixture_file"),
    json(resolve(options.pool_readiness_receipt), "invalid_pool_readiness_receipt_file"),
    json(HOSTING_PATH, "invalid_hosting_configuration"),
  ]);
  const receipt = createGoogleDriveUatPlanReceipt({
    contract,
    fixturePlan,
    poolReadinessReceipt,
    candidate,
    projectId: hosting.project_id,
    deployment: options.deployment_id,
    observedAtUtc: now(),
  });
  const output = await reservePrivateTempOutput(resolve(options.evidence_out), {
    repositoryRoot: ROOT,
    errorCode: "unsafe_google_drive_uat_evidence_output",
  });
  try {
    await output.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    await output.abort();
    throw error;
  }
  return receipt;
}

function usage() {
  return `Usage:\n  npm run uat:prepare-google-drive-connector -- --candidate-sha <exact-clean-HEAD-sha> --deployment-id <current-appgdep-id> --pool-readiness-receipt <private-ready-receipt.json> --evidence-out <owner-private-temp-directory/new-plan.json>\n\nThis command performs local preflight only. It never opens a browser, contacts Google Drive or Sites, mutates a provider, or creates hosted acceptance evidence.`;
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const receipt = await prepareGoogleDriveConnectorUat(options);
    process.stdout.write(`${JSON.stringify({
      status: receipt.status,
      hosted_evidence: receipt.hosted_evidence,
      candidate_sha: receipt.candidate_sha,
      deployment_id: receipt.deployment_id,
      artifact_sha256: receipt.artifact_sha256,
    })}\n`);
  } catch (error) {
    const code = error instanceof ProbeFailure ? error.code : safeCode(error?.code);
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
