import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  Clock,
  CommitEffectIdGenerator,
  ContentCommitMetadataStore,
  ContentCommitMetadataTransaction,
  IdempotencyNamespace,
  ObjectStore,
  RevisionIdGenerator,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  opaqueId,
  serializeRevisionManifest,
  version,
  type BindingVersion,
  type CanonicalRevisionEnvelope,
  type IdempotencyKey,
  type RevisionId,
  type Sha256Digest,
  type SpaceId,
  type WriteMindBindingId,
} from "@mind-diary/domain";
import {
  ChangesetPreflightService,
  DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
  validateChangesetOperations,
  type ChangesetOperation,
  type ChangesetPreflightLimits,
  type ChangesetPreflightResult,
  type ChangesetValidationCode,
} from "./changeset-preflight.js";
import {
  DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
  normalizeIdempotencyKeyMaxBytes,
  validateIdempotencyKey,
} from "./idempotency.js";
import type { HeadRevisionReader } from "./index.js";

export interface CommitChangesetRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId?: unknown;
  readonly expectedRevisionId: RevisionId | null;
  readonly idempotencyKey: unknown;
  readonly summary: string;
  /** Trusted application-only context; never projected from commit_changeset input. */
  readonly automaticCapture?: Readonly<AutomaticCaptureCommitContext>;
  /** Untrusted adapter input is validated by changeset preflight. */
  readonly operations: unknown;
}

export interface AutomaticCaptureCommitContext {
  readonly expectedBindingVersion: BindingVersion;
  readonly captureKey: string;
  readonly path: string;
  readonly sourceRefs: readonly Readonly<
    | { readonly kind: "user_statement" }
    | {
        readonly kind: "target_entry";
        readonly revisionId: RevisionId;
        readonly path: string;
      }
  >[];
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
  | { readonly kind: "idempotency_conflict" }
  | NonReadyPreflightResult;

export type ChangesetCommitFailureCode =
  | "invalid_actor"
  | "invalid_idempotency_result"
  | "invalid_idempotency_state"
  | "missing_parent"
  | "revision_id_collision"
  | "invalid_revision_chain"
  | "invalid_commit_effects";

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
  readonly effectIds?: CommitEffectIdGenerator;
  readonly preflightLimits?: Readonly<ChangesetPreflightLimits>;
  readonly idempotencyKeyMaxBytes?: number;
}

interface ValidatedCommitPayload {
  readonly idempotencyKey: IdempotencyKey;
  readonly writeBindingId: WriteMindBindingId | null;
  readonly operations: readonly Readonly<ChangesetOperation>[];
  readonly automaticCapture: Readonly<AutomaticCaptureCommitContext> | null;
}

type InvalidResult = Extract<
  ChangesetPreflightResult,
  { readonly kind: "invalid" }
>;

const ENCODER = new TextEncoder();

function invalid(code: ChangesetValidationCode, message: string): InvalidResult {
  return Object.freeze({
    kind: "invalid",
    error: Object.freeze({ code, message }),
  });
}

function canonicalOperation(operation: Readonly<ChangesetOperation>): object {
  switch (operation.type) {
    case "create_file":
      return { type: operation.type, path: operation.path, text: operation.text };
    case "replace_file":
    case "replace_index":
      return {
        type: operation.type,
        path: operation.path,
        text: operation.text,
        ...(operation.expected_sha256 === undefined
          ? {}
          : { expected_sha256: operation.expected_sha256 }),
      };
    case "delete_file":
      return {
        type: operation.type,
        path: operation.path,
        ...(operation.expected_sha256 === undefined
          ? {}
          : { expected_sha256: operation.expected_sha256 }),
      };
    case "add_log_entry":
      return {
        type: operation.type,
        path: operation.path,
        category: operation.category,
        message: operation.message,
      };
  }
}

