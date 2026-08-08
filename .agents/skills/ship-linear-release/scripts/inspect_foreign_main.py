#!/usr/bin/env python3
"""Take one read-only, bounded snapshot of the checkout holding default.

The script deliberately does not fetch, lock, refresh, stage, or inspect file
contents.  Its JSON is evidence for ship-linear-release; policy lives in
references/external-main.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

COMMAND_TIMEOUT_SECONDS = 30.0


@dataclass
class CommandResult:
    returncode: int
    stdout: bytes
    error: str | None = None


def run(repo: Path, *args: str) -> CommandResult:
    env = os.environ.copy()
    env.update(
        {
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_PAGER": "cat",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
    )
    try:
        completed = subprocess.run(
            ["git", "-C", str(repo), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            check=False,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        return CommandResult(124, error.stdout or b"", "timeout")
    except OSError:
        return CommandResult(127, b"", "spawn-error")
    return CommandResult(
        completed.returncode,
        completed.stdout,
        None if completed.returncode == 0 else "git-error",
    )


def text(repo: Path, *args: str) -> str | None:
    result = run(repo, *args)
    if result.returncode != 0:
        return None
    return result.stdout.decode("utf-8", "surrogateescape").strip()


def discover_default_checkout(
    repo: Path, default: str
) -> tuple[Path | None, str, str | None, int]:
    result = run(repo, "worktree", "list", "--porcelain", "-z")
    if result.returncode != 0:
        return None, "unavailable", result.error, 0
    listing = result.stdout.decode("utf-8", "surrogateescape")
    record: dict[str, str] = {}
    matches: list[Path] = []
    for raw in listing.split("\0"):
        if not raw:
            if record.get("branch") == f"refs/heads/{default}" and "worktree" in record:
                matches.append(Path(record["worktree"]))
            record = {}
            continue
        key, _, value = raw.partition(" ")
        record[key] = value
    if record.get("branch") == f"refs/heads/{default}" and "worktree" in record:
        matches.append(Path(record["worktree"]))
    if len(matches) == 1:
        return matches[0], "observed", None, 1
    if not matches:
        return None, "absent", None, 0
    return None, "ambiguous", "multiple-default-checkouts", len(matches)


def remote_sha(
    repo: Path, remote: str, default: str
) -> tuple[str | None, str, str | None]:
    result = run(repo, "ls-remote", "--heads", remote, f"refs/heads/{default}")
    if result.returncode != 0:
        return None, "unavailable", result.error
    line = result.stdout.decode("ascii", "replace").strip()
    if not line:
        return None, "missing", None
    sha = line.split()[0]
    return sha, "observed", None


def object_exists(repo: Path, sha: str) -> bool:
    return run(repo, "cat-file", "-e", f"{sha}^{{commit}}").returncode == 0


def relation(repo: Path, local_sha: str | None, remote: str | None) -> str:
    if local_sha is None:
        return "absent"
    if remote is None:
        return "unknown"
    if local_sha == remote:
        return "equal"
    if not object_exists(repo, local_sha) or not object_exists(repo, remote):
        return "unknown"
    local_before_remote = run(repo, "merge-base", "--is-ancestor", local_sha, remote).returncode
    remote_before_local = run(repo, "merge-base", "--is-ancestor", remote, local_sha).returncode
    if local_before_remote not in (0, 1) or remote_before_local not in (0, 1):
        return "unknown"
    if local_before_remote == 0:
        return "behind"
    if remote_before_local == 0:
        return "ahead"
    return "diverged"


def parse_status(raw: bytes) -> tuple[list[str], int, int, int, str]:
    entries = raw.split(b"\0")
    paths: list[str] = []
    staged = 0
    unstaged = 0
    untracked = 0
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if not entry:
            continue
        decoded = entry.decode("utf-8", "surrogateescape")
        if len(decoded) < 3:
            continue
        xy = decoded[:2]
        path = decoded[3:]
        if xy == "??":
            untracked += 1
            paths.append(path)
            continue
        if xy[0] not in (" ", "?"):
            staged += 1
        if xy[1] != " ":
            unstaged += 1
        paths.append(path)
        if xy[0] in ("R", "C") or xy[1] in ("R", "C"):
            if index < len(entries) and entries[index]:
                paths.append(entries[index].decode("utf-8", "surrogateescape"))
                index += 1
    tracked = staged + unstaged
    if tracked and untracked:
        dirty = "both"
    elif tracked:
        dirty = "tracked"
    elif untracked:
        dirty = "untracked"
    else:
        dirty = "clean"
    return sorted(set(paths)), staged, unstaged, untracked, dirty


def main() -> int:
    global COMMAND_TIMEOUT_SECONDS
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".")
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--default", required=True)
    parser.add_argument("--max-paths", type=int, default=80)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    args = parser.parse_args()

    if args.max_paths < 1:
        parser.error("--max-paths must be positive")
    if not 0.1 <= args.timeout_seconds <= 300:
        parser.error("--timeout-seconds must be between 0.1 and 300")
    COMMAND_TIMEOUT_SECONDS = args.timeout_seconds

    requested_repo = Path(args.repo).resolve()
    top_result = run(requested_repo, "rev-parse", "--show-toplevel")
    if top_result.returncode != 0:
        execution_error = top_result.error in ("timeout", "spawn-error")
        json.dump(
            {
                "schema": 1,
                "status": "unavailable" if execution_error else "not-a-repository",
                "probe_error": top_result.error,
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 3 if execution_error else 2
    repo = Path(top_result.stdout.decode("utf-8", "surrogateescape").strip())
    checkout, checkout_discovery, checkout_error, checkout_count = (
        discover_default_checkout(repo, args.default)
    )
    local_ref_result = run(
        repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{args.default}"
    )
    if local_ref_result.returncode == 0:
        local_ref = local_ref_result.stdout.decode("ascii", "replace").strip()
        local_ref_status = "observed"
        local_ref_error = None
    elif local_ref_result.returncode == 1:
        local_ref = None
        local_ref_status = "absent"
        local_ref_error = None
    else:
        local_ref = None
        local_ref_status = "unavailable"
        local_ref_error = local_ref_result.error
    observed_remote, remote_status, remote_error = remote_sha(
        repo, args.remote, args.default
    )

    status_state = "absent" if checkout_discovery == "absent" else "unavailable"
    status_error = checkout_error
    dirty = "clean" if checkout_discovery == "absent" else "unknown"
    paths: list[str] = []
    staged = unstaged = untracked = 0
    checkout_head: str | None = None
    checkout_head_status = "not-applicable"
    checkout_head_error: str | None = None
    raw_status = b""
    if checkout is not None:
        checkout_head_result = run(checkout, "rev-parse", "--verify", "HEAD")
        if checkout_head_result.returncode == 0:
            checkout_head = checkout_head_result.stdout.decode("ascii", "replace").strip()
            checkout_head_status = "observed"
        else:
            checkout_head_status = "unavailable"
            checkout_head_error = checkout_head_result.error
        status_result = run(
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
            paths, staged, unstaged, untracked, dirty = parse_status(raw_status)
        else:
            status_state = "unavailable"
            status_error = status_result.error
            dirty = "unknown"

    # Stabilize the multi-command observation. A checkout/default/remote move
    # during the probe must not be presented as one coherent snapshot.
    changed_during_probe = False
    if checkout is not None:
        after_head_result = run(checkout, "rev-parse", "--verify", "HEAD")
        after_head = (
            after_head_result.stdout.decode("ascii", "replace").strip()
            if after_head_result.returncode == 0
            else None
        )
        after_status_result = run(
            checkout,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignored=no",
        )
        changed_during_probe = (
            after_head != checkout_head
            or after_status_result.returncode != 0
            or after_status_result.stdout != raw_status
        )
    after_local_result = run(
        repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{args.default}"
    )
    after_local = (
        after_local_result.stdout.decode("ascii", "replace").strip()
        if after_local_result.returncode == 0
        else None
    )
    after_remote, after_remote_status, _ = remote_sha(repo, args.remote, args.default)
    changed_during_probe = changed_during_probe or after_local != local_ref
    changed_during_probe = changed_during_probe or after_remote != observed_remote
    changed_during_probe = changed_during_probe or after_remote_status != remote_status
    if changed_during_probe:
        status_state = "unavailable"
        status_error = "changed-during-probe"
        dirty = "unknown"

    digest = hashlib.sha256()
    for value in (
        str(checkout) if checkout is not None else "none",
        checkout_head or "none",
        local_ref or "none",
        observed_remote or "none",
        remote_status,
        remote_error or "none",
        checkout_discovery,
        checkout_error or "none",
        local_ref_status,
        local_ref_error or "none",
        checkout_head_status,
        checkout_head_error or "none",
        status_state,
        status_error or "none",
    ):
        digest.update(value.encode("utf-8", "surrogateescape"))
        digest.update(b"\0")
    digest.update(raw_status)

    complete = (
        checkout_discovery in ("observed", "absent")
        and local_ref_status in ("observed", "absent")
        and checkout_head_status in ("observed", "not-applicable")
        and status_state in ("observed", "absent")
        and remote_status == "observed"
        and not changed_during_probe
    )
    result = {
        "schema": 1,
        "status": "ok" if complete else "partial",
        "default": args.default,
        "remote": args.remote,
        "remote_status": remote_status,
        "remote_error": remote_error,
        "remote_sha": observed_remote,
        "default_checkout": str(checkout) if checkout is not None else None,
        "default_checkout_count": checkout_count,
        "checkout_discovery": checkout_discovery,
        "checkout_head": checkout_head,
        "checkout_head_status": checkout_head_status,
        "checkout_head_error": checkout_head_error,
        "local_default_ref": local_ref,
        "local_ref_status": local_ref_status,
        "local_ref_error": local_ref_error,
        "relation": (
            relation(repo, local_ref, observed_remote)
            if local_ref_status != "unavailable"
            else "unknown"
        ),
        "status_state": status_state,
        "status_error": status_error,
        "dirty": dirty,
        "staged_count": staged,
        "unstaged_count": unstaged,
        "untracked_count": untracked,
        "path_count": len(paths),
        "paths": paths[: args.max_paths],
        "paths_truncated": len(paths) > args.max_paths,
        "changed_during_probe": changed_during_probe,
        "fingerprint": digest.hexdigest(),
    }
    json.dump(result, sys.stdout, ensure_ascii=False, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if result["status"] == "ok" else 3


if __name__ == "__main__":
    raise SystemExit(main())
