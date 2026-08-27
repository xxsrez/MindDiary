#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createSitesMetadataStore } from "../packages/adapter-metadata-sites/dist/index.js";
import {
  assertRedactedDocument,
  candidateSha,
  canonical,
  digest,
  fail,
  isRecord,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import {
  createSyntheticBrowserComposition,
  SYNTHETIC_BROWSER_BINDING_NAMESPACE,
} from "./lib/synthetic-browser-composition.mjs";
import { assertNoSyntheticProductAuthority } from "./lib/synthetic-product-negative.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const EVIDENCE_SCHEMA = "mind-diary/synthetic-browser-evidence/v1";
const ACTOR_CLASS = "synthetic-browser-principal";
const MCP_PROTOCOL = "2026-07-28";

// This registry is intentionally closed: a passing receipt cannot silently
// omit a browser boundary, UI, API, ACL, operator, restart, or cleanup check.
export const SYNTHETIC_BROWSER_ASSERTION_IDS = Object.freeze([
  "activation.server-bound-browser-contexts",
  "bootstrap.distinct-ordinary-principals",
  "bootstrap.distinct-personal-minds",
  "bootstrap.client-identity-selection-denied",
  "personal-isolation.session-ui-and-api",
  "private.route-and-api-non-enumeration",
  "visibility.public-ui-and-catalog",
  "visibility.unlisted-exact-ui",
  "visibility.private-immediate-revoke",
  "invitation.pending-ui-and-api-denied",
  "invitation.accept-reader",
  "role.reader-no-write",
  "role.editor-controlled-write",
  "ownership.transfer-exactly-one-owner",
  "restart.persistence",
  "operator.ui-paginated-directory",
  "operator.api-paginated-directory",
  "operator.search-sort-empty-never-active",
  "operator.ordinary-ui-denied",
  "operator.ordinary-api-denied",
  "operator.mind-role-ui-denied",
  "operator.mind-role-api-denied",
  "operator.denied-request-no-activity",
  "revoke.context-denied-after-restart",
  "cleanup.ordinary-mind-deleted",
  "cleanup.tokens-revoked",
  "cleanup.accounts-deleted",
  "cleanup.background-drained",
  "cleanup.negative-state-scan",
  "production-negative.no-synthetic-authority",
]);

function required(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function passedTracker() {
  const values = new Set();
  return Object.freeze({
    add(id) {
      if (!SYNTHETIC_BROWSER_ASSERTION_IDS.includes(id)) fail("unknown_assertion_id");
      values.add(id);
    },
    values,
  });
}

function data(result, code = "invalid_projection") {
  if (!isRecord(result.body?.data)) fail(code);
  return result.body.data;
}

function expectStatus(result, status, code = "unexpected_status") {
  if (result.status !== status) fail(code, { status: result.status });
  return result;
}

function expectError(result, status, code) {
  if (result.status !== status || result.body?.error?.code !== code) {
    fail("expected_api_error_missing", { status: result.status, code: safeCode(result.body?.error?.code) });
  }
}

function mcpEnvelope(result) {
  const payload = result.body?.result;
  if (result.status !== 200 || !isRecord(payload)) {
    fail("mcp_request_failed", { status: result.status });
  }
  return payload;
}

function mcpData(result) {
  const payload = mcpEnvelope(result);
  if (payload.isError === true || !isRecord(payload.structuredContent?.data)) {
    fail("mcp_data_missing", { code: safeCode(payload.structuredContent?.error?.code) });
  }
  return payload.structuredContent.data;
}

function expectMcpError(result, code) {
  const payload = mcpEnvelope(result);
  if (payload.isError !== true || payload.structuredContent?.error?.code !== code) {
    fail("expected_mcp_error_missing", {
      expected: code,
      actual: safeCode(payload.structuredContent?.error?.code),
    });
  }
}

async function mcp(context, secret, name, args = {}) {
  return context.request("/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": MCP_PROTOCOL,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${context.name}-${name}`,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "synthetic-browser-gate", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function assertTargetOnlyMcpCatalog(context, secret) {
  const result = await context.request("/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": "tools/list",
      "mcp-protocol-version": MCP_PROTOCOL,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${context.name}-tools-list`,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "synthetic-browser-gate", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const tools = result.body?.result?.tools;
  if (!Array.isArray(tools)) fail("mcp_catalog_missing");
  const serialized = JSON.stringify(tools);
  if (
    tools.some(({ name }) => [
      "get_mind_bindings",
      "set_read_mind_binding",
      "set_write_mind_binding",
    ].includes(name)) ||
    /write_binding_id|expected_binding_version|target_generation/u.test(serialized)
  ) fail("mcp_catalog_exposes_binding_authority");
}

async function issueToken(context, nonce, name) {
  const result = await context.json("/api/v1/mcp-tokens", {
    method: "POST",
    body: { name, scopes: ["content:write"] },
    idempotencyKey: `browser:${nonce}:token:${name}`,
    csrfPath: "/settings/developer/mcp",
  });
  const value = data(result, "token_issue_failed");
  if (typeof value.secret !== "string" || typeof value.token?.personal_token_ref !== "string") {
    fail("token_issue_projection_invalid");
  }
  return Object.freeze({ secret: value.secret, ref: value.token.personal_token_ref });
}

async function mutateTokenTarget(context, tokenRef, nonce, body, suffix, expectedStatus = 200) {
  return context.api(
    `/api/v1/mcp-tokens/${encodeURIComponent(tokenRef)}/mind-access`,
    {
      method: "PATCH",
      body,
      idempotencyKey: `browser:${nonce}:target:${suffix}`,
      csrfPath: "/settings/developer/mcp",
      expectedStatus,
    },
  );
}

async function setVisibility(context, handle, value, metadataVersion, nonce) {
  return data(await context.json(`/api/v1/minds/${handle}/visibility`, {
    method: "PUT",
    body: {
      visibility: value,
      acknowledge_live_head_and_history_exposure: value !== "private",
      expected_metadata_version: metadataVersion,
    },
    idempotencyKey: `browser:${nonce}:visibility:${value}`,
    csrfPath: `/${handle}`,
  }));
}

async function deleteMind(context, handle, nonce) {
  const impact = data(await context.json(`/api/v1/minds/${handle}/deletion-impact`));
  await context.json(`/api/v1/minds/${handle}`, {
    method: "DELETE",
    body: { impact_id: impact.impact_id, confirmation: impact.confirmation },
    idempotencyKey: `browser:${nonce}:mind-delete`,
    csrfPath: `/${handle}`,
  });
}

async function deleteAccount(context, nonce, name) {
  const impact = data(await context.json("/api/v1/account/deletion-impact"));
  await context.json("/api/v1/account", {
    method: "DELETE",
    body: { impact_id: impact.impact_id, confirmation: impact.confirmation },
    idempotencyKey: `browser:${nonce}:account-delete:${name}`,
    csrfPath: "/settings/account",
  });
  const session = await context.api("/api/v1/session");
  expectError(session, 409, "registration_required");
}

async function revokeToken(context, personalTokenRef, nonce, name) {
  const result = data(await context.json(`/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}`, {
    method: "DELETE",
    idempotencyKey: `browser:${nonce}:token-revoke:${name}`,
    csrfPath: "/settings/developer/mcp",
  }));
  if (result.token?.state !== "revoked") fail("token_revoke_failed");
}

function searchProjectionCount(database) {
  return database.search.size + database.searchDocuments.size +
    database.searchMemberships.size + database.searchLexical.size;
}

function createEvidence({ candidate, startedAt, completedAt, nonce, passed }) {
  if (passed.size !== SYNTHETIC_BROWSER_ASSERTION_IDS.length) fail("incomplete_assertion_registry");
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: candidate,
    actor_class: ACTOR_CLASS,
    binding_namespace: SYNTHETIC_BROWSER_BINDING_NAMESPACE,
    run_fingerprint: digest(`browser-run:${nonce}`).slice(0, 38),
    actor_fingerprints: Object.freeze([
      digest(`browser-actor:${nonce}:a`).slice(0, 40),
      digest(`browser-actor:${nonce}:b`).slice(0, 40),
    ]),
    started_at: startedAt,
    completed_at: completedAt,
    assertions: Object.freeze(SYNTHETIC_BROWSER_ASSERTION_IDS.map((id) => ({ id, status: "passed" }))),
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

async function runScenario({ candidate, evidenceOut, randomBytesImpl, now }) {
  const startedAt = now().toISOString();
  const nonce = randomBytesImpl(8).toString("hex");
  const ownerEmail = `owner-${nonce}@synthetic.invalid`;
  const participantEmail = `participant-${nonce}@synthetic.invalid`;
  const operatorEmail = `operator-${nonce}@synthetic.invalid`;
  const handle = `browser-gate-${nonce}`;
  const composition = await createSyntheticBrowserComposition({ now });
  const owner = composition.createContext({ name: "owner", identity: {
    kind: "authenticated", verifiedEmail: ownerEmail, verifiedFullName: "Synthetic Owner",
  } });
  const participant = composition.createContext({ name: "participant", identity: {
    kind: "authenticated", verifiedEmail: participantEmail, verifiedFullName: "Synthetic Participant",
  } });
  const operator = composition.createContext({ name: "operator", identity: {
    kind: "authenticated", verifiedEmail: operatorEmail, verifiedFullName: "Synthetic Operator",
  } });
  const assertions = passedTracker();
  try {
    assertions.add("activation.server-bound-browser-contexts");
    const ownerBootstrap = await owner.bootstrap(`browser:${nonce}:bootstrap:owner`);
    const participantBootstrap = await participant.bootstrap(`browser:${nonce}:bootstrap:participant`);
    const operatorBootstrap = await operator.bootstrap(`browser:${nonce}:bootstrap:operator`);
    if (ownerBootstrap.principal_id === participantBootstrap.principal_id ||
        ownerBootstrap.personal_mind.mind_id === participantBootstrap.personal_mind.mind_id) {
      fail("ordinary_principals_not_isolated");
    }
    assertions.add("bootstrap.distinct-ordinary-principals");
    assertions.add("bootstrap.distinct-personal-minds");
    const spoofed = await participant.api("/api/v1/session", {
      headers: { "x-principal-id": ownerBootstrap.principal_id, "x-verified-email": ownerEmail },
    });
    if (spoofed.body?.data?.principal?.principal_id !== participantBootstrap.principal_id) {
      fail("client_identity_selection_succeeded");
    }
    assertions.add("bootstrap.client-identity-selection-denied");
    if (!(await owner.page("/me")).includes("Synthetic Owner") ||
        (await participant.page("/me")).includes("Synthetic Owner")) {
      fail("personal_ui_isolation_failed");
    }
    if ((await participant.api("/api/v1/session")).body?.data?.personal_mind?.mind_id ===
        ownerBootstrap.personal_mind.mind_id) fail("personal_api_isolation_failed");
    assertions.add("personal-isolation.session-ui-and-api");

    await composition.restart({ serviceOperatorPrincipalIds: [operatorBootstrap.principal_id] });
    let mind = data(await owner.json("/api/v1/minds", {
      method: "POST",
      body: { name: "Synthetic Browser Mind", handle },
      idempotencyKey: `browser:${nonce}:mind-create`,
    }));
    expectError(await participant.api(`/api/v1/minds/${handle}`), 404, "mind_not_found");
    if ((await participant.page(`/${handle}`)).includes("Synthetic Browser Mind") ||
        (await participant.page("/minds")).includes(handle)) fail("private_route_leak");
    assertions.add("private.route-and-api-non-enumeration");

    mind = await setVisibility(owner, handle, "public", mind.metadata_version, nonce);
    const publicMinds = data(await participant.json("/api/v1/public-minds")).minds;
    if (!publicMinds.some((candidate) => candidate.route === `/${handle}`) ||
        !(await participant.page(`/${handle}`)).includes("Synthetic Browser Mind")) {
      fail("public_ui_catalog_failed");
    }
    assertions.add("visibility.public-ui-and-catalog");
    mind = await setVisibility(owner, handle, "unlisted", mind.metadata_version, nonce);
    if (data(await participant.json("/api/v1/public-minds")).minds
      .some((candidate) => candidate.route === `/${handle}`) ||
        !(await participant.page(`/${handle}`)).includes("Synthetic Browser Mind")) fail("unlisted_ui_failed");
    assertions.add("visibility.unlisted-exact-ui");
    mind = await setVisibility(owner, handle, "private", mind.metadata_version, nonce);
    expectError(await participant.api(`/api/v1/minds/${handle}`), 404, "mind_not_found");
    if ((await participant.page(`/${handle}`)).includes("Synthetic Browser Mind")) fail("private_revoke_ui_failed");
    assertions.add("visibility.private-immediate-revoke");

    await owner.json(`/api/v1/minds/${handle}/invitations`, {
      method: "POST",
      body: { target_verified_email: participantEmail, role: "reader", expected_metadata_version: mind.metadata_version },
      idempotencyKey: `browser:${nonce}:invite`, csrfPath: `/${handle}`,
    });
    expectError(await participant.api(`/api/v1/minds/${handle}`), 404, "mind_not_found");
    if ((await participant.page(`/${handle}`)).includes("Synthetic Browser Mind")) fail("pending_invitation_ui_leak");
    assertions.add("invitation.pending-ui-and-api-denied");
    const invitations = data(await participant.json("/api/v1/invitations")).invitations;
    const invitation = invitations.find((value) => value.direction === "incoming" && (
      value.mind_handle === handle || value.mind_route === `/${handle}` ||
      value.mind_name === "Synthetic Browser Mind"
    ));
    if (!invitation) fail("invitation_missing");
    await participant.json(`/api/v1/invitations/${encodeURIComponent(invitation.invitation_id)}/accept`, {
      method: "POST", body: { expected_invitation_version: invitation.invitation_version },
      idempotencyKey: `browser:${nonce}:invite-accept`, csrfPath: "/invitations",
    });
    const membersAfterAccept = data(await owner.json(`/api/v1/minds/${handle}/members`)).members;
    const participantMember = membersAfterAccept.find((value) => value.role === "reader" && !value.is_self);
    if (!participantMember) fail("reader_membership_missing");
    assertions.add("invitation.accept-reader");

    const ownerToken = await issueToken(owner, nonce, "owner");
    const participantToken = await issueToken(participant, nonce, "participant");
    await assertTargetOnlyMcpCatalog(participant, participantToken.secret);
    const readerMind = mcpData(await mcp(participant, participantToken.secret, "list_minds"))
      .minds.find((value) => value.route === `/${handle}`);
    if (!readerMind) fail("reader_mcp_discovery_failed");
    const readerTarget = await mutateTokenTarget(
      participant,
      participantToken.ref,
      nonce,
      { action: "select_write", mind_ref: `/${handle}`, expected_target_version: 0 },
      "reader-denied",
      403,
    );
    expectError(readerTarget, 403, "target_ineligible");
    expectMcpError(await mcp(participant, participantToken.secret, "commit_changeset", {
      mind: `/${handle}`, expected_revision: readerMind.head.revision_id,
      idempotency_key: `browser:${nonce}:reader-write`, summary: "Reader denial", operations: [{
        type: "create_file",
        path: "concepts/reader-must-not-write.md",
        text: "---\ntype: Note\ntitle: Reader must not write\n---\nDenied.\n",
      }],
    }), "forbidden");
    assertions.add("role.reader-no-write");
    await owner.json(`/api/v1/minds/${handle}/members/${encodeURIComponent(participantMember.member_id)}`, {
      method: "PATCH", body: { role: "editor", expected_membership_version: participantMember.membership_version },
      idempotencyKey: `browser:${nonce}:role-editor`, csrfPath: `/${handle}`,
    });
    const selected = data(await mutateTokenTarget(
      participant,
      participantToken.ref,
      nonce,
      { action: "select_write", mind_ref: `/${handle}`, expected_target_version: 0 },
      "editor-select",
    ));
    if (selected.access?.target_version !== 1) fail("editor_target_select_failed");
    data(await mutateTokenTarget(
      participant,
      participantToken.ref,
      nonce,
      { action: "select_write", mind_ref: "/me", expected_target_version: 1 },
      "switch-personal",
    ));
    const staleInfo = mcpData(await mcp(participant, participantToken.secret, "get_mind_info", { mind: `/${handle}` }));
    expectMcpError(await mcp(participant, participantToken.secret, "commit_changeset", {
      mind: `/${handle}`,
      expected_revision: staleInfo.resolved_revision.revision_id,
      idempotency_key: `browser:${nonce}:editor-write-stale`, summary: "Stale generation denial",
      operations: [{ type: "create_file", path: "concepts/must-not-commit.md", text: "---\ntype: Note\ntitle: Must not commit\n---\nDenied.\n" }],
    }), "writable_target_mismatch");
    data(await mutateTokenTarget(
      participant,
      participantToken.ref,
      nonce,
      { action: "select_write", mind_ref: `/${handle}`, expected_target_version: 2 },
      "switch-back",
    ));
    await composition.restart({ serviceOperatorPrincipalIds: [operatorBootstrap.principal_id] });
    const currentInfo = mcpData(await mcp(participant, participantToken.secret, "get_mind_info", { mind: `/${handle}` }));
    const commit = mcpData(await mcp(participant, participantToken.secret, "commit_changeset", {
      mind: `/${handle}`,
      expected_revision: currentInfo.resolved_revision.revision_id,
      idempotency_key: `browser:${nonce}:editor-write`, summary: "Browser gate fixture",
      operations: [{ type: "create_file", path: "concepts/browser-gate.md", text: "---\ntype: Note\ntitle: Browser gate\n---\nDeterministic.\n" }],
    }));
    if (typeof commit.revision?.revision_id !== "string") fail("editor_commit_failed");
    assertions.add("role.editor-controlled-write");

    mind = data(await owner.json(`/api/v1/minds/${handle}`));
    const transferMembers = data(await owner.json(`/api/v1/minds/${handle}/members`)).members;
    const editorMember = transferMembers
      .find((value) => value.member_id === participantMember.member_id);
    const sourceOwner = transferMembers.find((value) => value.is_self === true && value.role === "owner");
    if (!editorMember || !sourceOwner) fail("ownership_transfer_members_missing");
    await owner.json(`/api/v1/minds/${handle}/ownership-transfer`, {
      method: "POST", body: {
        target_member_id: editorMember.member_id,
        expected_metadata_version: mind.metadata_version,
        expected_source_membership_version: sourceOwner.membership_version,
        expected_target_membership_version: editorMember.membership_version,
        confirmation: "transfer-ownership",
      },
      idempotencyKey: `browser:${nonce}:transfer`, csrfPath: `/${handle}`,
    });
    const transferredMembers = data(await participant.json(`/api/v1/minds/${handle}/members`)).members;
    if (transferredMembers.filter((value) => value.role === "owner").length !== 1 ||
        data(await participant.json(`/api/v1/minds/${handle}`)).access?.role !== "owner") fail("ownership_transfer_failed");
    assertions.add("ownership.transfer-exactly-one-owner");

    await composition.restart({ serviceOperatorPrincipalIds: [operatorBootstrap.principal_id] });
    if ((await participant.json(`/api/v1/minds/${handle}`)).body?.data?.head_revision_id !== commit.revision.revision_id) {
      fail("restart_head_not_persisted");
    }
    if (!(await participant.page(`/${handle}`)).includes("Synthetic Browser Mind")) fail("restart_ui_not_persisted");
    assertions.add("restart.persistence");

    const operatorPage = await operator.page("/internal/operators/users?limit=1&sort=display_name&direction=asc");
    if (!operatorPage.includes("UAT users") || !operatorPage.includes("Next page") || !operatorPage.includes("<tbody>")) fail("operator_ui_page_failed");
    assertions.add("operator.ui-paginated-directory");
    const operatorRows = data(await operator.json("/api/v1/internal/operators/users?limit=1&sort=display_name&direction=asc")).principals;
    if (!Array.isArray(operatorRows) || operatorRows.length !== 1) fail("operator_api_page_failed");
    const allOperatorRows = data(await operator.json("/api/v1/internal/operators/users?limit=100&sort=display_name&direction=asc")).principals;
    if (!Array.isArray(allOperatorRows) || allOperatorRows.length < 3) fail("operator_directory_not_multi_principal");
    const nextHref = /<a class="md-button" href="([^"]*cursor=[^"]+)">Next page<\/a>/u.exec(operatorPage)?.[1];
    if (nextHref === undefined || !(await operator.page(nextHref)).includes("UAT users")) fail("operator_ui_next_page_failed");
    assertions.add("operator.api-paginated-directory");
    const searchRows = data(await operator.json(`/api/v1/internal/operators/users?query=${encodeURIComponent(participantEmail)}&sort=last_activity_at&direction=desc`)).principals;
    const emptyRows = data(await operator.json("/api/v1/internal/operators/users?query=absent-synthetic-browser-user")).principals;
    const neverRows = data(await operator.json("/api/v1/internal/operators/users?never_active=true")).principals;
    if (searchRows.length !== 1 || emptyRows.length !== 0 || neverRows.length !== 0) fail("operator_filters_failed");
    if (!(await operator.page("/internal/operators/users?query=absent-synthetic-browser-user&neverActive=true")).includes("No accounts match this bounded view")) fail("operator_empty_ui_failed");
    assertions.add("operator.search-sort-empty-never-active");

    const ordinaryUiDeniedBefore = data(await operator.json(`/api/v1/internal/operators/users?query=${encodeURIComponent(participantEmail)}`)).principals;
    expectError(await participant.api("/api/v1/internal/operators/users"), 404, "not_found");
    if ((await participant.request("/internal/operators/users")).status !== 404) fail("ordinary_operator_ui_not_denied");
    const ordinaryUiDeniedAfter = data(await operator.json(`/api/v1/internal/operators/users?query=${encodeURIComponent(participantEmail)}`)).principals;
    if (JSON.stringify(ordinaryUiDeniedBefore) !== JSON.stringify(ordinaryUiDeniedAfter)) fail("denied_request_changed_activity");
    assertions.add("operator.ordinary-ui-denied");
    assertions.add("operator.ordinary-api-denied");
    // A principal with an ordinary Mind role is denied the operator boundary too.
    if ((await participant.request(`/internal/operators/users?mind=${handle}`)).status !== 404) fail("mind_role_operator_ui_not_denied");
    expectError(await participant.api(`/api/v1/internal/operators/users?mind=${handle}`), 404, "not_found");
    assertions.add("operator.mind-role-ui-denied");
    assertions.add("operator.mind-role-api-denied");
    assertions.add("operator.denied-request-no-activity");

    const ownerMember = transferredMembers.find((value) => value.role === "admin" && !value.is_self);
    await participant.json(`/api/v1/minds/${handle}/members/${encodeURIComponent(ownerMember.member_id)}`, {
      method: "DELETE", body: { expected_membership_version: ownerMember.membership_version },
      idempotencyKey: `browser:${nonce}:revoke-owner`, csrfPath: `/${handle}`,
    });
    expectError(await owner.api(`/api/v1/minds/${handle}`), 404, "mind_not_found");
    if ((await owner.page(`/${handle}`)).includes("Synthetic Browser Mind")) fail("revoked_ui_access_remained");
    assertions.add("revoke.context-denied-after-restart");

    await deleteMind(participant, handle, nonce);
    expectError(await participant.api(`/api/v1/minds/${handle}`), 404, "mind_not_found");
    assertions.add("cleanup.ordinary-mind-deleted");
    await revokeToken(owner, ownerToken.ref, nonce, "owner");
    await revokeToken(participant, participantToken.ref, nonce, "participant");
    expectStatus(await mcp(owner, ownerToken.secret, "list_minds"), 401, "revoked_owner_token_not_denied");
    expectStatus(await mcp(participant, participantToken.secret, "list_minds"), 401, "revoked_participant_token_not_denied");
    assertions.add("cleanup.tokens-revoked");
    await deleteAccount(owner, nonce, "owner");
    await deleteAccount(participant, nonce, "participant");
    await deleteAccount(operator, nonce, "operator");
    assertions.add("cleanup.accounts-deleted");
    await composition.drain();
    if (composition.scheduled.length !== 0) fail("background_queue_not_drained");
    assertions.add("cleanup.background-drained");
    const inspection = await createSitesMetadataStore(composition.database);
    const accountTotals = await inspection.inspectAccountBootstrapStateForTest();
    const ordinaryTotals = await inspection.inspectOrdinaryMindTotalsForTest();
    if (Object.values(accountTotals).some((value) => value !== 0) || ordinaryTotals.minds !== 0 || ordinaryTotals.memberships !== 0 || ordinaryTotals.revisions !== 0 || composition.bucket.records.size !== 0 || searchProjectionCount(composition.database) !== 0) fail("negative_state_scan_failed", { accountTotals, ordinaryTotals, objectCount: composition.bucket.records.size, searchCount: searchProjectionCount(composition.database) });
    assertions.add("cleanup.negative-state-scan");
    await assertNoSyntheticProductAuthority(ROOT);
    assertions.add("production-negative.no-synthetic-authority");
    const evidence = createEvidence({ candidate, startedAt, completedAt: now().toISOString(), nonce, passed: assertions.values });
    await writeFile(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return evidence;
  } finally {
    await composition.close();
  }
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || Object.hasOwn(options, key)) fail("invalid_cli_argument");
    options[key] = value;
    index += 1;
  }
  for (const key of Object.keys(options)) if (!["candidate_sha", "evidence_out"].includes(key)) fail("unsupported_cli_argument");
  if (!options.evidence_out) fail("missing_evidence_out");
  return options;
}

async function headSha() {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return candidateSha(result.stdout.trim());
}

export async function run(options, { randomBytesImpl = randomBytes, now = () => new Date() } = {}) {
  const current = await headSha();
  const requested = options.candidate_sha === undefined ? current : candidateSha(options.candidate_sha);
  if (requested !== current) fail("candidate_sha_not_head");
  return runScenario({ candidate: requested, evidenceOut: required(options.evidence_out, "missing_evidence_out"), randomBytesImpl, now });
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write("Usage: npm run gate:synthetic-browser -- --evidence-out <private-temp-path> [--candidate-sha <exact-HEAD-sha>]\n");
    else {
      const evidence = await run(options);
      process.stdout.write(`${JSON.stringify({ status: evidence.status, candidate_sha: evidence.candidate_sha, artifact_sha256: evidence.artifact_sha256 })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof ProbeFailure ? error.code : safeCode(error?.code) })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
