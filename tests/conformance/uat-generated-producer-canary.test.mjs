import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FIXTURE_SHA256,
  GENERATED_CANARY_ASSERTION_IDS,
  ProbeFailure,
  assertCanaryDocument,
  createReceipt,
  loadCredentialEnvironment,
  parseCli,
  run,
} from "../../scripts/run-uat-generated-producer-canary.mjs";

const CANDIDATE_SHA = "a".repeat(40);
const SETUP_DEPLOYMENT = "appgdep_generatedsetup123";
const VERIFY_DEPLOYMENT = "appgdep_generatedverify456";
const NONCE = "abcdef0123456789";
const HANDLE = `md290-generated-${NONCE}`;
const NAME = `MD-290 Generated Canary ${NONCE}`;
const BASE_URL = "https://uat.generated-canary.example.test";
const NOW = "2026-08-24T12:00:00.000Z";
const HIDDEN_ROUTE = "/api/v1/internal/operators/generated-ingress-canary";
const SITES_ENV = ["MIND_DIARY_UAT_GENERATED_CANARY_SITES", "TOKEN"].join("_");
const MCP_ENV = ["MIND_DIARY_UAT_GENERATED_CANARY_MCP", "TOKEN"].join("_");
const TARGET_FINGERPRINT = `md290-target-${"b".repeat(32)}`;
const RUN_FINGERPRINT = `md290-run-${"c".repeat(32)}`;
const RESOURCE_FINGERPRINT = `md290-resource-${"d".repeat(32)}`;
const EXPECTED_FIXTURE_SHA256 = Object.freeze([
  "sha256:1b56b50ac4e976f488f128cabdcdffb2fc9331d6974bb9968131a415d14ade24",
  "sha256:95acc04f9967f3f6971471ac9903c3a0135f010cc246039bb186e6f079bb6af0",
]);
const SETUP_ASSERTIONS = Object.freeze([
  "target.synthetic_private_owner_mind",
  "binding.preexisting_current_generation",
  "negative.foreign_binding_no_head",
  "negative.expired_binding_no_head",
  "negative.mime_no_head",
  "negative.size_no_head",
  "negative.quota_no_head",
  "negative.cancel_no_head",
  "negative.replay_no_head",
  "negative.writer_failure_no_head",
  "stage.bounded_replay_exact",
  "stage.server_stream_exact",
  "commit.atomic_generated_files_and_markdown",
]);
const VERIFY_ASSERTIONS = Object.freeze([
  "persistence.reconstruction_after_redeploy",
  "history.head_and_historical_exact_bytes_sha",
  "binding.current_generation_after_redeploy",
]);

function credentials() {
  return {
    [SITES_ENV]: "sites-generated-operator",
    [MCP_ENV]: "mdp_v1_generated_operator",
  };
}

function json(status, body) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function mcpSuccess(id, data) {
  return json(200, {
    jsonrpc: "2.0",
    id,
    result: {
      isError: false,
      structuredContent: { data },
    },
  });
}

function binding({ id, route, state = "active" }) {
  const personal = route === "/me";
  return {
    write_binding_id: id,
    state,
    mind_id: personal ? "mind-service-personal" : "mind-service-canary",
    mind: {
      mind_id: personal ? "mind-service-personal" : "mind-service-canary",
      route,
      name: personal ? "Fixture Personal Mind" : NAME,
      visibility: "private",
      head: { revision_id: personal ? "revision-service-personal" : "revision-service-canary" },
    },
  };
}

