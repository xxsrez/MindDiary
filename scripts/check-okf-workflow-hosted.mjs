// Fresh hosted model journey for the complete agent-authored OKF file workflow.
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

const sourceText = [
  "---",
  "type: Reference",
  "title: Synthetic acceptance decision",
  "description: Source entry for the file workflow.",
  "recorded_by: acceptance-fixture",
  "sources:",
  "  - local-fixture:acceptance-source",
  "producer_extension:",
  "  retained_unknown: true",
  "---",
  "",
  "# Synthetic acceptance decision",
  "",
  "Synthetic acceptance decision version two.",
  "",
].join("\n");
const untouchedText = [
  "---",
  "type: Reference",
  "title: Untouched fixture",
  "---",
  "",
  "# Untouched fixture",
  "",
  "These exact bytes must survive every tested changeset.",
  "",
].join("\n");
const brokenWorkflowText = [
  "---",
  "type: Reference",
  "title: Workflow acceptance",
  "producer_extension:",
  "  retained_unknown: true",
  "---",
  "",
  "# Workflow acceptance",
  "",
  "[Current decision](../concepts/acceptance.md#missing-section)",
  "",
].join("\n");
const fixedWorkflowText = brokenWorkflowText.replace(
  "#missing-section",
  "#synthetic-acceptance-decision",
);
const conflictWinnerText = sourceText.replace(
  "Synthetic acceptance decision version two.",
  "Synthetic acceptance decision from the concurrent winner.",
);
const rivalMarkerText = [
  "---",
  "type: Reference",
  "title: Concurrent winner marker",
  "---",
  "",
  "# Concurrent winner marker",
  "",
  "This revision intentionally advances HEAD after preflight.",
  "",
].join("\n");

