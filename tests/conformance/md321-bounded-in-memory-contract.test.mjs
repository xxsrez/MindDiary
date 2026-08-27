import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { GENERATED_ARTIFACT_LIMITS } from "@mind-diary/application-content";
import { createBoundedInMemoryIngressAdapter } from "@mind-diary/composition-root";

const root = new URL("../../", import.meta.url);
const contract = JSON.parse(await readFile(
  new URL("tests/fixtures/md321-bounded-in-memory/contract.v1.json", root),
  "utf8",
));

function exactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

test("MD-321 contract fixes one private constructor-owned bytes boundary", () => {
  exactKeys(contract, [
    "$schema",
    "version",
    "release",
    "task",
    "status",
    "boundary",
    "admission",
    "shared_guards",
    "publication",
    "privacy",
    "evidence",
  ], "top-level MD-321 contract drifted");
  assert.equal(contract.$schema, "mind-diary/md321-bounded-in-memory-composition/v1");
  assert.equal(contract.version, 1);
  assert.equal(contract.release, "0.3");
  assert.equal(contract.task, "MD-321");
  assert.equal(contract.status, "repository_candidate_not_hosted_evidence");
  assert.deepEqual(contract.boundary, {
    runtime_property: "ProductSiteRuntime.boundedInMemoryIngress",
    operation: "stage",
    transport: "constructor_owned_uint8array",
    source_kind: "bounded_in_memory",
    public_http_route: null,
    mcp_tool: null,
    advertised_hosted_status: "not_available_until_late_uat",
  });
});

test("MD-321 contract binds the exact inclusive limit and rejects transport provenance", () => {
  assert.equal(
    contract.admission.max_bytes_inclusive,
    GENERATED_ARTIFACT_LIMITS.maxBoundedInMemoryBytes,
  );
  assert.equal(
    contract.admission.first_rejected_size,
    contract.admission.max_bytes_inclusive + 1,
  );
  assert.deepEqual(contract.admission.forbidden_inputs, [
    "source_kind_override",
    "provider_object_id",
    "provider_url",
    "local_path",
    "prompt",
    "credential",
  ]);
  assert.deepEqual(contract.shared_guards, [
    "safe_filename",
    "recomputed_sha256_size_media",
    "current_scope_acl_target",
    "quota_reservation",
    "quarantine_promotion",
    "idempotency",
    "expiry_and_reconcile",
  ]);
});

test("MD-321 adapter has one operation and rejects byte +1 before application", async () => {
  let called = false;
  const adapter = createBoundedInMemoryIngressAdapter({
    application: {
      async stageBoundedInMemory() {
        called = true;
        return { kind: "invalid", code: "must_not_run" };
      },
    },
  });
  assert.deepEqual(Object.keys(adapter), ["stage"]);
  assert.deepEqual(await adapter.stage({
    actor: {},
    spaceId: "space_contract",
    writeBindingId: "target_generation_contract",
    displayFilename: "contract.bin",
    bytes: new Uint8Array(contract.admission.first_rejected_size),
    idempotencyKey: "stage:md321-contract",
  }), {
    kind: "invalid",
    code: "generated_artifact_size_limit_exceeded",
  });
  assert.equal(called, false);
});

test("MD-321 evidence is runnable and product docs retain the no-advertise boundary", async () => {
  for (const path of [
    contract.evidence.unit,
    contract.evidence.integration,
    contract.evidence.conformance,
  ]) await access(new URL(path, root));

  assert.deepEqual(contract.publication, {
    stage_result: "verified_staged_file_ref_only",
    head_change: "explicit_atomic_commit_changeset_only",
  });
  assert.deepEqual(contract.privacy, {
    payload_logs: "forbidden",
    structured_content: "forbidden",
    model_context: "forbidden",
  });
  assert.equal(contract.evidence.late_uat_owner, "MD-290");

  for (const path of [
    "docs/specs/file-ingress.md",
    "docs/specs/api.md",
    "docs/specs/bundle-files.md",
    "docs/architecture.md",
  ]) {
    const document = await readFile(new URL(path, root), "utf8");
    assert.ok(document.includes("ProductSiteRuntime.boundedInMemoryIngress"), path);
    assert.ok(document.includes("not_available"), path);
  }
});
