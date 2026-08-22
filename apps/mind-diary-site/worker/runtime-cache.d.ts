export interface RuntimeCacheHandle<Runtime> {
  readonly runtime: Promise<Runtime>;
  /** Removes only work captured by this isolate slot; no request context is retained. */
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
  }): RuntimeCacheHandle<Runtime>;
}
