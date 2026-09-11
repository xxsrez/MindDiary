import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  ObjectStore,
  PrincipalMindUsageIdGenerator,
  PrincipalMindUsageStore,
  SetPrincipalMindUsageModeResult,
} from "@mind-diary/application-ports";
import {
  MIND_USAGE_MODES,
  idempotencyKey,
  type MindUsageMode,
  type PrincipalId,
  type PrincipalMindUsageState,
  type SpaceId,
} from "@mind-diary/domain";

const ENCODER = new TextEncoder();
const BOUNDED_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;

export interface PrincipalMindUsageDependencies {
  readonly usage: PrincipalMindUsageStore;
  readonly ids: PrincipalMindUsageIdGenerator;
  readonly digest: Pick<ObjectStore, "calculateSha256">;
}

export interface PrincipalMindUsageCommand {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly usageMode: MindUsageMode;
  readonly expectedUsageVersion: number;
  readonly idempotencyKey: string;
}

export type PrincipalMindUsageCommandResult =
  | SetPrincipalMindUsageModeResult
  | {
      readonly kind: "invalid";
      readonly code:
        | "sites_identity_required"
        | "invalid_mind"
        | "invalid_mode"
        | "invalid_usage_version"
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

/** Site-only application boundary for principal-owned Mind usage intent. */
export class PrincipalMindUsageApplicationService {
  readonly #usage: PrincipalMindUsageStore;
  readonly #ids: PrincipalMindUsageIdGenerator;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;

  constructor(dependencies: PrincipalMindUsageDependencies) {
    this.#usage = dependencies.usage;
    this.#ids = dependencies.ids;
    this.#digest = dependencies.digest;
  }

  async read(
    actor: ActorContext,
  ): Promise<Readonly<PrincipalMindUsageState> | null> {
    const principalId = sitesPrincipal(actor);
    return principalId === null
      ? null
      : this.#usage.readPrincipalMindUsage(principalId);
  }

  async mutate(
    command: Readonly<PrincipalMindUsageCommand>,
  ): Promise<PrincipalMindUsageCommandResult> {
    const principalId = sitesPrincipal(command.actor);
    if (principalId === null) {
      return Object.freeze({ kind: "invalid", code: "sites_identity_required" });
    }
    if (typeof command.spaceId !== "string" || !BOUNDED_ID.test(command.spaceId)) {
      return Object.freeze({ kind: "invalid", code: "invalid_mind" });
    }
    if (!MIND_USAGE_MODES.includes(command.usageMode)) {
      return Object.freeze({ kind: "invalid", code: "invalid_mode" });
    }
    if (
      !Number.isSafeInteger(command.expectedUsageVersion) ||
      command.expectedUsageVersion < 0
    ) {
      return Object.freeze({ kind: "invalid", code: "invalid_usage_version" });
    }
    if (
      typeof command.idempotencyKey !== "string" ||
      command.idempotencyKey.length === 0 ||
      ENCODER.encode(command.idempotencyKey).byteLength > 512
    ) {
      return Object.freeze({ kind: "invalid", code: "invalid_idempotency_key" });
    }

    const canonicalRequestHash = await this.#digest.calculateSha256(
      ENCODER.encode(`${JSON.stringify({
        contract: "principal-mind-usage/v3",
        principal: principalId,
        mind: command.spaceId,
        mode: command.usageMode,
        expected_usage_version: command.expectedUsageVersion,
      })}\n`),
    );
    const request = Object.freeze({
      principalId,
      spaceId: command.spaceId,
      usageMode: command.usageMode,
      expectedUsageVersion: command.expectedUsageVersion,
      generationId: this.#ids.nextPrincipalMindUsageGenerationId(),
      idempotencyKey: idempotencyKey(command.idempotencyKey),
      canonicalRequestHash,
      requestId: command.actor.requestId,
      auditEventId: this.#ids.nextPrincipalMindUsageAuditEventId(),
      auditOutboxMessageId: this.#ids.nextPrincipalMindUsageOutboxMessageId(),
      occurredAt: command.actor.occurredAtUtc,
    });
    return this.#usage.runPrincipalMindUsageTransaction((transaction) =>
      transaction.setPrincipalMindUsageMode(request));
  }
}
