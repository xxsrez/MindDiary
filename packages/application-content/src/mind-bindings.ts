import type {
  McpTokenActorContext,
  RegisteredPrincipalActorContext,
} from "@mind-diary/application-contracts";
import {
  type ApplyMindBindingMutationResult,
  type ApplyCredentialWriteTargetResult,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizationStamp,
  type AuthorizationTransaction,
  type Authorizer,
  type MindBindingIdGenerator,
  type MindBindingSetSnapshot,
  type MindBindingStore,
  type CredentialWriteTargetStore,
  type ObjectStore,
} from "@mind-diary/application-ports";
import {
  bindingVersion,
  type BindingVersion,
  type CredentialWriteTargetGenerationId,
  type CredentialWriteTargetState,
  type EffectiveTokenScopes,
  type IdempotencyKey,
  type MindBindingOwnerId,
  type PrincipalId,
  type SpaceId,
  type WriteMindBindingId,
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
  readonly bindings: MindBindingStore & CredentialWriteTargetStore;
  /** Explicit transition gate: a runtime never consults both write authorities. */
  readonly writeAuthority: "credential_write_target" | "legacy_mind_binding";
  readonly ids: MindBindingIdGenerator;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
  readonly idempotencyKeyMaxBytes?: number;
}

export type SitesIdentityActorContext = Extract<
  RegisteredPrincipalActorContext,
  { readonly authentication: { readonly kind: "sites_identity" } }
>;

type MindBindingCaller =
  | {
      readonly actor: McpTokenActorContext;
      readonly bindingOwnerId?: never;
      readonly credentialScopes?: never;
    }
  | {
      readonly actor: SitesIdentityActorContext;
      /** Server-resolved credential locator; never accepted from an MCP body. */
      readonly bindingOwnerId: MindBindingOwnerId;
      /** Server-read current grant/token scopes for this exact owner. */
      readonly credentialScopes: EffectiveTokenScopes;
    };

export type ReadMindBindingsRequest = MindBindingCaller;

export type MutateReadMindBindingRequest = MindBindingCaller & {
  readonly action: "attach" | "detach";
  readonly spaceId: SpaceId;
  readonly expectedBindingVersion: unknown;
  readonly idempotencyKey: unknown;
};

export type MutateWriteMindBindingRequest =
  | (MindBindingCaller & {
      readonly action: "bind";
      readonly spaceId: SpaceId;
      readonly expectedBindingVersion: unknown;
      readonly idempotencyKey: unknown;
    })
  | (MindBindingCaller & {
      readonly action: "unbind";
      readonly expectedBindingVersion: unknown;
      readonly idempotencyKey: unknown;
    });

export type MutateAutomaticCapturePolicyRequest = MindBindingCaller & {
  readonly action: "enable" | "disable";
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
      readonly kind:
        | "capture_target_visibility_blocked"
        | "write_binding_required"
        | "write_binding_stale";
    }
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
  readonly actor: RegisteredPrincipalActorContext;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly principalId: PrincipalId;
  readonly effectiveScopes: EffectiveTokenScopes;
  readonly expectedBindingVersion: BindingVersion;
  readonly idempotencyKey: IdempotencyKey;
}

function validScopes(value: unknown): value is EffectiveTokenScopes {
  return Array.isArray(value) && (
    (value.length === 1 && value[0] === "content:read") ||
    (value.length === 2 &&
      value[0] === "content:read" &&
      value[1] === "content:write")
  );
}

function hasScope(
  scopes: EffectiveTokenScopes,
  scope: "content:read" | "content:write",
): boolean {
  return (scopes as readonly string[]).includes(scope);
}

function validMcpActor(actor: unknown): actor is McpTokenActorContext {
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
    typeof value.authentication.tokenId === "string" &&
    BOUNDED_ID.test(value.authentication.tokenId) &&
    validScopes(value.authentication.effectiveScopes) &&
    typeof value.occurredAtUtc === "string" &&
    Number.isFinite(Date.parse(value.occurredAtUtc))
  );
}

