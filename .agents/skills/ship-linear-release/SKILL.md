---
name: ship-linear-release
description: >-
  Start or continue Mind Diary's autonomous delivery of the current Linear
  milestone. Coordinate a work-conserving pool of isolated issue workers,
  continuous integration cutoffs, defect triage, exact-SHA verification, OpenAI Sites
  production deployment, rollback, and Linear closure. Support the current
  design-first bootstrap without claiming that service code, CI, Sites, or
  production already exists. Interpret worker count from nearby free-form
  language as well as workers=N/auto. Use only when the user explicitly invokes
  $ship-linear-release or asks to run this current-milestone delivery skill. Do
  not trigger for ordinary issue creation, Linear triage, release planning,
  status reporting, or work on one named issue outside the milestone flow.
---

# Ship Linear Release

Доставляй Linear milestone автономно: continuous issue pool -> rolling integration train ->
immutable cutoff -> global gate -> default -> publish/deploy -> `Done`.

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

Отсутствие release-профиля не мешает закрыть design/build issue с доказанным
acceptance, но запрещает release claims и issue без обязательного live evidence.

Один repo-global owner-session — coordinator; workers реализуют только свои
ветки. При `workers=1` root совмещает роли, при `N>1` coordination не вычитается
из limit. В начале goal-хода перечитай skill и [coordination.md](references/coordination.md).

Нормальный путь — continuous feature-only workers, cheap per-feature ingest, immutable
cutoffs, один global gate/default push на cutoff и в `release` один Sites deploy.
Никаких worker waves или barrier по самому медленному worker.
При технической аномалии GitHub читай [github-outage.md](references/github-outage.md): там находятся status context, Actions waiver, local queue, recovery и handoff.
Чужой checkout и remote drift обрабатывай по [external-main.md](references/external-main.md):
безопасное продолжай, affected scope карантинь, shared lane явно замораживай.
Restart/takeover и поиск незавершённых origin/local artifacts выполняй только по
[crash-recovery.md](references/crash-recovery.md).

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

Только owner-session меняет limit: increase сразу заполняет slots; decrease не
прерывает active issue и останавливает refill до нового limit. Чужая session
отказывает от мутаций. Новый run не наследует случайное старое число.

`N` — configured limit одновременно исполняемых Linear issue; coordinator,
cutoff validation и deploy в это число не входят. Вычисли отдельно:

```text
effective_workers = min(
  requested_or_auto_limit,
  доступная issue execution capacity, включая coordinator-inline lane,
  безопасный лимит CPU/RAM/ports
)
active_target = min(effective_workers, число готовых совместимых issue)
```

Маленький ready-set уменьшает загрузку, но не limit; новая ready issue сразу
занимает свободный slot.

При `N=1` normal path — `coordinator-inline` в отдельном issue worktree. При
`N>1` предпочитай dedicated coordinator + N executors; если runtime считает
root общим slot, hybrid coordinator-worker может занять одну issue lane, чтобы
coordination overhead не уменьшал task concurrency. Полные правила и матрица
sessions находятся в [coordination.md](references/coordination.md).

Если capacity ниже запроса, не спрашивай подтверждение: сообщи `requested`,
`effective`, `active_target` и причину. Workers не равны размеру cutoff; каждая
issue получает fresh identity, а свободный slot — следующую compatible issue.

До первой мутации дай один компактный launch summary:

