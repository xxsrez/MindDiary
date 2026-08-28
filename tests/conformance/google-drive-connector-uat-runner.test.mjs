import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createGoogleDriveUatPlanReceipt,
  createGoogleDriveUatStructuralJoin,
  GOOGLE_DRIVE_UAT_ASSERTION_IDS,
  GOOGLE_DRIVE_UAT_BLOCKER_CATEGORIES,
  GOOGLE_DRIVE_UAT_NEGATIVE_CASES,
  signGoogleDriveUatTestArtifact,
  validateGoogleDriveUatBlocker,
  validateGoogleDriveUatPlanReceipt,
  validateGoogleDriveUatStructuralJoin,
} from "../../scripts/lib/google-drive-connector-uat-evidence.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";
import {
  createPendingUatTestAccountPoolInventory,
  createUatTestAccountPoolReadinessReceipt,
} from "../../scripts/lib/uat-test-account-pool-contract.mjs";
import { parseCli as parseJoinCli } from "../../scripts/join-google-drive-connector-uat-readback.mjs";
import { parseCli as parsePrepareCli } from "../../scripts/prepare-google-drive-connector-uat.mjs";

const candidate = "a".repeat(40);
const projectId = "appgprj_example1428fe59b5d8381c";
const deploymentBefore = "appgdep_md319before";
const deploymentAfter = "appgdep_md319after";
const versionId = "appgver_md319fixture";
const observedAt = "2026-08-28T01:00:00.000Z";
const archiveBytes = Buffer.from("synthetic exact Site archive for MD-319", "utf8");

const contractUrl = new URL(
  "../fixtures/google-drive-connector-uat/contract.v1.json",
  import.meta.url,
);
const fixturePlanUrl = new URL(
  "../fixtures/google-drive-connector-uat/synthetic-fixture-plan.v1.json",
  import.meta.url,
);

function readyPoolReceipt() {
  const inventory = structuredClone(createPendingUatTestAccountPoolInventory());
  for (const key of Object.keys(inventory.owner_authority)) {
    inventory.owner_authority[key] = "owner-confirmed";
  }
  inventory.actors.forEach((actor, index) => {
    actor.actor_fingerprint = `actor-${String(index + 1).repeat(16)}`;
    actor.provisioning.external_account = "owner-confirmed";
    actor.provisioning.first_login_mfa = "owner-confirmed";
    actor.provisioning.independent_session = "verified";
  });
  inventory.readback.custom_audience = "exact";
  inventory.readback.operator_allowlist = "exact";
  inventory.readback.distinct_principals = "verified";
  inventory.baseline.temporary_mind_roles = "verified-absent";
  inventory.baseline.per_run_mcp_tokens = "verified-absent";
  return createUatTestAccountPoolReadinessReceipt(inventory, {
    observedAtUtc: observedAt,
    candidateSha: candidate,
    deploymentId: deploymentBefore,
  });
}

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function observationRef(kind, seed = kind) {
  return { kind, sha256: sha(seed) };
}

async function context() {
  const [contract, fixturePlan] = await Promise.all([
    readFile(contractUrl, "utf8").then(JSON.parse),
    readFile(fixturePlanUrl, "utf8").then(JSON.parse),
  ]);
  const planReceipt = createGoogleDriveUatPlanReceipt({
    contract,
    fixturePlan,
    poolReadinessReceipt: readyPoolReceipt(),
    candidate,
    projectId,
    deployment: deploymentBefore,
    observedAtUtc: observedAt,
  });
  return { contract, fixturePlan, planReceipt };
}

function sitesReadback() {
  return signGoogleDriveUatTestArtifact({
    schema: "mind-diary/google-drive-connector-sites-readback/v1",
    generator: "codex-sites-connector-same-run-readback/v1",
    status: "observed",
    candidate_sha: candidate,
    project_id: projectId,
    project_status: "active",
    version_id: versionId,
    version_source_candidate_sha: candidate,
    deployment_before: {
      id: deploymentBefore,
      status: "succeeded",
      updated_at_utc: "2026-08-28T00:58:00.000Z",
    },
    redeploy_start: {
      id: deploymentAfter,
      status: "publishing",
      updated_at_utc: "2026-08-28T00:59:00.000Z",
    },
    deployment_after: {
      id: deploymentAfter,
      status: "succeeded",
      updated_at_utc: observedAt,
    },
    archive_size: archiveBytes.byteLength,
    archive_sha256: sha(archiveBytes),
    observed_at_utc: observedAt,
    raw_observation_refs: [
      observationRef("site_version"),
      observationRef("deployment_before"),
      observationRef("deployment_after"),
    ],
  });
}

