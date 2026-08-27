import type {
  AutomaticCaptureService,
  BundleFileStagingService,
  BundleFileDownloadService,
  ChangesetCommitService,
  FileIngressCoordinator,
  LocalFileUploadIntentService,
  MindBindingApplicationService,
  MindBrowseService,
  MindDiscoveryService,
  MindHistoryService,
  MindSearchService,
  MindValidationService,
} from "@mind-diary/application-content";
import {
  NativeFileInputFailure,
  type NativeFileTransport,
} from "./native-file-input.js";
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

export interface ProductMcpApplicationDependencies {
  readonly discovery: Pick<MindDiscoveryService, "listMinds" | "resolveMind" | "getMindInfo">;
  readonly browse: Pick<MindBrowseService, "browseEntries" | "listBundleFiles" | "fetch" | "readResource">;
  readonly search: Pick<MindSearchService, "searchEntries">;
  readonly history: Pick<MindHistoryService, "listRevisions" | "getRevision">;
  readonly validation: Pick<MindValidationService, "validateMind">;
  readonly bindings: Pick<
    MindBindingApplicationService,
    "read" | "mutateRead" | "mutateWrite"
  >;
  readonly commits: Pick<ChangesetCommitService, "commit">;
  readonly staging?: Pick<BundleFileStagingService, "stageStream">;
  readonly uploadIntents?: Pick<LocalFileUploadIntentService, "create">;
  readonly uploadIntentUrl?: (capability: string) => string;
  readonly ingress: Pick<
    FileIngressCoordinator,
    "capabilities" | "reconcileStage" | "reconcileCommit"
  >;
  readonly bundleFileDownloads: Pick<BundleFileDownloadService, "issue">;
  readonly nativeFiles?: NativeFileTransport;
  readonly capture: Pick<AutomaticCaptureService, "capture">;
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

function canonicalCommitOperations(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return Object.freeze(value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const operation = item as Readonly<Record<string, unknown>>;
    const { expectedSha256, stagedFileRef, ...rest } = operation;
    return Object.freeze({
      ...rest,
      ...(stagedFileRef === undefined ? {} : { staged_file_id: stagedFileRef }),
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
    typeof input.sourceKind === "string" &&
    FILE_INGRESS_SOURCE_KINDS.has(input.sourceKind) &&
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
    case "binding_mismatch":
      return "staged_file_binding_stale";
    case "invalid_idempotency_key":
      return "invalid_request";
    default:
      return code;
  }
}

const CAPTURE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CAPTURE_KINDS = new Set(["fact", "decision", "source_note"]);

function validCaptureSources(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false;
  return value.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Readonly<Record<string, unknown>>;
    if (record.kind === "user_statement") return hasExactKeys(record, ["kind"]);
    return record.kind === "target_entry" &&
      hasExactKeys(record, ["kind", "revisionId", "path"]) &&
      stringValue(record.revisionId) !== null &&
      stringValue(record.path) !== null;
  });
}

function validCaptureInput(input: Readonly<Record<string, unknown>>): boolean {
  return hasExactKeys(input, [
    "mind",
    "expectedRevision",
    "idempotencyKey",
    "classification",
    "captureKind",
    "captureKey",
    "title",
    "description",
    "body",
    "sources",
  ]) &&
    stringValue(input.mind) !== null &&
    stringValue(input.expectedRevision) !== null &&
    idempotencyKeyValue(input.idempotencyKey) &&
    input.classification === "routine_non_sensitive" &&
    typeof input.captureKind === "string" && CAPTURE_KINDS.has(input.captureKind) &&
    typeof input.captureKey === "string" && CAPTURE_KEY_PATTERN.test(input.captureKey) &&
    stringValue(input.title) !== null &&
    stringValue(input.description) !== null &&
    stringValue(input.body) !== null &&
    validCaptureSources(input.sources);
}

function validChangesetInput(input: Readonly<Record<string, unknown>>): boolean {
  return hasExactKeys(input, [
    "mind",
    "expectedRevision",
    "idempotencyKey",
    "summary",
    "operations",
  ]) &&
    stringValue(input.mind) !== null &&
    stringValue(input.expectedRevision) !== null &&
    idempotencyKeyValue(input.idempotencyKey) &&
    typeof input.summary === "string" &&
    Array.isArray(input.operations) && input.operations.length > 0;
}

/** Complete custom Mind-aware content application behind the MCP HTTP adapters. */
export class ProductMcpContentApplication implements McpContentApplication {
  readonly #dependencies: ProductMcpApplicationDependencies;

