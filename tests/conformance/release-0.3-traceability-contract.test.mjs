import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/release-0.3-traceability/contract.v1.json", root),
  "utf8",
));
const specification = await readFile(
  new URL("docs/specs/release-0.3-traceability.md", root),
  "utf8",
);

function exactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label);
}

function sorted(values) {
  return [...values].sort();
}

function gitBlob(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function evidenceById() {
  return new Map(fixture.evidence.map((row) => [row.id, row]));
}

const expectedEpics = ["MD-329", "MD-330", "MD-331", "MD-332", "MD-333", "MD-334", "MD-335"];
const expectedOwners = [
  "MD-336", "MD-337", "MD-338", "MD-339", "MD-340", "MD-341", "MD-342", "MD-343", "MD-344",
  "MD-345", "MD-346", "MD-347", "MD-348", "MD-349", "MD-350", "MD-351", "MD-352", "MD-353",
  "MD-354", "MD-355", "MD-356", "MD-357", "MD-358", "MD-359", "MD-360", "MD-361", "MD-362",
  "MD-363", "MD-365", "MD-366", "MD-367",
];
const automationSafeDownstream = [
  "MD-290", "MD-311", "MD-317", "MD-319", "MD-344", "MD-347", "MD-351", "MD-354", "MD-358", "MD-363",
];

test("Release 0.3 traceability fixture has a closed scope and policy", () => {
  exactKeys(fixture, [
    "$schema", "version", "release", "status", "source", "sourceEvidence", "scope", "reusedAssets", "policies", "requirements", "evidence",
  ], "top-level traceability contract drifted");
  assert.equal(fixture.$schema, "mind-diary/release-0.3-traceability/v1");
  assert.equal(fixture.version, 1);
  assert.equal(fixture.release, "0.3");
  assert.equal(fixture.status, "accepted_verification_contract_not_runtime_evidence");
  assert.equal(fixture.source, "docs/specs/release-0.3-traceability.md");
  assert.deepEqual(fixture.scope.epics, expectedEpics);
  assert.deepEqual(fixture.scope.requirementOwners, expectedOwners);
  assert.deepEqual(fixture.scope.automationSafeDownstream, automationSafeDownstream);
  assert.deepEqual(fixture.scope.reviewOutcomes, ["pass", "concrete_defect"]);
  assert.deepEqual(fixture.scope.blockerTaxonomy, [
    "service_fault",
    "product_defect",
    "missing_external_capability",
    "credential_role_or_approval",
    "unknown_external_outcome",
    "blocked_by_dependency",
  ]);

  exactKeys(fixture.policies, [
    "maximumHostedActors", "hostedActors", "roleExecution", "browserFiles", "oauthState", "providerState",
    "privateUserData", "routineUserRunStep", "externalPrerequisite", "humanOnlyBoundary", "unknownOutcome",
  ], "policy registry drifted");
  assert.equal(fixture.policies.maximumHostedActors, 3);
  assert.deepEqual(fixture.policies.hostedActors, ["UAT-OPERATOR", "UAT-MIND-ROLE", "UAT-ORDINARY"]);
  assert.equal(fixture.policies.roleExecution, "sequential_over_stable_actor_pool");
  assert.equal(fixture.policies.browserFiles, "generated_per_run_in_private_temp_and_never_user_selected");
  assert.equal(fixture.policies.oauthState, "dedicated_per_run_client_grant_and_token_state");
  assert.equal(fixture.policies.providerState, "restricted_uat_test_state_only");
  assert.equal(fixture.policies.privateUserData, "forbidden");
  assert.equal(fixture.policies.routineUserRunStep, "forbidden");
  assert.deepEqual(fixture.policies.externalPrerequisite, {
    kind: "restricted_uat_session_unlock",
    owner: "external_account_owner",
    allowedAction: "password_mfa_or_passkey_for_existing_restricted_uat_accounts_only",
    resumeSignal: "three_distinct_short_lived_session_references_and_fresh_pool_read_back_are_available",
  });
});

test("export cutover source evidence is hashed and bound to the authority assertion", async () => {
  assert.deepEqual(fixture.sourceEvidence, [
    {
      assertionId: "r03.transfer.web-authority",
      role: "site-export-authority-conformance",
      path: "tests/conformance/import-export-authority-delta.test.mjs",
      gitBlob: "4c55bad74314a681ab8ec36c6b43900b2ac326b7",
    },
    {
      assertionId: "r03.transfer.web-authority",
      role: "mcp-export-cutover-conformance",
      path: "tests/conformance/mcp-export-move.test.mjs",
      gitBlob: "0d68a3a701fab6d747d824fadac5b1f9f5640eec",
    },
  ]);
  const assertionIds = new Set(fixture.requirements.map(({ assertionId }) => assertionId));
  for (const evidence of fixture.sourceEvidence) {
    exactKeys(evidence, ["assertionId", "role", "path", "gitBlob"], evidence.role);
    assert.ok(assertionIds.has(evidence.assertionId), evidence.assertionId);
    const bytes = await readFile(new URL(evidence.path, root));
    assert.equal(gitBlob(bytes), evidence.gitBlob, `${evidence.role} source drifted`);
  }
});

test("MD-237, MD-282, MD-299 and MD-300 reuse points are exact existing sources", async () => {
  assert.deepEqual(fixture.reusedAssets.map((row) => row.owner), ["MD-237", "MD-282", "MD-299", "MD-300"]);
  for (const row of fixture.reusedAssets) {
    exactKeys(row, ["owner", "purpose", "sources"], `${row.owner} reuse row drifted`);
    assert.ok(row.purpose.length > 20, `${row.owner} purpose must be concrete`);
    assert.ok(row.sources.length >= 2, `${row.owner} needs executable or contract sources`);
    for (const source of row.sources) await access(new URL(source, root));
  }
});

test("every requirement has one owner and complete forward traceability", async () => {
  assert.equal(fixture.requirements.length, expectedOwners.length);
  unique(fixture.requirements.map((row) => row.id), "requirement IDs must be unique");
  unique(fixture.requirements.map((row) => row.task), "each owning Task must own one independently reviewable row");
  unique(fixture.requirements.map((row) => row.assertionId), "assertion IDs must be unique");
  assert.deepEqual(sorted(fixture.requirements.map((row) => row.task)), sorted(expectedOwners));
  const evidence = evidenceById();

  for (const row of fixture.requirements) {
    exactKeys(row, [
      "id", "task", "epic", "beneficiaryOutcome", "acceptedDecisions", "domainInvariant", "authorizationBoundary",
      "surfaces", "localEvidence", "hostedEvidence", "assertionId", "readBack", "humanOnlyBoundary",
    ], `${row.id} requirement shape drifted`);
    assert.ok(expectedEpics.includes(row.epic), `${row.id} has unknown epic`);
    assert.ok(row.beneficiaryOutcome.length >= 40, `${row.id} beneficiary outcome is vague`);
    assert.ok(row.domainInvariant.length >= 30, `${row.id} invariant is vague`);
    assert.ok(row.authorizationBoundary.length >= 30, `${row.id} authorization boundary is vague`);
    assert.ok(row.readBack.length >= 30, `${row.id} independent read-back is vague`);
    assert.match(row.assertionId, /^r03\.[a-z0-9.-]+$/);
    exactKeys(row.surfaces, ["rest", "mcp", "ui", "migration"], `${row.id} surface matrix drifted`);
    for (const [surface, disposition] of Object.entries(row.surfaces)) {
      assert.ok(disposition.length >= 10, `${row.id} ${surface} disposition is vague`);
      assert.doesNotMatch(disposition, /\b(?:tbd|todo|manual|ask user)\b/i);
    }
    assert.ok(row.acceptedDecisions.length > 0, `${row.id} needs an accepted decision source`);
    for (const source of row.acceptedDecisions) await access(new URL(source, root));
    assert.equal(evidence.get(row.localEvidence)?.kind, "local", `${row.id} lacks local evidence`);
    assert.equal(evidence.get(row.hostedEvidence)?.kind, "hosted", `${row.id} lacks hosted evidence`);
    assert.ok(evidence.get(row.localEvidence).requirementIds.includes(row.id), `${row.id} local reverse link missing`);
    assert.ok(evidence.get(row.hostedEvidence).requirementIds.includes(row.id), `${row.id} hosted reverse link missing`);
  }
});

test("local evidence rows are exact runnable commands with existing tests and fixtures", async () => {
  const localRows = fixture.evidence.filter((row) => row.kind === "local");
  assert.deepEqual(localRows.map((row) => row.id), ["L-AUTHORITY", "L-SHELL", "L-MINDS", "L-ACCESS", "L-CONNECTIONS", "L-TRANSFER"]);
  for (const row of localRows) {
    exactKeys(row, [
      "id", "kind", "owner", "requirementIds", "command", "testPaths", "fixturePaths", "actors", "setup", "cleanup",
      "recovery", "unknownOutcome", "receiptSchema", "assertionSource", "readBack", "externalPrerequisite",
    ], `${row.id} local evidence shape drifted`);
    assert.match(row.command, /^npm run build --silent && /);
    assert.doesNotMatch(row.command, /<[^>]+>|\b(?:TODO|TBD|manual)\b/i);
    assert.equal(row.externalPrerequisite, "none");
    assert.equal(row.receiptSchema, "mind-diary/local-traceability-evidence/v1");
    assert.equal(row.assertionSource, "requirements.assertionId");
    assert.ok(row.actors.length > 0 && row.actors.length <= 3);
    for (const path of [...row.testPaths, ...row.fixturePaths]) {
      await access(new URL(path, root));
      assert.ok(row.command.includes(path) || row.fixturePaths.includes(path), `${row.id} test is not in exact command`);
    }
    for (const field of ["setup", "cleanup", "recovery", "unknownOutcome"]) {
      assert.ok(row[field].length > 0, `${row.id} ${field} is empty`);
    }
  }
});

test("local transfer evidence proves Site export and both MCP moved-compatibility profiles", () => {
  const transfer = fixture.evidence.find(({ id }) => id === "L-TRANSFER");
  assert.ok(transfer.testPaths.includes("tests/conformance/import-export-authority-delta.test.mjs"));
  assert.ok(transfer.testPaths.includes("tests/conformance/mcp-export-move.test.mjs"));
  assert.match(transfer.readBack, /Site export routes/u);
  assert.match(transfer.readBack, /both MCP catalogs\/moved results/u);

  const authority = fixture.requirements.find(({ id }) => id === "R03-335-AUTHORITY");
  assert.equal(authority.surfaces.rest, "Site import/export job routes");
  assert.equal(authority.surfaces.mcp, "start/get export tools absent");
  assert.equal(
    authority.surfaces.migration,
    "exact cached export calls return moved-to-Site results",
  );
  assert.match(authority.readBack, /both MCP catalogs/u);
  assert.match(authority.readBack, /without export side effects/u);
});

test("hosted evidence rows define exact lineage, receipts, bounded actors and reconciliation", async () => {
  const hostedRows = fixture.evidence.filter((row) => row.kind === "hosted");
  assert.deepEqual(hostedRows.map((row) => row.id), ["U-AUTHORITY", "U-SHELL", "U-MINDS", "U-ACCESS", "U-CONNECTIONS", "U-TRANSFER"]);
  for (const row of hostedRows) {
    exactKeys(row, [
      "id", "kind", "owner", "requirementIds", "runnerId", "runnerInputs", "receiptSchema", "receiptFields", "actors",
      "fixturePaths", "setup", "cleanup", "recovery", "unknownOutcome", "assertionSource", "readBack", "externalPrerequisite",
    ], `${row.id} hosted evidence shape drifted`);
    assert.match(row.runnerId, /^ship-work-release\/uat-release-0\.3-[a-z-]+\/v1$/);
    assert.ok(row.runnerInputs.includes("candidate_sha"));
    assert.ok(row.runnerInputs.includes("deployment_id"));
    assert.ok(row.runnerInputs.includes("pool_readiness_receipt"));
    assert.ok(row.runnerInputs.includes("private_evidence_dir"));
    assert.deepEqual(row.receiptFields, [
      "status", "candidate_sha", "deployment_id", "runner_id", "actor_fingerprints", "assertions", "read_back", "cleanup", "artifact_sha256",
    ]);
    assert.equal(row.assertionSource, "requirements.assertionId");
    assert.equal(row.externalPrerequisite, "policies.externalPrerequisite");
    assert.ok(row.actors.length > 0 && row.actors.length <= fixture.policies.maximumHostedActors);
    assert.equal(new Set(row.actors).size, row.actors.length);
    for (const actor of row.actors) assert.ok(fixture.policies.hostedActors.includes(actor), `${row.id} has non-pool actor`);
    for (const path of row.fixturePaths) await access(new URL(path, root));
    for (const field of ["setup", "cleanup", "recovery", "unknownOutcome"]) {
      assert.ok(row[field].length > 0, `${row.id} ${field} is empty`);
      assert.doesNotMatch(row[field].join(" "), /\b(?:TODO|TBD|ask the user|user acceptance|manual check)\b/i);
    }
    assert.ok(row.unknownOutcome.some((step) => step.includes("unknown_external_outcome")), `${row.id} lacks exact unknown classification`);
  }
});

test("reverse coverage finds no orphan requirement, evidence or assertion row", () => {
  unique(fixture.evidence.map((row) => row.id), "evidence IDs must be unique");
  const requirements = new Map(fixture.requirements.map((row) => [row.id, row]));
  const referencedEvidence = new Set();
  const referencedAssertions = new Set();

  for (const row of fixture.requirements) {
    referencedEvidence.add(row.localEvidence);
    referencedEvidence.add(row.hostedEvidence);
    referencedAssertions.add(row.assertionId);
  }
  assert.deepEqual(sorted(referencedEvidence), sorted(fixture.evidence.map((row) => row.id)), "orphan evidence row");
  assert.deepEqual(sorted(referencedAssertions), sorted(fixture.requirements.map((row) => row.assertionId)), "orphan assertion row");

  for (const evidence of fixture.evidence) {
    unique(evidence.requirementIds, `${evidence.id} reverse requirement IDs must be unique`);
    for (const requirementId of evidence.requirementIds) {
      const requirement = requirements.get(requirementId);
      assert.ok(requirement, `${evidence.id} points to missing requirement ${requirementId}`);
      const expectedEvidence = evidence.kind === "local" ? requirement.localEvidence : requirement.hostedEvidence;
      assert.equal(expectedEvidence, evidence.id, `${evidence.id} reverse link disagrees with ${requirementId}`);
    }
  }
});

test("documentation carries every stable requirement and evidence identifier", () => {
  for (const row of fixture.requirements) {
    assert.ok(specification.includes(`\`${row.id}\``), `spec misses ${row.id}`);
    assert.ok(specification.includes(`\`${row.assertionId}\``), `spec misses ${row.assertionId}`);
  }
  for (const row of fixture.evidence) assert.ok(specification.includes(`\`${row.id}\``), `spec misses ${row.id}`);
  for (const task of automationSafeDownstream) assert.ok(specification.includes(`\`${task}\``), `spec misses automation boundary ${task}`);
});
