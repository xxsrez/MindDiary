import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_UI_CLIENT_JAVASCRIPT,
} from "../../packages/adapter-web/dist/product-ui-assets.js";

import {
  REQUEST_RECOVERY_PULSE_HEADER,
  RequestRecoveryCoordinator,
  createMindDiaryProductWorker,
  isRecoveryEligibleRequest,
  productWorkerConfigFingerprint,
  restrictedUatGeneratedSourceTestConfig,
} from "../../apps/mind-diary-site/worker/request-recovery.js";

const ORIGIN = "https://mind-diary.example";

function recoveryPulse(path = "/") {
  return new Request(`${ORIGIN}${path}`, {
    method: "HEAD",
    headers: {
      accept: "text/html",
      [REQUEST_RECOVERY_PULSE_HEADER]: "1",
    },
  });
}

test("product UI schedules a fire-and-forget recovery pulse only after page load", () => {
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /requestIdleCallback/u);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /setTimeout\(.*15000/su);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /visibilityState/u);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /method:"HEAD"/u);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /"x-mind-diary-recovery-pulse":"1"/u);
  assert.match(PRODUCT_UI_CLIENT_JAVASCRIPT, /addEventListener\("load"/u);
});

test("foreground reads never inherit scheduled work from request recovery", async () => {
  let schedule;
  let releaseDispatch;
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  const waits = [];
  const worker = createMindDiaryProductWorker({
    recoveryCoordinator: new RequestRecoveryCoordinator({ delay: async () => undefined }),
    async createRuntime(capturedSchedule) {
      schedule = capturedSchedule;
      return {
        async fetch() { return new Response("ok"); },
        async recoverBackground(limit, mode) {
          assert.equal(limit, 4);
          assert.equal(mode, "request");
          schedule({ kind: "revision_index", id: "job_recovery" });
        },
        async dispatchBackground() { await dispatchGate; },
      };
    },
    readConfig() { return { publicOrigin: ORIGIN }; },
    async fallbackFetch() { return new Response("fallback", { status: 404 }); },
  });
  const environment = {};
  const context = { waitUntil: (promise) => waits.push(promise) };

  assert.equal((await worker.fetch(recoveryPulse(), environment, context)).status, 200);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(waits.length, 1);

  assert.equal((await worker.fetch(
    new Request(`${ORIGIN}/minds`, { headers: { accept: "text/html" } }),
    environment,
    context,
  )).status, 200);
  assert.equal(waits.length, 1);

  releaseDispatch();
  await waits[0];
});

test("Product Worker serves static assets without composing the product runtime", async () => {
  let runtimeCreations = 0;
  let configReads = 0;
  const waits = [];
  const worker = createMindDiaryProductWorker({
    async createRuntime() {
      runtimeCreations += 1;
      throw new Error("static assets must not compose the runtime");
    },
    staticFetch(request) {
      return new URL(request.url).pathname === "/ui/app.css"
        ? new Response("asset", { headers: { "content-type": "text/css" } })
        : null;
    },
    readConfig() {
      configReads += 1;
      return { publicOrigin: ORIGIN };
    },
    async fallbackFetch() {
      return new Response("fallback", { status: 404 });
    },
  });

  const response = await worker.fetch(
    new Request(`${ORIGIN}/ui/app.css`),
    {},
    { waitUntil: (promise) => waits.push(promise) },
  );
  assert.equal(await response.text(), "asset");
  assert.equal(runtimeCreations, 0);
  assert.equal(configReads, 0);
  assert.equal(waits.length, 0);
});

