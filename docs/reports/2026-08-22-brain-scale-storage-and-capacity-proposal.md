# Поддержка Brain-масштаба в Mind Diary: storage и capacity proposal

Статус документа: `report + proposal`.

- `normative_status`: `proposal`;
- `implementation_status`: текущий Sites vertical slice реализован частично,
  предложенная scale-архитектура не реализована;
- repository artifact: `cf50d865cef0cf232817be511fe444d4fde2e8cc`;
- live/task/storage evidence наблюдалось 2026-08-22 по времени
  `Atlantic/Madeira`;
- scope: анализ и планирование, без изменения product behavior, данных Minds,
  Task Manager и deployment.

## Решение в одном абзаце

Сам объём текущего Brain — около `589.9 MB` — не требует немедленного ухода с
OpenAI Sites: canonical bytes и будущие вложения должны лежать в R2, для
которого Sites не публикует фиксированный storage limit. Но текущую реализацию
Mind Diary нельзя считать готовой ни к полному Brain, ни к нескольким таким
Minds. Сегодня продукт принимает только Markdown; D1 имеет лимит `10 GB` на
Site, а текущий search adapter повторно сохраняет полный текст каждого Mind для
каждой immutable revision. Дополнительно metadata adapter перечитывает весь
глобальный event log на каждом запросе, commit и index/export материализуют весь
Mind в память, а import workflow отсутствует. Поэтому правильный следующий шаг
— не AWS migration и не полный перенос Brain, а устранение reliability и hot
path defects, переход к нормализованным D1 projections и delta-aware revisions,
после чего — контролируемый Markdown-only import на синтетическом или
privacy-reviewed corpus. Полный Brain требует также BundleFile, streaming
export, quotas и отдельного privacy/residency решения.

## 1. Что именно проверено

### 1.1. Платформа Sites

По официальной документации OpenAI Sites, наблюдавшейся 2026-08-22:

- Sites находится в public beta, а plan-specific usage limits общие для всех
  Sites пользователя;
- один Site получает до `10 GB` D1;
- для R2 не указан фиксированный storage limit;
- D1 предназначен для structured durable data, R2 — для файлов;
- на launch нет data residency или inference residency, включая D1, R2, logs и
  artifacts;
- Sites не следует использовать для PHI и payment-card data;
- hosting audience и sign-in внутри приложения — разные access boundaries.

