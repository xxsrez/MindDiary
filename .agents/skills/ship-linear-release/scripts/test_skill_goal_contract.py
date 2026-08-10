from __future__ import annotations

import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]


class SkillGoalContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        cls.goal = (SKILL_DIR / "references" / "goal-lifecycle.md").read_text(
            encoding="utf-8"
        )
        cls.spec = (
            REPO_ROOT / "docs" / "specs" / "ship-linear-release-v1.md"
        ).read_text(encoding="utf-8")

    def test_skill_routes_non_empty_work_through_goal_lifecycle(self) -> None:
        self.assertIn("references/goal-lifecycle.md", self.skill)
        self.assertIn("unfinished_count > 0", self.skill)
        self.assertIn("get_goal", self.skill)
        self.assertIn('update_goal({"status":"complete"})', self.skill)
        self.assertLess(
            self.skill.index("disposition=no-work"),
            self.skill.index("unfinished_count > 0"),
        )

    def test_goal_reference_preserves_full_milestone_outcome(self) -> None:
        normalized = " ".join(self.goal.split())
        for required in (
            "get_goal({})",
            "create_goal",
            'update_goal({"status":"complete"})',
            'update_goal({"status":"blocked"})',
            "каждую незавершённую in-scope issue",
            "zero unfinished in-scope work",
            "shipctl.py complete",
            "token_budget",
            "трёх последовательных Goal turns",
        ):
            self.assertIn(required, normalized)

    def test_accepted_spec_makes_goal_terminal_after_external_evidence(self) -> None:
        self.assertIn(
            "Непустой invocation выполняется как один "
            "exact-scope Codex Goal",
            self.spec,
        )
        self.assertIn("No-work path не создаёт новый Codex Goal", self.spec)
        self.assertIn("fully paginated exact Linear inventory", self.spec)
        self.assertIn('update_goal({"status":"complete"})', self.spec)
        self.assertIn("Git/Linear/UAT evidence", self.spec)


if __name__ == "__main__":
    unittest.main()
