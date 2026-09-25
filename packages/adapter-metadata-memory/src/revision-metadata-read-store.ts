import type {
  AuthorizationState,
  Envelope,
  MindBindingMutationRequest,
  MutableMindBindingOwnerState,
  RevisionId,
  SpaceId,
} from "./metadata-store-internals.js";
import type {
  AccountDeletionContext,
  ApplyAutomaticCapturePolicyRequest,
  ApplyCredentialWriteTargetRequest,
  ApplyCredentialWriteTargetResult,
  ApplyMindBindingMutationResult,
  ApplyReadMindBindingRequest,
  ApplyWriteMindBindingRequest,
  AuditEvent,
  AuditOutboxMessage,
  AuthorizationStateQuery,
  BundleFileStagingTransaction,
  CapacityLimits,
  CapacityReconcileResult,
  CapacityReservation,
  CapacityReservationTransaction,
  CapacityUsageSnapshot,
  CheckIdempotencyRequest,
  CompleteIdempotencyRequest,
  CredentialWriteTargetSnapshot,
  CredentialWriteTargetTransaction,
  ControlInvitationProjection,
  ControlMemberProjection,
  ExternalIdentityBindingLookup,
  HandleReservationRequest,
  HandleReservationResult,
  HandleResolutionRequest,
  HandleResolutionResult,
  HandleRetirementRequest,
  HandleRetirementResult,
  MembershipMutationReplayRequest,
  MembershipMutationReplayResult,
  MindBindingOwnerId,
  MindBindingSetSnapshot,
  MindBindingTransaction,
  MindRouteAuthorizationQuery,
  OrdinaryMindRouteSnapshot,
  PersonalMindProfileSnapshot,
  PersonalMindResolution,
  PersonalMindTargetClassification,
  PersonalMindTargetRequest,
  Principal,
  PrincipalAccountSnapshot,
  PrincipalActivitySummary,
  PrincipalId,
  PrincipalMindUsageGenerationId,
  PrincipalMindUsageState,
  PrincipalMindWriteGeneration,
  PrincipalMindUsageTransaction,
  PrincipalMindUsageWritePin,
  RegisterCredentialWriteTargetOwnerRequest,
  RegisterCredentialWriteTargetOwnerResult,
  PublicMindCatalogPageRequest,
  PublicMindCatalogPageResult,
  RecordPrincipalActivityRequest,
  RevisionCatalogEntry,
  RevokeMindBindingOwnerRequest,
  RevokeMindBindingOwnerResult,
  RevokeCredentialWriteTargetOwnerRequest,
  RevokeCredentialWriteTargetOwnerResult,
  SetPrincipalMindUsageModeRequest,
  SetPrincipalMindUsageModeResult,
  ServiceOperatorDirectoryPage,
  ServiceOperatorDirectoryQuery,
  ServiceOperatorPrincipalProjection,
  StageServiceOperatorDirectoryAuditRequest,
  StagedBundleFileId,
  StagedBundleFileRecord,
  UtcInstant,
  WriteMindBinding,
} from "@mind-diary/application-ports";
import { RevisionProjectionIntegrityFailure } from "@mind-diary/application-ports";
import {
  reserveHandleAgainst,
  resolveHandleAgainst,
  retireHandleAgainst,
} from "./handle-registry.js";
import {
  BOUNDED_OPAQUE_ID,
  PUBLIC_CATALOG_CURSOR_QUERY,
  SHA256_PATTERN,
  accountByBindingFromMaps,
  accountFromMaps,
  activeReservationAmounts,
  authorizationStateKey,
  canonicalCapacityUsageForSpace,
  capacityUsageFromCanonicalState,
  checkIdempotencyAgainst,
  cloneAccountDeletionCleanup,
  cloneAccountDeletionImpact,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneAuthorizationState,
  cloneCapacityReservation,
  cloneCapacityReservations,
  cloneCredentialWriteTargetOwners,
  cloneLegacyCredentialWriteTargetUpgrades,
  clonePrincipalMindUsageOwners,
  cloneEnvelope,
  cloneRevisionCatalogEntry,
  cloneIdempotencyRecords,
  cloneMindBindingOwners,
  clonePrincipalActivity,
  compareDirectoryRows,
  compareUnicodeScalarValues,
  completeIdempotencyAgainst,
  credentialWriteTargetEffectsAvailable,
  credentialWriteTargetLegacyProjection,
  credentialWriteTargetSnapshot,
  createStagedBundleFileAgainst,
  decodePublicCatalogCursor,
  decodeServiceOperatorCursor,
  emptyMindBindingOwnerState,
  freshCredentialWriteTargetOwnerState,
  encodePublicCatalogCursor,
  encodeServiceOperatorCursor,
  freezeStagedBundleFile,
  ensureSpaceRevisionProjections,
  maxUtilizationState,
  mindBindingEffectsAvailable,
  mindBindingSnapshot,
  migrateLegacyMindBindingOwners,
  normalizeDirectorySearch,
  normalizedUtcInstant,
  ownedCapacitySpaceIds,
  personalMindProfileFromAccount,
  readMembershipReplay,
  recordMindBindingMutation,
  recordCredentialWriteTargetMutation,
  recordPrincipalMindUsageMutation,
  replayCredentialWriteTargetMutation,
  replayMindBindingMutation,
  stageMindBindingAudit,
  stageCredentialWriteTargetAudit,
  stageCredentialWriteTargetRevokeAudit,
  stagePrincipalMindUsageAudit,
  stageMindBindingRevokeAudit,
  validMindBindingMutationBase,
  validCredentialWriteTargetMutation,
  replayPrincipalMindUsageMutation,
  revisionCatalogEntryFromEnvelope,
  compareRevisionAsOfIndexEntries,
} from "./metadata-store-internals.js";
import {
  bindingVersion,
  clearCredentialWriteTarget,
  configureCredentialAutomaticCapture,
  createFreshPrincipalMindUsageState,
  freezePrincipalMindUsageState,
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
  principalMindUsageWritePinMatches,
  revokeCredentialWriteTarget,
  selectCredentialWriteTarget,
  setPrincipalMindUsageMode,
  upgradeLegacyCredentialWriteTarget,
  version,
} from "@mind-diary/application-ports";
import { RevisionMetadataSnapshotStore } from "./revision-metadata-snapshot-store.js";
import { cloneCopyOnWriteValue, copyOnWriteMap } from "./copy-on-write.js";

function revisionCatalogEntryMatchesEnvelope(
  entry: Readonly<RevisionCatalogEntry>,
  envelope: Readonly<Envelope>,
): boolean {
  const expected = revisionCatalogEntryFromEnvelope(envelope);
  return entry.fileCount === expected.fileCount &&
    entry.totalBytes === expected.totalBytes &&
    entry.revision.spaceId === expected.revision.spaceId &&
    entry.revision.revisionId === expected.revision.revisionId &&
    entry.revision.revisionNumber === expected.revision.revisionNumber &&
    entry.revision.parentRevisionId === expected.revision.parentRevisionId &&
    entry.revision.committedAt === expected.revision.committedAt &&
    entry.revision.summary === expected.revision.summary &&
    entry.revision.manifestHash === expected.revision.manifestHash &&
    JSON.stringify(entry.revision.committedBy) ===
      JSON.stringify(expected.revision.committedBy);
}

function revisionProjectionIntegrityFailure(): never {
  throw new RevisionProjectionIntegrityFailure();
}

export abstract class RevisionMetadataReadStore extends RevisionMetadataSnapshotStore {
  async decommissionLegacyMindBindingsForMigration(): Promise<void> {
      await this._runExclusive(async () => {
        for (const [ownerId, evidence] of migrateLegacyMindBindingOwners(
          this._mindBindingOwners,
        )) {
          if (
            !this._credentialWriteTargetOwners.has(ownerId) &&
            !this._legacyCredentialWriteTargetUpgrades.has(ownerId)
          ) this._legacyCredentialWriteTargetUpgrades.set(ownerId, evidence);
        }
        this._mindBindingOwners.clear();
      });
    }
  async recordPrincipalActivity(
      request: Readonly<RecordPrincipalActivityRequest>,
    ): Promise<void> {
      await this._runExclusive(async () => {
        if (
          !BOUNDED_OPAQUE_ID.test(request.principalId) ||
          !Number.isFinite(Date.parse(request.observedAt)) ||
          (request.surface !== "web" && request.surface !== "mcp") ||
          ![
            "page",
            "control_read",
            "control_write",
            "discovery",
            "content_read",
            "content_write",
          ].includes(request.kind) ||
          (request.surface === "web" &&
            !["page", "control_read", "control_write"].includes(request.kind)) ||
          (request.surface === "mcp" &&
            !["discovery", "content_read", "content_write"].includes(request.kind))
        ) {
          throw new TypeError("Principal activity observation is invalid");
        }
        const principal = this._principals.get(request.principalId);
        if (!principal || principal.state !== "active") return;
        const current = this._principalActivities.get(request.principalId) ?? null;
        const observed = Date.parse(request.observedAt);
        const lastSurfaceAt = request.surface === "web"
          ? current?.lastWebSeenAt ?? null
          : current?.lastMcpSeenAt ?? null;
        const advancesSurface =
          lastSurfaceAt === null || observed > Date.parse(lastSurfaceAt);
        const advancesOverall =
          current?.lastActivityAt === null ||
          current?.lastActivityAt === undefined ||
          observed > Date.parse(current.lastActivityAt);
        if (!advancesSurface && !advancesOverall) return;
        const summary: Readonly<PrincipalActivitySummary> = Object.freeze({
          principalId: request.principalId,
          lastWebSeenAt:
            request.surface === "web" && advancesSurface
              ? request.observedAt
              : current?.lastWebSeenAt ?? null,
          lastMcpSeenAt:
            request.surface === "mcp" && advancesSurface
              ? request.observedAt
              : current?.lastMcpSeenAt ?? null,
          lastActivityAt: advancesOverall
            ? request.observedAt
            : current?.lastActivityAt ?? null,
          lastActivitySurface: advancesOverall
            ? request.surface
            : current?.lastActivitySurface ?? null,
          lastActivityKind: advancesOverall
            ? request.kind
            : current?.lastActivityKind ?? null,
        });
        this._principalActivities.set(request.principalId, summary);
      });
    }

