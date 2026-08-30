import assert from "node:assert/strict";
import test from "node:test";

import {
  createSitesLocalFileUploadIntentStore,
} from "@mind-diary/adapter-metadata-sites";
import { FakeD1Database } from "../../scripts/lib/fake-sites-storage.mjs";

const CREATED = "2026-08-25T12:00:00.000Z";
const EXPIRES = "2026-08-25T12:10:00.000Z";

function record(overrides = {}) {
  return Object.freeze({
    formatVersion: 1,
    intentId: "upload_intent_sites",
    namespaceHash: `sha256:${"1".repeat(64)}`,
    canonicalRequestHash: `sha256:${"2".repeat(64)}`,
    principalId: "principal_sites_upload",
    tokenId: "md_oauth_access_sites_upload",
    bindingOwnerId: "md_oauth_grant_sites_upload",
    spaceId: "space_sites_upload",
    principalMindUsageGenerationId: "usage_generation_sites_upload",
    sourceKind: "local_path",
    displayFilename: "fixture.epub",
    claimedMediaType: "application/epub+zip",
    expectedSize: 42,
    expectedSha256: `sha256:${"3".repeat(64)}`,
    idempotencyKey: "sites-upload-intent",
    state: "active",
    claimId: null,
    leaseExpiresAt: null,
    stagedFileId: null,
    stageReplayed: null,
    rejectionCode: null,
    createdAt: CREATED,
    expiresAt: EXPIRES,
    consumedAt: null,
    ...overrides,
  });
}

test("dedicated Sites store persists restart, exact replay, lease CAS and bounded deletion", async () => {
  const database = new FakeD1Database();
  const first = await createSitesLocalFileUploadIntentStore(database);
  const created = await first.createLocalFileUploadIntent(record());
  assert.equal(created.kind, "created");
  const restarted = await createSitesLocalFileUploadIntentStore(database);
  assert.deepEqual(await restarted.readLocalFileUploadIntent(record().intentId), record());
  assert.equal((await restarted.createLocalFileUploadIntent(record())).kind, "replayed");
  const rotated = await restarted.createLocalFileUploadIntent(record({
    intentId: "upload_intent_sites_rotated_attempt",
    tokenId: "md_oauth_access_sites_upload_rotated",
  }));
  assert.equal(rotated.kind, "replayed");
  assert.equal(rotated.record.intentId, record().intentId);
  assert.equal(rotated.record.tokenId, "md_oauth_access_sites_upload_rotated");
  const concurrent = await Promise.all([
    first.createLocalFileUploadIntent(record({
      intentId: "upload_intent_sites_concurrent_b",
      tokenId: "md_oauth_access_sites_upload_concurrent_b",
    })),
    restarted.createLocalFileUploadIntent(record({
      intentId: "upload_intent_sites_concurrent_c",
      tokenId: "md_oauth_access_sites_upload_concurrent_c",
    })),
  ]);
  assert.equal(concurrent.every((result) => result.kind === "replayed"), true);
  assert.equal(
    [
      "md_oauth_access_sites_upload_concurrent_b",
      "md_oauth_access_sites_upload_concurrent_c",
    ].includes((await restarted.readLocalFileUploadIntent(record().intentId)).tokenId),
    true,
  );
  assert.equal((await restarted.createLocalFileUploadIntent(record({
    canonicalRequestHash: `sha256:${"4".repeat(64)}`,
  }))).kind, "conflict");

  const claimed = await first.claimLocalFileUploadIntent({
    intentId: record().intentId,
    principalId: record().principalId,
    bindingOwnerId: record().bindingOwnerId,
    claimId: "claim_sites_one",
    occurredAt: CREATED,
    leaseExpiresAt: "2026-08-25T12:00:30.000Z",
  });
  assert.equal(claimed.kind, "claimed");
  assert.equal((await restarted.claimLocalFileUploadIntent({
    intentId: record().intentId,
    principalId: record().principalId,
    bindingOwnerId: record().bindingOwnerId,
    claimId: "claim_sites_two",
    occurredAt: "2026-08-25T12:00:01.000Z",
    leaseExpiresAt: "2026-08-25T12:00:31.000Z",
  })).kind, "busy");
  assert.equal(await restarted.completeLocalFileUploadIntent({
    intentId: record().intentId,
    claimId: "claim_sites_one",
    stagedFileId: "staged_sites_upload",
    replayed: false,
    completedAt: "2026-08-25T12:00:02.000Z",
  }), "completed");
  const durable = await first.readLocalFileUploadIntent(record().intentId);
  assert.equal(durable.state, "consumed");
  assert.equal(durable.stagedFileId, "staged_sites_upload");

  const capacityRecord = record({
    intentId: "upload_intent_sites_capacity",
    namespaceHash: `sha256:${"5".repeat(64)}`,
    canonicalRequestHash: `sha256:${"6".repeat(64)}`,
    idempotencyKey: "sites-upload-intent-capacity",
    expiresAt: "2026-08-25T12:20:00.000Z",
  });
  assert.equal(
    (await first.createLocalFileUploadIntent(capacityRecord)).kind,
    "created",
  );
  assert.equal((await first.claimLocalFileUploadIntent({
    intentId: capacityRecord.intentId,
    principalId: capacityRecord.principalId,
    bindingOwnerId: capacityRecord.bindingOwnerId,
    claimId: "claim_sites_capacity",
    occurredAt: CREATED,
    leaseExpiresAt: "2026-08-25T12:00:30.000Z",
  })).kind, "claimed");
  assert.equal(await first.rejectLocalFileUploadIntent({
    intentId: capacityRecord.intentId,
    claimId: "claim_sites_capacity",
    code: "capacity_soft_limit",
    rejectedAt: "2026-08-25T12:00:02.000Z",
  }), "rejected");
  assert.equal(
    (await (await createSitesLocalFileUploadIntentStore(database))
      .readLocalFileUploadIntent(capacityRecord.intentId)).rejectionCode,
    "capacity_soft_limit",
  );
  assert.doesNotMatch(
    JSON.stringify([...database.localFileUploadIntents.values()]),
    /mdupload_v1_|\/Users\/|private\/tmp|bearer|bytes/iu,
  );

  assert.equal((await first.collectExpiredLocalFileUploadIntents({
    expiredBefore: EXPIRES,
    limit: 100,
  })).length, 1);
  assert.equal(await first.deleteExpiredLocalFileUploadIntent({
    intentId: record().intentId,
    expectedExpiresAt: EXPIRES,
    expiredBefore: EXPIRES,
  }), true);
  assert.equal(await restarted.readLocalFileUploadIntent(record().intentId), null);
});
