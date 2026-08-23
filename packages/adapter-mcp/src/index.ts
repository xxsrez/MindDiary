import {
  CONTENT_COMMANDS,
  CONTENT_QUERIES,
  MindBrowseFailure,
  MindDiscoveryFailure,
  MindHistoryFailure,
  MindSearchFailure,
  MindValidationFailure,
  BundleFileDownloadFailure,
  type McpBearerAuthenticationResult,
  type McpBearerAuthenticator,
} from "@mind-diary/application-content";

export * from "./native-file-input.js";

export const MCP_TARGET_PROTOCOL = "2026-07-28" as const;
export const MCP_ENDPOINT = "/api/mcp" as const;
export const MCP_LEGACY_CODEX_PROTOCOL = "2025-11-25" as const;
export const MCP_LEGACY_CODEX_ENDPOINT = "/api/mcp/2025-11-25" as const;
export const MCP_RETIRED_SITES_ENDPOINT = "/mcp" as const;
export const MCP_WWW_AUTHENTICATE = 'Bearer realm="mind-diary"' as const;
export const MCP_AUTHENTICATION_POLICY = Object.freeze({
  scheme: "Bearer",
  requiredOnEveryPost: true,
  cachesActorAcrossRequests: false,
});

export const MCP_APPLICATION_BOUNDARY = {
  queries: CONTENT_QUERIES,
  commands: CONTENT_COMMANDS,
  authentication: MCP_AUTHENTICATION_POLICY,
} as const;

export const MCP_CONTENT_TOOLS = [
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "get_mind_bindings",
  "browse_entries",
  "search",
  "fetch",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "list_bundle_files",
  "set_read_mind_binding",
  "set_write_mind_binding",
  "get_file_ingress_capabilities",
  "stage_bundle_file",
  "reconcile_file_stage",
  "get_bundle_file_download",
  "commit_changeset",
  "reconcile_changeset",
  "capture_knowledge",
  "start_export",
  "get_export_status",
] as const;

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const NON_EMPTY_STRING_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
});

const OPAQUE_ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

/** Producer and consumer budget for every server-issued browse/search/fetch locator. */
const LOCATOR_ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

const PAGE_LIMIT_SCHEMA = Object.freeze({
  type: "integer",
  minimum: 1,
  maximum: 100,
});

const MIND_SELECTOR_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 512,
  description:
    "Exactly one Mind: /me, an exact canonical handle, or a server-issued opaque mind_id.",
});

const HANDLE_SCHEMA = Object.freeze({
  type: "string",
  minLength: 3,
  maxLength: 63,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

const SHA256_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
});

const REVISION_SELECTOR_SCHEMA = Object.freeze({
  oneOf: Object.freeze([
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["kind"]),
      properties: Object.freeze({ kind: Object.freeze({ const: "head" }) }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["kind", "revision_id"]),
      properties: Object.freeze({
        kind: Object.freeze({ const: "revision" }),
        revision_id: NON_EMPTY_STRING_SCHEMA,
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["kind", "as_of"]),
      properties: Object.freeze({
        kind: Object.freeze({ const: "as_of" }),
        as_of: Object.freeze({ type: "string", format: "date-time" }),
      }),
    }),
  ]),
});

const APPLICATION_ERROR_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["code", "message", "retryable", "request_id"]),
  properties: Object.freeze({
    code: NON_EMPTY_STRING_SCHEMA,
    message: NON_EMPTY_STRING_SCHEMA,
    retryable: Object.freeze({ type: "boolean" }),
    request_id: NON_EMPTY_STRING_SCHEMA,
    details: Object.freeze({ type: "object" }),
  }),
});

function toolOutputSchema(data: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["ok"]),
    properties: Object.freeze({
      ok: Object.freeze({ type: "boolean" }),
      data,
      error: APPLICATION_ERROR_SCHEMA,
    }),
    oneOf: Object.freeze([
      Object.freeze({
        required: Object.freeze(["ok", "data"]),
        properties: Object.freeze({ ok: Object.freeze({ const: true }) }),
        not: Object.freeze({ required: Object.freeze(["error"]) }),
      }),
      Object.freeze({
        required: Object.freeze(["ok", "error"]),
        properties: Object.freeze({ ok: Object.freeze({ const: false }) }),
        not: Object.freeze({ required: Object.freeze(["data"]) }),
      }),
    ]),
  });
}

const REVISION_DESCRIPTOR_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "revision_id",
    "revision_number",
    "parent_revision_id",
    "committed_at",
    "committed_by",
    "summary",
    "manifest_hash",
    "is_head",
  ]),
  properties: Object.freeze({
    revision_id: OPAQUE_ID_SCHEMA,
    revision_number: Object.freeze({ type: "integer", minimum: 1 }),
    parent_revision_id: Object.freeze({
      type: Object.freeze(["string", "null"]),
    }),
    committed_at: Object.freeze({ type: "string", format: "date-time" }),
    committed_by: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["kind", "id"]),
      properties: Object.freeze({
        kind: Object.freeze({
          type: "string",
          enum: Object.freeze(["principal", "deleted-principal"]),
        }),
        id: OPAQUE_ID_SCHEMA,
        display_name: NON_EMPTY_STRING_SCHEMA,
      }),
    }),
    summary: Object.freeze({ type: "string" }),
    manifest_hash: SHA256_SCHEMA,
    is_head: Object.freeze({ type: "boolean" }),
  }),
});

const CONTENT_CAPABILITY_SCHEMA = Object.freeze({
  type: "string",
  enum: Object.freeze(["content:read", "content:write"]),
});

const MIND_DESCRIPTOR_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "mind_id",
    "route",
    "handle",
    "name",
    "is_personal",
    "visibility",
    "discovery",
    "access",
    "metadata_version",
    "head",
  ]),
  properties: Object.freeze({
    mind_id: OPAQUE_ID_SCHEMA,
    route: NON_EMPTY_STRING_SCHEMA,
    handle: Object.freeze({ type: Object.freeze(["string", "null"]) }),
    name: NON_EMPTY_STRING_SCHEMA,
    is_personal: Object.freeze({ type: "boolean" }),
    visibility: Object.freeze({
      type: "string",
      enum: Object.freeze(["private", "unlisted", "public"]),
    }),
    discovery: Object.freeze({
      type: "string",
      enum: Object.freeze([
        "personal",
        "membership",
        "public_catalog",
        "exact_handle",
      ]),
    }),
    access: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["kind", "role", "capabilities"]),
      properties: Object.freeze({
        kind: Object.freeze({
          type: "string",
          enum: Object.freeze(["membership", "visibility"]),
        }),
        role: Object.freeze({
          type: Object.freeze(["string", "null"]),
          enum: Object.freeze(["reader", "editor", "admin", "owner", null]),
        }),
        capabilities: Object.freeze({
          type: "array",
          uniqueItems: true,
          items: CONTENT_CAPABILITY_SCHEMA,
        }),
      }),
    }),
    metadata_version: Object.freeze({ type: "integer", minimum: 1 }),
    head: REVISION_DESCRIPTOR_SCHEMA,
  }),
});

const ENTRY_SUMMARY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "entry_id",
    "resource_uri",
    "path",
    "kind",
    "title",
    "description",
    "tags",
    "mime_type",
    "revision_id",
    "sha256",
    "size",
  ]),
  properties: Object.freeze({
    entry_id: LOCATOR_ID_SCHEMA,
    resource_uri: Object.freeze({ type: "string", format: "uri" }),
    path: NON_EMPTY_STRING_SCHEMA,
    kind: Object.freeze({
      type: "string",
      enum: Object.freeze(["concept", "index", "log"]),
    }),
    title: Object.freeze({ type: "string" }),
    description: Object.freeze({ type: Object.freeze(["string", "null"]) }),
    tags: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
    mime_type: Object.freeze({ const: "text/markdown; charset=utf-8" }),
    revision_id: OPAQUE_ID_SCHEMA,
    sha256: SHA256_SCHEMA,
    size: Object.freeze({ type: "integer", minimum: 0 }),
    okf_type: Object.freeze({ type: Object.freeze(["string", "null"]) }),
  }),
});

function strictInputSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
) {
  return Object.freeze({
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required: Object.freeze([...required]) }),
    properties: Object.freeze(properties),
  });
}

const LIST_MINDS_INPUT_SCHEMA = strictInputSchema({
  cursor: OPAQUE_ID_SCHEMA,
  limit: PAGE_LIMIT_SCHEMA,
});

const RESOLVE_MIND_INPUT_SCHEMA = strictInputSchema(
  { handle: HANDLE_SCHEMA },
  ["handle"],
);

const GET_MIND_INFO_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    revision_selector: REVISION_SELECTOR_SCHEMA,
  },
  ["mind"],
);

const BROWSE_ENTRIES_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    revision_selector: REVISION_SELECTOR_SCHEMA,
    path: Object.freeze({ type: "string", maxLength: 1_024 }),
    cursor: OPAQUE_ID_SCHEMA,
    limit: PAGE_LIMIT_SCHEMA,
  },
  ["mind"],
);

const LIST_BUNDLE_FILES_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    revision_selector: REVISION_SELECTOR_SCHEMA,
    cursor: OPAQUE_ID_SCHEMA,
    limit: PAGE_LIMIT_SCHEMA,
  },
  ["mind"],
);

const GET_BUNDLE_FILE_DOWNLOAD_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    revision_selector: REVISION_SELECTOR_SCHEMA,
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 1_024 }),
  },
  ["mind", "path"],
);

const SEARCH_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    revision_selector: REVISION_SELECTOR_SCHEMA,
    query: Object.freeze({ type: "string", minLength: 1, maxLength: 1_024 }),
    cursor: OPAQUE_ID_SCHEMA,
    limit: PAGE_LIMIT_SCHEMA,
  },
  ["mind", "query"],
);

const FETCH_INPUT_SCHEMA = strictInputSchema({ id: LOCATOR_ID_SCHEMA }, ["id"]);

const LIST_REVISIONS_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    before: OPAQUE_ID_SCHEMA,
    limit: PAGE_LIMIT_SCHEMA,
  },
  ["mind"],
);

const GET_REVISION_INPUT_SCHEMA = strictInputSchema(
  { mind: MIND_SELECTOR_SCHEMA, revision_id: OPAQUE_ID_SCHEMA },
  ["mind", "revision_id"],
);

const VALIDATE_MIND_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    revision_selector: REVISION_SELECTOR_SCHEMA,
  },
  ["mind"],
);

const GET_MIND_BINDINGS_INPUT_SCHEMA = strictInputSchema({});

const BINDING_VERSION_SCHEMA = Object.freeze({
  type: "integer",
  minimum: 0,
});

const IDEMPOTENCY_KEY_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
});

const SET_READ_MIND_BINDING_INPUT_SCHEMA = strictInputSchema(
  {
    action: Object.freeze({
      type: "string",
      enum: Object.freeze(["attach", "detach"]),
    }),
    mind: MIND_SELECTOR_SCHEMA,
    expected_binding_version: BINDING_VERSION_SCHEMA,
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
  },
  ["action", "mind", "expected_binding_version", "idempotency_key"],
);

const SET_WRITE_MIND_BINDING_INPUT_SCHEMA = Object.freeze({
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "action",
    "expected_binding_version",
    "idempotency_key",
  ]),
  properties: Object.freeze({
    action: Object.freeze({
      type: "string",
      enum: Object.freeze(["bind", "unbind"]),
    }),
    mind: MIND_SELECTOR_SCHEMA,
    expected_binding_version: BINDING_VERSION_SCHEMA,
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
  }),
  oneOf: Object.freeze([
    Object.freeze({
      required: Object.freeze(["mind"]),
      properties: Object.freeze({
        action: Object.freeze({ const: "bind" }),
      }),
    }),
    Object.freeze({
      properties: Object.freeze({
        action: Object.freeze({ const: "unbind" }),
      }),
      not: Object.freeze({ required: Object.freeze(["mind"]) }),
    }),
  ]),
});

