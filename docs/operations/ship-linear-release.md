# Runbook: `ship-linear-release`

Статус: operational companion к
[спецификации доставки Linear milestone](../specs/linear-milestone-delivery.md).

Topology и recovery правила
[ADR-0007](../decisions/0007-linear-delivery-concurrency.md) реализованы в
tracked skill/helpers/tests. Перед операционным использованием всё равно
проверяется exact tracked contract и passing gate текущего commit.

## Когда использовать

Запускайте skill явно, когда нужно не спланировать, а реализовать и доставить
весь текущий milestone:

```text
$ship-linear-release
$ship-linear-release workers=4
$ship-linear-release workers=auto max=6
$ship-linear-release dry-run
```

Без параметра используется один worker. Exact число выбирайте, когда важна
предсказуемая параллельность и runtime располагает нужными slot-ами. `auto`
подходит, когда skill должен сам занять безопасно доступную capacity.

Skill не имеет build/release profile. Не нужно заранее сообщать ему, «релизная»
ли задача: это определяется Linear acceptance и repository contract.

## Что произойдёт при запуске

1. Read-only preflight проверит remote/default, tracked skill contract, текущий
   Goal, dirty checkout и существующий repo-global run.
2. Invocation будет нормализован в `workers=1`, exact N или `auto`.
3. Один compact Linear snapshot вместе с измеренной capacity будет передан в
   `startup-plan`: helper повторно проверит preflight, типы snapshot, graph,
   ready frontier и authoritative occupancy действующего run. На resume без
   нового count он берёт сохранённый request из `WORKERS`, а не default `1`.
4. Fresh run попытается CAS-ом получить единственный coordinator claim.
5. После победы будет создан один Goal. При одном worker root создаст feature
   branch в primary checkout; при нескольких — task-owned worktrees.
6. Workers начнут ready issues; coordinator будет один последовательно
   merge-ить готовые features в local `main`. `running >
   sustained_issue_capacity`, orphan live claim или execution без claim
   блокируют dispatch как incoherent state.
7. Coordinator накопит осмысленный batch, выполнит один full gate на exact
   `main` SHA и expected-old продвинет remote `main`.
8. Если acceptance/repository contract требует production, coordinator
   выполнит deployment и live gates. В противном случае он завершит milestone
   без выдуманного deploy.
9. Linear issues станут `Done` только после соответствующего evidence.

При `workers=1` эти роли исполняет root последовательно без отдельного
worktree. При `workers>1` root не считается одним из issue workers, остаётся
responsive coordinator и является единственным writer `main`.

## До запуска

Repository должен быть clean во всех checkout, которые видит Git. Любой staged,
unstaged, untracked, renamed/deleted либо conflicted path из `git status`
блокирует fresh normal start. Полностью связанный с durable claim прежнего run
dirty task worktree обрабатывается только через recovery/adoption после
fencing; это не разрешает новый normal dispatch. Skill не выполняет
stash/reset/clean и не присваивает остальные изменения себе. Нужно явно
выбрать: завершить и закоммитить их, перенести в отдельную task branch либо
отменить запуск, после чего повторить preflight.

Для exact N должны быть доступны N устойчивых issue slots, N изолированных
наборов mutable resources и при N>1 ещё один slot coordinator-а. При N=1 root
совмещает обе роли. При N>1 не нужно заранее устанавливать зависимости во все
worktrees: coordinator готовит bounded task-owned environment по tracked
lockfile через `provision-worktree`. Все ownership paths передаются повторяемым
`--path`; helper сам выбирает корневой и затронутые tracked nested
`package-lock.json`, например:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py \
  provision-worktree --repo . --worktree "$WORKTREE" \
  --path packages/domain --path apps/product-site --install
```

Feature worker не выполняет самовольный
`npm ci`, не получает symlink на mutable dependency tree другого worktree и не
запускает общий build.

После claim coordinator сверяет status/HEAD/refs с реестром собственных и
worker actions. Любое новое неучтённое отличие — critical stop. Не продолжайте
merge или release до человеческого отчёта и явного устранения вмешательства.
На каждой shared boundary это выполняет `shipctl.py repo-guard --input
<registered-actions.json>`.

## Одновременный запуск из другой сессии

Если active claim содержит running workers, live claims, pending external
effect либо неоднозначный state, ожидаемый результат — `already-running` с
read-only status. Чтобы увеличить параллельность такого run, меняется его worker
pool, а не запускается второй writer.

Если claim `handoff-ready` либо даже `active`, но полный durable vector
когерентно доказывает zero running, no live claims, no pending action, no
nonterminal/ambiguous gate/batch/deploy и stable repository snapshot, новый
явный запуск сам делает expected-old takeover с `epoch+1` и fence-ит guards.
Terminal reconciled batch record этому не мешает. Доказывать, что старая Codex
task физически перестала исполняться, не требуется. При непустом либо
неоднозначном state нужны terminal evidence или явное подтверждение
пользователя, затем fencing и reconciliation.

Quiescent reclaim исполняется строго bounded chain, без Linear warm-up между
шагами:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py takeover --repo .
python3 .agents/skills/ship-linear-release/scripts/shipctl.py fence-guards --repo .
python3 .agents/skills/ship-linear-release/scripts/shipctl.py resume-recovery --repo .
```

