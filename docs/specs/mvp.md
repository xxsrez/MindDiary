# Спецификация MVP

Статус: proposal, 2026-08-05. Поведение ниже ещё не реализовано.

## Цель

Доказать один end-to-end сценарий: несколько пользователей совместно работают
в private KnowledgeSpace; их агенты находят source-grounded knowledge через MCP,
дочитывают канонический OKF concept и безопасно создают новую revision.
Участники открывают read-only состояние Space по revision/date/Checkpoint.
Каждый Space имеет стабильный auth-gated `/{space_handle}` с base landing и
ограниченной персонализацией из designated Personal Space пользователя.
Admin/Owner получает переносимый валидный export.

MVP считается vertical slice, а не набором независимых демонстраций. В нём одна
модель ревизий и одни use cases работают локально; web/AWS adapters подключаются
после проверки этой модели.

## Обязательный scope

### Bundle lifecycle

- Импорт ZIP или локального OKF bundle с Markdown и binary assets.
- Создание target Space требует отдельные service-level `space_handle` и
  display `name`; import не превращает название из bundle в URL identity или
  ACL автоматически.
- Проверка OKF 0.2 conformance с отдельными quality warnings.
- Best-effort чтение неизвестных будущих полей и legacy 0.1 fallbacks
  `timestamp`/`# Citations`.
- Создание immutable revision с manifest и SHA-256 каждого entry.
- Детерминированный export выбранной revision без service-only metadata.
- Round-trip сохранение неизвестных types, fields и неизменённых raw bytes.

### Retrieval

- Browse root `index.md` и paths без загрузки всего bundle.
- Lexical `search` по title, description, tags, headings и body.
- `fetch` выбранного concept по opaque revision-bound ID с canonical URL/URI,
  sources, derived trust tier и freshness state.
- Жёсткий tenant/space/revision filter до выдачи результата.
- Результаты ограничены на сервере; если совместимый tool-result metadata
  позволяет, сервер явно сообщает truncation.

### Canonical URL и landing

- Каждый Space получает canonical HTTPS URL вида
  `https://{space-host}/{space_handle}`. В local profile host тестовый, но path
  contract совпадает с Sites/AWS adapters.
- `space_handle` — immutable в MVP и уникален внутри verified host namespace.
  Rename display name, новая HEAD и смена presentation settings не меняют URL.
- Авторизованный переход возвращает `SpaceLanding` выбранной target revision:
  title, base summary, authored entrypoints, provenance/freshness, suggested
  questions и available actions.
- Если у principal есть designated Personal Space, consent и
  `personal.context.read`, landing по умолчанию получает mode `personal_space`
  и адаптирует подачу из exact personal revision. Иначе mode — `base`; UI
  позволяет принудительно показать base.
- Landing не содержит memberships/private settings, raw personal facts и не
  загружает ни target, ни personal corpus. Derived text помечается как
  generated и не записывается в Space автоматически.
- Private URL проверяет current membership до чтения Space metadata;
  неавторизованный ответ не раскрывает name, summary или факт существования.
- Web representation и `get_space_info` ссылаются на один target `space_id`,
  canonical URL, target `resolved_revision_id`, personalization mode и, только
  для самого principal, `personal_context_revision_id`. Полная adaptive
  SpaceSession и anonymous public landing остаются вне MVP.

### Read-only history

- Упорядоченный список committed revisions с exact ID, parent, монотонным
  номером, server-assigned UTC commit time, actor и summary.
- Разрешение исторического состояния по точному `revision_id`, UTC `as_of` или
  immutable `Checkpoint`; относительное время сначала переводится в точный UTC
  instant с явной timezone.
- `as_of` выбирает последнюю revision с `committed_at <= as_of`, после чего
  mount фиксирует exact `resolved_revision_id` на всю сессию.
- Editor/Admin/Owner создаёт Checkpoint через trusted CLI/control plane с
  `space.checkpoint.write`. Имя уникально внутри Space, retarget запрещён;
  Checkpoint не меняет HEAD, не является OKF `tags` и не входит в export.
- Любой non-HEAD mount принудительно read-only даже для Owner и каждый раз
  проверяет current active membership плюс `space.history.read`.
- Browse/search/fetch используют только resolved revision. Если её производный
  index отсутствует, разрешён rebuild или явный unavailable/lag, но не fallback
  на HEAD.
