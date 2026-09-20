import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  MindBrowseService,
  MindHistoryFailure,
  MindHistoryService,
  WebCryptoMindLocatorCodec,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  verifiedSpaceHost,
} from "@mind-diary/domain";

const BOOTSTRAP_AT = "2026-08-07T20:00:00.000Z";
const CREATED_AT = "2026-08-07T20:01:00.000Z";
const HISTORY_AT = "2026-08-07T20:02:00.123456789Z";
const ACCESS_AT = "2026-08-07T20:03:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const encoder = new TextEncoder();

function preRegistrationActor(index, displayName = `History Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.history.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_history_bootstrap_${index}`,
    occurredAtUtc: BOOTSTRAP_AT,
  };
}

function actor(
  principalId,
  requestId = "request_history",
  occurredAtUtc = ACCESS_AT,
) {
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
    nextPrincipalId: () => `principal_history_${++account}`,
    nextExternalBindingId: () => `binding_history_${account}`,
    nextSpaceId: () => `space_personal_history_${account}`,
    nextMembershipId: () => `membership_personal_history_${account}`,
    nextRevisionId: () => `revision_personal_history_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-history-${account}`,
  };
}

function ordinaryIds() {
  let space = 0;
  let membership = 0;
  let revision = 0;
  return {
    nextSpaceId: () => `space_history_${++space}`,
    nextMembershipId: () => `membership_history_owner_${++membership}`,
    nextRevisionId: () => `revision_history_initial_${++revision}`,
  };
}

