#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createSitesMetadataStore } from "../packages/adapter-metadata-sites/dist/index.js";
import { createProductSiteRuntime } from "../packages/composition-root/dist/index.js";
import {
  MultiPrincipalActorClient,
  ProbeFailure,
  SYNTHETIC_ASSERTION_IDS,
  assertRedactedDocument,
  candidateSha,
  canonical,
  data,
  digest,
  fail,
  isRecord,
  mcpResultData,
  required,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import {
  FakeD1Database,
  FakeR2Bucket,
  deterministicKey,
} from "./lib/fake-sites-storage.mjs";
import {
  matchesExactDefaultMcpToolInventory,
  matchesExactVerifiedNativeMcpToolInventory,
} from "./lib/exact-mcp-tool-inventory.mjs";
import { assertNoSyntheticProductAuthority } from "./lib/synthetic-product-negative.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const ORIGIN = "https://synthetic-gate.invalid";
const EVIDENCE_SCHEMA = "mind-diary/synthetic-multi-principal-evidence/v1";
const BINDING_NAMESPACE = "synthetic-test";
const ACTOR_CLASS = "synthetic-principal";
const MODERN_PROTOCOL = "2026-07-28";
const COMPAT_PROTOCOL = "2025-11-25";

function opaque(prefix, bytes = randomBytes) {
  return `${prefix}-${bytes(16).toString("hex")}`;
}

function ids(session) {
  return Object.freeze({
    principal: required(session.principal?.principal_id, "missing_principal_id"),
    mind: required(session.personal_mind?.mind_id, "missing_personal_mind_id"),
  });
}

function mcpMinds(response, actorClass) {
  const minds = response.body?.result?.structuredContent?.data?.minds;
  if (
    response.status !== 200 ||
    response.body?.result?.isError === true ||
    !Array.isArray(minds)
  ) {
    fail("mcp_list_failed", { actorClass, status: response.status });
  }
  return minds;
}

function expectMcpError(response, code) {
  const expectedCodes = Array.isArray(code) ? code : [code];
  const actualCode = response.body?.result?.structuredContent?.error?.code;
  if (
    response.status !== 200 ||
    response.body?.result?.isError !== true ||
    !expectedCodes.includes(actualCode)
  ) {
    fail("expected_mcp_error_missing", {
      status: response.status,
      expectedCode: expectedCodes.join("|"),
      actualCode: safeCode(actualCode),
    });
  }
}

async function setMindUsage(actor, mindRef, usageMode, expectedUsageVersion, idempotencyKey, expectedStatus = 200) {
  const pathRef = mindRef === "/me" ? "me" : mindRef.replace(/^\//u, "");
  if (expectedStatus === null) {
    return actor.request(
      `/api/v1/minds/${encodeURIComponent(pathRef)}/usage`,
      {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          origin: actor.origin,
          "x-csrf-token": await actor.csrf("/minds"),
        },
        body: JSON.stringify({
          usage_mode: usageMode,
          expected_usage_version: expectedUsageVersion,
        }),
      },
    );
  }
  return actor.api(
    `/api/v1/minds/${encodeURIComponent(pathRef)}/usage`,
    {
      method: "PUT",
      body: {
        usage_mode: usageMode,
        expected_usage_version: expectedUsageVersion,
      },
      idempotencyKey,
      csrfPath: "/minds",
      expectedStatus,
    },
  );
}

async function readMindUsage(actor) {
  return data(await actor.api("/api/v1/mind-usage"));
}

async function assertExactMcpCatalogs(actor) {
  const modern = await actor.request("/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${actor.mcpToken}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": "tools/list",
      "mcp-protocol-version": MODERN_PROTOCOL,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${actor.actorClass}-tools-list`,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "synthetic-multi-principal-probe",
            version: "1",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  if (
    modern.status !== 200 ||
    !matchesExactVerifiedNativeMcpToolInventory(modern.body?.result?.tools)
  ) {
    fail("mcp_modern_catalog_mismatch", { status: modern.status });
  }

  const initialized = await actor.request("/api/mcp/2025-11-25", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${actor.mcpToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${actor.actorClass}-compat-initialize`,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "synthetic-multi-principal-probe", version: "1" },
      },
    }),
  });
  if (
    initialized.status !== 200 ||
    initialized.body?.result?.protocolVersion !== COMPAT_PROTOCOL
  ) fail("mcp_compat_initialize_failed", { status: initialized.status });

  const notified = await actor.request("/api/mcp/2025-11-25", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${actor.mcpToken}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-protocol-version": COMPAT_PROTOCOL,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (notified.status !== 202) fail("mcp_compat_initialized_failed", { status: notified.status });

  const compat = await actor.request("/api/mcp/2025-11-25", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${actor.mcpToken}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-protocol-version": COMPAT_PROTOCOL,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${actor.actorClass}-compat-tools-list`,
      method: "tools/list",
      params: {},
    }),
  });
  if (compat.status !== 200 || !matchesExactDefaultMcpToolInventory(compat.body?.result?.tools)) {
    fail("mcp_compat_catalog_mismatch", { status: compat.status });
  }
}

function createEvidence({ candidate, startedAt, completedAt, runFingerprint, actorFingerprints, passed }) {
  if (
    passed.size !== SYNTHETIC_ASSERTION_IDS.length ||
    SYNTHETIC_ASSERTION_IDS.some((id) => !passed.has(id))
  ) {
    fail("incomplete_assertion_registry");
  }
  if (
    !/^run-[0-9a-f]{32}$/u.test(runFingerprint) ||
    actorFingerprints.length < 2 ||
    new Set(actorFingerprints).size !== actorFingerprints.length ||
    actorFingerprints.some((value) => !/^actor-[0-9a-f]{32}$/u.test(value))
  ) {
    fail("invalid_evidence_fingerprint");
  }
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: candidateSha(candidate),
    actor_class: ACTOR_CLASS,
    binding_namespace: BINDING_NAMESPACE,
    run_fingerprint: runFingerprint,
    actor_fingerprints: Object.freeze([...actorFingerprints]),
    started_at: required(startedAt, "missing_started_at"),
    completed_at: required(completedAt, "missing_completed_at"),
    assertions: Object.freeze(SYNTHETIC_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

function passedTracker() {
  const values = new Set();
  return Object.freeze({
    add(id) {
      if (!SYNTHETIC_ASSERTION_IDS.includes(id)) fail("unknown_assertion_id");
      values.add(id);
    },
    values,
  });
}

function createHarness({ database, bucket, identities, scheduled }) {
  const options = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity(request) {
        return identities.get(request) ?? { kind: "unauthenticated" };
      },
    },
    identityBindingProvider: BINDING_NAMESPACE,
    tokenVerifierKey: deterministicKey(11),
    locatorKey: deterministicKey(51),
    exportDownloadVerifierKey: deterministicKey(91),
    csrfKey: deterministicKey(131),
    observabilityWriter: { write() {} },
    schedule(work) { scheduled.push(work); },
  };
  return Object.freeze({
    options,
    createRuntime: () => createProductSiteRuntime(options),
  });
}

