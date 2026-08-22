import type {
  AutomaticCaptureService,
  ChangesetCommitService,
  ExportJobApplicationService,
  MindBindingApplicationService,
  MindBrowseService,
  MindDiscoveryService,
  MindHistoryService,
  MindSearchService,
  MindValidationService,
  MindBindingCommandResult,
  ReadMindBindingsResult,
} from "@mind-diary/application-content";
import {
  MCP_TOOL_DEFINITIONS,
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
  readonly browse: Pick<MindBrowseService, "browseEntries" | "fetch" | "readResource">;
  readonly search: Pick<MindSearchService, "searchEntries">;
  readonly history: Pick<MindHistoryService, "listRevisions" | "getRevision">;
  readonly validation: Pick<MindValidationService, "validateMind">;
  readonly bindings: Pick<
    MindBindingApplicationService,
    "read" | "mutateRead" | "mutateWrite"
  >;
  readonly commits: Pick<ChangesetCommitService, "commit">;
  readonly capture: Pick<AutomaticCaptureService, "capture">;
  readonly exports: Pick<ExportJobApplicationService, "start" | "getStatus">;
  /** Schedules durable work by opaque ID; the payload never carries authority. */
  readonly scheduleExport?: (jobId: string) => void | Promise<void>;
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
    if (!("expectedSha256" in operation)) return operation;
    const { expectedSha256, ...rest } = operation;
    return Object.freeze({ ...rest, expected_sha256: expectedSha256 });
  }));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

function bindingVersionValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function idempotencyKeyValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
    "writeBindingId",
    "expectedBindingVersion",
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
    stringValue(input.writeBindingId) !== null &&
    bindingVersionValue(input.expectedBindingVersion) &&
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

/** Complete custom Mind-aware content application behind the MCP HTTP adapters. */
export class ProductMcpContentApplication implements McpContentApplication {
  readonly #dependencies: ProductMcpApplicationDependencies;

  constructor(dependencies: ProductMcpApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  async listTools(): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return MCP_TOOL_DEFINITIONS;
  }

