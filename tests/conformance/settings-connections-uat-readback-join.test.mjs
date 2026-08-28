import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createStructuralJoin,
  parseCli,
  validateStructuralJoin,
} from "../../scripts/join-settings-connections-uat-readback.mjs";
import {
  canonical,
  digest,
  ProbeFailure,
} from "../../scripts/lib/multi-principal-probe-core.mjs";
import { createProviderRequestLogBoundaryReceipt } from "../../scripts/lib/provider-request-log-boundary.mjs";
import {
  createPendingUatTestAccountPoolInventory,
  createUatTestAccountPoolReadinessReceipt,
} from "../../scripts/lib/uat-test-account-pool-contract.mjs";
import {
  createEvidence,
  SETTINGS_CONNECTIONS_RUNTIME_SUITES,
  SETTINGS_CONNECTIONS_SOURCE_PATHS,
} from "../../scripts/run-settings-connections-local-gate.mjs";

const candidate = "a".repeat(40);
const siteSourceCommitSha = "b".repeat(40);
const siteSourceTreeSha = "c".repeat(40);
const siteSourceMode = "subtree-mirror";
const siteProjectId = "appgprj_md358fixture";
const versionId = `${siteProjectId}~appgver_md358fixture`;
const deploymentBefore = "appgdep_md358before";
const deploymentAfter = "appgdep_md358after";
const archiveBytes = Buffer.from("exact md358 site archive", "utf8");
const providerArchiveBytes = Buffer.from("normalized md358 provider tar", "utf8");
const hostedAssertionIds = [
  "SC-LINEAGE-01",
  "SC-NAV-01",
  "SC-OAUTH-01",
  "SC-OAUTH-02",
  "SC-OAUTH-03",
  "SC-TOKEN-01",
  "SC-TOKEN-02",
  "SC-TOKEN-03",
  "SC-REDEPLOY-01",
  "SC-PRIVACY-01",
  "SC-CLEANUP-01",
];
const localAssertionIds = [
  "SC-NAV-01",
  "SC-OAUTH-01",
  "SC-OAUTH-02",
  "SC-TOKEN-01",
  "SC-TOKEN-02",
  "SC-PRIVACY-01",
  "SC-FAIL-CLOSED-01",
];
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const marked = (marker) => `sha256:${marker.repeat(64)}`;

function expected() {
  return {
    candidate,
    siteProjectId,
    siteSourceCommitSha,
    siteSourceTreeSha,
    siteSourceMode,
    contractSha256: marked("1"),
    contract: {
      local_assertion_ids: localAssertionIds,
      hosted_assertion_ids: hostedAssertionIds,
    },
  };
}

function localReceipt() {
  return createEvidence({
    candidate,
    contractSha256: marked("1"),
    oauth: {
      artifact_sha256: marked("2"),
      marketplace_candidate_sha: "b".repeat(40),
      marketplace_tree_sha: "c".repeat(40),
      plugin_version: "0.1.0",
      plugin_snapshot_sha256: marked("3"),
      client: "codex-cli",
      client_version: "0.150.1",
      routes: ["/api/mcp", "/api/mcp/2025-11-25"],
      catalog_profiles: {
        default_product_site_write: 17,
        read_only: 16,
        verified_native: 18,
      },
    },
    toolchain: {
      playwright_package_version: "1.62.1",
      playwright_cli_version: "1.62.1",
      chromium_package_version: "1.62.1",
      playwright_core_version: "1.62.1",
      chromium_revision: "1234",
      chromium_browser_version: "151.0.7922.34",
      chromium_executable_sha256: marked("4"),
    },
    runtimeSuites: SETTINGS_CONNECTIONS_RUNTIME_SUITES.map((path) => ({
      path,
      status: "passed",
      source_sha256: marked("5"),
      stdout_sha256: marked("6"),
    })),
    sourceHashes: Object.fromEntries(
      SETTINGS_CONNECTIONS_SOURCE_PATHS.map((path) => [path, marked("7")]),
    ),
    assertions: localAssertionIds.map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-28T01:00:00.000Z",
    completedAt: "2026-08-28T01:01:00.000Z",
  });
}

function providerReadback() {
  return {
    schema: "mind-diary/settings-connections-sites-provider-readback/v1",
    generator: "codex-sites-connector-readback/v1",
    observed_at_utc: "2026-08-28T01:04:00.123456+00:00",
    site: { id: siteProjectId, status: "active", current_live_url: "https://mind-diary.example.invalid" },
    version: {
      id: versionId,
      project_id: siteProjectId,
      source: { commit_sha: siteSourceCommitSha },
      archive_storage: {
        archive_format: "tar",
        content_hash: sha256(providerArchiveBytes).slice("sha256:".length),
        size_bytes: providerArchiveBytes.byteLength,
        file_count: 58,
      },
    },
    deployment_before: {
      id: deploymentBefore,
      project_id: siteProjectId,
      version_id: versionId,
      type: "publish",
      status: "succeeded",
      url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-28T01:01:30+00:00",
    },
    redeploy_start: {
      id: deploymentAfter,
      project_id: siteProjectId,
      version_id: versionId,
      type: "publish",
      status: "publishing",
      url: null,
      updated_at: "2026-08-28T01:02:00.123456+00:00",
    },
    deployment_after: {
      id: deploymentAfter,
      project_id: siteProjectId,
      version_id: versionId,
      type: "publish",
      status: "succeeded",
      url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-28T01:03:00.999999+00:00",
    },
  };
}

