import type {
  AccountDeletionState,
  Digest,
  Envelope,
  OrdinaryMindDeletionState,
  RevisionId,
} from "./metadata-store-internals.js";
import type {
  AccountBootstrapRecordSet,
  AccountBootstrapTransaction,
  ApplyMembershipMutationRequest,
  ApplyMembershipMutationResult,
  AuthorizationStateQuery,
  ChangeOrdinaryMindVisibilityRequest,
  ChangeOrdinaryMindVisibilityResult,
  CompleteAccountDeletionCleanupRequest,
  CompleteAccountDeletionCleanupResult,
  CompleteOrdinaryMindDeletionCleanupRequest,
  CompleteOrdinaryMindDeletionCleanupResult,
  CreateAccountBootstrapResult,
  CreateAccountDeletionImpactRequest,
  CreateAccountDeletionImpactResult,
  CreateInvitationRequest,
  CreateInvitationResult,
  CreateOrdinaryMindDeletionImpactRequest,
  CreateOrdinaryMindDeletionImpactResult,
  CreateOrdinaryMindResult,
  DeleteAccountCascadeRequest,
  DeleteAccountCascadeResult,
  DeleteOrdinaryMindRequest,
  DeleteOrdinaryMindResult,
  ExternalIdentityBindingLookup,
  MembershipControlTargetQuery,
  MembershipControlTransaction,
  OrdinaryMindMetadataTransaction,
  OrdinaryMindRecordSet,
  PersonalMindMetadataTransaction,
  PersonalMindTargetClassification,
  PersonalMindTargetRequest,
  PrincipalAccountSnapshot,
  RegisteredPrincipalSnapshot,
  ReissueInvitationRequest,
  ReissueInvitationResult,
  RenameOrdinaryMindRequest,
  RenameOrdinaryMindResult,
  RenamePersonalProfileRequest,
  RenamePersonalProfileResult,
  SpaceMembership,
  TransferOrdinaryMindOwnershipRequest,
  TransferOrdinaryMindOwnershipResult,
  TransitionInvitationRequest,
  TransitionInvitationResult,
} from "@mind-diary/application-ports";
import {
  handleKey,
  reserveHandleAgainst,
  retireHandleAgainst,
} from "./handle-registry.js";
import {
  BOUNDED_OPAQUE_ID,
  SHA256_PATTERN,
  accountByBindingFromMaps,
  accountDeletionFingerprint,
  accountDeletionSelection,
  accountFromMaps,
  activeReservationAmounts,
  capacityUsageFromCanonicalState,
  cloneAccountDeletionCleanup,
  cloneAccountDeletionCleanups,
  cloneAccountDeletionImpact,
  cloneAccountDeletionImpacts,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneAuthorizationState,
  cloneBackgroundJob,
  cloneBundleFileDownloadGrants,
  cloneEnvelope,
  cloneExportDownloadGrants,
  cloneExportJobs,
  cloneIdempotencyRecords,
  cloneIndexState,
  cloneMembershipMutationRecords,
  cloneMindBindingOwners,
  cloneOrdinaryMindDeletionCleanup,
  cloneOrdinaryMindDeletionCleanups,
  cloneOrdinaryMindDeletionImpact,
  cloneOrdinaryMindDeletionImpacts,
  cloneOrdinaryMindIdempotencyRecords,
  clonePersonalProfileIdempotencyRecords,
  clonePrincipalActivity,
  clonePublicCatalogSnapshots,
  cloneRecordMap,
  cloneSpaces,
  compareUnicodeScalarValues,
  currentSitesAuthorizationStateFromMaps,
  derivePublicMindCatalogSpaceIds,
  externalBindingKey,
  freezeExternalBinding,
  freezeInvitation,
  freezeInvitationLifecycleSnapshot,
  freezeInvitationSnapshot,
  freezeKnowledgeSpace,
  freezeMembership,
  freezeOrdinaryMindSnapshot,
  freezeOwnershipTransferSnapshot,
  freezePersonalBinding,
  freezePersonalMindProfile,
  freezePrincipal,
  freezeRegisteredPrincipalSnapshot,
  invitationIdempotencyRecordKey,
  invitationLifecycleActorIsCurrentlyAuthorized,
  invitationLifecycleIdempotencyRecordKey,
  membershipMutationKey,
  ordinaryMindCreateIdempotencyKey,
  ordinaryMindDeletionFingerprint,
  ordinaryMindRenameIdempotencyKey,
  ordinaryMindSnapshotFromMaps,
  ordinaryMindVisibilityIdempotencyKey,
  ownedCapacitySpaceIds,
  ownershipTransferIdempotencyKey,
  ownershipTransferSnapshotFromMaps,
  personalMindProfileFromAccount,
  personalProfileIdempotencyKey,
  purgeMindBindingsForPrincipal,
  purgeMindBindingsForSpace,
  readMembershipReplay,
  sameOwnershipTransferSnapshot,
  stageInitialRevisionIndexAgainst,
  stageOwnershipTransferAuditEffects,
  stagePublicCatalogSnapshot,
  stageVisibilityAuditEffects,
  targetRecordSelection,
  validateAccountBootstrapRecords,
  validateOrdinaryMindRecords,
} from "./metadata-store-internals.js";
import {
  DomainInvariantError,
  SpaceAggregate,
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
  revisionEnvelopesEqual,
  roleHasCapability,
  version,
} from "@mind-diary/application-ports";
import { RevisionMetadataReadStore } from "./revision-metadata-read-store.js";

export abstract class RevisionMetadataOrdinaryStore extends RevisionMetadataReadStore {
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

        const deletionState = (): OrdinaryMindDeletionState => ({
          knowledgeSpaces,
          memberships,
          invitations,
          revisionSpaces,
          ordinaryIdempotency: idempotencyRecords,
          contentIdempotency: contentIdempotencyRecords,
          auditEvents,
          auditOutbox,
          backgroundJobs,
          exportJobs,
          exportDownloadGrants,
          bundleFileDownloadGrants,
          indexStates,
          activeBySpace,
        });

        const accountState = (): AccountDeletionState => ({
          ...deletionState(),
          principals,
          externalBindings,
          personalBindings,
          personalProfileIdempotency: personalProfileIdempotencyRecords,
        });

