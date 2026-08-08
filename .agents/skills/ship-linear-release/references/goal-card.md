# Goal card

Читай только при создании нового milestone-delivery Goal. Objective не собирай
из шаблона вручную: его форма, размер и обязательные критерии проверяются
`shipctl.py goal-card`. `workers` — параметр исполнения, а не done criterion;
target/delivery profiles в Goal запрещены.

`run_id`, `run_key` и `owner_id` получай одним вызовом
`scripts/shipctl.py identities`; не собирай UUID/randomness отдельными shell или
JavaScript snippets. `create_goal` вызывай ровно один раз после выигранного
repo-global claim и не передавай `token_budget`, если пользователь явно не
запросил положительный budget.

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py goal-card \
  --repo <absolute-repo> \
  --project-name <name> --project-id <uuid> \
  --milestone-name <name> --milestone-id <uuid> \
  --run-id <uuid> --run-key <32-lower-hex> \
  --owner-id <uuid> --epoch <positive-int> \
  --contract-sha <exact-source-sha>
```

Только `status=valid`, `goal_allowed=true` и `characters <= limit` разрешают
`create_goal`. Передай `objective` без редактирования и сохрани
`objective_sha256` в coordinator ledger. Helper включает observable terminal
snapshots, exact-SHA verification, conditional production, isolation,
single-writer и blocker threshold; параллельный prose-template не поддерживай.

Goal не расширяет полномочия user request и не заменяет repo-global claim.
Если `get_goal` показывает другой active Goal, остановись до мутаций и объясни
конфликт; не заменяй его автоматически.

На завершении сначала terminalize owner/guards, проверь compact `shipctl.py
status` и cleanup terminal worktrees; `update_goal(status=complete)` — последняя
мутация run. Так Goal не может стать complete при ещё active authority.
