import { deriveAcceptanceApplicability } from "../../scripts/lib/acceptance-applicability.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/performance-fixture.mjs";
import { evaluatePerformanceGate } from "../../scripts/lib/performance-gate.mjs";
import { ACCEPTANCE_COMPONENTS, ACCEPTANCE_ASSERTIONS, ACCEPTANCE_MODEL_CASES, acceptanceDigest, createAcceptanceComponent, verifyAcceptanceComponent, joinAcceptanceSuite } from "../../scripts/lib/acceptance-evidence.mjs";

function prepared() {
  const evaluation = fixture(), report = evaluatePerformanceGate(evaluation);
  const identity = { candidate_sha: evaluation.candidate_sha, project_id: report.deployment.site_project_id, deployment_id: evaluation.deployment_id,
    site_version_id: report.deployment.site_version_id, archive_sha256: report.deployment.archive_sha256.slice(7), common_modules_sha256: "c".repeat(64), test_adapter_sha256: "d".repeat(64) };
  const inventory = { schema: "mind-diary/acceptance-inventory/v2", complete: true, principals: 0, owned_minds: 0, object_count: 0, object_bytes: 0,
    rows: Object.fromEntries(["md_acceptance_actors", "md_acceptance_sessions", "md_acceptance_cleanup_journal", "md_search_documents", "md_search_revision_documents", "md_exact_revision_search", "md_oauth_grants", "md_oauth_access_tokens", "md_oauth_refresh_tokens", "md_oauth_authorization_codes", "md_oauth_authorization_requests"].map(key => [key, 0])) };
  const components = ACCEPTANCE_COMPONENTS.map(kind => createAcceptanceComponent({ kind, status: "passed", identity, runner_sha: "e".repeat(40),
    assertions: Object.fromEntries(ACCEPTANCE_ASSERTIONS[kind].map(name => [name, true])),
    details: kind === "model" ? { package_sha256: "f".repeat(64), cases: [...ACCEPTANCE_MODEL_CASES], compactions: 1, runner_dirty: false }
      : kind === "performance" ? { report, evaluation } : kind === "persistence" ? { previous_deployment_id: "appgdep_previous" } : {},
    cleanup: { status: "baseline_restored", baseline: inventory, final: structuredClone(inventory) }, source_receipts: ["a".repeat(64)] }));
  return { components, manifest: { schema: "mind-diary/acceptance-manifest/v1", identity, runner_sha: "e".repeat(40), package_sha256: "f".repeat(64), component_hashes: Object.fromEntries(components.map(c => [c.kind, c.artifact_sha256])), platform_receipt_hashes: {}, applicability: deriveAcceptanceApplicability({ base_sha: "b".repeat(40), candidate_sha: identity.candidate_sha, scope_identifiers: ["MD-400"], changed_paths: [], provider_configuration_changed: false }) } };
}
function reseal(value) { const { artifact_sha256, ...unsigned } = value; return { ...unsigned, artifact_sha256: acceptanceDigest(unsigned) }; }
test("a complete independently anchored suite joins", () => { const { components, manifest } = prepared(); assert.equal(joinAcceptanceSuite(manifest, components).status, "passed"); });
test("changed candidate, deployment, adapter, package and a missing component fail even with recomputed hashes", () => {
  for (const field of ["candidate_sha", "deployment_id", "common_modules_sha256", "test_adapter_sha256"]) {
    const { components, manifest } = prepared();
    const changed = structuredClone(components[0]); changed.identity[field] = field === "candidate_sha" ? "b".repeat(40) : field === "deployment_id" ? "appgdep_wrong" : "b".repeat(64);
    components[0] = reseal(changed); manifest.component_hashes.product = components[0].artifact_sha256;
    assert.throws(() => joinAcceptanceSuite(manifest, components), /component_identity_mismatch/);
  }
  const { components, manifest } = prepared(); manifest.package_sha256 = "b".repeat(64);
  assert.throws(() => joinAcceptanceSuite(manifest, components), /package_hash_mismatch/);
  assert.throws(() => joinAcceptanceSuite(manifest, components.slice(1)), /component_coverage_missing/);
});
test("missing assertions, dirty model, incomplete inventory and failed cleanup cannot become passed", () => {
  const { components } = prepared();
  for (const change of [c => { delete c.assertions.personal_mode_matrix; }, c => { c.assertions.personal_mode_matrix = false; },
    c => { c.cleanup.final.complete = false; }, c => { c.cleanup.final.rows.md_oauth_grants = 1; }, c => { c.cleanup.status = "failed"; }]) {
    const changed = structuredClone(components[0]); change(changed); assert.throws(() => verifyAcceptanceComponent(reseal(changed)));
  }
  const model = structuredClone(components.find(c => c.kind === "model")); model.details.runner_dirty = true;
  assert.throws(() => verifyAcceptanceComponent(reseal(model)), /model_runner_dirty/);
});
test("forged telemetry fails reevaluation and a replaced valid receipt fails the trusted hash anchor", () => {
  const { components, manifest } = prepared();
  const performance = structuredClone(components.find(c => c.kind === "performance"));
  performance.details.evaluation.server_telemetry[0].benchmarkCorrelationId = "benchmark_forged";
  assert.throws(() => verifyAcceptanceComponent(reseal(performance)), /performance_evaluation_mismatch|invalid_capture_receipt/);
  const replacement = structuredClone(components[0]); replacement.source_receipts = ["b".repeat(64)]; components[0] = reseal(replacement);
  assert.throws(() => joinAcceptanceSuite(manifest, components), /untrusted_component_hash/);
});
