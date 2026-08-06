import type { AuditSink } from "@mind-diary/application-ports";

export const AUDIT_ADAPTER = "memory-fixture-only" as const;
export type AuditAdapterContract = AuditSink;
