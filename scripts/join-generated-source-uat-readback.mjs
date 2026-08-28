#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
const VERSION = /^(?:appgver_[a-z0-9]+|appgprj_[a-z0-9]+~appgver_[a-z0-9]+)$/u;
const PROJECT = /^appgprj_[a-z0-9]+$/u;
const PRIVATE_TEXT = /(?:mdp_v1_|mdo_(?:code|access|refresh)_|authorization|cookie|download_url|https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}|\/(?:Users|private|tmp)\/)/iu;

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function tempRoots() {
  const roots = [];
  for (const path of [tmpdir(), "/tmp", "/private/tmp"]) {
    try {
      roots.push(await realpath(path));
    } catch {}
  }
  return [...new Set(roots)];
}

export async function readPrivateReceipt(path, code = "unsafe_private_receipt") {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path)) fail(code);
    const parent = await realpath(dirname(path));
    const parentStat = await stat(parent);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!parentStat.isDirectory() || currentUid === null || parentStat.uid !== currentUid ||
        (parentStat.mode & 0o777) !== 0o700 ||
        !(await tempRoots()).some((root) => parent !== root && containsPath(root, parent))) fail(code);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [pathStat, handleStat] = await Promise.all([lstat(path), handle.stat()]);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !handleStat.isFile() ||
        pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino ||
        handleStat.uid !== currentUid || (handleStat.mode & 0o777) !== 0o600) fail(code);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function exactArtifact(value, code) {
  if (!isRecord(value) || !SHA256.test(value.artifact_sha256 ?? "")) fail(code);
  const { artifact_sha256: supplied, ...unsigned } = value;
  if (supplied !== digest(canonical(unsigned))) fail(code);
  if (PRIVATE_TEXT.test(JSON.stringify(value))) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    fail(code);
  }
}

function assertionIds(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected.length) fail(code);
  const ids = value.map((entry, index) => {
    if (!isRecord(entry) || entry.id !== expected[index] || entry.status !== "passed") fail(code);
    exactKeys(entry, ["id", "status"], code);
    return entry.id;
  });
  return Object.freeze(ids);
}

function suiteBindings(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected.length) fail(code);
  return Object.freeze(value.map((entry, index) => {
    if (!isRecord(entry) || entry.path !== expected[index] ||
        !SHA256.test(entry.sha256 ?? "") || entry.status !== "passed") fail(code);
    exactKeys(entry, ["path", "sha256", "status"], code);
    return Object.freeze({ path: entry.path, sha256: entry.sha256 });
  }));
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
  if (!isRecord(value.fixture)) fail("invalid_local_receipt");
  exactKeys(value.fixture, [
    "bounded_exact_bytes", "bounded_plus_one_bytes", "server_stream_class", "corpus_class",
  ], "invalid_local_receipt");
  if (value.fixture.bounded_exact_bytes !== 4_194_304 ||
      value.fixture.bounded_plus_one_bytes !== 4_194_305 ||
      value.fixture.server_stream_class !== "deterministic-synthetic-binary" ||
      value.fixture.corpus_class !== "synthetic-no-user-data") fail("invalid_local_receipt");
  const expectedRemaining = [
    "exact Sites candidate/deployment lineage",
    "restricted UAT private run-owned Mind and short credential",
    "same-run actor-owned Web target, export and cleanup",
    "distinct redeploy exact path/size/SHA/bytes read-back",
  ];
  if (!Array.isArray(value.hosted_rows_remaining) ||
      value.hosted_rows_remaining.length !== expectedRemaining.length ||
      value.hosted_rows_remaining.some((row, index) => row !== expectedRemaining[index])) {
    fail("invalid_local_receipt");
  }
  assertionIds(value.assertions, contract.assertion_ids, "invalid_local_assertions");
  suiteBindings(value.suites, contract.local_suites, "invalid_local_suite_bindings");
  exactKeys(value, [
    "schema", "status", "hosted_evidence", "acceptance", "provenance", "candidate_sha",
    "fixture", "suites", "assertions", "hosted_rows_remaining", "public_capability_claim",
    "started_at", "completed_at", "artifact_sha256",
  ], "invalid_local_receipt");
  return Object.freeze({ artifactSha256: value.artifact_sha256 });
}

