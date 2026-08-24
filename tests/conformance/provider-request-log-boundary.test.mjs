import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APPLICATION_BOUNDARY_CLASSIFICATIONS,
  PROVIDER_BOUNDARY_CLASSIFICATIONS,
  ProviderRequestLogBoundaryError,
  createProviderRequestLogBoundaryReceipt,
  verifyProviderRequestLogBoundaryReceipt,
} from "../../scripts/lib/provider-request-log-boundary.mjs";

const FIXTURE_URL = new URL("../fixtures/provider-request-log-boundary.json", import.meta.url);
const EVIDENCE = Object.freeze({
  locator: "provider-control:fixture/classification",
  sha256: `sha256:${"f".repeat(64)}`,
});

async function fixture() {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

test("provider boundary fixture is deterministic, classification-only and explicitly unknown", async () => {
  const receipt = verifyProviderRequestLogBoundaryReceipt(await fixture());
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.authority.status, "required");
  assert.deepEqual(
    receipt.application_evidence.map(({ classification }) => classification),
    APPLICATION_BOUNDARY_CLASSIFICATIONS,
  );
  assert.deepEqual(
    receipt.provider_evidence.map(({ classification }) => classification),
    PROVIDER_BOUNDARY_CLASSIFICATIONS,
  );
  assert.ok(receipt.provider_evidence.every(({ status, evidence }) =>
    status === "unknown" && evidence === null));
});

test("provider facts cannot be accepted without explicit authority evidence", async () => {
  const source = await fixture();
  const providerEvidence = source.provider_evidence.map((entry) => ({
    ...entry,
    status: "accepted_boundary",
    evidence: EVIDENCE,
  }));
  const stillUnknown = createProviderRequestLogBoundaryReceipt({
    candidate_sha: source.candidate_sha,
    deployment: source.deployment,
    observed_at_utc: source.observed_at_utc,
    application_evidence: source.application_evidence,
    provider_evidence: providerEvidence,
    authority: { status: "required", evidence: null },
  });
  assert.equal(stillUnknown.status, "unknown");

  const accepted = createProviderRequestLogBoundaryReceipt({
    candidate_sha: source.candidate_sha,
    deployment: source.deployment,
    observed_at_utc: source.observed_at_utc,
    application_evidence: source.application_evidence,
    provider_evidence: providerEvidence,
    authority: { status: "recorded", evidence: EVIDENCE },
  });
  assert.equal(accepted.status, "accepted_boundary");
});

test("not-available controls remain non-success until the boundary is explicitly accepted", async () => {
  const source = await fixture();
  const unavailable = source.provider_evidence.map((entry) => ({
    ...entry,
    status: "not_available",
    evidence: EVIDENCE,
  }));
  const pending = createProviderRequestLogBoundaryReceipt({
    candidate_sha: source.candidate_sha,
    deployment: source.deployment,
    observed_at_utc: source.observed_at_utc,
    application_evidence: source.application_evidence,
    provider_evidence: unavailable,
    authority: { status: "required", evidence: null },
  });
  assert.equal(pending.status, "not_available");
});

test("receipt rejects raw request values, arbitrary locators and unclassified fields without echoing them", async () => {
  const source = await fixture();
  const privateValues = [
    "person.private@example.invalid",
    "198.51.100.73",
    "PrivateClient/9.9",
    "/me/private-memory?query=secret",
    `Bearer ${"x".repeat(48)}`,
    "https://objects.example.invalid/private?signature=secret",
  ];
  for (const [key, value] of [
    ["verified_email", privateValues[0]],
    ["source_address", privateValues[1]],
    ["client_software", privateValues[2]],
    ["request_path", privateValues[3]],
    ["authorization", privateValues[4]],
    ["signed_url", privateValues[5]],
  ]) {
    assert.throws(
      () => createProviderRequestLogBoundaryReceipt({
        candidate_sha: source.candidate_sha,
        deployment: source.deployment,
        observed_at_utc: source.observed_at_utc,
        application_evidence: source.application_evidence,
        provider_evidence: source.provider_evidence,
        authority: source.authority,
        [key]: value,
      }),
      (error) => error instanceof ProviderRequestLogBoundaryError &&
        privateValues.every((privateValue) => !error.message.includes(privateValue)),
    );
  }
  assert.throws(
    () => createProviderRequestLogBoundaryReceipt({
      candidate_sha: source.candidate_sha,
      deployment: source.deployment,
      observed_at_utc: source.observed_at_utc,
      application_evidence: source.application_evidence.map((entry, index) =>
        index === 0
          ? { ...entry, evidence: { locator: privateValues[5], sha256: EVIDENCE.sha256 } }
          : entry),
      provider_evidence: source.provider_evidence,
      authority: source.authority,
    }),
    (error) => error instanceof ProviderRequestLogBoundaryError,
  );
});

test("receipt fails closed on failed application or provider evidence and hash tampering", async () => {
  const source = await fixture();
  const applicationFailed = createProviderRequestLogBoundaryReceipt({
    candidate_sha: source.candidate_sha,
    deployment: source.deployment,
    observed_at_utc: source.observed_at_utc,
    application_evidence: source.application_evidence.map((entry, index) =>
      index === 0 ? { ...entry, status: "failed" } : entry),
    provider_evidence: source.provider_evidence,
    authority: source.authority,
  });
  assert.equal(applicationFailed.status, "failed");

  const providerFailed = createProviderRequestLogBoundaryReceipt({
    candidate_sha: source.candidate_sha,
    deployment: source.deployment,
    observed_at_utc: source.observed_at_utc,
    application_evidence: source.application_evidence,
    provider_evidence: source.provider_evidence.map((entry, index) =>
      index === 0 ? { ...entry, status: "failed", evidence: EVIDENCE } : entry),
    authority: source.authority,
  });
  assert.equal(providerFailed.status, "failed");

  await assert.rejects(
    Promise.resolve().then(() => verifyProviderRequestLogBoundaryReceipt({
      ...source,
      artifact_sha256: `sha256:${"0".repeat(64)}`,
    })),
    (error) => error instanceof ProviderRequestLogBoundaryError,
  );
});
