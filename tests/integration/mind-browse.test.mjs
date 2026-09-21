import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import {
  CapabilityAuthorizer,
  REVISION_MANIFEST_MEDIA_TYPE,
} from "@mind-diary/application-ports";
import {
  CanonicalRevisionCoordinator,
  MindBrowseFailure,
  MindBrowseService,
  WebCryptoMindLocatorCodec,
  exactRevisionResourceUri,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  OrdinaryMindDeletionService,
  PrincipalMindUsageApplicationService,
} from "@mind-diary/application-control";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V5,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  verifiedSpaceHost,
  version,
} from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T13:00:00.000Z";
const CHANGED_AT = "2026-08-07T13:01:00.000Z";
const DELETE_AT = "2026-08-07T13:10:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const encoder = new TextEncoder();
const VALID_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const MALFORMED_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x08, 0x06, 0x00, 0x00, 0x00, 0xf0, 0xd7, 0xaf, 0xb7,
]);

function preRegistrationActor(index, displayName = `Browse Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.browse.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_browse_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function actor(principalId, requestId = "request_browse", occurredAtUtc = CHANGED_AT) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function mcpActor(principalId, tokenId = "token_browse_usage") {
  return {
    kind: "registered_principal",
    principalId,
    authentication: {
      kind: "mcp_token",
      tokenId,
      bindingOwnerId: `owner_${tokenId}`,
      effectiveScopes: ["content:read"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_${tokenId}`,
    occurredAtUtc: CHANGED_AT,
  };
}

function accountIds() {
  let account = 0;
  return {
    nextPrincipalId: () => `principal_browse_${++account}`,
    nextExternalBindingId: () => `binding_browse_${account}`,
    nextSpaceId: () => `space_personal_browse_${account}`,
    nextMembershipId: () => `membership_personal_browse_${account}`,
    nextRevisionId: () => `revision_personal_browse_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-browse-${account}`,
  };
}

function trackedObjects(delegate) {
  let immutableReads = 0;
  let bundleOpens = 0;
  let concurrentReads = 0;
  let maximumConcurrentReads = 0;
  let rangeReads = 0;
  let rangeBytes = 0;
  let canonicalReads = 0;
  return {
    kind: "object-store",
    calculateSha256: (bytes) => delegate.calculateSha256(bytes),
    putImmutable: (request) => delegate.putImmutable(request),
    getImmutable: async (sha256) => {
      immutableReads += 1;
      concurrentReads += 1;
      maximumConcurrentReads = Math.max(maximumConcurrentReads, concurrentReads);
      try {
        return await delegate.getImmutable(sha256);
      } finally {
        concurrentReads -= 1;
      }
    },
    openBundleFile: async (spaceId, sha256) => {
      bundleOpens += 1;
      return delegate.openBundleFile(spaceId, sha256);
    },
    getBundleFile: (spaceId, sha256) => delegate.getBundleFile(spaceId, sha256),
    getSpaceCanonicalObject: (kind, spaceId, sha256) => {
      canonicalReads += 1;
      return delegate.getSpaceCanonicalObject(kind, spaceId, sha256);
    },
    openSpaceCanonicalObject: (kind, spaceId, sha256) =>
      delegate.openSpaceCanonicalObject(kind, spaceId, sha256),
    openSpaceCanonicalObjectRange: (kind, spaceId, sha256, range) => {
      rangeReads += 1;
      rangeBytes += range.length;
      return delegate.openSpaceCanonicalObjectRange(kind, spaceId, sha256, range);
    },
    openBundleFileRange: (spaceId, sha256, range) => {
      rangeReads += 1;
      rangeBytes += range.length;
      return delegate.openBundleFileRange(spaceId, sha256, range);
    },
    listImmutableObjects: (request) => delegate.listImmutableObjects(request),
    deleteImmutableObject: (request) => delegate.deleteImmutableObject(request),
    reads: () => immutableReads,
    bundleOpens: () => bundleOpens,
    maxConcurrentReads: () => maximumConcurrentReads,
    rangeReads: () => rangeReads,
    rangeBytes: () => rangeBytes,
    canonicalReads: () => canonicalReads,
    reset: () => {
      immutableReads = 0;
      bundleOpens = 0;
      concurrentReads = 0;
      maximumConcurrentReads = 0;
      rangeReads = 0;
      rangeBytes = 0;
      canonicalReads = 0;
    },
  };
}

function locatorsWithRevocation(delegate, revokeAt, revoke) {
  let encodes = 0;
  return {
    decode: (candidate) => delegate.decode(candidate),
    encode: async (payload) => {
      const encoded = await delegate.encode(payload);
      encodes += 1;
      if (encodes === revokeAt) await revoke();
      return encoded;
    },
    encodes: () => encodes,
  };
}

function harness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const observedObjects = trackedObjects(objects);
  const locators = new WebCryptoMindLocatorCodec(new Uint8Array(32).fill(0x61));
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: accountIds(),
  });
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const browse = new MindBrowseService({
    store: metadata,
    objects: observedObjects,
    host: HOST,
    locators,
  });
  const credentialAccess = Object.freeze({
    async authorizeCredentialContentAccess() {
      return Object.freeze({ kind: "allowed" });
    },
  });
  const mcpBrowse = new MindBrowseService({
    store: metadata,
    objects: observedObjects,
    host: HOST,
    locators,
    credentialAccess,
  });
  let usageGeneration = 0;
  let usageAudit = 0;
  let usageOutbox = 0;
  const usage = new PrincipalMindUsageApplicationService({
    usage: metadata,
    digest: objects,
    ids: {
      nextPrincipalMindUsageGenerationId: () =>
        `usage_browse_generation_${++usageGeneration}`,
      nextPrincipalMindUsageAuditEventId: () =>
        `usage_browse_audit_${++usageAudit}`,
      nextPrincipalMindUsageOutboxMessageId: () =>
        `usage_browse_outbox_${++usageOutbox}`,
    },
  });
  const deletion = new OrdinaryMindDeletionService({
    ordinaryMinds: metadata,
    objects,
    index: new InMemoryExactRevisionSearchIndex(),
    audit: new InMemoryAuditSink(),
    exportArchives: objects,
    ids: (() => {
      let impact = 0;
      return { nextImpactId: () => `impact_browse_${++impact}` };
    })(),
    clock: { now: () => DELETE_AT },
    host: HOST,
  });
  let space = 0;
  let membership = 0;
  let revision = 0;
  return {
    metadata,
    objects,
    observedObjects,
    locators,
    bootstrap,
    revisions,
    browse,
    mcpBrowse,
    usage,
    deletion,
    nextSpaceId: () => `space_browse_${++space}`,
    nextMembershipId: () => `membership_browse_owner_${++membership}`,
    nextRevisionId: () => `revision_browse_content_${++revision}`,
  };
}

async function createAccount(env, index, displayName) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

function concept(title, body, options = {}) {
  const description = options.description ?? `${title} description`;
  const tags = options.tags ?? ["browse", title.toLowerCase()];
  return `---\ntype: Reference\ntitle: ${title}\ndescription: ${description}\ntags:\n${tags
    .map((tag) => `  - ${tag}`)
    .join("\n")}\n---\n\n# ${title}\n\n${body}\n`;
}

function rootIndex(links) {
  return `---\nokf_version: "0.2"\n---\n\n# Browse fixture\n\n${links
    .map(([title, path]) => `- [${title}](${path})`)
    .join("\n")}\n`;
}

async function commitFiles(env, owner, mind, files, summary = "Seed browse fixture") {
  const expectedRevisionId = await env.metadata.readHead(mind.mindId);
  assert.ok(expectedRevisionId);
  const result = await env.revisions.commit({
    spaceId: mind.mindId,
    expectedRevisionId,
    revisionId: env.nextRevisionId(),
    committedAt: CHANGED_AT,
    committedBy: { kind: "principal", principalId: owner.principalId },
    summary,
    files: files.map((file) => ({
      path: file.path,
      mediaType: MARKDOWN_MEDIA_TYPE,
      bytes: encoder.encode(file.text),
    })),
  });
  assert.equal(result.kind, "committed");
  return result.envelope.revision.revisionId;
}

