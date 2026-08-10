import { createProductSiteRuntime } from "@mind-diary/composition-root";
import handler from "vinext/server/app-router-entry";
import { readRuntimeConfig, type ProductEnv } from "./runtime-config";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function decodeFullName(headers: Headers): string | undefined {
  const value = headers.get("oai-authenticated-user-full-name");
  if (value === null) return undefined;
  if (headers.get("oai-authenticated-user-full-name-encoding") !== "percent-encoded-utf-8") return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

const worker = {
  async fetch(request: Request, env: ProductEnv, ctx: ExecutionContext): Promise<Response> {
    let failureStage = "runtime-config";
    try {
      const config = readRuntimeConfig(request, env);
      failureStage = "composition";
      let runtimePromise: ReturnType<typeof createProductSiteRuntime>;
      runtimePromise = createProductSiteRuntime({
        database: env.DB,
        bucket: env.MIND_DIARY_BUCKET,
        ...config,
        identity: {
          readVerifiedIdentity(platformRequest) {
            const email = platformRequest.headers.get("oai-authenticated-user-email");
            if (email === null) return Object.freeze({ kind: "unauthenticated" as const });
            const fullName = decodeFullName(platformRequest.headers);
            return Object.freeze({
              kind: "authenticated" as const,
              verifiedEmail: email,
              ...(fullName === undefined ? {} : { verifiedFullName: fullName }),
            });
          },
        },
        schedule(work) {
          ctx.waitUntil(runtimePromise.then((runtime) => runtime.dispatchBackground(
            work.kind === "export"
              ? { kind: "export", jobId: work.id }
              : work.kind === "audit_outbox"
                ? { kind: "audit_outbox", messageId: work.id }
                : work.kind === "invitation_expiry"
                  ? { kind: "invitation_expiry", jobId: work.id }
                  : { kind: "revision_index", jobId: work.id },
          )));
        },
      });
      const runtime = await runtimePromise;
      failureStage = "product-fetch";
      const response = await runtime.fetch(request);
      failureStage = "vinext-fetch";
      return response ?? handler.fetch(request, env, ctx);
    } catch {
      console.error(JSON.stringify({
        event: "mind-diary.runtime-unavailable",
        stage: failureStage,
      }));
      return Response.json(
        { ok: false, error: { code: "runtime_unavailable", message: "Mind Diary is temporarily unavailable.", retryable: true } },
        { status: 503, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
      );
    }
  },
};

export default worker;