const LIST_MINDS_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["minds", "next_cursor"]),
    properties: Object.freeze({
      minds: Object.freeze({ type: "array", items: MIND_DESCRIPTOR_SCHEMA }),
      next_cursor: Object.freeze({ type: Object.freeze(["string", "null"]) }),
    }),
  }),
);

const RESOLVE_MIND_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["mind"]),
    properties: Object.freeze({ mind: MIND_DESCRIPTOR_SCHEMA }),
  }),
);

const GET_MIND_INFO_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "mind",
      "resolved_revision",
      "revision_mode",
      "content_capabilities",
      "index_status",
    ]),
    properties: Object.freeze({
      mind: MIND_DESCRIPTOR_SCHEMA,
      resolved_revision: REVISION_DESCRIPTOR_SCHEMA,
      revision_mode: Object.freeze({
        type: "string",
        enum: Object.freeze(["head", "historical"]),
      }),
      content_capabilities: Object.freeze({
        type: "array",
        uniqueItems: true,
        items: Object.freeze({
          type: "string",
          enum: Object.freeze([
            "browse",
            "search",
            "fetch",
            "history",
            "validate",
            "export",
            "commit",
          ]),
        }),
      }),
      index_status: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze([
          "status",
          "retryable",
          "retry_after_ms",
          "failure_code",
        ]),
        properties: Object.freeze({
          status: Object.freeze({
            type: "string",
            enum: Object.freeze(["missing", "queued", "ready", "failed"]),
          }),
          retryable: Object.freeze({ type: "boolean" }),
          retry_after_ms: Object.freeze({
            type: Object.freeze(["integer", "null"]),
            minimum: 0,
          }),
          failure_code: Object.freeze({
            type: Object.freeze(["string", "null"]),
          }),
        }),
      }),
    }),
  }),
);

const BROWSE_ENTRIES_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "mind",
      "resolved_revision",
      "path",
      "entries",
      "next_cursor",
    ]),
    properties: Object.freeze({
      mind: MIND_DESCRIPTOR_SCHEMA,
      resolved_revision: REVISION_DESCRIPTOR_SCHEMA,
      path: Object.freeze({ type: "string" }),
      entries: Object.freeze({ type: "array", items: ENTRY_SUMMARY_SCHEMA }),
      next_cursor: Object.freeze({ type: Object.freeze(["string", "null"]) }),
    }),
  }),
);

const BUNDLE_FILE_DESCRIPTOR_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "path", "kind", "media_type", "size", "sha256", "revision_id", "inline_eligible",
  ]),
  properties: Object.freeze({
    path: Object.freeze({ type: "string", minLength: 1 }),
    kind: Object.freeze({ const: "opaque" }),
    media_type: Object.freeze({
      type: "string",
      enum: Object.freeze([
        "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/zip",
      ]),
    }),
    size: Object.freeze({ type: "integer", minimum: 0 }),
    sha256: SHA256_SCHEMA,
    revision_id: OPAQUE_ID_SCHEMA,
    inline_eligible: Object.freeze({ type: "boolean" }),
    reference_status: Object.freeze({
      type: "string",
      enum: Object.freeze(["referenced", "unreferenced", "invalid_reference"]),
    }),
  }),
});

const BUNDLE_REFERENCE_DIAGNOSTIC_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["severity", "class", "code", "path", "message"]),
  properties: Object.freeze({
    severity: Object.freeze({ type: "string", enum: Object.freeze(["error", "warning"]) }),
    class: Object.freeze({ type: "string", enum: Object.freeze(["conformance", "quality"]) }),
    code: NON_EMPTY_STRING_SCHEMA,
    path: Object.freeze({ type: "string" }),
    line: Object.freeze({ type: "integer", minimum: 1 }),
    message: NON_EMPTY_STRING_SCHEMA,
  }),
});

const LIST_BUNDLE_FILES_OUTPUT_SCHEMA = toolOutputSchema(Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["mind", "resolved_revision", "files", "diagnostics", "next_cursor"]),
  properties: Object.freeze({
    mind: MIND_DESCRIPTOR_SCHEMA,
    resolved_revision: REVISION_DESCRIPTOR_SCHEMA,
    files: Object.freeze({ type: "array", items: BUNDLE_FILE_DESCRIPTOR_SCHEMA }),
    diagnostics: Object.freeze({ type: "array", items: BUNDLE_REFERENCE_DIAGNOSTIC_SCHEMA }),
    next_cursor: Object.freeze({ type: Object.freeze(["string", "null"]) }),
  }),
}));

const GET_BUNDLE_FILE_DOWNLOAD_OUTPUT_SCHEMA = toolOutputSchema(Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "mind", "resolved_revision", "file", "download_url", "download_expires_at", "disposition",
  ]),
  properties: Object.freeze({
    mind: MIND_DESCRIPTOR_SCHEMA,
    resolved_revision: REVISION_DESCRIPTOR_SCHEMA,
    file: BUNDLE_FILE_DESCRIPTOR_SCHEMA,
    download_url: Object.freeze({ type: "string", format: "uri" }),
    download_expires_at: Object.freeze({ type: "string", format: "date-time" }),
    disposition: Object.freeze({ type: "string", enum: Object.freeze(["inline", "attachment"]) }),
  }),
}));

const SEARCH_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "mind",
      "resolved_revision",
      "results",
      "next_cursor",
      "index_status",
    ]),
    properties: Object.freeze({
      mind: MIND_DESCRIPTOR_SCHEMA,
      resolved_revision: REVISION_DESCRIPTOR_SCHEMA,
      results: Object.freeze({
        type: "array",
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze(["entry", "score", "snippet", "matched_fields"]),
          properties: Object.freeze({
            entry: ENTRY_SUMMARY_SCHEMA,
            score: Object.freeze({ type: "number" }),
            snippet: Object.freeze({ type: "string" }),
            matched_fields: Object.freeze({
              type: "array",
              uniqueItems: true,
              items: Object.freeze({
                type: "string",
                enum: Object.freeze([
                  "title",
                  "description",
                  "tags",
                  "headings",
                  "body",
                ]),
              }),
            }),
          }),
        }),
      }),
      next_cursor: Object.freeze({ type: Object.freeze(["string", "null"]) }),
      index_status: Object.freeze({ const: "ready" }),
    }),
  }),
);

const FETCH_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["fetched"]),
    properties: Object.freeze({
      fetched: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze([
          "entry",
          "text",
          "truncated",
          "continuation_id",
        ]),
        properties: Object.freeze({
          entry: ENTRY_SUMMARY_SCHEMA,
          text: Object.freeze({ type: "string" }),
          truncated: Object.freeze({ type: "boolean" }),
          continuation_id: Object.freeze({
            type: Object.freeze(["string", "null"]),
            maxLength: 512,
          }),
        }),
      }),
    }),
  }),
);

const REVISION_MANIFEST_SUMMARY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["file_count", "total_bytes"]),
  properties: Object.freeze({
    file_count: Object.freeze({ type: "integer", minimum: 0 }),
    total_bytes: Object.freeze({ type: "integer", minimum: 0 }),
  }),
});

const LIST_REVISIONS_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["mind", "revisions", "next_before"]),
    properties: Object.freeze({
      mind: MIND_DESCRIPTOR_SCHEMA,
      revisions: Object.freeze({
        type: "array",
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze(["revision", "manifest_summary"]),
          properties: Object.freeze({
            revision: REVISION_DESCRIPTOR_SCHEMA,
            manifest_summary: REVISION_MANIFEST_SUMMARY_SCHEMA,
          }),
        }),
      }),
      next_before: Object.freeze({ type: Object.freeze(["string", "null"]) }),
    }),
  }),
);

const GET_REVISION_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["mind", "revision", "manifest_summary"]),
    properties: Object.freeze({
      mind: MIND_DESCRIPTOR_SCHEMA,
      revision: REVISION_DESCRIPTOR_SCHEMA,
      manifest_summary: REVISION_MANIFEST_SUMMARY_SCHEMA,
    }),
  }),
);

const VALIDATION_ISSUE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["severity", "class", "code", "path", "message"]),
  properties: Object.freeze({
    severity: Object.freeze({
      type: "string",
      enum: Object.freeze(["error", "warning"]),
    }),
    class: Object.freeze({
      type: "string",
      enum: Object.freeze(["conformance", "quality"]),
    }),
    code: NON_EMPTY_STRING_SCHEMA,
    path: Object.freeze({ type: "string" }),
    line: Object.freeze({ type: "integer", minimum: 1 }),
    field: NON_EMPTY_STRING_SCHEMA,
    message: NON_EMPTY_STRING_SCHEMA,
  }),
});

const VALIDATE_MIND_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "mind",
      "resolved_revision",
      "valid",
      "conformance_errors",
      "quality_warnings",
      "validated_okf_version",
    ]),
    properties: Object.freeze({
      mind: MIND_DESCRIPTOR_SCHEMA,
      resolved_revision: REVISION_DESCRIPTOR_SCHEMA,
      valid: Object.freeze({ type: "boolean" }),
      conformance_errors: Object.freeze({
        type: "array",
        items: VALIDATION_ISSUE_SCHEMA,
      }),
      quality_warnings: Object.freeze({
        type: "array",
        items: VALIDATION_ISSUE_SCHEMA,
      }),
      validated_okf_version: Object.freeze({ const: "0.2" }),
    }),
  }),
);

const BINDING_CONTENT_CAPABILITY_SCHEMA = Object.freeze({
  type: "string",
  enum: Object.freeze([
    "browse",
    "search",
    "fetch",
    "history",
    "validate",
    "export",
    "commit",
  ]),
});

const READ_BINDING_PROJECTION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "read_binding_id",
    "mind_id",
    "availability",
    "mind",
    "content_capabilities",
  ]),
  properties: Object.freeze({
    read_binding_id: OPAQUE_ID_SCHEMA,
    mind_id: OPAQUE_ID_SCHEMA,
    availability: Object.freeze({
      type: "string",
      enum: Object.freeze(["available", "unavailable"]),
    }),
    mind: Object.freeze({
      oneOf: Object.freeze([MIND_DESCRIPTOR_SCHEMA, Object.freeze({ type: "null" })]),
    }),
    content_capabilities: Object.freeze({
      type: "array",
      uniqueItems: true,
      items: BINDING_CONTENT_CAPABILITY_SCHEMA,
    }),
  }),
});

const WRITE_BINDING_PROJECTION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "write_binding_id",
    "mind_id",
    "generation",
    "state",
    "availability",
    "mind",
    "content_capabilities",
  ]),
  properties: Object.freeze({
    write_binding_id: OPAQUE_ID_SCHEMA,
    mind_id: OPAQUE_ID_SCHEMA,
    generation: BINDING_VERSION_SCHEMA,
    state: Object.freeze({
      type: "string",
      enum: Object.freeze(["active", "invalidated"]),
    }),
    availability: Object.freeze({
      type: "string",
      enum: Object.freeze(["available", "unavailable"]),
    }),
    mind: Object.freeze({
      oneOf: Object.freeze([MIND_DESCRIPTOR_SCHEMA, Object.freeze({ type: "null" })]),
    }),
    content_capabilities: Object.freeze({
      type: "array",
      uniqueItems: true,
      items: BINDING_CONTENT_CAPABILITY_SCHEMA,
    }),
  }),
});