async function commitMixedFiles(env, owner, mind, markdownFiles, opaqueFiles, summary) {
  const expectedRevisionId = await env.metadata.readHead(mind.mindId);
  const parent = await env.metadata.readRevision(mind.mindId, expectedRevisionId);
  const markdownObjects = await Promise.all(markdownFiles.map((file) =>
    env.objects.putSpaceCanonicalObject({
      kind: "markdown",
      spaceId: mind.mindId,
      bytes: encoder.encode(file.text),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: CHANGED_AT,
    })));
  const opaqueObjects = await Promise.all(opaqueFiles.map((file) =>
    env.objects.putBundleFile({
      spaceId: mind.mindId,
      bytes: file.bytes,
      mediaType: file.mediaType,
      createdAt: CHANGED_AT,
    })));
  const manifest = createRevisionManifest([
    ...markdownFiles.map((file, index) => ({
      kind: "markdown",
      path: file.path,
      sha256: markdownObjects[index].object.sha256,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: markdownObjects[index].object.size,
      integrityRoot: markdownObjects[index].integrityRoot,
    })),
    ...opaqueFiles.map((file, index) => ({
      kind: "opaque",
      path: file.path,
      sha256: opaqueObjects[index].object.sha256,
      mediaType: file.mediaType,
      size: opaqueObjects[index].object.size,
      integrityRoot: opaqueObjects[index].integrityRoot,
    })),
  ], REVISION_MANIFEST_FORMAT_V5);
  const manifestObject = await env.objects.putSpaceCanonicalObject({
    kind: "revision_manifest",
    spaceId: mind.mindId,
    bytes: encoder.encode(serializeRevisionManifest(manifest)),
    mediaType: REVISION_MANIFEST_MEDIA_TYPE,
    createdAt: CHANGED_AT,
  });
  const revisionId = env.nextRevisionId();
  const envelope = createCanonicalRevisionEnvelope({
    revisionId,
    spaceId: mind.mindId,
    revisionNumber: parent.revision.revisionNumber + 1,
    parentRevisionId: expectedRevisionId,
    committedAt: CHANGED_AT,
    committedBy: { kind: "principal", principalId: owner.principalId },
    manifest,
    manifestHash: manifestObject.object.sha256,
    manifestSize: manifestObject.object.size,
    summary,
  });
  const result = await env.metadata.commitRevision({
    expectedHeadRevisionId: expectedRevisionId,
    envelope,
  });
  assert.equal(result.kind, "committed");
  return revisionId;
}

function fixtureFiles(alphaBody = "PRIVATE_ALPHA_BODY", betaBody = "PRIVATE_BETA_BODY") {
  return [
    {
      path: "index.md",
      text: rootIndex([
        ["Alpha", "concepts/alpha.md"],
        ["Beta", "concepts/beta.md"],
      ]),
    },
    { path: "concepts/alpha.md", text: concept("Alpha", alphaBody) },
    { path: "concepts/beta.md", text: concept("Beta", betaBody) },
    {
      path: "concepts/nested/gamma.md",
      text: concept("Gamma", "PRIVATE_NESTED_BODY"),
    },
  ];
}

async function createMind(env, owner, handle, files = fixtureFiles()) {
  const spaceId = env.nextSpaceId();
  const membershipId = env.nextMembershipId();
  const revisionId = env.nextRevisionId();
  const stored = await Promise.all(
    files.map((file) =>
      env.objects.putImmutable({
        bytes: encoder.encode(file.text),
        mediaType: MARKDOWN_MEDIA_TYPE,
        createdAt: CREATED_AT,
      }),
    ),
  );
  const manifest = createRevisionManifest(
    files.map((file, index) => ({
      path: file.path,
      sha256: stored[index].object.sha256,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: stored[index].object.size,
    })),
  );
  const manifestHash = await env.objects.calculateSha256(
    encoder.encode(serializeRevisionManifest(manifest)),
  );
  const initialRevision = createCanonicalRevisionEnvelope({
    revisionId,
    spaceId,
    revisionNumber: 1,
    parentRevisionId: null,
    committedAt: CREATED_AT,
    committedBy: { kind: "principal", principalId: owner.principalId },
    manifest,
    manifestHash,
    summary: "Create browse fixture Mind",
  });
  const canonicalRequestHash = await env.objects.calculateSha256(
    encoder.encode(`create:${spaceId}:${handle}`),
  );
  const created = await env.metadata.runOrdinaryMindTransaction((transaction) =>
    transaction.createOrdinaryMind({
      host: HOST,
      space: {
        spaceId,
        spaceHandle: handle,
        normalizedHandle: handle,
        name: handle,
        visibility: "private",
        state: "active",
        metadataVersion: version(1),
        accessVersion: version(1),
        headRevisionId: revisionId,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      ownerMembership: {
        membershipId,
        spaceId,
        principalId: owner.principalId,
        role: "owner",
        state: "active",
        version: version(1),
        createdAt: CREATED_AT,
        createdBy: owner.principalId,
        updatedAt: CREATED_AT,
        updatedBy: owner.principalId,
      },
      initialRevision,
      idempotencyKey: `create-${handle}`,
      canonicalRequestHash,
    }),
  );
  assert.equal(created.kind, "created");
  return {
    mindId: spaceId,
    handle,
    headRevisionId: revisionId,
    visibility: "private",
  };
}

function expectFailure(code, retryable) {
  return (error) => {
    assert.equal(error instanceof MindBrowseFailure, true);
    assert.equal(error.code, code);
    if (retryable !== undefined) assert.equal(error.retryable, retryable);
    return true;
  };
}

async function fetchAll(service, readActor, entryId, maxBytes = 7) {
  let id = entryId;
  let text = "";
  const ranges = [];
  for (let page = 0; page < 10_000; page += 1) {
    const fetched = await service.fetch(readActor, { id, maxBytes });
    text += fetched.text;
    ranges.push(fetched.range);
    if (fetched.continuationId === null) return { text, ranges };
    id = fetched.continuationId;
  }
  assert.fail("fetch continuation did not terminate");
}

test("browse reads only the requested manifest page, parses frontmatter, and never needs a search index", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Browse Owner");
  const mind = await createMind(env, owner, "browse-pages");
  const revisionId = mind.headRevisionId;

  env.observedObjects.reset();
  const first = await env.browse.browseEntries(actor(owner.principalId), {
    mind: mind.handle,
    path: "concepts",
    limit: 1,
  });
  assert.equal(first.resolvedRevision.revisionId, revisionId);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].path, "concepts/alpha.md");
  assert.equal(first.entries[0].title, "Alpha");
  assert.equal(first.entries[0].description, "Alpha description");
  assert.deepEqual(first.entries[0].tags, ["browse", "alpha"]);
  assert.equal(first.entries[0].okfType, "Reference");
  assert.ok(first.nextCursor);
  assert.equal(env.observedObjects.reads(), 1);
  assert.equal(JSON.stringify(first).includes("PRIVATE_ALPHA_BODY"), false);
  assert.equal(JSON.stringify(first).includes("PRIVATE_BETA_BODY"), false);

  const second = await env.browse.browseEntries(actor(owner.principalId), {
    mind: mind.handle,
    path: "concepts",
    cursor: first.nextCursor,
    limit: 1,
  });
  assert.deepEqual(second.entries.map((entry) => entry.path), ["concepts/beta.md"]);
  assert.equal(second.nextCursor, null);
  assert.equal(env.observedObjects.reads(), 2);

  const root = await env.browse.browseEntries(actor(owner.principalId), {
    mind: mind.mindId,
    limit: 100,
  });
  assert.deepEqual(root.entries.map((entry) => entry.path), ["index.md"]);
  assert.equal(root.entries[0].kind, "index");
  assert.equal(env.observedObjects.reads(), 3);
});

