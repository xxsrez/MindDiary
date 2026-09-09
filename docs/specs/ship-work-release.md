# Автономная доставка work scope

Статус: accepted execution contract, 2026-08-09.

Этот документ является единственной канонической спецификацией
`ship-work-release`. Слова «должен», «запрещено» и «обязательно» задают
нормативное поведение.

Уточнение для Mind Diary от 2026-09-09: объём проверок обычного UAT run
определяет [профиль revision 9](../operations/ship-work-release-profile.md#обычный-uat-release-соразмерная-приёмка).
Он заменяет в этом проекте прежнюю безусловную полноту gate/smoke/evidence
matrix. Ниже сохраняется полный execution contract, а не обязательный список
всех проверок для каждого cut. Authority, exact artifact, честность результатов
и cleanup этим исключением не ослабляются.

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
| `graceful pause` | In-band команда coordinator-у с выбранной semantic boundary и drain. Wall-clock guarantee существует только в `active-callback`; `turn-bound` явно остаётся best-effort. |
| `rollback` | Повторное продвижение последнего известного стабильного deployment/exact SHA внутри той же environment. Это не Git revert и не удаление неудачного commit из integration branch. |
| `feature-ready` | Work item имеет immutable artifact и receipt, unchanged acceptance/dependency fingerprint, attributable diff в пределах ownership, пройденные targeted checks и открытый publication guard. Это ещё не означает integration или release. |
| `publication guard` | Структурированная проверка перед принятием artifact или external effect: current owner/lane epochs, fingerprints, ownership/diff, checks, contract identity, target expected-old и отсутствие blocking hold должны совпадать с canonical state. Guard имеет только `open` или `held` с typed reasons. |
| `meaningful batch` | Непустой sealed набор, удовлетворяющий хотя бы одному declared profile criterion: наблюдаемое изменение release surface, завершённая dependency wave, отдельная risk boundary или configured size threshold. Решение хранит criterion ID и evidence; произвольный таймер или число мелких items сами по себе недостаточны. |
| `release hold` | Durable запрет нового UAT deploy или scope-release claim из-за rejected/failed/ambiguous cut. Не запрещает reconcile или подготовленный rollback. Снимается отдельной командой только с evidence устранения причины. |
| `known-bad hold` | Durable запрет публикации artifact, который уже связан с подтверждённым defect/integrity failure. Resume его не снимает; clearance требует нового exact artifact либо evidence, указанного hold policy. |
| `terminal work-item status` | `done` либо допустимый `canceled`. `canceled` допустим для completion только при явном исключении из acceptance exact scope и сохранённой причине; иначе scope остаётся blocked. |

## 4. Project delivery profile и environments

Skill не содержит repository-specific commands, branch names, URLs, providers,
protocol routes или smoke matrix. Их задаёт tracked project delivery profile.
Default path — `docs/operations/ship-work-release-profile.md`; иной path
должен быть явно указан в repository instructions.

Authoritative payload и все field/cross-field rules канонически определяет
[`Project profile contract`](ship-work-release-project-profile.md). Это первый
fenced YAML block со schema `ship-work-release/project-profile/v1`. Narrative
объясняет профиль, но не переопределяет structured values. Profile не содержит
secret values: только имена bindings/variables или ссылки на provider-managed
configuration.

Profile объявляет machine-resolvable operations, timeout, evidence и
reconciliation. Core строит resolved state `required | optional |
unconfigured`: `uat.configured=true` делает UAT и dev required;
`ci.required=true` делает CI required; configured dev без UAT может быть
optional; false/null capability становится unconfigured. `required` без
полной конфигурации блокирует run, `optional` можно пропустить только с
сохранённой причиной, `unconfigured` не симулируется и не угадывается.

Profile обязан задавать:

- stable `profile_id`, task-management adapter ID/contract/reference, work
  collection/scope selector и local integration target; remote target задаётся
  только вместе с соответствующей capability;
- install, targeted-check, full-gate и diff-check operations, применимые к
  repository type; package manager, cache layout и команды не задаются core;
- capability states для remote projection и CI, а при их наличии — provider,
  exact-candidate rule и reconciliation;
- capability state для dev, а при её наличии — launcher, readiness signal,
  URL source, data isolation, cleanup и smoke matrix;
- capability state для UAT, а при её наличии — target class/identifier, deploy
  authority, evidence matrix, first-cut bootstrap policy и rollback resolver;
- default UAT cadence и review policy;
- production target state, promotion workflow reference и подтверждение, что
  skill не имеет production deploy authority.

Profile проходит fail-closed validation до mutation. Adapter reference
загружается только после разрешения provider ID. Отсутствующее, ambiguous
или противоречивое обязательное поле блокирует run. Coordinator не угадывает
target по repository name, старому receipt, environment variable или
естественному языку пользователя.

Configured UAT требует `dev=required` и `ci=required`: hosted deployment нельзя
использовать как первую интеграционную проверку. Profile может объявить
неприменимые отдельные smoke rows, но не отключить целиком dev/CI pipeline при
активном UAT. Если проект принципиально не имеет этих gates, его UAT capability
остаётся `unconfigured` до отдельного принятого profile contract.

Универсальная environment model capability-driven:

| Environment | Назначение | Authority skill | Минимальное evidence |
|---|---|---|---|
| `dev` | Локальный exact candidate с изолированными local/test data, если capability configured. | Launch, readiness, cleanup и declared smoke. | Exact candidate, resolved URL/config fingerprint, smoke results и gaps. |
| `UAT` | Prod-like hosted environment без живых production users, если capability configured. | Deploy, live smoke и rollback только по project profile. | Exact artifact, применимые upstream gates, target/deployment identity, declared live matrix и rollback state. |
| `production` | Отдельная live environment реальных users/data. | Нет deploy authority. | Только handoff exact UAT/engineering candidate; eligibility и promotion определяет отдельный manual workflow. |

Для проекта с configured full pipeline каждый meaningful UAT cut проходит
последовательность:

```text
applicable targeted checks
→ exact integrated candidate
→ applicable full repository gate
→ configured dev launch + declared local smoke
→ configured expected-old remote projection + exact-SHA CI
→ UAT deploy
→ project-profile UAT live evidence
```

Если UAT `unconfigured`, skill может завершить engineering work scope с
`release=none`, но не создаёт UAT cut, scope UAT release или production
eligibility claim. Если пользователь запросил UAT, а capability не configured, команда
fail closed до mutation. `release=manual-uat | continuous-uat` допустим только
при configured UAT; `release=none` недопустим при `uat=required`. Profile
default обязан быть `none` при unconfigured UAT.

UAT cut нельзя выдавать за проверку любого flow, principal/role, protocol,
provider capability или usability criterion, которого нет в сохранённом
evidence. Project profile перечисляет обязательные и conditional flows.

Сам факт automated deploy/smoke означает `cut deployed`, но не «UAT пройден
владельцем». До optional observation cut имеет state
`pending-owner-observation`; он может стать `observed`, `rejected` или
`superseded-unobserved`. `continuous-uat` может продолжать после automated
smoke, но status не приписывает владельцу несуществующий verdict.

Production release не входит ни в один terminal path этого skill. Даже после
полного scope UAT release skill только сохраняет exact handoff candidate и UAT
evidence; production eligibility решает отдельный manual workflow. Фразы
`production`, `prod`, «продакшн» или «прод»
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
Нельзя объявить обязательный deploy или test неприменимым только из-за
выбранного execution mode или локальной policy.

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

Provider-neutral identity, selectors, normalized schemas, capability
declaration, closure, projection protocol и errors канонически определяет
[`Контракт task-management adapter`](ship-work-release-task-manager.md).
Contract identity — `ship-work-release/task-manager-adapter/v1`. Каждый
provider adapter реализует его normalized interface:

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
dependency fingerprint, parent refs и projection metadata.
Внешняя dependency за пределами selected item set остаётся typed external
blocker; adapter не втягивает её молча в scope и не скрывает при вычислении
ready frontier. Parent/child за пределами scope либо входит в явно показанный
closure, либо сохраняется как external relation с completion policy.

Normalized progress имеет четыре разные оси:

```text
lifecycle = backlog | ready | active | done | canceled
readiness = ready | blocked | not_applicable | unknown
effective_status = backlog | ready | active | blocked | done | canceled
disposition = pending | accepted | excluded | unsuccessful | incoherent
```

`blocked` обычно является derived readiness, а не обязательным remote status.
Scope completion принимает только `accepted | excluded`; remote `done` без
required evidence и remote `canceled` без exact exclusion authority не
становятся успешным terminal outcome.

Provider-specific entities, statuses, relations, pagination, update format и
API reconciliation принадлежат только adapter reference. Core не импортирует
provider SDK/tool names и не ветвится по provider ID.

Adapter объявляет mapping lifecycle и authoritative projection home для
item/scope facts. Derived readiness/disposition не записываются в вымышленный
provider status: adapter использует declared projection channel либо честно
сообщает unsupported capability. Core не выбирает «item или scope» во время
write и не выводит provider mapping из display name.

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
$ship-work-release release=none
$ship-work-release review=manual
$ship-work-release scope=work-scope:<stable-ref>
$ship-work-release scope=items:<stable-ref-1>,<stable-ref-2>
$ship-work-release dry-run
```

`workers=` является user-facing alias `lanes=`. Canonical status
использует термин `lane`, потому что один lane может
последовательно выполнить несколько work items. Capacity имеет
точную agent semantics:

- без capacity или при `workers=1` coordinator сам является
  единственным writer/worker; worker-субагент и дополнительный
  worker worktree не создаются;
- при `workers=N`, где `N > 1`, runtime запускает ровно `N`
  worker-субагентов и выделяет каждому отдельный writable worktree;
- coordinator не входит в эти `N` workers: он остаётся
  отдельным integrator и single writer canonical state/task-manager
  projection;
- repair-first может временно сделать coordinator-а ещё одним
  product writer-ом; эта emergency работа не меняет запрошенное
  `workers=N` и показывается в status отдельно.

Нормализация поддерживает natural-language aliases:

| Ввод | Нормализованное значение |
|---|---|
| без capacity | exact coordinator-only `lanes=1`; automatic writable expansion запрещён |
| `lanes=3`, `workers=3`, «3 воркера» | три worker-субагента плюс отдельный coordinator |
| `lanes=auto`, `workers=auto`, `workers=out`, «всех доступных» | adaptive capacity |
| `auto, не больше 3`, `lanes=auto max=3` | adaptive capacity с hard maximum |

Число work items, scope versions, grace или budget не считается lane count.
Несовместимые явные capacity values требуют одного короткого вопроса до любой
mutation. Count и maximum должны быть положительными.

Без параметров router работает в coordinator-only `lanes=1`. Он может
подключать read-only scouts, но не расширяет writable capacity без
явного `workers=N | lanes=N | workers=auto | lanes=auto`. Любой явный
parallel request дополнительно проходит admission gate из раздела 7.
`lanes=1` запрещает расширение write capacity. `lanes=N` задаёт
exact устойчивую resource capacity и fail-closed проверяется до write claims;
ready frontier всё равно может временно дать меньше N активных lanes.

`lanes=auto max=3` разрешает router-у использовать от одного до трёх writable
lanes. Реализация не должна автоматически создавать широкую fleet только потому, что
runtime показывает свободные slots.

`scope=work-scope:` выбирает один exact provider scope, а `scope=items:` —
bounded explicit item set внутри разрешённой collection. Значения являются
stable adapter refs, не display names. Selector без exact match, с
неоднозначным parent/dependency closure или за пределами profile collection
fail closed до mutation. Resolved scope и итоговый closure всегда показываются
в run card.

`dry-run` выполняет read-only preflight, разрешает exact work collection/scope
через task-management adapter,
строит dependency frontier, router decision, предполагаемые batches/UAT
boundaries и compatibility risks, но не создаёт claims, branches, comments,
deployments или другой mutable state.

### 6.2 Ортогональные оси решения

Router возвращает и показывает пользователю:

```text
engine = single | parallel | scripted
lanes = 1..N
scouts = off | on-demand
durability = ephemeral | durable
review = manual | on-anomaly | uat | final
release = none | manual-uat | continuous-uat
reason[]
```

- `single` — default для связной implementation path;
- `parallel` — только независимые writable scopes;
- `scripted` — много однотипных механических единиц с deterministic driver и
  verifier, а не разговорный coordinator на каждую единицу;
- `scouts` — вспомогательная read-only ось, а не отдельная state machine;
- `durable` — persistence/recovery assurance, а не четвёртый execution mode;
- `review` — дополнительная проверка, не замена tests;
- `release` — отсутствие hosted release либо cadence UAT cuts; ни одно значение
  не даёт права на production deployment.

Default release cadence берётся из project delivery profile. `none` завершает
применимые engineering gates без hosted release. `manual-uat` меняет cadence и
требует `uat=now`; он не перенаправляет release в production.

При `manual-uat` coordinator не создаёт ни промежуточный, ни финальный cut без
явной UAT-authorizing команды. `uat=now` авторизует один ближайший cut и затем
возвращает manual cadence. `pause=scope` сам является явной one-shot
авторизацией финального scope cut; отдельный `uat=now` для него не нужен. Если
engineering acceptance закончено без одной из этих команд, run переходит в
`quiescent` с `user-authority-required`, а не в `completed`.

Default для review — `manual`: coordinator не создаёт reviewer-а только потому,
что закончился batch или cohort. Repository contract может явно потребовать
review; тогда он имеет более высокий приоритет.
`review=uat` требует configured UAT; при `release=none` его нельзя молча
переименовать в final review.

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

Model/router может предложить decomposition и qualitative reason, но authority
имеет deterministic validator над typed snapshot. Одинаковые canonical input,
profile и router configuration должны давать одинаковый admission result;
natural-language rationale не участвует в решении.

Parallel mode разрешён, только если validator получил `true` на все
обязательные predicates:

1. На ready frontier есть минимум две независимые deliverables?
2. Их writable ownership paths не пересекаются либо разделены стабильным API?
3. Им не требуется постоянно синхронизировать одно развивающееся архитектурное
   решение?
4. Каждая deliverable имеет объективный targeted verifier?
5. Profile/rollout measurements дают положительный payoff: оценка экономии
   wall time выше configured coordination-cost threshold?
6. Runtime и machine resources поддерживают lanes без shared mutable paths?
7. Есть один integrator, который останется responsive и не станет ещё одним
   competing writer?

Каждый predicate хранит typed value `true | false | unknown`, evidence source
и snapshot fingerprint. Model classification может заполнить proposal, но
неизвестный либо неподтверждённый факт не превращается в `true`. Thresholds и
tie-breakers задаются versioned router configuration; их отсутствие означает
single, а не импровизированную оценку.

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

Coordinator не превышает project-profile maximum и admitted capacity. У
каждого lane:

- фиксированный ID и disjoint ownership manifest;
- один reusable worktree и feature branch lineage;
- собственные declared mutable dependency, cache, tmp и runtime paths;
- последовательная очередь совместимых work items;
- bounded receipt после каждого атомарного delivery checkpoint.

Worktree переиспользуется между work items одного lane. Новый worktree не
создаётся только из-за нового task-manager identifier. После интеграции lane
приводится в проверенное clean state и rebases/restarts от нового exact base по
явному protocol; пользовательские unknown bytes никогда не удаляются
автоматически.

Profile-declared install/provision operation выполняется один раз при создании
lane и повторяется только при изменении dependency-lock digest, повреждении
environment или явном требовании repository contract. Mutable dependency,
cache, tmp и runtime directories между lanes не шарятся.

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

## 9. Canonical run state и transactional protocol

Contract требует одну schema-versioned canonical state model и один reducer.
Git refs, task-manager updates, Desktop updates и terminal report являются
projections, а не конкурирующими вручную синхронизируемыми источниками истины.

### 9.1 Типы и обязательные поля

Unknown enum value или отсутствующее обязательное поле блокирует mutation до
schema upgrade; reducer не интерпретирует его эвристически.

```text
RunPhase = preflight | running | draining | settling-batch | settling-uat |
           quiescent | recovering | blocked | completed | aborted | failed
LaneState = available | assigned | implementing | checkpointing |
            feature-ready | integrated | fenced | preserved | rejected |
            failed | closed
ItemStage = planned | assigned | implementing | feature-ready | integrated |
            candidate-verified | released | done | blocked | canceled |
            preserved
BatchState = open | sealed | integrating | candidate-ready | gate-running |
             gate-passed | dev-running | dev-passed | projecting |
             ci-running | verified | verification-failed | rejected | closed
UATCutState = planned | deploying | deployed | evidence-running | successful |
              unsuccessful | rolling-back | rolled-back | superseded
ObservationState = pending-owner-observation | observed | rejected |
                   superseded-unobserved
ControlState = received | accepted | rejected | executing | applied | failed |
               superseded
HoldKind = release | known-bad | external-effect
HoldState = active | cleared
FailureCode = retryable | user-authority-required | capability-unavailable |
              ambiguous-external-effect | integrity-failure |
              acceptance-failure | provider-terminal-failure | user-abort
```

Минимальная typed model:

```text
CanonicalRunState {
  schema_version: positive integer
  state_revision: monotonically increasing uint64
  run_id: globally unique immutable ID
  profile_id: stable ID
  profile_revision: positive integer
  profile_sha256: digest exact fenced profile payload
  adapter_id: stable ID
  adapter_contract_digest: digest
  collection_ref: immutable provider ref
  scope_ref: immutable provider ref or explicit-item-set digest
  scope_snapshot_ref: immutable TaskManagerSnapshotRef
  scope_snapshot_fingerprint: digest
  owner: OwnerAuthority | null
  contract: {contract_sha, contract_source_sha, cohort_id}
  router_config_digest: digest
  repository_base_sha: exact object ID
  expected_integration_sha: exact object ID
  router: {engine, lanes, scouts, durability, review, release, reason_ids[]}
  capabilities: resolved profile capability snapshot
  phase: RunPhase
  item_fingerprints: map<ItemRef, Digest>
  items: map<ItemRef, ItemRecord>
  lanes: map<LaneId, LaneRecord>
  batches: map<BatchId, BatchRecord>
  current_batch_id: BatchId | null
  candidate_sha: exact object ID | null
  receipt_refs: set<ReceiptRef>
  context_snapshot_refs: set<ContextSnapshotRef>
  uat_cuts: map<CutId, UATCutRecord>
  previous_stable_deployment: DeploymentRef | null
  pause_request: PauseRecord | null
  claims: map<ClaimId, ClaimRecord>
  holds: map<HoldId, HoldRecord>
  rollback_plans: map<PlanId, RollbackPlan>
  controls: map<CommandId, ControlRecord>
  external_effects: map<EffectId, EffectRecord>
  failure: {code: FailureCode, subject_ref, evidence_refs[], recovery} | null
  last_transition_at: UTC timestamp
}

OwnerAuthority {
  owner_session_id: stable runtime session ID
  owner_epoch: monotonically increasing uint64
  acquired_at: UTC timestamp
  last_observed_at: UTC timestamp
  authority_reason: acquire | handoff | takeover
}

HoldRecord {
  hold_id: globally unique immutable ID
  kind: HoldKind
  state: HoldState
  subject_ref: artifact, cut or effect ref
  reason_code: closed contract/profile value
  created_by_control_id, evidence_refs[]
  clearance_policy: typed predicate
  cleared_by_control_id: ControlId | null
  clearance_evidence_refs[]
}

CapabilitySnapshot {
  profile_sha256, resolved_at
  dev, remote, ci, uat: {
    state: required | optional | unconfigured
    selected: boolean
    operation_ids[], provider_id, target_ref, timeout_policy
    reconciliation_policy, evidence_contract_digest
  }
  deadline: {
    mode: active-callback | turn-bound | unavailable
    watcher_or_callback_id, monotonic_clock_id, observed_at
  }
}

ContextBindingRecord {
  path: profile-declared dotted path
  type: closed scalar type | artifact-schema ID
  value: typed scalar | null
  artifact_ref: immutable artifact ref | null
  source_kind: profile-declared source
  source_ref: immutable state, receipt or artifact ref
  source_pointer: RFC 6901 pointer
  source_digest: sha256
}

ContextSnapshot {
  schema: ship-work-release/context-snapshot/v1
  context_snapshot_id: globally unique immutable ID
  run_id, state_revision, profile_sha256
  subject_ref: ControlId | EffectId | ReceiptRef
  bindings: map<ProfilePath, ContextBindingRecord>
  created_at: UTC timestamp
  digest: sha256 of canonical snapshot without this field
}

ClaimRecord {
  claim_id, subject_ref, owner_session_id, owner_epoch
  lane_id, lane_epoch, ownership_manifest_digest
  state: active | released | fenced
}

ItemRecord {
  item_ref, fingerprint, stage: ItemStage
  acceptance_refs[], dependency_fingerprint
  lane_id, lane_epoch, publication_guard
  feature_receipt_ref, required_capability_ids[]
  adapter_disposition, evidence_refs[], failure
}

LaneRecord {
  lane_id, epoch, state: LaneState
  owner_session_id, owner_epoch, item_ref
  ownership_manifest_digest, checkout_ref, branch_ref
  base_sha, head_sha, publication_guard
  artifact_ref, checkpoint_deadline, disposition_reason
}

BatchRecord {
  batch_id, sequence, state: BatchState
  item_refs[], latched_at, meaningful_criterion_id, criterion_evidence_refs[]
  manifest_ref, manifest_digest, candidate_sha, capability_snapshot_digest
  operation_refs[], effect_refs[], receipt_refs[], failure
}

BatchManifest {
  schema: ship-work-release/batch-manifest/v1
  batch_id, sequence, item_refs[], artifact_refs[]
  base_sha, candidate_sha
  changed_path_digest, changed_capability_ids[]
  has_changed_release_surface: boolean
  release_source_digest: sha256
  acceptance_row_refs[], evidence_refs[]
}

UATCutRecord {
  cut_id, display_name, batch_id, candidate_sha, state: UATCutState
  observation_state: ObservationState
  product_environment: uat
  platform_deployment_class, target_ref, deployment_ref
  predeploy_receipt_ref, previous_stable_deployment, rollback_state
  evidence_matrix_ref, hold_refs[], receipt_ref
}

ScopeReleaseReceipt {
  schema: ship-work-release/scope-release-receipt/v1
  receipt_id, run_id, scope_ref, scope_snapshot_ref
  scope_completion: accepted | engineering-complete | blocked | aborted
  final_candidate_sha: exact object ID | null
  scope_uat_release_sha: exact object ID | null
  final_cut_id: CutId | null
  deployment_ref: DeploymentRef | null
  acceptance_digest, evidence_matrix_ref, hold_refs[], failure_ref
  created_at: UTC timestamp
  digest: sha256 of canonical receipt without this field
}

PauseRecord {
  pause_id, control_id, boundary
  state: requested | draining | settling | ready | failed | superseded
  requested_at, dispatch_closed_at, latched_item_refs[]
  drain_duration, drain_deadline_utc, deadline_capability
  worker_dispositions[], late_artifact_refs[], failure
}

RollbackPlan {
  plan_id, control_id, cut_id, target_ref
  observed_from, desired_to, expected_old
  evidence_plan, prepared_state_revision, prepared_owner_epoch
  expiration, drift_predicate, state: prepared | applied | invalidated | failed
}

ControlRecord {
  control_id, payload_digest, kind, exact_target_refs[]
  expected_state_revision, expected_owner_epoch, actor_session_id
  context_snapshot_ref, state: ControlState
  result_refs[], failure, received_at, finished_at
}
```

`publication_guard` имеет `{state: open | held, reason_codes[],
checked_state_revision}`. `failure` использует `FailureCode` и evidence refs.
Любое optional/null поле выше допустимо только в состояниях, где объект ещё не
может его иметь; переход обязан заполнить поле до первого guard/effect, который
на него опирается. Exact required-by-state constraints проверяет schema вместе
с transition graph, а не prose caller.

`zero live claims` — derived predicate: в `claims` нет record со
`state=active`, а все lane authorities terminal/released для current epochs.
`PAUSE_READY` — user-visible event, не дополнительный RunPhase: он публикуется
только когда `phase=quiescent`, exact `PauseRecord.state=ready`, zero live
claims и zero pending effects.

Все maps/sets сериализуются в стабильном порядке. `last_observed_at` и
heartbeat являются observability, но сами по себе не создают и не прекращают
authority. Implementation storage специально не выбирается contract-ом: это
может быть repo-local typed file/database и immutable receipts. Git commit
messages не становятся workflow database.

Когда protocol требует state digest, он использует SHA-256 от RFC-8785/JCS
canonical serialization полной typed state revision. Artifact bodies не
встраиваются: state хэширует их immutable refs/digests. Невалидные numbers,
duplicate keys и non-canonical IDs отвергаются до digest.

Каждый command/effect, который читает `value_from`, evidence fact или assertion
path из project profile, получает immutable `ContextSnapshot`. Snapshot связывает
exact profile path с typed value либо artifact pointer, source state revision,
source receipt/ref и digest. Он строится только из полей, объявленных
`profile.context`; неизвестный path, nullable mismatch или drift до effect
инвалидирует plan. `current batch`, `current cut` и `current effect` никогда не
выбираются по времени или display name: reducer разрешает их exact IDs из
control envelope и state.

### 9.2 Reducer, CAS и idempotency

Все state mutations проходят один pure transition interface:

```text
reduce(current_state, control_envelope, typed_payload)
  → applied(new_state, effect_intents[], receipt_writes[])
  | duplicate(previous_result)
  | conflict(current_revision, current_owner_epoch)
  | invalid(reason_code)
```

Mutable envelope всегда содержит `control_id`, `run_id`,
`expected_state_revision`, `actor_session_id`, `expected_owner_epoch` и digest
canonical typed payload.
`control_id` уникален внутри run для semantic intent. Повтор с тем же ID и тем же
canonical payload возвращает сохранённый результат без новой transition или
external effect; тот же ID с другим payload является `invalid`.

`applied` атомарно сохраняет новую `state_revision`, command result,
receipt references и durable external-effect intents. Provider call никогда
не выполняется внутри storage transaction. Если CAS revision или owner epoch
не совпали, reducer не пишет частичный state и не вызывает provider.

Read-only snapshot принимает `run_id` и optional expected revision, но не
требует ownership и не увеличивает revision. Projection можно восстановить из
canonical state и immutable receipts. Recovery не реконструирует fingerprints,
lane bindings, effect intents, hold clearance или rollback plan из prose
comments, если typed fact отсутствует в обоих слоях.

### 9.3 Owner acquisition, handoff, takeover и fencing

Первый owner приобретается CAS-переходом только при `owner=null`. Каждая
authoritative lane mutation, integration, projection и provider dispatch
предъявляет current `owner_session_id`, `owner_epoch` и state revision.

Voluntary handoff двухфазный:

1. current owner закрывает dispatch, достигает `quiescent`, reconciles effects
   и сохраняет `handoff-prepared` receipt с exact successor session;
2. successor одним CAS принимает handoff, увеличивает `owner_epoch` и получает
   authority; старый owner и все его незафиксированные intents fenced.

Takeover без cooperation прежнего owner допустим только после recovery scan и
одного из независимых оснований: runtime подтвердил отсутствие прежней
session/claim либо пользователь явно подтвердил fencing после показа
preserved artifacts и pending effects. Истечение времени или отсутствие
heartbeat само по себе недостаточно. Takeover атомарно увеличивает
`owner_epoch`; два concurrent takeover-а разрешаются CAS, проигравший не
получает authority.

Lane имеет собственный monotonically increasing epoch. Любой artifact/receipt
со старым owner или lane epoch сохраняется, но получает `preserved`/`fenced` и
не проходит publication guard без явной adoption transition. External effect
проверяет epoch непосредственно перед provider call; потерявший epoch intent
не отправляется.

### 9.4 Закрытые state machines

Разрешённые верхнеуровневые transitions:

| State | Допустимые следующие states |
|---|---|
| `preflight` | `running`, `blocked`, `aborted`, `failed` |
| `running` | `draining`, `settling-batch`, `settling-uat`, `quiescent`, `recovering`, `blocked`, `completed`, `aborted`, `failed` |
| `draining` | `settling-batch`, `settling-uat`, `quiescent`, `recovering`, `blocked`, `aborted`, `failed` |
| `settling-batch` | `settling-uat`, `quiescent`, `running`, `recovering`, `blocked`, `completed`, `aborted`, `failed` |
| `settling-uat` | `quiescent`, `running`, `recovering`, `blocked`, `completed`, `aborted`, `failed` |
| `quiescent` | `running`, `recovering`, `blocked`, `completed`, `aborted`, `failed` |
| `recovering` | `running`, `quiescent`, `blocked`, `completed`, `aborted`, `failed` |
| `blocked` | `recovering`, `running`, `quiescent`, `aborted`, `failed` |
| `completed`, `aborted`, `failed` | Нет; это terminal run states. |

Lane проходит `available → assigned → implementing → checkpointing →
feature-ready → integrated → closed`. Из `assigned | implementing |
checkpointing | feature-ready` допустимы также `fenced | preserved | rejected |
failed`; только explicit adoption переводит `preserved` в `assigned` с новым
epoch. `fenced`, `rejected`, `failed` и `closed` terminal для данного lane
epoch. После `integrated → closed` reusable lane ID может открыть новый epoch
в `available` на том же worktree только после clean/attributable check и
перехода на declared exact base; история предыдущего epoch остаётся immutable.

Item проходит основной путь `planned → assigned → implementing → feature-ready
→ integrated → candidate-verified → released → done`. Если release capability
не применима к item, `candidate-verified → done` допустим с evidence
`release-not-applicable`. `blocked`, `canceled` и `preserved` достигаются только
typed transition с reason/evidence; `blocked` и `preserved` могут вернуться в
`assigned`, `canceled` terminal. Provider projection использует отдельные core
axes из §5.1: execution stage не создаёт новый provider lifecycle/status
автоматически.

Batch проходит `open → sealed → integrating → candidate-ready → gate-running
→ gate-passed`. Configured dev даёт `dev-running → dev-passed`; без неё
дальнейший переход сохраняет capability reason. От последнего successful gate
configured remote projection даёт `projecting`, configured CI — `ci-running`,
после чего batch становится `verified`; каждая отсутствующая стадия
пропускается только по capability snapshot. Failure gate/dev/projection/CI
даёт `verification-failed → rejected` с exact failed operation. Только
`verified | rejected` переходят в `closed`; sealed batch больше не принимает
late items.

UAT cut проходит `planned → deploying → deployed → evidence-running →
successful | unsuccessful`. `successful` может стать `superseded`;
`unsuccessful → rolling-back → rolled-back` требует отдельного rollback
effect. Observation state ортогонален deployment state. Control проходит
`received → accepted → executing → applied | failed`; invalid command даёт
`received → rejected`, а replacement до исполнения — `accepted → superseded`.

Любая transition вне этих graphs является `invalid`. Failure record всегда
содержит closed `FailureCode`, subject и preserved evidence. Обычная
исправимая ошибка переводит run в `blocked` или `recovering`; terminal `failed`
разрешён только когда coherent state или integrity безопасно восстановить
нельзя. Добровольное прекращение использует `aborted`/`user-abort` и не
выдаётся за completion.

### 9.5 External-effect journal

Каждый push, task-manager mutation, UAT deploy/rollback и иной внешний side
effect имеет typed record:

```text
EffectState = prepared | intent-durable | in-flight | applied | not-applied |
              ambiguous | quarantined | terminal-failed | canceled
EffectRecord {
  effect_id, effect_kind, provider_id, target_ref
  expected_old, desired_state, exact_artifact
  idempotency_key, capability_snapshot
  context_snapshot_ref
  reconcile_operation, attempts[], external_identity
  state: EffectState
}
```

FSM: `prepared → intent-durable` сохраняется до provider call;
`intent-durable → in-flight` означает, что call может быть отправлен.
Reconciliation переводит `in-flight | ambiguous` только в `applied`,
`not-applied`, `ambiguous` или `terminal-failed`. `prepared | intent-durable`
можно отменить до dispatch; `applied`, `terminal-failed` и `canceled` terminal.
`not-applied → intent-durable` допускает новый attempt того же semantic intent
только после повторной expected-old проверки и записи attempt number. Timeout
никогда не означает `not-applied`.

Adapter объявляет capabilities `native-idempotency`, `expected-old-write`,
`authoritative-read-after-write` и `external-operation-lookup`. Перед effect
core строит capability snapshot и обязан иметь способ после lost
acknowledgement доказать `applied` или `not-applied`. При отсутствии достаточной
комбинации effect не отправляется: run получает
`capability-unavailable`/manual handoff. Если provider не позволяет различить
исходы, state остаётся `ambiguous`, ставится соответствующий hold, и blind
retry запрещён.

Pending effect — любой record в `intent-durable | in-flight | ambiguous`.
Quiescence, handoff и terminal completion требуют zero pending effects;
`ambiguous` разрешается provider evidence или explicit adoption exact external
state. Если evidence недоступно, двухфазная user-confirmed quarantine переводит
effect в `quarantined` и создаёт `external-effect` hold. Она не называет исход,
но разрешает quiescence/handoff и независимую работу; conflicting effects и
completion запрещены. Поздний authoritative reconcile может перевести
`quarantined` в `applied | not-applied | terminal-failed` и снять hold.

## 10. Пользовательский control API

После запуска пользователь отправляет команды follow-up сообщением в тот же
Codex task. Повторно вызывать новый coordinator не требуется.

User-facing shorthand нормализуется в typed envelope из §9.2. Coordinator
берёт user-supplied `control_id` либо устойчиво выводит его из exact входящего
message, разрешает exact `run_id`, target IDs и current
`expected_state_revision`, затем вызывает reducer и показывает IDs/revision в
acknowledgement результата до любой следующей тяжёлой операции. Если в task
больше одного возможного run/cut/plan или target
успел измениться, coordinator задаёт короткий вопрос вместо выбора «текущего»
объекта по догадке. Пользователь может явно передать `run=`, `cut=`, `batch=`,
`item=`, `plan=`; destructive/release commands всегда требуют exact target.

| Команда | Семантика |
|---|---|
| `status [run=<id>] [expected=<revision>]` | Read-only snapshot без takeover и мутаций; optional expected revision обнаруживает stale view, но не запрашивает историческое state. |
| `pause=checkpoint [run=<id>] [grace=5m] [bounded=preferred|required]` | «Дойди до точки с запятой»: прекратить dispatch, drain до ближайших checkpoints, сохранить хвосты, остановиться без нового gate/deploy. |
| `pause=batch [run=<id>] [grace=5m] [bounded=preferred|required]` | Зафиксировать eligible set, интегрировать его в candidate, выполнить все configured pre-UAT gates и остановиться до UAT deployment. |
| `pause=uat [run=<id>] [grace=5m] [bounded=preferred|required]` | Закрыть batch, выполнить configured pre-UAT gates, exact UAT cut и live evidence, затем остановиться. Требует configured UAT. |
| `pause=scope [run=<id>]` | Продолжать normal delivery до полного terminal scope outcome: scope UAT release при configured UAT либо engineering completion при `release=none`. |
| `uat=now [run=<id>]` | Зафиксировать текущий meaningful batch, сделать UAT cut и продолжить run. Требует configured UAT; пустой cut не создаётся. |
| `resume run=<id> pause=<pause-id>` | Снять только exact user pause после preflight/recovery; blockers и holds не игнорируются. |
| `review=now target=<item:id|batch:id|sha:value>` | Запустить optional read-only review exact snapshot и вернуть findings. |
| `config run=<id> lanes=<...>` | На checkpoint изменить allowed write capacity; расширение снова проходит admission gate, сокращение drains лишние lanes. |
| `config run=<id> release=<none|manual-uat|continuous-uat>` | Изменить cadence со следующей batch boundary; UAT modes требуют configured capability. |
| `config run=<id> review=<manual|on-anomaly|uat|final>` | Изменить review policy со следующей подходящей boundary. |
| `$ship-work-release recover prepare run=<id>` | В новом task выполнить read-only recovery scan без takeover и вернуть `recovery_id`. |
| `recover confirm run=<id> recovery=<recovery-id> expected_owner_epoch=<n>` | CAS-takeover после независимого fencing evidence или явного user confirmation; один timeout недостаточен. Recovery plan может включать quarantine неразрешимого effect. |
| `handoff prepare run=<id>` | На quiescent boundary подготовить voluntary handoff и вернуть exact `handoff_id`. |
| `$ship-work-release handoff accept run=<id> handoff=<handoff-id>` | Successor в новом task одним CAS принимает exact handoff; drift или другая session отклоняются. |
| `flow upgrade [prepare] run=<id> source=<git-sha>` | Quiesce и проверить immutable bundle. Compatible fast path применяет его; `prepare` либо authority/state change возвращает `upgrade_id` без authority mutation. |
| `flow upgrade confirm run=<id> upgrade=<upgrade-id> expected_state_revision=<n> expected_owner_epoch=<n>` | Атомарно применить ровно проверенный state transform текущего run и переключить contract; drift инвалидирует confirmation. |
| `uat verdict=<observed|rejected> run=<id> cut=<cut-id>` | Привязать optional owner verdict к exact UAT cut. `rejected` создаёт release hold. |
| `hold clear run=<id> hold=<hold-id> resolution=<typed-ref>` | Снять exact hold только если typed clearance policy и evidence удовлетворены. |
| `rollback prepare run=<id> cut=<cut-id> target=last-stable` | Read-only подготовить exact from/to plan и confirmation ID; UAT ещё не меняется. |
| `rollback confirm run=<id> plan=<plan-id>` | Reconcile current UAT target и выполнить ровно подготовленный rollback plan; drift инвалидирует ID. |
| `abort prepare run=<id>` | Закрыть dispatch, сохранить artifacts, reconcile effects и показать exact последствия без terminal mutation. |
| `abort confirm run=<id> plan=<plan-id>` | Завершить exact run как `aborted`; это не completion, не cleanup unknown bytes и не release claim. |

Side effects границ различаются явно:

| Boundary | New dispatch | Lane checkpoint | Remote integration branch/CI | UAT target | Adapter projection | Work scope claim |
|---|---|---|---|---|---|---|
| `pause=checkpoint` | Сразу закрыт | Да, до grace; иначе preserve/fence | Нет, кроме reconciliation уже начатого effect | Нет | Нет новых release-dependent transitions | Нет |
| `pause=batch` | Сразу закрыт | Только latched work-item set | Все configured pre-UAT projections/CI | Нет | Только items, которым live evidence не требуется | Нет |
| `pause=uat` | Сразу закрыт | Только latched work-item set | Все configured pre-UAT projections/CI | Да, exact UAT cut | Только items с полным собственным evidence | Нет |
| `pause=scope` | Продолжается | Normal flow | Все configured gates | Только при configured UAT | Все корректно завершённые items | Да, после full applicable acceptance |

Свободная русская формулировка может нормализоваться в эти команды, но
coordinator всегда подтверждает распознанную boundary до продолжения.

Если contract upgrade вызван из `running`, coordinator временно quiesces run,
выполняет подтверждённый upgrade и возвращается к прежнему running intent. Если run уже был
остановлен пользовательской pause, upgrade не снимает pause: требуется
отдельный `resume`.

### 10.1 Acknowledgement

Как только model turn получил control message, coordinator до новой тяжёлой
операции отвечает:

```text
pause accepted: checkpoint
control: pause-checkpoint-1 / run: run-17 / revision: 42→43
dispatch: closed
running lanes: 2
grace deadline: 12:35:00Z
deadline enforcement: active-callback
next update: first checkpoint or deadline
```

Deadline capability фиксируется до acceptance:

| Mode | Семантика |
|---|---|
| `active-callback` | Есть timer/callback/watcher, который независимо от нового user turn применит deadline и fencing. Только этот mode даёт bounded guarantee. |
| `turn-bound` | Dispatch закрывается при получении команды, но deadline применяется на следующем доступном coordinator turn. `grace` является target, не гарантией. |
| `unavailable` | Runtime не позволяет даже достоверно продолжить drain; команда становится hard-pause guidance либо отклоняется. |

Resolved deadline capability хранит `mode`, stable `watcher_id` или runtime
callback identity, monotonic clock source и observation time. Drain duration
считается по monotonic elapsed time; UTC deadline используется только для
операторского отображения. Потеря watcher/callback после acceptance не
деградирует гарантию молча: pause переходит в `recovering`, status показывает
`deadline-enforcement-lost`, а handoff/deploy запрещены до fencing.

`bounded=required` отклоняется без `active-callback` до mutation.
`bounded=preferred` безопасно деградирует в `turn-bound` только после явного
acknowledgement с фактическим mode; оно не употребляет слово `bounded` в
terminal claim. Если client/runtime не доставляет model turn или hard pause уже
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
pause_id
control_id
requested_at
boundary
dispatch_closed_at
latched_item_set
drain_deadline
deadline_enforcement: active-callback | turn-bound | unavailable
worker_dispositions
late_artifacts
```

`grace=5m` ограничивает именно writer drain. Gate, exact-SHA CI и UAT deploy
имеют собственные repository timeouts и могут закончиться позже. Поэтому
`pause=checkpoint` — быстрая остановка, а `pause=batch`/`pause=uat` — запрос
дойти до более дорогой semantic boundary. Status всегда показывает текущую
phase и её отдельный deadline.

Реальное прерывание по wall-clock deadline возможно только в
`active-callback`. В `turn-bound` после истечения target status показывает
`deadline-passed; enforcement pending`; такое состояние не является
завершённой graceful pause и не даёт права на handoff/deploy. При первом
recovery turn coordinator немедленно применяет fencing и только затем может
подтвердить quiescence.

Quiescent run по умолчанию deploy-ineligible. Исключение — уже завершённая
`pause=uat` или closed verified batch с exact candidate, zero live claims, zero pending
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
4. heartbeat по configured quiet cadence, если meaningful transition не было;
5. обновление не позже следующего model turn после control request;
6. terminal report.

Status является read-only projection exact state revision. Compact schema
обязательно содержит `run_id`, revision, snapshot UTC/freshness, owner/epoch,
adapter/collection/scope refs, phase, Goal/runtime observation, resolved
capabilities, item counts по adapter axes, lanes, current batch/candidate/cut,
pending control IDs, pause/deadline mode, holds, pending effects и следующую
safe boundary. UI/Goal state помечается как observed projection и не заменяет
canonical phase.

Пример compact status:

```text
run: run-17 / revision 43 / work scope 0.2
snapshot: 2026-08-09T12:30:00Z / age 3s
owner: session s09 / epoch 4 / cohort c03 / contract abc1234
scope: adapter task-manager / collection c17 / scope s02
mode: parallel, 2 lanes / durable / review=manual
capabilities: dev=required, remote=required, ci=required, uat=required
work items: 18 total, 7 unfinished, 3 ready
lanes: 2 running, 0 feature-ready, 1 available
batch: u04 open, 2 work items, candidate none
gate: idle
UAT: 0.2-u03 live, exact 4ac91e2, observation=pending-owner-observation
pause: none
deadline enforcement: active-callback
controls: cmd-8c4 executing
Goal UI: running (observed 3s ago)
holds: none
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

Work item с provider lifecycle `done` получает disposition `accepted`, только
когда выполнено его собственное acceptance и весь обязательный для него
evidence. Промежуточный UAT cut может принять отдельные work items, но никогда
автоматически не закрывает work scope. Work item, которому нужен
multi-principal live proof, не получает `accepted` на основании
single-principal smoke.

Lifecycle `canceled` считается успешным terminal exclusion только если exact scope snapshot
явно исключает item из обязательного acceptance, adapter сохранил actor/reason
и dependency/parent closure после исключения остаётся согласованным. Иначе
disposition становится `unsuccessful`, а не тихим эквивалентом `accepted`.
Mapping `ItemStage → adapter lifecycle/readiness/disposition → provider
projection` является обязательной таблицей adapter-а; reducer не выводит его
из display name.

## 15. Work item lifecycle и integration

Canonical lifecycle задан в §9.4; happy path:

```text
planned → assigned → implementing → feature-ready
        → integrated → candidate-verified → released → done
```

`assigned` не означает отдельный worker process. Несколько последовательных
work items могут иметь один lane и общий implementation context.

Когда release для item неприменим, canonical shortcut
`candidate-verified → done` из §9.4 сохраняет
`release-not-applicable`; state `released` не выдумывается.

Writer receipt обязан быть bounded и включать:

- work item IDs и acceptance mapping;
- work item fingerprint/generation, lane epoch и publication guard;
- exact base/head SHA;
- ownership paths и actual changed paths;
- targeted checks и результаты;
- known residuals/blockers;
- `contract_sha`, `cohort_id` и lane ID.

Переход в `feature-ready` разрешён только когда все эти поля присутствуют,
fingerprint всё ещё current, actual diff находится внутри ownership, targeted
checks прошли и publication guard `open`. Любой guard reason переводит guard в
`held`; prose «готово» или worker completion message не заменяет transition.

Один integrator проверяет receipt, ownership и diff, затем последовательно
интегрирует feature в candidate. Неинтегрированный late artifact не считается
частью batch.

Targeted checks выполняются в lane. Один полный repository gate выполняется на
exact candidate каждого sealed meaningful batch. Одинаковые aggregate
subcommands не повторяются до full gate без отдельной причины.

Sealed batch после applicable full gate выполняет configured capabilities в
profile order: dev launch/readiness/smoke/cleanup, expected-old remote
projection и exact-SHA CI. Неприменимая capability сохраняет typed
`not-applicable` reason; required capability не пропускается. Только UAT
deployment остаётся за границей `pause=batch`. Если profile использует CI на
immutable candidate ref до integration branch, concrete projection явно
показывается в acknowledgement и receipt.

`pause=batch` означает «все configured pre-UAT capabilities завершены,
not-deployed-to-UAT». В проекте без remote/CI это может быть local-only exact
candidate с явным capability snapshot. Для остановки до новых configured
effects используется `pause=checkpoint`.

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
typed predicate из §3. Router предлагает criterion/evidence, а reducer проверяет
его по versioned profile rules. Если ни один criterion не доказан, automatic
cut не создаётся; `uat=now` может выбрать непустой batch явно, но receipt
фиксирует `user-forced`, а не выдуманный meaningful criterion. Profile может
задать maximum quiet interval только как сигнал предложить cut пользователю,
но таймер сам по себе не делает batch meaningful.

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
- известный previous stable UAT deployment для rollback либо доказанный
  first-cut bootstrap из следующего абзаца;
- declared smoke scope и known incomplete scope.

Незавершённые preserved worktrees допустимы только если они не входят в
candidate, fenced и не имеют authority на release state. Live claims или
pending external effects, способные изменить candidate, делают cut
неприемлемым.

Первый UAT cut не требует несуществующего previous stable deployment. Он
допустим только если `profile.uat.rollback.bootstrap.when_missing_stable_receipt`
задаёт поддерживаемую bootstrap policy, authoritative provider read доказывает
новый/пустой target либо exact declared baseline, а
receipt сохраняет `rollback_state=unavailable-bootstrap` или exact baseline
restore action. Неизвестный уже занятый target блокирует bootstrap. После
первого successful cut его deployment становится last-known-good; failed
bootstrap создаёт release hold и требует manual recovery, а не фиктивный
rollback.

### 17.3 UAT receipt

Каждый cut получает immutable `cut_id`; human name выдаёт reducer из
profile-declared prefix и monotonically increasing run sequence. Повтор команды
с тем же `control_id` возвращает тот же cut ID/name и не расходует sequence.
Каждый cut сохраняет:

- name (`0.2-u04`) и timestamp;
- exact Git SHA, remote projection и exact-SHA CI result;
- project-profile UAT target/deployment identity и resolved live URL;
- `product_environment=uat`, `platform_deployment_class`, `profile_id` и target
  class; platform terminology не переименовывает product environment;
- dev URL/config fingerprint и declared local smoke result;
- evidence class `uat-live`;
- project-profile evidence matrix;
- declared baseline, changed-surface и conditional smoke;
- non-secret actor aliases/classes, credential binding IDs и optional
  one-way fingerprints, которыми доказаны authorization flows;
- known incomplete scope и failed/not-run flows;
- previous stable deployment и проверенный rollback action либо
  `rollback_state=unavailable-bootstrap` с bootstrap evidence;
- owner observation: `pending-owner-observation | observed | rejected |
  superseded-unobserved`.

Evidence хранится как matrix, а не одно общее поле. Для каждой строки
записывается `passed | failed | not-run | not-applicable` с причиной,
client/adapter/provider pair и artifact. Required row со значением, отличным от
`passed`, делает cut unsuccessful. Conditional row можно пропустить только по
явному правилу project profile со ссылкой на последнее compatible exact
evidence.

Receipt никогда не содержит token/password/cookie, credential value,
provider-managed secret, private content или signed URL query. Artifact links
санитизируются, sensitive raw output хранится только в declared protected
store с bounded retention, а receipt содержит redacted reference и digest.

После automated smoke observation state становится
`pending-owner-observation`. Отсутствие ручного owner verdict не блокирует
дальнейшую автоматическую работу
при `continuous-uat`, если пользователь не запросил `pause=uat`. Rejected cut
создаёт exact release hold, делает этот deployment непригодным как
last-known-good, возвращает pointer к предыдущему stable cut либо `null` и
требует явного defect routing. Hold clearance policy содержит
одно из доказательств: rollback successful либо новый исправляющий candidate
прошёл profile-declared pre-UAT affected evidence. Ошибочный verdict не
переписывает immutable event; override требует отдельного project-profile
authority rule и audit receipt, а rejected cut всё равно не становится
last-known-good.
`resume` hold не снимает. `hold clear` применяет policy к exact evidence и
сохраняет clearance receipt; до этого новые UAT deployments и scope-release
claim запрещены, но reconcile и rollback разрешены.

### 17.4 Scope UAT release

Последний successful UAT candidate становится scope UAT release только после выполнения
всего normalized scope acceptance и полного обязательного evidence. Если exact SHA уже
развёрнут и current, повторный deployment не нужен: promotion является более
сильным доказательным утверждением, а не копированием тех же bytes.

Каждый terminal scope outcome создаёт immutable `ScopeReleaseReceipt` из §9.1.
Для `scope_completion=accepted` оба SHA обязательны, равны между собой и
ссылаются на successful current UAT cut без active hold. Для
`engineering-complete` обязателен `final_candidate_sha`, UAT capability должна
быть unconfigured, а UAT/deployment поля равны `null`. Для `blocked | aborted`
неполученные SHA/deployment могут быть `null`, но обязательны exact evidence и
failure/disposition refs. Поэтому context binding может объявить более узкую
non-null форму только для stage, guard которого уже доказал соответствующий
successful outcome.

Если UAT capability `unconfigured`, аналогичный terminal outcome называется
`engineering scope complete`, не `scope UAT release`; он не содержит hosted
или production claim.

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
Rollback plan immutable и связывает `plan_id`, rejected/current `cut_id`,
observed target state, from/to identities, expected-old, evidence plan и
expiration/drift predicate. Confirmation исполняет только exact plan после
повторного authoritative read; первый bootstrap без baseline не обещает
rollback, если profile не дал restore action.

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

1. `flow upgrade [prepare] run=<id> source=<git-sha>` текущим trusted contract читает immutable
   bundle из Git object store, закрывает dispatch, достигает quiescence и
   reconciles effects;
2. static admission проверяет source allowlist, manifest, content digest,
   imports, schema range и capabilities без исполнения candidate code;
3. coordinator сохраняет immutable plan, связанный с current state revision,
   owner epoch, old/new contract digest и change category, и показывает diff;
4. exact source command авторизует isolated no-secret validation и declarative
   state-transform dry-run; explicit `prepare` всегда останавливается на plan;
5. compatible fast path атомарно меняет pinned contract и начинает новый
   cohort;
6. authority/state change после dry-run возвращает `upgrade_id`; только
   `flow upgrade confirm ...` атомарно применяет exact state transform текущего
   run и переключает authority;
7. новый run card показывается до продолжения; прежний `running` intent
   восстанавливается, а существующая user pause сохраняется до `resume`.

Running worker никогда не начинает читать частично изменённый mutable skill из
checkout. Skill исполняет pinned contract snapshot
по exact SHA до boundary.

Candidate bundle описывает tracked manifest schema
`ship-work-release/contract-manifest/v1` с полями `entrypoint`,
`state_schema_version`, compatibility range, required sandbox capabilities и
`files[]`. Каждый file record содержит normalized root-relative POSIX path,
Git mode, byte size и SHA-256 exact Git blob bytes. Paths сортируются по UTF-8
byte order; absolute paths, `..`, duplicates, symlinks, submodules и unlisted
runtime imports запрещены.

Content identity вычисляется однозначно:

```text
canonical_manifest = RFC-8785/JCS({
  schema, entrypoint, state_schema_version, compatibility, capabilities,
  files_sorted
})
contract_sha = sha256("ship-work-release-contract-v1\n" || canonical_manifest)
```

Declared digest в manifest сравнивается с вычисленным; поле declared digest и
сам файл-envelope не входят в hash projection, поэтому circular hash нет.
Одинаковые bytes/metadata дают одинаковый `contract_sha`; unrelated files того
же commit не получают execution authority.

Source commit должен принадлежать exact repository identity из pinned profile
и удовлетворять trust policy текущего pinned contract; bundle читается только
из manifest path текущего contract. Runtime-команда не расширяет этот trust
root или path. До isolated validation candidate bytes только читаются и
хэшируются. Validation
не получает repository write, provider/network, credentials или canonical
state write; декларативные state transforms исполняет текущий trusted reducer над
copy state.

Upgrade plan ID связывает old state digest/revision, owner epoch, source commit,
manifest digest, new contract digest и expiration/drift predicate. Migration
confirmation дополнительно связывает dry-run input/output digests, schema
versions, invariant results и recovery smoke plan. Любой drift инвалидирует
plan/confirmation. Атомарное переключение выполняет текущий trusted reducer;
новый contract получает authority только после записи new schema/state,
old/new digests и успешного recovery smoke. Failed admission/validation/state
transform оставляет прежний pinned contract активным, все bytes preserved, а run —
quiescent или blocked с typed failure.

### 18.3 Категории изменений

| Категория | Примеры | Требования к upgrade |
|---|---|---|
| policy/telemetry | status format, heartbeat, router threshold | Quiescent boundary, targeted contract smoke; open batch можно сохранить с manifest старых receipts. |
| execution protocol | lane reuse, receipt fields, batch latch | Quiescent boundary, compatibility check и revalidation affected receipts. |
| authority/state | schema, CAS, fencing, recovery, external-effect journal | Zero live claims/effects, explicit state transform, recovery smoke; предпочтительно новый batch. |

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
2. кто владеет run, каков current owner epoch и существует ли независимое
   fencing evidence; время последнего heartbeat является только сигналом;
3. какие lane artifacts preserved;
4. что реально находится в local/remote integration branch;
5. произошли ли push, task manager write или UAT deploy;
6. какой candidate и previous stable deployment существовали.

Только затем допустим подтверждённый takeover, adoption, retry или rollback. Необратимые
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

Terminal run phase `completed` требует:

- все work items выбранного scope имеют terminal status по определению §3;
- dependency/parent closure reconciled;
- zero live claims и pending external effects;
- zero active holds;
- exact final artifact и все применимые required gates;
- при configured UAT — successful exact UAT cut и обязательный live evidence;
- при `release=none` — явный `engineering scope complete` без UAT/production
  claim;
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
- обязательный persistent OS daemon только ради pause; bounded pause использует
  только реально доступный timer/callback/watcher, а без него доступен честно
  обозначенный `turn-bound`, но не bounded claim;
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

- одинаковый deterministic router result для одинакового typed input независимо
  от model rationale и parallel rejection при любом `false | unknown`;
- `workers=` alias, exact/auto lane semantics и отдельный coordinator count;
- default/`workers=1` coordinator-only без субагента и лишнего worktree;
- `workers=3` как ровно три worker-субагента с тремя isolated
  worktrees плюс отдельный coordinator;
- reusable lanes и повторный profile install только при изменении dependency
  digest/declared invalidation;
- scout read-only/no-takeover behavior;
- reducer CAS conflict, duplicate `control_id`, same-ID/different-payload
  rejection и atomic state/intent persistence;
- owner acquisition, voluntary handoff, concurrent takeover fencing и отказ
  takeover только по timeout;
- valid/invalid transitions всех closed run/lane/item/batch/UAT/control enums;
- мгновенное закрытие dispatch после каждого pause command;
- latched batch и отбрасывание late receipt в следующий batch;
- grace deadline, fencing, `unknown-preserved`, `active-callback` и честный
  `turn-bound` downgrade; `bounded=required` без capability отклоняется;
- monotonic clock enforcement, watcher loss после acceptance и запрет тихого
  downgrade bounded claim;
- отсутствие gate/deploy при `pause=checkpoint`;
- applicable exact candidate/gates при `pause=batch`;
- required dev/CI→UAT promotion, separate `product_environment`/
  `platform_deployment_class` и честный evidence class при `pause=uat`;
- hard Goal Pause → recovery до dispatch;
- side-task status без state mutation;
- byte-stable contract digest fixtures, source allowlist, unlisted import
  rejection, no-secret sandbox, compatible upgrade и отдельно подтверждённая
  authority/state transform;
- profile validation, missing-field rejection и отсутствие project-specific
  defaults внутри skill;
- `release=none` при unconfigured UAT и fail-closed UAT command;
- выбор ровно одного declared task-management adapter, нормализация snapshot и
  отказ при unsupported provider;
- external-effect FSM после simulated lost acknowledgement, native-idempotency
  и no-safe-reconcile capability fallback без blind retry;
- user-confirmed ambiguous-effect quarantine, safe handoff и запрет
  conflicting effect/completion до authoritative resolution;
- first-UAT bootstrap, rejected hold, exact hold clearance, rollback и
  distinction от Git revert;
- UAT receipt redaction/secret scan и immutable exact cut targeting;
- work-item `done` rules для single-principal и multi-principal acceptance;
- admissible/inadmissible `canceled` terminal status и adapter round-trip;
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
4. максимальное число writable lanes, deterministic admission thresholds и
   tie-breakers;
5. meaningful-batch criteria и optional quiet prompt interval;
6. receipt/artifact retention и redaction policy;
7. available deadline enforcement mode;
8. provider capability/reconciliation timeouts.

Отсутствие active deadline mechanism запрещает заявлять bounded graceful pause,
но позволяет `turn-bound` с явным acknowledgement. Goal Pause остаётся hard
pause и после resume всегда проходит recovery.

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