test("Product Worker defers observational activity without delaying the response", async () => {
  let releaseActivity;
  const activity = new Promise((resolve) => { releaseActivity = resolve; });
  const waits = [];
  const worker = createMindDiaryProductWorker({
    async createRuntime() {
      return {
        async fetch(_request, deferActivity) {
          deferActivity(activity);
          return new Response("mcp response");
        },
        async recoverBackground() {},
        async dispatchBackground() {},
      };
    },
    readConfig() {
      return { publicOrigin: ORIGIN };
    },
    async fallbackFetch() {
      return new Response("fallback", { status: 404 });
    },
  });

  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/mcp`, { method: "POST" }),
    {},
    { waitUntil: (promise) => waits.push(promise) },
  );
  assert.equal(await response.text(), "mcp response");
  assert.equal(waits.length, 1);
  releaseActivity();
  await waits[0];
});

test("runtime cache fingerprint fences every restricted UAT configuration generation", () => {
  const baseline = productWorkerConfigFingerprint({}, ORIGIN);
  for (const [name, value] of Object.entries({
    MIND_DIARY_DEPLOYMENT_CLASS: "uat",
    MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
    MIND_DIARY_CAPACITY_PROFILE: "restricted-uat-v1",
    MIND_DIARY_RELEASE_CANDIDATE_SHA: "a".repeat(40),
    MIND_DIARY_CAPACITY_FENCE_NONCE: "capacity-fence-nonce-1234",
    MIND_DIARY_PERFORMANCE_CORRELATION_KEY: "performance-correlation-key-private",
  })) {
    const fingerprint = productWorkerConfigFingerprint({ [name]: value }, ORIGIN);
    assert.notEqual(fingerprint, baseline, name);
    assert.equal(fingerprint.includes(value), false, name);
  }
});

test("generated-source test composition installs only for exact restricted UAT lineage", async () => {
  const candidateSha = "a".repeat(40);
  assert.deepEqual(restrictedUatGeneratedSourceTestConfig({
    MIND_DIARY_DEPLOYMENT_CLASS: "uat",
    MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
    MIND_DIARY_RELEASE_CANDIDATE_SHA: candidateSha,
  }), {
    deploymentClass: "uat",
    deploymentPosture: "restricted-uat",
    candidateSha,
  });
  for (const environment of [
    {},
    {
      MIND_DIARY_DEPLOYMENT_CLASS: "production",
      MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
      MIND_DIARY_RELEASE_CANDIDATE_SHA: candidateSha,
    },
    {
      MIND_DIARY_DEPLOYMENT_CLASS: "uat",
      MIND_DIARY_DEPLOYMENT_POSTURE: "public",
      MIND_DIARY_RELEASE_CANDIDATE_SHA: candidateSha,
    },
    {
      MIND_DIARY_DEPLOYMENT_CLASS: "uat",
      MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
      MIND_DIARY_RELEASE_CANDIDATE_SHA: "not-a-sha",
    },
  ]) assert.equal(restrictedUatGeneratedSourceTestConfig(environment), undefined);

  let createdOptions;
  const worker = createMindDiaryProductWorker({
    async createRuntime(options) {
      createdOptions = options;
      return {
        async fetch() { return new Response("ok"); },
        async recoverBackground() {},
        async dispatchBackground() {},
      };
    },
    readConfig() { return { publicOrigin: ORIGIN }; },
    async fallbackFetch() { return new Response("fallback", { status: 404 }); },
  });
  const environment = {
    MIND_DIARY_DEPLOYMENT_CLASS: "uat",
    MIND_DIARY_DEPLOYMENT_POSTURE: "restricted-uat",
    MIND_DIARY_RELEASE_CANDIDATE_SHA: candidateSha,
  };
  await worker.fetch(
    new Request(`${ORIGIN}/`),
    environment,
    { waitUntil() {} },
  );
  assert.deepEqual(createdOptions.restrictedUatGeneratedSourceTest, {
    deploymentClass: "uat",
    deploymentPosture: "restricted-uat",
    candidateSha,
  });
});

test("only a successful explicit post-load HEAD pulse can trigger recovery", () => {
  const mobile = new Request(`${ORIGIN}/`, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mobile Safari",
    },
  });
  assert.equal(isRecoveryEligibleRequest(mobile, new Response("ok")), false);
  assert.equal(isRecoveryEligibleRequest(recoveryPulse(), new Response("ok")), true);
  for (const path of [
    "/_next/static/app.js",
    "/assets/app.css",
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/image.webp",
  ]) {
    assert.equal(
      isRecoveryEligibleRequest(new Request(`${ORIGIN}${path}`), new Response("asset")),
      false,
      path,
    );
  }
  assert.equal(
    isRecoveryEligibleRequest(new Request(`${ORIGIN}/api/v1/minds`, { method: "OPTIONS" }), new Response(null, { status: 204 })),
    false,
  );
  for (const request of [
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json" },
    }),
    new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
    }),
    new Request(`${ORIGIN}/api/v1/minds`, {
      headers: { accept: "application/json" },
    }),
    new Request(`${ORIGIN}/callback`, {
      headers: { accept: "text/html" },
    }),
  ]) {
    assert.equal(isRecoveryEligibleRequest(request, new Response("ok")), false, request.url);
  }
  assert.equal(
    isRecoveryEligibleRequest(recoveryPulse(), new Response("failed", { status: 503 })),
    false,
  );
});

test("a slow recovery starts only after foreground and never delays its response", async () => {
  let releaseIdle;
  const idleGate = new Promise((resolve) => { releaseIdle = resolve; });
  const coordinator = new RequestRecoveryCoordinator({
    delay: () => idleGate,
  });
  const environment = {};
  const order = [];
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const background = [];

  const response = await coordinator.respond({
    request: recoveryPulse(),
    environment,
    fingerprint: "deployment-a",
    foreground: async () => {
      order.push("foreground-start");
      order.push("foreground-complete");
      return new Response("home");
    },
    recover: async () => {
      order.push("recovery-start");
      await recoveryGate;
      order.push("recovery-complete");
    },
    waitUntil: (promise) => background.push(promise),
  });

  assert.equal(await response.text(), "home");
  assert.deepEqual(order, ["foreground-start", "foreground-complete"]);
  assert.equal(background.length, 1);
  releaseIdle();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["foreground-start", "foreground-complete", "recovery-start"]);

  const secondResponse = await coordinator.respond({
    request: new Request(`${ORIGIN}/me`, {
      headers: { accept: "text/html", "user-agent": "Mobile Safari" },
    }),
    environment,
    fingerprint: "deployment-a",
    foreground: async () => {
      order.push("second-foreground-complete");
      return new Response("my mind");
    },
    recover: async () => {
      throw new Error("an active recovery flight must be reused");
    },
    waitUntil: (promise) => background.push(promise),
  });
  assert.equal(await secondResponse.text(), "my mind");
  assert.equal(background.length, 1);
  assert.deepEqual(order, [
    "foreground-start",
    "foreground-complete",
    "recovery-start",
    "second-foreground-complete",
  ]);

  releaseRecovery();
  await background[0];
  assert.deepEqual(order, [
    "foreground-start",
    "foreground-complete",
    "recovery-start",
    "second-foreground-complete",
    "recovery-complete",
  ]);
});

test("post-load pulse owns recovery while document and asset requests remain foreground-only", async () => {
  const coordinator = new RequestRecoveryCoordinator({
    delay: async () => undefined,
  });
  const environment = {};
  let runs = 0;
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const background = [];
  const recover = async () => {
    runs += 1;
    await recoveryGate;
  };
  const respond = (request) => coordinator.respond({
    request,
    environment,
    fingerprint: "deployment-a",
    foreground: async () => new Response("ok"),
    recover,
    waitUntil: (promise) => background.push(promise),
  });

  await Promise.all([
    respond(recoveryPulse()),
    ...Array.from({ length: 20 }, () =>
      respond(new Request(`${ORIGIN}/`, { headers: { accept: "text/html" } }))),
    ...Array.from({ length: 20 }, (_, index) =>
      respond(new Request(`${ORIGIN}/_next/static/${index}.js`))),
  ]);
  assert.equal(runs, 1);
  assert.equal(background.length, 1);
  releaseRecovery();
  await Promise.all(background);
});

test("a later pulse fences the previous idle wait without sharing cancellation I/O", async () => {
  const idleResolvers = [];
  const coordinator = new RequestRecoveryCoordinator({
    delay: () => new Promise((resolve) => idleResolvers.push(resolve)),
  });
  const environment = {};
  const background = [];
  let runs = 0;
  const respond = () => coordinator.respond({
    request: recoveryPulse(),
    environment,
    fingerprint: "deployment-a",
    foreground: async () => new Response("ok"),
    recover: async () => { runs += 1; },
    waitUntil: (promise) => background.push(promise),
  });

  await respond();
  assert.equal(background.length, 1);
  await respond();
  assert.equal(background.length, 2);
  idleResolvers[0]();
  await background[0];
  assert.equal(runs, 0);
  idleResolvers[1]();
  await background[1];
  assert.equal(runs, 1);
});

test("completion-based cadence prevents a recovery storm after success or failure", async () => {
  let now = 1_000;
  const coordinator = new RequestRecoveryCoordinator({
    cadenceMs: 30_000,
    delay: async () => undefined,
    now: () => now,
  });
  const environment = {};
  const background = [];
  let runs = 0;
  const respond = (recover = async () => undefined) => coordinator.respond({
    request: recoveryPulse(),
    environment,
    fingerprint: "deployment-a",
    foreground: async () => new Response("ok"),
    recover: async () => {
      runs += 1;
      return recover();
    },
    waitUntil: (promise) => background.push(promise),
  });

  await respond();
  await background.at(-1);
  await respond();
  assert.equal(runs, 1);
  now += 29_999;
  await respond();
  assert.equal(runs, 1);
  now += 1;
  await respond(async () => { throw new Error("slow dependency failed"); });
  await background.at(-1);
  assert.equal(runs, 2);
  await respond();
  assert.equal(runs, 2);
});

test("a new pulse fences an older idle timer before foreground completes", async () => {
  const idleResolvers = [];
  const coordinator = new RequestRecoveryCoordinator({
    idleMs: 3_000,
    delay: () => new Promise((resolve) => idleResolvers.push(resolve)),
  });
  const environment = {};
  const background = [];
  let runs = 0;
  let releaseSecondForeground;
  const secondForegroundGate = new Promise((resolve) => {
    releaseSecondForeground = resolve;
  });
  const options = {
    request: recoveryPulse(),
    environment,
    fingerprint: "deployment-a",
    recover: async () => { runs += 1; },
    waitUntil: (promise) => background.push(promise),
  };

  await coordinator.respond({
    ...options,
    foreground: async () => new Response("first"),
  });
  assert.equal(idleResolvers.length, 1);

  const second = coordinator.respond({
    ...options,
    foreground: async () => {
      await secondForegroundGate;
      return new Response("second");
    },
  });
  idleResolvers[0]();
  await background[0];
  assert.equal(runs, 0);

  releaseSecondForeground();
  await second;
  assert.equal(idleResolvers.length, 2);
  idleResolvers[1]();
  await background[1];
  assert.equal(runs, 1);
});
