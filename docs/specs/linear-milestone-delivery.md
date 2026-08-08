# Спецификация автономной доставки Linear milestone

Статус: accepted для repo-local skill `ship-linear-release`, 2026-08-08.

Concurrency topology, interference policy, batch validation и optional release
lock уточнены [ADR-0007](../decisions/0007-linear-delivery-concurrency.md).
На 2026-08-08 эти уточнения приняты как целевой контракт, но ещё не реализованы
в `SKILL.md`, helper scripts и orchestration tests. До отдельной реализации
нельзя заявлять, что текущий исполняемый skill им соответствует.

## 1. Назначение и источники истины

Явный запуск `$ship-linear-release` означает: реализовать, проверить,
интегрировать и корректно завершить все незавершённые issue exact current
milestone выбранного Linear project.

Authoritative sources применяются в таком порядке:

1. явное ограничение пользователя в текущем вызове;
2. acceptance и dependencies exact Linear issue;
3. `AGENTS.md` затронутой repository surface;
4. tracked specifications, manifests, test и release contracts репозитория;
5. эта спецификация и сам skill как execution protocol.

Skill не добавляет `target_profile`, `delivery_profile` или release intent.
Worker count — только scheduler configuration. Он не меняет acceptance, набор
gates или определение production.

## 2. Invocation contract

Поддерживаются следующие формы:

| Вызов | Нормализованное значение |
|---|---|
| `$ship-linear-release` без числа | `workers=1` |
| `workers=4`, «4 воркера», «в 4 потока» | exact `workers=4` |
| `workers=auto`, «всех доступных» | adaptive `workers=auto` |
| `workers=out` | alias распознавания речи для `auto` |
| `auto, не больше 6` | `workers=auto`, `max_workers=6` |
| `dry-run` | только preflight и план, без мутаций |

Число должно быть положительным. Числа issue, milestone, версии или budget не
считаются worker count. Два несовместимых явных значения делают invocation
неоднозначным: skill задаёт один короткий вопрос до любой мутации.

`workers=N` — точное требование к устойчивой issue capacity. Если runtime или
безопасные ресурсы не позволяют поддерживать N, run не начинает claim и
сообщает доступные числа. Меньшее число ready issue не является ошибкой:
`refill_count=min(max(sustained-running,0), compatible ready)`, а текущий
`active_target=running+refill_count`. Состояние
`running > sustained_issue_capacity` означает capacity drift и блокирует новый
dispatch; свободный slot заполняется сразу после появления совместимой задачи.
`auto` выбирает минимум runtime capacity,
resource capacity и optional maximum как `sustained_issue_capacity`; ready
frontier ограничивает только текущий `active_target`, но не устойчивую
capacity. Источники runtime/resource capacity передаются в `launch-check` явно
и не выводятся из requested workers.

## 3. Роли и topology

### 3.1 Один worker

Root совмещает coordinator и issue executor и выполняет задачи последовательно.
Каждая задача получает отдельные feature branch, claim generation и receipt,
но отдельный worktree не создаётся: root работает в primary checkout. Перед
началом задачи coordinator переключает clean primary checkout с `main` на её
feature branch, а после targeted checks и commit возвращается на `main` и
интегрирует feature.

Отсутствие worktree — единственное отличие issue lifecycle в single-worker
режиме. Ownership manifest, targeted validation, Linear projection, conflict
resolution, batch accumulation и release evidence остаются обязательными.
Coordinator не использует primary checkout, если initial или текущий
repository snapshot не доказанно clean относительно всех зарегистрированных
действий run.

### 3.2 Несколько worker-ов

Root остаётся dedicated coordinator; одновременно исполняются до N issue
workers. Каждая задача получает отдельные feature branch и worktree, а каждый
worker владеет ровно одной issue generation. Worker не меняет Linear, `main`,
Sites, release tags, coordinator ledger или чужие worktrees.

Coordinator:

- выбирает ready frontier и выдаёт fenced claims;
- поддерживает work-conserving pool без искусственных waves;
- проверяет receipts и последовательно merge-ит feature branches в `main`;
- сам разрешает merge conflicts и повторяет только затронутые targeted checks;
- закрывает rolling immutable release batches;
- выполняет общие gates, default CAS, release actions и Linear projection;
- классифицирует дефекты и сохраняет durable recovery state.

