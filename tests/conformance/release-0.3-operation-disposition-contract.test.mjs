import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  MindBrowseFailure,
  MindBrowseService,
  exactRevisionResourceUri,
} from "../../packages/application-content/dist/index.js";
import {
  FILE_UPLOAD_INTENT_ROUTE_PREFIX,
  MCP_CONTENT_TOOLS,
  MCP_ENDPOINT,
  MCP_MOVED_EXPORT_TOOLS,
  MCP_RETIRED_BINDING_TOOLS,
  MCP_RETIRED_CAPTURE_TOOLS,
  MCP_RETIRED_SITES_ENDPOINT,
  MCP_RESOURCE_CAPABILITIES,
  MCP_TOOL_DEFINITIONS,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";
import { WEB_CONTROL_ROUTES } from "../../packages/adapter-web/dist/index.js";
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

function gitBlob(bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

const buildPairs = [
  ["packages/adapter-mcp/src/http-handler.ts", "packages/adapter-mcp/dist/http-handler.js"],
  ["packages/adapter-mcp/src/tool-definitions.ts", "packages/adapter-mcp/dist/tool-definitions.js"],
  ["packages/adapter-web/src/index.ts", "packages/adapter-web/dist/index.js"],
  ["packages/adapter-web/src/product-http-handler.ts", "packages/adapter-web/dist/product-http-handler.js"],
  ["packages/adapter-web/src/product-http-request-helpers.ts", "packages/adapter-web/dist/product-http-request-helpers.js"],
  ["packages/application-content/src/mind-browse.ts", "packages/application-content/dist/mind-browse.js"],
];

function contractActor() {
  return Object.freeze({
    kind: "registered_principal",
    principalId: "principal_operation_contract",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: "token_operation_contract",
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: Object.freeze(["content:read", "content:write"]),
    requestId: "request_operation_contract",
    occurredAtUtc: "2026-08-27T00:00:00.000Z",
  });
}

function protocolHarness() {
  let requestId = 0;
  const actor = contractActor();
  const dependencies = {
    authenticator: {
      async authenticate(token) {
        return token === "contract-token"
          ? { kind: "authenticated", actor }
          : { kind: "invalid" };
      },
    },
    requestIds: { nextRequestId: () => `request_operation_protocol_${++requestId}` },
    content: {
      async listTools() {
        return MCP_TOOL_DEFINITIONS;
      },
      async listRootResources() {
        return {
          resources: [{
            uri: "okf://spaces/space_contract/revisions/revision_contract/index",
            name: "Contract Mind",
            title: "Contract Mind",
            mimeType: "text/markdown; charset=utf-8",
          }],
          nextCursor: null,
        };
      },
      async readResource({ uri }) {
        return {
          uri,
          mimeType: "text/markdown; charset=utf-8",
          text: "# Contract\n",
          entry: {},
        };
      },
      async authorizeToolCall() {
        return { kind: "allowed" };
      },
      async executeToolCall() {
        return {
          resultType: "complete",
          structuredContent: { ok: true, data: {} },
          isError: false,
        };
      },
    },
  };
  const modern = createMcpHttpHandler(dependencies);
  const protocolMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "operation-contract", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  async function sendModern(method) {
    const params = {
      ...(method === "resources/read"
        ? { uri: "okf://spaces/space_contract/revisions/revision_contract/index" }
        : {}),
      ...(method === "tools/call" ? { name: "list_minds", arguments: {} } : {}),
      _meta: protocolMeta,
    };
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: "Bearer contract-token",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(method === "resources/read" ? { "mcp-name": params.uri } : {}),
      ...(method === "tools/call" ? { "mcp-name": params.name } : {}),
    };
    return modern(new Request("https://mind-diary.invalid/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }));
  }

  return { sendModern };
}

const profiles = new Set(Object.keys(fixture.profiles));
const definitions = new Map(MCP_TOOL_DEFINITIONS.map((definition) => [
  definition.name,
  definition,
]));

test("compiled imports are fresh relative to every contract source", async () => {
  for (const [sourcePath, outputPath] of buildPairs) {
    const [source, output] = await Promise.all([
      stat(new URL(sourcePath, root)),
      stat(new URL(outputPath, root)),
    ]);
    assert.ok(
      output.mtimeMs >= source.mtimeMs,
      `${outputPath} is older than ${sourcePath}; run npm run build immediately before this test`,
    );
  }
});

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
    "credentialAccessCompatibility",
    "principalMindUsage",
    "restRoutes",
    "auxiliaryHttpRoutes",
    "uiRoutes",
    "mcpTools",
    "targetMcpCatalog",
    "schemaDiffs",
    "retiredMcpTools",
    "retiredMcpCompatibility",
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
      "mind_usage",
      "visibility",
      "membership",
      "ownership",
      "connections",
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
    writableMindSelectedOn: "principal_mind_usage_on_sites",
  });
  for (const [name, profile] of Object.entries(fixture.profiles)) {
    assertExactKeys(profile, ["target", "actor", "checks", "errors", "compatibility"], name);
    assertUnique(profile.checks, `${name}: duplicate checks`);
    assertUnique(profile.errors, `${name}: duplicate errors`);
  }
});

