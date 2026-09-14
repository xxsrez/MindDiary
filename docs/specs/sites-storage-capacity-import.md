# Sites storage, capacity и Markdown import

Статус: accepted, 2026-08-22. `normative_status: accepted`;
`implementation_status: implemented_local_uat_pending`. Это Sites-only contract
для post-MVP Brain-scale storage/import. Его технические invariants сохраняются,
но [ADR-0019](../decisions/0019-release-0-1-codex-first-small-data-boundary.md)
убирает capability из terminal Release 0.1. MD-265 реализует в текущем repository candidate
Space-scoped content objects, separately digested v3 manifests, delta-aware
commit/read/GC и совместимое чтение legacy v1/v2 revisions. Reconstructable
accounting, durable reservations, admission для commit/stage/export, fairness,
bounded reservation cleanup, privacy-safe Owner usage и aggregate telemetry из
MD-266 реализованы в текущем repository candidate. Streaming export/download и
D1-checkpointed bounded cleanup из MD-268 также реализованы локально. MD-267
реализует private Sites UI/REST import sessions, bounded staging, validation и
canonical promotion checkpoints, exact HEAD commit, retry/cancel/expiry и
cleanup. Весь extension пока не проверен на exact UAT deployment.

ADR-0021 accepts manifest v4 as the Release 0.2 format-neutral successor. V4
keeps the separately digested Space-scoped layout but opens opaque media and
raises the per-file/counting-stream boundary to 256 MiB. Historical candidates
до MD-304 писали v3/legacy closed-media objects; current local implementation
пишет v4, сохраняя version-aware чтение immutable v1/v2/v3 revisions.

MD-271 задаёт общий [file-ingress contract](file-ingress.md) для source bytes,
которые могут быть staged как `BundleFile`. Этот документ отвечает только за
Space-scoped storage, capacity/reservation и отдельный Markdown import profile:
он не делает `local_path`, workspace или connector source capability
реализованной. В текущем candidate native `session_attachment`, bounded-inline
и server-generated streaming остаются отдельными local BundleFile paths;
hosted/native UAT для них по-прежнему требует exact evidence.

### Release 0.3 product authority

Import and export remain Sites control-plane workflows. Site owns plan,
reservation, staging/validation/finalization, status, cancellation, export
creation and authorized archive download. Content MCP may discover/read/search/
history/validate the exact resulting revision and perform a normal atomic
content commit in its server-approved exact target, but it is not a second
import/export administrator and does not require read bindings.

Этот authority split не меняет storage, capacity, manifest, checkpoint or GC
invariants ниже. Exact route/tool disposition belongs to MD-337; writable-target
and binding migration to MD-339. Current local/UAT status remains unchanged.
Import validation и final revision publish — внутренние этапы этой единой
Site-owned operation, не второй standalone validate или ordinary content-write
surface.

## Цель и граница

Обычная правка большого Mind не должна читать и заново записывать весь corpus,
а большой import/export не должен становиться одной неограниченной Worker
операцией. Canonical content остаётся immutable, exact-revision и
content-addressed; D1 хранит transactional authority и bounded metadata, R2 —
bytes. Derived search, usage projections и temporary objects не становятся
источником истины.

File ingress и Markdown import не смешиваются: file ingress stages one opaque
object per `staged_file_ref`, а Markdown import stages a complete UTF-8
Markdown snapshot through its own plan/session/checkpoint contract. Оба пути
используют одинаковые Space-scoped objects, reservations и final HEAD CAS;
ни один source locator не становится R2/D1 identity.

Первый import profile принимает только отдельные UTF-8 Markdown files. ZIP,
BundleFile file-by-file staging, symlinks, OCR, remote crawl, Google Drive
sync, legacy OKF 0.1 и cross-Mind merge не входят в этот import profile.
`BundleFile` ingress остаётся отдельным producer contract; его source matrix
не превращает archive/binary import в доступный workflow. AWS остаётся будущей
infrastructure direction и не является current implementation или fallback.

## Выбранная модель

### Canonical namespaces

