import type {
  ActorContext,
  McpTokenActorContext,
  RequestId,
} from "@mind-diary/application-contracts";
import {
  ObjectStoreFailure,
  type Clock,
  type CurrentAuthorizationToken,
  type McpTokenStore,
  type ObjectStore,
  type BundleFileObjectStore,
  type PilotCohort,
  type PrivacySafeObservabilityEvent,
  type PrivacySafeObservabilitySink,
  type RevisionMetadataStore,
  type SearchIndex,
  type TokenHasher,
} from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  canonicalMarkdownPath,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  utcInstant,
  type CanonicalRevisionEnvelope,
  type Capability,
  type EffectiveTokenScopes,
  type MarkdownMediaType,
  type BundleFileMediaType,
  type MindBindingOwnerId,
  type RevisionAuthorReference,
  type RevisionId,
  type Sha256Digest,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";
import type { OkfBundleFixture } from "@mind-diary/okf-codec";

export * from "./mind-discovery.js";
export * from "./mind-browse.js";
export * from "./mind-history.js";
export * from "./mind-bindings.js";
export * from "./automatic-capture.js";
export * from "./mind-search.js";
export * from "./mind-validation.js";
export * from "./bundle-file-references.js";
export * from "./bundle-file-downloads.js";

export const CONTENT_QUERIES = [
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "get_mind_bindings",
  "browse_entries",
  "search_entries",
  "fetch_entry",
  "list_revisions",
  "get_revision",
  "validate_revision",
  "list_bundle_files",
  "get_export_status",
] as const;

export const CONTENT_COMMANDS = [
  "set_read_mind_binding",
  "set_write_mind_binding",
  "stage_bundle_file",
  "get_bundle_file_download",
  "capture_knowledge",
  "commit_changeset",
  "start_export",
] as const;

export type McpObservabilityOutcome =
  | "authenticated"
  | "authentication_failed"
  | "authentication_unavailable"
  | "protocol_error"
  | "tool_denied"
  | "tool_completed"
  | "internal_error";

export type McpPerformanceProfile = "mcp_modern" | "mcp_compatibility";
export type McpPerformanceStage =
  | "stage_authentication"
  | "stage_application"
  | "stage_total";
export type McpPerformanceTool =
  | "list_minds"
  | "resolve_mind"
  | "get_mind_info"
  | "get_mind_bindings"
  | "browse_entries"
  | "search"
  | "fetch"
  | "list_revisions"
  | "get_revision"
  | "validate_mind"
  | "list_bundle_files"
  | "get_bundle_file_download"
  | "set_read_mind_binding"
  | "set_write_mind_binding"
  | "stage_bundle_file"
  | "commit_changeset"
  | "capture_knowledge"
  | "start_export"
  | "get_export_status";

function recordContentMetric(
  sink: PrivacySafeObservabilitySink,
  event: Readonly<PrivacySafeObservabilityEvent>,
): void {
  try {
    const pending = sink.record(Object.freeze(event));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Telemetry is best-effort and never changes content/auth outcomes.
  }
}

/**
 * Explicit content/MCP telemetry boundary. It accepts only controlled
 * dimensions; callers cannot pass query text, corpus bodies, URLs, or tokens.
 */
export class ContentPrivacySafeObservability {
  readonly #sink: PrivacySafeObservabilitySink;
  readonly #cohort: PilotCohort;

  constructor(dependencies: {
    readonly sink: PrivacySafeObservabilitySink;
    readonly cohort: PilotCohort;
  }) {
    this.#sink = dependencies.sink;
    this.#cohort = dependencies.cohort;
  }

