import { createProductSiteRuntime } from "@mind-diary/composition-root";
import handler from "vinext/server/app-router-entry";
import { RequestRecoveryCoordinator } from "./request-recovery";
import { readRuntimeConfig, type ProductEnv } from "./runtime-config";
import { IsolateRuntimeCache } from "./runtime-cache";

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

type ScheduledWork = Readonly<{ readonly kind: string; readonly id: string }>;

const runtimeCache = new IsolateRuntimeCache<
  ProductEnv,
  Awaited<ReturnType<typeof createProductSiteRuntime>>,
  ScheduledWork
>();
const recoveryCoordinator = new RequestRecoveryCoordinator();

function configFingerprint(env: ProductEnv, publicOrigin: string): string {
  const source = [
    publicOrigin,
    env.MIND_DIARY_PUBLIC_ORIGIN,
    env.MIND_DIARY_TOKEN_VERIFIER_KEY,
    env.MIND_DIARY_LOCATOR_KEY,
    env.MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY,
    env.MIND_DIARY_CSRF_KEY,
    env.MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS,
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${publicOrigin}\u0000${hash.toString(16).padStart(8, "0")}`;
}

function dispatchScheduled(
  runtime: Awaited<ReturnType<typeof createProductSiteRuntime>>,
  work: ScheduledWork,
) {
  return runtime.dispatchBackground(
    work.kind === "export"
      ? { kind: "export", jobId: work.id }
      : work.kind === "audit_outbox"
        ? { kind: "audit_outbox", messageId: work.id }
        : work.kind === "invitation_expiry"
          ? { kind: "invitation_expiry", jobId: work.id }
          : { kind: "revision_index", jobId: work.id },
  );
}

const worker = {
  async fetch(request: Request, env: ProductEnv, ctx: ExecutionContext): Promise<Response> {
    let failureStage = "runtime-config";
    try {
      const config = readRuntimeConfig(request, env);
      failureStage = "composition";
      const fingerprint = configFingerprint(env, config.publicOrigin);
      const acquired = runtimeCache.acquire({
        environment: env,
        fingerprint,
        dispatch: dispatchScheduled,
        create: (schedule) => createProductSiteRuntime({
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
          schedule,
        }),
      });
      const runtime = await acquired.runtime;
      return recoveryCoordinator.respond({
        request,
        environment: env,
        fingerprint,
        waitUntil: (promise) => ctx.waitUntil(promise),
        recover: () => runtime.recoverBackground(),
        foreground: async () => {
          failureStage = "product-fetch";
          let response: Response | null;
          try {
            response = await runtime.fetch(request);
          } finally {
            const scheduled = acquired.drainScheduled();
            if (scheduled.length > 0) ctx.waitUntil(Promise.allSettled(scheduled));
          }
          if (response !== null) return response;
          failureStage = "vinext-fetch";
          return handler.fetch(request, env, ctx);
        },
      });
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