Все новые canonical bytes изолированы `space_id`; path, display name, email и
content digest другого Mind не являются lookup key или existence oracle.

```text
spaces/{opaque-space-id}/objects/sha256/{hex}
spaces/{opaque-space-id}/manifests/sha256/{hex}
spaces/{opaque-space-id}/indexes/{opaque-revision-id}/{schema-version}
staging/{opaque-owner-id}/{opaque-session-id}/{opaque-object-id}
exports/{opaque-space-id}/{opaque-job-id}/{sha256-hex}
```

Keys являются internal locator, а не capability. Они не возвращаются клиенту,
не попадают в audit/telemetry и всегда разрешаются после authorization.
Cross-Space physical deduplication отклонена: выигрыш хранения не компенсирует
privacy/accounting ambiguity. Внутри одного Space одинаковый digest занимает
один canonical object и может быть достижим из многих revisions.

### R2 responsibilities

R2 хранит:

- immutable Markdown и accepted opaque objects по Space-scoped digest;
- canonical serialized immutable revision manifests;
- derived exact-revision index artifacts;
- quarantined import/staging objects;
- in-progress и completed export artifacts.

Каждый canonical put проверяет exact byte length и SHA-256 до появления D1
reference. Повторный put с тем же Space/digest обязан получить те же bytes и
metadata; collision или tamper fail closed. R2 listing никогда не используется
в foreground read/commit или как authority для quota; list нужен только
bounded reconcile/GC по persisted cursor.

### D1 responsibilities

D1 хранит transactional records:

- Space/revision identity, parent, author, timestamp и immutable manifest ref;
- единственный current HEAD и optimistic `expected_revision` CAS;
- object reachability/refcount projections scoped to Space;
- usage ledger, reservations, job/session state and persisted cursors;
- idempotency results, authorization state, audit outbox и safe derived-index
  status;
- canonical metadata event log и chunked materialized recovery snapshot:
  snapshot payload не становится одной D1 value, а bounded chunks atomically
  переключаются через exact sequence head и читаются bounded pages.

D1 не хранит Markdown bodies, opaque bytes, ZIP bytes, private search corpus,
download secrets или signed URLs. Manifest entry rows могут быть bounded
projection для lookup/accounting, но canonical manifest bytes and digest are in
R2; projection drift никогда не меняет revision meaning.

### Immutable manifest and HEAD CAS

Release 0.2 new revision uses canonical manifest format
`mind-diary-revision-manifest-v4`. It keeps v3's separately digested storage
contract and exact `path + kind + media_type + sha256 + size`, deterministic
Unicode-scalar ordering and canonical one-line JSON with final newline. V4
changes opaque `media_type` from a closed enum to open advisory metadata with
header-safe `application/octet-stream` fallback. MD-304 завершил local v4 write
promotion; это не переписывает и не переинтерпретирует historical v1/v2/v3.

Commit строит новый manifest как delta от exact parent:

1. Читает только parent manifest и bytes затронутых Markdown files.
2. Пишет только новые/изменённые content objects и новый manifest.
3. В одной D1 transaction повторно authorizes actor, проверяет reservation,
   idempotency и exact HEAD.
4. Создаёт revision record, обновляет reachability/usage and HEAD, consumes
   staging/reservation и ставит derived jobs.

Producer validation и проверка ссылок BundleFile могут требовать чтения всего
Markdown corpus. В пределах одного preflight они используют одну лениво
открытую exact-revision session: manifest проверяется при открытии, каждый
content object по-прежнему проверяется по digest, metadata и размеру. Session
не переиспользуется между запросами; current authorization и финальный HEAD
CAS сохраняются. Readers без session API используют прежний exact-file путь.

Неуспешный CAS не создаёт видимую revision. Уже записанные immutable objects
остаются unreachable и удаляются только после safety window. Retry с тем же
canonical request/idempotency key возвращает прежний result; новый HEAD требует
нового plan/confirmation/key.

## Historical read and search

