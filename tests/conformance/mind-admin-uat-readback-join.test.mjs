import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MIND_ADMIN_UAT_JOURNEYS,
  createStructuralJoin,
  parseCli,
} from "../../scripts/join-mind-admin-uat-readback.mjs";
import {
  MIND_ADMIN_BROWSER_ASSERTION_IDS,
  createEvidence,
} from "../../scripts/run-mind-admin-browser-gate.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";

const expected = Object.freeze({
  candidateSha: "a".repeat(40),
  sourceTreeSha: "b".repeat(40),
  siteSourceCommitSha: "c".repeat(40),
  siteSourceTreeSha: "d".repeat(40),
  siteSourceMode: "subtree-mirror",
  siteProjectId: "appgprj_fixture351",
});
const archiveBytes = Buffer.from("exact packaged Sites archive for MD-351", "utf8");

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function localReceipt() {
  return createEvidence({
    candidate: expected.candidateSha,
    tree: expected.sourceTreeSha,
    toolchain: {
      playwright_package_version: "1.62.1",
      playwright_cli_version: "1.62.1",
      chromium_package_version: "1.62.1",
      playwright_core_version: "1.62.1",
      chromium_revision: "1234",
      chromium_browser_version: "151.0.7922.34",
      chromium_executable_sha256: `sha256:${"c".repeat(64)}`,
    },
    sourceHashes: { "runner.mjs": `sha256:${"d".repeat(64)}` },
    assertions: MIND_ADMIN_BROWSER_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-27T23:00:00.000Z",
    completedAt: "2026-08-27T23:01:00.000Z",
  });
}

function providerReadback() {
  const storage = {
    archive_format: "tar.gz",
    content_hash: sha256(archiveBytes),
    size_bytes: archiveBytes.byteLength,
  };
  return {
    schema: "mind-diary/mind-admin-sites-provider-readback/v1",
    generator: "codex-sites-connector-readback/v1",
    observed_at_utc: "2026-08-27T23:04:00.000Z",
    site: {
      id: expected.siteProjectId,
      status: "active",
      current_live_url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T23:02:00.000Z",
    },
    saved_version: {
      id: "appgver_fixture351",
      project_id: expected.siteProjectId,
      version_number: 351,
      source: { commit_sha: expected.siteSourceCommitSha },
      archive_storage: { ...storage },
    },
    version: {
      id: "appgver_fixture351",
      project_id: expected.siteProjectId,
      version_number: 351,
      source: { commit_sha: expected.siteSourceCommitSha },
      archive_storage: { ...storage },
    },
    deployment_start: {
      id: "appgdep_fixture351",
      project_id: expected.siteProjectId,
      version_id: "appgver_fixture351",
      status: "publishing",
      type: "publish",
      updated_at: "2026-08-27T23:02:30.000Z",
    },
    deployment: {
      id: "appgdep_fixture351",
      project_id: expected.siteProjectId,
      version_id: "appgver_fixture351",
      status: "succeeded",
      type: "publish",
      url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T23:03:00.000Z",
    },
  };
}

function browserReadback(receiptBytes) {
  return {
    schema: "mind-diary/mind-admin-in-app-browser-readback/v1",
    generator: "codex-in-app-browser-direct-observation/v1",
    browser_surface: "codex-in-app-browser",
    live_url: "https://mind-diary.example.invalid",
    candidate_sha: expected.candidateSha,
    source_tree_sha: expected.sourceTreeSha,
    local_receipt_sha256: sha256(receiptBytes),
    observed_at_utc: "2026-08-27T23:05:00.000Z",
    journeys: MIND_ADMIN_UAT_JOURNEYS.map(({ id, checks }) => {
      const common = {
        metadata_version_before: 1,
        metadata_version_after: 2,
        negative_status: id.includes("nondisclosure") || id === "admin.cleanup-absence-readback" ? 404 : 0,
      };
      return {
        id,
        status: "passed",
        checks: [...checks],
        facts: id === "admin.cleanup-credential-baseline" ? {
          ...common,
          negative_status: 401,
          baseline_credential_count_before: 2,
          baseline_credential_count_after: 2,
          baseline_inventory_sha256_before: `sha256:${"8".repeat(64)}`,
          baseline_inventory_sha256_after: `sha256:${"8".repeat(64)}`,
          run_credential_count_after: 0,
          run_credential_used_status: 200,
          run_credential_denied_status_after_revoke: 401,
          run_credential_label_sha256: `sha256:${"9".repeat(64)}`,
          short_lived_expiry_seconds: 900,
        } : common,
      };
    }),
  };
}

