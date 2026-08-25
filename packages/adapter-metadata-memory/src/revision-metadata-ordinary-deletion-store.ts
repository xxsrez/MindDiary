import {
  BOUNDED_OPAQUE_ID,
  accountDeletionFingerprint,
  accountDeletionSelection,
  cloneAccountDeletionCleanup,
  cloneAccountDeletionImpact,
  cloneAuditEvent,
  cloneEnvelope,
  cloneOrdinaryMindDeletionCleanup,
  cloneOrdinaryMindDeletionImpact,
  compareUnicodeScalarValues,
  derivePublicMindCatalogSpaceIds,
  ordinaryMindDeletionFingerprint,
  ordinaryMindSnapshotFromMaps,
  purgeMindBindingsForPrincipal,
  purgeMindBindingsForSpace,
  stagePublicCatalogSnapshot,
  targetRecordSelection,
  type Digest,
  type Envelope,
  type RevisionId,
} from "./metadata-store-internals.js";

import {
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
  type CompleteAccountDeletionCleanupRequest,
  type CompleteAccountDeletionCleanupResult,
  type CompleteOrdinaryMindDeletionCleanupRequest,
  type CompleteOrdinaryMindDeletionCleanupResult,
  type CreateAccountDeletionImpactRequest,
  type CreateAccountDeletionImpactResult,
  type CreateOrdinaryMindDeletionImpactRequest,
  type CreateOrdinaryMindDeletionImpactResult,
  type DeleteAccountCascadeRequest,
  type DeleteAccountCascadeResult,
  type DeleteOrdinaryMindRequest,
  type DeleteOrdinaryMindResult,
  type OrdinaryMindMetadataTransaction,
} from "@mind-diary/application-ports";

import {
  handleKey,
  retireHandleAgainst,
} from "./handle-registry.js";

import {
  accountDeletionState,
  ordinaryMindDeletionState,
  type OrdinaryMindTransactionState,
} from "./ordinary-mind-transaction-state.js";

import { RevisionMetadataOrdinaryLifecycleStore } from "./revision-metadata-ordinary-lifecycle-store.js";