- Все успешно committed revisions сохраняются в MVP. Удаление из HEAD не
  является hard erasure и сопровождается явным предупреждением в UI.

### Safe mutation

- Создание draft changeset с одной или несколькими файловыми операциями.
- Diff до commit.
- Commit только с `expected_revision`, idempotency key и single-use approval
  token, привязанным к actor/Space/draft hash/membership epoch/expiry.
- Conflict response содержит актуальный HEAD и не выполняет скрытый merge.
- Multi-file changeset публикуется атомарно: HEAD указывает либо на полный
  предыдущий manifest, либо на полный новый. Частично видимой revision нет;
  отмена принятого commit создаёт новую revert revision.
- Успешный commit создаёт ровно одну новую revision и audit event.
- Индекс либо соответствует новой HEAD revision, либо явно сообщает lag; старые
  chunks не выдаются как текущие.

### Access

- Не менее четырёх private KnowledgeSpaces в fixture: основной collaborative
  target, isolation Space и по designated Personal Space для двух principals.
- Каждый Space имеет immutable `space_id`, immutable в MVP `space_handle` и
  обязательное mutable display `name`. Нормализованный handle уникален внутри
  host namespace; authorization после resolver использует только ID.
- Many-to-many `SpaceMembership` с ролями `reader`, `editor`, `admin`, `owner`.
- Один content MCP mount всегда связан ровно с одним Space.
- Canonical URL выводится из verified deployment host и сохранённого handle, а
  не из переданных клиентом tenant/name/role. Resolver переводит handle в ID до
  authorization и object read.
- Personal Space overlay server-side разрешает только designated Space того же
  verified principal и не даёт MCP второй searchable corpus.
- Создание Space атомарно создаёт creator membership с ролью Owner.
- Owners может быть несколько; последнего active Owner нельзя demote/revoke.
- Admin управляет Reader/Editor memberships и Space settings/export. Только
  Owner управляет Admin/Owner memberships, visibility и Space lifecycle.
- Отдельные scopes как минимум `space.read`, `space.history.read`,
  `space.draft`, `space.commit`, `space.export`, `space.checkpoint.write`,
  `space.settings`, `space.members.write`, `space.owner` и
  `personal.context.read`.
- Identity берётся из проверенного auth context, не из tool arguments.
- Role задаёт максимум capabilities; mount/OAuth scopes могут только сузить их.
- `space.commit` не заменяет approval token; autonomous commit не входит в MVP.
- Read-only deployment может полностью отключить mutation tools.
- Local operator получает approval token отдельной CLI после просмотра diff;
  публичного MCP tool для выпуска token нет. Test-only issuer существует только
  в integration-test process и не собирается в production artifact.
- Membership management выполняется в trusted web/CLI control plane и не
  публикуется в content MCP.
- Membership change использует version CAS, idempotency, audit и
  `membership_epoch`, но не создаёт SpaceRevision.

Capability matrix и owner invariants определены в
[доменной спецификации](domain-model.md).

## Первая MCP-поверхность

Обязательны два совместимых retrieval tool:

```text
search(query)
  -> { results: [{ id, title, url }] }

fetch(id)
  -> { id, title, text, url, metadata? }
```

`id` opaque и привязан к `space_id + revision_id + path`, поэтому `fetch` читает
именно найденную immutable revision. Дополнительные filters/revision/section не
расширяют эти standard inputs; для них при доказанной необходимости появятся
отдельные tools.

Mind Diary-specific минимальный набор:

```text
get_space_info()
browse_entries(path?)
validate_space()
list_revisions(before?, limit?)
get_revision(revision_id)
list_checkpoints()
create_draft(expected_revision, operations, idempotency_key)
get_draft_diff(draft_id)
commit_draft(draft_id, expected_revision, approval_token, idempotency_key)
start_export()
get_export_status(job_id)
```

`get_space_info` возвращает handle/display name Space, текущую роль, effective
content capabilities, canonical URL, landing mode, selector, target
`resolved_revision_id`, private `personal_context_revision_id` при его
использовании, commit time, `is_historical` и `management_url`. Это информация
для UX, а не доказательство прав: server-side authorization всё равно читает
текущий membership из проверенного identity context. Создание Checkpoint
остаётся trusted control-plane operation, а не content MCP tool.

