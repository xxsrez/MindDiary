import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMindDiaryUiShellDocument } from "../../../packages/adapter-web/dist/index.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_UI_PORT ?? "4178", 10);
const host = "127.0.0.1";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function fixtureModel(state) {
  const base = {
    displayName: `<img src=x onerror="globalThis.__mindDiaryInjected=true">Andrey`,
    activeNavigation: "minds",
    announcement: "Keyboard and screen-reader fixture ready.",
  };
  if (state === "loading") return { ...base, collection: { kind: "loading" } };
  if (state === "empty") return { ...base, collection: { kind: "empty" } };
  if (state === "error") {
    return {
      ...base,
      collection: {
        kind: "error",
        message: `<script>globalThis.__mindDiaryInjected=true</script> Service unavailable.`,
      },
    };
  }
  return {
    ...base,
    collection: {
      kind: "ready",
      minds: [
        {
          id: "mind_fixture_personal",
          name: `<svg onload="globalThis.__mindDiaryInjected=true">Personal fixture`,
          route: "/me",
          description: `<script>globalThis.__mindDiaryInjected=true</script> Synthetic public test text.`,
          visibility: "private",
          role: "Owner",
          updatedLabel: "Updated at fixture time",
          isPersonal: true,
        },
        {
          id: "mind_fixture_public",
          name: "Shared Research",
          route: "/shared-research",
          description: "A synthetic shared Mind used only for deterministic browser checks.",
          visibility: "public",
          role: "Editor",
          updatedLabel: "Updated at fixture time",
        },
      ],
    },
  };
}

function resolveStaticPath(pathname) {
  if (pathname === "/brand/mind-diary-tokens.css") {
    return resolve(root, "docs/assets/brand/mind-diary-tokens.css");
  }
  if (pathname === "/brand/mind-diary-lockup.svg") {
    return resolve(root, "docs/assets/brand/mind-diary-lockup.svg");
  }
  if (pathname === "/brand/mind-diary-mark.svg") {
    return resolve(root, "docs/assets/brand/mind-diary-mark.svg");
  }
  if (pathname === "/ui/mind-diary-shell.css") {
    return resolve(root, "packages/adapter-web/src/ui-shell.css");
  }
  if (pathname === "/ui/mind-diary-shell-client.js") {
    return resolve(root, "packages/adapter-web/dist/ui-shell-client.js");
  }
  if (pathname === "/ui/ui-shell.js") {
    return resolve(root, "packages/adapter-web/dist/ui-shell.js");
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
    if (url.pathname === "/" || url.pathname === "/minds") {
      const state = url.searchParams.get("state") ?? "ready";
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderMindDiaryUiShellDocument(fixtureModel(state)),
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

server.listen(port, host, async () => {
  const css = await readFile(resolve(root, "packages/adapter-web/src/ui-shell.css"), "utf8");
  if (!css.includes("/brand/mind-diary-tokens.css")) {
    throw new Error("UI fixture did not load the canonical token path");
  }
  process.stdout.write(`Mind Diary UI fixture: http://${host}:${port}/minds\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
