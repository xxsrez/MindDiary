import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundServiceActor } from "@mind-diary/adapter-background";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import {
  InMemoryObjectStore,
  WebCryptoExportDownloadSecretGenerator,
} from "@mind-diary/adapter-object-memory";
import { ExportJobHandler } from "@mind-diary/application-background";
import {
  CanonicalRevisionCoordinator,
  DeterministicOkfExportService,
  ExportJobApplicationService,
} from "@mind-diary/application-content";
import {
  CapabilityAuthorizer,
  CurrentAccessBackgroundAuthorizer,
} from "@mind-diary/application-ports";
import { CAPABILITIES, version } from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

test("durable export status contract contains safe metadata only and never embeds the archive", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Export job conformance fixture",
    files: CANONICAL_REVISION_FILES,
  });
  const actor = {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: "token_export_contract",
      effectiveScopes: ["content:read"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_export_contract",
    occurredAtUtc: FIXED_NOW,
  };
  const shared = {
    principal: { principalId: actor.principalId, state: "active" },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role: "reader",
      state: "active",
      version: version(1),
    },
  };
  metadata.setCurrentAuthorizationStateForTest(
    { principalId: actor.principalId, spaceId: MINDS.ordinary.spaceId, tokenId: actor.authentication.tokenId },
    {
      ...shared,
      token: {
        tokenId: actor.authentication.tokenId,
        principalId: actor.principalId,
        state: "active",
        scopes: ["content:read"],
        version: version(1),
        expiresAt: "2026-11-03T12:00:00.000Z",
      },
    },
  );
  metadata.setCurrentAuthorizationStateForTest(
    { principalId: actor.principalId, spaceId: MINDS.ordinary.spaceId, tokenId: null },
    { ...shared, token: null },
  );
  const clock = { now: () => FIXED_NOW };
  const application = new ExportJobApplicationService({
    authorizer: new CapabilityAuthorizer(metadata),
    backgroundAuthorizer: new CurrentAccessBackgroundAuthorizer(metadata),
    metadata,
    digest: objects,
    archives: objects,
    clock,
    jobIds: { nextExportJobId: () => "export_contract_job" },
    downloadSecrets: new WebCryptoExportDownloadSecretGenerator(),
    downloadUrlBase: "https://downloads.invalid/export-grants",
  });
  const started = await application.start({
    actor,
    spaceId: MINDS.ordinary.spaceId,
    revisionSelector: { kind: "head" },
    idempotencyKey: "export-contract-key",
  });
  assert.equal(started.kind, "started");
  assert.deepEqual(Object.keys(started.job).sort(), [
    "archive",
    "archiveCleanedAt",
    "attempts",
    "completedAt",
    "createdAt",
    "expiresAt",
    "jobId",
    "lastFailureCode",
    "revisionId",
    "status",
    "updatedAt",
  ]);
  assert.equal(started.job.archive, null);

  const builder = new DeterministicOkfExportService({
    materializer: revisions,
    digest: objects,
  });
  const worker = new ExportJobHandler({
    jobs: metadata,
    backgroundAuthorizer: new CurrentAccessBackgroundAuthorizer(metadata),
    builder,
    archives: objects,
    clock,
  });
  assert.deepEqual(
    await worker.handle({
      actor: createBackgroundServiceActor({
        serviceId: "export-contract-worker",
        requestId: "request_export_contract_worker",
        occurredAtUtc: FIXED_NOW,
        deploymentCapabilities: ["content:export"],
      }),
      jobId: started.job.jobId,
    }),
    { kind: "completed" },
  );
  const status = await application.getStatus({ actor, jobId: started.job.jobId });
  assert.equal(status.kind, "found");
  assert.deepEqual(Object.keys(status.job.archive).sort(), [
    "archiveFormat",
    "contentDisposition",
    "filename",
    "mediaType",
    "sha256",
    "size",
  ]);
  assert.match(status.download.url, /^https:\/\/downloads\.invalid\/export-grants\/mdg_v1_/u);
  const safeJson = JSON.stringify(status.job);
  assert.doesNotMatch(
    safeJson,
    /objectKey|requestedByPrincipalId|idempotencyKey|download|bytes|token|role/iu,
  );
  const [stored] = await metadata.listExportJobsForTest();
  assert.equal("token" in stored, false);
  assert.equal("role" in stored, false);
  assert.equal("downloadUrl" in stored, false);
  assert.equal("bytes" in stored, false);
  assert.equal((await objects.readExportArchive(stored.archive.objectKey)).byteLength > safeJson.length, true);

  const secret = new URL(status.download.url).pathname.split("/").at(-1);
  const [grant] = await metadata.listExportDownloadGrantsForTest();
  assert.equal(grant.revisionId, REVISIONS.initial.revisionId);
  assert.doesNotMatch(JSON.stringify(grant), /https:|mdg_v1_|download_url|downloadUrl/iu);
  const download = await application.download({
    actor: createBackgroundServiceActor({
      serviceId: "export-contract-download",
      requestId: "request_export_contract_download",
      occurredAtUtc: FIXED_NOW,
      deploymentCapabilities: ["content:export"],
    }),
    secret,
  });
  assert.equal(download.kind, "download");
  assert.deepEqual(download.response.headers, {
    "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="mind-diary-okf-bundle.zip"',
    "Content-Length": String(status.job.archive.size),
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  assert.equal(
    await objects.calculateSha256(download.response.bytes),
    status.job.archive.sha256,
  );
});
