#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  Release03AuthorityTargetEvidenceError,
  createRelease03AuthorityTargetUatJoin,
} from "./lib/release-0.3-authority-target-evidence.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function fail(code) {
  throw new Release03AuthorityTargetEvidenceError(code);
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
  const allowed = new Set(["local_evidence", "pool_evidence", "hosted_observation", "output"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) fail("unsupported_cli_argument");
  if ([...allowed].some((key) => typeof options[key] !== "string")) fail("missing_cli_value");
  return options;
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch {
    fail(code);
  }
}

export async function run(options) {
  const reservation = await reservePrivateTempOutput(resolve(options.output), {
    repositoryRoot: ROOT,
    errorCode: "unsafe_authority_target_join_output",
  });
  try {
    const evidence = createRelease03AuthorityTargetUatJoin({
      localEvidence: await readJson(options.local_evidence, "invalid_local_evidence_file"),
      poolEvidence: await readJson(options.pool_evidence, "invalid_pool_evidence_file"),
      hostedObservation: await readJson(
        options.hosted_observation,
        "invalid_hosted_observation_file",
      ),
    });
    await reservation.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } catch (error) {
    await reservation.abort();
    throw error;
  }
}

function help() {
  return [
    "Usage: npm run join:release-0.3-authority-target --",
    "  --local-evidence <private-local-receipt>",
    "  --pool-evidence <private-pool-readiness-receipt>",
    "  --hosted-observation <private-same-run-hosted-observation>",
    "  --output <new-private-temp-path>",
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
        deployment_id: evidence.deployment_id,
        artifact_sha256: evidence.artifact_sha256,
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof Release03AuthorityTargetEvidenceError
        ? error.code
        : "authority_target_join_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
