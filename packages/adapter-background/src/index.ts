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

export type ProductBackgroundWork =
  | { readonly kind: "revision_index"; readonly jobId: string }
  | { readonly kind: "export"; readonly jobId: string }
  | { readonly kind: "audit_outbox"; readonly messageId: string }
  | { readonly kind: "invitation_expiry"; readonly jobId: string }
  | { readonly kind: "export_expiry"; readonly jobId: string };

export interface ProductBackgroundHandlers {
  readonly revisionIndex: (actor: ServiceActorContext, jobId: string) => Promise<unknown>;
  readonly export: (actor: ServiceActorContext, jobId: string) => Promise<unknown>;
  readonly auditOutbox: (actor: ServiceActorContext, messageId: string) => Promise<unknown>;
  readonly invitationExpiry: (actor: ServiceActorContext, jobId: string) => Promise<unknown>;
  readonly exportExpiry: (actor: ServiceActorContext, jobId: string) => Promise<unknown>;
}

/**
 * Deployment dispatcher for opaque durable work IDs. Job payloads select work
 * but never carry principal, membership, role, scope, or capability authority.
 */
export function createProductBackgroundDispatcher(input: {
  readonly serviceId: string;
  readonly now: () => ServiceActorContext["occurredAtUtc"];
  readonly requestId: () => ServiceActorContext["requestId"];
  readonly handlers: ProductBackgroundHandlers;
}) {
  return async (work: Readonly<ProductBackgroundWork>): Promise<unknown> => {
    const actor = createBackgroundServiceActor({
      serviceId: input.serviceId,
      requestId: input.requestId(),
      occurredAtUtc: input.now(),
      deploymentCapabilities: Object.freeze([]),
    });
    switch (work.kind) {
      case "revision_index":
        return input.handlers.revisionIndex(actor, work.jobId);
      case "export":
        return input.handlers.export(actor, work.jobId);
      case "audit_outbox":
        return input.handlers.auditOutbox(actor, work.messageId);
      case "invitation_expiry":
        return input.handlers.invitationExpiry(actor, work.jobId);
      case "export_expiry":
        return input.handlers.exportExpiry(actor, work.jobId);
    }
  };
}