function validatedCaller(
  request: Readonly<MindBindingCaller>,
): Pick<
  ValidatedMutation,
  "actor" | "bindingOwnerId" | "principalId" | "effectiveScopes"
> | null {
  if (validMcpActor(request.actor)) {
    return Object.freeze({
      actor: request.actor,
      bindingOwnerId: request.actor.authentication.bindingOwnerId,
      principalId: request.actor.principalId,
      effectiveScopes: request.actor.authentication.effectiveScopes,
    });
  }
  const actor = request.actor as Partial<SitesIdentityActorContext>;
  if (
    actor.kind !== "registered_principal" ||
    typeof actor.principalId !== "string" ||
    !BOUNDED_ID.test(actor.principalId) ||
    actor.authentication?.kind !== "sites_identity" ||
    typeof request.bindingOwnerId !== "string" ||
    !BOUNDED_ID.test(request.bindingOwnerId) ||
    !validScopes(request.credentialScopes) ||
    typeof actor.occurredAtUtc !== "string" ||
    !Number.isFinite(Date.parse(actor.occurredAtUtc))
  ) return null;
  return Object.freeze({
    actor: request.actor,
    bindingOwnerId: request.bindingOwnerId,
    principalId: actor.principalId as PrincipalId,
    effectiveScopes: request.credentialScopes,
  });
}

function validSpaceId(value: unknown): value is SpaceId {
  return typeof value === "string" && BOUNDED_ID.test(value);
}

