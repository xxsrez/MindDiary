# Инкрементальный системный бэкап Mind Diary

Статус: выбранный инженерный контракт MD-444 для MD-443–MD-449, 2026-09-13.
MD-445 содержит опубликованную в UAT серверную реализацию выдачи, но hosted
transport с operator key пока не подтверждён. Ручной локальный CLI MD-446 и
offline restore MD-447 и runner MD-448 реализованы в repository и проверены
синтетически; установка расписания MD-448 ещё не выполнена. Контракт не меняет обычный
пользовательский export и не даёт content MCP административных прав.

## Цель и граница

Одна локальная копия на Mac должна пережить полную потерю Site, D1 и R2.
Она содержит состояние Minds на последней **успешной** фиксированной точке:
аккаунты и identity mapping, Space/handle/metadata, действовавшие на тот
момент memberships и usage modes, все committed revisions и оригинальные
Markdown/opaque bytes. Ревизии сохраняются по исходным ID, parent и HEAD.
Ежедневное обновление передаёт изменившиеся metadata и недостающие объекты;
отсутствие изменений не создаёт полный новый архив. Потеря одного или
нескольких дней допустима, но незавершённая копия никогда не становится
«последней успешной».

Независимость от OpenAI означает, что рядом с копией хранится проверенный
recovery kit: исходный код совместимой версии, lockfile, локальный runtime,
миграции, шаблоны конфигурации без секретов и инструкция. Git SHA или ссылка на
удалённый repository недостаточны. AWS, облачный mirror, PITR, block-level
deduplication и пользовательская коллекция ежедневных snapshots не входят в
эту работу.

## Нынешнее хранение и реестр полноты

`SITES_METADATA_MIGRATIONS` в
`packages/adapter-metadata-sites/src/index.ts` хранит fenced event log,
materialized snapshot/chunks и projection активности. Его `sequence` относится
только к этому adapter: OAuth, locator, search, audit-delivery и upload-intent
таблицы живут в отдельных adapters. Следовательно, существующий
`md_metadata_events` **не является** полным backup feed.
`InMemoryRevisionMetadataStore.exportDurableSnapshot()` v5 содержит логическое
состояние Minds; `InMemoryMcpTokenStore.exportDurableSnapshot()` содержит
верификаторы токенов. R2 adapter хранит canonical bytes под `canonical/`,
`spaces/` и `bundle-files/`, а также временные `staged-bundle-files/` и
`exports/`. Search находится в D1 и производен.

Исполняемый реестр
[`backup-completeness-registry.mjs`](../../scripts/lib/backup-completeness-registry.mjs)
перечисляет **27 D1 tables со всеми обнаруженными columns**, **48 полей
metadata snapshot**, **4 поля token snapshot**, event envelope и **5 R2
prefixes**. `npm run check:backup-completeness` сверяет его с production
DDL, snapshot serializers и R2 namespace constants; новый неописанный столбец,
таблица, поле или prefix блокирует gate. Это статическая проверка известных
adapters. MD-445 дополнительно должна сверять runtime `sqlite_schema` и R2
inventory на exact candidate: динамический SQL/ключ, не выраженный как
статический DDL/prefix, не доказывается этим check.

Политики реестра:

| Policy | Смысл при восстановлении |
|---|---|
| `exact` / `exact_referenced` | Сохранить логическую запись либо byte-exact объект и исходные ID, проверить digest/relations. Для `spaces/` сохраняются только referenced `objects` и `manifests`, не derived `indexes`. |
| `rebuild` | Не переносить physical projection; перестроить из exact records/objects до публикации чтения. |
| `reset` | Не возобновлять очередь, курсор, reservation, промежуточную загрузку или старый retry. |
| `revoke` | Не переносить действующую capability; новый операторский или пользовательский credential выпускается отдельно. |

В snapshot `spaces`, `revisionsById`, principals, external bindings,
KnowledgeSpaces, personal bindings, memberships, per-principal Mind usage,
handles/retired handles и canonical audit events — `exact`. External bindings
являются **данными**, не разрешением аутентификации после restore. Index,
reachability, quota ledger и public catalog — `rebuild`; их прежнее значение
не может переопределить canonical records. Старые idempotency results,
invitations, staging/import/export jobs, cleanup/deletion cursors и
authorization cache — `reset`. Token snapshot, OAuth tables, locator handles,
download grants и legacy write-target grants — `revoke`. Delivery projection
audit events перестраивается из сохранённых canonical audit events.

