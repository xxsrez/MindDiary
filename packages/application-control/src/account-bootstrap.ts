import type { ActorContext } from "@mind-diary/application-contracts";
import type { AccountBootstrapIdGenerator, AccountBootstrapStore, BundleFileObjectStore, ExternalIdentityBindingLookup, OrdinaryMindIdGenerator } from "@mind-diary/application-ports";
import { createCanonicalRevisionEnvelope, isReservedTopLevelHandle, parseCanonicalSpaceHandle, version } from "@mind-diary/domain";
import type { JobId, PrincipalId, PrincipalAccountSnapshot, SensitiveExternalBinding, SpaceId, UtcInstant } from "@mind-diary/domain";
import { parseUtcInstant } from "./token-lifecycle.js";
import { createInitialPersonalMindFiles } from "./initial-mind-files.js";
import { stageInitialMindRevision } from "./initial-mind-revision.js";

export const ACCOUNT_BOOTSTRAP_ACTION = "create_isolated_account" as const;

export interface SitesIdentityBeforeRegistration {
  readonly kind: "sites_identity_before_registration";
  readonly authentication: {
    readonly kind: "sites_identity";
    readonly verifiedByPlatform: true;
  };
  readonly provider: string;
  /** Exact server-normalized binding; sensitive and never returned/logged. */
  readonly normalizedBinding: SensitiveExternalBinding;
  readonly suggestedDisplayName?: string;
  readonly deploymentCapabilities: readonly string[];
  readonly requestId: ActorContext["requestId"];
  readonly occurredAtUtc: UtcInstant;
}

export interface BootstrapAccountCommand {
  readonly action: typeof ACCOUNT_BOOTSTRAP_ACTION;
  readonly displayName?: string;
}

export interface PersonalMindControlDescriptor {
  readonly mindId: PrincipalAccountSnapshot["personalMind"]["space"]["spaceId"];
  readonly route: "/me";
  readonly visibility: "private";
  readonly headRevisionId: PrincipalAccountSnapshot["personalMind"]["space"]["headRevisionId"];
}

export interface BootstrapAccountResult {
  readonly principalId: PrincipalId;
  readonly personalMind: Readonly<PersonalMindControlDescriptor>;
  readonly replayed: boolean;
}

export type AccountBootstrapFailureCode =
  | "authentication_required"
  | "invalid_action"
  | "display_name_required"
  | "account_bootstrap_conflict"
  | "account_bootstrap_unavailable"
  | "personal_mind_not_found";

/** Stable safe failure without external binding, profile, or hidden handle. */
export class AccountBootstrapFailure extends Error {
  readonly code: AccountBootstrapFailureCode;

  constructor(code: AccountBootstrapFailureCode, message: string) {
    super(message);
    this.name = "AccountBootstrapFailure";
    this.code = code;
  }
}

export interface AccountBootstrapSafeEvent {
  readonly event:
    | "account_bootstrap_succeeded"
    | "account_bootstrap_replayed"
    | "account_bootstrap_denied"
    | "account_bootstrap_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface AccountBootstrapSafeLogger {
  record(event: Readonly<AccountBootstrapSafeEvent>): void | Promise<void>;
}

export interface AccountBootstrapDependencies {
  readonly accounts: AccountBootstrapStore;
  readonly objects: BundleFileObjectStore;
  readonly ids: AccountBootstrapIdGenerator;
  readonly logger?: AccountBootstrapSafeLogger;
}

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function safeBootstrapRequestId(
  value: unknown,
): AccountBootstrapSafeEvent["requestId"] {
  return (
    typeof value === "string" && SAFE_REQUEST_ID_PATTERN.test(value)
      ? value
      : "request_invalid"
  ) as AccountBootstrapSafeEvent["requestId"];
}

function recordBootstrapEvent(
  logger: AccountBootstrapSafeLogger | undefined,
  event: AccountBootstrapSafeEvent["event"],
  requestId: AccountBootstrapSafeEvent["requestId"],
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
    // Safe observability is never part of the metadata transaction.
  }
}

function isSitesIdentityBeforeRegistration(
  actor: SitesIdentityBeforeRegistration | ActorContext,
): actor is SitesIdentityBeforeRegistration {
  return (
    actor?.kind === "sites_identity_before_registration" &&
    actor.authentication?.kind === "sites_identity" &&
    actor.authentication.verifiedByPlatform === true &&
    typeof actor.provider === "string" &&
    SAFE_PROVIDER_PATTERN.test(actor.provider) &&
    typeof actor.normalizedBinding === "string" &&
    actor.normalizedBinding.length > 0 &&
    actor.normalizedBinding.length <= 320 &&
    !CONTROL_OR_SEPARATOR.test(actor.normalizedBinding) &&
    typeof actor.requestId === "string" &&
    SAFE_REQUEST_ID_PATTERN.test(actor.requestId) &&
    parseUtcInstant(actor.occurredAtUtc) !== null &&
    Array.isArray(actor.deploymentCapabilities) &&
    actor.deploymentCapabilities.every(
      (capability) => typeof capability === "string" && capability.length > 0,
    )
  );
}

