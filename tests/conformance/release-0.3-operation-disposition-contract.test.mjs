import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FILE_UPLOAD_INTENT_ROUTE_PREFIX,
  MCP_CONTENT_TOOLS,
  MCP_ENDPOINT,
  MCP_LEGACY_CODEX_ENDPOINT,
  MCP_RETIRED_SITES_ENDPOINT,
  MCP_RESOURCE_CAPABILITIES,
  MCP_TOOL_DEFINITIONS,
} from "../../packages/adapter-mcp/dist/index.js";
import {
  WEB_CONTROL_ROUTES,
} from "../../packages/adapter-web/dist/index.js";
import {
  PRODUCT_UI_ROUTES,
} from "../../packages/adapter-web/dist/product-http-request-helpers.js";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/release-0.3-operation-disposition/contract.v1.json", root),
  "utf8",
));
const specification = await readFile(
  new URL("docs/specs/release-0.3-operation-disposition.md", root),
  "utf8",
);
const modernHandler = await readFile(
  new URL("packages/adapter-mcp/src/http-handler.ts", root),
  "utf8",
);
const compatibilityHandler = await readFile(
  new URL("packages/adapter-mcp/src/legacy-codex.ts", root),
  "utf8",
);
const oauthAdapter = await readFile(
  new URL("packages/adapter-oauth-sites/src/index.ts", root),
  "utf8",
);
const productSite = await readFile(
  new URL("packages/composition-root/src/product-site.ts", root),
  "utf8",
);
const productWebHandler = await readFile(
  new URL("packages/adapter-web/src/product-http-handler.ts", root),
  "utf8",
);
const exportDownloadHandler = await readFile(
  new URL("packages/adapter-web/src/export-download-http.ts", root),
  "utf8",
);
const bundleDownloadHandler = await readFile(
  new URL("packages/adapter-web/src/bundle-file-download-http.ts", root),
  "utf8",
);

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, keys, label) {
  assert.deepEqual(sortedKeys(value), [...keys].sort(), label);
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, label);
}

function canonicalRoute([method, path]) {
  return `${method} ${path}`;
}

const profiles = new Set(Object.keys(fixture.profiles));
const definitions = new Map(MCP_TOOL_DEFINITIONS.map((definition) => [
  definition.name,
  definition,
]));

test("operation-disposition fixture is a closed versioned contract", () => {
  assert.equal(fixture.$schema, "mind-diary/release-0.3-operation-disposition/v1");
  assert.equal(fixture.version, 1);
  assert.equal(fixture.source, "docs/specs/release-0.3-operation-disposition.md");
  assertExactKeys(fixture, [
    "$schema",
    "version",
    "source",
    "authority",
    "profiles",
    "restRoutes",
    "auxiliaryHttpRoutes",
    "uiRoutes",
    "mcpTools",
    "targetMcpCatalog",
    "schemaDiffs",
    "retiredMcpTools",
    "retiredReadErrors",
    "retiredWriteErrors",
    "targetWriteErrors",
    "protocolProfiles",
    "resources",
    "pluginHelp",
    "migrationOwners",
  ], "top-level operation contract drifted");
  assert.deepEqual(fixture.authority, {
    sitesControl: [
      "account",
      "mind_metadata",
      "visibility",
      "membership",
      "ownership",
      "connections",
      "writable_target",
      "credentials",
      "bulk_import",
      "bulk_export",
      "administrative_deletion",
    ],
    contentMcp: [
      "discovery",
      "browse",
      "search",
      "fetch",
      "history",
      "standalone_validation",
      "per_file_ingress",
      "exact_target_content_commit",
    ],
    implicitPersonalMindFallback: false,
    implicitCrossMind: false,
    readBindingRequired: false,
    writableTargetSelectedOn: "sites",
  });
  for (const [name, profile] of Object.entries(fixture.profiles)) {
    assertExactKeys(profile, ["target", "actor", "checks", "errors", "compatibility"], name);
    assertUnique(profile.checks, `${name}: duplicate checks`);
    assertUnique(profile.errors, `${name}: duplicate errors`);
  }
});

test("every exported first-party REST route has exactly one disposition", () => {
  const current = WEB_CONTROL_ROUTES.map(canonicalRoute);
  const registered = fixture.restRoutes.map(({ key }) => key);
  assert.deepEqual(registered, current);
  assertUnique(registered, "REST routes must be unique");
  for (const route of fixture.restRoutes) {
    assertExactKeys(route, ["key", "disposition", "profile", "mindScope", "owner"], route.key);
    assert.ok(profiles.has(route.profile), `${route.key}: unknown profile`);
    assert.ok(["keep", "change", "move", "remove"].includes(route.disposition), route.key);
    assert.match(specification, new RegExp(route.key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), route.key);
  }
  assert.equal(current.length, 41);
});

