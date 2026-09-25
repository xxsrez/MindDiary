import {
  type MindBindingOwnerId,
  type MembershipControlTransaction,
  type OrdinaryMindMetadataTransaction,
  type PrincipalId,
} from "@mind-diary/application-ports";

import {
  cloneAccountDeletionCleanups,
  cloneAccountDeletionImpacts,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneAuthorizationState,
  cloneBackgroundJob,
  cloneBundleFileDownloadGrants,
  cloneExportDownloadGrants,
  cloneExportJobs,
  cloneIdempotencyRecords,
  cloneIndexState,
  cloneMembershipMutationRecords,
  cloneMindBindingOwners,
  cloneCredentialWriteTargetOwners,
  cloneLegacyCredentialWriteTargetUpgrades,
  clonePrincipalMindUsageOwners,
  cloneOrdinaryMindDeletionCleanups,
  cloneOrdinaryMindDeletionImpacts,
  cloneOrdinaryMindIdempotencyRecords,
  clonePersonalProfileIdempotencyRecords,
  clonePrincipalActivity,
  clonePublicCatalogSnapshots,
  cloneRecordMap,
  cloneSpaces,
  freezeExternalBinding,
  freezeInvitation,
  freezeKnowledgeSpace,
  freezeMembership,
  freezePersonalBinding,
  freezePrincipal,
} from "./metadata-store-internals.js";

import type { OrdinaryMindTransactionState } from "./ordinary-mind-transaction-state.js";

import { RevisionMetadataOrdinaryDeletionStore } from "./revision-metadata-ordinary-deletion-store.js";
import { cloneCopyOnWriteValue, copyOnWriteMap, copyOnWriteSet } from "./copy-on-write.js";

