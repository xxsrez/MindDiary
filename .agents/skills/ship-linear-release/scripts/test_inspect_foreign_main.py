#!/usr/bin/env python3

from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("inspect_foreign_main.py")
SPEC = importlib.util.spec_from_file_location("inspect_foreign_main", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class StatusParsingTest(unittest.TestCase):
    def test_tracks_both_sides_of_rename_and_dirty_classes(self) -> None:
        raw = (
            b"M  staged.txt\0"
            b" M unstaged.txt\0"
            b"?? untracked.txt\0"
            b"R  renamed.txt\0old-name.txt\0"
            b"UU conflict.txt\0"
        )
        paths, staged, unstaged, untracked, dirty = MODULE.parse_status(raw)
        self.assertEqual(
            paths,
            [
                "conflict.txt",
                "old-name.txt",
                "renamed.txt",
                "staged.txt",
                "unstaged.txt",
                "untracked.txt",
            ],
        )
        self.assertEqual((staged, unstaged, untracked, dirty), (3, 2, 1, "both"))


class BoundedCommandTest(unittest.TestCase):
    def test_timeout_is_categorical_and_noninteractive(self) -> None:
        expired = subprocess.TimeoutExpired(["git"], 1, output=b"")
        with mock.patch.object(MODULE.subprocess, "run", side_effect=expired) as invoked:
            result = MODULE.run(Path("."), "status")
        self.assertEqual((result.returncode, result.error), (124, "timeout"))
        kwargs = invoked.call_args.kwargs
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["timeout"], MODULE.COMMAND_TIMEOUT_SECONDS)
        self.assertEqual(kwargs["env"]["GIT_OPTIONAL_LOCKS"], "0")
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")

    def test_relation_never_turns_command_timeout_into_divergence(self) -> None:
        timeout = MODULE.CommandResult(124, b"", "timeout")
        not_ancestor = MODULE.CommandResult(1, b"", "git-error")
        with mock.patch.object(MODULE, "object_exists", return_value=True), mock.patch.object(
            MODULE, "run", side_effect=[timeout, not_ancestor]
        ):
            observed = MODULE.relation(Path("."), "a" * 40, "b" * 40)
        self.assertEqual(observed, "unknown")

    def test_main_does_not_call_spawn_failure_not_a_repository(self) -> None:
        with mock.patch.object(
            MODULE, "run", return_value=MODULE.CommandResult(127, b"", "spawn-error")
        ), mock.patch.object(
            sys, "argv", [str(SCRIPT), "--repo", ".", "--default", "main"]
        ), io.StringIO() as output, redirect_stdout(output):
            exit_code = MODULE.main()
            payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 3)
        self.assertEqual(
            (payload["status"], payload["probe_error"]),
            ("unavailable", "spawn-error"),
        )


class GitRelationTest(unittest.TestCase):
    def git(self, repo: Path, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ).stdout.strip()

    def test_equal_behind_ahead_diverged_and_checkout_discovery(self) -> None:
        with tempfile.TemporaryDirectory(prefix="foreign-main-test-") as directory:
            repo = Path(directory)
            self.git(repo, "init", "-b", "main")
            self.git(repo, "config", "user.name", "test")
            self.git(repo, "config", "user.email", "test@example.invalid")
            self.git(repo, "commit", "--allow-empty", "-m", "base")
            base = self.git(repo, "rev-parse", "HEAD")
            self.git(repo, "commit", "--allow-empty", "-m", "left")
            left = self.git(repo, "rev-parse", "HEAD")
            self.git(repo, "switch", "-c", "right", base)
            self.git(repo, "commit", "--allow-empty", "-m", "right")
            right = self.git(repo, "rev-parse", "HEAD")

            self.assertEqual(MODULE.relation(repo, base, base), "equal")
            self.assertEqual(MODULE.relation(repo, base, left), "behind")
            self.assertEqual(MODULE.relation(repo, left, base), "ahead")
            self.assertEqual(MODULE.relation(repo, left, right), "diverged")

            checkout, state, error, count = MODULE.discover_default_checkout(
                repo, "main"
            )
            self.assertIsNone(checkout)
            self.assertEqual((state, error, count), ("absent", None, 0))

    def test_cli_fails_closed_on_missing_remote_and_allows_no_default_checkout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="foreign-main-cli-") as directory:
            root = Path(directory)
            repo = root / "repo"
            remote = root / "remote.git"
            self.git(root, "init", "--bare", str(remote))
            self.git(root, "init", "-b", "main", str(repo))
            self.git(repo, "config", "user.name", "test")
            self.git(repo, "config", "user.email", "test@example.invalid")
            self.git(repo, "commit", "--allow-empty", "-m", "base")
            self.git(repo, "remote", "add", "origin", str(remote))

            missing = subprocess.run(
                [sys.executable, str(SCRIPT), "--repo", str(repo), "--default", "main"],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            missing_json = json.loads(missing.stdout)
            self.assertEqual(missing.returncode, 3)
            self.assertEqual(
                (missing_json["status"], missing_json["remote_status"]),
                ("partial", "missing"),
            )

            self.git(repo, "push", "-u", "origin", "main")
            self.git(repo, "switch", "-c", "other")
            observed = subprocess.run(
                [sys.executable, str(SCRIPT), "--repo", str(repo), "--default", "main"],
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            observed_json = json.loads(observed.stdout)
            self.assertEqual(observed_json["status"], "ok")
            self.assertEqual(observed_json["checkout_discovery"], "absent")
            self.assertEqual(observed_json["relation"], "equal")


if __name__ == "__main__":
    unittest.main()
