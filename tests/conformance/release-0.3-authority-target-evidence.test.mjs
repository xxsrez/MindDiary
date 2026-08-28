import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OAUTH_DIRECT_PLUGIN_ASSERTION_IDS,
  createEvidence as createOAuthEvidence,
} from "../../scripts/run-oauth-direct-plugin-probe.mjs";
import {
  RELEASE_03_AUTHORITY_TARGET_JOIN_SCHEMA,
  RELEASE_03_FINAL_ASSERTION_IDS,
  RELEASE_03_HOSTED_AUTHORITY_CASE_IDS,
  RELEASE_03_HOSTED_CREDENTIAL_CASE_IDS,
  RELEASE_03_LOCAL_ASSERTION_IDS,
  RELEASE_03_LOCAL_SOURCE_PATHS,
  RELEASE_03_LOCAL_TEST_PATHS,
  Release03AuthorityTargetEvidenceError,
  createRelease03AuthorityTargetHostedObservation,
  createRelease03AuthorityTargetLocalEvidence,
  createRelease03AuthorityTargetUatJoin,
  verifyRelease03AuthorityTargetHostedObservation,
  verifyRelease03AuthorityTargetLocalEvidence,
  verifyRelease03AuthorityTargetUatJoin,
} from "../../scripts/lib/release-0.3-authority-target-evidence.mjs";
import {
  SYNTHETIC_ASSERTION_IDS,
  digest,
  canonical,
} from "../../scripts/lib/multi-principal-probe-core.mjs";
import { EXPECTED_MCP_TOOL_NAMES } from "../../scripts/lib/exact-mcp-tool-inventory.mjs";
import {
  createPendingUatTestAccountPoolInventory,
  createUatTestAccountPoolReadinessReceipt,
} from "../../scripts/lib/uat-test-account-pool-contract.mjs";
import { createEvidence as createSyntheticEvidence } from
  "../../scripts/run-synthetic-multi-principal-probe.mjs";
import { parseCli as parseJoinCli } from
  "../../scripts/join-release-0.3-authority-target-uat.mjs";
import { parseCli as parseLocalGateCli } from
  "../../scripts/run-release-0.3-authority-target-local-gate.mjs";

const CANDIDATE = "a".repeat(40);
const DEPLOYMENT = "appgdep_authorityfixture";
const T0 = "2026-08-28T00:00:00.000Z";
const T1 = "2026-08-28T00:01:00.000Z";
const ACTORS = [
  `actor-${"1".repeat(32)}`,
  `actor-${"2".repeat(32)}`,
  `actor-${"3".repeat(32)}`,
];

function passed(ids) {
  return ids.map((id) => ({ id, status: "passed" }));
}

function rehash(value) {
  const copy = structuredClone(value);
  delete copy.artifact_sha256;
  return { ...copy, artifact_sha256: digest(canonical(copy)) };
}

function syntheticEvidence() {
  return createSyntheticEvidence({
    candidate: CANDIDATE,
    startedAt: T0,
    completedAt: T1,
    runFingerprint: `run-${"4".repeat(32)}`,
    actorFingerprints: [`actor-${"5".repeat(32)}`, `actor-${"6".repeat(32)}`],
    passed: new Set(SYNTHETIC_ASSERTION_IDS),
  });
}

function oauthEvidence() {
  return createOAuthEvidence({
    candidate: CANDIDATE,
    marketplace: {
      head: "b".repeat(40),
      tree: "c".repeat(40),
      pluginVersion: "0.1.0+fixture",
      snapshotSha256: `sha256:${"d".repeat(64)}`,
    },
    startedAt: T0,
    completedAt: T1,
    passed: new Set(OAUTH_DIRECT_PLUGIN_ASSERTION_IDS),
  });
}

function localEvidence() {
  return createRelease03AuthorityTargetLocalEvidence({
    candidateSha: CANDIDATE,
    syntheticEvidence: syntheticEvidence(),
    oauthEvidence: oauthEvidence(),
    tests: RELEASE_03_LOCAL_TEST_PATHS.map((path) => ({
      path,
      status: "passed",
      stdout_sha256: `sha256:${"e".repeat(64)}`,
    })),
    sourceHashes: Object.fromEntries(RELEASE_03_LOCAL_SOURCE_PATHS.map((path) => [
      path,
      `sha256:${"f".repeat(64)}`,
    ])),
    startedAt: T0,
    completedAt: T1,
  });
}

function readyPool() {
  const inventory = structuredClone(createPendingUatTestAccountPoolInventory());
  for (const key of Object.keys(inventory.owner_authority)) {
    inventory.owner_authority[key] = "owner-confirmed";
  }
  inventory.actors.forEach((actor, index) => {
    actor.actor_fingerprint = ACTORS[index];
    actor.provisioning.external_account = "owner-confirmed";
    actor.provisioning.first_login_mfa = "owner-confirmed";
    actor.provisioning.independent_session = "verified";
  });
  inventory.readback.custom_audience = "exact";
  inventory.readback.operator_allowlist = "exact";
  inventory.readback.distinct_principals = "verified";
  inventory.baseline.temporary_mind_roles = "verified-absent";
  inventory.baseline.per_run_mcp_tokens = "verified-absent";
  return createUatTestAccountPoolReadinessReceipt(inventory, {
    observedAtUtc: T0,
    candidateSha: CANDIDATE,
    deploymentId: DEPLOYMENT,
  });
}

