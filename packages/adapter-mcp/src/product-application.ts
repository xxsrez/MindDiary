import type {
  BundleFileStagingService,
  BundleFileDownloadService,
  ChangesetCommitService,
  FileIngressCapability,
  FileIngressCoordinator,
  LocalFileUploadIntentService,
  MindBrowseService,
  MindDiscoveryService,
  MindHistoryService,
  MindSearchService,
  MindValidationService,
  NoteQueueService,
  ReconcileStageBundleFileResult,
} from "@mind-diary/application-content";
import {
  NativeFileParameterRoute,
  NativeFileInputFailure,
} from "./native-file-input.js";
import {
  MIND_DIARY_HOST_SPECIFIC_BOUNDARY,
  MIND_DIARY_SERVICE_GUIDANCE_MARKDOWN,
  MIND_DIARY_SERVICE_GUIDANCE_SHA256,
  MIND_DIARY_SERVICE_GUIDANCE_VERSION,
} from "./service-guidance.generated.js";
import {
  MCP_TOOL_DEFINITIONS,
  MCP_MOVED_EXPORT_TOOLS,
  createMcpToolErrorResult,
  createMcpToolSuccessResult,
  type McpContentApplication,
  type McpImmutableResourceRead,
  type McpRootResourcePage,
} from "./index.js";

type AuthenticatedActor = Parameters<
  McpContentApplication["listTools"]
>[0]["actor"];
type MindInfo = Awaited<ReturnType<MindDiscoveryService["getMindInfo"]>>;

export interface ProductMcpApplicationDependencies {
  readonly notes?: Pick<NoteQueueService, "enqueue" | "status">;
  readonly personalConfiguration?: {
    getMyMindConfiguration(actor: AuthenticatedActor): Promise<unknown>;
    configureMyMindDescription(actor: AuthenticatedActor, command: { description: string | null; expectedMetadataVersion: number; idempotencyKey: string }): Promise<unknown>;
  };
  readonly discovery: Pick<MindDiscoveryService, "listMinds" | "resolveMind" | "getMindInfo">;
  readonly browse: Pick<
    MindBrowseService,
    "browseEntries" | "listBundleFiles" | "listFiles" | "grepFiles" | "readFiles" | "fetch" | "readResource"
  >;
  readonly search: Pick<MindSearchService, "searchEntries">;
  readonly history: Pick<MindHistoryService, "listRevisions" | "getRevision">;
  readonly validation: Pick<MindValidationService, "validateMind">;
  readonly commits: Pick<ChangesetCommitService, "commit" | "preflight">;
  readonly staging?: Pick<BundleFileStagingService, "stageStream">;
  readonly uploadIntents?: Pick<LocalFileUploadIntentService, "create">;
  readonly uploadIntentUrl?: (capability: string) => string;
  readonly ingress: Pick<
    FileIngressCoordinator,
    "capabilities" | "reconcileStage" | "reconcileCommit"
  >;
  readonly bundleFileDownloads: Pick<BundleFileDownloadService, "issue">;
  readonly nativeFileRoute?: NativeFileParameterRoute;
  readonly scheduleCommitEffects?: () => void | Promise<void>;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function rootUri(spaceId: string, revisionId: string): string {
  return `okf://spaces/${encodeSegment(spaceId)}/revisions/${encodeSegment(revisionId)}/index`;
}

function toCamelKey(key: string): string {
  return key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function toSnakeKey(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function mapKeys(value: unknown, mapper: (key: string) => string): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => mapKeys(item, mapper)));
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        mapper(key),
        mapKeys(item, mapper),
      ]),
    ),
  );
}

function camelInput(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return mapKeys(value, toCamelKey) as Readonly<Record<string, unknown>>;
}

function snakeOutput(value: unknown): unknown {
  return mapKeys(value, toSnakeKey);
}

const FILE_OPERATION_RECOVERY = Object.freeze({
  file_not_found: Object.freeze({
    action: "refresh_file_list",
    retry_policy: "after_refresh",
  }),
  file_not_text: Object.freeze({
    action: "use_bundle_file_download",
    retry_policy: "manual_alternative",
  }),
  unsupported_text_encoding: Object.freeze({
    action: "use_bundle_file_download",
    retry_policy: "manual_alternative",
  }),
  file_scan_limit_exceeded: Object.freeze({
    action: "use_bundle_file_download",
    retry_policy: "manual_alternative",
  }),
  range_out_of_bounds: Object.freeze({
    action: "correct_range",
    retry_policy: "after_correction",
  }),
  utf8_boundary_required: Object.freeze({
    action: "align_utf8_boundary",
    retry_policy: "after_correction",
  }),
} as const);

function fileOperationErrorWithRecovery(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const error = value as Readonly<Record<string, unknown>>;
  const recovery = typeof error.code === "string"
    ? FILE_OPERATION_RECOVERY[error.code as keyof typeof FILE_OPERATION_RECOVERY]
    : undefined;
  return recovery === undefined ? value : Object.freeze({ ...error, recovery });
}

function snakeFileOperationOutput(value: unknown): unknown {
  const output = snakeOutput(value);
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Readonly<Record<string, unknown>>;
  const errors = Array.isArray(record.errors)
    ? Object.freeze(record.errors.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
        const row = item as Readonly<Record<string, unknown>>;
        return Object.freeze({ ...row, error: fileOperationErrorWithRecovery(row.error) });
      }))
    : record.errors;
  const items = Array.isArray(record.items)
    ? Object.freeze(record.items.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
        const row = item as Readonly<Record<string, unknown>>;
        return row.kind === "error"
          ? Object.freeze({ ...row, error: fileOperationErrorWithRecovery(row.error) })
          : row;
      }))
    : record.items;
  return Object.freeze({
    ...record,
    ...(errors === undefined ? {} : { errors }),
    ...(items === undefined ? {} : { items }),
  });
}

