import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_UPLOAD_INTENT_ROUTE_PREFIX,
  HostedFileUploadIntentClientFailure,
  createFileUploadIntentHttpHandler,
  createHostedFileUploadIntentClient,
} from "@mind-diary/adapter-mcp";

const ORIGIN = "https://mind-diary.invalid";
const CAPABILITY = "mdupload_v1_dXBsb2FkLWludGVudF8xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const URL = `${ORIGIN}${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${CAPABILITY}`;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

function staged(replayed = false) {
  return {
    kind: "staged",
    replayed,
    record: {
      stagedFileId: "staged_http_1",
      bindingOwnerId: "private_binding_owner",
      sourceKind: "local_path",
      writeBindingId: "private_write_binding",
      writeBindingGeneration: 1,
      spaceId: "private_space",
      displayFilename: "artifact.png",
      mediaType: "image/png",
      sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      size: PNG.byteLength,
      state: "verified",
      createdAt: "2026-08-24T12:00:00.000Z",
      expiresAt: "2026-08-24T13:00:00.000Z",
      consumedAt: null,
      rejectionCode: null,
    },
  };
}

function handlerHarness(overrides = {}) {
  const calls = [];
  let requestId = 0;
  const application = {
    async upload(input) {
      const chunks = [];
      for await (const chunk of input.stream) chunks.push(Uint8Array.from(chunk));
      calls.push({ kind: "upload", input, chunks });
      return overrides.uploadResult ?? staged();
    },
    async status(input) {
      calls.push({ kind: "status", input });
      return overrides.statusResult ?? {
        kind: "pending",
        expiresAt: "2026-08-24T12:10:00.000Z",
      };
    },
  };
  return {
    calls,
    handler: createFileUploadIntentHttpHandler({
      application,
      publicOrigin: ORIGIN,
      nextRequestId: () => `request_http_${++requestId}`,
    }),
  };
}

async function body(response) {
  return JSON.parse(await response.text());
}

test("capability route streams exact raw bytes and returns only a safe staged receipt", async () => {
  const env = handlerHarness();
  const response = await env.handler(new Request(URL, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: PNG,
  }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(env.calls[0].chunks, [PNG]);
  assert.equal(env.calls[0].input.capability, CAPABILITY);
  assert.equal(env.calls[0].input.requestId, "request_http_1");
  const output = await body(response);
  assert.deepEqual(output, {
    ok: true,
    data: {
      status: "staged",
      staged_file: {
        staged_file_ref: "staged_http_1",
        state: "verified",
        source_kind: "local_path",
        display_filename: "artifact.png",
        media_type: "image/png",
        sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        size: PNG.byteLength,
        expires_at: "2026-08-24T13:00:00.000Z",
        replayed: false,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(output), /private_|mdupload|binding_owner|write_binding|space/u);
});

test("GET is non-consuming and reports pending, staged or generic rejected state", async (t) => {
  await t.test("pending", async () => {
    const env = handlerHarness();
    const response = await env.handler(new Request(URL));
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), {
      ok: true,
      data: { status: "pending", expires_at: "2026-08-24T12:10:00.000Z" },
    });
    assert.equal(env.calls[0].kind, "status");
  });
  await t.test("staged", async () => {
    const env = handlerHarness({ statusResult: staged(true) });
    const response = await env.handler(new Request(URL));
    assert.equal((await body(response)).data.staged_file.replayed, true);
  });
  await t.test("rejected", async () => {
    const env = handlerHarness({ statusResult: { kind: "rejected", code: "private_internal_reason" } });
    const response = await env.handler(new Request(URL));
    assert.deepEqual(await body(response), {
      ok: true,
      data: { status: "rejected", code: "file_ingress_intent_conflict" },
    });
  });
});

test("route fails closed for foreign origin, changed path, credentials, query, method and content type", async () => {
  const env = handlerHarness();
  assert.equal(await env.handler(new Request(`${ORIGIN}/api/other`)), null);
  const requests = [
    new Request(URL.replace(ORIGIN, "https://foreign.invalid")),
    new Request(`${URL}?leak=1`),
    new Request(`${URL}/extra`),
    new Request(URL, { headers: { authorization: "Bearer mdo_access_secret" } }),
    new Request(URL, { headers: { cookie: "session=secret" } }),
    new Request(URL, { headers: { origin: "https://foreign.invalid" } }),
    new Request(URL, { method: "POST" }),
    new Request(URL, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }),
  ];
  for (const request of requests) {
    const response = await env.handler(request);
    assert.ok([404, 415].includes(response.status));
    const text = await response.text();
    assert.doesNotMatch(text, /mdupload|mdo_access|foreign\.invalid|leak/u);
  }
  assert.equal(env.calls.length, 0);
});

test("intent and transport failures map to stable privacy-safe HTTP outcomes", async () => {
  for (const [result, status, code] of [
    [{ kind: "intent_invalid", code: "file_ingress_source_unavailable" }, 404, "file_ingress_source_unavailable"],
    [{ kind: "intent_invalid", code: "file_ingress_intent_expired" }, 410, "file_ingress_intent_expired"],
    [{ kind: "intent_invalid", code: "file_ingress_intent_conflict" }, 409, "file_ingress_intent_conflict"],
    [{ kind: "stream_invalid", code: "stream_transport_unavailable" }, 503, "file_ingress_transport_unavailable"],
    [{ kind: "invalid", code: "expected_sha256_mismatch" }, 422, "bundle_file_digest_mismatch"],
  ]) {
    const env = handlerHarness({ uploadResult: result });
    const response = await env.handler(new Request(URL, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: PNG,
    }));
    assert.equal(response.status, status);
    const output = await body(response);
    assert.equal(output.error.code, code);
    assert.doesNotMatch(JSON.stringify(output), /mdupload|artifact\.png|private_/u);
  }
});

