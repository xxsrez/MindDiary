import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  ApplyCredentialWriteTargetResult,
  CredentialWriteTargetIdGenerator,
  CredentialWriteTargetSnapshot,
  CredentialWriteTargetStore,
  ObjectStore,
} from "@mind-diary/application-ports";
import {
  idempotencyKey,
  type CredentialWriteTargetGenerationId,
  type EffectiveTokenScopes,
  type MindBindingOwnerId,
  type PrincipalId,
  type SpaceId,
} from "@mind-diary/domain";

const ENCODER = new TextEncoder();
const BOUNDED_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;

export interface CredentialWriteTargetDependencies {
  readonly targets: CredentialWriteTargetStore;
  readonly ids: CredentialWriteTargetIdGenerator;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
}

export interface CredentialWriteTargetCaller {
  readonly actor: ActorContext;
  /** Resolved from server-side credential metadata, never from an MCP body. */
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly credentialScopes: EffectiveTokenScopes;
}

export type CredentialWriteTargetCommand = CredentialWriteTargetCaller &
  (
    | {
        readonly operation: "select";
        readonly spaceId: SpaceId;
        readonly expectedTargetVersion: number;
      }
    | {
        readonly operation: "clear";
        readonly expectedTargetVersion: number;
      }
    | {
        readonly operation: "configure_capture";
        readonly mode: "disabled" | "routine_non_sensitive";
        readonly expectedTargetVersion: number;
        readonly expectedGenerationId: CredentialWriteTargetGenerationId | null;
      }
    | {
        readonly operation: "upgrade_legacy";
        readonly credentialKind: "oauth_grant" | "personal_token";
      }
  ) & {
    readonly idempotencyKey: string;
  };

export type CredentialWriteTargetCommandResult =
  | ApplyCredentialWriteTargetResult
  | {
      readonly kind: "invalid";
      readonly code:
        | "sites_identity_required"
        | "invalid_owner"
        | "invalid_target"
        | "invalid_target_version"
        | "invalid_generation"
        | "invalid_idempotency_key";
    };

function sitesPrincipal(actor: ActorContext): PrincipalId | null {
  return actor?.kind === "registered_principal" &&
    actor.authentication.kind === "sites_identity" &&
    BOUNDED_ID.test(actor.principalId) &&
    Number.isFinite(Date.parse(actor.occurredAtUtc))
    ? actor.principalId
    : null;
}

export class CredentialWriteTargetApplicationService {
  readonly #targets: CredentialWriteTargetStore;
  readonly #ids: CredentialWriteTargetIdGenerator;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;

  constructor(dependencies: CredentialWriteTargetDependencies) {
    this.#targets = dependencies.targets;
    this.#ids = dependencies.ids;
    this.#digest = dependencies.digest;
  }

  async read(
    request: Readonly<CredentialWriteTargetCaller>,
  ): Promise<Readonly<CredentialWriteTargetSnapshot> | null> {
    const principalId = sitesPrincipal(request.actor);
    if (principalId === null || !BOUNDED_ID.test(request.bindingOwnerId)) return null;
    return this.#targets.readCredentialWriteTarget(
      request.bindingOwnerId,
      principalId,
    );
  }

  async mutate(
    command: Readonly<CredentialWriteTargetCommand>,
  ): Promise<CredentialWriteTargetCommandResult> {
    const principalId = sitesPrincipal(command.actor);
    if (principalId === null) {
      return Object.freeze({ kind: "invalid", code: "sites_identity_required" });
    }
    if (!BOUNDED_ID.test(command.bindingOwnerId)) {
      return Object.freeze({ kind: "invalid", code: "invalid_owner" });
    }
    if (
      "spaceId" in command &&
      (typeof command.spaceId !== "string" || !BOUNDED_ID.test(command.spaceId))
    ) return Object.freeze({ kind: "invalid", code: "invalid_target" });
    if (
      command.operation !== "upgrade_legacy" &&
      (!Number.isSafeInteger(command.expectedTargetVersion) ||
        command.expectedTargetVersion < 0)
    ) return Object.freeze({ kind: "invalid", code: "invalid_target_version" });
    if (
      command.operation === "configure_capture" &&
      command.expectedGenerationId !== null &&
      !BOUNDED_ID.test(command.expectedGenerationId)
    ) return Object.freeze({ kind: "invalid", code: "invalid_generation" });
    if (
      typeof command.idempotencyKey !== "string" ||
      command.idempotencyKey.length === 0 ||
      ENCODER.encode(command.idempotencyKey).byteLength > 512
    ) return Object.freeze({ kind: "invalid", code: "invalid_idempotency_key" });

    const canonical = JSON.stringify({
      contract: "credential-write-target/v1",
      owner: command.bindingOwnerId,
      principal: principalId,
      operation: command.operation,
      target: "spaceId" in command ? command.spaceId : null,
      targetVersion:
        command.operation === "upgrade_legacy" ? null : command.expectedTargetVersion,
      captureMode:
        command.operation === "configure_capture" ? command.mode : null,
      captureGeneration:
        command.operation === "configure_capture"
          ? command.expectedGenerationId
          : null,
      credentialKind:
        command.operation === "upgrade_legacy" ? command.credentialKind : null,
    });
    const canonicalRequestHash = await this.#digest.calculateSha256(
      ENCODER.encode(canonical),
    );
    const base = {
      bindingOwnerId: command.bindingOwnerId,
      principalId,
      idempotencyKey: idempotencyKey(command.idempotencyKey),
      canonicalRequestHash,
      requestId: command.actor.requestId,
      auditEventId: this.#ids.nextCredentialWriteTargetAuditEventId(),
      auditOutboxMessageId: this.#ids.nextCredentialWriteTargetOutboxMessageId(),
      occurredAt: command.actor.occurredAtUtc,
    };
    return this.#targets.runCredentialWriteTargetTransaction((transaction) => {
      if (command.operation === "select") {
        return transaction.applyCredentialWriteTarget({
          ...base,
          operation: "select",
          spaceId: command.spaceId,
          expectedTargetVersion: command.expectedTargetVersion,
          generationId: this.#ids.nextCredentialWriteTargetGenerationId(),
          credentialHasWriteScope: (command.credentialScopes as readonly string[]).includes("content:write"),
        });
      }
      if (command.operation === "clear") {
        return transaction.applyCredentialWriteTarget({
          ...base,
          operation: "clear",
          expectedTargetVersion: command.expectedTargetVersion,
        });
      }
      if (command.operation === "configure_capture") {
        return transaction.applyCredentialWriteTarget({
          ...base,
          operation: "configure_capture",
          mode: command.mode,
          expectedTargetVersion: command.expectedTargetVersion,
          expectedGenerationId: command.expectedGenerationId,
          credentialHasWriteScope: (command.credentialScopes as readonly string[]).includes("content:write"),
        });
      }
      return transaction.applyCredentialWriteTarget({
        ...base,
        operation: "upgrade_legacy",
        credentialKind: command.credentialKind,
        generationId: this.#ids.nextCredentialWriteTargetGenerationId(),
        credentialHasWriteScope: (command.credentialScopes as readonly string[]).includes("content:write"),
      });
    });
  }
}
