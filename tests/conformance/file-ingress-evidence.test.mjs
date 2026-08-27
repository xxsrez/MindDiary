import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MCP_TOOL_DEFINITIONS } from "../../packages/adapter-mcp/dist/index.js";

import {
  HOSTED_RECEIPT_SCHEMA,
  canonicalJson,
  createHostedDeploymentAnchor,
  createLocalReceipt,
  joinFileIngressEvidence,
  loadFileIngressEvidenceConfig,
  sealDocument,
  sha256,
  validateHostedDeploymentAnchor,
  validateHostedReceipt,
  validateLocalReceipt,
  verifyDeterministicFixtures,
} from "../../scripts/lib/file-ingress-evidence.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const candidateSha = "a".repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;

async function config() {
  return loadFileIngressEvidenceConfig(repositoryRoot);
}

function deploymentAnchor(current, sha = candidateSha, options = {}) {
  return createHostedDeploymentAnchor({
    candidateSha: sha,
    hostedAuthority: current.hostedAuthority,
    siteVersionId: options.siteVersionId ?? "site-version-md314",
    deploymentId: options.deploymentId ?? "deployment-md314",
  });
}

function deploymentForAnchor(anchor) {
  return Object.freeze({
    provider: anchor.provider,
    product_environment: anchor.product_environment,
    target_kind: anchor.target_kind,
    site_project_id: anchor.site_project_id,
    site_version_id: anchor.site_version_id,
    deployment_id: anchor.deployment_id,
    live_url: anchor.live_url,
    candidate_sha: anchor.candidate_sha,
    target_fingerprint: anchor.target_fingerprint,
  });
}

function hostedValidation(current, anchor = deploymentAnchor(current)) {
  return {
    registry: current.registry,
    candidateSha,
    registrySha256: current.registrySha256,
    toolInventory: current.toolInventory,
    hostedAuthority: current.hostedAuthority,
    hostedDeploymentAnchor: anchor,
  };
}

function reseal(document) {
  const { artifact_sha256: _artifactSha256, ...unsigned } = document;
  return sealDocument(unsigned);
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
  const anchor = options.anchor ?? deploymentAnchor(current);
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
      client_name: profile.client_name,
      client_version: profile.client_version,
      protocol_profile: profile.protocol_profile,
      tool_inventory_route: profile.tool_inventory_route,
      host_fingerprint: digest("b"),
      plugin_package: structuredClone(current.registry.hosted_authority.plugin_package),
      tool_inventory: structuredClone(current.toolInventory.entries),
      tool_inventory_sha256: `sha256:${sha256(canonicalJson(current.toolInventory.entries))}`,
      capture_boundary: current.registry.hosted_authority.trusted_runner_boundary,
      captured_at: "2026-08-27T20:00:00.000Z",
    },
    deployment: options.deployment ?? deploymentForAnchor(anchor),
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
  assert.equal(current.registry.schema, "mind-diary/file-ingress-evidence-registry/v2");
  assert.equal(current.registry.release, "0.3");
  assert.equal(current.registry.rows.length, 18);
  assert.equal(current.toolInventory.entries.length, 23);
  assert.equal(
    current.registry.hosted_authority.tool_inventory_sha256,
    current.toolInventorySha256,
  );
  assert.deepEqual(
    current.toolInventory.entries,
    MCP_TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      source: current.toolInventory.source,
      input_schema_sha256: `sha256:${sha256(canonicalJson(definition.inputSchema))}`,
      output_schema_sha256: `sha256:${sha256(canonicalJson(definition.outputSchema))}`,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  );
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
  const anchor = deploymentAnchor(current);
  const modern = hostedReceipt(current, "codex-modern-2026-07-28");
  const compatibility = hostedReceipt(current, "codex-compat-2025-11-25");
  for (const receipt of [modern, compatibility]) {
    assert.equal(validateHostedReceipt(receipt, hostedValidation(current, anchor)), receipt);
  }
  const report = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: passingLocalReceipt(current),
    hostedReceipts: [modern, compatibility],
    hostedDeploymentAnchor: anchor,
  });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.summary, { passed: 18, not_available: 0, pending: 0, failed: 0 });
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.deployment, deploymentForAnchor(anchor));
});

test("typed hosted not-available is terminal but never counted as passing", async () => {
  const current = await config();
  const anchor = deploymentAnchor(current);
  const modern = hostedReceipt(current, "codex-modern-2026-07-28", { status: "not_available" });
  const compatibility = hostedReceipt(current, "codex-compat-2025-11-25", { status: "not_available" });
  validateHostedReceipt(modern, hostedValidation(current, anchor));
  const report = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: passingLocalReceipt(current),
    hostedReceipts: [modern, compatibility],
    hostedDeploymentAnchor: anchor,
  });
  assert.equal(report.status, "not_available");
  assert.deepEqual(report.summary, { passed: 6, not_available: 12, pending: 0, failed: 0 });
  assert.equal(report.gaps.every(({ status }) => status === "not_available"), true);

  const unsafe = structuredClone(modern);
  unsafe.rows[0].unexpected_side_effect_count = 1;
  assert.throws(
    () => validateHostedReceipt(unsafe, hostedValidation(current, anchor)),
    /hosted_not_available_side_effect|invalid_hosted_receipt_digest/u,
  );
});

