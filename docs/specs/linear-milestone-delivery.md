# Спецификация автономной доставки Linear milestone

Статус: accepted для repo-local skill `ship-linear-release`, 2026-08-08.

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
сообщает доступные числа. Меньшее число ready issue не является ошибкой: active
target временно равен ready frontier, а свободный slot заполняется сразу после
появления совместимой задачи. `auto` выбирает минимум runtime capacity,
resource capacity, optional maximum и текущей ready frontier.

## 3. Роли и topology

### 3.1 Один worker

Root совмещает coordinator и issue executor. Он выполняет задачи
последовательно, но каждая задача всё равно получает отдельные worktree,
feature branch, claim generation и receipt. Integration и full gate не
выполняются в dirty primary checkout.

### 3.2 Несколько worker-ов

Root остаётся dedicated coordinator; одновременно исполняются до N issue
workers. Каждый worker владеет ровно одной issue generation и не меняет Linear,
default branch, Sites, release tags, coordinator ledger или чужие worktrees.

Coordinator:

- выбирает ready frontier и выдаёт fenced claims;
- поддерживает work-conserving pool без искусственных waves;
- проверяет receipts и принимает feature refs в integration train;
- закрывает rolling immutable cutoffs;
- выполняет общие gates, default CAS, release actions и Linear projection;
- классифицирует дефекты и сохраняет durable recovery state.

Worker:

- читает полное описание только своей issue и необходимые product docs;
- меняет только ownership paths manifest;
- коммитит целостную реализацию в task-owned branch;
- выполняет targeted checks и `git diff --check`;
- публикует feature receipt либо точный blocker/defect candidate.

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

Отсутствующие исходники, тесты, config или deployment implementation внутри
уже принятого scope не являются внешним blocker. Это work item: owning issue
переоткрывается или создаётся связанная дедуплицированная issue.

## 5. Ownership между сессиями

Для одного repository существует один repo-global coordinator claim с
`run_id`, `owner_id`, `owner_epoch`, contract digest и durable phase. Первое
mutable действие fresh run — expected-old CAS этого claim.

- CAS winner становится единственным writer control plane.
- CAS loser не создаёт Goal, Linear changes, worktrees, branches, guards,
  cutoffs, deploy или tags; он сообщает `already-running` и может дать только
  read-only status.
- Timeout сам по себе не передаёт ownership.
- Takeover разрешён только из доказанного quiescent handoff/recovery state,
  увеличивает epoch и сначала fence-ит все guards.
- Concurrent runs разных repositories независимы.

Вторая сессия не присоединяется к worker pool активного run: межсессионный
mailbox и shared runtime identity не входят в контракт. Нужную параллельность
задаёт один coordinator через `workers=N|auto`.

## 6. Primary checkout и изоляция

Preflight классифицирует checkout до claim:

- `clean` — обычный запуск;
- `isolated-dirty` — несвязанные пользовательские изменения сохранены, skill
  работает только в новых clean task-owned worktrees;
- `blocked-control-dirty` — изменены `AGENTS.md`, skill, package/lock/toolchain,
  CI/deployment config, migrations или другая execution control surface;
- `blocked-diverged` — primary/default ahead, diverged либо origin identity не
  доказана.

Skill никогда не выполняет `git add -A`, reset, checkout или cleanup
пользовательских файлов. Dirty control surface можно продолжить только после
явного решения пользователя: включить и закоммитить изменения, убрать их из
scope либо завершить текущую работу. После принятого commit preflight
повторяется на новом exact contract SHA.

Все worktrees имеют отдельные mutable dependency/cache/build/runtime paths.
Sharing read-only sealed artifacts допустим только при exact provenance;
изменяемые `node_modules`, caches, ports или generated outputs между worker-ами
не разделяются.

## 7. Goal contract

Fresh run после выигранного claim создаёт ровно один Goal без token budget, если
budget явно не запросил пользователь. Goal включает exact project, milestone,
repo, run identity и tracked skill/spec SHA, но не profiles.

Goal завершён, когда два свежих согласованных snapshot не содержат unfinished
issue, все run artifacts terminal, default branch healthy и каждый принятый
cutoff имеет exact-SHA gate/promotion evidence. Если acceptance или repository
release contract требует production, Goal дополнительно требует exact
artifact/deployment, live web + MCP evidence и rollback proof. Если production
не требуется, такие artifacts не создаются и не симулируются.

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
- terminal publication guard той же generation;
- unchanged issue fingerprint;
- passing targeted checks;
- scope/path proof и `git diff --check`;
- явных gaps без завышенных live/conformance claims.

Coordinator интегрирует только immutable ready refs, проверяет dependency order
и не ждёт завершения всех in-flight задач. Conflict сериализует конкретные
features, а не весь pool.

