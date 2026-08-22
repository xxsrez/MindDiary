import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
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
} from "@mind-diary/application-control";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
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
  let concurrentReads = 0;
  let maximumConcurrentReads = 0;
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
    listImmutableObjects: (request) => delegate.listImmutableObjects(request),
    deleteImmutableObject: (request) => delegate.deleteImmutableObject(request),
    reads: () => immutableReads,
    maxConcurrentReads: () => maximumConcurrentReads,
    reset: () => {
      immutableReads = 0;
      concurrentReads = 0;
      maximumConcurrentReads = 0;
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

test("entry and continuation locators stay on one exact revision across a HEAD move", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Revision Owner");
  const oldBody = "OLD_REVISION_BODY with UTF-8 scalars: 🧠 café Madeira. ".repeat(6);
  const oldFiles = fixtureFiles(oldBody);
  const seededMind = await createMind(env, owner, "immutable-fetch-seeded", oldFiles);
  const oldRevision = seededMind.headRevisionId;
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

  const firstPage = await env.browse.fetch(actor(owner.principalId), {
    id: oldEntry.entryId,
    maxBytes: 17,
  });
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
      maxBytes: 1024,
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
