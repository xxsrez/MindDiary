export const RUNTIME_INITIALIZATION_TIMEOUT_MS: number;

export interface RuntimeCacheHandle<Runtime> {
  /** Request-bounded view of the shared initialization flight. */
  readonly runtime: Promise<Runtime>;
  /** Dispatches cold-start work only when a live request adopts it. */
  drainInitializationScheduled(): readonly Promise<unknown>[];
  /** Dispatches post-initialization work owned by the current operation. */
  drainScheduled(): readonly Promise<unknown>[];
}

export declare class IsolateRuntimeCache<
  Environment extends object,
  Runtime,
  Work,
> {
  acquire(options: {
    readonly environment: Environment;
    readonly fingerprint: string;
    readonly create: (
      schedule: (work: Readonly<Work>) => void,
    ) => Promise<Runtime>;
    readonly dispatch: (
      runtime: Runtime,
      work: Readonly<Work>,
    ) => Promise<unknown>;
    readonly initializationTimeoutMs?: number;
  }): RuntimeCacheHandle<Runtime>;
}
