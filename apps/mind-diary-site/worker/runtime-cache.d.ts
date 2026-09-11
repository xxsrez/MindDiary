export const RUNTIME_INITIALIZATION_TIMEOUT_MS: number;

export interface RuntimeCacheHandle<Runtime> {
  readonly generation: string;
  /** Request-bounded view of the shared initialization flight. */
  readonly runtime: Promise<Runtime>;
  /** Retires only this settled generation, never a newer one or pending flight. */
  retireReady(): void;
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
  constructor(options?: {
    readonly now?: () => number;
  });
  acquire(options: {
    readonly environment: Environment;
    readonly fingerprint: string;
    readonly create: (
      schedule: (work: Readonly<Work>) => void,
      retireReady: () => void,
      generation: string,
    ) => Promise<Runtime>;
    readonly dispatch: (
      runtime: Runtime,
      work: Readonly<Work>,
    ) => Promise<unknown>;
    readonly initializationTimeoutMs?: number;
  }): RuntimeCacheHandle<Runtime>;
}
