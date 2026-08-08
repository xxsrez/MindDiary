#!/usr/bin/env python3
"""Deterministic, bounded helpers for ship-linear-release.

Policy remains in SKILL.md and references. Most commands are read-only.
``metadata-commit`` creates only an unreachable local metadata commit object.
The explicit ``soft-pause``, ``takeover``, ``fence-guards``,
``sync-contract``, ``resume-recovery``, and ``projection-batch-cas`` commands perform narrowly
fenced Git CAS transitions. They never mutate Linear, worktrees, feature refs,
default, deployment, or tags; projection provider calls remain external.
"""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
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
    "pausing",
    "checkpoint",
    "needs-input",
    "complete",
    "aborted",
    "retired",
}
KNOWN_OWNER_STATES = {"active", "handoff-ready", "complete", "aborted", "retired"}
TERMINAL_STATES = {"complete", "aborted", "retired"}
TERMINAL_BATCH_STATES = {
    "deployed",
    "failed",
    "integrated",
    "integrated-doc-only",
    "released",
    "rolled-back",
    "terminal",
}
TERMINAL_DEPLOYMENT_STATES = {
    "cancelled",
    "canceled",
    "completed",
    "deployed",
    "failed",
    "rolled-back",
    "succeeded",
    "terminal",
}
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
    "coordinator_sha",
    "repo",
    "worktree",
    "checkout_mode",
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
    "executor",
    "dependencies",
    "isolation",
    "validation",
    "remote_mode",
}

MAX_GOAL_CHARS = 4000
MAX_METADATA_BYTES = 49_152
SAFE_WORKER_EXECUTABLES = {"git", "node", "npm", "python", "python3", "ruby"}
FORBIDDEN_WORKER_WRAPPERS = {"bash", "bunx", "env", "npx", "sh", "zsh"}

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
REBUILDABLE_METADATA_HEADERS = {"COMMENT_MAP"}
REPEATABLE_METADATA_HEADERS = {
    "COMMENT_MAP",
    "CLAIM_MAP",
    "LINEAR_DONE",
    "PROJECTION_ITEM",
    "PROJECTION_RESULT",
}
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


def parse_fields(message: str) -> tuple[dict[str, str], list[str]]:
    parsed: dict[str, str] = {}
    duplicates: list[str] = []
    for line in message.splitlines():
        key, separator, value = line.partition(":")
        if separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            if key in parsed and key not in REPEATABLE_METADATA_HEADERS:
                duplicates.append(key)
            parsed[key] = value.strip()
    return parsed, sorted(set(duplicates))


def fields(message: str) -> dict[str, str]:
    parsed, duplicates = parse_fields(message)
    if duplicates:
        parsed["__DUPLICATE_HEADERS__"] = ",".join(duplicates)
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


def _compact_fields(value: str) -> tuple[dict[str, str], list[str], list[str]]:
    """Parse compact ``key=value;...`` fields and surface ambiguous records."""
    parsed: dict[str, str] = {}
    duplicates: list[str] = []
    malformed: list[str] = []
    for part in value.split(";"):
        key, separator, item = part.partition("=")
        normalized = key.strip().lower()
        if not part.strip():
            continue
        if not separator or not normalized:
            malformed.append(part.strip())
        elif normalized in parsed:
            duplicates.append(normalized)
        else:
            parsed[normalized] = item.strip()
    return parsed, sorted(set(duplicates)), malformed


def _semicolon_fields(value: str) -> dict[str, str]:
    """Parse compact ``key=value;...`` fields without splitting comma values."""
    parsed, _, _ = _compact_fields(value)
    return parsed


def _positive_count(value: str | None) -> int | None:
    if value is None or re.fullmatch(r"0|[1-9][0-9]*", value) is None:
        return None
    return int(value)


def _list_value(value: str | None) -> list[str]:
    if value is None or value.strip().lower() in {"", "none", "0"}:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _pause_index_value(metadata: dict[str, str]) -> str | None:
    return _semicolon_fields(metadata.get("HOLD_PAUSE_INDEX", "")).get("active")


def _hold_pause_entries(value: str | None) -> list[str]:
    if value is None or value.strip().lower() in {"", "none", "0"}:
        return []
    return [item.strip() for item in value.split("|") if item.strip()]


def _render_hold_pause_index(entries: list[str]) -> str:
    unique = sorted(dict.fromkeys(entries), key=str.lower)
    active = "|".join(unique) if unique else "none"
    digest = hashlib.sha256(
        json.dumps(unique, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return f"active={active};entries={len(unique)};digest={digest}"


def _coordinator_lifecycle(metadata: dict[str, str]) -> dict[str, Any]:
    """Decode and validate the coordinator lifecycle as one state vector.

    ``STATE``, ``OWNER_STATE``, worker occupancy, pause/index and action status
    are projections of this lifecycle.  Older ledgers do not have the explicit
    ``LIFECYCLE`` field, so their two known handoff shapes remain readable, but
    every new helper-written transition carries and validates that projection.
    """
    state = metadata.get("STATE", "").strip().lower()
    owner_state = metadata.get("OWNER_STATE", "").strip().lower()
    action_status = metadata.get("ACTION_STATUS", "").strip().lower()
    pause = _semicolon_fields(metadata.get("PAUSE", ""))
    workers = _semicolon_fields(metadata.get("WORKERS", ""))
    execution = _semicolon_fields(metadata.get("EXECUTION_INDEX", ""))
    lifecycle = _semicolon_fields(metadata.get("LIFECYCLE", ""))
    canonical = bool(lifecycle)
    errors: list[str] = []
    phase = "unknown"

    running_count = _positive_count(execution.get("running_count"))
    active_lanes = _list_value(workers.get("active_issue_lanes"))
    pause_id = pause.get("id")
    pause_state = pause.get("state", "").lower()
    pause_scope = pause.get("scope", "").lower()
    pending_actions = metadata.get("PENDING_ACTIONS", "none").strip().lower()
    index_entries = [item.lower() for item in _hold_pause_entries(_pause_index_value(metadata))]

    def validate_pause(*, drained: bool) -> None:
        if not pause_id or not pause_id.startswith("pause-"):
            errors.append("pause-id-invalid")
        if LOWER_DIGEST.fullmatch(pause.get("evidence", "")) is None:
            errors.append("pause-evidence-invalid")
        if UUID_TEXT.fullmatch(pause.get("after", "")) is None:
            errors.append("pause-created-action-invalid")
        if not pause.get("resume_predicate", "").startswith("fresh-explicit-user-launch-after-"):
            errors.append("pause-resume-predicate-invalid")
        if not _valid_timestamp(pause.get("created_at", "")):
            errors.append("pause-created-at-invalid")
        if drained and not _valid_timestamp(pause.get("drained_at", "")):
            errors.append("pause-drained-at-invalid")

    if action_status in {"intent", "planned"}:
        phase = "pending-action"
    elif state in TERMINAL_STATES and owner_state in TERMINAL_STATES:
        phase = "terminal"
    elif state == "running" and owner_state == "active":
        phase = "running"
        if canonical and pause_state not in {"", "lifted", "inactive", "cleared"}:
            errors.append("running-with-active-pause")
    elif state == "recovering" and owner_state == "active":
        phase = "recovering"
        if canonical and running_count not in {None, 0}:
            errors.append("recovering-with-running-executors")
    elif state == "pausing" and owner_state == "active":
        phase = "settling" if running_count == 0 else "draining"
        if pause_state != "active" or not pause_id:
            errors.append("drain-without-active-pause")
        expected_prefix = f"{pause_id}:pause@" if pause_id else ""
        if not expected_prefix or not any(item.startswith(expected_prefix) for item in index_entries):
            errors.append("pause-index-mismatch")
        if running_count is None:
            errors.append("drain-running-count-invalid")
        elif len(active_lanes) != running_count:
            errors.append("drain-worker-index-mismatch")
        if pending_actions != "none":
            errors.append("drain-has-pending-action")
        validate_pause(drained=False)
    elif state == "checkpoint" and owner_state == "handoff-ready":
        phase = "quiescent"
        if pause_state != "active" or not pause_id or pause_scope != "all-shared":
            errors.append("quiescent-pause-invalid")
        expected_index = f"{pause_id}:pause@all-shared" if pause_id else ""
        if expected_index not in index_entries:
            errors.append("quiescent-pause-index-mismatch")
        if running_count != 0:
            errors.append("quiescent-running-count-nonzero")
        if active_lanes:
            errors.append("quiescent-active-lanes-present")
        if pending_actions != "none":
            errors.append("quiescent-pending-actions-present")
        if pause.get("confirmation_required") != "yes":
            errors.append("quiescent-confirmation-not-required")
        if not pause.get("resume_predicate"):
            errors.append("quiescent-resume-predicate-missing")
        validate_pause(drained=True)
    elif state == "needs-input" and owner_state == "handoff-ready":
        # Legacy explicit handoff emitted before the soft-pause state machine.
        phase = "quiescent"
        target = metadata.get("ACTION_TARGET", "").strip().lower()
        if (
            metadata.get("ACTION_KIND", "").strip().lower() != "handoff-owner"
            or target in {"", "none", "unknown"}
            or workers.get("executors") != "terminal"
            or active_lanes
            or pause_state != "handoff-ready"
            or pause.get("pending_external_action") != "none"
        ):
            errors.append("legacy-handoff-incomplete")
    elif owner_state == "active" and state in KNOWN_RUN_STATES - TERMINAL_STATES:
        # Non-pause operating/recovery substates remain valid legacy vectors;
        # their specific mutation scope is still decided by preflight.
        phase = state
    else:
        errors.append("unsupported-state-vector")

    if action_status not in {"intent", "planned", "reconciled"}:
        errors.append("action-status-invalid")
    if canonical:
        if lifecycle.get("schema") != "1":
            errors.append("lifecycle-schema-invalid")
        projected = lifecycle.get("phase")
        if phase != "pending-action" and projected != phase:
            errors.append("lifecycle-phase-mismatch")
        transition = lifecycle.get("transition")
        if transition is None or UUID_TEXT.fullmatch(transition) is None:
            errors.append("lifecycle-transition-invalid")
        projected_pause = lifecycle.get("pause", "none")
        expected_pause = pause_id if pause_state == "active" and pause_id else "none"
        if projected_pause != expected_pause:
            errors.append("lifecycle-pause-mismatch")

    coherent = not errors
    return {
        "schema": 1 if canonical else "legacy",
        "phase": phase,
        "coherent": coherent,
        "errors": errors,
        "running_count": running_count,
        "active_issue_lanes": active_lanes,
        "pause_id": pause_id,
        "pause_scope": pause_scope or None,
        "pending_actions": pending_actions,
        "takeover_ready": coherent and phase == "quiescent" and action_status == "reconciled",
    }


def _handoff_takeover_ready(metadata: dict[str, str]) -> bool:
    """Recognize a fully reconciled, quiescent owner handoff.

    The handoff target is provenance, not an exclusive capability: the next
    explicitly invoked online coordinator still has to win the expected-old
    coordinator-ref CAS. This permits recovery after an external control task
    without asking the user to type a magic takeover phrase. A reconciled
    bookkeeping descendant must not invalidate an already durable handoff, so
    eligibility is derived from the current coherent ledger rather than only
    from the latest ``ACTION_KIND``.
    """
    return bool(_coordinator_lifecycle(metadata)["takeover_ready"])


def _terminal_pipeline(metadata: dict[str, str]) -> tuple[bool, list[str]]:
    """Prove that no nonterminal batch, gate, or deployment still owns a lane.

    Older ledgers sometimes retain ``PIPELINE.active_cutoff`` after the exact
    cutoff has already reached a reconciled terminal result.  That historical
    pointer must not become a permanent ownership lock, but it is safe to
    ignore only when the matching terminal records are complete.
    """
    errors: list[str] = []
    pipeline, pipeline_duplicates, pipeline_malformed = _compact_fields(
        metadata.get("PIPELINE", "")
    )
    gate, gate_duplicates, gate_malformed = _compact_fields(
        metadata.get("GATE_INDEX", "")
    )
    errors.extend(f"duplicate-pipeline-field:{name}" for name in pipeline_duplicates)
    errors.extend(f"malformed-pipeline-field:{name}" for name in pipeline_malformed)
    errors.extend(f"duplicate-gate-field:{name}" for name in gate_duplicates)
    errors.extend(f"malformed-gate-field:{name}" for name in gate_malformed)

    open_cutoff = pipeline.get("open_cutoff", "none").lower()
    active_cutoff = pipeline.get("active_cutoff", "none").lower()
    active_gate = gate.get("active", "none").lower()
    if open_cutoff not in {"", "none"}:
        errors.append("open-cutoff-present")
    if active_gate not in {"", "none"}:
        errors.append("active-gate-present")

    active_record, active_duplicates, active_malformed = _compact_fields(
        metadata.get("ACTIVE_CUTOFF", "")
    )
    result_record, result_duplicates, result_malformed = _compact_fields(
        metadata.get("CUTOFF_RESULT", "")
    )
    if metadata.get("ACTIVE_CUTOFF", "").strip().lower() not in {"", "none"}:
        errors.extend(
            f"duplicate-active-cutoff-field:{name}" for name in active_duplicates
        )
        errors.extend(
            f"malformed-active-cutoff-field:{name}" for name in active_malformed
        )
        active_status = active_record.get("status", "").lower()
        if active_status not in TERMINAL_BATCH_STATES:
            errors.append("active-cutoff-not-terminal")
    if metadata.get("CUTOFF_RESULT", "").strip().lower() not in {"", "none"}:
        errors.extend(
            f"duplicate-cutoff-result-field:{name}" for name in result_duplicates
        )
        errors.extend(
            f"malformed-cutoff-result-field:{name}" for name in result_malformed
        )
        result_status = result_record.get("status", "").lower()
        if result_status not in TERMINAL_BATCH_STATES:
            errors.append("cutoff-result-not-terminal")

    if active_cutoff not in {"", "none"}:
        match = re.fullmatch(r"([^:;,]+):g([1-9][0-9]*)", active_cutoff)
        if match is None:
            errors.append("active-cutoff-identity-invalid")
        else:
            cutoff_id, generation = match.groups()
            if (
                active_record.get("cutoff", "").lower() != cutoff_id
                or active_record.get("generation") != generation
                or active_record.get("status", "").lower()
                not in TERMINAL_BATCH_STATES
            ):
                errors.append("active-cutoff-not-terminal")
            result_identity = result_record.get("cutoff", "").lower()
            if (
                result_identity != active_cutoff
                or result_record.get("status", "").lower()
                not in TERMINAL_BATCH_STATES
            ):
                errors.append("cutoff-result-not-terminal")

    for header in ("DEPLOYMENT", "SITES_DEPLOYMENT"):
        value = metadata.get(header, "").strip()
        normalized = value.lower()
        if normalized in {"", "none"} or normalized.startswith("not-required"):
            continue
        status = _semicolon_fields(value).get("status", "").lower()
        if not status:
            errors.append(f"{header.lower()}-status-missing")
        elif status not in TERMINAL_DEPLOYMENT_STATES:
            errors.append(f"{header.lower()}-not-terminal")

    return not errors, list(dict.fromkeys(errors))


def _durable_quiescent_reclaim(metadata: dict[str, str]) -> tuple[bool, list[str]]:
    """Decide ownership from durable state without runtime liveness proof."""
    lifecycle = _coordinator_lifecycle(metadata)
    errors: list[str] = []
    if not lifecycle.get("coherent"):
        errors.extend(f"lifecycle:{item}" for item in lifecycle.get("errors", []))
    if lifecycle.get("phase") not in {"running", "recovering"}:
        errors.append("lifecycle-not-operating-or-recovering")
    if lifecycle.get("running_count") != 0:
        errors.append("running-executors-present-or-unknown")
    if lifecycle.get("active_issue_lanes"):
        errors.append("active-issue-lanes-present")
    if lifecycle.get("pending_actions") != "none":
        errors.append("pending-actions-present")
    if metadata.get("ACTION_STATUS", "").strip().lower() != "reconciled":
        errors.append("latest-action-not-reconciled")

    claim_index, claim_duplicates, claim_malformed = _compact_fields(
        metadata.get("CLAIM_INDEX", "")
    )
    errors.extend(f"duplicate-claim-index-field:{name}" for name in claim_duplicates)
    errors.extend(f"malformed-claim-index-field:{name}" for name in claim_malformed)
    if not claim_index:
        errors.append("claim-index-missing")
    elif _list_value(claim_index.get("active")):
        errors.append("active-claims-present")

    if _list_value(metadata.get("LIVE_GUARDS")):
        errors.append("live-guards-present")

    recovery = _semicolon_fields(metadata.get("RECOVERY", ""))
    if recovery and recovery.get("unresolved", "none").lower() not in {"", "none"}:
        errors.append("recovery-unresolved")

    terminal_pipeline, pipeline_errors = _terminal_pipeline(metadata)
    if not terminal_pipeline:
        errors.extend(pipeline_errors)
    return not errors, list(dict.fromkeys(errors))


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
                metadata, duplicates = parse_fields(message)
                metadata_state = "duplicate-authoritative-headers" if duplicates else "observed"
            else:
                metadata_state = "message-unavailable"
        state = metadata.get("STATE", "unknown").lower()
        owner_state = metadata.get("OWNER_STATE", "unknown").lower()
        lifecycle = _coordinator_lifecycle(metadata) if metadata_state == "observed" else {
            "schema": "unknown",
            "phase": "unknown",
            "coherent": False,
            "errors": ["metadata-unavailable"],
            "takeover_ready": False,
        }
        quiescent_reclaim_ready, quiescent_reclaim_blockers = (
            _durable_quiescent_reclaim(metadata)
            if metadata_state == "observed"
            else (False, ["metadata-unavailable"])
        )
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
                "contract_source_sha": metadata.get("CONTRACT_SOURCE_SHA", "unknown"),
                "contract_digest": metadata.get("CONTRACT_DIGEST", "unknown"),
                "active_restrictions": _active_restrictions(metadata),
                "lifecycle": lifecycle,
                "handoff_takeover_ready": lifecycle["takeover_ready"],
                "quiescent_reclaim_ready": quiescent_reclaim_ready,
                "quiescent_reclaim_blockers": quiescent_reclaim_blockers,
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

    second_local = foreign_main.run(
        repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{default}"
    )
    second_local_default = (
        second_local.stdout.decode("ascii", "replace").strip()
        if second_local.returncode == 0
        else None
    )
    second_checkout_head = checkout_head
    second_raw_status = raw_status
    if checkout is not None:
        second_head = foreign_main.run(checkout, "rev-parse", "--verify", "HEAD")
        second_checkout_head = (
            second_head.stdout.decode("ascii", "replace").strip()
            if second_head.returncode == 0
            else None
        )
        second_status = foreign_main.run(
            checkout,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignored=no",
        )
        second_raw_status = second_status.stdout if second_status.returncode == 0 else b""
    changed_during_snapshot = (
        second_local.returncode != local_result.returncode
        or second_local_default != local_default
        or second_checkout_head != checkout_head
        or second_raw_status != raw_status
    )

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
        and not changed_during_snapshot
    )

    if not complete:
        observation, action, block_reason = "unknown", "stop", "primary-default-snapshot-incomplete"
    elif relation == "ahead":
        observation, action, block_reason = "ahead", "stop", "primary-default-ahead"
    elif relation == "diverged":
        observation, action, block_reason = "diverged", "stop", "primary-default-diverged"
    elif dirty != "clean":
        observation, action, block_reason = "dirty", "stop", "repository-dirty"
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
        "changed" if changed_during_snapshot else "stable",
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
        "changed_during_snapshot": changed_during_snapshot,
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
    repository_snapshot = repository_worktree_snapshot(repo)
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
        else:
            refs_state, refs = "unavailable", []
            remote_contract = None
            primary_remote_sha = None

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
        if primary["block_reason"] not in {None, "repository-dirty"}:
            block(primary["block_reason"])
        if repository_snapshot["status"] != "ok":
            block("repository-worktree-snapshot-incomplete")
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
        if route != "blocked" and not active_canonical and repository_snapshot["observation"] != "clear":
            block("repository-dirty")
        if route != "blocked" and active_canonical:
            active = active_canonical[0]
            _, runtime_proof = _runtime_owner_proof()
            proof = args.owner_proof_digest or runtime_proof or ""
            stored_proof = active["owner_proof_digest"]
            valid_proof = bool(LOWER_DIGEST.fullmatch(proof))
            proof_matches = valid_proof and bool(LOWER_DIGEST.fullmatch(stored_proof)) and proof == stored_proof
            active_contract = active["contract_digest"]
            contract_matches = bool(GIT_OID.fullmatch(active_contract)) and active_contract == local_contract
            lifecycle_phase = active["lifecycle"]["phase"]
            lifecycle_coherent = bool(active["lifecycle"]["coherent"])
            resumable_state = lifecycle_coherent and lifecycle_phase in {
                "running",
                "validating",
                "offline-queue",
                "publishing",
                "deploying",
                "stabilizing",
            }
            restrictions = active["active_restrictions"]
            recoverable_owner = (
                proof_matches
                and contract_matches
                and active["state"] == "recovering"
                and active["owner_state"] == "active"
                and lifecycle_coherent
            )
            contract_source = active["contract_source_sha"]
            coherent_old_contract = (
                bool(GIT_OID.fullmatch(contract_source))
                and bool(GIT_OID.fullmatch(active_contract))
                and foreign_main.object_exists(observation_repo, contract_source)
                and tree_oid(observation_repo, contract_source, args.skill_path) == active_contract
            )
            safe_contract_upgrade = (
                proof_matches
                and not contract_matches
                and coherent_old_contract
                and remote_sha is not None
                and git(observation_repo, "merge-base", "--is-ancestor", contract_source, remote_sha)[0] == 0
                and active["state"] == "recovering"
                and active["owner_state"] == "active"
                and lifecycle_coherent
            )
            repository_clean = repository_snapshot["observation"] == "clear"
            if active["handoff_takeover_ready"]:
                route = "takeover"
            elif (
                not proof_matches
                and active.get("quiescent_reclaim_ready")
                and repository_clean
            ):
                route = "takeover"
            elif proof_matches and contract_matches and lifecycle_coherent and lifecycle_phase in {"draining", "settling"}:
                route = "drain-owner"
            elif recoverable_owner:
                route = "recover-owner"
            elif safe_contract_upgrade:
                route = "recover-owner-upgrade"
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
            if safe_contract_upgrade:
                reasons.append("active-contract-fast-forward-upgrade-safe")
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
            if active.get("quiescent_reclaim_ready"):
                reasons.append("durable-quiescent-reclaim-eligible")
            else:
                for blocker in active.get("quiescent_reclaim_blockers", []):
                    reasons.append(f"quiescent-reclaim:{blocker}")
            if not repository_clean:
                reasons.append("repository-dirty-requires-authority-check")
            if lifecycle_phase in {"draining", "settling"}:
                reasons.append(f"soft-pause-{lifecycle_phase}")
            for lifecycle_error in active["lifecycle"].get("errors", []):
                reasons.append(f"coordinator-lifecycle:{lifecycle_error}")

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
            "drain-owner": [
                "references/coordination.md",
                "references/soft-pause.md",
                "references/crash-recovery.md",
            ],
            "recover-owner": [
                "references/coordination.md",
                "references/crash-recovery.md",
                "references/external-main.md",
            ],
            "recover-owner-upgrade": [
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
            "drain-owner": "soft-pause-drain-and-settlement-only",
            "recover-owner": "recovery-only",
            "recover-owner-upgrade": "recovery-contract-upgrade-and-fencing-only",
            "recovery": "none",
            "blocked": "none",
        }[route]
        payload = {
            "schema": 1,
            "status": "ok" if route != "blocked" else "blocked",
            "route": route,
            "mutation_allowed": route in {
                "normal",
                "resume",
                "takeover",
                "drain-owner",
                "recover-owner",
                "recover-owner-upgrade",
            },
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
            "repository_snapshot": repository_snapshot,
            "contract_oid": remote_contract,
            "local_contract_oid": local_contract,
            "contract_matches_head": contract_matches_head,
            "skill_state": skill_state,
            "skill_changes": skill_changes,
            "agents_state": agents_state,
            "agents_changes": agents_changes,
            "coordinator_refs_state": refs_state,
            "coordinator_refs": refs,
            "required_references": required_refs,
            "startup_budget": {"max_calls_before_worker": 12, "max_milestone_snapshots": 1},
        }
        emit(payload)
        return 0 if route != "blocked" else 3


def _worktree_records(repo: Path) -> tuple[list[dict[str, str]], str | None]:
    result = foreign_main.run(repo, "worktree", "list", "--porcelain", "-z")
    if result.returncode != 0:
        return [], result.error or "git-error"
    records: list[dict[str, str]] = []
    record: dict[str, str] = {}
    for item in result.stdout.decode("utf-8", "surrogateescape").split("\0"):
        if not item:
            if record:
                records.append(record)
            record = {}
            continue
        key, _, value = item.partition(" ")
        record[key] = value
    if record:
        records.append(record)
    return records, None


def repository_worktree_snapshot(repo: Path, max_paths: int = 80) -> dict[str, Any]:
    """Read one stable, content-free status vector for every linked worktree."""
    records, discovery_error = _worktree_records(repo)
    entries: list[dict[str, Any]] = []
    errors: list[str] = []
    total_paths = 0
    digest = hashlib.sha256()
    if discovery_error is not None:
        errors.append(f"worktree-discovery:{discovery_error}")

    for record in sorted(records, key=lambda item: item.get("worktree", "")):
        raw_path = record.get("worktree", "")
        path = Path(raw_path).resolve() if raw_path else None
        if path is None or not path.is_dir():
            errors.append(f"worktree-unavailable:{raw_path or 'unknown'}")
            continue
        head_first = foreign_main.text(path, "rev-parse", "--verify", "HEAD")
        branch_first = foreign_main.text(
            path, "symbolic-ref", "--quiet", "--short", "HEAD"
        )
        status_first = foreign_main.run(
            path,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=no",
        )
        head_second = foreign_main.text(path, "rev-parse", "--verify", "HEAD")
        branch_second = foreign_main.text(
            path, "symbolic-ref", "--quiet", "--short", "HEAD"
        )
        status_second = foreign_main.run(
            path,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=no",
        )
        if (
            head_first is None
            or status_first.returncode != 0
            or status_second.returncode != 0
        ):
            errors.append(f"worktree-status-unavailable:{path}")
            continue
        stable = (
            head_first == head_second
            and branch_first == branch_second
            and status_first.stdout == status_second.stdout
        )
        if not stable:
            errors.append(f"worktree-changed-during-snapshot:{path}")
        paths, staged, unstaged, untracked, dirty = foreign_main.parse_status(
            status_first.stdout
        )
        total_paths += len(paths)
        entry = {
            "path": str(path),
            "branch": branch_first,
            "head": head_first,
            "dirty": dirty,
            "staged_count": staged,
            "unstaged_count": unstaged,
            "untracked_count": untracked,
            "path_count": len(paths),
            "paths": paths[:max_paths],
            "paths_truncated": len(paths) > max_paths,
            "stable": stable,
        }
        entries.append(entry)
        digest.update(
            json.dumps(entry, sort_keys=True, separators=(",", ":")).encode(
                "utf-8", "surrogateescape"
            )
        )
        digest.update(b"\0")
    if total_paths > max_paths:
        errors.append("repository-status-paths-truncated")
    dirty_entries = [entry for entry in entries if entry["dirty"] != "clean"]
    complete = not errors and len(entries) == len(records)
    return {
        "schema": 1,
        "status": "ok" if complete else "partial",
        "observation": "active-unknown" if not complete else "dirty" if dirty_entries else "clear",
        "worktree_count": len(records),
        "observed_count": len(entries),
        "dirty_worktree_count": len(dirty_entries),
        "dirty_path_count": total_paths,
        "worktrees": entries,
        "dirty_worktrees": dirty_entries,
        "errors": errors,
        "fingerprint": digest.hexdigest(),
    }


def command_status(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    worktrees, worktree_error = _worktree_records(repo)
    canonical = next(
        (
            item
            for item in preflight.get("coordinator_refs", [])
            if item.get("kind") == "canonical"
        ),
        None,
    )
    ledger_bytes = None
    legacy_profile = False
    if canonical and foreign_main.object_exists(repo, canonical["sha"]):
        code, message = git(repo, "show", "-s", "--format=%B", canonical["sha"])
        if code == 0:
            ledger_bytes = len(message.encode("utf-8"))
            legacy_profile = "PROFILE:" in message
    emit(
        {
            "schema": 1,
            "status": "ok" if preflight_code == 0 and worktree_error is None else "attention",
            "route": preflight.get("route"),
            "mutation_allowed": preflight.get("mutation_allowed", False),
            "reasons": preflight.get("reasons", []),
            "remote_sha": preflight.get("remote_sha"),
            "checkout": preflight.get("primary_checkout", {}).get("observation"),
            "repository": preflight.get("repository_snapshot", {}).get("observation"),
            "dirty_worktree_count": preflight.get("repository_snapshot", {}).get("dirty_worktree_count"),
            "coordinator": canonical,
            "ledger_bytes": ledger_bytes,
            "ledger_limit": MAX_METADATA_BYTES,
            "ledger_compaction_recommended": bool(ledger_bytes and ledger_bytes >= 32_768),
            "legacy_profile_detected": legacy_profile,
            "worktree_count": len(worktrees),
            "worktree_error": worktree_error,
        }
    )
    return 0 if preflight_code == 0 and worktree_error is None else 3


def command_repo_guard(args: argparse.Namespace) -> int:
    """Verify that every visible Git delta belongs to an exact registered action."""
    repo = Path(args.repo).resolve()
    payload, input_error = _read_json(args.input)
    if input_error or not isinstance(payload, dict):
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [input_error or "invalid:repo-guard:not-object"],
            }
        )
        return 2
    required_payload = {"authorizations", "expected_worktrees", "refs"}
    if set(payload) != required_payload:
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [
                    *[f"missing:{name}" for name in sorted(required_payload - set(payload))],
                    *[f"unexpected:{name}" for name in sorted(set(payload) - required_payload)],
                ],
            }
        )
        return 2
    authorizations = payload.get("authorizations", [])
    expected_worktrees = payload.get("expected_worktrees", [])
    refs = payload.get("refs", [])
    errors: list[str] = []
    by_worktree: dict[str, dict[str, Any]] = {}
    expected_by_worktree: dict[str, dict[str, Any]] = {}
    if not isinstance(expected_worktrees, list) or not expected_worktrees:
        errors.append("invalid:repo-guard.expected_worktrees")
        expected_worktrees = []
    for index, item in enumerate(expected_worktrees):
        prefix = f"expected_worktrees[{index}]"
        if not isinstance(item, dict) or set(item) != {"worktree", "branch", "head"}:
            errors.append(f"invalid:{prefix}:shape")
            continue
        raw_worktree = item.get("worktree")
        branch = item.get("branch")
        head = item.get("head")
        if not isinstance(raw_worktree, str) or not Path(raw_worktree).is_absolute():
            errors.append(f"invalid:{prefix}.worktree")
            continue
        worktree = str(Path(raw_worktree).resolve())
        if worktree in expected_by_worktree:
            errors.append(f"invalid:{prefix}.duplicate-worktree")
        if branch is not None and (
            not isinstance(branch, str) or not branch or branch.startswith("refs/")
        ):
            errors.append(f"invalid:{prefix}.branch")
        if not isinstance(head, str) or GIT_OID.fullmatch(head) is None:
            errors.append(f"invalid:{prefix}.head")
        expected_by_worktree[worktree] = item
    if not isinstance(authorizations, list):
        errors.append("invalid:repo-guard.authorizations")
        authorizations = []
    for index, item in enumerate(authorizations):
        prefix = f"authorizations[{index}]"
        if not isinstance(item, dict) or set(item) != {
            "worktree",
            "branch",
            "head",
            "ownership_paths",
            "action_id",
        }:
            errors.append(f"invalid:{prefix}:shape")
            continue
        raw_worktree = item.get("worktree")
        branch = item.get("branch")
        head = item.get("head")
        ownership = item.get("ownership_paths")
        action_id = item.get("action_id")
        if not isinstance(raw_worktree, str) or not Path(raw_worktree).is_absolute():
            errors.append(f"invalid:{prefix}.worktree")
            continue
        worktree = str(Path(raw_worktree).resolve())
        if worktree in by_worktree:
            errors.append(f"invalid:{prefix}.duplicate-worktree")
        if not isinstance(branch, str) or not branch or branch.startswith("refs/"):
            errors.append(f"invalid:{prefix}.branch")
        if not isinstance(head, str) or GIT_OID.fullmatch(head) is None:
            errors.append(f"invalid:{prefix}.head")
        if (
            not isinstance(ownership, list)
            or not ownership
            or not all(_valid_ownership_path(path) for path in ownership)
        ):
            errors.append(f"invalid:{prefix}.ownership_paths")
        if not isinstance(action_id, str) or UUID_TEXT.fullmatch(action_id) is None:
            errors.append(f"invalid:{prefix}.action_id")
        by_worktree[worktree] = item

    if not isinstance(refs, list):
        errors.append("invalid:repo-guard.refs")
        refs = []
    expected_refs: list[tuple[str, str]] = []
    for index, item in enumerate(refs):
        prefix = f"refs[{index}]"
        if not isinstance(item, dict) or set(item) != {"ref", "sha"}:
            errors.append(f"invalid:{prefix}:shape")
            continue
        ref = item.get("ref")
        sha = item.get("sha")
        if (
            not isinstance(ref, str)
            or not ref.startswith("refs/")
            or git(repo, "check-ref-format", ref)[0] != 0
        ):
            errors.append(f"invalid:{prefix}.ref")
        if not isinstance(sha, str) or GIT_OID.fullmatch(sha) is None:
            errors.append(f"invalid:{prefix}.sha")
        if isinstance(ref, str) and isinstance(sha, str):
            expected_refs.append((ref, sha))
    if errors:
        emit({"schema": 1, "status": "invalid", "errors": list(dict.fromkeys(errors))})
        return 2

    snapshot = repository_worktree_snapshot(repo)
    violations: list[dict[str, Any]] = []
    if snapshot["status"] != "ok":
        violations.append(
            {"kind": "snapshot-incomplete", "errors": snapshot["errors"]}
        )
    observed_by_worktree = {entry["path"]: entry for entry in snapshot["worktrees"]}
    for worktree in sorted(expected_by_worktree.keys() - observed_by_worktree.keys()):
        violations.append({"kind": "expected-worktree-missing", "worktree": worktree})
    for worktree in sorted(observed_by_worktree.keys() - expected_by_worktree.keys()):
        violations.append({"kind": "unexpected-worktree", "worktree": worktree})
    for worktree in sorted(expected_by_worktree.keys() & observed_by_worktree.keys()):
        expected = expected_by_worktree[worktree]
        observed = observed_by_worktree[worktree]
        if expected["branch"] != observed["branch"]:
            violations.append(
                {
                    "kind": "worktree-branch-mismatch",
                    "worktree": worktree,
                    "expected": expected["branch"],
                    "observed": observed["branch"],
                }
            )
        if expected["head"] != observed["head"]:
            violations.append(
                {
                    "kind": "worktree-head-mismatch",
                    "worktree": worktree,
                    "expected": expected["head"],
                    "observed": observed["head"],
                }
            )
    for worktree, authorization in by_worktree.items():
        entry = observed_by_worktree.get(worktree)
        if entry is None:
            violations.append({"kind": "authorized-worktree-missing", "worktree": worktree})
        elif entry["branch"] != authorization["branch"] or entry["head"] != authorization["head"]:
            violations.append({"kind": "authorization-binding-mismatch", "worktree": worktree})

    for entry in snapshot["dirty_worktrees"]:
        authorization = by_worktree.get(entry["path"])
        if authorization is None:
            violations.append(
                {
                    "kind": "unregistered-dirty-worktree",
                    "worktree": entry["path"],
                    "paths": entry["paths"],
                }
            )
            continue
        ownership = authorization["ownership_paths"]
        outside = [
            path
            for path in entry["paths"]
            if not any(_paths_overlap(path, owned) for owned in ownership)
        ]
        if entry["branch"] != authorization["branch"]:
            violations.append(
                {
                    "kind": "branch-mismatch",
                    "worktree": entry["path"],
                    "expected": authorization["branch"],
                    "observed": entry["branch"],
                }
            )
        if entry["head"] != authorization["head"]:
            violations.append(
                {
                    "kind": "head-mismatch",
                    "worktree": entry["path"],
                    "expected": authorization["head"],
                    "observed": entry["head"],
                }
            )
        if outside:
            violations.append(
                {
                    "kind": "paths-outside-ownership",
                    "worktree": entry["path"],
                    "paths": outside,
                }
            )
    for ref, expected in expected_refs:
        observed = foreign_main.text(repo, "rev-parse", "--verify", ref)
        if observed != expected:
            violations.append(
                {
                    "kind": "ref-mismatch",
                    "ref": ref,
                    "expected": expected,
                    "observed": observed,
                }
            )

    emit(
        {
            "schema": 1,
            "status": "critical-stop" if violations else "clear",
            "mutation_allowed": not violations,
            "snapshot_fingerprint": snapshot["fingerprint"],
            "dirty_worktree_count": snapshot["dirty_worktree_count"],
            "authorization_count": len(by_worktree),
            "expected_worktree_count": len(expected_by_worktree),
            "violations": violations,
        }
    )
    return 3 if violations else 0


