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
  migrateLegacyCredentialTargetsToPrincipalUsage,
  migrateLegacyMindBindingOwners,
  migrateLegacyPrincipalMindUsageOwners,
  validCredentialWriteTargetOwnersSnapshot,
  validLegacyCredentialWriteTargetUpgradesSnapshot,
  validPrincipalMindUsageOwnersSnapshot,
} from "./metadata-store-internals.js";
import { RevisionMetadataSupportStore } from "./revision-metadata-support-store.js";

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
        (snapshot.v === 3 || snapshot.v === 4 || snapshot.v === 5) &&
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
          snapshot.v !== 4 && snapshot.v !== 5) ||
        !mapFields.every((field) => snapshot[field] instanceof Map) ||
        (snapshot.v === 1 && !(snapshot.mindBindingOwners instanceof Map)) ||
        ((snapshot.v === 2 || snapshot.v === 3 || snapshot.v === 4 || snapshot.v === 5) &&
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
        ((snapshot.v === 3 || snapshot.v === 4 || snapshot.v === 5) &&
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
      restored._queuedNotes = new Map(snapshot.queuedNotes ?? []);
      for (const [id, note] of restored._queuedNotes) {
        if (!isQueuedNote(note) || id !== note.receiptId) throw new TypeError("Queued note snapshot is invalid");
        restored._queuedNotes.set(id, Object.freeze(structuredClone(note)));
      }
      restored._spaces = new Map(snapshot.spaces as Map<SpaceId, SpaceState>);
      restored._revisionsById = new Map(snapshot.revisionsById as Map<RevisionId, Envelope>);
      restored._reachabilityCounts = snapshot.objectReachabilityCounts === undefined
        ? null
        : cloneObjectReachabilityCounts(snapshot.objectReachabilityCounts);
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
      restored._capacityUsageLedger = snapshot.capacityUsageLedger instanceof Map
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
          snapshot.v === 5
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
