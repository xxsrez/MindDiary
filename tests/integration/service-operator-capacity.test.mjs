import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  ServiceOperatorCapacityDiagnosticsService,
  ServiceOperatorDirectoryFailure,
} from "@mind-diary/application-control";
import { DEFAULT_CAPACITY_LIMITS } from "@mind-diary/application-content";
import {
  RESTRICTED_UAT_CAPACITY_PROFILE,
  RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE,
} from "@mind-diary/composition-root";
import { CAPABILITIES } from "@mind-diary/domain";

const NOW = "2026-08-24T12:00:00.000Z";
const OPERATOR = "principal_capacity_operator";

function actor(principalId = OPERATOR) {
  return Object.freeze({
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_capacity_diagnostics",
    occurredAtUtc: NOW,
  });
}

function service(
  profile = RESTRICTED_UAT_CAPACITY_PROFILE,
  store = new InMemoryRevisionMetadataStore(),
) {
  let audit = 0;
  return new ServiceOperatorCapacityDiagnosticsService({
    store,
    clock: { now: () => NOW },
    ids: {
      nextAuditEventId: () => `audit_capacity_${++audit}`,
      nextOutboxMessageId: () => `outbox_capacity_${audit}`,
    },
    operatorPrincipalIds: new Set([OPERATOR]),
    profile,
    releaseConfigurationFenceSha256: `sha256:${"a".repeat(64)}`,
  });
}

async function registeredService(profile = RESTRICTED_UAT_CAPACITY_PROFILE) {
  const metadata = new InMemoryRevisionMetadataStore();
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects: new InMemoryObjectStore(),
    ids: {
      nextPrincipalId: () => OPERATOR,
      nextExternalBindingId: () => "binding_capacity_operator",
      nextSpaceId: () => "space_capacity_operator",
      nextMembershipId: () => "membership_capacity_operator",
      nextRevisionId: () => "revision_capacity_operator",
      nextIndexJobId: () => "job_capacity_operator",
      nextPersonalSpaceHandle: () => "personal-capacity-operator",
    },
  });
  await bootstrap.bootstrapAccount({
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: "capacity.operator@example.com",
    suggestedDisplayName: "Capacity Operator",
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_capacity_bootstrap",
    occurredAtUtc: NOW,
  }, { action: "create_isolated_account" });
  return { metadata, diagnostics: service(profile, metadata) };
}

test("operator capacity readback is exact, closed-schema and privacy-safe", async () => {
  const { metadata, diagnostics } = await registeredService();
  const result = await diagnostics.read(actor(), {});
  assert.deepEqual(Object.keys(result).sort(), [
    "headroom",
    "observedAt",
    "profile",
    "quotaRejects",
    "releaseFence",
    "reservations",
    "schema",
    "storageAmplification",
    "usage",
    "utilization",
    "version",
  ]);
  assert.equal(result.schema, "mind-diary/operator-capacity-diagnostics");
  assert.equal(result.version, 1);
  assert.equal(result.observedAt, NOW);
  assert.deepEqual(result.releaseFence, {
    schema: "mind-diary/uat-release-configuration-fence",
    version: 1,
    sha256: `sha256:${"a".repeat(64)}`,
  });
  assert.deepEqual(result.profile, RESTRICTED_UAT_CAPACITY_PROFILE);
  assert.deepEqual(Object.keys(result.usage).sort(), [
    "d1MetadataBytes",
    "logicalHeadBytes",
    "logicalRetainedBytes",
    "physicalCanonicalBytes",
    "reconciledAt",
    "reservedBytes",
    "temporaryBytes",
    "trustworthy",
  ]);
  assert.deepEqual(Object.keys(result.headroom).sort(), [
    "canonicalBytes",
    "d1MetadataBytes",
    "temporaryBytes",
  ]);
  assert.equal(result.profile.limits.mindPhysicalCanonicalBytes, 8_388_608);
  const { mindPhysicalCanonicalBytes: _profileMind, ...profileRemainder } =
    result.profile.limits;
  const { mindPhysicalCanonicalBytes: _defaultMind, ...defaultRemainder } =
    DEFAULT_CAPACITY_LIMITS;
  assert.deepEqual(profileRemainder, defaultRemainder);
  assert.equal(result.quotaRejects, 0);
  assert.deepEqual(result.reservations, {
    activeCount: 0,
    activeBytes: 0,
    expiredActiveCount: 0,
    expiredActiveBytes: 0,
    cleanupPendingCount: 0,
    cleanupPendingBytes: 0,
    staleCount: 0,
    staleBytes: 0,
  });
  assert.equal(result.utilization, "normal");
  assert.equal(
    /"(?:path|content|email|principalId|providerId|secret|token|objectKey|signedUrl)"\s*:/iu.test(
      JSON.stringify(result),
    ),
    false,
  );
  const audit = await metadata.listAuditEventsForTest();
  assert.equal(audit.length, 1);
  assert.equal(audit.at(-1).eventType, "service_operator.capacity_diagnostics_read");
  assert.deepEqual(audit.at(-1).safeMetadata, {
    operation: "read_capacity_diagnostics",
  });
  assert.equal((await metadata.listAuditOutboxForTest()).length, 1);
  const restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    metadata.exportDurableSnapshot(),
  );
  assert.equal(
    (await restored.listAuditEventsForTest()).at(-1).eventType,
    "service_operator.capacity_diagnostics_read",
  );
});

test("operator capacity readback is hidden from non-operators and rejects every query field", async () => {
  const { metadata, diagnostics } = await registeredService();
  await assert.rejects(
    diagnostics.read(actor("principal_capacity_outsider"), {}),
    (error) => error instanceof ServiceOperatorDirectoryFailure && error.code === "not_found",
  );
  await assert.rejects(
    diagnostics.read(actor(), { profile: "default" }),
    (error) => error instanceof ServiceOperatorDirectoryFailure && error.code === "invalid_request",
  );
  assert.equal((await metadata.listAuditEventsForTest()).length, 0);
});

test("restricted-UAT default profile is an exact terminal readback", async () => {
  const { diagnostics } = await registeredService(RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE);
  const result = await diagnostics.read(actor(), {});
  assert.equal(result.profile.profileId, "default-v1");
  assert.deepEqual(result.profile.limits, DEFAULT_CAPACITY_LIMITS);
});

test("operator capacity service rejects partial, extended and unallowlisted profiles", () => {
  const { activeHeavyPerSite: _missing, ...partialLimits } =
    RESTRICTED_UAT_CAPACITY_PROFILE.limits;
  for (const limits of [
    partialLimits,
    { ...RESTRICTED_UAT_CAPACITY_PROFILE.limits, arbitraryLimit: 1 },
  ]) {
    assert.throws(
      () => service({ ...RESTRICTED_UAT_CAPACITY_PROFILE, limits }),
      /capacity profile is invalid/u,
    );
  }
  assert.throws(
    () => service({ ...RESTRICTED_UAT_CAPACITY_PROFILE, unexpected: true }),
    /capacity profile is invalid/u,
  );
  assert.throws(
    () => new ServiceOperatorCapacityDiagnosticsService({
      store: new InMemoryRevisionMetadataStore(),
      clock: { now: () => NOW },
      ids: {
        nextAuditEventId: () => "audit_capacity_empty",
        nextOutboxMessageId: () => "outbox_capacity_empty",
      },
      operatorPrincipalIds: new Set(),
      profile: RESTRICTED_UAT_CAPACITY_PROFILE,
      releaseConfigurationFenceSha256: `sha256:${"a".repeat(64)}`,
    }),
    /require an allowlist/u,
  );
});
