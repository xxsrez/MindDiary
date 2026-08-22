import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES } from "@mind-diary/domain";
import {
  MCP_COMMIT_EXPORT_TOOL_DEFINITIONS,
  ProductMcpContentApplication,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";

const PROTOCOL = "2026-07-28";
const NOW = "2026-08-22T11:00:00.000Z";
const MIND_ID = "space_capture_mcp";
const WRITE_BINDING_ID = "write_capture_mcp";

function actor(scopes) {
  return Object.freeze({
    kind: "registered_principal",
    principalId: "principal_capture_mcp",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: `token_capture_${scopes.at(-1)}`,
      bindingOwnerId: "grant_capture_mcp",
      effectiveScopes: Object.freeze(scopes),
    }),
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_capture_actor",
    occurredAtUtc: NOW,
  });
}

function revision(revisionId) {
  const head = revisionId === "revision_capture_head";
  return Object.freeze({
    revisionId,
    revisionNumber: head ? 1 : 2,
    parentRevisionId: head ? null : "revision_capture_head",
    committedAt: NOW,
    committedBy: Object.freeze({
      kind: "principal",
      id: "principal_capture_mcp",
    }),
    summary: head ? "Capture fixture" : "Automatic capture routine-fact",
    manifestHash: `sha256:${(head ? "a" : "b").repeat(64)}`,
    isHead: true,
  });
}

function mind(revisionId) {
  return Object.freeze({
    mindId: MIND_ID,
    route: "/capture-fixture",
    handle: "capture-fixture",
    name: "Capture fixture",
    isPersonal: false,
    visibility: "private",
    discovery: "membership",
    access: Object.freeze({
      kind: "membership",
      role: "editor",
      capabilities: Object.freeze(["content:read", "content:write"]),
    }),
    metadataVersion: 1,
    head: revision(revisionId),
  });
}

function captureArguments(overrides = {}) {
  return {
    mind: "capture-fixture",
    write_binding_id: WRITE_BINDING_ID,
    expected_binding_version: 2,
    expected_revision: "revision_capture_head",
    idempotency_key: "capture-routine-fact",
    classification: "routine_non_sensitive",
    capture_kind: "fact",
    capture_key: "routine-fact",
    title: "Routine fact",
    description: "A bounded non-sensitive fact stated by the user.",
    body: "The user prefers compact weekly summaries.",
    sources: [{ kind: "user_statement" }],
    ...overrides,
  };
}

function rpc(argumentsValue, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "capture_knowledge",
      arguments: argumentsValue,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "automatic-capture-conformance",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function harness() {
  const calls = [];
  let scheduled = 0;
  const discovery = {
    async listMinds() { return { minds: [], nextCursor: null }; },
    async resolveMind() { return mind("revision_capture_head"); },
    async getMindInfo(_actor, _selector, revisionSelector) {
      const revisionId = revisionSelector?.kind === "revision"
        ? revisionSelector.revisionId
        : "revision_capture_head";
      return {
        mind: mind(revisionId),
        resolvedRevision: revision(revisionId),
        revisionMode: revisionSelector?.kind === "revision" ? "historical" : "head",
        contentCapabilities: ["browse", "commit"],
      };
    },
  };
  const application = new ProductMcpContentApplication({
    discovery,
    bindings: {
      async read() {
        return {
          kind: "ready",
          bindings: {
            bindingSet: {
              state: "active",
              bindingVersion: 2,
              automaticCaptureMode: "routine_non_sensitive",
              captureWriteBindingId: WRITE_BINDING_ID,
              captureUpdatedAt: NOW,
            },
            readBindings: [],
            writeBinding: null,
          },
        };
      },
      async mutateRead() { return { kind: "invalid" }; },
      async mutateWrite() { return { kind: "invalid" }; },
    },
    browse: {
      async browseEntries() { return {}; },
      async fetch() { return {}; },
      async readResource() { throw new Error("unused"); },
    },
    search: { async searchEntries() { return {}; } },
    history: { async listRevisions() { return {}; }, async getRevision() { return {}; } },
    validation: { async validateMind() { return {}; } },
    commits: { async commit() { return { kind: "invalid" }; } },
    capture: {
      async capture(request) {
        calls.push(request);
        if (request.captureKey === "disabled") return { kind: "capture_disabled" };
        if (request.captureKey === "private-source") {
          return { kind: "capture_confirmation_required" };
        }
        if (request.captureKey === "collision") return { kind: "capture_conflict" };
        if (request.captureKey === "no-op") {
          return {
            kind: "no_op",
            path: "concepts/captured/no-op.md",
            revisionId: "revision_capture_head",
          };
        }
        return {
          kind: "captured",
          path: `concepts/captured/${request.captureKey}.md`,
          previousRevisionId: "revision_capture_head",
          revisionId: "revision_capture_committed",
          replayed: false,
        };
      },
    },
    exports: {
      async start() { return { kind: "denied" }; },
      async getStatus() { return { kind: "not_found" }; },
    },
    scheduleCommitEffects() { scheduled += 1; },
  });
  let requestId = 0;
  const writeActor = actor(["content:read", "content:write"]);
  const readActor = actor(["content:read"]);
  const handler = createMcpHttpHandler({
    authenticator: {
      async authenticate(candidate) {
        if (candidate === "write-token") return { kind: "authenticated", actor: writeActor };
        if (candidate === "read-token") return { kind: "authenticated", actor: readActor };
        return { kind: "invalid" };
      },
    },
    requestIds: { nextRequestId: () => `request_capture_http_${++requestId}` },
    content: application,
  });
  async function call(argumentsValue, token = "write-token", id = 1) {
    const response = await handler(new Request("https://mind-diary.invalid/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "capture_knowledge",
        "mcp-protocol-version": PROTOCOL,
      },
      body: JSON.stringify(rpc(argumentsValue, id)),
    }));
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  return { call, calls, scheduled: () => scheduled };
}

