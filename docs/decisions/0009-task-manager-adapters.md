# ADR-0009: универсальный delivery skill и task-manager adapters

Статус: accepted, amended 2026-08-24.

## Контекст

Delivery flow отвечает за декомпозицию, writer lanes, checkpoints, batches,
dev/UAT evidence, pause, recovery и terminal claims. Эти правила не зависят от
того, в какой task-management system хранятся product scope, acceptance,
dependencies и progress.

Привязка имени skill и базового контракта к одному provider смешивает две
разные ответственности. Она заставляет универсальный coordinator знать remote
entity types, status catalog, relations, pagination, comment format и retry
семантику конкретной системы, а добавление нового provider-а превращает в
изменение всего delivery protocol.

## Решение

- Каноническое имя skill — `ship-work-release`.
- Базовая [delivery specification](../specs/ship-work-release.md) использует
  только нормализованные `work collection`, `work scope`, `work item`,
  dependency graph, status classes и projection operations.
- Project delivery profile выбирает ровно один `task_management.adapter` и
  задаёт provider-specific collection/scope selector.
- Каждый provider реализует единый adapter contract: resolve collection/scope,
  полный bounded snapshot, item normalization, ready frontier, expected-old
  projection и reconcile-before-retry. Нормативный interface задан в
  [общем adapter contract](../specs/ship-work-release-task-manager.md).
- Provider-specific entities, statuses, relations, permissions, pagination,
  update format и API/tool behavior описываются в отдельном tracked adapter
  document и производном lazy-loaded
  `references/task-manager-<provider>.md` внутри skill.
- Provider-specific semantics задаёт отдельная adapter specification и
  производный skill reference. Для текущего Mind Diary это
  [Task Manager mapping](../specs/ship-work-release-task-manager-srez.md);
  прежняя Linear mapping сохранена отдельно как historical.
- `SKILL.md` остаётся thin router: читает adapter ID из profile, загружает общий
  task-management contract и ровно один provider adapter выбранного execution
  path.
- Добавление нового task-management provider-а не меняет lanes, worktrees,
  pause, batches, cohorts, dev/UAT или production boundary.
- Unsupported, missing или ambiguous adapter configuration блокирует run до
  mutation. Core не угадывает provider по repository, URL или человеческому
  названию scope.

## Amendment 2026-08-24

Первоначальная project-specific запись этого ADR выбирала Linear и repo-local
`ship-linear-release` для Mind Diary. Миграция Release 0.1 в Task Manager
supersede-ит именно эту provider/runtime часть, не меняя provider-neutral core:

- current profile выбирает adapter `task-manager`, exact Project
  `525e801d-0ae9-4be7-bae4-6a9c8f85f581` и Release
  `e92b681b-fd18-43e2-91df-3538c37d9890`;
- current runtime boundary — configured direct-package identity
  `task-manager@srez-marketplace` плюс fresh callable catalog, `get_workspace`
  и exact Project/Release reads; отсутствующий connector-visible workspace UUID
  не подменяется Sites project, URL, OAuth principal или package version;
- specification и operational runtime reference являются разными tracked
  documents; второй производен от первого и не создаёт вторую норму;
- из-за отсутствия native Release status-update scope facts используют exact
  designated anchor Task `492adef6-ff53-4244-bf42-c101bb350ade` с
  predecessor/superseding comment chain и reconcile-before-retry;
- repo-local Linear/Shipliner runtime больше не является callable delivery
  authority; Git history и historical mapping сохраняют provenance.

Эта секция имеет приоритет над прежним выбором Linear для Mind Diary и не
утверждает, что Task Manager является единственным adapter других projects.

## Последствия

- Универсальный contract и operator runbook не содержат Linear entity/status
  semantics.
- Mind Diary выбирает adapter `task-manager` только в своём
  [project delivery profile](../operations/ship-work-release-profile.md), а
  старый Linear profile больше не является действующей конфигурацией.
- Task-manager adapter tests отделяются от router, state reducer, release и
  recovery conformance tests.
- Canonical run state хранит stable adapter/collection/scope/item refs, а remote
  comments или statuses остаются projections, не workflow database.
- Cross-provider перенос scope требует explicit mapping и reconciliation;
  одинаковые display names или human-readable item keys не считаются identity.

## Рассмотренные варианты

- **Сохранить provider в имени skill.** Отклонено: имя обещает более узкий
  contract, чем фактический delivery flow, и мешает новым adapters.
- **Оставить Linear branch-и внутри базовой specification.** Отклонено: core
  начинает зависеть от provider taxonomy и API behavior.
- **Создавать отдельный полный skill для каждого task manager.** Отклонено:
  router, safety, pause, release и recovery semantics начали бы расходиться и
  дублироваться.
- **Не использовать task manager.** Не выбрано как default: provider-neutral
  adapter contract допускает другой backend, но durable product scope и
  acceptance всё равно должны иметь declared authority.

Связанные документы:
[operator runbook](../operations/ship-work-release.md),
[project profile contract](../specs/ship-work-release-project-profile.md),
[task-management adapter contract](../specs/ship-work-release-task-manager.md),
[Mind Diary delivery profile](../operations/ship-work-release-profile.md) и
[ADR-0008](0008-dev-uat-production-delivery.md).
