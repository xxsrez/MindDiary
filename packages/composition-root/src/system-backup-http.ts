import {
  SitesSystemBackupService,
  SystemBackupFailure,
  type SystemBackupCheckpoint,
} from "./system-backup-sites.js";

const PREFIX = "/api/v1/internal/system-backup";
const SAFE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SAFE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function failure(code: string, status: number): Response {
  return json({ code }, status);
}

function baseCheckpoint(value: unknown): SystemBackupCheckpoint | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SystemBackupFailure("invalid_base_checkpoint");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.origin_id !== "string" ||
    !Number.isSafeInteger(item.generation) ||
    !Number.isSafeInteger(item.sequence) ||
    typeof item.digest !== "string" ||
    typeof item.session_id !== "string" ||
    typeof item.captured_at !== "string" ||
    typeof item.schema_digest !== "string") {
    throw new SystemBackupFailure("invalid_base_checkpoint");
  }
  return item as unknown as SystemBackupCheckpoint;
}

function exactInteger(value: string | null, fallback?: number): number {
  if (value === null) {
    if (fallback !== undefined) return fallback;
    throw new SystemBackupFailure("invalid_range");
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new SystemBackupFailure("invalid_range");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new SystemBackupFailure("invalid_range");
  return parsed;
}

function authorized(request: Request, key: Uint8Array): boolean {
  const value = request.headers.get("authorization");
  const match = /^Bearer mdb_v1_([A-Za-z0-9_-]{43})$/u.exec(value ?? "");
  if (match === null) return false;
  let received: Uint8Array;
  try {
    received = Uint8Array.from(
      atob(match[1]!.replaceAll("-", "+").replaceAll("_", "/") + "="),
      (character) => character.charCodeAt(0),
    );
  } catch { return false; }
  if (received.byteLength !== 32 || key.byteLength !== 32) return false;
  let mismatch = 0;
  for (let index = 0; index < 32; index += 1) mismatch |= received[index]! ^ key[index]!;
  received.fill(0);
  return mismatch === 0;
}

/** A separate read-only credential, never a Sites principal or MCP token. */
export function createSystemBackupHttpHandler(options: Readonly<{
  service: SitesSystemBackupService | null;
  operatorKey: Uint8Array | undefined;
  publicOrigin: string;
}>): (request: Request) => Promise<Response> {
  return async (request) => {
    if (options.service === null || options.operatorKey === undefined ||
      !authorized(request, options.operatorKey)) {
      return failure("not_found", 404);
    }
    const url = new URL(request.url);
    if (url.origin !== options.publicOrigin || !url.pathname.startsWith(PREFIX)) {
      return failure("not_found", 404);
    }
    const suffix = url.pathname.slice(PREFIX.length);
    try {
      if (suffix === "/sessions" && request.method === "POST") {
        const body = await request.text();
        if (new TextEncoder().encode(body).byteLength > 2_048) {
          throw new SystemBackupFailure("invalid_request");
        }
        let input: unknown;
        try { input = body === "" ? {} : JSON.parse(body); }
        catch { throw new SystemBackupFailure("invalid_request"); }
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          throw new SystemBackupFailure("invalid_request");
        }
        const source = input as Record<string, unknown>;
        if (Object.keys(source).some((key) =>
          key !== "base_checkpoint" && key !== "request_id") ||
          typeof source.request_id !== "string") {
          throw new SystemBackupFailure("invalid_request");
        }
        return json(await options.service.createSession(
          baseCheckpoint(source.base_checkpoint), source.request_id,
        ), 201);
      }
      const session = /^\/sessions\/([0-9a-f-]{36})$/u.exec(suffix);
      if (session !== null) {
        if (request.method === "GET") return json(await options.service.readSession(session[1]!));
        if (request.method === "DELETE") {
          await options.service.release(session[1]!);
          return new Response(null, { status: 204, headers: SAFE_HEADERS });
        }
      }
      const complete = /^\/sessions\/([0-9a-f-]{36})\/complete$/u.exec(suffix);
      if (complete !== null && request.method === "POST") {
        return json(await options.service.complete(complete[1]!));
      }
      const page = /^\/sessions\/([0-9a-f-]{36})\/pages\/([0-9]+)$/u.exec(suffix);
      if (page !== null && request.method === "GET") {
        const result = await options.service.readPage(page[1]!, exactInteger(page[2]!));
        return new Response(result.payload, {
          status: 200,
          headers: {
            ...SAFE_HEADERS,
            "content-type": "application/json; charset=utf-8",
            "x-md-backup-sha256": result.sha256,
            "x-md-backup-byte-size": String(result.byte_size),
          },
        });
      }
      const inventory = /^\/sessions\/([0-9a-f-]{36})\/inventory$/u.exec(suffix);
      if (inventory !== null && request.method === "GET") {
        return json(await options.service.listInventory(inventory[1]!,
          exactInteger(url.searchParams.get("cursor"), 0),
          exactInteger(url.searchParams.get("limit"), 128)));
      }
      const object = /^\/sessions\/([0-9a-f-]{36})\/objects\/([0-9]+)$/u.exec(suffix);
      if (object !== null && request.method === "GET") {
        const part = await options.service.readPart(object[1]!,
          exactInteger(object[2]!),
          exactInteger(url.searchParams.get("offset")),
          exactInteger(url.searchParams.get("length")));
        return new Response(new Uint8Array(part.bytes).buffer, {
          status: 206,
          headers: {
            ...SAFE_HEADERS,
            "content-type": "application/octet-stream",
            "content-range": `bytes ${part.offset}-${part.offset + part.length - 1}/${part.object_size}`,
            "x-md-backup-part-sha256": part.sha256,
            "x-md-backup-object-sha256": part.object_sha256,
          },
        });
      }
      return failure("not_found", 404);
    } catch (error) {
      if (error instanceof SystemBackupFailure) {
        const status = error.code.startsWith("invalid_") ? 400
          : error.code === "backup_session_not_found" ? 404
          : error.code === "backup_session_inactive" ||
            error.code === "backup_session_building" ||
            error.code === "backup_session_invalidated" ||
            error.code === "backup_target_changed" ? 409 : 503;
        return failure(error.code, status);
      }
      return failure("backup_unavailable", 503);
    }
  };
}
