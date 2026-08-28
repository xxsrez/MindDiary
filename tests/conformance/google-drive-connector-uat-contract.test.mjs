import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GOOGLE_DRIVE_UAT_BLOCKER_CATEGORIES,
  GOOGLE_DRIVE_UAT_NEGATIVE_CASES,
  validateGoogleDriveUatContract,
  validateGoogleDriveUatFixturePlan,
} from "../../scripts/lib/google-drive-connector-uat-evidence.mjs";

const contractUrl = new URL(
  "../fixtures/google-drive-connector-uat/contract.v1.json",
  import.meta.url,
);
const fixturePlanUrl = new URL(
  "../fixtures/google-drive-connector-uat/synthetic-fixture-plan.v1.json",
  import.meta.url,
);

const expectedAssertions = [
  "GD-UAT-001-exact-candidate-deployment",
  "GD-UAT-002-one-exact-authorized-object",
  "GD-UAT-003-binary-byte-for-byte",
  "GD-UAT-004-native-explicit-export-snapshot",
  "GD-UAT-005-adapter-secret-and-locator-boundary",
  "GD-UAT-006-revoked-grant-fails-closed",
  "GD-UAT-007-ownership-change-fails-closed",
  "GD-UAT-008-revision-or-export-race-fails-closed",
  "GD-UAT-009-oversize-timeout-unknown-fail-closed",
  "GD-UAT-010-no-existence-leak",
  "GD-UAT-011-current-writable-target-authorization",
  "GD-UAT-012-stage-commit-download-history-web-export",
  "GD-UAT-013-persistence-after-redeploy",
  "GD-UAT-014-content-mcp-has-no-administrative-export",
  "GD-UAT-015-bounded-cleanup-readback",
  "GD-UAT-016-shared-drive-native-export",
];

test("Google Drive UAT contract remains exact, privacy-safe and non-executed", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));

  assert.equal(contract.schema, "mind-diary/google-drive-connector-uat-contract/v1");
  assert.equal(contract.contract_status, "defined_not_executed");
  assert.equal(contract.implementation_task, "MD-284");
  assert.equal(contract.verification_task, "MD-319");
  assert.equal(contract.runner_id, "ship-work-release/uat-google-drive-connector-object/v1");
  assert.equal(contract.provider, "google_drive");
  assert.deepEqual(validateGoogleDriveUatContract(contract), contract);
  assert.deepEqual(contract.assertions, expectedAssertions);
  assert.equal(new Set(contract.assertions).size, contract.assertions.length);

  assert.deepEqual(
    contract.fixtures.map((fixture) => fixture.id),
    [
      "drive-binary",
      "drive-document-docx",
      "drive-spreadsheet-xlsx",
      "drive-presentation-pptx",
    ],
  );
  assert.deepEqual(
    contract.fixtures.slice(1).map((fixture) => fixture.export_format),
    ["google-drive/docx", "google-drive/xlsx", "google-drive/pptx"],
  );

  assert.deepEqual(contract.receipt.required_fields, [
    "schema",
    "status",
    "candidate_sha",
    "deployment_id",
    "runner_id",
    "started_at",
    "completed_at",
    "assertion_results",
    "cleanup_status",
    "hosted_evidence",
    "provenance",
    "raw_observation_refs",
  ]);
  assert.ok(contract.receipt.forbidden_fields.includes("access_token"));
  assert.ok(contract.receipt.forbidden_fields.includes("provider_object_id"));
  assert.ok(contract.receipt.forbidden_fields.includes("provider_export_url"));
  assert.ok(contract.receipt.forbidden_fields.includes("file_content"));
  assert.deepEqual(contract.blocker_taxonomy, GOOGLE_DRIVE_UAT_BLOCKER_CATEGORIES);
  assert.deepEqual(
    contract.negative_matrix,
    GOOGLE_DRIVE_UAT_NEGATIVE_CASES.map(({ id }) => id),
  );
  assert.equal(
    contract.evidence_schemas.structural_join,
    "mind-diary/google-drive-connector-uat-readback-join/v1",
  );
  assert.match(contract.local_preflight_rule, /hosted_evidence=false/u);
  assert.match(contract.structural_join_rule, /acceptance=nonterminal/u);
  assert.match(contract.success_rule, /never provider acceptance evidence/u);
});

test("synthetic fixture plan fixes binary bytes and native representations without pretending export bytes", async () => {
  const plan = JSON.parse(await readFile(fixturePlanUrl, "utf8"));
  assert.deepEqual(validateGoogleDriveUatFixturePlan(plan), plan);
  assert.equal(plan.corpus_class, "synthetic-no-user-data");
  assert.equal(plan.fixtures[0].expected_source_size, 4096);
  assert.equal(
    plan.fixtures[0].expected_source_sha256,
    "sha256:12f51875c1545afac5b3bd4b3fd5131a9ed9f50ff248b84b01986d0934716f68",
  );
  assert.deepEqual(
    plan.fixtures.slice(1).map(({ representation }) => representation.format),
    ["google-drive/docx", "google-drive/xlsx", "google-drive/pptx"],
  );
  assert.equal(
    plan.fixtures.slice(1).some((fixture) =>
      Object.hasOwn(fixture, "expected_source_sha256") ||
      Object.hasOwn(fixture, "expected_export_sha256")
    ),
    false,
  );
});
