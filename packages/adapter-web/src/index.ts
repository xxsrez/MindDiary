import {
  CONTROL_COMMANDS,
  CONTROL_QUERIES,
} from "@mind-diary/application-control";

export const WEB_APPLICATION_BOUNDARY = {
  queries: CONTROL_QUERIES,
  commands: CONTROL_COMMANDS,
} as const;

export const WEB_CONTROL_ROUTES = [
  ["GET", "/api/v1/session"],
  ["POST", "/api/v1/account"],
  ["PATCH", "/api/v1/account"],
  ["GET", "/api/v1/account/deletion-impact"],
  ["DELETE", "/api/v1/account"],
  ["GET", "/api/v1/minds"],
  ["POST", "/api/v1/minds"],
  ["GET", "/api/v1/minds/{mind_ref}"],
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
  ["POST", "/api/v1/minds/{mind_ref}/invitations"],
  ["POST", "/api/v1/invitations/{invitation_id}/accept"],
  ["POST", "/api/v1/invitations/{invitation_id}/reject"],
  ["DELETE", "/api/v1/invitations/{invitation_id}"],
  ["GET", "/api/v1/mcp-tokens"],
  ["POST", "/api/v1/mcp-tokens"],
  ["DELETE", "/api/v1/mcp-tokens/{token_id}"],
] as const;
