---
name: ship-linear-release
description: >-
  Start or continue Mind Diary's autonomous delivery of the current Linear
  milestone. Coordinate a work-conserving pool of isolated issue workers,
  rolling integration cutoffs, exact-SHA verification, OpenAI Sites production
  deployment when required by current acceptance, rollback, and Linear closure.
  Parse workers=N or free-form worker counts. Use only when the user explicitly invokes
  $ship-linear-release or asks to run this milestone-delivery skill; do not use
  for ordinary issue work, planning, or status reporting.
---

# Ship Linear Release

Доставляй текущий Linear milestone как continuous conveyor:
issue workers -> rolling integration cutoff -> global gate -> default -> при
применимом acceptance Sites -> `Done`. Единственные источники обязательных
gates — current Linear acceptance, `AGENTS.md` и tracked repository contract.
Не вводи target/delivery profiles. Отсутствующую реализацию внутри уже принятого
scope создай как обычную работу, но не выдавай её за выполненный service,
deployment или live gate. Нормативный contract —
[linear-milestone-delivery.md](../../../docs/specs/linear-milestone-delivery.md).

## Главный fast path

После чтения этого файла не загружай все references, product docs, tool schemas,
Git history или Linear comments. Сначала выполни ровно один bounded preflight:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 \
  .agents/skills/ship-linear-release/scripts/shipctl.py preflight \
  --repo <repo> --remote origin --default main
```

Команда read-only: она одним компактным JSON фиксирует remote/default,
tracked contract, dirty skill, coordinator refs, route и
нужные references. Не повторяй её отдельными Git-командами без конкретного
расхождения. Никогда не dump-и `ALL_TOOLS`, полные MCP schemas или descriptions:
найди/загрузи только точные Linear/Git/Sites операции, когда их стадия реально
наступила.

Следуй `route`:

- `blocked` — не мутируй ничего; сообщи точную причину;
- `recovery` — прочитай только выданные `required_references`, докажи owner и
  применяй [crash-recovery.md](references/crash-recovery.md);
- `takeover` — не читай Linear/Goal/references и не проси ручного takeover;
  первым mutable call выполни `shipctl.py takeover`, затем `fence-guards`;
- `resume` — допустим только когда переданный stable owner-proof совпал; затем
  читай те же recovery references и продолжай сохранённый run;
- `drain-owner` — прочитай [soft-pause.md](references/soft-pause.md) и продолжай
  только checkpoint/settlement/finalize текущей мягкой остановки; normal
  dispatch запрещён;
- `recover-owner` — same runtime owner продолжает recovery по durable phase;
- `recover-owner-upgrade` — до любых других мутаций синхронизируй coherent
  fast-forward contract через helper из startup-порядка ниже;
- `normal` — прочитай [coordination.md](references/coordination.md), выполни
  compact Linear snapshot и запускай реальные issue workers.

Другие references загружай только при событии:

- worker dispatch/receipt — [issue-worker.md](references/issue-worker.md);
- первый новый goal — [goal-card.md](references/goal-card.md);
- user/client pause или `drain-owner` —
  [soft-pause.md](references/soft-pause.md);
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
уместился, останови разрастание диагностики, сожми evidence и либо dispatch-и
уже доказанную ready issue, либо верни точный `no-actionable-frontier`.
Исчерпание diagnostic budget само по себе не blocker и не повод спрашивать
пользователя. Не запускай временных scout/explorer для scope discovery: первым
агентом по issue должен быть её worker. Если ownership нельзя определить из
issue и `rg`, тот же worker возвращает `SCOPE_REFINEMENT`; coordinator сужает
manifest и продолжает ту же issue, не создавая отдельного исследователя.

## Разобрать запуск и capacity

Разбирай весь текст вызова:

```text
без worker count                         -> 1
workers=N / «три воркера» / «в 3 потока» -> N
workers=auto / workers=out / «всех доступных» -> auto
auto + «не больше N»                      -> auto(max=N)
resume без нового count                   -> сохранённый WORKERS
dry-run                                   -> только read-only план
```

Нормализуй invocation одним helper до любых мутаций:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py invocation \
  --text '<полный текст вызова>'
```

