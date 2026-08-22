export const REQUEST_RECOVERY_CADENCE_MS: number;

export function isRecoveryEligibleRequest(
  request: Request,
  response: Response,
): boolean;

export declare class RequestRecoveryCoordinator {
  constructor(options?: {
    readonly cadenceMs?: number;
    readonly now?: () => number;
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
