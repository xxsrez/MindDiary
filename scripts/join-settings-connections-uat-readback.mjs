#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertRedactedDocument,
  canonical,
  digest,
  fail,
  isRecord,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";
import {
  resolveSiteSourceProvenance,
  validateProviderSourceCommit,
} from "./lib/sites-source-provenance.mjs";
import {
  providerArchiveBinding,
  providerTimestamp,
  providerVersionId,
} from "./lib/sites-provider-readback.mjs";
import { verifyProviderRequestLogBoundaryReceipt } from "./lib/provider-request-log-boundary.mjs";
import { verifyUatTestAccountPoolReadinessReceipt } from "./lib/uat-test-account-pool-contract.mjs";
import {
  SETTINGS_CONNECTIONS_RUNTIME_SUITES,
  SETTINGS_CONNECTIONS_SOURCE_PATHS,
} from "./run-settings-connections-local-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const LOCAL_SCHEMA = "mind-diary/settings-connections-local-evidence/v1";
const PROVIDER_SCHEMA = "mind-diary/settings-connections-sites-provider-readback/v1";
const BROWSER_SCHEMA = "mind-diary/settings-connections-in-app-browser-readback/v1";
const JOIN_SCHEMA = "mind-diary/settings-connections-uat-readback-join/v1";
const CONTRACT_PATH = "tests/fixtures/settings-connections-uat/contract.v1.json";
const UAT_URL = process.env.MIND_DIARY_UAT_ORIGIN ?? "https://mind-diary.example.invalid";
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROJECT_ID = /^appgprj_[a-z0-9]+$/u;
const DEPLOYMENT_ID = /^appgdep_[a-z0-9]+$/u;
const ACTOR_FINGERPRINT = /^actor-[a-z0-9]{16,64}$/u;

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function utc(value, code) {
  return providerTimestamp(value, code);
}

function validateArtifact(value, code) {
  if (!isRecord(value) || !SHA256.test(value.artifact_sha256 ?? "")) fail(code);
  const { artifact_sha256: supplied, ...unsigned } = value;
  if (supplied !== digest(canonical(unsigned))) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  if (!isRecord(value) || Object.keys(value).length !== expected.length ||
      Object.keys(value).some((key) => !expected.includes(key))) fail(code);
  return value;
}

