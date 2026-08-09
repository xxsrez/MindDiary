---
name: ship-linear-release
description: "Deliver the exact current Linear milestone in MindDiary: plan dependency-aware work, run either coordinator-only or exactly N isolated worker subagents, integrate feature branches into main, release meaningful batches continuously to UAT, and repair guardrail or UAT defects forward. Use only when the user explicitly invokes $ship-linear-release or asks to execute this repository's Linear milestone delivery workflow. Never release production."
---

# Ship Linear Release

Доставляй current Linear milestone простым coordinator-led flow. Считай
[упрощённую спецификацию](../../../docs/specs/ship-linear-release-v1.md)
обязательной для исполнимого v1; полный `ship-work-release` остаётся target
contract, но не runtime checklist.

## Начать

Сначала выполняй дешёвый read-only fast path. Не загружай relations, product
docs, release reference и Sites tooling, пока не доказано наличие работы.

1. Полностью прочитай `AGENTS.md` и этот файл.
2. Одним project/milestone lookup определи exact Linear project и current
   milestone. Не выбирай milestone по догадке.
3. Одним полностью paginated `list_issues(limit=250)` прочитай issue project-а.
   Сохрани exact JSON tool result во временный файл вне repository и нормализуй
   только inventory:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/linear_inventory.py \
     --input '<raw-linear-list.json>' --output '<inventory.json>' \
     --project-id '<linear-project-id>' --milestone-id '<linear-milestone-id>'
   ```

   Если ответ имеет следующую страницу, сначала дочитай все страницы; helper
   отклоняет неполную выборку.
4. Одной командой проверь invocation, Git и наличие работы:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/shipctl.py preflight \
     --repo "$PWD" --project-id '<linear-project-id>' \
     --milestone-id '<linear-milestone-id>' \
     --invocation '<полный invocation пользователя>' \
     --input '<inventory.json>'
   ```

5. Если `disposition=no-work`, немедленно остановись. Не вызывай `init`, не
   читай relations/acceptance исторических Done, не создавай workers/worktrees,
   не запускай gate/dev/CI и не создавай batch/UAT/defect/product changes.
   Если preflight вернул пустой `active_run_id`, просто отчитай exact Linear и
   Git state. Если он вернул существующий no-op run, закрой его обычным
   `complete` и отчитай `disposition=no-work`; UAT для этого не требуется.
6. Только для `start` или `resume` полностью прочитай
   [упрощённую спецификацию](../../../docs/specs/ship-linear-release-v1.md),
   проверь Git dirt/worktrees из preflight и запроси relations/acceptance только
   для `unfinished_issue_ids` и их boundary dependencies.
7. Для `workers=N`, `N > 1`, до Git/Linear/UAT writes проверь, что runtime имеет
   N свободных subagent slots. Не заменяй malformed или недоступный `N` на 1.
8. Создай либо найди run journal:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/shipctl.py init \
     --repo "$PWD" --project-id '<linear-project-uuid>' \
     --milestone-id '<linear-milestone-uuid>' --workers <N>
   ```

   Повторный exact `init` возвращает существующий active run. Другой active run
   того же repository/milestone запрещён.

## Выбрать topology

- `workers=1` или workers отсутствует: не создавай subagent/worktree.
  Coordinator сам выполняет по одной issue в primary checkout.
- `workers=N`, `N > 1`: запусти ровно N worker-субагентов и сохрани coordinator
  отдельным. Не считай coordinator одним из N. Создавай workers с
  `fork_turns=none`, не разрешай им порождать вложенных subagents и переиспользуй
  каждого worker-а в его lane для следующих issue.
- Не уменьшай requested N молча. Если runtime capacity недостаточна, остановись
  до dispatch и сообщи доступное число.

В parallel mode каждому worker назначь постоянный lane и отдельный worktree.
Одновременно worker владеет только одной issue и одним непересекающимся scope.
Подробный Git/dispatch flow читай в
[references/coordination.md](references/coordination.md) только при начале
работы или resume.

## Спланировать milestone

Не угадывай JSON schema и не читай для этого исходник helper-а. Получи exact
template:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py snapshot-template \
  --kind plan
```

