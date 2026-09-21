import type {
  ActiveHandleByKeyMap,
  ActiveHandleBySpaceMap,
  RetiredHandleMap,
} from "./handle-registry.js";
import type {
  AccountBootstrapFailureStage,
  AccountDeletionCleanupMap,
  AccountDeletionFailureStage,
  AccountDeletionImpactMap,
  AuditEventId,
  AuthorizationState,
  CompletedIdempotencyRecord,
  Digest,
  Envelope,
  ExternalBindingMap,
  InvitationMap,
  KnowledgeSpaceMap,
  MembershipMap,
  MutableCredentialWriteTargetOwnerState,
  MutableMindBindingOwnerState,
  MutablePrincipalMindUsageOwnerState,
  ObjectReachabilityCounts,
  OrdinaryMindDeletionCleanupMap,
  OrdinaryMindDeletionImpactMap,
  OrdinaryMindFailureStage,
  OrdinaryMindIdempotencyRecord,
  OutboxMessageId,
  PersonalBindingMap,
  PersonalProfileFailureStage,
  PersonalProfileIdempotencyRecord,
  PrincipalMap,
  RevisionId,
  SpaceId,
  SpaceState,
} from "./metadata-store-internals.js";
import type {
  AuditEvent,
  QueuedNote,
  AuditOutboxMessage,
  AuthorizationStateQuery,
  BackgroundJob,
  BundleFileDownloadGrant,
  CapacityAdmissionRequest,
  CapacityAdmissionResult,
  CapacityLimits,
  CapacityReservation,
  CapacityReservationTransaction,
  CapacityUsageSnapshot,
  ExportDownloadGrant,
  ExportJob,
  JobId,
  LegacyCredentialWriteTargetUpgradeSnapshot,
  MarkdownImportPlan,
  MarkdownImportSession,
  MarkdownImportStagedFile,
  MembershipMutationReplayRequest,
  MembershipMutationReplayResult,
  MindBindingOwnerId,
  ObjectCleanupCheckpoint,
  OrdinaryMindRouteSnapshot,
  PrincipalActivitySummary,
  PrincipalId,
  RevisionCommitRequest,
  RevisionCommitResult,
  RevisionIndexState,
  SpaceMembership,
  StagedBundleFileId,
  StagedBundleFileRecord,
  UtcInstant,
} from "@mind-diary/application-ports";
import {
  handleKey,
} from "./handle-registry.js";
import {
  SHA256_PATTERN,
  activeReservationAmounts,
  canonicalManifestSource,
  canonicalKeysForEnvelope,
  capacityOwnerForSpace,
  capacityReservationMatches,
  canonicalCapacityUsageForSpace,
  capacityUsageFromCanonicalLedger,
  cloneCapacityReservation,
  cloneEnvelope,
  currentSitesAuthorizationStateFromMaps,
  ensureSpaceRevisionProjections,
  envelopesEqual,
  freezeKnowledgeSpace,
  insertRevisionAsOfIndexEntry,
  maxUtilizationState,
  normalizedUtcInstant,
  ordinaryMindSnapshotFromMaps,
  ownedCapacitySpaceIds,
  revisionCatalogEntryFromEnvelope,
  sha256,
  validCapacityAdmissionRequest,
  validCapacityAmounts,
} from "./metadata-store-internals.js";
import {
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
} from "@mind-diary/application-ports";
import {
  newCopyOnWriteStats,
  type CopyOnWriteStats,
  isCopyOnWriteMap,
} from "./copy-on-write.js";

export abstract class RevisionMetadataStoreState {
  readonly kind = "metadata-store" as const;

  /** Shared instrumentation for the persistent roots descended from this state. */
  protected _copyOnWriteStats: CopyOnWriteStats = newCopyOnWriteStats();

  protected _spaceStates = new Map<SpaceId, SpaceState>();

  /**
   * Transaction boundaries replace the complete Space map. Rebuild missing
   * projections at that boundary so delete/account-cascade rewrites cannot
   * leave a later history read with a manifest-scan fallback.
   */
  protected get _spaces(): Map<SpaceId, SpaceState> {
    return this._spaceStates;
  }

  protected set _spaces(value: Map<SpaceId, SpaceState>) {
    if (!isCopyOnWriteMap(value)) {
      for (const [spaceId, state] of value) {
        ensureSpaceRevisionProjections(spaceId, state);
      }
    }
    this._spaceStates = value;
  }

  protected _revisionsById = new Map<RevisionId, Envelope>();