function validateProvider(value, expected, contract) {
  exactArtifact(value, "invalid_provider_readback");
  exactKeys(value, [
    "schema", "generator", "candidate_sha", "project_id", "version_id",
    "setup_deployment_id", "verify_deployment_id", "setup_status", "verify_status",
    "artifact_sha256",
  ], "invalid_provider_readback");
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
  if (value.some((row) => !isRecord(row))) fail(code);
  const rows = [...value].sort((left, right) => left.source_kind.localeCompare(right.source_kind));
  if (rows[0]?.source_kind !== "bounded_in_memory" || rows[1]?.source_kind !== "server_generated") {
    fail(code);
  }
  for (const row of rows) {
    exactKeys(row, ["source_kind", "test_composition_status", "test_transport", "max_bytes"], code);
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
    exactKeys(value, [
      "schema", "generator", "browser_surface", "status", "blocker_code", "candidate_sha",
      "setup_deployment_id", "verify_deployment_id", "capability_rows", "artifact_sha256",
    ], "invalid_browser_readback");
    if (value.blocker_code !== "hosted_generated_sources_not_available" ||
        rows.some((row) => row.test_composition_status !== "not_available" ||
          row.test_transport !== "none" || row.max_bytes !== 0)) {
      fail("invalid_hosted_blocker");
    }
    return Object.freeze({ kind: "blocked", rows, artifactSha256: value.artifact_sha256 });
  }
  if (value.status !== "passed" || value.blocker_code !== null) fail("invalid_browser_readback");
  exactKeys(value, [
    "schema", "generator", "browser_surface", "status", "blocker_code", "candidate_sha",
    "setup_deployment_id", "verify_deployment_id", "capability_rows", "assertions",
    "read_back", "cleanup", "artifact_sha256",
  ], "invalid_browser_readback");
  const expectedRows = Object.freeze([
    Object.freeze({
      source_kind: "bounded_in_memory",
      test_composition_status: "available",
      test_transport: "constructor_owned_bytes",
      max_bytes: 4_194_304,
    }),
    Object.freeze({
      source_kind: "server_generated",
      test_composition_status: "available",
      test_transport: "constructor_owned_stream",
      max_bytes: 268_435_456,
    }),
  ]);
  if (rows.some((row, index) =>
    row.test_composition_status !== expectedRows[index].test_composition_status ||
    row.test_transport !== expectedRows[index].test_transport ||
    row.max_bytes !== expectedRows[index].max_bytes)) fail("invalid_hosted_capability_rows");
  assertionIds(value.assertions, contract.hosted_assertion_ids, "invalid_hosted_assertions");
  const readBack = value.read_back;
  const cleanup = value.cleanup;
  if (isRecord(readBack)) exactKeys(readBack, [
    "exact_path", "exact_size", "exact_sha256", "exact_bytes", "one_revision",
    "no_partial_head", "no_duplicate_object", "no_duplicate_revision",
  ], "hosted_readback_incomplete");
  if (isRecord(cleanup)) exactKeys(cleanup, [
    "credential_revoked", "mind_deleted", "target_absent", "read_back_complete",
  ], "hosted_readback_incomplete");
  if (!isRecord(readBack) || readBack.exact_path !== true || readBack.exact_size !== true ||
      readBack.exact_sha256 !== true || readBack.exact_bytes !== true ||
      readBack.one_revision !== true || readBack.no_partial_head !== true ||
      readBack.no_duplicate_object !== true || readBack.no_duplicate_revision !== true ||
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
    local: await readPrivateReceipt(options.local_receipt, "unsafe_local_receipt"),
    provider: await readPrivateReceipt(options.provider_readback, "unsafe_provider_readback"),
    browser: await readPrivateReceipt(options.browser_readback, "unsafe_browser_readback"),
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