Сохрани bounded snapshot только незавершённых issue в JSON; IDs исторических
terminal blockers положи в `completed_dependency_ids`. Затем передай snapshot
journal helper-у:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py plan \
  --repo "$PWD" --run '<run-id>' --input '<snapshot.json>'
```

Snapshot содержит `issues[]` с `id`, `identifier`, `title`, `state`, `priority`,
`dependencies`. Исторические Done не являются tasks текущего run и никогда не
попадают из-за одного нового invocation в release batch. Dispatch только
`ready` issue; обновляй snapshot после Linear drift, reopen или появления
defect.

Перед каждой issue запиши claim:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py claim \
  --repo "$PWD" --run '<run-id>' --issue '<issue-id>' --lane '<lane-id>' \
  --branch '<feature-branch>' --worktree '<absolute-path>' \
  --path '<owned-path>' [--path '<owned-path>']
```

Для single mode lane равен `coordinator`, `--worktree` указывает primary
checkout. Helper отклоняет dependency и active-scope conflicts.

## Выполнить issue

Передай worker только:

- exact Linear issue и acceptance;
- dependencies и base SHA;
- ownership paths;
- нужные документы по `AGENTS.md`;
- targeted checks;
- branch/worktree и запрет Linear/main/UAT writes.

Worker коммитит feature и возвращает SHA, checks и gaps. Coordinator проверяет
его через `feature-ready`, затем интегрирует branch в `main` сам:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py feature-ready \
  --repo "$PWD" --run '<run-id>' --issue '<issue-id>' \
  --head '<full-sha>' --check '<name>=passed'

python3 .agents/skills/ship-linear-release/scripts/shipctl.py integrate \
  --repo "$PWD" --run '<run-id>' --issue '<issue-id>' \
  --main-sha '<full-main-sha>'
```

После verified integration обнови Linear и вызови `task-done`. При конфликте
coordinator вправе сначала влить актуальный `main` в feature branch либо
разрешить конфликт прямо в integration checkout.

## Выпускать UAT batches

UAT включён по умолчанию. Не связывай batch size с worker count и не жди
искусственной wave. Закрывай batch по осмысленному product boundary. Перед
первым cut прочитай
[references/batch-release.md](references/batch-release.md).

Не создавай batch, если в текущем run нет ни реально интегрированной feature,
ни resolved forward-fix зарегистрированного prerelease/UAT defect. Пустой
frontier, исторические Done и изменение release tooling сами по себе не являются
release candidate. Не запускай gate/dev/CI до этой проверки.

После canonical repository gate создай batch exact current `main`:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py batch-create \
  --repo "$PWD" --run '<run-id>' --candidate '<full-sha>' \
  --gate passed
```

После deployment и smoke запиши факт через `batch-uat`. Failed smoke не делает
rollback. Сначала прочитай
[references/defect-triage.md](references/defect-triage.md), зарегистрируй
дефект и выпусти forward fix новым batch. С момента failed smoke helper уже
блокирует ordinary claims — окно до triage не разрешает продолжать обычную
работу.

Никогда не выполняй production release. Команда `production` существует
только как исполнимая проверка отказа.

## Resume и завершение

Для resume сначала вызови `status`, затем сверь journal с Git, Linear и UAT.
Journal помогает найти checkpoint, но не доказывает внешний effect. При
необъяснимом drift останови затронутый lane; независимые lanes можно продолжать.

Перед `complete` проверь:

- Linear milestone не содержит незавершённых in-scope issue/defects;
- все lanes свободны;
- для run с реальными интегрированными изменениями `main` clean, прошёл final
  repository gate и выпущен meaningful UAT batch с passing smoke;
- для no-work run достаточно exact clean `main`; gate и UAT не запускаются;
- Linear отражает verified state.

Затем:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py complete \
  --repo "$PWD" --run '<run-id>' --main-sha '<full-main-sha>'
```

Отчитывай отдельно exact Git SHA, Linear state, repository gate и UAT evidence.
Не называй один вид evidence доказательством другого.
