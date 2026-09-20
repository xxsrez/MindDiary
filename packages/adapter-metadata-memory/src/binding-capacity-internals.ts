import {
  OBJECT_CLEANUP_NAMESPACES,
  bindingVersion,
  version,
  type ApplyAutomaticCapturePolicyRequest,
  type ApplyMindBindingMutationResult,
  type ApplyReadMindBindingRequest,
  type ApplyWriteMindBindingRequest,
  type AuditEvent,
  type AuditOutboxMessage,
  type CapacityAdmissionRequest,
  type CapacityAmounts,
  type CapacityReservation,
  type CapacityUsageSnapshot,
  type CapacityUtilizationState,
  type ExportJob,
  type JobId,
  type KnowledgeSpace,
  type MarkdownImportPlan,
  type MarkdownImportSession,
  type MarkdownImportStagedFile,
  type MindBindingOwnerId,
  type MindBindingSet,
  type MindBindingSetSnapshot,
  type ObjectCleanupCheckpoint,
  type ObjectCleanupNamespace,
  type PrincipalId,
  type ReadMindBinding,
  type ReadMindBindingId,
  type RevokeMindBindingOwnerRequest,
  type SpaceMembership,
  type StagedBundleFileId,
  type StagedBundleFileRecord,
  type UtcInstant,
  type WriteMindBinding,
  type WriteMindBindingId,
} from "@mind-diary/application-ports";

import {
  SHA256_PATTERN,
  compareUnicodeScalarValues,
  cloneAuditEvent,
  cloneAuditOutbox,
  BOUNDED_OPAQUE_ID,
  type SpaceId,
  type Digest,
  type AuditEventId,
  type OutboxMessageId,
  type SpaceState,
} from "./revision-internals.js";

export type AppliedMindBindingMutation = Readonly<
  Extract<ApplyMindBindingMutationResult, { readonly kind: "applied" }>
>;

export type MindBindingMutationRequest =
  | ApplyReadMindBindingRequest
  | ApplyWriteMindBindingRequest
  | ApplyAutomaticCapturePolicyRequest;

export interface StoredMindBindingMutation {
  readonly canonicalRequestHash: ApplyReadMindBindingRequest["canonicalRequestHash"];
  readonly spaceId: SpaceId | null;
  readonly result: AppliedMindBindingMutation;
}

export interface MutableMindBindingOwnerState {
  bindingSet: Readonly<MindBindingSet>;
  readBindingsById: Map<ReadMindBindingId, Readonly<ReadMindBinding>>;
  activeReadBindingBySpace: Map<SpaceId, ReadMindBindingId>;
  writeBindingsById: Map<WriteMindBindingId, Readonly<WriteMindBinding>>;
  activeWriteBindingId: WriteMindBindingId | null;
  idempotency: Map<string, StoredMindBindingMutation>;
}

export function cloneReadMindBinding(binding: Readonly<ReadMindBinding>): Readonly<ReadMindBinding> {
  return Object.freeze({ ...binding });
}

export function cloneWriteMindBinding(binding: Readonly<WriteMindBinding>): Readonly<WriteMindBinding> {
  return Object.freeze({ ...binding });
}

export function cloneMindBindingSnapshot(
  snapshot: Readonly<MindBindingSetSnapshot>,
): Readonly<MindBindingSetSnapshot> {
  return Object.freeze({
    bindingSet: Object.freeze({ ...snapshot.bindingSet }),
    readBindings: Object.freeze(snapshot.readBindings.map(cloneReadMindBinding)),
    writeBinding:
      snapshot.writeBinding === null
        ? null
        : cloneWriteMindBinding(snapshot.writeBinding),
  });
}

export function cloneAppliedMindBindingMutation(
  result: AppliedMindBindingMutation,
): AppliedMindBindingMutation {
  return Object.freeze({
    ...result,
    bindings: cloneMindBindingSnapshot(result.bindings),
    previousWriteBinding:
      result.previousWriteBinding === null
        ? null
        : cloneWriteMindBinding(result.previousWriteBinding),
  });
}