  protected _reachabilityCounts: Readonly<ObjectReachabilityCounts> | null = null;

  protected _idempotencyRecords = new Map<string, CompletedIdempotencyRecord>();

  protected _auditEvents = new Map<AuditEventId, Readonly<AuditEvent>>();

  protected _auditOutbox = new Map<OutboxMessageId, Readonly<AuditOutboxMessage>>();

  protected _backgroundJobs = new Map<JobId, Readonly<BackgroundJob>>();
  protected _queuedNotes = new Map<string, Readonly<QueuedNote>>();

  protected _exportJobs = new Map<JobId, Readonly<ExportJob>>();

  protected _exportDownloadGrants = new Map<string, Readonly<ExportDownloadGrant>>();

  protected _bundleFileDownloadGrants = new Map<string, Readonly<BundleFileDownloadGrant>>();

  protected _indexStates = new Map<string, Readonly<RevisionIndexState>>();

  protected _revisionIndexRecoveryCursor = 0;

  /** Test-only deterministic counters for bounded projection reads. */
  protected _revisionCatalogVisits = 0;

  protected _revisionAsOfVisits = 0;

  protected _capacityCanonicalKeyVisits = 0;

  protected _stagedBundleFiles = new Map<StagedBundleFileId, Readonly<StagedBundleFileRecord>>();

  protected _markdownImportPlans = new Map<string, Readonly<MarkdownImportPlan>>();

  protected _markdownImportSessions = new Map<string, Readonly<MarkdownImportSession>>();

  protected _markdownImportStagedFiles = new Map<
      StagedBundleFileId,
      Readonly<MarkdownImportStagedFile>
    >();

  protected _markdownImportPlanKeys = new Map<string, string>();

  protected _markdownImportSessionKeys = new Map<string, string>();

  protected _markdownImportBatchHashes = new Map<string, string>();

  protected _capacityReservations = new Map<string, Readonly<CapacityReservation>>();

  protected _capacityReconciledAt = new Map<SpaceId, UtcInstant>();

  protected _capacityUsageLedger = new Map<SpaceId, Readonly<CapacityUsageSnapshot>>();

  protected _capacityQuotaRejects = 0;

  protected _objectCleanupCheckpoint: Readonly<ObjectCleanupCheckpoint> | null = null;

  protected _principals: PrincipalMap = new Map();

  protected _principalActivities = new Map<
      PrincipalId,
      Readonly<PrincipalActivitySummary>
    >();

  protected _externalBindings: ExternalBindingMap = new Map();

  protected _knowledgeSpaces: KnowledgeSpaceMap = new Map();

  protected _personalBindings: PersonalBindingMap = new Map();

  protected _memberships: MembershipMap = new Map();

  protected _invitations: InvitationMap = new Map();

  protected _personalProfileIdempotencyRecords = new Map<
      string,
      Readonly<PersonalProfileIdempotencyRecord>
    >();

  protected _ordinaryMindIdempotencyRecords = new Map<
      string,
      Readonly<OrdinaryMindIdempotencyRecord>
    >();

  protected _membershipMutationRecords = new Map<
      string,
      Readonly<{
        canonicalRequestHash: MembershipMutationReplayRequest["canonicalRequestHash"];
        membership: Readonly<SpaceMembership>;
        changed: boolean;
        requiredCapability: Extract<
          MembershipMutationReplayResult,
          { readonly kind: "replayed" }
        >["requiredCapability"];
      }>
    >();

  protected _ordinaryMindDeletionImpacts: OrdinaryMindDeletionImpactMap = new Map();

  protected _ordinaryMindDeletionCleanup: OrdinaryMindDeletionCleanupMap = new Map();

  protected _accountDeletionImpacts: AccountDeletionImpactMap = new Map();

  protected _accountDeletionCleanup: AccountDeletionCleanupMap = new Map();

  protected _mindBindingOwners = new Map<
      MindBindingOwnerId,
      MutableMindBindingOwnerState
    >();

  protected _credentialWriteTargetOwners = new Map<
      MindBindingOwnerId,
      MutableCredentialWriteTargetOwnerState
    >();

  protected _legacyCredentialWriteTargetUpgrades = new Map<
      MindBindingOwnerId,
      Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>
  >();

  protected _principalMindUsageOwners = new Map<
      PrincipalId,
      MutablePrincipalMindUsageOwnerState
    >();

  protected _activeHandlesByKey: ActiveHandleByKeyMap = new Map();

  protected _activeHandlesBySpace: ActiveHandleBySpaceMap = new Map();

