import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DeterministicOkfExportService, OkfExportError } from "@mind-diary/application-content";
import { MARKDOWN_MEDIA_TYPE, bundleFileMediaType } from "@mind-diary/domain";
import { createProductUiStaticAssetResponse } from "../../../packages/adapter-web/dist/product-http.js";
import { renderOrdinaryMindsManagementDocument } from "../../../packages/adapter-web/dist/ordinary-minds-management.js";

const fixtureRoot = process.env.MIND_DIARY_MD363_FIXTURE_ROOT;
if (typeof fixtureRoot !== "string" || fixtureRoot.length === 0) {
  throw new Error("MIND_DIARY_MD363_FIXTURE_ROOT is required");
}
const manifest = JSON.parse(await readFile(resolve(fixtureRoot, "fixture-manifest.json"), "utf8"));
const fixtureFiles = new Map(await Promise.all(manifest.files.map(async (file) => [
  file.id,
  new Uint8Array(await readFile(resolve(fixtureRoot, file.relative_path))),
])));

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MIND_DIARY_MD363_PORT ?? "4363", 10);
const origin = `http://${host}:${port}`;
const spaceId = "space_md363_fixture";
const actorId = "principal_md363_fixture";
const revisionHistorical = "revision_md363_history_1";
const revisionBaseline = "revision_md363_head_2";
const revisionImported = "revision_md363_import_3";
const encoder = new TextEncoder();

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function markdown(path, bytes) {
  return Object.freeze({
    kind: "markdown",
    path,
    mediaType: MARKDOWN_MEDIA_TYPE,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    bytes: new Uint8Array(bytes),
  });
}

function opaque(path, bytes) {
  return Object.freeze({
    kind: "opaque",
    path,
    mediaType: bundleFileMediaType("application/octet-stream"),
    sha256: sha256(bytes),
    size: bytes.byteLength,
    bytes: new Uint8Array(bytes),
  });
}

function revision(revisionId, files) {
  return Object.freeze({
    envelope: Object.freeze({ revision: Object.freeze({ spaceId, revisionId }) }),
    files: Object.freeze(files),
  });
}

const historicalFiles = Object.freeze([
  markdown("index.md", fixtureFiles.get("historical-index")),
]);
const baselineFiles = Object.freeze([
  markdown("index.md", fixtureFiles.get("baseline-index")),
  markdown("concepts/before.md", fixtureFiles.get("baseline-concept")),
  opaque("assets/known.bin", fixtureFiles.get("known-opaque")),
]);

const revisions = new Map();
const exportBuilder = new DeterministicOkfExportService({
  materializer: {
    async materialize(requestSpaceId, requestRevisionId) {
      const value = revisions.get(requestRevisionId);
      if (requestSpaceId !== spaceId || value === undefined) throw new Error("revision_not_found");
      return value;
    },
  },
  digest: { calculateSha256: async (bytes) => sha256(bytes) },
});

let scenario;
let currentHead;
let plan;
let session;
let mindPresent;
let planAttempts;
let startAttempts;
let startByKey;
let startUnknownRemaining;
let validationInterruptRemaining;
let jobs;
let jobsByKey;
let jobSequence;
let grants;
let downloads;
let cleanup;

function importedFiles(staged = null) {
  const source = staged ?? new Map([
    ["index.md", fixtureFiles.get("import-index")],
    ["concepts/alpha.md", fixtureFiles.get("import-concept")],
  ]);
  return Object.freeze([
    ...[...source].map(([path, bytes]) => markdown(path, bytes)),
    opaque("assets/known.bin", fixtureFiles.get("known-opaque")),
  ]);
}

