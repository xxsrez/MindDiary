#!/usr/bin/env python3
"""Deterministic, bounded helpers for ship-linear-release.

Policy remains in SKILL.md and references. Most commands are read-only. The
explicit ``takeover`` command performs one narrowly fenced coordinator-ref CAS
after revalidating a reconciled quiescent handoff; it never mutates Linear,
worktrees, feature refs, default, deployment, or tags.
"""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime
import hashlib
import io
import json
import os
import re
import secrets
import sys
import tempfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

import inspect_foreign_main as foreign_main

SKILL_PATH = ".agents/skills/ship-linear-release"
CANONICAL_COORDINATOR_REF = "refs/heads/codex/release/coordinator"
LEGACY_COORDINATOR_PATTERN = "refs/heads/codex/release/*/coordinator"

KNOWN_RUN_STATES = {
    "claiming",
    "recovering",
    "running",
    "validating",
    "offline-queue",
    "publishing",
    "deploying",
    "stabilizing",
    "checkpoint",
    "needs-input",
    "complete",
    "aborted",
    "retired",
}
KNOWN_OWNER_STATES = {"active", "handoff-ready", "complete", "aborted", "retired"}
TERMINAL_STATES = {"complete", "aborted", "retired"}
LOWER_DIGEST = re.compile(r"[0-9a-f]{64}")
GIT_OID = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")
UUID_TEXT = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
ISSUE_IDENTIFIER = re.compile(r"[A-Z][A-Z0-9]*-[1-9][0-9]*")

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
    "dependency_shas",
    "queue_fingerprint",
    "scope_fingerprint",
    "issue_updated_at",
    "ownership_paths",
    "isolation",
    "validation",
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
    "control": [
        DOCS["overview"],
        DOCS["domain"],
        DOCS["architecture"],
        DOCS["mvp"],
        DOCS["api"],
    ],
    "content": [DOCS["overview"], DOCS["domain"], DOCS["architecture"], DOCS["mvp"], DOCS["api"]],
    "mcp": [DOCS["overview"], DOCS["architecture"], DOCS["mvp"], DOCS["api"], DOCS["platform"]],
    "okf": [DOCS["overview"], DOCS["mvp"], DOCS["api"], DOCS["okf"]],
    "sites": [DOCS["overview"], DOCS["roadmap"], DOCS["architecture"], DOCS["mvp"], DOCS["platform"]],
    "docs": [DOCS["overview"]],
    "unknown": ALL_DOCS,
}

# Ordered, boundary-safe routing. Every package currently tracked by this
# repository has an explicit owner surface; tests are refined below.
PATH_SURFACES: tuple[tuple[str, str], ...] = (
    (".agents/skills/ship-linear-release/", "skill"),
    (".openai/", "sites"),
    ("packages/adapter-web/", "ui"),
    ("packages/adapter-mcp/", "mcp"),
    ("packages/okf-codec/", "okf"),
    ("packages/test-fixtures/", "okf"),
    ("packages/adapter-audit-memory/", "control"),
    ("packages/adapter-metadata-memory/", "control"),
    ("packages/adapter-security-webcrypto/", "control"),
    ("packages/application-control/", "control"),
    ("packages/application-contracts/", "control"),
    ("packages/application-ports/", "control"),
    ("packages/composition-root/", "control"),
    ("packages/domain/", "control"),
    ("packages/adapter-object-memory/", "content"),
    ("packages/adapter-search-memory/", "content"),
    ("packages/application-content/", "content"),
    ("packages/adapter-background/", "content"),
    ("packages/application-background/", "content"),
    ("tests/browser/", "ui"),
    ("tests/fixtures/okf/", "okf"),
    ("docs/", "docs"),
)

TEST_SURFACE_TOKENS: tuple[tuple[str, frozenset[str]], ...] = (
    ("mcp", frozenset({"mcp"})),
    ("okf", frozenset({"okf", "fixture", "fixtures"})),
    ("ui", frozenset({"ui", "onboarding", "client", "browser", "catalog"})),
    (
        "control",
        frozenset(
            {
                "account",
                "authorizer",
                "bootstrap",
                "composition",
                "domain",
                "handle",
                "invitation",
                "membership",
                "ordinary",
                "ownership",
                "personal",
                "security",
                "token",
                "visibility",
            }
        ),
    ),
    (
        "content",
        frozenset(
            {
                "audit",
                "changeset",
                "content",
                "discovery",
                "download",
                "export",
                "idempotency",
                "jobs",
                "object",
                "outbox",
                "revision",
                "storage",
            }
        ),
    ),
)

TRANSITION_NAMESPACE = uuid.UUID("d34453c7-5bd3-5362-a00d-04e8708c6f5a")
STABLE_TRANSITION_HEADERS = (
    "SCHEMA",
    "KIND",
    "OWNER_ID",
    "OWNER_PROOF_KIND",
    "OWNER_PROOF_DIGEST",
    "RUN_ID",
    "RUN_KEY",
    "PROJECT_ID",
    "MILESTONE_ID",
    "EPOCH",
    "STATE",
    "OWNER_STATE",
    "GOAL_CURRENT",
    "GOAL_OBJECTIVE_DIGEST",
    "CONTRACT_SOURCE_SHA",
    "CONTRACT_DIGEST",
    "CONTRACT_MIGRATED_FROM",
    "COMMENT_INDEX",
    "CLAIM_INDEX",
    "EXECUTION_INDEX",
    "PIPELINE",
    "OPEN_CUTOFF",
    "HEALTH",
    "HOLD",
    "PAUSE",
    "QUEUE_FINGERPRINT",
    "STARTED_AT",
)
ACTION_HEADERS = (
    "ACTION_SEQ",
    "ACTION_ID",
    "ACTION_KIND",
    "ACTION_TARGET",
    "EXPECTED_BEFORE",
    "EXTERNAL_REQUEST_KEY",
    "PROVIDER_SELECTOR",
    "PAYLOAD_DIGEST",
    "EFFECT_IDENTITY",
)


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


def _ref_classification(state: str, owner_state: str) -> str:
    if state not in KNOWN_RUN_STATES or owner_state not in KNOWN_OWNER_STATES:
        return "unknown"
    state_terminal = state in TERMINAL_STATES
    owner_terminal = owner_state in TERMINAL_STATES
    if state_terminal and owner_terminal:
        return "terminal"
    if state_terminal != owner_terminal:
        return "incoherent-terminal"
    return "active"


def _remote_url(repo: Path, remote: str) -> str | None:
    code, value = git(repo, "remote", "get-url", remote)
    if code != 0 or not value:
        return None
    if (
        "://" not in value
        and not re.match(r"^[^/]+@[^:]+:", value)
        and not Path(value).is_absolute()
    ):
        return str((repo / value).resolve())
    return value


def create_observation_repo(
    source_repo: Path, destination: Path, remote: str, shas: list[str]
) -> tuple[str, str | None]:
    """Materialize advertised tips only in a disposable bare object database."""
    remote_url = _remote_url(source_repo, remote)
    common_dir = _common_git_dir(source_repo)
    if remote_url is None or common_dir is None:
        return "unavailable", "remote-or-common-dir-unavailable"
    if foreign_main.run(destination, "init", "--bare", ".").returncode != 0:
        return "unavailable", "temporary-bare-init-failed"
    try:
        alternates = destination / "objects" / "info" / "alternates"
        alternates.parent.mkdir(parents=True, exist_ok=True)
        alternates.write_text(str((common_dir / "objects").resolve()) + "\n", encoding="utf-8")
    except OSError:
        return "unavailable", "temporary-alternates-write-failed"
    exact_shas = list(dict.fromkeys(shas))
    if not exact_shas or any(GIT_OID.fullmatch(sha) is None for sha in exact_shas):
        return "unavailable", "invalid-advertised-object-set"
    result = foreign_main.run(
        destination,
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        remote_url,
        *exact_shas,
    )
    if result.returncode != 0:
        return "unavailable", "exact-object-fetch-failed"
    if any(not foreign_main.object_exists(destination, sha) for sha in exact_shas):
        return "unavailable", "exact-object-missing-after-fetch"
    return "observed", None


