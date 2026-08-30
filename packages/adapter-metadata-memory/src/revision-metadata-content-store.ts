import type {
  CompletedIdempotencyRecord,
  Digest,
  RevisionId,
  SpaceId,
} from "./metadata-store-internals.js";
import type {
  ApplyReadMindBindingRequest,
  AuthorizationStateQuery,
  BundleFileDownloadGrant,
  BundleFileDownloadGrantTransaction,
  CheckIdempotencyRequest,
  CompleteIdempotencyRequest,
  ConsumeBundleFileDownloadGrantResult,
  ConsumeStagedBundleFilesRequest,
  ContentCommitMetadataTransaction,
  CreateBundleFileDownloadGrantResult,
  CreateExportDownloadGrantResult,
  CreateExportJobResult,
  ExportDownloadGrant,
  ExportDownloadGrantTransaction,
  ExportJob,
  ExportStartTransaction,
  JobId,
  MarkdownImportMetadataTransaction,
  MarkdownImportPlan,
  MarkdownImportSession,
  MarkdownImportStagedFile,
  MindBindingOwnerId,
  PrincipalId,
  PrincipalMindUsageWritePin,
  RevisionCommitRequest,
  RevisionCommitResult,
  StageContentCommitEffectsRequest,
  StagedBundleFileId,
} from "@mind-diary/application-ports";
import {
  authorizationStateKey,
  bundleFileRetainedQuotaAllows,
  capacityUsageFromCanonicalState,
  checkIdempotencyAgainst,
  cloneAuditEvent,
  cloneAuditOutbox,
  cloneAuthorizationState,
  cloneBackgroundJob,
  cloneBundleFileDownloadGrant,
  cloneBundleFileDownloadGrants,
  cloneCapacityReservation,
  cloneCapacityReservations,
  cloneExportDownloadGrant,
  cloneExportDownloadGrants,
  cloneExportJob,
  cloneExportJobs,
  cloneIdempotencyRecord,
  cloneIdempotencyRecords,
  cloneIndexState,
  cloneRecordMap,
  cloneSpaces,
  compareUnicodeScalarValues,
  completeIdempotencyAgainst,
  consumeStagedBundleFilesAgainst,
  currentSitesAuthorizationStateFromMaps,
  envelopesEqual,
  freezeKnowledgeSpace,
  freezeMarkdownImportFailure,
  freezeMarkdownImportPlan,
  freezeMarkdownImportSession,
  freezeMarkdownImportStagedFile,
  freezeStagedBundleFile,
  markdownImportBatchKey,
  markdownImportKey,
  readBundleFileDownloadGrantAgainst,
  stageContentCommitEffectsAgainst,
  validBundleFileDownloadGrant,
  validExportDownloadGrant,
  validInitialExportJob,
} from "./metadata-store-internals.js";
import {
  version,
} from "@mind-diary/application-ports";
import { RevisionMetadataOrdinaryStore } from "./revision-metadata-ordinary-store.js";

export abstract class RevisionMetadataContentStore extends RevisionMetadataOrdinaryStore {
  async commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult> {
      return this.runContentCommitTransaction((transaction) =>
        transaction.commitRevision(request),
      );
    }

  async readMarkdownImportPlan(
      planId: string,
    ): Promise<Readonly<MarkdownImportPlan> | null> {
      const plan = this._markdownImportPlans.get(planId);
      return plan === undefined ? null : freezeMarkdownImportPlan(plan);
    }

  async readMarkdownImportSession(
      importId: string,
    ): Promise<Readonly<MarkdownImportSession> | null> {
      const session = this._markdownImportSessions.get(importId);
      return session === undefined ? null : freezeMarkdownImportSession(session);
    }

  async listMarkdownImportStagedFiles(
      importId: string,
    ): Promise<readonly Readonly<MarkdownImportStagedFile>[]> {
      return Object.freeze([...this._markdownImportStagedFiles.values()]
        .filter((file) => file.importId === importId)
        .sort((left, right) =>
          left.checkpoint - right.checkpoint ||
          compareUnicodeScalarValues(left.path, right.path),
        )
        .map(freezeMarkdownImportStagedFile));
    }

