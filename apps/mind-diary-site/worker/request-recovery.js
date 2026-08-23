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

export const REQUEST_RECOVERY_CADENCE_MS = 30_000;
export const REQUEST_RECOVERY_IDLE_MS = 3_000;

function isRecoveryCandidateRequest(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
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
      options.waitUntil(slot.inFlight.catch(() => undefined));
      return response;
    }
    if (this.#now() < slot.nextEligibleAt) return response;

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
