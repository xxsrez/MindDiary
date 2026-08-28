#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createGoogleDriveUatStructuralJoin,
} from "./lib/google-drive-connector-uat-evidence.mjs";
import {
  candidateSha,
  fail,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_PLAN_PATH = resolve(
  ROOT,
  "tests/fixtures/google-drive-connector-uat/synthetic-fixture-plan.v1.json",
);
const HOSTING_PATH = resolve(ROOT, "apps/mind-diary-site/.openai/hosting.json");

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
  const allowed = [
    "plan_receipt",
    "sites_readback",
    "provider_readback",
    "product_readback",
    "artifact_archive",
    "candidate_sha",
    "join_out",
  ];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) fail("unsupported_cli_argument");
  }
  for (const key of allowed) {
    if (typeof options[key] !== "string") fail(`missing_${key}`);
  }
  return options;
}

async function json(path, code) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch {
    fail(code);
  }
}

export async function joinGoogleDriveConnectorUatReadback(options) {
  const candidate = candidateSha(options.candidate_sha);
  const [
    planReceipt,
    sitesReadback,
    providerReadback,
    productReadback,
    archiveBytes,
    fixturePlan,
    hosting,
  ] = await Promise.all([
    json(options.plan_receipt, "invalid_plan_receipt_file"),
    json(options.sites_readback, "invalid_sites_readback_file"),
    json(options.provider_readback, "invalid_provider_readback_file"),
    json(options.product_readback, "invalid_product_readback_file"),
    readFile(resolve(options.artifact_archive)).catch(() => fail("invalid_artifact_archive")),
    json(FIXTURE_PLAN_PATH, "invalid_google_drive_uat_fixture_file"),
    json(HOSTING_PATH, "invalid_hosting_configuration"),
  ]);
  const join = createGoogleDriveUatStructuralJoin({
    planReceipt,
    sitesReadback,
    providerReadback,
    productReadback,
    archiveBytes,
    fixturePlan,
  }, {
    candidate,
    projectId: hosting.project_id,
  });
  const output = await reservePrivateTempOutput(resolve(options.join_out), {
    repositoryRoot: ROOT,
    errorCode: "unsafe_google_drive_uat_join_output",
  });
  try {
    await output.write(`${JSON.stringify(join, null, 2)}\n`);
  } catch (error) {
    await output.abort();
    throw error;
  }
  return join;
}

function usage() {
  return `Usage:\n  npm run join:google-drive-connector-uat-readback -- --plan-receipt <private-plan.json> --sites-readback <private-sites.json> --provider-readback <private-drive.json> --product-readback <private-product.json> --artifact-archive <exact-site.tgz> --candidate-sha <exact-deployed-sha> --join-out <owner-private-temp-directory/new-join.json>\n\nThe join checks closed schemas, exact lineage, byte snapshots, negative cases and cleanup. Local files can never produce hosted PASS.`;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const join = await joinGoogleDriveConnectorUatReadback(options);
    process.stdout.write(`${JSON.stringify({
      status: join.status,
      hosted_evidence: join.hosted_evidence,
      acceptance: join.acceptance,
      candidate_sha: join.candidate_sha,
      deployment_after_id: join.deployment_after_id,
      artifact_sha256: join.artifact_sha256,
    })}\n`);
  } catch (error) {
    const code = error instanceof ProbeFailure ? error.code : safeCode(error?.code);
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