export function normalizedDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized: string;
  try {
    normalized = value.normalize("NFKC").trim();
  } catch {
    return null;
  }
  return normalized.length > 0 &&
    [...normalized].length <= 128 &&
    !CONTROL_OR_SEPARATOR.test(normalized)
    ? normalized
    : null;
}

function bootstrapDisplayName(
  actor: SitesIdentityBeforeRegistration,
  command: BootstrapAccountCommand,
): string {
  const trustedProfile = normalizedDisplayName(actor.suggestedDisplayName);
  if (trustedProfile !== null) return trustedProfile;
  const explicit = normalizedDisplayName(command.displayName);
  if (explicit !== null) return explicit;
  throw new AccountBootstrapFailure(
    "display_name_required",
    "A valid display name is required for first account creation.",
  );
}

function personalMindDescriptor(
  account: Readonly<PrincipalAccountSnapshot>,
): Readonly<PersonalMindControlDescriptor> {
  const space = account.personalMind.space;
  return Object.freeze({
    mindId: space.spaceId,
    route: "/me",
    visibility: "private",
    headRevisionId: space.headRevisionId,
  });
}

function bootstrapResult(
  account: Readonly<PrincipalAccountSnapshot>,
  replayed: boolean,
): Readonly<BootstrapAccountResult> {
  return Object.freeze({
    principalId: account.principal.principalId,
    personalMind: personalMindDescriptor(account),
    replayed,
  });
}

function exactBindingLookup(
  actor: SitesIdentityBeforeRegistration,
): Readonly<ExternalIdentityBindingLookup> {
  return Object.freeze({
    provider: actor.provider,
    normalizedBinding: actor.normalizedBinding,
  });
}

export function initialRevisionIndexEffects(
  ids: Pick<AccountBootstrapIdGenerator | OrdinaryMindIdGenerator, "nextIndexJobId">,
  spaceId: SpaceId,
  revisionId: string,
  occurredAt: UtcInstant,
) {
  const jobId = ids.nextIndexJobId?.() ?? (`index_job_${revisionId}` as JobId);
  return Object.freeze({
    job: Object.freeze({
      jobId,
      target: Object.freeze({
        kind: "revision_index" as const,
        spaceId,
        revisionId: revisionId as never,
      }),
      state: "queued" as const,
      version: version(1),
      attempts: 0,
      availableAt: occurredAt,
      claimExpiresAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }),
    state: Object.freeze({
      spaceId,
      revisionId: revisionId as never,
      status: "queued" as const,
      attempts: 0,
      queuedAt: occurredAt,
      updatedAt: occurredAt,
      readyAt: null,
      lastFailureCode: null,
    }),
  });
}

export class AccountBootstrapService {
  readonly #accounts: AccountBootstrapStore;
  readonly #objects: BundleFileObjectStore;
  readonly #ids: AccountBootstrapIdGenerator;
  readonly #logger: AccountBootstrapSafeLogger | undefined;

  constructor(dependencies: AccountBootstrapDependencies) {
    this.#accounts = dependencies.accounts;
    this.#objects = dependencies.objects;
    this.#ids = dependencies.ids;
    this.#logger = dependencies.logger;
  }