const MIND_BINDINGS_STATE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "binding_version",
    "read_bindings",
    "write_binding",
    "automatic_capture",
  ]),
  properties: Object.freeze({
    binding_version: BINDING_VERSION_SCHEMA,
    read_bindings: Object.freeze({
      type: "array",
      uniqueItems: true,
      items: READ_BINDING_PROJECTION_SCHEMA,
    }),
    write_binding: Object.freeze({
      oneOf: Object.freeze([
        WRITE_BINDING_PROJECTION_SCHEMA,
        Object.freeze({ type: "null" }),
      ]),
    }),
    automatic_capture: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["mode", "write_binding_id", "updated_at"]),
      properties: Object.freeze({
        mode: Object.freeze({
          type: "string",
          enum: Object.freeze(["disabled", "routine_non_sensitive"]),
        }),
        write_binding_id: Object.freeze({ type: Object.freeze(["string", "null"]) }),
        updated_at: Object.freeze({ type: Object.freeze(["string", "null"]) }),
      }),
    }),
  }),
});

const GET_MIND_BINDINGS_OUTPUT_SCHEMA = toolOutputSchema(
  MIND_BINDINGS_STATE_SCHEMA,
);

const SET_READ_MIND_BINDING_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["changed", "replayed", "bindings"]),
    properties: Object.freeze({
      changed: Object.freeze({ type: "boolean" }),
      replayed: Object.freeze({ type: "boolean" }),
      bindings: MIND_BINDINGS_STATE_SCHEMA,
    }),
  }),
);

const SET_WRITE_MIND_BINDING_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "binding_version",
      "changed",
      "replayed",
      "previous",
      "current",
    ]),
    properties: Object.freeze({
      binding_version: BINDING_VERSION_SCHEMA,
      changed: Object.freeze({ type: "boolean" }),
      replayed: Object.freeze({ type: "boolean" }),
      previous: Object.freeze({
        oneOf: Object.freeze([
          WRITE_BINDING_PROJECTION_SCHEMA,
          Object.freeze({ type: "null" }),
        ]),
      }),
      current: Object.freeze({
        oneOf: Object.freeze([
          WRITE_BINDING_PROJECTION_SCHEMA,
          Object.freeze({ type: "null" }),
        ]),
      }),
    }),
  }),
);

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

const READ_SECURITY_SCHEMES = Object.freeze([
  Object.freeze({ type: "oauth2" as const, scopes: Object.freeze(["content:read"]) }),
]);
const WRITE_SECURITY_SCHEMES = Object.freeze([
  Object.freeze({ type: "oauth2" as const, scopes: Object.freeze(["content:write"]) }),
]);

/** Canonical deterministic definitions for read-only Mind content tools. */
export const MCP_READ_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "list_minds",
    title: "List accessible Minds",
    description:
      "List the authenticated principal's Personal Mind, accepted memberships, and public catalog entries without enumerating private or unlisted Minds.",
    inputSchema: LIST_MINDS_INPUT_SCHEMA,
    outputSchema: LIST_MINDS_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "resolve_mind",
    title: "Resolve an exact Mind handle",
    description:
      "Resolve one exact canonical handle to an authorized Mind descriptor; missing and private Minds remain indistinguishable.",
    inputSchema: RESOLVE_MIND_INPUT_SCHEMA,
    outputSchema: RESOLVE_MIND_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "get_mind_info",
    title: "Get exact Mind revision info",
    description:
      "Resolve one explicit Mind and HEAD, exact revision, or as-of selector to a single immutable revision and its current content capabilities.",
    inputSchema: GET_MIND_INFO_INPUT_SCHEMA,
    outputSchema: GET_MIND_INFO_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "get_mind_bindings",
    title: "Get current Mind bindings",
    description:
      "Inspect the authenticated token or OAuth grant's active read bindings and singleton write binding. Inaccessible targets are redacted as unavailable and discovery is not changed.",
    inputSchema: GET_MIND_BINDINGS_INPUT_SCHEMA,
    outputSchema: GET_MIND_BINDINGS_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "browse_entries",
    title: "Browse one Mind revision",
    description:
      "Browse manifest and frontmatter summaries inside one explicit Mind and one resolved revision without loading every entry body.",
    inputSchema: BROWSE_ENTRIES_INPUT_SCHEMA,
    outputSchema: BROWSE_ENTRIES_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "search",
    title: "Search one Mind revision",
    description:
      "Run lexical search only inside one explicit Mind and one resolved revision; this tool never performs implicit cross-Mind search or HEAD fallback.",
    inputSchema: SEARCH_INPUT_SCHEMA,
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "fetch",
    title: "Fetch an exact entry",
    description:
      "Fetch Markdown through a server-issued opaque entry or continuation ID fixed to one Mind, immutable revision, path, and byte range.",
    inputSchema: FETCH_INPUT_SCHEMA,
    outputSchema: FETCH_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "list_revisions",
    title: "List Mind revisions",
    description:
      "List immutable revisions for one explicit Mind in descending revision order after checking current access. Use an exact result for inspection or restore preview; this never makes history writable.",
    inputSchema: LIST_REVISIONS_INPUT_SCHEMA,
    outputSchema: LIST_REVISIONS_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "get_revision",
    title: "Get an exact Mind revision",
    description:
      "Read one exact immutable revision and safe manifest summary for one explicit Mind. Historical reads remain read-only; restoring selected content requires a separately previewed and confirmed commit_changeset against a fresh current HEAD.",
    inputSchema: GET_REVISION_INPUT_SCHEMA,
    outputSchema: GET_REVISION_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "validate_mind",
    title: "Validate one Mind revision",
    description:
      "Validate the complete OKF bundle for one explicit Mind and resolved revision, separating conformance errors from quality warnings.",
    inputSchema: VALIDATE_MIND_INPUT_SCHEMA,
    outputSchema: VALIDATE_MIND_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
  Object.freeze({
    name: "list_bundle_files",
    title: "List exact-revision BundleFiles",
    description:
      "List bounded metadata and Markdown reference status for opaque files in one authorized exact revision. Bytes, provider IDs and download URLs are never returned.",
    inputSchema: LIST_BUNDLE_FILES_INPUT_SCHEMA,
    outputSchema: LIST_BUNDLE_FILES_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: READ_ONLY_ANNOTATIONS,
  }),
] as const);

/** Service-metadata binding mutations; neither tool writes Mind content. */
export const MCP_BINDING_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "set_read_mind_binding",
    title: "Attach or detach one readable Mind",
    description:
      "Attach one currently readable exact Mind or detach one current binding using expected_binding_version and idempotency_key. Detach by the returned mind_id remains possible after access loss and never reveals target metadata.",
    inputSchema: SET_READ_MIND_BINDING_INPUT_SCHEMA,
    outputSchema: SET_READ_MIND_BINDING_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "set_write_mind_binding",
    title: "Bind or unbind the writable Mind",
    description:
      "Atomically bind or rebind one exact Mind with current content:write authority, or unbind the current target. The response names the invalidated previous generation and the only active current generation.",
    inputSchema: SET_WRITE_MIND_BINDING_INPUT_SCHEMA,
    outputSchema: SET_WRITE_MIND_BINDING_OUTPUT_SCHEMA,
    securitySchemes: WRITE_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    }),
  }),
] as const);

const EXPORT_JOB_STATE_SCHEMA = Object.freeze({
  type: "string",
  enum: Object.freeze(["queued", "running", "succeeded", "failed", "expired"]),
});

const EXPORT_JOB_STATUS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["job_id", "status", "revision_id"]),
  properties: Object.freeze({
    job_id: NON_EMPTY_STRING_SCHEMA,
    status: EXPORT_JOB_STATE_SCHEMA,
    revision_id: NON_EMPTY_STRING_SCHEMA,
    created_at: Object.freeze({ type: "string", format: "date-time" }),
    updated_at: Object.freeze({ type: "string", format: "date-time" }),
    completed_at: Object.freeze({
      type: Object.freeze(["string", "null"]),
      format: "date-time",
    }),
    expires_at: Object.freeze({ type: "string", format: "date-time" }),
    last_failure_code: Object.freeze({ type: Object.freeze(["string", "null"]) }),
    archive_format: Object.freeze({
      type: "string",
      enum: Object.freeze(["MD-OKF-ZIP-1", "MD-BUNDLE-ZIP-1"]),
    }),
    media_type: Object.freeze({ const: "application/zip" }),
    filename: Object.freeze({
      type: "string",
      enum: Object.freeze(["mind-diary-okf-bundle.zip", "mind-diary-bundle.zip"]),
    }),
    content_disposition: Object.freeze({
      type: "string",
      enum: Object.freeze([
        'attachment; filename="mind-diary-okf-bundle.zip"',
        'attachment; filename="mind-diary-bundle.zip"',
      ]),
    }),
    sha256: SHA256_SCHEMA,
    size: Object.freeze({ type: "integer", minimum: 0 }),
    download_url: Object.freeze({ type: "string", format: "uri" }),
    download_expires_at: Object.freeze({ type: "string", format: "date-time" }),
  }),
});

const NATIVE_FILE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["file_id", "download_url"]),
  properties: Object.freeze({
    file_id: Object.freeze({ type: "string", minLength: 1, maxLength: 1_024 }),
    download_url: Object.freeze({ type: "string", format: "uri", maxLength: 8_192 }),
    file_name: Object.freeze({ type: "string", minLength: 1, maxLength: 1_024 }),
    mime_type: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }),
  }),
});

const FILE_INGRESS_SOURCE_KIND_SCHEMA = Object.freeze({
  type: "string",
  enum: Object.freeze([
    "session_attachment",
    "local_path",
    "workspace/generated_artifact",
    "connector_object",
    "bounded_in_memory",
    "server_generated",
  ]),
});

const FILE_INGRESS_MEDIA_TYPE_SCHEMA = Object.freeze({
  type: "string",
  enum: Object.freeze([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/zip",
  ]),
});

const GET_FILE_INGRESS_CAPABILITIES_INPUT_SCHEMA = strictInputSchema({});

const GET_FILE_INGRESS_CAPABILITIES_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["sources"]),
    properties: Object.freeze({
      sources: Object.freeze({
        type: "array",
        minItems: 6,
        maxItems: 6,
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze([
            "source_kind",
            "status",
            "transport",
            "max_bytes",
            "fallback",
          ]),
          properties: Object.freeze({
            source_kind: FILE_INGRESS_SOURCE_KIND_SCHEMA,
            status: Object.freeze({
              type: "string",
              enum: Object.freeze([
                "available_local",
                "available_hosted",
                "not_available",
              ]),
            }),
            transport: Object.freeze({
              type: "string",
              enum: Object.freeze([
                "native_file_parameter",
                "authorized_connector",
                "local_companion",
                "bounded_bytes",
                "producer_stream",
              ]),
            }),
            max_bytes: Object.freeze({ type: "integer", minimum: 0 }),
            fallback: Object.freeze({ const: "none" }),
          }),
        }),
      }),
    }),
  }),
);

const STAGE_BUNDLE_FILE_INPUT_SCHEMA = Object.freeze({
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["mind", "write_binding_id", "file", "idempotency_key"]),
  properties: Object.freeze({
    mind: MIND_SELECTOR_SCHEMA,
    write_binding_id: OPAQUE_ID_SCHEMA,
    file: NATIVE_FILE_INPUT_SCHEMA,
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
    display_filename: Object.freeze({ type: "string", minLength: 1, maxLength: 255 }),
    expected_size: Object.freeze({
      type: "integer",
      minimum: 0,
      maximum: 67_108_864,
    }),
    expected_sha256: SHA256_SCHEMA,
  }),
});