  async readPrincipalActivity(
      principalId: PrincipalId,
    ): Promise<Readonly<PrincipalActivitySummary> | null> {
      const current = this._principalActivities.get(principalId);
      return current ? clonePrincipalActivity(current) : null;
    }

  async listServiceOperatorPrincipals(
      query: Readonly<ServiceOperatorDirectoryQuery>,
    ): Promise<Readonly<ServiceOperatorDirectoryPage>> {
      const offset = decodeServiceOperatorCursor(query.cursor);
      if (
        offset === null ||
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 100
      ) {
        throw new TypeError("Service operator directory query is invalid");
      }
      const personalSpaceIds = new Set(
        [...this._personalBindings.values()].map((binding) => binding.spaceId),
      );
      const normalizedQuery = query.query === undefined
        ? null
        : normalizeDirectorySearch(query.query);
      const rows = [...this._principals.values()].flatMap((principal) => {
        const binding = [...this._externalBindings.values()]
          .filter(
            (candidate) =>
              candidate.principalId === principal.principalId &&
              candidate.state === "active",
          )
          .sort((left, right) =>
            compareUnicodeScalarValues(left.bindingId, right.bindingId),
          )[0];
        if (!binding) return [];
        const activity = this._principalActivities.get(principal.principalId) ?? null;
        const activeOrdinaryMemberships = [...this._memberships.values()].filter(
          (membership) =>
            membership.principalId === principal.principalId &&
            membership.state === "active" &&
            !personalSpaceIds.has(membership.spaceId) &&
            this._knowledgeSpaces.get(membership.spaceId)?.state === "active",
        );
        const row: Readonly<ServiceOperatorPrincipalProjection> = Object.freeze({
          principalId: principal.principalId,
          displayName: principal.displayName,
          verifiedEmail: String(binding.normalizedBinding),
          state: principal.state,
          registeredAt: principal.createdAt,
          activity: activity === null ? null : clonePrincipalActivity(activity),
          ownedMindCount: activeOrdinaryMemberships.filter(
            (membership) => membership.role === "owner",
          ).length,
          participatingMindCount: activeOrdinaryMemberships.filter(
            (membership) => membership.role !== "owner",
          ).length,
        });
        if (query.state !== undefined && row.state !== query.state) return [];
        if (
          query.registeredFrom !== undefined &&
          Date.parse(row.registeredAt) < Date.parse(query.registeredFrom)
        ) return [];
        if (
          query.registeredTo !== undefined &&
          Date.parse(row.registeredAt) > Date.parse(query.registeredTo)
        ) return [];
        const lastActivityAt = row.activity?.lastActivityAt ?? null;
        if (query.neverActive === true && lastActivityAt !== null) return [];
        if (query.neverActive === false && lastActivityAt === null) return [];
        if (
          query.activityFrom !== undefined &&
          (lastActivityAt === null ||
            Date.parse(lastActivityAt) < Date.parse(query.activityFrom))
        ) return [];
        if (
          query.activityTo !== undefined &&
          (lastActivityAt === null ||
            Date.parse(lastActivityAt) > Date.parse(query.activityTo))
        ) return [];
        if (
          normalizedQuery !== null &&
          normalizeDirectorySearch(row.verifiedEmail) !== normalizedQuery &&
          !normalizeDirectorySearch(row.displayName).includes(normalizedQuery)
        ) return [];
        return [row];
      }).sort((left, right) => compareDirectoryRows(left, right, query));
      const end = Math.min(offset + query.limit, rows.length);
      return Object.freeze({
        principals: Object.freeze(rows.slice(offset, end)),
        nextCursor: end < rows.length ? encodeServiceOperatorCursor(end) : null,
      });
    }

  async stageServiceOperatorDirectoryAudit(
      request: Readonly<StageServiceOperatorDirectoryAuditRequest>,
    ): Promise<void> {
      await this._runExclusive(async () => {
        if (
          !BOUNDED_OPAQUE_ID.test(request.operatorPrincipalId) ||
          !BOUNDED_OPAQUE_ID.test(request.requestId) ||
          !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
          !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
          !Number.isFinite(Date.parse(request.occurredAt)) ||
          !this._principals.has(request.operatorPrincipalId) ||
          this._auditEvents.has(request.auditEventId) ||
          this._auditOutbox.has(request.auditOutboxMessageId)
        ) {
          throw new TypeError("Service operator directory audit is invalid");
        }
        const event: Readonly<AuditEvent> = Object.freeze({
          auditEventId: request.auditEventId,
          actor: Object.freeze({
            kind: "principal" as const,
            principalId: request.operatorPrincipalId,
          }),
          requestId: request.requestId,
          eventType: "service_operator.principal_directory_read",
          outcome: "succeeded" as const,
          spaceId: null,
          occurredAt: request.occurredAt,
          safeMetadata: Object.freeze({ operation: "list_principals" }),
        });
        const outbox: Readonly<AuditOutboxMessage> = Object.freeze({
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
        this._auditEvents.set(event.auditEventId, cloneAuditEvent(event));
        this._auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
      });
    }

  async runCapacityTransaction<Result>(
      operation: (transaction: CapacityReservationTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const reservations = cloneCapacityReservations(this._capacityReservations);
        const transaction = this._capacityTransaction(reservations);
        const result = await operation(transaction);
        this._capacityReservations = reservations;
        return result;
      });
    }

  async readMindCapacityUsage(
      spaceId: SpaceId,
    ): Promise<Readonly<CapacityUsageSnapshot> | null> {
      return this._runExclusive(async () => {
        if (!this._spaces.has(spaceId)) return null;
        return this._capacityUsageFromLedger(new Set([spaceId]));
      });
    }

  async readPrincipalCapacityUsage(
      principalId: PrincipalId,
    ): Promise<Readonly<CapacityUsageSnapshot>> {
      return this._runExclusive(async () => this._capacityUsageFromLedger(
        ownedCapacitySpaceIds(
          principalId,
          this._spaces,
          this._knowledgeSpaces,
          this._memberships,
        ),
      ));
    }

  async readSiteCapacityUsage(): Promise<Readonly<CapacityUsageSnapshot>> {
      return this._runExclusive(async () =>
        this._capacityUsageFromLedger(new Set(this._spaces.keys())));
    }

  async readCapacityTelemetry(
      limits: Readonly<CapacityLimits>,
      now: UtcInstant,
    ) {
      return this._runExclusive(async () => {
        const usage = this._capacityUsageFromLedger(new Set(this._spaces.keys()));
        const active = activeReservationAmounts(
          this._capacityReservations,
          () => true,
        );
        const utilization = maxUtilizationState([
          (usage.physicalCanonicalBytes + active.physicalCanonicalBytes) /
            limits.sitePhysicalCanonicalBytes,
          (usage.temporaryBytes + active.temporaryBytes) /
            limits.siteTemporaryBytes,
          (usage.d1MetadataBytes + active.d1MetadataBytes) /
            limits.siteD1MetadataBytes,
        ]);
        return Object.freeze({
          canonicalHeadroomBytes: Math.max(
            0,
            limits.sitePhysicalCanonicalBytes - usage.physicalCanonicalBytes -
              active.physicalCanonicalBytes,
          ),
          temporaryHeadroomBytes: Math.max(
            0,
            limits.siteTemporaryBytes - usage.temporaryBytes - active.temporaryBytes,
          ),
          d1HeadroomBytes: Math.max(
            0,
            limits.siteD1MetadataBytes - usage.d1MetadataBytes - active.d1MetadataBytes,
          ),
          storageAmplification: usage.storageAmplification,
          quotaRejects: this._capacityQuotaRejects,
          staleReservations: [...this._capacityReservations.values()].filter(
            (reservation) =>
              reservation.state === "cleanup_pending" ||
              (reservation.state === "active" &&
                Date.parse(reservation.expiresAt) <= Date.parse(now)),
          ).length,
          utilization,
        });
      });
    }

  async reconcileCapacityUsage(request: Readonly<{
      spaceId?: SpaceId;
      reconciledAt: UtcInstant;
    }>): Promise<Readonly<CapacityReconcileResult>> {
      if (!Number.isFinite(Date.parse(request.reconciledAt))) {
        throw new TypeError("capacity reconciliation time must be valid UTC");
      }
      return this._runExclusive(async () => {
        const selected = request.spaceId === undefined
          ? new Set(this._spaces.keys())
          : new Set(this._spaces.has(request.spaceId) ? [request.spaceId] : []);
        const previousUsage = this._capacityUsageFromLedger(selected);
        for (const spaceId of selected) {
          this._capacityReconciledAt.set(spaceId, request.reconciledAt);
          const state = this._spaces.get(spaceId);
          if (state !== undefined) this._capacityUsageLedger.set(
            spaceId,
            canonicalCapacityUsageForSpace(spaceId, state, request.reconciledAt),
          );
        }
        const usage = capacityUsageFromCanonicalState({
          spaceIds: selected,
          spaces: this._spaces,
          stagedBundleFiles: this._stagedBundleFiles,
          queuedNotes: this._queuedNotes,
          exportJobs: this._exportJobs,
          markdownImportPlans: this._markdownImportPlans,
          markdownImportSessions: this._markdownImportSessions,
          markdownImportStagedFiles: this._markdownImportStagedFiles,
          reservations: this._capacityReservations,
          reconciledAt: this._capacityReconciledAt,
        });
        const driftDetected = JSON.stringify({ ...previousUsage, reconciledAt: null }) !==
          JSON.stringify({ ...usage, reconciledAt: null });
        return Object.freeze({
          spaceId: request.spaceId ?? null,
          scannedSpaces: selected.size,
          driftDetected,
          usage,
        });
      });
    }

  async collectExpiredCapacityReservations(request: Readonly<{
      now: UtcInstant;
      limit: number;
    }>): Promise<readonly Readonly<CapacityReservation>[]> {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new TypeError("capacity reservation cleanup limit must be positive");
      }
      return this._runExclusive(async () => {
        const expired = [...this._capacityReservations.values()]
          .filter(
            (reservation) =>
              reservation.state === "cleanup_pending" ||
              (reservation.state === "active" &&
                Date.parse(reservation.expiresAt) <= Date.parse(request.now)),
          )
          .sort((left, right) =>
            Date.parse(left.expiresAt) - Date.parse(right.expiresAt) ||
            left.reservationId.localeCompare(right.reservationId),
          )
          .slice(0, request.limit)
          .map((reservation) => reservation.state === "cleanup_pending"
            ? cloneCapacityReservation(reservation)
            : cloneCapacityReservation(Object.freeze({
                ...reservation,
                state: "cleanup_pending" as const,
                updatedAt: request.now,
              })));
        for (const reservation of expired) {
          this._capacityReservations.set(reservation.reservationId, reservation);
        }
        return Object.freeze(expired);
      });
    }

