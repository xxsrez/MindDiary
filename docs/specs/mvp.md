# Спецификация MVP

Статус: proposal, 2026-08-05. Поведение ниже ещё не реализовано.

## Цель

Доказать один end-to-end сценарий: несколько пользователей совместно работают
в private KnowledgeSpace; их агенты находят source-grounded knowledge через MCP,
дочитывают канонический OKF concept, безопасно создают новую revision, а
Admin/Owner получает переносимый валидный export.

MVP считается vertical slice, а не набором независимых демонстраций. В нём одна
модель ревизий и одни use cases работают локально; web/AWS adapters подключаются
после проверки этой модели.

## Обязательный scope

### Bundle lifecycle

- Импорт ZIP или локального OKF bundle с Markdown и binary assets.
- Создание target Space требует отдельного service-level `name`; import не
  превращает название из bundle в identity или ACL автоматически.
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

- Два private KnowledgeSpaces в тестовом tenant: основной collaborative Space и
  isolation fixture; несколько active users имеют пересекающиеся memberships.
- Каждый Space имеет immutable `space_id` и обязательное `name`; нормализованное
  имя уникально внутри tenant, а authorization использует только ID.
- Many-to-many `SpaceMembership` с ролями `reader`, `editor`, `admin`, `owner`.
- Один content MCP mount всегда связан ровно с одним Space.
- Создание Space атомарно создаёт creator membership с ролью Owner.
- Owners может быть несколько; последнего active Owner нельзя demote/revoke.
- Admin управляет Reader/Editor memberships и Space settings/export. Только
  Owner управляет Admin/Owner memberships, visibility и Space lifecycle.
- Отдельные scopes как минимум `space.read`, `space.draft`, `space.commit`,
  `space.export`, `space.settings`, `space.members.write`, `space.owner`.
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

CloudBrain-specific минимальный набор:

```text
get_space_info()
browse_entries(path?, revision?)
validate_space(revision?)
create_draft(expected_revision, operations, idempotency_key)
get_draft_diff(draft_id)
commit_draft(draft_id, expected_revision, approval_token, idempotency_key)
start_export(revision?)
get_export_status(job_id)
```

`get_space_info` возвращает название Space, текущую роль, effective content
capabilities и `management_url`. Это информация для UX, а не доказательство
прав: server-side authorization всё равно читает текущий membership из
проверенного identity context.

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
5. Commit с текущим `expected_revision` создаёт новую HEAD. Повтор с тем же
   idempotency key возвращает тот же результат.
6. Commit с устаревшей revision получает conflict и не меняет HEAD.
7. Попытка прочитать другой Space/tenant отклоняется до поиска и object read;
   `search` не умеет неявно перейти в другой Space.
8. Malicious archive с `../`, absolute path, symlink или превышением quota
   отклоняется до canonical write; Markdown с script/опасной ссылкой не
   исполняется в UI.
9. Инструкция внутри concept не может получить approval token, расширить scope
   или перевести draft в commit; повтор token после успешного commit отклоняется.
10. MCP Inspector проходит initialize, `tools/list`, `search`, `fetch`, draft,
    затем получает reviewed token через operator CLI и выполняет commit через
    Streamable HTTP. Автоматический integration test повторяет поток через
    test-only issuer вне MCP.
11. Ни один лог или trace не содержит body concept, access/approval token или
    transfer URL.
12. Space нельзя создать без name и creator-owner; content import не импортирует
    имя как identity или ACL.
13. Два нормализованно одинаковых имени в одном tenant получают conflict; такое
    же имя в другом tenant допустимо. Rename использует metadata CAS и не меняет
    content HEAD или `space_id`.
14. Reader не создаёт draft; Editor делает reviewed commit; Admin управляет
    Reader/Editor, но не Admin/Owner; Owner управляет всеми ролями.
15. Один principal может быть Editor в основном Space и Reader в isolation
    fixture; его роль не является глобальным свойством пользователя.
16. Две конкурентные попытки снять двух последних Owners не оставляют Space без
    Owner; ownership transfer атомарен.
17. Revoked/demoted Editor не завершает draft, начатый до изменения membership;
    stale membership version получает conflict.
18. Membership mutation не меняет content HEAD и имеет ровно один audit event;
    retry с тем же idempotency key возвращает тот же результат.
19. Полный test suite, OKF fixtures и docs validation проходят на одном commit.

## Compatibility gate для Sites

Sites-релиз считается MCP-релизом только после проверки реальным ChatGPT
Developer mode, а не только локальным fetch:

- stable public HTTPS `/mcp`;
- protocol negotiation и `tools/list`;
- `search`/`fetch` с canonical URLs и citations;
- streaming/error behavior без buffering;
- OAuth discovery, PKCE, audience/scopes и refresh;
- domain challenge;
- D1/R2 persistence после нового deployment;
- проверенная доступность Sites для текущего аккаунта/региона.

Если хотя бы один обязательный пункт не проходит, Sites-релиз остаётся web UI,
а MCP backend получает отдельный portable runtime.

## AWS v1 acceptance

- Тот же container и MCP integration suite проходят в AgentCore Runtime.
- Canonical objects находятся в S3, HEAD CAS — в DynamoDB conditional write.
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
- billing и organization administration;
- invitations, groups, path/tag grants, `unlisted`/`public_read`, public links и
  cross-tenant sharing;
- KnowledgeSite publication, SpaceSession/SpaceGuide, adaptive answers,
  proactive recommendations, outbound push и `follow_head` publication;
- AgentCore Gateway, Memory, Bedrock Knowledge Bases, Verified Permissions,
  Object Lock и multi-region replication.

## Измерения перед следующими решениями

- Retrieval benchmark для русского, английского и mixed-language corpus.
- Доля запросов, решённых lexical search без embeddings.
- Search/fetch p50/p95, размер контекста и citation success rate.
- Частота revision conflicts и среднее время index lag.
- Стоимость хранения/запросов на fixture масштаба 1k, 10k и 100k concepts.
- Фактическая совместимость Sites с MCP и OAuth.
