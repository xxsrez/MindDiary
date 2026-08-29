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
        runtime: Promise.reject(new Error("runtime initialization not started")),
        scheduled: new Set(),
      };
      // The placeholder rejection is never observed: replace it synchronously.
      created.runtime.catch(() => undefined);
      const schedule = (work) => {
        const pending = created.runtime
          .then((runtime) => options.dispatch(runtime, work))
          .catch(() => undefined);
        created.scheduled.add(pending);
      };
      const initialization = Promise.resolve().then(() => options.create(schedule));
      created.runtime = withInitializationTimeout(initialization, timeoutMs).catch((error) => {
        if (this.#slots.get(options.environment) === created) {
          this.#slots.delete(options.environment);
        }
        throw error;
      });
      slot = created;
      this.#slots.set(options.environment, created);
    }
    const selected = slot;
    return Object.freeze({
      runtime: selected.runtime,
      drainScheduled: () => {
        const drained = Object.freeze([...selected.scheduled]);
        selected.scheduled.clear();
        return drained;
      },
    });
  }
}