function poolReadback() {
  const inventory = structuredClone(createPendingUatTestAccountPoolInventory());
  for (const key of Object.keys(inventory.owner_authority)) inventory.owner_authority[key] = "owner-confirmed";
  inventory.readback = {
    custom_audience: "exact",
    operator_allowlist: "exact",
    distinct_principals: "verified",
  };
  inventory.baseline = {
    temporary_mind_roles: "verified-absent",
    per_run_mcp_tokens: "verified-absent",
  };
  inventory.actors.forEach((actor, index) => {
    actor.actor_fingerprint = `actor-${String(index + 1).repeat(16)}`;
    actor.provisioning = {
      external_account: "owner-confirmed",
      first_login_mfa: "owner-confirmed",
      independent_session: "verified",
    };
  });
  return createUatTestAccountPoolReadinessReceipt(inventory, {
    observedAtUtc: "2026-08-28T01:03:30.000Z",
    candidateSha: candidate,
    deploymentId: deploymentAfter,
  });
}

function providerBoundaryReadback() {
  const reference = (suffix) => ({ locator: `repo:md358/${suffix}`, sha256: marked("8") });
  return createProviderRequestLogBoundaryReceipt({
    candidate_sha: candidate,
    deployment: {
      site_project_id: siteProjectId,
      site_version_id: versionId,
      deployment_id: deploymentAfter,
      archive_sha256: sha256(providerArchiveBytes),
    },
    observed_at_utc: "2026-08-28T01:04:30.000Z",
    application_evidence: [
      { classification: "application_telemetry", status: "passed", evidence: reference("telemetry") },
      { classification: "application_service_audit", status: "passed", evidence: reference("audit") },
      { classification: "release_receipt", status: "passed", evidence: reference("release") },
    ],
    provider_evidence: [
      "source_network_metadata",
      "client_software_metadata",
      "request_target_metadata",
      "request_header_metadata",
      "payload_metadata",
      "credential_metadata",
      "signed_resource_metadata",
      "retention_control",
      "reduction_control",
      "access_control",
      "deletion_control",
    ].map((classification) => ({ classification, status: "not_available", evidence: reference(classification) })),
    authority: { status: "recorded", evidence: reference("authority") },
  });
}

function browserReadback(pool = poolReadback()) {
  const passed = (keys) => Object.fromEntries(keys.map((key) => [key, true]));
  return {
    schema: "mind-diary/settings-connections-in-app-browser-readback/v1",
    generator: "codex-in-app-browser-same-run-readback/v1",
    browser_surface: "codex-in-app-browser",
    live_url: "https://mind-diary.example.invalid",
    candidate_sha: candidate,
    deployment_id: deploymentAfter,
    local_receipt_sha256: localReceipt().artifact_sha256,
    plugin_version: "0.1.0",
    client: "codex-cli",
    client_version: "0.150.1",
    observed_at_utc: "2026-08-28T01:05:00.000Z",
    run_fingerprint: marked("9"),
    actor_fingerprints: {
      "UAT-MIND-ROLE": pool.actors[1].actor_fingerprint,
      "UAT-ORDINARY": pool.actors[2].actor_fingerprint,
    },
    assertions: hostedAssertionIds.map((id) => ({ id, status: "passed" })),
    help: passed(["stable_no_connection", "stable_active", "stable_revoked"]),
    oauth: passed([
      "no_connection", "active", "acl_summary", "read_selector_absent", "target_selected",
      "target_switched", "target_cleared", "revoked_hidden", "next_request_denied",
      "reconnect_empty_target",
    ]),
    personal_token: passed([
      "created_show_once", "created_empty_target", "target_selected", "target_switched",
      "target_cleared", "revoked", "next_request_denied", "reissued_empty_target",
    ]),
    redeploy: passed(["connection_persisted", "token_persisted", "target_persisted"]),
    privacy: passed([
      "ordinary_projection_redacted", "forbidden_fields_absent", "raw_response_bodies_not_persisted",
    ]),
    cleanup: passed([
      "provider_credentials_absent", "product_credentials_absent", "targets_absent",
      "run_mind_absent", "pool_baseline_restored", "next_requests_denied",
    ]),
  };
}