  protected _retiredHandles: RetiredHandleMap = new Map();

  protected _publicMindCatalogGeneration = 0;

  protected _publicMindCatalogSpaceIds = new Set<SpaceId>();

  protected _publicMindCatalogSnapshots = new Map<number, readonly SpaceId[]>([
      [0, Object.freeze([])],
    ]);

  protected _authorizationStates = new Map<string, AuthorizationState>();

  protected _transactionTail: Promise<void> = Promise.resolve();

  protected _nextCommitFailure: Error | null = null;

  protected _nextAccountBootstrapFailureStage: AccountBootstrapFailureStage | null = null;

  protected _nextPersonalProfileFailureStage: PersonalProfileFailureStage | null = null;

  protected _nextOrdinaryMindFailureStage: OrdinaryMindFailureStage | null = null;

  protected _nextAccountDeletionFailureStage: AccountDeletionFailureStage | null = null;

  protected _capacityTransaction(
      reservations: Map<string, Readonly<CapacityReservation>>,
    ): CapacityReservationTransaction {
      return Object.freeze({
        readCapacityReservation: async (reservationId: string) => {
          const reservation = reservations.get(reservationId);
          return reservation === undefined ? null : cloneCapacityReservation(reservation);
        },
        admitCapacityReservation: async (
          request: Readonly<CapacityAdmissionRequest>,
          limits: Readonly<CapacityLimits>,
        ): Promise<CapacityAdmissionResult> => {
          if (!validCapacityAdmissionRequest(request)) {
            return Object.freeze({
              kind: "rejected",
              reason: "invalid_request",
              utilization: "normal",
            });
          }
          const existing = reservations.get(request.reservationId);
          if (existing !== undefined) {
            if (!capacityReservationMatches(existing, request)) {
              return Object.freeze({
                  kind: "rejected",
                  reason: "idempotency_conflict",
                  utilization: "normal",
                });
            }
            const expiredActive = existing.state === "active" &&
              Date.parse(existing.expiresAt) <= Date.parse(request.createdAt);
            const resumableCommit = request.operation === "commit" &&
              (existing.state === "cleanup_pending" || expiredActive);
            if ((existing.state === "cleanup_pending" || expiredActive) && !resumableCommit) {
              this._capacityQuotaRejects += 1;
              return Object.freeze({
                kind: "rejected",
                reason: "accounting_untrusted",
                utilization: "normal",
              });
            }
            if (existing.state === "released" || resumableCommit) {
              const reacquired = cloneCapacityReservation(Object.freeze({
                ...existing,
                actual: null,
                state: "active" as const,
                createdAt: request.createdAt,
                expiresAt: request.expiresAt,
                updatedAt: request.createdAt,
              }));
              reservations.set(reacquired.reservationId, reacquired);
              return Object.freeze({
                kind: "admitted",
                reservation: reacquired,
                replayed: false,
              });
            }
            return Object.freeze({
              kind: "admitted",
              reservation: cloneCapacityReservation(existing),
              replayed: true,
            });
          }
          const ownerPrincipalId = capacityOwnerForSpace(
            request.spaceId,
            this._knowledgeSpaces,
            this._memberships,
            request.requestedByPrincipalId,
          );
          if (ownerPrincipalId === null) {
            this._capacityQuotaRejects += 1;
            return Object.freeze({
              kind: "rejected",
              reason: "owner_not_found",
              utilization: "normal",
            });
          }
          const spaceUsage = this._capacityUsageFromLedger(
            new Set([request.spaceId]),
            { reservations },
          );
          const principalSpaceIds = new Set(ownedCapacitySpaceIds(
            ownerPrincipalId,
            this._spaces,
            this._knowledgeSpaces,
            this._memberships,
          ));
          principalSpaceIds.add(request.spaceId);
          const principalUsage = this._capacityUsageFromLedger(
            principalSpaceIds,
            { reservations },
          );
          const siteUsage = this._capacityUsageFromLedger(
            new Set(this._spaces.keys()),
            { reservations },
          );
          const spaceReserved = activeReservationAmounts(
            reservations,
            (reservation) => reservation.spaceId === request.spaceId,
          );
          const principalReserved = activeReservationAmounts(
            reservations,
            (reservation) => principalSpaceIds.has(reservation.spaceId),
          );
          const siteReserved = activeReservationAmounts(reservations, () => true);

          const currentRatios = [
            (spaceUsage.physicalCanonicalBytes + spaceReserved.physicalCanonicalBytes) /
              limits.mindPhysicalCanonicalBytes,
            (principalUsage.physicalCanonicalBytes + principalReserved.physicalCanonicalBytes) /
              limits.principalPhysicalCanonicalBytes,
            (siteUsage.physicalCanonicalBytes + siteReserved.physicalCanonicalBytes) /
              limits.sitePhysicalCanonicalBytes,
            (siteUsage.temporaryBytes + siteReserved.temporaryBytes) /
              limits.siteTemporaryBytes,
            (siteUsage.d1MetadataBytes + siteReserved.d1MetadataBytes) /
              limits.siteD1MetadataBytes,
          ];
          const projectedRatios = [
            (spaceUsage.physicalCanonicalBytes + spaceReserved.physicalCanonicalBytes +
              request.requested.physicalCanonicalBytes) /
              limits.mindPhysicalCanonicalBytes,
            (principalUsage.physicalCanonicalBytes + principalReserved.physicalCanonicalBytes +
              request.requested.physicalCanonicalBytes) /
              limits.principalPhysicalCanonicalBytes,
            (siteUsage.physicalCanonicalBytes + siteReserved.physicalCanonicalBytes +
              request.requested.physicalCanonicalBytes) /
              limits.sitePhysicalCanonicalBytes,
            (siteUsage.temporaryBytes + siteReserved.temporaryBytes +
              request.requested.temporaryBytes) /
              limits.siteTemporaryBytes,
            (siteUsage.d1MetadataBytes + siteReserved.d1MetadataBytes +
              request.requested.d1MetadataBytes) /
              limits.siteD1MetadataBytes,
          ];
          const projectedUtilization = maxUtilizationState(projectedRatios);
          const growth = request.requested.physicalCanonicalBytes +
            request.requested.temporaryBytes + request.requested.d1MetadataBytes;
          if (request.heavy) {
            const activeHeavy = [...reservations.values()].filter(
              (reservation) => reservation.state === "active" && reservation.heavy,
            );
            if (
              activeHeavy.filter((reservation) => reservation.spaceId === request.spaceId).length >=
                limits.activeHeavyPerMind ||
              activeHeavy.filter((reservation) =>
                principalSpaceIds.has(reservation.spaceId)).length >=
                limits.activeHeavyPerPrincipal ||
              activeHeavy.length >= limits.activeHeavyPerSite
            ) {
              this._capacityQuotaRejects += 1;
              return Object.freeze({
                kind: "rejected",
                reason: "fairness_limit",
                utilization: maxUtilizationState(currentRatios),
              });
            }
          }
          if (growth > 0 && projectedRatios.some((ratio) => ratio > 1)) {
            this._capacityQuotaRejects += 1;
            return Object.freeze({
              kind: "rejected",
              reason: "hard_limit",
              utilization: projectedUtilization,
            });
          }
          const reachesSoftLimit = projectedRatios.some((ratio) => ratio >= 0.85);
          const ordinaryCommitAllowed = request.operation === "commit" &&
            !request.bulk &&
            request.requested.physicalCanonicalBytes <=
              limits.ordinaryCommitSoftGrowthBytes;
          if (growth > 0 && reachesSoftLimit && (request.bulk || !ordinaryCommitAllowed)) {
            this._capacityQuotaRejects += 1;
            return Object.freeze({
              kind: "rejected",
              reason: "soft_limit",
              utilization: projectedUtilization,
            });
          }
          const reservation = cloneCapacityReservation(Object.freeze({
            ...request,
            ownerPrincipalId,
            actual: null,
            state: "active" as const,
            updatedAt: request.createdAt,
          }));
          reservations.set(reservation.reservationId, reservation);
          return Object.freeze({ kind: "admitted", reservation, replayed: false });
        },
        consumeCapacityReservation: async (
          request: Parameters<
            CapacityReservationTransaction["consumeCapacityReservation"]
          >[0],
        ) => {
          if (!validCapacityAmounts(request.actual)) return "state_conflict" as const;
          const current = reservations.get(request.reservationId);
          if (current === undefined) return "not_found" as const;
          if (current.state === "consumed") {
            return JSON.stringify(current.actual) === JSON.stringify(request.actual)
              ? "already_consumed" as const
              : "state_conflict" as const;
          }
          if (current.state !== "active") return "state_conflict" as const;
          if (
            request.actual.physicalCanonicalBytes > current.requested.physicalCanonicalBytes ||
            request.actual.temporaryBytes > current.requested.temporaryBytes ||
            request.actual.d1MetadataBytes > current.requested.d1MetadataBytes
          ) return "state_conflict" as const;
          reservations.set(
            request.reservationId,
            cloneCapacityReservation(Object.freeze({
              ...current,
              actual: Object.freeze({ ...request.actual }),
              state: "consumed" as const,
              updatedAt: request.consumedAt,
            })),
          );
          return "consumed" as const;
        },
        cancelCapacityReservation: async (
          request: Parameters<
            CapacityReservationTransaction["cancelCapacityReservation"]
          >[0],
        ) => {
          const current = reservations.get(request.reservationId);
          if (current === undefined) return "not_found" as const;
          if (current.state === "cleanup_pending") return "cleanup_pending" as const;
          if (current.state !== "active") return "already_final" as const;
          reservations.set(
            request.reservationId,
            cloneCapacityReservation(Object.freeze({
              ...current,
              state: "cleanup_pending" as const,
              updatedAt: request.canceledAt,
            })),
          );
          return "cleanup_pending" as const;
        },
      });
    }