export function cloneMindBindingOwnerState(
  state: MutableMindBindingOwnerState,
): MutableMindBindingOwnerState {
  return {
    bindingSet: Object.freeze({ ...state.bindingSet }),
    readBindingsById: new Map(
      [...state.readBindingsById].map(([id, binding]) => [
        id,
        cloneReadMindBinding(binding),
      ]),
    ),
    activeReadBindingBySpace: new Map(state.activeReadBindingBySpace),
    writeBindingsById: new Map(
      [...state.writeBindingsById].map(([id, binding]) => [
        id,
        cloneWriteMindBinding(binding),
      ]),
    ),
    activeWriteBindingId: state.activeWriteBindingId,
    idempotency: new Map(
      [...state.idempotency].map(([key, record]) => [
        key,
        {
          canonicalRequestHash: record.canonicalRequestHash,
          spaceId: record.spaceId,
          result: cloneAppliedMindBindingMutation(record.result),
        },
      ]),
    ),
  };
}

export function cloneMindBindingOwners(
  owners: ReadonlyMap<MindBindingOwnerId, MutableMindBindingOwnerState>,
): Map<MindBindingOwnerId, MutableMindBindingOwnerState> {
  return new Map(
    [...owners].map(([ownerId, state]) => [
      ownerId,
      cloneMindBindingOwnerState(state),
    ]),
  );
}

export function emptyMindBindingOwnerState(
  bindingOwnerId: MindBindingOwnerId,
  principalId: PrincipalId,
  occurredAt: ApplyReadMindBindingRequest["occurredAt"],
): MutableMindBindingOwnerState {
  return {
    bindingSet: Object.freeze({
      bindingOwnerId,
      principalId,
      state: "active" as const,
      bindingVersion: bindingVersion(0),
      automaticCaptureMode: "disabled" as const,
      captureWriteBindingId: null,
      captureUpdatedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }),
    readBindingsById: new Map(),
    activeReadBindingBySpace: new Map(),
    writeBindingsById: new Map(),
    activeWriteBindingId: null,
    idempotency: new Map(),
  };
}

export function mindBindingSnapshot(
  state: MutableMindBindingOwnerState,
): Readonly<MindBindingSetSnapshot> {
  const readBindings = [...state.activeReadBindingBySpace]
    .sort(([left], [right]) => compareUnicodeScalarValues(left, right))
    .map(([, id]) => state.readBindingsById.get(id))
    .filter((binding): binding is Readonly<ReadMindBinding> =>
      binding !== undefined && binding.state === "active",
    )
    .map(cloneReadMindBinding);
  const write =
    state.activeWriteBindingId === null
      ? null
      : state.writeBindingsById.get(state.activeWriteBindingId) ?? null;
  return Object.freeze({
    bindingSet: Object.freeze({ ...state.bindingSet }),
    readBindings: Object.freeze(readBindings),
    writeBinding:
      write?.state === "active" ? cloneWriteMindBinding(write) : null,
  });
}

export function validMindBindingMutationBase(
  request: Readonly<MindBindingMutationRequest>,
): boolean {
  return (
    BOUNDED_OPAQUE_ID.test(request.bindingOwnerId) &&
    BOUNDED_OPAQUE_ID.test(request.principalId) &&
    Number.isSafeInteger(request.expectedBindingVersion) &&
    request.expectedBindingVersion >= 0 &&
    typeof request.idempotencyKey === "string" &&
    request.idempotencyKey.length > 0 &&
    request.idempotencyKey.length <= 512 &&
    SHA256_PATTERN.test(request.canonicalRequestHash) &&
    BOUNDED_OPAQUE_ID.test(request.requestId) &&
    BOUNDED_OPAQUE_ID.test(request.auditEventId) &&
    BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) &&
    Number.isFinite(Date.parse(request.occurredAt))
  );
}

export function mindBindingIdempotencyKey(
  operation: "read" | "write" | "capture",
  request: Readonly<MindBindingMutationRequest>,
): string {
  return `${operation}\u0000${request.idempotencyKey}`;
}

export function replayMindBindingMutation(
  state: MutableMindBindingOwnerState,
  operation: "read" | "write" | "capture",
  request: Readonly<MindBindingMutationRequest>,
): ApplyMindBindingMutationResult | null {
  const record = state.idempotency.get(
    mindBindingIdempotencyKey(operation, request),
  );
  if (!record) return null;
  if (record.canonicalRequestHash !== request.canonicalRequestHash) {
    return Object.freeze({ kind: "idempotency_conflict" });
  }
  return Object.freeze({
    ...cloneAppliedMindBindingMutation(record.result),
    replayed: true,
  });
}

