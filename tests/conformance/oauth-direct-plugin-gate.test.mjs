import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MCP_TOOL_DEFINITIONS } from "../../packages/adapter-mcp/dist/index.js";
import {
  ProbeFailure,
  canonical,
  digest,
} from "../../scripts/lib/multi-principal-probe-core.mjs";
import {
  EXPECTED_D1_SCHEMA_GROUPS,
  FakeD1Database,
} from "../../scripts/lib/fake-sites-storage.mjs";
import {
  CODEX_PLUGIN_MCP_URL,
  CODEX_PLUGIN_OAUTH_RESOURCE,
  OAUTH_DIRECT_PLUGIN_ASSERTION_IDS,
  assertMindUsageSkillPolicy,
  assertCodexCompatibleDefaultWriteCatalog,
  assertCodexCompatibleReadCatalog,
  assertCodexCompatibleVerifiedNativeCatalog,
  assertCodexClientVersion,
  assertDirectPackageServer,
  assertFreshOAuthMcpServerProjection,
  assertMarketplaceCheckoutAvailable,
  createEvidence,
  parseCli,
  parseCodexSkillDiscovery,
  readCodexPromptInput,
} from "../../scripts/run-oauth-direct-plugin-probe.mjs";

const SKILL_DESCRIPTION = "Use Mind Diary through its connected content MCP.";
const SKILL_ROOT = "/private/tmp/fresh/plugins/cache/marketplace";
const INSTALLED_ROOT = "/private/tmp/fresh/plugins/cache/marketplace/mind-diary/version";

test("Codex plugin uses the isolated compatibility transport with the canonical OAuth resource", () => {
  assert.equal(CODEX_PLUGIN_MCP_URL, `${CODEX_PLUGIN_OAUTH_RESOURCE}/2025-11-25`);
  assert.equal(assertDirectPackageServer({
    type: "http",
    url: CODEX_PLUGIN_MCP_URL,
    oauth_resource: CODEX_PLUGIN_OAUTH_RESOURCE,
  }), true);
  for (const server of [
    {
      type: "http",
      url: CODEX_PLUGIN_OAUTH_RESOURCE,
      oauth_resource: CODEX_PLUGIN_OAUTH_RESOURCE,
    },
    {
      type: "http",
      url: CODEX_PLUGIN_MCP_URL,
      oauth_resource: CODEX_PLUGIN_MCP_URL,
    },
  ]) {
    assert.throws(
      () => assertDirectPackageServer(server),
      (error) => error instanceof ProbeFailure && error.code === "direct_resource_mismatch",
    );
  }
});

test("fresh Codex MCP projection identifies an OAuth-capable server without claiming login", () => {
  assert.equal(assertFreshOAuthMcpServerProjection({
    transport: {
      type: "streamable_http",
      url: CODEX_PLUGIN_MCP_URL,
    },
    auth_status: "o_auth",
  }), true);
  for (const server of [
    {
      transport: { type: "streamable_http", url: CODEX_PLUGIN_MCP_URL },
      auth_status: "not_logged_in",
    },
    {
      transport: { type: "streamable_http", url: CODEX_PLUGIN_OAUTH_RESOURCE },
      auth_status: "o_auth",
    },
    {
      transport: { type: "stdio", url: CODEX_PLUGIN_MCP_URL },
      auth_status: "o_auth",
    },
  ]) {
    assert.throws(
      () => assertFreshOAuthMcpServerProjection(server),
      (error) => error instanceof ProbeFailure &&
        error.code === "installed_mcp_resolution_mismatch",
    );
  }
});

test("full schema inventory stays closed while the deployed default catalog omits native staging", () => {
  const current = MCP_TOOL_DEFINITIONS.map(({ name, inputSchema, outputSchema }) => ({
    name,
    inputSchema,
    outputSchema,
  }));
  assert.equal(current.length, 23);
  const nativeIngress = current.find(({ name }) => name === "get_file_ingress_capabilities");
  assert.deepEqual(
    nativeIngress?.outputSchema?.properties?.data?.properties?.native_file_parameter?.required,
    [
      "source_kind",
      "transport",
      "status",
      "route_profile_id",
      "verification_status",
      "host_rewrite_assertion_id",
      "host_rewrite_observed_at_utc",
    ],
  );
  const verifiedNativeCatalog = current.filter(
    ({ name }) => name !== "open_bundle_file_picker",
  );
  assert.equal(verifiedNativeCatalog.length, 22);
  assert.equal(assertCodexCompatibleVerifiedNativeCatalog(verifiedNativeCatalog), true);
  const defaultWriteCatalog = current.filter(({ name }) =>
    name !== "open_bundle_file_picker" && name !== "stage_bundle_file");
  assert.equal(defaultWriteCatalog.length, 21);
  assert.equal(assertCodexCompatibleDefaultWriteCatalog(defaultWriteCatalog), true);
  assert.equal(assertCodexCompatibleReadCatalog(current.filter(
    ({ name }) => name !== "open_bundle_file_picker" &&
      name !== "create_file_upload_intent" &&
      name !== "stage_bundle_file",
  )), true);
  const mismatches = [
    verifiedNativeCatalog.slice(1),
    [...verifiedNativeCatalog, {
      name: "delete_all_minds",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      annotations: { destructiveHint: true },
    }],
    verifiedNativeCatalog.map((tool, index) => index === 0 ? {
      ...structuredClone(tool),
      inputSchema: { ...structuredClone(tool.inputSchema), description: "runtime drift" },
    } : tool),
  ];
  for (const mismatch of mismatches) {
    assert.throws(
      () => assertCodexCompatibleVerifiedNativeCatalog(mismatch),
      (error) => error instanceof ProbeFailure &&
        error.code === "codex_verified_native_catalog_incompatible",
    );
  }
  assert.throws(
    () => assertCodexCompatibleDefaultWriteCatalog(current),
    (error) => error instanceof ProbeFailure &&
      error.code === "codex_default_write_catalog_incompatible",
  );
});

