/**
 * One safe initialization flight per Worker environment/config identity.
 * Request ExecutionContext stays outside the cache and drains scheduled work.
 */
export class IsolateRuntimeCache {
  #slots = new WeakMap();

  acquire(options) {
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
      created.runtime = initialization.catch((error) => {
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