function canonicalMutationSource(input: {
  readonly operation:
    | "attach_read"
    | "detach_read"
    | "bind_write"
    | "unbind_write"
    | "enable_capture"
    | "disable_capture";
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

function legacyProjectionFromCredentialTarget(
  state: Readonly<CredentialWriteTargetState>,
): Readonly<MindBindingSetSnapshot> {
  const active = state.lifecycleState === "active"
    ? state.activeGeneration
    : null;
  return Object.freeze({
    bindingSet: Object.freeze({
      bindingOwnerId: state.bindingOwnerId,
      principalId: state.principalId,
      state: state.lifecycleState === "active" ? "active" as const : "revoked" as const,
      bindingVersion: state.targetVersion,
      automaticCaptureMode: state.automaticCaptureMode,
      captureWriteBindingId:
        state.captureGenerationId as unknown as WriteMindBindingId | null,
      captureUpdatedAt:
        state.automaticCaptureMode === "disabled" ? null : state.updatedAt,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    }),
    readBindings: Object.freeze([]),
    writeBinding: active === null
      ? null
      : Object.freeze({
          writeBindingId: active.generationId as unknown as WriteMindBindingId,
          bindingOwnerId: state.bindingOwnerId,
          spaceId: active.spaceId,
          generation: state.targetVersion,
          state: "active" as const,
          createdAt: active.selectedAt,
          invalidatedAt: null,
        }),
  });
}

/**
 * Authoritative MCP binding use case. Persisted bindings contain identifiers
 * only; target authority is freshly checked before and inside attach/bind.
 */
export class MindBindingApplicationService {
  readonly #authorizer: Authorizer;
  readonly #bindings: MindBindingStore & CredentialWriteTargetStore;
  readonly #writeAuthority: MindBindingApplicationDependencies["writeAuthority"];
  readonly #ids: MindBindingIdGenerator;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #idempotencyKeyMaxBytes: number;

  constructor(dependencies: MindBindingApplicationDependencies) {
    if (
      dependencies.writeAuthority !== "credential_write_target" &&
      dependencies.writeAuthority !== "legacy_mind_binding"
    ) throw new TypeError("Mind binding write authority must be explicit.");
    this.#authorizer = dependencies.authorizer;
    this.#bindings = dependencies.bindings;
    this.#writeAuthority = dependencies.writeAuthority;
    this.#ids = dependencies.ids;
    this.#digest = dependencies.digest;
    this.#idempotencyKeyMaxBytes = normalizeIdempotencyKeyMaxBytes(
      dependencies.idempotencyKeyMaxBytes ?? DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
    );
  }

  async read(
    request: Readonly<ReadMindBindingsRequest>,
  ): Promise<ReadMindBindingsResult> {
    const caller = validatedCaller(request);
    if (caller === null) {
      return Object.freeze({ kind: "invalid_actor" });
    }
    const snapshot = await this.#bindings.readMindBindingSet(
      caller.bindingOwnerId,
      caller.principalId,
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
    if (!hasScope(validated.effectiveScopes, "content:read")) {
      return Object.freeze({ kind: "denied", decision: bindingDenied("insufficient_scope") });
    }
    if (request.action !== "attach" && request.action !== "detach") {
      return Object.freeze({ kind: "invalid", code: "invalid_action" });
    }
    if (this.#writeAuthority === "credential_write_target") {
      // Reads use current ACL in the new profile. The legacy command remains
      // fail-closed until its protocol surface is removed separately.
      return Object.freeze({ kind: "binding_owner_revoked" });
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
    if (!hasScope(validated.effectiveScopes, "content:write")) {
      return Object.freeze({ kind: "denied", decision: bindingDenied("insufficient_scope") });
    }
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
    if (this.#writeAuthority === "credential_write_target") {
      const targetProfile = await this.#bindings.readCredentialWriteTarget(
        validated.bindingOwnerId,
        validated.principalId,
      );
      if (targetProfile?.kind !== "current") {
        return Object.freeze({ kind: "binding_owner_revoked" });
      }
      return this.#mutateCredentialWrite(
        request,
        validated,
        targetProfile.state,
        canonicalRequestHash,
      );
    }
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

  async #mutateCredentialWrite(
    request: Readonly<MutateWriteMindBindingRequest>,
    validated: ValidatedMutation,
    before: Readonly<CredentialWriteTargetState>,
    canonicalRequestHash: Awaited<ReturnType<ObjectStore["calculateSha256"]>>,
  ): Promise<MindBindingCommandResult> {
    const auditEventId = this.#ids.nextMindBindingAuditEventId();
    const auditOutboxMessageId = this.#ids.nextMindBindingOutboxMessageId();
    if (request.action === "unbind") {
      const result = await this.#bindings.runCredentialWriteTargetTransaction(
        (transaction) => transaction.applyCredentialWriteTarget({
          bindingOwnerId: validated.bindingOwnerId,
          principalId: validated.principalId,
          operation: "clear",
          expectedTargetVersion: validated.expectedBindingVersion,
          idempotencyKey: validated.idempotencyKey,
          canonicalRequestHash,
          requestId: request.actor.requestId,
          auditEventId,
          auditOutboxMessageId,
          occurredAt: request.actor.occurredAtUtc,
        }),
      );
      return this.#mapCredentialTargetResult(result, before, validated);
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
    const generationId = this.#ids.nextWriteMindBindingId() as unknown as
      CredentialWriteTargetGenerationId;
    const result = await this.#bindings.runCredentialWriteTargetTransaction(
      (transaction) => transaction.applyCredentialWriteTarget({
        bindingOwnerId: validated.bindingOwnerId,
        principalId: validated.principalId,
        operation: "select",
        spaceId: request.spaceId,
        expectedTargetVersion: validated.expectedBindingVersion,
        generationId,
        credentialHasWriteScope: true,
        idempotencyKey: validated.idempotencyKey,
        canonicalRequestHash,
        requestId: request.actor.requestId,
        auditEventId,
        auditOutboxMessageId,
        occurredAt: request.actor.occurredAtUtc,
      }),
    );
    return this.#mapCredentialTargetResult(result, before, validated);
  }

  async #mapCredentialTargetResult(
    result: ApplyCredentialWriteTargetResult,
    before: Readonly<CredentialWriteTargetState>,
    validated: ValidatedMutation,
    includePreviousWriteBinding = true,
  ): Promise<MindBindingCommandResult> {
    if (result.kind === "applied") {
      const priorWrite = legacyProjectionFromCredentialTarget(before).writeBinding;
      const previousWriteBinding =
        includePreviousWriteBinding &&
        result.changed &&
        priorWrite !== null &&
        priorWrite.writeBindingId !==
          (result.state.activeGeneration?.generationId as unknown as
            WriteMindBindingId | undefined)
          ? Object.freeze({
              ...priorWrite,
              state: "invalidated" as const,
              invalidatedAt: result.state.updatedAt,
            })
          : null;
      return Object.freeze({
        kind: "applied" as const,
        bindings: legacyProjectionFromCredentialTarget(result.state),
        previousWriteBinding,
        changed: result.changed,
        replayed: result.replayed,
      });
    }
    if (result.kind === "target_version_conflict") {
      const current = await this.#bindings.readCredentialWriteTarget(
        validated.bindingOwnerId,
        validated.principalId,
      );
      return Object.freeze({
        kind: "binding_version_conflict" as const,
        currentBindingVersion: bindingVersion(
          current?.kind === "current" ? current.state.targetVersion : 0,
        ),
      });
    }
    if (result.kind === "idempotency_conflict") {
      return Object.freeze({ kind: "idempotency_conflict" });
    }
    if (result.kind === "effect_conflict") {
      return Object.freeze({ kind: "effect_conflict" });
    }
    if (result.kind === "owner_mismatch") {
      return Object.freeze({ kind: "owner_mismatch" });
    }
    if (result.kind === "invalid_record") {
      return Object.freeze({ kind: "invalid_record" });
    }
    if (result.kind === "write_scope_required") {
      return Object.freeze({
        kind: "denied",
        decision: bindingDenied("insufficient_scope"),
      });
    }
    if (result.kind === "writer_access_required") {
      return Object.freeze({
        kind: "denied",
        decision: bindingDenied("capability_denied"),
      });
    }
    if (result.kind === "generation_mismatch") {
      return Object.freeze({ kind: "write_binding_stale" });
    }
    return Object.freeze({ kind: "binding_owner_revoked" });
  }

  async mutateAutomaticCapture(
    request: Readonly<MutateAutomaticCapturePolicyRequest>,
  ): Promise<MindBindingCommandResult> {
    const validated = this.#validateMutation(request);
    if ("kind" in validated) return validated;
    if (!hasScope(validated.effectiveScopes, "content:write")) {
      return Object.freeze({ kind: "denied", decision: bindingDenied("insufficient_scope") });
    }
    if (request.action !== "enable" && request.action !== "disable") {
      return Object.freeze({ kind: "invalid", code: "invalid_action" });
    }
    const targetProfile = this.#writeAuthority === "credential_write_target"
      ? await this.#bindings.readCredentialWriteTarget(
          validated.bindingOwnerId,
          validated.principalId,
        )
      : null;
    if (
      this.#writeAuthority === "credential_write_target" &&
      targetProfile?.kind !== "current"
    ) return Object.freeze({ kind: "binding_owner_revoked" });
    const current = await this.#bindings.readMindBindingSet(
      validated.bindingOwnerId,
      validated.principalId,
      request.actor.occurredAtUtc,
    );
    if (current === null) {
      return Object.freeze({ kind: "invalid", code: "invalid_actor" });
    }
    const active = current.writeBinding;
    if (request.action === "enable" && active === null) {
      return Object.freeze({ kind: "write_binding_required" });
    }
    if (
      request.action === "enable" &&
      (active?.state !== "active" || active.bindingOwnerId !== validated.bindingOwnerId)
    ) {
      return Object.freeze({ kind: "write_binding_stale" });
    }
    const spaceId = active?.spaceId ?? null;
    const operation = request.action === "enable" ? "enable_capture" : "disable_capture";
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
    const auditEventId = this.#ids.nextMindBindingAuditEventId();
    const auditOutboxMessageId = this.#ids.nextMindBindingOutboxMessageId();
    if (request.action === "disable") {
      if (targetProfile?.kind === "current") {
        const result = await this.#bindings.runCredentialWriteTargetTransaction(
          (transaction) => transaction.applyCredentialWriteTarget({
            bindingOwnerId: validated.bindingOwnerId,
            principalId: validated.principalId,
            operation: "configure_capture",
            mode: "disabled",
            expectedTargetVersion: validated.expectedBindingVersion,
            expectedGenerationId: null,
            credentialHasWriteScope: true,
            idempotencyKey: validated.idempotencyKey,
            canonicalRequestHash,
            requestId: request.actor.requestId,
            auditEventId,
            auditOutboxMessageId,
            occurredAt: request.actor.occurredAtUtc,
          }),
        );
        return this.#mapCredentialTargetResult(
          result,
          targetProfile.state,
          validated,
          false,
        );
      }
      return this.#bindings.runMindBindingTransaction((transaction) =>
        transaction.applyAutomaticCapturePolicy({
          ...validated,
          action: "disable",
          mode: "disabled",
          spaceId,
          writeBindingId: null,
          canonicalRequestHash,
          requestId: request.actor.requestId,
          auditEventId,
          auditOutboxMessageId,
          occurredAt: request.actor.occurredAtUtc,
        }),
      );
    }
    if (active === null) return Object.freeze({ kind: "write_binding_required" });
    const authorizationState = await this.#bindings.readCurrentAuthorizationState({
      principalId: validated.principalId,
      spaceId: active.spaceId,
      tokenId: request.actor.authentication.kind === "mcp_token"
        ? request.actor.authentication.tokenId
        : null,
    });
    if (authorizationState?.space.visibility !== "private") {
      return Object.freeze({ kind: "capture_target_visibility_blocked" });
    }
    const authorizationRequest = Object.freeze({
      actor: request.actor,
      spaceId: active.spaceId,
      capability: "content:write" as const,
      revisionMode: "head" as const,
      bindingRequirement: Object.freeze({
        kind: "write" as const,
        writeBindingId: active.writeBindingId,
      }),
    });
    const initial = await this.#authorizer.authorize(authorizationRequest);
    if (initial.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initial });
    }
    if (targetProfile?.kind === "current") {
      const result = await this.#bindings.runCredentialWriteTargetTransaction(
        (transaction) => transaction.applyCredentialWriteTarget({
          bindingOwnerId: validated.bindingOwnerId,
          principalId: validated.principalId,
          operation: "configure_capture",
          mode: "routine_non_sensitive",
          expectedTargetVersion: validated.expectedBindingVersion,
          expectedGenerationId:
            active.writeBindingId as unknown as CredentialWriteTargetGenerationId,
          credentialHasWriteScope: true,
          idempotencyKey: validated.idempotencyKey,
          canonicalRequestHash,
          requestId: request.actor.requestId,
          auditEventId,
          auditOutboxMessageId,
          occurredAt: request.actor.occurredAtUtc,
        }),
      );
      return this.#mapCredentialTargetResult(
        result,
        targetProfile.state,
        validated,
        false,
      );
    }
    return this.#bindings.runMindBindingTransaction(async (transaction) => {
      const fresh = await this.#authorizer.reauthorizeInTransaction(
        authorizationRequest,
        transaction,
        initial.stamp,
      );
      if (fresh.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: fresh });
      }
      return transaction.applyAutomaticCapturePolicy({
        ...validated,
        action: "enable",
        mode: "routine_non_sensitive",
        spaceId: active.spaceId,
        writeBindingId: active.writeBindingId,
        canonicalRequestHash,
        requestId: request.actor.requestId,
        auditEventId,
        auditOutboxMessageId,
        occurredAt: request.actor.occurredAtUtc,
      });
    });
  }

  #validateMutation(request: {
    readonly actor: RegisteredPrincipalActorContext;
    readonly bindingOwnerId?: MindBindingOwnerId;
    readonly credentialScopes?: EffectiveTokenScopes;
    readonly expectedBindingVersion: unknown;
    readonly idempotencyKey: unknown;
  }): ValidatedMutation | Extract<MindBindingCommandResult, { readonly kind: "invalid" }> {
    const caller = validatedCaller(request as MindBindingCaller);
    if (caller === null) {
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
      actor: caller.actor,
      bindingOwnerId: caller.bindingOwnerId,
      principalId: caller.principalId,
      effectiveScopes: caller.effectiveScopes,
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
 * Uses current ACL directly for reads in the new profile and enforces the
 * credential-owned generation for writes. Transactional rechecks fence rebind
 * from commit and export-start effects.
 */
export class MindBindingContentAuthorizer implements Authorizer {
  readonly #delegate: Authorizer;
  readonly #bindings: MindBindingStore;
  readonly #readAuthority: "current_acl" | "legacy_mind_binding";
  readonly #consistentRead:
    | (<Result>(operation: (dependencies: Readonly<{
        delegate: Authorizer;
        bindings: Pick<MindBindingStore, "readMindBindingSet">;
      }>) => Promise<Result>) => Promise<Result>)
    | undefined;

  constructor(dependencies: {
    readonly delegate: Authorizer;
    readonly bindings: MindBindingStore;
    readonly readAuthority: "current_acl" | "legacy_mind_binding";
    readonly consistentRead?: <Result>(operation: (dependencies: Readonly<{
      delegate: Authorizer;
      bindings: Pick<MindBindingStore, "readMindBindingSet">;
    }>) => Promise<Result>) => Promise<Result>;
  }) {
    if (
      dependencies.readAuthority !== "current_acl" &&
      dependencies.readAuthority !== "legacy_mind_binding"
    ) throw new TypeError("Mind content read authority must be explicit.");
    this.#delegate = dependencies.delegate;
    this.#bindings = dependencies.bindings;
    this.#readAuthority = dependencies.readAuthority;
    this.#consistentRead = dependencies.consistentRead;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    if (this.#consistentRead !== undefined) {
      return this.#consistentRead(({ bindings, delegate }) =>
        this.#authorizeWith(bindings, delegate, request));
    }
    return this.#authorizeWith(this.#bindings, this.#delegate, request);
  }

  async #authorizeWith(
    bindings: Pick<MindBindingStore, "readMindBindingSet">,
    delegate: Authorizer,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    if (
      this.#readAuthority === "current_acl" &&
      request.capability !== "content:write"
    ) return delegate.authorize(request);
    const binding = await this.#authorizeBinding(bindings, request);
    if (binding.kind === "denied") return binding;
    const authorization = await delegate.authorize(request);
    return authorization.kind === "denied"
      ? authorization
      : this.#withBindingStamp(authorization, binding.bindingVersion);
  }

  async reauthorizeInTransaction(
    request: AuthorizationRequest,
    transaction: AuthorizationTransaction,
    expected: AuthorizationStamp,
  ): Promise<AuthorizationDecision> {
    if (
      this.#readAuthority === "current_acl" &&
      request.capability !== "content:write"
    ) {
      return this.#delegate.reauthorizeInTransaction(
        request,
        transaction,
        expected,
      );
    }
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
      if (
        requirement?.kind !== "write" &&
        requirement?.kind !== "automatic_capture"
      ) {
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
      if (requirement.kind === "automatic_capture") {
        if (
          snapshot.bindingSet.bindingVersion !== requirement.expectedBindingVersion ||
          snapshot.bindingSet.automaticCaptureMode !== "routine_non_sensitive" ||
          snapshot.bindingSet.captureWriteBindingId !== requirement.writeBindingId
        ) {
          return bindingDenied("authorization_state_changed", true);
        }
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