def command_pool_status(args: argparse.Namespace) -> int:
    """Report worker occupancy and refill state from the canonical ledger."""
    repo = Path(args.repo).resolve()
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    canonical = next(
        (
            item
            for item in preflight.get("coordinator_refs", [])
            if item.get("kind") == "canonical"
        ),
        None,
    )
    if canonical is None:
        emit(
            {
                "schema": 1,
                "status": "idle" if preflight_code == 0 else "blocked",
                "route": preflight.get("route"),
                "running": 0,
                "feature_ready": 0,
                "summary": "worker pool: no canonical run",
                "reasons": preflight.get("reasons", []),
            }
        )
        return 0 if preflight_code == 0 else 3
    sha = canonical.get("sha")
    if not isinstance(sha, str):
        emit({"schema": 1, "status": "blocked", "reason": "coordinator-sha-invalid"})
        return 3
    message, materialization_error = _materialize_coordinator_parent(repo, args.remote, sha)
    if materialization_error or message is None:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": materialization_error or "coordinator-message-unavailable",
            }
        )
        return 3
    metadata, header_duplicates = parse_fields(message)
    workers, worker_duplicates, worker_malformed = _compact_fields(
        metadata.get("WORKERS", "")
    )
    refill, refill_duplicates, refill_malformed = _compact_fields(
        metadata.get("REFILL", "")
    )
    execution, execution_errors = _execution_vector(metadata.get("EXECUTION_INDEX", ""))
    live_claims, claim_errors = _strict_active_claim_pairs(message)
    errors = [
        *[f"duplicate-header:{name}" for name in header_duplicates],
        *[f"duplicate-workers-field:{name}" for name in worker_duplicates],
        *[f"malformed-workers-field:{name}" for name in worker_malformed],
        *[f"duplicate-refill-field:{name}" for name in refill_duplicates],
        *[f"malformed-refill-field:{name}" for name in refill_malformed],
        *execution_errors,
        *claim_errors,
    ]
    sustained = _positive_count(workers.get("sustained_issue_capacity"))
    active_target = _positive_count(workers.get("active_target"))
    running = sum(state == "running" for state in execution.values())
    feature_ready = sum(state == "feature_ready" for state in execution.values())
    active_lanes = _list_value(workers.get("active_issue_lanes"))
    if sustained is None:
        errors.append("invalid:workers.sustained_issue_capacity")
    if active_target is None:
        errors.append("invalid:workers.active_target")
    running_pairs = {key for key, state in execution.items() if state == "running"}
    occupied_pairs = {
        key
        for key, state in execution.items()
        if state in {"running", "coordinator-paused", "feature_ready"}
    }
    if len(active_lanes) != len(set(active_lanes)) or sorted(active_lanes) != sorted(
        issue for issue, _ in running_pairs
    ):
        errors.append("invalid:workers.active_issue_lanes")
    if not occupied_pairs.issubset(live_claims):
        errors.append("invalid:execution-without-live-claim")
    if not live_claims.issubset(set(execution)):
        errors.append("invalid:live-claim-without-execution-entry")
    if sustained is not None and active_target is not None and active_target > sustained:
        errors.append("invalid:workers.active_target-above-sustained")
    refill_blocker = refill.get("blocker", workers.get("refill_blocker", "unknown"))
    available_slots = max((sustained or 0) - running, 0)
    underfilled = sustained is not None and running < sustained
    target_gap = max((active_target or 0) - running, 0)
    pending_since = refill.get("pending_since", "unknown")
    unexplained_target_gap = (
        target_gap > 0
        and refill_blocker in {"", "none", "unknown"}
        and pending_since in {"", "none", "unknown"}
    )
    if unexplained_target_gap:
        errors.append("active-target-gap-without-refill-state")
    capacity_reason = (
        refill_blocker
        if sustained == 0 and refill_blocker not in {"", "none", "unknown"}
        else "no-sustained-capacity"
        if sustained == 0
        else "capacity-full"
        if not underfilled
        else refill_blocker
        if refill_blocker not in {"", "none", "unknown"}
        else "ready-set-limited"
        if active_target is not None and active_target < (sustained or 0)
        else "refill-pending"
    )
    summary = (
        f"worker pool: running={running}/{sustained if sustained is not None else '?'}; "
        f"target={active_target if active_target is not None else '?'}; "
        f"feature_ready={feature_ready}; refill_blocker={refill_blocker}"
    )
    emit(
        {
            "schema": 1,
            "status": "attention" if errors or preflight_code != 0 else "ok",
            "route": preflight.get("route"),
            "coordinator": sha,
            "run_id": metadata.get("RUN_ID"),
            "requested_workers": workers.get("requested_workers", "unknown"),
            "runtime_slots_total": _positive_count(workers.get("runtime_slots_total")),
            "sustained_issue_capacity": sustained,
            "active_target": active_target,
            "running": running,
            "available_slots": available_slots,
            "feature_ready": feature_ready,
            "active_issue_lanes": active_lanes,
            "underfilled": underfilled,
            "target_gap": target_gap,
            "target_satisfied": target_gap == 0,
            "capacity_reason": capacity_reason,
            "refill": {
                "target_seconds": _positive_count(refill.get("target_seconds")),
                "pending_since": pending_since,
                "blocker": refill_blocker,
                "evidence": refill.get("evidence", "unknown"),
                "resume_predicate": refill.get("resume_predicate", "unknown"),
            },
            "errors": list(dict.fromkeys(errors)),
            "summary": summary,
        }
    )
    return 3 if errors or preflight_code != 0 else 0


def _active_claim_pairs(repo: Path, coordinator: str | None) -> set[tuple[str, int]]:
    if coordinator is None or not foreign_main.object_exists(repo, coordinator):
        return set()
    code, message = git(repo, "show", "-s", "--format=%B", coordinator)
    if code != 0:
        return set()
    index = _semicolon_fields(fields(message).get("CLAIM_INDEX", ""))
    active = index.get("active", "none")
    pairs: set[tuple[str, int]] = set()
    for item in active.split(","):
        match = re.match(r"([A-Z][A-Z0-9]*-[1-9][0-9]*):([1-9][0-9]*)@", item.strip())
        if match:
            pairs.add((match.group(1), int(match.group(2))))
    return pairs


def _strict_active_claim_pairs(
    message: str,
) -> tuple[set[tuple[str, int]], list[str]]:
    metadata, header_duplicates = parse_fields(message)
    index, duplicates, malformed = _compact_fields(metadata.get("CLAIM_INDEX", ""))
    errors = [
        *[f"duplicate-header:{name}" for name in header_duplicates],
        *[f"duplicate-claim-index-field:{name}" for name in duplicates],
        *[f"malformed-claim-index-field:{name}" for name in malformed],
    ]
    pairs: set[tuple[str, int]] = set()
    active_values = _list_value(index.get("active"))
    for value in active_values:
        match = re.fullmatch(
            rf"({ISSUE_IDENTIFIER.pattern}):([1-9][0-9]*)@.+", value
        )
        if match is None:
            errors.append("invalid:claim-index-active-shape")
            continue
        pair = (match.group(1), int(match.group(2)))
        if pair in pairs:
            errors.append(f"invalid:duplicate-active-claim:{pair[0]}:{pair[1]}")
        pairs.add(pair)
    declared = _positive_count(index.get("entries"))
    if declared is None or declared < len(active_values):
        errors.append("invalid:claim-index-entry-count")
    return pairs, list(dict.fromkeys(errors))


def _active_claim_binding(
    message: str, issue: str, generation: int
) -> tuple[dict[str, str] | None, list[str]]:
    metadata, header_duplicates = parse_fields(message)
    index, index_duplicates, index_malformed = _compact_fields(
        metadata.get("CLAIM_INDEX", "")
    )
    errors = [
        *[f"duplicate-header:{name}" for name in header_duplicates],
        *[f"duplicate-claim-index-field:{name}" for name in index_duplicates],
        *[f"malformed-claim-index-field:{name}" for name in index_malformed],
    ]
    key = f"{issue}:{generation}"
    matching = [
        value
        for value in _list_value(index.get("active"))
        if value.split("@", 1)[0] == key
    ]
    if len(matching) != 1:
        errors.append(f"active-claim-binding-count:{key}:{len(matching)}")
        return None, errors
    value = matching[0]
    parts = value.split("@")
    if len(parts) != 4:
        fallbacks = [
            item
            for item in _metadata_values(message, "CLAIM_MAP")
            if item.split("@", 1)[0] == key
        ]
        if len(fallbacks) != 1:
            errors.append(f"active-claim-map-count:{key}:{len(fallbacks)}")
            return None, errors
        parts = fallbacks[0].split("@")
    if len(parts) != 4:
        errors.append(f"active-claim-binding-shape:{key}")
        return None, errors
    declared = _positive_count(index.get("entries"))
    if declared is None or declared < len(_list_value(index.get("active"))):
        errors.append("invalid:claim-index-entry-count")
    return {
        "identity": parts[0],
        "guard": parts[1],
        "feature": parts[2],
        "claim_token": parts[3],
    }, errors


def _branch_claim_pair(branch: str) -> tuple[str, int] | None:
    match = re.match(
        r"codex/([a-z][a-z0-9]*-[1-9][0-9]*)-.+/r[0-9a-f]{32}-e[1-9][0-9]*-c([1-9][0-9]*)$",
        branch,
    )
    if not match:
        return None
    return match.group(1).upper(), int(match.group(2))


def _cleanup_coordinator_authority(
    repo: Path, remote: str, advertised: list[tuple[str, str]]
) -> tuple[str | None, str | None]:
    """Require one coherent terminal ledger and no remaining run occupancy."""
    if not advertised:
        return None, "terminal-coordinator-required"
    if not _materialize_exact(repo, remote, [sha for sha, _ in advertised]):
        return None, "coordinator-object-unavailable"
    refs_state, refs = coordinator_refs(repo, advertised)
    if refs_state != "observed":
        return None, "coordinator-metadata-unavailable"
    canonical = [item for item in refs if item["kind"] == "canonical"]
    if len(canonical) != 1:
        return None, "exactly-one-canonical-coordinator-required"
    if any(item["classification"] not in {"terminal", "migrated"} for item in refs):
        return None, "nonterminal-coordinator-present"
    authority = canonical[0]
    if authority["classification"] != "terminal":
        return None, "canonical-coordinator-not-terminal"
    if authority["metadata_state"] != "observed":
        return None, "canonical-coordinator-metadata-invalid"
    code, message = git(repo, "show", "-s", "--format=%B", authority["sha"])
    if code != 0:
        return None, "canonical-coordinator-message-unavailable"
    metadata, duplicates = parse_fields(message)
    if duplicates:
        return None, "canonical-coordinator-headers-ambiguous"
    lifecycle = _coordinator_lifecycle(metadata)
    claim_index = _semicolon_fields(metadata.get("CLAIM_INDEX", ""))
    execution_index = _semicolon_fields(metadata.get("EXECUTION_INDEX", ""))
    workers = _semicolon_fields(metadata.get("WORKERS", ""))
    if metadata.get("KIND") != "COORDINATOR_CLAIM":
        return None, "canonical-coordinator-kind-invalid"
    if not lifecycle["coherent"] or lifecycle["phase"] != "terminal":
        return None, "canonical-coordinator-lifecycle-invalid"
    if metadata.get("ACTION_STATUS", "").lower() != "reconciled":
        return None, "canonical-coordinator-action-pending"
    if metadata.get("PENDING_ACTIONS", "").lower() != "none":
        return None, "canonical-coordinator-pending-actions"
    if claim_index.get("active") != "none":
        return None, "canonical-coordinator-live-claims"
    if execution_index.get("running_count") != "0":
        return None, "canonical-coordinator-running-executors"
    if _list_value(workers.get("active_issue_lanes")):
        return None, "canonical-coordinator-active-lanes"
    return authority["sha"], None


def _cleanup_plan(repo: Path, remote_sha: str, coordinator: str | None) -> dict[str, Any]:
    records, error = _worktree_records(repo)
    if error:
        raise ValueError(error)
    active_pairs = _active_claim_pairs(repo, coordinator)
    eligible: list[dict[str, str]] = []
    retained: list[dict[str, str]] = []
    for record in records:
        raw_path = record.get("worktree")
        if not raw_path:
            continue
        path = Path(raw_path).resolve()
        if path == repo:
            retained.append({"path": str(path), "reason": "primary"})
            continue
        branch_ref = record.get("branch")
        branch = branch_ref.removeprefix("refs/heads/") if branch_ref else ""
        head = record.get("HEAD", "")
        reason = None
        claim_pair = _branch_claim_pair(branch)
        if not branch.startswith("codex/"):
            reason = "non-codex-branch"
        elif claim_pair is None:
            reason = "unbound-codex-branch"
        elif claim_pair in active_pairs:
            reason = "active-claim"
        elif GIT_OID.fullmatch(head) is None:
            reason = "head-unavailable"
        else:
            status = foreign_main.run(
                path, "status", "--porcelain=v1", "-z", "--untracked-files=all"
            )
            if status.returncode != 0:
                reason = "status-unavailable"
            elif status.stdout:
                reason = "dirty"
        if reason is None and git(repo, "merge-base", "--is-ancestor", head, remote_sha)[0] != 0:
            reason = "not-merged-into-default"
        if reason:
            retained.append({"path": str(path), "branch": branch, "head": head, "reason": reason})
        else:
            eligible.append({"path": str(path), "branch": branch, "head": head})
    core = {
        "schema": 1,
        "repo": str(repo),
        "remote_default_sha": remote_sha,
        "coordinator_sha": coordinator,
        "eligible": eligible,
        "retained": retained,
    }
    core["plan_digest"] = hashlib.sha256(
        json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return core


def command_cleanup_plan(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    remote_sha, state, _ = foreign_main.remote_sha(repo, args.remote, args.default)
    if state != "observed" or remote_sha is None:
        emit({"schema": 1, "status": "blocked", "reason": "remote-default-unavailable"})
        return 3
    advertised_state, advertised = advertised_coordinator_refs(repo, args.remote)
    if advertised_state != "observed":
        emit({"schema": 1, "status": "blocked", "reason": "coordinator-unavailable"})
        return 3
    coordinator, authority_error = _cleanup_coordinator_authority(
        repo, args.remote, advertised
    )
    if authority_error:
        emit({"schema": 1, "status": "blocked", "reason": authority_error})
        return 3
    try:
        plan = _cleanup_plan(repo, remote_sha, coordinator)
    except ValueError as error:
        emit({"schema": 1, "status": "blocked", "reason": str(error)})
        return 3
    emit({"status": "planned", **plan})
    return 0


def command_cleanup_apply(args: argparse.Namespace) -> int:
    payload, input_error = _read_json(args.input)
    if input_error or not isinstance(payload, dict):
        emit({"schema": 1, "status": "invalid", "errors": [input_error or "invalid:plan"]})
        return 2
    repo = Path(args.repo).resolve()
    remote_sha, state, _ = foreign_main.remote_sha(repo, args.remote, args.default)
    advertised_state, advertised = advertised_coordinator_refs(repo, args.remote)
    if state != "observed" or remote_sha is None or advertised_state != "observed":
        emit({"schema": 1, "status": "blocked", "reason": "cleanup-authority-unavailable"})
        return 3
    coordinator, authority_error = _cleanup_coordinator_authority(
        repo, args.remote, advertised
    )
    if authority_error:
        emit({"schema": 1, "status": "blocked", "reason": authority_error})
        return 3
    try:
        fresh = _cleanup_plan(repo, remote_sha, coordinator)
    except ValueError as error:
        emit({"schema": 1, "status": "blocked", "reason": str(error)})
        return 3
    if payload.get("plan_digest") != fresh["plan_digest"] or payload.get("eligible") != fresh["eligible"]:
        emit({"schema": 1, "status": "blocked", "reason": "cleanup-plan-stale"})
        return 3
    removed: list[str] = []
    for entry in fresh["eligible"]:
        path = Path(entry["path"])
        result = foreign_main.run(repo, "worktree", "remove", str(path))
        if result.returncode != 0:
            emit(
                {
                    "schema": 1,
                    "status": "partial",
                    "reason": "worktree-remove-failed",
                    "removed": removed,
                    "failed": str(path),
                }
            )
            return 5
        removed.append(str(path))
    emit({"schema": 1, "status": "cleaned", "removed": removed, "branches_deleted": []})
    return 0


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


def _goal_objective(args: argparse.Namespace) -> str:
    return f"""Objective: Реализовать и доставить все незавершённые Linear issues проекта {args.project_name} ({args.project_id}) из milestone {args.milestone_name} ({args.milestone_id}) в {args.repo}. Следовать tracked contract {args.repo}/.agents/skills/ship-linear-release/SKILL.md и {args.repo}/docs/specs/linear-milestone-delivery.md на SHA {args.contract_sha}. Run: id={args.run_id}; key={args.run_key}; owner={args.owner_id}/{args.epoch}.

Done when: Два согласованных terminal snapshot после завершения projections не содержат unfinished issues кроме Canceled/Duplicate. Все feature, claim, cutoff, CI, deployment и rollback artifacts имеют terminal disposition; default healthy и равен проверенному cutoff. Каждая issue имеет exact feature/default evidence и Done. Production выполнен только когда его требует current acceptance/repository contract; тогда exact Sites deployment прошёл обязательные authenticated web/control, persistence и MCP live flows с rollback proof. Иначе receipt фиксирует not-required-by-current-milestone.

Verify with: Issue-scoped targeted checks; один canonical full gate на каждую immutable batch generation и обязательный финальный main SHA; expected-old default CAS и exact-SHA CI; применимые live/rollback checks. Terminal snapshots содержат scope digest и разделены завершённой external reconciliation boundary.

Constraints: Один repo-global coordinator; CAS loser read-only. Каждая issue и coordinator repair используют отдельные branch, manifest, lease и guard; при workers=1 coordinator-inline работает в primary checkout, при workers>1 delegated issues изолированы по worktrees. Только coordinator merge-ит main. Worker не меняет Linear/default/Sites/tags. Не трогать user changes, не sharing mutable dependencies, не force-push, не ослаблять gates метаданными запуска, не выбирать AWS fallback и не раскрывать secrets. Missing implementation принятого scope является work, а не external blocker.

Blocked when: Один и тот же доказанный внешний blocker, противоречие authoritative требований или необходимое новое product/security decision повторились минимум три последовательных Goal turns и не осталось безопасной независимой работы. Сложность, missing implementation, running worker, pending gate/CI, recoverable CAS, pause или handoff blocker-ом не являются."""


def command_goal_card(args: argparse.Namespace) -> int:
    errors: list[str] = []
    for name in ("project_id", "milestone_id", "run_id", "owner_id"):
        if UUID_TEXT.fullmatch(getattr(args, name)) is None:
            errors.append(f"invalid:{name.replace('_', '-')}")
    if re.fullmatch(r"[0-9a-f]{32}", args.run_key) is None:
        errors.append("invalid:run-key")
    if GIT_OID.fullmatch(args.contract_sha) is None:
        errors.append("invalid:contract-sha")
    if args.epoch <= 0:
        errors.append("invalid:epoch")
    repo = Path(args.repo)
    if not repo.is_absolute():
        errors.append("invalid:repo")
    for name in ("project_name", "milestone_name"):
        value = getattr(args, name)
        if not value.strip() or "\0" in value or "\n" in value:
            errors.append(f"invalid:{name.replace('_', '-')}")
    if errors:
        emit({"schema": 1, "status": "invalid", "goal_allowed": False, "errors": errors})
        return 2
    objective = _goal_objective(args)
    characters = len(objective)
    if characters > MAX_GOAL_CHARS:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "goal_allowed": False,
                "reason": "goal-objective-too-long",
                "characters": characters,
                "limit": MAX_GOAL_CHARS,
            }
        )
        return 3
    emit(
        {
            "schema": 1,
            "status": "valid",
            "goal_allowed": True,
            "characters": characters,
            "limit": MAX_GOAL_CHARS,
            "objective_sha256": hashlib.sha256(objective.encode()).hexdigest(),
            "objective": objective,
        }
    )
    return 0


RUSSIAN_WORKER_COUNTS = {
    "один": 1,
    "одна": 1,
    "два": 2,
    "две": 2,
    "три": 3,
    "четыре": 4,
    "пять": 5,
    "шесть": 6,
    "семь": 7,
    "восемь": 8,
    "девять": 9,
    "десять": 10,
}


def command_invocation(args: argparse.Namespace) -> int:
    """Normalize explicit worker syntax without guessing from issue/version numbers."""
    value = args.text.strip().lower()
    candidates: list[int | str] = []
    assignment_matches = list(
        re.finditer(r"\bworkers\s*=\s*(auto|out|-?[0-9]+)\b", value)
    )
    for match in assignment_matches:
        token = match.group(1)
        candidates.append("auto" if token in {"auto", "out"} else int(token))
    if re.search(r"\bworkers\s*=", value) and not assignment_matches:
        candidates.append("invalid")
    for match in re.finditer(r"\b(-?[0-9]+)\s+(?:issue\s+)?workers?\b", value):
        candidates.append(int(match.group(1)))
    for match in re.finditer(
        r"\b(-?[0-9]+)\s+(?:воркер(?:а|ов)?|поток(?:а|ов)?)\b", value
    ):
        candidates.append(int(match.group(1)))
    words = "|".join(RUSSIAN_WORKER_COUNTS)
    for match in re.finditer(
        rf"\b({words})\s+(?:воркер(?:а|ов)?|поток(?:а|ов)?)\b", value
    ):
        candidates.append(RUSSIAN_WORKER_COUNTS[match.group(1)])
    if re.search(r"\bworkers\s*=\s*auto\b|\bworkers\s*=\s*out\b|всех\s+доступных", value):
        candidates.append("auto")

    normalized = set(candidates)
    errors: list[str] = []
    if len(normalized) > 1:
        errors.append("ambiguous:workers")
    workers: int | str = next(iter(normalized)) if normalized else 1
    if workers == "invalid" or (isinstance(workers, int) and workers <= 0):
        errors.append("invalid:workers")

    maximum_values = {
        int(match.group(1))
        for match in re.finditer(
            r"(?:\bmax(?:-workers)?\s*=\s*|не\s+больше\s+)(-?[0-9]+)\b", value
        )
    }
    if len(maximum_values) > 1:
        errors.append("ambiguous:max-workers")
    max_workers = next(iter(maximum_values)) if len(maximum_values) == 1 else None
    if max_workers is not None and max_workers <= 0:
        errors.append("invalid:max-workers")
    if max_workers is not None and workers != "auto":
        errors.append("invalid:max-workers-with-exact")

    dry_run = bool(re.search(r"\bdry[- ]run\b|только\s+план", value))
    status = "invalid" if errors else "ok"
    emit(
        {
            "schema": 1,
            "status": status,
            "worker_mode": "auto" if workers == "auto" else "exact",
            "workers": workers,
            "max_workers": max_workers,
            "workers_explicit": bool(candidates),
            "dry_run": dry_run,
            "errors": errors,
        }
    )
    return 2 if errors else 0