```text
mode=build-and-ship-milestone; profile=<design|build|release>;
unfinished=<n>; ready=<n>;
implementation_required=<n>; workers=<requested/effective + coordination + reason>;
owner=<new|same|other-session>; lanes=<parallel/serial summary>;
pipeline=<open/active cutoff>; foreign-main=<state/action>;
gates=<available>; gaps=<not-available>
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
- fast-forward обновлять remote default только expected-old CAS;
- при `delivery_profile=release` сохранить/deploy exact artifact только в
  configured production OpenAI Site, проверить live web + MCP и создать новый
  immutable annotated tag по tracked version policy.

Это разрешение не распространяется на продуктовые решения, секреты, обычный
force-push, переписывание истории, другой milestone/project или изменение
внешней инфраструктуры. Explicit expected-old lease разрешён только как CAS
уже доказанного fast-forward. Пользователь нужен только для настоящего
продуктового выбора, неустранимой неоднозначности или внешнего блокера.

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
   создай deduplicated linked Bug и выпусти исправление следующим cutoff.
5. Не устанавливай, не настраивай и не меняй внешнюю инфраструктуру только
   ради прохождения gate без отдельного scope. Capability discovery и
   read-only status допустимы; secrets никогда не помещай в repo или receipts.

## Разделить роли

Coordinator единолично владеет:

- repo-global owner claim, live Linear scope, scheduling, states, Bugs и receipts;
- созданием и удалением task-owned worktrees;
- integration candidate, remote default CAS, Sites deployment, smoke и tags;
- defect attribution, исключением feature, rollback и release ledger.

Каждый свежий issue worker владеет только:

- одним exact Linear issue;
- одним отдельным worktree и run/epoch/claim-scoped
  `codex/<identifier>-<slug>/r<run-key>-e<epoch>-c<generation>` branch;
- issue-scoped кодом, тестами, commit и разрешённым manifest-ом local/remote ref;
- bounded `FEATURE_RECEIPT` и `DEFECT_CANDIDATE`.

Worker не мержит default branch, не публикует/deploy, не тегирует, не ставит
`Done` и по умолчанию не мутирует Linear. Протокол worker:
[issue-worker.md](references/issue-worker.md).

`coordinator-inline` — логически такой же свежий worker claim в отдельном
worktree. Совмещение ролей не разрешает feature lane менять Linear,
integration/default/deploy или расширять issue scope.

Если worker всё же изменил default branch, deployment, tag или Linear,
немедленно заморозь shared integration и восстанови фактическое состояние. Не
принимай это как нормальный `FEATURE_RECEIPT`, не повторяй уже случившуюся
мутацию и не разрешай worker-у продолжать. Безопасные unrelated workers доведи
до ближайшего bounded receipt; после reconciliation возобновляй run только по
текущему tracked контракту.

## Ограничить orchestration cost

1. Выполняй дешёвый feature/ingest gate на каждую issue, но ровно один полный
   integrated gate на validation key cutoff и в `release` один Sites deploy.
   Исключения — доказанный rollback и новая source generation после исправления.
2. Не используй streaming watcher, который многократно печатает полный job
   tree или лог. Проверяй внешний job компактным JSON/status snapshot не чаще
   одного раза в 45–60 секунд; полный failing log читай один раз и только
   нужный job/range.
3. Жди workers через mailbox с bounded timeout, а не tight polling. После
   timeout без нового события не перечитывай Linear, Git и receipts, если
   внешний state не мог измениться; ближайший cutoff deadline остаётся
   допустимым bounded timeout.
4. Батчируй независимые read-only tool calls. Не печатай полный diff, issue
   list, comment history или build log, если достаточно bounded fields,
   `--stat`, failing lines либо сохранённого comment ID.
5. Linear receipts — checkpoints, не telemetry. Не обновляй их при каждом
   poll, shell command или неизменившемся состоянии; правила записи находятся
   в [receipts.md](references/receipts.md).
6. Если normal-path invariant нарушен — появились waves/barrier или второй per-issue deploy,
   повторный full gate с тем же validation key, второй deploy той же surface,
   неизвестный worker-side external mutation или дублирующий receipt — сначала
   восстанови ledger и устрани причину, а не продолжай размножать artifacts.

## Выполнить preflight и восстановление

1. Прочитай `AGENTS.md` и обязательные документы; проверь default/remotes/status,
   refs/tags и существующие build/CI/Sites configs. Primary checkout не меняй;
   сними disposition по [external-main.md](references/external-main.md). Profile
   по умолчанию `design`, пока tracked tree не докажет `build|release`.
2. Для fresh online run `pinned_base` — exact preflight remote default SHA; для
   recovery — сохранённый `CONTRACT.source_sha`, никогда local default. Получи
   объект без обновления shared/local default refs. Запиши tree OID
   `<pinned_base>:.agents/skills/ship-linear-release` как `contract_digest` и
   сверь invoked bundle. Untracked/dirty-only/absent contract — stop до
   отдельного commit; не dispatch-и и не возвращайся к старому flow.
3. При `dry-run` выполняй только read-only путь: можно вызвать `get_goal`,
   разрешить exact project/milestone, прочитать scope/statuses/refs и построить
   dependency/conflict graph, initial ready-set, effective worker count и cutoff
   plan. Не вызывай `create_goal`, не публикуй coordinator ref/comment, не
   создавай worktree и не делай других мутаций. После плана остановись.
4. Вызови `get_goal` read-only.
   - При активном milestone-goal используй только pinned IDs из objective.
   - При отсутствии goal разреши exact Linear project/current milestone, но
     пока не создавай новый goal.
   - При активном другом goal не claim-и, не заменяй и не завершай его; верни `needs-input`.
5. Прочитай repo-global `refs/heads/codex/release/coordinator`, legacy milestone
   coordinator refs и примени [coordination.md](references/coordination.md).
   - Пока любой legacy ref может быть active, не создавай global claim: сначала
     докажи terminal/stop и перенеси ledger; неопределённость — `already-running`.
   - Active claim другой session при любом `N` — `already-running`: не join-и,
     не resume-и и не меняй limit; направь изменение owner-task либо сначала останови её.
   - Active claim этой session разрешает только resume того же run/goal при
     canonical owner proof; прочитанный из ref UUID proof-ом не является.
   - Timeout/stale heartbeat не разрешает takeover: нужен explicit handoff либо
     доказанный stop старой task, затем новый epoch + `recovering`.
6. Если active owner отсутствует и работа есть, первое mutable действие —
   атомарный repo-global claim. Создай `run_id`/случайный 128-bit `run_key`/
   `owner_id`, запиши доступный stable owner-proof, metadata commit с
   неизменным source tree и выиграй exact expected-old CAS. До победы не
   вызывай `create_goal`, не пиши Linear comment/status, не создавай worktree и
   не dispatch-и worker. CAS loser становится read-only observer.
7. Как owner выполни [crash-recovery.md](references/crash-recovery.md): разреши
   pending action, fence старые guard refs, инвентаризируй exact origin/runtime/
   external/Linear/local state, затем reattach, adopt, resume, requeue либо
   quarantine каждую issue. Не dispatch-и до окончания fencing; не повторяй
   доказанные checks/deploy. При contract migration запрети dispatch/integration,
   сохрани пригодные exact artifacts, CAS-запиши новый digest и продолжай с
   первой реально незавершённой стадии только по новому manifest.
8. Если существующий `RELEASE_RUN` имеет status `complete`, свежий scope пуст и
   нет незавершённых artifacts, верни idempotent `already-complete` без нового
   goal/run. Если старый milestone-goal по факту ещё active, заверши его только
   после обычной двойной snapshot-проверки done criteria.
9. После выигранного claim, если goal отсутствует и работа есть, прочитай
   [goal-card.md](references/goal-card.md) и создай goal без `token_budget`,
   если пользователь явно не задал положительный budget. Запиши goal fingerprint
   descendant claim commit-ом и в `RELEASE_RUN`. Active другой goal не заменяй;
   если run ещё ничего не мутировал, CAS-заверши claim как
   `aborted:goal-conflict-before-run`; иначе верни `needs-input`.
   `In Progress` и Linear comments никогда не доказывают ownership.

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
6. Исключай terminal до initial run и не имеющие run artifacts issue. Если issue
   стала `Done` при active claim/ready artifact без terminal delivery evidence,
   не теряй её молча: примени scope reconciliation из `crash-recovery.md`.
   Добавленные и переоткрытые issue сразу попадают в ready-set и `OPEN_CUTOFF`.
7. Сортируй готовую очередь:
   `Urgent > High > Medium > Low > No priority`; внутри priority —
   подтверждённый Bug/regression, затем больше разблокируемых issue, старше
   `createdAt`, board position, identifier.

## Вести continuous pool и integration conveyor

Полностью следуй [coordination.md](references/coordination.md). Ключевые
инварианты:

1. Построй dependency/conflict graph по ownership paths, subsystems,
   migrations, generated assets и runtime resources. `code` dependency может
   использовать exact ready ancestor SHA; `release` dependency ждёт terminal
   release evidence. Неясную зависимость считай `release`.
2. Не выбирай cohort/wave. После каждого terminal worker receipt, dependency
   unlock или limit increase немедленно dispatch-и следующую compatible ready
   issue, пока active count меньше limit.
3. Same-path conflict создаёт только serial lane. Если другая независимая
   issue готова, свободный slot не простаивает.
4. `OPEN_CUTOFF` принимает ready refs по одной feature через cheap ingest gate.
   Ровно один `ACTIVE_CUTOFF` выполняет global gate/default/deploy. Cutoff не
   ждёт in-flight workers; готовые позже refs идут в следующий prefix.
5. Пока active cutoff проверяется или публикуется, pool продолжает работу.
   Integration freeze не останавливает доказанно независимые branches от
   last-known-good base; default known-bad допускает только good-base-only либо
   stabilization-only режим.
6. Same-path downstream с superseded dependency SHA тоже superseded; выдай
   свежий claim/branch от нового ancestor и повтори только affected gates.
7. Foreign-main quarantine ограничивает affected scope; при unknown/active
   change остановись на bounded receipts по отдельному протоколу.

Для каждого issue coordinator после fenced action перечитывает live scope,
создаёт run/epoch/generation-bound `WORK_CLAIM`, переводит реально начатую
работу в `In Progress`, создаёт отдельный worktree/branch от exact base и выдаёт
изолированные mutable cache/tmp/build/runtime paths и ports.

Переиспользуй только content-addressed cache по toolchain/lockfile. Не разделяй
mutable build output и не переустанавливай dependencies при совпавшем
fingerprint и доказанно готовом install.

## Запустить issue workers

При `coordinator-inline` root выполняет manifest сам в отдельном worktree. Для
delegated lane запускай свежий
`spawn_agent(agent_type="worker", fork_turns="none")`. Не переиспользуй worker
для другой issue и не разрешай ему собственных subagents. Если runtime slots
не дают N child workers, используй root как одну hybrid issue lane прежде чем
уменьшать фактическую issue capacity.

Передай только task-local manifest:

```text
RUN: <run_id>; OWNER: id=<owner_id>; epoch=<n>;
CLAIM: generation=<n>; token=<opaque id>; executor=<agent|coordinator-inline>.
Выполни ровно Linear issue <identifier> (<id>) из project <project_id>,
milestone <release_id>.
Repo: <absolute_repo>. Worktree: <absolute_worktree>. Branch: <branch>.
Feature ref: <ref>; expected old: <zero-or-sha>.
Guard ref/tip: <claim-guard-ref>=<sha>; run key: <128-bit hex>.
Root SHA: <root_sha>. Base SHA/class: <sha>/<current|last-known-good|stabilization>.
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

