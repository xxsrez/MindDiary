import { installVisibilityCatalogUi } from "/ui/visibility-catalog.js";

const calls = [];
const failure = new URL(globalThis.location.href).searchParams.get("failure");
let failedOnce = false;
const catalogMinds = [
  {
    mindId: "mind_fixture_public_retry",
    route: "/published-research",
    name: "Recovered Public Research",
    summary: "A synthetic catalog result loaded by the retry control.",
    visibility: "public",
    isPersonal: false,
    discovery: "public_catalog",
  },
];

let metadataVersion = Number(
  document.querySelector("[data-visibility-form]")?.dataset.metadataVersion ?? "7",
);

const adapter = {
  async changeVisibility(command) {
    calls.push({ ...command });
    document.documentElement.dataset.fixtureRequestKeys = calls
      .map((call) => call.idempotencyKey)
      .join(",");
    if (failure === "conflict" && !failedOnce) {
      failedOnce = true;
      throw Object.assign(new Error("Synthetic metadata conflict."), {
        code: "metadata_conflict",
      });
    }
    if (failure === "transient" && !failedOnce) {
      failedOnce = true;
      throw new Error("Synthetic transient failure; retry the exact request.");
    }
    if (failure === "forbidden") {
      throw Object.assign(new Error("Synthetic Owner access loss."), {
        code: "forbidden",
      });
    }
    metadataVersion += 1;
    return {
      mindId: command.mindId,
      visibility: command.visibility,
      metadataVersion,
      changed: true,
      replayed: false,
    };
  },
  async listPublicMinds() {
    return catalogMinds.map((mind) => ({ ...mind }));
  },
};

globalThis.__visibilityCatalogFixture = { calls };
globalThis.__mindDiaryInjected = false;

installVisibilityCatalogUi(adapter, document, {
  nextIdempotencyKey: () => `visibility-fixture-${calls.length + 1}`,
});