  async closeCapacityReservationWriter(request: Readonly<{
      reservationId: string;
      expectedAttemptId: string;
      closedAt: UtcInstant;
    }>): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._capacityReservations.get(request.reservationId);
        if (current === undefined || current.attemptId !== request.expectedAttemptId ||
          current.operation !== "commit" ||
          (current.state !== "active" && current.state !== "cleanup_pending")) return false;
        if (current.writerClosedAt !== undefined && current.writerClosedAt !== null) return true;
        this._capacityReservations.set(request.reservationId,
          cloneCapacityReservation(Object.freeze({
            ...current,
            writerClosedAt: request.closedAt,
            updatedAt: request.closedAt,
          })));
        return true;
      });
    }

  async releaseCapacityReservation(request: Readonly<{
      reservationId: string;
      expectedAttemptId?: string;
      releasedAt: UtcInstant;
    }>): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._capacityReservations.get(request.reservationId);
        if (current === undefined || current.state === "released") return false;
        if (current.state === "active") return false;
        // Canonical exposure needs a complete fenced object-cleanup cycle.
        // That proof is committed atomically by completeObjectCleanupBatch.
        if (current.operation === "commit" || current.operation === "import") return false;
        this._capacityReservations.set(
          request.reservationId,
          cloneCapacityReservation(Object.freeze({
            ...current,
            state: "released" as const,
            updatedAt: request.releasedAt,
          })),
        );
        return true;
      });
    }

  async listCapacityReservationsForTest(): Promise<readonly Readonly<CapacityReservation>[]> {
      return this._runExclusive(async () => Object.freeze(
        [...this._capacityReservations.values()]
          .sort((left, right) => left.reservationId.localeCompare(right.reservationId))
          .map(cloneCapacityReservation),
      ));
    }

  /** Internal scoped read for an authorized operator diagnostic. */
  async listCapacityReservationsForSpace(spaceId: SpaceId): Promise<readonly Readonly<CapacityReservation>[]> {
    return this._runExclusive(async () => Object.freeze(
      [...this._capacityReservations.values()]
        .filter((reservation) => reservation.spaceId === spaceId)
        .sort((left, right) => left.reservationId.localeCompare(right.reservationId))
        .map(cloneCapacityReservation),
    ));
  }

  async readMindBindingSet(
      bindingOwnerId: MindBindingOwnerId,
      principalId: PrincipalId,
      occurredAt: ApplyReadMindBindingRequest["occurredAt"],
    ): Promise<Readonly<MindBindingSetSnapshot> | null> {
      if (
        !BOUNDED_OPAQUE_ID.test(bindingOwnerId) ||
        !BOUNDED_OPAQUE_ID.test(principalId) ||
        !Number.isFinite(Date.parse(occurredAt))
      ) {
        return null;
      }
      const state = this._mindBindingOwners.get(bindingOwnerId);
      const target = this._credentialWriteTargetOwners.get(bindingOwnerId);
      if (target !== undefined) {
        if (target.state.principalId !== principalId) return null;
        return credentialWriteTargetLegacyProjection(target.state);
      }
      if (this._legacyCredentialWriteTargetUpgrades.has(bindingOwnerId)) {
        return null;
      }
      if (state && state.bindingSet.principalId !== principalId) return null;
      return mindBindingSnapshot(
        state ?? emptyMindBindingOwnerState(bindingOwnerId, principalId, occurredAt),
      );
    }

  async readCredentialWriteTarget(
      bindingOwnerId: MindBindingOwnerId,
      principalId: PrincipalId,
    ): Promise<Readonly<CredentialWriteTargetSnapshot> | null> {
      if (
        !BOUNDED_OPAQUE_ID.test(bindingOwnerId) ||
        !BOUNDED_OPAQUE_ID.test(principalId)
      ) return null;
      const current = this._credentialWriteTargetOwners.get(bindingOwnerId);
      const legacy = this._legacyCredentialWriteTargetUpgrades.get(bindingOwnerId);
      if (
        (current !== undefined && current.state.principalId !== principalId) ||
        (legacy !== undefined && legacy.principalId !== principalId)
      ) return null;
      return credentialWriteTargetSnapshot(current, legacy);
    }

  async runCredentialWriteTargetTransaction<Result>(
      operation: (transaction: CredentialWriteTargetTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const owners = cloneCredentialWriteTargetOwners(
          this._credentialWriteTargetOwners,
        );
        const legacy = cloneLegacyCredentialWriteTargetUpgrades(
          this._legacyCredentialWriteTargetUpgrades,
        );
        const auditEvents = copyOnWriteMap(this._auditEvents, cloneAuditEvent);
        const auditOutbox = copyOnWriteMap(this._auditOutbox, cloneAuditOutbox);

        const generationIdUsed = (generationId: string): boolean =>
          [...owners.values()].some((owner) =>
            owner.retiredGenerationIds.has(generationId) ||
            owner.state.activeGeneration?.generationId === generationId ||
            [...owner.idempotency.values()].some(
              (record) => record.result.state.activeGeneration?.generationId === generationId,
            ),
          );
        const writerRoleFor = async (
          principalId: PrincipalId,
          spaceId: SpaceId | null,
        ) => {
          if (spaceId === null) return null;
          const state = await this.readCurrentAuthorizationState({
            principalId,
            spaceId,
            tokenId: null,
          });
          const role =
            state?.principal.state === "active" &&
            state.space.state === "active" &&
            state.membership?.state === "active" &&
            state.membership.principalId === principalId &&
            state.membership.spaceId === spaceId
              ? state.membership.role
              : null;
          return role;
        };

        const transaction: CredentialWriteTargetTransaction = Object.freeze({
          kind: "credential-write-target-transaction" as const,
          readCredentialWriteTarget: async (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => {
            const current = owners.get(bindingOwnerId);
            const migration = legacy.get(bindingOwnerId);
            if (
              (current !== undefined && current.state.principalId !== principalId) ||
              (migration !== undefined && migration.principalId !== principalId)
            ) return null;
            return credentialWriteTargetSnapshot(current, migration);
          },
          registerCredentialWriteTargetOwner: async (
            request: Readonly<RegisterCredentialWriteTargetOwnerRequest>,
          ): Promise<RegisterCredentialWriteTargetOwnerResult> => {
            if (
              !BOUNDED_OPAQUE_ID.test(request.bindingOwnerId) ||
              !BOUNDED_OPAQUE_ID.test(request.principalId) ||
              (request.credentialKind !== "oauth_grant" &&
                request.credentialKind !== "personal_token") ||
              !Number.isFinite(Date.parse(request.occurredAt))
            ) return Object.freeze({ kind: "invalid_record" });
            const existing = owners.get(request.bindingOwnerId);
            if (existing !== undefined) {
              return existing.state.principalId === request.principalId &&
                  existing.state.credentialKind === request.credentialKind
                ? Object.freeze({
                    kind: "registered" as const,
                    state: existing.state,
                    replayed: true,
                  })
                : Object.freeze({ kind: "owner_conflict" as const });
            }
            // A legacy owner cannot bypass explicit upgrade/re-consent by being
            // registered as if it were a fresh credential.
            if (legacy.has(request.bindingOwnerId)) {
              return Object.freeze({ kind: "owner_conflict" });
            }
            const created = freshCredentialWriteTargetOwnerState(request);
            owners.set(request.bindingOwnerId, created);
            return Object.freeze({
              kind: "registered" as const,
              state: created.state,
              replayed: false,
            });
          },
          applyCredentialWriteTarget: async (
            request: Readonly<ApplyCredentialWriteTargetRequest>,
          ): Promise<ApplyCredentialWriteTargetResult> => {
            if (!validCredentialWriteTargetMutation(request)) {
              return Object.freeze({ kind: "invalid_record" });
            }
            let owner = owners.get(request.bindingOwnerId);
            if (owner !== undefined) {
              if (owner.state.principalId !== request.principalId) {
                return Object.freeze({ kind: "owner_mismatch" });
              }
              const replay = replayCredentialWriteTargetMutation(owner, request);
              if (replay !== null) return replay;
            }

            let transition;
            if (request.operation === "upgrade_legacy") {
              const evidence = legacy.get(request.bindingOwnerId);
              if (evidence === undefined) {
                return Object.freeze({
                  kind: owner === undefined ? "not_found" : "credential_inactive",
                });
              }
              if (evidence.principalId !== request.principalId) {
                return Object.freeze({ kind: "owner_mismatch" });
              }
              if (generationIdUsed(request.generationId)) {
                return Object.freeze({ kind: "invalid_record" });
              }
              transition = upgradeLegacyCredentialWriteTarget({
                evidence,
                bindingOwnerId: request.bindingOwnerId,
                principalId: request.principalId,
                credentialKind: request.credentialKind,
                generationId: request.generationId,
                authority: {
                  hasContentWriteScope: request.credentialHasWriteScope,
                  currentRole: await writerRoleFor(
                    request.principalId,
                    evidence.candidateSpaceId,
                  ),
                },
                occurredAt: request.occurredAt,
              });
              if (transition.kind === "applied") {
                owner = {
                  state: transition.state,
                  retiredGenerationIds: new Set(),
                  idempotency: new Map(),
                };
                owners.set(request.bindingOwnerId, owner);
                legacy.delete(request.bindingOwnerId);
              }
            } else {
              if (owner === undefined) {
                return Object.freeze({
                  kind: legacy.has(request.bindingOwnerId)
                    ? "pending_upgrade"
                    : "not_found",
                });
              }
              if (
                request.operation === "select" &&
                owner.state.activeGeneration?.spaceId !== request.spaceId &&
                generationIdUsed(request.generationId)
              ) return Object.freeze({ kind: "invalid_record" });
              if (request.operation === "select") {
                transition = selectCredentialWriteTarget(owner.state, {
                  principalId: request.principalId,
                  spaceId: request.spaceId,
                  expectedTargetVersion: request.expectedTargetVersion,
                  generationId: request.generationId,
                  authority: {
                    hasContentWriteScope: request.credentialHasWriteScope,
                    currentRole: await writerRoleFor(
                      request.principalId,
                      request.spaceId,
                    ),
                  },
                  occurredAt: request.occurredAt,
                });
              } else if (request.operation === "clear") {
                transition = clearCredentialWriteTarget(owner.state, request);
              } else {
                transition = configureCredentialAutomaticCapture(owner.state, {
                  ...request,
                  authority: {
                    hasContentWriteScope: request.credentialHasWriteScope,
                    currentRole: await writerRoleFor(
                      request.principalId,
                      owner.state.activeGeneration?.spaceId ?? null,
                    ),
                  },
                });
              }
            }
            if (transition.kind !== "applied") {
              return Object.freeze({ kind: transition.kind });
            }
            if (owner === undefined) return Object.freeze({ kind: "invalid_record" });
            if (
              !credentialWriteTargetEffectsAvailable(
                request,
                auditEvents,
                auditOutbox,
              )
            ) return Object.freeze({ kind: "effect_conflict" });
            const previousGenerationId = owner.state.activeGeneration?.generationId;
            owner.state = transition.state;
            if (
              previousGenerationId !== undefined &&
              previousGenerationId !== transition.state.activeGeneration?.generationId
            ) owner.retiredGenerationIds.add(previousGenerationId);
            const result = Object.freeze({
              kind: "applied" as const,
              state: transition.state,
              changed: transition.changed,
              replayed: false,
            });
            stageCredentialWriteTargetAudit(
              request,
              result,
              auditEvents,
              auditOutbox,
            );
            recordCredentialWriteTargetMutation(owner, request, result);
            return result;
          },
        });

        const result = await operation(transaction);
        this._credentialWriteTargetOwners = owners;
        this._legacyCredentialWriteTargetUpgrades = legacy;
        this._auditEvents = auditEvents;
        this._auditOutbox = auditOutbox;
        return result;
      });
    }

  async revokeCredentialWriteTargetOwner(
      request: Readonly<RevokeCredentialWriteTargetOwnerRequest>,
    ): Promise<RevokeCredentialWriteTargetOwnerResult> {
      return this._runExclusive(async () => {
        if (
          !BOUNDED_OPAQUE_ID.test(request.bindingOwnerId) ||
          !BOUNDED_OPAQUE_ID.test(request.principalId) ||
          !BOUNDED_OPAQUE_ID.test(request.requestId) ||
          !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
          !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
          !Number.isFinite(Date.parse(request.occurredAt))
        ) return Object.freeze({ kind: "invalid_record" });
        const owner = this._credentialWriteTargetOwners.get(request.bindingOwnerId);
        const legacy = this._legacyCredentialWriteTargetUpgrades.get(
          request.bindingOwnerId,
        );
        if (owner === undefined) {
          if (legacy === undefined) return Object.freeze({ kind: "not_found" });
          if (legacy.principalId !== request.principalId) {
            return Object.freeze({ kind: "owner_mismatch" });
          }
          // Pending legacy credentials are already fail-closed. Revocation
          // removes the last migration-only evidence and cannot revive target IDs.
          this._legacyCredentialWriteTargetUpgrades.delete(request.bindingOwnerId);
          return Object.freeze({ kind: "revoked", changed: true, replayed: false });
        }
        if (owner.state.principalId !== request.principalId) {
          return Object.freeze({ kind: "owner_mismatch" });
        }
        const transition = revokeCredentialWriteTarget(
          owner.state,
          request.principalId,
          request.occurredAt,
        );
        if (transition.kind !== "applied") {
          return Object.freeze({
            kind: transition.kind === "owner_mismatch"
              ? "owner_mismatch" as const
              : "invalid_record" as const,
          });
        }
        if (!transition.changed) {
          return Object.freeze({ kind: "revoked", changed: false, replayed: true });
        }
        if (
          !credentialWriteTargetEffectsAvailable(
            request,
            this._auditEvents,
            this._auditOutbox,
          )
        ) return Object.freeze({ kind: "effect_conflict" });
        const previousGenerationId = owner.state.activeGeneration?.generationId;
        owner.state = transition.state;
        if (previousGenerationId !== undefined) {
          owner.retiredGenerationIds.add(previousGenerationId);
        }
        stageCredentialWriteTargetRevokeAudit(
          request,
          true,
          this._auditEvents,
          this._auditOutbox,
        );
        return Object.freeze({ kind: "revoked", changed: true, replayed: false });
      });
    }

  async readPrincipalMindUsage(
      principalId: PrincipalId,
    ): Promise<Readonly<PrincipalMindUsageState> | null> {
      if (!BOUNDED_OPAQUE_ID.test(principalId)) return null;
      const principal = this._principals.get(principalId);
      if (principal?.state !== "active") return null;
      const owner = this._principalMindUsageOwners.get(principalId);
      return owner === undefined
        ? null
        : freezePrincipalMindUsageState(owner.state);
    }

  async validatePrincipalMindUsageWritePin(
      pin: Readonly<PrincipalMindUsageWritePin>,
    ): Promise<boolean> {
      if (
        !BOUNDED_OPAQUE_ID.test(pin.principalId) ||
        !BOUNDED_OPAQUE_ID.test(pin.spaceId) ||
        !BOUNDED_OPAQUE_ID.test(pin.generationId)
      ) return false;
      const principal = this._principals.get(pin.principalId);
      const space = this._knowledgeSpaces.get(pin.spaceId);
      const owner = this._principalMindUsageOwners.get(pin.principalId);
      const linkedPersonalBinding = [...this._personalBindings.values()].find(
        (binding) => binding.spaceId === pin.spaceId,
      );
      const isOwnPersonal = linkedPersonalBinding?.principalId === pin.principalId &&
        this._personalBindings.get(pin.principalId)?.spaceId === pin.spaceId;
      if (
        principal?.state !== "active" ||
        space?.state !== "active" ||
        owner === undefined ||
        (linkedPersonalBinding !== undefined && !isOwnPersonal) ||
        !principalMindUsageWritePinMatches(owner.state, pin)
      ) return false;
      const membership = [...this._memberships.values()].find((candidate) =>
        candidate.principalId === pin.principalId &&
        candidate.spaceId === pin.spaceId &&
        candidate.state === "active");
      if (
        membership === undefined ||
        !["editor", "admin", "owner"].includes(membership.role)
      ) return false;
      return true;
    }

  async runPrincipalMindUsageTransaction<Result>(
      operation: (transaction: PrincipalMindUsageTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const owners = clonePrincipalMindUsageOwners(
          this._principalMindUsageOwners,
        );
        const auditEvents = copyOnWriteMap(this._auditEvents, cloneAuditEvent);
        const auditOutbox = copyOnWriteMap(this._auditOutbox, cloneAuditOutbox);
        const generationUsed = (generationId: PrincipalMindUsageGenerationId) =>
          [...owners.values()].some((owner) =>
            owner.retiredGenerationIds.has(generationId) ||
            owner.state.entries.some((entry) =>
              entry.writeGeneration?.generationId === generationId) ||
            [...owner.idempotency.values()].some((record) =>
              record.result.state.entries.some((entry) =>
                entry.writeGeneration?.generationId === generationId)));

        const transaction: PrincipalMindUsageTransaction = Object.freeze({
          kind: "principal-mind-usage-transaction" as const,
          readPrincipalMindUsage: async (principalId: PrincipalId) => {
            const principal = this._principals.get(principalId);
            const owner = owners.get(principalId);
            return principal?.state !== "active" || owner === undefined
              ? null
              : freezePrincipalMindUsageState(owner.state);
          },
          validatePrincipalMindUsageWritePin: async (
            pin: Readonly<PrincipalMindUsageWritePin>,
          ) => {
            const principal = this._principals.get(pin.principalId);
            const space = this._knowledgeSpaces.get(pin.spaceId);
            const owner = owners.get(pin.principalId);
            const linkedPersonalBinding = [...this._personalBindings.values()].find(
              (binding) => binding.spaceId === pin.spaceId,
            );
            const isOwnPersonal = linkedPersonalBinding?.principalId === pin.principalId &&
              this._personalBindings.get(pin.principalId)?.spaceId === pin.spaceId;
            const membership = [...this._memberships.values()].find((candidate) =>
              candidate.principalId === pin.principalId &&
              candidate.spaceId === pin.spaceId &&
              candidate.state === "active");
            if (
              principal?.state !== "active" ||
              space?.state !== "active" ||
              owner === undefined ||
              (linkedPersonalBinding !== undefined && !isOwnPersonal) ||
              membership === undefined ||
              !["editor", "admin", "owner"].includes(membership.role) ||
              !principalMindUsageWritePinMatches(owner.state, pin)
            ) return false;
            return true;
          },
          setPrincipalMindUsageMode: async (
            request: Readonly<SetPrincipalMindUsageModeRequest>,
          ): Promise<SetPrincipalMindUsageModeResult> => {
            if (
              !BOUNDED_OPAQUE_ID.test(request.principalId) ||
              !BOUNDED_OPAQUE_ID.test(request.spaceId) ||
              !BOUNDED_OPAQUE_ID.test(request.generationId) ||
              !BOUNDED_OPAQUE_ID.test(request.requestId) ||
              !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
              !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
              !["disabled", "read", "read_write"].includes(request.usageMode) ||
              !Number.isSafeInteger(request.expectedUsageVersion) ||
              request.expectedUsageVersion < 0 ||
              !SHA256_PATTERN.test(request.canonicalRequestHash) ||
              !Number.isFinite(Date.parse(request.occurredAt))
            ) return Object.freeze({ kind: "invalid_record" });
            const principal = this._principals.get(request.principalId);
            if (principal?.state !== "active") {
              return Object.freeze({ kind: "principal_not_found" });
            }
            const space = this._knowledgeSpaces.get(request.spaceId);
            if (space?.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const membership = [...this._memberships.values()].find((candidate) =>
              candidate.principalId === request.principalId &&
              candidate.spaceId === request.spaceId &&
              candidate.state === "active");
            const canRead = membership !== undefined || space.visibility !== "private";
            if (!canRead) return Object.freeze({ kind: "read_access_required" });
            const linkedPersonalBinding = [...this._personalBindings.values()].find(
              (binding) => binding.spaceId === request.spaceId,
            );
            const isOwnPersonal = linkedPersonalBinding?.principalId === request.principalId &&
              this._personalBindings.get(request.principalId)?.spaceId === request.spaceId;
            if (linkedPersonalBinding !== undefined && !isOwnPersonal) {
              return Object.freeze({ kind: "mind_not_found" });
            }
            if (
              request.usageMode === "read_write" &&
              (membership === undefined ||
                !["editor", "admin", "owner"].includes(membership.role))
            ) {
              return Object.freeze({ kind: "writer_access_required" });
            }
            let owner = owners.get(request.principalId);
            if (owner !== undefined) {
              const replay = replayPrincipalMindUsageMutation(owner, request);
              if (replay !== null) return replay;
            } else {
              owner = {
                state: createFreshPrincipalMindUsageState({
                  principalId: request.principalId,
                  occurredAt: request.occurredAt,
                }),
                retiredGenerationIds: new Set(),
                idempotency: new Map(),
              };
            }
            const currentMode = owner.state.entries.find(
              (entry) => entry.spaceId === request.spaceId,
            )?.usageMode ?? "disabled";
            if (
              request.usageMode === "read_write" &&
              currentMode !== "read_write" &&
              generationUsed(request.generationId)
            ) return Object.freeze({ kind: "generation_conflict" });
            const transition = setPrincipalMindUsageMode(owner.state, {
              principalId: request.principalId,
              spaceId: request.spaceId,
              usageMode: request.usageMode,
              expectedUsageVersion: request.expectedUsageVersion,
              generationId: request.generationId,
              authority: {
                canRead,
                currentRole: membership?.role ?? null,
                description: space.description ?? null,
                routingProfile: isOwnPersonal
                  ? "personal_default" as const
                  : "description_based" as const,
              },
              occurredAt: request.occurredAt,
            });
            if (transition.kind !== "applied") {
              return Object.freeze({ kind: transition.kind === "principal_mismatch"
                ? "invalid_record"
                : transition.kind });
            }
            if (
              auditEvents.has(request.auditEventId) ||
              auditOutbox.has(request.auditOutboxMessageId) ||
              [...auditOutbox.values()].some(
                (message) => message.auditEventId === request.auditEventId,
              )
            ) return Object.freeze({ kind: "effect_conflict" });
            const previousGenerations = owner.state.entries
              .map((entry) => entry.writeGeneration)
              .filter((generation): generation is PrincipalMindWriteGeneration =>
                generation !== null
              );
            if (!owners.has(request.principalId)) {
              owners.set(request.principalId, owner);
            }
            owner.state = transition.state;
            const currentGenerationIds = new Set(
              transition.state.entries.flatMap((entry) =>
                entry.writeGeneration === null
                  ? []
                  : [entry.writeGeneration.generationId]
              ),
            );
            for (const previousGeneration of previousGenerations) {
              if (!currentGenerationIds.has(previousGeneration.generationId)) {
                owner.retiredGenerationIds.add(previousGeneration.generationId);
              }
            }
            const result = Object.freeze({
              kind: "applied" as const,
              state: transition.state,
              changed: transition.changed,
              replayed: false,
            });
            stagePrincipalMindUsageAudit(request, result, auditEvents, auditOutbox);
            recordPrincipalMindUsageMutation(owner, request, result);
            return result;
          },
        });
        const result = await operation(transaction);
        this._principalMindUsageOwners = owners;
        this._auditEvents = auditEvents;
        this._auditOutbox = auditOutbox;
        return result;
      });
    }

  async readStagedBundleFile(
      stagedFileId: StagedBundleFileId,
    ): Promise<Readonly<StagedBundleFileRecord> | null> {
      const record = this._stagedBundleFiles.get(stagedFileId);
      return record === undefined ? null : freezeStagedBundleFile(record);
    }

  async runBundleFileStagingTransaction<Result>(
      operation: (transaction: BundleFileStagingTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const stagedBundleFiles = copyOnWriteMap(this._stagedBundleFiles, cloneCopyOnWriteValue);
        const idempotencyRecords = cloneIdempotencyRecords(this._idempotencyRecords);
        const capacityReservations = cloneCapacityReservations(this._capacityReservations);
        const capacityTransaction = this._capacityTransaction(capacityReservations);
        const transaction: BundleFileStagingTransaction = Object.freeze({
          ...capacityTransaction,
          kind: "authorization-transaction" as const,
          readCredentialWriteTarget: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => this.readCredentialWriteTarget(bindingOwnerId, principalId),
          readMindBindingSet: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
            occurredAt: ApplyReadMindBindingRequest["occurredAt"],
          ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
          readPrincipalMindUsage: (principalId: PrincipalId) =>
            this.readPrincipalMindUsage(principalId),
          validatePrincipalMindUsageWritePin: (
            pin: Readonly<PrincipalMindUsageWritePin>,
          ) =>
            this.validatePrincipalMindUsageWritePin(pin),
          readCurrentAuthorizationState: (query: AuthorizationStateQuery) =>
            this.readCurrentAuthorizationState(query),
          readStagedBundleFile: async (stagedFileId: StagedBundleFileId) => {
            const record = stagedBundleFiles.get(stagedFileId);
            return record === undefined ? null : freezeStagedBundleFile(record);
          },
          createStagedBundleFile: async (
            record: Readonly<StagedBundleFileRecord>,
            maxOutstandingBytes: number,
            occurredAt: StagedBundleFileRecord["createdAt"],
          ) => createStagedBundleFileAgainst(
            record,
            maxOutstandingBytes,
            occurredAt,
            stagedBundleFiles,
          ),
          checkIdempotency: async (request: CheckIdempotencyRequest) =>
            checkIdempotencyAgainst(request, idempotencyRecords),
          completeIdempotency: async (request: CompleteIdempotencyRequest) =>
            completeIdempotencyAgainst(request, idempotencyRecords),
        });
        const result = await operation(transaction);
        this._stagedBundleFiles = stagedBundleFiles;
        this._idempotencyRecords = idempotencyRecords;
        this._capacityReservations = capacityReservations;
        return result;
      });
    }

  async collectStagedBundleFilesForGc(request: Readonly<{
      createdBefore: StagedBundleFileRecord["createdAt"];
      limit: number;
    }>): Promise<readonly Readonly<StagedBundleFileRecord>[]> {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new TypeError("staged BundleFile GC limit must be positive");
      }
      return this._runExclusive(async () => {
        const candidates = [...this._stagedBundleFiles.values()]
          .filter(
            (record) => Date.parse(record.expiresAt) <= Date.parse(request.createdBefore),
          )
          .sort((left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.stagedFileId.localeCompare(right.stagedFileId),
          )
          .slice(0, request.limit)
          .map((record) => freezeStagedBundleFile({ ...record, state: "expired" }));
        for (const record of candidates) {
          this._stagedBundleFiles.set(record.stagedFileId, record);
        }
        return Object.freeze(candidates);
      });
    }

  async deleteExpiredStagedBundleFileRecord(
      stagedFileId: StagedBundleFileId,
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._stagedBundleFiles.get(stagedFileId);
        return current?.state === "expired"
          ? this._stagedBundleFiles.delete(stagedFileId)
          : false;
      });
    }

  async runMindBindingTransaction<Result>(
      operation: (transaction: MindBindingTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const owners = cloneMindBindingOwners(this._mindBindingOwners);
        const auditEvents = copyOnWriteMap(this._auditEvents, cloneAuditEvent);
        const auditOutbox = copyOnWriteMap(this._auditOutbox, cloneAuditOutbox);
        const getOwner = (
          request: Readonly<MindBindingMutationRequest>,
        ): MutableMindBindingOwnerState | ApplyMindBindingMutationResult => {
          if (!validMindBindingMutationBase(request)) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const existing = owners.get(request.bindingOwnerId);
          if (existing && existing.bindingSet.principalId !== request.principalId) {
            return Object.freeze({ kind: "owner_mismatch" });
          }
          const state =
            existing ??
            emptyMindBindingOwnerState(
              request.bindingOwnerId,
              request.principalId,
              request.occurredAt,
            );
          if (state.bindingSet.state !== "active") {
            return Object.freeze({ kind: "binding_owner_revoked" });
          }
          return state;
        };

        const transaction: MindBindingTransaction = Object.freeze({
          kind: "authorization-transaction" as const,
          readCredentialWriteTarget: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => this.readCredentialWriteTarget(bindingOwnerId, principalId),
          readCurrentAuthorizationState: (query: AuthorizationStateQuery) =>
            this.readCurrentAuthorizationState(query),
          readMindBindingSet: async (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
            occurredAt: ApplyReadMindBindingRequest["occurredAt"],
          ) => {
            if (
              !BOUNDED_OPAQUE_ID.test(bindingOwnerId) ||
              !BOUNDED_OPAQUE_ID.test(principalId) ||
              !Number.isFinite(Date.parse(occurredAt))
            ) {
              return null;
            }
            const state = owners.get(bindingOwnerId);
            if (state && state.bindingSet.principalId !== principalId) return null;
            return mindBindingSnapshot(
              state ?? emptyMindBindingOwnerState(bindingOwnerId, principalId, occurredAt),
            );
          },
          applyReadMindBinding: async (
            request: Readonly<ApplyReadMindBindingRequest>,
          ): Promise<ApplyMindBindingMutationResult> => {
            if (
              (request.action !== "attach" && request.action !== "detach") ||
              !BOUNDED_OPAQUE_ID.test(request.spaceId) ||
              (request.action === "attach" &&
                !BOUNDED_OPAQUE_ID.test(request.readBindingId))
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const selected = getOwner(request);
            if (!("bindingSet" in selected)) return selected;
            const replay = replayMindBindingMutation(selected, "read", request);
            if (replay) return replay;
            if (
              selected.bindingSet.bindingVersion !==
              request.expectedBindingVersion
            ) {
              return Object.freeze({
                kind: "binding_version_conflict",
                currentBindingVersion: selected.bindingSet.bindingVersion,
              });
            }
            if (
              !mindBindingEffectsAvailable(
                request.auditEventId,
                request.auditOutboxMessageId,
                auditEvents,
                auditOutbox,
              )
            ) {
              return Object.freeze({ kind: "effect_conflict" });
            }
            if (!owners.has(request.bindingOwnerId)) {
              owners.set(request.bindingOwnerId, selected);
            }

            const activeId = selected.activeReadBindingBySpace.get(request.spaceId);
            let changed = false;
            if (request.action === "attach") {
              if (!activeId) {
                if (selected.readBindingsById.has(request.readBindingId)) {
                  return Object.freeze({ kind: "invalid_record" });
                }
                selected.readBindingsById.set(
                  request.readBindingId,
                  Object.freeze({
                    readBindingId: request.readBindingId,
                    bindingOwnerId: request.bindingOwnerId,
                    spaceId: request.spaceId,
                    state: "active" as const,
                    createdAt: request.occurredAt,
                    invalidatedAt: null,
                  }),
                );
                selected.activeReadBindingBySpace.set(
                  request.spaceId,
                  request.readBindingId,
                );
                changed = true;
              }
            } else if (activeId) {
              const current = selected.readBindingsById.get(activeId);
              if (!current) return Object.freeze({ kind: "invalid_record" });
              selected.readBindingsById.set(
                activeId,
                Object.freeze({
                  ...current,
                  state: "invalidated" as const,
                  invalidatedAt: request.occurredAt,
                }),
              );
              selected.activeReadBindingBySpace.delete(request.spaceId);
              changed = true;
            }

            if (changed) {
              selected.bindingSet = Object.freeze({
                ...selected.bindingSet,
                bindingVersion: bindingVersion(
                  selected.bindingSet.bindingVersion + 1,
                ),
                updatedAt: request.occurredAt,
              });
            }
            const result = Object.freeze({
              kind: "applied" as const,
              bindings: mindBindingSnapshot(selected),
              previousWriteBinding: null,
              changed,
              replayed: false,
            });
            stageMindBindingAudit(
              request,
              result,
              request.spaceId,
              auditEvents,
              auditOutbox,
            );
            recordMindBindingMutation(selected, "read", request, result);
            return result;
          },
          applyWriteMindBinding: async (
            request: Readonly<ApplyWriteMindBindingRequest>,
          ): Promise<ApplyMindBindingMutationResult> => {
            if (
              (request.action !== "bind" && request.action !== "unbind") ||
              (request.action === "bind" &&
                (!BOUNDED_OPAQUE_ID.test(request.spaceId) ||
                  !BOUNDED_OPAQUE_ID.test(request.writeBindingId))) ||
              (request.action === "unbind" &&
                (request.spaceId !== null || request.writeBindingId !== null))
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const selected = getOwner(request);
            if (!("bindingSet" in selected)) return selected;
            const replay = replayMindBindingMutation(selected, "write", request);
            if (replay) return replay;
            if (
              selected.bindingSet.bindingVersion !==
              request.expectedBindingVersion
            ) {
              return Object.freeze({
                kind: "binding_version_conflict",
                currentBindingVersion: selected.bindingSet.bindingVersion,
              });
            }
            if (
              !mindBindingEffectsAvailable(
                request.auditEventId,
                request.auditOutboxMessageId,
                auditEvents,
                auditOutbox,
              )
            ) {
              return Object.freeze({ kind: "effect_conflict" });
            }

            const active =
              selected.activeWriteBindingId === null
                ? null
                : selected.writeBindingsById.get(selected.activeWriteBindingId) ??
                  null;
            if (selected.activeWriteBindingId !== null && active === null) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (!owners.has(request.bindingOwnerId)) {
              owners.set(request.bindingOwnerId, selected);
            }
            let previous: Readonly<WriteMindBinding> | null = null;
            let changed = false;
            if (request.action === "bind") {
              if (active?.state === "active" && active.spaceId === request.spaceId) {
                // Same-target bind preserves the immutable generation.
              } else {
                if (selected.writeBindingsById.has(request.writeBindingId)) {
                  return Object.freeze({ kind: "invalid_record" });
                }
                if (active?.state === "active") {
                  previous = Object.freeze({
                    ...active,
                    state: "invalidated" as const,
                    invalidatedAt: request.occurredAt,
                  });
                  selected.writeBindingsById.set(active.writeBindingId, previous);
                }
                const nextVersion = bindingVersion(
                  selected.bindingSet.bindingVersion + 1,
                );
                const current = Object.freeze({
                  writeBindingId: request.writeBindingId,
                  bindingOwnerId: request.bindingOwnerId,
                  spaceId: request.spaceId,
                  generation: nextVersion,
                  state: "active" as const,
                  createdAt: request.occurredAt,
                  invalidatedAt: null,
                });
                selected.writeBindingsById.set(request.writeBindingId, current);
                selected.activeWriteBindingId = request.writeBindingId;
                selected.bindingSet = Object.freeze({
                  ...selected.bindingSet,
                  bindingVersion: nextVersion,
                  automaticCaptureMode: "disabled" as const,
                  captureWriteBindingId: null,
                  captureUpdatedAt:
                    selected.bindingSet.automaticCaptureMode === "disabled"
                      ? selected.bindingSet.captureUpdatedAt
                      : request.occurredAt,
                  updatedAt: request.occurredAt,
                });
                changed = true;
              }
            } else if (active?.state === "active") {
              previous = Object.freeze({
                ...active,
                state: "invalidated" as const,
                invalidatedAt: request.occurredAt,
              });
              selected.writeBindingsById.set(active.writeBindingId, previous);
              selected.activeWriteBindingId = null;
              selected.bindingSet = Object.freeze({
                ...selected.bindingSet,
                bindingVersion: bindingVersion(
                  selected.bindingSet.bindingVersion + 1,
                ),
                automaticCaptureMode: "disabled" as const,
                captureWriteBindingId: null,
                captureUpdatedAt:
                  selected.bindingSet.automaticCaptureMode === "disabled"
                    ? selected.bindingSet.captureUpdatedAt
                    : request.occurredAt,
                updatedAt: request.occurredAt,
              });
              changed = true;
            }

            const result = Object.freeze({
              kind: "applied" as const,
              bindings: mindBindingSnapshot(selected),
              previousWriteBinding: previous,
              changed,
              replayed: false,
            });
            stageMindBindingAudit(
              request,
              result,
              request.spaceId ?? previous?.spaceId ?? null,
              auditEvents,
              auditOutbox,
            );
            recordMindBindingMutation(selected, "write", request, result);
            return result;
          },
          applyAutomaticCapturePolicy: async (
            request: Readonly<ApplyAutomaticCapturePolicyRequest>,
          ): Promise<ApplyMindBindingMutationResult> => {
            if (
              (request.action !== "enable" && request.action !== "disable") ||
              (request.action === "enable" &&
                (request.mode !== "routine_non_sensitive" ||
                  !BOUNDED_OPAQUE_ID.test(request.spaceId) ||
                  !BOUNDED_OPAQUE_ID.test(request.writeBindingId))) ||
              (request.action === "disable" &&
                (request.mode !== "disabled" || request.writeBindingId !== null ||
                  (request.spaceId !== null && !BOUNDED_OPAQUE_ID.test(request.spaceId))))
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const selected = getOwner(request);
            if (!("bindingSet" in selected)) return selected;
            const replay = replayMindBindingMutation(selected, "capture", request);
            if (replay) return replay;
            if (selected.bindingSet.bindingVersion !== request.expectedBindingVersion) {
              return Object.freeze({
                kind: "binding_version_conflict",
                currentBindingVersion: selected.bindingSet.bindingVersion,
              });
            }
            if (
              !mindBindingEffectsAvailable(
                request.auditEventId,
                request.auditOutboxMessageId,
                auditEvents,
                auditOutbox,
              )
            ) {
              return Object.freeze({ kind: "effect_conflict" });
            }
            const active = selected.activeWriteBindingId === null
              ? null
              : selected.writeBindingsById.get(selected.activeWriteBindingId) ?? null;
            if (
              request.action === "enable" &&
              (active?.state !== "active" ||
                active.spaceId !== request.spaceId ||
                active.writeBindingId !== request.writeBindingId)
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (!owners.has(request.bindingOwnerId)) owners.set(request.bindingOwnerId, selected);
            const changed = request.action === "enable"
              ? selected.bindingSet.automaticCaptureMode !== request.mode ||
                selected.bindingSet.captureWriteBindingId !== request.writeBindingId
              : selected.bindingSet.automaticCaptureMode !== "disabled" ||
                selected.bindingSet.captureWriteBindingId !== null;
            if (changed) {
              selected.bindingSet = Object.freeze({
                ...selected.bindingSet,
                bindingVersion: bindingVersion(selected.bindingSet.bindingVersion + 1),
                automaticCaptureMode: request.mode,
                captureWriteBindingId:
                  request.action === "enable" ? request.writeBindingId : null,
                captureUpdatedAt: request.occurredAt,
                updatedAt: request.occurredAt,
              });
            }
            const result = Object.freeze({
              kind: "applied" as const,
              bindings: mindBindingSnapshot(selected),
              previousWriteBinding: null,
              changed,
              replayed: false,
            });
            stageMindBindingAudit(
              request,
              result,
              request.spaceId,
              auditEvents,
              auditOutbox,
            );
            recordMindBindingMutation(selected, "capture", request, result);
            return result;
          },
        });

        const result = await operation(transaction);
        this._mindBindingOwners = owners;
        this._auditEvents = auditEvents;
        this._auditOutbox = auditOutbox;
        return result;
      });
    }

  async revokeMindBindingOwner(
      request: Readonly<RevokeMindBindingOwnerRequest>,
    ): Promise<RevokeMindBindingOwnerResult> {
      return this._runExclusive(async () => {
        if (
          !BOUNDED_OPAQUE_ID.test(request.bindingOwnerId) ||
          !BOUNDED_OPAQUE_ID.test(request.principalId) ||
          !BOUNDED_OPAQUE_ID.test(request.requestId) ||
          !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
          !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
          !Number.isFinite(Date.parse(request.occurredAt))
        ) {
          return Object.freeze({ kind: "invalid_record" });
        }
        const state = this._mindBindingOwners.get(request.bindingOwnerId);
        if (!state) return Object.freeze({ kind: "not_found" });
        if (state.bindingSet.principalId !== request.principalId) {
          return Object.freeze({ kind: "owner_mismatch" });
        }
        if (state.bindingSet.state !== "active") {
          return Object.freeze({
            kind: "revoked",
            invalidatedReadBindings: 0,
            invalidatedWriteBindings: 0,
            replayed: true,
          });
        }
        if (
          !mindBindingEffectsAvailable(
            request.auditEventId,
            request.auditOutboxMessageId,
            this._auditEvents,
            this._auditOutbox,
          )
        ) {
          return Object.freeze({ kind: "effect_conflict" });
        }
        const invalidatedReadBindings = state.activeReadBindingBySpace.size;
        for (const id of state.activeReadBindingBySpace.values()) {
          const current = state.readBindingsById.get(id);
          if (current) {
            state.readBindingsById.set(
              id,
              Object.freeze({
                ...current,
                state: "invalidated" as const,
                invalidatedAt: request.occurredAt,
              }),
            );
          }
        }
        state.activeReadBindingBySpace.clear();
        let invalidatedWriteBindings = 0;
        if (state.activeWriteBindingId !== null) {
          const current = state.writeBindingsById.get(state.activeWriteBindingId);
          if (current) {
            state.writeBindingsById.set(
              current.writeBindingId,
              Object.freeze({
                ...current,
                state: "invalidated" as const,
                invalidatedAt: request.occurredAt,
              }),
            );
            invalidatedWriteBindings = 1;
          }
        }
        state.activeWriteBindingId = null;
        state.bindingSet = Object.freeze({
          ...state.bindingSet,
          state: "revoked" as const,
          bindingVersion: bindingVersion(state.bindingSet.bindingVersion + 1),
          automaticCaptureMode: "disabled" as const,
          captureWriteBindingId: null,
          captureUpdatedAt:
            state.bindingSet.automaticCaptureMode === "disabled"
              ? state.bindingSet.captureUpdatedAt
              : request.occurredAt,
          updatedAt: request.occurredAt,
        });
        stageMindBindingRevokeAudit(
          request,
          invalidatedReadBindings,
          invalidatedWriteBindings,
          state.bindingSet.bindingVersion,
          this._auditEvents,
          this._auditOutbox,
        );
        return Object.freeze({
          kind: "revoked",
          invalidatedReadBindings,
          invalidatedWriteBindings,
          replayed: false,
        });
      });
    }

  /** Exposes bounded projection work for deterministic adapter integration tests. */
  inspectProjectionVisitsForTest(): Readonly<{
    readonly revisionCatalog: number;
    readonly revisionAsOf: number;
    readonly capacityCanonicalKeys: number;
  }> {
    return Object.freeze({
      revisionCatalog: this._revisionCatalogVisits,
      revisionAsOf: this._revisionAsOfVisits,
      capacityCanonicalKeys: this._capacityCanonicalKeyVisits,
    });
  }

  resetProjectionVisitsForTest(): void {
    this._revisionCatalogVisits = 0;
    this._revisionAsOfVisits = 0;
    this._capacityCanonicalKeyVisits = 0;
  }

  async readHead(spaceId: SpaceId): Promise<RevisionId | null> {
      return this._spaces.get(spaceId)?.head ?? null;
    }

  async readRevision(
      spaceId: SpaceId,
      revisionId: RevisionId,
    ): Promise<Envelope | null> {
      const envelope = this._spaces.get(spaceId)?.revisions.get(revisionId);
      return envelope === undefined ? null : cloneEnvelope(envelope);
    }

  async listRevisions(spaceId: SpaceId): Promise<readonly Envelope[]> {
      const revisions = [...(this._spaces.get(spaceId)?.revisions.values() ?? [])];
      revisions.sort(
        (left, right) =>
          left.revision.revisionNumber - right.revision.revisionNumber,
      );
      return Object.freeze(revisions.map(cloneEnvelope));
    }

  async listRevisionCatalog(
      spaceId: SpaceId,
      query: Readonly<{ beforeRevisionId: RevisionId | null; limit: number }>,
    ) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
        throw new TypeError("revision catalog limit must be positive");
      }
      const state = this._spaces.get(spaceId);
      if (state !== undefined) ensureSpaceRevisionProjections(spaceId, state);
      const catalog = state?.revisionCatalog;
      const revisionIdsByNumber = state?.revisionIdsByNumber;
      if (state !== undefined) {
        if (state.revisions.size === 0) {
          if (state.head !== null) revisionProjectionIntegrityFailure();
        } else {
          if (state.head === null || catalog === undefined || revisionIdsByNumber === undefined) {
            revisionProjectionIntegrityFailure();
          }
          const headEnvelope = state.revisions.get(state.head);
          const headEntry = catalog.get(state.head);
          if (
            headEnvelope === undefined || headEntry === undefined ||
            headEntry.revision.revisionNumber !== state.revisions.size ||
            revisionIdsByNumber.get(headEntry.revision.revisionNumber) !== state.head ||
            !revisionCatalogEntryMatchesEnvelope(headEntry, headEnvelope)
          ) revisionProjectionIntegrityFailure();
        }
      }
      let startNumber: number;
      let previousNewer: Readonly<RevisionCatalogEntry>["revision"] | null = null;
      if (query.beforeRevisionId !== null) {
        const boundary = catalog?.get(query.beforeRevisionId);
        if (boundary === undefined) {
          if (state?.revisions.has(query.beforeRevisionId) === true) {
            revisionProjectionIntegrityFailure();
          }
          return Object.freeze({
            entries: Object.freeze([]),
            hasMore: false,
            boundaryFound: false,
          });
        }
        const boundaryEnvelope = state?.revisions.get(query.beforeRevisionId);
        if (
          boundaryEnvelope === undefined ||
          revisionIdsByNumber?.get(boundary.revision.revisionNumber) !== query.beforeRevisionId ||
          !revisionCatalogEntryMatchesEnvelope(boundary, boundaryEnvelope)
        ) revisionProjectionIntegrityFailure();
        startNumber = boundary.revision.revisionNumber - 1;
        previousNewer = boundary.revision;
      } else {
        const head = state?.head === null || state?.head === undefined
          ? undefined
          : catalog?.get(state.head);
        startNumber = head?.revision.revisionNumber ?? 0;
      }
      // The revision chain is contiguous, so an addressable number map lets
      // this keyset page visit only limit + 1 catalog rows.
      const page: Readonly<RevisionCatalogEntry>[] = [];
      for (
        let revisionNumber = startNumber;
        revisionNumber > 0 && page.length <= query.limit;
        revisionNumber -= 1
      ) {
        const revisionId = revisionIdsByNumber?.get(revisionNumber);
        if (revisionId === undefined) revisionProjectionIntegrityFailure();
        const entry = catalog?.get(revisionId);
        const envelope = state?.revisions.get(revisionId);
        if (
          entry === undefined || envelope === undefined ||
          entry.revision.revisionNumber !== revisionNumber ||
          !revisionCatalogEntryMatchesEnvelope(entry, envelope) ||
          (previousNewer !== null && previousNewer.parentRevisionId !== revisionId) ||
          (revisionNumber === 1 && entry.revision.parentRevisionId !== null)
        ) revisionProjectionIntegrityFailure();
        this._revisionCatalogVisits += 1;
        page.push(entry);
        previousNewer = entry.revision;
      }
      const hasMore = page.length > query.limit;
      const selectedPage = page.slice(0, query.limit);
      return Object.freeze({
        entries: Object.freeze(selectedPage.map(cloneRevisionCatalogEntry)),
        hasMore,
        boundaryFound: true,
      });
    }

  async resolveRevisionAsOf(spaceId: SpaceId, asOf: UtcInstant) {
      const normalizedAsOf = normalizedUtcInstant(asOf);
      const state = this._spaces.get(spaceId);
      if (state !== undefined) ensureSpaceRevisionProjections(spaceId, state);
      const index = state?.revisionAsOfIndex ?? [];
      const catalog = state?.revisionCatalog;
      const verifyIndexEntry = (position: number): void => {
        const indexed = index[position];
        if (indexed === undefined || state === undefined || catalog === undefined) {
          revisionProjectionIntegrityFailure();
        }
        const envelope = state.revisions.get(indexed.revisionId);
        const catalogEntry = catalog.get(indexed.revisionId);
        if (
          envelope === undefined || catalogEntry === undefined ||
          indexed.committedAt !== normalizedUtcInstant(envelope.revision.committedAt) ||
          indexed.revisionNumber !== envelope.revision.revisionNumber ||
          state.revisionIdsByNumber?.get(indexed.revisionNumber) !== indexed.revisionId ||
          !revisionCatalogEntryMatchesEnvelope(catalogEntry, envelope) ||
          (position > 0 && compareRevisionAsOfIndexEntries(index[position - 1]!, indexed) > 0) ||
          (position + 1 < index.length && compareRevisionAsOfIndexEntries(indexed, index[position + 1]!) > 0)
        ) revisionProjectionIntegrityFailure();
      };
      if (state !== undefined) {
        if (
          index.length !== state.revisions.size ||
          (state.revisions.size === 0 && state.head !== null) ||
          (state.revisions.size > 0 && state.head === null)
        ) revisionProjectionIntegrityFailure();
      }
      let low = 0;
      let high = index.length;
      // Upper-bound search selects the last row at or before the instant. The
      // index's tie order makes equal timestamps deterministic by revision
      // number, then revision ID.
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        verifyIndexEntry(middle);
        this._revisionAsOfVisits += 1;
        if (index[middle]!.committedAt <= normalizedAsOf) low = middle + 1;
        else high = middle;
      }
      if (low === 0) return null;
      verifyIndexEntry(low - 1);
      const selected = catalog?.get(index[low - 1]!.revisionId);
      if (selected === undefined) revisionProjectionIntegrityFailure();
      return cloneRevisionCatalogEntry(selected);
    }

  async readAccount(
      principalId: Principal["principalId"],
    ): Promise<Readonly<PrincipalAccountSnapshot> | null> {
      return accountFromMaps(
        principalId,
        this._principals,
        this._externalBindings,
        this._knowledgeSpaces,
        this._personalBindings,
        this._memberships,
      );
    }

  async readAccountByExternalBinding(
      lookup: Readonly<ExternalIdentityBindingLookup>,
    ): Promise<Readonly<PrincipalAccountSnapshot> | null> {
      return accountByBindingFromMaps(
        lookup,
        this._principals,
        this._externalBindings,
        this._knowledgeSpaces,
        this._personalBindings,
        this._memberships,
      );
    }

  async resolvePersonalMind(
      principalId: Principal["principalId"],
    ): Promise<Readonly<PersonalMindResolution> | null> {
      try {
        const account = accountFromMaps(
          principalId,
          this._principals,
          this._externalBindings,
          this._knowledgeSpaces,
          this._personalBindings,
          this._memberships,
        );
        if (account === null || account.personalMind.space.state !== "active") {
          return null;
        }
        return Object.freeze({
          spaceId: account.personalMind.space.spaceId,
          headRevisionId: account.personalMind.space.headRevisionId,
        });
      } catch {
        return null;
      }
    }

  async listActiveMembershipMindIds(
      principalId: Principal["principalId"],
    ): Promise<readonly SpaceId[]> {
      const principal = this._principals.get(principalId);
      if (!principal || principal.state !== "active") return Object.freeze([]);
      const personalSpaceId = this._personalBindings.get(principalId)?.spaceId;
      return Object.freeze(
        [...new Set(
          [...this._memberships.values()]
            .filter(
              (membership) =>
                membership.principalId === principalId &&
                membership.state === "active" &&
                membership.spaceId !== personalSpaceId,
            )
            .map((membership) => membership.spaceId),
        )].sort(),
      );
    }

  async readMembershipMutationReplay(
      request: Readonly<MembershipMutationReplayRequest>,
    ): Promise<MembershipMutationReplayResult> {
      return readMembershipReplay(this._membershipMutationRecords, request);
    }

  async listControlMembers(
      spaceId: SpaceId,
    ): Promise<readonly Readonly<ControlMemberProjection>[]> {
      const space = this._knowledgeSpaces.get(spaceId);
      if (!space || space.state !== "active") return Object.freeze([]);
      return Object.freeze(
        [...this._memberships.values()]
          .filter((membership) => membership.spaceId === spaceId)
          .map((membership) => {
            const principal = this._principals.get(membership.principalId);
            if (!principal) return null;
            return Object.freeze({
              memberId: membership.membershipId,
              principalId: membership.principalId,
              displayName: principal.displayName,
              role: membership.role,
              state: membership.state,
              membershipVersion: membership.version,
            });
          })
          .filter(
            (projection): projection is Readonly<ControlMemberProjection> =>
              projection !== null,
          )
          .sort((left, right) =>
            left.memberId.localeCompare(right.memberId, "en"),
          ),
      );
    }

  async listControlInvitations(
      principalId: PrincipalId,
    ): Promise<readonly Readonly<ControlInvitationProjection>[]> {
      const principal = this._principals.get(principalId);
      if (!principal || principal.state !== "active") return Object.freeze([]);
      return Object.freeze(
        [...this._invitations.values()]
          .filter(
            (invitation) =>
              invitation.targetPrincipalId === principalId ||
              invitation.createdBy === principalId,
          )
          .map((invitation) => {
            const outgoing = invitation.createdBy === principalId;
            const counterpartyId = outgoing
              ? invitation.targetPrincipalId
              : invitation.createdBy;
            const counterparty = this._principals.get(counterpartyId);
            const mind = this._knowledgeSpaces.get(invitation.spaceId);
            if (!counterparty || !mind || mind.state !== "active") return null;
            return Object.freeze({
              invitationId: invitation.invitationId,
              mindId: invitation.spaceId,
              mindName: mind.name,
              mindRoute: `/${mind.spaceHandle}` as const,
              direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
              counterpartyPrincipalId: counterpartyId,
              counterpartyDisplayName: counterparty.displayName,
              proposedRole: invitation.proposedRole,
              state: invitation.state,
              invitationVersion: invitation.version,
              expiresAt: invitation.expiresAt,
            });
          })
          .filter(
            (projection): projection is Readonly<ControlInvitationProjection> =>
              projection !== null,
          )
          .sort((left, right) =>
            left.invitationId.localeCompare(right.invitationId, "en"),
          ),
      );
    }

  async listPublicMindCatalogPage(
      request: Readonly<PublicMindCatalogPageRequest>,
    ): Promise<PublicMindCatalogPageResult> {
      if (
        typeof request !== "object" ||
        request === null ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 100
      ) {
        return Object.freeze({ kind: "invalid_cursor" });
      }
      const decoded =
        request.cursor === null
          ? Object.freeze({
              v: 1 as const,
              q: PUBLIC_CATALOG_CURSOR_QUERY,
              g: this._publicMindCatalogGeneration,
              o: 0,
            })
          : typeof request.cursor === "string"
            ? decodePublicCatalogCursor(request.cursor)
            : null;
      if (decoded === null) return Object.freeze({ kind: "invalid_cursor" });
      const snapshot = this._publicMindCatalogSnapshots.get(decoded.g);
      if (snapshot === undefined || decoded.o > snapshot.length) {
        return Object.freeze({ kind: "invalid_cursor" });
      }
      const end = Math.min(decoded.o + request.limit, snapshot.length);
      return Object.freeze({
        kind: "page",
        spaceIds: Object.freeze(snapshot.slice(decoded.o, end)),
        nextCursor:
          end < snapshot.length
            ? encodePublicCatalogCursor(decoded.g, end)
            : null,
      });
    }

  async readResolvedSpace(
      spaceId: SpaceId,
    ): Promise<Readonly<OrdinaryMindRouteSnapshot> | null> {
      return this._ordinaryMindRouteSnapshot(spaceId);
    }

  async readResolvedSpaces(
      spaceIds: readonly SpaceId[],
    ): Promise<readonly (Readonly<OrdinaryMindRouteSnapshot> | null)[]> {
      if (!Array.isArray(spaceIds)) return Object.freeze([]);
      return Object.freeze(
        spaceIds.map((spaceId) => this._ordinaryMindRouteSnapshot(spaceId)),
      );
    }

  async readPersonalMindProfile(
      principalId: Principal["principalId"],
    ): Promise<Readonly<PersonalMindProfileSnapshot> | null> {
      try {
        const account = accountFromMaps(
          principalId,
          this._principals,
          this._externalBindings,
          this._knowledgeSpaces,
          this._personalBindings,
          this._memberships,
        );
        return account === null ? null : personalMindProfileFromAccount(account);
      } catch {
        return null;
      }
    }

  async classifyPersonalMindTarget(
      request: PersonalMindTargetRequest,
    ): Promise<PersonalMindTargetClassification> {
      const target = this._knowledgeSpaces.get(request.spaceId);
      if (!target || target.state !== "active") {
        return Object.freeze({ kind: "not_found" });
      }
      const personalBinding = [...this._personalBindings.values()].find(
        (binding) => binding.spaceId === request.spaceId,
      );
      if (!personalBinding) {
        return Object.freeze({ kind: "ordinary", spaceId: request.spaceId });
      }
      if (personalBinding.principalId !== request.principalId) {
        return Object.freeze({ kind: "not_found" });
      }
      const account = await this.readAccount(request.principalId);
      if (
        account === null ||
        account.personalMind.personalBinding?.spaceId !== request.spaceId
      ) {
        return Object.freeze({ kind: "not_found" });
      }
      return Object.freeze({ kind: "own_personal", spaceId: request.spaceId });
    }

  async reserveHandle(
      request: HandleReservationRequest,
    ): Promise<HandleReservationResult> {
      return this._runExclusive(async () =>
        reserveHandleAgainst(request, {
          activeByHandle: this._activeHandlesByKey,
          activeBySpace: this._activeHandlesBySpace,
          retired: this._retiredHandles,
        }),
      );
    }

  async resolveHandle(
      request: HandleResolutionRequest,
    ): Promise<HandleResolutionResult> {
      return resolveHandleAgainst(request, {
        activeByHandle: this._activeHandlesByKey,
      });
    }

  async retireHandle(
      request: HandleRetirementRequest,
    ): Promise<HandleRetirementResult> {
      return this._runExclusive(async () =>
        retireHandleAgainst(request, {
          activeByHandle: this._activeHandlesByKey,
          activeBySpace: this._activeHandlesBySpace,
          retired: this._retiredHandles,
        }),
      );
    }

  async readAccountDeletionContext(
      principalId: Principal["principalId"],
      impactId: string,
    ): Promise<Readonly<AccountDeletionContext> | null> {
      const impact = this._accountDeletionImpacts.get(impactId);
      if (impact?.principalId === principalId) {
        return Object.freeze({
          kind: "impact",
          impact: cloneAccountDeletionImpact(impact),
        });
      }
      const cleanup = this._accountDeletionCleanup.get(impactId);
      if (cleanup?.principalId === principalId) {
        return Object.freeze({
          kind: "cleanup",
          cleanup: cloneAccountDeletionCleanup(cleanup),
        });
      }
      return null;
    }

  async readCurrentAuthorizationState(
      query: AuthorizationStateQuery,
    ): Promise<AuthorizationState | null> {
      if (query.tokenId === null) {
        const current = this._currentSitesAuthorizationState(query);
        if (current !== null) return current;
      }
      const state = this._authorizationStates.get(authorizationStateKey(query));
      return state ? cloneAuthorizationState(state) : null;
    }

  async readCurrentAuthorizationStates(
      queries: readonly AuthorizationStateQuery[],
    ): Promise<readonly (AuthorizationState | null)[]> {
      if (!Array.isArray(queries)) return Object.freeze([]);
      return Object.freeze(
        queries.map((query) => {
          if (query === null || typeof query !== "object") return null;
          if (query.tokenId === null) {
            const current = this._currentSitesAuthorizationState(query);
            if (current !== null) return current;
          }
          const state = this._authorizationStates.get(authorizationStateKey(query));
          return state ? cloneAuthorizationState(state) : null;
        }),
      );
    }

  async readCurrentRouteAuthorizationState(
      query: MindRouteAuthorizationQuery,
    ): Promise<AuthorizationState | null> {
      const parsed = parseCanonicalSpaceHandle(query.handle);
      const snapshot = this._ordinaryMindRouteSnapshot(query.spaceId);
      if (
        parsed.kind !== "valid" ||
        isReservedTopLevelHandle(parsed.canonicalHandle) ||
        !snapshot ||
        snapshot.host !== query.host ||
        snapshot.canonicalHandle !== parsed.canonicalHandle
      ) {
        return null;
      }
      return this._currentSitesAuthorizationState({
        principalId: query.principalId,
        spaceId: query.spaceId,
        tokenId: query.tokenId,
      });
    }
}