test("principal Mind usage exposes one three-mode CAS and independent write lanes", () => {
  assert.deepEqual(fixture.profiles["mind-usage-control"].checks, [
    "sites_identity",
    "principal_owned_settings",
    "current_acl",
    "usage_version_cas",
    "singleton_read_write",
    "idempotency",
  ]);
  assert.deepEqual(fixture.principalMindUsage.implementedRuntime, {
    inputVersionField: "expected_usage_version",
    modeEnum: ["disabled", "read", "read_write"],
    scope: "principal",
    singleWritable: true,
    staleExpectedVersion: {
      httpStatus: 409,
      code: "usage_version_conflict",
      stateChange: "none",
      metadataDisclosure: "none",
    },
  });
  assert.equal(fixture.principalMindUsage.runtimeStatus, "principal-usage-implemented");
  assert.deepEqual(fixture.principalMindUsage.read_write.checks, [
    "current_read_access",
    "current_writer_role",
    "authorized_routing_profile",
    "expected_usage_version",
    "idempotency",
  ]);
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
  assert.equal(current.length, 44);
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
  assert.deepEqual(fixture.targetMcpCatalog, MCP_CONTENT_TOOLS);
  assert.deepEqual([...MCP_MOVED_EXPORT_TOOLS], ["start_export", "get_export_status"]);
  assert.deepEqual(
    [...MCP_RETIRED_BINDING_TOOLS],
    ["get_mind_bindings", "set_read_mind_binding", "set_write_mind_binding"],
  );
  assertUnique(fixture.mcpTools.map(({ name }) => name), "MCP tools must be unique");
  assert.deepEqual(
    fixture.retiredMcpTools,
    [
      "get_mind_bindings",
      "set_read_mind_binding",
      "set_write_mind_binding",
      "capture_knowledge",
      "start_export",
      "get_export_status",
    ],
  );
  assert.equal(fixture.targetMcpCatalog.length, 26);
  for (const tool of fixture.mcpTools) {
    assertExactKeys(tool, ["name", "disposition", "profile", "mindScope", "owner"], tool.name);
    assert.ok(profiles.has(tool.profile), `${tool.name}: unknown profile`);
    assert.match(specification, new RegExp(`\\b${tool.name}\\b`, "u"), tool.name);
  }
  for (const retired of fixture.retiredMcpTools) {
    assert.equal(fixture.targetMcpCatalog.includes(retired), false, retired);
    const currentDisposition = fixture.mcpTools.find(({ name }) => name === retired)?.disposition;
    if (currentDisposition === undefined) {
      assert.ok(MCP_MOVED_EXPORT_TOOLS.includes(retired), retired);
    } else {
      assert.ok(["move", "remove"].includes(currentDisposition), retired);
    }
  }
});

