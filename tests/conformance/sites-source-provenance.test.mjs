import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";
import { resolveSiteSourceProvenance } from "../../scripts/lib/sites-source-provenance.mjs";

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  }).trim();
}

test("Sites subtree mirror binds its exact tree and monorepo candidate subject", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-sites-source-"));
  try {
    await mkdir(join(root, "apps/mind-diary-site"), { recursive: true });
    await writeFile(join(root, "README.md"), "root\n", "utf8");
    await writeFile(join(root, "apps/mind-diary-site/index.js"), "export default {};\n", "utf8");
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Codex Test"]);
    git(root, ["config", "user.email", "codex-test@invalid.example"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "candidate"]);
    const candidate = git(root, ["rev-parse", "HEAD"]);
    const siteTree = git(root, ["rev-parse", `${candidate}:apps/mind-diary-site`]);
    const mirror = git(root, [
      "commit-tree",
      siteTree,
      "-m",
      `Mirror MindDiary ${candidate}`,
    ]);

    assert.deepEqual(resolveSiteSourceProvenance({
      root,
      candidate,
      providerSourceCommitSha: mirror,
    }), {
      candidateSha: candidate,
      candidateTreeSha: git(root, ["rev-parse", `${candidate}^{tree}`]),
      siteSourceCommitSha: mirror,
      siteSourceTreeSha: siteTree,
      siteSourceMode: "subtree-mirror",
    });

    const wrongSubject = git(root, ["commit-tree", siteTree, "-m", "unbound mirror"]);
    assert.throws(
      () => resolveSiteSourceProvenance({
        root,
        candidate,
        providerSourceCommitSha: wrongSubject,
      }),
      (error) => error instanceof ProbeFailure &&
        error.code === "site_source_provenance_mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
