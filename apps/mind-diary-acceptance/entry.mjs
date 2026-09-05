import {
  createProductSiteRuntime,
  createProductUiStaticAssetResponse,
} from "../../packages/composition-root/dist/index.js";
import { createMindDiaryProductWorker } from "../mind-diary-site/worker/request-recovery.js";
import { readRuntimeConfig } from "../mind-diary-site/worker/runtime-config.ts";
import { assertAcceptanceTarget } from "./runtime-target.mjs";
import probe from "./worker.mjs";

const product = createMindDiaryProductWorker({
  createRuntime: (options) => createProductSiteRuntime({
    ...options,
    // MD-403 supplies the verified session reader here. Until then no platform
    // or caller header can bootstrap a real account in the test environment.
    identity: { readVerifiedIdentity: () => ({ kind: "unauthenticated" }) },
    identityBindingProvider: "synthetic-test",
    serviceOperatorPrincipalIds: [],
  }),
  staticFetch: createProductUiStaticAssetResponse,
  readConfig: readRuntimeConfig,
  fallbackFetch: async () => new Response("Not found", { status: 404 }),
});

export default {
  async fetch(request, environment, context) {
    try { assertAcceptanceTarget(request, environment); }
    catch { return Response.json({ error: "acceptance_target_mismatch" }, { status: 503 }); }
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/api/probe") return probe.fetch(request, environment);
    if (path === "/_acceptance/build" && request.method === "GET") {
      return Response.json(__MD_ACCEPTANCE_BUILD__, { headers: { "cache-control": "no-store" } });
    }
    return product.fetch(request, environment, context);
  },
};
