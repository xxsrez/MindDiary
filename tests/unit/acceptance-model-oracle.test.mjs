import test from "node:test";
import assert from "node:assert/strict";
import { verifyModelTrace } from "../../scripts/lib/acceptance-model-oracle.mjs";
const call = (tool, args, data) => ({ method: "acceptance/tool", params: { tool, arguments: args, result: { isError: false, structuredContent: { data } } } });
const scenario = { reads: ["/shared"], requiredReads: ["/shared"], writes: [] };
const prefix = [call("list_minds", {}, { minds: [{ route: "/shared" }, { route: "/me" }] }), call("search", { mind: "/shared" }, { results: [{ entry: { entry_id: "opaque-entry" } }] })];
test("opaque fetch is bound to the preceding exact scoped search", () => {
  const trace = verifyModelTrace([...prefix, call("fetch", { id: "opaque-entry" }, { entry: { entry_id: "opaque-entry" } })], scenario);
  assert.equal(trace.at(-1).mind, "/shared");
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
});
