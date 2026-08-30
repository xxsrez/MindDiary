import {
  MAX_JSON_BYTES,
  MAX_IMPORT_BATCH_BODY_BYTES,
  MAX_IMPORT_BATCH_BYTES,
  ENCODER,
} from "./product-http-request-helpers.js";

export async function readInput(
  request: Request,
  maxBytes = MAX_JSON_BYTES,
): Promise<Readonly<Record<string, unknown>>> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    return Object.freeze(query);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new TypeError("request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new TypeError("request body is too large");
  }
  if (text.length === 0) return Object.freeze({});
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

export async function readImportBatchInput(
  request: Request,
): Promise<Readonly<Record<string, unknown>>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BATCH_BODY_BYTES) {
    throw new TypeError("import batch body is too large");
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return readInput(request);
  }
  const reader = request.body?.getReader();
  if (reader === undefined) throw new TypeError("import batch body is missing");
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bodyBytes += next.value.byteLength;
    if (bodyBytes > MAX_IMPORT_BATCH_BODY_BYTES) {
      await reader.cancel();
      throw new TypeError("import batch body is too large");
    }
    chunks.push(next.value);
  }
  const boundedBody = new Uint8Array(bodyBytes);
  let offset = 0;
  for (const chunk of chunks) {
    boundedBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body: boundedBody,
  });
  const form = await boundedRequest.formData();
  const manifestValue = form.get("manifest");
  if (typeof manifestValue !== "string" || ENCODER.encode(manifestValue).byteLength > MAX_JSON_BYTES) {
    throw new TypeError("import batch manifest is invalid");
  }
  const manifest: unknown = JSON.parse(manifestValue);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new TypeError("import batch manifest is invalid");
  }
  const source = manifest as Record<string, unknown>;
  if (!Array.isArray(source.files) || source.files.length < 1 || source.files.length > 256) {
    throw new TypeError("import batch manifest is invalid");
  }
  let totalBytes = 0;
  const files = [];
  for (const descriptor of source.files) {
    if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
      throw new TypeError("import batch descriptor is invalid");
    }
    const record = descriptor as Record<string, unknown>;
    if (typeof record.field !== "string" || !/^file_[0-9]{1,3}$/u.test(record.field)) {
      throw new TypeError("import batch descriptor is invalid");
    }
    const value = form.get(record.field);
    if (
      value === null || typeof value === "string" ||
      typeof (value as Blob).arrayBuffer !== "function"
    ) throw new TypeError("import batch file is missing");
    const bytes = new Uint8Array(await (value as Blob).arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_IMPORT_BATCH_BYTES) throw new TypeError("import batch is too large");
    files.push(Object.freeze({
      path: record.path,
      sha256: record.sha256,
      size: record.size,
      bytes,
    }));
  }
  return Object.freeze({
    expected_version: source.expected_version,
    files: Object.freeze(files),
  });
}

