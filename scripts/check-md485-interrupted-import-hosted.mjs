import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";

const [phase, tag, expectedCandidate] = process.argv.slice(2);
if (!["prepare", "resume", "cleanup"].includes(phase) ||
    !/^[A-Za-z0-9_-]{1,70}$/.test(tag ?? "") ||
    !/^[a-f0-9]{40}$/.test(expectedCandidate ?? "")) {
  throw new Error("phase_tag_candidate_required");
}
const root = join(homedir(), ".codex/private/mind-diary-acceptance");
const client = await new AcceptanceClient({
  directory: join(root, "runs", tag),
  platformToken: JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token,
  controllerKey: await readFile(join(root, "controller-key"), "utf8"),
}).open();
const buildResponse = await client.request("/_acceptance/build");
assert.equal(buildResponse.status, 200);
assert.equal((await buildResponse.json()).candidate_sha, expectedCandidate);

const owner = () => client.state.run.actors[0];
const cookie = () => client.state.actors[owner().actor_id].cookie;
async function csrf(path = "/") {
  const response = await client.request(path, { headers: { cookie: cookie() } });
  assert.equal(response.status, 200);
  const token = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await response.text())?.[1];
  assert.ok(token);
  return token;
}
async function mutation(name, path, body, method = "POST", page = "/") {
  return client.mutation(name, owner().actor_id, {
    path, method, body, csrf: await csrf(page),
  });
}
function data(value) {
  assert.equal(value.ok, true);
  assert.ok(value.data);
  return value.data;
}
async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.byteLength,
    sha256: "sha256:" + Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
  };
}
async function status(importId) {
  const response = await client.request(`/api/v1/markdown-imports/${importId}`, {
    headers: { cookie: cookie() },
  });
  assert.equal(response.status, 200);
  return data(await response.json()).session;
}
const testFile = {
  path: "concepts/md485-interrupted.md",
  text: "---\ntype: Reference\n---\n\nSynthetic import resumed after a cold deployment.\n",
};

if (phase === "prepare") {
  const prepareDeploymentId = process.env.MD485_PREPARE_DEPLOYMENT_ID;
  assert.match(prepareDeploymentId ?? "", /^appgdep_[a-f0-9]{32}$/);
  assert.ok(["prepared", "created"].includes(client.state.phase));
  if (!client.state.md485Interruption?.baseline) {
    const baseline = await client.control("/_acceptance/inventory");
    assert.equal(baseline.complete, true);
    assert.equal(baseline.principals, 0);
    assert.equal(baseline.owned_minds, 0);
    client.state.md485Interruption = { baseline, candidate: expectedCandidate,
      prepareDeploymentId };
    await client.save();
  }
  await client.setup();
  await client.session(owner().actor_id);
  await mutation("bootstrap:owner", "/api/v1/account", {
    action: "create_isolated_account",
  });
  await mutation("usage:personal:v0", "/api/v1/minds/me/usage", {
    usage_mode: "read_write", expected_usage_version: 0,
  }, "PUT");
  const issued = data(await mutation("token:owner", "/api/v1/mcp-tokens", {
    name: "Synthetic interruption", scopes: ["content:read"],
  }));
  const mind = (await client.mcp(issued.secret, "list_minds")).minds.find(x => x.route === "/me");
  assert.ok(mind?.head?.revision_id);
  const baseRevision = mind.head.revision_id;
  const listed = await client.mcp(issued.secret, "list_files", {
    mind: "/me",
    revision_selector: { kind: "revision", revision_id: baseRevision },
    include_globs: ["**/*.md"],
  });
  assert.ok(listed.files.length > 0 && listed.files.length < 20);
  const read = await client.mcp(issued.secret, "read_files", {
    mind: "/me",
    revision_selector: { kind: "revision", revision_id: baseRevision },
    requests: listed.files.map(file => ({ path: file.path, mode: "head", count: 1000 })),
  });
  const stagedFiles = [];
  for (const [index, item] of read.items.entries()) {
    assert.equal(typeof item.file?.text, "string");
    stagedFiles.push({
      path: listed.files[index].path,
      text: item.file.text,
      ...await digest(item.file.text),
    });
  }
  stagedFiles.push({ ...testFile, ...await digest(testFile.text) });
  const descriptors = stagedFiles.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  const plan = data(await mutation("import:plan", "/api/v1/minds/me/markdown-import-plans", {
    expected_revision_id: baseRevision, files: descriptors,
  }));
  const started = data(await mutation("import:start:v2", "/api/v1/minds/me/markdown-imports", {
    plan_id: plan.plan.plan_id,
  }));
  const session = started.session ?? started.import ?? started;
  assert.equal(session.state, "active");
  const file = descriptors.find(x => x.path === testFile.path);
  const manifest = { expected_version: session.version,
    files: stagedFiles.map(({ path, size, sha256 }, index) => ({
      field: `file_${index}`, path, size, sha256,
    })) };
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  stagedFiles.forEach(({ text }, index) =>
    form.append(`file_${index}`, new Blob([text], { type: "text/markdown" }), "ignored.md"));
  const batch = await client.transport(`https://mind-diary-acceptance.example.invalid/api/v1/markdown-imports/${session.import_id}/batches/1`, {
    method: "PUT", body: form, redirect: "manual", signal: AbortSignal.timeout(45000),
    headers: { "OAI-Sites-Authorization": `Bearer ${client.platformToken}`,
      cookie: cookie(), origin: "https://mind-diary-acceptance.example.invalid",
      "x-csrf-token": await csrf(), "idempotency-key": "md485-interruption-batch-1" },
  });
  if (batch.status !== 200) {
    const failure = await batch.json();
    throw new Error(`batch_http_${batch.status}_${failure.error?.code ?? "unknown"}`);
  }
  const staged = data(await batch.json()).session;
  assert.equal(staged.checkpoint, 1);
  const beforeCold = await status(session.import_id);
  assert.equal(beforeCold.state, "active");
  assert.equal(beforeCold.checkpoint, 1);
  client.state.md485Interruption = { ...client.state.md485Interruption,
    importId: session.import_id, baseRevision, descriptorCount: descriptors.length,
    fileSha256: file.sha256, stagedVersion: beforeCold.version,
    preparedAt: new Date().toISOString() };
  await client.save();
  console.log(JSON.stringify({ phase: "prepared", candidate: expectedCandidate,
    import_id: session.import_id, state: beforeCold.state, checkpoint: beforeCold.checkpoint,
    descriptor_count: descriptors.length }));
}