def command_launch_check(args: argparse.Namespace) -> int:
    """Fail closed before claim when sustainable concurrency is impossible."""
    errors: list[str] = []
    requested: int | None
    if args.workers == "auto":
        requested = None
    else:
        try:
            requested = int(args.workers)
        except ValueError:
            requested = 0
        if requested <= 0:
            errors.append("invalid:workers")
    if args.runtime_slots_total <= 0:
        errors.append("invalid:runtime-slots-total")
    if args.safe_resource_capacity is not None and args.safe_resource_capacity < 0:
        errors.append("invalid:safe-resource-capacity")
    if args.compatible_ready < 0:
        errors.append("invalid:compatible-ready")
    if args.unfinished < 0:
        errors.append("invalid:unfinished")
    if args.running < 0:
        errors.append("invalid:running")
    if args.max_workers is not None and args.max_workers <= 0:
        errors.append("invalid:max-workers")
    runtime_source = getattr(args, "runtime_source", None)
    resource_source = getattr(args, "resource_source", None)
    if runtime_source not in {"system-capacity", "runtime-api"}:
        errors.append("invalid:runtime-source")
    if resource_source not in {"provisioner", "explicit-safe-limit"}:
        errors.append("invalid:resource-source")
    if requested is not None and args.max_workers is not None:
        errors.append("invalid:max-workers-with-exact")

    if errors:
        emit({"schema": 1, "status": "invalid", "claim_allowed": False, "errors": errors})
        return 2

    if args.layout == "auto":
        layout = "fused" if requested == 1 or (requested is None and args.runtime_slots_total == 1) else "dedicated"
    else:
        layout = args.layout
    if layout == "fused" and requested not in {None, 1}:
        errors.append("invalid:fused-layout-requires-one-worker")
    if errors:
        emit({"schema": 1, "status": "invalid", "claim_allowed": False, "errors": errors})
        return 2

    delegated_capacity = max(args.runtime_slots_total - 1, 0) if layout == "dedicated" else 1
    safe_capacity = min(
        delegated_capacity,
        args.safe_resource_capacity if args.safe_resource_capacity is not None else delegated_capacity,
    )
    configured_limit = requested if requested is not None else safe_capacity
    if args.max_workers is not None:
        configured_limit = min(configured_limit, args.max_workers)
    sustained = min(configured_limit, safe_capacity)
    available_slots = max(sustained - args.running, 0)
    refill_count = min(available_slots, args.compatible_ready)
    active_target = min(sustained, args.running + refill_count)

    reasons: list[str] = []
    if requested is not None and requested > safe_capacity:
        reasons.append(
            f"exact-worker-capacity-unavailable:requested={requested};sustained={safe_capacity}"
        )
    if args.running > sustained:
        reasons.append(
            f"running-above-sustained-capacity:running={args.running};sustained={sustained}"
        )
    if args.unfinished > 0 and sustained == 0 and args.running == 0:
        reasons.append("no-sustainable-worker-capacity")
    if args.unfinished > 0 and args.compatible_ready == 0 and args.running == 0:
        reasons.append("no-actionable-frontier")
    if errors:
        reasons.extend(errors)
    status = "blocked" if reasons else "ok"
    emit(
        {
            "schema": 1,
            "status": status,
            "claim_allowed": not reasons,
            "worker_mode": "auto" if requested is None else "exact",
            "requested_workers": "auto" if requested is None else requested,
            "runtime_slots_total": args.runtime_slots_total,
            "runtime_source": runtime_source,
            "layout": layout,
            "delegated_capacity": delegated_capacity,
            "safe_resource_capacity": safe_capacity,
            "resource_source": resource_source,
            "sustained_issue_capacity": sustained,
            "compatible_ready": args.compatible_ready,
            "unfinished": args.unfinished,
            "running": args.running,
            "available_slots": available_slots,
            "refill_count": refill_count,
            "active_target": active_target,
            "reasons": reasons or (["ready-set-limited"] if active_target < sustained else ["capacity-satisfied"]),
        }
    )
    return 3 if reasons else 0


def command_milestone_plan(args: argparse.Namespace) -> int:
    payload, input_error = _read_json(args.input)
    if input_error or not isinstance(payload, dict):
        emit({"schema": 1, "status": "invalid", "errors": [input_error or "invalid:snapshot"]})
        return 2
    errors: list[str] = []
    project = payload.get("project")
    milestones = payload.get("milestones")
    issues = payload.get("issues")
    if not isinstance(project, dict) or UUID_TEXT.fullmatch(str(project.get("id", ""))) is None:
        errors.append("invalid:project")
    if not isinstance(milestones, list) or not all(isinstance(item, dict) for item in milestones):
        errors.append("invalid:milestones")
        milestones = []
    current = [item for item in milestones if item.get("current") is True]
    if len(current) != 1:
        errors.append("invalid:current-milestone-not-unique")
        milestone = None
    else:
        milestone = current[0]
        if UUID_TEXT.fullmatch(str(milestone.get("id", ""))) is None:
            errors.append("invalid:milestone-id")
    if not isinstance(issues, list) or not all(isinstance(item, dict) for item in issues):
        errors.append("invalid:issues")
        issues = []
    by_identifier: dict[str, dict[str, Any]] = {}
    normalized_issues: list[dict[str, Any]] = []
    for issue in issues:
        identifier = issue.get("identifier")
        if not isinstance(identifier, str) or ISSUE_IDENTIFIER.fullmatch(identifier) is None:
            errors.append("invalid:issue-identifier")
            continue
        if identifier in by_identifier:
            errors.append(f"invalid:duplicate-issue:{identifier}")
            continue
        if milestone is not None and issue.get("milestone_id") != milestone.get("id"):
            errors.append(f"invalid:issue-milestone:{identifier}")
        issue_id = issue.get("id")
        if not isinstance(issue_id, str) or not (
            ISSUE_IDENTIFIER.fullmatch(issue_id) or UUID_TEXT.fullmatch(issue_id)
        ):
            errors.append(f"invalid:issue-id:{identifier}")
        elif ISSUE_IDENTIFIER.fullmatch(issue_id) and issue_id != identifier:
            errors.append(f"invalid:issue-id-mismatch:{identifier}")
        title = issue.get("title")
        if (
            not isinstance(title, str)
            or not title.strip()
            or len(title) > 500
            or any(character in title for character in ("\0", "\n", "\r"))
        ):
            errors.append(f"invalid:issue-title:{identifier}")
            title = "Invalid"
        state = issue.get("state")
        if not isinstance(state, str) or state not in {
            "Backlog",
            "Todo",
            "In Progress",
            "In Review",
            "Done",
            "Canceled",
            "Duplicate",
        }:
            errors.append(f"invalid:issue-state:{identifier}")
            state = "Invalid"
        dependencies = issue.get("dependencies")
        if not isinstance(dependencies, list) or not all(isinstance(value, str) for value in dependencies):
            errors.append(f"invalid:issue-dependencies:{identifier}")
            dependencies = []
        elif len(set(dependencies)) != len(dependencies):
            errors.append(f"invalid:duplicate-issue-dependency:{identifier}")
        production_requirement = issue.get("production_requirement")
        if not isinstance(production_requirement, str) or production_requirement not in {
            "required",
            "not-required",
            "unknown",
        }:
            errors.append(f"invalid:production-requirement:{identifier}")
            production_requirement = "unknown"
        priority = issue.get("priority")
        if not isinstance(priority, int) or isinstance(priority, bool) or priority not in range(5):
            errors.append(f"invalid:issue-priority:{identifier}")
            priority = 0
        labels = issue.get("labels")
        if not isinstance(labels, list) or not all(
            isinstance(value, str)
            and value
            and len(value) <= 100
            and not any(character in value for character in ("\0", "\n", "\r"))
            for value in labels
        ):
            errors.append(f"invalid:issue-labels:{identifier}")
            labels = []
        if "createdAt" in issue and "created_at" in issue:
            errors.append(f"invalid:duplicate-issue-created-at:{identifier}")
        created_at = issue.get("createdAt", issue.get("created_at"))
        created_datetime = _utc_datetime(created_at)
        if created_datetime is None:
            errors.append(f"invalid:issue-created-at:{identifier}")
            created_at = ""
        else:
            created_at = _utc_text(created_datetime)
        if "updatedAt" in issue and "updated_at" in issue:
            errors.append(f"invalid:duplicate-issue-updated-at:{identifier}")
        updated_at = issue.get("updatedAt", issue.get("updated_at"))
        updated_datetime = _utc_datetime(updated_at)
        if updated_datetime is None:
            errors.append(f"invalid:issue-updated-at:{identifier}")
            updated_at = ""
        else:
            updated_at = _utc_text(updated_datetime)
        if "boardPosition" in issue and "board_position" in issue:
            errors.append(f"invalid:duplicate-issue-board-position:{identifier}")
        board_position = issue.get("boardPosition", issue.get("board_position"))
        if (
            not isinstance(board_position, (int, float))
            or isinstance(board_position, bool)
            or not math.isfinite(board_position)
        ):
            errors.append(f"invalid:issue-board-position:{identifier}")
            board_position = 0
        normalized_issue = {
            **issue,
            "id": issue_id,
            "identifier": identifier,
            "title": title,
            "state": state,
            "dependencies": sorted(dependencies),
            "production_requirement": production_requirement,
            "priority": priority,
            "labels": sorted(labels, key=str.casefold),
            "created_at": created_at,
            "updated_at": updated_at,
            "board_position": board_position,
        }
        normalized_issue.pop("createdAt", None)
        normalized_issue.pop("updatedAt", None)
        normalized_issue.pop("boardPosition", None)
        by_identifier[identifier] = normalized_issue
        normalized_issues.append(normalized_issue)
    terminal_states = {"Done", "Canceled", "Duplicate"}
    unfinished = {
        identifier: issue
        for identifier, issue in by_identifier.items()
        if issue.get("state") not in terminal_states
    }
    unknown_dependencies: list[str] = []
    graph: dict[str, list[str]] = {}
    for identifier, issue in unfinished.items():
        graph[identifier] = []
        for dependency in issue.get("dependencies", []):
            if dependency not in by_identifier:
                unknown_dependencies.append(f"{identifier}->{dependency}")
            elif dependency in unfinished:
                graph[identifier].append(dependency)
    visit: dict[str, int] = {}
    cycles: list[list[str]] = []

    def walk(identifier: str, stack: list[str]) -> None:
        state = visit.get(identifier, 0)
        if state == 1:
            start = stack.index(identifier) if identifier in stack else 0
            cycles.append(stack[start:] + [identifier])
            return
        if state == 2:
            return
        visit[identifier] = 1
        for dependency in graph.get(identifier, []):
            walk(dependency, [*stack, identifier])
        visit[identifier] = 2

    for identifier in sorted(graph):
        walk(identifier, [])
    running = sorted(
        identifier
        for identifier, issue in unfinished.items()
        if issue.get("state") in {"In Progress", "In Review"}
    )
    dependent_count = {
        identifier: sum(
            identifier in dependent.get("dependencies", [])
            and all(
                dependency == identifier
                or (
                    dependency in by_identifier
                    and by_identifier[dependency].get("state") in terminal_states
                )
                for dependency in dependent.get("dependencies", [])
            )
            for dependent in unfinished.values()
        )
        for identifier in unfinished
    }

    def ready_order(identifier: str) -> tuple[Any, ...]:
        issue = unfinished[identifier]
        priority = issue.get("priority", 0)
        priority_rank = priority if priority in {1, 2, 3, 4} else 5
        labels = {value.casefold() for value in issue.get("labels", [])}
        bug_rank = 0 if labels.intersection({"bug", "regression"}) else 1
        return (
            priority_rank,
            bug_rank,
            -dependent_count[identifier],
            (
                _utc_datetime(issue.get("created_at")).timestamp()
                if _utc_datetime(issue.get("created_at")) is not None
                else math.inf
            ),
            issue.get("board_position", 0),
            identifier,
        )

    ready = sorted(
        (
            identifier
            for identifier, issue in unfinished.items()
            if identifier not in running
            and all(
                by_identifier[dependency].get("state") in terminal_states
                for dependency in issue.get("dependencies", [])
                if dependency in by_identifier
            )
            and all(
                dependency in by_identifier
                for dependency in issue.get("dependencies", [])
            )
        ),
        key=ready_order,
    )
    obligations = {
        issue.get("production_requirement", "unknown") for issue in unfinished.values()
    }
    if not obligations or obligations == {"not-required"}:
        production = "not-required"
    elif "required" in obligations:
        production = "required"
    else:
        production = "unknown"
    structural = []
    if unknown_dependencies:
        structural.append("unknown-dependencies")
    if cycles:
        structural.append("dependency-cycle")
    if unfinished and not ready and not running:
        structural.append("no-actionable-frontier")
    errors.extend(f"invalid:unknown-dependency:{item}" for item in sorted(unknown_dependencies))
    errors.extend(f"invalid:dependency-cycle:{'->'.join(cycle)}" for cycle in cycles)
    normalized_payload = {
        **payload,
        "milestones": sorted(milestones, key=lambda item: (str(item.get("id", "")), str(item.get("name", "")))),
        "issues": sorted(normalized_issues, key=lambda item: item["identifier"]),
    }
    normalized = json.dumps(
        normalized_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    emit(
        {
            "schema": 1,
            "status": "blocked" if errors or structural else "planned",
            "claim_allowed": not errors and not structural,
            "errors": list(dict.fromkeys(errors)),
            "structural_reasons": structural,
            "project": project,
            "milestone": milestone,
            "unfinished": len(unfinished),
            "ready": ready,
            "running": running,
            "production_requirement": production,
            "snapshot_digest": hashlib.sha256(normalized.encode()).hexdigest(),
        }
    )
    return 3 if errors or structural else 0


def _capture_emitted(handler: Any, args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    with io.StringIO() as output, redirect_stdout(output):
        code = handler(args)
        try:
            payload = json.loads(output.getvalue())
        except json.JSONDecodeError:
            return 3, {"schema": 1, "status": "blocked", "reason": "helper-output-invalid"}
    return code, payload


def _capture_json_handler(
    handler: Any, payload: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    descriptor, name = tempfile.mkstemp(prefix="shipctl-input-", suffix=".json")
    path = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = -1
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True)
        return _capture_emitted(handler, argparse.Namespace(input=str(path)))
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def command_startup_plan(args: argparse.Namespace) -> int:
    """Collapse preflight, invocation, milestone and capacity planning."""
    payload, input_error = _read_json(args.input)
    allowed = {"invocation", "snapshot", "capacity"}
    if input_error or not isinstance(payload, dict):
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [input_error or "invalid:startup:not-object"],
            }
        )
        return 2
    errors = [
        *[f"missing:{name}" for name in sorted(allowed - set(payload))],
        *[f"unexpected:{name}" for name in sorted(set(payload) - allowed)],
    ]
    invocation_text = payload.get("invocation")
    snapshot = payload.get("snapshot")
    capacity = payload.get("capacity")
    capacity_fields = {
        "runtime_slots_total",
        "runtime_source",
        "safe_resource_capacity",
        "resource_source",
        "layout",
    }
    if not isinstance(invocation_text, str) or not invocation_text.strip():
        errors.append("invalid:invocation")
    if not isinstance(snapshot, dict):
        errors.append("invalid:snapshot")
    if not isinstance(capacity, dict):
        errors.append("invalid:capacity")
        capacity = {}
    else:
        errors.extend(
            f"missing:capacity.{name}"
            for name in sorted(capacity_fields - set(capacity))
        )
        errors.extend(
            f"unexpected:capacity.{name}"
            for name in sorted(set(capacity) - capacity_fields)
        )
    if errors:
        emit({"schema": 1, "status": "invalid", "errors": errors})
        return 2

    repo = Path(args.repo).resolve()
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    route = preflight.get("route")
    if preflight_code != 0 or route not in {"normal", "resume"}:
        next_steps = {
            "takeover": "run-takeover",
            "drain-owner": "continue-soft-pause",
            "recover-owner": "continue-recovery",
            "recover-owner-upgrade": "run-sync-contract",
            "recovery": "observe-active-run-read-only",
            "blocked": "resolve-preflight-blocker",
        }
        emit(
            {
                "schema": 1,
                "status": "routed" if preflight_code == 0 else "blocked",
                "route": route,
                "mutation_allowed": preflight.get("mutation_allowed", False),
                "reasons": preflight.get("reasons", []),
                "next": next_steps.get(str(route), "follow-preflight-route"),
            }
        )
        return 0 if preflight_code == 0 else 3

    invocation_code, invocation = _capture_emitted(
        command_invocation, argparse.Namespace(text=invocation_text)
    )
    assert isinstance(snapshot, dict)
    milestone_code, milestone = _capture_json_handler(command_milestone_plan, snapshot)
    if invocation_code != 0 or milestone.get("status") == "invalid":
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "route": route,
                "invocation": invocation,
                "milestone": milestone,
            }
        )
        return 2
    unfinished = milestone.get("unfinished")
    ready = milestone.get("ready")
    running = milestone.get("running")
    if not isinstance(unfinished, int) or not isinstance(ready, list) or not isinstance(running, list):
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "route": route,
                "reason": "milestone-plan-incomplete",
                "milestone": milestone,
            }
        )
        return 3
    if milestone_code != 0 or milestone.get("claim_allowed") is not True:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "route": route,
                "reason": "milestone-frontier-blocked",
                "milestone": milestone,
            }
        )
        return 3
    linear_running = list(running)
    authoritative_running: list[str] = []
    occupied_issues: set[str] = set()
    occupancy_sha: str | None = None
    if route == "resume":
        active = _active_canonical(preflight)
        occupancy_sha = active.get("sha") if active else None
        if not isinstance(occupancy_sha, str):
            emit(
                {
                    "schema": 1,
                    "status": "blocked",
                    "route": route,
                    "reason": "coordinator-occupancy-unavailable",
                }
            )
            return 3
        message, materialization_error = _materialize_coordinator_parent(
            repo, args.remote, occupancy_sha
        )
        if materialization_error or message is None:
            emit(
                {
                    "schema": 1,
                    "status": "blocked",
                    "route": route,
                    "reason": materialization_error or "coordinator-message-unavailable",
                }
            )
            return 3
        metadata, header_duplicates = parse_fields(message)
        workers, worker_duplicates, worker_malformed = _compact_fields(
            metadata.get("WORKERS", "")
        )
        execution, execution_errors = _execution_vector(
            metadata.get("EXECUTION_INDEX", "")
        )
        running_entries = {
            key for key, state in execution.items() if state == "running"
        }
        live_claims, claim_errors = _strict_active_claim_pairs(message)
        active_lanes = _list_value(workers.get("active_issue_lanes"))
        occupancy_errors = [
            *[f"duplicate-header:{name}" for name in header_duplicates],
            *[f"duplicate-workers-field:{name}" for name in worker_duplicates],
            *[f"malformed-workers-field:{name}" for name in worker_malformed],
            *execution_errors,
            *claim_errors,
        ]
        if invocation.get("workers_explicit") is not True:
            saved_keys = [
                name for name in ("requested_workers", "requested") if name in workers
            ]
            saved_request = workers.get(saved_keys[0], "") if len(saved_keys) == 1 else ""
            if len(saved_keys) != 1:
                occupancy_errors.append("saved-worker-request-ambiguous")
            saved_match = re.fullmatch(
                r"auto(?:\(max=([1-9][0-9]*)\))?", saved_request
            )
            if saved_request.isdigit() and int(saved_request) > 0:
                invocation["worker_mode"] = "exact"
                invocation["workers"] = int(saved_request)
                invocation["max_workers"] = None
            elif saved_match is not None:
                invocation["worker_mode"] = "auto"
                invocation["workers"] = "auto"
                invocation["max_workers"] = (
                    int(saved_match.group(1)) if saved_match.group(1) else None
                )
            else:
                if len(saved_keys) == 1:
                    occupancy_errors.append("saved-worker-request-unavailable")
        authority_bound_entries = {
            key
            for key, state in execution.items()
            if state in {"running", "coordinator-paused", "feature_ready"}
        }
        if not authority_bound_entries.issubset(live_claims):
            occupancy_errors.append("active-execution-without-live-claim")
        if not live_claims.issubset(set(execution)):
            occupancy_errors.append("live-claim-without-execution-entry")
        if sorted(active_lanes) != sorted(issue for issue, _ in running_entries):
            occupancy_errors.append("active-lanes-do-not-match-execution-index")
        if occupancy_errors:
            emit(
                {
                    "schema": 1,
                    "status": "blocked",
                    "route": route,
                    "reason": "coordinator-occupancy-incoherent",
                    "errors": list(dict.fromkeys(occupancy_errors)),
                }
            )
            return 3
        authoritative_running = [
            f"{issue}:{generation}" for issue, generation in sorted(running_entries)
        ]
        occupied_issues = {
            issue
            for (issue, _), state in execution.items()
            if state in {"running", "coordinator-paused", "feature_ready"}
        }
        occupied_issues.update(issue for issue, _ in live_claims)
    elif linear_running:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "route": route,
                "reason": "linear-running-without-execution-authority",
                "linear_running": linear_running,
                "next": "reconcile-linear-state-before-claim",
            }
        )
        return 3
    compatible_ready = [identifier for identifier in ready if identifier not in occupied_issues]
    launch_args = argparse.Namespace(
        workers=str(invocation["workers"]),
        max_workers=invocation.get("max_workers"),
        runtime_slots_total=capacity.get("runtime_slots_total"),
        runtime_source=capacity.get("runtime_source"),
        safe_resource_capacity=capacity.get("safe_resource_capacity"),
        resource_source=capacity.get("resource_source"),
        compatible_ready=len(compatible_ready),
        unfinished=unfinished,
        running=len(authoritative_running),
        layout=capacity.get("layout"),
    )
    launch_code, launch = _capture_emitted(command_launch_check, launch_args)
    result = {
            "schema": 1,
            "status": "planned" if launch_code == 0 else "blocked",
            "route": route,
            "dry_run": invocation.get("dry_run", False),
            "snapshot_digest": milestone.get("snapshot_digest"),
            "milestone": {
                "id": (
                    milestone.get("milestone", {}).get("id")
                    if isinstance(milestone.get("milestone"), dict)
                    else None
                ),
                "unfinished": unfinished,
                "ready": compatible_ready,
                "linear_running": linear_running,
                "authoritative_running": authoritative_running,
                "production_requirement": milestone.get("production_requirement"),
            },
            "occupancy_coordinator": occupancy_sha,
            "launch": launch,
            "next": (
                "dispatch-refill-count"
                if launch_code == 0 and launch.get("refill_count", 0) > 0
                else "continue-running-work"
                if launch_code == 0 and authoritative_running
                else "terminal-reconciliation"
                if launch_code == 0 and unfinished == 0
                else "resolve-launch-blocker"
            ),
        }
    result["plan_digest"] = hashlib.sha256(
        json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    emit(result)
    return launch_code


def _bounded_projection_text(value: Any, *, maximum: int = 500) -> bool:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or any(character in value for character in ("\0", "\n", "\r"))
    ):
        return False
    return re.search(
        r"(?:authorization\s*[:=]|\bbearer\s+[a-z0-9._-]+|"
        r"(?:password|secret|token|api[_-]?key|access[_-]?key)\s*[:=])",
        value,
        re.IGNORECASE,
    ) is None


PROJECTION_STATUSES: dict[str, set[str]] = {
    "WORK_CLAIM": {"active", "released", "superseded", "retired"},
    "FEATURE_RECEIPT": {
        "ready",
        "failed",
        "needs-coordinator",
        "needs-input",
        "superseded",
        "retired",
    },
    "DEFECT_CANDIDATE": {
        "open",
        "fixing",
        "excluded",
        "reverted",
        "resolved",
        "rolled-back",
    },
}

PROJECTION_HEADLINES = {
    "active": "Работа начата",
    "ready": "Изменения готовы",
    "failed": "Проверка не прошла",
    "needs-coordinator": "Нужна проверка координатора",
    "needs-input": "Работа заблокирована",
    "released": "Работа завершена",
    "superseded": "Запущена новая версия работы",
    "retired": "Работа остановлена",
    "open": "Обнаружена проблема",
    "fixing": "Исправление выполняется",
    "excluded": "Изменение исключено из candidate",
    "reverted": "Изменение отменено",
    "resolved": "Проблема устранена",
    "rolled-back": "Выполнен rollback",
}


