import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function readRepositoryFile(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

test("MD-271 names every source kind with an explicit capability status", async () => {
  const spec = await readRepositoryFile("docs/specs/file-ingress.md");
  const sourceKinds = [
    "session_attachment",
    "local_path",
    "workspace/generated_artifact",
    "connector_object",
    "bounded_in_memory",
    "server_generated",
  ];

  for (const sourceKind of sourceKinds) {
    assert.ok(spec.includes(`| \`${sourceKind}\` |`), `missing source row: ${sourceKind}`);
  }
  assert.match(spec, /`implementation_status: partial_by_source`/);
  assert.match(spec, /`session_attachment`.*`implemented_local`/s);
  const implementedKinds = new Set([
    "local_path",
    "workspace/generated_artifact",
    "bounded_in_memory",
    "server_generated",
  ]);
  for (const sourceKind of sourceKinds.slice(1)) {
    const row = spec.split("\n").find((line) => line.startsWith(`| \`${sourceKind}\` |`));
    if (implementedKinds.has(sourceKind)) {
      assert.ok(row?.includes("`implemented_local`"), `local companion status missing: ${sourceKind}`);
    } else {
      assert.ok(row?.includes("`proposal`"), `source must remain proposal: ${sourceKind}`);
    }
    assert.ok(row?.includes("UAT pending") || row?.includes("pending") || row?.includes("not started") || row?.includes("not-started") || row?.includes("not-available"), `source status missing: ${sourceKind}`);
  }
  assert.doesNotMatch(spec, /workspace_generated_artifact/);
});

test("MD-271 preserves the portable staged-ref boundary and common limits", async () => {
  const [spec, adr, api] = await Promise.all([
    readRepositoryFile("docs/specs/file-ingress.md"),
    readRepositoryFile("docs/decisions/0018-file-ingress-contract-and-source-capability-matrix.md"),
    readRepositoryFile("docs/specs/api.md"),
  ]);

  for (const text of [spec, adr]) {
    assert.match(text, /VerifiedFileInput/);
    assert.match(text, /staged_file_ref/);
    assert.match(text, /Provider (?:file )?ID|provider IDs/i);
    assert.match(text, /temporary URL/i);
    assert.match(text, /local path/i);
    assert.match(text, /atomic/);
    assert.match(text, /silent base64/);
  }
  assert.match(spec, /67,108,864 bytes \(64 MiB\)/);
  assert.match(spec, /134,217,728 bytes \(128 MiB\)/);
  assert.match(spec, /268,435,456 bytes \(256 MiB\)/);
  assert.match(spec, /3,600 seconds \(60 minutes\)/);
  assert.match(spec, /600 seconds \(10 minutes\)/);
  for (const code of [
    "native_file_input_unsupported",
    "file_ingress_source_unsupported",
    "file_ingress_source_unavailable",
    "file_ingress_transport_unavailable",
    "file_ingress_intent_expired",
    "file_ingress_intent_conflict",
  ]) {
    assert.ok(spec.includes(code), `missing error code in file-ingress contract: ${code}`);
    assert.ok(api.includes(code), `missing error code in API contract: ${code}`);
  }
});
