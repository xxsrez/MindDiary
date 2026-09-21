import { createHash } from "node:crypto";
import { createServer } from "node:http";

import {
  renderOrdinaryMindsManagementDocument,
} from "../../../packages/adapter-web/dist/ordinary-minds-management.js";
import {
  createProductUiStaticAssetResponse,
} from "../../../packages/adapter-web/dist/product-http.js";

const port = Number.parseInt(process.env.MIND_DIARY_MARKDOWN_IMPORT_UI_PORT ?? "4192", 10);
const host = "127.0.0.1";
const origin = `http://${host}:${port}`;

const writerMind = Object.freeze({
  mindId: "mind_import_fixture",
  handle: "research-notes",
  name: "Research Notes",
  description: null,
  headRevisionId: "revision_import_base",
  visibility: "private",
  role: "owner",
  metadataVersion: 7,
  updatedLabel: "Updated at fixture time",
});

let scenario = "fresh";
let plan = null;
let session = null;
let startCalls = 0;
let commitCalls = 0;
let batchCalls = 0;
let statusReadCalls = 0;
let statusFailuresRemaining = 0;
let revoked = false;

const snakePlan = (files = [
  { path: "private/secret.md", sha256: "sha256:fixture", size: 16 },
]) => Object.freeze({
  plan_id: "plan_import_fixture",
  expected_revision_id: writerMind.headRevisionId,
  descriptor_hash: descriptorHash(files),
  file_count: files.length,
  logical_bytes: files.reduce((total, file) => total + file.size, 0),
  additions: Math.max(0, files.length - 1),
  replacements: Math.min(1, files.length),
  deletions: 2,
  unchanged: 0,
  projected_utilization: scenario === "capacity" ? "hard_limit" : "normal",
});

function descriptorHash(files) {
  return `sha256:${createHash("sha256").update(JSON.stringify(
    files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  )).digest("hex")}`;
}

function openSession(state = "active") {
  return {
    import_id: "import_recovery",
    plan_id: "plan_import_fixture",
    expected_revision_id: writerMind.headRevisionId,
    state,
    version: 3,
    checkpoint: state === "active" ? 0 : 1,
    staged_file_count: state === "active" ? 0 : 1,
    staged_bytes: state === "active" ? 0 : 16,
    validation_checkpoint: state === "validating" ? 1 : 0,
    validated_bytes: 0,
    promotion_checkpoint: state === "finalizing" ? 1 : 0,
    promoted_bytes: 0,
    failures: state === "validation_failed"
      ? [{ path: "(snapshot)", code: "import_head_conflict" }]
      : [],
    revision_id: state === "committed" ? "revision_already_committed" : null,
  };
}

