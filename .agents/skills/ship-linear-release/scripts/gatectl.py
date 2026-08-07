#!/usr/bin/env python3
"""Run one durable, deduplicated release gate without invoking a shell.

The validation key is an idempotency key.  A terminal result, including a
failure, is immutable and is adopted by later invocations with the exact same
request.  Retrying an interrupted, non-terminal attempt is permitted only when
no process still owns the per-key file lock.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn


SCHEMA = 1
KEY_RE = re.compile(r"[0-9a-f]{64}")
SHA_RE = re.compile(r"[0-9a-f]{40}")
IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}")
LOG_RE = re.compile(r"attempt-[0-9]{6}\.log")
REQUEST_FIELDS = {
    "schema",
    "validation_key",
    "cutoff_id",
    "generation",
    "candidate_sha",
    "environment_id",
    "state_dir",
    "cwd",
    "plan",
}
RESULT_FIELDS = {
    "schema",
    "status",
    "validation_key",
    "request_sha256",
    "attempt",
    "exit_code",
    "started_at",
    "finished_at",
    "duration_ms",
    "log_file",
    "log_sha256",
    "result_sha256",
    "failed_step",
}
MANIFEST_FIELDS = {
    "schema",
    "request",
    "request_sha256",
    "attempt_count",
    "created_at",
    "last_attempt_started_at",
}
MAX_PLAN_JSON_BYTES = 131_072
MAX_PLAN_STEPS = 32
MAX_ARGV_ITEMS = 256
MAX_ARG_BYTES = 32_768
MAX_GIT_OUTPUT_BYTES = 65_536
GIT_TIMEOUT_SECONDS = 10


class GatectlError(Exception):
    """A bounded, user-facing contract or state error."""

    def __init__(self, reason: str, detail: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise GatectlError("invalid-arguments", message)


@dataclass(frozen=True)
class StatePaths:
    root: Path
    key_dir: Path
    lock: Path
    request: Path
    result: Path


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def digest_json(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def emit(payload: dict[str, Any]) -> None:
    print(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )


def fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    data = canonical_bytes(payload) + b"\n"
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.tmp-"
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError as error:
        raise GatectlError(f"missing-{label}") from error
    if len(raw) > 1_048_576:
        raise GatectlError(f"invalid-{label}", "file-too-large")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GatectlError(f"invalid-{label}", "malformed-json") from error
    if not isinstance(value, dict):
        raise GatectlError(f"invalid-{label}", "expected-object")
    return value


def absolute_path(raw: str, label: str, *, must_exist: bool) -> Path:
    if not isinstance(raw, str) or not os.path.isabs(raw):
        raise GatectlError(f"invalid-{label}", "expected-absolute-path")
    try:
        path = Path(raw).resolve(strict=must_exist)
    except (OSError, RuntimeError) as error:
        raise GatectlError(f"invalid-{label}", "cannot-resolve") from error
    if must_exist and not path.is_dir():
        raise GatectlError(f"invalid-{label}", "expected-existing-directory")
    return path


def bounded_git(cwd: Path, *arguments: str) -> tuple[int, bytes, bytes]:
    """Run a local read-only Git query with bounded time and retained output."""

    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            completed = subprocess.run(
                ["git", "-C", str(cwd), *arguments],
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                shell=False,
                close_fds=True,
                timeout=GIT_TIMEOUT_SECONDS,
                check=False,
            )
        except FileNotFoundError as error:
            raise GatectlError("git-unavailable") from error
        except subprocess.TimeoutExpired as error:
            raise GatectlError("git-check-timeout") from error
        stdout_size = stdout.tell()
        stderr_size = stderr.tell()
        if max(stdout_size, stderr_size) > MAX_GIT_OUTPUT_BYTES:
            raise GatectlError("git-check-output-too-large")
        stdout.seek(0)
        stderr.seek(0)
        return completed.returncode, stdout.read(), stderr.read()


def validate_candidate_checkout(cwd: Path, candidate_sha: str) -> None:
    code, raw_top, _ = bounded_git(cwd, "rev-parse", "--show-toplevel")
    if code != 0:
        raise GatectlError("candidate-cwd-not-git-worktree")
    try:
        top = Path(raw_top.decode("utf-8").strip()).resolve(strict=True)
    except (OSError, RuntimeError, UnicodeDecodeError) as error:
        raise GatectlError("candidate-cwd-not-git-worktree") from error
    if top != cwd:
        raise GatectlError("candidate-cwd-not-worktree-root")

    code, raw_head, _ = bounded_git(cwd, "rev-parse", "--verify", "HEAD^{commit}")
    try:
        head = raw_head.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise GatectlError("candidate-head-unavailable") from error
    if code != 0 or SHA_RE.fullmatch(head) is None:
        raise GatectlError("candidate-head-unavailable")
    if head != candidate_sha:
        raise GatectlError("candidate-head-mismatch")

    code, raw_status, _ = bounded_git(
        cwd, "status", "--porcelain=v1", "--untracked-files=normal"
    )
    if code != 0:
        raise GatectlError("candidate-status-unavailable")
    if raw_status:
        raise GatectlError("dirty-candidate-worktree")


def safe_identifier(raw: str, label: str) -> str:
    if not isinstance(raw, str) or IDENTIFIER_RE.fullmatch(raw) is None:
        raise GatectlError(f"invalid-{label}", "expected-safe-identifier")
    return raw


def positive_integer(raw: str) -> int:
    try:
        value = int(raw, 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a positive integer") from error
    if value <= 0 or str(value) != raw:
        raise argparse.ArgumentTypeError("expected a canonical positive integer")
    return value


def validate_plan(value: Any, reason: str) -> list[list[str]]:
    if not isinstance(value, list) or not value or len(value) > MAX_PLAN_STEPS:
        raise GatectlError(reason, "expected-nonempty-step-list")
    for step in value:
        if not isinstance(step, list) or not step or len(step) > MAX_ARGV_ITEMS:
            raise GatectlError(reason, "expected-nonempty-argv-list")
        for item in step:
            try:
                encoded = item.encode("utf-8") if isinstance(item, str) else b""
            except UnicodeEncodeError as error:
                raise GatectlError(reason, "invalid-argv-item") from error
            if (
                not isinstance(item, str)
                or not item
                or "\x00" in item
                or len(encoded) > MAX_ARG_BYTES
            ):
                raise GatectlError(reason, "invalid-argv-item")
    if len(canonical_bytes(value)) > MAX_PLAN_JSON_BYTES:
        raise GatectlError(reason, "input-too-large")
    return value


def parse_plan(raw: str) -> list[list[str]]:
    if len(raw.encode("utf-8", "surrogatepass")) > MAX_PLAN_JSON_BYTES:
        raise GatectlError("invalid-plan-json", "input-too-large")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise GatectlError("invalid-plan-json", "malformed-json") from error
    return validate_plan(value, "invalid-plan-json")


def validate_validation_key(raw: str) -> str:
    if not isinstance(raw, str) or KEY_RE.fullmatch(raw) is None:
        raise GatectlError("invalid-validation-key", "expected-64-lower-hex")
    return raw


def validate_candidate_sha(raw: str) -> str:
    if not isinstance(raw, str) or SHA_RE.fullmatch(raw) is None:
        raise GatectlError("invalid-candidate-sha", "expected-full-lower-sha1")
    return raw


def state_paths(raw_state_dir: str, validation_key: str, *, create: bool) -> StatePaths:
    root = absolute_path(raw_state_dir, "state-dir", must_exist=False)
    if create:
        root.mkdir(parents=True, exist_ok=True)
    elif not root.exists():
        raise GatectlError("state-not-found")
    if not root.is_dir():
        raise GatectlError("invalid-state-dir", "expected-directory")
    key_dir = root / validation_key
    if create:
        existed = key_dir.exists()
        key_dir.mkdir(mode=0o700, exist_ok=True)
        if not existed:
            fsync_directory(root)
    if not key_dir.exists():
        raise GatectlError("state-not-found")
    if key_dir.is_symlink() or not key_dir.is_dir():
        raise GatectlError("invalid-state-path", "key-path-is-not-a-directory")
    return StatePaths(
        root=root,
        key_dir=key_dir,
        lock=key_dir / "gate.lock",
        request=key_dir / "request.json",
        result=key_dir / "result.json",
    )


def request_from_args(args: argparse.Namespace, paths: StatePaths) -> dict[str, Any]:
    validation_key = validate_validation_key(args.validation_key)
    cwd = absolute_path(args.cwd, "cwd", must_exist=True)
    return {
        "schema": SCHEMA,
        "validation_key": validation_key,
        "cutoff_id": safe_identifier(args.cutoff_id, "cutoff-id"),
        "generation": args.generation,
        "candidate_sha": validate_candidate_sha(args.candidate_sha),
        "environment_id": safe_identifier(args.environment_id, "environment-id"),
        "state_dir": str(paths.root),
        "cwd": str(cwd),
        "plan": parse_plan(args.plan_json),
    }


def validate_stored_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict) or set(request) != REQUEST_FIELDS:
        raise GatectlError("invalid-request", "unexpected-request-shape")
    if request.get("schema") != SCHEMA:
        raise GatectlError("invalid-request", "unsupported-schema")
    validate_validation_key(request.get("validation_key"))
    safe_identifier(request.get("cutoff_id"), "cutoff-id")
    generation = request.get("generation")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation <= 0:
        raise GatectlError("invalid-request", "invalid-generation")
    validate_candidate_sha(request.get("candidate_sha"))
    safe_identifier(request.get("environment_id"), "environment-id")
    for label in ("state_dir", "cwd"):
        raw = request.get(label)
        if not isinstance(raw, str) or not os.path.isabs(raw):
            raise GatectlError("invalid-request", f"invalid-{label}")
    validate_plan(request.get("plan"), "invalid-request")
    return request


def validate_manifest(
    manifest: dict[str, Any], validation_key: str, state_root: Path
) -> tuple[dict[str, Any], str]:
    if set(manifest) != MANIFEST_FIELDS:
        raise GatectlError("invalid-request-manifest", "unexpected-manifest-shape")
    if manifest.get("schema") != SCHEMA:
        raise GatectlError("invalid-request-manifest", "unsupported-schema")
    request = validate_stored_request(manifest.get("request"))
    request_sha = digest_json(request)
    if manifest.get("request_sha256") != request_sha:
        raise GatectlError("invalid-request-manifest", "request-digest-mismatch")
    if request["validation_key"] != validation_key:
        raise GatectlError("invalid-request-manifest", "validation-key-mismatch")
    if request["state_dir"] != str(state_root):
        raise GatectlError("invalid-request-manifest", "state-dir-mismatch")
    attempt_count = manifest.get("attempt_count")
    if (
        not isinstance(attempt_count, int)
        or isinstance(attempt_count, bool)
        or attempt_count < 0
    ):
        raise GatectlError("invalid-request-manifest", "invalid-attempt-count")
    if not isinstance(manifest.get("created_at"), str):
        raise GatectlError("invalid-request-manifest", "invalid-created-at")
    if not isinstance(manifest.get("last_attempt_started_at"), str):
        raise GatectlError("invalid-request-manifest", "invalid-last-attempt-started-at")
    return request, request_sha


def validate_result(
    result: dict[str, Any],
    paths: StatePaths,
    request_sha: str,
    attempt_count: int,
    plan_length: int,
) -> dict[str, Any]:
    if set(result) != RESULT_FIELDS:
        raise GatectlError("invalid-result", "unexpected-result-shape")
    if result.get("schema") != SCHEMA:
        raise GatectlError("invalid-result", "unsupported-schema")
    if result.get("validation_key") != paths.key_dir.name:
        raise GatectlError("invalid-result", "validation-key-mismatch")
    if result.get("request_sha256") != request_sha:
        raise GatectlError("invalid-result", "request-digest-mismatch")
    status = result.get("status")
    exit_code = result.get("exit_code")
    if status not in {"passed", "failed"}:
        raise GatectlError("invalid-result", "nonterminal-status")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        raise GatectlError("invalid-result", "invalid-exit-code")
    if (status == "passed") != (exit_code == 0):
        raise GatectlError("invalid-result", "status-exit-code-mismatch")
    failed_step = result.get("failed_step")
    if status == "passed" and failed_step is not None:
        raise GatectlError("invalid-result", "unexpected-failed-step")
    if status == "failed" and (
        not isinstance(failed_step, int)
        or isinstance(failed_step, bool)
        or not 1 <= failed_step <= plan_length
    ):
        raise GatectlError("invalid-result", "invalid-failed-step")
    attempt = result.get("attempt")
    duration_ms = result.get("duration_ms")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt <= 0:
        raise GatectlError("invalid-result", "invalid-attempt")
    if attempt != attempt_count:
        raise GatectlError("invalid-result", "attempt-count-mismatch")
    if (
        not isinstance(duration_ms, int)
        or isinstance(duration_ms, bool)
        or duration_ms < 0
    ):
        raise GatectlError("invalid-result", "invalid-duration")
    if not isinstance(result.get("started_at"), str) or not isinstance(
        result.get("finished_at"), str
    ):
        raise GatectlError("invalid-result", "invalid-timestamps")
    expected_result_sha = result.get("result_sha256")
    unsigned = dict(result)
    unsigned.pop("result_sha256", None)
    if expected_result_sha != digest_json(unsigned):
        raise GatectlError("invalid-result", "result-digest-mismatch")
    log_name = result.get("log_file")
    if not isinstance(log_name, str) or LOG_RE.fullmatch(log_name) is None:
        raise GatectlError("invalid-result", "invalid-log-file")
    log_path = paths.key_dir / log_name
    if log_path.is_symlink() or not log_path.is_file():
        raise GatectlError("invalid-result", "missing-log")
    if result.get("log_sha256") != sha256_file(log_path):
        raise GatectlError("invalid-result", "log-digest-mismatch")
    return result


def open_lock(path: Path, *, create: bool) -> int | None:
    flags = os.O_RDWR
    if create:
        flags |= os.O_CREAT
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(path, flags, 0o600)
    except FileNotFoundError:
        return None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise GatectlError("invalid-lock", "symbolic-link") from error
        raise


def try_lock(descriptor: int) -> bool:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def unlock_and_close(descriptor: int) -> None:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def write_lock_identity(descriptor: int, request_sha: str) -> None:
    payload = {
        "schema": SCHEMA,
        "pid": os.getpid(),
        "request_sha256": request_sha,
        "started_at": utc_now(),
    }
    data = canonical_bytes(payload) + b"\n"
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.ftruncate(descriptor, 0)
    remaining = memoryview(data)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("short write while persisting lock identity")
        remaining = remaining[written:]
    os.fsync(descriptor)


def busy_request_sha(paths: StatePaths) -> str | None:
    deadline = time.monotonic() + 0.5
    while True:
        if paths.request.is_file():
            manifest = load_json(paths.request, "request-manifest")
            _, request_sha = validate_manifest(
                manifest, paths.key_dir.name, paths.root
            )
            return request_sha
        try:
            lock_state = load_json(paths.lock, "lock")
            request_sha = lock_state.get("request_sha256")
            if isinstance(request_sha, str) and KEY_RE.fullmatch(request_sha):
                return request_sha
        except GatectlError:
            pass
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.01)


def terminal_output(result: dict[str, Any], *, adopted: bool) -> dict[str, Any]:
    return dict(result) | {"adopted": adopted, "verified": True}


def return_for_terminal(result: dict[str, Any]) -> int:
    return 0 if result["status"] == "passed" else 1


def command_run(args: argparse.Namespace) -> int:
    validation_key = validate_validation_key(args.validation_key)
    paths = state_paths(args.state_dir, validation_key, create=True)
    request = request_from_args(args, paths)
    request_sha = digest_json(request)

    # Terminal files are atomic and immutable.  Reading them before the lock
    # also permits adoption if a finished gate left the lock inherited by a
    # short-lived descendant process.
    if paths.request.exists() and paths.result.exists():
        manifest = load_json(paths.request, "request-manifest")
        stored_request, stored_sha = validate_manifest(
            manifest, validation_key, paths.root
        )
        if stored_sha != request_sha or stored_request != request:
            raise GatectlError("request-mismatch")
        result = validate_result(
            load_json(paths.result, "result"),
            paths,
            request_sha,
            manifest["attempt_count"],
            len(stored_request["plan"]),
        )
        emit(terminal_output(result, adopted=True))
        return return_for_terminal(result)

    descriptor = open_lock(paths.lock, create=True)
    assert descriptor is not None
    if not try_lock(descriptor):
        os.close(descriptor)
        observed_sha = busy_request_sha(paths)
        if observed_sha is None:
            raise GatectlError("running-request-unverifiable")
        if observed_sha != request_sha:
            raise GatectlError("request-mismatch")
        emit(
            {
                "schema": SCHEMA,
                "status": "running",
                "validation_key": validation_key,
                "request_sha256": request_sha,
                "adopted": False,
            }
        )
        return 0

    try:
        write_lock_identity(descriptor, request_sha)
        if paths.request.exists():
            manifest = load_json(paths.request, "request-manifest")
            stored_request, stored_sha = validate_manifest(
                manifest, validation_key, paths.root
            )
            if stored_sha != request_sha or stored_request != request:
                raise GatectlError("request-mismatch")
        else:
            if paths.result.exists():
                raise GatectlError("invalid-state", "result-without-request")
            manifest = {
                "schema": SCHEMA,
                "request": request,
                "request_sha256": request_sha,
                "attempt_count": 0,
                "created_at": utc_now(),
            }

        if paths.result.exists():
            result = validate_result(
                load_json(paths.result, "result"),
                paths,
                request_sha,
                manifest["attempt_count"],
                len(request["plan"]),
            )
            emit(terminal_output(result, adopted=True))
            return return_for_terminal(result)

        validate_candidate_checkout(Path(request["cwd"]), request["candidate_sha"])
        attempt = manifest["attempt_count"] + 1
        manifest = dict(manifest)
        manifest["attempt_count"] = attempt
        manifest["last_attempt_started_at"] = utc_now()
        atomic_write_json(paths.request, manifest)

        log_name = f"attempt-{attempt:06d}.log"
        if LOG_RE.fullmatch(log_name) is None:
            raise GatectlError("attempt-limit-exceeded")
        log_path = paths.key_dir / log_name
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            log_descriptor = os.open(log_path, flags, 0o600)
        except FileExistsError as error:
            raise GatectlError("invalid-state", "attempt-log-already-exists") from error

        started_at = utc_now()
        started_ns = time.monotonic_ns()
        exit_code = 0
        failed_step: int | None = None
        plan = request["plan"]
        with os.fdopen(log_descriptor, "wb", buffering=0) as log_stream:
            for step_number, step in enumerate(plan, start=1):
                boundary = (
                    f"\ngatectl: step {step_number}/{len(plan)} begin "
                    f"argv_sha256={digest_json(step)}\n"
                )
                log_stream.write(boundary.encode("ascii"))
                os.fsync(log_stream.fileno())
                try:
                    process = subprocess.Popen(
                        step,
                        cwd=request["cwd"],
                        stdin=subprocess.DEVNULL,
                        stdout=log_stream,
                        stderr=subprocess.STDOUT,
                        shell=False,
                        close_fds=True,
                        pass_fds=(descriptor,),
                    )
                    step_exit_code = process.wait()
                except OSError as error:
                    step_exit_code = (
                        127 if isinstance(error, FileNotFoundError) else 126
                    )
                    message = (
                        "gatectl: step could not be started: "
                        f"{type(error).__name__}: {error}\n"
                    )
                    log_stream.write(message.encode("utf-8", "replace"))
                candidate_verified = True
                try:
                    validate_candidate_checkout(
                        Path(request["cwd"]), request["candidate_sha"]
                    )
                except GatectlError as error:
                    candidate_verified = False
                    message = (
                        "gatectl: candidate verification failed after step: "
                        f"{error.reason}\n"
                    )
                    log_stream.write(message.encode("utf-8"))
                    if step_exit_code == 0:
                        step_exit_code = 125
                boundary = (
                    f"\ngatectl: step {step_number}/{len(plan)} end "
                    f"exit_code={step_exit_code} "
                    f"candidate_verified={str(candidate_verified).lower()}\n"
                )
                log_stream.write(boundary.encode("ascii"))
                os.fsync(log_stream.fileno())
                if step_exit_code != 0:
                    exit_code = step_exit_code
                    failed_step = step_number
                    break

        finished_ns = time.monotonic_ns()
        finished_at = utc_now()
        log_sha = sha256_file(log_path)
        result: dict[str, Any] = {
            "schema": SCHEMA,
            "status": "passed" if exit_code == 0 else "failed",
            "validation_key": validation_key,
            "request_sha256": request_sha,
            "attempt": attempt,
            "exit_code": exit_code,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_ms": max(0, (finished_ns - started_ns) // 1_000_000),
            "log_file": log_name,
            "log_sha256": log_sha,
            "failed_step": failed_step,
        }
        result["result_sha256"] = digest_json(result)
        atomic_write_json(paths.result, result)
        emit(terminal_output(result, adopted=False))
        return return_for_terminal(result)
    finally:
        unlock_and_close(descriptor)


def command_status(args: argparse.Namespace) -> int:
    validation_key = validate_validation_key(args.validation_key)
    try:
        paths = state_paths(args.state_dir, validation_key, create=False)
    except GatectlError as error:
        if error.reason == "state-not-found":
            emit(
                {
                    "schema": SCHEMA,
                    "status": "not-found",
                    "validation_key": validation_key,
                }
            )
            return 3
        raise
    manifest = load_json(paths.request, "request-manifest")
    request, request_sha = validate_manifest(manifest, validation_key, paths.root)
    if paths.result.exists():
        result = validate_result(
            load_json(paths.result, "result"),
            paths,
            request_sha,
            manifest["attempt_count"],
            len(request["plan"]),
        )
        emit(terminal_output(result, adopted=False))
        return 0

    descriptor = open_lock(paths.lock, create=False)
    running = False
    if descriptor is not None:
        running = not try_lock(descriptor)
        if running:
            os.close(descriptor)
        else:
            unlock_and_close(descriptor)
    if running:
        observed_sha = busy_request_sha(paths)
        if observed_sha is not None and observed_sha != request_sha:
            raise GatectlError("invalid-lock", "request-digest-mismatch")
        emit(
            {
                "schema": SCHEMA,
                "status": "running",
                "validation_key": validation_key,
                "request_sha256": request_sha,
                "attempt_count": manifest["attempt_count"],
                "verified": observed_sha == request_sha,
            }
        )
        return 0

    emit(
        {
            "schema": SCHEMA,
            "status": "interrupted",
            "validation_key": validation_key,
            "request_sha256": request_sha,
            "attempt_count": manifest["attempt_count"],
            "candidate_sha": request["candidate_sha"],
            "verified": True,
        }
    )
    return 4


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="subcommand", required=True)

    run = subcommands.add_parser("run", help="run or adopt one exact gate")
    run.add_argument("--state-dir", required=True)
    run.add_argument("--validation-key", required=True)
    run.add_argument("--cutoff-id", required=True)
    run.add_argument("--generation", required=True, type=positive_integer)
    run.add_argument("--candidate-sha", required=True)
    run.add_argument("--environment-id", required=True)
    run.add_argument("--cwd", required=True)
    run.add_argument("--plan-json", required=True)
    run.set_defaults(handler=command_run)

    status = subcommands.add_parser("status", help="verify state without executing")
    status.add_argument("--state-dir", required=True)
    status.add_argument("--validation-key", required=True)
    status.set_defaults(handler=command_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        return args.handler(args)
    except GatectlError as error:
        payload: dict[str, Any] = {
            "schema": SCHEMA,
            "status": "error",
            "reason": error.reason,
        }
        if error.detail:
            payload["detail"] = error.detail[:512]
        emit(payload)
        return 2
    except OSError as error:
        emit(
            {
                "schema": SCHEMA,
                "status": "error",
                "reason": "io-error",
                "detail": f"{type(error).__name__}: {error}"[:512],
            }
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
