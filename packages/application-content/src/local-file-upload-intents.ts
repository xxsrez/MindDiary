import type {
  McpTokenActorContext,
  RequestId,
} from "@mind-diary/application-contracts";
import type {
  Authorizer,
  BundleFileStagingStore,
  Clock,
  LocalFileUploadIntentRecord,
  LocalFileUploadIntentSourceKind,
  LocalFileUploadIntentStore,
  ObjectStore,
  PrincipalMindUsageReader,
  PrincipalMindUsageWritePin,
} from "@mind-diary/application-ports";
import {
  principalMindUsageWriteGeneration,
  type Capability,
  type IdempotencyKey,
  type PrincipalMindUsageGenerationId,
  type Sha256Digest,
  type SpaceId,
  type StagedBundleFileId,
  type UtcInstant,
} from "@mind-diary/domain";
import {
  type BundleFileStagingService,
  type StageBundleFileStreamResult,
} from "./bundle-files.js";
import { validateIdempotencyKey } from "./idempotency.js";

export const LOCAL_FILE_UPLOAD_INTENT_LIMITS = Object.freeze({
  ttlMilliseconds: 10 * 60 * 1_000,
  consumeLeaseMilliseconds: 30 * 1_000,
  leaseHeartbeatMilliseconds: 10 * 1_000,
  maxBytes: 268_435_456,
  cleanupSafetyMilliseconds: 24 * 60 * 60 * 1_000,
  cleanupMaxRecords: 100,
});

const CAPABILITY_MAC_BASE64URL_LENGTH = 43;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPE_ESSENCE =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const CREATE_KEYS = new Set([
  "source_kind",
  "display_filename",
  "claimed_media_type",
  "expected_size",
  "expected_sha256",
  "idempotency_key",
]);

export interface LocalFileUploadIntentSecretCodec {
  issue(intentId: string): Promise<string>;
  verify(candidate: unknown): Promise<string | null>;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Domain-separated HMAC capability; durable state contains no usable secret. */
export async function createLocalFileUploadIntentSecretCodec(
  keyBytes: Uint8Array,
): Promise<LocalFileUploadIntentSecretCodec> {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength < 32) {
    throw new TypeError("upload intent key must contain at least 256 bits");
  }
  const owned = Uint8Array.from(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    owned,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  owned.fill(0);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const message = (payload: string) =>
    encoder.encode(`mind-diary-upload-intent-v1\0${payload}`);
  return Object.freeze({
    async issue(intentId: string): Promise<string> {
      if (!BOUNDED_ID.test(intentId)) {
        throw new TypeError("upload intent ID is invalid");
      }
      const payload = base64Url(encoder.encode(intentId));
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message(payload)));
      return `mdupload_v1_${payload}${base64Url(mac)}`;
    },
    async verify(candidate: unknown): Promise<string | null> {
      if (typeof candidate !== "string" || candidate.length > 1024) return null;
      const match = /^mdupload_v1_([A-Za-z0-9_-]{44,})$/u.exec(candidate);
      if (match === null) return null;
      const encoded = match[1]!;
      const payload = encoded.slice(0, -CAPABILITY_MAC_BASE64URL_LENGTH);
      const supplied = fromBase64Url(encoded.slice(-CAPABILITY_MAC_BASE64URL_LENGTH));
      if (supplied === null || supplied.byteLength !== 32) return null;
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(supplied).buffer,
        message(payload),
      );
      if (!valid) return null;
      const decoded = fromBase64Url(payload);
      if (decoded === null) return null;
      try {
        const intentId = decoder.decode(decoded);
        return BOUNDED_ID.test(intentId) ? intentId : null;
      } catch {
        return null;
      }
    },
  });
}

export type LocalFileUploadIntentFailureCode =
  | "invalid_request"
  | "insufficient_scope"
  | "writable_mind_required"
  | "writable_mind_stale"
  | "file_ingress_intent_expired"
  | "file_ingress_intent_conflict"
  | "file_ingress_source_unavailable"
  | "file_ingress_transport_unavailable";

