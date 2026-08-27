import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ADMIN_SHELL_UAT_JOURNEYS,
  createVerifiedReceipt,
  parseCli,
  validateReceipt,
} from "../../scripts/verify-admin-shell-uat-receipt.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";

const expected = Object.freeze({
  candidateSha: "a".repeat(40),
  sourceTreeSha: "b".repeat(40),
  siteProjectId: "appgprj_fixture123",
});
const archiveBytes = Buffer.from("exact packaged Sites archive fixture", "utf8");
const serverBundleBytes = Buffer.from("export default { fetch() {} };", "utf8");
const cssBytes = Buffer.from("body { color: CanvasText; }\n", "utf8");
const clientBytes = Buffer.from("document.documentElement.dataset.ready = 'true';\n", "utf8");

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function journeys() {
  return ADMIN_SHELL_UAT_JOURNEYS.map((journey) => ({
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
  }));
}

function providerReadback() {
  return {
    schema: "mind-diary/admin-shell-sites-provider-readback/v1",
    generator: "codex-sites-connector-readback/v1",
    observed_at_utc: "2026-08-27T22:31:00.000Z",
    site: {
      id: expected.siteProjectId,
      status: "active",
      current_live_url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T22:29:00.000Z",
    },
    saved_version: {
      id: "appgver_fixture123",
      project_id: expected.siteProjectId,
      version_number: 347,
      source: { commit_sha: expected.candidateSha },
      archive_storage: {
        archive_format: "tar.gz",
        content_hash: sha256(archiveBytes),
        size_bytes: archiveBytes.byteLength,
      },
    },
    version: {
      id: "appgver_fixture123",
      project_id: expected.siteProjectId,
      version_number: 347,
      source: { commit_sha: expected.candidateSha },
      archive_storage: {
        archive_format: "tar.gz",
        content_hash: sha256(archiveBytes),
        size_bytes: archiveBytes.byteLength,
      },
    },
    deployment_start: {
      id: "appgdep_fixture123",
      project_id: expected.siteProjectId,
      version_id: "appgver_fixture123",
      status: "publishing",
      type: "publish",
      url: null,
      updated_at: "2026-08-27T22:29:30.000Z",
    },
    deployment: {
      id: "appgdep_fixture123",
      project_id: expected.siteProjectId,
      version_id: "appgver_fixture123",
      status: "succeeded",
      type: "publish",
      url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T22:30:00.000Z",
    },
  };
}

function browserReadback() {
  return {
    schema: "mind-diary/admin-shell-in-app-browser-readback/v1",
    generator: "codex-in-app-browser-same-origin-readback/v1",
    browser_surface: "codex-in-app-browser",
    live_url: "https://mind-diary.example.invalid",
    observed_at_utc: "2026-08-27T22:32:00.000Z",
    assets: [
      {
        path: "/ui/mind-diary-shell.css",
        response_url: "https://mind-diary.example.invalid/ui/mind-diary-shell.css",
        status: 200,
        content_type: "text/css; charset=utf-8",
        body_base64: cssBytes.toString("base64"),
        body_sha256: sha256(cssBytes),
      },
      {
        path: "/ui/mind-diary-shell-client.js",
        response_url: "https://mind-diary.example.invalid/ui/mind-diary-shell-client.js",
        status: 200,
        content_type: "text/javascript; charset=utf-8",
        body_base64: clientBytes.toString("base64"),
        body_sha256: sha256(clientBytes),
      },
    ],
    journeys: journeys(),
  };
}

function inputs(overrides = {}) {
  const provider = overrides.providerReadback ?? providerReadback();
  const browser = overrides.browserReadback ?? browserReadback();
  return {
    providerReadback: provider,
    browserReadback: browser,
    providerReadbackBytes: Buffer.from(JSON.stringify(provider), "utf8"),
    browserReadbackBytes: Buffer.from(JSON.stringify(browser), "utf8"),
    archiveBytes: overrides.archiveBytes ?? archiveBytes,
    serverBundleBytes,
    candidateAssets: {
      "/ui/mind-diary-shell.css": cssBytes,
      "/ui/mind-diary-shell-client.js": clientBytes,
    },
  };
}

test("hosted admin shell CLI accepts only exact provider, browser and archive inputs", () => {
  assert.deepEqual(parseCli([
    "--provider-readback", "/tmp/provider.json",
    "--browser-readback", "/tmp/browser.json",
    "--artifact-archive", "/tmp/site.tar.gz",
    "--candidate-sha", expected.candidateSha,
    "--receipt-out", "/tmp/receipt.json",
  ]), {
    provider_readback: "/tmp/provider.json",
    browser_readback: "/tmp/browser.json",
    artifact_archive: "/tmp/site.tar.gz",
    candidate_sha: expected.candidateSha,
    receipt_out: "/tmp/receipt.json",
  });
  assert.throws(
    () => parseCli(["--receipt", "/tmp/self-asserted.json", "--approve", "true"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
});

test("hosted receipt is derived from exact provider, archive, server and live bytes", () => {
  const input = inputs();
  const receipt = createVerifiedReceipt(input, expected);
  assert.equal(receipt.schema, "mind-diary/admin-shell-uat-evidence/v2");
  assert.equal(receipt.lineage.artifact_archive_sha256, sha256(archiveBytes));
  assert.equal(receipt.lineage.server_bundle_sha256, sha256(serverBundleBytes));
  assert.equal(receipt.lineage.shell_css_sha256, sha256(cssBytes));
  assert.equal(receipt.lineage.shell_client_sha256, sha256(clientBytes));
  assert.equal(JSON.stringify(receipt).includes("body_base64"), false);
});

test("fake hashes, live bytes and opaque IDs cannot replace bound inputs", () => {
  const fakeArchiveHash = providerReadback();
  fakeArchiveHash.version.archive_storage.content_hash = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => createVerifiedReceipt(inputs({ providerReadback: fakeArchiveHash }), expected),
    (error) => error instanceof ProbeFailure && error.code === "uat_archive_digest_mismatch",
  );

  const fakeLiveHash = browserReadback();
  fakeLiveHash.assets[0].body_sha256 = `sha256:${"e".repeat(64)}`;
  assert.throws(
    () => createVerifiedReceipt(inputs({ browserReadback: fakeLiveHash }), expected),
    (error) => error instanceof ProbeFailure &&
      error.code === "live_asset_supplied_digest_mismatch",
  );

  const fakeProviderId = providerReadback();
  fakeProviderId.deployment.id = "appgdep_fabricated";
  assert.throws(
    () => createVerifiedReceipt(inputs({ providerReadback: fakeProviderId }), expected),
    (error) => error instanceof ProbeFailure &&
      error.code === "provider_readback_lineage_mismatch",
  );

  const input = inputs();
  const receipt = structuredClone(createVerifiedReceipt(input, expected));
  receipt.lineage.deployment_id = "appgdep_fabricated";
  assert.throws(
    () => validateReceipt(receipt, {
      ...expected,
      provider: {
        site_project_id: input.providerReadback.site.id,
        site_version_id: input.providerReadback.version.id,
        deployment_id: input.providerReadback.deployment.id,
        version_number: input.providerReadback.version.version_number,
        artifact_archive_sha256: sha256(archiveBytes),
      },
      browser: {
        assets: {
          "/ui/mind-diary-shell.css": sha256(cssBytes),
          "/ui/mind-diary-shell-client.js": sha256(clientBytes),
        },
        journeys: journeys(),
      },
      serverBundleSha256: sha256(serverBundleBytes),
      input,
    }),
    (error) => error instanceof ProbeFailure && error.code === "uat_evidence_binding_mismatch",
  );
});
