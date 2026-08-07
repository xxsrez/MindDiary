#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
import uuid
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).parent
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("shipctl", SCRIPTS / "shipctl.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class GitMixin:
    def git(self, repo: Path, *args: str, input_text: str | None = None) -> str:
        options: dict[str, object] = {
            "check": True,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
        }
        if input_text is None:
            options["stdin"] = subprocess.DEVNULL
        else:
            options["input"] = input_text
        return subprocess.run(["git", "-C", str(repo), *args], **options).stdout.strip()

    def fixture(self, root: Path) -> tuple[Path, Path]:
        remote = root / "remote.git"
        repo = root / "repo"
        self.git(root, "init", "--bare", str(remote))
        self.git(root, "init", "-b", "main", str(repo))
        self.git(repo, "config", "user.name", "test")
        self.git(repo, "config", "user.email", "test@example.invalid")
        skill = repo / MODULE.SKILL_PATH
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: test\n---\n", encoding="utf-8")
        (repo / "AGENTS.md").write_text("# test\n", encoding="utf-8")
        (repo / "package.json").write_text("{}\n", encoding="utf-8")
        self.git(repo, "add", MODULE.SKILL_PATH, "AGENTS.md", "package.json")
        self.git(repo, "commit", "-m", "base")
        self.git(repo, "remote", "add", "origin", str(remote))
        self.git(repo, "push", "-u", "origin", "main")
        return repo, remote

    def metadata_commit(self, repo: Path, message: str, parent: str | None = None) -> str:
        tree = self.git(repo, "rev-parse", "HEAD^{tree}")
        args = ["commit-tree", tree]
        if parent is not None:
            args.extend(["-p", parent])
        return self.git(repo, *args, input_text=message)


class DocsRoutingTest(unittest.TestCase):
    def test_skill_change_loads_no_product_documents(self) -> None:
        surfaces, docs = MODULE.route_docs(
            [".agents/skills/ship-linear-release/SKILL.md"], None
        )
        self.assertEqual(surfaces, ["skill"])
        self.assertEqual(docs, [])

    def test_mcp_and_ui_union_is_bounded(self) -> None:
        surfaces, docs = MODULE.route_docs(
            ["packages/adapter-mcp/src/index.ts", "packages/adapter-web/src/ui-shell.ts"],
            None,
        )
        self.assertEqual(surfaces, ["mcp", "ui"])
        self.assertIn("docs/specs/api.md", docs)
        self.assertIn("docs/brand.md", docs)
        self.assertLess(len(docs), len(MODULE.ALL_DOCS))

    def test_unknown_or_ambiguous_path_fails_safe_to_all_documents(self) -> None:
        surfaces, docs = MODULE.route_docs(
            ["packages/domain/src/index.ts", "new-surface/file.ts"], None
        )
        self.assertEqual(surfaces, ["control", "unknown"])
        self.assertEqual(docs, MODULE.ALL_DOCS)

    def test_substrings_do_not_misroute(self) -> None:
        self.assertEqual(MODULE.infer_surface("build/output.ts"), "unknown")
        self.assertEqual(MODULE.infer_surface("packages/adapter-webish/file.ts"), "unknown")
        self.assertEqual(MODULE.infer_surface("lib/sites-helper.ts"), "unknown")

    def test_all_real_package_roots_have_explicit_routes(self) -> None:
        package_roots = {
            "adapter-audit-memory",
            "adapter-background",
            "adapter-mcp",
            "adapter-metadata-memory",
            "adapter-object-memory",
            "adapter-search-memory",
            "adapter-security-webcrypto",
            "adapter-web",
            "application-background",
            "application-content",
            "application-contracts",
            "application-control",
            "application-ports",
            "composition-root",
            "domain",
            "okf-codec",
            "test-fixtures",
        }
        for name in package_roots:
            with self.subTest(name=name):
                self.assertNotEqual(
                    MODULE.infer_surface(f"packages/{name}/src/index.ts"), "unknown"
                )

    def test_relevant_test_roots_route_without_substrings(self) -> None:
        self.assertEqual(MODULE.infer_surface("tests/conformance/mcp-transport.test.mjs"), "mcp")
        self.assertEqual(MODULE.infer_surface("tests/unit/okf-codec.test.mjs"), "okf")
        self.assertEqual(MODULE.infer_surface("tests/integration/membership-control.test.mjs"), "control")
        self.assertEqual(MODULE.infer_surface("tests/integration/changeset-commit.test.mjs"), "content")

    def test_one_cross_surface_test_routes_union(self) -> None:
        surfaces, docs = MODULE.route_docs(
            ["tests/unit/mcp-token-management-ui.test.mjs"], None
        )
        self.assertEqual(surfaces, ["mcp", "ui", "control"])
        self.assertIn("docs/specs/api.md", docs)
        self.assertIn("docs/brand.md", docs)


class IdentityTest(unittest.TestCase):
    def test_identities_are_valid_and_unique(self) -> None:
        values = []
        for _ in range(2):
            with io.StringIO() as output, redirect_stdout(output):
                MODULE.command_identities(mock.Mock())
                values.append(json.loads(output.getvalue()))
        self.assertRegex(values[0]["run_key"], r"^[0-9a-f]{32}$")
        self.assertNotEqual(values[0]["run_key"], values[1]["run_key"])
        self.assertNotEqual(values[0]["run_id"], values[1]["run_id"])


class ManifestTest(GitMixin, unittest.TestCase):
    RUN_KEY = "a" * 32

    def manifest_fixture(self, root: Path) -> tuple[Path, Path, dict[str, object]]:
        repo, _ = self.fixture(root)
        branch = f"codex/and-56-domain/r{self.RUN_KEY}-e1-c1"
        self.git(repo, "branch", branch)
        worktree = root / "worker"
        self.git(repo, "worktree", "add", str(worktree), branch)
        base = self.git(worktree, "rev-parse", "HEAD")
        guard_message = "guard\n\nSTATE: claimed\n"
        guard_tip = self.metadata_commit(worktree, guard_message, base)
        guard_ref = f"refs/heads/codex/release/claims/{self.RUN_KEY}/AND-56/c1"
        self.git(repo, "update-ref", guard_ref, guard_tip)
        for name in ("build-task", "tmp-task", "runtime-task", "cache-task"):
            (worktree / name).mkdir()
        manifest: dict[str, object] = {
            "run_id": "019fdbbd-b0ed-77d1-80a4-f45a253c770f",
            "run_key": self.RUN_KEY,
            "owner_id": str(uuid.uuid4()),
            "owner_epoch": 1,
            "claim_generation": 1,
            "claim_token": str(uuid.uuid4()),
            "issue_id": str(uuid.uuid4()),
            "issue_identifier": "AND-56",
            "project_id": str(uuid.uuid4()),
            "milestone_id": str(uuid.uuid4()),
            "repo": str(repo),
            "worktree": str(worktree),
            "branch": branch,
            "feature_ref": f"refs/heads/{branch}",
            "guard_ref": guard_ref,
            "guard_tip": guard_tip,
            "root_sha": base,
            "base_sha": base,
            "dependency_shas": [],
            "queue_fingerprint": "b" * 64,
            "scope_fingerprint": "c" * 64,
            "issue_updated_at": "2026-08-07T14:00:00.123Z",
            "ownership_paths": ["packages/domain/src/index.ts"],
            "isolation": {
                "mutable_build_dir": str(worktree / "build-task"),
                "tmp_dir": str(worktree / "tmp-task"),
                "runtime_dir": str(worktree / "runtime-task"),
                "cache_mode": "isolated",
                "cache_dir": str(worktree / "cache-task"),
                "ports": [43123, 43124],
                "env": {"MIND_DIARY_TASK_TMP": str(worktree / "tmp-task")},
            },
            "validation": {
                "targeted_checks": ["node --test tests/unit/domain-invariants.test.mjs"],
                "check_class": "targeted-feature",
                "full_gate": "deferred-to-cutoff",
            },
            "remote_mode": "online",
        }
        return repo, worktree, manifest

    def invoke(self, payload: object) -> tuple[int, dict[str, object]]:
        args = mock.Mock(input="-")
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_manifest(args)
            return code, json.loads(output.getvalue())

    def test_validates_git_bound_manifest_and_routes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            code, result = self.invoke(payload)
        self.assertEqual((code, result["status"]), (0, "valid"))
        self.assertEqual(result["surfaces"], ["control"])
        self.assertIn("docs/specs/domain-model.md", result["documents"])

    def test_non_object_is_a_clean_validation_error(self) -> None:
        code, result = self.invoke(["not", "an", "object"])
        self.assertEqual((code, result["status"]), (2, "invalid"))
        self.assertEqual(result["errors"], ["invalid:manifest:not-object"])

    def test_rejects_missing_and_weak_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            del payload["claim_token"]
            payload["run_key"] = "SHORT"
            code, result = self.invoke(payload)
        self.assertIn("missing:claim_token", result["errors"])
        self.assertIn("invalid:claim_token", result["errors"])
        self.assertIn("invalid:run_key", result["errors"])
        self.assertEqual(code, 2)

    def test_rejects_wrong_issue_branch_binding(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            payload["issue_identifier"] = "AND-57"
            payload["guard_ref"] = f"refs/heads/codex/release/claims/{self.RUN_KEY}/AND-57/c1"
            code, result = self.invoke(payload)
        self.assertEqual(code, 2)
        self.assertIn("invalid:branch-issue-run-binding", result["errors"])

    def test_rejects_path_traversal_and_declared_surface_narrowing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            payload["ownership_paths"] = ["packages/domain/../adapter-web/src/index.ts"]
            payload["surface"] = "control"
            code, result = self.invoke(payload)
        self.assertEqual(code, 2)
        self.assertIn("invalid:ownership_paths", result["errors"])
        self.assertIn("invalid:surface-does-not-match-ownership", result["errors"])
        self.assertEqual(result["documents"], MODULE.ALL_DOCS)

    def test_rejects_isolation_escape_and_full_suite(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            payload["isolation"]["tmp_dir"] = str(Path(directory) / "outside")  # type: ignore[index]
            payload["validation"]["targeted_checks"] = ["npm run check"]  # type: ignore[index]
            code, result = self.invoke(payload)
        self.assertEqual(code, 2)
        self.assertIn("invalid:isolation.tmp_dir:outside-worktree", result["errors"])
        self.assertIn("invalid:validation.targeted_checks:full-suite", result["errors"])

    def test_rejects_duplicate_ports_and_scope_timestamp_confusion(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            payload["isolation"]["ports"] = [43123, 43123]  # type: ignore[index]
            payload["scope_fingerprint"] = payload["issue_updated_at"]
            code, result = self.invoke(payload)
        self.assertEqual(code, 2)
        self.assertIn("invalid:isolation.ports", result["errors"])
        self.assertIn("invalid:scope_fingerprint", result["errors"])


class PreflightTest(GitMixin, unittest.TestCase):
    PROOF = "a" * 64

    def preflight(self, repo: Path, proof: str | None = None) -> tuple[int, dict[str, object], int]:
        args = mock.Mock(
            repo=str(repo),
            remote="origin",
            default="main",
            skill_path=MODULE.SKILL_PATH,
            owner_proof_digest=proof,
        )
        with io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_preflight(args)
            raw = output.getvalue()
        return code, json.loads(raw), len(raw)

    def coordinator_message(
        self,
        repo: Path,
        *,
        state: str = "running",
        owner_state: str = "active",
        proof: str = PROOF,
        contract: str | None = None,
        extra: str = "",
    ) -> str:
        contract = contract or self.git(repo, "rev-parse", f"HEAD:{MODULE.SKILL_PATH}")
        return (
            "coordinator\n\n"
            "SCHEMA: 1\n"
            "KIND: COORDINATOR_CLAIM\n"
            f"STATE: {state}\n"
            f"OWNER_STATE: {owner_state}\n"
            f"OWNER_PROOF_DIGEST: {proof}\n"
            f"CONTRACT_DIGEST: {contract}\n"
            "ACTION_SEQ: 0\n"
            "ACTION_STATUS: reconciled\n"
            f"{extra}"
        )

    def push_coordinator(
        self, repo: Path, ref: str, message: str, parent: str | None = None
    ) -> str:
        commit = self.metadata_commit(repo, message, parent)
        self.git(repo, "push", "origin", f"{commit}:{ref}")
        return commit

    def test_clean_preflight_is_normal_build_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            code, result, size = self.preflight(repo)
        self.assertEqual((code, result["route"], result["delivery_profile"]), (0, "normal", "build"))
        self.assertTrue(result["mutation_allowed"])
        self.assertIn("references/external-main.md", result["required_references"])
        self.assertLess(size, 9000)

    def test_active_claim_routes_to_recovery_or_proven_resume(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(repo, MODULE.CANONICAL_COORDINATOR_REF, self.coordinator_message(repo))
            _, recovery, _ = self.preflight(repo)
            _, invalid_case, _ = self.preflight(repo, self.PROOF.upper())
            _, resume, _ = self.preflight(repo, self.PROOF)
        self.assertEqual(recovery["route"], "recovery")
        self.assertFalse(recovery["mutation_allowed"])
        self.assertEqual(invalid_case["route"], "recovery")
        self.assertEqual(resume["route"], "resume")
        self.assertTrue(resume["mutation_allowed"])
        self.assertIn("references/external-main.md", resume["required_references"])

    def test_matching_proof_cannot_resume_needs_input_handoff(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(repo, state="needs-input", owner_state="handoff-ready"),
            )
            code, result, _ = self.preflight(repo, self.PROOF)
        self.assertEqual((code, result["route"]), (0, "recovery"))
        self.assertFalse(result["mutation_allowed"])
        self.assertIn("canonical-state-needs-input", result["reasons"])
        self.assertIn("canonical-owner-handoff-ready", result["reasons"])
        self.assertIn("references/external-main.md", result["required_references"])

    def test_reconciled_quiescent_handoff_routes_to_automatic_takeover(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="needs-input",
                    owner_state="handoff-ready",
                    contract="1" * 40,
                    extra=(
                        "ACTION_KIND: handoff-owner\n"
                        "ACTION_TARGET: codex-thread:previous-control-task\n"
                        "WORKERS: active_issue_lanes=none;executors=terminal\n"
                        "PAUSE: state=handoff-ready;pending_external_action=none\n"
                        "PROMOTION_HOLD: known-bad-default\n"
                    ),
                ),
            )
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (0, "takeover"))
        self.assertTrue(result["mutation_allowed"])
        self.assertEqual(result["mutation_scope"], "coordinator-claim-cas-only")
        self.assertIn("handoff-ready-takeover-eligible", result["reasons"])
        self.assertIn("active-contract-mismatch-or-unknown", result["reasons"])
        self.assertIn("active-durable-restriction:PAUSE", result["reasons"])
        self.assertIn("active-durable-restriction:PROMOTION_HOLD", result["reasons"])

    def test_incomplete_handoff_remains_read_only_recovery(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="needs-input",
                    owner_state="handoff-ready",
                    extra=(
                        "ACTION_KIND: handoff-owner\n"
                        "ACTION_TARGET: codex-thread:next\n"
                        "WORKERS: active_issue_lanes=one;executors=running\n"
                        "PAUSE: state=handoff-ready;pending_external_action=none\n"
                    ),
                ),
            )
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (0, "recovery"))
        self.assertFalse(result["mutation_allowed"])
        self.assertEqual(result["mutation_scope"], "none")

    def test_matching_proof_cannot_lift_active_pause(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    extra="PAUSE: id=pause-1;confirmation_required=yes;scope=all-shared\n",
                ),
            )
            code, result, _ = self.preflight(repo, self.PROOF)
        self.assertEqual((code, result["route"]), (0, "recovery"))
        self.assertFalse(result["mutation_allowed"])
        self.assertIn("active-durable-restriction:PAUSE", result["reasons"])

    def test_lifted_pause_is_not_an_active_restriction(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    extra="PAUSE: id=pause-1;state=lifted;confirmation_required=yes\n",
                ),
            )
            code, result, _ = self.preflight(repo, self.PROOF)
        self.assertEqual((code, result["route"]), (0, "resume"))
        self.assertTrue(result["mutation_allowed"])
        self.assertFalse(any(reason.startswith("active-durable-restriction:") for reason in result["reasons"]))

    def test_active_contract_mismatch_routes_recovery(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(repo, contract="1" * 40),
            )
            _, result, _ = self.preflight(repo, self.PROOF)
        self.assertEqual(result["route"], "recovery")
        self.assertIn("active-contract-mismatch-or-unknown", result["reasons"])

    def test_dirty_skill_or_agents_blocks_dispatch(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            (repo / "AGENTS.md").write_text("dirty\n", encoding="utf-8")
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (3, "blocked"))
        self.assertIn("agents-instructions-dirty", result["reasons"])
        self.assertFalse(result["mutation_allowed"])

    def test_dirty_primary_control_surface_blocks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            (repo / "package.json").write_text('{"dirty":true}\n', encoding="utf-8")
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (3, "blocked"))
        self.assertIn("primary-control-surface-dirty", result["reasons"])
        self.assertEqual(result["primary_checkout"]["observation"], "overlap")

    def test_dirty_disjoint_primary_is_reported_and_allowed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            (repo / "personal-notes.txt").write_text("unrelated\n", encoding="utf-8")
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (0, "normal"))
        self.assertEqual(result["primary_checkout"]["observation"], "isolated-dirty")
        self.assertEqual(result["primary_checkout"]["action"], "continue")
        self.assertEqual(result["primary_checkout"]["paths"], ["personal-notes.txt"])

    def test_clean_ahead_primary_blocks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            (repo / "local.txt").write_text("ahead\n", encoding="utf-8")
            self.git(repo, "add", "local.txt")
            self.git(repo, "commit", "-m", "local ahead")
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (3, "blocked"))
        self.assertIn("primary-default-ahead", result["reasons"])
        self.assertEqual(result["primary_checkout"]["relation"], "ahead")

    def test_clean_diverged_primary_blocks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            root = Path(directory)
            repo, remote = self.fixture(root)
            other = root / "other"
            self.git(root, "clone", str(remote), str(other))
            self.git(other, "config", "user.name", "other")
            self.git(other, "config", "user.email", "other@example.invalid")
            (repo / "local.txt").write_text("local\n", encoding="utf-8")
            self.git(repo, "add", "local.txt")
            self.git(repo, "commit", "-m", "local change")
            (other / "remote.txt").write_text("remote\n", encoding="utf-8")
            self.git(other, "add", "remote.txt")
            self.git(other, "commit", "-m", "remote change")
            self.git(other, "push", "origin", "main")
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (3, "blocked"))
        self.assertIn("primary-default-diverged", result["reasons"])
        self.assertEqual(result["primary_checkout"]["relation"], "diverged")

    def test_stale_committed_contract_blocks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            (repo / MODULE.SKILL_PATH / "SKILL.md").write_text("changed\n", encoding="utf-8")
            self.git(repo, "add", MODULE.SKILL_PATH)
            self.git(repo, "commit", "-m", "local contract change")
            code, result, _ = self.preflight(repo)
        self.assertEqual(code, 3)
        self.assertIn("invoked-contract-stale-vs-remote-default", result["reasons"])

    def test_unknown_legacy_ref_blocks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                "refs/heads/codex/release/0.1/coordinator",
                "unstructured legacy checkpoint\n",
            )
            code, result, _ = self.preflight(repo)
        self.assertEqual(code, 3)
        self.assertTrue(any(reason.startswith("legacy-coordinator-not-terminal:") for reason in result["reasons"]))

    def test_exact_ancestral_migration_evidence_retires_legacy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            legacy_ref = "refs/heads/codex/release/0.1/coordinator"
            legacy = self.push_coordinator(repo, legacy_ref, "legacy checkpoint\n")
            target = f"{legacy_ref}@{legacy}"
            migration = self.metadata_commit(
                repo,
                self.coordinator_message(
                    repo,
                    extra=(
                        "ACTION_KIND: migrate-legacy-ledger\n"
                        f"ACTION_TARGET: {target}\n"
                        "ACTION_STATUS: reconciled\n"
                        "LEGACY_STOP_EVIDENCE: task-terminal-and-ledger-imported\n"
                    ),
                ),
            )
            canonical = self.metadata_commit(repo, self.coordinator_message(repo), migration)
            self.git(repo, "push", "origin", f"{canonical}:{MODULE.CANONICAL_COORDINATOR_REF}")
            code, result, _ = self.preflight(repo, self.PROOF)
        self.assertEqual((code, result["route"]), (0, "resume"))
        legacy_result = next(item for item in result["coordinator_refs"] if item["kind"] == "legacy")
        self.assertEqual(legacy_result["classification"], "migrated")
        self.assertEqual(legacy_result["migration_evidence"], migration)

    def test_wrong_sha_migration_evidence_does_not_retire_legacy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            legacy_ref = "refs/heads/codex/release/0.1/coordinator"
            self.push_coordinator(repo, legacy_ref, "legacy checkpoint\n")
            migration = self.metadata_commit(
                repo,
                self.coordinator_message(
                    repo,
                    extra=(
                        "ACTION_KIND: migrate-legacy-ledger\n"
                        f"ACTION_TARGET: {legacy_ref}@{'f' * 40}\n"
                        "ACTION_STATUS: reconciled\n"
                        "LEGACY_STOP_EVIDENCE: wrong-target\n"
                    ),
                ),
            )
            self.git(repo, "push", "origin", f"{migration}:{MODULE.CANONICAL_COORDINATOR_REF}")
            code, result, _ = self.preflight(repo, self.PROOF)
        self.assertEqual(code, 3)
        self.assertEqual(result["route"], "blocked")

    def test_non_ancestor_migration_evidence_does_not_retire_legacy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            legacy_ref = "refs/heads/codex/release/0.1/coordinator"
            legacy = self.push_coordinator(repo, legacy_ref, "legacy checkpoint\n")
            evidence = self.metadata_commit(
                repo,
                self.coordinator_message(
                    repo,
                    extra=(
                        "ACTION_KIND: migrate-legacy-ledger\n"
                        f"ACTION_TARGET: {legacy_ref}@{legacy}\n"
                        "ACTION_STATUS: reconciled\n"
                        "LEGACY_STOP_EVIDENCE: detached-evidence\n"
                    ),
                ),
            )
            self.git(repo, "update-ref", "refs/heads/detached-evidence", evidence)
            canonical = self.metadata_commit(repo, self.coordinator_message(repo))
            self.git(repo, "push", "origin", f"{canonical}:{MODULE.CANONICAL_COORDINATOR_REF}")
            code, result, _ = self.preflight(repo, self.PROOF)
        self.assertEqual(code, 3)
        self.assertEqual(result["route"], "blocked")

    def test_materializes_remote_advance_without_fetch_head(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            root = Path(directory)
            repo, remote = self.fixture(root)
            other = root / "other"
            self.git(root, "clone", str(remote), str(other))
            self.git(other, "config", "user.name", "other")
            self.git(other, "config", "user.email", "other@example.invalid")
            (other / "package.json").write_text('{"advanced":true}\n', encoding="utf-8")
            self.git(other, "add", "package.json")
            self.git(other, "commit", "-m", "remote advance")
            advanced = self.git(other, "rev-parse", "HEAD")
            self.git(other, "push", "origin", "main")
            self.assertFalse(MODULE.foreign_main.object_exists(repo, advanced))
            fetch_head = repo / ".git" / "FETCH_HEAD"
            if fetch_head.exists():
                fetch_head.unlink()
            code, result, _ = self.preflight(repo)
            self.assertFalse(MODULE.foreign_main.object_exists(repo, advanced))
            self.assertFalse(fetch_head.exists())
            self.assertTrue(result["contract_matches_head"])
        self.assertEqual(code, 0)
        self.assertEqual(result["remote_sha"], advanced)
        self.assertIsNotNone(result["contract_oid"])
        self.assertEqual(result["primary_checkout"]["relation"], "behind")
        self.assertEqual(result["primary_checkout"]["action"], "continue")


class TransitionTest(GitMixin, unittest.TestCase):
    def invoke(self, repo: Path, parent: str, payload: object) -> tuple[int, dict[str, object]]:
        args = MODULE.argparse.Namespace(repo=str(repo), parent=parent, input="-")
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_transition(args)
            return code, json.loads(output.getvalue())

    def parent_message(self, status: str | None = "reconciled", seq: int = 7, action_id: str | None = None) -> str:
        lines = [
            "coordinator",
            "",
            "SCHEMA: 1",
            "KIND: COORDINATOR_CLAIM",
            f"OWNER_ID: {uuid.uuid4()}",
            "OWNER_PROOF_KIND: runtime-task-id",
            "OWNER_PROOF_DIGEST: " + "e" * 64,
            f"RUN_ID: {uuid.uuid4()}",
            "RUN_KEY: " + "a" * 32,
            f"PROJECT_ID: {uuid.uuid4()}",
            f"MILESTONE_ID: {uuid.uuid4()}",
            "EPOCH: 1",
            "STATE: running",
            "OWNER_STATE: active",
            "CONTRACT_SOURCE_SHA: " + "1" * 40,
            "CONTRACT_DIGEST: " + "2" * 40,
            f"ACTION_SEQ: {seq}",
        ]
        if status in {"intent", "planned"}:
            lines.extend(
                [
                    f"ACTION_ID: {action_id or uuid.uuid4()}",
                    "ACTION_KIND: update-linear-state",
                    "ACTION_TARGET: linear:AND-56",
                    "EXPECTED_BEFORE: state=Backlog",
                    "EXTERNAL_REQUEST_KEY: issue:AND-56:in-progress",
                    "PROVIDER_SELECTOR: linear:issue:AND-56",
                    "PAYLOAD_DIGEST: " + "d" * 64,
                    "EFFECT_IDENTITY: linear:AND-56@In Progress",
                ]
            )
        if status is not None:
            lines.append(f"ACTION_STATUS: {status}")
        return "\n".join(lines) + "\n"

    def test_intent_is_deterministic_read_only_and_increments_seq(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.metadata_commit(repo, self.parent_message())
            payload = {
                "phase": "intent",
                "kind": "update-linear-state",
                "target": "linear:AND-56",
                "expected_before": "state=Backlog",
                "request_key": "issue:AND-56:in-progress",
                "selector": "linear:issue:AND-56",
                "payload_digest": "d" * 64,
                "effect_identity": "linear:AND-56@In Progress",
            }
            code_a, result_a = self.invoke(repo, parent, payload)
            code_b, result_b = self.invoke(repo, parent, payload)
            self.assertEqual(self.git(repo, "rev-parse", "HEAD"), self.git(repo, "rev-parse", "main"))
        self.assertEqual((code_a, code_b), (0, 0))
        self.assertEqual(result_a, result_b)
        rendered = MODULE.fields(result_a["message"])
        self.assertEqual(rendered["ACTION_SEQ"], "8")
        self.assertEqual(rendered["ACTION_STATUS"], "intent")
        uuid.UUID(rendered["ACTION_ID"])
        self.assertEqual(result_a["parent"], parent)
        self.assertEqual(result_a["message_digest"], MODULE.hashlib.sha256(result_a["message"].encode()).hexdigest())

    def test_intent_rejects_pending_parent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.metadata_commit(repo, self.parent_message("intent"))
            code, result = self.invoke(repo, parent, {"phase": "intent"})
        self.assertEqual(code, 2)
        self.assertIn("invalid:parent-action-not-reconciled", result["errors"])

    def test_missing_or_unknown_parent_action_status_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            missing = self.metadata_commit(repo, self.parent_message(None))
            code_missing, result_missing = self.invoke(repo, missing, {"phase": "intent"})
            unknown = self.metadata_commit(repo, self.parent_message("mystery"))
            code_unknown, result_unknown = self.invoke(repo, unknown, {"phase": "intent"})
        self.assertEqual((code_missing, code_unknown), (2, 2))
        self.assertIn("missing:parent-action-status", result_missing["errors"])
        self.assertIn("invalid:parent-action-status", result_unknown["errors"])

    def test_malformed_stable_parent_identity_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            malformed = self.parent_message().replace("EPOCH: 1", "EPOCH: zero")
            parent = self.metadata_commit(repo, malformed)
            code, result = self.invoke(repo, parent, {"phase": "intent"})
        self.assertEqual(code, 2)
        self.assertIn("invalid:parent-epoch", result["errors"])

    def test_phase_specific_unexpected_fields_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.metadata_commit(repo, self.parent_message())
            code, result = self.invoke(
                repo,
                parent,
                {"phase": "intent", "result": "must-not-be-accepted"},
            )
        self.assertEqual(code, 2)
        self.assertEqual(result["errors"], ["unexpected:result"])

    def test_reconcile_preserves_action_identity_and_accepts_legacy_planned(self) -> None:
        action_id = str(uuid.uuid4())
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.metadata_commit(repo, self.parent_message("planned", 9, action_id))
            code, result = self.invoke(
                repo, parent, {"phase": "reconciled", "result": "updatedAt=2026-08-07T14:10:00Z"}
            )
        self.assertEqual(code, 0)
        rendered = MODULE.fields(result["message"])
        self.assertEqual(rendered["ACTION_SEQ"], "9")
        self.assertEqual(rendered["ACTION_ID"], action_id)
        self.assertEqual(rendered["ACTION_STATUS"], "reconciled")
        self.assertEqual(rendered["ACTION_RESULT"], "updatedAt=2026-08-07T14:10:00Z")

    def test_transition_rejects_non_object_and_non_coordinator(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.metadata_commit(repo, "ordinary commit\n")
            code, result = self.invoke(repo, parent, [])
        self.assertEqual(code, 2)
        self.assertIn("invalid:transition:not-object", result["errors"])


if __name__ == "__main__":
    unittest.main()
