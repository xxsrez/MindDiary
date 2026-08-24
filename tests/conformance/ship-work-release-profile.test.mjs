import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const profilePath = resolve(
  repositoryRoot,
  "docs/operations/ship-work-release-profile.md",
);

async function loadProfile() {
  const markdown = await readFile(profilePath, "utf8");
  const match = markdown.match(/~~~yaml\n([\s\S]*?)\n~~~/u);
  assert.ok(match, "the delivery profile must contain a canonical YAML block");
  return parse(match[1]);
}

test("Mind Diary delivery profile resolves the current Task Manager scope", async () => {
  const profile = await loadProfile();
  const taskManagement = profile.task_management;

  assert.equal(profile.profile_revision, 5);
  assert.equal(taskManagement.adapter.id, "task-manager");
  assert.equal(
    taskManagement.adapter.specification,
    "docs/specs/ship-work-release-task-manager-srez.md",
  );
  assert.equal(
    taskManagement.adapter.runtime_reference,
    "docs/operations/ship-work-release-task-manager-srez.md",
  );
  assert.notEqual(
    taskManagement.adapter.specification,
    taskManagement.adapter.runtime_reference,
  );
  assert.equal(taskManagement.provider_instance.id, "task-manager@srez-marketplace");
  assert.equal(taskManagement.provider_instance.id_source, null);
  assert.equal(taskManagement.collection.provider, "task-manager");
  assert.equal(
    taskManagement.collection.id,
    "525e801d-0ae9-4be7-bae4-6a9c8f85f581",
  );
  assert.equal(taskManagement.default_scope.selector, "configured_release");
  assert.equal(
    taskManagement.default_scope.parameters.release_id,
    "e92b681b-fd18-43e2-91df-3538c37d9890",
  );
  assert.equal(taskManagement.scope_fact_projection.mode, "designated_anchor");
  assert.deepEqual(
    {
      provider: taskManagement.scope_fact_projection.target.provider,
      kind: taskManagement.scope_fact_projection.target.kind,
      id: taskManagement.scope_fact_projection.target.id,
    },
    {
      provider: "task-manager",
      kind: "task",
      id: "492adef6-ff53-4244-bf42-c101bb350ade",
    },
  );
  assert.equal(
    taskManagement.scope_fact_projection.marker_schema,
    "ship-work-release/task-manager-scope-fact-comment/v1",
  );
  assert.equal(
    taskManagement.scope_fact_projection.reconcile,
    "exact-effect-id-marker-and-comment-ref",
  );
  for (const bounds of Object.values(taskManagement.pagination.connections)) {
    assert.ok(bounds.page_size > 0 && bounds.page_size <= 50);
    assert.ok(bounds.max_pages > 0);
    assert.ok(bounds.max_records > 0);
  }
  assert.doesNotMatch(JSON.stringify(taskManagement), /\blinear\b/iu);
  assert.equal(profile.uat.smoke_rows.includes("uat.operator-directory-canary"), false);
  assert.equal(profile.uat.smoke_rows.includes("uat.first-user"), false);
  const rowIds = profile.evidence.rows.map(({ id }) => id);
  assert.equal(rowIds.includes("uat.oauth-direct-plugin-canary"), false);
  assert.equal(rowIds.includes("uat.first-user"), false);
  assert.deepEqual(
    rowIds.filter((id) => /bundle|ingress|capacity|connector|generated/u.test(id)),
    [],
  );
  const handoff = profile.evidence.rows.find(({ id }) => id === "handoff.scope-uat-accepted");
  assert.deepEqual(handoff.probe.required_assertion_ids, [
    "operator.three-principal-privacy-exact-deployment",
    "first-user.real-account-exact-deployment",
  ]);
});
