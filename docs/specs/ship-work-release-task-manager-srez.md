# Task Manager adapter для `ship-work-release` в Mind Diary

Статус: accepted project mapping, revision 2, 2026-08-24.

Документ фиксирует provider-specific mapping Mind Diary к текущему Task Manager
server. Общий boundary задаёт
[`task-management adapter contract`](ship-work-release-task-manager.md),
orchestration semantics — [`ship-work-release`](ship-work-release.md), exact
project values —
[`delivery profile`](../operations/ship-work-release-profile.md), а порядок
вызовов — отдельный
[`operational runtime reference`](../operations/ship-work-release-task-manager-srez.md).

Эта revision supersede-ит прежнюю Linear mapping для Mind Diary. Исторические
Linear IDs, human keys и receipts сохраняют provenance, но не являются current
selector или authority.

## Adapter и provider instance

```yaml
adapter: task-manager
contract: ship-work-release/task-manager-adapter/v1
provider_instance_id: appgprj_exampleb73ec2a398f1e2cc
runtime_reference: docs/operations/ship-work-release-task-manager-srez.md
```

`provider_instance_id` — стабильный OpenAI Sites project ID deployed Task
Manager server instance. Это не package/version plugin-а, не OAuth principal,
не Project Mind Diary и не URL. Connector `get_workspace` пока не публикует
отдельный immutable workspace UUID, поэтому profile хранит server instance ID
как exact configured literal и запрещает подменять его package identity
`task-manager@srez-marketplace`.

Preflight независимо проверяет, что вызывается configured Task Manager MCP
resource, `get_workspace` успешно возвращает фактические read/write
capabilities текущего principal, а exact Project принадлежит этому server
instance. Изменение configured server instance требует новой profile revision;
совпадение display name или данных другого Task Manager instance не является
reconciliation.

## Canonical collection, scope и anchor

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
    display_name: "0.1"
scope_fact_anchor:
  provider: task-manager
  kind: task
  id: 492adef6-ff53-4244-bf42-c101bb350ade
  display_name: MD-285
