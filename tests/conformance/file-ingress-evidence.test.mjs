import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  HOSTED_RECEIPT_SCHEMA,
  createLocalReceipt,
  joinFileIngressEvidence,
  loadFileIngressEvidenceConfig,
  sealDocument,
  validateHostedReceipt,
  validateLocalReceipt,
  verifyDeterministicFixtures,
} from "../../scripts/lib/file-ingress-evidence.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const candidateSha = "a".repeat(40);
const deployment = Object.freeze({
  site_project_id: "site-project-md314",
  site_version_id: "site-version-md314",
  deployment_id: "deployment-md314",
  live_url: "https://mind-diary.example.test",
});
const digest = (character) => `sha256:${character.repeat(64)}`;

async function config() {
  return loadFileIngressEvidenceConfig(repositoryRoot);
}

function fixtureForRow(current, row) {
  return current.fixtures.fixtures.find(({ id }) => id === row.fixture_ids[0]);
}

function artifactObservations(current, row) {
  const fixture = fixtureForRow(current, row);
  const tuple = Object.freeze({
    canonical_path: `synthetic/md314/${row.source_kind.replaceAll("/", "-").replaceAll("_", "-")}.bin`,
    sha256: fixture.sha256,
    size: fixture.size_bytes,
  });
  return Object.freeze({
    source_snapshot: Object.freeze({
      sha256: tuple.sha256,
      size: tuple.size,
      snapshot_semantics: row.snapshot_semantics,
      snapshot_fingerprint: digest("f"),
    }),
    commit: tuple,
    history: tuple,
    download: tuple,
    web_export: tuple,
    post_redeploy: tuple,
  });
}

function aggregateRowStatuses(statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("not_available")) return "not_available";
  return "passed";
}

function hostedReceipt(current, profileId, options = {}) {
  const profile = current.registry.client_profiles.find(({ id }) => id === profileId);
  const profileRows = current.registry.rows.filter(({ client_profile_id }) => client_profile_id === profileId);
  const failedRowId = options.failedRowId ?? null;
  const defaultStatus = options.status ?? (failedRowId === null ? "passed" : "not_available");
  const failedAssertionId = "hosted.stage.exact-transport";
  const assertions = current.registry.assertion_ids.hosted.map((id) => ({
    id,
    status: id === failedAssertionId && failedRowId !== null ? "failed" : "passed",
  }));
  const rows = profileRows.map((row) => {
    const status = row.id === failedRowId ? "failed" : defaultStatus;
    if (status === "passed") {
      return {
        row_id: row.id,
        status,
        assertion_ids: [...row.pass_assertion_ids],
        error_code: null,
        unexpected_side_effect_count: 0,
        artifact_observations: artifactObservations(current, row),
      };
    }
    if (status === "not_available") {
      return {
        row_id: row.id,
        status,
        assertion_ids: [...row.not_available_assertion_ids],
        error_code: row.source_kind === "session_attachment"
          ? "native_file_input_unsupported"
          : "file_ingress_source_unavailable",
        unexpected_side_effect_count: 0,
        artifact_observations: null,
      };
    }
    return {
      row_id: row.id,
      status,
      assertion_ids: [failedAssertionId],
      error_code: "assertion_failed",
      unexpected_side_effect_count: 0,
      artifact_observations: null,
    };
  });
  const passingRows = rows.filter(({ status }) => status === "passed");
  const failedRows = rows.filter(({ status }) => status === "failed");
  const mixedChangeset = failedRows.length > 0
    ? {
        status: "failed",
        row_ids: passingRows.map(({ row_id }) => row_id),
        revision_fingerprint: null,
        markdown_sha256: null,
        head_transitions: 0,
        post_redeploy: false,
        error_code: "assertion_failed",
      }
    : passingRows.length === 0
      ? {
          status: "not_available",
          row_ids: [],
          revision_fingerprint: null,
          markdown_sha256: null,
          head_transitions: 0,
          post_redeploy: false,
          error_code: "file_ingress_source_unavailable",
        }
      : {
          status: "passed",
          row_ids: passingRows.map(({ row_id }) => row_id),
          revision_fingerprint: digest("d"),
          markdown_sha256: digest("e"),
          head_transitions: 1,
          post_redeploy: true,
          error_code: null,
        };
  return sealDocument({
    schema: HOSTED_RECEIPT_SCHEMA,
    status: aggregateRowStatuses(rows.map(({ status }) => status)),
    candidate_sha: options.candidateSha ?? candidateSha,
    registry_sha256: current.registrySha256,
    client_profile_id: profileId,
    actor_class: "synthetic_registered_principal",
    credential_class: "synthetic_oauth_content_write",
    client_snapshot: {
      client_class: profile.client_class,
      client_version: "synthetic-contract-fixture-1",
      protocol_profile: profile.protocol_profile,
      host_fingerprint: digest("b"),
      tool_inventory_sha256: digest("c"),
      captured_at: "2026-08-27T20:00:00.000Z",
    },
    deployment: options.deployment ?? deployment,
    setup_cleanup: {
      fixture_namespace: "md314-synthetic-conformance",
      synthetic_only: true,
      setup_replayed: true,
      recovery_replayed: true,
      cleanup_replayed: true,
      remaining_side_effects: 0,
    },
    mixed_changeset: mixedChangeset,
    assertions,
    rows,
  });
}