const BUNDLE_FILE_DOWNLOAD_RETRIEVAL = Object.freeze({
  method: "https_get",
  executor: "client_or_same_host_trusted_download_companion",
  executionBoundary: "originating_mcp_client_host",
  oneUse: true,
  redirectPolicy: "reject",
  verify: Object.freeze([
    "content_type",
    "content_length",
    "etag",
    "content_disposition",
    "sha256",
  ]),
  failureCodeOnPolicyBlock: "client_transport_unsupported",
});

function camelListFilesInput(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { where, ...rest } = value;
  return Object.freeze({
    ...camelInput(rest),
    ...(Object.hasOwn(value, "where") ? { where } : {}),
  });
}

function toolInput(
  name: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return name === "list_files" ? camelListFilesInput(value) : camelInput(value);
}

function snakeListFilesOutput(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return snakeOutput(value);
  }
  const { files, aggregate, ...rest } = value as Readonly<Record<string, unknown>>;
  const convertedFiles = Array.isArray(files)
    ? Object.freeze(files.map((file) => {
        if (file === null || typeof file !== "object" || Array.isArray(file)) {
          return snakeOutput(file);
        }
        const { metadata, ...descriptor } = file as Readonly<Record<string, unknown>>;
        return Object.freeze({
          ...(snakeOutput(descriptor) as Readonly<Record<string, unknown>>),
          metadata,
        });
      }))
    : files;
  let convertedAggregate = snakeOutput(aggregate);
  if (
    aggregate !== null &&
    typeof aggregate === "object" &&
    !Array.isArray(aggregate) &&
    (aggregate as Readonly<Record<string, unknown>>).kind === "distinct"
  ) {
    const { values, ...descriptor } = aggregate as Readonly<Record<string, unknown>>;
    convertedAggregate = Object.freeze({
      ...(snakeOutput(descriptor) as Readonly<Record<string, unknown>>),
      values,
    });
  }
  return Object.freeze({
    ...(snakeOutput(rest) as Readonly<Record<string, unknown>>),
    files: convertedFiles,
    aggregate: convertedAggregate,
  });
}

function canonicalCommitOperations(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return Object.freeze(value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const operation = item as Readonly<Record<string, unknown>>;
    const { expectedSha256, stagedFileRef, mediaType, ...rest } = operation;
    return Object.freeze({
      ...rest,
      ...(stagedFileRef === undefined ? {} : { staged_file_id: stagedFileRef }),
      ...(mediaType === undefined ? {} : { media_type: mediaType }),
      ...(expectedSha256 === undefined ? {} : { expected_sha256: expectedSha256 }),
    });
  }));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type MovedExportOperation = (typeof MCP_MOVED_EXPORT_TOOLS)[number];

function movedExportOperationResult(
  operation: MovedExportOperation,
): Readonly<Record<string, unknown>> {
  const replacementRoute = operation === "start_export"
    ? "POST /api/v1/minds/{mind_ref}/exports"
    : "GET /api/v1/export-jobs/{job_id}";
  return Object.freeze({
    resultType: "complete",
    content: Object.freeze([
      Object.freeze({
        type: "text" as const,
        text: "This export operation moved to the Mind Diary Site.",
      }),
    ]),
    structuredContent: Object.freeze({
      schema: "mind-diary/mcp-operation-moved/v1",
      error: Object.freeze({
        code: "operation_moved_to_sites",
        operation,
        destination: "sites_control_plane",
        replacement_route: replacementRoute,
        retryable: false,
      }),
    }),
    isError: true,
  });
}