function reset(nextScenario) {
  scenario = nextScenario;
  plan = snakePlan();
  session = nextScenario === "open"
    ? openSession("active")
    : nextScenario === "validating" || nextScenario === "transient-once"
      ? openSession("validating")
      : nextScenario === "head-session"
        ? openSession("validation_failed")
        : nextScenario === "committed"
          ? openSession("committed")
          : null;
  startCalls = 0;
  commitCalls = 0;
  batchCalls = 0;
  statusReadCalls = 0;
  statusFailuresRemaining = nextScenario === "transient-once" ? 1 : 0;
  revoked = false;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function sendWebResponse(response, webResponse) {
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

function documentFor(role = "owner") {
  return renderOrdinaryMindsManagementDocument({
    displayName: "Fixture User",
    view: { kind: "detail", mind: { ...writerMind, role } },
  }, "/ui/mind-diary-ordinary-minds-client.js");
}

reset("fresh");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/_fixture/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/_fixture/reset" && request.method === "POST") {
      reset(url.searchParams.get("scenario") ?? "fresh");
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/_fixture/revoke" && request.method === "POST") {
      revoked = true;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/_fixture/state") {
      sendJson(response, 200, {
        scenario,
        start_calls: startCalls,
        commit_calls: commitCalls,
        batch_calls: batchCalls,
        status_read_calls: statusReadCalls,
        session,
      });
      return;
    }
    if (url.pathname === "/research-notes" || url.pathname === "/reader") {
      sendHtml(response, documentFor(url.pathname === "/reader" ? "reader" : "owner"));
      return;
    }
    if (url.pathname === "/help") {
      sendHtml(response, "<!doctype html><title>Help</title><a href=\"/research-notes\">Back</a>");
      return;
    }

    const staticResponse = createProductUiStaticAssetResponse(new Request(url));
    if (staticResponse) {
      await sendWebResponse(response, staticResponse);
      return;
    }

    if (/^\/api\/v1\/minds\/research-notes\/markdown-import-plans$/u.test(url.pathname) && request.method === "POST") {
      if (scenario === "head-plan") {
        sendJson(response, 409, { ok: false, error: { code: "import_head_conflict" } });
        return;
      }
      if (scenario === "server-error") {
        sendJson(response, 500, { ok: false, error: { code: "operation_failed", message: "d1/private/shard" } });
        return;
      }
      const body = await bodyJson(request);
      plan = snakePlan(body.files);
      sendJson(response, 200, { ok: true, data: { plan } });
      return;
    }
    if (/^\/api\/v1\/minds\/research-notes\/markdown-imports$/u.test(url.pathname) && request.method === "POST") {
      startCalls += 1;
      session = openSession("active");
      session.import_id = "import_fresh_fixture";
      sendJson(response, 200, { ok: true, data: { session } });
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/v1\/markdown-imports\/([^/]+)$/u);
    if (statusMatch && request.method === "GET") {
      statusReadCalls += 1;
      if (statusFailuresRemaining > 0) {
        statusFailuresRemaining -= 1;
        sendJson(response, 503, {
          ok: false,
          error: { code: "binding_state_unavailable", message: "private/redeploy/storage-shard" },
        });
        return;
      }
      if (revoked || session === null || statusMatch[1] !== session.import_id) {
        sendJson(response, 403, { ok: false, error: { code: "forbidden" } });
        return;
      }
      sendJson(response, 200, { ok: true, data: { session, plan } });
      return;
    }
    if (statusMatch && request.method === "DELETE") {
      if (session === null) {
        sendJson(response, 404, { ok: false, error: { code: "import_session_not_found" } });
        return;
      }
      session = { ...session, state: "canceled", version: session.version + 1 };
      sendJson(response, 200, { ok: true, data: { session } });
      return;
    }

    const batchMatch = url.pathname.match(/^\/api\/v1\/markdown-imports\/([^/]+)\/batches\/(\d+)$/u);
    if (batchMatch && request.method === "PUT") {
      batchCalls += 1;
      session = {
        ...session,
        checkpoint: Number(batchMatch[2]),
        staged_file_count: plan.file_count,
        staged_bytes: plan.logical_bytes,
        version: session.version + 1,
      };
      sendJson(response, 200, { ok: true, data: { session } });
      return;
    }

    const validateMatch = url.pathname.match(/^\/api\/v1\/markdown-imports\/([^/]+)\/validate$/u);
    if (validateMatch && request.method === "POST") {
      session = {
        ...session,
        state: "validated",
        validation_checkpoint: plan.file_count,
        validated_bytes: plan.logical_bytes,
        version: session.version + 1,
      };
      sendJson(response, 200, { ok: true, data: { session } });
      return;
    }

    const commitMatch = url.pathname.match(/^\/api\/v1\/markdown-imports\/([^/]+)\/commit$/u);
    if (commitMatch && request.method === "POST") {
      commitCalls += 1;
      if (scenario === "head-commit") {
        session = {
          ...session,
          state: "validation_failed",
          failures: [{ path: "(snapshot)", code: "import_head_conflict" }],
          version: session.version + 1,
        };
        sendJson(response, 409, { ok: false, error: { code: "import_head_conflict" } });
        return;
      }
      session = { ...session, state: "committed", revision_id: "revision_import_fixture", version: session.version + 1 };
      sendJson(response, 200, { ok: true, data: { revision_id: session.revision_id } });
      return;
    }

    sendJson(response, 404, { ok: false, error: { code: "not_found" } });
  } catch {
    sendJson(response, 500, { ok: false, error: { code: "fixture_failure" } });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Mind Diary Markdown import fixture: ${origin}/research-notes\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
