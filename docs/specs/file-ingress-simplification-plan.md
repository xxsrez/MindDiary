# Загрузка доступного файла без классификации источников

Статус: P1/P2 реализованы, P3 ожидает внешнюю приёмку, 2026-09-18. Контракт
принят в [ADR-0030](../decisions/0030-single-file-input.md), Codex host bridge
подтверждён в [отчёте](../reports/2026-09-18-file-input-contract-probe.md),
obsolete six-source surface удалена. UAT version 173 опубликована, но свежий
ChatGPT Work session attachment остановился в клиенте до MCP-вызова. Состояние
задач ведёт Task Manager, а не этот документ.

## Результат и требования пользователя

Пользователь хочет загружать файлы, к которым агент имеет разрешённый доступ,
без искусственных различий между вложением, файлом на диске и созданным
артефактом. Требуется убрать накопленную сложность и создать исполнимый план.
Это не разрешение считать любой внешний ID доступом к байтам или отменять ACL.

Предлагаемый результат: один обычный файловый вход без ручного выбора
`source_kind`, provider ID и picker для уже доступного файла. Клиент отвечает
за получение разрешённых байтов, адаптер — за транспорт, существующий staging
и commit — за сохранение. Если хост не поддерживает файловый мост, остаётся
один явный путь через companion; отсутствие моста не становится требованием
ручного attachment.

## Основания и пределы доказательств

- Разговор 2026-08-23 `01a02f01-d5e4-7c52-b7e8-fb53b60d9eca`: требование
  пользователя «везде, где codex имеет доступ» агент разложил на шесть типов
  в MD-270/MD-271. Это наша классификация, а не перечень MCP capabilities.
- [ADR-0018](../decisions/0018-file-ingress-contract-and-source-capability-matrix.md)
  и [file-ingress](file-ingress.md) смешивают происхождение, место чтения и
  транспорт в одном enum. Disk и workspace уже используют один upload intent.
- [MD-317 report](../reports/2026-08-27-host-managed-file-transport-capability-probe.md)
  фиксирует конкретный клиент августа. Отказ сервера до fetch не доказывает
  отсутствие файлового моста у хоста. Отказ пути в тогдашнем provider-object
  параметре нельзя переносить на любую современную обёртку.
- [ADR-0023](../decisions/0023-dedicated-mcp-apps-file-ingress-profile.md)
  описывает bootstrap cycle и собственное решение вынести native stage на
  Apps endpoint с app-only visibility. Это не обязательное правило MCP.
- Живой вызов `get_file_ingress_capabilities` 2026-09-18 на подключённом
  маршруте сообщил два available источника через `companion_upload_intent`
  и четыре unavailable. Это отчёт сервера, не проверка файловых прав клиента.
- Каталог Task Manager того же дня даёт host-facing `file: string` с абсолютным
  путём. Это основание проверить host bridge, но ещё не успешный upload.
