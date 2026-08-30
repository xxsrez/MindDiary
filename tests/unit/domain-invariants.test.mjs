import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainInvariantError,
  PersonalMindDirectory,
  PrincipalAccount,
  SpaceAggregate,
  capabilitiesForRole,
  normalizeOrdinaryMindDescription,
  normalizeTokenScopes,
  roleHasCapability,
  version,
} from "@mind-diary/domain";

const now = "2026-08-06T12:00:00.000Z";
const later = "2026-08-06T12:01:00.000Z";
const ownerId = "principal_owner";
const editorId = "principal_editor";
const outsiderId = "principal_outsider";
const spaceId = "space_ordinary";
const revisionId = "revision_initial";

function space(overrides = {}) {
  return {
    spaceId,
    spaceHandle: "research-notes",
    normalizedHandle: "research-notes",
    name: "Research Notes",
    visibility: "private",
    state: "active",
    metadataVersion: version(1),
    accessVersion: version(1),
    headRevisionId: revisionId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function membership(principalId, role, overrides = {}) {
  return {
    membershipId: `membership_${principalId}_${role}`,
    spaceId,
    principalId,
    role,
    state: "active",
    version: version(1),
    createdAt: now,
    createdBy: ownerId,
    updatedAt: now,
    updatedBy: ownerId,
    ...overrides,
  };
}

function invitation(targetPrincipalId, overrides = {}) {
  return {
    invitationId: `invitation_${targetPrincipalId}`,
    spaceId,
    targetPrincipalId,
    proposedRole: "editor",
    state: "pending",
    expiresAt: "2026-08-13T12:00:00.000Z",
    version: version(1),
    createdAt: now,
    createdBy: ownerId,
    updatedAt: now,
    updatedBy: ownerId,
    ...overrides,
  };
}

function ordinary(overrides = {}) {
  return SpaceAggregate.restoreOrdinary({
    space: overrides.space ?? space(),
    memberships: overrides.memberships ?? [
      membership(ownerId, "owner"),
      membership(editorId, "editor"),
    ],
    invitations: overrides.invitations ?? [],
  });
}

function expectDomainError(code, operation) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof DomainInvariantError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("role policy exposes named capabilities and write scope always includes read", () => {
  assert.deepEqual(capabilitiesForRole("reader"), [
    "content:browse",
    "content:search",
    "content:fetch",
    "content:history",
    "content:validate",
    "content:export",
  ]);
  assert.equal(roleHasCapability("editor", "content:write"), true);
  assert.equal(roleHasCapability("admin", "members:manage-admin"), false);
  assert.equal(roleHasCapability("owner", "space:delete"), true);
  assert.deepEqual(normalizeTokenScopes(["content:write"]), [
    "content:read",
    "content:write",
  ]);
  assert.throws(() => normalizeTokenScopes([]), /must include/);
});

test("active ordinary Mind restores only with exactly one Owner", () => {
  expectDomainError("ordinary_owner_count", () =>
    ordinary({ memberships: [membership(editorId, "editor")] }),
  );
  expectDomainError("ordinary_owner_count", () =>
    ordinary({
      memberships: [
        membership(ownerId, "owner"),
        membership(editorId, "owner"),
      ],
    }),
  );

  const aggregate = ordinary();
  assert.equal(aggregate.snapshot().space.description, null);
  assert.equal(
    aggregate.snapshot().memberships.filter((item) => item.role === "owner").length,
    1,
  );
  assert.equal(Object.isFrozen(aggregate.snapshot().memberships), true);
  expectDomainError("invalid_record", () =>
    ordinary({
      memberships: [
        membership(ownerId, "owner"),
        membership(editorId, "root"),
      ],
    }),
  );
});

test("ordinary description normalization is canonical and bounded by Unicode code points", () => {
  assert.deepEqual(
    normalizeOrdinaryMindDescription("  Ａ\r\nsecond line  "),
    { kind: "valid", value: "A\nsecond line" },
  );
  assert.deepEqual(normalizeOrdinaryMindDescription("\t\n"), {
    kind: "valid",
    value: null,
  });
  assert.deepEqual(normalizeOrdinaryMindDescription("😀".repeat(500)), {
    kind: "valid",
    value: "😀".repeat(500),
  });
  assert.deepEqual(normalizeOrdinaryMindDescription("😀".repeat(501)), {
    kind: "invalid",
  });
  for (const invalid of ["bad\0value", "bad\u000bvalue", "bad\u0085value", "\ud800"]) {
    assert.deepEqual(normalizeOrdinaryMindDescription(invalid), { kind: "invalid" });
  }

  expectDomainError("invalid_record", () => ordinary({
    space: space({ description: " not canonical " }),
  }));
});

test("active membership and pending invitation uniqueness is enforced per Mind/principal", () => {
  expectDomainError("duplicate_active_membership", () =>
    ordinary({
      memberships: [
        membership(ownerId, "owner"),
        membership(editorId, "editor"),
        membership(editorId, "reader", { membershipId: "membership_duplicate" }),
      ],
    }),
  );

  const first = invitation(outsiderId);
  expectDomainError("duplicate_pending_invitation", () =>
    ordinary({
      invitations: [
        first,
        invitation(outsiderId, { invitationId: "invitation_duplicate" }),
      ],
    }),
  );
  expectDomainError("pending_invitation_for_active_member", () =>
    ordinary({ invitations: [invitation(editorId)] }),
  );

  const withHistoricalRecords = ordinary({
    memberships: [
      membership(ownerId, "owner"),
      membership(editorId, "editor"),
      membership(editorId, "reader", {
        membershipId: "membership_revoked",
        state: "revoked",
      }),
    ],
    invitations: [
      invitation(outsiderId),
      invitation(outsiderId, {
        invitationId: "invitation_rejected",
        state: "rejected",
      }),
    ],
  });
  assert.equal(withHistoricalRecords.snapshot().memberships.length, 3);
});

test("adding an invitation enforces role policy and advances only Mind metadata", () => {
  const aggregate = ordinary();
  const updated = aggregate.addInvitation({
    actorPrincipalId: ownerId,
    invitation: invitation(outsiderId),
    expectedMetadataVersion: version(1),
    occurredAt: later,
  });

  assert.equal(aggregate.snapshot().space.metadataVersion, 1);
  assert.equal(updated.snapshot().space.metadataVersion, 2);
  assert.equal(updated.snapshot().space.accessVersion, 1);
  assert.equal(updated.snapshot().space.updatedAt, later);
  assert.equal(updated.snapshot().invitations.length, 1);
  expectDomainError("stale_version", () =>
    updated.addInvitation({
      actorPrincipalId: ownerId,
      invitation: invitation("principal_second_outsider"),
      expectedMetadataVersion: version(1),
      occurredAt: later,
    }),
  );
  expectDomainError("settings_permission_required", () =>
    aggregate.addInvitation({
      actorPrincipalId: editorId,
      invitation: invitation(outsiderId),
      expectedMetadataVersion: version(1),
      occurredAt: later,
    }),
  );

  const withAdmin = ordinary({
    memberships: [
      membership(ownerId, "owner"),
      membership(editorId, "admin"),
    ],
  });
  assert.equal(
    withAdmin.addInvitation({
      actorPrincipalId: editorId,
      invitation: invitation(outsiderId, { proposedRole: "reader" }),
      expectedMetadataVersion: version(1),
      occurredAt: later,
    }).snapshot().space.metadataVersion,
    2,
  );
  expectDomainError("settings_permission_required", () =>
    withAdmin.addInvitation({
      actorPrincipalId: editorId,
      invitation: invitation(outsiderId, { proposedRole: "admin" }),
      expectedMetadataVersion: version(1),
      occurredAt: later,
    }),
  );
});

test("Personal Mind uses the ordinary space schema but is private and sole-owned", () => {
  const personalSpaceId = "space_personal";
  const personalSpace = space({
    spaceId: personalSpaceId,
    spaceHandle: "service-managed-personal",
    normalizedHandle: "service-managed-personal",
    name: "Fixture Owner",
  });
  const binding = {
    principalId: ownerId,
    spaceId: personalSpaceId,
    version: version(1),
    createdAt: now,
  };
  const owner = membership(ownerId, "owner", {
    membershipId: "membership_personal_owner",
    spaceId: personalSpaceId,
  });
  const personal = SpaceAggregate.restorePersonal({
    space: personalSpace,
    binding,
    membership: owner,
  });

  assert.equal(personal.snapshot().kind, "personal");
  assert.equal(personal.snapshot().space.description, null);
  assert.equal(
    SpaceAggregate.restorePersonal({
      space: { ...personalSpace, description: "Personal decisions" },
      binding,
      membership: owner,
    }).snapshot().space.description,
    "Personal decisions",
  );
  expectDomainError("personal_description", () =>
    SpaceAggregate.restorePersonal({
      space: { ...personalSpace, description: "  not normalized  " },
      binding,
      membership: owner,
    }),
  );
  expectDomainError("personal_visibility", () =>
    SpaceAggregate.restorePersonal({
      space: { ...personalSpace, visibility: "public" },
      binding,
      membership: owner,
    }),
  );
  expectDomainError("personal_membership", () =>
    SpaceAggregate.restorePersonal({
      space: personalSpace,
      binding,
      membership: { ...owner, principalId: editorId },
    }),
  );
  expectDomainError("personal_visibility", () =>
    personal.changeVisibility({
      actorPrincipalId: ownerId,
      visibility: "unlisted",
      expectedMetadataVersion: version(1),
      occurredAt: later,
    }),
  );

  const directory = PersonalMindDirectory.restore([binding]);
  assert.equal(directory.forPrincipal(ownerId)?.spaceId, personalSpaceId);
  expectDomainError("duplicate_personal_binding", () =>
    directory.bind({ ...binding, spaceId: "another_personal_space" }),
  );

  const account = PrincipalAccount.restore({
    principal: {
      principalId: ownerId,
      displayName: "Fixture Owner",
      state: "active",
      profileVersion: version(1),
      createdAt: now,
      updatedAt: now,
    },
    externalBindings: [
      {
        bindingId: "binding_sites",
        principalId: ownerId,
        provider: "sites",
        normalizedBinding: "sensitive-fixture-binding",
        state: "active",
        version: version(1),
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    personalMind: personal,
  });
  assert.equal(account.snapshot().personalMind.personalBinding.principalId, ownerId);
  expectDomainError("personal_profile_mismatch", () =>
    PrincipalAccount.restore({
      principal: {
        ...account.snapshot().principal,
        displayName: "Split Brain Profile",
      },
      externalBindings: account.snapshot().externalBindings,
      personalMind: personal,
    }),
  );
});

test("ownership transfer is atomic and stale/retry attempts cannot create two Owners", () => {
  const initial = ordinary();
  const transferred = initial.transferOwnership({
    sourcePrincipalId: ownerId,
    targetPrincipalId: editorId,
    expectedMetadataVersion: version(1),
    expectedSourceMembershipVersion: version(1),
    expectedTargetMembershipVersion: version(1),
    occurredAt: later,
  });
  const roles = Object.fromEntries(
    transferred
      .snapshot()
      .memberships.map((item) => [item.principalId, item.role]),
  );
  assert.deepEqual(roles, { [ownerId]: "admin", [editorId]: "owner" });
  assert.equal(transferred.snapshot().space.metadataVersion, 2);
  assert.equal(initial.snapshot().space.metadataVersion, 1);

  expectDomainError("stale_version", () =>
    transferred.transferOwnership({
      sourcePrincipalId: editorId,
      targetPrincipalId: ownerId,
      expectedMetadataVersion: version(1),
      expectedSourceMembershipVersion: version(1),
      expectedTargetMembershipVersion: version(1),
      occurredAt: later,
    }),
  );
  assert.equal(
    transferred.snapshot().memberships.filter((item) => item.role === "owner").length,
    1,
  );
});

test("ownership transfer resolves active memberships after revoked history", () => {
  const sourceRevoked = membership(ownerId, "reader", {
    membershipId: "membership_owner_revoked_history",
    state: "revoked",
  });
  const targetRevoked = membership(editorId, "reader", {
    membershipId: "membership_editor_revoked_history",
    state: "revoked",
  });
  const sourceActive = membership(ownerId, "owner", {
    membershipId: "membership_owner_active",
  });
  const targetActive = membership(editorId, "editor", {
    membershipId: "membership_editor_active",
  });
  const initial = ordinary({
    memberships: [sourceRevoked, targetRevoked, sourceActive, targetActive],
  });

  const transferred = initial.transferOwnership({
    sourcePrincipalId: ownerId,
    targetPrincipalId: editorId,
    expectedMetadataVersion: version(1),
    expectedSourceMembershipVersion: version(1),
    expectedTargetMembershipVersion: version(1),
    occurredAt: later,
  });
  const active = transferred
    .snapshot()
    .memberships.filter((item) => item.state === "active");
  assert.deepEqual(
    active.map((item) => [item.principalId, item.role]),
    [
      [ownerId, "admin"],
      [editorId, "owner"],
    ],
  );
  assert.equal(
    transferred.snapshot().memberships.find(
      (item) => item.membershipId === sourceRevoked.membershipId,
    ).role,
    "reader",
  );
  assert.equal(
    transferred.snapshot().memberships.find(
      (item) => item.membershipId === targetRevoked.membershipId,
    ).role,
    "reader",
  );
});

test("client-supplied identity cannot substitute for current aggregate role", () => {
  const initial = ordinary();
  expectDomainError("owner_required", () =>
    initial.changeVisibility({
      actorPrincipalId: outsiderId,
      visibility: "public",
      expectedMetadataVersion: version(1),
      occurredAt: later,
    }),
  );
  assert.equal(initial.snapshot().space.visibility, "private");

  const changed = initial.changeVisibility({
    actorPrincipalId: ownerId,
    visibility: "public",
    expectedMetadataVersion: version(1),
    occurredAt: later,
  });
  assert.equal(changed.snapshot().space.visibility, "public");
  assert.equal(initial.snapshot().space.visibility, "private");
});

test("visibility change resolves the active Owner after revoked history", () => {
  const initial = ordinary({
    memberships: [
      membership(ownerId, "reader", {
        membershipId: "membership_owner_revoked_history",
        state: "revoked",
      }),
      membership(ownerId, "owner", {
        membershipId: "membership_owner_active",
      }),
      membership(editorId, "editor"),
    ],
  });

  const changed = initial.changeVisibility({
    actorPrincipalId: ownerId,
    visibility: "unlisted",
    expectedMetadataVersion: version(1),
    occurredAt: later,
  });
  assert.equal(changed.snapshot().space.visibility, "unlisted");
  assert.equal(initial.snapshot().space.visibility, "private");
});

test("invitation acceptance is all-or-nothing across duplicate, expiry and race cases", () => {
  const pending = ordinary({ invitations: [invitation(outsiderId)] });
  const newMembership = membership(outsiderId, "editor", {
    membershipId: "membership_outsider",
  });
  const accepted = pending.acceptInvitation({
    invitationId: `invitation_${outsiderId}`,
    targetPrincipalId: outsiderId,
    expectedInvitationVersion: version(1),
    membership: newMembership,
    occurredAt: later,
  });
  assert.equal(
    accepted.snapshot().invitations.find((item) => item.targetPrincipalId === outsiderId)
      ?.state,
    "accepted",
  );
  assert.equal(
    accepted.snapshot().memberships.filter((item) => item.principalId === outsiderId)
      .length,
    1,
  );
  expectDomainError("invitation_not_pending", () =>
    accepted.acceptInvitation({
      invitationId: `invitation_${outsiderId}`,
      targetPrincipalId: outsiderId,
      expectedInvitationVersion: version(1),
      membership: newMembership,
      occurredAt: later,
    }),
  );
  assert.equal(pending.snapshot().memberships.length, 2);

  const expired = ordinary({
    invitations: [
      invitation(outsiderId, { expiresAt: "2026-08-06T12:00:30.000Z" }),
    ],
  });
  expectDomainError("invitation_expired", () =>
    expired.acceptInvitation({
      invitationId: `invitation_${outsiderId}`,
      targetPrincipalId: outsiderId,
      expectedInvitationVersion: version(1),
      membership: newMembership,
      occurredAt: later,
    }),
  );
  assert.equal(expired.snapshot().invitations[0].state, "pending");
  assert.equal(expired.snapshot().memberships.length, 2);
});

test("runtime constructors reject invalid version and empty opaque ID values", async () => {
  const domain = await import("@mind-diary/domain");
  assert.throws(() => version(0), /positive safe integers/);
  assert.throws(() => domain.opaqueId(""), /must not be empty/);
  assert.equal(domain.opaqueId("principal_fixture"), "principal_fixture");
});
