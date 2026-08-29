import type { ActorContext } from "@mind-diary/application-contracts";
import type { PersonalMindProfileSnapshot, PublicMindCatalogStore, VerifiedSpaceHost } from "@mind-diary/application-ports";
import { MindRouteService, MindRouteFailure } from "./mind-route.js";
import type { OrdinaryMindRouteDescriptor } from "./mind-route.js";
import { safeBootstrapRequestId } from "./account-bootstrap.js";
import { registeredSitesPrincipal } from "./personal-mind-control.js";

export type PublicMindCatalogFailureCode =
  | "authentication_required"
  | "invalid_query"
  | "invalid_cursor"
  | "invalid_limit"
  | "catalog_unavailable";

/** Safe catalog failure without candidate IDs or target metadata. */
export class PublicMindCatalogFailure extends Error {
  readonly code: PublicMindCatalogFailureCode;

  constructor(code: PublicMindCatalogFailureCode, message: string) {
    super(message);
    this.name = "PublicMindCatalogFailure";
    this.code = code;
  }
}

export interface ListPublicMindsQuery {
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

interface NormalizedPublicMindCatalogQuery {
  readonly cursor: unknown;
  readonly limit: unknown;
}

export interface PublicMindCatalogResult {
  readonly minds: readonly Readonly<OrdinaryMindRouteDescriptor>[];
  readonly nextCursor: string | null;
}

export interface PublicMindCatalogSafeEvent {
  readonly event:
    | "public_minds_returned"
    | "public_minds_denied"
    | "public_minds_invalid_cursor"
    | "public_minds_failed";
  readonly requestId: ActorContext["requestId"];
}

export interface PublicMindCatalogSafeLogger {
  record(event: Readonly<PublicMindCatalogSafeEvent>): void | Promise<void>;
}

export interface PublicMindCatalogDependencies {
  readonly catalog: PublicMindCatalogStore;
  readonly host: VerifiedSpaceHost;
  readonly logger?: PublicMindCatalogSafeLogger;
}

const PUBLIC_MIND_CATALOG_DEFAULT_LIMIT = 50;
const PUBLIC_MIND_CATALOG_MAX_LIMIT = 100;
const PUBLIC_MIND_CATALOG_MAX_CURSOR_BYTES = 256;

function normalizePublicMindCatalogQuery(
  query: unknown,
): Readonly<NormalizedPublicMindCatalogQuery> | null {
  try {
    if (
      typeof query !== "object" ||
      query === null ||
      Array.isArray(query) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(query))
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(query);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" || (key !== "cursor" && key !== "limit"),
      )
    ) {
      return null;
    }
    for (const key of ["cursor", "limit"] as const) {
      const descriptor = descriptors[key];
      if (descriptor && !("value" in descriptor)) return null;
    }
    return Object.freeze({
      cursor: descriptors.cursor?.value,
      limit: descriptors.limit?.value,
    });
  } catch {
    return null;
  }
}

function recordPublicMindCatalogEvent(
  logger: PublicMindCatalogSafeLogger | undefined,
  event: PublicMindCatalogSafeEvent["event"],
  requestId: ActorContext["requestId"],
): void {
  if (!logger) return;
  try {
    const pending = logger.record(Object.freeze({ event, requestId }));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Safe observability remains outside catalog reads.
  }
}

/** Authenticated, fail-closed discovery over opaque public projection IDs. */
export class PublicMindCatalogService {
  readonly #catalog: PublicMindCatalogStore;
  readonly #host: VerifiedSpaceHost;
  readonly #routes: MindRouteService;
  readonly #logger: PublicMindCatalogSafeLogger | undefined;