export type CreateLocalFileUploadIntentApplicationResult =
  | Readonly<{
      kind: "ready";
      uploadCapability: string;
      expiresAt: UtcInstant;
      replayed: boolean;
    }>
  | Readonly<{ kind: "denied"; decision: unknown }>
  | Readonly<{ kind: "invalid"; code: LocalFileUploadIntentFailureCode }>;

export type UploadLocalFileIntentApplicationResult =
  | StageBundleFileStreamResult
  | Readonly<{ kind: "intent_invalid"; code: LocalFileUploadIntentFailureCode }>;

export type ReadLocalFileUploadIntentApplicationResult =
  | Readonly<{ kind: "pending"; expiresAt: UtcInstant }>
  | Readonly<{
      kind: "staged";
      record: NonNullable<
        Awaited<ReturnType<BundleFileStagingStore["readStagedBundleFile"]>>
      >;
      replayed: boolean;
    }>
  | Readonly<{ kind: "rejected"; code: string }>
  | Readonly<{ kind: "intent_invalid"; code: LocalFileUploadIntentFailureCode }>;

export interface CreateLocalFileUploadIntentInput {
  readonly source_kind?: unknown;
  readonly display_filename?: unknown;
  readonly claimed_media_type?: unknown;
  readonly expected_size?: unknown;
  readonly expected_sha256?: unknown;
  readonly idempotency_key?: unknown;
  readonly [key: string]: unknown;
}

type ValidatedCreate = Readonly<{
  sourceKind: LocalFileUploadIntentSourceKind;
  displayFilename: string;
  claimedMediaType: string;
  expectedSize: number;
  expectedSha256: Sha256Digest;
  idempotencyKey: string;
}>;

function isWriteActor(actor: unknown): actor is McpTokenActorContext {
  if (typeof actor !== "object" || actor === null) return false;
  const value = actor as Partial<McpTokenActorContext>;
  return value.kind === "registered_principal" &&
    value.authentication?.kind === "mcp_token" &&
    Array.isArray(value.authentication.effectiveScopes) &&
    value.authentication.effectiveScopes.includes("content:write");
}

function validFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.normalize("NFC") && !value.includes("/") &&
    !value.includes("\\") && value !== "." && value !== ".." &&
    !CONTROL.test(value) && new TextEncoder().encode(value).byteLength <= 255;
}

/** Header-safe advisory essence; unsafe or unknown input is never persisted. */
export function normalizeUploadIntentMediaType(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || CONTROL.test(value)) {
    return "application/octet-stream";
  }
  const essence = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return essence.length <= 127 && MEDIA_TYPE_ESSENCE.test(essence)
    ? essence
    : "application/octet-stream";
}

function validateCreate(
  input: Readonly<CreateLocalFileUploadIntentInput>,
): ValidatedCreate | null {
  if (Object.keys(input).some((key) => !CREATE_KEYS.has(key))) return null;
  const sourceKind = input.source_kind;
  const displayFilename = input.display_filename;
  const expectedSize = input.expected_size;
  const expectedSha256 = input.expected_sha256;
  const idempotency = validateIdempotencyKey(input.idempotency_key);
  if (
    (sourceKind !== "local_path" &&
      sourceKind !== "workspace/generated_artifact") ||
    !validFilename(displayFilename) ||
    !Number.isSafeInteger(expectedSize) || (expectedSize as number) < 0 ||
    (expectedSize as number) > LOCAL_FILE_UPLOAD_INTENT_LIMITS.maxBytes ||
    typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256) ||
    idempotency.kind !== "valid"
  ) return null;
  return Object.freeze({
    sourceKind,
    displayFilename,
    claimedMediaType: normalizeUploadIntentMediaType(input.claimed_media_type),
    expectedSize: expectedSize as number,
    expectedSha256: expectedSha256 as Sha256Digest,
    idempotencyKey: String(idempotency.key),
  });
}

function plus(instant: string, milliseconds: number): UtcInstant {
  return new Date(Date.parse(instant) + milliseconds).toISOString() as UtcInstant;
}

function leaseExpiry(occurredAt: UtcInstant, expiresAt: UtcInstant): UtcInstant {
  return new Date(Math.min(
    Date.parse(expiresAt),
    Date.parse(occurredAt) +
      LOCAL_FILE_UPLOAD_INTENT_LIMITS.consumeLeaseMilliseconds,
  )).toISOString() as UtcInstant;
}

