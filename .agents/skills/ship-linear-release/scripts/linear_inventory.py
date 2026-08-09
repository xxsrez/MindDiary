#!/usr/bin/env python3
"""Normalize one Linear list_issues response for ship-linear-release preflight.

The script deliberately does not fetch issue details or relations.  Its only
job is to prove whether an exact milestone has unfinished work.  Detailed reads
belong to the slower planning path and are needed only for unfinished issues.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any


INVENTORY_SCHEMA = "ship-linear-release/linear-inventory/v1"
TERMINAL_STATUS_TYPES = {"completed", "canceled", "cancelled"}
TERMINAL_STATE_NAMES = {"done", "completed", "canceled", "cancelled"}


class InventoryError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def read_json(path: str) -> Any:
    try:
        if path == "-":
            return json.load(sys.stdin)
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InventoryError("LINEAR_EXPORT_INVALID", str(exc)) from exc


def unwrap_export(value: Any) -> dict[str, Any]:
    """Accept the connector payload, CallToolResult envelope, or inner object."""
    if not isinstance(value, dict):
        raise InventoryError("LINEAR_EXPORT_INVALID", "Linear export must be an object")
    if value.get("isError") is True:
        raise InventoryError("LINEAR_EXPORT_INVALID", "Linear connector returned an error")
    if isinstance(value.get("issues"), list):
        return value
    content = value.get("content")
    if isinstance(content, list):
        texts = [item.get("text") for item in content if isinstance(item, dict) and item.get("type") == "text"]
        if len(texts) != 1 or not isinstance(texts[0], str):
            raise InventoryError("LINEAR_EXPORT_INVALID", "expected one JSON text payload")
        try:
            inner = json.loads(texts[0])
        except json.JSONDecodeError as exc:
            raise InventoryError("LINEAR_EXPORT_INVALID", "connector text is not JSON") from exc
        if isinstance(inner, dict) and isinstance(inner.get("issues"), list):
            return inner
    raise InventoryError("LINEAR_EXPORT_INVALID", "missing issues array")


def normalize_export(value: Any, *, project_id: str, milestone_id: str) -> dict[str, Any]:
    payload = unwrap_export(value)
    if payload.get("hasNextPage") is True:
        raise InventoryError("LINEAR_PAGINATION_REQUIRED", "list_issues response is not complete")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in payload["issues"]:
        if not isinstance(raw, dict):
            raise InventoryError("LINEAR_EXPORT_INVALID", "issue must be an object")
        observed_project = raw.get("projectId")
        if observed_project is not None and observed_project != project_id:
            raise InventoryError("LINEAR_SCOPE_MISMATCH", "issue belongs to another project")
        milestone = raw.get("projectMilestone")
        if milestone is None:
            continue
        if not isinstance(milestone, dict) or not isinstance(milestone.get("id"), str):
            raise InventoryError("LINEAR_EXPORT_INVALID", "projectMilestone is invalid")
        if milestone["id"] != milestone_id:
            continue
        issue_id = raw.get("id")
        title = raw.get("title")
        state = raw.get("status")
        status_type = raw.get("statusType")
        if not all(isinstance(item, str) and item for item in (issue_id, title, state)):
            raise InventoryError("LINEAR_EXPORT_INVALID", "issue id, title, and status are required")
        if issue_id in seen:
            raise InventoryError("LINEAR_EXPORT_INVALID", f"duplicate issue: {issue_id}")
        seen.add(issue_id)
        if status_type is None:
            status_type = "completed" if state.lower() in TERMINAL_STATE_NAMES else "unknown"
        if not isinstance(status_type, str) or not status_type:
            raise InventoryError("LINEAR_EXPORT_INVALID", "statusType is invalid")
        priority = raw.get("priority", 0)
        if isinstance(priority, dict):
            priority = priority.get("value", 0)
        if not isinstance(priority, int):
            raise InventoryError("LINEAR_EXPORT_INVALID", "priority is invalid")
        identifier = raw.get("identifier", issue_id)
        if not isinstance(identifier, str) or not identifier:
            raise InventoryError("LINEAR_EXPORT_INVALID", "identifier is invalid")
        normalized.append(
            {
                "id": issue_id,
                "identifier": identifier,
                "title": title,
                "state": state,
                "status_type": status_type.lower(),
                "priority": priority,
            }
        )
    normalized.sort(key=lambda issue: issue["id"].encode())
    return {
        "schema": INVENTORY_SCHEMA,
        "project_id": project_id,
        "milestone_id": milestone_id,
        "has_next_page": False,
        "issues": normalized,
    }


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


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--input", required=True, help="raw Linear JSON file or - for stdin")
    root.add_argument("--project-id", required=True)
    root.add_argument("--milestone-id", required=True)
    root.add_argument("--output", help="write normalized inventory to this path")
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        inventory = normalize_export(
            read_json(args.input), project_id=args.project_id, milestone_id=args.milestone_id
        )
        terminal = [
            issue["id"] for issue in inventory["issues"]
            if issue["status_type"] in TERMINAL_STATUS_TYPES
        ]
        unfinished = [
            issue["id"] for issue in inventory["issues"]
            if issue["status_type"] not in TERMINAL_STATUS_TYPES
        ]
        if args.output:
            output = Path(args.output).expanduser().resolve()
            atomic_write(output, inventory)
            result: dict[str, Any] = {
                "disposition": "no-work" if not unfinished else "details-required",
                "inventory": str(output),
                "issue_count": len(inventory["issues"]),
                "terminal_count": len(terminal),
                "unfinished_count": len(unfinished),
                "unfinished_issue_ids": unfinished,
            }
        else:
            result = inventory
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except InventoryError as exc:
        print(
            json.dumps({"status": "error", "code": exc.code, "message": str(exc)}, ensure_ascii=False, sort_keys=True),
            file=sys.stderr,
        )
        return 2
    except OSError as exc:
        print(
            json.dumps({"status": "error", "code": "IO_FAILED", "message": str(exc)}, ensure_ascii=False, sort_keys=True),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
