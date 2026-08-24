import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateOkfBundle } from "../../packages/okf-codec/dist/index.js";

import {
  BRAIN_FIXTURE_FILE_COUNT,
  BRAIN_FIXTURE_LOGICAL_BYTES,
  BRAIN_FIXTURE_MARKER,
  BRAIN_FIXTURE_MARKER_PATH,
  STORAGE_MATRIX_FIXTURE_SCHEMA,
  STORAGE_MATRIX_LINEAGE_SCHEMA,
  STORAGE_MATRIX_STATE_SCHEMA,
  StorageMatrixFailure,
  assertLineageTransition,
  canonical,
  classifyMcpEnvelope,
  createBrainMarkdownFixture,
  createImportBatches,
  createStorageMatrixEvidence,
  inspectDeterministicStoredZip,
  parseMcpHttpPayload,
  readPrivateState,
  sealPrivateState,
  sha256,
  validateLineageReceipt,
  writePrivateState,
} from "../../scripts/lib/uat-storage-matrix-core.mjs";
import {
  parseCli,
  recoveryNextPhase,
  run,
} from "../../scripts/run-uat-storage-matrix.mjs";

const CANDIDATE = "a".repeat(40);
const DEPLOYMENT_A = "appgdep_fixturea";
const DEPLOYMENT_B = "appgdep_fixtureb";

function lineage(deploymentId, overrides = {}) {
  return {
    schema: STORAGE_MATRIX_LINEAGE_SCHEMA,
    status: "succeeded",
    candidate_sha: CANDIDATE,
    site_project_id: "appgprj_fixture",
    site_version_id: deploymentId === DEPLOYMENT_A
      ? "appgver_fixturea"
      : "appgver_fixtureb",
    deployment_id: deploymentId,
    live_url: "https://mind-diary.example",
    observed_at_utc: deploymentId === DEPLOYMENT_A
      ? "2026-08-24T12:00:00.000Z"
      : "2026-08-24T12:05:00.000Z",
    ...overrides,
  };
}

function privateState({ status = "cleaned" } = {}) {
  const fixture = createBrainMarkdownFixture();
  return sealPrivateState({
    schema: STORAGE_MATRIX_STATE_SCHEMA,
    status,
    run_nonce: "0123456789abcdef",
    candidate_sha: CANDIDATE,
    prepared_lineage: lineage(DEPLOYMENT_A),
    observed_lineage: lineage(DEPLOYMENT_B),
    fixture: {
      schema: STORAGE_MATRIX_FIXTURE_SCHEMA,
      file_count: fixture.file_count,
      logical_bytes: fixture.logical_bytes,
      descriptor_sha256: fixture.descriptor_sha256,
      marker_sha256: fixture.marker_sha256,
    },
    dedicated_token: {
      name: "UAT Storage Matrix 0123456789abcdef",
      id_fingerprint: sha256("dedicated-token-id"),
    },
    mind: {
      handle: "uat-storage-0123456789abcdef",
      name: "UAT Storage Matrix 0123456789abcdef",
      initial_revision_id: "revision_fixture_initial",
    },
    import: {
      plan_id: "import_plan_fixture",
      import_id: "import_fixture",
      descriptor_hash: fixture.descriptor_sha256,
      logical_bytes: fixture.logical_bytes,
      file_count: fixture.file_count,
      total_batches: 7,
      interrupt_after_batches: 1,
      interrupted_checkpoint: 1,
      session_state: "committed",
      version: 39,
      checkpoint: 7,
      staged_file_count: fixture.file_count,
      staged_bytes: fixture.logical_bytes,
      validation_checkpoint: fixture.file_count,
      validated_bytes: fixture.logical_bytes,
      promotion_checkpoint: fixture.file_count,
      promoted_bytes: fixture.logical_bytes,
      committed_revision_id: "revision_fixture_committed",
      export_job_id: "job_fixture",
    },
    verification: {
      committed_file_count: fixture.file_count,
      committed_logical_bytes: fixture.logical_bytes,
      modern_fetch_sha256: fixture.marker_sha256,
      compat_fetch_sha256: fixture.marker_sha256,
      archive_sha256: sha256("archive"),
      archive_size: 6_000_000,
      export_entry_count: fixture.file_count,
      export_content_bytes: fixture.logical_bytes,
    },
    cleanup_completed_at_utc: "2026-08-24T12:10:00.000Z",
  });
}