function passingLocalReceipt(current, sha = candidateSha) {
  return createLocalReceipt({
    registry: current.registry,
    candidateSha: sha,
    registrySha256: current.registrySha256,
    fixturePlanSha256: current.fixturePlanSha256,
    assertionStatuses: new Map(
      current.registry.assertion_ids.local.map((id) => [id, "passed"]),
    ),
  });
}

test("MD-314 registry is versioned, closed across source x profile and names authority boundaries", async () => {
  const current = await config();
  assert.equal(current.registry.schema, "mind-diary/file-ingress-evidence-registry/v1");
  assert.equal(current.registry.release, "0.3");
  assert.equal(current.registry.rows.length, 18);
  assert.deepEqual(
    current.registry.client_profiles.map(({ id }) => id),
    [
      "repository-node-test-v1",
      "codex-modern-2026-07-28",
      "codex-compat-2025-11-25",
    ],
  );
  for (const row of current.registry.rows) {
    assert.match(row.actor_class, /^synthetic_/u);
    assert.match(row.credential_class, /^synthetic_/u);
    assert.equal(row.human_only_boundary, "none");
    assert.ok(row.external_prerequisite.length > 0);
    assert.ok(row.pass_assertion_ids.length > 0);
  }
  const sizes = new Map(current.fixtures.fixtures.map(({ id, size_bytes }) => [id, size_bytes]));
  assert.equal(sizes.get("local-path-256mib"), 268_435_456);
  assert.equal(sizes.get("local-path-256mib-plus-one"), 268_435_457);
  assert.equal(sizes.get("bounded-4mib"), 4_194_304);
  assert.equal(sizes.get("bounded-4mib-plus-one"), 4_194_305);
  assert.equal(await verifyDeterministicFixtures(current.fixtures), true);
});

test("local receipt is deterministic and cannot promote missing hosted evidence", async () => {
  const current = await config();
  const local = passingLocalReceipt(current);
  assert.equal(validateLocalReceipt(local, {
    registry: current.registry,
    candidateSha,
    registrySha256: current.registrySha256,
    fixturePlanSha256: current.fixturePlanSha256,
  }), local);
  const report = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: local,
    hostedReceipts: [],
  });
  assert.equal(report.status, "pending");
  assert.deepEqual(report.summary, { passed: 6, not_available: 0, pending: 12, failed: 0 });
  assert.equal(report.gaps.length, 12);
  assert.equal(report.gaps.every(({ code }) => code === "hosted_receipt_missing"), true);
});

test("same-candidate modern and compatibility receipts join exact artifact read-back", async () => {
  const current = await config();
  const modern = hostedReceipt(current, "codex-modern-2026-07-28");
  const compatibility = hostedReceipt(current, "codex-compat-2025-11-25");
  for (const receipt of [modern, compatibility]) {
    assert.equal(validateHostedReceipt(receipt, {
      registry: current.registry,
      candidateSha,
      registrySha256: current.registrySha256,
    }), receipt);
  }
  const report = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: passingLocalReceipt(current),
    hostedReceipts: [modern, compatibility],
  });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.summary, { passed: 18, not_available: 0, pending: 0, failed: 0 });
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.deployment, deployment);
});