function backgroundPayload(work) {
  if (work.kind === "audit_outbox") {
    return Object.freeze({ kind: work.kind, messageId: work.id });
  }
  return Object.freeze({ kind: work.kind, jobId: work.id });
}

function searchProjectionCount(database) {
  return database.search.size +
    database.searchDocuments.size +
    database.searchMemberships.size +
    database.searchLexical.size;
}

async function drainScheduled({ runtimeRef, scheduled, kinds }) {
  const allowed = kinds === undefined ? null : new Set(kinds);
  let drained = 0;
  while (true) {
    const index = scheduled.findIndex((work) => allowed === null || allowed.has(work.kind));
    if (index < 0) break;
    const [work] = scheduled.splice(index, 1);
    const result = await runtimeRef.current.dispatchBackground(backgroundPayload(work));
    if (result?.kind === "failed") {
      fail("background_work_failed", { kind: safeCode(work.kind) });
    }
    drained += 1;
    if (drained > 10_000) fail("background_work_did_not_quiesce");
  }
  return drained;
}

function createActors({ runtimeRef, identities, ownerAlias, participantAlias }) {
  const dispatch = async (request, identitySnapshot) => {
    identities.set(request, identitySnapshot);
    return runtimeRef.current.fetch(request);
  };
  return Object.freeze({
    owner: new MultiPrincipalActorClient({
      origin: ORIGIN,
      actorClass: "synthetic-owner",
      identitySnapshot: {
        kind: "authenticated",
        verifiedEmail: ownerAlias,
        verifiedFullName: "Synthetic Owner",
      },
      dispatch,
    }),
    participant: new MultiPrincipalActorClient({
      origin: ORIGIN,
      actorClass: "synthetic-participant",
      identitySnapshot: {
        kind: "authenticated",
        verifiedEmail: participantAlias,
        verifiedFullName: "Synthetic Participant",
      },
      dispatch,
    }),
  });
}

async function visibility(actor, handle, nonce, value, version) {
  return data(await actor.api(`/api/v1/minds/${handle}/visibility`, {
    method: "PUT",
    body: {
      visibility: value,
      acknowledge_live_head_and_history_exposure: value !== "private",
      expected_metadata_version: version,
    },
    idempotencyKey: `synthetic:${nonce}:visibility:${value}`,
    csrfPath: `/${handle}`,
  }));
}

async function deleteMind(actor, handle, nonce) {
  const impact = data(await actor.api(`/api/v1/minds/${handle}/deletion-impact`));
  await actor.api(`/api/v1/minds/${handle}`, {
    method: "DELETE",
    body: { impact_id: impact.impact_id, confirmation: impact.confirmation },
    idempotencyKey: `synthetic:${nonce}:mind:delete`,
    csrfPath: `/${handle}`,
  });
}

async function revokeToken(actor, nonce, suffix) {
  const response = data(await actor.api(
    `/api/v1/mcp-tokens/${encodeURIComponent(actor.mcpTokenRef)}`,
    {
      method: "DELETE",
      idempotencyKey: `synthetic:${nonce}:token:revoke:${suffix}`,
      csrfPath: "/settings/developer/mcp",
    },
  ));
  if (response.token?.state !== "revoked") fail("token_revoke_failed");
}

async function deleteAccount(actor, nonce, suffix) {
  const impact = data(await actor.api("/api/v1/account/deletion-impact"));
  await actor.api("/api/v1/account", {
    method: "DELETE",
    body: { impact_id: impact.impact_id, confirmation: impact.confirmation },
    idempotencyKey: `synthetic:${nonce}:account:delete:${suffix}`,
    csrfPath: "/settings/account",
  });
  const after = await actor.request("/api/v1/session", {
    headers: { accept: "application/json" },
  });
  if (after.status !== 409 || after.body?.error?.code !== "registration_required") {
    fail("account_cleanup_failed", { actorClass: actor.actorClass, status: after.status });
  }
}