async function* abortableStream(
  stream: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  let completed = false;
  let rejectAbort: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(new Error("upload intent consume lease was lost"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!completed && typeof iterator.return === "function") {
      void iterator.return().catch(() => undefined);
    }
  }
}

function actorForIntent(
  record: Readonly<LocalFileUploadIntentRecord>,
  requestId: RequestId,
  occurredAtUtc: UtcInstant,
  deploymentCapabilities: readonly Capability[],
): McpTokenActorContext {
  return Object.freeze({
    kind: "registered_principal",
    principalId: record.principalId,
    deploymentCapabilities: Object.freeze([...deploymentCapabilities]),
    requestId,
    occurredAtUtc,
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: record.tokenId,
      bindingOwnerId: record.bindingOwnerId,
      effectiveScopes: Object.freeze(["content:read", "content:write"] as const),
    }),
  });
}

export class LocalFileUploadIntentService {
  readonly #authorizer: Authorizer;
  readonly #usage: PrincipalMindUsageReader;
  readonly #intents: LocalFileUploadIntentStore;
  readonly #staging: Pick<BundleFileStagingService, "stageStream"> &
    Pick<BundleFileStagingStore, "readStagedBundleFile">;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #clock: Clock;
  readonly #nextIntentId: () => string;
  readonly #nextClaimId: () => string;
  readonly #secrets: LocalFileUploadIntentSecretCodec;
  readonly #deploymentCapabilities: readonly Capability[];
  readonly #issuerActorAllowed: (actor: McpTokenActorContext) => boolean;
  readonly #leaseHeartbeatMilliseconds: number;

