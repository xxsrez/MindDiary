import type {
  AccountBootstrapFailureStage,
  AccountDeletionFailureStage,
  Envelope,
  OrdinaryMindFailureStage,
  PersonalProfileFailureStage,
  SpaceId,
} from "./metadata-store-internals.js";
import type {
  AccountDeletionCleanupWorkItem,
  AccountDeletionImpactSnapshot,
  AuditEvent,
  AuditOutboxMessage,
  AuthorizationStateQuery,
  BackgroundJob,
  CurrentAuthorizationState,
  ExportDownloadGrant,
  ExportJob,
  HandleReservationSnapshot,
  KnowledgeSpace,
  OrdinaryMindDeletionCleanupWorkItem,
  OrdinaryMindDeletionImpactSnapshot,
  Principal,
  RetiredHandleMarker,
  SpaceInvitation,
  SpaceMembership,
} from "@mind-diary/application-ports";
import {
  freezeReservation,
} from "./handle-registry.js";
import {
  PUBLIC_CATALOG_SNAPSHOT_RETENTION,
  authorizationStateKey,
  cloneAccountDeletionCleanup,
  cloneAccountDeletionImpact,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneAuthorizationState,
  cloneBackgroundJob,
  cloneExportDownloadGrant,
  cloneExportJob,
  cloneOrdinaryMindDeletionCleanup,
  cloneOrdinaryMindDeletionImpact,
  derivePublicMindCatalogSpaceIds,
  freezeInvitation,
  freezeKnowledgeSpace,
  freezeMembership,
  freezePrincipal,
  stagePublicCatalogSnapshot,
} from "./metadata-store-internals.js";
import {
  SpaceAggregate,
  version,
} from "@mind-diary/application-ports";
import { RevisionMetadataBackgroundStore } from "./revision-metadata-background-store.js";

export abstract class RevisionMetadataSupportStore extends RevisionMetadataBackgroundStore {
  async listAuditEventsForTest(): Promise<readonly Readonly<AuditEvent>[]> {
      return Object.freeze([...this._auditEvents.values()].map(cloneAuditEvent));
    }

  async listAuditOutboxForTest(): Promise<readonly Readonly<AuditOutboxMessage>[]> {
      return Object.freeze([...this._auditOutbox.values()].map(cloneAuditOutbox));
    }

  async listBackgroundJobsForTest(): Promise<readonly Readonly<BackgroundJob>[]> {
      return Object.freeze([...this._backgroundJobs.values()].map(cloneBackgroundJob));
    }

  async listExportJobsForTest(): Promise<readonly Readonly<ExportJob>[]> {
      return Object.freeze([...this._exportJobs.values()].map(cloneExportJob));
    }

  async listExportDownloadGrantsForTest(): Promise<
      readonly Readonly<ExportDownloadGrant>[]
    > {
      return Object.freeze(
        [...this._exportDownloadGrants.values()].map(cloneExportDownloadGrant),
      );
    }

  failNextCommitForTest(
      error: Error = new Error("injected revision metadata transaction failure"),
    ): void {
      this._nextCommitFailure = error;
    }

  failNextAccountBootstrapAtForTest(stage: AccountBootstrapFailureStage): void {
      this._nextAccountBootstrapFailureStage = stage;
    }

  failNextPersonalProfileAtForTest(stage: PersonalProfileFailureStage): void {
      this._nextPersonalProfileFailureStage = stage;
    }

  failNextOrdinaryMindAtForTest(stage: OrdinaryMindFailureStage): void {
      this._nextOrdinaryMindFailureStage = stage;
    }

  failNextAccountDeletionAtForTest(stage: AccountDeletionFailureStage): void {
      this._nextAccountDeletionFailureStage = stage;
    }

  async inspectPublicMindCatalogForTest(): Promise<Readonly<{
      generation: number;
      spaceIds: readonly SpaceId[];
      retainedSnapshots: number;
    }>> {
      return Object.freeze({
        generation: this._publicMindCatalogGeneration,
        spaceIds: Object.freeze([...this._publicMindCatalogSpaceIds]),
        retainedSnapshots: this._publicMindCatalogSnapshots.size,
      });
    }

