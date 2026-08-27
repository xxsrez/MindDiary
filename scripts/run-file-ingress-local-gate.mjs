#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLocalReceipt,
  loadFileIngressEvidenceConfig,
  resolveCandidateSha,
  stableJson,
  verifyDeterministicFixtures,
} from "./lib/file-ingress-evidence.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    assert(value !== undefined, `missing value for ${argument}`);
    index += 1;
    if (argument === "--sha") options.candidate = value;
    else if (argument === "--output") options.output = value;
    else throw new Error(`unknown argument ${argument}`);
  }
  assert(options.candidate, "--sha is required");
  assert(options.output, "--output is required");
  return options;
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requireExactCleanCandidate(repositoryRoot, candidateSha) {
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  assert(head === candidateSha, "local gate must run from the exact candidate checked out at HEAD");
  const status = git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
  assert(status.length === 0, "local gate requires a clean candidate worktree");
}

async function writeReceipt(repositoryRoot, output, receipt) {
  const outputPath = resolve(repositoryRoot, output);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, stableJson(receipt), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return outputPath;
}

export async function runFileIngressLocalGate({
  repositoryRoot,
  candidate,
  output,
  execute = execFileSync,
}) {
  const config = await loadFileIngressEvidenceConfig(repositoryRoot);
  const candidateSha = resolveCandidateSha(repositoryRoot, candidate);
  requireExactCleanCandidate(repositoryRoot, candidateSha);
  const statuses = new Map(config.registry.assertion_ids.local.map((id) => [id, "not_run"]));
  statuses.set("local.registry.closed-versioned", "passed");
  try {
    await verifyDeterministicFixtures(config.fixtures);
    statuses.set("local.fixtures.deterministic-streamed", "passed");
  } catch {
    statuses.set("local.fixtures.deterministic-streamed", "failed");
  }

  if (statuses.get("local.fixtures.deterministic-streamed") === "passed") {
    for (const group of config.registry.local_command_groups) {
      const [command, ...args] = group.command;
      let passed = true;
      try {
        execute(command, args, {
          cwd: repositoryRoot,
          stdio: "inherit",
          env: { ...process.env, CI: "true" },
        });
      } catch {
        passed = false;
      }
      for (const id of group.assertion_ids) statuses.set(id, passed ? "passed" : "failed");
      if (!passed) break;
    }
  }

  const receipt = createLocalReceipt({
    registry: config.registry,
    candidateSha,
    registrySha256: config.registrySha256,
    fixturePlanSha256: config.fixturePlanSha256,
    assertionStatuses: statuses,
  });
  const outputPath = await writeReceipt(repositoryRoot, output, receipt);
  return Object.freeze({ receipt, outputPath });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const { receipt, outputPath } = await runFileIngressLocalGate({
    repositoryRoot,
    candidate: options.candidate,
    output: options.output,
  });
  console.log(
    `File-ingress local gate ${receipt.status} for ${receipt.candidate_sha}: ${relative(repositoryRoot, outputPath)}`,
  );
  if (receipt.status === "failed") process.exitCode = 1;
  else if (receipt.status !== "passed") process.exitCode = 2;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`File-ingress local gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