test("cached binding and capture compatibility is versioned, unadvertised and side-effect-free", () => {
  assert.deepEqual(fixture.retiredMcpCompatibility, {
    $schema: "mind-diary/mcp-operation-retired/v1",
    advertised: false,
    applicationCalls: 0,
    sideEffects: "none",
    operations: {
      get_mind_bindings: {
        code: "operation_retired_from_content_mcp",
        remediation: "inspect_mind_usage_on_site",
        retryable: false,
      },
      set_read_mind_binding: {
        code: "operation_retired_from_content_mcp",
        remediation: "manage_mind_usage_on_site",
        retryable: false,
      },
      set_write_mind_binding: {
        code: "operation_retired_from_content_mcp",
        remediation: "manage_mind_usage_on_site",
        retryable: false,
      },
      capture_knowledge: {
        code: "operation_retired_from_content_mcp",
        remediation: "use_commit_changeset",
        retryable: false,
      },
    },
  });
  assert.deepEqual(
    Object.keys(fixture.retiredMcpCompatibility.operations),
    [...MCP_RETIRED_BINDING_TOOLS, ...MCP_RETIRED_CAPTURE_TOOLS],
  );
});

test("machine-readable schema diff removes binding fields without removing explicit Mind", () => {
  const toolDiffs = fixture.schemaDiffs.filter(({ removeRequired }) => Array.isArray(removeRequired));
  assert.deepEqual(toolDiffs.map(({ operation }) => operation), [
    "create_file_upload_intent",
    "stage_bundle_file",
    "reconcile_file_stage",
    "commit_changeset",
    "reconcile_changeset",
  ]);
  for (const diff of toolDiffs) {
    assertExactKeys(
      diff,
      [
        "operation",
        "removeRequired",
        "keepRequired",
        "addRequired",
        ...(["commit_changeset", "reconcile_changeset"].includes(diff.operation)
          ? ["addOptional"]
          : []),
      ],
      diff.operation,
    );
    const currentRequired = definitions.get(diff.operation).inputSchema.required;
    for (const field of diff.removeRequired) {
      assert.equal(currentRequired.includes(field), false, `${diff.operation}: ${field} remains exposed`);
    }
    for (const field of diff.keepRequired) {
      assert.ok(currentRequired.includes(field), `${diff.operation}: ${field} is not preserved`);
    }
    const targetRequired = currentRequired.concat(diff.addRequired);
    assert.ok(targetRequired.includes("mind"), `${diff.operation}: explicit mind must remain required`);
    assert.equal(targetRequired.includes("write_binding_id"), false, diff.operation);
    if (diff.addOptional !== undefined) {
      assert.deepEqual(diff.addOptional, ["source_references"]);
      assert.ok(
        Object.hasOwn(definitions.get(diff.operation).inputSchema.properties, "source_references"),
        `${diff.operation}: source_references is not exposed`,
      );
    }
  }
  const capabilityDiff = fixture.schemaDiffs.find(
    ({ operation }) => operation === "get_file_ingress_capabilities",
  );
  assert.deepEqual(capabilityDiff, {
    operation: "get_file_ingress_capabilities",
    outputContract: "transport_summary_v2",
  });
  const capabilitySchema = JSON.stringify(
    definitions.get("get_file_ingress_capabilities").outputSchema,
  );
  assert.match(capabilitySchema, /source_selection_required/u);
  assert.match(capabilitySchema, /openai_file_parameter/u);
  assert.match(capabilitySchema, /one_use_upload_intent/u);
  assert.doesNotMatch(capabilitySchema, /sources\[\]|requires_writable_target/u);
  const usageDiff = fixture.schemaDiffs.find(
    ({ operation }) => operation === "PUT /api/v1/minds/{mind_ref}/usage",
  );
  assert.deepEqual(usageDiff, {
    operation: "PUT /api/v1/minds/{mind_ref}/usage",
    implementationOwner: "MD-374",
    modeEnum: ["disabled", "read", "read_write"],
    versionField: "expected_usage_version",
    singletonWritable: true,
  });
  assert.ok(fixture.restRoutes.some(({ key }) => key === usageDiff.operation));
  assert.equal(fixture.principalMindUsage.appliesTo.includes(usageDiff.operation), true);
  assert.equal(fixture.restRoutes.some(({ key }) => /\/mind-access$/u.test(key)), false);
});