function catalog(protocol) {
  return {
    protocol,
    tool_names: [...EXPECTED_MCP_TOOL_NAMES],
    retired_binding_tools_absent: true,
    moved_export_tools_absent: true,
  };
}

function hostedObservation() {
  return createRelease03AuthorityTargetHostedObservation({
    candidateSha: CANDIDATE,
    deploymentId: DEPLOYMENT,
    runFingerprint: `uatauth-run-${"7".repeat(32)}`,
    actorFingerprints: ACTORS,
    deploymentReadBack: {
      site_project_id: "appgprj_authorityfixture",
      site_version_id: "appgver_authorityfixture",
      archive_sha256: `sha256:${"8".repeat(64)}`,
    },
    webSurfaces: [
      { id: "oauth-connection", status: "passed" },
      { id: "personal-token-advanced-mcp", status: "passed" },
    ],
    catalogs: {
      modern: catalog("2026-07-28"),
      compatibility: catalog("2025-11-25"),
    },
    credentialCases: passed(RELEASE_03_HOSTED_CREDENTIAL_CASE_IDS),
    authorityCases: passed(RELEASE_03_HOSTED_AUTHORITY_CASE_IDS),
    immutableRevision: {
      commit_status: "committed",
      head_matches_commit: true,
      history_matches_commit: true,
      fetch_matches_commit: true,
      content_sha256: `sha256:${"9".repeat(64)}`,
    },
    cleanup: {
      status: "passed",
      credentials_revoked_next_request_denied: true,
      run_mind_absent: true,
      pool_baseline_unchanged: true,
    },
    observedAtUtc: T1,
  });
}

test("MD-344 contract fixture is closed and reuses the exact 18-tool inventory", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../fixtures/release-0.3-authority-target/contract.v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(fixture.release, "0.3");
  assert.equal(fixture.owner, "MD-344");
  assert.deepEqual(fixture.toolInventory, EXPECTED_MCP_TOOL_NAMES);
  assert.deepEqual(fixture.credentialCases, RELEASE_03_HOSTED_CREDENTIAL_CASE_IDS);
  assert.deepEqual(fixture.authorityCases, RELEASE_03_HOSTED_AUTHORITY_CASE_IDS);
  for (const source of fixture.localSources) {
    await readFile(new URL(`../../${source}`, import.meta.url));
  }
  assert.equal(fixture.joinRules.hostedFromLocal, "forbidden");
  assert.equal(fixture.joinRules.production, "excluded");
});

test("local gate and hosted join CLIs accept evidence paths but no identity or credential input", () => {
  assert.deepEqual(parseLocalGateCli([
    "--candidate-sha", CANDIDATE,
    "--evidence-out", "/private/tmp/private/local.json",
  ]), {
    candidate_sha: CANDIDATE,
    evidence_out: "/private/tmp/private/local.json",
  });
  assert.deepEqual(parseJoinCli([
    "--local-evidence", "local.json",
    "--pool-evidence", "pool.json",
    "--hosted-observation", "hosted.json",
    "--output", "/private/tmp/private/joined.json",
  ]), {
    local_evidence: "local.json",
    pool_evidence: "pool.json",
    hosted_observation: "hosted.json",
    output: "/private/tmp/private/joined.json",
  });
  for (const option of ["--email", "--token", "--session", "--principal-id", "--role"]) {
    assert.throws(() => parseLocalGateCli([
      "--candidate-sha", CANDIDATE,
      "--evidence-out", "/private/tmp/private/local.json",
      option, "forbidden",
    ]));
    assert.throws(() => parseJoinCli([
      "--local-evidence", "local.json",
      "--pool-evidence", "pool.json",
      "--hosted-observation", "hosted.json",
      "--output", "/private/tmp/private/joined.json",
      option, "forbidden",
    ]));
  }
});

test("local evidence is exact-candidate, fully hashed, and explicitly non-hosted", () => {
  const evidence = localEvidence();
  assert.equal(evidence.hosted_status, "not-run");
  assert.deepEqual(evidence.assertions, passed(RELEASE_03_LOCAL_ASSERTION_IDS));
  assert.deepEqual(verifyRelease03AuthorityTargetLocalEvidence(evidence), evidence);
  const { artifact_sha256: artifact, ...unsigned } = evidence;
  assert.equal(artifact, digest(canonical(unsigned)));

  const forged = structuredClone(evidence);
  forged.hosted_status = "passed";
  assert.throws(
    () => verifyRelease03AuthorityTargetLocalEvidence(forged),
    (error) => error instanceof Release03AuthorityTargetEvidenceError &&
      error.code === "invalid_local_evidence",
  );
});

