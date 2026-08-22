export interface RuntimeCacheHandle<Runtime> {
  readonly runtime: Promise<Runtime>;
  /** Removes only work captured by this isolate slot; no request context is retained. */
  drainScheduled(): readonly Promise<unknown>[];
}

interface RuntimeSlot<Runtime> {
  readonly fingerprint: string;
  runtime: Promise<Runtime>;
  readonly scheduled: Set<Promise<unknown>>;
}

/**
 * One safe initialization flight per Worker environment/config identity.
 * Request ExecutionContext stays outside the cache and drains scheduled work.
 */
export class IsolateRuntimeCache<Environment extends object, Runtime, Work> {
  readonly #slots = new WeakMap<Environment, RuntimeSlot<Runtime>>();

  acquire(options: {
    readonly environment: Environment;
    readonly fingerprint: string;
    readonly create: (schedule: (work: Readonly<Work>) => void) => Promise<Runtime>;
    readonly dispatch: (runtime: Runtime, work: Readonly<Work>) => Promise<unknown>;
  }): RuntimeCacheHandle<Runtime> {
    let slot = this.#slots.get(options.environment);
    if (slot === undefined || slot.fingerprint !== options.fingerprint) {
      const created: RuntimeSlot<Runtime> = {
        fingerprint: options.fingerprint,
        runtime: Promise.reject(new Error("runtime initialization not started")),
        scheduled: new Set(),
      };
      // The placeholder rejection is never observed: replace it synchronously.
      created.runtime.catch(() => undefined);
      const schedule = (work: Readonly<Work>) => {
        const pending = created.runtime
          .then((runtime) => options.dispatch(runtime, work))
          .catch(() => undefined);
        created.scheduled.add(pending);
      };
      const initialization = Promise.resolve().then(() => options.create(schedule));
      created.runtime = initialization.catch((error: unknown) => {
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