async function runScenario({ candidate, evidenceOut, randomBytesImpl, now }) {
  const startedAt = now().toISOString();
  const nonce = randomBytesImpl(8).toString("hex");
  const ownerAlias = `owner-${nonce}@synthetic.invalid`;
  const participantAlias = `participant-${nonce}@synthetic.invalid`;
  const handle = `synthetic-boundary-${nonce}`;
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const identities = new WeakMap();
  const scheduled = [];
  const harness = createHarness({ database, bucket, identities, scheduled });
  const runtimeRef = { current: await harness.createRuntime() };
  const actors = createActors({ runtimeRef, identities, ownerAlias, participantAlias });
  const assertions = passedTracker();
  assertions.add("activation.test-only-composition");

  const ownerSession = await actors.owner.session(`synthetic:${nonce}:bootstrap:owner`);
  const participantSession = await actors.participant.session(`synthetic:${nonce}:bootstrap:participant`);
  const ownerIds = ids(ownerSession);
  const participantIds = ids(participantSession);
  if (ownerIds.principal === participantIds.principal) fail("accounts_not_isolated");
  if (ownerIds.mind === participantIds.mind) fail("personal_minds_not_isolated");
  assertions.add("bootstrap.distinct-ordinary-principals");
  assertions.add("bootstrap.distinct-personal-minds");
  if (
    ids(await actors.owner.session()).principal !== ownerIds.principal ||
    ids(await actors.participant.session()).principal !== participantIds.principal
  ) fail("bootstrap_replay_changed_identity");
  assertions.add("bootstrap.idempotent-replay");
  const bootstrapInspection = await createSitesMetadataStore(database);
  const ownerSyntheticBinding = await bootstrapInspection.readAccountByExternalBinding({
    provider: BINDING_NAMESPACE,
    normalizedBinding: ownerAlias,
  });
  const participantSyntheticBinding = await bootstrapInspection.readAccountByExternalBinding({
    provider: BINDING_NAMESPACE,
    normalizedBinding: participantAlias,
  });
  const ownerSitesBinding = await bootstrapInspection.readAccountByExternalBinding({
    provider: "openai-sites",
    normalizedBinding: ownerAlias,
  });
  const participantSitesBinding = await bootstrapInspection.readAccountByExternalBinding({
    provider: "openai-sites",
    normalizedBinding: participantAlias,
  });
  if (
    ownerSyntheticBinding?.principal.principalId !== ownerIds.principal ||
    participantSyntheticBinding?.principal.principalId !== participantIds.principal ||
    ownerSitesBinding !== null ||
    participantSitesBinding !== null
  ) fail("synthetic_binding_namespace_not_persisted");
  assertions.add("bootstrap.synthetic-binding-namespace");

  await actors.owner.issueMcpToken({
    name: "Synthetic owner gate",
    idempotencyKey: `synthetic:${nonce}:token:owner`,
  });
  await actors.participant.issueMcpToken({
    name: "Synthetic participant gate",
    idempotencyKey: `synthetic:${nonce}:token:participant`,
  });
  if (
    actors.owner.mcpToken === actors.participant.mcpToken ||
    actors.owner.mcpTokenRef === actors.participant.mcpTokenRef
  ) fail("shared_mcp_credential_forbidden");
  await assertExactMcpCatalogs(actors.participant);
  assertions.add("catalogs.modern-compat-exact-17");
  const initialUsageInspection = await createSitesMetadataStore(database);
  const initialUsage = await initialUsageInspection.readPrincipalMindUsage(
    participantIds.principal,
  );
  if (initialUsage !== null && (
    initialUsage.usageVersion !== 0 ||
    initialUsage.entries.length !== 0
  )) fail("initial_binding_state_not_empty");
  assertions.add("bindings.initial-empty");

  if (
    participantSession.personal_mind.description !== null ||
    ownerSession.personal_mind.description !== null
  ) fail("personal_description_default_invalid");
  const removedPersonalDescription = await actors.participant.api(
    "/api/v1/minds/me/description",
    {
      method: "PATCH",
      body: {
        description: "Must not restore the retired Personal description route.",
        expected_metadata_version: participantSession.personal_mind.metadata_version,
      },
      idempotencyKey: `synthetic:${nonce}:retired-personal-description`,
      csrfPath: "/me",
      expectedStatus: 404,
    },
  );
  if (removedPersonalDescription.body?.error?.code !== "not_found") {
    fail("retired_personal_description_route_available");
  }
  for (const [actor, suffix] of [
    [actors.owner, "owner-personal"],
    [actors.participant, "participant-personal"],
  ]) {
    const usage = await readMindUsage(actor);
    const enabled = data(await setMindUsage(
      actor,
      "/me",
      "read",
      usage.usage_version,
      `synthetic:${nonce}:usage:${suffix}`,
    ));
    const personalItem = enabled.projection?.items?.find((item) => item.mind_ref === "/me");
    if (
      personalItem?.usage_mode !== "read" ||
      personalItem?.routing_profile !== "personal_default" ||
      personalItem?.description !== null
    ) {
      fail("personal_usage_not_enabled");
    }
  }
  const ownerMinds = mcpMinds(await actors.owner.mcp("list_minds"), actors.owner.actorClass);
  const participantMinds = mcpMinds(
    await actors.participant.mcp("list_minds"),
    actors.participant.actorClass,
  );
  if (
    ownerMinds.find((mind) => mind.route === "/me")?.mind_id !== ownerIds.mind ||
    participantMinds.find((mind) => mind.route === "/me")?.mind_id !== participantIds.mind ||
    ownerMinds.find((mind) => mind.route === "/me")?.routing_profile !== "personal_default" ||
    participantMinds.find((mind) => mind.route === "/me")?.routing_profile !== "personal_default" ||
    ownerMinds.find((mind) => mind.route === "/me")?.description !== null ||
    participantMinds.find((mind) => mind.route === "/me")?.description !== null
  ) fail("mcp_token_principal_mismatch");
  assertions.add("tokens.distinct-principal-bound");
  const crossPersonal = await actors.participant.mcp("get_mind_info", {
    mind: ownerIds.mind,
  });
  expectMcpError(crossPersonal, ["mind_not_found", "forbidden"]);
  assertions.add("personal-isolation.cross-account-denied");

  let current = data(await actors.owner.api("/api/v1/minds", {
    method: "POST",
    body: {
      name: "Synthetic Boundary",
      handle,
      description: "Durable shared knowledge explicitly discussed in this synthetic scenario.",
    },
    idempotencyKey: `synthetic:${nonce}:mind:create`,
  }));
  const privateExact = await actors.participant.api(`/api/v1/minds/${handle}`, {
    expectedStatus: 404,
  });
  if (
    privateExact.body?.error?.code !== "mind_not_found" ||
    JSON.stringify(privateExact.body).includes("Synthetic Boundary")
  ) fail("private_metadata_leak");
  assertions.add("private.web-non-enumeration");
  const privateListResponse = await actors.participant.api("/api/v1/minds");
  if (
    !Array.isArray(privateListResponse.body?.data) ||
    privateListResponse.body.data.some((mind) => mind.route === `/${handle}`)
  ) fail("private_list_leak");
  if (mcpMinds(await actors.participant.mcp("list_minds"), actors.participant.actorClass)
    .some((mind) => mind.route === `/${handle}`)) fail("private_mcp_list_leak");
  assertions.add("private.list-non-enumeration");
  expectMcpError(
    await actors.participant.mcp("list_revisions", { mind: `/${handle}` }),
    ["mind_not_found", "forbidden"],
  );
  assertions.add("private.history-non-enumeration");

  current = await visibility(actors.owner, handle, nonce, "public", current.metadata_version);
  const publicView = data(await actors.participant.api(`/api/v1/minds/${handle}`));
  if (publicView.access?.kind !== "visibility" || publicView.visibility !== "public") {
    fail("public_baseline_failed");
  }
  if (mcpMinds(await actors.participant.mcp("list_minds"), actors.participant.actorClass)
    .some((mind) => mind.route === `/${handle}`)) fail("disabled_public_mcp_leak");
  const publicUsage = await readMindUsage(actors.participant);
  const publicEnabled = data(await setMindUsage(
    actors.participant,
    `/${handle}`,
    "read",
    publicUsage.usage_version,
    `synthetic:${nonce}:usage:public-read`,
  ));
  if (publicEnabled.projection?.items?.find((item) => item.mind_ref === `/${handle}`)?.usage_mode !== "read") {
    fail("public_usage_not_enabled");
  }
  const publicMcp = mcpMinds(await actors.participant.mcp("list_minds"), actors.participant.actorClass)
    .find((mind) => mind.route === `/${handle}`);
  if (!publicMcp) fail("public_mcp_discovery_failed");
  const baselineWrite = await actors.participant.mcp("commit_changeset", {
    mind: `/${handle}`,
    expected_revision: publicMcp.head.revision_id,
    idempotency_key: `synthetic:${nonce}:baseline-write`,
    summary: "Synthetic baseline denial",
    operations: [{
      type: "create_file",
      path: "concepts/baseline-denied.md",
      text: "---\ntype: Note\ntitle: Baseline denied\n---\nDenied.\n",
    }],
  });
  expectMcpError(baselineWrite, ["forbidden", "writable_mind_required"]);
  const publicAfterDeniedWrite = data(await actors.participant.api(`/api/v1/minds/${handle}`));
  if (
    publicAfterDeniedWrite.access?.kind !== "visibility" ||
    publicAfterDeniedWrite.head_revision_id !== publicMcp.head.revision_id
  ) fail("public_write_denial_changed_authority_or_head");
  assertions.add("visibility.public-baseline-read-only");
  if (!data(await actors.participant.api("/api/v1/public-minds")).minds
    .some((candidate) => candidate.route === `/${handle}`)) {
    fail("public_catalog_missing");
  }
  assertions.add("visibility.public-catalog-only");

  current = await visibility(actors.owner, handle, nonce, "unlisted", current.metadata_version);
  if (data(await actors.participant.api("/api/v1/public-minds")).minds
    .some((candidate) => candidate.route === `/${handle}`)) {
    fail("unlisted_catalog_leak");
  }
  if (data(await actors.participant.api(`/api/v1/minds/${handle}`)).visibility !== "unlisted") {
    fail("unlisted_exact_failed");
  }
  if (!mcpMinds(await actors.participant.mcp("list_minds"), actors.participant.actorClass)
    .some((mind) => mind.route === `/${handle}`)) fail("enabled_unlisted_mcp_missing");
  const resolvedUnlisted = mcpResultData(await actors.participant.mcp("resolve_mind", { handle }));
  if (resolvedUnlisted.route !== `/${handle}`) fail("unlisted_mcp_exact_failed");
  assertions.add("visibility.unlisted-exact-only");

  current = await visibility(actors.owner, handle, nonce, "private", current.metadata_version);
  if ((await actors.participant.api(`/api/v1/minds/${handle}`, { expectedStatus: 404 }))
    .body?.error?.code !== "mind_not_found") fail("private_visibility_web_revoke_failed");
  if (mcpMinds(await actors.participant.mcp("list_minds"), actors.participant.actorClass)
    .some((mind) => mind.route === `/${handle}`)) fail("private_visibility_mcp_revoke_failed");
  expectMcpError(
    await actors.participant.mcp("list_revisions", { mind: `/${handle}` }),
    ["mind_not_found", "forbidden"],
  );
  assertions.add("visibility.private-immediate-revoke");

  await actors.owner.api(`/api/v1/minds/${handle}/invitations`, {
    method: "POST",
    body: {
      target_verified_email: participantAlias,
      role: "reader",
      expected_metadata_version: current.metadata_version,
    },
    idempotencyKey: `synthetic:${nonce}:invite`,
    csrfPath: `/${handle}`,
  });
  if ((await actors.participant.api(`/api/v1/minds/${handle}`, { expectedStatus: 404 }))
    .body?.error?.code !== "mind_not_found") fail("pending_invitation_granted_access");
  assertions.add("invitation.pending-access-denied");
  const invitation = data(await actors.participant.api("/api/v1/invitations"))
    .invitations?.find((item) => item.direction === "incoming" && (
      item.mind_route === `/${handle}` ||
      item.mind_handle === handle ||
      item.mind_name === "Synthetic Boundary"
    ));
  if (!invitation) fail("incoming_invitation_missing");
  const acceptOptions = {
    method: "POST",
    body: { expected_invitation_version: invitation.invitation_version },
    idempotencyKey: `synthetic:${nonce}:accept`,
    csrfPath: "/invitations",
  };
  await actors.participant.api(
    `/api/v1/invitations/${encodeURIComponent(invitation.invitation_id)}/accept`,
    acceptOptions,
  );
  await actors.participant.api(
    `/api/v1/invitations/${encodeURIComponent(invitation.invitation_id)}/accept`,
    acceptOptions,
  );
  const readerMembers = data(await actors.owner.api(`/api/v1/minds/${handle}/members`)).members;
  if (readerMembers.filter((member) => member.role === "reader").length !== 1) {
    fail("duplicate_reader_membership");
  }
  assertions.add("invitation.accept-replay-single-membership");
  const readerMind = mcpMinds(await actors.participant.mcp("list_minds"), actors.participant.actorClass)
    .find((mind) => mind.route === `/${handle}`);
  if (!readerMind) fail("reader_access_failed");
  mcpResultData(await actors.participant.mcp("list_revisions", { mind: `/${handle}` }));
  assertions.add("reads.current-acl-without-binding");
  mcpResultData(await actors.participant.mcp("browse_entries", { mind: `/${handle}` }));
  mcpResultData(await actors.participant.mcp("browse_entries", { mind: "/me" }));
  assertions.add("reads.multi-mind-current-acl");
  const readerUsage = await readMindUsage(actors.participant);
  const readerTargetDenied = await setMindUsage(
    actors.participant,
    `/${handle}`,
    "read_write",
    readerUsage.usage_version,
    `synthetic:${nonce}:target:reader-write-denied`,
    422,
  );
  if (readerTargetDenied.body?.error?.code !== "usage_not_allowed") {
    fail("reader_target_selection_not_denied");
  }
  const readerWrite = await actors.participant.mcp("commit_changeset", {
    mind: `/${handle}`,
    expected_revision: readerMind.head.revision_id,
    idempotency_key: `synthetic:${nonce}:reader-write`,
    summary: "Synthetic reader denial",
    operations: [{
      type: "create_file",
      path: "concepts/reader-denied.md",
      text: "---\ntype: Note\ntitle: Reader denied\n---\nDenied.\n",
    }],
  });
  expectMcpError(readerWrite, ["forbidden", "writable_mind_required"]);
  const readerAfterDeniedWrite = data(await actors.participant.api(`/api/v1/minds/${handle}`));
  if (
    readerAfterDeniedWrite.access?.role !== "reader" ||
    readerAfterDeniedWrite.head_revision_id !== readerMind.head.revision_id
  ) fail("reader_write_denial_changed_authority_or_head");
  assertions.add("bindings.read-only-cannot-write");
  assertions.add("role-transition.reader-read-only");

  const reader = readerMembers.find((member) => member.role === "reader" && !member.is_self);
  if (!reader) fail("reader_membership_missing");
  await actors.owner.api(
    `/api/v1/minds/${handle}/members/${encodeURIComponent(reader.member_id)}`,
    {
      method: "PATCH",
      body: { role: "editor", expected_membership_version: reader.membership_version },
      idempotencyKey: `synthetic:${nonce}:role:editor`,
      csrfPath: `/${handle}`,
    },
  );
  const editorInfo = mcpResultData(await actors.participant.mcp("get_mind_info", {
    mind: `/${handle}`,
  }));
  const usageBeforeOrdinaryWrite = await readMindUsage(actors.participant);
  const boundOrdinary = data(await setMindUsage(
    actors.participant,
    `/${handle}`,
    "read_write",
    usageBeforeOrdinaryWrite.usage_version,
    `synthetic:${nonce}:target:write:ordinary`,
  ));
  if (
    boundOrdinary.projection?.items?.find((item) => item.mind_ref === `/${handle}`)?.usage_mode !== "read_write" ||
    boundOrdinary.projection?.items?.filter((item) => item.usage_mode === "read_write").length !== 1
  ) fail("ordinary_write_binding_mismatch");
  assertions.add("bindings.single-write-current-target");
  const expectedRevision = editorInfo.resolved_revision.revision_id;
  const ordinaryCommitArguments = {
    mind: `/${handle}`,
    expected_revision: expectedRevision,
    idempotency_key: `synthetic:${nonce}:editor-write`,
    summary: "Synthetic editor fixture",
    operations: [{
      type: "create_file",
      path: "concepts/synthetic-gate.md",
      text: "---\ntype: Note\ntitle: Synthetic gate fixture\n---\nDeterministic fixture.\n",
    }],
  };
  const committed = mcpResultData(await actors.participant.mcp(
    "commit_changeset",
    ordinaryCommitArguments,
  ));
  let committedRevision = committed.revision?.revision_id;
  if (typeof committedRevision !== "string" || committedRevision === expectedRevision) {
    fail("editor_commit_failed");
  }
  const replayedCommit = mcpResultData(await actors.participant.mcp(
    "commit_changeset",
    ordinaryCommitArguments,
  ));
  if (replayedCommit.revision?.revision_id !== committedRevision) {
    fail("editor_commit_replay_changed_revision");
  }
  assertions.add("role-transition.editor-controlled-commit");
  const stale = await actors.participant.mcp("commit_changeset", {
    mind: `/${handle}`,
    expected_revision: expectedRevision,
    idempotency_key: `synthetic:${nonce}:stale-write`,
    summary: "Synthetic stale fixture",
    operations: [{
      type: "create_file",
      path: "concepts/stale.md",
      text: "---\ntype: Note\ntitle: Stale\n---\nStale.\n",
    }],
  });
  expectMcpError(stale, "revision_conflict");
  const afterStale = mcpResultData(await actors.participant.mcp("get_mind_info", {
    mind: `/${handle}`,
  }));
  if (afterStale.resolved_revision?.revision_id !== committedRevision) {
    fail("stale_commit_changed_head");
  }
  assertions.add("bindings.current-target-exactly-one-revision");
  assertions.add("role-transition.stale-head-no-partial-state");

  const personalBeforeRebind = mcpResultData(await actors.participant.mcp(
    "get_mind_info",
    { mind: "/me" },
  )).resolved_revision.revision_id;
  const preparedOrdinaryCommit = {
    mind: `/${handle}`,
    expected_revision: committedRevision,
    idempotency_key: `synthetic:${nonce}:binding:prepared-ordinary`,
    summary: "Synthetic prepared ordinary fixture",
    operations: [{
      type: "create_file",
      path: "concepts/prepared-before-rebind.md",
      text: "---\ntype: Note\ntitle: Prepared before rebind\n---\nMust not commit.\n",
    }],
  };
  const usageBeforePersonalWrite = await readMindUsage(actors.participant);
  const reboundPersonal = data(await setMindUsage(
    actors.participant,
    "/me",
    "read_write",
    usageBeforePersonalWrite.usage_version,
    `synthetic:${nonce}:target:write:personal`,
  ));
  if (
    reboundPersonal.projection?.items?.find((item) => item.mind_ref === "/me")?.usage_mode !== "read_write" ||
    reboundPersonal.projection?.items?.find((item) => item.mind_ref === "/me")?.routing_profile !== "personal_default" ||
    reboundPersonal.projection?.items?.find((item) => item.mind_ref === "/me")?.description !== null ||
    reboundPersonal.projection?.items?.find((item) => item.mind_ref === `/${handle}`)?.usage_mode !== "read_write" ||
    reboundPersonal.projection?.items?.filter((item) => item.usage_mode === "read_write").length !== 2
  ) fail("independent_personal_write_lane_mismatch");
  const preparedOrdinaryResult = mcpResultData(
    await actors.participant.mcp("commit_changeset", preparedOrdinaryCommit),
  );
  const ordinaryAfterPersonalEnable = mcpResultData(await actors.participant.mcp(
    "get_mind_info",
    { mind: `/${handle}` },
  )).resolved_revision.revision_id;
  const personalAfterOrdinaryCommit = mcpResultData(await actors.participant.mcp(
    "get_mind_info",
    { mind: "/me" },
  )).resolved_revision.revision_id;
  if (
    preparedOrdinaryResult.revision?.revision_id !== ordinaryAfterPersonalEnable ||
    ordinaryAfterPersonalEnable === committedRevision ||
    personalAfterOrdinaryCommit !== personalBeforeRebind
  ) fail("ordinary_write_disabled_by_personal_lane");
  committedRevision = ordinaryAfterPersonalEnable;
  assertions.add("bindings.personal-and-ordinary-write-independent");
  assertions.add("writes.ordinary-and-personal-exact-lane-no-cross-effect");

  const personalCommitArguments = {
    mind: "/me",
    expected_revision: personalBeforeRebind,
    idempotency_key: `synthetic:${nonce}:binding:commit:personal`,
    summary: "Synthetic personal binding fixture",
    operations: [{
      type: "create_file",
      path: "concepts/synthetic-binding-personal.md",
      text: "---\ntype: Note\ntitle: Synthetic binding personal fixture\n---\nBound target only.\n",
    }],
  };
  const committedPersonal = mcpResultData(await actors.participant.mcp(
    "commit_changeset",
    personalCommitArguments,
  ));
  const personalCommittedRevision = required(
    committedPersonal.revision?.revision_id,
    "personal_commit_revision_missing",
  );
  const replayedPersonal = mcpResultData(await actors.participant.mcp(
    "commit_changeset",
    personalCommitArguments,
  ));
  if (
    personalCommittedRevision === personalBeforeRebind ||
    replayedPersonal.revision?.revision_id !== personalCommittedRevision ||
    mcpResultData(await actors.participant.mcp("get_mind_info", {
      mind: `/${handle}`,
    })).resolved_revision.revision_id !== committedRevision
  ) fail("personal_bound_commit_not_exactly_once");
  assertions.add("bindings.current-target-exactly-one-revision");

  const usageBeforeOrdinaryRead = await readMindUsage(actors.participant);
  const ordinaryRead = data(await setMindUsage(
    actors.participant,
    `/${handle}`,
    "read",
    usageBeforeOrdinaryRead.usage_version,
    `synthetic:${nonce}:target:ordinary:read-before-concurrent`,
  ));
  if (
    ordinaryRead.projection?.items?.find((item) => item.mind_ref === `/${handle}`)?.usage_mode !== "read" ||
    ordinaryRead.projection?.items?.find((item) => item.mind_ref === "/me")?.usage_mode !== "read_write"
  ) fail("ordinary_lane_change_affected_personal_lane");
  const usageBeforeConcurrentSwitch = ordinaryRead.projection;
  const concurrentRebinds = await Promise.all([
    setMindUsage(
      actors.participant,
      `/${handle}`,
      "read_write",
      usageBeforeConcurrentSwitch.usage_version,
      `synthetic:${nonce}:target:concurrent:ordinary`,
      null,
    ),
    setMindUsage(
      actors.participant,
      `/${handle}`,
      "read_write",
      usageBeforeConcurrentSwitch.usage_version,
      `synthetic:${nonce}:target:concurrent:ordinary-second`,
      null,
    ),
  ]);
  const successfulRebinds = concurrentRebinds.filter(
    (response) => response.status === 200,
  );
  const rejectedRebinds = concurrentRebinds.filter(
    (response) => response.status === 409,
  );
  if (
    successfulRebinds.length !== 1 ||
    rejectedRebinds.length !== 1 ||
    rejectedRebinds[0].body?.error?.code !== "usage_conflict"
  ) fail("concurrent_rebind_cas_mismatch", {
    outcomes: concurrentRebinds.map((response) => ({
      status: response.status,
      code: safeCode(response.body?.error?.code),
      usageVersion: response.body?.data?.projection?.usage_version,
      writableCount: response.body?.data?.projection?.items?.filter(
        (item) => item.usage_mode === "read_write",
      ).length,
    })),
  });
  const winningRebind = data(successfulRebinds[0]);
  if (
    winningRebind.projection?.items?.find((item) => item.mind_ref === `/${handle}`)?.usage_mode !== "read_write" ||
    winningRebind.projection?.items?.find((item) => item.mind_ref === "/me")?.usage_mode !== "read_write" ||
    winningRebind.projection?.items?.filter((item) => item.usage_mode === "read_write").length !== 2
  ) fail("concurrent_rebind_result_not_independent");
  assertions.add("bindings.concurrent-rebind-cas");

  const materializedWork = await drainScheduled({
    runtimeRef,
    scheduled,
    kinds: ["revision_index", "audit_outbox"],
  });
  if (
    materializedWork === 0 ||
    searchProjectionCount(database) === 0 ||
    database.audit.size === 0
  ) fail("background_state_not_materialized", {
    materializedWork,
    searchCount: searchProjectionCount(database),
    auditCount: database.audit.size,
  });
  assertions.add("background.search-and-audit-materialized");
  const ordinaryBrowseBeforeDetach = mcpResultData(await actors.participant.mcp(
    "browse_entries",
    { mind: `/${handle}` },
  ));
  const ordinaryEntryId = ordinaryBrowseBeforeDetach.entries
    ?.find((entry) => typeof entry.entry_id === "string")?.entry_id;
  if (typeof ordinaryEntryId !== "string") fail("ordinary_entry_locator_missing");

  const ownerMind = data(await actors.owner.api(`/api/v1/minds/${handle}`));
  const transferMembers = data(await actors.owner.api(`/api/v1/minds/${handle}/members`)).members;
  const editor = transferMembers?.find((member) => member.role === "editor" && !member.is_self);
  const sourceOwner = transferMembers?.find((member) => member.role === "owner" && member.is_self);
  if (!editor || !sourceOwner) fail("ownership_transfer_members_missing");
  await actors.owner.api(`/api/v1/minds/${handle}/ownership-transfer`, {
    method: "POST",
    body: {
      target_member_id: editor.member_id,
      expected_metadata_version: ownerMind.metadata_version,
      expected_source_membership_version: sourceOwner.membership_version,
      expected_target_membership_version: editor.membership_version,
      confirmation: "transfer-ownership",
    },
    idempotencyKey: `synthetic:${nonce}:transfer`,
    csrfPath: `/${handle}`,
  });
  const transferredMembers = data(
    await actors.participant.api(`/api/v1/minds/${handle}/members`),
  ).members;
  if (
    transferredMembers.filter((member) => member.role === "owner").length !== 1 ||
    data(await actors.owner.api(`/api/v1/minds/${handle}`)).access?.role !== "admin" ||
    data(await actors.participant.api(`/api/v1/minds/${handle}`)).access?.role !== "owner"
  ) fail("ownership_transfer_failed");
  assertions.add("ownership-transfer.exactly-one-owner");

  runtimeRef.current = await harness.createRuntime();
  const ownerAfterRestart = ids(await actors.owner.session());
  const participantAfterRestart = ids(await actors.participant.session());
  if (
    ownerAfterRestart.principal !== ownerIds.principal ||
    ownerAfterRestart.mind !== ownerIds.mind ||
    participantAfterRestart.principal !== participantIds.principal ||
    participantAfterRestart.mind !== participantIds.mind
  ) fail("restart_account_state_changed");
  assertions.add("restart-persistence.accounts-personal-minds");
  const restartedParticipant = data(await actors.participant.api(`/api/v1/minds/${handle}`));
  const restartedOwner = data(await actors.owner.api(`/api/v1/minds/${handle}`));
  const restartedHistory = mcpResultData(await actors.participant.mcp("list_revisions", {
    mind: `/${handle}`,
  }));
  if (
    restartedParticipant.access?.role !== "owner" ||
    restartedOwner.access?.role !== "admin" ||
    restartedParticipant.head_revision_id !== committedRevision ||
    !restartedHistory.revisions?.some(
      (entry) => entry.revision?.revision_id === committedRevision,
    )
  ) fail("restart_collaboration_state_changed", {
    participantOwner: restartedParticipant.access?.role === "owner",
    sourceAdmin: restartedOwner.access?.role === "admin",
    headPersisted: restartedParticipant.head_revision_id === committedRevision,
    historyPersisted: restartedHistory.revisions?.some(
      (entry) => entry.revision?.revision_id === committedRevision,
    ) === true,
  });
  assertions.add("restart-persistence.owner-head-history-tokens");
  const restartedUsageInspection = await createSitesMetadataStore(database);
  const restartedUsage = await restartedUsageInspection.readPrincipalMindUsage(
    participantIds.principal,
  );
  if (
    restartedUsage === null ||
    !restartedUsage.entries.find((entry) =>
      entry.spaceId === restartedParticipant.mind_id)?.writeGeneration ||
    !restartedUsage.entries.find((entry) =>
      entry.spaceId === participantIds.mind)?.writeGeneration ||
    restartedUsage.entries.filter((entry) => entry.usageMode === "read_write").length !== 2
  ) fail("restart_binding_state_changed");
  assertions.add("bindings.restart-persistence");

  const staleWriteTargetRoute = `/${handle}`;
  const staleWriteTargetHead = mcpResultData(await actors.participant.mcp(
    "get_mind_info",
    { mind: staleWriteTargetRoute },
  )).resolved_revision.revision_id;
  mcpResultData(await actors.participant.mcp("fetch", { id: ordinaryEntryId }));
  mcpResultData(await actors.participant.mcp("list_revisions", { mind: `/${handle}` }));
  mcpResultData(await actors.participant.mcp("browse_entries", { mind: "/me" }));
  const usageBeforeDisable = await readMindUsage(actors.participant);
  const unbound = data(await setMindUsage(
    actors.participant,
    `/${handle}`,
    "disabled",
    usageBeforeDisable.usage_version,
    `synthetic:${nonce}:target:clear`,
  ));
  if (
    unbound.projection?.items?.find((item) => item.mind_ref === `/${handle}`)?.usage_mode !== "disabled" ||
    unbound.projection?.items?.find((item) => item.mind_ref === "/me")?.usage_mode !== "read_write" ||
    unbound.projection?.items?.filter((item) => item.usage_mode === "read_write").length !== 1
  ) fail("detach_unbind_transition_mismatch");
  expectMcpError(
    await actors.participant.mcp("commit_changeset", {
      mind: staleWriteTargetRoute,
      expected_revision: staleWriteTargetHead,
      idempotency_key: `synthetic:${nonce}:binding:stale-after-unbind`,
      summary: "Synthetic stale after unbind",
      operations: [{
        type: "create_file",
        path: "concepts/stale-after-unbind.md",
        text: "---\ntype: Note\ntitle: Stale after unbind\n---\nMust not commit.\n",
      }],
    }),
    ["mind_not_found", "forbidden", "writable_mind_required"],
  );
  if (data(await actors.participant.api(`/api/v1/minds/${handle}`)).head_revision_id !== staleWriteTargetHead) {
    fail("stale_after_unbind_changed_head");
  }
  assertions.add("bindings.unbind-write-fail-closed");

  const sourceMember = data(await actors.participant.api(`/api/v1/minds/${handle}/members`))
    .members?.find((member) => member.role === "admin" && !member.is_self);
  await actors.participant.api(
    `/api/v1/minds/${handle}/members/${encodeURIComponent(sourceMember.member_id)}`,
    {
      method: "DELETE",
      body: { expected_membership_version: sourceMember.membership_version },
      idempotencyKey: `synthetic:${nonce}:membership:revoke`,
      csrfPath: `/${handle}`,
    },
  );
  const revokedWeb = await actors.owner.api(`/api/v1/minds/${handle}`, {
    expectedStatus: 404,
  });
  if (
    revokedWeb.body?.error?.code !== "mind_not_found" ||
    JSON.stringify(revokedWeb.body).includes("Synthetic Boundary")
  ) fail("membership_revoke_web_failed");
  assertions.add("web-revoke.next-request-denied");
  if (mcpMinds(await actors.owner.mcp("list_minds"), actors.owner.actorClass)
    .some((mind) => mind.route === `/${handle}`)) fail("membership_revoke_mcp_failed");
  assertions.add("mcp-revoke.next-request-denied");
  expectMcpError(
    await actors.owner.mcp("list_revisions", { mind: `/${handle}` }),
    ["mind_not_found", "forbidden"],
  );
  assertions.add("history-revoke.next-request-denied");

  const usageBeforeDelete = await readMindUsage(actors.participant);
  const boundBeforeDelete = data(await setMindUsage(
    actors.participant,
    `/${handle}`,
    "read_write",
    usageBeforeDelete.usage_version,
    `synthetic:${nonce}:target:select-before-delete`,
  ));
  if (boundBeforeDelete.projection?.items?.find((item) => item.mind_ref === `/${handle}`)?.usage_mode !== "read_write") {
    fail("delete_target_binding_missing");
  }
  await deleteMind(actors.participant, handle, nonce);
  const deleted = await actors.participant.api(`/api/v1/minds/${handle}`, {
    expectedStatus: 404,
  });
  if (deleted.body?.error?.code !== "mind_not_found") fail("mind_cleanup_failed");
  assertions.add("cleanup.ordinary-mind-deleted");
  const deletionInspection = await createSitesMetadataStore(database);
  const usageAfterMindDelete = await deletionInspection.readPrincipalMindUsage(
    participantIds.principal,
  );
  if (
    usageAfterMindDelete === null ||
    usageAfterMindDelete.entries.some((entry) => entry.spaceId === restartedParticipant.mind_id) ||
    !usageAfterMindDelete.entries.find((entry) =>
      entry.spaceId === participantIds.mind)?.writeGeneration
  ) fail("mind_delete_did_not_invalidate_bindings");
  assertions.add("bindings.mind-delete-invalidates-target");
  const credentialInspection = await createSitesMetadataStore(database);
  const [ownerTokenMetadata, participantTokenMetadata] = await Promise.all([
    credentialInspection.readMcpTokenMetadataByPresentationRef(
      ownerIds.principal,
      actors.owner.mcpTokenRef,
    ),
    credentialInspection.readMcpTokenMetadataByPresentationRef(
      participantIds.principal,
      actors.participant.mcpTokenRef,
    ),
  ]);
  if (ownerTokenMetadata === null || participantTokenMetadata === null) {
    fail("personal_token_ref_resolution_failed");
  }
  const ownerTokenId = ownerTokenMetadata.tokenId;
  const participantTokenId = participantTokenMetadata.tokenId;
  await revokeToken(actors.owner, nonce, "owner");
  await revokeToken(actors.participant, nonce, "participant");
  const [ownerDenied, participantDenied] = await Promise.all([
    actors.owner.mcp("list_minds"),
    actors.participant.mcp("list_minds"),
  ]);
  if (ownerDenied.status !== 401 || participantDenied.status !== 401) {
    fail("token_cleanup_failed");
  }
  assertions.add("cleanup.tokens-revoked");
  const revokedUsageInspection = await createSitesMetadataStore(database);
  const revokedParticipantUsage = await revokedUsageInspection.readPrincipalMindUsage(
    participantIds.principal,
  );
  if (
    revokedParticipantUsage === null ||
    revokedParticipantUsage.usageVersion !== usageAfterMindDelete.usageVersion ||
    revokedParticipantUsage.entries.length !== usageAfterMindDelete.entries.length ||
    !revokedParticipantUsage.entries.find((entry) =>
      entry.spaceId === participantIds.mind)?.writeGeneration
  ) fail("target_owner_revoke_state_mismatch", {
    hasUsage: revokedParticipantUsage !== null,
    usageVersion: revokedParticipantUsage?.usageVersion ?? null,
    entryCount: revokedParticipantUsage?.entries.length ?? null,
  });
  assertions.add("bindings.owner-revoke-invalidates-state");
  await deleteAccount(actors.owner, nonce, "owner");
  await deleteAccount(actors.participant, nonce, "participant");
  assertions.add("cleanup.accounts-deleted");
  await drainScheduled({ runtimeRef, scheduled });
  if (scheduled.length !== 0) fail("background_cleanup_queue_not_drained");
  assertions.add("cleanup.background-work-drained");

  const inspection = await createSitesMetadataStore(database);
  const accountTotals = await inspection.inspectAccountBootstrapStateForTest();
  const ordinaryTotals = await inspection.inspectOrdinaryMindTotalsForTest();
  const ownerToken = await inspection.readMcpTokenForAuthorization(ownerTokenId);
  const participantToken = await inspection.readMcpTokenForAuthorization(
    participantTokenId,
  );
  const ownerBinding = await inspection.readAccountByExternalBinding({
    provider: BINDING_NAMESPACE,
    normalizedBinding: ownerAlias,
  });
  const participantBinding = await inspection.readAccountByExternalBinding({
    provider: BINDING_NAMESPACE,
    normalizedBinding: participantAlias,
  });
  const deletedParticipantUsage = await inspection.readPrincipalMindUsage(
    participantIds.principal,
  );
  const deletedParticipantUsageIsRemoved = deletedParticipantUsage === null;
  const retainedAuditTombstonesAreSafe = [...database.audit.values()].every((row) => {
    let event;
    try {
      event = JSON.parse(row.event_json);
    } catch {
      return false;
    }
    const serialized = JSON.stringify(event);
    return (
      row.actor_kind === "deleted-principal" &&
      row.principal_id === null &&
      event?.actor?.kind === "deleted-principal" &&
      event?.spaceId === null &&
      typeof event?.eventType === "string" &&
      /^[a-z][a-z0-9_.]{0,95}$/u.test(event.eventType) &&
      !serialized.includes(ownerAlias) &&
      !serialized.includes(participantAlias) &&
      !serialized.includes(ownerIds.principal) &&
      !serialized.includes(participantIds.principal) &&
      !serialized.includes(actors.owner.mcpTokenRef) &&
      !serialized.includes(actors.participant.mcpTokenRef)
    );
  });
  if (
    Object.values(accountTotals).some((count) => count !== 0) ||
    ordinaryTotals.minds !== 0 ||
    ordinaryTotals.reservations !== 0 ||
    ordinaryTotals.memberships !== 0 ||
    ordinaryTotals.revisions !== 0 ||
    ownerToken?.state !== "revoked" ||
    participantToken?.state !== "revoked" ||
    ownerBinding !== null ||
    participantBinding !== null ||
    !deletedParticipantUsageIsRemoved ||
    bucket.records.size !== 0 ||
    searchProjectionCount(database) !== 0 ||
    !retainedAuditTombstonesAreSafe
  ) fail("negative_state_scan_failed", {
    accountTotals,
    ordinaryTotals,
    tokensRevoked: ownerToken?.state === "revoked" && participantToken?.state === "revoked",
    ownerTokenState: ownerToken?.state ?? null,
    participantTokenState: participantToken?.state ?? null,
    bindingsRemoved: ownerBinding === null && participantBinding === null,
    deletedParticipantUsageIsRemoved,
    objectCount: bucket.records.size,
    searchCount: searchProjectionCount(database),
    auditCount: database.audit.size,
    retainedAuditTombstonesAreSafe,
  });
  assertions.add("cleanup.negative-state-scan");
  await assertNoSyntheticProductAuthority(ROOT);
  assertions.add("production-negative.no-synthetic-authority");

  const evidence = createEvidence({
    candidate,
    startedAt,
    completedAt: now().toISOString(),
    runFingerprint: opaque("run", randomBytesImpl),
    actorFingerprints: [
      opaque("actor", randomBytesImpl),
      opaque("actor", randomBytesImpl),
    ],
    passed: assertions.values,
  });
  await writeFile(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  database.destroy();
  bucket.destroy();
  return evidence;
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      fail("missing_cli_value");
    }
    if (Object.hasOwn(options, key)) fail("duplicate_cli_argument");
    options[key] = value;
    index += 1;
  }
  for (const key of Object.keys(options)) {
    if (!new Set(["candidate_sha", "evidence_out"]).has(key)) {
      fail("unsupported_cli_argument");
    }
  }
  if (!options.evidence_out) fail("missing_evidence_out");
  return options;
}

async function headSha() {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return candidateSha(result.stdout.trim());
}

export async function run(options, {
  randomBytesImpl = randomBytes,
  now = () => new Date(),
} = {}) {
  const currentHead = await headSha();
  const requested = options.candidate_sha === undefined
    ? currentHead
    : candidateSha(options.candidate_sha);
  if (requested !== currentHead) fail("candidate_sha_not_head");
  return runScenario({
    candidate: requested,
    evidenceOut: required(options.evidence_out, "missing_evidence_out"),
    randomBytesImpl,
    now,
  });
}

function help() {
  return "Usage: npm run gate:synthetic-multi-principal -- --evidence-out <private-temp-path> [--candidate-sha <exact-HEAD-sha>]";
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else {
      const evidence = await run(options);
      process.stdout.write(`${JSON.stringify({
        status: evidence.status,
        candidate_sha: evidence.candidate_sha,
        artifact_sha256: evidence.artifact_sha256,
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProbeFailure
        ? error.code
        : safeCode(error?.code) === "unexpected_response"
          ? "synthetic_probe_failed"
          : safeCode(error.code),
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

export { createEvidence };
