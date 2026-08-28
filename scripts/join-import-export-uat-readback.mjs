#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
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
import { IMPORT_EXPORT_ASSERTION_IDS } from "./run-import-export-browser-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const LOCAL_SCHEMA = "mind-diary/import-export-browser-evidence/v1";
const PROVIDER_SCHEMA = "mind-diary/import-export-sites-provider-readback/v1";
const BROWSER_SCHEMA = "mind-diary/import-export-in-app-browser-readback/v1";
const JOIN_SCHEMA = "mind-diary/import-export-uat-readback-join/v1";
const UAT_URL = "https://mind-diary.example.invalid";
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROJECT_ID = /^appgprj_[a-z0-9]+$/u;
const DEPLOYMENT_ID = /^appgdep_[a-z0-9]+$/u;

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

function assertionRegistry(value, code) {
  if (!Array.isArray(value) || value.length !== IMPORT_EXPORT_ASSERTION_IDS.length) fail(code);
  const ids = value.map((assertion) => {
    if (!isRecord(assertion) || assertion.status !== "passed" || typeof assertion.id !== "string") {
      fail(code);
    }
    return assertion.id;
  });
  if (new Set(ids).size !== ids.length ||
      ids.some((id, index) => id !== IMPORT_EXPORT_ASSERTION_IDS[index])) fail(code);
  return ids;
}

