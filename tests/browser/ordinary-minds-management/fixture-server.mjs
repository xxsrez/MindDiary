import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderOrdinaryMindsManagementDocument,
} from "../../../packages/adapter-web/dist/ordinary-minds-management.js";
import {
  createProductUiStaticAssetResponse,
} from "../../../packages/adapter-web/dist/product-http-static-assets.js";
import {
  withCsrfMeta,
} from "../../../packages/adapter-web/dist/product-http-request-helpers.js";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_ORDINARY_MINDS_UI_PORT ?? "4184", 10);
const host = "127.0.0.1";
const origin = `http://${host}:${port}`;
const csrfToken = "fixture-csrf-token";

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

const initialOrdinaryMinds = () => [{
  mindId: "mind_fixture_owner",
  handle: "research-notes",
  name: "Research Notes",
  description: "Research decisions and supporting notes.",
  headRevisionId: "revision_fixture_owner",
  visibility: "private",
  role: "owner",
  metadataVersion: 7,
  updatedLabel: "Updated at fixture time",
}, {
  mindId: "mind_fixture_member",
  handle: "shared-library",
  name: "Shared Library",
  description: null,
  headRevisionId: "revision_fixture_member",
  visibility: "unlisted",
  role: "editor",
  metadataVersion: 4,
  updatedLabel: "Updated at fixture time",
}];

let ordinaryMinds;
let calls;
let conflictMode;

function resetFixture() {
  ordinaryMinds = initialOrdinaryMinds();
  calls = [];
  conflictMode = null;
}

resetFixture();

function memberProjection(mind) {
  const self = {
    memberId: "member-fixture-self",
    displayName: "Fixture User",
    role: mind.role,
    membershipVersion: 3,
    isSelf: true,
    state: "active",
  };
  const collaborator = {
    memberId: "member-fixture-editor",
    displayName: "Morgan Editor",
    role: mind.role === "owner" ? "editor" : "owner",
    membershipVersion: 5,
    isSelf: false,
    state: "active",
  };
  return [self, collaborator];
}

function collaborationProjection(mind) {
  const members = memberProjection(mind);
  return {
    kind: "ready",
    snapshot: {
      mind: {
        mindId: mind.mindId,
        name: mind.name,
        route: `/${mind.handle}`,
        metadataVersion: mind.metadataVersion,
      },
      actor: {
        memberId: members[0].memberId,
        role: mind.role,
        membershipVersion: members[0].membershipVersion,
      },
      members,
      invitations: [{
        invitationId: "invitation-fixture-pending",
        direction: "outgoing",
        counterpartyDisplayName: "Taylor Reader",
        proposedRole: "reader",
        state: "pending",
        expiresAt: "2026-09-03T12:00:00.000Z",
        invitationVersion: 2,
        canManage: mind.role === "owner" || mind.role === "admin",
      }],
    },
  };
}

function capacityProjection() {
  return {
    kind: "ready",
    usage: {
      logicalHeadBytes: 1_024,
      logicalRetainedBytes: 2_048,
      physicalCanonicalBytes: 1_536,
      temporaryBytes: 0,
      d1MetadataBytes: 512,
      reservedBytes: 0,
      principalPhysicalCanonicalBytes: 1_536,
      mindCanonicalHeadroomBytes: 10_000,
      principalCanonicalHeadroomBytes: 20_000,
      storageAmplification: 1.5,
      utilization: "normal",
    },
  };
}

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
    view: {
      kind: "list",
      collection: { kind: "ready", minds: [ordinaryMinds[1], personalMind, ordinaryMinds[0]].filter(Boolean) },
    },
  };
}

function routeModel(pathname) {
  const handle = pathname.slice(1);
  const mind = ordinaryMinds.find((candidate) => candidate.handle === handle);
  if (!mind) {
    return {
      displayName: "Fixture User",
      view: { kind: "route_error", handle, message: "Mind settings are unavailable." },
    };
  }
  const members = memberProjection(mind);
  return {
    displayName: "Fixture User",
    view: {
      kind: "detail",
      mind,
      collaboration: collaborationProjection(mind),
      ...(mind.role === "owner" ? {
        ownership: { kind: "ready", members },
        capacity: capacityProjection(),
      } : {}),
    },
  };
}

