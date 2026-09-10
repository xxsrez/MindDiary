import { createServer } from "node:http";

import {
  renderAdvancedMcpPageDocument,
  renderCodexHelpPageDocument,
  renderConnectionDetailDocument,
  renderConnectionsPageDocument,
} from "../../../packages/adapter-web/dist/index.js";
import {
  PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
  PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT,
  PRODUCT_UI_APPLE_TOUCH_ICON_PNG,
  PRODUCT_UI_CLIENT_JAVASCRIPT,
  PRODUCT_UI_FAVICON_ICO,
  PRODUCT_UI_FAVICON_PNG,
  PRODUCT_UI_FAVICON_SVG,
  PRODUCT_UI_LOCKUP_SVG,
  PRODUCT_UI_MARK_SVG,
  PRODUCT_UI_SHELL_CSS,
  PRODUCT_UI_TOKENS_CSS,
} from "../../../packages/adapter-web/dist/product-ui-assets.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MIND_DIARY_BROWSER_FIXTURE_PORT ?? "4310", 10);
const requestedCount = Number.parseInt(process.env.MIND_DIARY_BROWSER_FIXTURE_COUNT ?? "1", 10);
const pageSize = 20;
const csrfToken = "browser-fixture-csrf";

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new TypeError("browser fixture port is invalid");
}
if (![0, 1, pageSize + 1].includes(requestedCount)) {
  throw new TypeError("browser fixture count must be 0, 1, or page_size + 1");
}

function presentationRef(prefix, index) {
  return `${prefix}${index.toString(16).padStart(32, "0")}`;
}

const connections = Array.from({ length: requestedCount }, (_, offset) => {
  const index = offset + 1;
  return Object.freeze({
    connectionRef: presentationRef("conn_v1_", index),
    clientName: index === 1
      ? "Codex Marketplace on a deliberately narrow mobile viewport"
      : `Fixture connection ${index}`,
    createdAt: `2026-08-${String(Math.min(index, 24)).padStart(2, "0")}T10:00:00.000Z`,
    lastUsedAt: index % 2 === 0 ? null : "2026-08-24T12:00:00.000Z",
    canRead: true,
    canWrite: index === 1,
  });
});

