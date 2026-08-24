import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  return { markdown, profile: parse(match[1]) };
}

test("Mind Diary delivery profile resolves exact Task Manager Release 0.1", async () => {
  const { profile } = await loadProfile();
  const taskManagement = profile.task_management;

  assert.equal(profile.profile_revision, 4);
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

  assert.equal(
    taskManagement.provider_instance.id,
    "task-manager@srez-marketplace",
  );
  assert.equal(taskManagement.provider_instance.id_source, null);
  assert.doesNotMatch(JSON.stringify(taskManagement), /appgprj_/u);

  assert.deepEqual(
    {
      provider: taskManagement.collection.provider,
      id: taskManagement.collection.id,
      selector: taskManagement.default_scope.selector,
      releaseId: taskManagement.default_scope.parameters.release_id,
    },
    {
      provider: "task-manager",
      id: "525e801d-0ae9-4be7-bae4-6a9c8f85f581",
      selector: "configured_release",
      releaseId: "e92b681b-fd18-43e2-91df-3538c37d9890",
    },
  );
  assert.doesNotMatch(JSON.stringify(taskManagement), /\blinear\b/iu);
});

test("Task Manager pagination is complete-by-contract and never requests over 50", async () => {
  const { profile } = await loadProfile();
  const connections = profile.task_management.pagination.connections;

  assert.deepEqual(Object.keys(connections).sort(), [
    "project_releases",
    "scope_tasks",
    "status_catalog",
    "subtasks",
    "task_comments",
    "task_relations",
  ]);
  for (const [name, bounds] of Object.entries(connections)) {
    assert.ok(bounds.page_size > 0 && bounds.page_size <= 50, `${name} page_size`);
    assert.ok(bounds.max_pages > 0, `${name} max_pages`);
    assert.ok(bounds.max_records > 0, `${name} max_records`);
  }
  assert.ok(profile.task_management.pagination.request_timeout_seconds > 0);
});

test("Release scope facts use the exact MD-285 superseding comment chain", async () => {
  const { profile } = await loadProfile();
  const projection = profile.task_management.scope_fact_projection;

  assert.equal(projection.mode, "designated_anchor");
  assert.deepEqual(
    { provider: projection.target.provider, kind: projection.target.kind, id: projection.target.id },
    {
      provider: "task-manager",
      kind: "task",
      id: "492adef6-ff53-4244-bf42-c101bb350ade",
    },
  );
  assert.equal(projection.resource_kind, "task-comment");
  assert.equal(
    projection.marker_schema,
    "ship-work-release/task-manager-scope-fact-comment/v1",
  );
  assert.equal(projection.identity_after_create, "exact-comment-ref");
  assert.equal(projection.expected_old, "exact-anchor-version-and-predecessor-comment-ref");
  assert.equal(projection.superseding, "exact-predecessor-comment-ref");
  assert.equal(projection.reconcile, "exact-effect-id-marker-and-comment-ref");
});

test("revision 4 keeps the current file-ingress and UAT evidence rows", async () => {
  const { markdown, profile } = await loadProfile();
  const evidenceRows = new Map(profile.evidence.rows.map((row) => [row.id, row]));

  assert.match(markdown, /MD-271[\s\S]*FI0-Contract/u);
  assert.match(markdown, /Account\/audience\/allowlist setup/u);
  assert.match(markdown, /provider privacy read-back/u);
  assert.ok(evidenceRows.has("dev.synthetic-multi-principal"));
  assert.ok(evidenceRows.has("dev.synthetic-browser"));
  assert.ok(evidenceRows.has("dev.oauth-direct-plugin"));
  assert.ok(evidenceRows.has("uat.multi-principal"));
  assert.ok(evidenceRows.has("uat.operator-directory-canary"));
  assert.ok(evidenceRows.has("uat.oauth-direct-plugin-canary"));
  assert.equal(
    evidenceRows.get("uat.operator-directory-canary").probe.implementation
      .external_cleanup_readback,
    "required-separately-for-md-280",
  );
});

test("adapter specification and runtime reference remain separate and aligned", async () => {
  const [specification, runtimeReference] = await Promise.all([
    readFile(
      resolve(repositoryRoot, "docs/specs/ship-work-release-task-manager-srez.md"),
      "utf8",
    ),
    readFile(
      resolve(repositoryRoot, "docs/operations/ship-work-release-task-manager-srez.md"),
      "utf8",
    ),
  ]);

  for (const document of [specification, runtimeReference]) {
    assert.match(document, /task-manager@srez-marketplace/u);
    assert.doesNotMatch(document, /appgprj_/u);
    assert.match(document, /492adef6-ff53-4244-bf42-c101bb350ade/u);
    assert.match(document, /ship-work-release\/task-manager-scope-fact-comment\/v1/u);
    assert.match(document, /reconcile/iu);
  }
  assert.match(specification, /Статус: accepted project mapping/u);
  assert.match(runtimeReference, /Статус: accepted operational reference/u);
});

test("retired Shipliner runtime and old Linear semantics cannot re-enter the active gate", async () => {
  const retiredPaths = [
    ".agents/skills/ship-linear-release/SKILL.md",
    "docs/specs/ship-linear-release-v1.md",
  ];
  for (const retiredPath of retiredPaths) {
    await assert.rejects(
      access(resolve(repositoryRoot, retiredPath)),
      (error) => error?.code === "ENOENT",
      `${retiredPath} must remain absent`,
    );
  }

  const packageJson = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.scripts["test:orchestration"], undefined);
  assert.doesNotMatch(packageJson.scripts.check, /ship-linear|test:orchestration/iu);

  const tombstone = await readFile(
    resolve(repositoryRoot, "docs/specs/ship-work-release-linear.md"),
    "utf8",
  );
  assert.match(tombstone, /Статус: retired historical tombstone/u);
  assert.match(tombstone, /ship-work-release-task-manager-srez\.md/u);
  assert.match(tombstone, /0009-task-manager-adapters\.md#amendment-2026-08-24/u);
  assert.doesNotMatch(
    tombstone,
    /current_project_milestone|references\/task-manager-linear|task_management\.adapter=linear/iu,
  );
  assert.ok(tombstone.length < 2_500, "the tombstone must not regrow the old full spec");

  const activeDocuments = [
    "AGENTS.md",
    "README.md",
    "docs/operations/ship-work-release-profile.md",
    "docs/operations/ship-work-release.md",
    "docs/specs/ship-work-release.md",
    "docs/specs/ship-work-release-project-profile.md",
    "docs/specs/ship-work-release-task-manager.md",
    "docs/specs/ship-work-release-task-manager-srez.md",
  ];
  for (const documentPath of activeDocuments) {
    const document = await readFile(resolve(repositoryRoot, documentPath), "utf8");
    assert.doesNotMatch(
      document,
      /ship-linear-release|ship-work-release-linear/iu,
      `${documentPath} must not route active delivery to retired contracts`,
    );
  }
});
