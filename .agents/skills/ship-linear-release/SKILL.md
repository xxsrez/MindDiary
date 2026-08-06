---
name: ship-linear-release
description: >-
  Start or continue Mind Diary's autonomous delivery of the current Linear
  milestone. Coordinate one or many isolated issue workers, feature worktrees,
  batched integration, defect triage, exact-SHA verification, OpenAI Sites
  production deployment, rollback, and Linear closure. Support the current
  design-first bootstrap without claiming that service code, CI, Sites, or
  production already exists. Interpret worker count from nearby free-form
  language as well as workers=N/auto. Use only when the user explicitly invokes
  $ship-linear-release or asks to run this current-milestone delivery skill. Do
  not trigger for ordinary issue creation, Linear triage, release planning,
  status reporting, or work on one named issue outside the milestone flow.
---

# Ship Linear Release

Доставляй Linear milestone автономно: feature worktrees -> sealed candidate ->
integrated gate -> default branch -> применимые publish/deploy gates -> `Done`.

Mind Diary находится в design-first bootstrap: сервисный код, CI и deployment
ещё не реализованы. На preflight зафиксируй `delivery_profile` по tracked repo
и live scope:

- `design` — specification/docs: product baseline, links, project-docs
  validator и diff; никаких выдуманных build/deploy/smoke/tag;
- `build` — code без release contract: доступные code/security/integration
  gates, CI и default branch;
- `release` — tracked OpenAI Sites project/config, build/test, web + MCP
  smoke/rollback и version policy; только этот профиль разрешает production
  deployment и tag.

Отсутствие release-профиля не мешает закрыть design/build issue, если её live
acceptance criteria полностью доказаны. Оно мешает только заявлениям о
deployment, production compatibility и полном release, а также issue, чьи
критерии прямо требуют недоступного live evidence.

Root — единственный coordinator; issue workers реализуют только свои ветки.
Используй внутренних subagents, не видимые Codex threads; перечитывай этот файл
в начале каждого goal-хода.

Нормальный путь — contract preflight, feature-only workers, sealed candidate,
integrated gate, доступный pre-push CI и один default push; в `release` — один Sites deploy.
При аномалии GitHub добавь официальный component-scoped status как контекст; при недоступности Git publication с local-only opt-in применяй [offline-delivery.md](references/offline-delivery.md).

## Понять вызов

Разбирай весь текст сообщения, включая free-form русские/английские формы
`worker/воркер/subagent/агент` до или после `$ship-linear-release`:

```text
новый run без указания                         -> 1
workers=N / «три воркера» / «в три потока»     -> N
workers=auto / «используй всех доступных»      -> auto
auto + «не больше N»                           -> auto(max=N)
resume без нового указания                     -> RELEASE_RUN.WORKERS
dry-run                                        -> только read-only план
```

Распознавай только положительное целое; `до/не больше/максимум N` — cap. Не
принимай число issue, batch, шагов, токенов или версий за worker count. При
несовместимых worker-числах задай один короткий вопрос; при нуле/отрицательном
уточни, не имелся ли в виду `dry-run`. Dry-run запрещает Git, Linear и любые
deployment-мутации.

Текущая free-form просьба может изменить worker limit активного run для
следующих dispatch waves: обнови `RELEASE_RUN.WORKERS`, но не прерывай уже
работающих workers. Не наследуй случайное число из старого сообщения при
создании нового run.

`N` — верхняя граница, а не обещание. Вычисли:

```text
effective_workers = min(
  requested_or_auto_limit,
  доступные runtime slots за вычетом coordinator,
  ширина графа готовых независимых issue,
  безопасный лимит CPU/RAM/ports
)
```

Не спрашивай подтверждение, если безопасное значение меньше запрошенного:
одной строкой сообщи распознанный `requested_workers`, фактический
`effective_workers` и ограничивающий фактор. Число workers не равно размеру
batch. Один worker может последовательно подготовить несколько feature refs,
после чего coordinator выпустит их одним batch.

До первой мутации дай один компактный launch summary:

```text
mode=build-and-ship-milestone; profile=<design|build|release>;
unfinished=<n>; ready=<n>;
implementation_required=<n>; workers=<requested/effective + reason>;
lanes=<parallel/serial summary>; gates=<available>; gaps=<not-available>
```

