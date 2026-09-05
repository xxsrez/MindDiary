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
    if (event.method !== "acceptance/tool") continue;
    const call = event.params, data = call.result.structuredContent?.data;
    if (call.tool === "list_minds" && !call.result.isError) for (const mind of data.minds) {
      selectors.set(mind.route, mind.route);
      if (mind.mind_id) selectors.set(mind.mind_id, mind.route);
    }
    let mind = selectors.get(call.arguments.mind) ?? call.arguments.mind ?? null;
    if (call.tool === "fetch") mind = locators.get(call.arguments.id) ?? null;
    if (["search", "browse_entries"].includes(call.tool) && !call.result.isError) registerEntries(data, mind);
    if (call.tool === "fetch" && mind && !call.result.isError) registerEntries(data, mind);
    calls.push({ ...call, resolvedMind: mind });
  }
  assert.equal(calls.some(c => ["get_personal_mind_configuration", "set_personal_mind_description"].includes(c.tool)), false, "unsolicited_configuration");
  const reads = calls.filter(c => ["search", "fetch", "browse_entries"].includes(c.tool));
  const scopedReads = calls.filter(c => ["get_mind_info", "search", "fetch", "browse_entries", "list_revisions", "get_revision", "validate_mind"].includes(c.tool));
  const commits = calls.filter(c => c.tool === "commit_changeset");
  for (const read of scopedReads) assert.equal(scenario.reads.includes(read.resolvedMind), true, "unexpected_read_source");
  for (const mind of scenario.requiredReads) assert.equal(reads.some(c => c.resolvedMind === mind && !c.result.isError), true, "required_read_missing");
  for (const write of commits) assert.equal(scenario.writes.includes(write.resolvedMind), true, "unexpected_write_destination");
  for (const mind of scenario.writes) assert.equal(commits.some(c => c.resolvedMind === mind && !c.result.isError), true, "required_commit_missing");
  return calls.map(c => ({ tool: c.tool, mind: c.resolvedMind, error: c.result.isError === true }));
}
