import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import type { RevisionId, SpaceId } from "@mind-diary/domain";
import type { CommitChangesetResult } from "./changeset-commit.js";

/**
 * Retired compatibility shape for cached clients that still call the former
 * additive-only tool. Fresh discovery no longer advertises this request.
 */
export interface AutomaticCaptureRequest {
  readonly actor: McpTokenActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
  readonly expectedBindingVersion: unknown;
  readonly expectedRevisionId: unknown;
  readonly idempotencyKey: unknown;
  readonly classification: unknown;
  readonly captureKind: unknown;
  readonly captureKey: unknown;
  readonly title: unknown;
  readonly description: unknown;
  readonly body: unknown;
  readonly sources: unknown;
}

export type AutomaticCaptureResult =
  | {
      readonly kind: "captured";
      readonly path: string;
      readonly previousRevisionId: RevisionId | null;
      readonly revisionId: RevisionId;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "no_op";
      readonly path: string;
      readonly revisionId: RevisionId;
    }
  | {
      readonly kind:
        | "invalid_capture_request"
        | "capture_disabled"
        | "capture_binding_stale"
        | "capture_target_visibility_blocked"
        | "capture_confirmation_required"
        | "capture_conflict"
        | "capture_target_not_ready";
    }
  | Exclude<CommitChangesetResult, { readonly kind: "committed" }>;

/**
 * The old tool intentionally has no write path. Automatic agent saves now use
 * the ordinary commit_changeset service and its principal-owned read_write
 * generation. Keeping this class side-effect-free makes cached calls safe
 * while adapters remove the retired tool from fresh discovery.
 */
export class AutomaticCaptureService {
  constructor(_dependencies: Readonly<Record<string, unknown>>) {}

  async capture(_request: AutomaticCaptureRequest): Promise<AutomaticCaptureResult> {
    return Object.freeze({ kind: "capture_disabled" as const });
  }
}