test("large valid frontmatter falls back to compact locators without breaking browse or fetch", async () => {
  const env = harness();
  const owner = await createAccount(env, 20, "Large Frontmatter Owner");
  const mind = await createMind(env, owner, "large-frontmatter-browse");
  const tags = Array.from(
    { length: 125 },
    (_, index) => `tag-${String(index).padStart(3, "0")}-${"x".repeat(40)}`,
  );
  await commitFiles(env, owner, mind, [
    { path: "index.md", text: rootIndex([["Large", "a.md"]]) },
    { path: "a.md", text: concept("Large", "LARGE_FRONTMATTER_BODY", { tags }) },
  ]);

  const listed = await env.browse.browseEntries(actor(owner.principalId), {
    mind: mind.handle,
    path: "",
    limit: 10,
  });
  const entry = listed.entries.find((candidate) => candidate.path === "a.md");
  assert.ok(entry);
  assert.deepEqual(entry.tags, tags);
  const locator = await env.locators.decode(entry.entryId);
  assert.equal(locator.kind, "entry");
  assert.equal(locator.okfType, undefined);

  const fetched = await fetchAll(
    env.browse,
    actor(owner.principalId),
    entry.entryId,
    512,
  );
  assert.match(fetched.text, /LARGE_FRONTMATTER_BODY/u);
});

test("disabled Mind invalidates previously issued fetch and resource locators before object reads", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Usage Browse Owner");
  const mind = await createMind(env, owner, "usage-browse");
  const enabled = await env.usage.mutate({
    actor: actor(owner.principalId, "request_enable_usage_browse"),
    spaceId: mind.mindId,
    usageMode: "read",
    expectedUsageVersion: 0,
    idempotencyKey: "enable-usage-browse",
  });
  assert.equal(enabled.kind, "applied");
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: owner.principalId,
      spaceId: mind.mindId,
      tokenId: "token_browse_usage",
    },
    {
      principal: { principalId: owner.principalId, state: "active" },
      space: {
        spaceId: mind.mindId,
        state: "active",
        visibility: "private",
        accessVersion: version(1),
      },
      membership: {
        principalId: owner.principalId,
        spaceId: mind.mindId,
        role: "owner",
        state: "active",
        version: version(1),
      },
      token: {
        tokenId: "token_browse_usage",
        principalId: owner.principalId,
        state: "active",
        scopes: ["content:read"],
        version: version(1),
        expiresAt: "2027-08-07T00:00:00.000Z",
      },
    },
  );
  const currentActor = mcpActor(owner.principalId);
  const listed = await env.mcpBrowse.browseEntries(currentActor, {
    mind: mind.handle,
    path: "concepts",
    limit: 1,
  });
  assert.equal(listed.entries.length, 1);

  const disabled = await env.usage.mutate({
    actor: actor(owner.principalId, "request_disable_usage_browse"),
    spaceId: mind.mindId,
    usageMode: "disabled",
    expectedUsageVersion: 1,
    idempotencyKey: "disable-usage-browse",
  });
  assert.equal(disabled.kind, "applied");
  env.observedObjects.reset();
  await assert.rejects(
    env.mcpBrowse.fetch(currentActor, { id: listed.entries[0].entryId }),
    expectFailure("locator_not_found"),
  );
  await assert.rejects(
    env.mcpBrowse.readResource(currentActor, listed.entries[0].resourceUri),
    expectFailure("resource_not_found"),
  );
  await assert.rejects(
    env.mcpBrowse.browseEntries(currentActor, {
      mind: mind.handle,
      path: "concepts",
    }),
    expectFailure("mind_not_found"),
  );
  assert.equal(env.observedObjects.reads(), 0);
});

test("file-operation cursors are invalid after usage mode changes and then returns to read", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "File Cursor Usage Owner");
  const mind = await createMind(env, owner, "file-cursor-usage");
  const enabled = await env.usage.mutate({
    actor: actor(owner.principalId, "request_enable_file_cursor_usage"),
    spaceId: mind.mindId,
    usageMode: "read",
    expectedUsageVersion: 0,
    idempotencyKey: "enable-file-cursor-usage",
  });
  assert.equal(enabled.kind, "applied");
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: owner.principalId,
      spaceId: mind.mindId,
      tokenId: "token_file_cursor_usage",
    },
    {
      principal: { principalId: owner.principalId, state: "active" },
      space: {
        spaceId: mind.mindId,
        state: "active",
        visibility: "private",
        accessVersion: version(1),
      },
      membership: {
        principalId: owner.principalId,
        spaceId: mind.mindId,
        role: "owner",
        state: "active",
        version: version(1),
      },
      token: {
        tokenId: "token_file_cursor_usage",
        principalId: owner.principalId,
        state: "active",
        scopes: ["content:read"],
        version: version(1),
        expiresAt: "2027-08-07T00:00:00.000Z",
      },
    },
  );
  const currentActor = mcpActor(owner.principalId, "token_file_cursor_usage");
  const first = await env.mcpBrowse.listFiles(currentActor, {
    mind: mind.handle,
    limit: 1,
  });
  assert.ok(first.nextCursor);

  const disabled = await env.usage.mutate({
    actor: actor(owner.principalId, "request_disable_file_cursor_usage"),
    spaceId: mind.mindId,
    usageMode: "disabled",
    expectedUsageVersion: 1,
    idempotencyKey: "disable-file-cursor-usage",
  });
  assert.equal(disabled.kind, "applied");
  const reenabled = await env.usage.mutate({
    actor: actor(owner.principalId, "request_reenable_file_cursor_usage"),
    spaceId: mind.mindId,
    usageMode: "read",
    expectedUsageVersion: 2,
    idempotencyKey: "reenable-file-cursor-usage",
  });
  assert.equal(reenabled.kind, "applied");

  await assert.rejects(
    env.mcpBrowse.listFiles(currentActor, {
      mind: mind.handle,
      cursor: first.nextCursor,
      limit: 1,
    }),
    expectFailure("file_operation_cursor_invalid"),
  );
});

test("browse materializes a scaled page with bounded concurrency and deterministic order", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Scaled Browse Owner");
  const files = [
    { path: "index.md", text: rootIndex([]) },
    ...Array.from({ length: 24 }, (_, index) => ({
      path: `concepts/item-${String(index).padStart(2, "0")}.md`,
      text: concept(`Item ${String(index).padStart(2, "0")}`, `BODY_${index}`),
    })),
  ];
  const mind = await createMind(env, owner, "scaled-browse", files);
  env.observedObjects.reset();
  const result = await env.browse.browseEntries(actor(owner.principalId), {
    mind: mind.handle,
    path: "concepts",
    limit: 100,
  });
  assert.equal(result.entries.length, 24);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    files.slice(1).map((file) => file.path),
  );
  assert.equal(env.observedObjects.reads(), 24);
  assert.equal(env.observedObjects.maxConcurrentReads(), 8);
});