function providerFixture(fixture, index) {
  const snapshot = fixture.kind === "binary"
    ? { size: fixture.expected_source_size, sha256: fixture.expected_source_sha256 }
    : { size: 10_000 + index, sha256: sha(`native-export-${fixture.id}`) };
  return {
    fixture_id: fixture.id,
    selector_kind: "exact_object_id",
    object_count: 1,
    url_query_or_folder_selector_used: false,
    actor_owned_run_scoped_grant: true,
    source_media_type: fixture.source_media_type,
    representation_kind: fixture.representation.kind,
    provider_method: fixture.representation.provider_method,
    metadata_supports_all_drives: true,
    content_supports_all_drives: fixture.kind === "binary",
    shared_drive: fixture.kind !== "binary",
    export_format: fixture.representation.format ?? null,
    export_media_type: fixture.representation.export_media_type ?? null,
    provider_query_keys: fixture.kind === "binary" ? ["alt", "supportsAllDrives"] : ["mimeType"],
    snapshot_stable_before_and_after: true,
    metadata_observation_sha256: sha(`metadata-${fixture.id}`),
    source_snapshot: snapshot,
    staged_snapshot: { ...snapshot },
  };
}

function providerReadback(fixturePlan, planReceipt) {
  return signGoogleDriveUatTestArtifact({
    schema: "mind-diary/google-drive-connector-provider-readback/v1",
    generator: "direct-same-run-google-drive-observation/v1",
    status: "observed",
    candidate_sha: candidate,
    deployment_before_id: deploymentBefore,
    deployment_after_id: deploymentAfter,
    runner_id: "ship-work-release/uat-google-drive-connector-object/v1",
    run_fingerprint: planReceipt.run_fingerprint,
    provider: "google_drive",
    persistent_scope_changed: false,
    observed_at_utc: observedAt,
    fixtures: fixturePlan.fixtures.map(providerFixture),
    negative_matrix: GOOGLE_DRIVE_UAT_NEGATIVE_CASES.map((entry) => ({
      id: entry.id,
      status: "passed",
      product_code: entry.code,
      retryable: entry.retryable,
      provider_fetch_started: entry.providerFetch,
      indistinguishable: entry.indistinguishable,
      no_staged_state: true,
      no_head_change: true,
      raw_observation_sha256: sha(`negative-${entry.id}`),
    })),
    assertions: GOOGLE_DRIVE_UAT_ASSERTION_IDS.filter((id) =>
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 16].some((number) =>
        id.includes(`-${String(number).padStart(3, "0")}-`)
      )
    ).map((id) => ({ id, status: "passed" })),
    raw_observation_refs: [observationRef("provider_calls")],
  });
}

function productReadback(provider, planReceipt) {
  return signGoogleDriveUatTestArtifact({
    schema: "mind-diary/google-drive-connector-product-readback/v1",
    generator: "direct-same-run-mind-diary-observation/v1",
    status: "observed",
    candidate_sha: candidate,
    deployment_before_id: deploymentBefore,
    deployment_after_id: deploymentAfter,
    runner_id: "ship-work-release/uat-google-drive-connector-object/v1",
    run_fingerprint: planReceipt.run_fingerprint,
    observed_at_utc: observedAt,
    target_preflight: {
      server_derived_current_target: true,
      caller_owner_generation_or_version_absent: true,
      authorization_before_provider_read: true,
      concurrent_target_change_fail_closed: true,
    },
    lifecycle: provider.fixtures.map((fixture) => ({
      fixture_id: fixture.fixture_id,
      source_kind: "connector_object",
      staged_snapshot: { ...fixture.staged_snapshot },
      one_head_transition: true,
      revision_fingerprint: sha(`revision-${fixture.fixture_id}`),
      history_revision_visible: true,
      history_observation_sha256: sha(`history-${fixture.fixture_id}`),
      download_snapshot: { ...fixture.staged_snapshot },
      web_export_entry_snapshot: { ...fixture.staged_snapshot },
      web_export_archive_sha256: sha(`web-export-${fixture.fixture_id}`),
      web_export_actor_owned: true,
      redeploy_readback_visible: true,
    })),
    content_mcp: {
      administrative_export_absent: true,
      connector_locator_absent: true,
    },
    cleanup: {
      provider_objects_absent: true,
      run_grant_revoked: true,
      next_request_denied: true,
      run_mind_absent: true,
      staged_state_absent: true,
      jobs_and_download_grants_absent: true,
    },
    assertions: GOOGLE_DRIVE_UAT_ASSERTION_IDS.filter((id) =>
      [1, 11, 12, 13, 14, 15].some((number) =>
        id.includes(`-${String(number).padStart(3, "0")}-`)
      )
    ).map((id) => ({ id, status: "passed" })),
    raw_observation_refs: [observationRef("product_lifecycle")],
  });
}

function recompute(value) {
  const copy = structuredClone(value);
  delete copy.artifact_sha256;
  return signGoogleDriveUatTestArtifact(copy);
}

test("local MD-319 preflight is deterministic, privacy-safe and explicitly hosted not-run", async () => {
  const { planReceipt } = await context();
  assert.deepEqual(
    validateGoogleDriveUatPlanReceipt(planReceipt, { candidate, projectId, deployment: deploymentBefore }),
    planReceipt,
  );
  assert.equal(planReceipt.status, "ready_for_hosted_execution");
  assert.equal(planReceipt.hosted_evidence, false);
  assert.equal(planReceipt.acceptance, "nonterminal");
  assert.equal(planReceipt.hosted_execution.status, "not_run");
  assert.equal(planReceipt.assertion_results.every(({ status }) => status === "not_run"), true);
  assert.equal(planReceipt.cleanup.status, "not_run");
  assert.equal(JSON.stringify(planReceipt).includes("provider_object_id"), false);
});