def _projection_item_id(seed: dict[str, Any]) -> str:
    canonical = json.dumps(
        seed, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return str(uuid.uuid5(TRANSITION_NAMESPACE, f"projection:{canonical}"))


def command_projection_plan(args: argparse.Namespace) -> int:
    payload, input_error = _read_json(args.input)
    if input_error or not isinstance(payload, dict):
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [input_error or "invalid:projection:not-object"],
            }
        )
        return 2
    if set(payload) != {"run_id", "items"}:
        errors = [
            *[f"missing:{name}" for name in sorted({"run_id", "items"} - set(payload))],
            *[f"unexpected:{name}" for name in sorted(set(payload) - {"run_id", "items"})],
        ]
        emit({"schema": 1, "status": "invalid", "errors": errors})
        return 2
    run_id = payload.get("run_id")
    source_items = payload.get("items")
    errors: list[str] = []
    if not isinstance(run_id, str) or UUID_TEXT.fullmatch(run_id) is None:
        errors.append("invalid:run_id")
    if (
        not isinstance(source_items, list)
        or not source_items
        or len(source_items) > 12
        or not all(isinstance(item, dict) for item in source_items)
    ):
        errors.append("invalid:items")
        source_items = []
    normalized: list[dict[str, Any]] = []
    markers: set[str] = set()
    status_targets: set[str] = set()
    allowed_fields = {
        "issue_identifier",
        "issue_id",
        "receipt_kind",
        "receipt_key",
        "generation",
        "status",
        "summary",
        "changes",
        "evidence",
        "next",
        "updated_at",
        "comment_id",
        "state_update",
    }
    for index, item in enumerate(source_items):
        prefix = f"items[{index}]"
        unexpected = sorted(set(item) - allowed_fields)
        if unexpected:
            errors.extend(f"unexpected:{prefix}.{name}" for name in unexpected)
        required = allowed_fields - {"comment_id", "state_update"}
        errors.extend(
            f"missing:{prefix}.{name}" for name in sorted(required - set(item))
        )
        issue_identifier = item.get("issue_identifier")
        issue_id = item.get("issue_id")
        receipt_kind = item.get("receipt_kind")
        receipt_key = item.get("receipt_key")
        generation = item.get("generation")
        status = item.get("status")
        if not isinstance(issue_identifier, str) or ISSUE_IDENTIFIER.fullmatch(issue_identifier) is None:
            errors.append(f"invalid:{prefix}.issue_identifier")
        if not isinstance(issue_id, str) or not (
            ISSUE_IDENTIFIER.fullmatch(issue_id) or UUID_TEXT.fullmatch(issue_id)
        ):
            errors.append(f"invalid:{prefix}.issue_id")
        elif (
            ISSUE_IDENTIFIER.fullmatch(issue_id) is not None
            and isinstance(issue_identifier, str)
            and issue_id != issue_identifier
        ):
            errors.append(f"invalid:{prefix}.issue_id-mismatch")
        if not isinstance(receipt_kind, str) or receipt_kind not in PROJECTION_STATUSES:
            errors.append(f"invalid:{prefix}.receipt_kind")
        if (
            not isinstance(receipt_key, str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}", receipt_key) is None
        ):
            errors.append(f"invalid:{prefix}.receipt_key")
        if not _positive_int(generation):
            errors.append(f"invalid:{prefix}.generation")
        if not isinstance(status, str) or status not in PROJECTION_STATUSES.get(str(receipt_kind), set()):
            errors.append(f"invalid:{prefix}.status")
        for name in ("summary", "next"):
            if not _bounded_projection_text(item.get(name)):
                errors.append(f"invalid:{prefix}.{name}")
        for name in ("changes", "evidence"):
            values = item.get(name)
            if (
                not isinstance(values, list)
                or len(values) > 8
                or not all(_bounded_projection_text(value) for value in values)
            ):
                errors.append(f"invalid:{prefix}.{name}")
        updated_at = item.get("updated_at")
        if not _valid_timestamp(updated_at):
            errors.append(f"invalid:{prefix}.updated_at")
        comment_id = item.get("comment_id")
        if comment_id is not None and not _bounded_projection_text(comment_id, maximum=256):
            errors.append(f"invalid:{prefix}.comment_id")
        state_update = item.get("state_update")
        if state_update is not None:
            if not isinstance(state_update, dict) or set(state_update) != {"expected", "desired"}:
                errors.append(f"invalid:{prefix}.state_update")
            elif not all(
                _bounded_projection_text(state_update.get(name), maximum=100)
                for name in ("expected", "desired")
            ) or state_update["expected"] == state_update["desired"]:
                errors.append(f"invalid:{prefix}.state_update")
        if errors and any(value.startswith((f"invalid:{prefix}", f"missing:{prefix}", f"unexpected:{prefix}")) for value in errors):
            continue
        if state_update is not None:
            assert isinstance(issue_id, str)
            if issue_id in status_targets:
                errors.append(f"invalid:duplicate-status-target:{issue_id}")
                continue
            status_targets.add(issue_id)
        marker = f"<!-- ship-linear-release:{run_id}:{receipt_kind}:{receipt_key} -->"
        if marker in markers:
            errors.append(f"invalid:duplicate-marker:{receipt_kind}:{receipt_key}")
            continue
        markers.add(marker)
        normalized.append(
            {
                **item,
                "marker": marker,
                "changes": list(item["changes"]),
                "evidence": list(item["evidence"]),
            }
        )
    if errors:
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": list(dict.fromkeys(errors)),
            }
        )
        return 2

    projection_items: list[dict[str, Any]] = []
    for item in sorted(
        normalized,
        key=lambda value: (
            value["issue_identifier"],
            value["receipt_kind"],
            value["receipt_key"],
        ),
    ):
        changes = item["changes"] or ["Содержательных изменений пока нет."]
        evidence = item["evidence"] or ["Проверки ещё не завершены."]
        machine_lines = [
            "<details><summary>Служебные данные</summary>",
            "",
            "```text",
            "SCHEMA: 1",
            f"KIND: {item['receipt_kind']}",
            f"KEY: {item['receipt_key']}",
            f"RUN_ID: {run_id}",
            f"ISSUE: {item['issue_identifier']}",
            f"GENERATION: {item['generation']}",
            f"STATUS: {item['status']}",
            f"UPDATED_AT: {item['updated_at']}",
            "```",
            "</details>",
        ]
        body = "\n".join(
            [
                item["marker"],
                f"### {PROJECTION_HEADLINES[item['status']]}",
                "",
                item["summary"],
                "",
                "Что изменилось:",
                *[f"- {value}" for value in changes],
                "",
                "Проверка:",
                *[f"- {value}" for value in evidence],
                "",
                f"Дальше: {item['next']}",
                "",
                *machine_lines,
            ]
        )
        if len(body.encode("utf-8")) > 8_192:
            emit(
                {
                    "schema": 1,
                    "status": "invalid",
                    "errors": [
                        f"invalid:item[{item['issue_identifier']}].rendered-comment-too-large"
                    ],
                }
            )
            return 2
        body_digest = hashlib.sha256(body.encode()).hexdigest()
        comment_operation = "update-comment" if item.get("comment_id") else "create-comment"
        comment_seed = {
            "run_id": run_id,
            "generation": item["generation"],
            "operation": comment_operation,
            "issue_id": item["issue_id"],
            "marker": item["marker"],
            "comment_id": item.get("comment_id"),
            "payload_digest": body_digest,
        }
        comment_item_id = _projection_item_id(comment_seed)
        projection_items.append(
            {
                "item_id": comment_item_id,
                "operation": comment_operation,
                "target": f"linear:issue:{item['issue_id']}:comment",
                "expected_before": (
                    f"comment_id={item['comment_id']}"
                    if item.get("comment_id")
                    else "marker=absent"
                ),
                "request_key": f"projection:{comment_item_id}",
                "selector": f"issue={item['issue_id']};marker={item['marker']}",
                "payload_digest": body_digest,
                "effect_identity": f"comment:{item['marker']}@{body_digest}",
                "payload": {
                    "comment_id": item.get("comment_id"),
                    "body": body,
                },
            }
        )
        if item.get("state_update") is not None:
            state_update = item["state_update"]
            state_payload = {"state": state_update["desired"]}
            state_digest = hashlib.sha256(
                json.dumps(
                    state_payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
            state_seed = {
                "run_id": run_id,
                "generation": item["generation"],
                "operation": "update-status",
                "issue_id": item["issue_id"],
                "expected": state_update["expected"],
                "payload_digest": state_digest,
            }
            state_item_id = _projection_item_id(state_seed)
            projection_items.append(
                {
                    "item_id": state_item_id,
                    "operation": "update-status",
                    "target": f"linear:issue:{item['issue_id']}:status",
                    "expected_before": f"state={state_update['expected']}",
                    "request_key": f"projection:{state_item_id}",
                    "selector": f"issue={item['issue_id']}",
                    "payload_digest": state_digest,
                    "effect_identity": (
                        f"linear:{item['issue_id']}@{state_update['desired']}"
                        f"/run={run_id}/generation={item['generation']}"
                    ),
                    "payload": state_payload,
                }
            )
    intent_digest = hashlib.sha256(
        json.dumps(
            projection_items,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    emit(
        {
            "schema": 1,
            "status": "planned",
            "kind": "projection-batch",
            "batch_id": str(
                uuid.uuid5(TRANSITION_NAMESPACE, f"projection-batch:{intent_digest}")
            ),
            "intent_digest": intent_digest,
            "item_count": len(projection_items),
            "items": projection_items,
        }
    )
    return 0


def _validate_projection_plan(
    payload: Any,
) -> tuple[list[dict[str, str]], list[str]]:
    required = {
        "schema",
        "status",
        "kind",
        "batch_id",
        "intent_digest",
        "item_count",
        "items",
    }
    if not isinstance(payload, dict) or set(payload) != required:
        return [], ["invalid:projection-plan-shape"]
    errors: list[str] = []
    items = payload.get("items")
    if (
        payload.get("schema") != 1
        or payload.get("status") != "planned"
        or payload.get("kind") != "projection-batch"
        or not isinstance(items, list)
        or not items
        or len(items) > 24
        or payload.get("item_count") != len(items)
    ):
        errors.append("invalid:projection-plan-header")
        items = []
    expected_item_fields = {
        "item_id",
        "operation",
        "target",
        "expected_before",
        "request_key",
        "selector",
        "payload_digest",
        "effect_identity",
        "payload",
    }
    durable: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    seen_requests: set[str] = set()
    for index, item in enumerate(items):
        prefix = f"items[{index}]"
        if not isinstance(item, dict) or set(item) != expected_item_fields:
            errors.append(f"invalid:{prefix}:shape")
            continue
        item_id = item.get("item_id")
        operation = item.get("operation")
        request_key = item.get("request_key")
        if not isinstance(item_id, str) or UUID_TEXT.fullmatch(item_id) is None:
            errors.append(f"invalid:{prefix}.item_id")
        elif item_id in seen_ids:
            errors.append(f"invalid:{prefix}.duplicate-item_id")
        else:
            seen_ids.add(item_id)
        if operation not in {"create-comment", "update-comment", "update-status"}:
            errors.append(f"invalid:{prefix}.operation")
        for name in (
            "target",
            "expected_before",
            "request_key",
            "selector",
            "effect_identity",
        ):
            if not _bounded_text(item.get(name)):
                errors.append(f"invalid:{prefix}.{name}")
        if isinstance(request_key, str):
            if request_key in seen_requests:
                errors.append(f"invalid:{prefix}.duplicate-request_key")
            seen_requests.add(request_key)
        digest = item.get("payload_digest")
        if not isinstance(digest, str) or LOWER_DIGEST.fullmatch(digest) is None:
            errors.append(f"invalid:{prefix}.payload_digest")
        provider_payload = item.get("payload")
        actual_digest: str | None = None
        if operation in {"create-comment", "update-comment"}:
            if (
                not isinstance(provider_payload, dict)
                or set(provider_payload) != {"comment_id", "body"}
                or not isinstance(provider_payload.get("body"), str)
                or len(provider_payload["body"].encode("utf-8")) > 8_192
            ):
                errors.append(f"invalid:{prefix}.payload")
            else:
                comment_id = provider_payload.get("comment_id")
                if (
                    operation == "create-comment" and comment_id is not None
                ) or (
                    operation == "update-comment"
                    and not _bounded_projection_text(comment_id, maximum=256)
                ):
                    errors.append(f"invalid:{prefix}.payload.comment_id")
                actual_digest = hashlib.sha256(
                    provider_payload["body"].encode()
                ).hexdigest()
        elif operation == "update-status":
            if (
                not isinstance(provider_payload, dict)
                or set(provider_payload) != {"state"}
                or not _bounded_projection_text(provider_payload.get("state"), maximum=100)
            ):
                errors.append(f"invalid:{prefix}.payload")
            else:
                actual_digest = hashlib.sha256(
                    json.dumps(
                        provider_payload,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode()
                ).hexdigest()
        if actual_digest is not None and actual_digest != digest:
            errors.append(f"invalid:{prefix}.payload_digest-mismatch")
        if not any(error.startswith(f"invalid:{prefix}") for error in errors):
            durable.append(
                {
                    name: item[name]
                    for name in (
                        "item_id",
                        "operation",
                        "target",
                        "expected_before",
                        "request_key",
                        "selector",
                        "payload_digest",
                        "effect_identity",
                    )
                }
            )
    canonical = json.dumps(
        items, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    intent_digest = hashlib.sha256(canonical.encode()).hexdigest()
    batch_id = payload.get("batch_id")
    if payload.get("intent_digest") != intent_digest:
        errors.append("invalid:projection-plan-intent-digest")
    expected_batch = str(
        uuid.uuid5(TRANSITION_NAMESPACE, f"projection-batch:{intent_digest}")
    )
    if not isinstance(batch_id, str) or batch_id != expected_batch:
        errors.append("invalid:projection-plan-batch-id")
    durable_size = sum(
        len(json.dumps(item, ensure_ascii=False, sort_keys=True).encode())
        for item in durable
    )
    if durable_size > 32_768:
        errors.append("invalid:projection-plan-durable-vector-too-large")
    return durable, list(dict.fromkeys(errors))


def _bounded_refill_value(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value.strip()) <= 300
        and value.strip().lower() not in {"none", "unknown", "n/a", "na"}
        and not any(character in value for character in ("\0", "\n", "\r", ";"))
    )


def _elapsed_seconds(start: datetime, end: datetime) -> int | float:
    value = (end - start).total_seconds()
    return int(value) if value.is_integer() else round(value, 6)


def _utc_text(value: datetime) -> str:
    utc = value.astimezone(timezone.utc)
    if utc.microsecond == 0:
        return utc.isoformat(timespec="seconds").replace("+00:00", "Z")
    rendered = utc.isoformat(timespec="microseconds").replace("+00:00", "Z")
    head, suffix = rendered[:-1], "Z"
    return head.rstrip("0") + suffix


def command_refill_check(args: argparse.Namespace) -> int:
    payload, input_error = _read_json(args.input)
    if input_error or not isinstance(payload, dict):
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [input_error or "invalid:refill:not-object"],
            }
        )
        return 2
    allowed = {
        "ready_observed_at",
        "evaluated_at",
        "spawned_at",
        "target_seconds",
        "sustained_capacity",
        "running_count",
        "compatible_ready",
        "blocker",
        "evidence",
        "resume_predicate",
    }
    required = allowed - {"spawned_at", "blocker", "evidence", "resume_predicate"}
    errors = [
        *[f"missing:{name}" for name in sorted(required - set(payload))],
        *[f"unexpected:{name}" for name in sorted(set(payload) - allowed)],
    ]
    observed = _utc_datetime(payload.get("ready_observed_at"))
    evaluated = _utc_datetime(payload.get("evaluated_at"))
    spawned = (
        _utc_datetime(payload.get("spawned_at"))
        if payload.get("spawned_at") is not None
        else None
    )
    if observed is None:
        errors.append("invalid:ready_observed_at")
    if evaluated is None:
        errors.append("invalid:evaluated_at")
    if payload.get("spawned_at") is not None and spawned is None:
        errors.append("invalid:spawned_at")
    target = payload.get("target_seconds")
    if target != 60:
        errors.append("invalid:target_seconds")
    for name in ("sustained_capacity", "running_count", "compatible_ready"):
        value = payload.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            errors.append(f"invalid:{name}")
    if (
        isinstance(payload.get("sustained_capacity"), int)
        and not isinstance(payload.get("sustained_capacity"), bool)
        and isinstance(payload.get("running_count"), int)
        and not isinstance(payload.get("running_count"), bool)
        and payload["running_count"] > payload["sustained_capacity"]
    ):
        errors.append("invalid:running_count_above_sustained_capacity")
    if observed is not None and evaluated is not None and evaluated < observed:
        errors.append("invalid:evaluated_before_ready")
    if observed is not None and spawned is not None and spawned < observed:
        errors.append("invalid:spawned_before_ready")
    if evaluated is not None and spawned is not None and spawned > evaluated:
        errors.append("invalid:spawned_after_evaluated")
    if errors:
        emit({"schema": 1, "status": "invalid", "errors": list(dict.fromkeys(errors))})
        return 2
    assert observed is not None and evaluated is not None and isinstance(target, int)
    sustained = payload["sustained_capacity"]
    running = payload["running_count"]
    compatible_ready = payload["compatible_ready"]
    deadline = observed.timestamp() + target
    deadline_text = _utc_text(datetime.fromtimestamp(deadline, timezone.utc))
    clear_record = (
        f"target_seconds={target};pending_since=none;blocker=none;"
        "evidence=none;resume_predicate=none"
    )
    if spawned is not None:
        interval = _elapsed_seconds(observed, spawned)
        met = interval <= target
        emit(
            {
                "schema": 1,
                "status": "met" if met else "missed",
                "interval_seconds": interval,
                "deadline": deadline_text,
                "record": (
                    clear_record
                    if met
                    else (
                        f"target_seconds={target};pending_since={payload['ready_observed_at']};"
                        f"blocker=late-spawn;evidence=spawned_after={interval}s;"
                        "resume_predicate=none"
                    )
                ),
                "record_required": not met,
                "blocker_cleared": met,
            }
        )
        return 0
    if sustained == 0 or running >= sustained or compatible_ready == 0:
        emit(
            {
                "schema": 1,
                "status": "not-required",
                "reason": (
                    "no-sustainable-capacity"
                    if sustained == 0
                    else "capacity-full"
                    if running >= sustained
                    else "no-compatible-ready"
                ),
                "deadline": deadline_text,
                "record": clear_record,
            }
        )
        return 0
    interval = _elapsed_seconds(observed, evaluated)
    if interval <= target:
        emit(
            {
                "schema": 1,
                "status": "pending",
                "interval_seconds": interval,
                "remaining_seconds": target - interval,
                "deadline": deadline_text,
                "record": (
                    f"target_seconds={target};pending_since={payload['ready_observed_at']};"
                    "blocker=none;evidence=none;resume_predicate=spawn-compatible-ready"
                ),
            }
        )
        return 0
    evidence_fields = ("blocker", "evidence", "resume_predicate")
    missing_evidence = [
        name for name in evidence_fields if not _bounded_refill_value(payload.get(name))
    ]
    if missing_evidence:
        emit(
            {
                "schema": 1,
                "status": "needs-evidence",
                "interval_seconds": interval,
                "deadline": deadline_text,
                "errors": [f"missing-or-invalid:{name}" for name in missing_evidence],
                "record_required": True,
            }
        )
        return 3
    record = (
        f"target_seconds={target};pending_since={payload['ready_observed_at']};"
        f"blocker={payload['blocker']};evidence=interval={interval}s,{payload['evidence']};"
        f"resume_predicate={payload['resume_predicate']}"
    )
    emit(
        {
            "schema": 1,
            "status": "missed",
            "interval_seconds": interval,
            "deadline": deadline_text,
            "record_required": True,
            "record": record,
        }
    )
    return 0


CONVEYOR_TRANSITIONS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "claimed": (
        "dispatch",
        "running",
        ("manifest_digest", "guard_tip", "executor_lease"),
    ),
    "running": (
        "receipt-verified",
        "feature_ready",
        ("receipt_digest", "head_sha", "checks_digest"),
    ),
    "feature_ready": (
        "ingest-accepted",
        "accepted",
        ("cutoff_id", "train_sha", "membership_digest"),
    ),
    "accepted": (
        "cutoff-sealed",
        "sealed",
        ("cutoff_ref", "candidate_sha", "validation_key"),
    ),
    "sealed": (
        "gate-passed",
        "gated",
        ("result_sha256", "candidate_sha"),
    ),
    "gated": (
        "default-promoted",
        "promoted",
        ("previous_sha", "default_sha", "remote_observation"),
    ),
    "promoted": (
        "linear-projected",
        "projected",
        ("issue_updated_at", "default_sha"),
    ),
    "projected": (
        "artifact-terminalized",
        "terminal",
        ("guard_tip", "feature_ref", "disposition"),
    ),
}


def command_conveyor_next(args: argparse.Namespace) -> int:
    """Validate one deterministic lifecycle transition without mutating state."""

    payload, input_error = _read_json(args.input)
    if input_error or not isinstance(payload, dict):
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [input_error or "invalid:conveyor:not-object"],
            }
        )
        return 2
    required = {
        "schema",
        "run_id",
        "issue_identifier",
        "generation",
        "state",
        "event",
        "event_id",
        "evidence",
    }
    errors = [f"missing:{name}" for name in sorted(required - payload.keys())]
    errors.extend(f"unexpected:{name}" for name in sorted(payload.keys() - required))
    if payload.get("schema") != 1:
        errors.append("invalid:schema")
    if UUID_TEXT.fullmatch(str(payload.get("run_id", ""))) is None:
        errors.append("invalid:run_id")
    if ISSUE_IDENTIFIER.fullmatch(str(payload.get("issue_identifier", ""))) is None:
        errors.append("invalid:issue_identifier")
    if not _positive_int(payload.get("generation")):
        errors.append("invalid:generation")
    if UUID_TEXT.fullmatch(str(payload.get("event_id", ""))) is None:
        errors.append("invalid:event_id")
    state = payload.get("state")
    transition = CONVEYOR_TRANSITIONS.get(state) if isinstance(state, str) else None
    if transition is None:
        errors.append("invalid:state")
        expected_event = None
        next_state = None
        evidence_fields: tuple[str, ...] = ()
    else:
        expected_event, next_state, evidence_fields = transition
        if payload.get("event") != expected_event:
            errors.append("invalid:event-for-state")
    evidence = payload.get("evidence")
    if not isinstance(evidence, dict):
        errors.append("invalid:evidence:not-object")
        evidence = {}
    else:
        errors.extend(
            f"missing:evidence.{name}" for name in evidence_fields if name not in evidence
        )
        errors.extend(
            f"unexpected:evidence.{name}"
            for name in sorted(evidence.keys() - set(evidence_fields))
        )
        for name in evidence_fields:
            value = evidence.get(name)
            if (
                not isinstance(value, str)
                or not value
                or len(value.encode("utf-8")) > 1024
                or "\n" in value
                or "\0" in value
            ):
                errors.append(f"invalid:evidence.{name}")
    errors = list(dict.fromkeys(errors))
    if errors:
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "state": state,
                "expected_event": expected_event,
                "errors": errors,
            }
        )
        return 2
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    transition_digest = hashlib.sha256(canonical.encode()).hexdigest()
    emit(
        {
            "schema": 1,
            "status": "advanced",
            "run_id": payload["run_id"],
            "issue_identifier": payload["issue_identifier"],
            "generation": payload["generation"],
            "event_id": payload["event_id"],
            "state_before": state,
            "state_after": next_state,
            "transition_digest": transition_digest,
        }
    )
    return 0


def _paths_overlap(left: str, right: str) -> bool:
    left_path = PurePosixPath(left.rstrip("/"))
    right_path = PurePosixPath(right.rstrip("/"))
    return left_path == right_path or left_path in right_path.parents or right_path in left_path.parents


def _dispatch_isolation(entry: dict[str, Any]) -> tuple[list[str], list[int], str | None, str | None]:
    isolation = entry.get("isolation")
    if not isinstance(isolation, dict):
        return [], [], None, None
    paths = [
        value
        for name in ("mutable_build_dir", "tmp_dir", "runtime_dir", "cache_dir")
        if isinstance((value := isolation.get(name)), str) and value
    ]
    ports = isolation.get("ports")
    return (
        paths,
        ports if isinstance(ports, list) and all(isinstance(port, int) for port in ports) else [],
        isolation.get("cache_mode") if isinstance(isolation.get("cache_mode"), str) else None,
        isolation.get("cache_key") if isinstance(isolation.get("cache_key"), str) else None,
    )


def command_dispatch_check(args: argparse.Namespace) -> int:
    payload, input_error = _read_json(args.input)
    if input_error:
        emit({"schema": 1, "status": "invalid", "dispatch_allowed": False, "errors": [input_error]})
        return 2
    if not isinstance(payload, dict) or not isinstance(payload.get("candidate"), dict):
        emit({"schema": 1, "status": "invalid", "dispatch_allowed": False, "errors": ["invalid:dispatch:not-object"]})
        return 2
    candidate = payload["candidate"]
    active = payload.get("active", [])
    history = payload.get("executor_history", [])
    errors: list[str] = []
    if not isinstance(active, list) or not all(isinstance(item, dict) for item in active):
        errors.append("invalid:active")
        active = []
    if not isinstance(history, list) or not all(isinstance(item, str) and item for item in history):
        errors.append("invalid:executor-history")
        history = []
    candidate_validation, _, _ = validate_manifest(
        candidate, phase="dispatch", remote=args.remote
    )
    errors.extend(f"candidate:{value}" for value in candidate_validation)
    current_scope = payload.get("current_scope_fingerprint")
    if current_scope != candidate.get("scope_fingerprint"):
        errors.append("invalid:candidate.scope-fingerprint-stale")
    normalized_candidate = json.dumps(
        candidate, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    candidate_digest = hashlib.sha256(normalized_candidate.encode()).hexdigest()
    if payload.get("candidate_digest") != candidate_digest:
        errors.append("invalid:candidate.digest")
    for index, entry in enumerate(active):
        active_validation, _, _ = validate_manifest(
            entry, phase="active", remote=args.remote
        )
        errors.extend(f"active[{index}]:{value}" for value in active_validation)
    issue = candidate.get("issue_identifier")
    if not isinstance(issue, str) or ISSUE_IDENTIFIER.fullmatch(issue) is None:
        errors.append("invalid:candidate.issue-identifier")
    executor = candidate.get("executor")
    if not isinstance(executor, dict):
        errors.append("invalid:candidate.executor")
        executor = {}
    lease_id = executor.get("lease_id")
    if not isinstance(lease_id, str) or UUID_TEXT.fullmatch(lease_id) is None:
        errors.append("invalid:candidate.executor.lease-id")
    if executor.get("mode") == "delegated":
        if executor.get("agent_type") != "worker":
            errors.append("invalid:candidate.executor.agent-type")
        if executor.get("fork_turns") != "none":
            errors.append("invalid:candidate.executor.fork-turns")
    elif executor.get("mode") == "coordinator-inline":
        if executor.get("agent_type") != "coordinator-inline" or executor.get("fork_turns") != "none":
            errors.append("invalid:candidate.executor.inline-contract")
    else:
        errors.append("invalid:candidate.executor.mode")
    if lease_id in history:
        errors.append("invalid:executor-reuse")

    ownership = candidate.get("ownership_paths")
    if not isinstance(ownership, list) or not ownership or not all(_valid_ownership_path(path) for path in ownership):
        errors.append("invalid:candidate.ownership-paths")
        ownership = []

    conflicts: list[dict[str, Any]] = []
    resource_conflicts: list[str] = []
    candidate_paths, candidate_ports, candidate_cache_mode, candidate_cache_key = _dispatch_isolation(candidate)
    for entry in active:
        active_issue = entry.get("issue_identifier", "unknown")
        active_executor = entry.get("executor")
        if isinstance(active_executor, dict) and active_executor.get("lease_id") == lease_id:
            errors.append(f"invalid:executor-active-reuse:{active_issue}")
        active_ownership = entry.get("ownership_paths")
        if not isinstance(active_ownership, list) or not all(_valid_ownership_path(path) for path in active_ownership):
            errors.append(f"invalid:active.ownership-paths:{active_issue}")
            continue
        overlapping = sorted(
            {f"{left}<->{right}" for left in ownership for right in active_ownership if _paths_overlap(left, right)}
        )
        if overlapping:
            conflicts.append({"issue": active_issue, "paths": overlapping})
        active_paths, active_ports, active_cache_mode, active_cache_key = _dispatch_isolation(entry)
        if set(candidate_ports) & set(active_ports):
            resource_conflicts.append(f"ports:{active_issue}")
        for left in candidate_paths[:3]:
            for right in active_paths[:3]:
                if Path(left) == Path(right) or _is_within(Path(left), Path(right)) or _is_within(Path(right), Path(left)):
                    resource_conflicts.append(f"mutable-path:{active_issue}")
        if candidate_paths and active_paths and candidate_paths[-1] == active_paths[-1]:
            shared_cache_valid = (
                candidate_cache_mode == active_cache_mode == "content-addressed"
                and candidate_cache_key is not None
                and candidate_cache_key == active_cache_key
            )
            if not shared_cache_valid:
                resource_conflicts.append(f"cache:{active_issue}")

    if errors or resource_conflicts:
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "dispatch_allowed": False,
                "errors": errors + sorted(set(resource_conflicts)),
                "ownership_conflicts": conflicts,
            }
        )
        return 2
    if conflicts:
        emit(
            {
                "schema": 1,
                "status": "serialized",
                "dispatch_allowed": False,
                "reason": "active-ownership-overlap",
                "ownership_conflicts": conflicts,
            }
        )
        return 4
    emit({"schema": 1, "status": "compatible", "dispatch_allowed": True, "ownership_conflicts": []})
    return 0


def _read_json(source: str) -> tuple[Any | None, str | None]:
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        return json.loads(raw), None
    except (OSError, json.JSONDecodeError) as error:
        return None, f"input:{type(error).__name__}"


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _utc_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        return None
    return parsed


def _valid_timestamp(value: Any) -> bool:
    return _utc_datetime(value) is not None


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


def _broad_worker_check(argv: list[str]) -> bool:
    normalized = [item.lower() for item in argv]
    if normalized[:3] in (["npm", "run", "check"], ["npm", "run", "build"]):
        return True
    if len(normalized) >= 3 and normalized[:2] == ["npm", "run"] and normalized[2].startswith("check:"):
        return True
    if normalized[:2] in (["npm", "test"], ["node", "--test"]):
        return len(normalized) == 2
    if normalized[:3] in (["python", "-m", "pytest"], ["python3", "-m", "pytest"]):
        return len(normalized) == 3
    if normalized[:3] in (["python", "-m", "unittest"], ["python3", "-m", "unittest"]):
        return len(normalized) == 3
    return any(item in {"full-gate", "full-suite"} for item in normalized)


def _dependency_mutating_worker_check(argv: list[str]) -> bool:
    normalized = [item.lower() for item in argv]
    return (
        len(normalized) >= 2
        and normalized[0] in {"npm", "pnpm", "yarn", "bun"}
        and normalized[1] in {"ci", "install", "i", "add"}
    )