const STAGED_FILE_DESCRIPTOR_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "staged_file_ref",
    "state",
    "display_filename",
    "media_type",
    "sha256",
    "size",
    "expires_at",
    "replayed",
  ]),
  properties: Object.freeze({
    staged_file_ref: OPAQUE_ID_SCHEMA,
    state: Object.freeze({ const: "verified" }),
    display_filename: Object.freeze({ type: "string", minLength: 1 }),
    media_type: FILE_INGRESS_MEDIA_TYPE_SCHEMA,
    sha256: SHA256_SCHEMA,
    size: Object.freeze({ type: "integer", minimum: 0 }),
    expires_at: Object.freeze({ type: "string", format: "date-time" }),
    replayed: Object.freeze({ type: "boolean" }),
  }),
});

const STAGE_BUNDLE_FILE_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["staged_file"]),
    properties: Object.freeze({
      staged_file: STAGED_FILE_DESCRIPTOR_SCHEMA,
    }),
  }),
);

const RECONCILE_FILE_STAGE_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    write_binding_id: OPAQUE_ID_SCHEMA,
    source_kind: FILE_INGRESS_SOURCE_KIND_SCHEMA,
    display_filename: Object.freeze({ type: "string", minLength: 1, maxLength: 255 }),
    claimed_media_type: FILE_INGRESS_MEDIA_TYPE_SCHEMA,
    media_type: FILE_INGRESS_MEDIA_TYPE_SCHEMA,
    sha256: SHA256_SCHEMA,
    size: Object.freeze({ type: "integer", minimum: 0, maximum: 67_108_864 }),
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
    expected_size: Object.freeze({
      type: "integer",
      minimum: 0,
      maximum: 67_108_864,
    }),
    expected_sha256: SHA256_SCHEMA,
  },
  [
    "mind",
    "write_binding_id",
    "source_kind",
    "display_filename",
    "media_type",
    "sha256",
    "size",
    "idempotency_key",
  ],
);

const RECONCILE_FILE_STAGE_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    oneOf: Object.freeze([
      Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze(["status"]),
        properties: Object.freeze({ status: Object.freeze({ const: "missing" }) }),
      }),
      Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze(["status", "staged_file"]),
        properties: Object.freeze({
          status: Object.freeze({ const: "staged" }),
          staged_file: STAGED_FILE_DESCRIPTOR_SCHEMA,
        }),
      }),
    ]),
  }),
);

const CHANGESET_OPERATION_SCHEMA = Object.freeze({
  oneOf: Object.freeze([
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path", "text"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "create_file" }),
        path: NON_EMPTY_STRING_SCHEMA,
        text: Object.freeze({ type: "string" }),
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path", "text"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "replace_file" }),
        path: NON_EMPTY_STRING_SCHEMA,
        text: Object.freeze({ type: "string" }),
        expected_sha256: SHA256_SCHEMA,
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "delete_file" }),
        path: NON_EMPTY_STRING_SCHEMA,
        expected_sha256: SHA256_SCHEMA,
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path", "text"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "replace_index" }),
        path: Object.freeze({ type: "string", pattern: "(?:^|/)index\\.md$" }),
        text: Object.freeze({ type: "string" }),
        expected_sha256: SHA256_SCHEMA,
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path", "category", "message"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "add_log_entry" }),
        path: Object.freeze({ type: "string", pattern: "(?:^|/)log\\.md$" }),
        category: NON_EMPTY_STRING_SCHEMA,
        message: NON_EMPTY_STRING_SCHEMA,
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path", "staged_file_ref"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "create_bundle_file" }),
        path: NON_EMPTY_STRING_SCHEMA,
        staged_file_ref: OPAQUE_ID_SCHEMA,
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path", "staged_file_ref"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "replace_bundle_file" }),
        path: NON_EMPTY_STRING_SCHEMA,
        staged_file_ref: OPAQUE_ID_SCHEMA,
        expected_sha256: SHA256_SCHEMA,
      }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["type", "path"]),
      properties: Object.freeze({
        type: Object.freeze({ const: "delete_bundle_file" }),
        path: NON_EMPTY_STRING_SCHEMA,
        expected_sha256: SHA256_SCHEMA,
      }),
    }),
  ]),
});

const COMMIT_CHANGESET_INPUT_SCHEMA = Object.freeze({
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "mind",
    "write_binding_id",
    "expected_revision",
    "idempotency_key",
    "summary",
    "operations",
  ]),
  properties: Object.freeze({
    mind: NON_EMPTY_STRING_SCHEMA,
    write_binding_id: OPAQUE_ID_SCHEMA,
    expected_revision: NON_EMPTY_STRING_SCHEMA,
    idempotency_key: NON_EMPTY_STRING_SCHEMA,
    summary: Object.freeze({ type: "string" }),
    operations: Object.freeze({
      type: "array",
      minItems: 1,
      items: CHANGESET_OPERATION_SCHEMA,
    }),
  }),
});

const COMMIT_CHANGESET_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "mind",
      "previous_revision_id",
      "revision",
      "index_status",
    ]),
    properties: Object.freeze({
      mind: Object.freeze({ type: "object" }),
      previous_revision_id: Object.freeze({ type: Object.freeze(["string", "null"]) }),
      revision: REVISION_DESCRIPTOR_SCHEMA,
      index_status: Object.freeze({ const: "queued" }),
    }),
  }),
);

const RECONCILE_CHANGESET_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    oneOf: Object.freeze([
      Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze(["status"]),
        properties: Object.freeze({ status: Object.freeze({ const: "missing" }) }),
      }),
      Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze([
          "status",
          "mind",
          "previous_revision_id",
          "revision",
        ]),
        properties: Object.freeze({
          status: Object.freeze({ const: "committed" }),
          mind: Object.freeze({ type: "object" }),
          previous_revision_id: Object.freeze({ type: Object.freeze(["string", "null"]) }),
          revision: REVISION_DESCRIPTOR_SCHEMA,
        }),
      }),
    ]),
  }),
);

const AUTOMATIC_CAPTURE_SOURCE_SCHEMA = Object.freeze({
  oneOf: Object.freeze([
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["kind"]),
      properties: Object.freeze({ kind: Object.freeze({ const: "user_statement" }) }),
    }),
    Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["kind", "revision_id", "path"]),
      properties: Object.freeze({
        kind: Object.freeze({ const: "target_entry" }),
        revision_id: OPAQUE_ID_SCHEMA,
        path: Object.freeze({ type: "string", minLength: 1, maxLength: 512 }),
      }),
    }),
  ]),
});

const CAPTURE_KNOWLEDGE_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    write_binding_id: OPAQUE_ID_SCHEMA,
    expected_binding_version: BINDING_VERSION_SCHEMA,
    expected_revision: OPAQUE_ID_SCHEMA,
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
    classification: Object.freeze({ const: "routine_non_sensitive" }),
    capture_kind: Object.freeze({
      type: "string",
      enum: Object.freeze(["fact", "decision", "source_note"]),
    }),
    capture_key: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
    }),
    title: Object.freeze({ type: "string", minLength: 1, maxLength: 160 }),
    description: Object.freeze({ type: "string", minLength: 1, maxLength: 320 }),
    body: Object.freeze({ type: "string", minLength: 1, maxLength: 8_192 }),
    sources: Object.freeze({
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: AUTOMATIC_CAPTURE_SOURCE_SCHEMA,
    }),
  },
  [
    "mind",
    "write_binding_id",
    "expected_binding_version",
    "expected_revision",
    "idempotency_key",
    "classification",
    "capture_kind",
    "capture_key",
    "title",
    "description",
    "body",
    "sources",
  ],
);

const CAPTURE_KNOWLEDGE_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "status",
      "mind",
      "path",
      "previous_revision_id",
      "revision",
      "index_status",
      "replayed",
    ]),
    properties: Object.freeze({
      status: Object.freeze({
        type: "string",
        enum: Object.freeze(["captured", "no_op"]),
      }),
      mind: Object.freeze({ type: "object" }),
      path: Object.freeze({ type: "string", minLength: 1 }),
      previous_revision_id: Object.freeze({ type: Object.freeze(["string", "null"]) }),
      revision: REVISION_DESCRIPTOR_SCHEMA,
      index_status: Object.freeze({
        type: "string",
        enum: Object.freeze(["queued", "unchanged"]),
      }),
      replayed: Object.freeze({ type: "boolean" }),
    }),
  }),
);

const START_EXPORT_INPUT_SCHEMA = Object.freeze({
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["mind", "idempotency_key"]),
  properties: Object.freeze({
    mind: NON_EMPTY_STRING_SCHEMA,
    revision_selector: REVISION_SELECTOR_SCHEMA,
    profile: Object.freeze({
      type: "string",
      enum: Object.freeze(["MD-OKF-ZIP-1", "MD-BUNDLE-ZIP-1"]),
    }),
    idempotency_key: NON_EMPTY_STRING_SCHEMA,
  }),
});

const START_EXPORT_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["job"]),
    properties: Object.freeze({
      job: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze(["job_id", "status", "revision_id", "created_at"]),
        properties: Object.freeze({
          job_id: NON_EMPTY_STRING_SCHEMA,
          status: Object.freeze({ const: "queued" }),
          revision_id: NON_EMPTY_STRING_SCHEMA,
          created_at: Object.freeze({ type: "string", format: "date-time" }),
        }),
      }),
    }),
  }),
);

const GET_EXPORT_STATUS_INPUT_SCHEMA = Object.freeze({
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["job_id"]),
  properties: Object.freeze({ job_id: NON_EMPTY_STRING_SCHEMA }),
});

const GET_EXPORT_STATUS_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["job"]),
    properties: Object.freeze({ job: EXPORT_JOB_STATUS_SCHEMA }),
  }),
);

/** Native-file staging is provider-specific at the MCP edge and portable below it. */
export const MCP_BUNDLE_FILE_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "get_file_ingress_capabilities",
    title: "Get file ingress capabilities",
    description:
      "Read the exact deployed source capability matrix. An unavailable source has no implicit base64, URL, local-path or cross-source fallback.",
    inputSchema: GET_FILE_INGRESS_CAPABILITIES_INPUT_SCHEMA,
    outputSchema: GET_FILE_INGRESS_CAPABILITIES_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "stage_bundle_file",
    title: "Stage one BundleFile",
    description:
      "Download exactly one client-native file through the provider transport, verify its bounded bytes and metadata, and create one expiring staged_file_ref pinned to the exact active writable Mind binding. The provider file ID, temporary URL and bytes are never returned or persisted as content. Reuse the same idempotency_key for an uncertain outcome; changed bytes or metadata conflict.",
    inputSchema: STAGE_BUNDLE_FILE_INPUT_SCHEMA,
    outputSchema: STAGE_BUNDLE_FILE_OUTPUT_SCHEMA,
    securitySchemes: WRITE_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    }),
    _meta: Object.freeze({ "openai/fileParams": Object.freeze(["file"]) }),
  }),
  Object.freeze({
    name: "reconcile_file_stage",
    title: "Reconcile one file stage",
    description:
      "Read one exact stage idempotency outcome from its safe source receipt without uploading bytes or reserving capacity. Use the original source kind, key, digest, size and canonical metadata; changed payloads conflict.",
    inputSchema: RECONCILE_FILE_STAGE_INPUT_SCHEMA,
    outputSchema: RECONCILE_FILE_STAGE_OUTPUT_SCHEMA,
    securitySchemes: WRITE_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "get_bundle_file_download",
    title: "Create a one-use BundleFile download",
    description:
      "Create one short-lived one-use exact-revision download grant after current token, binding and Mind access checks. The tool returns no bytes; keep the response-only URL out of logs and prompts.",
    inputSchema: GET_BUNDLE_FILE_DOWNLOAD_INPUT_SCHEMA,
    outputSchema: GET_BUNDLE_FILE_DOWNLOAD_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    }),
  }),
] as const);