export abstract class RevisionMetadataOrdinaryTransactionStore extends RevisionMetadataOrdinaryDeletionStore {
  async runMembershipControlTransaction<Result>(
      operation: (transaction: MembershipControlTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this.runOrdinaryMindTransaction((transaction) => operation(transaction));
    }

  async runAccountDeletionTransaction<Result>(
      operation: (transaction: OrdinaryMindMetadataTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this.runOrdinaryMindTransaction(operation);
    }

  async runOrdinaryMindTransaction<Result>(
      operation: (transaction: OrdinaryMindMetadataTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        let principals = cloneRecordMap(this._principals, freezePrincipal);
        let principalActivities = copyOnWriteMap(this._principalActivities, clonePrincipalActivity);
        let externalBindings = cloneRecordMap(
          this._externalBindings,
          freezeExternalBinding,
        );
        let personalBindings = cloneRecordMap(
          this._personalBindings,
          freezePersonalBinding,
        );
        let knowledgeSpaces = cloneRecordMap(
          this._knowledgeSpaces,
          freezeKnowledgeSpace,
        );
        let memberships = cloneRecordMap(this._memberships, freezeMembership);
        let invitations = cloneRecordMap(this._invitations, freezeInvitation);
        let revisionSpaces = cloneSpaces(this._spaces);
        let revisionsById = copyOnWriteMap(this._revisionsById, cloneCopyOnWriteValue);
        let idempotencyRecords = cloneOrdinaryMindIdempotencyRecords(
          this._ordinaryMindIdempotencyRecords,
        );
        let membershipMutationRecords = cloneMembershipMutationRecords(
          this._membershipMutationRecords,
        );
        let personalProfileIdempotencyRecords =
          clonePersonalProfileIdempotencyRecords(
            this._personalProfileIdempotencyRecords,
          );
        let activeByHandle = copyOnWriteMap(this._activeHandlesByKey, cloneCopyOnWriteValue);
        let activeBySpace = copyOnWriteMap(this._activeHandlesBySpace, cloneCopyOnWriteValue);
        let retired = copyOnWriteMap(this._retiredHandles, cloneCopyOnWriteValue);
        let publicCatalogGeneration = this._publicMindCatalogGeneration;
        let publicCatalogSpaceIds = copyOnWriteSet(this._publicMindCatalogSpaceIds);
        let publicCatalogSnapshots = clonePublicCatalogSnapshots(
          this._publicMindCatalogSnapshots,
        );
        let auditEvents = copyOnWriteMap(this._auditEvents, cloneAuditEvent);
        let auditOutbox = copyOnWriteMap(this._auditOutbox, cloneAuditOutbox);
        let contentIdempotencyRecords = cloneIdempotencyRecords(
          this._idempotencyRecords,
        );
        let backgroundJobs = copyOnWriteMap(this._backgroundJobs, cloneBackgroundJob);
        let exportJobs = cloneExportJobs(this._exportJobs);
        let exportDownloadGrants = cloneExportDownloadGrants(
          this._exportDownloadGrants,
        );
        let bundleFileDownloadGrants = cloneBundleFileDownloadGrants(
          this._bundleFileDownloadGrants,
        );
        let indexStates = copyOnWriteMap(this._indexStates, cloneIndexState);
        let deletionImpacts = cloneOrdinaryMindDeletionImpacts(
          this._ordinaryMindDeletionImpacts,
        );
        let deletionCleanup = cloneOrdinaryMindDeletionCleanups(
          this._ordinaryMindDeletionCleanup,
        );
        let accountDeletionImpacts = cloneAccountDeletionImpacts(
          this._accountDeletionImpacts,
        );
        let accountDeletionCleanup = cloneAccountDeletionCleanups(
          this._accountDeletionCleanup,
        );
        let authorizationStates = copyOnWriteMap(this._authorizationStates, cloneAuthorizationState);
        let mindBindingOwners = cloneMindBindingOwners(this._mindBindingOwners);
        let credentialWriteTargetOwners = cloneCredentialWriteTargetOwners(
          this._credentialWriteTargetOwners,
        );
        let legacyCredentialWriteTargetUpgrades =
          cloneLegacyCredentialWriteTargetUpgrades(
            this._legacyCredentialWriteTargetUpgrades,
          );
        let principalMindUsageOwners = clonePrincipalMindUsageOwners(
          this._principalMindUsageOwners,
        );

        const state: OrdinaryMindTransactionState = {
          principals,
          principalActivities,
          externalBindings,
          personalBindings,
          knowledgeSpaces,
          memberships,
          invitations,
          revisionSpaces,
          revisionsById,
          idempotencyRecords,
          membershipMutationRecords,
          personalProfileIdempotencyRecords,
          activeByHandle,
          activeBySpace,
          retired,
          publicCatalogGeneration,
          publicCatalogSpaceIds,
          publicCatalogSnapshots,
          auditEvents,
          auditOutbox,
          contentIdempotencyRecords,
          backgroundJobs,
          exportJobs,
          exportDownloadGrants,
          bundleFileDownloadGrants,
          indexStates,
          deletionImpacts,
          deletionCleanup,
          accountDeletionImpacts,
          accountDeletionCleanup,
          authorizationStates,
          mindBindingOwners,
          credentialWriteTargetOwners,
          legacyCredentialWriteTargetUpgrades,
          principalMindUsageOwners,
        };

        const transaction: OrdinaryMindMetadataTransaction = Object.freeze({
          kind: "authorization-transaction" as const,
          readCredentialWriteTarget: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => this.readCredentialWriteTarget(bindingOwnerId, principalId),
          ...this._membershipTransactionMethods(state),
          ...this._lifecycleTransactionMethods(state),
          ...this._deletionTransactionMethods(state),
        });

        const result = await operation(transaction);
        // Accepted note payloads are service records, not historical authorship.
        // Remove them with their Mind or requesting account, in the same commit.
        for (const [id, note] of this._queuedNotes) {
          if ((this._principals.has(note.actor.principalId) && !state.principals.has(note.actor.principalId)) ||
              (this._knowledgeSpaces.has(note.spaceId) && !state.knowledgeSpaces.has(note.spaceId))) {
            this._queuedNotes.delete(id);
          }
        }
        this._principals = state.principals;
        this._principalActivities = state.principalActivities;
        this._externalBindings = state.externalBindings;
        this._personalBindings = state.personalBindings;
        this._knowledgeSpaces = state.knowledgeSpaces;
        this._memberships = state.memberships;
        this._invitations = state.invitations;
        this._spaces = state.revisionSpaces;
        for (const spaceId of this._preflightProducerProofs.keys()) {
          if (!this._spaces.has(spaceId)) this._preflightProducerProofs.delete(spaceId);
        }
        this._revisionsById = state.revisionsById;
        this._reachabilityCounts = null;
        this._ordinaryMindIdempotencyRecords = state.idempotencyRecords;
        this._membershipMutationRecords = state.membershipMutationRecords;
        this._personalProfileIdempotencyRecords = state.personalProfileIdempotencyRecords;
        this._activeHandlesByKey = state.activeByHandle;
        this._activeHandlesBySpace = state.activeBySpace;
        this._retiredHandles = state.retired;
        this._publicMindCatalogGeneration = state.publicCatalogGeneration;
        this._publicMindCatalogSpaceIds = state.publicCatalogSpaceIds;
        this._publicMindCatalogSnapshots = state.publicCatalogSnapshots;
        this._auditEvents = state.auditEvents;
        this._auditOutbox = state.auditOutbox;
        this._idempotencyRecords = state.contentIdempotencyRecords;
        this._backgroundJobs = state.backgroundJobs;
        this._exportJobs = state.exportJobs;
        this._exportDownloadGrants = state.exportDownloadGrants;
        this._bundleFileDownloadGrants = state.bundleFileDownloadGrants;
        this._indexStates = state.indexStates;
        this._ordinaryMindDeletionImpacts = state.deletionImpacts;
        this._ordinaryMindDeletionCleanup = state.deletionCleanup;
        this._accountDeletionImpacts = state.accountDeletionImpacts;
        this._accountDeletionCleanup = state.accountDeletionCleanup;
        this._mindBindingOwners = state.mindBindingOwners;
        this._credentialWriteTargetOwners = state.credentialWriteTargetOwners;
        this._legacyCredentialWriteTargetUpgrades =
          state.legacyCredentialWriteTargetUpgrades;
        this._principalMindUsageOwners = state.principalMindUsageOwners;
        this._authorizationStates = state.authorizationStates;
        return result;
      });
    }
}
