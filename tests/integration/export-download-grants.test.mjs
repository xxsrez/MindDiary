import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundServiceActor } from "@mind-diary/adapter-background";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { createWebCryptoExportDownloadSecretCrypto } from "@mind-diary/adapter-security-webcrypto";
import { ExportJobHandler } from "@mind-diary/application-background";
import {
  CanonicalRevisionCoordinator,
  DeterministicOkfExportService,
  ExportJobApplicationService,
  MAX_EXPORT_DOWNLOAD_GRANT_TTL_MS,
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
  createFixtureClock,
} from "@mind-diary/test-fixtures";

const TOKEN_ID = "token_export_download";
const TOKEN_EXPIRY = "2026-11-03T12:00:00.000Z";
const EXPORT_DOWNLOAD_TEST_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 63,
);

function at(offsetMs) {
  return new Date(Date.parse(FIXED_NOW) + offsetMs).toISOString();
}

function actor(principalId = PRINCIPALS.editor.principalId, occurredAtUtc = FIXED_NOW) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      effectiveScopes: ["content:read"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_export_download",
    occurredAtUtc,
  };
}

function serviceActor(occurredAtUtc = FIXED_NOW) {
  return createBackgroundServiceActor({
    serviceId: "export-download-handler",
    requestId: "request_export_download_handler",
    occurredAtUtc,
    deploymentCapabilities: ["content:export"],
  });
}

function authorizationState(currentActor, options = {}) {
  const visibility = options.visibility ?? "private";
  const membership = options.membership === undefined
    ? {
        principalId: currentActor.principalId,
        spaceId: MINDS.ordinary.spaceId,
        role: "reader",
        state: "active",
        version: version(1),
      }
    : options.membership;
  return {
    principal: { principalId: currentActor.principalId, state: "active" },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility,
      accessVersion: options.accessVersion ?? version(1),
    },
    membership,
    token: options.withToken === false
      ? null
      : {
          tokenId: TOKEN_ID,
          principalId: currentActor.principalId,
          state: "active",
          scopes: ["content:read"],
          version: options.tokenVersion ?? version(1),
          expiresAt: TOKEN_EXPIRY,
        },
  };
}

function canonicalSecret(character) {
  const bytes = Uint8Array.from(
    { length: 32 },
    () => character.codePointAt(0),
  );
  return `mdg_v1_${Buffer.from(bytes).toString("base64url")}`;
}

class SequenceSecrets {
  constructor(values) {
    this.values = values.map((value) =>
      Uint8Array.from(Buffer.from(value.slice("mdg_v1_".length), "base64url"))
    );
    this.onNext = null;
    this.subtle = globalThis.crypto.subtle;
  }

  getRandomValues(target) {
    this.onNext?.();
    this.onNext = null;
    const next = this.values.shift();
    if (!next) throw new Error("download secret fixture exhausted");
    target.set(next);
    return target;
  }
}

