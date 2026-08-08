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
        (repo / "package-lock.json").write_text("{}\n", encoding="utf-8")
        (repo / ".gitignore").write_text("node_modules/\n.codex-task/\n", encoding="utf-8")
        self.git(
            repo,
            "add",
            MODULE.SKILL_PATH,
            "AGENTS.md",
            "package.json",
            "package-lock.json",
            ".gitignore",
        )
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
        self.git(repo, "push", "origin", f"{guard_tip}:{guard_ref}")
        task_root = worktree / ".codex-task"
        for name in ("build", "tmp", "runtime", "npm-cache"):
            (task_root / name).mkdir(parents=True)
        dependency_path = worktree / "node_modules"
        dependency_path.mkdir()
        lockfile_digest = MODULE.hashlib.sha256(
            (worktree / "package-lock.json").read_bytes()
        ).hexdigest()
        (task_root / "provision.json").write_text(
            json.dumps(
                {
                    "status": "installed",
                    "lockfile_digest": lockfile_digest,
                    "dependency_path": str(dependency_path.resolve()),
                }
            ),
            encoding="utf-8",
        )
        owner_id = str(uuid.uuid4())
        project_id = str(uuid.uuid4())
        milestone_id = str(uuid.uuid4())
        run_id = "019fdbbd-b0ed-77d1-80a4-f45a253c770f"
        coordinator_message = (
            "coordinator\n\n"
            "SCHEMA: 1\n"
            "KIND: COORDINATOR_CLAIM\n"
            f"RUN_ID: {run_id}\n"
            f"RUN_KEY: {self.RUN_KEY}\n"
            f"OWNER_ID: {owner_id}\n"
            "EPOCH: 1\n"
            f"PROJECT_ID: {project_id}\n"
            f"MILESTONE_ID: {milestone_id}\n"
            "STATE: running\n"
            "OWNER_STATE: active\n"
            "ACTION_SEQ: 0\n"
            "ACTION_STATUS: reconciled\n"
        )
        coordinator_sha = self.metadata_commit(repo, coordinator_message, base)
        self.git(
            repo,
            "push",
            "origin",
            f"{coordinator_sha}:{MODULE.CANONICAL_COORDINATOR_REF}",
        )
        manifest: dict[str, object] = {
            "run_id": run_id,
            "run_key": self.RUN_KEY,
            "owner_id": owner_id,
            "owner_epoch": 1,
            "claim_generation": 1,
            "claim_token": str(uuid.uuid4()),
            "issue_id": str(uuid.uuid4()),
            "issue_identifier": "AND-56",
            "project_id": project_id,
            "milestone_id": milestone_id,
            "repo": str(repo),
            "worktree": str(worktree),
            "branch": branch,
            "feature_ref": f"refs/heads/{branch}",
            "guard_ref": guard_ref,
            "guard_tip": guard_tip,
            "coordinator_sha": coordinator_sha,
            "root_sha": base,
            "base_sha": base,
            "dependency_shas": [],
            "queue_fingerprint": "b" * 64,
            "scope_fingerprint": "c" * 64,
            "issue_updated_at": "2026-08-07T14:00:00.123Z",
            "ownership_paths": ["packages/domain/src/index.ts"],
            "executor": {
                "lease_id": str(uuid.uuid4()),
                "mode": "delegated",
                "agent_type": "worker",
                "fork_turns": "none",
            },
            "isolation": {
                "mutable_build_dir": str(task_root / "build"),
                "tmp_dir": str(task_root / "tmp"),
                "runtime_dir": str(task_root / "runtime"),
                "cache_mode": "isolated",
                "cache_dir": str(task_root / "npm-cache"),
                "cache_key": "none",
                "ports": [43123, 43124],
                "env": {"MIND_DIARY_TASK_TMP": str(task_root / "tmp")},
            },
            "dependencies": {
                "mode": "isolated",
                "path": str(dependency_path.resolve()),
                "lockfile_digest": lockfile_digest,
                "cache_key": "none",
                "read_only": False,
                "provenance": f"npm-ci:{lockfile_digest}",
            },
            "validation": {
                "targeted_checks": [
                    {
                        "id": "domain-invariants",
                        "argv": ["node", "--test", "tests/unit/domain-invariants.test.mjs"],
                    }
                ],
                "check_class": "targeted-feature",
                "full_gate": "deferred-to-cutoff",
            },
            "remote_mode": "online",
        }
        return repo, worktree, manifest

    def invoke(self, payload: object) -> tuple[int, dict[str, object]]:
        args = MODULE.argparse.Namespace(input="-", phase="dispatch", remote="origin")
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
            payload["validation"]["targeted_checks"] = [  # type: ignore[index]
                {"id": "full", "argv": ["npm", "run", "check"]}
            ]
            code, result = self.invoke(payload)
        self.assertEqual(code, 2)
        self.assertIn("invalid:isolation.tmp_dir:outside-worktree", result["errors"])
        self.assertIn("invalid:validation.targeted_checks:full-suite", result["errors"])

    def test_rejects_executor_reuse_shape_and_dependency_install(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            payload["executor"]["fork_turns"] = "all"  # type: ignore[index]
            payload["validation"]["targeted_checks"] = [  # type: ignore[index]
                {"id": "install", "argv": ["npm", "ci"]}
            ]
            code, result = self.invoke(payload)
        self.assertEqual(code, 2)
        self.assertIn("invalid:executor.fork_turns", result["errors"])
        self.assertIn(
            "invalid:validation.targeted_checks:dependency-mutation", result["errors"]
        )

    def test_rejects_duplicate_ports_and_scope_timestamp_confusion(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            payload["isolation"]["ports"] = [43123, 43123]  # type: ignore[index]
            payload["scope_fingerprint"] = payload["issue_updated_at"]
            code, result = self.invoke(payload)
        self.assertEqual(code, 2)
        self.assertIn("invalid:isolation.ports", result["errors"])
        self.assertIn("invalid:scope_fingerprint", result["errors"])

    def test_accepts_connector_identifier_when_linear_uuid_is_not_exposed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-manifest-") as directory:
            _, _, payload = self.manifest_fixture(Path(directory))
            payload["issue_id"] = payload["issue_identifier"]
            code, result = self.invoke(payload)
            payload["issue_id"] = "AND-147"
            mismatch_code, mismatch = self.invoke(payload)
        self.assertEqual((code, result["status"]), (0, "valid"))
        self.assertEqual(mismatch_code, 2)
        self.assertIn("invalid:issue_id", mismatch["errors"])

    def test_receipt_verifier_binds_ready_feature_guard_scope_and_diff(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-receipt-") as directory:
            root = Path(directory)
            repo, worktree, manifest = self.manifest_fixture(root)
            source = worktree / "packages/domain/src/index.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export const value = 1;\n", encoding="utf-8")
            self.git(worktree, "add", "packages/domain/src/index.ts")
            self.git(worktree, "commit", "-m", "AND-56 implement domain invariant")
            head = self.git(worktree, "rev-parse", "HEAD")
            self.git(worktree, "push", "origin", manifest["branch"])
            checks_digest = "d" * 64
            guard_message = (
                "ready guard\n\n"
                "SCHEMA: 1\n"
                "KIND: CLAIM_GUARD\n"
                "STATE: ready\n"
                "ISSUE: AND-56\n"
                "CLAIM_GENERATION: 1\n"
                f"FEATURE_HEAD: {head}\n"
                f"CHECKS_DIGEST: {checks_digest}\n"
            )
            ready_guard = self.metadata_commit(
                repo, guard_message, str(manifest["guard_tip"])
            )
            self.git(repo, "update-ref", str(manifest["guard_ref"]), ready_guard)
            self.git(
                repo,
                "push",
                "origin",
                f"{ready_guard}:{manifest['guard_ref']}",
            )
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            receipt = "\n".join(
                [
                    "STATUS: ready",
                    f"RUN_ID: {manifest['run_id']}",
                    f"RUN_KEY: {manifest['run_key']}",
                    f"OWNER: id={manifest['owner_id']}; epoch=1",
                    f"CLAIM: generation=1; token={manifest['claim_token']}",
                    f"ISSUE: AND-56 ({manifest['issue_id']})",
                    f"WORKTREE: {worktree}",
                    f"BRANCH: {manifest['branch']}",
                    f"BASE_SHA: {manifest['base_sha']}",
                    f"HEAD_SHA: {head}",
                    f"SCOPE: start_fingerprint={manifest['scope_fingerprint']}; final_fingerprint={manifest['scope_fingerprint']}; unchanged",
                    f"ORIGIN_REF: {manifest['branch']}={head}",
                    f"GUARD: origin:{manifest['guard_ref']}={ready_guard}",
                    "CHECK_CLASS: targeted-feature",
                    "TARGETED_CHECKS: domain-invariants=pass",
                    f"CHECKS_DIGEST: {checks_digest}",
                    "FULL_GATE: deferred-to-cutoff",
                    f"EXECUTOR: lease={manifest['executor']['lease_id']}; mode=delegated; fresh=yes",  # type: ignore[index]
                    "GAPS: none",
                    "DIRTY_REMAINDER: none",
                    "DEFECT_CANDIDATE: none",
                    "NEXT: none",
                ]
            ) + "\n"
            args = MODULE.argparse.Namespace(
                manifest=str(manifest_path),
                input="-",
                remote="origin",
                current_scope_fingerprint=manifest["scope_fingerprint"],
            )
            with mock.patch.object(sys, "stdin", io.StringIO(receipt)), io.StringIO() as output, redirect_stdout(output):
                code = MODULE.command_receipt_verify(args)
                result = json.loads(output.getvalue())
        self.assertEqual((code, result["status"], result["verified"]), (0, "ready", True))
        self.assertEqual(result["head_sha"], head)

    def test_receipt_verifier_rejects_duplicate_authoritative_header(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-receipt-") as directory:
            root = Path(directory)
            _, _, manifest = self.manifest_fixture(root)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            args = MODULE.argparse.Namespace(
                manifest=str(manifest_path),
                input="-",
                remote="origin",
                current_scope_fingerprint=manifest["scope_fingerprint"],
            )
            with mock.patch.object(sys, "stdin", io.StringIO("STATUS: failed\nSTATUS: ready\n")), io.StringIO() as output, redirect_stdout(output):
                code = MODULE.command_receipt_verify(args)
                result = json.loads(output.getvalue())
        self.assertEqual((code, result["status"], result["verified"]), (2, "invalid", False))
        self.assertIn("invalid:receipt-duplicate:STATUS", result["errors"])


class InvocationTest(unittest.TestCase):
    def invoke(self, text: str) -> tuple[int, dict[str, object]]:
        with io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_invocation(mock.Mock(text=text))
            return code, json.loads(output.getvalue())

    def test_defaults_to_one_and_ignores_issue_numbers(self) -> None:
        code, result = self.invoke("$ship-linear-release milestone AND-84 version 6")
        self.assertEqual((code, result["workers"], result["worker_mode"]), (0, 1, "exact"))

    def test_accepts_exact_numeric_and_russian_word_forms(self) -> None:
        _, assignment = self.invoke("$ship-linear-release workers=6")
        _, threads = self.invoke("запусти skill в 4 потока")
        _, words = self.invoke("запусти три воркера")
        self.assertEqual(
            (assignment["workers"], threads["workers"], words["workers"]),
            (6, 4, 3),
        )

    def test_accepts_auto_out_alias_maximum_and_dry_run(self) -> None:
        code, result = self.invoke("workers=out, не больше 6, dry-run")
        self.assertEqual((code, result["workers"], result["max_workers"]), (0, "auto", 6))
        self.assertTrue(result["dry_run"])

    def test_conflicting_worker_counts_fail_before_mutation(self) -> None:
        code, result = self.invoke("workers=4 и 6 воркеров")
        self.assertEqual((code, result["status"]), (2, "invalid"))
        self.assertIn("ambiguous:workers", result["errors"])

    def test_explicit_nonpositive_or_unknown_worker_value_is_invalid(self) -> None:
        zero_code, zero = self.invoke("workers=0")
        bad_code, bad = self.invoke("workers=many")
        self.assertEqual((zero_code, bad_code), (2, 2))
        self.assertIn("invalid:workers", zero["errors"])
        self.assertIn("invalid:workers", bad["errors"])


class GoalAndMilestonePlanTest(unittest.TestCase):
    def test_goal_card_is_bounded_and_contains_exact_contract_identity(self) -> None:
        args = MODULE.argparse.Namespace(
            repo="/repo/MindDiary",
            project_name="Mind Diary",
            project_id=str(uuid.uuid4()),
            milestone_name="MVP",
            milestone_id=str(uuid.uuid4()),
            run_id=str(uuid.uuid4()),
            run_key="a" * 32,
            owner_id=str(uuid.uuid4()),
            epoch=2,
            contract_sha="b" * 40,
        )
        with io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_goal_card(args)
            result = json.loads(output.getvalue())
        self.assertEqual((code, result["status"]), (0, "valid"))
        self.assertLessEqual(result["characters"], MODULE.MAX_GOAL_CHARS)
        self.assertIn(args.milestone_id, result["objective"])
        self.assertIn(args.contract_sha, result["objective"])
        self.assertNotIn("profile", result["objective"].lower())

    def milestone(self, issues: list[dict[str, object]]) -> tuple[int, dict[str, object]]:
        milestone_id = str(uuid.uuid4())
        for issue in issues:
            issue["milestone_id"] = milestone_id
        payload = {
            "project": {"id": str(uuid.uuid4()), "name": "Mind Diary"},
            "milestones": [{"id": milestone_id, "name": "MVP", "current": True}],
            "issues": issues,
        }
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_milestone_plan(MODULE.argparse.Namespace(input="-"))
            return code, json.loads(output.getvalue())

    def test_milestone_plan_resolves_dependency_frontier(self) -> None:
        code, result = self.milestone(
            [
                {
                    "identifier": "AND-1",
                    "state": "Done",
                    "dependencies": [],
                    "production_requirement": "not-required",
                },
                {
                    "identifier": "AND-2",
                    "state": "Todo",
                    "dependencies": ["AND-1"],
                    "production_requirement": "not-required",
                },
            ]
        )
        self.assertEqual((code, result["status"], result["ready"]), (0, "planned", ["AND-2"]))
        self.assertEqual(result["production_requirement"], "not-required")

    def test_milestone_plan_fails_early_on_cycle(self) -> None:
        code, result = self.milestone(
            [
                {"identifier": "AND-1", "state": "Todo", "dependencies": ["AND-2"]},
                {"identifier": "AND-2", "state": "Todo", "dependencies": ["AND-1"]},
            ]
        )
        self.assertEqual((code, result["status"]), (3, "blocked"))
        self.assertIn("dependency-cycle", result["structural_reasons"])


class ConveyorStateMachineTest(unittest.TestCase):
    def invoke(self, payload: object) -> tuple[int, dict[str, object]]:
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_conveyor_next(MODULE.argparse.Namespace(input="-"))
            return code, json.loads(output.getvalue())

    def event(self, state: str, event: str, evidence: dict[str, str]) -> dict[str, object]:
        return {
            "schema": 1,
            "run_id": str(uuid.uuid4()),
            "issue_identifier": "AND-56",
            "generation": 1,
            "state": state,
            "event": event,
            "event_id": str(uuid.uuid4()),
            "evidence": evidence,
        }

    def test_happy_path_transition_is_deterministic(self) -> None:
        payload = self.event(
            "running",
            "receipt-verified",
            {
                "receipt_digest": "a" * 64,
                "head_sha": "b" * 40,
                "checks_digest": "c" * 64,
            },
        )
        code_a, first = self.invoke(payload)
        code_b, second = self.invoke(payload)
        self.assertEqual((code_a, code_b), (0, 0))
        self.assertEqual(first, second)
        self.assertEqual(first["state_after"], "feature_ready")

    def test_wrong_event_and_incomplete_evidence_fail_closed(self) -> None:
        code, result = self.invoke(
            self.event("running", "gate-passed", {"head_sha": "b" * 40})
        )
        self.assertEqual((code, result["status"]), (2, "invalid"))
        self.assertIn("invalid:event-for-state", result["errors"])
        self.assertIn("missing:evidence.receipt_digest", result["errors"])

    def test_terminal_state_cannot_advance(self) -> None:
        code, result = self.invoke(self.event("terminal", "dispatch", {}))
        self.assertEqual((code, result["status"]), (2, "invalid"))
        self.assertIn("invalid:state", result["errors"])


class DeliveryContractTest(unittest.TestCase):
    def test_runtime_contract_contains_no_profile_or_intent_switches(self) -> None:
        repo = SCRIPTS.parents[3]
        paths = [
            repo / ".agents/skills/ship-linear-release/SKILL.md",
            repo / ".agents/skills/ship-linear-release/references/goal-card.md",
            repo / ".agents/skills/ship-linear-release/references/batch-release.md",
            repo / ".agents/skills/ship-linear-release/references/receipts.md",
            repo / ".agents/skills/ship-linear-release/references/github-outage.md",
            repo / ".agents/skills/ship-linear-release/scripts/shipctl.py",
            repo / ".agents/skills/ship-linear-release/agents/openai.yaml",
        ]
        forbidden = (
            "delivery_profile",
            "target_profile",
            "PROFILE_RANK",
            "--profile",
            "--intent",
            "PROFILE: design | build | release",
        )
        for path in paths:
            text = path.read_text(encoding="utf-8")
            for marker in forbidden:
                with self.subTest(path=path.name, marker=marker):
                    self.assertNotIn(marker, text)

    def test_metadata_and_defect_policy_match_autonomous_delivery(self) -> None:
        repo = SCRIPTS.parents[3]
        metadata = (
            repo / ".agents/skills/ship-linear-release/agents/openai.yaml"
        ).read_text(encoding="utf-8")
        triage = (
            repo / ".agents/skills/ship-linear-release/references/defect-triage.md"
        ).read_text(encoding="utf-8")
        self.assertIn("без worker count работай одним worker", metadata)
        self.assertIn("workers=auto", metadata)
        self.assertIn("stabilization Bug", triage)
        self.assertIn("новый product/security decision", triage)
        self.assertNotIn("верни `STATUS: needs-input`", triage)


class LaunchAndDispatchTest(unittest.TestCase):
    def launch(self, **overrides: object) -> tuple[int, dict[str, object]]:
        values: dict[str, object] = {
            "workers": "6",
            "max_workers": None,
            "runtime_slots_total": 4,
            "runtime_source": "system-capacity",
            "safe_resource_capacity": 3,
            "resource_source": "provisioner",
            "compatible_ready": 10,
            "unfinished": 10,
            "running": 0,
            "layout": "auto",
        }
        values.update(overrides)
        with io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_launch_check(mock.Mock(**values))
            return code, json.loads(output.getvalue())

    def dispatch(self, payload: object) -> tuple[int, dict[str, object]]:
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_dispatch_check(
                MODULE.argparse.Namespace(input="-", remote="origin")
            )
            return code, json.loads(output.getvalue())

    def entry(self, issue: str, path: str, lease: str | None = None) -> dict[str, object]:
        suffix = issue.lower()
        return {
            "issue_identifier": issue,
            "ownership_paths": [path],
            "executor": {
                "lease_id": lease or str(uuid.uuid4()),
                "mode": "delegated",
                "agent_type": "worker",
                "fork_turns": "none",
            },
            "isolation": {
                "mutable_build_dir": f"/tmp/{suffix}/build",
                "tmp_dir": f"/tmp/{suffix}/tmp",
                "runtime_dir": f"/tmp/{suffix}/runtime",
                "cache_mode": "isolated",
                "cache_dir": f"/tmp/{suffix}/cache",
                "cache_key": "none",
                "ports": [],
            },
        }

    def test_exact_workers_fail_closed_when_runtime_capacity_is_smaller(self) -> None:
        code, result = self.launch()
        self.assertEqual((code, result["status"], result["claim_allowed"]), (3, "blocked", False))
        self.assertEqual(result["sustained_issue_capacity"], 3)
        self.assertIn("exact-worker-capacity-unavailable:requested=6;sustained=3", result["reasons"])

    def test_auto_adapts_and_exact_capacity_is_ready_set_limited(self) -> None:
        auto_code, auto = self.launch(workers="auto")
        limited_code, limited = self.launch(
            workers="3", runtime_slots_total=4, compatible_ready=1
        )
        self.assertEqual((auto_code, auto["sustained_issue_capacity"]), (0, 3))
        self.assertEqual((limited_code, limited["active_target"]), (0, 1))
        self.assertEqual(limited["reasons"], ["ready-set-limited"])

    def test_unfinished_graph_without_ready_or_running_work_fails_early(self) -> None:
        code, result = self.launch(workers="auto", compatible_ready=0, running=0)
        self.assertEqual((code, result["status"]), (3, "blocked"))
        self.assertIn("no-actionable-frontier", result["reasons"])

    def test_running_generation_keeps_empty_frontier_recoverable(self) -> None:
        code, result = self.launch(
            workers="auto", compatible_ready=0, running=1
        )
        self.assertEqual((code, result["status"]), (0, "ok"))
        self.assertNotIn("no-actionable-frontier", result["reasons"])

    def test_zero_resource_capacity_is_a_blocker_not_invalid_input(self) -> None:
        code, result = self.launch(
            workers="auto", safe_resource_capacity=0, compatible_ready=1
        )
        self.assertEqual((code, result["status"]), (3, "blocked"))
        self.assertIn("no-sustainable-worker-capacity", result["reasons"])

    def test_complete_milestone_does_not_require_ready_frontier(self) -> None:
        code, result = self.launch(
            workers="auto", unfinished=0, compatible_ready=0, running=0
        )
        self.assertEqual((code, result["status"]), (0, "ok"))
        self.assertNotIn("no-actionable-frontier", result["reasons"])

    def test_dispatch_rejects_skeletal_manifests_before_overlap_analysis(self) -> None:
        active = self.entry("AND-86", "packages/composition-root")
        candidate = self.entry("AND-88", "packages/composition-root/src/index.ts")
        serial_code, serial = self.dispatch({"candidate": candidate, "active": [active], "executor_history": []})
        lease = candidate["executor"]["lease_id"]  # type: ignore[index]
        reuse_code, reuse = self.dispatch({"candidate": candidate, "active": [], "executor_history": [lease]})
        self.assertEqual((serial_code, serial["status"]), (2, "invalid"))
        self.assertEqual((reuse_code, reuse["status"]), (2, "invalid"))
        self.assertTrue(any(error.startswith("candidate:missing:") for error in serial["errors"]))
        self.assertIn("invalid:executor-reuse", reuse["errors"])

    def test_path_overlap_is_segment_aware(self) -> None:
        self.assertTrue(
            MODULE._paths_overlap(
                "packages/composition-root", "packages/composition-root/src/index.ts"
            )
        )
        self.assertFalse(
            MODULE._paths_overlap("packages/adapter-mcp", "packages/composition-root")
        )

    def test_dispatch_never_accepts_a_disjoint_but_unbound_entry(self) -> None:
        code, result = self.dispatch(
            {
                "candidate": self.entry("AND-88", "packages/adapter-mcp"),
                "active": [self.entry("AND-86", "packages/composition-root")],
                "executor_history": [],
            }
        )
        self.assertEqual((code, result["status"], result["dispatch_allowed"]), (2, "invalid", False))


class MetadataCommitTest(GitMixin, unittest.TestCase):
    def test_metadata_helper_uses_empty_workflow_free_tree(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-metadata-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.git(repo, "rev-parse", "HEAD")
            message = "guard\n\nKIND: CLAIM_GUARD\nSTATE: claimed\n"
            args = MODULE.argparse.Namespace(repo=str(repo), parent=parent, kind="guard", input="-")
            with mock.patch.object(sys, "stdin", io.StringIO(message)), io.StringIO() as output, redirect_stdout(output):
                code = MODULE.command_metadata_commit(args)
                result = json.loads(output.getvalue())
            empty_tree = self.git(repo, "mktree")
            commit_tree = self.git(repo, "show", "-s", "--format=%T", result["commit"])
            commit_parent = self.git(repo, "rev-parse", f"{result['commit']}^")
        self.assertEqual((code, result["status"]), (0, "created"))
        self.assertEqual(result["tree_mode"], "empty-workflow-free")
        self.assertEqual((commit_tree, commit_parent), (empty_tree, parent))

    def test_metadata_helper_rejects_duplicate_scalar_headers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-metadata-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.git(repo, "rev-parse", "HEAD")
            message = "coordinator\n\nSTATE: running\nSTATE: complete\n"
            args = MODULE.argparse.Namespace(
                repo=str(repo), parent=parent, kind="coordinator", input="-"
            )
            with mock.patch.object(sys, "stdin", io.StringIO(message)), io.StringIO() as output, redirect_stdout(output):
                code = MODULE.command_metadata_commit(args)
                result = json.loads(output.getvalue())
        self.assertEqual((code, result["status"]), (2, "invalid"))
        self.assertEqual(
            result["errors"], ["invalid:duplicate-authoritative-header:STATE"]
        )

    def test_metadata_helper_accepts_repeatable_linear_done_history(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-metadata-") as directory:
            repo, _ = self.fixture(Path(directory))
            parent = self.git(repo, "rev-parse", "HEAD")
            message = (
                "coordinator\n\n"
                "KIND: COORDINATOR_CLAIM\n"
                "LINEAR_DONE: AND-47@2026-08-07T23:29:03Z\n"
                "LINEAR_DONE: AND-82@2026-08-07T23:29:01Z\n"
            )
            args = MODULE.argparse.Namespace(
                repo=str(repo), parent=parent, kind="coordinator", input="-"
            )
            with mock.patch.object(sys, "stdin", io.StringIO(message)), io.StringIO() as output, redirect_stdout(output):
                code = MODULE.command_metadata_commit(args)
                result = json.loads(output.getvalue())
        self.assertEqual((code, result["status"]), (0, "created"))


class ProvisionAndCleanupTest(GitMixin, unittest.TestCase):
    def terminal_coordinator(self, repo: Path) -> str:
        parent = self.git(repo, "rev-parse", "HEAD")
        message = (
            "terminal coordinator\n\n"
            "SCHEMA: 1\n"
            "KIND: COORDINATOR_CLAIM\n"
            "STATE: complete\n"
            "OWNER_STATE: complete\n"
            "ACTION_STATUS: reconciled\n"
            "PENDING_ACTIONS: none\n"
            f"CLAIM_INDEX: active=none;entries=0;digest={'1' * 64}\n"
            f"EXECUTION_INDEX: running_count=0;entries=none;digest={'2' * 64}\n"
            "WORKERS: active_issue_lanes=none\n"
        )
        coordinator = self.metadata_commit(repo, message, parent)
        self.git(
            repo,
            "push",
            "origin",
            f"{coordinator}:{MODULE.CANONICAL_COORDINATOR_REF}",
        )
        return coordinator

    def test_provision_prepares_and_adopts_exact_task_owned_environment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-provision-") as directory:
            root = Path(directory)
            repo, _ = self.fixture(root)
            branch = "codex/and-56-provision/r" + "a" * 32 + "-e1-c1"
            self.git(repo, "branch", branch)
            worktree = root / "worker"
            self.git(repo, "worktree", "add", str(worktree), branch)
            args = MODULE.argparse.Namespace(
                repo=str(repo),
                worktree=str(worktree),
                package_manager="npm",
                install=False,
                timeout_seconds=900,
            )
            with io.StringIO() as output, redirect_stdout(output):
                prepared_code = MODULE.command_provision_worktree(args)
                prepared = json.loads(output.getvalue())
            dependency_path = Path(prepared["dependency_path"])
            dependency_path.mkdir()
            receipt = {
                "status": "installed",
                "environment_id": prepared["environment_id"],
                "lockfile_digest": prepared["lockfile_digest"],
                "dependency_path": str(dependency_path),
            }
            (worktree / ".codex-task/provision.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            with io.StringIO() as output, redirect_stdout(output):
                adopted_code = MODULE.command_provision_worktree(args)
                adopted = json.loads(output.getvalue())
        self.assertEqual((prepared_code, prepared["status"]), (4, "prepared"))
        self.assertEqual((adopted_code, adopted["status"]), (0, "adopted"))
        self.assertEqual(adopted["environment_id"], prepared["environment_id"])

    def test_cleanup_requires_fresh_digest_and_removes_only_clean_merged_worktree(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-cleanup-") as directory:
            root = Path(directory)
            repo, _ = self.fixture(root)
            branch = "codex/and-56-clean/r" + "a" * 32 + "-e1-c1"
            self.git(repo, "branch", branch)
            worktree = root / "worker"
            self.git(repo, "worktree", "add", str(worktree), branch)
            unbound_branch = "codex/scratch"
            self.git(repo, "branch", unbound_branch)
            unbound_worktree = root / "unbound-worker"
            self.git(repo, "worktree", "add", str(unbound_worktree), unbound_branch)
            unbound_head = self.git(repo, "rev-parse", "HEAD")
            plan_args = MODULE.argparse.Namespace(
                repo=str(repo), remote="origin", default="main"
            )
            with io.StringIO() as output, redirect_stdout(output):
                blocked_code = MODULE.command_cleanup_plan(plan_args)
                blocked = json.loads(output.getvalue())
            coordinator = self.terminal_coordinator(repo)
            with io.StringIO() as output, redirect_stdout(output):
                plan_code = MODULE.command_cleanup_plan(plan_args)
                plan = json.loads(output.getvalue())
            stale = dict(plan)
            stale["plan_digest"] = "f" * 64
            apply_args = MODULE.argparse.Namespace(
                repo=str(repo), remote="origin", default="main", input="-"
            )
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(stale))), io.StringIO() as output, redirect_stdout(output):
                stale_code = MODULE.command_cleanup_apply(apply_args)
                stale_result = json.loads(output.getvalue())
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(plan))), io.StringIO() as output, redirect_stdout(output):
                apply_code = MODULE.command_cleanup_apply(apply_args)
                applied = json.loads(output.getvalue())
            unbound_path = str(unbound_worktree.resolve())
            unbound_retained_after_apply = unbound_worktree.exists()
        self.assertEqual(
            (blocked_code, blocked["reason"]), (3, "terminal-coordinator-required")
        )
        self.assertEqual((plan_code, plan["status"]), (0, "planned"))
        self.assertEqual(plan["coordinator_sha"], coordinator)
        self.assertIn(
            {
                "path": unbound_path,
                "branch": unbound_branch,
                "head": unbound_head,
                "reason": "unbound-codex-branch",
            },
            plan["retained"],
        )
        self.assertEqual((stale_code, stale_result["reason"]), (3, "cleanup-plan-stale"))
        self.assertEqual((apply_code, applied["status"]), (0, "cleaned"))
        self.assertIn(str(worktree.resolve()), applied["removed"])
        self.assertTrue(unbound_retained_after_apply)


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

    def soft_pause(
        self, repo: Path, phase: str, payload: object
    ) -> tuple[int, dict[str, object]]:
        args = mock.Mock(
            repo=str(repo),
            remote="origin",
            default="main",
            phase=phase,
            input="-",
        )
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_soft_pause(args)
            return code, json.loads(output.getvalue())

    def test_clean_preflight_is_normal_and_has_no_delivery_profile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            code, result, size = self.preflight(repo)
        self.assertEqual((code, result["route"]), (0, "normal"))
        self.assertNotIn("delivery_profile", result)
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

    def test_runtime_thread_identity_proves_resume_without_manual_digest(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        proof = MODULE.hashlib.sha256(thread_id.encode()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(repo, proof=proof),
            )
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}):
                code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (0, "resume"))
        self.assertTrue(result["mutation_allowed"])

    def test_same_owner_can_soft_pause_an_operating_gate_phase_without_workers(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        proof = MODULE.hashlib.sha256(thread_id.encode()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="validating",
                    proof=proof,
                    extra=(
                        "EXECUTION_INDEX: running_count=0;entries=none\n"
                        "WORKERS: active_issue_lanes=none\n"
                        "PENDING_ACTIONS: none\n"
                    ),
                ),
            )
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}):
                code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (0, "resume"))
        lifecycle = result["coordinator_refs"][0]["lifecycle"]
        self.assertEqual((lifecycle["coherent"], lifecycle["phase"]), (True, "validating"))

    def test_same_owner_can_soft_pause_after_recovery_inventory_or_complete(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        proof = MODULE.hashlib.sha256(thread_id.encode()).hexdigest()
        for recovery_phase in ("inventory", "complete"):
            with self.subTest(recovery_phase=recovery_phase), tempfile.TemporaryDirectory(
                prefix="shipctl-recovery-pause-"
            ) as directory:
                repo, _ = self.fixture(Path(directory))
                head = self.git(repo, "rev-parse", "HEAD")
                self.push_coordinator(
                    repo,
                    MODULE.CANONICAL_COORDINATOR_REF,
                    self.coordinator_message(
                        repo,
                        state="recovering",
                        proof=proof,
                        extra=(
                            f"OWNER_ID: {uuid.uuid4()}\n"
                            "OWNER_PROOF_KIND: runtime-task-id\n"
                            f"RUN_ID: {uuid.uuid4()}\n"
                            f"RUN_KEY: {'a' * 32}\n"
                            f"PROJECT_ID: {uuid.uuid4()}\n"
                            f"MILESTONE_ID: {uuid.uuid4()}\n"
                            "EPOCH: 3\n"
                            f"CONTRACT_SOURCE_SHA: {head}\n"
                            f"LIFECYCLE: schema=1;phase=recovering;pause=none;transition={uuid.uuid4()}\n"
                            "PAUSE: state=lifted;reason=handoff-consumed\n"
                            "HOLD_PAUSE_INDEX: active=none;entries=0\n"
                            "PENDING_ACTIONS: none\n"
                            "PIPELINE: open_cutoff=none;active_cutoff=none\n"
                            "GATE_INDEX: active=none;entries=0\n"
                            "EXECUTION_INDEX: running_count=0;entries=AND-61:3@executor=stopped\n"
                            "WORKERS: active_target=1;active_issue_lanes=none;stopped=AND-61;"
                            "ready_preserved=AND-84,AND-87;refill_blocker=none\n"
                            f"RECOVERY: generation=4;cause=handoff;phase={recovery_phase};unresolved=none\n"
                            "ACTION_KIND: recovery-checkpoint\n"
                        ),
                    ),
                )
                with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}):
                    _, before, _ = self.preflight(repo)
                    code, result = self.soft_pause(
                        repo, "start", {"evidence_digest": "1" * 64}
                    )
                    _, after, _ = self.preflight(repo)
                    finish_code, finished = self.soft_pause(
                        repo,
                        "finish",
                        {"settlement": "complete", "evidence_digest": "2" * 64},
                    )
                    _, final, _ = self.preflight(repo)

                self.assertEqual(before["route"], "recover-owner")
                self.assertEqual((code, result["status"]), (0, "settling"))
                self.assertEqual(after["route"], "drain-owner")
                self.assertEqual(
                    after["coordinator_refs"][0]["lifecycle"]["phase"], "settling"
                )
                self.assertEqual(
                    (finish_code, finished["status"]), (0, "handoff-ready")
                )
                self.assertEqual(final["route"], "takeover")

    def test_soft_pause_does_not_skip_recovery_fencing(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        proof = MODULE.hashlib.sha256(thread_id.encode()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="shipctl-recovery-fencing-pause-") as directory:
            repo, _ = self.fixture(Path(directory))
            head = self.git(repo, "rev-parse", "HEAD")
            parent = self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="recovering",
                    proof=proof,
                    extra=(
                        f"OWNER_ID: {uuid.uuid4()}\n"
                        "OWNER_PROOF_KIND: runtime-task-id\n"
                        f"RUN_ID: {uuid.uuid4()}\n"
                        f"RUN_KEY: {'a' * 32}\n"
                        f"PROJECT_ID: {uuid.uuid4()}\n"
                        f"MILESTONE_ID: {uuid.uuid4()}\n"
                        "EPOCH: 3\n"
                        f"CONTRACT_SOURCE_SHA: {head}\n"
                        f"LIFECYCLE: schema=1;phase=recovering;pause=none;transition={uuid.uuid4()}\n"
                        "PAUSE: state=lifted;reason=handoff-consumed\n"
                        "HOLD_PAUSE_INDEX: active=none;entries=0\n"
                        "PENDING_ACTIONS: none\n"
                        "EXECUTION_INDEX: running_count=0;entries=none\n"
                        "WORKERS: active_target=0;active_issue_lanes=none\n"
                        "RECOVERY: generation=4;cause=handoff;phase=fencing;unresolved=none\n"
                        "ACTION_KIND: takeover-owner\n"
                    ),
                ),
            )
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}):
                code, result = self.soft_pause(
                    repo, "start", {"evidence_digest": "1" * 64}
                )
            observed = self.git(
                repo, "ls-remote", "origin", MODULE.CANONICAL_COORDINATOR_REF
            ).split()[0]

        self.assertEqual((code, result["status"]), (3, "blocked"))
        self.assertEqual(result["reason"], "soft-pause-phase-not-eligible")
        self.assertEqual(observed, parent)

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

    def test_recover_stale_owner_requires_stop_proof_and_advances_epoch(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        with tempfile.TemporaryDirectory(prefix="shipctl-stale-owner-") as directory:
            repo, _ = self.fixture(Path(directory))
            head = self.git(repo, "rev-parse", "HEAD")
            parent = self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="validating",
                    proof="a" * 64,
                    extra=(
                        f"OWNER_ID: {uuid.uuid4()}\n"
                        "OWNER_PROOF_KIND: runtime-task-id\n"
                        f"RUN_ID: {uuid.uuid4()}\n"
                        f"RUN_KEY: {'b' * 32}\n"
                        f"PROJECT_ID: {uuid.uuid4()}\n"
                        f"MILESTONE_ID: {uuid.uuid4()}\n"
                        "EPOCH: 4\n"
                        f"CONTRACT_SOURCE_SHA: {head}\n"
                        "EXECUTION_INDEX: running_count=0;entries=none\n"
                        "WORKERS: active_issue_lanes=none\n"
                        "PENDING_ACTIONS: none\n"
                    ),
                ),
            )
            args = MODULE.argparse.Namespace(
                repo=str(repo),
                remote="origin",
                default="main",
                proof_kind="task-terminal",
                proof_digest="f" * 64,
            )
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}), io.StringIO() as output, redirect_stdout(output):
                code = MODULE.command_recover_stale_owner(args)
                result = json.loads(output.getvalue())
            observed = self.git(
                repo, "ls-remote", "origin", MODULE.CANONICAL_COORDINATOR_REF
            ).split()[0]
            message = self.git(repo, "show", "-s", "--format=%B", observed)
        self.assertEqual((code, result["status"], result["epoch"]), (0, "taken", 5))
        self.assertNotEqual(observed, parent)
        self.assertIn(
            "STALE_OWNER_PROOF: kind=task-terminal;digest=" + "f" * 64,
            message,
        )

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

    def test_lifecycle_validates_current_quiescent_shape_independent_of_last_action(self) -> None:
        pause_id = "pause-28cb9f4d-e177-4a23-aa8f-2c8323fbb238"
        message = (
            "STATE: checkpoint\n"
            "OWNER_STATE: handoff-ready\n"
            "ACTION_KIND: reconcile-pause-index\n"
            "ACTION_STATUS: reconciled\n"
            f"PAUSE: id={pause_id};state=active;kind=PAUSE;scope=all-shared;"
            "confirmation_required=yes;resume_predicate=fresh-explicit-user-launch-after-test;"
            f"evidence={'1' * 64};after=28cb9f4d-e177-4a23-aa8f-2c8323fbb238;"
            "created_at=2026-08-07T17:31:29Z;drained_at=2026-08-07T17:33:30Z\n"
            f"HOLD_PAUSE_INDEX: active={pause_id}:PAUSE@all-shared;entries=1\n"
            "EXECUTION_INDEX: running_count=0;entries=4\n"
            "WORKERS: active_issue_lanes=none\n"
            "PENDING_ACTIONS: none\n"
        )
        lifecycle = MODULE._coordinator_lifecycle(MODULE.fields(message))
        self.assertTrue(lifecycle["coherent"])
        self.assertEqual(lifecycle["phase"], "quiescent")
        self.assertTrue(lifecycle["takeover_ready"])

        revived = message.replace("running_count=0", "running_count=1").replace(
            "active_issue_lanes=none", "active_issue_lanes=AND-47"
        )
        invalid = MODULE._coordinator_lifecycle(MODULE.fields(revived))
        self.assertFalse(invalid["coherent"])
        self.assertFalse(invalid["takeover_ready"])
        self.assertIn("quiescent-running-count-nonzero", invalid["errors"])

    def test_lifecycle_phase_matrix_fails_closed_on_cross_projection_races(self) -> None:
        pause_id = "pause-28cb9f4d-e177-4a23-aa8f-2c8323fbb238"
        transition = "28cb9f4d-e177-4a23-aa8f-2c8323fbb238"
        pause = (
            f"id={pause_id};state=active;kind=PAUSE;scope=dispatch,new-work;"
            f"evidence={'1' * 64};after={transition};"
            "resume_predicate=fresh-explicit-user-launch-after-test;"
            "confirmation_required=yes;created_at=2026-08-07T17:31:29Z"
        )
        base = {
            "STATE": "pausing",
            "OWNER_STATE": "active",
            "ACTION_STATUS": "reconciled",
            "PAUSE": pause,
            "HOLD_PAUSE_INDEX": f"active={pause_id}:PAUSE@dispatch,new-work;entries=1",
            "PENDING_ACTIONS": "none",
        }
        cases = (
            (
                "draining",
                {
                    **base,
                    "EXECUTION_INDEX": "running_count=2;entries=AND-47:2@executor=running,AND-61:3@executor=running",
                    "WORKERS": "active_issue_lanes=AND-47,AND-61",
                    "LIFECYCLE": f"schema=1;phase=draining;pause={pause_id};transition={transition}",
                },
                True,
            ),
            (
                "settling",
                {
                    **base,
                    "EXECUTION_INDEX": "running_count=0;entries=none",
                    "WORKERS": "active_issue_lanes=none",
                    "LIFECYCLE": f"schema=1;phase=settling;pause={pause_id};transition={transition}",
                },
                True,
            ),
            (
                "worker-index-race",
                {
                    **base,
                    "EXECUTION_INDEX": "running_count=2;entries=AND-47:2@executor=running,AND-61:3@executor=running",
                    "WORKERS": "active_issue_lanes=AND-47",
                    "LIFECYCLE": f"schema=1;phase=draining;pause={pause_id};transition={transition}",
                },
                False,
            ),
            (
                "phase-race",
                {
                    **base,
                    "EXECUTION_INDEX": "running_count=0;entries=none",
                    "WORKERS": "active_issue_lanes=none",
                    "LIFECYCLE": f"schema=1;phase=draining;pause={pause_id};transition={transition}",
                },
                False,
            ),
        )
        for name, metadata, coherent in cases:
            with self.subTest(name=name):
                result = MODULE._coordinator_lifecycle(metadata)
                self.assertEqual(result["coherent"], coherent)
                self.assertEqual(result["takeover_ready"], False)

    def test_soft_pause_lifecycle_drains_checkpoints_handoffs_and_resumes_by_cas(self) -> None:
        owner_thread = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        successor_thread = "019fdd4b-37db-7123-830f-bc32654b5e2d"
        proof = MODULE.hashlib.sha256(owner_thread.encode()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="shipctl-soft-pause-") as directory:
            repo, _ = self.fixture(Path(directory))
            head = self.git(repo, "rev-parse", "HEAD")
            parent = self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    proof=proof,
                    extra=(
                        f"OWNER_ID: {uuid.uuid4()}\n"
                        "OWNER_PROOF_KIND: runtime-task-id\n"
                        f"RUN_ID: {uuid.uuid4()}\n"
                        f"RUN_KEY: {'a' * 32}\n"
                        f"PROJECT_ID: {uuid.uuid4()}\n"
                        f"MILESTONE_ID: {uuid.uuid4()}\n"
                        "EPOCH: 1\n"
                        f"CONTRACT_SOURCE_SHA: {head}\n"
                        "PAUSE: state=lifted;reason=none\n"
                        "HOLD: id=hold-known-bad;state=active;scope=default\n"
                        "HOLD_PAUSE_INDEX: active=hold-known-bad:HOLD@default;entries=1\n"
                        "PENDING_ACTIONS: none\n"
                        "PIPELINE: open_cutoff=none;active_cutoff=none\n"
                        "GATE_INDEX: active=none;entries=0\n"
                        "EXECUTION_INDEX: running_count=2;"
                        "entries=AND-47:2@executor=running,AND-61:3@executor=running\n"
                        "WORKERS: active_target=2;active_issue_lanes=AND-47,AND-61;"
                        "ready_preserved=none;refill_blocker=none\n"
                        "ACTION_KIND: dispatch-workers\n"
                    ),
                ),
            )
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": owner_thread}):
                start_code, started = self.soft_pause(
                    repo, "start", {"evidence_digest": "1" * 64}
                )
                _, draining, _ = self.preflight(repo)
                missing_code, missing = self.soft_pause(
                    repo,
                    "checkpoint",
                    {
                        "dispositions": [
                            {
                                "issue": "AND-47",
                                "generation": 2,
                                "state": "coordinator-paused",
                                "head": "none",
                                "evidence_digest": "2" * 64,
                            }
                        ]
                    },
                )
                still_draining = self.git(
                    repo, "ls-remote", "origin", MODULE.CANONICAL_COORDINATOR_REF
                ).split()[0]
                checkpoint_code, checkpointed = self.soft_pause(
                    repo,
                    "checkpoint",
                    {
                        "dispositions": [
                            {
                                "issue": "AND-47",
                                "generation": 2,
                                "state": "coordinator-paused",
                                "head": "none",
                                "evidence_digest": "2" * 64,
                            },
                            {
                                "issue": "AND-61",
                                "generation": 3,
                                "state": "stopped",
                                "head": "none",
                                "evidence_digest": "3" * 64,
                            },
                        ]
                    },
                )
                _, settling, _ = self.preflight(repo)
                finish_code, finished = self.soft_pause(
                    repo,
                    "finish",
                    {"settlement": "complete", "evidence_digest": "4" * 64},
                )
                _, takeover_ready, _ = self.preflight(repo)
            takeover_args = mock.Mock(repo=str(repo), remote="origin", default="main")
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": successor_thread}):
                with io.StringIO() as output, redirect_stdout(output):
                    takeover_code = MODULE.command_takeover(takeover_args)
                    taken = json.loads(output.getvalue())
                _, recovered, _ = self.preflight(repo)
            final_tip = self.git(
                repo, "ls-remote", "origin", MODULE.CANONICAL_COORDINATOR_REF
            ).split()[0]
            final_message = self.git(repo, "show", "-s", "--format=%B", final_tip)

        self.assertEqual((start_code, started["status"]), (0, "draining"))
        self.assertNotEqual(started["coordinator"], parent)
        self.assertEqual(draining["route"], "drain-owner")
        self.assertEqual(draining["coordinator_refs"][0]["lifecycle"]["phase"], "draining")
        self.assertEqual((missing_code, missing["status"]), (3, "blocked"))
        self.assertEqual(still_draining, started["coordinator"])
        self.assertEqual((checkpoint_code, checkpointed["status"]), (0, "settling"))
        self.assertEqual(settling["route"], "drain-owner")
        self.assertEqual((finish_code, finished["status"]), (0, "handoff-ready"))
        self.assertEqual(takeover_ready["route"], "takeover")
        self.assertEqual((takeover_code, taken["status"]), (0, "taken"))
        self.assertEqual(recovered["route"], "recover-owner")
        final_fields = MODULE.fields(final_message)
        self.assertEqual(
            MODULE._pause_index_value(final_fields), "hold-known-bad:HOLD@default"
        )
        self.assertEqual(MODULE._coordinator_lifecycle(final_fields)["phase"], "recovering")

    def test_takeover_command_cas_claims_quiescent_handoff_and_is_idempotent(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            head = self.git(repo, "rev-parse", "HEAD")
            parent = self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="needs-input",
                    owner_state="handoff-ready",
                    contract="1" * 40,
                    extra=(
                        "OWNER_ID: 07654254-e020-436b-9c04-6ca40f2f4a1e\n"
                        "OWNER_PROOF_KIND: runtime-task-id\n"
                        "RUN_ID: bc5fed70-55d9-4915-88d3-dc98de4d7013\n"
                        "RUN_KEY: 05921543be0e05af2538d99ee2372769\n"
                        "PROJECT_ID: 6c07eabb-e588-4184-8eaa-5974ad67fdda\n"
                        "MILESTONE_ID: 4854655e-aebd-458d-8d6b-dd5be9c75be2\n"
                        "EPOCH: 1\n"
                        f"CONTRACT_SOURCE_SHA: {head}\n"
                        "ACTION_KIND: handoff-owner\n"
                        "ACTION_TARGET: codex-thread:control-task\n"
                        "WORKERS: active_issue_lanes=none;executors=terminal\n"
                        "PAUSE: state=handoff-ready;pending_external_action=none\n"
                        "PROMOTION_HOLD: known-bad-default\n"
                        "RECOVERY: generation=2;cause=resume;phase=complete\n"
                    ),
                ),
            )
            args = mock.Mock(repo=str(repo), remote="origin", default="main")
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}):
                with io.StringIO() as output, redirect_stdout(output):
                    code = MODULE.command_takeover(args)
                    result = json.loads(output.getvalue())
                with io.StringIO() as output, redirect_stdout(output):
                    repeat_code = MODULE.command_takeover(args)
                    repeat = json.loads(output.getvalue())
                _, resumed, _ = self.preflight(repo)
            observed = self.git(repo, "ls-remote", "origin", MODULE.CANONICAL_COORDINATOR_REF).split()[0]
            observed_parent = self.git(repo, "rev-parse", f"{observed}^")
            message = self.git(repo, "show", "-s", "--format=%B", observed)
        self.assertEqual((code, result["status"]), (0, "taken"))
        self.assertNotEqual(observed, parent)
        self.assertEqual(observed_parent, parent)
        metadata = MODULE.fields(message)
        self.assertEqual(metadata["STATE"], "recovering")
        self.assertEqual(metadata["OWNER_STATE"], "active")
        self.assertEqual(metadata["EPOCH"], "2")
        self.assertEqual(metadata["CONTRACT_SOURCE_SHA"], head)
        self.assertEqual(metadata["ACTION_KIND"], "takeover-owner")
        self.assertEqual(metadata["ACTION_STATUS"], "reconciled")
        self.assertEqual((repeat_code, repeat["status"]), (0, "already-owner"))
        self.assertEqual(resumed["route"], "recover-owner")
        self.assertEqual(resumed["mutation_scope"], "recovery-only")

    def test_fence_guards_atomically_advances_indexed_vector_and_is_idempotent(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        run_id = "bc5fed70-55d9-4915-88d3-dc98de4d7013"
        run_key = "05921543be0e05af2538d99ee2372769"
        issue = "AND-47"
        guard_ref = f"refs/heads/codex/release/claims/{run_key}/{issue}/c1"
        with tempfile.TemporaryDirectory(prefix="shipctl-fence-") as directory:
            repo, _ = self.fixture(Path(directory))
            head = self.git(repo, "rev-parse", "HEAD")
            guard = self.metadata_commit(
                repo,
                (
                    "guard\n\n"
                    "SCHEMA: 1\n"
                    "KIND: CLAIM_GUARD\n"
                    "STATE: ready\n"
                    f"RUN_ID: {run_id}; RUN_KEY: {run_key}; ISSUE: {issue}\n"
                    "OWNER: id=07654254-e020-436b-9c04-6ca40f2f4a1e; "
                    "epoch=1; CLAIM: generation=1; token_digest=" + "a" * 64 + "\n"
                    "FEATURE: ref=refs/heads/codex/and-47-test/"
                    f"r{run_key}-e1-c1; expected_old=zero; head={head}\n"
                    "CHECKS_DIGEST: " + "c" * 64 + "\n"
                    "PREVIOUS_GUARD: zero; UPDATED_BY: worker\n"
                    "TERMINAL_REASON: none\n"
                    "TERMINAL_EVIDENCE: none\n"
                ),
                head,
            )
            self.git(repo, "push", "origin", f"{guard}:{guard_ref}")
            self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="needs-input",
                    owner_state="handoff-ready",
                    contract="1" * 40,
                    extra=(
                        "OWNER_ID: 07654254-e020-436b-9c04-6ca40f2f4a1e\n"
                        "OWNER_PROOF_KIND: runtime-task-id\n"
                        f"RUN_ID: {run_id}\n"
                        f"RUN_KEY: {run_key}\n"
                        f"PROJECT_ID: {uuid.uuid4()}\n"
                        f"MILESTONE_ID: {uuid.uuid4()}\n"
                        "EPOCH: 1\n"
                        f"CONTRACT_SOURCE_SHA: {head}\n"
                        "ACTION_KIND: handoff-owner\n"
                        "ACTION_TARGET: codex-thread:control-task\n"
                        "WORKERS: active_issue_lanes=none;executors=terminal\n"
                        "PAUSE: state=handoff-ready;pending_external_action=none\n"
                        "RECOVERY: generation=1;cause=handoff;phase=complete;inventory=none\n"
                        f"CLAIM_INDEX: active={issue}:1;entries=2;digest={'b' * 64}\n"
                        f"CLAIM_MAP: AND-147:2=terminal@refs/heads/codex/release/claims/{run_key}/AND-147/c2@{'d' * 40};feature={'e' * 40};batch=cutoff-1:g1\n"
                        f"CLAIM_MAP: {issue}:1@origin:{guard_ref}@origin:refs/heads/codex/and-47-test/r{run_key}-e1-c1@token\n"
                        f"LIVE_GUARDS: {issue}/c1={guard}:ready\n"
                    ),
                ),
            )
            args = mock.Mock(repo=str(repo), remote="origin", default="main")
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}):
                with io.StringIO() as output, redirect_stdout(output):
                    self.assertEqual(MODULE.command_takeover(args), 0)
                (repo / MODULE.SKILL_PATH / "SKILL.md").write_text(
                    "---\nname: test\n---\n# recovery upgrade\n", encoding="utf-8"
                )
                self.git(repo, "add", MODULE.SKILL_PATH)
                self.git(repo, "commit", "-m", "upgrade recovery contract")
                intermediate_head = self.git(repo, "rev-parse", "HEAD")
                self.git(repo, "push", "origin", "main")
                _, upgrade_preflight, _ = self.preflight(repo)
                original_run = MODULE.foreign_main.run

                def fail_atomic_push(target: Path, *call_args: str) -> subprocess.CompletedProcess[bytes]:
                    if call_args and call_args[0] == "push" and "--atomic" in call_args:
                        return subprocess.CompletedProcess(call_args, 1, b"", b"synthetic atomic race")
                    return original_run(target, *call_args)

                with mock.patch.object(MODULE.foreign_main, "run", side_effect=fail_atomic_push):
                    with io.StringIO() as output, redirect_stdout(output):
                        interrupted_code = MODULE.command_fence_guards(args)
                        interrupted = json.loads(output.getvalue())
                (repo / MODULE.SKILL_PATH / "SKILL.md").write_text(
                    "---\nname: test\n---\n# pending intent contract upgrade\n",
                    encoding="utf-8",
                )
                self.git(repo, "add", MODULE.SKILL_PATH)
                self.git(repo, "commit", "-m", "upgrade contract after pending intent")
                upgraded_head = self.git(repo, "rev-parse", "HEAD")
                upgraded_contract = self.git(repo, "rev-parse", f"HEAD:{MODULE.SKILL_PATH}")
                self.git(repo, "push", "origin", "main")
                _, pending_upgrade_preflight, _ = self.preflight(repo)
                with io.StringIO() as output, redirect_stdout(output):
                    fence_code = MODULE.command_fence_guards(args)
                    result = json.loads(output.getvalue())
                with io.StringIO() as output, redirect_stdout(output):
                    repeat_code = MODULE.command_fence_guards(args)
                    repeat = json.loads(output.getvalue())
            fenced_guard = self.git(repo, "ls-remote", "origin", guard_ref).split()[0]
            fenced_parent = self.git(repo, "rev-parse", f"{fenced_guard}^")
            guard_message = self.git(repo, "show", "-s", "--format=%B", fenced_guard)
            coordinator = self.git(repo, "ls-remote", "origin", MODULE.CANONICAL_COORDINATOR_REF).split()[0]
            coordinator_message = self.git(repo, "show", "-s", "--format=%B", coordinator)
        self.assertEqual((fence_code, result["status"]), (0, "fenced"))
        self.assertEqual((repeat_code, repeat["status"]), (0, "already-fenced"))
        self.assertEqual((interrupted_code, interrupted["status"]), (4, "cas-lost"))
        self.assertEqual(upgrade_preflight["route"], "recover-owner-upgrade")
        self.assertEqual(pending_upgrade_preflight["route"], "recover-owner-upgrade")
        self.assertEqual(
            upgrade_preflight["mutation_scope"],
            "recovery-contract-upgrade-and-fencing-only",
        )
        self.assertEqual(fenced_parent, guard)
        guard_metadata = MODULE.fields(guard_message)
        self.assertEqual(guard_metadata["STATE"], "fenced")
        self.assertEqual(guard_metadata["OWNER_EPOCH"], "2")
        self.assertEqual(guard_metadata["PREVIOUS_GUARD"], guard)
        coordinator_metadata = MODULE.fields(coordinator_message)
        self.assertEqual(coordinator_metadata["ACTION_KIND"], "fence-guards")
        self.assertEqual(coordinator_metadata["ACTION_STATUS"], "reconciled")
        self.assertEqual(coordinator_metadata["CONTRACT_SOURCE_SHA"], upgraded_head)
        self.assertEqual(coordinator_metadata["CONTRACT_DIGEST"], upgraded_contract)
        self.assertIn(
            f"source={intermediate_head};",
            coordinator_metadata["CONTRACT_MIGRATED_FROM"],
        )
        self.assertEqual(MODULE._structured_token(coordinator_metadata["RECOVERY"], "phase"), "inventory")

    def test_live_claim_index_fences_only_active_and_counts_history_separately(self) -> None:
        run_key = "a" * 32
        issue = "AND-47"
        guard = f"refs/heads/codex/release/claims/{run_key}/{issue}/c2"
        active = (
            f"{issue}:2@origin:{guard}@origin:refs/heads/codex/and-47-test/"
            f"r{run_key}-e2-c2@worktree-id"
        )
        claim_index = (
            f"active={active};quarantined=AND-84:1@{'f' * 40};"
            f"entries=3;digest={'b' * 64}"
        )
        message = (
            f"CLAIM_MAP: AND-147:2=terminal@refs/heads/codex/release/claims/{run_key}/"
            f"AND-147/c2@{'d' * 40};feature={'e' * 40};batch=cutoff-1:g1\n"
        )
        with tempfile.TemporaryDirectory(prefix="shipctl-claim-index-") as directory:
            repo, _ = self.fixture(Path(directory))
            entries, errors = MODULE._claim_guard_refs(
                repo, message, claim_index, run_key, "origin"
            )
        self.assertEqual(errors, [])
        self.assertEqual(entries, [(issue, 2, guard)])

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

    def test_sync_contract_upgrades_same_owner_recovery_and_is_idempotent(self) -> None:
        thread_id = "019fdcce-1fee-71d0-8d5d-6566cdf2d94b"
        proof = MODULE.hashlib.sha256(thread_id.encode()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="shipctl-sync-") as directory:
            repo, _ = self.fixture(Path(directory))
            old_head = self.git(repo, "rev-parse", "HEAD")
            old_contract = self.git(repo, "rev-parse", f"HEAD:{MODULE.SKILL_PATH}")
            parent = self.push_coordinator(
                repo,
                MODULE.CANONICAL_COORDINATOR_REF,
                self.coordinator_message(
                    repo,
                    state="recovering",
                    proof=proof,
                    contract=old_contract,
                    extra=(
                        f"OWNER_ID: {uuid.uuid4()}\n"
                        "OWNER_PROOF_KIND: runtime-task-id\n"
                        f"RUN_ID: {uuid.uuid4()}\n"
                        f"RUN_KEY: {'a' * 32}\n"
                        f"PROJECT_ID: {uuid.uuid4()}\n"
                        f"MILESTONE_ID: {uuid.uuid4()}\n"
                        "EPOCH: 2\n"
                        f"CONTRACT_SOURCE_SHA: {old_head}\n"
                    ),
                ),
            )
            (repo / MODULE.SKILL_PATH / "SKILL.md").write_text(
                "---\nname: test\n---\n# synced\n", encoding="utf-8"
            )
            self.git(repo, "add", MODULE.SKILL_PATH)
            self.git(repo, "commit", "-m", "new recovery contract")
            new_head = self.git(repo, "rev-parse", "HEAD")
            new_contract = self.git(repo, "rev-parse", f"HEAD:{MODULE.SKILL_PATH}")
            self.git(repo, "push", "origin", "main")
            args = mock.Mock(repo=str(repo), remote="origin", default="main")
            with mock.patch.dict(MODULE.os.environ, {"CODEX_THREAD_ID": thread_id}):
                _, before, _ = self.preflight(repo)
                with io.StringIO() as output, redirect_stdout(output):
                    code = MODULE.command_sync_contract(args)
                    result = json.loads(output.getvalue())
                with io.StringIO() as output, redirect_stdout(output):
                    repeat_code = MODULE.command_sync_contract(args)
                    repeat = json.loads(output.getvalue())
                _, after, _ = self.preflight(repo)
            observed = self.git(repo, "ls-remote", "origin", MODULE.CANONICAL_COORDINATOR_REF).split()[0]
            message = self.git(repo, "show", "-s", "--format=%B", observed)
            first_parent = self.git(repo, "rev-parse", f"{observed}^^")
        self.assertEqual(before["route"], "recover-owner-upgrade")
        self.assertEqual((code, result["status"]), (0, "synced"))
        self.assertEqual((repeat_code, repeat["status"]), (0, "already-synced"))
        self.assertEqual(after["route"], "recover-owner")
        self.assertEqual(first_parent, parent)
        metadata = MODULE.fields(message)
        self.assertEqual(metadata["CONTRACT_SOURCE_SHA"], new_head)
        self.assertEqual(metadata["CONTRACT_DIGEST"], new_contract)
        self.assertEqual(metadata["ACTION_KIND"], "sync-contract")
        self.assertEqual(metadata["ACTION_STATUS"], "reconciled")

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
            canonical = self.metadata_commit(
                repo,
                self.coordinator_message(
                    repo,
                    extra=(
                        "LINEAR_DONE: AND-47@2026-08-07T23:29:03Z\n"
                        "LINEAR_DONE: AND-82@2026-08-07T23:29:01Z\n"
                    ),
                ),
                migration,
            )
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

    def test_transition_preserves_lifecycle_pause_and_execution_authority(self) -> None:
        pause_id = "pause-28cb9f4d-e177-4a23-aa8f-2c8323fbb238"
        with tempfile.TemporaryDirectory(prefix="shipctl-transition-") as directory:
            repo, _ = self.fixture(Path(directory))
            message = self.parent_message() + (
                f"LIFECYCLE: schema=1;phase=settling;pause={pause_id};transition={uuid.uuid4()}\n"
                "EXECUTION_INDEX: running_count=0;entries=none;digest=" + "1" * 64 + "\n"
                "WORKERS: active_target=0;active_issue_lanes=none;refill_blocker=user-pause\n"
                "PENDING_ACTIONS: none\n"
                f"PAUSE: id={pause_id};state=active;scope=dispatch,new-work\n"
                f"HOLD_PAUSE_INDEX: active={pause_id}:PAUSE@dispatch,new-work;entries=1\n"
                "CLAIM_MAP: AND-47:2@origin:guard-47@origin:feature-47@token\n"
                "CLAIM_MAP: AND-61:3@origin:guard-61@origin:feature-61@token\n"
                "COMMENT_MAP: projection-only-1\n"
                "COMMENT_MAP: projection-only-2\n"
            )
            parent = self.metadata_commit(repo, message)
            code, result = self.invoke(
                repo,
                parent,
                {
                    "phase": "intent",
                    "kind": "update-linear-state",
                    "target": "linear:AND-56",
                    "expected_before": "state=Backlog",
                    "request_key": "issue:AND-56:in-progress",
                    "selector": "linear:issue:AND-56",
                    "payload_digest": "d" * 64,
                    "effect_identity": "linear:AND-56@In Progress",
                },
            )
        self.assertEqual(code, 0)
        rendered = MODULE.fields(result["message"])
        for key in (
            "LIFECYCLE",
            "EXECUTION_INDEX",
            "WORKERS",
            "PENDING_ACTIONS",
            "PAUSE",
            "HOLD_PAUSE_INDEX",
        ):
            self.assertEqual(rendered[key], MODULE.fields(message)[key])
        self.assertEqual(result["message"].count("CLAIM_MAP:"), 2)
        self.assertNotIn("COMMENT_MAP:", result["message"])

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
