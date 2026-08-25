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
  type SafeCredentialAccess,
} from "./connections.js";

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
  strictListQuery,
  safeBindingAccessByOwner,
  mutateCredentialAccess,
} from "./product-http-request-helpers.js";

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
  const activityCoalesceWindowMs = dependencies.activityCoalesceWindowMs ?? 1_500;
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
          ...(dependencies.mindBindings === undefined
            ? {}
            : { mindBindings: dependencies.mindBindings }),
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
      const parsed = camelInput(await (matched.operation === "stage_markdown_import_batch"
        ? readImportBatchInput(request)
        : matched.operation === "plan_markdown_import"
          ? readInput(request, MAX_IMPORT_PLAN_BODY_BYTES)
          : readInput(request)));
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
        matched.operation === "list_connections" ||
        matched.operation === "get_connection" ||
        matched.operation === "revoke_connection" ||
        matched.operation === "mutate_connection_access"
      ) {
        if (
          identity.kind !== "authenticated" ||
          dependencies.oauthConnections === undefined ||
          dependencies.mindBindings === undefined
        ) return errorResponse(404, "connection_not_found", requestId);
        if (matched.operation === "list_connections") {
          const query = strictListQuery(url, false);
          if (query === null) return errorResponse(400, "invalid_request", requestId);
          const page = await dependencies.oauthConnections.listPage(
            identity.actor.principalId,
            query,
          );
          const access = await safeBindingAccessByOwner(
            dependencies.control,
            dependencies.mindBindings,
            identity.actor,
            page.items.map((connection) => Object.freeze({
              ownerId: connection.bindingOwnerId,
              scopes: connection.scopes,
              state: "active" as const,
            })),
          );
          const items = page.items.map((connection) =>
            safeConnectionListItem(connection, access.get(connection.bindingOwnerId)!));
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
        const mutation = matched.operation === "mutate_connection_access"
          ? await mutateCredentialAccess({
            actor: identity.actor,
            mindBindings: dependencies.mindBindings,
            control: dependencies.control,
            ownerId: connection.bindingOwnerId,
            scopes: connection.scopes,
            request: input,
            presentationKey: "connection_ref",
          })
          : null;
        const fresh = matched.operation === "mutate_connection_access"
          ? await dependencies.oauthConnections.read(identity.actor.principalId, connectionRef)
          : connection;
        if (fresh === null) return errorResponse(404, "connection_not_found", requestId);
        const access = await safeBindingAccessByOwner(
          dependencies.control,
          dependencies.mindBindings,
          identity.actor,
          [Object.freeze({
            ownerId: fresh.bindingOwnerId,
            scopes: fresh.scopes,
            state: "active" as const,
          })],
        );
        const detail = safeConnectionDetail(fresh, access.get(fresh.bindingOwnerId)!);
        if (detail === null) return errorResponse(404, "connection_not_found", requestId);
        await activity.record(
          deferActivity,
          identity.actor,
          matched.operation === "mutate_connection_access" ? "control_write" : "control_read",
        );
        return json(200, {
          ok: true,
          data: snakeOutput(mutation === null ? detail : { ...detail, ...mutation }),
        });
      }
      if (
        matched.operation === "list_personal_token_page" ||
        matched.operation === "mutate_personal_token_access"
      ) {
        if (
          identity.kind !== "authenticated" ||
          dependencies.personalTokens === undefined ||
          dependencies.mindBindings === undefined
        ) return errorResponse(404, "personal_token_not_found", requestId);
        if (matched.operation === "list_personal_token_page") {
          const query = strictListQuery(url, true);
          if (query === null) return errorResponse(400, "invalid_request", requestId);
          const state = query.state ?? "active";
          const page = await dependencies.personalTokens.listPage(identity.actor, { ...query, state });
          const access = state === "active"
            ? await safeBindingAccessByOwner(
                dependencies.control,
                dependencies.mindBindings,
                identity.actor,
                page.items.map((token) => Object.freeze({
                  ownerId: token.bindingOwnerId,
                  scopes: token.scopes,
                  state: "active" as const,
                })),
              )
            : new Map<string, SafeCredentialAccess>();
          const items = page.items.map(({ bindingOwnerId, ...token }) => {
            const tokenAccess = access.get(bindingOwnerId);
            if (state === "active" && tokenAccess === undefined) {
              throw new TypeError("safe personal token access is unavailable");
            }
            return Object.freeze({
              ...token,
              ...(tokenAccess === undefined ? {} : { access: tokenAccess }),
            });
          });
          await activity.record(
            deferActivity,
            identity.actor,
            "control_read",
          );
          return json(200, { ok: true, data: snakeOutput({ items, nextCursor: page.nextCursor }) });
        }
        const personalTokenRef = String(matched.path.personal_token_ref ?? "");
        const token = await dependencies.personalTokens.read(identity.actor, personalTokenRef);
        if (token === null || token.state !== "active") {
          return errorResponse(404, "personal_token_not_found", requestId);
        }
        const mutation = await mutateCredentialAccess({
          actor: identity.actor,
          mindBindings: dependencies.mindBindings,
          control: dependencies.control,
          ownerId: token.bindingOwnerId,
          scopes: token.scopes,
          request: input,
          presentationKey: "personal_token_ref",
        });
        const fresh = await dependencies.personalTokens.read(identity.actor, personalTokenRef);
        if (fresh === null) return errorResponse(404, "personal_token_not_found", requestId);
        const access = await safeBindingAccessByOwner(
          dependencies.control,
          dependencies.mindBindings,
          identity.actor,
          [Object.freeze({
            ownerId: fresh.bindingOwnerId,
            scopes: fresh.scopes,
            state: "active" as const,
          })],
        );
        const { bindingOwnerId, ...safeToken } = fresh;
        const freshAccess = access.get(bindingOwnerId);
        if (freshAccess === undefined) {
          throw new TypeError("safe personal token access is unavailable");
        }
        await activity.record(
          deferActivity,
          identity.actor,
          "control_write",
        );
        return json(200, {
          ok: true,
          data: snakeOutput({ ...safeToken, access: freshAccess, ...mutation }),
        });
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
        const source = record(await dependencies.control.execute({
          operation: matched.operation,
          actor: identity.actor,
          input,
        }));
        if (source === null || !Array.isArray(source.minds)) {
          throw new TypeError("safe Public Mind catalog is unavailable");
        }
        const minds = Object.freeze(source.minds
          .map(publicUiMind)
          .filter((mind): mind is PublicMindCatalogItem => mind !== null));
        if (identity.kind === "authenticated") {
          await activity.record(deferActivity, identity.actor, "control_read");
        }
        return json(200, { ok: true, data: snakeOutput({ minds }) });
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
      return json(200, { ok: true, data: snakeOutput(data) });
    } catch (error) {
      const code = failureCode(error);
      return errorResponse(applicationErrorStatus(code), code, requestId);
    }
  };
}
