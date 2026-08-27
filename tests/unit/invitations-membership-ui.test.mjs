import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  renderInvitationsMembership,
  renderInvitationsMembershipDocument,
  renderInvitationsMembershipPanel,
} from "../../packages/adapter-web/dist/invitations-membership.js";

const implementation = await readFile(
  new URL(
    "../../packages/adapter-web/src/invitations-membership.ts",
    import.meta.url,
  ),
  "utf8",
);

const SNAPSHOT = Object.freeze({
  mind: Object.freeze({
    mindId: "mind_research",
    name: "Research Notes",
    route: "/research-notes",
    visibility: "private",
    metadataVersion: 7,
  }),
  actor: Object.freeze({
    memberId: "member_owner",
    role: "owner",
    membershipVersion: 3,
  }),
  members: Object.freeze([
    Object.freeze({
      memberId: "member_owner",
      displayName: "Andrey",
      role: "owner",
      state: "active",
      membershipVersion: 3,
      isSelf: true,
    }),
    Object.freeze({
      memberId: "member_admin",
      displayName: "Alex Admin",
      role: "admin",
      state: "active",
      membershipVersion: 4,
      isSelf: false,
    }),
    Object.freeze({
      memberId: "member_editor",
      displayName: "Eva Editor",
      role: "editor",
      state: "active",
      membershipVersion: 5,
      isSelf: false,
    }),
    Object.freeze({
      memberId: "member_revoked",
      displayName: "Former Reader",
      role: "reader",
      state: "revoked",
      membershipVersion: 2,
      isSelf: false,
    }),
  ]),
  invitations: Object.freeze([
    Object.freeze({
      invitationId: "invite_incoming_pending",
      direction: "incoming",
      counterpartyDisplayName: "Incoming Owner",
      proposedRole: "editor",
      state: "pending",
      expiresAt: "2026-08-12T12:00:00.000Z",
      invitationVersion: 1,
    }),
    Object.freeze({
      invitationId: "invite_incoming_expired",
      direction: "incoming",
      counterpartyDisplayName: "Expired Sender",
      proposedRole: "reader",
      state: "expired",
      expiresAt: "2026-08-06T12:00:00.000Z",
      invitationVersion: 2,
    }),
    Object.freeze({
      invitationId: "invite_outgoing_pending",
      direction: "outgoing",
      counterpartyDisplayName: "Pending Candidate",
      proposedRole: "admin",
      state: "pending",
      expiresAt: "2026-08-12T12:00:00.000Z",
      invitationVersion: 1,
    }),
    Object.freeze({
      invitationId: "invite_outgoing_expired",
      direction: "outgoing",
      counterpartyDisplayName: "Expired Candidate",
      proposedRole: "reader",
      state: "expired",
      expiresAt: "2026-08-06T12:00:00.000Z",
      invitationVersion: 2,
    }),
  ]),
});

function model(snapshot = SNAPSHOT) {
  return {
    displayName: "Andrey",
    collection: { kind: "ready", snapshot },
  };
}

function replaceActor(role) {
  return {
    ...SNAPSHOT,
    actor: {
      ...SNAPSHOT.actor,
      memberId: `member_${role}`,
      role,
    },
    members: SNAPSHOT.members.map((member) => ({
      ...member,
      isSelf: member.memberId === `member_${role}`,
    })),
  };
}

function element(html, marker, tag = "form") {
  const pattern = new RegExp(
    `<${tag}[^>]*${marker}[^>]*>[\\s\\S]*?<\\/${tag}>`,
    "u",
  );
  const match = html.match(pattern);
  assert.ok(match, `Expected ${tag} containing ${marker}`);
  return match[0];
}

test("exact-email invitation form exposes only roles the current actor may grant", () => {
  const ownerHtml = renderInvitationsMembership(model());
  const ownerForm = element(ownerHtml, "data-invitation-form");

  assert.match(ownerForm, /type="email"/);
  assert.match(ownerForm, /Exact verified email/);
  assert.match(ownerHtml, /existing Mind Diary account/);
  assert.match(ownerHtml, /people-search suggestions/);
  assert.match(ownerHtml, /invite emails/);
  assert.match(ownerHtml, /unregistered addresses/);
  assert.match(ownerForm, /<option value="reader">Reader<\/option>/);
  assert.match(ownerForm, /<option value="editor">Editor<\/option>/);
  assert.match(ownerForm, /<option value="admin">Admin<\/option>/);
  assert.doesNotMatch(ownerForm, /value="owner"|type="search"|<datalist/i);

  const adminHtml = renderInvitationsMembership(model(replaceActor("admin")));
  const adminForm = element(adminHtml, "data-invitation-form");
  assert.match(adminForm, /value="reader"/);
  assert.match(adminForm, /value="editor"/);
  assert.doesNotMatch(adminForm, /value="admin"|value="owner"/);
});

