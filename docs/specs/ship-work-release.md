# Автономная доставка work scope

Статус: accepted execution contract, 2026-08-09.

Этот документ является единственной канонической спецификацией
`ship-work-release`. Слова «должен», «запрещено» и «обязательно» задают
нормативное поведение.

## 1. Назначение и принципы

`ship-work-release` доставляет bounded work scope с acceptance-driven
декомпозицией, управляемым параллелизмом, точной integration authority,
восстановлением после crash и проверяемыми release artifacts.

Contract использует следующие принципы:

1. связную write-critical path ведёт один writer;
2. read-only scouts и verifiers могут работать параллельно без worktree;
3. два-три writable lane включаются только для действительно независимой
   работы;
4. worktree принадлежит lane, а не каждому work item;
5. full gate, CI и live release выполняются на осмысленной интеграционной
   границе, а не после каждой маленькой задачи;
6. пользователь получает явный control plane: status, несколько видов
   graceful pause, resume и немедленный UAT cut;
7. orchestration можно улучшать короткими versioned cohorts между безопасными
   границами, не останавливая work scope целиком.

Это не отказ от декомпозиции. Work items по-прежнему задают acceptance,
dependencies и progress. Меняется только предположение, что каждый work item
обязан иметь отдельного исполнителя и отдельный checkout.

## 2. Цели и non-goals

### 2.1 Цели

- уменьшить time-to-first-edit, повторное чтение репозитория, setup зависимостей,
  coordination chatter и merge/revalidation overhead;
- сохранять один понятный integration owner и точную доказательную цепочку от
  work item до live deployment;
- выбирать параллелизм по готовой независимой работе, а не по числу свободных
  agent slots;
- позволить пользователю остановить run на предсказуемой семантической
  границе;
- сделать минимальную verbosity компактной, но не непрозрачной;
- поддержать много UAT cuts внутри одного work scope;
- позволить быстро сравнивать версии orchestration на небольших cohorts;
- применять дорогие durable recovery mechanics только там, где они реально
  нужны.

### 2.2 Non-goals

- Contract не меняет product acceptance, security или определение готовности
  work item.
- Contract не делает code review обязательным после каждого batch или cohort.
- Contract не обещает фоновую реакцию на pause, если Codex Desktop полностью
  остановил model turns.
- Contract не вводит nested work scopes, release trains или cohort entities в
  task-management system.
- Contract не разрешает worker-ам писать в integration branch, task-management
  system,
  UAT/production или общий release state.
- Contract не ослабляет exact-SHA gate, CI, external-effect reconciliation или
  rollback evidence ради скорости.
- `ship-work-release` никогда не deploy-ит production. Production promotion
  остаётся отдельной ручной операцией после явного запроса владельца.

## 3. Термины

| Термин | Значение |
|---|---|
| `task-management adapter` | Lazy-loaded provider adapter, который разрешает work collections/scopes/items и проецирует normalized state обратно в task manager. |
| `work collection` | Provider-specific верхний контейнер работы: project, repository, board или другой bounded namespace. |
| `work scope` | Exact bounded набор work items с общим acceptance/release intent. Его provider-specific представление определяет adapter. |
| `work item` | Наименьшая нормализованная единица acceptance и progress; не обязательно единица исполнения. |
| `writer lane` | Последовательная writable очередь с одним владельцем, одним checkout и непересекающимся ownership. Один lane может выполнить несколько work items. |
| `scout` | Read-only агент для исследования кода, логов, внешних фактов или black-box verification. Он не получает writable worktree. |
| `batch` | Зафиксированное множество готовых изменений, интегрируемое в один exact candidate и проверяемое одним full gate. |
| `candidate` | Exact Git SHA после интеграции batch, ещё не являющийся утверждением о завершении work scope. |
| `dev` | Локально запущенный exact candidate на `localhost` с изолированными local/test data. |
| `UAT` | Отдельная prod-like среда без живых production users. Exact target задаёт project delivery profile. |
| `UAT cut` | Exact candidate, опубликованный в UAT для наблюдения и ограниченной live-проверки. |
| `scope UAT release` | Exact candidate в UAT, который удовлетворяет всему work scope acceptance и полному обязательному UAT evidence. |
| `production` | Отдельная live-среда реальных пользователей. Она не является target этого skill. |
| `cohort` | Последовательность действий и receipts, выполненных одной версией orchestration contract (`contract_sha`). Это не task manager entity и не обязательная review boundary. |
| `checkpoint` | Ближайшая безопасная точка writer-а: сохранённый commit/receipt либо явно preserved unknown state без потери bytes. |
| `quiescent` | Нет нового dispatch, активные writers завершены или fenced, pending external effects reconciled. Quiescent не означает deploy-ready. |
| `hard pause` | Остановка Goal/Codex runtime без гарантированного drain. После неё нужен recovery. |
| `graceful pause` | In-band команда coordinator-у с выбранной boundary и bounded drain. |
| `rollback` | Повторное продвижение последнего известного стабильного deployment/exact SHA внутри той же environment. Это не Git revert и не удаление неудачного commit из integration branch. |

## 4. Project delivery profile и environments

Skill не содержит repository-specific commands, branch names, URLs, providers,
protocol routes или smoke matrix. Их задаёт tracked project delivery profile.
Default path — `docs/operations/ship-work-release-profile.md`; иной path
должен быть явно указан в repository instructions.

Authoritative payload — первый fenced YAML block со schema
`ship-work-release/project-profile/v1`. Narrative объясняет профиль, но не
переопределяет structured values. Profile не содержит secret values: только
имена bindings/variables или ссылки на provider-managed configuration.

Profile обязан задавать:

- stable `profile_id`, task-management adapter ID/contract/reference, work
  collection/scope selector и integration branch/remote;
- install, targeted-check, full-gate и diff-check commands;
- CI provider, required projection и exact-candidate rule;
- dev launcher, readiness signal, URL source, data isolation и smoke matrix;
- UAT target class/identifier, deploy authority, evidence matrix и rollback
  resolver;
- default UAT cadence и review policy;
- production target state, promotion workflow reference и подтверждение, что
  skill не имеет production deploy authority.

Profile проходит fail-closed validation до mutation. Adapter reference
загружается только после разрешения provider ID. Отсутствующее, ambiguous
или противоречивое обязательное поле блокирует run. Coordinator не угадывает
target по repository name, старому receipt, environment variable или
естественному языку пользователя.

