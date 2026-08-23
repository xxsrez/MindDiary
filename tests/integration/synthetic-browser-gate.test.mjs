import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  run,
  SYNTHETIC_BROWSER_ASSERTION_IDS,
} from "../../scripts/run-synthetic-browser-gate.mjs";

test("server-bound synthetic browser gate produces a complete redacted receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-browser-gate-"));
  const evidenceOut = join(directory, "evidence.json");
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let tick = 0;
  try {
    const evidence = await run({ candidate_sha: candidate, evidence_out: evidenceOut }, {
      randomBytesImpl(size) { return Buffer.alloc(size, 0x61); },
      now: () => new Date(Date.UTC(2026, 7, 23, 0, 0, tick++)),
    });
    assert.equal(evidence.schema, "mind-diary/synthetic-browser-evidence/v1");
    assert.deepEqual(evidence.assertions.map(({ id }) => id), SYNTHETIC_BROWSER_ASSERTION_IDS);
    assert.equal(evidence.assertions.every(({ status }) => status === "passed"), true);
    assert.equal(evidence.candidate_sha, candidate);
    assert.equal(JSON.stringify(evidence).includes("@"), false);
    assert.equal(JSON.stringify(evidence).includes("Synthetic Browser Mind"), false);
    assert.match(evidence.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal((await stat(evidenceOut)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(evidenceOut, "utf8")), evidence);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
