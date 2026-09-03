import {
  DomainInvariantError,
  SpaceAggregate,
  revisionEnvelopesEqual,
  roleHasCapability,
  type ChangeOrdinaryMindVisibilityRequest,
  type ChangeOrdinaryMindVisibilityResult,
  type CreateOrdinaryMindResult,
  type OrdinaryMindMetadataTransaction,
  type OrdinaryMindRecordSet,
  type RenameOrdinaryMindRequest,
  type RenameOrdinaryMindResult,
  type TransferOrdinaryMindOwnershipRequest,
  type TransferOrdinaryMindOwnershipResult,
} from "@mind-diary/application-ports";

import {
  reserveHandleAgainst,
} from "./handle-registry.js";

import {
  BOUNDED_OPAQUE_ID,
  SHA256_PATTERN,
  activeReservationAmounts,
  capacityUsageFromCanonicalState,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneOrdinaryMindIdempotencyRecords,
  clonePublicCatalogSnapshots,
  cloneRecordMap,
  cloneSpaces,
  derivePublicMindCatalogSpaceIds,
  freezeKnowledgeSpace,
  freezeMembership,
  freezeOrdinaryMindSnapshot,
  freezeOwnershipTransferSnapshot,
  ordinaryMindCreateIdempotencyKey,
  ordinaryMindRenameIdempotencyKey,
  ordinaryMindSnapshotFromMaps,
  ordinaryMindVisibilityIdempotencyKey,
  ownedCapacitySpaceIds,
  ownershipTransferIdempotencyKey,
  ownershipTransferSnapshotFromMaps,
  sameOwnershipTransferSnapshot,
  stageInitialRevisionIndexAgainst,
  stageOwnershipTransferAuditEffects,
  stagePublicCatalogSnapshot,
  stageVisibilityAuditEffects,
  validateOrdinaryMindRecords,
} from "./metadata-store-internals.js";

import {
  type OrdinaryMindTransactionState,
} from "./ordinary-mind-transaction-state.js";

import { RevisionMetadataOrdinaryMembershipStore } from "./revision-metadata-ordinary-membership-store.js";