test("binding errors retire cleanly and writable-Mind errors apply only to write/ingress", () => {
  assert.deepEqual(fixture.retiredReadErrors, ["mind_binding_required"]);
  assert.deepEqual(fixture.retiredWriteErrors, [
    "write_binding_required",
    "write_binding_stale",
    "binding_owner_revoked",
    "binding_state_unavailable",
  ]);
  assert.deepEqual(fixture.targetWriteErrors, [
    "writable_mind_required",
    "writable_mind_stale",
  ]);
  assert.equal(fixture.targetWriteErrors.includes("target_conflict"), false);
  const retired = new Set([...fixture.retiredReadErrors, ...fixture.retiredWriteErrors]);
  for (const code of fixture.targetWriteErrors) assert.equal(retired.has(code), false, code);
  for (const tool of fixture.mcpTools) {
    if (tool.profile === "content-read") {
      assert.equal(tool.mindScope.includes("principal-read-write"), false, tool.name);
    }
    if (tool.profile === "content-write" || tool.profile === "content-ingress") {
      assert.match(tool.mindScope, /principal-read-write/u, tool.name);
    }
  }
});

test("legacy credentials fail closed before ACL-derived reads with one non-disclosing envelope", () => {
  assert.deepEqual(fixture.credentialAccessCompatibility, {
    appliesBefore: ["acl_discovery", "mind_metadata", "canonical_object", "derived_index"],
    freshOrUpgradedAuthority: "current_acl_or_visibility",
    legacyProfileOutcome: "fail_closed",
    code: "credential_access_upgrade_required",
    schema: "mind-diary/credential-access-upgrade-required/v1",
    retryable: false,
    remediation: ["upgrade", "re-consent", "reissue"],
    mindMetadataDisclosed: false,
    readBindingAuthority: false,
  });
  assert.ok(
    fixture.profiles["content-read"].errors.includes(
      "credential_access_upgrade_required",
    ),
  );
  assert.equal(
    fixture.profiles["content-read"].compatibility,
    "same-name-principal-usage-profile",
  );
});

