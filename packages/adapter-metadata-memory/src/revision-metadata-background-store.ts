import type {
  OutboxMessageId,
  RevisionId,
  SpaceId,
} from "./metadata-store-internals.js";
import type {
  AuditOutboxMessage,
  BackgroundJob,
  ClaimAuditOutboxResult,
  ClaimExportJobResult,
  ClaimIndexJobResult,
  ClaimInvitationExpiryJobResult,
  ClaimObjectCleanupResult,
  CompleteInvitationExpiryJobResult,
  ExpireExportJobResult,
  ExportArchiveRecord,
  ExportDownloadGrant,
  ExportJob,
  JobId,
  ObjectCleanupCheckpoint,
  ObjectCleanupNamespace,
  ReadExportDownloadGrantResult,
  RevisionIndexRecoveryCandidate,
  RevisionIndexState,
  SpaceInvitation,
  SpaceTargetPurgeResult,
  UtcInstant,
} from "@mind-diary/application-ports";
import {
  EXPORT_DOWNLOAD_VERIFIER_PATTERN,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneBackgroundJob,
  cloneCapacityReservation,
  cloneExportDownloadGrant,
  cloneExportJob,
  cloneIndexState,
  cloneObjectCleanupCheckpoint,
  cloneRecordMap,
  freezeInvitation,
  freezeKnowledgeSpace,
  indexStateKey,
  revisionIndexJobsForTarget,
  revisionIndexMetadataConsistent,
  stageInitialRevisionIndexAgainst,
  validClaimLease,
  validExportArchive,
} from "./metadata-store-internals.js";
import {
  OBJECT_CLEANUP_NAMESPACES,
  SpaceAggregate,
  isRevisionIndexTerminalFailureCode,
  version,
} from "@mind-diary/application-ports";
import { RevisionMetadataContentStore } from "./revision-metadata-content-store.js";
import { cloneCopyOnWriteValue, copyOnWriteMap } from "./copy-on-write.js";

export abstract class RevisionMetadataBackgroundStore extends RevisionMetadataContentStore {
  async claimObjectCleanup(request: Readonly<{
      now: UtcInstant;
      leaseExpiresAt: UtcInstant;
    }>): Promise<ClaimObjectCleanupResult> {
      return this._runExclusive(async () => {
        if (
          !Number.isFinite(Date.parse(request.now)) ||
          !Number.isFinite(Date.parse(request.leaseExpiresAt)) ||
          Date.parse(request.leaseExpiresAt) <= Date.parse(request.now)
        ) throw new TypeError("object cleanup lease is invalid");
        const current = this._objectCleanupCheckpoint ?? Object.freeze({
          version: 0 as ObjectCleanupCheckpoint["version"],
          namespace: "immutable" as const,
          cursor: null,
          cycleStartedAt: request.now,
          updatedAt: request.now,
          leaseExpiresAt: null,
          retries: 0,
          failures: 0,
        });
        if (
          current.leaseExpiresAt !== null &&
          Date.parse(current.leaseExpiresAt) > Date.parse(request.now)
        ) return Object.freeze({ kind: "busy" });
        const reclaimedLease = current.leaseExpiresAt !== null;
        this._objectCleanupCheckpoint = Object.freeze({
          ...current,
          version: version(current.version + 1),
          updatedAt: request.now,
          leaseExpiresAt: request.leaseExpiresAt,
          retries: current.retries + (reclaimedLease ? 1 : 0),
        });
        return Object.freeze({
          kind: "claimed",
          checkpoint: cloneObjectCleanupCheckpoint(this._objectCleanupCheckpoint),
          reclaimedLease,
        });
      });
    }