Worker:

- читает полное описание только своей issue и необходимые product docs;
- меняет только ownership paths manifest;
- коммитит целостную реализацию в task-owned branch;
- выполняет targeted checks и `git diff --check`;
- публикует feature receipt либо точный blocker/defect candidate.

Технический writer `main` всегда один — coordinator. Формулировка «worker
вливает задачу» означает доставку его feature branch через coordinator, а не
право worker самостоятельно выполнять merge или push в `main`.

`workers` не включает coordinator. Root может временно исполнить issue inline
только когда control-plane queue пуста; это не увеличивает объявленную
устойчивую capacity.

## 4. Ранний audit и построение frontier

До repo-global claim coordinator делает один компактный snapshot milestone и
проверяет:

- exact project и current milestone определены однозначно;
- нет dependency cycle или ссылки на неизвестный blocker;
- состояния и acceptance не противоречат authoritative repository contract;
- для каждой ready issue можно построить bounded ownership manifest;
- существует ready issue либо уже выполняемая generation, способная открыть
  следующий frontier;
- требуемые внешние credentials/capabilities известны как поздние gates и не
  маскируют обычную незавершённую реализацию.

Полные descriptions/comments читаются только у немедленно ready issue и их
непосредственных blocker-ов. Если ready frontier пуст при наличии unfinished
issues и running generations, coordinator продолжает ждать их terminal receipt.
Если нет ни ready, ни running, запуск останавливается до mutation с
`no-actionable-frontier` и объясняет конкретный cycle, unknown dependency или
acceptance contradiction.

Выбор project/current milestone, dependency graph и ready frontier выполняет
typed `shipctl.py milestone-plan`. Malformed, ambiguous или structurally
blocked snapshot запрещает claim; model не исправляет его догадкой. Snapshot
обязан содержать typed поля `id`, `identifier`, `title`, `state`, `priority`,
`labels`, `createdAt`, `updatedAt`, milestone, dependencies и finite board
position; digest и ready ordering не зависят от порядка входных массивов.

Отсутствующие исходники, тесты, config или deployment implementation внутри
уже принятого scope не являются внешним blocker. Это work item: owning issue
переоткрывается или создаётся связанная дедуплицированная issue.

## 5. Ownership между сессиями

Для одного repository существует один repo-global coordinator claim с
`run_id`, `owner_id`, `owner_epoch`, contract digest и durable phase. Первое
mutable действие fresh run — expected-old CAS этого claim.

- CAS winner становится единственным writer control plane.
- CAS loser не создаёт Goal, Linear changes, worktrees, branches, guards,
  batches, deploy или tags. Он повторно читает выигравший claim и выбирает
  observer либо recovery path.
- Claim не является бессрочной блокировкой. Fresh explicit invocation может
  без доказательства runtime liveness атомарно забрать `active` claim, если
  durable state когерентно доказывает quiescence: `running_count=0`, нет active
  issue lanes/live claims, pending external action, nonterminal либо ambiguous
  gate/batch/deploy, а repository snapshot совпадает с ожидаемым. Terminal
  reconciled batch record не удерживает owner. Takeover увеличивает epoch и до
  любой новой работы fence-ит все известные guards.
- Timeout, старый timestamp и отсутствие PID сами по себе не передают
  ownership. Они также не нужны для quiescent reclaim: authority даёт полный
  machine-checkable state vector и expected-old CAS.
- Если есть running worker, live claim, pending external effect либо
  неоднозначный state, автоматический reclaim запрещён. Нужны authoritative
  terminal evidence или явное подтверждение пользователя об остановке старого
  owner, после чего новый coordinator всё равно сначала выполняет fencing и
  reconciliation.
- Concurrent runs разных repositories независимы.

Вторая сессия не присоединяется к worker pool активного run: межсессионный
mailbox и shared runtime identity не входят в контракт. Нужную параллельность
задаёт один coordinator через `workers=N|auto`.

Repo-global claim синхронизирует repository вместе со всеми его worktrees. Он
не синхронизирует разные repositories. Optional production lock из раздела 10
— отдельная узкая защита одного Site target и не расширяет Git ownership.

## 6. Primary checkout и изоляция

