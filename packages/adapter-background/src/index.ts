import {
  BACKGROUND_HANDLERS,
  type ServiceActorContext,
} from "@mind-diary/application-background";

export const BACKGROUND_APPLICATION_BOUNDARY = {
  handlers: BACKGROUND_HANDLERS,
  authorityFromJobPayload: false,
} as const;

/** Deployment-owned factory; serialized job claims are never copied into authority. */
export function createBackgroundServiceActor(input: {
  readonly serviceId: string;
  readonly requestId: ServiceActorContext["requestId"];
  readonly occurredAtUtc: ServiceActorContext["occurredAtUtc"];
  readonly deploymentCapabilities?: ServiceActorContext["deploymentCapabilities"];
}): ServiceActorContext {
  if (typeof input.serviceId !== "string" || input.serviceId.trim().length === 0) {
    throw new TypeError("background service ID must be non-empty");
  }
  return Object.freeze({
    kind: "service",
    serviceId: input.serviceId,
    requestId: input.requestId,
    occurredAtUtc: input.occurredAtUtc,
    deploymentCapabilities: Object.freeze([
      ...(input.deploymentCapabilities ?? []),
    ]),
  });
}