Универсальная трёхступенчатая model:

| Environment | Назначение | Authority skill | Минимальное evidence |
|---|---|---|---|
| `dev` | Локальный exact candidate с изолированными local/test data. | Launch, readiness и declared smoke. | Exact candidate, resolved URL/config fingerprint, smoke results и gaps. |
| `UAT` | Prod-like hosted environment без живых production users. | Deploy, live smoke и rollback по project profile. | Exact artifact, CI, target/deployment identity, declared live matrix и previous stable target. |
| `production` | Отдельная live environment реальных users/data. | Нет deploy authority. | Только handoff exact production-eligible candidate; promotion принадлежит отдельному manual workflow. |

Каждый meaningful UAT cut проходит последовательность:

```text
targeted lane checks
→ exact integrated candidate
→ full repository gate
→ project-profile dev launch + declared local smoke
→ expected-old integration branch projection + exact-SHA CI
→ UAT deploy
→ project-profile UAT live evidence
```

UAT cut нельзя выдавать за проверку любого flow, principal/role, protocol,
provider capability или usability criterion, которого нет в сохранённом
evidence. Project profile перечисляет обязательные и conditional flows.

Сам факт automated deploy/smoke означает `cut deployed`, но не «UAT пройден
владельцем». До optional observation cut имеет state
`pending-owner-observation`; он может стать `observed`, `rejected` или
`superseded-unobserved`. `continuous-uat` может продолжать после automated
smoke, но status не приписывает владельцу несуществующий verdict.

Production release не входит ни в один terminal path этого skill. Даже после
полного scope UAT release skill только сохраняет exact production-eligible
candidate и handoff evidence. Фразы `production`, `prod`, «продакшн» или «прод»
не нормализуются в UAT: coordinator отказывается deploy-ить и объясняет, что
нужен отдельный manual production workflow.

## 5. Источники истины и authority

Приоритет источников остаётся таким:

1. явные ограничения пользователя в текущем run;
2. acceptance и dependencies exact work item;
3. `AGENTS.md` затронутой surface;
4. project delivery profile;
5. tracked specifications, manifests, test и release contracts;
6. принятая версия execution specification;
7. pinned orchestration contract exact cohort.

Execution mode, число lanes, review cadence и UAT cadence не меняют acceptance.
Нельзя вернуть legacy delivery profiles под новым названием и объявить
обязательный deploy или test неприменимым только из-за выбранного режима.

Явный запуск без более узкого пользовательского scope выбирает work collection
и scope по project delivery profile через task-management adapter. Adapter
возвращает exact scope snapshot и normalized unfinished work items. Cohorts,
batches и UAT cuts только режут исполнение и evidence; они не сужают product
scope. Adapter ID, work collection, work scope и итоговый item set показываются
в run card до mutation.

В любой момент существует один technical owner следующих side effects:

- запись и integration в local integration branch;
- expected-old push remote integration branch;
- task-manager projections work-item и release facts;
- UAT deployment, live evidence и rollback;
- canonical run state и cohort upgrade.

Writer и scout не выполняют эти действия.

### 5.1 Task-management adapter contract

Contract identity — `ship-work-release/task-manager-adapter/v1`. Каждый
provider adapter реализует один normalized interface:

1. `resolve_collection(profile, user_scope)`;
2. `resolve_scope(collection, selector)`;
3. `snapshot(scope)` без silent truncation;
4. `normalize_item(raw_item)`;
5. `ready_frontier(snapshot)`;
6. `plan_projection(expected_old, desired_state)`;
7. `apply_projection(effect_intent)`;
8. `reconcile_projection(effect_intent)`.

Normalized scope содержит stable adapter/collection/scope refs, bounded item
set, dependency graph, parent/child closure и adapter capabilities. Каждый
normalized work item содержит stable ref, human key, acceptance source,
status class, dependency fingerprint, parent refs и projection metadata.

Core status classes:

```text
backlog | ready | active | blocked | done | canceled
```

Provider-specific entities, statuses, relations, pagination, update format и
API reconciliation принадлежат только adapter reference. Core не импортирует
provider SDK/tool names и не ветвится по provider ID.

Adapter snapshot становится authority только после exact entity reads и полного
pagination. Search/list snippets сами по себе не являются authority. Drift
acceptance, dependencies, scope binding или terminal status инвалидирует старый
fingerprint.

Task-manager writes выполняет только coordinator. Каждая mutation имеет
expected-old value, effect intent и idempotency key; после timeout сначала
выполняется reconcile, а не blind retry.

## 6. Invocation и результат router-а

### 6.1 Интерфейс

```text
$ship-work-release
$ship-work-release lanes=1
$ship-work-release lanes=auto max=3
$ship-work-release lanes=3
$ship-work-release durability=durable
$ship-work-release release=continuous-uat
$ship-work-release review=manual
$ship-work-release dry-run
```

`workers=` является alias `lanes=`. Canonical status использует термин
`lane`, потому что один lane может последовательно выполнить несколько work items.

Нормализация поддерживает natural-language aliases:

| Ввод | Нормализованное значение |
|---|---|
| без capacity | router начинает с `lanes=1`, дальнейшее расширение только по admission gate |
| `lanes=3`, `workers=3`, «3 воркера» | exact sustainable capacity `lanes=3` |
| `lanes=auto`, `workers=auto`, `workers=out`, «всех доступных» | adaptive capacity |
| `auto, не больше 3`, `lanes=auto max=3` | adaptive capacity с hard maximum |

Число work items, scope versions, grace или budget не считается lane count.
Несовместимые явные capacity values требуют одного короткого вопроса до любой
mutation. Count и maximum должны быть положительными.

Без параметров router начинает с одного writer lane. Он может подключить
read-only scouts, а writable parallelism — только после admission gate из
раздела 7. `lanes=1` запрещает расширение write capacity. `lanes=N` задаёт
exact устойчивую resource capacity и fail-closed проверяется до write claims;
ready frontier всё равно может временно дать меньше N активных lanes.

`lanes=auto max=3` разрешает router-у использовать от одного до трёх writable
lanes. Реализация не должна автоматически создавать широкую fleet только потому, что
runtime показывает свободные slots.