Canonical browse/fetch/list/history всегда materialize exact manifest and
object digests; HEAD никогда не подмешивается. V1/v2/v3/v4 manifests читаются
одним version-aware compatibility reader и проверяются по stored digest. Each
legacy format retains its historical meaning; no read path re-sniffs or
rewrites old manifest bytes.

Search остаётся derived:

- current HEAD index строится eagerly after commit;
- historical revision index строится on demand и хранится как bounded cache;
- index содержит lexical fields/chunks/offsets, но не является canonical
  history; full Markdown body не дублируется в D1;
- cache eviction не удаляет canonical revision и не разрешает fallback на
  HEAD; до rebuild tool возвращает `search_index_unavailable` with retry hint;
- каждый build/query повторно authorizes exact Space/revision; revoke,
  visibility change или delete fail closed;
- one Space/job получает bounded slice, поэтому long history не монополизирует
  Worker.

## Usage definitions and ownership

Accounting не читает content bodies и использует manifest/object metadata.

- `logical_head_bytes`: сумма `size` entries current HEAD.
- `logical_retained_bytes`: сумма entry sizes across all committed manifests;
  reused bytes считаются для каждой revision и показывают history footprint.
- `physical_canonical_bytes`: unique Space-scoped canonical content + manifest
  + retained derived index bytes actually stored in R2.
- `temporary_bytes`: active staging/import/export objects плюс pending cleanup.
- `d1_metadata_bytes`: measured/estimated rows for canonical metadata, jobs,
  ledger and indexes; private text fields отсутствуют.
- `reserved_bytes`: worst-case growth active admitted operations, не уже
  committed usage.

Mind usage принадлежит его current sole Owner. Reader/Editor/Admin не получают
quota charge. Ownership transfer разрешён только если target principal проходит
aggregate admission с учётом Mind committed usage and active reservations;
transfer itself не копирует objects. Same-Space shared digest physically
считается один раз, logically — в каждой referencing revision. Cross-Space
sharing запрещено.

Ownership admission использует current owner relation, а не сохранённый actor
reservation как источник quota ownership: active reservation передаваемого
Mind учитывается в aggregate нового Owner даже если operation была admitted до
transfer. Transfer отклоняется при недоверенном accounting и при projected
principal utilization `>= 85%` (soft threshold, включая hard limit). Проверка и
две role mutations находятся в одной metadata transaction. Неуспех не меняет
ownership, usage projection, reservation owner/amount/state, audit или
idempotency; успешный transfer не копирует canonical objects и не создаёт новую
capacity reservation.

Ledger events ускоряют projection, но не являются единственной истиной.
Reconcile повторно вычисляет values from committed D1 manifest/reachability
records и exact R2 metadata bounded pages. Drift marks accounting
`reconciling`; operations that could exceed a hard limit fail closed until the
affected budget is trustworthy. Delete/net-shrink and cleanup remain allowed.

## Limits and admission

Все values — binary bytes and deployment constants. Provider headroom may be
smaller; startup/reconcile then uses the smaller effective hard limit and marks
the configured claim unavailable rather than overcommitting.

| Scope | Metric | Hard limit |
|---|---|---:|
| one Markdown file | logical bytes | 1 MiB |
| one opaque BundleFile | logical bytes | 256 MiB inclusive |
| one BundleFile changeset | referenced staged bytes | 256 MiB |
| one binding owner | outstanding verified staged bytes | 256 MiB |
| one Mind HEAD | Markdown bytes | 64 MiB |
| one Mind HEAD | all entries | 1 GiB / 10,000 files |
| one Mind history | physical canonical R2 | 2 GiB |
| one principal | owned Minds physical canonical R2 | 8 GiB |
| one Site | canonical R2 | 32 GiB |
| one Site | temporary R2 | 8 GiB |
| one Site | D1 metadata budget | 512 MiB |
| one import session | Markdown files/bytes | 10,000 / 64 MiB |
| one import batch | files/bytes | 256 / 4 MiB |
| active import sessions | per principal / per Site | 2 / 16 |
| active heavy jobs | per Mind / per principal / per Site | 1 / 2 / 8 |

