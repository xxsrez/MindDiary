import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_UPLOAD_INTENT_ROUTE_PREFIX,
  HostedFileUploadIntentClientFailure,
  createFileUploadIntentHttpHandler,
  createHostedFileUploadIntentClient,
} from "@mind-diary/adapter-mcp";

const ORIGIN = "https://mind-diary.invalid";
const CAPABILITY = `mdupload_v1_${"A".repeat(64)}`;
const URL = `${ORIGIN}${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${CAPABILITY}`;

function staged() {
  return Object.freeze({
    kind: "staged",
    replayed: false,
    record: Object.freeze({
      stagedFileId: "staged_http_upload",
      sourceKind: "local_path",
      displayFilename: "fixture.opus",
      mediaType: "audio/ogg",
      sha256: `sha256:${"a".repeat(64)}`,
      size: 3,
      expiresAt: "2026-08-25T13:00:00.000Z",
    }),
  });
}

function handler(options = {}) {
  const calls = [];
  const instance = createFileUploadIntentHttpHandler({
    publicOrigin: ORIGIN,
    nextRequestId: () => "request_http_upload",
    application: {
      async status(input) {
        calls.push({ kind: "status", input });
        return options.status ?? {
          kind: "pending",
          expiresAt: "2026-08-25T12:10:00.000Z",
        };
      },
      async upload(input) {
        const bytes = [];
        for await (const chunk of input.stream) bytes.push(...chunk);
        calls.push({ kind: "upload", input, bytes });
        if (options.throwPrivate) {
          throw new Error("/home/example/brain secret bearer");
        }
        return options.upload ?? staged();
      },
    },
  });
  return { calls, handler: instance };
}

test("same-origin capability route accepts credentialless GET/PUT and returns only a safe staged receipt", async () => {
  const env = handler();
  const pending = await env.handler(new Request(URL, {
    headers: { origin: ORIGIN },
  }));
  assert.equal(pending.status, 200);
  assert.deepEqual((await pending.json()).data, {
    status: "pending",
    expires_at: "2026-08-25T12:10:00.000Z",
  });
  const uploaded = await env.handler(new Request(URL, {
    method: "PUT",
    headers: {
      origin: ORIGIN,
      "content-type": "application/octet-stream",
    },
    body: Uint8Array.of(1, 2, 3),
  }));
  assert.equal(uploaded.status, 201);
  const payload = await uploaded.json();
  assert.deepEqual(payload.data.staged_file, {
    staged_file_ref: "staged_http_upload",
    state: "verified",
    source_kind: "local_path",
    display_filename: "fixture.opus",
    media_type: "audio/ogg",
    sha256: `sha256:${"a".repeat(64)}`,
    size: 3,
    expires_at: "2026-08-25T13:00:00.000Z",
    replayed: false,
  });
  assert.deepEqual(env.calls.at(-1).bytes, [1, 2, 3]);
  assert.equal(uploaded.headers.get("cache-control"), "no-store");
  assert.equal(uploaded.headers.get("referrer-policy"), "no-referrer");
});

test("route rejects foreign origins, query, bearer/cookie, wrong media type and declared oversize before application", async () => {
  for (const request of [
    new Request(URL, { headers: { origin: "https://foreign.invalid" } }),
    new Request(`${URL}?leak=1`),
    new Request(URL, { headers: { authorization: "Bearer secret" } }),
    new Request(URL, { headers: { cookie: "session=secret" } }),
  ]) {
    const env = handler();
    const response = await env.handler(request);
    assert.equal(response.status, 404);
    assert.equal(env.calls.length, 0);
  }
  const media = handler();
  assert.equal((await media.handler(new Request(URL, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "private",
  }))).status, 415);
  assert.equal(media.calls.length, 0);
  const oversize = handler();
  assert.equal((await oversize.handler(new Request(URL, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": "268435457",
    },
    body: Uint8Array.of(0),
  }))).status, 413);
  assert.equal(oversize.calls.length, 0);
});