function validateLocalReceipt(value, candidate) {
  validateArtifact(value, "invalid_local_receipt");
  if (value.schema !== LOCAL_SCHEMA || value.status !== "passed" ||
      value.hosted_evidence !== false || value.acceptance !== "local-deterministic-only" ||
      value.provenance !== "exact-candidate-local-execution" ||
      value.candidate_sha !== candidate || !isRecord(value.fixture) ||
      !SHA256.test(value.fixture.manifest_sha256 ?? "") ||
      value.fixture.input_selection !== "playwright-set-input-files" ||
      value.fixture.corpus_class !== "synthetic-no-user-data") fail("invalid_local_receipt");
  assertionRegistry(value.assertions, "invalid_local_assertion_registry");
  return Object.freeze({
    artifactSha256: value.artifact_sha256,
    fixtureManifestSha256: value.fixture.manifest_sha256,
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
  if (!PROJECT_ID.test(site.id ?? "") || site.id !== expected.siteProjectId || site.status !== "active" ||
      site.current_live_url !== UAT_URL || version.project_id !== site.id || validateProviderSourceCommit(
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
    uploadArchiveSha256: archive.uploadArchiveSha256,
    uploadArchiveSizeBytes: archive.uploadArchiveSizeBytes,
    archiveSha256: archive.providerArchiveSha256,
    providerArchiveSizeBytes: archive.providerArchiveSizeBytes,
    providerArchiveFileCount: archive.providerArchiveFileCount,
    providerArchiveFormat: archive.providerArchiveFormat,
  });
}

function digestFingerprint(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function validateExportComparison(value, expectedKind, expectedProfile) {
  if (!isRecord(value) || value.kind !== expectedKind || value.profile !== expectedProfile ||
      !Number.isSafeInteger(value.receipt_size) || value.receipt_size < 1 ||
      value.receipt_size !== value.download_size || value.bytes_match !== true) {
    fail("browser_export_comparison_mismatch");
  }
  const receipt = digestFingerprint(value.receipt_sha256, "browser_export_digest_mismatch");
  if (value.download_sha256 !== receipt || value.bytes_sha256 !== receipt) {
    fail("browser_export_digest_mismatch");
  }
  digestFingerprint(value.revision_fingerprint, "browser_revision_fingerprint_missing");
  digestFingerprint(value.job_fingerprint, "browser_job_fingerprint_missing");
  return Object.freeze(structuredClone(value));
}

function validateBrowserReadback(value, expected) {
  if (!isRecord(value) || value.schema !== BROWSER_SCHEMA ||
      value.generator !== "codex-in-app-browser-same-origin-readback/v1" ||
      value.browser_surface !== "codex-in-app-browser" || value.live_url !== UAT_URL ||
      value.candidate_sha !== expected.candidate ||
      value.deployment_id !== expected.provider.deploymentAfterId ||
      value.fixture_manifest_sha256 !== expected.local.fixtureManifestSha256 ||
      !isRecord(value.actor_fingerprints) || !isRecord(value.import_matrix) ||
      !isRecord(value.redeploy) || !isRecord(value.access) || !isRecord(value.cleanup) ||
      !Array.isArray(value.exports)) fail("invalid_browser_readback");
  const observedAt = utc(value.observed_at_utc, "invalid_browser_observed_at");
  if (Date.parse(observedAt) < Date.parse(expected.provider.observedAt)) {
    fail("browser_readback_precedes_provider");
  }
  digestFingerprint(value.run_fingerprint, "browser_run_fingerprint_missing");
  for (const role of ["owner", "reader"]) {
    digestFingerprint(value.actor_fingerprints[role], "browser_actor_fingerprint_missing");
  }
  const ids = assertionRegistry(value.assertions, "browser_assertion_registry_mismatch");
  const imported = value.import_matrix;
  if (imported.revision_count_delta !== 1 || imported.one_head_transition !== true ||
      imported.history_unchanged !== true || imported.opaque_preserved !== true ||
      imported.unknown_okf_fields_preserved !== true || imported.interruption_recovered !== true ||
      imported.cancel_no_head_change !== true || imported.idempotent_retry_single_result !== true ||
      imported.invalid_inputs_no_side_effect !== true || imported.size_plus_one_no_side_effect !== true ||
      imported.quota_no_side_effect !== true || imported.head_conflict_no_side_effect !== true) {
    fail("browser_import_matrix_mismatch");
  }
  digestFingerprint(imported.opaque_sha256, "browser_opaque_digest_missing");
  const comparisons = [
    validateExportComparison(value.exports[0], "current", "MD-BUNDLE-ZIP-1"),
    validateExportComparison(value.exports[1], "historical", "MD-OKF-ZIP-1"),
    validateExportComparison(value.exports[2], "mixed", "MD-BUNDLE-ZIP-1"),
  ];
  if (value.exports.length !== comparisons.length || value.redeploy.import_recovered !== true ||
      value.redeploy.export_recovered !== true ||
      value.redeploy.before_deployment_id !== expected.provider.deploymentBeforeId ||
      value.redeploy.after_deployment_id !== expected.provider.deploymentAfterId ||
      value.access.expired_denied !== true || value.access.credential_revoked_denied !== true ||
      value.access.visibility_tightened_denied !== true ||
      value.cleanup.credential_revoked !== true || value.cleanup.mind_deleted !== true ||
      value.cleanup.route_absent !== true || value.cleanup.jobs_absent !== true ||
      value.cleanup.grants_absent !== true) fail("browser_recovery_cleanup_mismatch");
  const serialized = JSON.stringify(value);
  for (const pattern of [
    /mdp_v1_|mdg_v1_|mdo_(?:code|access|refresh)_/iu,
    /authorization["']?\s*:/iu,
    /cookie["']?\s*:/iu,
    /download_url/iu,
    /body_base64/iu,
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
    /private[_/-](?:path|content|mind)/iu,
  ]) if (pattern.test(serialized)) fail("unsafe_browser_readback");
  return Object.freeze({
    observedAt,
    runFingerprint: value.run_fingerprint,
    actorFingerprints: Object.freeze(structuredClone(value.actor_fingerprints)),
    assertionIds: ids,
    exports: comparisons,
    importMatrix: Object.freeze(structuredClone(imported)),
    cleanup: Object.freeze(structuredClone(value.cleanup)),
  });
}

function normalizeStructuralBinding(input, expected) {
  if (!isRecord(input) || !isRecord(expected)) fail("invalid_structural_join_input");
  const local = validateLocalReceipt(input.localReceipt, expected.candidate);
  const provider = validateProviderReadback(
    input.providerReadback,
    expected,
    input.archiveBytes,
  );
  const browser = validateBrowserReadback(input.browserReadback, {
    candidate: expected.candidate,
    local,
    provider,
  });
  return Object.freeze({ input, expected, local, provider, browser });
}

function structuralJoinUnsigned(binding) {
  const { input, expected, local, provider, browser } = binding;
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
    }),
    byte_bindings: Object.freeze({
      upload_archive_sha256: provider.uploadArchiveSha256,
      upload_archive_size_bytes: provider.uploadArchiveSizeBytes,
      provider_archive_sha256: provider.archiveSha256,
      provider_archive_size_bytes: provider.providerArchiveSizeBytes,
      provider_archive_file_count: provider.providerArchiveFileCount,
      provider_archive_format: provider.providerArchiveFormat,
      local_receipt_sha256: local.artifactSha256,
      fixture_manifest_sha256: local.fixtureManifestSha256,
    }),
    input_hashes: Object.freeze({
      local_receipt_sha256: sha256Bytes(input.localReceiptBytes),
      provider_readback_sha256: sha256Bytes(input.providerReadbackBytes),
      browser_readback_sha256: sha256Bytes(input.browserReadbackBytes),
    }),
    run_fingerprint: browser.runFingerprint,
    actor_fingerprints: browser.actorFingerprints,
    assertions: browser.assertionIds.map((id) => Object.freeze({ id, status: "passed" })),
    import_matrix: browser.importMatrix,
    exports: browser.exports,
    cleanup: browser.cleanup,
    unresolved_provenance: Object.freeze([
      "sites-connector-call-origin-not-authenticated-offline",
      "in-app-browser-observation-origin-not-authenticated-offline",
    ]),
  });
}

export function createStructuralJoin(input, expected) {
  const binding = normalizeStructuralBinding(input, expected);
  const unsigned = structuralJoinUnsigned(binding);
  const result = Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
  validateStructuralJoin(result, { expected, input });
  return result;
}

export function validateStructuralJoin(value, binding) {
  validateArtifact(value, "invalid_structural_join");
  const normalized = normalizeStructuralBinding(binding?.input, binding?.expected);
  const expectedUnsigned = structuralJoinUnsigned(normalized);
  const { artifact_sha256: _artifactSha256, ...actualUnsigned } = value;
  if (canonical(actualUnsigned) !== canonical(expectedUnsigned)) fail("invalid_structural_join");
  if (value.status === "passed" || value.hosted_evidence === true) fail("offline_hosted_claim_forbidden");
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
  const required = ["local_receipt", "provider_readback", "browser_readback", "artifact_archive", "candidate_sha", "join_out"];
  for (const key of Object.keys(options)) if (!required.includes(key)) fail("unsupported_cli_argument");
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
    if (!PROJECT_ID.test(hosting.project_id ?? "")) fail("invalid_tracked_site_project");
    return Object.freeze({
      candidate: source.candidateSha,
      siteProjectId: hosting.project_id,
      siteSourceCommitSha: source.siteSourceCommitSha,
      siteSourceTreeSha: source.siteSourceTreeSha,
      siteSourceMode: source.siteSourceMode,
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
      process.stdout.write("Usage: npm run join:import-export-uat-readback -- --local-receipt <json> --provider-readback <json> --browser-readback <json> --artifact-archive <tgz> --candidate-sha <sha> --join-out <json>\n");
      return;
    }
    const [localReceiptBytes, providerReadbackBytes, browserReadbackBytes, archiveBytes] = await Promise.all([
      readFile(options.local_receipt),
      readFile(options.provider_readback),
      readFile(options.browser_readback),
      readFile(options.artifact_archive),
    ]);
    const providerReadback = JSON.parse(providerReadbackBytes.toString("utf8"));
    const expected = trackedContext(
      options.candidate_sha,
      providerReadback?.version?.source?.commit_sha,
    );
    const join = createStructuralJoin({
      localReceipt: JSON.parse(localReceiptBytes.toString("utf8")),
      providerReadback,
      browserReadback: JSON.parse(browserReadbackBytes.toString("utf8")),
      localReceiptBytes,
      providerReadbackBytes,
      browserReadbackBytes,
      archiveBytes,
    }, expected);
    const output = await reservePrivateTempOutput(options.join_out, {
      repositoryRoot: ROOT,
      errorCode: "unsafe_join_output",
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
