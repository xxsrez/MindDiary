import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_03_ACCESS_ADMIN_HOSTED_ASSERTION_IDS,
  RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS,
  RELEASE_03_ACCESS_ADMIN_LOCAL_ASSERTION_IDS,
  RELEASE_03_ACCESS_ADMIN_LOCAL_SOURCE_PATHS,
  RELEASE_03_ACCESS_ADMIN_LOCAL_TEST_PATHS,
  RELEASE_03_ACCESS_ADMIN_STATE_ROWS,
  RELEASE_03_EXPECTED_SYNTHETIC_BROWSER_ASSERTION_IDS,
  Release03AccessAdminEvidenceError,
  createRelease03AccessAdminHostedObservation,
  createRelease03AccessAdminLocalEvidence,
  createRelease03AccessAdminUatJoin,
} from "../../scripts/lib/release-0.3-access-admin-evidence.mjs";
import { EXPECTED_MCP_TOOL_NAMES } from "../../scripts/lib/exact-mcp-tool-inventory.mjs";
import { SYNTHETIC_ASSERTION_IDS, canonical, digest } from "../../scripts/lib/multi-principal-probe-core.mjs";
import {
  REQUIRED_UAT_TEST_ACTOR_ALIASES,
  createPendingUatTestAccountPoolInventory,
  createUatTestAccountPoolReadinessReceipt,
} from "../../scripts/lib/uat-test-account-pool-contract.mjs";
import { parseCli as parseLocalCli } from "../../scripts/run-release-0.3-access-admin-local-gate.mjs";
import {
  parseCli as parseJoinCli,
  readPrivateReceipt,
} from "../../scripts/join-release-0.3-access-admin-uat.mjs";

const candidate = "a".repeat(40);
const deployment = "appgdep_md354fixture";
const observedAt = "2026-08-28T01:00:00.000Z";
const actorFingerprints = Object.freeze([
  "actor-1111111111111111",
  "actor-2222222222222222",
  "actor-3333333333333333",
]);

function artifact(unsigned) {
  return { ...unsigned, artifact_sha256: digest(canonical(unsigned)) };
}