  protected _ordinaryMindRouteSnapshot(
      spaceId: SpaceId,
    ): Readonly<OrdinaryMindRouteSnapshot> | null {
      const space = this._knowledgeSpaces.get(spaceId);
      if (
        !space ||
        space.state !== "active" ||
        [...this._personalBindings.values()].some(
          (binding) => binding.spaceId === spaceId,
        )
      ) {
        return null;
      }
      const headRevision = this._spaces.get(spaceId)?.revisions.get(space.headRevisionId);
      const parsedHandle = parseCanonicalSpaceHandle(space.spaceHandle);
      const reservation = this._activeHandlesBySpace.get(spaceId);
      if (
        parsedHandle.kind !== "valid" ||
        isReservedTopLevelHandle(parsedHandle.canonicalHandle) ||
        space.normalizedHandle !== parsedHandle.canonicalHandle ||
        !reservation ||
        reservation.spaceId !== spaceId ||
        reservation.canonicalHandle !== parsedHandle.canonicalHandle ||
        this._activeHandlesByKey.get(
          handleKey(reservation.host, reservation.canonicalHandle),
        )?.spaceId !== spaceId ||
        ordinaryMindSnapshotFromMaps(
          spaceId,
          this._knowledgeSpaces,
          this._memberships,
        ) === null ||
        this._spaces.get(spaceId)?.head !== space.headRevisionId ||
        headRevision === undefined
      ) {
        return null;
      }
      return Object.freeze({
        host: reservation.host,
        canonicalHandle: parsedHandle.canonicalHandle,
        space: freezeKnowledgeSpace(space),
        headRevision: Object.freeze({ ...headRevision.revision }),
      });
    }