  async runMarkdownImportTransaction<Result>(
      operation: (transaction: MarkdownImportMetadataTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this.runContentCommitTransaction((transaction) =>
        operation(transaction as MarkdownImportMetadataTransaction));
    }

  async runContentCommitTransaction<Result>(
      operation: (
        transaction: ContentCommitMetadataTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const spaces = cloneSpaces(this._spaces);
        const revisionsById = new Map(this._revisionsById);
        const knowledgeSpaces = cloneRecordMap(
          this._knowledgeSpaces,
          freezeKnowledgeSpace,
        );
        const principals = this._principals;
        const memberships = this._memberships;
        const idempotencyRecords = cloneIdempotencyRecords(this._idempotencyRecords);
        const auditEvents = new Map(
          [...this._auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
        );
        const auditOutbox = new Map(
          [...this._auditOutbox].map(([id, message]) => [id, cloneAuditOutbox(message)]),
        );
        const backgroundJobs = new Map(
          [...this._backgroundJobs].map(([id, job]) => [id, cloneBackgroundJob(job)]),
        );
        const indexStates = new Map(
          [...this._indexStates].map(([key, state]) => [key, cloneIndexState(state)]),
        );
        const stagedBundleFiles = new Map(this._stagedBundleFiles);
        const markdownImportPlans = new Map(this._markdownImportPlans);
        const markdownImportSessions = new Map(this._markdownImportSessions);
        const markdownImportStagedFiles = new Map(this._markdownImportStagedFiles);
        const markdownImportPlanKeys = new Map(this._markdownImportPlanKeys);
        const markdownImportSessionKeys = new Map(this._markdownImportSessionKeys);
        const markdownImportBatchHashes = new Map(this._markdownImportBatchHashes);
        const capacityReservations = cloneCapacityReservations(this._capacityReservations);
        const capacityTransaction = this._capacityTransaction(capacityReservations);
        const authorizationStates = new Map(
          [...this._authorizationStates].map(([key, state]) => [
            key,
            cloneAuthorizationState(state),
          ]),
        );
        const transaction: MarkdownImportMetadataTransaction = Object.freeze({
          ...capacityTransaction,
          kind: "authorization-transaction" as const,
          readCredentialWriteTarget: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => this.readCredentialWriteTarget(bindingOwnerId, principalId),
          readMindBindingSet: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
            occurredAt: ApplyReadMindBindingRequest["occurredAt"],
          ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
          readPrincipalMindUsage: (principalId: PrincipalId) =>
            this.readPrincipalMindUsage(principalId),
          validatePrincipalMindUsageWritePin: (
            pin: Readonly<PrincipalMindUsageWritePin>,
          ) =>
            this.validatePrincipalMindUsageWritePin(pin),
          readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
            const current = currentSitesAuthorizationStateFromMaps(
              query,
              principals,
              knowledgeSpaces,
              memberships,
            );
            if (current !== null) return current;
            const state = authorizationStates.get(authorizationStateKey(query));
            return state ? cloneAuthorizationState(state) : null;
          },
          readHead: async (spaceId: SpaceId) => spaces.get(spaceId)?.head ?? null,
          readRevision: async (spaceId: SpaceId, revisionId: RevisionId) =>
            spaces.get(spaceId)?.revisions.get(revisionId) ?? null,
          readStagedBundleFile: async (stagedFileId: StagedBundleFileId) => {
            const record = stagedBundleFiles.get(stagedFileId);
            return record === undefined ? null : freezeStagedBundleFile(record);
          },
          consumeStagedBundleFiles: async (
            request: Readonly<ConsumeStagedBundleFilesRequest>,
          ) => consumeStagedBundleFilesAgainst(request, stagedBundleFiles),
          checkBundleFileRetainedQuota: async (
            request: Parameters<
              ContentCommitMetadataTransaction["checkBundleFileRetainedQuota"]
            >[0],
          ) =>
            bundleFileRetainedQuotaAllows(request, spaces),
          checkIdempotency: async (request: CheckIdempotencyRequest) =>
            checkIdempotencyAgainst(request, idempotencyRecords),
          commitRevision: async (request: RevisionCommitRequest) => {
            const aggregate = knowledgeSpaces.get(request.envelope.revision.spaceId);
            const existing = revisionsById.get(request.envelope.revision.revisionId);
            const isExactReplay =
              existing !== undefined && envelopesEqual(existing, request.envelope);
            if (
              aggregate &&
              !isExactReplay &&
              aggregate.headRevisionId !== request.expectedHeadRevisionId
            ) {
              return Object.freeze({
                kind: "stale_head" as const,
                currentHeadRevisionId: aggregate.headRevisionId,
              });
            }

            const committed = await this._commitRevisionAgainst(
              request,
              spaces,
              revisionsById,
            );
            const committedRevisionId = request.envelope.revision.revisionId;
            if (
              committed.kind === "committed" &&
              aggregate &&
              spaces.get(aggregate.spaceId)?.head === committedRevisionId &&
              aggregate.headRevisionId !== committedRevisionId
            ) {
              knowledgeSpaces.set(
                aggregate.spaceId,
                freezeKnowledgeSpace({
                  ...aggregate,
                  headRevisionId: committedRevisionId,
                }),
              );
            }
            return committed;
          },
          completeIdempotency: async (
            request: CompleteIdempotencyRequest,
          ) => completeIdempotencyAgainst(request, idempotencyRecords),
          stageContentCommitEffects: async (
            request: StageContentCommitEffectsRequest,
          ) =>
            stageContentCommitEffectsAgainst(
              request,
              auditEvents,
              auditOutbox,
              backgroundJobs,
              indexStates,
              revisionsById,
            ),
          readMarkdownImportPlan: async (planId: string) => {
            const plan = markdownImportPlans.get(planId);
            return plan === undefined ? null : freezeMarkdownImportPlan(plan);
          },
          createMarkdownImportPlan: async (
            plan: Readonly<MarkdownImportPlan>,
            siteD1MetadataLimit: number,
          ) => {
            const existingById = markdownImportPlans.get(plan.planId);
            if (existingById !== undefined) {
              return JSON.stringify(existingById) === JSON.stringify(plan)
                ? Object.freeze({ kind: "created" as const, plan: freezeMarkdownImportPlan(existingById), replayed: true })
                : Object.freeze({ kind: "id_collision" as const });
            }
            const key = markdownImportKey(plan.principalId, plan.spaceId, plan.idempotencyKey);
            const existingId = markdownImportPlanKeys.get(key);
            if (existingId !== undefined) {
              const existing = markdownImportPlans.get(existingId);
              if (existing === undefined) throw new Error("Markdown import plan key is corrupt");
              return existing.canonicalRequestHash === plan.canonicalRequestHash
                ? Object.freeze({ kind: "created" as const, plan: freezeMarkdownImportPlan(existing), replayed: true })
                : Object.freeze({ kind: "idempotency_conflict" as const });
            }
            if (!Number.isSafeInteger(siteD1MetadataLimit) || siteD1MetadataLimit < 1) {
              throw new TypeError("Markdown import plan D1 limit is invalid");
            }
            const usage = capacityUsageFromCanonicalState({
              spaceIds: new Set(spaces.keys()),
              spaces,
              stagedBundleFiles,
              exportJobs: this._exportJobs,
              markdownImportPlans,
              markdownImportSessions,
              markdownImportStagedFiles,
              reservations: capacityReservations,
              reconciledAt: this._capacityReconciledAt,
            });
            if (usage.d1MetadataBytes + 512 + plan.files.length * 160 > siteD1MetadataLimit) {
              this._capacityQuotaRejects += 1;
              return Object.freeze({ kind: "capacity_rejected" as const });
            }
            const stored = freezeMarkdownImportPlan(plan);
            markdownImportPlans.set(plan.planId, stored);
            markdownImportPlanKeys.set(key, plan.planId);
            return Object.freeze({ kind: "created" as const, plan: stored, replayed: false });
          },
          readMarkdownImportSession: async (importId: string) => {
            const session = markdownImportSessions.get(importId);
            return session === undefined ? null : freezeMarkdownImportSession(session);
          },
          readMarkdownImportSessionForPlan: async (planId: string) => {
            const session = [...markdownImportSessions.values()].find(
              (candidate) => candidate.planId === planId,
            );
            return session === undefined ? null : freezeMarkdownImportSession(session);
          },
          createMarkdownImportSession: async (session: Readonly<MarkdownImportSession>) => {
            const existingById = markdownImportSessions.get(session.importId);
            if (existingById !== undefined) {
              return JSON.stringify(existingById) === JSON.stringify(session)
                ? Object.freeze({ kind: "created" as const, session: freezeMarkdownImportSession(existingById), replayed: true })
                : Object.freeze({ kind: "id_collision" as const });
            }
            const key = markdownImportKey(
              session.principalId,
              session.spaceId,
              session.idempotencyKey,
            );
            const existingId = markdownImportSessionKeys.get(key);
            if (existingId !== undefined) {
              const existing = markdownImportSessions.get(existingId);
              if (existing === undefined) throw new Error("Markdown import session key is corrupt");
              return existing.canonicalRequestHash === session.canonicalRequestHash
                ? Object.freeze({ kind: "created" as const, session: freezeMarkdownImportSession(existing), replayed: true })
                : Object.freeze({ kind: "idempotency_conflict" as const });
            }
            const claimedPlan = [...markdownImportSessions.values()].find(
              (existing) => existing.planId === session.planId,
            );
            if (claimedPlan !== undefined) {
              return Object.freeze({ kind: "idempotency_conflict" as const });
            }
            const plan = markdownImportPlans.get(session.planId);
            if (
              plan === undefined || plan.principalId !== session.principalId ||
              plan.spaceId !== session.spaceId
            ) return Object.freeze({ kind: "plan_not_found" as const });
            if (Date.parse(plan.expiresAt) <= Date.parse(session.createdAt)) {
              return Object.freeze({ kind: "plan_expired" as const });
            }
            if ((spaces.get(session.spaceId)?.head ?? null) !== session.expectedRevisionId) {
              return Object.freeze({ kind: "head_conflict" as const });
            }
            const stored = freezeMarkdownImportSession(session);
            markdownImportSessions.set(session.importId, stored);
            markdownImportSessionKeys.set(key, session.importId);
            return Object.freeze({ kind: "created" as const, session: stored, replayed: false });
          },
          listMarkdownImportStagedFiles: async (importId: string) =>
            Object.freeze([...markdownImportStagedFiles.values()]
              .filter((file) => file.importId === importId)
              .sort((left, right) =>
                left.checkpoint - right.checkpoint ||
                compareUnicodeScalarValues(left.path, right.path),
              )
              .map(freezeMarkdownImportStagedFile)),
          stageMarkdownImportBatch: async (
            request: Parameters<
              MarkdownImportMetadataTransaction["stageMarkdownImportBatch"]
            >[0],
          ) => {
            const current = markdownImportSessions.get(request.importId);
            if (current === undefined) return Object.freeze({ kind: "not_found" as const });
            const batchKey = markdownImportBatchKey(request.importId, request.checkpoint);
            const existingHash = markdownImportBatchHashes.get(batchKey);
            if (existingHash !== undefined) {
              return existingHash === request.canonicalRequestHash
                ? Object.freeze({ kind: "staged" as const, session: freezeMarkdownImportSession(current), replayed: true })
                : Object.freeze({ kind: "idempotency_conflict" as const });
            }
            if (current.version !== request.expectedVersion || current.state !== "active") {
              return Object.freeze({ kind: "state_conflict" as const });
            }
            if (request.checkpoint !== current.checkpoint + 1) {
              return Object.freeze({ kind: "checkpoint_conflict" as const });
            }
            const plan = markdownImportPlans.get(current.planId);
            if (plan === undefined) return Object.freeze({ kind: "state_conflict" as const });
            const planned = new Map(plan.files.map((file) => [file.path, file]));
            const alreadyStaged = new Set([...markdownImportStagedFiles.values()]
              .filter((file) => file.importId === current.importId)
              .map((file) => file.path));
            for (const file of request.files) {
              const expected = planned.get(file.path);
              if (
                file.importId !== current.importId ||
                file.checkpoint !== request.checkpoint ||
                expected === undefined || expected.sha256 !== file.sha256 ||
                expected.size !== file.size || alreadyStaged.has(file.path) ||
                markdownImportStagedFiles.has(file.stagedFileId)
              ) return Object.freeze({ kind: "file_conflict" as const });
              alreadyStaged.add(file.path);
            }
            for (const file of request.files) {
              markdownImportStagedFiles.set(
                file.stagedFileId,
                freezeMarkdownImportStagedFile(file),
              );
            }
            const stagedFileCount = current.stagedFileCount + request.files.length;
            const stagedBytes = current.stagedBytes + request.files.reduce(
              (total, file) => total + file.size,
              0,
            );
            if (stagedFileCount > plan.files.length || stagedBytes > plan.logicalBytes) {
              throw new Error("Markdown import staged totals exceed the immutable plan");
            }
            const updated = freezeMarkdownImportSession({
              ...current,
              version: version(current.version + 1),
              checkpoint: request.checkpoint,
              stagedFileCount,
              stagedBytes,
              failures: Object.freeze(request.failures.map(freezeMarkdownImportFailure)),
              updatedAt: request.stagedAt,
            });
            markdownImportSessions.set(current.importId, updated);
            markdownImportBatchHashes.set(batchKey, request.canonicalRequestHash);
            return Object.freeze({ kind: "staged" as const, session: updated, replayed: false });
          },
          transitionMarkdownImportSession: async (
            request: Parameters<
              MarkdownImportMetadataTransaction["transitionMarkdownImportSession"]
            >[0],
          ) => {
            const current = markdownImportSessions.get(request.importId);
            if (current === undefined) return Object.freeze({ kind: "not_found" as const });
            if (current.version !== request.expectedVersion) {
              return Object.freeze({ kind: "version_conflict" as const });
            }
            if (!request.from.includes(current.state)) {
              return Object.freeze({ kind: "state_conflict" as const });
            }
            const updated = freezeMarkdownImportSession({
              ...current,
              state: request.to,
              version: version(current.version + 1),
              updatedAt: request.updatedAt,
              failures: request.failures === undefined
                ? current.failures
                : Object.freeze(request.failures.map(freezeMarkdownImportFailure)),
              validationCheckpoint: request.validationCheckpoint === undefined
                ? current.validationCheckpoint
                : request.validationCheckpoint,
              validatedBytes: request.validatedBytes === undefined
                ? current.validatedBytes
                : request.validatedBytes,
              promotionCheckpoint: request.promotionCheckpoint === undefined
                ? current.promotionCheckpoint
                : request.promotionCheckpoint,
              promotedBytes: request.promotedBytes === undefined
                ? current.promotedBytes
                : request.promotedBytes,
              revisionId: request.revisionId === undefined
                ? current.revisionId
                : request.revisionId,
            });
            markdownImportSessions.set(current.importId, updated);
            return Object.freeze({ kind: "updated" as const, session: updated });
          },
          claimMarkdownImportCleanup: async (
            request: Parameters<
              MarkdownImportMetadataTransaction["claimMarkdownImportCleanup"]
            >[0],
          ) => {
            if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
              throw new TypeError("Markdown import cleanup limit is invalid");
            }
            const selected = [...markdownImportSessions.values()]
              .filter((session) =>
                session.cleanupCompletedAt === null &&
                (session.state === "committed" || session.state === "canceled" ||
                  session.state === "validation_failed" || session.state === "expired" ||
                  Date.parse(session.expiresAt) <= Date.parse(request.now)),
              )
              .sort((left, right) =>
                Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
                left.importId.localeCompare(right.importId),
              )
              .slice(0, request.limit);
            const claimed = [];
            for (const selectedSession of selected) {
              let session = selectedSession;
              if (
                session.state === "active" || session.state === "validating" ||
                session.state === "validated" || session.state === "finalizing"
              ) {
                session = freezeMarkdownImportSession({
                  ...session,
                  state: "expired",
                  version: version(session.version + 1),
                  updatedAt: request.now,
                });
                markdownImportSessions.set(session.importId, session);
                await capacityTransaction.cancelCapacityReservation({
                  reservationId: session.reservationId,
                  canceledAt: request.now,
                });
              }
              claimed.push(Object.freeze({
                session: freezeMarkdownImportSession(session),
                files: Object.freeze([...markdownImportStagedFiles.values()]
                  .filter((file) => file.importId === session.importId)
                  .sort((left, right) => compareUnicodeScalarValues(left.path, right.path))
                  .map(freezeMarkdownImportStagedFile)),
              }));
            }
            return Object.freeze(claimed);
          },
          deleteMarkdownImportStagedFile: async (stagedFileId: StagedBundleFileId) =>
            markdownImportStagedFiles.delete(stagedFileId),
          completeMarkdownImportCleanup: async (
            request: Parameters<
              MarkdownImportMetadataTransaction["completeMarkdownImportCleanup"]
            >[0],
          ) => {
            const current = markdownImportSessions.get(request.importId);
            if (
              current === undefined || current.version !== request.expectedVersion ||
              current.cleanupCompletedAt !== null ||
              (current.state !== "committed" && current.state !== "canceled" &&
                current.state !== "expired" && current.state !== "validation_failed") ||
              [...markdownImportStagedFiles.values()].some((file) =>
                file.importId === current.importId)
            ) return false;
            const reservation = capacityReservations.get(current.reservationId);
            if (reservation !== undefined && reservation.state !== "released") {
              if (reservation.state === "active") return false;
              capacityReservations.set(
                reservation.reservationId,
                cloneCapacityReservation(Object.freeze({
                  ...reservation,
                  state: "released" as const,
                  updatedAt: request.completedAt,
                })),
              );
            }
            markdownImportSessions.set(
              current.importId,
              freezeMarkdownImportSession({
                ...current,
                version: version(current.version + 1),
                updatedAt: request.completedAt,
                cleanupCompletedAt: request.completedAt,
              }),
            );
            return true;
          },
          deleteExpiredMarkdownImportPlans: async (
            request: Parameters<
              MarkdownImportMetadataTransaction["deleteExpiredMarkdownImportPlans"]
            >[0],
          ) => {
            if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
              throw new TypeError("Markdown import plan cleanup limit is invalid");
            }
            const referenced = new Set([...markdownImportSessions.values()]
              .map((session) => session.planId));
            const expired = [...markdownImportPlans.values()]
              .filter((plan) =>
                !referenced.has(plan.planId) &&
                Date.parse(plan.expiresAt) <= Date.parse(request.now))
              .sort((left, right) =>
                Date.parse(left.expiresAt) - Date.parse(right.expiresAt) ||
                left.planId.localeCompare(right.planId),
              )
              .slice(0, request.limit);
            for (const plan of expired) {
              markdownImportPlans.delete(plan.planId);
              markdownImportPlanKeys.delete(
                markdownImportKey(plan.principalId, plan.spaceId, plan.idempotencyKey),
              );
            }
            return expired.length;
          },
        });

        const result = await operation(transaction);
        this._spaces = spaces;
        this._revisionsById = revisionsById;
        this._reachabilityCounts = null;
        this._knowledgeSpaces = knowledgeSpaces;
        this._idempotencyRecords = idempotencyRecords;
        this._auditEvents = auditEvents;
        this._auditOutbox = auditOutbox;
        this._backgroundJobs = backgroundJobs;
        this._indexStates = indexStates;
        this._stagedBundleFiles = stagedBundleFiles;
        this._markdownImportPlans = markdownImportPlans;
        this._markdownImportSessions = markdownImportSessions;
        this._markdownImportStagedFiles = markdownImportStagedFiles;
        this._markdownImportPlanKeys = markdownImportPlanKeys;
        this._markdownImportSessionKeys = markdownImportSessionKeys;
        this._markdownImportBatchHashes = markdownImportBatchHashes;
        this._capacityReservations = capacityReservations;
        return result;
      });
    }

  async runExportStartTransaction<Result>(
      operation: (transaction: ExportStartTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const spaces = cloneSpaces(this._spaces);
        const revisionsById = new Map(this._revisionsById);
        const principals = this._principals;
        const knowledgeSpaces = this._knowledgeSpaces;
        const memberships = this._memberships;
        const idempotencyRecords = cloneIdempotencyRecords(this._idempotencyRecords);
        const exportJobs = cloneExportJobs(this._exportJobs);
        const capacityReservations = cloneCapacityReservations(this._capacityReservations);
        const authorizationStates = new Map(
          [...this._authorizationStates].map(([key, state]) => [
            key,
            cloneAuthorizationState(state),
          ]),
        );
        const transaction: ExportStartTransaction = Object.freeze({
          ...this._capacityTransaction(capacityReservations),
          kind: "authorization-transaction" as const,
          readCredentialWriteTarget: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => this.readCredentialWriteTarget(bindingOwnerId, principalId),
          readMindBindingSet: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
            occurredAt: ApplyReadMindBindingRequest["occurredAt"],
          ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
          readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
            const current = currentSitesAuthorizationStateFromMaps(
              query,
              principals,
              knowledgeSpaces,
              memberships,
            );
            if (current !== null) return current;
            const state = authorizationStates.get(authorizationStateKey(query));
            return state ? cloneAuthorizationState(state) : null;
          },
          readHead: async (spaceId: SpaceId) => spaces.get(spaceId)?.head ?? null,
          readRevision: async (spaceId: SpaceId, revisionId: RevisionId) =>
            spaces.get(spaceId)?.revisions.get(revisionId) ?? null,
          listRevisions: async (spaceId: SpaceId) => {
            const revisions = [...(spaces.get(spaceId)?.revisions.values() ?? [])]
              .sort((left, right) =>
                left.revision.revisionNumber - right.revision.revisionNumber,
              );
            return Object.freeze(revisions);
          },
          readExportJob: async (jobId: JobId) => {
            const job = exportJobs.get(jobId);
            return job ? cloneExportJob(job) : null;
          },
          checkIdempotency: async (request: CheckIdempotencyRequest) =>
            checkIdempotencyAgainst(request, idempotencyRecords),
          completeIdempotency: async (request: CompleteIdempotencyRequest) =>
            completeIdempotencyAgainst(request, idempotencyRecords),
          createExportJob: async (
            job: Readonly<ExportJob>,
          ): Promise<CreateExportJobResult> => {
            const existing = exportJobs.get(job.jobId);
            if (existing) {
              return Object.freeze({ kind: "job_id_collision" });
            }
            if (!validInitialExportJob(job, revisionsById)) {
              return Object.freeze({ kind: "invalid_job" });
            }
            const stored = cloneExportJob(job);
            exportJobs.set(job.jobId, stored);
            return Object.freeze({ kind: "created", job: stored });
          },
        });

        const result = await operation(transaction);
        this._idempotencyRecords = idempotencyRecords;
        this._exportJobs = exportJobs;
        this._capacityReservations = capacityReservations;
        return result;
      });
    }

  async runExportDownloadGrantTransaction<Result>(
      operation: (transaction: ExportDownloadGrantTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const exportJobs = cloneExportJobs(this._exportJobs);
        const principals = this._principals;
        const knowledgeSpaces = this._knowledgeSpaces;
        const memberships = this._memberships;
        const exportDownloadGrants = cloneExportDownloadGrants(
          this._exportDownloadGrants,
        );
        const authorizationStates = new Map(
          [...this._authorizationStates].map(([key, state]) => [
            key,
            cloneAuthorizationState(state),
          ]),
        );
        const transaction: ExportDownloadGrantTransaction = Object.freeze({
          kind: "authorization-transaction" as const,
          readCredentialWriteTarget: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => this.readCredentialWriteTarget(bindingOwnerId, principalId),
          readMindBindingSet: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
            occurredAt: ApplyReadMindBindingRequest["occurredAt"],
          ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
          readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
            const current = currentSitesAuthorizationStateFromMaps(
              query,
              principals,
              knowledgeSpaces,
              memberships,
            );
            if (current !== null) return current;
            const state = authorizationStates.get(authorizationStateKey(query));
            return state ? cloneAuthorizationState(state) : null;
          },
          readExportJob: async (jobId: JobId) => {
            const job = exportJobs.get(jobId);
            return job ? cloneExportJob(job) : null;
          },
          createExportDownloadGrant: async (
            grant: Readonly<ExportDownloadGrant>,
          ): Promise<CreateExportDownloadGrantResult> => {
            if (exportDownloadGrants.has(grant.secretVerifier)) {
              return Object.freeze({ kind: "secret_collision" });
            }
            if (!validExportDownloadGrant(grant, exportJobs.get(grant.jobId))) {
              return Object.freeze({ kind: "invalid_grant" });
            }
            const stored = cloneExportDownloadGrant(grant);
            exportDownloadGrants.set(grant.secretVerifier, stored);
            return Object.freeze({ kind: "created", grant: stored });
          },
        });

        const result = await operation(transaction);
        this._exportDownloadGrants = exportDownloadGrants;
        return result;
      });
    }

  async runBundleFileDownloadGrantTransaction<Result>(
      operation: (transaction: BundleFileDownloadGrantTransaction) => Promise<Result>,
    ): Promise<Result> {
      return this._runExclusive(async () => {
        const grants = cloneBundleFileDownloadGrants(this._bundleFileDownloadGrants);
        const principals = this._principals;
        const knowledgeSpaces = this._knowledgeSpaces;
        const memberships = this._memberships;
        const spaces = this._spaces;
        const revisionsById = this._revisionsById;
        const authorizationStates = new Map(
          [...this._authorizationStates].map(([key, state]) => [
            key,
            cloneAuthorizationState(state),
          ]),
        );
        const transaction: BundleFileDownloadGrantTransaction = Object.freeze({
          kind: "authorization-transaction" as const,
          readCredentialWriteTarget: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
          ) => this.readCredentialWriteTarget(bindingOwnerId, principalId),
          readMindBindingSet: (
            bindingOwnerId: MindBindingOwnerId,
            principalId: PrincipalId,
            occurredAt: ApplyReadMindBindingRequest["occurredAt"],
          ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
          readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
            const current = currentSitesAuthorizationStateFromMaps(
              query,
              principals,
              knowledgeSpaces,
              memberships,
            );
            if (current !== null) return current;
            const state = authorizationStates.get(authorizationStateKey(query));
            return state ? cloneAuthorizationState(state) : null;
          },
          readRevision: async (spaceId: SpaceId, revisionId: RevisionId) =>
            spaces.get(spaceId)?.revisions.get(revisionId) ?? null,
          readBundleFileDownloadGrant: async (
            secretVerifier: BundleFileDownloadGrant["secretVerifier"],
            now: BundleFileDownloadGrant["createdAt"],
          ) =>
            readBundleFileDownloadGrantAgainst(secretVerifier, now, grants),
          createBundleFileDownloadGrant: async (
            grant: Readonly<BundleFileDownloadGrant>,
          ): Promise<CreateBundleFileDownloadGrantResult> => {
            if (grants.has(grant.secretVerifier)) {
              return Object.freeze({ kind: "secret_collision" });
            }
            if (!validBundleFileDownloadGrant(grant, revisionsById.get(grant.revisionId))) {
              return Object.freeze({ kind: "invalid_grant" });
            }
            const stored = cloneBundleFileDownloadGrant(grant);
            grants.set(grant.secretVerifier, stored);
            return Object.freeze({ kind: "created", grant: stored });
          },
          consumeBundleFileDownloadGrant: async (
            secretVerifier: BundleFileDownloadGrant["secretVerifier"],
            consumedAt: BundleFileDownloadGrant["createdAt"],
          ): Promise<ConsumeBundleFileDownloadGrantResult> => {
            const current = readBundleFileDownloadGrantAgainst(
              secretVerifier,
              consumedAt,
              grants,
            );
            if (current.kind !== "active") return current;
            const consumed = Object.freeze({
              ...current.grant,
              state: "consumed" as const,
              consumedAt,
            });
            grants.set(secretVerifier, consumed);
            return Object.freeze({ kind: "consumed", grant: consumed });
          },
        });
        const result = await operation(transaction);
        this._bundleFileDownloadGrants = grants;
        return result;
      });
    }

  async readBundleFileDownloadGrant(
      secretVerifier: BundleFileDownloadGrant["secretVerifier"],
      now: BundleFileDownloadGrant["createdAt"],
    ): Promise<ConsumeBundleFileDownloadGrantResult | {
      readonly kind: "active";
      readonly grant: Readonly<BundleFileDownloadGrant>;
    }> {
      return this._runExclusive(async () =>
        readBundleFileDownloadGrantAgainst(
          secretVerifier,
          now,
          this._bundleFileDownloadGrants,
        ));
    }

  async listBundleFileDownloadGrantsForTest(): Promise<readonly Readonly<BundleFileDownloadGrant>[]> {
      return Object.freeze(
        [...this._bundleFileDownloadGrants.values()].map(cloneBundleFileDownloadGrant),
      );
    }

  /** Test/local fixture inspection; application replay goes through authorization. */
    async listIdempotencyRecordsForTest(): Promise<
      readonly CompletedIdempotencyRecord[]
    > {
      return Object.freeze(
        [...this._idempotencyRecords.values()]
          .map(cloneIdempotencyRecord)
          .sort((left, right) =>
            left.idempotencyRecordId < right.idempotencyRecordId ? -1 : 1,
          ),
      );
    }

  async listReachableObjectDigests(): Promise<readonly Digest[]> {
      return Object.freeze([...this._objectReachabilityCounts().immutable.keys()].sort());
    }

  async isImmutableObjectReachable(sha256: Digest): Promise<boolean> {
      return (this._objectReachabilityCounts().immutable.get(sha256) ?? 0) > 0;
    }

  async listReachableBundleFileObjects(): Promise<readonly Readonly<{
      spaceId: SpaceId;
      sha256: Digest;
    }>[]> {
      const reachable = [...this._objectReachabilityCounts().bundle.keys()].map((key) => {
        const [spaceId, sha256] = key.split("\u0000");
        return Object.freeze({ spaceId: spaceId as SpaceId, sha256: sha256 as Digest });
      });
      return Object.freeze(reachable.sort((left, right) =>
        left.spaceId.localeCompare(right.spaceId) || left.sha256.localeCompare(right.sha256),
      ));
    }

  async isBundleFileObjectReachable(spaceId: SpaceId, sha256: Digest): Promise<boolean> {
      return (this._objectReachabilityCounts().bundle.get(`${spaceId}\u0000${sha256}`) ?? 0) > 0;
    }

  async listReachableSpaceCanonicalObjects(): Promise<readonly Readonly<{
      kind: "markdown" | "revision_manifest";
      spaceId: SpaceId;
      sha256: Digest;
    }>[]> {
      const reachable = [...this._objectReachabilityCounts().spaceCanonical.keys()].map((key) => {
        const [kind, spaceId, sha256] = key.split("\u0000");
        return Object.freeze({
          kind: kind as "markdown" | "revision_manifest",
          spaceId: spaceId as SpaceId,
          sha256: sha256 as Digest,
        });
      });
      return Object.freeze(reachable.sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.spaceId.localeCompare(right.spaceId) ||
        left.sha256.localeCompare(right.sha256),
      ));
    }

  async isSpaceCanonicalObjectReachable(
      kind: "markdown" | "revision_manifest",
      spaceId: SpaceId,
      sha256: Digest,
    ): Promise<boolean> {
      return (this._objectReachabilityCounts().spaceCanonical.get(
        `${kind}\u0000${spaceId}\u0000${sha256}`,
      ) ?? 0) > 0;
    }
}
