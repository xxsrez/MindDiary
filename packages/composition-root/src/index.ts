import { AUDIT_ADAPTER } from "@mind-diary/adapter-audit-memory";
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
} from "@mind-diary/adapter-metadata-memory";
import { OBJECT_ADAPTER } from "@mind-diary/adapter-object-memory";
import { SEARCH_ADAPTER } from "@mind-diary/adapter-search-memory";
import {
  SECURITY_ADAPTER,
  createWebCryptoTokenHasher,
} from "@mind-diary/adapter-security-webcrypto";
import { WEB_APPLICATION_BOUNDARY } from "@mind-diary/adapter-web";
import { BACKGROUND_HANDLERS } from "@mind-diary/application-background";
import {
  CONTENT_COMMANDS,
  CONTENT_QUERIES,
  McpBearerAuthenticationService,
  type McpBearerAuthenticationDependencies,
} from "@mind-diary/application-content";
import {
  CONTROL_COMMANDS,
  CONTROL_QUERIES,
} from "@mind-diary/application-control";

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
  deployableServiceImplemented: false,
} as const;

export interface LocalMcpHttpBoundaryOptions {
  readonly verifierKey: Uint8Array;
  readonly clock: McpBearerAuthenticationDependencies["clock"];
  readonly requestIds: McpRequestIdGenerator;
  readonly content: McpContentApplication;
  readonly logger?: McpSafeLogger;
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
  const handler = createMcpHttpHandler({
    authenticator,
    requestIds: options.requestIds,
    content: options.content,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return Object.freeze({ handler, authenticator, tokenHasher, tokens });
}