Проверяй receipt без повторения всей работы: exact run/epoch/claim token,
worktree/branch/HEAD, actual diff внутри ownership paths, origin ref, scope
freshness и заявленные checks. `ready` переводи в
существующий `In Review`, если он есть; иначе оставляй в started-state
`In Progress` с ready receipt. Failed issue оставляй незавершённой. Сразу
освободи slot, refill pool и передай receipt в continuous integration.

## Интегрировать и закрывать cutoffs

Каждый ready receipt сразу обрабатывай по
[batch-release.md](references/batch-release.md): fast-forward integration train
по одной feature после cheap ingest gate. Закрывай immutable cutoff по
size/max-wait/idle/urgent trigger без ожидания in-flight workers. На cutoff
выполняй ровно один global gate, exact default CAS и применимые CI/Sites gates.
Новые refs идут в следующий `OPEN_CUTOFF`; перед seal и каждой irreversible
boundary обновляй foreign-main/remote snapshot.

## Обработать найденные дефекты

Используй [defect-triage.md](references/defect-triage.md). Coordinator
deduplicate-ит `defect_signature` и выбирает минимальный корректный путь:

- acceptance scope исходной issue — вернуть её в `In Progress`, исправить в
  descendant repair ref с новым claim generation, supersede receipt и reseal;
