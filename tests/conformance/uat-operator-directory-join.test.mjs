import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  APPLICATION_BOUNDARY_CLASSIFICATIONS,
  PROVIDER_BOUNDARY_CLASSIFICATIONS,
  createProviderRequestLogBoundaryReceipt,
} from "../../scripts/lib/provider-request-log-boundary.mjs";
import {
  UAT_OPERATOR_DIRECTORY_JOIN_ASSERTION_IDS,
  UatOperatorDirectoryJoinError,
  createUatOperatorDirectoryJoinEvidence,
  verifyUatOperatorDirectoryJoinEvidence,
} from "../../scripts/lib/uat-operator-directory-join.mjs";
import {
  createPendingUatTestAccountPoolInventory,
  createUatTestAccountPoolReadinessReceipt,
} from "../../scripts/lib/uat-test-account-pool-contract.mjs";
import {
  createCleanupEvidence,
  createEvidence,
} from "../../scripts/run-uat-operator-directory-canary.mjs";
import {
  parseCli,
  run,
} from "../../scripts/run-uat-operator-directory-join.mjs";

const SHA = "a".repeat(40);
const DEPLOYMENT = "appgdep_joinfixture";
const NOW = "2026-08-24T10:00:00.000Z";
const RUN = `uatop-run-${"d".repeat(32)}`;
const HASH = `sha256:${"f".repeat(64)}`;
const REFERENCE = Object.freeze({
  locator: "provider-control:fixture/operator-directory",
  sha256: HASH,
});

function readyPool() {
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
    observedAtUtc: NOW,
    candidateSha: SHA,
    deploymentId: DEPLOYMENT,
  });
}

function providerReceipt({ candidateSha = SHA, deploymentId = DEPLOYMENT } = {}) {
  return createProviderRequestLogBoundaryReceipt({
    candidate_sha: candidateSha,
    deployment: {
      site_project_id: "appgprj_joinfixture",
      site_version_id: "appgver_joinfixture",
      deployment_id: deploymentId,
      archive_sha256: `sha256:${"b".repeat(64)}`,
    },
    observed_at_utc: NOW,
    application_evidence: APPLICATION_BOUNDARY_CLASSIFICATIONS.map((classification) => ({
      classification,
      status: "passed",
      evidence: REFERENCE,
    })),
    provider_evidence: PROVIDER_BOUNDARY_CLASSIFICATIONS.map((classification) => ({
      classification,
      status: "accepted_boundary",
      evidence: REFERENCE,
    })),
    authority: { status: "recorded", evidence: REFERENCE },
  });
}

function receipts() {
  return {
    canaryEvidence: createEvidence({
      candidateSha: SHA,
      deploymentId: DEPLOYMENT,
      runFingerprint: RUN,
      actors: {
        operator: `uatop-${"a".repeat(32)}`,
        mind_role: `uatop-${"b".repeat(32)}`,
        ordinary: `uatop-${"c".repeat(32)}`,
      },
      observedAtUtc: NOW,
    }),
    poolEvidence: readyPool(),
    providerEvidence: providerReceipt(),
    cleanupEvidence: createCleanupEvidence({
      phase: "cleanup",
      candidateSha: SHA,
      deploymentId: DEPLOYMENT,
      runFingerprint: RUN,
      observedAtUtc: NOW,
    }),
  };
}

test("OD4 join binds pool, canary, provider privacy and cleanup to one lineage", () => {
  const evidence = createUatOperatorDirectoryJoinEvidence({
    ...receipts(),
    observedAtUtc: NOW,
  });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.candidate_sha, SHA);
  assert.equal(evidence.deployment.deployment_id, DEPLOYMENT);
  assert.equal(evidence.production_excluded, true);
  assert.deepEqual(
    evidence.assertions.map(({ id }) => id),
    UAT_OPERATOR_DIRECTORY_JOIN_ASSERTION_IDS,
  );
  assert.deepEqual(verifyUatOperatorDirectoryJoinEvidence(evidence), evidence);
  assert.equal(JSON.stringify(evidence).includes("@"), false);
});

test("OD4 join fails closed on lineage, run, privacy and hash mismatch", () => {
  const source = receipts();
  const cases = [
    {
      ...source,
      providerEvidence: providerReceipt({ candidateSha: "b".repeat(40) }),
    },
    {
      ...source,
      cleanupEvidence: createCleanupEvidence({
        phase: "recovery",
        candidateSha: SHA,
        deploymentId: DEPLOYMENT,
        runFingerprint: `uatop-run-${"e".repeat(32)}`,
        observedAtUtc: NOW,
      }),
    },
    {
      ...source,
      cleanupEvidence: createCleanupEvidence({
        phase: "recovery",
        candidateSha: SHA,
        deploymentId: DEPLOYMENT,
        runFingerprint: RUN,
        observedAtUtc: NOW,
      }),
    },
    {
      ...source,
      providerEvidence: createProviderRequestLogBoundaryReceipt({
        candidate_sha: SHA,
        deployment: source.providerEvidence.deployment,
        observed_at_utc: NOW,
        application_evidence: source.providerEvidence.application_evidence,
        provider_evidence: PROVIDER_BOUNDARY_CLASSIFICATIONS.map((classification) => ({
          classification,
          status: "unknown",
          evidence: null,
        })),
        authority: { status: "required", evidence: null },
      }),
    },
    {
      ...source,
      poolEvidence: {
        ...source.poolEvidence,
        artifact_sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  ];
  for (const value of cases) {
    assert.throws(
      () => createUatOperatorDirectoryJoinEvidence({
        ...value,
        observedAtUtc: NOW,
      }),
      UatOperatorDirectoryJoinError,
    );
  }
});

test("OD4 CLI writes a mode-private validated receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-od4-"));
  try {
    const source = receipts();
    const paths = {};
    for (const [key, value] of Object.entries(source)) {
      paths[key] = join(directory, `${key}.json`);
      await writeFile(paths[key], JSON.stringify(value));
    }
    const evidenceOut = join(directory, "join.json");
    const options = parseCli([
      "--canary-evidence", paths.canaryEvidence,
      "--pool-evidence", paths.poolEvidence,
      "--provider-evidence", paths.providerEvidence,
      "--cleanup-evidence", paths.cleanupEvidence,
      "--evidence-out", evidenceOut,
    ]);
    const result = await run(options, { now: () => NOW });
    assert.equal(result.status, "passed");
    assert.equal(
      verifyUatOperatorDirectoryJoinEvidence(
        JSON.parse(await readFile(evidenceOut, "utf8")),
      ).candidate_sha,
      SHA,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