  recordMcpRequest(event: {
    readonly requestId: RequestId;
    readonly occurredAtUtc: UtcInstant;
    readonly durationMs: number;
    readonly status: number;
    readonly outcome: McpObservabilityOutcome;
    readonly profile?: McpPerformanceProfile;
  }): void {
    recordContentMetric(this.#sink, {
      kind: "operational",
      metric: "request_latency_ms",
      surface: "mcp",
      operation: "request",
      outcome: event.status >= 400 ? "failure" : "success",
      unit: "milliseconds",
      value: event.durationMs,
      occurredAtUtc: event.occurredAtUtc,
      requestId: event.requestId,
      jobId: null,
      cohort: null,
    });
    if (event.status >= 400 || event.outcome === "internal_error") {
      recordContentMetric(this.#sink, {
        kind: "operational",
        metric: "request_error",
        surface: "mcp",
        operation: "request",
        outcome: event.outcome === "tool_denied" ? "denied" : "failure",
        unit: "count",
        value: 1,
        occurredAtUtc: event.occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    }
    if (event.outcome.startsWith("authentication_")) {
      recordContentMetric(this.#sink, {
        kind: "operational",
        metric: "authentication_outcome",
        surface: "mcp",
        operation: "authentication",
        outcome:
          event.outcome === "authentication_failed" ? "denied" : "failure",
        unit: "count",
        value: 1,
        occurredAtUtc: event.occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    } else if (event.outcome === "authenticated") {
      recordContentMetric(this.#sink, {
        kind: "operational",
        metric: "authentication_outcome",
        surface: "mcp",
        operation: "authentication",
        outcome: "success",
        unit: "count",
        value: 1,
        occurredAtUtc: event.occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    }
    if (event.status === 429) {
      recordContentMetric(this.#sink, {
        kind: "operational",
        metric: "rate_limit",
        surface: "mcp",
        operation: "rate_limit",
        outcome: "rate_limited",
        unit: "count",
        value: 1,
        occurredAtUtc: event.occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    }
    if (event.profile !== undefined) {
      this.recordMcpPerformance({
        requestId: event.requestId,
        occurredAtUtc: event.occurredAtUtc,
        durationMs: event.durationMs,
        profile: event.profile,
        stage: "stage_total",
        tool: null,
        outcome: event.status >= 400 ? "failure" : "success",
      });
    }
  }

  /**
   * Emits only closed categorical route/tool/stage dimensions. Correlation is
   * the existing opaque request ID; query, selector, path and content never
   * cross this boundary.
   */
  recordMcpPerformance(event: {
    readonly requestId: RequestId;
    readonly occurredAtUtc: UtcInstant;
    readonly durationMs: number;
    readonly profile: McpPerformanceProfile;
    readonly stage: McpPerformanceStage;
    readonly tool: McpPerformanceTool | null;
    readonly outcome: "success" | "failure";
  }): void {
    const operations = [
      event.profile,
      event.stage,
      ...(event.tool === null ? [] : [event.tool]),
    ] as const;
    for (const operation of operations) {
      recordContentMetric(this.#sink, {
        kind: "operational",
        metric: "request_latency_ms",
        surface: "mcp",
        operation,
        outcome: event.outcome,
        unit: "milliseconds",
        value: event.durationMs,
        occurredAtUtc: event.occurredAtUtc,
        requestId: event.requestId,
        jobId: null,
        cohort: null,
      });
    }
  }

  recordCasConflict(actor: Pick<ActorContext, "requestId" | "occurredAtUtc">): void {
    recordContentMetric(this.#sink, {
      kind: "operational",
      metric: "cas_conflict",
      surface: "content",
      operation: "commit_changeset",
      outcome: "conflict",
      unit: "count",
      value: 1,
      occurredAtUtc: actor.occurredAtUtc,
      requestId: actor.requestId,
      jobId: null,
      cohort: null,
    });
  }

  recordPilot(event: {
    readonly actor: Pick<ActorContext, "requestId" | "occurredAtUtc">;
    readonly metric:
      | "time_to_first_useful_search_ms"
      | "time_to_first_meaningful_commit_ms"
      | "usage"
      | "lexical_search_effectiveness"
      | "citation_success";
    readonly operation: "search" | "commit_changeset" | "read" | "write" | "history" | "export" | "citation";
    readonly outcome: "completed" | "resolved" | "unresolved";
    readonly value: number;
  }): void {
    const unit =
      event.metric.endsWith("_ms")
        ? "milliseconds"
        : event.metric === "usage"
          ? "count"
          : "ratio";
    recordContentMetric(this.#sink, {
      kind: "pilot",
      metric: event.metric,
      surface: "content",
      operation: event.operation,
      outcome: event.outcome,
      unit,
      value: event.value,
      occurredAtUtc: event.actor.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: null,
      cohort: this.#cohort,
    });
  }