- `tiny-integration-repair` без продуктового выбора — отдельный
  candidate fix commit, affected test, затем reseal;
- новая independent/cross-feature regression — автоматически создать
  связанный Linear Bug с repro, expected/actual, provenance, cutoff/candidate
  SHA, failing gate, previous stable artifact при наличии и acceptance
  criteria; назначить
  `me`, применить существующий label `Bug` и `Regression`, только если такой
  label уже существует;
- blocker, созданный текущим milestone, включить в тот же milestone и
  поставить впереди очереди; неблокирующий defect оставить в backlog и
  продолжить независимую delivery;
- `systemic-or-second-generation`/unattributed — заморозить integration,
  оставить только доказанно независимые good-base branches и запросить
  архитектурное/продуктовое решение при настоящем выборе;
- `known-bad-default`/live — запретить ordinary promotion, выполнить rollback при
  production fail и пропускать только stabilization cutoff до healthy evidence.

При flake один раз повтори exact failing subcommand на неизменённом SHA.
Противоречивый результат без причины — fail/gap, не pass. После code change
запусти affected check и ровно один новый full integrated gate; feature gates
остальных веток не повторяй.

Если виновную feature можно исключить без нарушения dependencies, пересобери
cutoff без неё и выпусти независимые issue. Серьёзный defect одной feature не
должен автоматически блокировать весь milestone. Исключение upstream
автоматически исключает его stacked descendants из текущего cutoff.

