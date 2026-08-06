import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  Clock,
  ContentCommitMetadataStore,
  ObjectStore,
  RevisionIdGenerator,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  type CanonicalRevisionEnvelope,
  type RevisionId,
  type SpaceId,
} from "@mind-diary/domain";
import {
  ChangesetPreflightService,
  type ChangesetPreflightLimits,
  type ChangesetPreflightResult,
} from "./changeset-preflight.js";
import type { HeadRevisionReader } from "./index.js";

export interface CommitChangesetRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId | null;
  readonly summary: string;
  /** Untrusted adapter input is validated by changeset preflight. */
  readonly operations: unknown;
}

type NonReadyPreflightResult = Exclude<
  ChangesetPreflightResult,
  { readonly kind: "ready" }
>;

export type CommitChangesetResult =
  | {
      readonly kind: "committed";
      readonly previousRevisionId: RevisionId | null;
      readonly envelope: Readonly<CanonicalRevisionEnvelope>;
      readonly replayed: boolean;
    }
  | NonReadyPreflightResult;

export type ChangesetCommitFailureCode =
  | "invalid_actor"
  | "missing_parent"
  | "revision_id_collision"
  | "invalid_revision_chain";

export class ChangesetCommitFailure extends Error {
  readonly code: ChangesetCommitFailureCode;

  constructor(code: ChangesetCommitFailureCode, message: string) {
    super(message);
    this.name = "ChangesetCommitFailure";
    this.code = code;
  }
}

export interface ChangesetCommitDependencies {
  readonly authorizer: Authorizer;
  readonly metadata: ContentCommitMetadataStore;
  readonly revisions: HeadRevisionReader;
  readonly objects: ObjectStore;
  readonly clock: Clock;
  readonly revisionIds: RevisionIdGenerator;
  readonly preflightLimits?: Readonly<ChangesetPreflightLimits>;
}

const ENCODER = new TextEncoder();

/** Application-level immediate commit_changeset use case. */
export class ChangesetCommitService {
  readonly #authorizer: Authorizer;
  readonly #metadata: ContentCommitMetadataStore;
  readonly #objects: ObjectStore;
  readonly #clock: Clock;
  readonly #revisionIds: RevisionIdGenerator;
  readonly #preflight: ChangesetPreflightService;

  constructor(dependencies: ChangesetCommitDependencies) {
    this.#authorizer = dependencies.authorizer;
    this.#metadata = dependencies.metadata;
    this.#objects = dependencies.objects;
    this.#clock = dependencies.clock;
    this.#revisionIds = dependencies.revisionIds;
    this.#preflight = new ChangesetPreflightService({
      authorizer: dependencies.authorizer,
      revisions: dependencies.revisions,
      ...(dependencies.preflightLimits === undefined
        ? {}
        : { limits: dependencies.preflightLimits }),
    });
  }

  async commit(request: CommitChangesetRequest): Promise<CommitChangesetResult> {
    const preflight = await this.#preflight.preflight({
      actor: request.actor,
      spaceId: request.spaceId,
      revisionMode: "head",
      expectedRevisionId: request.expectedRevisionId,
      operations: request.operations,
    });
    if (preflight.kind !== "ready") return preflight;
    if (request.actor.kind !== "registered_principal") {
      throw new ChangesetCommitFailure(
        "invalid_actor",
        "a ready content changeset must belong to a registered principal",
      );
    }
    const actor = request.actor;

    const committedAt = this.#clock.now();
    const revisionId = this.#revisionIds.nextRevisionId();
    const entries = [];
    for (const file of preflight.candidateFiles) {
      const put = await this.#objects.putImmutable({
        bytes: ENCODER.encode(file.text),
        mediaType: MARKDOWN_MEDIA_TYPE,
        createdAt: committedAt,
      });
      entries.push({
        path: file.path,
        sha256: put.object.sha256,
        mediaType: put.object.mediaType,
        size: put.object.size,
      });
    }
    const manifest = createRevisionManifest(entries);
    const manifestHash = await this.#objects.calculateSha256(
      ENCODER.encode(serializeRevisionManifest(manifest)),
    );

    return this.#metadata.runContentCommitTransaction(async (transaction) => {
      const authorization = await this.#authorizer.reauthorizeInTransaction(
        {
          actor,
          spaceId: request.spaceId,
          capability: "content:write",
          revisionMode: "head",
        },
        transaction,
        preflight.authorization.stamp,
      );
      if (authorization.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: authorization });
      }

      const currentHeadRevisionId = await transaction.readHead(request.spaceId);
      if (currentHeadRevisionId !== preflight.baseRevisionId) {
        return Object.freeze({
          kind: "revision_conflict",
          currentRevisionId: currentHeadRevisionId,
        });
      }

      let revisionNumber = 1;
      if (preflight.baseRevisionId !== null) {
        const parent = await transaction.readRevision(
          request.spaceId,
          preflight.baseRevisionId,
        );
        if (parent === null) {
          throw new ChangesetCommitFailure(
            "missing_parent",
            "current HEAD does not resolve to an immutable parent revision",
          );
        }
        revisionNumber = parent.revision.revisionNumber + 1;
      }

      const envelope = createCanonicalRevisionEnvelope({
        revisionId,
        spaceId: request.spaceId,
        revisionNumber,
        parentRevisionId: preflight.baseRevisionId,
        committedAt,
        committedBy: {
          kind: "principal",
          principalId: actor.principalId,
        },
        manifest,
        manifestHash,
        summary: request.summary,
      });
      const committed = await transaction.commitRevision({
        expectedHeadRevisionId: preflight.baseRevisionId,
        envelope,
      });
      if (committed.kind === "committed") {
        return Object.freeze({
          kind: "committed",
          previousRevisionId: preflight.baseRevisionId,
          envelope: committed.envelope,
          replayed: committed.replayed,
        });
      }
      if (committed.kind === "stale_head") {
        return Object.freeze({
          kind: "revision_conflict",
          currentRevisionId: committed.currentHeadRevisionId,
        });
      }
      if (committed.kind === "revision_id_collision") {
        throw new ChangesetCommitFailure(
          "revision_id_collision",
          "generated revision ID is already bound to different metadata",
        );
      }
      throw new ChangesetCommitFailure(
        "invalid_revision_chain",
        `metadata rejected the changeset revision: ${committed.reason}`,
      );
    });
  }
}
