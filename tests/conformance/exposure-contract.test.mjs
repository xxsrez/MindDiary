import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_APPLICATION_BOUNDARY,
} from "@mind-diary/adapter-background";
import {
  MCP_CONTENT_TOOLS,
  MCP_ENDPOINT,
  MCP_LEGACY_CODEX_ENDPOINT,
  MCP_LEGACY_CODEX_PROTOCOL,
  MCP_RESOURCE_CAPABILITIES,
  MCP_TARGET_PROTOCOL,
} from "@mind-diary/adapter-mcp";
import {
  WEB_APPLICATION_BOUNDARY,
  WEB_CONTROL_ROUTES,
} from "@mind-diary/adapter-web";

const expectedMcpTools = [
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "browse_entries",
  "search",
  "fetch",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "commit_changeset",
  "start_export",
  "get_export_status",
];

test("browser contract exposes control metadata and no raw content routes", () => {
  const routes = WEB_CONTROL_ROUTES.map(([method, path]) => `${method} ${path}`);
  assert.equal(new Set(routes).size, routes.length);
  for (const [, path] of WEB_CONTROL_ROUTES) {
    assert.match(path, /^\/api\/v1\//);
    assert.doesNotMatch(
      path,
      /\/(?:content|files|entries|search|fetch|revisions|manifest|objects|exports?)(?:\/|$)/,
    );
  }
  assert.equal("browse_entries" in WEB_APPLICATION_BOUNDARY, false);
  assert.equal("commit_changeset" in WEB_APPLICATION_BOUNDARY, false);
});

test("MCP contract exposes only custom Mind-aware content tools", () => {
  assert.equal(MCP_ENDPOINT, "/api/mcp");
  assert.equal(MCP_TARGET_PROTOCOL, "2026-07-28");
  assert.equal(MCP_LEGACY_CODEX_ENDPOINT, "/api/mcp/2025-11-25");
  assert.equal(MCP_LEGACY_CODEX_PROTOCOL, "2025-11-25");
  assert.deepEqual(MCP_CONTENT_TOOLS, expectedMcpTools);
  const forbiddenControlTools = [
    "bootstrap_account",
    "create_invitation",
    "change_membership_role",
    "change_visibility",
    "transfer_ownership",
    "delete_space",
    "issue_mcp_token",
  ];
  for (const tool of forbiddenControlTools) {
    assert.equal(MCP_CONTENT_TOOLS.includes(tool), false);
  }
  assert.deepEqual(MCP_RESOURCE_CAPABILITIES, [
    "resources/list",
    "resources/read",
    "resources/templates/list-empty",
  ]);
});

test("background contract never grants authority from a serialized job", () => {
  assert.equal(BACKGROUND_APPLICATION_BOUNDARY.authorityFromJobPayload, false);
});