test("auxiliary capability, delivery, OAuth, MCP, and retired Sites routes are explicit", () => {
  const routes = fixture.auxiliaryHttpRoutes.map(({ key }) => key);
  assertUnique(routes, "auxiliary HTTP routes must be unique");
  assert.deepEqual(routes, [
    "GET /api/v1/internal/operators/users",
    "GET /internal/operators/users",
    "GET /api/v1/exports/{grant}",
    "GET /api/bundle-download/{grant}",
    "GET /api/file-ingress/v1/upload-intents/{capability}",
    "PUT /api/file-ingress/v1/upload-intents/{capability}",
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/api/mcp",
    "GET /.well-known/oauth-authorization-server",
    "GET /.well-known/openid-configuration",
    "POST /oauth/register",
    "GET /oauth/authorize",
    "POST /oauth/authorize",
    "POST /oauth/token",
    "POST /oauth/revoke",
    `POST ${MCP_ENDPOINT}`,
    `POST ${MCP_LEGACY_CODEX_ENDPOINT}`,
    `ANY ${MCP_RETIRED_SITES_ENDPOINT}`,
  ]);
  for (const route of fixture.auxiliaryHttpRoutes) {
    assertExactKeys(route, ["key", "disposition", "profile", "owner"], route.key);
    assert.ok(profiles.has(route.profile), `${route.key}: unknown profile`);
  }
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/oauth/register",
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/revoke",
  ]) assert.ok(oauthAdapter.includes(path), path);
  assert.ok(productWebHandler.includes("/api/v1/internal/operators/users"));
  assert.ok(productWebHandler.includes("/internal/operators/users"));
  assert.ok(exportDownloadHandler.includes("/api\\/v1\\/exports\\/"));
  assert.ok(bundleDownloadHandler.includes("/api\\/bundle-download\\/"));
  assert.equal(FILE_UPLOAD_INTENT_ROUTE_PREFIX, "/api/file-ingress/v1/upload-intents/");
  assert.ok(productSite.includes("MCP_RETIRED_SITES_ENDPOINT"));
  assert.equal(
    fixture.auxiliaryHttpRoutes.find(({ key }) => key === "ANY /mcp")?.disposition,
    "remove",
  );
});

test("UI inventory covers every registered static route and both dynamic route classes", () => {
  const patterns = fixture.uiRoutes.map(({ pattern }) => pattern);
  assertUnique(patterns, "UI routes must be unique");
  assert.deepEqual(
    patterns.filter((pattern) => !pattern.includes("{")),
    [...PRODUCT_UI_ROUTES],
  );
  assert.ok(patterns.includes("/{space_handle}"));
  assert.ok(patterns.includes("/settings/connections/{connection_ref}"));
  for (const route of fixture.uiRoutes) {
    assertExactKeys(route, ["pattern", "disposition", "owner"], route.pattern);
    assert.match(specification, new RegExp(route.pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), route.pattern);
  }
});

test("all current MCP tools have a disposition and the target catalog is exact", () => {
  assert.deepEqual(fixture.mcpTools.map(({ name }) => name), MCP_CONTENT_TOOLS);
  assertUnique(fixture.mcpTools.map(({ name }) => name), "MCP tools must be unique");
  assert.deepEqual(
    fixture.retiredMcpTools,
    [
      "get_mind_bindings",
      "set_read_mind_binding",
      "set_write_mind_binding",
      "start_export",
      "get_export_status",
    ],
  );
  assert.deepEqual(
    fixture.targetMcpCatalog,
    MCP_CONTENT_TOOLS.filter((name) => !fixture.retiredMcpTools.includes(name)),
  );
  assert.equal(fixture.targetMcpCatalog.length, 18);
  for (const tool of fixture.mcpTools) {
    assertExactKeys(tool, ["name", "disposition", "profile", "mindScope", "owner"], tool.name);
    assert.ok(profiles.has(tool.profile), `${tool.name}: unknown profile`);
    assert.match(specification, new RegExp(`\\b${tool.name}\\b`, "u"), tool.name);
  }
  for (const retired of fixture.retiredMcpTools) {
    assert.equal(fixture.targetMcpCatalog.includes(retired), false, retired);
    assert.ok(["move", "remove"].includes(
      fixture.mcpTools.find(({ name }) => name === retired)?.disposition,
    ), retired);
  }
});

