import { installInvitationsMembership } from "/ui/invitations-membership.js";

const scenario = new URL(globalThis.location.href).searchParams.get("scenario") ?? "ready";
let conflictInjected = false;
let reissueSequence = 0;
let unavailable = false;
let snapshot = {
  mind: {
    mindId: "mind_browser_fixture",
    name: "Browser Fixture Mind",
    route: "/browser-fixture",
    metadataVersion: 7,
  },
  actor: {
    memberId: "member_owner",
    role: "owner",
    membershipVersion: 3,
  },
  members: [
    {
      memberId: "member_owner",
      displayName: "Andrey",
      role: "owner",
      state: "active",
      membershipVersion: 3,
      isSelf: true,
    },
    {
      memberId: "member_admin",
      displayName: `<svg onload="globalThis.__mindDiaryInjected=true">Alex Admin`,
      role: "admin",
      state: "active",
      membershipVersion: 4,
      isSelf: false,
    },
    {
      memberId: "member_editor",
      displayName: "Eva Editor",
      role: "editor",
      state: "active",
      membershipVersion: 5,
      isSelf: false,
    },
  ],
  invitations: [
    {
      invitationId: scenario === "conflict" ? "invite_conflict" : "invite_incoming",
      direction: "incoming",
      counterpartyDisplayName: "Ada Owner",
      proposedRole: "editor",
      state: "pending",
      expiresAt: "2026-08-12T12:00:00.000Z",
      invitationVersion: 1,
    },
    {
      invitationId: "invite_outgoing",
      direction: "outgoing",
      counterpartyDisplayName: "Pending participant",
      proposedRole: "reader",
      state: "pending",
      expiresAt: "2026-08-12T12:00:00.000Z",
      invitationVersion: 1,
    },
    {
      invitationId: "invite_expired",
      direction: "outgoing",
      counterpartyDisplayName: "Expired participant",
      proposedRole: "editor",
      state: "expired",
      expiresAt: "2026-08-06T12:00:00.000Z",
      invitationVersion: 2,
    },
  ],
};

const clone = (value) => structuredClone(value);
const delay = () => new Promise((resolve) => setTimeout(resolve, 60));
const failure = (code, message) => Object.assign(new Error(message), { code });

function invitation(command) {
  return snapshot.invitations.find(
    (item) => item.invitationId === command.invitationId,
  );
}

function requireInvitation(command) {
  const current = invitation(command);
  if (!current) throw failure("invitation_conflict", "Invitation changed.");
  if (current.invitationVersion !== command.expectedInvitationVersion) {
    throw failure("invitation_conflict", "Invitation version changed.");
  }
  return current;
}

