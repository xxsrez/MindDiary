import { execFileSync } from "node:child_process";

import { fail } from "./multi-principal-probe-core.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const DEFAULT_SITE_PATH = "apps/mind-diary-site";
const MIRROR_SUBJECT_PREFIX = "Mirror MindDiary ";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function exactCommit(root, value, code) {
  if (!SHA.test(value ?? "")) fail(code);
  try {
    const resolved = git(root, ["rev-parse", `${value}^{commit}`]);
    if (resolved !== value) fail(code);
    return resolved;
  } catch {
    fail(code);
  }
}

export function validateProviderSourceCommit(value, expected, code) {
  if (!SHA.test(value ?? "") || value !== expected.siteSourceCommitSha) fail(code);
  return value;
}

export function resolveSiteSourceProvenance({
  root,
  candidate,
  providerSourceCommitSha,
  sitePath = DEFAULT_SITE_PATH,
}) {
  const candidateSha = exactCommit(root, candidate, "tracked_candidate_unavailable");
  const siteSourceCommitSha = exactCommit(
    root,
    providerSourceCommitSha,
    "tracked_site_source_unavailable",
  );
  const candidateTreeSha = git(root, ["rev-parse", `${candidateSha}^{tree}`]);

  if (siteSourceCommitSha === candidateSha) {
    return Object.freeze({
      candidateSha,
      candidateTreeSha,
      siteSourceCommitSha,
      siteSourceTreeSha: candidateTreeSha,
      siteSourceMode: "direct-candidate",
    });
  }

  const candidateSiteTreeSha = git(root, ["rev-parse", `${candidateSha}:${sitePath}`]);
  const siteSourceTreeSha = git(root, ["rev-parse", `${siteSourceCommitSha}^{tree}`]);
  const subject = git(root, ["show", "-s", "--format=%s", siteSourceCommitSha]);
  if (siteSourceTreeSha !== candidateSiteTreeSha ||
      subject !== `${MIRROR_SUBJECT_PREFIX}${candidateSha}`) {
    fail("site_source_provenance_mismatch");
  }

  return Object.freeze({
    candidateSha,
    candidateTreeSha,
    siteSourceCommitSha,
    siteSourceTreeSha,
    siteSourceMode: "subtree-mirror",
  });
}