test("hosted target, client version, plugin package and closed tool inventory reject forged evidence", async () => {
  const current = await config();
  const anchor = deploymentAnchor(current);
  assert.equal(
    validateHostedDeploymentAnchor(anchor, {
      candidateSha,
      hostedAuthority: current.hostedAuthority,
    }),
    anchor,
  );
  for (const [field, value, code] of [
    ["live_url", "https://attacker.example.invalid", "hosted_deployment_url_mismatch"],
    ["site_project_id", "appgprj_attacker", "hosted_deployment_project_mismatch"],
    ["deployment_id", "deployment-forged", "hosted_deployment_fingerprint_mismatch"],
  ]) {
    const forgedAnchor = structuredClone(anchor);
    forgedAnchor[field] = value;
    assert.throws(
      () => validateHostedDeploymentAnchor(reseal(forgedAnchor), {
        candidateSha,
        hostedAuthority: current.hostedAuthority,
      }),
      new RegExp(code, "u"),
    );
  }

  const cases = [
    {
      code: "invalid_hosted_client_version",
      mutate(receipt) {
        receipt.client_snapshot.client_version = "synthetic-contract-fixture-1";
      },
    },
    {
      code: "hosted_plugin_snapshot_mismatch",
      mutate(receipt) {
        receipt.client_snapshot.plugin_package.plugin_snapshot_sha256 = digest("9");
      },
    },
    {
      code: "hosted_plugin_snapshot_mismatch",
      mutate(receipt) {
        receipt.client_snapshot.plugin_package.plugin_version =
          "0.1.0+codex.20260826190539";
      },
    },
    {
      code: "hosted_tool_inventory_digest_mismatch",
      mutate(receipt) {
        receipt.client_snapshot.tool_inventory[0].input_schema_sha256 = digest("8");
      },
    },
    {
      code: "hosted_tool_inventory_digest_mismatch",
      mutate(receipt) {
        receipt.client_snapshot.tool_inventory_sha256 = digest("7");
      },
    },
    {
      code: "hosted_tool_inventory_contract_mismatch",
      mutate(receipt) {
        receipt.client_snapshot.tool_inventory.pop();
        receipt.client_snapshot.tool_inventory_sha256 =
          `sha256:${sha256(canonicalJson(receipt.client_snapshot.tool_inventory))}`;
      },
    },
    {
      code: "hosted_deployment_anchor_mismatch",
      mutate(receipt) {
        receipt.deployment.deployment_id = "deployment-forged";
      },
    },
  ];
  for (const fixture of cases) {
    const forged = structuredClone(hostedReceipt(current, "codex-modern-2026-07-28"));
    fixture.mutate(forged);
    assert.throws(
      () => validateHostedReceipt(reseal(forged), hostedValidation(current, anchor)),
      new RegExp(fixture.code, "u"),
    );
  }
});

test("stale candidates, changed artifact tuples and forged deployment receipts fail closed", async () => {
  const current = await config();
  const anchor = deploymentAnchor(current);
  const stale = hostedReceipt(current, "codex-modern-2026-07-28", {
    candidateSha: "b".repeat(40),
  });
  const changed = structuredClone(hostedReceipt(current, "codex-modern-2026-07-28"));
  changed.rows[0].artifact_observations.history = {
    ...changed.rows[0].artifact_observations.history,
    sha256: digest("9"),
  };
  assert.throws(
    () => validateHostedReceipt(changed, hostedValidation(current, anchor)),
    /hosted_artifact_readback_mismatch|invalid_hosted_receipt_digest/u,
  );
  const otherDeployment = hostedReceipt(current, "codex-compat-2025-11-25", {
    deployment: { ...deploymentForAnchor(anchor), deployment_id: "deployment-other" },
  });
  const report = joinFileIngressEvidence({
    ...current,
    candidateSha,
    localReceipt: passingLocalReceipt(current),
    hostedReceipts: [stale, otherDeployment],
    hostedDeploymentAnchor: anchor,
  });
  assert.equal(report.status, "failed");
  assert.equal(
    report.rows.filter(({ evidence_scope, status }) => evidence_scope === "hosted_uat" && status === "failed").length,
    12,
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
    hostedDeploymentAnchor: anchor,
  });
  assert.equal(crossDeployment.status, "failed");
  assert.equal(
    crossDeployment.rows.filter(({ status_code }) => status_code === "hosted_deployment_anchor_mismatch").length,
    6,
  );
});

test("a concrete failed row exits nonzero and readiness fails on missing hosted receipts by default", async () => {
  const current = await config();
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout.trim();
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-md314-evidence-"));
  try {
    const localPath = join(directory, "local.json");
    const hostedPath = join(directory, "hosted-modern.json");
    const anchorPath = join(directory, "deployment-anchor.json");
    const failedOutput = join(directory, "failed-report.json");
    const pendingOutput = join(directory, "pending-report.json");
    const headAnchor = deploymentAnchor(current, head);
    await writeFile(localPath, JSON.stringify(passingLocalReceipt(current, head)));
    await writeFile(anchorPath, JSON.stringify(headAnchor));
    await writeFile(
      hostedPath,
      JSON.stringify(hostedReceipt(current, "codex-modern-2026-07-28", {
        candidateSha: head,
        anchor: headAnchor,
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
        "--hosted-deployment-anchor",
        anchorPath,
        "--output",
        failedOutput,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(failed.status, 1, failed.stderr || failed.stdout);
    assert.equal(JSON.parse(await readFile(failedOutput, "utf8")).status, "failed");

    const pending = spawnSync(
      "npm",
      [
        "run",
        "readiness:file-ingress",
        "--",
        "--local-receipt",
        localPath,
        "--output",
        pendingOutput,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(pending.status, 2, pending.stderr || pending.stdout);
    assert.equal(JSON.parse(await readFile(pendingOutput, "utf8")).status, "pending");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
