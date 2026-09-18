import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MCP_AGENT_INSTRUCTIONS,
  MCP_GUIDANCE_TOOL_DEFINITIONS,
  MIND_DIARY_HOST_SPECIFIC_BOUNDARY,
  MIND_DIARY_SERVICE_GUIDANCE_MARKDOWN,
  MIND_DIARY_SERVICE_GUIDANCE_SHA256,
  MIND_DIARY_SERVICE_GUIDANCE_VERSION,
  ProductMcpContentApplication,
} from "../../packages/adapter-mcp/dist/index.js";

const actor = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_guidance",
  authentication: Object.freeze({
    kind: "mcp_token",
    tokenId: "token_guidance",
    effectiveScopes: Object.freeze(["content:read"]),
  }),
  deploymentCapabilities: Object.freeze(["content:read"]),
  requestId: "request_guidance",
  occurredAtUtc: "2026-09-18T00:00:00.000Z",
});

test("canonical guidance source generates the exact server representation", async () => {
  const source = await readFile(
    new URL("../../packages/adapter-mcp/guidance/service-guidance.md", import.meta.url),
    "utf8",
  );
  assert.equal(MIND_DIARY_SERVICE_GUIDANCE_MARKDOWN, source);
  assert.equal(
    MIND_DIARY_SERVICE_GUIDANCE_SHA256,
    `sha256:${createHash("sha256").update(source).digest("hex")}`,
  );
  assert.equal(MIND_DIARY_SERVICE_GUIDANCE_VERSION, "2026-09-18");
});

test("guidance tool is discoverable, self-contained and truthfully read-only", () => {
  assert.equal(MCP_GUIDANCE_TOOL_DEFINITIONS.length, 1);
  const definition = MCP_GUIDANCE_TOOL_DEFINITIONS[0];
  assert.equal(definition.name, "get_mind_diary_guidance");
  assert.deepEqual(definition.inputSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {},
  });
  assert.deepEqual(definition.securitySchemes, [
    { type: "oauth2", scopes: ["content:read"] },
  ]);
  assert.deepEqual(definition.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.match(definition.description, /self-contained/u);
  assert.match(definition.description, /does not read a Mind/u);
  assert.match(MCP_AGENT_INSTRUCTIONS, /call get_mind_diary_guidance once/u);
  assert.ok(MCP_AGENT_INSTRUCTIONS.length < MIND_DIARY_SERVICE_GUIDANCE_MARKDOWN.length);
});

test("guidance execution touches no corpus service and returns the complete portable guide", async () => {
  const dependencies = new Proxy({}, {
    get() {
      throw new Error("guidance_must_not_read_dependencies");
    },
  });
  const application = new ProductMcpContentApplication(dependencies);
  assert.deepEqual(await application.authorizeToolCall({
    actor,
    name: "get_mind_diary_guidance",
    arguments: {},
  }), { kind: "allowed" });

  const result = await application.executeToolCall({
    actor,
    name: "get_mind_diary_guidance",
    arguments: {},
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.data, {
    guidance_version: MIND_DIARY_SERVICE_GUIDANCE_VERSION,
    service_guidance_sha256: MIND_DIARY_SERVICE_GUIDANCE_SHA256,
    service_guidance_markdown: MIND_DIARY_SERVICE_GUIDANCE_MARKDOWN,
    host_specific: {
      applicability: "conditional_on_client_tools",
      instructions: MIND_DIARY_HOST_SPECIFIC_BOUNDARY,
    },
  });
  assert.match(result.structuredContent.data.service_guidance_markdown, /Start every relevant workflow with `list_minds`/u);
  assert.match(result.structuredContent.data.service_guidance_markdown, /call `preflight_changeset`/u);
  assert.match(result.structuredContent.data.service_guidance_markdown, /Host-specific optional capabilities/u);
  assert.match(result.structuredContent.data.host_specific.instructions, /only when .* actually present/u);

  const invalid = await application.executeToolCall({
    actor,
    name: "get_mind_diary_guidance",
    arguments: { mind: "/me" },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "invalid_request");
});
