import type { ActorContext } from "@mind-diary/application-contracts";
import type { BundleFileObjectStore, OrdinaryMindIdGenerator, OrdinaryMindSnapshot, OrdinaryMindStore, VerifiedSpaceHost } from "@mind-diary/application-ports";
import { createCanonicalRevisionEnvelope, isReservedTopLevelHandle, isReservedTopLevelRoute, normalizeOrdinaryMindDescription, parseCanonicalSpaceHandle, version } from "@mind-diary/domain";
import type { PrincipalId, SpaceId, UtcInstant } from "@mind-diary/domain";
import { personalProfileIdempotencyKey, PersonalMindControlFailure, registeredSitesPrincipal, PERSONAL_PROFILE_ENCODER } from "./personal-mind-control.js";
import { parseUtcInstant } from "./token-lifecycle.js";
import { safeBootstrapRequestId, normalizedDisplayName, initialRevisionIndexEffects } from "./account-bootstrap.js";
import { createInitialOrdinaryMindFiles } from "./initial-mind-files.js";
import { stageInitialMindRevision } from "./initial-mind-revision.js";

export type OrdinaryMindControlFailureCode =
  | "authentication_required"
  | "invalid_display_name"
  | "invalid_description"
  | "description_required_for_write"
  | "invalid_request"
  | "invalid_handle"
  | "invalid_visibility"
  | "invalid_exposure_acknowledgement"
  | "invalid_metadata_version"
  | "invalid_idempotency_key"
  | "handle_unavailable"
  | "mind_not_found"
  | "personal_mind_operation_forbidden"
  | "forbidden"
  | "exposure_acknowledgement_required"
  | "metadata_conflict"
  | "idempotency_conflict"
  | "visibility_effect_conflict"
  | "invalid_deletion_impact_id"
  | "invalid_confirmation"
  | "deletion_impact_expired"
  | "deletion_impact_changed"
  | "deletion_cleanup_incomplete"
  | "ordinary_mind_conflict"
  | "ordinary_mind_unavailable";

/** Safe failure without private profile, hidden handle, content, or authority claims. */
export class OrdinaryMindControlFailure extends Error {
  readonly code: OrdinaryMindControlFailureCode;

  constructor(code: OrdinaryMindControlFailureCode, message: string) {
    super(message);
    this.name = "OrdinaryMindControlFailure";
    this.code = code;
  }
}

export interface CreateOrdinaryMindCommand {
  readonly name: string;
  readonly handle: string;
  readonly description?: string | null;
  readonly idempotencyKey: string;
}

export interface RenameOrdinaryMindCommand {
  readonly mindId: SpaceId;
  readonly name?: string;
  readonly description?: string | null;
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface OrdinaryMindControlDescriptor {
  readonly mindId: SpaceId;
  readonly route: `/${string}`;
  readonly handle: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: "private" | "unlisted" | "public";
  readonly metadataVersion: number;
  readonly accessVersion: number;
  readonly headRevisionId: OrdinaryMindSnapshot["space"]["headRevisionId"];
}

export interface OrdinaryMindMutationResult extends OrdinaryMindControlDescriptor {
  readonly replayed: boolean;
}

export interface OrdinaryMindControlSafeEvent {
  readonly event:
    | "ordinary_mind_created"
    | "ordinary_mind_create_replayed"
    | "ordinary_mind_renamed"
    | "ordinary_mind_rename_replayed"
    | "ordinary_mind_deletion_previewed"
    | "ordinary_mind_deleted"
    | "ordinary_mind_delete_replayed"
    | "ordinary_mind_delete_cleanup_incomplete"
    | "ordinary_mind_conflict"
    | "ordinary_mind_denied"
    | "ordinary_mind_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface OrdinaryMindControlSafeLogger {
  record(event: Readonly<OrdinaryMindControlSafeEvent>): void | Promise<void>;
}

export interface OrdinaryMindControlDependencies {
  readonly ordinaryMinds: OrdinaryMindStore;
  readonly objects: BundleFileObjectStore;
  readonly ids: OrdinaryMindIdGenerator;
  readonly host: VerifiedSpaceHost;
  readonly logger?: OrdinaryMindControlSafeLogger;
}

export function ordinaryMindIdempotencyKey(value: unknown) {
  try {
    return personalProfileIdempotencyKey(value);
  } catch (error) {
    if (
      error instanceof PersonalMindControlFailure &&
      error.code === "invalid_idempotency_key"
    ) {
      throw new OrdinaryMindControlFailure(
        "invalid_idempotency_key",
        "A valid idempotency key is required.",
      );
    }
    throw error;
  }
}

export function ordinaryMindMetadataVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new OrdinaryMindControlFailure(
      "invalid_metadata_version",
      "A valid expected metadata version is required.",
    );
  }
}

