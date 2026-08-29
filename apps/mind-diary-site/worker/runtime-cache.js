export const RUNTIME_INITIALIZATION_TIMEOUT_MS = 5_000;

async function withInitializationTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(
        new Error("Product runtime initialization timed out"),
        { code: "runtime_initialization_timeout" },
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One safe initialization flight per Worker environment/config identity.
 * Request ExecutionContext stays outside the cache and drains scheduled work.
 */
export class IsolateRuntimeCache {
  #slots = new WeakMap();

  acquire(options) {
    const timeoutMs = options.initializationTimeoutMs ?? RUNTIME_INITIALIZATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("runtime initialization timeout must be a positive integer");
    }
    let slot = this.#slots.get(options.environment);
    if (slot === undefined || slot.fingerprint !== options.fingerprint) {
      const created = {
        fingerprint: options.fingerprint,
        initialization: undefined,
        scheduled: new Set(),
      };
      const schedule = (work) => {
        const pending = created.initialization
          .then((runtime) => options.dispatch(runtime, work))
          .catch(() => undefined);
        created.scheduled.add(pending);
      };
      // create runs in a microtask, after initialization has been assigned, so
      // schedule can safely share the same immutable flight.
      const initialization = Promise.resolve().then(() => options.create(schedule));
      created.initialization = initialization;
      // A request timeout bounds only that request. The underlying flight stays
      // authoritative until it settles, preventing an overlapping generation.
      void initialization.catch(() => {
        if (this.#slots.get(options.environment) === created) {
          this.#slots.delete(options.environment);
        }
      });
      slot = created;
      this.#slots.set(options.environment, created);
    }
    const selected = slot;
    return Object.freeze({
      runtime: withInitializationTimeout(selected.initialization, timeoutMs),
      drainScheduled: () => {
        const drained = Object.freeze([...selected.scheduled]);
        selected.scheduled.clear();
        return drained;
      },
    });
  }
}
