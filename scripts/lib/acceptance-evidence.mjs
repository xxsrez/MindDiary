import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyPerformanceTelemetryCaptureReceipt } from "./performance-telemetry-capture.mjs";
import { evaluatePerformanceGate, verifyPerformanceGateArtifact } from "./performance-gate.mjs";

export const ACCEPTANCE_COMPONENTS = Object.freeze(["product", "browser", "model", "recovery", "persistence", "performance"]);
export const ACCEPTANCE_MODEL_CASES = Object.freeze([
  "null-personal-automatic-read", "described-overlap-read", "explicit-personal-read", "no-topic-match",
  "excluded-nondurable-topic", "description-injection", "personal-to-shared-negative", "overlap-automatic-save",
  "overlap-semantic-noop", "null-personal-explicit-save", "described-personal-read-only", "described-personal-disabled",
  "overlap-unknown-commit", "overlap-partial-write",
]);
export const ACCEPTANCE_ASSERTIONS = Object.freeze({
  product: ["personal_mode_matrix", "credential_scope_narrowing", "metadata_cas", "revision_cas", "history", "okf", "acl_roles", "invitations", "outsider_denied"],
  browser: ["four_contexts", "bootstrap_forms", "token_opt_in", "modern_self_check", "compatibility_self_check", "oauth_pkce", "code_replay_denied", "refresh_rotation", "revoke_denied", "callback_credential_isolation"],
  model: [...ACCEPTANCE_MODEL_CASES, "actual_compaction", "fresh_context", "real_tool_traces", "budget_respected"],
  recovery: ["setup_interruption", "commit_interruption", "cleanup_interruption", "unknown_reconciliation", "overlap", "active_run_preserved", "ttl_expiry", "revoked_session", "service_unavailable", "idempotent_cleanup", "credential_denied"],
  persistence: ["commit_before_redeploy", "distinct_deployment", "same_artifact", "exact_revision_readback", "exact_content_readback"],
  performance: ["real_hosted_samples", "provider_telemetry", "signed_correlation", "starter_small", "small_history", "twenty_warm_samples", "budgets"],
});
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const IDENTITY_KEYS = ["candidate_sha", "project_id", "deployment_id", "site_version_id", "archive_sha256", "common_modules_sha256", "test_adapter_sha256"];
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",")}}`;
  return JSON.stringify(value);
}
export const acceptanceDigest = value => createHash("sha256").update(canonical(value)).digest("hex");
function keys(value, expected, code) { assert.ok(value && typeof value === "object" && !Array.isArray(value), code); assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), code); }
function identity(value) {
  keys(value, IDENTITY_KEYS, "invalid_identity");
  assert.match(value.candidate_sha, SHA);
  assert.match(value.project_id, /^appgprj_[a-z0-9]+$/);
  assert.match(value.deployment_id, /^appgdep_[a-z0-9]+$/);
  assert.match(value.site_version_id, /^(appgprj_[a-z0-9]+~)?appgver_[a-z0-9]+$/);
  for (const name of ["archive_sha256", "common_modules_sha256", "test_adapter_sha256"]) assert.match(value[name], HASH);
}
function cleanup(value) {
  keys(value, ["status", "baseline", "final"], "invalid_cleanup");
  assert.equal(value.status, "baseline_restored", "cleanup_failed");
  for (const inventory of [value.baseline, value.final]) {
    keys(inventory, ["schema", "complete", "principals", "owned_minds", "object_count", "object_bytes", "rows"], "invalid_inventory");
    assert.equal(inventory.schema, "mind-diary/acceptance-inventory/v2");
    assert.equal(inventory.complete, true, "incomplete_inventory");
    for (const count of [inventory.principals, inventory.owned_minds, inventory.object_count, inventory.object_bytes, ...Object.values(inventory.rows)]) assert.ok(Number.isSafeInteger(count) && count >= 0);
    for (const table of ["md_acceptance_actors", "md_acceptance_sessions", "md_acceptance_cleanup_journal", "md_search_documents", "md_search_revision_documents", "md_exact_revision_search", "md_oauth_grants", "md_oauth_access_tokens", "md_oauth_refresh_tokens", "md_oauth_authorization_codes", "md_oauth_authorization_requests"]) assert.ok(Object.hasOwn(inventory.rows, table), "inventory_table_missing");
  }
  assert.equal(canonical(value.baseline), canonical(value.final), "cleanup_inventory_mismatch");
}
export function createAcceptanceComponent(input) {
  const value = { ...input, schema: "mind-diary/acceptance-component/v1" };
  const result = { ...value, artifact_sha256: acceptanceDigest(value) };
  return verifyAcceptanceComponent(result);
}
export function verifyAcceptanceComponent(value) {
  keys(value, ["schema", "kind", "status", "identity", "runner_sha", "assertions", "details", "cleanup", "source_receipts", "artifact_sha256"], "invalid_component");
  assert.equal(value.schema, "mind-diary/acceptance-component/v1");
  assert.ok(ACCEPTANCE_COMPONENTS.includes(value.kind), "unknown_component");
  assert.equal(value.status, "passed", "component_failed");
  identity(value.identity); assert.match(value.runner_sha, SHA);
  keys(value.assertions, ACCEPTANCE_ASSERTIONS[value.kind], "assertion_coverage_missing");
  for (const passed of Object.values(value.assertions)) assert.equal(passed, true, "assertion_failed");
  cleanup(value.cleanup);
  assert.ok(Array.isArray(value.source_receipts) && value.source_receipts.length > 0, "source_receipt_missing");
  for (const hash of value.source_receipts) assert.match(hash, HASH);
  assert.equal(new Set(value.source_receipts).size, value.source_receipts.length, "duplicate_source_receipt");
  if (value.kind === "model") {
    assert.match(value.details.package_sha256, HASH);
    assert.deepEqual([...value.details.cases].sort(), [...ACCEPTANCE_MODEL_CASES].sort(), "model_case_coverage_missing");
    assert.equal(value.details.compactions >= 1, true, "model_compaction_missing");
    assert.equal(value.details.runner_dirty, false, "model_runner_dirty");
  }
  if (value.kind === "persistence") {
    assert.match(value.details.previous_deployment_id, /^appgdep_[a-z0-9]+$/);
    assert.notEqual(value.details.previous_deployment_id, value.identity.deployment_id, "redeploy_missing");
  }
  if (value.kind === "performance") {
    const report = verifyPerformanceGateArtifact(value.details.report);
    verifyPerformanceTelemetryCaptureReceipt(value.details.evaluation.telemetry_capture, value.details.evaluation.server_telemetry.map(event => JSON.stringify(event)).join("\n") + "\n");
    const evaluated = evaluatePerformanceGate(value.details.evaluation);
    assert.equal(canonical(evaluated), canonical(report), "performance_evaluation_mismatch");
    assert.equal(report.status, "passed", "performance_failed");
    assert.equal(report.candidate_sha, value.identity.candidate_sha, "performance_candidate_mismatch");
    assert.equal(report.deployment.deployment_id, value.identity.deployment_id, "performance_deployment_mismatch");
  }
  const { artifact_sha256, ...unsigned } = value;
  assert.equal(artifact_sha256, acceptanceDigest(unsigned), "component_hash_mismatch");
  return value;
}
export function joinAcceptanceSuite(manifest, components) {
  keys(manifest, ["schema", "identity", "runner_sha", "package_sha256", "component_hashes"], "invalid_suite_manifest");
  assert.equal(manifest.schema, "mind-diary/acceptance-manifest/v1");
  identity(manifest.identity); assert.match(manifest.runner_sha, SHA); assert.match(manifest.package_sha256, HASH);
  keys(manifest.component_hashes, ACCEPTANCE_COMPONENTS, "component_hash_coverage_missing");
  assert.equal(components.length, ACCEPTANCE_COMPONENTS.length, "component_coverage_missing");
  assert.deepEqual(components.map(x => x.kind).sort(), [...ACCEPTANCE_COMPONENTS].sort(), "component_coverage_missing");
  for (const component of components) {
    verifyAcceptanceComponent(component);
    assert.equal(canonical(component.identity), canonical(manifest.identity), "component_identity_mismatch");
    assert.equal(component.runner_sha, manifest.runner_sha, "runner_sha_mismatch");
    assert.equal(component.artifact_sha256, manifest.component_hashes[component.kind], "untrusted_component_hash");
    if (component.kind === "model") assert.equal(component.details.package_sha256, manifest.package_sha256, "package_hash_mismatch");
  }
  const result = { schema: "mind-diary/acceptance-suite/v1", status: "passed", identity: manifest.identity,
    runner_sha: manifest.runner_sha, package_sha256: manifest.package_sha256, component_hashes: manifest.component_hashes,
    coverage: [...ACCEPTANCE_COMPONENTS], cleanup: "baseline_restored" };
  return { ...result, artifact_sha256: acceptanceDigest(result) };
}
