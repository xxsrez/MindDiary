# Проверка простого файлового входа

Дата: 2026-09-18. Статус: P1 evidence; Codex bridge подтверждён, ChatGPT
Chat/Work acceptance выполняется после публикации modern UAT catalog.

## Причинный вывод

Проблема возникла не из ограничения MCP на шесть способов файла. Mind Diary
сам ввёл шесть provenance/source классов и затем сделал их частью выбора route.
Реальный OpenAI contract один: host преобразует разрешённый файл в object с
временным `download_url` и `file_id`, после чего MCP adapter читает байты
ограниченным потоком. Абсолютный путь существует только на стороне совместимой
Codex wrapper.

## Первичный контракт

OpenAI Plugins reference на дату проверки требует:

- top-level field в `_meta["openai/fileParams"]`;
- все четыре schema properties: `download_url`, `file_id`, `mime_type`,
  `file_name`;
- только `download_url` и `file_id` в `required`;
- runtime snake_case object; `mime_type` и `file_name` могут отсутствовать.

MCP transport переносит JSON-RPC. Он сам по себе не делает локальную файловую
систему сервера общей с клиентом и не превращает path string в bytes.

## Codex Desktop

Проверен текущий Codex Desktop task
`00000000-0000-4000-8000-4afe684433a0` через установленный Task Manager
wrapper. Host-facing parameter принял абсолютный путь; remote staged metadata
вернул:

| Поле | Значение |
|---|---|
| filename | `codex-fileparams-probe.txt` |
| media type | `text/plain` |
| size | `81` |
| SHA-256 | `17df3b2e7b539859517289b61da45d7807c53d9a3c15a4d71a6e7a9f847864ca` |
| staged ref | `00000000-0000-4000-8000-ae873afca159` |

`get_file` повторно вернул те же size/SHA/state. Затем unbound staged object
удалён: version `2` перешла в deleted version `3`. Это подтверждает path → host
file bridge → provider object → remote bounded upload на конкретной версии
Codex/Task Manager. Оно не раскрывает remote server локальный path и не
доказывает поведение другого tool schema или клиента.

## ChatGPT Chat и Work

Chrome-профиль `Mind Diary UAT Ordinary` доступен, поверхности Chat и Work
видимы. В Installed section на момент P1 не было тестового custom MCP plugin;
выполнять upload без нужного tool означало бы проверить только обычное
вложение ChatGPT. Поэтому результат сейчас `not_yet_tested`, а не
`unsupported`. После UAT publication нужен свежий разговор в каждой
поверхности: session attachment → `stage_bundle_file` → exact size/SHA
read-back → cleanup.

## Keep / remove / compatibility

| Решение | Элементы |
|---|---|
| Keep | `stage_bundle_file`, OpenAI file object, allowlisted credentialless bounded fetch, `stageStream`, `staged_file_ref`, SHA/size, quota/TTL/idempotency, exact Mind/generation/ACL/scopes, reconcile, HEAD CAS, atomic commit |
| Remove | six-source model choice, six-row capability gate, `/api/mcp/apps`, mandatory picker, app-only stage, receipt-before-publication gate, separate disk/workspace choice, separate bytes-vs-stream producer path |
| Compatibility | historical `sourceKind` reads, cached companion `source_kind` replay during intent lifetime, legacy revision/audit decoding, `/api/mcp/2025-11-25` without unverified native claim |

## Выбранный контракт

Modern `/api/mcp` публикует один model-visible `stage_bundle_file`. Клиент с
native bridge предоставляет файл напрямую; клиент без него использует один
companion upload-intent route. Оба маршрута заканчиваются в общем bounded
staging и возвращают один opaque ref. Происхождение байтов не выбирается
моделью и не меняет authorization или commit semantics.
