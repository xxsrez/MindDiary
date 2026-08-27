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
  MCP_LEGACY_CODEX_ENDPOINT,
  MCP_LEGACY_CODEX_PROTOCOL,
  MCP_RETIRED_SITES_ENDPOINT,
  MCP_RESOURCE_CAPABILITIES,
  MCP_TOOL_DEFINITIONS,
  createLegacyCodexMcpHttpHandler,
  createMcpHttpHandler,
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
const connectionsServer = await readFile(
  new URL("packages/adapter-web/src/connections.ts", root),
  "utf8",
);
const connectionsClient = await readFile(
  new URL("packages/adapter-web/assets/connections-client.js", root),
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
  ["packages/adapter-mcp/src/legacy-codex.ts", "packages/adapter-mcp/dist/legacy-codex.js"],
  ["packages/adapter-mcp/src/tool-definitions.ts", "packages/adapter-mcp/dist/tool-definitions.js"],
  ["packages/adapter-web/src/index.ts", "packages/adapter-web/dist/index.js"],
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
  const compatibility = createLegacyCodexMcpHttpHandler(dependencies);
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

  async function sendCompatibility(method) {
    const initialize = method === "initialize";
    const notification = method === "notifications/initialized";
    const params = initialize
      ? {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "0.147.0" },
        }
      : {
          ...(method === "resources/read"
            ? { uri: "okf://spaces/space_contract/revisions/revision_contract/index" }
            : {}),
          ...(method === "tools/call" ? { name: "list_minds", arguments: {} } : {}),
        };
    return compatibility(new Request(
      "https://mind-diary.invalid/api/mcp/2025-11-25",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer contract-token",
          "content-type": "application/json",
          ...(initialize ? {} : { "mcp-protocol-version": MCP_LEGACY_CODEX_PROTOCOL }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id: 1 }),
          method,
          ...(Object.keys(params).length === 0 ? {} : { params }),
        }),
      },
    ));
  }

  return { sendModern, sendCompatibility };
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
    "credentialTargetActions",
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