## 9. Cutoff, общие проверки и default

Cutoff фиксирует ordered accepted prefix integration train. После seal его
membership и source tree immutable. Любая source change, fix, exclusion или
revert создаёт новую generation и validation key.

Worker checks не заменяют общий gate. Coordinator в clean cutoff worktree один
раз выполняет canonical full repository gate для exact validation key. В Mind
Diary это `npm ci`, затем один `npm run check` и `git diff --check
<base>..<candidate>`, если текущий `AGENTS.md` не задаёт обновлённый contract.
Aggregate command не дублируется отдельными subcommands.

Только terminal pass разрешает expected-old fast-forward CAS exact candidate в
remote default. После push coordinator проверяет remote SHA и обязательный
post-push CI exact SHA. Primary checkout и local default ref не используются
как release evidence.

## 10. Production batches

Каждый проверенный cutoff может быть продвинут в default независимо от
production. Нужно ли затем выпускать production batch, определяется
acceptance текущего milestone и repository release contract.

Если production требуется, coordinator:

1. доказывает configured production target и previous stable artifact;
2. связывает artifact/version/deployment с exact validated default SHA;
3. deploy-ит один раз через durable action ticket;
4. проверяет обязательные live authenticated web/control, persistence и MCP
   flows на точном target;
5. создаёт immutable tag только если его требует tracked version policy;
6. закрывает Linear issue после terminal release evidence.

Для Mind Diary фраза «production release» означает полный Sites vertical slice
из `AGENTS.md`; локальный MCP, один UI или probe не заменяют release. Если этого
slice ещё нет, coordinator создаёт/переоткрывает implementation work и
продолжает. Внешняя platform capability может стать настоящим blocker только
после того, как exact deployable product и reproducible gate уже существуют, а
проверка действительно требует недоступного внешнего действия.

Если milestone не требует production, receipt пишет
`PRODUCTION_REQUIREMENT=not-required-by-current-milestone`; это наблюдение об
acceptance, а не profile и не waiver.

## 11. Классификация проблем

| Наблюдение | Действие |
|---|---|
| Дефект относится к acceptance текущей issue | Переоткрыть/оставить issue `In Progress`, создать новую claim generation и отправить на переделку |
| Сложный независимый дефект | Найти duplicate либо создать связанную Linear Bug с evidence и dependencies; продолжить независимый frontier |
| Маленький integration repair | Coordinator исправляет в integration worktree, создаёт новую cutoff generation и повторяет полный gate; непроверенного commit прямо в main нет |
| Default содержит известный bad change | Заморозить promotion, создать stabilization cutoff или rollback по exact evidence |
| Нужен новый product/security decision | Сохранить безопасный state, продолжить независимые задачи и запросить решение пользователя |
| Обязательный внешний ресурс недоступен | Выполнить все локально доказуемые prerequisites, зафиксировать точный resource/operation/error и остановиться только если больше нет safe progress |

Повторный или системный дефект получает одну дедуплицированную stabilization
issue и fresh claim generations; affected promotion замораживается, независимый
frontier продолжает работу. После двух одинаково неуспешных repair generations
coordinator обязан классифицировать root cause. Сложность реализации не
является blocker: остановка допустима только при доказанном внешнем ресурсе,
противоречии authoritative требований либо необходимости нового
product/security decision.

Линейная задача не закрывается по факту commit. `Done` требует feature receipt,
integrated cutoff, default evidence и все применимые acceptance/release gates.

## 12. Pause, crash и recovery

Pause сначала запрещает новые dispatch, затем дренирует workers, завершает или
безопасно останавливает активный cutoff, reconciles pending actions и оставляет
durable `handoff-ready` либо `paused` receipt. Убийство coordinator process не
является корректной остановкой.

После crash новый owner не повторяет внешние create/push/deploy операции
вслепую. Он сначала читает durable intents, remote refs, Linear state и external
artifacts, затем усыновляет exact result либо fence-ит старый epoch. Ambiguous
external create fail closed до reconciliation.

## 13. Terminal отчёт

Успешный итог сообщает кратко:

- milestone и число доставленных/переоткрытых/созданных issues;
- worker mode и фактическую peak concurrency;
- cutoff/default exact SHAs и результаты full gates;
- production evidence либо `not-required-by-current-milestone`;
- remaining gaps, если они не удерживают acceptance;
- состояние Goal и отсутствие активных run artifacts.

Blocked итог должен человеческим языком ответить на четыре вопроса: что именно
не получилось, какое требование это блокирует, что уже проверено/сделано и какое
минимальное действие пользователя или внешней системы снимет blocker. Внутренние
IDs и receipts приводятся после объяснения, а не вместо него.
