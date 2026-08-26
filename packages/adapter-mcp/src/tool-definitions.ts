import {
  CONTENT_COMMANDS,
  CONTENT_QUERIES,
} from "@mind-diary/application-content";

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
  "create_file_upload_intent",
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

const SET_WRITE_MIND_BINDING_INPUT_SCHEMA = strictInputSchema(
  {
    action: Object.freeze({
      type: "string",
      enum: Object.freeze(["bind", "unbind"]),
    }),
    mind: MIND_SELECTOR_SCHEMA,
    expected_binding_version: BINDING_VERSION_SCHEMA,
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
  },
  ["action", "expected_binding_version", "idempotency_key"],
);

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
      minLength: 3,
      maxLength: 127,
      pattern: "^[!#$%&'*+.^_`|~0-9a-z-]+/[!#$%&'*+.^_`|~0-9a-z-]+$",
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
  minLength: 3,
  maxLength: 127,
  pattern: "^[!#$%&'*+.^_`|~0-9a-z-]+/[!#$%&'*+.^_`|~0-9a-z-]+$",
});

const FILE_INGRESS_MEDIA_HINT_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
});

const GET_FILE_INGRESS_CAPABILITIES_INPUT_SCHEMA = strictInputSchema({});

const GET_FILE_INGRESS_CAPABILITIES_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "report_scope",
      "client_companion_status",
      "path_admission_status",
      "sources",
    ]),
    properties: Object.freeze({
      report_scope: Object.freeze({ const: "hosted_server_adapters_only" }),
      client_companion_status: Object.freeze({ const: "not_reported" }),
      path_admission_status: Object.freeze({ const: "not_reported" }),
      sources: Object.freeze({
        type: "array",
        minItems: 6,
        maxItems: 6,
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze([
            "source_kind",
            "server_adapter_status",
            "server_transport",
            "requires_write_binding",
            "max_bytes",
            "fallback",
          ]),
          properties: Object.freeze({
            source_kind: FILE_INGRESS_SOURCE_KIND_SCHEMA,
            server_adapter_status: Object.freeze({
              type: "string",
              enum: Object.freeze(["available", "not_available"]),
            }),
            server_transport: Object.freeze({
              type: "string",
              enum: Object.freeze(["companion_upload_intent", "none"]),
            }),
            requires_write_binding: Object.freeze({ type: "boolean" }),
            max_bytes: Object.freeze({ type: "integer", minimum: 0 }),
            fallback: Object.freeze({ const: "none" }),
          }),
        }),
      }),
    }),
  }),
);

const CREATE_FILE_UPLOAD_INTENT_INPUT_SCHEMA = strictInputSchema(
  {
    mind: MIND_SELECTOR_SCHEMA,
    write_binding_id: OPAQUE_ID_SCHEMA,
    source_kind: Object.freeze({
      type: "string",
      enum: Object.freeze([
        "local_path",
        "workspace/generated_artifact",
      ]),
    }),
    display_filename: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: 255,
    }),
    claimed_media_type: Object.freeze({
      type: "string",
      maxLength: 256,
    }),
    expected_size: Object.freeze({
      type: "integer",
      minimum: 0,
      maximum: 268_435_456,
    }),
    expected_sha256: SHA256_SCHEMA,
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
  },
  [
    "mind",
    "write_binding_id",
    "source_kind",
    "display_filename",
    "expected_size",
    "expected_sha256",
    "idempotency_key",
  ],
);

const CREATE_FILE_UPLOAD_INTENT_OUTPUT_SCHEMA = toolOutputSchema(
  Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "intent_version",
      "upload_url",
      "expires_at",
      "replayed",
    ]),
    properties: Object.freeze({
      intent_version: Object.freeze({ const: 1 }),
      upload_url: Object.freeze({
        type: "string",
        format: "uri",
        maxLength: 4_096,
      }),
      expires_at: Object.freeze({ type: "string", format: "date-time" }),
      replayed: Object.freeze({ type: "boolean" }),
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
      maximum: 268_435_456,
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
    claimed_media_type: FILE_INGRESS_MEDIA_HINT_SCHEMA,
    media_type: FILE_INGRESS_MEDIA_TYPE_SCHEMA,
    sha256: SHA256_SCHEMA,
    size: Object.freeze({ type: "integer", minimum: 0, maximum: 268_435_456 }),
    idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
    expected_size: Object.freeze({
      type: "integer",
      minimum: 0,
      maximum: 268_435_456,
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
      "Read only the hosted service's deployed ingress adapters, binding requirements and limits. This response does not report installed client companions or promise that a specific local path is readable; those require fresh client inventory and local admission. An unavailable source has no implicit base64, URL, local-path or cross-source fallback.",
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
    name: "create_file_upload_intent",
    title: "Create a one-use companion upload intent",
    description:
      "Create or exactly replay one versioned 10-minute same-origin upload capability for one verified local or workspace-generated regular-file snapshot. The exact active writable Mind binding and current OAuth grant are rechecked server-side. Return only the capability URL to the trusted companion; never provide a local path, bearer, provider locator, arbitrary URL or base64 bytes.",
    inputSchema: CREATE_FILE_UPLOAD_INTENT_INPUT_SCHEMA,
    outputSchema: CREATE_FILE_UPLOAD_INTENT_OUTPUT_SCHEMA,
    securitySchemes: WRITE_SECURITY_SCHEMES,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
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

export const CANONICAL_DEFINITION_BY_NAME: ReadonlyMap<
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
export const RESOURCE_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

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

export function isRootIndexResourceUri(value: unknown): value is string {
  return parseMcpResourceUri(value)?.kind === "index";
}
