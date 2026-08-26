import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  InMemoryLocalFileUploadIntentStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import { createWebCryptoExportDownloadSecretCrypto } from "@mind-diary/adapter-security-webcrypto";
import {
  BundleFileDownloadService,
  BundleFileStagingService,
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  FileIngressCoordinator,
  LocalFileUploadIntentService,
  MindBindingContentAuthorizer,
  MindBrowseService,
  MindSearchService,
  MindValidationService,
  WebCryptoMindLocatorCodec,
  createLocalFileUploadIntentSecretCodec,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  bindingVersion,
  version,
  verifiedSpaceHost,
} from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  MINDS,
  PRINCIPALS,
  REVISIONS,
  REVISION_AUTHORS,
} from "@mind-diary/test-fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(HERE, "../fixtures/incremental-okf-transfer");
const SOURCE_ROOT = resolve(FIXTURE_ROOT, "source");
const HOST = verifiedSpaceHost("mind-diary.test");
const TOKEN_ID = "token_incremental_okf_transfer";
const BINDING_OWNER_ID = "binding_owner_incremental_okf_transfer";
const WRITE_BINDING_ID = "write_binding_incremental_okf_transfer";
const FIRST_AT = "2026-08-26T01:00:00.000Z";
const SECOND_AT = "2026-08-26T01:05:00.000Z";
const EXPIRES_AT = "2027-08-26T01:00:00.000Z";
const CANONICAL_REQUEST_HASH = `sha256:${"a".repeat(64)}`;
const encoder = new TextEncoder();

function actor(clock, requestId) {
  return Object.freeze({
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      bindingOwnerId: BINDING_OWNER_ID,
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: clock.now(),
  });
}

function authorizationState() {
  return Object.freeze({
    principal: Object.freeze({
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
    }),
    space: Object.freeze({
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    }),
    membership: Object.freeze({
      principalId: PRINCIPALS.editor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role: "editor",
      state: "active",
      version: version(1),
    }),
    token: Object.freeze({
      tokenId: TOKEN_ID,
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
      scopes: Object.freeze(["content:read", "content:write"]),
      version: version(1),
      expiresAt: EXPIRES_AT,
    }),
  });
}

async function bindWritableMind(metadata, currentActor) {
  const result = await metadata.runMindBindingTransaction((transaction) =>
    transaction.applyWriteMindBinding({
      bindingOwnerId: BINDING_OWNER_ID,
      principalId: currentActor.principalId,
      action: "bind",
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE_BINDING_ID,
      expectedBindingVersion: bindingVersion(0),
      idempotencyKey: "bind-incremental-okf-transfer",
      canonicalRequestHash: CANONICAL_REQUEST_HASH,
      requestId: "request_bind_incremental_okf_transfer",
      auditEventId: "audit_bind_incremental_okf_transfer",
      auditOutboxMessageId: "outbox_bind_incremental_okf_transfer",
      occurredAt: currentActor.occurredAtUtc,
    }),
  );
  assert.equal(result.kind, "applied");
}