Preflight до claim проверяет весь repository, включая primary checkout и
зарегистрированные worktrees. Любой path, который виден в `git status` как
staged, unstaged, untracked, renamed, deleted, conflicted либо otherwise dirty,
входит в snapshot. Ignored build/cache files не считаются source dirt, но
проверяются отдельными isolation rules.

До fresh normal claim единственный безопасный state — `clean`. Исключение —
dirty task worktree, уже полностью связанный с durable claim прежнего run: он
маршрутизируется только в recovery/adoption и не разрешает normal dispatch до
fencing и reconciliation. Skill не присваивает себе иной ранее существовавший
dirt, не делает stash/reset/clean и не пытается угадать автора. Он
останавливается до мутаций и понятным языком предлагает пользователю завершить,
закоммитить либо отдельно передать эту работу. После решения preflight
полностью повторяется на новом exact SHA и clean status.

После claim coordinator сохраняет baseline `HEAD + refs + git status` каждого
checkout. Изменения допустимы только если они соответствуют зарегистрированному
действию текущего coordinator или active worker, его branch/worktree и
ownership paths. Любое иное новое отличие в primary checkout, task worktree,
local `main` или tracked ref считается внешним вмешательством, даже если Git не
позволяет доказать конкретного автора.

При таком вмешательстве coordinator немедленно запрещает новые edits, commits,
merges, gates и release actions, останавливает workers на ближайшей безопасной
границе и возвращает critical error. Он не пытается молча включить, отменить,
stash-нуть или исправить сторонние изменения.

В multi-worker режиме все worktrees имеют отдельные mutable
dependency/cache/build/runtime paths.
Sharing read-only sealed artifacts допустим только при exact provenance;
изменяемые `node_modules`, caches, ports или generated outputs между worker-ами
не разделяются.
Для Node worktree coordinator использует `shipctl.py provision-worktree`:
exact lockfile, task-owned `npm ci`, ignored `.codex-task` receipt и отсутствие
symlink overlay являются dispatch prerequisite. Все ownership paths передаются
повторяемым `--path`; helper устанавливает root и каждый tracked nested
`package-lock.json`, затронутый owned directory/file. Untracked lockfile не
является dependency authority, а изменение любого выбранного lockfile меняет
provisioning digest и запрещает adoption старого receipt.

В single-worker режиме task-owned paths располагаются внутри primary checkout,
но не разделяются с другим процессом. Появление второго writer немедленно
переводит run в critical stop по правилам выше.

## 7. Goal contract

Fresh run после выигранного claim создаёт ровно один Goal без token budget, если
budget явно не запросил пользователь. Goal включает exact project, milestone,
repo, run identity и tracked skill/spec SHA, но не profiles.

Goal завершён, когда два свежих согласованных snapshot не содержат unfinished
issue, все run artifacts terminal, default branch healthy и каждый принятый
batch имеет exact-SHA gate/promotion evidence. Если acceptance или repository
release contract требует production, Goal дополнительно требует exact
artifact/deployment, live web + MCP evidence и rollback proof. Если production
не требуется, такие artifacts не создаются и не симулируются.
До `update_goal(complete)` coordinator сначала terminalize-ит owner/guards,
проверяет compact status и очищает только доказанно terminal clean worktrees.

Goal отмечается `blocked` только по общему Goal protocol: один и тот же
устойчивый blocker повторился минимум в трёх последовательных goal turns и
невозможно безопасно продвинуть независимую часть milestone. Waiting worker,
CI, recoverable CAS race, pause или обычная сложная реализация blocker-ом не
являются.

## 8. Issue lifecycle и guards

Каждая dispatch generation содержит exact issue fingerprint, base/dependency
SHAs, ownership paths, targeted commands, executor lease, branch/worktree,
claim token и publication guard. Scope drift проверяется перед commit и перед
receipt. Изменившаяся acceptance отменяет старую generation и требует
re-dispatch.

Feature считается готовой к ingest только при наличии:

- clean committed head и exact origin ref;
- durable `ready` publication guard той же generation;
- unchanged issue fingerprint;
- passing targeted checks;
- scope/path proof и `git diff --check`;
- явных gaps без завышенных live/conformance claims.