function reset(nextScenario = "fresh") {
  scenario = nextScenario;
  revisions.clear();
  revisions.set(revisionHistorical, revision(revisionHistorical, historicalFiles));
  revisions.set(revisionBaseline, revision(revisionBaseline, baselineFiles));
  currentHead = revisionBaseline;
  if (nextScenario === "imported" || nextScenario.startsWith("export-")) {
    revisions.set(revisionImported, revision(revisionImported, importedFiles()));
    currentHead = revisionImported;
  }
  plan = null;
  session = null;
  mindPresent = true;
  planAttempts = [];
  startAttempts = [];
  startByKey = new Map();
  startUnknownRemaining = nextScenario === "unknown-start" ? 1 : 0;
  validationInterruptRemaining = ["interrupt", "cancel"].includes(nextScenario) ? 1 : 0;
  jobs = new Map();
  jobsByKey = new Map();
  jobSequence = 0;
  grants = new Map();
  downloads = [];
  cleanup = { requested: false, sessions_closed: false, grants_removed: false, mind_absent: false };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function requestBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function requestJson(request) {
  return JSON.parse((await requestBytes(request)).toString("utf8"));
}

function descriptorHash(files) {
  return sha256(encoder.encode(JSON.stringify(
    [...files].sort((left, right) => left.path.localeCompare(right.path, "en", { sensitivity: "variant" }))
      .map(({ path, sha256: digest, size }) => ({ path, sha256: digest, size })),
  )));
}

function multipart(request, bytes) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(request.headers["content-type"] ?? "");
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new Error("missing multipart boundary");
  const marker = Buffer.from(`--${boundary}`, "ascii");
  const parts = new Map();
  let cursor = bytes.indexOf(marker);
  while (cursor >= 0) {
    cursor += marker.byteLength;
    if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) cursor += 2;
    const next = bytes.indexOf(marker, cursor);
    if (next < 0) break;
    const part = bytes.subarray(cursor, next - 2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) throw new Error("malformed multipart part");
    const headers = part.subarray(0, headerEnd).toString("latin1");
    const name = /name="([^"]+)"/u.exec(headers)?.[1];
    if (!name || parts.has(name)) throw new Error("invalid multipart field");
    parts.set(name, new Uint8Array(part.subarray(headerEnd + 4)));
    cursor = next;
  }
  return parts;
}

function snakeSession() {
  if (session === null) return null;
  return {
    import_id: session.importId,
    plan_id: session.planId,
    expected_revision_id: session.expectedRevisionId,
    state: session.state,
    version: session.version,
    checkpoint: session.checkpoint,
    staged_file_count: session.staged.size,
    staged_bytes: [...session.staged.values()].reduce((total, bytes) => total + bytes.byteLength, 0),
    validation_checkpoint: session.validationCheckpoint,
    validated_bytes: session.validatedBytes,
    promotion_checkpoint: session.promotionCheckpoint,
    promoted_bytes: session.promotedBytes,
    failures: session.failures,
    revision_id: session.revisionId,
  };
}

function snakePlan() {
  if (plan === null) return null;
  return {
    plan_id: plan.planId,
    expected_revision_id: plan.expectedRevisionId,
    descriptor_hash: plan.descriptorHash,
    file_count: plan.files.length,
    logical_bytes: plan.files.reduce((total, file) => total + file.size, 0),
    additions: 1,
    replacements: 1,
    deletions: 1,
    unchanged: 0,
    projected_utilization: scenario === "quota" ? "hard_limit" : "normal",
  };
}

function document() {
  return renderOrdinaryMindsManagementDocument({
    displayName: "Synthetic MD-363",
    view: {
      kind: "detail",
      mind: {
        mindId: "mind_md363_fixture",
        handle: "transfer-matrix",
        name: "Transfer Matrix",
        description: "Generated import and export fixture",
        headRevisionId: currentHead,
        visibility: "private",
        role: "owner",
        metadataVersion: 1,
        updatedLabel: "Deterministic fixture",
      },
    },
  }, "/ui/mind-diary-ordinary-minds-client.js");
}

function safeState() {
  return {
    scenario,
    mind_present: mindPresent,
    current_head: currentHead,
    revision_count: revisions.size,
    revisions: [...revisions].map(([revisionId, value]) => ({
      revision_id: revisionId,
      files: value.files.map((file) => ({
        kind: file.kind,
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })),
    })),
    plan_attempts: planAttempts,
    start_attempts: startAttempts,
    session: snakeSession(),
    jobs: [...jobs.values()].map((job) => ({
      job_id: job.jobId,
      revision_id: job.revisionId,
      profile: job.profile,
      size: job.archive.size,
      sha256: job.archive.sha256,
    })),
    grants: grants.size,
    downloads,
    cleanup,
  };
}

