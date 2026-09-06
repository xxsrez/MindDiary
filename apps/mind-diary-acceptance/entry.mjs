import {
  createProductSiteRuntime,
  createProductUiStaticAssetResponse,
} from "../../packages/composition-root/dist/index.js";
import { createMindDiaryProductWorker } from "../mind-diary-site/worker/request-recovery.js";
import { readRuntimeConfig } from "../mind-diary-site/worker/runtime-config.ts";
import { assertAcceptanceTarget } from "./runtime-target.mjs";
import probe from "./worker.mjs";
import { AcceptanceSessionStore } from "./session-store.mjs";
import { handleAcceptanceSession } from "./session-http.mjs";
import { cleanupRun } from "./cleanup.mjs";
import { acceptanceInventory } from "./inventory.mjs";
import { recoverOrphanOAuth } from "./oauth-recovery.mjs";
import { ACCEPTANCE_ORIGIN } from "./runtime-target.mjs";
import { AcceptanceTelemetryJournal } from "./telemetry-journal.mjs";

export function createAcceptanceWorker({ createRuntime = createProductSiteRuntime } = {}) {
  const stores = new WeakMap();
  const runtimeEnvironments = new WeakMap();
  const recoveryIdentities = new WeakMap();
  const telemetryJournals = new WeakMap();
  function telemetryFor(database) {
    if (!telemetryJournals.has(database)) telemetryJournals.set(database, new AcceptanceTelemetryJournal(database, __MD_ACCEPTANCE_BUILD__));
    return telemetryJournals.get(database);
  }
  function storeFor(database) {
    if (!stores.has(database)) stores.set(database, new AcceptanceSessionStore(database));
    return stores.get(database);
  }

  function createProduct() {
    const runtimes = new WeakMap();
    const worker = createMindDiaryProductWorker({
      createRuntime: async (options) => {
        const runtime = await createRuntime({
          ...options,
          observabilityWriter: { write: value => telemetryFor(options.database).write(value) },
          identity: { async readVerifiedIdentity(request) {
            const actor = recoveryIdentities.get(request) ?? await storeFor(options.database).actorForRequest(request);
            return actor ? { kind: "authenticated", verifiedEmail: actor.subject, verifiedFullName: `Test actor ${actor.ordinal + 1}` } : { kind: "unauthenticated" };
          } },
          identityBindingProvider: "synthetic-test",
          mcpPrincipalAdmission: (principalId, request) => storeFor(options.database).admitPrincipal(principalId, request),
        });
        runtimes.set(options.database, runtime);
        return runtime;
      },
      staticFetch: createProductUiStaticAssetResponse,
      readConfig: readRuntimeConfig,
      fallbackFetch: async () => new Response("Not found", { status: 404 }),
    });
    return { worker, runtime: database => runtimes.get(database) };
  }
  const product = createProduct().worker;

  return {
    async fetch(request, environment, context) {
      try { assertAcceptanceTarget(request, environment); }
      catch { return Response.json({ error: "acceptance_target_mismatch" }, { status: 503 }); }
      const path = new URL(request.url).pathname;
      if (path === "/api/probe") return probe.fetch(request, environment);
      if (path === "/_acceptance/build" && request.method === "GET") {
        return Response.json(__MD_ACCEPTANCE_BUILD__, { headers: { "cache-control": "no-store" } });
      }
      const store = storeFor(environment.DB);
      const sessionResponse = await handleAcceptanceSession(request, store, environment.MD_ACCEPTANCE_CONTROLLER_KEY, (runId) => {
        // A canceled request can abandon pending work in a fulfilled runtime.
        // Retry from durable state without inheriting that request's queues.
        const recovery = createProduct();
        return cleanupRun(store, runId,
          async (actor, internalRequest) => {
            recoveryIdentities.set(internalRequest, actor);
            try { return await recovery.worker.fetch(internalRequest, environment, context); }
            finally { recoveryIdentities.delete(internalRequest); }
          },
          (input) => recovery.runtime(environment.DB).resumeAccountDeletion(input));
      }, () => acceptanceInventory(environment), async () => {
        const recovery = createProduct();
        await recovery.worker.fetch(new Request(ACCEPTANCE_ORIGIN + "/api/v1/session"), environment, context);
        return recoverOrphanOAuth(environment.DB, principalId => recovery.runtime(environment.DB).purgeDeletedPrincipalOAuth(principalId));
      });
      if (sessionResponse) return sessionResponse;
      const actor = await store.actorForRequest(request);
      if (path === "/" && !actor) return probe.fetch(request, environment);
      // Internal constructor configuration is derived from normal bootstrap results;
      // the outer guard has already rejected any caller/environment allowlist.
      if (!runtimeEnvironments.has(environment)) runtimeEnvironments.set(environment, { ...environment });
      const runtimeEnvironment = runtimeEnvironments.get(environment);
      runtimeEnvironment.MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS = (await store.operatorPrincipalIds()).join(",");
      const journal = telemetryFor(environment.DB);
      let measurement, response;
      try {
        measurement = await journal.begin(actor?.run_id ?? request.headers.get("x-md-acceptance-run"), request.headers.get("x-mind-diary-performance-correlation-id"));
        response = await product.fetch(request, runtimeEnvironment, context);
        await journal.finish(measurement, response.ok);
      } catch {
        return Response.json({ error: "acceptance_telemetry_unavailable" }, { status: 503 });
      } finally { journal.cancel(measurement); }
      if (actor && response.ok && (path === "/api/v1/account" && request.method === "POST" || path === "/api/v1/session" && request.method === "GET")) {
        const value = await response.clone().json();
        const principalId = path === "/api/v1/account" ? value.data?.principal_id : value.data?.principal?.principal_id;
        if (value.ok && principalId) await store.bindPrincipal(actor, principalId);
      }
      return response;
    },
  };
}

export default createAcceptanceWorker();