`dry-run` выполняет read-only preflight, разрешает exact work collection/scope
через task-management adapter,
строит dependency frontier, router decision, предполагаемые batches/UAT
boundaries и migration risks, но не создаёт claims, branches, comments,
deployments или другой mutable state.

### 6.2 Ортогональные оси решения

Router возвращает и показывает пользователю:

```text
engine = single | parallel | scripted
lanes = 1..N
scouts = off | on-demand
durability = ephemeral | durable
review = manual | on-anomaly | uat | final
release = manual-uat | continuous-uat
reason[]
```

- `single` — default для связной implementation path;
- `parallel` — только независимые writable scopes;
- `scripted` — много однотипных механических единиц с deterministic driver и
  verifier, а не разговорный coordinator на каждую единицу;
- `scouts` — вспомогательная read-only ось, а не отдельная state machine;
- `durable` — persistence/recovery assurance, а не четвёртый execution mode;
- `review` — дополнительная проверка, не замена tests;
- `release` — cadence UAT cuts, не изменение work scope acceptance и не право
  на production deployment.

Default release cadence берётся из project delivery profile. Skill всегда
release-ит только в UAT. `manual-uat` меняет cadence и требует `uat=now`; он
не перенаправляет release в production.

Default для review — `manual`: coordinator не создаёт reviewer-а только потому,
что закончился batch или cohort. Repository contract может явно потребовать
review; тогда он имеет более высокий приоритет.

### 6.3 Когда включается durability

`ephemeral` подходит для одного bounded interactive session без параллельных
writers и внешних effects. `durable` обязателен при любом из условий:

- run должен пережить смену session или unattended period;
- одновременно работают writable lanes;
- начинается push, task manager mutation, deployment или другой внешний effect;
- пользователь явно запросил durable mode;
- уже существует незавершённый durable run.

Upgrade `ephemeral → durable` выполняется на checkpoint до первого внешнего
effect. Downgrade возможен только после quiescent boundary. Safety kernel не
должен загружаться и исполняться полностью на каждом локальном single-lane
шаге, если эти условия отсутствуют.

## 7. Admission gate для writable parallelism

Parallel mode разрешён, только если coordinator может ответить «да» на все
обязательные вопросы:

1. На ready frontier есть минимум две независимые deliverables?
2. Их writable ownership paths не пересекаются либо разделены стабильным API?
3. Им не требуется постоянно синхронизировать одно развивающееся архитектурное
   решение?
4. Каждая deliverable имеет объективный targeted verifier?
5. Setup, coordination, integration и revalidation ожидаемо дешевле экономии
   wall time?
6. Runtime и machine resources поддерживают lanes без shared mutable paths?
7. Есть один integrator, который останется responsive и не станет ещё одним
   competing writer?

Если хотя бы один обязательный ответ отрицательный или неизвестен, write path
остаётся single. Свободные agent slots, большое число work items или большой
token budget сами по себе не являются основанием для parallel mode.

Router записывает короткое обоснование выбора. Например:

```text
engine=single
reason=cross-cutting domain/API change; shared acceptance context
```

или:

```text
engine=parallel lanes=2
reason=independent web copy and API conformance fixtures; disjoint ownership
```

## 8. Lanes, worktrees и зависимости

### 8.1 Single lane

Один writer работает в primary checkout на feature branch. Он может брать
несколько совместимых work items подряд, сохраняя общий контекст, пока
ownership и acceptance остаются связными. Coordinator и writer могут быть
одной session, но технический integration authority остаётся однозначным.

### 8.2 Parallel lanes

Coordinator создаёт не более двух-трёх lanes по умолчанию. У каждого lane:

- фиксированный ID и disjoint ownership manifest;
- один reusable worktree и feature branch lineage;
- собственные `node_modules`, cache, tmp и runtime paths;
- последовательная очередь совместимых work items;
- bounded receipt после каждого атомарного delivery checkpoint.

Worktree переиспользуется между work items одного lane. Новый worktree не
создаётся только из-за нового task-manager identifier. После интеграции lane
приводится в проверенное clean state и rebases/restarts от нового exact base по
явному protocol; пользовательские unknown bytes никогда не удаляются
автоматически.

`npm ci` выполняется один раз при provisioning lane и повторяется только при
изменении lockfile digest, повреждении environment или явном требовании
repository contract. Mutable dependency directories между lanes не шарятся.

### 8.3 Scouts и verifiers

Scout получает narrow read-only question, source boundaries и требуемый формат
ответа. Он возвращает compact facts, file/line references или artifact link, а
не полный transcript. Scout:

- не получает worktree только ради чтения;
- получает exact snapshot/ref; при изменяемом primary checkout читает Git
  objects или другой immutable read-only snapshot, а не случайную смесь двух
  состояний;
- не меняет Git, task manager, UAT target и canonical state;
- не становится owner активного run;
- может исследовать logs, code map, external primary sources или проверить
  exact artifact как black box.

Coordinator перепроверяет применимость advisory результата к current candidate.
Reviewer по умолчанию является таким же read-only verifier-ом.

### 8.4 Scripted batch

Для десятков одинаковых независимых изменений coordinator предпочитает
deterministic script/workflow с явным input list, per-unit result и selective
retry. Агент проектирует и проверяет driver, но не создаёт отдельный разговор и
worktree на каждую механическую единицу.

### 8.5 Work item authority внутри reusable lane

Переиспользование worktree не отменяет per-work-item provenance. В обычном
режиме lane имеет ровно один active work item; следующий work item остаётся
только queued и не получает write authority, пока предыдущий artifact не
committed, не получил receipt и не был integrated, rejected или preserved.

При начале work item coordinator фиксирует:

- immutable work item ID и acceptance/dependency fingerprint;
- lane ID, lane epoch, branch, worktree и exact base SHA;
- ownership manifest и допустимые generated paths;
- active `contract_sha` и cohort;
- required targeted checks и publication guard.

Checkpoint создаёт отдельный immutable feature ref и receipt с exact head SHA.
Diff следующего work item не может попасть в предыдущий receipt. После
integration или явного rejection coordinator проверяет clean/attributable lane
state и только затем переводит reusable worktree на новый exact base.