def legacy_migration_evidence(
    repo: Path, canonical_tip: str, legacy_ref: str, legacy_sha: str
) -> str | None:
    target = f"{legacy_ref}@{legacy_sha}"
    code, candidates = git(
        repo,
        "log",
        "--format=%H",
        "--fixed-strings",
        f"--grep=ACTION_TARGET: {target}",
        "--max-count=16",
        canonical_tip,
    )
    if code != 0:
        return None
    for commit in candidates.splitlines():
        if not GIT_OID.fullmatch(commit):
            continue
        message_code, message = git(repo, "show", "-s", "--format=%B", commit)
        if message_code != 0:
            continue
        metadata = fields(message)
        stop_evidence = metadata.get("LEGACY_STOP_EVIDENCE", "").strip()
        if (
            metadata.get("ACTION_KIND") == "migrate-legacy-ledger"
            and metadata.get("ACTION_TARGET") == target
            and metadata.get("ACTION_STATUS") == "reconciled"
            and stop_evidence
            and stop_evidence.lower() not in {"none", "unknown"}
        ):
            return commit
    return None


def advertised_coordinator_refs(
    repo: Path, remote: str
) -> tuple[str, list[tuple[str, str]]]:
    result = foreign_main.run(
        repo,
        "ls-remote",
        "--heads",
        remote,
        CANONICAL_COORDINATOR_REF,
        LEGACY_COORDINATOR_PATTERN,
    )
    if result.returncode != 0:
        return "unavailable", []
    advertised: list[tuple[str, str]] = []
    for line in result.stdout.decode("ascii", "replace").splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) == 2:
            advertised.append((parts[0], parts[1]))
    return "observed", advertised


def _active_restrictions(metadata: dict[str, str]) -> list[str]:
    active: list[str] = []
    for name in ("HOLD", "PAUSE", "HOLD_PAUSE_INDEX", "PROMOTION_HOLD"):
        value = metadata.get(name)
        if value is None:
            continue
        normalized = value.strip().lower()
        if normalized in {"", "none", "clear", "cleared", "inactive", "released", "resolved"}:
            continue
        structured_state = re.search(r"(?:^|[; ,])state=([a-z][a-z0-9-]*)(?:$|[; ,])", normalized)
        if structured_state and structured_state.group(1) in {"active", "handoff-ready"}:
            active.append(name)
            continue
        if structured_state and structured_state.group(1) in {
            "lifted",
            "cleared",
            "inactive",
            "released",
            "resolved",
        }:
            continue
        if name == "HOLD_PAUSE_INDEX" and re.search(r"(?:^|[; ,])active=(?:0|none)(?:$|[; ,])", normalized):
            continue
        active.append(name)
    return active


def _structured_token(value: str, name: str) -> str | None:
    match = re.search(
        rf"(?:^|[; ,]){re.escape(name.lower())}=([^; ,]+)(?:$|[; ,])",
        value.strip().lower(),
    )
    return match.group(1) if match else None


def _handoff_takeover_ready(metadata: dict[str, str]) -> bool:
    """Recognize a fully reconciled, quiescent owner handoff.

    The handoff target is provenance, not an exclusive capability: the next
    explicitly invoked online coordinator still has to win the expected-old
    coordinator-ref CAS. This permits recovery after an external control task
    without asking the user to type a magic takeover phrase.
    """
    workers = metadata.get("WORKERS", "")
    pause = metadata.get("PAUSE", "")
    target = metadata.get("ACTION_TARGET", "").strip().lower()
    return (
        metadata.get("STATE", "").strip().lower() == "needs-input"
        and metadata.get("OWNER_STATE", "").strip().lower() == "handoff-ready"
        and metadata.get("ACTION_KIND", "").strip().lower() == "handoff-owner"
        and metadata.get("ACTION_STATUS", "").strip().lower() == "reconciled"
        and target not in {"", "none", "unknown"}
        and _structured_token(workers, "executors") == "terminal"
        and _structured_token(workers, "active_issue_lanes") == "none"
        and _structured_token(pause, "state") == "handoff-ready"
        and _structured_token(pause, "pending_external_action") == "none"
    )


def _runtime_owner_proof() -> tuple[str | None, str | None]:
    thread_id = os.environ.get("CODEX_THREAD_ID", "").strip().lower()
    if UUID_TEXT.fullmatch(thread_id) is None:
        return None, None
    return thread_id, hashlib.sha256(thread_id.encode()).hexdigest()


def coordinator_refs(
    observation_repo: Path, advertised: list[tuple[str, str]]
) -> tuple[str, list[dict[str, Any]]]:
    refs: list[dict[str, Any]] = []
    for sha, ref in advertised:
        metadata: dict[str, str] = {}
        metadata_state = "object-unavailable"
        if foreign_main.object_exists(observation_repo, sha):
            code, message = git(observation_repo, "show", "-s", "--format=%B", sha)
            if code == 0:
                metadata = fields(message)
                metadata_state = "observed"
            else:
                metadata_state = "message-unavailable"
        state = metadata.get("STATE", "unknown").lower()
        owner_state = metadata.get("OWNER_STATE", "unknown").lower()
        refs.append(
            {
                "ref": ref,
                "kind": "canonical" if ref == CANONICAL_COORDINATOR_REF else "legacy",
                "sha": sha,
                "metadata_state": metadata_state,
                "state": state,
                "owner_state": owner_state,
                "classification": _ref_classification(state, owner_state),
                "owner_proof_digest": metadata.get("OWNER_PROOF_DIGEST", "unknown"),
                "owner_proof_kind": metadata.get("OWNER_PROOF_KIND", "unknown"),
                "contract_digest": metadata.get("CONTRACT_DIGEST", "unknown"),
                "active_restrictions": _active_restrictions(metadata),
                "handoff_takeover_ready": _handoff_takeover_ready(metadata),
                "action_kind": metadata.get("ACTION_KIND", "unknown"),
                "action_status": metadata.get("ACTION_STATUS", "unknown"),
                "migration_evidence": None,
            }
        )
    canonical = [item for item in refs if item["kind"] == "canonical"]
    if len(canonical) == 1 and canonical[0]["metadata_state"] == "observed":
        for item in refs:
            if item["kind"] != "legacy" or item["classification"] == "terminal":
                continue
            evidence = legacy_migration_evidence(
                observation_repo, canonical[0]["sha"], item["ref"], item["sha"]
            )
            if evidence is not None:
                item["classification"] = "migrated"
                item["migration_evidence"] = evidence
    return "observed", refs


def tree_oid(repo: Path, sha: str | None, path: str) -> str | None:
    if not sha or not foreign_main.object_exists(repo, sha):
        return None
    code, value = git(repo, "rev-parse", f"{sha}:{path}")
    return value if code == 0 and GIT_OID.fullmatch(value) else None


def tracked_at(repo: Path, sha: str | None, path: str) -> bool:
    if not sha or not foreign_main.object_exists(repo, sha):
        return False
    return git(repo, "cat-file", "-e", f"{sha}:{path}")[0] == 0


def dirty_path(repo: Path, path: str) -> tuple[str, int]:
    code, raw = git(repo, "status", "--porcelain=v1", "--untracked-files=normal", "--", path)
    if code != 0:
        return "unknown", 0
    entries = [line for line in raw.splitlines() if line]
    return ("clean" if not entries else "dirty"), len(entries)