test("BundleFile listing returns metadata only, verifies preview bytes, and stays on an exact historical revision", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Bundle Browse Owner");
  const mind = await createMind(env, owner, "bundle-browse");
  const oldMarkdown = fixtureFiles().map((file) => file.path === "concepts/alpha.md"
    ? {
        ...file,
        text: concept(
          "Alpha",
          "![Diagram](../assets/a.png)\n![Spoofed](../assets/spoofed.png)",
        ),
      }
    : file);
  const oldRevision = await commitMixedFiles(
    env,
    owner,
    mind,
    oldMarkdown,
    [
      {
        path: "assets/a.png",
        mediaType: "image/png",
        bytes: VALID_PNG,
      },
      {
        path: "assets/b.pdf",
        mediaType: "application/pdf",
        bytes: encoder.encode("%PDF-1.7\n"),
      },
      {
        path: "assets/spoofed.png",
        mediaType: "image/png",
        bytes: MALFORMED_PNG,
      },
    ],
    "Add browsable BundleFiles",
  );
  env.observedObjects.reset();
  const first = await env.browse.listBundleFiles(actor(owner.principalId), {
    mind: mind.handle,
    limit: 1,
  });
  assert.equal(first.resolvedRevision.revisionId, oldRevision);
  assert.deepEqual(first.files.map((file) => ({
    path: file.path,
    inlineEligible: file.inlineEligible,
    referenceStatus: file.referenceStatus,
  })), [{
    path: "assets/a.png",
    inlineEligible: true,
    referenceStatus: "referenced",
  }]);
  assert.ok(first.nextCursor);
  assert.equal(
    env.observedObjects.reads() + env.observedObjects.canonicalReads(),
    oldMarkdown.length + 1,
  );
  assert.equal(env.observedObjects.bundleOpens(), 2);
  assert.deepEqual(first.diagnostics.map(({ code }) => code), [
    "bundle_file_inline_disallowed",
  ]);
  assert.deepEqual(Object.keys(first).sort(), [
    "diagnostics",
    "files",
    "mind",
    "nextCursor",
    "resolvedRevision",
  ]);
  assert.deepEqual(Object.keys(first.files[0]).sort(), [
    "inlineEligible",
    "kind",
    "mediaType",
    "path",
    "referenceStatus",
    "revisionId",
    "sha256",
    "size",
  ]);

  const currentRevision = await commitMixedFiles(
    env,
    owner,
    mind,
    fixtureFiles(),
    [{
      path: "assets/current.zip",
      mediaType: "application/zip",
      bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
    }],
    "Move HEAD after BundleFile cursor issuance",
  );
  const second = await env.browse.listBundleFiles(actor(owner.principalId), {
    mind: mind.handle,
    cursor: first.nextCursor,
    limit: 1,
  });
  assert.equal(second.resolvedRevision.revisionId, oldRevision);
  assert.deepEqual(second.files.map((file) => file.path), ["assets/b.pdf"]);
  assert.equal(second.files[0].referenceStatus, "unreferenced");
  assert.ok(second.nextCursor);
  const third = await env.browse.listBundleFiles(actor(owner.principalId), {
    mind: mind.handle,
    cursor: second.nextCursor,
    limit: 1,
  });
  assert.deepEqual(third.files.map((file) => ({
    path: file.path,
    inlineEligible: file.inlineEligible,
    referenceStatus: file.referenceStatus,
  })), [{
    path: "assets/spoofed.png",
    inlineEligible: false,
    referenceStatus: "invalid_reference",
  }]);
  assert.equal(third.nextCursor, null);

  const historical = await env.browse.listBundleFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: oldRevision },
    limit: 10,
  });
  assert.deepEqual(historical.files.map((file) => file.path), [
    "assets/a.png",
    "assets/b.pdf",
    "assets/spoofed.png",
  ]);
  const current = await env.browse.listBundleFiles(actor(owner.principalId), {
    mind: mind.handle,
    limit: 10,
  });
  assert.equal(current.resolvedRevision.revisionId, currentRevision);
  assert.deepEqual(current.files.map((file) => file.path), ["assets/current.zip"]);
});