test("Brain fixture is deterministic, exact-sized, validly bounded and split into multipart batches", () => {
  const first = createBrainMarkdownFixture();
  const second = createBrainMarkdownFixture();
  assert.equal(first.file_count, BRAIN_FIXTURE_FILE_COUNT);
  assert.equal(first.logical_bytes, BRAIN_FIXTURE_LOGICAL_BYTES);
  assert.equal(
    first.descriptor_sha256,
    "sha256:7474b051866bfc4fa6daa618454c5356f09b5ab7719287d6eee5b2a8846606a5",
  );
  assert.equal(second.descriptor_sha256, first.descriptor_sha256);
  assert.deepEqual(second.descriptors, first.descriptors);
  assert.equal(first.files.every(({ path }) => path.endsWith(".md")), true);
  assert.equal(first.files.every(({ size }) => size <= 1_048_576), true);
  const marker = first.files.find(({ path }) => path === BRAIN_FIXTURE_MARKER_PATH);
  assert.ok(marker?.text.includes(BRAIN_FIXTURE_MARKER));
  const batches = createImportBatches(first.files);
  assert.equal(batches.length, 7);
  assert.equal(batches.flat().length, first.file_count);
  assert.equal(batches.every((batch) => batch.length <= 256), true);
  assert.equal(
    batches.every((batch) => batch.reduce((total, file) => total + file.size, 0) <= 4_194_304),
    true,
  );
});

test("Brain fixture is a valid complete OKF 0.2 bundle", () => {
  const fixture = createBrainMarkdownFixture();
  const validation = validateOkfBundle(fixture.files.map(({ path, text }) => ({ path, text })));
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics.slice(0, 3)));
  assert.equal(validation.conformanceErrors.length, 0);
  assert.equal(validation.envelopeErrors.length, 0);
});

test("lineage parser requires exact succeeded receipts and a distinct same-candidate redeploy", () => {
  assert.deepEqual(validateLineageReceipt(lineage(DEPLOYMENT_A)), lineage(DEPLOYMENT_A));
  const transition = assertLineageTransition(lineage(DEPLOYMENT_A), lineage(DEPLOYMENT_B));
  assert.equal(transition.prepared.deployment_id, DEPLOYMENT_A);
  assert.equal(transition.observed.deployment_id, DEPLOYMENT_B);
  assert.throws(
    () => assertLineageTransition(lineage(DEPLOYMENT_A), lineage(DEPLOYMENT_A)),
    (error) => error instanceof StorageMatrixFailure && error.code === "redeploy_boundary_not_observed",
  );
  assert.throws(
    () => validateLineageReceipt({ ...lineage(DEPLOYMENT_A), status: "pending" }),
    (error) => error instanceof StorageMatrixFailure && error.code === "lineage_not_succeeded",
  );
  assert.throws(
    () => assertLineageTransition(
      lineage(DEPLOYMENT_A),
      lineage(DEPLOYMENT_B, { candidate_sha: "b".repeat(40) }),
    ),
    (error) => error instanceof StorageMatrixFailure && error.code === "lineage_candidate_mismatch",
  );
});

test("MCP parser handles JSON and SSE but treats HTTP 200 tool isError as failure", () => {
  const success = {
    jsonrpc: "2.0",
    id: 1,
    result: { isError: false, structuredContent: { ok: true, data: { value: 7 } } },
  };
  assert.deepEqual(parseMcpHttpPayload(JSON.stringify(success)), success);
  assert.deepEqual(
    parseMcpHttpPayload(`event: message\ndata: ${JSON.stringify(success)}\n\n`, "text/event-stream"),
    success,
  );
  assert.deepEqual(classifyMcpEnvelope(200, success), {
    kind: "success",
    status: 200,
    data: { value: 7 },
  });
  const semanticFailure = classifyMcpEnvelope(200, {
    jsonrpc: "2.0",
    id: 2,
    result: {
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "search_index_unavailable", retryable: true },
      },
    },
  });
  assert.deepEqual(semanticFailure, {
    kind: "failure",
    status: 200,
    code: "search_index_unavailable",
    retryable: true,
  });
});