```

Project, Release и anchor Task exact-read-ятся по canonical refs перед каждым
run и перед scope projection. Adapter проверяет, что Release и anchor всё ещё
принадлежат exact Project, а anchor — configured Release. `Mind Diary`, `0.1`
и `MD-285` служат только человеку. Ноль, несколько результатов, archived
entity, несовпадающая parent identity или stale ref дают fail-closed preflight.

Default scope содержит все non-archived Tasks exact Release, включая terminal
Tasks: terminal history нужна для dependency closure и доказательства полного
release state. Backlog исключается только по явному business selector
`ship-tasks`; adapter сам не меняет выбранный delivery scope и не угадывает
его по текущему UI view.

## Bounded snapshot

Каждый paginated read использует page size не больше `50`. Profile задаёт
finite `max_pages`, `max_records` и request timeout отдельно для:

- Project Releases;
- Release Tasks;
- Task relations и subtasks;
- native comments, которые участвуют в evidence/reconcile;
- status catalog.

Adapter проходит `nextCursor` до `hasMore=false`. Достижение любого bound,
повтор cursor-а, duplicate canonical ref, неизвестный хвост или permission gap
дают `SNAPSHOT_INCOMPLETE`; предыдущий snapshot не дополняет новый. Compact
`list_tasks` rows являются только inventory. Для каждой selected Task и каждого
boundary node выполняется `get_task`, если acceptance, description, hierarchy,
relations, current `version` или available statuses влияют на решение.

Минимальный read protocol:

1. `get_workspace` — observed principal capabilities и status catalog;
2. `get_project` по exact Project ref — current workflow/status refs;
3. `get_release` либо exact result полного bounded `list_releases` по Release
   ref — принадлежность Project и lifecycle;
4. полностью paginated `list_tasks(projectRef, releaseRef, limit=50)`;
5. `get_task` для selected и boundary Tasks;
6. полностью paginated `list_task_comments(limit=50)` только для comments,
   которые входят в acceptance, opening report или scope projection reconcile.

Connector surface может расти, но новый list/read не становится частью
authoritative snapshot без profile pagination bound и новой adapter revision.

## Lifecycle и relations

Current status catalog exact-read-ится; имена не hardcode-ятся как refs.
Нормализация выполняется по provider category:

| Task Manager category | Normalized class |
|---|---|
| `backlog` | backlog |
| `unstarted` | ready или blocked по graph/acceptance |
| `started` | active или review по exact status metadata |
| `completed` | terminal-success candidate |
| `canceled` | terminal-nonsuccess |

`In Progress` и `In Review` имеют одну provider category `started`; различие
берётся из exact status ref/name текущего Project catalog и сохраняется в
provider metadata. `Done` не доказывает verification само по себе: calling
workflow обязан иметь acceptance/evidence до terminal projection.

Native `blocks` relation хранится относительно source/target direction и
нормализуется в одно directed dependency edge. `blocked_by` — только read
presentation обратного направления. Parent/subtask задаёт hierarchy, но не
создаёт dependency автоматически. Missing boundary Task или неоднозначное
направление блокирует затронутый frontier.

## Task-level mutations

Calling workflow, а не adapter, решает, нужен ли status/comment write. Adapter
только исполняет уже авторизованный projection:

- перед `update_task` делает exact `get_task` и передаёт current `version`;
- использует canonical status ref из exact Project catalog;
- после write exact-read-ит Task и проверяет desired state и новую version;
- при `version_conflict` перечитывает Task и не затирает unrelated changes;
- root comment создаёт через native `add_task_comment` с устойчивым
  `idempotencyKey`, затем exact-read-ит comment thread;
- после timeout или unknown acknowledgement сначала ищет effect по exact
  idempotency/marker identity и только затем решает, нужен ли retry.

Opening report, progress report и verification report остаются отдельными
логическими effects и не переиспользуют один idempotency key. Description не
используется как fallback для comments.

## Designated scope projection anchor

Task Manager не предоставляет native Release status-update. Для current
Release 0.1 принят `designated_anchor`: append-only native comments exact Task
`492adef6-ff53-4244-bf42-c101bb350ade` (`MD-285`). Комментарий произвольной
Task, Project description или Release metadata не заменяет anchor.

Payload marker имеет closed schema
`ship-work-release/task-manager-scope-fact-comment/v1` и bounded JSON body:

```json
{
  "schema": "ship-work-release/task-manager-scope-fact-comment/v1",
  "profile_id": "mind-diary",
  "profile_revision": 4,
  "provider_instance_id": "appgprj_exampleb73ec2a398f1e2cc",
  "collection_id": "525e801d-0ae9-4be7-bae4-6a9c8f85f581",
  "scope_id": "e92b681b-fd18-43e2-91df-3538c37d9890",
  "anchor_task_id": "492adef6-ff53-4244-bf42-c101bb350ade",
  "effect_id": "opaque-stable-effect-id",
  "idempotency_key": "opaque-stable-idempotency-key",
  "supersedes_comment_ref": null,
  "scope_snapshot_sha256": "sha256:<64 lowercase hex>",
  "candidate_sha": "<40 lowercase hex>",
  "fact_kind": "release-state",
  "fact_state": "open",
  "evidence_refs": [],
  "created_at": "RFC3339 UTC"
}
```

`fact_kind` имеет closed values `release-state | batch-evidence |
terminal-summary`; допустимые `fact_state` зависят от calling workflow и не
расширяют его lifecycle. `evidence_refs` содержит только bounded non-secret
stable refs/digests. Marker не хранит credentials, private task bodies, user
identity или raw provider response.

Перед create adapter:

1. exact-read-ит Project, Release и anchor, сохраняет anchor `version`;
2. полностью читает anchor comments и разрешает current predecessor;
3. требует `supersedes_comment_ref` exact current predecessor либо `null`, если
   scope marker ещё отсутствует;
4. повторно exact-read-ит anchor непосредственно перед append и блокирует drift;
5. создаёт comment с marker `effect_id` и `idempotency_key`;
6. сохраняет returned exact comment ref и перечитывает thread;
7. проверяет ровно один marker effect и непрерывную predecessor chain.

Concurrent successor, две головы chain, missing predecessor, marker с другим
scope/anchor, удалённый comment или unknown outcome без exact reconcile дают
`PROJECTION_AMBIGUOUS`. Adapter не создаёт «исправляющий» второй terminal
comment вслепую. Новый terminal summary обязан supersede-ить exact предыдущую
голову; старые comments остаются immutable history.

## Capability и error mapping

Для exact authorized principal mapping объявляет:

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
provider_revision: opaque_revision
permission_preflight: coarse
```

Это observed run capability, а не вечная характеристика package. Read-only
OAuth делает write capabilities `unavailable`; reconnect с write scope —
external prerequisite, а не повод просить token в тексте.

Основные typed failures:

| Условие | Outcome |
|---|---|
| Нет exact Project/Release/anchor | `SELECTOR_INVALID` |
| Pagination не завершена | `SNAPSHOT_INCOMPLETE` |
| Нет write scope | `PERMISSION_UNAVAILABLE` |
| Task version drift | `EXPECTED_OLD_MISMATCH` |
| Неизвестный write result | `EFFECT_UNKNOWN` до reconcile |
| Marker/predecessor fork | `PROJECTION_AMBIGUOUS` |

## Authority boundary

Adapter не создаёт Goal, не выбирает delivery scope, не решает acceptance, не
назначает writers, не выполняет Git/CI/Sites и не переводит Tasks в Done сам.
Эти решения принадлежат active `ship-tasks`/`ship-work-release` workflow и
явному пользовательскому authority. Profile и этот mapping позволяют безопасно
выполнить технический read/write, но не являются самостоятельным разрешением
на mutation.