export abstract class RevisionMetadataOrdinaryLifecycleStore extends RevisionMetadataOrdinaryMembershipStore {
  protected _lifecycleTransactionMethods(
    tx: OrdinaryMindTransactionState,
  ): Pick<OrdinaryMindMetadataTransaction,
    | "createOrdinaryMind"
    | "renameOrdinaryMind"
    | "changeOrdinaryMindVisibility"
    | "transferOrdinaryMindOwnership"
  > {
    return Object.freeze({
          createOrdinaryMind: async (
            records: Readonly<OrdinaryMindRecordSet>,
          ): Promise<CreateOrdinaryMindResult> => {
            const principalId = records.ownerMembership.principalId;
            const idempotencyRecordKey = ordinaryMindCreateIdempotencyKey(
              principalId,
              records.idempotencyKey,
            );
            const principal = tx.principals.get(principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "principal_not_found" });
            }
            const previous = tx.idempotencyRecords.get(idempotencyRecordKey);
            if (previous) {
              if (
                previous.operation !== "create_space_with_owner"
              ) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              const currentSpace = tx.knowledgeSpaces.get(previous.mind.space.spaceId);
              const currentReservation = tx.activeBySpace.get(
                previous.mind.space.spaceId,
              );
              const currentMembership = [...tx.memberships.values()].find(
                (membership) =>
                  membership.spaceId === previous.mind.space.spaceId &&
                  membership.principalId === principalId &&
                  membership.state === "active",
              );
              const isPersonal = [...tx.personalBindings.values()].some(
                (binding) => binding.spaceId === previous.mind.space.spaceId,
              );
              if (
                !currentSpace ||
                currentSpace.state !== "active" ||
                !currentReservation ||
                currentReservation.spaceId !== currentSpace.spaceId ||
                currentReservation.canonicalHandle !== currentSpace.normalizedHandle ||
                isPersonal ||
                ordinaryMindSnapshotFromMaps(
                  currentSpace.spaceId,
                  tx.knowledgeSpaces,
                  tx.memberships,
                ) === null
              ) {
                return Object.freeze({ kind: "mind_not_found" });
              }
              if (
                !currentMembership ||
                !roleHasCapability(currentMembership.role, "settings:configure")
              ) {
                return Object.freeze({ kind: "forbidden" });
              }
              if (previous.canonicalRequestHash !== records.canonicalRequestHash) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({
                kind: "created",
                mind: freezeOrdinaryMindSnapshot(previous.mind),
                replayed: true,
              });
            }
            const validated = validateOrdinaryMindRecords(records);
            if (validated === null) return Object.freeze({ kind: "invalid_record" });

            const space = records.space;
            const membership = records.ownerMembership;
            const revisionId = records.initialRevision.revision.revisionId;
            if (
              tx.knowledgeSpaces.has(space.spaceId) ||
              tx.memberships.has(membership.membershipId) ||
              tx.revisionSpaces.has(space.spaceId) ||
              tx.revisionsById.has(revisionId)
            ) {
              return Object.freeze({ kind: "record_conflict" });
            }
            const candidateKnowledgeSpaces = cloneRecordMap(
              tx.knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateMemberships = cloneRecordMap(
              tx.memberships,
              freezeMembership,
            );
            const candidateRevisionSpaces = cloneSpaces(tx.revisionSpaces);
            const candidateRevisionsById = new Map(tx.revisionsById);
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
            const candidateBackgroundJobs = new Map(tx.backgroundJobs);
            const candidateIndexStates = new Map(tx.indexStates);
            const candidateActiveByHandle = new Map(tx.activeByHandle);
            const candidateActiveBySpace = new Map(tx.activeBySpace);
            const candidateRetired = new Map(tx.retired);

            const reserved = reserveHandleAgainst(
              {
                host: records.host,
                handle: space.spaceHandle,
                spaceId: space.spaceId,
              },
              {
                activeByHandle: candidateActiveByHandle,
                activeBySpace: candidateActiveBySpace,
                retired: candidateRetired,
              },
            );
            if (reserved.kind !== "reserved") {
              return Object.freeze({
                kind:
                  reserved.kind === "handle_unavailable"
                    ? "handle_unavailable"
                    : "invalid_record",
              });
            }
            if (reserved.replayed) {
              return Object.freeze({ kind: "record_conflict" });
            }
            this._failOrdinaryMindIfRequested("create_after_handle");

            const revisionResult = await this._commitRevisionAgainst(
              {
                expectedHeadRevisionId: null,
                envelope: records.initialRevision,
              },
              candidateRevisionSpaces,
              candidateRevisionsById,
            );
            if (
              revisionResult.kind !== "committed" ||
              revisionResult.replayed ||
              !revisionEnvelopesEqual(
                revisionResult.envelope,
                records.initialRevision,
              )
            ) {
              return Object.freeze({ kind: "record_conflict" });
            }
            this._failOrdinaryMindIfRequested("create_after_revision");
            if (
              stageInitialRevisionIndexAgainst(
                records,
                candidateBackgroundJobs,
                candidateIndexStates,
              ) === "invalid"
            ) {
              return Object.freeze({ kind: "record_conflict" });
            }

            candidateKnowledgeSpaces.set(
              space.spaceId,
              freezeKnowledgeSpace(space),
            );
            this._failOrdinaryMindIfRequested("create_after_space");
            candidateMemberships.set(
              membership.membershipId,
              freezeMembership(membership),
            );
            this._failOrdinaryMindIfRequested("create_after_membership");
            const created = ordinaryMindSnapshotFromMaps(
              space.spaceId,
              candidateKnowledgeSpaces,
              candidateMemberships,
            );
            if (created === null) return Object.freeze({ kind: "invalid_record" });

            candidateIdempotencyRecords.set(
              idempotencyRecordKey,
              Object.freeze({
                operation: "create_space_with_owner" as const,
                principalId,
                key: records.idempotencyKey,
                canonicalRequestHash: records.canonicalRequestHash,
                mind: freezeOrdinaryMindSnapshot(created),
              }),
            );
            this._failOrdinaryMindIfRequested("create_after_idempotency");
            this._failOrdinaryMindIfRequested("create_before_commit");
            tx.knowledgeSpaces = candidateKnowledgeSpaces;
            tx.memberships = candidateMemberships;
            tx.revisionSpaces = candidateRevisionSpaces;
            tx.revisionsById = candidateRevisionsById;
            tx.idempotencyRecords = candidateIdempotencyRecords;
            tx.backgroundJobs = candidateBackgroundJobs;
            tx.indexStates = candidateIndexStates;
            tx.activeByHandle = candidateActiveByHandle;
            tx.activeBySpace = candidateActiveBySpace;
            tx.retired = candidateRetired;
            return Object.freeze({ kind: "created", mind: created, replayed: false });
          },

          renameOrdinaryMind: async (
            request: Readonly<RenameOrdinaryMindRequest>,
          ): Promise<RenameOrdinaryMindResult> => {
            const idempotencyRecordKey = ordinaryMindRenameIdempotencyKey(
              request.principalId,
              request.spaceId,
              request.idempotencyKey,
            );
            const principal = tx.principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const personalBinding = [...tx.personalBindings.values()].find(
              (binding) => binding.spaceId === request.spaceId,
            );
            if (personalBinding) {
              return Object.freeze({
                kind:
                  personalBinding.principalId === request.principalId
                    ? "personal_mind"
                    : "mind_not_found",
              });
            }
            const space = tx.knowledgeSpaces.get(request.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }

            const aggregateMemberships = [...tx.memberships.values()].filter(
              (membership) => membership.spaceId === request.spaceId,
            );
            let currentAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
            try {
              currentAggregate = SpaceAggregate.restoreOrdinary({
                space,
                memberships: aggregateMemberships,
              });
            } catch {
              return Object.freeze({ kind: "invalid_record" });
            }
            const currentMembership = currentAggregate
              .snapshot()
              .memberships.find(
                (membership) =>
                  membership.principalId === request.principalId &&
                  membership.state === "active",
              );
            if (
              !currentMembership ||
              !roleHasCapability(currentMembership.role, "settings:configure")
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            if (
              Object.prototype.hasOwnProperty.call(request, "description") &&
              request.description === null &&
              [...tx.principalMindUsageOwners.values()].some((owner) =>
                owner.state.ordinaryWriteGeneration?.spaceId === request.spaceId)
            ) {
              return Object.freeze({ kind: "description_required_for_write" });
            }

            const previous = tx.idempotencyRecords.get(idempotencyRecordKey);
            if (previous) {
              if (
                previous.operation !== "rename_space" ||
                previous.canonicalRequestHash !== request.canonicalRequestHash
              ) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({
                kind: "renamed",
                mind: freezeOrdinaryMindSnapshot(previous.mind),
                replayed: true,
              });
            }
            if (!SHA256_PATTERN.test(request.canonicalRequestHash)) {
              return Object.freeze({ kind: "invalid_record" });
            }
            let renamedAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
            try {
              renamedAggregate = currentAggregate.updateMetadata({
                actorPrincipalId: request.principalId,
                ...(request.displayName === undefined
                  ? {}
                  : { name: request.displayName }),
                ...(Object.prototype.hasOwnProperty.call(request, "description")
                  ? { description: request.description }
                  : {}),
                expectedMetadataVersion: request.expectedMetadataVersion,
                occurredAt: request.occurredAt,
              });
            } catch (error) {
              if (error instanceof DomainInvariantError) {
                if (error.code === "stale_version") {
                  return Object.freeze({
                    kind: "metadata_conflict",
                    currentMetadataVersion: space.metadataVersion,
                  });
                }
                if (error.code === "settings_permission_required") {
                  return Object.freeze({ kind: "forbidden" });
                }
                if (error.code === "space_not_active") {
                  return Object.freeze({ kind: "mind_not_found" });
                }
              }
              return Object.freeze({ kind: "invalid_record" });
            }

            const candidateKnowledgeSpaces = cloneRecordMap(
              tx.knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
            const renamedSnapshot = renamedAggregate.snapshot();
            candidateKnowledgeSpaces.set(
              request.spaceId,
              freezeKnowledgeSpace(renamedSnapshot.space),
            );
            this._failOrdinaryMindIfRequested("rename_after_space");
            const renamed = ordinaryMindSnapshotFromMaps(
              request.spaceId,
              candidateKnowledgeSpaces,
              tx.memberships,
            );
            if (renamed === null) return Object.freeze({ kind: "invalid_record" });
            candidateIdempotencyRecords.set(
              idempotencyRecordKey,
              Object.freeze({
                operation: "rename_space" as const,
                principalId: request.principalId,
                spaceId: request.spaceId,
                key: request.idempotencyKey,
                canonicalRequestHash: request.canonicalRequestHash,
                mind: freezeOrdinaryMindSnapshot(renamed),
              }),
            );
            this._failOrdinaryMindIfRequested("rename_after_idempotency");
            this._failOrdinaryMindIfRequested("rename_before_commit");
            tx.knowledgeSpaces = candidateKnowledgeSpaces;
            tx.idempotencyRecords = candidateIdempotencyRecords;
            return Object.freeze({ kind: "renamed", mind: renamed, replayed: false });
          },

          changeOrdinaryMindVisibility: async (
            request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
          ): Promise<ChangeOrdinaryMindVisibilityResult> => {
            const principal = tx.principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const space = tx.knowledgeSpaces.get(request.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personalBinding = [...tx.personalBindings.values()].find(
              (binding) => binding.spaceId === request.spaceId,
            );
            if (personalBinding) {
              return Object.freeze({
                kind:
                  personalBinding.principalId === request.principalId
                    ? "personal_mind"
                    : "mind_not_found",
              });
            }

            const aggregateMemberships = [...tx.memberships.values()].filter(
              (membership) => membership.spaceId === request.spaceId,
            );
            let currentAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
            try {
              currentAggregate = SpaceAggregate.restoreOrdinary({
                space,
                memberships: aggregateMemberships,
              });
            } catch {
              return Object.freeze({ kind: "invalid_record" });
            }
            const currentOwner = currentAggregate
              .snapshot()
              .memberships.find(
                (membership) =>
                  membership.principalId === request.principalId &&
                  membership.state === "active" &&
                  membership.role === "owner",
              );
            if (!currentOwner) return Object.freeze({ kind: "forbidden" });

            const idempotencyRecordKey = ordinaryMindVisibilityIdempotencyKey(
              request.principalId,
              request.spaceId,
              request.idempotencyKey,
            );
            const previous = tx.idempotencyRecords.get(idempotencyRecordKey);
            if (previous) {
              if (
                previous.operation !== "change_visibility" ||
                previous.canonicalRequestHash !== request.canonicalRequestHash
              ) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({
                kind: "visibility_changed",
                mind: freezeOrdinaryMindSnapshot(previous.mind),
                changed: previous.changed,
                replayed: true,
              });
            }
            if (!SHA256_PATTERN.test(request.canonicalRequestHash)) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (space.metadataVersion !== request.expectedMetadataVersion) {
              return Object.freeze({
                kind: "metadata_conflict",
                currentMetadataVersion: space.metadataVersion,
              });
            }
            if (space.visibility === request.visibility) {
              const current = ordinaryMindSnapshotFromMaps(
                request.spaceId,
                tx.knowledgeSpaces,
                tx.memberships,
              );
              if (current === null) return Object.freeze({ kind: "invalid_record" });
              const candidateIdempotencyRecords =
                cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
              candidateIdempotencyRecords.set(
                idempotencyRecordKey,
                Object.freeze({
                  operation: "change_visibility" as const,
                  principalId: request.principalId,
                  spaceId: request.spaceId,
                  key: request.idempotencyKey,
                  canonicalRequestHash: request.canonicalRequestHash,
                  mind: freezeOrdinaryMindSnapshot(current),
                  changed: false,
                }),
              );
              this._failOrdinaryMindIfRequested("visibility_after_idempotency");
              this._failOrdinaryMindIfRequested("visibility_before_commit");
              tx.idempotencyRecords = candidateIdempotencyRecords;
              return Object.freeze({
                kind: "visibility_changed",
                mind: current,
                changed: false,
                replayed: false,
              });
            }
            if (
              space.visibility === "private" &&
              request.visibility !== "private" &&
              !request.acknowledgeLiveHeadAndHistoryExposure
            ) {
              return Object.freeze({
                kind: "exposure_acknowledgement_required",
              });
            }

            let changedAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
            try {
              changedAggregate = currentAggregate.changeVisibility({
                actorPrincipalId: request.principalId,
                visibility: request.visibility,
                expectedMetadataVersion: request.expectedMetadataVersion,
                occurredAt: request.occurredAt,
              });
            } catch (error) {
              if (error instanceof DomainInvariantError) {
                if (error.code === "stale_version") {
                  return Object.freeze({
                    kind: "metadata_conflict",
                    currentMetadataVersion: space.metadataVersion,
                  });
                }
                if (error.code === "owner_required") {
                  return Object.freeze({ kind: "forbidden" });
                }
                if (error.code === "space_not_active") {
                  return Object.freeze({ kind: "mind_not_found" });
                }
                if (error.code === "personal_visibility") {
                  return Object.freeze({ kind: "personal_mind" });
                }
              }
              return Object.freeze({ kind: "invalid_record" });
            }

            const candidateKnowledgeSpaces = cloneRecordMap(
              tx.knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
            const candidateAuditEvents = new Map(
              [...tx.auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
            );
            const candidateAuditOutbox = new Map(
              [...tx.auditOutbox].map(([id, message]) => [
                id,
                cloneAuditOutbox(message),
              ]),
            );
            const changedSnapshot = changedAggregate.snapshot();
            candidateKnowledgeSpaces.set(
              request.spaceId,
              freezeKnowledgeSpace(changedSnapshot.space),
            );
            this._failOrdinaryMindIfRequested("visibility_after_space");
            const candidatePublicCatalogSpaceIds =
              derivePublicMindCatalogSpaceIds(
                candidateKnowledgeSpaces,
                tx.personalBindings,
              );
            const candidatePublicCatalogSnapshots = clonePublicCatalogSnapshots(
              tx.publicCatalogSnapshots,
            );
            const candidatePublicCatalogGeneration = tx.publicCatalogGeneration + 1;
            stagePublicCatalogSnapshot(
              candidatePublicCatalogGeneration,
              candidatePublicCatalogSpaceIds,
              candidatePublicCatalogSnapshots,
            );
            this._failOrdinaryMindIfRequested("visibility_after_catalog");
            if (
              !stageVisibilityAuditEffects(
                request,
                space,
                changedSnapshot.space,
                candidateAuditEvents,
                candidateAuditOutbox,
              )
            ) {
              return Object.freeze({ kind: "effect_conflict" });
            }
            this._failOrdinaryMindIfRequested("visibility_after_audit");
            const changed = ordinaryMindSnapshotFromMaps(
              request.spaceId,
              candidateKnowledgeSpaces,
              tx.memberships,
            );
            if (changed === null) return Object.freeze({ kind: "invalid_record" });
            candidateIdempotencyRecords.set(
              idempotencyRecordKey,
              Object.freeze({
                operation: "change_visibility" as const,
                principalId: request.principalId,
                spaceId: request.spaceId,
                key: request.idempotencyKey,
                canonicalRequestHash: request.canonicalRequestHash,
                mind: freezeOrdinaryMindSnapshot(changed),
                changed: true,
              }),
            );
            this._failOrdinaryMindIfRequested("visibility_after_idempotency");
            this._failOrdinaryMindIfRequested("visibility_before_commit");
            tx.knowledgeSpaces = candidateKnowledgeSpaces;
            tx.publicCatalogGeneration = candidatePublicCatalogGeneration;
            tx.publicCatalogSpaceIds = candidatePublicCatalogSpaceIds;
            tx.publicCatalogSnapshots = candidatePublicCatalogSnapshots;
            tx.idempotencyRecords = candidateIdempotencyRecords;
            tx.auditEvents = candidateAuditEvents;
            tx.auditOutbox = candidateAuditOutbox;
            return Object.freeze({
              kind: "visibility_changed",
              mind: changed,
              changed: true,
              replayed: false,
            });
          },

          transferOrdinaryMindOwnership: async (
            request: Readonly<TransferOrdinaryMindOwnershipRequest>,
          ): Promise<TransferOrdinaryMindOwnershipResult> => {
            const principal = tx.principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const space = tx.knowledgeSpaces.get(request.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personalBinding = [...tx.personalBindings.values()].find(
              (binding) => binding.spaceId === request.spaceId,
            );
            if (personalBinding) {
              return Object.freeze({
                kind:
                  personalBinding.principalId === request.principalId
                    ? "personal_mind"
                    : "mind_not_found",
              });
            }

            const recordKey = ownershipTransferIdempotencyKey(
              request.principalId,
              request.spaceId,
              request.idempotencyKey,
            );
            const previous = tx.idempotencyRecords.get(recordKey);
            if (previous) {
              if (
                previous.operation !== "transfer_ownership" ||
                previous.canonicalRequestHash !== request.canonicalRequestHash
              ) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              const current = ownershipTransferSnapshotFromMaps(
                request.spaceId,
                previous.transfer.sourceMembership.membershipId,
                previous.transfer.targetMembership.membershipId,
                tx.knowledgeSpaces,
                tx.memberships,
              );
              if (
                current === null ||
                !sameOwnershipTransferSnapshot(current, previous.transfer)
              ) {
                return Object.freeze({ kind: "ownership_state_changed" });
              }
              return Object.freeze({
                kind: "transferred",
                transfer: current,
                replayed: true,
              });
            }
            if (
              !SHA256_PATTERN.test(request.canonicalRequestHash) ||
              typeof request.targetMembershipId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(request.targetMembershipId) ||
              typeof request.requestId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(request.requestId) ||
              typeof request.auditEventId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
              typeof request.auditOutboxMessageId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
              !Number.isFinite(Date.parse(request.occurredAt))
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (space.metadataVersion !== request.expectedMetadataVersion) {
              return Object.freeze({
                kind: "metadata_conflict",
                currentMetadataVersion: space.metadataVersion,
              });
            }

            const aggregateMemberships = [...tx.memberships.values()].filter(
              (membership) => membership.spaceId === request.spaceId,
            );
            const aggregateInvitations = [...tx.invitations.values()].filter(
              (invitation) => invitation.spaceId === request.spaceId,
            );
            const source = aggregateMemberships.find(
              (membership) =>
                membership.principalId === request.principalId &&
                membership.state === "active",
            );
            const target = tx.memberships.get(request.targetMembershipId);
            if (!source || source.role !== "owner") {
              return Object.freeze({ kind: "forbidden" });
            }
            if (
              !target ||
              target.spaceId !== request.spaceId ||
              target.state !== "active" ||
              target.role === "owner" ||
              target.principalId === request.principalId
            ) {
              return Object.freeze({ kind: "ownership_target_invalid" });
            }
            if (
              source.version !== request.expectedSourceMembershipVersion ||
              target.version !== request.expectedTargetMembershipVersion
            ) {
              return Object.freeze({ kind: "ownership_state_changed" });
            }
            const targetSpaceIds = new Set(ownedCapacitySpaceIds(
              target.principalId,
              tx.revisionSpaces,
              tx.knowledgeSpaces,
              tx.memberships,
            ));
            targetSpaceIds.add(request.spaceId);
            const targetUsage = capacityUsageFromCanonicalState({
              spaceIds: targetSpaceIds,
              spaces: tx.revisionSpaces,
              stagedBundleFiles: this._stagedBundleFiles,
              exportJobs: tx.exportJobs,
              markdownImportPlans: this._markdownImportPlans,
              markdownImportSessions: this._markdownImportSessions,
              markdownImportStagedFiles: this._markdownImportStagedFiles,
              reservations: this._capacityReservations,
              reconciledAt: this._capacityReconciledAt,
            });
            const targetReserved = activeReservationAmounts(
              this._capacityReservations,
              (reservation) => targetSpaceIds.has(reservation.spaceId),
            );
            const principalLimit = request.capacityLimits.principalPhysicalCanonicalBytes;
            if (
              targetUsage.trustworthy !== true ||
              !Number.isSafeInteger(principalLimit) ||
              principalLimit <= 0
            ) {
              return Object.freeze({ kind: "capacity_accounting_untrusted" });
            }
            const projectedPrincipalCanonicalBytes =
              targetUsage.physicalCanonicalBytes +
              targetReserved.physicalCanonicalBytes;
            if (projectedPrincipalCanonicalBytes / principalLimit >= 0.85) {
              return Object.freeze({
                kind: "ownership_target_capacity_exceeded",
              });
            }

            let transferredAggregate: ReturnType<
              typeof SpaceAggregate.restoreOrdinary
            >;
            try {
              transferredAggregate = SpaceAggregate.restoreOrdinary({
                space,
                memberships: aggregateMemberships,
                invitations: aggregateInvitations,
              }).transferOwnership({
                sourcePrincipalId: request.principalId,
                targetPrincipalId: target.principalId,
                expectedMetadataVersion: request.expectedMetadataVersion,
                expectedSourceMembershipVersion:
                  request.expectedSourceMembershipVersion,
                expectedTargetMembershipVersion:
                  request.expectedTargetMembershipVersion,
                occurredAt: request.occurredAt,
              });
            } catch (error) {
              if (error instanceof DomainInvariantError) {
                if (error.code === "stale_version") {
                  return Object.freeze({
                    kind: "metadata_conflict",
                    currentMetadataVersion: space.metadataVersion,
                  });
                }
                if (error.code === "owner_required") {
                  return Object.freeze({ kind: "forbidden" });
                }
                if (error.code === "ownership_target_invalid") {
                  return Object.freeze({ kind: "ownership_target_invalid" });
                }
                if (error.code === "space_not_active") {
                  return Object.freeze({ kind: "mind_not_found" });
                }
              }
              return Object.freeze({ kind: "invalid_record" });
            }

            const updated = transferredAggregate.snapshot();
            const candidateKnowledgeSpaces = cloneRecordMap(
              tx.knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateMemberships = cloneRecordMap(
              tx.memberships,
              freezeMembership,
            );
            const candidateAuditEvents = new Map(
              [...tx.auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
            );
            const candidateAuditOutbox = new Map(
              [...tx.auditOutbox].map(([id, message]) => [
                id,
                cloneAuditOutbox(message),
              ]),
            );
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
            candidateKnowledgeSpaces.set(
              request.spaceId,
              freezeKnowledgeSpace(updated.space),
            );
            this._failOrdinaryMindIfRequested("ownership_after_space");
            for (const membership of updated.memberships) {
              candidateMemberships.set(
                membership.membershipId,
                freezeMembership(membership),
              );
            }
            this._failOrdinaryMindIfRequested("ownership_after_memberships");
            const currentSource = candidateMemberships.get(source.membershipId);
            const currentTarget = candidateMemberships.get(target.membershipId);
            if (!currentSource || !currentTarget) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const transfer = ownershipTransferSnapshotFromMaps(
              request.spaceId,
              currentSource.membershipId,
              currentTarget.membershipId,
              candidateKnowledgeSpaces,
              candidateMemberships,
            );
            if (transfer === null) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (
              !stageOwnershipTransferAuditEffects(
                request,
                space,
                updated.space,
                source,
                currentSource,
                target,
                currentTarget,
                candidateAuditEvents,
                candidateAuditOutbox,
              )
            ) {
              return Object.freeze({ kind: "effect_conflict" });
            }
            this._failOrdinaryMindIfRequested("ownership_after_audit");
            candidateIdempotencyRecords.set(
              recordKey,
              Object.freeze({
                operation: "transfer_ownership" as const,
                principalId: request.principalId,
                spaceId: request.spaceId,
                key: request.idempotencyKey,
                canonicalRequestHash: request.canonicalRequestHash,
                transfer: freezeOwnershipTransferSnapshot(transfer),
              }),
            );
            this._failOrdinaryMindIfRequested("ownership_after_idempotency");
            this._failOrdinaryMindIfRequested("ownership_before_commit");
            tx.knowledgeSpaces = candidateKnowledgeSpaces;
            tx.memberships = candidateMemberships;
            tx.auditEvents = candidateAuditEvents;
            tx.auditOutbox = candidateAuditOutbox;
            tx.idempotencyRecords = candidateIdempotencyRecords;
            return Object.freeze({
              kind: "transferred",
              transfer,
              replayed: false,
            });
          },

    });
  }
}