function canonicalRequestSource(
  request: CommitChangesetRequest,
  validated: ValidatedCommitPayload,
): string {
  return `${JSON.stringify({
    format: "mind-diary-commit-changeset-request-v1",
    write_binding_id: validated.writeBindingId,
    expected_revision_id: request.expectedRevisionId,
    summary: request.summary,
    operations: validated.operations.map(canonicalOperation),
    automatic_capture: validated.automaticCapture,
  })}\n`;
}

function writeBindingRequirement(
  writeBindingId: unknown,
  automaticCapture: Readonly<AutomaticCaptureCommitContext> | undefined | null,
) {
  if (typeof writeBindingId !== "string" || writeBindingId.length === 0) {
    return Object.freeze({});
  }
  return Object.freeze({
    bindingRequirement: automaticCapture === undefined || automaticCapture === null
      ? Object.freeze({
          kind: "write" as const,
          writeBindingId: writeBindingId as WriteMindBindingId,
        })
      : Object.freeze({
          kind: "automatic_capture" as const,
          writeBindingId: writeBindingId as WriteMindBindingId,
          expectedBindingVersion: automaticCapture.expectedBindingVersion,
        }),
  });
}

/** Application-level immediate commit_changeset use case. */
export class ChangesetCommitService {
  readonly #authorizer: Authorizer;
  readonly #metadata: ContentCommitMetadataStore;
  readonly #objects: ObjectStore;
  readonly #revisionIds: RevisionIdGenerator;
  readonly #effectIds: CommitEffectIdGenerator | null;
  readonly #preflight: ChangesetPreflightService;
  readonly #preflightLimits: Readonly<ChangesetPreflightLimits>;
  readonly #idempotencyKeyMaxBytes: number;