  recordCost(event: {
    readonly actor: Pick<ActorContext, "requestId" | "occurredAtUtc">;
    readonly metric: "storage_cost_bytes" | "query_cost_units";
    readonly value: number;
  }): void {
    recordContentMetric(this.#sink, {
      kind: "operational",
      metric: event.metric,
      surface: "content",
      operation: event.metric === "storage_cost_bytes" ? "storage" : "search",
      outcome: "success",
      unit: event.metric === "storage_cost_bytes" ? "bytes" : "query_units",
      value: event.value,
      occurredAtUtc: event.actor.occurredAtUtc,
      requestId: event.actor.requestId,
      jobId: null,
      cohort: null,
    });
  }
}

export const MCP_CONTENT_DEPLOYMENT_CAPABILITIES = Object.freeze(
  CAPABILITIES.filter((capability) => capability.startsWith("content:")),
) as readonly Capability[];

const INVALID_MCP_AUTHENTICATION = Object.freeze({ kind: "invalid" } as const);

export type McpBearerAuthenticationResult =
  | {
      readonly kind: "authenticated";
      readonly actor: McpTokenActorContext;
    }
  | { readonly kind: "invalid" };

export interface McpBearerAuthenticator {
  /** Raw bearer material is consumed here and never returned downstream. */
  authenticate(
    candidate: unknown,
    requestId: RequestId,
  ): Promise<McpBearerAuthenticationResult>;
}

export interface McpBearerAuthenticationDependencies {
  readonly clock: Clock;
  readonly tokenHasher: TokenHasher;
  readonly tokens: McpTokenStore;
  readonly deploymentCapabilities?: readonly Capability[];
}

function normalizeMcpDeploymentCapabilities(
  configured: readonly Capability[] | undefined,
): readonly Capability[] {
  if (configured === undefined) return MCP_CONTENT_DEPLOYMENT_CAPABILITIES;
  if (!Array.isArray(configured)) return Object.freeze([]);
  const requested = new Set<unknown>(configured);
  return Object.freeze(
    MCP_CONTENT_DEPLOYMENT_CAPABILITIES.filter((capability) =>
      requested.has(capability),
    ),
  );
}

function validEffectiveScopes(value: unknown): value is EffectiveTokenScopes {
  return (
    Array.isArray(value) &&
    ((value.length === 1 && value[0] === "content:read") ||
      (value.length === 2 &&
        value[0] === "content:read" &&
        value[1] === "content:write"))
  );
}

function validAuthenticatedToken(
  token: Readonly<CurrentAuthorizationToken>,
  occurredAtUtc: string,
): boolean {
  const expiresAt = Date.parse(token.expiresAt);
  const occurredAt = Date.parse(occurredAtUtc);
  return (
    typeof token.tokenId === "string" &&
    token.tokenId.length > 0 &&
    typeof token.principalId === "string" &&
    token.principalId.length > 0 &&
    token.state === "active" &&
    validEffectiveScopes(token.scopes) &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(occurredAt) &&
    expiresAt > occurredAt
  );
}

/** Request-scoped MCP authentication entry point owned by the content application. */
export class McpBearerAuthenticationService implements McpBearerAuthenticator {
  readonly #clock: Clock;
  readonly #tokenHasher: TokenHasher;
  readonly #tokens: McpTokenStore;
  readonly #deploymentCapabilities: readonly Capability[];

