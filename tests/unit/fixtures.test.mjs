import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  FIXED_NOW,
  FIXTURE_MANIFEST_SHA256,
  MINDS,
  OKF_BUNDLE,
  PRINCIPALS,
  REVISIONS,
  createFixtureClock,
} from "@mind-diary/test-fixtures";

const root = resolve(import.meta.dirname, "../..");

test("fixture identities, Minds, revisions and clocks are deterministic", () => {
  const firstClock = createFixtureClock();
  const secondClock = createFixtureClock();

  assert.equal(firstClock.now(), FIXED_NOW);
  assert.equal(secondClock.now(), FIXED_NOW);
  firstClock.set(REVISIONS.next.committedAt);
  assert.equal(firstClock.now(), REVISIONS.next.committedAt);
  assert.equal(secondClock.now(), FIXED_NOW);
  assert.equal(PRINCIPALS.owner.principalId, "principal_owner_0001");
  assert.equal(MINDS.personal.route, "/me");
  assert.equal(MINDS.ordinary.handle, "research-notes");
  assert.equal(REVISIONS.next.parentRevisionId, REVISIONS.initial.revisionId);
});

test("in-memory OKF fixture exactly matches the checked-in complete bundle", async () => {
  const manifest = createHash("sha256");
  for (const file of [...OKF_BUNDLE.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const bytes = await readFile(
      resolve(root, "tests", "fixtures", "okf", "basic", file.path),
    );
    assert.equal(bytes.toString("utf8"), file.text);
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    manifest.update(file.path);
    manifest.update("\0");
    manifest.update(fileHash);
    manifest.update("\n");
  }
  assert.equal(manifest.digest("hex"), FIXTURE_MANIFEST_SHA256);
});
