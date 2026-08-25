import type { ActorContext } from "@mind-diary/application-contracts";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import type { AuthorizationStamp, Clock, ControlReadStore, McpTokenStore, PilotCohort, PrivacySafeObservabilityEvent, PrivacySafeObservabilitySink, PrincipalActivityKind, PrincipalActivitySurface, ServiceOperatorAuditIdGenerator, ServiceOperatorDirectoryQuery, ServiceOperatorDirectoryStore } from "@mind-diary/application-ports";
import type { PrincipalId, SpaceId, UtcInstant } from "@mind-diary/domain";
import type { AccountBootstrapSafeEvent } from "./account-bootstrap.js";
import { registeredSitesPrincipal } from "./personal-mind-control.js";
import type { PersonalMindControlSafeEvent } from "./personal-mind-control.js";
import type { OrdinaryMindControlSafeEvent } from "./ordinary-mind-control.js";
import type { AccountDeletionSafeEvent } from "./account-deletion.js";
import type { VisibilityControlSafeEvent } from "./visibility-control.js";
import type { OwnershipTransferSafeEvent } from "./ownership-transfer.js";
import type { MembershipControlSafeEvent } from "./membership-control.js";
import type { InvitationControlSafeEvent } from "./invitation-control.js";
import type { MindRouteSafeEvent } from "./mind-route.js";
import type { PublicMindCatalogSafeEvent } from "./public-mind-catalog.js";
import { parseUtcInstant } from "./token-lifecycle.js";
import type { TokenLifecycleSafeEvent } from "./token-lifecycle.js";

export type ControlPrivacySafeEvent =
  | AccountBootstrapSafeEvent
  | PersonalMindControlSafeEvent
  | OrdinaryMindControlSafeEvent
  | AccountDeletionSafeEvent
  | VisibilityControlSafeEvent
  | OwnershipTransferSafeEvent
  | MembershipControlSafeEvent
  | InvitationControlSafeEvent
  | MindRouteSafeEvent
  | PublicMindCatalogSafeEvent
  | TokenLifecycleSafeEvent;

function controlOutcome(
  event: ControlPrivacySafeEvent["event"],
): PrivacySafeObservabilityEvent["outcome"] {
  if (event.includes("denied")) return "denied";
  if (event.includes("conflict")) return "conflict";
  if (event.includes("replayed")) return "replayed";
  if (event.includes("failed") || event.includes("incomplete")) return "failure";
  return "success";
}

/**
 * One logger for the existing control safe-event ports. It maps only the
 * event enum and opaque request ID; service inputs never cross this boundary.
 */
export type ControlReadFailureCode =
  | "authentication_required"
  | "mind_not_found"
  | "control_projection_unavailable";

export class ControlReadFailure extends Error {
  readonly code: ControlReadFailureCode;

  constructor(code: ControlReadFailureCode, message: string) {
    super(message);
    this.name = "ControlReadFailure";
    this.code = code;
  }
}

function sameAuthorizationStamp(
  left: Readonly<AuthorizationStamp>,
  right: Readonly<AuthorizationStamp>,
): boolean {
  return (
    left.accessVersion === right.accessVersion &&
    left.membershipVersion === right.membershipVersion &&
    left.tokenVersion === right.tokenVersion
  );
}

/** Current safe member/invitation projections for the trusted Sites UI. */
export class ControlReadService {
  readonly #store: ControlReadStore;
  readonly #authorizer: CapabilityAuthorizer;

  constructor(store: ControlReadStore) {
    this.#store = store;
    this.#authorizer = new CapabilityAuthorizer(store);
  }

  async listMembers(actor: ActorContext, mindId: unknown) {
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      throw new ControlReadFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    if (typeof mindId !== "string" || mindId.length === 0 || mindId.length > 128) {
      throw new ControlReadFailure("mind_not_found", "Mind was not found.");
    }
    const initial = await this.#authorizer.authorize({
      actor,
      spaceId: mindId as SpaceId,
      capability: "content:browse",
      revisionMode: "head",
    });
    if (initial.kind === "denied" || initial.grant.kind !== "membership") {
      throw new ControlReadFailure("mind_not_found", "Mind was not found.");
    }
    const members = await this.#store.listControlMembers(mindId as SpaceId);
    const final = await this.#authorizer.authorize({
      actor,
      spaceId: mindId as SpaceId,
      capability: "content:browse",
      revisionMode: "head",
    });
    if (
      final.kind === "denied" ||
      final.grant.kind !== "membership" ||
      !sameAuthorizationStamp(initial.stamp, final.stamp)
    ) {
      throw new ControlReadFailure(
        "control_projection_unavailable",
        "Membership state changed; retry the request.",
      );
    }
    return Object.freeze({
      members: Object.freeze(
        members
          .filter((member) => member.state === "active")
          .map(({ principalId: memberPrincipalId, ...member }) =>
            Object.freeze({
              ...member,
              isSelf: memberPrincipalId === principalId,
            }),
          ),
      ),
    });
  }

  async listInvitations(actor: ActorContext) {
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      throw new ControlReadFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }
    const invitations = await this.#store.listControlInvitations(principalId);
    return Object.freeze({ invitations: Object.freeze([...invitations]) });
  }
}

