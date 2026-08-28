#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  candidateSha,
  canonical,
  digest,
  fail,
  isRecord,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CONTRACT_PATH = resolve(ROOT, "tests/fixtures/generated-source-uat/contract.v1.json");
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DEPLOYMENT = /^appgdep_[a-z0-9]+$/u;
const VERSION = /^appgver_[a-z0-9]+$/u;
const PROJECT = /^appgprj_[a-z0-9]+$/u;
const PRIVATE_TEXT = /(?:mdp_v1_|mdo_(?:code|access|refresh)_|authorization|cookie|download_url|https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}|\/(?:Users|private|tmp)\/)/iu;

function exactArtifact(value, code) {
  if (!isRecord(value) || !SHA256.test(value.artifact_sha256 ?? "")) fail(code);
  const { artifact_sha256: supplied, ...unsigned } = value;
  if (supplied !== digest(canonical(unsigned))) fail(code);
  if (PRIVATE_TEXT.test(JSON.stringify(value))) fail(code);
  return value;
}

function assertionIds(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected.length) fail(code);
  const ids = value.map((entry, index) => {
    if (!isRecord(entry) || entry.id !== expected[index] || entry.status !== "passed") fail(code);
    return entry.id;
  });
  return Object.freeze(ids);
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
  const allowed = new Set([
    "candidate_sha", "setup_deployment_id", "verify_deployment_id",
    "local_receipt", "provider_readback", "browser_readback", "join_out",
  ]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail("unsupported_cli_argument");
  for (const key of allowed) if (!options[key]) fail(`missing_${key}`);
  return options;
}

function validateLocal(value, expected, contract) {
  exactArtifact(value, "invalid_local_receipt");
  if (value.schema !== contract.local_receipt_schema || value.status !== "passed" ||
      value.hosted_evidence !== false || value.acceptance !== "local-deterministic-only" ||
      value.candidate_sha !== expected.candidate || value.public_capability_claim !== "not_available") {
    fail("invalid_local_receipt");
  }
  assertionIds(value.assertions, contract.assertion_ids, "invalid_local_assertions");
  return Object.freeze({ artifactSha256: value.artifact_sha256 });
}

function validateProvider(value, expected, contract) {
  exactArtifact(value, "invalid_provider_readback");
  if (value.schema !== contract.provider_readback_schema ||
      value.generator !== "codex-sites-connector-readback/v1" ||
      value.candidate_sha !== expected.candidate ||
      value.setup_deployment_id !== expected.setup ||
      value.verify_deployment_id !== expected.verify ||
      !PROJECT.test(value.project_id ?? "") || !VERSION.test(value.version_id ?? "") ||
      value.setup_deployment_id === value.verify_deployment_id ||
      value.setup_status !== "succeeded" || value.verify_status !== "succeeded") {
    fail("provider_lineage_mismatch");
  }
  return Object.freeze({
    projectFingerprint: digest(value.project_id),
    versionFingerprint: digest(value.version_id),
    artifactSha256: value.artifact_sha256,
  });
}

function capabilityRows(value, code) {
  if (!Array.isArray(value) || value.length !== 2) fail(code);
  const rows = [...value].sort((left, right) => left.source_kind.localeCompare(right.source_kind));
  if (rows[0]?.source_kind !== "bounded_in_memory" || rows[1]?.source_kind !== "server_generated") {
    fail(code);
  }
  return rows;
}

