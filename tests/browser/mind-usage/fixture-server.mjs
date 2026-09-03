import { createServer } from "node:http";

import {
  createProductWebHttpHandler,
} from "../../../packages/adapter-web/dist/index.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MIND_DIARY_BROWSER_FIXTURE_PORT ?? "4334", 10);
const origin = `http://${host}:${port}`;
const csrf = "mind-usage-browser-csrf";
const actor = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_browser_usage",
  authentication: Object.freeze({ kind: "sites_identity", verifiedByPlatform: true }),
  requestId: "request_browser_usage",
  occurredAtUtc: "2026-08-30T20:00:00.000Z",
  deploymentCapabilities: Object.freeze([]),
});
const personal = Object.freeze({
  mindId: "space_personal_browser",
  route: "/me",
  name: "Personal strategy",
  isPersonal: true,
  visibility: "private",
  discovery: "personal",
  access: Object.freeze({ kind: "membership", role: "owner", capabilities: ["content:read", "content:write"] }),
  metadataVersion: 2,
  headRevisionId: "revision_personal_browser",
});
const research = Object.freeze({
  mindId: "space_research_browser",
  route: "/research-notes",
  handle: "research-notes",
  name: "Research notes",
  description: "Research decisions, evidence, and reusable conclusions.",
  isPersonal: false,
  visibility: "unlisted",
  discovery: "membership",
  access: Object.freeze({ kind: "membership", role: "owner", capabilities: ["content:read", "content:write"] }),
  metadataVersion: 4,
  headRevisionId: "revision_research_browser",
});
const archive = Object.freeze({
  mindId: "space_archive_browser",
  route: "/archive",
  handle: "archive",
  name: "Archive without description",
  description: null,
  isPersonal: false,
  visibility: "private",
  discovery: "membership",
  access: Object.freeze({ kind: "membership", role: "reader", capabilities: ["content:read"] }),
  metadataVersion: 1,
  headRevisionId: "revision_archive_browser",
});
const minds = Object.freeze([personal, research, archive]);
let usage = null;

const control = {
  execute(request) {
    if (request.operation === "get_session") return {
      principal: { displayName: "Browser Fixture", profileVersion: 1 },
      personalMind: {
        name: personal.name,
        metadataVersion: personal.metadataVersion,
        headRevisionId: personal.headRevisionId,
      },
    };
    if (request.operation === "list_minds") return minds;
    if (request.operation === "get_mind_info") {
      return minds.find((mind) =>
        request.input.mind_ref === (mind.isPersonal ? "me" : mind.handle)) ?? null;
    }
    throw Object.assign(new Error("not found"), { code: "not_found" });
  },
};

const mindUsage = {
  read() { return usage; },
  mutate(command) {
    const version = usage?.usageVersion ?? 0;
    if (command.expectedUsageVersion !== version) return { kind: "usage_version_conflict" };
    const selected = minds.find((mind) => mind.mindId === command.spaceId);
    if (selected === undefined) return { kind: "mind_not_found" };
    if (command.usageMode === "read_write" && !selected.isPersonal && selected.description === null) {
      return { kind: "description_required" };
    }
    if (command.usageMode === "read_write" && !["editor", "admin", "owner"].includes(selected.access.role)) {
      return { kind: "writer_access_required" };
    }
    const entries = new Map((usage?.entries ?? []).map((entry) => [entry.spaceId, entry.usageMode]));
    if (command.usageMode === "disabled") entries.delete(command.spaceId);
    else {
      if (command.usageMode === "read_write") {
        for (const [spaceId, mode] of entries) {
          if (mode === "read_write" && spaceId !== command.spaceId) entries.set(spaceId, "read");
        }
      }
      entries.set(command.spaceId, command.usageMode);
    }
    usage = Object.freeze({
      contractVersion: "principal-mind-usage/v1",
      principalId: actor.principalId,
      usageVersion: version + 1,
      entries: Object.freeze([...entries].map(([spaceId, usageMode]) =>
        Object.freeze({ spaceId, usageMode }))),
    });
    return { kind: "applied", state: usage, changed: true, replayed: false };
  },
};

const handler = createProductWebHttpHandler({
  applicationOrigin: origin,
  resolveIdentity: () => ({
    kind: "authenticated",
    actor,
    session: {
      principal: { displayName: "Browser Fixture", profileVersion: 1 },
      personalMind: {
        name: personal.name,
        metadataVersion: personal.metadataVersion,
        headRevisionId: personal.headRevisionId,
      },
    },
  }),
  csrf: { issue: () => csrf, verify: (_actor, token) => token === csrf },
  control,
  mindUsage,
});

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", origin);
  if (url.pathname === "/_fixture/health") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end('{"ok":true}');
    return;
  }
  if (url.pathname === "/_fixture/conflict" && incoming.method === "POST") {
    const current = usage ?? {
      contractVersion: "principal-mind-usage/v1",
      principalId: actor.principalId,
      usageVersion: 0,
      entries: Object.freeze([]),
    };
    usage = Object.freeze({ ...current, usageVersion: current.usageVersion + 1 });
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end('{"ok":true}');
    return;
  }
  const body = await requestBody(incoming);
  const response = await handler(new Request(url, {
    method: incoming.method,
    headers: incoming.headers,
    ...(body === undefined || incoming.method === "GET" || incoming.method === "HEAD"
      ? {}
      : { body }),
  }));
  if (response === null) {
    outgoing.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Not found");
    return;
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, host, () => {
  process.stdout.write(`Mind usage browser fixture: ${origin}/\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
