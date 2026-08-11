import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProbeFailure,
  assertRedactedDocument,
  createEvidence,
  loadCredentialEnvironment,
  parseCli,
  run,
} from "../../scripts/run-uat-multi-principal-probe.mjs";

const SHA = "a".repeat(40);
const PREPARED = "appgdep_prepared123";
const VERIFIED = "appgdep_verified456";

test("multi-principal receipt is deterministic, complete, and redacted", () => {
  const input = {
    candidateSha: SHA,
    deploymentId: VERIFIED,
    preparedDeploymentId: PREPARED,
    ownerFingerprint: `pilot-${"a".repeat(16)}`,
    participantFingerprint: `pilot-${"b".repeat(16)}`,
    observedAtUtc: "2026-08-11T00:00:00.000Z",
  };
  const first = createEvidence(input);
  assert.deepEqual(first, createEvidence(input));
  assert.equal(first.schema, "mind-diary/multi-principal-evidence/v1");
  assert.equal(first.status, "passed");
  assert.match(first.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.assertions.length, 13);
  assert.equal(first.assertions.every(({ status }) => status === "passed"), true);
  assert.equal(JSON.stringify(first).includes("@"), false);
});

test("redaction guard rejects credentials, PII, and durable service identifiers", () => {
  for (const value of [
    { secret: "mdp_v1_not-a-real-token" },
    { email: "pilot@example.test" },
    { principal: "principal_private" },
    { authorization: "Bearer value" },
  ]) {
    assert.throws(
      () => assertRedactedDocument(value),
      (error) => error instanceof ProbeFailure && error.code === "unsafe_evidence_document",
    );
  }
});

test("credential references require distinct Sites and MCP credentials", () => {
  const environment = {
    MIND_DIARY_UAT_OWNER_SITES_TOKEN: "owner-sites",
    MIND_DIARY_UAT_PARTICIPANT_SITES_TOKEN: "participant-sites",
    MIND_DIARY_UAT_PARTICIPANT_EMAIL: "authorized@example.test",
    MIND_DIARY_UAT_OWNER_MCP_TOKEN: "mdp_v1_owner-reference",
    MIND_DIARY_UAT_PARTICIPANT_MCP_TOKEN: "mdp_v1_participant-reference",
    MIND_DIARY_UAT_OWNER_MCP_TOKEN_ID: "opaque-owner-token",
    MIND_DIARY_UAT_PARTICIPANT_MCP_TOKEN_ID: "opaque-participant-token",
  };
  assert.equal(loadCredentialEnvironment(environment).ownerSitesToken, "owner-sites");
  assert.throws(
    () => loadCredentialEnvironment({ ...environment, MIND_DIARY_UAT_PARTICIPANT_SITES_TOKEN: "owner-sites" }),
    (error) => error instanceof ProbeFailure && error.code === "shared_sites_credential_forbidden",
  );
  assert.throws(
    () => loadCredentialEnvironment({ ...environment, MIND_DIARY_UAT_PARTICIPANT_MCP_TOKEN: "mdp_v1_owner-reference" }),
    (error) => error instanceof ProbeFailure && error.code === "shared_mcp_credential_forbidden",
  );
});