function discoveryStore(metadata, clock) {
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "readResolvedSpace") {
        return async (spaceId) => {
          if (spaceId !== MINDS.ordinary.spaceId) return null;
          const headRevisionId = await target.readHead(spaceId);
          if (headRevisionId === null) return null;
          return Object.freeze({
            host: HOST,
            canonicalHandle: "incremental-okf-transfer",
            space: Object.freeze({
              spaceId,
              spaceHandle: "incremental-okf-transfer",
              normalizedHandle: "incremental-okf-transfer",
              name: "Incremental OKF transfer fixture",
              visibility: "private",
              state: "active",
              metadataVersion: version(1),
              accessVersion: version(1),
              headRevisionId,
              createdAt: FIRST_AT,
              updatedAt: clock.now(),
            }),
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function* chunks(bytes) {
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  yield bytes.subarray(0, split);
  if (split < bytes.byteLength) yield bytes.subarray(split);
}

async function streamBytes(body) {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function listRelativeFiles(root) {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute));
    }
  };
  await visit(root);
  return files.sort();
}

async function createHarness() {
  let now = FIRST_AT;
  let staged = 0;
  let revision = 0;
  let intent = 0;
  let claim = 0;
  const clock = Object.freeze({
    now: () => now,
    set: (value) => { now = value; },
  });
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const firstActor = actor(clock, "request_incremental_transfer_first");
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: firstActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    authorizationState(),
  );
  await bindWritableMind(metadata, firstActor);

  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const seeded = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: FIRST_AT,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed incremental transfer fixture",
    files: CANONICAL_REVISION_FILES,
  });
  assert.equal(seeded.kind, "committed");

  const authorizer = new MindBindingContentAuthorizer({
    delegate: new CapabilityAuthorizer(metadata),
    bindings: metadata,
  });
  const staging = new BundleFileStagingService({
    authorizer,
    metadata,
    objects,
    clock,
    ids: { nextStagedBundleFileId: () => `staged_incremental_${++staged}` },
  });
  const commits = new ChangesetCommitService({
    authorizer,
    metadata,
    revisions,
    objects,
    clock,
    revisionIds: { nextRevisionId: () => `revision_incremental_${++revision}` },
  });
  const ingress = new FileIngressCoordinator({ staging, commits });
  const uploadIntents = new LocalFileUploadIntentService({
    authorizer,
    bindings: metadata,
    intents: new InMemoryLocalFileUploadIntentStore(),
    staging,
    digest: objects,
    clock,
    nextIntentId: () => `upload_intent_incremental_${++intent}`,
    nextClaimId: () => `upload_claim_incremental_${++claim}`,
    secrets: await createLocalFileUploadIntentSecretCodec(
      new Uint8Array(32).fill(0x36),
    ),
    deploymentCapabilities: CAPABILITIES,
    issuerActorAllowed: () => true,
    leaseHeartbeatMilliseconds: 5,
  });
  const store = discoveryStore(metadata, clock);
  const locators = new WebCryptoMindLocatorCodec(new Uint8Array(32).fill(0x42));
  const searchIndex = new InMemoryExactRevisionSearchIndex();
  const browse = new MindBrowseService({
    store,
    objects,
    host: HOST,
    locators,
    authorizer,
  });
  const search = new MindSearchService({
    store,
    index: searchIndex,
    host: HOST,
    locators,
    authorizer,
  });
  const validation = new MindValidationService({
    store,
    objects,
    host: HOST,
    authorizer,
  });
  const downloads = new BundleFileDownloadService({
    store,
    objects,
    authorizer,
    host: HOST,
    clock,
    secrets: await createWebCryptoExportDownloadSecretCrypto({
      verifierKey: new Uint8Array(32).fill(0x57),
    }),
    downloadUrlBase: "https://mind-diary.test/api/bundle-download",
  });
  return Object.freeze({
    clock,
    metadata,
    objects,
    revisions,
    staging,
    commits,
    ingress,
    uploadIntents,
    searchIndex,
    browse,
    search,
    validation,
    downloads,
  });
}

async function indexRevision(env, revisionId) {
  const exact = await env.revisions.materialize(MINDS.ordinary.spaceId, revisionId);
  await env.searchIndex.replaceExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId,
    documents: exact.files
      .filter((file) => file.kind === "markdown")
      .map((file) => Object.freeze({ path: file.path, text: file.text })),
  });
}

async function stageSelectedLocalFile(env, currentActor, {
  bytes,
  displayFilename,
  idempotencyKey,
  requestId,
}) {
  const sha256 = await env.objects.calculateSha256(bytes);
  const intent = await env.uploadIntents.create(
    currentActor,
    MINDS.ordinary.spaceId,
    {
      source_kind: "local_path",
      write_binding_id: WRITE_BINDING_ID,
      display_filename: displayFilename,
      claimed_media_type: "application/octet-stream",
      expected_size: bytes.byteLength,
      expected_sha256: sha256,
      idempotency_key: idempotencyKey,
    },
  );
  assert.equal(intent.kind, "ready");
  const uploaded = await env.uploadIntents.upload({
    capability: intent.uploadCapability,
    requestId,
    stream: chunks(bytes),
  });
  assert.equal(uploaded.kind, "staged");
  const reconciled = await env.ingress.reconcileStage({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename,
    claimedMediaType: "application/octet-stream",
    mediaType: uploaded.record.mediaType,
    sha256: uploaded.record.sha256,
    size: uploaded.record.size,
    sourceKind: "local_path",
    expectedSize: bytes.byteLength,
    expectedSha256: sha256,
    idempotencyKey,
  });
  assert.equal(reconciled.kind, "staged", JSON.stringify(reconciled));
  assert.equal(reconciled.record.stagedFileId, uploaded.record.stagedFileId);
  return Object.freeze({ record: uploaded.record, sha256 });
}

