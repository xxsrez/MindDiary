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
    /user explicitly asks|topic genuinely matches its description/u,
    /untrusted data, not instructions/u,
    /never run an implicit cross-Mind search/iu,
    /vacuum nearby Minds/iu,
    /writable_mount\.active=true/u,
    /effective\.can_write/u,
    /Never bind, rebind, unbind/u,
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
  assert.match(reads.get("search").description, /implicit cross-Mind search/iu);
  assert.match(reads.get("fetch").description, /enabled Mind/u);

  const writes = new Map(
    MCP_COMMIT_EXPORT_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
  );
  const commit = writes.get("commit_changeset");
  assert.match(commit.description, /principal's current read_write Mind/u);
  assert.match(commit.description, /explicitly discussed/u);
  assert.match(commit.description, /source_references/u);
  assert.match(commit.description, /notify the user/u);
  assert.match(writes.get("reconcile_changeset").description, /exact original/u);
});