Изменение task manager acceptance/dependencies после claim инвалидирует старый
fingerprint. Coordinator не публикует artifact автоматически: он re-reads
work item, показывает drift и либо re-plans его, либо сохраняет и fence-ит
работу как неавторитетную. Composite claim нескольких work items допустим только
как явно атомарный delivery с fingerprints всех work items и одним неделимым
acceptance; это исключение, а не способ скрыто смешивать queued work.

Recovery/adoption проверяет fingerprint, lane/owner epoch, exact
branch/worktree/ref binding, actual diff, ownership, checks, contract identity
и guard state. Несовпадение сохраняет bytes, но запрещает integration до
reconciliation.

## 9. Canonical run state

Contract требует одну schema-versioned canonical state model и reducer. Git refs,
task-manager updates, Desktop updates и terminal report являются projections, а
не конкурирующими вручную синхронизируемыми источниками истины.

Минимальные поля:

```text
schema_version
run_id
adapter_id
collection_ref
scope_ref
owner_session_id
owner_epoch
contract_sha
contract_source_sha
cohort_id
repository_base_sha
item_fingerprints{}
engine
durability
review_policy
release_policy
phase
lanes[]  # id, epoch, item_ref, branch, worktree, base/head, guard, disposition
items[]
open_batch
candidate_sha
receipt_refs[]
uat_cuts[]
previous_stable_deployment
pause_request
pending_external_effects[]  # effect ID, intent, exact SHA, idempotency key,
                            # external identity, reconciliation state
last_transition_at
```

Implementation storage специально не выбирается этим contract. Это может быть
repo-local typed file/database и минимальные immutable receipts. Git commit
messages не должны снова становиться неограниченной workflow database с
несколькими независимыми индексами authority.

Каждая transition валидируется reducer-ом и сохраняется один раз. Projection
можно восстановить из canonical state и immutable receipts. Compatibility
fields не участвуют в authority после завершённой migration.

Canonical state хранит текущую authority и ссылки на immutable receipts;
receipts хранят завершённые факты и evidence. Recovery не реконструирует
work item fingerprints, lane bindings, effect intents или rollback target из prose
comments, если эти поля отсутствуют в обоих слоях.

## 10. Пользовательский control API

После запуска пользователь отправляет команды follow-up сообщением в тот же
Codex task. Повторно вызывать новый coordinator не требуется.

| Команда | Семантика |
|---|---|
| `status` | Read-only snapshot без takeover и мутаций. |
| `pause=checkpoint [grace=5m]` | «Дойди до точки с запятой»: прекратить dispatch, bounded drain до ближайших checkpoints, сохранить хвосты, остановиться без gate/deploy. |
| `pause=batch [grace=5m]` | Зафиксировать eligible set, интегрировать его в candidate, выполнить full gate, localhost dev smoke, expected-old publish и exact-SHA CI, остановиться до UAT deployment. |
| `pause=uat [grace=5m]` | Закрыть batch, проверить candidate в dev, сделать UAT cut и live smoke, затем остановиться. |
| `pause=scope` | Продолжать normal delivery до полного scope UAT release и остановиться после него. |
| `uat=now` | Зафиксировать текущий meaningful batch, сделать UAT cut и продолжить run. Пустой cut не создаётся. |
| `resume` | Снять только user pause после preflight/recovery; blockers не игнорируются. |
| `review=now scope=<item|batch|sha>` | Запустить optional read-only review exact snapshot и вернуть findings; без scope используется current candidate/open batch. |
| `config lanes=<...>` | На checkpoint изменить allowed write capacity; расширение снова проходит admission gate, сокращение drains лишние lanes. |
| `config release=<manual-uat|continuous-uat>` | Изменить cadence со следующей batch boundary, не меняя acceptance. |
| `config review=<manual|on-anomaly|uat|final>` | Изменить review policy со следующей подходящей boundary. |
| `flow=upgrade <git-sha>` | На quiescent boundary разрешить immutable contract bundle из указанного Git commit, проверить и принять его, начав новый cohort. |
| `uat verdict=<observed|rejected>` | Привязать optional owner verdict к current exact UAT cut. `rejected` ставит release hold. |
| `rollback=last-stable` | Read-only подготовить exact from/to plan и confirmation ID; live Site ещё не меняется. |
| `rollback=confirm <id>` | Повторно reconcile current UAT target state и выполнить ровно подготовленный rollback plan; drift инвалидирует ID. |

Side effects границ различаются явно:

| Boundary | New dispatch | Lane checkpoint | Remote integration branch/CI | UAT target | Adapter projection | Work scope claim |
|---|---|---|---|---|---|---|
| `pause=checkpoint` | Сразу закрыт | Да, до grace; иначе preserve/fence | Нет, кроме reconciliation уже начатого effect | Нет | Нет новых release-dependent transitions | Нет |
| `pause=batch` | Сразу закрыт | Только latched work-item set | Да: expected-old publish и exact-SHA CI | Нет | Только items, которым live evidence не требуется | Нет |
| `pause=uat` | Сразу закрыт | Только latched work-item set | Да | Да, UAT cut | Только items с полным собственным evidence | Нет |
| `pause=scope` | Продолжается | Normal flow | Да | Да, если contract требует | Все корректно завершённые items | Да, только после full acceptance |

Свободная русская формулировка может нормализоваться в эти команды, но
coordinator всегда подтверждает распознанную boundary до продолжения.

Если `flow=upgrade` вызван из `running`, coordinator временно quiesces run,
выполняет upgrade и возвращается к прежнему running intent. Если run уже был
остановлен пользовательской pause, upgrade не снимает pause: требуется
отдельный `resume`.

### 10.1 Acknowledgement

Как только model turn получил control message, coordinator до новой тяжёлой
операции отвечает:

```text
pause accepted: checkpoint
dispatch: closed
running lanes: 2
grace deadline: 12:35:00Z
deadline enforcement: active
next update: first checkpoint or deadline
```

Conformant реализация не принимает bounded grace как hard guarantee, пока
coordinator не установил timer/callback, способный остановить и fence-ить
lanes. Если client/runtime не доставляет model turn или hard pause уже
остановил control plane, skill не обещает фоновую реакцию и не заявляет
`QUIESCENT`. Поэтому Desktop Goal Pause — не transport для graceful drain.

### 10.2 `/side`

Side task можно использовать для read-only `status`, если canonical durable
state доступен этой session. Side task не получает coordinator claim, не
dispatch-ит workers, не исправляет state и не выполняет recovery. Любая
управляющая команда отправляется в основной активный task.