test("normative resource URI grammars execute through the application builder and parser", async () => {
  assert.deepEqual(fixture.resources.uriPatterns, [
    "okf://spaces/{space-id}/revisions/{revision-id}/index",
    "okf://spaces/{space-id}/revisions/{revision-id}/entries/{path}",
  ]);
  const indexUri = exactRevisionResourceUri(
    "space_contract",
    "revision_contract",
    "index.md",
  );
  const entryUri = exactRevisionResourceUri(
    "space_contract",
    "revision_contract",
    "concepts/café.md",
  );
  assert.equal(
    indexUri,
    fixture.resources.uriPatterns[0]
      .replace("{space-id}", "space_contract")
      .replace("{revision-id}", "revision_contract"),
  );
  assert.equal(
    entryUri,
    fixture.resources.uriPatterns[1]
      .replace("{space-id}", "space_contract")
      .replace("{revision-id}", "revision_contract")
      .replace("{path}", "concepts/caf%C3%A9.md"),
  );

  const authorizationCalls = [];
  const browse = new MindBrowseService({
    store: {},
    objects: {},
    locators: {},
    host: "mind-diary.invalid",
    authorizer: {
      async authorize(request) {
        authorizationCalls.push(request);
        return { kind: "denied", code: "forbidden", retryable: false };
      },
    },
  });
  for (const uri of [indexUri, entryUri]) {
    const before = authorizationCalls.length;
    await assert.rejects(
      browse.readResource(contractActor(), uri),
      (error) => error instanceof MindBrowseFailure && error.code === "resource_not_found",
    );
    assert.equal(
      authorizationCalls.length,
      before + 1,
      `${uri}: application parser did not accept the builder output`,
    );
    assert.equal(authorizationCalls.at(-1).spaceId, "space_contract");
  }
  for (const uri of [
    "okf://spaces/space_contract/index",
    "okf://spaces/space_contract/revisions/revision_contract/entries/index.md",
    "okf://spaces/space_contract/revisions/revision_contract/entries/private%2Fsecret.md",
    `${entryUri}?access_token=secret`,
  ]) {
    const before = authorizationCalls.length;
    await assert.rejects(
      browse.readResource(contractActor(), uri),
      (error) => error instanceof MindBrowseFailure && error.code === "resource_not_found",
    );
    assert.equal(
      authorizationCalls.length,
      before,
      `${uri}: invalid or implicit-revision URI reached authorization`,
    );
  }
  assert.equal(fixture.resources.implicitHeadFallback, false);
  assert.equal(fixture.resources.bearerUri, false);
});

test("the single MCP protocol executes its closed keep/change/remove sets", async () => {
  assertExactKeys(fixture.protocolProfiles, ["2026-07-28"], "protocol profiles");
  const modern = fixture.protocolProfiles["2026-07-28"];
  for (const [name, profile] of Object.entries(fixture.protocolProfiles)) {
    assertExactKeys(
      profile,
      ["endpoint", "keep", "change", "removeWithMethodNotFound"],
      `${name} protocol disposition`,
    );
    assertUnique(
      [...profile.keep, ...profile.change, ...profile.removeWithMethodNotFound],
      `${name} protocol methods overlap`,
    );
  }
  assert.deepEqual(modern, {
    endpoint: "/api/mcp",
    keep: ["resources/templates/list"],
    change: [
      "server/discover",
      "resources/list",
      "resources/read",
      "tools/list",
      "tools/call",
    ],
    removeWithMethodNotFound: ["initialize", "ping"],
  });
  const runtime = protocolHarness();
  for (const method of [...modern.keep, ...modern.change]) {
    const response = await runtime.sendModern(method);
    assert.equal(response.status, 200, `modern ${method}`);
    assert.equal(Object.hasOwn(await response.json(), "error"), false, `modern ${method}`);
  }
  for (const method of modern.removeWithMethodNotFound) {
    const response = await runtime.sendModern(method);
    assert.equal(response.status, 404, `modern ${method}`);
    assert.equal((await response.json()).error.code, -32601, `modern ${method}`);
  }

  assert.deepEqual(fixture.resources.modern, MCP_RESOURCE_CAPABILITIES);
  assert.deepEqual(
    modern.change.filter((method) => method.startsWith("resources/")),
    ["resources/list", "resources/read"],
  );
});

test("MD-355 Settings IA source evidence matches its changed renderers", async () => {
  const expectations = [
    {
      surface: "/help/codex",
      role: "help-renderer-source",
      path: "packages/adapter-web/src/connections.ts",
      gitBlob: "b902c1ce3ee8c6b829c4010af68ad712a8d17f5d",
    },
    {
      surface: "plugin-label",
      role: "shared-label-source",
      path: "packages/adapter-web/src/ui-shell.ts",
      gitBlob: "fff06172183356335baf34ad9be96db631b29b41",
    },
  ];
  for (const expected of expectations) {
    const entry = fixture.pluginHelp.find(({ surface }) => surface === expected.surface);
    const evidence = entry?.sourceEvidence.find(({ role }) => role === expected.role);
    assert.deepEqual(evidence, {
      role: expected.role,
      path: expected.path,
      gitBlob: expected.gitBlob,
    });
    assert.equal(gitBlob(await readFile(new URL(expected.path, root))), expected.gitBlob);
  }
});

