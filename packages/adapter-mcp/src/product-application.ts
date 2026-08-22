import type {
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
    const result = await this.#dependencies.discovery.listMinds(request.actor, {
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: 100,
    });
    const resources = result.minds
      .filter((mind) => mind.discovery === "personal" || mind.discovery === "membership")
      .map((mind) =>
        Object.freeze({
          uri: rootUri(mind.mindId, mind.head.revisionId),
          name: mind.name,
          title: `${mind.name} · index.md`,
          description: "Authorized immutable root index of this Mind revision.",
          mimeType: "text/markdown; charset=utf-8" as const,
        }),
      );
    return Object.freeze({ resources: Object.freeze(resources), nextCursor: result.nextCursor });
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
        request.name === "commit_changeset"
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
          expectedRevisionId: input.expectedRevision as never,
          idempotencyKey: input.idempotencyKey as never,
          summary: input.summary as never,
          operations: input.operations as never,
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
        return createMcpToolErrorResult(request.actor.requestId, result.kind, "The changeset was not committed.", result.kind === "revision_conflict", output as Readonly<Record<string, unknown>>);
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
        return createMcpToolErrorResult(request.actor.requestId, result.kind, "The export was not started.", false, snakeOutput(result) as Readonly<Record<string, unknown>>);
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
