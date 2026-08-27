# Capability host-managed и same-host file transport на 2026-08-27

Статус: принятый live capability evidence для MD-317. Отчёт фиксирует только
наблюдавшийся профиль и не объявляет поддержку по наличию schema, исходного
кода либо недоступного клиентского профиля.

Закрытая машинно-проверяемая копия assertions сохранена в
[`receipt.v1.json`](../../tests/fixtures/md317-capability/receipt.v1.json) и
проверяется отдельным conformance test.

## Причинный вывод

В проверенном Codex Desktop schema native file parameter присутствует, но
развёрнутый профиль не может снабдить Mind Diary provider-object: корректный
объект закрывается ошибкой `native_file_input_unsupported` до скачивания.
Передача локального path в тот же параметр не переписывается host-ом и
закрывается как `invalid_request`.

Рабочий same-host transport существует отдельно: packaged local companion
снимает стабильный snapshot одного regular file, а hosted one-use intent
принимает path-free metadata и bytes. В этом профиле именно этот route, а не
native provider parameter, подтверждён до временного verified staging.

## Проверенный профиль

| Поле | Наблюдавшееся значение |
|---|---|
| Время последнего assertion | `2026-08-27 20:25:14 UTC` |
| Client | Codex Desktop `26.820.60940`, build `7119`, `com.openai.codex` |
| Mind Diary plugin | `0.1.0+codex.20260826190538` |
| Живой каталог | 23 hosted и 2 local companion tools |
| Mind | синтетическая работа в Personal Mind `/me`; visibility `private` |
| Write boundary | существующий binding, `binding_version=7`; binding не менялся |

ChatGPT Work из этого runtime не вызывается. Его результат не выведен из
Desktop и записан отдельной строкой `not_available`.

## Profile matrix

| Profile / route | Outcome | Наблюдаемая граница |
|---|---|---|
| Desktop `stage_bundle_file.file` schema | `supported_native_file_parameter` только на уровне schema | `{download_url, file_id, file_name?, mime_type?}` |
| Desktop host picker/provider bridge для Mind Diary | `not_available` | валидный provider-object вернул `native_file_input_unsupported` до fetch |
| Desktop path в native parameter | `not_available` | host не переписал path; `invalid_request` |
| Desktop packaged companion + hosted intent | `supported_same_host_path` | два synthetic regular files дошли до verified ephemeral staging |
| ChatGPT Work | `not_available` в текущем probe runtime | профиль не callable и не был подменён выводом из Desktop |
| Direct custom MCP | проверяется отдельно | schema или server catalog не доказывают host rewrite/picker |

Fresh hosted capability response сообщает `companion_upload_intent` с лимитом
256 MiB только для `local_path` и `workspace/generated_artifact`.
`session_attachment`, `connector_object`, `bounded_in_memory` и
`server_generated` имеют typed `not_available`, transport `none`, limit `0` и
fallback `none`.

## Closed assertions

| Assertion ID | Классификация | Exact outcome |
|---|---|---|
| `MD317-DESKTOP-NATIVE-SCHEMA` | schema present | `stage_bundle_file.file` объявляет provider-object; support из этого не следует |
| `MD317-DESKTOP-HOST-PICKER-BRIDGE` | `not_available` | структурно корректный object вернул non-retryable `native_file_input_unsupported`; URL не читался |
| `MD317-INVALID-OBJECT` | `not_available` | абсолютный same-host path в provider parameter вернул non-retryable `invalid_request` |
| `MD317-DESKTOP-SAME-HOST-PATH` | `supported_same_host_path` | companion snapshot и hosted intent соединены до verified staging |
| `MD317-COMPANION-PNG` | `supported_same_host_path` | 170 bytes, `image/png`, `sha256:9d580819bed1c8e7d744e20278936336f09bcb10d5046b849828755617aa2917` |
| `MD317-COMPANION-UNKNOWN-BINARY` | `supported_same_host_path` | 37 bytes, normalized `application/octet-stream`, `sha256:a8bb55bd3c1c444b8f291151ca3c83b640c42d4342e4b9f3c6eda62cf3a4076e` |
| `MD317-UNAVAILABLE-PATH` | fail closed | missing file вернул non-retryable `file_ingress_source_unavailable`; path отсутствовал в error/remediation |
| `MD317-SIZE-MISMATCH` | fail closed | неверный expected size вернул non-retryable `bundle_file_size_mismatch` |
| `MD317-EXPIRY` | fail closed | local ref истёк в `20:24:36.614178Z`; вызов до expiry intent `20:24:42.319Z` вернул `local_companion_ref_expired` до сети |
| `MD317-UAT-DEFERRED-SOURCES` | `not_available` | четыре deferred source rows явно вернули transport `none`, limit `0`, no fallback |
| `MD317-OTHER-PLUGIN-BRIDGE-SCHEMA` | comparison only | Task Manager и Google Drive объявляют host-rewritten string file parameters; внешняя загрузка не вызывалась |
| `MD317-CHATGPT-WORK-PROFILE` | `not_available` | профиль не callable в текущем local Desktop runtime |

## Transport, filename и failure boundaries

- Native shape принимает только provider-issued object. Локальный path,
  arbitrary URL и base64 не являются fallback.
- `file_name` и `mime_type` в native shape опциональны и advisory. Probe не
  подтвердил provider fetch, redirect либо filename normalization, потому что
  текущий adapter закрыл запрос на capability check до сети.
- Companion принимает один явно выбранный same-host regular file. Missing
  source, expected-size mismatch и expired ref закрываются локально без
  hosted path, filename, bytes, credential или temporary URL leakage.
- Unknown binary не отбрасывается и не переименовывается по расширению:
  точные bytes сохраняются, media безопасно становится
  `application/octet-stream`.
- Наблюдавшийся expiry доказывает local-ref boundary отдельно от ten-minute
  hosted intent. Он не является выводом из документации или wall-clock
  расчётом.

Redirect count, provider timeout и provider-object expiry не исполнялись:
отсутствующий Desktop bridge отбрасывает object раньше download boundary.
Эти проверки принадлежат будущему реально доступному route MD-315/MD-316 и не
могут быть отмечены pass в текущем profile.

## Побочные эффекты и приватность

- Использованы только два синтетических файла в private `mktemp` directory.
- Созданы два временных UAT staged refs без `commit_changeset`; Mind HEAD и
  immutable revision не изменились. Refs автоматически истекают в
  `21:11–21:12 UTC`.
- Binding, membership, ACL и visibility не менялись.
- В отчёте нет local paths, safe filenames, staged refs, URLs, credentials,
  identity или private bytes.
- Временный каталог удалён. Task Manager, Git и repository во время live probe
  не изменялись.

## Следствия для следующих Tasks

- MD-315 должна делать discovery/profile composition-aware: static
  `_meta["openai/fileParams"]` и object schema не являются support evidence.
- MD-316 не может считать host picker доступным в этом Desktop profile. Нужен
  profile, который реально materialize-ит provider-object, после чего отдельно
  проверяются authorized fetch, redirect, expiry, filename и size rules.
- MD-312 сохраняет companion как доказанный same-host route; relabeling его в
  `session_attachment` запрещён.
- MD-314 должна соединять server capability, client inventory и per-input
  admission отдельными receipts. Ни одна строка не повышается до `supported`
  только по schema presence.
