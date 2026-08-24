import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  UAT_TEST_ACCOUNT_POOL_RECEIPT_SCHEMA,
  UatTestAccountPoolContractError,
  assessUatTestAccountPoolReadiness,
  createPendingUatTestAccountPoolInventory,
  createUatTestAccountPoolReadinessReceipt,
  validateUatTestAccountPoolInventory,
  verifyUatTestAccountPoolReadinessReceipt,
} from "../../scripts/lib/uat-test-account-pool-contract.mjs";

const T0 = "2026-08-24T10:00:00.000Z";
const SHA = "a".repeat(40);
const DEPLOYMENT = "appgdep_poolfixture";

function readyInventory({ includeDisposable = false } = {}) {
  const inventory = structuredClone(
    createPendingUatTestAccountPoolInventory({ includeDisposable }),
  );
  for (const key of Object.keys(inventory.owner_authority)) {
    inventory.owner_authority[key] = "owner-confirmed";
  }
  inventory.actors.forEach((actor, index) => {
    actor.actor_fingerprint = `actor-${String(index + 1).repeat(16)}`;
    actor.provisioning.external_account = "owner-confirmed";
    actor.provisioning.first_login_mfa = "owner-confirmed";
    actor.provisioning.independent_session = "verified";
  });
  inventory.readback.custom_audience = "exact";
  inventory.readback.operator_allowlist = "exact";
  inventory.readback.distinct_principals = "verified";
  inventory.baseline.temporary_mind_roles = "verified-absent";
  inventory.baseline.per_run_mcp_tokens = "verified-absent";
  return inventory;
}

test("checked-in inventory is the canonical pending, redacted three-actor template", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../fixtures/uat-test-account-pool/pending-inventory.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(fixture, createPendingUatTestAccountPoolInventory());
  assert.deepEqual(
    fixture.actors.map(({ alias }) => alias),
    ["UAT-OPERATOR", "UAT-MIND-ROLE", "UAT-ORDINARY"],
  );
  assert.equal(assessUatTestAccountPoolReadiness(fixture).status, "blocked");
  assert.ok(
    assessUatTestAccountPoolReadiness(fixture).blockers.includes(
      "owner_authority.external_account_provisioning",
    ),
  );
});