test("typed hosted not-available is terminal but never counted as passing", async () => {
  const current = await config();
  const modern = hostedReceipt(current, "codex-modern-2026-07-28", { status: "not_available" });
  const compatibility = hostedReceipt(current, "codex-compat-2025-11-25", { status: "not_available" });
  validateHostedReceipt(modern, {
    registry: current.registry,
    candidateSha,
    registrySha256: current.registrySha256,
  });
  const report = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: passingLocalReceipt(current),
    hostedReceipts: [modern, compatibility],
  });
  assert.equal(report.status, "not_available");
  assert.deepEqual(report.summary, { passed: 6, not_available: 12, pending: 0, failed: 0 });
  assert.equal(report.gaps.every(({ status }) => status === "not_available"), true);

  const unsafe = structuredClone(modern);
  unsafe.rows[0].unexpected_side_effect_count = 1;
  assert.throws(
    () => validateHostedReceipt(unsafe, {
      registry: current.registry,
      candidateSha,
      registrySha256: current.registrySha256,
    }),
    /hosted_not_available_side_effect|invalid_hosted_receipt_digest/u,
  );
});

test("stale candidates, changed artifact tuples and cross-deployment receipts fail closed", async () => {
  const current = await config();
  const stale = hostedReceipt(current, "codex-modern-2026-07-28", {
    candidateSha: "b".repeat(40),
  });
  const changed = structuredClone(hostedReceipt(current, "codex-modern-2026-07-28"));
  changed.rows[0].artifact_observations.history = {
    ...changed.rows[0].artifact_observations.history,
    sha256: digest("9"),
  };
  assert.throws(
    () => validateHostedReceipt(changed, {
      registry: current.registry,
      candidateSha,
      registrySha256: current.registrySha256,
    }),
    /hosted_artifact_readback_mismatch|invalid_hosted_receipt_digest/u,
  );
  const otherDeployment = hostedReceipt(current, "codex-compat-2025-11-25", {
    deployment: { ...deployment, deployment_id: "deployment-other" },
  });
  const report = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: passingLocalReceipt(current),
    hostedReceipts: [stale, otherDeployment],
  });
  assert.equal(report.status, "failed");
  assert.equal(
    report.rows.filter(({ evidence_scope, status }) => evidence_scope === "hosted_uat" && status === "failed").length,
    6,
  );
  assert.equal(
    report.rows.filter(({ status_code }) => status_code === "hosted_candidate_sha_mismatch").length,
    6,
  );

  const crossDeployment = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: passingLocalReceipt(current),
    hostedReceipts: [
      hostedReceipt(current, "codex-modern-2026-07-28"),
      otherDeployment,
    ],
  });
  assert.equal(crossDeployment.status, "failed");
  assert.equal(
    crossDeployment.rows.filter(({ status_code }) => status_code === "cross_profile_deployment_mismatch").length,
    12,
  );
});

test("a concrete failed row makes the report CLI exit nonzero; missing receipts fail require-complete", async () => {
  const current = await config();
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout.trim();
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-md314-evidence-"));
  try {
    const localPath = join(directory, "local.json");
    const hostedPath = join(directory, "hosted-modern.json");
    const failedOutput = join(directory, "failed-report.json");
    const pendingOutput = join(directory, "pending-report.json");
    await writeFile(localPath, JSON.stringify(passingLocalReceipt(current, head)));
    await writeFile(
      hostedPath,
      JSON.stringify(hostedReceipt(current, "codex-modern-2026-07-28", {
        candidateSha: head,
        failedRowId: "hosted.modern.session-attachment",
      })),
    );
    const failed = spawnSync(
      process.execPath,
      [
        "scripts/generate-file-ingress-matrix-report.mjs",
        "--sha",
        "HEAD",
        "--local-receipt",
        localPath,
        "--hosted-receipt",
        `codex-modern-2026-07-28=${hostedPath}`,
        "--output",
        failedOutput,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(failed.status, 1, failed.stderr || failed.stdout);
    assert.equal(JSON.parse(await readFile(failedOutput, "utf8")).status, "failed");

    const pending = spawnSync(
      process.execPath,
      [
        "scripts/generate-file-ingress-matrix-report.mjs",
        "--sha",
        "HEAD",
        "--local-receipt",
        localPath,
        "--output",
        pendingOutput,
        "--require-complete",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(pending.status, 2, pending.stderr || pending.stdout);
    assert.equal(JSON.parse(await readFile(pendingOutput, "utf8")).status, "pending");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