`md_metadata_events` и physical snapshot tables создаются заново из
проверенного portable state; raw event tail не переносится, поскольку он может
содержать уже удалённые данные и token verifiers. Полная **committed revision
history** при этом сохраняется в `revisionsById` и object closure. Если
неизвестна семантика нового поля, gate отказывает, а не относит его к `reset`
по умолчанию.

## Формат и согласованная точка

`MD-SYSTEM-BACKUP-1` — версионированный portable envelope. Сервер MD-445
передаёт обязательные `captured_at` и `schema_digest` в checkpoint, а также
`schema_digest` в descriptor/manifest. Fingerprint охватывает exact-поля,
фактическую схему D1 и допустимые R2-префиксы; при его смене новая session
становится `rebaseline`. Envelope включает:

- случайный `origin_id`, однажды созданный для данного Site, и монотонную
  `generation`; они не выводятся из URL, email или Git SHA;
- `base_checkpoint` (null для baseline) и `target_checkpoint` с generation,
  монотонным backup sequence, UTC-временем и SHA-256 canonical state;
- fingerprint схемы D1, версии snapshot/manifest и кода recovery kit;
- упорядоченные, ограниченные по размеру страницы `upsert`/`delete` для
  portable records с page index/count, byte length и SHA-256 каждой страницы;
- полный target object inventory по `namespace`, `space_id` где применимо,
  digest, size и media type; это exact reachable closure всех revisions;
- digest manifest, счётчики записей/байтов и expiry server session.

Canonical JSON сериализуется детерминированно UTF-8; digest считается по
точным байтам. Ключ portable record — JSON-пара `[field, id]`, без NUL в
SQLite TEXT. Повтор страницы с тем же session/cursor возвращает те же bytes,
index и digest. Числовой cursor действует только внутри выбранной session:
`session_id` вместе с operator credential привязывает его к `origin`,
`generation`, `base` и `target`. Он не пропускает страницу и не действует после
истечения срока. Part большого объекта адресуется проверяемыми offset/length;
сервер отдаёт не больше bounded part, клиент проверяет весь объект по size и
SHA-256 перед его публикацией. Ни страницы, ни original bytes не идут через
JSON-RPC MCP.

Новый dedicated backup sequence должен охватывать **каждую** mutation exact
логического состояния в той же D1 transaction, что и эту mutation. Только
metadata adapter event sequence недостаточен. Для изменения, которое нельзя
атомарно связать с backup sequence, сервер отказывает в инкрементальной выдаче
и требует полную сверку metadata. Baseline/full reconciliation читает metadata
страницами с фиксированного target, не требует повторного скачивания уже
проверенных content-addressed objects. Stale base, другая generation, gap,
неизвестный schema fingerprint или digest mismatch не дают false complete:
клиент начинает полную сверку metadata с прежней безопасной локальной копией.

Текущая классификация durable surfaces допускает один источник exact логического
состояния: metadata snapshot; OAuth, locator, search, audit-delivery и upload
intent не восстанавливаются как exact. Это проверяется реестром, а не
предполагается для будущих adapters. Сервер фиксирует immutable target из
одного snapshot вместе с его event sequence, затем публикует backup session
через D1 CAS на том же sequence. Каждый успешный metadata append одновременно
продвигает отдельный backup sequence. Страницы готовой session не читают
изменяющееся live состояние. Server-side пересчёт полного metadata snapshot
допустим; по сети при обычном обновлении идут только изменённые records и
отсутствующие у локального клиента objects. Полнота большого snapshot в памяти
пока ограничена действующей in-memory архитектурой metadata adapter и не
считается доказательством bounded server-memory.
`spaces` передаёт HEAD без дублирования всех envelopes: `revisionsById`
содержит каждую committed revision отдельно, а per-Space revisions map
восстанавливается из неё. Это сохраняет историю и не заставляет каждое новое
изменение повторно передавать прежние manifest-ы.

Перед публикацией checkpoint сервер фиксирует target D1 state и object closure
атомарно относительно metadata mutations. Canonical R2 bytes должны быть
записаны и проверены до D1 reference. Session удерживает referenced objects от
ordinary GC конечной, возобновляемой lease (предлагаемый предел жизни одной
точки — 7 суток). GC и прямое whole-Mind/account deletion проверяют lease и
target generation. Удаление данных не откладывается бессрочно ради бэкапа:
если оно пересекает активную session, session инвалидируется и клиент
отбрасывает неполный target. После expiry, explicit release либо invalidation
pin снимается; повторный запрос на старую session fail closed. Неизвестная
reachability или deletion state запрещает выдачу complete.