## 11. Pause state machine

`pause=checkpoint`, `pause=batch` и `pause=uat` немедленно:

1. latch-ит boundary и eligible work-item set: уже `feature-ready` плюс текущий
   атомарный work item каждого active lane;
2. запрещает новый dispatch, refill и новых scouts;
3. reconciles уже начатые external effects, но не повторяет их вслепую;
4. назначает drain deadline всем active writers;
5. публикует user-visible acknowledgement.

`pause=scope` является `stop_at=work scope`, а не drain request: он сохраняет
normal dispatch и только ставит terminal boundary после полного release.

| Состояние | Разрешено | Запрещено |
|---|---|---|
| `running` | Normal dispatch, integration и выбранная release cadence. | Competing coordinator. |
| `draining` | Закончить текущую атомарную операцию, сохранить commit/receipt, reconcile started effect. | New dispatch/refill, расширение latched batch. |
| `settling-batch` | Интегрировать только latched eligible set, gate/CI согласно выбранной boundary. | Late receipts, новые work items, незапрошенный deploy. |
| `settling-uat` | Deploy exact candidate, bounded smoke, rollback receipt. | Следующий batch и scope-complete claim. |
| `quiescent` | Read-only status, handoff, flow upgrade, resume/recovery. | New writes без resume. |
| `recovering` | Reconcile ownership, preserved lanes и pending effects. | Dispatch до coherent state. |

`pause=checkpoint` не входит в `settling-batch`: цель этой команды — быстро и
дёшево сохранить хвосты, а не неожиданно запустить gate, CI или deploy.

При active deadline enforcement после `drain_deadline` неответивший lane
получает disposition
`unknown-preserved`, теряет write authority и fence-ится. Его branch/worktree и
bytes сохраняются. Запрещены `stash`, `reset`, `clean` и автоматическое
объявление lane failed/clean без evidence. Receipt latched active work item
входит в batch, только если достиг checkpoint не позже deadline. Более поздний receipt
инвентаризируется для следующего resume, но не расширяет уже latched batch.

Canonical pause record содержит как минимум:

```text
requested_at
boundary
dispatch_closed_at
latched_item_set
drain_deadline
worker_dispositions
late_artifacts
```

`grace=5m` ограничивает именно writer drain. Gate, exact-SHA CI и UAT deploy
имеют собственные repository timeouts и могут закончиться позже. Поэтому
`pause=checkpoint` — быстрая остановка, а `pause=batch`/`pause=uat` — запрос
дойти до более дорогой semantic boundary. Status всегда показывает текущую
phase и её отдельный deadline.

Реальное прерывание по wall-clock deadline возможно только если runtime даёт
coordinator-у callback/turn или отдельный watcher. Наличие такого механизма —
prerequisite для заявления conformance bounded pause. После emergency hard
pause status может показывать `deadline-passed; enforcement pending`, но такое
состояние не является graceful pause и не даёт права на handoff/deploy. При
первом recovery turn coordinator немедленно применяет fencing и только затем
может подтвердить quiescence.

Quiescent run по умолчанию deploy-ineligible. Исключение — уже завершённая
`pause=uat` или terminal batch с exact candidate, zero live claims, zero pending
effects и полным требуемым evidence.

## 12. Desktop Goal Pause и resume

Один Codex Goal представляет весь work scope run, а не отдельный batch, cohort
или lane. Scouts/workers не создают competing Goals. `QUIESCENT` после
graceful pause не означает Goal `complete` или `blocked`.

Graceful Goal handshake двухфазный:

1. coordinator достигает `QUIESCENT` и публикует `PAUSE_READY`;
2. после этого пользователь при необходимости нажимает Goal Pause.

Между этими шагами любые automatic continuation turns обязаны прочитать
canonical `QUIESCENT` и не выполнять mutation/dispatch. Они не запускают
повторный settlement и не объявляют Goal complete.

Нормальная последовательность для плавной остановки:

1. отправить в активный task `pause=checkpoint`, `pause=batch` или
   `pause=uat`;
2. дождаться acknowledgement и состояния `QUIESCENT`;
3. при необходимости нажать Pause у Goal в Codex Desktop.

Немедленный Goal Pause остаётся emergency hard pause. Он может остановить
model turns до того, как coordinator увидит request, поэтому не гарантирует
checkpoint. После Resume coordinator сначала входит в `recovering`, проверяет
owner epoch, preserved worktrees, claims, current integration branch, contract version и
pending external effects. Только coherent state разрешает новый dispatch.

`resume` не снимает technical blocker, known-bad hold или rejected UAT. Он
снимает только user pause. Cross-session resume гарантируется лишь в durable
mode.

## 13. Observability без log spam

Minimal verbosity означает compact state changes, а не отсутствие информации.
Coordinator показывает:

1. initial run card до первой write mutation;
2. router decision и короткую причину;
3. dispatch/feature-ready/batch-seal/gate/deploy/pause/blocker transitions;
4. heartbeat не реже одного раза в десять минут, если meaningful transition не
   было;
5. обновление не позже следующего model turn после control request;
6. terminal report.

Пример compact status:

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

Raw logs, complete ledger, every poll и token transcript не публикуются в
обычном режиме. `status verbose` может дать bounded diagnostic details.

Coordinator не должен блокироваться на одном tool wait дольше 60 секунд без
возможности обновить пользователя. Long-running gate/deploy показывают start,
последний known state и bounded progress polling.

## 14. Task-manager projection

Task-management system остаётся удобной product projection, но не workflow
database orchestration.

- Work scope хранит product release scope.
- Work items и их иерархия хранят acceptance, dependencies и durable progress.
- Cohort не создаёт новую collection, scope, item или обязательную metadata.
- `contract_sha` и `cohort_id` живут в run state и receipts.
- Optional flow marker допустим только как намеренная аналитическая metadata,
  но не является authority.
- Batch и UAT cut не требуют отдельной task-manager entity.
- Adapter может поддерживать одну обновляемую compact run card; heartbeat не
  превращается в отдельное remote update.

Remote projection содержит только durable факт: ownership при необходимости,
exact feature receipt, integrated candidate, gate/CI/live evidence, blocker или
terminal rationale. Технические retries и polling не спамят task-management
system.