test("capture_knowledge publishes a closed routine-only contract", () => {
  const definition = MCP_COMMIT_EXPORT_TOOL_DEFINITIONS.find(
    ({ name }) => name === "capture_knowledge",
  );
  assert.ok(definition);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.equal(definition.inputSchema.properties.classification.const, "routine_non_sensitive");
  assert.deepEqual(
    definition.inputSchema.properties.sources.items.oneOf.map(
      (variant) => variant.properties.kind.const,
    ),
    ["user_statement", "target_entry"],
  );
  assert.deepEqual(definition.securitySchemes, [
    { type: "oauth2", scopes: ["content:write"] },
  ]);
  assert.equal(definition.annotations.destructiveHint, false);
});

test("capture_knowledge preserves the exact binding tuple and maps capture/no-op safely", async () => {
  const env = harness();
  const captured = await env.call(captureArguments());
  assert.equal(captured.isError, false);
  assert.equal(captured.structuredContent.data.status, "captured");
  assert.equal(captured.structuredContent.data.path, "concepts/captured/routine-fact.md");
  assert.equal(captured.structuredContent.data.revision.revision_id, "revision_capture_committed");
  assert.equal(captured.structuredContent.data.index_status, "queued");
  assert.equal(env.scheduled(), 1);
  assert.equal(env.calls[0].spaceId, MIND_ID);
  assert.equal(env.calls[0].writeBindingId, WRITE_BINDING_ID);
  assert.equal(env.calls[0].expectedBindingVersion, 2);
  assert.equal(env.calls[0].expectedRevisionId, "revision_capture_head");
  assert.deepEqual(env.calls[0].sources, [{ kind: "user_statement" }]);

  const noOp = await env.call(captureArguments({
    capture_key: "no-op",
    idempotency_key: "capture-no-op",
  }), "write-token", 2);
  assert.equal(noOp.structuredContent.data.status, "no_op");
  assert.equal(noOp.structuredContent.data.index_status, "unchanged");
  assert.equal(noOp.structuredContent.data.previous_revision_id, null);
  assert.equal(env.scheduled(), 1);
});

test("capture_knowledge rejects policy expansion and redacts failed content", async () => {
  const env = harness();
  const confirmation = await env.call(captureArguments({
    capture_key: "private-source",
    idempotency_key: "capture-private-source",
    body: "PRIVATE_BODY_MUST_NOT_LEAK",
    sources: [{
      kind: "target_entry",
      revision_id: "revision_other_mind",
      path: "concepts/private.md",
    }],
  }));
  assert.equal(
    confirmation.structuredContent.error.code,
    "capture_confirmation_required",
  );
  assert.equal(JSON.stringify(confirmation).includes("PRIVATE_BODY_MUST_NOT_LEAK"), false);

  const invalid = await env.call(captureArguments({
    classification: "sensitive",
  }), "write-token", 3);
  assert.equal(invalid.isError, true);
  assert.equal(env.calls.length, 1);

  const readOnly = await env.call(captureArguments(), "read-token", 4);
  assert.equal(readOnly.isError, true);
  assert.equal(readOnly.structuredContent.error.code, "insufficient_scope");
  assert.equal(env.calls.length, 1);
});
