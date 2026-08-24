import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPERATOR_CANARY_ASSERTION_IDS,
  ProbeFailure,
  assertRedactedDocument,
  createEvidence,
  loadCredentialEnvironment,
  parseCli,
  run,
} from "../../scripts/run-uat-operator-directory-canary.mjs";

const SHA = "a".repeat(40);
const DEPLOYMENT = "appgdep_operator123";
const NOW = "2026-08-24T10:00:00.000Z";

function actorFingerprints() {
  return {
    operator: `uatop-${"a".repeat(32)}`,
    mind_role: `uatop-${"b".repeat(32)}`,
    ordinary: `uatop-${"c".repeat(32)}`,
  };
}

test("operator canary receipt is deterministic, exact and redacted", () => {
  const input = {
    candidateSha: SHA,
    deploymentId: DEPLOYMENT,
    runFingerprint: `uatop-run-${"d".repeat(32)}`,
    actors: actorFingerprints(),
    observedAtUtc: NOW,
  };
  const first = createEvidence(input);
  assert.deepEqual(first, createEvidence(input));
  assert.equal(first.schema, "mind-diary/uat-operator-directory-canary-evidence/v1");
  assert.equal(first.candidate_sha, SHA);
  assert.equal(first.deployment_id, DEPLOYMENT);
  assert.equal(first.actors.length, 3);
  assert.deepEqual(
    first.assertions.map(({ id }) => id),
    OPERATOR_CANARY_ASSERTION_IDS,
  );
  assert.equal(first.assertions.every(({ status }) => status === "passed"), true);
  assert.match(first.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(first).includes("@"), false);
});

test("operator canary redaction rejects credentials, email and service identifiers", () => {
  for (const value of [
    { value: "mdp_v1_secret" },
    { value: "someone@example.test" },
    { value: "principal_private" },
    { authorization: "Bearer private" },
  ]) {
    assert.throws(
      () => assertRedactedDocument(value),
      (error) => error instanceof ProbeFailure && error.code === "unsafe_evidence_document",
    );
  }
});

function credentials() {
  return {
    MIND_DIARY_UAT_OPERATOR_SITES_TOKEN: "sites-operator",
    MIND_DIARY_UAT_OPERATOR_MCP_TOKEN: "mdp_v1_operator",
    MIND_DIARY_UAT_MIND_ROLE_SITES_TOKEN: "sites-mind-role",
    MIND_DIARY_UAT_MIND_ROLE_MCP_TOKEN: "mdp_v1_mind-role",
    MIND_DIARY_UAT_ORDINARY_SITES_TOKEN: "sites-ordinary",
    MIND_DIARY_UAT_ORDINARY_MCP_TOKEN: "mdp_v1_ordinary",
  };
}

