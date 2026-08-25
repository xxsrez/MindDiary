import {
  revisionEnvelopesEqual,
  version,
  type AccountBootstrapRecordSet,
  type AccountBootstrapTransaction,
  type CreateAccountBootstrapResult,
  type ExternalIdentityBindingLookup,
  type PersonalMindMetadataTransaction,
  type PrincipalAccountSnapshot,
  type RenamePersonalProfileRequest,
  type RenamePersonalProfileResult,
} from "@mind-diary/application-ports";

import {
  accountByBindingFromMaps,
  accountFromMaps,
  cloneBackgroundJob,
  cloneIndexState,
  clonePersonalProfileIdempotencyRecords,
  cloneRecordMap,
  cloneSpaces,
  externalBindingKey,
  freezeExternalBinding,
  freezeKnowledgeSpace,
  freezeMembership,
  freezePersonalBinding,
  freezePersonalMindProfile,
  freezePrincipal,
  personalMindProfileFromAccount,
  personalProfileIdempotencyKey,
  stageInitialRevisionIndexAgainst,
  validateAccountBootstrapRecords,
} from "./metadata-store-internals.js";

import { RevisionMetadataOrdinaryTransactionStore } from "./revision-metadata-ordinary-transaction-store.js";

export abstract class RevisionMetadataOrdinaryStore extends RevisionMetadataOrdinaryTransactionStore {
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
