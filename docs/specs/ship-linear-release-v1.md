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
6. завершить milestone после проверки repository state и Linear, а для
   созданного в этом run meaningful candidate — также UAT.

Непустой invocation выполняется как один exact-scope Codex Goal. Его terminal
outcome — все незавершённые in-scope issue и обнаруженные defects exact
milestone завершены, интегрированы и проверены; отдельная issue, wave, batch или
успешный deployment являются только прогрессом. `workers=N` задаёт topology, а
не уменьшает результат до N задач.

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
- stable IDs уже завершённых внешних dependencies текущего snapshot;
- batches с candidate SHA, issue/defect IDs, gate и UAT result;
- current UAT SHA и unresolved defects;
- timestamps и last error.

Codex Goal, execution plan и journal имеют разные роли:

- Goal хранит terminal outcome между Goal turns и не разрешает добровольно
  закончить работу после промежуточного результата;
- plan отражает текущую исполнимую последовательность и меняется вместе с
  ready frontier;
- journal хранит durable checkpoints, lanes и evidence для crash/resume.

Ни один из них не доказывает внешний effect и не расширяет sandbox, approvals
или scope пользователя.

Не нужны SQLite, generic reducer, CAS revision protocol, signed receipts,
content-addressed objects, provider broker или schema migration framework.
После crash coordinator перечитывает Git, Linear и UAT, сверяет их с journal и
чинит расхождение явным resume-действием. Journal не может сам доказать внешний
effect.

## 6. Планирование и dispatch

До создания journal и проверки worker capacity coordinator делает дешёвый
read-only inventory:

1. одним paginated `list_issues` получает все issue exact milestone;
2. проверяет, что выборка полная и milestone identity exact;
3. отделяет terminal issue от незавершённых;
4. запускает repo-local `preflight`.

Если незавершённых issue нет, active run с реальной текущей работой отсутствует
и нет уже зарегистрированного failed UAT defect, результат равен `no-work`.
Coordinator немедленно завершает invocation отчётом о Linear и Git state. В
этом пути запрещены `init`, relations/acceptance reads для исторических Done,
worker/subagent allocation, repository gate, local dev, CI wait, batch creation,
UAT deployment и product changes. Предыдущий UAT можно назвать только
датированным историческим evidence; он не становится evidence нового release.

No-work path не создаёт новый Codex Goal. Если уже существует unfinished Goal
того же exact repository/project/milestone, coordinator выполняет terminal
reconciliation и закрывает его только при наличии полного evidence. Чужой Goal
не изменяется.

Если незавершённые issue есть, coordinator запрашивает relations и полную
acceptance только для них и необходимых boundary dependencies. Исторические
terminal issue не становятся tasks текущего run: их stable IDs используются
только как `completed_dependency_ids`.

До первой mutation coordinator вызывает `get_goal`. Exact-scope unfinished Goal
переиспользуется; при его отсутствии явный invocation этого skill авторизует
`create_goal` с self-contained repository/project/milestone identity и done
criteria. Чужой active Goal или отсутствие Goal tools останавливают run до
mutation. `token_budget` не передаётся без отдельного явного положительного
числового бюджета пользователя.

После этого coordinator получает bounded snapshot milestone и строит
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

При таком обновлении ownership проверяется по изменениям feature относительно
merge-base с текущим `main`: уже принятые main-изменения не считаются работой
worker-а, но собственные commits worker-а не могут выйти за выданный scope.

После merge запускаются затронутые проверки. Полный repository gate не
повторяется после каждой маленькой issue; он выполняется для закрытого batch.
Linear issue становится Done только после интеграции и достаточной проверки, а
не после одного worker report.

## 8. UAT batches

UAT разрешён и включён по умолчанию. Worker count не задаёт размер batch.
Coordinator закрывает batch, когда накоплен осмысленный вертикальный результат
либо возникла естественная risk boundary: завершённая связанная группа задач,
важный fix, исчерпание ready frontier или необходимость быстро проверить UAT.

`Ready frontier исчерпан` является boundary только когда в текущем run уже
есть новый интегрированный результат. Batch обязан содержать хотя бы одну
feature, реально прошедшую `claim -> feature-ready -> integrate -> task-done` в
этом run, либо зарегистрированный forward-fix реального prerelease/UAT defect.
Исторические Done, пустой milestone, изменение самого release tooling и простой
факт нового invocation не создают batch и не требуют UAT.

Для exact candidate coordinator:

1. запускает канонический repository gate;
2. запускает локальный dev/smoke, если это требует repository contract;
3. публикует exact candidate в UAT;
4. выполняет обязательный UAT smoke;
5. записывает candidate SHA, deployment reference и результат в journal;
6. обновляет Linear только проверенными фактами.

Следующий batch строится поверх текущего `main`; workers не обязаны ждать UAT,
если их новые задачи независимы от обнаруженного дефекта.

