import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  AuthorizationDecision,
  AuthorizationStamp,
  BackgroundAuthorizer,
  Clock,
  ExportArchiveStore,
  ExportDownloadGrantStore,
  ExportDownloadSecretCrypto,
  ExportJobIdGenerator,
  ExportStartTransaction,
  IdempotencyNamespace,
  ObjectStore,
} from "@mind-diary/application-ports";
import {
  version,
  utcInstant,
  type ExportDownloadGrant,
  type ExportJob,
  type IdempotencyKey,
  type JobId,
  type RevisionId,
  type RevisionMode,
  type Sha256Digest,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";
import {
  DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
  normalizeIdempotencyKeyMaxBytes,
  validateIdempotencyKey,
} from "./idempotency.js";

export const DEFAULT_EXPORT_JOB_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_EXPORT_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_EXPORT_DOWNLOAD_GRANT_TTL_MS = 5 * 60 * 1_000;
export const MAX_EXPORT_DOWNLOAD_GRANT_TTL_MS = 10 * 60 * 1_000;

export type ExportRevisionSelector =
  | { readonly kind: "head" }
  | { readonly kind: "revision"; readonly revisionId: RevisionId }
  | { readonly kind: "as_of"; readonly asOf: UtcInstant };

export interface StartExportRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly revisionSelector?: unknown;
  readonly idempotencyKey: unknown;
}

export interface SafeExportArchiveMetadata {
  readonly archiveFormat: "MD-OKF-ZIP-1";
  readonly mediaType: "application/zip";
  readonly filename: "mind-diary-okf-bundle.zip";
  readonly contentDisposition: 'attachment; filename="mind-diary-okf-bundle.zip"';
  readonly sha256: Sha256Digest;
  readonly size: number;
}

export interface SafeExportJobStatus {
  readonly jobId: JobId;
  readonly status: ExportJob["state"];
  readonly revisionId: RevisionId;
  readonly attempts: number;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly completedAt: UtcInstant | null;
  readonly lastFailureCode: string | null;
  readonly archiveCleanedAt: UtcInstant | null;
  /** Never includes archive bytes, object keys, download URLs or grants. */
  readonly archive: Readonly<SafeExportArchiveMetadata> | null;
}

/** Response-only bearer material. Callers must omit it from logs and status caches. */
export interface ExportDownloadGrantResponse {
  readonly url: string;
  readonly expiresAt: UtcInstant;
}

export interface ExportDownloadResponse {
  readonly archive: Readonly<SafeExportArchiveMetadata>;
  readonly headers: Readonly<{
    readonly "Content-Type": "application/zip";
    readonly "Content-Disposition": 'attachment; filename="mind-diary-okf-bundle.zip"';
    readonly "Content-Length": string;
    readonly "Cache-Control": "no-store";
    readonly Pragma: "no-cache";
    readonly "X-Content-Type-Options": "nosniff";
    readonly "Referrer-Policy": "no-referrer";
  }>;
  readonly bytes: Uint8Array;
}

export type StartExportResult =
  | {
      readonly kind: "started";
      readonly job: Readonly<SafeExportJobStatus>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "denied";
      readonly decision: Extract<AuthorizationDecision, { readonly kind: "denied" }>;
    }
  | { readonly kind: "invalid"; readonly code: string; readonly message: string }
  | { readonly kind: "revision_not_found" | "idempotency_conflict" };

export type GetExportStatusResult =
  | {
      readonly kind: "found";
      readonly job: Readonly<SafeExportJobStatus>;
      readonly download: Readonly<ExportDownloadGrantResponse> | null;
    }
  | { readonly kind: "not_found" };

export type DownloadExportResult =
  | { readonly kind: "download"; readonly response: Readonly<ExportDownloadResponse> }
  | { readonly kind: "not_found" };

export class ExportJobInvariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExportJobInvariantError";
  }
}

interface ParsedStart {
  readonly selector: Readonly<ExportRevisionSelector>;
  readonly revisionMode: RevisionMode;
  readonly idempotencyKey: IdempotencyKey;
}

