import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderInvitationsMembershipDocument } from "../../../packages/adapter-web/dist/invitations-membership.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(
  process.env.MIND_DIARY_AND82_UI_PORT ?? "4282",
  10,
);
const host = "127.0.0.1";

function snapshot(scenario) {
  const invitations = [
    {
      invitationId: scenario === "conflict" ? "invite_conflict" : "invite_incoming",
      direction: "incoming",
      counterpartyDisplayName: "Ada Owner",
      proposedRole: "editor",
      state: "pending",
      expiresAt: "2026-08-12T12:00:00.000Z",
      invitationVersion: 1,
    },
    {
      invitationId: "invite_outgoing",
      direction: "outgoing",
      counterpartyDisplayName: "Pending participant",
      proposedRole: "reader",
      state: "pending",
      expiresAt: "2026-08-12T12:00:00.000Z",
      invitationVersion: 1,
    },
    {
      invitationId: "invite_expired",
      direction: "outgoing",
      counterpartyDisplayName: "Expired participant",
      proposedRole: "editor",
      state: "expired",
      expiresAt: "2026-08-06T12:00:00.000Z",
      invitationVersion: 2,
    },
  ];
  return {
    mind: {
      mindId: "mind_browser_fixture",
      name: "Browser Fixture Mind",
      route: "/browser-fixture",
      metadataVersion: 7,
    },
    actor: {
      memberId: "member_owner",
      role: "owner",
      membershipVersion: 3,
    },
    members: [
      {
        memberId: "member_owner",
        displayName: "Andrey",
        role: "owner",
        state: "active",
        membershipVersion: 3,
        isSelf: true,
      },
      {
        memberId: "member_admin",
        displayName: `<svg onload="globalThis.__mindDiaryInjected=true">Alex Admin`,
        role: "admin",
        state: "active",
        membershipVersion: 4,
        isSelf: false,
      },
      {
        memberId: "member_editor",
        displayName: "Eva Editor",
        role: "editor",
        state: "active",
        membershipVersion: 5,
        isSelf: false,
      },
    ],
    invitations,
  };
}

function pageModel(state, scenario) {
  const base = {
    displayName: `<img src=x onerror="globalThis.__mindDiaryInjected=true">Andrey`,
  };
  if (state === "loading") return { ...base, collection: { kind: "loading" } };
  if (state === "error") {
    return {
      ...base,
      collection: {
        kind: "error",
        message: `<script>globalThis.__mindDiaryInjected=true</script> Synthetic reload error.`,
      },
    };
  }
  return {
    ...base,
    announcement: "Synthetic browser fixture ready.",
    collection: { kind: "ready", snapshot: snapshot(scenario) },
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
  if (pathname === "/ui/invitations-membership.js") {
    return resolve(root, "packages/adapter-web/dist/invitations-membership.js");
  }
  if (pathname === "/ui/ui-shell.js") {
    return resolve(root, "packages/adapter-web/dist/ui-shell.js");
  }
  if (pathname === "/fixture/invitations-membership-client.mjs") {
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
    if (url.pathname === "/" || url.pathname === "/invitations") {
      const state = url.searchParams.get("state") ?? "ready";
      const scenario = url.searchParams.get("scenario") ?? "ready";
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderInvitationsMembershipDocument(
          pageModel(state, scenario),
          "/fixture/invitations-membership-client.mjs",
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
  process.stdout.write(
    `Mind Diary invitations fixture: http://${host}:${port}/invitations\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