def _validate_targeted_checks(value: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(value, list) or not value:
        return ["invalid:validation.targeted_checks"]
    identifiers: set[str] = set()
    for index, check in enumerate(value):
        prefix = f"validation.targeted_checks[{index}]"
        if not isinstance(check, dict) or set(check) != {"id", "argv"}:
            errors.append(f"invalid:{prefix}:shape")
            continue
        identifier = check.get("id")
        argv = check.get("argv")
        if not isinstance(identifier, str) or re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", identifier) is None:
            errors.append(f"invalid:{prefix}:id")
        elif identifier in identifiers:
            errors.append("invalid:validation.targeted_checks:duplicate-id")
        else:
            identifiers.add(identifier)
        if (
            not isinstance(argv, list)
            or not argv
            or len(argv) > 128
            or not all(
                isinstance(item, str)
                and item
                and len(item.encode("utf-8")) <= 8192
                and "\0" not in item
                and "\n" not in item
                for item in argv
            )
        ):
            errors.append(f"invalid:{prefix}:argv")
            continue
        executable = Path(argv[0]).name.lower()
        if executable in FORBIDDEN_WORKER_WRAPPERS:
            errors.append(f"invalid:{prefix}:wrapper")
        elif executable not in SAFE_WORKER_EXECUTABLES and re.fullmatch(
            r"python3(?:\.\d+)?", executable
        ) is None:
            errors.append(f"invalid:{prefix}:executable")
        if _broad_worker_check(argv):
            errors.append("invalid:validation.targeted_checks:full-suite")
        if _dependency_mutating_worker_check(argv):
            errors.append("invalid:validation.targeted_checks:dependency-mutation")
    return list(dict.fromkeys(errors))


def _remote_ref_tip(repo: Path, remote: str, ref: str) -> str | None:
    result = foreign_main.run(repo, "ls-remote", "--refs", remote, ref)
    if result.returncode != 0:
        return None
    lines = result.stdout.decode("ascii", "replace").splitlines()
    if len(lines) != 1:
        return None
    parts = lines[0].split(maxsplit=1)
    return parts[0] if len(parts) == 2 and parts[1] == ref and GIT_OID.fullmatch(parts[0]) else None


def _required_package_roots(
    worktree: Path, ownership_paths: list[str]
) -> tuple[list[Path], list[str]]:
    worktree = worktree.resolve()
    roots = {worktree}
    errors: list[str] = []
    tracked = foreign_main.run(worktree, "ls-files", "-z")
    if tracked.returncode != 0:
        return [worktree], ["invalid:tracked-package-locks-unavailable"]
    tracked_lock_roots = {
        (worktree / PurePosixPath(path)).parent.resolve()
        for path in tracked.stdout.decode("utf-8", "surrogateescape").split("\0")
        if path and PurePosixPath(path).name == "package-lock.json"
    }
    if worktree not in tracked_lock_roots:
        errors.append("invalid:root-package-lock-untracked")
    for value in ownership_paths:
        if not _valid_ownership_path(value):
            errors.append(f"invalid:provision-path:{value or 'empty'}")
            continue
        candidate = (worktree / PurePosixPath(value)).resolve()
        if not _is_within(candidate, worktree):
            errors.append(f"invalid:provision-path-outside-worktree:{value}")
            continue
        cursor = candidate if candidate.is_dir() else candidate.parent
        selected = worktree
        while cursor != worktree and _is_within(cursor, worktree):
            if cursor in tracked_lock_roots:
                selected = cursor
                break
            cursor = cursor.parent
        roots.add(selected)
        if candidate.is_dir():
            roots.update(
                package_root
                for package_root in tracked_lock_roots
                if package_root == candidate or _is_within(package_root, candidate)
            )
    ordered = sorted(
        roots,
        key=lambda path: (
            path != worktree,
            path.relative_to(worktree).as_posix() if path != worktree else ".",
        ),
    )
    return ordered, list(dict.fromkeys(errors))


def _provision_installations(
    worktree: Path, ownership_paths: list[str]
) -> tuple[list[dict[str, str]], list[str]]:
    roots, errors = _required_package_roots(worktree, ownership_paths)
    installations: list[dict[str, str]] = []
    for root in roots:
        lockfile = root / "package-lock.json"
        if not lockfile.is_file():
            relative = "." if root == worktree else root.relative_to(worktree).as_posix()
            errors.append(f"invalid:package-lock-missing:{relative}")
            continue
        installations.append(
            {
                "root": "." if root == worktree else root.relative_to(worktree).as_posix(),
                "lockfile_digest": hashlib.sha256(lockfile.read_bytes()).hexdigest(),
                "dependency_path": str((root / "node_modules").resolve()),
            }
        )
    return installations, list(dict.fromkeys(errors))


def _provisioning_digest(installations: list[dict[str, str]]) -> str:
    return hashlib.sha256(
        json.dumps(
            installations,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _dependency_environment_errors(
    value: Any, worktree: Path | None, ownership_paths: list[str]
) -> list[str]:
    prefix = "dependencies"
    required = {"mode", "path", "lockfile_digest", "cache_key", "read_only", "provenance"}
    if not isinstance(value, dict):
        return [f"invalid:{prefix}:not-object"]
    errors = [f"missing:{prefix}.{name}" for name in sorted(required - value.keys())]
    mode = value.get("mode")
    if mode not in {"isolated", "content-addressed"}:
        errors.append(f"invalid:{prefix}.mode")
    raw_path = value.get("path")
    path = Path(raw_path) if isinstance(raw_path, str) and Path(raw_path).is_absolute() else None
    if path is None:
        errors.append(f"invalid:{prefix}.path")
    elif not path.exists() or not path.is_dir() or path.is_symlink():
        errors.append(f"invalid:{prefix}.path:missing-or-linked")
    elif mode == "isolated" and (worktree is None or path.resolve() != (worktree / "node_modules").resolve()):
        errors.append(f"invalid:{prefix}.path:not-task-owned-node-modules")
    elif mode == "content-addressed" and worktree is not None and (
        path.resolve() == worktree or _is_within(path.resolve(), worktree)
    ):
        errors.append(f"invalid:{prefix}.path:cache-inside-worktree")
    lockfile_digest = value.get("lockfile_digest")
    if not isinstance(lockfile_digest, str) or LOWER_DIGEST.fullmatch(lockfile_digest) is None:
        errors.append(f"invalid:{prefix}.lockfile_digest")
    elif worktree is not None:
        lockfile = worktree / "package-lock.json"
        if not lockfile.is_file():
            errors.append(f"invalid:{prefix}.lockfile:missing")
        elif hashlib.sha256(lockfile.read_bytes()).hexdigest() != lockfile_digest:
            errors.append(f"invalid:{prefix}.lockfile_digest:mismatch")
    cache_key = value.get("cache_key")
    read_only = value.get("read_only")
    if mode == "isolated":
        if cache_key != "none":
            errors.append(f"invalid:{prefix}.cache_key:unexpected")
        if read_only is not False:
            errors.append(f"invalid:{prefix}.read_only")
        if worktree is not None:
            receipt = worktree / ".codex-task" / "provision.json"
            try:
                provision = json.loads(receipt.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                errors.append(f"invalid:{prefix}.provision_receipt")
            else:
                if (
                    not isinstance(provision, dict)
                    or provision.get("status") != "installed"
                    or provision.get("lockfile_digest") != lockfile_digest
                    or provision.get("dependency_path") != str((worktree / "node_modules").resolve())
                ):
                    errors.append(f"invalid:{prefix}.provision_receipt")
                if not isinstance(provision, dict):
                    provision = {}
                expected_installations, installation_errors = _provision_installations(
                    worktree, ownership_paths
                )
                errors.extend(
                    f"invalid:{prefix}.provision_receipt:{item}"
                    for item in installation_errors
                )
                stored_installations = provision.get("installations")
                if len(expected_installations) > 1:
                    if stored_installations != expected_installations:
                        errors.append(f"invalid:{prefix}.provision_receipt:installations")
                    elif provision.get("provisioning_digest") != _provisioning_digest(
                        expected_installations
                    ):
                        errors.append(f"invalid:{prefix}.provision_receipt:digest")
                elif stored_installations is not None and stored_installations != expected_installations:
                    errors.append(f"invalid:{prefix}.provision_receipt:installations")
                for installation in expected_installations:
                    dependency = Path(installation["dependency_path"])
                    if not dependency.is_dir() or dependency.is_symlink():
                        errors.append(
                            f"invalid:{prefix}.provision_receipt:dependency-tree:{installation['root']}"
                        )
    elif mode == "content-addressed":
        if not isinstance(cache_key, str) or LOWER_DIGEST.fullmatch(cache_key) is None:
            errors.append(f"invalid:{prefix}.cache_key")
        if read_only is not True:
            errors.append(f"invalid:{prefix}.read_only")
        if path is not None and path.exists() and path.stat().st_mode & 0o222:
            errors.append(f"invalid:{prefix}.path:writable")
    provenance = value.get("provenance")
    if (
        not isinstance(provenance, str)
        or not provenance
        or len(provenance) > 512
        or "\n" in provenance
        or "\0" in provenance
    ):
        errors.append(f"invalid:{prefix}.provenance")
    return errors


def validate_manifest(
    manifest: Any, *, phase: str = "dispatch", remote: str = "origin"
) -> tuple[list[str], list[str], list[str]]:
    if not isinstance(manifest, dict):
        return ["invalid:manifest:not-object"], ["unknown"], list(ALL_DOCS)
    errors: list[str] = []

    def error(value: str) -> None:
        if value not in errors:
            errors.append(value)

    for name in sorted(REQUIRED_MANIFEST_FIELDS - manifest.keys()):
        error(f"missing:{name}")

    for name in ("run_id", "owner_id", "claim_token", "project_id", "milestone_id"):
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
    issue_id = manifest.get("issue_id")
    if not isinstance(issue_id, str) or (
        UUID_TEXT.fullmatch(issue_id) is None and issue_id != issue_identifier
    ):
        error("invalid:issue_id")
    for name in ("coordinator_sha", "guard_tip", "root_sha", "base_sha"):
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

    executor = manifest.get("executor")
    if not isinstance(executor, dict):
        error("invalid:executor:not-object")
        executor = {}
    if not isinstance(executor.get("lease_id"), str) or UUID_TEXT.fullmatch(executor["lease_id"]) is None:
        error("invalid:executor.lease_id")
    if executor.get("fork_turns") != "none":
        error("invalid:executor.fork_turns")
    if executor.get("mode") == "delegated":
        if executor.get("agent_type") != "worker":
            error("invalid:executor.agent_type")
    elif executor.get("mode") == "coordinator-inline":
        if executor.get("agent_type") != "coordinator-inline":
            error("invalid:executor.agent_type")
    else:
        error("invalid:executor.mode")

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
    checkout_mode = manifest.get("checkout_mode", "worktree")
    repo = Path(repo_value).resolve() if isinstance(repo_value, str) and Path(repo_value).is_absolute() else None
    worktree = Path(worktree_value).resolve() if isinstance(worktree_value, str) and Path(worktree_value).is_absolute() else None
    if repo is None or not repo.is_dir():
        error("invalid:repo")
    if worktree is None or not worktree.is_dir():
        error("invalid:worktree")
    if checkout_mode not in {"primary", "worktree"}:
        error("invalid:checkout_mode")
    elif checkout_mode == "primary":
        if repo is not None and worktree is not None and repo != worktree:
            error("invalid:primary-checkout-must-equal-repo")
        if executor.get("mode") != "coordinator-inline":
            error("invalid:primary-checkout-requires-coordinator-inline")
    elif repo is not None and worktree is not None and repo == worktree:
        error("invalid:worktree-must-differ-from-repo")

    for dependency_error in _dependency_environment_errors(
        manifest.get("dependencies"), worktree, ownership
    ):
        error(dependency_error)

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
    cache_key = isolation.get("cache_key")
    if cache_mode == "content-addressed" and (
        not isinstance(cache_key, str) or LOWER_DIGEST.fullmatch(cache_key) is None
    ):
        error("invalid:isolation.cache_key")
    if cache_mode == "isolated" and cache_key not in {None, "none"}:
        error("invalid:isolation.cache_key:unexpected")
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
    for targeted_error in _validate_targeted_checks(validation.get("targeted_checks")):
        error(targeted_error)

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
        if code != 0 or GIT_OID.fullmatch(head) is None:
            error("invalid:worktree-head")
        elif phase == "dispatch" and head != manifest.get("base_sha"):
            error("invalid:worktree-head-vs-base")
        if phase == "dispatch":
            status = foreign_main.run(
                worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"
            )
            if status.returncode != 0:
                error("invalid:worktree-status-unavailable")
            elif status.stdout:
                error("invalid:worktree-dirty")
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
        if phase == "dispatch" and isinstance(feature_ref, str):
            code, feature_tip = git(worktree, "rev-parse", "--verify", feature_ref)
            if code != 0 or feature_tip != manifest.get("base_sha"):
                error("invalid:feature_ref-tip")
        if isinstance(guard_ref, str):
            code, guard_tip = git(worktree, "rev-parse", "--verify", guard_ref)
            if code != 0 or GIT_OID.fullmatch(guard_tip) is None:
                error("invalid:guard_ref-tip")
            elif phase == "dispatch" and guard_tip != manifest.get("guard_tip"):
                error("invalid:guard_ref-tip")

        coordinator_sha = manifest.get("coordinator_sha")
        if isinstance(coordinator_sha, str) and GIT_OID.fullmatch(coordinator_sha):
            if not foreign_main.object_exists(repo, coordinator_sha):
                error("invalid:coordinator_sha:object-missing")
            else:
                message_code, message = git(repo, "show", "-s", "--format=%B", coordinator_sha)
                coordinator, duplicates = parse_fields(message) if message_code == 0 else ({}, [])
                if message_code != 0 or duplicates:
                    error("invalid:coordinator_sha:metadata")
                expected = {
                    "RUN_ID": manifest.get("run_id"),
                    "RUN_KEY": manifest.get("run_key"),
                    "OWNER_ID": manifest.get("owner_id"),
                    "EPOCH": str(manifest.get("owner_epoch")),
                    "PROJECT_ID": manifest.get("project_id"),
                    "MILESTONE_ID": manifest.get("milestone_id"),
                }
                if any(coordinator.get(name) != value for name, value in expected.items()):
                    error("invalid:coordinator_sha:identity-mismatch")
                if (
                    message_code == 0
                    and not duplicates
                    and isinstance(issue_identifier, str)
                    and _positive_int(generation)
                ):
                    binding, binding_errors = _active_claim_binding(
                        message, issue_identifier, generation
                    )
                    for binding_error in binding_errors:
                        error(f"invalid:coordinator_sha:claim:{binding_error}")
                    if binding is None:
                        error("invalid:coordinator_sha:claim-not-active")
                    else:
                        if binding.get("guard") != f"{remote}:{guard_ref}":
                            error("invalid:coordinator_sha:claim-guard-binding")
                        if binding.get("feature") != f"{remote}:{feature_ref}":
                            error("invalid:coordinator_sha:claim-feature-binding")
                        if binding.get("claim_token") != manifest.get("claim_token"):
                            error("invalid:coordinator_sha:claim-token-binding")
        if manifest.get("remote_mode") == "online" and isinstance(guard_ref, str):
            remote_coordinator = _remote_ref_tip(repo, remote, CANONICAL_COORDINATOR_REF)
            dispatched_coordinator = manifest.get("coordinator_sha")
            if remote_coordinator is None:
                error("invalid:remote-coordinator-missing")
            else:
                materialized = foreign_main.run(
                    repo,
                    "fetch",
                    "--no-write-fetch-head",
                    "--no-tags",
                    remote,
                    remote_coordinator,
                )
                if materialized.returncode != 0 or not foreign_main.object_exists(repo, remote_coordinator):
                    error("invalid:remote-coordinator-materialization")
                elif (
                    phase == "dispatch" and remote_coordinator != dispatched_coordinator
                ):
                    error("invalid:remote-coordinator-tip")
                elif (
                    phase != "dispatch"
                    and (
                        not isinstance(dispatched_coordinator, str)
                        or git(
                            repo,
                            "merge-base",
                            "--is-ancestor",
                            dispatched_coordinator,
                            remote_coordinator,
                        )[0]
                        != 0
                    )
                ):
                    error("invalid:remote-coordinator-not-descendant")
                else:
                    current_code, current_message = git(
                        repo, "show", "-s", "--format=%B", remote_coordinator
                    )
                    current, current_duplicates = (
                        parse_fields(current_message) if current_code == 0 else ({}, [])
                    )
                    expected = {
                        "RUN_ID": manifest.get("run_id"),
                        "RUN_KEY": manifest.get("run_key"),
                        "OWNER_ID": manifest.get("owner_id"),
                        "EPOCH": str(manifest.get("owner_epoch")),
                        "PROJECT_ID": manifest.get("project_id"),
                        "MILESTONE_ID": manifest.get("milestone_id"),
                    }
                    if current_code != 0 or current_duplicates:
                        error("invalid:remote-coordinator-metadata")
                    elif any(current.get(name) != value for name, value in expected.items()):
                        error("invalid:remote-coordinator-identity-mismatch")
                    elif isinstance(issue_identifier, str) and _positive_int(generation):
                        binding, binding_errors = _active_claim_binding(
                            current_message, issue_identifier, generation
                        )
                        for binding_error in binding_errors:
                            error(f"invalid:remote-coordinator-claim:{binding_error}")
                        if binding is None:
                            error("invalid:remote-coordinator-claim-not-active")
                        else:
                            if binding.get("guard") != f"{remote}:{guard_ref}":
                                error("invalid:remote-coordinator-claim-guard-binding")
                            if binding.get("feature") != f"{remote}:{feature_ref}":
                                error("invalid:remote-coordinator-claim-feature-binding")
                            if binding.get("claim_token") != manifest.get("claim_token"):
                                error("invalid:remote-coordinator-claim-token-binding")
            remote_guard_tip = _remote_ref_tip(repo, remote, guard_ref)
            if remote_guard_tip is None:
                error("invalid:remote-guard-missing")
            elif phase == "dispatch" and remote_guard_tip != manifest.get("guard_tip"):
                error("invalid:remote-guard-tip")
            else:
                materialized_guard = foreign_main.run(
                    repo,
                    "fetch",
                    "--no-write-fetch-head",
                    "--no-tags",
                    remote,
                    remote_guard_tip,
                )
                dispatched_guard = manifest.get("guard_tip")
                if (
                    materialized_guard.returncode != 0
                    or not foreign_main.object_exists(repo, remote_guard_tip)
                ):
                    error("invalid:remote-guard-materialization")
                elif (
                    not isinstance(dispatched_guard, str)
                    or git(
                        repo,
                        "merge-base",
                        "--is-ancestor",
                        dispatched_guard,
                        remote_guard_tip,
                    )[0]
                    != 0
                ):
                    error("invalid:remote-guard-not-descendant")
                else:
                    guard_code, guard_message = git(
                        repo, "show", "-s", "--format=%B", remote_guard_tip
                    )
                    guard_metadata, guard_duplicates = (
                        parse_fields(guard_message) if guard_code == 0 else ({}, [])
                    )
                    allowed_guard_states = {
                        "dispatch": {"claimed", "checkpoint"},
                        "active": {"claimed", "checkpoint", "ready"},
                        "receipt": {"ready"},
                    }[phase]
                    if guard_code != 0 or guard_duplicates:
                        error("invalid:remote-guard-metadata")
                    elif guard_metadata.get("STATE", "").lower() not in allowed_guard_states:
                        error("invalid:remote-guard-state")
                    elif guard_metadata.get("KIND") not in {None, "CLAIM_GUARD"}:
                        error("invalid:remote-guard-kind")

    return errors, surfaces, list(documents)


def command_manifest(args: argparse.Namespace) -> int:
    manifest, input_error = _read_json(args.input)
    if input_error:
        emit({"schema": 1, "status": "invalid", "errors": [input_error], "surfaces": ["unknown"], "documents": ALL_DOCS})
        return 2
    errors, surfaces, docs = validate_manifest(manifest, phase=args.phase, remote=args.remote)
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


def _tool_version(executable: str) -> str | None:
    try:
        result = subprocess.run(
            [executable, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
            text=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and value and len(value) <= 128 else None


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = -1
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def command_provision_worktree(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    worktree = Path(args.worktree).resolve()
    checkout_mode = getattr(args, "checkout_mode", "worktree")
    errors: list[str] = []
    if checkout_mode == "worktree" and repo == worktree:
        errors.append("invalid:worktree-must-differ-from-repo")
    elif checkout_mode == "primary" and repo != worktree:
        errors.append("invalid:primary-checkout-must-equal-repo")
    repo_top = foreign_main.text(repo, "rev-parse", "--show-toplevel")
    worktree_top = foreign_main.text(worktree, "rev-parse", "--show-toplevel")
    if repo_top is None or Path(repo_top).resolve() != repo:
        errors.append("invalid:repo")
    if worktree_top is None or Path(worktree_top).resolve() != worktree:
        errors.append("invalid:worktree")
    if _common_git_dir(repo) != _common_git_dir(worktree):
        errors.append("invalid:repo-worktree-common-dir")
    status = foreign_main.run(
        worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"
    )
    if status.returncode != 0:
        errors.append("invalid:worktree-status-unavailable")
    elif status.stdout:
        errors.append("invalid:worktree-dirty-before-provision")
    ownership_paths = list(getattr(args, "path", []) or [])
    installations, installation_errors = _provision_installations(
        worktree, ownership_paths
    )
    errors.extend(installation_errors)
    if args.package_manager != "npm":
        errors.append("invalid:package-manager")
    if not 30 <= args.timeout_seconds <= 3600:
        errors.append("invalid:timeout-seconds")
    if errors:
        emit({"schema": 1, "status": "invalid", "errors": errors})
        return 2

    if not installations or installations[0]["root"] != ".":
        emit({"schema": 1, "status": "invalid", "errors": ["invalid:root-package-lock-missing"]})
        return 2
    lockfile_digest = installations[0]["lockfile_digest"]
    provisioning_digest = _provisioning_digest(installations)
    task_root = worktree / ".codex-task"
    build_dir = task_root / "build"
    tmp_dir = task_root / "tmp"
    runtime_dir = task_root / "runtime"
    cache_dir = task_root / "npm-cache"
    for path in (build_dir, tmp_dir, runtime_dir, cache_dir):
        path.mkdir(parents=True, exist_ok=True)
    dependency_path = worktree / "node_modules"
    receipt_path = task_root / "provision.json"
    node_version = _tool_version("node")
    npm_version = _tool_version("npm")
    if node_version is None or npm_version is None:
        emit({"schema": 1, "status": "blocked", "reason": "toolchain-unavailable"})
        return 3
    environment_id = hashlib.sha256(
        f"npm-ci\0{provisioning_digest}\0{node_version}\0{npm_version}\0{sys.platform}".encode()
    ).hexdigest()
    dependency_trees_valid = all(
        Path(item["dependency_path"]).is_dir()
        and not Path(item["dependency_path"]).is_symlink()
        for item in installations
    )
    if receipt_path.is_file() and dependency_trees_valid:
        try:
            stored = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            stored = None
        stored_installations = stored.get("installations") if isinstance(stored, dict) else None
        installation_match = (
            stored_installations == installations
            or (len(installations) == 1 and stored_installations is None)
        )
        if (
            isinstance(stored, dict)
            and stored.get("status") == "installed"
            and stored.get("environment_id") == environment_id
            and stored.get("lockfile_digest") == lockfile_digest
            and stored.get("dependency_path") == str(dependency_path)
            and stored.get("checkout_mode", "worktree") == checkout_mode
            and installation_match
            and (
                len(installations) == 1
                or stored.get("provisioning_digest") == provisioning_digest
            )
        ):
            emit({"schema": 1, **stored, "status": "adopted"})
            return 0
    if not args.install:
        commands = [
            {
                "cwd": str(
                    worktree
                    if item["root"] == "."
                    else worktree / PurePosixPath(item["root"])
                ),
                "argv": ["npm", "ci"],
            }
            for item in installations
        ]
        emit(
            {
                "schema": 1,
                "status": "prepared",
                "checkout_mode": checkout_mode,
                "install_required": True,
                "environment_id": environment_id,
                "lockfile_digest": lockfile_digest,
                "provisioning_digest": provisioning_digest,
                "installations": installations,
                "task_root": str(task_root.resolve()),
                "dependency_path": str(dependency_path),
                "command": commands[0],
                "commands": commands,
            }
        )
        return 4

    environment = os.environ.copy()
    environment.update(
        {
            "NPM_CONFIG_CACHE": str(cache_dir.resolve()),
            "TMPDIR": str(tmp_dir.resolve()),
        }
    )
    deadline = time.monotonic() + args.timeout_seconds
    for installation in installations:
        install_root = (
            worktree
            if installation["root"] == "."
            else worktree / PurePosixPath(installation["root"])
        )
        remaining = max(deadline - time.monotonic(), 0)
        if remaining == 0:
            emit(
                {
                    "schema": 1,
                    "status": "failed",
                    "reason": "npm-ci-timeout",
                    "install_root": installation["root"],
                }
            )
            return 5
        with tempfile.TemporaryFile() as output:
            try:
                completed = subprocess.run(
                    ["npm", "ci"],
                    cwd=install_root,
                    stdin=subprocess.DEVNULL,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    env=environment,
                    check=False,
                    timeout=remaining,
                )
            except subprocess.TimeoutExpired:
                emit(
                    {
                        "schema": 1,
                        "status": "failed",
                        "reason": "npm-ci-timeout",
                        "install_root": installation["root"],
                    }
                )
                return 5
            except OSError as error:
                emit(
                    {
                        "schema": 1,
                        "status": "failed",
                        "reason": f"npm-ci-{type(error).__name__}",
                        "install_root": installation["root"],
                    }
                )
                return 5
            if completed.returncode != 0:
                emit(
                    {
                        "schema": 1,
                        "status": "failed",
                        "reason": "npm-ci-failed",
                        "install_root": installation["root"],
                        "exit_code": completed.returncode,
                    }
                )
                return 5
    invalid_trees = [
        item["root"]
        for item in installations
        if not Path(item["dependency_path"]).is_dir()
        or Path(item["dependency_path"]).is_symlink()
    ]
    if invalid_trees:
        emit(
            {
                "schema": 1,
                "status": "failed",
                "reason": "dependency-tree-missing-or-linked",
                "install_roots": invalid_trees,
            }
        )
        return 5
    receipt = {
        "status": "installed",
        "checkout_mode": checkout_mode,
        "environment_id": environment_id,
        "lockfile_digest": lockfile_digest,
        "dependency_path": str(dependency_path),
        "provisioning_digest": provisioning_digest,
        "installations": installations,
        "node_version": node_version,
        "npm_version": npm_version,
        "provenance": f"npm-ci-set:{provisioning_digest}",
    }
    _atomic_json(receipt_path, receipt)
    after = foreign_main.run(
        worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"
    )
    if after.returncode != 0 or after.stdout:
        emit({"schema": 1, "status": "failed", "reason": "provision-created-unignored-source-state"})
        return 5
    emit(
        {
            "schema": 1,
            **receipt,
            "isolation": {
                "mutable_build_dir": str(build_dir.resolve()),
                "tmp_dir": str(tmp_dir.resolve()),
                "runtime_dir": str(runtime_dir.resolve()),
                "cache_mode": "isolated",
                "cache_dir": str(cache_dir.resolve()),
                "cache_key": "none",
                "ports": [],
                "env": {
                    "MIND_DIARY_TASK_TMP": str(tmp_dir.resolve()),
                    "NPM_CONFIG_CACHE": str(cache_dir.resolve()),
                },
            },
            "dependencies": {
                "mode": "isolated",
                "path": str(dependency_path),
                "lockfile_digest": lockfile_digest,
                "cache_key": "none",
                "read_only": False,
                "provenance": f"npm-ci-set:{provisioning_digest}",
                "installations": installations,
                "provisioning_digest": provisioning_digest,
            },
        }
    )
    return 0


def _receipt_identity(value: str, pattern: str) -> tuple[str, ...] | None:
    match = re.fullmatch(pattern, value)
    return match.groups() if match else None


def command_receipt_verify(args: argparse.Namespace) -> int:
    manifest, manifest_error = _read_json(args.manifest)
    if manifest_error:
        emit({"schema": 1, "status": "invalid", "verified": False, "errors": [manifest_error]})
        return 2
    manifest_errors, _, _ = validate_manifest(manifest, phase="receipt", remote=args.remote)
    try:
        raw = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
    except OSError as error:
        emit({"schema": 1, "status": "invalid", "verified": False, "errors": [f"input:{type(error).__name__}"]})
        return 2
    errors = [f"manifest:{value}" for value in manifest_errors]
    if not raw.strip() or len(raw.encode("utf-8")) > 4096 or "\0" in raw:
        errors.append("invalid:receipt-size")
        receipt: dict[str, str] = {}
    else:
        receipt, duplicates = parse_fields(raw)
        errors.extend(f"invalid:receipt-duplicate:{name}" for name in duplicates)
    required = {
        "STATUS",
        "RUN_ID",
        "RUN_KEY",
        "OWNER",
        "CLAIM",
        "ISSUE",
        "WORKTREE",
        "BRANCH",
        "BASE_SHA",
        "HEAD_SHA",
        "SCOPE",
        "ORIGIN_REF",
        "GUARD",
        "CHECK_CLASS",
        "TARGETED_CHECKS",
        "CHECKS_DIGEST",
        "FULL_GATE",
        "EXECUTOR",
        "GAPS",
        "DIRTY_REMAINDER",
        "DEFECT_CANDIDATE",
        "NEXT",
    }
    errors.extend(f"missing:receipt.{name.lower()}" for name in sorted(required - receipt.keys()))
    status = receipt.get("STATUS")
    if status not in {"ready", "failed", "needs-coordinator", "needs-input"}:
        errors.append("invalid:receipt.status")
    expected_scalars = {
        "RUN_ID": manifest.get("run_id"),
        "RUN_KEY": manifest.get("run_key"),
        "WORKTREE": manifest.get("worktree"),
        "BRANCH": manifest.get("branch"),
        "BASE_SHA": manifest.get("base_sha"),
        "CHECK_CLASS": "targeted-feature",
        "FULL_GATE": "deferred-to-cutoff",
    }
    for name, expected in expected_scalars.items():
        if receipt.get(name) != expected:
            errors.append(f"invalid:receipt.{name.lower()}")
    issue = _receipt_identity(
        receipt.get("ISSUE", ""), r"([A-Z][A-Z0-9]*-[1-9][0-9]*) \(([^()]+)\)"
    )
    if issue != (manifest.get("issue_identifier"), manifest.get("issue_id")):
        errors.append("invalid:receipt.issue")
    owner = _receipt_identity(
        receipt.get("OWNER", ""),
        rf"id=({UUID_TEXT.pattern}); epoch=([1-9][0-9]*)",
    )
    if owner != (manifest.get("owner_id"), str(manifest.get("owner_epoch"))):
        errors.append("invalid:receipt.owner")
    claim = _receipt_identity(
        receipt.get("CLAIM", ""),
        rf"generation=([1-9][0-9]*); token=({UUID_TEXT.pattern})",
    )
    if claim != (str(manifest.get("claim_generation")), manifest.get("claim_token")):
        errors.append("invalid:receipt.claim")
    executor = _receipt_identity(
        receipt.get("EXECUTOR", ""),
        rf"lease=({UUID_TEXT.pattern}); mode=(delegated|coordinator-inline); fresh=(yes)",
    )
    manifest_executor = manifest.get("executor", {}) if isinstance(manifest, dict) else {}
    if executor != (
        manifest_executor.get("lease_id"),
        manifest_executor.get("mode"),
        "yes",
    ):
        errors.append("invalid:receipt.executor")
    checks_digest = receipt.get("CHECKS_DIGEST", "")
    if LOWER_DIGEST.fullmatch(checks_digest) is None:
        errors.append("invalid:receipt.checks-digest")
    scope = _receipt_identity(
        receipt.get("SCOPE", ""),
        r"start_fingerprint=([0-9a-f]{64}); final_fingerprint=([0-9a-f]{64}); (unchanged|adapted)",
    )
    expected_scope = manifest.get("scope_fingerprint") if isinstance(manifest, dict) else None
    if (
        scope is None
        or scope[0] != expected_scope
        or scope[1] != args.current_scope_fingerprint
        or scope[2] != "unchanged"
    ):
        errors.append("invalid:receipt.scope")
    if status == "ready" and not errors:
        repo = Path(manifest["repo"]).resolve()
        worktree = Path(manifest["worktree"]).resolve()
        head = receipt.get("HEAD_SHA", "")
        if GIT_OID.fullmatch(head) is None or foreign_main.text(worktree, "rev-parse", "HEAD") != head:
            errors.append("invalid:receipt.head")
        feature = _receipt_identity(
            receipt.get("ORIGIN_REF", ""), r"([^=\s]+)=([0-9a-f]{40}(?:[0-9a-f]{24})?)"
        )
        if feature != (manifest.get("branch"), head):
            errors.append("invalid:receipt.origin-ref")
        elif _remote_ref_tip(repo, args.remote, manifest["feature_ref"]) != head:
            errors.append("invalid:receipt.remote-feature-tip")
        guard = _receipt_identity(
            receipt.get("GUARD", ""),
            r"origin:(refs/heads/[^=\s]+)=([0-9a-f]{40}(?:[0-9a-f]{24})?)",
        )
        if guard is None or guard[0] != manifest.get("guard_ref"):
            errors.append("invalid:receipt.guard")
        elif _remote_ref_tip(repo, args.remote, guard[0]) != guard[1]:
            errors.append("invalid:receipt.remote-guard-tip")
        else:
            fetch = foreign_main.run(
                repo, "fetch", "--no-write-fetch-head", "--no-tags", args.remote, guard[1]
            )
            code, guard_message = git(repo, "show", "-s", "--format=%B", guard[1])
            guard_metadata = _guard_metadata(guard_message) if fetch.returncode == 0 and code == 0 else {}
            if (
                guard_metadata.get("STATE") != "ready"
                or guard_metadata.get("ISSUE") != manifest.get("issue_identifier")
                or guard_metadata.get("CLAIM_GENERATION") != str(manifest.get("claim_generation"))
                or guard_metadata.get("FEATURE_HEAD") != head
                or guard_metadata.get("CHECKS_DIGEST") != checks_digest
            ):
                errors.append("invalid:receipt.guard-metadata")
        worktree_status = foreign_main.run(
            worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"
        )
        if worktree_status.returncode != 0 or worktree_status.stdout:
            errors.append("invalid:receipt.worktree-dirty")
        code, changed = git(
            worktree, "diff", "--name-only", f"{manifest['base_sha']}..{head}"
        )
        ownership = manifest.get("ownership_paths", [])
        if code != 0:
            errors.append("invalid:receipt.diff-unavailable")
        else:
            for path in changed.splitlines():
                if not any(_paths_overlap(path, owned) for owned in ownership):
                    errors.append(f"invalid:receipt.path-outside-ownership:{path}")
    if errors:
        emit({"schema": 1, "status": "invalid", "verified": False, "errors": list(dict.fromkeys(errors))})
        return 2
    digest = hashlib.sha256(raw.encode()).hexdigest()
    emit(
        {
            "schema": 1,
            "status": status,
            "verified": True,
            "receipt_digest": digest,
            "issue_identifier": manifest.get("issue_identifier"),
            "head_sha": receipt.get("HEAD_SHA"),
            "checks_digest": checks_digest,
            "next": "execution-feature-ready" if status == "ready" else "coordinator-triage",
        }
    )
    return 0


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
    if parent_fields.get("__DUPLICATE_HEADERS__"):
        errors.append("invalid:parent-duplicate-authoritative-headers")
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
    tree = _metadata_tree(repo)
    if code != 0 or tree is None:
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
    replaced = set(ACTION_HEADERS) | {"ACTION_STATUS", "ACTION_RESULT"}
    for line in parent_message.splitlines():
        key, separator, _ = line.partition(":")
        if (
            separator
            and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
            and key not in replaced
            and key not in REBUILDABLE_METADATA_HEADERS
        ):
            message_lines.append(line)
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
            "tree_mode": "empty-workflow-free",
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
    repository: dict[str, Any],
    thread_id: str,
    *,
    cause: str = "handoff",
    expected_owner_state: str = "handoff-ready",
    stop_proof_kind: str = "none",
    stop_proof_digest: str = "none",
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
        "cause": cause,
        "stop_proof_kind": stop_proof_kind,
        "stop_proof_digest": stop_proof_digest,
    }
    payload_digest = hashlib.sha256(
        json.dumps(action_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    action_id = str(
        uuid.uuid5(TRANSITION_NAMESPACE, f"takeover-action:{payload_digest}")
    )
    parent_lifecycle = _coordinator_lifecycle(parent_fields)
    pause_id = parent_lifecycle.get("pause_id")
    pause_prefix = f"{pause_id}:pause@" if pause_id else ""
    remaining_holds = [
        item
        for item in _hold_pause_entries(_pause_index_value(parent_fields))
        if not pause_prefix or not item.lower().startswith(pause_prefix)
    ]
    primary_fingerprint = primary.get("fingerprint") or "unknown"
    primary_observation = primary.get("observation") or "unknown"
    repository_fingerprint = repository.get("fingerprint") or "unknown"
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
        "LIFECYCLE": f"schema=1;phase=recovering;pause=none;transition={action_id}",
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
        "HOLD_PAUSE_INDEX",
        "DEFAULT_OBSERVED_SHA",
        "PRIMARY_CHECKOUT",
        "REPOSITORY_SNAPSHOT",
        "PROFILE",
        "STALE_OWNER_PROOF",
    }
    ledger_lines: list[str] = []
    for line in parent_message.splitlines():
        key, separator, _ = line.partition(":")
        if (
            separator
            and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
            and key not in replaced
            and key not in REBUILDABLE_METADATA_HEADERS
        ):
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
            f"generation={recovery_generation};cause={cause};phase=fencing;"
            f"previous_owner={parent_fields['OWNER_ID']}/{old_epoch};"
            "inventory=none;reattached=none;adopted=none;requeued=none;"
            "quarantined=none;unresolved=none"
        ),
        (
            f"PAUSE: id={pause_id or 'legacy-handoff'};state=lifted;reason={cause}-consumed;"
            "confirmation=explicit-skill-invocation;pending_external_action=none"
        ),
        f"STALE_OWNER_PROOF: kind={stop_proof_kind};digest={stop_proof_digest}",
        f"HOLD_PAUSE_INDEX: {_render_hold_pause_index(remaining_holds)}",
        f"DEFAULT_OBSERVED_SHA: {remote_main}",
        (
            f"PRIMARY_CHECKOUT: observation={primary_observation};relation={primary.get('relation') or 'unknown'};"
            f"fingerprint={primary_fingerprint}"
        ),
        (
            "REPOSITORY_SNAPSHOT: "
            f"status={repository.get('observation') or 'unknown'};"
            f"worktrees={repository.get('worktree_count', 'unknown')};"
            f"dirty_worktrees={repository.get('dirty_worktree_count', 'unknown')};"
            f"fingerprint={repository_fingerprint}"
        ),
    ]
    action = {
        "ACTION_SEQ": str(parent_seq + 1),
        "ACTION_ID": action_id,
        "ACTION_KIND": (
            "takeover-owner"
            if cause == "handoff"
            else "reclaim-quiescent-owner"
            if cause == "quiescent-reclaim"
            else "recover-stale-owner"
        ),
        "ACTION_TARGET": f"{CANONICAL_COORDINATOR_REF}@{parent}",
        "EXPECTED_BEFORE": (
            f"owner={parent_fields['OWNER_ID']}/{old_epoch}:{expected_owner_state};"
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
    if preflight.get("route") in {"resume", "recover-owner", "recover-owner-upgrade"} and active and active.get("owner_proof_digest") == runtime_proof:
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
    takeover_kind = (
        "handoff"
        if active and active.get("handoff_takeover_ready")
        else "quiescent-reclaim"
        if active and active.get("quiescent_reclaim_ready")
        else None
    )
    if preflight.get("route") != "takeover" or not active or takeover_kind is None:
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
    remote_main = preflight.get("remote_sha")
    contract_digest = preflight.get("contract_oid")
    if (
        code != 0
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
        preflight.get("repository_snapshot", {}),
        thread_id,
        cause=takeover_kind,
        expected_owner_state=(
            "handoff-ready" if takeover_kind == "handoff" else "active"
        ),
    )
    if errors or message is None or identity is None:
        emit({"schema": 1, "status": "blocked", "reason": "takeover-message-invalid", "errors": errors})
        return 3
    commit = _metadata_commit(repo, parent, message)
    if commit is None:
        emit({"schema": 1, "status": "blocked", "reason": "takeover-commit-failed"})
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


def command_recover_stale_owner(args: argparse.Namespace) -> int:
    """Take ownership only after exact external proof that the old task stopped."""
    repo = Path(args.repo).resolve()
    thread_id, runtime_proof = _runtime_owner_proof()
    if thread_id is None or runtime_proof is None:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-thread-id-unavailable"})
        return 3
    if args.proof_kind not in {"task-terminal", "user-confirmed-stop"}:
        emit({"schema": 1, "status": "invalid", "errors": ["invalid:proof-kind"]})
        return 2
    if LOWER_DIGEST.fullmatch(args.proof_digest) is None:
        emit({"schema": 1, "status": "invalid", "errors": ["invalid:proof-digest"]})
        return 2
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    active = next(
        (
            item
            for item in preflight.get("coordinator_refs", [])
            if item.get("kind") == "canonical" and item.get("classification") == "active"
        ),
        None,
    )
    if preflight_code != 0 or preflight.get("route") != "recovery" or active is None:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "stale-owner-recovery-not-eligible",
                "route": preflight.get("route"),
            }
        )
        return 3
    lifecycle = active.get("lifecycle", {})
    if (
        not lifecycle.get("coherent")
        or lifecycle.get("running_count") != 0
        or lifecycle.get("pending_actions") != "none"
    ):
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "old-owner-not-quiescent-enough-to-fence",
                "lifecycle": lifecycle,
            }
        )
        return 3
    parent = active["sha"]
    fetch = foreign_main.run(
        repo, "fetch", "--no-write-fetch-head", "--no-tags", args.remote, parent
    )
    if fetch.returncode != 0 or not foreign_main.object_exists(repo, parent):
        emit({"schema": 1, "status": "blocked", "reason": "parent-materialization-failed"})
        return 3
    code, parent_message = git(repo, "show", "-s", "--format=%B", parent)
    remote_main = preflight.get("remote_sha")
    contract_digest = preflight.get("contract_oid")
    if (
        code != 0
        or not isinstance(remote_main, str)
        or GIT_OID.fullmatch(remote_main) is None
        or not isinstance(contract_digest, str)
        or GIT_OID.fullmatch(contract_digest) is None
    ):
        emit({"schema": 1, "status": "blocked", "reason": "stale-owner-input-invalid"})
        return 3
    message, identity, errors = _render_takeover_message(
        parent,
        parent_message,
        remote_main,
        contract_digest,
        preflight.get("primary_checkout", {}),
        preflight.get("repository_snapshot", {}),
        thread_id,
        cause="stale-owner-stop",
        expected_owner_state=active.get("owner_state", "active"),
        stop_proof_kind=args.proof_kind,
        stop_proof_digest=args.proof_digest,
    )
    if errors or message is None or identity is None:
        emit({"schema": 1, "status": "blocked", "reason": "stale-owner-message-invalid", "errors": errors})
        return 3
    commit = _metadata_commit(repo, parent, message)
    if commit is None:
        emit({"schema": 1, "status": "blocked", "reason": "stale-owner-commit-failed"})
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
        emit({"schema": 1, "status": "blocked", "reason": "stale-owner-delivery-unverified", "commit": commit})
        return 3
    emit(
        {
            "schema": 1,
            "status": "taken",
            "coordinator": commit,
            "parent": parent,
            "owner_id": identity["owner_id"],
            "epoch": int(identity["epoch"]),
            "proof_kind": args.proof_kind,
            "proof_digest": args.proof_digest,
            "state": "recovering",
            "mutation_scope": "recovery-only",
            "next": "fence-indexed-guards-then-recover",
        }
    )
    return 0


def _metadata_values(message: str, name: str) -> list[str]:
    prefix = f"{name}:"
    return [
        line[len(prefix) :].strip()
        for line in message.splitlines()
        if line.startswith(prefix)
    ]


def _claim_guard_refs(
    repo: Path, message: str, claim_index: str, run_key: str, remote: str
) -> tuple[list[tuple[str, int, str]], list[str]]:
    """Resolve only live claim guards; terminal/history CLAIM_MAP rows are evidence.

    New ledgers carry the complete binding in ``CLAIM_INDEX.active``.  Older
    ledgers list only ``issue:generation`` there and require the matching
    four-part ``CLAIM_MAP`` row.  ``CLAIM_INDEX.entries`` counts terminal and
    quarantined history too, so it must never be compared to the live vector.
    """
    entries: list[tuple[str, int, str]] = []
    errors: list[str] = []
    seen: set[str] = set()
    maps: dict[tuple[str, int], str] = {}
    index = _semicolon_fields(claim_index)
    active_values = _list_value(index.get("active"))
    fallback_keys: set[tuple[str, int]] = set()
    for active_value in active_values:
        active_parts = active_value.split("@")
        identity = active_parts[0].split(":")
        if len(identity) == 2 and len(active_parts) != 4:
            issue, generation_text = identity
            generation = int(generation_text) if generation_text.isdigit() else 0
            fallback_keys.add((issue, generation))
    if fallback_keys:
        for value in _metadata_values(message, "CLAIM_MAP"):
            # Terminal/historical rows are provenance, never fencing authority.
            terminal = re.match(
                rf"^({ISSUE_IDENTIFIER.pattern}):([1-9][0-9]*)=([a-z][a-z0-9-]*)@",
                value,
            )
            if terminal:
                continue
            parts = value.split("@")
            identity = parts[0].split(":")
            if len(parts) != 4 or len(identity) != 2:
                continue
            issue, generation_text = identity
            generation = int(generation_text) if generation_text.isdigit() else 0
            key = (issue, generation)
            if key not in fallback_keys:
                continue
            if key in maps:
                errors.append(f"invalid:duplicate-claim-map:{issue}:{generation}")
            else:
                maps[key] = value

    for active_value in active_values:
        active_parts = active_value.split("@")
        identity = active_parts[0].split(":")
        if len(identity) != 2:
            errors.append("invalid:claim-index-active-shape")
            continue
        issue, generation_text = identity
        generation = int(generation_text) if generation_text.isdigit() else 0
        key = (issue, generation)
        binding = active_value if len(active_parts) == 4 else maps.get(key, "")
        parts = binding.split("@")
        if len(parts) != 4:
            errors.append(f"missing:active-claim-binding:{issue or 'unknown'}:{generation}")
            continue
        remote_prefix = f"{remote}:"
        guard_ref = parts[1][len(remote_prefix) :] if parts[1].startswith(remote_prefix) else ""
        expected = (
            f"refs/heads/codex/release/claims/{run_key}/{issue}/c{generation}"
        )
        if (
            ISSUE_IDENTIFIER.fullmatch(issue) is None
            or generation <= 0
            or guard_ref != expected
            or git(repo, "check-ref-format", guard_ref)[0] != 0
        ):
            errors.append(f"invalid:claim-map-guard:{issue or 'unknown'}")
            continue
        if guard_ref in seen:
            errors.append(f"invalid:duplicate-claim-map-guard:{guard_ref}")
            continue
        seen.add(guard_ref)
        entries.append((issue, generation, guard_ref))
    declared = _positive_count(index.get("entries"))
    if declared is None or declared < len(entries):
        errors.append("invalid:claim-index-entry-count")
    entries.sort(key=lambda item: item[2])
    return entries, errors


def _remote_ref_tips(
    repo: Path, remote: str, refs: list[str]
) -> tuple[dict[str, str], list[str]]:
    if not refs:
        return {}, []
    result = foreign_main.run(repo, "ls-remote", "--heads", remote, *refs)
    if result.returncode != 0:
        return {}, ["remote-guard-advertisement-unavailable"]
    observed: dict[str, str] = {}
    errors: list[str] = []
    requested = set(refs)
    for line in result.stdout.decode("ascii", "replace").splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or parts[1] not in requested or GIT_OID.fullmatch(parts[0]) is None:
            errors.append("invalid:remote-guard-advertisement")
            continue
        if parts[1] in observed:
            errors.append(f"invalid:duplicate-remote-guard:{parts[1]}")
            continue
        observed[parts[1]] = parts[0]
    for ref in refs:
        if ref not in observed:
            errors.append(f"missing:remote-guard:{ref}")
    return observed, errors


def _metadata_tree(repo: Path) -> str | None:
    """Return an empty tree so metadata refs cannot carry runnable workflows."""
    result = foreign_main.run(repo, "mktree")
    tree = result.stdout.decode("ascii", "replace").strip()
    if result.returncode != 0 or GIT_OID.fullmatch(tree) is None:
        return None
    return tree


def _metadata_commit(repo: Path, parent: str, message: str) -> str | None:
    if len(message.encode("utf-8")) > MAX_METADATA_BYTES or "\0" in message:
        return None
    tree = _metadata_tree(repo)
    if tree is None:
        return None
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", prefix="shipctl-metadata-", delete=True
    ) as handle:
        handle.write(message)
        handle.flush()
        result = foreign_main.run(repo, "commit-tree", tree, "-p", parent, "-F", handle.name)
    commit = result.stdout.decode("ascii", "replace").strip()
    if result.returncode != 0 or GIT_OID.fullmatch(commit) is None:
        return None
    if foreign_main.text(repo, "rev-parse", f"{commit}^") != parent:
        return None
    if foreign_main.text(repo, "show", "-s", "--format=%T", commit) != tree:
        return None
    return commit


def command_metadata_commit(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    if GIT_OID.fullmatch(args.parent) is None or not foreign_main.object_exists(repo, args.parent):
        emit({"schema": 1, "status": "invalid", "errors": ["invalid:parent"]})
        return 2
    try:
        message = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
    except OSError as error:
        emit({"schema": 1, "status": "invalid", "errors": [f"input:{type(error).__name__}"]})
        return 2
    message_bytes = len(message.encode("utf-8"))
    if not message.strip() or message_bytes > MAX_METADATA_BYTES or "\0" in message:
        emit({"schema": 1, "status": "invalid", "errors": ["invalid:message"]})
        return 2
    metadata, duplicates = parse_fields(message)
    if duplicates:
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [f"invalid:duplicate-authoritative-header:{name}" for name in duplicates],
            }
        )
        return 2
    expected_kind = "COORDINATOR_CLAIM" if args.kind == "coordinator" else "CLAIM_GUARD"
    if metadata.get("KIND") != expected_kind:
        emit({"schema": 1, "status": "invalid", "errors": [f"invalid:kind:expected-{expected_kind.lower()}"]})
        return 2
    commit = _metadata_commit(repo, args.parent, message)
    if commit is None:
        emit({"schema": 1, "status": "blocked", "reason": "metadata-commit-failed"})
        return 3
    emit(
        {
            "schema": 1,
            "status": "created",
            "commit": commit,
            "parent": args.parent,
            "tree": _metadata_tree(repo),
            "tree_mode": "empty-workflow-free",
            "message_bytes": message_bytes,
            "message_limit": MAX_METADATA_BYTES,
            "compaction_recommended": message_bytes >= 32_768,
        }
    )
    return 0


def _render_coordinator_action(
    parent: str,
    parent_message: str,
    subject: str,
    replacements: dict[str, str],
    action: dict[str, str],
    status: str,
    result: str | None = None,
) -> tuple[str | None, list[str]]:
    parent_fields = fields(parent_message)
    errors, parent_seq, parent_status = _validate_transition_parent(parent_fields)
    if errors:
        return None, errors
    assert parent_seq is not None and parent_status is not None
    if status == "intent":
        if parent_status != "reconciled":
            return None, ["invalid:parent-action-not-reconciled"]
        action = dict(action)
        action["ACTION_SEQ"] = str(parent_seq + 1)
        missing = [name for name in ACTION_HEADERS if name not in action]
    elif status == "reconciled":
        if parent_status not in {"intent", "planned"}:
            return None, ["invalid:parent-action-not-pending"]
        action = {name: parent_fields.get(name, "") for name in ACTION_HEADERS}
        missing = [name for name in ACTION_HEADERS if not action[name]]
    else:
        return None, ["invalid:action-status"]
    if missing:
        return None, [f"missing:{name.lower()}" for name in missing]
    if not UUID_TEXT.fullmatch(action["ACTION_ID"]):
        return None, ["invalid:action-id"]
    replaced = set(replacements) | set(ACTION_HEADERS) | {"ACTION_STATUS", "ACTION_RESULT"}
    ledger_lines: list[str] = []
    for line in parent_message.splitlines():
        key, separator, _ = line.partition(":")
        if (
            separator
            and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
            and key not in replaced
            and key not in REBUILDABLE_METADATA_HEADERS
        ):
            ledger_lines.append(line)
    lines = [subject, "", *ledger_lines]
    lines.extend(f"{name}: {value}" for name, value in replacements.items())
    lines.extend(f"{name}: {action[name]}" for name in ACTION_HEADERS)
    lines.append(f"ACTION_STATUS: {status}")
    if result is not None:
        lines.append(f"ACTION_RESULT: {result}")
    return "\n".join(lines) + "\n", []


def _update_structured(value: str, replacements: dict[str, str]) -> str:
    remaining = dict(replacements)
    output: list[str] = []
    for part in value.split(";"):
        key, separator, _ = part.partition("=")
        normalized = key.strip().lower()
        if separator and normalized in remaining:
            output.append(f"{key.strip()}={remaining.pop(normalized)}")
        elif part.strip():
            output.append(part.strip())
    output.extend(f"{key}={item}" for key, item in remaining.items())
    return ";".join(output)


EXECUTION_STATES = {
    "running",
    "coordinator-paused",
    "feature_ready",
    "failed",
    "needs-input",
    "stopped",
}


def _execution_vector(value: str) -> tuple[dict[tuple[str, int], str], list[str]]:
    """Read both the canonical execution vector and bounded legacy lists."""
    structured = _semicolon_fields(value)
    entries: dict[tuple[str, int], str] = {}
    errors: list[str] = []

    def add(issue: str, generation_text: str, state: str) -> None:
        generation = int(generation_text) if generation_text.isdigit() else 0
        key = (issue, generation)
        normalized = "stopped" if state == "terminal" else state
        if (
            ISSUE_IDENTIFIER.fullmatch(issue) is None
            or generation <= 0
            or normalized not in EXECUTION_STATES
        ):
            errors.append(f"invalid:execution-entry:{issue or 'unknown'}")
        elif key in entries:
            errors.append(f"invalid:duplicate-execution-entry:{issue}:{generation}")
        else:
            entries[key] = normalized

    canonical = structured.get("entries")
    if canonical and not canonical.isdigit():
        for item in _list_value(canonical):
            match = re.fullmatch(
                rf"({ISSUE_IDENTIFIER.pattern}):([1-9][0-9]*)@executor=([a-z][a-z0-9_-]*)",
                item,
            )
            if match is None:
                errors.append("invalid:execution-entry-shape")
            else:
                add(match.group(1), match.group(2), match.group(3))
    else:
        for field, default_state in (
            ("running", "running"),
            ("draining", "running"),
            ("stopped", "stopped"),
            ("feature_ready", "feature_ready"),
            ("failed", "failed"),
            ("needs_input", "needs-input"),
        ):
            for item in _list_value(structured.get(field)):
                match = re.match(
                    rf"^({ISSUE_IDENTIFIER.pattern}):([1-9][0-9]*)(?::([a-z][a-z0-9_-]*))?(?:@.*)?$",
                    item,
                )
                if match is None:
                    errors.append(f"invalid:execution-{field}-shape")
                else:
                    add(match.group(1), match.group(2), match.group(3) or default_state)

    running_count = _positive_count(structured.get("running_count"))
    actual_running = sum(state == "running" for state in entries.values())
    if running_count is None:
        errors.append("invalid:execution-running-count")
    elif running_count != actual_running:
        errors.append("invalid:execution-running-count-mismatch")
    declared_entries = structured.get("entries")
    if declared_entries and declared_entries.isdigit() and int(declared_entries) != len(entries):
        errors.append("invalid:execution-entry-count-mismatch")
    return entries, errors


def _render_execution_vector(entries: dict[tuple[str, int], str], timestamp: str) -> str:
    ordered = [
        f"{issue}:{generation}@executor={entries[(issue, generation)]}"
        for issue, generation in sorted(entries)
    ]
    digest = hashlib.sha256(
        json.dumps(ordered, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    running_count = sum(state == "running" for state in entries.values())
    return (
        f"running_count={running_count};entries={','.join(ordered) if ordered else 'none'};"
        f"digest={digest};transition_at={timestamp}"
    )


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _direct_action_id(parent: str, kind: str, target: str, payload_digest: str) -> str:
    return str(
        uuid.uuid5(
            TRANSITION_NAMESPACE,
            f"direct:{parent}:{kind}:{target}:{payload_digest}",
        )
    )


def _render_direct_coordinator_action(
    parent: str,
    parent_message: str,
    subject: str,
    replacements: dict[str, str],
    kind: str,
    target: str,
    payload_digest: str,
    effect_identity: str,
) -> tuple[str | None, str | None, list[str]]:
    parent_fields = fields(parent_message)
    errors, parent_seq, parent_status = _validate_transition_parent(parent_fields)
    if errors:
        return None, None, errors
    if parent_status != "reconciled":
        return None, None, ["invalid:parent-action-not-reconciled"]
    assert parent_seq is not None
    action_id = _direct_action_id(parent, kind, target, payload_digest)
    action = {
        "ACTION_SEQ": str(parent_seq + 1),
        "ACTION_ID": action_id,
        "ACTION_KIND": kind,
        "ACTION_TARGET": target,
        "EXPECTED_BEFORE": f"coordinator={parent}",
        "EXTERNAL_REQUEST_KEY": "none",
        "PROVIDER_SELECTOR": f"git:origin:{CANONICAL_COORDINATOR_REF}",
        "PAYLOAD_DIGEST": payload_digest,
        "EFFECT_IDENTITY": effect_identity,
    }
    replaced = set(replacements) | set(ACTION_HEADERS) | {"ACTION_STATUS", "ACTION_RESULT"}
    ledger_lines: list[str] = []
    for line in parent_message.splitlines():
        key, separator, _ = line.partition(":")
        if (
            separator
            and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
            and key not in replaced
            and key not in REBUILDABLE_METADATA_HEADERS
        ):
            ledger_lines.append(line)
    lines = [subject, "", *ledger_lines]
    lines.extend(f"{name}: {value}" for name, value in replacements.items())
    lines.extend(f"{name}: {action[name]}" for name in ACTION_HEADERS)
    lines.append("ACTION_STATUS: reconciled")
    return "\n".join(lines) + "\n", action_id, []


def _push_coordinator_cas(
    repo: Path, remote: str, parent: str, message: str
) -> tuple[str, str | None]:
    commit = _metadata_commit(repo, parent, message)
    if commit is None:
        return "commit-failed", None
    push = foreign_main.run(
        repo,
        "push",
        "--porcelain",
        f"--force-with-lease={CANONICAL_COORDINATOR_REF}:{parent}",
        remote,
        f"{commit}:{CANONICAL_COORDINATOR_REF}",
    )
    if push.returncode != 0:
        return "cas-lost", None
    state, advertised = advertised_coordinator_refs(repo, remote)
    observed = next((sha for sha, ref in advertised if ref == CANONICAL_COORDINATOR_REF), None)
    if state != "observed" or observed != commit:
        return "delivery-unverified", commit
    return "pushed", commit


def _active_canonical(preflight: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in preflight.get("coordinator_refs", [])
            if item.get("kind") == "canonical" and item.get("classification") == "active"
        ),
        None,
    )


def _projection_message_base(parent_message: str) -> list[str]:
    replaced = (
        set(ACTION_HEADERS)
        | {
            "ACTION_STATUS",
            "ACTION_RESULT",
            "PROJECTION_BATCH",
            "PROJECTION_ITEM",
            "PROJECTION_RESULT",
        }
    )
    lines: list[str] = []
    for line in parent_message.splitlines():
        key, separator, _ = line.partition(":")
        if (
            separator
            and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
            and key not in replaced
            and key not in REBUILDABLE_METADATA_HEADERS
        ):
            lines.append(line)
    return lines


def command_projection_batch_cas(args: argparse.Namespace) -> int:
    """Persist or reconcile one exact Linear projection batch under owner CAS."""
    repo = Path(args.repo).resolve()
    expected_parent = args.expected_coordinator_sha
    if GIT_OID.fullmatch(expected_parent) is None:
        emit({"schema": 1, "status": "invalid", "errors": ["invalid:expected-coordinator-sha"]})
        return 2
    payload, input_error = _read_json(args.input)
    if input_error or not isinstance(payload, dict):
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [input_error or "invalid:projection-batch:not-object"],
            }
        )
        return 2
    _, runtime_proof = _runtime_owner_proof()
    if runtime_proof is None:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-thread-id-unavailable"})
        return 3
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    active = _active_canonical(preflight)
    if (
        preflight_code != 0
        or active is None
        or active.get("sha") != expected_parent
        or active.get("owner_proof_digest") != runtime_proof
        or active.get("contract_digest") != preflight.get("local_contract_oid")
    ):
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "projection-owner-or-expected-parent-mismatch",
                "route": preflight.get("route"),
                "observed_coordinator": active.get("sha") if active else None,
            }
        )
        return 3
    parent_message, parent_error = _materialize_coordinator_parent(
        repo, args.remote, expected_parent
    )
    if parent_error or parent_message is None:
        emit({"schema": 1, "status": "blocked", "reason": parent_error})
        return 3
    parent_fields = fields(parent_message)
    parent_errors, parent_seq, parent_status = _validate_transition_parent(parent_fields)
    if parent_errors or parent_seq is None or parent_status is None:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "projection-parent-invalid",
                "errors": parent_errors,
            }
        )
        return 3

    if args.phase == "intent":
        if preflight.get("route") != "resume" or parent_status != "reconciled":
            emit(
                {
                    "schema": 1,
                    "status": "blocked",
                    "reason": "projection-intent-requires-reconciled-resume",
                    "route": preflight.get("route"),
                }
            )
            return 3
        durable_items, plan_errors = _validate_projection_plan(payload)
        if plan_errors:
            emit({"schema": 1, "status": "invalid", "errors": plan_errors})
            return 2
        batch_id = payload["batch_id"]
        intent_digest = payload["intent_digest"]
        action_seed = json.dumps(
            {
                "parent": expected_parent,
                "seq": parent_seq + 1,
                "batch_id": batch_id,
                "intent_digest": intent_digest,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        action = {
            "ACTION_SEQ": str(parent_seq + 1),
            "ACTION_ID": str(uuid.uuid5(TRANSITION_NAMESPACE, action_seed)),
            "ACTION_KIND": "projection-batch",
            "ACTION_TARGET": f"linear:projection-batch:{batch_id}",
            "EXPECTED_BEFORE": "projection-batch=none",
            "EXTERNAL_REQUEST_KEY": f"projection-batch:{batch_id}",
            "PROVIDER_SELECTOR": f"linear:projection-batch:{batch_id}",
            "PAYLOAD_DIGEST": intent_digest,
            "EFFECT_IDENTITY": f"projection-batch:{batch_id}@{intent_digest}",
        }
        result_vector = ",".join(
            f"{item['item_id']}:pending" for item in durable_items
        )
        lines = ["ship-linear-release intent projection batch", ""]
        lines.extend(_projection_message_base(parent_message))
        lines.append(
            f"PROJECTION_BATCH: id={batch_id};items={len(durable_items)};"
            f"intent_digest={intent_digest};results={result_vector};status=intent"
        )
        lines.extend(
            "PROJECTION_ITEM: "
            + json.dumps(
                item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            for item in durable_items
        )
        lines.extend(f"{name}: {action[name]}" for name in ACTION_HEADERS)
        lines.append("ACTION_STATUS: intent")
        message = "\n".join(lines) + "\n"
        batch_status = "intent"
        result_digest = None
    else:
        if (
            parent_status not in {"intent", "planned"}
            or parent_fields.get("ACTION_KIND") != "projection-batch"
        ):
            emit(
                {
                    "schema": 1,
                    "status": "blocked",
                    "reason": "projection-reconcile-requires-pending-batch",
                }
            )
            return 3
        batch, batch_duplicates, batch_malformed = _compact_fields(
            parent_fields.get("PROJECTION_BATCH", "")
        )
        stored_items: list[dict[str, str]] = []
        item_errors: list[str] = [
            *[f"duplicate-projection-batch-field:{name}" for name in batch_duplicates],
            *[f"malformed-projection-batch-field:{name}" for name in batch_malformed],
        ]
        if set(batch) != {"id", "items", "intent_digest", "results", "status"}:
            item_errors.append("invalid:projection-batch-fields")
        if (
            LOWER_DIGEST.fullmatch(batch.get("intent_digest", "")) is None
            or batch.get("intent_digest") != parent_fields.get("PAYLOAD_DIGEST")
        ):
            item_errors.append("invalid:projection-batch-intent-digest")
        for value in _metadata_values(parent_message, "PROJECTION_ITEM"):
            try:
                item = json.loads(value)
            except json.JSONDecodeError:
                item_errors.append("invalid:projection-item-json")
                continue
            if not isinstance(item, dict) or not isinstance(item.get("item_id"), str):
                item_errors.append("invalid:projection-item-shape")
            else:
                stored_items.append(item)
        batch_id = payload.get("batch_id")
        source_results = payload.get("results")
        if set(payload) != {"batch_id", "results"}:
            item_errors.append("invalid:projection-results-shape")
        if (
            not isinstance(batch_id, str)
            or UUID_TEXT.fullmatch(batch_id) is None
            or batch.get("id") != batch_id
            or batch.get("status") != "intent"
            or parent_fields.get("ACTION_TARGET") != f"linear:projection-batch:{batch_id}"
        ):
            item_errors.append("invalid:projection-results-batch")
        if not isinstance(source_results, list) or not all(
            isinstance(item, dict) for item in source_results
        ):
            item_errors.append("invalid:projection-results")
            source_results = []
        results: dict[str, dict[str, str]] = {}
        allowed_results = {"applied", "absent", "failed", "ambiguous"}
        for index, item in enumerate(source_results):
            if set(item) != {"item_id", "status", "result"}:
                item_errors.append(f"invalid:results[{index}]:shape")
                continue
            item_id = item.get("item_id")
            status = item.get("status")
            result = item.get("result")
            if (
                not isinstance(item_id, str)
                or UUID_TEXT.fullmatch(item_id) is None
                or status not in allowed_results
                or not _bounded_projection_text(result, maximum=500)
            ):
                item_errors.append(f"invalid:results[{index}]")
            elif item_id in results:
                item_errors.append(f"invalid:duplicate-result:{item_id}")
            else:
                results[item_id] = item
        expected_ids = {item["item_id"] for item in stored_items}
        if set(results) != expected_ids:
            item_errors.append("invalid:projection-result-vector-incomplete")
        if batch.get("items") != str(len(stored_items)):
            item_errors.append("invalid:projection-item-count")
        if item_errors:
            emit(
                {
                    "schema": 1,
                    "status": "invalid",
                    "errors": list(dict.fromkeys(item_errors)),
                }
            )
            return 2
        ordered_results = [results[item_id] for item_id in sorted(results)]
        result_digest = hashlib.sha256(
            json.dumps(
                ordered_results,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        result_vector = ",".join(
            f"{item['item_id']}:{item['status']}" for item in ordered_results
        )
        action_result = (
            f"batch={batch_id};results_digest={result_digest};"
            f"failed={sum(item['status'] == 'failed' for item in ordered_results)};"
            f"ambiguous={sum(item['status'] == 'ambiguous' for item in ordered_results)}"
        )
        lines = ["ship-linear-release reconciled projection batch", ""]
        lines.extend(_projection_message_base(parent_message))
        lines.append(
            f"PROJECTION_BATCH: id={batch_id};items={len(stored_items)};"
            f"intent_digest={batch['intent_digest']};results={result_vector};status=reconciled"
        )
        lines.extend(
            "PROJECTION_ITEM: "
            + json.dumps(
                item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            for item in stored_items
        )
        lines.extend(
            "PROJECTION_RESULT: "
            + json.dumps(
                item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            for item in ordered_results
        )
        lines.extend(f"{name}: {parent_fields[name]}" for name in ACTION_HEADERS)
        lines.append("ACTION_STATUS: reconciled")
        lines.append(f"ACTION_RESULT: {action_result}")
        message = "\n".join(lines) + "\n"
        batch_status = "reconciled"
    delivery, coordinator = _push_coordinator_cas(
        repo, args.remote, expected_parent, message
    )
    if delivery != "pushed":
        emit(
            {
                "schema": 1,
                "status": delivery,
                "expected_coordinator": expected_parent,
                "candidate": coordinator,
                "batch_id": batch_id,
            }
        )
        return 4 if delivery == "cas-lost" else 3
    emit(
        {
            "schema": 1,
            "status": batch_status,
            "batch_id": batch_id,
            "parent": expected_parent,
            "coordinator": coordinator,
            "item_count": len(durable_items) if args.phase == "intent" else len(stored_items),
            "result_digest": result_digest,
            "next": (
                "execute-items-with-item-idempotency"
                if args.phase == "intent"
                else "continue-conveyor-or-triage-terminal-item-results"
            ),
        }
    )
    return 0


def _materialize_coordinator_parent(
    repo: Path, remote: str, parent: str
) -> tuple[str | None, str | None]:
    fetch = foreign_main.run(
        repo,
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        remote,
        parent,
    )
    if fetch.returncode != 0 or not foreign_main.object_exists(repo, parent):
        return None, "parent-materialization-failed"
    code, message = git(repo, "show", "-s", "--format=%B", parent)
    return (message, None) if code == 0 else (None, "parent-message-unavailable")


def _soft_pause_payload(args: argparse.Namespace) -> tuple[dict[str, Any] | None, str | None]:
    payload, error = _read_json(args.input)
    if error:
        return None, error
    if not isinstance(payload, dict):
        return None, "invalid:soft-pause:not-object"
    return payload, None


def command_soft_pause(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    _, runtime_proof = _runtime_owner_proof()
    if runtime_proof is None:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-thread-id-unavailable"})
        return 3
    payload, input_error = _soft_pause_payload(args)
    if input_error or payload is None:
        emit({"schema": 1, "status": "invalid", "errors": [input_error]})
        return 2
    allowed = {
        "start": {"evidence_digest"},
        "checkpoint": {"dispositions"},
        "finish": {"settlement", "evidence_digest"},
    }[args.phase]
    unexpected = sorted(set(payload) - allowed)
    missing = sorted(allowed - set(payload))
    if unexpected or missing:
        emit(
            {
                "schema": 1,
                "status": "invalid",
                "errors": [*[f"missing:{name}" for name in missing], *[f"unexpected:{name}" for name in unexpected]],
            }
        )
        return 2

    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    active = _active_canonical(preflight)
    route = preflight.get("route")
    if args.phase == "finish" and route == "takeover" and active:
        emit(
            {
                "schema": 1,
                "status": "already-finished",
                "coordinator": active["sha"],
                "lifecycle": active["lifecycle"],
                "next": "return-control;fresh-explicit-invocation-will-take-over",
            }
        )
        return 0
    if preflight_code != 0 or active is None:
        emit({"schema": 1, "status": "blocked", "reason": "preflight-blocked", "preflight": preflight})
        return 3
    if active.get("owner_proof_digest") != runtime_proof:
        emit({"schema": 1, "status": "blocked", "reason": "owner-proof-mismatch"})
        return 3
    lifecycle = active["lifecycle"]
    parent = active["sha"]
    parent_message, parent_error = _materialize_coordinator_parent(
        repo, args.remote, parent
    )
    if parent_error or parent_message is None:
        emit({"schema": 1, "status": "blocked", "reason": parent_error})
        return 3
    metadata = fields(parent_message)
    if args.phase == "start" and route == "drain-owner":
        evidence = payload.get("evidence_digest")
        current_pause = metadata.get("PAUSE", "")
        if _semicolon_fields(current_pause).get("evidence") == evidence:
            emit(
                {
                    "schema": 1,
                    "status": "already-started",
                    "coordinator": parent,
                    "lifecycle": lifecycle,
                    "next": "soft-stop-running-workers",
                }
            )
            return 0
    start_operating_phases = {
        "running",
        "validating",
        "offline-queue",
        "publishing",
        "deploying",
        "stabilizing",
    }
    recovery_phase = _semicolon_fields(metadata.get("RECOVERY", "")).get("phase")
    recovered_owner_eligible = (
        route == "recover-owner"
        and lifecycle.get("coherent") is True
        and lifecycle.get("phase") == "recovering"
        and lifecycle.get("pending_actions") == "none"
        and active.get("action_status") == "reconciled"
        and recovery_phase in {"inventory", "complete"}
    )
    start_eligible = route == "resume" or recovered_owner_eligible or (
        route == "recovery"
        and lifecycle.get("coherent") is True
        and lifecycle.get("phase") in start_operating_phases
        and active.get("contract_digest") == preflight.get("local_contract_oid")
    )
    phase_eligible = start_eligible if args.phase == "start" else route == "drain-owner"
    if not phase_eligible:
        emit({"schema": 1, "status": "blocked", "reason": "soft-pause-phase-not-eligible", "route": route})
        return 3

    timestamp = _utc_timestamp()
    target = f"run:{metadata.get('RUN_ID', 'unknown')}:soft-pause"
    replacements: dict[str, str]
    effect_identity: str

    if args.phase == "start":
        evidence = payload.get("evidence_digest")
        if not isinstance(evidence, str) or LOWER_DIGEST.fullmatch(evidence) is None:
            emit({"schema": 1, "status": "invalid", "errors": ["invalid:evidence_digest"]})
            return 2
        execution, execution_errors = _execution_vector(metadata.get("EXECUTION_INDEX", ""))
        running = sorted(key for key, state in execution.items() if state == "running")
        active_lanes = _list_value(_semicolon_fields(metadata.get("WORKERS", "")).get("active_issue_lanes"))
        if execution_errors or len(active_lanes) != len(running):
            emit({"schema": 1, "status": "blocked", "reason": "execution-vector-incoherent", "errors": execution_errors})
            return 3
        payload_digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        pause_uuid = str(uuid.uuid5(TRANSITION_NAMESPACE, f"pause:{parent}:{evidence}"))
        pause_id = f"pause-{pause_uuid}"
        target = f"run:{metadata['RUN_ID']}:{pause_id}"
        action_id = _direct_action_id(parent, "start-soft-pause", target, payload_digest)
        scope = "dispatch,new-work,new-claims,new-cutoffs"
        pause_entry = f"{pause_id}:PAUSE@{scope}"
        index_entries = _hold_pause_entries(_pause_index_value(metadata))
        index_entries.append(pause_entry)
        start_phase = "draining" if running else "settling"
        replacements = {
            "STATE": "pausing",
            "OWNER_STATE": "active",
            "LIFECYCLE": f"schema=1;phase={start_phase};pause={pause_id};transition={action_id}",
            "PAUSE": (
                f"id={pause_id};state=active;kind=PAUSE;scope={scope};"
                f"reason=user-requested-soft-stop;evidence={evidence};"
                f"resume_predicate=fresh-explicit-user-launch-after-{pause_uuid};"
                f"confirmation_required=yes;after={action_id};created_at={timestamp}"
            ),
            "HOLD_PAUSE_INDEX": _render_hold_pause_index(index_entries),
            "WORKERS": _update_structured(
                metadata.get("WORKERS", ""),
                {"active_target": "0", "refill_blocker": "user-pause"},
            ),
            "PENDING_ACTIONS": "none",
        }
        effect_identity = f"pause={pause_id};phase={start_phase};running={len(running)}"
        next_step = (
            "soft-stop-running-workers-at-bounded-checkpoints"
            if running
            else "settle-already-active-or-ready-work-then-finish"
        )
    elif args.phase == "checkpoint":
        if lifecycle.get("phase") == "settling":
            emit({"schema": 1, "status": "already-checkpointed", "coordinator": parent, "lifecycle": lifecycle, "next": "settle-ready-work-then-finish"})
            return 0
        if lifecycle.get("phase") != "draining":
            emit({"schema": 1, "status": "blocked", "reason": "not-draining"})
            return 3
        dispositions = payload.get("dispositions")
        if not isinstance(dispositions, list):
            emit({"schema": 1, "status": "invalid", "errors": ["invalid:dispositions"]})
            return 2
        execution, execution_errors = _execution_vector(metadata.get("EXECUTION_INDEX", ""))
        running_keys = {key for key, state in execution.items() if state == "running"}
        parsed: dict[tuple[str, int], dict[str, str]] = {}
        disposition_errors: list[str] = []
        for item in dispositions:
            if not isinstance(item, dict) or set(item) != {"issue", "generation", "state", "head", "evidence_digest"}:
                disposition_errors.append("invalid:disposition-shape")
                continue
            issue = item.get("issue")
            generation = item.get("generation")
            state = item.get("state")
            head = item.get("head")
            evidence = item.get("evidence_digest")
            key = (issue, generation)
            if (
                not isinstance(issue, str)
                or ISSUE_IDENTIFIER.fullmatch(issue) is None
                or not isinstance(generation, int)
                or isinstance(generation, bool)
                or generation <= 0
                or state not in EXECUTION_STATES - {"running"}
                or not isinstance(head, str)
                or (head != "none" and GIT_OID.fullmatch(head) is None)
                or (state == "feature_ready" and head == "none")
                or not isinstance(evidence, str)
                or LOWER_DIGEST.fullmatch(evidence) is None
            ):
                disposition_errors.append(f"invalid:disposition:{issue or 'unknown'}")
            elif key in parsed:
                disposition_errors.append(f"invalid:duplicate-disposition:{issue}:{generation}")
            else:
                parsed[key] = {"state": state, "head": head, "evidence": evidence}
        if execution_errors or disposition_errors or set(parsed) != running_keys:
            emit(
                {
                    "schema": 1,
                    "status": "blocked",
                    "reason": "checkpoint-vector-incomplete-or-invalid",
                    "errors": [*execution_errors, *disposition_errors],
                    "expected": [f"{issue}:{generation}" for issue, generation in sorted(running_keys)],
                    "received": [f"{issue}:{generation}" for issue, generation in sorted(parsed)],
                }
            )
            return 3
        for key, item in parsed.items():
            execution[key] = item["state"]
        checkpoint_rows = [
            f"{issue}:{generation}@state={parsed[(issue, generation)]['state']}"
            f"@head={parsed[(issue, generation)]['head']}"
            f"@evidence={parsed[(issue, generation)]['evidence']}"
            for issue, generation in sorted(parsed)
        ]
        payload_digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        pause_id = lifecycle.get("pause_id")
        target = f"run:{metadata['RUN_ID']}:{pause_id}"
        action_id = _direct_action_id(parent, "checkpoint-soft-pause", target, payload_digest)
        stopped = [issue for (issue, _), state in sorted(execution.items()) if state in {"coordinator-paused", "failed", "needs-input", "stopped"}]
        ready = [issue for (issue, _), state in sorted(execution.items()) if state == "feature_ready"]
        replacements = {
            "STATE": "pausing",
            "OWNER_STATE": "active",
            "LIFECYCLE": f"schema=1;phase=settling;pause={pause_id};transition={action_id}",
            "EXECUTION_INDEX": _render_execution_vector(execution, timestamp),
            "CHECKPOINTS": (
                f"entries={','.join(checkpoint_rows) if checkpoint_rows else 'none'};"
                f"digest={hashlib.sha256(json.dumps(checkpoint_rows, separators=(',', ':')).encode()).hexdigest()}"
            ),
            "WORKERS": _update_structured(
                metadata.get("WORKERS", ""),
                {
                    "active_target": "0",
                    "active_issue_lanes": "none",
                    "stopped": ",".join(sorted(set(stopped))) or "none",
                    "ready_preserved": ",".join(sorted(set(ready))) or "none",
                    "refill_blocker": "user-pause",
                },
            ),
            "PENDING_ACTIONS": "none",
        }
        effect_identity = f"pause={pause_id};phase=settling;running=0"
        next_step = "settle-already-ready-work-without-new-dispatch-then-finish"
    else:
        settlement = payload.get("settlement")
        evidence = payload.get("evidence_digest")
        if settlement not in {"complete", "preserved-blocked"}:
            emit({"schema": 1, "status": "invalid", "errors": ["invalid:settlement"]})
            return 2
        if not isinstance(evidence, str) or LOWER_DIGEST.fullmatch(evidence) is None:
            emit({"schema": 1, "status": "invalid", "errors": ["invalid:evidence_digest"]})
            return 2
        if lifecycle.get("phase") != "settling" or lifecycle.get("running_count") != 0:
            emit({"schema": 1, "status": "blocked", "reason": "pause-not-quiescent"})
            return 3
        pipeline = _semicolon_fields(metadata.get("PIPELINE", ""))
        gate_index = _semicolon_fields(metadata.get("GATE_INDEX", ""))
        active_cutoff = pipeline.get("active_cutoff", "none")
        active_gate = gate_index.get("active", "none")
        terminal_pipeline, terminal_pipeline_errors = _terminal_pipeline(metadata)
        execution, execution_errors = _execution_vector(
            metadata.get("EXECUTION_INDEX", "")
        )
        if execution_errors:
            emit(
                {
                    "schema": 1,
                    "status": "blocked",
                    "reason": "execution-vector-incoherent",
                    "errors": execution_errors,
                }
            )
            return 3
        ready_preserved = sorted(
            issue
            for (issue, _), state in execution.items()
            if state == "feature_ready"
        )
        open_cutoff = pipeline.get("open_cutoff", "none")
        blockers_present = bool(
            metadata.get("PROMOTION_HOLD", "").strip().lower() not in {"", "none"}
            or metadata.get("HOLD", "").strip().lower() not in {"", "none"}
            or _semicolon_fields(metadata.get("HEALTH", "")).get("default") in {"known-bad", "drifted", "stabilizing"}
        )
        if not terminal_pipeline:
            emit({"schema": 1, "status": "blocked", "reason": "settlement-still-active", "active_cutoff": active_cutoff, "active_gate": active_gate, "errors": terminal_pipeline_errors})
            return 3
        if settlement == "complete" and (ready_preserved or open_cutoff != "none"):
            emit({"schema": 1, "status": "blocked", "reason": "ready-work-not-settled"})
            return 3
        if settlement == "preserved-blocked" and not blockers_present:
            emit({"schema": 1, "status": "blocked", "reason": "preserved-ready-work-without-durable-blocker"})
            return 3
        payload_digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        pause_id = lifecycle.get("pause_id")
        target = f"run:{metadata['RUN_ID']}:{pause_id}"
        action_id = _direct_action_id(parent, "finish-soft-pause", target, payload_digest)
        pause = _update_structured(
            metadata.get("PAUSE", ""),
            {"scope": "all-shared", "drained_at": timestamp, "settlement": settlement, "settlement_evidence": evidence},
        )
        old_pause_prefix = f"{pause_id}:pause@"
        index_entries = [
            item
            for item in _hold_pause_entries(_pause_index_value(metadata))
            if not item.lower().startswith(old_pause_prefix)
        ]
        index_entries.append(f"{pause_id}:PAUSE@all-shared")
        replacements = {
            "STATE": "checkpoint",
            "OWNER_STATE": "handoff-ready",
            "LIFECYCLE": f"schema=1;phase=quiescent;pause={pause_id};transition={action_id}",
            "PAUSE": pause,
            "HOLD_PAUSE_INDEX": _render_hold_pause_index(index_entries),
            "WORKERS": _update_structured(
                metadata.get("WORKERS", ""),
                {"active_target": "0", "active_issue_lanes": "none", "refill_blocker": "user-pause"},
            ),
            "PENDING_ACTIONS": "none",
            "PIPELINE": _update_structured(
                metadata.get("PIPELINE", ""),
                {"open_cutoff": "none", "active_cutoff": "none", "cutoff_ref": "none"},
            ),
            "ACTIVE_CUTOFF": "none",
        }
        effect_identity = f"pause={pause_id};phase=quiescent;settlement={settlement}"
        next_step = "return-control;fresh-explicit-invocation-will-take-over"

    message, action_id, render_errors = _render_direct_coordinator_action(
        parent,
        parent_message,
        f"ship-linear-release reconciled {args.phase} soft pause",
        replacements,
        f"{args.phase}-soft-pause",
        target,
        payload_digest,
        effect_identity,
    )
    if render_errors or message is None or action_id is None:
        emit({"schema": 1, "status": "blocked", "reason": "soft-pause-render-invalid", "errors": render_errors})
        return 3
    push_status, commit = _push_coordinator_cas(repo, args.remote, parent, message)
    if push_status != "pushed" or commit is None:
        code = 4 if push_status == "cas-lost" else 3
        emit({"schema": 1, "status": push_status, "reason": "soft-pause-cas-not-confirmed", "expected": parent})
        return code
    result_message = git(repo, "show", "-s", "--format=%B", commit)[1]
    result_lifecycle = _coordinator_lifecycle(fields(result_message))
    if not result_lifecycle["coherent"]:
        emit({"schema": 1, "status": "blocked", "reason": "written-lifecycle-incoherent", "errors": result_lifecycle["errors"]})
        return 3
    emit(
        {
            "schema": 1,
            "status": "handoff-ready" if args.phase == "finish" else result_lifecycle["phase"],
            "coordinator": commit,
            "parent": parent,
            "action_id": action_id,
            "lifecycle": result_lifecycle,
            "next": next_step,
        }
    )
    return 0


def _guard_metadata(message: str) -> dict[str, str]:
    parsed = fields(message)

    def colon_value(name: str, pattern: str) -> str | None:
        direct = parsed.get(name, "")
        if re.fullmatch(pattern, direct):
            return direct
        match = re.search(
            rf"(?:^|;\s*){re.escape(name)}:\s*({pattern})(?=;|$)",
            message,
            re.MULTILINE,
        )
        return match.group(1) if match else None

    normalized: dict[str, str] = {}
    scalar_patterns = {
        "SCHEMA": r"[1-9][0-9]*",
        "KIND": r"[A-Z][A-Z0-9_]*",
        "STATE": r"[a-z][a-z0-9-]*",
        "RUN_ID": UUID_TEXT.pattern,
        "RUN_KEY": r"[0-9a-f]{32}",
        "ISSUE": ISSUE_IDENTIFIER.pattern,
        "CLAIM_TOKEN_DIGEST": LOWER_DIGEST.pattern,
        "FEATURE_REF": r"refs/heads/[^;\s]+",
        "FEATURE_EXPECTED_OLD": r"[^;\s]+",
        "FEATURE_HEAD": GIT_OID.pattern,
        "CHECKS_DIGEST": LOWER_DIGEST.pattern,
        "PREVIOUS_GUARD": rf"(?:{GIT_OID.pattern}|zero|none)",
        "UPDATED_BY": r"[^;\r\n]+",
        "TERMINAL_REASON": r"[^;\r\n]+",
        "TERMINAL_EVIDENCE": r"[^;\r\n]+",
    }
    for name, pattern in scalar_patterns.items():
        value = colon_value(name, pattern)
        if value is not None:
            normalized[name] = value

    owner = re.search(
        rf"(?:^|;\s*)OWNER:\s*id=({UUID_TEXT.pattern});\s*epoch=([1-9][0-9]*)(?=;|$)",
        message,
        re.MULTILINE,
    )
    owner_id = colon_value("OWNER_ID", UUID_TEXT.pattern)
    owner_epoch = colon_value("OWNER_EPOCH", r"[1-9][0-9]*")
    if owner_id is not None:
        normalized["OWNER_ID"] = owner_id
    elif owner:
        normalized["OWNER_ID"] = owner.group(1)
    if owner_epoch is not None:
        normalized["OWNER_EPOCH"] = owner_epoch
    elif owner:
        normalized["OWNER_EPOCH"] = owner.group(2)

    claim = re.search(
        rf"(?:^|;\s*)CLAIM:\s*generation=([1-9][0-9]*);\s*token_digest=({LOWER_DIGEST.pattern})(?=;|$)",
        message,
        re.MULTILINE,
    )
    generation = colon_value("CLAIM_GENERATION", r"[1-9][0-9]*")
    if generation is not None:
        normalized["CLAIM_GENERATION"] = generation
    elif claim:
        normalized["CLAIM_GENERATION"] = claim.group(1)
    if "CLAIM_TOKEN_DIGEST" not in normalized and claim:
        normalized["CLAIM_TOKEN_DIGEST"] = claim.group(2)

    feature = re.search(
        rf"(?:^|;\s*)FEATURE:\s*ref=(refs/heads/[^;\s]+);\s*"
        rf"expected_old=([^;\s]+);\s*head=({GIT_OID.pattern})(?=;|$)",
        message,
        re.MULTILINE,
    )
    if feature:
        normalized.setdefault("FEATURE_REF", feature.group(1))
        normalized.setdefault("FEATURE_EXPECTED_OLD", feature.group(2))
        normalized.setdefault("FEATURE_HEAD", feature.group(3))
    return normalized


def _render_guard_fence_message(
    parent_message: str,
    issue: str,
    generation: int,
    old_tip: str,
    owner_id: str,
    owner_epoch: str,
    coordinator_intent: str,
) -> tuple[str | None, list[str]]:
    metadata = _guard_metadata(parent_message)
    if metadata.get("KIND") != "CLAIM_GUARD":
        return None, [f"invalid:guard-kind:{issue}"]
    if metadata.get("ISSUE") != issue or metadata.get("CLAIM_GENERATION") != str(generation):
        return None, [f"invalid:guard-identity:{issue}"]
    replacements = {
        "STATE": "fenced",
        "OWNER_ID": owner_id,
        "OWNER_EPOCH": owner_epoch,
        "PREVIOUS_GUARD": old_tip,
        "UPDATED_BY": "coordinator-recovery",
        "FENCED_BY": f"owner={owner_id};epoch={owner_epoch};coordinator={coordinator_intent}",
        "FENCE_REASON": "takeover-recovery",
    }
    semantic_keys = {
        "SCHEMA",
        "KIND",
        "STATE",
        "RUN_ID",
        "RUN_KEY",
        "ISSUE",
        "OWNER",
        "OWNER_ID",
        "OWNER_EPOCH",
        "CLAIM",
        "CLAIM_GENERATION",
        "CLAIM_TOKEN_DIGEST",
        "FEATURE",
        "FEATURE_REF",
        "FEATURE_EXPECTED_OLD",
        "FEATURE_HEAD",
        "CHECKS_DIGEST",
        "PREVIOUS_GUARD",
        "UPDATED_BY",
        "TERMINAL_REASON",
        "TERMINAL_EVIDENCE",
        "FENCED_BY",
        "FENCE_REASON",
    }
    normalized = dict(metadata)
    normalized.update(replacements)
    lines = [f"ship-linear-release {issue} fenced by recovery", ""]
    for line in parent_message.splitlines():
        key, separator, _ = line.partition(":")
        if separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in semantic_keys:
            lines.append(line)
    for name in (
        "SCHEMA",
        "KIND",
        "STATE",
        "RUN_ID",
        "RUN_KEY",
        "ISSUE",
        "OWNER_ID",
        "OWNER_EPOCH",
        "CLAIM_GENERATION",
        "CLAIM_TOKEN_DIGEST",
        "FEATURE_REF",
        "FEATURE_EXPECTED_OLD",
        "FEATURE_HEAD",
        "CHECKS_DIGEST",
        "PREVIOUS_GUARD",
        "UPDATED_BY",
        "TERMINAL_REASON",
        "TERMINAL_EVIDENCE",
        "FENCED_BY",
        "FENCE_REASON",
    ):
        if name in normalized:
            lines.append(f"{name}: {normalized[name]}")
    return "\n".join(lines) + "\n", []


def _materialize_exact(repo: Path, remote: str, shas: list[str]) -> bool:
    if not shas:
        return True
    result = foreign_main.run(
        repo,
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        remote,
        *list(dict.fromkeys(shas)),
    )
    return result.returncode == 0 and all(foreign_main.object_exists(repo, sha) for sha in shas)


def command_fence_guards(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    _, runtime_proof = _runtime_owner_proof()
    if runtime_proof is None:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-thread-id-unavailable"})
        return 3
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    if preflight_code != 0 or preflight.get("route") not in {
        "recover-owner",
        "recover-owner-upgrade",
    }:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "guard-fencing-not-eligible",
                "preflight": preflight,
            }
        )
        return 3
    active = next(
        (
            item
            for item in preflight.get("coordinator_refs", [])
            if item.get("kind") == "canonical" and item.get("classification") == "active"
        ),
        None,
    )
    if active is None or active.get("owner_proof_digest") != runtime_proof:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-owner-proof-mismatch"})
        return 3
    coordinator = active["sha"]
    if not _materialize_exact(repo, args.remote, [coordinator]):
        emit({"schema": 1, "status": "blocked", "reason": "coordinator-materialization-failed"})
        return 3
    code, coordinator_message = git(repo, "show", "-s", "--format=%B", coordinator)
    if code != 0:
        emit({"schema": 1, "status": "blocked", "reason": "coordinator-message-unavailable"})
        return 3
    coordinator_fields = fields(coordinator_message)
    run_key = coordinator_fields.get("RUN_KEY", "")
    run_id = coordinator_fields.get("RUN_ID", "")
    owner_id = coordinator_fields.get("OWNER_ID", "")
    owner_epoch = coordinator_fields.get("EPOCH", "")
    recovery = coordinator_fields.get("RECOVERY", "")
    if (
        re.fullmatch(r"[0-9a-f]{32}", run_key) is None
        or UUID_TEXT.fullmatch(run_id) is None
        or UUID_TEXT.fullmatch(owner_id) is None
        or not owner_epoch.isdigit()
        or int(owner_epoch) <= 0
        or not recovery
    ):
        emit({"schema": 1, "status": "blocked", "reason": "coordinator-recovery-identity-invalid"})
        return 3
    claim_index = coordinator_fields.get("CLAIM_INDEX", "")
    guard_entries, entry_errors = _claim_guard_refs(
        repo, coordinator_message, claim_index, run_key, args.remote
    )
    claim_count = _semicolon_fields(claim_index).get("entries")
    if entry_errors:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "claim-guard-index-invalid",
                "errors": entry_errors,
                "claim_count": claim_count,
                "guard_count": len(guard_entries),
            }
        )
        return 3
    action_kind = coordinator_fields.get("ACTION_KIND", "")
    action_status = coordinator_fields.get("ACTION_STATUS", "").lower()
    recovery_phase = _structured_token(recovery, "phase")
    contract_replacements: dict[str, str] = {}
    if preflight.get("route") == "recover-owner-upgrade":
        remote_sha = preflight.get("remote_sha")
        contract_oid = preflight.get("contract_oid")
        old_source = coordinator_fields.get("CONTRACT_SOURCE_SHA", "unknown")
        old_digest = coordinator_fields.get("CONTRACT_DIGEST", "unknown")
        if (
            not isinstance(remote_sha, str)
            or GIT_OID.fullmatch(remote_sha) is None
            or not isinstance(contract_oid, str)
            or GIT_OID.fullmatch(contract_oid) is None
        ):
            emit({"schema": 1, "status": "blocked", "reason": "contract-upgrade-target-invalid"})
            return 3
        contract_replacements = {
            "CONTRACT_SOURCE_SHA": remote_sha,
            "CONTRACT_DIGEST": contract_oid,
            "CONTRACT_MIGRATED_FROM": f"source={old_source};digest={old_digest}",
        }
    if action_kind == "fence-guards" and action_status == "reconciled" and recovery_phase != "fencing":
        tips, tip_errors = _remote_ref_tips(repo, args.remote, [item[2] for item in guard_entries])
        if tip_errors or not _materialize_exact(repo, args.remote, list(tips.values())):
            emit({"schema": 1, "status": "blocked", "reason": "fenced-guard-verification-failed", "errors": tip_errors})
            return 3
        invalid = []
        for issue, generation, ref in guard_entries:
            message_code, message = git(repo, "show", "-s", "--format=%B", tips[ref])
            metadata = _guard_metadata(message) if message_code == 0 else {}
            if (
                metadata.get("STATE") != "fenced"
                or metadata.get("ISSUE") != issue
                or metadata.get("CLAIM_GENERATION") != str(generation)
                or metadata.get("RUN_ID") != run_id
                or metadata.get("OWNER_ID") != owner_id
                or metadata.get("OWNER_EPOCH") != owner_epoch
            ):
                invalid.append(ref)
        if invalid:
            emit({"schema": 1, "status": "blocked", "reason": "fenced-guard-drift", "refs": invalid})
            return 3
        emit(
            {
                "schema": 1,
                "status": "already-fenced",
                "coordinator": coordinator,
                "guard_count": len(guard_entries),
                "next": "inventory-and-adopt",
            }
        )
        return 0
    if action_status in {"intent", "planned"}:
        if action_kind != "fence-guards":
            emit({"schema": 1, "status": "blocked", "reason": "different-action-pending"})
            return 3
        intent = coordinator
    else:
        if action_status != "reconciled" or recovery_phase != "fencing":
            emit({"schema": 1, "status": "blocked", "reason": "guard-fencing-phase-invalid"})
            return 3
        before, before_errors = _remote_ref_tips(
            repo, args.remote, [item[2] for item in guard_entries]
        )
        if before_errors:
            emit({"schema": 1, "status": "blocked", "reason": "guard-vector-unavailable", "errors": before_errors})
            return 3
        vector = ",".join(f"{ref}@{before[ref]}" for _, _, ref in guard_entries) or "none"
        vector_digest = hashlib.sha256(vector.encode()).hexdigest()
        action_id = str(uuid.uuid5(TRANSITION_NAMESPACE, f"fence-guards:{coordinator}:{vector_digest}"))
        action = {
            "ACTION_ID": action_id,
            "ACTION_KIND": "fence-guards",
            "ACTION_TARGET": f"refs/heads/codex/release/claims/{run_key}/*",
            "EXPECTED_BEFORE": f"vector-sha256={vector_digest};count={len(guard_entries)}",
            "EXTERNAL_REQUEST_KEY": "none",
            "PROVIDER_SELECTOR": f"git:{args.remote}:guard-namespace:{run_key}",
            "PAYLOAD_DIGEST": vector_digest,
            "EFFECT_IDENTITY": f"fenced-owner={owner_id};epoch={owner_epoch};count={len(guard_entries)}",
        }
        intent_replacements = {"FENCE_VECTOR": vector, **contract_replacements}
        intent_message, render_errors = _render_coordinator_action(
            coordinator,
            coordinator_message,
            "ship-linear-release intent fence indexed guards",
            intent_replacements,
            action,
            "intent",
        )
        if render_errors or intent_message is None:
            emit({"schema": 1, "status": "blocked", "reason": "fence-intent-invalid", "errors": render_errors})
            return 3
        intent = _metadata_commit(repo, coordinator, intent_message)
        if intent is None:
            emit({"schema": 1, "status": "blocked", "reason": "fence-intent-commit-failed"})
            return 3
        push = foreign_main.run(
            repo,
            "push",
            "--porcelain",
            f"--force-with-lease={CANONICAL_COORDINATOR_REF}:{coordinator}",
            args.remote,
            f"{intent}:{CANONICAL_COORDINATOR_REF}",
        )
        if push.returncode != 0:
            emit({"schema": 1, "status": "cas-lost", "reason": "coordinator-ref-changed", "expected": coordinator})
            return 4
        coordinator_message = intent_message
        coordinator_fields = fields(intent_message)

    current, current_errors = _remote_ref_tips(
        repo, args.remote, [item[2] for item in guard_entries]
    )
    if current_errors or not _materialize_exact(repo, args.remote, list(current.values())):
        emit({"schema": 1, "status": "blocked", "reason": "guard-materialization-failed", "errors": current_errors})
        return 3
    updates: list[tuple[str, str, str]] = []
    final_tips: dict[str, str] = {}
    for issue, generation, ref in guard_entries:
        old_tip = current[ref]
        message_code, guard_message = git(repo, "show", "-s", "--format=%B", old_tip)
        guard_fields = _guard_metadata(guard_message) if message_code == 0 else {}
        fenced_by = guard_fields.get("FENCED_BY", "")
        exact_fence = (
            guard_fields.get("STATE") == "fenced"
            and guard_fields.get("OWNER_ID") == owner_id
            and guard_fields.get("OWNER_EPOCH") == owner_epoch
            and _structured_token(fenced_by, "coordinator") == intent
        )
        if exact_fence:
            final_tips[ref] = old_tip
            continue
        if (
            message_code != 0
            or guard_fields.get("RUN_ID") != run_id
            or guard_fields.get("RUN_KEY") != run_key
        ):
            emit({"schema": 1, "status": "blocked", "reason": "guard-run-identity-invalid", "ref": ref})
            return 3
        fence_message, fence_errors = _render_guard_fence_message(
            guard_message, issue, generation, old_tip, owner_id, owner_epoch, intent
        )
        if fence_errors or fence_message is None:
            emit({"schema": 1, "status": "blocked", "reason": "guard-fence-message-invalid", "ref": ref, "errors": fence_errors})
            return 3
        new_tip = _metadata_commit(repo, old_tip, fence_message)
        if new_tip is None:
            emit({"schema": 1, "status": "blocked", "reason": "guard-fence-commit-failed", "ref": ref})
            return 3
        updates.append((ref, old_tip, new_tip))
        final_tips[ref] = new_tip
    if updates:
        leases = [f"--force-with-lease={ref}:{old}" for ref, old, _ in updates]
        refspecs = [f"{new}:{ref}" for ref, _, new in updates]
        push = foreign_main.run(repo, "push", "--porcelain", "--atomic", *leases, args.remote, *refspecs)
        if push.returncode != 0:
            emit({"schema": 1, "status": "cas-lost", "reason": "guard-ref-changed", "expected_count": len(updates)})
            return 4
    observed, observed_errors = _remote_ref_tips(
        repo, args.remote, [item[2] for item in guard_entries]
    )
    if observed_errors or observed != final_tips:
        emit({"schema": 1, "status": "blocked", "reason": "guard-fence-delivery-unverified", "errors": observed_errors})
        return 3
    live_guards = ";".join(
        f"{issue}/c{generation}={observed[ref]}:fenced"
        for issue, generation, ref in guard_entries
    ) or "none"
    result_digest = hashlib.sha256(live_guards.encode()).hexdigest()
    reconciled_recovery = _update_structured(
        coordinator_fields["RECOVERY"],
        {"phase": "inventory", "inventory": result_digest, "unresolved": "none"},
    )
    reconcile_message, reconcile_errors = _render_coordinator_action(
        intent,
        coordinator_message,
        "ship-linear-release reconciled fence indexed guards",
        {
            "RECOVERY": reconciled_recovery,
            "LIVE_GUARDS": live_guards,
            **contract_replacements,
        },
        {},
        "reconciled",
        f"fenced={len(guard_entries)};vector-sha256={result_digest}",
    )
    if reconcile_errors or reconcile_message is None:
        emit({"schema": 1, "status": "blocked", "reason": "fence-reconcile-invalid", "errors": reconcile_errors})
        return 3
    reconciled = _metadata_commit(repo, intent, reconcile_message)
    if reconciled is None:
        emit({"schema": 1, "status": "blocked", "reason": "fence-reconcile-commit-failed"})
        return 3
    push = foreign_main.run(
        repo,
        "push",
        "--porcelain",
        f"--force-with-lease={CANONICAL_COORDINATOR_REF}:{intent}",
        args.remote,
        f"{reconciled}:{CANONICAL_COORDINATOR_REF}",
    )
    if push.returncode != 0:
        emit({"schema": 1, "status": "cas-lost", "reason": "coordinator-ref-changed-after-fencing", "expected": intent})
        return 4
    emit(
        {
            "schema": 1,
            "status": "fenced",
            "coordinator": reconciled,
            "intent": intent,
            "guard_count": len(guard_entries),
            "guard_vector_digest": result_digest,
            "next": "inventory-and-adopt",
        }
    )
    return 0


def command_sync_contract(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    _, runtime_proof = _runtime_owner_proof()
    if runtime_proof is None:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-thread-id-unavailable"})
        return 3
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    active = next(
        (
            item
            for item in preflight.get("coordinator_refs", [])
            if item.get("kind") == "canonical" and item.get("classification") == "active"
        ),
        None,
    )
    if (
        preflight_code == 0
        and preflight.get("route") == "recover-owner"
        and active
        and active.get("owner_proof_digest") == runtime_proof
    ):
        emit(
            {
                "schema": 1,
                "status": "already-synced",
                "coordinator": active["sha"],
                "contract_source_sha": preflight.get("remote_sha"),
                "contract_digest": preflight.get("contract_oid"),
                "next": "continue-recovery",
            }
        )
        return 0
    if (
        preflight_code != 0
        or preflight.get("route") != "recover-owner-upgrade"
        or active is None
        or active.get("owner_proof_digest") != runtime_proof
    ):
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "contract-sync-not-eligible",
                "preflight": preflight,
            }
        )
        return 3
    coordinator = active["sha"]
    remote_sha = preflight.get("remote_sha")
    contract_oid = preflight.get("contract_oid")
    if (
        not isinstance(remote_sha, str)
        or GIT_OID.fullmatch(remote_sha) is None
        or not isinstance(contract_oid, str)
        or GIT_OID.fullmatch(contract_oid) is None
        or not _materialize_exact(repo, args.remote, [coordinator])
    ):
        emit({"schema": 1, "status": "blocked", "reason": "contract-sync-input-invalid"})
        return 3
    code, coordinator_message = git(repo, "show", "-s", "--format=%B", coordinator)
    if code != 0:
        emit({"schema": 1, "status": "blocked", "reason": "coordinator-message-unavailable"})
        return 3
    coordinator_fields = fields(coordinator_message)
    action_kind = coordinator_fields.get("ACTION_KIND", "")
    action_status = coordinator_fields.get("ACTION_STATUS", "").lower()
    if action_status in {"intent", "planned"}:
        if action_kind != "sync-contract":
            emit({"schema": 1, "status": "blocked", "reason": "different-action-pending"})
            return 3
        intent = coordinator
        intent_message = coordinator_message
    else:
        if action_status != "reconciled":
            emit({"schema": 1, "status": "blocked", "reason": "contract-sync-action-invalid"})
            return 3
        old_source = coordinator_fields.get("CONTRACT_SOURCE_SHA", "unknown")
        old_digest = coordinator_fields.get("CONTRACT_DIGEST", "unknown")
        payload = {
            "old_source": old_source,
            "old_digest": old_digest,
            "new_source": remote_sha,
            "new_digest": contract_oid,
        }
        payload_digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        action = {
            "ACTION_ID": str(
                uuid.uuid5(
                    TRANSITION_NAMESPACE,
                    f"sync-contract:{coordinator}:{payload_digest}",
                )
            ),
            "ACTION_KIND": "sync-contract",
            "ACTION_TARGET": f"{SKILL_PATH}@{remote_sha}",
            "EXPECTED_BEFORE": f"source={old_source};digest={old_digest}",
            "EXTERNAL_REQUEST_KEY": "none",
            "PROVIDER_SELECTOR": f"git:{args.remote}:refs/heads/{args.default}:{SKILL_PATH}",
            "PAYLOAD_DIGEST": payload_digest,
            "EFFECT_IDENTITY": f"source={remote_sha};digest={contract_oid}",
        }
        intent_message, errors = _render_coordinator_action(
            coordinator,
            coordinator_message,
            "ship-linear-release intent sync recovery contract",
            {},
            action,
            "intent",
        )
        if errors or intent_message is None:
            emit({"schema": 1, "status": "blocked", "reason": "contract-sync-intent-invalid", "errors": errors})
            return 3
        intent = _metadata_commit(repo, coordinator, intent_message)
        if intent is None:
            emit({"schema": 1, "status": "blocked", "reason": "contract-sync-intent-commit-failed"})
            return 3
        push = foreign_main.run(
            repo,
            "push",
            "--porcelain",
            f"--force-with-lease={CANONICAL_COORDINATOR_REF}:{coordinator}",
            args.remote,
            f"{intent}:{CANONICAL_COORDINATOR_REF}",
        )
        if push.returncode != 0:
            emit({"schema": 1, "status": "cas-lost", "reason": "coordinator-ref-changed", "expected": coordinator})
            return 4
        coordinator_fields = fields(intent_message)
    old_source = coordinator_fields.get("CONTRACT_SOURCE_SHA", "unknown")
    old_digest = coordinator_fields.get("CONTRACT_DIGEST", "unknown")
    reconcile_message, errors = _render_coordinator_action(
        intent,
        intent_message,
        "ship-linear-release reconciled sync recovery contract",
        {
            "CONTRACT_SOURCE_SHA": remote_sha,
            "CONTRACT_DIGEST": contract_oid,
            "CONTRACT_MIGRATED_FROM": f"source={old_source};digest={old_digest}",
        },
        {},
        "reconciled",
        f"source={remote_sha};digest={contract_oid}",
    )
    if errors or reconcile_message is None:
        emit({"schema": 1, "status": "blocked", "reason": "contract-sync-reconcile-invalid", "errors": errors})
        return 3
    reconciled = _metadata_commit(repo, intent, reconcile_message)
    if reconciled is None:
        emit({"schema": 1, "status": "blocked", "reason": "contract-sync-reconcile-commit-failed"})
        return 3
    push = foreign_main.run(
        repo,
        "push",
        "--porcelain",
        f"--force-with-lease={CANONICAL_COORDINATOR_REF}:{intent}",
        args.remote,
        f"{reconciled}:{CANONICAL_COORDINATOR_REF}",
    )
    if push.returncode != 0:
        emit({"schema": 1, "status": "cas-lost", "reason": "coordinator-ref-changed-after-contract-sync", "expected": intent})
        return 4
    advertised_state, advertised = advertised_coordinator_refs(repo, args.remote)
    observed = next((sha for sha, ref in advertised if ref == CANONICAL_COORDINATOR_REF), None)
    if advertised_state != "observed" or observed != reconciled:
        emit({"schema": 1, "status": "blocked", "reason": "contract-sync-delivery-unverified"})
        return 3
    emit(
        {
            "schema": 1,
            "status": "synced",
            "coordinator": reconciled,
            "intent": intent,
            "contract_source_sha": remote_sha,
            "contract_digest": contract_oid,
            "next": "continue-recovery",
        }
    )
    return 0


def command_resume_recovery(args: argparse.Namespace) -> int:
    """CAS-resume an empty, reconciled recovery without requiring runtime proof elsewhere."""
    repo = Path(args.repo).resolve()
    _, runtime_proof = _runtime_owner_proof()
    if runtime_proof is None:
        emit({"schema": 1, "status": "blocked", "reason": "runtime-thread-id-unavailable"})
        return 3
    preflight_code, preflight = _capture_preflight(repo, args.remote, args.default)
    active = _active_canonical(preflight)
    if (
        preflight_code != 0
        or preflight.get("route") != "recover-owner"
        or active is None
        or active.get("owner_proof_digest") != runtime_proof
        or preflight.get("repository_snapshot", {}).get("observation") != "clear"
    ):
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "recovery-resume-not-eligible",
                "route": preflight.get("route"),
                "repository": preflight.get("repository_snapshot", {}).get("observation"),
            }
        )
        return 3
    parent = active["sha"]
    parent_message, materialization_error = _materialize_coordinator_parent(
        repo, args.remote, parent
    )
    if materialization_error or parent_message is None:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": materialization_error or "coordinator-message-unavailable",
            }
        )
        return 3
    metadata = fields(parent_message)
    quiescent, quiescent_errors = _durable_quiescent_reclaim(metadata)
    recovery = _semicolon_fields(metadata.get("RECOVERY", ""))
    if (
        not quiescent
        or metadata.get("STATE", "").lower() != "recovering"
        or recovery.get("phase") not in {"inventory", "complete"}
        or recovery.get("unresolved", "none").lower() not in {"", "none"}
        or metadata.get("LIVE_GUARDS", "none").strip().lower() not in {"", "none"}
    ):
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "recovery-not-quiescent",
                "errors": quiescent_errors,
                "recovery_phase": recovery.get("phase"),
            }
        )
        return 3

    timestamp = _utc_timestamp()
    target = f"run:{metadata.get('RUN_ID', 'unknown')}:resume-recovery"
    payload = {
        "parent": parent,
        "repository_fingerprint": preflight["repository_snapshot"]["fingerprint"],
        "terminal_pipeline": True,
    }
    payload_digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    action_id = _direct_action_id(parent, "resume-recovery", target, payload_digest)
    pipeline = _update_structured(
        metadata.get("PIPELINE", ""),
        {"open_cutoff": "none", "active_cutoff": "none", "cutoff_ref": "none"},
    )
    completed_recovery = _update_structured(
        metadata.get("RECOVERY", ""),
        {"phase": "complete", "unresolved": "none"},
    )
    replacements = {
        "STATE": "running",
        "OWNER_STATE": "active",
        "LIFECYCLE": f"schema=1;phase=running;pause=none;transition={action_id}",
        "RECOVERY": completed_recovery,
        "PIPELINE": pipeline,
        "ACTIVE_CUTOFF": "none",
        "PENDING_ACTIONS": "none",
        "PRIMARY_CHECKOUT": (
            "clean;relation=equal;fingerprint="
            f"{preflight['repository_snapshot']['fingerprint']}"
        ),
        "REPOSITORY_SNAPSHOT": (
            "status=clear;"
            f"worktrees={preflight['repository_snapshot']['worktree_count']};"
            "dirty_worktrees=0;"
            f"fingerprint={preflight['repository_snapshot']['fingerprint']}"
        ),
    }
    message, rendered_action_id, render_errors = _render_direct_coordinator_action(
        parent,
        parent_message,
        "ship-linear-release resumed reconciled recovery",
        replacements,
        "resume-recovery",
        target,
        payload_digest,
        "state=running;running=0;claims=0;pending=none",
    )
    if render_errors or message is None or rendered_action_id != action_id:
        emit(
            {
                "schema": 1,
                "status": "blocked",
                "reason": "recovery-resume-render-invalid",
                "errors": render_errors,
            }
        )
        return 3
    push_status, commit = _push_coordinator_cas(repo, args.remote, parent, message)
    if push_status != "pushed" or commit is None:
        emit(
            {
                "schema": 1,
                "status": push_status,
                "reason": "recovery-resume-cas-not-confirmed",
                "expected": parent,
            }
        )
        return 4 if push_status == "cas-lost" else 3
    emit(
        {
            "schema": 1,
            "status": "resumed",
            "coordinator": commit,
            "parent": parent,
            "action_id": action_id,
            "state": "running",
            "mutation_scope": "run",
            "next": "take-one-linear-snapshot-and-dispatch",
        }
    )
    return 0