function generatedCanaryFixture({
  failCreate = false,
  failCanaryAction = null,
  preexistingTarget = false,
} = {}) {
  const model = {
    mindExists: preexistingTarget,
    targetRole: "owner",
    targetVisibility: "private",
    targetName: NAME,
    extraMember: false,
    bindingVersion: 0,
    currentBinding: null,
    mcpCalls: [],
    apiCalls: [],
    hiddenCalls: [],
    deletes: 0,
    failCreate,
    failCanaryAction,
  };

  const target = () => ({
    mind_id: "mind-service-canary",
    name: model.targetName,
    route: `/${HANDLE}`,
    visibility: model.targetVisibility,
    metadata_version: 1,
    head: { revision_id: "revision-service-canary" },
    access: { kind: "membership", role: model.targetRole },
  });

  const bindingProjection = () => ({
    binding_version: model.bindingVersion,
    read_bindings: [],
    write_binding: model.currentBinding,
    automatic_capture: {
      mode: "disabled",
      write_binding_id: null,
      updated_at: null,
    },
  });

  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers ?? {});
    const hasSitesCredential =
      headers.get("OAI-Sites-Authorization") === "Bearer sites-generated-operator";
    if (!hasSitesCredential) {
      return json(401, { error: { code: "authentication_required" } });
    }

    let body = null;
    if (typeof options.body === "string" && options.body.length > 0) {
      body = JSON.parse(options.body);
    }
    model.apiCalls.push({ path: url.pathname, method, body, headers });

    if (url.pathname === "/api/mcp" && method === "POST") {
      if (headers.get("authorization") !== "Bearer mdp_v1_generated_operator") {
        return json(401, { error: { code: "authentication_required" } });
      }
      const call = body?.params;
      model.mcpCalls.push({ name: call?.name, arguments: call?.arguments });
      if (call?.name === "list_minds") {
        return mcpSuccess(body.id, {
          minds: [
            {
              mind_id: "mind-service-personal",
              name: "Fixture Personal Mind",
              route: "/me",
              visibility: "private",
            },
            ...(model.mindExists ? [target()] : []),
          ],
        });
      }
      if (call?.name === "get_mind_bindings") {
        return mcpSuccess(body.id, bindingProjection());
      }
      if (call?.name === "set_write_mind_binding") {
        const args = call.arguments;
        if (args?.expected_binding_version !== model.bindingVersion) {
          return json(200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: true,
              structuredContent: { error: { code: "binding_version_conflict" } },
            },
          });
        }
        const previous = model.currentBinding === null
          ? null
          : { ...model.currentBinding, state: "invalidated" };
        model.bindingVersion += 1;
        if (args.action === "bind") {
          const id = args.mind === "/me"
            ? "write_binding_service_personal"
            : "write_binding_service_canary";
          model.currentBinding = binding({ id, route: args.mind });
        } else if (args.action === "unbind") {
          model.currentBinding = null;
        } else {
          return json(200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: true,
              structuredContent: { error: { code: "invalid_request" } },
            },
          });
        }
        return mcpSuccess(body.id, {
          binding_version: model.bindingVersion,
          previous,
          current: model.currentBinding,
        });
      }
      return json(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          structuredContent: { error: { code: "unknown_tool" } },
        },
      });
    }

    if (url.pathname === HIDDEN_ROUTE && method === "POST") {
      assert.equal(headers.get("authorization"), "Bearer mdp_v1_generated_operator");
      assert.equal(headers.has("x-mind-diary-canary-mcp-authorization"), false);
      assert.equal(headers.get("origin"), BASE_URL);
      assert.equal(headers.get("x-csrf-token"), "fixture-csrf");
      model.hiddenCalls.push(body);
      if (model.failCanaryAction === body?.action) {
        return json(503, { ok: false, error: { code: "canary_unavailable" } });
      }
      const assertions = body?.action === "setup" ? SETUP_ASSERTIONS : VERIFY_ASSERTIONS;
      return json(200, {
        ok: true,
        data: {
          status: body?.action === "setup" ? "awaiting_redeploy" : "verified",
          fixture_profile: "md290-generated-producer-v1",
          fixture_sha256: EXPECTED_FIXTURE_SHA256,
          assertions,
        },
      });
    }

    if (url.pathname === "/api/v1/session" && method === "GET") {
      return json(200, {
        data: {
          principal: { principal_id: "principal-service-operator" },
          personal_mind: {
            mind_id: "mind-service-personal",
            name: "Fixture Personal Mind",
            route: "/me",
            visibility: "private",
            head: { revision_id: "revision-service-personal" },
          },
        },
      });
    }

    if (url.pathname === "/api/v1/minds" && method === "POST") {
      assert.deepEqual(body, { name: NAME, handle: HANDLE });
      if (model.mindExists) {
        return json(409, { error: { code: "mind_handle_conflict" } });
      }
      if (model.failCreate) {
        return json(503, { error: { code: "fixture_create_unavailable" } });
      }
      model.mindExists = true;
      return json(200, { data: target() });
    }

    if (url.pathname === "/api/v1/minds" && method === "GET") {
      return json(200, {
        data: [
          {
            mind_id: "mind-service-personal",
            name: "Fixture Personal Mind",
            route: "/me",
            visibility: "private",
            access: { kind: "membership", role: "owner" },
          },
          ...(model.mindExists ? [target()] : []),
        ],
      });
    }

    if (url.pathname === `/api/v1/minds/${HANDLE}` && method === "GET") {
      return model.mindExists
        ? json(200, { data: target() })
        : json(404, { error: { code: "mind_not_found" } });
    }

    if (url.pathname === `/api/v1/minds/${HANDLE}/members` && method === "GET") {
      if (!model.mindExists) return json(404, { error: { code: "mind_not_found" } });
      return json(200, {
        data: {
          members: [
            {
              member_id: "member-service-operator",
              is_self: true,
              role: model.targetRole,
            },
            ...(model.extraMember
              ? [{ member_id: "member-service-other", is_self: false, role: "reader" }]
              : []),
          ],
        },
      });
    }

    if (url.pathname === `/api/v1/minds/${HANDLE}/deletion-impact` && method === "GET") {
      if (!model.mindExists) return json(404, { error: { code: "mind_not_found" } });
      return json(200, {
        data: {
          impact_id: "impact-service-canary",
          confirmation: `delete-mind:${HANDLE}`,
        },
      });
    }

    if (url.pathname === `/api/v1/minds/${HANDLE}` && method === "DELETE") {
      assert.deepEqual(body, {
        impact_id: "impact-service-canary",
        confirmation: `delete-mind:${HANDLE}`,
      });
      model.deletes += 1;
      model.mindExists = false;
      return json(200, { data: { replayed: false } });
    }

    if (method === "GET") {
      return new Response(
        '<!doctype html><meta name="mind-diary-csrf-token" content="fixture-csrf">',
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return json(404, { error: { code: "not_found" } });
  };

  return { fetchImpl, model };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function assertMissing(path) {
  await assert.rejects(
    readFile(path, "utf8"),
    (error) => error?.code === "ENOENT",
  );
}

async function assertPrivateFile(path) {
  const metadata = await stat(path);
  assert.equal(metadata.mode & 0o777, 0o600);
  return metadata;
}

function assertNoPrivateMaterial(document, paths = []) {
  const serialized = typeof document === "string" ? document : JSON.stringify(document);
  for (const forbidden of [
    "sites-generated-operator",
    "mdp_v1_generated_operator",
    "operator@example.test",
    BASE_URL,
    HANDLE,
    NAME,
    "principal-service-operator",
    "mind-service-canary",
    "mind-service-personal",
    "write_binding_service_canary",
    "write_binding_service_personal",
    "revision-service-canary",
    "impact-service-canary",
    ...paths,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `must redact ${forbidden}`);
  }
}

test("fixture hashes, assertion inventory and receipt are deterministic and redacted", () => {
  assert.deepEqual(FIXTURE_SHA256, EXPECTED_FIXTURE_SHA256);
  for (const id of [...SETUP_ASSERTIONS, ...VERIFY_ASSERTIONS]) {
    assert.equal(GENERATED_CANARY_ASSERTION_IDS.includes(id), true, id);
  }

  const input = {
    candidateSha: CANDIDATE_SHA,
    setupDeploymentId: SETUP_DEPLOYMENT,
    verifyDeploymentId: VERIFY_DEPLOYMENT,
    targetFingerprint: TARGET_FINGERPRINT,
    runFingerprint: RUN_FINGERPRINT,
    resourceFingerprint: RESOURCE_FINGERPRINT,
    fixtureSha256: FIXTURE_SHA256,
    observedAtUtc: NOW,
  };
  const first = createReceipt(input);
  assert.deepEqual(first, createReceipt(input));
  assert.equal(first.schema, "mind-diary/uat-generated-producer-canary-receipt/v1");
  assert.equal(first.status, "passed");
  assert.equal(first.candidate_sha, CANDIDATE_SHA);
  assert.equal(first.setup_deployment_id, SETUP_DEPLOYMENT);
  assert.equal(first.verify_deployment_id, VERIFY_DEPLOYMENT);
  assert.equal(first.target_fingerprint, TARGET_FINGERPRINT);
  assert.equal(first.run_fingerprint, RUN_FINGERPRINT);
  assert.equal(first.resource_fingerprint, RESOURCE_FINGERPRINT);
  assert.deepEqual(first.fixture_sha256, EXPECTED_FIXTURE_SHA256);
  assert.deepEqual(first.assertions.map(({ id }) => id), GENERATED_CANARY_ASSERTION_IDS);
  assert.equal(first.assertions.every(({ status }) => status === "passed"), true);
  assert.match(first.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assertNoPrivateMaterial(first);
});

test("canary document guard rejects credentials, identities, URLs and local paths", () => {
  for (const value of [
    { secret: "mdp_v1_not-a-real-token" },
    { email: "operator@example.test" },
    { url: BASE_URL },
    { principal: "principal_service_private" },
    { mind: "mind_service_private" },
    { binding: "write_binding_service_private" },
    { revision: "revision_service_private" },
    { path: "/private/tmp/canary-state.json" },
  ]) {
    assert.throws(
      () => assertCanaryDocument(value),
      (error) => error instanceof ProbeFailure,
    );
  }
});

test("CLI and environment accept only the four phases and environment-backed credentials", () => {
  assert.deepEqual(loadCredentialEnvironment(credentials()), {
    sitesToken: "sites-generated-operator",
    mcpToken: credentials()[MCP_ENV],
  });
  assert.deepEqual(parseCli(["--help"]), { help: true });
  assert.deepEqual(parseCli([
    "--phase", "setup",
    "--candidate-sha", CANDIDATE_SHA,
    "--deployment-id", SETUP_DEPLOYMENT,
    "--state-out", "/private/state.json",
    "--base-url", BASE_URL,
    "--nonce", NONCE,
  ]), {
    phase: "setup",
    candidate_sha: CANDIDATE_SHA,
    deployment_id: SETUP_DEPLOYMENT,
    state_out: "/private/state.json",
    base_url: BASE_URL,
    nonce: NONCE,
  });
  for (const phase of ["verify", "cleanup", "recover"]) {
    const parsed = parseCli(["--phase", phase, "--state", "/private/state.json"]);
    assert.equal(parsed.phase, phase);
    assert.equal(parsed.state, "/private/state.json");
  }
  assert.throws(
    () => parseCli(["--phase", "recovery", "--state", "/private/state.json"]),
    (error) => error instanceof ProbeFailure,
  );
  assert.throws(
    () => parseCli(["--phase", "setup", "--sites-token", "secret"]),
    (error) => error instanceof ProbeFailure,
  );
  assert.throws(
    () => loadCredentialEnvironment({}),
    (error) => error instanceof ProbeFailure,
  );
});

test("setup, redeploy verify and cleanup preserve the phase boundary and emit a private receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-generated-canary-"));
  const statePath = join(directory, "state.json");
  const receiptPath = join(directory, "receipt.json");
  const fixture = generatedCanaryFixture();
  try {
    const setup = await run({
      phase: "setup",
      candidate_sha: CANDIDATE_SHA,
      deployment_id: SETUP_DEPLOYMENT,
      state_out: statePath,
      base_url: BASE_URL,
      nonce: NONCE,
    }, {
      environment: credentials(),
      fetchImpl: fixture.fetchImpl,
      now: () => NOW,
    });
    assert.equal(setup.status, "awaiting_redeploy");
    const setupMetadata = await assertPrivateFile(statePath);
    const setupState = await readJson(statePath);
    assert.equal(setupState.schema, "mind-diary/uat-generated-producer-canary-state/v1");
    assert.equal(setupState.status, "awaiting_redeploy");
    assert.match(setupState.target_fingerprint, /^md290-target-[0-9a-f]{32}$/u);
    assert.match(setupState.run_fingerprint, /^md290-run-[0-9a-f]{32}$/u);
    assert.match(setupState.resource_fingerprint, /^md290-resource-[0-9a-f]{32}$/u);
    assertNoPrivateMaterial(setupState, [directory, statePath, receiptPath]);
    await assertMissing(receiptPath);

    const bindCalls = fixture.model.mcpCalls.filter(({ name }) =>
      name === "set_write_mind_binding");
    assert.equal(bindCalls.length, 2);
    assert.equal(bindCalls[0].arguments.action, "bind");
    assert.equal(bindCalls[0].arguments.mind, "/me");
    assert.equal(bindCalls[1].arguments.action, "bind");
    assert.equal(bindCalls[1].arguments.mind, `/${HANDLE}`);
    assert.equal(bindCalls[1].arguments.expected_binding_version, 1);
    assert.deepEqual(fixture.model.hiddenCalls, [{
      action: "setup",
      run_nonce: NONCE,
      write_binding_id: "write_binding_service_canary",
      stale_write_binding_id: "write_binding_service_personal",
    }]);
    assert.equal(fixture.model.mindExists, true);
    assert.equal(fixture.model.targetVisibility, "private");

    await assert.rejects(
      run({
        phase: "verify",
        deployment_id: VERIFY_DEPLOYMENT,
        state: statePath,
        base_url: "https://wrong.generated-canary.example.test",
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    assert.equal(fixture.model.hiddenCalls.length, 1);

    await assert.rejects(
      run({
        phase: "verify",
        deployment_id: SETUP_DEPLOYMENT,
        state: statePath,
        base_url: BASE_URL,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    assert.equal(fixture.model.hiddenCalls.length, 1);

    const verified = await run({
      phase: "verify",
      deployment_id: VERIFY_DEPLOYMENT,
      state: statePath,
      base_url: BASE_URL,
    }, {
      environment: credentials(),
      fetchImpl: fixture.fetchImpl,
      now: () => NOW,
    });
    assert.equal(verified.status, "verified");
    const verifiedMetadata = await assertPrivateFile(statePath);
    assert.notEqual(verifiedMetadata.ino, setupMetadata.ino, "state update must use atomic replacement");
    const verifiedState = await readJson(statePath);
    assert.equal(verifiedState.status, "verified");
    assertNoPrivateMaterial(verifiedState, [directory, statePath, receiptPath]);
    await assertMissing(receiptPath);
    assert.deepEqual(fixture.model.hiddenCalls[1], {
      action: "verify",
      run_nonce: NONCE,
      write_binding_id: "write_binding_service_canary",
    });

    const cleaned = await run({
      phase: "cleanup",
      state: statePath,
      receipt_out: receiptPath,
      base_url: BASE_URL,
    }, {
      environment: credentials(),
      fetchImpl: fixture.fetchImpl,
      now: () => NOW,
    });
    assert.equal(cleaned.status, "passed");
    const passedMetadata = await assertPrivateFile(statePath);
    assert.notEqual(passedMetadata.ino, verifiedMetadata.ino, "cleanup state update must be atomic");
    await assertPrivateFile(receiptPath);
    assert.equal(fixture.model.mindExists, false);
    assert.equal(fixture.model.deletes, 1);
    assert.equal(fixture.model.currentBinding, null);

    const passedState = await readJson(statePath);
    const receipt = await readJson(receiptPath);
    assert.equal(passedState.status, "passed");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.candidate_sha, CANDIDATE_SHA);
    assert.equal(receipt.setup_deployment_id, SETUP_DEPLOYMENT);
    assert.equal(receipt.verify_deployment_id, VERIFY_DEPLOYMENT);
    assert.equal(receipt.target_fingerprint, setupState.target_fingerprint);
    assert.equal(receipt.run_fingerprint, setupState.run_fingerprint);
    assert.equal(receipt.resource_fingerprint, setupState.resource_fingerprint);
    assert.deepEqual(receipt.fixture_sha256, EXPECTED_FIXTURE_SHA256);
    assert.deepEqual(receipt.assertions.map(({ id }) => id), GENERATED_CANARY_ASSERTION_IDS);
    assertNoPrivateMaterial(passedState, [directory, statePath, receiptPath]);
    assertNoPrivateMaterial(receipt, [directory, statePath, receiptPath]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state and receipt outputs are exclusive and never overwrite an existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-generated-exclusive-"));
  const statePath = join(directory, "state.json");
  const verifiedStatePath = join(directory, "verified-state.json");
  const receiptPath = join(directory, "receipt.json");
  const fixture = generatedCanaryFixture();
  try {
    await writeFile(statePath, "keep-state\n", { mode: 0o600, flag: "wx" });
    await assert.rejects(
      run({
        phase: "setup",
        candidate_sha: CANDIDATE_SHA,
        deployment_id: SETUP_DEPLOYMENT,
        state_out: statePath,
        base_url: BASE_URL,
        nonce: NONCE,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    assert.equal(await readFile(statePath, "utf8"), "keep-state\n");
    assert.equal(fixture.model.apiCalls.length, 0, "exclusive state reservation must precede product mutation");

    const receiptFixture = generatedCanaryFixture();
    await run({
      phase: "setup",
      candidate_sha: CANDIDATE_SHA,
      deployment_id: SETUP_DEPLOYMENT,
      state_out: verifiedStatePath,
      base_url: BASE_URL,
      nonce: NONCE,
    }, { environment: credentials(), fetchImpl: receiptFixture.fetchImpl });
    await run({
      phase: "verify",
      deployment_id: VERIFY_DEPLOYMENT,
      state: verifiedStatePath,
      base_url: BASE_URL,
    }, { environment: credentials(), fetchImpl: receiptFixture.fetchImpl });
    await writeFile(receiptPath, "keep-receipt\n", { mode: 0o600, flag: "wx" });
    await assert.rejects(
      run({
        phase: "cleanup",
        state: verifiedStatePath,
        receipt_out: receiptPath,
        base_url: BASE_URL,
      }, { environment: credentials(), fetchImpl: receiptFixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    assert.equal(await readFile(receiptPath, "utf8"), "keep-receipt\n");
    assert.equal(receiptFixture.model.deletes, 0, "receipt reservation must precede cleanup");
    assert.equal(receiptFixture.model.mindExists, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup_complete resumes receipt publication and accepts only a matching private receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-generated-cleanup-resume-"));
  const statePath = join(directory, "state.json");
  const receiptDirectory = join(directory, "receipt-parent");
  const receiptPath = join(receiptDirectory, "receipt.json");
  const fixture = generatedCanaryFixture();
  try {
    await run({
      phase: "setup",
      candidate_sha: CANDIDATE_SHA,
      deployment_id: SETUP_DEPLOYMENT,
      state_out: statePath,
      base_url: BASE_URL,
      nonce: NONCE,
    }, { environment: credentials(), fetchImpl: fixture.fetchImpl });
    await run({
      phase: "verify",
      deployment_id: VERIFY_DEPLOYMENT,
      state: statePath,
      base_url: BASE_URL,
    }, { environment: credentials(), fetchImpl: fixture.fetchImpl });

    await assert.rejects(run({
      phase: "cleanup",
      state: statePath,
      receipt_out: receiptPath,
      base_url: BASE_URL,
    }, {
      environment: credentials(),
      fetchImpl: fixture.fetchImpl,
      now: () => NOW,
    }));
    assert.equal((await readJson(statePath)).status, "cleanup_complete");
    assert.equal(fixture.model.deletes, 1);
    assert.equal(fixture.model.mindExists, false);
    await assertMissing(receiptPath);

    await mkdir(receiptDirectory, { mode: 0o700 });
    const resumed = await run({
      phase: "cleanup",
      state: statePath,
      receipt_out: receiptPath,
      base_url: BASE_URL,
    }, {
      environment: {},
      fetchImpl: fixture.fetchImpl,
      now: () => NOW,
    });
    assert.equal(resumed.status, "passed");
    assert.equal((await readJson(statePath)).status, "passed");
    await assertPrivateFile(receiptPath);
    const receipt = await readJson(receiptPath);
    assert.equal(receipt.observed_at_utc, NOW);
    assertNoPrivateMaterial(receipt, [directory, statePath, receiptPath]);

    const terminal = await readJson(statePath);
    await writeFile(
      statePath,
      `${JSON.stringify({ ...terminal, status: "cleanup_complete" }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const callsBeforeReceiptReplay = fixture.model.apiCalls.length;
    const replayed = await run({
      phase: "cleanup",
      state: statePath,
      receipt_out: receiptPath,
      base_url: BASE_URL,
    }, {
      environment: {},
      fetchImpl: fixture.fetchImpl,
      now: () => "2026-08-24T12:30:00.000Z",
    });
    assert.equal(replayed.status, "passed");
    assert.equal(fixture.model.apiCalls.length, callsBeforeReceiptReplay);
    assert.deepEqual(await readJson(receiptPath), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recover removes only its exact private single-owner canary and emits no receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-generated-recover-"));
  const statePath = join(directory, "state.json");
  const receiptPath = join(directory, "receipt.json");
  const fixture = generatedCanaryFixture({ failCanaryAction: "setup" });
  try {
    await assert.rejects(
      run({
        phase: "setup",
        candidate_sha: CANDIDATE_SHA,
        deployment_id: SETUP_DEPLOYMENT,
        state_out: statePath,
        base_url: BASE_URL,
        nonce: NONCE,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    assert.equal((await readJson(statePath)).status, "canary_target_active");
    fixture.model.failCanaryAction = null;
    const recovered = await run({
      phase: "recover",
      state: statePath,
      base_url: BASE_URL,
    }, { environment: credentials(), fetchImpl: fixture.fetchImpl });
    assert.equal(recovered.status, "recovered");
    assert.equal(fixture.model.deletes, 1);
    assert.equal(fixture.model.mindExists, false);
    assert.equal(fixture.model.currentBinding, null);
    assert.equal((await readJson(statePath)).status, "recovered");
    await assertPrivateFile(statePath);
    await assertMissing(receiptPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup requires an initially empty write binding and recovery never changes an unrelated binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-generated-preexisting-"));
  const statePath = join(directory, "state.json");
  const fixture = generatedCanaryFixture();
  fixture.model.bindingVersion = 7;
  fixture.model.currentBinding = binding({
    id: "write_binding_service_foreign",
    route: "/foreign-mind",
  });
  try {
    await assert.rejects(
      run({
        phase: "setup",
        candidate_sha: CANDIDATE_SHA,
        deployment_id: SETUP_DEPLOYMENT,
        state_out: statePath,
        base_url: BASE_URL,
        nonce: NONCE,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    assert.equal((await readJson(statePath)).status, "setup_started");
    assert.equal(fixture.model.mcpCalls.filter(({ name }) =>
      name === "set_write_mind_binding").length, 0);
    assert.equal(fixture.model.mindExists, false);

    const recovered = await run({
      phase: "recover",
      state: statePath,
      base_url: BASE_URL,
    }, { environment: credentials(), fetchImpl: fixture.fetchImpl });
    assert.equal(recovered.status, "recovered");
    assert.equal(fixture.model.currentBinding.mind.route, "/foreign-mind");
    assert.equal(fixture.model.deletes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("priming checkpoint permits recovery to undo only the runner-created /me binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-generated-priming-"));
  const statePath = join(directory, "state.json");
  const fixture = generatedCanaryFixture({ failCreate: true });
  try {
    await assert.rejects(
      run({
        phase: "setup",
        candidate_sha: CANDIDATE_SHA,
        deployment_id: SETUP_DEPLOYMENT,
        state_out: statePath,
        base_url: BASE_URL,
        nonce: NONCE,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    assert.equal((await readJson(statePath)).status, "priming_started");
    assert.equal(fixture.model.currentBinding.mind.route, "/me");
    fixture.model.failCreate = false;

    const recovered = await run({
      phase: "recover",
      state: statePath,
      base_url: BASE_URL,
    }, { environment: credentials(), fetchImpl: fixture.fetchImpl });
    assert.equal(recovered.status, "recovered");
    assert.equal(fixture.model.currentBinding, null);
    assert.equal(fixture.model.deletes, 0);
    assert.equal((await readJson(statePath)).status, "recovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recover never deletes a preexisting lookalike without a resource fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-generated-lookalike-"));
  const statePath = join(directory, "state.json");
  const fixture = generatedCanaryFixture({ preexistingTarget: true });
  try {
    await assert.rejects(
      run({
        phase: "setup",
        candidate_sha: CANDIDATE_SHA,
        deployment_id: SETUP_DEPLOYMENT,
        state_out: statePath,
        base_url: BASE_URL,
        nonce: NONCE,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure,
    );
    const state = await readJson(statePath);
    assert.equal(state.status, "priming_started");
    assert.equal(state.resource_fingerprint, null);
    await assert.rejects(
      run({
        phase: "recover",
        state: statePath,
        base_url: BASE_URL,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure &&
        error.code === "canary_ownership_unattested",
    );
    assert.equal(fixture.model.deletes, 0);
    assert.equal(fixture.model.mindExists, true);
    assert.equal(fixture.model.currentBinding, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const UNSAFE_SIGNATURES = Object.freeze([
  ["name", (model) => { model.targetName = "Unrelated private Mind"; }],
  ["visibility", (model) => { model.targetVisibility = "public"; }],
  ["owner-role", (model) => { model.targetRole = "admin"; }],
  ["single-owner", (model) => { model.extraMember = true; }],
]);

for (const phase of ["cleanup", "recover"]) {
  for (const [signature, makeUnsafe] of UNSAFE_SIGNATURES) {
    test(`${phase} fails closed on unsafe ${signature} without deleting the target`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `mind-diary-generated-unsafe-${phase}-`));
    const statePath = join(directory, "state.json");
    const receiptPath = join(directory, "receipt.json");
    const fixture = generatedCanaryFixture();
    try {
      await run({
        phase: "setup",
        candidate_sha: CANDIDATE_SHA,
        deployment_id: SETUP_DEPLOYMENT,
        state_out: statePath,
        base_url: BASE_URL,
        nonce: NONCE,
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl });
      if (phase === "cleanup") {
        await run({
          phase: "verify",
          deployment_id: VERIFY_DEPLOYMENT,
          state: statePath,
          base_url: BASE_URL,
        }, { environment: credentials(), fetchImpl: fixture.fetchImpl });
      }
      makeUnsafe(fixture.model);
      await assert.rejects(
        run({
          phase,
          state: statePath,
          ...(phase === "cleanup" ? { receipt_out: receiptPath } : {}),
          base_url: BASE_URL,
        }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
        (error) => error instanceof ProbeFailure,
      );
      assert.equal(fixture.model.deletes, 0);
      assert.equal(fixture.model.mindExists, true);
      await assertMissing(receiptPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    });
  }
}
