import type { ActorContext } from "@mind-diary/application-contracts";
import {
  REVISION_MANIFEST_MEDIA_TYPE,
  type Authorizer,
  type BundleFileObjectStore,
  type CapacityLimits,
  type Clock,
  type CommitEffectIdGenerator,
  type MarkdownImportMetadataStore,
  type MarkdownImportPlan,
  type MarkdownImportPlanFile,
  type MarkdownImportSession,
  type MarkdownImportSessionFailure,
  type MarkdownImportStagedFile,
  type RevisionIdGenerator,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V5,
  canonicalMarkdownPath,
  compareUnicodeScalarValues,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  opaqueId,
  serializeRevisionManifest,
  sha256Digest,
  utcInstant,
  version,
  type IdempotencyKey,
  type MindBindingOwnerId,
  type RevisionId,
  type RevisionManifestEntry,
  type Sha256Digest,
  type SpaceId,
  type StagedBundleFileId,
} from "@mind-diary/domain";
import { parseOkfFile } from "@mind-diary/okf-codec";
import { analyzeBundleFileReferences } from "./bundle-file-references.js";
import {
  CAPACITY_RESERVATION_TTL_MS,
  DEFAULT_CAPACITY_LIMITS,
  capacityExpiry,
  capacityOperationKey,
  capacityReservationId,
} from "./capacity.js";
import {
  DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
  validateIdempotencyKey,
} from "./idempotency.js";
import type { DeltaRevisionReader } from "./index.js";

export const MARKDOWN_IMPORT_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxLogicalBytes: 67_108_864,
  maxFileBytes: 1_048_576,
  maxBatchFiles: 256,
  maxBatchBytes: 4_194_304,
  maxValidationFiles: 100,
  maxValidationBytes: 4_194_304,
  maxPromotionFiles: 100,
  maxPromotionBytes: 4_194_304,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255,
  maxFailures: 100,
  planTtlMs: 60 * 60 * 1_000,
  sessionTtlMs: CAPACITY_RESERVATION_TTL_MS.import,
  cleanupMaxFiles: 100,
  cleanupMaxBytes: 268_435_456,
  cleanupMaxDurationMs: 20_000,
} as const);

export type MarkdownImportErrorCode =
  | "invalid_import_request"
  | "invalid_import_path"
  | "invalid_import_digest"
  | "import_file_limit_exceeded"
  | "import_byte_limit_exceeded"
  | "import_plan_not_found"
  | "import_session_not_found"
  | "import_plan_expired"
  | "import_session_expired"
  | "import_state_conflict"
  | "import_checkpoint_conflict"
  | "import_idempotency_conflict"
  | "import_file_conflict"
  | "import_head_conflict"
  | "import_validation_failed"
  | "capacity_soft_limit"
  | "capacity_hard_limit"
  | "capacity_fairness_limit"
  | "capacity_accounting_untrusted";

export class MarkdownImportError extends Error {
  readonly code: MarkdownImportErrorCode;
  readonly failures: readonly Readonly<MarkdownImportSessionFailure>[];

  constructor(
    code: MarkdownImportErrorCode,
    message: string,
    failures: readonly Readonly<MarkdownImportSessionFailure>[] = [],
  ) {
    super(message);
    this.name = "MarkdownImportError";
    this.code = code;
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
}

export interface MarkdownImportIdGenerator {
  nextPlanId(): string;
  nextImportId(): string;
  nextStagedFileId(): StagedBundleFileId;
}

export interface MarkdownImportPlanRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId;
  readonly idempotencyKey: unknown;
  readonly files: unknown;
}

export interface MarkdownImportBatchFile {
  readonly path: unknown;
  readonly sha256: unknown;
  readonly size: unknown;
  readonly bytes: unknown;
}

export interface MarkdownImportBatchRequest {
  readonly actor: ActorContext;
  readonly importId: string;
  readonly checkpoint: unknown;
  readonly expectedVersion: unknown;
  readonly files: unknown;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const WINDOWS_DRIVE = /^[a-z]:/iu;
const ENCODED_PATH_HAZARD = /%(?:00|2f|5c)/iu;

function registeredActor(actor: ActorContext) {
  if (actor.kind !== "registered_principal") {
    throw new MarkdownImportError("invalid_import_request", "registered principal is required");
  }
  return actor;
}

function canonicalImportPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
    throw new MarkdownImportError("invalid_import_path", "import path must be non-empty NFC");
  }
  if (
    value.startsWith("/") || value.includes("\\") || value.includes("//") ||
    CONTROL.test(value) || SCHEME.test(value) || WINDOWS_DRIVE.test(value) ||
    ENCODED_PATH_HAZARD.test(value) ||
    value.startsWith(".mind-diary/") || value === ".mind-diary" ||
    !value.endsWith(".md")
  ) throw new MarkdownImportError("invalid_import_path", "import path is outside the Markdown profile");
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." ||
      ENCODER.encode(segment).byteLength > MARKDOWN_IMPORT_LIMITS.maxSegmentBytes)
  ) throw new MarkdownImportError("invalid_import_path", "import path segment is invalid");
  if (ENCODER.encode(value).byteLength > MARKDOWN_IMPORT_LIMITS.maxPathBytes) {
    throw new MarkdownImportError("invalid_import_path", "import path is too long");
  }
  try {
    return canonicalMarkdownPath(value);
  } catch {
    throw new MarkdownImportError("invalid_import_path", "import path is not canonical");
  }
}

function safeFailurePath(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, "�").slice(0, 1_024)
    : "(unknown)";
}

