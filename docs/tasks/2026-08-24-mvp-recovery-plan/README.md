# План восстановления MVP 0.1

Статус документа: `proposal`.

Дата среза: 2026-08-24.

Этот пакет фиксирует не новый набор обещаний, а способ вернуть Release `0.1`
к одному проверяемому пользовательскому результату: новый пользователь ставит
Mind Diary из Marketplace, проходит read-only OAuth, выбирает readable Minds,
получает первый read result и при первой записи проходит native step-up для
одного writable Mind. После этого он получает полезный
read/write/history/export результат через Codex.

Пакет нужен потому, что текущий release-контур одновременно содержит:

- незавершённый пользовательский onboarding и перегруженный `MCP setup`;
- terminal UAT evidence для уже реализованного кода;
- operator, performance и release-infrastructure gates;
- BundleFile, Brain-scale import и universal file ingress expansion.

Эти surfaces имеют разную ценность, разные критерии готовности и разные
release boundaries. Пока они представлены одним плоским списком blockers,
локальный прогресс не превращается в понятное решение о готовности MVP.

## Документы пакета

1. [Визуальная карта системы и перехода](system-transition-presentation.html) —
   большая интерактивная презентация текущей архитектуры, перегруженного
   `MCP setup`, целевой information architecture, blocker graph, фаз перехода,
   рисков и критериев `Done` простым языком.
2. [Текущее состояние](current-state.md) — фактический срез продукта,
   репозитория, UAT и 40 незавершённых Tasks.
3. [Целевое состояние MVP](target-state.md) — один пользовательский outcome,
   предлагаемая информационная архитектура и обязательные acceptance signals.
4. [План перехода](transition-plan.md) — поэтапная последовательность работ,
   gates, rollback и terminal conditions.
5. [План Task Manager](task-manager-plan.md) — triage действующего release
   graph и целевая структура новых Tasks.
6. [Критический архитектурный прогон](critical-review.md) — baseline drift,
   normative scope conflict, write-step-up state machine, browser acceptance,
   pagination/security и скрытые зависимости final gate.
7. [Реестр блокеров](blocker-register.md) — единственная текущая проекция P0
   gates, non-blocking scope, external boundaries и resume signals.

## Главный вывод

Release `0.1` возвращается к small-data Codex-first Markdown MVP. BundleFile,
Brain-scale import, provider-specific ingress и универсальные источники файлов
сохраняются как следующий milestone, но не определяют готовность 0.1. Текущий
исполняемый порядок: MD-292 normative boundary → MD-301 integration baseline и
MD-294 contract → implementation/browser gates → MD-299 connection UAT →
MD-293 final first-user receipt.

## Источники истины и ограничения среза

- Project: `Mind Diary` (`525e801d-0ae9-4be7-bae4-6a9c8f85f581`).
- Release: `0.1` (`e92b681b-fd18-43e2-91df-3538c37d9890`).
- Task Manager перечитан после второго критического прогона: Project содержит
  215 Tasks, Release 0.1 — 159 Tasks; незавершённый release scope — 40 Tasks.
  MD-301 исправлена из Backlog в Todo. Эти числа — датированный snapshot;
  delivery всегда начинает работу с fresh read-back.
- Deployed UAT согласно последнему сохранённому release evidence связан с
  `eca3400` / Sites deployment 50. Более свежий engineering candidate —
  `1df46ec`; hosted acceptance для него ещё не является доказанным фактом.
- Повторная загрузка UAT через in-app Browser 2026-08-24 завершилась timeout
  навигации. Поэтому текущие UI-числа ниже помечены как сделанный ранее в тот же
  день snapshot, а не как новый smoke на момент написания документа.
- `main` и integration candidate `1df46ec` остаются разными линиями. Число
  planning commits слева изменяется при обновлении этого пакета, поэтому
  MD-301 обязана начинаться с fresh
  `git rev-list --left-right --count main...1df46ec`, а затем выполнить
  conflict-aware объединение до начала UI implementation. На входе второго
  review справа оставался тот же набор из 21 engineering commit.
