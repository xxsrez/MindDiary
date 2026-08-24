# План восстановления MVP 0.1

Статус документа: `proposal`.

Дата среза: 2026-08-24.

Этот пакет фиксирует не новый набор обещаний, а способ вернуть Release `0.1`
к одному проверяемому пользовательскому результату: новый пользователь ставит
Mind Diary из Marketplace, проходит OAuth, явно выбирает доступные для чтения
Minds и не более одного writable Mind, после чего получает первый полезный
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

1. [Текущее состояние](current-state.md) — фактический срез продукта,
   репозитория, UAT и 29 незавершённых Tasks.
2. [Целевое состояние MVP](target-state.md) — один пользовательский outcome,
   предлагаемая информационная архитектура и обязательные acceptance signals.
3. [План перехода](transition-plan.md) — поэтапная последовательность работ,
   gates, rollback и terminal conditions.
4. [План Task Manager](task-manager-plan.md) — triage действующего release
   graph и целевая структура новых Tasks.
5. [Критический архитектурный прогон](critical-review.md) — baseline drift,
   normative scope conflict, write-step-up state machine, browser acceptance,
   pagination/security и скрытые зависимости final gate.

## Главный вывод

Release `0.1` нельзя продолжать закрывать как сумму всех когда-либо добавленных
технических инициатив. Сначала нужно принять его продуктовую границу, затем
закрыть короткий P0 graph и провести один end-to-end first-user acceptance.
Brain-scale import, provider-specific ingress и универсальные источники файлов
должны перестать определять готовность Codex-first MVP, если отдельным решением
не будет принято обратное.

## Источники истины и ограничения среза

- Project: `Mind Diary` (`525e801d-0ae9-4be7-bae4-6a9c8f85f581`).
- Release: `0.1` (`e92b681b-fd18-43e2-91df-3538c37d9890`).
- Task Manager прочитан полностью, включая 204 Tasks и полные карточки всех 29
  незавершённых Tasks.
- Deployed UAT согласно последнему сохранённому release evidence связан с
  `eca3400` / Sites deployment 50. Более свежий engineering candidate —
  `1df46ec`; hosted acceptance для него ещё не является доказанным фактом.
- Повторная загрузка UAT через in-app Browser 2026-08-24 завершилась timeout
  навигации. Поэтому текущие UI-числа ниже помечены как сделанный ранее в тот же
  день snapshot, а не как новый smoke на момент написания документа.
- Локальный `main` грязный и отстаёт от integration candidate. Этот пакет не
  меняет продуктовый код и не вмешивается в параллельную release-реализацию.