  protected async _commitRevisionAgainst(
      request: RevisionCommitRequest,
      spaces: Map<SpaceId, SpaceState>,
      revisionsById: Map<RevisionId, Envelope>,
    ): Promise<RevisionCommitResult> {
      const envelope = request.envelope;
      const revision = envelope.revision;
      const manifestSource = canonicalManifestSource(envelope);
      if (
        manifestSource === null ||
        !SHA256_PATTERN.test(revision.manifestHash) ||
        (await sha256(manifestSource)) !== revision.manifestHash
      ) {
        return Object.freeze({
          kind: "invalid_revision_chain",
          reason: "manifest_hash_mismatch",
        });
      }

      const existingGlobal = revisionsById.get(revision.revisionId);
      if (existingGlobal) {
        if (envelopesEqual(existingGlobal, envelope)) {
          return Object.freeze({
            kind: "committed",
            envelope: existingGlobal,
            replayed: true,
          });
        }
        return Object.freeze({ kind: "revision_id_collision" });
      }

      const state = spaces.get(revision.spaceId);
      const expected = request.expectedHeadRevisionId;
      if (revision.parentRevisionId !== expected) {
        return Object.freeze({
          kind: "invalid_revision_chain",
          reason: "parent_mismatch",
        });
      }

      if (expected === null) {
        if (revision.revisionNumber !== 1) {
          return Object.freeze({
            kind: "invalid_revision_chain",
            reason: "revision_number_mismatch",
          });
        }
      } else {
        const parent = state?.revisions.get(expected);
        if (!parent) {
          return Object.freeze({
            kind: "invalid_revision_chain",
            reason: "missing_parent",
          });
        }
        if (revision.revisionNumber !== parent.revision.revisionNumber + 1) {
          return Object.freeze({
            kind: "invalid_revision_chain",
            reason: "revision_number_mismatch",
          });
        }
      }

      const currentHead = state?.head ?? null;
      if (currentHead !== expected) {
        return Object.freeze({
          kind: "stale_head",
          currentHeadRevisionId: currentHead,
        });
      }
      if (this._nextCommitFailure) {
        const failure = this._nextCommitFailure;
        this._nextCommitFailure = null;
        throw failure;
      }

      const stored = cloneEnvelope(envelope);
      const nextState = state ?? { head: null, revisions: new Map<RevisionId, Envelope>() };
      // Transactions pass cloned SpaceState values, so projection updates stay
      // atomic with the candidate revision and disappear with a rolled-back
      // candidate. A legacy state is rebuilt once here if it predates the
      // compact projections.
      ensureSpaceRevisionProjections(revision.spaceId, nextState);
      const revisionCatalog = new Map(nextState.revisionCatalog ?? []);
      const revisionIdsByNumber = new Map(nextState.revisionIdsByNumber ?? []);
      let revisionAsOfIndex = [...(nextState.revisionAsOfIndex ?? [])];
      const canonicalKeys = new Set(nextState.canonicalKeys ?? []);
      // These adjacent synchronous mutations are the in-memory transaction boundary.
      nextState.revisions.set(revision.revisionId, stored);
      nextState.head = revision.revisionId;
      revisionCatalog.set(
        revision.revisionId,
        revisionCatalogEntryFromEnvelope(stored),
      );
      revisionIdsByNumber.set(revision.revisionNumber, revision.revisionId);
      revisionAsOfIndex = insertRevisionAsOfIndexEntry(revisionAsOfIndex, {
        committedAt: normalizedUtcInstant(revision.committedAt),
        revisionNumber: revision.revisionNumber,
        revisionId: revision.revisionId,
      });
      for (const key of canonicalKeysForEnvelope(revision.spaceId, stored)) {
        canonicalKeys.add(key);
      }
      nextState.revisionCatalog = revisionCatalog;
      nextState.revisionIdsByNumber = revisionIdsByNumber;
      nextState.revisionAsOfIndex = Object.freeze(revisionAsOfIndex);
      nextState.canonicalKeys = canonicalKeys;
      spaces.set(revision.spaceId, nextState);
      revisionsById.set(revision.revisionId, stored);
      return Object.freeze({ kind: "committed", envelope: stored, replayed: false });
    }