/** Canonical published definitions for immediate commit and asynchronous export. */
export const MCP_COMMIT_EXPORT_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "commit_changeset",
    title: "Commit a Mind changeset",
    description:
      "Atomically apply one non-empty Markdown and/or staged BundleFile changeset through the exact active write_binding_id to the matching current HEAD; a stale generation never redirects to another Mind. Before a substantial, deleting, or currently visible write, preview exact paths and visibility impact to the user and obtain explicit confirmation; then re-read HEAD and use its exact expected_revision. The call immediately creates one immutable revision and never creates a server draft or approval artifact. On revision_conflict, stop and rebuild instead of retrying a changed payload with the same idempotency key.",
    inputSchema: COMMIT_CHANGESET_INPUT_SCHEMA,
    outputSchema: COMMIT_CHANGESET_OUTPUT_SCHEMA,
    securitySchemes: WRITE_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "reconcile_changeset",
    title: "Reconcile a Mind changeset",
    description:
      "Read the idempotency outcome for the exact original commit_changeset payload. Missing performs no preflight, reservation, object write or HEAD mutation; a completed outcome returns the original immutable revision.",
    inputSchema: COMMIT_CHANGESET_INPUT_SCHEMA,
    outputSchema: RECONCILE_CHANGESET_OUTPUT_SCHEMA,
    securitySchemes: WRITE_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "capture_knowledge",
    title: "Capture routine knowledge",
    description:
      "Add one bounded routine, non-sensitive Memory to the exact private active writable Mind after automatic capture was explicitly enabled in the trusted control plane. Use the current binding_version, exact write_binding_id, and exact HEAD. Sources may be only the user's current statement or an entry in that same target HEAD. Never use this tool for sensitive, cross-Mind, external, destructive, or substantial content; request explicit confirmation and use commit_changeset when needed.",
    inputSchema: CAPTURE_KNOWLEDGE_INPUT_SCHEMA,
    outputSchema: CAPTURE_KNOWLEDGE_OUTPUT_SCHEMA,
    securitySchemes: WRITE_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "start_export",
    title: "Start an exact-revision OKF export",
    description:
      "Create an asynchronous export job fixed to one authorized immutable revision. Preserve the returned exact revision for integrity verification; the archive and download bearer URL are never returned by this call.",
    inputSchema: START_EXPORT_INPUT_SCHEMA,
    outputSchema: START_EXPORT_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "get_export_status",
    title: "Get export status",
    description:
      "Reauthorize and read one export job. A succeeded job may return a new short-lived download grant plus exact SHA-256 and size, never archive bytes. Keep the URL out of logs and prompts, download before expiry, and request a fresh grant only while current access remains valid.",
    inputSchema: GET_EXPORT_STATUS_INPUT_SCHEMA,
    outputSchema: GET_EXPORT_STATUS_OUTPUT_SCHEMA,
    securitySchemes: READ_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    }),
  }),
] as const);

/** Complete canonical tool catalog in the exact order advertised by tools/list. */
export const MCP_TOOL_DEFINITIONS = Object.freeze([
  ...MCP_READ_TOOL_DEFINITIONS,
  ...MCP_BINDING_TOOL_DEFINITIONS,
  ...MCP_BUNDLE_FILE_TOOL_DEFINITIONS,
  ...MCP_COMMIT_EXPORT_TOOL_DEFINITIONS,
] as const);

const CANONICAL_DEFINITION_BY_NAME: ReadonlyMap<
  string,
  Readonly<Record<string, unknown>>
> = new Map(
  MCP_TOOL_DEFINITIONS.map((definition) => [
    definition.name,
    definition,
  ]),
);

export const MCP_RESOURCE_CAPABILITIES = [
  "resources/list",
  "resources/read",
  "resources/templates/list-empty",
] as const;

export const MCP_ADVERTISED_CAPABILITIES = Object.freeze({
  tools: Object.freeze({}),
  resources: Object.freeze({}),
});

/** Security/product assertions for the custom Mind-aware MCP profile. */
export const MCP_CUSTOM_PROFILE_GUARDRAILS = Object.freeze({
  profile: "mind-diary-custom-mind-aware",
  companyKnowledgeCompatible: false,
  fetchToolRequiredFallback: true,
  resourceUrisAreCapabilities: false,
  resourceTemplatesPublished: false,
  implicitPersonalization: false,
  corpusSelectsMind: false,
  corpusSelectsScopes: false,
  controlToolsPublished: false,
  allowedWritePromptInjectionRisk: "residual-explicit",
});

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType: "text/markdown; charset=utf-8";
}

export interface McpRootResourcePage {
  readonly resources: readonly Readonly<McpResourceDescriptor>[];
  readonly nextCursor: string | null;
}

export interface McpImmutableResourceRead {
  readonly uri: string;
  readonly mimeType: "text/markdown; charset=utf-8";
  readonly text: string;
}

export interface ParsedMcpResourceUri {
  readonly kind: "index" | "entry";
  readonly spaceId: string;
  readonly revisionId: string;
  readonly path: string;
}

const MCP_RESOURCE_URI_PREFIX = "okf://spaces/";
const MCP_RESOURCE_URI_MAX_CHARACTERS = 4_096;
const RESOURCE_ENCODED_SEPARATOR = /%(?:2f|5c)/iu;
const RESOURCE_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function encodeRfc3986Segment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeCanonicalResourceSegment(value: string): string | null {
  if (value.length === 0 || RESOURCE_ENCODED_SEPARATOR.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.length === 0 ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      RESOURCE_ENCODED_SEPARATOR.test(decoded) ||
      RESOURCE_CONTROL_CHARACTER.test(decoded) ||
      encodeRfc3986Segment(decoded) !== value
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Parses the one exact token-free resource URI grammar. Re-encoding every
 * decoded segment prevents encoded-once, case, separator, and path ambiguity.
 */
export function parseMcpResourceUri(value: unknown): ParsedMcpResourceUri | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MCP_RESOURCE_URI_MAX_CHARACTERS ||
    !value.startsWith(MCP_RESOURCE_URI_PREFIX) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }
  const segments = value.slice(MCP_RESOURCE_URI_PREFIX.length).split("/");
  if (segments.length < 4 || segments[1] !== "revisions") return null;
  const spaceId = decodeCanonicalResourceSegment(segments[0]!);
  const revisionId = decodeCanonicalResourceSegment(segments[2]!);
  if (spaceId === null || revisionId === null) return null;

  if (segments.length === 4 && segments[3] === "index") {
    return Object.freeze({
      kind: "index",
      spaceId,
      revisionId,
      path: "index.md",
    });
  }
  if (segments[3] !== "entries" || segments.length < 5) return null;
  const pathSegments = segments.slice(4).map(decodeCanonicalResourceSegment);
  if (pathSegments.some((segment) => segment === null)) return null;
  const path = (pathSegments as string[]).join("/");
  if (
    path === "index.md" ||
    !path.endsWith(".md") ||
    path.startsWith("/") ||
    RESOURCE_ENCODED_SEPARATOR.test(path)
  ) {
    return null;
  }
  return Object.freeze({ kind: "entry", spaceId, revisionId, path });
}

function isRootIndexResourceUri(value: unknown): value is string {
  return parseMcpResourceUri(value)?.kind === "index";
}

type McpAuthenticatedActor = Extract<
  McpBearerAuthenticationResult,
  { readonly kind: "authenticated" }
>["actor"];
type McpRequestId = Parameters<McpBearerAuthenticator["authenticate"]>[1];
type McpToolName = (typeof MCP_CONTENT_TOOLS)[number];
type McpReadToolName = (typeof MCP_READ_TOOL_DEFINITIONS)[number]["name"];

const MCP_READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  MCP_READ_TOOL_DEFINITIONS.map((definition) => definition.name),
);

export interface McpRequestIdGenerator {
  nextRequestId(): McpRequestId;
}

export type McpToolAuthorizationDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "denied";
      readonly code: string;
      readonly retryable?: boolean;
    };

