#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  Release03AuthorityTargetEvidenceError,
  RELEASE_03_LOCAL_SOURCE_PATHS,
  RELEASE_03_LOCAL_TEST_PATHS,
  createRelease03AuthorityTargetLocalEvidence,
} from "./lib/release-0.3-authority-target-evidence.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

function fail(code) {
  throw new Release03AuthorityTargetEvidenceError(code);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function git(args) {
  return execFileAsync("git", args, { cwd: ROOT, encoding: "utf8" });
}

async function exactHead(candidateSha) {
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) fail("invalid_candidate_sha");
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (head !== candidateSha) fail("candidate_sha_not_head");
  const status = (await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  if (status !== "") fail("candidate_worktree_not_clean");
  return head;
}

async function runNode(args, code) {
  try {
    return await execFileAsync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const lines = typeof error?.stderr === "string"
      ? error.stderr.trim().split("\n").reverse()
      : [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(parsed.code)) {
          fail(parsed.code);
        }
      } catch (parseError) {
        if (parseError instanceof Release03AuthorityTargetEvidenceError) throw parseError;
      }
    }
    fail(code);
  }
}

async function sourceHashes() {
  const rows = await Promise.all(RELEASE_03_LOCAL_SOURCE_PATHS.map(async (path) => [
    path,
    sha256(await readFile(resolve(ROOT, path))),
  ]));
  return Object.fromEntries(rows);
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("missing_cli_value");
    if (Object.hasOwn(options, key)) fail("duplicate_cli_argument");
    options[key] = value;
    index += 1;
  }
  const allowed = new Set(["candidate_sha", "evidence_out", "marketplace_root"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) fail("unsupported_cli_argument");
  if (typeof options.candidate_sha !== "string" || typeof options.evidence_out !== "string") {
    fail("missing_cli_value");
  }
  return options;
}

export async function run(options, { now = () => new Date() } = {}) {
  await exactHead(options.candidate_sha);
  const reservation = await reservePrivateTempOutput(resolve(options.evidence_out), {
    repositoryRoot: ROOT,
    errorCode: "unsafe_authority_target_local_output",
  });
  const privateRunDirectory = await mkdtemp(join(tmpdir(), "mind-diary-r03-authority-"));
  const syntheticPath = join(privateRunDirectory, "synthetic.json");
  const oauthPath = join(privateRunDirectory, "oauth.json");
  const startedAt = now().toISOString();
  try {
    await runNode([
      "scripts/run-synthetic-multi-principal-probe.mjs",
      "--candidate-sha", options.candidate_sha,
      "--evidence-out", syntheticPath,
    ], "synthetic_probe_failed");
    const oauthArgs = [
      "scripts/run-oauth-direct-plugin-probe.mjs",
      "--candidate-sha", options.candidate_sha,
      "--evidence-out", oauthPath,
    ];
    if (typeof options.marketplace_root === "string") {
      oauthArgs.push("--marketplace-root", options.marketplace_root);
    }
    await runNode(oauthArgs, "oauth_probe_failed");

    const tests = [];
    for (const path of RELEASE_03_LOCAL_TEST_PATHS) {
      const result = await runNode(["--test", path], "authority_target_test_failed");
      tests.push(Object.freeze({
        path,
        status: "passed",
        stdout_sha256: sha256(result.stdout),
      }));
    }
    await exactHead(options.candidate_sha);
    const evidence = createRelease03AuthorityTargetLocalEvidence({
      candidateSha: options.candidate_sha,
      syntheticEvidence: JSON.parse(await readFile(syntheticPath, "utf8")),
      oauthEvidence: JSON.parse(await readFile(oauthPath, "utf8")),
      tests,
      sourceHashes: await sourceHashes(),
      startedAt,
      completedAt: now().toISOString(),
    });
    await reservation.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } catch (error) {
    await reservation.abort();
    throw error;
  } finally {
    await rm(privateRunDirectory, { recursive: true, force: true });
  }
}

function help() {
  return [
    "Usage: npm run gate:release-0.3-authority-target --",
    "  --candidate-sha <exact-clean-HEAD-sha>",
    "  --evidence-out <new-private-temp-path>",
    "  [--marketplace-root <clean-marketplace-checkout>]",
  ].join(" ");
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else {
      const evidence = await run(options);
      process.stdout.write(`${JSON.stringify({
        status: evidence.status,
        candidate_sha: evidence.candidate_sha,
        hosted_status: evidence.hosted_status,
        artifact_sha256: evidence.artifact_sha256,
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof Release03AuthorityTargetEvidenceError
        ? error.code
        : "authority_target_local_gate_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
