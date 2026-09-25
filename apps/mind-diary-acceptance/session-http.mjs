import { ACCEPTANCE_ORIGIN } from "./runtime-target.mjs";

const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
const projection = (run) => ({ run_id: run.id, state: run.state, profile: run.profile, expires_at: run.expires_at,
  actors: run.actors.map((a) => ({ actor_id: a.id, ordinal: a.ordinal, subject: a.subject, registered: a.principal_id !== null })) });

async function body(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error("invalid_request"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
    return value;
  } catch { throw new Error("invalid_request"); }
  finally { reader.releaseLock(); }
}

async function controller(request, expected) {
  const actual = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (typeof expected !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(expected) || !actual || actual.length > 256) return false;
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function handleAcceptanceSession(request, store, controllerKey, cleanup, inventory, recoverOAuth, backupSchemaProbe, objectInventory, recoverRunOrphans, seedValidationFixture) {
  const { pathname, origin } = new URL(request.url);
  if (!pathname.startsWith("/_acceptance/")) return null;
  if (origin !== ACCEPTANCE_ORIGIN) return json({ error: "wrong_audience" }, 403);
  const callerOrigin = request.headers.get("origin");
  if (callerOrigin && callerOrigin !== origin) return json({ error: "origin_denied" }, 403);
  try {
    if (pathname === "/_acceptance/session" && request.method === "POST") {
      if (callerOrigin !== origin) return json({ error: "origin_required" }, 403);
      const value = await body(request);
      if (Object.keys(value).length !== 1 || typeof value.code !== "string") return json({ error: "invalid_request" }, 400);
      const session = await store.exchange(value.code, origin);
      return json({ status: "authenticated" }, 200, { "set-cookie": session.cookie });
    }
    if (!(await controller(request, controllerKey))) return json({ error: "controller_required" }, 401);
    if (pathname === "/_acceptance/backup-schema-probe" && request.method === "GET" && backupSchemaProbe) {
      return json(await backupSchemaProbe());
    }
    if (pathname === "/_acceptance/object-inventory" && request.method === "GET" && objectInventory) {
      const parameters = new URL(request.url).searchParams;
      if ([...parameters.keys()].some((key) => key !== "cursor") || parameters.getAll("cursor").length > 1) {
        return json({ error: "invalid_request" }, 400);
      }
      const cursor = parameters.get("cursor");
      if (cursor !== null && (cursor.length === 0 || cursor.length > 4096)) {
        return json({ error: "invalid_request" }, 400);
      }
      return json(await objectInventory(cursor));
    }
    const externalRoute = /^\/_acceptance\/runs\/([a-f0-9-]+)\/external-mcp$/.exec(pathname);
    if (externalRoute) {
      if (request.method === "POST") return json(await store.enableExternalMcp(externalRoute[1], await body(request)));
      if (request.method === "DELETE") return json(await store.revokeExternalMcp(externalRoute[1]));
      return json({ error: "not_found" }, 404);
    }
    if (pathname === "/_acceptance/inventory" && request.method === "GET" && inventory) return json(await inventory());
    if (pathname === "/_acceptance/recover" && request.method === "POST" && cleanup) {
      if (Object.keys(await body(request)).length !== 0) return json({ error: "invalid_request" }, 400);
      await store.ready();
      const due = await store.statement("SELECT id FROM md_acceptance_runs WHERE state != 'cleaned' AND (state != 'active' OR expires_at <= ?) ORDER BY created_at LIMIT 2", store.now()).all();
      const results = [];
      for (const run of due.results) {
        try { results.push(await cleanup(run.id)); }
        catch { results.push({ run_id: run.id, state: "cleanup_pending" }); }
      }
      const oauth = recoverOAuth ? await recoverOAuth() : undefined;
      return json({ results, ...(oauth ? { oauth } : {}) }, results.some((r) => r.state !== "cleaned") ? 503 : 200);
    }
    const cleanupRoute = /^\/_acceptance\/runs\/([a-f0-9-]+)\/cleanup$/.exec(pathname);
    if (cleanupRoute && request.method === "POST" && cleanup) {
      if (Object.keys(await body(request)).length !== 0) return json({ error: "invalid_request" }, 400);
      return json(await cleanup(cleanupRoute[1]));
    }
    const orphanRoute = /^\/_acceptance\/runs\/([a-f0-9-]+)\/orphan-cleanup$/.exec(pathname);
    if (orphanRoute && request.method === "POST" && recoverRunOrphans) {
      return json(await recoverRunOrphans(orphanRoute[1], await body(request)));
    }
    const validationRoute = /^\/_acceptance\/runs\/([a-f0-9-]+)\/validation-fixture$/.exec(pathname);
    if (validationRoute && request.method === "POST" && seedValidationFixture) {
      return json(await seedValidationFixture(validationRoute[1], await body(request)));
    }
    if (pathname === "/_acceptance/runs" && request.method === "POST") {
      return json(projection(await store.create(await body(request), request.headers.get("idempotency-key"))));
    }
    const route = /^\/_acceptance\/runs\/([a-f0-9-]+)(\/exchanges)?$/.exec(pathname);
    if (!route) return json({ error: "not_found" }, 404);
    if (!route[2] && request.method === "GET") return json(projection(await store.run(route[1])));
    if (!route[2] && request.method === "DELETE") return json({ ...projection(await store.revoke(route[1])), cleanup_required: true });
    if (route[2] && request.method === "POST") {
      const value = await body(request);
      if (Object.keys(value).length !== 1 || typeof value.actor_id !== "string") return json({ error: "invalid_request" }, 400);
      return json(await store.mintExchange(route[1], value.actor_id));
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "exchange_denied" ? 401 : code === "external_mcp_denied" ? 403 : code === "run_not_found" ? 404
      : ["run_capacity_reached", "idempotency_conflict"].includes(code) ? 409
      : ["invalid_run", "invalid_actor", "invalid_run_request", "invalid_idempotency_key", "invalid_request"].includes(code) ? 400 : 503;
    const controllerDiagnostic = pathname.endsWith("/orphan-cleanup") && code.startsWith("orphan_") ||
      pathname.endsWith("/validation-fixture") && code.startsWith("validation_fixture_");
    return json({ error: status === 503 && !controllerDiagnostic ? "acceptance_unavailable" : code }, status);
  }
}
