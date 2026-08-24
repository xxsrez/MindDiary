# Task Manager adapter для `ship-work-release` в Mind Diary

Статус: accepted project mapping, revision 2, 2026-08-24.

Этот документ фиксирует текущую привязку Mind Diary к установленному
Task Manager adapter. Общий provider-neutral boundary задаёт
[`task-management adapter contract`](ship-work-release-task-manager.md),
orchestration semantics — [`ship-work-release`](ship-work-release.md), а exact
порядок connector calls — отдельный
[`operational runtime reference`](../operations/ship-work-release-task-manager-srez.md).

## Adapter identity

```yaml
adapter: task-manager
contract: ship-work-release/task-manager-adapter/v1
provider_instance_id: task-manager@srez-marketplace
runtime_reference: docs/operations/ship-work-release-task-manager-srez.md
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

## Bounded snapshot и lifecycle

- `get_workspace`, exact Project/Release/Task reads и native comments образуют
  authoritative snapshot; compact inventory не заменяет `get_task` там, где
  важны acceptance, hierarchy, relations, current `version` или statuses.
- Каждый paginated read использует page size не больше `50`, finite
  `max_pages`/`max_records`, opaque `nextCursor` и завершается только при
  `hasMore=false`. Duplicate ref/cursor, unknown tail или permission gap дают
  `SNAPSHOT_INCOMPLETE`.
- Release 0.1 exact-read-ится по ref
  `e92b681b-fd18-43e2-91df-3538c37d9890`; designated projection anchor — Task
  `492adef6-ff53-4244-bf42-c101bb350ade` (`MD-285`). Adapter проверяет их
  принадлежность Project до mutation.
- Current status catalog exact-read-ится; `In Progress` и `In Review` имеют
  provider category `started`, но различаются exact status ref/name. `Done`
  не заменяет acceptance evidence calling workflow.
- Native `blocks` relation нормализуется как directed dependency edge;
  hierarchy не создаёт dependency автоматически.

## Task-level mutations

Calling workflow, а не adapter, решает, нужен ли status/comment write. Adapter:

- перед `update_task` exact-read-ит Task и передаёт current `version`;
- использует canonical status ref из exact Project catalog;
- после write exact-read-ит Task и проверяет desired state и новую version;
- при `version_conflict` перечитывает Task и не затирает unrelated changes;
- root comment создаёт через native `add_task_comment` с устойчивым
  `idempotencyKey`, затем перечитывает native thread;
- после timeout/unknown acknowledgement сначала ищет exact effect и только
  затем решает, нужен ли retry.

Opening, progress и verification reports — разные logical effects и не
переиспользуют idempotency key. Description не является fallback для comments.

## Designated scope projection anchor

Текущий connector не предоставляет native Release status-update. Поэтому
release-level fact проецируется только append-only native comment exact Task
`MD-285`, а не произвольной Task, Project description или Release metadata.
Marker имеет closed schema
`ship-work-release/task-manager-scope-fact-comment/v1` и содержит exact
profile/provider/Project/Release/anchor identities, stable `effect_id`,
`idempotency_key`, exact `supersedes_comment_ref`, snapshot digest, candidate
SHA, bounded non-secret evidence refs и UTC time.

Перед append adapter exact-read-ит Project/Release/anchor, полностью читает
anchor comments, разрешает единственную голову predecessor chain, повторно
сверяет anchor version/membership, создаёт comment и перечитывает thread.
Success требует ровно один marker exact effect и непрерывную chain. Fork,
missing predecessor, drift или unknown create outcome без exact reconcile дают
`PROJECTION_AMBIGUOUS`; второй terminal summary вслепую запрещён.

```yaml
exact_entity_read: available
bounded_full_snapshot: available
relation_closure: full
item_status_projection: supported
item_progress_projection: supported
scope_fact_projection: designated_anchor
expected_old: compare_immediately_before_write
idempotency: adapter_marker_and_reconcile
reconcile: exact_effect_lookup
```

- Read-only OAuth делает write capabilities `unavailable`; reconnect с write
  scope — external prerequisite, а не повод принимать credential в тексте.
- Project/Release descriptions также не имеют supported mutation surface.
  Поэтому их historical AND/Linear или superseded release-scope narrative
  считается non-authoritative. Current scope задают exact Release composition,
  relations, accepted repository contracts и fresh task read-back; stale
  description не является blocker и не может расширить authority.
- Delivery semantics, Goal policy, writer lanes, release boundary и deploy
  authority остаются в `ship-work-release`; adapter не выбирает их сам.

## Historical Linear mapping

[`ship-work-release-linear.md`](ship-work-release-linear.md) сохранён для
исторической трассировки старого rollout и не является действующим adapter,
profile, scope selector или source of truth для Mind Diary. Его старый Project
ID `6c07eabb-e588-4184-8eaa-5974ad67fdda` не должен использоваться.