export function recordMindBindingMutation(
  state: MutableMindBindingOwnerState,
  operation: "read" | "write" | "capture",
  request: Readonly<MindBindingMutationRequest>,
  result: AppliedMindBindingMutation,
): void {
  state.idempotency.set(mindBindingIdempotencyKey(operation, request), {
    canonicalRequestHash: request.canonicalRequestHash,
    spaceId: request.spaceId,
    result: cloneAppliedMindBindingMutation(result),
  });
}

export function mindBindingEffectsAvailable(
  auditEventId: AuditEventId,
  auditOutboxMessageId: OutboxMessageId,
  auditEvents: ReadonlyMap<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: ReadonlyMap<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): boolean {
  return (
    !auditEvents.has(auditEventId) &&
    !auditOutbox.has(auditOutboxMessageId) &&
    ![...auditOutbox.values()].some(
      (message) => message.auditEventId === auditEventId,
    )
  );
}

export function stageMindBindingAudit(
  request: Readonly<MindBindingMutationRequest>,
  result: AppliedMindBindingMutation,
  spaceId: SpaceId | null,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): void {
  const operation =
    request.action === "attach"
      ? "attach_read"
      : request.action === "detach"
        ? "detach_read"
        : request.action === "bind"
          ? "bind_write"
          : request.action === "unbind"
            ? "unbind_write"
            : request.action === "enable"
              ? "enable_capture"
              : "disable_capture";
  const event = Object.freeze({
    auditEventId: request.auditEventId,
    actor: Object.freeze({
      kind: "principal" as const,
      principalId: request.principalId,
    }),
    requestId: request.requestId,
    eventType: `mind_binding.${operation}`,
    outcome: "succeeded" as const,
    spaceId,
    occurredAt: request.occurredAt,
    safeMetadata: Object.freeze({
      binding_version: result.bindings.bindingSet.bindingVersion,
      changed: result.changed,
      operation,
    }),
  });
  const outbox = Object.freeze({
    outboxMessageId: request.auditOutboxMessageId,
    auditEventId: request.auditEventId,
    state: "pending" as const,
    version: version(1),
    attempts: 0,
    availableAt: request.occurredAt,
    claimExpiresAt: null,
    createdAt: request.occurredAt,
    updatedAt: request.occurredAt,
  });
  auditEvents.set(event.auditEventId, cloneAuditEvent(event));
  auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
}

export function stageMindBindingRevokeAudit(
  request: Readonly<RevokeMindBindingOwnerRequest>,
  invalidatedReadBindings: number,
  invalidatedWriteBindings: number,
  bindingVersionValue: number,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): void {
  const event = Object.freeze({
    auditEventId: request.auditEventId,
    actor: Object.freeze({
      kind: "principal" as const,
      principalId: request.principalId,
    }),
    requestId: request.requestId,
    eventType: "mind_binding.owner_revoked",
    outcome: "succeeded" as const,
    spaceId: null,
    occurredAt: request.occurredAt,
    safeMetadata: Object.freeze({
      binding_version: bindingVersionValue,
      read_bindings_invalidated: invalidatedReadBindings,
      write_bindings_invalidated: invalidatedWriteBindings,
    }),
  });
  const outbox = Object.freeze({
    outboxMessageId: request.auditOutboxMessageId,
    auditEventId: request.auditEventId,
    state: "pending" as const,
    version: version(1),
    attempts: 0,
    availableAt: request.occurredAt,
    claimExpiresAt: null,
    createdAt: request.occurredAt,
    updatedAt: request.occurredAt,
  });
  auditEvents.set(event.auditEventId, cloneAuditEvent(event));
  auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
}

