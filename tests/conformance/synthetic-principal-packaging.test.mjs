import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ProbeFailure,
  SYNTHETIC_ASSERTION_IDS,
  assertRedactedDocument,
} from "../../scripts/lib/multi-principal-probe-core.mjs";
import {
  assertNoSyntheticProductAuthority,
  findSyntheticProductAuthority,
} from "../../scripts/lib/synthetic-product-negative.mjs";
import {
  createEvidence,
  parseCli,
} from "../../scripts/run-synthetic-multi-principal-probe.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("product source and packaging expose no synthetic identity provider, switch, header, or route", async () => {
  assert.deepEqual(await findSyntheticProductAuthority(ROOT), []);
  assert.equal(await assertNoSyntheticProductAuthority(ROOT), true);
});

test("product packaging scan detects a synthetic authority in source and config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-negative-authority-"));
  try {
    const app = join(directory, "apps", "mind-diary-site");
    const packages = join(directory, "packages", "example");
    await mkdir(app, { recursive: true });
    await mkdir(packages, { recursive: true });
    await writeFile(join(app, ".env"), "MIND_DIARY_ENABLE_SYNTHETIC=1\n");
    await writeFile(join(packages, "index.ts"), "export const route = '/synthetic-login';\n");
    const findings = await findSyntheticProductAuthority(directory);
    assert.deepEqual(
      new Set(findings.map(({ label }) => label)),
      new Set(["synthetic runtime flag", "test login route"]),
    );
    await assert.rejects(
      assertNoSyntheticProductAuthority(directory),
      (error) => error.code === "synthetic_product_authority_detected",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("synthetic receipt hash is deterministic over the exact redacted unsigned document", () => {
  const input = {
    candidate: "a".repeat(40),
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:00:01.000Z",
    runFingerprint: `run-${"1".repeat(32)}`,
    actorFingerprints: [
      `actor-${"2".repeat(32)}`,
      `actor-${"3".repeat(32)}`,
    ],
    passed: new Set(SYNTHETIC_ASSERTION_IDS),
  };
  assert.deepEqual(createEvidence(input), createEvidence(input));
  assert.match(createEvidence(input).artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
});

test("synthetic CLI accepts no identity, role, token, route, or runtime-switch argument", () => {
  assert.deepEqual(parseCli(["--evidence-out", "/tmp/evidence.json"]), {
    evidence_out: "/tmp/evidence.json",
  });
  for (const option of [
    "--email",
    "--principal-id",
    "--role",
    "--token",
    "--route",
    "--enable-synthetic",
  ]) {
    assert.throws(
      () => parseCli(["--evidence-out", "/tmp/evidence.json", option, "value"]),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("shared receipt guard rejects aliases, credentials, and internal identifiers", () => {
  for (const value of [
    { alias: "owner@synthetic.invalid" },
    { secret: "mdp_v1_not-a-token" },
    { id: "principal_private" },
    { authorization: "Bearer private" },
  ]) {
    assert.throws(
      () => assertRedactedDocument(value),
      (error) => error instanceof ProbeFailure && error.code === "unsafe_evidence_document",
    );
  }
});
