import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createStructuralJoin,
  parseCli,
  validateStructuralJoin,
} from "../../scripts/join-import-export-uat-readback.mjs";
import {
  canonical,
  digest,
  ProbeFailure,
} from "../../scripts/lib/multi-principal-probe-core.mjs";
import {
  createEvidence,
  IMPORT_EXPORT_ASSERTION_IDS,
} from "../../scripts/run-import-export-browser-gate.mjs";

const candidate = "a".repeat(40);
const siteSourceCommitSha = "b".repeat(40);
const siteSourceTreeSha = "c".repeat(40);
const siteSourceMode = "subtree-mirror";
const siteProjectId = "appgprj_md363fixture";
const archiveBytes = Buffer.from("exact md363 site archive", "utf8");

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function localReceipt() {
  return createEvidence({
    candidate,
    toolchain: {
      playwright_package_version: "1.62.1",
      playwright_cli_version: "1.62.1",
      chromium_package_version: "1.62.1",
      playwright_core_version: "1.62.1",
      chromium_revision: "1234",
      chromium_browser_version: "151.0.7922.34",
      chromium_executable_sha256: `sha256:${"b".repeat(64)}`,
    },
    fixture: {
      generator: "mind-diary-md363-deterministic-v1",
      artifact_sha256: `sha256:${"c".repeat(64)}`,
      known_opaque_bytes_hex: "00017f80ff4d443336330a",
      files: [{ id: "known-opaque", relative_path: "baseline/assets/known.bin", size: 11, sha256: `sha256:${"d".repeat(64)}` }],
    },
    runtimeSuites: [{ path: "tests/integration/markdown-imports.test.mjs", sha256: `sha256:${"e".repeat(64)}`, status: "passed" }],
    assertions: IMPORT_EXPORT_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-27T23:00:00.000Z",
    completedAt: "2026-08-27T23:01:00.000Z",
  });
}

function providerReadback() {
  return {
    schema: "mind-diary/import-export-sites-provider-readback/v1",
    generator: "codex-sites-connector-readback/v1",
    observed_at_utc: "2026-08-27T23:04:00.000Z",
    site: {
      id: siteProjectId,
      status: "active",
      current_live_url: "https://mind-diary.example.invalid",
    },
    version: {
      id: "appgver_md363fixture",
      project_id: siteProjectId,
      source: { commit_sha: siteSourceCommitSha },
      archive_storage: {
        archive_format: "tar.gz",
        content_hash: sha256(archiveBytes),
        size_bytes: archiveBytes.byteLength,
      },
    },
    deployment_before: {
      id: "appgdep_md363before",
      project_id: siteProjectId,
      version_id: "appgver_md363fixture",
      type: "publish",
      status: "succeeded",
      url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T23:01:30.000Z",
    },
    redeploy_start: {
      id: "appgdep_md363after",
      project_id: siteProjectId,
      version_id: "appgver_md363fixture",
      type: "publish",
      status: "publishing",
      url: null,
      updated_at: "2026-08-27T23:02:00.000Z",
    },
    deployment_after: {
      id: "appgdep_md363after",
      project_id: siteProjectId,
      version_id: "appgver_md363fixture",
      type: "publish",
      status: "succeeded",
      url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T23:03:00.000Z",
    },
  };
}

function exportComparison(kind, profile, marker) {
  const digest = `sha256:${marker.repeat(64)}`;
  return {
    kind,
    profile,
    revision_fingerprint: `sha256:${(marker === "f" ? "1" : marker).repeat(64)}`,
    job_fingerprint: `sha256:${(marker === "f" ? "2" : marker).repeat(64)}`,
    receipt_size: 123,
    receipt_sha256: digest,
    download_size: 123,
    download_sha256: digest,
    bytes_sha256: digest,
    bytes_match: true,
  };
}

function browserReadback() {
  return {
    schema: "mind-diary/import-export-in-app-browser-readback/v1",
    generator: "codex-in-app-browser-same-origin-readback/v1",
    browser_surface: "codex-in-app-browser",
    live_url: "https://mind-diary.example.invalid",
    candidate_sha: candidate,
    deployment_id: "appgdep_md363after",
    fixture_manifest_sha256: `sha256:${"c".repeat(64)}`,
    observed_at_utc: "2026-08-27T23:05:00.000Z",
    run_fingerprint: `sha256:${"3".repeat(64)}`,
    actor_fingerprints: {
      owner: `sha256:${"4".repeat(64)}`,
      reader: `sha256:${"5".repeat(64)}`,
    },
    assertions: IMPORT_EXPORT_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
    import_matrix: {
      revision_count_delta: 1,
      one_head_transition: true,
      history_unchanged: true,
      opaque_preserved: true,
      opaque_sha256: `sha256:${"d".repeat(64)}`,
      unknown_okf_fields_preserved: true,
      interruption_recovered: true,
      cancel_no_head_change: true,
      idempotent_retry_single_result: true,
      invalid_inputs_no_side_effect: true,
      size_plus_one_no_side_effect: true,
      quota_no_side_effect: true,
      head_conflict_no_side_effect: true,
    },
    exports: [
      exportComparison("current", "MD-BUNDLE-ZIP-1", "6"),
      exportComparison("historical", "MD-OKF-ZIP-1", "7"),
      exportComparison("mixed", "MD-BUNDLE-ZIP-1", "8"),
    ],
    redeploy: {
      import_recovered: true,
      export_recovered: true,
      before_deployment_id: "appgdep_md363before",
      after_deployment_id: "appgdep_md363after",
    },
    access: {
      expired_denied: true,
      credential_revoked_denied: true,
      visibility_tightened_denied: true,
    },
    cleanup: {
      credential_revoked: true,
      mind_deleted: true,
      route_absent: true,
      jobs_absent: true,
      grants_absent: true,
    },
  };
}

