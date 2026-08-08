import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildReadinessReport,
  evaluateReceiptDocument,
  parseTraceabilityDocument,
  resolveCandidateSha,
  stableJson,
  validateRegistry,
} from "../../scripts/generate-readiness-report.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const traceabilityPath = resolve(repositoryRoot, "docs/specs/traceability.md");
const packagePath = resolve(repositoryRoot, "package.json");
const candidateSha = "a".repeat(40);
const deployment = {
  site_project_id: "site-project-01",
  site_version_id: "site-version-01",
  deployment_id: "deployment-01",
  live_url: "https://mind-diary.example.test",
};

async function loadRegistry() {
  const markdown = await readFile(traceabilityPath, "utf8");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const parsed = parseTraceabilityDocument(markdown);
  return { ...parsed, packageCheck: packageJson.scripts.check };
}

async function currentPathExists(path) {
  try {
    await access(resolve(repositoryRoot, path));
    return true;
  } catch {
    return false;
  }
}

function receiptText(slot, overrides = {}) {
  return JSON.stringify({
    schema: "mind-diary/readiness-evidence/v1",
    slot,
    candidate_sha: candidateSha,
    status: "passed",
    deployment,
    ...overrides,
  });
}

function receiptStates(overrides = {}) {
  return Object.fromEntries(
    ["W", "P", "MI", "CX", "R"].map((slot) => [
      slot,
      evaluateReceiptDocument({
        slot,
        text: Object.hasOwn(overrides, slot) ? overrides[slot] : receiptText(slot),
        candidateSha,
        artifactPath: `docs/evidence/releases/${candidateSha}/${slot}.json`,
      }),
    ]),
  );
}

function reportInput(registry, overrides = {}) {
  return {
    registry,
    candidateSha,
    candidateCommittedAt: "2026-08-08T10:00:00+00:00",
    traceabilitySha256: "1".repeat(64),
    packageSha256: "2".repeat(64),
    localGateStatus: "passed",
    receipts: receiptStates(),
    ...overrides,
  };
}

test("registry binds all 29 criteria to one owner and concrete candidate paths", async () => {
  const { registry, tableRows, packageCheck } = await loadRegistry();
  await validateRegistry(registry, {
    tableRows,
    pathExists: currentPathExists,
    packageCheck,
  });

  assert.deepEqual(registry.criteria.map(({ id }) => id), Array.from({ length: 29 }, (_, index) => index + 1));
  assert.equal(registry.criteria.filter(({ local_evidence }) => local_evidence.length === 0).length, 1);
  assert.equal(registry.criteria.at(-1).id, 29);
  assert.deepEqual(Object.keys(registry.live_evidence).sort(), ["CX", "MI", "P", "R", "W"]);
});

test("same-SHA local and live receipts produce a fully passing report", async () => {
  const { registry } = await loadRegistry();
  const report = buildReadinessReport(reportInput(registry));

  assert.equal(report.candidate_sha, candidateSha);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.summary, { passed: 29, pending: 0, failed: 0 });
  assert.equal(report.criteria[27].evidence_id, "A28");
  assert.equal(report.criteria[27].local.status, "passed");
  assert.equal(report.criteria[28].local.status, "not_required");
  assert.equal(report.criteria[28].status, "passed");
  assert.equal(report.post_mvp_denylist.status, "passed");
});

test("missing local and live evidence remains explicit pending rather than pass", async () => {
  const { registry } = await loadRegistry();
  const missingReceipts = receiptStates({ W: null, P: null, MI: null, CX: null, R: null });
  const report = buildReadinessReport(reportInput(registry, {
    localGateStatus: "pending",
    receipts: missingReceipts,
  }));

  assert.equal(report.status, "pending");
  assert.deepEqual(report.summary, { passed: 0, pending: 29, failed: 0 });
  assert.deepEqual(report.release_summary, { passed: 0, pending: 29, failed: 0 });
  assert.equal(report.criteria[0].local.status, "pending");
  assert.equal(report.criteria[0].live.status, "pending");
  assert.equal(report.criteria[27].live.status, "not_required");
  assert.equal(report.criteria[27].status, "pending");
  assert.equal(report.criteria[27].release_readiness_status, "pending");
  assert.equal(report.criteria[28].local.status, "not_required");
  assert.equal(report.live_evidence.R.reason, "missing");
});

