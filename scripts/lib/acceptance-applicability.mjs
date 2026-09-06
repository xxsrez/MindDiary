import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export const PLATFORM_ASSERTIONS = Object.freeze({
  sites_identity: ["authenticated_sites_context", "stable_principal_readback", "unauthenticated_denied"],
  operator_directory: ["three_distinct_sites_sessions", "own_account_isolation", "operator_directory_readback", "cleanup_verified"],
  first_user_connection: ["fresh_marketplace_install", "read_first_oauth", "explicit_write_step_up", "independent_write_lanes", "markdown_history_export", "revoke_denied", "cleanup_verified"],
});
const sha = /^[a-f0-9]{40}$/;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function deriveAcceptanceApplicability(input) {
  assert.deepEqual(Object.keys(input).sort(), ["base_sha", "candidate_sha", "scope_identifiers", "changed_paths", "provider_configuration_changed"].sort());
  assert.match(input.base_sha, sha); assert.match(input.candidate_sha, sha);
  assert.ok(Array.isArray(input.scope_identifiers) && input.scope_identifiers.length > 0 && input.scope_identifiers.every(id => /^MD-[1-9]\d*$/.test(id)));
  assert.ok(Array.isArray(input.changed_paths) && input.changed_paths.every(path => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..")));
  assert.equal(typeof input.provider_configuration_changed, "boolean");
  const historical = input.scope_identifiers.some(id => ["MD-394", "MD-399"].includes(id));
  const paths = [...new Set(input.changed_paths)].sort();
  const match = patterns => paths.filter(path => patterns.some(pattern => pattern.test(path)));
  const identity = match([/^packages\/adapter-web\/src\/sites-identity-binding\.ts$/, /^apps\/mind-diary-site\/worker\/(runtime-config\.ts|index\.ts|request-recovery\.js)$/, /^packages\/composition-root\/src\/product-site\.ts$/]);
  const directory = match([/^packages\/application-control\/src\/control-read-and-observability\.ts$/, /^packages\/adapter-metadata-(sites\/src\/index|memory\/src\/revision-metadata-read-store)\.ts$/, /^packages\/adapter-web\/src\/.*operator/, /^packages\/adapter-metadata-sites\/src\/.*operator/]);
  const firstUser = match([/^plugins\//, /^\.codex-plugin\//, /^packages\/adapter-oauth-sites\//, /^packages\/adapter-web\/(src\/(connections|token-management)|assets\/product-ui-client)/]);
  const required = {
    sites_identity: historical || input.provider_configuration_changed || identity.length > 0,
    operator_directory: historical || input.provider_configuration_changed || directory.length > 0,
    first_user_connection: historical || input.provider_configuration_changed || firstUser.length > 0,
  };
  const value = { schema: "mind-diary/acceptance-applicability/v1", policy: historical ? "historical-contract-preserved" : "autonomous-v1",
    base_sha: input.base_sha, candidate_sha: input.candidate_sha, scope_identifiers: [...new Set(input.scope_identifiers)].sort(),
    changed_paths: paths, provider_configuration_changed: input.provider_configuration_changed, required,
    reasons: { sites_identity: identity, operator_directory: directory, first_user_connection: firstUser } };
  return { ...value, artifact_sha256: hash(value) };
}
export function verifyAcceptanceApplicability(value) {
  const recreated = deriveAcceptanceApplicability({ base_sha: value.base_sha, candidate_sha: value.candidate_sha, scope_identifiers: value.scope_identifiers,
    changed_paths: value.changed_paths, provider_configuration_changed: value.provider_configuration_changed });
  assert.deepEqual(value, recreated, "applicability_tampered"); return recreated;
}
export function verifyApplicablePlatformReceipts(applicability, receipts, expectedHashes) {
  const policy = verifyAcceptanceApplicability(applicability);
  assert.ok(Array.isArray(receipts));
  const required = Object.keys(policy.required).filter(key => policy.required[key]).sort();
  assert.deepEqual(Object.keys(expectedHashes).sort(), required, "platform_hash_coverage_missing");
  assert.deepEqual(receipts.map(r => r.surface).sort(), required, "platform_receipt_coverage_missing");
  for (const receipt of receipts) {
    assert.equal(receipt.schema, "mind-diary/acceptance-platform-canary/v1");
    assert.equal(receipt.status, "passed", "platform_canary_failed");
    assert.deepEqual(Object.keys(receipt.assertions ?? {}).sort(), [...PLATFORM_ASSERTIONS[receipt.surface]].sort(), "platform_assertion_coverage_missing");
    assert.ok(Object.values(receipt.assertions).every(value => value === true), "platform_assertion_failed");
    assert.equal(receipt.candidate_sha, policy.candidate_sha, "platform_candidate_mismatch");
    assert.equal(receipt.identity_source, "openai-sites", "synthetic_identity_is_not_platform_proof");
    assert.equal(receipt.target_class, "ordinary-uat", "test_target_is_not_platform_proof");
    assert.match(receipt.deployment_id, /^appgdep_[a-z0-9]+$/);
    assert.ok(Array.isArray(receipt.source_receipts) && receipt.source_receipts.length > 0 && receipt.source_receipts.every(h => /^[a-f0-9]{64}$/.test(h)));
    const { artifact_sha256, ...unsigned } = receipt;
    assert.equal(artifact_sha256, hash(unsigned), "platform_receipt_hash_mismatch");
    assert.equal(artifact_sha256, expectedHashes[receipt.surface], "platform_receipt_not_anchored");
  }
  return true;
}