  constructor(dependencies: {
    readonly authorizer: Authorizer;
    readonly usage?: PrincipalMindUsageReader;
    /** @deprecated Composition compatibility; principal usage is still read here. */
    readonly bindings?: PrincipalMindUsageReader;
    readonly intents: LocalFileUploadIntentStore;
    readonly staging: Pick<BundleFileStagingService, "stageStream"> &
      Pick<BundleFileStagingStore, "readStagedBundleFile">;
    readonly digest: Pick<ObjectStore, "calculateSha256">;
    readonly clock: Clock;
    readonly nextIntentId?: () => string;
    readonly nextClaimId?: () => string;
    readonly secrets: LocalFileUploadIntentSecretCodec;
    readonly deploymentCapabilities: readonly Capability[];
    readonly issuerActorAllowed: (actor: McpTokenActorContext) => boolean;
    readonly leaseHeartbeatMilliseconds?: number;
  }) {
    this.#authorizer = dependencies.authorizer;
    const usage = dependencies.usage ?? dependencies.bindings;
    if (usage === undefined) throw new TypeError("principal Mind usage reader is required");
    this.#usage = usage;
    this.#intents = dependencies.intents;
    this.#staging = dependencies.staging;
    this.#digest = dependencies.digest;
    this.#clock = dependencies.clock;
    this.#nextIntentId = dependencies.nextIntentId ??
      (() => `upload-intent_${crypto.randomUUID()}`);
    this.#nextClaimId = dependencies.nextClaimId ??
      (() => `upload-claim_${crypto.randomUUID()}`);
    this.#secrets = dependencies.secrets;
    this.#deploymentCapabilities = Object.freeze([
      ...dependencies.deploymentCapabilities,
    ]);
    this.#issuerActorAllowed = dependencies.issuerActorAllowed;
    this.#leaseHeartbeatMilliseconds =
      dependencies.leaseHeartbeatMilliseconds ??
      LOCAL_FILE_UPLOAD_INTENT_LIMITS.leaseHeartbeatMilliseconds;
    if (
      !Number.isSafeInteger(this.#leaseHeartbeatMilliseconds) ||
      this.#leaseHeartbeatMilliseconds < 1 ||
      this.#leaseHeartbeatMilliseconds >=
        LOCAL_FILE_UPLOAD_INTENT_LIMITS.consumeLeaseMilliseconds
    ) throw new TypeError("upload intent lease heartbeat is invalid");
  }

  async create(
    actor: McpTokenActorContext,
    expectedSpaceId: SpaceId,
    input: Readonly<CreateLocalFileUploadIntentInput>,
  ): Promise<CreateLocalFileUploadIntentApplicationResult> {
    if (!isWriteActor(actor) || !this.#issuerActorAllowed(actor)) {
      return Object.freeze({ kind: "invalid", code: "insufficient_scope" });
    }
    const validated = validateCreate(input);
    if (validated === null) {
      return Object.freeze({ kind: "invalid", code: "invalid_request" });
    }
    const ownerId = actor.authentication.bindingOwnerId;
    const writePin = await this.#resolveWritePin(actor.principalId, expectedSpaceId);
    if (writePin === null) {
      return Object.freeze({ kind: "invalid", code: "writable_mind_required" });
    }
    const authorization = await this.#authorizer.authorize({
      actor,
      spaceId: expectedSpaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (authorization.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: authorization });
    }

    const namespaceHash = await this.#digest.calculateSha256(
      new TextEncoder().encode(`${JSON.stringify({
        format: "mind-diary-local-upload-intent-namespace-v1",
        principal_id: actor.principalId,
        binding_owner_id: ownerId,
        idempotency_key: validated.idempotencyKey,
      })}\n`),
    );
    const canonicalRequestHash = await this.#digest.calculateSha256(
      new TextEncoder().encode(`${JSON.stringify({
        format: "mind-diary-local-upload-intent-request-v2",
        binding_owner_id: ownerId,
        principal_id: actor.principalId,
        space_id: expectedSpaceId,
        principal_mind_usage_generation_id: writePin.generationId,
        source_kind: validated.sourceKind,
        display_filename: validated.displayFilename,
        claimed_media_type: validated.claimedMediaType,
        expected_size: validated.expectedSize,
        expected_sha256: validated.expectedSha256,
      })}\n`),
    );
    const createdAt = this.#clock.now();
    const record: Readonly<LocalFileUploadIntentRecord> = Object.freeze({
      formatVersion: 1,
      intentId: this.#nextIntentId(),
      namespaceHash,
      canonicalRequestHash,
      principalId: actor.principalId,
      tokenId: actor.authentication.tokenId,
      bindingOwnerId: ownerId,
      spaceId: expectedSpaceId,
      principalMindUsageGenerationId: writePin.generationId,
      sourceKind: validated.sourceKind,
      displayFilename: validated.displayFilename,
      claimedMediaType: validated.claimedMediaType,
      expectedSize: validated.expectedSize,
      expectedSha256: validated.expectedSha256,
      idempotencyKey: validated.idempotencyKey as IdempotencyKey,
      state: "active",
      claimId: null,
      leaseExpiresAt: null,
      stagedFileId: null,
      stageReplayed: null,
      rejectionCode: null,
      createdAt,
      expiresAt: plus(
        createdAt,
        LOCAL_FILE_UPLOAD_INTENT_LIMITS.ttlMilliseconds,
      ),
      consumedAt: null,
    });
    const result = await this.#intents.createLocalFileUploadIntent(record);
    if (result.kind === "conflict") {
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_intent_conflict",
      });
    }
    if (Date.parse(result.record.expiresAt) <= Date.parse(createdAt)) {
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_intent_expired",
      });
    }
    return Object.freeze({
      kind: "ready",
      uploadCapability: await this.#secrets.issue(result.record.intentId),
      expiresAt: result.record.expiresAt,
      replayed: result.kind === "replayed",
    });
  }

  async upload(input: Readonly<{
    capability: unknown;
    requestId: RequestId;
    stream: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }>): Promise<UploadLocalFileIntentApplicationResult> {
    const intentId = await this.#secrets.verify(input.capability);
    if (intentId === null) {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    const occurredAt = this.#clock.now();
    const existing = await this.#intents.readLocalFileUploadIntent(intentId);
    if (existing === null) {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    const actor = actorForIntent(
      existing,
      input.requestId,
      occurredAt,
      this.#deploymentCapabilities,
    );
    if (
      existing.principalMindUsageGenerationId === undefined ||
      !(await this.#usage.validatePrincipalMindUsageWritePin({
        principalId: existing.principalId,
        spaceId: existing.spaceId,
        generationId: existing.principalMindUsageGenerationId,
      }))
    ) {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    const authorization = await this.#authorizer.authorize({
      actor,
      spaceId: existing.spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (authorization.kind === "denied") {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }

    const claimId = this.#nextClaimId();
    const claimed = await this.#intents.claimLocalFileUploadIntent({
      intentId,
      principalId: existing.principalId,
      bindingOwnerId: existing.bindingOwnerId,
      claimId,
      occurredAt,
      leaseExpiresAt: leaseExpiry(occurredAt, existing.expiresAt),
    });
    if (claimed.kind === "not_found") {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    if (claimed.kind === "expired") {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_intent_expired",
      });
    }
    if (claimed.kind === "consumed" || claimed.kind === "rejected") {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_intent_conflict",
      });
    }
    if (claimed.kind !== "claimed") {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_transport_unavailable",
      });
    }

    const record = claimed.record;
    const streamAbort = new AbortController();
    const upstreamAbort = () => streamAbort.abort();
    if (input.signal?.aborted) streamAbort.abort();
    else input.signal?.addEventListener("abort", upstreamAbort, { once: true });
    let heartbeatStopped = false;
    let heartbeatInFlight: Promise<void> = Promise.resolve();
    const renewLease = async (): Promise<void> => {
      if (heartbeatStopped || streamAbort.signal.aborted) return;
      try {
        const renewedAt = this.#clock.now();
        const renewed = await this.#intents.renewLocalFileUploadIntent({
          intentId: record.intentId,
          claimId,
          occurredAt: renewedAt,
          leaseExpiresAt: leaseExpiry(renewedAt, record.expiresAt),
        });
        if (renewed !== "renewed") streamAbort.abort();
      } catch {
        streamAbort.abort();
      }
    };
    const heartbeat = setInterval(() => {
      heartbeatInFlight = heartbeatInFlight.then(renewLease, renewLease);
    }, this.#leaseHeartbeatMilliseconds);
    (heartbeat as unknown as { unref?: () => void }).unref?.();

    let result: StageBundleFileStreamResult;
    try {
      try {
        result = await this.#staging.stageStream({
          actor,
          spaceId: record.spaceId,
          displayFilename: record.displayFilename,
          claimedMediaType: record.claimedMediaType,
          expectedSize: record.expectedSize,
          expectedSha256: record.expectedSha256,
          sourceKind: record.sourceKind,
          idempotencyKey: record.idempotencyKey,
          stream: abortableStream(input.stream, streamAbort.signal),
          maxBytes: LOCAL_FILE_UPLOAD_INTENT_LIMITS.maxBytes,
          signal: streamAbort.signal,
        });
      } finally {
        heartbeatStopped = true;
        clearInterval(heartbeat);
        input.signal?.removeEventListener("abort", upstreamAbort);
        await heartbeatInFlight;
      }
    } catch (error) {
      await this.#intents.releaseLocalFileUploadIntent({
        intentId: record.intentId,
        claimId,
      }).catch(() => undefined);
      throw error;
    }

    if (result.kind === "staged") {
      const completed = await this.#intents.completeLocalFileUploadIntent({
        intentId: record.intentId,
        claimId,
        stagedFileId: result.record.stagedFileId,
        replayed: result.replayed,
        completedAt: this.#clock.now(),
      });
      if (completed === "completed") return result;
      return Object.freeze({
        kind: "intent_invalid",
        code: completed === "expired"
          ? "file_ingress_intent_expired"
          : "file_ingress_transport_unavailable",
      });
    }

    const retryable = result.kind === "stream_invalid" &&
      (result.code === "stream_cancelled" ||
        result.code === "stream_transport_unavailable");
    if (retryable) {
      await this.#intents.releaseLocalFileUploadIntent({
        intentId: record.intentId,
        claimId,
      });
    } else {
      const code = result.kind === "denied"
        ? "authorization_denied"
        : result.code;
      await this.#intents.rejectLocalFileUploadIntent({
        intentId: record.intentId,
        claimId,
        code,
        rejectedAt: this.#clock.now(),
      });
    }
    return result;
  }

  async status(input: Readonly<{
    capability: unknown;
    requestId: RequestId;
  }>): Promise<ReadLocalFileUploadIntentApplicationResult> {
    const intentId = await this.#secrets.verify(input.capability);
    if (intentId === null) {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    const record = await this.#intents.readLocalFileUploadIntent(intentId);
    if (record === null) {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    const occurredAt = this.#clock.now();
    if (Date.parse(record.expiresAt) <= Date.parse(occurredAt)) {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_intent_expired",
      });
    }
    const actor = actorForIntent(
      record,
      input.requestId,
      occurredAt,
      this.#deploymentCapabilities,
    );
    if (
      record.principalMindUsageGenerationId === undefined ||
      !(await this.#usage.validatePrincipalMindUsageWritePin({
        principalId: record.principalId,
        spaceId: record.spaceId,
        generationId: record.principalMindUsageGenerationId,
      }))
    ) {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    const authorization = await this.#authorizer.authorize({
      actor,
      spaceId: record.spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (authorization.kind === "denied") {
      return Object.freeze({
        kind: "intent_invalid",
        code: "file_ingress_source_unavailable",
      });
    }
    if (record.state === "rejected") {
      return Object.freeze({
        kind: "rejected",
        code: record.rejectionCode ?? "file_ingress_intent_conflict",
      });
    }
    if (record.state !== "consumed" || record.stagedFileId === null) {
      return Object.freeze({ kind: "pending", expiresAt: record.expiresAt });
    }
    const staged = await this.#staging.readStagedBundleFile(
      record.stagedFileId as StagedBundleFileId,
    );
    return staged === null
      ? Object.freeze({
          kind: "intent_invalid",
          code: "file_ingress_transport_unavailable",
        })
      : Object.freeze({
          kind: "staged",
          record: staged,
          replayed: record.stageReplayed === true,
        });
  }

  async #resolveWritePin(
    principalId: McpTokenActorContext["principalId"],
    assertedSpaceId: SpaceId,
  ): Promise<Readonly<PrincipalMindUsageWritePin> | null> {
    const state = await this.#usage.readPrincipalMindUsage(principalId);
    const generation = principalMindUsageWriteGeneration(state, assertedSpaceId);
    if (
      generation === null || generation.principalId !== principalId ||
      generation.spaceId !== assertedSpaceId
    ) return null;
    const pin: Readonly<PrincipalMindUsageWritePin> = Object.freeze({
      principalId,
      spaceId: assertedSpaceId,
      generationId: generation.generationId as PrincipalMindUsageGenerationId,
    });
    return await this.#usage.validatePrincipalMindUsageWritePin(pin)
      ? pin
      : null;
  }
}