  constructor(dependencies: McpBearerAuthenticationDependencies) {
    this.#clock = dependencies.clock;
    this.#tokenHasher = dependencies.tokenHasher;
    this.#tokens = dependencies.tokens;
    this.#deploymentCapabilities = normalizeMcpDeploymentCapabilities(
      dependencies.deploymentCapabilities,
    );
  }

  async authenticate(
    candidate: unknown,
    requestId: RequestId,
  ): Promise<McpBearerAuthenticationResult> {
    const occurredAtUtc = this.#clock.now();
    const verification = await this.#tokenHasher.verifySecret(
      candidate,
      this.#tokens,
    );
    if (verification.kind !== "verified") return INVALID_MCP_AUTHENTICATION;

    const token = verification.value;
    if (!validAuthenticatedToken(token, occurredAtUtc)) {
      return INVALID_MCP_AUTHENTICATION;
    }

    return Object.freeze({
      kind: "authenticated",
      actor: Object.freeze({
        kind: "registered_principal",
        principalId: token.principalId,
        authentication: Object.freeze({
          kind: "mcp_token",
          tokenId: token.tokenId,
          bindingOwnerId: token.tokenId as unknown as MindBindingOwnerId,
          effectiveScopes: Object.freeze([...token.scopes]) as EffectiveTokenScopes,
        }),
        deploymentCapabilities: this.#deploymentCapabilities,
        requestId,
        occurredAtUtc,
      }),
    });
  }
}

export interface ContentBoundaryMarker {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly objectStore: ObjectStore;
  readonly searchIndex: SearchIndex;
  readonly fixtureOnlyBundle?: OkfBundleFixture;
}

export interface CanonicalRevisionFileInput {
  readonly path: string;
  readonly mediaType: MarkdownMediaType;
  readonly bytes: Uint8Array;
}

export interface CommitCanonicalRevisionRequest {
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId | null;
  /** Stable server-issued ID makes an exact low-level retry idempotent. */
  readonly revisionId: RevisionId;
  readonly committedAt: UtcInstant | string;
  readonly committedBy: RevisionAuthorReference;
  readonly summary: string;
  readonly files: readonly CanonicalRevisionFileInput[];
}

export type CommitCanonicalRevisionResult =
  | {
      readonly kind: "committed";
      readonly envelope: Readonly<CanonicalRevisionEnvelope>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "stale_head";
      readonly currentHeadRevisionId: RevisionId | null;
    };

export type CanonicalRevisionErrorCode =
  | "invalid_file"
  | "invalid_utf8"
  | "parent_not_found"
  | "revision_id_collision"
  | "invalid_revision_chain"
  | "revision_not_found"
  | "manifest_integrity_failure"
  | "object_not_found"
  | "object_integrity_failure"
  | "invalid_gc_limit";

export class CanonicalRevisionError extends Error {
  readonly code: CanonicalRevisionErrorCode;

  constructor(code: CanonicalRevisionErrorCode, message: string) {
    super(message);
    this.name = "CanonicalRevisionError";
    this.code = code;
  }
}

export interface MaterializedMarkdownRevisionFile {
  readonly kind: "markdown";
  readonly path: string;
  readonly mediaType: MarkdownMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface MaterializedOpaqueRevisionFile {
  readonly kind: "opaque";
  readonly path: string;
  readonly mediaType: BundleFileMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export type MaterializedRevisionFile =
  | MaterializedMarkdownRevisionFile
  | MaterializedOpaqueRevisionFile;

export interface MaterializedRevision {
  readonly envelope: Readonly<CanonicalRevisionEnvelope>;
  readonly files: readonly Readonly<MaterializedRevisionFile>[];
}

export interface HeadRevisionReader {
  /** Returns the exact current HEAD, or null when the Mind has no revision yet. */
  readHeadRevision(spaceId: SpaceId): Promise<Readonly<MaterializedRevision> | null>;
}

export interface UnreachableObjectCollectionResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly deletedDigests: readonly Sha256Digest[];
}

interface ValidatedFile {
  readonly path: string;
  readonly mediaType: MarkdownMediaType;
  readonly bytes: Uint8Array;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CanonicalRevisionError(
      "invalid_utf8",
      "canonical revision files must contain valid UTF-8 bytes",
    );
  }
}

