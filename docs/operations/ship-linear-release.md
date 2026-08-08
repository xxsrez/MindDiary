# Runbook: `ship-linear-release`

Статус: operational companion к
[спецификации доставки Linear milestone](../specs/linear-milestone-delivery.md).

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
3. Один compact Linear snapshot проверит milestone graph и ready frontier.
4. Fresh run попытается CAS-ом получить единственный coordinator claim.
5. После победы будет создан один Goal и task-owned worktrees.
6. Workers начнут ready issues; готовые features будут сразу поступать в
   rolling integration train.
7. Coordinator закроет небольшие immutable cutoffs, выполнит full gate и
   продвинет exact SHA в main.
8. Если acceptance требует production, coordinator выполнит deployment и live
   gates. В противном случае он завершит milestone без выдуманного deploy.
9. Linear issues станут `Done` только после соответствующего evidence.

При `workers=1` эти роли исполняет root последовательно. При `workers>1` root
не считается одним из issue workers и остаётся responsive coordinator.

## До запуска

Предпочтителен clean checkout, но несвязанные незакоммиченные изменения не
требуют stash/reset. Skill должен оставить их на месте и работать через clean
worktrees. Он остановится, если dirty changes затрагивают сам skill,
`AGENTS.md`, package/lock/toolchain, CI/deployment config, migrations или другую
surface, определяющую выполнение. Тогда нужно явно выбрать: включить эти
изменения в новый contract commit, завершить их отдельно или отменить запуск.

Для exact N должны быть доступны N устойчивых issue slots, N изолированных
наборов mutable resources и при N>1 ещё один slot coordinator-а. При N=1 root
совмещает обе роли. Не нужно заранее устанавливать зависимости во все
worktrees: coordinator готовит bounded task-owned environment по tracked
lockfile. Feature worker не выполняет самовольный `npm ci` или общий build.

## Одновременный запуск из другой сессии

Ожидаемый результат для того же repository — `already-running` с read-only
status. Это не ошибка и не зависание: один coordinator уже владеет Linear,
main, cutoffs и deploy. Чтобы увеличить параллельность активного run, меняется
его worker pool, а не запускается второй writer.

Если прежняя сессия корректно оставила `handoff-ready`, новый явный запуск может
автоматически выполнить fenced takeover. Если owner жив или state неоднозначен,
takeover запрещён. Для другого repository действует отдельный claim, поэтому
обе сессии могут работать одновременно.

## Как читать status

Перед мутациями skill сообщает одну компактную строку со следующими фактами:

```text
mode=linear-milestone-delivery; unfinished=12; ready=4;
workers=4/4; runtime-slots=5; owner=new; route=normal;
checkout=clean; external-gates=pending
```

- `workers=requested/sustained` показывает запрос и реальную устойчивую
  capacity, не мгновенное число ready issues;
- `owner=other` и `already-running` означают безопасный отказ второй сессии;
- `checkout=isolated-dirty` означает, что изменения пользователя не трогаются;
- `external-gates` описывает фактические milestone obligations, не profile;
- `no-actionable-frontier` означает structural problem graph, а не отсутствие
  уже реализованного production.

После этого полезны только milestone-level события: issue dispatched/ready,
cutoff sealed/passed/promoted, production gate, pause/recovery или настоящий
blocker. Внутренний streaming telemetry не должен засорять ответ.

## Если тест или интеграция упали

Skill сначала локализует источник:

- проблема исходной issue возвращается тому же worker через новую generation;
- независимый сложный дефект становится дедуплицированной связанной Linear Bug;
- маленькая integration-only правка выполняется coordinator-ом до seal нового
  cutoff и проходит тот же full gate;
- systemic failure замораживает promotion и создаёт stabilization path, но
  независимые безопасные workers могут продолжить работу.

Ни один из вариантов не разрешает непроверенный commit непосредственно в main.
Повтор terminal failure с тем же validation key запрещён: нужен source fix либо
доказанное изменение environment/contract и новая cutoff generation.

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

## Ожидаемый финальный результат

Нормальный успех — все задачи current milestone реализованы и `Done`, main
указывает на exact проверенный cutoff, общие CI/gates terminal, Goal завершён,
а активных claims/cutoffs/deploy actions не осталось. Если milestone требовал
production, дополнительно существует подтверждённый exact deployment и live
smoke; если не требовал — receipt явно говорит об этом без профилей и waiver.

Если результат blocked, это должен быть короткий человеческий отчёт с
минимальным необходимым действием, а не список внутренних token, guard или
receipt идентификаторов.
