import { createServer } from "node:http";

import { createProductWebHttpHandler } from "../../../packages/adapter-web/dist/index.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MIND_DIARY_UI_PORT ?? "4190", 10);
const browserOrigin = `http://${host}:${port}`;
const handlerOrigin = `https://${host}:${port}`;
const csrfToken = "synthetic-browser-csrf";

const registeredActor = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_browser_fixture",
  authentication: Object.freeze({ kind: "sites_identity", verifiedByPlatform: true }),
  requestId: "request_browser_fixture",
  occurredAtUtc: "2026-08-08T00:00:00.000Z",
  deploymentCapabilities: Object.freeze([]),
});

const bootstrapActor = Object.freeze({
  kind: "sites_identity_before_registration",
  authentication: Object.freeze({ kind: "sites_identity", verifiedByPlatform: true }),
  provider: "openai_sites",
  normalizedBinding: "fixture@example.invalid",
  suggestedDisplayName: "Browser Fixture",
  deploymentCapabilities: Object.freeze([]),
  requestId: "request_browser_fixture",
  occurredAtUtc: "2026-08-08T00:00:00.000Z",
});

let registered = false;
let displayName = "Browser Fixture";
let issued = false;

const session = () => ({
  principal: { principalId: registeredActor.principalId, displayName, profileVersion: 1 },
  personalMind: {
    mindId: "space_browser_fixture",
    route: "/me",
    name: displayName,
    visibility: "private",
    metadataVersion: 1,
    headRevisionId: "revision_browser_fixture",
  },
});

const handler = createProductWebHttpHandler({
  applicationOrigin: handlerOrigin,
  resolveIdentity: () => registered
    ? { kind: "authenticated", actor: registeredActor }
    : { kind: "registration_required", actor: bootstrapActor },
  csrf: {
    issue: () => csrfToken,
    verify: (_actor, candidate) => candidate === csrfToken,
  },
  control: {
    execute(request) {
      if (request.operation === "bootstrap_account") {
        registered = true;
        displayName = String(request.input.displayName ?? "Browser Fixture");
        return session();
      }
      if (request.operation === "get_session") return session();
      if (request.operation === "list_minds") {
        return [{
          mindId: "space_browser_fixture",
          route: "/me",
          name: displayName,
          isPersonal: true,
          visibility: "private",
          discovery: "personal",
          access: { kind: "membership", role: "owner", capabilities: ["content:read"] },
          metadataVersion: 1,
          headRevisionId: "revision_browser_fixture",
        }];
      }
      if (request.operation === "list_mcp_tokens") {
        return issued ? [{
          tokenId: "tok_browser_fixture",
          name: "Browser smoke token",
          displayPrefix: "mdp_v1_Browse…",
          scopes: ["content:read"],
          state: "active",
          version: 1,
          createdAt: "2026-08-08T00:00:00.000Z",
          expiresAt: "2026-08-15T00:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        }] : [];
      }
      if (request.operation === "issue_mcp_token") {
        issued = true;
        return {
          token: { tokenId: "tok_browser_fixture", displayPrefix: "mdp_v1_Browse…" },
          secret: "synthetic-browser-secret",
        };
      }
      if (request.operation === "revoke_mcp_token") {
        issued = false;
        return { token: { tokenId: "tok_browser_fixture", state: "revoked" }, replayed: false };
      }
      throw Object.assign(new Error("Unsupported browser fixture operation"), { code: "not_found" });
    },
  },
});

async function nodeRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const headers = new Headers(request.headers);
  if (headers.get("origin") === browserOrigin) headers.set("origin", handlerOrigin);
  return new Request(new URL(request.url ?? "/", handlerOrigin), {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  });
}

async function sendNodeResponse(source, target) {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await source.arrayBuffer()));
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/_fixture/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"ok":true}');
      return;
    }
    const handled = await handler(await nodeRequest(request));
    await sendNodeResponse(handled ?? new Response("Not found", { status: 404 }), response);
  } catch {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Synthetic fixture failure");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Mind Diary production control fixture: ${browserOrigin}/\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
