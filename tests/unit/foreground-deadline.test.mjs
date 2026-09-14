import assert from "node:assert/strict";
import test from "node:test";
import { withForegroundDeadline } from "../../apps/mind-diary-site/worker/foreground-deadline.js";
import { createMindDiaryProductWorker, RequestRecoveryCoordinator } from "../../apps/mind-diary-site/worker/request-recovery.js";

const ORIGIN = "https://mind-diary.example";
const context = { waitUntil(promise) { void promise.catch(() => undefined); } };

test("foreground deadline preserves trusted request identity", async () => {
  const request = new Request(ORIGIN);
  const identities = new WeakMap([[request, "verified-actor"]]);
  const response = await withForegroundDeadline(request, 100, async (candidate) => {
    assert.equal(candidate, request);
    return new Response(identities.get(candidate));
  }, () => {});
  assert.equal(await response.text(), "verified-actor");
});

function fixture({ backupForegroundTimeoutMs, mcpForegroundTimeoutMs } = {}) {
  let generations = 0;
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduled = [];
  const worker = createMindDiaryProductWorker({
    foregroundTimeoutMs: 25,
    ...(mcpForegroundTimeoutMs === undefined ? {} : { mcpForegroundTimeoutMs }),
    ...(backupForegroundTimeoutMs === undefined ? {} : { backupForegroundTimeoutMs }),
    recoveryCoordinator: new RequestRecoveryCoordinator({ enabled: false }),
    readConfig() { return { publicOrigin: ORIGIN }; },
    async fallbackFetch() { return new Response("fallback"); },
    async createRuntime({ schedule }) {
      const generation = ++generations;
      return {
        async fetch() {
          if (generation === 1) {
            started();
            await gate;
            schedule({ kind: "revision_index", id: "late-work" });
          }
          return new Response(`generation-${generation}`);
        },
        async recoverBackground() {},
        async dispatchBackground(work) { scheduled.push(work); },
      };
    },
  });
  return { worker, release, entered, scheduled, generations: () => generations };
}

for (const path of ["/", "/me", "/ordinary", "/api/mcp/2025-11-25"]) {
  test(`foreground deadline bounds ${path} and fences late generation work`, async () => {
    const f = fixture();
    const environment = {};
    const request = () => new Request(ORIGIN + path, {
      ...(path.startsWith("/api/") ? { method: "POST", body: "{}" } : {}),
    });
    const first = await f.worker.fetch(request(), environment, context);
    assert.equal(first.status, 503);
    assert.equal((await first.json()).error.code, "request_timeout");
    const next = await f.worker.fetch(request(), environment, context);
    assert.equal(await next.text(), "generation-2");
    f.release();
    await new Promise((resolve) => setImmediate(resolve));
    const afterLateSettlement = await f.worker.fetch(request(), environment, context);
    assert.equal(await afterLateSettlement.text(), "generation-2");
    assert.equal(f.generations(), 2);
    assert.deepEqual(f.scheduled, []);
  });
}

test("operator backup route may complete after the ordinary foreground deadline", async () => {
  const f = fixture({ backupForegroundTimeoutMs: 300 });
  const pending = f.worker.fetch(new Request(ORIGIN + "/api/v1/internal/system-backup/sessions", {
    method: "POST", body: "{}",
  }), {}, context);
  await f.entered;
  await new Promise((resolve) => setTimeout(resolve, 40));
  f.release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "generation-1");
});

for (const path of ["/api/mcp", "/api/mcp/2025-11-25", "/api/mcp/apps"]) {
  test(`MCP budget lets ${path} finish beyond the navigation deadline`, async () => {
    const f = fixture({ mcpForegroundTimeoutMs: 300 });
    const pending = f.worker.fetch(new Request(ORIGIN + path, {
      method: "POST", body: "{}",
    }), {}, context);
    await f.entered;
    await new Promise((resolve) => setTimeout(resolve, 40));
    f.release();
    assert.equal((await pending).status, 200);
    assert.equal(f.generations(), 1);
  });
}

for (const path of ["/me", "/api/mcp/not-a-route", "/api/mcp-extra"]) {
  test(`MCP budget does not extend ${path}`, async () => {
    const f = fixture({ mcpForegroundTimeoutMs: 300 });
    const response = await f.worker.fetch(new Request(ORIGIN + path), {}, context);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "request_timeout");
    f.release();
  });
}

test("client cancellation retires a ready generation without claiming write failure", async () => {
  const f = fixture();
  const environment = {};
  const controller = new AbortController();
  const pending = f.worker.fetch(new Request(ORIGIN + "/api/mcp", {
    method: "POST", body: "{}", signal: controller.signal,
  }), environment, context);
  await f.entered;
  controller.abort();
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "request_canceled");
  assert.match(body.error.message, /may still commit/);
  const next = await f.worker.fetch(new Request(ORIGIN + "/me"), environment, context);
  assert.equal(await next.text(), "generation-2");
  f.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.scheduled, []);
});

test("already canceled requests perform no runtime initialization", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  const response = await f.worker.fetch(new Request(ORIGIN, { signal: controller.signal }), {}, context);
  assert.equal((await response.json()).error.code, "request_canceled");
  assert.equal(f.generations(), 0);
});

test("a metadata queue timeout retires its generation even before the foreground deadline", async () => {
  let generations = 0;
  let oldRetire;
  const environment = {};
  const worker = createMindDiaryProductWorker({
    recoveryCoordinator: new RequestRecoveryCoordinator({ enabled: false }),
    readConfig() { return { publicOrigin: ORIGIN }; },
    async fallbackFetch() { return new Response("fallback"); },
    async createRuntime({ onMetadataQueueTimeout }) {
      const generation = ++generations;
      if (generation === 1) oldRetire = onMetadataQueueTimeout;
      return {
        async fetch() {
          if (generation === 1) {
            onMetadataQueueTimeout();
            return new Response("queue unavailable", { status: 503 });
          }
          return new Response(`generation-${generation}`);
        },
        async recoverBackground() {}, async dispatchBackground() {},
      };
    },
  });
  assert.equal((await worker.fetch(new Request(ORIGIN), environment, context)).status, 503);
  assert.equal(await (await worker.fetch(new Request(ORIGIN), environment, context)).text(), "generation-2");
  oldRetire();
  assert.equal(await (await worker.fetch(new Request(ORIGIN), environment, context)).text(), "generation-2");
  assert.equal(generations, 2);
});