function inputs(overrides = {}) {
  const local = overrides.localReceipt ?? localReceipt();
  const provider = overrides.providerReadback ?? providerReadback();
  const browser = overrides.browserReadback ?? browserReadback();
  return {
    localReceipt: local,
    providerReadback: provider,
    browserReadback: browser,
    localReceiptBytes: Buffer.from(JSON.stringify(local), "utf8"),
    providerReadbackBytes: Buffer.from(JSON.stringify(provider), "utf8"),
    browserReadbackBytes: Buffer.from(JSON.stringify(browser), "utf8"),
    archiveBytes,
  };
}

function recomputeArtifact(value) {
  const { artifact_sha256: _artifactSha256, ...unsigned } = value;
  value.artifact_sha256 = digest(canonical(unsigned));
  return value;
}

test("MD-363 join CLI has no approval or hosted-pass input", () => {
  assert.deepEqual(parseCli([
    "--local-receipt", "/tmp/local.json",
    "--provider-readback", "/tmp/provider.json",
    "--browser-readback", "/tmp/browser.json",
    "--artifact-archive", "/tmp/site.tgz",
    "--candidate-sha", candidate,
    "--join-out", "/tmp/join.json",
  ]), {
    local_receipt: "/tmp/local.json",
    provider_readback: "/tmp/provider.json",
    browser_readback: "/tmp/browser.json",
    artifact_archive: "/tmp/site.tgz",
    candidate_sha: candidate,
    join_out: "/tmp/join.json",
  });
  assert.throws(
    () => parseCli(["--hosted-pass", "true"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
});

test("lookalike local files can prove structure but never produce hosted PASS", () => {
  const input = inputs();
  const join = createStructuralJoin(input, {
    candidate,
    siteProjectId,
    siteSourceCommitSha,
    siteSourceTreeSha,
    siteSourceMode,
  });
  assert.equal(join.status, "structurally_verified_readback");
  assert.equal(join.hosted_evidence, false);
  assert.equal(join.acceptance, "nonterminal");
  assert.equal(join.provenance, "unverified-local-files");
  assert.notEqual(join.status, "passed");
  assert.equal(join.byte_bindings.site_archive_sha256, sha256(archiveBytes));
  assert.equal(join.byte_bindings.local_receipt_sha256, input.localReceipt.artifact_sha256);
  assert.equal(join.byte_bindings.fixture_manifest_sha256, `sha256:${"c".repeat(64)}`);
  assert.match(join.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
});

test("tampered bytes and every persisted semantic projection fail closed even with a recomputed artifact hash", () => {
  const wrongArchive = inputs();
  wrongArchive.archiveBytes = Buffer.from("changed", "utf8");
  assert.throws(
    () => createStructuralJoin(wrongArchive, {
      candidate,
      siteProjectId,
      siteSourceCommitSha,
      siteSourceTreeSha,
      siteSourceMode,
    }),
    (error) => error instanceof ProbeFailure && error.code === "provider_lineage_mismatch",
  );

  const wrongBrowser = browserReadback();
  wrongBrowser.exports[2].bytes_sha256 = `sha256:${"9".repeat(64)}`;
  assert.throws(
    () => createStructuralJoin(inputs({ browserReadback: wrongBrowser }), {
      candidate,
      siteProjectId,
      siteSourceCommitSha,
      siteSourceTreeSha,
      siteSourceMode,
    }),
    (error) => error instanceof ProbeFailure && error.code === "browser_export_digest_mismatch",
  );

  const input = inputs();
  const original = createStructuralJoin(input, {
    candidate,
    siteProjectId,
    siteSourceCommitSha,
    siteSourceTreeSha,
    siteSourceMode,
  });
  const mutations = [
    (join) => { join.claimed_lineage.site_version_id = "appgver_forged"; },
    (join) => { join.actor_fingerprints.owner = `sha256:${"9".repeat(64)}`; },
    (join) => { join.import_matrix.history_unchanged = false; },
    (join) => { join.exports[1].bytes_match = false; },
    (join) => { join.cleanup.jobs_absent = false; },
    (join) => { join.status = "passed"; join.hosted_evidence = true; },
  ];
  for (const mutate of mutations) {
    const join = structuredClone(original);
    mutate(join);
    recomputeArtifact(join);
    assert.throws(
      () => validateStructuralJoin(join, {
        expected: {
          candidate,
          siteProjectId,
          siteSourceCommitSha,
          siteSourceTreeSha,
          siteSourceMode,
        },
        input,
      }),
      (error) => error instanceof ProbeFailure && error.code === "invalid_structural_join",
    );
  }
});
