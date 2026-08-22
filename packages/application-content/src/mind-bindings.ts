import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import {
  type ApplyMindBindingMutationResult,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizationStamp,
  type AuthorizationTransaction,
  type Authorizer,
  type MindBindingIdGenerator,
  type MindBindingSetSnapshot,
  type MindBindingStore,
  type ObjectStore,
} from "@mind-diary/application-ports";
import {
  bindingVersion,
  type BindingVersion,
  type IdempotencyKey,
  type MindBindingOwnerId,
  type PrincipalId,
  type SpaceId,
} from "@mind-diary/domain";
import {
  DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
  normalizeIdempotencyKeyMaxBytes,
  validateIdempotencyKey,
} from "./idempotency.js";

const ENCODER = new TextEncoder();
const BOUNDED_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;

export interface MindBindingApplicationDependencies {
  readonly authorizer: Authorizer;
  readonly bindings: MindBindingStore;
  readonly ids: MindBindingIdGenerator;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
  readonly idempotencyKeyMaxBytes?: number;
}

export interface ReadMindBindingsRequest {
  readonly actor: McpTokenActorContext;
}

export interface MutateReadMindBindingRequest {
  readonly actor: McpTokenActorContext;
  readonly action: "attach" | "detach";
  readonly spaceId: SpaceId;
  readonly expectedBindingVersion: unknown;
  readonly idempotencyKey: unknown;
}

export type MutateWriteMindBindingRequest =
  | {
      readonly actor: McpTokenActorContext;
      readonly action: "bind";
      readonly spaceId: SpaceId;
      readonly expectedBindingVersion: unknown;
      readonly idempotencyKey: unknown;
    }
  | {
      readonly actor: McpTokenActorContext;
      readonly action: "unbind";
      readonly expectedBindingVersion: unknown;
      readonly idempotencyKey: unknown;
    };

export type ReadMindBindingsResult =
  | {
      readonly kind: "ready";
      readonly bindings: Readonly<MindBindingSetSnapshot>;
    }
  | { readonly kind: "invalid_actor" | "binding_state_unavailable" };

export type MindBindingCommandResult =
  | ApplyMindBindingMutationResult
  | {
      readonly kind: "denied";
      readonly decision: Extract<
        Awaited<ReturnType<Authorizer["authorize"]>>,
        { readonly kind: "denied" }
      >;
    }
  | {
      readonly kind: "invalid";
      readonly code:
        | "invalid_actor"
        | "invalid_action"
        | "invalid_space_id"
        | "invalid_binding_version"
        | "invalid_idempotency_key";
    };

interface ValidatedMutation {
  readonly actor: McpTokenActorContext;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly expectedBindingVersion: BindingVersion;
  readonly idempotencyKey: IdempotencyKey;
}

function validActor(actor: unknown): actor is McpTokenActorContext {
  if (typeof actor !== "object" || actor === null) return false;
  const value = actor as Partial<McpTokenActorContext>;
  return (
    value.kind === "registered_principal" &&
    typeof value.principalId === "string" &&
    BOUNDED_ID.test(value.principalId) &&
    typeof value.authentication === "object" &&
    value.authentication !== null &&
    value.authentication.kind === "mcp_token" &&
    typeof value.authentication.bindingOwnerId === "string" &&
    BOUNDED_ID.test(value.authentication.bindingOwnerId) &&
    typeof value.occurredAtUtc === "string" &&
    Number.isFinite(Date.parse(value.occurredAtUtc))
  );
}

function validSpaceId(value: unknown): value is SpaceId {
  return typeof value === "string" && BOUNDED_ID.test(value);
}

function canonicalMutationSource(input: {
  readonly operation: "attach_read" | "detach_read" | "bind_write" | "unbind_write";
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId | null;
  readonly expectedBindingVersion: BindingVersion;
}): string {
  return `${JSON.stringify({
    format: "mind-diary-binding-mutation-v1",
    operation: input.operation,
    binding_owner_id: input.bindingOwnerId,
    principal_id: input.principalId,
    space_id: input.spaceId,
    expected_binding_version: input.expectedBindingVersion,
  })}\n`;
}