## Продвинуть candidate и завершить cutoff

1. Требуй fresh foreign-main disposition без promotion hold, current remote
   default=`expected_default_sha` и ancestry до candidate.
2. После доказанной ancestry обнови default explicit expected-old server-side
   lease на `expected_default_sha`; обычного check-then-push недостаточно.
   Lease служит только CAS и не разрешает history rewrite. Drift/rewrite и
   local ahead/diverged обрабатывай по [external-main.md](references/external-main.md).
3. Дождись required CI для exact candidate SHA после default push, если
   required CI настроен. Успешный pre-push run не отменяет этот gate, но при
   неизменном validation key не повторяй локальный full suite. Отсутствие
   configured CI запиши как `none`, не выдумывай check.
   Missing/stalled/infra CI и недоступную Git publication обрабатывай только по
   [github-outage.md](references/github-outage.md).
4. Для `design` и `build` не создавай deployment или tag. Запиши
   `SITES/DEPLOYMENT: not-applicable(profile=<profile>)` и не называй cutoff
   production release. После доказательства acceptance, integrated gate и
   exact default плюс terminal CI outcome можно перейти к Linear closure;
   terminal outcome может быть success, отсутствие configured CI либо outage
   waiver по отдельному протоколу.
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
9. В annotation запиши milestone, cutoff ID, exact SHA, issue identifiers, Sites
   version/deployment/artifact digest, previous stable и web + MCP smoke.
10. Upsert-ни batch/feature dispositions, CAS-terminalize-ни exact guards и
   только затем переведи issue с полностью доказанным live acceptance в
   completed-state (`Done`, если так он называется). После fresh snapshot очищай
   artifacts по [crash-recovery.md](references/crash-recovery.md).

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

До stabilization поставь `DEFAULT_HEALTH=known-bad`, заморозь ordinary
integration/default/deploy и разрешай независимую issue-работу только от exact
last-known-good base. Не reset/force default branch. Если Git-состояние надо
отменить, сделай явный revert whole cutoff или issue в новом commit и выпусти
его новой версией.

## Делать checkpoint и завершить goal

За один goal-ход держи pool заполненным и доводи active cutoff до terminal checkpoint:
`integrated`, `locally-integrated`, `released`, `rolled-back`, `needs-input` или
доказанного external wait. Без active cutoff checkpoint допустим только с заполненным
pool и точным ближайшим trigger. Не проси запускать следующую волну: conveyor непрерывен.

Checkpoint должен содержать только:

```text
pool active/limit -> open/active cutoff -> health -> profile -> issues ->
candidate/default SHA -> foreign-main/hold -> validation key ->
Sites/live/tag/rollback -> defects/gaps -> remaining counts
```

Перед следующим cutoff получи новый Linear snapshot. Goal заверши только после двух свежих
согласованных snapshots без unfinished issue/active artifacts, с healthy default и полным
ledger. Затем CAS-запиши terminal owner `complete`, сохрани ref и заверши milestone goal.

`update_goal(status="blocked")` используй только после трёх последовательных goal-ходов
с тем же внешним блокером. Независимая работа, terminal waiver и автоматически
исправимая/исключаемая/переоткрываемая проблема блокером не являются.

Если пользователь меняет процесс, сначала обнови и проверь skill через `skill-creator`.
