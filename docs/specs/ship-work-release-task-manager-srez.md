# Task Manager adapter для `ship-work-release` в Mind Diary

Статус: accepted project mapping, revision 1, 2026-08-23.

Этот документ фиксирует текущую привязку Mind Diary к установленному
Task Manager adapter. Общий provider-neutral boundary задаёт
[`task-management adapter contract`](ship-work-release-task-manager.md), а
orchestration semantics — [`ship-work-release`](ship-work-release.md).

## Adapter identity

```yaml
adapter: task-manager
contract: ship-work-release/task-manager-adapter/v1
runtime_reference: task-manager@srez-marketplace
```

`task-manager@srez-marketplace` — identity установленного adapter package, а не
идентификатор пользователя или workspace. Текущий `get_workspace` возвращает
capabilities и counts, но не публикует отдельный immutable workspace UUID;
поэтому adapter instance не подменяется выдуманным provider или пользовательским
ID.

## Canonical collection и default scope

Живое чтение Task Manager 2026-08-23 разрешило ровно один активный Project и
один активный Release:

```yaml
collection:
  provider: task-manager
  kind: project
  id: 525e801d-0ae9-4be7-bae4-6a9c8f85f581
  display_name: Mind Diary
default_scope:
  selector: configured_release
  release:
    provider: task-manager
    kind: release
    id: e92b681b-fd18-43e2-91df-3538c37d9890
    name: "0.1"
```

Project и Release refs обязательны для exact reread перед каждым delivery run.
Имена `Mind Diary` и `0.1` являются display metadata; identity — только
canonical refs. Поиск, старый receipt или старый provider ID не являются
fallback.

## Supported surface и границы

- `get_workspace`, `list_projects`, `get_project`, `list_releases`,
  `list_tasks`, `get_task` и native task comments используются для bounded
  snapshot, status, acceptance, dependencies и evidence read-back.
- Pagination остаётся bounded на каждом connection; неполный snapshot или
  ambiguous Project/Release блокирует run.
- Task Manager поддерживает task-level status/comment mutation с optimistic
  `version` и exact reread после записи.
- Текущий connector не предоставляет project-level status-update capability.
  Поэтому scope fact projection имеет режим `unavailable`: нельзя имитировать
  project update, подменять его комментариями на произвольной задаче или
  объявлять terminal projection без task-level evidence.
- Delivery semantics, Goal policy, writer lanes, release boundary и deploy
  authority остаются в `ship-work-release`; adapter не выбирает их сам.

## Historical Linear mapping

[`ship-work-release-linear.md`](ship-work-release-linear.md) сохранён для
исторической трассировки старого rollout и не является действующим adapter,
profile, scope selector или source of truth для Mind Diary. Его старый Project
ID `6c07eabb-e588-4184-8eaa-5974ad67fdda` не должен использоваться.
