import type { ActorContext } from "@mind-diary/application-contracts";
import type { ObjectStore, PersonalMindProfileSnapshot, PersonalMindStore } from "@mind-diary/application-ports";
import { idempotencyKey, normalizeOrdinaryMindDescription, version } from "@mind-diary/domain";
import type { PrincipalId, SpaceId } from "@mind-diary/domain";
import { safeBootstrapRequestId, normalizedDisplayName } from "./account-bootstrap.js";

export const PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS = [
  "rename_space",
  "create_invitation",
  "accept_invitation",
  "reject_invitation",
  "cancel_invitation",
  "reissue_invitation",
  "add_participant",
  "change_membership_role",
  "revoke_membership",
  "leave_space",
  "change_visibility",
  "publish",
  "transfer_ownership",
  "delete_space",
] as const;

export type PersonalMindForbiddenLifecycleOperation =
  (typeof PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS)[number];

export type PersonalMindControlFailureCode =
  | "authentication_required"
  | "invalid_display_name"
  | "invalid_description"
  | "invalid_profile_version"
  | "invalid_idempotency_key"
  | "invalid_lifecycle_operation"
  | "mind_not_found"
  | "personal_mind_not_found"
  | "personal_mind_operation_forbidden"
  | "profile_conflict"
  | "metadata_conflict"
  | "description_required_for_write"
  | "idempotency_conflict"
  | "personal_mind_unavailable";

/** Stable safe error: it never includes a target ID, display name, or hidden handle. */
export class PersonalMindControlFailure extends Error {
  readonly code: PersonalMindControlFailureCode;

  constructor(code: PersonalMindControlFailureCode, message: string) {
    super(message);
    this.name = "PersonalMindControlFailure";
    this.code = code;
  }
}

export interface RenameAccountCommand {
  readonly displayName: string;
  readonly expectedProfileVersion: number;
  readonly idempotencyKey: string;
}

export interface UpdatePersonalMindDescriptionCommand {
  readonly description: string | null;
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface PersonalMindProfileDescriptor {
  readonly principal: {
    readonly principalId: PrincipalId;
    readonly displayName: string;
    readonly profileVersion: number;
  };
  readonly personalMind: {
    readonly mindId: SpaceId;
    readonly route: "/me";
    readonly name: string;
    readonly description: string | null;
    readonly visibility: "private";
    readonly metadataVersion: number;
    readonly headRevisionId: PersonalMindProfileSnapshot["personalMind"]["headRevisionId"];
  };
}

export interface RenameAccountResult extends PersonalMindProfileDescriptor {
  readonly replayed: boolean;
}

export interface UpdatePersonalMindDescriptionResult
  extends PersonalMindProfileDescriptor {
  readonly replayed: boolean;
}

export interface GuardOrdinaryLifecycleCommand {
  readonly mindId: SpaceId;
  readonly operation: PersonalMindForbiddenLifecycleOperation;
}

export interface OrdinaryLifecycleTarget {
  readonly kind: "ordinary";
  readonly mindId: SpaceId;
}

export interface PersonalMindControlSafeEvent {
  readonly event:
    | "personal_mind_resolved"
    | "personal_profile_renamed"
    | "personal_profile_replayed"
    | "personal_profile_conflict"
    | "personal_lifecycle_denied"
    | "personal_control_denied"
    | "personal_control_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface PersonalMindControlSafeLogger {
  record(event: Readonly<PersonalMindControlSafeEvent>): void | Promise<void>;
}

export interface PersonalMindControlDependencies {
  readonly personalMinds: PersonalMindStore;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
  readonly logger?: PersonalMindControlSafeLogger;
}

const PERSONAL_PROFILE_IDEMPOTENCY_MAX_BYTES = 256;
const PERSONAL_PROFILE_IDEMPOTENCY_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
export const PERSONAL_PROFILE_ENCODER = new TextEncoder();

export function registeredSitesPrincipal(actor: ActorContext): PrincipalId | null {
  return actor?.kind === "registered_principal" &&
    actor.authentication?.kind === "sites_identity" &&
    typeof actor.principalId === "string" &&
    actor.principalId.length > 0
    ? actor.principalId
    : null;
}

export function personalProfileIdempotencyKey(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    PERSONAL_PROFILE_IDEMPOTENCY_FORBIDDEN.test(value) ||
    PERSONAL_PROFILE_ENCODER.encode(value).byteLength >
      PERSONAL_PROFILE_IDEMPOTENCY_MAX_BYTES
  ) {
    throw new PersonalMindControlFailure(
      "invalid_idempotency_key",
      "A valid idempotency key is required.",
    );
  }
  return idempotencyKey(value);
}