function auditIds() {
  let event = 0;
  let outbox = 0;
  return {
    nextAuditEventId: () => `audit_history_${++event}`,
    nextOutboxMessageId: () => `outbox_history_${++outbox}`,
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

function harness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const store = revisionHeadStore(metadata);
  const objects = new InMemoryObjectStore();
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
  const revisions = new CanonicalRevisionCoordinator({
    objects,
    revisions: metadata,
  });
  const history = new MindHistoryService({ store, host: HOST });
  const browse = new MindBrowseService({
    store,
    objects,
    host: HOST,
    locators: new WebCryptoMindLocatorCodec(new Uint8Array(32).fill(0x68)),
  });
  let revision = 0;
  return {
    metadata,
    store,
    objects,
    bootstrap,
    ordinary,
    visibility,
    revisions,
    history,
    browse,
    nextRevisionId: () => `revision_history_content_${++revision}`,
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
    actor(owner.principalId, `request_create_${handle}`, CREATED_AT),
    { name: handle, handle, idempotencyKey: `create-${handle}` },
  );
}

function indexFile(link = null) {
  return `---\nokf_version: "0.2"\n---\n\n# History fixture\n${
    link === null ? "" : `\n- [Deleted Memory](${link})\n`
  }`;
}

function conceptFile(body) {
  return `---\ntype: Reference\ntitle: Deleted Memory\n---\n\n# Deleted Memory\n\n${body}\n`;
}

async function commitFiles(
  env,
  owner,
  mind,
  files,
  summary,
  committedAt = HISTORY_AT,
) {
  const expectedRevisionId = await env.metadata.readHead(mind.mindId);
  assert.ok(expectedRevisionId);
  const result = await env.revisions.commit({
    spaceId: mind.mindId,
    expectedRevisionId,
    revisionId: env.nextRevisionId(),
    committedAt,
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

async function seedDeletedFileHistory(env, owner, mind) {
  const oldRevision = await commitFiles(
    env,
    owner,
    mind,
    [
      { path: "index.md", text: indexFile("concepts/deleted.md") },
      {
        path: "concepts/deleted.md",
        text: conceptFile("PRIVATE_DELETED_FROM_HEAD_BODY"),
      },
    ],
    "Add a Memory",
  );
  const headRevision = await commitFiles(
    env,
    owner,
    mind,
    [{ path: "index.md", text: indexFile() }],
    "Delete the Memory from HEAD",
  );
  return { oldRevision, headRevision };
}

async function changeVisibility(env, owner, mind, visibility, suffix) {
  const current = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(current);
  return env.visibility.changeVisibility(
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
}

function expectHistoryFailure(code) {
  return (error) => {
    assert.equal(error instanceof MindHistoryFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("Snapshot View pins HEAD, exact and nanosecond UTC as_of while history metadata stays body-free", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "History Owner");
  const mind = await createMind(env, owner, "snapshot-history");
  const initialRevision = mind.headRevisionId;
  const { oldRevision, headRevision } = await seedDeletedFileHistory(env, owner, mind);
  const ownerActor = actor(owner.principalId);

  const head = await env.history.resolveSnapshotView(ownerActor, {
    mind: mind.handle,
    revisionSelector: { kind: "head" },
  });
  assert.equal(head.resolvedRevisionId, headRevision);
  assert.equal(head.revisionMode, "head");
  assert.equal(head.readOnly, false);
  assert.equal(head.contentCapabilities.includes("commit"), true);

  const exact = await env.history.resolveSnapshotView(ownerActor, {
    mind: mind.mindId,
    revisionSelector: { kind: "revision", revisionId: oldRevision },
  });
  assert.equal(exact.resolvedRevisionId, oldRevision);
  assert.equal(exact.revisionMode, "historical");
  assert.equal(exact.readOnly, true);
  assert.equal(exact.contentCapabilities.includes("commit"), false);

  const asOf = await env.history.resolveSnapshotView(ownerActor, {
    mind: mind.handle,
    revisionSelector: { kind: "as_of", asOf: HISTORY_AT },
  });
  assert.equal(asOf.resolvedRevisionId, headRevision);
  assert.equal(asOf.resolvedRevision.revisionNumber, 3);
  assert.equal(asOf.readOnly, true);
  assert.equal(asOf.contentCapabilities.includes("commit"), false);

  const oneNanosecondEarlier = await env.history.resolveSnapshotView(
    ownerActor,
    {
      mind: mind.handle,
      revisionSelector: {
        kind: "as_of",
        asOf: "2026-08-07T20:02:00.123456788Z",
      },
    },
  );
  assert.equal(oneNanosecondEarlier.resolvedRevisionId, initialRevision);

  await assert.rejects(
    env.history.resolveSnapshotView(ownerActor, {
      mind: mind.handle,
      revisionSelector: { kind: "as_of", asOf: "2026-08-07T20:00:59.999999999Z" },
    }),
    expectHistoryFailure("revision_not_found"),
  );

  const firstPage = await env.history.listRevisions(ownerActor, {
    mind: mind.handle,
    limit: 2,
  });
  assert.deepEqual(
    firstPage.revisions.map((entry) => entry.revision.revisionId),
    [headRevision, oldRevision],
  );
  assert.equal(firstPage.nextBefore, oldRevision);
  const secondPage = await env.history.listRevisions(ownerActor, {
    mind: mind.handle,
    before: firstPage.nextBefore,
    limit: 2,
  });
  assert.deepEqual(
    secondPage.revisions.map((entry) => entry.revision.revisionId),
    [initialRevision],
  );
  assert.equal(secondPage.nextBefore, null);

  const exactMetadata = await env.history.getRevision(ownerActor, {
    mind: mind.handle,
    revisionId: oldRevision,
  });
  assert.equal(exactMetadata.revision.revisionId, oldRevision);
  assert.equal(exactMetadata.manifestSummary.fileCount, 2);
  assert.equal(exactMetadata.readOnly, true);
  const serialized = JSON.stringify({ firstPage, exactMetadata });
  assert.equal(serialized.includes("PRIVATE_DELETED_FROM_HEAD_BODY"), false);
  assert.equal(serialized.includes("concepts/deleted.md"), false);
  assert.equal(serialized.includes("checkpoint"), false);
  assert.equal(serialized.includes("tags"), false);

  const historicalWrite = await new CapabilityAuthorizer(env.metadata).authorize({
    actor: ownerActor,
    spaceId: mind.mindId,
    capability: "content:write",
    revisionMode: "historical",
  });
  assert.deepEqual(historicalWrite, {
    kind: "denied",
    code: "historical_read_only",
    retryable: false,
  });
  assert.equal(await env.metadata.readHead(mind.mindId), headRevision);
});

test("as_of treats equivalent UTC fractions as the same instant", async () => {
  const env = harness();
  const owner = await createAccount(env, 20, "Equivalent Fraction Owner");
  const mind = await createMind(env, owner, "equivalent-fraction-history");
  const initialRevision = mind.headRevisionId;
  const committedRevision = await commitFiles(
    env,
    owner,
    mind,
    [{ path: "index.md", text: indexFile() }],
    "Commit with a short UTC fraction",
    "2026-08-07T20:02:00.1Z",
  );
  const ownerActor = actor(owner.principalId);

  const equivalent = await env.history.resolveSnapshotView(ownerActor, {
    mind: mind.handle,
    revisionSelector: { kind: "as_of", asOf: "2026-08-07T20:02:00.100Z" },
  });
  assert.equal(equivalent.resolvedRevisionId, committedRevision);

  const oneNanosecondEarlier = await env.history.resolveSnapshotView(ownerActor, {
    mind: mind.handle,
    revisionSelector: { kind: "as_of", asOf: "2026-08-07T20:02:00.099999999Z" },
  });
  assert.equal(oneNanosecondEarlier.resolvedRevisionId, initialRevision);
});

test("a file deleted from HEAD remains fetchable from its authorized exact revision", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Fetch Owner");
  const mind = await createMind(env, owner, "deleted-file-history");
  const { oldRevision, headRevision } = await seedDeletedFileHistory(env, owner, mind);
  const ownerActor = actor(owner.principalId);

  const current = await env.browse.browseEntries(ownerActor, {
    mind: mind.handle,
    revisionSelector: { kind: "head" },
    path: "concepts",
  });
  assert.equal(current.resolvedRevision.revisionId, headRevision);
  assert.deepEqual(current.entries, []);

  const historical = await env.browse.browseEntries(ownerActor, {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: oldRevision },
    path: "concepts",
  });
  assert.equal(historical.resolvedRevision.revisionId, oldRevision);
  assert.deepEqual(historical.entries.map((entry) => entry.path), [
    "concepts/deleted.md",
  ]);
  const fetched = await env.browse.fetch(ownerActor, {
    id: historical.entries[0].entryId,
  });
  assert.match(fetched.text, /PRIVATE_DELETED_FROM_HEAD_BODY/);
  assert.equal(fetched.entry.revisionId, oldRevision);
  assert.equal(await env.metadata.readHead(mind.mindId), headRevision);
});

test("historical reads use current visibility and fail after the current grant is revoked", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Visibility Owner");
  const viewer = await createAccount(env, 2, "Visibility Viewer");
  const mind = await createMind(env, owner, "current-history-access");
  const { oldRevision, headRevision } = await seedDeletedFileHistory(env, owner, mind);

  await changeVisibility(env, owner, mind, "public", "public");
  const viewerActor = actor(viewer.principalId, "request_viewer_history");
  const granted = await env.history.getRevision(viewerActor, {
    mind: mind.handle,
    revisionId: oldRevision,
  });
  assert.equal(granted.revision.revisionId, oldRevision);
  assert.equal(granted.mind.access.kind, "visibility");

  await changeVisibility(env, owner, mind, "private", "private");
  for (const operation of [
    () =>
      env.history.resolveSnapshotView(viewerActor, {
        mind: mind.handle,
        revisionSelector: { kind: "revision", revisionId: oldRevision },
      }),
    () => env.history.listRevisions(viewerActor, { mind: mind.handle }),
    () =>
      env.history.getRevision(viewerActor, {
        mind: mind.handle,
        revisionId: oldRevision,
      }),
  ]) {
    await assert.rejects(operation(), expectHistoryFailure("mind_not_found"));
  }
  assert.equal(await env.metadata.readHead(mind.mindId), headRevision);
  assert.equal((await env.metadata.listRevisions(mind.mindId)).length, 3);
});

test("invalid selectors and a visibility race fail closed without mutating immutable history", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Race Owner");
  const viewer = await createAccount(env, 2, "Race Viewer");
  const mind = await createMind(env, owner, "history-race");
  const { oldRevision, headRevision } = await seedDeletedFileHistory(env, owner, mind);
  const ownerActor = actor(owner.principalId);
  const originalCount = (await env.metadata.listRevisions(mind.mindId)).length;

  for (const [operation, code] of [
    [
      () =>
        env.history.resolveSnapshotView(ownerActor, {
          mind: mind.handle,
          revisionSelector: { kind: "as_of", asOf: "not-a-utc-instant" },
        }),
      "invalid_revision_selector",
    ],
    [
      () => env.history.listRevisions(ownerActor, { mind: mind.handle, limit: 101 }),
      "invalid_limit",
    ],
    [
      () =>
        env.history.listRevisions(ownerActor, {
          mind: mind.handle,
          before: "revision_missing",
        }),
      "revision_not_found",
    ],
    [
      () =>
        env.history.getRevision(ownerActor, {
          mind: mind.handle,
          revisionId: "revision_missing",
        }),
      "revision_not_found",
    ],
    [
      () =>
        env.history.getRevision(ownerActor, {
          mind: mind.handle,
          revisionId: oldRevision,
          unexpected: true,
        }),
      "invalid_request",
    ],
  ]) {
    await assert.rejects(operation(), expectHistoryFailure(code));
    assert.equal(await env.metadata.readHead(mind.mindId), headRevision);
    assert.equal((await env.metadata.listRevisions(mind.mindId)).length, originalCount);
  }

  await changeVisibility(env, owner, mind, "public", "race-public");
  let revokedDuringRead = false;
  const store = new Proxy(env.store, {
    get(target, property) {
      if (property === "listRevisionCatalog") {
        return async (spaceId, query) => {
          const result = await target.listRevisionCatalog(spaceId, query);
          if (!revokedDuringRead && spaceId === mind.mindId) {
            revokedDuringRead = true;
            await changeVisibility(env, owner, mind, "private", "race-private");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const racedHistory = new MindHistoryService({ store, host: HOST });
  await assert.rejects(
    racedHistory.listRevisions(actor(viewer.principalId), { mind: mind.handle }),
    expectHistoryFailure("mind_not_found"),
  );
  assert.equal(revokedDuringRead, true);
  assert.equal(await env.metadata.readHead(mind.mindId), headRevision);
  assert.equal((await env.metadata.listRevisions(mind.mindId)).length, originalCount);
});
