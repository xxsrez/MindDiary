#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  UatOperatorDirectoryJoinError,
  createUatOperatorDirectoryJoinEvidence,
} from "./lib/uat-operator-directory-join.mjs";

function fail(code) {
  throw new UatOperatorDirectoryJoinError(code);
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      fail("missing_cli_value");
    }
    if (Object.hasOwn(options, key)) fail("duplicate_cli_argument");
    options[key] = value;
    index += 1;
  }
  const required = [
    "canary_evidence",
    "pool_evidence",
    "provider_evidence",
    "cleanup_evidence",
    "evidence_out",
  ];
  if (
    Object.keys(options).some((key) => !required.includes(key)) ||
    required.some((key) => typeof options[key] !== "string")
  ) fail("invalid_cli_arguments");
  return options;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("invalid_input_file");
  }
}

export async function run(options, { now = () => new Date().toISOString() } = {}) {
  const [canaryEvidence, poolEvidence, providerEvidence, cleanupEvidence] =
    await Promise.all([
      readJson(options.canary_evidence),
      readJson(options.pool_evidence),
      readJson(options.provider_evidence),
      readJson(options.cleanup_evidence),
    ]);
  const evidence = createUatOperatorDirectoryJoinEvidence({
    canaryEvidence,
    poolEvidence,
    providerEvidence,
    cleanupEvidence,
    observedAtUtc: now(),
  });
  await writeFile(options.evidence_out, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return Object.freeze({
    status: "passed",
    evidence_path: options.evidence_out,
    artifact_sha256: evidence.artifact_sha256,
  });
}

function help() {
  return "Usage: node scripts/run-uat-operator-directory-join.mjs --canary-evidence <path> --pool-evidence <path> --provider-evidence <path> --cleanup-evidence <path> --evidence-out <path>";
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else process.stdout.write(`${JSON.stringify(await run(options))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof UatOperatorDirectoryJoinError
        ? error.code
        : "operator_directory_join_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
