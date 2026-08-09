import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_CONTROL_REQUEST_SECURITY_POLICY,
  WebControlRequestSecurityBoundary,
} from "../../packages/adapter-web/dist/index.js";
import {
  createLocalWebControlRequestSecurityBoundary,
} from "../../packages/composition-root/dist/index.js";
import { CAPABILITIES } from "../../packages/domain/dist/index.js";

const ORIGIN = "https://mind-diary.example";
const CSRF = "csrf-fixture-7c4f4b24b02f4f7db2e2c2df";
const DENIED = {
  kind: "denied",
  status: 403,
  code: "forbidden",
  retryable: false,
};

function actor(authentication = { kind: "sites_identity" }) {
  return {
    kind: "registered_principal",
    principalId: "principal_request_security",
    authentication,
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_control_mutation",
    occurredAtUtc: "2026-08-07T22:00:00.000Z",
  };
}

function mutation({
  method = "POST",
  url = `${ORIGIN}/api/v1/minds`,
  origin = ORIGIN,
  csrf = CSRF,
  headers = {},
} = {}) {
  const options = {
    method,
    headers: {
      accept: "application/json",
      authorization: "Bearer must-not-reach-command",
      cookie: "session=must-not-reach-command",
      "content-type": "application/json",
      "idempotency-key": "request-security-key",
      ...(origin === null ? {} : { origin }),
      ...(csrf === null ? {} : { "x-csrf-token": csrf }),
      ...headers,
    },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify({ name: "Safe fixture" }) }),
  };
  return new Request(url, options);
}

function harness({ verify } = {}) {
  const state = { csrfChecks: 0, executions: 0, bodies: [] };
  const boundary = createLocalWebControlRequestSecurityBoundary({
    applicationOrigin: ORIGIN,
    csrf: {
      async verify(input) {
        state.csrfChecks += 1;
        return verify ? verify(input) : input.token === CSRF;
      },
    },
    executor: {
      async execute(input) {
        state.executions += 1;
        assert.equal(input.request.headers.get("origin"), null);
        assert.equal(input.request.headers.get("x-csrf-token"), null);
        assert.equal(input.request.headers.get("authorization"), null);
        assert.equal(input.request.headers.get("cookie"), null);
        assert.equal(
          input.request.headers.get("idempotency-key"),
          "request-security-key",
        );
        const body = await input.request.json();
        state.bodies.push(body);
        return { mutation: state.executions, body };
      },
    },
  });
  return { boundary, state };
}

test("composition root wires the concrete fail-closed Origin and CSRF policy", () => {
  assert.deepEqual(WEB_CONTROL_REQUEST_SECURITY_POLICY, {
    origin: "configured-exact-origin",
    csrf: "principal-bound-session-verifier",
    mutationMethods: ["POST", "PATCH", "PUT", "DELETE"],
    forwardsSecurityCredentials: false,
  });
  assert.throws(
    () => new WebControlRequestSecurityBoundary({
      applicationOrigin: `${ORIGIN}/`,
      csrf: { verify: () => true },
      executor: { execute: () => null },
    }),
    /canonical HTTPS or loopback HTTP origin/u,
  );
  assert.throws(
    () => new WebControlRequestSecurityBoundary({
      applicationOrigin: "http://mind-diary.example",
      csrf: { verify: () => true },
      executor: { execute: () => null },
    }),
    /canonical HTTPS or loopback HTTP origin/u,
  );
  assert.doesNotThrow(() => new WebControlRequestSecurityBoundary({
    applicationOrigin: "http://localhost:3000",
    csrf: { verify: () => true },
    executor: { execute: () => null },
  }));
});

test("all declared mutation methods execute only after exact Origin and CSRF", async () => {
  const env = harness();
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const result = await env.boundary.execute(actor(), mutation({ method }));
    assert.equal(result.kind, "executed");
    assert.equal(result.value.mutation, env.state.executions);
  }
  assert.equal(env.state.csrfChecks, 4);
  assert.equal(env.state.executions, 4);
  assert.deepEqual(env.state.bodies, Array.from({ length: 4 }, () => ({
    name: "Safe fixture",
  })));
});

test("origin, URL, actor, method and CSRF failures are indistinguishable and preserve state", async () => {
  const env = harness();
  const invalid = [
    { currentActor: actor(), request: mutation({ origin: null }) },
    { currentActor: actor(), request: mutation({ origin: "null" }) },
    { currentActor: actor(), request: mutation({ origin: `${ORIGIN}/` }) },
    { currentActor: actor(), request: mutation({ origin: "https://attacker.invalid" }) },
    { currentActor: actor(), request: mutation({ url: "https://attacker.invalid/api/v1/minds" }) },
    { currentActor: actor(), request: mutation({ url: `${ORIGIN}/outside-control` }) },
    { currentActor: actor(), request: mutation({ csrf: null }) },
    { currentActor: actor(), request: mutation({ csrf: " leading-space" }) },
    { currentActor: actor(), request: mutation({ csrf: `${CSRF},duplicate` }) },
    { currentActor: actor({
      kind: "mcp_token",
      tokenId: "token_not_sites",
      effectiveScopes: ["content:read", "content:write"],
    }), request: mutation() },
    { currentActor: actor(), request: mutation({ method: "GET" }) },
  ];

  for (const scenario of invalid) {
    const result = await env.boundary.execute(
      scenario.currentActor,
      scenario.request,
    );
    assert.deepEqual(result, DENIED);
    assert.equal(scenario.request.bodyUsed, false);
  }
  assert.equal(env.state.executions, 0);
  assert.deepEqual(env.state.bodies, []);
});

test("spoofed routing headers never replace the configured public origin", async () => {
  const env = harness();
  const denied = await env.boundary.execute(
    actor(),
    mutation({
      url: "https://internal.invalid/api/v1/minds",
      headers: {
        host: "mind-diary.example",
        "x-forwarded-host": "mind-diary.example",
        "x-forwarded-proto": "https",
      },
    }),
  );
  assert.deepEqual(denied, DENIED);
  assert.equal(env.state.executions, 0);
});

test("verifier denial, failure and a revocation race all fail closed before command execution", async () => {
  const denied = harness({ verify: () => false });
  assert.deepEqual(
    await denied.boundary.execute(actor(), mutation()),
    DENIED,
  );
  assert.equal(denied.state.executions, 0);

  const failed = harness({ verify: () => {
    throw new Error("private verifier details");
  } });
  assert.deepEqual(
    await failed.boundary.execute(actor(), mutation()),
    DENIED,
  );
  assert.equal(failed.state.executions, 0);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let active = true;
  const raced = harness({ verify: async () => {
    await gate;
    return active;
  } });
  const pending = raced.boundary.execute(actor(), mutation());
  active = false;
  release();
  assert.deepEqual(await pending, DENIED);
  assert.equal(raced.state.executions, 0);
});

test("a denied request leaves its body reusable for one corrected retry", async () => {
  const env = harness();
  const firstRequest = mutation({ csrf: "wrong-csrf" });
  assert.deepEqual(
    await env.boundary.execute(actor(), firstRequest),
    DENIED,
  );
  assert.equal(firstRequest.bodyUsed, false);
  assert.equal(env.state.executions, 0);

  const retry = await env.boundary.execute(actor(), mutation());
  assert.equal(retry.kind, "executed");
  assert.equal(env.state.executions, 1);
  assert.deepEqual(env.state.bodies, [{ name: "Safe fixture" }]);
});