Источник: [OpenAI Sites](https://learn.chatgpt.com/docs/sites).

Read-only live inspection текущего Mind Diary UAT подтвердил:

- Site активен, текущий hosting access mode — `public`, а содержимое продукта
  отдельно защищено его authenticated application flow;
- подключены D1 binding `DB` и R2 binding `MIND_DIARY_BUCKET`;
- live D1 содержит, в частности, `md_metadata_events` и
  `md_exact_revision_search`, то есть deployed schema совпадает с исследуемыми
  hot paths;
- Sites connector показывает schema, но не предоставляет безопасный агрегат
  фактических D1/R2 bytes. Поэтому текущее физическое потребление UAT не
  подтверждено и не должно называться измеренным.

Мы сознательно не читали live table rows для оценки размера: это раскрыло бы
private content и всё равно не дало бы надёжный storage total.

### 1.2. Реальный профиль Brain

Read-only `rclone size` вернул `3,504` файла и `589,868,461` bytes:
`589.9 MB`, или `562.5 MiB`. Канонический Markdown-срез без `.agents/`,
`output/` и `tmp/` содержит `1,741` файл и `5,681,704` bytes (`5.42 MiB`),
то есть только `0.96%` полного объёма. Максимальный канонический Markdown-файл
— `432,578` bytes.

Крупнейшие форматы показывают, почему «полгигабайта Brain» и «полгигабайта
Markdown» — разные workloads:

| Формат | Файлы | Bytes | Роль в текущем продукте |
|---|---:|---:|---|
| ZIP | 8 | 174,525,938 | не поддерживается как import/canonical content |
| PDF | 318 | 153,843,451 | будущий `BundleFile`; text extraction отдельно |
| PNG | 89 | 100,346,430 | будущий `BundleFile` |
| JPG | 134 | 56,669,204 | будущий `BundleFile` |
| JSONL | 18 | 25,399,061 | не является текущим Markdown content |
| HEIC | 7 | 19,678,697 | будущий `BundleFile` |
| JSON | 24 | 11,018,670 | нужен отдельный import/profile decision |
| JPEG | 58 | 10,244,979 | будущий `BundleFile` |
| TXT | 920 | 8,015,804 | не входит в текущий OKF Markdown profile |
| Канонический Markdown | 1,741 | 5,681,704 | численно укладывается в текущий MVP profile |

Текущие hard limits в
[changeset preflight](../../packages/application-content/src/changeset-preflight.ts)
— `100` operations, `1 MiB` на Markdown-файл, `10,000` resulting files и
`64 MiB` на resulting Markdown bundle. Следовательно, текущий канонический
Markdown Brain укладывается в file/count/bundle limits, но его нельзя записать
одним changeset: требуется не менее `18` commits, фактически больше с учётом
`index.md` и `log.md`. Пользователь явно разрешил последовательные immutable
revisions; отсутствие whole-import atomicity блокером не является.

### 1.3. Эксперимент из соседней сессии

Bounded pilot перенёс четыре privacy-minimized Markdown records в private Mind:
получилась revision из шести файлов и `7,322` bytes. История, полная OKF 0.2
validation, eventual search readiness, manifest hashes и точечный fetch прошли.
Это полезное положительное доказательство semantics, но не capacity proof.

Эксперимент обнаружил два дополнительных contract defects:

1. MCP schema рекламирует optional `expected_sha256` для `replace_index`, но
   первый вызов с этим полем был отвергнут сервером как
   `replace_index fields are invalid`. Повтор без поля прошёл. В текущем
   repository source поле поддерживается и MCP schema, и preflight-кодом;
   значит, наблюдение указывает на deployed/package/runtime skew, который
   нужно закрыть exact-client conformance test, а не только локальным unit test.
2. Opaque entry IDs для трёх длинных путей имели `543–552` characters, тогда
   как MCP `fetch` schema ограничивает ID `512` characters. Browse и search
   успешно выдали ID, который тот же connector отказался принимать. Это
   нарушение producer/consumer contract и прямой blocker для надёжного
   migration read-back.

Эти два дефекта ещё не представлены отдельными tasks в актуальном Task Manager
snapshot. Они включены ниже в предлагаемый backlog. Source-side repair текущего
Brain пользователь берёт на себя, поэтому он также не считается blocker-ом
Mind Diary.

### 1.4. Актуальные задачи и timings

Task Manager уже содержит важный набор работ:

- `MD-251` — initial Personal/ordinary revision не получает index job;
- `MD-252` — queued/failed/abandoned index jobs не подбираются автоматически;
- `MD-253` — search readiness не видна клиенту;
- `MD-254` — metadata event log полностью проигрывается на каждом request;
- `MD-255` — Product Site runtime создаётся заново на каждый request;
- `MD-256` — MCP выполняет discovery/authorization дважды;
- `MD-257` — list/browse/web имеют serial N+1 reads;
- `MD-258` — отсутствуют stage telemetry и blocking performance gate;
- `MD-245`–`MD-250` — planned versioned `BundleFile` surface;
- `MD-228`–`MD-235` — multiple-read/single-write Mind bindings.

Зафиксированные в `MD-254` UAT timings на candidate `cf50d865` уже плохи на
маленьком corpus:

| Operation | Наблюдавшийся диапазон |
|---|---:|
| `list_minds` | 10.2–13.8 s |
| `browse_entries` | 19.7–22.4 s |
| `search` | 20.2–22.8 s |
| locator-bound `fetch` | 2.4–2.6 s |

Это означает, что перед Brain-scale import нужен architecture fix, а не
простое увеличение quota.

## 2. Где именно возникает amplification

### 2.1. R2 canonical storage: хорошая основа, но hot write path не delta-aware

[Sites object adapter](../../packages/adapter-object-sites/src/index.ts)
хранит Markdown content-addressed по `canonical/sha256/<digest>`. Одинаковые
bytes физически дедуплицируются на уровне Site, а revisions ссылаются на digest.
Это правильная основа и для будущих `BundleFile`.

Но [changeset commit](../../packages/application-content/src/changeset-commit.ts)
после любой маленькой правки проходит по всем `candidateFiles` и вызывает
`putImmutable` для каждого. Для уже существующего digest R2 adapter сначала
читает весь object и повторно сравнивает bytes. Перед этим preflight через
`readHeadRevision` материализует весь HEAD и валидирует весь resulting bundle.

Для импорта `1,741` Markdown-файла идеальными пакетами по `100` operations это
около `17,041` cumulative file passes только на commit path, ещё до отдельных
index jobs. При обычной дальнейшей истории каждая маленькая revision остаётся
`O(number of files + corpus bytes)`.

### 2.2. D1 metadata: глобальный replay и полные manifests в событиях

[Sites metadata adapter](../../packages/adapter-metadata-sites/src/index.ts)
перед каждым чтением или mutation выбирает все rows из `md_metadata_events` с
sequence `1`, создаёт in-memory stores и проигрывает события заново. Event
payload `commitRevision` несёт полный revision envelope и manifest. Поэтому:

- latency растёт с суммарной историей всего Site, а не только выбранного Mind;
- один большой или активный Mind ухудшает запросы всех остальных;
- runtime reuse (`MD-255`) уменьшит initialization overhead, но сам по себе не
  исправит forced refresh/full replay;
- несколько Minds делают current global event-sourcing hot path особенно
  опасным.

`MD-254` правильно предлагает materialized D1 read model или snapshot+tail.
Для Brain scale рекомендуется полноценный нормализованный read/write model;
event log следует оставить для audit/recovery, а не для каждого user request.

### 2.3. D1 search: полный текст каждой revision

[Sites search adapter](../../packages/adapter-search-sites/src/index.ts)
сериализует все `{path,text}` exact revision в один `documents_json` и хранит
одну такую копию для каждой пары `(space_id, revision_id)`. Search затем читает
и парсит весь JSON, а
[application search](../../packages/application-content/src/mind-search.ts)
ранжирует все документы в JavaScript.

Нижняя граница объёма только текста, без JSON/SQLite/index overhead:

| Workload | Повторно сохранённый текст в D1 |
|---|---:|
| 1 Brain-sized Markdown Mind × 10 revisions | 56.8 MB |
| 1 Mind × 100 revisions | 568.2 MB |
| 1 Mind × 1,000 revisions | 5.68 GB |
| 10 Minds × 100 revisions | 5.68 GB |
| 100 Minds × 100 revisions | 56.8 GB |

При D1 limit `10 GB` последний сценарий невозможен, а предпоследний оставляет
слишком мало места для metadata, auth, jobs, audit и storage overhead. Кроме
того, неизвестные через Sites ограничения row/bind/query/runtime могут
сработать значительно раньше; отдельного live large-row probe пока нет.

Индекс должен хранить parsed/extracted document один раз по content digest, а
revision — только membership/projection или дельту. Неизменённый Markdown не
должен повторно занимать D1 на каждой revision.

### 2.4. Index jobs: durable state есть, durable execution нет

[RevisionIndexJobHandler](../../packages/application-background/src/index.ts)
умеет claim, lease, fail и retry timestamp, но worker запускает exact job через
`waitUntil` только как эффект текущего request. Scheduler/reconciler, который
подберёт пропущенный initial job, expired lease или failed job, отсутствует.
Это подтверждено `MD-251` и `MD-252`.

Сам job снова материализует весь revision в память и записывает весь текст в
один D1 JSON row. При Brain-scale corpus reliability и capacity здесь связаны:
долгий job чаще переживает request/isolate boundary, а повтор снова читает весь
corpus.

### 2.5. Browse, discovery и locator

[Mind discovery](../../packages/application-content/src/mind-discovery.ts)
последовательно разрешает каждый membership Mind и весь public catalog.
[Mind browse](../../packages/application-content/src/mind-browse.ts)
последовательно читает каждый object на странице, а web/MCP повторяют части
authorization. `MD-255`–`MD-257` покрывают эти hot paths.

Текущий locator self-contains полный path. При path limit `1,024` bytes
невозможно гарантировать, что base64/signature envelope поместится в generic
`512`-character ID schema. Простое увеличение лимита — временный fix. Надёжный
contract должен использовать compact entry ordinal/path digest + exact
revision/manifest binding либо server-side opaque locator record.

### 2.6. Export и memory pressure

[Revision materialization](../../packages/application-content/src/index.ts)
последовательно загружает bytes каждого файла и держит весь revision в памяти.
[Deterministic export](../../packages/application-content/src/deterministic-export.ts)
создаёт ещё один полный массив ZIP bytes, после чего R2 adapter принимает ещё
один `Uint8Array`. Реальный peak превышает размер corpus и масштабируется с ним.

Для `5.68 MB` Markdown это терпимо. Для полного Brain порядка `590 MB` такая
схема неприемлема даже после появления BundleFile. Large export должен быть
streaming/chunked напрямую в object storage с incremental digest, bounded
buffer и финальным atomic publication объекта.

### 2.7. GC, deletion и exports делают глобальные R2 scans

Текущий GC строит set всех reachable digests из всех revisions, а R2 adapter
перечисляет весь `canonical/` namespace. Export cleanup перечисляет весь
`exports/` prefix и фильтрует в памяти. Это допустимо для UAT, но не даёт
предсказуемой latency при множестве Minds. Нужны indexed ownership/reference
records, bounded pages и asynchronous deletion/GC jobs.

### 2.8. Privacy и residency — отдельный blocker полного Brain

Brain содержит private, family и health-adjacent records. Текущий Sites UAT
имеет public hosting audience, хотя application content требует sign-in. Это не
равно anonymous content access, но и не является достаточным production proof
для полного private corpus. У Sites нет data residency на launch, а PHI прямо
исключён официальной документацией.

До отдельного решения запрещено использовать полный Brain или медицинские/
health-adjacent records как UAT load fixture. Capacity testing должно идти на
synthetic corpus с тем же распределением размеров, path depth и revisions либо
на явно privacy-reviewed non-sensitive subset.

## 3. Целевая архитектура

### 3.1. Разделение canonical, transactional и derived state

```text
bounded/resumable import
        │
        ▼
R2 staging/quarantine ──hash verify──► R2 objects/sha256
        │                                      │
        └──────── import checkpoints           ▼
                                      immutable manifest object
                                                │
                                                ▼
                              D1 revision row + CAS HEAD
                                                │
                                   durable index/outbox job
                                                ▼
                              derived search/read projections
```

Рекомендуемое распределение:

| State | Storage | Правило |
|---|---|---|
| principals, spaces, membership, ACL, HEAD | D1 normalized tables | indexed point/batch reads; никаких full replays |
| revision identity, parent, manifest hash | D1 | малая transactional row, CAS вместе с HEAD |
| immutable manifest | R2 по manifest digest | exact historical representation; path/digest/size/media type |
| current HEAD entry projection | D1 | быстрый browse/path lookup, rebuildable из manifest |
| Markdown и BundleFile bytes | R2 по content digest | upload только новых digest; неизменённые bytes не перечитываются при commit |
| jobs, leases, retry, checkpoints, quotas | D1 | durable reconciler и bounded claims |
| parsed/search document | derived store по content digest | один раз на уникальный Markdown object |
| revision search membership | derived projection/delta | не копировать полный text на revision |
| export archive | R2 | streaming build, TTL и indexed cleanup |
| audit/event history | D1/R2 append-only | recovery/audit, но не hot read model |

Начальный Sites-compatible вариант может хранить полный immutable manifest
каждой revision в R2. Если manifest history станет значимой долей storage,
следующий шаг — persistent Merkle tree или chunked manifest со structural
sharing. Не следует начинать с этого усложнения без benchmark.

### 3.2. Commit path должен стать delta-aware

Commit получает exact parent manifest и operations и должен:

1. проверять authorization/idempotency/HEAD CAS как сейчас;
2. загружать и хешировать только новые или изменённые bytes;
3. переиспользовать parent manifest entries для неизменённых paths без R2 GET;
4. построить новый immutable manifest;
5. выполнить D1 transaction: revision pointer, HEAD CAS, jobs и accounting;
6. валидировать изменённые documents по digest cache, а bundle-wide invariants
   — по manifest/frontmatter projection; при невозможности сохранить текущий
   synchronous invariant нужен отдельный accepted contract, а не silent
   ослабление validation.

Целевой cost маленькой правки: `O(changed bytes + changed paths)`, а не
`O(full Mind)`.

### 3.3. Search storage и historical policy

Минимальная модель:

- `search_documents(content_digest, parsed fields, extractor_version, ...)`;
- HEAD/revision membership ссылается на digest, но не содержит полный text;
- query выполняется storage-side через bounded lexical index, а не загружает
  весь corpus в JavaScript;
- новый extractor/index version создаёт rebuildable projection;
- HEAD index всегда materialized;
- exact historical search либо materialized по demand и кэшируется, либо
  строится из digest documents по revision manifest. Выбранная latency/retention
  semantics должна быть явно добавлена в API specification.

Необходимо сравнить Sites-compatible D1 lexical implementation и post-MVP
search adapter на одном benchmark. OpenSearch не следует вводить автоматически:
он оправдан только после доказанного query/scale требования.

### 3.4. Resumable import вместо одного огромного changeset

Предлагаемый workflow:

1. `plan_import`: client строит privacy-reviewed manifest, размеры, digests,
   media types и desired paths; server возвращает admission decision.
2. `stage`: только отсутствующие digests загружаются bounded chunks; staged
   bytes имеют TTL и не видны ни одной revision.
3. `validate`: paths, UTF-8/OKF, file policy, declared/actual MIME, archive
   safety и quota проверяются до bind.
4. `commit_batch`: до `N` files связываются с новой immutable revision;
   checkpoint хранит manifest cursor и committed revision. Whole-import
   atomicity не требуется.
5. `reconcile/resume`: повтор с тем же import ID не создаёт дубликаты и
   продолжает с последнего verified checkpoint.
6. `finalize`: exact HEAD, file count, total bytes, manifest digest, full OKF
   validation и index readiness проверяются read-back-ом.
7. `cleanup`: orphan staging удаляется bounded TTL job.

Для текущего Markdown-only этапа transport может оставаться batched
`commit_changeset`, но orchestration/checkpoints должны быть отдельным client
workflow. Полный ZIP import и native file upload начинаются только после
принятия `BundleFile` contract и security boundary.

### 3.5. Durable jobs и fairness

`MD-251`–`MD-253` следует расширить до общего job execution contract:

- initial revisions атомарно создают index state/job;
- request-triggered scheduling остаётся fast path;
- bounded reconciler подбирает `queued`, retryable `failed` и expired leases;
- если Sites не предоставляет периодический trigger, нужны opportunistic drain
  на requests/runtime start плюс explicit operator/backfill command; это
  ограничение должно быть отражено в readiness/SLO;
- claims имеют max attempts, exponential backoff + jitter и terminal state;
- очередь partitioned по `space_id`; один большой Mind не занимает все slots;
- на один Mind действуют max in-flight jobs и per-import concurrency;
- readiness API показывает `missing | queued | running | ready | failed`,
  attempts, safe failure code и retryability без content leakage.

### 3.6. Capacity accounting и admission control

Нужно считать разные величины, а не один «размер Mind»:

| Metric | Зачем |
|---|---|
| `logical_head_bytes` / files | user-visible текущий corpus |
| `unique_object_bytes` | реальное canonical R2 потребление |
| `history_manifest_bytes` / revisions | рост immutable history |
| `search_index_bytes` | главный D1 capacity risk |
| `staged_bytes` | незавершённые imports/uploads |
| `export_bytes` | временные R2 archives |
| `queued_job_count` и oldest age | backpressure/readiness |
| D1/R2 site totals и growth rate | system admission и AWS trigger |

Quota policy должна иметь:

- per-file, per-import, per-Mind и site-wide limits;
- soft warning, hard admission limit и минимум `30%` operational headroom;
- preflight, который оценивает **incremental physical** и logical growth до
  upload/commit;
- отдельные budgets для current content, history, derived index, staging и
  exports;
- конфигурируемые значения, а не product constants в domain core;
- privacy-safe usage UI/telemetry без paths, titles и content.

Финальные числовые quotas нельзя выбирать только из Sites maxima. Сначала
нужно пройти capacity matrix ниже. Текущий Brain следует использовать как
нижний target profile: `1,741` Markdown files / `5.68 MB` text и, после
BundleFile, `590 MB` latest logical corpus.

## 4. Что произойдёт с несколькими Minds

Если каждый Mind имеет размер текущего полного Brain, latest canonical bytes в
R2 без учёта deduplication составят:

| Minds | Latest raw bytes |
|---:|---:|
| 1 | 0.590 GB |
| 10 | 5.90 GB |
| 100 | 59.0 GB |

Это не противоречит опубликованному R2 limit, потому что фиксированный limit не
указан. Но plan usage, cost и fair-use остаются внешними ограничениями, а
actual UAT usage сейчас не измерим через connector.

Главная проблема current design — не R2 raw bytes:

- D1 search растёт как `Minds × revisions × full Markdown text`;
- global metadata replay растёт от общей активности всех Minds;
- `list_minds` и public catalog имеют N+1 behavior;
- index/export/GC jobs конкурируют без per-Mind fairness;
- один большой import создаёт noisy-neighbor effect для других пользователей.

После предлагаемого разделения одинаковые content bytes хранятся один раз,
неизменённый document индексируется один раз, а metadata и jobs выбираются по
конкретному principal/space. Тогда несколько Minds увеличивают storage и load
примерно по реальным дельтам, а не по произведению всей истории.

## 5. Поэтапный план

### Фаза 0 — запретить дальнейшее накопление технического долга

До следующего Brain-scale pilot:

1. закрыть `MD-251`, `MD-252`, `MD-253`;
2. закрыть `MD-254` и убрать full replay из hot path;
3. закрыть `MD-255`–`MD-257`;
4. реализовать `MD-258` и получить baseline на exact deployed artifact;
5. исправить `replace_index.expected_sha256` contract skew;
6. исправить producer/consumer locator length contract;
7. добавить synthetic Brain-shaped fixture и privacy classification gate.

Результат фазы: маленькая новая revision гарантированно становится searchable,
нет stranded jobs, а warm read operations укладываются в performance budget.

### Фаза 1 — scale-safe Sites persistence

1. Зафиксировать accepted ADR: normalized D1 read/write model, R2 revision
   manifests, digest-level search documents и migration strategy.
2. Создать schema v2 рядом с текущими event/search tables.
3. Backfill materialized state и manifest/search projections idempotently.
4. Ввести dual-read verification, затем bounded dual-write.
5. Сравнивать old/new reads и counts без private payload в logs.
6. Переключить reads, сохранить rollback window, затем убрать старый hot path.
7. Не удалять legacy rows до export/restore и reconciliation evidence.

### Фаза 2 — Markdown-only Brain import

1. Реализовать resumable client/import job и checkpoints.
2. Пройти synthetic profile `1,741 files / 5.68 MB`.
3. Провести privacy review реального subset; не использовать medical/
   health-adjacent content.
4. Импортировать несколько batches в отдельный private Mind.
5. Проверить exact paths/count/bytes/hashes, history, OKF validation, index
   readiness и deterministic export.

### Фаза 3 — полный file-shaped Brain

Выполнить `MD-245`–`MD-250` и дополнить их:

- staging/quarantine TTL и admission control;
- streaming upload/download/export;
- content-addressed BundleFile bytes и revision binding;
- MIME sniffing, allow/deny policy, archive-bomb limits, malware decision;
- deterministic export profile для mixed Markdown/files;
- deletion, reference accounting и orphan GC;
- load proof на `590 MB` synthetic corpus.

OCR, transcription, preview generation и semantic/vector indexing не должны
входить в эту фазу автоматически. Это отдельные derived jobs и privacy/cost
decisions.

### Фаза 4 — multi-Mind capacity и production decision

1. Пройти 1/10/100-Mind matrix и noisy-neighbor tests.
2. Ввести per-Mind fairness, quotas и operator capacity view.
3. Принять hosting audience, residency, backup/RPO/RTO и sensitive-data
   policy для production.
4. Оценить Sites economics и operational ceiling по реальному росту.
5. Только после этого принимать решение о production target.

### Фаза 5 — AWS только по измеримому trigger

Размер одного Brain в `590 MB` сам по себе не является trigger. Переход на
planned S3/DynamoDB/OpenSearch adapters оправдан, если выполняется хотя бы одно:

- D1 capacity после оптимизации устойчиво проходит warning threshold или
  forecast исчерпывает headroom;
- Sites не даёт нужного durable scheduler, streaming transport или operational
  visibility;
- production требует data residency/compliance, которой у Sites нет;
- multi-tenant load не удаётся изолировать в Sites runtime;
- measured cost/latency хуже AWS target на одинаковом workload.

Domain/application ports должны позволить такой переход, но AWS SDK не должен
попадать в domain core.

## 6. Capacity и acceptance gates

### 6.1. Fixtures

Нужны полностью synthetic, deterministic fixtures:

- `brain-md-1x`: 1,741 Markdown files, 5.68 MB, реальные size/path-depth
  distribution, несколько paths, порождающих >512-character старые locators;
- `brain-md-history`: 1, 20, 100 и 1,000 revisions с 1–5% changed files;
- `brain-assets-1x`: после BundleFile — 590 MB mix PDF/images/archives без
  private bytes;
- `minds-10x`: десять corpus Minds с controlled shared/unique digest ratio;
- `minds-100x`: metadata/list/fairness workload; полный 59 GB upload для него не
  требуется, пока storage throughput не является целью теста.

### 6.2. Latency gates

Использовать предложенный `MD-258` baseline:

- server p95: `list_minds`, `browse_entries`, `search` ≤ `2 s`;
- server p95 `fetch` ≤ `1 s`;
- installed connector read p95 ≤ `5 s`;
- authenticated home TTFB ≤ `3 s`, cold path ≤ `5 s`;
- увеличение event/history volume в `10×` ухудшает point-read p95 не более чем
  на `20%`;
- не менее `20` warm samples плюс отдельный cold sample на exact SHA/deployment.

### 6.3. Reliability gates

- initial и committed revision всегда создают observable index state;
- forced dropped scheduling, expired lease и two injected failures сходятся в
  `ready` после bounded reconcile; через `10 min` нет stranded retryable jobs;
- resume import не дублирует objects или logical files и не пропускает batch;
- повторный finalize возвращает тот же manifest/result;
- full exact read-back совпадает по file count, bytes и SHA-256;
- search/browse не выпускают token, который fetch schema не принимает;
- connector-advertised optional fields проходят exact deployed client/server
  conformance.

### 6.4. Storage-amplification gates

- `100` revisions с неизменённым corpus не добавляют `100×` Markdown text в
  D1;
- no-op/small revisions не копируют canonical R2 payload bytes;
- physical R2 growth объясняется новыми unique digests, manifests, staging и
  exports отдельно;
- D1 остаётся минимум с `30%` headroom после target matrix;
- import admission отказывает до upload, если predicted hard quota превышена;
- staging/export TTL cleanup bounded и не делает global namespace scan;
- peak memory зависит от configured batch/chunk, а не от полного corpus/export.

### 6.5. Security gates

- capacity evidence не содержит paths, titles, snippets, tokens, URLs или
  private bytes;
- каждый object/browse/search/import/export сначала проверяет current access;
- staged object не становится читаемым до revision commit;
- public hosting audience не интерпретируется как разрешение anonymous content;
- health-adjacent/medical corpus не попадает в Sites UAT;
- restore/deletion/retention и backup evidence проверены до production.

## 7. Backlog: что уже покрыто и чего не хватает

| Surface | Existing tasks | Gap |
|---|---|---|
| index reliability/readiness | `MD-251`–`MD-253` | добавить durable reconcile/SLO на Brain-shaped corpus |
| metadata/runtime/read latency | `MD-254`–`MD-258` | связать с schema v2 и 1/10/100 capacity matrix |
| non-Markdown files | `MD-245`–`MD-250` | streaming, import, accounting и large-corpus gate |
| multiple Minds/bindings | `MD-228`–`MD-235` | bindings не решают storage isolation, fairness или cross-Mind capacity |
| deployed contract skew | нет отдельной задачи | `replace_index.expected_sha256` exact-client conformance |
| locator size | нет отдельной задачи | compact/fixed-budget locator contract |
| revision/search amplification | нет отдельной задачи | digest-level index + R2 manifests + delta-aware commit |
| bulk import | нет отдельной задачи | resumable plan/stage/commit/finalize workflow |
| capacity accounting | нет отдельной задачи | quotas, admission, usage UI, site headroom |
| large export | частично `MD-249` | streaming builder/write/download and memory gate |
| GC/noisy neighbor | нет отдельной задачи | indexed cleanup, per-Mind queue fairness |
| privacy/residency | нет Brain-specific task | data classification и production go/no-go |

Рекомендуется создать один parent epic `Brain-scale storage and import` с
отдельными задачами по этим gaps после принятия направления. В рамках этого
report задачи намеренно не создавались и существующие статусы не менялись.

## 8. Открытые решения

До реализации нужно явно выбрать:

1. Всегда ли exact historical search должен быть немедленно materialized или
   допустим bounded on-demand rebuild/cache?
2. Хранить ли revision manifest целиком в R2 или сразу вводить structural
   sharing?
3. Как считать quota при cross-Mind physical deduplication, не раскрывая факт
   существования чужого digest?
4. Какие file types и max sizes входят в первый BundleFile profile?
5. Нужны ли encryption controls сверх provider-managed storage и какой
   production residency/compliance profile обязателен?
6. Какой Sites mechanism будет гарантированно запускать reconciler при
   отсутствии user traffic?
7. Какие warning/hard thresholds и paid plan economics подтверждаются после
   capacity run?

## Итоговая рекомендация

На текущем UAT допустим только ограниченный, privacy-reviewed Markdown pilot
после устранения P0 defects. Полный Brain сейчас переносить не следует:
`~584 MB` его текущего объёма не поддерживаются content model, а current D1 и
hot paths не выдерживают безопасного роста revisions/Minds. При этом не нужно
сразу уходить в AWS. Если D1 хранит только transactional metadata и компактные
derived projections, а R2 — unique canonical bytes/manifests/exports, один
Brain и несколько таких Minds являются реалистичным Sites workload. Это нужно
доказать описанными capacity gates; AWS остаётся следующим шагом по privacy,
operations или измеренному ceiling, а не реакцией на число «полгигабайта».
