import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
  MIND_DIARY_CODEX_STARTER_PLAYBOOK,
  MIND_DIARY_STARTER_OKF_TEMPLATE,
} from "@mind-diary/adapter-web";
import { validateOkfBundle } from "@mind-diary/okf-codec";

const root = resolve(import.meta.dirname, "../..");

test("copy-ready starter template exactly matches one strict checked-in OKF 0.2 bundle", async () => {
  assert.deepEqual(
    MIND_DIARY_STARTER_OKF_TEMPLATE.map(({ path }) => path),
    ["concepts/first-memory.md", "index.md", "log.md"],
  );
  for (const file of MIND_DIARY_STARTER_OKF_TEMPLATE) {
    const checkedIn = await readFile(
      resolve(root, "tests", "fixtures", "okf", "starter", file.path),
      "utf8",
    );
    assert.equal(checkedIn, file.text, file.path);
  }
  const validation = validateOkfBundle(MIND_DIARY_STARTER_OKF_TEMPLATE);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.equal(validation.conforms, true);
  assert.equal(validation.qualityWarnings.length, 0);
});

test("starter and concierge playbooks keep the supported Codex-first boundary explicit", () => {
  for (const expected of [
    "exactly one target",
    "UTF-8 Markdown",
    "validate_mind",
    "fetch index.md",
    "search",
    "fetch the returned entry",
    "do not ask me to construct wire JSON",
    "Never request or repeat a token",
  ]) {
    assert.match(MIND_DIARY_CODEX_STARTER_PLAYBOOK, new RegExp(expected, "u"));
  }
  for (const expected of [
    "concierge work, not a product import",
    "exactly one accessible target Mind",
    "UTF-8 Markdown only",
    "Do not create or imply a ZIP/import/upload/crawl API",
    "Never put the target Mind's whole canonical corpus into the prompt",
  ]) {
    assert.match(MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK, new RegExp(expected, "u"));
  }
});
