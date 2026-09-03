import {
  CONTROL_COMMANDS,
  CONTROL_QUERIES,
  type ControlBoundaryMarker,
} from "@mind-diary/application-control";

export * from "./ui-shell.js";
export * from "./onboarding.js";
export * from "./token-management.js";
export * from "./connections.js";
export * from "./sites-identity-binding.js";
export * from "./request-security.js";
export * from "./product-http.js";
export * from "./export-download-http.js";
export * from "./bundle-file-download-http.js";
export * from "./ordinary-minds-management.js";
export * from "./export-workflow.js";
export * from "./operator-directory.js";
export * from "./account-deletion.js";
export * from "./invitations-membership.js";
export * from "./visibility-catalog.js";
export * from "./mind-usage.js";

import { WEB_CONTROL_REQUEST_SECURITY_POLICY } from "./request-security.js";

type WebActorContext = ControlBoundaryMarker["actor"];

export const WEB_APPLICATION_BOUNDARY = {
  queries: CONTROL_QUERIES,
  commands: CONTROL_COMMANDS,
  requestSecurity: WEB_CONTROL_REQUEST_SECURITY_POLICY,
} as const;

export const WEB_ACCEPTS_MCP_BEARER = false as const;

/**
 * Web control receives an already trusted Sites actor from its platform
 * boundary. It never parses Authorization as an MCP credential.
 */
export function isTrustedSitesControlActor(
  actor: WebActorContext | null,
): boolean {
  return (
    actor?.kind === "registered_principal" &&
    actor.authentication.kind === "sites_identity"
  );
}

export const WEB_CONTROL_ROUTES = [
  ["GET", "/api/v1/session"],
  ["POST", "/api/v1/account"],
  ["PATCH", "/api/v1/account"],
  ["GET", "/api/v1/account/deletion-impact"],
  ["DELETE", "/api/v1/account"],
  ["GET", "/api/v1/minds"],
  ["GET", "/api/v1/mind-usage"],
  ["POST", "/api/v1/minds"],
  ["GET", "/api/v1/minds/{mind_ref}"],
  ["GET", "/api/v1/minds/{mind_ref}/usage"],
  ["PUT", "/api/v1/minds/{mind_ref}/usage"],
  ["GET", "/api/v1/minds/{mind_ref}/capacity"],
  ["POST", "/api/v1/minds/{mind_ref}/exports"],
  ["GET", "/api/v1/export-jobs/{job_id}"],
  ["POST", "/api/v1/minds/{mind_ref}/markdown-import-plans"],
  ["POST", "/api/v1/minds/{mind_ref}/markdown-imports"],
  ["GET", "/api/v1/markdown-imports/{import_id}"],
  ["PUT", "/api/v1/markdown-imports/{import_id}/batches/{checkpoint}"],
  ["POST", "/api/v1/markdown-imports/{import_id}/validate"],
  ["POST", "/api/v1/markdown-imports/{import_id}/commit"],
  ["DELETE", "/api/v1/markdown-imports/{import_id}"],
  ["PATCH", "/api/v1/minds/{mind_ref}"],
  ["GET", "/api/v1/minds/{mind_ref}/deletion-impact"],
  ["DELETE", "/api/v1/minds/{mind_ref}"],
  ["GET", "/api/v1/public-minds"],
  ["PUT", "/api/v1/minds/{mind_ref}/visibility"],
  ["GET", "/api/v1/minds/{mind_ref}/members"],
  ["PATCH", "/api/v1/minds/{mind_ref}/members/{member_id}"],
  ["DELETE", "/api/v1/minds/{mind_ref}/members/{member_id}"],
  ["POST", "/api/v1/minds/{mind_ref}/leave"],
  ["POST", "/api/v1/minds/{mind_ref}/ownership-transfer"],
  ["GET", "/api/v1/invitations"],
  ["GET", "/api/v1/invitations-overview"],
  ["POST", "/api/v1/minds/{mind_ref}/invitations"],
  ["POST", "/api/v1/invitations/{invitation_id}/accept"],
  ["POST", "/api/v1/invitations/{invitation_id}/reject"],
  ["POST", "/api/v1/invitations/{invitation_id}/reissue"],
  ["DELETE", "/api/v1/invitations/{invitation_id}"],
  ["GET", "/api/v1/mcp-tokens"],
  ["POST", "/api/v1/mcp-tokens"],
  ["DELETE", "/api/v1/mcp-tokens/{personal_token_ref}"],
  ["GET", "/api/v1/connections"],
  ["GET", "/api/v1/connections/{connection_ref}"],
  ["DELETE", "/api/v1/connections/{connection_ref}"],
] as const;
