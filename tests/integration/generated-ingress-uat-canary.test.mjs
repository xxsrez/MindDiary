import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MCP_ENDPOINT,
  MCP_TARGET_PROTOCOL,
} from "../../packages/adapter-mcp/dist/index.js";
import { createProductSiteRuntime } from "../../packages/composition-root/dist/index.js";
import {
  deterministicKey,
  FakeD1Database,
  FakeR2Bucket,
} from "../../scripts/lib/fake-sites-storage.mjs";

const ORIGIN = "https://mind-diary.example";
const CANARY_PATH = "/api/v1/internal/operators/generated-ingress-canary";
const RUN_NONCE = "0123456789abcdef";
const HANDLE = `md290-generated-${RUN_NONCE}`;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);
const PDF = new TextEncoder().encode(
  "%PDF-1.7\n% Mind Diary MD-290 fixed generated producer fixture\n",
);

class StreamingFakeR2Bucket extends FakeR2Bucket {
  async put(key, value, options = {}) {
    if (!(value instanceof ReadableStream)) return super.put(key, value, options);
    const reader = value.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const copy = Uint8Array.from(next.value);
        chunks.push(copy);
        size += copy.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return super.put(key, bytes, options);
  }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function csrfFromHtml(html) {
  const match = /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(html);
  assert.ok(match);
  return match[1];
}

async function responseFrom(runtime, request) {
  const response = await runtime.fetch(request);
  assert.ok(response instanceof Response);
  return response;
}

async function modernTool(runtime, secret, id, name, args) {
  const response = await responseFrom(runtime, new Request(`${ORIGIN}${MCP_ENDPOINT}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": MCP_TARGET_PROTOCOL,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "mind-diary-md290-canary-test",
            version: "0.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  }));
  assert.equal(response.status, 200, name);
  const body = await response.json();
  assert.equal(body.result?.isError, false, JSON.stringify(body));
  return body.result.structuredContent.data;
}

async function bootstrap(runtime, idempotencySuffix) {
  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const account = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": `bootstrap:${idempotencySuffix}`,
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(account.status, 200);
  const principalId = (await account.json()).data.principal_id;
  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/mcp`));
  const csrf = csrfFromHtml(await settings.text());
  const token = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": `token:${idempotencySuffix}`,
    },
    body: JSON.stringify({
      name: `MD-290 ${idempotencySuffix}`,
      scopes: ["content:write"],
    }),
  }));
  assert.equal(token.status, 200);
  return Object.freeze({
    principalId,
    csrf,
    secret: (await token.json()).data.secret,
  });
}

