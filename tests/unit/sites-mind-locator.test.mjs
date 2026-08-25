import assert from "node:assert/strict";
import test from "node:test";

import {
  SITES_LOCATOR_MAX_CHARACTERS,
  SitesMindLocatorCodec,
} from "@mind-diary/adapter-locator-sites";
import { WebCryptoMindLocatorCodec } from "@mind-diary/application-content";
import { FakeD1Database } from "../../scripts/lib/fake-sites-storage.mjs";

const secret = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);

function maxPathPayload() {
  return {
    version: 1,
    kind: "entry",
    spaceId: `space_${"s".repeat(500)}`,
    revisionId: `revision_${"r".repeat(497)}`,
    path: `${"directory/".repeat(180)}entry.md`,
    sha256: `sha256:${"a".repeat(64)}`,
    start: 0,
    end: 4096,
  };
}

test("Sites locators remain fixed-size, durable, expiring and mdl1-compatible", async () => {
  const database = new FakeD1Database();
  let now = new Date("2026-08-22T13:00:00.000Z");
  const codec = new SitesMindLocatorCodec({
    database,
    secret,
    ttlMs: 1_000,
    now: () => now,
  });
  const payload = maxPathPayload();
  const locator = await codec.encode(payload);
  assert.match(locator, /^mdl2_[A-Za-z0-9_-]{32}$/u);
  assert.ok(locator.length <= SITES_LOCATOR_MAX_CHARACTERS);
  assert.deepEqual(await codec.decode(locator), payload);

  const restarted = new SitesMindLocatorCodec({
    database,
    secret,
    ttlMs: 1_000,
    now: () => now,
  });
  assert.deepEqual(await restarted.decode(locator), payload);
  const tamperedLocator = `${locator.slice(0, -1)}${locator.endsWith("x") ? "y" : "x"}`;
  assert.equal(await restarted.decode(tamperedLocator), null);

  const legacy = new WebCryptoMindLocatorCodec(secret);
  const legacyLocator = await legacy.encode(payload);
  assert.deepEqual(await restarted.decode(legacyLocator), payload);

  now = new Date("2026-08-22T13:00:01.001Z");
  assert.equal(await restarted.decode(locator), null);
});