async function harness(options = {}) {
  const clock = createFixtureClock(FIXED_NOW);
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed export download grants",
    files: CANONICAL_REVISION_FILES,
  });
  const currentActor = actor();
  const initial = authorizationState(currentActor, {
    visibility: options.visibility,
    membership: options.membership,
  });
  const setState = (state) => {
    metadata.setCurrentAuthorizationStateForTest(
      {
        principalId: currentActor.principalId,
        spaceId: MINDS.ordinary.spaceId,
        tokenId: TOKEN_ID,
      },
      state,
    );
    metadata.setCurrentAuthorizationStateForTest(
      {
        principalId: currentActor.principalId,
        spaceId: MINDS.ordinary.spaceId,
        tokenId: null,
      },
      state === null ? null : { ...state, token: null },
    );
  };
  setState(initial);
  const baseAuthorizer = new CapabilityAuthorizer(metadata);
  let afterTransactionalAuthorization = null;
  const authorizer = options.afterTransactionalAuthorization
    ? {
        authorize: (request) => baseAuthorizer.authorize(request),
        reauthorizeInTransaction: async (request, transaction, expected) => {
          const decision = await baseAuthorizer.reauthorizeInTransaction(
            request,
            transaction,
            expected,
          );
          if (decision.kind === "allowed" && afterTransactionalAuthorization) {
            afterTransactionalAuthorization({
              currentActor,
              initial,
              setState,
            });
          }
          return decision;
        },
      }
    : baseAuthorizer;
  const backgroundAuthorizer = new CurrentAccessBackgroundAuthorizer(metadata);
  const secrets = options.secrets ?? new SequenceSecrets([
    canonicalSecret("A"),
    canonicalSecret("B"),
    canonicalSecret("C"),
  ]);
  const downloadSecretCrypto = await createWebCryptoExportDownloadSecretCrypto({
    verifierKey: EXPORT_DOWNLOAD_TEST_KEY,
    crypto: secrets,
  });
  const applicationDigest = Object.freeze({
    calculateSha256: async (bytes) => {
      options.onApplicationDigest?.(new Uint8Array(bytes));
      return objects.calculateSha256(bytes);
    },
  });
  const archiveReader = Object.freeze({
    readExportArchive: async (objectKey) => {
      options.onArchiveRead?.(objectKey);
      return objects.readExportArchive(objectKey);
    },
  });
  const application = new ExportJobApplicationService({
    authorizer,
    backgroundAuthorizer,
    metadata,
    digest: applicationDigest,
    archives: archiveReader,
    clock,
    jobIds: { nextExportJobId: () => "export_download_job" },
    downloadSecretCrypto,
    downloadUrlBase: "https://downloads.invalid/export-grants",
    retentionMs: options.retentionMs ?? 60_000,
    downloadGrantTtlMs: options.downloadGrantTtlMs ?? 5_000,
  });
  const builder = new DeterministicOkfExportService({
    materializer: revisions,
    digest: objects,
  });
  const worker = new ExportJobHandler({
    jobs: metadata,
    backgroundAuthorizer,
    builder,
    archives: objects,
    clock,
  });
  const started = await application.start({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionSelector: { kind: "head" },
    idempotencyKey: "export-download-key",
  });
  assert.equal(started.kind, "started");
  assert.deepEqual(
    await worker.handle({ actor: serviceActor(), jobId: started.job.jobId }),
    { kind: "completed" },
  );
  afterTransactionalAuthorization = options.afterTransactionalAuthorization ?? null;
  return {
    application,
    clock,
    currentActor,
    initial,
    metadata,
    objects,
    secrets,
    setState,
    jobId: started.job.jobId,
  };
}

function secretFromUrl(url) {
  return new URL(url).pathname.split("/").at(-1);
}

test("Reader and public/unlisted baseline Readers receive exact no-store downloads", async (t) => {
  const cases = [
    { name: "membership Reader", visibility: "private", membership: undefined },
    { name: "public baseline Reader", visibility: "public", membership: null },
    { name: "unlisted baseline Reader", visibility: "unlisted", membership: null },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = await harness(scenario);
      const status = await env.application.getStatus({
        actor: env.currentActor,
        jobId: env.jobId,
      });
      assert.equal(status.kind, "found");
      assert.equal(status.job.revisionId, REVISIONS.initial.revisionId);
      assert.equal(status.job.archive.archiveFormat, "MD-OKF-ZIP-1");
      assert.equal(status.download.expiresAt, at(5_000));
      const secret = secretFromUrl(status.download.url);
      const downloaded = await env.application.download({
        actor: serviceActor(),
        secret,
      });
      assert.equal(downloaded.kind, "download");
      assert.deepEqual(downloaded.response.headers, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="mind-diary-okf-bundle.zip"',
        "Content-Length": String(status.job.archive.size),
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      assert.equal(
        await env.objects.calculateSha256(downloaded.response.bytes),
        status.job.archive.sha256,
      );
      const [grant] = await env.metadata.listExportDownloadGrantsForTest();
      const durable = JSON.stringify(grant);
      assert.doesNotMatch(durable, /https:|mdg_v1_|download_url|downloadUrl|secret[^V]/iu);
      assert.doesNotMatch(
        JSON.stringify(status.job),
        /objectKey|downloadUrl|download_url|"url"|secret|bytes/iu,
      );
    });
  }
});