test("offline readback join closes exact shapes but can never create hosted PASS", async () => {
  const { fixturePlan, planReceipt } = await context();
  const sites = sitesReadback();
  const provider = providerReadback(fixturePlan, planReceipt);
  const product = productReadback(provider, planReceipt);
  const inputs = {
    planReceipt,
    sitesReadback: sites,
    providerReadback: provider,
    productReadback: product,
    archiveBytes,
    fixturePlan,
  };
  const join = createGoogleDriveUatStructuralJoin(inputs, { candidate, projectId });
  assert.equal(join.status, "structurally_verified_readback");
  assert.equal(join.hosted_evidence, false);
  assert.equal(join.acceptance, "nonterminal");
  assert.equal(join.provenance, "unverified-local-files");
  assert.notEqual(join.status, "passed");
  assert.deepEqual(validateGoogleDriveUatStructuralJoin(join, inputs, { candidate, projectId }), join);
  assert.equal(join.fixture_snapshots.length, 4);
  assert.equal(join.assertions.length, 16);
});

test("join fails closed on archive, snapshot, negative, lifecycle and cleanup drift", async () => {
  const { fixturePlan, planReceipt } = await context();
  const validProvider = providerReadback(fixturePlan, planReceipt);
  const validProduct = productReadback(validProvider, planReceipt);
  const base = {
    planReceipt,
    sitesReadback: sitesReadback(),
    providerReadback: validProvider,
    productReadback: validProduct,
    archiveBytes,
    fixturePlan,
  };
  const cases = [
    () => ({ ...base, archiveBytes: Buffer.from("changed", "utf8") }),
    () => {
      const provider = structuredClone(validProvider);
      provider.fixtures[1].staged_snapshot.sha256 = sha("changed-native");
      return { ...base, providerReadback: recompute(provider) };
    },
    () => {
      const provider = structuredClone(validProvider);
      provider.negative_matrix[4].no_head_change = false;
      return { ...base, providerReadback: recompute(provider) };
    },
    () => {
      const product = structuredClone(validProduct);
      product.lifecycle[0].download_snapshot.size += 1;
      return { ...base, productReadback: recompute(product) };
    },
    () => {
      const product = structuredClone(validProduct);
      product.cleanup.run_grant_revoked = false;
      return { ...base, productReadback: recompute(product) };
    },
  ];
  for (const mutate of cases) {
    assert.throws(
      () => createGoogleDriveUatStructuralJoin(mutate(), { candidate, projectId }),
      ProbeFailure,
    );
  }
});

test("CLI has no hosted-pass or approval input", () => {
  assert.deepEqual(parsePrepareCli([
    "--candidate-sha", candidate,
    "--deployment-id", deploymentBefore,
    "--pool-readiness-receipt", "/tmp/pool.json",
    "--evidence-out", "/tmp/plan.json",
  ]), {
    candidate_sha: candidate,
    deployment_id: deploymentBefore,
    pool_readiness_receipt: "/tmp/pool.json",
    evidence_out: "/tmp/plan.json",
  });
  assert.deepEqual(parseJoinCli([
    "--plan-receipt", "/tmp/plan.json",
    "--sites-readback", "/tmp/sites.json",
    "--provider-readback", "/tmp/drive.json",
    "--product-readback", "/tmp/product.json",
    "--artifact-archive", "/tmp/site.tgz",
    "--candidate-sha", candidate,
    "--join-out", "/tmp/join.json",
  ]), {
    plan_receipt: "/tmp/plan.json",
    sites_readback: "/tmp/sites.json",
    provider_readback: "/tmp/drive.json",
    product_readback: "/tmp/product.json",
    artifact_archive: "/tmp/site.tgz",
    candidate_sha: candidate,
    join_out: "/tmp/join.json",
  });
  for (const parse of [parsePrepareCli, parseJoinCli]) {
    assert.throws(
      () => parse(["--hosted-pass", "true"]),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("blocker taxonomy is closed and evidence documents reject provider identity or secret fields", async () => {
  const blocker = {
    category: GOOGLE_DRIVE_UAT_BLOCKER_CATEGORIES[2],
    code: "hosted_connector_primitive_missing",
    affected_assertion_ids: [GOOGLE_DRIVE_UAT_ASSERTION_IDS[1]],
    resume_signal: "exact_hosted_connector_primitive_is_observed",
  };
  assert.deepEqual(validateGoogleDriveUatBlocker(blocker), blocker);
  assert.throws(
    () => validateGoogleDriveUatBlocker({ ...blocker, category: "manual_review" }),
    ProbeFailure,
  );

  const { fixturePlan, planReceipt } = await context();
  const provider = structuredClone(providerReadback(fixturePlan, planReceipt));
  provider.fixtures[0].provider_object_id = "unsafe-raw-object";
  assert.throws(() => recompute(provider), ProbeFailure);
});