test("ready inventory emits a deterministic classification-only receipt", () => {
  const inventory = readyInventory();
  assert.deepEqual(assessUatTestAccountPoolReadiness(inventory), {
    status: "ready",
    blockers: [],
  });
  const receipt = createUatTestAccountPoolReadinessReceipt(inventory, {
    observedAtUtc: T0,
    candidateSha: SHA,
    deploymentId: DEPLOYMENT,
  });
  assert.equal(receipt.schema, UAT_TEST_ACCOUNT_POOL_RECEIPT_SCHEMA);
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.candidate_sha, SHA);
  assert.equal(receipt.deployment_id, DEPLOYMENT);
  assert.equal(receipt.readback.custom_audience_actor_count, 3);
  assert.equal(receipt.readback.operator_actor_count, 1);
  assert.equal(receipt.recovery_policy.per_run_mcp_tokens, "revoke-and-deny-readback");
  assert.match(receipt.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    receipt,
    createUatTestAccountPoolReadinessReceipt(inventory, {
      observedAtUtc: T0,
      candidateSha: SHA,
      deploymentId: DEPLOYMENT,
    }),
  );
  assert.deepEqual(verifyUatTestAccountPoolReadinessReceipt(receipt), receipt);
  const serialized = JSON.stringify(receipt);
  for (const forbidden of ["@", "https://", "mdp_v1_", "principal_", "session_"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("receipt creation fails closed until every owner and read-back boundary passes", () => {
  const cases = [
    ["owner authority", (inventory) => {
      inventory.owner_authority.custom_audience_mutation = "pending-owner-action";
    }],
    ["independent session", (inventory) => {
      inventory.actors[1].provisioning.independent_session = "not-run";
    }],
    ["audience mismatch", (inventory) => {
      inventory.readback.custom_audience = "mismatch";
    }],
    ["operator mismatch", (inventory) => {
      inventory.readback.operator_allowlist = "mismatch";
    }],
    ["distinctness mismatch", (inventory) => {
      inventory.readback.distinct_principals = "mismatch";
    }],
    ["token baseline", (inventory) => {
      inventory.baseline.per_run_mcp_tokens = "not-run";
    }],
  ];
  for (const [name, mutate] of cases) {
    const inventory = readyInventory();
    mutate(inventory);
    assert.equal(
      assessUatTestAccountPoolReadiness(inventory).status,
      "blocked",
      name,
    );
    assert.throws(
      () => createUatTestAccountPoolReadinessReceipt(inventory, {
        observedAtUtc: T0,
        candidateSha: SHA,
        deploymentId: DEPLOYMENT,
      }),
      (error) => error instanceof UatTestAccountPoolContractError &&
        error.code === "pool_not_ready",
      name,
    );
  }
});

test("inventory rejects identity, credential, arbitrary field, and fingerprint leakage", () => {
  const unsafeCases = [
    (inventory) => {
      inventory.actors[0].email = ["person", "example.invalid"].join("@");
    },
    (inventory) => {
      inventory.actors[0].session_ref = "owner-session-reference";
    },
    (inventory) => {
      inventory.actors[0].actor_fingerprint = "actor-derived-from-identity";
    },
    (inventory) => {
      inventory.actors[1].actor_fingerprint = inventory.actors[0].actor_fingerprint;
    },
    (inventory) => {
      inventory.owner_authority.unbounded_policy_mutation = "owner-confirmed";
    },
  ];
  for (const mutate of unsafeCases) {
    const inventory = readyInventory();
    mutate(inventory);
    assert.throws(
      () => validateUatTestAccountPoolInventory(inventory),
      UatTestAccountPoolContractError,
    );
  }
});

test("optional disposable actor remains non-operator and owner-approved", () => {
  const inventory = readyInventory({ includeDisposable: true });
  const disposable = inventory.actors.at(-1);
  assert.equal(disposable.alias, "UAT-DISPOSABLE");
  assert.equal(disposable.lifecycle, "ephemeral-owner-approved");
  assert.equal(disposable.intended_roles.service_operator, "denied");
  assert.equal(disposable.intended_roles.canary_mind_role, "account-lifecycle-only");
  const receipt = createUatTestAccountPoolReadinessReceipt(inventory, {
    observedAtUtc: T0,
    candidateSha: SHA,
    deploymentId: DEPLOYMENT,
  });
  assert.equal(receipt.readback.custom_audience_actor_count, 4);
  assert.equal(receipt.readback.operator_actor_count, 1);
});

test("readiness receipt rejects missing lineage and hash tampering", () => {
  const inventory = readyInventory();
  assert.throws(
    () => createUatTestAccountPoolReadinessReceipt(inventory, {
      observedAtUtc: T0,
      candidateSha: SHA,
    }),
    UatTestAccountPoolContractError,
  );
  const receipt = createUatTestAccountPoolReadinessReceipt(inventory, {
    observedAtUtc: T0,
    candidateSha: SHA,
    deploymentId: DEPLOYMENT,
  });
  assert.throws(
    () => verifyUatTestAccountPoolReadinessReceipt({
      ...receipt,
      artifact_sha256: `sha256:${"0".repeat(64)}`,
    }),
    UatTestAccountPoolContractError,
  );
});

test("runbook keeps provisioning and policy mutation at the owner boundary", async () => {
  const [runbook, index] = await Promise.all([
    readFile(
      new URL("../../docs/operations/uat-test-account-pool.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../docs/README.md", import.meta.url), "utf8"),
  ]);
  for (const required of [
    "UAT-OPERATOR",
    "UAT-MIND-ROLE",
    "UAT-ORDINARY",
    "pending-owner-action",
    "owner authority",
    "exact custom-audience read-back",
    "revoke",
    "recovery",
  ]) assert.ok(runbook.includes(required), required);
  assert.ok(index.includes("operations/uat-test-account-pool.md"));
});