function validatedPlanFiles(value: unknown): readonly Readonly<MarkdownImportPlanFile>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MarkdownImportError("invalid_import_request", "import plan requires files");
  }
  if (value.length > MARKDOWN_IMPORT_LIMITS.maxFiles) {
    throw new MarkdownImportError("import_file_limit_exceeded", "import file limit exceeded");
  }
  const files: MarkdownImportPlanFile[] = [];
  const seen = new Set<string>();
  let logicalBytes = 0;
  const failures: MarkdownImportSessionFailure[] = [];
  for (const candidate of value) {
    const source = typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
    try {
      const path = canonicalImportPath(source.path);
      if (seen.has(path)) throw new MarkdownImportError("invalid_import_path", "duplicate path");
      seen.add(path);
      if (!Number.isSafeInteger(source.size) || Number(source.size) < 0) {
        throw new MarkdownImportError("invalid_import_request", "file size is invalid");
      }
      const size = Number(source.size);
      if (size > MARKDOWN_IMPORT_LIMITS.maxFileBytes) {
        throw new MarkdownImportError("import_byte_limit_exceeded", "file byte limit exceeded");
      }
      const sha256 = sha256Digest(String(source.sha256 ?? ""));
      logicalBytes += size;
      files.push(Object.freeze({ path, sha256, size }));
    } catch (error) {
      failures.push(Object.freeze({
        path: safeFailurePath(source.path),
        code: error instanceof MarkdownImportError ? error.code : "invalid_import_digest",
      }));
    }
  }
  if (failures.length > 0) {
    throw new MarkdownImportError(
      "invalid_import_request",
      "import plan contains invalid files",
      failures.slice(0, MARKDOWN_IMPORT_LIMITS.maxFailures),
    );
  }
  if (logicalBytes > MARKDOWN_IMPORT_LIMITS.maxLogicalBytes) {
    throw new MarkdownImportError("import_byte_limit_exceeded", "import byte limit exceeded");
  }
  return Object.freeze(files.sort((left, right) =>
    compareUnicodeScalarValues(left.path, right.path)));
}

function importKey(value: unknown): IdempotencyKey {
  const validated = validateIdempotencyKey(value, DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES);
  if (validated.kind !== "valid") {
    throw new MarkdownImportError("invalid_import_request", "idempotency key is invalid");
  }
  return validated.key;
}

function utilizationForRatio(ratio: number) {
  if (ratio >= 1) return "hard_limit" as const;
  if (ratio >= 0.85) return "soft_limit" as const;
  if (ratio >= 0.7) return "warning" as const;
  return "normal" as const;
}

function planExpiry(createdAt: string) {
  return utcInstant(new Date(Date.parse(createdAt) + MARKDOWN_IMPORT_LIMITS.planTtlMs).toISOString());
}

function sessionFailure(path: string, code: string): Readonly<MarkdownImportSessionFailure> {
  return Object.freeze({ path: safeFailurePath(path), code });
}

function stagedPlanFailures(
  plan: Readonly<MarkdownImportPlan>,
  staged: readonly Readonly<MarkdownImportStagedFile>[],
): readonly Readonly<MarkdownImportSessionFailure>[] {
  const planned = new Map(plan.files.map((file) => [file.path, file] as const));
  const seen = new Set<string>();
  const failures: MarkdownImportSessionFailure[] = [];
  for (const file of staged) {
    const expected = planned.get(file.path);
    if (seen.has(file.path)) {
      failures.push(sessionFailure(file.path, "duplicate_staged_path"));
    } else if (
      expected === undefined ||
      expected.sha256 !== file.sha256 ||
      expected.size !== file.size
    ) {
      failures.push(sessionFailure(file.path, "staged_file_differs_from_plan"));
    }
    seen.add(file.path);
  }
  for (const file of plan.files) {
    if (!seen.has(file.path)) failures.push(sessionFailure(file.path, "planned_file_not_staged"));
  }
  return Object.freeze(failures.slice(0, MARKDOWN_IMPORT_LIMITS.maxFailures));
}

function capacityCode(reason: string): MarkdownImportErrorCode {
  if (reason === "hard_limit") return "capacity_hard_limit";
  if (reason === "soft_limit") return "capacity_soft_limit";
  if (reason === "fairness_limit") return "capacity_fairness_limit";
  return "capacity_accounting_untrusted";
}

export class MarkdownImportService {
  readonly #authorizer: Authorizer;
  readonly #metadata: MarkdownImportMetadataStore;
  readonly #objects: BundleFileObjectStore;
  readonly #revisions: DeltaRevisionReader;
  readonly #clock: Clock;
  readonly #ids: MarkdownImportIdGenerator;
  readonly #revisionIds: RevisionIdGenerator;
  readonly #effectIds: CommitEffectIdGenerator;
  readonly #capacityLimits: Readonly<CapacityLimits>;