function apiMind(mind) {
  return {
    mind_id: mind.mindId,
    handle: mind.handle,
    route: `/${mind.handle}`,
    is_personal: false,
    name: mind.name,
    description: mind.description,
    visibility: mind.visibility,
    access: { kind: "membership", role: mind.role },
    discovery: "membership",
  };
}

function apiPersonalMind() {
  return {
    mind_id: personalMind.mindId,
    handle: null,
    route: "/me",
    is_personal: true,
    name: personalMind.name,
    visibility: "private",
    access: { kind: "membership", role: "owner" },
  };
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
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

function sendJson(response, status, body) {
  sendText(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function sendApiSuccess(response, data) {
  sendJson(response, 200, { ok: true, data });
}

function sendApiError(response, status, code) {
  sendJson(response, status, { ok: false, error: { code, message: "Synthetic control-plane failure" } });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function recordCall(operation, request, command = null) {
  calls.push({
    operation,
    command,
    csrf: request.headers["x-csrf-token"] ?? null,
    idempotencyKey: request.headers["idempotency-key"] ?? null,
  });
}

function mutationAuthorized(request) {
  return request.headers["x-csrf-token"] === csrfToken &&
    typeof request.headers["idempotency-key"] === "string";
}

async function serveProductAsset(request, response, pathname) {
  const asset = createProductUiStaticAssetResponse(new Request(`${origin}${pathname}`, {
    method: request.method,
  }));
  if (asset === null) return false;
  const body = Buffer.from(await asset.arrayBuffer());
  response.writeHead(asset.status, Object.fromEntries(asset.headers.entries()));
  response.end(body);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/_fixture/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/_fixture/reset" && request.method === "POST") {
      resetFixture();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/_fixture/conflict" && request.method === "POST") {
      const body = await readJson(request);
      conflictMode = body?.mode === "downgrade" || body?.mode === "revoke" ? body.mode : null;
      sendJson(response, 200, { ok: true, mode: conflictMode });
      return;
    }
    if (url.pathname === "/_fixture/calls") {
      sendJson(response, 200, { ok: true, calls });
      return;
    }

    if (url.pathname === "/api/v1/minds" && request.method === "GET") {
      recordCall("listMinds", request);
      sendApiSuccess(response, [ordinaryMinds[1], apiPersonalMind(), ordinaryMinds[0]]
        .filter(Boolean)
        .map((mind) => mind.is_personal === true ? mind : apiMind(mind)));
      return;
    }
    if (url.pathname === "/api/v1/minds" && request.method === "POST") {
      const body = await readJson(request);
      recordCall("createMind", request, body);
      if (!mutationAuthorized(request)) {
        sendApiError(response, 403, "csrf_failed");
        return;
      }
      if (body?.handle === "unavailable-mind") {
        sendApiError(response, 409, "handle_unavailable");
        return;
      }
      const created = {
        mindId: `mind_fixture_${body.handle}`,
        handle: body.handle,
        name: body.name,
        description: body.description ?? null,
        headRevisionId: "revision_fixture_created",
        visibility: "private",
        role: "owner",
        metadataVersion: 1,
        updatedLabel: "Created at fixture time",
      };
      ordinaryMinds = [created, ...ordinaryMinds.filter((mind) => mind.handle !== created.handle)];
      sendApiSuccess(response, { route: `/${created.handle}` });
      return;
    }

    const impactMatch = url.pathname.match(/^\/api\/v1\/minds\/([^/]+)\/deletion-impact$/u);
    if (impactMatch && request.method === "GET") {
      const handle = decodeURIComponent(impactMatch[1]);
      const mind = ordinaryMinds.find((candidate) => candidate.handle === handle);
      recordCall("getDeletionImpact", request, { handle });
      if (!mind || mind.role !== "owner") {
        sendApiError(response, 403, "forbidden");
        return;
      }
      sendApiSuccess(response, {
        impact_id: "impact_fixture_owner_0001",
        expires_at: "2026-09-03T12:45:00.000Z",
        mind: { route: `/${handle}`, name: mind.name },
        revision_count: 12,
        membership_count: 3,
        pending_invitation_count: 2,
        background_job_count: 1,
        export_job_count: 1,
        irreversible: true,
        recovery_available: false,
        forensic_receipt_retained: false,
        confirmation: `delete-mind:${handle}`,
      });
      return;
    }

    const visibilityMatch = url.pathname.match(/^\/api\/v1\/minds\/([^/]+)\/visibility$/u);
    if (visibilityMatch && request.method === "PUT") {
      const handle = decodeURIComponent(visibilityMatch[1]);
      const body = await readJson(request);
      recordCall("changeVisibility", request, { handle, ...body });
      const mind = ordinaryMinds.find((candidate) => candidate.handle === handle);
      if (!mutationAuthorized(request) || !mind || mind.role !== "owner") {
        sendApiError(response, 403, "forbidden");
        return;
      }
      mind.visibility = body.visibility;
      mind.metadataVersion += 1;
      sendApiSuccess(response, { visibility: mind.visibility });
      return;
    }

    const ownershipMatch = url.pathname.match(/^\/api\/v1\/minds\/([^/]+)\/ownership-transfer$/u);
    if (ownershipMatch && request.method === "POST") {
      const handle = decodeURIComponent(ownershipMatch[1]);
      const body = await readJson(request);
      recordCall("transferOwnership", request, { handle, ...body });
      const mind = ordinaryMinds.find((candidate) => candidate.handle === handle);
      if (!mutationAuthorized(request) || !mind || mind.role !== "owner") {
        sendApiError(response, 403, "forbidden");
        return;
      }
      mind.role = "admin";
      mind.metadataVersion += 1;
      sendApiSuccess(response, { role: "admin" });
      return;
    }

    const mindMatch = url.pathname.match(/^\/api\/v1\/minds\/([^/]+)$/u);
    if (mindMatch && request.method === "PATCH") {
      const handle = decodeURIComponent(mindMatch[1]);
      const body = await readJson(request);
      recordCall("updateMetadata", request, { handle, ...body });
      const index = ordinaryMinds.findIndex((candidate) => candidate.handle === handle);
      if (!mutationAuthorized(request) || index < 0) {
        sendApiError(response, 403, "forbidden");
        return;
      }
      const mind = ordinaryMinds[index];
      if (conflictMode === "downgrade") {
        ordinaryMinds[index] = { ...mind, role: "reader", metadataVersion: mind.metadataVersion + 1 };
        conflictMode = null;
        sendApiError(response, 409, "metadata_conflict");
        return;
      }
      if (conflictMode === "revoke") {
        ordinaryMinds.splice(index, 1);
        conflictMode = null;
        sendApiError(response, 409, "metadata_conflict");
        return;
      }
      if (body.expected_metadata_version !== mind.metadataVersion) {
        sendApiError(response, 409, "metadata_conflict");
        return;
      }
      mind.name = body.name;
      mind.description = body.description;
      mind.metadataVersion += 1;
      sendApiSuccess(response, { route: `/${handle}` });
      return;
    }
    if (mindMatch && request.method === "DELETE") {
      const handle = decodeURIComponent(mindMatch[1]);
      const body = await readJson(request);
      recordCall("deleteMind", request, { handle, ...body });
      if (!mutationAuthorized(request) ||
          body?.impact_id !== "impact_fixture_owner_0001" ||
          body?.confirmation !== `delete-mind:${handle}`) {
        sendApiError(response, 409, "deletion_impact_changed");
        return;
      }
      ordinaryMinds = ordinaryMinds.filter((mind) => mind.handle !== handle);
      sendApiSuccess(response, { replayed: false });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/minds") {
      const document = renderOrdinaryMindsManagementDocument(
        listModel(url.searchParams.get("state") ?? "ready"),
        "/ui/mind-diary-ordinary-minds-client.js",
      );
      sendText(response, 200, "text/html; charset=utf-8", withCsrfMeta(document, csrfToken));
      return;
    }
    if (/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(url.pathname)) {
      const document = renderOrdinaryMindsManagementDocument(
        routeModel(url.pathname),
        "/ui/mind-diary-ordinary-minds-client.js",
      );
      sendText(response, 200, "text/html; charset=utf-8", withCsrfMeta(document, csrfToken));
      return;
    }
    if (await serveProductAsset(request, response, url.pathname)) return;
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
  } catch (error) {
    sendText(response, 500, "text/plain; charset=utf-8", `Fixture failure: ${error instanceof Error ? error.message : "unknown"}`);
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Mind Diary ordinary-Minds fixture: ${origin}/minds\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
