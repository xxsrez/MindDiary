# Упрощённая доставка Linear milestone

Статус: accepted executable compromise для repo-local skill
`ship-linear-release`, 2026-08-09.

Эта спецификация задаёт простую исполнимую версию доставки текущего Linear
milestone. Полный [контракт `ship-work-release`](ship-work-release.md) остаётся
целевой моделью и источником исходных требований, но не является обязательным
runtime-протоколом этой версии. Расхождение ниже является осознанным
компромиссом, а не отменой долгосрочного требования.

## 1. Результат

Явный запуск `$ship-linear-release` означает:

1. определить exact Linear project и current milestone;
2. реализовать все входящие в scope незавершённые issue с учётом dependencies;
3. интегрировать готовые feature branches в `main`;
4. периодически выпускать осмысленные batches в UAT;
5. исправлять prerelease и UAT defects с повышенным приоритетом;
6. завершить milestone только после проверки repository state, Linear и UAT.

Skill не выполняет production release. Production всегда требует отдельного
ручного workflow и явного запроса пользователя.

## 2. Invocation и worker topology

Поддерживаются две основные формы:

- без `workers` либо `workers=1`: coordinator сам является единственным
  worker; субагенты и дополнительные worktrees не создаются;
- `workers=N`, где `N > 1`: запускаются ровно `N` worker-субагентов плюс
  отдельный coordinator. Coordinator не входит в `N`.

Искусственного верхнего предела в skill нет. Запуск обязан до мутаций проверить,
что runtime действительно может создать requested число workers. Если нет —
остановиться и назвать доступную capacity, не уменьшать `N` молча.

Каждый worker в parallel mode получает собственные:

- durable lane `worker-1 .. worker-N`;
- feature branch;
- Git worktree;
- одну active Linear issue за раз;
- непересекающийся writable scope.

Lane и worktree переиспользуются этим worker для следующих задач после чистого
завершения предыдущей. Число lanes/worktrees равно числу worker-субагентов, а
не числу issue во всём milestone.

## 3. Authority и роли

Coordinator — единственный writer для:

- `main` и integration merges;
- Linear status, comments, reopen и defect creation;
- release batches и UAT deployment;
- run journal;
- окончательных решений о scope conflict и completion.

Worker:

- читает exact issue, acceptance, dependencies и документы своей surface;
- изменяет только выданные ownership paths;
- запускает targeted checks и `git diff --check`;
- коммитит целостный результат в свою feature branch;
- возвращает coordinator-у SHA, checks и обнаруженные gaps;
- не пишет в Linear, `main`, чужой worktree или UAT.

Coordinator может делать мелкие integration, prerelease и UAT fixes прямо в
`main`. Обычные product tasks в parallel mode он берёт только когда это не
мешает координации и срочному repair flow.

## 4. Источники истины

При конфликте применяются по порядку:

1. явные ограничения пользователя в текущем invocation;
2. acceptance и dependencies exact Linear issue;
3. `AGENTS.md` затронутой repository surface;
4. tracked product specifications и tests;
5. эта спецификация и `SKILL.md` как execution policy.

Linear names и identifiers используются для UX, но journal хранит stable issue
ID вместе с display identifier. Неизвестную dependency, неоднозначный current
milestone или конфликтующий scope нельзя исправлять догадкой.

## 5. Простой durable journal

На run используется один JSON-файл под Git common directory:

```text
<git-common-dir>/ship-linear-release/runs/<run-id>.json
```

Journal — aid для resume и защиты от случайного двойного dispatch, а не
транзакционная база и не второй task manager. Записи делаются через lock и
atomic replace. Достаточный state:

- schema version, `run_id`, repository root, project и milestone;
- requested workers и mode `single | parallel`;
- status `active | paused | completed | failed`;
- initial и current `main` SHA;
- lanes с worker, branch, worktree и active issue;
- tasks со status `ready | running | feature-ready | integrated | done |
  blocked`, ownership paths, branch, feature SHA и checks;
- batches с candidate SHA, issue/defect IDs, gate и UAT result;
- current UAT SHA и unresolved defects;
- timestamps и last error.

Не нужны SQLite, generic reducer, CAS revision protocol, signed receipts,
content-addressed objects, provider broker или schema migration framework.
После crash coordinator перечитывает Git, Linear и UAT, сверяет их с journal и
чинит расхождение явным resume-действием. Journal не может сам доказать внешний
effect.

## 6. Планирование и dispatch

Перед работой coordinator получает bounded snapshot milestone и строит
dependency-aware ready frontier. Issue готова, если:

- она незавершённая и входит в exact milestone;
- все её blockers завершены либо уже интегрированы в текущем run;
- acceptance достаточно конкретна для реализации;
- writable paths не пересекаются с active lanes.

В single mode coordinator последовательно берёт одну ready issue и работает в
primary checkout на feature branch. В parallel mode свободный lane немедленно
получает следующую независимую issue. Искусственных waves нет.

