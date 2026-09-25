import type {
  ActiveHandleByKeyMap,
  ActiveHandleBySpaceMap,
  RetiredHandleMap,
} from "./handle-registry.js";
import type {
  AccountDeletionCleanupMap,
  AccountDeletionImpactMap,
  AuditEventId,
  AuthorizationState,
  CompletedIdempotencyRecord,
  Envelope,
  ExternalBindingMap,
  InvitationMap,
  KnowledgeSpaceMap,
  MembershipMap,
  MutableMindBindingOwnerState,
  MutableCredentialWriteTargetOwnerState,
  MutablePrincipalMindUsageOwnerState,
  OrdinaryMindDeletionCleanupMap,
  OrdinaryMindDeletionImpactMap,
  OrdinaryMindIdempotencyRecord,
  OutboxMessageId,
  PersonalBindingMap,
  PersonalProfileIdempotencyRecord,
  PrincipalMap,
  RevisionId,
  SpaceId,
  SpaceState,
} from "./metadata-store-internals.js";
import type {
  AccountDeletionStore,
  AuditEvent,
  AuditOutboxMessage,
  BackgroundJob,
  BundleFileDownloadGrant,
  BundleFileDownloadGrantStore,
  CapacityLedgerStore,
  CapacityReservation,
  CapacityUsageSnapshot,
  ContentCommitMetadataStore,
  CredentialWriteTargetStore,
  ControlReadStore,
  ExportDownloadGrant,
  ExportDownloadGrantStore,
  ExportJob,
  JobId,
  MarkdownImportMetadataStore,
  MarkdownImportPlan,
  MarkdownImportSession,
  MarkdownImportStagedFile,
  MembershipControlStore,
  MindBindingOwnerId,
  LegacyCredentialWriteTargetUpgradeSnapshot,
  MindBindingStore,
  ObjectCleanupCheckpointStore,
  OrdinaryMindStore,
  PersonalMindStore,
  PreflightProducerProof,
  PrincipalMindUsageStore,
  PrincipalActivitySummary,
  PrincipalId,
  PublicMindCatalogStore,
  RevisionIndexState,
  ServiceOperatorDirectoryStore,
  StagedBundleFileId,
  StagedBundleFileRecord,
  UtcInstant,
} from "@mind-diary/application-ports";
import {
  cloneCapacityReservations,
  cloneMembershipMutationRecords,
  cloneObjectCleanupCheckpoint,
  cloneObjectReachabilityCounts,
  clonePrincipalActivity,
  cloneCredentialWriteTargetOwners,
  cloneLegacyCredentialWriteTargetUpgrades,
  clonePrincipalMindUsageOwners,
  ensureSpaceRevisionProjections,
  migrateLegacyCredentialTargetsToPrincipalUsage,
  migrateLegacyMindBindingOwners,
  migrateLegacyPrincipalMindUsageOwners,
  validCredentialWriteTargetOwnersSnapshot,
  validLegacyCredentialWriteTargetUpgradesSnapshot,
  validPrincipalMindUsageOwnersSnapshot,
} from "./metadata-store-internals.js";
import { RevisionMetadataSupportStore } from "./revision-metadata-support-store.js";
import {
  cloneCopyOnWriteValue,
  copyOnWriteMap,
  copyOnWriteSet,
  copyOnWriteStats,
  isCopyOnWriteMap,
  isCopyOnWriteSet,
  type CopyOnWriteStats,
} from "./copy-on-write.js";

