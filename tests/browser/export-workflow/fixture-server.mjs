import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

import { renderProductExportWorkflowPanel } from "../../../packages/adapter-web/dist/export-workflow.js";

const root = resolve(import.meta.dirname, "../../..");
const port = Number.parseInt(process.env.MIND_DIARY_EXPORT_UI_PORT ?? "4327", 10);
const host = "127.0.0.1";
const archive = Buffer.from("PK\u0003\u0004mind-diary-exact-revision-fixture\n", "utf8");
const corruptArchive = Buffer.from(archive);
corruptArchive[corruptArchive.length - 2] ^= 1;
const sha256 = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
let mode = "normal";
let sequence = 0;
let startRequests = 0;
const startAttempts = [];
const jobs = new Map();
const jobsByKey = new Map();
const polls = new Map();
const usedGrants = new Set();

function reset(nextMode = "normal") {
  mode = nextMode;
  sequence = 0;
  startRequests = 0;
  startAttempts.length = 0;
  jobs.clear();
  jobsByKey.clear();
  polls.clear();
  usedGrants.clear();
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function document() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="mind-diary-csrf-token" content="fixture-csrf"><link rel="stylesheet" href="/brand/mind-diary-tokens.css"><link rel="stylesheet" href="/ui/mind-diary-shell.css"><title>Export fixture</title></head><body><main class="md-shell"><h1>Research Notes</h1>${renderProductExportWorkflowPanel({ mindRef: "research-notes", route: "/research-notes", name: "Research Notes", headRevisionId: "revision_head_7" })}</main><script src="/ui/mind-diary-export-client.js" defer></script></body></html>`;
}

const server = createServer(async (request, response) => {
  try {
    const origin = `http://${host}:${port}`;
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/_fixture/health") return json(response, 200, { ok: true });
    if (url.pathname === "/_fixture/reset" && request.method === "POST") {
      reset(url.searchParams.get("mode") ?? "normal");
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/_fixture/mode" && request.method === "POST") {
      mode = url.searchParams.get("value") ?? "normal";
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/_fixture/state") {
      return json(response, 200, {
        ok: true,
        mode,
        startRequests,
        uniqueStartKeys: new Set(startAttempts.map((attempt) => attempt.key)).size,
        startAttempts,
        uniqueJobs: jobs.size,
        jobs: [...jobs.values()],
      });
    }
    if (url.pathname === "/" || url.pathname === "/research-notes") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(document());
      return;
    }
    if (url.pathname === "/brand/mind-diary-tokens.css" || url.pathname === "/ui/mind-diary-shell.css" || url.pathname === "/ui/mind-diary-export-client.js") {
      const path = url.pathname === "/brand/mind-diary-tokens.css"
        ? resolve(root, "docs/assets/brand/mind-diary-tokens.css")
        : url.pathname === "/ui/mind-diary-shell.css"
          ? resolve(root, "packages/adapter-web/src/ui-shell.css")
          : resolve(root, "packages/adapter-web/assets/export-client.js");
      await access(path);
      response.writeHead(200, {
        "content-type": extname(path) === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      createReadStream(path).pipe(response);
      return;
    }
    if (url.pathname === "/api/v1/minds/research-notes/exports" && request.method === "POST") {
      startRequests += 1;
      if (request.headers.origin !== origin || request.headers["x-csrf-token"] !== "fixture-csrf") {
        return json(response, 403, { ok: false, error: { code: "forbidden" } });
      }
      const key = request.headers["idempotency-key"];
      const input = await body(request);
      startAttempts.push({ key, input });
      const selector = input.revision_selector;
      const revisionId = selector?.kind === "head" ? "revision_head_7" : selector?.revision_id;
      if (revisionId === "revision_mixed" && input.profile === "MD-OKF-ZIP-1") {
        return json(response, 422, { ok: false, error: { code: "export_profile_required" } });
      }
      let job = jobsByKey.get(key);
      const replayed = job !== undefined;
      if (!job) {
        job = { job_id: `export_${++sequence}`, status: "queued", revision_id: revisionId, profile: input.profile, selector };
        jobs.set(job.job_id, job);
        jobsByKey.set(key, job);
      }
      if (mode === "unknown_once" && !replayed) {
        return json(response, 503, { ok: false, error: { code: "temporarily_unavailable" } });
      }
      return json(response, 202, { ok: true, data: { job, replayed } });
    }
    const statusMatch = /^\/api\/v1\/export-jobs\/([^/]+)$/.exec(url.pathname);
    if (statusMatch && request.method === "GET") {
      const job = jobs.get(decodeURIComponent(statusMatch[1]));
      if (!job || mode === "revoked" || mode === "tightened") {
        return json(response, 404, { ok: false, error: { code: "export_job_not_found" } });
      }
      if (mode === "expired") {
        return json(response, 200, { ok: true, data: { job: { ...job, status: "expired" } } });
      }
      if (mode === "failed_integrity") {
        return json(response, 200, {
          ok: true,
          data: {
            job: {
              ...job,
              status: "failed",
              last_failure_code: "revision_integrity_failure",
            },
          },
        });
      }
      const count = (polls.get(job.job_id) ?? 0) + 1;
      polls.set(job.job_id, count);
      if (count < 2) {
        return json(response, 200, { ok: true, data: { job: { ...job, status: "running" } } });
      }
      const grant = `grant-${job.job_id}-${count}`;
      return json(response, 200, {
        ok: true,
        data: {
          job: {
            ...job,
            status: "succeeded",
            archive_format: job.profile,
            media_type: "application/zip",
            filename: job.profile === "MD-BUNDLE-ZIP-1" ? "mind-diary-bundle.zip" : "mind-diary-okf-bundle.zip",
            size: archive.byteLength,
            sha256,
            download_url: `${origin}/api/v1/exports/${grant}`,
            download_expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
    }
    const grantMatch = /^\/api\/v1\/exports\/([^/]+)$/.exec(url.pathname);
    if (grantMatch && request.method === "GET") {
      const grant = grantMatch[1];
      if (usedGrants.has(grant) || mode === "revoked" || mode === "tightened" || mode === "expired") {
        return json(response, 404, { ok: false, error: { code: "export_download_not_found" } });
      }
      usedGrants.add(grant);
      const bytes = mode === "corrupt" ? corruptArchive : archive;
      const filename = jobs.get(grant.split("-")[1])?.profile === "MD-OKF-ZIP-1"
        ? "mind-diary-okf-bundle.zip"
        : "mind-diary-bundle.zip";
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(bytes);
      return;
    }
    json(response, 404, { ok: false, error: { code: "not_found" } });
  } catch (error) {
    json(response, 500, { ok: false, error: { code: "fixture_failure", message: error.message } });
  }
});

server.listen(port, host, () => process.stdout.write(`Mind Diary export fixture: http://${host}:${port}/research-notes\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