`build-and-ship-milestone` означает, что skill не только публикует готовое, но
и реализует незавершённые issue. Не спрашивай подтверждение этой уже явно
вызванной семантики, но не скрывай объём за словом «release».

Явный недвусмысленный запуск без `dry-run` разрешает в пределах закреплённого
release:

- создавать worktrees, feature/integration branches, commits и origin refs;
- менять статусы и idempotent receipts в Linear;
- автоматически создавать deduplicated linked Bug, назначать на `me` и при
  необходимости добавлять его в тот же milestone;
- fast-forward обновлять default branch;
- при `delivery_profile=release` сохранить/deploy exact artifact только в
  configured production OpenAI Site, проверить live web + MCP и создать новый
  immutable annotated tag по tracked version policy.

Это разрешение не распространяется на продуктовые решения, секреты,
force-push, переписывание истории, другой milestone/project или изменение
внешней инфраструктуры. Пользователь нужен только для настоящего продуктового
выбора, неустранимой неоднозначности или внешнего блокера.

## Ограничить проверки возможностями среды

1. До dispatch и sealing зафиксируй capability boundary текущей среды:
   documented repo commands, docs validator, toolchain, CI, browser/UI paths,
   OKF fixtures/validator, MCP Inspector и client profiles, credentials и
   configured production OpenAI Sites project/bindings.
2. В hard gate включай все доступные проверки, необходимые live acceptance и
   tracked contract. Используй сильнейшие безопасные substitutes: focused
   unit/property/security tests, integration tests, protocol conformance,
   browser flows и local smoke. Substitute уменьшает неопределённость, но не
   доказывает отдельно требуемую live/client/cloud compatibility.
3. Недоступную external/client/platform проверку записывай как
   `not-available` в `GAPS`. Это не автоматически `fail`, но и не разрешение
   переписать acceptance. Если критерий issue или release contract прямо
   требует это evidence, оставь issue незавершённой и зафиксируй настоящий
   blocker/wait; иначе продолжай и не заявляй непроверенную совместимость.
4. Не ослабляй известный дефект: воспроизведённая пользователем либо доступной
   проверкой проблема остаётся настоящим `fail`. Переоткрой исходную issue или
   создай deduplicated linked Bug и выпусти исправление следующим batch.
5. Не устанавливай, не настраивай и не меняй внешнюю инфраструктуру только
   ради прохождения gate без отдельного scope. Capability discovery и
   read-only status допустимы; secrets никогда не помещай в repo или receipts.

## Разделить роли

Coordinator единолично владеет:

- live Linear scope, scheduling, states, claims, Bugs и receipts;
- созданием и удалением task-owned worktrees;
- integration candidate, default branch, Sites deployment, smoke и tags;
- defect attribution, исключением feature, rollback и release ledger.

Каждый свежий issue worker владеет только:

- одним exact Linear issue;
- одним отдельным worktree и `codex/<identifier>-<slug>` branch;
- issue-scoped кодом, тестами, commit и разрешённым manifest-ом local/remote ref;
- bounded `FEATURE_RECEIPT` и `DEFECT_CANDIDATE`.

Worker не мержит default branch, не публикует/deploy, не тегирует, не ставит
`Done` и по умолчанию не мутирует Linear. Протокол worker:
[issue-worker.md](references/issue-worker.md).

Если worker всё же изменил default branch, deployment, tag или Linear,
немедленно заморозь новый dispatch и восстанови фактическое состояние. Не
принимай это как нормальный `FEATURE_RECEIPT`, не повторяй уже случившуюся
мутацию и не разрешай worker-у продолжать. После reconciliation возобновляй
run только по текущему tracked контракту.

## Ограничить orchestration cost

1. Нормальный batch делает один полный integrated gate на validation key и в
   `release` один Sites deploy. Исключения — доказанный rollback и новая source
   generation после исправления.
2. Не используй streaming watcher, который многократно печатает полный job
   tree или лог. Проверяй внешний job компактным JSON/status snapshot не чаще
   одного раза в 45–60 секунд; полный failing log читай один раз и только
   нужный job/range.
3. Жди workers через mailbox с bounded timeout, а не tight polling. После
   timeout без нового события не перечитывай Linear, Git и receipts, если
   внешний state не мог измениться.
4. Батчируй независимые read-only tool calls. Не печатай полный diff, issue
   list, comment history или build log, если достаточно bounded fields,
   `--stat`, failing lines либо сохранённого comment ID.
