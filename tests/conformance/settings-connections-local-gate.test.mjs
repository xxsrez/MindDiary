import assert from "node:assert/strict";
import test from "node:test";

import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";
import {
  verifySettingsConnectionsCatalogProfiles,
} from "../../scripts/lib/settings-connections-plugin-observation.mjs";
import {
  createEvidence,
  parseCli,
  SETTINGS_CONNECTIONS_RUNTIME_SUITES,
  SETTINGS_CONNECTIONS_SOURCE_PATHS,
} from "../../scripts/run-settings-connections-local-gate.mjs";

const candidate = "a".repeat(40);
const digest = (marker) => `sha256:${marker.repeat(64)}`;

function toolchain() {
  return {
    playwright_package_version: "1.62.1",
    playwright_cli_version: "1.62.1",
    chromium_package_version: "1.62.1",
    playwright_core_version: "1.62.1",
    chromium_revision: "1234",
    chromium_browser_version: "151.0.7922.34",
    chromium_executable_sha256: digest("b"),
  };
}

function plugin() {
  return {
    artifact_sha256: digest("c"),
    marketplace_candidate_sha: "d".repeat(40),
    marketplace_tree_sha: "e".repeat(40),
    plugin_version: "0.1.0",
    plugin_snapshot_sha256: digest("f"),
    client: "codex-cli",
    client_version: "0.153.4",
    routes: ["/api/mcp", "/api/mcp/2025-11-25"],
    catalog_profiles: {
      default_product_site_write: 21,
      read_only: 20,
      verified_native: 22,
    },
  };
}

function sourceHashes() {
  return Object.fromEntries(SETTINGS_CONNECTIONS_SOURCE_PATHS.map((path) => [path, digest("9")]));
}

function evidence() {
  return createEvidence({
    candidate,
    contractSha256: digest("1"),
    oauth: plugin(),
    toolchain: toolchain(),
    runtimeSuites: SETTINGS_CONNECTIONS_RUNTIME_SUITES.map((path, index) => ({
      path,
      status: "passed",
      source_sha256: digest(String((index + 2) % 10)),
      stdout_sha256: digest(String((index + 3) % 10)),
    })),
    sourceHashes: sourceHashes(),
    assertions: [
      "SC-NAV-01",
      "SC-OAUTH-01",
      "SC-OAUTH-02",
      "SC-TOKEN-01",
      "SC-TOKEN-02",
      "SC-PRIVACY-01",
      "SC-FAIL-CLOSED-01",
    ].map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-28T01:00:00.000Z",
    completedAt: "2026-08-28T01:01:00.000Z",
  });
}

test("MD-358 local gate CLI accepts only exact candidate, private output and optional Marketplace root", () => {
  assert.deepEqual(parseCli([
    "--candidate-sha", candidate,
    "--evidence-out", "/private/tmp/md358/local.json",
    "--marketplace-root", "/private/tmp/marketplace",
  ]), {
    candidate_sha: candidate,
    evidence_out: "/private/tmp/md358/local.json",
    marketplace_root: "/private/tmp/marketplace",
  });
  for (const option of ["--deployment-id", "--hosted-pass", "--browser-readback"]) {
    assert.throws(
      () => parseCli(["--evidence-out", "/private/tmp/md358/local.json", option, "forged"]),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("MD-358 owns the current default, read-only, and verified-native catalog profiles", () => {
  assert.deepEqual(verifySettingsConnectionsCatalogProfiles(), {
    default_product_site_write: 21,
    read_only: 20,
    verified_native: 22,
  });
});

test("MD-358 local receipt pins plugin, client, browser and runtime while hosted rows stay not-run", () => {
  const value = evidence();
  assert.equal(value.schema, "mind-diary/settings-connections-local-evidence/v1");
  assert.equal(value.status, "passed");
  assert.equal(value.hosted_evidence, false);
  assert.equal(value.hosted_status, "not-run");
  assert.equal(value.acceptance, "local-deterministic-only");
  assert.equal(value.deployment_id, null);
  assert.equal(value.plugin.plugin_version, "0.1.0");
  assert.equal(value.plugin.client_version, "0.153.4");
  assert.deepEqual(value.plugin.catalog_profiles, {
    default_product_site_write: 21,
    read_only: 20,
    verified_native: 22,
  });
  assert.deepEqual(value.runtime_suites.map(({ path }) => path), SETTINGS_CONNECTIONS_RUNTIME_SUITES);
  assert.deepEqual(value.unresolved_hosted_rows, [
    "exact-sites-deployment",
    "in-app-browser-settings-journey",
    "fresh-hosted-codex-plugin-observation",
    "controlled-redeploy-persistence",
    "provider-and-product-cleanup-readback",
  ]);
  assert.match(value.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(value).includes("/private/tmp"), false);
});

test("MD-358 local receipt rejects a partial runtime registry", () => {
  assert.throws(
    () => createEvidence({
      candidate,
      contractSha256: digest("1"),
      oauth: plugin(),
      toolchain: toolchain(),
      runtimeSuites: [],
      sourceHashes: {},
      assertions: [],
      startedAt: "2026-08-28T01:00:00.000Z",
      completedAt: "2026-08-28T01:01:00.000Z",
    }),
    (error) => error instanceof ProbeFailure && error.code === "runtime_suite_registry_mismatch",
  );
});

test("MD-358 local receipt rejects partial assertion and source registries", () => {
  const args = {
    candidate,
    contractSha256: digest("1"),
    oauth: plugin(),
    toolchain: toolchain(),
    runtimeSuites: SETTINGS_CONNECTIONS_RUNTIME_SUITES.map((path) => ({
      path,
      status: "passed",
      source_sha256: digest("2"),
      stdout_sha256: digest("3"),
    })),
    sourceHashes: sourceHashes(),
    assertions: [
      "SC-NAV-01", "SC-OAUTH-01", "SC-OAUTH-02", "SC-TOKEN-01", "SC-TOKEN-02",
      "SC-PRIVACY-01", "SC-FAIL-CLOSED-01",
    ].map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-28T01:00:00.000Z",
    completedAt: "2026-08-28T01:01:00.000Z",
  };
  assert.throws(
    () => createEvidence({ ...args, assertions: args.assertions.slice(0, -1) }),
    (error) => error instanceof ProbeFailure && error.code === "local_assertion_registry_mismatch",
  );
  assert.throws(
    () => createEvidence({ ...args, sourceHashes: {} }),
    (error) => error instanceof ProbeFailure && error.code === "source_hash_registry_mismatch",
  );
});
