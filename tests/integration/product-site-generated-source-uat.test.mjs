import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_ENDPOINT,
  MCP_TARGET_PROTOCOL,
} from "@mind-diary/adapter-mcp";
import {
  RESTRICTED_UAT_GENERATED_SOURCE_TEST_ROUTE,
  RESTRICTED_UAT_GENERATED_SOURCE_TOKEN_NAME,
  createProductSiteRuntime,
} from "@mind-diary/composition-root";
import {
  deterministicKey,
  FakeD1Database,
  FakeR2Bucket,
} from "../../scripts/lib/fake-sites-storage.mjs";

const ORIGIN = "https://mind-diary.example";
const NOW = "2026-08-28T20:00:00.000Z";
const CANDIDATE = "a".repeat(40);

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
        const chunk = new Uint8Array(next.value);
        chunks.push(chunk);
        size += chunk.byteLength;
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

async function modernMcp(runtime, secret, body) {
  return responseFrom(runtime, new Request(`${ORIGIN}${MCP_ENDPOINT}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": body.method,
      "mcp-protocol-version": MCP_TARGET_PROTOCOL,
      ...(body.method === "tools/call" && typeof body.params?.name === "string"
        ? { "mcp-name": body.params.name }
        : {}),
    },
    body: JSON.stringify(body),
  }));
}

async function modernTool(runtime, secret, id, name, args) {
  const response = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-generated-source-uat-test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(response.status, 200, name);
  const body = await response.json();
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  return body.result.structuredContent.data;
}

test("restricted UAT installs one deterministic generated-source caller without MCP exposure", async () => {
  const database = new FakeD1Database();
  const bucket = new StreamingFakeR2Bucket();
  const scheduled = [];
  const runtime = await createProductSiteRuntime({
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "generated.uat@example.com",
          verifiedFullName: "Generated UAT",
        };
      },
    },
    tokenVerifierKey: deterministicKey(21),
    locatorKey: deterministicKey(61),
    exportDownloadVerifierKey: deterministicKey(101),
    csrfKey: deterministicKey(141),
    now: () => new Date(NOW),
    schedule(work) { scheduled.push(work); },
    restrictedUatGeneratedSourceTest: {
      deploymentClass: "uat",
      deploymentPosture: "restricted-uat",
      candidateSha: CANDIDATE,
    },
  });

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrap = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:generated-uat",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrap.status, 200);

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const csrf = csrfFromHtml(await settings.text());
  const createdMind = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/minds`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "mind:generated-uat",
    },
    body: JSON.stringify({
      name: "Generated UAT",
      handle: "generated-uat",
      description: "Deterministic generated-source UAT evidence",
    }),
  }));
  assert.equal(createdMind.status, 200, await createdMind.clone().text());

  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:generated-uat",
    },
    body: JSON.stringify({
      name: RESTRICTED_UAT_GENERATED_SOURCE_TOKEN_NAME,
      scopes: ["content:write"],
      expires_at: "2026-09-04T20:00:00.000Z",
    }),
  }));
  assert.equal(issued.status, 200, await issued.clone().text());
  const issuedData = (await issued.json()).data;
  const secret = issuedData.secret;
  const personalTokenRef = issuedData.token.personal_token_ref;

  const selected = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/generated-uat/usage`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "usage:generated-uat",
      },
      body: JSON.stringify({
        usage_mode: "read_write",
        expected_usage_version: 0,
      }),
    },
  ));
  assert.equal(selected.status, 200, await selected.clone().text());

  const createdOtherMind = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "mind:generated-uat-other",
      },
      body: JSON.stringify({
        name: "Generated UAT Other",
        handle: "generated-uat-other",
        description: null,
      }),
    },
  ));
  assert.equal(createdOtherMind.status, 200, await createdOtherMind.clone().text());
  const selectedOther = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/generated-uat-other/usage`,
    {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "usage:generated-uat-other",
      },
      body: JSON.stringify({
        usage_mode: "read_write",
        expected_usage_version: 1,
      }),
    },
  ));
  assert.equal(selectedOther.status, 200, await selectedOther.clone().text());

  const capabilityResponse = await responseFrom(
    runtime,
    new Request(`${ORIGIN}${RESTRICTED_UAT_GENERATED_SOURCE_TEST_ROUTE}`),
  );
  assert.equal(capabilityResponse.status, 200);
  const capabilities = (await capabilityResponse.json()).data;
  assert.equal(capabilities.candidate_sha, CANDIDATE);
  assert.deepEqual(capabilities.capability_rows, [
    {
      source_kind: "bounded_in_memory",
      test_composition_status: "available",
      test_transport: "constructor_owned_bytes",
      max_bytes: 4_194_304,
    },
    {
      source_kind: "server_generated",
      test_composition_status: "available",
      test_transport: "constructor_owned_stream",
      max_bytes: 268_435_456,
    },
  ]);

  const before = await modernTool(runtime, secret, "generated-before", "list_minds", {});
  const beforeMind = before.minds.find(({ route }) => route === "/generated-uat");
  assert.ok(beforeMind);
  const initialRevision = beforeMind.head.revision_id;

  const matrixResponse = await responseFrom(runtime, new Request(
    `${ORIGIN}${RESTRICTED_UAT_GENERATED_SOURCE_TEST_ROUTE}`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        action: "run_matrix",
        mind_ref: "/generated-uat",
        personal_token_ref: personalTokenRef,
        run_id: "generated-uat-run-001",
      }),
    },
  ));
  assert.equal(matrixResponse.status, 200, await matrixResponse.clone().text());
  const matrix = (await matrixResponse.json()).data;
  assert.equal(matrix.status, "passed");
  assert.equal(matrix.commit.one_revision, true);
  assert.equal(matrix.commit.replayed, true);
  assert.equal(matrix.assertions.length, 14);
  assert.equal(matrix.assertions.every(({ status }) => status === "passed"), true);
  assert.equal(matrix.staged.bounded_in_memory.size, 4_194_304);
  assert.ok(matrix.staged.server_generated.size > 0);

  const after = await modernTool(runtime, secret, "generated-after", "list_minds", {});
  const afterMind = after.minds.find(({ route }) => route === "/generated-uat");
  assert.notEqual(afterMind.head.revision_id, initialRevision);
  const files = await modernTool(runtime, secret, "generated-files", "list_bundle_files", {
    mind: "/generated-uat",
    revision_selector: { kind: "revision", revision_id: afterMind.head.revision_id },
    limit: 10,
  });
  assert.deepEqual(files.files.map(({ path, size }) => [path, size]), [
    ["assets/uat-generated-bounded.png", 4_194_304],
    ["assets/uat-server-generated.pdf", matrix.staged.server_generated.size],
  ]);

  const publicCapabilities = await modernTool(
    runtime,
    secret,
    "generated-public-capabilities",
    "get_file_ingress_capabilities",
    {},
  );
  assert.equal(publicCapabilities.source_selection_required, false);
  assert.equal("sources" in publicCapabilities, false);

  const toolList = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "generated-tool-list",
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-generated-source-uat-test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  const toolNames = (await toolList.json()).result.tools.map(({ name }) => name);
  assert.equal(toolNames.some((name) => /server_generated|generated.*stage/iu.test(name)), false);
  assert.equal(scheduled.some(({ kind }) => kind === "revision_index"), true);
});

test("generated-source test composition rejects non-UAT constructor lineage", async () => {
  await assert.rejects(
    createProductSiteRuntime({
      database: new FakeD1Database(),
      bucket: new FakeR2Bucket(),
      publicOrigin: ORIGIN,
      identity: { readVerifiedIdentity: () => ({ kind: "unauthenticated" }) },
      tokenVerifierKey: deterministicKey(22),
      locatorKey: deterministicKey(62),
      exportDownloadVerifierKey: deterministicKey(102),
      csrfKey: deterministicKey(142),
      schedule() {},
      restrictedUatGeneratedSourceTest: {
        deploymentClass: "uat",
        deploymentPosture: "restricted-uat",
        candidateSha: "not-a-candidate",
      },
    }),
    /requires exact restricted-UAT lineage/u,
  );
});