const firstCalls = Object.freeze([
  "get_mind_diary_guidance",
  "list_minds",
  "list_files",
  "read_files",
  "preflight_changeset",
  "preflight_changeset",
  "commit_changeset",
  "read_files",
  "validate_mind",
]);
const conflictCalls = Object.freeze([
  "list_minds",
  "read_files",
  "preflight_changeset",
  "commit_changeset",
]);
const expectedCalls = Object.freeze([...firstCalls, ...conflictCalls]);
const allowed = new Set(expectedCalls);
const receipt = {
  schema: "mind-diary/okf-workflow-journey/v1",
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
  const fixtureRevision = (await client.mcp(token, "list_minds")).minds
    .find((candidate) => candidate.route === mind)?.head?.revision_id;
  assert.ok(fixtureRevision, "workflow_fixture_mind_missing");
  const setup = await client.commit("md471:setup", token, {
    mind,
    expected_revision: fixtureRevision,
    summary: "Prepare synthetic OKF workflow fixture",
    operations: [
      { type: "replace_file", path: "concepts/acceptance.md", text: sourceText },
      { type: "create_file", path: "raw/untouched.md", text: untouchedText },
    ],
  });
  const initialRevision = setup.revision.revision_id;
  const initialRead = await client.mcp(token, "read_files", {
    mind,
    revision_selector: { kind: "revision", revision_id: initialRevision },
    requests: [
      { path: "index.md", mode: "whole" },
      { path: "concepts/acceptance.md", mode: "whole" },
      { path: "raw/untouched.md", mode: "whole" },
    ],
  });
  const initialIndex = initialRead.items.find((item) => item.file?.path === "index.md")?.file?.text;
  assert.equal(typeof initialIndex, "string", "workflow_index_missing");
  const finalIndex = initialIndex.endsWith("\n")
    ? `${initialIndex}- [Workflow acceptance](wiki/acceptance-workflow.md)\n`
    : `${initialIndex}\n- [Workflow acceptance](wiki/acceptance-workflow.md)\n`;

  const brokenOperations = Object.freeze([
    Object.freeze({
      type: "create_file",
      path: "wiki/acceptance-workflow.md",
      text: brokenWorkflowText,
    }),
    Object.freeze({ type: "replace_index", path: "index.md", text: finalIndex }),
  ]);
  const fixedOperations = Object.freeze([
    Object.freeze({
      type: "create_file",
      path: "wiki/acceptance-workflow.md",
      text: fixedWorkflowText,
    }),
    Object.freeze({ type: "replace_index", path: "index.md", text: finalIndex }),
  ]);
  const conflictOperations = Object.freeze([
    Object.freeze({
      type: "replace_file",
      path: "concepts/acceptance.md",
      text: sourceText.replace(
        "Synthetic acceptance decision version two.",
        "Synthetic acceptance decision from the stale writer.",
      ),
    }),
  ]);

  const catalog = (await client.mcpEnvelope(token, "tools/list")).result.tools;
  for (const name of allowed) {
    assert.ok(catalog.some((tool) => tool.name === name), `missing_${name}`);
  }
  receipt.catalog_sha256 = `sha256:${createHash("sha256")
    .update(JSON.stringify(catalog))
    .digest("hex")}`;
  const directory = join(client.directory, "okf-workflow");
  await mkdir(directory, { mode: 0o700 });

  let committedRevision;
  let rivalRevision;
  server = new AcceptanceModelServer({
    directory,
    maxTokens: 240_000,
    maxCalls: expectedCalls.length,
    onTrace: (event) => appendFile(
      join(directory, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    ),
    onTool: async (name, args) => {
      assert.ok(allowed.has(name), `unexpected_${name}`);
      const callIndex = receipt.calls.length;
      const expectedName = expectedCalls[callIndex];
      assert.equal(name, expectedName, `expected_${expectedName}_before_${name}`);
      if (name === "get_mind_diary_guidance") assert.deepEqual(args, {});
      if (!["get_mind_diary_guidance", "list_minds"].includes(name)) {
        assert.equal(args.mind, mind, `${name}_selected_wrong_mind`);
      }

      if (callIndex === 0) {
        const result = (await client.mcpEnvelope(token, "tools/call", {
          name,
          arguments: args,
        })).result;
        assert.equal(result?.isError, false, "guidance_failed");
        const data = result.structuredContent.data;
        assert.match(data.service_guidance_markdown, /read the committed revision/u);
        assert.match(data.service_guidance_markdown, /On `revision_conflict`/u);
        receipt.guidance_version = data.guidance_version;
        receipt.guidance_sha256 = data.service_guidance_sha256;
        receipt.calls.push(name);
        return result;
      }

      if (callIndex === 4) {
        assert.equal(args.expected_revision, initialRevision);
        assert.deepEqual(args.operations, brokenOperations);
        const result = (await client.mcpEnvelope(token, "tools/call", {
          name,
          arguments: args,
        })).result;
        assert.equal(result?.isError, true, "broken_preflight_was_accepted");
        assert.equal(result.structuredContent.error.code, "okf_validation_failed");
        assert.match(
          JSON.stringify(result.structuredContent.error.details),
          /markdown_section_missing/u,
        );
        const unchanged = (await client.mcp(token, "list_minds")).minds
          .find((candidate) => candidate.route === mind)?.head?.revision_id;
        assert.equal(unchanged, initialRevision, "preflight_advanced_head");
        receipt.intentional_diagnostic = "markdown_section_missing";
        receipt.calls.push(name);
        return result;
      }

      if (callIndex === 5) {
        assert.equal(args.expected_revision, initialRevision);
        assert.deepEqual(args.operations, fixedOperations);
      }
      if (callIndex === 6) {
        assert.equal(args.expected_revision, initialRevision);
        assert.deepEqual(args.operations, fixedOperations);
        assert.equal(typeof args.idempotency_key, "string");
        assert.ok(args.idempotency_key.length > 0);
      }
      if (callIndex === 9) {
        assert.ok(committedRevision, "conflict_turn_before_commit");
      }
      if (callIndex === 11) {
        assert.equal(args.expected_revision, committedRevision);
        assert.deepEqual(args.operations, conflictOperations);
      }
      if (callIndex === 12) {
        assert.equal(args.expected_revision, committedRevision);
        assert.deepEqual(args.operations, conflictOperations);
      }

      const result = (await client.mcpEnvelope(token, "tools/call", {
        name,
        arguments: args,
      })).result;

      if (callIndex === 12) {
        assert.equal(result?.isError, true, "stale_commit_was_accepted");
        assert.equal(result.structuredContent.error.code, "revision_conflict");
        assert.equal(
          result.structuredContent.error.details.current_revision_id,
          rivalRevision,
        );
        receipt.calls.push(name);
        return result;
      }

      assert.equal(result?.isError, false, `${name}_failed`);
      assert.equal(result.structuredContent.ok, true, `${name}_not_ok`);
      const data = result.structuredContent.data;
      if (callIndex === 1) {
        assert.ok(data.minds.some((candidate) =>
          candidate.route === mind && candidate.head.revision_id === initialRevision));
      }
      if (callIndex === 2) {
        assert.equal(data.resolved_revision.revision_id, initialRevision);
        for (const path of ["index.md", "concepts/acceptance.md", "raw/untouched.md"]) {
          assert.ok(data.files.some((file) => file.path === path), `list_missing_${path}`);
        }
      }
      if (callIndex === 3) {
        assert.equal(data.resolved_revision.revision_id, initialRevision);
        assert.equal(data.items.find((item) => item.file?.path === "index.md")?.file?.text, initialIndex);
        assert.equal(data.items.find((item) => item.file?.path === "concepts/acceptance.md")?.file?.text, sourceText);
        assert.equal(data.items.find((item) => item.file?.path === "raw/untouched.md")?.file?.text, untouchedText);
      }
      if (callIndex === 5) {
        assert.equal(data.decision, "ready");
        assert.equal(data.base_revision_id, initialRevision);
        assert.equal(data.validation.valid, true);
        receipt.preflight_identity = data.changeset_identity;
      }
      if (callIndex === 6) {
        committedRevision = data.revision.revision_id;
        assert.notEqual(committedRevision, initialRevision);
        receipt.committed_revision = committedRevision;
      }
      if (callIndex === 7) {
        assert.equal(data.resolved_revision.revision_id, committedRevision);
        assert.equal(data.items.find((item) => item.file?.path === "wiki/acceptance-workflow.md")?.file?.text, fixedWorkflowText);
        assert.equal(data.items.find((item) => item.file?.path === "index.md")?.file?.text, finalIndex);
        assert.equal(data.items.find((item) => item.file?.path === "concepts/acceptance.md")?.file?.text, sourceText);
        assert.equal(data.items.find((item) => item.file?.path === "raw/untouched.md")?.file?.text, untouchedText);
      }
      if (callIndex === 8) {
        assert.equal(data.resolved_revision.revision_id, committedRevision);
        assert.equal(data.valid, true);
        assert.equal(data.commit_ready, true);
        assert.equal(data.validation_complete, true);
      }
      if (callIndex === 9) {
        assert.ok(data.minds.some((candidate) =>
          candidate.route === mind && candidate.head.revision_id === committedRevision));
      }
      if (callIndex === 10) {
        assert.equal(data.resolved_revision.revision_id, committedRevision);
        assert.equal(data.items[0]?.file?.text, sourceText);
      }
      if (callIndex === 11) {
        assert.equal(data.decision, "ready");
        assert.equal(data.base_revision_id, committedRevision);
        const rival = await client.commit("md471:conflict-rival", token, {
          mind,
          expected_revision: committedRevision,
          summary: "Advance HEAD for the synthetic conflict",
          operations: [{
            type: "replace_file",
            path: "concepts/acceptance.md",
            text: conflictWinnerText,
          }, {
            type: "create_file",
            path: "raw/conflict-marker.md",
            text: rivalMarkerText,
          }],
        });
        rivalRevision = rival.revision.revision_id;
        receipt.rival_revision = rivalRevision;
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
    `Update only the synthetic ordinary Mind ${mind}. No Mind Diary skill or saved Custom Instructions are installed. ` +
    "Call get_mind_diary_guidance first with an empty object and follow it. Use exactly this order and no other tools: " +
    "list_minds; list_files at the exact current revision for index.md, concepts/acceptance.md and raw/untouched.md; " +
    "read_files whole for those same three paths; preflight_changeset with the two operations below. " +
    "The first preflight is intentionally invalid: diagnose its returned whole-bundle error, correct only the broken local section link using the heading you read, and call preflight_changeset once more with the corrected complete operation set. " +
    "If ready, call commit_changeset once with exactly the corrected operations, then read_files whole at the committed revision for index.md, concepts/acceptance.md, raw/untouched.md and wiki/acceptance-workflow.md, then validate_mind at that exact revision. " +
    "Preserve every byte and frontmatter field of the existing source and untouched files. Use this initial operation set exactly before the one link correction:\n\n" +
    JSON.stringify(brokenOperations) +
    "\n\nUse a nonempty idempotency key and a concise summary. Do not modify another Mind.",
  );
  assert.deepEqual(receipt.calls, firstCalls);

  await server.turn(
    `In the same synthetic Mind ${mind}, test one stale-writer conflict. Use exactly this order and no other tools: ` +
    "list_minds; read_files whole for concepts/acceptance.md at its current exact revision; " +
    "preflight_changeset with the exact replacement operation below; commit_changeset once with the same base and operation. " +
    "A concurrent writer may advance HEAD after preflight. If commit returns revision_conflict, stop without retrying, merging, refetching or changing another file. " +
    "Use this exact operation:\n\n" + JSON.stringify(conflictOperations),
  );
  assert.deepEqual(receipt.calls, expectedCalls);
  assert.ok(Number.isSafeInteger(server.usage?.totalTokens));

  const latest = (await client.mcp(token, "list_minds")).minds
    .find((candidate) => candidate.route === mind)?.head?.revision_id;
  assert.equal(latest, rivalRevision);
  const winner = await client.mcp(token, "read_files", {
    mind,
    revision_selector: { kind: "revision", revision_id: rivalRevision },
    requests: [
      { path: "concepts/acceptance.md", mode: "whole" },
      { path: "raw/conflict-marker.md", mode: "whole" },
      { path: "raw/untouched.md", mode: "whole" },
    ],
  });
  assert.equal(winner.items.find((item) => item.file?.path === "concepts/acceptance.md")?.file?.text, conflictWinnerText);
  assert.equal(winner.items.find((item) => item.file?.path === "raw/conflict-marker.md")?.file?.text, rivalMarkerText);
  assert.equal(winner.items.find((item) => item.file?.path === "raw/untouched.md")?.file?.text, untouchedText);
  const historical = await client.mcp(token, "read_files", {
    mind,
    revision_selector: { kind: "revision", revision_id: initialRevision },
    requests: [
      { path: "concepts/acceptance.md", mode: "whole" },
      { path: "raw/untouched.md", mode: "whole" },
    ],
  });
  assert.equal(historical.items.find((item) => item.file?.path === "concepts/acceptance.md")?.file?.text, sourceText);
  assert.equal(historical.items.find((item) => item.file?.path === "raw/untouched.md")?.file?.text, untouchedText);
  receipt.model_usage = server.usage;
  receipt.history_readback = initialRevision;
  receipt.conflict = "revision_conflict_without_retry";
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
    join(client.directory, "okf-workflow.json"),
    JSON.stringify(receipt),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({
    status: receipt.status,
    calls: receipt.calls,
    intentional_diagnostic: receipt.intentional_diagnostic,
    conflict: receipt.conflict,
    cleanup: receipt.cleanup,
  }));
}