5. Linear receipts — checkpoints, не telemetry. Не обновляй их при каждом
   poll, shell command или неизменившемся состоянии; правила записи находятся
   в [receipts.md](references/receipts.md).
6. Если normal-path invariant нарушен — появился второй per-issue deploy,
   повторный full gate с тем же validation key, второй deploy той же surface,
   неизвестный worker-side external mutation или дублирующий receipt — сначала
   восстанови ledger и устрани причину, а не продолжай размножать artifacts.

## Выполнить preflight и восстановление

1. Прочитай текущие `AGENTS.md` и все обязательные документы из него. Затем
   проверь Git default branch, remotes, status, refs/tags и только реально
   существующие build/CI/Sites configs, включая `.openai/hosting.json`. Не
   меняй dirty пользовательский checkout.
   Зафиксируй честный `delivery_profile`; для текущего design-first tree по
   умолчанию это `design`, пока tracked implementation/release contract не
   докажет иное.
2. Запиши Git tree OID
   `<pinned_base>:.agents/skills/ship-linear-release` как `contract_digest`;
   он охватывает `SKILL.md` и все bundled protocols. Убедись, что invoked
   contract совпадает с этим tracked tree и доступен из pinned base SHA. Если
   он untracked, отличается только в dirty checkout или отсутствует в base,
   останови реальный запуск до отдельного contract commit. Не dispatch-и
   worker и не откатывайся к старому single-issue delivery path.
3. При `dry-run` выполняй только read-only путь: можно вызвать `get_goal`,
   разрешить exact project/milestone, прочитать scope/statuses/refs и построить
   dependency/conflict graph, proposed cohort, effective worker count и gate
   plan. Не вызывай `create_goal`, не публикуй coordinator ref/comment, не
   создавай worktree и не делай других мутаций. После плана остановись.
4. Вызови `get_goal` read-only.
   - При активном milestone-goal используй только pinned IDs из objective.
   - При отсутствии goal разреши exact Linear project/current milestone, но
     пока не создавай новый goal.
   - Активный другой goal не заменяй и не завершай.
5. Восстанови прерванный run и получи свежий scope в порядке из
   [receipts.md](references/receipts.md): remote refs/tags -> exact-SHA CI ->
   Sites versions/deployments -> Linear scope/receipts -> локальные worktrees.
   - Если сохранённый `contract_digest` отличается от текущего, сначала войди
     в migration checkpoint: запрети новый dispatch, сопоставь старые
     commits/refs/checks/deployments с фактическим state и сохрани пригодные
     exact artifacts.
   - Не объявляй работу недействительной только из-за старой версии skill и не
     повторяй доказанные проверки/deploy. Старые workers больше не получают
     authority; следующий dispatch использует только новый manifest.
   - Обнови coordinator ref и `RELEASE_RUN` новым digest и краткой migration
     записью, затем продолжай с первой реально незавершённой стадии.
6. Если существующий `RELEASE_RUN` имеет status `complete`, свежий scope пуст и
   нет незавершённых artifacts, верни idempotent `already-complete` без нового
   goal/run. Если старый milestone-goal по факту ещё active, заверши его только
   после обычной двойной snapshot-проверки done criteria.
7. Если goal отсутствует и работа есть, прочитай
   [goal-card.md](references/goal-card.md) и создай goal без `token_budget`,
   если пользователь явно не задал положительный budget.
8. Используй один `run_id` на pinned milestone-goal и один durable coordinator
   claim. Публикуй claim через устойчивый remote release-run ref без force и
   соответствующий receipt.
   - Если существующий `RELEASE_RUN` не terminal, resume/observe тот же run; не
     запускай второго coordinator.
   - Если status `complete`, но появились новые незавершённые issue, создай
     новый `run_id` и fast-forward продолжи ledger ref metadata commit-ом.
   - Если active goal fingerprint расходится с active claim, не делай takeover:
     верни `needs-input`.
   Не считай один `In Progress` доказательством ownership.

## Закрепить scope и очередь

1. Разрешай exact project по repo path, remote/product name и live Linear.
   Выбирай только сущность, которую Linear явно считает текущим milestone или
   release. Не хардкодь название/UUID и не переключай активный goal на новый
   milestone.
2. Получи live workflow statuses и labels команды. Используй существующие
   states по их type/name; не создавай новый workflow state ради skill.
3. Если connector release-filter пуст, но scope хранится как milestone, fetch
   issues exact project и фильтруй по `projectMilestone.id`.