Число должно быть положительным; не принимай число issue, batch, версии или
budget за worker count. Несовместимые числа требуют одного короткого вопроса.
`workers=N` — exact требование к устойчивому числу одновременно исполняемых
issue. Не понижай его молча. `workers=auto` — единственный адаптивный режим.
Зафиксируй отдельно:

```text
requested_workers; runtime_slots_total; delegated_capacity;
sustained_issue_capacity; opportunistic_inline; active_target
```

`runtime_slots_total` включает root; dedicated coordinator использует только
`delegated_capacity`. Hybrid inline допустим лишь при пустой coordinator queue,
сразу уступает control-plane работе и никогда не учитывается как sustained
concurrent lane. `active_target=min(sustained_issue_capacity, compatible ready)`.
До repo-global claim проверь capacity и actionable frontier детерминированно:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py launch-check \
  --workers <N|auto> [--max-workers N] \
  --runtime-slots-total <including-root> \
  --safe-resource-capacity <n> --compatible-ready <n> \
  --unfinished <n> --running <n>
```

`status=blocked` запрещает claim, goal и dispatch. При exact `N` дефицит
runtime/resource capacity требует остановки с числами, а не скрытого исполнения
меньшим pool. Меньший ready frontier ограничивает только текущий `active_target`
и не нарушает exact capacity. `no-actionable-frontier` при unfinished>0 и
running=0 требует объяснить dependency cycle, unknown blocker или acceptance
contradiction до мутаций; отсутствие ещё не реализованного service само по себе
не blocker. При `auto` используй вычисленный target. Не называй time-sliced root
ещё одним устойчивым worker. `workers=1` — fused coordinator-inline, но issue
всё равно исполняется в отдельном worktree.

До первой мутации дай одну строку:

```text
mode=linear-milestone-delivery; unfinished=<n>;
ready=<n>; workers=<requested/sustained>; runtime-slots=<total>;
delegated=<n>; opportunistic-inline=<0|1>; owner=<new|same|other>; route=<route>;
checkout=<clean|isolated-dirty>; pipeline=<state>; foreign-main=<state>;
external-gates=<not-required|pending|ready|blocked>; gaps=<unavailable>
```

`dry-run` запрещает `create_goal`, Git/Linear/deployment mutations, worktrees и
dispatch. В обычном явно запущенном run разрешены task worktrees/branches,
commits/refs, idempotent Linear receipts, deduplicated Bugs, expected-old
fast-forward default CAS и required configured production Sites deployment/tag.
Разрешена implementation уже принятого Sites MVP vertical slice. Не разрешены
новые product decisions, чтение/раскрытие secrets, force-push/history rewrite,
другой milestone/project, AWS fallback или не принятая infrastructure.

## Claim, goal и live scope

1. На fresh invocation и в начале каждого автоматически продолженного goal turn
   вызови `get_goal` ровно один раз. Active другой goal — `needs-input`, не
   заменяй. Если client status сообщает pause текущего run, до dispatch/shared
   mutation немедленно начни `soft-pause`; `get_goal` остаётся read-only и сам
   не заменяет lifecycle CAS.
2. Одним Linear запросом разреши exact project/current milestone и получи
   compact snapshot: `id/identifier/title/state/priority/labels/createdAt/updatedAt`,
   milestone, dependencies и board tie-breaker. Полный текст/comments читай
   только у issue, выбранных для немедленного dispatch. До claim проверь cycle,
   unknown blockers, conflicting acceptance и наличие ready/running frontier.
   Missing implementation принятого scope классифицируй как work, а не внешний
   prerequisite. Если unfinished есть, но нет ready и running, `launch-check`
   обязан вернуть `no-actionable-frontier` с точной structural причиной.
3. После snapshot и успешного `launch-check` при fresh work первое mutable
   действие — repo-global coordinator claim по
   [coordination.md](references/coordination.md). CAS loser остаётся read-only.
   Active чужой owner — `already-running`; timeout сам по себе не даёт takeover.
   `route=takeover` означает ровно один разрешённый mutable шаг: expected-old
   CAS repo-global claim с `epoch+1`; до его победы и fencing никакие другие
   Git/Linear/worktree mutations не разрешены. Fully reconciled
   `handoff-ready` не требует от пользователя ручной команды, magic phrase или
   самостоятельного Git takeover: fresh explicit вызов этого skill уже задаёт
   intent продолжить run. Eligibility — durable state, а не тип последнего
   ledger action: descendant reconciled bookkeeping после quiescent handoff не
   отменяет takeover, если PAUSE/index, zero-running workers и отсутствие
   pending actions остаются согласованы.

   При `route=takeover` не читай Linear snapshot и references вручную до CAS.
   Сразу выполни один bounded helper, который повторяет preflight, связывает
   proof с `CODEX_THREAD_ID`, создаёт descendant metadata commit и сам делает
   expected-old push:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/shipctl.py takeover \
     --repo "$PWD" --remote origin --default main
   ```

   Допустимы только `status=taken|already-owner`. Затем, как и при fresh
   `route=recover-owner; RECOVERY phase=fencing`, до Linear, ручного Git и
   inventory сразу выполни второй bounded helper:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/shipctl.py fence-guards \
     --repo "$PWD" --remote origin --default main
   ```

   Он durable-записывает intent, строит descendant `fenced` commits и одним
   atomic expected-old multi-ref CAS продвигает весь indexed guard vector,
   затем reconciles coordinator phase `inventory`. Допустимы только
   `status=fenced|already-fenced`; после них загрузи recovery references и
   продолжай inventory/adoption с `mutation_scope=recovery-only`. `cas-lost`
   означает повторить ровно этот helper: он усыновляет свой pending intent и
   уже fenced tips. Другой результат запрещает дальнейшие мутации.
   При `route=recover-owner-upgrade` и pending/active fencing тот же
   `fence-guards` одновременно pin-ит новый contract. После завершённого
   fencing первым mutable call вместо него выполни:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/shipctl.py sync-contract \
     --repo "$PWD" --remote origin --default main
   ```

   Допустимы `status=synced|already-synced`; helper усыновляет свой pending
   intent и сохраняет `CONTRACT_MIGRATED_FROM`. Upgrade допустим только для
   того же runtime owner, coherent старого contract и fast-forward
   `CONTRACT_SOURCE_SHA -> origin/main`; другой mismatch остаётся read-only.
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
затем проецируй `In Progress`/receipt. Несколько независимых Linear comment/
status updates можно провести одним projection-batch intent и одним item-wise
reconcile с отдельными selectors, idempotency keys, payload digests и results.
Никогда не включай в такой batch Git refs, train/cutoff/default, deploy или tag.
Исключение fast path — scope freshness, без которой worker мог бы реализовать
уже отменённую issue.

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
128-bit `run_key`, root/base/dependency SHAs, queue fingerprint, semantic
`scope_fingerprint`, отдельный operational Linear `updatedAt`, ownership paths,
fresh executor lease, isolated env/cache/tmp/ports и remote mode.
Status/comment projections могут
менять `updatedAt`, но не `scope_fingerprint`.
`issue_id` — Linear UUID, когда connector его реально выдаёт; если connector
нормализует `id` до `AND-N`, используй этот exact provider identifier только
при равенстве `issue_id == issue_identifier`. UUID не выдумывай.

