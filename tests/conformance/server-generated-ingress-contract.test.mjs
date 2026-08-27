import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { MCP_TOOL_DEFINITIONS } from "@mind-diary/adapter-mcp";
import {
  CONTENT_COMMANDS,
  CONTENT_QUERIES,
  SERVER_GENERATED_INGRESS_LIMITS,
} from "@mind-diary/application-content";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function repositoryFile(path) {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

test("MD-322 evidence contract fixes the trusted stream, limit and lease boundary", async () => {
  assert.deepEqual(SERVER_GENERATED_INGRESS_LIMITS, {
    maxBytes: 268_435_456,
    producerLeaseMilliseconds: 600_000,
  });
  const [
    source,
    stagingSource,
    specification,
    architecture,
    traceability,
    coreEvidence,
    retryEvidence,
  ] = await Promise.all([
    repositoryFile("packages/application-content/src/server-generated-ingress.ts"),
    repositoryFile("packages/application-content/src/bundle-files.ts"),
    repositoryFile("docs/specs/file-ingress.md"),
    repositoryFile("docs/architecture.md"),
    repositoryFile("docs/specs/traceability.md"),
    repositoryFile("tests/integration/bundle-files-core.test.mjs"),
    repositoryFile("tests/integration/server-generated-composition.test.mjs"),
  ]);
  assert.match(source, /class TrustedServerGeneratedIngressService/u);
  assert.match(source, /AbortSignal\.any/u);
  assert.match(source, /Promise\.race/u);
  assert.match(source, /stageServerGenerated/u);
  assert.match(source, /bundleFileMediaType\(request\.expectedMediaType\)/u);
  assert.ok(
    source.indexOf("#reconciliation.reconcile") <
      source.indexOf("request.producer(Object.freeze"),
  );
  assert.match(specification, /Exact 268,435,456 bytes remain permitted/u);
  assert.match(specification, /byte 268,435,457[\s\S]*fail closed/u);
  assert.match(specification, /600-second producer lease/u);
  assert.match(specification, /uncertain same-key retry performs[\s\S]*no generation/u);
  assert.match(specification, /MIME essence[\s\S]*before `upload\.complete`/u);
  assert.ok(
    stagingSource.indexOf("expectedMediaType !== detected") <
      stagingSource.indexOf("await upload.complete({ sha256, size })"),
  );
  assert.match(architecture, /serverGeneratedIngress/u);
  assert.match(traceability, /FI6-ServerGeneratedComposition/u);
  assert.match(traceability, /"server-generated-composition"/u);
  assert.match(coreEvidence, /accepts exact 256 MiB and rejects byte 268435457/u);
  assert.match(coreEvidence, /completedBytes: 268_435_456/u);
  assert.match(coreEvidence, /overflowObjects\.evidence\.aborted, true/u);
  assert.match(retryEvidence, /assert\.equal\(producerInvocations, 1\)/u);
  assert.match(retryEvidence, /objectCallsAfterSuccess/u);
  assert.match(retryEvidence, /application\/pdf; charset=binary/u);
  assert.match(retryEvidence, /allocatedReservationsBeforeWrongMedia/u);
  assert.match(retryEvidence, /collectStagedBundleFilesForGc/u);
});

test("the internal request cannot carry bytes or source/provider identity", async () => {
  const source = await repositoryFile(
    "packages/application-content/src/server-generated-ingress.ts",
  );
  const request = /export interface StageTrustedServerGeneratedRequest \{([\s\S]*?)\n\}/u
    .exec(source)?.[1];
  assert.ok(request);
  for (const forbidden of [
    "bytes", "path", "url", "provider", "locator", "prompt", "jobId", "sourceKind",
  ]) assert.doesNotMatch(request, new RegExp(`\\b${forbidden}\\b`, "iu"), forbidden);
  for (const required of [
    "producer", "displayFilename", "expectedMediaType", "idempotencyKey",
    "writeBindingId", "expectedSize", "expectedSha256", "signal",
  ]) assert.match(request, new RegExp(`\\b${required}\\b`, "u"), required);
});

test("hosted composition exposes no customer route, MCP stage or MCP export claim", async () => {
  const [composition, api] = await Promise.all([
    repositoryFile("packages/composition-root/src/product-site.ts"),
    repositoryFile("docs/specs/api.md"),
  ]);
  assert.match(composition, /readonly serverGeneratedIngress/u);
  assert.match(composition, /new TrustedServerGeneratedIngressService/u);
  const toolNames = MCP_TOOL_DEFINITIONS.map(({ name }) => name);
  assert.equal(
    toolNames.some((name) => /server_generated|generated.*stage/iu.test(name)),
    false,
  );
  assert.equal(toolNames.some((name) => /export/iu.test(name)), false);
  assert.equal(
    [...CONTENT_QUERIES, ...CONTENT_COMMANDS].some((name) =>
      /server_generated|generated.*stage|export/iu.test(name)
    ),
    false,
  );
  assert.match(api, /capability row remains `not_available`/u);
  assert.match(api, /adds no MCP\/REST tool, route or export surface/u);
});
