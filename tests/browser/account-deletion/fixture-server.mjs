import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderAccountDeletionDocument } from "../../../packages/adapter-web/dist/account-deletion.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_ACCOUNT_DELETION_PORT ?? "4184", 10);
const host = "127.0.0.1";

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
  if (pathname === "/ui/account-deletion.js") {
    return resolve(root, "packages/adapter-web/dist/account-deletion.js");
  }
  if (pathname === "/ui/ui-shell.js") {
    return resolve(root, "packages/adapter-web/dist/ui-shell.js");
  }
  if (pathname === "/fixture/account-deletion-client.mjs") {
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
    if (url.pathname === "/" || url.pathname === "/settings/account/delete") {
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderAccountDeletionDocument(
          {
            displayName: `<img src=x onerror="globalThis.__mindDiaryInjected=true">Fixture User`,
            state: { kind: "loading" },
          },
          "/fixture/account-deletion-client.mjs",
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
  process.stdout.write(`Mind Diary account-deletion fixture: http://${host}:${port}/settings/account/delete\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
