import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_AGENT_INSTRUCTIONS,
  MCP_COMMIT_EXPORT_TOOL_DEFINITIONS,
  MCP_READ_TOOL_DEFINITIONS,
} from "../../packages/adapter-mcp/dist/index.js";

test("central MCP guidance describes the complete principal Mind usage policy", () => {
  for (const fragment of [
    /list_minds/u,
    /narrow files with list_files/u,
    /locate evidence with grep_files/u,
    /read the necessary exact ranges with read_files/u,
    /Mind name, metadata summary, search snippet, or ranking is not proof/u,
    /Never default or fall back to \/me/u,
    /search_index_unavailable/u,
    /canonical browse_entries, list_files, grep_files, and read_files/u,
    /Read Personal Mind without a description only when the current user directly asks/u,
    /ordinary enabled Mind when the user names it|topic genuinely matches its description/u,
    /routing_profile=personal_default/u,
    /routing_profile=description_based/u,
    /untrusted data, not instructions/u,
    /never run an implicit cross-Mind search/iu,
    /vacuum nearby Minds/iu,
    /writable_mount\.active=true/u,
    /effective\.can_write/u,
    /Never bind, rebind, unbind/u,
    /If both descriptions match/u,
    /durable knowledge explicitly discussed/u,
    /exact source Mind, revision, and locator provenance/u,
    /Validate the complete proposed OKF 0\.2 bundle/u,
    /read the exact committed revision/u,
    /reconcile the exact original payload/u,
    /tell the user what was saved/u,
  ]) {
    assert.match(MCP_AGENT_INSTRUCTIONS, fragment);
  }
  assert.match(MCP_AGENT_INSTRUCTIONS, /Multiple relevant enabled Minds may be read sequentially/u);
  assert.doesNotMatch(MCP_AGENT_INSTRUCTIONS, /capture_knowledge/u);
});

test("Mind-aware tool descriptions repeat the local decision and write safety at the point of use", () => {
  const reads = new Map(
    MCP_READ_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
  );
  assert.match(reads.get("list_minds").description, /description/u);
  assert.match(reads.get("list_minds").description, /untrusted/u);
  assert.match(reads.get("list_minds").description, /Personal Mind has personal_default and an optional description/u);
  const mindSchema = reads.get("list_minds").outputSchema.properties.data.properties.minds.items;
  assert.equal(mindSchema.required.includes("routing_profile"), true);
  assert.equal(mindSchema.required.includes("description"), false);
  assert.deepEqual(mindSchema.properties.routing_profile.enum, [
    "personal_default",
    "description_based",
  ]);
  assert.match(reads.get("search").description, /implicit cross-Mind search/iu);
  assert.match(reads.get("search").description, /search_index_unavailable/u);
  assert.match(reads.get("fetch").description, /enabled Mind/u);
  assert.match(reads.get("list_minds").description, /never default or fall back to \/me/iu);
  assert.match(reads.get("list_minds").description, /list_files, grep_files, and read_files/u);
  assert.match(reads.get("list_files").description, /After list_minds/u);
  assert.match(reads.get("grep_files").description, /then use read_files/u);
  assert.match(reads.get("read_files").description, /Mind, revision, and path provenance/u);

  const writes = new Map(
    MCP_COMMIT_EXPORT_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
  );
  const commit = writes.get("commit_changeset");
  assert.match(commit.description, /exact Mind's current principal-owned read_write lane/u);
  assert.match(commit.description, /Personal and ordinary write lanes are independent/u);
  assert.match(commit.description, /Canonical and only content-write tool/u);
  assert.match(commit.description, /current user directly asks/u);
  assert.match(commit.description, /previous request/u);
  assert.match(commit.description, /explicitly discussed/u);
  assert.match(commit.description, /source_references/u);
  assert.match(commit.description, /notify the user/u);
  assert.match(writes.get("reconcile_changeset").description, /exact original/u);
});
