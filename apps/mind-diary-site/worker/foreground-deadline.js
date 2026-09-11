export const FOREGROUND_TIMEOUT_MS = 10_000;

/** Bounds caller waiting, never claims cancellation of durable effects. */
export async function withForegroundDeadline(request, timeoutMs, operation, retire) {
  const controller = new AbortController();
  let timer;
  let expire;
  const deadline = new Promise((resolve) => {
    expire = (code) => {
      if (controller.signal.aborted) return;
      controller.abort();
      retire(code);
      resolve(Response.json({
        ok: false,
        error: {
          code,
          message: "Request did not finish. A write may still commit; reconcile using the original idempotency key before retrying.",
          retryable: true,
        },
      }, { status: 503, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }));
    };
  });
  const canceled = () => expire("request_canceled");
  request.signal.addEventListener("abort", canceled, { once: true });
  try {
    if (request.signal.aborted) {
      canceled();
      return await deadline;
    }
    timer = setTimeout(() => expire("request_timeout"), timeoutMs);
    return await Promise.race([
      deadline,
      // Preserve request identity: trusted adapters may associate verified
      // context with the original Request in a WeakMap.
      Promise.resolve().then(() => operation(request, controller.signal)),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", canceled);
  }
}