test("contextual Access starts compact and reveals invitation/member controls on request", () => {
  const html = renderInvitationsMembershipPanel(SNAPSHOT);

  assert.match(html, /<h2 id="collaboration-heading">Access<\/h2>/);
  assert.match(html, /data-access-summary/);
  assert.match(html, /<dt>Visibility<\/dt><dd>Private — Only active participants can read this Mind\.<\/dd>/);
  assert.match(html, /<dt>Your role<\/dt><dd>Owner<\/dd>/);
  assert.match(html, /<dt>Participants<\/dt><dd>3<\/dd>/);
  assert.match(html, /<dt>Pending invitations<\/dt><dd>2 pending — no access is granted until acceptance\.<\/dd>/);
  assert.match(html, /data-access-participant-summary/);
  assert.match(html, /<details data-access-invitations>/);
  assert.match(html, /<summary>Manage invitations<\/summary>/);
  assert.match(html, /<details data-access-participants>/);
  assert.match(html, /<summary>Manage participants<\/summary>/);
  assert.match(html, /autocomplete="off"/);
  assert.doesNotMatch(html, /type="search"|<datalist/i);
});

test("global invitation inbox omits outgoing lifecycle even if unsafe input contains it", () => {
  const incoming = {
    ...SNAPSHOT.invitations[0],
    mindId: "mind_external",
    mindName: "External Mind",
    mindRoute: "/external-mind",
  };
  const outgoing = {
    ...SNAPSHOT.invitations[2],
    mindId: "mind_research",
    mindName: "Research Notes",
    mindRoute: "/research-notes",
  };
  const html = renderInvitationsMembership({
    displayName: "Andrey",
    collection: { kind: "global_ready", invitations: [incoming, outgoing] },
  });

  assert.match(html, /Incoming invitations/);
  assert.match(html, /External Mind/);
  assert.doesNotMatch(html, /Sent invitations|invite_outgoing_pending|Pending Candidate/);
});

test("incoming and outgoing invitation states expose only valid lifecycle actions", () => {
  const html = renderInvitationsMembership(model());

  assert.equal((html.match(/data-invitation-action="accept"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-invitation-action="reject"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-invitation-action="cancel"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-invitation-action="reissue"/gu) ?? []).length, 1);

  const expiredIncoming = element(
    html,
    'data-invitation-card="invite_incoming_expired"',
    "article",
  );
  assert.match(expiredIncoming, />Expired</);
  assert.doesNotMatch(expiredIncoming, /data-invitation-action/);

  const pendingOutgoing = element(
    html,
    'data-invitation-card="invite_outgoing_pending"',
    "article",
  );
  assert.match(pendingOutgoing, /Cancel invitation/);
  assert.doesNotMatch(pendingOutgoing, />Accept<|>Reject</);
});

test("Admin cannot manage Admin or Owner while Owner can manage active Admin", () => {
  const ownerHtml = renderInvitationsMembership(model());
  const ownerAdminCard = element(
    ownerHtml,
    'data-member-card="member_admin"',
    "article",
  );
  assert.match(ownerAdminCard, /data-member-role-form/);
  assert.match(ownerAdminCard, /value="admin" selected/);
  assert.match(ownerAdminCard, /data-revoke-member/);

  const adminHtml = renderInvitationsMembership(model(replaceActor("admin")));
  const adminAdminCard = element(
    adminHtml,
    'data-member-card="member_admin"',
    "article",
  );
  const adminOwnerCard = element(
    adminHtml,
    'data-member-card="member_owner"',
    "article",
  );
  const adminEditorCard = element(
    adminHtml,
    'data-member-card="member_editor"',
    "article",
  );

  assert.match(adminAdminCard, /data-member-controls-disabled/);
  assert.match(adminOwnerCard, /data-member-controls-disabled/);
  assert.doesNotMatch(adminAdminCard + adminOwnerCard, /data-revoke-member|data-member-role-form/);
  assert.match(adminEditorCard, /data-member-role-form/);
  assert.doesNotMatch(adminEditorCard, /value="admin"|value="owner"/);
});