BundleFile's 60-minute verified-ref TTL, 24-hour orphan safety window and
100-object/256-MiB GC pass remain normative. Combined HEAD and retained-Space
limits are evaluated against both Markdown and BundleFile entries; a lower
specific limit wins. Every opaque upload/promotion/download/export is chunked;
capacity accounting never requires reading the full object into memory.

Streaming stage admission uses exact verified `expected_size` when the source
provides it and falls back to the 256 MiB transport ceiling only when size is
unknown. Heavy classification uses the same reserved byte count, so a small
local/workspace file does not consume the one-heavy-operation-per-Mind lane.
Staging quota, soft capacity, fairness and accounting-untrusted rejections are
retryable without changing the prepared source or intent; hard capacity remains
terminal. Multi-file callers stage and commit sequential bounded batches within
the limits above and preserve explicit per-file partial progress.

For each capacity, states are exact:

- below `70%`: normal;
- `70%..84.999%`: warning, operations still admitted;
- `85%..99.999%`: soft limit; a new bulk import/stage/export reservation is
  rejected. An ordinary commit may proceed only when its additional physical
  canonical growth is at most 4 MiB and every affected budget remains below
  hard limit. Payload size is not the test: same-digest reuse or an already
  reserved BundleFile commit may have zero additional growth, while replacing
  a file whose old bytes remain in history may grow retained usage. Delete,
  net-shrink and cleanup always remain available;
- `>=100%` including active reservations: hard stop for every net-growing
  operation.

The Owner sees Mind/principal warning and safe category totals; an operator sees
aggregate Site totals/headroom without corpus, paths or principal email.
No request field, role or UI acknowledgement can raise a limit. Changing limits
is versioned deployment configuration plus compatibility evidence, not an
operator bypass.

### Reservation protocol

Commit/import/export/stage obtains a durable reservation before expensive
writes. Requested amount is the conservative upper bound for canonical,
temporary and D1 growth; admission atomically checks:

```text
committed_usage + active_reservations + requested <= effective_hard_limit
```

Reservation is bound to owner, Space, operation, exact base revision,
idempotency key and expiry. Acquire/replay/release/consume are D1-transactional
and idempotent. An operation may reduce but never silently increase its
reservation; expansion requires a new atomic admission check. Commit consumes
actual growth and releases remainder in the same HEAD transaction. Failure,
cancel and expiry move reservation to cleanup-pending; a persisted cursor
reclaims temporary bytes before final release. Unknown outcome reconciles exact
state before retry.

Для export transient `failed` job сохраняет reservation до bounded retry или
expiry. Повтор exact selector/profile тем же principal восстанавливает этот job
даже после утраты первоначального client key: новый namespace завершается тем же
job result, а background work планируется повторно без второй reservation.
Несовпадающий export и любая другая heavy operation продолжают получать обычный
`capacity_fairness_limit`.

## Sites-only Markdown import profile

Workflow: `plan -> reserve -> stage batches -> validate -> commit -> finalize`.
An import session is private to the current Sites-authenticated principal and
Space, pinned to exact `expected_revision`, idempotency key and contract
version. The first-party UI does not borrow an MCP credential binding. The
historical possibility of an MCP import adapter is no longer target product
authority in Release 0.3; exact compatibility disposition belongs to MD-337.
Default TTL is 24 hours; progress/checkpoints survive Worker restart.

### Plan and path rules

Plan accepts metadata for the whole selected corpus before any canonical
visibility. Before bytes exist server validates declared size/digest grammar,
quota estimate and these path rules:

- relative `/`-separated path, no leading slash, backslash, drive/UNC/scheme,
  empty/`.`/`..` segment, control character, encoded separator or NUL;
- exact NFC; non-NFC is rejected, not silently rewritten;
- `.md` suffix, at most 1,024 UTF-8 bytes total and 255 per segment;
- no `.mind-diary/` root, symlink/hardlink/device entry or duplicate after NFC;
- exact declared non-negative size and canonical SHA-256 grammar.