function syntheticCarrier() {
  return artifact({
    schema: "mind-diary/synthetic-multi-principal-evidence/v1",
    status: "passed",
    candidate_sha: candidate,
    actor_class: "synthetic-principal",
    binding_namespace: "synthetic-test",
    run_fingerprint: "run-11111111111111111111111111111111",
    actor_fingerprints: [
      "actor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "actor-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    started_at: observedAt,
    completed_at: observedAt,
    assertions: SYNTHETIC_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
  });
}

function browserCarrier() {
  return artifact({
    schema: "mind-diary/synthetic-browser-evidence/v1",
    status: "passed",
    candidate_sha: candidate,
    actor_class: "synthetic-browser-principal",
    binding_namespace: "synthetic-browser-test",
    run_fingerprint: "sha256:1111111111111111111111111111111",
    actor_fingerprints: [
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    started_at: observedAt,
    completed_at: observedAt,
    assertions: RELEASE_03_EXPECTED_SYNTHETIC_BROWSER_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
  });
}

function hashes(paths) {
  return Object.fromEntries(paths.map((path, index) => [
    path,
    `sha256:${String((index % 9) + 1).repeat(64)}`,
  ]));
}

function localEvidence() {
  return createRelease03AccessAdminLocalEvidence({
    candidateSha: candidate,
    syntheticEvidence: syntheticCarrier(),
    browserEvidence: browserCarrier(),
    tests: RELEASE_03_ACCESS_ADMIN_LOCAL_TEST_PATHS.map((path, index) => ({
      path,
      status: "passed",
      stdout_sha256: `sha256:${String((index % 9) + 1).repeat(64)}`,
    })),
    sourceHashes: hashes(RELEASE_03_ACCESS_ADMIN_LOCAL_SOURCE_PATHS),
    startedAt: observedAt,
    completedAt: observedAt,
  });
}

function readyPoolReceipt() {
  const inventory = structuredClone(createPendingUatTestAccountPoolInventory());
  for (const key of Object.keys(inventory.owner_authority)) {
    inventory.owner_authority[key] = "owner-confirmed";
  }
  inventory.actors.forEach((actor, index) => {
    actor.actor_fingerprint = actorFingerprints[index];
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
    deploymentId: deployment,
  });
}

function allTrue(keys) {
  return Object.fromEntries(keys.map((key) => [key, true]));
}

function hostedObservation(pool = readyPoolReceipt()) {
  return createRelease03AccessAdminHostedObservation({
    candidateSha: candidate,
    deploymentId: deployment,
    projectId: "appgprj_md354fixture",
    versionId: "appgver_md354fixture",
    poolReceiptSha256: pool.artifact_sha256,
    actorFingerprints,
    mcpToolNames: EXPECTED_MCP_TOOL_NAMES,
    stateRows: RELEASE_03_ACCESS_ADMIN_STATE_ROWS,
    invitationRows: RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS,
    readBack: allTrue([
      "browser_rest_mcp_content_each_state",
      "current_role_on_every_request",
      "public_unlisted_reader_equivalent_only",
      "revoked_private_non_enumerating",
      "sole_owner_after_transfer",
      "no_control_mcp_tools",
      "restart_or_redeploy_current_state",
    ]),
    cleanup: allTrue([
      "per_run_tokens_revoked",
      "next_mcp_request_denied",
      "run_mind_deleted",
      "exact_mind_absent",
      "temporary_roles_absent",
      "audience_unchanged",
      "operator_allowlist_unchanged",
      "pool_baseline_read_back",
      "unknown_outcomes_none",
    ]),
    observedAt,
  });
}

test("MD-354 local receipt binds three-principal carriers and cannot claim hosted UAT", () => {
  const receipt = localEvidence();
  assert.equal(receipt.carrier.ephemeral_principal_count, 3);
  assert.equal(receipt.hosted_status, "not-run");
  assert.deepEqual(
    receipt.assertions.map(({ id }) => id),
    RELEASE_03_ACCESS_ADMIN_LOCAL_ASSERTION_IDS,
  );
  assert.equal(receipt.tests.length, RELEASE_03_ACCESS_ADMIN_LOCAL_TEST_PATHS.length);
});

test("hosted observation closes role, invitation, visibility, surface and cleanup rows", () => {
  const receipt = hostedObservation();
  assert.deepEqual(receipt.state_rows, RELEASE_03_ACCESS_ADMIN_STATE_ROWS);
  assert.deepEqual(receipt.invitation_rows, RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS);
  assert.deepEqual(receipt.mcp_tool_names, EXPECTED_MCP_TOOL_NAMES);
  assert.deepEqual(
    receipt.assertions.map(({ id }) => id),
    RELEASE_03_ACCESS_ADMIN_HOSTED_ASSERTION_IDS,
  );
  assert.equal(receipt.cleanup.pool_baseline_read_back, true);
});

test("offline join is exact and remains nonterminal without live tool provenance", () => {
  const pool = readyPoolReceipt();
  const joined = createRelease03AccessAdminUatJoin({
    localEvidence: localEvidence(),
    poolEvidence: pool,
    hostedObservation: hostedObservation(pool),
  });
  assert.equal(joined.status, "structurally_verified_readback");
  assert.equal(joined.acceptance, "nonterminal");
  assert.equal(joined.hosted_evidence, false);
  assert.equal(joined.live_tool_provenance_required, true);
  assert.deepEqual(joined.actor_fingerprints, actorFingerprints);
});

test("join rejects candidate, deployment, pool actor and receipt lineage drift", () => {
  const pool = readyPoolReceipt();
  const base = {
    localEvidence: localEvidence(),
    poolEvidence: pool,
    hostedObservation: hostedObservation(pool),
  };
  const mismatches = [
    { ...base, localEvidence: artifact({ ...base.localEvidence, artifact_sha256: undefined, candidate_sha: "b".repeat(40) }) },
    { ...base, poolEvidence: { ...pool, deployment_id: "appgdep_different" } },
    { ...base, hostedObservation: { ...base.hostedObservation, actor_fingerprints: [...actorFingerprints].reverse() } },
  ];
  for (const value of mismatches) {
    assert.throws(
      () => createRelease03AccessAdminUatJoin(value),
      Release03AccessAdminEvidenceError,
    );
  }
});

test("hosted observation rejects control MCP drift and incomplete state or cleanup", () => {
  const pool = readyPoolReceipt();
  const args = {
    candidateSha: candidate,
    deploymentId: deployment,
    projectId: "appgprj_md354fixture",
    versionId: "appgver_md354fixture",
    poolReceiptSha256: pool.artifact_sha256,
    actorFingerprints,
    mcpToolNames: EXPECTED_MCP_TOOL_NAMES,
    stateRows: RELEASE_03_ACCESS_ADMIN_STATE_ROWS,
    invitationRows: RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS,
    readBack: allTrue([
      "browser_rest_mcp_content_each_state", "current_role_on_every_request",
      "public_unlisted_reader_equivalent_only", "revoked_private_non_enumerating",
      "sole_owner_after_transfer", "no_control_mcp_tools", "restart_or_redeploy_current_state",
    ]),
    cleanup: allTrue([
      "per_run_tokens_revoked", "next_mcp_request_denied", "run_mind_deleted",
      "exact_mind_absent", "temporary_roles_absent", "audience_unchanged",
      "operator_allowlist_unchanged", "pool_baseline_read_back", "unknown_outcomes_none",
    ]),
    observedAt,
  };
  assert.throws(
    () => createRelease03AccessAdminHostedObservation({
      ...args,
      mcpToolNames: [...EXPECTED_MCP_TOOL_NAMES, "change_visibility"],
    }),
    Release03AccessAdminEvidenceError,
  );
  assert.throws(
    () => createRelease03AccessAdminHostedObservation({
      ...args,
      stateRows: RELEASE_03_ACCESS_ADMIN_STATE_ROWS.slice(1),
    }),
    Release03AccessAdminEvidenceError,
  );
  assert.throws(
    () => createRelease03AccessAdminHostedObservation({
      ...args,
      cleanup: { ...args.cleanup, pool_baseline_read_back: false },
    }),
    Release03AccessAdminEvidenceError,
  );
});

test("MD-354 CLIs accept only private receipt paths and no identities, URLs or credentials", () => {
  assert.deepEqual(parseLocalCli([
    "--candidate-sha", candidate,
    "--evidence-out", "/private/evidence/local.json",
  ]), {
    candidate_sha: candidate,
    evidence_out: "/private/evidence/local.json",
  });
  assert.equal(parseJoinCli([
    "--local-evidence", "/private/evidence/local.json",
    "--pool-evidence", "/private/evidence/pool.json",
    "--hosted-observation", "/private/evidence/hosted.json",
    "--output", "/private/evidence/join.json",
  ]).output, "/private/evidence/join.json");
  for (const forbidden of ["email", "session", "url", "credential", "token", "mind-id"]) {
    assert.throws(
      () => parseLocalCli([`--${forbidden}`, "unsafe"]),
      Release03AccessAdminEvidenceError,
    );
  }
});

test("join inputs require a private 0700 temp parent and exact 0600 file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-md354-input-"));
  const path = join(directory, "receipt.json");
  try {
    await writeFile(path, '{"synthetic":true}\n', { mode: 0o600 });
    assert.deepEqual(await readPrivateReceipt(path), { synthetic: true });
    await chmod(path, 0o644);
    await assert.rejects(
      readPrivateReceipt(path),
      (error) => error instanceof Release03AccessAdminEvidenceError &&
        error.code === "unsafe_private_receipt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checked-in MD-354 contract is closed and explicitly excludes production", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../fixtures/release-0.3-access-admin/contract.v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(contract.owner, "MD-354");
  assert.equal(contract.actorAliases.length, 3);
  assert.deepEqual(contract.requiredSurfaces, [
    "browser", "rest", "mcp", "content_read", "content_write", "membership_manage",
  ]);
  assert.equal(contract.joinRules.hostedFromLocal, "forbidden");
  assert.equal(contract.joinRules.production, "excluded");
});

test("pool, U-ACCESS, MD-354 contract and runbook share one exact actor and invitation order", async () => {
  const [contract, traceability, runbook] = await Promise.all([
    readFile(
      new URL("../fixtures/release-0.3-access-admin/contract.v1.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(
      new URL("../fixtures/release-0.3-traceability/contract.v1.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(
      new URL("../../docs/operations/release-0.3-access-admin-uat-runbook.md", import.meta.url),
      "utf8",
    ),
  ]);
  const uAccess = traceability.evidence.find(({ id }) => id === "U-ACCESS");
  assert.deepEqual(traceability.policies.hostedActors, REQUIRED_UAT_TEST_ACTOR_ALIASES);
  assert.deepEqual(contract.actorAliases, REQUIRED_UAT_TEST_ACTOR_ALIASES);
  assert.deepEqual(uAccess.actors, REQUIRED_UAT_TEST_ACTOR_ALIASES);
  assert.ok(uAccess.fixturePaths.includes(
    "tests/fixtures/release-0.3-access-admin/contract.v1.json",
  ));
  const invitationOrder = RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS.map(({ id }) => id);
  assert.deepEqual(contract.invitationSequence, invitationOrder);
  assert.ok(runbook.includes(
    "`UAT-OPERATOR → UAT-MIND-ROLE → UAT-ORDINARY`",
  ));
  assert.ok(runbook.includes(
    "`pending → cancelled → reissued → rejected → accepted`",
  ));
});

test("MD-354 branch preserves current durable token UI assertions", async () => {
  const runtimeTest = await readFile(
    new URL("../integration/product-site-mcp-runtime.test.mjs", import.meta.url),
    "utf8",
  );
  for (const stale of [
    "assert.match(emptyHtml, /Readable Minds always follow current membership and visibility/u);",
    "assert.match(emptyHtml, /Can add and change[\\s\\S]*Not selected/u);",
    "const marker = `data-personal-token-ref=\"${tokenRef}\"`;",
  ]) assert.equal(runtimeTest.includes(stale), false, stale);
  for (const current of [
    "const marker = `<h3>${tokenName}</h3>`;",
    "assert.doesNotMatch(readOnlyHtml, /data-personal-token-ref/u);",
    "assert.match(boundHtml, /Writable target[\\s\\S]*Web Binding E2E",
  ]) assert.equal(runtimeTest.includes(current), true, current);
});