test("machine-readable schema diff removes binding fields without removing explicit Mind", () => {
  const toolDiffs = fixture.schemaDiffs.filter(({ removeRequired }) => Array.isArray(removeRequired));
  assert.deepEqual(toolDiffs.map(({ operation }) => operation), [
    "create_file_upload_intent",
    "stage_bundle_file",
    "reconcile_file_stage",
    "commit_changeset",
    "reconcile_changeset",
    "capture_knowledge",
  ]);
  for (const diff of toolDiffs) {
    assertExactKeys(diff, ["operation", "removeRequired", "keepRequired", "addRequired"], diff.operation);
    const currentRequired = definitions.get(diff.operation).inputSchema.required;
    for (const field of diff.removeRequired) {
      assert.ok(currentRequired.includes(field), `${diff.operation}: ${field} is not a current required field`);
    }
    for (const field of diff.keepRequired) {
      assert.ok(currentRequired.includes(field), `${diff.operation}: ${field} is not preserved`);
    }
    const targetRequired = currentRequired
      .filter((field) => !diff.removeRequired.includes(field))
      .concat(diff.addRequired);
    assert.ok(targetRequired.includes("mind"), `${diff.operation}: explicit mind must remain required`);
    assert.equal(targetRequired.includes("write_binding_id"), false, diff.operation);
  }
  const capabilityDiff = fixture.schemaDiffs.find(
    ({ operation }) => operation === "get_file_ingress_capabilities",
  );
  assert.deepEqual(capabilityDiff, {
    operation: "get_file_ingress_capabilities",
    outputRenames: {
      "sources[].requires_write_binding": "sources[].requires_writable_target",
    },
  });
  assert.match(
    JSON.stringify(definitions.get("get_file_ingress_capabilities").outputSchema),
    /requires_write_binding/u,
  );
  const restDiffs = fixture.schemaDiffs.filter(({ operation }) => operation.startsWith("PATCH "));
  assert.equal(restDiffs.length, 2);
  for (const diff of restDiffs) {
    assert.deepEqual(diff.removeEnum, ["attach_read", "detach_read"]);
    assert.deepEqual(diff.keepEnum, ["select_write", "clear_write"]);
    assert.deepEqual(diff.renameFields, {
      expected_binding_version: "expected_target_version",
    });
  }
});

test("binding errors retire cleanly and target errors apply only to write/ingress", () => {
  assert.deepEqual(fixture.retiredReadErrors, ["mind_binding_required"]);
  assert.deepEqual(fixture.retiredWriteErrors, [
    "write_binding_required",
    "write_binding_stale",
    "binding_owner_revoked",
    "binding_state_unavailable",
  ]);
  assert.deepEqual(fixture.targetWriteErrors, [
    "writable_target_required",
    "writable_target_mismatch",
    "writable_target_unavailable",
  ]);
  const retired = new Set([...fixture.retiredReadErrors, ...fixture.retiredWriteErrors]);
  for (const code of fixture.targetWriteErrors) assert.equal(retired.has(code), false, code);
  for (const tool of fixture.mcpTools) {
    if (tool.profile === "content-read") {
      assert.equal(tool.mindScope.includes("selected-target"), false, tool.name);
    }
    if (tool.profile === "content-write" || tool.profile === "content-ingress") {
      assert.match(tool.mindScope, /selected.*target/u, tool.name);
    }
  }
});

test("both MCP protocol profiles and Resources behavior are closed", () => {
  assertExactKeys(fixture.protocolProfiles, ["2026-07-28", "2025-11-25"], "protocol profiles");
  assert.equal(fixture.protocolProfiles["2026-07-28"].endpoint, "/api/mcp");
  assert.equal(fixture.protocolProfiles["2025-11-25"].endpoint, "/api/mcp/2025-11-25");
  for (const method of [
    "server/discover",
    "resources/templates/list",
    "resources/list",
    "resources/read",
    "tools/list",
    "tools/call",
  ]) assert.ok(modernHandler.includes(`\"${method}\"`), method);
  for (const method of [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call",
  ]) assert.ok(compatibilityHandler.includes(`\"${method}\"`), method);
  assert.deepEqual(fixture.resources.modern, MCP_RESOURCE_CAPABILITIES);
  assert.deepEqual(fixture.resources.compatibility, []);
  assert.equal(fixture.resources.implicitHeadFallback, false);
  assert.equal(fixture.resources.bearerUri, false);
});

test("plugin/help migration preserves package transport while removing control aliases", () => {
  assert.deepEqual(fixture.pluginHelp.map(({ surface }) => surface), [
    "marketplace-package",
    "bundled-skill",
    "/help/codex",
    "/help",
    "plugin-label",
  ]);
  const packageRow = fixture.pluginHelp[0];
  assert.ok(packageRow.requirements.includes("transport:/api/mcp/2025-11-25"));
  assert.ok(packageRow.requirements.includes("oauth_resource:/api/mcp"));
  const skill = fixture.pluginHelp[1];
  assert.ok(skill.requirements.includes("explicit_mind"));
  assert.ok(skill.requirements.includes("no_binding_tools"));
  assert.ok(skill.requirements.includes("no_mcp_export"));
  assertExactKeys(fixture.migrationOwners, ["MD-339", "MD-359", "integration-owner"], "migration owners");
});