При contract upgrade между fencing и resume вызывается `sync-contract`.
`resume-recovery` повторно требует clean repo-wide snapshot, zero claims/guards/
pending actions и terminal либо отсутствующий pipeline.

Для другого repository действует отдельный claim, поэтому обе сессии могут
работать одновременно.

## Как читать status

Перед мутациями skill сообщает одну компактную строку со следующими фактами:

```text
mode=linear-milestone-delivery; unfinished=12; ready=4;
workers=4/4; runtime-slots=5; owner=new; route=normal;
checkout=clean; external-gates=pending
```

- `workers=requested/sustained` показывает запрос и реальную устойчивую
  capacity, не мгновенное число ready issues;
- `owner=other` и `already-running` означают, что durable state пока не даёт
  безопасного reclaim;
- любой `checkout=dirty` блокирует normal start; skill не stash-ит и не
  присваивает эти изменения;
- `external-gates` описывает фактические milestone obligations, не profile;
- `no-actionable-frontier` означает structural problem graph, а не отсутствие
  уже реализованного production.

После этого полезны только milestone-level события: issue dispatched/ready,
batch closed/passed/promoted, production gate, pause/recovery или настоящий
blocker. Внутренний streaming telemetry не должен засорять ответ.
Текущий state можно перепроверить `shipctl.py status`. Фактическую загрузку
пула без открытия UI subagents показывает `shipctl.py pool-status`: отдельно
выводятся `running/sustained`, текущий `active_target`, `feature_ready`,
свободные slots и durable refill blocker. Поэтому `running < 6` само по себе не
дефект: нормальные причины — меньший ready frontier, ownership conflict,
dependency wait или уже готовые features в integration queue.

Terminal cleanup сначала строится `cleanup-plan`, затем применяется только при
неизменном digest. Helper требует coherent terminal coordinator, zero
occupancy, отсутствие live claims и удаляет только существующие clean merged
claim-bound task worktrees.

## Как отражается работа в Linear

Linear не является источником истины для claim, integration или release, но
каждый существенный durable transition проецируется в issue понятным
комментарием: текущий статус, что изменилось, какие проверки есть и что будет
дальше. Если transition меняет состояние issue, status update выполняется с
expected-before CAS.

1. Соберите bounded JSON vector и передайте его в `projection-plan`.
2. До Linear API сохраните весь exact vector:
   `projection-batch-cas --phase intent --expected-coordinator-sha <sha>`.
3. Выполните только выданные `create-comment`, `update-comment` и
   `update-status` операции с их `request_key`.
4. Сохраните item-wise outcomes через `projection-batch-cas --phase reconcile`
   от exact intent SHA.

Marker и idempotency key включают `run_id` и generation. После crash helper
позволяет проверить каждый item и продолжить reconcile, не повторяя вслепую
весь batch. Слишком большой comment и secret-like текст отклоняются до provider
call.

После валидированного ready receipt worker slot освобождается до интеграции.
Границу refill проверяет `shipctl.py refill-check`: до 60 секунд состояние
`pending`, после неё coordinator обязан либо доказать spawn, либо записать
конкретные blocker, evidence и resume predicate. Fractional seconds не
усекаются, а поздний spawn не стирает уже случившийся miss.

## Batch validation и production lock

После каждой feature выполняются только affected checks. Coordinator собирает
несколько merge в осмысленный batch и запускает full gate один раз на exact
`main` SHA. Fixed batch size нет; в стабильном потоке мелких задач не следует
релизить каждую отдельно. Перед завершением skill финальный batch обязателен
даже для одного patch. Typed решение валидирует `shipctl.py batch-boundary
--input <boundary.json>`; helper запрещает keep-open для urgent/idle/final state.