def command_batch_boundary(args: argparse.Namespace) -> int:
    """Validate one meaningful batch decision without inventing a size or timer."""
    payload, input_error = _read_json(args.input)
    allowed = {
        "candidate_sha",
        "features",
        "cohesion",
        "risk",
        "gate_cost",
        "queue_state",
        "urgent",
        "decision",
        "reason",
        "rationale",
    }
    if input_error or not isinstance(payload, dict):
        emit({"schema": 1, "status": "invalid", "errors": [input_error or "invalid:batch-boundary:not-object"]})
        return 2
    errors = [
        *[f"missing:{name}" for name in sorted(allowed - set(payload))],
        *[f"unexpected:{name}" for name in sorted(set(payload) - allowed)],
    ]
    candidate = payload.get("candidate_sha")
    features = payload.get("features")
    cohesion = payload.get("cohesion")
    risk = payload.get("risk")
    gate_cost = payload.get("gate_cost")
    queue_state = payload.get("queue_state")
    urgent = payload.get("urgent")
    decision = payload.get("decision")
    reason = payload.get("reason")
    rationale = payload.get("rationale")
    if not isinstance(candidate, str) or GIT_OID.fullmatch(candidate) is None:
        errors.append("invalid:candidate_sha")
    if (
        not isinstance(features, list)
        or not features
        or len(features) > 64
        or not all(isinstance(item, str) and ISSUE_IDENTIFIER.fullmatch(item) for item in features)
        or len(features) != len(set(features))
    ):
        errors.append("invalid:features")
    if cohesion not in {"cohesive", "mixed"}:
        errors.append("invalid:cohesion")
    if risk not in {"low", "medium", "high"}:
        errors.append("invalid:risk")
    if gate_cost not in {"low", "medium", "high"}:
        errors.append("invalid:gate_cost")
    if queue_state not in {"active", "idle", "finishing"}:
        errors.append("invalid:queue_state")
    if not isinstance(urgent, bool):
        errors.append("invalid:urgent")
    if decision not in {"keep-open", "seal"}:
        errors.append("invalid:decision")
    allowed_reasons = {"cohesion", "risk", "size", "gate-cost", "idle", "urgent", "final"}
    if reason not in allowed_reasons:
        errors.append("invalid:reason")
    if not _bounded_projection_text(rationale, maximum=600):
        errors.append("invalid:rationale")
    mandatory_reason = "urgent" if urgent is True else "final" if queue_state == "finishing" else "idle" if queue_state == "idle" else None
    if mandatory_reason and (decision != "seal" or reason != mandatory_reason):
        errors.append(f"invalid:mandatory-boundary:{mandatory_reason}")
    if decision == "keep-open" and reason in {"idle", "urgent", "final"}:
        errors.append("invalid:keep-open-terminal-reason")
    if errors:
        emit({"schema": 1, "status": "invalid", "errors": list(dict.fromkeys(errors))})
        return 2
    normalized = {
        "candidate_sha": candidate,
        "features": features,
        "cohesion": cohesion,
        "risk": risk,
        "gate_cost": gate_cost,
        "queue_state": queue_state,
        "urgent": urgent,
        "decision": decision,
        "reason": reason,
        "rationale": rationale,
    }
    digest = hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    emit(
        {
            "schema": 1,
            "status": "validated",
            "action": decision,
            "reason": reason,
            "candidate_sha": candidate,
            "feature_count": len(features),
            "boundary_digest": digest,
            "fixed_size_or_timer": False,
            "next": "seal-and-run-one-full-gate" if decision == "seal" else "continue-targeted-ingest",
        }
    )
    return 0