export function purgeMindBindingsForSpace(
  owners: Map<MindBindingOwnerId, MutableMindBindingOwnerState>,
  spaceId: SpaceId,
  occurredAt: ApplyReadMindBindingRequest["occurredAt"],
): void {
  for (const state of owners.values()) {
    let activeChanged = false;
    const activeReadId = state.activeReadBindingBySpace.get(spaceId);
    if (activeReadId) {
      state.activeReadBindingBySpace.delete(spaceId);
      activeChanged = true;
    }
    for (const [id, binding] of state.readBindingsById) {
      if (binding.spaceId === spaceId) state.readBindingsById.delete(id);
    }
    if (state.activeWriteBindingId !== null) {
      const active = state.writeBindingsById.get(state.activeWriteBindingId);
      if (active?.spaceId === spaceId) {
        state.activeWriteBindingId = null;
        state.bindingSet = Object.freeze({
          ...state.bindingSet,
          automaticCaptureMode: "disabled" as const,
          captureWriteBindingId: null,
          captureUpdatedAt:
            state.bindingSet.automaticCaptureMode === "disabled"
              ? state.bindingSet.captureUpdatedAt
              : occurredAt,
        });
        activeChanged = true;
      }
    }
    for (const [id, binding] of state.writeBindingsById) {
      if (binding.spaceId === spaceId) state.writeBindingsById.delete(id);
    }
    for (const [key, record] of state.idempotency) {
      if (
        record.spaceId === spaceId ||
        record.result.bindings.readBindings.some(
          (binding) => binding.spaceId === spaceId,
        ) ||
        record.result.bindings.writeBinding?.spaceId === spaceId ||
        record.result.previousWriteBinding?.spaceId === spaceId
      ) {
        state.idempotency.delete(key);
      }
    }
    if (activeChanged && state.bindingSet.state === "active") {
      state.bindingSet = Object.freeze({
        ...state.bindingSet,
        bindingVersion: bindingVersion(state.bindingSet.bindingVersion + 1),
        updatedAt: occurredAt,
      });
    }
  }
}

export function purgeMindBindingsForPrincipal(
  owners: Map<MindBindingOwnerId, MutableMindBindingOwnerState>,
  principalId: PrincipalId,
): void {
  for (const [ownerId, state] of owners) {
    if (state.bindingSet.principalId === principalId) owners.delete(ownerId);
  }
}

export const ZERO_CAPACITY_AMOUNTS: Readonly<CapacityAmounts> = Object.freeze({
  physicalCanonicalBytes: 0,
  temporaryBytes: 0,
  d1MetadataBytes: 0,
});

export function validCapacityAmounts(value: Readonly<CapacityAmounts>): boolean {
  return [
    value.physicalCanonicalBytes,
    value.temporaryBytes,
    value.d1MetadataBytes,
  ].every((amount) => Number.isSafeInteger(amount) && amount >= 0);
}

export function addCapacityAmounts(
  left: Readonly<CapacityAmounts>,
  right: Readonly<CapacityAmounts>,
): Readonly<CapacityAmounts> {
  return Object.freeze({
    physicalCanonicalBytes:
      left.physicalCanonicalBytes + right.physicalCanonicalBytes,
    temporaryBytes: left.temporaryBytes + right.temporaryBytes,
    d1MetadataBytes: left.d1MetadataBytes + right.d1MetadataBytes,
  });
}

export function cloneCapacityReservation(
  reservation: Readonly<CapacityReservation>,
): Readonly<CapacityReservation> {
  return Object.freeze({
    ...reservation,
    requested: Object.freeze({ ...reservation.requested }),
    actual: reservation.actual === null
      ? null
      : Object.freeze({ ...reservation.actual }),
  });
}

export function cloneCapacityReservations(
  source: ReadonlyMap<string, Readonly<CapacityReservation>>,
): Map<string, Readonly<CapacityReservation>> {
  return new Map(
    [...source].map(([id, reservation]) => [id, cloneCapacityReservation(reservation)]),
  );
}

export function capacityOwnerForSpace(
  spaceId: SpaceId,
  knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>,
  memberships: ReadonlyMap<SpaceMembership["membershipId"], Readonly<SpaceMembership>>,
  fallbackPrincipalId: PrincipalId,
): PrincipalId | null {
  const owners = [...memberships.values()].filter(
    (membership) =>
      membership.spaceId === spaceId &&
      membership.state === "active" &&
      membership.role === "owner",
  );
  if (owners.length === 1) return owners[0]!.principalId;
  // Legacy isolated stores used by conformance fixtures predate control-plane
  // aggregates. Production Spaces always have exactly one canonical Owner.
  return knowledgeSpaces.has(spaceId) ? null : fallbackPrincipalId;
}

export function ownedCapacitySpaceIds(
  principalId: PrincipalId,
  spaces: ReadonlyMap<SpaceId, SpaceState>,
  knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>,
  memberships: ReadonlyMap<SpaceMembership["membershipId"], Readonly<SpaceMembership>>,
): ReadonlySet<SpaceId> {
  const owned = new Set<SpaceId>();
  for (const membership of memberships.values()) {
    if (
      membership.principalId === principalId &&
      membership.state === "active" &&
      membership.role === "owner"
    ) owned.add(membership.spaceId);
  }
  if (owned.size === 0 && knowledgeSpaces.size === 0) {
    for (const spaceId of spaces.keys()) owned.add(spaceId);
  }
  return owned;
}