Work item получает normalized status `done`, когда выполнено его собственное
acceptance и весь обязательный для него evidence. Промежуточный UAT cut может
закрыть отдельные work items, но никогда автоматически не закрывает work scope.
Work item, которому нужен multi-principal live proof, не становится `done` на
основании single-principal smoke.

## 15. Work item lifecycle и integration

Рекомендуемый lifecycle:

```text
planned → lane-assigned → implementing → feature-ready
        → integrated → candidate-verified → released-if-required → done
```

`lane-assigned` не означает отдельный worker process. Несколько последовательных
work items могут иметь один lane и общий implementation context.

Writer receipt обязан быть bounded и включать:

- work item IDs и acceptance mapping;
- work item fingerprint/generation, lane epoch и publication guard;
- exact base/head SHA;
- ownership paths и actual changed paths;
- targeted checks и результаты;
- known residuals/blockers;
- `contract_sha`, `cohort_id` и lane ID.

Один integrator проверяет receipt, ownership и diff, затем последовательно
интегрирует feature в candidate. Неинтегрированный late artifact не считается
частью batch.

Targeted checks выполняются в lane. Один полный repository gate выполняется на
exact candidate каждого sealed meaningful batch. Одинаковые aggregate
subcommands не повторяются до full gate без отдельной причины.

Sealed batch после local full gate запускает dev command из project profile,
выполняет declared smoke, затем expected-old продвигает candidate в configured
integration branch и ждёт required exact-SHA CI; только UAT deployment остаётся
за границей `pause=batch`. Если profile использует CI на immutable candidate
ref до integration branch, concrete projection явно показывается в
acknowledgement и receipt.

`pause=batch` означает «projected to configured authoritative remote,
not-deployed-to-UAT», а не local-only stop. Для остановки без нового remote
effect используется `pause=checkpoint`.

## 16. Review policy

Human или LLM review является отдельной осью и по умолчанию `manual`.

| Policy | Когда review запускается |
|---|---|
| `manual` | Только по команде пользователя или явному repository requirement. |
| `on-anomaly` | После заранее перечисленного anomaly trigger. |
| `uat` | Один read-only review exact candidate перед UAT cut. |
| `final` | Один read-only review final candidate. |

Возможные anomaly triggers: ownership violation, repeated targeted failure,
unexpected cross-cutting diff, merge conflict, auth/security surface, state
incoherence или failed live smoke. Router может рекомендовать review, но в
`manual` mode не запускает его молча.

Review:

- привязан к exact diff/SHA и acceptance;
- по умолчанию не требует worktree;
- возвращает actionable findings, а не переписывает feature;
- не заменяет tests, gate, CI, live smoke или owner observation;
- не является обязательной границей cohort.

Runtime-команда `review=now` latch-ит exact work-item diff, batch candidate или SHA
и не читает движущуюся смесь states. Findings сами по себе не мутируют code или
task manager; исправление возвращается в обычный writer flow.

## 17. Batches и частые UAT cuts

### 17.1 Release cadence

Один work scope ожидаемо содержит много cuts:

```text
Work scope 0.2
  0.2-u01
  0.2-u02
  0.2-u03
  ...
  Scope UAT release 0.2
```

`release=continuous-uat` создаёт cut после meaningful batch или явного
`uat=now`. `release=manual-uat` ждёт команды. Meaningful boundary определяется
изменением наблюдаемого vertical slice, risk boundary, dependency wave или
достаточным накопленным объёмом — не каждым маленьким work item и не произвольным
таймером.

`pause=batch` останавливается после candidate gate/dev smoke/CI до UAT
deployment.
`pause=uat` выполняет тот же путь, deploy и bounded live smoke, после чего
останавливается. `uat=now` временно закрывает dispatch, использует ту же latch
семантику и после успешного cut снова открывает normal run. Если latched set не
создаёт meaningful change, run останавливается/продолжается согласно команде,
но пустой deployment не выполняется.

### 17.2 Eligibility UAT cut

Перед deploy обязательны:

- latched batch manifest;
- exact integrated candidate SHA;
- clean integration ownership и отсутствие неизвестных bytes в candidate;
- one full repository gate на exact SHA;
- successful exact-candidate localhost dev launch и declared local smoke;
- required exact-SHA CI;
- reconciled prior push/deploy state;
- известный previous stable UAT deployment для rollback;
- declared smoke scope и known incomplete scope.

Незавершённые preserved worktrees допустимы только если они не входят в
candidate, fenced и не имеют authority на release state. Live claims или
pending external effects, способные изменить candidate, делают cut
неприемлемым.

### 17.3 UAT receipt

Каждый cut сохраняет:

- name (`0.2-u04`) и timestamp;
- exact Git SHA, remote projection и exact-SHA CI result;
- project-profile UAT target/deployment identity и resolved live URL;
- environment `uat`, `profile_id` и target class;
- dev URL/config fingerprint и declared local smoke result;
- evidence class `uat-live`;
- project-profile evidence matrix;
- declared baseline, changed-surface и conditional smoke;
- использованные actors/credentials и тем самым доказанные authorization flows;
- known incomplete scope и failed/not-run flows;
- previous stable deployment и проверенный rollback action;
- owner observation: `pending-owner-observation | observed | rejected |
  superseded-unobserved`.

Evidence хранится как matrix, а не одно общее поле. Для каждой строки
записывается `passed | failed | not-run | not-applicable` с причиной,
client/adapter/provider pair и artifact. Required row со значением, отличным от
`passed`, делает cut unsuccessful. Conditional row можно пропустить только по
явному правилу project profile со ссылкой на последнее compatible exact
evidence.

После automated smoke observation state становится
`pending-owner-observation`. Отсутствие ручного owner verdict не блокирует
дальнейшую автоматическую работу
при `continuous-uat`, если пользователь не запросил `pause=uat`. Rejected cut
ставит release hold и требует явного defect routing.

### 17.4 Scope UAT release

Последний UAT candidate становится scope UAT release только после выполнения
всего normalized scope acceptance и полного обязательного evidence. Если exact SHA уже
развёрнут и current, повторный deployment не нужен: promotion является более
сильным доказательным утверждением, а не копированием тех же bytes.

Финальный report отдельно перечисляет:

- что было доказано UAT cuts;
- какие multi-principal или расширенные flows проверены отдельно;
- exact final SHA и deployment;
- какие capability остаются непроверенными и поэтому не входят в release
  claim.

### 17.5 Rollback

Rollback UAT означает продвижение last-known-good deployment/exact SHA и
повторный bounded smoke. Он не удаляет bad commit из Git и не делает work item
автоматически незавершённым без adapter reconciliation. Receipt фиксирует
причину, from/to deployment, время, smoke и последующий defect plan.

## 18. Cohorts и быстрое улучшение orchestration

### 18.1 Cohort не является batch

Cohort отвечает на вопрос «какой flow выполнял работу», batch — «какие product
changes вместе интегрированы и проверены». Они могут совпасть, но это не
обязательно.

Cohort определяется exact `contract_sha` и порядковым `cohort_id`.
`contract_source_sha` указывает Git commit, из которого получен bundle, а
`contract_sha` является content identity полного исполняемого bundle
(entrypoint, references, helpers и schema). Поэтому unrelated product commit не
создаёт новый cohort, а одинаковый contract имеет одинаковую identity.
Task-management system не нужны дополнительные metadata для такого разбиения:
work-item receipts уже дают mapping
`work item → cohort → batch → candidate`.

### 18.2 Upgrade без work scope freeze

Orchestration можно менять несколько раз внутри hobby work scope. Upgrade
выполняется так:

1. coordinator принимает `flow=upgrade <git-sha>` и текущим trusted contract
   читает из Git object store immutable candidate bundle;
2. закрывает dispatch и достигает quiescent boundary;
3. reconciles pending external effects;
4. проверяет allowlisted manifest, полноту bundle, content digest, schema
   compatibility и targeted contract suite в isolated fixture, не исполняя
   helpers из mutable primary checkout;
5. выполняет schema migration, если она нужна;
6. атомарно меняет pinned `contract_sha` и начинает новый cohort;
7. показывает пользователю diff категории и новый run card;
8. продолжает с preserved product state только если до upgrade run был
   `running`; существующая user pause сохраняется до `resume`.

Running worker никогда не начинает читать частично изменённый mutable skill из
checkout. Skill исполняет pinned contract snapshot
по exact SHA до boundary.

Candidate bundle состоит только из перечисленных tracked entrypoint,
references, helpers, schemas и migrations. Его `contract_sha` вычисляется по
каноническому manifest/content; unrelated files того же commit не получают
execution authority. Authority/state upgrade требует явного подтверждения
пользователя после migration dry-run. Атомарное переключение выполняет текущий
trusted reducer; новый contract получает authority только после успешной
записи новой schema/version и recovery smoke. Failed admission оставляет
старый contract активным и run quiescent.

### 18.3 Категории изменений

| Категория | Примеры | Требования к upgrade |
|---|---|---|
| policy/telemetry | status format, heartbeat, router threshold | Quiescent boundary, targeted contract smoke; open batch можно сохранить с manifest старых receipts. |
| execution protocol | lane reuse, receipt fields, batch latch | Quiescent boundary, compatibility check и revalidation affected receipts. |
| authority/state | schema, CAS, fencing, recovery, external-effect journal | Zero live claims/effects, explicit migration, recovery smoke; предпочтительно новый batch. |

Batch может содержать receipts двух policy cohorts, только если manifest
перечисляет оба `contract_sha`, новый reducer их принимает и exact candidate
полностью revalidated. Несовместимые protocol/state cohorts не смешиваются.

Не требуется обязательный code review, retrospective или ручное одобрение в
конце каждого cohort. Для быстрого feedback достаточно automated contract
smoke, сохранённых метрик и осознанного upgrade на safe boundary.

### 18.4 Как тестировать flow быстро

Вместо заморозки на весь work scope полезен последовательный ablation:

- менять одну существенную policy за cohort либо явно фиксировать несколько
  связанных изменений;
- сравнивать 3–5 похожих deliveries, не требуя идеального лабораторного A/B;
- автоматически собирать time-to-first-edit, setup/install time, wall time,
  cached/uncached/output tokens, повторное чтение repo, conflicts, discarded
  work, gates/CI/deploys, recovery и post-integration defects;
- сравнивать single, single+scouts и две writer lanes;
- выбирать следующую capacity по observed ready frontier и payoff, а не по
  доступным slots.

Orchestration code и product code должны иметь отдельные commits и acceptance.
Они могут попасть в один UAT candidate только по явному намерению пользователя;
в receipt тогда отдельно указано, что cut одновременно проверяет product и
flow change. Это не запрет быстрых итераций, а защита от неявного смешивания
причин сбоя.

## 19. Safety kernel и recovery

Safety kernel обязателен во всех проектах:

- один technical owner integration branch, task-manager projections и UAT target;
- clean-start/no-stash/no-reset/no-clean protection;
- bounded ownership manifests и actual-diff verification;
- immutable feature refs/receipts до интеграции;
- targeted lane checks и один exact-SHA full gate на batch;
- expected-old push и single release owner;
- exact deployment binding и live evidence;
- reconciliation внешнего состояния до retry push, task manager write или deploy;
- conservative fencing: stale worker теряет authority, но не bytes;
- last-known-good deployment и проверяемый rollback;
- full worktree scan при start, terminal cleanup и recovery;
- active-lane scan на обычных boundaries; unknown delta расширяет проверку до
  repo-wide и fail-closed.

Full repo-global CAS/fencing/recovery включается, когда run durable,
multi-writer или выполняет внешние effects. Lightweight single interactive
work не обязана платить весь setup cost заранее, но перед первым side effect
должна пройти upgrade в durable safety envelope.

После crash coordinator сначала устанавливает факты:

1. какой exact contract и cohort действовали;
2. кто владел run и истёк ли owner epoch;
3. какие lane artifacts preserved;
4. что реально находится в local/remote integration branch;
5. произошли ли push, task manager write или UAT deploy;
6. какой candidate и previous stable deployment существовали.

Только затем допустим takeover, adoption, retry или rollback. Необратимые
операции не повторяются по одному лишь отсутствию локального acknowledgement.

## 20. Blockers и terminal semantics

Run продолжает работу на независимом frontier после локального defect. Он
останавливается только когда:

- пользовательская pause boundary достигнута;
- весь work scope завершён;
- remaining frontier действительно blocked;
- state или ownership incoherent и safe recovery невозможен;
- требуется новая authority пользователя или недоступный внешний capability.