Journal принимает только bounded HTTPS live URL без credentials, query или
fragment. Secret-bearing и signed URLs не являются допустимым evidence.

## 9. Repair-first policy

Failed prerelease guardrail или сломанный UAT имеет приоритет над новой обычной
работой. Новые dispatch временно приостанавливаются, пока coordinator не
классифицирует проблему.

Defect flow можно открыть только для candidate, созданного текущей работой:
после интегрированной feature, failed prerelease gate такого candidate либо
failed UAT batch. Нельзя превращать отсутствие работы или ошибочное ожидание
skill-а в product defect и затем чинить продукт под это ожидание.

Failed UAT блокирует ordinary dispatch сразу после записи результата, ещё до
создания defect record. Блокировка снимается только после нового passing
forward batch, а не после одного локального fix commit.

Используются три рекомендуемых маршрута:

1. **Мелкий локальный дефект.** Coordinator исправляет прямо в `main`, запускает
   затронутые проверки и выпускает новый UAT batch. При регистрации он обязан
   задать не более четырёх непересекающихся repository-relative repair paths.
2. **Дефект одной задачи.** Coordinator reopen-ит исходную Linear issue,
   повышает её приоритет и направляет на обычный feature flow. При отсутствии
   свободного worker coordinator может взять её сам.
3. **Крупный integration defect.** Coordinator создаёт отдельную
   дедуплицированную bug issue с высоким приоритетом и чинит её первым
   доступным исполнителем, включая самого coordinator-а.

Маршрут `coordinator` является только ограниченным repair budget, а не
предварительной бессрочной классификацией. Helper вычисляет changed paths от
affected candidate, число файлов, implementation components и failed repair
attempts. После каждого failed repair check и при любом расширении diff
coordinator обязан выполнить `defect-assess`. Перед `defect-resolve` helper
повторяет оценку по committed forward-fix SHA.

Coordinator repair требует переклассификации, если выполнено хотя бы одно
условие:

- diff вышел за объявленные repair paths;
- изменено больше 12 файлов;
- затронуто больше двух implementation components (support-only `.agents`,
  `docs`, `test` и `tests` в этот счётчик не входят);
- получен третий failed repair attempt.

После срабатывания границы дефект остаётся open и `defect-resolve` fail closed.
Coordinator сначала reopen-ит исходную Linear issue либо создаёт
дедуплицированную high-priority bug, затем записывает её exact stable ID через
`defect-reclassify`. Только после этого forward fix можно закрыть. Уменьшение
последующего diff не сбрасывает уже сработавшую переклассификацию.
Pre-existing open `coordinator` defect без recorded repair paths считается
unbounded и также требует `reopen`/`new-bug`, а не получает legacy bypass.

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
- `main` clean; если run создал candidate, он прошёл финальный repository gate;
- последний обязательный meaningful batch, если он существует, выпущен в UAT и
  smoke проверен;
- Linear отражает verified state без ложных completion claims;
- journal помечен `completed`.

Сначала coordinator повторно получает fully paginated exact Linear inventory и
успешно выполняет journal `complete`. Затем он ещё раз связывает terminal
journal, clean exact `main`, final gate, Linear projection и обязательное UAT
evidence с одним SHA. Только после этого вызывается
`update_goal({"status":"complete"})`. `update_goal` нельзя вызывать после одной
issue, batch, gate или UAT deployment.

Обычная ошибка проверки, worker crash, merge conflict, CI/UAT failure,
медленная работа или неполный результат требуют repair/resume и не являются
Goal blocker. `update_goal({"status":"blocked"})` допустим только после одного
и того же точного blocker в трёх последовательных Goal turns, когда без user
input либо изменения внешнего state meaningful progress невозможен.

Для `no-work` invocation journal обычно вообще не создаётся. Если пустой
journal уже был создан прежним/прерванным запуском и не содержит tasks,
batches или defects, его можно закрыть как `completed` без repository gate и
UAT. Это no-op completion, а не release claim. Во всех остальных случаях
repository gate и passing UAT требуются только для фактически созданного
meaningful batch exact candidate.

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
- terminal-only milestone fast path без journal, relations, gate и UAT;
- Goal contract: no-work не создаёт Goal, непустой run создаёт или exact-scope
  переиспользует Goal, а completion требует zero unfinished work и полный
  Git/Linear/UAT evidence;
- historical Done не попадают в current-run batch;
- no-op completion не требует UAT, а реальная integrated feature требует;
- defect нельзя открыть без current-run candidate;
- default continuous UAT и production refusal;
- три repair-first маршрута без rollback, bounded coordinator assessment и
  обязательная Linear reclassification при расширении scope/resource budget;
- crash/resume из каждого durable checkpoint;
- один реальный forward test с coordinator-only;
- один реальный forward test с coordinator + 3 worker-субагентами.

Последние два теста выполняются после локальной детерминированной suite. Они
оценивают поведение skill, а не используются для его разработки.
