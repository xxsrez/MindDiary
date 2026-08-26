import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function readRepositoryFile(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

test("MD-312 fixes the Release 0.2 readable-path profile without promoting deferred routes", async () => {
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
  assert.match(spec, /`implementation_status: implemented_repository_for_disk_workspace`/);
  const implementedKinds = new Set([
    "local_path",
    "workspace/generated_artifact",
  ]);
  for (const sourceKind of sourceKinds) {
    const row = spec.split("\n").find((line) => line.startsWith(`| \`${sourceKind}\` |`));
    if (implementedKinds.has(sourceKind)) {
      assert.ok(row?.includes("Release 0.2 `implemented_repository`"), `Release 0.2 companion status missing: ${sourceKind}`);
      assert.ok(row?.includes("MD-325"), `joined evidence owner missing: ${sourceKind}`);
    } else {
      assert.ok(row?.includes("Release 0.3 `not_available`"), `source must remain deferred: ${sourceKind}`);
    }
  }
  assert.match(spec, /explicit readable absolute path on the current Codex execution host/);
  assert.match(spec, /Missing path сам по себе не доказывает cross-host origin/);
  assert.match(spec, /Absolute path не входит в hosted request, error, audit/);
  assert.match(spec, /URL, base64, provider object.*не используются как fallback/s);
  for (const code of [
    "file_ingress_source_unavailable",
    "file_ingress_source_unsupported",
    "local_companion_file_changed",
    "local_companion_ref_expired",
  ]) {
    assert.ok(spec.includes(code), `missing readable-path outcome: ${code}`);
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
  assert.match(spec, /One staged\/canonical BundleFile.*268,435,456 bytes \(256 MiB\), inclusive/);
  assert.match(spec, /Staged bytes referenced by one changeset.*268,435,456 bytes \(256 MiB\)/);
  assert.match(spec, /Byte 268,435,457 fails/);
  assert.match(spec, /4,194,304 bytes \(4 MiB\)/);
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
  for (const tool of [
    "get_file_ingress_capabilities",
    "reconcile_file_stage",
    "reconcile_changeset",
  ]) {
    assert.ok(spec.includes(tool), `missing file-ingress tool contract: ${tool}`);
    assert.ok(api.includes(tool), `missing API tool contract: ${tool}`);
  }
});
