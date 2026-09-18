// One fresh hosted model journey proving the MCP-only guidance path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { AcceptanceModelServer } from "./lib/acceptance-model-server.mjs";

const [tag, identityFile] = process.argv.slice(2);
assert.match(tag ?? "", /^[a-zA-Z0-9_-]{1,80}$/u);
assert.ok(identityFile, "exact_identity_file_required");

const root = join(homedir(), ".codex/private/mind-diary-acceptance");
const identity = JSON.parse(await readFile(identityFile, "utf8"));
const client = await new AcceptanceClient({
  directory: join(root, "runs", tag),
  platformToken: JSON.parse(
    await readFile(join(root, "platform-token.json"), "utf8"),
  ).token,
  controllerKey: await readFile(join(root, "controller-key"), "utf8"),
}).open();
assert.equal(client.state.phase, "prepared", "fresh_journey_required");

const build = await (await client.request("/_acceptance/build")).json();
for (const key of ["candidate_sha", "common_modules_sha256", "test_adapter_sha256"]) {
  assert.equal(build[key], identity[key]);
}
const baseline = await client.control("/_acceptance/inventory");
assert.equal(baseline.complete, true);
assert.equal(baseline.principals, 0);

const expectedText = [
  "---",
  "type: Reference",
  "---",
  "",
  "Synthetic acceptance decision version three after MCP-only guidance.",
  "",
].join("\n");
const expectedCalls = Object.freeze([
  "get_mind_diary_guidance",
  "list_minds",
  "list_files",
  "read_files",
  "preflight_changeset",
  "commit_changeset",
  "read_files",
  "validate_mind",
]);
const allowed = new Set(expectedCalls);
const receipt = {
  schema: "mind-diary/mcp-only-guidance-journey/v1",
  status: "pending",
  identity,
  runner_sha: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  runner_dirty: execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim().length > 0,
  client: execFileSync("/opt/homebrew/bin/codex", ["--version"], {
    encoding: "utf8",
  }).trim(),
  model: "gpt-6-astra",
  instruction_source: "mcp_tool_only",
  calls: [],
};

