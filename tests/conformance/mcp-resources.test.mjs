import assert from "node:assert/strict";
import test from "node:test";

import { MindBrowseFailure } from "../../packages/application-content/dist/index.js";
import {
  MCP_ADVERTISED_CAPABILITIES,
  MCP_CONTENT_TOOLS,
  MCP_CUSTOM_PROFILE_GUARDRAILS,
  MCP_RESOURCE_CAPABILITIES,
  createMcpHttpHandler,
  parseMcpResourceUri,
} from "../../packages/adapter-mcp/dist/index.js";

const PROTOCOL = "2026-07-28";
const PERSONAL_ROOT = "okf://spaces/space_personal/revisions/rev_personal/index";
const MEMBER_ROOT = "okf://spaces/space_member/revisions/rev_member/index";
const EXACT_ENTRY =
  "okf://spaces/space_member/revisions/rev_member/entries/concepts/caf%C3%A9.md";

function actor() {
  return Object.freeze({
    kind: "registered_principal",
    principalId: "principal_resources",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: "token_read",
      effectiveScopes: Object.freeze(["content:read"]),
    }),
    deploymentCapabilities: Object.freeze(["content:read"]),
    requestId: "request_actor",
    occurredAtUtc: "2026-08-07T21:00:00.000Z",
  });
}

function protocolMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    "io.modelcontextprotocol/clientInfo": {
      name: "resource-conformance",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function rpc(method, params = {}, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: protocolMeta() },
  };
}

function resource(uri, name) {
  return {
    uri,
    name,
    title: name,
    mimeType: "text/markdown; charset=utf-8",
  };
}