  async inspectDeletionCleanupForTest(): Promise<
      readonly Readonly<OrdinaryMindDeletionCleanupWorkItem>[]
    > {
      return Object.freeze(
        [...this._ordinaryMindDeletionCleanup.values()]
          .map(cloneOrdinaryMindDeletionCleanup)
          .sort((left, right) => left.impactId.localeCompare(right.impactId)),
      );
    }

  async inspectDeletionImpactsForTest(): Promise<
      readonly Readonly<OrdinaryMindDeletionImpactSnapshot>[]
    > {
      return Object.freeze(
        [...this._ordinaryMindDeletionImpacts.values()]
          .map(cloneOrdinaryMindDeletionImpact)
          .sort((left, right) => left.impactId.localeCompare(right.impactId)),
      );
    }

  async inspectAccountDeletionImpactsForTest(): Promise<
      readonly Readonly<AccountDeletionImpactSnapshot>[]
    > {
      return Object.freeze(
        [...this._accountDeletionImpacts.values()]
          .map(cloneAccountDeletionImpact)
          .sort((left, right) => left.impactId.localeCompare(right.impactId)),
      );
    }

  async inspectAccountDeletionCleanupForTest(): Promise<
      readonly Readonly<AccountDeletionCleanupWorkItem>[]
    > {
      return Object.freeze(
        [...this._accountDeletionCleanup.values()]
          .map(cloneAccountDeletionCleanup)
          .sort((left, right) => left.impactId.localeCompare(right.impactId)),
      );
    }

  async inspectRetiredHandlesForTest(): Promise<
      readonly Readonly<RetiredHandleMarker>[]
    > {
      return Object.freeze(
        [...this._retiredHandles.values()]
          .map((marker) => Object.freeze({ ...marker }))
          .sort((left, right) =>
            `${left.host}\u0000${left.canonicalHandle}`.localeCompare(
              `${right.host}\u0000${right.canonicalHandle}`,
            ),
          ),
      );
    }

  /** Test-only derived projection corruption; canonical Mind state is untouched. */
    async corruptPublicMindCatalogForTest(
      candidateIds: readonly unknown[],
    ): Promise<void> {
      await this._runExclusive(async () => {
        this._publicMindCatalogGeneration += 1;
        this._publicMindCatalogSpaceIds = new Set(
          candidateIds as readonly SpaceId[],
        );
        this._publicMindCatalogSnapshots.set(
          this._publicMindCatalogGeneration,
          Object.freeze([...candidateIds]) as readonly SpaceId[],
        );
        while (
          this._publicMindCatalogSnapshots.size >
          PUBLIC_CATALOG_SNAPSHOT_RETENTION
        ) {
          const oldest = Math.min(...this._publicMindCatalogSnapshots.keys());
          this._publicMindCatalogSnapshots.delete(oldest);
        }
      });
    }

