import type {
  AuditEventId,
  IdempotencyKey,
  MindUsageMode,
  OutboxMessageId,
  PrincipalId,
  PrincipalMindUsageGenerationId,
  PrincipalMindUsageState,
  RequestId,
  Sha256Digest,
  SpaceId,
  UtcInstant,
} from "@mind-diary/domain";
import type { MetadataStore } from "./runtime.js";

export interface PrincipalMindUsageIdGenerator {
  nextPrincipalMindUsageGenerationId(): PrincipalMindUsageGenerationId;
  nextPrincipalMindUsageAuditEventId(): AuditEventId;
  nextPrincipalMindUsageOutboxMessageId(): OutboxMessageId;
}

export interface SetPrincipalMindUsageModeRequest {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly usageMode: MindUsageMode;
  readonly expectedUsageVersion: number;
  readonly generationId: PrincipalMindUsageGenerationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly requestId: RequestId;
  readonly auditEventId: AuditEventId;
  readonly auditOutboxMessageId: OutboxMessageId;
  readonly occurredAt: UtcInstant;
}

export type SetPrincipalMindUsageModeResult =
  | {
      readonly kind: "applied";
      readonly state: Readonly<PrincipalMindUsageState>;
      readonly changed: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly kind:
        | "principal_not_found"
        | "mind_not_found"
        | "read_access_required"
        | "writer_access_required"
        | "description_required"
        | "usage_version_conflict"
        | "idempotency_conflict"
        | "generation_conflict"
        | "effect_conflict"
        | "invalid_record";
    };

export interface PrincipalMindUsageWritePin {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly generationId: PrincipalMindUsageGenerationId;
}

/** Read-only projection shared by ordinary reads and race-sensitive writes. */
export interface PrincipalMindUsageReader {
  readPrincipalMindUsage(
    principalId: PrincipalId,
  ): Promise<Readonly<PrincipalMindUsageState> | null>;
  validatePrincipalMindUsageWritePin(
    pin: Readonly<PrincipalMindUsageWritePin>,
  ): Promise<boolean>;
}

export interface PrincipalMindUsageTransaction extends PrincipalMindUsageReader {
  readonly kind: "principal-mind-usage-transaction";
  setPrincipalMindUsageMode(
    request: Readonly<SetPrincipalMindUsageModeRequest>,
  ): Promise<SetPrincipalMindUsageModeResult>;
}

export interface PrincipalMindUsageStore
  extends MetadataStore,
    PrincipalMindUsageReader {
  runPrincipalMindUsageTransaction<Result>(
    operation: (transaction: PrincipalMindUsageTransaction) => Promise<Result>,
  ): Promise<Result>;
}
