import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  PrincipalMindUsageApplicationService,
} from "@mind-diary/application-control";
import {
  BundleFileStagingService,
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  LocalFileCompanion,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  REVISION_MANIFEST_FORMAT_V5,
  verifiedSpaceHost,
  version,
} from "@mind-diary/domain";
import {
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISIONS,
} from "@mind-diary/test-fixtures";
import { createNodeLocalCompanionFileSystem } from "../../scripts/local-companion-node-filesystem.mjs";
import { createMindDiaryLocalCompanionRuntime } from "../../scripts/local-companion-runtime.mjs";

const PUBLIC_ORIGIN = "https://mind-diary.invalid";
const UPLOAD_URL = `${PUBLIC_ORIGIN}/api/file-ingress/v1/upload-intents/mdupload_v1_0123456789abcdef`;
const LATER = "2026-08-25T13:00:00.000Z";
const EXPIRY = "2026-11-05T12:00:00.000Z";
const TOKEN_ID = "token_local_companion";
const BINDING_OWNER_ID = "binding_owner_local_companion";

function sha(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function staged(prepared, overrides = {}) {
  return {
    staged_file_ref: "staged_local_companion",
    state: "verified",
    source_kind: prepared.source_kind,
    display_filename: prepared.display_filename,
    media_type: prepared.claimed_media_type,
    sha256: prepared.expected_sha256,
    size: prepared.expected_size,
    expires_at: LATER,
    replayed: false,
    ...overrides,
  };
}

function nextRefs() {
  let value = 0;
  return () => `mdlocal_v1_${String(++value).padStart(16, "0")}`;
}

test("Node companion prepares arbitrary regular formats and rejects directory, final symlink and special files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-formats-"));
  try {
    const fixtures = new Map([
      ["fixture.docx", [Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
      ["photo.heic", [new TextEncoder().encode("....ftypheic...."), "image/heic"]],
      ["book.epub", [Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 2]), "application/epub+zip"]],
      ["voice.opus", [new TextEncoder().encode("OggS....OpusHead"), "audio/opus"]],
      ["unsafe.html", [new TextEncoder().encode("<script>alert(1)</script>"), "text/html"]],
      ["analysis.ipynb", [new TextEncoder().encode('{"cells":[],"nbformat":4}'), "application/x-ipynb+json"]],
      ["unknown.bin", [Uint8Array.from([0, 255, 17, 99, 4]), "application/octet-stream"]],
    ]);
    for (const [name, [bytes]] of fixtures) await writeFile(join(root, name), bytes);
    const directory = join(root, "directory");
    const symlink = join(root, "final-link.bin");
    const fifo = join(root, "special.fifo");
    await mkdir(directory);
    await (await import("node:fs/promises")).symlink(join(root, "unknown.bin"), symlink);
    const fifoResult = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(fifoResult.status, 0, fifoResult.stderr);

    const companion = new LocalFileCompanion({
      filesystem: createNodeLocalCompanionFileSystem({ localRoots: [root] }),
      transport: { async upload() { throw new Error("not used"); } },
      nextLocalFileRef: nextRefs(),
    });
    for (const [name, [bytes, media]] of fixtures) {
      const result = await companion.prepare_local_file({
        path: join(root, name),
        claimed_media_type: media,
        expected_size: bytes.byteLength,
        expected_sha256: sha(bytes),
      });
      assert.equal(result.kind, "prepared", name);
      assert.equal(result.prepared_file.display_filename, name);
      assert.equal(result.prepared_file.claimed_media_type, media);
      assert.equal(result.prepared_file.expected_sha256, sha(bytes));
    }
    for (const path of [directory, symlink, fifo]) {
      assert.deepEqual(await companion.prepare_local_file({ path }), {
        kind: "invalid",
        code: "file_ingress_source_unsupported",
      });
    }
    await companion.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority rejects a parent-symlink swap between descriptor open and path resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-authority-race-"));
  try {
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    const pivot = join(root, "pivot");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(allowed, "selected.bin"), "allowed bytes");
    await writeFile(join(outside, "selected.bin"), "outside private bytes");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, pivot);
    let swapped = false;
    let transportCalls = 0;
    const companion = new LocalFileCompanion({
      filesystem: createNodeLocalCompanionFileSystem({
        localRoots: [allowed],
        async beforeAuthorityCheck() {
          assert.equal(swapped, false);
          await rm(pivot, { force: true });
          await symlink(allowed, pivot);
          swapped = true;
        },
      }),
      transport: {
        async upload() {
          transportCalls += 1;
          throw new Error("authority race reached transport");
        },
      },
    });
    assert.deepEqual(await companion.prepare_local_file({
      path: join(pivot, "selected.bin"),
    }), {
      kind: "invalid",
      code: "file_ingress_source_unsupported",
    });
    assert.equal(swapped, true);
    assert.equal(transportCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable descriptor streams a structural file above 146215108 bytes without a proportional buffer", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-structural-"));
  const structuralSize = 146_215_109;
  try {
    const path = join(root, "structural.bin");
    await writeFile(path, new Uint8Array());
    await truncate(path, structuralSize);
    let prepared;
    let uploadChunks = 0;
    let largestChunk = 0;
    let uploaded = 0;
    const uploadedDigest = createHash("sha256");
    const companion = new LocalFileCompanion({
      filesystem: createNodeLocalCompanionFileSystem({ localRoots: [root] }),
      transport: {
        async upload({ stream }) {
          for await (const chunk of stream) {
            uploadChunks += 1;
            largestChunk = Math.max(largestChunk, chunk.byteLength);
            uploaded += chunk.byteLength;
            uploadedDigest.update(chunk);
          }
          return staged(prepared, {
            sha256: `sha256:${uploadedDigest.digest("hex")}`,
          });
        },
      },
      nextLocalFileRef: nextRefs(),
    });
    const result = await companion.prepare_local_file({
      path,
      claimed_media_type: "application/octet-stream",
      expected_size: structuralSize,
    });
    assert.equal(result.kind, "prepared");
    prepared = result.prepared_file;
    const uploadedResult = await companion.upload_prepared_file({
      local_file_ref: prepared.local_file_ref,
      upload_url: UPLOAD_URL,
    });
    assert.equal(uploadedResult.kind, "staged");
    assert.equal(uploaded, structuralSize);
    assert.ok(uploadChunks > 139);
    assert.ok(largestChunk <= 1_048_576);
    assert.equal(uploadedResult.staged_file.sha256, prepared.expected_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inclusive limit admission and byte mutation are detected before a remote success", async (t) => {
  await t.test("256 MiB plus one", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-oversize-"));
    try {
      const path = join(root, "oversize.bin");
      await writeFile(path, new Uint8Array());
      await truncate(path, 268_435_457);
      const companion = new LocalFileCompanion({
        filesystem: createNodeLocalCompanionFileSystem({ localRoots: [root] }),
        transport: { async upload() { assert.fail("oversize reached transport"); } },
      });
      assert.deepEqual(await companion.prepare_local_file({ path }), {
        kind: "invalid",
        code: "bundle_file_size_limit_exceeded",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("same-size bytes changed after prepare", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-mutation-"));
    try {
      const path = join(root, "mutable.bin");
      const original = new TextEncoder().encode("original bytes");
      const changed = new TextEncoder().encode("different byte");
      assert.equal(original.byteLength, changed.byteLength);
      await writeFile(path, original);
      let prepared;
      const companion = new LocalFileCompanion({
        filesystem: createNodeLocalCompanionFileSystem({ localRoots: [root] }),
        transport: {
          async upload({ stream }) {
            let first = true;
            for await (const _chunk of stream) {
              if (first) {
                first = false;
                await writeFile(path, changed);
              }
            }
            return staged(prepared);
          },
        },
        nextLocalFileRef: nextRefs(),
      });
      const result = await companion.prepare_local_file({ path });
      assert.equal(result.kind, "prepared");
      prepared = result.prepared_file;
      assert.deepEqual(await companion.upload_prepared_file({
        local_file_ref: prepared.local_file_ref,
        upload_url: UPLOAD_URL,
      }), {
        kind: "invalid",
        code: "local_companion_file_changed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("path replacement invalidates the selected snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-replace-"));
    try {
      const path = join(root, "selected.bin");
      const replacement = join(root, "replacement.bin");
      const original = new TextEncoder().encode("selected descriptor bytes");
      await writeFile(path, original);
      await writeFile(replacement, new TextEncoder().encode("replacement content data"));
      let prepared;
      let transportCalls = 0;
      const companion = new LocalFileCompanion({
        filesystem: createNodeLocalCompanionFileSystem({ localRoots: [root] }),
        transport: {
          async upload({ stream }) {
            transportCalls += 1;
            const chunks = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            return staged(prepared);
          },
        },
        nextLocalFileRef: nextRefs(),
      });
      const result = await companion.prepare_local_file({ path });
      assert.equal(result.kind, "prepared");
      prepared = result.prepared_file;
      await rename(replacement, path);
      assert.deepEqual(await companion.upload_prepared_file({
        local_file_ref: prepared.local_file_ref,
        upload_url: UPLOAD_URL,
      }), {
        kind: "invalid",
        code: "local_companion_file_changed",
      });
      assert.equal(transportCalls, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("reference runtime performs credentialless GET-before-PUT and reconciles an unknown PUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-http-"));
  try {
    const path = join(root, "private-source.opus");
    const bytes = new TextEncoder().encode("OggS....OpusHead....private payload");
    await writeFile(path, bytes);
    let prepared;
    let step = 0;
    let uploaded = Buffer.alloc(0);
    const calls = [];
    const fetcher = async (url, init) => {
      step += 1;
      calls.push({
        url,
        method: init.method,
        credentials: init.credentials,
        redirect: init.redirect,
        referrerPolicy: init.referrerPolicy,
        headers: init.headers,
      });
      if (step === 1) {
        return json({ status: "pending", expires_at: LATER });
      }
      if (step === 2) {
        const reader = init.body.getReader();
        const chunks = [];
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(Buffer.from(next.value));
        }
        uploaded = Buffer.concat(chunks);
        throw new Error("unknown PUT outcome");
      }
      return json({ status: "staged", staged_file: staged(prepared, { replayed: true }) });
    };
    const runtime = createMindDiaryLocalCompanionRuntime({
      publicOrigin: PUBLIC_ORIGIN,
      localRoots: [root],
      fetcher,
      nextLocalFileRef: nextRefs(),
    });
    const result = await runtime.prepare_local_file({
      path,
      claimed_media_type: "audio/opus",
    });
    assert.equal(result.kind, "prepared");
    prepared = result.prepared_file;
    const uploadedResult = await runtime.upload_prepared_file({
      local_file_ref: prepared.local_file_ref,
      upload_url: UPLOAD_URL,
    });
    assert.equal(uploadedResult.kind, "staged");
    assert.equal(uploadedResult.staged_file.replayed, true);
    assert.deepEqual(uploaded, Buffer.from(bytes));
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "PUT", "GET"]);
    for (const call of calls) {
      assert.equal(call.url, UPLOAD_URL);
      assert.equal(call.credentials, "omit");
      assert.equal(call.redirect, "error");
      assert.equal(call.referrerPolicy, "no-referrer");
      assert.doesNotMatch(JSON.stringify(call), /private-source|tmp|authorization|cookie/iu);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local companion stream enters canonical staging and commits manifest v5", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-v4-"));
  try {
    const path = join(root, "fixture.epub");
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 5, 6, 7, 8]);
    await writeFile(path, bytes);
    const env = await applicationHarness();
    let prepared;
    const companion = new LocalFileCompanion({
      filesystem: createNodeLocalCompanionFileSystem({ localRoots: [root] }),
      transport: {
        async upload({ stream }) {
          const result = await env.staging.stageStream({
            actor: env.currentActor,
            spaceId: MINDS.ordinary.spaceId,
            sourceKind: prepared.source_kind,
            stream,
            maxBytes: 268_435_456,
            displayFilename: prepared.display_filename,
            claimedMediaType: prepared.claimed_media_type,
            expectedSize: prepared.expected_size,
            expectedSha256: prepared.expected_sha256,
            idempotencyKey: "local-companion-v4-stage",
          });
          assert.equal(result.kind, "staged");
          return {
            staged_file_ref: result.record.stagedFileId,
            state: "verified",
            source_kind: result.record.sourceKind,
            display_filename: result.record.displayFilename,
            media_type: result.record.mediaType,
            sha256: result.record.sha256,
            size: result.record.size,
            expires_at: result.record.expiresAt,
            replayed: result.replayed,
          };
        },
      },
      nextLocalFileRef: nextRefs(),
    });
    const preparedResult = await companion.prepare_local_file({
      path,
      claimed_media_type: "application/epub+zip",
    });
    assert.equal(preparedResult.kind, "prepared");
    prepared = preparedResult.prepared_file;
    const stagedResult = await companion.upload_prepared_file({
      local_file_ref: prepared.local_file_ref,
      upload_url: UPLOAD_URL,
    });
    assert.equal(stagedResult.kind, "staged");
    const committed = await env.commits.commit({
      actor: env.currentActor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "local-companion-v4-commit",
      summary: "MD-272 manifest v4 regression",
      operations: [{
        type: "create_bundle_file",
        path: "assets/fixture.epub",
        staged_file_id: stagedResult.staged_file.staged_file_ref,
      }],
    });
    assert.equal(committed.kind, "committed");
    assert.equal(committed.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V5);
    assert.equal(
      committed.envelope.manifest.entries.find((entry) =>
        entry.path === "assets/fixture.epub").mediaType,
      "application/epub+zip",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function json(data) {
  return new Response(`${JSON.stringify({ ok: true, data })}\n`, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function applicationHarness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: {
      nextPrincipalId: () => PRINCIPALS.editor.principalId,
      nextExternalBindingId: () => "external_binding_local_companion",
      nextSpaceId: () => "space_personal_local_companion",
      nextMembershipId: () => "membership_personal_local_companion",
      nextRevisionId: () => "revision_personal_local_companion",
      nextIndexJobId: () => "job_personal_local_companion",
      nextPersonalSpaceHandle: () => "personal-local-companion",
    },
  });
  const account = await bootstrap.bootstrapAccount({
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: "local-companion@example.com",
    suggestedDisplayName: "Local Companion",
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_local_companion_bootstrap",
    occurredAtUtc: FIXED_NOW,
  }, { action: "create_isolated_account" });
  assert.equal(account.principalId, PRINCIPALS.editor.principalId);
  const sitesActor = {
    kind: "registered_principal",
    principalId: account.principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_local_companion_create_mind",
    occurredAtUtc: FIXED_NOW,
  };
  const ordinary = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    ids: {
      nextSpaceId: () => MINDS.ordinary.spaceId,
      nextMembershipId: () => "membership_local_companion",
      nextRevisionId: () => REVISIONS.initial.revisionId,
      nextIndexJobId: () => "job_local_companion",
    },
    host: verifiedSpaceHost("mind-diary.invalid"),
  });
  const mind = await ordinary.createSpaceWithOwner(sitesActor, {
    name: "Local companion fixtures",
    handle: MINDS.ordinary.handle,
    description: "Durable local companion file fixtures",
    idempotencyKey: "create-local-companion-mind",
  });
  assert.equal(mind.mindId, MINDS.ordinary.spaceId);
  let usageId = 0;
  const usage = new PrincipalMindUsageApplicationService({
    usage: metadata,
    digest: objects,
    ids: {
      nextPrincipalMindUsageGenerationId: () =>
        `usage_generation_local_companion_${++usageId}`,
      nextPrincipalMindUsageAuditEventId: () =>
        `usage_audit_local_companion_${usageId}`,
      nextPrincipalMindUsageOutboxMessageId: () =>
        `usage_outbox_local_companion_${usageId}`,
    },
  });
  assert.equal((await usage.mutate({
    actor: sitesActor,
    spaceId: mind.mindId,
    usageMode: "read_write",
    expectedUsageVersion: 0,
    idempotencyKey: "enable-local-companion-writes",
  })).kind, "applied");
  const currentActor = {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      bindingOwnerId: BINDING_OWNER_ID,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_local_companion",
    occurredAtUtc: FIXED_NOW,
  };
  const currentAuthorization = await metadata.readCurrentAuthorizationState({
    principalId: currentActor.principalId,
    spaceId: MINDS.ordinary.spaceId,
    tokenId: null,
  });
  assert.ok(currentAuthorization);
  metadata.setCurrentAuthorizationStateForTest({
    principalId: currentActor.principalId,
    spaceId: MINDS.ordinary.spaceId,
    tokenId: TOKEN_ID,
  }, {
    ...currentAuthorization,
    token: {
      tokenId: TOKEN_ID,
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: EXPIRY,
    },
  });
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const authorizer = new CapabilityAuthorizer(metadata);
  const staging = new BundleFileStagingService({
    authorizer,
    metadata,
    objects,
    clock: { now: () => LATER },
    ids: { nextStagedBundleFileId: () => "staged_local_companion_v4" },
  });
  const commits = new ChangesetCommitService({
    authorizer,
    metadata,
    revisions: coordinator,
    objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => REVISIONS.next.revisionId },
  });
  return { currentActor, staging, commits };
}
