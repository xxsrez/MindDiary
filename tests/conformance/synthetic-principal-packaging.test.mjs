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
  EXPECTED_D1_SCHEMA_GROUPS,
  FakeD1Database,
} from "../../scripts/lib/fake-sites-storage.mjs";
import {
  assertNoSyntheticProductAuthority,
  findSyntheticProductAuthority,
} from "../../scripts/lib/synthetic-product-negative.mjs";
import {
  createEvidence,
  parseCli,
} from "../../scripts/run-synthetic-multi-principal-probe.mjs";
import {
  SITES_IDENTITY_PROVIDER,
  resolveProductSitesIdentity,
} from "../../packages/adapter-web/dist/index.js";

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

test("trusted binding provider is constructor-only and defaults to OpenAI Sites", async () => {
  const seen = [];
  const base = {
    snapshot: {
      kind: "authenticated",
      verifiedEmail: "fixture@example.invalid",
    },
    bindings: {
      readActiveBinding(lookup) {
        seen.push(lookup.provider);
        return { kind: "unbound" };
      },
    },
    context: {
      requestId: "synthetic-provider-contract",
      occurredAtUtc: "2026-08-20T00:00:00.000Z",
      deploymentCapabilities: [],
    },
  };
  const normal = await resolveProductSitesIdentity(base);
  const alternate = await resolveProductSitesIdentity({
    ...base,
    bindingProvider: "fixture-provider",
  });
  assert.equal(normal.kind, "registration_required");
  assert.equal(normal.actor.provider, SITES_IDENTITY_PROVIDER);
  assert.equal(alternate.kind, "registration_required");
  assert.equal(alternate.actor.provider, "fixture-provider");
  assert.deepEqual(seen, [SITES_IDENTITY_PROVIDER, "fixture-provider"]);
});

test("Fake D1 rejects malformed and missing current adapter schema", async () => {
  const malformed = EXPECTED_D1_SCHEMA_GROUPS.audit[1]
    .replace("event_json TEXT NOT NULL", "event_body TEXT NOT NULL");
  await assert.rejects(
    new FakeD1Database().prepare(malformed).run(),
    /unexpected FakeD1 schema statement/u,
  );

  const incomplete = new FakeD1Database();
  await assert.rejects(
    incomplete.batch([
      incomplete.prepare(EXPECTED_D1_SCHEMA_GROUPS.metadata[0]),
    ]),
    /incomplete FakeD1 metadata schema batch/u,
  );

  await assert.rejects(
    new FakeD1Database()
      .prepare("/*md-metadata-events*/ SELECT sequence FROM md_metadata_events")
      .all(),
    /FakeD1 metadata schema is incomplete/u,
  );
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
