# Coordination flow

Загружай этот файл при старте, resume или изменении worker topology.

## Single mode

`workers=1` означает coordinator-only:

1. Создай task branch от current `main` в primary checkout.
2. Запиши `claim` с lane `coordinator` и worktree = repository root.
3. Реализуй issue, выполни targeted checks, commit и `feature-ready`.
4. Верни checkout на `main`, интегрируй task branch и вызови `integrate`.
5. Обнови Linear и вызови `task-done`.

Ни subagent, ни дополнительный worktree не создаются.

## Parallel mode

`workers=N`, `N > 1` означает ровно N worker-subagents плюс coordinator.
Создай для lane отдельный worktree вне repository root. Пример:

```bash
git worktree add -b 'codex/and-123-r<run>-w1' \
  '../MindDiary-worktrees/<run>/worker-1' main
```

Worker prompt обязан назвать issue, branch/worktree, ownership paths, checks,
нужные документы и запреты. Не передавай worker-у право менять Linear, main,
чужой worktree, journal или UAT.

После интеграции очисти lane: worktree должен быть clean. Для новой issue
создай в нём новую task branch от актуального `main`; не смешивай commits двух
issue в одной feature lineage.

## Scope

Paths нормализуются относительно repository root. Два active scopes
конфликтуют, если один path равен другому или является его parent. При
конфликте оставь issue в ready frontier до освобождения lane.

Worker может сообщить `needs-coordinator`, если минимальный корректный fix
выходит за scope. Coordinator либо расширяет scope после проверки active lanes,
либо выполняет integration fix сам. Worker не расширяет scope молча.

## Integration

Coordinator проверяет clean feature head и выполненные checks. Затем он может:

- merge/fast-forward feature в `main`; либо
- сначала merge актуальный `main` в feature, повторить затронутые checks и
  затем интегрировать.

Только descendant/merged feature SHA принимается `integrate`. После merge
запусти затронутые проверки и только потом помечай Linear issue Done.

## Resume

`status` показывает lanes, tasks, batches и defects. После crash отдельно
проверь:

- существует ли branch/worktree каждой running issue;
- совпадает ли worktree HEAD и чист ли checkout;
- вошёл ли feature SHA уже в `main`;
- был ли batch реально deployed и какой smoke получен;
- не изменились ли Linear acceptance/dependencies.

Исправь journal только через соответствующую semantic command. Не редактируй
JSON вручную и не делай destructive Git cleanup.