test("hosted observation requires both web surfaces, all credential cases, and immutable read-back", () => {
  const evidence = hostedObservation();
  assert.deepEqual(verifyRelease03AuthorityTargetHostedObservation(evidence), evidence);
  for (const [expectedCode, mutate] of [
    ["invalid_web_surface_read_back", (input) => input.webSurfaces.pop()],
    ["invalid_credential_cases", (input) => input.credentialCases.pop()],
    ["invalid_immutable_revision_read_back", (input) => {
      input.immutableRevision.fetch_matches_commit = false;
    }],
    ["invalid_cleanup_read_back", (input) => {
      input.cleanup.pool_baseline_unchanged = false;
    }],
  ]) {
    const input = {
      candidateSha: CANDIDATE,
      deploymentId: DEPLOYMENT,
      runFingerprint: `uatauth-run-${"7".repeat(32)}`,
      actorFingerprints: [...ACTORS],
      deploymentReadBack: {
        site_project_id: "appgprj_authorityfixture",
        site_version_id: "appgver_authorityfixture",
        archive_sha256: `sha256:${"8".repeat(64)}`,
      },
      webSurfaces: [
        { id: "oauth-connection", status: "passed" },
        { id: "personal-token-advanced-mcp", status: "passed" },
      ],
      catalogs: {
        modern: catalog("2026-07-28"),
        compatibility: catalog("2025-11-25"),
      },
      credentialCases: passed(RELEASE_03_HOSTED_CREDENTIAL_CASE_IDS),
      authorityCases: passed(RELEASE_03_HOSTED_AUTHORITY_CASE_IDS),
      immutableRevision: {
        commit_status: "committed",
        head_matches_commit: true,
        history_matches_commit: true,
        fetch_matches_commit: true,
        content_sha256: `sha256:${"9".repeat(64)}`,
      },
      cleanup: {
        status: "passed",
        credentials_revoked_next_request_denied: true,
        run_mind_absent: true,
        pool_baseline_unchanged: true,
      },
      observedAtUtc: T1,
    };
    mutate(input);
    assert.throws(
      () => createRelease03AuthorityTargetHostedObservation(input),
      (error) => error instanceof Release03AuthorityTargetEvidenceError &&
        error.code === expectedCode,
    );
  }
});

test("UAT join binds local, pool and hosted evidence to one candidate, deployment and actor pool", () => {
  const joined = createRelease03AuthorityTargetUatJoin({
    localEvidence: localEvidence(),
    poolEvidence: readyPool(),
    hostedObservation: hostedObservation(),
  });
  assert.deepEqual(Object.keys(joined), [
    "status", "candidate_sha", "deployment_id", "runner_id", "actor_fingerprints",
    "assertions", "read_back", "cleanup", "artifact_sha256",
  ]);
  assert.equal(joined.read_back.schema, RELEASE_03_AUTHORITY_TARGET_JOIN_SCHEMA);
  assert.deepEqual(joined.assertions, passed(RELEASE_03_FINAL_ASSERTION_IDS));
  assert.deepEqual(verifyRelease03AuthorityTargetUatJoin(joined), joined);

  assert.throws(
    () => createRelease03AuthorityTargetUatJoin({
      localEvidence: localEvidence(),
      poolEvidence: readyPool(),
      hostedObservation: localEvidence(),
    }),
    (error) => error instanceof Release03AuthorityTargetEvidenceError &&
      error.code === "invalid_join_input_receipt",
  );

  const wrongCandidate = structuredClone(hostedObservation());
  wrongCandidate.candidate_sha = "b".repeat(40);
  assert.throws(
    () => createRelease03AuthorityTargetUatJoin({
      localEvidence: localEvidence(),
      poolEvidence: readyPool(),
      hostedObservation: rehash(wrongCandidate),
    }),
    (error) => error instanceof Release03AuthorityTargetEvidenceError &&
      error.code === "candidate_lineage_mismatch",
  );

  const wrongDeployment = structuredClone(hostedObservation());
  wrongDeployment.deployment_id = "appgdep_otherfixture";
  assert.throws(
    () => createRelease03AuthorityTargetUatJoin({
      localEvidence: localEvidence(),
      poolEvidence: readyPool(),
      hostedObservation: rehash(wrongDeployment),
    }),
    (error) => error instanceof Release03AuthorityTargetEvidenceError &&
      error.code === "deployment_lineage_mismatch",
  );

  const wrongActors = structuredClone(hostedObservation());
  wrongActors.actor_fingerprints.reverse();
  assert.throws(
    () => createRelease03AuthorityTargetUatJoin({
      localEvidence: localEvidence(),
      poolEvidence: readyPool(),
      hostedObservation: rehash(wrongActors),
    }),
    (error) => error instanceof Release03AuthorityTargetEvidenceError &&
      error.code === "actor_pool_lineage_mismatch",
  );
});
