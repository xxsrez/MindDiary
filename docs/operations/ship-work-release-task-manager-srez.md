# Runtime reference Task Manager для доставки Mind Diary

Статус: accepted operational reference, revision 1, 2026-08-24.

Этот документ — исполнимая памятка для configured Task Manager connector. Он
производен от
[`adapter specification`](../specs/ship-work-release-task-manager-srez.md) и
не меняет `ship-work-release` lifecycle, ShipTask policy или authority. Exact
Project/Release/anchor values берутся из
[`project profile`](ship-work-release-profile.md), а не копируются из старого
receipt.

## Preflight

1. В fresh callable catalog разрешить configured direct package
   `task-manager@srez-marketplace` и проверить наличие Task Manager
   `get_workspace`, Project/Release/Task reads, native comments и versioned
   Task write/reconcile tools. Совпадение только display name недостаточно.
2. Вызвать `get_workspace`. Сохранить observed read/write capabilities без user
   email, token или других credential values. Ответ не содержит immutable
   workspace UUID; не придумывать его из Sites hosting project, URL, OAuth
   principal или package version.
3. Exact-read Project ref `525e801d-0ae9-4be7-bae4-6a9c8f85f581` и его current
   status catalog.
4. Полностью пройти `list_releases(projectRef, limit=50)` до `hasMore=false` и
   разрешить ровно Release ref `e92b681b-fd18-43e2-91df-3538c37d9890`.
5. Exact-read designated anchor Task ref
   `492adef6-ff53-4244-bf42-c101bb350ade`; проверить Project/Release, archive
   state и сохранить current version.

Нулевой/ambiguous result, stale identity, missing read capability или
незавершённая pagination останавливают run до Goal/task/comment/code mutation.
Configured package identity ограничивает runtime routing, но не является
утверждением о connector-visible workspace/server UUID. Deployment provenance
Task Manager проверяется отдельно и не участвует в AdapterRef reconciliation.

## Snapshot Release 0.1

- Вызывать `list_tasks` с обоими exact filters `projectRef` и `releaseRef`,
  `limit=50`.
- Продолжать только по opaque `nextCursor`; не конструировать cursor и не
  менять filters между страницами.
- Остановиться успешно только при `hasMore=false`.
- Отклонить duplicate refs, повтор cursor-а и превышение profile `max_pages` или
  `max_records`.
- Для каждой выбранной Task вызвать `get_task` перед reasoning из description,
  acceptance, parent/subtasks, relations, status или version.
- Boundary dependency exact-read-ить даже вне selected set; отсутствие доступа
  блокирует только затронутый frontier, но не скрывается.
- Comments читать `list_task_comments(limit=50)` до конца, когда они нужны для
  acceptance, lifecycle report или reconcile. Imported external context не
  заменяет native comment thread.

Snapshot receipt сохраняет canonical refs, filters, число страниц/records,
terminal cursor fact, observed capabilities и digest. Task bodies, comments и
private attachments в release receipt не копируются.

## Task status и comments

Перед status write:

1. `get_task(taskRef)`;
2. выбрать canonical `statusRef` из current Project catalog;
3. вызвать `update_task(taskRef, version, statusRef)`;
4. повторить `get_task` и проверить status ref, lifecycle time и новую version.

`version_conflict` требует нового read и semantic comparison. Retry допустим
только если desired transition всё ещё применим; unrelated newer changes не
перезаписываются.

Перед root comment:

1. exact-read Task;
2. проверить `list_task_comments`, если это retry/unknown outcome;
3. вызвать `add_task_comment` с новым stable idempotency key логического
   report-а;
4. перечитать native thread и сохранить exact comment ref.

Один key используется только для одного неизменного body. Description,
imported comment и новый «похожий» comment не являются fallback.

## Scope fact через MD-285

Release-level state записывается только в designated anchor Task `MD-285` по
marker schema
`ship-work-release/task-manager-scope-fact-comment/v1` из adapter spec.

До append:

1. exact-read Project, Release и anchor;
2. полностью прочитать anchor comments;
3. выбрать единственную голову marker chain;
4. положить её exact ref в `supersedes_comment_ref` или `null` для первого
   marker-а;
5. сформировать bounded marker с exact snapshot/candidate digests, effect ID и
   независимым idempotency key;
6. повторно exact-read anchor и сравнить version/membership;
7. создать comment, сохранить returned comment ref и перечитать thread.

Success требует ровно один comment exact effect и непрерывную predecessor
chain. Fork, competing successor, missing predecessor, drift либо unknown
create outcome оставляют projection unresolved. Не создавать второй terminal
summary до exact reconcile.

## Reconcile before retry

После timeout/network loss:

- status write: `get_task`, сравнить exact desired state, prior version и
  unrelated fields;
- comment write: полностью прочитать Task comments и искать exact
  idempotency/effect marker;
- scope fact: дополнительно проверить predecessor chain и единственную голову;
- found exact effect — принять returned/live ref и не повторять write;
- absent exact effect при доказанном terminal read — retry тем же key;
- incomplete read, duplicate marker или incompatible state — вернуть typed
  unknown/ambiguous outcome вызывающему workflow.

## Boundary и handoff

Этот runtime reference не разрешает Task mutation сам по себе. Status/report
policy, Task selection, Goal, verification, Git integration, CI, UAT deploy и
Done принадлежат calling ShipTask workflow. Production, destructive data,
credentials, access-policy и external recipients остаются explicit-only.

В handoff отдельно указать:

- exact Project/Release/Task refs и pagination disposition;
- observed connector read/write capability;
- Task version до/после каждого status write;
- exact comment ref и marker predecessor для каждого report/projection;
- unresolved permission, incomplete snapshot или unknown effect без
  optimistic формулировки об успехе.
