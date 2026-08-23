import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCli,
  SYNTHETIC_BROWSER_ASSERTION_IDS,
} from "../../scripts/run-synthetic-browser-gate.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";

test("synthetic browser gate CLI is bounded to candidate and private evidence path", () => {
  assert.deepEqual(parseCli([
    "--candidate-sha", "a".repeat(40),
    "--evidence-out", "/tmp/mind-diary-browser-evidence.json",
  ]), {
    candidate_sha: "a".repeat(40),
    evidence_out: "/tmp/mind-diary-browser-evidence.json",
  });
  assert.equal(SYNTHETIC_BROWSER_ASSERTION_IDS.length >= 20, true);
  for (const argv of [
    ["--evidence-out", "/tmp/evidence.json", "--principal-id", "principal_forbidden"],
    ["--evidence-out", "/tmp/evidence.json", "--identity", "owner"],
    ["--evidence-out", "/tmp/evidence.json", "--skip-ui", "true"],
  ]) {
    assert.throws(
      () => parseCli(argv),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});