  constructor(dependencies: PublicMindCatalogDependencies) {
    this.#catalog = dependencies.catalog;
    this.#host = dependencies.host;
    this.#routes = new MindRouteService({
      routes: dependencies.catalog,
      host: dependencies.host,
    });
    this.#logger = dependencies.logger;
  }

  async listPublicMinds(
    actor: ActorContext,
  ): Promise<Readonly<PublicMindCatalogResult>>;
  async listPublicMinds(
    actor: ActorContext,
    query: Readonly<ListPublicMindsQuery>,
  ): Promise<Readonly<PublicMindCatalogResult>>;
  async listPublicMinds(
    actor: ActorContext,
    query: unknown = {},
  ): Promise<Readonly<PublicMindCatalogResult>> {
    if (this.#catalog.withConsistentRead !== undefined) {
      return this.#catalog.withConsistentRead((catalog) => {
        const consistent = new PublicMindCatalogService({
          // The consistent-read view preserves the derived catalog method at
          // runtime; the base port types the callback as a route-only view.
          catalog: catalog as PublicMindCatalogStore,
          host: this.#host,
          ...(this.#logger === undefined ? {} : { logger: this.#logger }),
        });
        return consistent.#listPublicMinds(actor, query);
      });
    }
    return this.#listPublicMinds(actor, query);
  }

  async #listPublicMinds(
    actor: ActorContext,
    query: unknown = {},
  ): Promise<Readonly<PublicMindCatalogResult>> {
    const requestId = safeBootstrapRequestId(actor?.requestId);
    const principalId = registeredSitesPrincipal(actor);
    if (principalId === null) {
      recordPublicMindCatalogEvent(this.#logger, "public_minds_denied", requestId);
      throw new PublicMindCatalogFailure(
        "authentication_required",
        "A registered Sites principal is required.",
      );
    }

    // Prove that the actor still owns an active account before catalog state read,
    // including for an empty projection or a later-invalid cursor.
    let profile: Readonly<PersonalMindProfileSnapshot> | null;
    try {
      profile = await this.#catalog.readPersonalMindProfile(principalId);
    } catch {
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_failed",
        requestId,
      );
      throw new PublicMindCatalogFailure(
        "catalog_unavailable",
        "Public catalog is unavailable.",
      );
    }
    if (profile === null || profile.principalId !== principalId) {
      recordPublicMindCatalogEvent(this.#logger, "public_minds_denied", requestId);
      throw new PublicMindCatalogFailure(
        "authentication_required",
        "An active registered Sites principal is required.",
      );
    }

    const normalizedQuery = normalizePublicMindCatalogQuery(query);
    if (normalizedQuery === null) {
      throw new PublicMindCatalogFailure(
        "invalid_query",
        "Catalog query is invalid.",
      );
    }

    const cursor = normalizedQuery.cursor ?? null;
    if (
      cursor !== null &&
      (typeof cursor !== "string" ||
        cursor.length === 0 ||
        new TextEncoder().encode(cursor).byteLength >
          PUBLIC_MIND_CATALOG_MAX_CURSOR_BYTES)
    ) {
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_invalid_cursor",
        requestId,
      );
      throw new PublicMindCatalogFailure("invalid_cursor", "Cursor is invalid.");
    }
    const limit = normalizedQuery.limit ?? PUBLIC_MIND_CATALOG_DEFAULT_LIMIT;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PUBLIC_MIND_CATALOG_MAX_LIMIT
    ) {
      throw new PublicMindCatalogFailure(
        "invalid_limit",
        "Limit must be an integer between 1 and 100.",
      );
    }

    try {
      const page = await this.#catalog.listPublicMindCatalogPage({ cursor, limit });
      if (page.kind === "invalid_cursor") {
        recordPublicMindCatalogEvent(
          this.#logger,
          "public_minds_invalid_cursor",
          requestId,
        );
        throw new PublicMindCatalogFailure("invalid_cursor", "Cursor is invalid.");
      }
      if (
        page.kind !== "page" ||
        !Array.isArray(page.spaceIds) ||
        page.spaceIds.length > limit ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" ||
            page.nextCursor.length === 0 ||
            new TextEncoder().encode(page.nextCursor).byteLength >
              PUBLIC_MIND_CATALOG_MAX_CURSOR_BYTES))
      ) {
        throw new PublicMindCatalogFailure(
          "catalog_unavailable",
          "Public catalog is unavailable.",
        );
      }
      const minds: Readonly<OrdinaryMindRouteDescriptor>[] = [];
      for (const candidateId of new Set<unknown>(page.spaceIds)) {
        if (typeof candidateId !== "string" || candidateId.length === 0) {
          continue;
        }
        try {
          minds.push(
            await this.#routes.resolvePublicCatalogMind(actor, candidateId),
          );
        } catch (error) {
          if (error instanceof MindRouteFailure && error.code === "mind_not_found") {
            continue;
          }
          throw error;
        }
      }
      const finalProfile = await this.#catalog.readPersonalMindProfile(principalId);
      if (finalProfile === null || finalProfile.principalId !== principalId) {
        recordPublicMindCatalogEvent(
          this.#logger,
          "public_minds_denied",
          requestId,
        );
        throw new PublicMindCatalogFailure(
          "authentication_required",
          "An active registered Sites principal is required.",
        );
      }
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_returned",
        requestId,
      );
      return Object.freeze({
        minds: Object.freeze(minds),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof PublicMindCatalogFailure) {
        if (error.code === "catalog_unavailable") {
          recordPublicMindCatalogEvent(
            this.#logger,
            "public_minds_failed",
            requestId,
          );
        }
        throw error;
      }
      recordPublicMindCatalogEvent(
        this.#logger,
        "public_minds_failed",
        requestId,
      );
      throw new PublicMindCatalogFailure(
        "catalog_unavailable",
        "Public catalog is unavailable.",
      );
    }
  }
}
