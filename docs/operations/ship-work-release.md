# Как управлять `ship-work-release` из Codex Desktop

Статус: accepted operator runbook к
[канонической спецификации](../specs/ship-work-release.md), 2026-08-09.

Документ показывает UX глазами пользователя: как запустить
большой work scope, видеть прогресс, попросить «дойти до точки с запятой»,
получить очередной UAT deployment, поменять orchestration между cohorts и
безопасно продолжить работу.

## Короткая модель

У flow четыре рабочие границы и отдельная production promotion:

```text
writer checkpoint → sealed batch + localhost dev smoke
                  → UAT cut → scope UAT release
                  → [отдельный manual production workflow, не этот skill]
```

- **Checkpoint** — быстро сохранить текущие хвосты. Gate и deploy не запускаются.
- **Batch** — интегрировать готовое, выполнить full gate, поднять exact
  candidate на localhost и проверить всё доступное в dev.
- **UAT cut** — опубликовать candidate в отдельную prod-like UAT environment и
  проверить hosted live flows.
- **Scope UAT release** — доказать полный acceptance work scope в UAT.
- **Production release** — отдельная ручная promotion после явного prompt и
  confirmation владельца; `ship-work-release` её никогда не выполняет.

Exact commands, integration branch, CI, dev launcher, UAT target и evidence
matrix берутся из tracked project delivery profile. Default path profile —
`docs/operations/ship-work-release-profile.md`. Run fail closed, если
обязательные project values отсутствуют или противоречат repository
instructions.

Отдельно существует **cohort** — версия самого orchestration flow. Cohort не
определяет product scope и не создаётся в task manager.

## 1. Запуск

Обычный запуск:

```text
$ship-work-release
```

Он означает:

- начать с одного связного writer lane;
- при необходимости использовать read-only scouts;
- подключать дополнительные writable lanes только после проверки реальной
  независимости;
- сохранить acceptance из task manager и repository contracts;
- перед каждым UAT cut запустить exact candidate через project-profile dev
  launcher и выполнить declared local smoke;
- по умолчанию release-ить только в UAT;
- никогда не deploy-ить production;
- показывать compact progress в Codex и durable product facts в task manager.

Если нужно явно запретить writable parallelism:

```text
$ship-work-release lanes=1
```

Если вы хотите эксперимент с adaptive capacity:

```text
$ship-work-release lanes=auto max=3
```

Если для эксперимента важно иметь exact resource capacity:

```text
$ship-work-release lanes=3
```

`lanes=3` не обещает, что три work items всегда будут выполняться одновременно.
Dependency graph может оставить только одну-две совместимые ready tasks. Команда
требует лишь, чтобы runtime и локальные ресурсы могли устойчиво обслуживать три
lanes, когда такая frontier существует.

`workers=3` является compatibility alias `lanes=3`.

## 2. Что должно появиться сразу после запуска

До первой write mutation coordinator показывает run card:

```text
work scope: 0.2
task management: example-adapter / example-collection
contract: 7b1d4a2 / cohort c01
router: single writer + scouts on demand
durability: durable before first external effect
work items: 18 total, 7 unfinished, 3 ready
release: continuous-uat
review: manual
next: WI-201 in primary checkout
```

Default cadence показывает project delivery profile. `manual-uat` и
`continuous-uat` меняют cadence, но не target. Production не является
допустимым значением.

Это позволяет сразу увидеть:

- какой work scope и exact contract выбраны;
- почему включён single или parallel mode;
- сколько product work реально готово;
- будет ли skill делать регулярные UAT cuts;
- включён ли автоматический review;
- какое действие будет следующим.

Если карточка противоречит вашему намерению, отправьте correction до того, как
run начал mutation. Например:

```text
config lanes=1
config release=manual-uat
```

Coordinator должен подтвердить новое нормализованное значение.

## 3. Как следить за работой

### 3.1 Обычные updates

Skill не должен печатать каждый poll и raw log. Он сообщает meaningful
transitions:

- выбран work item или изменилась router topology;
- feature стала ready;
- batch зафиксирован;
- начался или закончился full gate/CI;
- начался или закончился UAT deploy/live smoke;
- принят pause request;
- возник blocker или recovery;
- run достиг quiescent/terminal state.