Сервер хранит завершённую точку и её record digests до 30 суток для
инкрементального сравнения. При следующем создании session один устаревший
server checkpoint вместе со страницами и inventory удаляется; если Mac
пришёл с уже удалённой base, сервер выдаёт `rebaseline` вместо ложной дельты.
Локально подтверждённая копия от этого удаления не зависит.

Первый server adapter использует грубый глобальный pin: пока есть building или
ready session, физический canonical GC не начинает новый проход. Любая уже
начатая операция удаления регистрируется в D1 до R2 и должна завершиться до
создания session; при неизвестном исходе новых sessions нет. Whole-Mind/account
deletion имеет приоритет и инвалидирует все активные sessions в том же D1
коммите, который удаляет exact metadata, до физической очистки R2. Последний
скачанный part не означает успешный backup: только отдельный completion CAS
по status, epoch и expiry выдаёт receipt, после которого локальный клиент может
продвинуть checkpoint. Уже выданные bytes нельзя отозвать, но удаление до
completion не может дать успешный receipt. Удаление после receipt относится к
более позднему состоянию, которое попадёт в следующий checkpoint.

Полная потеря Site после последнего checkpoint неизбежно оставляет локальную
копию старее: в ней могут быть данные, удалённые **после** этого checkpoint.
Без связи с потерянным Site нельзя доказать обратное. Поэтому offline restore
всегда начинается в изолированном, только локальном operator-only режиме;
старые users/ACL не получают доступ автоматически. Перед любым будущим
открытием другим людям владелец должен проверить удаления и заново подтвердить
identity/access. Новые удаления после успешного следующего backup удаляют
соответствующие logical records и делают прежние objects кандидатами локального
GC, а не стирают committed историю оставшихся Minds.

## Локальное применение и восстановление

Mac хранит одну transactional catalog database, immutable objects по digest,
staging и recovery kit. Только один writer может обновлять каталог. Клиент
сначала проверяет origin/base/format/schema; скачивает и fsync-ит недостающие
parts во временные файлы; сверяет object inventory и все page/root digests;
лишь затем одной durable transaction переключает `current_checkpoint`.
Старый checkpoint и его bytes не удаляются до подтверждённого commit. Отдельный
идемпотентный GC удаляет только объекты, не нужные current или pending run.
После crash, disk-full, network failure либо повторного запуска статус
показывает последний успешный checkpoint и отдельно pending/error; initial
baseline до commit не считается recoverable.

Offline restore принимает только полный, проверенный checkpoint и совместимый
kit. Он валидирует schema/format, counts, digests, уникальность ID,
parent/HEAD, membership/owner invariants и всю referenced object closure до
изменения target. Затем в пустом локальном storage атомарно создаёт логическое
состояние с исходными identity/revisions, перестраивает search/index,
reachability/quota/catalog и сбрасывает operational queues. Restore повторяем:
один и тот же checkpoint не создаёт дубли. Старые OAuth/personal tokens,
sessions, invitation links, download URLs и operator credentials не действуют.
Доступ к восстановленному сервису первоначально имеет только новый локальный
оператор через loopback; публикация наружу не входит в этот contract.

Backup bytes содержат чувствительные данные. Каталог Mac доступен только
владельцу; runner не пишет bytes, paths, object keys, emails, secrets или raw
manifest в logs/Task Manager. Credential для unattended чтения всех Minds —
отдельная least-privilege read-only operator capability с явной выдачей и
отзывом. Существующий content MCP token не повышается до cross-user export.
Конкретная выдача реального credential и установка на пользовательский Mac
требуют соблюдения границ доступа и секретов; синтетический UAT test их не
подменяет.

## Evidence для следующих задач

MD-445 проверяет fixed-target pages/parts, update/delete/GC races, expiry,
generation mismatch, repeat и synthetic UAT transport. MD-446 доказывает
delta-only transfer, bounded memory, fsync/transaction ordering и fault
injection. MD-447 поднимает чистый локальный target без Site/network и сверяет
все fixture Minds/revisions/bytes: repository test использует три Minds,
четыре ревизии и opaque bytes; отдельный kit содержит Node runtime, Git archive
точного SHA с lockfile/миграциями и автономный CLI. MD-448 подтверждает реальный macOS runner,
catch-up и last-success status. MD-449 соединяет эти доказательства в один
source-bound drill. До этих receipts данный контракт не является обещанием
работающего бэкапа.