Coordinator интегрирует только immutable ready refs, проверяет dependency order
и не ждёт завершения всех in-flight задач. Он один последовательно merge-ит их
в local `main` с expected base. Conflict сериализует конкретные features, а не
весь pool; coordinator разрешает его в integration context и сохраняет
исходную feature provenance.
Полный candidate/active manifest, coordinator SHA, dependency receipt,
non-shell targeted argv, canonical manifest digest и fresh scope fingerprint
проверяются `dispatch-check`; обрезанный resource-only entry недействителен.
Worker receipt принимается только после `receipt-verify` exact refs/guard/scope/
diff checks. `needs-coordinator` маршрутизирует scope и defect вопросы без
преждевременного запроса пользователю.
Manifest dispatch обязан совпадать с exact live claim binding. В active/receipt
phase более новый coordinator SHA допустим только как descendant исходного при
том же run/owner/epoch и пока exact issue generation, guard и feature binding
остаются live; current guard обязан быть descendant dispatch guard и не быть
`fenced|terminal` (для receipt — ровно `ready`).

Linear status/comment — projection durable Git facts. `projection-plan` создаёт
run/generation-scoped items и короткий читаемый comment со статусом, изменениями,
проверкой и следующим шагом. До provider calls `projection-batch-cas` сохраняет
под exact expected coordinator SHA полный identity vector, после calls — полный
item-wise `applied|absent|failed|ambiguous` vector. Частичный failure не стирает
успешные соседние results и не разрешает повторить их вслепую.

После `running -> feature_ready` slot освобождается. Refill target `<=60s`
считается `refill-check` без усечения fractional seconds; невозможные timestamps,
placeholder evidence и late spawn fail closed либо сохраняют missed evidence.

## 9. Накопление в `main` и общие проверки

Каждая готовая задача после targeted validation отдельным merge попадает в
local `main`. Merge commit либо fast-forward сохраняет issue ID, feature SHA и
claim generation. После каждого merge coordinator выполняет только дешёвые
проверки потенциально затронутой поверхности: conflict review,
`git diff --check`, affected tests/validator/smoke и необходимые security/schema
invariants. Полный repository gate после каждой маленькой задачи запрещён.

Coordinator периодически закрывает release batch — exact immutable snapshot
накопленного `main`. Контракт намеренно не задаёт механический размер либо
таймер. Boundary выбирается по связности изменений, риску, стоимости gate,
размеру накопленного результата и состоянию очереди. При устойчивом потоке
мелких задач следует ждать заметного, осмысленного unit; urgent fix, исчерпание
ready work или иной risk boundary могут закрыть batch раньше.

Worker checks не заменяют batch gate. Coordinator один раз выполняет canonical
full repository gate для exact batch SHA и validation key. В Mind Diary это
`npm ci`, затем один `npm run check` и `git diff --check
<previous-released>..<candidate>`, если текущий `AGENTS.md` не задаёт
обновлённый contract. Aggregate command не дублируется отдельными subcommands.
Gate имеет bounded step/total timeout, завершает process group и сохраняет
immutable `failure_kind`; shell wrappers, duplicate steps и aggregate вместе с
покрываемым subcommand отклоняются до запуска.

Только terminal pass разрешает expected-old CAS exact candidate в remote
`main`. После push coordinator проверяет remote SHA и обязательный post-push CI
exact SHA. Любая source change, fix, exclusion или revert после batch snapshot
создаёт новую generation и validation key.

Перед завершением skill обязан закрыть финальный batch, выполнить полный gate и
применимый production release даже для одной маленькой оставшейся задачи.
Наличие недавно успешного предыдущего batch не покрывает новый patch.

## 10. Production batches и release lock

После successful full gate и продвижения exact batch SHA в remote `main`
coordinator выполняет применимый production release. При потоке задач это
происходит на batch boundaries, а не после каждой feature. Финальный release
обязателен перед успешным завершением skill, если repository release contract
определяет production как часть delivery.

Если production требуется, coordinator:

1. доказывает configured production target и previous stable artifact;
2. проверяет наличие atomic release-lock capability для exact Site/environment;
3. связывает artifact/version/deployment с exact validated `main` SHA;
4. deploy-ит один раз через durable action ticket;
5. проверяет обязательные live authenticated web/control, persistence и MCP
   flows на точном target;
6. создаёт immutable tag только если его требует tracked version policy;
7. закрывает Linear issue после terminal release evidence.