Byte order, line endings and content are preserved; importer does not rename,
case-fold, transcode or merge files. After staging, server verifies actual
size/digest, valid UTF-8 and the whole corpus, including reserved
`index.md`/`log.md`, references and unknown OKF types/fields preservation.
The first conflict policy is only `replace_exact_head`: imported Markdown is an
exact snapshot, omitted current Markdown paths are deletions, and existing
opaque paths must remain unchanged without collision. UI shows additions,
replacements/deletions and requires ordinary destructive preview/confirmation.
The first-party UI exposes this flow for Personal Mind `/me` and writable
ordinary Minds. To import into a new ordinary Mind, user first creates it
through normal control flow, then plans against its exact initial HEAD.
Per-file merge, implicit rebase and historical write are absent.

Plan returns bounded counts, logical bytes, path/conflict errors and quota
state, never content bodies. Invalid plan creates no reservation or staged
object. A valid plan is admitted atomically against the Site D1 hard budget;
unclaimed plans expire after one hour and bounded recovery deletes their
metadata. Its constant-size descriptor hash covers the deterministic sorted
`path`/`sha256`/`size` array; reload resume requires the reselected snapshot to
match that hash, not merely counts or aggregate bytes.

### Компактный встроенный интерфейс импорта

Страница Mind после входа показывает импорт Markdown только участнику с
актуальным `content:write`: Editor, Admin или Owner. Единственный Owner также
видит его на `/me`. Reader и пользователь, читающий Mind только благодаря
`visibility`, не получают даже выключенный элемент импорта. До выбора файлов и
во всех незавершённых состояниях панель всегда показывает точный маршрут
целевого Mind и текущую базовую ревизию.

Перед подтверждением браузер локально проверяет ограничения путей, профиль
Markdown-only и корректность UTF-8 выбранного снимка, после чего запрашивает
авторитетный план у сервера. В обзоре видны числа добавленных, заменённых,
удалённых и неизменившихся файлов, конфликты путей и формата, а также ожидаемое
состояние ёмкости. Подтверждение недоступно, пока проверки не пройдены. Текст
прямо предупреждает о полной замене Markdown-снимка: каждый текущий Markdown-
путь, которого нет в выбранном наборе, исчезает из новой HEAD, а неизменяемая
история и непротиворечащие opaque-файлы сохраняются.

После запуска одна подписанная область прогресса показывает только ограниченные
счётчики локальной проверки, загрузки, проверки всего корпуса и канонического
продвижения. Каждая стадия использует существующий долговечный контракт
`checkpoint`/`version`. Пользователь может продолжить свою открытую сессию или
отменить её до commit; успешное завершение показывает точную цель, базовую
ревизию и квитанцию одной созданной ревизии. Обновление страницы, переходы
назад/вперёд и повторное развёртывание Worker восстанавливают состояние по
непрозрачному `import_id` и ссылке на текущий Mind во fragment того же URL с
последующим авторизованным чтением статуса. Браузер не сохраняет пути, хеши,
содержимое или данные операции в `localStorage`/`sessionStorage` и не создаёт
вторую сессию для имитации продолжения.

Каждый запрос статуса или продолжения заново проверяет текущего principal и его
актуальное право записи. Отсутствующий, чужой либо отозванный доступ даёт одно
обобщённое недоступное состояние, очищает fragment и не раскрывает план, пути,
прогресс или квитанцию. Изменение HEAD завершает эту сессию: интерфейс очищает
восстанавливаемое состояние, требует заново открыть текущую ревизию Mind и
построить новый план, не предлагая rebase или повтор устаревшего снимка. Пустой
выбор, ошибка проверки, отказ по ёмкости, отмена и восстановление сохраняют
контекст цели и базы, но не раскрывают object keys, внутренние пространства
хранения, подписанные URL и другие технические детали хранилища.

Временная ошибка чтения статуса — например, сетевой сбой, `503` во время
повторного развёртывания или неполный ответ — не доказывает, что сессия
отсутствует. В этом случае интерфейс сохраняет точный fragment восстановления,
показывает безопасное повторяемое состояние и блокирует создание нового
импорта, пока статус не будет успешно перечитан. Очищать указатель разрешено
только после подтверждённого терминального состояния, `import_session_not_found`
либо потери авторизации текущего аккаунта.

