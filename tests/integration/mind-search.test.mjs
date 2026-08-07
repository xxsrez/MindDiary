import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import {
  CanonicalRevisionCoordinator,
  MindBrowseService,
  MindSearchFailure,
  MindSearchService,
  WebCryptoMindLocatorCodec,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  verifiedSpaceHost,
} from "@mind-diary/domain";

const BOOTSTRAP_AT = "2026-08-07T20:20:00.000Z";
const COMMITTED_AT = "2026-08-07T20:21:00.000Z";
const ACCESS_AT = "2026-08-07T20:22:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const encoder = new TextEncoder();

function preRegistrationActor(index, displayName = `Search Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.search.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_search_bootstrap_${index}`,
    occurredAtUtc: BOOTSTRAP_AT,
  };
}

function actor(principalId, requestId = "request_search", occurredAtUtc = ACCESS_AT) {
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
    nextPrincipalId: () => `principal_search_${++account}`,
    nextExternalBindingId: () => `binding_search_${account}`,
    nextSpaceId: () => `space_personal_search_${account}`,
    nextMembershipId: () => `membership_personal_search_${account}`,
    nextRevisionId: () => `revision_personal_search_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-search-${account}`,
  };
}

function ordinaryIds() {
  let space = 0;
  let membership = 0;
  let revision = 0;
  return {
    nextSpaceId: () => `space_search_${++space}`,
    nextMembershipId: () => `membership_search_owner_${++membership}`,
    nextRevisionId: () => `revision_search_initial_${++revision}`,
  };
}

function auditIds() {
  let event = 0;
  let outbox = 0;
  return {
    nextAuditEventId: () => `audit_search_${++event}`,
    nextOutboxMessageId: () => `outbox_search_${++outbox}`,
  };
}

function revisionHeadStore(metadata) {
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "readResolvedSpace") {
        return async (spaceId) => {
          const state = await target.inspectOrdinaryMindStateForTest(spaceId);
          const headRevisionId = await target.readHead(spaceId);
          if (state === null || headRevisionId === null) return null;
          return {
            host: state.reservation.host,
            canonicalHandle: state.reservation.canonicalHandle,
            space: { ...state.space, headRevisionId },
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function harness(index = new InMemoryExactRevisionSearchIndex()) {
  const metadata = new InMemoryRevisionMetadataStore();
  const store = revisionHeadStore(metadata);
  const objects = new InMemoryObjectStore();
  const locators = new WebCryptoMindLocatorCodec(new Uint8Array(32).fill(0x73));
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: accountIds(),
  });
  const ordinary = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    ids: ordinaryIds(),
    host: HOST,
  });
  const visibility = new VisibilityControlService({
    ordinaryMinds: metadata,
    objects,
    auditIds: auditIds(),
  });
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const search = new MindSearchService({ store, index, host: HOST, locators });
  const browse = new MindBrowseService({ store, objects, host: HOST, locators });
  let revision = 0;
  return {
    metadata,
    store,
    objects,
    index,
    bootstrap,
    ordinary,
    visibility,
    revisions,
    search,
    browse,
    nextRevisionId: () => `revision_search_content_${++revision}`,
  };
}

async function createAccount(env, index, displayName) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function createMind(env, owner, handle) {
  return env.ordinary.createSpaceWithOwner(
    actor(owner.principalId, `request_create_${handle}`, COMMITTED_AT),
    { name: handle, handle, idempotencyKey: `create-${handle}` },
  );
}

function rootIndex(body = "- [Atlas](concepts/atlas.md)") {
  return `---\nokf_version: "0.2"\n---\n\n# Search fixture\n\n${body}\n`;
}

function concept({ title, description, tags, heading, body }) {
  return `---\ntype: Reference\ntitle: ${title}\ndescription: ${description}\ntags:\n${tags
    .map((tag) => `  - ${tag}`)
    .join("\n")}\n---\n\n## ${heading}\n\n${body}\n`;
}

function fixtureFiles(suffix = "old") {
  return [
    { path: "index.md", text: rootIndex() },
    {
      path: "concepts/atlas.md",
      text: concept({
        title: "Orchid Atlas",
        description: "MarineNotation reference",
        tags: ["FieldTag", "atlas"],
        heading: "HeadingGlyph",
        body: `BodyNeedle shared ${suffix}`,
      }),
    },
    {
      path: "concepts/title-ranked.md",
      text: concept({
        title: "Shared Handbook",
        description: "A ranking fixture",
        tags: ["ranking"],
        heading: "Secondary",
        body: "ordinary prose",
      }),
    },
    {
      path: "concepts/body-ranked.md",
      text: concept({
        title: "Body fixture",
        description: "A lower weight fixture",
        tags: ["ranking"],
        heading: "Secondary",
        body: "shared appears in the body",
      }),
    },
  ];
}

