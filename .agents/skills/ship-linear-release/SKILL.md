---
name: ship-linear-release
description: >-
  Start or continue Mind Diary's autonomous delivery of the current Linear
  milestone. Coordinate a work-conserving pool of isolated issue workers,
  rolling integration cutoffs, exact-SHA verification, OpenAI Sites production
  deployment when configured, rollback, and Linear closure. Parse workers=N or
  free-form worker counts. Use only when the user explicitly invokes
  $ship-linear-release or asks to run this milestone-delivery skill; do not use
  for ordinary issue work, planning, or status reporting.
---

# Ship Linear Release

Доставляй текущий Linear milestone как continuous conveyor:
issue workers -> rolling integration cutoff -> global gate -> default -> при
`release` Sites -> `Done`. Репозиторий может быть на стадиях `design`, `build`
или `release`; не выдумывай отсутствующий сервис, CI, deployment или live gate.

## Главный fast path

После чтения этого файла не загружай все references, product docs, tool schemas,
Git history или Linear comments. Сначала выполни ровно один bounded preflight:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 \
  .agents/skills/ship-linear-release/scripts/shipctl.py preflight \
  --repo <repo> --remote origin --default main
```

Команда read-only: она одним компактным JSON фиксирует remote/default,
tracked contract, dirty skill, delivery profile, coordinator refs, route и
нужные references. Не повторяй её отдельными Git-командами без конкретного
расхождения. Никогда не dump-и `ALL_TOOLS`, полные MCP schemas или descriptions:
найди/загрузи только точные Linear/Git/Sites операции, когда их стадия реально
наступила.

Следуй `route`:

- `blocked` — не мутируй ничего; сообщи точную причину;
- `recovery` — прочитай только выданные `required_references`, докажи owner и
  применяй [crash-recovery.md](references/crash-recovery.md);
- `resume` — допустим только когда переданный stable owner-proof совпал; затем
  читай те же recovery references и продолжай сохранённый run;
- `normal` — прочитай [coordination.md](references/coordination.md), выполни
  compact Linear snapshot и запускай реальные issue workers.

Другие references загружай только при событии:

- worker dispatch/receipt — [issue-worker.md](references/issue-worker.md);
- первый новый goal — [goal-card.md](references/goal-card.md);
- ingest/cutoff/promotion — [batch-release.md](references/batch-release.md) и
  [receipts.md](references/receipts.md);
- дефект — [defect-triage.md](references/defect-triage.md);
- default/remote drift — [external-main.md](references/external-main.md);
- реальная GitHub/Actions аномалия — [github-outage.md](references/github-outage.md).

До первого настоящего issue executor соблюдай диагностический budget:

```text
coordinator tool calls <= 12
Linear milestone snapshots <= 1
full issue descriptions/comments = только выбранные ready issues
product docs = 0 у coordinator
scout/explorer agents = 0
duplicate Git/Linear/tool discovery = 0
```

Это process invariant, не обещание wall-clock. Если безопасный dispatch не
уместился, останови разрастание контекста и выведи, какой конкретный blocker
съел budget. Не запускай временных scout/explorer для scope discovery: первым
агентом по issue должен быть её worker. Если ownership нельзя определить из
issue и `rg`, тот же worker возвращает `SCOPE_REFINEMENT`; coordinator сужает
manifest и продолжает ту же issue, не создавая отдельного исследователя.

## Разобрать запуск и capacity

Разбирай весь текст вызова:

```text
без worker count                         -> 1
workers=N / «три воркера» / «в 3 потока» -> N
workers=auto / «всех доступных»           -> auto
auto + «не больше N»                      -> auto(max=N)
resume без нового count                   -> сохранённый WORKERS
dry-run                                   -> только read-only план
```

Число должно быть положительным; не принимай число issue, batch, версии или
budget за worker count. Несовместимые числа требуют одного короткого вопроса.
`N` — число одновременно исполняемых issue; coordinator/cutoff/deploy не
вычитаются. Вычисли `effective_workers` по runtime capacity и безопасным
CPU/RAM/port limits, затем `active_target=min(effective_workers, compatible ready)`.
При дефиците capacity сообщи requested/effective/reason и продолжай без
подтверждения. `workers=1` — coordinator-inline в отдельном issue worktree.

До первой мутации дай одну строку:

```text
mode=build-and-ship-milestone; profile=<design|build|release>; unfinished=<n>;
ready=<n>; workers=<requested/effective>; owner=<new|same|other>; route=<route>;
pipeline=<state>; foreign-main=<state>; gates=<available>; gaps=<unavailable>
```

`dry-run` запрещает `create_goal`, Git/Linear/deployment mutations, worktrees и
dispatch. В обычном явно запущенном run разрешены task worktrees/branches,
commits/refs, idempotent Linear receipts, deduplicated Bugs, expected-old
fast-forward default CAS и — только при `release` — configured production Sites
deployment/tag. Не разрешены product decisions, secrets, force-push/history
rewrite, другой milestone/project, AWS fallback или новая infrastructure.

## Claim, goal и live scope

1. Вызови `get_goal` один раз. Active другой goal — `needs-input`, не заменяй.
2. Одним Linear запросом разреши exact project/current milestone и получи
   compact snapshot: `id/identifier/title/state/priority/labels/createdAt/updatedAt`,
   milestone, dependencies и board tie-breaker. Полный текст/comments читай
   только у issue, выбранных для немедленного dispatch.
3. При fresh work первое mutable действие — repo-global coordinator claim по
   [coordination.md](references/coordination.md). CAS loser остаётся read-only.
   Active чужой owner — `already-running`; timeout сам по себе не даёт takeover.
4. Генерируй identities детерминированным helper, не JavaScript snippets:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/shipctl.py identities
   ```