let server;
try {
  const fixture = await createCollaborationFixture(client);
  const token = client.state.operations["token:owner"].result.data.secret;
  const mind = `/${fixture.handle}`;
  const listedBefore = await client.mcp(token, "list_minds");
  const before = listedBefore.minds.find((candidate) => candidate.route === mind);
  assert.ok(before?.head?.revision_id, "guidance_fixture_mind_missing");
  const beforeRevision = before.head.revision_id;

  const catalog = (await client.mcpEnvelope(token, "tools/list")).result.tools;
  for (const name of allowed) {
    assert.ok(catalog.some((tool) => tool.name === name), `missing_${name}`);
  }
  receipt.catalog_sha256 = `sha256:${createHash("sha256")
    .update(JSON.stringify(catalog))
    .digest("hex")}`;
  const directory = join(client.directory, "mcp-only-guidance");
  await mkdir(directory, { mode: 0o700 });

  let preflightOperations;
  let committedRevision;
  server = new AcceptanceModelServer({
    directory,
    maxTokens: 180_000,
    maxCalls: expectedCalls.length,
    onTrace: (event) => appendFile(
      join(directory, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    ),
    onTool: async (name, args) => {
      assert.ok(allowed.has(name), `unexpected_${name}`);
      const expectedName = expectedCalls[receipt.calls.length];
      assert.equal(name, expectedName, `expected_${expectedName}_before_${name}`);
      if (name === "get_mind_diary_guidance") assert.deepEqual(args, {});
      if (!["get_mind_diary_guidance", "list_minds"].includes(name)) {
        assert.equal(args.mind, mind, `${name}_selected_wrong_mind`);
      }
      const result = (await client.mcpEnvelope(token, "tools/call", {
        name,
        arguments: args,
      })).result;
      assert.equal(result?.isError, false, `${name}_failed`);
      assert.equal(result.structuredContent.ok, true, `${name}_not_ok`);
      const data = result.structuredContent.data;

      if (name === "get_mind_diary_guidance") {
        assert.match(data.guidance_version, /^\d{4}-\d{2}-\d{2}$/u);
        assert.match(data.service_guidance_sha256, /^sha256:[0-9a-f]{64}$/u);
        assert.match(data.service_guidance_markdown, /Start every relevant workflow with `list_minds`/u);
        assert.match(data.service_guidance_markdown, /call `preflight_changeset`/u);
        assert.equal(data.host_specific.applicability, "conditional_on_client_tools");
        receipt.guidance_version = data.guidance_version;
        receipt.guidance_sha256 = data.service_guidance_sha256;
      }
      if (name === "list_minds") {
        assert.ok(data.minds.some((candidate) =>
          candidate.route === mind && candidate.head.revision_id === beforeRevision));
      }
      if (["list_files", "read_files"].includes(name) && committedRevision === undefined) {
        assert.equal(data.resolved_revision.revision_id, beforeRevision);
        if (name === "read_files") {
          assert.ok(data.items.some((item) =>
            item.path === "concepts/acceptance.md" &&
            item.file?.text === "---\ntype: Reference\n---\n\nSynthetic acceptance decision version two.\n"));
        }
      }
      if (name === "preflight_changeset") {
        assert.equal(args.expected_revision, beforeRevision);
        assert.deepEqual(args.operations, [{
          type: "replace_file",
          path: "concepts/acceptance.md",
          text: expectedText,
        }]);
        assert.equal(data.decision, "ready");
        assert.equal(data.base_revision_id, beforeRevision);
        assert.equal(data.validation.valid, true);
        preflightOperations = structuredClone(args.operations);
        receipt.preflight_identity = data.changeset_identity;
      }
      if (name === "commit_changeset") {
        assert.ok(preflightOperations, "commit_before_preflight");
        assert.equal(args.expected_revision, beforeRevision);
        assert.deepEqual(args.operations, preflightOperations);
        committedRevision = data.revision.revision_id;
        assert.notEqual(committedRevision, beforeRevision);
        receipt.committed_revision = committedRevision;
      }
      if (name === "read_files" && committedRevision !== undefined) {
        assert.equal(data.resolved_revision.revision_id, committedRevision);
        assert.ok(data.items.some((item) =>
          item.path === "concepts/acceptance.md" && item.file?.text === expectedText));
      }
      if (name === "validate_mind") {
        assert.equal(data.resolved_revision.revision_id, committedRevision);
        assert.equal(data.valid, true);
        assert.equal(data.commit_ready, true);
        assert.equal(data.validation_complete, true);
      }
      receipt.calls.push(name);
      return result;
    },
  });
  await server.start();
  await server.thread({
    model: receipt.model,
    instructionMode: "mcp-only",
    tools: catalog
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
  });
  await server.turn(
    `Update only the synthetic ordinary Mind ${mind}. You have no Mind Diary skill. ` +
    "First call get_mind_diary_guidance with an empty object, then follow the returned service guide. " +
    "Use this exact order and no other tools: list_minds; list_files for concepts/ at the current exact revision; " +
    "read_files whole for concepts/acceptance.md; preflight_changeset; commit_changeset; " +
    "read_files whole at the committed revision; validate_mind at that same committed revision. " +
    "Replace only concepts/acceptance.md with this exact UTF-8 text, preserving the final newline:\n\n" +
    expectedText +
    "\nUse one idempotency key for the commit and do not modify another Mind.",
  );
  assert.deepEqual(receipt.calls, expectedCalls);
  assert.ok(Number.isSafeInteger(server.usage?.totalTokens));
  receipt.model_usage = server.usage;
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.failure = error.name;
  receipt.failure_code = error.message;
  receipt.model_usage = server?.usage;
  process.exitCode = 1;
} finally {
  server?.close();
  try {
    await client.cleanup();
    assert.deepEqual(await client.control("/_acceptance/inventory"), baseline);
    receipt.cleanup = "baseline_restored";
  } catch {
    receipt.cleanup = "pending";
    receipt.status = "failed";
    process.exitCode = 1;
  }
  await writeFile(
    join(client.directory, "mcp-only-guidance.json"),
    JSON.stringify(receipt),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({
    status: receipt.status,
    calls: receipt.calls,
    guidance_version: receipt.guidance_version,
    cleanup: receipt.cleanup,
  }));
}
