import type { ActorContext } from "@mind-diary/application-contracts";
import type { AuditSink, SearchIndex } from "@mind-diary/application-ports";
import type { RevisionId } from "@mind-diary/domain";
import type { OkfBundleFixture } from "@mind-diary/okf-codec";

export const BACKGROUND_HANDLERS = [
  "rebuild_revision_index",
  "complete_export",
  "collect_unreachable_objects",
  "deliver_audit_outbox",
  "expire_invitations",
  "expire_export_grants",
  "continue_deletion",
] as const;

export interface BackgroundBoundaryMarker {
  readonly actor: Extract<ActorContext, { kind: "service" }>;
  readonly revisionId?: RevisionId;
  readonly searchIndex: SearchIndex;
  readonly auditSink: AuditSink;
  readonly fixtureOnlyBundle?: OkfBundleFixture;
}
