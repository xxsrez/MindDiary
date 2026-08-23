import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  MindBrowseFailure,
  MindBrowseService,
  MindDiscoveryService,
  WebCryptoMindLocatorCodec,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  MindRouteService,
  OrdinaryMindControlService,
} from "@mind-diary/application-control";
import { createProductWebHttpHandler } from "@mind-diary/adapter-web";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  verifiedSpaceHost,
} from "@mind-diary/domain";

export const LOCAL_MIND_SCALE_SCHEMA = "mind-diary/local-mind-scale-evidence/v1";
export const LOCAL_MIND_SCALE_COUNTS = Object.freeze([1, 10, 100]);
export const LOCAL_MIND_SCALE_LATENCY_BUDGET_MS = 2_000;
export const LOCAL_MIND_SCALE_CONCURRENCY = 8;

const CREATED_AT = "2026-08-23T18:00:00.000Z";
const CHANGED_AT = "2026-08-23T18:01:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const ENCODER = new TextEncoder();

const METADATA_READ_METHODS = Object.freeze([
  "readPersonalMindProfile",
  "listActiveMembershipMindIds",
  "listPublicMindCatalogPage",
  "readResolvedSpace",
  "readResolvedSpaces",
  "readRevision",
  "readHead",
  "readCurrentAuthorizationState",
  "readCurrentAuthorizationStates",
]);

const OBJECT_READ_METHODS = Object.freeze([
  "getImmutable",
  "getSpaceCanonicalObject",
  "calculateSha256",
]);

function registeredActor(principalId, requestId) {
  return Object.freeze({
    kind: "registered_principal",
    principalId,
    authentication: Object.freeze({ kind: "sites_identity" }),
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: CHANGED_AT,
  });
}

