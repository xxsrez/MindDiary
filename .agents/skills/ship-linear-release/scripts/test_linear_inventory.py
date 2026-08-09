#!/usr/bin/env python3

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

import linear_inventory as inventory


PROJECT = "project-1"
MILESTONE = "milestone-1"


def issue(
    identifier: str,
    *,
    status: str = "Done",
    status_type: str = "completed",
    milestone: str = MILESTONE,
) -> dict[str, object]:
    return {
        "id": identifier,
        "title": f"Task {identifier}",
        "status": status,
        "statusType": status_type,
        "priority": {"value": 2, "name": "High"},
        "projectId": PROJECT,
        "projectMilestone": {"id": milestone, "name": "0.1"},
    }


class LinearInventoryTest(unittest.TestCase):
    def test_normalizes_real_connector_envelope_and_filters_other_milestones(self) -> None:
        inner = {
            "issues": [issue("AND-1"), issue("AND-2", milestone="another")],
            "hasNextPage": False,
        }
        envelope = {"content": [{"type": "text", "text": json.dumps(inner)}], "isError": False}
        result = inventory.normalize_export(envelope, project_id=PROJECT, milestone_id=MILESTONE)
        self.assertEqual(result["schema"], inventory.INVENTORY_SCHEMA)
        self.assertEqual([value["id"] for value in result["issues"]], ["AND-1"])
        self.assertEqual(result["issues"][0]["priority"], 2)

    def test_incomplete_pagination_and_scope_mismatch_fail_closed(self) -> None:
        with self.assertRaisesRegex(inventory.InventoryError, "connector returned an error"):
            inventory.normalize_export(
                {"content": [], "isError": True},
                project_id=PROJECT,
                milestone_id=MILESTONE,
            )
        with self.assertRaisesRegex(inventory.InventoryError, "not complete"):
            inventory.normalize_export(
                {"issues": [issue("AND-1")], "hasNextPage": True},
                project_id=PROJECT,
                milestone_id=MILESTONE,
            )
        wrong = issue("AND-1")
        wrong["projectId"] = "another-project"
        with self.assertRaisesRegex(inventory.InventoryError, "another project"):
            inventory.normalize_export(
                {"issues": [wrong], "hasNextPage": False},
                project_id=PROJECT,
                milestone_id=MILESTONE,
            )

    def test_cli_writes_inventory_and_reports_no_work_without_detail_reads(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "linear.json"
            output = root / "inventory.json"
            source.write_text(
                json.dumps({"issues": [issue(f"AND-{index}") for index in range(1, 72)], "hasNextPage": False}),
                encoding="utf-8",
            )
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = inventory.main(
                    [
                        "--input", str(source),
                        "--project-id", PROJECT,
                        "--milestone-id", MILESTONE,
                        "--output", str(output),
                    ]
                )
            self.assertEqual(code, 0, stderr.getvalue())
            summary = json.loads(stdout.getvalue())
            self.assertEqual(summary["disposition"], "no-work")
            self.assertEqual(summary["issue_count"], 71)
            self.assertEqual(summary["unfinished_count"], 0)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["schema"], inventory.INVENTORY_SCHEMA)

    def test_cli_names_only_unfinished_issues_for_detailed_follow_up(self) -> None:
        result = inventory.normalize_export(
            {
                "issues": [
                    issue("AND-1"),
                    issue("AND-2", status="Todo", status_type="unstarted"),
                ],
                "hasNextPage": False,
            },
            project_id=PROJECT,
            milestone_id=MILESTONE,
        )
        unfinished = [
            value["id"] for value in result["issues"]
            if value["status_type"] not in inventory.TERMINAL_STATUS_TYPES
        ]
        self.assertEqual(unfinished, ["AND-2"])


if __name__ == "__main__":
    unittest.main()