test("grant bearer material never crosses the application object digest or archive boundary", async () => {
  const digestInputs = [];
  const archiveReads = [];
  const env = await harness({
    onApplicationDigest: (bytes) => digestInputs.push(new TextDecoder().decode(bytes)),
    onArchiveRead: (objectKey) => archiveReads.push(objectKey),
  });
  const status = await env.application.getStatus({
    actor: env.currentActor,
    jobId: env.jobId,
  });
  assert.equal(status.kind, "found");
  const secret = secretFromUrl(status.download.url);
  assert.match(secret, /^mdg_v1_[A-Za-z0-9_-]{43}$/u);

  const downloaded = await env.application.download({
    actor: serviceActor(),
    secret,
  });
  assert.equal(downloaded.kind, "download");
  assert.equal(digestInputs.length, 1);
  assert.match(digestInputs[0], /mind-diary-start-export-request-v1/u);
  assert.ok(digestInputs.every((input) => !input.includes(secret)));
  assert.ok(digestInputs.every((input) => !input.includes("mdg_v1_")));
  assert.equal(archiveReads.length, 1);
  assert.ok(archiveReads.every((objectKey) => !objectKey.includes(secret)));
  assert.ok(archiveReads.every((objectKey) => !objectKey.includes("mdg_v1_")));
  assert.doesNotMatch(
    JSON.stringify(await env.metadata.listExportDownloadGrantsForTest()),
    /mdg_v1_/u,
  );
});

test("invalid locators and denied exact-revision status never create a grant", async (t) => {
  await t.test("malformed and unknown secrets", async () => {
    const env = await harness();
    for (const secret of [null, "", "mdg_v1_short", canonicalSecret("Z")]) {
      assert.deepEqual(
        await env.application.download({ actor: serviceActor(), secret }),
        { kind: "not_found" },
      );
    }
    assert.equal((await env.metadata.listExportDownloadGrantsForTest()).length, 0);
  });

  await t.test("membership revoke between build and grant", async () => {
    const env = await harness();
    env.setState(authorizationState(env.currentActor, {
      membership: { ...env.initial.membership, state: "revoked", version: version(2) },
      accessVersion: version(2),
    }));
    assert.deepEqual(
      await env.application.getStatus({ actor: env.currentActor, jobId: env.jobId }),
      { kind: "not_found" },
    );
    assert.equal((await env.metadata.listExportDownloadGrantsForTest()).length, 0);
  });

  await t.test("source MCP token revoke between build and grant", async () => {
    const env = await harness();
    const revoked = authorizationState(env.currentActor, {
      membership: env.initial.membership,
      tokenVersion: version(2),
    });
    env.setState({
      ...revoked,
      token: { ...revoked.token, state: "revoked" },
    });
    assert.deepEqual(
      await env.application.getStatus({ actor: env.currentActor, jobId: env.jobId }),
      { kind: "not_found" },
    );
    assert.equal((await env.metadata.listExportDownloadGrantsForTest()).length, 0);
  });

  await t.test("baseline visibility switch to private between build and grant", async () => {
    const env = await harness({ visibility: "public", membership: null });
    env.setState(authorizationState(env.currentActor, {
      visibility: "private",
      membership: null,
      accessVersion: version(2),
    }));
    assert.deepEqual(
      await env.application.getStatus({ actor: env.currentActor, jobId: env.jobId }),
      { kind: "not_found" },
    );
    assert.equal((await env.metadata.listExportDownloadGrantsForTest()).length, 0);
  });
});

test("grant retry handles a secret collision and every URL expires independently", async () => {
  const secretA = canonicalSecret("A");
  const secretB = canonicalSecret("B");
  const env = await harness({
    secrets: new SequenceSecrets([secretA, secretA, secretB]),
    downloadGrantTtlMs: 1_000,
  });
  const first = await env.application.getStatus({
    actor: env.currentActor,
    jobId: env.jobId,
  });
  const retried = await env.application.getStatus({
    actor: env.currentActor,
    jobId: env.jobId,
  });
  assert.equal(first.kind, "found");
  assert.equal(retried.kind, "found");
  assert.notEqual(first.download.url, retried.download.url);
  assert.equal((await env.metadata.listExportDownloadGrantsForTest()).length, 2);

  env.clock.set(at(1_000));
  for (const status of [first, retried]) {
    assert.deepEqual(
      await env.application.download({
        actor: serviceActor(at(1_000)),
        secret: secretFromUrl(status.download.url),
      }),
      { kind: "not_found" },
    );
  }
  assert.deepEqual(
    (await env.metadata.listExportDownloadGrantsForTest()).map((grant) => grant.state),
    ["expired", "expired"],
  );
  assert.equal((await env.metadata.readExportJob(env.jobId)).state, "succeeded");
});

test("authorization race during issuance is fail closed with no durable candidate", async () => {
  const secrets = new SequenceSecrets([canonicalSecret("R")]);
  const env = await harness({ secrets });
  secrets.onNext = () => env.setState(authorizationState(env.currentActor, {
    membership: { ...env.initial.membership, state: "revoked", version: version(2) },
    accessVersion: version(2),
  }));
  assert.deepEqual(
    await env.application.getStatus({ actor: env.currentActor, jobId: env.jobId }),
    { kind: "not_found" },
  );
  assert.equal((await env.metadata.listExportDownloadGrantsForTest()).length, 0);
  assert.equal((await env.metadata.readExportJob(env.jobId)).state, "succeeded");
  assert.equal((await env.objects.listExportArchivesForTest()).length, 1);
});