def is_control_path(path: str, skill_path: str) -> bool:
    value = normalize_path(path).rstrip("/")
    parts = PurePosixPath(value).parts
    name = PurePosixPath(value).name
    return (
        value in {"AGENTS.md", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".nvmrc", ".node-version", ".tool-versions"}
        or value == skill_path
        or value.startswith(f"{skill_path}/")
        or value.startswith((".github/", ".openai/", "docs/runbooks/"))
        or "scripts" in parts
        or "schemas" in parts
        or "schema" in parts
        or "migrations" in parts
        or "migration" in parts
        or name == "package.json"
        or name.startswith("tsconfig") and name.endswith(".json")
        or name.startswith(("Dockerfile", "railway", "release", "deploy", "rollback"))
    )


def primary_checkout_snapshot(
    repo: Path,
    object_repo: Path,
    checkout: Path | None,
    checkout_state: str,
    checkout_error: str | None,
    checkout_count: int,
    default: str,
    remote_sha: str | None,
    skill_path: str,
    max_paths: int = 80,
) -> dict[str, Any]:
    local_result = foreign_main.run(
        repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{default}"
    )
    if local_result.returncode == 0:
        local_default = local_result.stdout.decode("ascii", "replace").strip()
        local_state = "observed"
    elif local_result.returncode == 1:
        local_default = None
        local_state = "absent"
    else:
        local_default = None
        local_state = "unavailable"

    checkout_head: str | None = None
    checkout_head_state = "not-applicable"
    status_state = "absent" if checkout_state == "absent" else "unavailable"
    dirty = "clean" if checkout_state == "absent" else "unknown"
    raw_status = b""
    paths: list[str] = []
    staged = unstaged = untracked = 0
    if checkout is not None:
        head_result = foreign_main.run(checkout, "rev-parse", "--verify", "HEAD")
        if head_result.returncode == 0:
            checkout_head = head_result.stdout.decode("ascii", "replace").strip()
            checkout_head_state = "observed"
        else:
            checkout_head_state = "unavailable"
        status_result = foreign_main.run(
            checkout,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignored=no",
        )
        if status_result.returncode == 0:
            status_state = "observed"
            raw_status = status_result.stdout
            paths, staged, unstaged, untracked, dirty = foreign_main.parse_status(raw_status)
        else:
            status_state = "unavailable"

    relation = (
        foreign_main.relation(object_repo, local_default, remote_sha)
        if local_state in {"observed", "absent"}
        else "unknown"
    )
    truncated = len(paths) > max_paths
    control_paths = [path for path in paths if is_control_path(path, skill_path)]
    head_matches_ref = (
        checkout_state == "absent"
        or (
            checkout_head_state == "observed"
            and local_state == "observed"
            and checkout_head == local_default
        )
    )
    complete = (
        checkout_state in {"observed", "absent"}
        and local_state in {"observed", "absent"}
        and checkout_head_state in {"observed", "not-applicable"}
        and status_state in {"observed", "absent"}
        and remote_sha is not None
        and relation != "unknown"
        and head_matches_ref
        and not truncated
    )

    if not complete:
        observation, action, block_reason = "unknown", "stop", "primary-default-snapshot-incomplete"
    elif relation == "ahead":
        observation, action, block_reason = "ahead", "stop", "primary-default-ahead"
    elif relation == "diverged":
        observation, action, block_reason = "diverged", "stop", "primary-default-diverged"
    elif control_paths:
        observation, action, block_reason = "overlap", "stop", "primary-control-surface-dirty"
    elif dirty != "clean":
        observation, action, block_reason = "isolated-dirty", "continue", None
    else:
        observation, action, block_reason = "clear", "continue", None

    digest = hashlib.sha256()
    for value in (
        str(checkout) if checkout else "none",
        checkout_state,
        checkout_error or "none",
        str(checkout_count),
        checkout_head or "none",
        checkout_head_state,
        local_default or "none",
        local_state,
        remote_sha or "none",
        relation,
        status_state,
    ):
        digest.update(value.encode("utf-8", "surrogateescape"))
        digest.update(b"\0")
    digest.update(raw_status)
    return {
        "status": "ok" if complete else "partial",
        "observation": observation,
        "action": action,
        "block_reason": block_reason,
        "checkout": str(checkout) if checkout else None,
        "checkout_state": checkout_state,
        "checkout_error": checkout_error,
        "checkout_count": checkout_count,
        "checkout_head": checkout_head,
        "checkout_head_state": checkout_head_state,
        "local_default_ref": local_default,
        "local_default_state": local_state,
        "remote_sha": remote_sha,
        "relation": relation,
        "status_state": status_state,
        "dirty": dirty,
        "staged_count": staged,
        "unstaged_count": unstaged,
        "untracked_count": untracked,
        "path_count": len(paths),
        "paths": paths[:max_paths],
        "paths_truncated": truncated,
        "control_paths": control_paths[:max_paths],
        "fingerprint": digest.hexdigest(),
    }