function preRegistrationActor(index) {
  return Object.freeze({
    kind: "sites_identity_before_registration",
    authentication: Object.freeze({
      kind: "sites_identity",
      verifiedByPlatform: true,
    }),
    provider: "openai-sites",
    normalizedBinding: `private.scale.${index}@example.com`,
    suggestedDisplayName: `Scale Owner ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `scale-bootstrap-${index}`,
    occurredAtUtc: CREATED_AT,
  });
}

function accountIds() {
  let sequence = 0;
  return Object.freeze({
    nextPrincipalId: () => `principal_scale_${++sequence}`,
    nextExternalBindingId: () => `binding_scale_${sequence}`,
    nextSpaceId: () => `space_personal_scale_${sequence}`,
    nextMembershipId: () => `membership_personal_scale_${sequence}`,
    nextRevisionId: () => `revision_personal_scale_${sequence}`,
    nextPersonalSpaceHandle: () => `personal-scale-${sequence}`,
  });
}

function ordinaryIds() {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  return Object.freeze({
    nextSpaceId: () => `space_scale_${++spaces}`,
    nextMembershipId: () => `membership_scale_${++memberships}`,
    nextRevisionId: () => `revision_scale_${++revisions}`,
  });
}

function countsFor(methods) {
  return Object.fromEntries(methods.map((method) => [method, 0]));
}

function instrumentStore(delegate, methods) {
  const counts = countsFor(methods);
  const methodSet = new Set(methods);
  let active = 0;
  let maximumConcurrent = 0;
  const store = new Proxy(delegate, {
    get(target, property) {
      const selected = Reflect.get(target, property, target);
      if (typeof selected !== "function") return selected;
      if (typeof property !== "string" || !methodSet.has(property)) {
        return selected.bind(target);
      }
      return (...args) => {
        counts[property] += 1;
        active += 1;
        maximumConcurrent = Math.max(maximumConcurrent, active);
        let pending;
        try {
          pending = selected.apply(target, args);
        } catch (error) {
          active -= 1;
          throw error;
        }
        return Promise.resolve(pending).finally(() => {
          active -= 1;
        });
      };
    },
  });
  return Object.freeze({
    store,
    snapshot: () => Object.freeze({
      calls: Object.freeze({ ...counts }),
      maximumConcurrent,
    }),
    reset: () => {
      for (const method of methods) counts[method] = 0;
      active = 0;
      maximumConcurrent = 0;
    },
  });
}

function conceptText(index) {
  const padded = String(index).padStart(3, "0");
  return `---\ntype: Reference\ntitle: Scale Concept ${padded}\ndescription: Deterministic local scale fixture ${padded}\ntags:\n  - scale\n  - local\n---\n\n# Scale Concept ${padded}\n\nSynthetic authenticated browse fixture ${padded}.\n`;
}

async function createEnvironment(count) {
  const metadata = new InMemoryRevisionMetadataStore();
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
  const owner = await bootstrap.bootstrapAccount(
    preRegistrationActor(`owner-${count}`),
    { action: "create_isolated_account" },
  );
  const ownerActor = registeredActor(owner.principalId, `scale-list-${count}`);
  const minds = [];
  for (let index = 0; index < count; index += 1) {
    const handle = `scale-${String(index).padStart(3, "0")}`;
    const created = await ordinary.createSpaceWithOwner(ownerActor, {
      name: `Scale Mind ${String(index).padStart(3, "0")}`,
      handle,
      idempotencyKey: `scale-create-${count}-${index}`,
    });
    minds.push(Object.freeze({ mindId: created.mindId, handle }));
  }
  return Object.freeze({ metadata, objects, bootstrap, owner, ownerActor, minds });
}

function expectedListRoutes(count) {
  return Object.freeze([
    "/me",
    ...Array.from(
      { length: Math.max(0, Math.min(count, 99)) },
      (_, index) => `/scale-${String(index).padStart(3, "0")}`,
    ),
  ]);
}

async function runListScale(count) {
  const environment = await createEnvironment(count);
  const metadata = instrumentStore(environment.metadata, METADATA_READ_METHODS);
  const discovery = new MindDiscoveryService({
    store: metadata.store,
    host: HOST,
  });
  const startedAt = performance.now();
  const first = await discovery.listMinds(environment.ownerActor, { limit: 100 });
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  const routes = Object.freeze(first.minds.map((mind) => mind.route));
  const evidence = metadata.snapshot();
  const second = await discovery.listMinds(environment.ownerActor, { limit: 100 });
  assert.deepEqual(second.minds.map((mind) => mind.route), routes);
  assert.deepEqual(routes, expectedListRoutes(count));
  assert.equal(first.minds.length, Math.min(count + 1, 100));
  assert.equal(first.nextCursor !== null, count >= 100);
  assert.ok(
    elapsedMs <= LOCAL_MIND_SCALE_LATENCY_BUDGET_MS,
    `local list_minds ${count} exceeded ${LOCAL_MIND_SCALE_LATENCY_BUDGET_MS}ms`,
  );

  // Batch authorization and route projections keep the storage calls bounded
  // by the page. The page still reports the number of logical candidate Minds
  // so a later hosted profile can compare the same matrix.
  assert.deepEqual(evidence.calls, {
    readPersonalMindProfile: 1,
    listActiveMembershipMindIds: 1,
    listPublicMindCatalogPage: 1,
    readResolvedSpace: 0,
    readResolvedSpaces: 1,
    readRevision: 1,
    readHead: 0,
    readCurrentAuthorizationState: 2,
    readCurrentAuthorizationStates: 2,
  });
  assert.ok(evidence.maximumConcurrent <= LOCAL_MIND_SCALE_CONCURRENCY);
  return Object.freeze({
    mind_count: count,
    returned_minds: first.minds.length,
    next_cursor: first.nextCursor !== null,
    latency_ms: Number(elapsedMs.toFixed(3)),
    metadata: evidence,
  });
}

async function runWebProjectionScale(count) {
  const environment = await createEnvironment(count);
  const metadata = instrumentStore(environment.metadata, METADATA_READ_METHODS);
  const routes = new MindRouteService({
    routes: metadata.store,
    host: HOST,
  });
  const handler = createProductWebHttpHandler({
    applicationOrigin: "https://mind-diary.example",
    resolveIdentity: () => ({
      kind: "authenticated",
      actor: environment.ownerActor,
    }),
    csrf: {
      issue: () => "local-scale-csrf",
      verify: () => true,
    },
    control: {
      execute: async (request) => {
        if (request.operation !== "list_minds") {
          throw new Error("unexpected local scale web operation");
        }
        return routes.listMinds(request.actor);
      },
    },
  });

  const startedAt = performance.now();
  const home = await handler(new Request("https://mind-diary.example/"));
  const homeElapsedMs = Math.max(0, performance.now() - startedAt);
  assert.equal(home?.status, 200);
  assert.match(await home.text(), /Mind Diary/u);
  const homeEvidence = metadata.snapshot();
  metadata.reset();

  const mindsStartedAt = performance.now();
  const minds = await handler(new Request("https://mind-diary.example/minds"));
  const mindsElapsedMs = Math.max(0, performance.now() - mindsStartedAt);
  assert.equal(minds?.status, 200);
  assert.match(await minds.text(), /Minds/u);
  const mindsEvidence = metadata.snapshot();
  for (const evidence of [homeEvidence, mindsEvidence]) {
    assert.deepEqual(evidence.calls, {
      readPersonalMindProfile: 1,
      listActiveMembershipMindIds: 1,
      listPublicMindCatalogPage: 0,
      readResolvedSpace: 0,
      readResolvedSpaces: 1,
      readRevision: 0,
      readHead: 0,
      readCurrentAuthorizationState: 0,
      readCurrentAuthorizationStates: 2,
    });
    assert.ok(evidence.maximumConcurrent <= LOCAL_MIND_SCALE_CONCURRENCY);
  }
  assert.ok(homeElapsedMs <= LOCAL_MIND_SCALE_LATENCY_BUDGET_MS);
  assert.ok(mindsElapsedMs <= LOCAL_MIND_SCALE_LATENCY_BUDGET_MS);
  return Object.freeze({
    mind_count: count,
    home: Object.freeze({
      status: home.status,
      latency_ms: Number(homeElapsedMs.toFixed(3)),
      metadata: homeEvidence,
    }),
    minds: Object.freeze({
      status: minds.status,
      latency_ms: Number(mindsElapsedMs.toFixed(3)),
      metadata: mindsEvidence,
    }),
  });
}

async function createBrowseEnvironment() {
  const environment = await createEnvironment(1);
  const outsider = await environment.bootstrap.bootstrapAccount(
    preRegistrationActor("outsider"),
    {
      action: "create_isolated_account",
    },
  );
  const mind = environment.minds[0];
  const revisions = new CanonicalRevisionCoordinator({
    objects: environment.objects,
    revisions: environment.metadata,
  });
  const expectedRevisionId = await environment.metadata.readHead(mind.mindId);
  assert.ok(expectedRevisionId);
  const files = [
    { path: "index.md", text: "# Local scale browse fixture\n" },
    { path: "log.md", text: "# Local scale log\n" },
    ...Array.from({ length: 100 }, (_, index) => ({
      path: `concepts/${String(index).padStart(3, "0")}.md`,
      text: conceptText(index),
    })),
  ];
  const committed = await revisions.commit({
    spaceId: mind.mindId,
    expectedRevisionId,
    revisionId: "revision_scale_browse_100",
    committedAt: CHANGED_AT,
    committedBy: { kind: "principal", principalId: environment.owner.principalId },
    summary: "Seed deterministic local browse scale fixture",
    files: files.map((file) => ({
      path: file.path,
      mediaType: MARKDOWN_MEDIA_TYPE,
      bytes: ENCODER.encode(file.text),
    })),
  });
  assert.equal(committed.kind, "committed");
  return Object.freeze({ ...environment, outsider, mind });
}

async function runBrowseScale() {
  const environment = await createBrowseEnvironment();
  const metadata = instrumentStore(environment.metadata, METADATA_READ_METHODS);
  const objects = instrumentStore(environment.objects, OBJECT_READ_METHODS);
  const browse = new MindBrowseService({
    store: metadata.store,
    objects: objects.store,
    host: HOST,
    locators: new WebCryptoMindLocatorCodec(new Uint8Array(32).fill(0x61)),
  });
  const startedAt = performance.now();
  const result = await browse.browseEntries(environment.ownerActor, {
    mind: environment.mind.handle,
    path: "concepts",
    limit: 100,
  });
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  const paths = Object.freeze(result.entries.map((entry) => entry.path));
  assert.deepEqual(
    paths,
    Array.from({ length: 100 }, (_, index) =>
      `concepts/${String(index).padStart(3, "0")}.md`,
    ),
  );
  assert.equal(result.nextCursor, null);
  assert.ok(
    elapsedMs <= LOCAL_MIND_SCALE_LATENCY_BUDGET_MS,
    `local browse_entries exceeded ${LOCAL_MIND_SCALE_LATENCY_BUDGET_MS}ms`,
  );
  const objectEvidence = objects.snapshot();
  assert.equal(objectEvidence.calls.getImmutable, 100);
  assert.equal(objectEvidence.calls.calculateSha256, 101);
  assert.ok(objectEvidence.maximumConcurrent <= LOCAL_MIND_SCALE_CONCURRENCY);

  objects.reset();
  await assert.rejects(
    browse.browseEntries(
      registeredActor(environment.outsider.principalId, "scale-denied"),
      { mind: environment.mind.handle, path: "concepts", limit: 100 },
    ),
    (error) => error instanceof MindBrowseFailure && error.code === "mind_not_found",
  );
  assert.deepEqual(objects.snapshot().calls, {
    getImmutable: 0,
    getSpaceCanonicalObject: 0,
    calculateSha256: 0,
  });
  return Object.freeze({
    mind_count: 1,
    entry_count: result.entries.length,
    latency_ms: Number(elapsedMs.toFixed(3)),
    metadata: metadata.snapshot(),
    objects: objectEvidence,
    denied_object_reads: objects.snapshot().calls.getImmutable,
  });
}

export async function runLocalMindScaleBenchmark() {
  const list = [];
  const web = [];
  for (const count of LOCAL_MIND_SCALE_COUNTS) {
    list.push(await runListScale(count));
    web.push(await runWebProjectionScale(count));
  }
  return Object.freeze({
    schema: LOCAL_MIND_SCALE_SCHEMA,
    environment: "local-synthetic-in-memory",
    hosted_evidence: false,
    list_minds: Object.freeze(list),
    web_projections: Object.freeze(web),
    browse_entries: await runBrowseScale(),
  });
}