test("credential target actions keep recovery-safe clear distinct from select", () => {
  assert.deepEqual(fixture.profiles["credential-control"].checks, [
    "credential_owner_authority",
    "target_version_cas",
    "idempotency",
  ]);
  assert.deepEqual(fixture.credentialTargetActions, {
    appliesTo: [
      "PATCH /api/v1/connections/{connection_ref}/mind-access",
      "PATCH /api/v1/mcp-tokens/{personal_token_ref}/mind-access",
    ],
    select_write: {
      checks: [
        "credential_owner_authority",
        "active_lifecycle",
        "content_write_scope",
        "current_writer_role",
        "target_eligibility",
        "expected_target_version",
        "idempotency",
      ],
      errors: [
        "credential_not_found",
        "write_step_up_required",
        "target_conflict",
        "target_ineligible",
      ],
      metadataDisclosure: "authorized-target-only",
    },
    clear_write: {
      checks: [
        "credential_owner_authority",
        "active_lifecycle",
        "expected_target_version",
        "idempotency",
      ],
      mustNotRequire: ["target_acl", "current_writer_role", "target_eligibility"],
      allowedAfter: ["target_acl_loss", "target_role_loss", "target_deletion"],
      errors: ["credential_not_found", "target_conflict"],
      metadataDisclosure: "none",
    },
  });
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
  const currentServerActions = [...new Set(
    [...connectionsServer.matchAll(/data-access-action="([a-z_]+)"/gu)]
      .map((match) => match[1]),
  )].sort();
  assert.deepEqual(currentServerActions, [
    "attach_read",
    "clear_write",
    "detach_read",
    "select_write",
  ]);
  assert.match(connectionsServer, /data-binding-version="\$\{access\.bindingVersion\}"/u);
  assert.match(connectionsServer, /\/api\/v1\/connections\/\$\{safeRef\}/u);
  assert.match(connectionsServer, /\/api\/v1\/mcp-tokens\/\$\{safeRef\}/u);
  assert.match(connectionsClient, /panel\.dataset\.bindingVersion/u);
  assert.match(connectionsClient, /expected_binding_version:\s*expected/u);
  assert.doesNotMatch(connectionsClient, /expected_target_version/u);
  const restDiffs = fixture.schemaDiffs.filter(({ operation }) => operation.startsWith("PATCH "));
  assert.equal(restDiffs.length, 2);
  assert.deepEqual(
    restDiffs.map(({ operation }) => operation),
    fixture.credentialTargetActions.appliesTo,
  );
  for (const diff of restDiffs) {
    assert.ok(fixture.restRoutes.some(({ key }) => key === diff.operation), diff.operation);
    assert.deepEqual(
      [...diff.removeEnum, ...diff.keepEnum].sort(),
      currentServerActions,
      `${diff.operation}: target action delta must cover the exact live server action set`,
    );
    assert.deepEqual(diff.removeEnum, ["attach_read", "detach_read"]);
    assert.deepEqual(diff.keepEnum, ["select_write", "clear_write"]);
    assert.deepEqual(diff.renameFields, {
      expected_binding_version: "expected_target_version",
    });
    assert.deepEqual(diff.staleExpectedTargetVersion, {
      code: "target_conflict",
      httpStatus: 409,
      targetStateChange: "none",
      metadataDisclosure: "none",
      lastWriteWins: false,
      surface: "sites-control",
      contentMcpError: false,
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
  assert.equal(fixture.targetWriteErrors.includes("target_conflict"), false);
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

test("both MCP protocol profiles execute their closed keep/change/remove sets", async () => {
  assertExactKeys(fixture.protocolProfiles, ["2026-07-28", "2025-11-25"], "protocol profiles");
  const modern = fixture.protocolProfiles["2026-07-28"];
  const compatibility = fixture.protocolProfiles["2025-11-25"];
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
  assert.deepEqual(compatibility, {
    endpoint: "/api/mcp/2025-11-25",
    keep: ["notifications/initialized", "ping"],
    change: ["initialize", "tools/list", "tools/call"],
    removeWithMethodNotFound: [
      "server/discover",
      "resources/templates/list",
      "resources/list",
      "resources/read",
    ],
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

  for (const method of ["initialize", "ping", "tools/list", "tools/call"]) {
    const response = await runtime.sendCompatibility(method);
    assert.equal(response.status, 200, `compatibility ${method}`);
    assert.equal(
      Object.hasOwn(await response.json(), "error"),
      false,
      `compatibility ${method}`,
    );
  }
  const initialized = await runtime.sendCompatibility("notifications/initialized");
  assert.equal(initialized.status, 202);
  assert.equal(await initialized.text(), "");
  for (const method of compatibility.removeWithMethodNotFound) {
    const response = await runtime.sendCompatibility(method);
    assert.equal(response.status, 404, `compatibility ${method}`);
    assert.equal((await response.json()).error.code, -32601, `compatibility ${method}`);
  }

  assert.deepEqual(fixture.resources.modern, MCP_RESOURCE_CAPABILITIES);
  assert.deepEqual(fixture.resources.compatibility, []);
  assert.deepEqual(
    modern.change.filter((method) => method.startsWith("resources/")),
    ["resources/list", "resources/read"],
  );
  assert.deepEqual(
    compatibility.removeWithMethodNotFound.filter((method) => method.startsWith("resources/")),
    ["resources/templates/list", "resources/list", "resources/read"],
  );
});

test("plugin/help migration has closed owners and exact current source evidence", async () => {
  assertExactKeys(fixture.migrationOwners, ["MD-339", "MD-359", "integration-owner"], "migration owners");
  assert.deepEqual(fixture.pluginHelp, [
    {
      surface: "marketplace-package",
      disposition: "change",
      owner: "integration-owner",
      requirements: [
        "AVAILABLE",
        "ON_USE",
        "transport:/api/mcp/2025-11-25",
        "oauth_resource:/api/mcp",
        "new_immutable_version",
      ],
      sourceEvidence: [{
        role: "package-probe-source",
        path: "scripts/run-oauth-direct-plugin-probe.mjs",
        gitBlob: "9bf26c534f54f3d2e14b03eb88400eb7232764b2",
      }],
    },
    {
      surface: "bundled-skill",
      disposition: "change",
      owner: "integration-owner",
      requirements: [
        "explicit_mind",
        "explicit_revision_when_historical",
        "no_binding_tools",
        "no_mcp_export",
        "site_target_control",
      ],
      sourceEvidence: [
        {
          role: "accepted-skill-source-contract",
          path: "docs/specs/plugin-connector.md",
          gitBlob: "6784b7274aed6998aba762fcdc00f2624e6f4fcf",
        },
        {
          role: "installed-skill-probe-source",
          path: "scripts/run-oauth-direct-plugin-probe.mjs",
          gitBlob: "9bf26c534f54f3d2e14b03eb88400eb7232764b2",
        },
      ],
    },
    {
      surface: "/help/codex",
      disposition: "change",
      owner: "MD-339",
      requirements: [
        "install",
        "authenticate_read",
        "read_explicit_mind",
        "select_write_target_on_site_only_when_writing",
      ],
      sourceEvidence: [{
        role: "help-renderer-source",
        path: "packages/adapter-web/src/connections.ts",
        gitBlob: "85a74210f0d11f5957d0eab9e6953338b3ad4437",
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
          gitBlob: "e5997bf8a2b3e7a6520b1969492c0614d7ee0cdf",
        },
        {
          role: "help-route-source",
          path: "packages/adapter-web/src/product-http-request-helpers.ts",
          gitBlob: "514ac171ac3eaa4870f74a3b1e64c28f48f49f91",
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
        gitBlob: "0b4066e05c5240bc6826f4a9a1efaad33dae641d",
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
