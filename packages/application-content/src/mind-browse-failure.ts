export type MindBrowseFailureCode =
  | "authentication_required"
  | "forbidden"
  | "mind_not_found"
  | "revision_not_found"
  | "locator_not_found"
  | "resource_not_found"
  | "bundle_file_not_found"
  | "invalid_request"
  | "invalid_query"
  | "invalid_cursor"
  | "invalid_limit"
  | "invalid_path"
  | "invalid_fetch_budget"
  | "invalid_mind_selector"
  | "invalid_revision_selector"
  | "invalid_file_operation"
  | "invalid_glob"
  | "invalid_metadata_filter"
  | "invalid_sort"
  | "unsupported_pattern"
  | "file_operation_cursor_invalid"
  | "file_operation_budget_exhausted"
  | "revision_integrity_failure"
  | "read_conflict"
  | "discovery_unavailable"
  | "mind_binding_required"
  | "credential_access_upgrade_required"
  | "binding_owner_revoked"
  | "binding_state_unavailable";

export class MindBrowseFailure extends Error {
  readonly code: MindBrowseFailureCode;
  readonly retryable: boolean;

  constructor(code: MindBrowseFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "MindBrowseFailure";
    this.code = code;
    this.retryable = retryable;
  }
}
