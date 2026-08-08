import type {
  ChangesetCommitService,
  ExportJobApplicationService,
  MindBrowseService,
  MindDiscoveryService,
  MindHistoryService,
  MindSearchService,
  MindValidationService,
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
      request.name === "get_export_status"
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
        const output = snakeOutput(result);
        if (result.kind === "committed") {
          await this.#dependencies.scheduleCommitEffects?.();
          return createMcpToolSuccessResult(output, "Committed one immutable Mind revision.");
        }
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
          return createMcpToolSuccessResult(snakeOutput(result), "Started an exact-revision export.");
        }
        return createMcpToolErrorResult(request.actor.requestId, result.kind, "The export was not started.", false, snakeOutput(result) as Readonly<Record<string, unknown>>);
      }
      case "get_export_status": {
        const jobId = stringValue(input.jobId);
        const result = await this.#dependencies.exports.getStatus({
          actor: request.actor,
          jobId: (jobId ?? "") as never,
        });
        return result.kind === "found"
          ? createMcpToolSuccessResult(snakeOutput(result), "Read the exact-revision export status.")
          : createMcpToolErrorResult(request.actor.requestId, result.kind, "Export job was not found.", false);
      }
    }
  }
}
