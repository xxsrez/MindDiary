import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const moduleUrl = pathToFileURL(resolve(
  new URL("../..", import.meta.url).pathname,
  "apps/mind-diary-site/worker/runtime-config.ts",
)).href;

function evaluate(source) {
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `import { readRuntimeConfig } from ${JSON.stringify(moduleUrl)};\n${source}`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const setup = `
  const ORIGIN = "https://mind-diary.example";
  const KEY = "A".repeat(43);
  const SHA = "a".repeat(40);
  const FENCE = "capacity-fence-nonce-01";
  const environment = (overrides = {}) => ({
    MIND_DIARY_PUBLIC_ORIGIN: ORIGIN,
    MIND_DIARY_TOKEN_VERIFIER_KEY: KEY,
    MIND_DIARY_LOCATOR_KEY: KEY,
    MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY: KEY,
    MIND_DIARY_CSRF_KEY: KEY,
    MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "",
    ...overrides,
  });
`;

test("capacity profile is selected only by exact trusted restricted-UAT configuration", () => {
  const result = evaluate(`${setup}
    const active = readRuntimeConfig(new Request(ORIGIN + "/"), environment({
      MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
      MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
      MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
      MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
      MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
    }));
    const defaults = readRuntimeConfig(
      new Request(ORIGIN + "/?capacity_profile=restricted-uat-v1&deployment_posture=restricted-uat"),
      environment(),
    );
    process.stdout.write(JSON.stringify({
      posture: active.deploymentPosture,
      profile: active.capacityProfileId,
      operators: active.serviceOperatorPrincipalIds,
      candidate: active.releaseCandidateSha,
      fence: active.capacityFenceNonce,
      requestCouldSelectProfile: "capacityProfileId" in defaults,
      requestCouldSelectPosture: "deploymentPosture" in defaults,
    }));
  `);
  assert.deepEqual(result, {
    posture: "restricted-uat",
    profile: "restricted-uat-v1",
    operators: ["principal_operator"],
    candidate: "a".repeat(40),
    fence: "capacity-fence-nonce-01",
    requestCouldSelectProfile: false,
    requestCouldSelectPosture: false,
  });
});

test("restricted-UAT capacity profile fails closed on missing, malformed or unallowed posture", () => {
  const result = evaluate(`${setup}
    const invalid = [
      {
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
      },
      {
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_DEPLOYMENT_POSTURE: "production",
        MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
      },
      {
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_DEPLOYMENT_POSTURE: "preview",
        MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
      },
      {
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
        MIND_DIARY_CAPACITY_PROFILE: "custom-1",
        MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
        MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
      },
      {
        MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
        MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
        MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
        MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
      },
      {
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
        MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
        MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
      },
      {
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
        MIND_DIARY_RELEASE_CANDIDATE_SHA: "A".repeat(40),
        MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
      },
      {
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
        MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
        MIND_DIARY_CAPACITY_FENCE_NONCE: "short",
      },
      {
        MIND_DIARY_DEPLOYMENT_POSTURE: "production",
        MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
        MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
      },
    ];
    const rejected = invalid.map((overrides) => {
      try {
        readRuntimeConfig(new Request(ORIGIN + "/"), environment(overrides));
        return false;
      } catch {
        return true;
      }
    });
    process.stdout.write(JSON.stringify(rejected));
  `);
  assert.deepEqual(result, [true, true, true, true, true, true, true, true, true]);
});

test("restricted-UAT posture without an override exposes exact default-profile readback", () => {
  const result = evaluate(`${setup}
    const config = readRuntimeConfig(new Request(ORIGIN + "/"), environment({
      MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
      MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
      MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
      MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
    }));
    process.stdout.write(JSON.stringify({
      posture: config.deploymentPosture,
      profile: config.capacityProfileId,
      candidate: config.releaseCandidateSha,
      fence: config.capacityFenceNonce,
    }));
  `);
  assert.deepEqual(result, {
    posture: "restricted-uat",
    profile: "default-v1",
    candidate: "a".repeat(40),
    fence: "capacity-fence-nonce-01",
  });
});

test("runtime deployment-ID env is neither required nor accepted into capacity configuration", () => {
  const result = evaluate(`${setup}
    const valid = readRuntimeConfig(new Request(ORIGIN + "/"), environment({
      MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
      MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
      MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
      MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
      MIND_DIARY_CAPACITY_FENCE_NONCE: FENCE,
      MIND_DIARY_SITES_DEPLOYMENT_ID: "appgdep_must_not_bind",
      MIND_DIARY_DEPLOYMENT_ID: "appgdep_must_not_bind_either",
    }));
    let legacyCouldSubstitute = true;
    try {
      readRuntimeConfig(new Request(ORIGIN + "/"), environment({
        MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "principal_operator",
        MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
        MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
        MIND_DIARY_RELEASE_CANDIDATE_SHA: SHA,
        MIND_DIARY_SITES_DEPLOYMENT_ID: "appgdep_must_not_bind",
      }));
    } catch {
      legacyCouldSubstitute = false;
    }
    process.stdout.write(JSON.stringify({
      legacyCouldSubstitute,
      projectedDeployment:
        "releaseDeploymentId" in valid ||
        "sitesDeploymentId" in valid ||
        "deploymentId" in valid,
    }));
  `);
  assert.deepEqual(result, {
    legacyCouldSubstitute: false,
    projectedDeployment: false,
  });
});

test("production posture without a profile preserves normal capacity defaults", () => {
  const result = evaluate(`${setup}
    const config = readRuntimeConfig(new Request(ORIGIN + "/"), environment({
      MIND_DIARY_DEPLOYMENT_POSTURE: "production",
    }));
    process.stdout.write(JSON.stringify({
      posture: config.deploymentPosture,
      profileSelected: "capacityProfileId" in config,
    }));
  `);
  assert.deepEqual(result, { posture: "production", profileSelected: false });
});