export class InMemoryRevisionMetadataStore extends RevisionMetadataSupportStore
  implements
    ContentCommitMetadataStore,
    ExportDownloadGrantStore,
    BundleFileDownloadGrantStore,
    PublicMindCatalogStore,
    PersonalMindStore,
    OrdinaryMindStore,
    AccountDeletionStore,
    CapacityLedgerStore,
    MarkdownImportMetadataStore,
    ObjectCleanupCheckpointStore,
    MembershipControlStore,
    ControlReadStore,
    CredentialWriteTargetStore,
    PrincipalMindUsageStore,
    ServiceOperatorDirectoryStore,
    MindBindingStore {
  /**
   * Fork the complete metadata root without walking any of its maps.  Each
   * map records only touched keys and clones a mutable value when it is first
   * observed by the fork.  This is the boundary used by Sites CAS retries and
   * detached read sessions.
   */
  forkForTransaction(): InMemoryRevisionMetadataStore {
    return this.#forkRoot();
  }

  forkForRead(): InMemoryRevisionMetadataStore {
    return this.#forkRoot();
  }

  readCopyOnWriteStatsForTest(): Readonly<CopyOnWriteStats> {
    return copyOnWriteStats(this._copyOnWriteStats);
  }

  /**
   * Collapse persistent overlays after a durable checkpoint. Checkpoints
   * already scan the complete root, so retaining a long overlay chain would
   * make later recovery and scans pay the same history repeatedly.
   */
  compactCopyOnWriteRootForCheckpoint(): void {
    const map = <Key, Value>(source: Map<Key, Value>): Map<Key, Value> =>
      isCopyOnWriteMap(source) ? source.materialize() : source;
    const set = <Value>(source: Set<Value>): Set<Value> =>
      isCopyOnWriteSet(source) ? source.materialize() : source;
    this._spaceStates = map(this._spaceStates);
    this._revisionsById = map(this._revisionsById);
    this._preflightProducerProofs = map(this._preflightProducerProofs);
    this._idempotencyRecords = map(this._idempotencyRecords);
    this._auditEvents = map(this._auditEvents);
    this._auditOutbox = map(this._auditOutbox);
    this._backgroundJobs = map(this._backgroundJobs);
    this._queuedNotes = map(this._queuedNotes);
    this._exportJobs = map(this._exportJobs);
    this._exportDownloadGrants = map(this._exportDownloadGrants);
    this._bundleFileDownloadGrants = map(this._bundleFileDownloadGrants);
    this._indexStates = map(this._indexStates);
    this._stagedBundleFiles = map(this._stagedBundleFiles);
    this._markdownImportPlans = map(this._markdownImportPlans);
    this._markdownImportSessions = map(this._markdownImportSessions);
    this._markdownImportStagedFiles = map(this._markdownImportStagedFiles);
    this._markdownImportPlanKeys = map(this._markdownImportPlanKeys);
    this._markdownImportSessionKeys = map(this._markdownImportSessionKeys);
    this._markdownImportBatchHashes = map(this._markdownImportBatchHashes);
    this._capacityReservations = map(this._capacityReservations);
    this._capacityReconciledAt = map(this._capacityReconciledAt);
    this._capacityUsageLedger = map(this._capacityUsageLedger);
    this._principals = map(this._principals);
    this._principalActivities = map(this._principalActivities);
    this._externalBindings = map(this._externalBindings);
    this._knowledgeSpaces = map(this._knowledgeSpaces);
    this._personalBindings = map(this._personalBindings);
    this._memberships = map(this._memberships);
    this._invitations = map(this._invitations);
    this._personalProfileIdempotencyRecords = map(this._personalProfileIdempotencyRecords);
    this._ordinaryMindIdempotencyRecords = map(this._ordinaryMindIdempotencyRecords);
    this._membershipMutationRecords = map(this._membershipMutationRecords);
    this._ordinaryMindDeletionImpacts = map(this._ordinaryMindDeletionImpacts);
    this._ordinaryMindDeletionCleanup = map(this._ordinaryMindDeletionCleanup);
    this._accountDeletionImpacts = map(this._accountDeletionImpacts);
    this._accountDeletionCleanup = map(this._accountDeletionCleanup);
    this._mindBindingOwners = map(this._mindBindingOwners);
    this._credentialWriteTargetOwners = map(this._credentialWriteTargetOwners);
    this._legacyCredentialWriteTargetUpgrades = map(this._legacyCredentialWriteTargetUpgrades);
    this._principalMindUsageOwners = map(this._principalMindUsageOwners);
    this._activeHandlesByKey = map(this._activeHandlesByKey);
    this._activeHandlesBySpace = map(this._activeHandlesBySpace);
    this._retiredHandles = map(this._retiredHandles);
    this._publicMindCatalogSpaceIds = set(this._publicMindCatalogSpaceIds);
    this._publicMindCatalogSnapshots = map(this._publicMindCatalogSnapshots);
    this._authorizationStates = map(this._authorizationStates);
  }

  #forkRoot(): InMemoryRevisionMetadataStore {
    const fork = new InMemoryRevisionMetadataStore();
    fork._copyOnWriteStats = this._copyOnWriteStats;
    const stats = this._copyOnWriteStats;
    const map = <Key, Value>(source: ReadonlyMap<Key, Value>) =>
      copyOnWriteMap(source, cloneCopyOnWriteValue, stats);
    fork._spaceStates = map(this._spaceStates);
    fork._revisionsById = map(this._revisionsById);
    fork._preflightProducerProofs = map(this._preflightProducerProofs);
    fork._idempotencyRecords = map(this._idempotencyRecords);
    fork._auditEvents = map(this._auditEvents);
    fork._auditOutbox = map(this._auditOutbox);
    fork._backgroundJobs = map(this._backgroundJobs);
    fork._queuedNotes = map(this._queuedNotes);
    fork._exportJobs = map(this._exportJobs);
    fork._exportDownloadGrants = map(this._exportDownloadGrants);
    fork._bundleFileDownloadGrants = map(this._bundleFileDownloadGrants);
    fork._indexStates = map(this._indexStates);
    fork._stagedBundleFiles = map(this._stagedBundleFiles);
    fork._markdownImportPlans = map(this._markdownImportPlans);
    fork._markdownImportSessions = map(this._markdownImportSessions);
    fork._markdownImportStagedFiles = map(this._markdownImportStagedFiles);
    fork._markdownImportPlanKeys = map(this._markdownImportPlanKeys);
    fork._markdownImportSessionKeys = map(this._markdownImportSessionKeys);
    fork._markdownImportBatchHashes = map(this._markdownImportBatchHashes);
    fork._capacityReservations = map(this._capacityReservations);
    fork._capacityReconciledAt = map(this._capacityReconciledAt);
    fork._capacityUsageLedger = map(this._capacityUsageLedger);
    fork._principals = map(this._principals);
    fork._principalActivities = map(this._principalActivities);
    fork._externalBindings = map(this._externalBindings);
    fork._knowledgeSpaces = map(this._knowledgeSpaces);
    fork._personalBindings = map(this._personalBindings);
    fork._memberships = map(this._memberships);
    fork._invitations = map(this._invitations);
    fork._personalProfileIdempotencyRecords = map(this._personalProfileIdempotencyRecords);
    fork._ordinaryMindIdempotencyRecords = map(this._ordinaryMindIdempotencyRecords);
    fork._membershipMutationRecords = map(this._membershipMutationRecords);
    fork._ordinaryMindDeletionImpacts = map(this._ordinaryMindDeletionImpacts);
    fork._ordinaryMindDeletionCleanup = map(this._ordinaryMindDeletionCleanup);
    fork._accountDeletionImpacts = map(this._accountDeletionImpacts);
    fork._accountDeletionCleanup = map(this._accountDeletionCleanup);
    fork._mindBindingOwners = map(this._mindBindingOwners);
    fork._credentialWriteTargetOwners = map(this._credentialWriteTargetOwners);
    fork._legacyCredentialWriteTargetUpgrades = map(this._legacyCredentialWriteTargetUpgrades);
    fork._principalMindUsageOwners = map(this._principalMindUsageOwners);
    fork._activeHandlesByKey = map(this._activeHandlesByKey);
    fork._activeHandlesBySpace = map(this._activeHandlesBySpace);
    fork._retiredHandles = map(this._retiredHandles);
    fork._publicMindCatalogSpaceIds = copyOnWriteSet(this._publicMindCatalogSpaceIds, stats);
    fork._publicMindCatalogSnapshots = map(this._publicMindCatalogSnapshots);
    fork._authorizationStates = map(this._authorizationStates);
    fork._reachabilityCounts = this._reachabilityCounts;
    fork._revisionIndexRecoveryCursor = this._revisionIndexRecoveryCursor;
    fork._revisionCatalogVisits = this._revisionCatalogVisits;
    fork._revisionAsOfVisits = this._revisionAsOfVisits;
    fork._capacityCanonicalKeyVisits = this._capacityCanonicalKeyVisits;
    fork._capacityQuotaRejects = this._capacityQuotaRejects;
    fork._objectCleanupCheckpoint = this._objectCleanupCheckpoint;
    fork._publicMindCatalogGeneration = this._publicMindCatalogGeneration;
    fork._nextCommitFailure = this._nextCommitFailure;
    fork._nextAccountBootstrapFailureStage = this._nextAccountBootstrapFailureStage;
    fork._nextPersonalProfileFailureStage = this._nextPersonalProfileFailureStage;
    fork._nextOrdinaryMindFailureStage = this._nextOrdinaryMindFailureStage;
    fork._nextAccountDeletionFailureStage = this._nextAccountDeletionFailureStage;
    return fork;
  }

  /** Restores a checkpoint produced by exportDurableSnapshot, failing closed on corruption. */
    static fromDurableSnapshot(value: unknown): InMemoryRevisionMetadataStore {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Revision metadata durable snapshot is invalid");
      }
      const snapshot = value as Record<string, unknown>;
      const mapFields = [
        "spaces", "revisionsById", "idempotencyRecords", "auditEvents", "auditOutbox",
        "backgroundJobs", "exportJobs", "exportDownloadGrants", "indexStates", "principals",
        "externalBindings", "knowledgeSpaces", "personalBindings", "memberships", "invitations",
        "personalProfileIdempotencyRecords", "ordinaryMindIdempotencyRecords",
        "membershipMutationRecords", "ordinaryMindDeletionImpacts", "ordinaryMindDeletionCleanup",
        "accountDeletionImpacts", "accountDeletionCleanup",
        "activeHandlesByKey", "activeHandlesBySpace", "retiredHandles",
        "publicMindCatalogSnapshots", "authorizationStates",
      ] as const;
      let principalMindUsageOwners: Map<
        PrincipalId,
        MutablePrincipalMindUsageOwnerState
      > | null = null;
      if (
        (snapshot.v === 3 || snapshot.v === 4 || snapshot.v === 5 || snapshot.v === 6) &&
        snapshot.principalMindUsageOwners instanceof Map &&
        snapshot.personalBindings instanceof Map
      ) {
        try {
          principalMindUsageOwners = snapshot.v === 3 || snapshot.v === 4
            ? migrateLegacyPrincipalMindUsageOwners(
                snapshot.principalMindUsageOwners as Map<PrincipalId, unknown>,
                snapshot.personalBindings as PersonalBindingMap,
              )
            : clonePrincipalMindUsageOwners(
                snapshot.principalMindUsageOwners as Map<
                  PrincipalId,
                  MutablePrincipalMindUsageOwnerState
                >,
              );
        } catch {
          principalMindUsageOwners = null;
        }
      }
      if (
        (snapshot.v !== 1 && snapshot.v !== 2 && snapshot.v !== 3 &&
          snapshot.v !== 4 && snapshot.v !== 5 && snapshot.v !== 6) ||
        !mapFields.every((field) => snapshot[field] instanceof Map) ||
        (snapshot.v === 1 && !(snapshot.mindBindingOwners instanceof Map)) ||
        ((snapshot.v === 2 || snapshot.v === 3 || snapshot.v === 4 || snapshot.v === 5 || snapshot.v === 6) &&
          (!(snapshot.credentialWriteTargetOwners instanceof Map) ||
            !(snapshot.legacyCredentialWriteTargetUpgrades instanceof Map) ||
            !validCredentialWriteTargetOwnersSnapshot(
              snapshot.credentialWriteTargetOwners as Map<MindBindingOwnerId, unknown>,
            ) ||
            !validLegacyCredentialWriteTargetUpgradesSnapshot(
              snapshot.legacyCredentialWriteTargetUpgrades as Map<MindBindingOwnerId, unknown>,
            ) ||
            [...(snapshot.credentialWriteTargetOwners as Map<MindBindingOwnerId, unknown>).keys()]
              .some((ownerId) =>
                (snapshot.legacyCredentialWriteTargetUpgrades as Map<MindBindingOwnerId, unknown>)
                  .has(ownerId),
              ))) ||
        ((snapshot.v === 3 || snapshot.v === 4 || snapshot.v === 5 || snapshot.v === 6) &&
          (principalMindUsageOwners === null ||
            !validPrincipalMindUsageOwnersSnapshot(
              principalMindUsageOwners,
              snapshot.personalBindings as PersonalBindingMap,
            ))) ||
        !(snapshot.publicMindCatalogSpaceIds instanceof Set) ||
        !Number.isSafeInteger(snapshot.publicMindCatalogGeneration) ||
        (snapshot.publicMindCatalogGeneration as number) < 0 ||
        (snapshot.revisionIndexRecoveryCursor !== undefined &&
          (!Number.isSafeInteger(snapshot.revisionIndexRecoveryCursor) ||
            (snapshot.revisionIndexRecoveryCursor as number) < 0))
      ) {
        throw new TypeError("Revision metadata durable snapshot is invalid");
      }
      const restored = new InMemoryRevisionMetadataStore();
      if (snapshot.queuedNotes !== undefined && !(snapshot.queuedNotes instanceof Map)) {
        throw new TypeError("Queued note snapshot is invalid");
      }
      if (snapshot.preflightProducerProofs !== undefined &&
          !(snapshot.preflightProducerProofs instanceof Map)) {
        throw new TypeError("Preflight producer proof snapshot is invalid");
      }
      restored._queuedNotes = new Map(snapshot.queuedNotes ?? []);
      for (const [id, note] of restored._queuedNotes) {
        if (!isQueuedNote(note) || id !== note.receiptId) throw new TypeError("Queued note snapshot is invalid");
        restored._queuedNotes.set(id, Object.freeze(structuredClone(note)));
      }
      restored._spaces = new Map(snapshot.spaces as Map<SpaceId, SpaceState>);
      for (const [spaceId, state] of restored._spaces) {
        ensureSpaceRevisionProjections(spaceId, state);
      }
      restored._revisionsById = new Map(snapshot.revisionsById as Map<RevisionId, Envelope>);
      restored._preflightProducerProofs = new Map(
        snapshot.preflightProducerProofs as Map<SpaceId, Readonly<PreflightProducerProof>> | undefined,
      );
      const persistedReachability = snapshot.objectReachabilityCounts;
      restored._reachabilityCounts =
        snapshot.v !== 6 ||
        typeof persistedReachability !== "object" ||
        persistedReachability === null ||
        !("bundleBytes" in persistedReachability) ||
        !("bundleRetainedBytes" in persistedReachability)
          ? null
          : cloneObjectReachabilityCounts(persistedReachability);
      restored._idempotencyRecords = new Map(snapshot.idempotencyRecords as Map<string, CompletedIdempotencyRecord>);
      restored._auditEvents = new Map(snapshot.auditEvents as Map<AuditEventId, Readonly<AuditEvent>>);
      restored._auditOutbox = new Map(snapshot.auditOutbox as Map<OutboxMessageId, Readonly<AuditOutboxMessage>>);
      restored._backgroundJobs = new Map(snapshot.backgroundJobs as Map<JobId, Readonly<BackgroundJob>>);
      restored._exportJobs = new Map(
        [...(snapshot.exportJobs as Map<JobId, Readonly<ExportJob>>)].map(([jobId, job]) => [
          jobId,
          Object.freeze({ ...job, profile: job.profile ?? "MD-OKF-ZIP-1" }),
        ]),
      );
      restored._exportDownloadGrants = new Map(snapshot.exportDownloadGrants as Map<string, Readonly<ExportDownloadGrant>>);
      restored._bundleFileDownloadGrants = snapshot.bundleFileDownloadGrants instanceof Map
        ? new Map(snapshot.bundleFileDownloadGrants as Map<string, Readonly<BundleFileDownloadGrant>>)
        : new Map();
      restored._indexStates = new Map(snapshot.indexStates as Map<string, Readonly<RevisionIndexState>>);
      restored._revisionIndexRecoveryCursor = snapshot.revisionIndexRecoveryCursor === undefined
        ? 0
        : snapshot.revisionIndexRecoveryCursor as number;
      restored._stagedBundleFiles = snapshot.stagedBundleFiles instanceof Map
        ? new Map(snapshot.stagedBundleFiles as Map<StagedBundleFileId, Readonly<StagedBundleFileRecord>>)
        : new Map();
      restored._markdownImportPlans = snapshot.markdownImportPlans instanceof Map
        ? new Map(snapshot.markdownImportPlans as Map<string, Readonly<MarkdownImportPlan>>)
        : new Map();
      restored._markdownImportSessions = snapshot.markdownImportSessions instanceof Map
        ? new Map(snapshot.markdownImportSessions as Map<string, Readonly<MarkdownImportSession>>)
        : new Map();
      restored._markdownImportStagedFiles = snapshot.markdownImportStagedFiles instanceof Map
        ? new Map(snapshot.markdownImportStagedFiles as Map<StagedBundleFileId, Readonly<MarkdownImportStagedFile>>)
        : new Map();
      restored._markdownImportPlanKeys = snapshot.markdownImportPlanKeys instanceof Map
        ? new Map(snapshot.markdownImportPlanKeys as Map<string, string>)
        : new Map();
      restored._markdownImportSessionKeys = snapshot.markdownImportSessionKeys instanceof Map
        ? new Map(snapshot.markdownImportSessionKeys as Map<string, string>)
        : new Map();
      restored._markdownImportBatchHashes = snapshot.markdownImportBatchHashes instanceof Map
        ? new Map(snapshot.markdownImportBatchHashes as Map<string, string>)
        : new Map();
      restored._capacityReservations = snapshot.capacityReservations instanceof Map
        ? cloneCapacityReservations(
            snapshot.capacityReservations as Map<string, Readonly<CapacityReservation>>,
          )
        : new Map();
      restored._capacityReconciledAt = snapshot.capacityReconciledAt instanceof Map
        ? new Map(snapshot.capacityReconciledAt as Map<SpaceId, UtcInstant>)
        : new Map();
      restored._capacityUsageLedger = snapshot.v === 6 && snapshot.capacityUsageLedger instanceof Map
        ? new Map(
            [...(snapshot.capacityUsageLedger as Map<SpaceId, Readonly<CapacityUsageSnapshot>>)]
              .map(([spaceId, usage]) => [spaceId, Object.freeze({ ...usage })]),
          )
        : new Map();
      restored._capacityQuotaRejects = Number.isSafeInteger(snapshot.capacityQuotaRejects) &&
        (snapshot.capacityQuotaRejects as number) >= 0
        ? snapshot.capacityQuotaRejects as number
        : 0;
      restored._objectCleanupCheckpoint = snapshot.objectCleanupCheckpoint === undefined ||
        snapshot.objectCleanupCheckpoint === null
        ? null
        : cloneObjectCleanupCheckpoint(snapshot.objectCleanupCheckpoint);
      restored._principals = new Map(snapshot.principals as PrincipalMap);
      restored._principalActivities = snapshot.principalActivities instanceof Map
        ? new Map(
            [...(snapshot.principalActivities as Map<PrincipalId, Readonly<PrincipalActivitySummary>>)]
              .map(([principalId, summary]) => [principalId, clonePrincipalActivity(summary)]),
          )
        : new Map();
      restored._externalBindings = new Map(snapshot.externalBindings as ExternalBindingMap);
      restored._personalBindings = new Map(snapshot.personalBindings as PersonalBindingMap);
      restored._knowledgeSpaces = new Map(
        [...(snapshot.knowledgeSpaces as KnowledgeSpaceMap)].map(([spaceId, space]) => {
          return [
            spaceId,
            Object.freeze({ ...space, description: space.description ?? null }),
          ] as const;
        }),
      );
      restored._memberships = new Map(snapshot.memberships as MembershipMap);
      restored._invitations = new Map(snapshot.invitations as InvitationMap);
      restored._personalProfileIdempotencyRecords = new Map(snapshot.personalProfileIdempotencyRecords as Map<string, Readonly<PersonalProfileIdempotencyRecord>>);
      restored._ordinaryMindIdempotencyRecords = new Map(snapshot.ordinaryMindIdempotencyRecords as Map<string, Readonly<OrdinaryMindIdempotencyRecord>>);
      restored._membershipMutationRecords = cloneMembershipMutationRecords(
        snapshot.membershipMutationRecords as Parameters<
          typeof cloneMembershipMutationRecords
        >[0],
      );
      restored._ordinaryMindDeletionImpacts = new Map(snapshot.ordinaryMindDeletionImpacts as OrdinaryMindDeletionImpactMap);
      restored._ordinaryMindDeletionCleanup = new Map(snapshot.ordinaryMindDeletionCleanup as OrdinaryMindDeletionCleanupMap);
      restored._accountDeletionImpacts = new Map(snapshot.accountDeletionImpacts as AccountDeletionImpactMap);
      restored._accountDeletionCleanup = new Map(snapshot.accountDeletionCleanup as AccountDeletionCleanupMap);
      if (snapshot.v === 1) {
        const legacyOwners = new Map(
          snapshot.mindBindingOwners as Map<MindBindingOwnerId, MutableMindBindingOwnerState>,
        );
        // Read-binding projections are intentionally discarded. Only bounded,
        // fail-closed write evidence survives for an explicit same-owner upgrade.
        restored._legacyCredentialWriteTargetUpgrades =
          migrateLegacyMindBindingOwners(legacyOwners);
        restored._mindBindingOwners = new Map();
      } else {
        restored._credentialWriteTargetOwners = cloneCredentialWriteTargetOwners(
          snapshot.credentialWriteTargetOwners as Map<
            MindBindingOwnerId,
            MutableCredentialWriteTargetOwnerState
          >,
        );
        restored._legacyCredentialWriteTargetUpgrades =
          cloneLegacyCredentialWriteTargetUpgrades(
            snapshot.legacyCredentialWriteTargetUpgrades as Map<
              MindBindingOwnerId,
              Readonly<LegacyCredentialWriteTargetUpgradeSnapshot>
            >,
          );
        // A forward snapshot never revives the removed legacy authority model.
        restored._mindBindingOwners = new Map();
      }
      restored._principalMindUsageOwners = snapshot.v === 3 || snapshot.v === 4 ||
          snapshot.v === 5 || snapshot.v === 6
        ? clonePrincipalMindUsageOwners(principalMindUsageOwners!)
        : migrateLegacyCredentialTargetsToPrincipalUsage(
            restored._credentialWriteTargetOwners,
            restored._legacyCredentialWriteTargetUpgrades,
            restored._knowledgeSpaces,
            restored._memberships,
            restored._personalBindings,
          );
      restored._activeHandlesByKey = new Map(snapshot.activeHandlesByKey as ActiveHandleByKeyMap);
      restored._activeHandlesBySpace = new Map(snapshot.activeHandlesBySpace as ActiveHandleBySpaceMap);
      restored._retiredHandles = new Map(snapshot.retiredHandles as RetiredHandleMap);
      restored._publicMindCatalogGeneration = snapshot.publicMindCatalogGeneration as number;
      restored._publicMindCatalogSpaceIds = new Set(snapshot.publicMindCatalogSpaceIds as Set<SpaceId>);
      restored._publicMindCatalogSnapshots = new Map(snapshot.publicMindCatalogSnapshots as Map<number, readonly SpaceId[]>);
      for (const [key, item] of snapshot.authorizationStates as Map<string, AuthorizationState>) {
        restored._authorizationStates.set(key, item);
      }
      return restored;
    }
}
import { isQueuedNote } from "@mind-diary/application-ports";
