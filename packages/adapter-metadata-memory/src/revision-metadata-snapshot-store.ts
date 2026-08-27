
import { RevisionMetadataStoreState } from "./revision-metadata-store-state.js";
import {
  cloneCredentialWriteTargetOwners,
  cloneLegacyCredentialWriteTargetUpgrades,
  migrateLegacyMindBindingOwners,
} from "./credential-write-target-internals.js";

export abstract class RevisionMetadataSnapshotStore extends RevisionMetadataStoreState {
  /** Trusted adapter checkpoint; canonical objects remain outside this projection. */
    exportDurableSnapshot(): unknown {
      const reachabilityCounts = this._objectReachabilityCounts();
      const legacyCredentialWriteTargetUpgrades = new Map(
        this._legacyCredentialWriteTargetUpgrades,
      );
      for (const [ownerId, evidence] of migrateLegacyMindBindingOwners(
        this._mindBindingOwners,
      )) {
        if (
          !this._credentialWriteTargetOwners.has(ownerId) &&
          !legacyCredentialWriteTargetUpgrades.has(ownerId)
        ) legacyCredentialWriteTargetUpgrades.set(ownerId, evidence);
      }
      return {
        v: 2,
        spaces: new Map(this._spaces),
        revisionsById: new Map(this._revisionsById),
        objectReachabilityCounts: Object.freeze({
          immutable: new Map(reachabilityCounts.immutable),
          bundle: new Map(reachabilityCounts.bundle),
          spaceCanonical: new Map(reachabilityCounts.spaceCanonical),
        }),
        idempotencyRecords: new Map(this._idempotencyRecords),
        auditEvents: new Map(this._auditEvents),
        auditOutbox: new Map(this._auditOutbox),
        backgroundJobs: new Map(this._backgroundJobs),
        exportJobs: new Map(this._exportJobs),
        exportDownloadGrants: new Map(this._exportDownloadGrants),
        bundleFileDownloadGrants: new Map(this._bundleFileDownloadGrants),
        indexStates: new Map(this._indexStates),
        revisionIndexRecoveryCursor: this._revisionIndexRecoveryCursor,
        stagedBundleFiles: new Map(this._stagedBundleFiles),
        markdownImportPlans: new Map(this._markdownImportPlans),
        markdownImportSessions: new Map(this._markdownImportSessions),
        markdownImportStagedFiles: new Map(this._markdownImportStagedFiles),
        markdownImportPlanKeys: new Map(this._markdownImportPlanKeys),
        markdownImportSessionKeys: new Map(this._markdownImportSessionKeys),
        markdownImportBatchHashes: new Map(this._markdownImportBatchHashes),
        capacityReservations: new Map(this._capacityReservations),
        capacityReconciledAt: new Map(this._capacityReconciledAt),
        capacityUsageLedger: new Map(this._capacityUsageLedger),
        capacityQuotaRejects: this._capacityQuotaRejects,
        objectCleanupCheckpoint: this._objectCleanupCheckpoint === null
          ? null
          : Object.freeze({ ...this._objectCleanupCheckpoint }),
        principals: new Map(this._principals),
        principalActivities: new Map(this._principalActivities),
        externalBindings: new Map(this._externalBindings),
        knowledgeSpaces: new Map(this._knowledgeSpaces),
        personalBindings: new Map(this._personalBindings),
        memberships: new Map(this._memberships),
        invitations: new Map(this._invitations),
        personalProfileIdempotencyRecords: new Map(this._personalProfileIdempotencyRecords),
        ordinaryMindIdempotencyRecords: new Map(this._ordinaryMindIdempotencyRecords),
        membershipMutationRecords: new Map(this._membershipMutationRecords),
        ordinaryMindDeletionImpacts: new Map(this._ordinaryMindDeletionImpacts),
        ordinaryMindDeletionCleanup: new Map(this._ordinaryMindDeletionCleanup),
        accountDeletionImpacts: new Map(this._accountDeletionImpacts),
        accountDeletionCleanup: new Map(this._accountDeletionCleanup),
        credentialWriteTargetOwners: cloneCredentialWriteTargetOwners(
          this._credentialWriteTargetOwners,
        ),
        legacyCredentialWriteTargetUpgrades:
          cloneLegacyCredentialWriteTargetUpgrades(
            legacyCredentialWriteTargetUpgrades,
          ),
        activeHandlesByKey: new Map(this._activeHandlesByKey),
        activeHandlesBySpace: new Map(this._activeHandlesBySpace),
        retiredHandles: new Map(this._retiredHandles),
        publicMindCatalogGeneration: this._publicMindCatalogGeneration,
        publicMindCatalogSpaceIds: new Set(this._publicMindCatalogSpaceIds),
        publicMindCatalogSnapshots: new Map(this._publicMindCatalogSnapshots),
        authorizationStates: new Map(this._authorizationStates),
      };
    }
}