export abstract class RevisionMetadataOrdinaryDeletionStore extends RevisionMetadataOrdinaryLifecycleStore {
  protected _deletionTransactionMethods(
    tx: OrdinaryMindTransactionState,
  ): Pick<OrdinaryMindMetadataTransaction,
    | "createOrdinaryMindDeletionImpact"
    | "deleteOrdinaryMind"
    | "completeOrdinaryMindDeletionCleanup"
    | "createAccountDeletionImpact"
    | "deleteAccountCascade"
    | "completeAccountDeletionCleanup"
  > {
    return Object.freeze({
          createOrdinaryMindDeletionImpact: async (
            request: Readonly<CreateOrdinaryMindDeletionImpactRequest>,
          ): Promise<CreateOrdinaryMindDeletionImpactResult> => {
            const parsed = parseCanonicalSpaceHandle(request.handle);
            const occurredAt = Date.parse(request.occurredAt);
            const expiresAt = Date.parse(request.expiresAt);
            if (
              parsed.kind !== "valid" ||
              isReservedTopLevelHandle(parsed.canonicalHandle) ||
              parsed.canonicalHandle !== request.handle ||
              !BOUNDED_OPAQUE_ID.test(request.impactId) ||
              !Number.isFinite(occurredAt) ||
              !Number.isFinite(expiresAt) ||
              expiresAt <= occurredAt
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            for (const [impactId, candidate] of tx.deletionImpacts) {
              if (Date.parse(candidate.expiresAt) <= occurredAt) {
                tx.deletionImpacts.delete(impactId);
              }
            }
            if (
              tx.deletionImpacts.has(request.impactId) ||
              tx.deletionCleanup.has(request.impactId)
            ) {
              return Object.freeze({ kind: "impact_id_collision" });
            }
            const principal = tx.principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const reservation = tx.activeByHandle.get(
              handleKey(request.host, parsed.canonicalHandle),
            );
            if (!reservation) return Object.freeze({ kind: "mind_not_found" });
            const space = tx.knowledgeSpaces.get(reservation.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personal = [...tx.personalBindings.values()].find(
              (binding) => binding.spaceId === space.spaceId,
            );
            if (personal) {
              return Object.freeze({
                kind:
                  personal.principalId === request.principalId
                    ? "personal_mind"
                    : "mind_not_found",
              });
            }
            const aggregate = ordinaryMindSnapshotFromMaps(
              space.spaceId,
              tx.knowledgeSpaces,
              tx.memberships,
            );
            if (aggregate === null) return Object.freeze({ kind: "invalid_record" });
            if (
              aggregate.ownerMembership.principalId !== request.principalId ||
              aggregate.ownerMembership.state !== "active" ||
              aggregate.ownerMembership.role !== "owner"
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            const stateFingerprint = ordinaryMindDeletionFingerprint(
              space.spaceId,
              ordinaryMindDeletionState(tx),
            );
            const revisionState = tx.revisionSpaces.get(space.spaceId);
            if (stateFingerprint === null || !revisionState) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const selected = targetRecordSelection(space.spaceId, ordinaryMindDeletionState(tx));
            const impact = cloneOrdinaryMindDeletionImpact({
              impactId: request.impactId,
              principalId: request.principalId,
              host: request.host,
              spaceId: space.spaceId,
              canonicalHandle: parsed.canonicalHandle,
              name: space.name,
              expiresAt: request.expiresAt,
              metadataVersion: space.metadataVersion,
              accessVersion: space.accessVersion,
              headRevisionId: space.headRevisionId,
              revisionCount: selected.revisionIds.length,
              membershipCount: selected.membershipIds.length,
              invitationCount: selected.invitationIds.length,
              backgroundJobCount: selected.backgroundJobIds.length,
              exportJobCount: selected.exportJobIds.length,
              stateFingerprint,
            });
            tx.deletionImpacts.set(impact.impactId, impact);
            this._failOrdinaryMindIfRequested("deletion_impact_after_record");
            this._failOrdinaryMindIfRequested("deletion_impact_before_commit");
            return Object.freeze({ kind: "created", impact });
          },

          deleteOrdinaryMind: async (
            request: Readonly<DeleteOrdinaryMindRequest>,
          ): Promise<DeleteOrdinaryMindResult> => {
            const parsed = parseCanonicalSpaceHandle(request.handle);
            if (
              parsed.kind !== "valid" ||
              isReservedTopLevelHandle(parsed.canonicalHandle) ||
              parsed.canonicalHandle !== request.handle ||
              !BOUNDED_OPAQUE_ID.test(request.impactId) ||
              !Number.isFinite(Date.parse(request.occurredAt))
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const reservation = tx.activeByHandle.get(
              handleKey(request.host, parsed.canonicalHandle),
            );
            if (!reservation) {
              const pending = [...tx.deletionCleanup.values()].find(
                (work) =>
                  work.host === request.host &&
                  work.canonicalHandle === parsed.canonicalHandle,
              );
              if (!pending) return Object.freeze({ kind: "already_absent" });
              if (
                pending.impactId !== request.impactId ||
                pending.principalId !== request.principalId
              ) {
                return Object.freeze({ kind: "mind_not_found" });
              }
              if (pending.idempotencyKey !== request.idempotencyKey) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({
                kind: "cleanup_pending",
                cleanup: cloneOrdinaryMindDeletionCleanup(pending),
              });
            }
            const principal = tx.principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const spaceId = reservation.spaceId;
            const space = tx.knowledgeSpaces.get(spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personal = [...tx.personalBindings.values()].find(
              (binding) => binding.spaceId === spaceId,
            );
            if (personal) {
              return Object.freeze({
                kind:
                  personal.principalId === request.principalId
                    ? "personal_mind"
                    : "mind_not_found",
              });
            }
            const aggregate = ordinaryMindSnapshotFromMaps(
              spaceId,
              tx.knowledgeSpaces,
              tx.memberships,
            );
            if (aggregate === null) return Object.freeze({ kind: "invalid_record" });
            if (
              aggregate.ownerMembership.principalId !== request.principalId ||
              aggregate.ownerMembership.state !== "active" ||
              aggregate.ownerMembership.role !== "owner"
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            const impact = tx.deletionImpacts.get(request.impactId);
            if (
              !impact ||
              impact.principalId !== request.principalId ||
              impact.spaceId !== spaceId ||
              impact.host !== request.host ||
              impact.canonicalHandle !== parsed.canonicalHandle
            ) {
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
            if (Date.parse(request.occurredAt) >= Date.parse(impact.expiresAt)) {
              tx.deletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_expired" });
            }
            const currentFingerprint = ordinaryMindDeletionFingerprint(
              spaceId,
              ordinaryMindDeletionState(tx),
            );
            if (
              currentFingerprint === null ||
              currentFingerprint !== impact.stateFingerprint
            ) {
              tx.deletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
            if (tx.deletionCleanup.has(request.impactId)) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const selected = targetRecordSelection(spaceId, ordinaryMindDeletionState(tx));
            const targetRevisions = tx.revisionSpaces.get(spaceId)?.revisions;
            if (!targetRevisions) return Object.freeze({ kind: "invalid_record" });
            const targetDigests = new Set<Digest>();
            for (const envelope of targetRevisions.values()) {
              for (const entry of envelope.manifest.entries) {
                targetDigests.add(entry.sha256);
              }
            }
            const remainingReachable = new Set<Digest>();
            for (const [candidateSpaceId, state] of tx.revisionSpaces) {
              if (candidateSpaceId === spaceId) continue;
              for (const envelope of state.revisions.values()) {
                for (const entry of envelope.manifest.entries) {
                  remainingReachable.add(entry.sha256);
                }
              }
            }
            const cleanup = cloneOrdinaryMindDeletionCleanup({
              impactId: request.impactId,
              idempotencyKey: request.idempotencyKey,
              principalId: request.principalId,
              spaceId,
              host: request.host,
              canonicalHandle: parsed.canonicalHandle,
              objectDigests: Object.freeze(
                [...targetDigests]
                  .filter((digest) => !remainingReachable.has(digest))
                  .sort(),
              ),
              deleteBefore: request.occurredAt,
            });

            const retiredResult = retireHandleAgainst(
              {
                host: request.host,
                handle: parsed.canonicalHandle,
                spaceId,
              },
              {
                activeByHandle: tx.activeByHandle,
                activeBySpace: tx.activeBySpace,
                retired: tx.retired,
              },
            );
            if (retiredResult.kind !== "retired") {
              return Object.freeze({ kind: "invalid_record" });
            }
            this._failOrdinaryMindIfRequested("delete_after_handle_retirement");

            tx.knowledgeSpaces.delete(spaceId);
            selected.membershipIds.forEach((id) => tx.memberships.delete(id));
            selected.invitationIds.forEach((id) => tx.invitations.delete(id));
            tx.revisionSpaces.delete(spaceId);
            selected.revisionIds.forEach((id) => tx.revisionsById.delete(id));
            selected.ordinaryIdempotencyKeys.forEach((key) =>
              tx.idempotencyRecords.delete(key));
            selected.contentIdempotencyKeys.forEach((key) =>
              tx.contentIdempotencyRecords.delete(key));
            for (const key of tx.membershipMutationRecords.keys()) {
              if (key.split("\u0000")[1] === spaceId) {
                tx.membershipMutationRecords.delete(key);
              }
            }
            selected.backgroundJobIds.forEach((id) => tx.backgroundJobs.delete(id));
            selected.exportJobIds.forEach((id) => tx.exportJobs.delete(id));
            selected.exportGrantKeys.forEach((key) =>
              tx.exportDownloadGrants.delete(key));
            selected.bundleFileDownloadGrantKeys.forEach((key) =>
              tx.bundleFileDownloadGrants.delete(key));
            selected.indexKeys.forEach((key) => tx.indexStates.delete(key));
            selected.outboxIds.forEach((id) => tx.auditOutbox.delete(id));
            selected.auditIds.forEach((id) => tx.auditEvents.delete(id));
            for (const [key, state] of tx.authorizationStates) {
              if (state.space.spaceId === spaceId) tx.authorizationStates.delete(key);
            }
            for (const [impactId, candidate] of tx.deletionImpacts) {
              if (candidate.spaceId === spaceId) tx.deletionImpacts.delete(impactId);
            }
            purgeMindBindingsForSpace(
              tx.mindBindingOwners,
              spaceId,
              request.occurredAt,
            );
            this._failOrdinaryMindIfRequested("delete_after_target_records");

            tx.publicCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
              tx.knowledgeSpaces,
              tx.personalBindings,
            );
            tx.publicCatalogGeneration += 1;
            stagePublicCatalogSnapshot(
              tx.publicCatalogGeneration,
              tx.publicCatalogSpaceIds,
              tx.publicCatalogSnapshots,
            );
            this._failOrdinaryMindIfRequested("delete_after_catalog");
            tx.deletionCleanup.set(cleanup.impactId, cleanup);
            this._failOrdinaryMindIfRequested("delete_after_cleanup_work");
            this._failOrdinaryMindIfRequested("delete_before_commit");
            return Object.freeze({
              kind: "deleted",
              cleanup,
              counts: Object.freeze({
                revisions: selected.revisionIds.length,
                memberships: selected.membershipIds.length,
                invitations: selected.invitationIds.length,
                backgroundJobs: selected.backgroundJobIds.length,
                exportJobs: selected.exportJobIds.length,
                exportDownloadGrants: selected.exportGrantKeys.length,
                bundleFileDownloadGrants:
                  selected.bundleFileDownloadGrantKeys.length,
                indexStates: selected.indexKeys.length,
                auditEvents: selected.auditIds.length,
                auditOutboxMessages: selected.outboxIds.length,
                idempotencyRecords:
                  selected.ordinaryIdempotencyKeys.length +
                  selected.contentIdempotencyKeys.length,
              }),
            });
          },

          completeOrdinaryMindDeletionCleanup: async (
            request: Readonly<CompleteOrdinaryMindDeletionCleanupRequest>,
          ): Promise<CompleteOrdinaryMindDeletionCleanupResult> => {
            const parsed = parseCanonicalSpaceHandle(request.handle);
            if (
              parsed.kind !== "valid" ||
              parsed.canonicalHandle !== request.handle
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const pending = tx.deletionCleanup.get(request.impactId);
            if (
              !pending ||
              pending.spaceId !== request.spaceId ||
              pending.host !== request.host ||
              pending.canonicalHandle !== parsed.canonicalHandle
            ) {
              return Object.freeze({ kind: "not_found" });
            }
            tx.deletionCleanup.delete(request.impactId);
            this._failOrdinaryMindIfRequested("delete_cleanup_before_commit");
            return Object.freeze({ kind: "completed" });
          },

          createAccountDeletionImpact: async (
            request: Readonly<CreateAccountDeletionImpactRequest>,
          ): Promise<CreateAccountDeletionImpactResult> => {
            const occurredAt = Date.parse(request.occurredAt);
            const expiresAt = Date.parse(request.expiresAt);
            if (
              !BOUNDED_OPAQUE_ID.test(request.impactId) ||
              !BOUNDED_OPAQUE_ID.test(request.deletedPrincipalId) ||
              !Number.isFinite(occurredAt) ||
              !Number.isFinite(expiresAt) ||
              expiresAt <= occurredAt ||
              !Number.isSafeInteger(request.activeTokenCount) ||
              request.activeTokenCount < 0 ||
              typeof request.tokenStateFingerprint !== "string" ||
              request.tokenStateFingerprint.length === 0
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            for (const [impactId, candidate] of tx.accountDeletionImpacts) {
              if (Date.parse(candidate.expiresAt) <= occurredAt) {
                tx.accountDeletionImpacts.delete(impactId);
              }
            }
            if (
              tx.accountDeletionImpacts.has(request.impactId) ||
              tx.accountDeletionCleanup.has(request.impactId)
            ) {
              return Object.freeze({ kind: "impact_id_collision" });
            }
            const selected = accountDeletionSelection(
              request.principalId,
              request.host,
              accountDeletionState(tx),
            );
            const metadataStateFingerprint = accountDeletionFingerprint(
              request.principalId,
              request.host,
              accountDeletionState(tx),
            );
            if (!selected || metadataStateFingerprint === null) {
              return Object.freeze({ kind: "account_not_found" });
            }
            const impact = cloneAccountDeletionImpact({
              impactId: request.impactId,
              principalId: request.principalId,
              host: request.host,
              deletedPrincipalId: request.deletedPrincipalId,
              expiresAt: request.expiresAt,
              personalMind: Object.freeze({
                spaceId: selected.personalSpace.spaceId,
                name: selected.personalSpace.name,
                revisionCount: selected.personalRevisionCount,
              }),
              ownedMinds: selected.ownedMinds,
              foreignMembershipCount: selected.foreignActiveMembershipCount,
              pendingInvitationCount: selected.pendingInvitationCount,
              activeTokenCount: request.activeTokenCount,
              metadataStateFingerprint,
              tokenStateFingerprint: request.tokenStateFingerprint,
            });
            tx.accountDeletionImpacts.set(impact.impactId, impact);
            this._failAccountDeletionIfRequested("impact_after_record");
            this._failAccountDeletionIfRequested("impact_before_commit");
            return Object.freeze({ kind: "created", impact });
          },

          deleteAccountCascade: async (
            request: Readonly<DeleteAccountCascadeRequest>,
          ): Promise<DeleteAccountCascadeResult> => {
            if (
              !BOUNDED_OPAQUE_ID.test(request.impactId) ||
              !BOUNDED_OPAQUE_ID.test(request.deletedPrincipalId) ||
              typeof request.tokenStateFingerprint !== "string" ||
              request.tokenStateFingerprint.length === 0 ||
              !Number.isFinite(Date.parse(request.occurredAt))
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const pending = tx.accountDeletionCleanup.get(request.impactId);
            if (pending) {
              if (pending.principalId !== request.principalId) {
                return Object.freeze({ kind: "account_not_found" });
              }
              if (pending.idempotencyKey !== request.idempotencyKey) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              if (
                pending.tokenStateFingerprint !== request.tokenStateFingerprint ||
                pending.deletedPrincipalId !== request.deletedPrincipalId
              ) {
                return Object.freeze({ kind: "deletion_impact_changed" });
              }
              return Object.freeze({
                kind: "cleanup_pending",
                cleanup: cloneAccountDeletionCleanup(pending),
              });
            }
            const impact = tx.accountDeletionImpacts.get(request.impactId);
            if (!impact || impact.principalId !== request.principalId) {
              return Object.freeze({ kind: "account_not_found" });
            }
            if (Date.parse(request.occurredAt) >= Date.parse(impact.expiresAt)) {
              tx.accountDeletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_expired" });
            }
            if (impact.tokenStateFingerprint !== request.tokenStateFingerprint) {
              tx.accountDeletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
            const currentSelection = accountDeletionSelection(
              request.principalId,
              impact.host,
              accountDeletionState(tx),
            );
            const currentFingerprint = accountDeletionFingerprint(
              request.principalId,
              impact.host,
              accountDeletionState(tx),
            );
            if (
              !currentSelection ||
              currentFingerprint === null ||
              currentFingerprint !== impact.metadataStateFingerprint
            ) {
              tx.accountDeletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
            if (
              currentSelection.ownedMinds.length !== impact.ownedMinds.length ||
              currentSelection.ownedMinds.some(
                (mind, index) =>
                  mind.spaceId !== impact.ownedMinds[index]?.spaceId ||
                  mind.host !== impact.ownedMinds[index]?.host ||
                  mind.canonicalHandle !==
                    impact.ownedMinds[index]?.canonicalHandle,
              )
            ) {
              tx.accountDeletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_changed" });
            }

            const targetSelections = new Map(
              currentSelection.deletedSpaceIds.map((spaceId) => [
                spaceId,
                targetRecordSelection(spaceId, ordinaryMindDeletionState(tx)),
              ]),
            );
            const targetDigests = new Set<Digest>();
            for (const spaceId of currentSelection.deletedSpaceIds) {
              const state = tx.revisionSpaces.get(spaceId);
              if (!state) return Object.freeze({ kind: "invalid_record" });
              for (const envelope of state.revisions.values()) {
                for (const entry of envelope.manifest.entries) {
                  targetDigests.add(entry.sha256);
                }
              }
            }
            const remainingReachable = new Set<Digest>();
            for (const [spaceId, state] of tx.revisionSpaces) {
              if (currentSelection.deletedSpaceIdSet.has(spaceId)) continue;
              for (const envelope of state.revisions.values()) {
                for (const entry of envelope.manifest.entries) {
                  remainingReachable.add(entry.sha256);
                }
              }
            }
            const cleanup = cloneAccountDeletionCleanup({
              impactId: request.impactId,
              idempotencyKey: request.idempotencyKey,
              principalId: request.principalId,
              deletedPrincipalId: request.deletedPrincipalId,
              deletedSpaceIds: currentSelection.deletedSpaceIds,
              objectDigests: Object.freeze(
                [...targetDigests]
                  .filter((digest) => !remainingReachable.has(digest))
                  .sort(compareUnicodeScalarValues),
              ),
              foreignExportJobIds: currentSelection.foreignExportJobIds,
              tokenStateFingerprint: request.tokenStateFingerprint,
              deleteBefore: request.occurredAt,
            });

            for (const mind of currentSelection.ownedMinds) {
              const reservation = tx.activeBySpace.get(mind.spaceId);
              if (
                !reservation ||
                reservation.host !== mind.host ||
                reservation.canonicalHandle !== mind.canonicalHandle
              ) {
                return Object.freeze({ kind: "deletion_impact_changed" });
              }
            }
            for (const mind of currentSelection.ownedMinds) {
              const retiredResult = retireHandleAgainst(
                {
                  host: mind.host,
                  handle: mind.canonicalHandle,
                  spaceId: mind.spaceId,
                },
                {
                  activeByHandle: tx.activeByHandle,
                  activeBySpace: tx.activeBySpace,
                  retired: tx.retired,
                },
              );
              if (retiredResult.kind !== "retired") {
                throw new Error("account deletion handle retirement changed");
              }
            }
            this._failAccountDeletionIfRequested("delete_after_handle_retirement");

            let revisionsDeleted = 0;
            let membershipsDeleted = 0;
            let invitationsDeleted = 0;
            for (const spaceId of currentSelection.deletedSpaceIds) {
              const records = targetSelections.get(spaceId)!;
              revisionsDeleted += records.revisionIds.length;
              membershipsDeleted += records.membershipIds.length;
              invitationsDeleted += records.invitationIds.length;
              tx.knowledgeSpaces.delete(spaceId);
              tx.revisionSpaces.delete(spaceId);
              records.revisionIds.forEach((id) => tx.revisionsById.delete(id));
              records.membershipIds.forEach((id) => tx.memberships.delete(id));
              records.invitationIds.forEach((id) => tx.invitations.delete(id));
              records.ordinaryIdempotencyKeys.forEach((key) =>
                tx.idempotencyRecords.delete(key),
              );
              records.contentIdempotencyKeys.forEach((key) =>
                tx.contentIdempotencyRecords.delete(key),
              );
              for (const key of tx.membershipMutationRecords.keys()) {
                if (key.split("\u0000")[1] === spaceId) {
                  tx.membershipMutationRecords.delete(key);
                }
              }
              records.backgroundJobIds.forEach((id) => tx.backgroundJobs.delete(id));
              records.exportJobIds.forEach((id) => tx.exportJobs.delete(id));
              records.exportGrantKeys.forEach((key) =>
                tx.exportDownloadGrants.delete(key),
              );
              records.bundleFileDownloadGrantKeys.forEach((key) =>
                tx.bundleFileDownloadGrants.delete(key),
              );
              records.indexKeys.forEach((key) => tx.indexStates.delete(key));
              records.outboxIds.forEach((id) => tx.auditOutbox.delete(id));
              records.auditIds.forEach((id) => tx.auditEvents.delete(id));
              for (const [impactId, candidate] of tx.deletionImpacts) {
                if (candidate.spaceId === spaceId) tx.deletionImpacts.delete(impactId);
              }
              purgeMindBindingsForSpace(
                tx.mindBindingOwners,
                spaceId,
                request.occurredAt,
              );
            }
            this._failAccountDeletionIfRequested("delete_after_target_records");

            let foreignRevisionAuthorsTombstoned = 0;
            for (const [spaceId, state] of tx.revisionSpaces) {
              const revised = new Map<RevisionId, Envelope>();
              for (const [revisionId, envelope] of state.revisions) {
                let retained = envelope;
                if (
                  envelope.revision.committedBy.kind === "principal" &&
                  envelope.revision.committedBy.principalId === request.principalId
                ) {
                  retained = cloneEnvelope({
                    ...envelope,
                    revision: Object.freeze({
                      ...envelope.revision,
                      committedBy: Object.freeze({
                        kind: "deleted-principal" as const,
                        tombstoneId: request.deletedPrincipalId,
                      }),
                    }),
                  });
                  foreignRevisionAuthorsTombstoned += 1;
                }
                revised.set(revisionId, retained);
                tx.revisionsById.set(revisionId, retained);
              }
              tx.revisionSpaces.set(spaceId, { head: state.head, revisions: revised });
            }
            let foreignAuditActorsTombstoned = 0;
            for (const [auditEventId, event] of tx.auditEvents) {
              if (
                event.actor.kind !== "principal" ||
                event.actor.principalId !== request.principalId
              ) {
                continue;
              }
              tx.auditEvents.set(
                auditEventId,
                cloneAuditEvent({
                  ...event,
                  actor: Object.freeze({
                    kind: "deleted-principal" as const,
                    opaqueId: request.deletedPrincipalId,
                  }),
                }),
              );
              foreignAuditActorsTombstoned += 1;
            }
            this._failAccountDeletionIfRequested(
              "delete_after_foreign_tombstones",
            );

            for (const membershipId of currentSelection.foreignMembershipIds) {
              if (tx.memberships.delete(membershipId)) membershipsDeleted += 1;
            }
            const targetInvitationIdSet = new Set(
              currentSelection.targetInvitationIds,
            );
            for (const invitationId of targetInvitationIdSet) {
              if (tx.invitations.delete(invitationId)) invitationsDeleted += 1;
            }
            for (const [jobId, job] of tx.backgroundJobs) {
              if (
                job.target.kind === "expire_invitation" &&
                targetInvitationIdSet.has(job.target.invitationId)
              ) {
                tx.backgroundJobs.delete(jobId);
              }
            }
            const foreignExportJobIdSet = new Set(
              currentSelection.foreignExportJobIds,
            );
            foreignExportJobIdSet.forEach((id) => tx.exportJobs.delete(id));
            for (const [key, grant] of tx.exportDownloadGrants) {
              if (
                grant.requestedByPrincipalId === request.principalId ||
                foreignExportJobIdSet.has(grant.jobId)
              ) {
                tx.exportDownloadGrants.delete(key);
              }
            }
            for (const [key, grant] of tx.bundleFileDownloadGrants) {
              if (grant.requestedByPrincipalId === request.principalId) {
                tx.bundleFileDownloadGrants.delete(key);
              }
            }
            for (const [key, record] of tx.contentIdempotencyRecords) {
              if (record.principalId === request.principalId) {
                tx.contentIdempotencyRecords.delete(key);
              }
            }
            for (const [key, record] of tx.idempotencyRecords) {
              if (record.principalId === request.principalId) {
                tx.idempotencyRecords.delete(key);
              }
            }
            for (const [key, record] of tx.personalProfileIdempotencyRecords) {
              if (record.principalId === request.principalId) {
                tx.personalProfileIdempotencyRecords.delete(key);
              }
            }
            for (const key of tx.membershipMutationRecords.keys()) {
              if (key.split("\u0000")[0] === request.principalId) {
                tx.membershipMutationRecords.delete(key);
              }
            }
            const externalBindingKeys = [...tx.externalBindings]
              .filter(([, binding]) => binding.principalId === request.principalId)
              .map(([key]) => key);
            externalBindingKeys.forEach((key) => tx.externalBindings.delete(key));
            tx.personalBindings.delete(request.principalId);
            tx.principals.delete(request.principalId);
            tx.principalActivities.delete(request.principalId);
            purgeMindBindingsForPrincipal(
              tx.mindBindingOwners,
              request.principalId,
            );
            for (const [key, state] of tx.authorizationStates) {
              if (
                state.principal.principalId === request.principalId ||
                currentSelection.deletedSpaceIdSet.has(state.space.spaceId)
              ) {
                tx.authorizationStates.delete(key);
              }
            }
            this._failAccountDeletionIfRequested("delete_after_identity");

            tx.publicCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
              tx.knowledgeSpaces,
              tx.personalBindings,
            );
            tx.publicCatalogGeneration += 1;
            stagePublicCatalogSnapshot(
              tx.publicCatalogGeneration,
              tx.publicCatalogSpaceIds,
              tx.publicCatalogSnapshots,
            );
            for (const [impactId, candidate] of tx.accountDeletionImpacts) {
              if (candidate.principalId === request.principalId) {
                tx.accountDeletionImpacts.delete(impactId);
              }
            }
            tx.accountDeletionCleanup.set(cleanup.impactId, cleanup);
            this._failAccountDeletionIfRequested("delete_after_cleanup_work");
            this._failAccountDeletionIfRequested("delete_before_commit");
            return Object.freeze({
              kind: "deleted",
              cleanup,
              counts: Object.freeze({
                spaces: currentSelection.deletedSpaceIds.length,
                revisions: revisionsDeleted,
                memberships: membershipsDeleted,
                invitations: invitationsDeleted,
                externalBindings: externalBindingKeys.length,
                foreignRevisionAuthorsTombstoned,
                foreignAuditActorsTombstoned,
                foreignExportJobs: foreignExportJobIdSet.size,
              }),
            });
          },

          completeAccountDeletionCleanup: async (
            request: Readonly<CompleteAccountDeletionCleanupRequest>,
          ): Promise<CompleteAccountDeletionCleanupResult> => {
            const pending = tx.accountDeletionCleanup.get(request.impactId);
            if (!pending || pending.principalId !== request.principalId) {
              return Object.freeze({ kind: "not_found" });
            }
            tx.accountDeletionCleanup.delete(request.impactId);
            this._failAccountDeletionIfRequested("cleanup_before_commit");
            return Object.freeze({ kind: "completed" });
          },    });
  }
}
