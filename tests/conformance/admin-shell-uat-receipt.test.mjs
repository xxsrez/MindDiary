import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SHELL_UAT_JOURNEYS,
  parseCli,
  validateReceipt,
} from "../../scripts/verify-admin-shell-uat-receipt.mjs";
import {
  canonical,
  digest,
  ProbeFailure,
} from "../../scripts/lib/multi-principal-probe-core.mjs";

const expected = Object.freeze({
  candidateSha: "a".repeat(40),
  sourceTreeSha: "b".repeat(40),
  siteProjectId: "appgprj_fixture123",
  siteVersionId: "version-fixture-123",
  deploymentId: "deployment-fixture-123",
});

function validReceipt() {
  const unsigned = {
    schema: "mind-diary/admin-shell-uat-evidence/v1",
    status: "passed",
    candidate_sha: expected.candidateSha,
    live_url: "https://mind-diary.example.invalid",
    evidence_basis: "in-app-browser-dom-accessibility-geometry",
    browser_surface: "codex-in-app-browser",
    observed_at_utc: "2026-08-27T22:30:00.000Z",
    lineage: {
      candidate_sha: expected.candidateSha,
      source_tree_sha: expected.sourceTreeSha,
      site_project_id: expected.siteProjectId,
      site_version_id: expected.siteVersionId,
      deployment_id: expected.deploymentId,
      artifact_archive_sha256: `sha256:${"1".repeat(64)}`,
      server_bundle_sha256: `sha256:${"2".repeat(64)}`,
      shell_css_sha256: `sha256:${"3".repeat(64)}`,
      shell_client_sha256: `sha256:${"4".repeat(64)}`,
    },
    journeys: ADMIN_SHELL_UAT_JOURNEYS.map((journey) => ({
      id: journey.id,
      status: "passed",
      route: journey.route,
      viewport: { ...journey.viewport },
      current_items: [...journey.currentItems],
      checks: [...journey.checks],
      metrics: {
        document_overflow_px: 0,
        body_overflow_px: 0,
        minimum_hit_target_px: 44,
        h1_count: 1,
        page_header_bottom_px: 240,
        first_key_content_top_px: 300,
      },
    })),
  };
  return { ...unsigned, artifact_sha256: digest(canonical(unsigned)) };
}

test("hosted admin shell CLI requires exact lineage selectors", () => {
  assert.deepEqual(parseCli([
    "--receipt", "/tmp/private-receipt.json",
    "--candidate-sha", expected.candidateSha,
    "--site-version-id", expected.siteVersionId,
    "--deployment-id", expected.deploymentId,
  ]), {
    receipt: "/tmp/private-receipt.json",
    candidate_sha: expected.candidateSha,
    site_version_id: expected.siteVersionId,
    deployment_id: expected.deploymentId,
  });
  assert.throws(
    () => parseCli(["--receipt", "/tmp/receipt.json", "--approve", "true"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
});

test("hosted admin shell receipt joins assets, journeys and numeric budgets", () => {
  assert.equal(validateReceipt(validReceipt(), expected).status, "passed");
  const overflow = validReceipt();
  overflow.journeys[0].metrics.document_overflow_px = 2;
  assert.throws(
    () => validateReceipt(overflow, expected),
    (error) => error instanceof ProbeFailure && error.code === "uat_overflow_budget_failed",
  );
  const screenshot = validReceipt();
  screenshot.diagnostic_screenshot = "/tmp/fixture.png";
  const { artifact_sha256: _oldDigest, ...unsigned } = screenshot;
  screenshot.artifact_sha256 = digest(canonical(unsigned));
  assert.throws(
    () => validateReceipt(screenshot, expected),
    (error) => error instanceof ProbeFailure && error.code === "unsafe_uat_receipt",
  );
});