function personalProfileVersion(value: unknown) {
  try {
    return version(value as number);
  } catch {
    throw new PersonalMindControlFailure(
      "invalid_profile_version",
      "A valid expected profile version is required.",
    );
  }
}

function personalProfileDescriptor(
  profile: Readonly<PersonalMindProfileSnapshot>,
): Readonly<PersonalMindProfileDescriptor> {
  return Object.freeze({
    principal: Object.freeze({
      principalId: profile.principalId,
      displayName: profile.displayName,
      profileVersion: profile.profileVersion,
    }),
    personalMind: Object.freeze({
      mindId: profile.personalMind.spaceId,
      route: "/me",
      name: profile.personalMind.name,
      description: profile.personalMind.description,
      visibility: "private",
      metadataVersion: profile.personalMind.metadataVersion,
      headRevisionId: profile.personalMind.headRevisionId,
    }),
  });
}

function recordPersonalMindEvent(
  logger: PersonalMindControlSafeLogger | undefined,
  event: PersonalMindControlSafeEvent["event"],
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

/** `/me`, profile sync, and pre-mutation Personal Mind lifecycle policy. */
export class PersonalMindControlService {
  readonly #personalMinds: PersonalMindStore;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #logger: PersonalMindControlSafeLogger | undefined;

  constructor(dependencies: PersonalMindControlDependencies) {
    this.#personalMinds = dependencies.personalMinds;
    this.#digest = dependencies.digest;
    this.#logger = dependencies.logger;
  }

  async resolveMyMind(
    actor: ActorContext,
  ): Promise<Readonly<PersonalMindProfileDescriptor>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordPersonalMindEvent(
        this.#logger,
        "personal_control_denied",
        requestId,
      );
      throw new PersonalMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const profile = await this.#personalMinds.readPersonalMindProfile(principalId);
    if (profile === null) {
      throw new PersonalMindControlFailure(
        "personal_mind_not_found",
        "Personal Mind is unavailable.",
      );
    }
    recordPersonalMindEvent(
      this.#logger,
      "personal_mind_resolved",
      requestId,
    );
    return personalProfileDescriptor(profile);
  }

  async renameAccount(
    actor: ActorContext,
    command: RenameAccountCommand,
  ): Promise<Readonly<RenameAccountResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordPersonalMindEvent(
        this.#logger,
        "personal_control_denied",
        requestId,
      );
      throw new PersonalMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const displayName = normalizedDisplayName(command?.displayName);
    if (displayName === null) {
      throw new PersonalMindControlFailure(
        "invalid_display_name",
        "A valid display name is required.",
      );
    }
    const expectedProfileVersion = personalProfileVersion(
      command?.expectedProfileVersion,
    );
    const checkedIdempotencyKey = personalProfileIdempotencyKey(
      command?.idempotencyKey,
    );
    const preflight = await this.#personalMinds.readPersonalMindProfile(principalId);
    if (preflight === null) {
      throw new PersonalMindControlFailure(
        "personal_mind_not_found",
        "Personal Mind is unavailable.",
      );
    }
    const canonicalRequestHash = await this.#digest.calculateSha256(
      PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-personal-profile-rename-v1",
        display_name: displayName,
        expected_profile_version: expectedProfileVersion,
      })}\n`),
    );
    try {
      const renamed = await this.#personalMinds.runPersonalMindTransaction(
        (transaction) =>
          transaction.renamePersonalProfile({
            principalId,
            displayName,
            expectedProfileVersion,
            expectedPersonalMetadataVersion:
              preflight.personalMind.metadataVersion,
            idempotencyKey: checkedIdempotencyKey,
            canonicalRequestHash,
            occurredAt: actor.occurredAtUtc,
          }),
      );
      if (renamed.kind === "renamed") {
        recordPersonalMindEvent(
          this.#logger,
          renamed.replayed
            ? "personal_profile_replayed"
            : "personal_profile_renamed",
          requestId,
        );
        return Object.freeze({
          ...personalProfileDescriptor(renamed.profile),
          replayed: renamed.replayed,
        });
      }
      if (renamed.kind === "profile_conflict") {
        recordPersonalMindEvent(
          this.#logger,
          "personal_profile_conflict",
          requestId,
        );
        throw new PersonalMindControlFailure(
          "profile_conflict",
          "Profile metadata changed; re-read and retry.",
        );
      }
      if (renamed.kind === "idempotency_conflict") {
        throw new PersonalMindControlFailure(
          "idempotency_conflict",
          "The idempotency key was already used for another request.",
        );
      }
      throw new PersonalMindControlFailure(
        renamed.kind === "not_found"
          ? "personal_mind_not_found"
          : "personal_mind_unavailable",
        "Personal Mind profile update is unavailable.",
      );
    } catch (error) {
      if (!(error instanceof PersonalMindControlFailure)) {
        recordPersonalMindEvent(
          this.#logger,
          "personal_control_failed",
          requestId,
        );
      }
      throw error;
    }
  }

  async updateMyMindDescription(
    actor: ActorContext,
    command: UpdatePersonalMindDescriptionCommand,
  ): Promise<Readonly<UpdatePersonalMindDescriptionResult>> {
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      throw new PersonalMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const normalized = typeof command?.description === "string"
      ? normalizeOrdinaryMindDescription(command.description)
      : command?.description === null
        ? Object.freeze({ kind: "valid" as const, value: null })
        : Object.freeze({ kind: "invalid" as const });
    if (normalized.kind !== "valid") {
      throw new PersonalMindControlFailure(
        "invalid_description",
        "A valid Personal Mind description is required.",
      );
    }
    const expectedMetadataVersion = personalProfileVersion(
      command.expectedMetadataVersion,
    );
    const checkedIdempotencyKey = personalProfileIdempotencyKey(
      command.idempotencyKey,
    );
    const canonicalRequestHash = await this.#digest.calculateSha256(
      PERSONAL_PROFILE_ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-personal-mind-description-v1",
        description: normalized.value,
        expected_metadata_version: expectedMetadataVersion,
      })}\n`),
    );
    const updated = await this.#personalMinds.runPersonalMindTransaction(
      (transaction) => transaction.updatePersonalMindDescription({
        principalId,
        description: normalized.value,
        expectedPersonalMetadataVersion: expectedMetadataVersion,
        idempotencyKey: checkedIdempotencyKey,
        canonicalRequestHash,
        occurredAt: actor.occurredAtUtc,
      }),
    );
    if (updated.kind === "updated") {
      return Object.freeze({
        ...personalProfileDescriptor(updated.profile),
        replayed: updated.replayed,
      });
    }
    if (updated.kind === "metadata_conflict") {
      throw new PersonalMindControlFailure(
        "metadata_conflict",
        "Personal Mind metadata changed; re-read and retry.",
      );
    }
    if (updated.kind === "description_required_for_write") {
      throw new PersonalMindControlFailure(
        "description_required_for_write",
        "Change the Mind usage mode before clearing its writable description.",
      );
    }
    if (updated.kind === "idempotency_conflict") {
      throw new PersonalMindControlFailure(
        "idempotency_conflict",
        "The idempotency key was already used for another request.",
      );
    }
    throw new PersonalMindControlFailure(
      updated.kind === "not_found"
        ? "personal_mind_not_found"
        : "personal_mind_unavailable",
      "Personal Mind description update is unavailable.",
    );
  }

  /** Must run before any ordinary lifecycle command stages mutations. */
  async guardOrdinaryLifecycle(
    actor: ActorContext,
    command: GuardOrdinaryLifecycleCommand,
  ): Promise<Readonly<OrdinaryLifecycleTarget>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      throw new PersonalMindControlFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (
      command === null ||
      typeof command !== "object" ||
      !PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS.includes(command.operation) ||
      typeof command.mindId !== "string" ||
      command.mindId.length === 0
    ) {
      throw new PersonalMindControlFailure(
        "invalid_lifecycle_operation",
        "The lifecycle operation is invalid.",
      );
    }
    const target = await this.#personalMinds.classifyPersonalMindTarget({
      principalId,
      spaceId: command.mindId,
    });
    if (target.kind === "own_personal") {
      recordPersonalMindEvent(
        this.#logger,
        "personal_lifecycle_denied",
        requestId,
      );
      throw new PersonalMindControlFailure(
        "personal_mind_operation_forbidden",
        "This operation is unavailable for Personal Mind.",
      );
    }
    if (target.kind === "not_found") {
      throw new PersonalMindControlFailure(
        "mind_not_found",
        "Mind was not found.",
      );
    }
    return Object.freeze({ kind: "ordinary", mindId: target.spaceId });
  }
}