  protected _objectReachabilityCounts(): Readonly<ObjectReachabilityCounts> {
      if (this._reachabilityCounts !== null) return this._reachabilityCounts;
      const immutable = new Map<Digest, number>();
      const bundle = new Map<string, number>();
      const bundleBytes = new Map<string, number>();
      const bundleRetainedBytes = new Map<SpaceId, number>();
      const spaceCanonical = new Map<string, number>();
      const capacity = new Map<string, number>();
      const increment = (target: Map<string, number>, key: string) =>
        target.set(key, (target.get(key) ?? 0) + 1);
      for (const envelope of this._revisionsById.values()) {
        const spaceId = envelope.revision.spaceId;
        for (const entry of envelope.manifest.entries) {
          immutable.set(entry.sha256, (immutable.get(entry.sha256) ?? 0) + 1);
          increment(capacity, `${spaceId}\u0000${entry.kind}\u0000${entry.sha256}`);
          if (entry.kind === "opaque") {
            const key = `${spaceId}\u0000${entry.sha256}`;
            const existingSize = bundleBytes.get(key);
            if (existingSize !== undefined && existingSize !== entry.size) {
              throw new TypeError("BundleFile digest size is inconsistent");
            }
            increment(bundle, key);
            if (existingSize === undefined) {
              bundleBytes.set(key, entry.size);
              const retained = (bundleRetainedBytes.get(spaceId) ?? 0) + entry.size;
              if (!Number.isSafeInteger(retained)) {
                throw new TypeError("BundleFile retained bytes overflow");
              }
              bundleRetainedBytes.set(spaceId, retained);
            }
          } else if (
            envelope.manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
            envelope.manifest.format === REVISION_MANIFEST_FORMAT_V4
          ) {
            increment(spaceCanonical, `markdown\u0000${spaceId}\u0000${entry.sha256}`);
          }
        }
        if (
          envelope.manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
          envelope.manifest.format === REVISION_MANIFEST_FORMAT_V4
        ) {
          increment(
            spaceCanonical,
            `revision_manifest\u0000${spaceId}\u0000${envelope.revision.manifestHash}`,
          );
        }
        increment(
          capacity,
          `${spaceId}\u0000manifest\u0000${envelope.revision.manifestHash}`,
        );
      }
      this._reachabilityCounts = Object.freeze({
        immutable,
        bundle,
        bundleBytes,
        bundleRetainedBytes,
        spaceCanonical,
        capacity,
      });
      return this._reachabilityCounts;
    }

