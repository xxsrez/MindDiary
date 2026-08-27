# Release 0.3: delta полномочий import/export

Статус: proposed implementation register, 2026-08-27. Документ фиксирует
проверяемую разницу между текущим repository contract и целевой границей
Release 0.3. Он не утверждает, что перенос routes уже реализован или развёрнут.

Авторитетная product boundary принята в [обзоре](../overview.md#product-authority-после-release-01),
[архитектуре](../architecture.md#sites-control-plane-и-internal-api) и
[storage/import contract](sites-storage-capacity-import.md#release-03-product-authority):
управление import/export принадлежит только authenticated Sites control plane.
Content MCP сохраняет discovery, read/history/standalone validation и ordinary
atomic commit в заранее разрешённый exact target, но не начинает и не ведёт
import/export workflow.

Этот register основан на repository candidate
`25d8b8213ff1bf938b57831d1febe8649c283250`. Машинная форма находится в
`tests/fixtures/import-export-authority-delta/contract.v1.json`; conformance test
проверяет закрытые route/schema/state matrices, но не доказывает runtime cutover
или UAT.

`evidence.blobs` в fixture — закрытый список затронутых authority/spec/runtime
источников с SHA-256 exact Git blobs. Проверка читает каждый blob через
`git show <observed_candidate>:<path>`, а не из working tree и не относительно
`HEAD^`; поэтому последующий cherry-pick не меняет заявленную evidence base.
Изменение candidate, path set или digest делает contract test красным.

## Граница и неизменяемые примитивы

Изменяется inbound owner, а не canonical content lifecycle:

- Markdown import остаётся resumable exact-snapshot replacement:
  `plan -> reserve -> stage -> validate -> promote -> one HEAD CAS -> cleanup`;
- текущий implementation уже создаёт
  `mind-diary-revision-manifest-v4`, сохраняет opaque entries exact base revision
  и публикует ровно одну revision или ничего;
- export остаётся exact-revision, asynchronous и deterministic; существующие
  `MD-OKF-ZIP-1` и `MD-BUNDLE-ZIP-1`, streaming builder, lease-fenced worker,
  R2 parts, job/grant records и authorized download сохраняются;
- archive bytes не входят в REST JSON или JSON-RPC. Большие payload передаются
  через bounded multipart staging либо object storage и короткоживущий bearer
  download grant;
- internal reuse `Authorizer`, quota reservations, idempotency, validation,
  canonical promotion, HEAD CAS и background handlers не превращает их в
  Content MCP authority.

Не переоткрываются решения MD-264/ADR-0016. ZIP/archive import, binary import,
Drive sync, provider-specific connector, AWS deployment и production release
остаются вне этой задачи.

## Route delta register

`keep` означает отсутствие wire/owner change; `move` — новый inbound owner при
сохранении внутренней семантики; `change` — усиление контракта; `remove` — имя
исчезает из advertised surface. `compatibility-stub` не исполняет операцию.

| ID | Текущий route/tool | Target Release 0.3 | Disposition | Implementation owner |
|---|---|---|---|---|
| `IM-PLAN` | `POST /api/v1/minds/{mind_ref}/markdown-import-plans` | тот же Sites route | `keep` | existing web/import implementation |
| `IM-START` | `POST /api/v1/minds/{mind_ref}/markdown-imports` | тот же Sites route | `keep` | existing web/import implementation |
| `IM-BATCH` | `PUT /api/v1/markdown-imports/{import_id}/batches/{checkpoint}` | тот же bounded multipart route | `keep` | existing web/import implementation |
| `IM-STATUS` | `GET /api/v1/markdown-imports/{import_id}` | тот же creator-private status route | `keep` | existing web/import implementation |
| `IM-VALIDATE` | `POST /api/v1/markdown-imports/{import_id}/validate` | тот же bounded internal-import validation step | `keep` | existing web/import implementation |
| `IM-COMMIT` | `POST /api/v1/markdown-imports/{import_id}/commit` | тот же bounded promotion/final HEAD CAS step | `keep`, clarify v4 | existing implementation; shared spec correction at integration |
| `IM-CANCEL` | `DELETE /api/v1/markdown-imports/{import_id}` | тот же close-and-cleanup route | `keep` | existing web/import implementation |
| `EX-START` | MCP start_export | `POST /api/v1/minds/{mind_ref}/exports` | `move`; MCP name becomes stub | MD-337 contract, unassigned Release 0.3 runtime implementation |
| `EX-STATUS` | MCP get_export_status | `GET /api/v1/export-jobs/{job_id}` | `move` and make creator-private; MCP name becomes stub | MD-337 contract, unassigned Release 0.3 runtime implementation |
| `EX-DOWNLOAD` | `GET /api/v1/exports/{download_secret}` | тот же response-only grant route | `keep` | existing web/export implementation |
| `EX-COMPLETE` | internal complete_export handler | тот же lease-fenced background handler | `keep` | existing background implementation |
| `EX-EXPIRY` | internal export expiry and cleanup | тот же bounded background lifecycle | `keep` | existing background implementation |

Target export start принимает `revision_selector` и optional `profile` в JSON,
`Idempotency-Key` в header, а `mind_ref` — только из route. Adapter разрешает
`mind_ref` в `space_id` до application call. Он не принимает `principal_id`,
role, object key, provider locator или download URL. Status route принимает
только opaque `job_id` из path и возвращает safe job projection; succeeded
status может выпустить новый короткоживущий grant, но никогда archive bytes.

Existing MCP import aliases отсутствуют и не добавляются. Unknown names вроде
`start_import`, `plan_markdown_import` или `commit_markdown_import` остаются
unknown-tool и не получают compatibility alias: нет доказанного historical wire
contract, который надо сохранять.

## Schema delta register

| ID | Current schema/state | Target | Disposition |
|---|---|---|---|
| `SC-IMPORT-PLAN` | `mind-diary-markdown-import-plan-v1` request hash и persisted plan | без изменения | `keep` |
| `SC-IMPORT-SESSION` | `mind-diary-markdown-import-session-v1` и version CAS | без изменения | `keep` |
| `SC-IMPORT-BATCH` | `mind-diary-markdown-import-batch-v1`, multipart ≤ 256 files / 4 MiB | без изменения | `keep` |
| `SC-IMPORT-MANIFEST` | runtime promotion вызывает `createRevisionManifest(..., REVISION_MANIFEST_FORMAT_V4)` | normative text должен говорить v4, без silent rewrite старых revisions | `change-doc` |
| `SC-EXPORT-REQUEST` | internal normalized request v1/v2 и `start_export` idempotency namespace | тот же normalized request вызывается Sites adapter; namespace/hash сохраняются для replay | `move` |
| `SC-EXPORT-JOB` | durable `ExportJob`, safe status, exact profile/revision | без изменения; status дополнительно требует job creator | `change-auth` |
| `SC-EXPORT-GRANT` | durable verifier, response-only secret/URL | без изменения | `keep` |
| `SC-MCP-MOVED` | отсутствует | `mind-diary/mcp-operation-moved/v1` | `add` |

Новый REST adapter не создаёт второй export aggregate, не переименовывает
persisted `start_export` idempotency operation и не пересчитывает request hash
из transport-specific route. Поэтому web retry с тем же principal, exact Mind,
selector, profile и key может безопасно replay-ить job, созданный до cutover.
Changed payload под тем же key остаётся `idempotency_conflict`.

## Authorization, ACL и privacy

### Import

- caller — только registered Sites principal; MCP bearer не заимствуется;
- plan/start/stage/status/validate/commit reauthorize current Space и exact session;
  publish требует `content:write`, то есть current Editor/Admin/Owner либо Owner
  Personal Mind;
- plan/start/commit проверяют exact `expected_revision`; каждая session mutation
  проверяет `expected_version`;
- status существует только для creating principal. Unknown, foreign, deleted
  или unauthorized locator имеет один safe not-found response;
- cancel разрешён creating principal после потери write role, потому что может
  только закрыть private staging, освободить capacity и оставить HEAD без
  изменений;
- path/content разрешены только в авторизованной import projection и никогда
  не попадают в logs, metrics или generic errors.

### Export

- start — только registered Sites principal с current `content:export` для
  resolved exact revision. Reader/Editor/Admin/Owner и authenticated baseline
  Reader public/unlisted могут экспортировать то, что сейчас вправе читать;
- target status требует одновременно `requested_by_principal_id == caller` и
  current access к exact revision. Это intentional tightening относительно
  current `getStatus`, который проверяет access, но не ownership job;
- background completion reauthorizes captured principal before build and after
  the potentially long build. Role revoke, membership revoke, private switch,
  deletion или integrity failure fail closed;
- issuing a grant reauthorizes inside transaction and after it. Download
  resolves only the one-way verifier, then reauthorizes captured principal
  before bytes and immediately before response; browser cookies/Bearer headers
  do not replace grant authority;
- unknown, foreign, revoked, expired or mismatched job/grant responses are
  indistinguishable and contain no Mind metadata, object key or access reason.

## Quota, CAS, idempotency и cleanup

| Concern | Import | Export |
|---|---|---|
| Quota admission | plan metadata checks D1 budget; start atomically reserves worst-case temporary/canonical growth | start atomically reserves estimated temporary archive + metadata as heavy/bulk work |
| Exact revision | plan/session pin `expected_revision`; terminal commit performs one HEAD CAS | start resolves one immutable `revision_id`; export never moves HEAD |
| Idempotency | plan, start and batch have separate canonical hashes/keys; checkpoint/version make resume deterministic | preserve current `start_export` principal/space/key namespace and normalized v1/v2 hash |
| Retry | exact replay returns current plan/session/checkpoint; changed replay conflicts | exact web replay returns same job; failed/running jobs retain lease/version fencing |
| Cleanup | cancel/expiry/failure -> cleanup-pending reservation; persisted bounded staging cursor; terminal session never reopens | job/grant expiry and archive cleanup stay bounded; active export/grant remain GC roots |
| Reauthorization | every visible/publishing step; cancel is the narrow role-loss exception | start/status/grant, worker before+after build, download before bytes+response |

Cleanup сохраняет accepted bounds: один pass не более 100 objects, 256 MiB и
20 seconds; uncertainty skips deletion. Import validation/promotion pages
остаются ≤ 100 files / 4 MiB, staging batch — ≤ 256 files / 4 MiB. Failure,
cancel или stale HEAD не публикуют partial revision.

## State migration register

### Markdown import

| State | Cutover action |
|---|---|
| unexpired plan | `keep`; тот же Sites principal может claim/replay по current contract |
| `active` | `keep`; resume from exact batch checkpoint after exact folder fingerprint reselect |
| `validating` | `keep`; resume bounded validation from persisted checkpoint |
| `validated` | `keep`; await explicit Site confirmation, then promote |
| `finalizing` | `keep`; resume promotion; HEAD всё ещё unchanged до terminal CAS |
| `committed` | `keep`; immutable revision/status read-back, cleanup continues |
| `validation_failed`, `canceled`, `expired` | `keep-closed`; never reopen, only bounded cleanup/new session |

### Export

| State | Cutover action |
|---|---|
| `queued`, `running`, `failed` | `keep`; same worker/lease/retry state, creator sees it through new Site status route |
| `succeeded` | `keep`; exact archive remains and a newly authorized Site status may issue a fresh grant |
| `expired` | `keep-closed`; archive/grants cleanup continues, no resurrection |
| grant `active` | `keep`; existing URL remains bounded by current reauthorization/expiry |
| grant `revoked`, `expired` | `keep-closed`; never reissue same secret |
| reservation `active` | `keep`; tied to original operation/job/session |
| reservation `cleanup_pending`, `consumed`, `released` | `keep`; recovery finishes idempotently |

No backfill rewrites canonical revisions, archives, plan/session/job IDs,
idempotency results or grant verifiers. The cutover requirement is adapter and
authorization routing, not storage migration. Deploy rollback after v4 content
exists must remain v4-aware.

## MCP compatibility response v1

После cutover `start_export` и `get_export_status` удаляются из advertised
modern and `2025-11-25` tool catalogs, но exact calls получают terminal
application-level compatibility result, а не начинают export:

```json
{
  "schema": "mind-diary/mcp-operation-moved/v1",
  "error": {
    "code": "operation_moved_to_sites",
    "operation": "start_export",
    "destination": "sites_control_plane",
    "replacement_route": "POST /api/v1/minds/{mind_ref}/exports",
    "retryable": false
  }
}
```

Для `get_export_status` replacement —
`GET /api/v1/export-jobs/{job_id}`. Tool result имеет `isError: true`; transport
остаётся JSON-RPC success response, чтобы ошибка операции не становилась
protocol failure. Оба MCP protocol profiles получают одинаковый schema/code;
legacy adapter может удалить только уже принятые modern result metadata.
Compatibility response не содержит current status, signed URL, Site origin,
Mind name или доказательство существования job. Stub не authorizes target, не
резервирует quota, не пишет idempotency и не ставит background work.

Stub сохраняется минимум один UAT release после cutover; его удаление требует
отдельного compatibility decision с client evidence. Это migration aid, а не
постоянная Content MCP authority.

## Пробелы зафиксированной сборки

Список ниже относится к evidence-locked candidate этого register и сохраняется
как историческое доказательство причин runtime cutover. Более позднюю локальную
сборку MD-361 он не описывает.

1. `start_export`/`get_export_status` всё ещё advertised и исполняются MCP
   adapter; target REST start/status routes отсутствуют.
2. Current `ExportJobApplicationService.getStatus` reauthorizes current access,
   но не сравнивает caller с `requestedByPrincipalId`; target Site status должен
   быть creator-private.
3. Versioned `mind-diary/mcp-operation-moved/v1` stub ещё не существует.
4. `docs/specs/api.md` и
   `docs/specs/sites-storage-capacity-import.md` всё ещё называют terminal
   Markdown import manifest v3, тогда как current code и domain default уже v4.
   Shared normative text must be corrected during integration without rewriting
   historical v1/v2/v3 revisions.
5. Runtime cutover, generated route/tool schemas, dev smoke, UAT and rollback
   evidence принадлежат отдельной Release 0.3 implementation/release работе;
   MD-359 не выполняет и не объявляет их.

MD-337 owns the complete cross-surface operation register and must consume
these import/export dispositions without inventing a second lifecycle.
MD-339 owns credential writable-target migration; import/export remain
Sites-authenticated and must not acquire a read/write binding precondition.

## Локальная реализация MD-361

MD-361 закрывает пункты 1–3 в локальной сборке: Sites REST принимает запуск и
доступный только создателю статус, существующие exact-revision
engine/job/grant/download переиспользуются, а оба MCP-каталога больше не
публикуют export names. Точные вызовы прежних имён получают versioned
side-effect-free moved result из этого register. Это уточняет общий rule
`Invalid params` из MD-337 только для двух evidence-backed export names и
минимум на один UAT release; остальные неизвестные tools и удалённые методы
отдельных профилей сохраняют protocol behavior MD-337.

Незакрытым остаётся пункт 5 в части dev/UAT/live evidence и rollback. Этот
follow-up не утверждает deployment или production readiness.

## Acceptance граница MD-359

MD-359 завершён как contract delta, когда Markdown и machine fixture совпадают,
route/schema/state sets закрыты conformance test, gaps перечисляют только live
repository evidence, а docs/link/diff checks проходят. Это не acceptance
runtime move, dev/UAT release или production.
