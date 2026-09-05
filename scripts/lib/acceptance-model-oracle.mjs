import assert from "node:assert/strict";

// Fetch takes an opaque locator, not a Mind argument. Bind that locator to an
// earlier successful scoped discovery; never infer a source from corpus text.
export function verifyModelTrace(events, scenario) {
  const locators = new Map(), selectors = new Map(), calls = [];
  const registerEntries = (value, mind) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.entry_id === "string") locators.set(value.entry_id, mind);
    if (typeof value.resource_uri === "string") locators.set(value.resource_uri, mind);
    if (typeof value.continuation_id === "string") locators.set(value.continuation_id, mind);
    for (const nested of Object.values(value)) if (nested && typeof nested === "object") registerEntries(nested, mind);
  };
  for (const event of events) {
    assert.equal(["commandExecution", "fileChange", "webSearch", "collabAgentToolCall"].includes(event.params?.item?.type), false, "unexpected_builtin_tool");
    if (event.method !== "acceptance/tool") continue;
    const call = event.params, data = call.result.structuredContent?.data;
    if (call.tool === "list_minds" && !call.result.isError) for (const mind of data.minds) {
      selectors.set(mind.route, mind.route);
      if (mind.mind_id) selectors.set(mind.mind_id, mind.route);
    }
    let mind = selectors.get(call.arguments.mind) ?? call.arguments.mind ?? null;
    if (call.tool === "fetch") mind = locators.get(call.arguments.id) ?? null;
    if (["search", "browse_entries", "get_revision", "get_mind_info", "commit_changeset"].includes(call.tool) && mind && !call.result.isError) registerEntries(data, mind);
    if (call.tool === "fetch" && mind && !call.result.isError) registerEntries(data, mind);
    calls.push({ ...call, resolvedMind: mind });
  }
  assert.equal(calls.some(c => ["get_personal_mind_configuration", "set_personal_mind_description"].includes(c.tool)), false, "unsolicited_configuration");
  const reads = calls.filter(c => ["search", "fetch", "browse_entries"].includes(c.tool));
  const scopedReads = calls.filter(c => ["get_mind_info", "search", "fetch", "browse_entries", "list_revisions", "get_revision", "validate_mind"].includes(c.tool));
  const attempts = calls.filter(c => c.tool === "commit_changeset");
  const commits = [...attempts];
  for (const uncertain of attempts.filter(c => c.result.structuredContent?.error?.code === "transport_outcome_unknown")) {
    const reconciled = calls.slice(calls.indexOf(uncertain) + 1).find(c => c.tool === "reconcile_changeset");
    assert.ok(reconciled, "unknown_commit_not_reconciled");
    assert.deepEqual(reconciled.arguments, uncertain.arguments, "unknown_commit_payload_changed");
    assert.equal(reconciled.result.structuredContent?.data?.status, "committed", "unknown_commit_not_confirmed");
    const retriedBeforeReconcile = calls.slice(calls.indexOf(uncertain) + 1, calls.indexOf(reconciled)).some(c => c.tool === "commit_changeset");
    assert.equal(retriedBeforeReconcile, false, "unknown_commit_blind_retry");
    commits.push(reconciled);
  }
  if (scenario.unknownCommit) assert.equal(attempts.some(c => c.result.structuredContent?.error?.code === "transport_outcome_unknown"), true, "unknown_commit_injection_missing");
  for (const read of scopedReads) assert.equal(scenario.reads.includes(read.resolvedMind), true, "unexpected_read_source");
  for (const mind of scenario.requiredReads) assert.equal(reads.some(c => c.resolvedMind === mind && !c.result.isError), true, "required_read_missing");
  for (const write of commits) assert.equal(scenario.writes.includes(write.resolvedMind), true, "unexpected_write_destination");
  for (const mind of scenario.requiredWrites ?? scenario.writes) assert.equal(commits.some(c => c.resolvedMind === mind && !c.result.isError), true, "required_commit_missing");
  if (scenario.partialCommit) {
    assert.equal(typeof scenario.failedWrite, "string", "partial_failure_destination_missing");
    assert.equal(commits.some(c => c.resolvedMind === scenario.failedWrite && c.result.isError), true, "partial_failure_missing");
    assert.equal(commits.some(c => c.resolvedMind === scenario.failedWrite && !c.result.isError), false, "partial_failed_destination_committed");
  }
  for (const commit of commits.filter(c => !c.result.isError)) {
    const revision = commit.result.structuredContent?.data?.revision?.revision_id;
    assert.equal(typeof revision, "string", "commit_revision_missing");
    assert.equal(calls.some(c => c.tool === "validate_mind" && c.resolvedMind === commit.resolvedMind &&
      c.result.structuredContent?.data?.valid === true && c.result.structuredContent.data.resolved_revision?.revision_id === revision), true, "committed_revision_validation_missing");
    assert.equal(calls.some(c => c.tool === "fetch" && c.resolvedMind === commit.resolvedMind &&
      c.result.structuredContent?.data?.entry?.revision_id === revision), true, "committed_content_readback_missing");
  }
  return calls.map(c => ({ tool: c.tool, mind: c.resolvedMind, error: c.result.isError === true }));
}
