import {
  DomainInvariantError,
  SpaceAggregate,
  roleHasCapability,
  version,
  type ApplyMembershipMutationRequest,
  type ApplyMembershipMutationResult,
  type AuthorizationStateQuery,
  type CreateInvitationRequest,
  type CreateInvitationResult,
  type ExternalIdentityBindingLookup,
  type MembershipControlTargetQuery,
  type OrdinaryMindMetadataTransaction,
  type PersonalMindTargetClassification,
  type PersonalMindTargetRequest,
  type RegisteredPrincipalSnapshot,
  type ReissueInvitationRequest,
  type ReissueInvitationResult,
  type SpaceMembership,
  type TransitionInvitationRequest,
  type TransitionInvitationResult,
} from "@mind-diary/application-ports";

import {
  BOUNDED_OPAQUE_ID,
  SHA256_PATTERN,
  accountByBindingFromMaps,
  accountFromMaps,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneBackgroundJob,
  cloneOrdinaryMindIdempotencyRecords,
  cloneRecordMap,
  currentSitesAuthorizationStateFromMaps,
  freezeInvitation,
  freezeInvitationLifecycleSnapshot,
  freezeInvitationSnapshot,
  freezeKnowledgeSpace,
  freezeMembership,
  freezeRegisteredPrincipalSnapshot,
  invitationIdempotencyRecordKey,
  invitationLifecycleActorIsCurrentlyAuthorized,
  invitationLifecycleIdempotencyRecordKey,
  membershipMutationKey,
  readMembershipReplay,
} from "./metadata-store-internals.js";

import {
  RevisionMetadataReadStore,
} from "./revision-metadata-read-store.js";

import {
  type OrdinaryMindTransactionState,
} from "./ordinary-mind-transaction-state.js";