function exactSnapshot(materialized) {
  return materialized.files.map((file) => file.kind === "markdown"
    ? Object.freeze({ path: file.path, kind: file.kind, text: file.text })
    : Object.freeze({
        path: file.path,
        kind: file.kind,
        mediaType: file.mediaType,
        bytes: [...file.bytes],
      }));
}

test("two explicit typed OKF transfers use ordinary changesets without migration state", async () => {
  const env = await createHarness();
  const selection = JSON.parse(
    await readFile(resolve(FIXTURE_ROOT, "selection.json"), "utf8"),
  );
  const candidatePaths = await listRelativeFiles(SOURCE_ROOT);
  for (const excluded of selection.excluded) {
    assert.equal(candidatePaths.includes(excluded), true, excluded);
  }

  const readPaths = [];
  const readSelected = async (path, encoding) => {
    assert.equal(selection.excluded.includes(path), false, path);
    readPaths.push(path);
    return readFile(resolve(SOURCE_ROOT, path), encoding);
  };
  const firstSource = await readSelected(selection.first.entry, "utf8");
  const attachmentBytes = new Uint8Array(
    await readSelected(selection.first.attachment),
  );
  const firstTransferred = firstSource.replace(
    "](/raw/harbor-evidence.bin#sample)",
    "](../raw/harbor-evidence.bin#sample)",
  );
  assert.notEqual(firstTransferred, firstSource);
  assert.equal(firstTransferred.replace(
    "](../raw/harbor-evidence.bin#sample)",
    "](/raw/harbor-evidence.bin#sample)",
  ), firstSource);

  const firstActor = actor(env.clock, "request_incremental_transfer_first");
  const firstAttachment = await stageSelectedLocalFile(env, firstActor, {
    bytes: attachmentBytes,
    displayFilename: "harbor-evidence.bin",
    idempotencyKey: "intent-incremental-harbor-evidence",
    requestId: "request_upload_incremental_harbor_evidence",
  });

  const initial = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    REVISIONS.initial.revisionId,
  );
  const initialIndex = initial.files.find((file) => file.path === "index.md");
  assert.equal(initialIndex?.kind, "markdown");
  const firstIndex = `${initialIndex.text.trimEnd()}\n- [Harbor Lantern](wiki/harbor-lantern.md) - Incremental synthetic transfer.\n`;
  const firstRequest = Object.freeze({
    actor: firstActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-incremental-transfer-first",
    summary: "Transfer one explicitly selected typed OKF entry",
    operations: Object.freeze([
      Object.freeze({
        type: "create_file",
        path: selection.first.entry,
        text: firstTransferred,
      }),
      Object.freeze({
        type: "create_bundle_file",
        path: selection.first.attachment,
        staged_file_id: firstAttachment.record.stagedFileId,
      }),
      Object.freeze({
        type: "replace_index",
        path: "index.md",
        text: firstIndex,
        expected_sha256: await env.objects.calculateSha256(encoder.encode(initialIndex.text)),
      }),
      Object.freeze({
        type: "add_log_entry",
        path: "log.md",
        category: "Create",
        message: "Transferred [Harbor Lantern](wiki/harbor-lantern.md) and its explicit evidence file.",
      }),
    ]),
  });
  const first = await env.ingress.commit(firstRequest);
  assert.equal(first.kind, "committed");
  assert.equal(first.replayed, false);
  assert.equal(first.envelope.revision.revisionNumber, 2);
  assert.equal((await env.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 2);

  const exactRetry = await env.ingress.commit(firstRequest);
  assert.equal(exactRetry.kind, "committed");
  assert.equal(exactRetry.replayed, true);
  assert.equal(exactRetry.envelope.revision.revisionId, first.envelope.revision.revisionId);
  const reconciledCommit = await env.ingress.reconcileCommit(firstRequest);
  assert.equal(reconciledCommit.kind, "committed");
  assert.equal(reconciledCommit.replayed, true);
  assert.equal((await env.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 2);
  await indexRevision(env, first.envelope.revision.revisionId);
  const firstExactBeforeSecond = exactSnapshot(await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    first.envelope.revision.revisionId,
  ));

  env.clock.set(SECOND_AT);
  const freshHead = await env.metadata.readHead(MINDS.ordinary.spaceId);
  assert.equal(freshHead, first.envelope.revision.revisionId);
  const secondSource = await readSelected(selection.second.entry, "utf8");
  const secondAttachmentBytes = new Uint8Array(
    await readSelected(selection.second.attachment),
  );
  const secondTransferred = secondSource
    .replace(
      "](/wiki/harbor-lantern.md#harbor-lantern)",
      "](harbor-lantern.md#harbor-lantern)",
    )
    .replace(
      "](/output/second-derived.txt#result)",
      "](../output/second-derived.txt#result)",
    );
  assert.notEqual(secondTransferred, secondSource);
  assert.equal(secondTransferred
    .replace(
      "](harbor-lantern.md#harbor-lantern)",
      "](/wiki/harbor-lantern.md#harbor-lantern)",
    )
    .replace(
      "](../output/second-derived.txt#result)",
      "](/output/second-derived.txt#result)",
    ), secondSource);
  const secondActor = actor(env.clock, "request_incremental_transfer_second");
  const secondAttachment = await stageSelectedLocalFile(env, secondActor, {
    bytes: secondAttachmentBytes,
    displayFilename: "second-derived.txt",
    idempotencyKey: "intent-incremental-second-output",
    requestId: "request_upload_incremental_second_output",
  });
  const current = await env.revisions.materialize(MINDS.ordinary.spaceId, freshHead);
  const currentIndex = current.files.find((file) => file.path === "index.md");
  assert.equal(currentIndex?.kind, "markdown");
  const secondIndex = `${currentIndex.text.trimEnd()}\n- [Second Observation](wiki/second-observation.md) - Fresh-HEAD synthetic transfer.\n`;
  const secondRequest = Object.freeze({
    actor: secondActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: freshHead,
    idempotencyKey: "commit-incremental-transfer-second",
    summary: "Transfer the next explicitly selected typed OKF entry",
    operations: Object.freeze([
      Object.freeze({
        type: "create_file",
        path: selection.second.entry,
        text: secondTransferred,
      }),
      Object.freeze({
        type: "create_bundle_file",
        path: selection.second.attachment,
        staged_file_id: secondAttachment.record.stagedFileId,
      }),
      Object.freeze({
        type: "replace_index",
        path: "index.md",
        text: secondIndex,
        expected_sha256: await env.objects.calculateSha256(encoder.encode(currentIndex.text)),
      }),
      Object.freeze({
        type: "add_log_entry",
        path: "log.md",
        category: "Create",
        message: "Transferred [Second Observation](wiki/second-observation.md) from a fresh HEAD.",
      }),
    ]),
  });
  const second = await env.ingress.commit(secondRequest);
  assert.equal(second.kind, "committed");
  assert.equal(second.replayed, false);
  assert.equal(second.envelope.revision.parentRevisionId, freshHead);
  assert.equal(second.envelope.revision.revisionNumber, 3);
  assert.equal((await env.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 3);
  await indexRevision(env, second.envelope.revision.revisionId);

  assert.deepEqual(
    exactSnapshot(await env.revisions.materialize(
      MINDS.ordinary.spaceId,
      first.envelope.revision.revisionId,
    )),
    firstExactBeforeSecond,
  );
  const finalExact = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    second.envelope.revision.revisionId,
  );
  const finalPaths = new Set(finalExact.files.map((file) => file.path));
  for (const selected of [
    selection.first.entry,
    selection.first.attachment,
    selection.second.entry,
    selection.second.attachment,
    "index.md",
    "log.md",
  ]) assert.equal(finalPaths.has(selected), true, selected);
  for (const excluded of selection.excluded) {
    assert.equal(finalPaths.has(excluded), false, excluded);
  }
  assert.deepEqual(readPaths.sort(), [
    selection.first.attachment,
    selection.first.entry,
    selection.second.attachment,
    selection.second.entry,
  ].sort());

  const firstEntry = finalExact.files.find((file) => file.path === selection.first.entry);
  const secondEntry = finalExact.files.find((file) => file.path === selection.second.entry);
  assert.equal(firstEntry?.kind, "markdown");
  assert.equal(firstEntry.text, firstTransferred);
  assert.match(firstEntry.text, /recorded_by: fixture-observer/u);
  assert.match(firstEntry.text, /applies_to:\n  - synthetic-harbor/u);
  assert.match(firstEntry.text, /sources:\n  - local-fixture:harbor-evidence/u);
  assert.match(firstEntry.text, /retained_unknown: true/u);
  assert.equal(secondEntry?.kind, "markdown");
  assert.equal(secondEntry.text, secondTransferred);
  assert.match(secondEntry.text, /retained_unknown: second-value/u);
  assert.match(firstEntry.text, /\]\(\.\.\/raw\/harbor-evidence\.bin#sample\)/u);
  assert.match(secondEntry.text, /\]\(harbor-lantern\.md#harbor-lantern\)/u);
  assert.match(secondEntry.text, /\]\(\.\.\/output\/second-derived\.txt#result\)/u);
  assert.doesNotMatch(`${firstEntry.text}\n${secondEntry.text}`, /\]\(\/(?:raw|wiki|output)\//u);

  const searched = await env.search.searchEntries(
    actor(env.clock, "request_incremental_transfer_search"),
    { mind: MINDS.ordinary.spaceId, query: "cobalt-tide" },
  );
  assert.deepEqual(searched.results.map((result) => result.entry.path), [
    selection.second.entry,
  ]);
  const browsed = await env.browse.browseEntries(
    actor(env.clock, "request_incremental_transfer_browse"),
    { mind: MINDS.ordinary.spaceId, path: "wiki", limit: 10 },
  );
  assert.deepEqual(browsed.entries.map((entry) => entry.path), [
    selection.first.entry,
    selection.second.entry,
  ]);
  const fetched = await env.browse.fetch(
    actor(env.clock, "request_incremental_transfer_fetch"),
    { id: browsed.entries[0].entryId },
  );
  assert.equal(fetched.entry.path, selection.first.entry);
  assert.equal(fetched.text, firstTransferred);

  const listed = await env.browse.listBundleFiles(
    actor(env.clock, "request_incremental_transfer_list_files"),
    { mind: MINDS.ordinary.spaceId, limit: 10 },
  );
  assert.deepEqual(listed.files.map((file) => file.path), [
    selection.second.attachment,
    selection.first.attachment,
  ]);
  assert.equal(listed.files.find(
    (file) => file.path === selection.first.attachment,
  ).sha256, firstAttachment.sha256);
  assert.equal(listed.files.every((file) => file.referenceStatus === "referenced"), true);
  for (const [index, path, expectedBytes] of [
    [1, selection.first.attachment, attachmentBytes],
    [2, selection.second.attachment, secondAttachmentBytes],
  ]) {
    const issued = await env.downloads.issue(
      actor(env.clock, `request_incremental_transfer_download_issue_${index}`),
      { mind: MINDS.ordinary.spaceId, path },
    );
    assert.equal(issued.disposition, "attachment");
    const downloadSecret = new URL(issued.downloadUrl).pathname.split("/").at(-1);
    const downloaded = await env.downloads.download(
      Object.freeze({
        kind: "service",
        serviceId: "incremental-transfer-test",
        deploymentCapabilities: CAPABILITIES,
        requestId: `request_incremental_transfer_download_${index}`,
        occurredAtUtc: env.clock.now(),
      }),
      downloadSecret,
    );
    assert.equal(downloaded.kind, "download");
    assert.deepEqual(await streamBytes(downloaded.body), expectedBytes);
  }

  const validation = await env.validation.validateMind(
    actor(env.clock, "request_incremental_transfer_validate"),
    { mind: MINDS.ordinary.spaceId },
  );
  assert.equal(validation.resolvedRevision.revisionId, second.envelope.revision.revisionId);
  assert.equal(validation.valid, true);
  assert.equal(validation.validatedOkfVersion, "0.2");
  assert.equal(Object.hasOwn(env, "migrationDatabase"), false);
});