export function ordinaryMindActor(actor: ActorContext): Readonly<{
  principalId: PrincipalId;
  occurredAtUtc: UtcInstant;
}> | null {
  const principalId = registeredSitesPrincipal(actor);
  if (principalId === null || parseUtcInstant(actor.occurredAtUtc) === null) {
    return null;
  }
  return Object.freeze({ principalId, occurredAtUtc: actor.occurredAtUtc });
}

export function ordinaryMindDescriptor(
  mind: Readonly<OrdinaryMindSnapshot>,
): Readonly<OrdinaryMindControlDescriptor> {
  const space = mind.space;
  return Object.freeze({
    mindId: space.spaceId,
    route: `/${space.spaceHandle}`,
    handle: space.spaceHandle,
    name: space.name,
    description: space.description ?? null,
    visibility: space.visibility,
    metadataVersion: space.metadataVersion,
    accessVersion: space.accessVersion,
    headRevisionId: space.headRevisionId,
  });
}

export function recordOrdinaryMindEvent(
  logger: OrdinaryMindControlSafeLogger | undefined,
  event: OrdinaryMindControlSafeEvent["event"],
  requestId: ActorContext["requestId"],
): void {
  if (!logger) return;
  try {
    const pending = logger.record(Object.freeze({ event, requestId }));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Safe observability remains outside the metadata transaction.
  }
}

/** Ordinary Mind create/rename use cases for the trusted Sites control plane. */
export class OrdinaryMindControlService {
  readonly #ordinaryMinds: OrdinaryMindStore;
  readonly #objects: BundleFileObjectStore;
  readonly #ids: OrdinaryMindIdGenerator;
  readonly #host: VerifiedSpaceHost;
  readonly #logger: OrdinaryMindControlSafeLogger | undefined;

  constructor(dependencies: OrdinaryMindControlDependencies) {
    this.#ordinaryMinds = dependencies.ordinaryMinds;
    this.#objects = dependencies.objects;
    this.#ids = dependencies.ids;
    this.#host = dependencies.host;
    this.#logger = dependencies.logger;
  }