  constructor(dependencies: ProductMcpApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  async #resolveWritableTarget(
    actor: AuthenticatedActor,
    spaceId: string,
  ): Promise<
    | Readonly<{ kind: "ready"; writeBindingId: string; targetVersion: number }>
    | Readonly<{ kind: "error"; result: unknown }>
  > {
    const current = await this.#dependencies.bindings.read({ actor });
    if (current.kind === "writable_target_required") {
      return Object.freeze({
        kind: "error",
        result: this.#writableTargetError(actor.requestId, "writable_target_required"),
      });
    }
    if (
      current.kind !== "ready" ||
      current.bindings.bindingSet.state !== "active"
    ) {
      return Object.freeze({
        kind: "error",
        result: this.#writableTargetError(actor.requestId, "writable_target_unavailable"),
      });
    }
    const write = current.bindings.writeBinding;
    if (write === null) {
      return Object.freeze({
        kind: "error",
        result: this.#writableTargetError(actor.requestId, "writable_target_required"),
      });
    }
    if (write.state !== "active") {
      return Object.freeze({
        kind: "error",
        result: this.#writableTargetError(actor.requestId, "writable_target_unavailable"),
      });
    }
    if (write.spaceId !== spaceId) {
      return Object.freeze({
        kind: "error",
        result: this.#writableTargetError(actor.requestId, "writable_target_mismatch"),
      });
    }
    return Object.freeze({
      kind: "ready",
      writeBindingId: write.writeBindingId,
      targetVersion: current.bindings.bindingSet.bindingVersion,
    });
  }

  #writableTargetError(
    requestId: AuthenticatedActor["requestId"],
    code:
      | "writable_target_required"
      | "writable_target_mismatch"
      | "writable_target_unavailable",
    retryable = false,
  ) {
    const messages = Object.freeze({
      writable_target_required:
        "Select one writable Mind in the Site connection settings before writing.",
      writable_target_mismatch:
        "The requested Mind is not the writable target selected for this credential.",
      writable_target_unavailable:
        "The selected writable Mind or credential is no longer available.",
    });
    return createMcpToolErrorResult(
      requestId,
      code,
      messages[code],
      retryable,
    );
  }

  async listTools(_request: {
    readonly actor: AuthenticatedActor;
  }): Promise<readonly Readonly<Record<string, unknown>>[]> {
    if (
      this.#dependencies.uploadIntents !== undefined &&
      this.#dependencies.uploadIntentUrl !== undefined
    ) return MCP_TOOL_DEFINITIONS;
    return Object.freeze(
      MCP_TOOL_DEFINITIONS.filter(
        (definition) => definition.name !== "create_file_upload_intent",
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
      request.name === "start_export" ||
      request.name === "get_export_status" ||
      request.name === "list_minds" ||
      request.name === "fetch" ||
      request.name === "get_file_ingress_capabilities"
    ) {
      return Object.freeze({ kind: "allowed" as const });
    }
    try {
      const input = camelInput(request.arguments);
      if (request.name === "resolve_mind") {
        await this.#dependencies.discovery.resolveMind(request.actor, input.handle);
        return Object.freeze({ kind: "allowed" as const });
      }
      const info = await this.#dependencies.discovery.getMindInfo(
        request.actor,
        targetMind(input),
        input.revisionSelector,
      );
      const required =
        request.name === "commit_changeset" ||
          request.name === "reconcile_changeset" ||
          request.name === "capture_knowledge" ||
          request.name === "create_file_upload_intent" ||
          request.name === "stage_bundle_file" ||
          request.name === "reconcile_file_stage"
          ? "commit"
          : null;
      if (required !== null && !info.contentCapabilities.includes(required)) {
        return Object.freeze({ kind: "denied" as const, code: "forbidden" });
      }
      return Object.freeze({ kind: "allowed" as const });
    } catch {
      return Object.freeze({ kind: "denied" as const, code: "mind_not_found" });
    }
  }

