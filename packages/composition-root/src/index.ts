import {
  AUDIT_ADAPTER,
  InMemoryAuditSink,
  InMemoryPrivacySafeObservabilitySink,
  OBSERVABILITY_ADAPTER,
} from "@mind-diary/adapter-audit-memory";
import {
  SITES_AUDIT_ADAPTER,
  createSitesAuditSink,
  type D1DatabaseLike as AuditD1DatabaseLike,
} from "../../adapter-audit-sites/dist/index.js";
import { BACKGROUND_APPLICATION_BOUNDARY } from "@mind-diary/adapter-background";
import {
  MCP_APPLICATION_BOUNDARY,
  createMcpHttpHandler,
  type McpContentApplication,
  type McpRequestIdGenerator,
  type McpSafeLogger,
} from "@mind-diary/adapter-mcp";
import {
  METADATA_ADAPTER,
  InMemoryMcpTokenStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import {
  SITES_METADATA_ADAPTER,
  createSitesMetadataStore,
  type D1DatabaseLike as MetadataD1DatabaseLike,
} from "../../adapter-metadata-sites/dist/index.js";
import {
  OBJECT_ADAPTER,
  InMemoryObjectStore,
} from "@mind-diary/adapter-object-memory";
import {
  SITES_OBJECT_ADAPTER,
  createSitesObjectStore,
  type R2BucketLike,
} from "../../adapter-object-sites/dist/index.js";
import {
  SEARCH_ADAPTER,
  InMemoryExactRevisionSearchIndex,
} from "@mind-diary/adapter-search-memory";
import {
  SITES_SEARCH_ADAPTER,
  createSitesSearchIndex,
  type D1DatabaseLike as SearchD1DatabaseLike,
} from "../../adapter-search-sites/dist/index.js";
import {
  SECURITY_ADAPTER,
  createWebCryptoTokenHasher,
} from "@mind-diary/adapter-security-webcrypto";
import {
  WEB_APPLICATION_BOUNDARY,
  WebControlRequestSecurityBoundary,
  type WebControlRequestSecurityOptions,
} from "@mind-diary/adapter-web";
import {
  BACKGROUND_HANDLERS,
  BackgroundPrivacySafeObservability,
} from "@mind-diary/application-background";
import {
  CONTENT_COMMANDS,
  CONTENT_QUERIES,
  ContentPrivacySafeObservability,
  McpBearerAuthenticationService,
  type McpBearerAuthenticationDependencies,
} from "@mind-diary/application-content";
import {
  AccountDeletionService,
  CONTROL_COMMANDS,
  CONTROL_QUERIES,
  ControlPrivacySafeObservability,
  type AccountDeletionDependencies,
} from "@mind-diary/application-control";

export * from "./product-site.js";
export * from "./bounded-in-memory-ingress.js";
export * from "./google-drive-connector.js";
export { createProductUiStaticAssetResponse } from "@mind-diary/adapter-web";

export const COMPOSITION_SELECTION = {
  applications: {
    control: { queries: CONTROL_QUERIES, commands: CONTROL_COMMANDS },
    content: { queries: CONTENT_QUERIES, commands: CONTENT_COMMANDS },
    background: { handlers: BACKGROUND_HANDLERS },
  },
  inbound: {
    web: WEB_APPLICATION_BOUNDARY,
    mcp: MCP_APPLICATION_BOUNDARY,
    background: BACKGROUND_APPLICATION_BOUNDARY,
  },
  outbound: {
    metadata: METADATA_ADAPTER,
    objects: OBJECT_ADAPTER,
    search: SEARCH_ADAPTER,
    security: SECURITY_ADAPTER,
    audit: AUDIT_ADAPTER,
  },
  productionOutbound: {
    metadata: SITES_METADATA_ADAPTER,
    objects: SITES_OBJECT_ADAPTER,
    search: SITES_SEARCH_ADAPTER,
    audit: SITES_AUDIT_ADAPTER,
  },
  deployableServiceImplemented: true,
} as const;

export interface SitesPersistenceBoundaryOptions {
  readonly database: MetadataD1DatabaseLike &
    SearchD1DatabaseLike &
    AuditD1DatabaseLike;
  readonly bucket: R2BucketLike;
}

/**
 * Durable outbound boundary for the future product Site composition. It does
 * not create a deployable Site or claim live binding compatibility.
 */
export async function createSitesPersistenceBoundary(
  options: SitesPersistenceBoundaryOptions,
) {
  const [metadata, objects, index, audit] = await Promise.all([
    createSitesMetadataStore(options.database),
    createSitesObjectStore(options.bucket),
    createSitesSearchIndex(options.database),
    createSitesAuditSink(options.database),
  ]);
  return Object.freeze({
    metadata,
    tokens: metadata,
    objects,
    exportArchives: objects,
    index,
    audit,
  });
}

export interface LocalMcpHttpBoundaryOptions {
  readonly verifierKey: Uint8Array;
  readonly clock: McpBearerAuthenticationDependencies["clock"];
  readonly requestIds: McpRequestIdGenerator;
  readonly content: McpContentApplication;
  readonly logger?: McpSafeLogger;
  readonly observability?: ContentPrivacySafeObservability;
}

/**
 * Wires the local token store and Web Crypto verifier to the MCP adapter.
 * This is an injectable boundary, not a claim that a deployable service exists.
 */
export async function createLocalMcpHttpBoundary(
  options: LocalMcpHttpBoundaryOptions,
) {
  const tokens = new InMemoryMcpTokenStore();
  const tokenHasher = await createWebCryptoTokenHasher({
    verifierKey: options.verifierKey,
  });
  const authenticator = new McpBearerAuthenticationService({
    clock: options.clock,
    tokenHasher,
    tokens,
  });
  const handler = options.observability
    ? async (request: Request) => {
        const startedAt = performance.now();
        const requestId = options.requestIds.nextRequestId();
        const logger: McpSafeLogger = {
          async record(event) {
            options.observability?.recordMcpRequest({
              requestId: event.requestId,
              occurredAtUtc: options.clock.now(),
              durationMs: Math.max(0, performance.now() - startedAt),
              status: event.status,
              outcome: event.outcome,
            });
            await options.logger?.record(event);
          },
        };
        return createMcpHttpHandler({
          authenticator,
          requestIds: { nextRequestId: () => requestId },
          content: options.content,
          logger,
        })(request);
      }
    : createMcpHttpHandler({
        authenticator,
        requestIds: options.requestIds,
        content: options.content,
        ...(options.logger ? { logger: options.logger } : {}),
      });
  return Object.freeze({ handler, authenticator, tokenHasher, tokens });
}

/** Wires the concrete Origin + CSRF guard in front of one control executor. */
export function createLocalWebControlRequestSecurityBoundary<Result>(
  options: WebControlRequestSecurityOptions<Result>,
) {
  return new WebControlRequestSecurityBoundary(options);
}

export interface LocalPrivacySafeObservabilityBoundaryOptions {
  readonly clock: AccountDeletionDependencies["clock"];
  readonly cohort: "close_circle" | "external";
}

/** Local dashboard/pilot composition; no deployable telemetry backend is claimed. */
export function createLocalPrivacySafeObservabilityBoundary(
  options: LocalPrivacySafeObservabilityBoundaryOptions,
) {
  const sink = new InMemoryPrivacySafeObservabilitySink();
  const control = new ControlPrivacySafeObservability({
    sink,
    clock: options.clock,
    cohort: options.cohort,
  });
  const content = new ContentPrivacySafeObservability({
    sink,
    cohort: options.cohort,
  });
  const background = new BackgroundPrivacySafeObservability({
    sink,
    cohort: options.cohort,
  });
  return Object.freeze({
    adapter: OBSERVABILITY_ADAPTER,
    sink,
    control,
    content,
    background,
  });
}

export interface LocalAccountDeletionBoundaryOptions {
  readonly ids: AccountDeletionDependencies["ids"];
  readonly clock: AccountDeletionDependencies["clock"];
  readonly host: AccountDeletionDependencies["host"];
  readonly logger?: AccountDeletionDependencies["logger"];
}

/** Shared local adapters for the complete account-preview/cascade boundary. */
export function createLocalAccountDeletionBoundary(
  options: LocalAccountDeletionBoundaryOptions,
) {
  const metadata = new InMemoryRevisionMetadataStore();
  const tokens = new InMemoryMcpTokenStore();
  const objects = new InMemoryObjectStore();
  const index = new InMemoryExactRevisionSearchIndex();
  const audit = new InMemoryAuditSink();
  const deletion = new AccountDeletionService({
    accounts: metadata,
    tokens,
    objects,
    index,
    audit,
    exportArchives: objects,
    ids: options.ids,
    clock: options.clock,
    host: options.host,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return Object.freeze({ metadata, tokens, objects, index, audit, deletion });
}