export abstract class RevisionMetadataOrdinaryMembershipStore extends RevisionMetadataReadStore {
  protected _membershipTransactionMethods(
    tx: OrdinaryMindTransactionState,
  ): Pick<OrdinaryMindMetadataTransaction,
    | "readMembershipControlTarget"
    | "applyMembershipMutation"
    | "classifyPersonalMindTarget"
    | "readCurrentAuthorizationState"
    | "readRegisteredPrincipalByExternalBinding"
    | "createInvitation"
    | "transitionInvitation"
    | "reissueInvitation"
  > {
    return Object.freeze({
          readMembershipControlTarget: async (
            query: Readonly<MembershipControlTargetQuery>,
          ) => {
            const space = tx.knowledgeSpaces.get(query.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" as const });
            }
            const membership = [...tx.memberships.values()].find(
              (candidate) =>
                candidate.spaceId === query.spaceId &&
                (query.memberId !== undefined
                  ? candidate.membershipId === query.memberId
                  : candidate.principalId === query.principalId),
            );
            if (!membership) {
              return Object.freeze({ kind: "membership_not_found" as const });
            }
            const personal = [...tx.personalBindings.values()].some(
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
            const replay = readMembershipReplay(tx.membershipMutationRecords, request);
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
            const principal = tx.principals.get(request.principalId);
            const space = tx.knowledgeSpaces.get(request.spaceId);
            if (!principal || principal.state !== "active") {
              return Object.freeze({ kind: "forbidden" });
            }
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "mind_not_found" });
            }
            if (
              [...tx.personalBindings.values()].some(
                (binding) => binding.spaceId === request.spaceId,
              )
            ) {
              return Object.freeze({ kind: "personal_mind" });
            }
            const source = [...tx.memberships.values()].find(
              (candidate) =>
                candidate.spaceId === request.spaceId &&
                candidate.principalId === request.principalId &&
                candidate.state === "active",
            );
            const target = tx.memberships.get(request.targetMembershipId);
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
              tx.auditEvents.has(request.auditEventId) ||
              tx.auditOutbox.has(request.auditOutboxMessageId) ||
              [...tx.auditOutbox.values()].some(
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
            tx.memberships.set(target.membershipId, updatedMembership);
            tx.knowledgeSpaces.set(request.spaceId, updatedSpace);
            tx.auditEvents.set(event.auditEventId, cloneAuditEvent(event));
            tx.auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
            tx.membershipMutationRecords.set(
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
            const target = tx.knowledgeSpaces.get(request.spaceId);
            if (!target || target.state !== "active") {
              return Object.freeze({ kind: "not_found" });
            }
            const personalBinding = [...tx.personalBindings.values()].find(
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
                tx.principals,
                tx.externalBindings,
                tx.knowledgeSpaces,
                tx.personalBindings,
                tx.memberships,
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
              tx.principals,
              tx.knowledgeSpaces,
              tx.memberships,
            ),
          readRegisteredPrincipalByExternalBinding: async (
            lookup: Readonly<ExternalIdentityBindingLookup>,
          ): Promise<Readonly<RegisteredPrincipalSnapshot> | null> => {
            try {
              const account = accountByBindingFromMaps(
                lookup,
                tx.principals,
                tx.externalBindings,
                tx.knowledgeSpaces,
                tx.personalBindings,
                tx.memberships,
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
            const actorPrincipal = tx.principals.get(request.principalId);
            if (!actorPrincipal || actorPrincipal.state !== "active") {
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
            const targetPrincipal = tx.principals.get(request.target.principalId);
            if (
              !targetPrincipal ||
              targetPrincipal.state !== "active" ||
              targetPrincipal.displayName !== request.target.displayName
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            const aggregateMemberships = [...tx.memberships.values()].filter(
              (membership) => membership.spaceId === request.spaceId,
            );
            const aggregateInvitations = [...tx.invitations.values()].filter(
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
            const previous = tx.idempotencyRecords.get(recordKey);
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
              tx.invitations.has(invitation.invitationId) ||
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
                kind: tx.invitations.has(invitation.invitationId)
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
            if (tx.backgroundJobs.has(expiryJob.jobId)) {
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
              tx.invitations,
              freezeInvitation,
            );
            const candidateKnowledgeSpaces = cloneRecordMap(
              tx.knowledgeSpaces,
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
            const candidateBackgroundJobs = new Map(tx.backgroundJobs);
            candidateBackgroundJobs.set(expiryJob.jobId, cloneBackgroundJob(expiryJob));
            this._failOrdinaryMindIfRequested("invitation_after_record");
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
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
            tx.knowledgeSpaces = candidateKnowledgeSpaces;
            tx.invitations = candidateInvitations;
            tx.backgroundJobs = candidateBackgroundJobs;
            tx.idempotencyRecords = candidateIdempotencyRecords;
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
            const currentInvitation = tx.invitations.get(request.invitationId);
            if (!currentInvitation) return Object.freeze({ kind: "invitation_not_found" });
            const space = tx.knowledgeSpaces.get(currentInvitation.spaceId);
            if (!space || space.state !== "active") {
              return Object.freeze({ kind: "invitation_not_found" });
            }
            if ([...tx.personalBindings.values()].some((binding) => binding.spaceId === space.spaceId)) {
              return Object.freeze({ kind: "personal_mind" });
            }
            if (
              !invitationLifecycleActorIsCurrentlyAuthorized(
                request.operation,
                request.principalId,
                currentInvitation,
                tx.principals,
                tx.memberships,
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
            const previous = tx.idempotencyRecords.get(recordKey);
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
            const aggregateMemberships = [...tx.memberships.values()].filter(
              (membership) => membership.spaceId === space.spaceId,
            );
            const aggregateInvitations = [...tx.invitations.values()].filter(
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
                if (tx.memberships.has(request.membershipId)) {
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
            const target = tx.principals.get(currentInvitation.targetPrincipalId);
            if (!transitioned || !target) return Object.freeze({ kind: "invalid_record" });
            const lifecycle = freezeInvitationLifecycleSnapshot({
              invitation: {
                invitation: transitioned,
                target: { principalId: target.principalId, displayName: target.displayName },
              },
              membership: acceptedMembership,
            });
            const candidateSpaces = cloneRecordMap(tx.knowledgeSpaces, freezeKnowledgeSpace);
            const candidateInvitations = cloneRecordMap(tx.invitations, freezeInvitation);
            const candidateMemberships = cloneRecordMap(tx.memberships, freezeMembership);
            candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
            candidateInvitations.set(transitioned.invitationId, freezeInvitation(transitioned));
            this._failOrdinaryMindIfRequested("invitation_lifecycle_after_record");
            if (acceptedMembership) candidateMemberships.set(acceptedMembership.membershipId, acceptedMembership);
            this._failOrdinaryMindIfRequested("invitation_lifecycle_after_membership");
            const candidateIdempotency = cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
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
            tx.knowledgeSpaces = candidateSpaces;
            tx.invitations = candidateInvitations;
            tx.memberships = candidateMemberships;
            tx.idempotencyRecords = candidateIdempotency;
            return Object.freeze({ kind: "transitioned", result: lifecycle, replayed: false });
          },
          reissueInvitation: async (
            request: Readonly<ReissueInvitationRequest>,
          ): Promise<ReissueInvitationResult> => {
            const current = tx.invitations.get(request.invitationId);
            if (!current) return Object.freeze({ kind: "invitation_not_found" });
            const space = tx.knowledgeSpaces.get(current.spaceId);
            if (!space || space.state !== "active") return Object.freeze({ kind: "invitation_not_found" });
            if ([...tx.personalBindings.values()].some((binding) => binding.spaceId === space.spaceId)) {
              return Object.freeze({ kind: "personal_mind" });
            }
            if (
              !invitationLifecycleActorIsCurrentlyAuthorized(
                "reissue_invitation",
                request.principalId,
                current,
                tx.principals,
                tx.memberships,
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
            const previous = tx.idempotencyRecords.get(recordKey);
            if (previous) {
              if (previous.operation !== "reissue_invitation" || previous.canonicalRequestHash !== request.canonicalRequestHash) {
                return Object.freeze({ kind: "idempotency_conflict" });
              }
              return Object.freeze({ kind: "reissued", invitation: freezeInvitationSnapshot(previous.invitation), replayed: true });
            }
            if (!SHA256_PATTERN.test(request.canonicalRequestHash)) return Object.freeze({ kind: "invalid_record" });
            if (current.version !== request.expectedInvitationVersion) return Object.freeze({ kind: "invitation_version_conflict" });
            if (current.state === "accepted") return Object.freeze({ kind: "accepted_invitation" });
            const target = tx.principals.get(current.targetPrincipalId);
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
              tx.invitations.has(request.replacementInvitationId) ||
              tx.backgroundJobs.has(request.expiryJobId)
            ) return Object.freeze({ kind: tx.invitations.has(request.replacementInvitationId) ? "record_conflict" : "expiry_job_conflict" });
            const aggregateMemberships = [...tx.memberships.values()].filter((item) => item.spaceId === space.spaceId);
            const aggregateInvitations = [...tx.invitations.values()].filter((item) => item.spaceId === space.spaceId);
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
            const candidateSpaces = cloneRecordMap(tx.knowledgeSpaces, freezeKnowledgeSpace);
            const candidateInvitations = cloneRecordMap(tx.invitations, freezeInvitation);
            const candidateJobs = new Map(tx.backgroundJobs);
            candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
            for (const item of updated.invitations) candidateInvitations.set(item.invitationId, freezeInvitation(item));
            this._failOrdinaryMindIfRequested("invitation_reissue_after_record");
            candidateJobs.set(expiryJob.jobId, expiryJob);
            this._failOrdinaryMindIfRequested("invitation_reissue_after_job");
            const candidateIdempotency = cloneOrdinaryMindIdempotencyRecords(tx.idempotencyRecords);
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
            tx.knowledgeSpaces = candidateSpaces;
            tx.invitations = candidateInvitations;
            tx.backgroundJobs = candidateJobs;
            tx.idempotencyRecords = candidateIdempotency;
            return Object.freeze({ kind: "reissued", invitation: snapshot, replayed: false });
          },
    });
  }
}