test("a passing canonical gate makes A28 pass while release evidence stays pending", async () => {
  const { registry } = await loadRegistry();
  const report = buildReadinessReport(reportInput(registry, {
    receipts: receiptStates({ W: null, P: null, MI: null, CX: null, R: null }),
  }));

  assert.equal(report.status, "pending");
  assert.deepEqual(report.summary, { passed: 1, pending: 28, failed: 0 });
  assert.equal(report.criteria[27].evidence_id, "A28");
  assert.equal(report.criteria[27].status, "passed");
  assert.equal(report.criteria[27].release_readiness_status, "pending");
});

test("stale SHA and cross-deployment receipts deterministically fail", async () => {
  const { registry } = await loadRegistry();
  const stale = receiptText("W", { candidate_sha: "b".repeat(40) });
  const otherDeployment = receiptText("MI", {
    deployment: { ...deployment, deployment_id: "deployment-02" },
  });
  const report = buildReadinessReport(reportInput(registry, {
    receipts: receiptStates({ W: stale, MI: otherDeployment }),
  }));

  assert.equal(report.status, "failed");
  assert.equal(report.live_evidence.W.reason, "candidate_sha_mismatch");
  assert.equal(report.live_evidence.MI.reason, "deployment_identity_mismatch");
  assert.ok(report.summary.failed > 0);
});

test("invalid, denied and owner-reported live receipts never become passing", () => {
  const invalid = evaluateReceiptDocument({
    slot: "CX",
    text: "{",
    candidateSha,
    artifactPath: "CX.json",
  });
  const denied = evaluateReceiptDocument({
    slot: "CX",
    text: receiptText("CX", { status: "failed" }),
    candidateSha,
    artifactPath: "CX.json",
  });
  const missingIdentity = evaluateReceiptDocument({
    slot: "CX",
    text: receiptText("CX", { deployment: null }),
    candidateSha,
    artifactPath: "CX.json",
  });

  assert.equal(invalid.status, "failed");
  assert.equal(invalid.reason, "invalid_json");
  assert.equal(denied.status, "failed");
  assert.equal(denied.reason, "owner_reported_failure");
  assert.equal(missingIdentity.reason, "deployment_identity_missing");
});

test("broken owner, evidence path and criterion coverage are rejected", async () => {
  const { registry, tableRows, packageCheck } = await loadRegistry();

  const wrongOwner = structuredClone(registry);
  wrongOwner.criteria[0].owner = "AND-999";
  await assert.rejects(
    validateRegistry(wrongOwner, { tableRows, pathExists: currentPathExists, packageCheck }),
    /owner differs/,
  );

  const missingCriterion = structuredClone(registry);
  missingCriterion.criteria.pop();
  await assert.rejects(
    validateRegistry(missingCriterion, { tableRows, pathExists: currentPathExists, packageCheck }),
    /1 through 29/,
  );

  const missingPath = structuredClone(registry);
  missingPath.local_evidence["account-bootstrap"].paths = ["tests/integration/not-present.test.mjs"];
  await assert.rejects(
    validateRegistry(missingPath, { tableRows, pathExists: currentPathExists, packageCheck }),
    /absent from the candidate/,
  );
});

test("report serialization is reproducible and invalid candidate names fail closed", async () => {
  const { registry } = await loadRegistry();
  const first = stableJson(buildReadinessReport(reportInput(registry)));
  const second = stableJson(buildReadinessReport(reportInput(registry)));
  assert.equal(first, second);
  assert.throws(
    () => resolveCandidateSha(repositoryRoot, "refs/heads/definitely-missing-readiness-candidate"),
    /cannot resolve candidate commit/,
  );
});
