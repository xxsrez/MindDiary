import { AUDIT_ADAPTER } from "@mind-diary/adapter-audit-memory";
import { BACKGROUND_APPLICATION_BOUNDARY } from "@mind-diary/adapter-background";
import { MCP_APPLICATION_BOUNDARY } from "@mind-diary/adapter-mcp";
import { METADATA_ADAPTER } from "@mind-diary/adapter-metadata-memory";
import { OBJECT_ADAPTER } from "@mind-diary/adapter-object-memory";
import { SEARCH_ADAPTER } from "@mind-diary/adapter-search-memory";
import { SECURITY_ADAPTER } from "@mind-diary/adapter-security-webcrypto";
import { WEB_APPLICATION_BOUNDARY } from "@mind-diary/adapter-web";
import { BACKGROUND_HANDLERS } from "@mind-diary/application-background";
import {
  CONTENT_COMMANDS,
  CONTENT_QUERIES,
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