function validateBrowser(value, expected, contract) {
  exactArtifact(value, "invalid_browser_readback");
  if (value.schema !== contract.browser_readback_schema ||
      value.generator !== "codex-in-app-browser-readback/v1" ||
      value.browser_surface !== "codex-in-app-browser" ||
      value.candidate_sha !== expected.candidate ||
      value.setup_deployment_id !== expected.setup ||
      value.verify_deployment_id !== expected.verify) fail("browser_lineage_mismatch");
  const rows = capabilityRows(value.capability_rows, "invalid_capability_rows");
  if (value.status === "blocked") {
    if (value.blocker_code !== "hosted_generated_sources_not_available" ||
        rows.some((row) => row.server_adapter_status !== "not_available" ||
          row.server_transport !== "none" || row.max_bytes !== 0)) {
      fail("invalid_hosted_blocker");
    }
    return Object.freeze({ kind: "blocked", rows, artifactSha256: value.artifact_sha256 });
  }
  if (value.status !== "passed" || value.blocker_code !== null) fail("invalid_browser_readback");
  assertionIds(value.assertions, contract.hosted_assertion_ids, "invalid_hosted_assertions");
  const readBack = value.read_back;
  const cleanup = value.cleanup;
  if (!isRecord(readBack) || readBack.exact_path !== true || readBack.exact_size !== true ||
      readBack.exact_sha256 !== true || readBack.exact_bytes !== true ||
      readBack.one_revision !== true || readBack.no_duplicate_object !== true ||
      !isRecord(cleanup) || cleanup.credential_revoked !== true ||
      cleanup.mind_deleted !== true || cleanup.target_absent !== true ||
      cleanup.read_back_complete !== true) fail("hosted_readback_incomplete");
  return Object.freeze({ kind: "passed", rows, artifactSha256: value.artifact_sha256 });
}

export function createStructuralJoin(input, expected, contract) {
  const local = validateLocal(input.local, expected, contract);
  const provider = validateProvider(input.provider, expected, contract);
  const browser = validateBrowser(input.browser, expected, contract);
  const unsigned = Object.freeze({
    schema: contract.join_schema,
    status: browser.kind === "blocked" ? "verification_blocked" : "structurally_verified_readback",
    hosted_evidence: false,
    acceptance: "nonterminal",
    provenance: "offline-private-receipt-join",
    candidate_sha: expected.candidate,
    setup_deployment_id: expected.setup,
    verify_deployment_id: expected.verify,
    distinct_redeploy: true,
    input_artifacts: Object.freeze({
      local_receipt_sha256: local.artifactSha256,
      provider_readback_sha256: provider.artifactSha256,
      browser_readback_sha256: browser.artifactSha256,
    }),
    lineage_fingerprints: Object.freeze({
      project: provider.projectFingerprint,
      version: provider.versionFingerprint,
    }),
    capability_rows: browser.rows,
    blocker_code: browser.kind === "blocked" ? "hosted_generated_sources_not_available" : null,
    unresolved_provenance: Object.freeze([
      "Sites connector call origin is not authenticated by an offline file",
      "in-app Browser observation origin is not authenticated by an offline file",
    ]),
  });
  return Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
}

export async function run(options) {
  const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
  const expected = Object.freeze({
    candidate: candidateSha(options.candidate_sha),
    setup: DEPLOYMENT.test(options.setup_deployment_id) ? options.setup_deployment_id : fail("invalid_setup_deployment_id"),
    verify: DEPLOYMENT.test(options.verify_deployment_id) ? options.verify_deployment_id : fail("invalid_verify_deployment_id"),
  });
  if (expected.setup === expected.verify) fail("redeploy_not_distinct");
  const input = Object.freeze({
    local: JSON.parse(await readFile(options.local_receipt, "utf8")),
    provider: JSON.parse(await readFile(options.provider_readback, "utf8")),
    browser: JSON.parse(await readFile(options.browser_readback, "utf8")),
  });
  const joined = createStructuralJoin(input, expected, contract);
  const output = await reservePrivateTempOutput(options.join_out, {
    repositoryRoot: ROOT,
    errorCode: "unsafe_join_output",
  });
  try {
    await output.write(`${JSON.stringify(joined, null, 2)}\n`);
  } finally {
    await output.abort();
  }
  return joined;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run join:generated-source-uat -- --candidate-sha <sha> --setup-deployment-id <id> --verify-deployment-id <id> --local-receipt <private-file> --provider-readback <private-file> --browser-readback <private-file> --join-out <new-private-file>\n");
      return;
    }
    const joined = await run(options);
    process.stdout.write(`${JSON.stringify({
      status: joined.status,
      hosted_evidence: joined.hosted_evidence,
      candidate_sha: joined.candidate_sha,
      artifact_sha256: joined.artifact_sha256,
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
