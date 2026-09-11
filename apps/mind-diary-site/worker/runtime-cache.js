export const RUNTIME_INITIALIZATION_TIMEOUT_MS = 5_000;
const RUNTIME_INITIALIZATION_LEASE_MULTIPLIER = 3;

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
 * One safe initialization flight per exact Worker environment/config identity.
 * Request ExecutionContext stays outside the cache and drains queued work.
 */
export class IsolateRuntimeCache {
  #environments = new WeakMap();
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") {
      throw new TypeError("runtime cache clock must be a function");
    }
    this.#now = now;
  }

  #retire(environmentSlots, slot) {
    if (environmentSlots.slots.get(slot.fingerprint) === slot) {
      environmentSlots.slots.delete(slot.fingerprint);
    }
    slot.acceptsScheduledWork = false;
    slot.initializationScheduled.length = 0;
    slot.scheduled.length = 0;
  }

  #drain(slot, queue) {
    if (!slot.acceptsScheduledWork || queue.length === 0) return Object.freeze([]);
    const drained = queue.splice(0, queue.length);
    return Object.freeze(drained.map((work) =>
      slot.initialization
        .then((runtime) => slot.acceptsScheduledWork
          ? slot.dispatch(runtime, work)
          : undefined)
        .catch(() => undefined)));
  }

  acquire(options) {
    const timeoutMs = options.initializationTimeoutMs ?? RUNTIME_INITIALIZATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("runtime initialization timeout must be a positive integer");
    }
    const leaseMs = timeoutMs * RUNTIME_INITIALIZATION_LEASE_MULTIPLIER;
    if (!Number.isSafeInteger(leaseMs)) {
      throw new TypeError("runtime initialization lease must be a safe integer");
    }
    let environmentSlots = this.#environments.get(options.environment);
    if (environmentSlots === undefined) {
      environmentSlots = {
        currentFingerprint: undefined,
        slots: new Map(),
      };
      this.#environments.set(options.environment, environmentSlots);
    }

    if (environmentSlots.currentFingerprint !== options.fingerprint) {
      const previous = environmentSlots.slots.get(environmentSlots.currentFingerprint);
      if (previous !== undefined && previous.state !== "pending") {
        this.#retire(environmentSlots, previous);
      }
      const returning = environmentSlots.slots.get(options.fingerprint);
      if (returning !== undefined && returning.state !== "pending") {
        this.#retire(environmentSlots, returning);
      }
      environmentSlots.currentFingerprint = options.fingerprint;
    }

    let slot = environmentSlots.slots.get(options.fingerprint);
    if (
      slot !== undefined &&
      slot.state === "pending" &&
      this.#now() >= slot.leaseExpiresAt
    ) {
      this.#retire(environmentSlots, slot);
      slot = undefined;
    }
    if (slot === undefined) {
      const created = {
        fingerprint: options.fingerprint,
        state: "pending",
        leaseExpiresAt: this.#now() + leaseMs,
        initialization: undefined,
        dispatch: options.dispatch,
        acceptsScheduledWork: true,
        initializationScheduled: [],
        scheduled: [],
      };
      const schedule = (work) => {
        if (!created.acceptsScheduledWork) return;
        const queue = created.state === "pending"
          ? created.initializationScheduled
          : created.scheduled;
        queue.push(work);
      };
      // create runs in a microtask, after initialization has been assigned, so
      // schedule can safely share the same immutable flight.
      const initialization = Promise.resolve().then(() => options.create(schedule, () => {
        if (created.state === "fulfilled") this.#retire(environmentSlots, created);
      }));
      created.initialization = initialization;
      // A request timeout bounds only that request. Pending flights remain
      // reusable until their lease expires, while settled obsolete, rejected,
      // or expired generations are fenced together with their queued work.
      void initialization.then(
        () => {
          created.state = "fulfilled";
          if (
            environmentSlots.currentFingerprint !== created.fingerprint ||
            environmentSlots.slots.get(created.fingerprint) !== created
          ) this.#retire(environmentSlots, created);
        },
        () => {
          created.state = "rejected";
          this.#retire(environmentSlots, created);
        },
      );
      slot = created;
      environmentSlots.slots.set(options.fingerprint, created);
    }
    const selected = slot;
    return Object.freeze({
      runtime: withInitializationTimeout(selected.initialization, timeoutMs),
      retireReady: () => {
        if (selected.state === "fulfilled") this.#retire(environmentSlots, selected);
      },
      drainInitializationScheduled: () =>
        this.#drain(selected, selected.initializationScheduled),
      drainScheduled: () => this.#drain(selected, selected.scheduled),
    });
  }
}
