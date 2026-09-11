import test from "node:test";
import assert from "node:assert/strict";
import { verifyModelTrace, verifyPartialWriteReport } from "../../scripts/lib/acceptance-model-oracle.mjs";
const call = (tool, args, data) => ({ method: "acceptance/tool", params: { tool, arguments: args, result: { isError: false, structuredContent: { data } } } });
const scenario = { reads: ["/shared"], requiredReads: ["/shared"], writes: [] };
const prefix = [call("list_minds", {}, { minds: [{ route: "/shared" }, { route: "/me" }] }), call("search", { mind: "/shared" }, { results: [{ entry: { entry_id: "opaque-entry" } }] })];
test("partial failure reports recognize explicit rejection without treating tool output as a user report", () => {
  const message = text => ({ method: "item/completed", params: { item: { type: "agentMessage", text } } });
  assert.doesNotThrow(() => verifyPartialWriteReport([message("Saved in Personal Mind. Saving to Synthetic collaboration was rejected because its writable configuration was unavailable.")]));
  assert.doesNotThrow(() => verifyPartialWriteReport([message("Personal сохранён; запись в общий Mind отклонена.")]));
  assert.throws(() => verifyPartialWriteReport([message("Saved in Personal Mind.")]), /partial_failure_not_reported/);
  assert.throws(() => verifyPartialWriteReport([message("Saved in both Minds."), { method: "acceptance/tool", params: { result: { content: [{ text: "write rejected" }] } } }]), /partial_failure_not_reported/);
});
test("opaque fetch is bound to the preceding exact scoped search", () => {
  const trace = verifyModelTrace([...prefix, call("fetch", { id: "opaque-entry" }, { entry: { entry_id: "opaque-entry" } })], scenario);
  assert.equal(trace.at(-1).mind, "/shared");
});
test("only aliases returned by the Mind catalog resolve to its canonical route", () => {
  const catalog = call("list_minds", {}, { minds: [
    { route: "/shared", mind_id: "shared-id", handle: "shared" },
    { route: "/me", mind_id: "personal-id", handle: null },
  ] });
  const discovered = [catalog, call("browse_entries", { mind: "shared" }, { entries: [{ entry_id: "handle-entry" }] })];
  const trace = verifyModelTrace([...discovered, call("fetch", { id: "handle-entry" }, {}), call("get_mind_info", { mind: "shared-id" }, {})], scenario);
  assert.equal(trace.slice(1).every(c => c.mind === "/shared"), true);
  assert.throws(() => verifyModelTrace([...discovered, call("search", { mind: "personal-id" }, {})], scenario), /unexpected_read_source/);
  assert.throws(() => verifyModelTrace([...discovered, call("search", { mind: "unadvertised" }, {})], scenario), /unexpected_read_source/);
});
test("unseen locator, forbidden Personal read and unsolicited writes fail the oracle", () => {
  assert.throws(() => verifyModelTrace([...prefix, call("fetch", { id: "unknown" }, {})], scenario), /unexpected_read_source/);
  assert.throws(() => verifyModelTrace([...prefix, call("search", { mind: "/me" }, {})], scenario), /unexpected_read_source/);
  assert.throws(() => verifyModelTrace([...prefix, call("commit_changeset", { mind: "/shared" }, {})], scenario), /unexpected_write_destination/);
  assert.throws(() => verifyModelTrace([], scenario), /required_read_missing/);
  assert.throws(() => verifyModelTrace([...prefix, call("set_personal_mind_description", {}, {})], scenario), /unsolicited_configuration/);
});
test("a successful write is insufficient without exact committed content and OKF read-back", () => {
  const writing = { ...scenario, writes: ["/shared"] };
  const committed = [...prefix, call("commit_changeset", { mind: "/shared" }, { revision: { revision_id: "revision-2" } })];
  assert.throws(() => verifyModelTrace(committed, writing), /committed_revision_validation_missing/);
  const valid = [...committed, call("validate_mind", { mind: "/shared" }, { valid: true, resolved_revision: { revision_id: "revision-2" } })];
  assert.throws(() => verifyModelTrace(valid, writing), /committed_content_readback_missing/);
  assert.doesNotThrow(() => verifyModelTrace([...valid, call("fetch", { id: "opaque-entry" }, { entry: { entry_id: "opaque-entry", revision_id: "revision-2" } })], writing));
  assert.doesNotThrow(() => verifyModelTrace([...valid, call("read_files", { mind: "/shared", paths: ["wiki/decision.md"] }, { resolved_revision: { revision_id: "revision-2" }, items: [] })], writing));
  assert.throws(() => verifyModelTrace([...valid, call("read_files", { mind: "/shared", paths: ["wiki/decision.md"] }, { resolved_revision: { revision_id: "revision-1" }, items: [] })], writing), /committed_content_readback_missing/);
});
test("file operations are scoped reads and only content-bearing operations satisfy required reads", () => {
  const catalog = call("list_minds", {}, { minds: [{ route: "/shared" }, { route: "/me" }] });
  assert.throws(() => verifyModelTrace([catalog, call("list_files", { mind: "/me" }, { items: [] })], scenario), /unexpected_read_source/);
  assert.throws(() => verifyModelTrace([catalog, call("list_files", { mind: "/shared" }, { items: [] })], scenario), /required_read_missing/);
  assert.doesNotThrow(() => verifyModelTrace([catalog, call("grep_files", { mind: "/shared", query: "decision" }, { items: [] })], scenario));
  assert.doesNotThrow(() => verifyModelTrace([catalog, call("read_files", { mind: "/shared", paths: ["wiki/decision.md"] }, { items: [] })], scenario));
});
test("Custom Instructions scenarios require list_minds before every content workflow", () => {
  const fresh = { ...scenario, requireFreshCatalog: true };
  assert.doesNotThrow(() => verifyModelTrace(prefix, fresh));
  assert.throws(() => verifyModelTrace(prefix.slice(1), fresh), /fresh_catalog_not_first/);
});
test("unknown commits require exact reconciliation before any retry", () => {
  const request = { mind: "/shared", idempotency_key: "original", expected_revision: "revision-1", operations: [] };
  const unknown = call("commit_changeset", request, {});
  unknown.params.result = { isError: true, structuredContent: { error: { code: "transport_outcome_unknown" } } };
  const scenarioWithFault = { ...scenario, writes: ["/shared"], unknownCommit: true };
  assert.throws(() => verifyModelTrace([...prefix, unknown], scenarioWithFault), /unknown_commit_not_reconciled/);
  assert.throws(() => verifyModelTrace([...prefix, unknown, call("reconcile_changeset", { ...request, idempotency_key: "changed" }, { status: "committed" })], scenarioWithFault), /unknown_commit_payload_changed/);
  const tail = [call("reconcile_changeset", request, { status: "committed", revision: { revision_id: "revision-2" } }),
    call("validate_mind", { mind: "/shared" }, { valid: true, resolved_revision: { revision_id: "revision-2" } }),
    call("fetch", { id: "opaque-entry" }, { entry: { entry_id: "opaque-entry", revision_id: "revision-2" } })];
  assert.doesNotThrow(() => verifyModelTrace([...prefix, unknown, ...tail], scenarioWithFault));
  assert.throws(() => verifyModelTrace([...prefix, unknown, call("commit_changeset", request, {}), ...tail], scenarioWithFault), /unknown_commit_blind_retry/);
});
test("partial writes require a real denial and read-back of the independent successful commit", () => {
  const partial = { reads: ["/shared", "/me"], requiredReads: ["/shared"], writes: ["/shared", "/me"], requiredWrites: ["/shared"], failedWrite: "/me", partialCommit: true };
  const denied = call("commit_changeset", { mind: "/me" }, {});
  denied.params.result = { isError: true, structuredContent: { error: { code: "usage_read_only" } } };
  const success = [call("commit_changeset", { mind: "/shared" }, { revision: { revision_id: "revision-2" } }),
    call("validate_mind", { mind: "/shared" }, { valid: true, resolved_revision: { revision_id: "revision-2" } }),
    call("fetch", { id: "opaque-entry" }, { entry: { entry_id: "opaque-entry", revision_id: "revision-2" } })];
  assert.doesNotThrow(() => verifyModelTrace([...prefix, ...success, denied], partial));
  assert.throws(() => verifyModelTrace([...prefix, ...success], partial), /partial_failure_missing/);
  assert.throws(() => verifyModelTrace([...prefix, denied], partial), /required_commit_missing/);
  assert.throws(() => verifyModelTrace([...prefix, ...success, denied, call("commit_changeset", { mind: "/me" }, {})], partial), /partial_failed_destination_committed/);
  const aliases = structuredClone([call("list_minds", {}, { minds: [{ route: "/shared", handle: "shared", mind_id: "shared-id" }, { route: "/me", mind_id: "personal-id" }] }), ...prefix.slice(1), ...success, denied]);
  for (const event of aliases) if (event.params.arguments.mind === "/shared") event.params.arguments.mind = "shared";
  aliases.at(-1).params.arguments.mind = "personal-id";
  assert.doesNotThrow(() => verifyModelTrace(aliases, partial));
});