function inputs(overrides = {}) {
  const local = overrides.localReceipt ?? localReceipt();
  const provider = overrides.providerReadback ?? providerReadback();
  const pool = overrides.poolReadback ?? poolReadback();
  const boundary = overrides.providerBoundaryReadback ?? providerBoundaryReadback();
  const browser = overrides.browserReadback ?? browserReadback(pool);
  return {
    localReceipt: local,
    providerReadback: provider,
    poolReadback: pool,
    providerBoundaryReadback: boundary,
    browserReadback: browser,
    localReceiptBytes: Buffer.from(JSON.stringify(local)),
    providerReadbackBytes: Buffer.from(JSON.stringify(provider)),
    poolReadbackBytes: Buffer.from(JSON.stringify(pool)),
    providerBoundaryReadbackBytes: Buffer.from(JSON.stringify(boundary)),
    browserReadbackBytes: Buffer.from(JSON.stringify(browser)),
    archiveBytes,
  };
}

function recompute(value) {
  const { artifact_sha256: _artifact, ...unsigned } = value;
  value.artifact_sha256 = digest(canonical(unsigned));
  return value;
}

test("MD-358 join CLI has no approval, hosted-pass or actor override input", () => {
  const argv = [
    "--local-receipt", "/tmp/local.json",
    "--provider-readback", "/tmp/provider.json",
    "--pool-readback", "/tmp/pool.json",
    "--provider-boundary-readback", "/tmp/boundary.json",
    "--browser-readback", "/tmp/browser.json",
    "--artifact-archive", "/tmp/site.tgz",
    "--candidate-sha", candidate,
    "--join-out", "/tmp/join.json",
  ];
  assert.equal(parseCli(argv).candidate_sha, candidate);
  for (const option of ["--hosted-pass", "--approve", "--actor-fingerprint"]) {
    assert.throws(
      () => parseCli([option, "forged"]),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("lookalike files join exact lineage and cleanup but can never produce hosted PASS", () => {
  const input = inputs();
  const value = createStructuralJoin(input, expected());
  assert.equal(value.status, "structurally_verified_readback");
  assert.equal(value.hosted_evidence, false);
  assert.equal(value.acceptance, "nonterminal");
  assert.equal(value.provenance, "unverified-local-files");
  assert.equal(value.claimed_lineage.deployment_after_id, deploymentAfter);
  assert.equal(value.claimed_lineage.site_version_id, versionId);
  assert.equal(value.claimed_lineage.upload_archive_sha256, sha256(archiveBytes));
  assert.equal(value.claimed_lineage.provider_archive_sha256, sha256(providerArchiveBytes));
  assert.equal(value.claimed_lineage.provider_archive_format, "tar");
  assert.equal(value.cleanup.provider_credentials_absent, true);
  assert.match(value.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
});

test("candidate, deployment, actor, cleanup and privacy mismatches fail closed", () => {
  const wrongActorPool = poolReadback();
  const wrongActorBrowser = browserReadback(wrongActorPool);
  wrongActorBrowser.actor_fingerprints["UAT-ORDINARY"] = "actor-9999999999999999";
  assert.throws(
    () => createStructuralJoin(inputs({ poolReadback: wrongActorPool, browserReadback: wrongActorBrowser }), expected()),
    (error) => error instanceof ProbeFailure && error.code === "browser_actor_mismatch",
  );

  const noCleanup = browserReadback();
  noCleanup.cleanup.provider_credentials_absent = false;
  assert.throws(
    () => createStructuralJoin(inputs({ browserReadback: noCleanup }), expected()),
    (error) => error instanceof ProbeFailure && error.code === "browser_cleanup_matrix_mismatch",
  );

  const unsafe = browserReadback();
  unsafe.raw_response_body = "private";
  assert.throws(
    () => createStructuralJoin(inputs({ browserReadback: unsafe }), expected()),
    (error) => error instanceof ProbeFailure && error.code === "unsafe_browser_readback",
  );

  const wrongProvider = providerReadback();
  wrongProvider.version.source.commit_sha = "f".repeat(40);
  assert.throws(
    () => createStructuralJoin(inputs({ providerReadback: wrongProvider }), expected()),
    (error) => error instanceof ProbeFailure && error.code === "provider_lineage_mismatch",
  );
});

test("a recomputed offline artifact cannot be promoted or edited semantically", () => {
  const input = inputs();
  const original = createStructuralJoin(input, expected());
  for (const mutate of [
    (value) => { value.status = "passed"; value.hosted_evidence = true; },
    (value) => { value.claimed_lineage.client_version = "forged"; },
    (value) => { value.oauth.reconnect_empty_target = false; },
    (value) => { value.cleanup.pool_baseline_restored = false; },
  ]) {
    const value = structuredClone(original);
    mutate(value);
    recompute(value);
    assert.throws(
      () => validateStructuralJoin(value, { input, expected: expected() }),
      (error) => error instanceof ProbeFailure && error.code === "invalid_structural_join",
    );
  }
});