async function commitFiles(env, owner, mind, files, summary) {
  const expectedRevisionId = await env.metadata.readHead(mind.mindId);
  assert.ok(expectedRevisionId);
  const result = await env.revisions.commit({
    spaceId: mind.mindId,
    expectedRevisionId,
    revisionId: env.nextRevisionId(),
    committedAt: COMMITTED_AT,
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

async function indexRevision(env, mindId, revisionId, index = env.index) {
  const materialized = await env.revisions.materialize(mindId, revisionId);
  await index.replaceExactRevision({
    spaceId: mindId,
    revisionId,
    documents: materialized.files.map((file) => ({ path: file.path, text: file.text })),
  });
}

async function changeVisibility(env, owner, mind, visibility, suffix) {
  const current = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(current);
  const result = await env.visibility.changeVisibility(
    actor(owner.principalId, `request_visibility_${suffix}`),
    {
      mindId: mind.mindId,
      visibility,
      acknowledgeLiveHeadAndHistoryExposure:
        current.space.visibility === "private" && visibility !== "private",
      expectedMetadataVersion: current.space.metadataVersion,
      idempotencyKey: `visibility-${suffix}`,
    },
  );
  assert.equal(result.changed, true);
}

function expectSearchFailure(code) {
  return (error) => {
    assert.equal(error instanceof MindSearchFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("lexical search covers declared fields, ranks deterministically and emits exact fetch locators", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Search Owner");
  const mind = await createMind(env, owner, "field-search");
  const revisionId = await commitFiles(env, owner, mind, fixtureFiles(), "Seed search");
  await indexRevision(env, mind.mindId, revisionId);
  const ownerActor = actor(owner.principalId);

  for (const [query, field] of [
    ["Orchid", "title"],
    ["MarineNotation", "description"],
    ["FieldTag", "tags"],
    ["HeadingGlyph", "headings"],
    ["BodyNeedle", "body"],
  ]) {
    const result = await env.search.searchEntries(ownerActor, {
      mind: mind.handle,
      query,
    });
    assert.equal(result.resolvedRevision.revisionId, revisionId);
    assert.equal(result.results[0].entry.path, "concepts/atlas.md");
    assert.equal(result.results[0].matchedFields.includes(field), true);
    assert.equal(result.results[0].snippet.toLowerCase().includes(query.toLowerCase()), true);
    assert.equal(result.indexStatus, "ready");
  }

  const ranked = await env.search.searchEntries(ownerActor, {
    mind: mind.mindId,
    query: "shared",
  });
  assert.equal(ranked.results[0].entry.path, "concepts/title-ranked.md");
  assert.equal(ranked.results.every((result) => result.score > 0 && result.score <= 1), true);
  assert.equal(JSON.stringify(ranked).includes("trust"), false);

  const fetched = await env.browse.fetch(ownerActor, {
    id: ranked.results[0].entry.entryId,
  });
  assert.equal(fetched.entry.revisionId, revisionId);
  assert.equal(fetched.entry.path, "concepts/title-ranked.md");
});

test("search cursor is query/revision bound and keeps its immutable snapshot after HEAD moves", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Cursor Owner");
  const mind = await createMind(env, owner, "cursor-search");
  const oldRevision = await commitFiles(env, owner, mind, fixtureFiles("old"), "Old");
  await indexRevision(env, mind.mindId, oldRevision);
  const first = await env.search.searchEntries(actor(owner.principalId), {
    mind: mind.handle,
    query: "shared",
    limit: 1,
  });
  assert.ok(first.nextCursor);
  const newRevision = await commitFiles(env, owner, mind, fixtureFiles("new"), "New");
  await indexRevision(env, mind.mindId, newRevision);

  const continued = await env.search.searchEntries(actor(owner.principalId), {
    mind: mind.handle,
    query: "shared",
    cursor: first.nextCursor,
    limit: 1,
  });
  assert.equal(continued.resolvedRevision.revisionId, oldRevision);
  await assert.rejects(
    env.search.searchEntries(actor(owner.principalId), {
      mind: mind.handle,
      query: "different",
      cursor: first.nextCursor,
    }),
    expectSearchFailure("invalid_cursor"),
  );
  await assert.rejects(
    env.search.searchEntries(actor(owner.principalId), {
      mind: mind.handle,
      revisionSelector: { kind: "head" },
      query: "shared",
      cursor: first.nextCursor,
    }),
    expectSearchFailure("invalid_cursor"),
  );
});

test("missing historical index is unavailable and never falls back to indexed HEAD", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "History Search Owner");
  const mind = await createMind(env, owner, "historical-search");
  const oldRevision = await commitFiles(env, owner, mind, fixtureFiles("OLD_ONLY"), "Old");
  const headFiles = fixtureFiles("HEAD_ONLY");
  const headRevision = await commitFiles(env, owner, mind, headFiles, "Head");
  await indexRevision(env, mind.mindId, headRevision);

  await assert.rejects(
    env.search.searchEntries(actor(owner.principalId), {
      mind: mind.handle,
      revisionSelector: { kind: "revision", revisionId: oldRevision },
      query: "OLD_ONLY",
    }),
    (error) => {
      expectSearchFailure("search_index_unavailable")(error);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes("HEAD_ONLY"), false);
      return true;
    },
  );
  const head = await env.search.searchEntries(actor(owner.principalId), {
    mind: mind.handle,
    query: "HEAD_ONLY",
  });
  assert.equal(head.resolvedRevision.revisionId, headRevision);
  await indexRevision(env, mind.mindId, oldRevision);
  const historical = await env.search.searchEntries(actor(owner.principalId), {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: oldRevision },
    query: "OLD_ONLY",
  });
  assert.equal(historical.results[0].entry.revisionId, oldRevision);
});

