import test from "node:test";
import assert from "node:assert/strict";
import { readInput } from "../../packages/adapter-web/dist/product-http-routing.js";

function streamedRequest(chunks, headers = {}) {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (reads === chunks.length) return controller.close();
      controller.enqueue(chunks[reads++]);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request("https://mind-diary.example/api/v1/minds", {
    method: "POST", headers, body: stream, duplex: "half",
  });
  return { request, get reads() { return reads; }, get cancelled() { return cancelled; } };
}

test("JSON body stops at the byte limit even without a truthful Content-Length", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    const source = streamedRequest([
      new Uint8Array(32), new Uint8Array(33), new Uint8Array(1024),
    ], headers);
    await assert.rejects(readInput(source.request, 64), /body is too large/u);
    assert.equal(source.cancelled, true);
    assert.equal(source.reads, 2, "the remaining body must not be consumed");
  }
});

test("JSON body counts UTF-8 bytes and accepts multibyte text split across chunks", async () => {
  const bytes = new TextEncoder().encode('{"name":"é"}');
  const source = streamedRequest([bytes.slice(0, 10), bytes.slice(10)]);
  assert.deepEqual(await readInput(source.request, bytes.length), { name: "é" });
  const oversized = streamedRequest([bytes.slice(0, 10), bytes.slice(10)]);
  await assert.rejects(readInput(oversized.request, bytes.length - 1), /body is too large/u);
});
