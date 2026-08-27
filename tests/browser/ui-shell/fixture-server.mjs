import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderAuthenticatedOnboardingDocument,
  renderMindDiaryRoutePageDocument,
  renderMindDiaryUiShellDocument,
} from "../../../packages/adapter-web/dist/index.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_UI_PORT ?? "4178", 10);
const host = "127.0.0.1";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
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

function onboardingModel(pathname, state) {
  if (pathname === "/sign-in") {
    return {
      kind: "anonymous",
      authEntryPath: "/signin-with-chatgpt",
    };
  }
  if (pathname === "/welcome") {
    if (state === "bootstrapping") return { kind: "bootstrapping" };
    if (state === "error") {
      return {
        kind: "bootstrap_error",
        displayName: "Fixture User",
        bootstrapIdempotencyKey: "bootstrap-fixture-0001",
        message: "Synthetic setup failure. No private data is included.",
        retryable: true,
      };
    }
    return {
      kind: "registration_required",
      suggestedDisplayName: "Fixture User",
      bootstrapIdempotencyKey: "bootstrap-fixture-0001",
      manualRecoveryStatus: state === "recovery-requested" ? "requested" : "available",
    };
  }
  const profileUpdate = state === "saving"
    ? { kind: "saving", idempotencyKey: "profile-fixture-0001" }
    : state === "saved"
      ? { kind: "saved", message: "Profile name saved.", idempotencyKey: "profile-fixture-0001" }
      : state === "conflict"
        ? { kind: "conflict", message: "Your profile changed in another session." }
        : state === "error"
          ? { kind: "error", message: "Synthetic profile failure.", retryable: true, idempotencyKey: "profile-fixture-0001" }
          : { kind: "idle", idempotencyKey: "profile-fixture-0001" };
  return {
    kind: "authenticated",
    displayName: `<img src=x onerror="globalThis.__mindDiaryInjected=true">Fixture User`,
    profileVersion: 3,
    personalMind: {
      route: "/me",
      name: `<svg onload="globalThis.__mindDiaryInjected=true">Fixture Mind`,
      headRevisionId: "revision_browser_fixture",
      updatedLabel: "Updated at fixture time",
    },
    profileUpdate,
  };
}

const routePages = new Map([
  ["/public", ["public", "Public Minds"]],
  ["/invitations", ["invitations", "Invitations"]],
  ["/settings/account", ["account", "Account and profile"]],
  ["/settings/connections", ["connections", "Connections"]],
  ["/settings/connections/conn_v1_fixture", ["connections", "Fixture connection"]],
  ["/settings/developer/mcp", ["tokens", "Advanced MCP"]],
  ["/help/codex", ["help", "Use Mind Diary with Codex"]],
  ["/help", ["help", "Help and accessibility"]],
  ["/shared-research", ["minds", "Shared Research"]],
]);

function routePageModel(pathname) {
  const route = routePages.get(pathname);
  if (!route) return null;
  return {
    displayName: "Fixture User",
    activeNavigation: route[0],
    shellCurrent: pathname === "/help" ? null : undefined,
    eyebrow: "Administration",
    title: route[1],
    description: "Server-resolved control state without raw Memory content.",
    state: { kind: "ready", message: "Current management state is ready." },
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
  if (pathname === "/ui/onboarding.js") {
    return resolve(root, "packages/adapter-web/dist/onboarding.js");
  }
  if (pathname === "/ui/token-management.js") {
    return resolve(root, "packages/adapter-web/dist/token-management.js");
  }
  if (pathname === "/ui/ordinary-minds-management.js") {
    return resolve(root, "packages/adapter-web/dist/ordinary-minds-management.js");
  }
  if (pathname === "/ui/invitations-membership.js") {
    return resolve(root, "packages/adapter-web/dist/invitations-membership.js");
  }
  if (pathname === "/fixture/onboarding-client.mjs") {
    return resolve(root, "tests/browser/ui-shell/onboarding-client.mjs");
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
    if (["/sign-in", "/welcome", "/me"].includes(url.pathname)) {
      const state = url.searchParams.get("state") ?? "ready";
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderAuthenticatedOnboardingDocument(
          onboardingModel(url.pathname, state),
          "/fixture/onboarding-client.mjs",
        ),
      );
      return;
    }
    const routeModel = routePageModel(url.pathname);
    if (routeModel !== null) {
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderMindDiaryRoutePageDocument(routeModel),
      );
      return;
    }
    if (url.pathname === "/signin-with-chatgpt") {
      sendText(response, 200, "text/html; charset=utf-8", "<!doctype html><title>Fixture auth entry</title><h1>Fixture auth entry</h1>");
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