Release lock используется только когда фактический provider предоставляет
проверяемые atomic acquire/conditional release либо эквивалентный CAS. Lock
scope — exact Site project + environment; record содержит `owner_run_id`,
`acquired_at` и, если provider поддерживает, monotonic fencing epoch/expiry.
Захват выполняется до первой publish mutation, освобождение — только после
terminal deploy/reconciliation и только matching owner/epoch.

Отсутствие такой capability не блокирует release: шаг пропускается, а evidence
явно записывает `release_lock=unsupported/skipped`. Обычный файл, comment,
environment variable без CAS или marker в опубликованном Site lock-ом не
считается. На 2026-08-08 доступный Sites connector не предоставляет отдельной
atomic lock operation; это observation текущей tool surface, а не обещание
платформы навсегда.

Если failure оставил настоящий lock, coordinator не удаляет его автоматически.
Он сначала reconciles deployment status и объясняет пользователю owner, target,
последний доказанный этап и риск повторного publish. `force-unlock` допустим
только после явного подтверждения пользователя; при доступном fencing он также
увеличивает epoch, чтобы прежний publisher потерял authority. Если provider не
умеет fence-ить уже начатый publish, отчёт прямо предупреждает об остаточном
риске overlap.

Для Mind Diary фраза «production release» означает полный Sites vertical slice
из `AGENTS.md`; локальный MCP, один UI или probe не заменяют release. Если этого
slice ещё нет, coordinator создаёт/переоткрывает implementation work и
продолжает. Внешняя platform capability может стать настоящим blocker только
после того, как exact deployable product и reproducible gate уже существуют, а
проверка действительно требует недоступного внешнего действия.

Если authoritative repository contract для конкретного milestone не требует
production, receipt пишет
`PRODUCTION_REQUIREMENT=not-required-by-current-milestone`; это наблюдение об
acceptance, а не profile и не waiver.

## 11. Классификация проблем

| Наблюдение | Действие |
|---|---|
| Дефект относится к acceptance текущей issue | Переоткрыть/оставить issue `In Progress`, создать новую claim generation и отправить на переделку |
| Сложный независимый дефект | Найти duplicate либо создать связанную Linear Bug с evidence и dependencies; продолжить независимый frontier |
| Маленький integration repair | Coordinator создаёт отдельную feature branch, исправляет её в primary checkout при single-worker либо отдельном worktree при multi-worker, merge-ит в `main` и создаёт новую batch generation; release без повторного полного gate запрещён |
| Default содержит известный bad change | Заморозить promotion, создать stabilization cutoff или rollback по exact evidence |
| Нужен новый product/security decision | Сохранить безопасный state, продолжить независимые задачи и запросить решение пользователя |
| Обязательный внешний ресурс недоступен | Выполнить все локально доказуемые prerequisites, зафиксировать точный resource/operation/error и остановиться только если больше нет safe progress |
| В repository появился незарегистрированный `git status`/HEAD/ref delta | Немедленно остановить новые мутации и release, довести workers только до безопасной границы, сохранить чужие bytes нетронутыми и выдать critical error overview |

Повторный или системный дефект получает одну дедуплицированную stabilization
issue и fresh claim generations; affected promotion замораживается, независимый
frontier продолжает работу. После двух одинаково неуспешных repair generations
coordinator обязан классифицировать root cause. Сложность реализации не
является blocker: остановка допустима только при доказанном внешнем ресурсе,
противоречии authoritative требований либо необходимости нового
product/security decision.

Линейная задача не закрывается по факту commit. `Done` требует feature receipt,
integrated batch, `main` evidence и все применимые acceptance/release gates.

## 12. Pause, crash и recovery

Pause сначала запрещает новые dispatch, затем дренирует workers, завершает или
безопасно останавливает активный batch, reconciles pending actions и оставляет
durable `handoff-ready` либо `paused` receipt. Убийство coordinator process не
является корректной остановкой.

После crash новый owner не повторяет внешние create/push/deploy операции
вслепую. Он сначала читает durable intents, remote refs, Linear state и external
artifacts, затем усыновляет exact result либо fence-ит старый epoch. Ambiguous
external create fail closed до reconciliation.

