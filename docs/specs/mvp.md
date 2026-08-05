# Спецификация MVP

Статус: proposal, 2026-08-05. Поведение ниже ещё не реализовано.

## Цель

Доказать один end-to-end сценарий: агент подключается к приватной тематической
базе, находит source-grounded knowledge через MCP, дочитывает канонический OKF
concept, безопасно создаёт новую ревизию и получает переносимый валидный export.

MVP считается vertical slice, а не набором независимых демонстраций. В нём одна
модель ревизий и одни use cases работают локально; web/AWS adapters подключаются
после проверки этой модели.

## Обязательный scope

### Bundle lifecycle

- Импорт ZIP или локального OKF bundle с Markdown и binary assets.
- Проверка OKF 0.2 conformance с отдельными quality warnings.
- Best-effort чтение неизвестных будущих полей и legacy 0.1 fallbacks
  `timestamp`/`# Citations`.
- Создание immutable revision с manifest и SHA-256 каждого entry.
- Детерминированный export выбранной revision без service-only metadata.
- Round-trip сохранение неизвестных types, fields и неизменённых raw bytes.

### Retrieval

- Browse root `index.md` и paths без загрузки всего bundle.
- Lexical `search` по title, description, tags, headings и body.
- `fetch` целого concept или секции с path, revision, canonical URL/URI,
  sources, derived trust tier и freshness state.
- Жёсткий tenant/base/revision filter до выдачи результата.
- Явный limit и признак truncation.

### Safe mutation

- Создание draft changeset с одной или несколькими файловыми операциями.
- Diff до commit.
- Commit только с `expected_revision`, idempotency key и single-use approval
  token, привязанным к actor/base/draft hash/expiry.
- Conflict response содержит актуальный HEAD и не выполняет скрытый merge.
- Multi-file changeset публикуется атомарно: HEAD указывает либо на полный
  предыдущий manifest, либо на полный новый. Частично видимой revision нет;
  отмена принятого commit создаёт новую revert revision.
- Успешный commit создаёт ровно одну новую revision и audit event.
- Индекс либо соответствует новой HEAD revision, либо явно сообщает lag; старые
  chunks не выдаются как текущие.

### Access

- Приватный tenant и один knowledge mount, связанный ровно с одной base.
- Отдельные scopes как минимум `kb.read`, `kb.draft`, `kb.commit`, `kb.export`.
- Identity берётся из проверенного auth context, не из tool arguments.
- `kb.commit` не заменяет approval token; autonomous commit не входит в MVP.
- Read-only deployment может полностью отключить mutation tools.
- Local operator получает approval token отдельной CLI после просмотра diff;
  публичного MCP tool для выпуска token нет. Test-only issuer существует только
  в integration-test process и не собирается в production artifact.

## Первая MCP-поверхность

Обязательны два совместимых retrieval tool:

```text
search(query, filters?, limit?)
  -> [{ id, title, url, excerpt, revision, metadata }]

fetch(id, revision?, section?)
  -> { id, title, text, url, revision, metadata }
```

CloudBrain-specific минимальный набор:

```text
knowledge_base_info()
knowledge_browse(path?, revision?)
knowledge_validate(revision?)
knowledge_draft_create(expected_revision, operations, idempotency_key)
knowledge_diff(draft_id)
knowledge_draft_commit(draft_id, expected_revision, approval_token, idempotency_key)
knowledge_export_start(revision?)
knowledge_export_status(job_id)
```

Import может сначала оставаться web/CLI operation. Если он входит в MCP,
archive передаётся через upload intent/presigned URL, а не base64 в JSON-RPC.

До реализации необходимо зафиксировать JSON Schemas, error taxonomy и MCP
annotations. Input validation errors должны быть понятны модели и позволять
исправить вызов; authorization errors не раскрывают существование чужих bases.

## Критерии готовности local vertical slice

1. Fixture с nested indexes, unknown type/field, raw asset, `sources`,
   `verified`, `stale_after` и legacy fallback импортируется без потери данных.
2. Validator корректно различает хотя бы один conformance error и один quality
   warning.
3. `search` на русском и английском возвращает ожидаемый concept; `fetch`
   возвращает точный canonical text и source pointers.
4. Export после import без мутаций семантически эквивалентен входному bundle, а
   неизменённые entry bytes совпадают.
5. Commit с текущим `expected_revision` создаёт новую HEAD. Повтор с тем же
   idempotency key возвращает тот же результат.
6. Commit с устаревшей revision получает conflict и не меняет HEAD.
7. Попытка прочитать другую base/tenant отклоняется до поиска и object read;
   `search` не умеет неявно перейти в другую base.
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
12. Полный test suite, OKF fixtures и docs validation проходят на одном commit.

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
- public sharing, billing и organization administration;
- AgentCore Gateway, Memory, Bedrock Knowledge Bases, Verified Permissions,
  Object Lock и multi-region replication.

## Измерения перед следующими решениями

- Retrieval benchmark для русского, английского и mixed-language corpus.
- Доля запросов, решённых lexical search без embeddings.
- Search/fetch p50/p95, размер контекста и citation success rate.
- Частота revision conflicts и среднее время index lag.
- Стоимость хранения/запросов на fixture масштаба 1k, 10k и 100k concepts.
- Фактическая совместимость Sites с MCP и OAuth.