test("environment contract requires six distinct non-CLI credential refs", () => {
  assert.equal(loadCredentialEnvironment(credentials()).operator.sitesToken, "sites-operator");
  assert.throws(
    () => loadCredentialEnvironment({
      ...credentials(),
      MIND_DIARY_UAT_ORDINARY_SITES_TOKEN: "sites-operator",
    }),
    (error) => error instanceof ProbeFailure && error.code === "shared_sites_credential_forbidden",
  );
  assert.throws(
    () => loadCredentialEnvironment({
      ...credentials(),
      MIND_DIARY_UAT_MIND_ROLE_MCP_TOKEN: "mdp_v1_operator",
    }),
    (error) => error instanceof ProbeFailure && error.code === "shared_mcp_credential_forbidden",
  );
  assert.deepEqual(parseCli([
    "--phase", "verify",
    "--deployment-id", DEPLOYMENT,
    "--state", "/private/state.json",
    "--evidence-out", "/private/evidence.json",
  ]), {
    phase: "verify",
    deployment_id: DEPLOYMENT,
    state: "/private/state.json",
    evidence_out: "/private/evidence.json",
  });
  assert.throws(
    () => parseCli(["--phase", "setup", "--operator-sites-token", "secret"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
});

function operatorFixture({ mindRole = true } = {}) {
  const principals = {
    operator: "principal-fixture-operator",
    mind_role: "principal-fixture-mind-role",
    ordinary: "principal-fixture-ordinary",
  };
  const sites = {
    "Bearer sites-operator": "operator",
    "Bearer sites-mind-role": "mind_role",
    "Bearer sites-ordinary": "ordinary",
  };
  const mcp = {
    operator: "Bearer mdp_v1_operator",
    mind_role: "Bearer mdp_v1_mind-role",
    ordinary: "Bearer mdp_v1_ordinary",
  };
  const activities = new Map();
  let tick = 0;
  const timestamp = () => `2026-08-24T10:00:${String(++tick).padStart(2, "0")}.000Z`;
  const record = (actor, surface) => {
    const previous = activities.get(actor) ?? {};
    const observed = timestamp();
    activities.set(actor, {
      ...previous,
      ...(surface === "web" ? { lastWebSeenAt: observed } : { lastMcpSeenAt: observed }),
      lastActivityAt: observed,
      lastActivitySurface: surface,
      lastActivityKind: surface === "web" ? "control_read" : "discovery",
    });
  };
  const json = (status, value) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  const actorFor = (headers) => sites[new Headers(headers).get("OAI-Sites-Authorization")];
  const queries = [];
  const wireActivity = (actor) => {
    const activity = activities.get(actor);
    return activity === undefined ? null : {
      last_web_seen_at: activity.lastWebSeenAt ?? null,
      last_mcp_seen_at: activity.lastMcpSeenAt ?? null,
      last_activity_at: activity.lastActivityAt,
      last_activity_surface: activity.lastActivitySurface,
      last_activity_kind: activity.lastActivityKind,
    };
  };
  const rows = () => [...["operator", "mind_role", "ordinary"].map((actor, index) => ({
    principal_id: principals[actor],
    display_name: `Fixture ${index}`,
    verified_email: `fixture-${index}@example.test`,
    state: "active",
    registered_at: `2026-08-20T00:00:0${index}.000Z`,
    activity: wireActivity(actor),
    owned_mind_count: actor === "mind_role" && mindRole ? 1 : 0,
    participating_mind_count: 0,
    active_mcp_credential_count: 1,
  })), {
    principal_id: "fixture-never-active",
    display_name: "Fixture Never",
    verified_email: "fixture-never@example.test",
    state: "active",
    registered_at: "2026-08-20T00:00:03.000Z",
    activity: null,
    owned_mind_count: 0,
    participating_mind_count: 0,
    active_mcp_credential_count: 0,
  }];
  const normalized = (value) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const compare = (left, right, sort, direction) => {
    let compared;
    if (sort === "registered_at") compared = left.registered_at.localeCompare(right.registered_at);
    else if (sort === "last_activity_at") {
      compared = (left.activity?.last_activity_at ?? "").localeCompare(
        right.activity?.last_activity_at ?? "",
      );
    } else compared = normalized(left.display_name).localeCompare(normalized(right.display_name), "en-US");
    if (compared === 0) compared = left.principal_id < right.principal_id ? -1 : left.principal_id > right.principal_id ? 1 : 0;
    return direction === "asc" ? compared : -compared;
  };
  const page = (url) => {
    const query = Object.fromEntries(url.searchParams);
    queries.push(query);
    let selected = rows();
    if (query.query !== undefined) {
      const needle = normalized(query.query);
      selected = selected.filter((row) =>
        normalized(row.display_name) === needle || normalized(row.verified_email) === needle);
    }
    if (query.never_active === "true") selected = selected.filter((row) => row.activity === null);
    if (query.registered_from !== undefined) {
      selected = selected.filter((row) => row.registered_at >= query.registered_from);
    }
    if (query.registered_to !== undefined) {
      selected = selected.filter((row) => row.registered_at <= query.registered_to);
    }
    if (query.activity_from !== undefined) {
      selected = selected.filter((row) =>
        row.activity !== null && row.activity.last_activity_at >= query.activity_from);
    }
    if (query.activity_to !== undefined) {
      selected = selected.filter((row) =>
        row.activity !== null && row.activity.last_activity_at <= query.activity_to);
    }
    const sort = query.sort ?? "registered_at";
    const direction = query.direction ?? "desc";
    selected.sort((left, right) => compare(left, right, sort, direction));
    const offset = query.cursor === undefined
      ? 0
      : Number(/^fixture\.(\d+)$/u.exec(query.cursor)?.[1] ?? Number.NaN);
    const limit = Number(query.limit ?? 50);
    const principals = selected.slice(offset, offset + limit);
    const next = offset + limit < selected.length ? `fixture.${offset + limit}` : null;
    return { principals, next_cursor: next };
  };
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    const actor = actorFor(options.headers);
    if (!actor) return json(401, { error: { code: "authentication_required" } });
    if (url.pathname === "/api/v1/session") {
      record(actor, "web");
      return json(200, { data: {
        principal: { principal_id: principals[actor] },
        personal_mind: { mind_id: `personal-fixture-${actor}` },
      } });
    }
    if (url.pathname === "/api/v1/minds") {
      record(actor, "web");
      const data = [{
        mind_id: `personal-fixture-${actor}`,
        route: "/me",
        is_personal: true,
        access: { kind: "membership", role: "owner" },
      }];
      if (actor === "mind_role" && mindRole) data.push({
        mind_id: "mind-fixture-shared",
        route: "/fixture-shared",
        is_personal: false,
        access: { kind: "membership", role: "admin" },
      });
      return json(200, { data });
    }
    if (url.pathname === "/api/mcp") {
      if (new Headers(options.headers).get("authorization") !== mcp[actor]) {
        return json(401, { error: { code: "authentication_required" } });
      }
      record(actor, "mcp");
      return json(200, { result: {
        isError: false,
        structuredContent: { data: { minds: [] } },
      } });
    }
    if (url.pathname === "/api/v1/internal/operators/users") {
      if (actor !== "operator") return json(404, { error: { code: "not_found" } });
      const response = json(200, { data: page(url) });
      record(actor, "web");
      return response;
    }
    if (url.pathname === "/internal/operators/users") {
      if (actor !== "operator") return json(404, { error: { code: "not_found" } });
      const empty = url.searchParams.get("neverActive") === "true" &&
        rows().every((row) => row.activity !== null);
      const response = new Response(
        `<!doctype html><h1>UAT users</h1>${empty ? "No accounts match this bounded view." : "Never"}`,
        {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
      record(actor, "web");
      return response;
    }
    return json(404, { error: { code: "not_found" } });
  };
  return { fetchImpl, activities, queries };
}

test("setup, verify and cleanup exercise the three-actor hosted contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-operator-canary-"));
  const statePath = join(directory, "state.json");
  const evidencePath = join(directory, "evidence.json");
  const fixture = operatorFixture();
  try {
    const prepared = await run({
      phase: "setup",
      candidate_sha: SHA,
      deployment_id: DEPLOYMENT,
      state_out: statePath,
      nonce: "abcdef0123456789",
    }, { environment: credentials(), fetchImpl: fixture.fetchImpl });
    assert.equal(prepared.status, "ready_for_verify");

    const verified = await run({
      phase: "verify",
      deployment_id: DEPLOYMENT,
      state: statePath,
      evidence_out: evidencePath,
    }, {
      environment: credentials(),
      fetchImpl: fixture.fetchImpl,
      now: () => NOW,
    });
    assert.equal(verified.status, "passed");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.candidate_sha, SHA);
    assert.equal(evidence.deployment_id, DEPLOYMENT);
    assert.equal(evidence.assertions.length, OPERATOR_CANARY_ASSERTION_IDS.length);
    assert.equal(JSON.stringify(evidence).includes("principal-fixture"), false);
    assert.equal(JSON.stringify(evidence).includes("example.test"), false);
    assert.equal(fixture.queries.some(({ cursor }) => cursor === "fixture.1"), true);
    assert.equal(fixture.queries.some(({ query }) => query === "Fixture 2"), true);
    assert.equal(fixture.queries.some(({ query }) => query?.startsWith("__uat_operator_canary_no_match_")), true);
    assert.equal(fixture.queries.some(({ registered_from, registered_to }) =>
      registered_from !== undefined && registered_from === registered_to), true);
    assert.equal(fixture.queries.some(({ activity_from, activity_to }) =>
      activity_from !== undefined && activity_from === activity_to), true);
    assert.equal(fixture.queries.some(({ never_active }) => never_active === "true"), true);
    for (const sort of ["registered_at", "last_activity_at", "display_name"]) {
      for (const direction of ["asc", "desc"]) {
        assert.equal(fixture.queries.some((query) =>
          query.sort === sort && query.direction === direction), true, `${sort}:${direction}`);
      }
    }

    const cleaned = await run({ phase: "cleanup", state: statePath });
    assert.equal(cleaned.status, "cleaned");
    assert.equal(fixture.activities.size, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed setup leaves redacted state that recovery can close without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-operator-recovery-"));
  const statePath = join(directory, "state.json");
  try {
    const fixture = operatorFixture({ mindRole: false });
    await assert.rejects(
      run({
        phase: "setup",
        candidate_sha: SHA,
        deployment_id: DEPLOYMENT,
        state_out: statePath,
        nonce: "abcdef0123456789",
      }, { environment: credentials(), fetchImpl: fixture.fetchImpl }),
      (error) => error instanceof ProbeFailure && error.code === "mind_role_membership_missing",
    );
    const initial = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(initial.status, "setup_started");
    assert.equal(JSON.stringify(initial).includes("principal-fixture"), false);
    const recovered = await run({ phase: "recovery", state: statePath }, {
      environment: {},
      fetchImpl: undefined,
    });
    assert.equal(recovered.status, "recovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