test("OAuth direct-plugin probe never fabricates native-route authority", async () => {
  const source = await readFile(
    new URL("../../scripts/run-oauth-direct-plugin-probe.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /verifiedNativeFileParameterRoute/u);
  assert.doesNotMatch(source, /local-synthetic:oauth-direct-plugin:native-route/u);
  assert.doesNotMatch(source, /\/connections\/\$\{[^}]+\}\/mind-access/u);
  assert.doesNotMatch(source, /target_version|writable_mind/u);
  assert.match(source, /\/api\/v1\/mind-usage/u);
  assert.match(source, /\/api\/v1\/minds\/me\/usage/u);
  assert.match(source, /personal-token\.shared-principal-usage/u);
});

function promptInputFixture(line, roots = []) {
  return [{
    type: "message",
    role: "developer",
    content: [{
      type: "input_text",
      text: `<skills_instructions>\n## Skills\n${roots.join("\n")}\n${line}\n</skills_instructions>`,
    }],
  }];
}

test("OAuth direct-plugin receipt is closed, redacted, and canonically hashed", () => {
  const input = {
    candidate: "a".repeat(40),
    marketplace: {
      head: "b".repeat(40),
      tree: "c".repeat(40),
      pluginVersion: "0.1.0+fixture",
      snapshotSha256: `sha256:${"d".repeat(64)}`,
    },
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:00:01.000Z",
    passed: new Set(OAUTH_DIRECT_PLUGIN_ASSERTION_IDS),
  };
  const receipt = createEvidence(input);
  const { artifact_sha256: artifact, ...unsigned } = receipt;
  assert.equal(artifact, digest(canonical(unsigned)));
  assert.equal(receipt.external_ui_canary.status, "not-run");
  assert.equal(receipt.external_ui_canary.requirement, "informational");
  assert.deepEqual(
    receipt.assertions.map(({ id, status }) => [id, status]),
    OAUTH_DIRECT_PLUGIN_ASSERTION_IDS.map((id) => [id, "passed"]),
  );
  const serialized = JSON.stringify(receipt);
  for (const forbidden of [
    "https://",
    "@synthetic.invalid",
    "mdo_access_",
    "mdo_refresh_",
    "mdo_code_",
    "mdp_v1_",
    "principal_private",
    "space_private",
    "revision_private",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("OAuth direct-plugin UI canary fields are allowed by the release evidence policy", async () => {
  const profile = await readFile(
    new URL("../../docs/operations/ship-work-release-profile.md", import.meta.url),
    "utf8",
  );
  const policy = profile.match(
    /- id: release-evidence-default\n(?<body>[\s\S]*?)\n\s+never_store:/u,
  )?.groups?.body;
  assert.ok(policy, "release-evidence-default policy must exist");
  for (const field of ["external_ui_canary", "requirement", "claim"]) {
    assert.match(policy, new RegExp(`^\\s+- ${field}$`, "mu"));
  }
});

test("Codex prompt-input parser proves the installed skill is model-visible", () => {
  const path = `${INSTALLED_ROOT}/skills/mind-diary/SKILL.md`;
  const line = `- mind-diary:mind-diary: ${SKILL_DESCRIPTION} (file: r7/mind-diary/version/skills/mind-diary/SKILL.md)`;
  assert.deepEqual(
    parseCodexSkillDiscovery(promptInputFixture(line, [`- \`r7\` = \`${SKILL_ROOT}\``]), {
      installedRoot: INSTALLED_ROOT,
      description: SKILL_DESCRIPTION,
    }),
    {
      name: "mind-diary:mind-diary",
      description: SKILL_DESCRIPTION,
      source: "file",
      path,
    },
  );
});

test("installed skill principal-owned Mind usage policy is complete and fail-closed", () => {
  const policy = [
    "Start each relevant workflow with fresh `list_minds`",
    "Personal Mind has `routing_profile=personal_default` and an optional description",
    "When the current user names Personal Mind or asks to read or use My Mind",
    "Otherwise select only the readable Mind or Minds whose descriptions genuinely fit",
    "For Personal Mind without a description, write only when the current user directly asks in this conversation",
    "If both descriptions match, save in both Minds independently",
    "consider every newly discussed piece of durable knowledge for automatic preservation",
    "No extra confirmation is needed for a qualifying save",
    "pass optional `source_references` with the exact enabled source Mind",
    "Fetch a targeted existing Memory before deciding whether the result is a create, update, explicit delete or semantic no-op",
    "Validate the complete proposed OKF 0.2 bundle before commit",
    "call `reconcile_changeset` with the exact original full request",
    "Briefly tell the user what was created, updated or removed",
  ].join("\n");
  assert.equal(assertMindUsageSkillPolicy(policy), true);
  assert.throws(
    () => assertMindUsageSkillPolicy("Use every accessible Mind and save everything."),
    (error) => error instanceof ProbeFailure &&
      error.code === "installed_mind_usage_skill_policy_missing",
  );
  assert.throws(
    () => assertMindUsageSkillPolicy(`${policy}\nwrite_binding_id`),
    (error) => error instanceof ProbeFailure &&
      error.code === "installed_mind_usage_skill_policy_missing",
  );
});

test("Codex prompt-input discovery fails closed for cache-only, wrong-source, and duplicate evidence", () => {
  const expected = {
    installedRoot: INSTALLED_ROOT,
    description: SKILL_DESCRIPTION,
  };
  const exactLine = `- mind-diary:mind-diary: ${SKILL_DESCRIPTION} (file: r7/mind-diary/version/skills/mind-diary/SKILL.md)`;
  const wrongLine = `- mind-diary:mind-diary: ${SKILL_DESCRIPTION} (file: /tmp/untrusted/SKILL.md)`;
  const root = `- \`r7\` = \`${SKILL_ROOT}\``;
  for (const fixture of [
    [{ role: "user", content: [{ type: "input_text", text: `${root}\n${exactLine}` }] }],
    promptInputFixture(wrongLine),
    promptInputFixture(exactLine, ["- `r7` = `/tmp/untrusted`"]),
    promptInputFixture(`${exactLine}\n${exactLine}`, [root]),
    { not: "a prompt input list" },
  ]) {
    assert.throws(
      () => parseCodexSkillDiscovery(fixture, expected),
      (error) => error instanceof ProbeFailure && [
        "installed_skill_not_model_visible",
        "invalid_codex_prompt_input",
      ].includes(error.code),
    );
  }
});

test("Codex client version and prompt-input command availability fail closed", async () => {
  assertCodexClientVersion("codex-cli 0.153.4\n");
  assert.throws(
    () => assertCodexClientVersion("codex-cli 0.153.0\n"),
    (error) => error instanceof ProbeFailure && error.code === "codex_version_mismatch",
  );
  await assert.rejects(
    readCodexPromptInput("/tmp/fresh-codex-home", async () => {
      throw new Error("raw subprocess failure must not escape");
    }),
    (error) => error instanceof ProbeFailure && error.code === "codex_prompt_input_unavailable",
  );
});

test("OAuth direct-plugin CLI exposes no identity, scope, token, route, or runtime switch", () => {
  assert.deepEqual(parseCli([
    "--evidence-out",
    "/tmp/evidence.json",
    "--marketplace-root",
    "/tmp/marketplace",
  ]), {
    evidence_out: "/tmp/evidence.json",
    marketplace_root: "/tmp/marketplace",
  });
  for (const option of [
    "--email",
    "--principal-id",
    "--scope",
    "--token",
    "--route",
    "--enable-oauth-test-user",
  ]) {
    assert.throws(
      () => parseCli(["--evidence-out", "/tmp/evidence.json", option, "value"]),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("missing default Marketplace sibling is an explicit safe precondition blocker", async () => {
  await assert.rejects(
    assertMarketplaceCheckoutAvailable("/private/tmp/missing-marketplace-fixture", {
      statImpl: async () => {
        const error = new Error("fixture missing");
        error.code = "ENOENT";
        throw error;
      },
    }),
    (error) => error instanceof ProbeFailure &&
      error.code === "marketplace_checkout_unavailable" &&
      Object.keys(error.details).length === 0,
  );
});

test("shared Fake D1 fails closed for incomplete and unknown OAuth SQL", async () => {
  const incomplete = new FakeD1Database();
  await incomplete.prepare(EXPECTED_D1_SCHEMA_GROUPS.oauth[0]).run();
  await assert.rejects(
    incomplete
      .prepare("/*md-oauth-client-read*/ SELECT * FROM md_oauth_registered_clients WHERE id = ?")
      .bind("fixture")
      .all(),
    /FakeD1 oauth schema is incomplete/u,
  );

  const complete = new FakeD1Database();
  await complete.batch(EXPECTED_D1_SCHEMA_GROUPS.oauth.map((sql) => complete.prepare(sql)));
  await assert.rejects(
    complete.prepare("/*md-oauth-unknown*/ SELECT 1").all(),
    /unsupported FakeD1 all statement/u,
  );
});