Machine-checkable isolation/validation fragment обязателен:

```json
{
  "issue_updated_at": "<operational timestamp>",
  "scope_fingerprint": "<semantic digest>",
  "executor": {
    "lease_id": "<fresh UUID for this issue only>",
    "mode": "delegated|coordinator-inline",
    "agent_type": "worker|coordinator-inline",
    "fork_turns": "none"
  },
  "isolation": {
    "mutable_build_dir": "<absolute task-owned path>",
    "tmp_dir": "<absolute task-owned path>",
    "runtime_dir": "<absolute task-owned path>",
    "cache_mode": "content-addressed|isolated",
    "cache_dir": "<absolute path>",
    "cache_key": "<sha256 for content-addressed, otherwise none>",
    "ports": [],
    "env": {}
  },
  "validation": {
    "check_class": "targeted-feature",
    "targeted_checks": ["<exact command/check id>"],
    "full_gate": "deferred-to-cutoff"
  }
}
```

`ports` содержит уникальные integer ports, `env` — только явные non-secret
task-scoped values; `targeted_checks` не пуст и не включает full repo suite или
dependency install. Feature worker не запускает `npm ci/install`, `pnpm
install`, `yarn install` или аналог: coordinator заранее предоставляет
task-owned isolated dependency tree либо immutable content-addressed cache.

