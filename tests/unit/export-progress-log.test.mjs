import assert from "node:assert/strict";
import test from "node:test";
import { serializeSafeExportProgress } from "../../packages/composition-root/dist/export-progress-log.js";

const valid = Object.freeze({
  jobId: "job-export_0f275f16-f979-4e49-96e6-f4f38c16d61c",
  claimVersion: 1,
  stage: "inspect",
  completedEntries: 16,
  totalEntries: 162,
});

test("export progress log contains only an exact server job ID and bounded counters", () => {
  assert.deepEqual(JSON.parse(serializeSafeExportProgress(valid)), {
    event: "mind-diary-export-progress",
    ...valid,
  });
  for (const invalid of [
    null,
    { ...valid, jobId: undefined },
    { ...valid, jobId: 42 },
    { ...valid, jobId: "job-export_token-secret" },
    { ...valid, claimVersion: 0 },
    { ...valid, claimVersion: -1 },
    { ...valid, claimVersion: 1.5 },
    { ...valid, completedEntries: -1 },
    { ...valid, completedEntries: 163 },
    { ...valid, totalEntries: 65_536 },
    { ...valid, stage: "content" },
  ]) assert.equal(serializeSafeExportProgress(invalid), null);
  assert.doesNotMatch(serializeSafeExportProgress({ ...valid, content: "private body" }), /private body/u);
  assert.deepEqual(JSON.parse(serializeSafeExportProgress({
    ...valid,
    stage: "failed",
    completedEntries: 0,
    totalEntries: 0,
    failureKind: "object_error",
    failureCode: "object_read_timeout",
    content: "private body",
  })), {
    event: "mind-diary-export-progress",
    ...valid,
    stage: "failed",
    completedEntries: 0,
    totalEntries: 0,
    failureKind: "object_error",
    failureCode: "object_read_timeout",
  });
  assert.doesNotMatch(serializeSafeExportProgress({
    ...valid,
    stage: "failed",
    failureKind: "private body",
    failureCode: "private body",
  }), /private body/u);
  assert.doesNotMatch(serializeSafeExportProgress({
    ...valid,
    stage: "failed",
    failureKind: "runtime_error",
    failureCode: "private_secret_value",
  }), /private_secret_value/u);
});