test("differential file operations compose over one exact mixed-file revision with bounded continuations", async (t) => {
  try {
    assert.match(execFileSync("rg", ["--version"], { encoding: "utf8" }), /^ripgrep 15\.2\.0$/mu);
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("external ripgrep oracle is unavailable; run gate:file-operations-differential");
      return;
    }
    throw error;
  }
  const env = harness();
  const owner = await createAccount(env, 31, "File Operation Owner");
  const mind = await createMind(env, owner, "file-operation-fixture");
  const markdownFiles = fixtureFiles();
  const opaqueFiles = [
    {
      path: "data/profile.json",
      mediaType: "application/json",
      bytes: encoder.encode('{"team":"runtime","rank":2,"enabled":true}\n'),
    },
    {
      path: "data/settings.yaml",
      mediaType: "application/yaml",
      bytes: encoder.encode("team: product\nrank: 1\n"),
    },
    {
      path: "data/routes.csv",
      mediaType: "text/csv",
      bytes: encoder.encode("route_id,route_short_name\n1,Airport\n2,Funchal\n"),
    },
    {
      path: "notes/plain.txt",
      mediaType: "text/plain",
      bytes: encoder.encode("first line\nneedle café 🧠\nlast line\n"),
    },
    {
      path: "logs/crlf.log",
      mediaType: "text/plain",
      bytes: encoder.encode("первая строка\r\nneedle warning\r\nlast\r\n"),
    },
    {
      path: "code/example.ts",
      mediaType: "text/plain",
      bytes: encoder.encode("export const needle = /a+b?/u;\n"),
    },
    {
      path: "notes/über [x].txt",
      mediaType: "text/plain",
      bytes: encoder.encode("literal .* characters\n"),
    },
    {
      path: "notes/empty.txt",
      mediaType: "text/plain",
      bytes: new Uint8Array(),
    },
    {
      path: "assets/manual.pdf",
      mediaType: "application/pdf",
      bytes: encoder.encode("%PDF-1.7\nneedle-hidden\n"),
    },
  ];
  const exactRevision = await commitMixedFiles(
    env,
    owner,
    mind,
    markdownFiles,
    opaqueFiles,
    "Seed exact file-operation fixture",
  );

  const oracleRoot = await mkdtemp(join(tmpdir(), "mind-diary-file-operations-"));
  t.after(() => rm(oracleRoot, { recursive: true, force: true }));
  for (const file of markdownFiles) {
    const target = join(oracleRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text);
  }
  for (const file of opaqueFiles) {
    const target = join(oracleRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  const firstList = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    includeGlobs: ["**/*.md"],
    limit: 2,
  });
  assert.equal(firstList.resolvedRevision.revisionId, exactRevision);
  assert.deepEqual(firstList.files.map((file) => file.path), [
    "concepts/alpha.md",
    "concepts/beta.md",
  ]);
  assert.equal(firstList.incomplete, true);
  assert.ok(firstList.nextCursor);
  const fullMarkdownList = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    includeGlobs: ["**/*.md"],
    limit: 100,
  });
  const localMarkdownPaths = execFileSync(
    "rg",
    ["--files", "--hidden", "--no-ignore", "--glob", "**/*.md"],
    { cwd: oracleRoot, encoding: "utf8" },
  ).trim().split("\n").sort();
  assert.deepEqual(fullMarkdownList.files.map((file) => file.path), localMarkdownPaths);

  const metadataList = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    kinds: ["markdown"],
    where: { field: "metadata.type", op: "eq", value: "Reference" },
    selectMetadataFields: ["metadata.title", "metadata.tags"],
    sort: [{ field: "metadata.title", direction: "desc" }],
    aggregate: { kind: "distinct", field: "metadata.type" },
    limit: 10,
  });
  assert.deepEqual(metadataList.files.map((file) => file.path), [
    "concepts/nested/gamma.md",
    "concepts/beta.md",
    "concepts/alpha.md",
  ]);
  assert.deepEqual(metadataList.aggregate, {
    kind: "distinct",
    field: "metadata.type",
    values: ["Reference"],
  });
  const metadataPageOne = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    kinds: ["markdown"],
    where: { field: "metadata.type", op: "eq", value: "Reference" },
    sort: [{ field: "metadata.title", direction: "asc" }],
    limit: 2,
  });
  assert.equal(metadataPageOne.files.length, 2);
  assert.equal(metadataPageOne.incomplete, true);
  assert.ok(metadataPageOne.nextCursor);
  const metadataPageTwo = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    kinds: ["markdown"],
    where: { field: "metadata.type", op: "eq", value: "Reference" },
    sort: [{ field: "metadata.title", direction: "asc" }],
    cursor: metadataPageOne.nextCursor,
    limit: 2,
  });
  assert.equal(metadataPageTwo.files.length, 1);
  assert.equal(metadataPageTwo.incomplete, false);
  assert.equal(metadataPageTwo.nextCursor, null);
  assert.deepEqual(
    [...metadataPageOne.files, ...metadataPageTwo.files].map(({ path }) => path),
    ["concepts/alpha.md", "concepts/beta.md", "concepts/nested/gamma.md"],
  );
  const manifestOnlyList = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    sort: [{ field: "revisionId", direction: "asc" }],
    limit: 100,
  });
  assert.equal(manifestOnlyList.scanned.files, 0);
  assert.equal(manifestOnlyList.files.every((file) => file.revisionId === exactRevision), true);
  const structuredMetadata = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    kinds: ["opaque"],
    where: { field: "metadata.rank", op: "gte", value: 1 },
    selectMetadataFields: ["metadata.team", "metadata.rank"],
    sort: [{ field: "metadata.rank", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(structuredMetadata.files.map((file) => ({
    path: file.path,
    metadata: file.metadata,
  })), [
    { path: "data/settings.yaml", metadata: { "metadata.team": "product", "metadata.rank": 1 } },
    { path: "data/profile.json", metadata: { "metadata.team": "runtime", "metadata.rank": 2 } },
  ]);

  const grep = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    patterns: ["needle", "café"],
    syntax: "literal",
    includeGlobs: ["notes/**", "assets/**"],
    output: "matches",
    limit: 10,
  });
  assert.equal(grep.resolvedRevision.revisionId, exactRevision);
  assert.deepEqual(grep.files.map((file) => file.path), ["notes/plain.txt"]);
  assert.equal(grep.files[0].matchingLines, 1);
  assert.equal(grep.files[0].occurrences, 2);
  assert.equal(grep.files[0].count, 1);
  assert.equal(grep.countUnit, "matching_lines");
  assert.deepEqual(grep.files[0].matches[0].spans.map((span) => span.patternIndex), [0, 1]);
  assert.deepEqual(grep.errors, [{
    path: "assets/manual.pdf",
    error: { code: "file_not_text", retryable: false },
  }]);
  const importedText = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: exactRevision },
    paths: ["data/profile.json", "data/routes.csv", "notes/plain.txt"],
    patterns: ["runtime", "Airport", "café"],
    syntax: "literal",
    output: "matches",
    limit: 10,
  });
  assert.deepEqual(importedText.files.map((file) => file.path), [
    "data/profile.json",
    "data/routes.csv",
    "notes/plain.txt",
  ]);
  assert.deepEqual(importedText.errors, []);
  const importedRead = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: exactRevision },
    requests: [
      { path: "data/profile.json", mode: "whole" },
      { path: "data/routes.csv", mode: "lines", startLine: 2, endLine: 2 },
      { path: "notes/plain.txt", mode: "lines", startLine: 2, endLine: 2 },
    ],
  });
  assert.deepEqual(importedRead.items.map((item) => item.file.text), [
    '{"team":"runtime","rank":2,"enabled":true}\n',
    "1,Airport\n",
    "needle café 🧠\n",
  ]);
  const localGrep = execFileSync(
    "rg",
    ["--json", "--fixed-strings", "-e", "needle", "-e", "café", "notes/plain.txt"],
    { cwd: oracleRoot, encoding: "utf8" },
  ).trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.type === "match");
  assert.ok(localGrep);
  assert.equal(grep.files[0].matches[0].lineNumber, localGrep.data.line_number);
  assert.deepEqual(
    grep.files[0].matches[0].spans.map(({ startByte, endByte }) => ({
      start: startByte - grep.files[0].matches[0].startByte,
      end: endByte - grep.files[0].matches[0].startByte,
    })),
    localGrep.data.submatches.map(({ start, end }) => ({ start, end })),
  );
  const regexCount = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    paths: ["notes/plain.txt"],
    patterns: ["(needle|café)"],
    syntax: "regex",
    output: "count",
    countUnit: "occurrences",
  });
  assert.equal(regexCount.files[0].matchingLines, 1);
  assert.equal(regexCount.files[0].occurrences, 2);
  assert.equal(regexCount.files[0].count, 2);
  assert.equal(regexCount.countUnit, "occurrences");
  const localRegex = execFileSync(
    "rg",
    ["--json", "-e", "(needle|café)", "notes/plain.txt"],
    { cwd: oracleRoot, encoding: "utf8" },
  ).trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.type === "match");
  assert.equal(regexCount.files[0].matchingLines, localRegex.length);
  assert.equal(
    regexCount.files[0].occurrences,
    localRegex.reduce((sum, row) => sum + row.data.submatches.length, 0),
  );
  const comparedPaths = ["notes/plain.txt", "logs/crlf.log", "code/example.ts", "notes/empty.txt"];
  const filesWithMatches = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    paths: comparedPaths,
    patterns: ["needle"],
    output: "files_with_matches",
  });
  const localFilesWithMatches = execFileSync(
    "rg",
    ["--files-with-matches", "--fixed-strings", "needle", ...comparedPaths],
    { cwd: oracleRoot, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(filesWithMatches.files.map(({ path }) => path), localFilesWithMatches);
  const filesWithoutMatch = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    paths: comparedPaths,
    patterns: ["needle"],
    output: "files_without_match",
  });
  const localFilesWithoutMatch = execFileSync(
    "rg",
    ["--files-without-match", "--fixed-strings", "needle", ...comparedPaths],
    { cwd: oracleRoot, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(filesWithoutMatch.files.map(({ path }) => path), localFilesWithoutMatch);
  const literalRegexSyntax = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    paths: ["notes/plain.txt"],
    patterns: ["needle(?= warning)"],
    syntax: "literal",
  });
  assert.equal(literalRegexSyntax.files.length, 0);
  await assert.rejects(
    env.browse.grepFiles(actor(owner.principalId), {
      mind: mind.handle,
      patterns: ["needle(?= warning)"],
      syntax: "regex",
    }),
    expectFailure("unsupported_pattern"),
  );
  await assert.rejects(
    env.browse.grepFiles(actor(owner.principalId), {
      mind: mind.handle,
      patterns: ["needle"],
      caseSensitive: "false",
    }),
    expectFailure("invalid_file_operation"),
  );
  await assert.rejects(
    env.browse.listFiles(actor(owner.principalId), {
      mind: mind.handle,
      recursive: 1,
    }),
    expectFailure("invalid_file_operation"),
  );
  await assert.rejects(
    env.browse.listFiles(actor(owner.principalId), {
      mind: mind.handle,
      prefix: "x".repeat(1_025),
    }),
    expectFailure("invalid_file_operation"),
  );

  const rangedRead = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    requests: [
      { path: "notes/plain.txt", mode: "head", count: 1 },
      { path: "notes/plain.txt", mode: "lines", startLine: 2, endLine: 2 },
      { path: "logs/crlf.log", mode: "tail", count: 1 },
      { path: "notes/empty.txt", mode: "whole" },
    ],
    maxOutputBytes: 1_024,
  });
  assert.deepEqual(rangedRead.items.map((item) => item.file.text), [
    "first line\n",
    "needle café 🧠\n",
    "last\r\n",
    "",
  ]);

  let streamedBytes = 0;
  let streamCanceled = false;
  const streamingObjects = {
    ...env.observedObjects,
    openBundleFileRange: undefined,
    openBundleFile: async (spaceId, sha256) => {
      const object = await env.objects.getBundleFile(spaceId, sha256);
      if (object === null) return null;
      let offset = 0;
      return {
        ...object,
        body: new ReadableStream({
          pull(controller) {
            if (offset >= object.bytes.byteLength) {
              controller.close();
              return;
            }
            controller.enqueue(object.bytes.slice(offset, offset + 1));
            offset += 1;
            streamedBytes += 1;
          },
          cancel() { streamCanceled = true; },
        }),
      };
    },
  };
  const streamingBrowse = new MindBrowseService({
    store: env.metadata,
    objects: streamingObjects,
    host: HOST,
    locators: env.locators,
  });
  const streamedHead = await streamingBrowse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: exactRevision },
    requests: [{ path: "notes/plain.txt", mode: "head", count: 1 }],
  });
  assert.equal(streamedHead.items[0].file.text, "first line\n");
  assert.equal(streamCanceled, false);
  assert.equal(streamedBytes, opaqueFiles.find(({ path }) => path === "notes/plain.txt").bytes.byteLength);
  assert.equal(streamedHead.items[0].file.lineRange.total, null);

  streamedBytes = 0;
  streamCanceled = false;
  const streamedLines = await streamingBrowse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: exactRevision },
    requests: [{ path: "notes/plain.txt", mode: "lines", startLine: 2, endLine: 2 }],
  });
  assert.equal(streamedLines.items[0].file.text, "needle café 🧠\n");
  assert.equal(streamCanceled, false);
  assert.equal(streamedBytes, opaqueFiles.find(({ path }) => path === "notes/plain.txt").bytes.byteLength);
  assert.equal(streamedLines.items[0].file.lineRange.total, null);

  const firstRead = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    requests: [
      { path: "notes/plain.txt", mode: "whole" },
      { path: "assets/manual.pdf", mode: "whole" },
    ],
    maxOutputBytes: 16,
  });
  assert.equal(firstRead.resolvedRevision.revisionId, exactRevision);
  assert.equal(firstRead.items[0].kind, "file");
  assert.equal(firstRead.items[0].file.text, "first line\nneedl");
  assert.equal(firstRead.items[0].file.truncated, true);
  assert.equal(firstRead.incomplete, true);
  assert.ok(firstRead.nextCursor);

  await commitMixedFiles(
    env,
    owner,
    mind,
    fixtureFiles("NEW_HEAD_BODY", "NEW_HEAD_BODY"),
    [],
    "Move HEAD after exact file-operation cursor issuance",
  );
  let readCursor = firstRead.nextCursor;
  let reconstructed = firstRead.items[0].file.text;
  let finalRead;
  while (readCursor !== null) {
    finalRead = await env.browse.readFiles(actor(owner.principalId), {
      mind: mind.handle,
      requests: [
        { path: "notes/plain.txt", mode: "whole" },
        { path: "assets/manual.pdf", mode: "whole" },
      ],
      cursor: readCursor,
      maxOutputBytes: 16,
    });
    assert.equal(finalRead.resolvedRevision.revisionId, exactRevision);
    for (const item of finalRead.items) {
      if (item.kind === "file") reconstructed += item.file.text;
    }
    readCursor = finalRead.nextCursor;
  }
  assert.equal(reconstructed, "first line\nneedle café 🧠\nlast line\n");
  assert.deepEqual(
    encoder.encode(reconstructed),
    new Uint8Array(await readFile(join(oracleRoot, "notes/plain.txt"))),
  );
  assert.deepEqual(finalRead.items.at(-1), {
    kind: "error",
    path: "assets/manual.pdf",
    error: { code: "file_not_text", retryable: false },
  });
  assert.equal(finalRead.nextCursor, null);

  const invalidBoundary = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: exactRevision },
    requests: [{ path: "notes/plain.txt", mode: "bytes", startByte: 24, endByte: 26 }],
  });
  assert.equal(invalidBoundary.items[0].kind, "error");
  assert.equal(invalidBoundary.items[0].error.code, "utf8_boundary_required");
});

