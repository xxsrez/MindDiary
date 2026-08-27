import {
  type MembershipControlTransaction,
  type OrdinaryMindMetadataTransaction,
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
        let principalActivities = new Map(
          [...this._principalActivities].map(([principalId, summary]) => [
            principalId,
            clonePrincipalActivity(summary),
          ]),
        );
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
        let revisionsById = new Map(this._revisionsById);
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
        let activeByHandle = new Map(this._activeHandlesByKey);
        let activeBySpace = new Map(this._activeHandlesBySpace);
        let retired = new Map(this._retiredHandles);
        let publicCatalogGeneration = this._publicMindCatalogGeneration;
        let publicCatalogSpaceIds = new Set(this._publicMindCatalogSpaceIds);
        let publicCatalogSnapshots = clonePublicCatalogSnapshots(
          this._publicMindCatalogSnapshots,
        );
        let auditEvents = new Map(
          [...this._auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
        );
        let auditOutbox = new Map(
          [...this._auditOutbox].map(([id, message]) => [
            id,
            cloneAuditOutbox(message),
          ]),
        );
        let contentIdempotencyRecords = cloneIdempotencyRecords(
          this._idempotencyRecords,
        );
        let backgroundJobs = new Map(
          [...this._backgroundJobs].map(([id, job]) => [
            id,
            cloneBackgroundJob(job),
          ]),
        );
        let exportJobs = cloneExportJobs(this._exportJobs);
        let exportDownloadGrants = cloneExportDownloadGrants(
          this._exportDownloadGrants,
        );
        let bundleFileDownloadGrants = cloneBundleFileDownloadGrants(
          this._bundleFileDownloadGrants,
        );
        let indexStates = new Map(
          [...this._indexStates].map(([key, state]) => [
            key,
            cloneIndexState(state),
          ]),
        );
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
        let authorizationStates = new Map(
          [...this._authorizationStates].map(([key, state]) => [
            key,
            cloneAuthorizationState(state),
          ]),
        );
        let mindBindingOwners = cloneMindBindingOwners(this._mindBindingOwners);
        let credentialWriteTargetOwners = cloneCredentialWriteTargetOwners(
          this._credentialWriteTargetOwners,
        );
        let legacyCredentialWriteTargetUpgrades =
          cloneLegacyCredentialWriteTargetUpgrades(
            this._legacyCredentialWriteTargetUpgrades,
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
        };

        const transaction: OrdinaryMindMetadataTransaction = Object.freeze({
          kind: "authorization-transaction" as const,
          ...this._membershipTransactionMethods(state),
          ...this._lifecycleTransactionMethods(state),
          ...this._deletionTransactionMethods(state),
        });

        const result = await operation(transaction);
        this._principals = state.principals;
        this._principalActivities = state.principalActivities;
        this._externalBindings = state.externalBindings;
        this._personalBindings = state.personalBindings;
        this._knowledgeSpaces = state.knowledgeSpaces;
        this._memberships = state.memberships;
        this._invitations = state.invitations;
        this._spaces = state.revisionSpaces;
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
        this._authorizationStates.clear();
        state.authorizationStates.forEach((state, key) =>
          this._authorizationStates.set(key, state));
        return result;
      });
    }
}