        const transaction: OrdinaryMindMetadataTransaction = Object.freeze({
          kind: "authorization-transaction" as const,
          readMembershipControlTarget: async (
            query: Readonly<MembershipControlTargetQuery>,
          ) => {
            const space = knowledgeSpaces.get(query.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" as const });
            }
            const membership = [...memberships.values()].find(
              (candidate) =>
                candidate.spaceId === query.spaceId &&
                (query.memberId !== undefined
                  ? candidate.membershipId === query.memberId
                  : candidate.principalId === query.principalId),
            );
            if (!membership) {
              return Object.freeze({ kind: "membership_not_found" as const });
            }
            const personal = [...personalBindings.values()].some(
              (binding) => binding.spaceId === query.spaceId,
            );
            return Object.freeze({
              kind: "found" as const,
              mindKind: personal ? ("personal" as const) : ("ordinary" as const),
              membership: freezeMembership(membership),
            });
          },
          applyMembershipMutation: async (
            request: Readonly<ApplyMembershipMutationRequest>,
          ): Promise<ApplyMembershipMutationResult> => {
            const replay = readMembershipReplay(membershipMutationRecords, request);
            if (replay.kind === "idempotency_conflict") return replay;
            if (replay.kind === "replayed") {
              return Object.freeze({
                kind: "applied",
                membership: replay.membership,
                changed: replay.changed,
                replayed: true,
              });
            }
            if (
              !SHA256_PATTERN.test(request.canonicalRequestHash) ||
              !BOUNDED_OPAQUE_ID.test(request.requestId) ||
              !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
              !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
              !Number.isFinite(Date.parse(request.occurredAt))
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const principal = principals.get(request.principalId);
            const space = knowledgeSpaces.get(request.spaceId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            if (
              [...personalBindings.values()].some(
                (binding) => binding.spaceId === request.spaceId,
              )
            ) {
              return Object.freeze({ kind: "personal_mind" });
            }
            const source = [...memberships.values()].find(
              (candidate) =>
                candidate.spaceId === request.spaceId &&
                candidate.principalId === request.principalId &&
                candidate.state === "active",
            );
            const target = memberships.get(request.targetMembershipId);
            if (
              !source ||
              !target ||
              target.spaceId !== request.spaceId ||
              target.state !== "active"
            ) {
              return Object.freeze({ kind: "membership_not_found" });
            }
            if (target.role === "owner") {
              return Object.freeze({ kind: "owner_membership" });
            }
            if (target.version !== request.expectedMembershipVersion) {
              return Object.freeze({ kind: "membership_version_conflict" });
            }
            if (
              request.authorizationStamp.accessVersion !== space.accessVersion ||
              request.authorizationStamp.membershipVersion !== source.version ||
              request.authorizationStamp.tokenVersion !== null
            ) {
              return Object.freeze({ kind: "authorization_state_changed" });
            }
            if (!roleHasCapability(source.role, request.requiredCapability)) {
              return Object.freeze({ kind: "forbidden" });
            }
            if (request.operation === "leave_space") {
              if (source.membershipId !== target.membershipId) {
                return Object.freeze({ kind: "forbidden" });
              }
            } else {
              const required =
                target.role === "admin" || request.role === "admin"
                  ? "members:manage-admin"
                  : "members:manage-basic";
              if (request.requiredCapability !== required) {
                return Object.freeze({ kind: "forbidden" });
              }
            }
            const changed =
              request.operation === "change_membership_role"
                ? target.role !== request.role
                : true;
            if (
              request.operation === "change_membership_role" &&
              request.role !== "reader" &&
              request.role !== "editor" &&
              request.role !== "admin"
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (
              auditEvents.has(request.auditEventId) ||
              auditOutbox.has(request.auditOutboxMessageId) ||
              [...auditOutbox.values()].some(
                (message) => message.auditEventId === request.auditEventId,
              )
            ) {
              return Object.freeze({ kind: "effect_conflict" });
            }
            const updatedMembership = freezeMembership({
              ...target,
              ...(request.operation === "change_membership_role"
                ? { role: request.role! }
                : { state: "revoked" as const }),
              version: changed ? version(target.version + 1) : target.version,
              updatedAt: changed ? request.occurredAt : target.updatedAt,
              updatedBy: changed ? request.principalId : target.updatedBy,
            });
            const updatedSpace = changed
              ? freezeKnowledgeSpace({
                  ...space,
                  accessVersion: version(space.accessVersion + 1),
                  updatedAt: request.occurredAt,
                })
              : space;
            const event = Object.freeze({
              auditEventId: request.auditEventId,
              actor: Object.freeze({
                kind: "principal" as const,
                principalId: request.principalId,
              }),
              requestId: request.requestId,
              eventType: `membership.${request.operation}`,
              outcome: "succeeded" as const,
              spaceId: request.spaceId,
              occurredAt: request.occurredAt,
              safeMetadata: Object.freeze({
                member_id: target.membershipId,
                previous_role: target.role,
                resulting_role: updatedMembership.role,
                previous_state: target.state,
                resulting_state: updatedMembership.state,
                changed,
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
            memberships.set(target.membershipId, updatedMembership);
            knowledgeSpaces.set(request.spaceId, updatedSpace);
            auditEvents.set(event.auditEventId, cloneAuditEvent(event));
            auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
            membershipMutationRecords.set(
              membershipMutationKey(request),
              Object.freeze({
                canonicalRequestHash: request.canonicalRequestHash,
                membership: updatedMembership,
                changed,
                requiredCapability: request.requiredCapability,
              }),
            );
            return Object.freeze({
              kind: "applied",
              membership: updatedMembership,
              changed,
              replayed: false,
            });
          },
          classifyPersonalMindTarget: async (
            request: PersonalMindTargetRequest,
          ): Promise<PersonalMindTargetClassification> => {
            const target = knowledgeSpaces.get(request.spaceId);
            if (!target || target.state !== "active") {
              return Object.freeze({ kind: "not_found" });
            }
            const personalBinding = [...personalBindings.values()].find(
              (binding) => binding.spaceId === request.spaceId,
            );
            if (!personalBinding) {
              return Object.freeze({ kind: "ordinary", spaceId: request.spaceId });
            }
            if (personalBinding.principalId !== request.principalId) {
              return Object.freeze({ kind: "not_found" });
            }
            try {
              const account = accountFromMaps(
                request.principalId,
                principals,
                externalBindings,
                knowledgeSpaces,
                personalBindings,
                memberships,
              );
              if (
                account === null ||
                account.personalMind.personalBinding?.spaceId !== request.spaceId
              ) {
                return Object.freeze({ kind: "not_found" });
              }
            } catch {
              return Object.freeze({ kind: "not_found" });
            }
            return Object.freeze({ kind: "own_personal", spaceId: request.spaceId });
          },
          readCurrentAuthorizationState: async (query: AuthorizationStateQuery) =>
            currentSitesAuthorizationStateFromMaps(
              query,
              principals,
              knowledgeSpaces,
              memberships,
            ),
          readRegisteredPrincipalByExternalBinding: async (
            lookup: Readonly<ExternalIdentityBindingLookup>,
          ): Promise<Readonly<RegisteredPrincipalSnapshot> | null> => {
            try {
              const account = accountByBindingFromMaps(
                lookup,
                principals,
                externalBindings,
                knowledgeSpaces,
                personalBindings,
                memberships,
              );
              if (account === null || account.principal.state !== "active") {
                return null;
              }
              return freezeRegisteredPrincipalSnapshot({
                principalId: account.principal.principalId,
                displayName: account.principal.displayName,
              });
            } catch {
              return null;
            }
          },
          createInvitation: async (
            request: Readonly<CreateInvitationRequest>,
          ): Promise<CreateInvitationResult> => {
            const actorPrincipal = principals.get(request.principalId);
            if (!actorPrincipal || actorPrincipal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const space = knowledgeSpaces.get(request.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personalBinding = [...personalBindings.values()].find(
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
            const targetPrincipal = principals.get(request.target.principalId);
            if (
              !targetPrincipal ||
              targetPrincipal.state !== "active" ||
              targetPrincipal.displayName !== request.target.displayName
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const aggregateMemberships = [...memberships.values()].filter(
              (membership) => membership.spaceId === request.spaceId,
            );
            const aggregateInvitations = [...invitations.values()].filter(
              (invitation) => invitation.spaceId === request.spaceId,
            );
            let currentAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
            try {
              currentAggregate = SpaceAggregate.restoreOrdinary({
                space,
                memberships: aggregateMemberships,
                invitations: aggregateInvitations,
              });
            } catch {
              return Object.freeze({ kind: "invalid_record" });
            }
            const actorMembership = currentAggregate
              .snapshot()
              .memberships.find(
                (membership) =>
                  membership.principalId === request.principalId &&
                  membership.state === "active",
              );
            if (
              !actorMembership ||
              (request.invitation.proposedRole === "admin"
                ? actorMembership.role !== "owner"
                : !["admin", "owner"].includes(actorMembership.role))
            ) {
              return Object.freeze({ kind: "forbidden" });
            }

            const recordKey = invitationIdempotencyRecordKey(
              request.principalId,
              request.spaceId,
              request.idempotencyKey,
            );
            const previous = idempotencyRecords.get(recordKey);
            if (previous) {
              if (
                previous.operation !== "create_invitation" ||
                previous.canonicalRequestHash !== request.canonicalRequestHash
              ) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({
                kind: "created",
                invitation: freezeInvitationSnapshot(previous.invitation),
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
            if (
              aggregateMemberships.some(
                (membership) =>
                  membership.principalId === request.target.principalId &&
                  membership.state === "active",
              )
            ) {
              return Object.freeze({ kind: "active_membership_exists" });
            }
            if (
              aggregateInvitations.some(
                (invitation) =>
                  invitation.targetPrincipalId === request.target.principalId &&
                  invitation.state === "pending",
              )
            ) {
              return Object.freeze({ kind: "pending_invitation_exists" });
            }

            const invitation = request.invitation;
            const occurredAt = Date.parse(request.occurredAt);
            const expiresAt = Date.parse(invitation.expiresAt);
            if (
              typeof invitation.invitationId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(invitation.invitationId) ||
              invitations.has(invitation.invitationId) ||
              invitation.spaceId !== request.spaceId ||
              invitation.targetPrincipalId !== request.target.principalId ||
              !["reader", "editor", "admin"].includes(invitation.proposedRole) ||
              invitation.state !== "pending" ||
              invitation.version !== 1 ||
              invitation.createdBy !== request.principalId ||
              invitation.updatedBy !== request.principalId ||
              invitation.createdAt !== request.occurredAt ||
              invitation.updatedAt !== request.occurredAt ||
              !Number.isFinite(occurredAt) ||
              !Number.isFinite(expiresAt) ||
              expiresAt - occurredAt !== 7 * 24 * 60 * 60 * 1_000
            ) {
              return Object.freeze({
                kind: invitations.has(invitation.invitationId)
                  ? "record_conflict"
                  : "invalid_record",
              });
            }
            const expiryJob = request.expiryJob;
            if (
              typeof expiryJob.jobId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(expiryJob.jobId) ||
              expiryJob.target.kind !== "expire_invitation" ||
              expiryJob.target.invitationId !== invitation.invitationId ||
              expiryJob.state !== "queued" ||
              expiryJob.version !== 1 ||
              expiryJob.attempts !== 0 ||
              expiryJob.availableAt !== invitation.expiresAt ||
              expiryJob.claimExpiresAt !== null ||
              expiryJob.createdAt !== request.occurredAt ||
              expiryJob.updatedAt !== request.occurredAt
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (backgroundJobs.has(expiryJob.jobId)) {
              return Object.freeze({ kind: "expiry_job_conflict" });
            }

            let updatedAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
            try {
              updatedAggregate = currentAggregate.addInvitation({
                actorPrincipalId: request.principalId,
                invitation: { ...invitation },
                expectedMetadataVersion: request.expectedMetadataVersion,
                occurredAt: request.occurredAt,
              });
            } catch (error) {
              if (
                error instanceof DomainInvariantError &&
                error.code === "duplicate_pending_invitation"
              ) {
                return Object.freeze({ kind: "pending_invitation_exists" });
              }
              if (
                error instanceof DomainInvariantError &&
                error.code === "pending_invitation_for_active_member"
              ) {
                return Object.freeze({ kind: "active_membership_exists" });
              }
              if (
                error instanceof DomainInvariantError &&
                error.code === "settings_permission_required"
              ) {
                return Object.freeze({ kind: "forbidden" });
              }
              if (
                error instanceof DomainInvariantError &&
                error.code === "stale_version"
              ) {
                return Object.freeze({
                  kind: "metadata_conflict",
                  currentMetadataVersion: space.metadataVersion,
                });
              }
              return Object.freeze({ kind: "invalid_record" });
            }
            const updatedSnapshot = updatedAggregate.snapshot();
            const persisted = updatedSnapshot
              .invitations.find(
                (candidate) => candidate.invitationId === invitation.invitationId,
              );
            if (!persisted) return Object.freeze({ kind: "invalid_record" });
            const candidateInvitations = cloneRecordMap(
              invitations,
              freezeInvitation,
            );
            const candidateKnowledgeSpaces = cloneRecordMap(
              knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            candidateKnowledgeSpaces.set(
              updatedSnapshot.space.spaceId,
              freezeKnowledgeSpace(updatedSnapshot.space),
            );
            candidateInvitations.set(
              persisted.invitationId,
              freezeInvitation(persisted),
            );
            const candidateBackgroundJobs = new Map(backgroundJobs);
            candidateBackgroundJobs.set(expiryJob.jobId, cloneBackgroundJob(expiryJob));
            this._failOrdinaryMindIfRequested("invitation_after_record");
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
            const snapshot = freezeInvitationSnapshot({
              invitation: persisted,
              target: request.target,
            });
            candidateIdempotencyRecords.set(
              recordKey,
              Object.freeze({
                operation: "create_invitation" as const,
                principalId: request.principalId,
                spaceId: request.spaceId,
                key: request.idempotencyKey,
                canonicalRequestHash: request.canonicalRequestHash,
                invitation: snapshot,
              }),
            );
            this._failOrdinaryMindIfRequested("invitation_after_idempotency");
            this._failOrdinaryMindIfRequested("invitation_after_expiry_job");
            this._failOrdinaryMindIfRequested("invitation_before_commit");
            knowledgeSpaces = candidateKnowledgeSpaces;
            invitations = candidateInvitations;
            backgroundJobs = candidateBackgroundJobs;
            idempotencyRecords = candidateIdempotencyRecords;
            return Object.freeze({
              kind: "created",
              invitation: snapshot,
              replayed: false,
            });
          },
          transitionInvitation: async (
            request: Readonly<TransitionInvitationRequest>,
          ): Promise<TransitionInvitationResult> => {
            if (
              request.operation !== "accept_invitation" &&
              request.operation !== "reject_invitation" &&
              request.operation !== "cancel_invitation"
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const currentInvitation = invitations.get(request.invitationId);
            if (!currentInvitation) return Object.freeze({ kind: "invitation_not_found" });
            const space = knowledgeSpaces.get(currentInvitation.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "invitation_not_found" });
            }
            if ([...personalBindings.values()].some((binding) => binding.spaceId === space.spaceId)) {
              return Object.freeze({ kind: "personal_mind" });
            }
            if (
              !invitationLifecycleActorIsCurrentlyAuthorized(
                request.operation,
                request.principalId,
                currentInvitation,
                principals,
                memberships,
              )
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            const recordKey = invitationLifecycleIdempotencyRecordKey(
              request.principalId,
              space.spaceId,
              request.operation,
              request.idempotencyKey,
            );
            const previous = idempotencyRecords.get(recordKey);
            if (previous) {
              if (
                previous.operation !== request.operation ||
                previous.canonicalRequestHash !== request.canonicalRequestHash ||
                !("lifecycle" in previous)
              ) return Object.freeze({ kind: "idempotency_conflict" });
              return Object.freeze({
                kind: "transitioned",
                result: freezeInvitationLifecycleSnapshot(previous.lifecycle),
                replayed: true,
              });
            }
            if (!SHA256_PATTERN.test(request.canonicalRequestHash)) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (currentInvitation.version !== request.expectedInvitationVersion) {
              return Object.freeze({ kind: "invitation_version_conflict" });
            }
            if (!Number.isFinite(Date.parse(request.occurredAt))) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const aggregateMemberships = [...memberships.values()].filter(
              (membership) => membership.spaceId === space.spaceId,
            );
            const aggregateInvitations = [...invitations.values()].filter(
              (invitation) => invitation.spaceId === space.spaceId,
            );
            let aggregate;
            try {
              aggregate = SpaceAggregate.restoreOrdinary({
                space,
                memberships: aggregateMemberships,
                invitations: aggregateInvitations,
              });
            } catch {
              return Object.freeze({ kind: "invalid_record" });
            }
            let acceptedMembership: Readonly<SpaceMembership> | null = null;
            try {
              if (request.operation === "accept_invitation") {
                if (
                  request.membershipId === null ||
                  typeof request.membershipId !== "string" ||
                  !BOUNDED_OPAQUE_ID.test(request.membershipId)
                ) return Object.freeze({ kind: "invalid_record" });
                if (memberships.has(request.membershipId)) {
                  return Object.freeze({ kind: "record_conflict" });
                }
                acceptedMembership = freezeMembership({
                  membershipId: request.membershipId,
                  spaceId: currentInvitation.spaceId,
                  principalId: currentInvitation.targetPrincipalId,
                  role: currentInvitation.proposedRole,
                  state: "active",
                  version: version(1),
                  createdAt: request.occurredAt,
                  createdBy: request.principalId,
                  updatedAt: request.occurredAt,
                  updatedBy: request.principalId,
                });
                aggregate = aggregate.acceptInvitation({
                  invitationId: request.invitationId,
                  targetPrincipalId: request.principalId,
                  expectedInvitationVersion: request.expectedInvitationVersion,
                  membership: acceptedMembership,
                  occurredAt: request.occurredAt,
                });
              } else if (request.operation === "reject_invitation") {
                if (request.membershipId !== null) return Object.freeze({ kind: "invalid_record" });
                aggregate = aggregate.rejectInvitation({
                  invitationId: request.invitationId,
                  targetPrincipalId: request.principalId,
                  expectedInvitationVersion: request.expectedInvitationVersion,
                  occurredAt: request.occurredAt,
                });
              } else {
                if (request.membershipId !== null) return Object.freeze({ kind: "invalid_record" });
                aggregate = aggregate.cancelInvitation({
                  invitationId: request.invitationId,
                  actorPrincipalId: request.principalId,
                  expectedInvitationVersion: request.expectedInvitationVersion,
                  occurredAt: request.occurredAt,
                });
              }
            } catch (error) {
              if (!(error instanceof DomainInvariantError)) {
                return Object.freeze({ kind: "invalid_record" });
              }
              if (error.code === "invitation_not_pending") {
                return Object.freeze({ kind: "invitation_not_pending" });
              }
              if (error.code === "invitation_expired") {
                return Object.freeze({ kind: "invitation_expired" });
              }
              if (error.code === "invitation_target_mismatch" || error.code === "settings_permission_required") {
                return Object.freeze({ kind: "forbidden" });
              }
              if (error.code === "duplicate_active_membership" || error.code === "pending_invitation_for_active_member") {
                return Object.freeze({ kind: "active_membership_exists" });
              }
              if (error.code === "stale_version") {
                return Object.freeze({ kind: "invitation_version_conflict" });
              }
              return Object.freeze({ kind: "invalid_record" });
            }
            const updated = aggregate.snapshot();
            const transitioned = updated.invitations.find((item) => item.invitationId === request.invitationId);
            const target = principals.get(currentInvitation.targetPrincipalId);
            if (!transitioned || !target) return Object.freeze({ kind: "invalid_record" });
            const lifecycle = freezeInvitationLifecycleSnapshot({
              invitation: {
                invitation: transitioned,
                target: { principalId: target.principalId, displayName: target.displayName },
              },
              membership: acceptedMembership,
            });
            const candidateSpaces = cloneRecordMap(knowledgeSpaces, freezeKnowledgeSpace);
            const candidateInvitations = cloneRecordMap(invitations, freezeInvitation);
            const candidateMemberships = cloneRecordMap(memberships, freezeMembership);
            candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
            candidateInvitations.set(transitioned.invitationId, freezeInvitation(transitioned));
            this._failOrdinaryMindIfRequested("invitation_lifecycle_after_record");
            if (acceptedMembership) candidateMemberships.set(acceptedMembership.membershipId, acceptedMembership);
            this._failOrdinaryMindIfRequested("invitation_lifecycle_after_membership");
            const candidateIdempotency = cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
            candidateIdempotency.set(recordKey, Object.freeze({
              operation: request.operation,
              principalId: request.principalId,
              spaceId: space.spaceId,
              key: request.idempotencyKey,
              canonicalRequestHash: request.canonicalRequestHash,
              lifecycle,
            }));
            this._failOrdinaryMindIfRequested("invitation_lifecycle_after_idempotency");
            this._failOrdinaryMindIfRequested("invitation_lifecycle_before_commit");
            knowledgeSpaces = candidateSpaces;
            invitations = candidateInvitations;
            memberships = candidateMemberships;
            idempotencyRecords = candidateIdempotency;
            return Object.freeze({ kind: "transitioned", result: lifecycle, replayed: false });
          },
          reissueInvitation: async (
            request: Readonly<ReissueInvitationRequest>,
          ): Promise<ReissueInvitationResult> => {
            const current = invitations.get(request.invitationId);
            if (!current) return Object.freeze({ kind: "invitation_not_found" });
            const space = knowledgeSpaces.get(current.spaceId);
            if (!space || space.state !== "active") return Object.freeze({ kind: "invitation_not_found" });
            if ([...personalBindings.values()].some((binding) => binding.spaceId === space.spaceId)) {
              return Object.freeze({ kind: "personal_mind" });
            }
            if (
              !invitationLifecycleActorIsCurrentlyAuthorized(
                "reissue_invitation",
                request.principalId,
                current,
                principals,
                memberships,
              )
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            const recordKey = invitationLifecycleIdempotencyRecordKey(
              request.principalId,
              space.spaceId,
              "reissue_invitation",
              request.idempotencyKey,
            );
            const previous = idempotencyRecords.get(recordKey);
            if (previous) {
              if (previous.operation !== "reissue_invitation" || previous.canonicalRequestHash !== request.canonicalRequestHash) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({ kind: "reissued", invitation: freezeInvitationSnapshot(previous.invitation), replayed: true });
            }
            if (!SHA256_PATTERN.test(request.canonicalRequestHash)) return Object.freeze({ kind: "invalid_record" });
            if (current.version !== request.expectedInvitationVersion) return Object.freeze({ kind: "invitation_version_conflict" });
            if (current.state === "accepted") return Object.freeze({ kind: "accepted_invitation" });
            const target = principals.get(current.targetPrincipalId);
            if (!target || target.state !== "active") return Object.freeze({ kind: "invalid_record" });
            const occurredAt = Date.parse(request.occurredAt);
            const expiresAt = Date.parse(request.expiresAt);
            if (
              typeof request.replacementInvitationId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(request.replacementInvitationId) ||
              typeof request.expiryJobId !== "string" ||
              !BOUNDED_OPAQUE_ID.test(request.expiryJobId) ||
              !Number.isFinite(occurredAt) ||
              !Number.isFinite(expiresAt) ||
              expiresAt - occurredAt !== 7 * 24 * 60 * 60 * 1_000
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (
              invitations.has(request.replacementInvitationId) ||
              backgroundJobs.has(request.expiryJobId)
            ) return Object.freeze({ kind: invitations.has(request.replacementInvitationId) ? "record_conflict" : "expiry_job_conflict" });
            const aggregateMemberships = [...memberships.values()].filter((item) => item.spaceId === space.spaceId);
            const aggregateInvitations = [...invitations.values()].filter((item) => item.spaceId === space.spaceId);
            if (aggregateMemberships.some((item) => item.principalId === current.targetPrincipalId && item.state === "active")) {
              return Object.freeze({ kind: "active_membership_exists" });
            }
            if (aggregateInvitations.some((item) => item.invitationId !== current.invitationId && item.targetPrincipalId === current.targetPrincipalId && item.state === "pending")) {
              return Object.freeze({ kind: "pending_invitation_exists" });
            }
            const replacement = freezeInvitation({
              invitationId: request.replacementInvitationId,
              spaceId: current.spaceId,
              targetPrincipalId: current.targetPrincipalId,
              proposedRole: current.proposedRole,
              state: "pending",
              expiresAt: request.expiresAt,
              version: version(1),
              createdAt: request.occurredAt,
              createdBy: request.principalId,
              updatedAt: request.occurredAt,
              updatedBy: request.principalId,
            });
            let aggregate;
            try {
              aggregate = SpaceAggregate.restoreOrdinary({ space, memberships: aggregateMemberships, invitations: aggregateInvitations })
                .reissueInvitation({
                  invitationId: current.invitationId,
                  actorPrincipalId: request.principalId,
                  expectedInvitationVersion: request.expectedInvitationVersion,
                  replacement,
                  occurredAt: request.occurredAt,
                });
            } catch (error) {
              if (error instanceof DomainInvariantError && error.code === "settings_permission_required") return Object.freeze({ kind: "forbidden" });
              if (error instanceof DomainInvariantError && error.code === "stale_version") return Object.freeze({ kind: "invitation_version_conflict" });
              if (error instanceof DomainInvariantError && error.code === "duplicate_pending_invitation") return Object.freeze({ kind: "pending_invitation_exists" });
              if (error instanceof DomainInvariantError && error.code === "pending_invitation_for_active_member") return Object.freeze({ kind: "active_membership_exists" });
              return Object.freeze({ kind: "invalid_record" });
            }
            const updated = aggregate.snapshot();
            const persisted = updated.invitations.find((item) => item.invitationId === replacement.invitationId);
            if (!persisted) return Object.freeze({ kind: "invalid_record" });
            const expiryJob = cloneBackgroundJob({
              jobId: request.expiryJobId,
              target: { kind: "expire_invitation", invitationId: persisted.invitationId },
              state: "queued",
              version: version(1),
              attempts: 0,
              availableAt: persisted.expiresAt,
              claimExpiresAt: null,
              createdAt: request.occurredAt,
              updatedAt: request.occurredAt,
            });
            const snapshot = freezeInvitationSnapshot({ invitation: persisted, target });
            const candidateSpaces = cloneRecordMap(knowledgeSpaces, freezeKnowledgeSpace);
            const candidateInvitations = cloneRecordMap(invitations, freezeInvitation);
            const candidateJobs = new Map(backgroundJobs);
            candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
            for (const item of updated.invitations) candidateInvitations.set(item.invitationId, freezeInvitation(item));
            this._failOrdinaryMindIfRequested("invitation_reissue_after_record");
            candidateJobs.set(expiryJob.jobId, expiryJob);
            this._failOrdinaryMindIfRequested("invitation_reissue_after_job");
            const candidateIdempotency = cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
            candidateIdempotency.set(recordKey, Object.freeze({
              operation: "reissue_invitation",
              principalId: request.principalId,
              spaceId: space.spaceId,
              key: request.idempotencyKey,
              canonicalRequestHash: request.canonicalRequestHash,
              invitation: snapshot,
            }));
            this._failOrdinaryMindIfRequested("invitation_reissue_after_idempotency");
            this._failOrdinaryMindIfRequested("invitation_reissue_before_commit");
            knowledgeSpaces = candidateSpaces;
            invitations = candidateInvitations;
            backgroundJobs = candidateJobs;
            idempotencyRecords = candidateIdempotency;
            return Object.freeze({ kind: "reissued", invitation: snapshot, replayed: false });
          },
          createOrdinaryMind: async (
            records: Readonly<OrdinaryMindRecordSet>,
          ): Promise<CreateOrdinaryMindResult> => {
            const principalId = records.ownerMembership.principalId;
            const idempotencyRecordKey = ordinaryMindCreateIdempotencyKey(
              principalId,
              records.idempotencyKey,
            );
            const principal = this._principals.get(principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "principal_not_found" });
            }
            const previous = idempotencyRecords.get(idempotencyRecordKey);
            if (previous) {
              if (
                previous.operation !== "create_space_with_owner"
              ) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              const currentSpace = knowledgeSpaces.get(previous.mind.space.spaceId);
              const currentReservation = activeBySpace.get(
                previous.mind.space.spaceId,
              );
              const currentMembership = [...memberships.values()].find(
                (membership) =>
                  membership.spaceId === previous.mind.space.spaceId &&
                  membership.principalId === principalId &&
                  membership.state === "active",
              );
              const isPersonal = [...this._personalBindings.values()].some(
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
                  knowledgeSpaces,
                  memberships,
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
              knowledgeSpaces.has(space.spaceId) ||
              memberships.has(membership.membershipId) ||
              revisionSpaces.has(space.spaceId) ||
              revisionsById.has(revisionId)
            ) {
              return Object.freeze({ kind: "record_conflict" });
            }
            const candidateKnowledgeSpaces = cloneRecordMap(
              knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateMemberships = cloneRecordMap(
              memberships,
              freezeMembership,
            );
            const candidateRevisionSpaces = cloneSpaces(revisionSpaces);
            const candidateRevisionsById = new Map(revisionsById);
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
            const candidateBackgroundJobs = new Map(backgroundJobs);
            const candidateIndexStates = new Map(indexStates);
            const candidateActiveByHandle = new Map(activeByHandle);
            const candidateActiveBySpace = new Map(activeBySpace);
            const candidateRetired = new Map(retired);

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
            knowledgeSpaces = candidateKnowledgeSpaces;
            memberships = candidateMemberships;
            revisionSpaces = candidateRevisionSpaces;
            revisionsById = candidateRevisionsById;
            idempotencyRecords = candidateIdempotencyRecords;
            backgroundJobs = candidateBackgroundJobs;
            indexStates = candidateIndexStates;
            activeByHandle = candidateActiveByHandle;
            activeBySpace = candidateActiveBySpace;
            retired = candidateRetired;
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
            const principal = this._principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const space = knowledgeSpaces.get(request.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personalBinding = [...this._personalBindings.values()].find(
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

            const aggregateMemberships = [...memberships.values()].filter(
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

            const previous = idempotencyRecords.get(idempotencyRecordKey);
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
              renamedAggregate = currentAggregate.rename({
                actorPrincipalId: request.principalId,
                name: request.displayName,
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
              knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
            const renamedSnapshot = renamedAggregate.snapshot();
            candidateKnowledgeSpaces.set(
              request.spaceId,
              freezeKnowledgeSpace(renamedSnapshot.space),
            );
            this._failOrdinaryMindIfRequested("rename_after_space");
            const renamed = ordinaryMindSnapshotFromMaps(
              request.spaceId,
              candidateKnowledgeSpaces,
              memberships,
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
            knowledgeSpaces = candidateKnowledgeSpaces;
            idempotencyRecords = candidateIdempotencyRecords;
            return Object.freeze({ kind: "renamed", mind: renamed, replayed: false });
          },

          changeOrdinaryMindVisibility: async (
            request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
          ): Promise<ChangeOrdinaryMindVisibilityResult> => {
            const principal = principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const space = knowledgeSpaces.get(request.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personalBinding = [...personalBindings.values()].find(
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

            const aggregateMemberships = [...memberships.values()].filter(
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
            const previous = idempotencyRecords.get(idempotencyRecordKey);
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
                knowledgeSpaces,
                memberships,
              );
              if (current === null) return Object.freeze({ kind: "invalid_record" });
              const candidateIdempotencyRecords =
                cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
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
              idempotencyRecords = candidateIdempotencyRecords;
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
              knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
            const candidateAuditEvents = new Map(
              [...auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
            );
            const candidateAuditOutbox = new Map(
              [...auditOutbox].map(([id, message]) => [
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
                personalBindings,
              );
            const candidatePublicCatalogSnapshots = clonePublicCatalogSnapshots(
              publicCatalogSnapshots,
            );
            const candidatePublicCatalogGeneration = publicCatalogGeneration + 1;
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
              memberships,
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
            knowledgeSpaces = candidateKnowledgeSpaces;
            publicCatalogGeneration = candidatePublicCatalogGeneration;
            publicCatalogSpaceIds = candidatePublicCatalogSpaceIds;
            publicCatalogSnapshots = candidatePublicCatalogSnapshots;
            idempotencyRecords = candidateIdempotencyRecords;
            auditEvents = candidateAuditEvents;
            auditOutbox = candidateAuditOutbox;
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
            const principal = principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const space = knowledgeSpaces.get(request.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personalBinding = [...personalBindings.values()].find(
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
            const previous = idempotencyRecords.get(recordKey);
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
                knowledgeSpaces,
                memberships,
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

            const aggregateMemberships = [...memberships.values()].filter(
              (membership) => membership.spaceId === request.spaceId,
            );
            const aggregateInvitations = [...invitations.values()].filter(
              (invitation) => invitation.spaceId === request.spaceId,
            );
            const source = aggregateMemberships.find(
              (membership) =>
                membership.principalId === request.principalId &&
                membership.state === "active",
            );
            const target = memberships.get(request.targetMembershipId);
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
            if (request.capacityLimits !== undefined) {
              const targetSpaceIds = new Set(ownedCapacitySpaceIds(
                target.principalId,
                revisionSpaces,
                knowledgeSpaces,
                memberships,
              ));
              targetSpaceIds.add(request.spaceId);
              const targetUsage = capacityUsageFromCanonicalState({
                spaceIds: targetSpaceIds,
                spaces: revisionSpaces,
                stagedBundleFiles: this._stagedBundleFiles,
                exportJobs,
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
              if (
                targetUsage.physicalCanonicalBytes +
                  targetReserved.physicalCanonicalBytes >
                  request.capacityLimits.principalPhysicalCanonicalBytes
              ) {
                return Object.freeze({
                  kind: "ownership_target_capacity_exceeded",
                });
              }
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
                expectedSourceMembershipVersion: source.version,
                expectedTargetMembershipVersion: target.version,
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
              knowledgeSpaces,
              freezeKnowledgeSpace,
            );
            const candidateMemberships = cloneRecordMap(
              memberships,
              freezeMembership,
            );
            const candidateAuditEvents = new Map(
              [...auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
            );
            const candidateAuditOutbox = new Map(
              [...auditOutbox].map(([id, message]) => [
                id,
                cloneAuditOutbox(message),
              ]),
            );
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
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
            knowledgeSpaces = candidateKnowledgeSpaces;
            memberships = candidateMemberships;
            auditEvents = candidateAuditEvents;
            auditOutbox = candidateAuditOutbox;
            idempotencyRecords = candidateIdempotencyRecords;
            return Object.freeze({
              kind: "transferred",
              transfer,
              replayed: false,
            });
          },

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
            for (const [impactId, candidate] of deletionImpacts) {
              if (Date.parse(candidate.expiresAt) <= occurredAt) {
                deletionImpacts.delete(impactId);
              }
            }
            if (
              deletionImpacts.has(request.impactId) ||
              deletionCleanup.has(request.impactId)
            ) {
              return Object.freeze({ kind: "impact_id_collision" });
            }
            const principal = principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const reservation = activeByHandle.get(
              handleKey(request.host, parsed.canonicalHandle),
            );
            if (!reservation) return Object.freeze({ kind: "mind_not_found" });
            const space = knowledgeSpaces.get(reservation.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personal = [...personalBindings.values()].find(
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
              knowledgeSpaces,
              memberships,
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
              deletionState(),
            );
            const revisionState = revisionSpaces.get(space.spaceId);
            if (stateFingerprint === null || !revisionState) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const selected = targetRecordSelection(space.spaceId, deletionState());
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
            deletionImpacts.set(impact.impactId, impact);
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
            const reservation = activeByHandle.get(
              handleKey(request.host, parsed.canonicalHandle),
            );
            if (!reservation) {
              const pending = [...deletionCleanup.values()].find(
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
            const principal = principals.get(request.principalId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            const spaceId = reservation.spaceId;
            const space = knowledgeSpaces.get(spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            const personal = [...personalBindings.values()].find(
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
              knowledgeSpaces,
              memberships,
            );
            if (aggregate === null) return Object.freeze({ kind: "invalid_record" });
            if (
              aggregate.ownerMembership.principalId !== request.principalId ||
              aggregate.ownerMembership.state !== "active" ||
              aggregate.ownerMembership.role !== "owner"
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            const impact = deletionImpacts.get(request.impactId);
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
              deletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_expired" });
            }
            const currentFingerprint = ordinaryMindDeletionFingerprint(
              spaceId,
              deletionState(),
            );
            if (
              currentFingerprint === null ||
              currentFingerprint !== impact.stateFingerprint
            ) {
              deletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
            if (deletionCleanup.has(request.impactId)) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const selected = targetRecordSelection(spaceId, deletionState());
            const targetRevisions = revisionSpaces.get(spaceId)?.revisions;
            if (!targetRevisions) return Object.freeze({ kind: "invalid_record" });
            const targetDigests = new Set<Digest>();
            for (const envelope of targetRevisions.values()) {
              for (const entry of envelope.manifest.entries) {
                targetDigests.add(entry.sha256);
              }
            }
            const remainingReachable = new Set<Digest>();
            for (const [candidateSpaceId, state] of revisionSpaces) {
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
              { activeByHandle, activeBySpace, retired },
            );
            if (retiredResult.kind !== "retired") {
              return Object.freeze({ kind: "invalid_record" });
            }
            this._failOrdinaryMindIfRequested("delete_after_handle_retirement");

            knowledgeSpaces.delete(spaceId);
            selected.membershipIds.forEach((id) => memberships.delete(id));
            selected.invitationIds.forEach((id) => invitations.delete(id));
            revisionSpaces.delete(spaceId);
            selected.revisionIds.forEach((id) => revisionsById.delete(id));
            selected.ordinaryIdempotencyKeys.forEach((key) =>
              idempotencyRecords.delete(key));
            selected.contentIdempotencyKeys.forEach((key) =>
              contentIdempotencyRecords.delete(key));
            for (const key of membershipMutationRecords.keys()) {
              if (key.split("\u0000")[1] === spaceId) {
                membershipMutationRecords.delete(key);
              }
            }
            selected.backgroundJobIds.forEach((id) => backgroundJobs.delete(id));
            selected.exportJobIds.forEach((id) => exportJobs.delete(id));
            selected.exportGrantKeys.forEach((key) =>
              exportDownloadGrants.delete(key));
            selected.bundleFileDownloadGrantKeys.forEach((key) =>
              bundleFileDownloadGrants.delete(key));
            selected.indexKeys.forEach((key) => indexStates.delete(key));
            selected.outboxIds.forEach((id) => auditOutbox.delete(id));
            selected.auditIds.forEach((id) => auditEvents.delete(id));
            for (const [key, state] of authorizationStates) {
              if (state.space.spaceId === spaceId) authorizationStates.delete(key);
            }
            for (const [impactId, candidate] of deletionImpacts) {
              if (candidate.spaceId === spaceId) deletionImpacts.delete(impactId);
            }
            purgeMindBindingsForSpace(
              mindBindingOwners,
              spaceId,
              request.occurredAt,
            );
            this._failOrdinaryMindIfRequested("delete_after_target_records");

            publicCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
              knowledgeSpaces,
              personalBindings,
            );
            publicCatalogGeneration += 1;
            stagePublicCatalogSnapshot(
              publicCatalogGeneration,
              publicCatalogSpaceIds,
              publicCatalogSnapshots,
            );
            this._failOrdinaryMindIfRequested("delete_after_catalog");
            deletionCleanup.set(cleanup.impactId, cleanup);
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
            const pending = deletionCleanup.get(request.impactId);
            if (
              !pending ||
              pending.spaceId !== request.spaceId ||
              pending.host !== request.host ||
              pending.canonicalHandle !== parsed.canonicalHandle
            ) {
              return Object.freeze({ kind: "not_found" });
            }
            deletionCleanup.delete(request.impactId);
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
            for (const [impactId, candidate] of accountDeletionImpacts) {
              if (Date.parse(candidate.expiresAt) <= occurredAt) {
                accountDeletionImpacts.delete(impactId);
              }
            }
            if (
              accountDeletionImpacts.has(request.impactId) ||
              accountDeletionCleanup.has(request.impactId)
            ) {
              return Object.freeze({ kind: "impact_id_collision" });
            }
            const selected = accountDeletionSelection(
              request.principalId,
              request.host,
              accountState(),
            );
            const metadataStateFingerprint = accountDeletionFingerprint(
              request.principalId,
              request.host,
              accountState(),
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
            accountDeletionImpacts.set(impact.impactId, impact);
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
            const pending = accountDeletionCleanup.get(request.impactId);
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
            const impact = accountDeletionImpacts.get(request.impactId);
            if (!impact || impact.principalId !== request.principalId) {
              return Object.freeze({ kind: "account_not_found" });
            }
            if (Date.parse(request.occurredAt) >= Date.parse(impact.expiresAt)) {
              accountDeletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_expired" });
            }
            if (impact.tokenStateFingerprint !== request.tokenStateFingerprint) {
              accountDeletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
            const currentSelection = accountDeletionSelection(
              request.principalId,
              impact.host,
              accountState(),
            );
            const currentFingerprint = accountDeletionFingerprint(
              request.principalId,
              impact.host,
              accountState(),
            );
            if (
              !currentSelection ||
              currentFingerprint === null ||
              currentFingerprint !== impact.metadataStateFingerprint
            ) {
              accountDeletionImpacts.delete(impact.impactId);
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
              accountDeletionImpacts.delete(impact.impactId);
              return Object.freeze({ kind: "deletion_impact_changed" });
            }

            const targetSelections = new Map(
              currentSelection.deletedSpaceIds.map((spaceId) => [
                spaceId,
                targetRecordSelection(spaceId, deletionState()),
              ]),
            );
            const targetDigests = new Set<Digest>();
            for (const spaceId of currentSelection.deletedSpaceIds) {
              const state = revisionSpaces.get(spaceId);
              if (!state) return Object.freeze({ kind: "invalid_record" });
              for (const envelope of state.revisions.values()) {
                for (const entry of envelope.manifest.entries) {
                  targetDigests.add(entry.sha256);
                }
              }
            }
            const remainingReachable = new Set<Digest>();
            for (const [spaceId, state] of revisionSpaces) {
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
              const reservation = activeBySpace.get(mind.spaceId);
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
                { activeByHandle, activeBySpace, retired },
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
              knowledgeSpaces.delete(spaceId);
              revisionSpaces.delete(spaceId);
              records.revisionIds.forEach((id) => revisionsById.delete(id));
              records.membershipIds.forEach((id) => memberships.delete(id));
              records.invitationIds.forEach((id) => invitations.delete(id));
              records.ordinaryIdempotencyKeys.forEach((key) =>
                idempotencyRecords.delete(key),
              );
              records.contentIdempotencyKeys.forEach((key) =>
                contentIdempotencyRecords.delete(key),
              );
              for (const key of membershipMutationRecords.keys()) {
                if (key.split("\u0000")[1] === spaceId) {
                  membershipMutationRecords.delete(key);
                }
              }
              records.backgroundJobIds.forEach((id) => backgroundJobs.delete(id));
              records.exportJobIds.forEach((id) => exportJobs.delete(id));
              records.exportGrantKeys.forEach((key) =>
                exportDownloadGrants.delete(key),
              );
              records.bundleFileDownloadGrantKeys.forEach((key) =>
                bundleFileDownloadGrants.delete(key),
              );
              records.indexKeys.forEach((key) => indexStates.delete(key));
              records.outboxIds.forEach((id) => auditOutbox.delete(id));
              records.auditIds.forEach((id) => auditEvents.delete(id));
              for (const [impactId, candidate] of deletionImpacts) {
                if (candidate.spaceId === spaceId) deletionImpacts.delete(impactId);
              }
              purgeMindBindingsForSpace(
                mindBindingOwners,
                spaceId,
                request.occurredAt,
              );
            }
            this._failAccountDeletionIfRequested("delete_after_target_records");

            let foreignRevisionAuthorsTombstoned = 0;
            for (const [spaceId, state] of revisionSpaces) {
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
                revisionsById.set(revisionId, retained);
              }
              revisionSpaces.set(spaceId, { head: state.head, revisions: revised });
            }
            let foreignAuditActorsTombstoned = 0;
            for (const [auditEventId, event] of auditEvents) {
              if (
                event.actor.kind !== "principal" ||
                event.actor.principalId !== request.principalId
              ) {
                continue;
              }
              auditEvents.set(
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
              if (memberships.delete(membershipId)) membershipsDeleted += 1;
            }
            const targetInvitationIdSet = new Set(
              currentSelection.targetInvitationIds,
            );
            for (const invitationId of targetInvitationIdSet) {
              if (invitations.delete(invitationId)) invitationsDeleted += 1;
            }
            for (const [jobId, job] of backgroundJobs) {
              if (
                job.target.kind === "expire_invitation" &&
                targetInvitationIdSet.has(job.target.invitationId)
              ) {
                backgroundJobs.delete(jobId);
              }
            }
            const foreignExportJobIdSet = new Set(
              currentSelection.foreignExportJobIds,
            );
            foreignExportJobIdSet.forEach((id) => exportJobs.delete(id));
            for (const [key, grant] of exportDownloadGrants) {
              if (
                grant.requestedByPrincipalId === request.principalId ||
                foreignExportJobIdSet.has(grant.jobId)
              ) {
                exportDownloadGrants.delete(key);
              }
            }
            for (const [key, grant] of bundleFileDownloadGrants) {
              if (grant.requestedByPrincipalId === request.principalId) {
                bundleFileDownloadGrants.delete(key);
              }
            }
            for (const [key, record] of contentIdempotencyRecords) {
              if (record.principalId === request.principalId) {
                contentIdempotencyRecords.delete(key);
              }
            }
            for (const [key, record] of idempotencyRecords) {
              if (record.principalId === request.principalId) {
                idempotencyRecords.delete(key);
              }
            }
            for (const [key, record] of personalProfileIdempotencyRecords) {
              if (record.principalId === request.principalId) {
                personalProfileIdempotencyRecords.delete(key);
              }
            }
            for (const key of membershipMutationRecords.keys()) {
              if (key.split("\u0000")[0] === request.principalId) {
                membershipMutationRecords.delete(key);
              }
            }
            const externalBindingKeys = [...externalBindings]
              .filter(([, binding]) => binding.principalId === request.principalId)
              .map(([key]) => key);
            externalBindingKeys.forEach((key) => externalBindings.delete(key));
            personalBindings.delete(request.principalId);
            principals.delete(request.principalId);
            principalActivities.delete(request.principalId);
            purgeMindBindingsForPrincipal(
              mindBindingOwners,
              request.principalId,
            );
            for (const [key, state] of authorizationStates) {
              if (
                state.principal.principalId === request.principalId ||
                currentSelection.deletedSpaceIdSet.has(state.space.spaceId)
              ) {
                authorizationStates.delete(key);
              }
            }
            this._failAccountDeletionIfRequested("delete_after_identity");

            publicCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
              knowledgeSpaces,
              personalBindings,
            );
            publicCatalogGeneration += 1;
            stagePublicCatalogSnapshot(
              publicCatalogGeneration,
              publicCatalogSpaceIds,
              publicCatalogSnapshots,
            );
            for (const [impactId, candidate] of accountDeletionImpacts) {
              if (candidate.principalId === request.principalId) {
                accountDeletionImpacts.delete(impactId);
              }
            }
            accountDeletionCleanup.set(cleanup.impactId, cleanup);
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
            const pending = accountDeletionCleanup.get(request.impactId);
            if (!pending || pending.principalId !== request.principalId) {
              return Object.freeze({ kind: "not_found" });
            }
            accountDeletionCleanup.delete(request.impactId);
            this._failAccountDeletionIfRequested("cleanup_before_commit");
            return Object.freeze({ kind: "completed" });
          },
        });

        const result = await operation(transaction);
        this._principals = principals;
        this._principalActivities = principalActivities;
        this._externalBindings = externalBindings;
        this._personalBindings = personalBindings;
        this._knowledgeSpaces = knowledgeSpaces;
        this._memberships = memberships;
        this._invitations = invitations;
        this._spaces = revisionSpaces;
        this._revisionsById = revisionsById;
        this._reachabilityCounts = null;
        this._ordinaryMindIdempotencyRecords = idempotencyRecords;
        this._membershipMutationRecords = membershipMutationRecords;
        this._personalProfileIdempotencyRecords = personalProfileIdempotencyRecords;
        this._activeHandlesByKey = activeByHandle;
        this._activeHandlesBySpace = activeBySpace;
        this._retiredHandles = retired;
        this._publicMindCatalogGeneration = publicCatalogGeneration;
        this._publicMindCatalogSpaceIds = publicCatalogSpaceIds;
        this._publicMindCatalogSnapshots = publicCatalogSnapshots;
        this._auditEvents = auditEvents;
        this._auditOutbox = auditOutbox;
        this._idempotencyRecords = contentIdempotencyRecords;
        this._backgroundJobs = backgroundJobs;
        this._exportJobs = exportJobs;
        this._exportDownloadGrants = exportDownloadGrants;
        this._bundleFileDownloadGrants = bundleFileDownloadGrants;
        this._indexStates = indexStates;
        this._ordinaryMindDeletionImpacts = deletionImpacts;
        this._ordinaryMindDeletionCleanup = deletionCleanup;
        this._accountDeletionImpacts = accountDeletionImpacts;
        this._accountDeletionCleanup = accountDeletionCleanup;
        this._mindBindingOwners = mindBindingOwners;
        this._authorizationStates.clear();
        authorizationStates.forEach((state, key) =>
          this._authorizationStates.set(key, state));
        return result;
      });
    }

  async runPersonalMindTransaction<Result>(
      operation: (transaction: PersonalMindMetadataTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const principals = cloneRecordMap(this._principals, freezePrincipal);
        const knowledgeSpaces = cloneRecordMap(
          this._knowledgeSpaces,
          freezeKnowledgeSpace,
        );
        const idempotencyRecords = clonePersonalProfileIdempotencyRecords(
          this._personalProfileIdempotencyRecords,
        );
        const transaction: PersonalMindMetadataTransaction = Object.freeze({
          renamePersonalProfile: async (
            request: RenamePersonalProfileRequest,
          ): Promise<RenamePersonalProfileResult> => {
            const idempotencyRecordKey = personalProfileIdempotencyKey(
              request.principalId,
              request.idempotencyKey,
            );
            let account: Readonly<PrincipalAccountSnapshot> | null;
            try {
              account = accountFromMaps(
                request.principalId,
                principals,
                this._externalBindings,
                knowledgeSpaces,
                this._personalBindings,
                this._memberships,
              );
            } catch {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (account === null) return Object.freeze({ kind: "not_found" });
            const previous = idempotencyRecords.get(idempotencyRecordKey);
            if (previous) {
              if (
                previous.profile.principalId !== account.principal.principalId ||
                previous.profile.personalMind.spaceId !==
                  account.personalMind.space.spaceId
              ) {
                return Object.freeze({ kind: "invalid_record" });
              }
              if (previous.canonicalRequestHash !== request.canonicalRequestHash) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({
                kind: "renamed",
                profile: freezePersonalMindProfile(previous.profile),
                replayed: true,
              });
            }
            const personalSpace = account.personalMind.space;
            if (
              account.principal.profileVersion !== request.expectedProfileVersion ||
              personalSpace.metadataVersion !== request.expectedPersonalMetadataVersion
            ) {
              return Object.freeze({
                kind: "profile_conflict",
                currentProfileVersion: account.principal.profileVersion,
                currentPersonalMetadataVersion: personalSpace.metadataVersion,
              });
            }

            const updatedPrincipal = freezePrincipal({
              ...account.principal,
              displayName: request.displayName,
              profileVersion: version(account.principal.profileVersion + 1),
              updatedAt: request.occurredAt,
            });
            const updatedSpace = freezeKnowledgeSpace({
              ...personalSpace,
              name: request.displayName,
              metadataVersion: version(personalSpace.metadataVersion + 1),
              updatedAt: request.occurredAt,
            });
            const candidatePrincipals = new Map(principals);
            candidatePrincipals.set(request.principalId, updatedPrincipal);
            const candidateSpaces = new Map(knowledgeSpaces);
            candidateSpaces.set(personalSpace.spaceId, updatedSpace);
            let updatedAccount: Readonly<PrincipalAccountSnapshot> | null;
            try {
              updatedAccount = accountFromMaps(
                request.principalId,
                candidatePrincipals,
                this._externalBindings,
                candidateSpaces,
                this._personalBindings,
                this._memberships,
              );
            } catch {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (updatedAccount === null) {
              return Object.freeze({ kind: "invalid_record" });
            }
            principals.set(request.principalId, updatedPrincipal);
            this._failPersonalProfileIfRequested("after_principal");
            knowledgeSpaces.set(personalSpace.spaceId, updatedSpace);
            this._failPersonalProfileIfRequested("after_space");
            const profile = personalMindProfileFromAccount(updatedAccount);
            idempotencyRecords.set(
              idempotencyRecordKey,
              Object.freeze({
                principalId: request.principalId,
                key: request.idempotencyKey,
                canonicalRequestHash: request.canonicalRequestHash,
                profile,
              }),
            );
            this._failPersonalProfileIfRequested("before_commit");
            return Object.freeze({ kind: "renamed", profile, replayed: false });
          },
        });

        const result = await operation(transaction);
        this._principals = principals;
        this._knowledgeSpaces = knowledgeSpaces;
        this._personalProfileIdempotencyRecords = idempotencyRecords;
        return result;
      });
    }

  async runAccountBootstrapTransaction<Result>(
      operation: (transaction: AccountBootstrapTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const principals = cloneRecordMap(this._principals, freezePrincipal);
        const externalBindings = cloneRecordMap(
          this._externalBindings,
          freezeExternalBinding,
        );
        const knowledgeSpaces = cloneRecordMap(
          this._knowledgeSpaces,
          freezeKnowledgeSpace,
        );
        const personalBindings = cloneRecordMap(
          this._personalBindings,
          freezePersonalBinding,
        );
        const memberships = cloneRecordMap(this._memberships, freezeMembership);
        const revisionSpaces = cloneSpaces(this._spaces);
        const revisionsById = new Map(this._revisionsById);
        const backgroundJobs = new Map(
          [...this._backgroundJobs].map(([id, job]) => [id, cloneBackgroundJob(job)]),
        );
        const indexStates = new Map(
          [...this._indexStates].map(([key, state]) => [key, cloneIndexState(state)]),
        );
        const transaction: AccountBootstrapTransaction = Object.freeze({
          readAccountByExternalBinding: async (
            lookup: Readonly<ExternalIdentityBindingLookup>,
          ) =>
            accountByBindingFromMaps(
              lookup,
              principals,
              externalBindings,
              knowledgeSpaces,
              personalBindings,
              memberships,
            ),
          createAccountBootstrap: async (
            records: Readonly<AccountBootstrapRecordSet>,
          ): Promise<CreateAccountBootstrapResult> => {
            const lookup = Object.freeze({
              provider: records.externalBinding.provider,
              normalizedBinding: records.externalBinding.normalizedBinding,
            });
            const exactExisting = accountByBindingFromMaps(
              lookup,
              principals,
              externalBindings,
              knowledgeSpaces,
              personalBindings,
              memberships,
            );
            if (exactExisting !== null) {
              return Object.freeze({
                kind: "exact_binding_exists",
                account: exactExisting,
              });
            }
            const validated = validateAccountBootstrapRecords(records);
            if (validated === null) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const { principal, externalBinding, personalSpace, personalBinding } =
              records;
            const ownerMembership = records.ownerMembership;
            const hasCollision =
              principals.has(principal.principalId) ||
              [...externalBindings.values()].some(
                (binding) => binding.bindingId === externalBinding.bindingId,
              ) ||
              knowledgeSpaces.has(personalSpace.spaceId) ||
              [...knowledgeSpaces.values()].some(
                (space) => space.normalizedHandle === personalSpace.normalizedHandle,
              ) ||
              personalBindings.has(personalBinding.principalId) ||
              [...personalBindings.values()].some(
                (binding) => binding.spaceId === personalBinding.spaceId,
              ) ||
              memberships.has(ownerMembership.membershipId) ||
              revisionSpaces.has(personalSpace.spaceId) ||
              revisionsById.has(records.initialRevision.revision.revisionId);
            if (hasCollision) {
              return Object.freeze({ kind: "record_conflict" });
            }

            const revisionResult = await this._commitRevisionAgainst(
              {
                expectedHeadRevisionId: null,
                envelope: records.initialRevision,
              },
              revisionSpaces,
              revisionsById,
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
            this._failAccountBootstrapIfRequested("after_revision");
            if (
              stageInitialRevisionIndexAgainst(records, backgroundJobs, indexStates) ===
              "invalid"
            ) {
              return Object.freeze({ kind: "record_conflict" });
            }
            principals.set(principal.principalId, freezePrincipal(principal));
            this._failAccountBootstrapIfRequested("after_principal");
            externalBindings.set(
              externalBindingKey(lookup),
              freezeExternalBinding(externalBinding),
            );
            this._failAccountBootstrapIfRequested("after_binding");
            knowledgeSpaces.set(
              personalSpace.spaceId,
              freezeKnowledgeSpace(personalSpace),
            );
            this._failAccountBootstrapIfRequested("after_space");
            personalBindings.set(
              personalBinding.principalId,
              freezePersonalBinding(personalBinding),
            );
            memberships.set(
              ownerMembership.membershipId,
              freezeMembership(ownerMembership),
            );
            this._failAccountBootstrapIfRequested("after_membership");
            const account = accountFromMaps(
              principal.principalId,
              principals,
              externalBindings,
              knowledgeSpaces,
              personalBindings,
              memberships,
            );
            if (account === null) {
              throw new Error("account bootstrap aggregate could not be restored");
            }
            this._failAccountBootstrapIfRequested("before_commit");
            return Object.freeze({ kind: "created", account });
          },
        });

        const result = await operation(transaction);
        this._principals = principals;
        this._externalBindings = externalBindings;
        this._knowledgeSpaces = knowledgeSpaces;
        this._personalBindings = personalBindings;
        this._memberships = memberships;
        this._spaces = revisionSpaces;
        this._revisionsById = revisionsById;
        this._reachabilityCounts = null;
        this._backgroundJobs = backgroundJobs;
        this._indexStates = indexStates;
        return result;
      });
    }
}
