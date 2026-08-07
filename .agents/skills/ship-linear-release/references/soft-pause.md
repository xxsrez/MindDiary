# Мягкая остановка и возобновление

Читай при явной просьбе пользователя остановить/поставить Goal на паузу, при
client pause signal и при recovery состояния `draining|settling|quiescent`.
Это отдельный lifecycle, а не вариант `blocked` и не аварийное прерывание.
Coordinator проверяет model-visible Goal status один раз в начале каждого
доставленного goal turn и реагирует до следующего dispatch/shared action. Если
client полностью не доставил model turn, выполнить drain до следующего turn
технически невозможно; не заявляй фоновый watcher, которого runtime не даёт.

## Единственная state machine

`STATE`, `OWNER_STATE`, `LIFECYCLE`, `EXECUTION_INDEX`, `WORKERS`, `PAUSE`,
`HOLD_PAUSE_INDEX` и `PENDING_ACTIONS` — согласованные projections одного
состояния. Не редактируй их отдельными shell snippets или generic
`transition`. Все три перехода выполняет только `shipctl.py soft-pause`.

| Phase | Durable projection | Разрешено |
| --- | --- | --- |
| `running` | owner active, user pause lifted, обычный scheduler | Обычная работа. |
| `draining` | `STATE=pausing`, active user PAUSE, прежний `running_count>0` | Запретить dispatch/refill/new claims/new cutoffs; workers идут до ближайшего bounded checkpoint. |
| `settling` | тот же owner, `running_count=0`, все прежние executors имеют disposition | Завершать только уже-ready work и active external effect; не начинать новую issue. |
| `quiescent` | `STATE=checkpoint`, owner `handoff-ready`, PAUSE `all-shared`, no running/pending effect | Никаких mutations; вернуть управление пользователю. |
| `recovering` | новый epoch после takeover, pause lifted, guards ещё под fencing | Только canonical recovery. |

Любое несовпадение projections даёт read-only `recovery`, а не догадку о
намерении. Последний `ACTION_KIND` не является lifecycle: reconciled
bookkeeping descendant не отменяет quiescent handoff.

## Начать drain

Сразу после pause signal, до сообщений workers и до новой shared mutation,
вызови:

```text
python3 .agents/skills/ship-linear-release/scripts/shipctl.py soft-pause \
  --repo <repo> --remote origin --default <default> --phase start \
  --input <json>
```

Input:

```json
{"evidence_digest":"<sha256 exact user/client pause signal>"}
```

Helper требует current owner proof, coherent operating ledger и exact
execution vector; одним expected-old CAS создаёт PAUSE и переводит lifecycle в
`draining`, либо сразу в `settling`, если running executors уже нет. Повтор
exact request идемпотентен. Same owner может начать drain из
`route=recover-owner` только после завершённого guard fencing: `RECOVERY.phase`
равен `inventory|complete`, latest action reconciled и `PENDING_ACTIONS=none`.
Фазы `fencing` и pending recovery action сначала доводи до безопасной границы;
soft-pause не должен оставлять stale worker authority unfenced. После success:

- не dispatch-и, не refill-и, не создавай новые claims/cutoffs;
- сообщи каждому running worker soft-stop: закончить только текущую атомарную
  операцию, не начинать следующую, не выполнять full gate/Linear/default;
- попроси bounded disposition с exact issue/generation, state, HEAD либо
  `none` и evidence digest;
- `feature_ready` сохраняет ready ref/guard; `coordinator-paused` сохраняет
  чистый commit/worktree; `stopped` означает отсутствие незавершённой мутации;
- не interrupt-и worker, пока он отвечает и движется к checkpoint. Interrupt
  допустим только после runtime failure/неответа, затем его grant остаётся
  fenced recovery input, а не считается clean stop.

## Зафиксировать worker dispositions

Когда каждый executor из исходного running vector ответил либо получил
доказанный terminal disposition, вызови `--phase checkpoint` с exact полным
набором:

