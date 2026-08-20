import { createHash } from "node:crypto";

export const MCP_PROTOCOL = "2026-07-28";

export const SYNTHETIC_ASSERTION_IDS = Object.freeze([
  "activation.test-only-composition",
  "bootstrap.distinct-ordinary-principals",
  "bootstrap.distinct-personal-minds",
  "bootstrap.idempotent-replay",
  "bootstrap.synthetic-binding-namespace",
  "personal-isolation.cross-account-denied",
  "tokens.distinct-principal-bound",
  "private.web-non-enumeration",
  "private.list-non-enumeration",
  "private.history-non-enumeration",
  "visibility.public-baseline-read-only",
  "visibility.public-catalog-only",
  "visibility.unlisted-exact-only",
  "visibility.private-immediate-revoke",
  "invitation.pending-access-denied",
  "invitation.accept-replay-single-membership",
  "role-transition.reader-read-only",
  "role-transition.editor-controlled-commit",
  "role-transition.stale-head-no-partial-state",
  "background.search-and-audit-materialized",
  "ownership-transfer.exactly-one-owner",
  "restart-persistence.accounts-personal-minds",
  "restart-persistence.owner-head-history-tokens",
  "web-revoke.next-request-denied",
  "mcp-revoke.next-request-denied",
  "history-revoke.next-request-denied",
  "cleanup.ordinary-mind-deleted",
  "cleanup.tokens-revoked",
  "cleanup.accounts-deleted",
  "cleanup.background-work-drained",
  "cleanup.negative-state-scan",
  "production-negative.no-synthetic-authority",
]);

export class ProbeFailure extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ProbeFailure";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function fail(code, details) {
  throw new ProbeFailure(code, details);
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function required(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

export function candidateSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    fail("invalid_candidate_sha");
  }
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Shared historical/synthetic receipt guard. It never inspects live responses. */
export function assertRedactedDocument(value) {
  const text = JSON.stringify(value);
  for (const pattern of [
    /mdp_v1_/iu,
    /mdo_(?:code|access|refresh)_/iu,
    /OAI-Sites-Authorization/iu,
    /authorization["']?\s*:/iu,
    /cookie["']?\s*:/iu,
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
  ]) {
    if (pattern.test(text)) fail("unsafe_evidence_document");
  }
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      typeof current === "string" &&
      /^(?:principal|space|token)_[a-z0-9]/iu.test(current)
    ) {
      fail("unsafe_evidence_document");
    }
    if (Array.isArray(current)) pending.push(...current);
    else if (isRecord(current)) pending.push(...Object.values(current));
  }
  return value;
}

export function safeCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "unexpected_response";
}

export function data(response, code = "invalid_projection") {
  if (!isRecord(response.body?.data)) fail(code);
  return response.body.data;
}

export function mcpResultData(response, code = "mcp_request_failed") {
  const result = response.body?.result;
  if (
    response.status !== 200 ||
    result?.isError === true ||
    !isRecord(result?.structuredContent?.data)
  ) {
    fail(code, {
      status: response.status,
      applicationCode: safeCode(result?.structuredContent?.error?.code),
    });
  }
  return result.structuredContent.data;
}

export class MultiPrincipalActorClient {
  constructor({ origin, actorClass, identitySnapshot, dispatch }) {
    this.origin = origin;
    this.actorClass = actorClass;
    this.identitySnapshot = Object.freeze({ ...identitySnapshot });
    this.dispatch = dispatch;
    this.mcpToken = null;
    this.mcpTokenId = null;
  }

  setMcpCredential({ secret, tokenId }) {
    if (typeof secret !== "string" || !secret.startsWith("mdp_v1_")) {
      fail("invalid_mcp_token_reference");
    }
    if (typeof tokenId !== "string" || tokenId.length === 0) {
      fail("invalid_mcp_token_id");
    }
    this.mcpToken = secret;
    this.mcpTokenId = tokenId;
  }

  async request(path, options = {}) {
    const request = new Request(new URL(path, this.origin), {
      ...options,
      headers: new Headers(options.headers ?? {}),
      redirect: "error",
    });
    const response = await this.dispatch(request, this.identitySnapshot);
    if (!(response instanceof Response)) fail("runtime_route_unavailable");
    const text = await response.text();
    let body = null;
    if (text && response.headers.get("content-type")?.includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        fail("invalid_json_response", {
          actorClass: this.actorClass,
          status: response.status,
        });
      }
    }
    return Object.freeze({ status: response.status, body, text });
  }

  async csrf(path = "/") {
    const response = await this.request(path);
    const match = response.status === 200 &&
      /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(response.text);
    if (!match) {
      fail("csrf_token_missing", {
        actorClass: this.actorClass,
        status: response.status,
      });
    }
    return match[1];
  }

  async api(path, {
    method = "GET",
    body,
    idempotencyKey,
    expectedStatus = 200,
    csrfPath = "/minds",
  } = {}) {
    const headers = { accept: "application/json" };
    if (method !== "GET") {
      headers.origin = this.origin;
      headers["x-csrf-token"] = await this.csrf(csrfPath);
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const response = await this.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== expectedStatus) {
      fail("api_request_failed", {
        actorClass: this.actorClass,
        status: response.status,
        code: safeCode(response.body?.error?.code),
      });
    }
    return response;
  }

  async session(bootstrapKey) {
    let response = await this.request("/api/v1/session", {
      headers: { accept: "application/json" },
    });
    if (
      response.status === 409 &&
      response.body?.error?.code === "registration_required" &&
      bootstrapKey
    ) {
      await this.api("/api/v1/account", {
        method: "POST",
        body: { action: "create_isolated_account" },
        idempotencyKey: bootstrapKey,
        csrfPath: "/",
      });
      response = await this.request("/api/v1/session", {
        headers: { accept: "application/json" },
      });
    }
    if (response.status !== 200 || !isRecord(response.body?.data)) {
      fail("session_unavailable", {
        actorClass: this.actorClass,
        status: response.status,
      });
    }
    return response.body.data;
  }

  async issueMcpToken({ name, idempotencyKey }) {
    const issued = data(await this.api("/api/v1/mcp-tokens", {
      method: "POST",
      body: { name, scopes: ["content:write"] },
      idempotencyKey,
      csrfPath: "/settings/mcp",
    }), "token_issue_failed");
    this.setMcpCredential({
      secret: issued.secret,
      tokenId: issued.token?.token_id,
    });
    return Object.freeze({ secret: this.mcpToken, tokenId: this.mcpTokenId });
  }

  async mcp(name, args = {}) {
    if (this.mcpToken === null) fail("mcp_token_not_issued");
    return this.request("/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.mcpToken}`,
        "content-type": "application/json; charset=utf-8",
        "mcp-method": "tools/call",
        "mcp-name": name,
        "mcp-protocol-version": MCP_PROTOCOL,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${this.actorClass}-${name}`,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": {
              name: "synthetic-multi-principal-probe",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }
}