/**
 * Authoritative MCP binding use case. Persisted bindings contain identifiers
 * only; target authority is freshly checked before and inside attach/bind.
 */
export class MindBindingApplicationService {
  readonly #authorizer: Authorizer;
  readonly #bindings: MindBindingStore;
  readonly #ids: MindBindingIdGenerator;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #idempotencyKeyMaxBytes: number;

  constructor(dependencies: MindBindingApplicationDependencies) {
    this.#authorizer = dependencies.authorizer;
    this.#bindings = dependencies.bindings;
    this.#ids = dependencies.ids;
    this.#digest = dependencies.digest;
    this.#idempotencyKeyMaxBytes = normalizeIdempotencyKeyMaxBytes(
      dependencies.idempotencyKeyMaxBytes ?? DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
    );
  }

  async read(
    request: Readonly<ReadMindBindingsRequest>,
  ): Promise<ReadMindBindingsResult> {
    if (!validActor(request.actor)) {
      return Object.freeze({ kind: "invalid_actor" });
    }
    const snapshot = await this.#bindings.readMindBindingSet(
      request.actor.authentication.bindingOwnerId,
      request.actor.principalId,
      request.actor.occurredAtUtc,
    );
    return snapshot === null
      ? Object.freeze({ kind: "binding_state_unavailable" })
      : Object.freeze({ kind: "ready", bindings: snapshot });
  }

  async mutateRead(
    request: Readonly<MutateReadMindBindingRequest>,
  ): Promise<MindBindingCommandResult> {
    const validated = this.#validateMutation(request);
    if ("kind" in validated) return validated;
    if (request.action !== "attach" && request.action !== "detach") {
      return Object.freeze({ kind: "invalid", code: "invalid_action" });
    }
    if (!validSpaceId(request.spaceId)) {
      return Object.freeze({ kind: "invalid", code: "invalid_space_id" });
    }
    const operation = request.action === "attach" ? "attach_read" : "detach_read";
    const canonicalRequestHash = await this.#digest.calculateSha256(
      ENCODER.encode(
        canonicalMutationSource({
          operation,
          bindingOwnerId: validated.bindingOwnerId,
          principalId: validated.principalId,
          spaceId: request.spaceId,
          expectedBindingVersion: validated.expectedBindingVersion,
        }),
      ),
    );
    if (request.action === "detach") {
      const auditEventId = this.#ids.nextMindBindingAuditEventId();
      const auditOutboxMessageId = this.#ids.nextMindBindingOutboxMessageId();
      return this.#bindings.runMindBindingTransaction((transaction) =>
        transaction.applyReadMindBinding({
          ...validated,
          action: "detach",
          spaceId: request.spaceId,
          readBindingId: null,
          canonicalRequestHash,
          requestId: request.actor.requestId,
          auditEventId,
          auditOutboxMessageId,
          occurredAt: request.actor.occurredAtUtc,
        }),
      );
    }

    const authorizationRequest = Object.freeze({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:browse" as const,
      revisionMode: "head" as const,
    });
    const initial = await this.#authorizer.authorize(authorizationRequest);
    if (initial.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initial });
    }
    const readBindingId = this.#ids.nextReadMindBindingId();
    const auditEventId = this.#ids.nextMindBindingAuditEventId();
    const auditOutboxMessageId = this.#ids.nextMindBindingOutboxMessageId();
    return this.#bindings.runMindBindingTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction(
        authorizationRequest,
        transaction,
        initial.stamp,
      );
      if (current.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: current });
      }
      return transaction.applyReadMindBinding({
        ...validated,
        action: "attach",
        spaceId: request.spaceId,
        readBindingId,
        canonicalRequestHash,
        requestId: request.actor.requestId,
        auditEventId,
        auditOutboxMessageId,
        occurredAt: request.actor.occurredAtUtc,
      });
    });
  }

  async mutateWrite(
    request: Readonly<MutateWriteMindBindingRequest>,
  ): Promise<MindBindingCommandResult> {
    const validated = this.#validateMutation(request);
    if ("kind" in validated) return validated;
    if (request.action !== "bind" && request.action !== "unbind") {
      return Object.freeze({ kind: "invalid", code: "invalid_action" });
    }
    if (request.action === "bind" && !validSpaceId(request.spaceId)) {
      return Object.freeze({ kind: "invalid", code: "invalid_space_id" });
    }
    const spaceId = request.action === "bind" ? request.spaceId : null;
    const operation = request.action === "bind" ? "bind_write" : "unbind_write";
    const canonicalRequestHash = await this.#digest.calculateSha256(
      ENCODER.encode(
        canonicalMutationSource({
          operation,
          bindingOwnerId: validated.bindingOwnerId,
          principalId: validated.principalId,
          spaceId,
          expectedBindingVersion: validated.expectedBindingVersion,
        }),
      ),
    );
    if (request.action === "unbind") {
      const auditEventId = this.#ids.nextMindBindingAuditEventId();
      const auditOutboxMessageId = this.#ids.nextMindBindingOutboxMessageId();
      return this.#bindings.runMindBindingTransaction((transaction) =>
        transaction.applyWriteMindBinding({
          ...validated,
          action: "unbind",
          spaceId: null,
          writeBindingId: null,
          canonicalRequestHash,
          requestId: request.actor.requestId,
          auditEventId,
          auditOutboxMessageId,
          occurredAt: request.actor.occurredAtUtc,
        }),
      );
    }

    const authorizationRequest = Object.freeze({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:write" as const,
      revisionMode: "head" as const,
    });
    const initial = await this.#authorizer.authorize(authorizationRequest);
    if (initial.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initial });
    }
    const writeBindingId = this.#ids.nextWriteMindBindingId();
    const auditEventId = this.#ids.nextMindBindingAuditEventId();
    const auditOutboxMessageId = this.#ids.nextMindBindingOutboxMessageId();
    return this.#bindings.runMindBindingTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction(
        authorizationRequest,
        transaction,
        initial.stamp,
      );
      if (current.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: current });
      }
      return transaction.applyWriteMindBinding({
        ...validated,
        action: "bind",
        spaceId: request.spaceId,
        writeBindingId,
        canonicalRequestHash,
        requestId: request.actor.requestId,
        auditEventId,
        auditOutboxMessageId,
        occurredAt: request.actor.occurredAtUtc,
      });
    });
  }

  #validateMutation(request: {
    readonly actor: McpTokenActorContext;
    readonly expectedBindingVersion: unknown;
    readonly idempotencyKey: unknown;
  }): ValidatedMutation | Extract<MindBindingCommandResult, { readonly kind: "invalid" }> {
    if (!validActor(request.actor)) {
      return Object.freeze({ kind: "invalid", code: "invalid_actor" });
    }
    if (
      !Number.isSafeInteger(request.expectedBindingVersion) ||
      (request.expectedBindingVersion as number) < 0
    ) {
      return Object.freeze({ kind: "invalid", code: "invalid_binding_version" });
    }
    const key = validateIdempotencyKey(
      request.idempotencyKey,
      this.#idempotencyKeyMaxBytes,
    );
    if (key.kind === "invalid") {
      return Object.freeze({ kind: "invalid", code: "invalid_idempotency_key" });
    }
    return Object.freeze({
      actor: request.actor,
      bindingOwnerId: request.actor.authentication.bindingOwnerId,
      principalId: request.actor.principalId,
      expectedBindingVersion: bindingVersion(
        request.expectedBindingVersion as number,
      ),
      idempotencyKey: key.key,
    });
  }
}

