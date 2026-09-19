import assert from "node:assert/strict";
import test from "node:test";
import { readInput, readImportBatchInput } from "../../packages/adapter-web/dist/product-http-routing.js";

for (const multipart of [false, true]) {
  test(`${multipart ? "multipart" : "JSON"} input stops at its byte bound with a false Content-Length`, { timeout: 2_000 }, async () => {
    let pulls = 0;
    let canceled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(multipart ? 1024 * 1024 : 32));
      },
      cancel() { canceled = true; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    const request = new Request("https://mind-diary.test/api", {
      method: "POST", body, duplex: "half",
      headers: { "content-length": "1", "content-type": multipart ? "multipart/form-data; boundary=test" : "application/json" },
    });
    await assert.rejects(multipart ? readImportBatchInput(request) : readInput(request, 64), /body is too large/);
    assert.equal(pulls, multipart ? 6 : 3);
    assert.equal(canceled, true);
    assert.equal(body.locked, false);
  });
}

test("JSON byte limits preserve UTF-8 split across chunks and reject multibyte overflow", async () => {
  const text = '{"name":"Привет"}';
  const bytes = new TextEncoder().encode(text);
  const request = () => new Request("https://mind-diary.test/api", {
    method: "POST", duplex: "half",
    body: new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  });
  assert.deepEqual(await readInput(request(), bytes.byteLength), { name: "Привет" });
  await assert.rejects(readInput(request(), bytes.byteLength - 1), /too large/);
});