const ENCODER = new TextEncoder();
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(code: string, message: string): StartExportResult {
  return Object.freeze({ kind: "invalid", code, message });
}

function normalizeDownloadUrlBase(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError("export download URL base must be an absolute HTTPS URL");
  }
  const loopbackHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("export download URL base must be a safe absolute HTTPS or loopback HTTP URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function sameAuthorizationStamp(
  left: AuthorizationStamp,
  right: AuthorizationStamp,
): boolean {
  return (
    left.accessVersion === right.accessVersion &&
    left.membershipVersion === right.membershipVersion &&
    left.tokenVersion === right.tokenVersion
  );
}

function safeArchiveMetadata(
  archive: NonNullable<ExportJob["archive"]>,
): Readonly<SafeExportArchiveMetadata> {
  return Object.freeze({
    archiveFormat: archive.archiveFormat,
    mediaType: archive.mediaType,
    filename: archive.filename,
    contentDisposition: archive.contentDisposition,
    sha256: archive.sha256,
    size: archive.size,
  });
}

function parseSelector(value: unknown): Readonly<ExportRevisionSelector> | null {
  if (value === undefined) return Object.freeze({ kind: "head" });
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const keys = Object.keys(value).sort();
  if (value.kind === "head" && keys.length === 1 && keys[0] === "kind") {
    return Object.freeze({ kind: "head" });
  }
  if (
    value.kind === "revision" &&
    keys.length === 2 &&
    keys[0] === "kind" &&
    keys[1] === "revisionId" &&
    typeof value.revisionId === "string" &&
    value.revisionId.length > 0 &&
    value.revisionId.length <= 512 &&
    !CONTROL_CHARACTER.test(value.revisionId)
  ) {
    return Object.freeze({
      kind: "revision",
      revisionId: value.revisionId as RevisionId,
    });
  }
  if (
    value.kind === "as_of" &&
    keys.length === 2 &&
    keys[0] === "asOf" &&
    keys[1] === "kind" &&
    typeof value.asOf === "string"
  ) {
    try {
      return Object.freeze({ kind: "as_of", asOf: utcInstant(value.asOf) });
    } catch {
      return null;
    }
  }
  return null;
}

function canonicalSelector(selector: Readonly<ExportRevisionSelector>): object {
  switch (selector.kind) {
    case "head":
      return { kind: "head" };
    case "revision":
      return { kind: "revision", revision_id: selector.revisionId };
    case "as_of":
      return { kind: "as_of", as_of: selector.asOf };
  }
}

function addMilliseconds(now: UtcInstant, durationMs: number): UtcInstant {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new ExportJobInvariantError("invalid_clock", "export clock returned invalid UTC");
  }
  return new Date(timestamp + durationMs).toISOString() as UtcInstant;
}

function safeStatus(job: Readonly<ExportJob>): Readonly<SafeExportJobStatus> {
  const archive =
    job.state === "succeeded" && job.archive !== null
      ? safeArchiveMetadata(job.archive)
      : null;
  return Object.freeze({
    jobId: job.jobId,
    status: job.state,
    revisionId: job.revisionId,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    completedAt: job.completedAt,
    lastFailureCode: job.lastFailureCode,
    archiveCleanedAt: job.archiveCleanedAt,
    archive,
  });
}

export class ExportJobApplicationService {
  readonly #authorizer: Authorizer;
  readonly #backgroundAuthorizer: BackgroundAuthorizer;
  readonly #metadata: ExportDownloadGrantStore;
  readonly #digest: Pick<ObjectStore, "calculateSha256">;
  readonly #archives: Pick<ExportArchiveStore, "readExportArchive">;
  readonly #clock: Clock;
  readonly #jobIds: ExportJobIdGenerator;
  readonly #downloadSecretCrypto: ExportDownloadSecretCrypto;
  readonly #downloadUrlBase: string;
  readonly #retentionMs: number;
  readonly #downloadGrantTtlMs: number;
  readonly #idempotencyKeyMaxBytes: number;