export interface McpContentApplication {
  /** Returns the deployed version's complete MCP tool definitions. */
  listTools(request: {
    readonly actor: McpAuthenticatedActor;
  }): Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** Enumerates only authorized Personal/accepted-membership root index resources. */
  listRootResources(request: {
    readonly actor: McpAuthenticatedActor;
    readonly cursor?: string;
  }): Promise<Readonly<McpRootResourcePage>>;
  /** Reauthorizes current access and reads one exact immutable Markdown resource. */
  readResource(request: {
    readonly actor: McpAuthenticatedActor;
    readonly uri: string;
  }): Promise<Readonly<McpImmutableResourceRead>>;
  /** Legacy compatibility hook; fused handlers execute application authorization once. */
  authorizeToolCall(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<McpToolAuthorizationDecision>;
  /** Preferred product path: validates, authorizes and executes in one application graph. */
  executeAuthorizedToolCall?(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
  executeToolCall(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface McpSafeRequestLogEvent {
  readonly requestId: McpRequestId;
  readonly method: string;
  /** Pathname only: URL query and fragment are intentionally absent. */
  readonly path: string;
  readonly status: number;
  readonly outcome:
    | "authenticated"
    | "authentication_failed"
    | "authentication_unavailable"
    | "protocol_error"
    | "tool_denied"
    | "tool_completed"
    | "internal_error";
  /** Only allowlisted protocol headers survive; secrets are redacted. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface McpSafeLogger {
  record(event: McpSafeRequestLogEvent): void | Promise<void>;
}

export interface McpHttpHandlerDependencies {
  readonly authenticator: McpBearerAuthenticator;
  readonly requestIds: McpRequestIdGenerator;
  readonly content: McpContentApplication;
  /** Canonical HTTPS origin allowed when a browser supplies an Origin header. */
  readonly allowedOrigin?: string;
  readonly oauth?: Readonly<{
    readonly protectedResourceMetadataUrl: string;
  }>;
  readonly logger?: McpSafeLogger;
}

const REDACTED_HEADER = "[REDACTED]";
const PRESENT_HEADER = "[PRESENT]";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
]);
const SAFE_PROTOCOL_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const SAFE_AUTHORIZATION_DENIALS = new Set([
  "access_denied",
  "capability_denied",
  "insufficient_scope",
  "deployment_capability_disabled",
  "historical_read_only",
  "authorization_state_changed",
]);
/** Header values default to omission so unknown private metadata cannot leak. */
export function redactMcpHeaders(
  headers: Headers,
): Readonly<Record<string, string>> {
  const redacted: Record<string, string> = {};
  for (const name of SENSITIVE_HEADERS) {
    if (headers.has(name)) redacted[name] = REDACTED_HEADER;
  }
  for (const name of SAFE_PROTOCOL_HEADERS) {
    if (headers.has(name)) redacted[name] = PRESENT_HEADER;
  }
  return Object.freeze(redacted);
}

function pathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "<invalid-path>";
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function oauthChallenge(
  oauth: McpHttpHandlerDependencies["oauth"],
  scope: "content:read" | "content:write" = "content:read",
): string {
  return oauth === undefined
    ? MCP_WWW_AUTHENTICATE
    : `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl}", scope="${scope}"`;
}

function authenticationResponse(
  requestId: McpRequestId,
  oauth?: McpHttpHandlerDependencies["oauth"],
): Response {
  return jsonResponse(
    401,
    {
      type: "about:blank",
      title: "Authentication required",
      status: 401,
      code: "authentication_required",
      request_id: requestId,
    },
    {
      "content-type": "application/problem+json; charset=utf-8",
      "www-authenticate": oauthChallenge(oauth),
    },
  );
}

function authenticationUnavailableResponse(requestId: McpRequestId): Response {
  return jsonResponse(
    503,
    {
      type: "about:blank",
      title: "Service unavailable",
      status: 503,
      code: "authentication_unavailable",
      request_id: requestId,
    },
    { "content-type": "application/problem+json; charset=utf-8" },
  );
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  status: number,
  headers: Readonly<Record<string, string>> = {},
  data?: Readonly<Record<string, unknown>>,
): Response {
  return jsonResponse(
    status,
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    headers,
  );
}

type McpResponseFormat = "json" | "sse";

interface AcceptedRepresentation {
  readonly format: McpResponseFormat;
  readonly preference: number;
  readonly position: number;
}

interface McpJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface McpProtocolError {
  readonly code: -32600 | -32020 | -32021 | -32022;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

function noContentResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function jsonRpcResult(
  id: string | number | undefined,
  result: unknown,
  format: McpResponseFormat,
): Response {
  if (id === undefined) return noContentResponse(202);
  const payload = { jsonrpc: "2.0", id, result };
  if (format === "json") return jsonResponse(200, payload);
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function acceptedResponseFormat(value: string | null): McpResponseFormat | null {
  if (value === null) return null;
  const supported = new Map<McpResponseFormat, AcceptedRepresentation>();
  for (const [position, item] of value.split(",").entries()) {
    const [rawMediaType, ...rawParameters] = item.split(";");
    const mediaType = rawMediaType?.trim().toLowerCase();
    const format =
      mediaType === "application/json"
        ? "json"
        : mediaType === "text/event-stream"
          ? "sse"
          : null;
    if (format === null) continue;

    let preference = 1;
    for (const rawParameter of rawParameters) {
      const [rawName, rawValue] = rawParameter.split("=", 2);
      if (rawName?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(rawValue?.trim());
      preference = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    if (preference <= 0) continue;
    const existing = supported.get(format);
    if (
      existing === undefined ||
      preference > existing.preference ||
      (preference === existing.preference && position < existing.position)
    ) {
      supported.set(format, { format, preference, position });
    }
  }

  const json = supported.get("json");
  const sse = supported.get("sse");
  if (json === undefined || sse === undefined) return null;
  if (sse.preference !== json.preference) {
    return sse.preference > json.preference ? "sse" : "json";
  }
  return sse.position < json.position ? "sse" : "json";
}

function hasJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function invalidRequestOrigin(
  request: Request,
  allowedOrigin: string | undefined,
): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== allowedOrigin;
}

function validRpcId(value: unknown): value is string | number | undefined {
  return (
    value === undefined ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function parseJsonRpcRequest(value: unknown): McpJsonRpcRequest | null {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    !validRpcId(value.id) ||
    !isRecord(value.params)
  ) {
    return null;
  }
  return value as unknown as McpJsonRpcRequest;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function expectedMcpName(request: McpJsonRpcRequest): unknown {
  if (request.method === "tools/call") return request.params.name;
  if (request.method === "resources/read") return request.params.uri;
  return null;
}

function decodedMcpHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -2);
  if (encoded.length === 0) return null;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validateProtocolEnvelope(
  request: McpJsonRpcRequest,
  headers: Headers,
): McpProtocolError | null {
  const headerVersion = headers.get("mcp-protocol-version");
  if (headerVersion === null) {
    return { code: -32020, message: "MCP-Protocol-Version is required." };
  }
  if (headerVersion !== MCP_TARGET_PROTOCOL) {
    return {
      code: -32022,
      message: "Unsupported MCP protocol version.",
      data: Object.freeze({
        requested: headerVersion,
        supported: Object.freeze([MCP_TARGET_PROTOCOL]),
      }),
    };
  }

  const methodHeader = headers.get("mcp-method");
  if (methodHeader === null || methodHeader !== request.method) {
    return { code: -32020, message: "Mcp-Method does not match the request body." };
  }

  const expectedName = expectedMcpName(request);
  const nameHeader = headers.get("mcp-name");
  const decodedNameHeader = decodedMcpHeaderValue(nameHeader);
  if (expectedName === null) {
    if (nameHeader !== null) {
      return { code: -32020, message: "Mcp-Name is not valid for this method." };
    }
  } else if (
    !nonEmptyString(expectedName) ||
    decodedNameHeader !== expectedName
  ) {
    return { code: -32020, message: "Mcp-Name does not match the request body." };
  }

  const meta = request.params._meta;
  if (!isRecord(meta)) {
    return { code: -32020, message: "Request protocol metadata is required." };
  }
  const metaVersion = meta["io.modelcontextprotocol/protocolVersion"];
  if (typeof metaVersion !== "string") {
    return { code: -32020, message: "Request protocol metadata is incomplete." };
  }
  if (metaVersion !== MCP_TARGET_PROTOCOL || metaVersion !== headerVersion) {
    return {
      code: -32022,
      message: "Unsupported MCP protocol version.",
      data: Object.freeze({
        requested: metaVersion,
        supported: Object.freeze([MCP_TARGET_PROTOCOL]),
      }),
    };
  }

  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  if (
    !isRecord(clientInfo) ||
    !nonEmptyString(clientInfo.name) ||
    !nonEmptyString(clientInfo.version)
  ) {
    return { code: -32020, message: "Client information is required." };
  }
  if (!isRecord(meta["io.modelcontextprotocol/clientCapabilities"])) {
    return { code: -32021, message: "Client capabilities are required." };
  }
  return null;
}

export function createMcpToolSuccessResult(
  data: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    resultType: "complete",
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: message }),
    ]),
    structuredContent: Object.freeze({ ok: true, data }),
    isError: false,
  });
}

export function createMcpToolErrorResult(
  requestId: McpRequestId,
  code: string,
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
  meta?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const error = Object.freeze({
    code,
    message,
    retryable,
    request_id: requestId,
    ...(details === undefined ? {} : { details }),
  });
  return Object.freeze({
    resultType: "complete",
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: message }),
    ]),
    structuredContent: Object.freeze({ ok: false, error }),
    isError: true,
    ...(meta === undefined ? {} : { _meta: meta }),
  });
}

function isReadToolName(name: McpToolName): name is McpReadToolName {
  return MCP_READ_TOOL_NAMES.has(name);
}

function readToolSuccessMessage(name: McpReadToolName): string {
  switch (name) {
    case "list_minds":
      return "Listed accessible Minds.";
    case "resolve_mind":
      return "Resolved the Mind.";
    case "get_mind_info":
      return "Resolved the Mind and revision.";
    case "get_mind_bindings":
      return "Read the current Mind bindings.";
    case "browse_entries":
      return "Browsed entries in the resolved Mind revision.";
    case "search":
      return "Searched the resolved Mind revision.";
    case "fetch":
      return "Fetched the exact entry revision.";
    case "list_revisions":
      return "Listed Mind revisions.";
    case "get_revision":
      return "Fetched the exact Mind revision.";
    case "validate_mind":
      return "Validated the complete Mind revision.";
    case "list_bundle_files":
      return "Listed BundleFiles in the exact Mind revision.";
  }
}

function normalizeReadToolExecutionResult(
  name: McpReadToolName,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    value.resultType !== "complete" ||
    !isRecord(value.structuredContent) ||
    typeof value.isError !== "boolean"
  ) {
    return createMcpToolSuccessResult(value, readToolSuccessMessage(name));
  }
  if (Array.isArray(value.content)) return value;
  return Object.freeze({
    ...value,
    content: Object.freeze([
      Object.freeze({
        type: "text" as const,
        text: value.isError ? "The tool call failed." : readToolSuccessMessage(name),
      }),
    ]),
  });
}

interface SafeReadToolFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

function readFailureMessage(code: string): string {
  switch (code) {
    case "authentication_required":
      return "Authentication is required.";
    case "forbidden":
      return "The requested operation is not allowed.";
    case "mind_not_found":
      return "Mind was not found.";
    case "revision_not_found":
      return "Revision was not found.";
    case "locator_not_found":
    case "resource_not_found":
      return "The requested entry was not found.";
    case "bundle_file_not_found":
      return "BundleFile was not found.";
    case "search_index_unavailable":
      return "Search is unavailable for the exact requested revision.";
    case "discovery_unavailable":
      return "Mind discovery is unavailable.";
    case "revision_integrity_failure":
      return "The exact revision could not be materialized safely.";
    case "read_conflict":
      return "The Mind changed while it was being read; retry the call.";
    case "mind_binding_required":
      return "Attach this Mind for reading or select it as the writable target first.";
    case "write_binding_required":
      return "Select exactly one writable Mind before committing.";
    case "write_binding_stale":
      return "The writable Mind changed; inspect current bindings and rebuild the commit.";
    case "binding_owner_revoked":
      return "The current credential can no longer use Mind bindings.";
    case "binding_state_unavailable":
      return "Mind binding state is unavailable.";
    case "invalid_cursor":
      return "The pagination cursor is invalid.";
    case "invalid_limit":
      return "The page limit is invalid.";
    case "invalid_path":
      return "The content path is invalid.";
    case "invalid_fetch_budget":
      return "The fetch response budget is invalid.";
    case "invalid_mind_selector":
      return "The Mind selector is invalid.";
    case "invalid_revision_selector":
      return "The revision selector is invalid.";
    case "invalid_query":
      return "The query is invalid.";
    case "invalid_request":
    default:
      return "The tool arguments are invalid.";
  }
}

function safeReadToolFailure(error: unknown): SafeReadToolFailure | null {
  if (
    !(
      error instanceof MindDiscoveryFailure ||
      error instanceof MindBrowseFailure ||
      error instanceof MindHistoryFailure ||
      error instanceof MindSearchFailure ||
      error instanceof MindValidationFailure ||
      error instanceof BundleFileDownloadFailure
    )
  ) {
    return null;
  }
  const retryable =
    "retryable" in error
      ? error.retryable === true
      : error.code === "discovery_unavailable";
  return Object.freeze({
    code: error.code,
    message: readFailureMessage(error.code),
    retryable,
  });
}

