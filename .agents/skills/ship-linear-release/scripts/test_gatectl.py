#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).with_name("gatectl.py")
KEY = "a" * 64


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


class GatectlTest(unittest.TestCase):
    def git(self, cwd: Path, *arguments: str) -> str:
        return subprocess.run(
            ["git", "-C", str(cwd), *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()

    def fixture(self, root: Path) -> tuple[Path, Path]:
        root.mkdir(parents=True, exist_ok=True)
        state = root / "state"
        cwd = root / "cwd"
        subprocess.run(
            ["git", "init", "-b", "main", str(cwd)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            check=True,
        )
        self.git(cwd, "config", "user.name", "gatectl test")
        self.git(cwd, "config", "user.email", "gatectl@example.invalid")
        (cwd / "tracked.txt").write_text("clean\n")
        self.git(cwd, "add", "tracked.txt")
        self.git(cwd, "commit", "-m", "fixture")
        return state, cwd

    def run_args(
        self,
        state: Path,
        working_directory: Path,
        plan: list[str] | list[list[str]],
        **overrides: str,
    ) -> list[str]:
        normalized_plan: list[list[str]]
        if plan and isinstance(plan[0], str):
            normalized_plan = [plan]  # type: ignore[list-item]
        else:
            normalized_plan = plan  # type: ignore[assignment]
        values = {
            "state_dir": str(state),
            "validation_key": KEY,
            "cutoff_id": "cutoff-1",
            "generation": "1",
            "candidate_sha": self.git(working_directory, "rev-parse", "HEAD"),
            "environment_id": "local-node22",
            "cwd": str(working_directory),
            "plan_json": json.dumps(normalized_plan),
        }
        values.update(overrides)
        return [
            sys.executable,
            str(SCRIPT),
            "run",
            "--state-dir",
            values["state_dir"],
            "--validation-key",
            values["validation_key"],
            "--cutoff-id",
            values["cutoff_id"],
            "--generation",
            values["generation"],
            "--candidate-sha",
            values["candidate_sha"],
            "--environment-id",
            values["environment_id"],
            "--cwd",
            values["cwd"],
            "--plan-json",
            values["plan_json"],
        ]

    def invoke(self, args: list[str], timeout: float = 10) -> tuple[int, dict[str, Any], str]:
        completed = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        self.assertTrue(completed.stdout, completed.stderr)
        return completed.returncode, json.loads(completed.stdout), completed.stderr

    def counter_command(self, counter: Path, exit_code: int = 0) -> list[str]:
        source = (
            "from pathlib import Path; import sys; "
            "p=Path(sys.argv[1]); "
            "p.write_text((p.read_text() if p.exists() else '')+'x\\n'); "
            f"raise SystemExit({exit_code})"
        )
        return [sys.executable, "-c", source, str(counter)]

    def ordered_command(
        self, record: Path, label: str, exit_code: int = 0
    ) -> list[str]:
        source = (
            "from pathlib import Path; import sys; "
            "p=Path(sys.argv[1]); "
            "p.write_text((p.read_text() if p.exists() else '')+sys.argv[2]+'\\n'); "
            "raise SystemExit(int(sys.argv[3]))"
        )
        return [
            sys.executable,
            "-c",
            source,
            str(record),
            label,
            str(exit_code),
        ]

    def test_exact_second_invocation_adopts_without_rerun(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            counter = root / "counter"
            args = self.run_args(state, cwd, self.counter_command(counter))
            first_code, first, _ = self.invoke(args)
            second_code, second, _ = self.invoke(args)

            self.assertEqual((first_code, first["status"], first["adopted"]), (0, "passed", False))
            self.assertEqual((second_code, second["status"], second["adopted"]), (0, "passed", True))
            self.assertEqual(counter.read_text().splitlines(), ["x"])
            self.assertEqual(first["result_sha256"], second["result_sha256"])

    def test_clean_exact_git_candidate_runs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            expected_head = self.git(cwd, "rev-parse", "HEAD")
            code, result, _ = self.invoke(
                self.run_args(state, cwd, [sys.executable, "-c", "pass"])
            )

            self.assertEqual((code, result["status"]), (0, "passed"))
            self.assertIsNone(result["failed_step"])
            manifest = json.loads((state.resolve() / KEY / "request.json").read_text())
            self.assertEqual(manifest["request"]["candidate_sha"], expected_head)

    def test_wrong_head_and_dirty_tracked_checkout_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            wrong_state, wrong_cwd = self.fixture(root / "wrong")
            code, result, _ = self.invoke(
                self.run_args(
                    wrong_state,
                    wrong_cwd,
                    [sys.executable, "-c", "pass"],
                    candidate_sha="c" * 40,
                )
            )
            self.assertEqual(
                (code, result["status"], result["reason"]),
                (2, "error", "candidate-head-mismatch"),
            )

            dirty_state, dirty_cwd = self.fixture(root / "dirty")
            (dirty_cwd / "tracked.txt").write_text("dirty\n")
            code, result, _ = self.invoke(
                self.run_args(
                    dirty_state, dirty_cwd, [sys.executable, "-c", "pass"]
                )
            )
            self.assertEqual(
                (code, result["status"], result["reason"]),
                (2, "error", "dirty-candidate-worktree"),
            )

    def test_nonignored_untracked_gate_input_is_rejected_before_execution(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            (cwd / "gate-config.py").write_text("unsafe configuration\n")
            executed = root / "command-executed"
            command = [
                sys.executable,
                "-c",
                (
                    "from pathlib import Path; import sys; "
                    "Path(sys.argv[1]).write_text(Path('gate-config.py').read_text())"
                ),
                str(executed),
            ]
            code, result, _ = self.invoke(self.run_args(state, cwd, command))

            self.assertEqual(
                (code, result["status"], result["reason"]),
                (2, "error", "dirty-candidate-worktree"),
            )
            self.assertFalse(executed.exists())
            self.assertFalse((state.resolve() / KEY / "result.json").exists())

    def test_candidate_drift_during_gate_becomes_terminal_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            second_step_ran = root / "second-step-ran"
            command = [
                sys.executable,
                "-c",
                "from pathlib import Path; Path('tracked.txt').write_text('changed\\n')",
            ]
            args = self.run_args(
                state,
                cwd,
                [
                    command,
                    [
                        sys.executable,
                        "-c",
                        "from pathlib import Path; import sys; Path(sys.argv[1]).touch()",
                        str(second_step_ran),
                    ],
                ],
            )
            first_code, first, _ = self.invoke(args)
            second_code, second, _ = self.invoke(args)

            self.assertEqual(
                (first_code, first["status"], first["exit_code"]),
                (1, "failed", 125),
            )
            self.assertEqual(first["failed_step"], 1)
            self.assertFalse(second_step_ran.exists())
            self.assertEqual(
                (second_code, second["status"], second["adopted"]),
                (1, "failed", True),
            )
            log = (state.resolve() / KEY / first["log_file"]).read_text()
            self.assertIn("dirty-candidate-worktree", log)

    def test_failed_result_is_terminal_and_adopted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            counter = root / "counter"
            args = self.run_args(state, cwd, self.counter_command(counter, 7))
            first_code, first, _ = self.invoke(args)
            second_code, second, _ = self.invoke(args)

            self.assertEqual((first_code, first["status"], first["exit_code"]), (1, "failed", 7))
            self.assertEqual(first["failed_step"], 1)
            self.assertEqual((second_code, second["status"], second["adopted"]), (1, "failed", True))
            self.assertEqual(counter.read_text().splitlines(), ["x"])

    def test_different_plan_under_same_key_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            first_args = self.run_args(
                state,
                cwd,
                [
                    [sys.executable, "-c", "pass"],
                    [sys.executable, "-c", "print('first plan')"],
                ],
            )
            second_args = self.run_args(
                state,
                cwd,
                [
                    [sys.executable, "-c", "pass"],
                    [sys.executable, "-c", "print('different plan')"],
                ],
            )
            self.assertEqual(self.invoke(first_args)[0], 0)
            code, result, _ = self.invoke(second_args)

            self.assertEqual(code, 2)
            self.assertEqual((result["status"], result["reason"]), ("error", "request-mismatch"))

    def test_plan_runs_in_order_and_records_step_boundaries(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            record = root / "order"
            plan = [
                self.ordered_command(record, "one"),
                self.ordered_command(record, "two"),
                self.ordered_command(record, "three"),
            ]
            code, result, _ = self.invoke(self.run_args(state, cwd, plan))

            self.assertEqual((code, result["status"]), (0, "passed"))
            self.assertIsNone(result["failed_step"])
            self.assertEqual(record.read_text().splitlines(), ["one", "two", "three"])
            manifest = json.loads((state.resolve() / KEY / "request.json").read_text())
            self.assertEqual(manifest["request"]["plan"], plan)
            log = (state.resolve() / KEY / result["log_file"]).read_text()
            boundaries = [log.index(f"step {number}/3 begin") for number in (1, 2, 3)]
            self.assertEqual(boundaries, sorted(boundaries))

    def test_plan_stops_on_first_failure_and_records_failed_step(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            record = root / "order"
            plan = [
                self.ordered_command(record, "one"),
                self.ordered_command(record, "two", 9),
                self.ordered_command(record, "must-not-run"),
            ]
            code, result, _ = self.invoke(self.run_args(state, cwd, plan))

            self.assertEqual(
                (code, result["status"], result["exit_code"], result["failed_step"]),
                (1, "failed", 9, 2),
            )
            self.assertEqual(record.read_text().splitlines(), ["one", "two"])
            log = (state.resolve() / KEY / result["log_file"]).read_text()
            self.assertNotIn("step 3/3 begin", log)

    def test_concurrent_invocation_and_status_report_running(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            marker = root / "started"
            source = (
                "from pathlib import Path; import sys, time; "
                "Path(sys.argv[1]).write_text('started'); time.sleep(2)"
            )
            args = self.run_args(
                state, cwd, [sys.executable, "-c", source, str(marker)]
            )
            running = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(marker.exists(), "gate child did not start")

                code, result, _ = self.invoke(args)
                self.assertEqual((code, result["status"]), (0, "running"))

                status_args = [
                    sys.executable,
                    str(SCRIPT),
                    "status",
                    "--state-dir",
                    str(state),
                    "--validation-key",
                    KEY,
                ]
                status_code, status, _ = self.invoke(status_args)
                self.assertEqual((status_code, status["status"]), (0, "running"))
                self.assertTrue(status["verified"])
            finally:
                stdout, stderr = running.communicate(timeout=5)
            self.assertEqual(running.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout)["status"], "passed")

    def test_interrupted_attempt_retries_only_after_inherited_lock_exits(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            counter = root / "counter"
            source = (
                "from pathlib import Path; import sys, time; "
                "p=Path(sys.argv[1]); "
                "p.write_text((p.read_text() if p.exists() else '')+'x\\n'); "
                "time.sleep(0.8)"
            )
            args = self.run_args(
                state, cwd, [sys.executable, "-c", source, str(counter)]
            )
            interrupted = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            deadline = time.monotonic() + 5
            while not counter.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(counter.exists(), "first gate child did not start")
            interrupted.terminate()
            interrupted.communicate(timeout=5)
            self.assertNotEqual(interrupted.returncode, 0)

            code, result, _ = self.invoke(args)
            self.assertEqual((code, result["status"]), (0, "running"))

            time.sleep(0.9)
            code, result, _ = self.invoke(args)
            self.assertEqual((code, result["status"], result["attempt"]), (0, "passed", 2))
            manifest = json.loads((state.resolve() / KEY / "request.json").read_text())
            self.assertEqual(manifest["attempt_count"], 2)
            self.assertEqual(counter.read_text().splitlines(), ["x", "x"])

    def test_status_verifies_terminal_result(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            self.assertEqual(
                self.invoke(
                    self.run_args(state, cwd, [sys.executable, "-c", "print('ok')"])
                )[0],
                0,
            )
            code, result, _ = self.invoke(
                [
                    sys.executable,
                    str(SCRIPT),
                    "status",
                    "--state-dir",
                    str(state),
                    "--validation-key",
                    KEY,
                ]
            )

            self.assertEqual((code, result["status"]), (0, "passed"))
            self.assertTrue(result["verified"])

    def test_malformed_inputs_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            valid_command = [sys.executable, "-c", "pass"]
            cases = [
                {"state_dir": "relative"},
                {"validation_key": "A" * 64},
                {"generation": "0"},
                {"candidate_sha": "short"},
                {"cwd": str(root / "missing")},
                {"plan_json": "{}"},
                {"plan_json": "[]"},
                {"plan_json": "[[]]"},
                {"plan_json": '["ok",1]'},
                {"plan_json": '[["\\ud800"]]'},
                {"plan_json": json.dumps([["true"]] * 33)},
                {"plan_json": json.dumps([["x"] * 257])},
                {"plan_json": '[[""]]'},
                {"environment_id": "bad environment"},
            ]
            for overrides in cases:
                with self.subTest(overrides=overrides):
                    args = self.run_args(state, cwd, valid_command, **overrides)
                    code, result, _ = self.invoke(args)
                    self.assertEqual(code, 2)
                    self.assertEqual(result["status"], "error")

    def test_request_result_and_log_digests_are_exact(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            code, output, _ = self.invoke(
                self.run_args(state, cwd, [sys.executable, "-c", "print('digest')"])
            )
            self.assertEqual(code, 0)
            key_dir = state.resolve() / KEY
            manifest = json.loads((key_dir / "request.json").read_text())
            result = json.loads((key_dir / "result.json").read_text())

            request_sha = hashlib.sha256(canonical_bytes(manifest["request"])).hexdigest()
            self.assertEqual(manifest["request_sha256"], request_sha)
            self.assertEqual(result["request_sha256"], request_sha)
            log_sha = hashlib.sha256((key_dir / result["log_file"]).read_bytes()).hexdigest()
            self.assertEqual(result["log_sha256"], log_sha)
            unsigned = dict(result)
            result_sha = unsigned.pop("result_sha256")
            self.assertEqual(result_sha, hashlib.sha256(canonical_bytes(unsigned)).hexdigest())
            self.assertEqual(output["result_sha256"], result_sha)

    def test_shell_metacharacters_are_plain_argv_data(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gatectl-") as directory:
            root = Path(directory)
            state, cwd = self.fixture(root)
            sentinel = root / "must-not-exist"
            metacharacters = f"; touch {sentinel}"
            command = [
                sys.executable,
                "-c",
                "import sys; print(sys.argv[1])",
                metacharacters,
            ]
            code, result, _ = self.invoke(self.run_args(state, cwd, command))

            self.assertEqual((code, result["status"]), (0, "passed"))
            self.assertFalse(sentinel.exists())
            log = (state.resolve() / KEY / result["log_file"]).read_text()
            self.assertIn(metacharacters, log)


if __name__ == "__main__":
    unittest.main()