function validateLocalReceipt(value, expected) {
  exactKeys(value, [
    "schema", "status", "hosted_evidence", "hosted_status", "acceptance", "provenance",
    "candidate_sha", "deployment_id", "contract_sha256", "plugin", "browser",
    "runtime_suites", "source_hashes", "assertions", "cleanup", "unresolved_hosted_rows",
    "started_at", "completed_at", "artifact_sha256",
  ], "invalid_local_receipt");
  validateArtifact(value, "invalid_local_receipt");
  if (
    value.schema !== LOCAL_SCHEMA ||
    value.status !== "passed" ||
    value.hosted_evidence !== false ||
    value.hosted_status !== "not-run" ||
    value.acceptance !== "local-deterministic-only" ||
    value.provenance !== "exact-candidate-local-execution" ||
    value.candidate_sha !== expected.candidate ||
    value.deployment_id !== null ||
    value.contract_sha256 !== expected.contractSha256 ||
    !isRecord(value.plugin) ||
    typeof value.plugin.plugin_version !== "string" ||
    typeof value.plugin.client !== "string" ||
    typeof value.plugin.client_version !== "string" ||
    !SHA256.test(value.plugin.artifact_sha256 ?? "") ||
    !SHA.test(value.plugin.marketplace_candidate_sha ?? "") ||
    !SHA.test(value.plugin.marketplace_tree_sha ?? "") ||
    !SHA256.test(value.plugin.plugin_snapshot_sha256 ?? "") ||
    canonical(value.plugin.routes) !== canonical(["/api/mcp", "/api/mcp/2025-11-25"]) ||
    value.plugin.catalog_profiles?.default_product_site_write !== 21 ||
    value.plugin.catalog_profiles?.read_only !== 20 ||
    value.plugin.catalog_profiles?.verified_native !== 22
  ) fail("invalid_local_receipt");
  exactKeys(value.plugin, [
    "artifact_sha256", "marketplace_candidate_sha", "marketplace_tree_sha", "plugin_version",
    "plugin_snapshot_sha256", "client", "client_version", "routes", "catalog_profiles",
  ], "invalid_local_receipt");
  exactKeys(value.plugin.catalog_profiles, [
    "default_product_site_write", "read_only", "verified_native",
  ], "invalid_local_receipt");
  exactKeys(value.browser, [
    "playwright_package_version", "playwright_cli_version", "chromium_package_version",
    "playwright_core_version", "chromium_revision", "chromium_browser_version",
    "chromium_executable_sha256", "fixture", "workers", "locale", "timezone",
  ], "invalid_local_receipt");
  if (value.browser.fixture !== "server-bound-synthetic-connections" ||
      value.browser.workers !== 1 || value.browser.locale !== "en-US" ||
      value.browser.timezone !== "UTC" ||
      !SHA256.test(value.browser.chromium_executable_sha256 ?? "")) {
    fail("invalid_local_receipt");
  }
  if (!Array.isArray(value.runtime_suites) ||
      value.runtime_suites.length !== SETTINGS_CONNECTIONS_RUNTIME_SUITES.length ||
      value.runtime_suites.some((entry, index) => {
        exactKeys(entry, ["path", "status", "source_sha256", "stdout_sha256"],
          "invalid_local_receipt");
        return entry.path !== SETTINGS_CONNECTIONS_RUNTIME_SUITES[index] ||
          entry.status !== "passed" || !SHA256.test(entry.source_sha256 ?? "") ||
          !SHA256.test(entry.stdout_sha256 ?? "");
      })) fail("invalid_local_receipt");
  exactKeys(value.source_hashes, SETTINGS_CONNECTIONS_SOURCE_PATHS, "invalid_local_receipt");
  if (SETTINGS_CONNECTIONS_SOURCE_PATHS.some((path) =>
    !SHA256.test(value.source_hashes[path] ?? ""))) fail("invalid_local_receipt");
  assertionRegistry(value.assertions, expected.contract.local_assertion_ids,
    "invalid_local_receipt");
  exactBooleanRecord(value.cleanup, [
    "fixture_processes_closed", "browser_contexts_closed",
    "oauth_synthetic_adapters_destroyed", "private_temporary_inputs_removed",
  ], "invalid_local_receipt");
  if (canonical(value.unresolved_hosted_rows) !== canonical([
    "exact-sites-deployment",
    "in-app-browser-settings-journey",
    "fresh-hosted-codex-plugin-observation",
    "controlled-redeploy-persistence",
    "provider-and-product-cleanup-readback",
  ])) fail("invalid_local_receipt");
  const startedAt = utc(value.started_at, "invalid_local_receipt");
  const completedAt = utc(value.completed_at, "invalid_local_receipt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail("invalid_local_receipt");
  return Object.freeze({
    artifactSha256: value.artifact_sha256,
    contractSha256: value.contract_sha256,
    pluginVersion: value.plugin.plugin_version,
    client: value.plugin.client,
    clientVersion: value.plugin.client_version,
    marketplaceCandidateSha: value.plugin.marketplace_candidate_sha,
    marketplaceTreeSha: value.plugin.marketplace_tree_sha,
    pluginSnapshotSha256: value.plugin.plugin_snapshot_sha256,
    catalogProfiles: Object.freeze(structuredClone(value.plugin.catalog_profiles)),
  });
}

function validateProviderReadback(value, expected, archiveBytes) {
  if (!isRecord(value) || value.schema !== PROVIDER_SCHEMA ||
      value.generator !== "codex-sites-connector-readback/v1" ||
      !isRecord(value.site) || !isRecord(value.version) ||
      !isRecord(value.deployment_before) || !isRecord(value.redeploy_start) ||
      !isRecord(value.deployment_after)) fail("invalid_provider_readback");
  const observedAt = utc(value.observed_at_utc, "invalid_provider_observed_at");
  const { site, version, deployment_before: before, redeploy_start: start, deployment_after: after } = value;
  const versionId = providerVersionId(version.id, "provider_lineage_mismatch");
  if (!PROJECT_ID.test(site.id ?? "") || site.id !== expected.siteProjectId ||
      site.status !== "active" || site.current_live_url !== UAT_URL ||
      version.project_id !== site.id ||
      validateProviderSourceCommit(
        version.source?.commit_sha,
        expected,
        "provider_lineage_mismatch",
      ) !== expected.siteSourceCommitSha) fail("provider_lineage_mismatch");
  for (const deployment of [before, start, after]) {
    utc(deployment.updated_at, "invalid_deployment_timestamp");
    if (!DEPLOYMENT_ID.test(deployment.id ?? "") || deployment.project_id !== site.id ||
        deployment.version_id !== versionId || deployment.type !== "publish") {
      fail("provider_deployment_mismatch");
    }
  }
  if (before.status !== "succeeded" || before.url !== UAT_URL ||
      !["pending", "building", "publishing", "succeeded"].includes(start.status) ||
      after.status !== "succeeded" || after.url !== UAT_URL ||
      before.id === after.id || start.id !== after.id ||
      Date.parse(start.updated_at) < Date.parse(before.updated_at) ||
      Date.parse(after.updated_at) < Date.parse(start.updated_at) ||
      Date.parse(observedAt) < Date.parse(after.updated_at)) fail("provider_redeploy_mismatch");
  const archive = providerArchiveBinding({
    archiveBytes,
    storages: [version.archive_storage],
    invalidCode: "provider_lineage_mismatch",
  });
  return Object.freeze({
    observedAt,
    projectId: site.id,
    siteSourceCommitSha: expected.siteSourceCommitSha,
    versionId,
    deploymentBeforeId: before.id,
    deploymentAfterId: after.id,
    archiveSha256: archive.providerArchiveSha256,
    ...archive,
  });
}

function validatePool(value, expected) {
  let pool;
  try {
    pool = verifyUatTestAccountPoolReadinessReceipt(value);
  } catch {
    fail("invalid_pool_readback");
  }
  if (pool.candidate_sha !== expected.candidate ||
      pool.deployment_id !== expected.deploymentId) fail("pool_lineage_mismatch");
  const actors = Object.freeze(Object.fromEntries(pool.actors.map((actor) => [
    actor.alias,
    actor.actor_fingerprint,
  ])));
  return Object.freeze({ artifactSha256: pool.artifact_sha256, actors });
}

function validateProviderBoundary(value, expected) {
  let boundary;
  try {
    boundary = verifyProviderRequestLogBoundaryReceipt(value);
  } catch {
    fail("invalid_provider_boundary_readback");
  }
  if (boundary.status !== "accepted_boundary" ||
      boundary.candidate_sha !== expected.candidate ||
      boundary.deployment.site_project_id !== expected.projectId ||
      boundary.deployment.site_version_id !== expected.versionId ||
      boundary.deployment.deployment_id !== expected.deploymentId ||
      boundary.deployment.archive_sha256 !== expected.archiveSha256) {
    fail("provider_boundary_lineage_mismatch");
  }
  return Object.freeze({ artifactSha256: boundary.artifact_sha256 });
}

function exactBooleanRecord(value, keys, code) {
  exactKeys(value, keys, code);
  if (keys.some((key) => value[key] !== true)) fail(code);
  return Object.freeze(structuredClone(value));
}

function assertionRegistry(value, ids, code) {
  if (!Array.isArray(value) || value.length !== ids.length ||
      value.some((entry, index) =>
        !isRecord(entry) || entry.id !== ids[index] || entry.status !== "passed")) fail(code);
  return Object.freeze(ids.map((id) => Object.freeze({ id, status: "passed" })));
}

function assertBrowserReadbackSafe(value) {
  const text = JSON.stringify(value);
  for (const pattern of [
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
    /mdp_v1_|mdg_v1_|mdo_(?:code|access|refresh)_/iu,
    /(?:authorization|cookie|csrf|secret|verifier|download_url|raw_response_body)["']?\s*:/iu,
    /(?:principal_id|space_id|token_id|grant_id|binding_owner_id)["']?\s*:/iu,
    /private[_/-](?:content|corpus|path)/iu,
  ]) if (pattern.test(text)) fail("unsafe_browser_readback");
}

function validateBrowserReadback(value, expected) {
  assertBrowserReadbackSafe(value);
  exactKeys(value, [
    "schema", "generator", "browser_surface", "live_url", "candidate_sha", "deployment_id",
    "local_receipt_sha256", "plugin_version", "client", "client_version", "observed_at_utc",
    "run_fingerprint", "actor_fingerprints", "assertions", "help", "oauth", "personal_token",
    "redeploy", "privacy", "cleanup",
  ], "invalid_browser_readback");
  if (!isRecord(value) || value.schema !== BROWSER_SCHEMA ||
      value.generator !== "codex-in-app-browser-same-run-readback/v1" ||
      value.browser_surface !== "codex-in-app-browser" || value.live_url !== UAT_URL ||
      value.candidate_sha !== expected.candidate ||
      value.deployment_id !== expected.provider.deploymentAfterId ||
      value.local_receipt_sha256 !== expected.local.artifactSha256 ||
      value.plugin_version !== expected.local.pluginVersion ||
      value.client !== expected.local.client ||
      value.client_version !== expected.local.clientVersion ||
      !SHA256.test(value.run_fingerprint ?? "") || !isRecord(value.actor_fingerprints)) {
    fail("invalid_browser_readback");
  }
  const observedAt = utc(value.observed_at_utc, "invalid_browser_observed_at");
  if (Date.parse(observedAt) < Date.parse(expected.provider.observedAt)) {
    fail("browser_readback_precedes_provider");
  }
  exactKeys(value.actor_fingerprints, ["UAT-MIND-ROLE", "UAT-ORDINARY"],
    "browser_actor_mismatch");
  for (const alias of ["UAT-MIND-ROLE", "UAT-ORDINARY"]) {
    if (!ACTOR_FINGERPRINT.test(value.actor_fingerprints[alias] ?? "") ||
        value.actor_fingerprints[alias] !== expected.pool.actors[alias]) {
      fail("browser_actor_mismatch");
    }
  }
  const assertions = assertionRegistry(
    value.assertions,
    expected.contract.hosted_assertion_ids,
    "browser_assertion_registry_mismatch",
  );
  const help = exactBooleanRecord(value.help, [
    "stable_no_connection",
    "stable_active",
    "stable_revoked",
  ], "browser_help_matrix_mismatch");
  const oauth = exactBooleanRecord(value.oauth, [
    "no_connection",
    "active",
    "acl_summary",
    "read_selector_absent",
    "target_selected",
    "target_switched",
    "target_cleared",
    "revoked_hidden",
    "next_request_denied",
    "reconnect_empty_target",
  ], "browser_oauth_matrix_mismatch");
  const personalToken = exactBooleanRecord(value.personal_token, [
    "created_show_once",
    "created_empty_target",
    "target_selected",
    "target_switched",
    "target_cleared",
    "revoked",
    "next_request_denied",
    "reissued_empty_target",
  ], "browser_token_matrix_mismatch");
  const redeploy = exactBooleanRecord(value.redeploy, [
    "connection_persisted",
    "token_persisted",
    "target_persisted",
  ], "browser_redeploy_matrix_mismatch");
  if (value.redeploy.before_deployment_id !== undefined ||
      value.redeploy.after_deployment_id !== undefined) fail("browser_redeploy_matrix_mismatch");
  const privacy = exactBooleanRecord(value.privacy, [
    "ordinary_projection_redacted",
    "forbidden_fields_absent",
    "raw_response_bodies_not_persisted",
  ], "browser_privacy_matrix_mismatch");
  const cleanup = exactBooleanRecord(value.cleanup, [
    "provider_credentials_absent",
    "product_credentials_absent",
    "targets_absent",
    "run_mind_absent",
    "pool_baseline_restored",
    "next_requests_denied",
  ], "browser_cleanup_matrix_mismatch");
  return Object.freeze({
    observedAt,
    runFingerprint: value.run_fingerprint,
    actorFingerprints: Object.freeze(structuredClone(value.actor_fingerprints)),
    assertions,
    help,
    oauth,
    personalToken,
    redeploy,
    privacy,
    cleanup,
  });
}

function normalize(input, expected) {
  const local = validateLocalReceipt(input.localReceipt, expected);
  const provider = validateProviderReadback(input.providerReadback, expected, input.archiveBytes);
  const pool = validatePool(input.poolReadback, {
    candidate: expected.candidate,
    deploymentId: provider.deploymentAfterId,
  });
  const boundary = validateProviderBoundary(input.providerBoundaryReadback, {
    candidate: expected.candidate,
    projectId: provider.projectId,
    versionId: provider.versionId,
    deploymentId: provider.deploymentAfterId,
    archiveSha256: provider.archiveSha256,
  });
  const browser = validateBrowserReadback(input.browserReadback, {
    candidate: expected.candidate,
    contract: expected.contract,
    local,
    provider,
    pool,
  });
  return Object.freeze({ input, expected, local, provider, pool, boundary, browser });
}

function unsignedJoin(binding) {
  const { input, expected, local, provider, pool, boundary, browser } = binding;
  return Object.freeze({
    schema: JOIN_SCHEMA,
    status: "structurally_verified_readback",
    hosted_evidence: false,
    acceptance: "nonterminal",
    provenance: "unverified-local-files",
    evidence_basis: "offline-byte-and-shape-join-only",
    candidate_sha: expected.candidate,
    live_url: UAT_URL,
    observed_at_utc: browser.observedAt,
    claimed_lineage: Object.freeze({
      site_project_id: provider.projectId,
      site_source_commit_sha: provider.siteSourceCommitSha,
      site_source_tree_sha: expected.siteSourceTreeSha,
      site_source_mode: expected.siteSourceMode,
      site_version_id: provider.versionId,
      deployment_before_id: provider.deploymentBeforeId,
      deployment_after_id: provider.deploymentAfterId,
      upload_archive_sha256: provider.uploadArchiveSha256,
      upload_archive_size_bytes: provider.uploadArchiveSizeBytes,
      provider_archive_sha256: provider.providerArchiveSha256,
      provider_archive_size_bytes: provider.providerArchiveSizeBytes,
      provider_archive_file_count: provider.providerArchiveFileCount,
      provider_archive_format: provider.providerArchiveFormat,
      plugin_version: local.pluginVersion,
      client: local.client,
      client_version: local.clientVersion,
      marketplace_candidate_sha: local.marketplaceCandidateSha,
      marketplace_tree_sha: local.marketplaceTreeSha,
      plugin_snapshot_sha256: local.pluginSnapshotSha256,
      catalog_profiles: local.catalogProfiles,
    }),
    input_hashes: Object.freeze({
      local_receipt_sha256: sha256Bytes(input.localReceiptBytes),
      provider_readback_sha256: sha256Bytes(input.providerReadbackBytes),
      pool_readback_sha256: sha256Bytes(input.poolReadbackBytes),
      provider_boundary_readback_sha256: sha256Bytes(input.providerBoundaryReadbackBytes),
      browser_readback_sha256: sha256Bytes(input.browserReadbackBytes),
    }),
    artifact_bindings: Object.freeze({
      local_receipt_sha256: local.artifactSha256,
      pool_receipt_sha256: pool.artifactSha256,
      provider_boundary_receipt_sha256: boundary.artifactSha256,
      contract_sha256: local.contractSha256,
    }),
    run_fingerprint: browser.runFingerprint,
    actor_fingerprints: browser.actorFingerprints,
    assertions: browser.assertions,
    help: browser.help,
    oauth: browser.oauth,
    personal_token: browser.personalToken,
    redeploy: browser.redeploy,
    privacy: browser.privacy,
    cleanup: browser.cleanup,
    unresolved_provenance: Object.freeze([
      "sites-connector-call-origin-not-authenticated-offline",
      "in-app-browser-observation-origin-not-authenticated-offline",
      "fresh-client-observation-origin-not-authenticated-offline",
    ]),
  });
}

export function createStructuralJoin(input, expected) {
  const unsigned = unsignedJoin(normalize(input, expected));
  const value = Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
  assertRedactedDocument(value);
  return value;
}

export function validateStructuralJoin(value, binding) {
  validateArtifact(value, "invalid_structural_join");
  const expected = unsignedJoin(normalize(binding.input, binding.expected));
  const { artifact_sha256: _artifact, ...unsigned } = value;
  if (canonical(unsigned) !== canonical(expected) || value.status === "passed" ||
      value.hosted_evidence === true) fail("invalid_structural_join");
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
  const required = [
    "local_receipt",
    "provider_readback",
    "pool_readback",
    "provider_boundary_readback",
    "browser_readback",
    "artifact_archive",
    "candidate_sha",
    "join_out",
  ];
  if (Object.keys(options).some((key) => !required.includes(key))) fail("unsupported_cli_argument");
  for (const key of required) if (typeof options[key] !== "string") fail(`missing_${key}`);
  return options;
}

function trackedContext(candidate, providerSourceCommitSha) {
  if (!SHA.test(candidate)) fail("invalid_candidate_sha");
  try {
    const source = resolveSiteSourceProvenance({
      root: ROOT,
      candidate,
      providerSourceCommitSha,
    });
    const hosting = JSON.parse(execFileSync(
      "git",
      ["show", `${candidate}:apps/mind-diary-site/.openai/hosting.json`],
      { cwd: ROOT, encoding: "utf8" },
    ));
    const contractBytes = execFileSync(
      "git",
      ["show", `${candidate}:${CONTRACT_PATH}`],
      { cwd: ROOT },
    );
    const contract = JSON.parse(contractBytes.toString("utf8"));
    if (!PROJECT_ID.test(hosting.project_id ?? "") ||
        contract.schema !== "mind-diary/settings-connections-uat-contract/v1") {
      fail("invalid_tracked_context");
    }
    return Object.freeze({
      candidate: source.candidateSha,
      siteProjectId: hosting.project_id,
      siteSourceCommitSha: source.siteSourceCommitSha,
      siteSourceTreeSha: source.siteSourceTreeSha,
      siteSourceMode: source.siteSourceMode,
      contractSha256: sha256Bytes(contractBytes),
      contract,
    });
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    fail("tracked_candidate_unavailable");
  }
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run join:settings-connections-uat -- --local-receipt <json> --provider-readback <json> --pool-readback <json> --provider-boundary-readback <json> --browser-readback <json> --artifact-archive <tgz> --candidate-sha <sha> --join-out <json>\n");
      return;
    }
    const [
      localReceiptBytes,
      providerReadbackBytes,
      poolReadbackBytes,
      providerBoundaryReadbackBytes,
      browserReadbackBytes,
      archiveBytes,
    ] = await Promise.all([
      readFile(options.local_receipt),
      readFile(options.provider_readback),
      readFile(options.pool_readback),
      readFile(options.provider_boundary_readback),
      readFile(options.browser_readback),
      readFile(options.artifact_archive),
    ]);
    const providerReadback = JSON.parse(providerReadbackBytes.toString("utf8"));
    const expected = trackedContext(
      options.candidate_sha,
      providerReadback?.version?.source?.commit_sha,
    );
    const input = {
      localReceipt: JSON.parse(localReceiptBytes.toString("utf8")),
      providerReadback,
      poolReadback: JSON.parse(poolReadbackBytes.toString("utf8")),
      providerBoundaryReadback: JSON.parse(providerBoundaryReadbackBytes.toString("utf8")),
      browserReadback: JSON.parse(browserReadbackBytes.toString("utf8")),
      localReceiptBytes,
      providerReadbackBytes,
      poolReadbackBytes,
      providerBoundaryReadbackBytes,
      browserReadbackBytes,
      archiveBytes,
    };
    const join = createStructuralJoin(input, expected);
    const output = await reservePrivateTempOutput(options.join_out, {
      repositoryRoot: ROOT,
      errorCode: "unsafe_settings_connections_join_output",
    });
    try {
      await output.write(`${JSON.stringify(join, null, 2)}\n`);
    } finally {
      await output.abort();
    }
    process.stdout.write(`${JSON.stringify({
      status: join.status,
      hosted_evidence: join.hosted_evidence,
      candidate_sha: join.candidate_sha,
      artifact_sha256: join.artifact_sha256,
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
