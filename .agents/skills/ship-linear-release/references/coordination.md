# Координация workers и непрерывной доставки

Этот протокол определяет только ownership, параллелизм, cutoffs и реакцию на
дефекты. Форматы durable records бери из [receipts.md](receipts.md), работу
issue — из [issue-worker.md](issue-worker.md), сборку и продвижение exact
candidate — из [batch-release.md](batch-release.md), классификацию дефектов —
из [defect-triage.md](defect-triage.md). Не дублируй здесь release- или
Sites-процедуру. Чужие изменения primary/default обрабатывай по
[external-main.md](external-main.md).
Crash/restart, guard fencing и artifact adoption находятся в
[crash-recovery.md](crash-recovery.md).

## Startup fast path

До первого issue executor coordinator следует bounded `shipctl.py preflight`
из `SKILL.md`, а не повторяет Git discovery вручную. Не запускай scout,
explorer или planning agent перед issue worker. Scope discovery выполняется
compact Linear snapshot + `rg`; неоднозначность возвращается тем же worker-ом
как `SCOPE_REFINEMENT`, после чего coordinator обновляет manifest этой issue.
Это не новая issue lane и не повод перечитывать весь repository context.

## Содержание

- [Считать workers по исполняемым issue](#считать-workers-по-исполняемым-issue)
- [Захватить один repo-global claim](#захватить-один-repo-global-claim)
- [Разрешить комбинации sessions однозначно](#разрешить-комбинации-sessions-однозначно)
- [Менять limit немедленно и безопасно](#менять-limit-немедленно-и-безопасно)
- [Поддерживать work-conserving pool](#поддерживать-work-conserving-pool)
- [Вести OPEN_CUTOFF и один ACTIVE_CUTOFF](#вести-open_cutoff-и-один-active_cutoff)
- [Срабатывать по точным cutoff triggers](#срабатывать-по-точным-cutoff-triggers)
- [Хранить явное health state](#хранить-явное-health-state)
- [Соблюдать durable HOLD и PAUSE](#соблюдать-durable-hold-и-pause)
- [Выбирать действие по классу дефекта](#выбирать-действие-по-классу-дефекта)
- [Восстанавливаться без двойной мутации](#восстанавливаться-без-двойной-мутации)
- [Оставлять только минимальные receipts](#оставлять-только-минимальные-receipts)

## Считать workers по исполняемым issue

1. Трактуй `workers=N` как requested concurrency исполняемых Linear issue, а
   не как число subagents или общий orchestration budget. Не выдавай requested
   value за фактически доступную capacity.
2. Durable-запиши пять независимых величин:

   ```text
   requested_workers; runtime_slots_total; delegated_capacity;
   sustained_issue_capacity; opportunistic_inline
   ```

   `runtime_slots_total` включает root и все child agents. Dedicated root
   оставляет issue только фактически доступную `delegated_capacity` (не больше
   `runtime_slots_total - 1`). Для dedicated layout
   `sustained_issue_capacity=min(requested_workers, delegated_capacity,
   safe_resource_capacity)`; root в неё не входит. Отдельный `active_target`
   равен минимуму sustained capacity и compatible ready-set. В fused
   `workers=1` sustained capacity равна одной root-inline lane.
3. При `workers=1` разрешён fused режим: owner-session исполняет одну issue в
   отдельном worktree и обслуживает coordinator queue между bounded
   checkpoint. При `N>1` предпочитай dedicated root и child executors.
4. Hybrid inline разрешай только когда coordinator queue пуста: нет
   необработанного ready receipt, просроченного refill, pending cutoff seal,
   gate/default/deploy transition, recovery, hold/pause или user message.
   При появлении coordinator work inline lane доходит до ближайшего bounded
   checkpoint и уступает root. Храни её как `opportunistic_inline=1`, но не
   прибавляй к `sustained_issue_capacity` и не называй устойчивой concurrent
   lane.
5. Разделяй три состояния одной issue:
   - claim authority: current owner/epoch/generation/token и live guard;
   - execution state: `running | coordinator-paused | feature_ready | failed |
     needs-input | stopped`;
   - integration state: `not-queued | queued | accepted | excluded | terminal`.
6. Только `execution_state=running` занимает issue slot. Durable grant
   переводится в `running` непосредственно перед spawn/inline start; failed
   spawn сразу переводит его в `stopped`. `coordinator-paused` не считается
   дополнительной concurrent lane.
7. После валидированного durable `ready` guard немедленно переведи execution в
   `feature_ready`: slot свободен, хотя claim/guard остаются live до terminal
   integration disposition. Не вычисляй occupancy по `CLAIM_INDEX`.
8. Храни bounded `EXECUTION_INDEX` в repo-global ledger с exact
   `issue/generation/executor/state`, `running_count`, entries digest и последним
   missed-refill blocker. `CLAIM_INDEX` отвечает только за authority/recovery,
   а integration queue — только за продвижение feature.

## Захватить один repo-global claim

Используй ровно один ref для всего repository, всех sessions и milestones:

```text
refs/heads/codex/release/coordinator
```

1. До первой мутации fetch-ни ref. Если он отсутствует, создай metadata commit
   с неизменным source tree и атомарно создай ref обычным non-force push.
2. Храни в каждом claim commit минимум:

   ```text
   owner_id; owner_proof_kind; owner_proof_digest;
   run_id; run_key; milestone_id; epoch; state;
   action_seq; action_id; action_kind; action_target; expected_before;
   external_request_key; provider_selector; payload_digest; effect_identity;
   contract_source_sha; contract_digest
   ```

3. Считай `owner_id` ID конкретной Codex task/session, а не пользователя,
   машины или milestone. Запиши digest stable runtime task/thread identity в
   initial claim, если она доступна. Иначе сгенерируй UUID, но один remote UUID
   не доказывает same owner. `caller = owner` доказано только matching stable
   runtime identity либо authoritative active goal этой task с exact
   `run_id + owner_id`; без proof используй observer/takeover path из
   [crash-recovery.md](crash-recovery.md).
4. Увеличивай `epoch` только при новом ownership после terminal release claim
   либо при разрешённом takeover. Никогда не уменьшай и не переиспользуй epoch.
5. Перед каждой bounded shared мутацией создай descendant claim commit с новым
   `action_seq` и одноразовым `action_id`, докажи ancestry и CAS-продвинь ref с
   explicit server-side expected-old lease на exact observed tip. Выполняй
   действие только после успешного push; lease не разрешает history rewrite.
6. Свяжи action ID с exact kind/target, `expected_before`, payload digest,
   queryable provider selector, external request/idempotency key и ожидаемой
   effect identity. Без этих полей ambiguous create не retry-и. Action не
   разрешает соседнее действие.
7. Единственное batch-исключение — один bounded `projection-batch` intent для
   независимых Linear comment/status projections и один item-wise reconcile.
   Каждый item имеет собственные target, expected-before, selector,
   request/idempotency key, payload digest, effect identity и result; partial
   failure не делает остальные items unknown. Не включай в batch guard/feature/
   train/cutoff/default refs, CI waiver authority, deploy, tag или Sites effect:
   они сохраняют отдельные authoritative action tickets.
8. Для worker создай fenced grant `<owner_id, epoch, claim_generation,
   claim_token, issue_id, base_sha, feature_ref, guard_ref, guard_tip>`. Online
   worker пишет feature+descendant guard acknowledgement одним atomic multi-ref
   expected-old push; без этой remote capability возвращает local-only commit.
   Полная race/restart процедура — в `crash-recovery.md`.
9. При CAS reject ничего не мутируй. Fetch-ни победивший claim и стань
   observer. Не retry-и push поверх нового owner/epoch.
10. Если remote ref нельзя прочитать или CAS-продвинуть, не начинай новую
   мутацию. Разрешай read-only recovery/dry-run; уже выданный grant можно
   довести только до его точной bounded границы.

Claim не является lease по времени. `heartbeat`, возраст comment, отсутствие
локального PID и длительное молчание сами по себе не освобождают ownership.
Он также не блокирует процесс вне skill: такой процесс не получает authority,
но его Git effects надо обнаружить, карантинить или reconciliate отдельно.

Mixed legacy/global refs fail-closed. Любой nonterminal
`refs/heads/codex/release/<milestone>/coordinator` блокирует normal/resume, кроме
exact tip, для которого ancestry canonical repo-global ref содержит reconciled
action `migrate-legacy-ledger` с target `<legacy-ref>@<legacy-full-SHA>` и durable
stop evidence прежнего coordinator/workers. Только этот exact ref@SHA считается
retired для collision check; новый SHA, другой legacy ref, missing reconcile или
owner proof одного global ref не разрешают mutations.

## Разрешить комбинации sessions однозначно

| Remote state | Caller | Milestone / worker limits | Действие |
| --- | --- | --- | --- |
| Claim отсутствует | Две sessions race | Любые | Обе делают create-CAS; победитель становится owner, проигравшая — observer. |
| `active`, caller = owner proof | Та же session | Тот же milestone, `1->1`, `1->N`, `N->1`, `N->M` | Resume run; изменение limit примени по следующему разделу. |
| `active`, caller = owner | Та же session | Другой milestone, любые limits | Не запускай второй run; сначала terminal checkpoint и release текущего claim, затем новый epoch. |
| `active`, caller != owner | Вторая session | Тот же milestone, `1/1`, `1/N`, `N/1` или `N/M` | Откажись от мутаций; только observer/read-only report. |
| `active`, caller != owner | Вторая session | Другой milestone, любые limits | Откажись от мутаций; repo-global claim важнее milestone boundary. |
| `active`, старый owner доказанно остановлен | Новая session | Тот же или другой milestone | Выполни takeover `epoch+1`, fence guards, затем recovery; до fencing не dispatch-и. |
| `handoff-ready`, explicit target/reason, нет in-flight action/worker | Новая session | Тот же run | CAS-прими ownership с `epoch+1`, fence-ни guards и затем recovery. |
| `complete` | Любая session | Любой milestone/limit | CAS-создай descendant claim с новым owner и `epoch+1`; сохрани старый ledger. |
| `aborted`, нет run effects | Любая session | Любой milestone/limit | CAS-создай descendant claim с новым owner и `epoch+1`; aborted не считать release success. |
| Любой state | Любая session с `dry-run` | Любые | Разреши только read-only план; не создавай claim, receipt, worktree или action token. |

Вторая session не становится coordinator из-за большего worker limit. Она не
меняет limit owner-session и не «помогает» внешними mutations; при необходимости
передай owner только read-only observation.

Takeover разрешай только после одного из доказательств:

- пользователь явно подтвердил, что названная старая Codex task остановлена;
- authoritative task/thread state доказывает terminal/archived old coordinator.
  Unknown children допустимы только при доказанном feature-only manifest: их
  guards сначала fence-ятся, worktrees не переиспользуются. Иначе нужны
  подтверждения остановки children либо reconciliation shared effects.

Не используй timeout, stale timestamp или предположение о crash как
доказательство. При сомнении оставайся observer и верни `needs-input`.
`handoff-ready` создаётся только отдельным explicit owner action с target/reason;
goal conflict до первой run effect завершается owner state `aborted`, а не
превращается в неявный handoff.

## Менять limit немедленно и безопасно

Только текущая owner-session меняет limit после отдельного fenced CAS action.

- Increase `N->M`, `M>N`: пересчитай truthful capacity и сразу dispatch-и
  готовые совместимые issue до `sustained_issue_capacity`; opportunistic inline
  остаётся отдельным временным режимом.
- Decrease `N->M`, `M<N`: не interrupt-и running issue; прекрати refill, пока
  `running_count` не станет меньше `M`, затем поддерживай новый limit.
- Переход к `1`: после graceful drain работай fused coordinator-inline.
- Переход от `1`: немедленно выбери dedicated layout; hybrid inline включай
  только при пустой coordinator queue и не прибавляй к sustained capacity.

Не сдвигай deadline уже непустого `OPEN_CUTOFF` позже. При decrease уменьши
его latched size, если новый size меньше; при increase новый size применяй со
следующего пустого `OPEN_CUTOFF`.

## Поддерживать work-conserving pool

1. Не создавай waves и barrier между workers.
2. После появления durable `ready` guard соблюдай один work-conserving порядок:
   validate exact receipt -> durable `running -> feature_ready` в
   `EXECUTION_INDEX` -> refill свободного slot -> enqueue feature для ingest ->
   projection batch/bookkeeping. Claim/guard не terminalize-и до integration
   disposition.
3. Цель от наблюдения ready guard до нового spawn/inline start — `<=60s`. Если
   compatible ready issue есть, а target пропущен, запиши один durable blocker:
   exact interval, причина, evidence и resume predicate; очисти его при refill.
   Не превращай это в heartbeat/telemetry.
4. После каждого dispatch, execution terminal/feature-ready transition,
   dependency unlock, исключения feature или изменения limit немедленно
   пересчитай ready-set по `EXECUTION_INDEX`, не по live claims.
5. Если `running_count < sustained_issue_capacity`, сразу отдай следующий
   совместимый ready issue. Не жди завершения других workers, ingest или
   наполнения cutoff.
6. Используй priority/dependency/conflict ordering основного skill. Один
   same-path serial lane не должен оставлять свободным slot, если существует
   другая независимая issue.
7. Продолжай worker pool, пока `ACTIVE_CUTOFF` проходит дорогой global gate или
   продвижение. Новые ready receipts направляй в `OPEN_CUTOFF`.
8. При fused `workers=1` переключай coordinator между issue checkpoint и
   cutoff duties; не оставляй issue worktree в недетерминированном состоянии.

## Вести OPEN_CUTOFF и один ACTIVE_CUTOFF

1. Держи один mutable `OPEN_CUTOFF`: принимай только fresh `ready`
   receipts с доказанными refs, ancestry, dependencies и scope.
2. На ingest выполняй только дешёвые gates: merge preflight, conflict review,
   `git diff --check` и affected tests. Не запускай full suite, global CI или
   deploy на каждую feature.
3. После pass одним fenced checkpoint продвинь train ref и запиши
   `OPEN_CUTOFF` timer/size/count плюс feature integration state по
   [receipts.md](receipts.md); порядок восстанавливается из train commits.
4. Держи не более одного immutable `ACTIVE_CUTOFF`. При trigger и отсутствии
   active cutoff запечатай точный dependency-closed состав и сразу начни
   [batch-release.md](batch-release.md).
5. Не жди in-flight workers после sealing. Их receipts остаются для следующего
   `OPEN_CUTOFF`, даже если пришли через секунду.
6. Пока active cutoff выполняется, продолжай cheap ingest. При первом trigger
   durable-защёлкни pending boundary: exact train head, ordered membership
   digest/count, reason и trigger time. Более поздние accepts принадлежат
   successor suffix и не меняют boundary.
7. После terminal active cutoff pending seal ticket имеет приоритет над late
   ready receipt, ingest и projection. Сначала создай immutable cutoff ref exact
   latched train head и membership; только затем обрабатывай late ingest. Если
   latched head больше не доказанным ancestor current train, freeze sealing.
8. Любая правка sealed source создаёт новую generation того же active cutoff.
   Не открывай второй global gate параллельно.

## Срабатывать по точным cutoff triggers

При первом eligible ingest зафиксируй:

```text
CUTOFF_SIZE = max(2, min(sustained_issue_capacity, 4))
MAX_WAIT = 5 minutes from first_eligible_at
```

Сохрани эти latched значения и `max_wait_at` в `RELEASE_RUN.OPEN_CUTOFF`;
restart/worker-limit change их не пересчитывает для уже непустого cutoff.

Проверяй triggers после каждого pool/cutoff event. Срабатывай по первому
истинному условию; timer не сбрасывай новым receipt и никогда не продлевай.

| Trigger | Точное условие | Состав и действие |
| --- | --- | --- |
| `size` | Eligible dependency-closed ready count `>= CUTOFF_SIZE` | Активируй oldest ordered compatible prefix размером до `CUTOFF_SIZE`. |
| `max_wait` | `now >= first_eligible_at + 5m` и OPEN непуст | Активируй все доступные compatible receipts, но не больше `CUTOFF_SIZE`; не жди остальных. |
| `pool_idle` | Fresh scope показывает `running_count=0` и `dispatchable_count=0`, OPEN непуст | Активируй сразу, без grace period. |
| `urgent` | Ready Urgent issue, stabilization fix или rollback candidate | Активируй сразу минимальный dependency-closed urgent set; unrelated receipts оставь OPEN. |

Если `ACTIVE_CUTOFF` занят, сохрани самый ранний trigger time/reason вместе с
exact train head и membership digest/count. После terminal active state seal
этот prefix раньше любого late ingest; поздний suffix остаётся новым OPEN.
Никогда не жди час, ожидаемый worker ETA или «полную волну». Dependency, которой
ещё нет в ready receipts, не входит в cutoff и не задерживает независимый prefix.

## Хранить явное health state

### Integration и dispatch health

| Integration state | Разрешено | Переход |
| --- | --- | --- |
| `open` | Cheap ingest, sealing и один active global gate | Начальное состояние после recovery без противоречий. |
| `validating` | OPEN ingest и один ACTIVE_CUTOFF | Возврати `open` после terminal result либо `frozen` при systemic/unknown failure. |
| `publishing` | OPEN ingest; только active cutoff владеет default/deploy lane | Terminal publish возвращает `open` либо переводит default в bad/stabilizing. |
| `frozen` | Только read-only evidence, recovery и stabilization decision | Не ingest-и, не seal-и, не push/deploy. Dispatch регулируй отдельно. |

| Dispatch mode | Разрешено |
| --- | --- |
| `open` | Обычный work-conserving refill. |
| `good-base-only` | Только доказанно независимые issue branches от `LAST_KNOWN_GOOD_DEFAULT`. |
| `stabilization-only` | Только issue/fix, восстанавливающие default/live health. |
| `frozen` | Не dispatch-и; in-flight workers останови на ближайшем bounded receipt. |

### Default health

| State | Правило |
| --- | --- |
| `unknown` | Recovery ещё не доказал exact remote/default/live state; mutations запрещены. |
| `healthy` | Exact expected default подтверждён; promotion допустим по cutoff protocol. |
| `pending` | Один candidate уже продвинут и ждёт terminal gates; второй default push запрещён, OPEN/refill продолжаются. |
| `drifted` | Remote default не равен expected SHA; promotion заморожен до reconciliation и новой sealed generation. |
| `known-bad` | Дефект current default/live воспроизведён; integration заморожена, dispatch только `good-base-only` либо `stabilization-only`. |
| `stabilizing` | Активен ровно один urgent fix/revert cutoff; normal cutoff не продвигай. |

Не называй default `healthy` по отсутствию сигнала. После `known-bad` верни
его в `healthy` только по exact stabilization evidence из cutoff protocol.
`PROMOTION_HOLD=<hold-id>:foreign-main:*` запрещает integration ingest/seal/global gate,
default/deploy/tag/Done независимо от `HEALTH`; task-owned feature refs и
dispatch остаются `open|good-base-only|frozen` по доказанному overlap из
[external-main.md](external-main.md).

## Соблюдать durable HOLD и PAUSE

1. Любое временное ограничение shared либо issue lane записывай в repo-global
   ledger до остановки как exact scoped record: `id`, `kind=HOLD|PAUSE`, scope,
   reason, evidence, resume predicate, confirmation requirement, created action
   и state. Linear comment — только projection этого record.
2. `HOLD` снимается отдельным expected-old CAS только после machine-checkable
   resume predicate и fresh evidence. Timeout, новый turn или отсутствие нового
   сигнала predicate не доказывают.
3. `PAUSE confirmation_required=yes` требует и predicate evidence, и явное
   подтверждение пользователя после создания pause. Сохрани digest/ID этого
   подтверждения в lift action. Goal auto-continuation, `get_goal`, compaction,
   resume той же task и повторный preflight подтверждением не являются.
4. В начале каждого turn и перед каждой shared mutation проверь активные scopes.
   Не выполняй запрещённое действие и не создавай заменяющий action ticket до
   durable lift. Незатронутые branch lanes продолжай только при доказанной
   независимости.
5. `PROMOTION_HOLD` остаётся compact summary, но ссылается на exact durable hold
   ID. Unknown/contradictory hold index fail-closed для affected scopes.

## Выбирать действие по классу дефекта

| Класс | Немедленное действие | Pipeline |
| --- | --- | --- |
| Feature-local / same-scope | Верни исходную issue в тот же scope, создай descendant repair ref с новым claim generation, supersede receipt; не создавай Bug по умолчанию. | Исключи feature и зависимых descendants из cutoff; независимые workers и cutoff продолжай. |
| Tiny integration repair | Coordinator делает один минимальный fenced integration-fix commit и affected check. | Reseal новой generation и выполни один новый global gate; не повторяй feature gates остальных refs. |
| Independent или complex bug | Deduplicate и создай linked Bug по [defect-triage.md](defect-triage.md); отдай отдельному issue worker. | Блокируй только виновный scope/dependencies; исключи его и выпускай независимое. |
| Systemic, unattributed integration или second-generation | Зафиксируй evidence и recursion guard; не генерируй следующий fix автономно. | `integration=frozen`; dispatch оставь `good-base-only` лишь при доказанной независимости, иначе `frozen`; default push/deploy запрещены. |
| Known-bad default/live | Поставь `default=known-bad`, затем собери минимальный urgent stabilization fix/revert. | Заморозь integration; разреши `good-base-only` branch work и один `stabilizing` cutoff по [batch-release.md](batch-release.md). |

Targeted flake повторяй ровно один раз на неизменённом SHA. Terminal full-gate
`GATE_RESULT` того же key не rerun-и: исправление/изменённая среда требует новой
sealed generation/key. Не превращай необъяснённый результат в pass и не
маскируй известный fail как `not-available`.

## Восстанавливаться без двойной мутации

Полностью выполни [crash-recovery.md](crash-recovery.md). Сначала разреши owner,
durable HOLD/PAUSE, pending action/projection batch и terminal `GATE_RESULT`, при
takeover CAS-fence-ни все indexed/run-scoped guard refs, затем inventory/
adoption. Новый epoch сам по себе не делает прошедший ранее worker precheck
достаточным fence; terminal guard делает его atomic publication невозможной.
Claim generation остаётся per-run/per-issue monotonic.

Если stale session обнаружила другой owner/epoch, она прекращает mutations и
возвращает bounded handoff; локальный прогресс сохраняет без публикации.

## Оставлять только минимальные receipts

Пиши receipts только на содержательных переходах: acquisition/takeover,
fenced dispatch, sealed cutoff, terminal gate/default/release result,
recovery contradiction и completion. Обновляй существующий key idempotently по
[receipts.md](receipts.md).

Не записывай poll, heartbeat loop, worker utilization, ETA, queue telemetry,
полные logs или command-by-command history. Action commits в coordinator ref —
fencing ledger, а не повод дублировать каждый action Linear comment-ом.

При конфликте целей выбирай в этом порядке: **reliability**, затем
**flexibility**, затем **performance**.