def command_release_lock_plan(args: argparse.Namespace) -> int:
    """Classify a real provider lock capability; never synthesize marker locks."""
    payload, input_error = _read_json(args.input)
    allowed = {"production_required", "target", "owner", "capability"}
    if input_error or not isinstance(payload, dict):
        emit({"schema": 1, "status": "invalid", "errors": [input_error or "invalid:release-lock:not-object"]})
        return 2
    errors = [
        *[f"missing:{name}" for name in sorted(allowed - set(payload))],
        *[f"unexpected:{name}" for name in sorted(set(payload) - allowed)],
    ]
    production_required = payload.get("production_required")
    target = payload.get("target")
    owner = payload.get("owner")
    capability = payload.get("capability")
    if not isinstance(production_required, bool):
        errors.append("invalid:production_required")
    if not _bounded_projection_text(target, maximum=300):
        errors.append("invalid:target")
    if not isinstance(owner, dict) or set(owner) != {"run_id", "epoch"}:
        errors.append("invalid:owner")
    elif UUID_TEXT.fullmatch(str(owner.get("run_id", ""))) is None or not _positive_int(owner.get("epoch")):
        errors.append("invalid:owner")
    capability_fields = {"atomic_acquire", "conditional_release", "fencing", "provider_operation"}
    if not isinstance(capability, dict) or set(capability) != capability_fields:
        errors.append("invalid:capability")
    else:
        for name in ("atomic_acquire", "conditional_release", "fencing"):
            if not isinstance(capability.get(name), bool):
                errors.append(f"invalid:capability.{name}")
        operation = capability.get("provider_operation")
        if operation != "none" and not _bounded_projection_text(operation, maximum=300):
            errors.append("invalid:capability.provider_operation")
    if errors:
        emit({"schema": 1, "status": "invalid", "errors": list(dict.fromkeys(errors))})
        return 2
    supported = bool(
        capability["atomic_acquire"]
        and capability["conditional_release"]
        and capability["provider_operation"] != "none"
    )
    status = "not-required" if not production_required else "acquire-required" if supported else "unsupported/skipped"
    emit(
        {
            "schema": 1,
            "status": status,
            "target": target,
            "owner": owner,
            "acquire_before_publish": production_required and supported,
            "conditional_release_after_terminal": production_required and supported,
            "fencing_available": capability["fencing"] if supported else False,
            "provider_operation": capability["provider_operation"] if supported else None,
            "simulated_marker_allowed": False,
            "force_unlock_requires_user_confirmation": supported,
        }
    )
    return 0