function toolError(
  id: string | number | undefined,
  requestId: McpRequestId,
  code: string,
  message: string,
  format: McpResponseFormat,
  retryable = false,
  meta?: Readonly<Record<string, unknown>>,
): Response {
  return jsonRpcResult(
    id,
    createMcpToolErrorResult(requestId, code, message, retryable, undefined, meta),
    format,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolName(value: unknown): value is McpToolName {
  return (
    typeof value === "string" &&
    (MCP_CONTENT_TOOLS as readonly string[]).includes(value)
  );
}

function tokenAllowsWrite(actor: McpAuthenticatedActor): boolean {
  return actor.authentication.effectiveScopes.some(
    (scope) => scope === "content:write",
  );
}

async function authenticateRequest(
  request: Request,
  authenticator: McpBearerAuthenticator,
  requestId: McpRequestId,
): Promise<McpBearerAuthenticationResult> {
  const header = request.headers.get("authorization");
  if (header === null) return { kind: "invalid" };
  const match = /^Bearer ([^\s,]+)$/iu.exec(header);
  if (match?.[1] === undefined) return { kind: "invalid" };
  return authenticator.authenticate(match[1], requestId);
}

async function safeLog(
  logger: McpSafeLogger | undefined,
  request: Request,
  requestId: McpRequestId,
  response: Response,
  outcome: McpSafeRequestLogEvent["outcome"],
): Promise<void> {
  if (!logger) return;
  try {
    await logger.record(
      Object.freeze({
        requestId,
        method: request.method,
        path: pathname(request),
        status: response.status,
        outcome,
        headers: redactMcpHeaders(request.headers),
      }),
    );
  } catch {
    // Logging is best-effort and cannot change authentication/tool outcomes.
  }
}

function listedTools(
  actor: McpAuthenticatedActor,
  definitions: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  const available = new Set(
    definitions.flatMap((definition) =>
      typeof definition.name === "string" ? [definition.name] : [],
    ),
  );
  return Object.freeze(
    MCP_CONTENT_TOOLS
      .filter(
        (name) =>
          available.has(name) &&
          (name !== "stage_bundle_file" || tokenAllowsWrite(actor)),
      )
      .map((name) => CANONICAL_DEFINITION_BY_NAME.get(name))
      .filter(
        (definition): definition is Readonly<Record<string, unknown>> =>
          definition !== undefined,
      ),
  );
}

type ResourceListParameters =
  | { readonly kind: "valid"; readonly cursor?: string }
  | { readonly kind: "invalid" };

function resourceListParameters(
  params: Readonly<Record<string, unknown>>,
): ResourceListParameters {
  if (Object.keys(params).some((key) => key !== "_meta" && key !== "cursor")) {
    return Object.freeze({ kind: "invalid" });
  }
  if (params.cursor === undefined) return Object.freeze({ kind: "valid" });
  if (
    typeof params.cursor !== "string" ||
    params.cursor.length === 0 ||
    params.cursor.length > 4_096 ||
    RESOURCE_CONTROL_CHARACTER.test(params.cursor)
  ) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind: "valid", cursor: params.cursor });
}

function exactResourceReadUri(
  params: Readonly<Record<string, unknown>>,
): string | null {
  const keys = Object.keys(params).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "_meta" ||
    keys[1] !== "uri" ||
    parseMcpResourceUri(params.uri) === null
  ) {
    return null;
  }
  return params.uri as string;
}

function validSafeResourceText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !RESOURCE_CONTROL_CHARACTER.test(value)
  );
}

function normalizedRootResourcePage(
  value: unknown,
): Readonly<McpRootResourcePage> | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.resources) ||
    (value.nextCursor !== null &&
      (typeof value.nextCursor !== "string" ||
        value.nextCursor.length === 0 ||
        value.nextCursor.length > 4_096 ||
        RESOURCE_CONTROL_CHARACTER.test(value.nextCursor)))
  ) {
    return null;
  }
  const resources: McpResourceDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value.resources) {
    if (
      !isRecord(candidate) ||
      !isRootIndexResourceUri(candidate.uri) ||
      !validSafeResourceText(candidate.name) ||
      candidate.mimeType !== "text/markdown; charset=utf-8" ||
      (candidate.title !== undefined && !validSafeResourceText(candidate.title)) ||
      (candidate.description !== undefined &&
        !validSafeResourceText(candidate.description)) ||
      seen.has(candidate.uri)
    ) {
      return null;
    }
    seen.add(candidate.uri);
    resources.push(
      Object.freeze({
        uri: candidate.uri,
        name: candidate.name,
        ...(candidate.title === undefined ? {} : { title: candidate.title }),
        ...(candidate.description === undefined
          ? {}
          : { description: candidate.description }),
        mimeType: candidate.mimeType,
      }),
    );
  }
  resources.sort((left, right) =>
    left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0,
  );
  return Object.freeze({
    resources: Object.freeze(resources),
    nextCursor: value.nextCursor,
  });
}

function normalizedResourceRead(
  expectedUri: string,
  value: unknown,
): Readonly<McpImmutableResourceRead> | null {
  if (
    !isRecord(value) ||
    value.uri !== expectedUri ||
    parseMcpResourceUri(value.uri) === null ||
    value.mimeType !== "text/markdown; charset=utf-8" ||
    typeof value.text !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    uri: value.uri,
    mimeType: value.mimeType,
    text: value.text,
  });
}

function resourceNotFoundResponse(
  id: string | number | undefined,
  format: McpResponseFormat,
): Response {
  const payload = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32602, message: "Resource not found" },
  };
  if (format === "json") return jsonResponse(400, payload);
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 400,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function indistinguishableResourceNotFound(error: unknown): boolean {
  return (
    error instanceof MindBrowseFailure &&
    error.code !== "revision_integrity_failure"
  );
}

/**
 * Request-scoped Streamable HTTP boundary. It intentionally does not retain an
 * actor, token, role, authorization decision, request body, query, or result.
 */
function createMcpHttpHandlerAtEndpoint(
  dependencies: McpHttpHandlerDependencies,
  endpoint: string,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = dependencies.requestIds.nextRequestId();
    if (pathname(request) !== endpoint) {
      const response = jsonRpcError(null, -32600, "Invalid request", 404);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }
    if (request.method !== "POST") {
      const response = jsonRpcError(
        null,
        -32600,
        "Stateless MCP accepts POST only.",
        405,
        { allow: "POST" },
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    if (invalidRequestOrigin(request, dependencies.allowedOrigin)) {
      const response = jsonRpcError(null, -32600, "Invalid Origin", 403);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    let authentication: McpBearerAuthenticationResult;
    try {
      authentication = await authenticateRequest(
        request,
        dependencies.authenticator,
        requestId,
      );
    } catch {
      const response = authenticationUnavailableResponse(requestId);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authentication_unavailable",
      );
      return response;
    }
    if (authentication.kind !== "authenticated") {
      const response = authenticationResponse(requestId, dependencies.oauth);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authentication_failed",
      );
      return response;
    }
    const actor = authentication.actor;

    if (!hasJsonContentType(request.headers.get("content-type"))) {
      const response = jsonRpcError(
        null,
        -32600,
        "Content-Type must be application/json.",
        400,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    const responseFormat = acceptedResponseFormat(request.headers.get("accept"));
    if (responseFormat === null) {
      const response = jsonRpcError(
        null,
        -32600,
        "Accept must allow application/json and text/event-stream.",
        400,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      const response = jsonRpcError(null, -32700, "Parse error", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    const rpc = parseJsonRpcRequest(parsed);
    if (rpc === null) {
      const id = isRecord(parsed) && validRpcId(parsed.id) ? parsed.id : null;
      const response = jsonRpcError(id, -32600, "Invalid request", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    const protocolError = validateProtocolEnvelope(rpc, request.headers);
    if (protocolError !== null) {
      const response = jsonRpcError(
        rpc.id,
        protocolError.code,
        protocolError.message,
        400,
        {},
        protocolError.data,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    if (rpc.method === "server/discover") {
      if (
        rpc.id === undefined ||
        Object.keys(rpc.params).length !== 1 ||
        !Object.hasOwn(rpc.params, "_meta")
      ) {
        const response = jsonRpcError(rpc.id, -32602, "Invalid params", 400);
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "protocol_error",
        );
        return response;
      }
      const response = jsonRpcResult(
        rpc.id,
        Object.freeze({
          resultType: "complete" as const,
          supportedVersions: Object.freeze([MCP_TARGET_PROTOCOL]),
          capabilities: MCP_ADVERTISED_CAPABILITIES,
          _meta: Object.freeze({
            "io.modelcontextprotocol/serverInfo": Object.freeze({
              name: "mind-diary",
              title: "Mind Diary",
              version: "0.1.0",
            }),
          }),
          instructions:
            "Use list_minds only to discover eligible targets. Inspect get_mind_bindings, attach every intended read target with set_read_mind_binding, and select at most one writable target with set_write_mind_binding. Discovery never creates a binding and there is no implicit /me fallback.",
          ttlMs: 60_000,
          cacheScope: "private" as const,
        }),
        responseFormat,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authenticated",
      );
      return response;
    }

    if (rpc.method === "resources/templates/list") {
      if (
        Object.keys(rpc.params).length !== 1 ||
        !Object.hasOwn(rpc.params, "_meta")
      ) {
        const response = jsonRpcError(rpc.id, -32602, "Invalid params", 400);
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "protocol_error",
        );
        return response;
      }
      const response = jsonRpcResult(
        rpc.id,
        {
          resultType: "complete",
          resourceTemplates: Object.freeze([]),
        },
        responseFormat,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authenticated",
      );
      return response;
    }

    if (rpc.method === "resources/list") {
      const parameters = resourceListParameters(rpc.params);
      if (parameters.kind === "invalid") {
        const response = jsonRpcError(rpc.id, -32602, "Invalid params", 400);
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "protocol_error",
        );
        return response;
      }
      let response: Response;
      try {
        const listed = await dependencies.content.listRootResources({
          actor,
          ...(parameters.cursor === undefined
            ? {}
            : { cursor: parameters.cursor }),
        });
        const page = normalizedRootResourcePage(listed);
        response =
          page === null
            ? jsonResponse(500, {
                code: "internal_error",
                request_id: requestId,
              })
            : jsonRpcResult(
                rpc.id,
                Object.freeze({
                  resultType: "complete",
                  resources: page.resources,
                  ...(page.nextCursor === null
                    ? {}
                    : { nextCursor: page.nextCursor }),
                  ttlMs: 60_000,
                  cacheScope: "private",
                }),
                responseFormat,
              );
      } catch {
        response = jsonResponse(500, {
          code: "internal_error",
          request_id: requestId,
        });
      }
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        response.status === 200 || response.status === 202
          ? "authenticated"
          : "internal_error",
      );
      return response;
    }

    if (rpc.method === "resources/read") {
      const uri = exactResourceReadUri(rpc.params);
      if (uri === null) {
        const response = resourceNotFoundResponse(rpc.id, responseFormat);
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "protocol_error",
        );
        return response;
      }
      let response: Response;
      let outcome: McpSafeRequestLogEvent["outcome"];
      try {
        const read = normalizedResourceRead(
          uri,
          await dependencies.content.readResource({ actor, uri }),
        );
        if (read === null) {
          response = jsonResponse(500, {
            code: "internal_error",
            request_id: requestId,
          });
          outcome = "internal_error";
        } else {
          response = jsonRpcResult(
            rpc.id,
            {
              resultType: "complete",
              contents: Object.freeze([
                Object.freeze({
                  uri: read.uri,
                  mimeType: read.mimeType,
                  text: read.text,
                }),
              ]),
            },
            responseFormat,
          );
          outcome = "authenticated";
        }
      } catch (error) {
        if (indistinguishableResourceNotFound(error)) {
          response = resourceNotFoundResponse(rpc.id, responseFormat);
          outcome = "protocol_error";
        } else {
          response = jsonResponse(500, {
            code: "internal_error",
            request_id: requestId,
          });
          outcome = "internal_error";
        }
      }
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        outcome,
      );
      return response;
    }

    if (rpc.method === "tools/list") {
      let response: Response;
      try {
        const definitions = await dependencies.content.listTools({ actor });
        response = jsonRpcResult(
          rpc.id,
          {
            resultType: "complete",
            tools: listedTools(actor, definitions),
            ttlMs: 60_000,
            cacheScope: "private",
          },
          responseFormat,
        );
      } catch {
        response = jsonResponse(500, {
          code: "internal_error",
          request_id: requestId,
        });
      }
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        response.status === 200 || response.status === 202
          ? "authenticated"
          : "internal_error",
      );
      return response;
    }

    if (rpc.method !== "tools/call" || !isRecord(rpc.params)) {
      const message =
        rpc.method === "initialize"
          ? "Method not found; initialize is not part of the stateless 2026-07-28 profile."
          : "Method not found";
      const response = jsonRpcError(rpc.id, -32601, message, 404);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    const name = rpc.params.name;
    const argumentsValue = rpc.params.arguments;
    if (!isToolName(name) || !isRecord(argumentsValue)) {
      const response = jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }
    const toolArguments = Object.freeze({ ...argumentsValue });

    if (
      (name === "commit_changeset" ||
        name === "reconcile_changeset" ||
        name === "stage_bundle_file" ||
        name === "reconcile_file_stage" ||
        name === "capture_knowledge" ||
        name === "set_write_mind_binding") &&
      !tokenAllowsWrite(actor)
    ) {
      const challenge = oauthChallenge(dependencies.oauth, "content:write");
      const response = toolError(
        rpc.id,
        requestId,
        "insufficient_scope",
        "The token does not allow content writes.",
        responseFormat,
        false,
        Object.freeze({ "mcp/www_authenticate": Object.freeze([challenge]) }),
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "tool_denied",
      );
      return response;
    }

    const fusedExecution = dependencies.content.executeAuthorizedToolCall;
    if (fusedExecution === undefined) {
      let authorization: McpToolAuthorizationDecision;
      try {
        authorization = await dependencies.content.authorizeToolCall({
          actor,
          name,
          arguments: toolArguments,
        });
      } catch {
        const response = jsonResponse(500, {
          code: "internal_error",
          request_id: requestId,
        });
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "internal_error",
        );
        return response;
      }

      if (authorization.kind === "denied") {
        if (
          authorization.code === "authentication_required" ||
          authorization.code === "token_inactive"
        ) {
          const response = authenticationResponse(requestId, dependencies.oauth);
          await safeLog(
            dependencies.logger,
            request,
            requestId,
            response,
            "authentication_failed",
          );
          return response;
        }
        const code = SAFE_AUTHORIZATION_DENIALS.has(authorization.code)
          ? authorization.code
          : "forbidden";
        const response = toolError(
          rpc.id,
          requestId,
          code,
          "The requested operation is not allowed.",
          responseFormat,
          authorization.retryable === true,
        );
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "tool_denied",
        );
        return response;
      }
    }

    try {
      const execution = await (fusedExecution === undefined
        ? dependencies.content.executeToolCall({
            actor,
            name,
            arguments: toolArguments,
          })
        : fusedExecution.call(dependencies.content, {
            actor,
            name,
            arguments: toolArguments,
          }));
      const result = isReadToolName(name)
        ? normalizeReadToolExecutionResult(name, execution)
        : execution;
      const response = jsonRpcResult(rpc.id, result, responseFormat);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "tool_completed",
      );
      return response;
    } catch (error) {
      const safeFailure = isReadToolName(name) || name === "get_bundle_file_download"
        ? safeReadToolFailure(error)
        : null;
      if (safeFailure !== null) {
        const response = toolError(
          rpc.id,
          requestId,
          safeFailure.code,
          safeFailure.message,
          responseFormat,
          safeFailure.retryable,
        );
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          safeFailure.code === "forbidden" ? "tool_denied" : "tool_completed",
        );
        return response;
      }
      const response = jsonResponse(500, {
        code: "internal_error",
        request_id: requestId,
      });
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "internal_error",
      );
      return response;
    }
  };
}