4. Получи компактный snapshot всех issue pinned milestone:
   `id/identifier`, milestone ID, title, state, priority, type/labels,
   `createdAt/updatedAt`, dependencies/blockers и board tie-breaker. Полные
   descriptions/comments читай только выбранным issue.
5. Построй fingerprint из отсортированных
   `identifier/state/updatedAt/projectMilestone.id`.
6. Исключай completed/canceled/duplicate states; добавленные и переоткрытые issue
   автоматически попадают в следующий незапечатанный batch.
7. Сортируй готовую очередь:
   `Urgent > High > Medium > Low > No priority`; внутри priority —
   подтверждённый Bug/regression, затем больше разблокируемых issue, старше
   `createdAt`, board position, identifier.

## Спланировать cohort и параллелизм

1. Построй dependency graph и conservative conflict graph по ownership paths,
   затрагиваемым подсистемам, миграциям, generated assets и runtime resources.
   Классифицируй dependency:
   - `code` — downstream можно начать после branch-ready exact SHA
     предшественника в stacked lane того же batch;
   - `release` — downstream требует deployed/Done поведение и идёт только в
     следующем batch;
   - неясную dependency консервативно считай `release`, не выдумывая контракт.
2. Выбери bounded cohort из уже готовых issue. Cohort может быть больше
   `effective_workers`: освобождённый slot получает следующую совместимую
   issue. Не жди будущих задач ради увеличения batch.
3. Держи вместе изменения, для которых общая integrated-проверка экономит
   работу. Отделяй рискованные migrations/architecture changes, несовместимые
   rollout constraints и batch, где marginal integration risk уже выше
   экономии проверки.
4. До dispatch зафиксируй `batch_id`, expected default-branch SHA, queue
   fingerprint, ordered cohort, зависимости и предполагаемые ownership paths.
   Новый ready issue после cutoff идёт в следующий batch.
5. Для каждого issue coordinator:
   - перечитывает full live scope;
   - делает idempotent `WORK_CLAIM`;
   - переводит реально начатую работу в `In Progress`;
   - создаёт worktree от pinned batch root либо exact dependency-base,
     собранного из уже ready ancestor refs;
   - выдаёт отдельные cache/tmp/build/runtime paths и уникальные ports.
6. Переиспользуй content-addressed package-manager cache по toolchain/lockfile,
   но не разделяй между worktrees mutable build output. Не переустанавливай
   зависимости при совпавшем fingerprint и доказанно готовом локальном install.
   Не копируй секреты в Git, receipts или сообщения.
7. Same-path conflict создаёт serial lane: второй issue не dispatch-ится до
   ready receipt первого. Если первый SHA меняет контекст второго, base второго
   должен быть descendant первого и явно записать dependency SHA. Все lanes
   остаются rooted в одном `expected_default_sha`; не подтягивай движущийся
   default branch.
8. Если upstream `FEATURE_RECEIPT` superseded новым descendant SHA, все
   downstream receipts, записавшие старый dependency SHA, временно
   `superseded`. Обнови их branches новым commit/merge через свежих workers и
   перепроверь только affected feature gates. Не force-rewrite опубликованные
   feature refs.

## Запустить issue workers

Заполняй до `effective_workers` slots свежими subagents через
`spawn_agent(agent_type="worker", fork_turns="none")`. Не переиспользуй worker
для другой issue и не разрешай ему собственных subagents.

Если slots временно заняты, сначала дождись/восстанови текущих task-owned
workers. Если subagents недоступны на этой поверхности вообще, coordinator
может последовательно выполнить worker-протокол сам, но только в отдельном
issue worktree и с тем же bounded receipt; не работай в dirty root checkout.

Передай только task-local manifest:

```text
Выполни ровно Linear issue <identifier> (<id>) из project <project_id>,
milestone <release_id>.
Repo: <absolute_repo>. Worktree: <absolute_worktree>. Branch: <branch>.
Batch root SHA: <root_sha>. Base SHA: <sha>.
Dependency SHAs: <ordered refs или none>.
Queue fingerprint: <hash>. Issue updatedAt: <timestamp>.
Ownership paths: <paths>. Isolated env/cache/tmp/ports: <values>.
Resume: <none или exact artifacts>.
Remote mode: <online | offline-local-only>; offline base: <origin SHA или none>.
Forbidden: default branch, Linear mutations, deploy/publish, tags, milestone closure.
Прочитай <worktree>/.agents/skills/ship-linear-release/references/issue-worker.md
и AGENTS.md из worktree. Ты не один: не откатывай и не захватывай чужие
изменения. Не создавай subagents. Верни только bounded receipt.
```