type AllowedAuthorization = Extract<
  AuthorizationDecision,
  { readonly kind: "allowed" }
>;

function bindingDenied(
  code: Extract<
    AuthorizationDecision,
    { readonly kind: "denied" }
  >["code"],
  retryable = false,
): Extract<AuthorizationDecision, { readonly kind: "denied" }> {
  return Object.freeze({ kind: "denied", code, retryable });
}

/**
 * Enforces the binding owned by the authenticated MCP credential before any
 * Mind content authorization. Transactional rechecks fence rebind from commit
 * and export-start effects without turning discovery into an implicit attach.
 */
export class MindBindingContentAuthorizer implements Authorizer {
  readonly #delegate: Authorizer;
  readonly #bindings: MindBindingStore;

  constructor(dependencies: {
    readonly delegate: Authorizer;
    readonly bindings: MindBindingStore;
  }) {
    this.#delegate = dependencies.delegate;
    this.#bindings = dependencies.bindings;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const binding = await this.#authorizeBinding(this.#bindings, request);
    if (binding.kind === "denied") return binding;
    const authorization = await this.#delegate.authorize(request);
    return authorization.kind === "denied"
      ? authorization
      : this.#withBindingStamp(authorization, binding.bindingVersion);
  }

  async reauthorizeInTransaction(
    request: AuthorizationRequest,
    transaction: AuthorizationTransaction,
    expected: AuthorizationStamp,
  ): Promise<AuthorizationDecision> {
    if (transaction.readMindBindingSet === undefined) {
      return bindingDenied("binding_state_unavailable", true);
    }
    const readMindBindingSet = transaction.readMindBindingSet.bind(transaction);
    const binding = await this.#authorizeBinding(
      { readMindBindingSet },
      request,
    );
    if (binding.kind === "denied") return binding;
    if (
      expected.bindingVersion === undefined ||
      binding.bindingVersion !== expected.bindingVersion
    ) {
      return bindingDenied("authorization_state_changed", true);
    }
    const authorization = await this.#delegate.reauthorizeInTransaction(
      request,
      transaction,
      expected,
    );
    return authorization.kind === "denied"
      ? authorization
      : this.#withBindingStamp(authorization, binding.bindingVersion);
  }

  async #authorizeBinding(
    reader: Pick<MindBindingStore, "readMindBindingSet">,
    request: AuthorizationRequest,
  ): Promise<
    | { readonly kind: "allowed"; readonly bindingVersion: BindingVersion }
    | Extract<AuthorizationDecision, { readonly kind: "denied" }>
  > {
    const actor = request.actor;
    if (
      actor.kind !== "registered_principal" ||
      actor.authentication.kind !== "mcp_token"
    ) {
      return bindingDenied("authentication_required");
    }
    const bindingOwnerId = actor.authentication.bindingOwnerId;
    const snapshot = await reader.readMindBindingSet(
      bindingOwnerId,
      actor.principalId,
      actor.occurredAtUtc,
    );
    if (
      snapshot === null ||
      snapshot.bindingSet.bindingOwnerId !==
        bindingOwnerId ||
      snapshot.bindingSet.principalId !== actor.principalId
    ) {
      return bindingDenied("binding_state_unavailable", true);
    }
    if (snapshot.bindingSet.state !== "active") {
      return bindingDenied("binding_owner_revoked");
    }

    if (request.capability === "content:write") {
      const requirement = request.bindingRequirement;
      if (requirement?.kind !== "write") {
        return bindingDenied("write_binding_required");
      }
      const active = snapshot.writeBinding;
      if (active === null) return bindingDenied("write_binding_required");
      if (
        active.state !== "active" ||
        active.bindingOwnerId !== bindingOwnerId ||
        active.spaceId !== request.spaceId ||
        active.writeBindingId !== requirement.writeBindingId
      ) {
        return bindingDenied("write_binding_stale");
      }
    } else {
      const readIsActive = snapshot.readBindings.some(
        (binding) =>
          binding.state === "active" &&
          binding.bindingOwnerId === bindingOwnerId &&
          binding.spaceId === request.spaceId,
      );
      const writeIsActive =
        snapshot.writeBinding !== null &&
        snapshot.writeBinding.state === "active" &&
        snapshot.writeBinding.bindingOwnerId === bindingOwnerId &&
        snapshot.writeBinding.spaceId === request.spaceId;
      if (!readIsActive && !writeIsActive) {
        return bindingDenied("mind_binding_required");
      }
    }
    return Object.freeze({
      kind: "allowed" as const,
      bindingVersion: snapshot.bindingSet.bindingVersion,
    });
  }

  #withBindingStamp(
    authorization: AllowedAuthorization,
    bindingVersionValue: BindingVersion,
  ): AuthorizationDecision {
    return Object.freeze({
      ...authorization,
      stamp: Object.freeze({
        ...authorization.stamp,
        bindingVersion: bindingVersionValue,
      }),
    });
  }
}
