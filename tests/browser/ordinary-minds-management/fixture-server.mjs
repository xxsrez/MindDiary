import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderOrdinaryMindsManagementDocument,
} from "../../../packages/adapter-web/dist/ordinary-minds-management.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_ORDINARY_MINDS_UI_PORT ?? "4184", 10);
const host = "127.0.0.1";

const ownerMind = Object.freeze({
  mindId: "mind_fixture_owner",
  handle: "research-notes",
  name: "Research Notes",
  description: "Research decisions and supporting notes.",
  headRevisionId: "revision_fixture_owner",
  visibility: "private",
  role: "owner",
  metadataVersion: 7,
  updatedLabel: "Updated at fixture time",
});

const memberMind = Object.freeze({
  mindId: "mind_fixture_member",
  handle: "shared-library",
  name: "Shared Library",
  description: null,
  headRevisionId: "revision_fixture_member",
  visibility: "unlisted",
  role: "editor",
  metadataVersion: 4,
  updatedLabel: "Updated at fixture time",
});

const personalMind = Object.freeze({
  isPersonal: true,
  mindId: "mind_fixture_personal",
  route: "/me",
  name: "Fixture User",
  headRevisionId: "revision_fixture_personal",
  visibility: "private",
  role: "owner",
  updatedLabel: "Current HEAD is ready",
});

function listModel(state) {
  const base = {
    displayName: `<img src=x onerror="globalThis.__mindDiaryInjected=true">Fixture User`,
    announcement: "Synthetic ordinary-Minds fixture ready.",
  };
  if (state === "loading") return { ...base, view: { kind: "list", collection: { kind: "loading" } } };
  if (state === "empty") return { ...base, view: { kind: "list", collection: { kind: "empty" } } };
  if (state === "error") {
    return {
      ...base,
      view: {
        kind: "list",
        collection: {
          kind: "error",
          message: `<script>globalThis.__mindDiaryInjected=true</script> Synthetic metadata failure.`,
        },
      },
    };
  }
  return {
    ...base,
    view: { kind: "list", collection: { kind: "ready", minds: [memberMind, personalMind, ownerMind] } },
  };
}

function routeModel(pathname) {
  const mind = pathname === "/shared-library" ? memberMind : ownerMind;
  return {
    displayName: "Fixture User",
    view: { kind: "detail", mind },
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
  if (pathname === "/ui/ordinary-minds-management.js") {
    return resolve(root, "packages/adapter-web/dist/ordinary-minds-management.js");
  }
  if (pathname === "/ui/ui-shell.js") {
    return resolve(root, "packages/adapter-web/dist/ui-shell.js");
  }
  if (pathname === "/ui/invitations-membership.js") {
    return resolve(root, "packages/adapter-web/dist/invitations-membership.js");
  }
  if (pathname === "/fixture/ordinary-minds-client.mjs") {
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
    if (url.pathname === "/" || url.pathname === "/minds") {
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderOrdinaryMindsManagementDocument(
          listModel(url.searchParams.get("state") ?? "ready"),
          "/fixture/ordinary-minds-client.mjs",
        ),
      );
      return;
    }
    if (url.pathname === "/research-notes" || url.pathname === "/shared-library") {
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderOrdinaryMindsManagementDocument(
          routeModel(url.pathname),
          "/fixture/ordinary-minds-client.mjs",
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
  process.stdout.write(`Mind Diary ordinary-Minds fixture: http://${host}:${port}/minds\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
