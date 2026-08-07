import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_CONTENT_TOOLS,
} from "../../packages/adapter-mcp/dist/index.js";
import {
  WEB_ACCEPTS_MCP_BEARER,
  isTrustedSitesControlActor,
} from "../../packages/adapter-web/dist/index.js";
import {
  McpBearerAuthenticationService,
} from "../../packages/application-content/dist/index.js";
import {
  TokenLifecycleService,
} from "../../packages/application-control/dist/index.js";
import { CapabilityAuthorizer } from "../../packages/application-ports/dist/index.js";
import { createLocalMcpHttpBoundary } from "../../packages/composition-root/dist/index.js";
import { CAPABILITIES, version } from "../../packages/domain/dist/index.js";

const START = "2026-08-06T12:00:00.000Z";
const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 29);
const UNKNOWN_CANONICAL_SECRET = `mdp_v1_${"A".repeat(43)}`;
const PRIVATE_DOWNLOAD_URL =
  "https://objects.invalid/private-download-grant-marker";

function sitesActor(principalId, occurredAtUtc = START) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_sites_${principalId}`,
    occurredAtUtc,
  };
}

function rpcCall(id, name, args) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function protocolMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "mind-diary-tests",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function successfulToolResult(data) {
  return {
    resultType: "complete",
    content: [{ type: "text", text: "Completed." }],
    structuredContent: { ok: true, data },
    isError: false,
  };
}

function capabilityForTool(name) {
  if (name === "commit_changeset") return "content:write";
  if (name === "search") return "content:search";
  if (name === "list_revisions" || name === "get_revision") {
    return "content:history";
  }
  if (name === "validate_mind") return "content:validate";
  if (name === "start_export" || name === "get_export_status") {
    return "content:export";
  }
  if (name === "fetch") return "content:fetch";
  return "content:browse";
}

async function harness() {
  let currentTime = START;
  let nextRequestId = 0;
  let nextTokenId = 0;
  let role = "owner";
  let accessVersion = 1;
  let membershipVersion = 1;
  let authorizationCalls = 0;
  let executionCalls = 0;
  let committedRevisions = 0;
  let revokeDuringNextAuthorization = false;
  let includePrivateDownloadInNextResult = false;
  const captures = [];
  const logs = [];
  const idempotencyResults = new Map();
  const clock = {
    now: () => currentTime,
    set: (value) => {
      currentTime = value;
    },
  };

  let boundary;
  let lifecycle;
  let authorizer;

  const stateReader = {
    async readCurrentAuthorizationState(query) {
      const token = query.tokenId
        ? await boundary.tokens.readMcpTokenForAuthorization(query.tokenId)
        : null;
      return {
        principal: { principalId: query.principalId, state: "active" },
        space: {
          spaceId: query.spaceId,
          state: "active",
          visibility: "private",
          accessVersion: version(accessVersion),
        },
        membership: {
          principalId: query.principalId,
          spaceId: query.spaceId,
          role,
          state: "active",
          version: version(membershipVersion),
        },
        token,
      };
    },
  };
  const transaction = {
    kind: "authorization-transaction",
    readCurrentAuthorizationState: (query) =>
      stateReader.readCurrentAuthorizationState(query),
  };

  const content = {
    async listTools() {
      return MCP_CONTENT_TOOLS.map((name) => ({
        name,
        title: name,
        description: `${name} test definition`,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      }));
    },
    async authorizeToolCall(request) {
      authorizationCalls += 1;
      captures.push(request.actor);
      const authorizationRequest = {
        actor: request.actor,
        spaceId: request.arguments.mind ?? "space_one",
        capability: capabilityForTool(request.name),
        revisionMode: "head",
      };
      const preflight = await authorizer.authorize(authorizationRequest);
      if (
        revokeDuringNextAuthorization &&
        preflight.kind === "allowed"
      ) {
        revokeDuringNextAuthorization = false;
        await lifecycle.revokeMcpToken(
          sitesActor(request.actor.principalId, currentTime),
          request.actor.authentication.tokenId,
        );
        return authorizer.reauthorizeInTransaction(
          authorizationRequest,
          transaction,
          preflight.stamp,
        );
      }
      return preflight;
    },
    async executeToolCall(request) {
      executionCalls += 1;
      captures.push(request.actor);
      if (request.name === "commit_changeset") {
        const key = request.arguments.idempotency_key;
        const existing = idempotencyResults.get(key);
        if (existing) return existing;
        committedRevisions += 1;
        const result = successfulToolResult({
          revision_id: `revision_${committedRevisions}`,
        });
        idempotencyResults.set(key, result);
        return result;
      }
      if (includePrivateDownloadInNextResult) {
        includePrivateDownloadInNextResult = false;
        return successfulToolResult({ download_url: PRIVATE_DOWNLOAD_URL });
      }
      return successfulToolResult({ entries: [] });
    },
  };

  boundary = await createLocalMcpHttpBoundary({
    verifierKey: TEST_KEY,
    clock,
    requestIds: {
      nextRequestId() {
        nextRequestId += 1;
        return `request_mcp_${nextRequestId}`;
      },
    },
    content,
    logger: { record: (event) => logs.push(event) },
  });
  lifecycle = new TokenLifecycleService({
    clock,
    tokens: boundary.tokens,
    tokenHasher: boundary.tokenHasher,
    tokenIds: {
      nextTokenId() {
        nextTokenId += 1;
        return `token_${nextTokenId}`;
      },
    },
  });
  authorizer = new CapabilityAuthorizer(stateReader);

  async function issueToken(scopes, expiresAt) {
    const issued = await lifecycle.issueMcpToken(
      sitesActor("principal_mcp", currentTime),
      {
        name: "Codex test token",
        scopes,
        ...(expiresAt ? { expiresAt } : {}),
      },
    );
    return {
      descriptor: issued.token,
      secret: issued.secret.consumeSecret(),
    };
  }

  async function post(rpc, secret, options = {}) {
    const requestBody =
      typeof rpc === "string"
        ? rpc
        : {
            ...rpc,
            params: {
              ...(rpc.params ?? {}),
              _meta: rpc.params?._meta ?? protocolMeta(),
            },
          };
    const method = typeof requestBody === "string" ? "tools/call" : requestBody.method;
    const name =
      typeof requestBody === "string" || method !== "tools/call"
        ? undefined
        : requestBody.params?.name;
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
      ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
      ...(options.headers ?? {}),
    });
    return boundary.handler(
      new Request(options.url ?? "https://mind-diary.invalid/mcp", {
        method: "POST",
        headers,
        body: typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody),
      }),
    );
  }

  return {
    boundary,
    captures,
    clock,
    content,
    issueToken,
    lifecycle,
    logs,
    post,
    state: {
      authorizationCalls: () => authorizationCalls,
      executionCalls: () => executionCalls,
      committedRevisions: () => committedRevisions,
      setRole(nextRole) {
        role = nextRole;
        accessVersion += 1;
        membershipVersion += 1;
      },
      revokeDuringNextAuthorization() {
        revokeDuringNextAuthorization = true;
      },
      includePrivateDownloadInNextResult() {
        includePrivateDownloadInNextResult = true;
      },
    },
  };
}

async function body(response) {
  return response.json();
}

test("authenticates each POST, builds a secret-free actor, and preserves idempotent retry state", async () => {
  const fixture = await harness();
  const token = await fixture.issueToken(["content:write"]);
  const call = rpcCall(1, "commit_changeset", {
    mind: "space_one",
    idempotency_key: "retry_key",
    private_body: "private-content-marker",
  });

  const first = await fixture.post(call, token.secret);
  const firstBody = await body(first);
  const retry = await fixture.post(call, token.secret);
  const retryBody = await body(retry);

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(firstBody.result.isError, false);
  assert.deepEqual(retryBody.result, firstBody.result);
  assert.equal(fixture.state.authorizationCalls(), 2);
  assert.equal(fixture.state.executionCalls(), 2);
  assert.equal(fixture.state.committedRevisions(), 1);
  assert.equal(fixture.captures.length, 4);
  for (const actor of fixture.captures) {
    assert.equal(actor.authentication.kind, "mcp_token");
    assert.deepEqual(actor.authentication.effectiveScopes, [
      "content:read",
      "content:write",
    ]);
    assert.equal("role" in actor, false);
    assert.equal(JSON.stringify(actor).includes(token.secret), false);
  }
});

test("configured MCP deployment capabilities can only narrow the content allowlist", async () => {
  const fixture = await harness();
  const token = await fixture.issueToken(["content:write"]);
  const configured = [
    "visibility:change",
    "content:search",
    "unknown:injected",
    "content:browse",
    "content:search",
  ];
  const authenticator = new McpBearerAuthenticationService({
    clock: fixture.clock,
    tokenHasher: fixture.boundary.tokenHasher,
    tokens: fixture.boundary.tokens,
    deploymentCapabilities: configured,
  });
  configured.push("content:write");

  const authenticated = await authenticator.authenticate(
    token.secret,
    "request_capability_narrowing",
  );
  assert.equal(authenticated.kind, "authenticated");
  assert.deepEqual(
    authenticated.kind === "authenticated"
      ? authenticated.actor.deploymentCapabilities
      : null,
    ["content:browse", "content:search"],
  );
  assert.equal(
    authenticated.kind === "authenticated" &&
      Object.isFrozen(authenticated.actor.deploymentCapabilities),
    true,
  );
  assert.equal(
    authenticated.kind === "authenticated" &&
      authenticated.actor.deploymentCapabilities.includes("visibility:change"),
    false,
  );
});

test("missing, invalid, expired, and revoked tokens are generic transport 401s with no final mutation", async () => {
  const fixture = await harness();
  const call = rpcCall(2, "commit_changeset", {
    mind: "space_one",
    idempotency_key: "must_not_commit",
  });

  const missing = await fixture.post("{not-json", undefined);
  const invalid = await fixture.post(call, UNKNOWN_CANONICAL_SECRET);
  const shortLived = await fixture.issueToken(
    ["content:write"],
    "2026-08-06T12:00:01.000Z",
  );
  fixture.clock.set(shortLived.descriptor.expiresAt);
  const expired = await fixture.post(call, shortLived.secret);
  const revocable = await fixture.issueToken(["content:write"]);
  await fixture.lifecycle.revokeMcpToken(
    sitesActor("principal_mcp", fixture.clock.now()),
    revocable.descriptor.tokenId,
  );
  const revoked = await fixture.post(call, revocable.secret);

  for (const response of [missing, invalid, expired, revoked]) {
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get("www-authenticate"),
      'Bearer realm="mind-diary"',
    );
    const responseBody = await body(response);
    assert.equal(responseBody.code, "authentication_required");
    assert.equal("result" in responseBody, false);
  }
  assert.equal(fixture.state.authorizationCalls(), 0);
  assert.equal(fixture.state.executionCalls(), 0);
  assert.equal(fixture.state.committedRevisions(), 0);
});

test("read-only tokens cannot reach commit and MCP actors are rejected by the REST control boundary", async () => {
  const fixture = await harness();
  const token = await fixture.issueToken(["content:read"]);
  const list = await fixture.post(
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    token.secret,
  );
  const listedNames = (await body(list)).result.tools.map((tool) => tool.name);
  const denied = await fixture.post(
    rpcCall(4, "commit_changeset", {
      mind: "space_one",
      idempotency_key: "read_only_denied",
    }),
    token.secret,
  );
  const deniedBody = await body(denied);
  const authenticated = await fixture.boundary.authenticator.authenticate(
    token.secret,
    "request_control_probe",
  );

  assert.equal(listedNames.includes("commit_changeset"), false);
  assert.equal(listedNames.includes("search"), true);
  assert.equal(denied.status, 200);
  assert.equal(deniedBody.result.isError, true);
  assert.equal(
    deniedBody.result.structuredContent.error.code,
    "insufficient_scope",
  );
  assert.equal(fixture.state.authorizationCalls(), 0);
  assert.equal(fixture.state.executionCalls(), 0);
  assert.equal(fixture.state.committedRevisions(), 0);
  assert.equal(WEB_ACCEPTS_MCP_BEARER, false);
  assert.equal(authenticated.kind, "authenticated");
  assert.equal(
    authenticated.kind === "authenticated" &&
      isTrustedSitesControlActor(authenticated.actor),
    false,
  );
  assert.equal(isTrustedSitesControlActor(sitesActor("principal_mcp")), true);
});

test("current role and token state are re-read without reconnect, including a revocation race", async () => {
  const fixture = await harness();
  const token = await fixture.issueToken(["content:write"]);
  const first = await fixture.post(
    rpcCall(5, "commit_changeset", {
      mind: "space_one",
      idempotency_key: "first_commit",
    }),
    token.secret,
  );
  assert.equal(first.status, 200);
  assert.equal(fixture.state.committedRevisions(), 1);

  fixture.state.setRole("reader");
  const staleRoleAttempt = await fixture.post(
    rpcCall(6, "commit_changeset", {
      mind: "space_one",
      idempotency_key: "stale_role_must_not_commit",
    }),
    token.secret,
  );
  const staleRoleBody = await body(staleRoleAttempt);
  assert.equal(staleRoleAttempt.status, 200);
  assert.equal(staleRoleBody.result.isError, true);
  assert.equal(
    staleRoleBody.result.structuredContent.error.code,
    "capability_denied",
  );
  assert.equal(fixture.state.committedRevisions(), 1);

  fixture.state.setRole("owner");
  fixture.state.revokeDuringNextAuthorization();
  const racingRevocation = await fixture.post(
    rpcCall(7, "commit_changeset", {
      mind: "space_one",
      idempotency_key: "race_must_not_commit",
    }),
    token.secret,
  );
  assert.equal(racingRevocation.status, 401);
  assert.equal((await body(racingRevocation)).code, "authentication_required");
  assert.equal(fixture.state.committedRevisions(), 1);

  const afterRevocation = await fixture.post(
    rpcCall(8, "commit_changeset", {
      mind: "space_one",
      idempotency_key: "after_revoke_must_not_commit",
    }),
    token.secret,
  );
  assert.equal(afterRevocation.status, 401);
  assert.equal(fixture.state.committedRevisions(), 1);
  assert.equal(fixture.state.executionCalls(), 1);
});

test("structured request logs redact headers and omit token, private body/query, and download URL", async () => {
  const fixture = await harness();
  const token = await fixture.issueToken(["content:read"]);
  fixture.state.includePrivateDownloadInNextResult();
  const response = await fixture.post(
    rpcCall(9, "search", {
      mind: "space_one",
      query: "private-search-query-marker",
    }),
    token.secret,
    {
      url: "https://mind-diary.invalid/mcp?query=url-private-query-marker",
      headers: {
        cookie: "cookie-private-marker",
        accept:
          "application/json, text/event-stream; marker=protocol-header-private-marker",
        "x-private-header": "header-private-marker",
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await body(response)).result.structuredContent.data.download_url,
    PRIVATE_DOWNLOAD_URL,
  );

  const serializedLogs = JSON.stringify(fixture.logs);
  for (const privateValue of [
    token.secret,
    "private-search-query-marker",
    "url-private-query-marker",
    "cookie-private-marker",
    "protocol-header-private-marker",
    "header-private-marker",
    PRIVATE_DOWNLOAD_URL,
  ]) {
    assert.equal(serializedLogs.includes(privateValue), false);
  }
  const event = fixture.logs.at(-1);
  assert.equal(event.path, "/mcp");
  assert.equal(event.headers.authorization, "[REDACTED]");
  assert.equal(event.headers.cookie, "[REDACTED]");
  assert.equal(event.headers["mcp-protocol-version"], "[PRESENT]");
  assert.equal("x-private-header" in event.headers, false);
  assert.equal("body" in event, false);
  assert.equal("query" in event, false);
  assert.equal("result" in event, false);
});