test("HTTP failures are typed and never echo private exceptions, capability, path, bearer or bytes", async () => {
  const thrown = handler({ throwPrivate: true });
  const response = await thrown.handler(new Request(URL, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: Uint8Array.of(1),
  }));
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /file_ingress_transport_unavailable/u);
  assert.doesNotMatch(body, /Users|private|brain|bearer|mdupload|bytes/iu);

  for (const [result, status, code] of [
    [{ kind: "invalid", code: "expected_size_mismatch" }, 422, "bundle_file_size_mismatch"],
    [{ kind: "invalid", code: "expected_sha256_mismatch" }, 422, "bundle_file_digest_mismatch"],
    [{ kind: "stream_invalid", code: "stream_size_limit_exceeded" }, 413, "bundle_file_size_limit_exceeded"],
    [{ kind: "invalid", code: "capacity_soft_limit" }, 429, "capacity_soft_limit"],
    [{ kind: "invalid", code: "capacity_hard_limit" }, 429, "capacity_hard_limit"],
    [{ kind: "invalid", code: "capacity_fairness_limit" }, 429, "capacity_fairness_limit"],
    [{ kind: "invalid", code: "capacity_accounting_untrusted" }, 429, "capacity_accounting_untrusted"],
    [{ kind: "invalid", code: "outstanding_staged_byte_limit_exceeded" }, 422, "staging_quota_exceeded"],
  ]) {
    const env = handler({ upload: result });
    const failure = await env.handler(new Request(URL, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(),
    }));
    assert.equal(failure.status, status);
    assert.equal((await failure.json()).error.code, code);
  }
  const rejected = handler({
    status: { kind: "rejected", code: "expected_sha256_mismatch" },
  });
  const reconciled = await rejected.handler(new Request(URL));
  assert.equal(reconciled.status, 200);
  assert.deepEqual((await reconciled.json()).data, {
    status: "rejected",
    code: "bundle_file_digest_mismatch",
  });
  for (const [storedCode, publicCode] of [
    ["capacity_soft_limit", "capacity_soft_limit"],
    ["capacity_hard_limit", "capacity_hard_limit"],
    ["capacity_fairness_limit", "capacity_fairness_limit"],
    ["capacity_accounting_untrusted", "capacity_accounting_untrusted"],
    ["outstanding_staged_byte_limit_exceeded", "staging_quota_exceeded"],
  ]) {
    const capacity = handler({
      status: { kind: "rejected", code: storedCode },
    });
    const status = await capacity.handler(new Request(URL));
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json()).data, {
      status: "rejected",
      code: publicCode,
    });
  }
});

test("companion client preserves typed capacity failures from PUT and GET reconciliation", async () => {
  const pending = () => new Response(JSON.stringify({
    ok: true,
    data: { status: "pending", expires_at: "2026-08-25T12:10:00.000Z" },
  }));
  for (const [code, status, retryable] of [
    ["capacity_soft_limit", 429, true],
    ["capacity_hard_limit", 429, false],
    ["capacity_fairness_limit", 429, false],
    ["capacity_accounting_untrusted", 429, true],
    ["staging_quota_exceeded", 422, false],
  ]) {
    let calls = 0;
    const client = createHostedFileUploadIntentClient({
      publicOrigin: ORIGIN,
      async fetcher() {
        calls += 1;
        if (calls === 1) return pending();
        return new Response(JSON.stringify({
          ok: false,
          error: { code, message: "safe", retryable },
        }), { status });
      },
    });
    await assert.rejects(
      client.upload({ uploadUrl: URL, bytes: new Uint8Array() }),
      (error) => error instanceof HostedFileUploadIntentClientFailure &&
        error.code === code && error.retryable === retryable,
    );

    const reconciled = createHostedFileUploadIntentClient({
      publicOrigin: ORIGIN,
      async fetcher() {
        return new Response(JSON.stringify({
          ok: true,
          data: { status: "rejected", code },
        }));
      },
    });
    await assert.rejects(
      reconciled.upload({ uploadUrl: URL, bytes: new Uint8Array() }),
      (error) => error instanceof HostedFileUploadIntentClientFailure &&
        error.code === code && error.retryable === retryable,
    );
  }
});

test("companion client reconciles an unknown PUT and always omits credentials, bearer and redirects", async () => {
  const calls = [];
  const pending = () => new Response(JSON.stringify({
    ok: true,
    data: { status: "pending", expires_at: "2026-08-25T12:10:00.000Z" },
  }));
  const ready = () => new Response(JSON.stringify({
    ok: true,
    data: {
      status: "staged",
      staged_file: {
        staged_file_ref: "staged_reconciled",
        state: "verified",
        source_kind: "workspace/generated_artifact",
        display_filename: "fixture.ipynb",
        media_type: "application/x-ipynb+json",
        sha256: `sha256:${"b".repeat(64)}`,
        size: 4,
        expires_at: "2026-08-25T13:00:00.000Z",
        replayed: false,
      },
    },
  }));
  let step = 0;
  const client = createHostedFileUploadIntentClient({
    publicOrigin: ORIGIN,
    async fetcher(url, init) {
      calls.push({ url, init });
      step += 1;
      if (step === 1) return pending();
      if (step === 2) throw new TypeError("unknown network outcome");
      return ready();
    },
  });
  const result = await client.upload({
    uploadUrl: URL,
    bytes: Uint8Array.of(1, 2, 3, 4),
  });
  assert.equal(result.status, "staged");
  assert.equal(result.staged_file.staged_file_ref, "staged_reconciled");
  assert.deepEqual(calls.map(({ init }) => init.method), ["GET", "PUT", "GET"]);
  for (const { url, init } of calls) {
    assert.equal(url, URL);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal("authorization" in init.headers, false);
    assert.equal("cookie" in init.headers, false);
  }
  await assert.rejects(
    client.status("https://foreign.invalid/api/file-ingress/v1/upload-intents/nope"),
    (error) => error instanceof HostedFileUploadIntentClientFailure &&
      error.code === "invalid_upload_url",
  );
});