test("file-operation budgets always advance or fail explicitly and abort a stalled head stream", async () => {
  const env = harness();
  const owner = await createAccount(env, 32, "File Budget Owner");
  const mind = await createMind(env, owner, "file-budget-fixture");
  const lateRow = "trip-late,25:10:00,25:10:00,stop-9000\n";
  const largeText = encoder.encode(
    `trip_id,arrival_time,departure_time,stop_id\n${"x".repeat(17 * 1024 * 1024)}\n${lateRow}`,
  );
  const oversized = encoder.encode(`{"needle":"${"x".repeat((32 * 1024 * 1024) + 1)}"}\n`);
  const revisionId = await commitMixedFiles(env, owner, mind, fixtureFiles(), [
    { path: "data/oversized.json", mediaType: "application/json", bytes: oversized },
    { path: "data/stop_times.txt", mediaType: "text/plain", bytes: largeText },
    { path: "notes/paged.txt", mediaType: "text/plain", bytes: encoder.encode("needle\nneedlez\n") },
    { path: "notes/stalled.txt", mediaType: "text/plain", bytes: encoder.encode("needle\ntail\n") },
  ], "Seed budget progress fixture");

  const listed = await env.browse.listFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    paths: ["data/oversized.json"],
    selectMetadataFields: ["metadata.needle"],
  });
  assert.equal(listed.incomplete, false);
  assert.equal(listed.nextCursor, null);
  assert.equal(listed.files[0].metadataStatus, "unsupported");

  const oversizedGrep = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    paths: ["data/oversized.json"],
    patterns: ["needle"],
  });
  assert.equal(oversizedGrep.incomplete, false);
  assert.equal(oversizedGrep.nextCursor, null);
  assert.deepEqual(oversizedGrep.errors, [{
    path: "data/oversized.json",
    error: { code: "file_scan_limit_exceeded", retryable: false },
  }]);

  const largeGrep = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    paths: ["data/stop_times.txt"],
    patterns: ["trip-late"],
    maxOutputBytes: 128,
  });
  assert.equal(largeGrep.resolvedRevision.revisionId, revisionId);
  assert.equal(largeGrep.incomplete, false);
  assert.equal(largeGrep.scanned.bytes, largeText.byteLength);
  assert.equal(largeGrep.files[0].matches[0].lineNumber, 3);
  assert.equal(largeGrep.files[0].matches[0].text, lateRow.trimEnd());
  const lateRowStart = largeText.byteLength - encoder.encode(lateRow).byteLength;
  env.observedObjects.reset();
  const largeRange = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    requests: [{
      path: "data/stop_times.txt",
      mode: "bytes",
      startByte: lateRowStart,
      endByte: largeText.byteLength,
    }],
    maxOutputBytes: 128,
  });
  assert.equal(largeRange.items[0].file.text, lateRow);
  assert.deepEqual(largeRange.items[0].file.byteRange, {
    start: lateRowStart,
    end: largeText.byteLength,
    total: largeText.byteLength,
  });
  assert.equal(env.observedObjects.rangeReads(), 1);
  assert.ok(env.observedObjects.rangeBytes() <= encoder.encode(lateRow).byteLength + 3);
  const largeHead = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    requests: [{ path: "data/stop_times.txt", mode: "head", count: 1 }],
  });
  assert.equal(
    largeHead.items[0].file.text,
    "trip_id,arrival_time,departure_time,stop_id\n",
  );
  assert.equal(largeHead.items[0].file.lineRange.total, null);

  const largeWholeFirst = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    requests: [{ path: "data/stop_times.txt", mode: "whole" }],
    maxOutputBytes: 64,
  });
  assert.equal(largeWholeFirst.resolvedRevision.revisionId, revisionId);
  assert.equal(largeWholeFirst.incompleteReason, "response_budget");
  assert.ok(largeWholeFirst.nextCursor);
  await commitMixedFiles(
    env,
    owner,
    mind,
    fixtureFiles("NEW_HEAD_BODY", "NEW_HEAD_BODY"),
    [],
    "Move HEAD after large-text cursor issuance",
  );
  const largeWholeSecond = await env.browse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    requests: [{ path: "data/stop_times.txt", mode: "whole" }],
    cursor: largeWholeFirst.nextCursor,
    maxOutputBytes: 64,
  });
  assert.equal(largeWholeSecond.resolvedRevision.revisionId, revisionId);
  assert.equal(
    largeWholeSecond.items[0].file.byteRange.start,
    largeWholeFirst.items[0].file.byteRange.end,
  );

  const firstGrep = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    paths: ["notes/paged.txt"],
    patterns: ["needle"],
    maxOutputBytes: 10,
  });
  assert.equal(firstGrep.files[0].matchingLines, 1);
  assert.equal(firstGrep.files[0].occurrences, 1);
  assert.equal(firstGrep.files[0].matches.length, 1);
  assert.equal(firstGrep.incompleteReason, "response_budget");
  assert.ok(firstGrep.nextCursor);
  const secondGrep = await env.browse.grepFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    paths: ["notes/paged.txt"],
    patterns: ["needle"],
    maxOutputBytes: 10,
    cursor: firstGrep.nextCursor,
  });
  assert.equal(secondGrep.files[0].matchingLines, 1);
  assert.equal(secondGrep.files[0].occurrences, 1);
  assert.equal(secondGrep.files[0].matches[0].text, "needlez");
  assert.equal(secondGrep.nextCursor, null);

  await assert.rejects(
    env.browse.grepFiles(actor(owner.principalId), {
      mind: mind.handle,
      revisionSelector: { kind: "revision", revisionId },
      paths: ["notes/paged.txt"],
      patterns: ["needle"],
      maxOutputBytes: 4,
    }),
    expectFailure("file_operation_budget_exhausted"),
  );

  let streamCanceled = false;
  const stalledObjects = {
    ...env.observedObjects,
    openBundleFileRange: undefined,
    openBundleFile: async (spaceId, sha256) => {
      const object = await env.objects.getBundleFile(spaceId, sha256);
      if (object === null) return null;
      return {
        ...object,
        body: new ReadableStream({
          cancel() { streamCanceled = true; },
        }),
      };
    },
  };
  const stalledBrowse = new MindBrowseService({
    store: env.metadata,
    objects: stalledObjects,
    host: HOST,
    locators: env.locators,
  });
  const controller = new AbortController();
  const stalledRead = stalledBrowse.readFiles(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId },
    requests: [{ path: "notes/stalled.txt", mode: "head", count: 1 }],
  }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(stalledRead, expectFailure("file_operation_budget_exhausted"));
  assert.equal(streamCanceled, true);
});