Если meaningful transition долго нет, приходит короткий heartbeat. Минимальная
verbosity поэтому остаётся спокойной, но не превращается в «что-то происходит,
смотрите только в task manager».

### 3.2 Команда `status`

В основной task отправьте отдельной строкой:

```text
status
```

Ожидаемый ответ:

```text
run: work scope 0.2 / cohort c03 / contract abc1234
mode: parallel, 2 lanes / durable / review=manual
work items: 18 total, 7 unfinished, 3 ready
lanes: 2 running, 0 feature-ready, 1 available
batch: u04 open, 2 work items, candidate none
gate: idle
UAT: 0.2-u03 live, exact 4ac91e2, observation=pending-owner-observation
pause: none
pending external effects: none
next safe boundary: 2 writer checkpoints
```

Для диагностики можно запросить:

```text
status verbose
```

Verbose status остаётся bounded: он не должен выгружать полный ledger,
transcript или неограниченные logs.

### 3.3 Side task

Codex Desktop позволяет открыть side task командой `/side`. Это удобно, если
вы хотите прочитать snapshot и не перебивать основной ход работы. В side task
следует просить только `status` или объяснение текущего state.

Side task:

- не становится coordinator-ом;
- не делает takeover/recovery;
- не меняет task manager/Git/UAT target;
- не отправляет pause/resume;
- читает только доступный durable snapshot.

Если run ephemeral или durable snapshot этой session недоступен, side task
должен сообщить ограничение; authoritative `status` тогда запрашивается в
основном task.