  async completeObjectCleanupBatch(request: Readonly<{
      expectedVersion: ObjectCleanupCheckpoint["version"];
      namespace: ObjectCleanupNamespace;
      cursor: string | null;
      cycleStartedAt: UtcInstant;
      completedAt: UtcInstant;
    }>): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._objectCleanupCheckpoint;
        if (
          !current || current.version !== request.expectedVersion ||
          current.leaseExpiresAt === null ||
          !(OBJECT_CLEANUP_NAMESPACES as readonly string[]).includes(request.namespace) ||
          (request.cursor !== null && request.cursor.length > 4096) ||
          !Number.isFinite(Date.parse(request.cycleStartedAt)) ||
          !Number.isFinite(Date.parse(request.completedAt))
        ) return false;
        this._objectCleanupCheckpoint = Object.freeze({
          ...current,
          version: version(current.version + 1),
          namespace: request.namespace,
          cursor: request.cursor,
          cycleStartedAt: request.cycleStartedAt,
          updatedAt: request.completedAt,
          leaseExpiresAt: null,
        });
        return true;
      });
    }

  async failObjectCleanupBatch(request: Readonly<{
      expectedVersion: ObjectCleanupCheckpoint["version"];
      failedAt: UtcInstant;
    }>): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._objectCleanupCheckpoint;
        if (
          !current || current.version !== request.expectedVersion ||
          current.leaseExpiresAt === null || !Number.isFinite(Date.parse(request.failedAt))
        ) return false;
        this._objectCleanupCheckpoint = Object.freeze({
          ...current,
          version: version(current.version + 1),
          updatedAt: request.failedAt,
          leaseExpiresAt: null,
          failures: current.failures + 1,
        });
        return true;
      });
    }

  async listRecoverableInvitationExpiryJobs(
      now: UtcInstant,
      limit: number,
    ): Promise<readonly Readonly<BackgroundJob>[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return Object.freeze([]);
      }
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) return Object.freeze([]);
      return Object.freeze(
        [...this._backgroundJobs.values()]
          .filter((job) => {
            if (job.target.kind !== "expire_invitation" || job.attempts >= 5) {
              return false;
            }
            if (job.state === "queued" || job.state === "failed") {
              return Date.parse(job.availableAt) <= nowMs;
            }
            return job.state === "running" &&
              job.claimExpiresAt !== null &&
              Date.parse(job.claimExpiresAt) <= nowMs;
          })
          .sort((left, right) => {
            const availability = left.availableAt.localeCompare(right.availableAt);
            return availability === 0
              ? String(left.jobId).localeCompare(String(right.jobId), "en")
              : availability;
          })
          .slice(0, limit)
          .map(cloneBackgroundJob),
      );
    }

  async claimInvitationExpiryJob(
      jobId: JobId,
      now: SpaceInvitation["updatedAt"],
      claimExpiresAt: SpaceInvitation["updatedAt"],
    ): Promise<ClaimInvitationExpiryJobResult> {
      return this._runExclusive(async () => {
        if (!validClaimLease(now, claimExpiresAt)) return Object.freeze({ kind: "not_available" });
        const current = this._backgroundJobs.get(jobId);
        if (!current || current.target.kind !== "expire_invitation") return Object.freeze({ kind: "not_found" });
        if (current.state === "succeeded") return Object.freeze({ kind: "completed" });
        const expiredClaim = current.state === "running" && current.claimExpiresAt !== null && Date.parse(current.claimExpiresAt) <= Date.parse(now);
        if (
          (current.state === "running" && !expiredClaim) ||
          (current.state !== "queued" && current.state !== "failed" && !expiredClaim) ||
          (!expiredClaim && Date.parse(current.availableAt) > Date.parse(now))
        ) return Object.freeze({ kind: "not_available" });
        const claimed = cloneBackgroundJob({
          ...current,
          state: "running",
          attempts: current.attempts + 1,
          version: version(current.version + 1),
          claimExpiresAt,
          updatedAt: now,
        });
        this._backgroundJobs.set(jobId, claimed);
        return Object.freeze({ kind: "claimed", job: claimed });
      });
    }

  async completeInvitationExpiryJob(
      jobId: JobId,
      expectedClaimVersion: BackgroundJob["version"],
      completedAt: SpaceInvitation["updatedAt"],
    ): Promise<CompleteInvitationExpiryJobResult> {
      return this._runExclusive(async () => {
        const current = this._backgroundJobs.get(jobId);
        if (!current || current.target.kind !== "expire_invitation") return Object.freeze({ kind: "not_found" });
        if (
          current.state !== "running" ||
          current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null ||
          Date.parse(completedAt) >= Date.parse(current.claimExpiresAt)
        ) return Object.freeze({ kind: "not_available" });
        const invitation = this._invitations.get(current.target.invitationId);
        if (!invitation) return Object.freeze({ kind: "not_found" });
        let result: "expired" | "already_terminal" = "already_terminal";
        const candidateSpaces = cloneRecordMap(this._knowledgeSpaces, freezeKnowledgeSpace);
        const candidateInvitations = cloneRecordMap(this._invitations, freezeInvitation);
        if (invitation.state === "pending") {
          if (Date.parse(invitation.expiresAt) > Date.parse(completedAt)) {
            return Object.freeze({ kind: "not_available" });
          }
          const space = this._knowledgeSpaces.get(invitation.spaceId);
          if (!space || space.state !== "active") return Object.freeze({ kind: "not_found" });
          try {
            const updated = SpaceAggregate.restoreOrdinary({
              space,
              memberships: [...this._memberships.values()].filter((item) => item.spaceId === space.spaceId),
              invitations: [...this._invitations.values()].filter((item) => item.spaceId === space.spaceId),
            }).expireInvitation({
              invitationId: invitation.invitationId,
              expectedInvitationVersion: invitation.version,
              occurredAt: completedAt,
            }).snapshot();
            const expired = updated.invitations.find((item) => item.invitationId === invitation.invitationId);
            if (!expired) return Object.freeze({ kind: "not_found" });
            candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
            candidateInvitations.set(expired.invitationId, freezeInvitation(expired));
            result = "expired";
          } catch {
            return Object.freeze({ kind: "not_available" });
          }
        }
        this._failOrdinaryMindIfRequested("invitation_expiry_after_record");
        const candidateJobs = copyOnWriteMap(this._backgroundJobs, cloneBackgroundJob);
        candidateJobs.set(jobId, cloneBackgroundJob({
          ...current,
          state: "succeeded",
          version: version(current.version + 1),
          claimExpiresAt: null,
          updatedAt: completedAt,
        }));
        this._failOrdinaryMindIfRequested("invitation_expiry_before_commit");
        this._knowledgeSpaces = candidateSpaces;
        this._invitations = candidateInvitations;
        this._backgroundJobs = candidateJobs;
        return Object.freeze({ kind: result });
      });
    }

  async failInvitationExpiryJob(
      jobId: JobId,
      expectedClaimVersion: BackgroundJob["version"],
      failedAt: SpaceInvitation["updatedAt"],
      retryAt: SpaceInvitation["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._backgroundJobs.get(jobId);
        if (
          !current || current.target.kind !== "expire_invitation" ||
          current.state !== "running" || current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null || Date.parse(failedAt) >= Date.parse(current.claimExpiresAt)
        ) return false;
        this._backgroundJobs.set(jobId, cloneBackgroundJob({
          ...current,
          state: "failed",
          version: version(current.version + 1),
          availableAt: retryAt,
          claimExpiresAt: null,
          updatedAt: failedAt,
        }));
        return true;
      });
    }

  async listRecoverableIndexJobs(
      now: RevisionIndexState["updatedAt"],
      limit: number,
    ): Promise<readonly Readonly<BackgroundJob>[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return Object.freeze([]);
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) return Object.freeze([]);
      return Object.freeze(
        [...this._backgroundJobs.values()]
          .filter((job) => {
            if (job.target.kind !== "revision_index") return false;
            if (job.attempts >= 5) return false;
            const indexState = this._indexStates.get(indexStateKey(
              job.target.spaceId,
              job.target.revisionId,
            ));
            if (isRevisionIndexTerminalFailureCode(indexState?.lastFailureCode)) {
              return false;
            }
            if (job.state === "queued" || job.state === "failed") {
              return Date.parse(job.availableAt) <= nowMs;
            }
            return job.state === "running" &&
              job.claimExpiresAt !== null &&
              Date.parse(job.claimExpiresAt) <= nowMs;
          })
          .sort((left, right) => {
            const availability = left.availableAt.localeCompare(right.availableAt);
            return availability === 0
              ? String(left.jobId).localeCompare(String(right.jobId), "en")
              : availability;
          })
          .slice(0, limit)
          .map(cloneBackgroundJob),
      );
    }

  /** Test-only durable corruption fixture for recovery contract coverage. */
    async corruptRevisionIndexMetadataForTest(
      spaceId: SpaceId,
      revisionId: RevisionId,
      mode: "drop_job" | "drop_state",
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        if (mode === "drop_state") {
          return this._indexStates.delete(indexStateKey(spaceId, revisionId));
        }
        if (mode !== "drop_job") return false;
        const jobs = revisionIndexJobsForTarget(this._backgroundJobs, spaceId, revisionId);
        for (const job of jobs) this._backgroundJobs.delete(job.jobId);
        return jobs.length > 0;
      });
    }

  async listActiveRevisionIndexGaps(
      limit: number,
    ): Promise<readonly Readonly<{ readonly spaceId: SpaceId; readonly revisionId: RevisionId }>[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return Object.freeze([]);
      return Object.freeze(
        [...this._knowledgeSpaces.values()]
          .filter((space) =>
            space.state === "active" &&
            !this._indexStates.has(indexStateKey(space.spaceId, space.headRevisionId)))
          .sort((left, right) => String(left.spaceId).localeCompare(String(right.spaceId), "en"))
          .slice(0, limit)
          .map((space) => Object.freeze({
            spaceId: space.spaceId,
            revisionId: space.headRevisionId,
          })),
      );
    }

  async listActiveRevisionIndexRecoveryCandidates(
      limit: number,
    ): Promise<readonly RevisionIndexRecoveryCandidate[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return Object.freeze([]);
      return this._runExclusive(async () => {
        const candidates: RevisionIndexRecoveryCandidate[] = [...this._knowledgeSpaces.values()]
          .filter((space) => space.state === "active")
          .map((space): RevisionIndexRecoveryCandidate | null => {
            const spaceId = space.spaceId;
            const revisionId = space.headRevisionId;
            const state = this._indexStates.get(indexStateKey(spaceId, revisionId));
            const jobs = revisionIndexJobsForTarget(this._backgroundJobs, spaceId, revisionId);
            if (state === undefined && jobs.length === 0) {
              return Object.freeze({ spaceId, revisionId, reason: "metadata_missing" as const });
            }
            if (!revisionIndexMetadataConsistent(state, jobs)) {
              return Object.freeze({ spaceId, revisionId, reason: "metadata_inconsistent" as const });
            }
            return state?.status === "ready"
              ? Object.freeze({
                  spaceId,
                  revisionId,
                  reason: "verify_ready_projection" as const,
                  observedJobId: jobs[0]!.jobId,
                  observedJobVersion: jobs[0]!.version,
                })
              : null;
          })
          .filter((candidate): candidate is RevisionIndexRecoveryCandidate => candidate !== null)
          .sort((left, right) => String(left.spaceId).localeCompare(String(right.spaceId), "en"));
        if (candidates.length === 0) {
          this._revisionIndexRecoveryCursor = 0;
          return Object.freeze([]);
        }
        const start = this._revisionIndexRecoveryCursor % candidates.length;
        const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
        const selected = rotated.slice(0, limit);
        this._revisionIndexRecoveryCursor = (start + selected.length) % candidates.length;
        return Object.freeze(selected);
      });
    }

  async ensureRevisionIndexQueued(
      job: Readonly<BackgroundJob>,
      state: Readonly<RevisionIndexState>,
    ) {
      return this._runExclusive(async () => {
        if (job.target.kind !== "revision_index") {
          return Object.freeze({ kind: "invalid_effects" as const });
        }
        const target = job.target;
        const space = this._knowledgeSpaces.get(target.spaceId);
        if (!space || space.state !== "active") {
          return Object.freeze({ kind: "revision_not_found" as const });
        }
        if (space.headRevisionId !== target.revisionId) {
          return Object.freeze({ kind: "not_current_head" as const });
        }
        const revision = this._revisionsById.get(target.revisionId);
        if (!revision || revision.revision.spaceId !== target.spaceId) {
          return Object.freeze({ kind: "revision_not_found" as const });
        }
        const key = indexStateKey(target.spaceId, target.revisionId);
        const existingState = this._indexStates.get(key);
        const existingJob = [...this._backgroundJobs.values()].find(
          (candidate) =>
            candidate.target.kind === "revision_index" &&
            candidate.target.spaceId === target.spaceId &&
            candidate.target.revisionId === target.revisionId,
        );
        if (existingState && existingJob) {
          return Object.freeze({ kind: "already_present" as const, job: cloneBackgroundJob(existingJob) });
        }
        if (existingState || existingJob) {
          return Object.freeze({ kind: "invalid_effects" as const });
        }
        const jobs = copyOnWriteMap(this._backgroundJobs, cloneBackgroundJob);
        const states = copyOnWriteMap(this._indexStates, cloneCopyOnWriteValue);
        if (stageInitialRevisionIndexAgainst({
          initialRevision: revision,
          initialIndexJob: job,
          initialIndexState: state,
        }, jobs, states, "recovery") !== "staged") {
          return Object.freeze({ kind: "invalid_effects" as const });
        }
        this._backgroundJobs = jobs;
        this._indexStates = states;
        return Object.freeze({ kind: "queued" as const, job: cloneBackgroundJob(job) });
      });
    }

  async repairRevisionIndexQueued(
      job: Readonly<BackgroundJob>,
      state: Readonly<RevisionIndexState>,
      reason: Readonly<
        | { readonly kind: "metadata_inconsistent" }
        | {
            readonly kind: "physical_index_missing";
            readonly expectedReadyJobId: JobId;
            readonly expectedReadyJobVersion: BackgroundJob["version"];
          }
      >,
    ) {
      return this._runExclusive(async () => {
        if (job.target.kind !== "revision_index" ||
            (reason.kind !== "metadata_inconsistent" && reason.kind !== "physical_index_missing")) {
          return Object.freeze({ kind: "invalid_effects" as const });
        }
        const target = job.target;
        const space = this._knowledgeSpaces.get(target.spaceId);
        if (!space || space.state !== "active") {
          return Object.freeze({ kind: "revision_not_found" as const });
        }
        if (space.headRevisionId !== target.revisionId) {
          return Object.freeze({ kind: "not_current_head" as const });
        }
        const revision = this._revisionsById.get(target.revisionId);
        if (!revision || revision.revision.spaceId !== target.spaceId) {
          return Object.freeze({ kind: "revision_not_found" as const });
        }
        const key = indexStateKey(target.spaceId, target.revisionId);
        const existingState = this._indexStates.get(key);
        const existingJobs = revisionIndexJobsForTarget(
          this._backgroundJobs,
          target.spaceId,
          target.revisionId,
        );
        const consistent = revisionIndexMetadataConsistent(existingState, existingJobs);
        if (consistent &&
            (reason.kind === "metadata_inconsistent" ||
              existingState?.status !== "ready" ||
              existingJobs[0]!.jobId !== reason.expectedReadyJobId ||
              existingJobs[0]!.version !== reason.expectedReadyJobVersion)) {
          return Object.freeze({
            kind: "already_present" as const,
            job: cloneBackgroundJob(existingJobs[0]!),
          });
        }
        if (this._backgroundJobs.has(job.jobId) &&
            !existingJobs.some((candidate) => candidate.jobId === job.jobId)) {
          return Object.freeze({ kind: "invalid_effects" as const });
        }
        const candidateJobs = copyOnWriteMap(this._backgroundJobs, cloneBackgroundJob);
        for (const existing of existingJobs) candidateJobs.delete(existing.jobId);
        const candidateStates = copyOnWriteMap(this._indexStates, cloneCopyOnWriteValue);
        candidateStates.delete(key);
        if (stageInitialRevisionIndexAgainst({
          initialRevision: revision,
          initialIndexJob: job,
          initialIndexState: state,
        }, candidateJobs, candidateStates, "recovery") !== "staged") {
          return Object.freeze({ kind: "invalid_effects" as const });
        }
        this._backgroundJobs = candidateJobs;
        this._indexStates = candidateStates;
        return Object.freeze({ kind: "queued" as const, job: cloneBackgroundJob(job) });
      });
    }

  async claimIndexJob(
      jobId: JobId,
      now: RevisionIndexState["updatedAt"],
      claimExpiresAt: RevisionIndexState["updatedAt"],
    ): Promise<ClaimIndexJobResult> {
      return this._runExclusive(async () => {
        if (!validClaimLease(now, claimExpiresAt)) {
          return Object.freeze({ kind: "not_available" });
        }
        const current = this._backgroundJobs.get(jobId);
        if (!current || current.target.kind !== "revision_index") {
          return Object.freeze({ kind: "not_found" });
        }
        if (current.state === "succeeded") return Object.freeze({ kind: "completed" });
        const expiredRunningClaim =
          current.state === "running" &&
          current.claimExpiresAt !== null &&
          Date.parse(current.claimExpiresAt) <= Date.parse(now);
        if (
          (current.state === "running" && !expiredRunningClaim) ||
          (current.state !== "queued" &&
            current.state !== "failed" &&
            !expiredRunningClaim) ||
          (!expiredRunningClaim && Date.parse(current.availableAt) > Date.parse(now))
        ) {
          return Object.freeze({ kind: "not_available" });
        }
        const attempts = current.attempts + 1;
        const job = Object.freeze({
          ...current,
          state: "running" as const,
          attempts,
          version: version(current.version + 1),
          updatedAt: now,
          claimExpiresAt,
        });
        const key = indexStateKey(current.target.spaceId, current.target.revisionId);
        const currentState = this._indexStates.get(key);
        if (!currentState) return Object.freeze({ kind: "not_found" });
        const indexState = Object.freeze({
          ...currentState,
          status: "queued" as const,
          attempts,
          updatedAt: now,
          readyAt: null,
          lastFailureCode: null,
        });
        this._backgroundJobs.set(jobId, job);
        this._indexStates.set(key, indexState);
        return Object.freeze({
          kind: "claimed",
          job: cloneBackgroundJob(job),
          indexState: cloneIndexState(indexState),
        });
      });
    }

  async completeIndexJob(
      jobId: JobId,
      expectedClaimVersion: BackgroundJob["version"],
      completedAt: RevisionIndexState["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._backgroundJobs.get(jobId);
        if (!current || current.target.kind !== "revision_index") return false;
        if (
          current.state !== "running" ||
          current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null ||
          Date.parse(completedAt) >= Date.parse(current.claimExpiresAt)
        ) return false;
        const key = indexStateKey(current.target.spaceId, current.target.revisionId);
        const state = this._indexStates.get(key);
        if (!state) return false;
        this._backgroundJobs.set(
          jobId,
          Object.freeze({
            ...current,
            state: "succeeded",
            version: version(current.version + 1),
            updatedAt: completedAt,
            claimExpiresAt: null,
          }),
        );
        this._indexStates.set(
          key,
          Object.freeze({
            ...state,
            status: "ready",
            updatedAt: completedAt,
            readyAt: completedAt,
            lastFailureCode: null,
          }),
        );
        return true;
      });
    }

  async failIndexJob(
      jobId: JobId,
      expectedClaimVersion: BackgroundJob["version"],
      failureCode: string,
      failedAt: RevisionIndexState["updatedAt"],
      retryAt: RevisionIndexState["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._backgroundJobs.get(jobId);
        if (
          !current ||
          current.target.kind !== "revision_index" ||
          current.state !== "running" ||
          current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null ||
          Date.parse(failedAt) >= Date.parse(current.claimExpiresAt) ||
          typeof failureCode !== "string" ||
          !/^[a-z0-9_]{1,64}$/u.test(failureCode)
        ) {
          return false;
        }
        const key = indexStateKey(current.target.spaceId, current.target.revisionId);
        const state = this._indexStates.get(key);
        if (!state) return false;
        this._backgroundJobs.set(
          jobId,
          Object.freeze({
            ...current,
            state: "failed",
            availableAt: retryAt,
            version: version(current.version + 1),
            updatedAt: failedAt,
            claimExpiresAt: null,
          }),
        );
        this._indexStates.set(
          key,
          Object.freeze({
            ...state,
            status: "failed",
            updatedAt: failedAt,
            readyAt: null,
            lastFailureCode: failureCode,
          }),
        );
        return true;
      });
    }

  async readRevisionIndexState(
      spaceId: SpaceId,
      revisionId: RevisionId,
    ): Promise<Readonly<RevisionIndexState> | null> {
      const state = this._indexStates.get(indexStateKey(spaceId, revisionId));
      return state ? cloneIndexState(state) : null;
    }

  async claimAuditOutbox(
      outboxMessageId: OutboxMessageId,
      now: AuditOutboxMessage["updatedAt"],
      claimExpiresAt: AuditOutboxMessage["updatedAt"],
    ): Promise<ClaimAuditOutboxResult> {
      return this._runExclusive(async () => {
        if (!validClaimLease(now, claimExpiresAt)) {
          return Object.freeze({ kind: "not_available" });
        }
        const current = this._auditOutbox.get(outboxMessageId);
        if (!current) return Object.freeze({ kind: "not_found" });
        if (current.state === "delivered") return Object.freeze({ kind: "completed" });
        const expiredDeliveryClaim =
          current.state === "delivering" &&
          current.claimExpiresAt !== null &&
          Date.parse(current.claimExpiresAt) <= Date.parse(now);
        if (
          (current.state === "delivering" && !expiredDeliveryClaim) ||
          (current.state !== "pending" &&
            current.state !== "failed" &&
            !expiredDeliveryClaim) ||
          (!expiredDeliveryClaim && Date.parse(current.availableAt) > Date.parse(now))
        ) {
          return Object.freeze({ kind: "not_available" });
        }
        const event = this._auditEvents.get(current.auditEventId);
        if (!event) return Object.freeze({ kind: "not_found" });
        const message = Object.freeze({
          ...current,
          state: "delivering" as const,
          attempts: current.attempts + 1,
          version: version(current.version + 1),
          updatedAt: now,
          claimExpiresAt,
        });
        this._auditOutbox.set(outboxMessageId, message);
        return Object.freeze({
          kind: "claimed",
          message: cloneAuditOutbox(message),
          event: cloneAuditEvent(event),
        });
      });
    }

  async completeAuditOutbox(
      outboxMessageId: OutboxMessageId,
      expectedClaimVersion: AuditOutboxMessage["version"],
      completedAt: AuditOutboxMessage["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._auditOutbox.get(outboxMessageId);
        if (!current) return false;
        if (
          current.state !== "delivering" ||
          current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null ||
          Date.parse(completedAt) >= Date.parse(current.claimExpiresAt)
        ) return false;
        this._auditOutbox.set(
          outboxMessageId,
          Object.freeze({
            ...current,
            state: "delivered",
            version: version(current.version + 1),
            updatedAt: completedAt,
            claimExpiresAt: null,
          }),
        );
        return true;
      });
    }

  async failAuditOutbox(
      outboxMessageId: OutboxMessageId,
      expectedClaimVersion: AuditOutboxMessage["version"],
      failedAt: AuditOutboxMessage["updatedAt"],
      retryAt: AuditOutboxMessage["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._auditOutbox.get(outboxMessageId);
        if (
          !current ||
          current.state !== "delivering" ||
          current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null ||
          Date.parse(failedAt) >= Date.parse(current.claimExpiresAt)
        ) return false;
        this._auditOutbox.set(
          outboxMessageId,
          Object.freeze({
            ...current,
            state: "failed",
            availableAt: retryAt,
            version: version(current.version + 1),
            updatedAt: failedAt,
            claimExpiresAt: null,
          }),
        );
        return true;
      });
    }

  async readExportDownloadGrant(
      secretVerifier: ExportDownloadGrant["secretVerifier"],
      now: ExportDownloadGrant["createdAt"],
    ): Promise<ReadExportDownloadGrantResult> {
      return this._runExclusive(async () => {
        if (
          !EXPORT_DOWNLOAD_VERIFIER_PATTERN.test(secretVerifier) ||
          !Number.isFinite(Date.parse(now))
        ) {
          return Object.freeze({ kind: "not_found" });
        }
        const current = this._exportDownloadGrants.get(secretVerifier);
        if (!current) return Object.freeze({ kind: "not_found" });
        if (current.state === "revoked") return Object.freeze({ kind: "revoked" });
        if (current.state === "expired") return Object.freeze({ kind: "expired" });
        const job = this._exportJobs.get(current.jobId);
        const expired =
          Date.parse(now) >= Date.parse(current.expiresAt) ||
          !job ||
          job.state !== "succeeded" ||
          job.archive === null ||
          job.archive.objectKey !== current.objectKey ||
          Date.parse(now) >= Date.parse(job.expiresAt);
        if (expired) {
          this._exportDownloadGrants.set(
            secretVerifier,
            Object.freeze({ ...current, state: "expired" as const }),
          );
          return Object.freeze({ kind: "expired" });
        }
        return Object.freeze({
          kind: "active",
          grant: cloneExportDownloadGrant(current),
        });
      });
    }

  async revokeExportDownloadGrant(
      secretVerifier: ExportDownloadGrant["secretVerifier"],
      revokedAt: ExportDownloadGrant["createdAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        if (
          !EXPORT_DOWNLOAD_VERIFIER_PATTERN.test(secretVerifier) ||
          !Number.isFinite(Date.parse(revokedAt))
        ) {
          return false;
        }
        const current = this._exportDownloadGrants.get(secretVerifier);
        if (!current || current.state === "expired") return false;
        if (current.state === "revoked") return true;
        this._exportDownloadGrants.set(
          secretVerifier,
          Object.freeze({
            ...current,
            state: "revoked" as const,
            revokedAt,
          }),
        );
        return true;
      });
    }

  async readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null> {
      const job = this._exportJobs.get(jobId);
      return job ? cloneExportJob(job) : null;
    }

  async listRecoverableExportJobs(
      now: ExportJob["updatedAt"],
      limit: number,
    ): Promise<readonly Readonly<ExportJob>[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return Object.freeze([]);
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) return Object.freeze([]);
      return Object.freeze(
        [...this._exportJobs.values()]
          .filter((job) => {
            if (job.attempts >= 5 || Date.parse(job.expiresAt) <= nowMs) return false;
            if (job.state === "queued" || job.state === "failed") {
              return Date.parse(job.availableAt) <= nowMs;
            }
            return job.state === "running" &&
              job.claimExpiresAt !== null &&
              Date.parse(job.claimExpiresAt) <= nowMs;
          })
          .sort((left, right) => {
            const availability = left.availableAt.localeCompare(right.availableAt);
            return availability === 0
              ? String(left.jobId).localeCompare(String(right.jobId), "en")
              : availability;
          })
          .slice(0, limit)
          .map(cloneExportJob),
      );
    }

  async claimExportJob(
      jobId: JobId,
      now: ExportJob["updatedAt"],
      claimExpiresAt: ExportJob["updatedAt"],
    ): Promise<ClaimExportJobResult> {
      return this._runExclusive(async () => {
        if (!validClaimLease(now, claimExpiresAt)) {
          return Object.freeze({ kind: "not_available" });
        }
        const current = this._exportJobs.get(jobId);
        if (!current) return Object.freeze({ kind: "not_found" });
        if (current.state === "succeeded") {
          return Object.freeze({ kind: "completed" });
        }
        if (current.state === "expired" || Date.parse(now) >= Date.parse(current.expiresAt)) {
          return Object.freeze({ kind: "expired" });
        }
        const expiredClaim =
          current.state === "running" &&
          current.claimExpiresAt !== null &&
          Date.parse(current.claimExpiresAt) <= Date.parse(now);
        if (
          (current.state === "running" && !expiredClaim) ||
          (current.state !== "queued" && current.state !== "failed" && !expiredClaim) ||
          (!expiredClaim && Date.parse(current.availableAt) > Date.parse(now))
        ) {
          return Object.freeze({ kind: "not_available" });
        }
        const claimed = Object.freeze({
          ...current,
          state: "running" as const,
          version: version(current.version + 1),
          attempts: current.attempts + 1,
          claimExpiresAt,
          updatedAt: now,
          lastFailureCode: null,
        });
        this._exportJobs.set(jobId, claimed);
        return Object.freeze({ kind: "claimed", job: cloneExportJob(claimed) });
      });
    }

  async completeExportJob(
      jobId: JobId,
      expectedClaimVersion: ExportJob["version"],
      archive: Readonly<ExportArchiveRecord>,
      completedAt: ExportJob["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._exportJobs.get(jobId);
        if (
          !current ||
          current.state !== "running" ||
          current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null ||
          Date.parse(completedAt) >= Date.parse(current.claimExpiresAt) ||
          Date.parse(completedAt) >= Date.parse(current.expiresAt) ||
          !validExportArchive(archive)
        ) {
          return false;
        }
        const capacityReservation = [...this._capacityReservations.values()].find(
          (reservation) =>
            reservation.operation === "export" &&
            reservation.operationRef === String(jobId) &&
            reservation.spaceId === current.spaceId,
        );
        if (
          capacityReservation !== undefined &&
          (capacityReservation.state !== "active" ||
            archive.size > capacityReservation.requested.temporaryBytes)
        ) return false;
        this._exportJobs.set(
          jobId,
          Object.freeze({
            ...current,
            state: "succeeded",
            version: version(current.version + 1),
            updatedAt: completedAt,
            completedAt,
            claimExpiresAt: null,
            lastFailureCode: null,
            archive: Object.freeze({ ...archive }),
          }),
        );
        if (capacityReservation !== undefined) {
          this._capacityReservations.set(
            capacityReservation.reservationId,
            cloneCapacityReservation(Object.freeze({
              ...capacityReservation,
              actual: Object.freeze({
                physicalCanonicalBytes: 0,
                temporaryBytes: archive.size,
                d1MetadataBytes: capacityReservation.requested.d1MetadataBytes,
              }),
              state: "consumed" as const,
              updatedAt: completedAt,
            })),
          );
        }
        return true;
      });
    }

  async failExportJob(
      jobId: JobId,
      expectedClaimVersion: ExportJob["version"],
      failureCode: string,
      failedAt: ExportJob["updatedAt"],
      retryAt: ExportJob["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._exportJobs.get(jobId);
        if (
          !current ||
          current.state !== "running" ||
          current.version !== expectedClaimVersion ||
          current.claimExpiresAt === null ||
          Date.parse(failedAt) >= Date.parse(current.claimExpiresAt) ||
          Date.parse(failedAt) >= Date.parse(current.expiresAt) ||
          !/^[a-z0-9_]{1,64}$/u.test(failureCode) ||
          Date.parse(retryAt) <= Date.parse(failedAt)
        ) {
          return false;
        }
        this._exportJobs.set(
          jobId,
          Object.freeze({
            ...current,
            state: "failed",
            version: version(current.version + 1),
            availableAt: retryAt,
            updatedAt: failedAt,
            claimExpiresAt: null,
            completedAt: null,
            lastFailureCode: failureCode,
            archive: null,
          }),
        );
        return true;
      });
    }

  async expireExportJob(
      jobId: JobId,
      now: ExportJob["updatedAt"],
    ): Promise<ExpireExportJobResult> {
      return this._runExclusive(async () => {
        const current = this._exportJobs.get(jobId);
        if (!current) return Object.freeze({ kind: "not_found" });
        if (current.state === "expired") {
          return Object.freeze({
            kind: "expired",
            job: cloneExportJob(current),
            replayed: true,
          });
        }
        if (Date.parse(now) < Date.parse(current.expiresAt)) {
          return Object.freeze({ kind: "not_due" });
        }
        const expired = Object.freeze({
          ...current,
          state: "expired" as const,
          version: version(current.version + 1),
          updatedAt: now,
          claimExpiresAt: null,
          lastFailureCode: current.lastFailureCode,
          archiveCleanedAt: null,
        });
        this._exportJobs.set(jobId, expired);
        for (const [reservationId, reservation] of this._capacityReservations) {
          if (
            reservation.operation === "export" &&
            reservation.operationRef === String(jobId) &&
            reservation.spaceId === current.spaceId &&
            reservation.state === "active"
          ) {
            this._capacityReservations.set(
              reservationId,
              cloneCapacityReservation(Object.freeze({
                ...reservation,
                state: "cleanup_pending" as const,
                updatedAt: now,
              })),
            );
          }
        }
        for (const [verifier, grant] of this._exportDownloadGrants) {
          if (grant.jobId === jobId && grant.state === "active") {
            this._exportDownloadGrants.set(
              verifier,
              Object.freeze({ ...grant, state: "expired" as const }),
            );
          }
        }
        return Object.freeze({
          kind: "expired",
          job: cloneExportJob(expired),
          replayed: false,
        });
      });
    }

  async completeExpiredExportCleanup(
      jobId: JobId,
      expectedVersion: ExportJob["version"],
      cleanedAt: ExportJob["updatedAt"],
    ): Promise<boolean> {
      return this._runExclusive(async () => {
        const current = this._exportJobs.get(jobId);
        if (
          !current ||
          current.state !== "expired" ||
          current.version !== expectedVersion ||
          current.archiveCleanedAt !== null ||
          !Number.isFinite(Date.parse(cleanedAt))
        ) {
          return false;
        }
        this._exportJobs.set(
          jobId,
          Object.freeze({
            ...current,
            version: version(current.version + 1),
            updatedAt: cleanedAt,
            archive: null,
            archiveCleanedAt: cleanedAt,
          }),
        );
        for (const [reservationId, reservation] of this._capacityReservations) {
          if (
            reservation.operation === "export" &&
            reservation.operationRef === String(jobId) &&
            reservation.spaceId === current.spaceId &&
            reservation.state !== "active" &&
            reservation.state !== "released"
          ) {
            this._capacityReservations.set(
              reservationId,
              cloneCapacityReservation(Object.freeze({
                ...reservation,
                state: "released" as const,
                updatedAt: cleanedAt,
              })),
            );
          }
        }
        return true;
      });
    }

  async purgeSpaceTargetRecords(spaceId: SpaceId): Promise<SpaceTargetPurgeResult> {
      return this._runExclusive(async () => {
        for (const [id, note] of this._queuedNotes) {
          if (note.spaceId === spaceId) this._queuedNotes.delete(id);
        }
        const indexKeys = [...this._indexStates]
          .filter(([, state]) => state.spaceId === spaceId)
          .map(([key]) => key);
        const auditIds = [...this._auditEvents]
          .filter(([, event]) => event.spaceId === spaceId)
          .map(([id]) => id);
        const auditIdSet = new Set(auditIds);
        const outboxIds = [...this._auditOutbox]
          .filter(([, message]) => auditIdSet.has(message.auditEventId))
          .map(([id]) => id);
        const outboxIdSet = new Set(outboxIds);
        const invitationIdSet = new Set(
          [...this._invitations.values()]
            .filter((invitation) => invitation.spaceId === spaceId)
            .map((invitation) => invitation.invitationId),
        );
        const jobIds = [...this._backgroundJobs]
          .filter(
            ([, job]) =>
              ("spaceId" in job.target && job.target.spaceId === spaceId) ||
              (job.target.kind === "audit_delivery" &&
                outboxIdSet.has(job.target.outboxMessageId)) ||
              (job.target.kind === "expire_invitation" &&
                invitationIdSet.has(job.target.invitationId)),
          )
          .map(([id]) => id);
        const idempotencyKeys = [...this._idempotencyRecords]
          .filter(([, record]) => record.spaceId === spaceId)
          .map(([key]) => key);
        const exportJobIds = [...this._exportJobs]
          .filter(([, job]) => job.spaceId === spaceId)
          .map(([id]) => id);
        const exportGrantVerifiers = [...this._exportDownloadGrants]
          .filter(([, grant]) => grant.spaceId === spaceId)
          .map(([verifier]) => verifier);
        const bundleFileGrantVerifiers = [...this._bundleFileDownloadGrants]
          .filter(([, grant]) => grant.spaceId === spaceId)
          .map(([verifier]) => verifier);
        const capacityReservationIds = [...this._capacityReservations]
          .filter(([, reservation]) => reservation.spaceId === spaceId)
          .map(([reservationId]) => reservationId);
        jobIds.forEach((id) => this._backgroundJobs.delete(id));
        exportJobIds.forEach((id) => this._exportJobs.delete(id));
        exportGrantVerifiers.forEach((verifier) =>
          this._exportDownloadGrants.delete(verifier));
        bundleFileGrantVerifiers.forEach((verifier) =>
          this._bundleFileDownloadGrants.delete(verifier));
        capacityReservationIds.forEach((reservationId) =>
          this._capacityReservations.delete(reservationId));
        this._capacityReconciledAt.delete(spaceId);
        this._capacityUsageLedger.delete(spaceId);
        indexKeys.forEach((key) => this._indexStates.delete(key));
        outboxIds.forEach((id) => this._auditOutbox.delete(id));
        auditIds.forEach((id) => this._auditEvents.delete(id));
        idempotencyKeys.forEach((key) => this._idempotencyRecords.delete(key));
        return Object.freeze({
          backgroundJobs: jobIds.length + exportJobIds.length,
          indexStates: indexKeys.length,
          auditEvents: auditIds.length,
          auditOutboxMessages: outboxIds.length,
          idempotencyRecords: idempotencyKeys.length,
        });
      });
    }
}
