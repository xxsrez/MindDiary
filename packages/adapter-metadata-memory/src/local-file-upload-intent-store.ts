import type {
  ClaimLocalFileUploadIntentResult,
  CreateLocalFileUploadIntentResult,
  LocalFileUploadIntentRecord,
  LocalFileUploadIntentStore,
  MindBindingOwnerId,
  PrincipalId,
  StagedBundleFileId,
  UtcInstant,
} from "@mind-diary/application-ports";

function clone(
  record: Readonly<LocalFileUploadIntentRecord>,
): Readonly<LocalFileUploadIntentRecord> {
  return Object.freeze({ ...record });
}

function finiteInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

const RECORD_KEYS = new Set([
  "formatVersion", "intentId", "namespaceHash", "canonicalRequestHash",
  "principalId", "tokenId", "bindingOwnerId", "spaceId", "writeBindingId",
  "sourceKind", "displayFilename", "claimedMediaType", "expectedSize",
  "expectedSha256", "idempotencyKey", "state", "claimId", "leaseExpiresAt",
  "stagedFileId", "stageReplayed", "rejectionCode", "createdAt", "expiresAt",
  "consumedAt",
]);
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

function validFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.normalize("NFC") && !value.includes("/") &&
    !value.includes("\\") && value !== "." && value !== ".." &&
    !CONTROL.test(value) && new TextEncoder().encode(value).byteLength <= 255;
}

function validStored(record: Readonly<LocalFileUploadIntentRecord>): boolean {
  if (
    Object.keys(record).some((key) => !RECORD_KEYS.has(key)) ||
    Object.keys(record).length !== RECORD_KEYS.size ||
    record.formatVersion !== 1 ||
    !BOUNDED_ID.test(record.intentId) ||
    !SHA256.test(record.namespaceHash) ||
    !SHA256.test(record.canonicalRequestHash) ||
    !BOUNDED_ID.test(record.principalId) ||
    !BOUNDED_ID.test(record.tokenId) ||
    !BOUNDED_ID.test(record.bindingOwnerId) ||
    !BOUNDED_ID.test(record.spaceId) ||
    !BOUNDED_ID.test(record.writeBindingId) ||
    (record.sourceKind !== "local_path" &&
      record.sourceKind !== "workspace/generated_artifact") ||
    !validFilename(record.displayFilename) ||
    !MEDIA_TYPE.test(record.claimedMediaType) ||
    !Number.isSafeInteger(record.expectedSize) || record.expectedSize < 0 ||
    record.expectedSize > 268_435_456 ||
    !SHA256.test(record.expectedSha256) ||
    typeof record.idempotencyKey !== "string" ||
    record.idempotencyKey.length === 0 || CONTROL.test(record.idempotencyKey) ||
    new TextEncoder().encode(record.idempotencyKey).byteLength > 256 ||
    !finiteInstant(record.createdAt) || !finiteInstant(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.createdAt)
  ) return false;
  const emptyClaim = record.claimId === null && record.leaseExpiresAt === null;
  const emptyStage = record.stagedFileId === null && record.stageReplayed === null;
  if (record.state === "active") {
    return emptyClaim && emptyStage && record.rejectionCode === null &&
      record.consumedAt === null;
  }
  if (record.state === "consuming") {
    return typeof record.claimId === "string" && BOUNDED_ID.test(record.claimId) &&
      record.leaseExpiresAt !== null && finiteInstant(record.leaseExpiresAt) &&
      Date.parse(record.leaseExpiresAt) <= Date.parse(record.expiresAt) &&
      emptyStage && record.rejectionCode === null && record.consumedAt === null;
  }
  if (record.state === "consumed") {
    return emptyClaim && typeof record.stagedFileId === "string" &&
      BOUNDED_ID.test(record.stagedFileId) &&
      typeof record.stageReplayed === "boolean" &&
      record.rejectionCode === null && record.consumedAt !== null &&
      finiteInstant(record.consumedAt);
  }
  return record.state === "rejected" && emptyClaim && emptyStage &&
    typeof record.rejectionCode === "string" &&
    BOUNDED_ID.test(record.rejectionCode) && record.consumedAt !== null &&
    finiteInstant(record.consumedAt);
}

function validNew(record: Readonly<LocalFileUploadIntentRecord>): boolean {
  return validStored(record) &&
    record.state === "active" &&
    record.claimId === null;
}

function sameReplayIdentity(
  current: Readonly<LocalFileUploadIntentRecord>,
  incoming: Readonly<LocalFileUploadIntentRecord>,
): boolean {
  return current.namespaceHash === incoming.namespaceHash &&
    current.canonicalRequestHash === incoming.canonicalRequestHash &&
    current.principalId === incoming.principalId &&
    current.bindingOwnerId === incoming.bindingOwnerId &&
    current.spaceId === incoming.spaceId &&
    current.writeBindingId === incoming.writeBindingId &&
    current.sourceKind === incoming.sourceKind &&
    current.displayFilename === incoming.displayFilename &&
    current.claimedMediaType === incoming.claimedMediaType &&
    current.expectedSize === incoming.expectedSize &&
    current.expectedSha256 === incoming.expectedSha256 &&
    current.idempotencyKey === incoming.idempotencyKey;
}

