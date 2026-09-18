# Проверка простого файлового входа

Дата: 2026-09-18. Статус: P1/P3 evidence; Codex bridge подтверждён,
ChatGPT Work session attachment на текущем клиенте не доходит до MCP-вызова.

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

## ChatGPT Work

Modern UAT catalog опубликован в Sites version `173` из product candidate
`dd25c83faff195a4aa43360e443d6afaff57fa39`, provider source
`721b8de46c76ae567678994376d605b12b0a59c6`, deployment
`appgdep_example46c5386c7cdc7f53`. В developer plugin
`Mind Diary UAT Modern` (`asdk_app_example7751478055590638`)
выполнен `Refresh`; каталог показал обновлённый `stage_bundle_file` с
`$defs.OpenAIFile`, ссылкой `file: {"$ref":"#/$defs/OpenAIFile"}` и описанием,
запрещающим подставлять local path.

Fresh Work conversation
`https://example.invalid/private-conversation` получил одно
session attachment `mind-diary-chatgpt-native-dd25c83.txt`: 138 bytes,
SHA-256 `e883cb5ebcce841cc5f223e72a202f82f057fbef6aff4aa5ed89e391c101792d`.
`list_minds` дошёл до UAT и вернул HEAD
`revision_00000000-0000-4000-8000-97775b151c45`. Следующий единственный
`stage_bundle_file` остановился внутри клиента: ChatGPT попытался разрешить
native file identifier как local path и получил `No such file or directory`.
Worker logs за тот же run содержат `tools/list` и `tools/call list_minds`, но
не содержат `tools/call stage_bundle_file`. Значит, отказ возник до remote MCP
server, а не в ACL, schema validation, fetch, staging или commit Mind Diary.
Новая revision не создана.

Первый probe с inline object schema завершился так же. Замена на точную форму
из OpenAI Plugins reference устранила schema drift и видна после `Refresh`, но
не исправила текущий Work host. Поэтому результат — проверенная внешняя
несовместимость текущего ChatGPT Work file-parameter bridge, а не доказанная
ошибка server implementation и не повод возвращать six-source taxonomy.
Chat surface отдельно не заявляется проверенной: developer plugin запускает
этот workflow в Work.

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
моделью и не меняет authorization или commit semantics. На текущем ChatGPT
Work native bridge объявлен официальным metadata contract, но live session
attachment не проходит его pre-MCP resolution; до исправления хоста рабочим
fallback остаётся companion, без повторного деления на происхождение файла.
