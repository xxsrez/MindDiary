import { installAccountDeletionUi } from "/ui/account-deletion.js";

const scenario = new URL(window.location.href).searchParams.get("scenario") ?? "success";
const fixtureState = {
  scenario,
  previewCalls: 0,
  deletionCalls: 0,
  sessionEndCalls: 0,
  commands: [],
  sessionEnded: false,
};
globalThis.__mindDiaryAccountDeletionFixture = fixtureState;

function syncFixtureEvidence() {
  document.documentElement.dataset.fixturePreviewCalls = String(fixtureState.previewCalls);
  document.documentElement.dataset.fixtureDeletionCalls = String(fixtureState.deletionCalls);
  document.documentElement.dataset.fixtureSessionEndCalls = String(fixtureState.sessionEndCalls);
  document.documentElement.dataset.fixtureSessionEnded = String(fixtureState.sessionEnded);
  const command = fixtureState.commands.at(-1);
  document.documentElement.dataset.fixtureImpactId = command?.impactId ?? "none";
  document.documentElement.dataset.fixtureConfirmation = command?.confirmation ?? "none";
  document.documentElement.dataset.fixtureIdempotencyKey = command?.idempotencyKey ?? "none";
}
syncFixtureEvidence();

function fixtureImpact() {
  return {
    impactId: `impact_browser_fixture_${fixtureState.previewCalls}`,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    personalMind: {
      route: "/me",
      name: `<svg onload="globalThis.__mindDiaryInjected=true">Fixture Personal Mind`,
    },
    ownedMinds: [
      {
        route: "/shared-research",
        name: `<img src=x onerror="globalThis.__mindDiaryInjected=true">Shared Research`,
      },
      { route: "/family-library", name: "Family Library" },
    ],
    foreignMembershipCount: 2,
    pendingInvitationCount: 1,
    activeMcpTokenCount: 3,
    irreversible: true,
    recoveryAvailable: false,
    forensicReceiptRetained: false,
    confirmation: "delete-account",
    privateContent: "PRIVATE FIXTURE BODY MUST NEVER ENTER THE DOM",
    verifiedEmail: "private-fixture@example.com",
  };
}

function successResult(replayed = false) {
  return {
    replayed,
    spacesDeleted: 3,
    tokensRevoked: 3,
    canonicalObjectsDeleted: 5,
    canonicalObjectsRetained: 0,
    indexedRevisionsDeleted: 5,
    deliveredAuditEventsDeleted: 4,
    deliveredAuditActorsTombstoned: 2,
    exportArchivesDeleted: 1,
  };
}

const adapter = {
  async getAccountDeletionImpact() {
    fixtureState.previewCalls += 1;
    syncFixtureEvidence();
    if (scenario === "load-denied") {
      throw Object.assign(new Error("Synthetic denied preview"), {
        code: "authentication_required",
      });
    }
    return fixtureImpact();
  },
  async deleteAccount(command) {
    fixtureState.deletionCalls += 1;
    fixtureState.commands.push({ ...command });
    syncFixtureEvidence();
    if (
      (scenario === "changed" || scenario === "changed-then-success") &&
      fixtureState.deletionCalls === 1
    ) {
      throw Object.assign(new Error("Synthetic changed preview"), {
        code: "deletion_impact_changed",
      });
    }
    if (
      (scenario === "expired" || scenario === "expired-then-success") &&
      fixtureState.deletionCalls === 1
    ) {
      throw Object.assign(new Error("Synthetic expired preview"), {
        code: "deletion_impact_expired",
      });
    }
    if (scenario === "denied") {
      throw Object.assign(new Error("Synthetic deletion denial"), {
        code: "authentication_required",
      });
    }
    if (scenario === "cleanup-retry" && fixtureState.deletionCalls === 1) {
      throw Object.assign(new Error("Synthetic incomplete cleanup"), {
        code: "deletion_cleanup_incomplete",
      });
    }
    if (scenario === "failure" && fixtureState.deletionCalls === 1) {
      throw new Error("Synthetic transport failure");
    }
    return successResult(fixtureState.deletionCalls > 1);
  },
  async endSessionAfterDeletion() {
    fixtureState.sessionEndCalls += 1;
    syncFixtureEvidence();
    if (scenario === "session-retry" && fixtureState.sessionEndCalls === 1) {
      throw new Error("Synthetic sign-out failure");
    }
    fixtureState.sessionEnded = true;
    syncFixtureEvidence();
  },
};

installAccountDeletionUi(adapter, document, {
  createIdempotencyKey: () => "account-delete-browser-fixture-0001",
});