test("file operations compare their initial authorization with a separately refreshed final stamp", async () => {
  const env = harness();
  const owner = await createAccount(env, 41, "File Authorization Owner");
  const viewer = await createAccount(env, 42, "File Authorization Viewer");
  const mind = await createMind(env, owner, "file-authorization-race");
  const authorize = new CapabilityAuthorizer(env.metadata);
  let rechecks = 0;
  const finalAuthorizationRecheck = async (currentActor, request) => {
    rechecks += 1;
    assert.equal(
      await env.metadata.changeOrdinaryVisibilityForTest(
        mind.mindId,
        "private",
        CHANGED_AT,
      ),
      true,
    );
    return authorize.authorize({ actor: currentActor, ...request });
  };
  const browse = new MindBrowseService({
    store: env.metadata,
    objects: env.observedObjects,
    host: HOST,
    locators: env.locators,
    finalAuthorizationRecheck,
  });

  for (const operation of [
    () => browse.listFiles(actor(viewer.principalId), { mind: mind.handle }),
    () => browse.grepFiles(actor(viewer.principalId), {
      mind: mind.handle,
      patterns: ["Alpha"],
    }),
    () => browse.readFiles(actor(viewer.principalId), {
      mind: mind.handle,
      requests: [{ path: "index.md", mode: "head", count: 1 }],
    }),
  ]) {
    assert.equal(
      await env.metadata.changeOrdinaryVisibilityForTest(
        mind.mindId,
        "public",
        CHANGED_AT,
      ),
      true,
    );
    await assert.rejects(operation(), expectFailure("mind_not_found"));
  }
  assert.equal(rechecks, 3);
});

test("entry and continuation locators stay on one exact revision across a HEAD move", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Revision Owner");
  const oldBody = "OLD_REVISION_BODY with UTF-8 scalars: 🧠 café Madeira. ".repeat(6);
  const oldFiles = fixtureFiles(oldBody);
  const seededMind = await createMind(env, owner, "immutable-fetch-seeded", oldFiles);
  const oldRevision = await commitMixedFiles(
    env,
    owner,
    seededMind,
    oldFiles,
    [],
    "Promote exact fetch fixture to Space-canonical storage",
  );
  const oldBrowse = await env.browse.browseEntries(actor(owner.principalId), {
    mind: seededMind.handle,
    path: "concepts",
    limit: 10,
  });
  const oldEntry = oldBrowse.entries.find((entry) => entry.path === "concepts/alpha.md");
  assert.ok(oldEntry);
  assert.equal(oldEntry.revisionId, oldRevision);
  assert.match(oldEntry.entryId, /^mdl1_[A-Za-z0-9_-]+$/);
  assert.equal(oldEntry.entryId.includes(seededMind.mindId), false);
  assert.equal(oldEntry.resourceUri.includes("mdl1_"), false);
  assert.equal(oldEntry.resourceUri.includes("mdp_v1_"), false);

  env.observedObjects.reset();
  const firstPage = await env.browse.fetch(actor(owner.principalId), {
    id: oldEntry.entryId,
    maxBytes: 17,
  });
  assert.equal(firstPage.entry.entryId, oldEntry.entryId);
  assert.equal(firstPage.truncated, true);
  assert.ok(firstPage.continuationId);
  const oldCanonical = oldFiles.find((file) => file.path === "concepts/alpha.md").text;

  const newCanonical = concept("Alpha", "NEW_HEAD_BODY");
  const newRevision = await commitFiles(
    env,
    owner,
    seededMind,
    [
      { path: "index.md", text: rootIndex([["Alpha", "concepts/alpha.md"]]) },
      { path: "concepts/alpha.md", text: newCanonical },
    ],
    "Move HEAD",
  );
  assert.notEqual(newRevision, oldRevision);

  const rest = await fetchAll(
    env.browse,
    actor(owner.principalId),
    firstPage.continuationId,
    7,
  );
  assert.equal(firstPage.text + rest.text, oldCanonical);
  assert.equal(rest.ranges.every((range) => range.end > range.start), true);
  assert.ok(env.observedObjects.rangeReads() > 1);
  assert.ok(
    env.observedObjects.rangeBytes() <
      encoder.encode(oldCanonical).byteLength * env.observedObjects.rangeReads(),
  );
  const replay = await env.browse.fetch(actor(owner.principalId), {
    id: oldEntry.entryId,
    maxBytes: 17,
  });
  assert.equal(replay.text, firstPage.text);
  assert.deepEqual(replay.range, firstPage.range);

  const oldResource = await env.browse.readResource(
    actor(owner.principalId),
    oldEntry.resourceUri,
  );
  assert.equal(oldResource.text, oldCanonical);
  assert.equal(oldResource.entry.revisionId, oldRevision);

  assert.equal(await env.metadata.readHead(seededMind.mindId), newRevision);
  assert.equal(oldResource.entry.resourceUri, oldEntry.resourceUri);
});