export function capacityUsageFromCanonicalState(input: Readonly<{
  queuedNotes?: ReadonlyMap<string, Readonly<import("@mind-diary/application-ports").QueuedNote>>;
  spaceIds: ReadonlySet<SpaceId>;
  spaces: ReadonlyMap<SpaceId, SpaceState>;
  stagedBundleFiles: ReadonlyMap<StagedBundleFileId, Readonly<StagedBundleFileRecord>>;
  exportJobs: ReadonlyMap<JobId, Readonly<ExportJob>>;
  markdownImportPlans?: ReadonlyMap<string, Readonly<MarkdownImportPlan>>;
  markdownImportSessions?: ReadonlyMap<string, Readonly<MarkdownImportSession>>;
  markdownImportStagedFiles?: ReadonlyMap<StagedBundleFileId, Readonly<MarkdownImportStagedFile>>;
  reservations: ReadonlyMap<string, Readonly<CapacityReservation>>;
  reconciledAt: ReadonlyMap<SpaceId, UtcInstant>;
}>): Readonly<CapacityUsageSnapshot> {
  let logicalHeadBytes = 0;
  let logicalRetainedBytes = 0;
  let physicalCanonicalBytes = 0;
  let temporaryBytes = 0;
  let d1MetadataBytes = 0;
  let reservedBytes = 0;
  let latestReconciledAt: UtcInstant | null = null;
  const uniqueCanonical = new Set<string>();

  for (const spaceId of input.spaceIds) {
    const state = input.spaces.get(spaceId);
    if (!state) continue;
    d1MetadataBytes += 1_024;
    const head = state.head === null ? null : state.revisions.get(state.head) ?? null;
    if (head !== null) {
      logicalHeadBytes += head.manifest.entries.reduce(
        (total, entry) => total + entry.size,
        0,
      );
    }
    for (const envelope of state.revisions.values()) {
      d1MetadataBytes += 512 + envelope.manifest.entries.length * 160;
      logicalRetainedBytes += envelope.manifest.entries.reduce(
        (total, entry) => total + entry.size,
        0,
      );
      const manifestKey = `${spaceId}\u0000manifest\u0000${envelope.revision.manifestHash}`;
      if (!uniqueCanonical.has(manifestKey)) {
        uniqueCanonical.add(manifestKey);
        physicalCanonicalBytes += envelope.revision.manifestSize ?? 0;
      }
      for (const entry of envelope.manifest.entries) {
        const key = `${spaceId}\u0000${entry.kind}\u0000${entry.sha256}`;
        if (uniqueCanonical.has(key)) continue;
        uniqueCanonical.add(key);
        physicalCanonicalBytes += entry.size;
      }
    }
    const reconciled = input.reconciledAt.get(spaceId) ?? null;
    if (
      reconciled !== null &&
      (latestReconciledAt === null || Date.parse(reconciled) > Date.parse(latestReconciledAt))
    ) latestReconciledAt = reconciled;
  }

  for (const note of input.queuedNotes?.values() ?? []) {
    if (!input.spaceIds.has(note.spaceId)) continue;
    d1MetadataBytes += 2_048;
    const key = `${note.spaceId}\u0000markdown\u0000${note.payloadHash}`;
    if (!uniqueCanonical.has(key)) { uniqueCanonical.add(key); physicalCanonicalBytes += note.size; }
  }
  for (const record of input.stagedBundleFiles.values()) {
    if (!input.spaceIds.has(record.spaceId)) continue;
    temporaryBytes += record.size;
    d1MetadataBytes += 512;
  }
  for (const job of input.exportJobs.values()) {
    if (!input.spaceIds.has(job.spaceId)) continue;
    d1MetadataBytes += 768;
    if (job.archive !== null && job.archiveCleanedAt === null) {
      temporaryBytes += job.archive.size;
    }
  }
  for (const plan of input.markdownImportPlans?.values() ?? []) {
    if (!input.spaceIds.has(plan.spaceId)) continue;
    d1MetadataBytes += 512 + plan.files.length * 160;
  }
  for (const session of input.markdownImportSessions?.values() ?? []) {
    if (!input.spaceIds.has(session.spaceId)) continue;
    d1MetadataBytes += 768 + session.failures.length * 128;
  }
  for (const file of input.markdownImportStagedFiles?.values() ?? []) {
    const session = input.markdownImportSessions?.get(file.importId);
    if (session !== undefined && input.spaceIds.has(session.spaceId)) {
      d1MetadataBytes += 384;
    }
  }
  for (const reservation of input.reservations.values()) {
    if (!input.spaceIds.has(reservation.spaceId)) continue;
    d1MetadataBytes += 512;
    if (reservation.state === "active") {
      reservedBytes += reservation.requested.physicalCanonicalBytes +
        reservation.requested.temporaryBytes +
        reservation.requested.d1MetadataBytes;
    }
    if (reservation.state === "cleanup_pending") {
      temporaryBytes += reservation.requested.temporaryBytes +
        reservation.requested.physicalCanonicalBytes;
    }
  }
  const storageAmplification = logicalHeadBytes === 0
    ? 1
    : physicalCanonicalBytes / logicalHeadBytes;
  return Object.freeze({
    logicalHeadBytes,
    logicalRetainedBytes,
    physicalCanonicalBytes,
    temporaryBytes,
    d1MetadataBytes,
    reservedBytes,
    storageAmplification,
    trustworthy: true,
    reconciledAt: latestReconciledAt,
  });
}

