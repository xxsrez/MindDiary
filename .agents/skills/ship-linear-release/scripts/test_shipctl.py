#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
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

    def test_unknown_path_fails_safe_to_all_documents(self) -> None:
        surfaces, docs = MODULE.route_docs(["new-surface/file.ts"], None)
        self.assertEqual(surfaces, ["unknown"])
        self.assertEqual(docs, MODULE.ALL_DOCS)


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


class ManifestTest(unittest.TestCase):
    def valid_manifest(self) -> dict[str, object]:
        return {
            name: "value" for name in MODULE.REQUIRED_MANIFEST_FIELDS
        } | {
            "run_key": "a" * 32,
            "ownership_paths": ["packages/domain/src/index.ts"],
            "remote_mode": "online",
        }

    def invoke(self, payload: dict[str, object]) -> tuple[int, dict[str, object]]:
        args = mock.Mock(input="-")
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), io.StringIO() as output, redirect_stdout(output):
            code = MODULE.command_manifest(args)
            return code, json.loads(output.getvalue())

    def test_validates_and_routes_manifest(self) -> None:
        code, result = self.invoke(self.valid_manifest())
        self.assertEqual((code, result["status"]), (0, "valid"))
        self.assertIn("docs/specs/domain-model.md", result["documents"])

    def test_rejects_missing_and_weak_identity(self) -> None:
        payload = self.valid_manifest()
        del payload["claim_token"]
        payload["run_key"] = "short"
        code, result = self.invoke(payload)
        self.assertEqual((code, result["status"]), (2, "invalid"))
        self.assertIn("missing:claim_token", result["errors"])
        self.assertIn("invalid:run_key", result["errors"])

    def test_unknown_declared_surface_fails_safe(self) -> None:
        payload = self.valid_manifest()
        payload["surface"] = "invented"
        code, result = self.invoke(payload)
        self.assertEqual((code, result["status"]), (2, "invalid"))
        self.assertIn("invalid:surface", result["errors"])
        self.assertEqual(result["documents"], MODULE.ALL_DOCS)


class GitFixture(unittest.TestCase):
    def git(self, repo: Path, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ).stdout.strip()

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
        (repo / "package.json").write_text("{}\n", encoding="utf-8")
        self.git(repo, "add", MODULE.SKILL_PATH, "package.json")
        self.git(repo, "commit", "-m", "base")
        self.git(repo, "remote", "add", "origin", str(remote))
        self.git(repo, "push", "-u", "origin", "main")
        return repo, remote

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

    def test_clean_preflight_is_normal_build_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            code, result, size = self.preflight(repo)
        self.assertEqual((code, result["route"], result["delivery_profile"]), (0, "normal", "build"))
        self.assertLess(size, 8000)

    def test_active_claim_routes_to_recovery_or_proven_resume(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            self.git(repo, "switch", "--orphan", "claim")
            self.git(repo, "commit", "--allow-empty", "-m", "claim\n\nSTATE: running\nOWNER_STATE: active\nOWNER_PROOF_DIGEST: proof")
            self.git(repo, "push", "origin", "HEAD:refs/heads/codex/release/coordinator")
            self.git(repo, "switch", "main")
            _, recovery, _ = self.preflight(repo)
            _, resume, _ = self.preflight(repo, "proof")
        self.assertEqual(recovery["route"], "recovery")
        self.assertEqual(resume["route"], "resume")

    def test_dirty_skill_blocks_dispatch(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shipctl-") as directory:
            repo, _ = self.fixture(Path(directory))
            (repo / MODULE.SKILL_PATH / "SKILL.md").write_text("dirty\n", encoding="utf-8")
            code, result, _ = self.preflight(repo)
        self.assertEqual((code, result["route"]), (3, "blocked"))


if __name__ == "__main__":
    unittest.main()