- [OpenAI file inputs](https://developers.openai.com/plugins/reference#file-apis)
  описывает `_meta["openai/fileParams"]` и объект с `file_id`/`download_url`.
  [MCP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
  переносит JSON-RPC; байтовая загрузка не возникает автоматически из имени
  Streamable HTTP. Источники проверены в аудите 2026-09-18.
- Скилл `chatgpt-mcp`, аудит 2026-09-17, подтверждает materialization ресурсов
  из сервера в ChatGPT. Он не доказывает обратную универсальную загрузку.

## Минимальная целевая конструкция

```text
разрешённый файл клиента → файловый мост хоста либо companion
                       → общий bounded stream → staged_file_ref
                       → существующий atomic commit_changeset
```

Обычный native tool принимает файл, exact Mind и idempotency key. Имя
`stage_bundle_file` предпочтительно переиспользовать; окончательную схему
выбирает первая задача. Модель не конструирует provider envelope и не выбирает
из шести источников. Абсолютный путь допустим только как вход клиентской
обёртки, которая умеет прочитать его; hosted сервер не получает путь для чтения.

Для клиента без native bridge текущий companion остаётся поддержанным
альтернативным маршрутом. Выбор маршрута опирается на фактический доступ
к байтам, а не на происхождение файла. Ошибка авторизации, integrity или quota
не запускает автоматическую смену маршрута или Mind.

| Сейчас | Предложение |
|---|---|
| `local_path` и `workspace/generated_artifact` | Один readable-file transport; локальные проверки прав сохраняются |
| `session_attachment` | Вход host file bridge; материализованный файл может идти общим readable-file путём |
| `connector_object` | Получение через существующий разрешённый connector; после materialization обычная загрузка |
| `bounded_in_memory` и `server_generated` | Один внутренний stream API; buffer адаптируется в stream, размеры проверяются общим слоем |
| Closed source enum в обычных tools/capabilities | Удалить из обязательного выбора; capabilities описывают реальные transports и limits |
| App-only stage и обязательный picker | Model-visible file input для поддержанного клиента; picker только для выбора пользователем |

Новые provider-specific интеграции не входят в scope. Google-native документ
нуждается в явно выбранном экспорте; один object ID не равен доступному файлу.
Прямой server-to-server adapter сохраняется только при существующем потребителе
или доказанной необходимости; происхождение само по себе не оправдывает его.

## Совместимость и ограничения объёма

- Сохраняются существующие staging/store, `staged_file_ref`, SHA-256/size,
  bounded streaming, лимит 256 MiB, quota, expiry, idempotency, exact Mind,
  current ACL/scopes/generation, HEAD CAS и одна atomic revision для файлов
  вместе с Markdown. Новый store, новый commit и новая очередь не нужны.
- Исторические revisions и сохранённый `source_kind` остаются читаемыми.
  Compatibility decoder/adapter допускается; массовой миграции content нет.
  До изменения hashing/reconcile учесть in-flight refs, intent TTL и replay:
  прежний успешный запрос не должен стать новым upload/commit из-за удаления enum.
- Составить короткий список keep/remove/compat для coordinator, шести adapter
  slots, route gating, picker, capability schema, тестов и инструкций. Удалять
  доказанно ненужные ветви, а не добавлять поверх них новый facade навсегда.
- Companion удаляется только для профиля, где замена доказана. Общая библиотека
  потоковой передачи остаётся даже при удалении лишних source adapters.
- Нет произвольного server URL fetch, передачи секретов, больших base64 в
  JSON-RPC, автоматического выполнения/распаковки файлов, новых ACL/scopes,
  смены провайдера, AWS/production или нового универсального framework.
- Проверки описывают пользовательские journeys и transport/security boundaries.
  Все шесть происхождений на одном deployment больше не являются обязательным
  условием простого upload. Не создавать новую систему receipts или join engine.

## Три результата и зависимости

### P1. Проверенный простой вход и окончательный контракт

На синтетическом model-visible `fileParams` tool проверить текущие Codex и
ChatGPT Chat/Work отдельно: какие входы доступны, что получает сервер, какие
байты дошли. Для неизвестного/недоступного клиента писать «не проверено»,
а не «не поддерживается». Разделить host wrapper, MCP payload, adapter отказ
и fetch; не требовать заранее receipt, чтобы опубликовать проверяемый tool.

Результат: один краткий отчёт с exact client/profile, SHA/size и выбранным
маршрутом для каждого целевого клиента; схема обычного входа, companion path,
reconcile compatibility и keep/remove/compat список. До реализации обновить
затронутые спецификации и оформить замену применимых решений ADR-0018/0023.
Нет обязательного публичного туннеля: использовать разрешённый dev/UAT target.

### P2. Общий файловый вход без выбора происхождения

Реализовать выбранный P1 маршрут в MCP/composition и общем staging. Убрать
model-visible source taxonomy, объединить disk/workspace transport и внутренние
producer streams, сохранить compatible read/replay. Публиковать native input
для доказанного host route без обязательного виджета. Убрать route gates,
мешающие этому сценарию, но не включать неподдержанный transport всем клиентам.
Targeted tests проверяют контракт, bounded stream, ACL/CAS и compatibility.
P1 блокирует P2: сначала нужен проверенный wire contract, затем его реализация.

### P3. Удалённая лишняя сложность и проверка в реальных клиентах

Удалить ненужные P1 ветви и требования six-source matrix из активных gates,
описаний tools, package/skill/help. Исторические отчёты не переписывать под
новый результат; активные документы явно ссылаются на заменивший контракт.
Согласовать свежий installed catalog и существующее подключение пользователя
по release profile; отложенный login/consent явно фиксировать.

В UAT по действующему delivery profile проверить: local disk и generated file
в Codex, session attachment в ChatGPT, материализованный разрешённый файл
другого инструмента через тот же вход. Синтетические fixtures, fresh conversation,
stage → commit → exact download SHA/size; history и один mixed Markdown/file
commit. Отдельно regression companion для клиента без native bridge.
Негативные проверки: неверный digest/oversize, lost response/retry, stale HEAD,
revoke и cross-Mind ref. Границы размера и race допустимо проверять локально;
не повторять полную матрицу в каждом hosted клиенте.

P2 блокирует P3: удаление и финальная проверка опираются на рабочую замену.
Epic завершён, когда пользовательский путь работает и obsolete mechanisms
удалены либо имеют конкретного действующего потребителя и причину сохранения.
Unavailable требуемый клиент остаётся явным пробелом, не превращается в pass.

На candidate `dd25c83faff195a4aa43360e443d6afaff57fa39` этот пробел наблюдается
в ChatGPT Work: обновлённая официальная `$defs.OpenAIFile`/`fileParams` schema
видна после `Refresh`, но session attachment преобразуется клиентом в попытку
чтения local path. UAT server получает предшествующий `list_minds`, но не
получает `stage_bundle_file`. Поэтому P3 остаётся на внешней приёмке; добавлять
обратно source taxonomy, Apps picker или новый transport facade ради обхода
этого pre-MCP сбоя нельзя.

## Task Manager и пересечения

Project Mind Diary, единственный active Release 0.5 подтверждены 2026-09-18.
Созданы в Backlog: parent
[MD-465](https://task-manager.example.invalid/issues/59c8f654-b12d-49d1-81c6-6d7f8ce1a67e)
и три native subtasks:

| Этап | Задача | Label |
|---|---|---|
| P1 | [MD-466](https://task-manager.example.invalid/issues/78d5449e-f5aa-486b-9f9a-aadb7f1194e3) — проверка входа и контракт | Spike |
| P2 | [MD-467](https://task-manager.example.invalid/issues/11c22e94-6a29-46a5-a13b-c8e4022223f6) — общий файловый вход | Improvement |
| P3 | [MD-468](https://task-manager.example.invalid/issues/4846316d-38a4-4f1a-8f37-8f3a1c46fae1) — удаление лишнего и UAT | Improvement |

Две native зависимости: MD-466 blocks MD-467; MD-467 blocks MD-468.
Parent имеет Label Epic. Все четыре элемента относятся к Release 0.5.
Вложений для планирования нет.

Bounded search и полный каталог незавершённых задач не нашли дубликата.
MD-454 занимается операциями Memory без OKF и не является dependency этой
работы: файловый вход сохраняет существующий commit contract. Завершённые
MD-270/271/315/317/325 используются как история, не переоткрываются.
