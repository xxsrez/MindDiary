import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderVisibilityCatalogDocument } from "../../../packages/adapter-web/dist/visibility-catalog.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_VISIBILITY_UI_PORT ?? "4184", 10);
const host = "127.0.0.1";

const publicMind = Object.freeze({
  mindId: "mind_fixture_public",
  route: "/published-research",
  name: "Published Research",
  summary: "A synthetic public Mind for deterministic browser checks.",
  visibility: "public",
  isPersonal: false,
  discovery: "public_catalog",
});

const unlistedMind = Object.freeze({
  mindId: "mind_fixture_unlisted",
  route: "/quiet-link",
  name: "Quiet Link",
  summary: "A synthetic unlisted Mind that opens only by exact URL.",
  visibility: "unlisted",
  isPersonal: false,
  discovery: "exact_handle",
});

const hiddenCatalogCandidates = Object.freeze([
  unlistedMind,
  Object.freeze({
    ...publicMind,
    mindId: "mind_fixture_private",
    route: "/private-notes",
    name: "Private Notes",
    visibility: "private",
    discovery: "membership",
  }),
  Object.freeze({
    ...publicMind,
    mindId: "mind_fixture_personal",
    route: "/me",
    name: "Personal Fixture",
    isPersonal: true,
  }),
  Object.freeze({
    ...publicMind,
    mindId: "mind_fixture_exact_public",
    route: "/exact-public",
    name: "Exact-only Public Candidate",
    discovery: "exact_handle",
  }),
]);

function ownerMind(visibility = "private") {
  return {
    mindId: "mind_fixture_owner",
    route: "/owner-settings",
    name: "Owner Settings Fixture",
    summary: "Change visibility here with a synthetic adapter.",
    visibility,
    isPersonal: false,
    discovery: "membership",
    accessKind: "membership",
    role: "owner",
    metadataVersion: 7,
  };
}

function routeMind(item, accessKind = "visibility", role = null) {
  return {
    ...item,
    accessKind,
    role,
    metadataVersion: 4,
  };
}

function fixtureModel(pathname, state) {
  const displayName = `<img src=x onerror="globalThis.__mindDiaryInjected=true">Fixture User`;
  if (pathname === "/public") {
    if (state === "loading") {
      return { kind: "catalog", displayName, authenticated: true, collection: { kind: "loading" } };
    }
    if (state === "empty") {
      return { kind: "catalog", displayName, authenticated: true, collection: { kind: "empty" } };
    }
    if (state === "error") {
      return {
        kind: "catalog",
        displayName,
        authenticated: true,
        collection: {
          kind: "error",
          message: `<script>globalThis.__mindDiaryInjected=true</script> Synthetic catalog failure.`,
        },
      };
    }
    return {
      kind: "catalog",
      displayName,
      authenticated: state !== "anonymous",
      announcement: "Synthetic authenticated catalog ready.",
      collection: {
        kind: "ready",
        minds: [...hiddenCatalogCandidates, publicMind, publicMind],
      },
    };
  }
  if (pathname === "/quiet-link") {
    return {
      kind: "mind",
      displayName,
      mind: routeMind(unlistedMind),
    };
  }
  if (pathname === "/published-research") {
    return {
      kind: "mind",
      displayName,
      mind: routeMind(publicMind),
    };
  }
  if (pathname === "/member-settings") {
    return {
      kind: "mind",
      displayName,
      mind: routeMind(
        {
          ...unlistedMind,
          mindId: "mind_fixture_member",
          route: "/member-settings",
          name: "Member Settings Fixture",
          discovery: "membership",
        },
        "membership",
        "admin",
      ),
    };
  }
  return {
    kind: "mind",
    displayName,
    announcement: "Synthetic Owner route ready.",
    mind: ownerMind(state === "public" ? "public" : state === "unlisted" ? "unlisted" : "private"),
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
  if (pathname === "/ui/visibility-catalog.js") {
    return resolve(root, "packages/adapter-web/dist/visibility-catalog.js");
  }
  if (pathname === "/ui/ui-shell.js") {
    return resolve(root, "packages/adapter-web/dist/ui-shell.js");
  }
  if (pathname === "/fixture/visibility-catalog-client.mjs") {
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
    if (["/", "/public", "/quiet-link", "/published-research", "/owner-settings", "/member-settings"].includes(url.pathname)) {
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderVisibilityCatalogDocument(
          fixtureModel(url.pathname, url.searchParams.get("state") ?? "ready"),
          "/fixture/visibility-catalog-client.mjs",
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
  process.stdout.write(`Mind Diary visibility fixture: http://${host}:${port}/public\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