def command_preflight(args: argparse.Namespace) -> int:
    requested = Path(args.repo).resolve()
    code, top = git(requested, "rev-parse", "--show-toplevel")
    if code != 0:
        emit({"schema": 1, "status": "blocked", "route": "blocked", "reason": "not-a-repository", "mutation_allowed": False})
        return 2
    repo = Path(top)
    remote_sha, remote_state, remote_error = foreign_main.remote_sha(repo, args.remote, args.default)
    advertised_state, advertised_refs = advertised_coordinator_refs(repo, args.remote)
    checkout, checkout_state, checkout_error, checkout_count = foreign_main.discover_default_checkout(repo, args.default)
    skill_state, skill_changes = dirty_path(repo, args.skill_path)
    agents_state, agents_changes = dirty_path(repo, "AGENTS.md")
    head = foreign_main.text(repo, "rev-parse", "HEAD")
    local_contract = tree_oid(repo, head, args.skill_path)
    with tempfile.TemporaryDirectory(prefix="shipctl-observation-") as directory:
        observation_repo = Path(directory)
        if remote_state == "observed" and remote_sha is not None and advertised_state == "observed":
            observation_state, observation_error = create_observation_repo(
                repo,
                observation_repo,
                args.remote,
                [remote_sha, *[sha for sha, _ in advertised_refs]],
            )
        else:
            observation_state, observation_error = "unavailable", "advertisement-unavailable"

        if observation_state == "observed":
            refs_state, refs = coordinator_refs(observation_repo, advertised_refs)
            remote_contract = tree_oid(observation_repo, remote_sha, args.skill_path)
            primary_remote_sha = remote_sha
            if tracked_at(observation_repo, remote_sha, ".openai/hosting.json"):
                profile = "release"
            elif tracked_at(observation_repo, remote_sha, "package.json") or tracked_at(observation_repo, remote_sha, "packages"):
                profile = "build"
            else:
                profile = "design"
        else:
            refs_state, refs = "unavailable", []
            remote_contract = None
            primary_remote_sha = None
            profile = "design"

        contract_matches_head = remote_contract is not None and remote_contract == local_contract
        primary = primary_checkout_snapshot(
            repo,
            observation_repo if observation_state == "observed" else repo,
            checkout,
            checkout_state,
            checkout_error,
            checkout_count,
            args.default,
            primary_remote_sha,
            args.skill_path,
        )

        route = "normal"
        reasons: list[str] = []

        def block(reason: str) -> None:
            nonlocal route
            route = "blocked"
            if reason not in reasons:
                reasons.append(reason)

        if remote_state != "observed":
            block("remote-default-unavailable")
        if advertised_state != "observed":
            block("coordinator-advertisement-unavailable")
        if observation_state != "observed":
            block("remote-observation-materialization-failed")
        if checkout_state not in {"observed", "absent"}:
            block("default-checkout-ambiguous-or-unavailable")
        if primary["block_reason"] is not None:
            block(primary["block_reason"])
        if refs_state != "observed":
            block("coordinator-refs-unavailable")
        if skill_state != "clean":
            block("invoked-contract-dirty")
        if agents_state != "clean":
            block("agents-instructions-dirty")
        if remote_contract is None or local_contract is None:
            block("contract-tree-unavailable")
        elif not contract_matches_head:
            block("invoked-contract-stale-vs-remote-default")

        canonical = [item for item in refs if item["kind"] == "canonical"]
        legacy = [item for item in refs if item["kind"] == "legacy"]
        nonterminal = [
            item for item in refs if item["classification"] not in {"terminal", "migrated"}
        ]
        if len(canonical) > 1:
            block("multiple-canonical-coordinator-refs")
        for item in refs:
            if item["classification"] == "migrated":
                continue
            if item["classification"] == "incoherent-terminal":
                block(f"coordinator-terminal-state-incoherent:{item['ref']}")
            elif item["classification"] == "unknown":
                block(f"coordinator-metadata-unknown:{item['ref']}")
        for item in legacy:
            if item["classification"] not in {"terminal", "migrated"}:
                block(f"legacy-coordinator-not-terminal:{item['ref']}")
        if len(nonterminal) > 1:
            block("multiple-nonterminal-coordinator-refs")

        active_canonical = [item for item in canonical if item["classification"] == "active"]
        if route != "blocked" and active_canonical:
            active = active_canonical[0]
            _, runtime_proof = _runtime_owner_proof()
            proof = args.owner_proof_digest or runtime_proof or ""
            stored_proof = active["owner_proof_digest"]
            valid_proof = bool(LOWER_DIGEST.fullmatch(proof))
            proof_matches = valid_proof and bool(LOWER_DIGEST.fullmatch(stored_proof)) and proof == stored_proof
            active_contract = active["contract_digest"]
            contract_matches = bool(GIT_OID.fullmatch(active_contract)) and active_contract == local_contract
            resumable_state = active["state"] == "running" and active["owner_state"] == "active"
            restrictions = active["active_restrictions"]
            recoverable_owner = (
                proof_matches
                and contract_matches
                and active["state"] == "recovering"
                and active["owner_state"] == "active"
            )
            if active["handoff_takeover_ready"]:
                route = "takeover"
            elif recoverable_owner:
                route = "recover-owner"
            else:
                route = (
                    "resume"
                    if proof_matches and contract_matches and resumable_state and not restrictions
                    else "recovery"
                )
            reasons.append("active-canonical-coordinator")
            if not proof_matches:
                reasons.append("owner-proof-missing-invalid-or-mismatched")
            if not contract_matches:
                reasons.append("active-contract-mismatch-or-unknown")
            if active["state"] == "needs-input":
                reasons.append("canonical-state-needs-input")
            elif active["state"] != "running":
                reasons.append("canonical-state-not-running")
            if active["owner_state"] == "handoff-ready":
                reasons.append("canonical-owner-handoff-ready")
            elif active["owner_state"] != "active":
                reasons.append("canonical-owner-not-active")
            for restriction in restrictions:
                reasons.append(f"active-durable-restriction:{restriction}")
            if active["handoff_takeover_ready"]:
                reasons.append("handoff-ready-takeover-eligible")

        required_refs = {
            "normal": ["references/coordination.md", "references/external-main.md"],
            "resume": [
                "references/coordination.md",
                "references/crash-recovery.md",
                "references/external-main.md",
            ],
            "recovery": [
                "references/coordination.md",
                "references/crash-recovery.md",
                "references/external-main.md",
            ],
            "takeover": [
            ],
            "recover-owner": [
                "references/coordination.md",
                "references/crash-recovery.md",
                "references/external-main.md",
            ],
            "blocked": [],
        }[route]
        mutation_scope = {
            "normal": "run",
            "resume": "run",
            "takeover": "coordinator-claim-cas-only",
            "recover-owner": "recovery-only",
            "recovery": "none",
            "blocked": "none",
        }[route]
        payload = {
            "schema": 1,
            "status": "ok" if route != "blocked" else "blocked",
            "route": route,
            "mutation_allowed": route in {"normal", "resume", "takeover", "recover-owner"},
            "mutation_scope": mutation_scope,
            "reasons": reasons or ["clean-start"],
            "repo": str(repo),
            "default": args.default,
            "remote": args.remote,
            "remote_sha": remote_sha,
            "remote_state": remote_state,
            "remote_error": remote_error,
            "remote_observation_state": observation_state,
            "remote_observation_error": observation_error,
            "default_checkout": str(checkout) if checkout else None,
            "default_checkout_state": checkout_state,
            "default_checkout_error": checkout_error,
            "default_checkout_count": checkout_count,
            "primary_checkout": primary,
            "contract_oid": remote_contract,
            "local_contract_oid": local_contract,
            "contract_matches_head": contract_matches_head,
            "skill_state": skill_state,
            "skill_changes": skill_changes,
            "agents_state": agents_state,
            "agents_changes": agents_changes,
            "delivery_profile": profile,
            "coordinator_refs_state": refs_state,
            "coordinator_refs": refs,
            "required_references": required_refs,
            "startup_budget": {"max_calls_before_worker": 12, "max_milestone_snapshots": 1},
        }
        emit(payload)
        return 0 if route != "blocked" else 3


def normalize_path(path: str) -> str:
    value = path.replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return value


def infer_surface(path: str) -> str:
    surfaces = infer_surfaces(path)
    return surfaces[0] if len(surfaces) == 1 else "unknown"


def infer_surfaces(path: str) -> list[str]:
    value = normalize_path(path)
    if value in {"AGENTS.md", "README.md"}:
        return ["docs"]
    prefix_matches: list[str] = []
    for prefix, surface in PATH_SURFACES:
        if value.startswith(prefix) and surface not in prefix_matches:
            prefix_matches.append(surface)
    if prefix_matches:
        return prefix_matches
    if value.startswith(("tests/unit/", "tests/integration/", "tests/conformance/")):
        tokens = frozenset(
            token for token in re.split(r"[^a-z0-9]+", PurePosixPath(value).name.lower()) if token
        )
        test_surfaces = [
            surface for surface, routed_tokens in TEST_SURFACE_TOKENS if tokens & routed_tokens
        ]
        return test_surfaces or ["unknown"]
    return ["unknown"]


def route_docs(paths: list[str], surface: str | None) -> tuple[list[str], list[str]]:
    raw_surfaces = [surface] if surface else [
        selected for path in paths for selected in infer_surfaces(path)
    ]
    if not raw_surfaces:
        raw_surfaces = ["unknown"]
    surfaces: list[str] = []
    for selected in raw_surfaces:
        if selected not in surfaces:
            surfaces.append(selected)
    if "unknown" in surfaces or any(selected not in SURFACE_DOCS for selected in surfaces):
        return surfaces, list(ALL_DOCS)
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


def _read_json(source: str) -> tuple[Any | None, str | None]:
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        return json.loads(raw), None
    except (OSError, json.JSONDecodeError) as error:
        return None, f"input:{type(error).__name__}"


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0


def _valid_ownership_path(value: Any) -> bool:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 512
        or "\\" in value
        or value.startswith(("/", "-"))
        or any(character in value for character in ("\0", "\n", "\r", "*", "?", "[", "]"))
    ):
        return False
    path = PurePosixPath(value)
    return (
        str(path) == value
        and value not in {".", ".git"}
        and ".." not in path.parts
        and ".git" not in path.parts
    )


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return path != parent
    except ValueError:
        return False