const adapter = {
  async loadPage() {
    await delay();
    if (unavailable) {
      return { kind: "unavailable", message: "You no longer participate in this Mind." };
    }
    return { kind: "ready", snapshot: clone(snapshot) };
  },

  async createInvitation(command) {
    await delay();
    if (command.expectedMetadataVersion !== snapshot.mind.metadataVersion) {
      throw failure("metadata_conflict", "Mind metadata changed.");
    }
    const allowed = snapshot.actor.role === "owner"
      ? ["reader", "editor", "admin"]
      : snapshot.actor.role === "admin"
        ? ["reader", "editor"]
        : [];
    if (!allowed.includes(command.role)) throw failure("forbidden", "Role is not allowed.");
    snapshot.invitations.unshift({
      invitationId: `invite_created_${snapshot.invitations.length}`,
      direction: "outgoing",
      counterpartyDisplayName: "Registered participant",
      proposedRole: command.role,
      state: "pending",
      expiresAt: "2026-08-14T12:00:00.000Z",
      invitationVersion: 1,
    });
    snapshot.mind.metadataVersion += 1;
  },

  async acceptInvitation(command) {
    await delay();
    const current = requireInvitation(command);
    if (scenario === "conflict" && !conflictInjected) {
      conflictInjected = true;
      current.state = "expired";
      current.invitationVersion += 1;
      current.expiresAt = "2026-08-06T12:00:00.000Z";
      throw failure("invitation_expired", "Invitation expired during acceptance.");
    }
    if (current.state !== "pending") throw failure("invitation_expired", "Invitation expired.");
    current.state = "accepted";
    current.invitationVersion += 1;
  },

  async rejectInvitation(command) {
    await delay();
    const current = requireInvitation(command);
    if (current.state !== "pending") throw failure("invitation_conflict", "Invitation changed.");
    current.state = "rejected";
    current.invitationVersion += 1;
  },

  async cancelInvitation(command) {
    await delay();
    const current = requireInvitation(command);
    if (current.state !== "pending") throw failure("invitation_conflict", "Invitation changed.");
    current.state = "cancelled";
    current.invitationVersion += 1;
  },

  async reissueInvitation(command) {
    await delay();
    const current = requireInvitation(command);
    if (current.state !== "expired" && current.state !== "cancelled") {
      throw failure("invitation_conflict", "Invitation is not reissuable.");
    }
    reissueSequence += 1;
    current.invitationId = `invite_reissued_${reissueSequence}`;
    current.state = "pending";
    current.invitationVersion = 1;
    current.expiresAt = "2026-08-14T12:00:00.000Z";
  },

  async changeMemberRole(command) {
    await delay();
    const member = snapshot.members.find((item) => item.memberId === command.memberId);
    if (!member || member.state !== "active") throw failure("membership_not_found", "Membership changed.");
    if (member.membershipVersion !== command.expectedMembershipVersion) {
      throw failure("membership_version_conflict", "Membership changed.");
    }
    member.role = command.role;
    member.membershipVersion += 1;
  },

  async revokeMember(command) {
    await delay();
    const member = snapshot.members.find((item) => item.memberId === command.memberId);
    if (!member || member.membershipVersion !== command.expectedMembershipVersion) {
      throw failure("membership_state_changed", "Membership changed.");
    }
    member.state = "revoked";
    member.membershipVersion += 1;
  },

  async leaveMind(command) {
    await delay();
    if (snapshot.actor.role === "owner") throw failure("owner_membership_protected", "Owner cannot leave.");
    if (snapshot.actor.membershipVersion !== command.expectedMembershipVersion) {
      throw failure("membership_version_conflict", "Membership changed.");
    }
    unavailable = true;
  },

  async transferOwnership(command) {
    await delay();
    if (command.confirmation !== "transfer-ownership") throw failure("forbidden", "Confirmation is required.");
    if (command.expectedMetadataVersion !== snapshot.mind.metadataVersion) {
      throw failure("metadata_conflict", "Mind metadata changed.");
    }
    const source = snapshot.members.find((item) => item.memberId === snapshot.actor.memberId);
    const target = snapshot.members.find((item) => item.memberId === command.targetMemberId);
    if (!source || !target || target.state !== "active" || target.role === "owner") {
      throw failure("ownership_target_invalid", "Target is not active.");
    }
    if (
      source.membershipVersion !== command.expectedSourceMembershipVersion ||
      target.membershipVersion !== command.expectedTargetMembershipVersion
    ) {
      throw failure("ownership_state_changed", "Ownership memberships changed.");
    }
    if (scenario === "ownership-conflict" && !conflictInjected) {
      conflictInjected = true;
      target.state = "revoked";
      target.membershipVersion += 1;
      throw failure("ownership_state_changed", "Target was revoked during transfer.");
    }
    source.role = "admin";
    source.membershipVersion += 1;
    target.role = "owner";
    target.membershipVersion += 1;
    snapshot.actor.role = "admin";
    snapshot.actor.membershipVersion = source.membershipVersion;
    snapshot.mind.metadataVersion += 1;
  },
};

let keySequence = 0;
installInvitationsMembership(adapter, document, {
  createIdempotencyKey: () => `browser-fixture-key-${++keySequence}`,
});