```json
{
  "dispositions": [
    {
      "issue": "AND-47",
      "generation": 2,
      "state": "coordinator-paused",
      "head": "<full SHA or none>",
      "evidence_digest": "<sha256 bounded receipt>"
    }
  ]
}
```

Разрешённые terminal execution states: `coordinator-paused`, `feature_ready`,
`failed`, `needs-input`, `stopped`. Missing, duplicate, extra либо malformed
entry запрещает CAS. Helper атомарно записывает zero-running execution vector,
checkpoint digest и `LIFECYCLE.phase=settling`.
Если `start` сразу вернул `settling`, checkpoint не вызывай.

## Довести готовое и завершить pause

В `settling` coordinator:

1. reconciliate уже начатый external effect;
2. ingest/finish только feature, которая стала `ready` до/во время drain;
3. если ready subset можно безопасно seal/gate/publish/CI/Done — довести его до
   terminal evidence;
4. незавершённые feature branches/worktrees не дорабатывать и не удалять;
5. если ready work нельзя закончить из-за durable known-bad/foreign-main/HOLD,
   сохранить его как `ready_preserved` с exact blocker.

Ready authority определяется `EXECUTION_INDEX state=feature_ready`, а не
одноимённым compatibility-полем `WORKERS.ready_preserved`: старые ledgers могли
перечислять там quarantined/stopped artifacts, которые надо сохранить, но не
надо завершать во время pause settlement.

Не открывай новую issue ради освобождения cutoff и не считай паузу причиной
обхода gate/CI. Когда active cutoff/gate и `PENDING_ACTIONS` отсутствуют, вызови
`--phase finish`:

```json
{"settlement":"complete","evidence_digest":"<sha256 settlement evidence>"}
```

Либо, только при существующем durable blocker:

```json
{"settlement":"preserved-blocked","evidence_digest":"<sha256 blocker evidence>"}
```

`complete` запрещён при `ready_preserved` или open cutoff;
`preserved-blocked` запрещён без durable HOLD/PROMOTION_HOLD/known-bad health.
Helper делает `quiescent`, расширяет PAUSE до `all-shared`, переводит owner в
`handoff-ready` и оставляет worktrees/feature refs для следующего execution.

После этого останови coordinator turn. Не вызывай `update_goal(blocked)`:
Goal остаётся resumable через client control. Не проси пользователя вручную
делать takeover или печатать magic phrase.

## Возобновить

Fresh explicit online invocation этого skill после quiescent PAUSE является
resume confirmation. Preflight возвращает `route=takeover`; первый mutable call
— `shipctl.py takeover`. Expected-old CAS выбирает одного successor, поднимает
epoch, атомарно снимает только user PAUSE/index entry и переводит lifecycle в
`recovering`. Остальные HOLD/PROMOTION_HOLD сохраняются. Затем fence guards,
inventory и обычный crash recovery.

Если phase всё ещё `draining|settling`, чужая session остаётся read-only. Same
owner получает только `soft-pause-drain-and-settlement-only`; он не может
возобновить normal dispatch до quiescent handoff и нового takeover epoch.

## Goal `blocked` не является pause

Не вызывай `update_goal(blocked)` для user/client pause, drain, running worker,
pending CI/gate, recoverable CAS race или ожидаемой краткой maintenance-правки
control surface. Три быстрых auto-continuation с тем же неизменным fingerprint
считай одним наблюдением, а не тремя независимыми blocker turns.

`blocked` допустим только для действительно устойчивого внешнего impasse:
требуется user input/external state, нет безопасной независимой работы, есть
три fresh последовательных наблюдения на естественных границах. Для transient
dirty contract/control surface дополнительно должно пройти не менее пяти минут
с первого наблюдения без подтверждённого progress. Иначе bounded wait/recheck
или мягкий handoff, но не terminal Goal state.
