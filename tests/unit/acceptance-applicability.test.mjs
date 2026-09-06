import test from "node:test";
import assert from "node:assert/strict";
import { deriveAcceptanceApplicability, verifyAcceptanceApplicability, verifyApplicablePlatformReceipts } from "../../scripts/lib/acceptance-applicability.mjs";
const base = { base_sha: "a".repeat(40), candidate_sha: "b".repeat(40), scope_identifiers: ["MD-400"], changed_paths: ["packages/application-content/src/mind-search.ts"], provider_configuration_changed: false };
test("product-only changes do not claim or require an unchanged platform flow", () => {
  const result = deriveAcceptanceApplicability(base);
  assert.deepEqual(result.required, { sites_identity: false, operator_directory: false, first_user_connection: false });
  assert.equal(verifyApplicablePlatformReceipts(result, [], {}), true);
});
test("identity, directory, OAuth and provider changes activate their real canaries", () => {
  for (const [path, expected] of [["packages/adapter-web/src/sites-identity-binding.ts", "sites_identity"], ["packages/adapter-web/src/operator-directory.ts", "operator_directory"], ["packages/adapter-oauth-sites/src/index.ts", "first_user_connection"]]) {
    assert.equal(deriveAcceptanceApplicability({ ...base, changed_paths: [path] }).required[expected], true);
  }
  assert.equal(Object.values(deriveAcceptanceApplicability({ ...base, provider_configuration_changed: true }).required).every(Boolean), true);
});
test("historical MD-394/399 and missing platform evidence cannot be silently relaxed", () => {
  const result = deriveAcceptanceApplicability({ ...base, scope_identifiers: ["MD-399"] });
  assert.equal(Object.values(result.required).every(Boolean), true);
  assert.throws(() => verifyApplicablePlatformReceipts(result, [], {}), /platform_hash_coverage_missing/);
  result.required.first_user_connection = false;
  assert.throws(() => verifyAcceptanceApplicability(result), /applicability_tampered/);
});
test("a platform pass requires actual surface assertions and its independent receipt hash", async () => {
  const { createHash } = await import("node:crypto");
  const policy = deriveAcceptanceApplicability({ ...base, changed_paths: ["packages/adapter-web/src/sites-identity-binding.ts"] });
  const seal = value => ({ ...value, artifact_sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") });
  const source = { schema: "mind-diary/acceptance-platform-canary/v1", surface: "sites_identity", status: "passed", candidate_sha: base.candidate_sha,
    identity_source: "openai-sites", target_class: "ordinary-uat", deployment_id: "appgdep_actual",
    assertions: { authenticated_sites_context: true, registered_account_readback: true, unauthenticated_denied: true }, source_receipts: ["a".repeat(64)] };
  const receipt = seal(source);
  assert.equal(verifyApplicablePlatformReceipts(policy, [receipt], { sites_identity: receipt.artifact_sha256 }), true);
  for (const changed of [{ ...source, assertions: {} }, { ...source, identity_source: "synthetic" }, { ...source, target_class: "test" }]) {
    const receipt = seal(changed);
    assert.throws(() => verifyApplicablePlatformReceipts(policy, [receipt], { sites_identity: receipt.artifact_sha256 }));
  }
  assert.throws(() => verifyApplicablePlatformReceipts(policy, [receipt], { sites_identity: "b".repeat(64) }), /not_anchored/);
});

test("prospective canaries follow the changed boundary while historical install evidence stays required", () => {
  const oauth = deriveAcceptanceApplicability({ ...base, changed_paths: ["packages/adapter-oauth-sites/src/index.ts"] });
  assert.deepEqual(oauth.required_assertions.first_user_connection, ["cleanup_verified", "read_first_oauth", "refresh_rotation", "revoke_denied"]);
  const plugin = deriveAcceptanceApplicability({ ...base, changed_paths: ["plugins/mind-diary/.mcp.json"] });
  assert.ok(plugin.required_assertions.first_user_connection.includes("fresh_marketplace_install"));
  const historical = deriveAcceptanceApplicability({ ...base, scope_identifiers: ["MD-399"], changed_paths: [] });
  assert.ok(historical.required_assertions.first_user_connection.includes("fresh_marketplace_install"));
});
