import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createAcceptancePerformanceFixture } from "../../scripts/lib/acceptance-performance-fixture.mjs";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";

test("performance profiles are provisioned through ordinary APIs and read back at one and ten revisions", async t => {
  const runtime = await acceptanceRuntime(t);
  const client = await new AcceptanceClient({ directory: join(runtime.directory, "performance"), platformToken: "synthetic", controllerKey: runtime.controllerKey, fetch: runtime.fetch }).open();
  try {
    const fixture = await createAcceptancePerformanceFixture(client, { candidate_sha: "a".repeat(40), project_id: "appgprj_test", deployment_id: "appgdep_test", site_version_id: "appgver_test", archive_sha256: "b".repeat(64) }, "synthetic-binding-key-at-least-32-bytes");
    assert.deepEqual(fixture.profileReadback.profiles.map(p => p.observed.revisions), [1, 1, 10]);
    assert.equal(fixture.scenario.requests.length, 19);
    assert.equal(fixture.scenario.requests[0].cookie_env, "MD_PERF_COOKIE");
    assert.equal(fixture.scenario.warm_samples, 20);
    assert.equal(fixture.profileReadback.profiles[0].fixture_fingerprint, fixture.profileReadback.profiles[1].fixture_fingerprint);
  } finally { assert.equal((await client.cleanup()).state, "cleaned"); }
});
