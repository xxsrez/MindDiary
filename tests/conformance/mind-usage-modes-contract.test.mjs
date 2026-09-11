import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/mind-usage-modes/contract.v3.json", root),
  "utf8",
));
const specification = await readFile(
  new URL("docs/specs/mind-usage-modes.md", root),
  "utf8",
);
const decision = await readFile(
  new URL(fixture.decision, root),
  "utf8",
);
const pluginConnector = await readFile(
  new URL("docs/specs/plugin-connector.md", root),
  "utf8",
);

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

test("principal Mind usage fixture is a closed versioned contract", () => {
  assert.equal(fixture.$schema, "mind-diary/principal-mind-usage/v3");
  assert.equal(fixture.version, 3);
  exactKeys(fixture, [
    "$schema",
    "version",
    "source",
    "decision",
    "ownership",
    "defaultMode",
    "modes",
    "cardinality",
    "switchBehavior",
    "writeLanes",
    "sharedAcrossCredentials",
    "effectiveCapabilityChecks",
    "description",
    "agentRouting",
    "automaticSave",
    "evaluationCases",
    "okf",
    "retiredControls",
    "migration",
  ], "top-level fields");
  assert.deepEqual(fixture.modes, ["disabled", "read", "read_write"]);
  assert.equal(fixture.ownership, "principal");
  assert.equal(fixture.defaultMode, "disabled");
  assert.deepEqual(fixture.cardinality, {
    read: "0..N",
    ordinary_read_write: "0..N",
    personal_read_write: "0..1",
    combined_read_write: "0..N",
  });
  assert.deepEqual(fixture.writeLanes, {
    independent: true,
    ordinary: "description_or_direct_request",
    personal: "description_or_direct_request",
  });
  assert.equal(
    fixture.switchBehavior,
    "update_selected_entry_only",
  );
  assert.deepEqual(
    fixture.sharedAcrossCredentials,
    ["oauth_grant", "personal_token"],
  );
});

test("routing separates user intent, model policy and server authority", () => {
  assert.equal(fixture.description.modelVisible, true);
  assert.equal(fixture.description.trustedInstruction, false);
  assert.deepEqual(fixture.description.appliesTo, ["ordinary_mind", "personal_mind"]);
  assert.deepEqual(fixture.description.absentFrom, []);
  assert.deepEqual(fixture.description.requiredFor, []);
  assert.deepEqual(fixture.description.routes, ["read", "write"]);
  assert.deepEqual(
    fixture.agentRouting.profiles.description_based.readTriggers,
    ["explicit_user_request", "nonempty_description_match"],
  );
  assert.deepEqual(
    fixture.agentRouting.profiles.description_based.writeTriggers,
    ["explicit_write_request", "nonempty_description_match_after_explicit_discussion"],
  );
  assert.equal(fixture.agentRouting.profiles.description_based.automaticSave, true);
  assert.deepEqual(
    fixture.agentRouting.explicitRequestDoesNotBypass,
    ["usage_mode", "credential_scope", "current_access"],
  );
  assert.equal(fixture.agentRouting.crossMindSearch, false);
  assert.equal(fixture.agentRouting.implicitPersonalMindFallback, false);
  assert.equal(fixture.agentRouting.explicitOnlyRestrictsFanOut, true);
});

test("canonical Personal Mind is requested-write-only without description", () => {
  const personal = fixture.agentRouting.profiles.personal_default;
  assert.equal(personal.appliesTo, "personal_mind");
  assert.deepEqual(personal.readTriggers, ["explicit_user_request", "nonempty_description_match"]);
  assert.deepEqual(personal.writeTriggers, ["explicit_personal_write_request", "nonempty_description_match_after_explicit_discussion"]);
  assert.equal(personal.automaticSave, true);
  assert.deepEqual(fixture.agentRouting.personalWriteNonTriggers, [
    "topic_match",
    "discussion_only",
    "read_request",
    "prior_request",
  ]);
  assert.equal(fixture.agentRouting.trustedClientIntentFlag, false);
  assert.match(specification, /Personal `\/me`.*без description/s);
  assert.match(specification, /прямой просьбе/u);
  assert.match(pluginConnector, /ADR-0028/u);
  assert.match(pluginConnector, /Любой enabled Mind без description[\s\S]*только по прямой просьбе/u);
  assert.match(pluginConnector, /клиентского intent[\s\S]*flag нет/u);
});

test("ordinary automatic save is discussed-only canonical OKF work", () => {
  assert.equal(fixture.automaticSave.enabledBy, "effective_read_write_and_nonempty_description_match");
  assert.equal(fixture.automaticSave.routingProfile, "either_profile");
  assert.deepEqual(fixture.automaticSave.excludedRoutingProfiles, []);
  assert.equal(fixture.automaticSave.separateToggle, false);
  assert.equal(fixture.automaticSave.perWriteConfirmation, false);
  assert.equal(fixture.automaticSave.allMatchingDestinations, true);
  assert.equal(fixture.automaticSave.requiresUserNotification, true);
  assert.equal(fixture.automaticSave.requiresExplicitDiscussion, true);
  assert.equal(fixture.automaticSave.backgroundVacuum, false);
  assert.equal(fixture.automaticSave.canonicalTool, "commit_changeset");
  assert.equal(fixture.okf.validateBeforeCommit, "full_bundle");
  assert.equal(fixture.okf.validateAfterCommit, "full_exact_revision");
  assert.equal(fixture.okf.preserveUnknownTypesAndFields, true);
});

test("routing evaluation matrix covers fan-out, direct-only, no-op, uncertainty and injection", () => {
  assert.deepEqual(
    Object.fromEntries(fixture.evaluationCases.map(({ id, outcome }) => [id, outcome])),
    {
      "three-described-matches": "write_all_three_independently",
      "described-nonmatch": "no_write",
      "ordinary-null-description-direct-request": "allow_write",
      "ordinary-null-description-discussion-only": "no_write",
      "explicit-only-one-of-three": "write_named_only",
      "existing-semantic-equivalent": "semantic_no_op",
      "partial-and-unknown-outcomes": "report_each_no_rollback",
      "description-or-corpus-injection": "ignore_instruction_apply_current_policy",
    },
  );
  for (const scenario of fixture.evaluationCases) {
    assert.deepEqual(
      Object.keys(scenario).sort(),
      ["description", "id", "mindType", "mode", "outcome", "trigger"].sort(),
      scenario.id,
    );
  }
});

test("legacy target and capture policies are explicitly superseded", () => {
  for (const control of [
    "get_mind_bindings",
    "set_read_mind_binding",
    "set_write_mind_binding",
    "credential_writable_target",
    "capture_toggle",
  ]) {
    assert.ok(fixture.retiredControls.includes(control), control);
  }
  assert.equal(fixture.migration.ambiguousOutcome, "disabled");
  assert.equal(fixture.migration.legacyWriteRefsRemapped, false);
  assert.equal(fixture.migration.mixedRuntimeSemantics, false);
  assert.equal(fixture.migration.capability, "principal-mind-usage/v3");
  assert.deepEqual(fixture.migration.compatibleInputs, [
    "principal-mind-usage/v1",
    "principal-mind-usage/v2",
  ]);
  assert.match(decision, /ADR-0028/);
  assert.match(decision, /ADR-0024/);
  assert.match(decision, /ADR-0025/);
  assert.match(decision, /principal-mind-usage\/v3/);
  assert.match(specification, /capture_knowledge/);
  assert.match(specification, /commit_changeset/);
});