function inputs() {
  const local = structuredClone(localReceipt());
  const localReceiptBytes = Buffer.from(JSON.stringify(local), "utf8");
  const provider = providerReadback();
  const browser = browserReadback(localReceiptBytes);
  return {
    localReceipt: local,
    providerReadback: provider,
    browserReadback: browser,
    localReceiptBytes,
    providerReadbackBytes: Buffer.from(JSON.stringify(provider), "utf8"),
    browserReadbackBytes: Buffer.from(JSON.stringify(browser), "utf8"),
    archiveBytes,
  };
}

test("MD-351 structural join CLI has no hosted approval or PASS switch", () => {
  assert.deepEqual(parseCli([
    "--local-receipt", "/tmp/local.json",
    "--provider-readback", "/tmp/provider.json",
    "--browser-readback", "/tmp/browser.json",
    "--artifact-archive", "/tmp/site.tar.gz",
    "--candidate-sha", expected.candidateSha,
    "--join-out", "/tmp/join.json",
  ]), {
    local_receipt: "/tmp/local.json",
    provider_readback: "/tmp/provider.json",
    browser_readback: "/tmp/browser.json",
    artifact_archive: "/tmp/site.tar.gz",
    candidate_sha: expected.candidateSha,
    join_out: "/tmp/join.json",
  });
  assert.throws(
    () => parseCli(["--join-out", "/tmp/join.json", "--hosted-pass", "true"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
});

test("fully consistent local files still produce only nonterminal structural evidence", () => {
  const join = createStructuralJoin(inputs(), expected);
  assert.equal(join.schema, "mind-diary/mind-admin-uat-readback-join/v1");
  assert.equal(join.status, "structurally_verified_readback");
  assert.equal(join.hosted_evidence, false);
  assert.equal(join.acceptance, "nonterminal");
  assert.equal(join.provenance, "unverified-local-files");
  assert.equal(join.claimed_lineage.site_source_commit_sha, expected.siteSourceCommitSha);
  assert.notEqual(join.status, "passed");
  assert.equal(join.journeys.length, 13);
  const credentialCleanup = join.journeys.find(({ id }) => id === "admin.cleanup-credential-baseline");
  assert.equal(credentialCleanup.facts.run_credential_count_after, 0);
  assert.equal(
    credentialCleanup.facts.baseline_inventory_sha256_after,
    credentialCleanup.facts.baseline_inventory_sha256_before,
  );
  assert.equal(credentialCleanup.facts.run_credential_denied_status_after_revoke, 401);
  assert.deepEqual(join.unresolved_provenance, [
    "sites-connector-call-origin-not-authenticated-offline",
    "in-app-browser-observation-origin-not-authenticated-offline",
  ]);
  assert.equal(JSON.stringify(join).includes("@example"), false);
});

test("MD-351 structural join rejects receipt, candidate and journey substitution", () => {
  const changedReceipt = inputs();
  changedReceipt.localReceipt.candidate_tree_sha = "f".repeat(40);
  assert.throws(
    () => createStructuralJoin(changedReceipt, expected),
    (error) => error instanceof ProbeFailure && error.code === "invalid_local_receipt",
  );

  const changedCandidate = inputs();
  changedCandidate.providerReadback.version.source.commit_sha = "e".repeat(40);
  assert.throws(
    () => createStructuralJoin(changedCandidate, expected),
    (error) => error instanceof ProbeFailure && error.code === "provider_readback_lineage_mismatch",
  );

  const changedJourney = inputs();
  changedJourney.browserReadback.journeys[0].checks = ["self-asserted-pass"];
  assert.throws(
    () => createStructuralJoin(changedJourney, expected),
    (error) => error instanceof ProbeFailure && error.code === "uat_journey_mismatch",
  );

  const changedCredentialBaseline = inputs();
  const credentialCleanup = changedCredentialBaseline.browserReadback.journeys.find(
    ({ id }) => id === "admin.cleanup-credential-baseline",
  );
  credentialCleanup.facts.baseline_credential_count_after += 1;
  assert.throws(
    () => createStructuralJoin(changedCredentialBaseline, expected),
    (error) => error instanceof ProbeFailure && error.code === "uat_credential_cleanup_facts_missing",
  );
});