Управляющие сообщения всегда отправляются в основной task. Возможности Goal,
follow-up steering и side tasks описаны в официальной документации
[Long-running work](https://learn.chatgpt.com/docs/long-running-work) и
[Slash commands](https://learn.chatgpt.com/docs/reference/slash-commands).

## 4. «Дойди до точки с запятой»

Каноническая команда:

```text
pause=checkpoint grace=5m
```

Её смысл:

1. больше не брать новые work items и не запускать scouts;
2. дать каждому writer-у до пяти минут дойти до ближайшей атомарной точки;
3. сохранить clean commit/receipt, если это возможно;
4. при истечении grace сохранить и fence-ить незавершённый branch/worktree;
5. reconcile уже начатый внешний effect, но не повторять его;
6. остановиться в `QUIESCENT`;
7. не начинать только ради остановки integration, full gate, CI или deploy.

Сразу после команды вы должны увидеть acknowledgement:

```text
pause accepted: checkpoint
dispatch: closed
running lanes: 2
grace deadline: 12:35:00Z
deadline enforcement: active
next update: first checkpoint or deadline
```

Финальный ответ для такой остановки:

```text
PAUSE_READY / QUIESCENT
completed checkpoints: lane-1
preserved/fenced: lane-2 at branch codex/lane-2
open batch: unchanged, not gated
pending external effects: none
resume action: preflight + adopt preserved lane-2
```

Это и есть технический смысл «закрой по возможности хвосты и плавно
остановись»: pause не превращается в неожиданную release procedure.

## 5. Остановиться после проверенного batch

Команда:

```text
pause=batch grace=5m
```

Coordinator:

1. немедленно запрещает новый dispatch;
2. фиксирует уже ready work items и текущий атомарный work item каждого active lane;
3. drains active lanes с deadline;
4. включает receipt active work item, только если он достиг checkpoint до
   deadline; более поздние artifacts оставляет следующему batch;
5. интегрирует latched set;
6. запускает один full repository gate;
7. запускает exact candidate через project-profile dev command и выполняет
   declared local smoke;
8. expected-old продвигает candidate в configured authoritative remote
   projection и ждёт required exact-SHA CI;
9. останавливается до UAT deployment.

Результат — exact sealed candidate, уже опубликованный в Git, но ещё не в
UAT. Это удобная граница, если вы хотите посмотреть diff/evidence до hosted
release. Если project profile использует CI на immutable candidate ref без
продвижения integration branch, status показывает выбранную projection.

`pause=batch` означает «published to configured authoritative remote, но не
deployed to UAT». Это не local-only boundary: exact-SHA CI является частью
контракта. Если нельзя делать remote effect, используйте `pause=checkpoint`.

`pause=batch` не означает, что human/LLM review запустится автоматически.
Review выполняется только по выбранной policy или отдельной команде.

`grace=5m` ограничивает drain writers, а не весь путь до batch boundary. Full
gate, dev smoke и CI имеют собственные timeouts и могут закончиться позже;
status должен показывать их отдельную phase/deadline.

## 6. Остановиться после следующего UAT cut

Команда:

```text
pause=uat grace=5m
```

Она включает путь `pause=batch`, затем:

- deploy exact candidate в project-profile UAT target;
- declared baseline live smoke;
- declared conditional/changed-surface smoke;
- сохранение target/deployment identity, resolved URL и rollback target;
- остановку в `QUIESCENT`.

Это самый естественный способ сказать: «доработай ближайший осмысленный кусок,
покажи его мне живьём и остановись».

В status будет одновременно видно:

```text
environment: uat
profile: example-project
target: configured-uat-class
evidence class: uat-live
cut: 0.2-u04
observation: pending-owner-observation
work scope: still in progress
```

Такой cut не доказывает flows, actors или capabilities вне сохранённой evidence
matrix. Он не завершает work scope автоматически.

Automated smoke не означает, что вы уже посмотрели UAT. После
`pause=uat` skill останавливается в `pending-owner-observation`; после осмотра
можно отправить `uat verdict=observed` или `uat verdict=rejected`.

Здесь `grace` также относится только к writers. Deployment и live smoke имеют
отдельные bounded timeouts, поэтому для самой быстрой остановки выбирайте
`pause=checkpoint`.

## 7. Получить UAT cut и продолжить

Если останавливаться не нужно:

```text
uat=now
```

Skill фиксирует текущий meaningful batch, проверяет и публикует его, затем
продолжает normal run. Если новых integrated product changes нет, пустой cut не
создаётся: coordinator отвечает, почему deploy пропущен.

При policy:

```text
release=continuous-uat
```

skill сам делает cuts на meaningful boundaries. Meaningful — это наблюдаемый
vertical slice, risk/dependency boundary или накопленный связный batch, а не
каждый маленький work item.

В continuous mode следующий cut может заменить live version до ручного
осмотра предыдущего. Тогда предыдущий receipt получает
`superseded-unobserved`; документация не утверждает, что владелец его принял.

Пример серии:

```text
0.2-u01  onboarding shell
0.2-u02  membership control
0.2-u03  API history reads
0.2-u04  export flow
0.2      complete work scope acceptance
```

Все cuts идут в одну UAT environment. Каждый новый successful deployment
заменяет предыдущую live version, но receipt сохраняет last-known-good rollback
target.

## 8. Дойти до конца work scope

Команда:

```text
pause=scope
```

Название означает «остановись после work scope», а не немедленный drain.
Coordinator продолжает normal dispatch, batches и UAT cuts, пока не выполнены
все условия:

- каждый work item удовлетворяет acceptance;
- parent/dependency closure reconciled;
- final exact SHA прошёл полный gate и CI;
- обязательное live evidence собрано;
- claims и pending effects отсутствуют.

Только после этого он объявляет scope UAT release и становится quiescent.

Если remaining frontier реально blocked, он остановится раньше и объяснит
blocker; `pause=scope` не разрешает обходить security или release gates.

### 8.1 Production после work scope

Scope UAT release не запускает production promotion. Terminal report только
сохраняет exact candidate SHA, UAT evidence, gaps и production handoff status.

Если пользователь пишет `release to production`, `prod`, «прод» или
«продакшн» внутри этого skill, coordinator отвечает отказом: production —
отдельная manual environment и отдельный workflow. Нужны явный новый prompt,
проверка полного UAT acceptance, exact artifact identity, production target,
rollback plan и повторное confirmation непосредственно перед external effect.
Project delivery profile сообщает, configured ли production и где находится
его отдельный promotion runbook.

## 9. Resume

После graceful pause в основном task отправьте:

```text
resume
```

Перед новым dispatch skill:

1. повторит bounded preflight;
2. проверит owner epoch и pinned contract;
3. инвентаризирует preserved lanes и late artifacts;
4. reconciles local/remote integration branch и внешние effects;
5. подтвердит batch/candidate/UAT state;
6. снимет только user pause.

Technical blocker, known-bad hold или rejected UAT не исчезают от `resume`.
Если предыдущий run был ephemeral и task/session потеряна, cross-session resume
не гарантируется.

## 10. Goal Pause в Codex Desktop

Goal Pause — hard client pause, а не надёжная команда graceful drain.

Предпочтительная последовательность:

```text
1. Отправить pause=checkpoint|batch|uat
2. Дождаться QUIESCENT
3. Нажать Goal Pause, если нужно освободить/закрыть task
```

После drain coordinator показывает `PAUSE_READY`. Skill не может сам нажать UI
Pause: это отдельное действие владельца в Desktop. Если Goal успеет получить
automatic continuation turn между `PAUSE_READY` и кликом, он обязан остаться
read-only в canonical `QUIESCENT`, без повторного settlement или dispatch.

Если нужно остановить Codex немедленно, Goal Pause допустим. Но coordinator
может не получить нового model turn и не увидеть request. После Resume такой
run сначала считается recovery case: skill не dispatch-ит новое, пока не
проверит worktrees, claims, integration branch, contract и начатые внешние
effects.

Если grace deadline прошёл, но runtime был полностью остановлен, status должен
честно сказать:

```text
deadline passed; enforcement pending next model turn
```

Документация не обещает скрытый persistent daemon. Bounded grace считается
гарантией только когда acknowledgement показывает active coordinator
timer/runtime callback; иначе run не может заявить graceful `QUIESCENT`.

## 11. Как cohorts выглядят технически

Cohort не нужно оформлять в task manager. Он появляется автоматически, когда run
фиксирует exact orchestration bundle `contract_sha`. Отдельный
`contract_source_sha` показывает Git commit, из которого разрешён bundle:

```text
cohort c01: contract 1a2b3c4
  WI-201 → batch u01
  WI-202 → batch u01

cohort c02: contract 5d6e7f8
  WI-203 → batch u02
  WI-204 → batch u02
```

Work item receipts содержат `contract_sha`, `cohort_id`, lane, base/head SHA и
checks. Поэтому позже можно сравнить скорость и ошибки flow versions без
nested work scopes или служебных work items.

Один batch может включать два compatible policy cohorts, если новый contract
принимает старые receipts и весь candidate заново проверен. Изменения
state/authority/recovery contract требуют отдельной migration и обычно нового
batch.

## 12. Быстро обновить orchestration между cohorts

После подготовки новой tracked версии flow:

```text
flow=upgrade 5d6e7f8
```

Skill должен:

- закрыть dispatch;
- достичь quiescent boundary;
- проверить отсутствие pending external effects;
- классифицировать diff как telemetry/policy, execution protocol или
  authority/state change;
- выполнить соответствующий smoke/migration;
- разрешить полный bundle, сохранить его content identity `contract_sha` и
  source commit `contract_source_sha`;
- начать новый cohort;
- продолжить product delivery, только если upgrade был запрошен из running
  state.

Если вы сначала сделали `pause=checkpoint`, user pause сохраняется после
upgrade и снимается только отдельным `resume`. Если `flow=upgrade` отправлен во
время running, skill сам делает временную quiescent boundary и возвращается к
прежнему running intent после успешной проверки.

Не требуется замораживать orchestration на весь work scope. Также не требуется
обязательный review после каждого маленького cohort. Ограничение другое:
running writers не должны читать наполовину изменённый skill, а incompatible
state change нельзя применять без migration.

Product code и orchestration code лучше держать отдельными commits. Если вы
намеренно хотите проверить их вместе одним UAT cut, скажите это явно; receipt
должен перечислить обе причины изменения. Это помогает понять, что сломалось,
не замедляя hobby iteration до больших formal release cycles.

## 13. Что видно в task-management system

Task-management system остаётся product control surface. Конкретные remote
fields и operations определяет выбранный adapter, но пользователь всегда видит:

- normalized status каждого work item;
- durable feature, integration и release evidence;
- blockers и dependency/parent closure;
- одну обновляемую compact run card, если adapter поддерживает scope-level
  projection.

Автоматически не создаются cohort scopes, batch items, worker items,
updates на каждый poll/heartbeat или служебные state-machine entities.

Связь восстанавливается из receipts:

```text
work item → cohort/contract → batch → exact candidate → UAT cut/release
```

Work item может получить normalized status `done` после промежуточного UAT cut,
если его acceptance и обязательный evidence полностью выполнены. Work scope при
этом остаётся открытым. Single-principal smoke не закрывает work item, которому
нужен другой principal или multi-principal proof.

## 14. Review остаётся опциональным

Default:

```text
review=manual
```

Это значит: ни cohort, ни batch сами по себе не запускают reviewer-а. Tests,
full gate, CI и release evidence остаются обязательными; review — отдельная
диагностическая процедура.

Варианты:

```text
review=on-anomaly
review=uat
review=final
```

`on-anomaly` должен иметь заранее видимые triggers: unexpected cross-cutting
diff, ownership violation, repeated failure, merge conflict, security/auth
surface, state incoherence или failed live smoke.

Если repository contract прямо требует review, пользовательская default policy
не может его отменить.

Разовый review запускается без смены policy:

```text
review=now scope=batch
review=now scope=item:WI-203
review=now scope=sha:4ac91e2
```

Reviewer читает exact snapshot и возвращает findings. Он не получает mutation
authority, а исправления выполняет обычный writer lane.

## 15. Настройка работающего run

Некоторые policies можно менять follow-up сообщением без нового Goal:

```text
config lanes=1
config lanes=auto max=2
config release=continuous-uat
config review=on-anomaly
```

Capacity меняется на checkpoint: сокращение drains лишние lanes, расширение
снова проходит admission gate. Release/review policy применяется со следующей
подходящей boundary и не меняет acceptance. Coordinator подтверждает старое и
новое значение и момент применения.

## 16. Как понимать UAT evidence

После каждого cut skill показывает не только «deploy успешен», но и точную силу
утверждения:

```text
proved:
- baseline-flow: passed
- persistence-flow: passed
- changed-api-flow: passed
- conditional-compatibility-flow: not-run, unchanged surface

not proved by this cut:
- second-actor acceptance
- alternate-role boundaries
- non-member access
- generalized usability
```

UAT environment и evidence class — разные поля. Частые UAT deployments дают
владельцу реальный контроль, но не создают ложное production claim.

## 17. Rollback после неудачного cut

Если live smoke или ваше наблюдение провалилось:

```text
uat verdict=rejected
rollback=last-stable
```

Первая rollback-команда ничего не меняет. Skill сначала устанавливает
фактический current deployment и показывает exact from/to plan:

```text
rollback plan: rb-017
from: UAT deployment d104 / SHA bad1234
to: UAT deployment d103 / SHA good987
confirm with: rollback=confirm rb-017
```

Только explicit confirmation выполняет повторный reconciliation, продвижение
previous known-good UAT deployment/exact SHA и bounded smoke. Если current state
успел измениться, confirmation ID становится недействительным и строится новый
plan.

Rollback:

- меняет live UAT deployment;
- не удаляет commit из integration branch;
- не является `git revert`;
- сохраняет from/to deployment IDs и причину;
- создаёт defect/blocker routing для исправления.

Вслепую повторять deploy после потерянного acknowledgement запрещено.

## 18. Типовые сценарии

### Спокойная последовательная работа

```text
$ship-work-release lanes=1 release=continuous-uat
status
pause=uat grace=5m
```

Результат: один writer, несколько связных work items, один meaningful UAT cut и
остановка на живой версии.

### Две действительно независимые ветки

```text
$ship-work-release lanes=auto max=2
```

Router показывает admission rationale. Если ready work пересекается по файлам
или общему решению, он остаётся на одном writer-е — это нормальный результат, а
не недоиспользование slots.

### Быстрая остановка без дорогого gate

```text
pause=checkpoint grace=3m
```

Результат: dispatch закрыт, хвосты committed/preserved, gate и deploy не
начинаются.

### Посмотреть candidate до UAT

```text
pause=batch
```

Результат: exact candidate + full gate/CI, но live Site не меняется.

### Обновить сам flow внутри work scope

```text
pause=checkpoint
flow=upgrade 5d6e7f8
resume
```

Результат: новый cohort с preserved product progress, без scope-long
freeze.

### Emergency stop

Нажать Goal Pause. После Resume не требовать немедленного продолжения; сначала
дождаться recovery status и coherent state.