/**
 * Canonical retained-revision contribution for one Space. This is the only
 * helper that walks revision manifests; callers persist the result as the
 * admission ledger and update it incrementally on later commits.
 */
export function canonicalCapacityUsageForSpace(
  spaceId: SpaceId,
  state: SpaceState,
  reconciledAt: UtcInstant | null,
): Readonly<CapacityUsageSnapshot> {
  let logicalHeadBytes = 0;
  let logicalRetainedBytes = 0;
  let physicalCanonicalBytes = 0;
  let d1MetadataBytes = 1_024;
  const uniqueCanonical = new Set<string>();
  const head = state.head === null ? null : state.revisions.get(state.head) ?? null;
  if (head !== null) {
    logicalHeadBytes = head.manifest.entries.reduce(
      (total, entry) => total + entry.size,
      0,
    );
  }
  for (const envelope of state.revisions.values()) {
    d1MetadataBytes += 512 + envelope.manifest.entries.length * 160;
    logicalRetainedBytes += envelope.manifest.entries.reduce(
      (total, entry) => total + entry.size,
      0,
    );
    const manifestKey = `${spaceId}\u0000manifest\u0000${envelope.revision.manifestHash}`;
    if (!uniqueCanonical.has(manifestKey)) {
      uniqueCanonical.add(manifestKey);
      physicalCanonicalBytes += envelope.revision.manifestSize ?? 0;
    }
    for (const entry of envelope.manifest.entries) {
      const key = `${spaceId}\u0000${entry.kind}\u0000${entry.sha256}`;
      if (uniqueCanonical.has(key)) continue;
      uniqueCanonical.add(key);
      physicalCanonicalBytes += entry.size;
    }
  }
  return Object.freeze({
    logicalHeadBytes,
    logicalRetainedBytes,
    physicalCanonicalBytes,
    temporaryBytes: 0,
    d1MetadataBytes,
    reservedBytes: 0,
    storageAmplification: logicalHeadBytes === 0
      ? 1
      : physicalCanonicalBytes / logicalHeadBytes,
    trustworthy: true,
    reconciledAt,
  });
}

/**
 * Builds complete usage from per-Space canonical ledgers plus bounded mutable
 * records. It deliberately never reads a revision manifest.
 */