test("post-transaction authorization race revokes the unexposed grant candidate", async () => {
  const env = await harness({
    secrets: new SequenceSecrets([canonicalSecret("F")]),
    afterTransactionalAuthorization: ({ currentActor, initial, setState }) => {
      setState(authorizationState(currentActor, {
        membership: { ...initial.membership, state: "revoked", version: version(2) },
        accessVersion: version(2),
      }));
    },
  });
  assert.deepEqual(
    await env.application.getStatus({ actor: env.currentActor, jobId: env.jobId }),
    { kind: "not_found" },
  );
  const [candidate] = await env.metadata.listExportDownloadGrantsForTest();
  assert.equal(candidate.state, "revoked");
  assert.equal(candidate.revokedAt, FIXED_NOW);
  assert.equal((await env.metadata.readExportJob(env.jobId)).state, "succeeded");
  assert.equal((await env.objects.listExportArchivesForTest()).length, 1);
});

test("revoked/private-switched grants and missing archives fail closed with final state", async (t) => {
  for (const scenario of ["revoked-membership", "private-switch"]) {
    await t.test(scenario, async () => {
      const baseline = scenario === "private-switch";
      const env = await harness({
        visibility: baseline ? "public" : "private",
        membership: baseline ? null : undefined,
      });
      const status = await env.application.getStatus({
        actor: env.currentActor,
        jobId: env.jobId,
      });
      assert.equal(status.kind, "found");
      env.setState(authorizationState(env.currentActor, baseline
        ? { visibility: "private", membership: null, accessVersion: version(2) }
        : {
            membership: { ...env.initial.membership, state: "revoked", version: version(2) },
            accessVersion: version(2),
          }));
      assert.deepEqual(
        await env.application.download({
          actor: serviceActor(),
          secret: secretFromUrl(status.download.url),
        }),
        { kind: "not_found" },
      );
      const [grant] = await env.metadata.listExportDownloadGrantsForTest();
      assert.equal(grant.state, "revoked");
      assert.equal((await env.metadata.readExportJob(env.jobId)).state, "succeeded");
      assert.equal((await env.objects.listExportArchivesForTest()).length, 1);
    });
  }

  await t.test("archive removed after grant", async () => {
    const env = await harness();
    const status = await env.application.getStatus({
      actor: env.currentActor,
      jobId: env.jobId,
    });
    const job = await env.metadata.readExportJob(env.jobId);
    assert.equal(await env.objects.deleteExportArchive(job.archive.objectKey), true);
    assert.deepEqual(
      await env.application.download({
        actor: serviceActor(),
        secret: secretFromUrl(status.download.url),
      }),
      { kind: "not_found" },
    );
    const [grant] = await env.metadata.listExportDownloadGrantsForTest();
    assert.equal(grant.state, "revoked");
    assert.equal((await env.metadata.readExportJob(env.jobId)).state, "succeeded");
  });
});

test("download grant configuration rejects unbounded TTL and unsafe URL bases", () => {
  const dependencies = {
    authorizer: {},
    backgroundAuthorizer: {},
    metadata: {},
    digest: {},
    archives: {},
    clock: {},
    jobIds: {},
    downloadSecretCrypto: {},
    downloadUrlBase: "https://downloads.invalid/export-grants",
  };
  for (const downloadGrantTtlMs of [0, MAX_EXPORT_DOWNLOAD_GRANT_TTL_MS + 1]) {
    assert.throws(
      () => new ExportJobApplicationService({ ...dependencies, downloadGrantTtlMs }),
      /lifetime must be positive and bounded/u,
    );
  }
  assert.doesNotThrow(() => new ExportJobApplicationService({
    ...dependencies,
    downloadUrlBase: "http://localhost:3000/api/v1/exports",
  }));
  for (const downloadUrlBase of [
    "http://downloads.invalid/grants",
    "https://user:secret@downloads.invalid/grants",
    "not-a-url",
  ]) {
    assert.throws(
      () => new ExportJobApplicationService({ ...dependencies, downloadUrlBase }),
      /safe absolute HTTPS or loopback HTTP URL|absolute HTTPS URL/u,
    );
  }
});
