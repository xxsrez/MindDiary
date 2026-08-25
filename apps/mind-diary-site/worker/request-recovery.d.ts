export const REQUEST_RECOVERY_CADENCE_MS: number;
export const REQUEST_RECOVERY_IDLE_MS: number;

export function isRecoveryEligibleRequest(
  request: Request,
  response: Response,
): boolean;

export declare class RequestRecoveryCoordinator {
  constructor(options?: {
    readonly cadenceMs?: number;
    readonly idleMs?: number;
    readonly now?: () => number;
    readonly delay?: (milliseconds: number) => Promise<unknown>;
  });

  respond<Environment extends object>(options: {
    readonly request: Request;
    readonly environment: Environment;
    readonly fingerprint: string;
    readonly foreground: () => Promise<Response>;
    readonly recover: () => Promise<unknown>;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  }): Promise<Response>;
}

export declare function productWorkerConfigFingerprint(
  environment: Record<string, unknown>,
  publicOrigin: string,
): string;

export declare function createMindDiaryProductWorker<
  Environment extends object,
  Context extends { waitUntil(promise: Promise<unknown>): void },
  RuntimeOptions,
  Runtime extends {
    fetch(
      request: Request,
      deferActivity?: (promise: Promise<unknown>) => void,
    ): Promise<Response | null>;
    recoverBackground(): Promise<unknown>;
    dispatchBackground(work: Readonly<Record<string, unknown>>): Promise<unknown>;
  },
>(options: {
  readonly createRuntime: (options: RuntimeOptions) => Promise<Runtime>;
  readonly readConfig: (request: Request, environment: Environment) =>
    Readonly<Record<string, unknown> & { readonly publicOrigin: string }>;
  readonly fallbackFetch: (
    request: Request,
    environment: Environment,
    context: Context,
  ) => Promise<Response>;
  readonly runtimeCache?: object;
  readonly recoveryCoordinator?: RequestRecoveryCoordinator;
}): Readonly<{
  fetch(request: Request, environment: Environment, context: Context): Promise<Response>;
}>;