test("tampering, cross-Mind/revision reuse, stale cursors, and invalid budgets fail without changing HEAD", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Boundary Owner");
  const firstMind = await createMind(env, owner, "boundary-first");
  const secondMind = await createMind(env, owner, "boundary-second");
  const firstRevision = firstMind.headRevisionId;
  const secondRevision = secondMind.headRevisionId;
  const first = await env.browse.browseEntries(actor(owner.principalId), {
    mind: firstMind.handle,
    path: "concepts",
    limit: 1,
  });
  assert.ok(first.nextCursor);
  const entry = first.entries[0];
  const originalFirstHead = await env.metadata.readHead(firstMind.mindId);
  const originalSecondHead = await env.metadata.readHead(secondMind.mindId);

  const last = entry.entryId.at(-1);
  const tampered = `${entry.entryId.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  await assert.rejects(
    env.browse.fetch(actor(owner.principalId), { id: tampered }),
    expectFailure("locator_not_found"),
  );
  for (const maxBytes of [0, 3, 1024 * 1024 + 1, 4.5]) {
    await assert.rejects(
      env.browse.fetch(actor(owner.principalId), {
        id: entry.entryId,
        maxBytes,
      }),
      expectFailure("invalid_fetch_budget"),
    );
  }
  await assert.rejects(
    env.browse.browseEntries(actor(owner.principalId), {
      mind: secondMind.handle,
      path: "concepts",
      cursor: first.nextCursor,
    }),
    expectFailure("invalid_cursor"),
  );

  const crossRevisionUri = exactRevisionResourceUri(
    firstMind.mindId,
    secondRevision,
    entry.path,
  );
  env.observedObjects.reset();
  await assert.rejects(
    env.browse.readResource(actor(owner.principalId), crossRevisionUri),
    expectFailure("resource_not_found"),
  );
  assert.equal(env.observedObjects.reads(), 0);
  await assert.rejects(
    env.browse.readResource(
      actor(owner.principalId),
      entry.resourceUri.replace("/entries/", "/entries/%252e%252e/"),
    ),
    expectFailure("resource_not_found"),
  );

  assert.equal(await env.metadata.readHead(firstMind.mindId), firstRevision);
  assert.equal(await env.metadata.readHead(secondMind.mindId), originalSecondHead);
  assert.equal(await env.metadata.readHead(firstMind.mindId), originalFirstHead);
});

test("denial, access races, retry, and whole-Mind deletion authorize before object reads", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Access Owner");
  const viewer = await createAccount(env, 2, "Access Viewer");
  const mind = await createMind(env, owner, "access-race");
  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "public", CHANGED_AT),
    true,
  );
  const publicBrowse = await env.browse.browseEntries(actor(viewer.principalId), {
    mind: mind.handle,
    path: "concepts",
    limit: 10,
  });
  const locator = publicBrowse.entries[0];
  const headBeforeDenial = await env.metadata.readHead(mind.mindId);

  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "private", CHANGED_AT),
    true,
  );
  env.observedObjects.reset();
  await assert.rejects(
    env.browse.fetch(actor(viewer.principalId), { id: locator.entryId }),
    expectFailure("locator_not_found"),
  );
  await assert.rejects(
    env.browse.readResource(actor(viewer.principalId), locator.resourceUri),
    expectFailure("resource_not_found"),
  );
  await assert.rejects(
    env.browse.browseEntries(actor(viewer.principalId), {
      mind: mind.handle,
      path: "concepts",
    }),
    expectFailure("mind_not_found"),
  );
  assert.equal(env.observedObjects.reads(), 0);
  assert.equal(await env.metadata.readHead(mind.mindId), headBeforeDenial);

  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "public", CHANGED_AT),
    true,
  );
  const originalReadRevision = env.metadata.readRevision.bind(env.metadata);
  let raced = false;
  const racingStore = new Proxy(env.metadata, {
    get(target, property) {
      if (property === "readRevision") {
        return async (spaceId, revisionId) => {
          const envelope = await originalReadRevision(spaceId, revisionId);
          if (!raced && spaceId === mind.mindId) {
            raced = true;
            assert.equal(
              await env.metadata.changeOrdinaryVisibilityForTest(
                mind.mindId,
                "private",
                CHANGED_AT,
              ),
              true,
            );
          }
          return envelope;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const racingBrowse = new MindBrowseService({
    store: racingStore,
    objects: env.observedObjects,
    host: HOST,
    locators: env.locators,
  });
  env.observedObjects.reset();
  await assert.rejects(
    racingBrowse.fetch(actor(viewer.principalId), { id: locator.entryId }),
    expectFailure("locator_not_found"),
  );
  assert.equal(raced, true);
  assert.equal(env.observedObjects.reads(), 0);
  await assert.rejects(
    racingBrowse.fetch(actor(viewer.principalId), { id: locator.entryId }),
    expectFailure("locator_not_found"),
  );
  assert.equal(env.observedObjects.reads(), 0);

  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "public", CHANGED_AT),
    true,
  );
  const retried = await racingBrowse.fetch(actor(viewer.principalId), {
    id: locator.entryId,
    maxBytes: 1024,
  });
  assert.equal(retried.entry.revisionId, locator.revisionId);
  assert.equal(retried.text.includes("PRIVATE_ALPHA_BODY"), true);
  assert.equal(env.observedObjects.reads(), 1);

  const preview = await env.deletion.getDeletionImpact(
    actor(owner.principalId, "request_browse_delete_preview", DELETE_AT),
    { handle: mind.handle },
  );
  await env.deletion.deleteSpace(
    actor(owner.principalId, "request_browse_delete", DELETE_AT),
    {
      handle: mind.handle,
      impactId: preview.impactId,
      confirmation: preview.confirmation,
      idempotencyKey: "delete-browse-target",
    },
  );
  env.observedObjects.reset();
  await assert.rejects(
    env.browse.fetch(actor(owner.principalId), { id: locator.entryId }),
    expectFailure("locator_not_found"),
  );
  await assert.rejects(
    env.browse.readResource(actor(owner.principalId), locator.resourceUri),
    expectFailure("resource_not_found"),
  );
  assert.equal(env.observedObjects.reads(), 0);
  assert.equal(await env.metadata.readHead(mind.mindId), null);
  assert.equal(
    await env.metadata.readRevision(mind.mindId, locator.revisionId),
    null,
  );
});

test("browse, fetch, and MCP resource reads reauthorize after response locators are materialized", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Final Authorization Owner");
  const viewer = await createAccount(env, 2, "Final Authorization Viewer");
  const mind = await createMind(env, owner, "final-authorization");
  const setVisibility = (visibility) =>
    env.metadata.changeOrdinaryVisibilityForTest(
      mind.mindId,
      visibility,
      CHANGED_AT,
    );
  assert.equal(await setVisibility("public"), true);

  const discovered = await env.browse.browseEntries(actor(viewer.principalId), {
    mind: mind.handle,
    path: "concepts",
    limit: 10,
  });
  const entry = discovered.entries.find(
    (candidate) => candidate.path === "concepts/alpha.md",
  );
  assert.ok(entry);

  const browseLocators = locatorsWithRevocation(env.locators, 2, async () => {
    assert.equal(await setVisibility("private"), true);
  });
  const racingBrowse = new MindBrowseService({
    store: env.metadata,
    objects: env.observedObjects,
    host: HOST,
    locators: browseLocators,
  });
  env.observedObjects.reset();
  await assert.rejects(
    racingBrowse.browseEntries(actor(viewer.principalId), {
      mind: mind.handle,
      path: "concepts",
      limit: 1,
    }),
    expectFailure("mind_not_found"),
  );
  assert.equal(browseLocators.encodes(), 2);
  assert.equal(env.observedObjects.reads(), 1);

  assert.equal(await setVisibility("public"), true);
  const fetchLocators = locatorsWithRevocation(env.locators, 1, async () => {
    assert.equal(await setVisibility("private"), true);
  });
  const racingFetch = new MindBrowseService({
    store: env.metadata,
    objects: env.observedObjects,
    host: HOST,
    locators: fetchLocators,
  });
  env.observedObjects.reset();
  await assert.rejects(
    racingFetch.fetch(actor(viewer.principalId), {
      id: entry.entryId,
      maxBytes: 16,
    }),
    expectFailure("locator_not_found"),
  );
  assert.equal(fetchLocators.encodes(), 1);
  assert.equal(env.observedObjects.reads(), 1);

  assert.equal(await setVisibility("public"), true);
  const resourceLocators = locatorsWithRevocation(env.locators, 1, async () => {
    assert.equal(await setVisibility("private"), true);
  });
  const racingResources = new MindBrowseService({
    store: env.metadata,
    objects: env.observedObjects,
    host: HOST,
    locators: resourceLocators,
  });
  env.observedObjects.reset();
  await assert.rejects(
    racingResources.readResource(actor(viewer.principalId), entry.resourceUri),
    expectFailure("resource_not_found"),
  );
  assert.equal(resourceLocators.encodes(), 1);
  assert.equal(env.observedObjects.reads(), 1);
});