test("token-free client validates same-origin URLs and omits credentials, auth and redirects", async () => {
  const calls = [];
  const client = createHostedFileUploadIntentClient({
    publicOrigin: ORIGIN,
    async fetcher(url, init) {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ok: true,
        data: {
          status: "staged",
          staged_file: {
            staged_file_ref: "staged_client",
            state: "verified",
            source_kind: "connector_object",
            display_filename: "drive.png",
            media_type: "image/png",
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: PNG.byteLength,
            expires_at: "2026-08-24T13:00:00.000Z",
            replayed: false,
          },
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.upload({ uploadUrl: URL, bytes: PNG });
  assert.equal(result.staged_file.staged_file_ref, "staged_client");
  assert.equal(calls[0].url, URL);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/octet-stream" });

  for (const invalid of [
    URL.replace(ORIGIN, "https://foreign.invalid"),
    `${URL}?secret=1`,
    `${URL}#secret`,
    `${ORIGIN}/api/other/${CAPABILITY}`,
  ]) {
    await assert.rejects(
      client.status(invalid),
      (error) => error instanceof HostedFileUploadIntentClientFailure &&
        error.code === "invalid_upload_url" && !error.message.includes(invalid),
    );
  }
  assert.equal(calls.length, 1);
});

test("client reconciles a lost PUT response with one non-consuming GET", async () => {
  const calls = [];
  const client = createHostedFileUploadIntentClient({
    publicOrigin: ORIGIN,
    async fetcher(_url, init) {
      calls.push(init);
      if (init.method === "PUT") throw new TypeError("network lost");
      return new Response(JSON.stringify({
        ok: true,
        data: {
          status: "staged",
          staged_file: {
            staged_file_ref: "staged_reconciled",
            state: "verified",
            source_kind: "local_path",
            display_filename: "artifact.png",
            media_type: "image/png",
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: PNG.byteLength,
            expires_at: "2026-08-24T13:00:00.000Z",
            replayed: false,
          },
        },
      }), { status: 200 });
    },
  });
  const result = await client.upload({ uploadUrl: URL, bytes: PNG });
  assert.equal(result.staged_file.staged_file_ref, "staged_reconciled");
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "GET"]);
  assert.equal(calls[1].credentials, "omit");
  assert.equal(calls[1].redirect, "error");
});

test("client reconciles an ambiguous HTTP 503 after the server consumed the intent", async () => {
  const calls = [];
  const client = createHostedFileUploadIntentClient({
    publicOrigin: ORIGIN,
    async fetcher(_url, init) {
      calls.push(init.method);
      if (init.method === "PUT") {
        return new Response(JSON.stringify({
          ok: false,
          error: {
            code: "file_ingress_transport_unavailable",
            message: "The upload transport is temporarily unavailable.",
            retryable: true,
          },
        }), { status: 503 });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: {
          status: "staged",
          staged_file: {
            staged_file_ref: "staged_after_503",
            state: "verified",
            source_kind: "local_path",
            display_filename: "artifact.png",
            media_type: "image/png",
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: PNG.byteLength,
            expires_at: "2026-08-24T13:00:00.000Z",
            replayed: false,
          },
        },
      }), { status: 200 });
    },
  });
  const recovered = await client.upload({ uploadUrl: URL, bytes: PNG });
  assert.equal(recovered.staged_file.staged_file_ref, "staged_after_503");
  assert.deepEqual(calls, ["PUT", "GET"]);
});
