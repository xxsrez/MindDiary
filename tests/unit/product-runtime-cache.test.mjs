import assert from "node:assert/strict";
import test from "node:test";

import { IsolateRuntimeCache } from "../../apps/mind-diary-site/worker/runtime-cache.js";

test("isolate runtime cache single-flights warm and concurrent initialization", async () => {
  const cache = new IsolateRuntimeCache();
  const environment = {};
  let creates = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const create = async () => {
    creates += 1;
    await gate;
    return { generation: creates };
  };
  const first = cache.acquire({ environment, fingerprint: "a", create, dispatch: async () => undefined });
  const second = cache.acquire({ environment, fingerprint: "a", create, dispatch: async () => undefined });
  release();
  assert.equal(await first.runtime, await second.runtime);
  assert.equal(creates, 1);
  assert.equal(await cache.acquire({ environment, fingerprint: "a", create, dispatch: async () => undefined }).runtime, await first.runtime);
});

test("failed initialization is evicted and configuration mismatch creates a clean generation", async () => {
  const cache = new IsolateRuntimeCache();
  const environment = {};
  let attempts = 0;
  const create = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("synthetic init failure");
    return { generation: attempts };
  };
  await assert.rejects(
    cache.acquire({ environment, fingerprint: "a", create, dispatch: async () => undefined }).runtime,
    /synthetic init failure/u,
  );
  assert.deepEqual(
    await cache.acquire({ environment, fingerprint: "a", create, dispatch: async () => undefined }).runtime,
    { generation: 2 },
  );
  assert.deepEqual(
    await cache.acquire({ environment, fingerprint: "b", create, dispatch: async () => undefined }).runtime,
    { generation: 3 },
  );
});

test("scheduled work is drained without retaining any request execution context", async () => {
  const cache = new IsolateRuntimeCache();
  const environment = {};
  const dispatched = [];
  let schedule;
  const handle = cache.acquire({
    environment,
    fingerprint: "a",
    create: async (capturedSchedule) => {
      schedule = capturedSchedule;
      return { generation: 1 };
    },
    dispatch: async (runtime, work) => {
      dispatched.push([runtime.generation, work.id]);
    },
  });
  await handle.runtime;
  schedule({ id: "job-current-request" });
  const pending = handle.drainScheduled();
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.deepEqual(dispatched, [[1, "job-current-request"]]);
  assert.deepEqual(handle.drainScheduled(), []);
});
