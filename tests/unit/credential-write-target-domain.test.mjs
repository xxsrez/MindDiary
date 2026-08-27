import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCredentialWriteTarget,
  configureCredentialAutomaticCapture,
  createFreshCredentialWriteTargetState,
  selectCredentialWriteTarget,
  upgradeLegacyCredentialWriteTarget,
} from "@mind-diary/domain";

const T0 = "2026-08-27T12:00:00.000Z";
const T1 = "2026-08-27T12:01:00.000Z";
const OWNER = "grant_property_owner";
const PRINCIPAL = "principal_property_owner";

function fresh(owner = OWNER, principal = PRINCIPAL) {
  return createFreshCredentialWriteTargetState({
    bindingOwnerId: owner,
    principalId: principal,
    credentialKind: "oauth_grant",
    occurredAt: T0,
  });
}

test("fresh credentials have an ACL-derived profile with no target or capture", () => {
  const state = fresh();
  assert.equal(state.contractVersion, "credential-write-target/v1");
  assert.equal(state.lifecycleState, "active");
  assert.equal(state.targetVersion, 0);
  assert.equal(state.activeGeneration, null);
  assert.equal(state.automaticCaptureMode, "disabled");
  assert.equal(state.captureGenerationId, null);
});

test("write-target selection never expands scope or ACL capability", () => {
  for (const hasContentWriteScope of [false, true]) {
    for (const currentRole of [null, "reader", "editor", "admin", "owner"]) {
      const result = selectCredentialWriteTarget(fresh(), {
        principalId: PRINCIPAL,
        spaceId: "space_property_target",
        expectedTargetVersion: 0,
        generationId: `generation_${hasContentWriteScope}_${currentRole}`,
        authority: { hasContentWriteScope, currentRole },
        occurredAt: T1,
      });
      const allowed =
        hasContentWriteScope &&
        (currentRole === "editor" || currentRole === "admin" || currentRole === "owner");
      assert.equal(result.kind === "applied", allowed, `${hasContentWriteScope}/${currentRole}`);
    }
  }
});

test("target switches pin capture to one exact generation and never transfer it", () => {
  const selectedA = selectCredentialWriteTarget(fresh(), {
    principalId: PRINCIPAL,
    spaceId: "space_property_a",
    expectedTargetVersion: 0,
    generationId: "generation_property_a",
    authority: { hasContentWriteScope: true, currentRole: "editor" },
    occurredAt: T1,
  });
  assert.equal(selectedA.kind, "applied");
  const capture = configureCredentialAutomaticCapture(selectedA.state, {
    principalId: PRINCIPAL,
    expectedTargetVersion: 1,
    expectedGenerationId: "generation_property_a",
    mode: "routine_non_sensitive",
    authority: { hasContentWriteScope: true, currentRole: "editor" },
    occurredAt: T1,
  });
  assert.equal(capture.kind, "applied");
  assert.equal(capture.state.captureGenerationId, "generation_property_a");

  const selectedB = selectCredentialWriteTarget(capture.state, {
    principalId: PRINCIPAL,
    spaceId: "space_property_b",
    expectedTargetVersion: 1,
    generationId: "generation_property_b",
    authority: { hasContentWriteScope: true, currentRole: "owner" },
    occurredAt: T1,
  });
  assert.equal(selectedB.kind, "applied");
  assert.equal(selectedB.state.activeGeneration.generationId, "generation_property_b");
  assert.equal(selectedB.state.automaticCaptureMode, "disabled");
  assert.equal(selectedB.state.captureGenerationId, null);

  const staleCapture = configureCredentialAutomaticCapture(selectedB.state, {
    principalId: PRINCIPAL,
    expectedTargetVersion: 2,
    expectedGenerationId: "generation_property_a",
    mode: "routine_non_sensitive",
    authority: { hasContentWriteScope: true, currentRole: "owner" },
    occurredAt: T1,
  });
  assert.equal(staleCapture.kind, "generation_mismatch");

  const cleared = clearCredentialWriteTarget(selectedB.state, {
    principalId: PRINCIPAL,
    expectedTargetVersion: 2,
    occurredAt: T1,
  });
  assert.equal(cleared.kind, "applied");
  assert.equal(cleared.state.activeGeneration, null);
  assert.equal(cleared.state.captureGenerationId, null);
});

test("legacy upgrade preserves only an unambiguous OAuth target under current authority", () => {
  const evidence = {
    bindingOwnerId: OWNER,
    principalId: PRINCIPAL,
    candidateSpaceId: "space_legacy_candidate",
    candidateGeneration: 9,
    unambiguous: true,
    automaticCaptureWasEnabled: true,
    observedAt: T0,
  };
  const upgraded = upgradeLegacyCredentialWriteTarget({
    evidence,
    bindingOwnerId: OWNER,
    principalId: PRINCIPAL,
    credentialKind: "oauth_grant",
    generationId: "generation_v1_replacement",
    authority: { hasContentWriteScope: true, currentRole: "editor" },
    occurredAt: T1,
  });
  assert.equal(upgraded.kind, "applied");
  assert.equal(upgraded.state.activeGeneration.spaceId, "space_legacy_candidate");
  assert.equal(upgraded.state.activeGeneration.generationId, "generation_v1_replacement");
  assert.equal(upgraded.state.activeGeneration.generation, 1);
  assert.equal(upgraded.state.automaticCaptureMode, "disabled");
  assert.equal(upgraded.state.captureGenerationId, null);

  for (const mutation of [
    { ...evidence, unambiguous: false },
    { ...evidence, candidateSpaceId: null },
  ]) {
    const result = upgradeLegacyCredentialWriteTarget({
      evidence: mutation,
      bindingOwnerId: OWNER,
      principalId: PRINCIPAL,
      credentialKind: "oauth_grant",
      generationId: "generation_fail_closed",
      authority: { hasContentWriteScope: true, currentRole: "owner" },
      occurredAt: T1,
    });
    assert.equal(result.kind, "applied");
    assert.equal(result.state.activeGeneration, null);
    assert.equal(result.state.automaticCaptureMode, "disabled");
  }

  assert.equal(
    upgradeLegacyCredentialWriteTarget({
      evidence,
      bindingOwnerId: OWNER,
      principalId: PRINCIPAL,
      credentialKind: "personal_token",
      generationId: "generation_personal_reissue_only",
      authority: { hasContentWriteScope: true, currentRole: "owner" },
      occurredAt: T1,
    }).kind,
    "upgrade_not_supported",
  );
});