test("private state is atomic 0600 and rejects tampering or broad permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-md288-state-"));
  const path = join(directory, "state.json");
  const state = privateState({ status: "verified" });
  const { state_sha256: _digest, ...unsigned } = state;
  await writePrivateState(path, unsigned, { exclusive: true });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readPrivateState(path)).status, "verified");

  const tampered = JSON.parse(await readFile(path, "utf8"));
  tampered.status = "cleaned";
  await writeFile(path, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(
    readPrivateState(path),
    (error) => error instanceof StorageMatrixFailure && error.code === "state_integrity_mismatch",
  );

  await writePrivateState(path, unsigned);
  await chmod(path, 0o644);
  await assert.rejects(
    readPrivateState(path),
    (error) => error instanceof StorageMatrixFailure && error.code === "state_file_permissions_too_broad",
  );
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

function minimalStoredZip(files) {
  const local = [];
  const central = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const bytes = Buffer.from(file.bytes);
    const checksum = crc32(bytes);
    const localEntry = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0x0021),
      uint32(checksum),
      uint32(bytes.length),
      uint32(bytes.length),
      uint16(name.length),
      uint16(0),
      name,
      bytes,
    ]);
    local.push(localEntry);
    central.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      uint16(0x0314),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0x0021),
      uint32(checksum),
      uint32(bytes.length),
      uint32(bytes.length),
      uint16(name.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0x81a40000),
      uint32(localOffset),
      name,
    ]));
    localOffset += localEntry.length;
  }
  const centralSize = central.reduce((total, entry) => total + entry.length, 0);
  const archive = new Uint8Array(Buffer.concat([
    ...local,
    ...central,
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      uint16(0),
      uint16(0),
      uint16(files.length),
      uint16(files.length),
      uint32(centralSize),
      uint32(localOffset),
      uint16(0),
    ]),
  ]));
  return { archive, centralOffset: localOffset };
}

