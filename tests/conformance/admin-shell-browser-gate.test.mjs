import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SHELL_BROWSER_ASSERTION_IDS,
  ADMIN_SHELL_BROWSER_VIEWPORTS,
  createEvidence,
  parseCli,
  verifyToolchainObservation,
} from "../../scripts/run-admin-shell-browser-gate.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";

test("MD-347 browser gate CLI is closed to an exact candidate and private receipt", () => {
  assert.deepEqual(parseCli([
    "--candidate-sha", "a".repeat(40),
    "--evidence-out", "/tmp/mind-diary-md347-evidence.json",
  ]), {
    candidate_sha: "a".repeat(40),
    evidence_out: "/tmp/mind-diary-md347-evidence.json",
  });
  for (const argv of [
    ["--evidence-out", "/tmp/evidence.json", "--browser", "chrome"],
    ["--evidence-out", "/tmp/evidence.json", "--skip", "accessibility"],
    ["--evidence-out", "/tmp/evidence.json", "--base-url", "https://example.invalid"],
  ]) {
    assert.throws(
      () => parseCli(argv),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("MD-347 evidence registry covers every accepted viewport and assertion exactly once", () => {
  assert.deepEqual(
    ADMIN_SHELL_BROWSER_VIEWPORTS.map(({ width, height }) => `${width}x${height}`),
    ["320x568", "390x844", "768x1024", "1024x768", "1440x900"],
  );
  assert.equal(new Set(ADMIN_SHELL_BROWSER_ASSERTION_IDS).size,
    ADMIN_SHELL_BROWSER_ASSERTION_IDS.length);
  const evidence = createEvidence({
    candidate: "b".repeat(40),
    toolchain: {
      playwright_package_version: "1.62.1",
      playwright_cli_version: "1.62.1",
      chromium_package_version: "1.62.1",
      playwright_core_version: "1.62.1",
      chromium_revision: "1234",
      chromium_browser_version: "151.0.7922.34",
      chromium_executable_sha256: `sha256:${"c".repeat(64)}`,
    },
    assertions: ADMIN_SHELL_BROWSER_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:01:00.000Z",
  });
  assert.equal(evidence.schema, "mind-diary/admin-shell-browser-evidence/v1");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.candidate_sha, "b".repeat(40));
  assert.deepEqual(evidence.assertions.map(({ id }) => id),
    ADMIN_SHELL_BROWSER_ASSERTION_IDS);
  assert.match(evidence.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes("/tmp"), false);
});

function toolchainObservation() {
  return {
    rootPackage: {
      devDependencies: {
        "@playwright/test": "1.62.1",
        "@playwright/browser-chromium": "1.62.1",
      },
      allowScripts: { "@playwright/browser-chromium@1.62.1": true },
    },
    lockfile: {
      packages: {
        "node_modules/@playwright/test": {
          version: "1.62.1",
          integrity: "sha512-DTcUc8qii+cpHvtOwggMtBRMjKZHXYWdw8syRYu2vtzuq4Wxphqq4NfCs5Zt44L6mA8rfDfj+PHnxFc/FeK6mQ==",
        },
        "node_modules/@playwright/browser-chromium": {
          version: "1.62.1",
          integrity: "sha512-DU/t4TSqHvAc+uFMt972forQYqBTh/ul7lZ8U81HYGyxnf6vSPPz9NzuE0OR3x/elqvvGm+n4gcny+QSKT+FDw==",
        },
        "node_modules/playwright-core": {
          version: "1.62.1",
          integrity: "sha512-wPYSwEBJY9GHraISXqyqtx0na0LpO3XEX7jNDhntbex7tzUS7kLnZsOlFruFJB4Hi/rhDMjXGqHewDZ68nYZVw==",
        },
      },
    },
    installedPlaywright: { version: "1.62.1" },
    installedBrowser: { version: "1.62.1" },
    installedCore: { version: "1.62.1" },
    browserManifest: {
      browsers: [{
        name: "chromium",
        revision: "1234",
        browserVersion: "151.0.7922.34",
      }],
    },
    cliVersionOutput: "Version 1.62.1\n",
    browserVersionOutput: "Google Chrome for Testing 151.0.7922.34\n",
    executablePath: "/private/cache/chromium-1234/chrome",
  };
}

test("MD-347 rejects mismatched actually executed browser toolchain", () => {
  assert.equal(
    verifyToolchainObservation(toolchainObservation()).chromium_browser_version,
    "151.0.7922.34",
  );
  for (const [mutate, code] of [
    [(value) => { value.cliVersionOutput = "Version 1.62.0\n"; },
      "playwright_runtime_version_mismatch"],
    [(value) => { value.browserVersionOutput = "Google Chrome for Testing 150.0.0.0\n"; },
      "chromium_runtime_version_mismatch"],
    [(value) => { value.lockfile.packages["node_modules/@playwright/test"].integrity = "sha512-fake"; },
      "unpinned_browser_toolchain"],
  ]) {
    const value = structuredClone(toolchainObservation());
    mutate(value);
    assert.throws(
      () => verifyToolchainObservation(value),
      (error) => error instanceof ProbeFailure && error.code === code,
    );
  }
});
