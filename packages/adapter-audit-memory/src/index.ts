import type { AuditEvent, AuditSink } from "@mind-diary/application-ports";

export const AUDIT_ADAPTER = "memory-idempotent-delivery" as const;
export type AuditAdapterContract = AuditSink;

function cloneEvent(event: Readonly<AuditEvent>): Readonly<AuditEvent> {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    safeMetadata: Object.freeze({ ...event.safeMetadata }),
  });
}

/** Test/local sink with durable-id semantics and no payload logging. */
export class InMemoryAuditSink implements AuditSink {
  readonly kind = "audit-sink" as const;
  readonly #delivered = new Map<AuditEvent["auditEventId"], Readonly<AuditEvent>>();
  #nextFailure: Error | null = null;

  async deliver(event: Readonly<AuditEvent>): Promise<"delivered" | "duplicate"> {
    if (this.#delivered.has(event.auditEventId)) return "duplicate";
    if (this.#nextFailure) {
      const failure = this.#nextFailure;
      this.#nextFailure = null;
      throw failure;
    }
    this.#delivered.set(event.auditEventId, cloneEvent(event));
    return "delivered";
  }

  async purgeSpace(spaceId: NonNullable<AuditEvent["spaceId"]>): Promise<number> {
    const ids = [...this.#delivered]
      .filter(([, event]) => event.spaceId === spaceId)
      .map(([id]) => id);
    ids.forEach((id) => this.#delivered.delete(id));
    return ids.length;
  }

  deliveredForTest(): readonly Readonly<AuditEvent>[] {
    return Object.freeze([...this.#delivered.values()].map(cloneEvent));
  }

  failNextDeliveryForTest(error: Error = new Error("injected audit delivery failure")): void {
    this.#nextFailure = error;
  }
}