function harness({ invalidListResource = false, nextCursor = null } = {}) {
  let nextRequestId = 0;
  let accessAllowed = true;
  let head = "rev_member";
  const rootCalls = [];
  const readCalls = [];
  const authenticatedActor = actor();

  const handler = createMcpHttpHandler({
    authenticator: {
      async authenticate(candidate) {
        return candidate === "read-token"
          ? { kind: "authenticated", actor: authenticatedActor }
          : { kind: "invalid" };
      },
    },
    requestIds: {
      nextRequestId() {
        nextRequestId += 1;
        return `request_resources_${nextRequestId}`;
      },
    },
    content: {
      async listTools() {
        return MCP_CONTENT_TOOLS.map((name) => ({ name }));
      },
      async listRootResources(request) {
        rootCalls.push(request);
        return {
          resources: invalidListResource
            ? [resource(EXACT_ENTRY, "Entry must not be enumerated")]
            : [
                resource(MEMBER_ROOT, "Member Mind"),
                resource(PERSONAL_ROOT, "Personal Mind"),
              ],
          nextCursor,
        };
      },
      async readResource(request) {
        readCalls.push(request);
        if (!accessAllowed || request.uri.includes("missing")) {
          throw new MindBrowseFailure(
            "resource_not_found",
            "Private membership details must never escape.",
          );
        }
        return {
          uri: request.uri,
          mimeType: "text/markdown; charset=utf-8",
          text: `# Exact ${request.uri.includes("rev_member") ? "rev_member" : head}\n`,
          entry: { privateInternalMetadata: true },
        };
      },
      async authorizeToolCall() {
        return { kind: "allowed" };
      },
      async executeToolCall() {
        return {};
      },
    },
  });

  async function send(body) {
    const name = body.method === "resources/read" ? body.params.uri : undefined;
    return handler(
      new Request("https://mind-diary.invalid/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer read-token",
          "content-type": "application/json",
          "mcp-method": body.method,
          "mcp-protocol-version": PROTOCOL,
          ...(name === undefined ? {} : { "mcp-name": name }),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  return {
    send,
    rootCalls,
    readCalls,
    setAccessAllowed(value) {
      accessAllowed = value;
    },
    moveHead(value) {
      head = value;
    },
  };
}

async function json(response) {
  return response.json();
}

test("publishes only the custom Mind-aware resource profile", () => {
  assert.deepEqual(MCP_ADVERTISED_CAPABILITIES, { tools: {}, resources: {} });
  assert.deepEqual(MCP_RESOURCE_CAPABILITIES, [
    "resources/list",
    "resources/read",
    "resources/templates/list-empty",
  ]);
  assert.deepEqual(MCP_CUSTOM_PROFILE_GUARDRAILS, {
    profile: "mind-diary-custom-mind-aware",
    companyKnowledgeCompatible: false,
    fetchToolRequiredFallback: true,
    resourceUrisAreCapabilities: false,
    resourceTemplatesPublished: false,
    implicitPersonalization: false,
    corpusSelectsMind: false,
    corpusSelectsScopes: false,
    controlToolsPublished: false,
    allowedWritePromptInjectionRisk: "residual-explicit",
  });
  assert.ok(MCP_CONTENT_TOOLS.includes("fetch"));
  for (const forbidden of [
    "create_invitation",
    "change_membership_role",
    "change_visibility",
    "transfer_ownership",
    "delete_space",
    "issue_mcp_token",
    "personalize",
  ]) {
    assert.equal(MCP_CONTENT_TOOLS.includes(forbidden), false);
  }
});

test("accepts only canonical encode-once immutable resource URIs", () => {
  assert.deepEqual(parseMcpResourceUri(PERSONAL_ROOT), {
    kind: "index",
    spaceId: "space_personal",
    revisionId: "rev_personal",
    path: "index.md",
  });
  assert.deepEqual(parseMcpResourceUri(EXACT_ENTRY), {
    kind: "entry",
    spaceId: "space_member",
    revisionId: "rev_member",
    path: "concepts/café.md",
  });

  for (const invalid of [
    "okf://spaces/space_member/revisions/rev_member/entries/concepts%2Fsecret.md",
    "okf://spaces/space_member/revisions/rev_member/entries/concepts/%252F.md",
    "okf://spaces/space_member/revisions/rev_member/entries/concepts/%2e%2e.md",
    "okf://spaces/space_member/revisions/rev_member/entries/concepts/caf%c3%a9.md",
    "okf://spaces/space_member/revisions/rev_member/entries/concepts/café.md",
    `${EXACT_ENTRY}?access_token=secret`,
    `${EXACT_ENTRY}#private`,
    "https://example.invalid/content.md",
  ]) {
    assert.equal(parseMcpResourceUri(invalid), null, invalid);
  }
});

test("resources/templates/list is empty and does not enter content application", async () => {
  const fixture = harness();
  const response = await fixture.send(rpc("resources/templates/list"));
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).result, {
    resultType: "complete",
    resourceTemplates: [],
  });
  assert.equal(fixture.rootCalls.length, 0);
  assert.equal(fixture.readCalls.length, 0);
});

test("resources/list returns only deterministic authorized root indexes", async () => {
  const fixture = harness();
  const response = await fixture.send(rpc("resources/list", { cursor: "page_1" }));
  assert.equal(response.status, 200);
  const result = (await json(response)).result;
  assert.deepEqual(
    result.resources.map(({ uri }) => uri),
    [MEMBER_ROOT, PERSONAL_ROOT],
  );
  assert.equal(Object.hasOwn(result, "nextCursor"), false);
  assert.equal(result.resultType, "complete");
  assert.equal(result.ttlMs, 60_000);
  assert.equal(result.cacheScope, "private");
  assert.equal(fixture.rootCalls.length, 1);
  assert.equal(fixture.rootCalls[0].cursor, "page_1");
  assert.equal(fixture.rootCalls[0].actor.principalId, "principal_resources");
  assert.equal(JSON.stringify(result).includes("token_read"), false);
});

test("resources/list preserves an opaque continuation cursor only when present", async () => {
  const fixture = harness({ nextCursor: "page_2" });
  const response = await fixture.send(rpc("resources/list"));
  assert.equal(response.status, 200);
  const result = (await json(response)).result;
  assert.equal(result.nextCursor, "page_2");
  assert.equal(result.ttlMs, 60_000);
  assert.equal(result.cacheScope, "private");
});

test("resources/list fails closed if the application expands enumeration", async () => {
  const fixture = harness({ invalidListResource: true });
  const response = await fixture.send(rpc("resources/list"));
  assert.equal(response.status, 500);
  assert.deepEqual(await json(response), {
    code: "internal_error",
    request_id: "request_resources_1",
  });
});

test("resources/read reauthorizes and returns one exact Markdown revision", async () => {
  const fixture = harness();
  const first = await fixture.send(rpc("resources/read", { uri: EXACT_ENTRY }));
  assert.equal(first.status, 200);
  assert.deepEqual((await json(first)).result, {
    resultType: "complete",
    contents: [
      {
        uri: EXACT_ENTRY,
        mimeType: "text/markdown; charset=utf-8",
        text: "# Exact rev_member\n",
      },
    ],
  });

  fixture.moveHead("rev_new_head");
  const second = await fixture.send(rpc("resources/read", { uri: EXACT_ENTRY }, 2));
  assert.equal(second.status, 200);
  assert.equal((await json(second)).result.contents[0].text, "# Exact rev_member\n");
  assert.equal(fixture.readCalls.length, 2);
  assert.equal(fixture.readCalls[0].uri, EXACT_ENTRY);
  assert.equal(fixture.readCalls[1].uri, EXACT_ENTRY);
  assert.equal(fixture.readCalls[1].actor.principalId, "principal_resources");
});

test("invalid, missing, and unauthorized resources are indistinguishable", async () => {
  const fixture = harness();
  const invalidUri =
    "okf://spaces/space_member/revisions/rev_member/entries/private%2Fsecret.md";
  const invalid = await fixture.send(rpc("resources/read", { uri: invalidUri }, 7));
  const missing = await fixture.send(
    rpc(
      "resources/read",
      {
        uri: "okf://spaces/space_member/revisions/rev_member/entries/missing.md",
      },
      7,
    ),
  );
  fixture.setAccessAllowed(false);
  const denied = await fixture.send(rpc("resources/read", { uri: EXACT_ENTRY }, 7));

  assert.equal(invalid.status, 400);
  assert.equal(missing.status, 400);
  assert.equal(denied.status, 400);
  const expected = {
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32602, message: "Resource not found" },
  };
  assert.deepEqual(await json(invalid), expected);
  assert.deepEqual(await json(missing), expected);
  assert.deepEqual(await json(denied), expected);
  assert.equal(fixture.readCalls.length, 2);
  assert.equal(JSON.stringify(expected).includes("private"), false);
});
