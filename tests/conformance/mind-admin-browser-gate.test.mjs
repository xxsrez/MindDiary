import assert from "node:assert/strict";
import test from "node:test";

import {
  MIND_ADMIN_BROWSER_ASSERTION_IDS,
  MIND_ADMIN_BROWSER_SOURCE_FILES,
  createEvidence,
  parseCli,
} from "../../scripts/run-mind-admin-browser-gate.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";

const sha256 = (character) => `sha256:${character.repeat(64)}`;

test("MD-351 browser gate CLI is closed to an exact candidate and private receipt", () => {
  assert.deepEqual(parseCli([
    "--candidate-sha", "a".repeat(40),
    "--evidence-out", "/tmp/mind-diary-md351-evidence.json",
  ]), {
    candidate_sha: "a".repeat(40),
    evidence_out: "/tmp/mind-diary-md351-evidence.json",
  });
  for (const argv of [
    ["--evidence-out", "/tmp/evidence.json", "--base-url", "https://example.invalid"],
    ["--evidence-out", "/tmp/evidence.json", "--actor-email", "person@example.invalid"],
    ["--evidence-out", "/tmp/evidence.json", "--hosted", "true"],
  ]) {
    assert.throws(
      () => parseCli(argv),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("MD-351 local receipt binds exact tree, executed bytes and toolchain but is not hosted", () => {
  assert.equal(new Set(MIND_ADMIN_BROWSER_ASSERTION_IDS).size, 12);
  assert.equal(new Set(MIND_ADMIN_BROWSER_SOURCE_FILES).size, 13);
  for (const requiredContractSource of [
    "docs/specs/release-0.3-traceability.md",
    "tests/conformance/release-0.3-traceability-contract.test.mjs",
    "tests/fixtures/release-0.3-traceability/contract.v1.json",
  ]) {
    assert.ok(MIND_ADMIN_BROWSER_SOURCE_FILES.includes(requiredContractSource));
  }
  const sourceHashes = Object.fromEntries(
    MIND_ADMIN_BROWSER_SOURCE_FILES.map((path, index) => [path, sha256(String(index + 1))]),
  );
  const evidence = createEvidence({
    candidate: "b".repeat(40),
    tree: "c".repeat(40),
    toolchain: {
      playwright_package_version: "1.62.1",
      playwright_cli_version: "1.62.1",
      chromium_package_version: "1.62.1",
      playwright_core_version: "1.62.1",
      chromium_revision: "1234",
      chromium_browser_version: "151.0.7922.34",
      chromium_executable_sha256: sha256("f"),
    },
    sourceHashes,
    assertions: MIND_ADMIN_BROWSER_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-27T23:00:00.000Z",
    completedAt: "2026-08-27T23:01:00.000Z",
  });
  assert.equal(evidence.schema, "mind-diary/mind-admin-browser-evidence/v1");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.hosted_evidence, false);
  assert.equal(evidence.acceptance, "local-only");
  assert.equal(evidence.candidate_sha, "b".repeat(40));
  assert.equal(evidence.candidate_tree_sha, "c".repeat(40));
  assert.deepEqual(evidence.executed_sources, sourceHashes);
  assert.deepEqual(evidence.assertions.map(({ id }) => id), MIND_ADMIN_BROWSER_ASSERTION_IDS);
  assert.match(evidence.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes("@example"), false);
});
