import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../../scripts/run-synthetic-multi-principal-probe.mjs";
import {
  SYNTHETIC_ASSERTION_IDS,
  canonical,
  digest,
} from "../../scripts/lib/multi-principal-probe-core.mjs";

test("one-shot synthetic gate exercises ordinary Product Site commands and emits only redacted evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-synthetic-gate-"));
  const evidencePath = join(directory, "evidence.json");
  try {
    const evidence = await run({ evidence_out: evidencePath });
    assert.equal(evidence.schema, "mind-diary/synthetic-multi-principal-evidence/v1");
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.actor_class, "synthetic-principal");
    assert.equal(evidence.binding_namespace, "synthetic-test");
    assert.equal(evidence.assertions.length, SYNTHETIC_ASSERTION_IDS.length);
    assert.deepEqual(evidence.assertions.map(({ id }) => id), SYNTHETIC_ASSERTION_IDS);
    assert.equal(new Set(evidence.actor_fingerprints).size, 2);
    const { artifact_sha256: artifact, ...unsigned } = evidence;
    assert.equal(artifact, digest(canonical(unsigned)));

    const persisted = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.deepEqual(persisted, evidence);
    assert.equal((await stat(evidencePath)).mode & 0o077, 0);
    const serialized = JSON.stringify(persisted);
    for (const forbidden of [
      "@synthetic.invalid",
      "mdp_v1_",
      "principal_",
      "space_",
      "revision_",
      "token_",
      "concepts/synthetic-gate.md",
      "Synthetic Boundary",
      "authorization",
      "cookie",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