export class PrincipalActivityService {
  readonly #store: ServiceOperatorDirectoryStore;

  constructor(store: ServiceOperatorDirectoryStore) {
    this.#store = store;
  }

  /** Activity is observational: persistence failures never change product outcomes. */
  async recordSuccessful(
    actor: ActorContext,
    surface: PrincipalActivitySurface,
    kind: PrincipalActivityKind,
  ): Promise<void> {
    if (
      actor.kind !== "registered_principal" ||
      typeof actor.principalId !== "string" ||
      actor.principalId.length === 0
    ) return;
    try {
      await this.#store.recordPrincipalActivity({
        principalId: actor.principalId,
        surface,
        kind,
        observedAt: actor.occurredAtUtc,
      });
    } catch {
      // Best-effort projection; canonical application success already happened.
    }
  }
}

export type ServiceOperatorDirectoryFailureCode = "not_found" | "invalid_request";

export class ServiceOperatorDirectoryFailure extends Error {
  readonly code: ServiceOperatorDirectoryFailureCode;

  constructor(code: ServiceOperatorDirectoryFailureCode, message: string) {
    super(message);
    this.name = "ServiceOperatorDirectoryFailure";
    this.code = code;
  }
}

function operatorUtc(value: unknown): UtcInstant | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 40) {
    throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid UTC range.");
  }
  const parsed = parseUtcInstant(value);
  if (parsed === null || new Date(parsed).toISOString() !== value) {
    throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid UTC range.");
  }
  return value as UtcInstant;
}

function operatorBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid boolean filter.");
}

export class ServiceOperatorDirectoryService {
  readonly #store: ServiceOperatorDirectoryStore;
  readonly #tokens: McpTokenStore;
  readonly #operatorPrincipalIds: ReadonlySet<PrincipalId>;
  readonly #ids: ServiceOperatorAuditIdGenerator;

  constructor(dependencies: {
    readonly store: ServiceOperatorDirectoryStore;
    readonly tokens: McpTokenStore;
    readonly operatorPrincipalIds: ReadonlySet<PrincipalId>;
    readonly ids: ServiceOperatorAuditIdGenerator;
  }) {
    this.#store = dependencies.store;
    this.#tokens = dependencies.tokens;
    this.#operatorPrincipalIds = new Set(dependencies.operatorPrincipalIds);
    this.#ids = dependencies.ids;
  }

  async list(
    actor: ActorContext,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null || !this.#operatorPrincipalIds.has(principalId)) {
      throw new ServiceOperatorDirectoryFailure("not_found", "Route was not found.");
    }
    const queryValue = input.query;
    if (
      queryValue !== undefined &&
      (typeof queryValue !== "string" || queryValue.length > 320 || /[\u0000-\u001f\u007f]/u.test(queryValue))
    ) {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid directory query.");
    }
    const state = input.state === "" ? undefined : input.state;
    if (state !== undefined && state !== "active" && state !== "deleted") {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid account state.");
    }
    const sort = input.sort ?? "registered_at";
    if (sort !== "registered_at" && sort !== "last_activity_at" && sort !== "display_name") {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid directory sort.");
    }
    const direction = input.direction ?? "desc";
    if (direction !== "asc" && direction !== "desc") {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid sort direction.");
    }
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid directory limit.");
    }
    const cursor = input.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 1024)) {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid directory cursor.");
    }
    const registeredFrom = operatorUtc(input.registeredFrom);
    const registeredTo = operatorUtc(input.registeredTo);
    const activityFrom = operatorUtc(input.activityFrom);
    const activityTo = operatorUtc(input.activityTo);
    const neverActive = operatorBoolean(input.neverActive);
    if (
      (registeredFrom !== undefined && registeredTo !== undefined &&
        Date.parse(registeredFrom) > Date.parse(registeredTo)) ||
      (activityFrom !== undefined && activityTo !== undefined &&
        Date.parse(activityFrom) > Date.parse(activityTo))
    ) {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid directory range.");
    }
    const query: Readonly<ServiceOperatorDirectoryQuery> = Object.freeze({
      ...(queryValue === undefined ? {} : { query: queryValue as string }),
      ...(state === undefined ? {} : { state }),
      ...(registeredFrom === undefined ? {} : { registeredFrom }),
      ...(registeredTo === undefined ? {} : { registeredTo }),
      ...(activityFrom === undefined ? {} : { activityFrom }),
      ...(activityTo === undefined ? {} : { activityTo }),
      ...(neverActive === undefined ? {} : { neverActive }),
      sort,
      direction,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    let page;
    try {
      page = await this.#store.listServiceOperatorPrincipals(query);
    } catch {
      throw new ServiceOperatorDirectoryFailure("invalid_request", "Invalid directory query.");
    }
    const occurredAt = Date.parse(actor.occurredAtUtc);
    const principals = await Promise.all(page.principals.map(async (principal) => {
      const credentials = await this.#tokens.listMcpTokenMetadata(principal.principalId);
      return Object.freeze({
        ...principal,
        activeMcpCredentialCount: credentials.filter(
          (token) => token.state === "active" && Date.parse(token.expiresAt) > occurredAt,
        ).length,
      });
    }));
    await this.#store.stageServiceOperatorDirectoryAudit({
      operatorPrincipalId: principalId,
      requestId: actor.requestId,
      auditEventId: this.#ids.nextAuditEventId(),
      auditOutboxMessageId: this.#ids.nextOutboxMessageId(),
      occurredAt: actor.occurredAtUtc,
    });
    return Object.freeze({ principals: Object.freeze(principals), nextCursor: page.nextCursor });
  }
}

