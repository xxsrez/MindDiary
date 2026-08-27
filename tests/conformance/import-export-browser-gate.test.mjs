import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createEvidence,
  finalizeGateWorkspace,
  generateFixtureWorkspace,
  IMPORT_EXPORT_ASSERTION_IDS,
  parseCli,
  RUNTIME_SUITES,
} from "../../scripts/run-import-export-browser-gate.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";
import { reservePrivateTempOutput } from "../../scripts/lib/private-evidence-output.mjs";

const candidate = "a".repeat(40);
const repositoryRoot = resolve(import.meta.dirname, "../..");

function toolchain() {
  return {
    playwright_package_version: "1.62.1",
    playwright_cli_version: "1.62.1",
    chromium_package_version: "1.62.1",
    playwright_core_version: "1.62.1",
    chromium_revision: "1234",
    chromium_browser_version: "151.0.7922.34",
    chromium_executable_sha256: `sha256:${"b".repeat(64)}`,
  };
}

test("MD-363 gate CLI accepts only its closed argument shape", () => {
  assert.deepEqual(parseCli([
    "--candidate-sha", candidate,
    "--evidence-out", "/tmp/md363.json",
  ]), { candidate_sha: candidate, evidence_out: "/tmp/md363.json" });
  for (const argv of [
    ["--evidence-out", "/tmp/md363.json", "--base-url", "https://example.invalid"],
    ["--evidence-out", "/tmp/md363.json", "--fixture", "/private/user-data"],
    ["--evidence-out", "/tmp/md363.json", "--hosted-pass", "true"],
  ]) {
    assert.throws(
      () => parseCli(argv),
      (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
    );
  }
});

test("evidence output reservation requires exact 0700 parent and atomically owns the new 0600 file", async () => {
  const privateDirectory = await mkdtemp(join(tmpdir(), "mind-diary-md363-output-test-"));
  const repoBuild = resolve(repositoryRoot, "build");
  await mkdir(repoBuild, { recursive: true });
  const worktreeDirectory = await mkdtemp(join(repoBuild, "md363-output-test-"));
  const invalidModeDirectory = await mkdtemp(join(tmpdir(), "mind-diary-md363-mode-test-"));
  try {
    const safe = join(privateDirectory, "receipt.json");
    const output = await reservePrivateTempOutput(safe, {
      repositoryRoot,
      errorCode: "unsafe_evidence_output",
    });
    await output.write("reserved evidence\n");
    assert.equal(await readFile(safe, "utf8"), "reserved evidence\n");
    assert.equal((await lstat(safe)).mode & 0o777, 0o600);
    await assert.rejects(
      reservePrivateTempOutput(safe, { repositoryRoot, errorCode: "unsafe_evidence_output" }),
      (error) => error instanceof ProbeFailure && error.code === "unsafe_evidence_output",
    );
    const symlinkTarget = join(worktreeDirectory, "symlink-target.json");
    const symlinkOutput = join(privateDirectory, "symlink-output.json");
    await symlink(symlinkTarget, symlinkOutput);
    await assert.rejects(
      reservePrivateTempOutput(symlinkOutput, { repositoryRoot, errorCode: "unsafe_evidence_output" }),
      (error) => error instanceof ProbeFailure && error.code === "unsafe_evidence_output",
    );
    await assert.rejects(lstat(symlinkTarget), (error) => error?.code === "ENOENT");
    await assert.rejects(
      reservePrivateTempOutput(join(worktreeDirectory, "receipt.json"), {
        repositoryRoot,
        errorCode: "unsafe_evidence_output",
      }),
      (error) => error instanceof ProbeFailure && error.code === "unsafe_evidence_output",
    );
    for (const mode of [0o500, 0o755]) {
      await chmod(invalidModeDirectory, mode);
      await assert.rejects(
        reservePrivateTempOutput(join(invalidModeDirectory, `join-${mode.toString(8)}.json`), {
          repositoryRoot,
          errorCode: "unsafe_join_output",
        }),
        (error) => error instanceof ProbeFailure && error.code === "unsafe_join_output",
      );
    }
  } finally {
    await chmod(invalidModeDirectory, 0o700);
    await Promise.all([
      rm(privateDirectory, { recursive: true, force: true }),
      rm(worktreeDirectory, { recursive: true, force: true }),
      rm(invalidModeDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("repeated parent swaps after validation create no surviving file in the worktree", async () => {
  const repoBuild = resolve(repositoryRoot, "build");
  await mkdir(repoBuild, { recursive: true });
  const worktreeDirectory = await mkdtemp(join(repoBuild, "md363-race-target-"));
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parent = await mkdtemp(join(tmpdir(), `mind-diary-md363-race-${attempt}-`));
      const moved = `${parent}-moved`;
      const filename = `receipt-${attempt}.json`;
      try {
        await assert.rejects(
          reservePrivateTempOutput(join(parent, filename), {
            repositoryRoot,
            errorCode: "unsafe_evidence_output",
            testHooks: {
              async afterInitialValidation() {
                await rename(parent, moved);
                await symlink(worktreeDirectory, parent, "dir");
              },
            },
          }),
          (error) => error instanceof ProbeFailure && error.code === "unsafe_evidence_output",
        );
        await assert.rejects(
          lstat(join(worktreeDirectory, filename)),
          (error) => error?.code === "ENOENT",
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
        await rm(moved, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(worktreeDirectory, { recursive: true, force: true });
  }
});

test("failed Playwright diagnostics survive with a 24-hour cleanup marker while successful workspaces disappear", async () => {
  const failed = await mkdtemp(join(tmpdir(), "mind-diary-md363-failed-test-"));
  const passed = await mkdtemp(join(tmpdir(), "mind-diary-md363-passed-test-"));
  try {
    await writeFile(join(failed, "failure.png"), "synthetic", { mode: 0o600 });
    const disposition = await finalizeGateWorkspace(failed, {
      preserveDiagnostics: true,
      now: () => new Date("2026-08-27T23:00:00.000Z"),
    });
    assert.equal(disposition.preserved, true);
    assert.equal(disposition.cleanupAfter, "2026-08-28T23:00:00.000Z");
    assert.match(await readFile(disposition.guidancePath, "utf8"), /delete this entire directory by 2026-08-28T23:00:00\.000Z/u);
    assert.equal((await lstat(join(failed, "failure.png"))).isFile(), true);

    const completed = await finalizeGateWorkspace(passed, { preserveDiagnostics: false });
    assert.equal(completed.preserved, false);
    await assert.rejects(lstat(passed), (error) => error?.code === "ENOENT");
  } finally {
    await rm(failed, { recursive: true, force: true });
    await rm(passed, { recursive: true, force: true });
  }
});

test("generated fixture pins Markdown, invalid bytes, known opaque bytes and size plus one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-md363-fixture-test-"));
  try {
    const manifest = await generateFixtureWorkspace(directory);
    assert.equal(manifest.schema, "mind-diary/import-export-generated-fixtures/v1");
    assert.equal(manifest.known_opaque_bytes_hex, "00017f80ff4d443336330a");
    assert.equal(manifest.size_plus_one_bytes, 1_048_577);
    assert.equal(manifest.files.find((file) => file.id === "size-plus-one").size, 1_048_577);
    assert.equal((await readFile(join(directory, "baseline/assets/known.bin"))).toString("hex"),
      manifest.known_opaque_bytes_hex);
    assert.match(manifest.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local receipt binds candidate, executed toolchain, runtime sources and all browser assertions", () => {
  const fixture = {
    generator: "mind-diary-md363-deterministic-v1",
    artifact_sha256: `sha256:${"c".repeat(64)}`,
    known_opaque_bytes_hex: "00017f80ff4d443336330a",
    files: [{ id: "known-opaque", relative_path: "baseline/assets/known.bin", size: 11, sha256: `sha256:${"d".repeat(64)}` }],
  };
  const evidence = createEvidence({
    candidate,
    toolchain: toolchain(),
    fixture,
    runtimeSuites: RUNTIME_SUITES.map((path) => ({ path, sha256: `sha256:${"e".repeat(64)}`, status: "passed" })),
    assertions: IMPORT_EXPORT_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
    startedAt: "2026-08-27T23:00:00.000Z",
    completedAt: "2026-08-27T23:01:00.000Z",
  });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.hosted_evidence, false);
  assert.equal(evidence.acceptance, "local-deterministic-only");
  assert.equal(evidence.candidate_sha, candidate);
  assert.deepEqual(evidence.assertions.map(({ id }) => id), IMPORT_EXPORT_ASSERTION_IDS);
  assert.deepEqual(evidence.runtime_suites.map(({ path }) => path), RUNTIME_SUITES);
  assert.match(evidence.artifact_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes("/tmp"), false);
});
