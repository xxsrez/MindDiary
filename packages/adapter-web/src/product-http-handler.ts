import {
  renderAuthenticatedOnboardingDocument,
} from "./onboarding.js";

import {
  normalizeAccountDeletionImpact,
} from "./account-deletion.js";

import {
  type PublicMindCatalogItem,
} from "./visibility-catalog.js";

import {
  ProductWebActivityCoordinator,
  type ProductWebActivityDeferrer,
} from "./product-web-activity.js";

import {
  type ProductSitesIdentityResolution,
  type ProductWebHttpHandlerDependencies,
} from "./product-http-contracts.js";

import {
  MUTATION_METHODS,
  PRODUCT_UI_ROUTES,
  RESERVED_UI_HANDLES,
  SITES_SIGN_IN_PATH,
  MAX_IMPORT_PLAN_BODY_BYTES,
  SAFE_HEADERS,
  canonicalOrigin,
  json,
  errorResponse,
  safeRequestId,
  safeBenchmarkCorrelationId,
  recordWebPerformance,
  camelInput,
  snakeOutput,
  html,
  record,
  requiredString,
  publicUiMind,
  safeInvitationOverview,
  safeConnectionListItem,
  safeConnectionDetail,
  safePersonalTokenItem,
  strictListQuery,
  strictPublicCatalogQuery,
  safePublicCatalogCursor,
} from "./product-http-request-helpers.js";

import {
  mutateMindUsage,
  readMindUsageProjection,
} from "./mind-usage.js";

import {
  createProductUiStaticAssetResponse,
} from "./product-http-static-assets.js";

import {
  productUiDocument,
} from "./product-http-document.js";

import {
  readInput,
  readImportBatchInput,
  apiOperation,
  failureCode,
  applicationErrorStatus,
} from "./product-http-routing.js";

