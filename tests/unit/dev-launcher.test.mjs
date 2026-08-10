import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  configurationFingerprint,
  extractDevUrl,
} from "../../scripts/run-dev.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("dev launcher accepts only the machine-resolved loopback URL", () => {
  assert.equal(extractDevUrl("  ➜  Local:   http://localhost:3000/\n"), "http://localhost:3000/");
  assert.equal(extractDevUrl("\u001b[1;1H\u001b[0J Local: http://127.0.0.1:4173/"), "http://127.0.0.1:4173/");
  assert.equal(extractDevUrl("Debug: http://localhost:3000/__debug"), null);
  assert.throws(() => extractDevUrl("Local: https://example.com/"), /non-loopback/u);
  assert.throws(() => extractDevUrl("Local: http://localhost:3000/not-root"), /non-loopback/u);
  assert.throws(() => extractDevUrl("Local: http://localhost:3000/?secret=value"), /non-loopback/u);
});

test("dev configuration fingerprint contains tracked public shape, never secret values", () => {
  const hosting = JSON.stringify({ project_id: "appgprj_fixture", d1: "DB", r2: "BUCKET" });
  const first = configurationFingerprint(hosting, "TOKEN=first-secret\nORIGIN=https://one.example\n");
  const second = configurationFingerprint(hosting, "TOKEN=second-secret\nORIGIN=https://two.example\n");
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(first, /secret|example/u);
});

test("root package exposes the accepted dev launcher command", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts.dev, "node scripts/run-dev.mjs");
});