test("plugin/help migration has closed owners and exact current source evidence", async () => {
  assertExactKeys(
    fixture.migrationOwners,
    ["MD-374", "MD-376", "MD-379", "MD-359", "integration-owner"],
    "migration owners",
  );
  assert.deepEqual(fixture.pluginHelp, [
    {
      surface: "marketplace-package",
      disposition: "change",
      owner: "integration-owner",
      requirements: [
        "AVAILABLE",
        "ON_USE",
        "transport:/api/mcp",
        "oauth_resource:/api/mcp",
        "new_immutable_version",
      ],
      sourceEvidence: [{
        role: "package-probe-source",
        path: "scripts/run-oauth-direct-plugin-probe.mjs",
        gitBlob: "e51eb5b70f428afc2e54ea36a0a63044bd15565f",
      }],
    },
    {
      surface: "bundled-skill",
      disposition: "change",
      owner: "integration-owner",
      requirements: [
        "explicit_mind",
        "explicit_revision_when_historical",
        "description_relevance",
        "personal_requested_write_only",
        "no_binding_tools",
        "no_mcp_export",
        "site_mind_usage",
        "automatic_commit_changeset",
      ],
      sourceEvidence: [
        {
          role: "accepted-skill-source-contract",
          path: "docs/specs/plugin-connector.md",
          gitBlob: "0a850e98615eaed4f32d9ba45418560d98bf945f",
        },
        {
          role: "installed-skill-probe-source",
          path: "scripts/run-oauth-direct-plugin-probe.mjs",
          gitBlob: "e51eb5b70f428afc2e54ea36a0a63044bd15565f",
        },
      ],
    },
    {
      surface: "/help/codex",
      disposition: "change",
      owner: "MD-376",
      requirements: [
        "install",
        "authenticate_read",
        "read_enabled_explicit_mind",
        "configure_principal_mind_usage_on_site",
        "automatic_commit_changeset",
      ],
      sourceEvidence: [{
        role: "help-renderer-source",
        path: "packages/adapter-web/src/connections.ts",
        gitBlob: "b902c1ce3ee8c6b829c4010af68ad712a8d17f5d",
      }],
    },
    {
      surface: "/help",
      disposition: "change",
      owner: "integration-owner",
      requirements: ["no_removed_binding_tools", "no_removed_export_tools"],
      sourceEvidence: [
        {
          role: "help-playbook-source",
          path: "packages/adapter-web/src/token-management.ts",
          gitBlob: "10a2a48d93df43685ee659cb30377bc4e948de56",
        },
        {
          role: "help-route-source",
          path: "packages/adapter-web/src/product-http-request-helpers.ts",
          gitBlob: "462f1ef89ef59b78f1b3e9af4384297e1a52b3ab",
        },
      ],
    },
    {
      surface: "plugin-label",
      disposition: "keep",
      owner: "integration-owner",
      requirements: ["Mind Diary UAT", "no_production_claim"],
      sourceEvidence: [{
        role: "shared-label-source",
        path: "packages/adapter-web/src/ui-shell.ts",
        gitBlob: "fff06172183356335baf34ad9be96db631b29b41",
      }],
    },
  ]);
  const owners = new Set(Object.keys(fixture.migrationOwners));
  for (const entry of fixture.pluginHelp) {
    assert.ok(owners.has(entry.owner), `${entry.surface}: unknown implementation owner`);
    for (const evidence of entry.sourceEvidence) {
      assertExactKeys(evidence, ["role", "path", "gitBlob"], evidence.role);
      const bytes = await readFile(new URL(evidence.path, root));
      assert.equal(
        gitBlob(bytes),
        evidence.gitBlob,
        `${entry.surface}: ${evidence.role} source drifted; refresh target migration evidence`,
      );
    }
  }
});