Перед каждым dispatch передай candidate manifest, `EXECUTION_INDEX` active
manifests и все уже использованные executor lease IDs в один read-only check:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py dispatch-check \
  --input <dispatch.json>
```

Только `status=compatible` разрешает spawn. `serialized` означает same-path
lane: жди terminal/feature-ready владельца пересекающегося prefix. `invalid`
запрещает dispatch из-за reuse executor или resource/isolation collision.

Delegated lane запускай сразу как
`spawn_agent(agent_type="worker", fork_turns="none")`; worker не создаёт
subagents и не переиспользуется для другой issue. Один runtime agent принимает
ровно один executor lease за всю жизнь; `followup_task` для второй issue
запрещён. Передай только manifest,
выданные docs и ссылку на [issue-worker.md](references/issue-worker.md).
Coordinator-inline следует тому же протоколу в отдельном worktree. Worker не
меняет default, Linear, Sites, tags или milestone state.

Проверяй receipt только по exact identities, HEAD/ref/guard, semantic scope
freshness, ownership diff и заявленным targeted checks. После durable `ready`
guard соблюдай порядок: validate receipt -> перевести execution state из
`running` в `feature_ready` и освободить slot -> refill compatible issue ->
enqueue ingest -> batch projections/bookkeeping. Цель ready-guard -> refill —
не более 60 секунд; при пропуске durable-запиши точный blocker/evidence. Claim и
guard при `feature_ready` остаются live до terminal integration disposition.

## Continuous pool и cutoffs

Полные fencing/CAS правила — в [coordination.md](references/coordination.md).

- Никаких waves/barrier. Same-path conflict образует serial lane, но не
  останавливает независимые issue.
- `OPEN_CUTOFF` принимает ready refs по одной feature после cheap ingest gate.
  Один `ACTIVE_CUTOFF` выполняет global gate/default/deploy. Поздние refs идут
  в следующий cutoff; cutoff не ждёт in-flight workers.
- Trigger при занятом ACTIVE защёлкивает exact train head+membership digest;
  после terminal ACTIVE этот prefix seal-ится раньше любого late ingest.
- Worker использует exact ready ancestor только для code dependency; release
  dependency ждёт terminal release evidence.
- Same-path descendant superseded feature получает fresh claim/branch.
- Active cutoff не останавливает pool; foreign-main quarantine ограничивается
  affected scope, пока shared lane безопасно не доказана.
- Общие dependency caches допускаются только content-addressed; mutable build,
  tmp, runtime и ports изолированы.
- Coordinator/claim metadata refs создавай только через `shipctl.py
  metadata-commit` или встроенные fenced helpers. Их tree пустой и не содержит
  `.github/workflows`; source/feature tree доказывается отдельными exact SHA.
  Не используй прямой `commit-tree` с source tree: stale workflow на metadata
  ref создаёт лишние Actions runs.

На worker/ingest запускай только targeted checks, smoke и `git diff --check`;
full repository gate всегда принадлежит sealed cutoff. Для каждой
`cutoff/generation/validation key` создай один durable `GATE_RESULT` и один
deduplicated canonical plan: не запускай aggregate command вместе с уже
покрытыми им subcommands. Terminal artifact после compaction/lost handle усынови,
а не запускай gate снова. Не poll-и tight loop: mailbox с bounded timeout;
внешние jobs — compact status раз в 45–60 секунд, failing log один раз и только
нужный range. Linear receipts — transitions, не telemetry.

Перед каждым новым/автоматически продолженным goal turn проверь durable scoped
`HOLD`/`PAUSE`. Не выполняй запрещённую scope, пока записанный resume predicate
не доказан. `PAUSE` с `confirmation_required` переживает Goal continuation и
снимается только отдельным CAS после явного подтверждения пользователя;
автопродолжение, timeout или новый turn подтверждением не являются.

Явная просьба пользователя мягко остановить run или client pause signal
запускает [soft-pause.md](references/soft-pause.md): helper атомарно запрещает
новый dispatch, workers доходят до bounded checkpoints, coordinator завершает
только уже-ready work, а незавершённые refs/worktrees сохраняет. После
quiescent handoff останови turn без `update_goal(blocked)`. Fresh explicit
вызов skill сам выполняет takeover новым epoch.

## Gate, default и применимый production

На первом ingest прочитай [batch-release.md](references/batch-release.md) и
[receipts.md](references/receipts.md). Перед seal/promotion обнови compact
remote/default state. Требуй exact expected-old server-side lease; обычный
check-then-push недостаточен. После default push дождись required CI exact SHA,
если он настроен. Реальную Actions аномалию обрабатывай только по
[github-outage.md](references/github-outage.md); project-command failure нельзя
waive.

Каждый cutoff получает gates из acceptance вошедших issues, current `AGENTS.md`
и tracked commands. Никогда не ослабляй их метаданными запуска. Если current
milestone не требует production, запиши
`PRODUCTION_REQUIREMENT=not-required-by-current-milestone` и не придумывай
deploy/tag. Если требует, отсутствие deployable service, Sites config,
auth/persistence/MCP flow, test или automation — implementation gap: переоткрой
owning issue либо создай deduplicated linked issue и продолжай conveyor.

Production действие допустимо только через tracked `.openai/hosting.json` и
runbook exact-SHA target. Для Mind Diary требуются authenticated web/control,
persistence и MCP smoke, saved previous stable + rollback evidence, затем
immutable tag только по tracked version policy. Один UI, локальный MCP или
capability probe не заменяют этот contract.

Недоступный client/platform gate — `not-available`, а не pass. Если его прямо
требует acceptance/release contract, issue остаётся unfinished. Production
smoke failure: не ставь `Done`, redeploy exact previous stable, проверь rollback
flows, поставь `DEFAULT_HEALTH=known-bad` и выпусти repair новым cutoff; default
не reset/force, нужен явный revert commit при необходимости.

Дефекты маршрутизируй по [defect-triage.md](references/defect-triage.md):
same-scope обратно в issue, независимый regression в deduplicated linked Bug,
systemic/second-generation — в priority stabilization Bug с fresh worker и
заморозкой affected integration. Две неуспешные generations не являются сами по
себе поводом просить пользователя: bounded диагностика должна доказать внешний
blocker, противоречие requirements либо необходимость нового decision. Исключай
виновную feature и её descendants, если независимый cutoff остаётся корректным.

## Завершить

Checkpoint — одна bounded строка:

```text
pool -> cutoff -> health -> issues -> candidate/default SHA ->
foreign-main/hold -> validation key -> production obligation/evidence -> gaps -> remaining
```

Issue переводится в completed-state только после terminal guard и полного
acceptance evidence. Goal завершается после двух fresh согласованных Linear
snapshot без unfinished issue/active artifacts, healthy default и полного
ledger; затем owner ref CAS-terminalize как `complete`. `blocked` допустим
только после трёх fresh последовательных goal-ходов с тем же устойчивым внешним
блокером и без безопасной независимой работы. User pause, drain/handoff,
running worker, pending CI/gate и recoverable CAS race не являются blocker.
Быстрые auto-continuation с тем же fingerprint считаются одним наблюдением;
transient dirty control surface дополнительно наблюдай не менее пяти минут по
[soft-pause.md](references/soft-pause.md).

Если пользователь меняет этот процесс, сначала обнови и проверь skill через
`skill-creator`.