function validateFiles(
  files: readonly CanonicalRevisionFileInput[],
): readonly ValidatedFile[] {
  if (!Array.isArray(files)) {
    throw new CanonicalRevisionError("invalid_file", "revision files must be an array");
  }
  const seen = new Set<string>();
  return files.map((file) => {
    if (
      typeof file !== "object" ||
      file === null ||
      !(file.bytes instanceof Uint8Array)
    ) {
      throw new CanonicalRevisionError(
        "invalid_file",
        "each revision file must provide Uint8Array bytes",
      );
    }
    const path = canonicalMarkdownPath(file.path);
    if (seen.has(path)) {
      throw new CanonicalRevisionError(
        "invalid_file",
        `duplicate revision path ${JSON.stringify(path)}`,
      );
    }
    seen.add(path);
    if (file.mediaType !== MARKDOWN_MEDIA_TYPE) {
      throw new CanonicalRevisionError(
        "invalid_file",
        `canonical revision media type must be ${MARKDOWN_MEDIA_TYPE}`,
      );
    }
    const bytes = new Uint8Array(file.bytes);
    decodeUtf8(bytes);
    return Object.freeze({ path, mediaType: MARKDOWN_MEDIA_TYPE, bytes });
  });
}

export class CanonicalRevisionCoordinator {
  readonly #objects: ObjectStore;
  readonly #revisions: RevisionMetadataStore;

  constructor(dependencies: {
    readonly objects: ObjectStore;
    readonly revisions: RevisionMetadataStore;
  }) {
    this.#objects = dependencies.objects;
    this.#revisions = dependencies.revisions;
  }

  async commit(
    request: CommitCanonicalRevisionRequest,
  ): Promise<CommitCanonicalRevisionResult> {
    const committedAt = utcInstant(request.committedAt);
    const files = validateFiles(request.files);
    let nextRevisionNumber = 1;
    if (request.expectedRevisionId !== null) {
      const parent = await this.#revisions.readRevision(
        request.spaceId,
        request.expectedRevisionId,
      );
      if (!parent) {
        throw new CanonicalRevisionError(
          "parent_not_found",
          "the expected parent revision does not exist in this Mind",
        );
      }
      nextRevisionNumber = parent.revision.revisionNumber + 1;
    }

