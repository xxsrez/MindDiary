import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { AcceptanceModelServer } from "./lib/acceptance-model-server.mjs";

let phase = "configuration";
process.once("uncaughtException", () => { console.error(JSON.stringify({ status: "failed", phase })); process.exit(1); });
const root = join(homedir(), ".codex/private/mind-diary-acceptance");
const tag = process.argv[2];
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tag ?? "")) throw new Error("exact_run_tag_required");
const expected = process.env.MD_ACCEPTANCE_EXPECTED_SHA;
const plugin = process.env.MD_ACCEPTANCE_PLUGIN_PATH;
if (!/^[a-f0-9]{40}$/.test(expected ?? "") || !plugin?.startsWith(join(homedir(), ".codex/plugins/cache/"))) throw new Error("exact_candidate_and_installed_package_required");
const platformToken = JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token;
const controllerKey = await readFile(join(root, "controller-key"), "utf8");
const client = await new AcceptanceClient({ directory: join(root, "runs", tag), platformToken, controllerKey }).open();
if (client.state.phase === "cleaned") throw new Error("use_new_tag_for_new_model_evaluation");
const build = await (await client.request("/_acceptance/build")).json(); assert.equal(build.candidate_sha, expected);
const skill = await readFile(join(plugin, "skills/mind-diary/SKILL.md"), "utf8");
const packageHasher = createHash("sha256");
async function hashDirectory(path) {
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("package_symlink_not_supported");
    if (entry.isDirectory()) await hashDirectory(file);
    else if (entry.isFile()) packageHasher.update(relative(plugin, file) + "\0").update(await readFile(file)).update("\0");
  }
}
await hashDirectory(plugin);
const receipt = { schema: "mind-diary/acceptance-model/v1", candidate: expected, build,
  runner_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runner_dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  cli: execFileSync("/opt/homebrew/bin/codex", ["--version"], { encoding: "utf8" }).trim(), model: "gpt-6-astra", package_hash: packageHasher.digest("hex"),
  skill_hash: createHash("sha256").update(skill).digest("hex"), cases: [] };
const baseline = await client.control("/_acceptance/inventory"); assert.equal(baseline.complete, true);
let server;
try {
  phase = "fixture";
  const fixture = await createCollaborationFixture(client);
  const token = client.state.operations["token:owner"].result.data.secret;
  const catalog = await client.mcpEnvelope(token, "tools/list");
  assert.ok(catalog.result.tools.length > 5);
  const tools = catalog.result.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  const shared = `/${fixture.handle}`;
  const cases = [
    { id: "null-personal-automatic-read", description: null, prompt: "What does our synthetic acceptance fixture currently say about the engineering decision?", reads: [shared], requiredReads: [shared], writes: [] },
    { id: "described-overlap-read", description: "Synthetic acceptance fixtures and shared engineering decisions. Exclude daily activity logs.", prompt: "What does our synthetic acceptance fixture currently say about the engineering decision?", reads: ["/me", shared], requiredReads: ["/me", shared], writes: [], compact: true },
    { id: "explicit-personal-read", description: null, prompt: "Read only My Mind and tell me what the synthetic acceptance fixture currently says. Do not use other Minds.", reads: ["/me"], requiredReads: ["/me"], writes: [] },
    { id: "no-topic-match", description: "Synthetic acceptance fixtures and engineering decisions; exclude daily activity logs.", prompt: "Give me a short example of a friendly birthday greeting for a fictional person. This is just a wording exercise.", reads: [], requiredReads: [], writes: [] },
  ];
  for (const scenario of cases) {
    phase = scenario.id;
    const config = await client.mcp(token, "get_personal_mind_configuration");
    await client.mcp(token, "set_personal_mind_description", { description: scenario.description, expected_metadata_version: config.metadata_version, idempotency_key: `acceptance-model:${crypto.randomUUID()}` });
    const directory = join(client.directory, "models", scenario.id); await mkdir(directory, { recursive: true, mode: 0o700 });
    server = new AcceptanceModelServer({ directory, maxTokens: 180000, maxCalls: 50, onTool: async (tool, args) => {
      if (!tools.some(t => t.name === tool)) throw new Error("unknown_model_tool");
      const envelope = await client.mcpEnvelope(token, "tools/call", { name: tool, arguments: args });
      return envelope.result ?? { isError: true, content: [{ type: "text", text: "Protocol error" }] };
    } });
    await server.start(); await server.thread({ model: receipt.model, tools, skill });
    let events;
    try {
      events = await server.turn(scenario.prompt);
      if (scenario.compact) {
        await server.compact();
        const after = await server.turn("Please check those same synthetic acceptance decisions again using the current state.");
        const calls = after.filter(e => e.method === "acceptance/tool");
        assert.equal(calls[0]?.params.tool, "list_minds");
        events = [...events, ...after];
      }
      const calls = events.filter(e => e.method === "acceptance/tool").map(e => e.params);
      const contentReads = calls.filter(c => ["search", "fetch", "browse_entries"].includes(c.tool));
      const commits = calls.filter(c => c.tool === "commit_changeset");
      assert.equal(calls.some(c => c.tool === "set_personal_mind_description"), false);
      for (const read of contentReads) assert.equal(scenario.reads.includes(read.arguments.mind), true);
      for (const mind of scenario.requiredReads) assert.equal(contentReads.some(c => c.arguments.mind === mind), true);
      for (const write of commits) assert.equal(scenario.writes.includes(write.arguments.mind), true);
      for (const mind of scenario.writes) assert.equal(commits.some(c => c.arguments.mind === mind && !c.result.isError), true);
      receipt.cases.push({ id: scenario.id, status: "passed", calls: calls.map(c => ({ tool: c.tool, mind: c.arguments.mind ?? null, error: c.result.isError === true })), compacted: scenario.compact === true, usage: server.usage });
      console.log(JSON.stringify({ phase, status: "passed", calls: calls.length, compacted: scenario.compact === true }));
    } finally {
      await writeFile(join(directory, "trace.json"), JSON.stringify({ receipt: { ...receipt, cases: [] }, scenario, events: server.events }), { mode: 0o600 });
      server.close(); server = null;
    }
  }
  receipt.status = "passed";
} finally {
  server?.close();
  const cleanup = await client.cleanup(); assert.equal(cleanup.state, "cleaned");
  const final = await client.control("/_acceptance/inventory"); assert.deepEqual(final, baseline);
  receipt.cleanup = "baseline_restored";
  await writeFile(join(client.directory, "model-receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
  console.log(JSON.stringify({ phase: "model_cleanup", status: receipt.status ?? "failed", cases: receipt.cases.length, cleanup: receipt.cleanup, runner_dirty: receipt.runner_dirty }));
}