  /** Test-only concurrent metadata mutation; content HEAD/history are untouched. */
    async bumpPersonalMindMetadataVersionForTest(
      principalId: Principal["principalId"],
      occurredAt: KnowledgeSpace["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const binding = this._personalBindings.get(principalId);
        if (!binding) return false;
        const space = this._knowledgeSpaces.get(binding.spaceId);
        if (!space) return false;
        this._knowledgeSpaces.set(
          space.spaceId,
          freezeKnowledgeSpace({
            ...space,
            metadataVersion: version(space.metadataVersion + 1),
            updatedAt: occurredAt,
          }),
        );
        return true;
      });
    }

  /** Test-only concurrent ordinary metadata mutation; access and revisions stay fixed. */
    async bumpOrdinaryMindMetadataVersionForTest(
      spaceId: KnowledgeSpace["spaceId"],
      occurredAt: KnowledgeSpace["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        if (
          [...this._personalBindings.values()].some(
            (binding) => binding.spaceId === spaceId,
          )
        ) {
          return false;
        }
        const space = this._knowledgeSpaces.get(spaceId);
        if (!space) return false;
        this._knowledgeSpaces.set(
          spaceId,
          freezeKnowledgeSpace({
            ...space,
            metadataVersion: version(space.metadataVersion + 1),
            updatedAt: occurredAt,
          }),
        );
        return true;
      });
    }

  /** Test-only account-deletion interleaving for current authorization reads. */
    async disablePrincipalForTest(
      principalId: Principal["principalId"],
      occurredAt: Principal["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const principal = this._principals.get(principalId);
        if (!principal || principal.state !== "active") return false;
        this._principals.set(
          principalId,
          freezePrincipal({
            ...principal,
            state: "deleted",
            profileVersion: version(principal.profileVersion + 1),
            updatedAt: occurredAt,
          }),
        );
        return true;
      });
    }

  /** Test-only valid non-owner membership setup for current-state authorization races. */
    async grantOrdinaryMembershipForTest(
      membership: Readonly<SpaceMembership>,
      occurredAt: KnowledgeSpace["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const space = this._knowledgeSpaces.get(membership.spaceId);
        const principal = this._principals.get(membership.principalId);
        if (
          !space ||
          space.state !== "active" ||
          !principal ||
          principal.state !== "active" ||
          membership.state !== "active" ||
          membership.role === "owner" ||
          this._memberships.has(membership.membershipId) ||
          [...this._personalBindings.values()].some(
            (binding) => binding.spaceId === membership.spaceId,
          ) ||
          [...this._memberships.values()].some(
            (candidate) =>
              candidate.spaceId === membership.spaceId &&
              candidate.principalId === membership.principalId &&
              candidate.state === "active",
          )
        ) {
          return false;
        }
        const updatedSpace = freezeKnowledgeSpace({
          ...space,
          metadataVersion: version(space.metadataVersion + 1),
          accessVersion: version(space.accessVersion + 1),
          updatedAt: occurredAt,
        });
        const candidateMemberships = [
          ...this._memberships.values(),
          freezeMembership(membership),
        ].filter((candidate) => candidate.spaceId === space.spaceId);
        try {
          SpaceAggregate.restoreOrdinary({
            space: updatedSpace,
            memberships: candidateMemberships,
          });
        } catch {
          return false;
        }
        this._knowledgeSpaces.set(space.spaceId, updatedSpace);
        this._memberships.set(
          membership.membershipId,
          freezeMembership(membership),
        );
        return true;
      });
    }

  /** Test-only access revocation while another active Owner preserves the aggregate. */
    async revokeOrdinaryMembershipForTest(
      spaceId: KnowledgeSpace["spaceId"],
      principalId: Principal["principalId"],
      occurredAt: KnowledgeSpace["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const space = this._knowledgeSpaces.get(spaceId);
        const current = [...this._memberships.values()].find(
          (membership) =>
            membership.spaceId === spaceId &&
            membership.principalId === principalId &&
            membership.state === "active",
        );
        if (!space || !current || current.role === "owner") return false;
        const revoked = freezeMembership({
          ...current,
          state: "revoked",
          version: version(current.version + 1),
          updatedAt: occurredAt,
          updatedBy: principalId,
        });
        const updatedSpace = freezeKnowledgeSpace({
          ...space,
          metadataVersion: version(space.metadataVersion + 1),
          accessVersion: version(space.accessVersion + 1),
          updatedAt: occurredAt,
        });
        const candidateMemberships = [...this._memberships.values()]
          .filter((membership) => membership.spaceId === spaceId)
          .map((membership) =>
            membership.membershipId === revoked.membershipId
              ? revoked
              : membership,
          );
        try {
          SpaceAggregate.restoreOrdinary({
            space: updatedSpace,
            memberships: candidateMemberships,
          });
        } catch {
          return false;
        }
        this._knowledgeSpaces.set(spaceId, updatedSpace);
        this._memberships.set(revoked.membershipId, revoked);
        return true;
      });
    }

  /** Test-only atomic ownership transfer using the real aggregate records. */
    async transferOrdinaryOwnershipForTest(
      spaceId: KnowledgeSpace["spaceId"],
      sourcePrincipalId: Principal["principalId"],
      targetPrincipalId: Principal["principalId"],
      occurredAt: KnowledgeSpace["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const space = this._knowledgeSpaces.get(spaceId);
        if (
          !space ||
          space.state !== "active" ||
          [...this._personalBindings.values()].some(
            (binding) => binding.spaceId === spaceId,
          )
        ) {
          return false;
        }
        const aggregateMemberships = [...this._memberships.values()].filter(
          (membership) => membership.spaceId === spaceId,
        );
        const source = aggregateMemberships.find(
          (membership) =>
            membership.principalId === sourcePrincipalId &&
            membership.state === "active",
        );
        const target = aggregateMemberships.find(
          (membership) =>
            membership.principalId === targetPrincipalId &&
            membership.state === "active",
        );
        if (!source || !target) return false;
        try {
          const transferred = SpaceAggregate.restoreOrdinary({
            space,
            memberships: aggregateMemberships,
          })
            .transferOwnership({
              sourcePrincipalId,
              targetPrincipalId,
              expectedMetadataVersion: space.metadataVersion,
              expectedSourceMembershipVersion: source.version,
              expectedTargetMembershipVersion: target.version,
              occurredAt,
            })
            .snapshot();
          this._knowledgeSpaces.set(
            spaceId,
            freezeKnowledgeSpace(transferred.space),
          );
          for (const membership of transferred.memberships) {
            this._memberships.set(
              membership.membershipId,
              freezeMembership(membership),
            );
          }
          return true;
        } catch {
          return false;
        }
      });
    }

  /** Test-only current visibility transition with the same access-epoch effect. */
    async changeOrdinaryVisibilityForTest(
      spaceId: KnowledgeSpace["spaceId"],
      visibility: KnowledgeSpace["visibility"],
      occurredAt: KnowledgeSpace["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const space = this._knowledgeSpaces.get(spaceId);
        if (
          !space ||
          space.state !== "active" ||
          !["private", "unlisted", "public"].includes(visibility) ||
          [...this._personalBindings.values()].some(
            (binding) => binding.spaceId === spaceId,
          )
        ) {
          return false;
        }
        if (space.visibility === visibility) return true;
        this._knowledgeSpaces.set(
          spaceId,
          freezeKnowledgeSpace({
            ...space,
            visibility,
            metadataVersion: version(space.metadataVersion + 1),
            accessVersion: version(space.accessVersion + 1),
            updatedAt: occurredAt,
          }),
        );
        this._publicMindCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
          this._knowledgeSpaces,
          this._personalBindings,
        );
        this._publicMindCatalogGeneration += 1;
        stagePublicCatalogSnapshot(
          this._publicMindCatalogGeneration,
          this._publicMindCatalogSpaceIds,
          this._publicMindCatalogSnapshots,
        );
        return true;
      });
    }

  /** Test-only corrupt aggregate fixture; the canonical registry is untouched. */
    async corruptOrdinaryHandleForTest(
      spaceId: KnowledgeSpace["spaceId"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const space = this._knowledgeSpaces.get(spaceId);
        if (
          !space ||
          [...this._personalBindings.values()].some(
            (binding) => binding.spaceId === spaceId,
          )
        ) {
          return false;
        }
        this._knowledgeSpaces.set(
          spaceId,
          freezeKnowledgeSpace({
            ...space,
            normalizedHandle: `${space.normalizedHandle}-corrupt` as KnowledgeSpace["normalizedHandle"],
          }),
        );
        return true;
      });
    }

  /** Test-only deletion-race state; the handle remains reserved until delete commits. */
    async markOrdinaryMindDeletingForTest(
      spaceId: KnowledgeSpace["spaceId"],
      occurredAt: KnowledgeSpace["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const space = this._knowledgeSpaces.get(spaceId);
        if (
          !space ||
          [...this._personalBindings.values()].some(
            (binding) => binding.spaceId === spaceId,
          )
        ) {
          return false;
        }
        const deleting = freezeKnowledgeSpace({
          ...space,
          state: "deleting",
          metadataVersion: version(space.metadataVersion + 1),
          accessVersion: version(space.accessVersion + 1),
          updatedAt: occurredAt,
        });
        this._knowledgeSpaces.set(spaceId, deleting);
        return true;
      });
    }

  async inspectOrdinaryMindStateForTest(
      spaceId: KnowledgeSpace["spaceId"],
    ): Promise<Readonly<{
      space: Readonly<KnowledgeSpace>;
      memberships: readonly Readonly<SpaceMembership>[];
      invitations: readonly Readonly<SpaceInvitation>[];
      revisions: readonly Envelope[];
      reservation: Readonly<HandleReservationSnapshot>;
    }> | null> {
      if (
        [...this._personalBindings.values()].some(
          (binding) => binding.spaceId === spaceId,
        )
      ) {
        return null;
      }
      const space = this._knowledgeSpaces.get(spaceId);
      const reservation = this._activeHandlesBySpace.get(spaceId);
      if (!space || !reservation) return null;
      const memberships = [...this._memberships.values()]
        .filter((membership) => membership.spaceId === spaceId)
        .map(freezeMembership);
      const invitations = [...this._invitations.values()]
        .filter((invitation) => invitation.spaceId === spaceId)
        .map(freezeInvitation);
      const revisions = await this.listRevisions(spaceId);
      return Object.freeze({
        space: freezeKnowledgeSpace(space),
        memberships: Object.freeze(memberships),
        invitations: Object.freeze(invitations),
        revisions,
        reservation: freezeReservation(
          reservation.host,
          reservation.canonicalHandle,
          reservation.spaceId,
        ),
      });
    }

  async inspectOrdinaryMindTotalsForTest(): Promise<Readonly<{
      minds: number;
      reservations: number;
      memberships: number;
      revisions: number;
      idempotencyRecords: number;
    }>> {
      const personalSpaceIds = new Set(
        [...this._personalBindings.values()].map((binding) => binding.spaceId),
      );
      const ordinarySpaceIds = new Set(
        [...this._knowledgeSpaces.keys()].filter(
          (spaceId) => !personalSpaceIds.has(spaceId),
        ),
      );
      return Object.freeze({
        minds: ordinarySpaceIds.size,
        reservations: [...this._activeHandlesBySpace.keys()].filter((spaceId) =>
          ordinarySpaceIds.has(spaceId),
        ).length,
        memberships: [...this._memberships.values()].filter((membership) =>
          ordinarySpaceIds.has(membership.spaceId),
        ).length,
        revisions: [...this._revisionsById.values()].filter((envelope) =>
          ordinarySpaceIds.has(envelope.revision.spaceId),
        ).length,
        idempotencyRecords: this._ordinaryMindIdempotencyRecords.size,
      });
    }

  async inspectAccountBootstrapStateForTest(): Promise<Readonly<{
      principals: number;
      bindings: number;
      personalMinds: number;
      memberships: number;
      revisions: number;
    }>> {
      const personalSpaceIds = new Set(
        [...this._personalBindings.values()].map((binding) => binding.spaceId),
      );
      return Object.freeze({
        principals: this._principals.size,
        bindings: this._externalBindings.size,
        personalMinds: this._personalBindings.size,
        memberships: this._memberships.size,
        revisions: [...this._revisionsById.values()].filter((envelope) =>
          personalSpaceIds.has(envelope.revision.spaceId),
        ).length,
      });
    }

  /** Test/local fixture hook; production authorization mutations use metadata transactions. */
    setCurrentAuthorizationStateForTest(
      query: AuthorizationStateQuery,
      state: CurrentAuthorizationState | null,
    ): void {
      const key = authorizationStateKey(query);
      if (state === null) {
        this._authorizationStates.delete(key);
        return;
      }
      this._authorizationStates.set(key, cloneAuthorizationState(state));
    }
}