def command_critical_overview(args: argparse.Namespace) -> int:
    """Render a bounded human overview instead of forwarding raw worker/tool output."""
    payload, input_error = _read_json(args.input)
    text_fields = (
        "reason",
        "safety_impact",
        "stage",
        "changed",
        "git_state",
        "linear_state",
        "release_state",
        "next_action",
    )
    allowed = {*text_fields, "evidence"}
    if input_error or not isinstance(payload, dict):
        emit({"schema": 1, "status": "invalid", "errors": [input_error or "invalid:critical-overview:not-object"]})
        return 2
    errors = [
        *[f"missing:{name}" for name in sorted(allowed - set(payload))],
        *[f"unexpected:{name}" for name in sorted(set(payload) - allowed)],
    ]
    for name in text_fields:
        if not _bounded_projection_text(payload.get(name), maximum=700):
            errors.append(f"invalid:{name}")
    evidence = payload.get("evidence")
    if (
        not isinstance(evidence, list)
        or len(evidence) > 12
        or not all(_bounded_projection_text(item, maximum=240) for item in evidence)
    ):
        errors.append("invalid:evidence")
    if errors:
        emit({"schema": 1, "status": "invalid", "errors": list(dict.fromkeys(errors))})
        return 2
    overview = (
        f"Критическая остановка: {payload['reason']}. Продолжать небезопасно: "
        f"{payload['safety_impact']}. Этап: {payload['stage']}. Уже изменено: "
        f"{payload['changed']}. Git: {payload['git_state']}. Linear: "
        f"{payload['linear_state']}. Release: {payload['release_state']}. "
        f"Для продолжения: {payload['next_action']}."
    )
    emit({"schema": 1, "status": "rendered", "overview": overview, "evidence": evidence})
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
    status = sub.add_parser("status")
    status.add_argument("--repo", default=".")
    status.add_argument("--remote", default="origin")
    status.add_argument("--default", default="main")
    status.set_defaults(handler=command_status)
    repo_guard = sub.add_parser("repo-guard")
    repo_guard.add_argument("--repo", default=".")
    repo_guard.add_argument("--input", default="-")
    repo_guard.set_defaults(handler=command_repo_guard)
    batch_boundary = sub.add_parser("batch-boundary")
    batch_boundary.add_argument("--input", default="-")
    batch_boundary.set_defaults(handler=command_batch_boundary)
    release_lock = sub.add_parser("release-lock-plan")
    release_lock.add_argument("--input", default="-")
    release_lock.set_defaults(handler=command_release_lock_plan)
    critical_overview = sub.add_parser("critical-overview")
    critical_overview.add_argument("--input", default="-")
    critical_overview.set_defaults(handler=command_critical_overview)
    pool_status = sub.add_parser("pool-status")
    pool_status.add_argument("--repo", default=".")
    pool_status.add_argument("--remote", default="origin")
    pool_status.add_argument("--default", default="main")
    pool_status.set_defaults(handler=command_pool_status)
    docs = sub.add_parser("docs")
    docs.add_argument("--path", action="append", default=[])
    docs.add_argument("--surface", choices=sorted(SURFACE_DOCS))
    docs.set_defaults(handler=command_docs)
    identities = sub.add_parser("identities")
    identities.set_defaults(handler=command_identities)
    goal_card = sub.add_parser("goal-card")
    goal_card.add_argument("--repo", required=True)
    goal_card.add_argument("--project-name", required=True)
    goal_card.add_argument("--project-id", required=True)
    goal_card.add_argument("--milestone-name", required=True)
    goal_card.add_argument("--milestone-id", required=True)
    goal_card.add_argument("--run-id", required=True)
    goal_card.add_argument("--run-key", required=True)
    goal_card.add_argument("--owner-id", required=True)
    goal_card.add_argument("--epoch", type=int, required=True)
    goal_card.add_argument("--contract-sha", required=True)
    goal_card.set_defaults(handler=command_goal_card)
    invocation = sub.add_parser("invocation")
    invocation.add_argument("--text", required=True)
    invocation.set_defaults(handler=command_invocation)
    launch_check = sub.add_parser("launch-check")
    launch_check.add_argument("--workers", required=True)
    launch_check.add_argument("--max-workers", type=int)
    launch_check.add_argument("--runtime-slots-total", type=int, required=True)
    launch_check.add_argument(
        "--runtime-source", choices=("system-capacity", "runtime-api"), required=True
    )
    launch_check.add_argument("--safe-resource-capacity", type=int)
    launch_check.add_argument(
        "--resource-source", choices=("provisioner", "explicit-safe-limit"), required=True
    )
    launch_check.add_argument("--compatible-ready", type=int, required=True)
    launch_check.add_argument("--unfinished", type=int, required=True)
    launch_check.add_argument("--running", type=int, default=0)
    launch_check.add_argument("--layout", choices=("auto", "dedicated", "fused"), default="auto")
    launch_check.set_defaults(handler=command_launch_check)
    milestone_plan = sub.add_parser("milestone-plan")
    milestone_plan.add_argument("--input", default="-")
    milestone_plan.set_defaults(handler=command_milestone_plan)
    startup_plan = sub.add_parser("startup-plan")
    startup_plan.add_argument("--repo", default=".")
    startup_plan.add_argument("--remote", default="origin")
    startup_plan.add_argument("--default", default="main")
    startup_plan.add_argument("--input", default="-")
    startup_plan.set_defaults(handler=command_startup_plan)
    projection_plan = sub.add_parser("projection-plan")
    projection_plan.add_argument("--input", default="-")
    projection_plan.set_defaults(handler=command_projection_plan)
    projection_batch = sub.add_parser("projection-batch-cas")
    projection_batch.add_argument("--repo", default=".")
    projection_batch.add_argument("--remote", default="origin")
    projection_batch.add_argument("--default", default="main")
    projection_batch.add_argument(
        "--phase", choices=("intent", "reconcile"), required=True
    )
    projection_batch.add_argument("--expected-coordinator-sha", required=True)
    projection_batch.add_argument("--input", default="-")
    projection_batch.set_defaults(handler=command_projection_batch_cas)
    refill_check = sub.add_parser("refill-check")
    refill_check.add_argument("--input", default="-")
    refill_check.set_defaults(handler=command_refill_check)
    conveyor_next = sub.add_parser("conveyor-next")
    conveyor_next.add_argument("--input", default="-")
    conveyor_next.set_defaults(handler=command_conveyor_next)
    dispatch_check = sub.add_parser("dispatch-check")
    dispatch_check.add_argument("--input", default="-")
    dispatch_check.add_argument("--remote", default="origin")
    dispatch_check.set_defaults(handler=command_dispatch_check)
    manifest = sub.add_parser("manifest")
    manifest.add_argument("--input", default="-")
    manifest.add_argument("--phase", choices=("dispatch", "active", "receipt"), default="dispatch")
    manifest.add_argument("--remote", default="origin")
    manifest.set_defaults(handler=command_manifest)
    provision = sub.add_parser("provision-worktree")
    provision.add_argument("--repo", default=".")
    provision.add_argument("--worktree", required=True)
    provision.add_argument(
        "--checkout-mode", choices=("primary", "worktree"), default="worktree"
    )
    provision.add_argument("--path", action="append", default=[])
    provision.add_argument("--package-manager", default="npm")
    provision.add_argument("--install", action="store_true")
    provision.add_argument("--timeout-seconds", type=int, default=900)
    provision.set_defaults(handler=command_provision_worktree)
    receipt = sub.add_parser("receipt-verify")
    receipt.add_argument("--manifest", required=True)
    receipt.add_argument("--input", default="-")
    receipt.add_argument("--remote", default="origin")
    receipt.add_argument("--current-scope-fingerprint", required=True)
    receipt.set_defaults(handler=command_receipt_verify)
    cleanup_plan = sub.add_parser("cleanup-plan")
    cleanup_plan.add_argument("--repo", default=".")
    cleanup_plan.add_argument("--remote", default="origin")
    cleanup_plan.add_argument("--default", default="main")
    cleanup_plan.set_defaults(handler=command_cleanup_plan)
    cleanup_apply = sub.add_parser("cleanup-apply")
    cleanup_apply.add_argument("--repo", default=".")
    cleanup_apply.add_argument("--remote", default="origin")
    cleanup_apply.add_argument("--default", default="main")
    cleanup_apply.add_argument("--input", default="-")
    cleanup_apply.set_defaults(handler=command_cleanup_apply)
    metadata_commit = sub.add_parser("metadata-commit")
    metadata_commit.add_argument("--repo", default=".")
    metadata_commit.add_argument("--parent", required=True)
    metadata_commit.add_argument("--kind", choices=("coordinator", "guard"), required=True)
    metadata_commit.add_argument("--input", default="-")
    metadata_commit.set_defaults(handler=command_metadata_commit)
    transition = sub.add_parser("transition")
    transition.add_argument("--repo", default=".")
    transition.add_argument("--parent", required=True)
    transition.add_argument("--input", default="-")
    transition.set_defaults(handler=command_transition)
    soft_pause = sub.add_parser("soft-pause")
    soft_pause.add_argument("--repo", default=".")
    soft_pause.add_argument("--remote", default="origin")
    soft_pause.add_argument("--default", default="main")
    soft_pause.add_argument("--phase", choices=("start", "checkpoint", "finish"), required=True)
    soft_pause.add_argument("--input", default="-")
    soft_pause.set_defaults(handler=command_soft_pause)
    takeover = sub.add_parser("takeover")
    takeover.add_argument("--repo", default=".")
    takeover.add_argument("--remote", default="origin")
    takeover.add_argument("--default", default="main")
    takeover.set_defaults(handler=command_takeover)
    recover_stale = sub.add_parser("recover-stale-owner")
    recover_stale.add_argument("--repo", default=".")
    recover_stale.add_argument("--remote", default="origin")
    recover_stale.add_argument("--default", default="main")
    recover_stale.add_argument(
        "--proof-kind", choices=("task-terminal", "user-confirmed-stop"), required=True
    )
    recover_stale.add_argument("--proof-digest", required=True)
    recover_stale.set_defaults(handler=command_recover_stale_owner)
    fence_guards = sub.add_parser("fence-guards")
    fence_guards.add_argument("--repo", default=".")
    fence_guards.add_argument("--remote", default="origin")
    fence_guards.add_argument("--default", default="main")
    fence_guards.set_defaults(handler=command_fence_guards)
    sync_contract = sub.add_parser("sync-contract")
    sync_contract.add_argument("--repo", default=".")
    sync_contract.add_argument("--remote", default="origin")
    sync_contract.add_argument("--default", default="main")
    sync_contract.set_defaults(handler=command_sync_contract)
    resume_recovery = sub.add_parser("resume-recovery")
    resume_recovery.add_argument("--repo", default=".")
    resume_recovery.add_argument("--remote", default="origin")
    resume_recovery.add_argument("--default", default="main")
    resume_recovery.set_defaults(handler=command_resume_recovery)
    return root


def main() -> int:
    args = parser().parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