Проверяй receipt без повторения всей работы: exact worktree/branch/HEAD,
origin ref, scope freshness и заявленные checks. `branch-ready` переводи в
существующий `In Review`, если он есть; иначе оставляй в started-state
`In Progress` с ready receipt. Failed issue оставляй незавершённой. Освобождай
slot и продолжай cohort, пока есть готовые задачи.

## Собрать и запечатать batch

После branch-ready receipts следуй
[batch-release.md](references/batch-release.md).

Ключевые инварианты:

1. Собирай batch только в dedicated clean integration worktree от
   `expected_default_sha`.
2. Добавляй exact feature SHAs в топологическом устойчивом порядке. Stacked
   descendant включай только после всех записанных dependency SHAs. После
   каждого merge делай только preflight, `git diff --check` и affected tests —
   не полный suite.
3. Merge-конфликт не разрешай механически. Локальный очевидный конфликт можно
   исправить в candidate; semantic/scope конфликт верни свежему worker в
   исходный feature worktree и supersede receipt.
4. Запечатай поколение: membership, ordered feature SHAs, `candidate_sha`,
   source tree OID, gate contract hash и environment fingerprint.
5. Любая code change, merge, exclusion или revert создаёт новое generation.
   Не вливай default branch бесконечно в каждую feature branch.
6. Один раз выполни полный integrated gate на exact sealed tree.
   Переиспользуй pass только при совпадении
   `tree OID + gate contract hash + environment fingerprint`.
7. Собери canonical gate из текущего `AGENTS.md`, live acceptance и реально
   существующих scripts/configs. Для docs выполняй project-docs validator и
   `git diff --check`; после появления кода добавляй только проверенные
   repo-canonical build/test/lint/security commands. Для OKF fixtures проверяй
   весь bundle strict validator-ом. Для MCP/client/platform compatibility
   используй отдельные exact adapter/client profiles и честно фиксируй gaps.
8. После локального gate и до default push запусти CI exact candidate SHA,
   если существующая CI-конфигурация поддерживает безопасный branch,
   pull-request или manual-dispatch path. Не меняй внешнюю инфраструктуру
   только ради этого milestone. Если pre-push CI недоступен, запиши
   `not-available`; не подменяй им required CI после default push.
9. До CI классифицируй checks как portable или platform-bound. Не сравнивай
   platform-specific baselines на несовместимом runner и не заявляй
   cross-platform/client parity без соответствующего evidence.

## Обработать найденные дефекты

Используй [defect-triage.md](references/defect-triage.md). Coordinator
deduplicate-ит `defect_signature` и выбирает минимальный корректный путь:

- acceptance scope исходной issue — вернуть её в `In Progress`, исправить в
  той же feature branch/worktree, supersede receipt и reseal;
- tiny obvious integration repair без продуктового выбора — отдельный
  candidate fix commit, affected test, затем reseal;
- новая independent/cross-feature regression — автоматически создать
  связанный Linear Bug с repro, expected/actual, provenance, batch/candidate
  SHA, failing gate, previous stable artifact при наличии и acceptance
  criteria; назначить
  `me`, применить существующий label `Bug` и `Regression`, только если такой
  label уже существует;
- blocker, созданный текущим milestone, включить в тот же milestone и
  поставить впереди очереди; неблокирующий defect оставить в backlog и
  продолжить независимую delivery;
- systemic либо дефект второго поколения после generated fix — остановить
  автономную рекурсию и запросить архитектурное/продуктовое решение.

При flake один раз повтори exact failing subcommand на неизменённом SHA.
Противоречивый результат без причины — fail/gap, не pass. После code change
запусти affected check и ровно один новый full integrated gate; feature gates
остальных веток не повторяй.

Если виновную feature можно исключить без нарушения dependencies, пересобери
batch без неё и выпусти независимые issue. Серьёзный defect одной feature не
должен автоматически блокировать весь milestone. Исключение upstream
автоматически исключает его stacked descendants из текущего batch.

## Продвинуть candidate и завершить batch

1. Требуй, чтобы current remote default branch всё ещё равнялась
   `expected_default_sha`, а candidate был её descendant.
