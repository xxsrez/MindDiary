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

  assert.equal(profile.profile_revision, 3);
  assert.equal(taskManagement.adapter.id, "task-manager");
  assert.equal(
    taskManagement.adapter.specification,
    "docs/specs/ship-work-release-task-manager-srez.md",
  );
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
  assert.equal(taskManagement.scope_fact_projection.mode, "unavailable");
  assert.doesNotMatch(JSON.stringify(taskManagement), /\blinear\b/iu);
});
