import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryObjectStore,
  WebCryptoExportDownloadSecretGenerator,
} from "@mind-diary/adapter-object-memory";
import { CurrentAccessBackgroundAuthorizer } from "@mind-diary/application-ports";
import { version } from "@mind-diary/domain";

const now = "2026-08-07T00:00:00.000Z";

function serviceActor(capabilities = ["content:export"]) {
  return {
    kind: "service",
    serviceId: "export-worker",
    deploymentCapabilities: capabilities,
    requestId: "request-worker",
    occurredAtUtc: now,
  };
}

function state(overrides = {}) {
  return {
    principal: { principalId: "principal_export", state: "active" },
    space: {
      spaceId: "space_export",
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: "principal_export",
      spaceId: "space_export",
      role: "reader",
      state: "active",
      version: version(1),
    },
    token: null,
    ...overrides,
  };
}

test("background authorization rebuilds current access with no serialized token or role input", async () => {
  let current = state();
  const queries = [];
  const authorizer = new CurrentAccessBackgroundAuthorizer({
    readCurrentAuthorizationState: async (query) => {
      queries.push(query);
      return structuredClone(current);
    },
  });
  const request = {
    actor: serviceActor(),
    principalId: "principal_export",
    spaceId: "space_export",
    capability: "content:export",
    revisionMode: "historical",
  };
  assert.equal((await authorizer.authorize(request)).kind, "allowed");
  assert.deepEqual(queries, [{
    principalId: "principal_export",
    spaceId: "space_export",
    tokenId: null,
  }]);

  current = state({
    membership: { ...state().membership, principalId: "principal_other" },
  });
  assert.equal(
    (await authorizer.authorize(request)).code,
    "authorization_state_unavailable",
  );
  current = state({ membership: { ...state().membership, state: "revoked" } });
  assert.equal((await authorizer.authorize(request)).code, "access_denied");
  assert.equal(
    (await authorizer.authorize({
      ...request,
      actor: serviceActor([]),
    })).code,
    "deployment_capability_disabled",
  );
  assert.equal(
    (await authorizer.authorize({
      ...request,
      actor: { ...serviceActor(), kind: "registered_principal" },
    })).code,
    "authentication_required",
  );
});

test("export archives use claim-scoped immutable keys and job cleanup is repeatable", async () => {
  const objects = new InMemoryObjectStore();
  const bytes = new TextEncoder().encode("synthetic zip bytes");
  const sha256 = await objects.calculateSha256(bytes);
  const request = {
    jobId: "export_job_ports",
    spaceId: "space_export",
    claimVersion: version(2),
    bytes,
    sha256,
    createdAt: now,
  };
  const first = await objects.putExportArchive(request);
  assert.equal(first.kind, "stored");
  const replay = await objects.putExportArchive(request);
  assert.equal(replay.kind, "already_exists");
  assert.equal(replay.archive.objectKey, first.archive.objectKey);

  const different = new TextEncoder().encode("different bytes");
  assert.deepEqual(
    await objects.putExportArchive({
      ...request,
      bytes: different,
      sha256: await objects.calculateSha256(different),
    }),
    { kind: "object_key_collision" },
  );
  assert.equal(
    (await objects.putExportArchive({ ...request, claimVersion: version(3) })).kind,
    "stored",
  );
  assert.equal((await objects.listExportArchivesForTest()).length, 2);
  assert.equal(await objects.deleteExportArchivesForJob(request.jobId), 2);
  assert.equal(await objects.deleteExportArchivesForJob(request.jobId), 0);
});

test("download grant generator returns fresh canonical 256-bit opaque secrets", () => {
  const generator = new WebCryptoExportDownloadSecretGenerator();
  const secrets = new Set(
    Array.from({ length: 32 }, () => generator.nextExportDownloadSecret()),
  );
  assert.equal(secrets.size, 32);
  for (const secret of secrets) {
    assert.match(secret, /^mdg_v1_[A-Za-z0-9_-]{43}$/u);
    assert.equal(secret.length, 50);
  }
});
