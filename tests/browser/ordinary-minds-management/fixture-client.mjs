import { installOrdinaryMindsManagement } from "/ui/ordinary-minds-management.js";

class FixtureFailure extends Error {
  constructor(code) {
    super("Synthetic control-plane failure");
    this.code = code;
  }
}

let minds = [
  {
    isPersonal: true,
    mindId: "mind_fixture_personal",
    route: "/me",
    name: "Fixture User",
    headRevisionId: "revision_fixture_personal",
    visibility: "private",
    role: "owner",
    updatedLabel: "Current HEAD is ready",
  },
  {
    mindId: "mind_fixture_owner",
    handle: "research-notes",
    name: "Research Notes",
    description: "Research decisions and supporting notes.",
    headRevisionId: "revision_fixture_owner",
    visibility: "private",
    role: "owner",
    metadataVersion: 7,
    updatedLabel: "Updated at fixture time",
  },
  {
    mindId: "mind_fixture_member",
    handle: "shared-library",
    name: "Shared Library",
    description: null,
    headRevisionId: "revision_fixture_member",
    visibility: "unlisted",
    role: "editor",
    metadataVersion: 4,
    updatedLabel: "Updated at fixture time",
  },
];

const cloneMind = (mind) => ({ ...mind });
const calls = [];
globalThis.__ordinaryMindsCalls = calls;
document.documentElement.dataset.fixtureClientReady = "true";

const record = (operation, command = null) => {
  calls.push({ operation, command: command === null ? null : { ...command } });
  document.documentElement.dataset.fixtureLastOperation = operation;
};

const adapter = {
  async listMinds() {
    record("listMinds");
    return minds.map(cloneMind);
  },
  async getMind(handle) {
    record("getMind", { handle });
    const mind = minds.find((candidate) => candidate.isPersonal !== true && candidate.handle === handle);
    if (!mind) throw new FixtureFailure("mind_not_found");
    return cloneMind(mind);
  },
  async createMind(command) {
    record("createMind", command);
    if (command.handle === "unavailable-mind") {
      throw new FixtureFailure("handle_unavailable");
    }
    const created = {
      mindId: `mind_fixture_${command.handle}`,
      handle: command.handle,
      name: command.name,
      description: command.description ?? null,
      headRevisionId: "revision_fixture_created",
      visibility: "private",
      role: "owner",
      metadataVersion: 1,
      updatedLabel: "Created at fixture time",
    };
    const personal = minds.filter((mind) => mind.isPersonal === true);
    minds = [...personal, created, ...minds.filter((mind) => mind.isPersonal !== true && mind.handle !== command.handle)];
    return cloneMind(created);
  },
  async renameMind(command) {
    record("renameMind", command);
    const index = minds.findIndex((mind) => mind.handle === command.handle);
    if (index < 0) throw new FixtureFailure("mind_not_found");
    const current = minds[index];
    if (command.name === "Conflicting name") {
      minds[index] = {
        ...current,
        name: "Changed in another session",
        metadataVersion: current.metadataVersion + 1,
      };
      throw new FixtureFailure("metadata_conflict");
    }
    if (command.expectedMetadataVersion !== current.metadataVersion) {
      throw new FixtureFailure("metadata_conflict");
    }
    const renamed = {
      ...current,
      name: command.name,
      description: command.description,
      metadataVersion: current.metadataVersion + 1,
      updatedLabel: "Renamed at fixture time",
    };
    minds[index] = renamed;
    return cloneMind(renamed);
  },
  async getDeletionImpact(handle) {
    record("getDeletionImpact", { handle });
    const mind = minds.find((candidate) => candidate.handle === handle);
    if (!mind || mind.role !== "owner") throw new FixtureFailure("forbidden");
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      impactId: "impact_fixture_owner_0001",
      expiresAt: "2026-08-07T12:45:00.000Z",
      mind: { route: `/${handle}`, name: mind.name },
      revisionCount: 12,
      membershipCount: 3,
      pendingInvitationCount: 2,
      backgroundJobCount: 1,
      exportJobCount: 1,
      irreversible: true,
      recoveryAvailable: false,
      forensicReceiptRetained: false,
      confirmation: `delete-mind:${handle}`,
    };
  },
  async deleteMind(command) {
    record("deleteMind", command);
    if (
      command.impactId !== "impact_fixture_owner_0001" ||
      command.confirmation !== `delete-mind:${command.handle}`
    ) {
      throw new FixtureFailure("deletion_impact_changed");
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    minds = minds.filter((mind) => mind.handle !== command.handle);
    return { replayed: false };
  },
};

let sequence = 0;
installOrdinaryMindsManagement(adapter, document, {
  idempotencyKey() {
    sequence += 1;
    return `fixture-key-${String(sequence).padStart(4, "0")}`;
  },
});