Coherent quiescent `active` owner не может навсегда заблокировать repository.
Fresh explicit invocation выполняет expected-old takeover с `epoch+1` и fencing
без требования доказать состояние старой Codex task. Это разрешено только для
полного zero-work/no-pending/no-nonterminal-batch predicate из раздела 5. Любой
running либо внешний pending effect сохраняет conservative recovery path.

## 13. Terminal отчёт

Успешный итог сообщает кратко:

- milestone и число доставленных/переоткрытых/созданных issues;
- worker mode и фактическую peak concurrency;
- batch/`main` exact SHAs и результаты full gates;
- production evidence либо `not-required-by-current-milestone`;
- remaining gaps, если они не удерживают acceptance;
- состояние Goal и отсутствие активных run artifacts.

Blocked итог должен человеческим языком ответить на четыре вопроса: что именно
не получилось, какое требование это блокирует, что уже проверено/сделано и какое
минимальное действие пользователя или внешней системы снимет blocker. Внутренние
IDs и receipts приводятся после объяснения, а не вместо него.

При critical error coordinator дополнительно сообщает, на каком этапе
остановился run, какие изменения уже были сделаны, в каком состоянии остались
`main`, feature branches/worktrees, Linear и release target. Он самостоятельно
сводит worker/subagent evidence в короткий понятный overview. Raw сообщение
subagent, stack trace, guard vector или tool JSON не являются пользовательским
объяснением и могут приводиться только как вторичное evidence.

## 14. Требуемые исполняемые guardrails

Список ниже включает существующие helpers и требования ADR-0007, которые ещё
нужно реализовать. Пока `SKILL.md`, scripts и tests не обновлены отдельным
изменением, этот раздел задаёт acceptance будущей реализации, а не доказывает
текущее соответствие.

Нормативные prose-переходы имеют machine-checkable counterparts:

- `goal-card` ограничивает и хеширует exact Goal objective;
- `milestone-plan` валидирует current milestone и dependency frontier;
- `startup-plan` объединяет invocation/frontier/capacity, но на resume берёт
  occupancy только из authoritative `EXECUTION_INDEX` и live claims, а при
  отсутствии нового count сохраняет durable worker request;
- `pool-status` объясняет фактическую загрузку и unused capacity без UI subagents;
- `projection-plan` и `projection-batch-cas` дают двухфазную crash-safe Linear
  projection; `refill-check` фиксирует точную 60-second boundary;
- `manifest`, multi-worker `provision-worktree`, `dispatch-check` и
  `receipt-verify` ограждают issue lane;
- `conveyor-next` допускает только ordered lifecycle с обязательным evidence;
- `gatectl run/status` дедуплицирует один full gate exact generation;
- `recover-stale-owner` сохраняется для непустого state и принимает только
  terminal-task/user-confirmed-stop proof; отдельный quiescent path не требует
  runtime proof, но требует полного zero-work predicate и expected-old CAS;
- `status`, `cleanup-plan` и `cleanup-apply` закрывают terminal run без удаления
  dirty, active или unpublished carrier; cleanup требует coherent terminal
  coordinator, zero occupancy, no live claims и claim-bound branch identity.
- preflight снимает один coherent repo-wide snapshot всех worktrees и
  классифицирует любое видимое `git status` отличие;
- single-worker helper безопасно управляет task feature branch в primary
  checkout, а multi-worker integration допускает merge в `main` только
  coordinator-у;
- quiescent reclaim атомарно проверяет zero-work/no-pending predicate,
  увеличивает epoch и fence-ит guards без runtime-liveness proof;
- batch planner выбирает и сохраняет осмысленную boundary без full gate на
  каждую feature и принудительно закрывает финальный batch;
- release capability probe либо использует atomic Site lock, либо сохраняет
  terminal `unsupported/skipped` evidence без выдуманного marker lock;
- critical-stop renderer строит human overview из coordinator/worker evidence
  и не возвращает сырой subagent output как итог.

Canonical `npm run check` включает Python orchestration suites; изменение helper
без этих tests не может пройти repository gate.

Metadata ledger bounded по размеру, запрещает duplicate scalar headers и перед
переполнением compacts только terminal history до count+digest. Primary/default
snapshot пригоден, только если два чтения одной bounded операции совпали; torn
snapshot запрещает shared mutation.
