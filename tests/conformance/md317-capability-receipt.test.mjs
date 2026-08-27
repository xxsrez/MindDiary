import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const receiptUrl = new URL(
  "../fixtures/md317-capability/receipt.v1.json",
  import.meta.url,
);
const receipt = JSON.parse(await readFile(receiptUrl, "utf8"));

const expectedAssertionIds = [
  "MD317-DESKTOP-NATIVE-SCHEMA",
  "MD317-DESKTOP-HOST-PICKER-BRIDGE",
  "MD317-INVALID-OBJECT",
  "MD317-DESKTOP-SAME-HOST-PATH",
  "MD317-COMPANION-PNG",
  "MD317-COMPANION-UNKNOWN-BINARY",
  "MD317-UNAVAILABLE-PATH",
  "MD317-SIZE-MISMATCH",
  "MD317-EXPIRY",
  "MD317-UAT-DEFERRED-SOURCES",
  "MD317-OTHER-PLUGIN-BRIDGE-SCHEMA",
  "MD317-CHATGPT-WORK-PROFILE",
];

function collectKeys(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, result);
    return result;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      result.push(key);
      collectKeys(item, result);
    }
  }
  return result;
}

test("MD-317 receipt has a closed profile and assertion matrix", () => {
  assert.equal(
    receipt.schema,
    "mind-diary/md317-host-file-capability-receipt/v1",
  );
  assert.equal(Date.parse(receipt.captured_at) > 0, true);
  assert.deepEqual(
    receipt.server_capabilities.map(({ source_kind }) => source_kind),
    [
      "session_attachment",
      "local_path",
      "workspace/generated_artifact",
      "connector_object",
      "bounded_in_memory",
      "server_generated",
    ],
  );
  assert.deepEqual(
    receipt.assertions.map(({ id }) => id),
    expectedAssertionIds,
  );
  assert.equal(new Set(expectedAssertionIds).size, expectedAssertionIds.length);
});

test("MD-317 success evidence is exact and unavailable routes are fail closed", () => {
  const assertions = new Map(
    receipt.assertions.map((assertion) => [assertion.id, assertion]),
  );
  for (const id of ["MD317-COMPANION-PNG", "MD317-COMPANION-UNKNOWN-BINARY"]) {
    const assertion = assertions.get(id);
    assert.match(assertion.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(Number.isSafeInteger(assertion.size) && assertion.size > 0, true);
  }
  for (const assertion of receipt.assertions.filter(
    ({ outcome }) => outcome === "not_available",
  )) {
    assert.equal(assertion.retryable, false);
    assert.equal(typeof assertion.error_code, "string");
  }
  assert.deepEqual(receipt.effects, {
    synthetic_only: true,
    temporary_staged_ref_count: 2,
    commit_changeset_call_count: 0,
    head_transition_count: 0,
    binding_mutation_count: 0,
    membership_mutation_count: 0,
    acl_mutation_count: 0,
    repository_mutation_during_probe: false,
    local_fixture_directory_removed: true,
  });
});

test("MD-317 receipt excludes private locators and credentials", () => {
  const forbiddenKeys = new Set([
    "path",
    "file_name",
    "filename",
    "file_id",
    "download_url",
    "upload_url",
    "staged_file_ref",
    "token",
    "credential",
    "email",
    "principal_id",
    "space_id",
  ]);
  assert.deepEqual(
    collectKeys(receipt).filter((key) => forbiddenKeys.has(key)),
    [],
  );
});
