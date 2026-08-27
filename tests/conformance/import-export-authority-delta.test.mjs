import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/import-export-authority-delta/contract.v1.json", root),
  "utf8",
));
const specification = await readFile(new URL(fixture.source, root), "utf8");
const webRouting = await readFile(
  new URL("packages/adapter-web/src/product-http-routing.ts", root),
  "utf8",
);
const mcpDefinitions = await readFile(
  new URL("packages/adapter-mcp/src/tool-definitions.ts", root),
  "utf8",
);
const markdownImports = await readFile(
  new URL("packages/application-content/src/markdown-imports.ts", root),
  "utf8",
);
const exportJobs = await readFile(
  new URL("packages/application-content/src/export-jobs.ts", root),
  "utf8",
);
const exportDownloadHttp = await readFile(
  new URL("packages/adapter-web/src/export-download-http.ts", root),
  "utf8",
);

function keys(value) {
  return Object.keys(value).sort();
}

function exactKeys(value, expected, label) {
  assert.deepEqual(keys(value), [...expected].sort(), label);
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label);
}

test("MD-359 fixture is a closed versioned delta register", () => {
  assert.equal(fixture.$schema, "mind-diary/import-export-authority-delta/v1");
  assert.equal(fixture.version, 1);
  assert.equal(fixture.target_release, "0.3");
  assert.match(fixture.observed_candidate, /^[0-9a-f]{40}$/u);
  exactKeys(fixture, [
    "$schema",
    "version",
    "source",
    "observed_candidate",
    "target_release",
    "authority",
    "routes",
    "schemas",
    "policies",
    "state_machines",
    "compatibility",
    "gaps",
    "non_goals",
  ], "top-level delta keys drifted");
  assert.deepEqual(
    fixture.routes.map(({ id }) => id),
    [
      "IM-PLAN",
      "IM-START",
      "IM-BATCH",
      "IM-STATUS",
      "IM-VALIDATE",
      "IM-COMMIT",
      "IM-CANCEL",
      "EX-START",
      "EX-STATUS",
      "EX-DOWNLOAD",
      "EX-COMPLETE",
      "EX-EXPIRY",
    ],
  );
  unique(fixture.routes.map(({ id }) => id), "route IDs must be unique");
  unique(fixture.schemas.map(({ id }) => id), "schema IDs must be unique");
  unique(fixture.gaps.map(({ id }) => id), "gap IDs must be unique");
  for (const route of fixture.routes) {
    exactKeys(route, [
      "id",
      "current",
      "target",
      "disposition",
      "policy",
      "migration_owner",
      "implementation_owner",
    ], `${route.id}: route record drifted`);
    assert.ok(specification.includes(`\`${route.id}\``), route.id);
    assert.ok(specification.includes(route.current), `${route.id}: current route missing from spec`);
    assert.ok(specification.includes(route.target), `${route.id}: target route missing from spec`);
  }
});

test("current routes are observed and target export control routes remain explicit gaps", () => {
  for (const operation of [
    "plan_markdown_import",
    "start_markdown_import",
    "get_markdown_import",
    "stage_markdown_import_batch",
    "validate_markdown_import",
    "commit_markdown_import",
    "cancel_markdown_import",
  ]) assert.ok(webRouting.includes(`operation: "${operation}"`), operation);

  assert.match(mcpDefinitions, /name: "start_export"/u);
  assert.match(mcpDefinitions, /name: "get_export_status"/u);
  assert.ok(exportDownloadHttp.includes("api\\/v1\\/exports"));
  assert.doesNotMatch(webRouting, /operation: "start_export"/u);
  assert.doesNotMatch(webRouting, /operation: "get_export_status"/u);
  assert.doesNotMatch(webRouting, /export-jobs/u);
  assert.ok(
    fixture.gaps.some(({ id }) => id === "GAP-WEB-EXPORT-CONTROL"),
    "missing target routes must remain a declared gap",
  );

  const disposition = new Map(fixture.routes.map((route) => [route.id, route.disposition]));
  assert.equal(disposition.get("EX-START"), "move-and-stub");
  assert.equal(disposition.get("EX-STATUS"), "move-tighten-creator-and-stub");
  assert.equal(disposition.get("EX-DOWNLOAD"), "keep");
  for (const id of ["IM-PLAN", "IM-START", "IM-BATCH", "IM-STATUS", "IM-VALIDATE", "IM-CANCEL"]) {
    assert.equal(disposition.get(id), "keep", id);
  }
  assert.equal(disposition.get("IM-COMMIT"), "keep-clarify-v4");
});