  async createSpaceWithOwner(
    actor: ActorContext,
    command: CreateOrdinaryMindCommand,
  ): Promise<Readonly<OrdinaryMindMutationResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      Array.isArray(command) ||
      Object.keys(command).some(
        (key) => !["name", "handle", "description", "idempotencyKey"].includes(key),
      )
    ) {
      throw new OrdinaryMindControlFailure("invalid_request", "Mind create request is invalid.");
    }
    const displayName = normalizedDisplayName(command.name);
    if (displayName === null) {
      throw new OrdinaryMindControlFailure(
        "invalid_display_name",
        "A valid display name is required.",
      );
    }
    const hasDescription = Object.prototype.hasOwnProperty.call(command, "description");
    const normalizedDescription = hasDescription
      ? typeof command.description === "string"
        ? normalizeOrdinaryMindDescription(command.description)
        : command.description === null
          ? Object.freeze({ kind: "valid" as const, value: null })
          : Object.freeze({ kind: "invalid" as const })
      : Object.freeze({ kind: "valid" as const, value: null });
    if (normalizedDescription.kind !== "valid") {
      throw new OrdinaryMindControlFailure(
        "invalid_description",
        "A valid ordinary Mind description is required.",
      );
    }
    const hasCanonicalDescription = normalizedDescription.value !== null;
    if (isReservedTopLevelRoute(command?.handle)) {
      throw new OrdinaryMindControlFailure(
        "handle_unavailable",
        "The Mind handle is unavailable.",
      );
    }
    const parsedHandle = parseCanonicalSpaceHandle(command?.handle);
    if (parsedHandle.kind !== "valid") {
      throw new OrdinaryMindControlFailure(
        "invalid_handle",
        "A canonical Mind handle is required.",
      );
    }
    if (isReservedTopLevelHandle(parsedHandle.canonicalHandle)) {
      throw new OrdinaryMindControlFailure(
        "handle_unavailable",
        "The Mind handle is unavailable.",
      );
    }
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command?.idempotencyKey,
    );

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: hasCanonicalDescription
            ? "mind-diary-ordinary-mind-create-v2"
            : "mind-diary-ordinary-mind-create-v1",
          host: this.#host,
          handle: parsedHandle.canonicalHandle,
          display_name: displayName,
          ...(hasCanonicalDescription
            ? { description: normalizedDescription.value }
            : {}),
        })}\n`),
      );
      const spaceId = this.#ids.nextSpaceId();
      const membershipId = this.#ids.nextMembershipId();
      const revisionId = this.#ids.nextRevisionId();
      const initialFiles = createInitialOrdinaryMindFiles(
        trustedActor.occurredAtUtc,
      );
      const staged = await stageInitialMindRevision(
        this.#objects, spaceId, initialFiles, trustedActor.occurredAtUtc,
      );
      const initialRevision = createCanonicalRevisionEnvelope({
        revisionId,
        spaceId,
        revisionNumber: 1,
        parentRevisionId: null,
        committedAt: trustedActor.occurredAtUtc,
        committedBy: {
          kind: "principal",
          principalId: trustedActor.principalId,
        },
        manifest: staged.manifest,
        manifestHash: staged.manifestHash,
        manifestSize: staged.manifestSize,
        summary: "Create Mind",
      });
      const initialIndex = initialRevisionIndexEffects(
        this.#ids,
        spaceId,
        revisionId,
        trustedActor.occurredAtUtc,
      );
      const records = Object.freeze({
        canonicalCreationIntentId: staged.intentId,
        host: this.#host,
        space: Object.freeze({
          spaceId,
          spaceHandle: parsedHandle.canonicalHandle,
          normalizedHandle: parsedHandle.canonicalHandle,
          name: displayName,
          description: normalizedDescription.value,
          visibility: "private" as const,
          state: "active" as const,
          metadataVersion: version(1),
          accessVersion: version(1),
          headRevisionId: revisionId,
          createdAt: trustedActor.occurredAtUtc,
          updatedAt: trustedActor.occurredAtUtc,
        }),
        ownerMembership: Object.freeze({
          membershipId,
          spaceId,
          principalId: trustedActor.principalId,
          role: "owner" as const,
          state: "active" as const,
          version: version(1),
          createdAt: trustedActor.occurredAtUtc,
          createdBy: trustedActor.principalId,
          updatedAt: trustedActor.occurredAtUtc,
          updatedBy: trustedActor.principalId,
        }),
        initialRevision,
        initialIndexJob: initialIndex.job,
        initialIndexState: initialIndex.state,
        idempotencyKey: checkedIdempotencyKey,
        canonicalRequestHash,
      });
      const created = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) => transaction.createOrdinaryMind(records),
      );
      if (created.kind !== "created" || created.replayed) await staged.completeIntent();
      if (created.kind === "created") {
        recordOrdinaryMindEvent(
          this.#logger,
          created.replayed
            ? "ordinary_mind_create_replayed"
            : "ordinary_mind_created",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(created.mind),
          replayed: created.replayed,
        });
      }
      if (created.kind === "handle_unavailable") {
        throw new OrdinaryMindControlFailure(
          "handle_unavailable",
          "The Mind handle is unavailable.",
        );
      }
      if (created.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (created.kind === "principal_not_found") {
        throw new OrdinaryMindControlFailure(
          "authentication_required",
          "A registered Sites principal is required.",
        );
      }
      if (created.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure(
          "mind_not_found",
          "Mind was not found.",
        );
      }
      if (created.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current Mind settings access is required.",
        );
      }
      throw new OrdinaryMindControlFailure(
        created.kind === "record_conflict"
          ? "ordinary_mind_conflict"
          : "ordinary_mind_unavailable",
        "Mind creation is unavailable.",
      );
    } catch (error) {
      if (error instanceof OrdinaryMindControlFailure) {
        if (
          error.code === "handle_unavailable" ||
          error.code === "idempotency_conflict" ||
          error.code === "ordinary_mind_conflict"
        ) {
          recordOrdinaryMindEvent(
            this.#logger,
            "ordinary_mind_conflict",
            requestId,
          );
        }
      } else {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }

  async renameSpace(
    actor: ActorContext,
    command: RenameOrdinaryMindCommand,
  ): Promise<Readonly<OrdinaryMindMutationResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const trustedActor = ordinaryMindActor(actor);
    if (trustedActor === null) {
      recordOrdinaryMindEvent(this.#logger, "ordinary_mind_denied", requestId);
      throw new OrdinaryMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      Array.isArray(command) ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0
    ) {
      throw new OrdinaryMindControlFailure(
        "mind_not_found",
        "Mind was not found.",
      );
    }
    if (
      Object.keys(command).some(
        (key) => ![
          "mindId",
          "name",
          "description",
          "expectedMetadataVersion",
          "idempotencyKey",
        ].includes(key),
      )
    ) {
      throw new OrdinaryMindControlFailure(
        "invalid_request",
        "Ordinary Mind metadata update fields are invalid.",
      );
    }
    const updatesName = Object.prototype.hasOwnProperty.call(command, "name");
    const updatesDescription = Object.prototype.hasOwnProperty.call(command, "description");
    if (!updatesName && !updatesDescription) {
      throw new OrdinaryMindControlFailure(
        "invalid_request",
        "At least one ordinary Mind metadata field is required.",
      );
    }
    let displayName: string | undefined;
    if (updatesName) {
      const normalizedName = normalizedDisplayName(command.name);
      if (normalizedName === null) {
        throw new OrdinaryMindControlFailure(
          "invalid_display_name",
          "A valid display name is required.",
        );
      }
      displayName = normalizedName;
    }
    const normalizedDescription = updatesDescription
      ? typeof command.description === "string"
        ? normalizeOrdinaryMindDescription(command.description)
        : command.description === null
          ? Object.freeze({ kind: "valid" as const, value: null })
          : Object.freeze({ kind: "invalid" as const })
      : null;
    if (normalizedDescription?.kind === "invalid") {
      throw new OrdinaryMindControlFailure(
        "invalid_description",
        "A valid ordinary Mind description is required.",
      );
    }
    const expectedMetadataVersion = ordinaryMindMetadataVersion(
      command.expectedMetadataVersion,
    );
    const checkedIdempotencyKey = ordinaryMindIdempotencyKey(
      command.idempotencyKey,
    );

    try {
      const canonicalRequestHash = await this.#objects.calculateSha256(
        PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
          format: updatesDescription
            ? "mind-diary-ordinary-mind-metadata-update-v2"
            : "mind-diary-ordinary-mind-rename-v1",
          mind_id: command.mindId,
          ...(updatesName ? { display_name: displayName } : {}),
          ...(updatesDescription
            ? { description: normalizedDescription?.value ?? null }
            : {}),
          expected_metadata_version: expectedMetadataVersion,
        })}\n`),
      );
      const renamed = await this.#ordinaryMinds.runOrdinaryMindTransaction(
        (transaction) =>
          transaction.renameOrdinaryMind({
            principalId: trustedActor.principalId,
            spaceId: command.mindId,
            ...(displayName === undefined ? {} : { displayName }),
            ...(updatesDescription
              ? { description: normalizedDescription?.value ?? null }
              : {}),
            expectedMetadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: trustedActor.occurredAtUtc,
          }),
      );
      if (renamed.kind === "renamed") {
        recordOrdinaryMindEvent(
          this.#logger,
          renamed.replayed
            ? "ordinary_mind_rename_replayed"
            : "ordinary_mind_renamed",
          requestId,
        );
        return Object.freeze({
          ...ordinaryMindDescriptor(renamed.mind),
          replayed: renamed.replayed,
        });
      }
      if (renamed.kind === "metadata_conflict") {
        throw new OrdinaryMindControlFailure(
          "metadata_conflict",
          "Mind metadata changed; re-read and retry.",
        );
      }
      if (renamed.kind === "idempotency_conflict") {
        throw new OrdinaryMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      if (renamed.kind === "personal_mind") {
        throw new OrdinaryMindControlFailure(
          "personal_mind_operation_forbidden",
          "This operation is unavailable for Personal Mind.",
        );
      }
      if (renamed.kind === "mind_not_found") {
        throw new OrdinaryMindControlFailure(
          "mind_not_found",
          "Mind was not found.",
        );
      }
      if (renamed.kind === "forbidden") {
        throw new OrdinaryMindControlFailure(
          "forbidden",
          "Current Mind settings access is required.",
        );
      }
      if (renamed.kind === "description_required_for_write") {
        throw new OrdinaryMindControlFailure(
          "description_required_for_write",
          "Change the Mind usage mode before clearing its writable description.",
        );
      }
      throw new OrdinaryMindControlFailure(
        "ordinary_mind_unavailable",
        "Mind rename is unavailable.",
      );
    } catch (error) {
      if (error instanceof OrdinaryMindControlFailure) {
        if (
          error.code === "metadata_conflict" ||
          error.code === "idempotency_conflict"
        ) {
          recordOrdinaryMindEvent(
            this.#logger,
            "ordinary_mind_conflict",
            requestId,
          );
        } else if (
          error.code === "forbidden" ||
          error.code === "personal_mind_operation_forbidden"
        ) {
          recordOrdinaryMindEvent(
            this.#logger,
            "ordinary_mind_denied",
            requestId,
          );
        }
      } else {
        recordOrdinaryMindEvent(this.#logger, "ordinary_mind_failed", requestId);
      }
      throw error;
    }
  }
}
