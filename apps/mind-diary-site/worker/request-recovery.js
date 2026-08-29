import { IsolateRuntimeCache } from "./runtime-cache.js";

const STATIC_PATH_PREFIXES = Object.freeze([
  "/_next/",
  "/_assets/",
  "/assets/",
]);

const STATIC_PATHS = new Set([
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/robots.txt",
]);

const STATIC_EXTENSION = /\.(?:avif|css|gif|ico|jpe?g|js|map|mjs|otf|png|svg|ttf|webp|woff2?)$/iu;

const NON_DOCUMENT_PATH_PREFIXES = Object.freeze([
  "/api/",
  "/oauth/",
]);

const NON_DOCUMENT_PATHS = new Set([
  "/callback",
  "/signin-with-chatgpt",
  "/signout-with-chatgpt",
]);

export const REQUEST_RECOVERY_CADENCE_MS = 5 * 60_000;
export const REQUEST_RECOVERY_IDLE_MS = 5_000;
export const REQUEST_RECOVERY_PULSE_HEADER = "x-mind-diary-recovery-pulse";

function isRecoveryCandidateRequest(request) {
  if (request.method !== "HEAD") return false;
  if (request.headers.get(REQUEST_RECOVERY_PULSE_HEADER) !== "1") return false;
  const path = new URL(request.url).pathname;
  if (NON_DOCUMENT_PATHS.has(path) ||
      NON_DOCUMENT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  const acceptsHtml = request.headers
    .get("accept")
    ?.split(",")
    .some((mediaRange) => mediaRange.trim().split(";", 1)[0].toLowerCase() === "text/html") ?? false;
  return acceptsHtml &&
    !STATIC_PATHS.has(path) &&
    !STATIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
    !STATIC_EXTENSION.test(path);
}

/** Recovery is useful only after a successfully produced HTML document response. */
export function isRecoveryEligibleRequest(request, response) {
  return response.status < 500 && isRecoveryCandidateRequest(request);
}

/**
 * One quiet-window recovery flight per Worker environment/config generation.
 * A new document navigation fences an older pending timer before foreground
 * work begins. The response never awaits recovery, and failure observes the
 * same completion-based cadence so an unhealthy dependency cannot create a
 * storm.
 */
export class RequestRecoveryCoordinator {
  #slots = new WeakMap();
  #cadenceMs;
  #idleMs;
  #now;
  #delay;

  constructor(options = {}) {
    this.#cadenceMs = options.cadenceMs ?? REQUEST_RECOVERY_CADENCE_MS;
    this.#idleMs = options.idleMs ?? REQUEST_RECOVERY_IDLE_MS;
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? ((milliseconds) => new Promise(
      (resolve) => setTimeout(resolve, milliseconds),
    ));
    if (!Number.isSafeInteger(this.#cadenceMs) || this.#cadenceMs < 1) {
      throw new TypeError("request recovery cadence must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#idleMs) || this.#idleMs < 1) {
      throw new TypeError("request recovery idle window must be a positive integer");
    }
  }

  async respond(options) {
    const candidate = isRecoveryCandidateRequest(options.request);
    let slot = this.#slots.get(options.environment);
    if (slot === undefined || slot.fingerprint !== options.fingerprint) {
      slot = {
        fingerprint: options.fingerprint,
        inFlight: null,
        nextEligibleAt: 0,
        navigationGeneration: 0,
      };
      this.#slots.set(options.environment, slot);
    }
    if (candidate) slot.navigationGeneration += 1;
    const navigationGeneration = slot.navigationGeneration;

    const response = await options.foreground();
    if (!candidate || response.status >= 500) return response;

    if (slot.inFlight !== null) {
      // The request that started the flight already owns its waitUntil. Reusing
      // that promise here makes every navigation during maintenance inherit the
      // remaining Worker lifetime even though its foreground response is ready.
      return response;
    }
    if (this.#now() < slot.nextEligibleAt) return response;
    if (slot.navigationGeneration !== navigationGeneration) return response;

    const selected = slot;
    const planned = this.#delay(this.#idleMs)
      .then(() => {
        if (
          selected.navigationGeneration !== navigationGeneration ||
          selected.inFlight !== null ||
          this.#now() < selected.nextEligibleAt
        ) return undefined;
        const flight = Promise.resolve()
          .then(() => options.recover())
          .finally(() => {
            selected.inFlight = null;
            selected.nextEligibleAt = this.#now() + this.#cadenceMs;
          });
        selected.inFlight = flight;
        return flight;
      });
    options.waitUntil(planned.catch(() => undefined));
    return response;
  }
}

function decodeFullName(headers) {
  const value = headers.get("oai-authenticated-user-full-name");
  if (value === null) return undefined;
  if (headers.get("oai-authenticated-user-full-name-encoding") !== "percent-encoded-utf-8") {
    return undefined;
  }
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export function productWorkerConfigFingerprint(environment, publicOrigin) {
  const source = [
    publicOrigin,
    environment.MIND_DIARY_PUBLIC_ORIGIN,
    environment.MIND_DIARY_TOKEN_VERIFIER_KEY,
    environment.MIND_DIARY_LOCATOR_KEY,
    environment.MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY,
    environment.MIND_DIARY_CSRF_KEY,
    environment.MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS,
    environment.MIND_DIARY_DEPLOYMENT_CLASS,
    environment.MIND_DIARY_DEPLOYMENT_POSTURE,
    environment.MIND_DIARY_CAPACITY_PROFILE,
    environment.MIND_DIARY_RELEASE_CANDIDATE_SHA,
    environment.MIND_DIARY_CAPACITY_FENCE_NONCE,
    environment.MIND_DIARY_PERFORMANCE_CORRELATION_KEY,
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${publicOrigin}\u0000${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Constructor-only activation for the generated-source matrix. A partial or
 * production-like environment never installs the route.
 */
export function restrictedUatGeneratedSourceTestConfig(environment) {
  const candidateSha = environment.MIND_DIARY_RELEASE_CANDIDATE_SHA;
  if (
    environment.MIND_DIARY_DEPLOYMENT_CLASS !== "uat" ||
    environment.MIND_DIARY_DEPLOYMENT_POSTURE !== "restricted-uat" ||
    typeof candidateSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(candidateSha)
  ) return undefined;
  return Object.freeze({
    deploymentClass: "uat",
    deploymentPosture: "restricted-uat",
    candidateSha,
  });
}

function dispatchScheduled(runtime, work) {
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

/** Product Worker factory shared by the deployed default export and restart tests. */
export function createMindDiaryProductWorker(options) {
  if (typeof options?.createRuntime !== "function" ||
      typeof options?.readConfig !== "function" ||
      typeof options?.fallbackFetch !== "function" ||
      (options.staticFetch !== undefined && typeof options.staticFetch !== "function")) {
    throw new TypeError("product Worker dependencies are required");
  }
  const runtimeCache = options.runtimeCache ?? new IsolateRuntimeCache();
  const recoveryCoordinator = options.recoveryCoordinator ?? new RequestRecoveryCoordinator();
  return Object.freeze({
    async fetch(request, environment, context) {
      let failureStage = "static-assets";
      try {
        const staticResponse = options.staticFetch?.(request) ?? null;
        if (staticResponse !== null) return staticResponse;
        failureStage = "runtime-config";
        const config = options.readConfig(request, environment);
        failureStage = "composition";
        const fingerprint = productWorkerConfigFingerprint(environment, config.publicOrigin);
        const acquired = runtimeCache.acquire({
          environment,
          fingerprint,
          dispatch: dispatchScheduled,
          create: (schedule) => {
            const generatedSourceTest =
              restrictedUatGeneratedSourceTestConfig(environment);
            return options.createRuntime({
              database: environment.DB,
              bucket: environment.MIND_DIARY_BUCKET,
              ...config,
              ...(generatedSourceTest === undefined
                ? {}
                : { restrictedUatGeneratedSourceTest: generatedSourceTest }),
              identity: {
                readVerifiedIdentity(platformRequest) {
                  const email = platformRequest.headers.get("oai-authenticated-user-email");
                  if (email === null) return Object.freeze({ kind: "unauthenticated" });
                  const fullName = decodeFullName(platformRequest.headers);
                  return Object.freeze({
                    kind: "authenticated",
                    verifiedEmail: email,
                    ...(fullName === undefined ? {} : { verifiedFullName: fullName }),
                  });
                },
              },
              schedule,
            });
          },
        });
        const runtime = await acquired.runtime;
        return recoveryCoordinator.respond({
          request,
          environment,
          fingerprint,
          waitUntil: (promise) => context.waitUntil(promise),
          recover: async () => {
            try {
              // Request-triggered maintenance must remain a tiny repair tick.
              // Larger batches are explicit operator work: on Sites they can
              // occupy the shared D1 binding long enough to starve navigation.
              return await runtime.recoverBackground(4, "request");
            } finally {
              // Work produced by recovery belongs to the pulse that started
              // it. Never leave it for an unrelated foreground read to adopt.
              const scheduled = acquired.drainScheduled();
              if (scheduled.length > 0) await Promise.allSettled(scheduled);
            }
          },
          foreground: async () => {
            failureStage = "product-fetch";
            let response;
            try {
              response = await runtime.fetch(request, (promise) => {
                context.waitUntil(Promise.resolve(promise).catch(() => undefined));
              });
            } finally {
              if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
                const scheduled = acquired.drainScheduled();
                if (scheduled.length > 0) context.waitUntil(Promise.allSettled(scheduled));
              }
            }
            if (response !== null) return response;
            failureStage = "vinext-fetch";
            return options.fallbackFetch(request, environment, context);
          },
        });
      } catch {
        console.error(JSON.stringify({
          event: "mind-diary.runtime-unavailable",
          stage: failureStage,
        }));
        return Response.json(
          {
            ok: false,
            error: {
              code: "runtime_unavailable",
              message: "Mind Diary is temporarily unavailable.",
              retryable: true,
            },
          },
          {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
    },
  });
}
