import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SHELL_BROWSER_ASSERTION_IDS,
  ADMIN_SHELL_BROWSER_VIEWPORTS,
  createEvidence,
  parseCli,
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
    versions: { playwright: "1.62.1", chromium: "1.62.1" },
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
