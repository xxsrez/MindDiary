# ADR-0030: один файловый вход без классификации происхождения

Статус: accepted, 2026-09-18, MD-466.

## Причина

Предыдущий контракт свёл шесть способов получения байтов в закрытый
`source_kind` и затем использовал ту же классификацию в MCP schemas,
capability report, route gates и UAT matrix. Это смешало три разных уровня:

- место, где клиент получил разрешённые байты;
- механизм передачи файла от host к MCP tool;
- внутреннюю provenance-метку уже сохранённого staged record.

Шесть значений были архитектурной классификацией Mind Diary, а не шестью
видами MCP file input. Официальный OpenAI contract использует один top-level
file parameter: совместимый host передаёт объект с `download_url`, `file_id`,
необязательными `mime_type` и `file_name`. Локальный путь может быть входом
обёртки клиента, но не становится аргументом удалённого MCP server.

18 сентября 2026 года текущий Codex wrapper успешно преобразовал абсолютный
путь синтетического файла в такой native input для Task Manager. Серверный
read-back подтвердил 81 byte и точный SHA-256; тестовый staged object удалён.
Это доказывает конкретный Codex host bridge, а не универсальную поддержку всех
MCP clients. ChatGPT Chat и Work проверяются отдельно после публикации tool на
UAT.

## Решение

1. Обычный modern Content MCP публикует один model-visible
   `stage_bundle_file` с top-level `file` и
   `_meta["openai/fileParams"] = ["file"]`. Schema объявляет ровно
   `download_url`, `file_id`, optional `mime_type` и `file_name`. Модель не
   конструирует provider object и не выбирает происхождение файла.
2. Сервер принимает provider envelope только на adapter boundary, проверяет
   разрешённый HTTPS host на каждом redirect, не передаёт credentials/referrer,
   ограничивает время и поток 256 MiB. Ни локальный путь, ни provider ID, ни
   временный URL не входят в domain identity или durable content.
3. Отдельный `/api/mcp/apps`, обязательный picker и app-only visibility больше
   не являются активным контрактом. Picker остаётся допустимым интерфейсом
   host, но не отдельным способом staging. Compatibility endpoint
   `/api/mcp/2025-11-25` не получает новый native claim без отдельной проверки.
4. Companion остаётся одним явным запасным transport для клиента без native
   bridge. Fresh `create_file_upload_intent` больше не принимает
   `source_kind`; один явно выбранный readable regular-file snapshot загружается
   в тот же bounded staging. Cached legacy calls с `local_path` или
   `workspace/generated_artifact` принимаются только для точного replay и
   истекающего in-flight intent.
5. `get_file_ingress_capabilities` сообщает реальные transports и limits, а не
   шесть происхождений. `reconcile_file_stage` не требует выбирать
   `source_kind`; adapter разрешает современный receipt и ограниченный набор
   legacy fingerprints server-side.
6. Внутренний `sourceKind` в существующих staged records, audit и historical
   manifests сохраняется как compatibility provenance. Он не является
   authorization identity, model-visible selector или новым обязательным полем.
   Миграции исторических revisions нет.
7. Native input, companion и trusted producer используют общий
   `BundleFileStagingService.stageStream`. Сохраняются exact Mind, current ACL,
   scopes, principal usage generation, SHA-256/size, quota, expiry,
   idempotency, `reconcile_file_stage`, HEAD CAS, atomic Markdown/file
   `commit_changeset` и exact `reconcile_changeset`.

## Совместимость

- Новый modern catalog сразу показывает проверяемый `fileParams` tool. Отказ
  host до вызова означает неподтверждённую client capability, а не новый source
  type и не повод строить ещё один endpoint.
- Legacy caller может завершить уже созданный companion intent с прежней
  provenance-меткой. Fresh catalog эту метку не предлагает.
- Ошибка native bridge не запускает произвольный URL fetch, base64, смену Mind
  или скрытую передачу локального пути. Caller явно использует companion либо
  сообщает отсутствие доступного transport.

## Заменённые решения

Этот ADR заменяет обязательную six-source capability matrix и model-visible
closed `source_kind` из [ADR-0018](0018-file-ingress-contract-and-source-capability-matrix.md).
Он полностью заменяет отдельный Apps endpoint, picker и app-only stage из
[ADR-0023](0023-dedicated-mcp-apps-file-ingress-profile.md). Общие security,
integrity, staging и atomic commit invariants обоих решений сохраняются.

Связанные документы: [file ingress](../specs/file-ingress.md),
[BundleFile](../specs/bundle-files.md), [API](../specs/api.md) и
[проверка контракта](../reports/2026-09-18-file-input-contract-probe.md).