test("index identity/content mismatch and private denial fail closed without cross-Mind text", async () => {
  const reads = { count: 0 };
  const baseIndex = new InMemoryExactRevisionSearchIndex();
  const observedIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => baseIndex.replaceExactRevision(request),
    readExactRevision: async (spaceId, revisionId) => {
      reads.count += 1;
      return baseIndex.readExactRevision(spaceId, revisionId);
    },
    purgeSpace: (spaceId) => baseIndex.purgeSpace(spaceId),
  };
  const env = harness(observedIndex);
  const owner = await createAccount(env, 1, "Isolation Owner");
  const stranger = await createAccount(env, 2, "Isolation Stranger");
  const first = await createMind(env, owner, "first-search");
  const second = await createMind(env, owner, "second-search");
  const firstRevision = await commitFiles(env, owner, first, fixtureFiles("FIRST_ONLY"), "First");
  const secondRevision = await commitFiles(env, owner, second, fixtureFiles("SECOND_SECRET"), "Second");
  const secondMaterialized = await env.revisions.materialize(second.mindId, secondRevision);
  await baseIndex.replaceExactRevision({
    spaceId: first.mindId,
    revisionId: firstRevision,
    documents: secondMaterialized.files.map((file) => ({ path: file.path, text: file.text })),
  });

  await assert.rejects(
    env.search.searchEntries(actor(owner.principalId), {
      mind: first.handle,
      query: "SECOND_SECRET",
    }),
    (error) => {
      expectSearchFailure("search_index_unavailable")(error);
      assert.equal(error.message.includes("SECOND_SECRET"), false);
      return true;
    },
  );
  const readsBeforeDenial = reads.count;
  await assert.rejects(
    env.search.searchEntries(actor(stranger.principalId), {
      mind: first.handle,
      query: "SECOND_SECRET",
    }),
    expectSearchFailure("mind_not_found"),
  );
  assert.equal(reads.count, readsBeforeDenial);
});

test("search reauthorizes after index read and returns no result when baseline access is revoked", async () => {
  const delegate = new InMemoryExactRevisionSearchIndex();
  let revokeAfterRead = async () => {};
  const racingIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => delegate.replaceExactRevision(request),
    readExactRevision: async (spaceId, revisionId) => {
      const result = await delegate.readExactRevision(spaceId, revisionId);
      await revokeAfterRead();
      return result;
    },
    purgeSpace: (spaceId) => delegate.purgeSpace(spaceId),
  };
  const env = harness(racingIndex);
  const owner = await createAccount(env, 1, "Race Owner");
  const visitor = await createAccount(env, 2, "Race Visitor");
  const mind = await createMind(env, owner, "race-search");
  const revisionId = await commitFiles(env, owner, mind, fixtureFiles(), "Race");
  await indexRevision(env, mind.mindId, revisionId);
  await changeVisibility(env, owner, mind, "public", "open");
  let revoked = false;
  revokeAfterRead = async () => {
    if (revoked) return;
    revoked = true;
    await changeVisibility(env, owner, mind, "private", "close");
  };

  await assert.rejects(
    env.search.searchEntries(actor(visitor.principalId), {
      mind: mind.handle,
      query: "BodyNeedle",
    }),
    expectSearchFailure("mind_not_found"),
  );
  const final = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.equal(final.space.visibility, "private");
});

test("a rebuilt lexical index returns the same paths and scores without vector state", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Rebuild Owner");
  const mind = await createMind(env, owner, "rebuild-search");
  const revisionId = await commitFiles(env, owner, mind, fixtureFiles(), "Rebuild");
  await indexRevision(env, mind.mindId, revisionId);
  const first = await env.search.searchEntries(actor(owner.principalId), {
    mind: mind.handle,
    query: "shared",
  });

  const rebuilt = new InMemoryExactRevisionSearchIndex();
  await indexRevision(env, mind.mindId, revisionId, rebuilt);
  const secondService = new MindSearchService({
    store: env.store,
    index: rebuilt,
    host: HOST,
    locators: new WebCryptoMindLocatorCodec(new Uint8Array(32).fill(0x74)),
  });
  const second = await secondService.searchEntries(actor(owner.principalId), {
    mind: mind.handle,
    query: "shared",
  });
  assert.deepEqual(
    second.results.map((result) => [result.entry.path, result.score]),
    first.results.map((result) => [result.entry.path, result.score]),
  );
  assert.equal(Object.hasOwn(rebuilt, "vector"), false);
});
