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

test("a timed-out request leaves the sole initialization flight shared with an early retry", async () => {
  let now = 0;
  const cache = new IsolateRuntimeCache({ now: () => now });
  const environment = {};
  let attempts = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatched = [];
  const create = async (schedule) => {
    attempts += 1;
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    await gate;
    schedule({ id: "job-from-late-initialization" });
    concurrent -= 1;
    return { generation: attempts };
  };
  const first = cache.acquire({
    environment,
    fingerprint: "a",
    create,
    dispatch: async (runtime, work) => {
      dispatched.push([runtime.generation, work.id]);
    },
    initializationTimeoutMs: 25,
  });
  const firstOutcome = await Promise.race([
    first.runtime.then(() => "completed", (error) => error),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  assert.notEqual(firstOutcome, "blocked");
  assert.match(firstOutcome.message, /timed out/u);
  assert.equal(attempts, 1);

  now = 50;
  const retry = cache.acquire({
    environment,
    fingerprint: "a",
    create,
    dispatch: async (runtime, work) => {
      dispatched.push([runtime.generation, work.id]);
    },
    initializationTimeoutMs: 1_000,
  });
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(maximumConcurrent, 1);

  release();
  assert.deepEqual(await retry.runtime, { generation: 1 });
  const scheduled = retry.drainInitializationScheduled();
  assert.equal(scheduled.length, 1);
  await Promise.all(scheduled);
  assert.deepEqual(dispatched, [[1, "job-from-late-initialization"]]);
  assert.equal(maximumConcurrent, 1);
  assert.deepEqual(
    await cache.acquire({
      environment,
      fingerprint: "a",
      create,
      dispatch: async () => undefined,
    }).runtime,
    { generation: 1 },
  );
  assert.equal(attempts, 1);
});

test("an expired initialization lease retires a canceled flight and fences its late work", async () => {
  let now = 0;
  const cache = new IsolateRuntimeCache({ now: () => now });
  const environment = {};
  let attempts = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const dispatched = [];
  const create = async (schedule) => {
    const generation = ++attempts;
    if (generation === 1) {
      await firstGate;
      schedule({ id: "work-from-retired-generation" });
    }
    return { generation };
  };
  const dispatch = async (runtime, work) => {
    dispatched.push([runtime.generation, work.id]);
  };

  const first = cache.acquire({
    environment,
    fingerprint: "a",
    create,
    dispatch,
    initializationTimeoutMs: 25,
  });
  await assert.rejects(first.runtime, { code: "runtime_initialization_timeout" });
  assert.equal(attempts, 1);

  now = 75;
  const replacement = cache.acquire({
    environment,
    fingerprint: "a",
    create,
    dispatch,
    initializationTimeoutMs: 25,
  });
  assert.deepEqual(await replacement.runtime, { generation: 2 });
  assert.equal(attempts, 2);

  releaseFirst();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(first.drainInitializationScheduled(), []);
  assert.deepEqual(replacement.drainInitializationScheduled(), []);
  assert.deepEqual(dispatched, []);
  assert.deepEqual(
    await cache.acquire({
      environment,
      fingerprint: "a",
      create,
      dispatch,
    }).runtime,
    { generation: 2 },
  );
});

test("in-flight A to B to A configuration changes rejoin each exact fingerprint", async () => {
  const cache = new IsolateRuntimeCache();
  const environment = {};
  let attemptsA = 0;
  let concurrentA = 0;
  let maximumConcurrentA = 0;
  let releaseA;
  let releaseFirstB;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const gateFirstB = new Promise((resolve) => { releaseFirstB = resolve; });
  const discardedDispatches = [];

  const createA = async () => {
    attemptsA += 1;
    concurrentA += 1;
    maximumConcurrentA = Math.max(maximumConcurrentA, concurrentA);
    await gateA;
    concurrentA -= 1;
    return { fingerprint: "a", generation: attemptsA };
  };
  let attemptsB = 0;
  const createB = async (schedule) => {
    attemptsB += 1;
    if (attemptsB === 1) {
      schedule({ id: "obsolete-b-work" });
      await gateFirstB;
    }
    return { fingerprint: "b", generation: attemptsB };
  };
  const dispatch = async (_runtime, work) => { discardedDispatches.push(work.id); };

  const firstA = cache.acquire({
    environment,
    fingerprint: "a",
    create: createA,
    dispatch,
  });
  await Promise.resolve();
  assert.equal(attemptsA, 1);

  const firstB = cache.acquire({
    environment,
    fingerprint: "b",
    create: createB,
    dispatch,
  });
  await Promise.resolve();
  assert.equal(attemptsB, 1);

  const rejoinedA = cache.acquire({
    environment,
    fingerprint: "a",
    create: createA,
    dispatch,
  });
  await Promise.resolve();
  assert.equal(attemptsA, 1);
  assert.equal(maximumConcurrentA, 1);

  releaseA();
  assert.equal(await firstA.runtime, await rejoinedA.runtime);
  assert.equal(maximumConcurrentA, 1);

  releaseFirstB();
  assert.deepEqual(await firstB.runtime, { fingerprint: "b", generation: 1 });
  await Promise.resolve();

  const cleanB = cache.acquire({
    environment,
    fingerprint: "b",
    create: createB,
    dispatch,
  });
  assert.deepEqual(await cleanB.runtime, { fingerprint: "b", generation: 2 });
  assert.equal(attemptsB, 2);
  assert.deepEqual(cleanB.drainInitializationScheduled(), []);
  assert.deepEqual(discardedDispatches, []);
});

test("late initialization failure evicts only after settlement and permits a clean retry", async () => {
  const cache = new IsolateRuntimeCache();
  const environment = {};
  let attempts = 0;
  let rejectInitialization;
  const create = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Promise((_, reject) => { rejectInitialization = reject; });
    }
    return { generation: attempts };
  };
  const first = cache.acquire({
    environment,
    fingerprint: "a",
    create,
    dispatch: async () => undefined,
    initializationTimeoutMs: 25,
  });
  await assert.rejects(first.runtime, { code: "runtime_initialization_timeout" });

  const shared = cache.acquire({
    environment,
    fingerprint: "a",
    create,
    dispatch: async () => undefined,
    initializationTimeoutMs: 1_000,
  });
  assert.equal(attempts, 1);
  rejectInitialization(new Error("late synthetic init failure"));
  await assert.rejects(shared.runtime, /late synthetic init failure/u);

  assert.deepEqual(
    await cache.acquire({
      environment,
      fingerprint: "a",
      create,
      dispatch: async () => undefined,
    }).runtime,
    { generation: 2 },
  );
  assert.equal(attempts, 2);
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