  constructor(dependencies: {
    readonly authorizer: Authorizer;
    readonly backgroundAuthorizer: BackgroundAuthorizer;
    readonly metadata: ExportDownloadGrantStore;
    readonly digest: Pick<ObjectStore, "calculateSha256">;
    readonly archives: Pick<ExportArchiveStore, "readExportArchive">;
    readonly clock: Clock;
    readonly jobIds: ExportJobIdGenerator;
    readonly downloadSecretCrypto: ExportDownloadSecretCrypto;
    readonly downloadUrlBase: string;
    readonly retentionMs?: number;
    readonly downloadGrantTtlMs?: number;
    readonly idempotencyKeyMaxBytes?: number;
  }) {
    this.#authorizer = dependencies.authorizer;
    this.#backgroundAuthorizer = dependencies.backgroundAuthorizer;
    this.#metadata = dependencies.metadata;
    this.#digest = dependencies.digest;
    this.#archives = dependencies.archives;
    this.#clock = dependencies.clock;
    this.#jobIds = dependencies.jobIds;
    this.#downloadSecretCrypto = dependencies.downloadSecretCrypto;
    this.#downloadUrlBase = normalizeDownloadUrlBase(dependencies.downloadUrlBase);
    this.#retentionMs = dependencies.retentionMs ?? DEFAULT_EXPORT_JOB_RETENTION_MS;
    if (
      !Number.isSafeInteger(this.#retentionMs) ||
      this.#retentionMs < 1 ||
      this.#retentionMs > MAX_EXPORT_JOB_RETENTION_MS
    ) {
      throw new TypeError("export retention must be a positive bounded duration");
    }
    this.#downloadGrantTtlMs =
      dependencies.downloadGrantTtlMs ?? DEFAULT_EXPORT_DOWNLOAD_GRANT_TTL_MS;
    if (
      !Number.isSafeInteger(this.#downloadGrantTtlMs) ||
      this.#downloadGrantTtlMs < 1 ||
      this.#downloadGrantTtlMs > MAX_EXPORT_DOWNLOAD_GRANT_TTL_MS
    ) {
      throw new TypeError("export download grant lifetime must be positive and bounded");
    }
    this.#idempotencyKeyMaxBytes = normalizeIdempotencyKeyMaxBytes(
      dependencies.idempotencyKeyMaxBytes ?? DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
    );
  }

  async start(request: StartExportRequest): Promise<StartExportResult> {
    const parsed = this.#parseStart(request);
    if ("kind" in parsed) return parsed;
    const initial = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:export",
      revisionMode: parsed.revisionMode,
    });
    if (initial.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initial });
    }
    if (request.actor.kind !== "registered_principal") {
      throw new ExportJobInvariantError(
        "invalid_actor",
        "an authorized export request must belong to a registered principal",
      );
    }
    const actor = request.actor;
    const canonicalRequestHash = await this.#digest.calculateSha256(
      ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-start-export-request-v1",
        revision_selector: canonicalSelector(parsed.selector),
      })}\n`),
    );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "start_export" }
    > = Object.freeze({
      principalId: actor.principalId,
      spaceId: request.spaceId,
      operation: "start_export",
      key: parsed.idempotencyKey,
    });
    const createdAt = this.#clock.now();
    const jobId = this.#jobIds.nextExportJobId();

    return this.#metadata.runExportStartTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction(
        {
          actor,
          spaceId: request.spaceId,
          capability: "content:export",
          revisionMode: parsed.revisionMode,
        },
        transaction,
        initial.stamp,
      );
      if (current.kind === "denied") {
        return Object.freeze({ kind: "denied", decision: current });
      }
      const checked = await transaction.checkIdempotency({
        namespace,
        canonicalRequestHash,
      });
      if (checked.kind === "conflict") {
        return Object.freeze({ kind: "idempotency_conflict" });
      }
      if (checked.kind === "replay") {
        const result = checked.record.result;
        if (result.kind !== "start_export") {
          throw new ExportJobInvariantError(
            "invalid_idempotency_result",
            "start_export namespace resolved to another operation",
          );
        }
        const replayed = await transaction.readExportJob(result.jobId);
        if (
          replayed === null ||
          replayed.spaceId !== request.spaceId ||
          replayed.revisionId !== result.revisionId ||
          replayed.requestedByPrincipalId !== actor.principalId
        ) {
          throw new ExportJobInvariantError(
            "invalid_idempotency_result",
            "start_export result does not resolve to its durable job",
          );
        }
        return Object.freeze({
          kind: "started",
          job: safeStatus(replayed),
          replayed: true,
        });
      }

      const revisionId = await this.#resolveRevision(transaction, request.spaceId, parsed.selector);
      if (revisionId === null) return Object.freeze({ kind: "revision_not_found" });
      const job: Readonly<ExportJob> = Object.freeze({
        jobId,
        requestedByPrincipalId: actor.principalId,
        spaceId: request.spaceId,
        revisionId,
        idempotencyKey: parsed.idempotencyKey,
        state: "queued",
        version: version(1),
        attempts: 0,
        availableAt: createdAt,
        claimExpiresAt: null,
        expiresAt: addMilliseconds(createdAt, this.#retentionMs),
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        lastFailureCode: null,
        archive: null,
        archiveCleanedAt: null,
      });
      const created = await transaction.createExportJob(job);
      if (created.kind !== "created") {
        throw new ExportJobInvariantError(
          created.kind,
          "export metadata rejected a new durable job",
        );
      }
      const completed = await transaction.completeIdempotency({
        namespace,
        canonicalRequestHash,
        result: Object.freeze({ kind: "start_export", jobId, revisionId }),
        completedAt: createdAt,
      });
      if (completed.kind !== "completed") {
        throw new ExportJobInvariantError(
          "invalid_idempotency_state",
          "start_export idempotency changed inside its transaction",
        );
      }
      return Object.freeze({
        kind: "started",
        job: safeStatus(created.job),
        replayed: false,
      });
    });
  }

  async getStatus(request: {
    readonly actor: ActorContext;
    readonly jobId: JobId;
  }): Promise<GetExportStatusResult> {
    if (typeof request.jobId !== "string" || request.jobId.length === 0) {
      return Object.freeze({ kind: "not_found" });
    }
    const job = await this.#metadata.readExportJob(request.jobId);
    if (job === null) return Object.freeze({ kind: "not_found" });
    const authorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: job.spaceId,
      capability: "content:export",
      revisionMode: "historical",
    });
    if (authorization.kind === "denied") {
      return Object.freeze({ kind: "not_found" });
    }
    if (request.actor.kind !== "registered_principal") {
      return Object.freeze({ kind: "not_found" });
    }
    if (
      job.state !== "succeeded" ||
      job.archive === null ||
      Date.parse(this.#clock.now()) >= Date.parse(job.expiresAt)
    ) {
      return Object.freeze({ kind: "found", job: safeStatus(job), download: null });
    }
    return this.#issueDownloadGrant(request.actor, job, authorization);
  }

  async download(request: {
    readonly actor: ActorContext;
    readonly secret: unknown;
  }): Promise<DownloadExportResult> {
    if (request.actor.kind !== "service") {
      return Object.freeze({ kind: "not_found" });
    }
    const now = this.#clock.now();
    const verified = await this.#downloadSecretCrypto.verifySecret(request.secret, {
      findByVerifier: async (verifier) => {
        const located = await this.#metadata.readExportDownloadGrant(verifier, now);
        return located.kind === "active"
          ? Object.freeze({
              kind: "found" as const,
              verifier: located.grant.secretVerifier,
              value: located.grant,
            })
          : Object.freeze({ kind: "not_found" as const });
      },
    });
    if (verified.kind !== "verified") return Object.freeze({ kind: "not_found" });
    const grant = verified.value;
    const verifier = grant.secretVerifier;
    const authorizationRequest = Object.freeze({
      actor: request.actor,
      principalId: grant.requestedByPrincipalId,
      spaceId: grant.spaceId,
      capability: "content:export" as const,
      revisionMode: "historical" as const,
    });
    const initial = await this.#backgroundAuthorizer.authorize(authorizationRequest);
    if (initial.kind === "denied") {
      await this.#metadata.revokeExportDownloadGrant(verifier, this.#clock.now());
      return Object.freeze({ kind: "not_found" });
    }

    const job = await this.#metadata.readExportJob(grant.jobId);
    if (!this.#grantMatchesSucceededJob(grant, job, this.#clock.now())) {
      await this.#metadata.revokeExportDownloadGrant(verifier, this.#clock.now());
      return Object.freeze({ kind: "not_found" });
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await this.#archives.readExportArchive(grant.objectKey);
    } catch {
      bytes = null;
    }
    if (bytes === null || bytes.byteLength !== job!.archive!.size) {
      await this.#metadata.revokeExportDownloadGrant(verifier, this.#clock.now());
      return Object.freeze({ kind: "not_found" });
    }

    const finalGrant = await this.#metadata.readExportDownloadGrant(
      verifier,
      this.#clock.now(),
    );
    const finalAuthorization = await this.#backgroundAuthorizer.authorize(
      authorizationRequest,
    );
    const finalJob = await this.#metadata.readExportJob(grant.jobId);
    if (
      finalGrant.kind !== "active" ||
      finalAuthorization.kind === "denied" ||
      !sameAuthorizationStamp(initial.stamp, finalAuthorization.stamp) ||
      !this.#grantMatchesSucceededJob(grant, finalJob, this.#clock.now())
    ) {
      await this.#metadata.revokeExportDownloadGrant(verifier, this.#clock.now());
      return Object.freeze({ kind: "not_found" });
    }

    const archive = safeArchiveMetadata(finalJob!.archive!);
    return Object.freeze({
      kind: "download",
      response: Object.freeze({
        archive,
        headers: Object.freeze({
          "Content-Type": archive.mediaType,
          "Content-Disposition": archive.contentDisposition,
          "Content-Length": String(archive.size),
          "Cache-Control": "no-store",
          Pragma: "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        }),
        bytes: new Uint8Array(bytes),
      }),
    });
  }

  async #issueDownloadGrant(
    actor: Extract<ActorContext, { readonly kind: "registered_principal" }>,
    observedJob: Readonly<ExportJob>,
    initial: Extract<AuthorizationDecision, { readonly kind: "allowed" }>,
  ): Promise<GetExportStatusResult> {
    const authorizationRequest = Object.freeze({
      actor,
      spaceId: observedJob.spaceId,
      capability: "content:export" as const,
      revisionMode: "historical" as const,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const issuedSecret = await this.#downloadSecretCrypto.issueSecret();
      const secretVerifier = issuedSecret.verifier();
      const createdAt = this.#clock.now();
      const expiresAt = new Date(
        Math.min(
          Date.parse(addMilliseconds(createdAt, this.#downloadGrantTtlMs)),
          Date.parse(observedJob.expiresAt),
        ),
      ).toISOString() as UtcInstant;
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
        return Object.freeze({
          kind: "found",
          job: safeStatus(observedJob),
          download: null,
        });
      }

      const issued = await this.#metadata.runExportDownloadGrantTransaction(
        async (transaction) => {
          const current = await this.#authorizer.reauthorizeInTransaction(
            authorizationRequest,
            transaction,
            initial.stamp,
          );
          if (current.kind === "denied") {
            return Object.freeze({ kind: "not_found" as const });
          }
          const job = await transaction.readExportJob(observedJob.jobId);
          if (!this.#sameGrantableJob(observedJob, job, createdAt)) {
            return Object.freeze({ kind: "not_found" as const });
          }
          const grant: Readonly<ExportDownloadGrant> = Object.freeze({
            secretVerifier,
            jobId: job!.jobId,
            requestedByPrincipalId: actor.principalId,
            spaceId: job!.spaceId,
            revisionId: job!.revisionId,
            objectKey: job!.archive!.objectKey,
            state: "active",
            createdAt,
            expiresAt,
            revokedAt: null,
          });
          const created = await transaction.createExportDownloadGrant(grant);
          if (created.kind === "secret_collision") {
            return Object.freeze({ kind: "secret_collision" as const });
          }
          if (created.kind !== "created") {
            throw new ExportJobInvariantError(
              created.kind,
              "export metadata rejected a bounded download grant",
            );
          }
          return Object.freeze({
            kind: "created" as const,
            grant: created.grant,
            authorizationStamp: current.stamp,
            job: job!,
          });
        },
      );
      if (issued.kind === "secret_collision") continue;
      if (issued.kind === "not_found") return Object.freeze({ kind: "not_found" });

      const final = await this.#authorizer.authorize(authorizationRequest);
      if (
        final.kind === "denied" ||
        !sameAuthorizationStamp(issued.authorizationStamp, final.stamp)
      ) {
        await this.#metadata.revokeExportDownloadGrant(
          secretVerifier,
          this.#clock.now(),
        );
        return Object.freeze({ kind: "not_found" });
      }
      const secret = issuedSecret.consumeSecret();
      if (secret === null) {
        await this.#metadata.revokeExportDownloadGrant(
          secretVerifier,
          this.#clock.now(),
        );
        throw new ExportJobInvariantError(
          "invalid_download_secret",
          "download secret was unavailable after successful grant creation",
        );
      }
      return Object.freeze({
        kind: "found",
        job: safeStatus(issued.job),
        download: Object.freeze({
          url: `${this.#downloadUrlBase}/${secret}`,
          expiresAt: issued.grant.expiresAt,
        }),
      });
    }
    throw new ExportJobInvariantError(
      "download_secret_collision",
      "download grant secret generation repeatedly collided",
    );
  }

  #sameGrantableJob(
    observed: Readonly<ExportJob>,
    current: Readonly<ExportJob> | null,
    now: UtcInstant,
  ): boolean {
    return (
      current !== null &&
      current.jobId === observed.jobId &&
      current.spaceId === observed.spaceId &&
      current.revisionId === observed.revisionId &&
      current.version === observed.version &&
      current.state === "succeeded" &&
      current.archive !== null &&
      observed.archive !== null &&
      current.archive.objectKey === observed.archive.objectKey &&
      Date.parse(now) < Date.parse(current.expiresAt)
    );
  }

  #grantMatchesSucceededJob(
    grant: Readonly<ExportDownloadGrant>,
    job: Readonly<ExportJob> | null,
    now: UtcInstant,
  ): boolean {
    return (
      job !== null &&
      job.state === "succeeded" &&
      job.archive !== null &&
      job.jobId === grant.jobId &&
      job.spaceId === grant.spaceId &&
      job.revisionId === grant.revisionId &&
      job.archive.objectKey === grant.objectKey &&
      Date.parse(now) < Date.parse(job.expiresAt) &&
      Date.parse(now) < Date.parse(grant.expiresAt)
    );
  }

  #parseStart(request: StartExportRequest): ParsedStart | StartExportResult {
    const selector = parseSelector(request.revisionSelector);
    if (selector === null) {
      return invalid("invalid_revision_selector", "revision selector is invalid");
    }
    const key = validateIdempotencyKey(
      request.idempotencyKey,
      this.#idempotencyKeyMaxBytes,
    );
    if (key.kind === "invalid") {
      return invalid("invalid_idempotency_key", "idempotency key is invalid");
    }
    return Object.freeze({
      selector,
      revisionMode: selector.kind === "head" ? "head" : "historical",
      idempotencyKey: key.key,
    });
  }

  async #resolveRevision(
    transaction: ExportStartTransaction,
    spaceId: SpaceId,
    selector: Readonly<ExportRevisionSelector>,
  ): Promise<RevisionId | null> {
    if (selector.kind === "head") return transaction.readHead(spaceId);
    if (selector.kind === "revision") {
      const revision = await transaction.readRevision(spaceId, selector.revisionId);
      return revision?.revision.revisionId ?? null;
    }
    const requestedAt = Date.parse(selector.asOf);
    const revisions = await transaction.listRevisions(spaceId);
    let selected: RevisionId | null = null;
    let selectedNumber = -1;
    for (const envelope of revisions) {
      if (
        Date.parse(envelope.revision.committedAt) <= requestedAt &&
        envelope.revision.revisionNumber > selectedNumber
      ) {
        selected = envelope.revision.revisionId;
        selectedNumber = envelope.revision.revisionNumber;
      }
    }
    return selected;
  }
}
