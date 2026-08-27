import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const repositoryRoot = fileURLToPath(root);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/import-export-authority-delta/contract.v1.json", root),
  "utf8",
));
const specification = await readFile(new URL(fixture.source, root), "utf8");

const expectedEvidencePaths = [
  "docs/overview.md",
  "docs/architecture.md",
  "docs/specs/api.md",
  "docs/specs/sites-storage-capacity-import.md",
  "packages/adapter-web/src/product-http-routing.ts",
  "packages/adapter-web/src/export-download-http.ts",
  "packages/adapter-mcp/src/tool-definitions.ts",
  "packages/application-content/src/markdown-imports.ts",
  "packages/application-content/src/export-jobs.ts",
  "packages/application-background/src/index.ts",
  "packages/domain/src/records.ts",
  "packages/application-ports/src/revisions.ts",
];

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function candidateBlob(candidate, path) {
  return gitOutput(["show", `${candidate}:${path}`]);
}

function candidateText(path) {
  return candidateBlob(fixture.observed_candidate, path).toString("utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const webRouting = candidateText("packages/adapter-web/src/product-http-routing.ts");
const mcpDefinitions = candidateText("packages/adapter-mcp/src/tool-definitions.ts");
const markdownImports = candidateText("packages/application-content/src/markdown-imports.ts");
const exportJobs = candidateText("packages/application-content/src/export-jobs.ts");
const exportDownloadHttp = candidateText("packages/adapter-web/src/export-download-http.ts");

function keys(value) {
  return Object.keys(value).sort();
}

function exactKeys(value, expected, label) {
  assert.deepEqual(keys(value), [...expected].sort(), label);
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label);
}

function verifyObservedEvidence(candidate, evidence) {
  assert.match(candidate, /^[0-9a-f]{40}$/u, "observed candidate must be a full Git SHA");
  assert.equal(
    gitOutput(["cat-file", "-t", candidate]).toString("utf8").trim(),
    evidence.git_object_type,
    "observed candidate object type drifted",
  );
  exactKeys(evidence, ["git_object_type", "digest_algorithm", "blobs"], "evidence keys drifted");
  assert.equal(evidence.git_object_type, "commit");
  assert.equal(evidence.digest_algorithm, "sha256");
  assert.deepEqual(evidence.blobs.map(({ path }) => path), expectedEvidencePaths);
  unique(evidence.blobs.map(({ path }) => path), "evidence paths must be unique");
  for (const record of evidence.blobs) {
    exactKeys(record, ["path", "sha256"], `${record.path}: evidence tuple drifted`);
    assert.match(record.sha256, /^[0-9a-f]{64}$/u, `${record.path}: invalid digest`);
    assert.equal(
      sha256(candidateBlob(candidate, record.path)),
      record.sha256,
      `${record.path}: observed candidate blob drifted`,
    );
  }
}

test("MD-359 fixture is a closed versioned delta register", () => {
  assert.equal(fixture.$schema, "mind-diary/import-export-authority-delta/v1");
  assert.equal(fixture.version, 1);
  assert.equal(fixture.target_release, "0.3");
  verifyObservedEvidence(fixture.observed_candidate, fixture.evidence);
  exactKeys(fixture, [
    "$schema",
    "version",
    "source",
    "observed_candidate",
    "evidence",
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

test("observed evidence rejects candidate, path, and digest drift", () => {
  const otherCandidate = `${fixture.observed_candidate.slice(0, -1)}${
    fixture.observed_candidate.endsWith("0") ? "1" : "0"
  }`;
  assert.notEqual(otherCandidate, fixture.observed_candidate);
  assert.throws(() => verifyObservedEvidence(otherCandidate, fixture.evidence));

  const pathDrift = structuredClone(fixture.evidence);
  pathDrift.blobs[0].path = `${pathDrift.blobs[0].path}.drift`;
  assert.throws(
    () => verifyObservedEvidence(fixture.observed_candidate, pathDrift),
    /Expected values to be strictly deep-equal/u,
  );

  const digestDrift = structuredClone(fixture.evidence);
  digestDrift.blobs[0].sha256 = "0".repeat(64);
  assert.throws(
    () => verifyObservedEvidence(fixture.observed_candidate, digestDrift),
    /observed candidate blob drifted/u,
  );
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