5. После выигранного claim создай milestone goal ровно один раз по
   [goal-card.md](references/goal-card.md), без `token_budget`, если пользователь
   явно не запросил положительный budget.
6. Получи live statuses/labels команды без их создания. Если release-filter
   пуст, фильтруй project issues по exact `projectMilestone.id`.
7. Сортируй ready: priority, подтверждённый Bug/regression, число
   разблокируемых, `createdAt`, board position, identifier.

Linear status/comment projection не должна задерживать worker после выигранного
durable Git claim и валидного manifest. Сначала обеспечь fencing и dispatch;
затем в том же bounded transition проецируй `In Progress`/receipt. Исключение —
scope freshness, без которой worker мог бы реализовать уже отменённую issue.

## Подготовить и запустить worker

Coordinator не читает продуктовые документы. Он строит ownership paths из
issue + `rg`, создаёт отдельный worktree/branch от exact pinned base и формирует
JSON manifest с полями, требуемыми `shipctl manifest`. До dispatch проверь его:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py manifest \
  --input <manifest.json>
```

`status=invalid` запрещает dispatch. `documents` — точный список product docs
для worker; unknown surface fail-safe возвращает весь mandatory set. Новый
surface можно проверить отдельно:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py docs \
  --path <ownership-path> [--path <ownership-path> ...]
```

Manifest содержит как минимум run/owner/epoch, claim generation/token,
issue/project/milestone IDs, repo/worktree/branch, feature+guard refs/tip,
128-bit `run_key`, root/base/dependency SHAs, queue fingerprint, issue
`updatedAt`, ownership paths, isolated env/cache/tmp/ports и remote mode.

Delegated lane запускай сразу как
`spawn_agent(agent_type="worker", fork_turns="none")`; worker не создаёт
subagents и не переиспользуется для другой issue. Передай только manifest,
выданные docs и ссылку на [issue-worker.md](references/issue-worker.md).
Coordinator-inline следует тому же протоколу в отдельном worktree. Worker не
меняет default, Linear, Sites, tags или milestone state.

Проверяй receipt только по exact identities, HEAD/ref/guard, scope freshness,
ownership diff и заявленным checks. `ready` отправляй в ingest; failed остаётся
unfinished. Slot освободи и немедленно заполни следующей compatible issue.

## Continuous pool и cutoffs

Полные fencing/CAS правила — в [coordination.md](references/coordination.md).

- Никаких waves/barrier. Same-path conflict образует serial lane, но не
  останавливает независимые issue.
- `OPEN_CUTOFF` принимает ready refs по одной feature после cheap ingest gate.
  Один `ACTIVE_CUTOFF` выполняет global gate/default/deploy. Поздние refs идут
  в следующий cutoff; cutoff не ждёт in-flight workers.
- Worker использует exact ready ancestor только для code dependency; release
  dependency ждёт terminal release evidence.
- Same-path descendant superseded feature получает fresh claim/branch.
- Active cutoff не останавливает pool; foreign-main quarantine ограничивается
  affected scope, пока shared lane безопасно не доказана.
- Общие dependency caches допускаются только content-addressed; mutable build,
  tmp, runtime и ports изолированы.

На feature запускай только targeted checks, smoke и `git diff --check`; полный
repository gate — один раз на validation key cutoff. Не poll-и tight loop:
mailbox с bounded timeout; внешние jobs — compact status раз в 45–60 секунд,
failing log один раз и только нужный range. Linear receipts — transitions, не
telemetry.

## Gate, default и release

На первом ingest прочитай [batch-release.md](references/batch-release.md) и
[receipts.md](references/receipts.md). Перед seal/promotion обнови compact
remote/default state. Требуй exact expected-old server-side lease; обычный
check-then-push недостаточен. После default push дождись required CI exact SHA,
если он настроен. Реальную Actions аномалию обрабатывай только по
[github-outage.md](references/github-outage.md); project-command failure нельзя
waive.

- `design`: docs/product gates; build/deploy/tag не применимы.
- `build`: доступные build/test/security/conformance gates и default; Sites/tag
  не применимы.
- `release`: только tracked `.openai/hosting.json`/runbook позволяет exact-SHA
  production OpenAI Sites artifact/deploy. Требуются authenticated web/control
  и MCP smoke, saved previous stable + rollback evidence, затем immutable tag
  по tracked version policy.

Недоступный client/platform gate — `not-available`, а не pass. Если его прямо
требует acceptance/release contract, issue остаётся unfinished. Production
smoke failure: не ставь `Done`, redeploy exact previous stable, проверь rollback
flows, поставь `DEFAULT_HEALTH=known-bad` и выпусти repair новым cutoff; default
не reset/force, нужен явный revert commit при необходимости.

Дефекты маршрутизируй по [defect-triage.md](references/defect-triage.md):
same-scope обратно в issue, независимый regression в deduplicated linked Bug,
systemic/second-generation замораживает integration. Исключай виновную feature
и её descendants, если независимый cutoff остаётся корректным.

## Завершить

Checkpoint — одна bounded строка:

```text
pool -> cutoff -> health -> profile -> issues -> candidate/default SHA ->
foreign-main/hold -> validation key -> Sites/live/tag/rollback -> gaps -> remaining
```

Issue переводится в completed-state только после terminal guard и полного
acceptance evidence. Goal завершается после двух fresh согласованных Linear
snapshot без unfinished issue/active artifacts, healthy default и полного
ledger; затем owner ref CAS-terminalize как `complete`. `blocked` допустим
только после трёх последовательных goal-ходов с тем же внешним блокером и без
безопасной независимой работы.

Если пользователь меняет этот процесс, сначала обнови и проверь skill через
`skill-creator`.
