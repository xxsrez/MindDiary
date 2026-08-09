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

1. Полностью прочитай `AGENTS.md` и упрощённую спецификацию.
2. Проверь Git root, current `main`, clean status и зарегистрированные worktrees.
   Не исправляй чужой dirt через reset, clean или stash.
3. Прочитай exact Linear project/current milestone, issue dependencies и
   acceptance. Не выбирай milestone по догадке.
4. Нормализуй invocation:

   ```bash
   python3 .agents/skills/ship-linear-release/scripts/shipctl.py invocation \
     '<полный invocation пользователя>'
   ```

5. Создай либо найди run journal:

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
  отдельным. Не считай coordinator одним из N.
- Не уменьшай requested N молча. Если runtime capacity недостаточна, остановись
  до dispatch и сообщи доступное число.

В parallel mode каждому worker назначь постоянный lane и отдельный worktree.
Одновременно worker владеет только одной issue и одним непересекающимся scope.
Подробный Git/dispatch flow читай в
[references/coordination.md](references/coordination.md) только при начале
работы или resume.

## Спланировать milestone

Сохрани bounded Linear snapshot в JSON и передай его journal helper-у:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py plan \
  --repo "$PWD" --run '<run-id>' --input '<snapshot.json>'
```

Snapshot содержит `issues[]` с `id`, `identifier`, `title`, `state`,
`priority`, `dependencies`. Dispatch только `ready` issue; обновляй snapshot
после Linear drift, reopen или появления defect.

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

После canonical repository gate создай batch exact current `main`:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py batch-create \
  --repo "$PWD" --run '<run-id>' --candidate '<full-sha>' \
  --gate passed
```

После deployment и smoke запиши факт через `batch-uat`. Failed smoke не делает
rollback. Сначала прочитай
[references/defect-triage.md](references/defect-triage.md), зарегистрируй
дефект и выпусти forward fix новым batch.

Никогда не выполняй production release. Команда `production` существует
только как исполнимая проверка отказа.

## Resume и завершение

Для resume сначала вызови `status`, затем сверь journal с Git, Linear и UAT.
Journal помогает найти checkpoint, но не доказывает внешний effect. При
необъяснимом drift останови затронутый lane; независимые lanes можно продолжать.

Перед `complete` проверь:

- Linear milestone не содержит незавершённых in-scope issue/defects;
- все lanes свободны;
- `main` clean и прошёл final repository gate;
- current `main` выпущен meaningful UAT batch и smoke прошёл;
- Linear отражает verified state.

Затем:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py complete \
  --repo "$PWD" --run '<run-id>' --main-sha '<full-main-sha>'
```

Отчитывай отдельно exact Git SHA, Linear state, repository gate и UAT evidence.
Не называй один вид evidence доказательством другого.
