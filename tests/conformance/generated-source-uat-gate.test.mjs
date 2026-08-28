import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createLocalEvidence,
  parseCli as parseLocalCli,
} from "../../scripts/run-generated-source-local-gate.mjs";
import {
  createStructuralJoin,
  parseCli as parseJoinCli,
} from "../../scripts/join-generated-source-uat-readback.mjs";
import {
  canonical,
  digest,
  ProbeFailure,
} from "../../scripts/lib/multi-principal-probe-core.mjs";

const contract = JSON.parse(await readFile(
  new URL("../fixtures/generated-source-uat/contract.v1.json", import.meta.url),
  "utf8",
));
const candidate = "a".repeat(40);
const setup = "appgdep_md290setup";
const verify = "appgdep_md290verify";

function artifact(unsigned) {
  return { ...unsigned, artifact_sha256: digest(canonical(unsigned)) };
}

function localReceipt() {
  return createLocalEvidence({
    candidate,
    contract,
    suiteReceipts: contract.local_suites.map((path) => ({
      path,
      sha256: `sha256:${"b".repeat(64)}`,
      status: "passed",
    })),
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:01:00.000Z",
  });
}

function providerReadback() {
  return artifact({
    schema: contract.provider_readback_schema,
    generator: "codex-sites-connector-readback/v1",
    candidate_sha: candidate,
    project_id: "appgprj_md290fixture",
    version_id: "appgver_md290fixture",
    setup_deployment_id: setup,
    verify_deployment_id: verify,
    setup_status: "succeeded",
    verify_status: "succeeded",
  });
}

function availableRows() {
  return [
    { source_kind: "bounded_in_memory", server_adapter_status: "available", server_transport: "trusted_internal", max_bytes: 4_194_304 },
    { source_kind: "server_generated", server_adapter_status: "available", server_transport: "trusted_internal_stream", max_bytes: 268_435_456 },
  ];
}

function browserPassed() {
  return artifact({
    schema: contract.browser_readback_schema,
    generator: "codex-in-app-browser-readback/v1",
    browser_surface: "codex-in-app-browser",
    status: "passed",
    blocker_code: null,
    candidate_sha: candidate,
    setup_deployment_id: setup,
    verify_deployment_id: verify,
    capability_rows: availableRows(),
    assertions: contract.hosted_assertion_ids.map((id) => ({ id, status: "passed" })),
    read_back: {
      exact_path: true,
      exact_size: true,
      exact_sha256: true,
      exact_bytes: true,
      one_revision: true,
      no_duplicate_object: true,
    },
    cleanup: {
      credential_revoked: true,
      mind_deleted: true,
      target_absent: true,
      read_back_complete: true,
    },
  });
}

function browserBlocked() {
  return artifact({
    schema: contract.browser_readback_schema,
    generator: "codex-in-app-browser-readback/v1",
    browser_surface: "codex-in-app-browser",
    status: "blocked",
    blocker_code: "hosted_generated_sources_not_available",
    candidate_sha: candidate,
    setup_deployment_id: setup,
    verify_deployment_id: verify,
    capability_rows: [
      { source_kind: "bounded_in_memory", server_adapter_status: "not_available", server_transport: "none", max_bytes: 0 },
      { source_kind: "server_generated", server_adapter_status: "not_available", server_transport: "none", max_bytes: 0 },
    ],
  });
}

test("MD-290 CLIs accept only exact lineage and private evidence path classes", () => {
  assert.deepEqual(parseLocalCli([
    "--candidate-sha", candidate,
    "--evidence-out", "/private/evidence/local.json",
  ]), {
    candidate_sha: candidate,
    evidence_out: "/private/evidence/local.json",
  });
  assert.deepEqual(parseJoinCli([
    "--candidate-sha", candidate,
    "--setup-deployment-id", setup,
    "--verify-deployment-id", verify,
    "--local-receipt", "/private/evidence/local.json",
    "--provider-readback", "/private/evidence/provider.json",
    "--browser-readback", "/private/evidence/browser.json",
    "--join-out", "/private/evidence/join.json",
  ]).candidate_sha, candidate);
  for (const forbidden of ["bytes", "prompt", "job-id", "base-url", "credential", "mind-name"]) {
    assert.throws(
      () => parseLocalCli([`--${forbidden}`, "unsafe"]),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("local evidence is exact-candidate and can never claim hosted acceptance", () => {
  const receipt = localReceipt();
  assert.equal(receipt.hosted_evidence, false);
  assert.equal(receipt.acceptance, "local-deterministic-only");
  assert.equal(receipt.public_capability_claim, "not_available");
  assert.equal(receipt.assertions.length, contract.assertion_ids.length);
  assert.equal(receipt.artifact_sha256, digest(canonical((({ artifact_sha256: _, ...rest }) => rest)(receipt))));
});

test("offline join validates complete shape but remains nonterminal", () => {
  const joined = createStructuralJoin({
    local: localReceipt(),
    provider: providerReadback(),
    browser: browserPassed(),
  }, { candidate, setup, verify }, contract);
  assert.equal(joined.status, "structurally_verified_readback");
  assert.equal(joined.hosted_evidence, false);
  assert.equal(joined.acceptance, "nonterminal");
  assert.equal(joined.blocker_code, null);
});

test("fresh unavailable capability rows become an exact blocker, never a substitute pass", () => {
  const joined = createStructuralJoin({
    local: localReceipt(),
    provider: providerReadback(),
    browser: browserBlocked(),
  }, { candidate, setup, verify }, contract);
  assert.equal(joined.status, "verification_blocked");
  assert.equal(joined.hosted_evidence, false);
  assert.equal(joined.blocker_code, "hosted_generated_sources_not_available");
});

test("join rejects copied lineage, same deployment, incomplete cleanup and artifact tampering", () => {
  const base = { local: localReceipt(), provider: providerReadback(), browser: browserPassed() };
  assert.throws(
    () => createStructuralJoin(base, { candidate, setup, verify: setup }, contract),
    (error) => error instanceof ProbeFailure && error.code === "provider_lineage_mismatch",
  );
  const incomplete = browserPassed();
  incomplete.cleanup.read_back_complete = false;
  incomplete.artifact_sha256 = digest(canonical((({ artifact_sha256: _, ...rest }) => rest)(incomplete)));
  assert.throws(
    () => createStructuralJoin({ ...base, browser: incomplete }, { candidate, setup, verify }, contract),
    (error) => error instanceof ProbeFailure && error.code === "hosted_readback_incomplete",
  );
  const tampered = { ...providerReadback(), verify_status: "failed" };
  assert.throws(
    () => createStructuralJoin({ ...base, provider: tampered }, { candidate, setup, verify }, contract),
    (error) => error instanceof ProbeFailure && error.code === "invalid_provider_readback",
  );
});
