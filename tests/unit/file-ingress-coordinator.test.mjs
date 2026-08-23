import assert from "node:assert/strict";
import test from "node:test";

import { FileIngressCoordinator } from "@mind-diary/application-content";

function record(sourceKind) {
  return {
    stagedFileId: `staged_${sourceKind}`,
    bindingOwnerId: "binding_owner_test",
    sourceKind,
    writeBindingId: "write_test",
    writeBindingGeneration: 1,
    spaceId: "space_test",
    displayFilename: "fixture.png",
    mediaType: "image/png",
    sha256: `sha256:${"a".repeat(64)}`,
    size: 10,
    state: "verified",
    createdAt: "2026-08-23T12:00:00.000Z",
    expiresAt: "2026-08-23T13:00:00.000Z",
    consumedAt: null,
    rejectionCode: null,
  };
}

function coordinator(adapters = {}) {
  return new FileIngressCoordinator({
    adapters,
    staging: {
      async reconcile(request) {
        return { kind: "stage_reconcile", request };
      },
    },
    commits: {
      async commit(request) {
        return { kind: "commit_delegate", request };
      },
      async reconcile(request) {
        return { kind: "commit_reconcile", request };
      },
    },
  });
}

test("capabilities expose all sources and never invent an absent adapter", () => {
  const service = coordinator({
    session_attachment: {
      async stage() {
        return { kind: "staged", record: record("session_attachment"), replayed: false };
      },
    },
    bounded_in_memory: {
      async stage() {
        return { kind: "staged", record: record("bounded_in_memory"), replayed: false };
      },
    },
  });
  assert.deepEqual(
    service.capabilities().map(({ sourceKind, status, fallback }) => [
      sourceKind,
      status,
      fallback,
    ]),
    [
      ["session_attachment", "available_local", "none"],
      ["local_path", "not_available", "none"],
      ["workspace/generated_artifact", "not_available", "none"],
      ["connector_object", "not_available", "none"],
      ["bounded_in_memory", "available_local", "none"],
      ["server_generated", "not_available", "none"],
    ],
  );
});

test("dispatch fails closed for unsupported, broken and source-mismatched adapters", async () => {
  const service = coordinator({
    session_attachment: {
      async stage() {
        return { kind: "staged", record: record("connector_object"), replayed: false };
      },
    },
    connector_object: {
      async stage() {
        throw new Error("provider unavailable");
      },
    },
  });
  assert.deepEqual(
    await service.stage({ sourceKind: "local_path", payload: {} }),
    { kind: "invalid", code: "file_ingress_source_unsupported" },
  );
  assert.deepEqual(
    await service.stage({ sourceKind: "connector_object", payload: {} }),
    { kind: "invalid", code: "file_ingress_transport_unavailable" },
  );
  assert.deepEqual(
    await service.stage({ sourceKind: "session_attachment", payload: {} }),
    { kind: "invalid", code: "file_ingress_source_mismatch" },
  );
});

test("commit and reconcile operations use their single owned delegates", async () => {
  const service = coordinator();
  const stage = { idempotencyKey: "stage-key" };
  const commit = { idempotencyKey: "commit-key" };
  assert.deepEqual(await service.reconcileStage(stage), {
    kind: "stage_reconcile",
    request: stage,
  });
  assert.deepEqual(await service.commit(commit), {
    kind: "commit_delegate",
    request: commit,
  });
  assert.deepEqual(await service.reconcileCommit(commit), {
    kind: "commit_reconcile",
    request: commit,
  });
});
