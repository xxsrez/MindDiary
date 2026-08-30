import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMcpTokenManagementDocument } from "../../../packages/adapter-web/dist/index.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_UI_PORT ?? "4183", 10);
const host = "127.0.0.1";

const fixtureToken = Object.freeze({
  tokenId: "tok_fixture_active",
  name: `<svg onload="globalThis.__mindDiaryInjected=true">Codex fixture`,
  displayPrefix: "mdp_v1_Alpha1…",
  scopes: Object.freeze(["content:read", "content:write"]),
  state: "active",
  createdAt: "2026-08-05T22:00:00.000Z",
  expiresAt: "2026-11-03T22:00:00.000Z",
  lastUsedAt: "2026-08-06T12:00:00.000Z",
  revokedAt: null,
});

function fixtureModel(state) {
  const base = {
    displayName: `<img src=x onerror="globalThis.__mindDiaryInjected=true">Andrey`,
  };
  if (state === "loading") return { ...base, collection: { kind: "loading" } };
  if (state === "empty") return { ...base, collection: { kind: "empty" } };
  if (state === "error") {
    return {
      ...base,
      collection: {
        kind: "error",
        message: `<script>globalThis.__mindDiaryInjected=true</script> Synthetic service error.`,
      },
    };
  }
  return {
    ...base,
    announcement: "Synthetic browser fixture ready.",
    collection: { kind: "ready", tokens: [fixtureToken] },
  };
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function resolveStaticPath(pathname) {
  if (pathname === "/brand/mind-diary-tokens.css") {
    return resolve(root, "docs/assets/brand/mind-diary-tokens.css");
  }
  if (pathname === "/brand/mind-diary-lockup.svg") {
    return resolve(root, "docs/assets/brand/mind-diary-lockup.svg");
  }
  if (pathname === "/ui/mind-diary-shell.css") {
    return resolve(root, "packages/adapter-web/src/ui-shell.css");
  }
  if (pathname === "/ui/token-management.js") {
    return resolve(root, "packages/adapter-web/dist/token-management.js");
  }
  if (pathname === "/ui/ui-shell.js") {
    return resolve(root, "packages/adapter-web/dist/ui-shell.js");
  }
  if (pathname === "/fixture/token-management-client.mjs") {
    return resolve(fixtureDirectory, "fixture-client.mjs");
  }
  return null;
}

function sendText(response, status, type, body) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === "/_fixture/health") {
      sendText(response, 200, "application/json; charset=utf-8", '{"ok":true}');
      return;
    }
    if (url.pathname === "/" || url.pathname === "/settings/developer/mcp") {
      const state = url.searchParams.get("state") ?? "ready";
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderMcpTokenManagementDocument(
          fixtureModel(state),
          "/fixture/token-management-client.mjs",
        ),
      );
      return;
    }
    const path = resolveStaticPath(url.pathname);
    if (!path) {
      sendText(response, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    await access(path);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(path)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(path).pipe(response);
  } catch {
    sendText(response, 500, "text/plain; charset=utf-8", "Fixture failure");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Mind Diary MCP token fixture: http://${host}:${port}/settings/developer/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