### Stage and checkpoint

After reservation, client uploads ordered batches of at most 256 files / 4 MiB.
Each batch has session ID, monotonic checkpoint, file digests and a
session-scoped idempotency key. Exact replay returns the same checkpoint;
changed bytes/metadata return `idempotency_conflict`. Server verifies streaming
size, digest and UTF-8 before marking a file staged. Progress exposes counts,
bytes and sanitized per-file code/path only to the authorized owner; logs omit
path/content.

Descriptor-matching bytes that are not valid UTF-8 make the sealed plan
impossible to satisfy. The server therefore closes that session as
`validation_failed`, records only sanitized `invalid_utf8`, schedules bounded
reservation cleanup and leaves HEAD unchanged.

One immutable plan can be claimed by exactly one import session. Exact start
replay returns that session; a different idempotency key cannot create another
session or share its reservation.

Disconnect leaves the last committed checkpoint resumable. Cancel/expiry marks
session closed, leaves HEAD unchanged and schedules bounded cleanup. A closed
session never becomes active again; restart requires a new session/key.

### Validate, commit and finalize

Validation materializes the proposed manifest from staged digests, validates
the entire corpus bounded pages of at most 100 files / 4 MiB and rechecks
current access, expected HEAD and reservation. Durable validation checkpoint
and byte count make repeated `validate` calls restart-safe. It never creates a
visible revision. Each page validates OKF and Markdown BundleFile references
against the retained opaque entries of the exact base revision; terminal
sanitized failures schedule cleanup.

Commit/finalize promotes verified objects into the Space-scoped canonical
namespace in durable pages of at most 100 files / 4 MiB, then writes one v4
manifest and uses the normal D1 HEAD transaction. Exactly one new immutable
revision becomes visible or nothing does. Search index job is queued after
commit; canonical browse/fetch works immediately. Finalize records the
idempotent result and schedules staged cleanup. A stale HEAD returns conflict;
server atomically closes the session as `validation_failed` with sanitized
`import_head_conflict`, schedules bounded staging/reservation cleanup and never
reopens it. It never rebases or partially imports automatically.

## Sites-owned export, staging and GC lifecycle

- Staging/import objects have explicit owner/session/state/expiry and are not
  reader-visible.
- Export is exact-revision, asynchronous and streaming/batched into R2; archive
  bytes never enter JSON-RPC or whole Worker memory.
- Один export job открывает request-scoped exact-revision session: canonical
  manifest читается и проверяется один раз, после чего оба deterministic ZIP
  прохода повторно открывают только указанные в нём content objects и каждый
  раз сверяют их metadata, размер и SHA-256. Session не переживает job attempt
  и не является межзапросным manifest cache.
- Download URLs are short-lived response-only bearer material, reauthorized
  before bytes and never durable/logged.
- GC is mark/refcount assisted but treats committed manifests, active staging,
  active export and unexpired reservations as roots.
- Each cleanup run has persisted cursor and limits of 100 objects, 256 MiB and
  20 seconds. It is idempotent and resumes after timeout.
- Unreachable canonical objects wait at least 24 hours. Import/session temporary
  objects wait until closed/expired plus one successful reconcile. No global
  synchronous R2 scan/delete runs in a user request.

Race policy is conservative: uncertain reachability skips deletion and emits a
safe retry metric. Whole-Mind deletion uses its separate restartable erasure
state machine; ordinary GC cannot replace that contract.

## Privacy, threat model and operations

Private/sensitive content remains untrusted input. D1/R2 objects inherit the
Site deployment's access, residency, backup and recovery properties; Mind Diary
does not claim a region, retention SLA, point-in-time restore or legal-erasure
guarantee that Sites has not verified. UAT uses isolated test data.

Never store in logs, telemetry, usage ledger, Task Manager evidence or metrics:

- Markdown/BundleFile bytes, snippets, search query or paths;
- token/CSRF/session/download secrets or verifiers;
- signed URLs, provider file IDs, object keys or authenticated email;
- raw manifest or import request/response bodies.

