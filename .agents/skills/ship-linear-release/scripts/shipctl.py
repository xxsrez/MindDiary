#!/usr/bin/env python3
"""Small durable journal helper for the simplified ship-linear-release skill.

The helper does not call Linear, deploy UAT, spawn agents, merge branches, or
run checks. It records and verifies the coordinator's durable checkpoints.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from typing import Any, Iterator
from urllib.parse import urlsplit
import uuid

from linear_inventory import INVENTORY_SCHEMA, TERMINAL_STATUS_TYPES


SCHEMA = "ship-linear-release/run/v1"
SNAPSHOT_SCHEMA = "ship-linear-release/linear-snapshot/v1"
PREFLIGHT_SCHEMA = "ship-linear-release/preflight/v1"
SHA_RE = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")
WORKERS_KEY_RE = re.compile(r"(?<![A-Za-z0-9_-])workers\s*=", re.I)
WORKERS_VALUE_RE = re.compile(r"(?<![A-Za-z0-9_-])workers\s*=\s*([^\s,;]+)", re.I)
TERMINAL_TASK_STATES = {"done", "excluded"}
ACTIVE_TASK_STATES = {"running", "feature-ready"}
COMPLETED_LINEAR_STATES = {"done", "completed", "canceled", "cancelled"}


class ShipError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def emit(value: dict[str, Any]) -> int:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))
    return 0


def git(path: Path, *args: str, check: bool = True) -> str:
    completed = subprocess.run(
        ["git", "-C", str(path), *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ShipError("GIT_FAILED", f"git {' '.join(args)}: {detail}")
    return completed.stdout.strip()


def repo_root(value: str | Path) -> Path:
    path = Path(value).expanduser().resolve()
    root = Path(git(path, "rev-parse", "--show-toplevel")).resolve()
    if root != path:
        raise ShipError("REPO_ROOT_REQUIRED", f"expected repository root {root}")
    return root


def common_dir(repo: Path) -> Path:
    raw = Path(git(repo, "rev-parse", "--git-common-dir"))
    if not raw.is_absolute():
        raw = repo / raw
    return raw.resolve()


def runs_dir(repo: Path) -> Path:
    return common_dir(repo) / "ship-linear-release" / "runs"


def journal_path(repo: Path, run_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f-]{36}", run_id):
        raise ShipError("RUN_ID_INVALID", "run id must be a lowercase UUID")
    return runs_dir(repo) / f"{run_id}.json"


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ShipError("RUN_NOT_FOUND", f"run journal does not exist: {path.name}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ShipError("JOURNAL_INVALID", f"cannot read run journal: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise ShipError("JOURNAL_INVALID", "unsupported run journal schema")
    return value


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def validate_state(state: dict[str, Any]) -> None:
    required = {
        "schema",
        "run_id",
        "repo_root",
        "project_id",
        "milestone_id",
        "workers",
        "mode",
        "status",
        "main_branch",
        "initial_main_sha",
        "current_main_sha",
        "lanes",
        "tasks",
        "completed_dependency_ids",
        "batches",
        "defects",
        "uat",
        "created_at",
        "updated_at",
    }
    if set(state) != required:
        raise ShipError("JOURNAL_INVALID", "run journal fields are not closed")
    workers = state["workers"]
    if not isinstance(workers, int) or workers < 1:
        raise ShipError("JOURNAL_INVALID", "workers must be positive")
    expected_mode = "single" if workers == 1 else "parallel"
    if state["mode"] != expected_mode:
        raise ShipError("JOURNAL_INVALID", "mode does not match workers")
    lane_ids = [lane.get("id") for lane in state["lanes"]]
    expected_lanes = (
        ["coordinator"]
        if workers == 1
        else [f"worker-{index}" for index in range(1, workers + 1)]
    )
    if lane_ids != expected_lanes or len(set(lane_ids)) != len(lane_ids):
        raise ShipError("JOURNAL_INVALID", "lane topology does not match workers")
    active_issues = [lane.get("active_issue") for lane in state["lanes"] if lane.get("active_issue")]
    if len(active_issues) != len(set(active_issues)):
        raise ShipError("JOURNAL_INVALID", "one issue is assigned to multiple lanes")
    if state["status"] not in {"active", "paused", "completed", "failed"}:
        raise ShipError("JOURNAL_INVALID", "unknown run status")
    completed_dependency_ids = state["completed_dependency_ids"]
    if (
        not isinstance(completed_dependency_ids, list)
        or not all(isinstance(value, str) and value for value in completed_dependency_ids)
        or len(completed_dependency_ids) != len(set(completed_dependency_ids))
    ):
        raise ShipError("JOURNAL_INVALID", "completed dependency ids are invalid")


@contextmanager
def edit_run(repo: Path, run_id: str) -> Iterator[dict[str, Any]]:
    path = journal_path(repo, run_id)
    with file_lock(path.with_suffix(".lock")):
        state = read_json(path)
        validate_state(state)
        yield state
        state["updated_at"] = utc_now()
        validate_state(state)
        atomic_write(path, state)


def active_runs(repo: Path) -> list[dict[str, Any]]:
    directory = runs_dir(repo)
    if not directory.exists():
        return []
    found: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json"), key=lambda item: item.name.encode()):
        state = read_json(path)
        validate_state(state)
        if state["status"] in {"active", "paused"}:
            found.append(state)
    return found


def require_active(state: dict[str, Any]) -> None:
    if state["status"] != "active":
        raise ShipError("RUN_NOT_ACTIVE", f"run status is {state['status']}")


def full_sha(value: str, field: str) -> str:
    if not SHA_RE.fullmatch(value):
        raise ShipError("SHA_INVALID", f"{field} must be a full Git object id")
    return value


def normalized_path(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ShipError("PATH_INVALID", f"invalid repository-relative path: {value}")
    return path.as_posix().rstrip("/")


def path_overlap(left: str, right: str) -> bool:
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def lane(state: dict[str, Any], lane_id: str) -> dict[str, Any]:
    for value in state["lanes"]:
        if value["id"] == lane_id:
            return value
    raise ShipError("LANE_UNKNOWN", f"unknown lane: {lane_id}")


def task(state: dict[str, Any], issue_id: str) -> dict[str, Any]:
    value = state["tasks"].get(issue_id)
    if not isinstance(value, dict):
        raise ShipError("ISSUE_UNKNOWN", f"unknown issue: {issue_id}")
    return value


def refresh_frontier(state: dict[str, Any]) -> None:
    completed = set(state["completed_dependency_ids"]) | {
        issue_id
        for issue_id, value in state["tasks"].items()
        if value["status"] in TERMINAL_TASK_STATES | {"integrated"}
    }
    for value in state["tasks"].values():
        if value["status"] not in {"ready", "blocked"}:
            continue
        value["status"] = (
            "ready" if all(dep in completed for dep in value["dependencies"]) else "blocked"
        )


def parse_invocation(text: str) -> dict[str, Any]:
    keys = WORKERS_KEY_RE.findall(text)
    values = WORKERS_VALUE_RE.findall(text)
    if not keys:
        workers = 1
    else:
        if len(keys) != 1 or len(values) != 1:
            raise ShipError("WORKERS_AMBIGUOUS", "workers must be specified exactly once")
        if not re.fullmatch(r"[1-9][0-9]*", values[0]):
            raise ShipError("WORKERS_INVALID", "workers must be a positive integer")
        workers = int(values[0])
    return {"workers": workers, "mode": "single" if workers == 1 else "parallel"}


def command_invocation(args: argparse.Namespace) -> int:
    return emit(parse_invocation(args.text))


def read_input(path: str, *, code: str) -> dict[str, Any]:
    try:
        if path == "-":
            value = json.load(sys.stdin)
        else:
            value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ShipError(code, str(exc)) from exc
    if not isinstance(value, dict):
        raise ShipError(code, "input must be an object")
    return value


def parse_inventory(value: dict[str, Any], *, project_id: str, milestone_id: str) -> list[dict[str, Any]]:
    if value.get("schema") != INVENTORY_SCHEMA or set(value) != {
        "schema", "project_id", "milestone_id", "has_next_page", "issues"
    }:
        raise ShipError("INVENTORY_INVALID", "unsupported or open inventory schema")
    if value["project_id"] != project_id or value["milestone_id"] != milestone_id:
        raise ShipError("LINEAR_SCOPE_MISMATCH", "inventory does not match exact project/milestone")
    if value["has_next_page"] is not False or not isinstance(value["issues"], list):
        raise ShipError("INVENTORY_INCOMPLETE", "inventory must contain the final page")
    parsed: list[dict[str, Any]] = []
    seen: set[str] = set()
    fields = {"id", "identifier", "title", "state", "status_type", "priority"}
    for raw in value["issues"]:
        if not isinstance(raw, dict) or set(raw) != fields:
            raise ShipError("INVENTORY_INVALID", "inventory issue fields are not closed")
        if not all(
            isinstance(raw[field], str) and raw[field]
            for field in ("id", "identifier", "title", "state", "status_type")
        ) or not isinstance(raw["priority"], int):
            raise ShipError("INVENTORY_INVALID", "inventory issue fields are invalid")
        if raw["id"] in seen:
            raise ShipError("INVENTORY_INVALID", f"duplicate issue: {raw['id']}")
        seen.add(raw["id"])
        parsed.append(dict(raw))
    return parsed


def current_run_has_candidate(state: dict[str, Any]) -> bool:
    return bool(state["batches"] or state["defects"] or any(
        value.get("feature_sha") is not None and value["status"] in {"integrated", "done"}
        for value in state["tasks"].values()
    ))


def journal_is_noop(state: dict[str, Any]) -> bool:
    return (
        not state["batches"]
        and not state["defects"]
        and not any(value["active_issue"] for value in state["lanes"])
        and all(value["status"] in TERMINAL_TASK_STATES for value in state["tasks"].values())
        and not any(value.get("feature_sha") is not None for value in state["tasks"].values())
    )


def command_preflight(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    inventory = parse_inventory(
        read_input(args.input, code="INVENTORY_INVALID"),
        project_id=args.project_id,
        milestone_id=args.milestone_id,
    )
    invocation = parse_invocation(args.invocation)
    unfinished = sorted(
        (issue["id"] for issue in inventory if issue["status_type"] not in TERMINAL_STATUS_TYPES),
        key=lambda value: value.encode(),
    )
    terminal_count = len(inventory) - len(unfinished)
    active = active_runs(repo)
    same = [
        state for state in active
        if state["project_id"] == args.project_id and state["milestone_id"] == args.milestone_id
    ]
    branch = git(repo, "branch", "--show-current")
    main_sha = full_sha(git(repo, "rev-parse", args.main_branch), "main sha")
    clean = not bool(git(repo, "status", "--porcelain=v1", "--untracked-files=all"))
    worktree_count = git(repo, "worktree", "list", "--porcelain").count("worktree ")
    active_run_id: str | None = None
    release_required = False
    if len(same) == 1 and len(active) == 1:
        active_run_id = same[0]["run_id"]
        if same[0]["workers"] != invocation["workers"]:
            disposition = "blocked"
            reason = "ACTIVE_RUN_CONFLICT"
            next_action = "inspect active run"
        elif not unfinished and journal_is_noop(same[0]):
            disposition = "no-work"
            reason = None
            next_action = "complete existing no-op run, then report and stop"
        else:
            disposition = "resume"
            reason = None
            next_action = "status"
            release_required = current_run_has_candidate(same[0])
    elif active:
        disposition = "blocked"
        reason = "ACTIVE_RUN_CONFLICT"
        next_action = "inspect active run"
    elif not unfinished:
        disposition = "no-work"
        reason = None
        next_action = "report and stop"
    elif branch != args.main_branch:
        disposition = "blocked"
        reason = "MAIN_BRANCH_REQUIRED"
        next_action = f"switch to {args.main_branch} without discarding changes"
    elif not clean:
        disposition = "blocked"
        reason = "REPOSITORY_DIRTY"
        next_action = "resolve repository ownership before init"
    else:
        disposition = "start"
        reason = None
        next_action = "check worker capacity, then init"
    return emit(
        {
            "schema": PREFLIGHT_SCHEMA,
            "disposition": disposition,
            "reason": reason,
            "workers": invocation["workers"],
            "mode": invocation["mode"],
            "repository": {
                "root": str(repo),
                "branch": branch,
                "main_sha": main_sha,
                "clean": clean,
                "worktree_count": worktree_count,
            },
            "linear": {
                "project_id": args.project_id,
                "milestone_id": args.milestone_id,
                "issue_count": len(inventory),
                "terminal_count": terminal_count,
                "unfinished_count": len(unfinished),
                "unfinished_issue_ids": unfinished,
                "relations_required": bool(unfinished),
            },
            "active_run_id": active_run_id,
            "release_required": release_required,
            "next_action": next_action,
        }
    )


def command_snapshot_template(args: argparse.Namespace) -> int:
    if args.kind == "inventory":
        return emit(
            {
                "schema": INVENTORY_SCHEMA,
                "project_id": "<linear-project-id>",
                "milestone_id": "<linear-milestone-id>",
                "has_next_page": False,
                "issues": [
                    {
                        "id": "<issue-id>",
                        "identifier": "AND-123",
                        "title": "<title>",
                        "state": "Todo",
                        "status_type": "unstarted",
                        "priority": 2,
                    }
                ],
            }
        )
    return emit(
        {
            "schema": SNAPSHOT_SCHEMA,
            "issues": [
                {
                    "id": "<issue-id>",
                    "identifier": "AND-123",
                    "title": "<title>",
                    "state": "Todo",
                    "priority": 2,
                    "dependencies": [],
                }
            ],
            "completed_dependency_ids": [],
        }
    )


def command_init(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    if args.workers < 1:
        raise ShipError("WORKERS_INVALID", "workers must be positive")
    directory = runs_dir(repo)
    with file_lock(directory / ".runs.lock"):
        active = active_runs(repo)
        same = [
            value
            for value in active
            if value["project_id"] == args.project_id
            and value["milestone_id"] == args.milestone_id
        ]
        if same:
            current = same[0]
            if current["workers"] != args.workers:
                raise ShipError("ACTIVE_RUN_CONFLICT", "active run uses another worker count")
            return emit({"disposition": "reused", "run": current})
        if active:
            raise ShipError("ACTIVE_RUN_CONFLICT", "another active run owns this repository")
        if git(repo, "status", "--porcelain=v1", "--untracked-files=all"):
            raise ShipError("REPOSITORY_DIRTY", "fresh run requires a clean repository")
        initial_sha = full_sha(git(repo, "rev-parse", args.main_branch), "main sha")
        run_id = str(uuid.uuid4())
        now = utc_now()
        lane_ids = (
            ["coordinator"]
            if args.workers == 1
            else [f"worker-{index}" for index in range(1, args.workers + 1)]
        )
        state: dict[str, Any] = {
            "schema": SCHEMA,
            "run_id": run_id,
            "repo_root": str(repo),
            "project_id": args.project_id,
            "milestone_id": args.milestone_id,
            "workers": args.workers,
            "mode": "single" if args.workers == 1 else "parallel",
            "status": "active",
            "main_branch": args.main_branch,
            "initial_main_sha": initial_sha,
            "current_main_sha": initial_sha,
            "lanes": [
                {"id": lane_id, "active_issue": None, "branch": None, "worktree": None}
                for lane_id in lane_ids
            ],
            "tasks": {},
            "completed_dependency_ids": [],
            "batches": [],
            "defects": [],
            "uat": {
                "mode": "continuous",
                "current_sha": None,
                "last_good_sha": None,
                "last_attempt_sha": None,
            },
            "created_at": now,
            "updated_at": now,
        }
        validate_state(state)
        atomic_write(journal_path(repo, run_id), state)
        return emit({"disposition": "created", "run": state})


def command_plan(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    snapshot = read_input(args.input, code="SNAPSHOT_INVALID")
    if not isinstance(snapshot, dict) or snapshot.get("schema") != SNAPSHOT_SCHEMA:
        raise ShipError("SNAPSHOT_INVALID", "unsupported snapshot schema")
    issues = snapshot.get("issues")
    completed_external = snapshot.get("completed_dependency_ids", [])
    if (
        not isinstance(issues, list)
        or not isinstance(completed_external, list)
        or not all(isinstance(value, str) and value for value in completed_external)
        or len(completed_external) != len(set(completed_external))
    ):
        raise ShipError("SNAPSHOT_INVALID", "issues and completed_dependency_ids must be arrays")
    parsed: dict[str, dict[str, Any]] = {}
    for raw in issues:
        if not isinstance(raw, dict) or set(raw) != {
            "id", "identifier", "title", "state", "priority", "dependencies"
        }:
            raise ShipError("SNAPSHOT_INVALID", "issue fields are not closed")
        issue_id = raw["id"]
        dependencies = raw["dependencies"]
        if not all(isinstance(value, str) and value for value in (issue_id, raw["identifier"], raw["title"], raw["state"])):
            raise ShipError("SNAPSHOT_INVALID", "issue string fields must be non-empty")
        if issue_id in parsed or not isinstance(dependencies, list) or len(dependencies) != len(set(dependencies)):
            raise ShipError("SNAPSHOT_INVALID", "duplicate issue or dependency")
        if not isinstance(raw["priority"], int) or not all(isinstance(dep, str) and dep for dep in dependencies):
            raise ShipError("SNAPSHOT_INVALID", "priority/dependencies have invalid types")
        parsed[issue_id] = dict(raw)
    known = set(parsed) | set(completed_external)
    for raw in parsed.values():
        if any(dep not in known for dep in raw["dependencies"]):
            raise ShipError("SNAPSHOT_INVALID", "snapshot contains an unknown dependency")
    with edit_run(repo, args.run) as state:
        require_active(state)
        missing_active = sorted(
            issue_id
            for issue_id, value in state["tasks"].items()
            if value["status"] in ACTIVE_TASK_STATES and issue_id not in parsed
        )
        if missing_active:
            raise ShipError("SNAPSHOT_INCOMPLETE", f"active issues missing from snapshot: {', '.join(missing_active)}")
        historical_terminal = {
            issue_id
            for issue_id, raw in parsed.items()
            if raw["state"].lower() in COMPLETED_LINEAR_STATES
            and issue_id not in state["tasks"]
        }
        state["completed_dependency_ids"] = sorted(
            set(completed_external) | historical_terminal,
            key=lambda value: value.encode(),
        )
        for issue_id, raw in parsed.items():
            existing = state["tasks"].get(issue_id)
            if raw["state"].lower() in COMPLETED_LINEAR_STATES:
                if existing is None or existing["status"] == "done":
                    continue
                raise ShipError(
                    "ISSUE_DRIFT",
                    f"Linear marks an unfinished current-run issue terminal: {issue_id}",
                )
            if existing and existing["status"] in ACTIVE_TASK_STATES | {"integrated"}:
                if any(existing[field] != raw[field] for field in ("identifier", "title", "dependencies")):
                    raise ShipError("ISSUE_DRIFT", f"active issue changed: {issue_id}")
                continue
            if existing and existing["status"] == "done" and raw["state"].lower() not in COMPLETED_LINEAR_STATES:
                reopened = any(
                    value["status"] == "open"
                    and value["route"] == "reopen"
                    and value["linear_issue_id"] == issue_id
                    for value in state["defects"]
                )
                if not reopened:
                    raise ShipError("ISSUE_DRIFT", f"completed issue reopened without a registered defect: {issue_id}")
            state["tasks"][issue_id] = {
                **raw,
                "status": "blocked",
                "lane": None,
                "branch": None,
                "worktree": None,
                "base_sha": None,
                "feature_sha": None,
                "ownership_paths": [],
                "changed_paths": [],
                "checks": {},
                "batch_id": existing.get("batch_id") if existing else None,
                "attempts": existing.get("attempts", 0) if existing else 0,
                "last_error": None,
            }
        refresh_frontier(state)
        ready = sorted(
            (value for value in state["tasks"].values() if value["status"] == "ready"),
            key=lambda value: (value["priority"], value["identifier"].encode()),
        )
        response = {
            "run_id": state["run_id"],
            "disposition": "no-work" if not state["tasks"] else "planned",
            "ready": [value["id"] for value in ready],
            "task_count": len(state["tasks"]),
            "historical_terminal_count": len(historical_terminal),
        }
    return emit(response)


def verify_worktree(repo: Path, worktree: Path, *, allow_root: bool) -> None:
    worktree = worktree.resolve()
    if not allow_root and worktree == repo:
        raise ShipError("WORKTREE_REQUIRED", "parallel lane requires a separate worktree")
    actual_root = Path(git(worktree, "rev-parse", "--show-toplevel")).resolve()
    if actual_root != worktree:
        raise ShipError("WORKTREE_INVALID", "worktree path must be its checkout root")
    if common_dir(worktree) != common_dir(repo):
        raise ShipError("WORKTREE_INVALID", "worktree belongs to another repository")
    if git(worktree, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ShipError("WORKTREE_DIRTY", f"worktree is dirty: {worktree}")


def command_claim(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    worktree = Path(args.worktree).expanduser().resolve()
    ownership = sorted({normalized_path(value) for value in args.path}, key=lambda value: value.encode())
    if not ownership:
        raise ShipError("SCOPE_REQUIRED", "at least one ownership path is required")
    with edit_run(repo, args.run) as state:
        require_active(state)
        unresolved = [value for value in state["defects"] if value["status"] == "open"]
        uat_repair_required = (
            state["uat"]["last_attempt_sha"] is not None
            and state["uat"]["last_attempt_sha"] != state["uat"]["last_good_sha"]
        )
        allowed_repairs = {value.get("linear_issue_id") for value in unresolved if value.get("linear_issue_id")}
        if (unresolved or uat_repair_required) and args.issue not in allowed_repairs:
            raise ShipError("REPAIR_FIRST", "resolve the active guardrail/UAT defect before ordinary dispatch")
        item = task(state, args.issue)
        if item["status"] != "ready":
            raise ShipError("ISSUE_NOT_READY", f"issue status is {item['status']}")
        selected_lane = lane(state, args.lane)
        if selected_lane["active_issue"] is not None:
            raise ShipError("LANE_BUSY", f"lane {args.lane} is busy")
        if state["mode"] == "single" and args.lane != "coordinator":
            raise ShipError("LANE_UNKNOWN", "single mode uses coordinator lane")
        verify_worktree(repo, worktree, allow_root=state["mode"] == "single")
        if state["mode"] == "single" and worktree != repo:
            raise ShipError("WORKTREE_INVALID", "single mode uses the primary checkout")
        branch = git(worktree, "branch", "--show-current")
        if branch != args.branch:
            raise ShipError("BRANCH_MISMATCH", f"expected {args.branch}, observed {branch}")
        for other in state["tasks"].values():
            if other["status"] not in ACTIVE_TASK_STATES:
                continue
            for left in ownership:
                for right in other["ownership_paths"]:
                    if path_overlap(left, right):
                        raise ShipError("SCOPE_CONFLICT", f"{left} overlaps active {right}")
        base_sha = full_sha(git(repo, "rev-parse", state["main_branch"]), "base sha")
        item.update(
            {
                "status": "running",
                "lane": args.lane,
                "branch": args.branch,
                "worktree": str(worktree),
                "base_sha": base_sha,
                "feature_sha": None,
                "ownership_paths": ownership,
                "changed_paths": [],
                "checks": {},
                "attempts": item["attempts"] + 1,
                "last_error": None,
            }
        )
        selected_lane.update({"active_issue": args.issue, "branch": args.branch, "worktree": str(worktree)})
        response = {"run_id": state["run_id"], "issue": args.issue, "lane": args.lane, "base_sha": base_sha}
    return emit(response)


def parse_checks(values: list[str]) -> dict[str, str]:
    checks: dict[str, str] = {}
    for value in values:
        name, separator, result = value.partition("=")
        if not separator or not name or result not in {"passed", "failed"} or name in checks:
            raise ShipError("CHECK_INVALID", f"invalid check: {value}")
        checks[name] = result
    if not checks or any(result != "passed" for result in checks.values()):
        raise ShipError("CHECK_FAILED", "all declared targeted checks must pass")
    return checks


def command_feature_ready(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    head = full_sha(args.head, "feature head")
    checks = parse_checks(args.check)
    with edit_run(repo, args.run) as state:
        require_active(state)
        item = task(state, args.issue)
        if item["status"] != "running":
            raise ShipError("ISSUE_NOT_RUNNING", f"issue status is {item['status']}")
        worktree = Path(item["worktree"])
        verify_worktree(repo, worktree, allow_root=state["mode"] == "single")
        if git(worktree, "branch", "--show-current") != item["branch"]:
            raise ShipError("BRANCH_MISMATCH", "worker branch changed")
        if git(worktree, "rev-parse", "HEAD") != head:
            raise ShipError("SHA_MISMATCH", "feature head does not match worktree HEAD")
        if subprocess.run(
            ["git", "-C", str(worktree), "merge-base", "--is-ancestor", item["base_sha"], head],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode != 0:
            raise ShipError("FEATURE_NOT_DESCENDANT", "feature is not based on recorded main")
        current_main = full_sha(git(repo, "rev-parse", state["main_branch"]), "main sha")
        scope_base = full_sha(git(worktree, "merge-base", current_main, head), "scope base")
        changed = [
            normalized_path(value)
            for value in git(worktree, "diff", "--name-only", f"{scope_base}..{head}").splitlines()
            if value
        ]
        if not changed:
            raise ShipError("FEATURE_EMPTY", "feature has no committed changes")
        outside = [
            value
            for value in changed
            if not any(value == owned or value.startswith(owned + "/") for owned in item["ownership_paths"])
        ]
        if outside:
            raise ShipError("SCOPE_VIOLATION", f"changed paths outside ownership: {', '.join(outside)}")
        item.update({"status": "feature-ready", "feature_sha": head, "changed_paths": changed, "checks": checks})
        response = {"run_id": state["run_id"], "issue": args.issue, "feature_sha": head, "changed_paths": changed}
    return emit(response)


def command_task_failed(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    with edit_run(repo, args.run) as state:
        require_active(state)
        item = task(state, args.issue)
        if item["status"] not in ACTIVE_TASK_STATES:
            raise ShipError("ISSUE_NOT_ACTIVE", f"issue status is {item['status']}")
        selected_lane = lane(state, item["lane"])
        selected_lane.update({"active_issue": None, "branch": None})
        item.update({"status": "blocked", "lane": None, "last_error": args.reason})
        refresh_frontier(state)
        response = {"run_id": state["run_id"], "issue": args.issue, "status": item["status"]}
    return emit(response)


def command_integrate(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    main_sha = full_sha(args.main_sha, "main sha")
    with edit_run(repo, args.run) as state:
        require_active(state)
        item = task(state, args.issue)
        if item["status"] != "feature-ready":
            raise ShipError("FEATURE_NOT_READY", f"issue status is {item['status']}")
        observed = full_sha(git(repo, "rev-parse", state["main_branch"]), "main sha")
        if observed != main_sha:
            raise ShipError("SHA_MISMATCH", f"main is {observed}, not {main_sha}")
        if subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor", item["feature_sha"], main_sha],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode != 0:
            raise ShipError("FEATURE_NOT_IN_MAIN", "feature SHA is not integrated in main")
        selected_lane = lane(state, item["lane"])
        selected_lane.update({"active_issue": None, "branch": None})
        item.update({"status": "integrated", "lane": None})
        state["current_main_sha"] = main_sha
        refresh_frontier(state)
        response = {"run_id": state["run_id"], "issue": args.issue, "status": "integrated", "main_sha": main_sha}
    return emit(response)


def command_task_done(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    with edit_run(repo, args.run) as state:
        require_active(state)
        item = task(state, args.issue)
        if item["status"] != "integrated":
            raise ShipError("ISSUE_NOT_INTEGRATED", f"issue status is {item['status']}")
        item["status"] = "done"
        refresh_frontier(state)
        response = {"run_id": state["run_id"], "issue": args.issue, "status": "done"}
    return emit(response)


def command_batch_create(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    candidate = full_sha(args.candidate, "candidate")
    if args.gate != "passed":
        raise ShipError("GATE_FAILED", "only a passing canonical gate can create a batch")
    with edit_run(repo, args.run) as state:
        require_active(state)
        observed = full_sha(git(repo, "rev-parse", state["main_branch"]), "main sha")
        if observed != candidate:
            raise ShipError("SHA_MISMATCH", "candidate is not current main")
        items = sorted(
            issue_id
            for issue_id, value in state["tasks"].items()
            if value["status"] == "done"
            and value["batch_id"] is None
            and value.get("feature_sha") is not None
        )
        defects = sorted(
            value["id"]
            for value in state["defects"]
            if value["status"] == "resolved" and value["batch_id"] is None
        )
        if not items and not defects:
            raise ShipError("BATCH_EMPTY", "no newly integrated tasks or resolved defects")
        batch_id = f"batch-{len(state['batches']) + 1:03d}"
        batch = {
            "id": batch_id,
            "candidate_sha": candidate,
            "issue_ids": items,
            "defect_ids": defects,
            "gate": "passed",
            "state": "validated",
            "deployment_ref": None,
            "live_url": None,
            "smoke": None,
            "created_at": utc_now(),
            "observed_at": None,
        }
        state["batches"].append(batch)
        for issue_id in items:
            state["tasks"][issue_id]["batch_id"] = batch_id
        for value in state["defects"]:
            if value["id"] in defects:
                value["batch_id"] = batch_id
        state["current_main_sha"] = candidate
        response = {"run_id": state["run_id"], "batch": batch}
    return emit(response)


def command_batch_uat(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    try:
        live_url = urlsplit(args.url)
        port = live_url.port
    except ValueError as exc:
        raise ShipError("UAT_URL_INVALID", "UAT URL is malformed") from exc
    if (
        len(args.url) > 2048
        or live_url.scheme != "https"
        or not live_url.hostname
        or live_url.username is not None
        or live_url.password is not None
        or live_url.query
        or live_url.fragment
        or port is not None and not 1 <= port <= 65535
    ):
        raise ShipError("UAT_URL_INVALID", "UAT URL must be bounded HTTPS without credentials, query, or fragment")
    if not args.deployment.strip() or len(args.deployment) > 256 or any(char in args.deployment for char in "\r\n"):
        raise ShipError("DEPLOYMENT_REF_INVALID", "deployment reference is invalid")
    with edit_run(repo, args.run) as state:
        require_active(state)
        batch = next((value for value in state["batches"] if value["id"] == args.batch), None)
        if batch is None:
            raise ShipError("BATCH_UNKNOWN", f"unknown batch: {args.batch}")
        if batch["state"] != "validated":
            raise ShipError("BATCH_NOT_DEPLOYABLE", f"batch state is {batch['state']}")
        batch.update(
            {
                "state": "uat-passed" if args.result == "passed" else "uat-failed",
                "deployment_ref": args.deployment,
                "live_url": args.url,
                "smoke": args.result,
                "observed_at": utc_now(),
            }
        )
        state["uat"]["current_sha"] = batch["candidate_sha"]
        state["uat"]["last_attempt_sha"] = batch["candidate_sha"]
        if args.result == "passed":
            state["uat"]["last_good_sha"] = batch["candidate_sha"]
        response = {"run_id": state["run_id"], "batch": batch}
    return emit(response)


def command_defect(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    summary = args.summary.strip()
    if not summary or len(summary) > 1000 or any(char in summary for char in "\r\n"):
        raise ShipError("DEFECT_SUMMARY_INVALID", "defect summary must be one bounded line")
    with edit_run(repo, args.run) as state:
        require_active(state)
        if not current_run_has_candidate(state):
            raise ShipError(
                "DEFECT_REQUIRES_CURRENT_WORK",
                "a prerelease/UAT defect requires an integrated current-run candidate",
            )
        if args.route in {"reopen", "new-bug"} and not args.linear_issue_id:
            raise ShipError("LINEAR_ISSUE_REQUIRED", f"{args.route} requires --linear-issue-id")
        candidate_sha = state["uat"]["last_attempt_sha"] or state["current_main_sha"]
        value = next(
            (
                item
                for item in state["defects"]
                if item["status"] == "open"
                and item["route"] == args.route
                and item["candidate_sha"] == candidate_sha
                and (
                    item["linear_issue_id"] == args.linear_issue_id
                    if args.linear_issue_id
                    else item["summary"] == summary
                )
            ),
            None,
        )
        disposition = "reused"
        if value is None:
            defect_id = f"defect-{len(state['defects']) + 1:03d}"
            value = {
                "id": defect_id,
                "route": args.route,
                "linear_issue_id": args.linear_issue_id,
                "candidate_sha": candidate_sha,
                "summary": summary,
                "status": "open",
                "fixed_sha": None,
                "batch_id": None,
                "created_at": utc_now(),
                "resolved_at": None,
            }
            state["defects"].append(value)
            disposition = "created"
        response = {
            "run_id": state["run_id"],
            "disposition": disposition,
            "defect": value,
            "ordinary_dispatch": "paused",
        }
    return emit(response)


def command_defect_resolve(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    fixed_sha = full_sha(args.fixed_sha, "fixed sha")
    with edit_run(repo, args.run) as state:
        require_active(state)
        value = next((item for item in state["defects"] if item["id"] == args.defect), None)
        if value is None:
            raise ShipError("DEFECT_UNKNOWN", f"unknown defect: {args.defect}")
        if value["status"] != "open":
            raise ShipError("DEFECT_NOT_OPEN", f"defect status is {value['status']}")
        observed = full_sha(git(repo, "rev-parse", state["main_branch"]), "main sha")
        if observed != fixed_sha:
            raise ShipError("SHA_MISMATCH", "fixed SHA is not current main")
        if subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor", value["candidate_sha"], fixed_sha],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode != 0:
            raise ShipError("FORWARD_FIX_REQUIRED", "fixed SHA must descend from the affected candidate")
        value.update({"status": "resolved", "fixed_sha": fixed_sha, "resolved_at": utc_now()})
        response = {"run_id": state["run_id"], "defect": value}
    return emit(response)


def command_status(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    if args.run:
        state = read_json(journal_path(repo, args.run))
        validate_state(state)
        return emit({"run": state})
    return emit({"runs": active_runs(repo)})


def command_complete(args: argparse.Namespace) -> int:
    repo = repo_root(args.repo)
    main_sha = full_sha(args.main_sha, "main sha")
    with edit_run(repo, args.run) as state:
        require_active(state)
        unfinished = [issue_id for issue_id, value in state["tasks"].items() if value["status"] not in TERMINAL_TASK_STATES]
        if unfinished:
            raise ShipError("TASKS_UNFINISHED", f"unfinished tasks: {', '.join(sorted(unfinished))}")
        if any(value["active_issue"] for value in state["lanes"]):
            raise ShipError("LANES_BUSY", "all lanes must be free")
        if any(value["status"] == "open" for value in state["defects"]):
            raise ShipError("DEFECTS_OPEN", "all defects must be resolved")
        observed = full_sha(git(repo, "rev-parse", state["main_branch"]), "main sha")
        if observed != main_sha or git(repo, "status", "--porcelain=v1", "--untracked-files=all"):
            raise ShipError("MAIN_NOT_CLEAN", "completion requires exact clean main")
        release_required = current_run_has_candidate(state)
        if release_required and state["uat"]["last_good_sha"] != main_sha:
            raise ShipError("UAT_NOT_CURRENT", "current main has no passing UAT batch")
        state["current_main_sha"] = main_sha
        state["status"] = "completed"
        response = {
            "run_id": state["run_id"],
            "status": "completed",
            "disposition": "released" if release_required else "no-work",
            "release_required": release_required,
            "main_sha": main_sha,
        }
    return emit(response)


def command_production(_: argparse.Namespace) -> int:
    raise ShipError("PRODUCTION_FORBIDDEN", "ship-linear-release never deploys production")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    invocation = commands.add_parser("invocation")
    invocation.add_argument("text")
    invocation.set_defaults(handler=command_invocation)

    template = commands.add_parser("snapshot-template")
    template.add_argument("--kind", choices=("inventory", "plan"), default="inventory")
    template.set_defaults(handler=command_snapshot_template)

    preflight = commands.add_parser("preflight")
    preflight.add_argument("--repo", required=True)
    preflight.add_argument("--project-id", required=True)
    preflight.add_argument("--milestone-id", required=True)
    preflight.add_argument("--invocation", required=True)
    preflight.add_argument("--input", required=True)
    preflight.add_argument("--main-branch", default="main")
    preflight.set_defaults(handler=command_preflight)

    init = commands.add_parser("init")
    init.add_argument("--repo", required=True)
    init.add_argument("--project-id", required=True)
    init.add_argument("--milestone-id", required=True)
    init.add_argument("--workers", type=int, default=1)
    init.add_argument("--main-branch", default="main")
    init.set_defaults(handler=command_init)

    status = commands.add_parser("status")
    status.add_argument("--repo", required=True)
    status.add_argument("--run")
    status.set_defaults(handler=command_status)

    plan = commands.add_parser("plan")
    plan.add_argument("--repo", required=True)
    plan.add_argument("--run", required=True)
    plan.add_argument("--input", required=True)
    plan.set_defaults(handler=command_plan)

    claim = commands.add_parser("claim")
    claim.add_argument("--repo", required=True)
    claim.add_argument("--run", required=True)
    claim.add_argument("--issue", required=True)
    claim.add_argument("--lane", required=True)
    claim.add_argument("--branch", required=True)
    claim.add_argument("--worktree", required=True)
    claim.add_argument("--path", action="append", default=[])
    claim.set_defaults(handler=command_claim)

    ready = commands.add_parser("feature-ready")
    ready.add_argument("--repo", required=True)
    ready.add_argument("--run", required=True)
    ready.add_argument("--issue", required=True)
    ready.add_argument("--head", required=True)
    ready.add_argument("--check", action="append", default=[])
    ready.set_defaults(handler=command_feature_ready)

    failed = commands.add_parser("task-failed")
    failed.add_argument("--repo", required=True)
    failed.add_argument("--run", required=True)
    failed.add_argument("--issue", required=True)
    failed.add_argument("--reason", required=True)
    failed.set_defaults(handler=command_task_failed)

    integrate = commands.add_parser("integrate")
    integrate.add_argument("--repo", required=True)
    integrate.add_argument("--run", required=True)
    integrate.add_argument("--issue", required=True)
    integrate.add_argument("--main-sha", required=True)
    integrate.set_defaults(handler=command_integrate)

    done = commands.add_parser("task-done")
    done.add_argument("--repo", required=True)
    done.add_argument("--run", required=True)
    done.add_argument("--issue", required=True)
    done.set_defaults(handler=command_task_done)

    batch = commands.add_parser("batch-create")
    batch.add_argument("--repo", required=True)
    batch.add_argument("--run", required=True)
    batch.add_argument("--candidate", required=True)
    batch.add_argument("--gate", choices=("passed", "failed"), required=True)
    batch.set_defaults(handler=command_batch_create)

    uat = commands.add_parser("batch-uat")
    uat.add_argument("--repo", required=True)
    uat.add_argument("--run", required=True)
    uat.add_argument("--batch", required=True)
    uat.add_argument("--deployment", required=True)
    uat.add_argument("--url", required=True)
    uat.add_argument("--result", choices=("passed", "failed"), required=True)
    uat.set_defaults(handler=command_batch_uat)

    defect = commands.add_parser("defect")
    defect.add_argument("--repo", required=True)
    defect.add_argument("--run", required=True)
    defect.add_argument("--route", choices=("coordinator", "reopen", "new-bug"), required=True)
    defect.add_argument("--linear-issue-id")
    defect.add_argument("--summary", required=True)
    defect.set_defaults(handler=command_defect)

    resolved = commands.add_parser("defect-resolve")
    resolved.add_argument("--repo", required=True)
    resolved.add_argument("--run", required=True)
    resolved.add_argument("--defect", required=True)
    resolved.add_argument("--fixed-sha", required=True)
    resolved.set_defaults(handler=command_defect_resolve)

    complete = commands.add_parser("complete")
    complete.add_argument("--repo", required=True)
    complete.add_argument("--run", required=True)
    complete.add_argument("--main-sha", required=True)
    complete.set_defaults(handler=command_complete)

    production = commands.add_parser("production")
    production.set_defaults(handler=command_production)
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        return args.handler(args)
    except ShipError as exc:
        print(json.dumps({"status": "error", "code": exc.code, "message": str(exc)}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2
    except OSError as exc:
        print(json.dumps({"status": "error", "code": "IO_FAILED", "message": str(exc)}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