export function createProductWebHttpHandler(
  dependencies: ProductWebHttpHandlerDependencies,
): (
  request: Request,
  deferActivity?: ProductWebActivityDeferrer,
) => Promise<Response | null> {
  const origin = canonicalOrigin(dependencies.applicationOrigin);
  // A hosted waitUntil contributes to the Worker lifetime observed by Sites.
  // Keep the default activity write deferred, but never hold navigation open
  // purely to debounce observational metadata. Callers that value write
  // coalescing over latency can still opt into a bounded window explicitly.
  const activityCoalesceWindowMs = dependencies.activityCoalesceWindowMs ?? 0;
  if (
    !Number.isSafeInteger(activityCoalesceWindowMs) ||
    activityCoalesceWindowMs < 0 || activityCoalesceWindowMs > 2_000
  ) throw new TypeError("activityCoalesceWindowMs must be an integer from 0 to 2000");
  const activity = new ProductWebActivityCoordinator(
    dependencies.activity,
    activityCoalesceWindowMs,
  );
  return async (request, deferActivity) => {
    const url = new URL(request.url);
    const staticResponse = createProductUiStaticAssetResponse(request);
    if (staticResponse !== null) return staticResponse;
    const isApi = url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/");
    const isOperatorPath =
      url.pathname === "/internal/operators/users" ||
      url.pathname === "/api/v1/internal/operators/users";
    const detailMatch = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(url.pathname);
    const connectionUiDetail = /^\/settings\/connections\/[^/]+$/u.test(url.pathname);
    const isUi = PRODUCT_UI_ROUTES.has(url.pathname) || (
      detailMatch !== null && !RESERVED_UI_HANDLES.has(detailMatch[1]!)
    ) || connectionUiDetail;
    if (!isApi && !isUi) return null;
    const homeStartedAt = url.pathname === "/" &&
      isUi &&
      (request.method === "GET" || request.method === "HEAD")
      ? performance.now()
      : null;
    const performanceCorrelationId = homeStartedAt === null
      ? null
      : safeBenchmarkCorrelationId(request);
    const identityStartedAt = homeStartedAt === null ? null : performance.now();

    let identity: ProductSitesIdentityResolution;
    try {
      identity = await dependencies.resolveIdentity(request);
    } catch {
      identity = { kind: "unavailable" };
    }
    const requestId = safeRequestId(identity);
    if (
      identityStartedAt !== null &&
      identity.kind === "authenticated"
    ) {
      recordWebPerformance(dependencies.performance, {
        requestId,
        benchmarkCorrelationId: performanceCorrelationId,
        operation: "stage_authentication",
        durationMs: Math.max(0, performance.now() - identityStartedAt),
        outcome: "success",
      });
    }
    if (identity.kind === "denied") {
      if (isOperatorPath) {
        return errorResponse(404, "not_found", requestId);
      }
      if (isUi && (request.method === "GET" || request.method === "HEAD")) {
        const response = html(renderAuthenticatedOnboardingDocument({
          kind: "anonymous",
          authEntryPath: SITES_SIGN_IN_PATH,
        }));
        return request.method === "HEAD" ? new Response(null, response) : response;
      }
      return errorResponse(401, "authentication_required", requestId);
    }
    if (identity.kind === "unavailable") return errorResponse(503, "identity_binding_unavailable", requestId, true);
    if (
      isOperatorPath &&
      identity.kind !== "authenticated"
    ) return errorResponse(404, "not_found", requestId);

    if (
      url.pathname === "/settings/mcp" &&
      identity.kind === "authenticated" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return new Response(null, {
        status: 308,
        headers: {
          ...SAFE_HEADERS,
          location: "/settings/developer/mcp",
          "x-mind-diary-request-id": requestId,
        },
      });
    }

    if (isUi) {
      if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(405, "method_not_allowed", requestId);
      const listQuery = url.pathname === "/settings/connections"
        ? strictListQuery(url, false)
        : url.pathname === "/settings/developer/mcp"
          ? strictListQuery(url, true)
          : Object.freeze({});
      if (listQuery === null) return errorResponse(400, "invalid_request", requestId);
      const uiQuery: Record<string, string> = {};
      url.searchParams.forEach((value, key) => { uiQuery[key] = value; });
      const applicationStartedAt = homeStartedAt !== null && identity.kind === "authenticated"
        ? performance.now()
        : null;
      let response: Response;
      try {
        response = html(await productUiDocument({
          pathname: url.pathname,
          siteOrigin: url.origin,
          identity,
          csrfToken: await dependencies.csrf.issue(identity.actor),
          control: dependencies.control,
          ...(dependencies.oauthConnections === undefined
            ? {}
            : { oauthConnections: dependencies.oauthConnections }),
          ...(dependencies.personalTokens === undefined
            ? {}
            : { personalTokens: dependencies.personalTokens }),
          query: Object.freeze(uiQuery),
          listQuery,
        }));
      } catch (error) {
        const code = failureCode(error);
        response = code === "connection_not_found"
          ? errorResponse(404, "connection_not_found", requestId)
          : url.pathname === "/internal/operators/users"
          ? errorResponse(applicationErrorStatus(code), code, requestId)
          : errorResponse(503, "operation_failed", requestId, true);
      }
      if (response.ok && identity.kind === "authenticated") {
        await activity.record(
          deferActivity,
          identity.actor,
          "page",
        );
      }
      const finalResponse = request.method === "HEAD"
        ? new Response(null, response)
        : response;
      finalResponse.headers.set("x-mind-diary-request-id", requestId);
      if (performanceCorrelationId !== null) {
        finalResponse.headers.set(
          "x-mind-diary-performance-correlation-id",
          performanceCorrelationId,
        );
      }
      if (
        homeStartedAt !== null &&
        applicationStartedAt !== null &&
        identity.kind === "authenticated"
      ) {
        const outcome = response.ok ? "success" as const : "failure" as const;
        const completedAt = performance.now();
        recordWebPerformance(dependencies.performance, {
          requestId,
          benchmarkCorrelationId: performanceCorrelationId,
          operation: "stage_application",
          durationMs: Math.max(0, completedAt - applicationStartedAt),
          outcome,
        });
        const totalDurationMs = Math.max(0, completedAt - homeStartedAt);
        for (const operation of ["stage_total", "home"] as const) {
          recordWebPerformance(dependencies.performance, {
            requestId,
            benchmarkCorrelationId: performanceCorrelationId,
            operation,
            durationMs: totalDurationMs,
            outcome,
          });
        }
      }
      return finalResponse;
    }

    const matched = apiOperation(request.method, url.pathname);
    if (matched === null) return errorResponse(404, "not_found", requestId);
    if (
      identity.kind === "registration_required" &&
      !(matched.operation === "bootstrap_account" && request.method === "POST")
    ) {
      return errorResponse(409, "registration_required", requestId);
    }
    if (MUTATION_METHODS.has(request.method)) {
      if (url.origin !== origin || request.headers.get("origin") !== origin) {
        return errorResponse(403, "forbidden", requestId);
      }
      const csrf = request.headers.get("x-csrf-token");
      if (
        csrf === null ||
        csrf.length === 0 ||
        csrf.length > 512 ||
        !(await dependencies.csrf.verify(identity.actor, csrf))
      ) {
        return errorResponse(403, "forbidden", requestId);
      }
    }
    let input: Readonly<Record<string, unknown>>;
    try {
      const raw = await (matched.operation === "stage_markdown_import_batch"
        ? readImportBatchInput(request)
        : matched.operation === "plan_markdown_import"
          ? readInput(request, MAX_IMPORT_PLAN_BODY_BYTES)
          : readInput(request));
      if (
        matched.operation === "start_export" &&
        ("idempotency_key" in raw || "idempotencyKey" in raw)
      ) {
        throw new TypeError("export idempotency belongs to the request header");
      }
      const parsed = camelInput(raw);
      const idempotencyKey = request.headers.get("idempotency-key");
      input = Object.freeze({
        ...parsed,
        ...(idempotencyKey === null || "idempotencyKey" in parsed
          ? {}
          : { idempotencyKey }),
        ...matched.path,
      });
    } catch {
      return errorResponse(400, "invalid_request", requestId);
    }
    try {
      if (
        matched.operation === "get_mind_usage" ||
        matched.operation === "set_mind_usage"
      ) {
        if (
          identity.kind !== "authenticated" ||
          dependencies.mindUsage === undefined
        ) return errorResponse(503, "mind_usage_unavailable", requestId, true);
        if (matched.operation === "get_mind_usage") {
          const allowed = new Set(["mind_ref"]);
          if (Object.keys(input).some((key) => !allowed.has(key))) {
            return errorResponse(400, "invalid_request", requestId);
          }
          const mindRef = typeof input.mind_ref === "string"
            ? input.mind_ref === "me" ? "/me" : `/${input.mind_ref}`
            : undefined;
          const projection = await readMindUsageProjection({
            actor: identity.actor,
            control: dependencies.control,
            mindUsage: dependencies.mindUsage,
            ...(mindRef === undefined ? {} : { mindRef }),
          });
          await activity.record(deferActivity, identity.actor, "control_read");
          return json(200, { ok: true, data: snakeOutput(projection) });
        }
        const result = await mutateMindUsage({
          actor: identity.actor,
          control: dependencies.control,
          mindUsage: dependencies.mindUsage,
          request: input,
        });
        await activity.record(deferActivity, identity.actor, "control_write");
        return json(200, { ok: true, data: snakeOutput(result) });
      }
      if (
        matched.operation === "list_connections" ||
        matched.operation === "get_connection" ||
        matched.operation === "revoke_connection"
      ) {
        if (
          identity.kind !== "authenticated" ||
          dependencies.oauthConnections === undefined
        ) return errorResponse(404, "connection_not_found", requestId);
        if (matched.operation === "list_connections") {
          const query = strictListQuery(url, false);
          if (query === null) return errorResponse(400, "invalid_request", requestId);
          const page = await dependencies.oauthConnections.listPage(
            identity.actor.principalId,
            query,
          );
          const items = page.items.map((connection) =>
            safeConnectionListItem(connection));
          await activity.record(
            deferActivity,
            identity.actor,
            "control_read",
          );
          return json(200, { ok: true, data: snakeOutput({ items, nextCursor: page.nextCursor }) });
        }
        const connectionRef = String(matched.path.connection_ref ?? "");
        const connection = await dependencies.oauthConnections.read(
          identity.actor.principalId,
          connectionRef,
        );
        if (connection === null) return errorResponse(404, "connection_not_found", requestId);
        if (matched.operation === "revoke_connection") {
          if (requiredString(input.idempotencyKey) === null) {
            return errorResponse(400, "invalid_request", requestId);
          }
          if (!(await dependencies.oauthConnections.revoke(identity.actor.principalId, connectionRef))) {
            return errorResponse(404, "connection_not_found", requestId);
          }
          await activity.record(
            deferActivity,
            identity.actor,
            "control_write",
          );
          return json(200, { ok: true, data: { revoked: true } });
        }
        const fresh = connection;
        if (fresh === null) return errorResponse(404, "connection_not_found", requestId);
        const detail = safeConnectionDetail(fresh);
        if (detail === null) return errorResponse(404, "connection_not_found", requestId);
        await activity.record(
          deferActivity,
          identity.actor,
          "control_read",
        );
        return json(200, {
          ok: true,
          data: snakeOutput(detail),
        });
      }
      if (
        matched.operation === "list_personal_token_page"
      ) {
        if (
          identity.kind !== "authenticated" ||
          dependencies.personalTokens === undefined
        ) return errorResponse(404, "personal_token_not_found", requestId);
        if (matched.operation === "list_personal_token_page") {
          const query = strictListQuery(url, true);
          if (query === null) return errorResponse(400, "invalid_request", requestId);
          const state = query.state ?? "active";
          const page = await dependencies.personalTokens.listPage(identity.actor, { ...query, state });
          const items = page.items.map(safePersonalTokenItem);
          await activity.record(
            deferActivity,
            identity.actor,
            "control_read",
          );
          return json(200, { ok: true, data: snakeOutput({ items, nextCursor: page.nextCursor }) });
        }
      }
      if (matched.operation === "revoke_personal_token") {
        if (identity.kind !== "authenticated") {
          return errorResponse(404, "personal_token_not_found", requestId);
        }
        if (requiredString(input.idempotencyKey) === null) {
          return errorResponse(400, "invalid_request", requestId);
        }
        try {
          const data = await dependencies.control.execute({
            operation: matched.operation,
            actor: identity.actor,
            input,
          });
          await activity.record(
            deferActivity,
            identity.actor,
            "control_write",
          );
          return json(200, { ok: true, data: snakeOutput(data) });
        } catch (error) {
          const code = failureCode(error);
          if (code === "token_not_found" || code === "invalid_token_id") {
            return errorResponse(404, "personal_token_not_found", requestId);
          }
          throw error;
        }
      }
      if (matched.operation === "get_account_deletion_impact") {
        const impact = normalizeAccountDeletionImpact(await dependencies.control.execute({
          operation: matched.operation,
          actor: identity.actor,
          input,
        }));
        if (impact === null) throw new TypeError("safe account deletion impact is unavailable");
        if (identity.kind === "authenticated") {
          await activity.record(deferActivity, identity.actor, "control_read");
        }
        return json(200, { ok: true, data: snakeOutput(impact) });
      }
      if (matched.operation === "list_public_minds") {
        const query = strictPublicCatalogQuery(url);
        if (query === null) return errorResponse(400, "invalid_request", requestId);
        const source = record(await dependencies.control.execute({
          operation: matched.operation,
          actor: identity.actor,
          input: query,
        }));
        if (source === null || !Array.isArray(source.minds)) {
          throw new TypeError("safe Public Mind catalog is unavailable");
        }
        const nextCursor = safePublicCatalogCursor(source.nextCursor);
        if (nextCursor === undefined) {
          throw new TypeError("safe Public Mind catalog cursor is unavailable");
        }
        const minds = Object.freeze(source.minds
          .map(publicUiMind)
          .filter((mind): mind is PublicMindCatalogItem => mind !== null));
        if (identity.kind === "authenticated") {
          await activity.record(deferActivity, identity.actor, "control_read");
        }
        return json(200, {
          ok: true,
          data: snakeOutput({ minds }),
          next_cursor: nextCursor,
        });
      }
      if (matched.operation === "get_invitations_overview") {
        const overview = safeInvitationOverview(await dependencies.control.execute({
          operation: matched.operation,
          actor: identity.actor,
          input,
        }));
        if (overview === null) throw new TypeError("safe invitation overview is unavailable");
        if (identity.kind === "authenticated") {
          await activity.record(deferActivity, identity.actor, "control_read");
        }
        return json(200, { ok: true, data: snakeOutput(overview) });
      }
      if (matched.operation === "update_personal_mind_description") {
        const source = record(await dependencies.control.execute({
          operation: matched.operation,
          actor: identity.actor,
          input,
        }));
        const personalMind = record(source?.personalMind);
        const name = requiredString(personalMind?.name);
        const description = personalMind?.description;
        const metadataVersion = personalMind?.metadataVersion;
        if (
          source === null || personalMind?.route !== "/me" || name === null ||
          !(description === null || typeof description === "string") ||
          !Number.isSafeInteger(metadataVersion) || Number(metadataVersion) < 1 ||
          !(source?.replayed === undefined || typeof source.replayed === "boolean")
        ) throw new TypeError("safe Personal Mind description read-back is unavailable");
        if (identity.kind === "authenticated") {
          await activity.record(deferActivity, identity.actor, "control_write");
        }
        return json(200, {
          ok: true,
          data: snakeOutput(Object.freeze({
            personalMind: Object.freeze({
              route: "/me" as const,
              name,
              description,
              metadataVersion: Number(metadataVersion),
            }),
            ...(source.replayed === undefined ? {} : { replayed: source.replayed }),
          })),
        });
      }
      const data = await dependencies.control.execute({
        operation: matched.operation,
        actor: identity.actor,
        input,
      });
      if (identity.kind === "authenticated") {
        await activity.record(
          deferActivity,
          identity.actor,
          MUTATION_METHODS.has(request.method) ? "control_write" : "control_read",
        );
      }
      return json(
        matched.operation === "start_export" ? 202 : 200,
        { ok: true, data: snakeOutput(data) },
      );
    } catch (error) {
      const code = failureCode(error);
      return errorResponse(applicationErrorStatus(code), code, requestId);
    }
  };
}
