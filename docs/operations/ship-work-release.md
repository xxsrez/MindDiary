# Как управлять `ship-work-release` из Codex Desktop

Статус: accepted operator runbook к
[канонической спецификации](../specs/ship-work-release.md), 2026-08-09.

Для Mind Diary с 2026-09-09 объём UAT проверок выбирается по
[профилю revision 9](ship-work-release-profile.md#обычный-uat-release-соразмерная-приёмка).
Описанные ниже полные gates и матрицы — расширенный режим, не default для
каждого релиза. Это уточнение распространяется и на возобновление checkpoint.

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

`$ship-work-release` — invocation skill-а в текущем Codex task. Это не
plain-text control уже идущего run, не slash-command Codex и не кнопка Goal в
Desktop. Один invocation создаёт или однозначно находит один `run_id`; повторно
запускать skill для того же scope вместо `status`, `resume`, `handoff` или
`recover` нельзя. Исключение — документированные invocation forms для принятия
handoff или подготовки recovery в новом task.

Он означает:

- работать в coordinator-only режиме: coordinator сам является
  единственным worker-ом, субагент и отдельный worker worktree
  не создаются;
- при необходимости использовать read-only scouts;
- не подключать writable субагентов без явного capacity request;
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

`workers=3` является compatibility alias `lanes=3` и означает
ровно три worker-субагента плюс отдельный coordinator.
Каждый активный worker-субагент получает свой isolated writable
worktree. Coordinator не уменьшает это число; он отвечает за
интеграцию, canonical state и task-manager writes. Исключение —
default/`workers=1`: coordinator сам является единственным worker-ом без
субагента и без лишнего worktree.

### 1.1 Выбор scope без привязки к task manager

Default scope берётся из project delivery profile:

```text
$ship-work-release scope=profile-default
```

Для явного выбора используется provider-neutral selector, а выбранный adapter
разрешает opaque stable refs в свои entities:

```text
$ship-work-release scope=work-scope:<stable-ref>
$ship-work-release scope=items:<stable-ref-1>,<stable-ref-2>
```

Display name или приблизительный поиск не являются stable ref. Если selector
разрешается неоднозначно, adapter fail closed и показывает допустимые exact
refs без начала mutation. Run card всегда повторяет исходный selector,
нормализованный collection ref и полный resolved item count. Dependencies или
parent entities вне bounded selector не добавляются молча: coordinator
показывает closure gap и просит новый exact scope.

### 1.2 Четыре разные control surfaces

| Surface | Для чего она нужна | Чего она не делает |
| --- | --- | --- |
| `$ship-work-release ...` | Запускает новый run либо явно принимает handoff/recovery в новом task. | Не является командой pause/status уже идущего run. |
| Plain-text controls `status`, `pause=...`, `resume`, `config ...` | Управляют exact `run_id` через coordinator в основном task. | Не являются slash-commands приложения. |
| Slash-command `/side`, когда он доступен в клиенте | Открывает отдельный side task для read-only snapshot или объяснения. | Не pause-ит Goal и не передаёт authority. |
| Goal progress row и кнопки Pause/Resume/Edit/Clear | Управляют lifecycle самого Codex Goal в Desktop. | Не заменяют graceful delivery controls и не меняют canonical run state. |

В частности, plain-text `status run=<run_id>` — это status delivery flow.
Встроенный `/status` относится к Codex task/context и **не** показывает batches,
lanes, UAT cuts или pending effects.

### 1.3 Goal при запуске

Если invocation отправлен внутри Goal, созданного через `/goal` или
соответствующее действие Desktop, приложение показывает Goal progress row для
всего work scope. Skill сам не создаёт эту UI-строку: invocation в обычном task
остаётся обычным task и всё равно управляется plain-text controls.

До первой mutation run card обязан показать одно из значений `goal: active`,
`goal: not-active` или `goal: unknown`. Если progress row не появилась:

1. не запускайте `$ship-work-release` повторно;
2. отправьте в том же task `status run=<run_id>`;
3. если status показывает `goal: not-active`, продолжайте plain-text controls
   либо сначала доведите run до `QUIESCENT` и сделайте явный handoff в новый
   Goal;
4. если status показывает `goal: active`, но row не видна, delivery state всё
   равно читается через plain `status`; `/status` можно использовать только для
   диагностики самого Codex task, не как подтверждение состояния run.

Если сама run card потеряна и `run_id` неизвестен, read-only `status runs` в
том же task возвращает bounded список найденных active/quiescent run IDs. После
этого все controls снова адресуются одному exact ID.

## 2. Что должно появиться сразу после запуска

До первой write mutation coordinator показывает run card:

```text
run: run-7f31
goal: active
work scope: selector work-scope:ws-02 / resolved ws-02
task management: example-adapter / collection col-01
contract: 7b1d4a2 / cohort c01
router: single writer + scouts on demand
durability: durable before first external effect
deadline capability: active-callback
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
config run=run-7f31 lanes=1 control_id=cfg-001
config run=run-7f31 release=manual-uat control_id=cfg-002
```

Coordinator должен подтвердить новое нормализованное значение и `control_id`.

### 2.1 Адресация и acknowledgement controls

Каждый plain-text control, который может изменить run, адресуется точному
`run=<run_id>` и получает уникальный внутри run `control_id`. Достаточно
короткого понятного ID вроде `pause-uat-1`; UUID вручную не требуется. Если ID
не указан, coordinator обязан получить устойчивый ID из входящего сообщения и
сохранить его до первого effect, но для operator-critical commands явный ID
предпочтителен.

Первый ответ на control — короткий acknowledgement:

```text
control: pause-uat-1
run: run-7f31
normalized: pause=uat grace=5m
result: accepted
state revision: 184
next: draining 2 writers
```

Одинаковый `control_id` с тем же нормализованным payload идемпотентен: duplicate
не запускает второй drain, deploy, rollback или upgrade, а возвращает
сохранённый acknowledgement/result. Тот же ID с другим payload отклоняется как
conflict. Новый ID означает новое намерение пользователя.

Если acknowledgement потерялся, не отправляйте команду заново с новым ID.
Сначала запросите:

```text
status run=run-7f31 control=pause-uat-1
```

Если явного ID не было, используйте `status run=run-7f31 controls=recent`.
Повтор допустим только с прежним ID; если authoritative status подтверждает,
что control не был принят, следующая попытка получает новый ID. Такой
lost-ack protocol особенно обязателен для publish, UAT, rollback, authority и
task-manager mutations.

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
status run=run-7f31
```

Ожидаемый ответ:

```text
run: run-7f31 / state revision 184
snapshot: 2026-08-09T12:34:08Z / age 8s / authoritative
goal: active / task codex-task-91
work scope: ws-02 / cohort c03 / contract abc1234
mode: parallel, 2 lanes / durable / review=manual
work items: 18 total, 7 unfinished, 3 ready
lanes: 2 running, 0 feature-ready, 1 available
batch: batch-u04 open, 2 work items, candidate none
gate: idle
UAT: cut-0.2-u03 live, exact 4ac91e2
observations: cut-0.2-u03=pending-owner-observation
pause: none
holds: none
deadline capability: active-callback
phase deadline: none
controls: last applied cfg-002 / pending none
pending external effects: none
next safe boundary: 2 writer checkpoints
```

`snapshot` показывает время наблюдения и age, а не только время печати ответа.
Side task может вернуть `authoritative`, `cached` или `unavailable`; cached
snapshot всегда содержит исходную state revision и возраст. `goal` описывает
известное coordinator-у состояние Goal (`active`, `paused`, `not-active` или
`unknown`), но не подменяет UI приложения.

Для диагностики можно запросить:

```text
status run=run-7f31 verbose
```

Verbose status остаётся bounded: он не должен выгружать полный ledger,
transcript или неограниченные logs.

### 3.3 Side task

Codex Desktop позволяет открыть side task командой `/side`. Это удобно, если
вы хотите прочитать snapshot и не перебивать основной ход работы. В side task
следует просить только plain-text `status run=<run_id>` или объяснение текущего
state. `/side` открывает side task; он сам не является delivery status.

Доступность `/side` зависит от клиента и текущего режима. Если command нет,
это не ошибка delivery run: запросите plain `status` в основном task. Не
создавайте второй coordinator только ради отдельного status window.

Side task:

- не становится coordinator-ом;
- не делает takeover/recovery;
- не меняет task manager/Git/UAT target;
- не отправляет pause/resume;
- читает только доступный durable snapshot.

Если run ephemeral или durable snapshot этой session недоступен, side task
должен ответить без догадок:

```text
snapshot: unavailable
authority change: none
fallback: in the coordinator task send status run=run-7f31
```

Authoritative `status` тогда запрашивается в основном task. Если основной task
утрачен, side task всё равно не делает takeover: в новом основном task
используется двухфазный `recover` из раздела 9.2.

Управляющие сообщения всегда отправляются в основной task. Возможности Goal,
follow-up steering и side tasks описаны в официальной документации
[Long-running work](https://learn.chatgpt.com/docs/long-running-work) и
[Slash commands](https://learn.chatgpt.com/docs/reference/slash-commands).

## 4. «Дойди до точки с запятой»

Каноническая команда:

```text
pause=checkpoint run=run-7f31 grace=5m control_id=pause-checkpoint-1
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
control: pause-checkpoint-1
run: run-7f31
pause accepted: checkpoint
dispatch: closed
running lanes: 2
grace deadline: 12:35:00Z
deadline enforcement: active-callback
next update: first checkpoint or deadline
```

`grace` ограничивает только drain уже работающих writers. Закрытие dispatch
происходит сразу, а scouts, full gate, CI, dev smoke, deploy и live smoke не
получают из `grace` общий timeout.

Acknowledgement обязан показать одну из capability:

- `active-callback` — wall-clock deadline действительно будет применён;
- `turn-bound` — dispatch уже закрыт, но fence/checkpoint может примениться
  только на следующем model turn; это best-effort target, а не bounded pause;
- `unavailable` — coordinator не способен безопасно сохранить request и
  команда отклоняется без изменения run.

Без active callback нельзя молча обещать пяти минут. Если пользователь добавил
`require_deadline=true`, отсутствие `active-callback` отклоняет control. Без
этого флага безопасно сохранённая команда может быть принята как
`accepted-degraded` с `deadline enforcement: turn-bound`; `PAUSE_READY`
появляется только после фактически наблюдаемого checkpoint/fencing, не по
истечении таймера.

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
pause=batch run=run-7f31 grace=5m control_id=pause-batch-1
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
pause=uat run=run-7f31 grace=5m control_id=pause-uat-1
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
run: run-7f31
environment: uat
profile: example-project
target: configured-uat-class
evidence class: uat-live
cut: cut-0.2-u04 / label 0.2-u04
observation: pending-owner-observation
work scope: still in progress
```

Такой cut не доказывает flows, actors или capabilities вне сохранённой evidence
matrix. Он не завершает work scope автоматически.

Automated smoke не означает, что вы уже посмотрели UAT. После
`pause=uat` skill останавливается в `pending-owner-observation`; после осмотра
verdict всегда адресуется exact cut, а не «текущей live версии»:

```text
uat verdict=observed run=run-7f31 cut=cut-0.2-u04 control_id=verdict-u04
uat verdict=rejected run=run-7f31 cut=cut-0.2-u04 control_id=reject-u04
```

Это обязательно и в paused run: continuous UAT мог успеть опубликовать более
новый cut. Verdict для superseded cut остаётся привязан к его receipt и не
меняет observation более новой версии.

Здесь `grace` также относится только к writers. Deployment и live smoke имеют
отдельные bounded timeouts, поэтому для самой быстрой остановки выбирайте
`pause=checkpoint`.

## 7. Получить UAT cut и продолжить

Если останавливаться не нужно:

```text
uat=now run=run-7f31 control_id=uat-now-1
```

Skill фиксирует текущий meaningful batch, проверяет и публикует его, затем
продолжает normal run. Если новых integrated product changes нет, пустой cut не
создаётся: coordinator отвечает, почему deploy пропущен.

При policy:

```text
config run=run-7f31 release=continuous-uat control_id=release-policy-1
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
pause=scope run=run-7f31 control_id=pause-scope-1
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
Если cadence сейчас `manual-uat`, `pause=scope` остаётся явной one-shot
авторизацией именно этого финального scope cut. Промежуточные hosted cuts в той
же cadence по-прежнему требуют отдельного `uat=now`.

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
resume run=run-7f31 control_id=resume-1
```

Перед новым dispatch skill:

1. повторит bounded preflight;
2. проверит owner epoch и pinned contract;
3. инвентаризирует preserved lanes и late artifacts;
4. reconciles local/remote integration branch и внешние effects;
5. подтвердит batch/candidate/UAT state;
6. снимет только user pause.

Technical blocker, known-bad hold или rejected UAT не исчезают от `resume`.
Если run ephemeral и task/session потеряна, cross-session recovery невозможно:
новый task только сообщает это ограничение и не реконструирует authority из
task-manager prose.

### 9.1 Явный handoff в другой основной task

Handoff нужен, если старый основной task ещё доступен, но coordinator следует
перенести в новый Goal/task. Сначала доведите run до `QUIESCENT`, затем в старом
task отправьте:

```text
handoff prepare run=run-7f31 control_id=handoff-prepare-1
```

Ответ содержит exact `handoff_id`, state revision, текущий owner epoch и
перечень pending effects. Plan создаётся только при zero live writers; он не
передаёт authority сам по себе. Новый task сначала запускается как Goal, если
нужна Goal progress row, и принимает handoff через явный skill invocation:

```text
$ship-work-release handoff accept run=run-7f31 handoff=ho-19 \
  control_id=handoff-accept-1
```

Accept повторно reconciles state, атомарно меняет owner epoch, fence-ит прежний
coordinator и только затем разрешает dispatch. Старый task после accept остаётся
read-only. Повтор того же accept с тем же `control_id` возвращает прежний
результат; stale или уже использованный handoff с новым payload отклоняется.

### 9.2 Recovery, если основной task потерян

Для durable run новый основной task сначала вызывает skill только для
read-only plan:

```text
$ship-work-release recover prepare run=run-7f31
```

Plan показывает `recovery_id`, observed owner epoch/heartbeat, state revision,
preserved lanes и pending/ambiguous effects. Если takeover безопасен,
пользователь подтверждает exact snapshot:

```text
recover confirm run=run-7f31 recovery=rec-22 \
  expected_owner_epoch=7 control_id=recover-confirm-1
```

Перед authority mutation coordinator снова проверяет expected epoch и state
revision. Любое изменение делает plan stale и требует нового `recover prepare`.
`recover confirm` не выполняется из side task, не обходит unresolved external
effects и не доступен для ephemeral run.

### 9.3 Прервать run без ложного completion

Если work scope больше не нужно продолжать, run завершается двухфазно:

```text
abort prepare run=run-7f31 control_id=abort-prepare-1
```

Preparation сразу закрывает dispatch, сохраняет или fence-ит все lane artifacts,
reconcile-ит начатые external effects и показывает exact plan: что останется в
Git/task manager/UAT, какие holds или ambiguous effects сохраняются и какие
cleanup actions безопасны. Она не меняет terminal state.

После проверки плана:

```text
abort confirm run=run-7f31 plan=abort-17 control_id=abort-confirm-1
```

Confirmation повторно проверяет state revision/owner epoch и переводит run в
`aborted`. Это не `completed`, не scope acceptance и не release claim. Abort не
удаляет unknown worktrees/bytes, не откатывает UAT автоматически и не закрывает
product items как Done. Для потенциально применившегося внешнего effect сначала
нужны reconciliation, explicit quarantine либо отдельный rollback path.

## 10. Goal UI в Codex Desktop

Goal progress row принадлежит Codex Desktop, а не delivery protocol. Она
появляется только у task, действительно запущенного как Goal; `$ship-work-release`
в обычном task сам по себе её не создаёт. Один Goal охватывает весь work scope,
а не отдельный lane, batch, UAT cut или cohort.

### 10.1 Pause и Resume

Goal Pause — client-level pause request. С точки зрения delivery protocol это
hard pause, потому что он не гарантирует, что coordinator успеет закрыть
dispatch, дождаться writer checkpoint и записать receipts. UI Pause также не
доказывает, что уже начатый tool call или subprocess был отменён; это выясняет
последующий recovery.

Предпочтительная последовательность:

```text
1. Отправить pause=checkpoint|batch|uat run=<run_id> control_id=<unique-id>
2. Дождаться PAUSE_READY / QUIESCENT
3. Нажать Goal Pause, если нужно остановить automatic continuation
```

После drain coordinator показывает `PAUSE_READY`. Skill не может сам нажать UI
Pause: это отдельное действие владельца в Desktop. Если Goal успеет получить
automatic continuation turn между `PAUSE_READY` и кликом, он обязан остаться
read-only в canonical `QUIESCENT`, без повторного settlement или dispatch.

Если нужно остановить Codex немедленно, Goal Pause допустим. Coordinator может
не получить нового model turn и не увидеть request. Goal Resume в таком случае
не равен plain-text `resume`: сначала run входит в recovery и сверяет
worktrees, claims, integration branch, contract и начатые внешние effects.
Только после coherent recovery пользователь снимает delivery pause отдельной
командой `resume run=<run_id> control_id=<unique-id>`.

Если grace deadline прошёл, но runtime был полностью остановлен, status должен
честно сказать:

```text
deadline passed; enforcement pending next model turn
```

Документация не обещает скрытый persistent daemon. Bounded grace считается
гарантией только когда acknowledgement показывает `active-callback`; иначе run
не может заявить graceful `QUIESCENT` до фактического reconciliation.

### 10.2 Edit и Clear

Goal Edit меняет формулировку objective для следующих continuation turns, но не
переписывает pinned scope, acceptance, contract, release target или safety
policy. Capacity, UAT cadence и review policy меняются через exact `config`;
contract — через `flow upgrade`; pinned scope/acceptance и release target не
переназначаются через Edit. Свободный текст в Goal Edit считается
steering/context, а не approval внешнего effect.

Goal Clear убирает Goal-level continuation, но не отменяет delivery run, не
очищает claims/effects и не передаёт authority. Перед Clear используйте
graceful pause и дождитесь `PAUSE_READY`. Если Goal уже очищен во время active
run, plain `status` в том же task сначала переводит run в recovery; для нового
task используйте handoff или recovery, а не повторный обычный skill invocation.

Если заранее ожидается потеря подключения или закрытие task, сначала выполните
graceful pause. Goal Pause/Clear после `PAUSE_READY` не требует от coordinator-а
угадывать, успел ли последний external effect завершиться.

### 10.3 Prevent sleep

Включайте Desktop `Prevent sleep`, когда важно, чтобы Mac не уснул во время
writer grace, full gate, CI wait, dev/UAT smoke или deploy. Это повышает шанс
получить непрерывный wall-clock progress, но не создаёт coordinator callback,
не заменяет durable state и не доказывает `active-callback`. Источник истины —
поле `deadline capability` в run card/status. При выключенном Prevent sleep run
остаётся корректным, но после сна может потребовать recovery и не должен
заявлять, что deadline был применён в реальном времени.

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

Обычный fast path для tracked policy/telemetry или compatible execution change:

```text
flow upgrade run=run-7f31 source=5d6e7f8 control_id=flow-upgrade-4
```

Coordinator текущим pinned contract:

- закрыть dispatch;
- достичь quiescent boundary;
- проверить отсутствие pending external effects;
- классифицировать diff как telemetry/policy, execution protocol или
  authority/state change;
- выполнить соответствующий smoke;
- разрешить полный bundle, сохранить его content identity `contract_sha` и
  source commit `contract_source_sha`;
- для compatible change начать новый cohort;
- продолжить product delivery, только если upgrade был запрошен из running
  state.

Если classification — `authority/state`, fast path **не** меняет authority или
schema. Он превращается только в preparation и возвращает exact plan:

```text
upgrade: up-42 / confirmation-required
source: 5d6e7f8
class: authority-state
expected state revision: 184
expected owner epoch: 7
dry-run: passed
confirm with: flow upgrade confirm run=run-7f31 upgrade=up-42 \
  expected_state_revision=184 expected_owner_epoch=7 control_id=<unique-id>
```

Если заранее известно, что меняется authority/state contract, используйте
явную prepare форму:

```text
flow upgrade prepare run=run-7f31 source=5d6e7f8 \
  control_id=flow-prepare-4
```

`prepare` может quiesce run и выполнить isolated dry-run, но не записывает
новую schema/version и не передаёт authority. Только exact `confirm` повторно
проверяет zero live writers/effects, expected state revision и owner epoch,
после чего применяет plan. Изменившийся snapshot делает `upgrade_id` stale.
Duplicate `confirm` с тем же `control_id` возвращает сохранённый result, а не
повторяет migration.

Если вы сначала сделали `pause=checkpoint`, user pause сохраняется после
upgrade и снимается только отдельным `resume`. Если fast-path `flow upgrade`
отправлен во время running, skill сам делает временную quiescent boundary и
возвращается к прежнему running intent после успешной проверки. Authority/state
upgrade после `confirm` также возвращается к прежнему intent, если plan явно
сохранил `resume_after_apply=true`; иначе остаётся `QUIESCENT`.

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
config run=run-7f31 review=manual control_id=review-policy-1
```

Это значит: ни cohort, ни batch сами по себе не запускают reviewer-а. Tests,
full gate, CI и release evidence остаются обязательными; review — отдельная
диагностическая процедура.

Варианты:

```text
config run=run-7f31 review=on-anomaly control_id=review-policy-2
config run=run-7f31 review=uat control_id=review-policy-3
config run=run-7f31 review=final control_id=review-policy-4
```

`on-anomaly` должен иметь заранее видимые triggers: unexpected cross-cutting
diff, ownership violation, repeated failure, merge conflict, security/auth
surface, state incoherence или failed live smoke.

Если repository contract прямо требует review, пользовательская default policy
не может его отменить.

Разовый review запускается без смены policy:

```text
review=now run=run-7f31 target=batch:6b592d35-1534-41f9-b5af-3462d8152f11 control_id=review-u04
review=now run=run-7f31 target=item:72ef4fe4-6004-48aa-b8fb-1f0b9bd08591 control_id=review-item-1
review=now run=run-7f31 target=sha:4ac91e2c4bb0ae9f7dc828f18c7a3dbe449d0bc1 control_id=review-sha-1
```

Reviewer читает exact snapshot и возвращает findings. Он не получает mutation
authority, а исправления выполняет обычный writer lane. Значения после
`batch:` и `item:` — exact canonical IDs, не display name, task key или alias;
`sha:` содержит полный object ID.

## 15. Настройка работающего run

Некоторые policies можно менять follow-up сообщением без нового Goal:

```text
config run=run-7f31 lanes=1 control_id=lanes-1
config run=run-7f31 lanes=auto max=2 control_id=lanes-auto-2
config run=run-7f31 release=continuous-uat control_id=release-continuous
config run=run-7f31 review=on-anomaly control_id=review-anomaly
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
uat verdict=rejected run=run-7f31 cut=cut-0.2-u04 \
  control_id=reject-u04
rollback prepare run=run-7f31 cut=cut-0.2-u04 target=last-stable \
  control_id=rollback-prepare-u04
```

Rejected verdict создаёт exact release hold, например `hold-31`, привязанный к
cut и его live deployment. `resume` такой hold не снимает. Status показывает
hold ID, reason, cut и допустимые resolution paths.

`rollback prepare` ничего не меняет. Skill сначала устанавливает
фактический current deployment и показывает exact from/to plan:

```text
rollback plan: rb-017
run: run-7f31
hold: hold-31
from: UAT deployment d104 / SHA bad1234
to: UAT deployment d103 / SHA good987
expected current deployment: d104
confirm with: rollback confirm run=run-7f31 plan=rb-017 \
  control_id=<unique-id>
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

После проверенного rollback или replacement cut hold снимается отдельным exact
control:

```text
hold clear run=run-7f31 hold=hold-31 resolution=rollback:rb-017 \
  defect=WI-244 control_id=hold-clear-31

hold clear run=run-7f31 hold=hold-31 resolution=cut:cut-0.2-u05 \
  defect=WI-244 control_id=hold-clear-31b
```

Coordinator проверяет referenced receipt, live deployment, required smoke и
durable defect routing. Stale, failed или unrelated resolution отклоняется.
`hold clear` снимает только названный release hold, но не technical/security
blocker. Вслепую повторять deploy или confirmation после потерянного
acknowledgement запрещено; применяется общий `control_id` protocol из §2.1.

## 18. Типовые сценарии

### Спокойная последовательная работа

```text
$ship-work-release lanes=1 release=continuous-uat
status run=<run_id>
pause=uat run=<run_id> grace=5m control_id=pause-uat-1
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
pause=checkpoint run=<run_id> grace=3m control_id=pause-fast-1
```

Результат: dispatch закрыт, хвосты committed/preserved, gate и deploy не
начинаются.

### Посмотреть candidate до UAT

```text
pause=batch run=<run_id> control_id=pause-batch-1
```

Результат: exact candidate + full gate/CI, но live Site не меняется.

### Обновить сам flow внутри work scope

```text
pause=checkpoint run=<run_id> control_id=pause-flow-1
flow upgrade run=<run_id> source=5d6e7f8 control_id=flow-upgrade-1
resume run=<run_id> control_id=resume-flow-1
```

Результат: новый cohort с preserved product progress, без scope-long
freeze.

### Emergency stop

Нажать Goal Pause. После Resume не требовать немедленного продолжения; сначала
дождаться recovery status и coherent state.
