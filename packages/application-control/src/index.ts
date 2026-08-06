import type { ActorContext } from "@mind-diary/application-contracts";
import type { MetadataStore } from "@mind-diary/application-ports";
import type { PrincipalId } from "@mind-diary/domain";

export const CONTROL_QUERIES = [
  "get_session",
  "get_account_deletion_impact",
  "list_minds",
  "resolve_mind_metadata",
  "get_mind_info",
  "list_public_minds",
  "list_members",
  "list_invitations",
  "list_mcp_tokens",
] as const;

export const CONTROL_COMMANDS = [
  "bootstrap_account",
  "rename_account",
  "delete_account",
  "create_space_with_owner",
  "rename_space",
  "change_visibility",
  "delete_space",
  "create_invitation",
  "accept_invitation",
  "reject_invitation",
  "cancel_invitation",
  "change_membership_role",
  "revoke_membership",
  "leave_space",
  "transfer_ownership",
  "issue_mcp_token",
  "revoke_mcp_token",
] as const;

export interface ControlBoundaryMarker {
  readonly actor: ActorContext;
  readonly metadata: MetadataStore;
  readonly principalId?: PrincipalId;
}