До dispatch coordinator записывает issue, branch, worktree и ownership paths в
journal. Worker не начинает изменения до этого checkpoint.

## 7. Feature и integration flow

Готовая feature должна иметь:

- clean committed feature head;
- соответствие изменённых файлов ownership scope;
- passing targeted checks;
- passing `git diff --check`;
- короткое описание результата и известных gaps.

Coordinator проверяет feature SHA и интегрирует branch прямо в `main`.
По своему усмотрению он может сначала обновить worker branch из актуального
`main`, чтобы перенести конфликт из integration checkout. Конфликт разрешает
coordinator; worker может помочь только в своём scope.

После merge запускаются затронутые проверки. Полный repository gate не
повторяется после каждой маленькой issue; он выполняется для закрытого batch.
Linear issue становится Done только после интеграции и достаточной проверки, а
не после одного worker report.

## 8. UAT batches

UAT разрешён и включён по умолчанию. Worker count не задаёт размер batch.
Coordinator закрывает batch, когда накоплен осмысленный вертикальный результат
либо возникла естественная risk boundary: завершённая связанная группа задач,
важный fix, исчерпание ready frontier или необходимость быстро проверить UAT.

Для exact candidate coordinator:

1. запускает канонический repository gate;
2. запускает локальный dev/smoke, если это требует repository contract;
3. публикует exact candidate в UAT;
4. выполняет обязательный UAT smoke;
5. записывает candidate SHA, deployment reference и результат в journal;
6. обновляет Linear только проверенными фактами.

Следующий batch строится поверх текущего `main`; workers не обязаны ждать UAT,
если их новые задачи независимы от обнаруженного дефекта.

## 9. Repair-first policy

Failed prerelease guardrail или сломанный UAT имеет приоритет над новой обычной
работой. Новые dispatch временно приостанавливаются, пока coordinator не
классифицирует проблему.

Используются три рекомендуемых маршрута:

1. **Мелкий локальный дефект.** Coordinator исправляет прямо в `main`, запускает
   затронутые проверки и выпускает новый UAT batch.
2. **Дефект одной задачи.** Coordinator reopen-ит исходную Linear issue,
   повышает её приоритет и направляет на обычный feature flow. При отсутствии
   свободного worker coordinator может взять её сам.
3. **Крупный integration defect.** Coordinator создаёт отдельную
   дедуплицированную bug issue с высоким приоритетом и чинит её первым
   доступным исполнителем, включая самого coordinator-а.

UAT defect входит в текущий milestone scope. После failed UAT smoke rollback не
делается: применяется forward fix и выпускается новый candidate. UAT не обязан
оставаться постоянно хорошим, но восстановление его функционирования является
первой задачей run.

## 10. Resume и внешнее вмешательство

При повторном запуске coordinator:

1. находит незавершённый journal exact repository/milestone;
2. сверяет `main`, зарегистрированные worktrees и feature branches;
3. сверяет active Linear issues и последний известный UAT deployment;
4. продолжает с последнего подтверждённого checkpoint либо останавливается с
   понятным конфликтом.

Skill не делает автоматический `reset`, `clean`, stash, force-push или
перезапись чужих изменений. Необъяснимый dirty checkout либо branch drift
останавливает затронутый lane; независимые lanes можно продолжить.

## 11. Completion

Run завершён, когда:

- в exact milestone нет незавершённых in-scope issue и unresolved UAT defects;
- все lanes освобождены, feature branches интегрированы либо явно abandoned;
- `main` clean и прошёл финальный repository gate;
- последний обязательный meaningful batch выпущен в UAT и smoke проверен;
- Linear отражает verified state без ложных completion claims;
- journal помечен `completed`.

Production evidence и production deployment в completion не входят.

## 12. Осознанные компромиссы

Относительно полного `ship-work-release` v1 сознательно не предоставляет:

- provider-neutral task-manager adapters;
- многосессионный handoff/takeover protocol;
- transactional external-effect reconciliation;
- generic control API и сложную pause state machine;
- cryptographic receipt graph и формальную evidence matrix;
- automatic rollback;
- production delivery;
- доказательство корректности при нескольких coordinator writers.

Надёжность v1 обеспечивают один coordinator, Git isolation, atomic JSON
journal, проверка реального Git/Linear/UAT state на resume, exact candidate
gates и fail-closed поведение при необъяснимом конфликте.

## 13. Минимальная проверка реализации

Обязательны:

- unit tests parser-а, journal lock/atomic update и invalid transitions;
- coordinator-only flow без subagent/worktree;
- parallel flow с тремя lanes/worktrees и непересекающимися scopes;
- dependency ordering, scope conflict и worker failure;
- coordinator-only merge и batch creation;
- default continuous UAT и production refusal;
- три repair-first маршрута без rollback;
- crash/resume из каждого durable checkpoint;
- один реальный forward test с coordinator-only;
- один реальный forward test с coordinator + 3 worker-субагентами.

Последние два теста выполняются после локальной детерминированной suite. Они
оценивают поведение skill, а не используются для его разработки.