export class ControlPrivacySafeObservability {
  readonly #sink: PrivacySafeObservabilitySink;
  readonly #clock: Clock;
  readonly #cohort: PilotCohort;

  constructor(dependencies: {
    readonly sink: PrivacySafeObservabilitySink;
    readonly clock: Clock;
    readonly cohort: PilotCohort;
  }) {
    this.#sink = dependencies.sink;
    this.#clock = dependencies.clock;
    this.#cohort = dependencies.cohort;
  }

  record(event: Readonly<ControlPrivacySafeEvent>): void {
    const occurredAtUtc = this.#clock.now();
    const outcome = controlOutcome(event.event);
    if (event.event.startsWith("invitation_")) {
      this.#emit({
        kind: "operational",
        metric: "invitation_outcome",
        surface: "control",
        operation: "invitation",
        outcome,
        unit: "count",
        value: 1,
        occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    } else if (event.event.startsWith("token_")) {
      this.#emit({
        kind: "operational",
        metric: "token_outcome",
        surface: "control",
        operation: "token",
        outcome,
        unit: "count",
        value: 1,
        occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    } else if (
      event.event.includes("delete") ||
      event.event.includes("deletion")
    ) {
      this.#emit({
        kind: "operational",
        metric: "deletion_outcome",
        surface: "control",
        operation: "deletion",
        outcome,
        unit: "count",
        value: 1,
        occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    } else if (
      outcome === "failure" ||
      outcome === "denied"
    ) {
      this.#emit({
        kind: "operational",
        metric: "request_error",
        surface: "control",
        operation: "request",
        outcome,
        unit: "count",
        value: 1,
        occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    }
    if (outcome === "conflict") {
      this.#emit({
        kind: "operational",
        metric: "cas_conflict",
        surface: "control",
        operation: "request",
        outcome: "conflict",
        unit: "count",
        value: 1,
        occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    }
    if (
      event.event === "account_bootstrap_succeeded" ||
      event.event === "account_bootstrap_replayed"
    ) {
      this.#emit({
        kind: "pilot",
        metric: "setup_completion",
        surface: "control",
        operation: "setup",
        outcome: event.event.endsWith("replayed") ? "replayed" : "completed",
        unit: "count",
        value: 1,
        occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: this.#cohort,
      });
    }
  }

  recordRetention(event: {
    readonly requestId: ActorContext["requestId"];
    readonly occurredAtUtc: UtcInstant;
    readonly week: 1 | 4;
    readonly retained: boolean;
    readonly count: number;
  }): void {
    this.#emit({
      kind: "pilot",
      metric: "retention",
      surface: "control",
      operation: event.week === 1 ? "retention_week_1" : "retention_week_4",
      outcome: event.retained ? "retained" : "unresolved",
      unit: "count",
      value: event.count,
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.requestId,
      jobId: null,
      cohort: this.#cohort,
    });
  }

  #emit(event: Readonly<PrivacySafeObservabilityEvent>): void {
    try {
      const pending = this.#sink.record(Object.freeze(event));
      if (
        typeof pending === "object" &&
        pending !== null &&
        "catch" in pending &&
        typeof pending.catch === "function"
      ) {
        void pending.catch(() => undefined);
      }
    } catch {
      // Telemetry is best-effort and never changes control outcomes.
    }
  }
}