  async listRootResources(request: {
    readonly actor: AuthenticatedActor;
    readonly cursor?: string;
  }): Promise<Readonly<McpRootResourcePage>> {
    if (request.cursor !== undefined) {
      return Object.freeze({ resources: Object.freeze([]), nextCursor: null });
    }
    const current = await this.#dependencies.bindings.read({ actor: request.actor });
    if (
      current.kind !== "ready" ||
      current.bindings.bindingSet.state !== "active"
    ) {
      return Object.freeze({ resources: Object.freeze([]), nextCursor: null });
    }
    const spaceIds = new Set(
      current.bindings.readBindings
        .filter((binding) => binding.state === "active")
        .map((binding) => binding.spaceId),
    );
    if (current.bindings.writeBinding?.state === "active") {
      spaceIds.add(current.bindings.writeBinding.spaceId);
    }
    const resources = [];
    for (const spaceId of [...spaceIds].sort()) {
      try {
        const info = await this.#dependencies.discovery.getMindInfo(
          request.actor,
          spaceId,
          { kind: "head" },
        );
        resources.push(
          Object.freeze({
            uri: rootUri(info.mind.mindId, info.resolvedRevision.revisionId),
            name: info.mind.name,
            title: `${info.mind.name} · index.md`,
            description: "Bound immutable root index of this Mind revision.",
            mimeType: "text/markdown; charset=utf-8" as const,
          }),
        );
      } catch {
        // Current ACL loss redacts the stale target instead of leaking metadata.
      }
    }
    return Object.freeze({ resources: Object.freeze(resources), nextCursor: null });
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
      request.name === "list_minds" ||
      request.name === "fetch" ||
      request.name === "get_export_status" ||
      request.name === "get_mind_bindings" ||
      request.name === "set_read_mind_binding" ||
      request.name === "set_write_mind_binding"
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
        request.name === "commit_changeset" || request.name === "capture_knowledge"
          ? "commit"
          : request.name === "start_export"
            ? "export"
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
      case "list_minds":
        return snakeOutput(await this.#dependencies.discovery.listMinds(request.actor, input));
      case "resolve_mind":
        return snakeOutput(await this.#dependencies.discovery.resolveMind(request.actor, input.handle));
      case "get_mind_info":
        return snakeOutput(await this.#dependencies.discovery.getMindInfo(request.actor, input.mind, input.revisionSelector));
      case "get_mind_bindings": {
        if (!hasExactKeys(input, [])) {
          return this.#bindingError(request.actor.requestId, "invalid_request");
        }
        const read = await this.#dependencies.bindings.read({ actor: request.actor });
        if (read.kind !== "ready") {
          return this.#bindingError(request.actor.requestId, read.kind);
        }
        if (read.bindings.bindingSet.state !== "active") {
          return this.#bindingError(request.actor.requestId, "binding_owner_revoked");
        }
        return createMcpToolSuccessResult(
          snakeOutput(await this.#projectBindings(request.actor, read.bindings)),
          "Read the current Mind bindings.",
        );
      }
      case "set_read_mind_binding": {
        if (
          !hasExactKeys(input, [
            "action",
            "mind",
            "expectedBindingVersion",
            "idempotencyKey",
          ]) ||
          (input.action !== "attach" && input.action !== "detach") ||
          !stringValue(input.mind) ||
          !bindingVersionValue(input.expectedBindingVersion) ||
          !idempotencyKeyValue(input.idempotencyKey)
        ) {
          return this.#bindingError(request.actor.requestId, "invalid_request");
        }
        let spaceId: string | null = null;
        if (input.action === "detach") {
          const current = await this.#dependencies.bindings.read({ actor: request.actor });
          if (current.kind === "ready") {
            spaceId =
              current.bindings.readBindings.find(
                (binding) => binding.spaceId === input.mind,
              )?.spaceId ?? null;
          }
        }
        if (spaceId === null) {
          try {
            const info = await this.#dependencies.discovery.getMindInfo(
              request.actor,
              input.mind,
              { kind: "head" },
            );
            spaceId = info.mind.mindId;
          } catch {
            return this.#bindingError(request.actor.requestId, "mind_not_found");
          }
        }
        const result = await this.#dependencies.bindings.mutateRead({
          actor: request.actor,
          action: input.action,
          spaceId: spaceId as never,
          expectedBindingVersion: input.expectedBindingVersion,
          idempotencyKey: input.idempotencyKey,
        });
        if (result.kind !== "applied") {
          return this.#bindingResultError(request.actor.requestId, result);
        }
        return createMcpToolSuccessResult(
          snakeOutput({
            changed: result.changed,
            replayed: result.replayed,
            bindings: await this.#projectBindings(request.actor, result.bindings),
          }),
          result.changed
            ? `${input.action === "attach" ? "Attached" : "Detached"} the read Mind binding.`
            : "The read Mind binding was already in the requested state.",
        );
      }
      case "set_write_mind_binding": {
        const bind = input.action === "bind";
        const expectedKeys = bind
          ? ["action", "mind", "expectedBindingVersion", "idempotencyKey"]
          : ["action", "expectedBindingVersion", "idempotencyKey"];
        if (
          (input.action !== "bind" && input.action !== "unbind") ||
          !hasExactKeys(input, expectedKeys) ||
          (bind && !stringValue(input.mind)) ||
          !bindingVersionValue(input.expectedBindingVersion) ||
          !idempotencyKeyValue(input.idempotencyKey)
        ) {
          return this.#bindingError(request.actor.requestId, "invalid_request");
        }
        let result: MindBindingCommandResult;
        if (bind) {
          let spaceId: string;
          try {
            const info = await this.#dependencies.discovery.getMindInfo(
              request.actor,
              input.mind,
              { kind: "head" },
            );
            spaceId = info.mind.mindId;
          } catch {
            return this.#bindingError(request.actor.requestId, "mind_not_found");
          }
          result = await this.#dependencies.bindings.mutateWrite({
            actor: request.actor,
            action: "bind",
            spaceId: spaceId as never,
            expectedBindingVersion: input.expectedBindingVersion,
            idempotencyKey: input.idempotencyKey,
          });
        } else {
          result = await this.#dependencies.bindings.mutateWrite({
            actor: request.actor,
            action: "unbind",
            expectedBindingVersion: input.expectedBindingVersion,
            idempotencyKey: input.idempotencyKey,
          });
        }
        if (result.kind !== "applied") {
          return this.#bindingResultError(request.actor.requestId, result);
        }
        return createMcpToolSuccessResult(
          snakeOutput({
            bindingVersion: result.bindings.bindingSet.bindingVersion,
            changed: result.changed,
            replayed: result.replayed,
            previous:
              result.previousWriteBinding === null
                ? null
                : await this.#projectWriteBinding(
                    request.actor,
                    result.previousWriteBinding,
                  ),
            current:
              result.bindings.writeBinding === null
                ? null
                : await this.#projectWriteBinding(
                    request.actor,
                    result.bindings.writeBinding,
                  ),
          }),
          result.changed
            ? bind
              ? "Selected the singleton writable Mind binding."
              : "Removed the writable Mind binding."
            : "The writable Mind binding was already in the requested state.",
        );
      }
      case "browse_entries":
        return snakeOutput(await this.#dependencies.browse.browseEntries(request.actor, input));
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
      case "commit_changeset": {
        const info = await this.#dependencies.discovery.getMindInfo(request.actor, input.mind, { kind: "head" });
        const result = await this.#dependencies.commits.commit({
          actor: request.actor,
          spaceId: info.mind.mindId,
          writeBindingId: input.writeBindingId,
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
        return createMcpToolErrorResult(
          request.actor.requestId,
          code,
          code === "write_binding_required"
            ? "Select exactly one writable Mind before committing."
            : code === "write_binding_stale"
              ? "The writable Mind changed; inspect current bindings and rebuild the commit."
              : "The changeset was not committed.",
          result.kind === "revision_conflict" ||
            (result.kind === "denied" && result.decision.retryable),
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
        const result = await this.#dependencies.capture.capture({
          actor: request.actor,
          spaceId: info.mind.mindId,
          writeBindingId: input.writeBindingId,
          expectedBindingVersion: input.expectedBindingVersion,
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
      case "start_export": {
        const info = await this.#dependencies.discovery.getMindInfo(request.actor, input.mind, input.revisionSelector);
        const result = await this.#dependencies.exports.start({
          actor: request.actor,
          spaceId: info.mind.mindId,
          revisionSelector: input.revisionSelector as never,
          idempotencyKey: input.idempotencyKey as never,
        });
        if (result.kind === "started") {
          await this.#dependencies.scheduleExport?.(result.job.jobId);
          return createMcpToolSuccessResult(
            snakeOutput({
              job: {
                jobId: result.job.jobId,
                status: result.job.status,
                revisionId: result.job.revisionId,
                createdAt: result.job.createdAt,
              },
            }),
            "Started an exact-revision export.",
          );
        }
        const code =
          result.kind === "denied" ? result.decision.code : result.kind;
        return createMcpToolErrorResult(
          request.actor.requestId,
          code,
          code === "mind_binding_required"
            ? "Attach this Mind for reading or select it as the writable target first."
            : "The export was not started.",
          result.kind === "denied" && result.decision.retryable,
          snakeOutput(result) as Readonly<Record<string, unknown>>,
        );
      }
      case "get_export_status": {
        const jobId = stringValue(input.jobId);
        const result = await this.#dependencies.exports.getStatus({
          actor: request.actor,
          jobId: (jobId ?? "") as never,
        });
        if (result.kind !== "found") {
          return createMcpToolErrorResult(
            request.actor.requestId,
            result.kind,
            "Export job was not found.",
            false,
          );
        }
        const archive = result.job.archive;
        const download = result.download;
        return createMcpToolSuccessResult(
          snakeOutput({
            job: {
              jobId: result.job.jobId,
              status: result.job.status,
              revisionId: result.job.revisionId,
              createdAt: result.job.createdAt,
              updatedAt: result.job.updatedAt,
              completedAt: result.job.completedAt,
              expiresAt: result.job.expiresAt,
              lastFailureCode: result.job.lastFailureCode,
              ...(archive === null
                ? {}
                : {
                    archiveFormat: archive.archiveFormat,
                    mediaType: archive.mediaType,
                    filename: archive.filename,
                    contentDisposition: archive.contentDisposition,
                    sha256: archive.sha256,
                    size: archive.size,
                  }),
              ...(download === null
                ? {}
                : {
                    downloadUrl: download.url,
                    downloadExpiresAt: download.expiresAt,
                  }),
            },
          }),
          "Read the exact-revision export status.",
        );
      }
    }
  }

  async #projectBindings(
    actor: AuthenticatedActor,
    snapshot: Extract<
      ReadMindBindingsResult,
      { readonly kind: "ready" }
    >["bindings"],
  ) {
    return Object.freeze({
      bindingVersion: snapshot.bindingSet.bindingVersion,
      readBindings: Object.freeze(
        await Promise.all(
          snapshot.readBindings.map(async (binding) => {
            const target = await this.#projectTarget(actor, binding.spaceId);
            return Object.freeze({
              readBindingId: binding.readBindingId,
              mindId: binding.spaceId,
              ...target,
            });
          }),
        ),
      ),
      writeBinding:
        snapshot.writeBinding === null
          ? null
          : await this.#projectWriteBinding(actor, snapshot.writeBinding),
      automaticCapture: Object.freeze({
        mode: snapshot.bindingSet.automaticCaptureMode,
        writeBindingId: snapshot.bindingSet.captureWriteBindingId,
        updatedAt: snapshot.bindingSet.captureUpdatedAt,
      }),
    });
  }

  async #projectWriteBinding(
    actor: AuthenticatedActor,
    binding: NonNullable<
      Extract<
        ReadMindBindingsResult,
        { readonly kind: "ready" }
      >["bindings"]["writeBinding"]
    >,
  ) {
    const target = await this.#projectTarget(actor, binding.spaceId);
    return Object.freeze({
      writeBindingId: binding.writeBindingId,
      mindId: binding.spaceId,
      generation: binding.generation,
      state: binding.state,
      ...target,
    });
  }

  async #projectTarget(actor: AuthenticatedActor, spaceId: string) {
    try {
      const info = await this.#dependencies.discovery.getMindInfo(
        actor,
        spaceId,
        { kind: "head" },
      );
      return Object.freeze({
        availability: "available" as const,
        mind: info.mind,
        contentCapabilities: info.contentCapabilities,
      });
    } catch {
      return Object.freeze({
        availability: "unavailable" as const,
        mind: null,
        contentCapabilities: Object.freeze([]),
      });
    }
  }

  #bindingResultError(
    requestId: AuthenticatedActor["requestId"],
    result: Exclude<MindBindingCommandResult, { readonly kind: "applied" }>,
  ) {
    if (result.kind === "denied") {
      return this.#bindingError(
        requestId,
        result.decision.code,
        result.decision.retryable,
      );
    }
    if (result.kind === "invalid") {
      return this.#bindingError(requestId, "invalid_request");
    }
    if (result.kind === "binding_version_conflict") {
      return createMcpToolErrorResult(
        requestId,
        result.kind,
        "The binding state changed; inspect current bindings and rebuild the mutation.",
        true,
        Object.freeze({
          current_binding_version: result.currentBindingVersion,
        }),
      );
    }
    return this.#bindingError(
      requestId,
      result.kind === "owner_mismatch" || result.kind === "invalid_record"
        ? "binding_state_unavailable"
        : result.kind,
      result.kind === "effect_conflict",
    );
  }

  #bindingError(
    requestId: AuthenticatedActor["requestId"],
    code: string,
    retryable = false,
  ) {
    const messages: Readonly<Record<string, string>> = Object.freeze({
      invalid_request: "The binding tool arguments are invalid.",
      mind_not_found: "Mind was not found.",
      insufficient_scope: "The token does not allow this binding operation.",
      capability_denied: "The current principal cannot bind this Mind.",
      access_denied: "Mind was not found.",
      binding_owner_revoked: "The token or OAuth grant can no longer use bindings.",
      binding_state_unavailable: "Mind binding state is unavailable.",
      idempotency_conflict: "The idempotency key was already used for another binding mutation.",
      effect_conflict: "Binding audit state changed; retry with a fresh request.",
    });
    const safeCode = code === "access_denied" ? "mind_not_found" : code;
    return createMcpToolErrorResult(
      requestId,
      safeCode,
      messages[code] ?? "The Mind binding operation failed.",
      retryable,
    );
  }
}