Import может сначала оставаться web/CLI operation. Если он входит в MCP,
archive передаётся через upload intent/presigned URL, а не base64 в JSON-RPC.

До реализации необходимо зафиксировать JSON Schemas, error taxonomy и MCP
annotations. Input validation errors должны быть понятны модели и позволять
исправить вызов; authorization errors не раскрывают существование чужих Spaces.

## Критерии готовности local vertical slice

1. Fixture с nested indexes, unknown type/field, raw asset, `sources`,
   `verified`, `stale_after` и legacy fallback импортируется без потери данных.
2. Validator корректно различает хотя бы один conformance error и один quality
   warning.
3. `search(query)` на русском и английском возвращает ожидаемый concept с
   opaque revision-bound ID; `fetch(id)` возвращает точный canonical text и
   source pointers даже после смены HEAD.
4. Export после import без мутаций семантически эквивалентен входному bundle, а
   неизменённые entry bytes совпадают.
5. Три последовательные revisions разрешаются по exact ID и `as_of`: instant
   между второй и третьей всегда выбирает вторую и возвращает её exact ID,
   номер и server commit time.
6. Checkpoint остаётся привязан к той же revision после продвижения HEAD;
   попытка retarget получает conflict, а новое имя может указать на новую
   revision.
7. Historical mount Owner не показывает mutation tools и отклоняет create
   draft/commit. `search`/`fetch` читают exact resolved revision и не выдают
   content, появившийся только в HEAD.
8. Revoked participant не читает ни HEAD, ни прежнюю revision, даже если ранее
   имел к ней доступ: проверяется current membership, а не historical ACL.
9. Удалённый из HEAD entry остаётся читаемым в прежней committed revision, и UI
   предупреждает, что обычный commit не является hard erasure.
10. Отсутствующий historical index не вызывает fallback к HEAD: search честно
    сообщает lag/unavailable или использует index, перестроенный именно для
    resolved revision.
11. Commit с текущим `expected_revision` создаёт новую HEAD. Повтор с тем же
   idempotency key возвращает тот же результат.
12. Commit с устаревшей revision получает conflict и не меняет HEAD.
13. Попытка прочитать другой Space/tenant отклоняется до поиска и object read;
   `search` не умеет неявно перейти в другой Space.
14. Malicious archive с `../`, absolute path, symlink или превышением quota
   отклоняется до canonical write; Markdown с script/опасной ссылкой не
   исполняется в UI.
15. Инструкция внутри concept не может получить approval token, расширить scope
   или перевести draft в commit; повтор token после успешного commit отклоняется.
16. MCP Inspector проходит initialize, `tools/list`, `search`, `fetch`, draft,
    затем получает reviewed token через operator CLI и выполняет commit через
    Streamable HTTP. Автоматический integration test повторяет поток через
    test-only issuer вне MCP.
17. Ни один лог или trace не содержит body concept, PersonalContext/personal
    fact, landing body, access/approval token или transfer URL.
18. Space нельзя создать без `space_handle`, display `name` и creator-owner;
    content import не импортирует handle, name или ACL.
19. Два нормализованно одинаковых handles на одном verified host получают
    conflict даже в разных tenants; на другом verified host тот же handle
    допустим. Display names могут совпадать. Rename name использует metadata CAS
    и не меняет content HEAD, handle или `space_id`.
20. Reader не создаёт draft; Editor делает reviewed commit; Admin управляет
    Reader/Editor, но не Admin/Owner; Owner управляет всеми ролями.
21. Один principal может быть Editor в основном Space и Reader в isolation
    fixture; его роль не является глобальным свойством пользователя.
22. Две конкурентные попытки снять двух последних Owners не оставляют Space без
    Owner; ownership transfer атомарен.
23. Revoked/demoted Editor не завершает draft, начатый до изменения membership;
    stale membership version получает conflict.
24. Membership mutation не меняет content HEAD и имеет ровно один audit event;
    retry с тем же idempotency key возвращает тот же результат.
25. Полный test suite, OKF fixtures и docs validation проходят на одном commit.
26. Create Space возвращает canonical `/{space_handle}`; rename display name и
    смена HEAD не меняют URL. Router разрешает handle в `space_id` до ACL и
    object read; handle не используется как доказательство прав.
27. Authorized member получает по URL landing exact target revision. Два
    неавторизованных запроса к случайному и существующему private handle не
    различимы по раскрываемой Space metadata.