Allowed telemetry is closed-schema: status/code, duration, bounded counts and
bytes, utilization bucket, reservation age, queue age, retry count, reclaimed
bytes and opaque non-reversible deployment/run fingerprints. Metrics cannot be
joined into a corpus/principal inventory.

Temporary bytes are encrypted/access-controlled by provider bindings and
unreachable without application authorization; signed URLs are never used for
staging authority. Backups are recovery material, not an alternate history/API,
and may not resurrect deleted access. Production residency/backup/retention is
an explicit future decision.

## Migration, compatibility and rollback

Migration is forward-only, resumable and non-destructive:

1. Keep dual reader for legacy embedded v1/v2 and separately stored v3
   manifests; add explicit v4 read/write without changing the old branches.
2. Inventory legacy revisions from D1 in bounded pages; create Space-scoped R2
   objects/manifests, verifying exact digest/size without changing HEAD.
   Global legacy Markdown `canonical/sha256/*` is copied per reachable Space;
   existing Space-scoped BundleFile objects are verified/reused rather than
   rewritten. Embedded v1/v2 manifest bytes retain their original digest.
3. Record backfill checkpoint and shadow-compare exact materialization,
   retained usage and representative historical reads.
4. Existing v3 delta revisions stay valid. MD-304 enabled v4 writes after
   verifying arbitrary media, exact 256 MiB streaming and all reachable parent
   objects for a Space; old revisions stay immutable and readable.
5. Reconcile ledger/refcounts from canonical manifests before enabling hard
   admission; until then growth fails closed but reads/deletes continue.
6. Enable import, streaming export and GC in dependency order only after their
   targeted/local gates and exact UAT capacity evidence.

Before the first v3 commit, application rollback may restore the last v2-capable
deployment. After any v3 commit, rollback target must be dual-read/v3-aware;
after any v4 commit it must also be v4-aware. Deploying older code is forbidden.
Operational rollback disables new writes/import jobs and preserves bytes/state;
it never rewrites history or deletes v3/v4 objects. Backfill failures quarantine
only the affected Space for growth and remain resumable.

Post-MVP task sequence is normative: MD-264 contract -> MD-265 delta manifests/commit ->
MD-266 accounting/admission; MD-268 streaming export/cleanup depends on
MD-265; MD-267 import depends on MD-266 and MD-268 plus its existing search/
MCP prerequisites. MD-260 closes only after those children and exact UAT
capacity/import evidence.

## Alternatives rejected

- **Full revision snapshot in D1/R2 on every commit.** Simple, but makes small
  edits O(total corpus) and duplicates immutable history.
- **Global digest namespace across Minds.** Saves more bytes but creates
  privacy and quota-ownership ambiguity.
- **Event-only accounting.** Fast but can drift permanently after failure;
  canonical reconcile is required.
- **One synchronous import/export request.** Violates Worker memory/time and
  makes disconnect recovery ambiguous.
- **Publish batches directly to HEAD.** Exposes partial corpus and breaks one
  immutable revision semantics.
- **Use R2 listing as foreground authority.** Unbounded and race-prone; D1
  references/reservations are the transaction boundary.
- **Automatic AWS fallback.** Changes platform, cost, secrets and release
  boundary without authority; AWS remains post-MVP.

## Required evidence

Repository tests must prove delta bytes read/written on a large synthetic
corpus, deterministic manifests, v1/v2 compatibility, CAS/idempotency races,
shared-digest accounting, reservation failure before/after HEAD, reconcile,
bounded GC/export and import interrupt/resume/cancel/conflict.

UAT evidence для продвижения этого post-MVP slice must join exact Git SHA,
Sites version/deployment and large private
fixture fingerprints; show D1/R2 usage/headroom without content; prove small
delta, restart/redeploy persistence, quota warning/soft/hard behavior, bounded
memory/latency, import resume and final exact search/fetch. Local tests or a
deployment alone are not UAT acceptance. Эти rows не входят в final receipt
Release 0.1.
