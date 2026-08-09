#!/usr/bin/env python3

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("shipctl", SCRIPTS / "shipctl.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ShipctlTest(unittest.TestCase):
    def git(self, repo: Path, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ).stdout.strip()

    def repo_fixture(self, root: Path) -> Path:
        repo = root / "repo"
        self.git(root, "init", "-b", "main", str(repo))
        self.git(repo, "config", "user.name", "test")
        self.git(repo, "config", "user.email", "test@example.invalid")
        (repo / "src").mkdir()
        (repo / "src" / "base.txt").write_text("base\n", encoding="utf-8")
        self.git(repo, "add", "src/base.txt")
        self.git(repo, "commit", "-m", "base")
        return repo

    def invoke(self, *args: str, expected: int = 0) -> dict[str, object]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = MODULE.main(list(args))
        self.assertEqual(result, expected, stderr.getvalue())
        stream = stdout if result == 0 else stderr
        return json.loads(stream.getvalue())

    def init_run(self, repo: Path, workers: int = 1) -> dict[str, object]:
        result = self.invoke(
            "init",
            "--repo",
            str(repo),
            "--project-id",
            "project-1",
            "--milestone-id",
            "milestone-1",
            "--workers",
            str(workers),
        )
        return result["run"]  # type: ignore[return-value]

    def snapshot(self, path: Path, issues: list[dict[str, object]]) -> None:
        path.write_text(
            json.dumps(
                {
                    "schema": MODULE.SNAPSHOT_SCHEMA,
                    "issues": issues,
                    "completed_dependency_ids": [],
                }
            ),
            encoding="utf-8",
        )

    def issue(
        self,
        issue_id: str,
        identifier: str,
        *,
        dependencies: list[str] | None = None,
        priority: int = 1,
    ) -> dict[str, object]:
        return {
            "id": issue_id,
            "identifier": identifier,
            "title": f"Task {identifier}",
            "state": "Todo",
            "priority": priority,
            "dependencies": dependencies or [],
        }

    def plan(
        self,
        repo: Path,
        run_id: str,
        root: Path,
        issues: list[dict[str, object]],
        *,
        expected: int = 0,
    ) -> dict[str, object]:
        path = root / "snapshot.json"
        self.snapshot(path, issues)
        return self.invoke(
            "plan", "--repo", str(repo), "--run", run_id,
            "--input", str(path), expected=expected,
        )

    def add_worktree(self, repo: Path, root: Path, lane: int, identifier: str) -> tuple[Path, str]:
        branch = f"codex/{identifier.lower()}-w{lane}"
        worktree = root / f"worker-{lane}"
        self.git(repo, "worktree", "add", "-b", branch, str(worktree), "main")
        return worktree, branch

    def commit_change(self, worktree: Path, relative: str, text: str) -> str:
        path = worktree / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        self.git(worktree, "add", relative)
        self.git(worktree, "commit", "-m", f"change {relative}")
        return self.git(worktree, "rev-parse", "HEAD")

    def claim(
        self,
        repo: Path,
        run_id: str,
        issue_id: str,
        lane: str,
        branch: str,
        worktree: Path,
        path: str,
        *,
        expected: int = 0,
    ) -> dict[str, object]:
        return self.invoke(
            "claim",
            "--repo",
            str(repo),
            "--run",
            run_id,
            "--issue",
            issue_id,
            "--lane",
            lane,
            "--branch",
            branch,
            "--worktree",
            str(worktree),
            "--path",
            path,
            expected=expected,
        )

    def finish_feature(
        self,
        repo: Path,
        run_id: str,
        issue_id: str,
        branch: str,
        worktree: Path,
        relative: str,
    ) -> str:
        head = self.commit_change(worktree, relative, f"{issue_id}\n")
        self.invoke(
            "feature-ready",
            "--repo",
            str(repo),
            "--run",
            run_id,
            "--issue",
            issue_id,
            "--head",
            head,
            "--check",
            "targeted=passed",
            "--check",
            "diff=passed",
        )
        self.git(repo, "merge", "--ff-only", branch)
        main_sha = self.git(repo, "rev-parse", "main")
        self.invoke("integrate", "--repo", str(repo), "--run", run_id, "--issue", issue_id, "--main-sha", main_sha)
        self.invoke("task-done", "--repo", str(repo), "--run", run_id, "--issue", issue_id)
        return main_sha

    def test_invocation_defaults_to_coordinator_and_preserves_exact_workers(self) -> None:
        self.assertEqual(self.invoke("invocation", "$ship-linear-release"), {"mode": "single", "workers": 1})
        self.assertEqual(
            self.invoke("invocation", "$ship-linear-release workers=3"),
            {"mode": "parallel", "workers": 3},
        )
        error = self.invoke("invocation", "workers=2 workers=3", expected=2)
        self.assertEqual(error["code"], "WORKERS_AMBIGUOUS")

    def test_init_builds_exact_single_and_three_worker_topologies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = self.repo_fixture(Path(temporary))
            single = self.init_run(repo, 1)
            self.assertEqual(single["mode"], "single")
            self.assertEqual([value["id"] for value in single["lanes"]], ["coordinator"])

        with tempfile.TemporaryDirectory() as temporary:
            repo = self.repo_fixture(Path(temporary))
            parallel = self.init_run(repo, 3)
            self.assertEqual(parallel["mode"], "parallel")
            self.assertEqual(
                [value["id"] for value in parallel["lanes"]],
                ["worker-1", "worker-2", "worker-3"],
            )

    def test_exact_init_is_reused_but_worker_drift_conflicts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = self.repo_fixture(Path(temporary))
            first = self.init_run(repo, 3)
            reused = self.invoke(
                "init", "--repo", str(repo), "--project-id", "project-1",
                "--milestone-id", "milestone-1", "--workers", "3",
            )
            self.assertEqual(reused["disposition"], "reused")
            self.assertEqual(reused["run"]["run_id"], first["run_id"])
            conflict = self.invoke(
                "init", "--repo", str(repo), "--project-id", "project-1",
                "--milestone-id", "milestone-1", "--workers", "2", expected=2,
            )
            self.assertEqual(conflict["code"], "ACTIVE_RUN_CONFLICT")

    def test_plan_respects_dependencies_and_rejects_unknown_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            result = self.plan(
                repo,
                run["run_id"],
                root,
                [self.issue("a", "AND-1"), self.issue("b", "AND-2", dependencies=["a"])],
            )
            self.assertEqual(result["ready"], ["a"])
            error = self.plan(
                repo,
                run["run_id"],
                root,
                [self.issue("c", "AND-3", dependencies=["missing"])],
                expected=2,
            )
            self.assertEqual(error["code"], "SNAPSHOT_INVALID")

    def test_three_worker_claims_use_distinct_worktrees_and_reject_scope_overlap(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 3)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1"), self.issue("b", "AND-2"), self.issue("c", "AND-3")])
            worktrees = [self.add_worktree(repo, root, index, f"AND-{index}") for index in (1, 2, 3)]
            self.claim(repo, run_id, "a", "worker-1", worktrees[0][1], worktrees[0][0], "src/a")
            overlap = self.claim(repo, run_id, "b", "worker-2", worktrees[1][1], worktrees[1][0], "src/a/nested", expected=2)
            self.assertEqual(overlap["code"], "SCOPE_CONFLICT")
            self.claim(repo, run_id, "b", "worker-2", worktrees[1][1], worktrees[1][0], "src/b")
            self.claim(repo, run_id, "c", "worker-3", worktrees[2][1], worktrees[2][0], "src/c")
            state = self.invoke("status", "--repo", str(repo), "--run", run_id)["run"]
            self.assertEqual({value["active_issue"] for value in state["lanes"]}, {"a", "b", "c"})

    def test_three_parallel_features_integrate_serially_into_one_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 3)
            run_id = run["run_id"]
            issues = [self.issue(letter, f"AND-{index}") for index, letter in enumerate(("a", "b", "c"), 1)]
            self.plan(repo, run_id, root, issues)
            features: list[tuple[str, str, Path, str]] = []
            for index, letter in enumerate(("a", "b", "c"), 1):
                worktree, branch = self.add_worktree(repo, root, index, f"AND-{index}")
                owned = f"src/{letter}"
                self.claim(repo, run_id, letter, f"worker-{index}", branch, worktree, owned)
                head = self.commit_change(worktree, f"{owned}/result.txt", f"{letter}\n")
                self.invoke(
                    "feature-ready", "--repo", str(repo), "--run", run_id,
                    "--issue", letter, "--head", head, "--check", "targeted=passed",
                )
                features.append((letter, branch, worktree, head))
            for index, (letter, branch, _worktree, _head) in enumerate(features):
                if index == 0:
                    self.git(repo, "merge", "--ff-only", branch)
                else:
                    self.git(repo, "merge", "--no-edit", branch)
                main_sha = self.git(repo, "rev-parse", "main")
                self.invoke(
                    "integrate", "--repo", str(repo), "--run", run_id,
                    "--issue", letter, "--main-sha", main_sha,
                )
                self.invoke("task-done", "--repo", str(repo), "--run", run_id, "--issue", letter)
            batch = self.invoke(
                "batch-create", "--repo", str(repo), "--run", run_id,
                "--candidate", self.git(repo, "rev-parse", "main"), "--gate", "passed",
            )["batch"]
            self.assertEqual(batch["issue_ids"], ["a", "b", "c"])

    def test_feature_scope_and_integration_are_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 3)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            worktree, branch = self.add_worktree(repo, root, 1, "AND-1")
            self.claim(repo, run_id, "a", "worker-1", branch, worktree, "src/a")
            head = self.commit_change(worktree, "src/outside.txt", "bad\n")
            error = self.invoke(
                "feature-ready", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--head", head, "--check", "targeted=passed", expected=2,
            )
            self.assertEqual(error["code"], "SCOPE_VIOLATION")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 3)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            worktree, branch = self.add_worktree(repo, root, 1, "AND-1")
            self.claim(repo, run_id, "a", "worker-1", branch, worktree, "src/a")
            main_sha = self.finish_feature(repo, run_id, "a", branch, worktree, "src/a/result.txt")
            state = self.invoke("status", "--repo", str(repo), "--run", run_id)["run"]
            self.assertEqual(state["tasks"]["a"]["status"], "done")
            self.assertEqual(state["current_main_sha"], main_sha)
            self.assertIsNone(state["lanes"][0]["active_issue"])

    def test_failed_worker_releases_lane_for_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 3)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            worktree, branch = self.add_worktree(repo, root, 1, "AND-1")
            self.claim(repo, run_id, "a", "worker-1", branch, worktree, "src/a")
            result = self.invoke(
                "task-failed", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--reason", "targeted check failed",
            )
            self.assertEqual(result["status"], "ready")
            state = self.invoke("status", "--repo", str(repo), "--run", run_id)["run"]
            self.assertIsNone(state["lanes"][0]["active_issue"])

    def test_coordinator_only_end_to_end_has_no_extra_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 1)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            branch = "codex/and-1-single"
            self.git(repo, "switch", "-c", branch)
            self.claim(repo, run_id, "a", "coordinator", branch, repo, "src/a")
            head = self.commit_change(repo, "src/a/result.txt", "single\n")
            self.invoke(
                "feature-ready", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--head", head, "--check", "targeted=passed",
            )
            self.git(repo, "switch", "main")
            self.git(repo, "merge", "--ff-only", branch)
            main_sha = self.git(repo, "rev-parse", "main")
            self.invoke("integrate", "--repo", str(repo), "--run", run_id, "--issue", "a", "--main-sha", main_sha)
            self.invoke("task-done", "--repo", str(repo), "--run", run_id, "--issue", "a")
            batch = self.invoke(
                "batch-create", "--repo", str(repo), "--run", run_id,
                "--candidate", main_sha, "--gate", "passed",
            )["batch"]
            self.invoke(
                "batch-uat", "--repo", str(repo), "--run", run_id,
                "--batch", batch["id"], "--deployment", "uat-1",
                "--url", "https://uat.example.invalid", "--result", "passed",
            )
            complete = self.invoke("complete", "--repo", str(repo), "--run", run_id, "--main-sha", main_sha)
            self.assertEqual(complete["status"], "completed")
            worktrees = self.git(repo, "worktree", "list", "--porcelain")
            self.assertEqual(worktrees.count("worktree "), 1)

    def test_failed_uat_uses_forward_repair_and_blocks_ordinary_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 3)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1"), self.issue("b", "AND-2")])
            worktree, branch = self.add_worktree(repo, root, 1, "AND-1")
            self.claim(repo, run_id, "a", "worker-1", branch, worktree, "src/a")
            main_sha = self.finish_feature(repo, run_id, "a", branch, worktree, "src/a/result.txt")
            batch = self.invoke(
                "batch-create", "--repo", str(repo), "--run", run_id,
                "--candidate", main_sha, "--gate", "passed",
            )["batch"]
            self.invoke(
                "batch-uat", "--repo", str(repo), "--run", run_id,
                "--batch", batch["id"], "--deployment", "uat-broken",
                "--url", "https://uat.example.invalid", "--result", "failed",
            )
            defect = self.invoke(
                "defect", "--repo", str(repo), "--run", run_id,
                "--route", "coordinator", "--summary", "smoke failed",
            )["defect"]
            worktree2, branch2 = self.add_worktree(repo, root, 2, "AND-2")
            blocked = self.claim(repo, run_id, "b", "worker-2", branch2, worktree2, "src/b", expected=2)
            self.assertEqual(blocked["code"], "REPAIR_FIRST")
            (repo / "src" / "uat-fix.txt").write_text("forward fix\n", encoding="utf-8")
            self.git(repo, "add", "src/uat-fix.txt")
            self.git(repo, "commit", "-m", "fix UAT forward")
            fixed_sha = self.git(repo, "rev-parse", "main")
            self.invoke(
                "defect-resolve", "--repo", str(repo), "--run", run_id,
                "--defect", defect["id"], "--fixed-sha", fixed_sha,
            )
            repaired_batch = self.invoke(
                "batch-create", "--repo", str(repo), "--run", run_id,
                "--candidate", fixed_sha, "--gate", "passed",
            )["batch"]
            self.assertEqual(repaired_batch["issue_ids"], [])
            self.assertEqual(repaired_batch["defect_ids"], [defect["id"]])
            self.invoke(
                "batch-uat", "--repo", str(repo), "--run", run_id,
                "--batch", repaired_batch["id"], "--deployment", "uat-fixed",
                "--url", "https://uat.example.invalid", "--result", "passed",
            )
            self.claim(repo, run_id, "b", "worker-2", branch2, worktree2, "src/b")
            state = self.invoke("status", "--repo", str(repo), "--run", run_id)["run"]
            self.assertEqual(state["uat"]["current_sha"], fixed_sha)
            self.assertEqual(state["uat"]["last_good_sha"], fixed_sha)

    def test_all_defect_routes_and_production_refusal_are_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            run_id = run["run_id"]
            for route in ("reopen", "new-bug"):
                result = self.invoke(
                    "defect", "--repo", str(repo), "--run", run_id,
                    "--route", route, "--linear-issue-id", f"linear-{route}",
                    "--summary", route,
                )
                self.assertEqual(result["defect"]["route"], route)
            error = self.invoke("production", expected=2)
            self.assertEqual(error["code"], "PRODUCTION_FORBIDDEN")

    def test_atomic_write_keeps_old_journal_when_replace_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            path.write_text('{"old": true}\n', encoding="utf-8")
            with mock.patch.object(MODULE.os, "replace", side_effect=OSError("crash")):
                with self.assertRaises(OSError):
                    MODULE.atomic_write(path, {"new": True})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"old": True})
            self.assertEqual(list(path.parent.glob(".state.json.*")), [])

    def test_failed_journal_commit_never_emits_success_or_changes_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            run_id = run["run_id"]
            snapshot = root / "snapshot.json"
            self.snapshot(snapshot, [self.issue("a", "AND-1")])
            stdout = io.StringIO()
            stderr = io.StringIO()
            with mock.patch.object(MODULE, "atomic_write", side_effect=OSError("disk full")):
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    result = MODULE.main(
                        ["plan", "--repo", str(repo), "--run", run_id, "--input", str(snapshot)]
                    )
            self.assertEqual(result, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(json.loads(stderr.getvalue())["code"], "IO_FAILED")
            state = self.invoke("status", "--repo", str(repo), "--run", run_id)["run"]
            self.assertEqual(state["tasks"], {})


if __name__ == "__main__":
    unittest.main()