28. Web landing и `get_space_info` возвращают тот же target `space_id`, handle,
    canonical URL и `resolved_revision_id`; landing не содержит membership list
    или весь target/personal corpus.
29. Два authorized principals с разными designated Personal Spaces получают
    разную глубину/порядок подачи одной target revision, но одинаковые target
    facts, revision ID и provenance.
30. Principal без designation, consent или `personal.context.read` получает
    `base`; instrumentation подтверждает, что его Personal Space не читался.
31. Malicious instruction в target concept не может выбрать arbitrary personal
    path/query, получить raw personal fact, сменить designation или расширить
    `personal.context.read`.
32. Personalized landing одного principal не выдаётся другому, не попадает в
    shared/CDN cache и не виден в audit/analytics Owners target Space.
33. Personalized landing фиксирует exact personal revision ID. Продвижение HEAD
    Personal Space не меняет уже возвращённый result/receipt; новый opening
    явно разрешает новую revision.

## Compatibility gate для Sites

Sites-релиз считается MCP-релизом только после проверки реальным ChatGPT
Developer mode, а не только локальным fetch:

- stable public HTTPS `/mcp`;
- protocol negotiation и `tools/list`;
- `search`/`fetch` с canonical URLs и citations;
- canonical `/{space_handle}` и revision-bound base/personalized SpaceLanding;
- streaming/error behavior без buffering;
- OAuth discovery, PKCE, audience/scopes и refresh;
- domain challenge;
- D1/R2 persistence после нового deployment;
- проверенная доступность Sites для текущего аккаунта/региона.

Если хотя бы один обязательный пункт не проходит, Sites-релиз остаётся web UI,
а MCP backend получает отдельный portable runtime.

## AWS v1 acceptance

- Тот же container и MCP integration suite проходят в AgentCore Runtime.
- Portable Web/API adapter обслуживает canonical Space URL с тем же landing
  contract и authorization semantics, что local/Sites profile.
- Canonical objects находятся в S3, HEAD CAS — в DynamoDB conditional write.
- Exact ID, `as_of` и Checkpoint разрешаются в ту же revision, что в local
  adapter; historical reads проверяют current membership и не смешиваются с
  HEAD.
- Повторная доставка index job безопасна и идемпотентна.
- IAM role сервиса имеет минимальные права и не даёт клиентам прямой доступ к
  S3/DynamoDB/OpenSearch.
- JWT authorizer и application ACL проверяют каждый tool/resource.
- CloudWatch/OTEL показывает latency, errors, conflicts и index lag без
  приватного содержимого.
- Export из AWS проходит тот же OKF round-trip suite, что local adapter.

## Не входит в MVP

- vector search как обязательная зависимость;
- автоматический crawling/OCR/transcription;
- выполнение Attested Computations;
- безусловный agent-generated synthesis после ingest;
- UI-редактор уровня Notion;
- сложный semantic merge параллельных changesets;
- branches, moving tags, merges или запись поверх historical/detached revision;
- hard erasure committed history и юридическая retention/deletion policy;
- billing и organization administration;
- invitations, groups, path/tag grants, `unlisted`/`public_read`, public links и
  cross-tenant sharing;
- handle rename/aliases, global discovery/link graph и anonymous SpaceLanding;
- general cross-space search, несколько Personal Spaces/профилей, использование
  sensitive personal categories и sharing designated Personal Space;
- KnowledgeSite publication, полноценная SpaceSession/SpaceGuide, свободные
  adaptive answers, proactive recommendations, outbound push и `follow_head`
  publication;
- AgentCore Gateway, Memory, Bedrock Knowledge Bases, Verified Permissions,
  Object Lock и multi-region replication.

## Измерения перед следующими решениями

- Retrieval benchmark для русского, английского и mixed-language corpus.
- Доля запросов, решённых lexical search без embeddings.
- Search/fetch p50/p95, размер контекста и citation success rate.
- Base/personalized landing p50/p95, доля fallback и субъективная полезность
  адаптации без изменения factual grounding.
- Доля пользователей, включивших Personal Space context, и частота ручного
  переключения на base без логирования личного содержания.
- Частота revision conflicts и среднее время index lag.
- Стоимость хранения/запросов на fixture масштаба 1k, 10k и 100k concepts.
- Фактическая совместимость Sites с MCP и OAuth.