  async bootstrapAccount(
    actor: SitesIdentityBeforeRegistration | ActorContext,
    command: BootstrapAccountCommand,
  ): Promise<Readonly<BootstrapAccountResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    if (!isSitesIdentityBeforeRegistration(actor)) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_denied", requestId);
      throw new AccountBootstrapFailure(
        "authentication_required",
        "A verified Sites identity before registration is required.",
      );
    }
    if (command?.action !== ACCOUNT_BOOTSTRAP_ACTION) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_denied", requestId);
      throw new AccountBootstrapFailure(
        "invalid_action",
        "Only explicit isolated account creation is supported.",
      );
    }

    const lookup = exactBindingLookup(actor);

    try {
      const existing = await this.#accounts.readAccountByExternalBinding(lookup);
      if (existing !== null) {
        recordBootstrapEvent(this.#logger, "account_bootstrap_replayed", requestId);
        return bootstrapResult(existing, true);
      }
    } catch (error) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_failed", requestId);
      throw error;
    }

    let displayName: string;
    try {
      displayName = bootstrapDisplayName(actor, command);
    } catch (error) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_denied", requestId);
      throw error;
    }

    try {
      const principalId = this.#ids.nextPrincipalId();
      const bindingId = this.#ids.nextExternalBindingId();
      const spaceId = this.#ids.nextSpaceId();
      const membershipId = this.#ids.nextMembershipId();
      const revisionId = this.#ids.nextRevisionId();
      const hiddenHandle = this.#ids.nextPersonalSpaceHandle();
      const parsedHandle = parseCanonicalSpaceHandle(hiddenHandle);
      if (
        parsedHandle.kind !== "valid" ||
        isReservedTopLevelHandle(parsedHandle.canonicalHandle)
      ) {
        throw new AccountBootstrapFailure(
          "account_bootstrap_conflict",
          "Server-owned account identifiers are unavailable.",
        );
      }

      const initialFiles = createInitialPersonalMindFiles(actor.occurredAtUtc);
      const staged = await stageInitialMindRevision(
        this.#objects, spaceId, initialFiles, actor.occurredAtUtc,
      );
      const initialRevision = createCanonicalRevisionEnvelope({
        revisionId,
        spaceId,
        revisionNumber: 1,
        parentRevisionId: null,
        committedAt: actor.occurredAtUtc,
        committedBy: { kind: "principal", principalId },
        manifest: staged.manifest,
        manifestHash: staged.manifestHash,
        manifestSize: staged.manifestSize,
        summary: "Create Personal Mind",
      });
      const initialIndex = initialRevisionIndexEffects(
        this.#ids,
        spaceId,
        revisionId,
        actor.occurredAtUtc,
      );
      const records = Object.freeze({
        canonicalCreationIntentId: staged.intentId,
        principal: Object.freeze({
          principalId,
          displayName,
          state: "active" as const,
          profileVersion: version(1),
          createdAt: actor.occurredAtUtc,
          updatedAt: actor.occurredAtUtc,
        }),
        externalBinding: Object.freeze({
          bindingId,
          principalId,
          provider: actor.provider,
          normalizedBinding: actor.normalizedBinding,
          state: "active" as const,
          version: version(1),
          verifiedAt: actor.occurredAtUtc,
          createdAt: actor.occurredAtUtc,
          updatedAt: actor.occurredAtUtc,
        }),
        personalSpace: Object.freeze({
          spaceId,
          spaceHandle: parsedHandle.canonicalHandle,
          normalizedHandle: parsedHandle.canonicalHandle,
          name: displayName,
          description: null,
          visibility: "private" as const,
          state: "active" as const,
          metadataVersion: version(1),
          accessVersion: version(1),
          headRevisionId: revisionId,
          createdAt: actor.occurredAtUtc,
          updatedAt: actor.occurredAtUtc,
        }),
        personalBinding: Object.freeze({
          principalId,
          spaceId,
          version: version(1),
          createdAt: actor.occurredAtUtc,
        }),
        ownerMembership: Object.freeze({
          membershipId,
          spaceId,
          principalId,
          role: "owner" as const,
          state: "active" as const,
          version: version(1),
          createdAt: actor.occurredAtUtc,
          createdBy: principalId,
          updatedAt: actor.occurredAtUtc,
          updatedBy: principalId,
        }),
        initialRevision,
        initialIndexJob: initialIndex.job,
        initialIndexState: initialIndex.state,
      });

      const created = await this.#accounts.runAccountBootstrapTransaction(
        async (transaction) => {
          const replay = await transaction.readAccountByExternalBinding(lookup);
          if (replay !== null) {
            return Object.freeze({ kind: "exact_binding_exists", account: replay } as const);
          }
          return transaction.createAccountBootstrap(records);
        },
      );
      // Sites settles a committed creation intent in the same D1 batch as
      // its revision event. A known non-commit still owns its staged objects.
      if (created.kind !== "created") await staged.completeIntent();
      if (created.kind === "created") {
        recordBootstrapEvent(this.#logger, "account_bootstrap_succeeded", requestId);
        return bootstrapResult(created.account, false);
      }
      if (created.kind === "exact_binding_exists") {
        recordBootstrapEvent(this.#logger, "account_bootstrap_replayed", requestId);
        return bootstrapResult(created.account, true);
      }
      throw new AccountBootstrapFailure(
        "account_bootstrap_conflict",
        "Account creation conflicted with current state.",
      );
    } catch (error) {
      recordBootstrapEvent(this.#logger, "account_bootstrap_failed", requestId);
      throw error;
    }
  }

  async resolveMyMind(
    actor: ActorContext,
  ): Promise<Readonly<PersonalMindControlDescriptor>> {
    if (
      actor?.kind !== "registered_principal" ||
      actor.authentication.kind !== "sites_identity"
    ) {
      throw new AccountBootstrapFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const resolution = await this.#accounts.resolvePersonalMind(actor.principalId);
    if (resolution === null) {
      throw new AccountBootstrapFailure(
        "personal_mind_not_found",
        "Personal Mind is unavailable.",
      );
    }
    return Object.freeze({
      mindId: resolution.spaceId,
      route: "/me",
      visibility: "private",
      headRevisionId: resolution.headRevisionId,
    });
  }
}