  async executeAuthorizedToolCall(
    request: Parameters<NonNullable<McpContentApplication["executeAuthorizedToolCall"]>>[0],
  ): Promise<unknown> {
    return this.executeToolCall(request);
  }

  async executeToolCall(request: Parameters<McpContentApplication["executeToolCall"]>[0]): Promise<unknown> {
    const input = camelInput(request.arguments);
    switch (request.name) {
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
          const hostedUploadIntents =
            this.#dependencies.uploadIntents !== undefined &&
            this.#dependencies.uploadIntentUrl !== undefined;
          const sources = Object.freeze([
            "session_attachment",
            "local_path",
            "workspace/generated_artifact",
            "connector_object",
            "bounded_in_memory",
            "server_generated",
          ].map((sourceKind) => {
            const available = hostedUploadIntents &&
              (sourceKind === "local_path" ||
                sourceKind === "workspace/generated_artifact");
            return Object.freeze({
              sourceKind,
              serverAdapterStatus: available ? "available" : "not_available",
              serverTransport: available ? "companion_upload_intent" : "none",
              requiresWritableTarget: available,
              maxBytes: available ? 268_435_456 : 0,
              fallback: "none",
            });
          }));
        return createMcpToolSuccessResult(
          snakeOutput({
            reportScope: "hosted_server_adapters_only",
            clientCompanionStatus: "not_reported",
            pathAdmissionStatus: "not_reported",
            sources,
          }),
          "Read the hosted server-adapter matrix; client inventory and path admission are not reported.",
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
            "sourceKind",
            "displayFilename",
            ...(input.claimedMediaType === undefined
              ? []
              : ["claimedMediaType"]),
            "expectedSize",
            "expectedSha256",
            "idempotencyKey",
          ])
        ) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The upload intent arguments are invalid.",
            false,
          );
        }
        let info;
        try {
          info = await this.#dependencies.discovery.getMindInfo(
            request.actor,
            input.mind,
            { kind: "head" },
          );
        } catch {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "mind_not_found",
            "The requested Mind is unavailable.",
            false,
          );
        }
        if (!info.contentCapabilities.includes("commit")) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "forbidden",
            "The requested operation is not allowed.",
            false,
          );
        }
        const target = await this.#resolveWritableTarget(
          request.actor,
          info.mind.mindId,
        );
        if (target.kind === "error") return target.result;
        const {
          mind: _mind,
          ...intentArguments
        } = request.arguments;
        const created = await this.#dependencies.uploadIntents.create(
          request.actor,
          info.mind.mindId,
          Object.freeze({
            ...intentArguments,
            write_binding_id: target.writeBindingId,
          }),
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
            created.code === "write_binding_required" ||
            created.code === "write_binding_stale"
          ) {
            return this.#writableTargetError(
              request.actor.requestId,
              created.code === "write_binding_required"
                ? "writable_target_required"
                : "writable_target_unavailable",
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
        if (!validStageBundleFileInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The native file staging arguments are invalid.",
            false,
          );
        }
        const info = await this.#dependencies.discovery.getMindInfo(
          request.actor,
          input.mind,
          { kind: "head" },
        );
        if (!info.contentCapabilities.includes("commit")) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "forbidden",
            "The requested operation is not allowed.",
            false,
          );
        }
        const target = await this.#resolveWritableTarget(
          request.actor,
          info.mind.mindId,
        );
        if (target.kind === "error") return target.result;
        if (
          this.#dependencies.nativeFiles === undefined ||
          this.#dependencies.staging === undefined
        ) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "native_file_input_unsupported",
            "This deployed client/profile cannot supply native file input.",
            false,
          );
        }
        let downloaded;
        try {
          downloaded = await this.#dependencies.nativeFiles.download(input.file);
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
        const staged = await this.#dependencies.staging.stageStream({
          actor: request.actor,
          spaceId: info.mind.mindId,
          writeBindingId: target.writeBindingId as never,
          displayFilename: input.displayFilename ?? downloaded.fileName,
          claimedMediaType: downloaded.mimeType,
          stream: downloaded.stream,
          maxBytes: 268_435_456,
          idempotencyKey: input.idempotencyKey,
          expectedSize: input.expectedSize,
          expectedSha256: input.expectedSha256,
        });
        if (staged.kind === "denied") {
          const decision = staged.decision as Readonly<{
            code?: unknown;
            retryable?: unknown;
          }>;
          if (
            decision.code === "write_binding_required" ||
            decision.code === "write_binding_stale" ||
            decision.code === "binding_state_unavailable"
          ) {
            return this.#writableTargetError(
              request.actor.requestId,
              decision.code === "write_binding_required"
                ? "writable_target_required"
                : "writable_target_unavailable",
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
          if (staged.code === "binding_mismatch") {
            return this.#writableTargetError(
              request.actor.requestId,
              "writable_target_unavailable",
            );
          }
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
        const info = await this.#dependencies.discovery.getMindInfo(
          request.actor,
          input.mind,
          { kind: "head" },
        );
        if (!info.contentCapabilities.includes("commit")) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "forbidden",
            "The requested operation is not allowed.",
            false,
          );
        }
        const target = await this.#resolveWritableTarget(
          request.actor,
          info.mind.mindId,
        );
        if (target.kind === "error") return target.result;
        const reconciled = await this.#dependencies.ingress.reconcileStage({
          actor: request.actor,
          spaceId: info.mind.mindId,
          writeBindingId: target.writeBindingId as never,
          sourceKind: input.sourceKind,
          displayFilename: input.displayFilename,
          claimedMediaType: input.claimedMediaType,
          mediaType: input.mediaType,
          sha256: input.sha256,
          size: input.size,
          idempotencyKey: input.idempotencyKey,
          expectedSize: input.expectedSize,
          expectedSha256: input.expectedSha256,
        });
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
            decision.code === "write_binding_required" ||
            decision.code === "write_binding_stale" ||
            decision.code === "binding_state_unavailable"
          ) {
            return this.#writableTargetError(
              request.actor.requestId,
              decision.code === "write_binding_required"
                ? "writable_target_required"
                : "writable_target_unavailable",
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
          if (reconciled.code === "binding_mismatch") {
            return this.#writableTargetError(
              request.actor.requestId,
              "writable_target_unavailable",
            );
          }
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
      case "get_bundle_file_download":
        return createMcpToolSuccessResult(
          snakeOutput(await this.#dependencies.bundleFileDownloads.issue(request.actor, input)),
          "Created a one-use BundleFile download.",
        );
      case "commit_changeset": {
        if (!validChangesetInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The changeset arguments are invalid.",
            false,
          );
        }
        const info = await this.#dependencies.discovery.getMindInfo(request.actor, input.mind, { kind: "head" });
        if (!info.contentCapabilities.includes("commit")) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "forbidden",
            "The requested operation is not allowed.",
            false,
          );
        }
        const target = await this.#resolveWritableTarget(
          request.actor,
          info.mind.mindId,
        );
        if (target.kind === "error") return target.result;
        const result = await this.#dependencies.commits.commit({
          actor: request.actor,
          spaceId: info.mind.mindId,
          writeBindingId: target.writeBindingId as never,
          expectedRevisionId: input.expectedRevision as never,
          idempotencyKey: input.idempotencyKey as never,
          summary: input.summary as never,
          operations: canonicalCommitOperations(input.operations) as never,
        });
        if (result.kind === "committed") {
          await this.#dependencies.scheduleCommitEffects?.();
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
              indexStatus: "queued",
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
        if (
          code === "write_binding_required" ||
          code === "write_binding_stale" ||
          code === "binding_state_unavailable"
        ) {
          return this.#writableTargetError(
            request.actor.requestId,
            code === "write_binding_required"
              ? "writable_target_required"
              : "writable_target_unavailable",
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
      case "reconcile_changeset": {
        if (!validChangesetInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_request",
            "The changeset reconciliation arguments are invalid.",
            false,
          );
        }
        const info = await this.#dependencies.discovery.getMindInfo(
          request.actor,
          input.mind,
          { kind: "head" },
        );
        if (!info.contentCapabilities.includes("commit")) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "forbidden",
            "The requested operation is not allowed.",
            false,
          );
        }
        const target = await this.#resolveWritableTarget(
          request.actor,
          info.mind.mindId,
        );
        if (target.kind === "error") return target.result;
        const result = await this.#dependencies.ingress.reconcileCommit({
          actor: request.actor,
          spaceId: info.mind.mindId,
          writeBindingId: target.writeBindingId as never,
          expectedRevisionId: input.expectedRevision as never,
          idempotencyKey: input.idempotencyKey as never,
          summary: input.summary as never,
          operations: canonicalCommitOperations(input.operations) as never,
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
        if (
          code === "write_binding_required" ||
          code === "write_binding_stale" ||
          code === "binding_state_unavailable"
        ) {
          return this.#writableTargetError(
            request.actor.requestId,
            code === "write_binding_required"
              ? "writable_target_required"
              : "writable_target_unavailable",
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
      case "capture_knowledge": {
        if (!validCaptureInput(input)) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "invalid_capture_request",
            "The capture arguments are invalid or outside the routine non-sensitive policy.",
            false,
          );
        }
        const info = await this.#dependencies.discovery.getMindInfo(
          request.actor,
          input.mind,
          { kind: "head" },
        );
        if (!info.contentCapabilities.includes("commit")) {
          return createMcpToolErrorResult(
            request.actor.requestId,
            "forbidden",
            "The requested operation is not allowed.",
            false,
          );
        }
        const target = await this.#resolveWritableTarget(
          request.actor,
          info.mind.mindId,
        );
        if (target.kind === "error") return target.result;
        const result = await this.#dependencies.capture.capture({
          actor: request.actor,
          spaceId: info.mind.mindId,
          writeBindingId: target.writeBindingId as never,
          expectedBindingVersion: target.targetVersion,
          expectedRevisionId: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          classification: input.classification,
          captureKind: input.captureKind,
          captureKey: input.captureKey,
          title: input.title,
          description: input.description,
          body: input.body,
          sources: input.sources,
        });
        if (result.kind === "captured" || result.kind === "no_op") {
          if (result.kind === "captured") {
            await this.#dependencies.scheduleCommitEffects?.();
          }
          const capturedInfo = await this.#dependencies.discovery.getMindInfo(
            request.actor,
            input.mind,
            { kind: "revision", revisionId: result.revisionId },
          );
          return createMcpToolSuccessResult(
            snakeOutput({
              status: result.kind,
              mind: capturedInfo.mind,
              path: result.path,
              previousRevisionId:
                result.kind === "captured" ? result.previousRevisionId : null,
              revision: capturedInfo.resolvedRevision,
              indexStatus: result.kind === "captured" ? "queued" : "unchanged",
              replayed: result.kind === "captured" ? result.replayed : false,
            }),
            result.kind === "captured"
              ? "Captured one routine Memory in a new immutable revision."
              : "The exact routine Memory already exists; no revision was created.",
          );
        }
        const code = result.kind === "denied"
          ? result.decision.code
          : result.kind === "invalid"
              ? result.error.code
              : result.kind;
        if (
          code === "write_binding_required" ||
          code === "write_binding_stale" ||
          code === "binding_state_unavailable" ||
          code === "capture_binding_stale"
        ) {
          return this.#writableTargetError(
            request.actor.requestId,
            code === "write_binding_required"
              ? "writable_target_required"
              : "writable_target_unavailable",
            result.kind === "denied" && result.decision.retryable,
          );
        }
        const messages: Readonly<Record<string, string>> = Object.freeze({
          invalid_capture_request: "The capture arguments are invalid or outside the routine non-sensitive policy.",
          capture_disabled: "Automatic capture is disabled for this credential.",
          capture_binding_stale: "The automatic capture policy is not pinned to this current write binding generation.",
          capture_target_visibility_blocked: "Automatic capture is available only for a private target Mind.",
          capture_confirmation_required: "This source requires explicit user confirmation and a normal changeset.",
          capture_conflict: "The stable capture key already names different content; no overwrite was attempted.",
          capture_target_not_ready: "The target Mind is not ready for automatic capture.",
          revision_conflict: "HEAD changed; inspect the current revision before considering a new capture.",
        });
        return createMcpToolErrorResult(
          request.actor.requestId,
          code,
          messages[code] ?? "The routine Memory was not captured.",
          result.kind === "revision_conflict" ||
            (result.kind === "denied" && result.decision.retryable),
          snakeOutput(result) as Readonly<Record<string, unknown>>,
        );
      }
    }
  }

}