Перед Sites publish coordinator проверяет текущую tool/provider surface. Если
она предоставляет atomic lock/CAS для exact Site и environment, lock
захватывается до publish и conditional-освобождается после terminal deployment.
Если нет — release продолжается, а receipt явно содержит
`release_lock=unsupported/skipped`; marker или обычный файл lock не заменяют.
Fact-vector проверяется `shipctl.py release-lock-plan --input <lock.json>`.

Оставшийся после failure настоящий lock автоматически не удаляется. Сначала
проверяются deployment status и owner, затем пользователю сообщаются этап,
последний доказанный effect и риск overlap. `force-unlock` выполняется только
после явного подтверждения пользователя и по возможности одновременно fence-ит
старого publisher новым epoch.

## Если тест или интеграция упали

Skill сначала локализует источник:

- проблема исходной issue возвращается тому же worker через новую generation;
- независимый сложный дефект становится дедуплицированной связанной Linear Bug;
- маленькая integration-only правка получает отдельную feature branch; в
  single-worker режиме она выполняется в primary checkout, в multi-worker — в
  отдельном worktree, после чего попадает в новый batch и проходит full gate;
- systemic failure замораживает promotion и создаёт stabilization path, но
  независимые безопасные workers могут продолжить работу.

Ни один из вариантов не разрешает считать merge в `main` готовым к release без
batch gate. Повтор terminal failure с тем же validation key запрещён: нужен
source fix либо доказанное изменение environment/contract и новая batch
generation.

## Если production gate невозможен

Сначала отделите implementation gap от external blocker.

Implementation gap — отсутствуют service path, Sites config, auth flow,
persistence, MCP endpoint, tests или release automation, хотя принятый milestone
их требует. Skill обязан создать/переоткрыть work и реализовать их; запрос к
пользователю не нужен.

External blocker — deployable product уже собран и проверен, но конкретная
операция требует недоступного account permission, secret, platform capability
или нового продуктового решения. Тогда skill завершает весь независимый scope,
сохраняет recoverable state и объясняет:

1. какой exact gate не выполнен;
2. почему локальная замена не доказывает acceptance;
3. какие prerequisites уже прошли;
4. какое минимальное действие разблокирует продолжение.

Термины вроде «product token» или «pinned inspector» не должны появляться без
этого объяснения и ссылки на acceptance, которая действительно их требует.

## Pause и продолжение

Запрос pause запрещает новые dispatch и запускает soft drain. Дождитесь
terminal `paused`/`handoff-ready`; простое закрытие сессии может оставить
неоднозначные guards. Повторный явный запуск сначала делает recovery, а не
создаёт новый параллельный run.

При crash не удаляйте worktrees/branches вручную. Durable refs и receipts нужны,
чтобы новый owner различил committed work, незавершённую внешнюю операцию и
мусор. После reconciliation skill сам retire-ит только доказанно terminal
artifacts.

## Как сообщать critical error

При внешнем Git-вмешательстве, неоднозначном recovery или другой критической
ошибке coordinator сначала прекращает новые мутации, а затем самостоятельно
сводит evidence. Пользовательский итог должен объяснить:

1. что произошло и почему продолжать небезопасно;
2. на каком этапе остановился run;
3. что уже успело измениться;
4. состояние `main`, feature branches/worktrees, Linear и release target;
5. минимальное действие для продолжения.

Raw JSON helper-а, stack trace или ответ worker/subagent можно приложить после
этого overview, но нельзя использовать вместо него. Bounded поля сводит
`shipctl.py critical-overview --input <critical.json>`.

## Ожидаемый финальный результат

Перед promotion exact batch candidate проходит канонический repository gate:
`npm ci`, один `npm run check` и
`git diff --check <previous-released>..<candidate>`.
`npm run check` включает Python orchestration suites `shipctl`, `gatectl` и
foreign-main inspector; повторять его составные команды перед aggregate gate
не нужно.

Нормальный успех — все задачи current milestone реализованы и `Done`, `main`
указывает на exact проверенный batch, общие CI/gates terminal, Goal завершён, а
активных claims/batches/deploy actions не осталось. Если milestone требовал
production, дополнительно существует подтверждённый exact deployment и live
smoke; если не требовал — receipt явно говорит об этом без профилей и waiver.

Если результат blocked, это должен быть короткий человеческий отчёт с
минимальным необходимым действием, а не список внутренних token, guard или
receipt идентификаторов.
`update_goal(complete)` выполняется последним: после terminal owner/guards,
compact status и cleanup доказанно terminal clean worktrees.