function segment(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && !decoded.includes("/") && !decoded.includes("\\")
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function apiOperation(method: string, pathname: string): {
  readonly operation: string;
  readonly path: Readonly<Record<string, string>>;
} | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v1") return null;
  const tail = parts.slice(2);
  const one = segment(tail[0]);
  const two = segment(tail[1]);
  const three = segment(tail[2]);
  const four = segment(tail[3]);
  if (method === "GET" && one === "session" && tail.length === 1) return { operation: "get_session", path: {} };
  if (
    method === "GET" && one === "internal" && two === "operators" &&
    three === "users" && tail.length === 3
  ) return { operation: "list_service_operator_principals", path: {} };
  if (one === "account" && tail.length === 1) {
    if (method === "POST") return { operation: "bootstrap_account", path: {} };
    if (method === "PATCH") return { operation: "rename_account", path: {} };
    if (method === "DELETE") return { operation: "delete_account", path: {} };
  }
  if (method === "GET" && one === "account" && two === "deletion-impact" && tail.length === 2) return { operation: "get_account_deletion_impact", path: {} };
  if (one === "minds" && tail.length === 1) {
    if (method === "GET") return { operation: "list_minds", path: {} };
    if (method === "POST") return { operation: "create_space_with_owner", path: {} };
  }
  if (method === "GET" && one === "mind-usage" && tail.length === 1) {
    return { operation: "get_mind_usage", path: {} };
  }
  if (method === "GET" && one === "public-minds" && tail.length === 1) return { operation: "list_public_minds", path: {} };
  if (one === "minds" && two !== null) {
    const path = { mind_ref: two };
    if (tail.length === 2 && method === "GET") return { operation: "get_mind_info", path };
    if (three === "usage" && tail.length === 3 && method === "GET") {
      return { operation: "get_mind_usage", path };
    }
    if (three === "usage" && tail.length === 3 && method === "PUT") {
      return { operation: "set_mind_usage", path };
    }
    if (
      two === "me" && three === "description" && tail.length === 3 &&
      method === "PATCH"
    ) return { operation: "update_personal_mind_description", path };
    if (three === "capacity" && tail.length === 3 && method === "GET") return { operation: "get_capacity_usage", path };
    if (three === "exports" && tail.length === 3 && method === "POST") return { operation: "start_export", path };
    if (three === "markdown-import-plans" && tail.length === 3 && method === "POST") return { operation: "plan_markdown_import", path };
    if (three === "markdown-imports" && tail.length === 3 && method === "POST") return { operation: "start_markdown_import", path };
    if (tail.length === 2 && method === "PATCH") return { operation: "rename_space", path };
    if (tail.length === 2 && method === "DELETE") return { operation: "delete_space", path };
    if (three === "deletion-impact" && tail.length === 3 && method === "GET") return { operation: "get_mind_deletion_impact", path };
    if (three === "visibility" && tail.length === 3 && method === "PUT") return { operation: "change_visibility", path };
    if (three === "members" && tail.length === 3 && method === "GET") return { operation: "list_members", path };
    if (three === "members" && four !== null && tail.length === 4) {
      const memberPath = { ...path, member_id: four };
      if (method === "PATCH") return { operation: "change_membership_role", path: memberPath };
      if (method === "DELETE") return { operation: "revoke_membership", path: memberPath };
    }
    if (three === "leave" && tail.length === 3 && method === "POST") return { operation: "leave_space", path };
    if (three === "ownership-transfer" && tail.length === 3 && method === "POST") return { operation: "transfer_ownership", path };
    if (three === "invitations" && tail.length === 3 && method === "POST") return { operation: "create_invitation", path };
  }
  if (one === "markdown-imports" && two !== null) {
    const path = { import_id: two };
    if (tail.length === 2 && method === "GET") return { operation: "get_markdown_import", path };
    if (tail.length === 2 && method === "DELETE") return { operation: "cancel_markdown_import", path };
    if (three === "batches" && four !== null && tail.length === 4 && method === "PUT") {
      const checkpoint = Number(four);
      if (!Number.isSafeInteger(checkpoint) || checkpoint < 1) return null;
      return { operation: "stage_markdown_import_batch", path: { ...path, checkpoint: String(checkpoint) } };
    }
    if (three === "validate" && tail.length === 3 && method === "POST") return { operation: "validate_markdown_import", path };
    if (three === "commit" && tail.length === 3 && method === "POST") return { operation: "commit_markdown_import", path };
  }
  if (one === "export-jobs" && two !== null && tail.length === 2 && method === "GET") {
    return { operation: "get_export_status", path: { job_id: two } };
  }
  if (one === "invitations") {
    if (tail.length === 1 && method === "GET") return { operation: "list_invitations", path: {} };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "cancel_invitation", path: { invitation_id: two } };
    if (two !== null && three === "accept" && tail.length === 3 && method === "POST") return { operation: "accept_invitation", path: { invitation_id: two } };
    if (two !== null && three === "reject" && tail.length === 3 && method === "POST") return { operation: "reject_invitation", path: { invitation_id: two } };
    if (two !== null && three === "reissue" && tail.length === 3 && method === "POST") return { operation: "reissue_invitation", path: { invitation_id: two } };
  }
  if (
    one === "invitations-overview" &&
    tail.length === 1 &&
    method === "GET"
  ) return { operation: "get_invitations_overview", path: {} };
  if (one === "mcp-tokens") {
    if (tail.length === 1 && method === "GET") return { operation: "list_personal_token_page", path: {} };
    if (tail.length === 1 && method === "POST") return { operation: "issue_mcp_token", path: {} };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "revoke_personal_token", path: { personal_token_ref: two } };
  }
  if (one === "connections") {
    if (tail.length === 1 && method === "GET") return { operation: "list_connections", path: {} };
    if (two !== null && tail.length === 2 && method === "GET") return { operation: "get_connection", path: { connection_ref: two } };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "revoke_connection", path: { connection_ref: two } };
  }
  return null;
}

export function failureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
  ) return error.code;
  return "operation_failed";
}

export function applicationErrorStatus(code: string): number {
  if (code === "authentication_required") return 401;
  if (code === "operation_removed") return 400;
  if (code === "rate_limited") return 429;
  if (code === "search_index_unavailable") return 503;
  if (code === "binding_state_unavailable") return 503;
  if (code === "mind_usage_unavailable") return 503;
  if (code === "capacity_accounting_untrusted") return 503;
  if (
    code === "okf_validation_failed" ||
    code === "export_profile_required" ||
    code === "import_validation_failed" ||
    code === "import_file_limit_exceeded" ||
    code === "import_byte_limit_exceeded" ||
    code === "capacity_soft_limit" ||
    code === "capacity_hard_limit" ||
    code === "capacity_fairness_limit" ||
    code === "ownership_target_capacity_exceeded"
  ) return 422;
  if (
    code === "handle_unavailable" ||
    code === "usage_conflict" ||
    code === "write_step_up_required" ||
    code === "deletion_impact_changed" ||
    code === "deletion_impact_expired" ||
    code === "import_plan_expired" ||
    code === "import_session_expired" ||
    code === "ownership_state_changed" ||
    code.includes("conflict")
  ) return 409;
  if (
    code === "description_required" ||
    code === "description_required_for_write" ||
    code === "usage_not_allowed"
  ) return 422;
  if (code.includes("not_found") || code.endsWith("_unavailable")) return 404;
  if (code.startsWith("invalid_")) return 400;
  return 403;
}

/** Authenticated web/control handler. It deliberately never reads Bearer auth. */