/** Dedicated path-free metadata store for upload intents only. */
export class InMemoryLocalFileUploadIntentStore
  implements LocalFileUploadIntentStore {
  #records = new Map<string, Readonly<LocalFileUploadIntentRecord>>();
  #tail: Promise<void> = Promise.resolve();

  static fromDurableSnapshot(value: unknown): InMemoryLocalFileUploadIntentStore {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as { v?: unknown }).v !== 1 ||
      !((value as { records?: unknown }).records instanceof Map)
    ) throw new TypeError("upload intent durable snapshot is invalid");
    const restored = new InMemoryLocalFileUploadIntentStore();
    for (const [key, item] of (value as {
      records: Map<unknown, unknown>;
    }).records) {
      if (
        typeof key !== "string" ||
        typeof item !== "object" ||
        item === null ||
        (item as { intentId?: unknown }).intentId !== key ||
        !validStored(item as Readonly<LocalFileUploadIntentRecord>)
      ) throw new TypeError("upload intent durable snapshot is invalid");
      restored.#records.set(
        key,
        clone(item as Readonly<LocalFileUploadIntentRecord>),
      );
    }
    return restored;
  }

  exportDurableSnapshot(): unknown {
    return Object.freeze({ v: 1, records: new Map(this.#records) });
  }

  async #exclusive<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async readLocalFileUploadIntent(
    intentId: string,
  ): Promise<Readonly<LocalFileUploadIntentRecord> | null> {
    const record = this.#records.get(intentId);
    return record === undefined ? null : clone(record);
  }

  async createLocalFileUploadIntent(
    record: Readonly<LocalFileUploadIntentRecord>,
  ): Promise<CreateLocalFileUploadIntentResult> {
    return this.#exclusive(() => {
      if (!validNew(record)) {
        return Object.freeze({ kind: "conflict" as const });
      }
      const replay = [...this.#records.values()].find(
        (candidate) => candidate.namespaceHash === record.namespaceHash,
      );
      if (replay !== undefined) {
        if (!sameReplayIdentity(replay, record)) {
          return Object.freeze({ kind: "conflict" as const });
        }
        // Exact replay is grant-scoped, while OAuth access records rotate.
        // The already-authorized caller may refresh only the token reference;
        // the stable principal/grant/binding/body identity remains immutable.
        const current = replay.tokenId === record.tokenId ||
            Date.parse(replay.expiresAt) <= Date.parse(record.createdAt)
          ? replay
          : clone({ ...replay, tokenId: record.tokenId });
        if (current !== replay) this.#records.set(replay.intentId, current);
        return Object.freeze({ kind: "replayed" as const, record: clone(current) });
      }
      if (this.#records.has(record.intentId)) {
        return Object.freeze({ kind: "conflict" as const });
      }
      const stored = clone(record);
      this.#records.set(record.intentId, stored);
      return Object.freeze({ kind: "created" as const, record: stored });
    });
  }

  async claimLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    principalId: PrincipalId;
    bindingOwnerId: MindBindingOwnerId;
    claimId: string;
    occurredAt: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<ClaimLocalFileUploadIntentResult> {
    return this.#exclusive(() => {
      const current = this.#records.get(request.intentId);
      if (
        current === undefined ||
        current.principalId !== request.principalId ||
        current.bindingOwnerId !== request.bindingOwnerId ||
        !BOUNDED_ID.test(request.claimId)
      ) return Object.freeze({ kind: "not_found" as const });
      const now = Date.parse(request.occurredAt);
      const leaseExpiresAt = Date.parse(request.leaseExpiresAt);
      if (
        !Number.isFinite(now) || !Number.isFinite(leaseExpiresAt) ||
        leaseExpiresAt <= now ||
        leaseExpiresAt > Date.parse(current.expiresAt) ||
        Date.parse(current.expiresAt) <= now
      ) return Object.freeze({ kind: "expired" as const });
      if (current.state === "consumed") {
        return Object.freeze({ kind: "consumed" as const });
      }
      if (current.state === "rejected") {
        return Object.freeze({ kind: "rejected" as const });
      }
      if (
        current.state === "consuming" &&
        current.leaseExpiresAt !== null &&
        Date.parse(current.leaseExpiresAt) > now
      ) return Object.freeze({ kind: "busy" as const });
      const claimed = clone({
        ...current,
        state: "consuming",
        claimId: request.claimId,
        leaseExpiresAt: request.leaseExpiresAt,
      });
      this.#records.set(request.intentId, claimed);
      return Object.freeze({ kind: "claimed" as const, record: claimed });
    });
  }

  async renewLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    occurredAt: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<"renewed" | "claim_lost" | "expired" | "not_found"> {
    return this.#exclusive(() => {
      const current = this.#records.get(request.intentId);
      if (current === undefined) return "not_found";
      if (
        current.state !== "consuming" ||
        current.claimId !== request.claimId ||
        !BOUNDED_ID.test(request.claimId)
      ) return "claim_lost";
      const now = Date.parse(request.occurredAt);
      const requestedExpiry = Date.parse(request.leaseExpiresAt);
      const currentExpiry = current.leaseExpiresAt === null
        ? Number.NaN
        : Date.parse(current.leaseExpiresAt);
      if (!Number.isFinite(now) || Date.parse(current.expiresAt) <= now) {
        return "expired";
      }
      if (
        !Number.isFinite(requestedExpiry) ||
        requestedExpiry <= now ||
        requestedExpiry > Date.parse(current.expiresAt) ||
        !Number.isFinite(currentExpiry) ||
        currentExpiry <= now
      ) return "claim_lost";
      if (requestedExpiry > currentExpiry) {
        this.#records.set(
          request.intentId,
          clone({ ...current, leaseExpiresAt: request.leaseExpiresAt }),
        );
      }
      return "renewed";
    });
  }

  async completeLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    stagedFileId: StagedBundleFileId;
    replayed: boolean;
    completedAt: UtcInstant;
  }>): Promise<"completed" | "claim_lost" | "expired" | "not_found"> {
    return this.#exclusive(() => {
      const current = this.#records.get(request.intentId);
      if (current === undefined) return "not_found";
      if (
        current.state !== "consuming" ||
        current.claimId !== request.claimId ||
        !BOUNDED_ID.test(request.claimId) ||
        !BOUNDED_ID.test(request.stagedFileId)
      ) return "claim_lost";
      const completedAt = Date.parse(request.completedAt);
      if (
        !Number.isFinite(completedAt) ||
        Date.parse(current.expiresAt) <= completedAt
      ) return "expired";
      if (
        current.leaseExpiresAt === null ||
        Date.parse(current.leaseExpiresAt) <= completedAt
      ) return "claim_lost";
      this.#records.set(
        request.intentId,
        clone({
          ...current,
          state: "consumed",
          claimId: null,
          leaseExpiresAt: null,
          stagedFileId: request.stagedFileId,
          stageReplayed: request.replayed,
          consumedAt: request.completedAt,
        }),
      );
      return "completed";
    });
  }

  async rejectLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    code: string;
    rejectedAt: UtcInstant;
  }>): Promise<"rejected" | "claim_lost" | "not_found"> {
    return this.#exclusive(() => {
      const current = this.#records.get(request.intentId);
      if (current === undefined) return "not_found";
      if (
        current.state !== "consuming" ||
        current.claimId !== request.claimId ||
        !BOUNDED_ID.test(request.claimId) ||
        !BOUNDED_ID.test(request.code) ||
        !finiteInstant(request.rejectedAt)
      ) return "claim_lost";
      this.#records.set(
        request.intentId,
        clone({
          ...current,
          state: "rejected",
          claimId: null,
          leaseExpiresAt: null,
          rejectionCode: request.code,
          consumedAt: request.rejectedAt,
        }),
      );
      return "rejected";
    });
  }

  async releaseLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
  }>): Promise<"released" | "claim_lost" | "not_found"> {
    return this.#exclusive(() => {
      const current = this.#records.get(request.intentId);
      if (current === undefined) return "not_found";
      if (
        current.state !== "consuming" ||
        current.claimId !== request.claimId ||
        !BOUNDED_ID.test(request.claimId)
      ) return "claim_lost";
      this.#records.set(
        request.intentId,
        clone({
          ...current,
          state: "active",
          claimId: null,
          leaseExpiresAt: null,
        }),
      );
      return "released";
    });
  }

  async collectExpiredLocalFileUploadIntents(request: Readonly<{
    expiredBefore: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<LocalFileUploadIntentRecord>[]> {
    if (
      !finiteInstant(request.expiredBefore) ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    ) throw new TypeError("upload intent cleanup request is invalid");
    return Object.freeze(
      [...this.#records.values()]
        .filter(
          (record) =>
            Date.parse(record.expiresAt) <= Date.parse(request.expiredBefore),
        )
        .sort(
          (left, right) =>
            left.expiresAt.localeCompare(right.expiresAt) ||
            left.intentId.localeCompare(right.intentId),
        )
        .slice(0, request.limit)
        .map(clone),
    );
  }

  async deleteExpiredLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    expectedExpiresAt: UtcInstant;
    expiredBefore: UtcInstant;
  }>): Promise<boolean> {
    return this.#exclusive(() => {
      if (
        !finiteInstant(request.expectedExpiresAt) ||
        !finiteInstant(request.expiredBefore)
      ) return false;
      const current = this.#records.get(request.intentId);
      if (
        current === undefined ||
        current.expiresAt !== request.expectedExpiresAt ||
        Date.parse(current.expiresAt) > Date.parse(request.expiredBefore)
      ) return false;
      return this.#records.delete(request.intentId);
    });
  }
}