const personalTokens = Array.from({ length: requestedCount }, (_, offset) => {
  const index = offset + 1;
  return Object.freeze({
    personalTokenRef: presentationRef("ptok_v1_", index),
    name: index === 1
      ? "Recovery token with a deliberately long mobile label"
      : `Fixture personal token ${index}`,
    displayPrefix: `mdp_v1_Fixture${String(index).padStart(2, "0")}…`,
    scopes: Object.freeze(index === 1
      ? ["content:read", "content:write"]
      : ["content:read"]),
    state: "active",
    createdAt: "2026-08-24T10:00:00.000Z",
    expiresAt: "2026-11-22T10:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  });
});

const revokedConnections = new Set();
const revokedTokens = new Set();
let createdToken = null;

function cookie(request, name) {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function activeConnections() {
  return connections.filter((item) => !revokedConnections.has(item.connectionRef));
}

function activeTokens() {
  return [
    ...(createdToken === null || revokedTokens.has(createdToken.personalTokenRef)
      ? []
      : [createdToken]),
    ...personalTokens.filter((item) => !revokedTokens.has(item.personalTokenRef)),
  ];
}

function tokensForState(state) {
  const all = [
    ...(createdToken === null ? [] : [createdToken]),
    ...personalTokens,
  ];
  if (state === "revoked") {
    return all
      .filter((item) => revokedTokens.has(item.personalTokenRef))
      .map((item) => Object.freeze({ ...item, state: "revoked", revokedAt: "2026-08-28T00:00:00.000Z" }));
  }
  if (state === "expired") {
    return personalTokens.slice(0, Math.min(requestedCount, 1)).map((item) => Object.freeze({
      ...item,
      state: "expired",
      expiresAt: "2026-08-01T00:00:00.000Z",
    }));
  }
  return activeTokens();
}

function page(items, cursor) {
  const start = cursor === "fixture-next" ? pageSize : 0;
  const visible = items.slice(start, start + pageSize);
  return Object.freeze({
    items: Object.freeze(visible),
    nextCursor: start === 0 && items.length > pageSize ? "fixture-next" : null,
  });
}

function withFixtureMeta(html) {
  return html.replace(
    "<head>",
    `<head>\n  <meta name="mind-diary-csrf-token" content="${csrfToken}">`,
  );
}

function send(response, status, type, body, headers = {}) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function json(response, status, value) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const method = request.method ?? "GET";
    if (url.pathname === "/_fixture/health") {
      json(response, 200, { ok: true, count: requestedCount });
      return;
    }
    if (url.pathname === "/_fixture/reconnect" && method === "POST") {
      revokedConnections.clear();
      json(response, 200, { ok: true });
      return;
    }
    if (
      url.pathname === "/" &&
      method === "HEAD" &&
      request.headers["x-mind-diary-recovery-pulse"] === "1"
    ) {
      send(response, 200, "text/html; charset=utf-8", "");
      return;
    }
    if (url.pathname === "/brand/mind-diary-tokens.css") {
      send(response, 200, "text/css; charset=utf-8", PRODUCT_UI_TOKENS_CSS);
      return;
    }
    if (url.pathname === "/ui/mind-diary-shell.css") {
      send(response, 200, "text/css; charset=utf-8", PRODUCT_UI_SHELL_CSS);
      return;
    }
    if (url.pathname === "/brand/mind-diary-lockup.svg") {
      send(response, 200, "image/svg+xml; charset=utf-8", PRODUCT_UI_LOCKUP_SVG);
      return;
    }
    if (url.pathname === "/brand/mind-diary-mark.svg") {
      send(response, 200, "image/svg+xml; charset=utf-8", PRODUCT_UI_MARK_SVG);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      send(response, 200, "image/x-icon", PRODUCT_UI_FAVICON_ICO);
      return;
    }
    if (url.pathname === "/favicon.svg") {
      send(response, 200, "image/svg+xml; charset=utf-8", PRODUCT_UI_FAVICON_SVG);
      return;
    }
    if (url.pathname === "/favicon-32x32.png") {
      send(response, 200, "image/png", PRODUCT_UI_FAVICON_PNG);
      return;
    }
    if (url.pathname === "/apple-touch-icon.png") {
      send(response, 200, "image/png", PRODUCT_UI_APPLE_TOUCH_ICON_PNG);
      return;
    }
    if (url.pathname === "/ui/mind-diary-connections-client.js") {
      send(
        response,
        200,
        "text/javascript; charset=utf-8",
        `${PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT}\n${PRODUCT_UI_CLIENT_JAVASCRIPT}\n${PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT}`,
      );
      return;
    }

    const errorFixture = cookie(request, "fixture_view") === "error";
    if (url.pathname === "/settings/connections" && method === "GET") {
      const active = activeConnections();
      const result = page(active, url.searchParams.get("cursor"));
      const collection = errorFixture
        ? { kind: "error", message: "Deterministic connection failure." }
        : active.length === 0
          ? { kind: "empty" }
          : { kind: "ready", ...result };
      send(response, 200, "text/html; charset=utf-8", withFixtureMeta(
        renderConnectionsPageDocument({ displayName: "Browser Fixture", collection }),
      ));
      return;
    }
    if (url.pathname === "/settings/developer/mcp" && method === "GET") {
      const state = ["active", "revoked", "expired"].includes(url.searchParams.get("state"))
        ? url.searchParams.get("state")
        : "active";
      const tokens = tokensForState(state);
      const result = page(tokens, url.searchParams.get("cursor"));
      const collection = errorFixture
        ? { kind: "error", message: "Deterministic personal-token failure." }
        : tokens.length === 0
          ? { kind: "empty" }
          : {
              kind: "ready",
              items: result.items,
              nextCursor: result.nextCursor,
            };
      send(response, 200, "text/html; charset=utf-8", withFixtureMeta(
        renderAdvancedMcpPageDocument({
          displayName: "Browser Fixture",
          siteOrigin: `http://${host}:${port}`,
          state,
          collection,
        }),
      ));
      return;
    }
    if (url.pathname === "/help/codex" && method === "GET") {
      send(response, 200, "text/html; charset=utf-8", withFixtureMeta(
        renderCodexHelpPageDocument("Browser Fixture", "https://mind-diary.example.invalid"),
      ));
      return;
    }

    if (url.pathname === "/api/v1/connections" && method === "GET") {
      if (errorFixture) {
        json(response, 503, { error: { code: "operation_failed", message: "Fixture failure." } });
        return;
      }
      const result = page(activeConnections(), url.searchParams.get("cursor"));
      json(response, 200, {
        ok: true,
        data: {
          items: result.items.map((item) => ({
            connection_ref: item.connectionRef,
            client_name: item.clientName,
            created_at: item.createdAt,
            last_used_at: item.lastUsedAt,
            can_read: item.canRead,
            can_write: item.canWrite,
          })),
          next_cursor: result.nextCursor,
        },
      });
      return;
    }

    const connectionMatch = /^\/settings\/connections\/(conn_v1_[0-9a-f]{32})$/u.exec(url.pathname);
    if (connectionMatch && method === "GET") {
      const item = activeConnections().find((candidate) =>
        candidate.connectionRef === connectionMatch[1]);
      if (item === undefined) {
        send(response, 404, "text/plain; charset=utf-8", "Not found");
        return;
      }
      send(response, 200, "text/html; charset=utf-8", withFixtureMeta(
        renderConnectionDetailDocument({
          displayName: "Browser Fixture",
          connection: item,
        }),
      ));
      return;
    }

    const connectionApi = /^\/api\/v1\/connections\/(conn_v1_[0-9a-f]{32})$/u.exec(url.pathname);
    if (connectionApi && method === "DELETE") {
      await new Promise((resolve) => setTimeout(resolve, 80));
      revokedConnections.add(connectionApi[1]);
      json(response, 200, { ok: true, data: { revoked: true } });
      return;
    }
    if (url.pathname === "/api/v1/mcp-tokens" && method === "POST") {
      const command = await body(request);
      createdToken = Object.freeze({
        personalTokenRef: presentationRef("ptok_v1_", 999),
        name: typeof command?.name === "string" ? command.name : "Browser-created token",
        displayPrefix: "mdp_v1_Browser…",
        scopes: Object.freeze([
          ...(command?.scopes?.includes("content:write")
            ? ["content:read", "content:write"] : ["content:read"]),
          ...(command?.scopes?.includes("personal:configure") ? ["personal:configure"] : []),
        ]),
        state: "active",
        createdAt: "2026-08-24T12:00:00.000Z",
        expiresAt: "2026-11-22T12:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      });
      json(response, 200, {
        ok: true,
        data: { token: createdToken, secret: "[deterministic one-time fixture value]" },
      });
      return;
    }
    const tokenApi = /^\/api\/v1\/mcp-tokens\/(ptok_v1_[0-9a-f]{32})$/u.exec(url.pathname);
    if (tokenApi && method === "DELETE") {
      revokedTokens.add(tokenApi[1]);
      json(response, 200, { ok: true, data: { token: { state: "revoked" } } });
      return;
    }
    if (
      url.pathname === "/api/v1/session" ||
      url.pathname === "/api/mcp" ||
      url.pathname === "/api/mcp/2025-11-25"
    ) {
      json(response, 401, { error: { code: "fixture_diagnostic_denied" } });
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found");
  } catch {
    send(response, 500, "text/plain; charset=utf-8", "Browser fixture failure");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Mind Diary Connections browser fixture: http://${host}:${port}/\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
