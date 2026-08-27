# UAT-контракт Google Drive `connector_object`

Статус: exact-provider contract определён MD-284, но не исполнен. Реальный
provider run, hosted evidence и terminal acceptance принадлежат MD-319.

## Назначение и граница

Эта процедура проверяет один exact candidate/deployment и один ограниченный
synthetic набор Google Drive objects. Она не разрешает использовать файлы
пользователя, расширять persistent scopes, менять provider configuration,
передавать данные внешнему получателю или принимать произвольный URL. OAuth,
provider mutation и browser launch выполняются только при отдельной authority
в owning task; наличие этого документа такой authority не создаёт.

Машинный contract:
[`tests/fixtures/google-drive-connector-uat/contract.v1.json`](../../tests/fixtures/google-drive-connector-uat/contract.v1.json).

## Предусловия

1. Зафиксированы exact `candidate_sha` и UAT `deployment_id`; deployment
   прочитан обратно из configured Sites provider.
2. Restricted-UAT account pool имеет `ready` receipt, а run-scoped provider
   grant и synthetic Drive objects созданы вне repository. В repository и Task
   Manager не сохраняются token, account, grant, object/revision ID или URL.
3. Test Mind и writable target принадлежат тому же synthetic principal.
   Existing user Minds, grants и provider objects не используются.
4. Private evidence directory находится вне repository и очищается после
   privacy-safe receipt derivation.

Если любое предусловие неизвестно, итог — `blocked` или `unknown`, а не
частичный `passed`.

## Фикстуры

- один обычный binary object с заранее вычисленными exact size/SHA-256;
- один Google Doc в synthetic shared drive с явным export snapshot
  `google-drive/docx`;
- один Google Sheet в synthetic shared drive с явным export snapshot
  `google-drive/xlsx`;
- одна Google Slides presentation в synthetic shared drive с явным export snapshot
  `google-drive/pptx`.

Для native objects исходные provider bytes не выдумываются: evidence относится
только к выбранному export snapshot. Дополнительный `google-drive/pdf` может
быть informational, но не заменяет три обязательных native formats.

## Blocking assertions

Runner выполняет все `GD-UAT-001`–`GD-UAT-015` из machine contract. В частности:

- принимает только один exact authorized object ID, никогда URL/query/folder;
- сверяет binary source и staged/downloaded bytes byte-for-byte по size и
  SHA-256;
- требует exact explicit export representation для Docs/Sheets/Slides;
- подтверждает shared-drive metadata path и native `files.export` по exact
  `fileId + mimeType` для всех трёх типов без неподдерживаемых query parameters;
- проверяет revoke, ownership/version mutation, export race, oversize, timeout
  и unknown provider result как fail-closed без existence leak;
- доказывает current Mind write authorization до provider content read;
- завершает общий lifecycle: staged ref → atomic commit → exact revision
  download/history → Sites-owned web export → redeploy read-back;
- отдельно подтверждает отсутствие administrative export у Content MCP.

Локальные fake-provider tests не заменяют ни один из этих hosted assertions.

## Receipt и cleanup

Public/privacy-safe receipt содержит только schema/status, exact candidate и
deployment lineage, runner ID, timestamps, результаты stable assertions и
cleanup status. Запрещены credentials, authorization header, provider
grant/object/revision ID, binding ref, export/download URL, email, local path и
content.

Cleanup удаляет synthetic provider objects, отзывает run-scoped grant, удаляет
run Mind и выполняет отсутствие-read-back с обеих сторон. Любая непроверенная
часть cleanup делает итог не выше `unknown`; успешные product assertions не
компенсируют незакрытый cleanup.

Только один receipt со всеми `passed` на одном exact candidate/deployment и
успешным cleanup является MD-319 provider evidence. Сам contract и repository
conformance test фиксируют лишь форму будущей проверки и не являются UAT
acceptance.