  constructor(dependencies: ChangesetCommitDependencies) {
    this.#authorizer = dependencies.authorizer;
    this.#metadata = dependencies.metadata;
    this.#objects = dependencies.objects;
    this.#revisionIds = dependencies.revisionIds;
    this.#effectIds = dependencies.effectIds ?? null;
    this.#preflightLimits =
      dependencies.preflightLimits ?? DEFAULT_CHANGESET_PREFLIGHT_LIMITS;
    this.#idempotencyKeyMaxBytes = normalizeIdempotencyKeyMaxBytes(
      dependencies.idempotencyKeyMaxBytes ?? DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
    );
    this.#preflight = new ChangesetPreflightService({
      authorizer: dependencies.authorizer,
      revisions: dependencies.revisions,
      clock: dependencies.clock,
      limits: this.#preflightLimits,
    });
  }

  async commit(request: CommitChangesetRequest): Promise<CommitChangesetResult> {
    const initialAuthorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
      ...writeBindingRequirement(request.writeBindingId, request.automaticCapture),
    });
    if (initialAuthorization.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initialAuthorization });
    }
    if (request.actor.kind !== "registered_principal") {
      throw new ChangesetCommitFailure(
        "invalid_actor",
        "an authorized content changeset must belong to a registered principal",
      );
    }
    const actor = request.actor;

    const validated = this.#validatePayload(request);
    if ("kind" in validated) return validated;
    const canonicalRequestHash = await this.#objects.calculateSha256(
      ENCODER.encode(canonicalRequestSource(request, validated)),
    );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "commit_changeset" }
    > = Object.freeze({
      principalId: actor.principalId,
      spaceId: request.spaceId,
      operation: "commit_changeset",
      key: validated.idempotencyKey,
    });

    const early = await this.#metadata.runContentCommitTransaction(
      async (transaction) => {
        const authorization = await this.#authorizer.reauthorizeInTransaction(
          {
            actor,
            spaceId: request.spaceId,
            capability: "content:write",
            revisionMode: "head",
            ...writeBindingRequirement(
              validated.writeBindingId,
              validated.automaticCapture,
            ),
          },
          transaction,
          initialAuthorization.stamp,
        );
        if (authorization.kind === "denied") {
          return Object.freeze({ kind: "denied", decision: authorization });
        }
        return this.#resolveIdempotency(
          transaction,
          namespace,
          canonicalRequestHash,
        );
      },
    );
    if (early.kind !== "missing") return early;

    const preflight = await this.#preflight.preflight({
      actor,
      spaceId: request.spaceId,
      revisionMode: "head",
      expectedRevisionId: request.expectedRevisionId,
      ...(validated.writeBindingId === null
        ? {}
        : {
            writeBindingId: validated.writeBindingId,
            ...(validated.automaticCapture === null
              ? {}
              : {
                  automaticCaptureExpectedBindingVersion:
                    validated.automaticCapture.expectedBindingVersion,
                }),
          }),
      operations: validated.operations,
    });
    if (preflight.kind !== "ready") return preflight;

    const committedAt = preflight.committedAt;
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
          ...writeBindingRequirement(
            validated.writeBindingId,
            validated.automaticCapture,
          ),
        },
        transaction,
        preflight.authorization.stamp,
      );
      if (authorization.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: authorization });
      }

      const idempotency = await this.#resolveIdempotency(
        transaction,
        namespace,
        canonicalRequestHash,
      );
      if (idempotency.kind !== "missing") return idempotency;

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
        if (committed.replayed) {
          throw new ChangesetCommitFailure(
            "invalid_idempotency_state",
            "revision-ID replay cannot substitute for namespaced idempotency",
          );
        }
        const completion = await transaction.completeIdempotency({
          namespace,
          canonicalRequestHash,
          result: Object.freeze({
            kind: "commit_changeset",
            previousRevisionId: preflight.baseRevisionId,
            revisionId: committed.envelope.revision.revisionId,
          }),
          completedAt: committedAt,
        });
        if (completion.kind !== "completed") {
          throw new ChangesetCommitFailure(
            "invalid_idempotency_state",
            "idempotency namespace changed inside the content transaction",
          );
        }
        const committedRevisionId = committed.envelope.revision.revisionId;
        const auditEventId = this.#effectIds?.nextAuditEventId() ??
          opaqueId<"audit-event">(`audit_${committedRevisionId}`);
        const outboxMessageId = this.#effectIds?.nextOutboxMessageId() ??
          opaqueId<"outbox-message">(`audit_outbox_${committedRevisionId}`);
        const indexJobId = this.#effectIds?.nextIndexJobId() ??
          opaqueId<"job">(`index_job_${committedRevisionId}`);
        const effects = await transaction.stageContentCommitEffects({
          auditEvent: Object.freeze({
            auditEventId,
            actor: Object.freeze({
              kind: "principal" as const,
              principalId: actor.principalId,
            }),
            requestId: actor.requestId,
            eventType: "content.changeset_committed",
            outcome: "succeeded",
            spaceId: request.spaceId,
            occurredAt: committedAt,
            safeMetadata: Object.freeze({
              revision_id: committedRevisionId,
              previous_revision_id: preflight.baseRevisionId,
              revision_number: committed.envelope.revision.revisionNumber,
              manifest_hash: committed.envelope.revision.manifestHash,
              ...(validated.automaticCapture === null
                ? {}
                : {
                    capture_mode: "routine_non_sensitive",
                    capture_key: validated.automaticCapture.captureKey,
                    capture_path: validated.automaticCapture.path,
                    capture_source_refs: JSON.stringify(
                      validated.automaticCapture.sourceRefs,
                    ),
                  }),
            }),
          }),
          auditOutbox: Object.freeze({
            outboxMessageId,
            auditEventId,
            state: "pending",
            version: version(1),
            attempts: 0,
            availableAt: committedAt,
            claimExpiresAt: null,
            createdAt: committedAt,
            updatedAt: committedAt,
          }),
          indexJob: Object.freeze({
            jobId: indexJobId,
            target: Object.freeze({
              kind: "revision_index" as const,
              spaceId: request.spaceId,
              revisionId: committedRevisionId,
            }),
            state: "queued",
            version: version(1),
            attempts: 0,
            availableAt: committedAt,
            claimExpiresAt: null,
            createdAt: committedAt,
            updatedAt: committedAt,
          }),
          indexState: Object.freeze({
            spaceId: request.spaceId,
            revisionId: committedRevisionId,
            status: "queued",
            attempts: 0,
            queuedAt: committedAt,
            updatedAt: committedAt,
            readyAt: null,
            lastFailureCode: null,
          }),
        });
        if (effects.kind !== "staged") {
          throw new ChangesetCommitFailure(
            "invalid_commit_effects",
            `commit effects were not staged atomically: ${effects.kind}`,
          );
        }
        return Object.freeze({
          kind: "committed",
          previousRevisionId: preflight.baseRevisionId,
          envelope: committed.envelope,
          replayed: false,
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

  #validatePayload(
    request: CommitChangesetRequest,
  ): ValidatedCommitPayload | InvalidResult {
    if (
      request.expectedRevisionId !== null &&
      (typeof request.expectedRevisionId !== "string" ||
        request.expectedRevisionId.length === 0)
    ) {
      return invalid(
        "invalid_expected_revision",
        "expected revision must be a non-empty opaque ID or null",
      );
    }
    if (typeof request.summary !== "string") {
      return invalid("invalid_summary", "changeset summary must be a string");
    }
    const checkedKey = validateIdempotencyKey(
      request.idempotencyKey,
      this.#idempotencyKeyMaxBytes,
    );
    if (checkedKey.kind === "invalid") {
      const message =
        checkedKey.reason === "byte_limit_exceeded"
          ? "idempotency key exceeds its UTF-8 byte limit"
          : checkedKey.reason === "single_line_required"
            ? "idempotency key must not contain control or line-separator characters"
            : checkedKey.reason === "invalid_utf8"
              ? "idempotency key must be canonical UTF-8"
              : "idempotency key must be a non-empty string";
      return invalid(
        "invalid_idempotency_key",
        message,
      );
    }
    const operations = validateChangesetOperations(
      request.operations,
      this.#preflightLimits,
    );
    if (operations.kind === "invalid") return operations;
    if (
      request.writeBindingId !== undefined &&
      (typeof request.writeBindingId !== "string" ||
        request.writeBindingId.length === 0)
    ) {
      return invalid(
        "invalid_write_binding_id",
        "write binding ID must be a non-empty opaque ID",
      );
    }
    return Object.freeze({
      idempotencyKey: checkedKey.key,
      writeBindingId:
        request.writeBindingId === undefined
          ? null
          : (request.writeBindingId as WriteMindBindingId),
      operations: operations.operations,
      automaticCapture: request.automaticCapture ?? null,
    });
  }

  async #resolveIdempotency(
    transaction: ContentCommitMetadataTransaction,
    namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "commit_changeset" }
    >,
    canonicalRequestHash: Sha256Digest,
  ): Promise<
    | { readonly kind: "missing" }
    | { readonly kind: "idempotency_conflict" }
    | Extract<CommitChangesetResult, { readonly kind: "committed" }>
  > {
    const checked = await transaction.checkIdempotency({
      namespace,
      canonicalRequestHash,
    });
    if (checked.kind === "missing") return checked;
    if (checked.kind === "conflict") {
      return Object.freeze({ kind: "idempotency_conflict" });
    }
    if (
      checked.record.operation !== "commit_changeset" ||
      checked.record.result.kind !== "commit_changeset"
    ) {
      throw new ChangesetCommitFailure(
        "invalid_idempotency_result",
        "commit_changeset namespace resolved to a different typed result",
      );
    }
    const envelope = await transaction.readRevision(
      namespace.spaceId,
      checked.record.result.revisionId,
    );
    if (envelope === null) {
      throw new ChangesetCommitFailure(
        "invalid_idempotency_result",
        "completed idempotency result does not resolve to its immutable revision",
      );
    }
    return Object.freeze({
      kind: "committed",
      previousRevisionId: checked.record.result.previousRevisionId,
      envelope,
      replayed: true,
    });
  }
}