  constructor(dependencies: {
    readonly authorizer: Authorizer;
    readonly metadata: MarkdownImportMetadataStore;
    readonly objects: BundleFileObjectStore;
    readonly revisions: DeltaRevisionReader;
    readonly clock: Clock;
    readonly revisionIds: RevisionIdGenerator;
    readonly effectIds: CommitEffectIdGenerator;
    readonly ids?: MarkdownImportIdGenerator;
    readonly capacityLimits?: Readonly<CapacityLimits>;
  }) {
    this.#authorizer = dependencies.authorizer;
    this.#metadata = dependencies.metadata;
    this.#objects = dependencies.objects;
    this.#revisions = dependencies.revisions;
    this.#clock = dependencies.clock;
    this.#revisionIds = dependencies.revisionIds;
    this.#effectIds = dependencies.effectIds;
    this.#ids = dependencies.ids ?? Object.freeze({
      nextPlanId: () => `import-plan_${crypto.randomUUID()}`,
      nextImportId: () => `import_${crypto.randomUUID()}`,
      nextStagedFileId: () => opaqueId<"staged-bundle-file">(
        `import-file_${crypto.randomUUID()}`,
      ),
    });
    this.#capacityLimits = dependencies.capacityLimits ?? DEFAULT_CAPACITY_LIMITS;
  }

  async plan(request: MarkdownImportPlanRequest) {
    const actor = registeredActor(request.actor);
    const key = importKey(request.idempotencyKey);
    const authorization = await this.#authorizer.authorize({
      actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (authorization.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: authorization });
    if (typeof request.expectedRevisionId !== "string" || request.expectedRevisionId.length === 0) {
      throw new MarkdownImportError("invalid_import_request", "expected revision is required");
    }
    const files = validatedPlanFiles(request.files);
    const head = await this.#revisions.readHeadRevisionEnvelope(request.spaceId);
    if (head === null || head.revision.revisionId !== request.expectedRevisionId) {
      throw new MarkdownImportError("import_head_conflict", "import base HEAD changed");
    }
    const currentMarkdown = new Map(head.manifest.entries
      .filter((entry) => entry.kind === "markdown")
      .map((entry) => [entry.path, entry]));
    const opaquePaths = new Set(head.manifest.entries
      .filter((entry) => entry.kind === "opaque")
      .map((entry) => entry.path));
    const failures = files
      .filter((file) => opaquePaths.has(file.path))
      .map((file) => sessionFailure(file.path, "opaque_path_conflict"));
    if (failures.length > 0) {
      throw new MarkdownImportError("import_file_conflict", "Markdown collides with opaque path", failures);
    }
    let additions = 0;
    let replacements = 0;
    let unchanged = 0;
    for (const file of files) {
      const current = currentMarkdown.get(file.path);
      if (current === undefined) additions += 1;
      else if (current.sha256 === file.sha256 && current.size === file.size) unchanged += 1;
      else replacements += 1;
    }
    const selectedPaths = new Set(files.map((file) => file.path));
    const deletions = [...currentMarkdown.keys()].filter((path) => !selectedPaths.has(path)).length;
    const logicalBytes = files.reduce((total, file) => total + file.size, 0);
    const descriptorHash = await this.#objects.calculateSha256(ENCODER.encode(JSON.stringify(
      files.map(({ path, sha256, size }) => ({ path, sha256, size })),
    )));
    const canonicalRequestHash = await this.#objects.calculateSha256(ENCODER.encode(`${JSON.stringify({
      format: "mind-diary-markdown-import-plan-v1",
      principal_id: actor.principalId,
      space_id: request.spaceId,
      expected_revision_id: request.expectedRevisionId,
      files,
    })}\n`));
    const usage = await this.#metadata.readMindCapacityUsage(request.spaceId);
    if (usage === null || !usage.trustworthy) {
      throw new MarkdownImportError("capacity_accounting_untrusted", "capacity accounting is unavailable");
    }
    const projectedUtilization = utilizationForRatio(
      (usage.physicalCanonicalBytes + usage.reservedBytes + logicalBytes + files.length * 256 + 512) /
        this.#capacityLimits.mindPhysicalCanonicalBytes,
    );
    const createdAt = this.#clock.now();
    const plan: Readonly<MarkdownImportPlan> = Object.freeze({
      planId: this.#ids.nextPlanId(),
      principalId: actor.principalId,
      spaceId: request.spaceId,
      expectedRevisionId: request.expectedRevisionId,
      idempotencyKey: key,
      canonicalRequestHash,
      descriptorHash,
      files,
      logicalBytes,
      additions,
      replacements,
      deletions,
      unchanged,
      projectedUtilization,
      createdAt,
      expiresAt: planExpiry(createdAt),
    });
    return this.#metadata.runMarkdownImportTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction({
        actor,
        spaceId: request.spaceId,
        capability: "content:write",
        revisionMode: "head",
      }, transaction, authorization.stamp);
      if (current.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: current });
      if (await transaction.readHead(request.spaceId) !== request.expectedRevisionId) {
        throw new MarkdownImportError("import_head_conflict", "import base HEAD changed");
      }
      const created = await transaction.createMarkdownImportPlan(
        plan,
        this.#capacityLimits.siteD1MetadataBytes,
      );
      if (created.kind === "capacity_rejected") {
        throw new MarkdownImportError("capacity_hard_limit", "import plan metadata capacity rejected");
      }
      if (created.kind === "idempotency_conflict") {
        throw new MarkdownImportError("import_idempotency_conflict", "import plan key was reused");
      }
      if (created.kind === "id_collision") throw new Error("Markdown import plan ID collision");
      if (created.kind !== "created") throw new Error("Markdown import plan was not created");
      return Object.freeze({ kind: "planned" as const, plan: created.plan, replayed: created.replayed });
    });
  }

  async start(request: Readonly<{
    actor: ActorContext;
    spaceId: SpaceId;
    planId: unknown;
    idempotencyKey: unknown;
  }>) {
    const actor = registeredActor(request.actor);
    const key = importKey(request.idempotencyKey);
    if (typeof request.planId !== "string" || request.planId.length === 0) {
      throw new MarkdownImportError("invalid_import_request", "plan ID is required");
    }
    const authorization = await this.#authorizer.authorize({
      actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (authorization.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: authorization });
    const plan = await this.#metadata.readMarkdownImportPlan(request.planId);
    if (plan === null || plan.principalId !== actor.principalId || plan.spaceId !== request.spaceId) {
      throw new MarkdownImportError("import_plan_not_found", "import plan was not found");
    }
    const createdAt = this.#clock.now();
    if (Date.parse(plan.expiresAt) <= Date.parse(createdAt)) {
      throw new MarkdownImportError("import_plan_expired", "import plan expired");
    }
    const canonicalRequestHash = await this.#objects.calculateSha256(ENCODER.encode(`${JSON.stringify({
      format: "mind-diary-markdown-import-session-v1",
      plan_id: plan.planId,
      principal_id: actor.principalId,
      space_id: plan.spaceId,
      expected_revision_id: plan.expectedRevisionId,
    })}\n`));
    const importId = this.#ids.nextImportId();
    const reservationId = capacityReservationId("import", plan.spaceId, String(canonicalRequestHash));
    const requestedCapacity = Object.freeze({
      physicalCanonicalBytes: plan.logicalBytes + plan.files.length * 256 + 512,
      temporaryBytes: plan.logicalBytes,
      d1MetadataBytes: 2_048 + plan.files.length * 256,
    });
    return this.#metadata.runMarkdownImportTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction({
        actor,
        spaceId: request.spaceId,
        capability: "content:write",
        revisionMode: "head",
      }, transaction, authorization.stamp);
      if (current.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: current });
      const claimed = await transaction.readMarkdownImportSessionForPlan(plan.planId);
      if (claimed !== null) {
        if (
          claimed.principalId === actor.principalId &&
          claimed.spaceId === plan.spaceId &&
          claimed.idempotencyKey === key &&
          claimed.canonicalRequestHash === canonicalRequestHash
        ) {
          return Object.freeze({ kind: "started" as const, session: claimed, replayed: true });
        }
        throw new MarkdownImportError(
          "import_idempotency_conflict",
          "import plan is already claimed",
        );
      }
      const admission = await transaction.admitCapacityReservation(Object.freeze({
        reservationId,
        requestedByPrincipalId: actor.principalId,
        spaceId: plan.spaceId,
        operation: "import" as const,
        operationRef: String(canonicalRequestHash),
        baseRevisionId: plan.expectedRevisionId,
        idempotencyKey: capacityOperationKey("import", String(key)),
        requested: requestedCapacity,
        bulk: true,
        heavy: true,
        createdAt,
        expiresAt: capacityExpiry("import", createdAt),
      }), this.#capacityLimits);
      if (admission.kind === "rejected") {
        throw new MarkdownImportError(capacityCode(admission.reason), "import capacity admission rejected");
      }
      const session: Readonly<MarkdownImportSession> = Object.freeze({
        importId,
        planId: plan.planId,
        principalId: actor.principalId,
        spaceId: plan.spaceId,
        expectedRevisionId: plan.expectedRevisionId,
        idempotencyKey: key,
        canonicalRequestHash,
        reservationId: admission.reservation.reservationId,
        state: "active",
        version: version(1),
        checkpoint: 0,
        stagedFileCount: 0,
        stagedBytes: 0,
        validationCheckpoint: 0,
        validatedBytes: 0,
        promotionCheckpoint: 0,
        promotedBytes: 0,
        failures: Object.freeze([]),
        revisionId: null,
        createdAt,
        expiresAt: capacityExpiry("import", createdAt),
        updatedAt: createdAt,
        cleanupCompletedAt: null,
      });
      const created = await transaction.createMarkdownImportSession(session);
      if (created.kind === "idempotency_conflict") {
        throw new MarkdownImportError("import_idempotency_conflict", "import session key was reused");
      }
      if (created.kind === "head_conflict") {
        throw new MarkdownImportError("import_head_conflict", "import base HEAD changed");
      }
      if (created.kind === "plan_expired") {
        throw new MarkdownImportError("import_plan_expired", "import plan expired");
      }
      if (created.kind === "plan_not_found") {
        throw new MarkdownImportError("import_plan_not_found", "import plan was not found");
      }
      if (created.kind === "id_collision") throw new Error("Markdown import session ID collision");
      if (created.kind !== "created") throw new Error("Markdown import session was not created");
      return Object.freeze({ kind: "started" as const, session: created.session, replayed: created.replayed });
    });
  }

  async status(actorValue: ActorContext, importId: string) {
    const actor = registeredActor(actorValue);
    const session = await this.#ownedSession(actor, importId);
    await this.#ensureActiveAuthorization(actor, session.spaceId);
    const plan = await this.#metadata.readMarkdownImportPlan(session.planId);
    if (plan === null) throw new MarkdownImportError("import_session_not_found", "import session was not found");
    return Object.freeze({
      kind: "found" as const,
      session,
      plan: Object.freeze({
        fileCount: plan.files.length,
        descriptorHash: plan.descriptorHash,
        logicalBytes: plan.logicalBytes,
        additions: plan.additions,
        replacements: plan.replacements,
        deletions: plan.deletions,
        unchanged: plan.unchanged,
        projectedUtilization: plan.projectedUtilization,
      }),
    });
  }

  async stageBatch(request: MarkdownImportBatchRequest) {
    const actor = registeredActor(request.actor);
    const session = await this.#ownedSession(actor, request.importId);
    await this.#ensureActiveAuthorization(actor, session.spaceId);
    if (
      !Number.isSafeInteger(Number(request.checkpoint)) || Number(request.checkpoint) < 1 ||
      !Number.isSafeInteger(request.expectedVersion) || Number(request.expectedVersion) < 1 ||
      !Array.isArray(request.files) || request.files.length === 0 ||
      request.files.length > MARKDOWN_IMPORT_LIMITS.maxBatchFiles
    ) throw new MarkdownImportError("invalid_import_request", "import batch envelope is invalid");
    const checkpoint = Number(request.checkpoint);
    const expectedVersion = version(Number(request.expectedVersion));
    const plan = await this.#metadata.readMarkdownImportPlan(session.planId);
    if (plan === null) throw new MarkdownImportError("import_session_not_found", "import session was not found");
    const planned = new Map(plan.files.map((file) => [file.path, file]));
    const validated: {
      path: string;
      sha256: Sha256Digest;
      size: number;
      bytes: Uint8Array;
    }[] = [];
    const failures: MarkdownImportSessionFailure[] = [];
    let batchBytes = 0;
    for (const raw of request.files as MarkdownImportBatchFile[]) {
      try {
        const path = canonicalImportPath(raw.path);
        const sha256 = sha256Digest(String(raw.sha256 ?? ""));
        if (!Number.isSafeInteger(raw.size) || Number(raw.size) < 0 || !(raw.bytes instanceof Uint8Array)) {
          throw new MarkdownImportError("invalid_import_request", "import batch file is invalid");
        }
        const bytes = new Uint8Array(raw.bytes);
        const size = Number(raw.size);
        const expected = planned.get(path);
        if (
          expected === undefined || expected.sha256 !== sha256 || expected.size !== size ||
          bytes.byteLength !== size || await this.#objects.calculateSha256(bytes) !== sha256
        ) throw new MarkdownImportError("import_file_conflict", "staged bytes differ from plan");
        try { DECODER.decode(bytes); } catch {
          failures.push(sessionFailure(path, "invalid_utf8"));
          continue;
        }
        batchBytes += bytes.byteLength;
        validated.push({ path, sha256, size, bytes });
      } catch (error) {
        failures.push(sessionFailure(
          safeFailurePath(raw?.path),
          error instanceof MarkdownImportError ? error.code : "invalid_import_request",
        ));
      }
    }
    if (failures.length > 0) {
      if (failures.some((failure) => failure.code === "invalid_utf8")) {
        await this.#closeForTerminalFailure(session, failures);
      }
      throw new MarkdownImportError("import_validation_failed", "import batch validation failed", failures);
    }
    if (batchBytes > MARKDOWN_IMPORT_LIMITS.maxBatchBytes) {
      throw new MarkdownImportError("import_byte_limit_exceeded", "import batch byte limit exceeded");
    }
    const canonicalRequestHash = await this.#objects.calculateSha256(ENCODER.encode(`${JSON.stringify({
      format: "mind-diary-markdown-import-batch-v1",
      import_id: session.importId,
      checkpoint,
      files: validated.map(({ path, sha256, size }) => ({ path, sha256, size })),
    })}\n`));
    const createdAt = this.#clock.now();
    const stored: MarkdownImportStagedFile[] = [];
    try {
      for (const file of validated) {
        const stagedFileId = this.#ids.nextStagedFileId();
        const put = await this.#objects.putStagedBundleFile({
          stagedFileId,
          bindingOwnerId: opaqueId<"mind-binding-owner">(
            `import-owner_${session.importId}`,
          ) as MindBindingOwnerId,
          spaceId: session.spaceId,
          bytes: file.bytes,
          createdAt,
        });
        if (put.size !== file.size) throw new Error("staged import object size mismatch");
        stored.push(Object.freeze({
          stagedFileId,
          importId: session.importId,
          checkpoint,
          path: file.path,
          sha256: file.sha256,
          size: file.size,
          createdAt,
        }));
      }
      const initial = await this.#authorizer.authorize({
        actor,
        spaceId: session.spaceId,
        capability: "content:write",
        revisionMode: "head",
      });
      if (initial.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: initial });
      const result = await this.#metadata.runMarkdownImportTransaction(async (transaction) => {
        const current = await this.#authorizer.reauthorizeInTransaction({
          actor,
          spaceId: session.spaceId,
          capability: "content:write",
          revisionMode: "head",
        }, transaction, initial.stamp);
        if (current.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: current });
        return transaction.stageMarkdownImportBatch({
          importId: session.importId,
          expectedVersion,
          checkpoint,
          canonicalRequestHash,
          files: Object.freeze(stored),
          failures: Object.freeze([]),
          stagedAt: createdAt,
        });
      });
      if (result.kind !== "staged" || result.replayed) {
        await Promise.all(stored.map((file) =>
          this.#objects.deleteStagedBundleFile(file.stagedFileId).catch(() => false)));
      }
      if (result.kind === "staged") return result;
      if (result.kind === "denied") return result;
      if (result.kind === "checkpoint_conflict") {
        throw new MarkdownImportError("import_checkpoint_conflict", "import checkpoint changed");
      }
      if (result.kind === "idempotency_conflict") {
        throw new MarkdownImportError("import_idempotency_conflict", "import batch differs from replay");
      }
      if (result.kind === "file_conflict") {
        throw new MarkdownImportError("import_file_conflict", "import file was already staged");
      }
      throw new MarkdownImportError("import_state_conflict", "import session is not active");
    } catch (error) {
      await Promise.all(stored.map((file) =>
        this.#objects.deleteStagedBundleFile(file.stagedFileId).catch(() => false)));
      throw error;
    }
  }

  async validate(request: Readonly<{
    actor: ActorContext;
    importId: string;
    expectedVersion: unknown;
  }>) {
    const actor = registeredActor(request.actor);
    const session = await this.#ownedSession(actor, request.importId);
    const initial = await this.#ensureActiveAuthorization(actor, session.spaceId);
    if (session.state === "validated") {
      return Object.freeze({ kind: "validated" as const, session, replayed: true });
    }
    if (!Number.isSafeInteger(Number(request.expectedVersion)) || Number(request.expectedVersion) < 1) {
      throw new MarkdownImportError("invalid_import_request", "import version is invalid");
    }
    const expectedVersion = version(Number(request.expectedVersion));
    const [plan, staged, parent] = await Promise.all([
      this.#metadata.readMarkdownImportPlan(session.planId),
      this.#metadata.listMarkdownImportStagedFiles(session.importId),
      this.#revisions.readHeadRevisionEnvelope(session.spaceId),
    ]);
    if (
      plan === null || parent === null ||
      parent.revision.revisionId !== session.expectedRevisionId
    ) {
      if (plan !== null && parent !== null) {
        await this.#closeForHeadConflict(session);
        throw new MarkdownImportError("import_head_conflict", "import base HEAD changed");
      }
      throw new MarkdownImportError("import_validation_failed", "import plan is unavailable");
    }
    const bundleFiles = parent.manifest.entries
      .filter((entry) => entry.kind === "opaque")
      .map((entry) => Object.freeze({ path: entry.path, mediaType: entry.mediaType }));
    const snapshotFailures = stagedPlanFailures(plan, staged);
    const failures: MarkdownImportSessionFailure[] = [
      ...session.failures,
      ...snapshotFailures,
    ];
    let validationCheckpoint = session.validationCheckpoint;
    let validatedBytes = session.validatedBytes;
    let validationBytes = 0;
    let examined = 0;
    for (const file of staged.slice(validationCheckpoint)) {
      if (
        examined >= MARKDOWN_IMPORT_LIMITS.maxValidationFiles ||
        (examined > 0 && validationBytes + file.size > MARKDOWN_IMPORT_LIMITS.maxValidationBytes)
      ) break;
      const object = await this.#objects.getStagedBundleFile(file.stagedFileId);
      if (
        object === null || object.spaceId !== session.spaceId || object.size !== file.size ||
        object.bytes.byteLength !== file.size ||
        await this.#objects.calculateSha256(object.bytes) !== file.sha256
      ) {
        failures.push(sessionFailure(file.path, "staged_object_integrity_failure"));
      } else {
        const text = DECODER.decode(object.bytes);
        const parsed = parseOkfFile({ path: file.path, text });
        for (const diagnostic of parsed.diagnostics) {
          if (diagnostic.severity === "error") failures.push(sessionFailure(file.path, diagnostic.code));
        }
        const references = analyzeBundleFileReferences({
          markdown: Object.freeze([Object.freeze({ path: file.path, text })]),
          bundleFiles,
        });
        for (const diagnostic of references.diagnostics) {
          if (diagnostic.severity === "error") failures.push(sessionFailure(file.path, diagnostic.code));
        }
      }
      examined += 1;
      validationCheckpoint += 1;
      validationBytes += file.size;
      validatedBytes += file.size;
      if (failures.length >= MARKDOWN_IMPORT_LIMITS.maxFailures) break;
    }
    const complete = validationCheckpoint === plan.files.length;
    const targetState = failures.length > 0
      ? "validation_failed" as const
      : complete
        ? "validated" as const
        : "validating" as const;
    const result = await this.#metadata.runMarkdownImportTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction({
        actor,
        spaceId: session.spaceId,
        capability: "content:write",
        revisionMode: "head",
      }, transaction, initial.stamp);
      if (current.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: current });
      const transitioned = await transaction.transitionMarkdownImportSession({
        importId: session.importId,
        expectedVersion,
        from: Object.freeze(["active", "validating"]),
        to: targetState,
        updatedAt: this.#clock.now(),
        failures: Object.freeze(failures.slice(0, MARKDOWN_IMPORT_LIMITS.maxFailures)),
        validationCheckpoint,
        validatedBytes,
      });
      if (transitioned.kind !== "updated") {
        throw new MarkdownImportError("import_state_conflict", "import session changed during validation");
      }
      if (targetState === "validation_failed") {
        const canceled = await transaction.cancelCapacityReservation({
          reservationId: session.reservationId,
          canceledAt: transitioned.session.updatedAt,
        });
        if (canceled !== "cleanup_pending") {
          throw new Error("Markdown import validation cleanup was not scheduled");
        }
      }
      return Object.freeze({
        kind: targetState === "validated"
          ? "validated" as const
          : targetState === "validating"
            ? "validation_progress" as const
            : "validation_failed" as const,
        session: transitioned.session,
        replayed: false,
      });
    });
    if (result.kind === "validation_failed") {
      throw new MarkdownImportError(
        "import_validation_failed",
        "whole-corpus validation failed",
        result.session.failures,
      );
    }
    return result;
  }

  async commit(request: Readonly<{
    actor: ActorContext;
    importId: string;
    expectedVersion: unknown;
    summary?: unknown;
  }>) {
    const actor = registeredActor(request.actor);
    const session = await this.#ownedSession(actor, request.importId);
    const initial = await this.#ensureActiveAuthorization(actor, session.spaceId);
    if (session.state === "committed" && session.revisionId !== null) {
      return Object.freeze({ kind: "committed" as const, revisionId: session.revisionId, replayed: true });
    }
    if (!Number.isSafeInteger(request.expectedVersion) || Number(request.expectedVersion) < 1) {
      throw new MarkdownImportError("invalid_import_request", "import version is invalid");
    }
    const expectedVersion = version(Number(request.expectedVersion));
    const summary = request.summary === undefined ? "Import Markdown snapshot" : request.summary;
    if (typeof summary !== "string" || summary.length < 1 || summary.length > 240 || CONTROL.test(summary)) {
      throw new MarkdownImportError("invalid_import_request", "import summary is invalid");
    }
    const [plan, staged, parent] = await Promise.all([
      this.#metadata.readMarkdownImportPlan(session.planId),
      this.#metadata.listMarkdownImportStagedFiles(session.importId),
      this.#revisions.readHeadRevisionEnvelope(session.spaceId),
    ]);
    if (plan !== null && parent !== null && parent.revision.revisionId !== session.expectedRevisionId) {
      const closed = await this.#closeForHeadConflict(session);
      if (closed?.state === "committed" && closed.revisionId !== null) {
        return Object.freeze({ kind: "committed" as const, revisionId: closed.revisionId, replayed: true });
      }
      throw new MarkdownImportError("import_head_conflict", "validated import base changed");
    }
    if (plan === null || parent === null) {
      throw new MarkdownImportError("import_validation_failed", "validated import state is unavailable");
    }
    const snapshotFailures = stagedPlanFailures(plan, staged);
    if (
      snapshotFailures.length > 0 || staged.length !== plan.files.length ||
      session.validationCheckpoint !== plan.files.length ||
      session.validatedBytes !== plan.logicalBytes ||
      session.promotionCheckpoint > plan.files.length ||
      session.promotedBytes > plan.logicalBytes
    ) {
      throw new MarkdownImportError(
        "import_validation_failed",
        "validated staged snapshot differs from the immutable plan",
        snapshotFailures,
      );
    }
    if (session.state !== "validated" && session.state !== "finalizing") {
      throw new MarkdownImportError("import_state_conflict", "import session is not ready to finalize");
    }
    const committedAt = this.#clock.now();
    let promotionCheckpoint = session.promotionCheckpoint;
    let promotedBytes = session.promotedBytes;
    let promotionBytes = 0;
    let promotedFiles = 0;
    for (const file of staged.slice(promotionCheckpoint)) {
      if (
        promotedFiles >= MARKDOWN_IMPORT_LIMITS.maxPromotionFiles ||
        (promotedFiles > 0 && promotionBytes + file.size > MARKDOWN_IMPORT_LIMITS.maxPromotionBytes)
      ) break;
      const object = await this.#objects.getStagedBundleFile(file.stagedFileId);
      if (
        object === null || object.spaceId !== session.spaceId || object.size !== file.size ||
        await this.#objects.calculateSha256(object.bytes) !== file.sha256
      ) throw new MarkdownImportError("import_validation_failed", "staged import object changed");
      const put = await this.#objects.putSpaceCanonicalObject({
        kind: "markdown",
        spaceId: session.spaceId,
        bytes: object.bytes,
        mediaType: MARKDOWN_MEDIA_TYPE,
        createdAt: committedAt,
      });
      if (put.object.sha256 !== file.sha256 || put.object.size !== file.size) {
        throw new MarkdownImportError("import_validation_failed", "promoted import object changed");
      }
      promotedFiles += 1;
      promotionCheckpoint += 1;
      promotionBytes += file.size;
      promotedBytes += file.size;
    }
    if (promotionCheckpoint < staged.length) {
      const progress = await this.#metadata.runMarkdownImportTransaction(async (transaction) => {
        const current = await this.#authorizer.reauthorizeInTransaction({
          actor,
          spaceId: session.spaceId,
          capability: "content:write",
          revisionMode: "head",
        }, transaction, initial.stamp);
        if (current.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: current });
        const currentSession = await transaction.readMarkdownImportSession(session.importId);
        if (
          currentSession === null || currentSession.version !== expectedVersion ||
          (currentSession.state !== "validated" && currentSession.state !== "finalizing")
        ) throw new MarkdownImportError("import_state_conflict", "import session changed during finalization");
        if (await transaction.readHead(session.spaceId) !== session.expectedRevisionId) {
          return Object.freeze({ kind: "head_conflict" as const });
        }
        const transitioned = await transaction.transitionMarkdownImportSession({
          importId: session.importId,
          expectedVersion,
          from: Object.freeze(["validated", "finalizing"]),
          to: "finalizing",
          updatedAt: committedAt,
          promotionCheckpoint,
          promotedBytes,
        });
        if (transitioned.kind !== "updated") {
          throw new MarkdownImportError("import_state_conflict", "import finalization checkpoint changed");
        }
        return Object.freeze({
          kind: "commit_progress" as const,
          session: transitioned.session,
          replayed: false,
        });
      });
      if (progress.kind === "head_conflict") {
        const closed = await this.#closeForHeadConflict(session);
        if (closed?.state === "committed" && closed.revisionId !== null) {
          return Object.freeze({ kind: "committed" as const, revisionId: closed.revisionId, replayed: true });
        }
        throw new MarkdownImportError("import_head_conflict", "import base HEAD changed");
      }
      return progress;
    }
    if (promotedBytes !== plan.logicalBytes) {
      throw new MarkdownImportError("import_validation_failed", "promoted import byte count differs from plan");
    }
    const entries: RevisionManifestEntry[] = staged.map((file) => Object.freeze({
      kind: "markdown" as const,
      path: file.path,
      sha256: file.sha256,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: file.size,
    }));
    const markdownPaths = new Set(entries.map((entry) => entry.path));
    for (const entry of parent.manifest.entries) {
      if (entry.kind !== "opaque") continue;
      if (markdownPaths.has(entry.path)) {
        throw new MarkdownImportError("import_file_conflict", "Markdown collides with retained opaque path");
      }
      entries.push(entry);
    }
    const manifest = createRevisionManifest(entries, REVISION_MANIFEST_FORMAT_V5);
    const manifestBytes = ENCODER.encode(serializeRevisionManifest(manifest));
    const manifestPut = await this.#objects.putSpaceCanonicalObject({
      kind: "revision_manifest",
      spaceId: session.spaceId,
      bytes: manifestBytes,
      mediaType: REVISION_MANIFEST_MEDIA_TYPE,
      createdAt: committedAt,
    });
    const revisionId = this.#revisionIds.nextRevisionId();
    const envelope = createCanonicalRevisionEnvelope({
      revisionId,
      spaceId: session.spaceId,
      revisionNumber: parent.revision.revisionNumber + 1,
      parentRevisionId: session.expectedRevisionId,
      committedAt,
      committedBy: Object.freeze({ kind: "principal" as const, principalId: actor.principalId }),
      manifest,
      manifestHash: manifestPut.object.sha256,
      manifestSize: manifestPut.object.size,
      summary,
    });
    const committed = await this.#metadata.runMarkdownImportTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction({
        actor,
        spaceId: session.spaceId,
        capability: "content:write",
        revisionMode: "head",
      }, transaction, initial.stamp);
      if (current.kind === "denied") return Object.freeze({ kind: "denied" as const, decision: current });
      const currentSession = await transaction.readMarkdownImportSession(session.importId);
      if (
        currentSession === null || currentSession.version !== expectedVersion ||
        (currentSession.state !== "validated" && currentSession.state !== "finalizing")
      ) throw new MarkdownImportError("import_state_conflict", "import session changed before commit");
      if (await transaction.readHead(session.spaceId) !== session.expectedRevisionId) {
        return Object.freeze({ kind: "head_conflict" as const });
      }
      const committed = await transaction.commitRevision({
        expectedHeadRevisionId: session.expectedRevisionId,
        envelope,
      });
      if (committed.kind === "stale_head") {
        return Object.freeze({ kind: "head_conflict" as const });
      }
      if (committed.kind !== "committed" || committed.replayed) {
        throw new Error(`Markdown import revision commit failed: ${committed.kind}`);
      }
      const transitioned = await transaction.transitionMarkdownImportSession({
        importId: session.importId,
        expectedVersion,
        from: Object.freeze(["validated", "finalizing"]),
        to: "committed",
        updatedAt: committedAt,
        failures: Object.freeze([]),
        promotionCheckpoint,
        promotedBytes,
        revisionId,
      });
      if (transitioned.kind !== "updated") throw new Error("Markdown import session commit was not atomic");
      const canceled = await transaction.cancelCapacityReservation({
        reservationId: session.reservationId,
        canceledAt: committedAt,
      });
      if (canceled !== "cleanup_pending") throw new Error("Markdown import capacity cleanup was not scheduled");
      const auditEventId = this.#effectIds.nextAuditEventId();
      const outboxMessageId = this.#effectIds.nextOutboxMessageId();
      const indexJobId = this.#effectIds.nextIndexJobId();
      const effects = await transaction.stageContentCommitEffects({
        auditEvent: Object.freeze({
          auditEventId,
          actor: Object.freeze({ kind: "principal" as const, principalId: actor.principalId }),
          requestId: actor.requestId,
          eventType: "content.changeset_committed",
          outcome: "succeeded",
          spaceId: session.spaceId,
          occurredAt: committedAt,
          safeMetadata: Object.freeze({
            revision_id: revisionId,
            previous_revision_id: session.expectedRevisionId,
            revision_number: envelope.revision.revisionNumber,
            manifest_hash: envelope.revision.manifestHash,
          }),
        }),
        auditOutbox: Object.freeze({
          outboxMessageId,
          auditEventId,
          state: "pending",
          version: version(1),
          attempts: 0,
          availableAt: committedAt,
          claimExpiresAt: null,
          createdAt: committedAt,
          updatedAt: committedAt,
        }),
        indexJob: Object.freeze({
          jobId: indexJobId,
          target: Object.freeze({ kind: "revision_index" as const, spaceId: session.spaceId, revisionId }),
          state: "queued",
          version: version(1),
          attempts: 0,
          availableAt: committedAt,
          claimExpiresAt: null,
          createdAt: committedAt,
          updatedAt: committedAt,
        }),
        indexState: Object.freeze({
          spaceId: session.spaceId,
          revisionId,
          status: "queued",
          attempts: 0,
          queuedAt: committedAt,
          updatedAt: committedAt,
          readyAt: null,
          lastFailureCode: null,
        }),
      });
      if (effects.kind !== "staged") throw new Error("Markdown import commit effects failed");
      return Object.freeze({ kind: "committed" as const, revisionId, replayed: false });
    });
    if (committed.kind === "head_conflict") {
      const closed = await this.#closeForHeadConflict(session);
      if (closed?.state === "committed" && closed.revisionId !== null) {
        return Object.freeze({ kind: "committed" as const, revisionId: closed.revisionId, replayed: true });
      }
      throw new MarkdownImportError("import_head_conflict", "import base HEAD changed");
    }
    return committed;
  }

  async cancel(actorValue: ActorContext, importId: string, expectedVersionValue: unknown) {
    const actor = registeredActor(actorValue);
    const session = await this.#ownedSession(actor, importId);
    if (!Number.isSafeInteger(expectedVersionValue) || Number(expectedVersionValue) < 1) {
      throw new MarkdownImportError("invalid_import_request", "import version is invalid");
    }
    const expectedVersion = version(Number(expectedVersionValue));
    return this.#metadata.runMarkdownImportTransaction(async (transaction) => {
      const transitioned = await transaction.transitionMarkdownImportSession({
        importId: session.importId,
        expectedVersion,
        from: Object.freeze(["active", "validating", "validated", "finalizing"]),
        to: "canceled",
        updatedAt: this.#clock.now(),
      });
      if (transitioned.kind !== "updated") {
        if (session.state === "canceled" || session.state === "expired") {
          return Object.freeze({ kind: "canceled" as const, session, replayed: true });
        }
        throw new MarkdownImportError("import_state_conflict", "import session cannot be canceled");
      }
      const canceled = await transaction.cancelCapacityReservation({
        reservationId: session.reservationId,
        canceledAt: transitioned.session.updatedAt,
      });
      if (canceled !== "cleanup_pending") throw new Error("Markdown import cleanup was not scheduled");
      return Object.freeze({ kind: "canceled" as const, session: transitioned.session, replayed: false });
    });
  }

  async collectExpired(request: Readonly<{
    maxSessions?: number;
    maxFiles?: number;
    maxBytes?: number;
    maxDurationMs?: number;
  }> = {}) {
    const now = this.#clock.now();
    const maxSessions = Math.max(1, Math.min(16, request.maxSessions ?? 4));
    const maxFiles = Math.max(1, Math.min(
      MARKDOWN_IMPORT_LIMITS.cleanupMaxFiles,
      request.maxFiles ?? MARKDOWN_IMPORT_LIMITS.cleanupMaxFiles,
    ));
    const maxBytes = Math.max(1, Math.min(
      MARKDOWN_IMPORT_LIMITS.cleanupMaxBytes,
      request.maxBytes ?? MARKDOWN_IMPORT_LIMITS.cleanupMaxBytes,
    ));
    const maxDurationMs = Number.isSafeInteger(request.maxDurationMs) && Number(request.maxDurationMs) > 0
      ? Math.min(Number(request.maxDurationMs), MARKDOWN_IMPORT_LIMITS.cleanupMaxDurationMs)
      : MARKDOWN_IMPORT_LIMITS.cleanupMaxDurationMs;
    const deadline = Date.parse(now) + maxDurationMs;
    let timedOut = false;
    const reachedDeadline = () => {
      if (timedOut) return true;
      timedOut = Date.parse(this.#clock.now()) >= deadline;
      return timedOut;
    };
    const claimed = await this.#metadata.runMarkdownImportTransaction((transaction) =>
      transaction.claimMarkdownImportCleanup({ now, limit: maxSessions }));
    const expiredPlans = await this.#metadata.runMarkdownImportTransaction((transaction) =>
      transaction.deleteExpiredMarkdownImportPlans({ now, limit: Math.min(1_000, maxFiles) }));
    let examined = 0;
    let deleted = 0;
    let reclaimedBytes = 0;
    for (const item of claimed) {
      for (const file of item.files) {
        if (reachedDeadline() || examined >= maxFiles || reclaimedBytes + file.size > maxBytes) break;
        examined += 1;
        const current = await this.#objects.getStagedBundleFile(file.stagedFileId);
        if (current !== null) {
          await this.#objects.deleteStagedBundleFile(file.stagedFileId);
          reclaimedBytes += file.size;
          deleted += 1;
        }
        await this.#metadata.runMarkdownImportTransaction((transaction) =>
          transaction.deleteMarkdownImportStagedFile(file.stagedFileId));
        if (reachedDeadline()) break;
      }
      const remaining = await this.#metadata.listMarkdownImportStagedFiles(item.session.importId);
      if (!timedOut && remaining.length === 0) {
        const current = await this.#metadata.readMarkdownImportSession(item.session.importId);
        if (current !== null) {
          await this.#metadata.runMarkdownImportTransaction((transaction) =>
            transaction.completeMarkdownImportCleanup({
              importId: current.importId,
              expectedVersion: current.version,
              completedAt: this.#clock.now(),
            }));
        }
      }
      if (timedOut || examined >= maxFiles || reclaimedBytes >= maxBytes) break;
    }
    return Object.freeze({
      sessions: claimed.length,
      expiredPlans,
      examined,
      deleted,
      reclaimedBytes,
      timedOut,
    });
  }

  async #closeForHeadConflict(session: Readonly<MarkdownImportSession>) {
    return this.#closeForTerminalFailure(session, Object.freeze([
      sessionFailure("(snapshot)", "import_head_conflict"),
    ]));
  }

  async #closeForTerminalFailure(
    session: Readonly<MarkdownImportSession>,
    terminalFailures: readonly Readonly<MarkdownImportSessionFailure>[],
  ) {
    const closedAt = this.#clock.now();
    return this.#metadata.runMarkdownImportTransaction(async (transaction) => {
      const current = await transaction.readMarkdownImportSession(session.importId);
      if (current === null) return null;
      if (
        current.state !== "active" && current.state !== "validating" &&
        current.state !== "validated" && current.state !== "finalizing"
      ) return current;
      const failures = Object.freeze([
        ...current.failures,
        ...terminalFailures,
      ].slice(0, MARKDOWN_IMPORT_LIMITS.maxFailures));
      const transitioned = await transaction.transitionMarkdownImportSession({
        importId: current.importId,
        expectedVersion: current.version,
        from: Object.freeze(["active", "validating", "validated", "finalizing"]),
        to: "validation_failed",
        updatedAt: closedAt,
        failures,
      });
      if (transitioned.kind !== "updated") {
        return transaction.readMarkdownImportSession(current.importId);
      }
      const canceled = await transaction.cancelCapacityReservation({
        reservationId: transitioned.session.reservationId,
        canceledAt: closedAt,
      });
      if (canceled !== "cleanup_pending") {
        throw new Error("Markdown import terminal cleanup was not scheduled");
      }
      return transitioned.session;
    });
  }

  async #ownedSession(
    actor: Extract<ActorContext, { readonly kind: "registered_principal" }>,
    importId: string,
  ) {
    if (typeof importId !== "string" || importId.length === 0 || importId.length > 256) {
      throw new MarkdownImportError("import_session_not_found", "import session was not found");
    }
    const session = await this.#metadata.readMarkdownImportSession(importId);
    if (session === null || session.principalId !== actor.principalId) {
      throw new MarkdownImportError("import_session_not_found", "import session was not found");
    }
    if (
      (session.state === "active" || session.state === "validating" ||
        session.state === "validated" || session.state === "finalizing") &&
      Date.parse(session.expiresAt) <= Date.parse(this.#clock.now())
    ) throw new MarkdownImportError("import_session_expired", "import session expired");
    return session;
  }

  async #ensureActiveAuthorization(
    actor: Extract<ActorContext, { readonly kind: "registered_principal" }>,
    spaceId: SpaceId,
  ) {
    const authorization = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability: "content:write",
      revisionMode: "head",
    });
    if (authorization.kind === "denied") {
      throw new MarkdownImportError("import_session_not_found", "import session was not found");
    }
    return authorization;
  }
}