    const entries = [];
    for (const file of files) {
      const put = await this.#objects.putImmutable({
        bytes: file.bytes,
        mediaType: file.mediaType,
        createdAt: committedAt,
      });
      entries.push({
        path: file.path,
        sha256: put.object.sha256,
        mediaType: put.object.mediaType,
        size: put.object.size,
      });
    }
    const manifest = createRevisionManifest(entries);
    const manifestHash = await this.#objects.calculateSha256(
      new TextEncoder().encode(serializeRevisionManifest(manifest)),
    );
    const envelope = createCanonicalRevisionEnvelope({
      revisionId: request.revisionId,
      spaceId: request.spaceId,
      revisionNumber: nextRevisionNumber,
      parentRevisionId: request.expectedRevisionId,
      committedAt,
      committedBy: request.committedBy,
      manifest,
      manifestHash,
      summary: request.summary,
    });
    const result = await this.#revisions.commitRevision({
      expectedHeadRevisionId: request.expectedRevisionId,
      envelope,
    });
    if (result.kind === "committed") {
      return Object.freeze({
        kind: "committed",
        envelope: result.envelope,
        replayed: result.replayed,
      });
    }
    if (result.kind === "stale_head") return result;
    if (result.kind === "revision_id_collision") {
      throw new CanonicalRevisionError(
        "revision_id_collision",
        "revision ID is already bound to different immutable metadata",
      );
    }
    throw new CanonicalRevisionError(
      "invalid_revision_chain",
      `revision metadata rejected the canonical envelope: ${result.reason}`,
    );
  }

  async materialize(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<MaterializedRevision>> {
    const envelope = await this.#revisions.readRevision(spaceId, revisionId);
    if (!envelope) {
      throw new CanonicalRevisionError(
        "revision_not_found",
        "exact revision does not exist in this Mind",
      );
    }
    const actualManifestHash = await this.#objects.calculateSha256(
      new TextEncoder().encode(serializeRevisionManifest(envelope.manifest)),
    );
    if (actualManifestHash !== envelope.revision.manifestHash) {
      throw new CanonicalRevisionError(
        "manifest_integrity_failure",
        "committed manifest no longer matches its immutable hash",
      );
    }

    const files: MaterializedRevisionFile[] = [];
    for (const entry of envelope.manifest.entries) {
      let object;
      try {
        object = entry.kind === "markdown"
          ? await this.#objects.getImmutable(entry.sha256)
          : "getBundleFile" in this.#objects
            ? await (this.#objects as BundleFileObjectStore).getBundleFile(
                spaceId,
                entry.sha256,
              )
            : null;
      } catch (error) {
        if (error instanceof ObjectStoreFailure && error.code === "object_tampered") {
          throw new CanonicalRevisionError(
            "object_integrity_failure",
            `committed object failed integrity verification for ${JSON.stringify(entry.path)}`,
          );
        }
        throw error;
      }
      if (!object) {
        throw new CanonicalRevisionError(
          "object_not_found",
          `committed object is missing for ${JSON.stringify(entry.path)}`,
        );
      }
      if (
        object.sha256 !== entry.sha256 ||
        object.mediaType !== entry.mediaType ||
        object.size !== entry.size ||
        object.bytes.byteLength !== entry.size
      ) {
        throw new CanonicalRevisionError(
          "object_integrity_failure",
          `committed object metadata differs for ${JSON.stringify(entry.path)}`,
        );
      }
      const bytes = new Uint8Array(object.bytes);
      files.push(entry.kind === "markdown"
        ? Object.freeze({
            kind: "markdown" as const,
            path: entry.path,
            mediaType: entry.mediaType,
            sha256: entry.sha256,
            size: entry.size,
            bytes,
            text: decodeUtf8(bytes),
          })
        : Object.freeze({
            kind: "opaque" as const,
            path: entry.path,
            mediaType: entry.mediaType,
            sha256: entry.sha256,
            size: entry.size,
            bytes,
          }));
    }
    return Object.freeze({ envelope, files: Object.freeze(files) });
  }

  async readHeadRevision(
    spaceId: SpaceId,
  ): Promise<Readonly<MaterializedRevision> | null> {
    const revisionId = await this.#revisions.readHead(spaceId);
    return revisionId === null ? null : this.materialize(spaceId, revisionId);
  }

  async collectUnreachableObjects(request: {
    readonly createdBefore: UtcInstant | string;
    readonly limit: number;
  }): Promise<Readonly<UnreachableObjectCollectionResult>> {
    const createdBefore = utcInstant(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new CanonicalRevisionError(
        "invalid_gc_limit",
        "garbage collection limit must be a positive safe integer",
      );
    }
    const reachable = new Set(await this.#revisions.listReachableObjectDigests());
    const candidates = await this.#objects.listImmutableObjects({
      createdBefore,
      excludedDigests: [...reachable],
      limit: request.limit,
    });
    let scanned = candidates.length;
    const deletedDigests: Sha256Digest[] = [];
    for (const candidate of candidates) {
      if (reachable.has(candidate.sha256)) continue;
      const deleted = await this.#objects.deleteImmutableObject({
        sha256: candidate.sha256,
        expectedProtectedAt: candidate.protectedAt,
        createdBefore,
      });
      if (deleted) deletedDigests.push(candidate.sha256);
    }
    if (
      deletedDigests.length < request.limit &&
      "listBundleFileObjects" in this.#objects
    ) {
      const bundleObjects = this.#objects as BundleFileObjectStore;
      const reachableBundleFiles = await this.#revisions.listReachableBundleFileObjects();
      const bundleCandidates = await bundleObjects.listBundleFileObjects({
        createdBefore,
        excluded: reachableBundleFiles,
        limit: request.limit - deletedDigests.length,
      });
      scanned += bundleCandidates.length;
      for (const candidate of bundleCandidates) {
        const deleted = await bundleObjects.deleteBundleFileObject({
          spaceId: candidate.spaceId,
          sha256: candidate.sha256,
          expectedProtectedAt: candidate.protectedAt,
          createdBefore,
        });
        if (deleted) deletedDigests.push(candidate.sha256);
      }
    }
    return Object.freeze({
      scanned,
      deleted: deletedDigests.length,
      deletedDigests: Object.freeze(deletedDigests),
    });
  }
}

export * from "./changeset-preflight.js";
export * from "./bundle-files.js";
export * from "./changeset-commit.js";
export * from "./deterministic-export.js";
export * from "./export-jobs.js";
export * from "./idempotency.js";
