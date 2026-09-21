import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(
  new URL("../../packages/adapter-web/assets/markdown-import-client.js", import.meta.url),
  "utf8",
);

test("Markdown import recovery uses actor-owned server status and no browser storage", () => {
  assert.match(client, /new URLSearchParams\(location\.hash/u);
  assert.match(client, /json\("GET", `\/api\/v1\/markdown-imports/u);
  assert.match(client, /const current = await freshSession\(\);/u);
  assert.match(client, /sessionAttemptKey \?\?=/u);
  assert.match(client, /status_read_unavailable/u);
  assert.match(client, /recoveryPending/u);
  assert.match(client, /The saved import locator was kept/u);
  assert.match(client, /import_session_not_found/u);
  assert.doesNotMatch(client, /\b(?:localStorage|sessionStorage|indexedDB)\b/u);
});

test("Markdown import checks local shape and keeps server planning authoritative", () => {
  assert.match(client, /new TextDecoder\("utf-8", \{ fatal: true \}\)/u);
  assert.match(client, /local_path_conflict/u);
  assert.match(client, /local_format_conflict/u);
  assert.match(client, /projected_utilization/u);
  assert.match(client, /expected_revision_id: head/u);
  assert.match(client, /descriptor_hash !== descriptorHash/u);
});

test("Markdown import exposes bounded progress, cancel, replan, receipt and safe denial", () => {
  assert.match(client, /Math\.max\(0, Math\.min\(100/u);
  assert.match(client, /\/batches\/\$\{index \+ 1\}`,[\s\S]*method: "PUT"/u);
  assert.match(client, /"DELETE",[\s\S]*expected_version: session\.version/u);
  assert.match(client, /showReceipt\(/u);
  assert.match(client, /import_head_conflict/u);
  assert.match(client, /No operation details were shown/u);
  assert.doesNotMatch(client, /signed[_ -]?url|private[_ -]?path|storage[_ -]?key/iu);
});

test("Markdown import distinguishes capacity outcomes without exposing reservation internals", () => {
  assert.match(client, /Another heavy operation is active; retry same plan\/job after it finishes\./u);
  assert.match(client, /Storage headroom is low; clean up completed imports or exports, then retry the same plan\/job\./u);
  assert.match(client, /This snapshot exceeds the supported size or capacity; reduce it and create a new plan\./u);
  assert.match(client, /Storage accounting is being reconciled; retry same plan\/job after reconciliation finishes\./u);
  assert.match(client, /planAttemptKey \?\?= key\("import-plan"\)/u);
  assert.match(client, /sessionAttemptKey \?\?= key\("import-session"\)/u);
  assert.doesNotMatch(client, /reservation[_ -]?id|private[_ -]?job|object[_ -]?key/iu);
});