  protected _ensureCapacityUsageLedger(spaceIds: ReadonlySet<SpaceId>): void {
      for (const spaceId of spaceIds) {
        if (this._capacityUsageLedger.has(spaceId)) continue;
        const state = this._spaces.get(spaceId);
        this._capacityUsageLedger.set(
          spaceId,
          state === undefined
            ? Object.freeze({
                logicalHeadBytes: 0,
                logicalRetainedBytes: 0,
                physicalCanonicalBytes: 0,
                temporaryBytes: 0,
                d1MetadataBytes: 0,
                reservedBytes: 0,
                storageAmplification: 1,
                trustworthy: true,
                reconciledAt: this._capacityReconciledAt.get(spaceId) ?? null,
              })
            : canonicalCapacityUsageForSpace(
                spaceId,
                state,
                this._capacityReconciledAt.get(spaceId) ?? null,
              ),
        );
      }
    }

  protected _capacityUsageFromLedger(
      spaceIds: ReadonlySet<SpaceId>,
      overrides: Readonly<{
        stagedBundleFiles?: ReadonlyMap<StagedBundleFileId, Readonly<StagedBundleFileRecord>>;
        queuedNotes?: ReadonlyMap<string, Readonly<QueuedNote>>;
        exportJobs?: ReadonlyMap<JobId, Readonly<ExportJob>>;
        markdownImportPlans?: ReadonlyMap<string, Readonly<MarkdownImportPlan>>;
        markdownImportSessions?: ReadonlyMap<string, Readonly<MarkdownImportSession>>;
        markdownImportStagedFiles?: ReadonlyMap<StagedBundleFileId, Readonly<MarkdownImportStagedFile>>;
        reservations?: ReadonlyMap<string, Readonly<CapacityReservation>>;
      }> = {},
    ): Readonly<CapacityUsageSnapshot> {
      this._ensureCapacityUsageLedger(spaceIds);
      const canonicalKeysBySpace = new Map<SpaceId, ReadonlySet<string>>();
      for (const spaceId of spaceIds) {
        const state = this._spaces.get(spaceId);
        if (state === undefined) continue;
        ensureSpaceRevisionProjections(spaceId, state);
        const canonicalKeys = state.canonicalKeys ?? new Set<string>();
        this._capacityCanonicalKeyVisits += canonicalKeys.size;
        canonicalKeysBySpace.set(spaceId, canonicalKeys);
      }
      return capacityUsageFromCanonicalLedger({
        spaceIds,
        ledger: this._capacityUsageLedger,
        canonicalKeysBySpace,
        stagedBundleFiles: overrides.stagedBundleFiles ?? this._stagedBundleFiles,
        queuedNotes: overrides.queuedNotes ?? this._queuedNotes,
        exportJobs: overrides.exportJobs ?? this._exportJobs,
        markdownImportPlans: overrides.markdownImportPlans ?? this._markdownImportPlans,
        markdownImportSessions:
          overrides.markdownImportSessions ?? this._markdownImportSessions,
        markdownImportStagedFiles:
          overrides.markdownImportStagedFiles ?? this._markdownImportStagedFiles,
        reservations: overrides.reservations ?? this._capacityReservations,
      });
    }

