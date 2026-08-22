import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { IncrementalSha256 } from "@mind-diary/application-content";

for (const source of [
  new Uint8Array(0),
  new TextEncoder().encode("abc"),
  Uint8Array.from({ length: 65_537 }, (_value, index) => index % 251),
]) {
  test(`incremental SHA-256 matches Node for ${source.byteLength} bytes`, () => {
    const digest = new IncrementalSha256();
    for (let offset = 0; offset < source.byteLength; offset += 137) {
      digest.update(source.subarray(offset, offset + 137));
    }
    assert.equal(
      digest.digest(),
      `sha256:${createHash("sha256").update(source).digest("hex")}`,
    );
  });
}

test("incremental SHA-256 is single-use after digest", () => {
  const digest = new IncrementalSha256();
  digest.update(new TextEncoder().encode("abc"));
  assert.equal(digest.digest(), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.throws(() => digest.digest(), /already finalized/u);
  assert.throws(() => digest.update(Uint8Array.of(1)), /already finalized/u);
});