test("ownership transfer lists active participants only and confirms source becomes Admin", () => {
  const html = renderInvitationsMembership(model());
  const transfer = element(html, "data-transfer-form");

  assert.match(transfer, /value="member_admin"/);
  assert.match(transfer, /value="member_editor"/);
  assert.doesNotMatch(
    transfer,
    /member_owner|member_revoked|invite_outgoing_pending|Pending Candidate/,
  );
  assert.match(html, /Pending invitations cannot receive ownership/);
  assert.match(transfer, /data-source-membership-version="3"/);
  assert.match(transfer, /value="member_editor" data-membership-version="5" data-display-name="Eva Editor"/);
  assert.match(transfer, /data-transfer-target-name/);
  assert.match(transfer, /sole Owner immediately/);
  assert.match(transfer, /Both changes happen together or neither happens/);
  assert.match(transfer, /name="confirm_source_admin" type="checkbox" required/);
  assert.match(transfer, /I separately confirm the selected participant becomes sole Owner and I become Admin immediately/);
  assert.match(implementation, /confirmation: "transfer-ownership"/);
  assert.match(implementation, /expectedSourceMembershipVersion: sourceMembershipVersion/);
  assert.match(implementation, /expectedTargetMembershipVersion: targetMembershipVersion/);
});

test("leave and unauthorized controls are fail-closed for the current role", () => {
  const ownerHtml = renderInvitationsMembership(model());
  assert.match(ownerHtml, /Owner cannot leave/);
  assert.doesNotMatch(ownerHtml, /data-leave-mind/);

  const editorHtml = renderInvitationsMembership(model(replaceActor("editor")));
  assert.match(editorHtml, /data-leave-mind/);
  assert.match(editorHtml, /Re-entry requires a new accepted invitation/);
  assert.doesNotMatch(editorHtml, /data-member-role-form|data-revoke-member/);
});

test("conflict and expiry paths always reload authoritative state before exposing controls", () => {
  assert.match(implementation, /const runMutation = async/);
  assert.match(implementation, /const refreshed = await loadAuthoritativeState\(\)/);
  assert.match(implementation, /No access controls are shown until current server state can be loaded/);
  assert.match(implementation, /The latest state is shown/);
  assert.match(implementation, /Current state was reloaded and unavailable controls are disabled/);
  assert.doesNotMatch(
    implementation,
    /localStorage|sessionStorage|dataLayer|sendBeacon|console\./,
  );
});

test("server text is escaped and document accepts only a safe local fixture client", () => {
  const malicious = `<img src=x onerror="globalThis.pwned=1">`;
  const html = renderInvitationsMembership({
    displayName: malicious,
    announcement: malicious,
    collection: {
      kind: "ready",
      snapshot: {
        ...SNAPSHOT,
        mind: { ...SNAPSHOT.mind, name: malicious, route: `javascript:pwned()` },
        members: [
          {
            ...SNAPSHOT.members[1],
            memberId: `member\" onmouseover=\"globalThis.pwned=2`,
            displayName: `<svg onload="globalThis.pwned=3">`,
          },
        ],
        invitations: [
          {
            ...SNAPSHOT.invitations[0],
            counterpartyDisplayName: `<script>globalThis.pwned=4</script>`,
          },
        ],
      },
    },
  });

  assert.doesNotMatch(html, /<(?:script|svg|img)\b[^>]*(?:onerror|onload|pwned)/i);
  assert.doesNotMatch(html, /\son(?:error|load|mouseover)\s*=\s*["']/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /&lt;svg onload=&quot;globalThis\.pwned=3&quot;&gt;/);

  const safe = renderInvitationsMembershipDocument(
    model(),
    "/fixture/invitations-membership-client.mjs",
  );
  const unsafe = renderInvitationsMembershipDocument(
    model(),
    `javascript:globalThis.pwned=5`,
  );
  assert.match(safe, /src="\/fixture\/invitations-membership-client\.mjs"/);
  assert.doesNotMatch(unsafe, /javascript:|globalThis\.pwned/);
});

test("loading, unavailable, and error states never expose stale management actions", () => {
  const loading = renderInvitationsMembership({
    displayName: "Andrey",
    collection: { kind: "loading" },
  });
  const unavailable = renderInvitationsMembership({
    displayName: "Andrey",
    collection: { kind: "unavailable", message: "You left this Mind." },
  });
  const error = renderInvitationsMembership({
    displayName: "Andrey",
    collection: { kind: "error", message: "Reload failed." },
  });

  assert.match(loading, /aria-busy="true"/);
  assert.match(unavailable, /data-access-unavailable/);
  assert.match(error, /data-people-retry/);
  assert.doesNotMatch(
    loading + unavailable + error,
    /data-invitation-form|data-member-role-form|data-transfer-form|data-revoke-member/,
  );
});
