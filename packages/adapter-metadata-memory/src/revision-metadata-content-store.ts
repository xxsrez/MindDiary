import type {
  CompletedIdempotencyRecord,
  Digest,
  Envelope,
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
  PreflightProducerProof,
  RevisionCommitRequest,
  RevisionCommitResult,
  StageContentCommitEffectsRequest,
  StagedBundleFileId,
} from "@mind-diary/application-ports";
import {
  authorizationStateKey,
  bundleFileRetainedQuotaAllows,
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
import { cloneCopyOnWriteValue, copyOnWriteMap } from "./copy-on-write.js";
import { RevisionMetadataOrdinaryStore } from "./revision-metadata-ordinary-store.js";

// Pending proofs are disposable accelerators. Keep their D1 snapshot and
// event payloads bounded independently of committed revision capacity.
const MAX_PREFLIGHT_PROOF_BYTES = 1_000_000;
const MAX_PENDING_PROOF_BYTES = 8_000_000;
const MAX_PENDING_PROOFS = 128;
const PROOF_ENCODER = new TextEncoder();

function preflightProofBytes(proof: Readonly<PreflightProducerProof>): number {
  return PROOF_ENCODER.encode(JSON.stringify(proof)).byteLength;
}

export abstract class RevisionMetadataContentStore extends RevisionMetadataOrdinaryStore {
  async readPreflightProducerProof(
    spaceId: SpaceId,
  ): Promise<Readonly<PreflightProducerProof> | null> {
    const proof = this._preflightProducerProofs.get(spaceId);
    return proof === undefined ? null : structuredClone(proof);
  }

  async storePreflightProducerProof(proof: Readonly<PreflightProducerProof>): Promise<boolean> {
    return this._runExclusive(async () => {
      // A racing HEAD change or deletion cannot retain a stale proof as a
      // current Space record. The caller still performs its own HEAD CAS.
      if (this._spaces.get(proof.spaceId)?.head !== proof.baseRevisionId ||
          !this._revisionsById.has(proof.baseRevisionId)) return false;
      const bytes = preflightProofBytes(proof);
      if (bytes > MAX_PREFLIGHT_PROOF_BYTES) return false;
      this._preflightProducerProofs.delete(proof.spaceId);
      let retainedBytes = 0;
      for (const retained of this._preflightProducerProofs.values()) {
        retainedBytes += preflightProofBytes(retained);
      }
      while (this._preflightProducerProofs.size >= MAX_PENDING_PROOFS ||
          retainedBytes + bytes > MAX_PENDING_PROOF_BYTES) {
        const oldest = this._preflightProducerProofs.keys().next().value;
        if (oldest === undefined) break;
        const removed = this._preflightProducerProofs.get(oldest)!;
        retainedBytes -= preflightProofBytes(removed);
        this._preflightProducerProofs.delete(oldest);
      }
      this._preflightProducerProofs.set(proof.spaceId, structuredClone(proof));
      return true;
    });
  }

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
        const revisionsById = copyOnWriteMap(this._revisionsById, cloneCopyOnWriteValue);
        const knowledgeSpaces = cloneRecordMap(
          this._knowledgeSpaces,
          freezeKnowledgeSpace,
        );
        const principals = this._principals;
        const memberships = this._memberships;
        const idempotencyRecords = cloneIdempotencyRecords(this._idempotencyRecords);
        const auditEvents = copyOnWriteMap(this._auditEvents, cloneAuditEvent);
        const auditOutbox = copyOnWriteMap(this._auditOutbox, cloneAuditOutbox);
        const backgroundJobs = copyOnWriteMap(this._backgroundJobs, cloneBackgroundJob);
        const indexStates = copyOnWriteMap(this._indexStates, cloneIndexState);
        const stagedBundleFiles = copyOnWriteMap(this._stagedBundleFiles, cloneCopyOnWriteValue);
        const markdownImportPlans = copyOnWriteMap(this._markdownImportPlans, cloneCopyOnWriteValue);
        const queuedNotes = copyOnWriteMap(this._queuedNotes, cloneCopyOnWriteValue);
        const markdownImportSessions = copyOnWriteMap(this._markdownImportSessions, cloneCopyOnWriteValue);
        const markdownImportStagedFiles = copyOnWriteMap(this._markdownImportStagedFiles, cloneCopyOnWriteValue);
        const markdownImportPlanKeys = copyOnWriteMap(this._markdownImportPlanKeys);
        const markdownImportSessionKeys = copyOnWriteMap(this._markdownImportSessionKeys);
        const markdownImportBatchHashes = copyOnWriteMap(this._markdownImportBatchHashes);
        const capacityReservations = cloneCapacityReservations(this._capacityReservations);
        const committedCapacityRevisions: Envelope[] = [];
        const capacityTransaction = this._capacityTransaction(capacityReservations);
        const authorizationStates = copyOnWriteMap(this._authorizationStates, cloneAuthorizationState);
        const transaction: MarkdownImportMetadataTransaction = Object.freeze({
          ...capacityTransaction,
          readQueuedNote: async (receiptId: string) => queuedNotes.get(receiptId) ?? null,
          listQueuedNotes: async () => Object.freeze([...queuedNotes.values()]),
          putQueuedNote: async (note: import("@mind-diary/application-ports").QueuedNote) => { queuedNotes.set(note.receiptId, Object.freeze(structuredClone(note))); },
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
            bundleFileRetainedQuotaAllows(request, this._objectReachabilityCounts()),
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
            if (committed.kind === "committed" && existing === undefined) {
              committedCapacityRevisions.push(request.envelope);
            }
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
            for (const reservation of capacityReservations.values()) {
              if (
                reservation.state === "active" &&
                Date.parse(reservation.expiresAt) <= Date.parse(plan.createdAt)
              ) {
                capacityReservations.set(reservation.reservationId, cloneCapacityReservation(Object.freeze({
                  ...reservation,
                  state: "cleanup_pending" as const,
                  updatedAt: plan.createdAt,
                })));
              }
            }
            const usage = this._capacityUsageFromLedger(
              new Set(spaces.keys()),
              {
                stagedBundleFiles,
                exportJobs: this._exportJobs,
                markdownImportPlans,
                markdownImportSessions,
                markdownImportStagedFiles,
                reservations: capacityReservations,
              },
            );
            const reservedD1 = [...capacityReservations.values()].reduce((total, reservation) =>
              reservation.state === "active" && spaces.has(reservation.spaceId)
                ? total + reservation.requested.d1MetadataBytes
                : total,
              0,
            );
            if (usage.d1MetadataBytes + reservedD1 + 512 + plan.files.length * 160 > siteD1MetadataLimit) {
              this._capacityQuotaRejects += 1;
              return Object.freeze({
                kind: "capacity_rejected" as const,
                diagnostic: Object.freeze({
                  operation: "import" as const,
                  spaceScope: "site" as const,
                  metric: "d1_metadata_bytes" as const,
                  requested: 512 + plan.files.length * 160,
                  committed: usage.d1MetadataBytes,
                  reserved: reservedD1,
                  state: "hard_limit" as const,
                  heavy: true,
                  recovery: Object.freeze({ action: "retry_after_capacity_change" as const }),
                }),
              });
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
            if (current.version !== request.expectedVersion || current.state !== "active" ||
              !(current.activeStagingStepIds ?? []).includes(request.stagingStepId) ||
              !(current.armedStagingStepIds ?? []).includes(request.stagingStepId)) {
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
              activeStagingStepIds: Object.freeze((current.activeStagingStepIds ?? []).filter((id) =>
                id !== request.stagingStepId)),
              armedStagingStepIds: Object.freeze((current.armedStagingStepIds ?? []).filter((id) =>
                id !== request.stagingStepId)),
              failures: Object.freeze(request.failures.map(freezeMarkdownImportFailure)),
              updatedAt: request.stagedAt,
            });
            markdownImportSessions.set(current.importId, updated);
            markdownImportBatchHashes.set(batchKey, request.canonicalRequestHash);
            return Object.freeze({ kind: "staged" as const, session: updated, replayed: false });
          },
          beginMarkdownImportStagingStep: async (
            request: Parameters<MarkdownImportMetadataTransaction["beginMarkdownImportStagingStep"]>[0],
          ) => {
            const current = markdownImportSessions.get(request.importId);
            if (current === undefined) return Object.freeze({ kind: "state_conflict" as const });
            const existingHash = markdownImportBatchHashes.get(markdownImportBatchKey(
              request.importId, request.checkpoint,
            ));
            if (existingHash !== undefined) return existingHash === request.canonicalRequestHash
              ? Object.freeze({ kind: "replayed" as const, session: freezeMarkdownImportSession(current) })
              : Object.freeze({ kind: "idempotency_conflict" as const });
            if (request.checkpoint !== current.checkpoint + 1) {
              return Object.freeze({ kind: "checkpoint_conflict" as const });
            }
            if (
              current.state !== "active" ||
              current.version !== request.expectedVersion ||
              (current.activeStagingStepIds ?? []).includes(request.stepId) ||
              (current.activeStagingStepIds ?? []).length >= 128 ||
              Date.parse(current.expiresAt) <= Date.parse(request.startedAt)
            ) return Object.freeze({ kind: "state_conflict" as const });
            markdownImportSessions.set(current.importId, freezeMarkdownImportSession({
              ...current,
              activeStagingStepIds: Object.freeze([
                ...(current.activeStagingStepIds ?? []), request.stepId,
              ]),
              updatedAt: request.startedAt,
            }));
            return Object.freeze({ kind: "claimed" as const });
          },
          armMarkdownImportStagingStep: async (
            request: Parameters<MarkdownImportMetadataTransaction["armMarkdownImportStagingStep"]>[0],
          ) => {
            const current = markdownImportSessions.get(request.importId);
            if (
              current === undefined || current.state !== "active" ||
              current.version !== request.expectedVersion ||
              !(current.activeStagingStepIds ?? []).includes(request.stepId) ||
              (current.armedStagingStepIds ?? []).includes(request.stepId) ||
              Date.parse(current.expiresAt) <= Date.parse(request.armedAt)
            ) return false;
            markdownImportSessions.set(current.importId, freezeMarkdownImportSession({
              ...current,
              armedStagingStepIds: Object.freeze([
                ...(current.armedStagingStepIds ?? []), request.stepId,
              ]),
              updatedAt: request.armedAt,
            }));
            return true;
          },
          settleMarkdownImportStagingStep: async (
            request: Parameters<MarkdownImportMetadataTransaction["settleMarkdownImportStagingStep"]>[0],
          ) => {
            const current = markdownImportSessions.get(request.importId);
            if (current === undefined ||
              !(current.activeStagingStepIds ?? []).includes(request.stepId)) return false;
            const remaining = (current.activeStagingStepIds ?? []).filter((id) =>
              id !== request.stepId);
            const updated = freezeMarkdownImportSession({
              ...current,
              activeStagingStepIds: Object.freeze(remaining),
              armedStagingStepIds: Object.freeze((current.armedStagingStepIds ?? []).filter((id) =>
                id !== request.stepId)),
              updatedAt: request.settledAt,
            });
            markdownImportSessions.set(updated.importId, updated);
            if (
              remaining.length === 0 && (updated.activeStepId ?? null) === null &&
              !updated.unsettledWriterPossible &&
              (updated.state === "committed" || updated.state === "canceled" ||
                updated.state === "validation_failed" || updated.state === "expired")
            ) {
              const reservation = capacityReservations.get(updated.reservationId);
              if (reservation?.operation === "import" &&
                reservation.attemptId === updated.importId &&
                (reservation.state === "active" || reservation.state === "cleanup_pending")) {
                capacityReservations.set(reservation.reservationId,
                  cloneCapacityReservation(Object.freeze({
                    ...reservation,
                    writerClosedAt: request.settledAt,
                    updatedAt: request.settledAt,
                  })));
              }
            }
            return true;
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
            const currentStepId = current.activeStepId ?? null;
            if (currentStepId !== (request.expectedActiveStepId ?? null)) {
              return Object.freeze({ kind: "state_conflict" as const });
            }
            const nextStepId = request.activeStepId === undefined
              ? currentStepId
              : request.activeStepId;
            const unsettledStepIds = [...(current.unsettledStepIds ?? [])];
            if (
              request.unsettledWriterPossible === true && currentStepId !== null &&
              nextStepId !== currentStepId && !unsettledStepIds.includes(currentStepId)
            ) unsettledStepIds.push(currentStepId);
            if (unsettledStepIds.length > 128) {
              throw new Error("Markdown import has too many unsettled promotion steps");
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
              activeStepId: nextStepId,
              canonicalWriteExposure: (current.canonicalWriteExposure ?? false) ||
                nextStepId !== null,
              unsettledStepIds: Object.freeze(unsettledStepIds),
              unsettledWriterPossible: unsettledStepIds.length > 0 ||
                (request.unsettledWriterPossible ?? current.unsettledWriterPossible ?? false),
              revisionId: request.revisionId === undefined
                ? current.revisionId
                : request.revisionId,
            });
            markdownImportSessions.set(current.importId, updated);
            if (
              (request.to === "committed" || request.to === "canceled" ||
                request.to === "validation_failed" || request.to === "expired") &&
              (updated.activeStepId ?? null) === null &&
              !updated.unsettledWriterPossible &&
              (updated.activeStagingStepIds ?? []).length === 0
            ) {
              const reservation = capacityReservations.get(updated.reservationId);
              if (reservation?.operation === "import" &&
                reservation.attemptId === updated.importId &&
                (reservation.state === "active" || reservation.state === "cleanup_pending")) {
                capacityReservations.set(reservation.reservationId,
                  cloneCapacityReservation(Object.freeze({
                    ...reservation,
                    writerClosedAt: request.updatedAt,
                    updatedAt: request.updatedAt,
                  })));
              }
            }
            return Object.freeze({ kind: "updated" as const, session: updated });
          },
          settleMarkdownImportStep: async (
            request: Parameters<MarkdownImportMetadataTransaction["settleMarkdownImportStep"]>[0],
          ) => {
            const current = markdownImportSessions.get(request.importId);
            if (current === undefined) return null;
            const pending = current.unsettledStepIds;
            if (pending === undefined || !pending.includes(request.stepId)) {
              return freezeMarkdownImportSession(current);
            }
            const remaining = pending.filter((stepId) => stepId !== request.stepId);
            const updated = freezeMarkdownImportSession({
              ...current,
              version: version(current.version + 1),
              updatedAt: request.settledAt,
              unsettledStepIds: Object.freeze(remaining),
              unsettledWriterPossible: remaining.length > 0,
            });
            markdownImportSessions.set(updated.importId, updated);
            if (
              remaining.length === 0 && (updated.activeStepId ?? null) === null &&
              (updated.activeStagingStepIds ?? []).length === 0 &&
              (updated.state === "committed" || updated.state === "canceled" ||
                updated.state === "validation_failed" || updated.state === "expired")
            ) {
              const reservation = capacityReservations.get(updated.reservationId);
              if (reservation?.operation === "import" &&
                reservation.attemptId === updated.importId &&
                (reservation.state === "active" || reservation.state === "cleanup_pending")) {
                capacityReservations.set(reservation.reservationId,
                  cloneCapacityReservation(Object.freeze({
                    ...reservation,
                    writerClosedAt: request.settledAt,
                    updatedAt: request.settledAt,
                  })));
              }
            }
            return updated;
          },
          claimMarkdownImportCleanup: async (
            request: Parameters<
              MarkdownImportMetadataTransaction["claimMarkdownImportCleanup"]
            >[0],
          ) => {
            if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
              throw new TypeError("Markdown import cleanup limit is invalid");
            }
            for (const current of markdownImportSessions.values()) {
              const terminal = current.state === "committed" || current.state === "canceled" ||
                current.state === "validation_failed" || current.state === "expired";
              if (!terminal && Date.parse(current.expiresAt) > Date.parse(request.now)) continue;
              const armed = new Set(current.armedStagingStepIds ?? []);
              const remaining = (current.activeStagingStepIds ?? []).filter((id) => armed.has(id));
              if (remaining.length === (current.activeStagingStepIds ?? []).length) continue;
              const updated = freezeMarkdownImportSession({
                ...current,
                version: version(current.version + 1),
                updatedAt: request.now,
                activeStagingStepIds: Object.freeze(remaining),
              });
              markdownImportSessions.set(updated.importId, updated);
              if (terminal && remaining.length === 0 &&
                (updated.activeStepId ?? null) === null && !updated.unsettledWriterPossible) {
                const reservation = capacityReservations.get(updated.reservationId);
                if (reservation?.operation === "import" &&
                  reservation.attemptId === updated.importId &&
                  (reservation.state === "active" || reservation.state === "cleanup_pending")) {
                  capacityReservations.set(reservation.reservationId,
                    cloneCapacityReservation(Object.freeze({
                      ...reservation,
                      writerClosedAt: request.now,
                      updatedAt: request.now,
                    })));
                }
              }
            }
            const selected = [...markdownImportSessions.values()]
              .filter((session) =>
                (session.activeStepId ?? null) === null &&
                (session.activeStagingStepIds ?? []).length === 0 &&
                !session.unsettledWriterPossible &&
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
                const reservation = capacityReservations.get(session.reservationId);
                if (reservation?.operation === "import" &&
                  reservation.attemptId === session.importId &&
                  reservation.state === "cleanup_pending" &&
                  !session.unsettledWriterPossible) {
                  capacityReservations.set(reservation.reservationId,
                    cloneCapacityReservation(Object.freeze({
                      ...reservation,
                      writerClosedAt: request.now,
                      updatedAt: request.now,
                    })));
                }
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
            if (current.unsettledWriterPossible ||
              (current.activeStagingStepIds ?? []).length > 0) return false;
            if (reservation !== undefined && reservation.state !== "released") {
              if (reservation.state === "active") return false;
              const committedRevision = current.state === "committed" &&
                current.revisionId !== null
                ? revisionsById.get(current.revisionId)
                : undefined;
              const fullyPublished = !current.unsettledWriterPossible &&
                committedRevision?.revision.spaceId === current.spaceId;
              if (reservation.operation === "import" &&
                reservation.attemptId === current.importId &&
                current.activeStagingStepIds !== undefined &&
                current.armedStagingStepIds !== undefined &&
                (fullyPublished ||
                  (reservation.writerClosedAt !== undefined &&
                    reservation.writerClosedAt !== null &&
                    !current.unsettledWriterPossible &&
                    current.promotionCheckpoint === 0 &&
                    !current.canonicalWriteExposure))) {
                capacityReservations.set(
                  reservation.reservationId,
                  cloneCapacityReservation(Object.freeze({
                    ...reservation,
                    state: "released" as const,
                    updatedAt: request.completedAt,
                  })),
                );
              }
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
        for (const envelope of committedCapacityRevisions) {
          this._recordCommittedRevisionCapacity(envelope);
        }
        this._spaces = spaces;
        this._revisionsById = revisionsById;
        this._knowledgeSpaces = knowledgeSpaces;
        this._idempotencyRecords = idempotencyRecords;
        this._auditEvents = auditEvents;
        this._auditOutbox = auditOutbox;
        this._backgroundJobs = backgroundJobs;
        this._indexStates = indexStates;
        this._stagedBundleFiles = stagedBundleFiles;
        this._markdownImportPlans = markdownImportPlans;
        this._queuedNotes = queuedNotes;
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
        const revisionsById = copyOnWriteMap(this._revisionsById, cloneCopyOnWriteValue);
        const principals = this._principals;
        const knowledgeSpaces = this._knowledgeSpaces;
        const memberships = this._memberships;
        const idempotencyRecords = cloneIdempotencyRecords(this._idempotencyRecords);
        const exportJobs = cloneExportJobs(this._exportJobs);
        const capacityReservations = cloneCapacityReservations(this._capacityReservations);
        const authorizationStates = copyOnWriteMap(this._authorizationStates, cloneAuthorizationState);
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
          resolveRevisionAsOf: (spaceId: SpaceId, asOf: import("@mind-diary/application-ports").UtcInstant) =>
            this.resolveRevisionAsOf(spaceId, asOf),
          findActiveOrRecoverableExportJob: async (
            request: Parameters<
              ExportStartTransaction["findActiveOrRecoverableExportJob"]
            >[0],
          ) => {
            const now = Date.parse(request.now);
            const candidates = [...exportJobs.values()]
              .filter((job) =>
                job.requestedByPrincipalId === request.requestedByPrincipalId &&
                job.spaceId === request.spaceId &&
                job.revisionId === request.revisionId &&
                (job.profile ?? "MD-OKF-ZIP-1") === request.profile &&
                Date.parse(job.expiresAt) > now &&
                (
                  job.state === "running" ||
                  ((job.state === "queued" || job.state === "failed") &&
                    Date.parse(job.availableAt) <= now)
                )
              )
              .sort((left, right) =>
                Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
                compareUnicodeScalarValues(String(right.jobId), String(left.jobId)),
              );
            return candidates[0] === undefined ? null : cloneExportJob(candidates[0]);
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
        const authorizationStates = copyOnWriteMap(this._authorizationStates, cloneAuthorizationState);
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
        const authorizationStates = copyOnWriteMap(this._authorizationStates, cloneAuthorizationState);
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
      for (const note of this._queuedNotes.values()) {
        if (!reachable.some((item) => item.kind === "markdown" && item.spaceId === note.spaceId && item.sha256 === note.payloadHash)) {
          reachable.push(Object.freeze({ kind: "markdown", spaceId: note.spaceId, sha256: note.payloadHash }));
        }
      }
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
      if (kind === "markdown" && [...this._queuedNotes.values()].some((note) =>
        note.spaceId === spaceId && note.payloadHash === sha256)) return true;
      return (this._objectReachabilityCounts().spaceCanonical.get(
        `${kind}\u0000${spaceId}\u0000${sha256}`,
      ) ?? 0) > 0;
    }

  /** One metadata snapshot checks both references and writers before physical GC. */
  async canPhysicallyDeleteCanonicalObject(request: Readonly<{
    namespace: "immutable" | "bundle_file" | "space_canonical";
    spaceId?: SpaceId;
    kind?: "markdown" | "revision_manifest";
    sha256: Digest;
  }>): Promise<boolean> {
    // Legacy global objects have no durable write reservation. Keep their
    // physical bytes until a separately fenced legacy cleanup is available.
    if (request.namespace === "immutable") return false;
    if (request.spaceId === undefined) return false;
    for (const reservation of this._capacityReservations.values()) {
      if (reservation.spaceId !== request.spaceId ||
        (reservation.state !== "active" && reservation.state !== "cleanup_pending") ||
        (reservation.state === "cleanup_pending" && reservation.writerClosedAt)) continue;
      if (reservation.operation === "commit") return false;
      if (reservation.operation !== "import") continue;
      // Import writes only plan Markdown and one manifest. A lost promotion
      // step must not stop GC of unrelated BundleFiles or Markdown.
      if (request.namespace === "bundle_file") continue;
      if (request.kind === "revision_manifest") return false;
      const session = [...this._markdownImportSessions.values()].find((item) =>
        item.reservationId === reservation.reservationId);
      const plan = session === undefined ? undefined : this._markdownImportPlans.get(session.planId);
      if (plan === undefined || plan.files.some((file) => file.sha256 === request.sha256)) {
        return false;
      }
    }
    const reachability = this._objectReachabilityCounts();
    if (request.namespace === "bundle_file") {
      return (reachability.bundle.get(`${request.spaceId}\u0000${request.sha256}`) ?? 0) === 0;
    }
    if (request.kind === undefined) return false;
    if (request.kind === "markdown" && [...this._queuedNotes.values()].some((note) =>
      note.spaceId === request.spaceId && note.payloadHash === request.sha256)) return false;
    return (reachability.spaceCanonical.get(
      `${request.kind}\u0000${request.spaceId}\u0000${request.sha256}`,
    ) ?? 0) === 0;
  }
}