  protected _recordCommittedRevisionCapacity(envelope: Readonly<Envelope>): void {
      const spaceId = envelope.revision.spaceId;
      this._ensureCapacityUsageLedger(new Set([spaceId]));
      const previous = this._capacityUsageLedger.get(spaceId);
      if (previous === undefined) {
        throw new TypeError("capacity usage ledger is incomplete");
      }
      const currentCounts = this._objectReachabilityCounts();
      const immutable = new Map(currentCounts.immutable);
      const bundle = new Map(currentCounts.bundle);
      const bundleBytes = new Map(currentCounts.bundleBytes);
      const bundleRetainedBytes = new Map(currentCounts.bundleRetainedBytes);
      const spaceCanonical = new Map(currentCounts.spaceCanonical);
      const capacity = new Map(currentCounts.capacity);
      const increment = (target: Map<string, number>, key: string) =>
        target.set(key, (target.get(key) ?? 0) + 1);
      let physicalGrowth = 0;
      const manifestKey = `${spaceId}\u0000manifest\u0000${envelope.revision.manifestHash}`;
      if (!capacity.has(manifestKey)) {
        physicalGrowth += envelope.revision.manifestSize ?? 0;
      }
      increment(capacity, manifestKey);
      let headBytes = 0;
      for (const entry of envelope.manifest.entries) {
        headBytes += entry.size;
        const capacityKey = `${spaceId}\u0000${entry.kind}\u0000${entry.sha256}`;
        if (!capacity.has(capacityKey)) physicalGrowth += entry.size;
        increment(capacity, capacityKey);
        immutable.set(entry.sha256, (immutable.get(entry.sha256) ?? 0) + 1);
        if (entry.kind === "opaque") {
          const key = `${spaceId}\u0000${entry.sha256}`;
          const existingSize = bundleBytes.get(key);
          if (existingSize !== undefined && existingSize !== entry.size) {
            throw new TypeError("BundleFile digest size is inconsistent");
          }
          increment(bundle, key);
          if (existingSize === undefined) {
            bundleBytes.set(key, entry.size);
            const retained = (bundleRetainedBytes.get(spaceId) ?? 0) + entry.size;
            if (!Number.isSafeInteger(retained)) {
              throw new TypeError("BundleFile retained bytes overflow");
            }
            bundleRetainedBytes.set(spaceId, retained);
          }
        } else if (
          envelope.manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
          envelope.manifest.format === REVISION_MANIFEST_FORMAT_V4
        ) {
          increment(spaceCanonical, `markdown\u0000${spaceId}\u0000${entry.sha256}`);
        }
      }
      if (
        envelope.manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
        envelope.manifest.format === REVISION_MANIFEST_FORMAT_V4
      ) {
        increment(
          spaceCanonical,
          `revision_manifest\u0000${spaceId}\u0000${envelope.revision.manifestHash}`,
        );
      }
      const logicalRetainedBytes = previous.logicalRetainedBytes + headBytes;
      const physicalCanonicalBytes = previous.physicalCanonicalBytes + physicalGrowth;
      this._capacityUsageLedger.set(spaceId, Object.freeze({
        logicalHeadBytes: headBytes,
        logicalRetainedBytes,
        physicalCanonicalBytes,
        temporaryBytes: 0,
        d1MetadataBytes: previous.d1MetadataBytes +
          (this._spaces.has(spaceId) ? 0 : 1_024) + 512 +
          envelope.manifest.entries.length * 160,
        reservedBytes: 0,
        storageAmplification: headBytes === 0
          ? 1
          : physicalCanonicalBytes / headBytes,
        trustworthy: true,
        reconciledAt: previous.reconciledAt,
      }));
      this._reachabilityCounts = Object.freeze({
        immutable,
        bundle,
        bundleBytes,
        bundleRetainedBytes,
        spaceCanonical,
        capacity,
      });
    }

  protected _currentSitesAuthorizationState(
      query: AuthorizationStateQuery,
    ): AuthorizationState | null {
      return currentSitesAuthorizationStateFromMaps(
        query,
        this._principals,
        this._knowledgeSpaces,
        this._memberships,
      );
    }

  protected async _runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
      const previous = this._transactionTail;
      let release!: () => void;
      this._transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    }

  protected _failAccountBootstrapIfRequested(stage: AccountBootstrapFailureStage): void {
      if (this._nextAccountBootstrapFailureStage !== stage) return;
      this._nextAccountBootstrapFailureStage = null;
      throw new Error(`injected account bootstrap transaction failure at ${stage}`);
    }

  protected _failPersonalProfileIfRequested(stage: PersonalProfileFailureStage): void {
      if (this._nextPersonalProfileFailureStage !== stage) return;
      this._nextPersonalProfileFailureStage = null;
      throw new Error(`injected Personal Mind profile transaction failure at ${stage}`);
    }

  protected _failOrdinaryMindIfRequested(stage: OrdinaryMindFailureStage): void {
      if (this._nextOrdinaryMindFailureStage !== stage) return;
      this._nextOrdinaryMindFailureStage = null;
      throw new Error(`injected ordinary Mind transaction failure at ${stage}`);
    }

  protected _failAccountDeletionIfRequested(stage: AccountDeletionFailureStage): void {
      if (this._nextAccountDeletionFailureStage !== stage) return;
      this._nextAccountDeletionFailureStage = null;
      throw new Error(`injected account deletion transaction failure at ${stage}`);
    }
}
