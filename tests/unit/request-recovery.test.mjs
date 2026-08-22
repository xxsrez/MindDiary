import assert from "node:assert/strict";
import test from "node:test";

import {
  RequestRecoveryCoordinator,
  isRecoveryEligibleRequest,
} from "../../apps/mind-diary-site/worker/request-recovery.js";

const ORIGIN = "https://mind-diary.example";

test("only successful dynamic HTML document requests can trigger recovery", () => {
  const mobile = new Request(`${ORIGIN}/`, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mobile Safari",
    },
  });
  assert.equal(isRecoveryEligibleRequest(mobile, new Response("ok")), true);
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
    isRecoveryEligibleRequest(mobile, new Response("failed", { status: 503 })),
    false,
  );
});

test("a slow recovery starts only after foreground and never delays its response", async () => {
  const coordinator = new RequestRecoveryCoordinator();
  const environment = {};
  const order = [];
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const background = [];

  const response = await coordinator.respond({
    request: new Request(`${ORIGIN}/`, {
      headers: { accept: "text/html", "user-agent": "Mobile Safari" },
    }),
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
  assert.deepEqual(order, ["foreground-start", "foreground-complete", "recovery-start"]);
  assert.equal(background.length, 1);
  releaseRecovery();
  await background[0];
  assert.deepEqual(order, [
    "foreground-start",
    "foreground-complete",
    "recovery-start",
    "recovery-complete",
  ]);
});

test("concurrent home and asset burst creates one recovery flight", async () => {
  const coordinator = new RequestRecoveryCoordinator();
  const environment = {};
  let runs = 0;
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const background = [];
  const recover = async () => {
    runs += 1;
    await recoveryGate;
  };
  const respond = (path) => coordinator.respond({
    request: new Request(`${ORIGIN}${path}`, { headers: { accept: "text/html" } }),
    environment,
    fingerprint: "deployment-a",
    foreground: async () => new Response("ok"),
    recover,
    waitUntil: (promise) => background.push(promise),
  });

  await Promise.all([
    ...Array.from({ length: 20 }, () => respond("/")),
    ...Array.from({ length: 20 }, (_, index) => respond(`/_next/static/${index}.js`)),
  ]);
  assert.equal(runs, 1);
  assert.equal(background.length, 20);
  releaseRecovery();
  await Promise.all(background);
});

test("completion-based cadence prevents a recovery storm after success or failure", async () => {
  let now = 1_000;
  const coordinator = new RequestRecoveryCoordinator({
    cadenceMs: 30_000,
    now: () => now,
  });
  const environment = {};
  const background = [];
  let runs = 0;
  const respond = (recover = async () => undefined) => coordinator.respond({
    request: new Request(`${ORIGIN}/`, { headers: { accept: "text/html" } }),
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
