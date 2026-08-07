#!/usr/bin/env python3
"""Deterministic, bounded helpers for ship-linear-release startup.

Policy remains in SKILL.md and references. This CLI only collects compact
evidence and validates repetitive inputs; it never changes Git or Linear.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
import uuid
from pathlib import Path
from typing import Any

import inspect_foreign_main as foreign_main

SKILL_PATH = ".agents/skills/ship-linear-release"
TERMINAL_OWNER_STATES = {"complete", "aborted", "retired"}
REQUIRED_MANIFEST_FIELDS = {
    "run_id",
    "run_key",
    "owner_id",
    "owner_epoch",
    "claim_generation",
    "claim_token",
    "issue_id",
    "issue_identifier",
    "project_id",
    "milestone_id",
    "repo",
    "worktree",
    "branch",
    "feature_ref",
    "guard_ref",
    "guard_tip",
    "root_sha",
    "base_sha",
    "queue_fingerprint",
    "issue_updated_at",
    "ownership_paths",
    "remote_mode",
}

DOCS = {
    "overview": "docs/overview.md",
    "roadmap": "docs/roadmap.md",
    "brand": "docs/brand.md",
    "domain": "docs/specs/domain-model.md",
    "opening": "docs/specs/personalized-opening.md",
    "architecture": "docs/architecture.md",
    "mvp": "docs/specs/mvp.md",
    "api": "docs/specs/api.md",
    "okf": "docs/reports/2026-08-05-okf-status.md",
    "platform": "docs/reports/2026-08-05-platform-status.md",
}
ALL_DOCS = list(DOCS.values())
SURFACE_DOCS = {
    "coordinator": [],
    "skill": [],
    "ui": [DOCS["overview"], DOCS["brand"], DOCS["opening"], DOCS["mvp"]],
    "control": [DOCS["overview"], DOCS["domain"], DOCS["architecture"], DOCS["mvp"]],
    "content": [DOCS["overview"], DOCS["domain"], DOCS["architecture"], DOCS["mvp"], DOCS["api"]],
    "mcp": [DOCS["overview"], DOCS["architecture"], DOCS["mvp"], DOCS["api"], DOCS["platform"]],
    "okf": [DOCS["overview"], DOCS["mvp"], DOCS["api"], DOCS["okf"]],
    "sites": [DOCS["overview"], DOCS["roadmap"], DOCS["architecture"], DOCS["mvp"], DOCS["platform"]],
    "docs": [DOCS["overview"]],
    "unknown": ALL_DOCS,
}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def git(repo: Path, *args: str) -> tuple[int, str]:
    result = foreign_main.run(repo, *args)
    return result.returncode, result.stdout.decode("utf-8", "surrogateescape").strip()


def fields(message: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for line in message.splitlines():
        key, separator, value = line.partition(":")
        if separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            parsed[key] = value.strip()
    return parsed


def coordinator_refs(repo: Path, remote: str) -> tuple[str, list[dict[str, str]]]:
    result = foreign_main.run(
        repo,
        "ls-remote",
        "--heads",
        remote,
        "refs/heads/codex/release/coordinator",
        "refs/heads/codex/release/*/coordinator",
    )
    if result.returncode != 0:
        return "unavailable", []
    refs: list[dict[str, str]] = []
    for line in result.stdout.decode("ascii", "replace").splitlines():
        sha, ref = line.split(maxsplit=1)
        status, owner_state, owner_proof = "unknown", "unknown", "unknown"
        if foreign_main.object_exists(repo, sha):
            code, message = git(repo, "show", "-s", "--format=%B", sha)
            if code == 0:
                metadata = fields(message)
                status = metadata.get("STATE", "unknown").lower()
                owner_state = metadata.get("OWNER_STATE", "unknown").lower()
                owner_proof = metadata.get("OWNER_PROOF_DIGEST", "unknown")
        refs.append(
            {
                "ref": ref,
                "sha": sha,
                "state": status,
                "owner_state": owner_state,
                "owner_proof_digest": owner_proof,
            }
        )
    return "observed", refs


def tree_oid(repo: Path, sha: str | None, path: str) -> str | None:
    if not sha or not foreign_main.object_exists(repo, sha):
        return None
    code, value = git(repo, "rev-parse", f"{sha}:{path}")
    return value if code == 0 else None


def tracked_at(repo: Path, sha: str | None, path: str) -> bool:
    if not sha or not foreign_main.object_exists(repo, sha):
        return False
    return git(repo, "cat-file", "-e", f"{sha}:{path}")[0] == 0


def dirty_skill(repo: Path, path: str) -> tuple[str, int]:
    code, raw = git(repo, "status", "--porcelain=v1", "--untracked-files=normal", "--", path)
    if code != 0:
        return "unknown", 0
    entries = [line for line in raw.splitlines() if line]
    return ("clean" if not entries else "dirty"), len(entries)


def command_preflight(args: argparse.Namespace) -> int:
    requested = Path(args.repo).resolve()
    code, top = git(requested, "rev-parse", "--show-toplevel")
    if code != 0:
        emit({"schema": 1, "status": "blocked", "reason": "not-a-repository"})
        return 2
    repo = Path(top)
    remote_sha, remote_state, remote_error = foreign_main.remote_sha(repo, args.remote, args.default)
    checkout, checkout_state, checkout_error, checkout_count = foreign_main.discover_default_checkout(repo, args.default)
    skill_state, skill_changes = dirty_skill(repo, args.skill_path)
    refs_state, refs = coordinator_refs(repo, args.remote)
    active = [
        item
        for item in refs
        if item["owner_state"] not in TERMINAL_OWNER_STATES
        and item["state"] not in TERMINAL_OWNER_STATES
    ]
    contract_oid = tree_oid(repo, remote_sha, args.skill_path)
    local_contract = tree_oid(repo, foreign_main.text(repo, "rev-parse", "HEAD"), args.skill_path)
    if tracked_at(repo, remote_sha, ".openai/hosting.json"):
        profile = "release"
    elif tracked_at(repo, remote_sha, "package.json") or tracked_at(repo, remote_sha, "packages"):
        profile = "build"
    else:
        profile = "design"

    route = "normal"
    reasons: list[str] = []
    if remote_state != "observed" or checkout_state not in {"observed", "absent"} or refs_state != "observed":
        route = "blocked"
        reasons.append("incomplete-git-evidence")
    if skill_state != "clean" or contract_oid is None:
        route = "blocked"
        reasons.append("contract-not-clean-or-unavailable")
    if active and route != "blocked":
        proof_matches = bool(args.owner_proof_digest) and any(
            item["owner_proof_digest"] == args.owner_proof_digest for item in active
        )
        route = "resume" if proof_matches else "recovery"
        reasons.append("active-coordinator-ref")

    required_refs = {
        "normal": ["references/coordination.md"],
        "resume": ["references/coordination.md", "references/crash-recovery.md"],
        "recovery": ["references/coordination.md", "references/crash-recovery.md"],
        "blocked": [],
    }[route]
    payload = {
        "schema": 1,
        "status": "ok" if route != "blocked" else "blocked",
        "route": route,
        "reasons": reasons or ["clean-start"],
        "repo": str(repo),
        "default": args.default,
        "remote": args.remote,
        "remote_sha": remote_sha,
        "remote_state": remote_state,
        "remote_error": remote_error,
        "default_checkout": str(checkout) if checkout else None,
        "default_checkout_state": checkout_state,
        "default_checkout_error": checkout_error,
        "default_checkout_count": checkout_count,
        "contract_oid": contract_oid,
        "local_contract_oid": local_contract,
        "contract_matches_head": contract_oid is not None and contract_oid == local_contract,
        "skill_state": skill_state,
        "skill_changes": skill_changes,
        "delivery_profile": profile,
        "coordinator_refs_state": refs_state,
        "coordinator_refs": refs,
        "required_references": required_refs,
        "startup_budget": {"max_calls_before_worker": 12, "max_milestone_snapshots": 1},
    }
    emit(payload)
    return 0 if route != "blocked" else 3


def infer_surface(path: str) -> str:
    value = path.replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    if value.startswith(".agents/skills/ship-linear-release/"):
        return "skill"
    if value.startswith("packages/adapter-web/") or "ui" in value:
        return "ui"
    if value.startswith("packages/adapter-mcp/") or "conformance" in value:
        return "mcp"
    if value.startswith("packages/okf-codec/") or "fixture" in value:
        return "okf"
    if value.startswith("packages/application-control/") or value.startswith("packages/domain/"):
        return "control"
    if value.startswith("packages/application-content/"):
        return "content"
    if value.startswith(".openai/") or "sites" in value.lower():
        return "sites"
    if value.startswith("docs/") or value in {"AGENTS.md", "README.md"}:
        return "docs"
    return "unknown"


def route_docs(paths: list[str], surface: str | None) -> tuple[list[str], list[str]]:
    surfaces = [surface] if surface else [infer_surface(path) for path in paths]
    if not surfaces:
        surfaces = ["unknown"]
    docs: list[str] = []
    for selected in surfaces:
        for path in SURFACE_DOCS[selected]:
            if path not in docs:
                docs.append(path)
    return surfaces, docs


def command_docs(args: argparse.Namespace) -> int:
    surfaces, docs = route_docs(args.path, args.surface)
    digest = hashlib.sha256("\0".join(docs).encode()).hexdigest()
    emit(
        {
            "schema": 1,
            "status": "ok",
            "always": ["AGENTS.md", f"{SKILL_PATH}/references/issue-worker.md"],
            "surfaces": surfaces,
            "documents": docs,
            "fallback_all": "unknown" in surfaces,
            "digest": digest,
        }
    )
    return 0


def command_identities(_: argparse.Namespace) -> int:
    emit(
        {
            "schema": 1,
            "run_id": str(uuid.uuid4()),
            "owner_id": str(uuid.uuid4()),
            "run_key": secrets.token_hex(16),
        }
    )
    return 0


def command_manifest(args: argparse.Namespace) -> int:
    try:
        raw = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
        manifest = json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        emit({"schema": 1, "status": "invalid", "errors": [f"input:{type(error).__name__}"]})
        return 2
    errors = [f"missing:{name}" for name in sorted(REQUIRED_MANIFEST_FIELDS - manifest.keys())]
    run_key = manifest.get("run_key", "")
    if not isinstance(run_key, str) or re.fullmatch(r"[0-9a-fA-F]{32,}", run_key) is None:
        errors.append("invalid:run_key")
    ownership = manifest.get("ownership_paths")
    if not isinstance(ownership, list) or not ownership or not all(isinstance(path, str) and path for path in ownership):
        errors.append("invalid:ownership_paths")
    if manifest.get("remote_mode") not in {"online", "offline-local-only"}:
        errors.append("invalid:remote_mode")
    surface = manifest.get("surface")
    if surface is not None and surface not in SURFACE_DOCS:
        errors.append("invalid:surface")
        surface = "unknown"
    surfaces, docs = route_docs(
        ownership if isinstance(ownership, list) else [], surface
    )
    normalized = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    emit(
        {
            "schema": 1,
            "status": "valid" if not errors else "invalid",
            "errors": errors,
            "manifest_digest": hashlib.sha256(normalized.encode()).hexdigest(),
            "surfaces": surfaces,
            "documents": docs,
        }
    )
    return 0 if not errors else 2


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    preflight = sub.add_parser("preflight")
    preflight.add_argument("--repo", default=".")
    preflight.add_argument("--remote", default="origin")
    preflight.add_argument("--default", default="main")
    preflight.add_argument("--skill-path", default=SKILL_PATH)
    preflight.add_argument("--owner-proof-digest")
    preflight.set_defaults(handler=command_preflight)
    docs = sub.add_parser("docs")
    docs.add_argument("--path", action="append", default=[])
    docs.add_argument("--surface", choices=sorted(SURFACE_DOCS))
    docs.set_defaults(handler=command_docs)
    identities = sub.add_parser("identities")
    identities.set_defaults(handler=command_identities)
    manifest = sub.add_parser("manifest")
    manifest.add_argument("--input", default="-")
    manifest.set_defaults(handler=command_manifest)
    return root


def main() -> int:
    args = parser().parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