test("stored ZIP inspector proves every exact exported entry digest and rejects corruption", () => {
  const encoder = new TextEncoder();
  const files = [
    { path: "index.md", bytes: encoder.encode("# Index\n") },
    { path: "log.md", bytes: encoder.encode("# Log\n") },
  ].map((file) => ({
    ...file,
    size: file.bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`,
  }));
  const fixture = { files };
  const { archive, centralOffset } = minimalStoredZip(files);
  const inspected = inspectDeterministicStoredZip(archive, fixture);
  assert.equal(inspected.entry_count, 2);
  assert.equal(inspected.content_bytes, files[0].size + files[1].size);
  assert.equal(inspected.archive_sha256, sha256(archive));

  const corrupted = Uint8Array.from(archive);
  corrupted[35] ^= 1;
  assert.throws(
    () => inspectDeterministicStoredZip(corrupted, fixture),
    (error) => error instanceof StorageMatrixFailure,
  );

  const bareCentralSignature = new Uint8Array(centralOffset + 4);
  bareCentralSignature.set(archive.subarray(0, centralOffset));
  bareCentralSignature.set([0x50, 0x4b, 0x01, 0x02], centralOffset);
  assert.throws(
    () => inspectDeterministicStoredZip(bareCentralSignature, fixture),
    (error) => error instanceof StorageMatrixFailure &&
      error.code === "export_zip_central_directory_missing",
  );
  assert.throws(
    () => inspectDeterministicStoredZip(archive.subarray(0, -22), fixture),
    (error) => error instanceof StorageMatrixFailure && error.code === "export_zip_eocd_missing",
  );
  const truncatedCentral = archive.subarray(0, archive.byteLength - 6);
  assert.throws(
    () => inspectDeterministicStoredZip(truncatedCentral, fixture),
    (error) => error instanceof StorageMatrixFailure &&
      new Set(["invalid_export_zip_eocd", "export_zip_eocd_missing"]).has(error.code),
  );
});

test("terminal evidence contains only lineage, counts and hashes and is content-addressed", () => {
  const state = privateState({ status: "cleaned_evidence_pending" });
  const evidence = createStorageMatrixEvidence({
    state,
    observedLineage: lineage(DEPLOYMENT_B),
    completedAt: "2026-08-24T12:10:00.000Z",
  });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.fixture.file_count, BRAIN_FIXTURE_FILE_COUNT);
  assert.equal(evidence.fixture.logical_bytes, BRAIN_FIXTURE_LOGICAL_BYTES);
  assert.equal(evidence.assertions.length, 11);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /revision_fixture|import_fixture|job_fixture/u);
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(serialized, /mdp_v1_/u);
  const { artifact_sha256: artifact, ...unsigned } = evidence;
  assert.equal(artifact, sha256(canonical(unsigned)));
});

test("recovery resumes staging until the bounded interrupt checkpoint exists", () => {
  assert.equal(recoveryNextPhase({
    status: "import_started",
    import: { checkpoint: 0, interrupt_after_batches: 1 },
  }), "start");
  assert.equal(recoveryNextPhase({
    status: "import_started",
    import: { checkpoint: 1, interrupt_after_batches: 1 },
  }), "interrupt");
  assert.equal(recoveryNextPhase({
    status: "cleaned_evidence_pending",
  }), "cleanup");
});

test("terminal receipt retry after a local write failure performs no network cleanup twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-md288-receipt-"));
  const statePath = join(directory, "state.json");
  const evidencePath = join(directory, "evidence.json");
  const pending = privateState({ status: "cleaned_evidence_pending" });
  const { state_sha256: _digest, ...unsigned } = pending;
  await writePrivateState(statePath, unsigned, { exclusive: true });
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("network cleanup must not repeat");
  };

  await assert.rejects(run({
    phase: "cleanup",
    state: statePath,
    evidence_out: statePath,
  }, { environment: {}, fetchImpl }), (error) =>
    error instanceof StorageMatrixFailure && error.code === "evidence_path_conflicts_with_state");
  assert.equal((await readPrivateState(statePath)).status, "cleaned_evidence_pending");

  await assert.rejects(run({
    phase: "cleanup",
    state: statePath,
    evidence_out: join(directory, "missing", "evidence.json"),
  }, { environment: {}, fetchImpl }));
  assert.equal((await readPrivateState(statePath)).status, "cleaned_evidence_pending");

  const completed = await run({
    phase: "cleanup",
    state: statePath,
    evidence_out: evidencePath,
  }, { environment: {}, fetchImpl });
  assert.equal(completed.status, "cleaned");
  assert.equal((await readPrivateState(statePath)).status, "cleaned");
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
  assert.equal(fetchCalls, 0);

  const replayed = await run({
    phase: "cleanup",
    state: statePath,
    evidence_out: evidencePath,
  }, { environment: {}, fetchImpl });
  assert.equal(replayed.artifact_sha256, completed.artifact_sha256);
  assert.equal(fetchCalls, 0);
});

test("CLI exposes explicit setup/start/interrupt/verify/cleanup/recover phases", () => {
  assert.equal(parseCli(["--phase", "recover", "--state", "state.json"]).phase, "recover");
  assert.equal(
    parseCli([
      "--phase", "start",
      "--state", "state.json",
      "--lineage", "a.json",
      "--interrupt-after-batches", "2",
    ]).interrupt_after_batches,
    2,
  );
  assert.throws(
    () => parseCli(["--phase", "verify", "--poll-timeout-ms", "999"]),
    (error) => error instanceof StorageMatrixFailure && error.code === "invalid_poll_timeout",
  );
});