if (phase === "resume") {
  const record = client.state.md485Interruption;
  assert.ok(record?.importId && record.candidate === expectedCandidate);
  assert.equal(client.state.phase, "created");
  // A fresh Worker deployment is required between prepare and resume.
  const coldDeploymentId = process.env.MD485_COLD_DEPLOYMENT_ID;
  assert.match(coldDeploymentId ?? "", /^appgdep_[a-f0-9]{32}$/);
  assert.notEqual(coldDeploymentId, record.prepareDeploymentId,
    "provider_redeployment_receipt_required");
  let current = await status(record.importId);
  assert.equal(current.state, "active");
  assert.equal(current.checkpoint, 1);
  for (let step = 0; step < 30 && current.state !== "validated"; step++) {
    current = data(await mutation(`import:validate:${step}`,
      `/api/v1/markdown-imports/${record.importId}/validate`,
      { expected_version: current.version })).session;
  }
  assert.equal(current.state, "validated");
  for (let step = 0; step < 30 && current.state !== "committed"; step++) {
    const result = data(await mutation(`import:commit:${step}`,
      `/api/v1/markdown-imports/${record.importId}/commit`,
      { expected_version: current.version, summary: "Synthetic interrupted import" }));
    current = result.session ?? { ...current, state: "committed", revision_id: result.revision_id };
  }
  assert.equal(current.state, "committed");
  assert.ok(current.revision_id && current.revision_id !== record.baseRevision);
  const issued = client.state.operations["token:owner"].result.data.secret;
  const revisions = await client.mcp(issued, "list_revisions", { mind: "/me" });
  assert.equal(revisions.revisions.filter(x => x.revision_id === current.revision_id).length, 1);
  const file = await client.mcp(issued, "read_files", {
    mind: "/me", revision_selector: { kind: "revision", revision_id: current.revision_id },
    requests: [{ path: testFile.path, mode: "head", count: 1000 }],
  });
  assert.equal(file.items[0].file.text, testFile.text);
  client.state.md485Interruption = { ...record, committedRevision: current.revision_id,
    coldDeploymentId,
    resumedAt: new Date().toISOString() };
  await client.save();
  console.log(JSON.stringify({ phase: "resumed", candidate: expectedCandidate,
    cold_deployment_id: coldDeploymentId, one_revision: true,
    file_sha256: record.fileSha256, import_state: current.state }));
}

if (phase === "cleanup") {
  const record = client.state.md485Interruption;
  assert.ok(record?.baseline);
  const receipt = await client.cleanup();
  assert.equal(receipt.state, "cleaned");
  const final = await client.control("/_acceptance/inventory");
  assert.deepEqual(final, record.baseline);
  console.log(JSON.stringify({ phase: "cleaned", baseline_restored: true }));
}