/** Current stateless MCP 2026-07-28 endpoint. */
export function createMcpHttpHandler(
  dependencies: McpHttpHandlerDependencies,
): (request: Request) => Promise<Response> {
  return createMcpHttpHandlerAtEndpoint(dependencies, MCP_ENDPOINT);
}

interface LegacyCodexJsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

function parseLegacyCodexJsonRpcMessage(
  value: unknown,
): LegacyCodexJsonRpcMessage | null {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    !nonEmptyString(value.method) ||
    !validRpcId(value.id) ||
    (value.params !== undefined && !isRecord(value.params))
  ) {
    return null;
  }
  return value as unknown as LegacyCodexJsonRpcMessage;
}

function validLegacyCodexInitialize(
  rpc: LegacyCodexJsonRpcMessage,
): boolean {
  if (rpc.id === undefined || !isRecord(rpc.params)) return false;
  const clientInfo = rpc.params.clientInfo;
  return (
    (rpc.params.protocolVersion === "2025-06-18" ||
      rpc.params.protocolVersion === MCP_LEGACY_CODEX_PROTOCOL) &&
    isRecord(rpc.params.capabilities) &&
    isRecord(clientInfo) &&
    nonEmptyString(clientInfo.name) &&
    nonEmptyString(clientInfo.version)
  );
}

function legacyCodexProtocolHeader(request: Request): McpProtocolError | null {
  return request.headers.get("mcp-protocol-version") === MCP_LEGACY_CODEX_PROTOCOL
    ? null
    : { code: -32022, message: "Unsupported MCP protocol version." };
}

function modernizedLegacyCodexRequest(
  request: Request,
  rpc: LegacyCodexJsonRpcMessage,
): Request {
  const params: Readonly<Record<string, unknown>> =
    rpc.params ?? Object.freeze({});
  const existingMeta = isRecord(params._meta) ? params._meta : Object.freeze({});
  const modernParams: Readonly<Record<string, unknown>> = Object.freeze({
    ...params,
    _meta: Object.freeze({
      ...existingMeta,
      "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
      "io.modelcontextprotocol/clientInfo": Object.freeze({
        name: "codex-legacy-bridge",
        version: MCP_LEGACY_CODEX_PROTOCOL,
      }),
      "io.modelcontextprotocol/clientCapabilities": Object.freeze({}),
    }),
  });
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("mcp-protocol-version", MCP_TARGET_PROTOCOL);
  headers.set("mcp-method", rpc.method);
  headers.delete("mcp-session-id");
  const name =
    rpc.method === "tools/call"
      ? modernParams.name
      : rpc.method === "resources/read"
        ? modernParams.uri
        : null;
  if (nonEmptyString(name)) headers.set("mcp-name", name);
  else headers.delete("mcp-name");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(rpc.id === undefined ? {} : { id: rpc.id }),
      method: rpc.method,
      params: modernParams,
    }),
  });
}

async function legacyCodexResponse(response: Response): Promise<Response> {
  if (
    response.status !== 200 ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return response;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return jsonRpcError(null, -32603, "Internal error", 500);
  }
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return jsonResponse(response.status, payload);
  }
  const {
    resultType: _resultType,
    ttlMs: _ttlMs,
    cacheScope: _cacheScope,
    ...result
  } = payload.result;
  return jsonResponse(response.status, { ...payload, result });
}

/**
 * Isolated Streamable HTTP 2025-11-25 lifecycle bridge for Codex 0.147.
 *
 * It deliberately does not create protocol sessions. Authentication and all
 * content authorization still run per request, while operational messages are
 * translated into the current stateless application boundary.
 */
export function createLegacyCodexMcpHttpHandler(
  dependencies: McpHttpHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = dependencies.requestIds.nextRequestId();
    if (pathname(request) !== MCP_LEGACY_CODEX_ENDPOINT) {
      const response = jsonRpcError(null, -32600, "Invalid request", 404);
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    if (request.method !== "POST") {
      const response = jsonRpcError(
        null,
        -32600,
        "Legacy Codex MCP accepts POST only.",
        405,
        { allow: "POST" },
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    if (invalidRequestOrigin(request, dependencies.allowedOrigin)) {
      const response = jsonRpcError(null, -32600, "Invalid Origin", 403);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    let authentication: McpBearerAuthenticationResult;
    try {
      authentication = await authenticateRequest(
        request,
        dependencies.authenticator,
        requestId,
      );
    } catch {
      const response = authenticationUnavailableResponse(requestId);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authentication_unavailable",
      );
      return response;
    }
    if (authentication.kind !== "authenticated") {
      const response = authenticationResponse(requestId, dependencies.oauth);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authentication_failed",
      );
      return response;
    }

    if (request.headers.has("mcp-session-id")) {
      const response = jsonRpcError(
        null,
        -32020,
        "Mcp-Session-Id is not used by the stateless Codex compatibility profile.",
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    if (!hasJsonContentType(request.headers.get("content-type"))) {
      const response = jsonRpcError(
        null,
        -32600,
        "Content-Type must be application/json.",
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    const responseFormat = acceptedResponseFormat(request.headers.get("accept"));
    if (responseFormat === null) {
      const response = jsonRpcError(
        null,
        -32600,
        "Accept must allow application/json and text/event-stream.",
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      const response = jsonRpcError(null, -32700, "Parse error", 400);
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    const rpc = parseLegacyCodexJsonRpcMessage(parsed);
    if (rpc === null) {
      const id = isRecord(parsed) && validRpcId(parsed.id) ? parsed.id : null;
      const response = jsonRpcError(id, -32600, "Invalid request", 400);
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    if (rpc.method === "initialize") {
      const initializationVersionHeader = request.headers.get(
        "mcp-protocol-version",
      );
      const response =
        initializationVersionHeader !== null
          ? jsonRpcError(
              rpc.id,
              -32022,
              "MCP-Protocol-Version is not valid before legacy negotiation.",
              400,
            )
          : validLegacyCodexInitialize(rpc)
            ? jsonResponse(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  protocolVersion: MCP_LEGACY_CODEX_PROTOCOL,
                  capabilities: {
                    tools: Object.freeze({}),
                  },
                  serverInfo: {
                    name: "mind-diary",
                    title: "Mind Diary",
                    version: "0.1.0",
                  },
                  instructions:
                    "Use list_minds only to discover eligible targets. Inspect get_mind_bindings, attach every intended read target with set_read_mind_binding, and select at most one writable target with set_write_mind_binding. Discovery never creates a binding and there is no implicit /me fallback.",
                },
              })
            : jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        response.status === 200 ? "authenticated" : "protocol_error",
      );
      return response;
    }

    const protocolError = legacyCodexProtocolHeader(request);
    if (protocolError !== null) {
      const response = jsonRpcError(
        rpc.id,
        protocolError.code,
        protocolError.message,
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    if (rpc.method === "notifications/initialized") {
      const valid =
        rpc.id === undefined &&
        (rpc.params === undefined || Object.keys(rpc.params).length === 0);
      const response = valid
        ? noContentResponse(202)
        : jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        valid ? "authenticated" : "protocol_error",
      );
      return response;
    }

    if (rpc.method === "ping") {
      const response =
        rpc.id !== undefined &&
        (rpc.params === undefined || Object.keys(rpc.params).length === 0)
          ? jsonRpcResult(rpc.id, Object.freeze({}), responseFormat)
          : jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        response.status === 200 ? "authenticated" : "protocol_error",
      );
      return response;
    }

    if (rpc.method !== "tools/list" && rpc.method !== "tools/call") {
      const response = jsonRpcError(rpc.id, -32601, "Method not found", 404);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    const translated = modernizedLegacyCodexRequest(request, rpc);
    const authenticatedDependencies: McpHttpHandlerDependencies = {
      ...dependencies,
      authenticator: {
        async authenticate() {
          return authentication;
        },
      },
      requestIds: {
        nextRequestId() {
          return requestId;
        },
      },
    };
    return legacyCodexResponse(
      await createMcpHttpHandlerAtEndpoint(
        authenticatedDependencies,
        MCP_LEGACY_CODEX_ENDPOINT,
      )(translated),
    );
  };
}

export * from "./product-application.js";
