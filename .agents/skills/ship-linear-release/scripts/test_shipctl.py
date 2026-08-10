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

    def snapshot(
        self,
        path: Path,
        issues: list[dict[str, object]],
        completed_dependency_ids: list[str] | None = None,
    ) -> None:
        path.write_text(
            json.dumps(
                {
                    "schema": MODULE.SNAPSHOT_SCHEMA,
                    "issues": issues,
                    "completed_dependency_ids": completed_dependency_ids or [],
                }
            ),
            encoding="utf-8",
        )

    def inventory(
        self,
        path: Path,
        issues: list[dict[str, object]],
    ) -> None:
        path.write_text(
            json.dumps(
                {
                    "schema": MODULE.INVENTORY_SCHEMA,
                    "project_id": "project-1",
                    "milestone_id": "milestone-1",
                    "has_next_page": False,
                    "issues": issues,
                }
            ),
            encoding="utf-8",
        )

    def inventory_issue(
        self,
        issue_id: str,
        *,
        state: str = "Done",
        status_type: str = "completed",
    ) -> dict[str, object]:
        return {
            "id": issue_id,
            "identifier": issue_id,
            "title": f"Task {issue_id}",
            "state": state,
            "status_type": status_type,
            "priority": 2,
        }

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
        completed_dependency_ids: list[str] | None = None,
        expected: int = 0,
    ) -> dict[str, object]:
        path = root / "snapshot.json"
        self.snapshot(path, issues, completed_dependency_ids)
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
        self.assertEqual(self.invoke("invocation", "workers=auto", expected=2)["code"], "WORKERS_INVALID")
        self.assertEqual(self.invoke("invocation", "workers=0", expected=2)["code"], "WORKERS_INVALID")
        self.assertEqual(
            self.invoke("invocation", "workers=3 workers=3", expected=2)["code"],
            "WORKERS_AMBIGUOUS",
        )

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

    def test_terminal_only_preflight_is_no_work_and_creates_no_journal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            inventory = root / "inventory.json"
            self.inventory(
                inventory,
                [self.inventory_issue(f"AND-{index}") for index in range(1, 72)],
            )
            result = self.invoke(
                "preflight", "--repo", str(repo),
                "--project-id", "project-1", "--milestone-id", "milestone-1",
                "--invocation", "$ship-linear-release workers=3", "--input", str(inventory),
            )
            self.assertEqual(result["disposition"], "no-work")
            self.assertEqual(result["workers"], 3)
            self.assertEqual(result["linear"]["issue_count"], 71)
            self.assertEqual(result["linear"]["unfinished_count"], 0)
            self.assertFalse(result["linear"]["relations_required"])
            self.assertFalse(result["release_required"])
            self.assertFalse(MODULE.runs_dir(repo).exists())

    def test_zero_work_forward_path_uses_two_cli_calls_and_stops(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            raw = root / "linear.json"
            inventory = root / "inventory.json"
            raw.write_text(
                json.dumps(
                    {
                        "issues": [
                            {
                                "id": f"AND-{index}",
                                "title": f"Task {index}",
                                "status": "Done",
                                "statusType": "completed",
                                "priority": {"value": 2},
                                "projectId": "project-1",
                                "projectMilestone": {"id": "milestone-1", "name": "0.1"},
                            }
                            for index in range(1, 72)
                        ],
                        "hasNextPage": False,
                    }
                ),
                encoding="utf-8",
            )
            normalized = subprocess.run(
                [
                    sys.executable, str(SCRIPTS / "linear_inventory.py"),
                    "--input", str(raw), "--output", str(inventory),
                    "--project-id", "project-1", "--milestone-id", "milestone-1",
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(json.loads(normalized.stdout)["disposition"], "no-work")
            preflight = subprocess.run(
                [
                    sys.executable, str(SCRIPTS / "shipctl.py"), "preflight",
                    "--repo", str(repo), "--project-id", "project-1",
                    "--milestone-id", "milestone-1", "--invocation", "$ship-linear-release",
                    "--input", str(inventory),
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            result = json.loads(preflight.stdout)
            self.assertEqual(result["disposition"], "no-work")
            self.assertEqual(result["next_action"], "report and stop")
            self.assertFalse(MODULE.runs_dir(repo).exists())

    def test_preflight_requires_details_only_for_unfinished_and_blocks_dirty_start(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            inventory = root / "inventory.json"
            self.inventory(
                inventory,
                [
                    self.inventory_issue("AND-1"),
                    self.inventory_issue("AND-2", state="Todo", status_type="unstarted"),
                ],
            )
            (repo / "dirty.txt").write_text("dirty\n", encoding="utf-8")
            result = self.invoke(
                "preflight", "--repo", str(repo),
                "--project-id", "project-1", "--milestone-id", "milestone-1",
                "--invocation", "$ship-linear-release", "--input", str(inventory),
            )
            self.assertEqual(result["disposition"], "blocked")
            self.assertEqual(result["reason"], "REPOSITORY_DIRTY")
            self.assertEqual(result["linear"]["unfinished_issue_ids"], ["AND-2"])
            self.assertTrue(result["linear"]["relations_required"])
            self.assertFalse(MODULE.runs_dir(repo).exists())

    def test_preflight_recognizes_an_existing_empty_run_as_no_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            inventory = root / "inventory.json"
            self.inventory(inventory, [self.inventory_issue("AND-1")])
            result = self.invoke(
                "preflight", "--repo", str(repo),
                "--project-id", "project-1", "--milestone-id", "milestone-1",
                "--invocation", "$ship-linear-release", "--input", str(inventory),
            )
            self.assertEqual(result["disposition"], "no-work")
            self.assertEqual(result["active_run_id"], run["run_id"])
            self.assertIn("complete existing no-op run", result["next_action"])

    def test_snapshot_templates_are_machine_readable_and_closed(self) -> None:
        inventory = self.invoke("snapshot-template", "--kind", "inventory")
        plan = self.invoke("snapshot-template", "--kind", "plan")
        self.assertEqual(inventory["schema"], MODULE.INVENTORY_SCHEMA)
        self.assertEqual(plan["schema"], MODULE.SNAPSHOT_SCHEMA)
        self.assertEqual(set(plan), {"schema", "issues", "completed_dependency_ids"})

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

            external = self.plan(
                repo,
                run["run_id"],
                root,
                [self.issue("d", "AND-4", dependencies=["external-done"])],
                completed_dependency_ids=["external-done"],
            )
            self.assertIn("d", external["ready"])
            state = self.invoke("status", "--repo", str(repo), "--run", run["run_id"])["run"]
            self.assertEqual(state["completed_dependency_ids"], ["external-done"])

    def test_historical_done_is_dependency_only_and_noop_completion_needs_no_uat(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            historical = self.issue("a", "AND-1")
            historical["state"] = "Done"
            dependent = self.issue("b", "AND-2", dependencies=["a"])
            result = self.plan(repo, run["run_id"], root, [historical, dependent])
            self.assertEqual(result["ready"], ["b"])
            state = self.invoke("status", "--repo", str(repo), "--run", run["run_id"])["run"]
            self.assertNotIn("a", state["tasks"])
            self.assertIn("a", state["completed_dependency_ids"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            historical = self.issue("a", "AND-1")
            historical["state"] = "Done"
            result = self.plan(repo, run["run_id"], root, [historical])
            self.assertEqual(result["disposition"], "no-work")
            batch = self.invoke(
                "batch-create", "--repo", str(repo), "--run", run["run_id"],
                "--candidate", self.git(repo, "rev-parse", "main"), "--gate", "passed", expected=2,
            )
            self.assertEqual(batch["code"], "BATCH_EMPTY")
            completed = self.invoke(
                "complete", "--repo", str(repo), "--run", run["run_id"],
                "--main-sha", self.git(repo, "rev-parse", "main"),
            )
            self.assertEqual(completed["disposition"], "no-work")
            self.assertFalse(completed["release_required"])

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

    def test_feature_scope_allows_merging_current_main_into_worker_branch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo, 3)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            worktree, branch = self.add_worktree(repo, root, 1, "AND-1")
            self.claim(repo, run_id, "a", "worker-1", branch, worktree, "src/a")

            (repo / "src" / "integration.txt").write_text("main\n", encoding="utf-8")
            self.git(repo, "add", "src/integration.txt")
            self.git(repo, "commit", "-m", "advance main")
            self.git(worktree, "merge", "--no-edit", "main")
            head = self.commit_change(worktree, "src/a/result.txt", "feature\n")
            ready = self.invoke(
                "feature-ready", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--head", head, "--check", "targeted=passed",
            )
            self.assertEqual(ready["changed_paths"], ["src/a/result.txt"])

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
            worktree2, branch2 = self.add_worktree(repo, root, 2, "AND-2")
            blocked_before_triage = self.claim(
                repo, run_id, "b", "worker-2", branch2, worktree2, "src/b", expected=2,
            )
            self.assertEqual(blocked_before_triage["code"], "REPAIR_FIRST")
            defect = self.invoke(
                "defect", "--repo", str(repo), "--run", run_id,
                "--route", "coordinator", "--summary", "smoke failed",
                "--path", "src/uat-fix.txt",
            )["defect"]
            tree = self.git(repo, "write-tree")
            unrelated = subprocess.run(
                ["git", "-C", str(repo), "commit-tree", tree],
                input="unrelated root\n",
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ).stdout.strip()
            self.git(repo, "update-ref", "refs/heads/main", unrelated)
            self.git(repo, "reset", "--hard", "main")
            not_forward = self.invoke(
                "defect-resolve", "--repo", str(repo), "--run", run_id,
                "--defect", defect["id"], "--fixed-sha", unrelated, expected=2,
            )
            self.assertEqual(not_forward["code"], "FORWARD_FIX_REQUIRED")
            self.git(repo, "update-ref", "refs/heads/main", main_sha)
            self.git(repo, "reset", "--hard", "main")
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
            blocked_until_restored = self.claim(
                repo, run_id, "b", "worker-2", branch2, worktree2, "src/b", expected=2,
            )
            self.assertEqual(blocked_until_restored["code"], "REPAIR_FIRST")
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
            rejected = self.invoke(
                "defect", "--repo", str(repo), "--run", run_id,
                "--route", "coordinator", "--summary", "invented",
                "--path", "src/fix", expected=2,
            )
            self.assertEqual(rejected["code"], "DEFECT_REQUIRES_CURRENT_WORK")
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            branch = "codex/and-1-defect-routes"
            self.git(repo, "switch", "-c", branch)
            self.claim(repo, run_id, "a", "coordinator", branch, repo, "src/a")
            head = self.commit_change(repo, "src/a/result.txt", "candidate\n")
            self.invoke(
                "feature-ready", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--head", head, "--check", "targeted=passed",
            )
            self.git(repo, "switch", "main")
            self.git(repo, "merge", "--ff-only", branch)
            main_sha = self.git(repo, "rev-parse", "main")
            self.invoke(
                "integrate", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--main-sha", main_sha,
            )
            self.invoke("task-done", "--repo", str(repo), "--run", run_id, "--issue", "a")
            legacy = self.invoke(
                "defect", "--repo", str(repo), "--run", run_id,
                "--route", "coordinator", "--summary", "legacy unbounded repair",
                "--path", "src/legacy-fix",
            )["defect"]
            journal = MODULE.journal_path(repo, run_id)
            state = MODULE.read_json(journal)
            legacy_record = next(item for item in state["defects"] if item["id"] == legacy["id"])
            for field in (
                "repair_paths", "assessment", "failed_attempts", "reclassification_required",
                "reclassified_from", "reclassified_at",
            ):
                legacy_record.pop(field)
            MODULE.atomic_write(journal, state)
            legacy_fix_sha = self.commit_change(repo, "src/legacy-fix/runtime.py", "fixed\n")
            legacy_blocked = self.invoke(
                "defect-resolve", "--repo", str(repo), "--run", run_id,
                "--defect", legacy["id"], "--fixed-sha", legacy_fix_sha, expected=2,
            )
            self.assertEqual(legacy_blocked["code"], "DEFECT_RECLASSIFICATION_REQUIRED")
            self.invoke(
                "defect-reclassify", "--repo", str(repo), "--run", run_id,
                "--defect", legacy["id"], "--route", "reopen",
                "--linear-issue-id", "linear-legacy",
            )
            self.invoke(
                "defect-resolve", "--repo", str(repo), "--run", run_id,
                "--defect", legacy["id"], "--fixed-sha", legacy_fix_sha,
            )
            for route in ("reopen", "new-bug"):
                result = self.invoke(
                    "defect", "--repo", str(repo), "--run", run_id,
                    "--route", route, "--linear-issue-id", f"linear-{route}",
                    "--summary", route,
                )
                self.assertEqual(result["defect"]["route"], route)
                replay = self.invoke(
                    "defect", "--repo", str(repo), "--run", run_id,
                    "--route", route, "--linear-issue-id", f"linear-{route}",
                    "--summary", f"changed wording for {route}",
                )
                self.assertEqual(replay["disposition"], "reused")
                self.assertEqual(replay["defect"]["id"], result["defect"]["id"])
            error = self.invoke("production", expected=2)
            self.assertEqual(error["code"], "PRODUCTION_FORBIDDEN")

    def test_expanded_coordinator_repair_requires_linear_reclassification(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            branch = "codex/and-1-reclassification"
            self.git(repo, "switch", "-c", branch)
            self.claim(repo, run_id, "a", "coordinator", branch, repo, "src/a")
            head = self.commit_change(repo, "src/a/result.txt", "candidate\n")
            self.invoke(
                "feature-ready", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--head", head, "--check", "targeted=passed",
            )
            self.git(repo, "switch", "main")
            self.git(repo, "merge", "--ff-only", branch)
            candidate = self.git(repo, "rev-parse", "main")
            self.invoke(
                "integrate", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--main-sha", candidate,
            )
            self.invoke("task-done", "--repo", str(repo), "--run", run_id, "--issue", "a")
            defect = self.invoke(
                "defect", "--repo", str(repo), "--run", run_id,
                "--route", "coordinator", "--summary", "small runtime fix",
                "--path", "src/fix", "--path", "tests/fix",
            )["defect"]
            (repo / "src" / "fix").mkdir(parents=True)
            (repo / "src" / "fix" / "runtime.py").write_text("fixed = True\n", encoding="utf-8")
            (repo / "apps" / "web").mkdir(parents=True)
            (repo / "apps" / "web" / "origin.py").write_text("origin = True\n", encoding="utf-8")
            (repo / "packages" / "export").mkdir(parents=True)
            (repo / "packages" / "export" / "archive.py").write_text("archive = True\n", encoding="utf-8")
            self.git(repo, "add", "src/fix/runtime.py", "apps/web/origin.py", "packages/export/archive.py")
            self.git(repo, "commit", "-m", "expand repair across systems")
            fixed_sha = self.git(repo, "rev-parse", "main")
            assessment = self.invoke(
                "defect-assess", "--repo", str(repo), "--run", run_id,
                "--defect", defect["id"], "--head", fixed_sha, "--result", "failed",
            )
            self.assertTrue(assessment["defect"]["reclassification_required"])
            self.assertEqual(assessment["next_action"], "reclassify-in-linear")
            self.assertEqual(
                assessment["defect"]["assessment"]["out_of_scope_paths"],
                ["apps/web/origin.py", "packages/export/archive.py"],
            )
            blocked = self.invoke(
                "defect-resolve", "--repo", str(repo), "--run", run_id,
                "--defect", defect["id"], "--fixed-sha", fixed_sha, expected=2,
            )
            self.assertEqual(blocked["code"], "DEFECT_RECLASSIFICATION_REQUIRED")
            reclassified = self.invoke(
                "defect-reclassify", "--repo", str(repo), "--run", run_id,
                "--defect", defect["id"], "--route", "new-bug",
                "--linear-issue-id", "linear-bug-1",
            )["defect"]
            self.assertEqual(reclassified["linear_issue_id"], "linear-bug-1")
            resolved = self.invoke(
                "defect-resolve", "--repo", str(repo), "--run", run_id,
                "--defect", defect["id"], "--fixed-sha", fixed_sha,
            )["defect"]
            self.assertEqual(resolved["status"], "resolved")

    def test_third_failed_coordinator_repair_attempt_requires_reclassification(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            branch = "codex/and-1-repair-budget"
            self.git(repo, "switch", "-c", branch)
            self.claim(repo, run_id, "a", "coordinator", branch, repo, "src/a")
            head = self.commit_change(repo, "src/a/result.txt", "candidate\n")
            self.invoke(
                "feature-ready", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--head", head, "--check", "targeted=passed",
            )
            self.git(repo, "switch", "main")
            self.git(repo, "merge", "--ff-only", branch)
            candidate = self.git(repo, "rev-parse", "main")
            self.invoke(
                "integrate", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--main-sha", candidate,
            )
            self.invoke("task-done", "--repo", str(repo), "--run", run_id, "--issue", "a")
            defect = self.invoke(
                "defect", "--repo", str(repo), "--run", run_id,
                "--route", "coordinator", "--summary", "bounded repair keeps failing",
                "--path", "src/fix",
            )["defect"]
            for attempt in range(1, 4):
                assessment = self.invoke(
                    "defect-assess", "--repo", str(repo), "--run", run_id,
                    "--defect", defect["id"], "--result", "failed",
                )["defect"]
                self.assertEqual(assessment["failed_attempts"], attempt)
            self.assertTrue(assessment["reclassification_required"])
            self.assertIn("repair reached 3 failed attempts", assessment["assessment"]["reasons"])

    def test_uat_url_rejects_credentials_query_and_fragment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            run_id = run["run_id"]
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            branch = "codex/and-1-url"
            self.git(repo, "switch", "-c", branch)
            self.claim(repo, run_id, "a", "coordinator", branch, repo, "src/a")
            head = self.commit_change(repo, "src/a/result.txt", "url\n")
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
            for unsafe in (
                "https://user:secret@uat.example.invalid/path",
                "https://uat.example.invalid/path?token=secret",
                "https://uat.example.invalid/path#private",
            ):
                error = self.invoke(
                    "batch-uat", "--repo", str(repo), "--run", run_id,
                    "--batch", batch["id"], "--deployment", "uat-1",
                    "--url", unsafe, "--result", "passed", expected=2,
                )
                self.assertEqual(error["code"], "UAT_URL_INVALID")

    def test_every_durable_checkpoint_is_readable_by_a_fresh_process(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self.repo_fixture(root)
            run = self.init_run(repo)
            run_id = run["run_id"]

            def fresh_status() -> dict[str, object]:
                completed = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPTS / "shipctl.py"),
                        "status",
                        "--repo",
                        str(repo),
                        "--run",
                        run_id,
                    ],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                return json.loads(completed.stdout)["run"]

            self.assertEqual(fresh_status()["tasks"], {})
            self.plan(repo, run_id, root, [self.issue("a", "AND-1")])
            self.assertEqual(fresh_status()["tasks"]["a"]["status"], "ready")
            branch = "codex/and-1-resume"
            self.git(repo, "switch", "-c", branch)
            self.claim(repo, run_id, "a", "coordinator", branch, repo, "src/a")
            self.assertEqual(fresh_status()["tasks"]["a"]["status"], "running")
            head = self.commit_change(repo, "src/a/result.txt", "resume\n")
            self.invoke(
                "feature-ready", "--repo", str(repo), "--run", run_id,
                "--issue", "a", "--head", head, "--check", "targeted=passed",
            )
            self.assertEqual(fresh_status()["tasks"]["a"]["status"], "feature-ready")
            self.git(repo, "switch", "main")
            self.git(repo, "merge", "--ff-only", branch)
            main_sha = self.git(repo, "rev-parse", "main")
            self.invoke("integrate", "--repo", str(repo), "--run", run_id, "--issue", "a", "--main-sha", main_sha)
            self.assertEqual(fresh_status()["tasks"]["a"]["status"], "integrated")
            self.invoke("task-done", "--repo", str(repo), "--run", run_id, "--issue", "a")
            self.assertEqual(fresh_status()["tasks"]["a"]["status"], "done")
            batch = self.invoke(
                "batch-create", "--repo", str(repo), "--run", run_id,
                "--candidate", main_sha, "--gate", "passed",
            )["batch"]
            self.assertEqual(fresh_status()["batches"][0]["state"], "validated")
            self.invoke(
                "batch-uat", "--repo", str(repo), "--run", run_id,
                "--batch", batch["id"], "--deployment", "uat-resume",
                "--url", "https://uat.example.invalid", "--result", "passed",
            )
            self.assertEqual(fresh_status()["batches"][0]["state"], "uat-passed")
            self.invoke("complete", "--repo", str(repo), "--run", run_id, "--main-sha", main_sha)
            self.assertEqual(fresh_status()["status"], "completed")

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