export function capacityUsageFromCanonicalLedger(input: Readonly<{
  queuedNotes?: ReadonlyMap<string, Readonly<import("@mind-diary/application-ports").QueuedNote>>;
  spaceIds: ReadonlySet<SpaceId>;
  ledger: ReadonlyMap<SpaceId, Readonly<CapacityUsageSnapshot>>;
  stagedBundleFiles: ReadonlyMap<StagedBundleFileId, Readonly<StagedBundleFileRecord>>;
  exportJobs: ReadonlyMap<JobId, Readonly<ExportJob>>;
  markdownImportPlans?: ReadonlyMap<string, Readonly<MarkdownImportPlan>>;
  markdownImportSessions?: ReadonlyMap<string, Readonly<MarkdownImportSession>>;
  markdownImportStagedFiles?: ReadonlyMap<StagedBundleFileId, Readonly<MarkdownImportStagedFile>>;
  reservations: ReadonlyMap<string, Readonly<CapacityReservation>>;
}>): Readonly<CapacityUsageSnapshot> {
  let logicalHeadBytes = 0;
  let logicalRetainedBytes = 0;
  let physicalCanonicalBytes = 0;
  let temporaryBytes = 0;
  let d1MetadataBytes = 0;
  let reservedBytes = 0;
  let latestReconciledAt: UtcInstant | null = null;
  const uniqueCanonical = new Set<string>();

  for (const spaceId of input.spaceIds) {
    const usage = input.ledger.get(spaceId);
    if (usage === undefined || usage.trustworthy !== true) {
      throw new TypeError("capacity usage ledger is incomplete");
    }
    logicalHeadBytes += usage.logicalHeadBytes;
    logicalRetainedBytes += usage.logicalRetainedBytes;
    physicalCanonicalBytes += usage.physicalCanonicalBytes;
    d1MetadataBytes += usage.d1MetadataBytes;
    if (
      usage.reconciledAt !== null &&
      (latestReconciledAt === null ||
        Date.parse(usage.reconciledAt) > Date.parse(latestReconciledAt))
    ) latestReconciledAt = usage.reconciledAt;
  }

  for (const note of input.queuedNotes?.values() ?? []) {
    if (!input.spaceIds.has(note.spaceId)) continue;
    d1MetadataBytes += 2_048;
    const key = `${note.spaceId}\u0000markdown\u0000${note.payloadHash}`;
    if (!uniqueCanonical.has(key)) {
      uniqueCanonical.add(key);
      physicalCanonicalBytes += note.size;
    }
  }
  for (const record of input.stagedBundleFiles.values()) {
    if (!input.spaceIds.has(record.spaceId)) continue;
    temporaryBytes += record.size;
    d1MetadataBytes += 512;
  }
  for (const job of input.exportJobs.values()) {
    if (!input.spaceIds.has(job.spaceId)) continue;
    d1MetadataBytes += 768;
    if (job.archive !== null && job.archiveCleanedAt === null) {
      temporaryBytes += job.archive.size;
    }
  }
  for (const plan of input.markdownImportPlans?.values() ?? []) {
    if (!input.spaceIds.has(plan.spaceId)) continue;
    d1MetadataBytes += 512 + plan.files.length * 160;
  }
  for (const session of input.markdownImportSessions?.values() ?? []) {
    if (!input.spaceIds.has(session.spaceId)) continue;
    d1MetadataBytes += 768 + session.failures.length * 128;
  }
  for (const file of input.markdownImportStagedFiles?.values() ?? []) {
    const session = input.markdownImportSessions?.get(file.importId);
    if (session !== undefined && input.spaceIds.has(session.spaceId)) {
      d1MetadataBytes += 384;
    }
  }
  for (const reservation of input.reservations.values()) {
    if (!input.spaceIds.has(reservation.spaceId)) continue;
    d1MetadataBytes += 512;
    if (reservation.state === "active") {
      reservedBytes += reservation.requested.physicalCanonicalBytes +
        reservation.requested.temporaryBytes +
        reservation.requested.d1MetadataBytes;
    }
    if (reservation.state === "cleanup_pending") {
      temporaryBytes += reservation.requested.temporaryBytes +
        reservation.requested.physicalCanonicalBytes;
    }
  }
  return Object.freeze({
    logicalHeadBytes,
    logicalRetainedBytes,
    physicalCanonicalBytes,
    temporaryBytes,
    d1MetadataBytes,
    reservedBytes,
    storageAmplification: logicalHeadBytes === 0
      ? 1
      : physicalCanonicalBytes / logicalHeadBytes,
    trustworthy: true,
    reconciledAt: latestReconciledAt,
  });
}

export function capacityReservationMatches(
  reservation: Readonly<CapacityReservation>,
  request: Readonly<CapacityAdmissionRequest>,
): boolean {
  return reservation.requestedByPrincipalId === request.requestedByPrincipalId &&
    reservation.spaceId === request.spaceId &&
    reservation.operation === request.operation &&
    reservation.operationRef === request.operationRef &&
    reservation.baseRevisionId === request.baseRevisionId &&
    reservation.idempotencyKey === request.idempotencyKey &&
    reservation.bulk === request.bulk &&
    reservation.heavy === request.heavy &&
    JSON.stringify(reservation.requested) === JSON.stringify(request.requested);
}