function canaryRequest(sitesSession, mcpSecret, csrf, body, method = "POST") {
  return new Request(`${ORIGIN}${CANARY_PATH}`, {
    method,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${mcpSecret}`,
      "content-type": "application/json; charset=utf-8",
      "oai-sites-authorization": `Bearer ${sitesSession}`,
      "x-csrf-token": csrf,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

test("restricted UAT generated ingress canary is fail-closed and exact across reconstruction", async () => {
  const database = new FakeD1Database();
  const bucket = new StreamingFakeR2Bucket();
  const scheduled = [];
  let identity = Object.freeze({
    verifiedEmail: "md290.operator@example.com",
    verifiedFullName: "MD-290 Operator",
  });
  const baseOptions = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return identity === null
          ? Object.freeze({ kind: "unauthenticated" })
          : Object.freeze({ kind: "authenticated", ...identity });
      },
    },
    tokenVerifierKey: deterministicKey(19),
    locatorKey: deterministicKey(59),
    exportDownloadVerifierKey: deterministicKey(99),
    csrfKey: deterministicKey(139),
    observabilityWriter: { write() {} },
    schedule(work) { scheduled.push(work); },
  };
  const createRuntime = (deploymentClass, serviceOperatorPrincipalIds = []) =>
    createProductSiteRuntime({
      ...baseOptions,
      deploymentClass,
      serviceOperatorPrincipalIds,
    });

  let runtime = await createRuntime("uat");
  const operator = await bootstrap(runtime, "md290-operator");
  const created = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": operator.csrf,
      "idempotency-key": "mind:md290-generated",
    },
    body: JSON.stringify({
      name: `MD-290 Generated Canary ${RUN_NONCE}`,
      handle: HANDLE,
    }),
  }));
  assert.equal(created.status, 200);
  assert.equal((await created.json()).data.visibility, "private");

  const oldBinding = await modernTool(
    runtime,
    operator.secret,
    "md290-bind-old",
    "set_write_mind_binding",
    {
      action: "bind",
      mind: "/me",
      expected_binding_version: 0,
      idempotency_key: "binding:md290-old",
    },
  );
  const currentBinding = await modernTool(
    runtime,
    operator.secret,
    "md290-bind-current",
    "set_write_mind_binding",
    {
      action: "bind",
      mind: `/${HANDLE}`,
      expected_binding_version: oldBinding.binding_version,
      idempotency_key: "binding:md290-current",
    },
  );
  const setupInput = Object.freeze({
    action: "setup",
    run_nonce: RUN_NONCE,
    write_binding_id: currentBinding.current.write_binding_id,
    stale_write_binding_id: oldBinding.current.write_binding_id,
  });
  const operatorSitesSession = "sites-session-md290-operator";
  const ordinarySitesSession = "sites-session-md290-ordinary";

  identity = Object.freeze({
    verifiedEmail: "md290.ordinary@example.com",
    verifiedFullName: "MD-290 Ordinary",
  });
  const ordinary = await bootstrap(runtime, "md290-ordinary");

  identity = Object.freeze({
    verifiedEmail: "md290.operator@example.com",
    verifiedFullName: "MD-290 Operator",
  });
  const exactNotFound = { ok: false, error: { code: "not_found" } };
  for (const deniedRuntime of [
    await createRuntime("production", [operator.principalId]),
    await createRuntime("dev", [operator.principalId]),
    await createRuntime("unknown", [operator.principalId]),
    await createRuntime("uat", []),
  ]) {
    const denied = await responseFrom(
      deniedRuntime,
      canaryRequest(operatorSitesSession, operator.secret, operator.csrf, setupInput),
    );
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), exactNotFound);
  }

  runtime = await createRuntime("uat", [operator.principalId]);
  const hiddenGet = await responseFrom(
    runtime,
    canaryRequest(operatorSitesSession, operator.secret, operator.csrf, setupInput, "GET"),
  );
  assert.equal(hiddenGet.status, 404);
  assert.deepEqual(await hiddenGet.json(), exactNotFound);

  identity = null;
  const anonymous = await responseFrom(
    runtime,
    canaryRequest(operatorSitesSession, operator.secret, operator.csrf, setupInput),
  );
  assert.equal(anonymous.status, 404);
  assert.deepEqual(await anonymous.json(), exactNotFound);

  identity = Object.freeze({
    verifiedEmail: "md290.ordinary@example.com",
    verifiedFullName: "MD-290 Ordinary",
  });
  const ordinaryDenied = await responseFrom(
    runtime,
    canaryRequest(ordinarySitesSession, ordinary.secret, ordinary.csrf, setupInput),
  );
  assert.equal(ordinaryDenied.status, 404);
  assert.deepEqual(await ordinaryDenied.json(), exactNotFound);
  const ordinaryMalformedDenied = await responseFrom(
    runtime,
    new Request(`${ORIGIN}${CANARY_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    }),
  );
  assert.equal(ordinaryMalformedDenied.status, 404);
  assert.deepEqual(await ordinaryMalformedDenied.json(), exactNotFound);

  identity = Object.freeze({
    verifiedEmail: "md290.operator@example.com",
    verifiedFullName: "MD-290 Operator",
  });
  const mismatchedMcpPrincipal = await responseFrom(
    runtime,
    canaryRequest(operatorSitesSession, ordinary.secret, operator.csrf, setupInput),
  );
  assert.equal(mismatchedMcpPrincipal.status, 404);
  assert.deepEqual(await mismatchedMcpPrincipal.json(), exactNotFound);

  const genericProducerInput = await responseFrom(runtime, canaryRequest(
    operatorSitesSession,
    operator.secret,
    operator.csrf,
    { ...setupInput, bytes: "client-supplied-bytes-are-forbidden" },
  ));
  assert.equal(genericProducerInput.status, 400);
  assert.deepEqual(await genericProducerInput.json(), {
    ok: false,
    error: { code: "invalid_request" },
  });

  const setup = await responseFrom(
    runtime,
    canaryRequest(operatorSitesSession, operator.secret, operator.csrf, setupInput),
  );
  assert.equal(setup.status, 200);
  const setupBody = await setup.json();
  assert.equal(setupBody.ok, true);
  assert.equal(setupBody.data.status, "awaiting_redeploy");
  assert.equal(setupBody.data.fixture_profile, "md290-generated-producer-v1");
  assert.equal(setupBody.data.replayed, false);
  assert.deepEqual(
    setupBody.data.fixture_sha256,
    [sha256(PNG), sha256(PDF)],
  );
  assert.deepEqual(new Set(setupBody.data.assertions), new Set([
    "target.synthetic_private_owner_mind",
    "binding.preexisting_current_generation",
    "negative.foreign_binding_no_head",
    "negative.expired_binding_no_head",
    "negative.mime_no_head",
    "negative.size_no_head",
    "negative.quota_no_head",
    "negative.cancel_no_head",
    "negative.replay_no_head",
    "negative.writer_failure_no_head",
    "stage.bounded_replay_exact",
    "stage.server_stream_exact",
    "commit.atomic_generated_files_and_markdown",
  ]));
  const serializedSetup = JSON.stringify(setupBody);
  assert.doesNotMatch(
    serializedSetup,
    /principal_|write-binding|space_|revision_|assets\/|concepts\/|@example\.com|Bearer /u,
  );

  const historyBeforeReplay = await modernTool(
    runtime,
    operator.secret,
    "md290-history-before-replay",
    "list_revisions",
    { mind: `/${HANDLE}`, limit: 10 },
  );
  assert.equal(historyBeforeReplay.revisions.length, 3);
  assert.deepEqual(
    historyBeforeReplay.revisions.slice(0, 2).map(({ revision }) => revision.summary),
    [
      `MD-290 generated ingress canary history ${RUN_NONCE}`,
      `MD-290 generated ingress canary setup ${RUN_NONCE}`,
    ],
  );

  runtime = await createRuntime("uat", [operator.principalId]);
  const replay = await responseFrom(
    runtime,
    canaryRequest(operatorSitesSession, operator.secret, operator.csrf, setupInput),
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.replayed, true);
  const historyAfterReplay = await modernTool(
    runtime,
    operator.secret,
    "md290-history-after-replay",
    "list_revisions",
    { mind: `/${HANDLE}`, limit: 10 },
  );
  assert.equal(historyAfterReplay.revisions.length, 3);

  const verified = await responseFrom(runtime, canaryRequest(
    operatorSitesSession,
    operator.secret,
    operator.csrf,
    {
      action: "verify",
      run_nonce: RUN_NONCE,
      write_binding_id: currentBinding.current.write_binding_id,
    },
  ));
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.deepEqual(verifiedBody, {
    ok: true,
    data: {
      status: "verified",
      fixture_profile: "md290-generated-producer-v1",
      fixture_sha256: [sha256(PNG), sha256(PDF)],
      assertions: [
        "persistence.reconstruction_after_redeploy",
        "history.head_and_historical_exact_bytes_sha",
        "binding.current_generation_after_redeploy",
      ],
    },
  });
  assert.ok(scheduled.length >= 2);
});
