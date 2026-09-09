// One scoped acceptance journey; deliberately not a full model-suite receipt.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { AcceptanceModelServer } from "./lib/acceptance-model-server.mjs";

const [tag, identityFile, plugin] = process.argv.slice(2);
assert.match(tag ?? "", /^[a-zA-Z0-9_-]{1,80}$/);
const root = join(homedir(), ".codex/private/mind-diary-acceptance");
assert.ok(plugin?.startsWith(join(homedir(), ".codex/plugins/cache/")));
const identity = JSON.parse(await readFile(identityFile, "utf8"));
const skill = await readFile(join(plugin, "skills/mind-diary/SKILL.md"), "utf8");
const hash = createHash("sha256");
async function hashPackage(path) {
  for (const e of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    assert.equal(e.isSymbolicLink(), false);
    const file = join(path, e.name);
    if (e.isDirectory()) await hashPackage(file);
    else if (e.isFile()) hash.update(relative(plugin, file) + "\0").update(await readFile(file)).update("\0");
  }
}
await hashPackage(plugin);
const client = await new AcceptanceClient({ directory: join(root, "runs", tag),
  platformToken: JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token,
  controllerKey: await readFile(join(root, "controller-key"), "utf8") }).open();
assert.equal(client.state.phase, "prepared", "fresh_journey_required");
const build = await (await client.request("/_acceptance/build")).json();
for (const key of ["candidate_sha", "common_modules_sha256", "test_adapter_sha256"]) assert.equal(build[key], identity[key]);
const baseline = await client.control("/_acceptance/inventory");
assert.equal(baseline.complete, true);
assert.equal(baseline.principals, 0);
const receipt = { schema: "mind-diary/scoped-file-journey/v1", status: "pending", identity,
  runner_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  package_sha256: hash.digest("hex"), client: execFileSync("/opt/homebrew/bin/codex", ["--version"], { encoding: "utf8" }).trim(),
  transport: "existing-acceptance-dynamic-tools", native_oauth_install_proven: false, calls: [] };
let server;
try {
  console.log(JSON.stringify({ phase: "fixture" }));
  const fixture = await createCollaborationFixture(client);
  const token = client.state.operations["token:owner"].result.data.secret;
  const mind = `/${fixture.handle}`;
  const before = (await client.mcp(token, "list_minds")).minds.find(m => m.route === mind).head.revision_id;
  const catalog = (await client.mcpEnvelope(token, "tools/list")).result.tools;
  const allowed = ["list_minds", "list_files", "grep_files", "read_files"];
  for (const name of allowed) assert.ok(catalog.some(t => t.name === name));
  receipt.catalog_sha256 = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
  const directory = join(client.directory, "journey"); await mkdir(directory, { mode: 0o700 });
  // Token accounting is cumulative across calls and includes the installed skill
  // and tool schemas on each turn; four reads can exceed 30k without long output.
  server = new AcceptanceModelServer({ directory, maxTokens: 100000, maxCalls: 6,
    onTrace: event => appendFile(join(directory, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 }),
    onTool: async (name, args) => {
      assert.ok(allowed.includes(name));
      const result = (await client.mcpEnvelope(token, "tools/call", { name, arguments: args })).result;
      assert.equal(result?.isError, false);
      assert.equal(result.structuredContent.ok, true);
      const data = result.structuredContent.data;
      if (name !== "list_minds") {
        assert.equal(data.resolved_revision.revision_id, before);
        assert.equal(data.incomplete, false);
      }
      if (name === "read_files") assert.ok(data.items.some(i => i.file?.text === "---\ntype: Reference\n---\n\nSynthetic acceptance decision version two.\n"));
      receipt.calls.push(name);
      return result;
    } });
  await server.start();
  await server.thread({ model: "gpt-6-astra", skill,
    tools: catalog.filter(t => allowed.includes(t.name)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  console.log(JSON.stringify({ phase: "fresh_file_journey" }));
  await server.turn(`Read only the synthetic ordinary Mind ${mind}, not My Mind. First list_minds. Then use list_files with prefix concepts/; grep_files over exactly those returned paths for literal 'Synthetic acceptance decision'; then read_files whole on the matched path. Report the current decision. Do not write. Use the same exact revision throughout.`);
  assert.deepEqual(receipt.calls, allowed);
  const after = (await client.mcp(token, "list_minds")).minds.find(m => m.route === mind).head.revision_id;
  assert.equal(after, before);
  receipt.head_unchanged = true;
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.failure = error.name;
  if (["model_token_budget_exceeded", "model_tool_budget_exceeded", "model_turn_failed", "model_event_timeout"].includes(error.message)) receipt.failure_code = error.message;
  receipt.usage = server?.usage;
  process.exitCode = 1;
} finally {
  server?.close();
  try {
    await client.cleanup();
    assert.deepEqual(await client.control("/_acceptance/inventory"), baseline);
    receipt.cleanup = "baseline_restored";
  } catch {
    receipt.cleanup = "pending"; receipt.status = "failed"; process.exitCode = 1;
  }
  await writeFile(join(client.directory, "file-journey.json"), JSON.stringify(receipt), { mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, calls: receipt.calls, cleanup: receipt.cleanup }));
}