export function utilizationState(ratio: number): CapacityUtilizationState {
  if (ratio >= 1) return "hard_limit";
  if (ratio >= 0.85) return "soft_limit";
  if (ratio >= 0.7) return "warning";
  return "normal";
}

export function maxUtilizationState(ratios: readonly number[]) {
  return utilizationState(Math.max(0, ...ratios));
}

export function activeReservationAmounts(
  reservations: ReadonlyMap<string, Readonly<CapacityReservation>>,
  predicate: (reservation: Readonly<CapacityReservation>) => boolean,
): Readonly<CapacityAmounts> {
  let total = ZERO_CAPACITY_AMOUNTS;
  for (const reservation of reservations.values()) {
    if (reservation.state === "active" && predicate(reservation)) {
      total = addCapacityAmounts(total, reservation.requested);
    }
  }
  return total;
}

export function validCapacityAdmissionRequest(request: Readonly<CapacityAdmissionRequest>): boolean {
  return request.reservationId.length > 0 &&
    request.operationRef.length > 0 &&
    request.idempotencyKey.length > 0 &&
    validCapacityAmounts(request.requested) &&
    Number.isFinite(Date.parse(request.createdAt)) &&
    Number.isFinite(Date.parse(request.expiresAt)) &&
    Date.parse(request.expiresAt) > Date.parse(request.createdAt);
}

export interface ObjectReachabilityCounts {
  readonly immutable: ReadonlyMap<Digest, number>;
  readonly bundle: ReadonlyMap<string, number>;
  readonly spaceCanonical: ReadonlyMap<string, number>;
  readonly capacity: ReadonlyMap<string, number>;
}

export function cloneObjectReachabilityCounts(value: unknown): Readonly<ObjectReachabilityCounts> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("object reachability counts are invalid");
  }
  const source = value as Record<string, unknown>;
  if (
    !(source.immutable instanceof Map) || !(source.bundle instanceof Map) ||
    !(source.spaceCanonical instanceof Map) || !(source.capacity instanceof Map)
  ) throw new TypeError("object reachability counts are invalid");
  const clone = (input: Map<unknown, unknown>) => {
    const output = new Map<string, number>();
    for (const [key, count] of input) {
      if (
        typeof key !== "string" || !Number.isSafeInteger(count) ||
        (count as number) < 1
      ) throw new TypeError("object reachability counts are invalid");
      output.set(key, count as number);
    }
    return output;
  };
  const immutable = new Map<Digest, number>();
  for (const [key, count] of clone(source.immutable)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(key)) {
      throw new TypeError("object reachability counts are invalid");
    }
    immutable.set(key as unknown as Digest, count);
  }
  return Object.freeze({
    immutable,
    bundle: clone(source.bundle),
    spaceCanonical: clone(source.spaceCanonical),
    capacity: clone(source.capacity),
  });
}

export function cloneObjectCleanupCheckpoint(value: unknown): Readonly<ObjectCleanupCheckpoint> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("object cleanup checkpoint is invalid");
  }
  const source = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(source.version) || (source.version as number) < 0 ||
    typeof source.namespace !== "string" ||
    !(OBJECT_CLEANUP_NAMESPACES as readonly string[]).includes(source.namespace) ||
    (source.cursor !== null && typeof source.cursor !== "string") ||
    typeof source.cycleStartedAt !== "string" || !Number.isFinite(Date.parse(source.cycleStartedAt)) ||
    typeof source.updatedAt !== "string" || !Number.isFinite(Date.parse(source.updatedAt)) ||
    (source.leaseExpiresAt !== null &&
      (typeof source.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(source.leaseExpiresAt)))) ||
    !Number.isSafeInteger(source.retries) || (source.retries as number) < 0 ||
    !Number.isSafeInteger(source.failures) || (source.failures as number) < 0
  ) throw new TypeError("object cleanup checkpoint is invalid");
  return Object.freeze({
    version: source.version as ObjectCleanupCheckpoint["version"],
    namespace: source.namespace as ObjectCleanupNamespace,
    cursor: source.cursor as string | null,
    cycleStartedAt: source.cycleStartedAt as UtcInstant,
    updatedAt: source.updatedAt as UtcInstant,
    leaseExpiresAt: source.leaseExpiresAt as UtcInstant | null,
    retries: source.retries as number,
    failures: source.failures as number,
  });
}