def _common_git_dir(path: Path) -> Path | None:
    code, value = git(path, "rev-parse", "--git-common-dir")
    if code != 0:
        return None
    candidate = Path(value)
    return (candidate if candidate.is_absolute() else path / candidate).resolve()


def _broad_worker_check(command: str) -> bool:
    normalized = " ".join(command.strip().lower().split())
    exact = {
        "npm test",
        "npm run test",
        "npm run test:unit",
        "npm run test:integration",
        "npm run test:conformance",
        "npm run build",
        "pytest",
        "python -m pytest",
        "python3 -m pytest",
        "cargo test",
        "dotnet test",
        "mvn test",
        "mvn verify",
        "gradle test",
        "./gradlew test",
        "make test",
        "make check",
    }
    return (
        normalized in exact
        or re.match(r"^npm run check(?:\s|$)", normalized) is not None
        or normalized in {"node --test", "python -m unittest", "python3 -m unittest"}
        or normalized in {"go test ./...", "go test ./…"}
        or "full gate" in normalized
        or normalized in {"full-gate", "full-suite"}
    )


def validate_manifest(manifest: Any) -> tuple[list[str], list[str], list[str]]:
    if not isinstance(manifest, dict):
        return ["invalid:manifest:not-object"], ["unknown"], list(ALL_DOCS)
    errors: list[str] = []

    def error(value: str) -> None:
        if value not in errors:
            errors.append(value)

    for name in sorted(REQUIRED_MANIFEST_FIELDS - manifest.keys()):
        error(f"missing:{name}")

    for name in ("run_id", "owner_id", "claim_token", "issue_id", "project_id", "milestone_id"):
        value = manifest.get(name)
        if not isinstance(value, str) or UUID_TEXT.fullmatch(value) is None:
            error(f"invalid:{name}")

    run_key = manifest.get("run_key")
    if not isinstance(run_key, str) or re.fullmatch(r"[0-9a-f]{32}", run_key) is None:
        error("invalid:run_key")
    for name in ("owner_epoch", "claim_generation"):
        if not _positive_int(manifest.get(name)):
            error(f"invalid:{name}")
    issue_identifier = manifest.get("issue_identifier")
    if not isinstance(issue_identifier, str) or ISSUE_IDENTIFIER.fullmatch(issue_identifier) is None:
        error("invalid:issue_identifier")
    for name in ("guard_tip", "root_sha", "base_sha"):
        value = manifest.get(name)
        if not isinstance(value, str) or GIT_OID.fullmatch(value) is None:
            error(f"invalid:{name}")
    for name in ("queue_fingerprint", "scope_fingerprint"):
        value = manifest.get(name)
        if not isinstance(value, str) or LOWER_DIGEST.fullmatch(value) is None:
            error(f"invalid:{name}")
    if not _valid_timestamp(manifest.get("issue_updated_at")):
        error("invalid:issue_updated_at")

    dependencies = manifest.get("dependency_shas")
    if not isinstance(dependencies, list) or not all(
        isinstance(value, str) and GIT_OID.fullmatch(value) for value in dependencies
    ) or len(set(dependencies)) != len(dependencies):
        error("invalid:dependency_shas")
        dependencies = []

    ownership = manifest.get("ownership_paths")
    if (
        not isinstance(ownership, list)
        or not ownership
        or not all(_valid_ownership_path(path) for path in ownership)
        or len(set(ownership)) != len(ownership)
    ):
        error("invalid:ownership_paths")
        ownership = []

    if manifest.get("remote_mode") not in {"online", "offline-local-only"}:
        error("invalid:remote_mode")

    inferred_surfaces, inferred_docs = route_docs(ownership, None)
    declared_surface = manifest.get("surface")
    if declared_surface is not None:
        if declared_surface not in SURFACE_DOCS or declared_surface == "unknown":
            error("invalid:surface")
            surfaces, documents = ["unknown"], list(ALL_DOCS)
        elif inferred_surfaces != [declared_surface]:
            error("invalid:surface-does-not-match-ownership")
            surfaces, documents = inferred_surfaces, list(ALL_DOCS)
        else:
            surfaces, documents = [declared_surface], SURFACE_DOCS[declared_surface]
    else:
        surfaces, documents = inferred_surfaces, inferred_docs

    isolation = manifest.get("isolation")
    if not isinstance(isolation, dict):
        error("invalid:isolation:not-object")
        isolation = {}
    required_isolation = {
        "mutable_build_dir",
        "tmp_dir",
        "runtime_dir",
        "cache_mode",
        "cache_dir",
        "ports",
        "env",
    }
    for name in sorted(required_isolation - isolation.keys()):
        error(f"missing:isolation.{name}")

    repo_value = manifest.get("repo")
    worktree_value = manifest.get("worktree")
    repo = Path(repo_value).resolve() if isinstance(repo_value, str) and Path(repo_value).is_absolute() else None
    worktree = Path(worktree_value).resolve() if isinstance(worktree_value, str) and Path(worktree_value).is_absolute() else None
    if repo is None or not repo.is_dir():
        error("invalid:repo")
    if worktree is None or not worktree.is_dir():
        error("invalid:worktree")
    if repo is not None and worktree is not None and repo == worktree:
        error("invalid:worktree-must-differ-from-repo")

    isolated_dirs: list[Path] = []
    for name in ("mutable_build_dir", "tmp_dir", "runtime_dir"):
        value = isolation.get(name)
        if not isinstance(value, str) or not Path(value).is_absolute():
            error(f"invalid:isolation.{name}")
            continue
        resolved = Path(value).resolve()
        isolated_dirs.append(resolved)
        if worktree is None or not _is_within(resolved, worktree):
            error(f"invalid:isolation.{name}:outside-worktree")
    if len(set(isolated_dirs)) != len(isolated_dirs):
        error("invalid:isolation.mutable-dirs-not-distinct")
    cache_mode = isolation.get("cache_mode")
    if cache_mode not in {"content-addressed", "isolated"}:
        error("invalid:isolation.cache_mode")
    cache_value = isolation.get("cache_dir")
    cache_dir = Path(cache_value).resolve() if isinstance(cache_value, str) and Path(cache_value).is_absolute() else None
    if cache_dir is None:
        error("invalid:isolation.cache_dir")
    elif cache_mode == "isolated" and (worktree is None or not _is_within(cache_dir, worktree)):
        error("invalid:isolation.cache_dir:outside-worktree")
    ports = isolation.get("ports")
    if not isinstance(ports, list) or not all(
        isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535 for port in ports
    ) or len(set(ports)) != len(ports):
        error("invalid:isolation.ports")
    env = isolation.get("env")
    if not isinstance(env, dict):
        error("invalid:isolation.env")
    else:
        for name, value in env.items():
            if not isinstance(name, str) or re.fullmatch(r"[A-Z_][A-Z0-9_]*", name) is None:
                error("invalid:isolation.env-name")
            if re.search(r"(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)", str(name), re.IGNORECASE):
                error("invalid:isolation.env-secret-name")
            if not isinstance(value, str) or "\n" in value or "\0" in value:
                error("invalid:isolation.env-value")

    validation = manifest.get("validation")
    if not isinstance(validation, dict):
        error("invalid:validation:not-object")
        validation = {}
    if validation.get("check_class") != "targeted-feature":
        error("invalid:validation.check_class")
    if validation.get("full_gate") != "deferred-to-cutoff":
        error("invalid:validation.full_gate")
    targeted = validation.get("targeted_checks")
    if not isinstance(targeted, list) or not targeted or not all(
        isinstance(check, str) and check.strip() and "\n" not in check and "\0" not in check for check in targeted
    ) or len(set(targeted or [])) != len(targeted or []):
        error("invalid:validation.targeted_checks")
    elif any(_broad_worker_check(check) for check in targeted):
        error("invalid:validation.targeted_checks:full-suite")

    branch = manifest.get("branch")
    feature_ref = manifest.get("feature_ref")
    guard_ref = manifest.get("guard_ref")
    owner_epoch = manifest.get("owner_epoch")
    generation = manifest.get("claim_generation")
    if not isinstance(branch, str) or not branch:
        error("invalid:branch")
    else:
        if issue_identifier and ISSUE_IDENTIFIER.fullmatch(str(issue_identifier)) and isinstance(run_key, str) and _positive_int(owner_epoch) and _positive_int(generation):
            expected_prefix = f"codex/{issue_identifier.lower()}-"
            expected_suffix = f"/r{run_key}-e{owner_epoch}-c{generation}"
            if not branch.startswith(expected_prefix) or not branch.endswith(expected_suffix) or len(branch) <= len(expected_prefix) + len(expected_suffix):
                error("invalid:branch-issue-run-binding")
        if feature_ref != f"refs/heads/{branch}":
            error("invalid:feature_ref")
    if isinstance(run_key, str) and isinstance(issue_identifier, str) and _positive_int(generation):
        expected_guard = f"refs/heads/codex/release/claims/{run_key}/{issue_identifier}/c{generation}"
        if guard_ref != expected_guard:
            error("invalid:guard_ref")
    elif not isinstance(guard_ref, str):
        error("invalid:guard_ref")

    if repo is not None and worktree is not None and repo.is_dir() and worktree.is_dir():
        repo_code, repo_top = git(repo, "rev-parse", "--show-toplevel")
        worktree_code, worktree_top = git(worktree, "rev-parse", "--show-toplevel")
        if repo_code != 0 or Path(repo_top).resolve() != repo:
            error("invalid:repo-not-git-toplevel")
        if worktree_code != 0 or Path(worktree_top).resolve() != worktree:
            error("invalid:worktree-not-git-toplevel")
        repo_common = _common_git_dir(repo)
        worktree_common = _common_git_dir(worktree)
        if repo_common is None or worktree_common is None or repo_common != worktree_common:
            error("invalid:repo-worktree-common-dir")
        code, current_branch = git(worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
        if code != 0 or current_branch != branch:
            error("invalid:worktree-branch")
        code, head = git(worktree, "rev-parse", "--verify", "HEAD")
        if code != 0 or head != manifest.get("base_sha"):
            error("invalid:worktree-head-vs-base")
        if isinstance(branch, str) and git(worktree, "check-ref-format", "--branch", branch)[0] != 0:
            error("invalid:branch-ref-format")
        for name in ("root_sha", "base_sha", "guard_tip"):
            value = manifest.get(name)
            if isinstance(value, str) and GIT_OID.fullmatch(value) and not foreign_main.object_exists(worktree, value):
                error(f"invalid:{name}:object-missing")
        root_sha = manifest.get("root_sha")
        base_sha = manifest.get("base_sha")
        if isinstance(root_sha, str) and isinstance(base_sha, str) and GIT_OID.fullmatch(root_sha) and GIT_OID.fullmatch(base_sha):
            if git(worktree, "merge-base", "--is-ancestor", root_sha, base_sha)[0] != 0:
                error("invalid:root-not-ancestor-of-base")
        for dependency in dependencies:
            if not foreign_main.object_exists(worktree, dependency):
                error("invalid:dependency_shas:object-missing")
            elif isinstance(base_sha, str) and git(worktree, "merge-base", "--is-ancestor", dependency, base_sha)[0] != 0:
                error("invalid:dependency_shas:not-ancestor-of-base")
        if isinstance(feature_ref, str):
            code, feature_tip = git(worktree, "rev-parse", "--verify", feature_ref)
            if code != 0 or feature_tip != manifest.get("base_sha"):
                error("invalid:feature_ref-tip")
        if isinstance(guard_ref, str):
            code, guard_tip = git(worktree, "rev-parse", "--verify", guard_ref)
            if code != 0 or guard_tip != manifest.get("guard_tip"):
                error("invalid:guard_ref-tip")

    return errors, surfaces, list(documents)


def command_manifest(args: argparse.Namespace) -> int:
    manifest, input_error = _read_json(args.input)
    if input_error:
        emit({"schema": 1, "status": "invalid", "errors": [input_error], "surfaces": ["unknown"], "documents": ALL_DOCS})
        return 2
    errors, surfaces, docs = validate_manifest(manifest)
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


def _transition_invalid(errors: list[str]) -> int:
    emit({"schema": 1, "status": "invalid", "errors": errors})
    return 2


def _bounded_text(value: Any, *, allow_none: bool = False) -> bool:
    if allow_none and value == "none":
        return True
    return isinstance(value, str) and 0 < len(value) <= 1000 and "\n" not in value and "\0" not in value


def _validate_transition_parent(parent_fields: dict[str, str]) -> tuple[list[str], int | None, str | None]:
    required = (
        "SCHEMA",
        "KIND",
        "OWNER_ID",
        "OWNER_PROOF_KIND",
        "OWNER_PROOF_DIGEST",
        "RUN_ID",
        "RUN_KEY",
        "PROJECT_ID",
        "MILESTONE_ID",
        "EPOCH",
        "STATE",
        "OWNER_STATE",
        "CONTRACT_SOURCE_SHA",
        "CONTRACT_DIGEST",
        "ACTION_SEQ",
        "ACTION_STATUS",
    )
    missing = [name for name in required if name not in parent_fields]
    if missing:
        return [f"missing:parent-{name.lower().replace('_', '-')}" for name in missing], None, None
    errors: list[str] = []
    if parent_fields["SCHEMA"] != "1":
        errors.append("invalid:parent-schema")
    if parent_fields["KIND"] != "COORDINATOR_CLAIM":
        errors.append("invalid:parent-kind")
    for name in ("OWNER_ID", "RUN_ID", "PROJECT_ID", "MILESTONE_ID"):
        if UUID_TEXT.fullmatch(parent_fields[name]) is None:
            errors.append(f"invalid:parent-{name.lower().replace('_', '-')}")
    if re.fullmatch(r"[a-z][a-z0-9-]{0,63}", parent_fields["OWNER_PROOF_KIND"]) is None:
        errors.append("invalid:parent-owner-proof-kind")
    if LOWER_DIGEST.fullmatch(parent_fields["OWNER_PROOF_DIGEST"]) is None:
        errors.append("invalid:parent-owner-proof-digest")
    if re.fullmatch(r"[0-9a-f]{32}", parent_fields["RUN_KEY"]) is None:
        errors.append("invalid:parent-run-key")
    try:
        epoch = int(parent_fields["EPOCH"])
    except ValueError:
        epoch = 0
    if epoch <= 0:
        errors.append("invalid:parent-epoch")
    if parent_fields["STATE"].lower() not in KNOWN_RUN_STATES:
        errors.append("invalid:parent-state")
    if parent_fields["OWNER_STATE"].lower() not in KNOWN_OWNER_STATES:
        errors.append("invalid:parent-owner-state")
    if GIT_OID.fullmatch(parent_fields["CONTRACT_SOURCE_SHA"]) is None:
        errors.append("invalid:parent-contract-source-sha")
    if GIT_OID.fullmatch(parent_fields["CONTRACT_DIGEST"]) is None:
        errors.append("invalid:parent-contract-digest")
    try:
        parent_seq = int(parent_fields["ACTION_SEQ"])
    except ValueError:
        parent_seq = -1
    if parent_seq < 0:
        errors.append("invalid:parent-action-seq")
    parent_status = parent_fields["ACTION_STATUS"].lower()
    if parent_status not in {"intent", "planned", "reconciled"}:
        errors.append("invalid:parent-action-status")
    return errors, parent_seq if parent_seq >= 0 else None, parent_status


def command_transition(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    parent = args.parent
    if not GIT_OID.fullmatch(parent) or not foreign_main.object_exists(repo, parent):
        return _transition_invalid(["invalid:parent"])
    payload, input_error = _read_json(args.input)
    if input_error:
        return _transition_invalid([input_error])
    if not isinstance(payload, dict):
        return _transition_invalid(["invalid:transition:not-object"])
    phase = payload.get("phase")
    if phase == "intent":
        allowed = {
            "phase",
            "kind",
            "target",
            "expected_before",
            "request_key",
            "selector",
            "payload_digest",
            "effect_identity",
        }
    elif phase == "reconciled":
        allowed = {"phase", "result"}
    else:
        return _transition_invalid(["invalid:phase"])
    unexpected = sorted(set(payload) - allowed)
    if unexpected:
        return _transition_invalid([f"unexpected:{name}" for name in unexpected])
    code, parent_message = git(repo, "show", "-s", "--format=%B", parent)
    tree_code, tree = git(repo, "show", "-s", "--format=%T", parent)
    if code != 0 or tree_code != 0 or not GIT_OID.fullmatch(tree):
        return _transition_invalid(["invalid:parent-metadata"])
    parent_fields = fields(parent_message)
    parent_errors, parent_seq, parent_status = _validate_transition_parent(parent_fields)
    if parent_errors:
        return _transition_invalid(parent_errors)
    assert parent_seq is not None and parent_status is not None
    action: dict[str, str] = {}
    action_result: str | None = None

    if phase == "intent":
        if parent_status != "reconciled":
            return _transition_invalid(["invalid:parent-action-not-reconciled"])
        required = ("kind", "target", "expected_before", "request_key", "selector", "payload_digest", "effect_identity")
        missing = [f"missing:{name}" for name in required if name not in payload]
        if missing:
            return _transition_invalid(missing)
        if not isinstance(payload.get("kind"), str) or re.fullmatch(r"[a-z][a-z0-9-]{0,63}", payload["kind"]) is None:
            return _transition_invalid(["invalid:kind"])
        for name in ("target", "expected_before", "request_key", "selector", "effect_identity"):
            if not _bounded_text(payload.get(name), allow_none=name == "request_key"):
                return _transition_invalid([f"invalid:{name}"])
        if not isinstance(payload.get("payload_digest"), str) or LOWER_DIGEST.fullmatch(payload["payload_digest"]) is None:
            return _transition_invalid(["invalid:payload_digest"])
        seq = parent_seq + 1
        identity_seed = json.dumps(
            {"parent": parent, "seq": seq, **{name: payload[name] for name in required}},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        action = {
            "ACTION_SEQ": str(seq),
            "ACTION_ID": str(uuid.uuid5(TRANSITION_NAMESPACE, identity_seed)),
            "ACTION_KIND": payload["kind"],
            "ACTION_TARGET": payload["target"],
            "EXPECTED_BEFORE": payload["expected_before"],
            "EXTERNAL_REQUEST_KEY": payload["request_key"],
            "PROVIDER_SELECTOR": payload["selector"],
            "PAYLOAD_DIGEST": payload["payload_digest"],
            "EFFECT_IDENTITY": payload["effect_identity"],
        }
        status = "intent"
    elif phase == "reconciled":
        if parent_status not in {"intent", "planned"}:
            return _transition_invalid(["invalid:parent-action-not-pending"])
        if not _bounded_text(payload.get("result")):
            return _transition_invalid(["invalid:result"])
        missing_headers = [name for name in ACTION_HEADERS if name not in parent_fields]
        if missing_headers:
            return _transition_invalid([f"missing:parent-{name.lower()}" for name in missing_headers])
        action = {name: parent_fields[name] for name in ACTION_HEADERS}
        if not UUID_TEXT.fullmatch(action["ACTION_ID"]):
            return _transition_invalid(["invalid:parent-action-id"])
        if action["ACTION_SEQ"] != str(parent_seq):
            return _transition_invalid(["invalid:parent-action-seq"])
        action_result = payload["result"]
        status = "reconciled"
    subject = f"ship-linear-release {status} {action['ACTION_KIND']} {action['ACTION_TARGET']}"
    message_lines = [subject, ""]
    for name in STABLE_TRANSITION_HEADERS:
        if name in parent_fields:
            message_lines.append(f"{name}: {parent_fields[name]}")
    for name in ACTION_HEADERS:
        message_lines.append(f"{name}: {action[name]}")
    message_lines.append(f"ACTION_STATUS: {status}")
    if action_result is not None:
        message_lines.append(f"ACTION_RESULT: {action_result}")
    message = "\n".join(message_lines) + "\n"
    emit(
        {
            "schema": 1,
            "status": "ok",
            "phase": status,
            "parent": parent,
            "tree": tree,
            "message": message,
            "message_digest": hashlib.sha256(message.encode()).hexdigest(),
        }
    )
    return 0


def _capture_preflight(repo: Path, remote: str, default: str) -> tuple[int, dict[str, Any]]:
    args = argparse.Namespace(
        repo=str(repo),
        remote=remote,
        default=default,
        skill_path=SKILL_PATH,
        owner_proof_digest=None,
    )
    with io.StringIO() as output, redirect_stdout(output):
        code = command_preflight(args)
        try:
            payload = json.loads(output.getvalue())
        except json.JSONDecodeError:
            return 3, {"status": "blocked", "reason": "preflight-output-invalid"}
    return code, payload


def _next_recovery_generation(value: str) -> int:
    token = _structured_token(value, "generation")
    return int(token) + 1 if token and token.isdigit() else 1


def _render_takeover_message(
    parent: str,
    parent_message: str,
    remote_main: str,
    contract_digest: str,
    primary: dict[str, Any],
    thread_id: str,
) -> tuple[str | None, dict[str, str] | None, list[str]]:
    parent_fields = fields(parent_message)
    errors, parent_seq, _ = _validate_transition_parent(parent_fields)
    if errors:
        return None, None, errors
    assert parent_seq is not None
    try:
        old_epoch = int(parent_fields["EPOCH"])
    except ValueError:
        return None, None, ["invalid:parent-epoch"]
    new_epoch = old_epoch + 1
    owner_id = str(
        uuid.uuid5(TRANSITION_NAMESPACE, f"takeover:{parent}:{thread_id}:{new_epoch}")
    )
    proof_digest = hashlib.sha256(thread_id.encode()).hexdigest()
    action_payload = {
        "parent": parent,
        "owner_id": owner_id,
        "epoch": new_epoch,
        "thread_id": thread_id,
        "contract_source_sha": remote_main,
        "contract_digest": contract_digest,
    }
    payload_digest = hashlib.sha256(
        json.dumps(action_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    action_id = str(
        uuid.uuid5(TRANSITION_NAMESPACE, f"takeover-action:{payload_digest}")
    )
    primary_fingerprint = primary.get("fingerprint") or "unknown"
    core_values = {
        "SCHEMA": parent_fields["SCHEMA"],
        "KIND": parent_fields["KIND"],
        "OWNER_ID": owner_id,
        "OWNER_PROOF_KIND": "runtime-task-id",
        "OWNER_PROOF_DIGEST": proof_digest,
        "RUN_ID": parent_fields["RUN_ID"],
        "RUN_KEY": parent_fields["RUN_KEY"],
        "PROJECT_ID": parent_fields["PROJECT_ID"],
        "MILESTONE_ID": parent_fields["MILESTONE_ID"],
        "EPOCH": str(new_epoch),
        "STATE": "recovering",
        "OWNER_STATE": "active",
        "GOAL_CURRENT": "none",
        "GOAL_OBJECTIVE_DIGEST": "none",
        "CONTRACT_SOURCE_SHA": remote_main,
        "CONTRACT_DIGEST": contract_digest,
    }
    replaced = set(core_values) | set(ACTION_HEADERS) | {
        "ACTION_STATUS",
        "ACTION_RESULT",
        "CONTRACT_MIGRATED_FROM",
        "RECOVERY",
        "PAUSE",
        "DEFAULT_OBSERVED_SHA",
        "PRIMARY_CHECKOUT",
    }
    ledger_lines: list[str] = []
    for line in parent_message.splitlines():
        key, separator, _ = line.partition(":")
        if separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in replaced:
            ledger_lines.append(line)
    recovery_generation = _next_recovery_generation(parent_fields.get("RECOVERY", ""))
    extras = [
        (
            "CONTRACT_MIGRATED_FROM: "
            f"source={parent_fields['CONTRACT_SOURCE_SHA']};"
            f"digest={parent_fields['CONTRACT_DIGEST']}"
        ),
        (
            "RECOVERY: "
            f"generation={recovery_generation};cause=handoff;phase=fencing;"
            f"previous_owner={parent_fields['OWNER_ID']}/{old_epoch};"
            "inventory=none;reattached=none;adopted=none;requeued=none;"
            "quarantined=none;unresolved=none"
        ),
        (
            "PAUSE: state=lifted;reason=handoff-consumed;"
            "confirmation=explicit-skill-invocation;pending_external_action=none"
        ),
        f"DEFAULT_OBSERVED_SHA: {remote_main}",
        (
            "PRIMARY_CHECKOUT: clean;relation=equal;"
            f"fingerprint={primary_fingerprint}"
        ),
    ]
    action = {
        "ACTION_SEQ": str(parent_seq + 1),
        "ACTION_ID": action_id,
        "ACTION_KIND": "takeover-owner",
        "ACTION_TARGET": f"{CANONICAL_COORDINATOR_REF}@{parent}",
        "EXPECTED_BEFORE": (
            f"owner={parent_fields['OWNER_ID']}/{old_epoch}:handoff-ready;"
            f"coordinator={parent}"
        ),
        "EXTERNAL_REQUEST_KEY": "none",
        "PROVIDER_SELECTOR": f"git:origin:{CANONICAL_COORDINATOR_REF}",
        "PAYLOAD_DIGEST": payload_digest,
        "EFFECT_IDENTITY": f"owner={owner_id};epoch={new_epoch};parent={parent}",
    }
    lines = ["ship-linear-release reconciled takeover owner", ""]
    lines.extend(f"{name}: {value}" for name, value in core_values.items())
    lines.extend(ledger_lines)
    lines.extend(extras)
    lines.extend(f"{name}: {action[name]}" for name in ACTION_HEADERS)
    lines.append("ACTION_STATUS: reconciled")
    return "\n".join(lines) + "\n", {
        "owner_id": owner_id,
        "owner_proof_digest": proof_digest,
        "epoch": str(new_epoch),
        "action_id": action_id,
    }, []


def command_takeover(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    thread_id, runtime_proof = _runtime_owner_proof()
    if thread_id is None or runtime_proof is None:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-thread-id-unavailable"})
        return 3
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    if preflight_code != 0:
        emit({"schema": 1, "status": "blocked", "reason": "preflight-blocked", "preflight": preflight})
        return 3
    active = next(
        (
            item
            for item in preflight.get("coordinator_refs", [])
            if item.get("kind") == "canonical" and item.get("classification") == "active"
        ),
        None,
    )
    if preflight.get("route") in {"resume", "recover-owner"} and active and active.get("owner_proof_digest") == runtime_proof:
        emit(
            {
                "schema": 1,
                "status": "already-owner",
                "route": preflight["route"],
                "coordinator": active["sha"],
                "mutation_scope": preflight["mutation_scope"],
            }
        )
        return 0
    if preflight.get("route") != "takeover" or not active or not active.get("handoff_takeover_ready"):
        emit({"schema": 1, "status": "blocked", "reason": "takeover-not-eligible", "route": preflight.get("route")})
        return 3
    parent = active["sha"]
    fetch = foreign_main.run(
        repo,
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        args.remote,
        parent,
    )
    if fetch.returncode != 0 or not foreign_main.object_exists(repo, parent):
        emit({"schema": 1, "status": "blocked", "reason": "parent-materialization-failed"})
        return 3
    code, parent_message = git(repo, "show", "-s", "--format=%B", parent)
    tree_code, tree = git(repo, "show", "-s", "--format=%T", parent)
    remote_main = preflight.get("remote_sha")
    contract_digest = preflight.get("contract_oid")
    if (
        code != 0
        or tree_code != 0
        or GIT_OID.fullmatch(tree) is None
        or not isinstance(remote_main, str)
        or GIT_OID.fullmatch(remote_main) is None
        or not isinstance(contract_digest, str)
        or GIT_OID.fullmatch(contract_digest) is None
    ):
        emit({"schema": 1, "status": "blocked", "reason": "takeover-input-invalid"})
        return 3
    message, identity, errors = _render_takeover_message(
        parent,
        parent_message,
        remote_main,
        contract_digest,
        preflight.get("primary_checkout", {}),
        thread_id,
    )
    if errors or message is None or identity is None:
        emit({"schema": 1, "status": "blocked", "reason": "takeover-message-invalid", "errors": errors})
        return 3
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="shipctl-takeover-", delete=True) as handle:
        handle.write(message)
        handle.flush()
        commit_result = foreign_main.run(repo, "commit-tree", tree, "-p", parent, "-F", handle.name)
    commit = commit_result.stdout.decode("ascii", "replace").strip()
    if commit_result.returncode != 0 or GIT_OID.fullmatch(commit) is None:
        emit({"schema": 1, "status": "blocked", "reason": "takeover-commit-failed"})
        return 3
    parent_check = foreign_main.text(repo, "rev-parse", f"{commit}^")
    tree_check = foreign_main.text(repo, "show", "-s", "--format=%T", commit)
    if parent_check != parent or tree_check != tree:
        emit({"schema": 1, "status": "blocked", "reason": "takeover-commit-verification-failed"})
        return 3
    push = foreign_main.run(
        repo,
        "push",
        "--porcelain",
        f"--force-with-lease={CANONICAL_COORDINATOR_REF}:{parent}",
        args.remote,
        f"{commit}:{CANONICAL_COORDINATOR_REF}",
    )
    if push.returncode != 0:
        emit({"schema": 1, "status": "cas-lost", "reason": "coordinator-ref-changed", "expected": parent})
        return 4
    advertised_state, advertised = advertised_coordinator_refs(repo, args.remote)
    observed = next((sha for sha, ref in advertised if ref == CANONICAL_COORDINATOR_REF), None)
    if advertised_state != "observed" or observed != commit:
        emit({"schema": 1, "status": "blocked", "reason": "takeover-delivery-unverified", "commit": commit})
        return 3
    emit(
        {
            "schema": 1,
            "status": "taken",
            "coordinator": commit,
            "parent": parent,
            "owner_id": identity["owner_id"],
            "epoch": int(identity["epoch"]),
            "owner_proof_kind": "runtime-task-id",
            "action_id": identity["action_id"],
            "state": "recovering",
            "mutation_scope": "recovery-only",
            "next": "fence-indexed-guards-then-recover",
        }
    )
    return 0


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
    transition = sub.add_parser("transition")
    transition.add_argument("--repo", default=".")
    transition.add_argument("--parent", required=True)
    transition.add_argument("--input", default="-")
    transition.set_defaults(handler=command_transition)
    takeover = sub.add_parser("takeover")
    takeover.add_argument("--repo", default=".")
    takeover.add_argument("--remote", default="origin")
    takeover.add_argument("--default", default="main")
    takeover.set_defaults(handler=command_takeover)
    return root


def main() -> int:
    args = parser().parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
