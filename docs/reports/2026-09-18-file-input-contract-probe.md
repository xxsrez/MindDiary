# Проверка простого файлового входа

Дата: 2026-09-18. Статус: P1/P3 evidence; простой native file flow
подтверждён в Codex Desktop и ChatGPT Work UAT до commit и точного read-back.

## Причинный вывод

Проблема возникла не из ограничения MCP на шесть способов файла. Mind Diary
сам ввёл шесть provenance/source классов и затем сделал их частью выбора route.
Реальный OpenAI contract один: host преобразует разрешённый файл в object с
временным `download_url` и `file_id`, после чего MCP adapter читает байты
ограниченным потоком. Абсолютный путь существует только на стороне совместимой
Codex wrapper.

## Первичный контракт

[OpenAI Plugins reference](https://developers.openai.com/plugins/reference)
на дату проверки требует:

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

Modern UAT catalog публикует `stage_bundle_file` с `$defs.OpenAIFile`, ссылкой
`file: {"$ref":"#/$defs/OpenAIFile"}` и `_meta["openai/fileParams"]`. Свежий
Work host сформировал официальный runtime object и вызвал MCP; ранний вывод о
pre-MCP несовместимости оказался неверным и исправлен последующими live runs.

Три серверных дефекта проявились последовательно:

1. корневой normalizer должен был преобразовать runtime `download_url`/
   `file_id` в внутренний camelCase object;
2. сохранённый как private field `globalThis.fetch` вызывался с неверным
   receiver, поэтому Cloudflare Worker возвращал `Illegal invocation`;
3. после успешного fetch неизвестная приложению длина создавала обычный
   `TransformStream`, тогда как R2 staging требовал `FixedLengthStream`.

Финальная реализация bind-ит default fetch к `globalThis`, читает валидный
`Content-Length` ответа провайдера как транспортную длину и передаёт её в
общий streaming staging. Агенту по-прежнему не требуется передавать
`expected_size`, выбирать происхождение или конструировать file object.

Финальный UAT опубликован в Sites version `180` из product candidate
`be169e0dabb75c138d4bd10a5267094bd9155e4e`, provider source
`6713669336fa91327ac0c863bb4117bce8527903`, deployment
`appgdep_example8ce6b119631eb53c`. Work conversation
`https://example.invalid/private-conversation` передал attachment
`mind-diary-native-uat-174(2).txt` без `expected_size` и
`expected_sha256`. `stage_bundle_file` вернул:

| Поле | Значение |
|---|---|
| staged ref | `staged_00000000-0000-4000-8000-22d0d2731f3b` |
| state | `verified` |
| size | `163` |
| SHA-256 | `cf3cb4754f87b6ac12c1d4ed82bb84cdc27785b417435ea67de15841f1b95461` |

Один `commit_changeset` с одной `create_bundle_file` создал
`assets/chatgpt-native-uat-180.txt` и продвинул HEAD с
`revision_00000000-0000-4000-8000-97775b151c45` на
`revision_00000000-0000-4000-8000-26f0595ec2af`. `list_bundle_files` подтвердил
path, 163 bytes и тот же SHA-256. `read_files` по exact revision вернул полный
диапазон `0..163` и точный исходный текст. `get_revision` и `validate_mind`
подтвердили exact revision, OKF `0.2`, ноль conformance errors и ноль quality
warnings. Первый read-back получил transient `metadata_queue_timeout`; один
повтор только read-only операции прошёл. Commit был однозначно успешным,
поэтому reconcile не требовался.

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
моделью и не меняет authorization или commit semantics. Текущий ChatGPT Work
native bridge подтверждён live staging, commit и exact read-back. Companion
остаётся единственным fallback для клиентов без native fileParams, без
повторного деления на происхождение файла.