async function sendWebResponse(response, webResponse) {
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

reset();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/_fixture/health") return sendJson(response, 200, { ok: true });
    if (url.pathname === "/_fixture/manifest") return sendJson(response, 200, manifest);
    if (url.pathname === "/_fixture/state") return sendJson(response, 200, safeState());
    if (url.pathname === "/_fixture/reset" && request.method === "POST") {
      reset(url.searchParams.get("scenario") ?? "fresh");
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === "/_fixture/set-scenario" && request.method === "POST") {
      scenario = url.searchParams.get("scenario") ?? scenario;
      return sendJson(response, 200, { ok: true, scenario });
    }
    if (url.pathname === "/_fixture/cleanup" && request.method === "DELETE") {
      cleanup = { requested: true, sessions_closed: true, grants_removed: true, mind_absent: true };
      if (session !== null && session.state !== "committed") session.state = "canceled";
      grants.clear();
      jobs.clear();
      mindPresent = false;
      return sendJson(response, 200, { ok: true, cleanup });
    }
    if (url.pathname === "/transfer-matrix") {
      if (!mindPresent) return sendJson(response, 404, { ok: false, error: { code: "not_found" } });
      return sendHtml(response, document());
    }

    const staticResponse = createProductUiStaticAssetResponse(new Request(url));
    if (staticResponse) return sendWebResponse(response, staticResponse);

    if (url.pathname === "/api/v1/minds/transfer-matrix/markdown-import-plans" && request.method === "POST") {
      if (scenario === "head-plan") {
        return sendJson(response, 409, { ok: false, error: { code: "import_head_conflict" } });
      }
      const body = await requestJson(request);
      if (body.expected_revision_id !== currentHead || !Array.isArray(body.files)) {
        return sendJson(response, 409, { ok: false, error: { code: "import_head_conflict" } });
      }
      const key = request.headers["idempotency-key"];
      const canonicalRequest = JSON.stringify(body);
      planAttempts.push({ key, request_sha256: sha256(encoder.encode(canonicalRequest)) });
      if (plan !== null && plan.key === key && plan.canonicalRequest !== canonicalRequest) {
        return sendJson(response, 409, { ok: false, error: { code: "import_idempotency_conflict" } });
      }
      if (plan === null || plan.key !== key) {
        plan = {
          key,
          canonicalRequest,
          planId: "plan_md363",
          expectedRevisionId: currentHead,
          files: body.files,
          descriptorHash: descriptorHash(body.files),
        };
      }
      return sendJson(response, 200, { ok: true, data: { plan: snakePlan() } });
    }

    if (url.pathname === "/api/v1/minds/transfer-matrix/markdown-imports" && request.method === "POST") {
      const body = await requestJson(request);
      const key = request.headers["idempotency-key"];
      startAttempts.push({ key, plan_id: body.plan_id });
      const existing = startByKey.get(key);
      if (existing !== undefined && existing.planId !== body.plan_id) {
        return sendJson(response, 409, { ok: false, error: { code: "import_idempotency_conflict" } });
      }
      if (existing === undefined) {
        session = {
          importId: "import_md363",
          planId: body.plan_id,
          expectedRevisionId: currentHead,
          state: "active",
          version: 1,
          checkpoint: 0,
          staged: new Map(),
          validationCheckpoint: 0,
          validatedBytes: 0,
          promotionCheckpoint: 0,
          promotedBytes: 0,
          failures: [],
          revisionId: null,
        };
        startByKey.set(key, { planId: body.plan_id, importId: session.importId });
      }
      if (startUnknownRemaining > 0) {
        startUnknownRemaining -= 1;
        return sendJson(response, 503, { ok: false, error: { code: "temporarily_unavailable" } });
      }
      return sendJson(response, 200, { ok: true, data: { session: snakeSession(), replayed: existing !== undefined } });
    }

    const sessionMatch = /^\/api\/v1\/markdown-imports\/([^/]+)$/u.exec(url.pathname);
    if (sessionMatch && request.method === "GET") {
      if (!mindPresent || session === null || sessionMatch[1] !== session.importId) {
        return sendJson(response, 404, { ok: false, error: { code: "import_session_not_found" } });
      }
      return sendJson(response, 200, { ok: true, data: { session: snakeSession(), plan: snakePlan() } });
    }
    if (sessionMatch && request.method === "DELETE") {
      if (session === null || sessionMatch[1] !== session.importId) {
        return sendJson(response, 404, { ok: false, error: { code: "import_session_not_found" } });
      }
      if (session.state !== "committed") session.state = "canceled";
      session.version += 1;
      session.staged.clear();
      return sendJson(response, 200, { ok: true, data: { session: snakeSession() } });
    }

    const batchMatch = /^\/api\/v1\/markdown-imports\/([^/]+)\/batches\/(\d+)$/u.exec(url.pathname);
    if (batchMatch && request.method === "PUT") {
      if (session === null || batchMatch[1] !== session.importId) {
        return sendJson(response, 404, { ok: false, error: { code: "import_session_not_found" } });
      }
      const checkpoint = Number(batchMatch[2]);
      const parts = multipart(request, await requestBytes(request));
      const batchManifest = JSON.parse(Buffer.from(parts.get("manifest") ?? []).toString("utf8"));
      if (checkpoint === session.checkpoint) {
        return sendJson(response, 200, { ok: true, data: { session: snakeSession(), replayed: true } });
      }
      if (checkpoint !== session.checkpoint + 1 || batchManifest.expected_version !== session.version) {
        return sendJson(response, 409, { ok: false, error: { code: "import_checkpoint_conflict" } });
      }
      for (const file of batchManifest.files) {
        const bytes = parts.get(file.field);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.size || sha256(bytes) !== file.sha256 ||
            !plan.files.some((planned) => planned.path === file.path && planned.size === file.size && planned.sha256 === file.sha256)) {
          return sendJson(response, 422, { ok: false, error: { code: "import_file_conflict" } });
        }
        session.staged.set(file.path, new Uint8Array(bytes));
      }
      session.checkpoint = checkpoint;
      session.version += 1;
      return sendJson(response, 200, { ok: true, data: { session: snakeSession(), replayed: false } });
    }

    const validateMatch = /^\/api\/v1\/markdown-imports\/([^/]+)\/validate$/u.exec(url.pathname);
    if (validateMatch && request.method === "POST") {
      if (validationInterruptRemaining > 0) {
        validationInterruptRemaining -= 1;
        return sendJson(response, 503, { ok: false, error: { code: "temporarily_unavailable" } });
      }
      session.state = "validated";
      session.validationCheckpoint = session.staged.size;
      session.validatedBytes = [...session.staged.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
      session.version += 1;
      return sendJson(response, 200, { ok: true, data: { session: snakeSession() } });
    }

    const commitMatch = /^\/api\/v1\/markdown-imports\/([^/]+)\/commit$/u.exec(url.pathname);
    if (commitMatch && request.method === "POST") {
      if (scenario === "head-commit") {
        session.state = "validation_failed";
        session.failures = [{ path: "(snapshot)", code: "import_head_conflict" }];
        session.version += 1;
        return sendJson(response, 409, { ok: false, error: { code: "import_head_conflict" } });
      }
      if (session.state === "committed") {
        return sendJson(response, 200, { ok: true, data: { revision_id: session.revisionId, replayed: true } });
      }
      revisions.set(revisionImported, revision(revisionImported, importedFiles(session.staged)));
      currentHead = revisionImported;
      session.state = "committed";
      session.revisionId = revisionImported;
      session.version += 1;
      return sendJson(response, 200, { ok: true, data: { revision_id: revisionImported, replayed: false } });
    }

    if (url.pathname === "/api/v1/minds/transfer-matrix/exports" && request.method === "POST") {
      const body = await requestJson(request);
      const key = request.headers["idempotency-key"];
      const revisionId = body.revision_selector?.kind === "head"
        ? currentHead
        : body.revision_selector?.revision_id;
      const canonicalRequest = JSON.stringify(body);
      const previous = jobsByKey.get(key);
      if (previous && previous.canonicalRequest !== canonicalRequest) {
        return sendJson(response, 409, { ok: false, error: { code: "idempotency_conflict" } });
      }
      if (previous) {
        const job = jobs.get(previous.jobId);
        return sendJson(response, 202, { ok: true, data: { job: {
          job_id: job.jobId, status: "queued", revision_id: job.revisionId,
        }, replayed: true } });
      }
      let archive;
      try {
        archive = await exportBuilder.exportExactRevision({
          spaceId,
          revisionId,
          profile: body.profile,
        });
      } catch (error) {
        const code = error instanceof OkfExportError ? error.code : "operation_failed";
        return sendJson(response, code === "export_profile_required" ? 422 : 500, { ok: false, error: { code } });
      }
      const jobId = `export_md363_${++jobSequence}`;
      jobs.set(jobId, { jobId, revisionId, profile: body.profile, archive, polls: 0 });
      jobsByKey.set(key, { canonicalRequest, jobId });
      return sendJson(response, 202, { ok: true, data: { job: {
        job_id: jobId, status: "queued", revision_id: revisionId,
      }, replayed: false } });
    }

    const jobMatch = /^\/api\/v1\/export-jobs\/([^/]+)$/u.exec(url.pathname);
    if (jobMatch && request.method === "GET") {
      const job = jobs.get(jobMatch[1]);
      if (!job || ["export-revoked", "export-tightened"].includes(scenario)) {
        return sendJson(response, 404, { ok: false, error: { code: "export_job_not_found" } });
      }
      if (scenario === "export-expired") {
        return sendJson(response, 200, { ok: true, data: { job: {
          job_id: job.jobId, status: "expired", revision_id: job.revisionId,
        } } });
      }
      job.polls += 1;
      if (job.polls < 2) {
        return sendJson(response, 200, { ok: true, data: { job: {
          job_id: job.jobId, status: "running", revision_id: job.revisionId,
        } } });
      }
      const grant = `grant-md363-${job.jobId}-${job.polls}`;
      grants.set(grant, { jobId: job.jobId, used: false });
      return sendJson(response, 200, { ok: true, data: { job: {
        job_id: job.jobId,
        status: "succeeded",
        revision_id: job.revisionId,
        archive_format: job.archive.archiveFormat,
        media_type: job.archive.mediaType,
        filename: job.archive.filename,
        size: job.archive.size,
        sha256: job.archive.sha256,
        download_url: `${origin}/api/v1/exports/${grant}`,
        download_expires_at: new Date(Date.now() + 60_000).toISOString(),
      } } });
    }

    const grantMatch = /^\/api\/v1\/exports\/([^/]+)$/u.exec(url.pathname);
    if (grantMatch && request.method === "GET") {
      const grant = grants.get(grantMatch[1]);
      const job = grant && jobs.get(grant.jobId);
      if (!grant || grant.used || !job || ["export-expired", "export-revoked", "export-tightened"].includes(scenario)) {
        return sendJson(response, 404, { ok: false, error: { code: "export_download_not_found" } });
      }
      grant.used = true;
      downloads.push({ revision_id: job.revisionId, profile: job.profile, size: job.archive.size, sha256: job.archive.sha256 });
      response.writeHead(200, {
        "content-type": job.archive.mediaType,
        "content-length": String(job.archive.size),
        "content-disposition": job.archive.contentDisposition,
        "cache-control": "no-store",
        pragma: "no-cache",
        "x-content-type-options": "nosniff",
      });
      response.end(Buffer.from(job.archive.bytes));
      return;
    }

    sendJson(response, 404, { ok: false, error: { code: "not_found" } });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: { code: "fixture_failure", message: error.message } });
  }
});

server.listen(port, host, () => process.stdout.write(`Mind Diary MD-363 fixture: ${origin}/transfer-matrix\n`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