2. Push exact candidate в default branch только fast-forward и без любого
   force. При drift создай новое generation на свежем base; переиспользуй
   feature refs, но integrated validation — только при совпавшем validation
   key.
3. Дождись required CI для exact candidate SHA после default push, если
   required CI настроен. Успешный pre-push run не отменяет этот gate, но при
   неизменном validation key не повторяй локальный full suite. Отсутствие
   configured CI запиши как `none`, не выдумывай check.
   При offline opt-in вместо push/CI примени [offline-delivery.md](references/offline-delivery.md).
4. Для `design` и `build` не создавай deployment или tag. Запиши
   `SITES/DEPLOYMENT: not-applicable(profile=<profile>)` и не называй batch
   production release. После доказательства acceptance, integrated gate и
   exact default/CI state можно перейти к Linear closure.
5. Для `release` требуй один configured production OpenAI Site из tracked
   `.openai/hosting.json`/runbook. Web/control, persistence и `/mcp` — flows
   одного Sites release; отдельный container или AWS запрещён без нового
   решения.
6. Найди или один раз создай Sites artifact exact validated SHA, deploy его и
   продолжай по найденным version/deployment IDs после прерывания. Затем
   выполни live authenticated web/control и required MCP client gates.
7. До deploy установи exact `previous_stable` Sites version и rollback
   artifact. Если их нельзя доказать, остановись до deploy; не создавай
   baseline по предположению.
8. Только после успешного Sites web + MCP smoke создай и push immutable
   annotated tag на exact candidate SHA без force, если tracked version policy
   требует tag. Не выводи SemVer из произвольного имени milestone. Если policy
   отсутствует или имя нельзя однозначно сопоставить version, запроси решение
   до первого deploy. Существующий tag не двигай, не удаляй и не переиспользуй.
9. В annotation запиши milestone, batch ID, exact SHA, issue identifiers, Sites
   version/deployment/artifact digest, previous stable и web + MCP smoke.
10. Upsert-ни `BATCH_RELEASE_RECEIPT`; затем обнови issue receipts и переведи
   только issue с полностью доказанным live acceptance в существующий
   completed-state (`Done`, если так он называется). После свежего milestone
   snapshot очисти только task-owned worktrees/refs, чьи commits достижимы из
   default branch либо immutable tag.

Если обязательный post-smoke tag push временно не удался, сохрани exact
состояние `live-awaiting-tag`, не ставь release-scoped issue `Done` и
idempotently продолжи тот же SHA/tag.

## Откатить неудачный production release

При провале production smoke:

1. не создавай новый stable tag и не ставь issue `Done`;
2. зафиксируй failed deployment/version как evidence;
3. redeploy exact saved Sites version из `previous_stable` receipt;
4. проверь предыдущие критические web/control и MCP production flows;
5. создай/верни defect в работу и выпусти исправление новым commit, candidate,
   artifact/deployment и новой immutable version по tracked policy.

Не reset/force default branch. Если Git-состояние надо отменить, сделай явный
revert whole batch или issue в новом commit и выпусти его новой версией.

## Делать checkpoint и завершить goal

За один goal-ход доводи один batch до terminal checkpoint: `integrated`, `locally-integrated`, `released`, `rolled-back`, `needs-input` или доказанного external wait. Не останавливайся
после подготовки одной feature и не проси пользователя запустить следующий
шаг; активный goal продолжает следующий batch автоматически.

Checkpoint должен содержать только:

```text
batch -> profile -> issues -> candidate/default SHA -> validation key ->
Sites/live/tag/rollback -> defects/gaps -> remaining counts
```

Перед следующим batch получи новый Linear snapshot. Goal заверши только после
двух свежих согласованных snapshots без незавершённых issue pinned milestone,
без активных claims/candidate/deployment artifacts и с полным ledger выбранного
profile.

`update_goal(status="blocked")` используй только после трёх последовательных goal-ходов с тем же
внешним блокером. Offline queue с безопасной локальной работой не является
блокером; автоматически исправимая/исключаемая/переоткрываемая проблема — тоже.

После batch throttle-и remote attempts; перед завершением goal попробуй всегда. При любом
handoff с незапушенным local head явно предупреди пользователя по offline-протоколу.

Если пользователь просит изменить этот процесс, сначала обнови skill через
`skill-creator`, проверь его и только затем запускай release.
