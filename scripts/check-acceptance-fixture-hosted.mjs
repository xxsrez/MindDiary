import { privateAcceptanceDirectory } from "./lib/private-operations.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { acceptanceDigest, createAcceptanceComponent } from "./lib/acceptance-evidence.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { verifyProductMatrix } from "./lib/acceptance-product-matrix.mjs";
import { verifyAclMatrix } from "./lib/acceptance-acl-matrix.mjs";

const runnerSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const identityPath = process.env.MD_ACCEPTANCE_IDENTITY_FILE;
const identity = identityPath ? JSON.parse(await readFile(identityPath, "utf8")) : null;
if (identity && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("clean_runner_required");
const privateRoot = privateAcceptanceDirectory();
const tag = process.argv[2] ?? crypto.randomUUID();
if (!/^[A-Za-z0-9_-]{1,80}$/.test(tag)) throw new Error("invalid_run_tag");
const expected = process.env.MD_ACCEPTANCE_EXPECTED_SHA;
if (!/^[a-f0-9]{40}$/.test(expected ?? "")) throw new Error("exact_expected_candidate_required");
const platformToken = process.env.MD_ACCEPTANCE_PLATFORM_TOKEN ?? JSON.parse(await readFile(join(privateRoot, "platform-token.json"), "utf8")).token;
const controllerKey = process.env.MD_ACCEPTANCE_CONTROLLER_KEY ?? await readFile(join(privateRoot, "controller-key"), "utf8");
const config = { directory: join(privateRoot, "runs", tag), platformToken, controllerKey };
let client = await new AcceptanceClient(config).open();
const buildResponse = await client.request("/_acceptance/build");
assert.equal(buildResponse.status, 200);
const build = await buildResponse.json(); assert.equal(build.candidate_sha, expected);
if (identity) {
  assert.equal(identity.candidate_sha, expected);
  for (const field of ["common_modules_sha256", "test_adapter_sha256"]) assert.equal(identity[field], build[field]);
}
if (client.state.phase === "cleaned") {
  console.log(JSON.stringify({ status: "previously_cleaned", candidate: expected, receipt: client.state.receipt }));
} else {
  client.state.baseline ??= await client.control("/_acceptance/inventory"); await client.save();
  assert.equal(client.state.baseline.complete, true);
  let verified = false, token;
  try {
    if (client.state.phase !== "cleanup_pending") {
      if (process.env.MD_ACCEPTANCE_INJECT_LOST_COMMIT === "1" && !client.state.injectionCompleted) {
        let injected = false;
        const transport = client.transport;
        client.transport = async (url, options) => {
          const response = await transport(url, options);
          const body = options.body ? JSON.parse(options.body) : null;
          if (!injected && body?.params?.name === "commit_changeset" && response.ok && (await response.clone().json()).result?.isError === false) {
            injected = true; throw new Error("injected_lost_commit_response");
          }
          return response;
        };
        await assert.rejects(createCollaborationFixture(client), /injected_lost_commit_response/);
        client = await new AcceptanceClient(config).open(); client.state.injectionCompleted = true; await client.save();
      }
      const fixture = await createCollaborationFixture(client);
      token = client.state.operations["token:owner"].result.data.secret;
      for (const [role, actor] of Object.entries(fixture.actors)) {
        const response = await client.request(`/api/v1/minds/${fixture.handle}`, { headers: { cookie: client.state.actors[actor.actor_id].cookie } });
        assert.equal(response.status, role === "outsider" ? 404 : 200);
        if (response.ok) assert.equal((await response.json()).data.access.role, role);
      }
      for (const mind of ["/me", `/${fixture.handle}`]) {
        const history = await client.mcp(token, "list_revisions", { mind }); assert.equal(history.revisions.length, 3);
      }
      if (process.env.MD_ACCEPTANCE_PRODUCT_MATRIX === "1") {
        client.state.productMatrix = await verifyProductMatrix(client, fixture); await client.save();
        console.log(JSON.stringify(client.state.productMatrix));
        client.state.aclMatrix = await verifyAclMatrix(client, fixture); await client.save();
        console.log(JSON.stringify(client.state.aclMatrix));
      }
      client.state.populated = await client.control("/_acceptance/inventory"); await client.save();
      assert.equal(client.state.populated.complete, true);
      assert.equal(client.state.populated.principals - client.state.baseline.principals, 4);
      verified = true;
      console.log(JSON.stringify({ phase: "fixture_verified", candidate: expected, actors: 4, lanes: 2, revisions_per_lane: 3, recovered_commit: client.state.injectionCompleted === true }));
    }
  } finally {
    const receipt = await client.cleanup(); assert.equal(receipt.state, "cleaned");
    if (token) await assert.rejects(client.mcp(token, "list_minds"), /mcp_http_401/);
    const final = await client.control("/_acceptance/inventory"); assert.equal(final.complete, true);
    for (const key of ["principals", "owned_minds", "object_count", "object_bytes"]) assert.equal(final[key], client.state.baseline[key], `final_${key}`);
    assert.deepEqual(final.rows, client.state.baseline.rows);
    client.state.finalInventory = final; client.state.verified = verified; await client.save();
    console.log(JSON.stringify({ phase: "cleaned", verified, candidate: expected, receipt, final }));
    if (identity && verified && client.state.productMatrix?.status === "passed" && client.state.aclMatrix?.status === "passed") {
      const matrix = client.state.productMatrix, acl = client.state.aclMatrix;
      const source = { build, matrix, acl, cleanup: receipt, baseline: client.state.baseline, final, runner_sha: runnerSha };
      const component = createAcceptanceComponent({ kind: "product", status: "passed", identity, runner_sha: runnerSha,
        assertions: { personal_mode_matrix: matrix.personal_mode_description_cells.length === 9,
          credential_scope_narrowing: matrix.scope_narrowing, metadata_cas: matrix.metadata_cas,
          revision_cas: matrix.stale_revision_denied, history: matrix.history, okf: matrix.okf,
          acl_roles: acl.roles.length === 3, invitations: true, outsider_denied: acl.outsider_private_mind_denied },
        details: { matrix, acl }, cleanup: { status: "baseline_restored", baseline: client.state.baseline, final }, source_receipts: [acceptanceDigest(source)] });
      await writeFile(join(client.directory, "product-source.json"), JSON.stringify(source), { mode: 0o600 });
      await writeFile(join(client.directory, "product-component.json"), JSON.stringify(component), { mode: 0o600 });
    }
  }
}