test("CLI accepts only non-secret orchestration arguments", () => {
  assert.deepEqual(parseCli(["--phase", "cleanup", "--state", "/tmp/state.json"]), {
    phase: "cleanup",
    state: "/tmp/state.json",
  });
  assert.throws(
    () => parseCli(["--phase", "setup", "--owner-sites-token", "secret"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
});

function probeFixture() {
  const state = {
    registered: new Set(),
    roles: new Map(),
    tokenState: new Map([["owner", "active"], ["participant", "active"]]),
    mindExists: false,
    visibility: "private",
    metadataVersion: 1,
    invitation: null,
    handle: null,
    name: null,
  };
  const json = (status, value) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  const actorFor = (headers) => {
    const token = new Headers(headers).get("OAI-Sites-Authorization");
    if (token === "Bearer owner-sites") return "owner";
    if (token === "Bearer participant-sites") return "participant";
    return null;
  };
  const member = (actor, viewer) => ({
    member_id: `member-${actor}`,
    display_name: actor,
    membership_version: 1,
    role: state.roles.get(actor),
    is_self: actor === viewer,
  });
  const canRead = (actor) => state.mindExists && (
    state.roles.has(actor) || state.visibility === "public" || state.visibility === "unlisted"
  );
  const mind = (actor) => ({
    mind_id: "mind-shared",
    name: state.name,
    route: `/${state.handle}`,
    visibility: state.visibility,
    metadata_version: state.metadataVersion,
    access: state.roles.has(actor)
      ? { kind: "membership", role: state.roles.get(actor) }
      : { kind: "visibility", role: null },
  });
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    const actor = actorFor(options.headers);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (!actor) return json(401, { error: { code: "authentication_required" } });

    if (url.pathname === "/api/mcp") {
      const supplied = new Headers(options.headers).get("authorization");
      const expected = actor === "owner" ? "Bearer mdp_v1_owner-reference" : "Bearer mdp_v1_participant-reference";
      if (supplied !== expected || state.tokenState.get(actor) !== "active") {
        return json(401, { code: "authentication_required" });
      }
      if (body.params.name === "list_minds") {
        const minds = [{ mind_id: `mind-personal-${actor}`, route: "/me" }];
        if (canRead(actor)) minds.push({ mind_id: "mind-shared", route: `/${state.handle}` });
        return json(200, { result: { isError: false, structuredContent: { data: { minds } } } });
      }
      return json(200, { result: { isError: !canRead(actor), structuredContent: { data: {} } } });
    }

    if (url.pathname === "/api/v1/session") {
      if (!state.registered.has(actor)) return json(409, { error: { code: "registration_required" } });
      return json(200, { data: {
        principal: { principal_id: `principal-${actor}` },
        personal_mind: { mind_id: `mind-personal-${actor}`, route: "/me" },
      } });
    }
    if (url.pathname === "/api/v1/account" && method === "POST") {
      state.registered.add(actor);
      return json(200, { data: { replayed: false } });
    }
    if (url.pathname === "/api/v1/minds" && method === "POST") {
      state.mindExists = true;
      state.handle = body.handle;
      state.name = body.name;
      state.roles.set(actor, "owner");
      return json(200, { data: mind(actor) });
    }
    if (url.pathname === "/api/v1/invitations" && method === "GET") {
      return json(200, { data: { invitations: actor === "participant" && state.invitation ? [state.invitation] : [] } });
    }
    if (segments[2] === "invitations" && segments[4] === "accept" && method === "POST") {
      state.roles.set(actor, "reader");
      return json(200, { data: { replayed: false } });
    }
    if (url.pathname === "/api/v1/mcp-tokens" && method === "GET") {
      return json(200, { data: { tokens: [{ token_id: `opaque-${actor}-token`, state: state.tokenState.get(actor) }] } });
    }
    if (segments[2] === "mcp-tokens" && segments.length === 4 && method === "DELETE") {
      state.tokenState.set(actor, "revoked");
      return json(200, { data: { token: { state: "revoked" } } });
    }

    if (segments[2] === "minds" && segments[3] === state.handle) {
      if (segments.length === 4 && method === "GET") {
        return canRead(actor) ? json(200, { data: mind(actor) }) : json(404, { error: { code: "mind_not_found" } });
      }
      if (segments.length === 4 && method === "DELETE") {
        state.mindExists = false;
        state.roles.clear();
        return json(200, { data: { replayed: false } });
      }
      if (segments[4] === "visibility" && method === "PUT") {
        state.visibility = body.visibility;
        state.metadataVersion += 1;
        return json(200, { data: mind(actor) });
      }
      if (segments[4] === "deletion-impact" && method === "GET") {
        return json(200, { data: { impact_id: "impact-fixture", confirmation: `delete-mind:${state.handle}` } });
      }
      if (segments[4] === "members" && segments.length === 5 && method === "GET") {
        return json(200, { data: { members: [...state.roles.keys()].map((item) => member(item, actor)) } });
      }
      if (segments[4] === "members" && segments.length === 6 && method === "PATCH") {
        const target = segments[5].replace("member-", "");
        state.roles.set(target, body.role);
        return json(200, { data: member(target, actor) });
      }
      if (segments[4] === "members" && segments.length === 6 && method === "DELETE") {
        state.roles.delete(segments[5].replace("member-", ""));
        return json(200, { data: { revoked: true } });
      }
      if (segments[4] === "invitations" && method === "POST") {
        state.invitation = {
          invitation_id: "invitation-fixture",
          invitation_version: 1,
          direction: "incoming",
          mind_route: `/${state.handle}`,
        };
        return json(200, { data: { replayed: false } });
      }
      if (segments[4] === "ownership-transfer" && method === "POST") {
        state.roles.set("owner", "admin");
        state.roles.set("participant", "owner");
        return json(200, { data: { source_role: "admin", target_role: "owner" } });
      }
    }

    const csrfHtml = '<meta name="mind-diary-csrf-token" content="fixture-csrf">';
    if (url.pathname === "/public") {
      return new Response(`${csrfHtml}${state.mindExists && state.visibility === "public" ? state.handle : ""}`, { status: 200 });
    }
    return new Response(csrfHtml, { status: 200 });
  };
  return { fetchImpl, state };
}

test("two-phase probe exercises redeploy persistence, immediate revoke, and cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-probe-test-"));
  const statePath = join(directory, "state.json");
  const evidencePath = join(directory, "evidence.json");
  const environment = {
    MIND_DIARY_UAT_OWNER_SITES_TOKEN: "owner-sites",
    MIND_DIARY_UAT_PARTICIPANT_SITES_TOKEN: "participant-sites",
    MIND_DIARY_UAT_PARTICIPANT_EMAIL: "authorized@example.test",
    MIND_DIARY_UAT_OWNER_MCP_TOKEN: "mdp_v1_owner-reference",
    MIND_DIARY_UAT_PARTICIPANT_MCP_TOKEN: "mdp_v1_participant-reference",
    MIND_DIARY_UAT_OWNER_MCP_TOKEN_ID: "opaque-owner-token",
    MIND_DIARY_UAT_PARTICIPANT_MCP_TOKEN_ID: "opaque-participant-token",
  };
  const fixture = probeFixture();
  try {
    const prepared = await run({
      phase: "setup",
      candidate_sha: SHA,
      deployment_id: PREPARED,
      owner_fingerprint: `pilot-${"a".repeat(16)}`,
      participant_fingerprint: `pilot-${"b".repeat(16)}`,
      state_out: statePath,
      nonce: "abcdef0123456789",
    }, { environment, fetchImpl: fixture.fetchImpl });
    assert.equal(prepared.status, "awaiting_redeploy");
    assert.equal(fixture.state.roles.get("owner"), "admin");
    assert.equal(fixture.state.roles.get("participant"), "owner");

    const verified = await run({
      phase: "verify",
      deployment_id: VERIFIED,
      state: statePath,
      evidence_out: evidencePath,
    }, { environment, fetchImpl: fixture.fetchImpl });
    assert.equal(verified.status, "passed");
    assert.equal(fixture.state.mindExists, false);
    assert.deepEqual([...fixture.state.tokenState.values()], ["revoked", "revoked"]);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.deployment_id, VERIFIED);
    assert.equal(evidence.assertions.length, 13);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