test("import keeps resumable exact-snapshot publication and records actual v4 promotion", () => {
  assert.match(
    markdownImports,
    /createRevisionManifest\(entries, REVISION_MANIFEST_FORMAT_V4\)/u,
  );
  const manifestSchema = fixture.schemas.find(({ id }) => id === "SC-IMPORT-MANIFEST");
  assert.deepEqual(manifestSchema, {
    id: "SC-IMPORT-MANIFEST",
    current: "mind-diary-revision-manifest-v4",
    target: "mind-diary-revision-manifest-v4",
    disposition: "change-normative-doc-from-v3",
  });
  assert.deepEqual(fixture.policies.import.publish_roles, ["editor", "admin", "owner"]);
  assert.equal(fixture.policies.import.actor, "registered-sites-principal");
  assert.equal(fixture.policies.import.status_owner, "creating-principal");
  assert.equal(fixture.policies.import.cancel_after_role_loss, true);
  assert.equal(fixture.policies.import.head_cas, true);
  assert.equal(fixture.policies.import.session_version_cas, true);
  assert.equal(fixture.policies.import.partial_head_visible, false);
  assert.deepEqual(
    fixture.state_machines.markdown_import_session.map(({ state }) => state),
    [
      "active",
      "validating",
      "validated",
      "validation_failed",
      "finalizing",
      "committed",
      "canceled",
      "expired",
    ],
  );
  assert.ok(
    fixture.state_machines.markdown_import_session
      .filter(({ state }) => ["validation_failed", "canceled", "expired"].includes(state))
      .every(({ cutover }) => cutover.includes("closed")),
  );
});

test("export preserves exact-revision jobs, quota/idempotency and object-store transfer", () => {
  assert.match(exportJobs, /operation: "start_export"/u);
  assert.match(exportJobs, /capability: "content:export"/u);
  assert.match(exportJobs, /admitCapacityReservation/u);
  assert.match(exportJobs, /requestedByPrincipalId/u);
  assert.equal(fixture.policies.export.actor, "registered-sites-principal");
  assert.equal(fixture.policies.export.status_owner, "requesting-principal");
  assert.equal(fixture.policies.export.revision, "exact-immutable");
  assert.equal(fixture.policies.export.moves_head, false);
  assert.equal(fixture.policies.export.idempotency_namespace, "start_export");
  assert.equal(fixture.policies.export.archive_transport, "object-storage-short-lived-grant");
  assert.equal(fixture.policies.export.archive_in_json, false);
  assert.equal(fixture.policies.export.archive_in_json_rpc, false);
  assert.deepEqual(
    fixture.state_machines.export_job.map(({ state }) => state),
    ["queued", "running", "succeeded", "failed", "expired"],
  );
  assert.deepEqual(
    fixture.state_machines.export_download_grant.map(({ state }) => state),
    ["active", "revoked", "expired"],
  );
  assert.deepEqual(
    fixture.state_machines.capacity_reservation.map(({ state }) => state),
    ["active", "consumed", "cleanup_pending", "released"],
  );
  assert.deepEqual(fixture.policies.cleanup, {
    max_objects_per_pass: 100,
    max_bytes_per_pass: 268435456,
    max_seconds_per_pass: 20,
    uncertain_reachability_action: "skip-and-retry",
    closed_states_reopen: false,
  });
});

test("MCP cutover is a versioned side-effect-free compatibility result", () => {
  assert.deepEqual(fixture.compatibility.operations, [
    {
      name: "start_export",
      replacement_route: "POST /api/v1/minds/{mind_ref}/exports",
    },
    {
      name: "get_export_status",
      replacement_route: "GET /api/v1/export-jobs/{job_id}",
    },
  ]);
  assert.equal(fixture.compatibility.schema, "mind-diary/mcp-operation-moved/v1");
  assert.equal(fixture.compatibility.error_code, "operation_moved_to_sites");
  assert.equal(fixture.compatibility.is_error, true);
  assert.equal(fixture.compatibility.json_rpc_transport_error, false);
  assert.equal(fixture.compatibility.retryable, false);
  assert.equal(fixture.compatibility.advertised_after_cutover, false);
  assert.deepEqual(fixture.compatibility.profiles, ["2026-07-28", "2025-11-25"]);
  assert.deepEqual(fixture.compatibility.side_effects, {
    target_authorization_reads: 0,
    capacity_reservations: 0,
    idempotency_writes: 0,
    background_jobs: 0,
    head_transitions: 0,
  });
  assert.ok(fixture.compatibility.minimum_uat_releases >= 1);
  assert.ok(fixture.authority.content_mcp_forbids.includes("import_start"));
  assert.ok(fixture.authority.content_mcp_forbids.includes("export_start"));
  assert.ok(fixture.authority.content_mcp_forbids.includes("archive_bytes"));
});

test("the delta does not broaden import, infrastructure or release authority", () => {
  assert.deepEqual(fixture.non_goals, [
    "archive-import",
    "binary-import",
    "drive-sync",
    "provider-specific-connector",
    "aws-deployment",
    "production-release",
    "md-264-redecision",
    "runtime-cutover",
    "uat-evidence",
  ]);
  for (const forbidden of [
    "archive-import",
    "binary-import",
    "drive-sync",
    "aws-deployment",
    "production-release",
  ]) assert.ok(fixture.non_goals.includes(forbidden));
  assert.ok(specification.includes("не утверждает, что перенос routes уже реализован"));
  assert.ok(specification.includes("не выполняет и не объявляет их"));
});