function targetMind(argumentsValue: Readonly<Record<string, unknown>>): unknown {
  return argumentsValue.mind;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function idempotencyKeyValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const FILE_INGRESS_SOURCE_KINDS = new Set([
  "session_attachment",
  "local_path",
  "workspace/generated_artifact",
  "connector_object",
  "bounded_in_memory",
  "server_generated",
]);

type FileIngressCapabilityRegistry = ReadonlyMap<
  FileIngressCapability["sourceKind"],
  Readonly<FileIngressCapability>
>;

function fileIngressCapabilityRegistry(
  ingress: Pick<FileIngressCoordinator, "capabilities">,
): FileIngressCapabilityRegistry {
  const registry = new Map<
    FileIngressCapability["sourceKind"],
    Readonly<FileIngressCapability>
  >();
  let capabilities: readonly Readonly<FileIngressCapability>[];
  try {
    capabilities = ingress.capabilities();
  } catch {
    return registry;
  }
  if (!Array.isArray(capabilities)) return registry;
  for (const capability of capabilities) {
    if (
      capability !== null &&
      typeof capability === "object" &&
      FILE_INGRESS_SOURCE_KINDS.has(capability.sourceKind) &&
      !registry.has(capability.sourceKind)
    ) {
      registry.set(capability.sourceKind, capability);
    }
  }
  return registry;
}

function hostedRegistryCapability(
  registry: FileIngressCapabilityRegistry,
  sourceKind: FileIngressCapability["sourceKind"],
  transport: FileIngressCapability["transport"],
): Readonly<FileIngressCapability> | null {
  const capability = registry.get(sourceKind);
  return capability?.status === "available_hosted" &&
      capability.transport === transport &&
      Number.isSafeInteger(capability.maxBytes) &&
      capability.maxBytes > 0 &&
      capability.maxBytes <= 268_435_456
    ? capability
    : null;
}

function validStageBundleFileInput(input: Readonly<Record<string, unknown>>): boolean {
  const allowed = new Set([
    "mind",
    "file",
    "idempotencyKey",
    "displayFilename",
    "expectedSize",
    "expectedSha256",
  ]);
  return Object.keys(input).every((key) => allowed.has(key)) &&
    stringValue(input.mind) !== null &&
    input.file !== null && typeof input.file === "object" && !Array.isArray(input.file) &&
    idempotencyKeyValue(input.idempotencyKey) &&
    (input.displayFilename === undefined || stringValue(input.displayFilename) !== null) &&
    (input.expectedSize === undefined ||
      (Number.isSafeInteger(input.expectedSize) &&
        (input.expectedSize as number) >= 0 &&
        (input.expectedSize as number) <= 268_435_456)) &&
    (input.expectedSha256 === undefined ||
      (typeof input.expectedSha256 === "string" && SHA256.test(input.expectedSha256)));
}

function stageBundleFileInputShape(input: Readonly<Record<string, unknown>>): string {
  const file = input.file;
  const fileType = file === null
    ? "null"
    : Array.isArray(file)
      ? "array"
      : typeof file;
  const fileKeys = fileType === "object"
    ? Object.keys(file as Readonly<Record<string, unknown>>).sort().join(",")
    : "";
  const keys = Object.keys(input).sort().join(",");
  return `Received keys [${keys}] and file type ${fileType}${
    fileKeys.length === 0 ? "" : ` with keys [${fileKeys}]`
  }.`;
}

function validReconcileFileStageInput(input: Readonly<Record<string, unknown>>): boolean {
  const allowed = new Set([
    "mind",
    "sourceKind",
    "displayFilename",
    "claimedMediaType",
    "mediaType",
    "sha256",
    "size",
    "idempotencyKey",
    "expectedSize",
    "expectedSha256",
  ]);
  return Object.keys(input).every((key) => allowed.has(key)) &&
    stringValue(input.mind) !== null &&
    (input.sourceKind === undefined ||
      (typeof input.sourceKind === "string" &&
        FILE_INGRESS_SOURCE_KINDS.has(input.sourceKind))) &&
    stringValue(input.displayFilename) !== null &&
    (input.claimedMediaType === undefined ||
      (typeof input.claimedMediaType === "string" && input.claimedMediaType.length <= 256)) &&
    typeof input.mediaType === "string" && input.mediaType.length <= 127 &&
    typeof input.sha256 === "string" && SHA256.test(input.sha256) &&
    Number.isSafeInteger(input.size) && (input.size as number) >= 0 &&
    (input.size as number) <= 268_435_456 &&
    idempotencyKeyValue(input.idempotencyKey) &&
    (input.expectedSize === undefined ||
      (Number.isSafeInteger(input.expectedSize) &&
        (input.expectedSize as number) >= 0 &&
        (input.expectedSize as number) <= 268_435_456)) &&
    (input.expectedSha256 === undefined ||
      (typeof input.expectedSha256 === "string" && SHA256.test(input.expectedSha256)));
}

function stageFailureCode(code: string): string {
  switch (code) {
    case "file_size_limit_exceeded":
      return "bundle_file_size_limit_exceeded";
    case "media_type_not_allowed":
      return "unsupported_bundle_file_type";
    case "file_signature_mismatch":
    case "file_extension_mismatch":
    case "expected_size_mismatch":
      return "bundle_file_media_mismatch";
    case "expected_sha256_mismatch":
      return "bundle_file_digest_mismatch";
    case "invalid_filename":
      return "invalid_bundle_file_name";
    case "outstanding_staged_byte_limit_exceeded":
      return "staging_quota_exceeded";
    case "invalid_idempotency_key":
      return "invalid_request";
    default:
      return code;
  }
}

function validChangesetInput(input: Readonly<Record<string, unknown>>): boolean {
  const keys = [
    "mind",
    "expectedRevision",
    "idempotencyKey",
    "summary",
    "operations",
    ...(input.sourceReferences === undefined ? [] : ["sourceReferences"]),
  ];
  return hasExactKeys(input, keys) &&
    stringValue(input.mind) !== null &&
    stringValue(input.expectedRevision) !== null &&
    idempotencyKeyValue(input.idempotencyKey) &&
    typeof input.summary === "string" &&
    Array.isArray(input.operations) && input.operations.length > 0 &&
    (input.sourceReferences === undefined || (
      Array.isArray(input.sourceReferences) &&
      input.sourceReferences.length <= 8 &&
      input.sourceReferences.every((reference) =>
        reference !== null &&
        typeof reference === "object" &&
        !Array.isArray(reference) &&
        hasExactKeys(reference as Readonly<Record<string, unknown>>, [
          "mind",
          "revision",
          "path",
        ]) &&
        stringValue((reference as Readonly<Record<string, unknown>>).mind) !== null &&
        stringValue((reference as Readonly<Record<string, unknown>>).revision) !== null &&
        stringValue((reference as Readonly<Record<string, unknown>>).path) !== null
      )
    ));
}

function validPreflightChangesetInput(input: Readonly<Record<string, unknown>>): boolean {
  const keys = [
    "mind",
    "expectedRevision",
    "operations",
    ...(input.sourceReferences === undefined ? [] : ["sourceReferences"]),
  ];
  return hasExactKeys(input, keys) &&
    stringValue(input.mind) !== null &&
    stringValue(input.expectedRevision) !== null &&
    Array.isArray(input.operations) && input.operations.length > 0 &&
    (input.sourceReferences === undefined || (
      Array.isArray(input.sourceReferences) &&
      input.sourceReferences.length <= 8 &&
      input.sourceReferences.every((reference) =>
        reference !== null &&
        typeof reference === "object" &&
        !Array.isArray(reference) &&
        hasExactKeys(reference as Readonly<Record<string, unknown>>, [
          "mind",
          "revision",
          "path",
        ]) &&
        stringValue((reference as Readonly<Record<string, unknown>>).mind) !== null &&
        stringValue((reference as Readonly<Record<string, unknown>>).revision) !== null &&
        stringValue((reference as Readonly<Record<string, unknown>>).path) !== null
      )
    ));
}

/** Complete custom Mind-aware content application behind the MCP HTTP adapters. */
export class ProductMcpContentApplication implements McpContentApplication {
  readonly #dependencies: ProductMcpApplicationDependencies;

  constructor(dependencies: ProductMcpApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  async #resolveSourceReferences(
    actor: AuthenticatedActor,
    sourceReferences: unknown,
  ): Promise<readonly Readonly<{
    spaceId: string;
    revisionId: string;
    path: string;
  }>[]> {
    if (!Array.isArray(sourceReferences)) return Object.freeze([]);
    return Object.freeze(await Promise.all(sourceReferences.map(async (reference) => {
      const value = reference as Readonly<Record<string, unknown>>;
      const info = await this.#dependencies.discovery.getMindInfo(
        actor,
        value.mind,
        { kind: "revision", revisionId: value.revision as never },
      );
      return Object.freeze({
        spaceId: info.mind.mindId,
        revisionId: info.resolvedRevision.revisionId,
        path: value.path as string,
      });
    })));
  }

  #writableMindError(
    requestId: AuthenticatedActor["requestId"],
    code: "writable_mind_required" | "writable_mind_stale",
    retryable = false,
  ) {
    const messages = Object.freeze({
      writable_mind_required:
        "Configure this exact Mind as read_write in the Site settings before writing.",
      writable_mind_stale:
        "The principal's writable Mind changed or is no longer available; refresh list_minds.",
    });
    return createMcpToolErrorResult(
      requestId,
      code,
      messages[code],
      retryable,
    );
  }

  async #writeMindInfo(
    actor: AuthenticatedActor,
    mind: unknown,
  ): Promise<Readonly<
    | { readonly kind: "ready"; readonly info: MindInfo }
    | { readonly kind: "error"; readonly result: unknown }
  >> {
    let info: MindInfo;
    try {
      info = await this.#dependencies.discovery.getMindInfo(
        actor,
        mind,
        { kind: "head" },
      );
    } catch {
      return Object.freeze({
        kind: "error" as const,
        result: this.#writableMindError(actor.requestId, "writable_mind_required"),
      });
    }
    if (info.contentCapabilities.includes("commit")) {
      return Object.freeze({ kind: "ready" as const, info });
    }
    return Object.freeze({
      kind: "error" as const,
      result: info.mind.usageMode === "read"
        ? this.#writableMindError(actor.requestId, "writable_mind_required")
        : createMcpToolErrorResult(
            actor.requestId,
            "forbidden",
            "The requested operation is not allowed.",
            false,
          ),
    });
  }

  async listTools(_request: {
    readonly actor: AuthenticatedActor;
  }): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const hostedUploadIntents =
      this.#dependencies.uploadIntents !== undefined &&
      this.#dependencies.uploadIntentUrl !== undefined;
    const nativeFileParameter =
      this.#dependencies.nativeFileRoute instanceof NativeFileParameterRoute &&
      this.#dependencies.staging !== undefined;
    return Object.freeze(
      MCP_TOOL_DEFINITIONS.filter(
        (definition) =>
          (this.#dependencies.notes !== undefined || !["enqueue_note", "get_note_status"].includes(definition.name)) &&
          (hostedUploadIntents || definition.name !== "create_file_upload_intent") &&
          (nativeFileParameter || definition.name !== "stage_bundle_file"),
      ).map((definition) =>
        definition.name === "stage_bundle_file" &&
        this.#dependencies.nativeFileRoute?.routeKind === "verified_host_rewrite"
          ? Object.freeze({
              ...definition,
              _meta: Object.freeze({
                "openai/fileParams": Object.freeze(["file"]),
              }),
            })
          : definition,
      ),
    );
  }

  async listRootResources(request: {
    readonly actor: AuthenticatedActor;
    readonly cursor?: string;
  }): Promise<Readonly<McpRootResourcePage>> {
    const page = await this.#dependencies.discovery.listMinds(request.actor, {
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: 100,
    });
    return Object.freeze({
      resources: Object.freeze(page.minds.map((mind) => Object.freeze({
        uri: rootUri(mind.mindId, mind.head.revisionId),
        name: mind.name,
        title: `${mind.name} · index.md`,
        description: "Current authorized immutable root index of this Mind revision.",
        mimeType: "text/markdown; charset=utf-8" as const,
      }))),
      nextCursor: page.nextCursor,
    });
  }

  async readResource(request: {
    readonly actor: AuthenticatedActor;
    readonly uri: string;
  }): Promise<Readonly<McpImmutableResourceRead>> {
    const result = await this.#dependencies.browse.readResource(
      request.actor,
      request.uri,
    );
    return Object.freeze({ uri: result.uri, mimeType: result.mimeType, text: result.text });
  }

  async authorizeToolCall(request: Parameters<McpContentApplication["authorizeToolCall"]>[0]) {
    if (
      request.name === "stage_bundle_file" &&
      (!(this.#dependencies.nativeFileRoute instanceof NativeFileParameterRoute) ||
        this.#dependencies.staging === undefined)
    ) {
      return Object.freeze({ kind: "allowed" as const });
    }
    if (
      request.name === "get_mind_diary_guidance" ||
      request.name === "get_personal_mind_configuration" ||
      request.name === "set_personal_mind_description" ||
      request.name === "start_export" ||
      request.name === "get_export_status" ||
      request.name === "list_minds" ||
      request.name === "fetch" ||
      request.name === "get_file_ingress_capabilities"
    ) {
      return Object.freeze({ kind: "allowed" as const });
    }
    const writeTool = request.name === "preflight_changeset" ||
      request.name === "commit_changeset" ||
      request.name === "enqueue_note" ||
      request.name === "reconcile_changeset" ||
      request.name === "create_file_upload_intent" ||
      request.name === "stage_bundle_file" ||
      request.name === "reconcile_file_stage";
    try {
      const input = toolInput(request.name, request.arguments);
      if (request.name === "resolve_mind") {
        await this.#dependencies.discovery.resolveMind(request.actor, input.handle);
        return Object.freeze({ kind: "allowed" as const });
      }
      const info = await this.#dependencies.discovery.getMindInfo(
        request.actor,
        targetMind(input),
        input.revisionSelector,
      );
      const required = writeTool ? "commit" : null;
      if (required !== null && !info.contentCapabilities.includes(required)) {
        return Object.freeze({
          kind: "denied" as const,
          code: info.mind.usageMode === "read"
            ? "writable_mind_required"
            : "forbidden",
        });
      }
      return Object.freeze({ kind: "allowed" as const });
    } catch {
      return Object.freeze({
        kind: "denied" as const,
        code: writeTool ? "writable_mind_required" : "mind_not_found",
      });
    }
  }

  async executeAuthorizedToolCall(
    request: Parameters<NonNullable<McpContentApplication["executeAuthorizedToolCall"]>>[0],
  ): Promise<unknown> {
    return this.executeToolCall(request);
  }

  async executeToolCall(request: Parameters<McpContentApplication["executeToolCall"]>[0]): Promise<unknown> {
    const input = toolInput(request.name, request.arguments);
    switch (request.name) {
      case "get_mind_diary_guidance":
        if (!hasExactKeys(input, [])) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "Mind Diary guidance arguments must be empty.",
            false,
          );
        }
        return createMcpToolSuccessResult(
          snakeOutput({
            guidanceVersion: MIND_DIARY_SERVICE_GUIDANCE_VERSION,
            serviceGuidanceSha256: MIND_DIARY_SERVICE_GUIDANCE_SHA256,
            serviceGuidanceMarkdown: MIND_DIARY_SERVICE_GUIDANCE_MARKDOWN,
            hostSpecific: {
              applicability: "conditional_on_client_tools",
              instructions: MIND_DIARY_HOST_SPECIFIC_BOUNDARY,
            },
          }),
          `Mind Diary service guidance ${MIND_DIARY_SERVICE_GUIDANCE_VERSION}.`,
        );
      case "get_personal_mind_configuration":
      case "set_personal_mind_description": {
        if (!request.actor.authentication.effectiveScopes.some((scope) => scope === "personal:configure")) {
          return createMcpToolErrorResult(request.actor.requestId, "insufficient_scope", "Personal configuration permission is required.", false);
        }
        const service = this.#dependencies.personalConfiguration;
        const read = request.name === "get_personal_mind_configuration";
        if (service === undefined || !hasExactKeys(input, read ? [] : ["description", "expectedMetadataVersion", "idempotencyKey"])) {
          return createMcpToolErrorResult(request.actor.requestId, "invalid_request", "Invalid Personal configuration request.", false);
        }
        try {
          return createMcpToolSuccessResult(snakeOutput(read ? await service.getMyMindConfiguration(request.actor) :
            await service.configureMyMindDescription(request.actor, input as unknown as { description: string | null; expectedMetadataVersion: number; idempotencyKey: string })), "Personal Mind configuration.");
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "configuration_unavailable";
          return createMcpToolErrorResult(request.actor.requestId, code, "Personal configuration could not be completed. Re-read current configuration before rebuilding a conflicting request.", false);
        }
      }

      case "start_export":
      case "get_export_status":
        return movedExportOperationResult(request.name);
      case "list_minds":
        return snakeOutput(await this.#dependencies.discovery.listMinds(request.actor, input));
      case "resolve_mind":
        return snakeOutput(await this.#dependencies.discovery.resolveMind(request.actor, input.handle));
      case "get_mind_info":
        return snakeOutput(await this.#dependencies.discovery.getMindInfo(request.actor, input.mind, input.revisionSelector));
      case "get_file_ingress_capabilities":
        if (!hasExactKeys(input, [])) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "File ingress capability arguments must be empty.",
            false,
          );
        }
        {
          const capabilityRegistry = fileIngressCapabilityRegistry(
            this.#dependencies.ingress,
          );
          const hostedUploadIntents =
            this.#dependencies.uploadIntents !== undefined &&
            this.#dependencies.uploadIntentUrl !== undefined;
          const companionAvailable = hostedUploadIntents &&
            (hostedRegistryCapability(
              capabilityRegistry,
              "local_path",
              "local_companion",
            ) !== null || hostedRegistryCapability(
              capabilityRegistry,
              "workspace/generated_artifact",
              "local_companion",
            ) !== null);
          const nativeFileRoute =
            this.#dependencies.nativeFileRoute instanceof NativeFileParameterRoute &&
              this.#dependencies.staging !== undefined
              ? this.#dependencies.nativeFileRoute
              : null;
        return createMcpToolSuccessResult(
          snakeOutput({
            contractVersion: 2,
            sourceSelectionRequired: false,
            maxBytes: 268_435_456,
            nativeFileInput: {
              transport: "openai_file_parameter",
              status: nativeFileRoute === null ? "not_available" : "available",
              routeProfileId: nativeFileRoute?.profileId ?? null,
              verificationStatus:
                nativeFileRoute?.verificationStatus ?? "not_available",
            },
            companionUpload: {
              transport: "one_use_upload_intent",
              status: companionAvailable ? "available" : "not_available",
            },
          }),
          "Read the available file transports and shared byte limit. File origin is not a caller-selected capability.",
        );
        }
      case "create_file_upload_intent": {
        if (
          this.#dependencies.uploadIntents === undefined ||
          this.#dependencies.uploadIntentUrl === undefined
        ) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "file_ingress_source_unsupported",
            "This deployment does not expose the companion upload-intent boundary.",
            false,
          );
        }
        if (
          !hasExactKeys(input, [
            "mind",
            ...(input.sourceKind === undefined ? [] : ["sourceKind"]),
            "displayFilename",
            ...(input.claimedMediaType === undefined
              ? []
              : ["claimedMediaType"]),
            "expectedSize",
            "expectedSha256",
            "idempotencyKey",
          ])
          || (input.sourceKind !== undefined &&
            input.sourceKind !== "local_path" &&
            input.sourceKind !== "workspace/generated_artifact")
        ) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The upload intent arguments are invalid.",
            false,
          );
        }
        const writeMind = await this.#writeMindInfo(request.actor, input.mind);
        if (writeMind.kind === "error") return writeMind.result;
        const { info } = writeMind;
        const {
          mind: _mind,
          ...providedIntentArguments
        } = request.arguments;
        const intentArguments = Object.freeze({
          source_kind: "local_path",
          ...providedIntentArguments,
        });
        const created = await this.#dependencies.uploadIntents.create(
          request.actor,
          info.mind.mindId,
          Object.freeze(intentArguments),
        );
        if (created.kind === "denied") {
          const decision = created.decision as Readonly<{
            code?: unknown;
            retryable?: unknown;
          }>;
          return createMcpToolErrorResult(
            request.actor.requestId,
            typeof decision.code === "string" ? decision.code : "forbidden",
            "The upload intent could not be authorized.",
            decision.retryable === true,
          );
        }
        if (created.kind === "invalid") {
          if (
            created.code === "writable_mind_required" ||
            created.code === "writable_mind_stale"
          ) {
            return this.#writableMindError(
              request.actor.requestId,
              created.code,
            );
          }
          return createMcpToolErrorResult(
            request.actor.requestId,
            created.code,
            created.code === "file_ingress_intent_conflict"
              ? "The idempotency key is bound to another upload intent payload."
              : "The upload intent request was not accepted.",
            created.code === "file_ingress_transport_unavailable",
          );
        }
        return createMcpToolSuccessResult(
          {
            intent_version: 1,
            upload_url: this.#dependencies.uploadIntentUrl(
              created.uploadCapability,
            ),
            expires_at: created.expiresAt,
            replayed: created.replayed,
          },
          created.replayed
            ? "Recovered the existing one-use file upload intent."
            : "Created one short-lived file upload intent.",
        );
      }
      case "browse_entries":
        return snakeOutput(await this.#dependencies.browse.browseEntries(request.actor, input));
      case "list_files":
        return snakeListFilesOutput(
          await this.#dependencies.browse.listFiles(request.actor, input, request.signal),
        );
      case "grep_files":
        return snakeFileOperationOutput(
          await this.#dependencies.browse.grepFiles(request.actor, input, request.signal),
        );
      case "read_files":
        return snakeFileOperationOutput(
          await this.#dependencies.browse.readFiles(request.actor, input, request.signal),
        );
      case "list_bundle_files": {
        const result = await this.#dependencies.browse.listBundleFiles(request.actor, input);
        return snakeOutput({
          ...result,
          diagnostics: result.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            class: diagnostic.severity === "warning" ? "quality" : "conformance",
            code: diagnostic.code,
            path: diagnostic.path,
            ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
            message: diagnostic.message,
          })),
        });
      }
      case "search":
        return snakeOutput(await this.#dependencies.search.searchEntries(request.actor, input));
      case "fetch":
        return snakeOutput(await this.#dependencies.browse.fetch(request.actor, input));
      case "list_revisions":
        return snakeOutput(await this.#dependencies.history.listRevisions(request.actor, input));
      case "get_revision":
        return snakeOutput(await this.#dependencies.history.getRevision(request.actor, input));
      case "validate_mind":
        return snakeOutput(await this.#dependencies.validation.validateMind(request.actor, input));
      case "stage_bundle_file": {
        const staging = this.#dependencies.staging;
        if (
          !(this.#dependencies.nativeFileRoute instanceof NativeFileParameterRoute) ||
          staging === undefined
        ) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "native_file_input_unsupported",
            "This deployed route profile has no verified native file parameter rewrite.",
            false,
          );
        }
        const nativeFileRoute = this.#dependencies.nativeFileRoute;
        if (!validStageBundleFileInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            `The native file staging arguments are invalid. ${stageBundleFileInputShape(input)}`,
            false,
          );
        }
        const writeMind = await this.#writeMindInfo(request.actor, input.mind);
        if (writeMind.kind === "error") return writeMind.result;
        const { info } = writeMind;
        let downloaded;
        try {
          downloaded = await nativeFileRoute.download(input.file);
        } catch (error) {
          if (error instanceof NativeFileInputFailure) {
            return createMcpToolErrorResult(
              request.actor.requestId,
              error.code,
              error.message,
              error.retryable,
            );
          }
          return createMcpToolErrorResult(
            request.actor.requestId,
            "native_file_input_unsupported",
            "The client native file input could not be read safely.",
            true,
          );
        }
        let staged;
        try {
          staged = await staging.stageStream({
            actor: request.actor,
            spaceId: info.mind.mindId,
            sourceKind: "session_attachment",
            displayFilename: input.displayFilename ?? downloaded.fileName ?? "uploaded-file",
            claimedMediaType: downloaded.mimeType,
            stream: downloaded.stream,
            maxBytes: 268_435_456,
            idempotencyKey: input.idempotencyKey,
            expectedSize: input.expectedSize ?? downloaded.size,
            expectedSha256: input.expectedSha256,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
        } finally {
          downloaded.dispose();
        }
        if (staged.kind === "denied") {
          const decision = staged.decision as Readonly<{
            code?: unknown;
            retryable?: unknown;
          }>;
          if (
            decision.code === "writable_mind_required" ||
            decision.code === "writable_mind_stale"
          ) {
            return this.#writableMindError(
              request.actor.requestId,
              decision.code,
              decision.retryable === true,
            );
          }
          return createMcpToolErrorResult(
            request.actor.requestId,
            typeof decision.code === "string" ? decision.code : "forbidden",
            "The requested operation is not allowed.",
            decision.retryable === true,
          );
        }
        if (staged.kind === "invalid") {
          const code = stageFailureCode(staged.code);
          return createMcpToolErrorResult(
            request.actor.requestId,
            code,
            code === "idempotency_conflict"
              ? "The idempotency key is already bound to different file bytes or metadata."
              : "The native file could not be staged safely.",
            false,
          );
        }
        if (staged.kind === "stream_invalid") {
          return createMcpToolErrorResult(
            request.actor.requestId,
            staged.code === "stream_size_limit_exceeded"
              ? "bundle_file_size_limit_exceeded"
              : "native_file_input_unsupported",
            "The native file could not be staged safely.",
            staged.code === "stream_transport_unavailable",
          );
        }
        return createMcpToolSuccessResult(
          snakeOutput({
            stagedFile: {
              stagedFileRef: staged.record.stagedFileId,
              state: staged.record.state,
              displayFilename: staged.record.displayFilename,
              mediaType: staged.record.mediaType,
              sha256: staged.record.sha256,
              size: staged.record.size,
              expiresAt: staged.record.expiresAt,
              replayed: staged.replayed,
            },
          }),
          staged.replayed
            ? "Reconciled the existing staged BundleFile."
            : "Staged one verified BundleFile.",
        );
      }
      case "reconcile_file_stage": {
        if (!validReconcileFileStageInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The file stage reconciliation arguments are invalid.",
            false,
          );
        }
        const writeMind = await this.#writeMindInfo(request.actor, input.mind);
        if (writeMind.kind === "error") return writeMind.result;
        const { info } = writeMind;
        const compatibilitySourceKinds = input.sourceKind === undefined
          ? Object.freeze([
              "session_attachment",
              "local_path",
              "workspace/generated_artifact",
            ])
          : Object.freeze([input.sourceKind]);
        let reconciled: ReconcileStageBundleFileResult | null = null;
        for (const sourceKind of compatibilitySourceKinds) {
          const attempt = await this.#dependencies.ingress.reconcileStage({
            actor: request.actor,
            spaceId: info.mind.mindId,
            sourceKind,
            displayFilename: input.displayFilename,
            claimedMediaType: input.claimedMediaType,
            mediaType: input.mediaType,
            sha256: input.sha256,
            size: input.size,
            idempotencyKey: input.idempotencyKey,
            expectedSize: input.expectedSize,
            expectedSha256: input.expectedSha256,
          });
          if (attempt.kind === "staged" || attempt.kind === "denied") {
            reconciled = attempt;
            break;
          }
          if (attempt.kind === "missing") {
            reconciled ??= attempt;
            continue;
          }
          if (attempt.code !== "idempotency_conflict") {
            reconciled = attempt;
            break;
          }
          if (reconciled === null || reconciled.kind === "missing") {
            reconciled = attempt;
          }
        }
        if (reconciled === null) {
          throw new Error("file stage reconciliation produced no result");
        }
        if (reconciled.kind === "missing") {
          return createMcpToolSuccessResult(
            { status: "missing" },
            "No completed file stage exists for the exact receipt.",
          );
        }
        if (reconciled.kind === "denied") {
          const decision = reconciled.decision as Readonly<{
            code?: unknown;
            retryable?: unknown;
          }>;
          if (
            decision.code === "writable_mind_required" ||
            decision.code === "writable_mind_stale"
          ) {
            return this.#writableMindError(
              request.actor.requestId,
              decision.code,
              decision.retryable === true,
            );
          }
          return createMcpToolErrorResult(
            request.actor.requestId,
            typeof decision.code === "string" ? decision.code : "forbidden",
            "The requested operation is not allowed.",
            decision.retryable === true,
          );
        }
        if (reconciled.kind === "invalid") {
          const code = stageFailureCode(reconciled.code);
          return createMcpToolErrorResult(
            request.actor.requestId,
            code,
            code === "idempotency_conflict"
              ? "The idempotency key is bound to a different file receipt."
              : "The file stage outcome could not be reconciled.",
            false,
          );
        }
        return createMcpToolSuccessResult(
          snakeOutput({
            status: "staged",
            stagedFile: {
              stagedFileRef: reconciled.record.stagedFileId,
              state: reconciled.record.state,
              displayFilename: reconciled.record.displayFilename,
              mediaType: reconciled.record.mediaType,
              sha256: reconciled.record.sha256,
              size: reconciled.record.size,
              expiresAt: reconciled.record.expiresAt,
              replayed: true,
            },
          }),
          "Reconciled the existing staged BundleFile.",
        );
      }
      case "get_bundle_file_download": {
        const grant = await this.#dependencies.bundleFileDownloads.issue(request.actor, input);
        return createMcpToolSuccessResult(
          snakeOutput({ ...grant, retrieval: BUNDLE_FILE_DOWNLOAD_RETRIEVAL }),
          "Created a one-use BundleFile download.",
        );
      }
      case "enqueue_note":
      case "get_note_status": {
        if (this.#dependencies.notes === undefined) return createMcpToolErrorResult(request.actor.requestId, "unsupported_operation", "Note queue unavailable.", false);
        try {
        const info = await this.#dependencies.discovery.getMindInfo(request.actor, input.mind);
        const receipt = request.name === "enqueue_note"
          ? await this.#dependencies.notes.enqueue(request.actor, info.mind.mindId, {
              idempotencyKey: input.idempotencyKey, title: input.title, text: input.text,
            })
          : await this.#dependencies.notes.status(request.actor, info.mind.mindId, input.receiptId);
        return createMcpToolSuccessResult(snakeOutput(receipt), "Note receipt.");
        } catch (error) {
          const codes = new Set(["invalid_note", "invalid_note_receipt", "note_not_found", "note_access_denied", "writable_mind_required", "idempotency_conflict", "note_queue_full", "note_capacity_rejected"]);
          if (error instanceof Error && codes.has(error.message)) return createMcpToolErrorResult(
            request.actor.requestId, error.message, "The note operation could not be completed.",
            error.message === "note_queue_full" || error.message === "note_capacity_rejected");
          throw error;
        }
      }
      case "commit_changeset": {
        if (!validChangesetInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The changeset arguments are invalid.",
            false,
          );
        }
        const writeMind = await this.#writeMindInfo(request.actor, input.mind);
        if (writeMind.kind === "error") return writeMind.result;
        const { info } = writeMind;
        let sourceReferences;
        try {
          sourceReferences = await this.#resolveSourceReferences(
            request.actor,
            input.sourceReferences,
          );
        } catch {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "mind_not_found",
            "One or more source references are unavailable.",
            false,
          );
        }
        const result = await this.#dependencies.commits.commit({
          actor: request.actor,
          spaceId: info.mind.mindId,
          expectedRevisionId: input.expectedRevision as never,
          idempotencyKey: input.idempotencyKey as never,
          summary: input.summary as never,
          producerProfile: true,
          operations: canonicalCommitOperations(input.operations) as never,
          sourceReferences,
        });
        if (result.kind === "committed") {
          if (!result.replayed) await this.#dependencies.scheduleCommitEffects?.();
          const committedInfo = await this.#dependencies.discovery.getMindInfo(
            request.actor,
            input.mind,
            { kind: "revision", revisionId: result.envelope.revision.revisionId },
          );
          return createMcpToolSuccessResult(
            snakeOutput({
              mind: committedInfo.mind,
              previousRevisionId: result.previousRevisionId,
              revision: committedInfo.resolvedRevision,
              indexStatus: committedInfo.indexStatus.status,
              replayed: result.replayed,
            }),
            "Committed one immutable Mind revision.",
          );
        }
        const output = snakeOutput(result);
        const code =
          result.kind === "denied"
            ? result.decision.code
            : result.kind === "invalid"
              ? result.error.code
              : result.kind;
        if (code === "writable_mind_required" || code === "writable_mind_stale") {
          return createMcpToolErrorResult(
            request.actor.requestId,
            code,
            code === "writable_mind_required"
              ? "Configure this exact Mind as read_write on the Mind Diary Site, then refresh list_minds."
              : "The writable Mind changed or lost authority; refresh list_minds and rebuild from the current HEAD.",
            result.kind === "denied" && result.decision.retryable,
          );
        }
        return createMcpToolErrorResult(
          request.actor.requestId,
          code,
          "The changeset was not committed.",
          result.kind === "revision_conflict" ||
            (result.kind === "denied" && result.decision.retryable),
          output as Readonly<Record<string, unknown>>,
        );
      }
      case "preflight_changeset": {
        if (!validPreflightChangesetInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The changeset preflight arguments are invalid.",
            false,
          );
        }
        const writeMind = await this.#writeMindInfo(request.actor, input.mind);
        if (writeMind.kind === "error") return writeMind.result;
        let sourceReferences;
        try {
          sourceReferences = await this.#resolveSourceReferences(
            request.actor,
            input.sourceReferences,
          );
        } catch {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "mind_not_found",
            "One or more source references are unavailable.",
            false,
          );
        }
        const result = await this.#dependencies.commits.preflight({
          actor: request.actor,
          spaceId: writeMind.info.mind.mindId,
          expectedRevisionId: input.expectedRevision as never,
          producerProfile: true,
          operations: canonicalCommitOperations(input.operations) as never,
          sourceReferences,
        });
        if (result.kind === "ready") {
          return createMcpToolSuccessResult(
            snakeOutput({
              mind: writeMind.info.mind,
              decision: "ready",
              baseRevisionId: result.baseRevisionId,
              changesetIdentity: result.changesetIdentity,
              validationProfile: "strict_producer_2026-09-18",
              validation: {
                valid: result.validation.valid,
                conforms: result.validation.conforms,
                diagnostics: result.validation.diagnostics,
                conformanceErrorCount: result.validation.conformanceErrors.length,
                consistencyErrorCount: result.validation.envelopeErrors.filter(
                  (diagnostic) => diagnostic.code.startsWith("markdown_"),
                ).length,
                qualityWarningCount: result.validation.qualityWarnings.length,
              },
              operationCount: result.operations.length,
              resultingFileCount: result.candidateFiles.length,
              stagedBundleFileCount: result.stagedBundleFileRecords.length,
            }),
            "The exact changeset passes the current commit gate without being saved.",
          );
        }
        const output = snakeOutput(result);
        const code = result.kind === "denied"
          ? result.decision.code
          : result.kind === "invalid"
            ? result.error.code
            : result.kind;
        return createMcpToolErrorResult(
          request.actor.requestId,
          code,
          "The changeset does not pass preflight and was not saved.",
          result.kind === "revision_conflict" ||
            (result.kind === "denied" && result.decision.retryable),
          output as Readonly<Record<string, unknown>>,
        );
      }
      case "reconcile_changeset": {
        if (!validChangesetInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The changeset reconciliation arguments are invalid.",
            false,
          );
        }
        const writeMind = await this.#writeMindInfo(request.actor, input.mind);
        if (writeMind.kind === "error") return writeMind.result;
        const { info } = writeMind;
        let sourceReferences;
        try {
          sourceReferences = await this.#resolveSourceReferences(
            request.actor,
            input.sourceReferences,
          );
        } catch {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "mind_not_found",
            "One or more source references are unavailable.",
            false,
          );
        }
        const result = await this.#dependencies.ingress.reconcileCommit({
          actor: request.actor,
          spaceId: info.mind.mindId,
          expectedRevisionId: input.expectedRevision as never,
          idempotencyKey: input.idempotencyKey as never,
          summary: input.summary as never,
          producerProfile: true,
          operations: canonicalCommitOperations(input.operations) as never,
          sourceReferences,
        });
        if (result.kind === "missing") {
          return createMcpToolSuccessResult(
            { status: "missing" },
            "No completed changeset exists for the exact payload.",
          );
        }
        if (result.kind === "committed") {
          const committedInfo = await this.#dependencies.discovery.getMindInfo(
            request.actor,
            input.mind,
            { kind: "revision", revisionId: result.envelope.revision.revisionId },
          );
          return createMcpToolSuccessResult(
            snakeOutput({
              status: "committed",
              mind: committedInfo.mind,
              previousRevisionId: result.previousRevisionId,
              revision: committedInfo.resolvedRevision,
            }),
            "Reconciled the original immutable Mind revision.",
          );
        }
        const output = snakeOutput(result);
        const code = result.kind === "denied"
          ? result.decision.code
          : result.kind === "invalid"
            ? result.error.code
            : result.kind;
        if (code === "writable_mind_required" || code === "writable_mind_stale") {
          return createMcpToolErrorResult(
            request.actor.requestId,
            code,
            code === "writable_mind_required"
              ? "Configure this exact Mind as read_write on the Mind Diary Site, then refresh list_minds."
              : "The writable Mind changed or lost authority; refresh list_minds before reconciliation.",
            result.kind === "denied" && result.decision.retryable,
          );
        }
        return createMcpToolErrorResult(
          request.actor.requestId,
          code,
          "The changeset outcome could not be reconciled.",
          result.kind === "denied" && result.decision.retryable,
          output as Readonly<Record<string, unknown>>,
        );
      }
    }
  }

}
