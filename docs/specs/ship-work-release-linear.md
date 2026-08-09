# Linear adapter для `ship-work-release`

Статус: accepted adapter specification, 2026-08-09.

Документ задаёт всю Linear-specific семантику `ship-work-release`. Базовый
[execution contract](ship-work-release.md) работает только с нормализованными
work scopes, work items, dependencies, status classes и projections.

В skill этот adapter хранится отдельным lazy-loaded reference
`references/task-manager-linear.md` и загружается только при
`task_management.adapter=linear`.

## Adapter identity

~~~yaml
adapter: linear
contract: ship-work-release/task-manager-adapter/v1
reference: references/task-manager-linear.md
~~~

## Scope mapping

Linear adapter отображает:

| Core concept | Linear source |
|---|---|
| work collection | Linear project |
| work scope | project milestone либо явно выбранный bounded issue set |
| work item | issue |
| item key | immutable issue ID + human-readable identifier |
| parent closure | parent/child issue relationship |
| dependency edge | blocking/blocked relation |
| acceptance source | issue description, linked accepted specification и repository contract |
| progress projection | issue status и bounded comments |

Default selector `current_project_milestone` разрешается внутри exact Linear
project из project delivery profile. Adapter обязан получить один exact
nonterminal milestone. Ноль или несколько подходящих milestones дают
fail-closed ambiguity; milestone не выбирается по похожему имени или старому
receipt.

Explicit selectors поддерживают exact milestone ID/name и bounded exact issue
IDs. Cohort, batch и UAT cut не создают дополнительные Linear milestones или
issues.

## Normalized status classes

Adapter использует Linear status type, а не локализованное display name:

| Linear status type | Core status class |
|---|---|
| backlog | `backlog` |
| unstarted | `ready` после dependency/acceptance preflight, иначе `blocked` |
| started | `active` |
| completed | `done` |
| canceled | `canceled` |

Custom display names вроде Backlog, Todo, In Progress или Done остаются
projection metadata. Они не меняют normalized semantics.

Issue переводится в completed только после собственного acceptance, required
repository evidence и всех обязательных live criteria. Intermediate UAT cut
не закрывает issue автоматически. Parent issue закрывается только после
child/acceptance closure.

## Snapshot и fingerprint

Один bounded snapshot содержит:

- project и milestone exact IDs;
- issue ID, identifier, title и updated timestamp;
- status ID/type;
- description и acceptance references;
- parent/children;
- blocking/blocked relations;
- assignee, labels и project/milestone binding, если они влияют на routing;
- permissions/capabilities текущего principal.

Fingerprint включает все поля, влияющие на acceptance, dependencies, routing и
terminal status. Drift после claim инвалидирует publication authority:
coordinator rereads issue, показывает изменение и re-plans либо preserves work
как non-authoritative.

Linear comments, status и labels являются projections, а не canonical workflow
database. Authority worktree, lane epoch, external-effect journal, cohort,
candidate и rollback state хранятся в canonical reducer.

## Read operations

Adapter обязан поддерживать:

1. resolve exact project и scope;
2. list bounded scope items без silent truncation;
3. read exact item и relations;
4. reread changed items перед mutation;
5. получить status catalog и permissions;
6. построить normalized ready frontier;
7. reconcile remote projection после timeout или потерянного acknowledgement.

Pagination завершается полностью либо operation fail closed. Search results не
используются как authority, пока exact entity не reread по ID.

## Write operations

Только coordinator выполняет Linear mutations:

- переводит work item между разрешёнными status classes;
- записывает bounded human-readable progress/evidence comment;
- сохраняет exact candidate/UAT facts в item или scope projection;
- reconciles parent closure;
- исправляет projection после rollback или rejected evidence.

Каждая mutation имеет effect intent, expected-old value и idempotency key.
После timeout adapter сначала rereads Linear; blind replay запрещён. Worker,
scout и reviewer не получают Linear write authority.

Technical polling, retry, lane heartbeat, claim internals и raw logs не
проецируются в comments. Один meaningful transition создаёт не более одного
bounded update.

## Done и scope completion

Normalized `done` требует:

- acceptance exact issue выполнено;
- targeted evidence и applicable release evidence сохранены;
- dependency/parent preconditions reconciled;
- отсутствует unresolved rejected UAT evidence, относящееся к issue;
- remote Linear state reread после mutation.

Scope UAT release требует, чтобы все входящие в scope items имели допустимый
terminal status, dependency/parent closure была coherent, а exact final
candidate и UAT evidence были связаны с scope. Linear milestone сам по себе не
является release artifact.

## User-visible projection

Status card и terminal report показывают одновременно:

- adapter `linear`;
- project и milestone;
- total items и count каждого normalized status class;
- unfinished, ready, active и blocked count;
- current item/lane;
- batch, candidate, UAT cut и terminal claim.

Команда side-status читает Linear snapshot, но не меняет status, comments,
claims или coordinator state.

## Packaging

`SKILL.md` выбирает adapter по project delivery profile и напрямую ссылается
на `references/task-manager-linear.md`. Base references не копируют Linear
status mapping, milestone resolution, comment policy или API-specific
reconciliation.

Новый task-management provider добавляется отдельным
`references/task-manager-<provider>.md`, реализует тот же adapter contract и
не меняет router, lanes, pause, cohorts, dev/UAT или production boundary.
