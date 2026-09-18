import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function readRepositoryFile(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

test("MD-466 replaces caller-selected source classes with one file input", async () => {
  const [spec, adr, report] = await Promise.all([
    readRepositoryFile("docs/specs/file-ingress.md"),
    readRepositoryFile("docs/decisions/0030-single-file-input.md"),
    readRepositoryFile("docs/reports/2026-09-18-file-input-contract-probe.md"),
  ]);

  assert.match(spec, /Действующее изменение 2026-09-18/u);
  assert.match(spec, /один\s+`stage_bundle_file` с `openai\/fileParams`/u);
  assert.match(spec, /Internal legacy provenance/u);
  assert.match(adr, /Шесть значений были архитектурной классификацией Mind Diary/u);
  assert.match(adr, /Fresh `create_file_upload_intent` больше не принимает/u);
  assert.match(adr, /`get_file_ingress_capabilities` сообщает реальные transports и limits/u);
  assert.match(adr, /полностью заменяет отдельный Apps endpoint/u);
  assert.match(report, /size \| `81`/u);
  assert.match(report, /17df3b2e7b539859517289b61da45d7807c53d9a3c15a4d71a6e7a9f847864ca/u);
  assert.match(report, /`not_yet_tested`, а не\s+`unsupported`/u);
});

test("single file input preserves the bounded staged-ref security boundary", async () => {
  const [spec, adr, api] = await Promise.all([
    readRepositoryFile("docs/specs/file-ingress.md"),
    readRepositoryFile("docs/decisions/0030-single-file-input.md"),
    readRepositoryFile("docs/specs/api.md"),
  ]);

  assert.match(spec, /staged_file_ref/);
  assert.match(adr, /bounded staging/u);
  for (const text of [spec, adr]) {
    assert.match(text, /provider ID|Provider file ID/i);
    assert.match(text, /temporary URL|временный URL/i);
    assert.match(text, /local path|локальный путь/i);
    assert.match(text, /atomic/i);
    assert.match(text, /base64/i);
  }
  assert.match(adr, /256 MiB/u);
  assert.match(adr, /current ACL/u);
  assert.match(adr, /HEAD CAS/u);
  for (const tool of [
    "get_file_ingress_capabilities",
    "create_file_upload_intent",
    "stage_bundle_file",
    "reconcile_file_stage",
    "reconcile_changeset",
  ]) {
    assert.ok(adr.includes(tool), `missing current file-ingress operation: ${tool}`);
    assert.ok(api.includes(tool), `missing API operation: ${tool}`);
  }
});