Critical error сообщается человеческим языком до repair: что произошло, какие
bytes/effects сохранены, что ещё безопасно, какое действие требуется.

Terminal `complete` требует:

- все work items выбранного scope имеют корректный terminal status;
- dependency/parent closure reconciled;
- zero live claims и pending external effects;
- exact final SHA, gate, CI и обязательный live evidence;
- final task-manager scope projection;
- UAT cuts и final work scope claim не смешаны;
- cleanup не удалил неизвестные пользовательские данные.

Terminal `quiescent` после pause — не `complete` и не автоматически
`release-ready`.

## 21. Что сознательно отсутствует

Contract не добавляет:

- дополнительный staging target, если его не объявляет project profile;
- обязательный manual approval перед каждым UAT cut;
- drafts, feature flags или per-feature rollout;
- отдельного planner/implementer/tester/reviewer на каждый work item;
- nested work scopes для batches/cohorts;
- обязательный persistent OS daemon только ради pause; bounded pause может
  использовать active coordinator timer или runtime callback и без такого
  механизма не считается conformant;
- автоматическую очистку unknown worktrees;
- production claim или production deployment.

Production является отдельной environment для живых пользователей. Её manual
workflow задаёт promotion policy, blast-radius controls, production data
safeguards и release contract. Это не скрытая возможность
`ship-work-release`.

## 22. Packaging skill

Tracked skill не копирует весь contract в каждый agent context. Нормативная
lazy structure:

```text
SKILL.md                 # trigger, authority, router call, universal invariants,
                         # control dispatch, terminal report
references/router.md
references/task-management.md
references/task-manager-<provider>.md
references/modes/single.md
references/modes/parallel.md
references/modes/scripted.md
references/scouts.md
references/durability.md
references/controls.md
references/uat.md
references/review.md
references/state-schema.md
```

Entrypoint должен быть thin router, а не второй полный runbook. Он сначала
читает adapter ID из profile, затем загружает общий task-management contract,
один `task-manager-<provider>.md` и references выбранного
engine/durability/release path. Safety invariants имеют одно canonical описание;
mode references на него ссылаются, а не переписывают. Ownership-based product
docs по-прежнему подбираются программно и selectively. Project-specific values
загружаются из одного delivery profile и не дублируются в skill references.

## 23. Conformance requirements

Conformance suite содержит automated и scenario tests как минимум на:

- deterministic router decisions и parallel admission rejection;
- `workers=` alias и exact/auto lane semantics;
- single lane без лишнего worktree;
- reusable lanes и reinstall только при изменении lock digest;
- scout read-only/no-takeover behavior;
- мгновенное закрытие dispatch после каждого pause command;
- latched batch и отбрасывание late receipt в следующий batch;
- grace deadline, fencing и `unknown-preserved` disposition;
- active timer/callback enforcement до заявления bounded-pause conformance;
- отсутствие gate/deploy при `pause=checkpoint`;
- exact candidate/gate/CI при `pause=batch`;
- dev→UAT promotion и честный environment/evidence class при `pause=uat`;
- hard Goal Pause → recovery до dispatch;
- side-task status без state mutation;
- contract upgrade, compatible mixed receipts и incompatible migration block;
- profile validation, missing-field rejection и отсутствие project-specific
  defaults внутри skill;
- выбор ровно одного declared task-management adapter, нормализация snapshot и
  отказ при unsupported provider;
- external-effect reconciliation после simulated crash на push/task manager/deploy;
- UAT rejection, rollback и distinction от Git revert;
- work-item `done` rules для single-principal и multi-principal acceptance;
- terminal cleanup без удаления unknown bytes;
- observability card и bounded heartbeat;
- отсутствие mutation на continuation turn после `PAUSE_READY`/`QUIESCENT`;

Кроме conformance suite проводится measured rollout: несколько похожих
deliveries в single, single+scouts и selective parallel режимах. Решение о
default thresholds принимается по фактическому wall time, token/tool overhead,
ready frontier, conflicts и defects, а не только по субъективной скорости.

## 24. Configurable runtime parameters

Canonical reducer использует transactional storage и versioned immutable
receipts. Project profile или contract configuration задаёт:

1. grace duration и допустимые repository bounds;
2. cadence quiet heartbeat;
3. anomaly triggers optional review;
4. максимальное число writable lanes;
5. receipt retention;
6. active timer/callback для deadline enforcement.

Отсутствие active deadline mechanism запрещает заявлять bounded graceful pause.
Goal Pause остаётся hard pause и после resume всегда проходит recovery.

## 25. Основания design

Contract опирается на два разных класса evidence.

Operational evidence показывает, что mandatory worktree на каждый work item и
широкий parallelism увеличивают coordination cost. Exact-SHA evidence,
single-writer integration, fencing, recovery и live provider checks остаются
обязательным release safety kernel.

Внешняя практика на 2026-08-09 также поддерживает selective, а не всеобщий
parallelism:

- [Anthropic: when and how to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
  рекомендует single-agent default, context boundaries вместо role conveyor и
  отдельно отмечает кратный token overhead multi-agent;
- [Google Research: scaling agent systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
  показывает выигрыш централизованной координации на parallelizable benchmark и
  деградацию на sequential planning; это общий agent benchmark, не coding-only
  доказательство;
- [GitHub Copilot CLI fleet](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet)
  ограничивает пользу fleet независимыми subtasks и предупреждает о
  дополнительных model interactions/credits;
- [Factory Missions](https://factory.ai/news/missions) описывает sequential
  work scopes, integration gates и targeted parallelism только при низкой цене
  координации;
- [Devin best practices](https://docs.devin.ai/use-cases/best-practices)
  формулирует parallel slices как atomic, independent и objectively verifiable;
- [Codex long-running work](https://learn.chatgpt.com/docs/long-running-work)
  является основанием для follow-up steering, Goal Pause/Resume и side-task UX,
  но не обещает skill-callable graceful pause hook.

Vendor case studies и heuristics не являются универсальным benchmark. Поэтому
точные thresholds lanes, cadence и review остаются предметом
измеренного rollout из раздела 18.4, а не копируются из чужого продукта.

Project-specific thresholds и environment values берутся только из tracked
profile и не угадываются внутри skill.
