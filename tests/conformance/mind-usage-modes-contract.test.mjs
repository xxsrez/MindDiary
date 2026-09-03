import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/mind-usage-modes/contract.v1.json", root),
  "utf8",
));
const specification = await readFile(
  new URL("docs/specs/mind-usage-modes.md", root),
  "utf8",
);
const decision = await readFile(
  new URL("docs/decisions/0024-principal-mind-usage-modes-and-automatic-save.md", root),
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
  assert.equal(fixture.$schema, "mind-diary/principal-mind-usage/v1");
  assert.equal(fixture.version, 1);
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
  assert.equal(fixture.cardinality.read_write, "0..1");
  assert.deepEqual(
    fixture.sharedAcrossCredentials,
    ["oauth_grant", "personal_token"],
  );
});

test("routing separates user intent, model policy and server authority", () => {
  assert.equal(fixture.description.modelVisible, true);
  assert.equal(fixture.description.trustedInstruction, false);
  assert.deepEqual(fixture.description.appliesTo, ["ordinary_mind"]);
  assert.deepEqual(fixture.description.absentFrom, ["personal_mind"]);
  assert.deepEqual(fixture.description.requiredFor, ["ordinary_read_write"]);
  assert.deepEqual(fixture.description.routes, ["read", "write"]);
  assert.deepEqual(
    fixture.agentRouting.profiles.description_based.readTriggers,
    ["explicit_user_request", "description_match"],
  );
  assert.deepEqual(
    fixture.agentRouting.profiles.description_based.writeTriggers,
    ["description_match_after_explicit_discussion"],
  );
  assert.equal(fixture.agentRouting.profiles.description_based.automaticSave, true);
  assert.deepEqual(
    fixture.agentRouting.explicitRequestDoesNotBypass,
    ["usage_mode", "credential_scope", "current_access"],
  );
  assert.equal(fixture.agentRouting.crossMindSearch, false);
  assert.equal(fixture.agentRouting.implicitPersonalMindFallback, false);
});

test("canonical Personal Mind is requested-write-only without description", () => {
  const personal = fixture.agentRouting.profiles.personal_default;
  assert.equal(personal.appliesTo, "personal_mind");
  assert.deepEqual(personal.readTriggers, ["explicit_user_request"]);
  assert.deepEqual(personal.writeTriggers, ["explicit_personal_write_request"]);
  assert.equal(personal.automaticSave, false);
  assert.deepEqual(fixture.agentRouting.personalWriteNonTriggers, [
    "topic_match",
    "discussion_only",
    "read_request",
    "prior_request",
  ]);
  assert.equal(fixture.agentRouting.trustedClientIntentFlag, false);
  assert.match(specification, /Personal `\/me`.*без description/s);
  assert.match(specification, /текущий пользователь прямо просит/s);
  assert.match(pluginConnector, /ни совпадение темы, ни[\s\S]*не запускают write/u);
  assert.match(pluginConnector, /только после прямой просьбы текущего[\s\S]*пользователя/u);
  assert.match(pluginConnector, /клиентского intent[\s\S]*flag нет/u);
});

test("ordinary automatic save is discussed-only canonical OKF work", () => {
  assert.equal(fixture.automaticSave.enabledBy, "ordinary_mind_read_write");
  assert.equal(fixture.automaticSave.routingProfile, "description_based");
  assert.deepEqual(fixture.automaticSave.excludedRoutingProfiles, ["personal_default"]);
  assert.equal(fixture.automaticSave.separateToggle, false);
  assert.equal(fixture.automaticSave.perWriteConfirmation, false);
  assert.equal(fixture.automaticSave.requiresUserNotification, true);
  assert.equal(fixture.automaticSave.requiresExplicitDiscussion, true);
  assert.equal(fixture.automaticSave.backgroundVacuum, false);
  assert.equal(fixture.automaticSave.canonicalTool, "commit_changeset");
  assert.equal(fixture.okf.validateBeforeCommit, "full_bundle");
  assert.equal(fixture.okf.validateAfterCommit, "full_exact_revision");
  assert.equal(fixture.okf.preserveUnknownTypesAndFields, true);
});

test("routing evaluation matrix keeps Personal exception and ordinary guard closed", () => {
  assert.deepEqual(
    Object.fromEntries(fixture.evaluationCases.map(({ id, outcome }) => [id, outcome])),
    {
      "personal-read-write-null-description": "allow",
      "personal-discussion-only-write": "no_write",
      "personal-explicit-requested-write": "allow_write",
      "ordinary-read-write-null-description": "description_required",
      "ordinary-discussed-description-match-write": "allow_write",
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
  assert.match(decision, /ADR-0013/);
  assert.match(decision, /ADR-0014/);
  assert.match(decision, /ADR-0022/);
  assert.match(specification, /capture_knowledge/);
  assert.match(specification, /commit_changeset/);
});