export class LocalFileUploadIntentCleanupService {
  readonly #intents: Pick<
    LocalFileUploadIntentStore,
    "collectExpiredLocalFileUploadIntents" |
      "deleteExpiredLocalFileUploadIntent"
  >;
  readonly #clock: Clock;

  constructor(dependencies: {
    readonly intents: Pick<
      LocalFileUploadIntentStore,
      "collectExpiredLocalFileUploadIntents" |
        "deleteExpiredLocalFileUploadIntent"
    >;
    readonly clock: Clock;
  }) {
    this.#intents = dependencies.intents;
    this.#clock = dependencies.clock;
  }

  async run(): Promise<Readonly<{ scanned: number; deleted: number }>> {
    const now = this.#clock.now();
    const expiredBefore = new Date(
      Date.parse(now) -
        LOCAL_FILE_UPLOAD_INTENT_LIMITS.cleanupSafetyMilliseconds,
    ).toISOString() as UtcInstant;
    const candidates =
      await this.#intents.collectExpiredLocalFileUploadIntents({
        expiredBefore,
        limit: LOCAL_FILE_UPLOAD_INTENT_LIMITS.cleanupMaxRecords,
      });
    let deleted = 0;
    for (const candidate of candidates) {
      if (await this.#intents.deleteExpiredLocalFileUploadIntent({
        intentId: candidate.intentId,
        expectedExpiresAt: candidate.expiresAt,
        expiredBefore,
      })) deleted += 1;
    }
    return Object.freeze({ scanned: candidates.length, deleted });
  }
}
