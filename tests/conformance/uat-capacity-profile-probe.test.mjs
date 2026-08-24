import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RESTRICTED_UAT_CAPACITY_PROFILE,
  RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE,
} from "@mind-diary/composition-root";
import {
  CAPACITY_PROFILE_ASSERTION_IDS,
  ProbeFailure,
  createEvidence,
  parseCli,
  run,
  validateCapacitySnapshot,
} from "../../scripts/run-uat-capacity-profile-probe.mjs";

const SHA = "a".repeat(40);
const FENCE = "capacity-fence-nonce-01";
const NOW = "2026-08-24T12:00:00.000Z";

function snakeKey(key) {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function limits(profile = RESTRICTED_UAT_CAPACITY_PROFILE) {
  return Object.fromEntries(
    Object.entries(profile.limits)
      .map(([key, value]) => [snakeKey(key), value]),
  );
}

function releaseConfigurationFenceSha256(
  candidateSha = SHA,
  fenceNonce = FENCE,
) {
  return `sha256:${createHash("sha256")
    .update(
      `mind-diary/uat-release-configuration-fence/v1\0${candidateSha}\0${fenceNonce}`,
    )
    .digest("hex")}`;
}

function snapshot(overrides = {}) {
  return {
    schema: "mind-diary/operator-capacity-diagnostics",
    version: 1,
    observed_at: NOW,
    release_fence: {
      schema: "mind-diary/uat-release-configuration-fence",
      version: 1,
      sha256: releaseConfigurationFenceSha256(),
    },
    profile: {
      schema: "mind-diary/capacity-profile",
      version: 1,
      profile_id: "restricted-uat-v1",
      deployment_posture: "restricted-uat",
      limits: limits(),
    },
    usage: {
      physical_canonical_bytes: 5_900_000,
      temporary_bytes: 0,
      d1_metadata_bytes: 12_000,
      logical_head_bytes: 5_800_000,
      logical_retained_bytes: 5_800_000,
      reserved_bytes: 0,
      trustworthy: true,
      reconciled_at: NOW,
    },
    headroom: {
      canonical_bytes: 27_654_432,
      temporary_bytes: 8_589_934_592,
      d1_metadata_bytes: 536_858_912,
    },
    storage_amplification: 1.017,
    quota_rejects: 2,
    reservations: {
      active_count: 1,
      active_bytes: 256,
      expired_active_count: 0,
      expired_active_bytes: 0,
      cleanup_pending_count: 0,
      cleanup_pending_bytes: 0,
      stale_count: 0,
      stale_bytes: 0,
    },
    utilization: "warning",
    ...overrides,
  };
}

test("capacity UAT snapshot and receipt have exact versioned, redacted schema", () => {
  const validated = validateCapacitySnapshot(snapshot());
  assert.equal(validated.profile.limits.mind_physical_canonical_bytes, 8_388_608);
  const evidence = createEvidence({
    candidateSha: SHA,
    configurationFenceNonce: FENCE,
    snapshot: validated,
  });
  assert.deepEqual(evidence, createEvidence({
    candidateSha: SHA,
    configurationFenceNonce: FENCE,
    snapshot: validated,
  }));
  assert.equal(evidence.schema, "mind-diary/uat-capacity-profile-evidence/v1");
  assert.equal(evidence.profile.profile_id, "restricted-uat-v1");
  assert.equal(
    evidence.release_configuration_fence_sha256,
    releaseConfigurationFenceSha256(),
  );
  assert.equal(evidence.lineage_scope, "runtime_configuration_fence_not_attestation");
  assert.equal("deployment_id" in evidence, false);
  assert.deepEqual(
    evidence.assertions.map(({ id }) => id),
    CAPACITY_PROFILE_ASSERTION_IDS,
  );
  assert.match(evidence.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes("@"), false);
});

test("capacity UAT snapshot rejects schema drift, changed limits and wrong configuration fence", () => {
  const { reservations: _missing, ...missingField } = snapshot();
  assert.throws(
    () => validateCapacitySnapshot(missingField),
    (error) => error instanceof ProbeFailure && error.code === "invalid_capacity_snapshot_schema",
  );
  assert.throws(
    () => validateCapacitySnapshot({
      ...snapshot(),
      profile: {
        ...snapshot().profile,
        limits: { ...limits(), mind_physical_canonical_bytes: 9_000_000 },
      },
    }),
    (error) => error instanceof ProbeFailure && error.code === "capacity_limit_mismatch",
  );
  assert.throws(
    () => validateCapacitySnapshot({ ...snapshot(), path: "private.md" }),
    (error) => error instanceof ProbeFailure && error.code === "invalid_capacity_snapshot_schema",
  );
  assert.throws(
    () => createEvidence({
      candidateSha: SHA,
      configurationFenceNonce: "different-fence-nonce-02",
      snapshot: snapshot(),
    }),
    (error) => error instanceof ProbeFailure &&
      error.code === "release_configuration_fence_mismatch",
  );
});

test("capacity UAT snapshot accepts exact default profile only when selected", () => {
  const defaults = snapshot({
    profile: {
      schema: "mind-diary/capacity-profile",
      version: 1,
      profile_id: "default-v1",
      deployment_posture: "restricted-uat",
      limits: limits(RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE),
    },
    utilization: "normal",
  });
  assert.equal(validateCapacitySnapshot(defaults, "default-v1").profile.profile_id, "default-v1");
  assert.throws(
    () => validateCapacitySnapshot(defaults, "restricted-uat-v1"),
    (error) => error instanceof ProbeFailure && error.code === "unexpected_capacity_profile",
  );
});

test("capacity UAT probe uses only environment credential, rejects query override and writes 0600 evidence", async () => {
  assert.deepEqual(parseCli([
    "--candidate-sha", SHA,
    "--configuration-fence-nonce", FENCE,
    "--expected-profile", "restricted-uat-v1",
    "--expected-utilization", "warning",
    "--min-quota-rejects", "2",
  ]), {
    candidate_sha: SHA,
    configuration_fence_nonce: FENCE,
    expected_profile: "restricted-uat-v1",
    expected_utilization: "warning",
    min_quota_rejects: "2",
  });
  assert.throws(
    () => parseCli(["--operator-sites-token", "private"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
  assert.throws(
    () => parseCli(["--deployment-id", "appgdep_self_certified"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );

  const directory = await mkdtemp(join(tmpdir(), "mind-diary-capacity-"));
  const output = join(directory, "evidence.json");
  await writeFile(output, "stale\n", { mode: 0o644 });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers["OAI-Sites-Authorization"] });
    if (new URL(url).searchParams.has("profile")) {
      return Response.json({ ok: false, error: { code: "invalid_request" } }, { status: 400 });
    }
    return Response.json({ ok: true, data: snapshot() });
  };
  try {
    const evidence = await run({
      candidate_sha: SHA,
      configuration_fence_nonce: FENCE,
      expected_utilization: "warning",
      min_quota_rejects: "2",
      evidence_out: output,
      base_url: "https://mind-diary.example",
    }, {
      environment: { MIND_DIARY_UAT_OPERATOR_SITES_TOKEN: "private-sites-token" },
      fetchImpl,
    });
    assert.equal(evidence.status, "passed");
    assert.equal(requests.length, 2);
    assert.equal(requests.every(({ authorization }) => authorization === "Bearer private-sites-token"), true);
    assert.equal(JSON.stringify(evidence).includes("private-sites-token"), false);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidence);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capacity UAT probe emits a terminal default-profile receipt", async () => {
  const defaultSnapshot = snapshot({
    profile: {
      schema: "mind-diary/capacity-profile",
      version: 1,
      profile_id: "default-v1",
      deployment_posture: "restricted-uat",
      limits: limits(RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE),
    },
    utilization: "normal",
  });
  const evidence = await run({
    candidate_sha: SHA,
    configuration_fence_nonce: FENCE,
    expected_profile: "default-v1",
    base_url: "https://mind-diary.example",
  }, {
    environment: { MIND_DIARY_UAT_OPERATOR_SITES_TOKEN: "private-sites-token" },
    fetchImpl: async (url) => new URL(url).search.length > 0
      ? Response.json({ ok: false, error: { code: "invalid_request" } }, { status: 400 })
      : Response.json({ ok: true, data: defaultSnapshot }),
  });
  assert.equal(evidence.profile.profile_id, "default-v1");
  assert.deepEqual(
    evidence.profile.limits,
    limits(RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE),
  );
});
