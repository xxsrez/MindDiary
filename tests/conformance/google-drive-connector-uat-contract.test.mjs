import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractUrl = new URL(
  "../fixtures/google-drive-connector-uat/contract.v1.json",
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
  "GD-UAT-011-current-mind-write-authorization",
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
  ]);
  assert.ok(contract.receipt.forbidden_fields.includes("access_token"));
  assert.ok(contract.receipt.forbidden_fields.includes("provider_object_id"));
  assert.ok(contract.receipt.forbidden_fields.includes("provider_export_url"));
  assert.ok(contract.receipt.forbidden_fields.includes("file_content"));
  assert.match(contract.success_rule, /never provider acceptance evidence/u);
});
