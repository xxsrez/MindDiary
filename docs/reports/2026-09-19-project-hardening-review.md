# Ревью проекта и укрепление проверок — 2026-09-19

Статус: инженерное ревью и первый пакет исправлений. База:
`7a73bd3e1eee8a30696ae93da382b1844fbc2c79`. Это не заключение об отсутствии
дефектов и не приёмка production.

## Вывод

Причина последних сбоев не сводится к особенностям клиента. Между продуктовым
решением, каталогом MCP, локальными проверками, отдельной сборкой Site и
установленной записью подключения накопились расхождения. Некоторые тесты
закрепляли уже отменённый контракт; другие проверяли собственную модель
ожидаемого результата вместо ответа действующего обработчика.

Удаление второго endpoint и исправление видимости файлового инструмента уже
входили в исходную базу этого ревью. Здесь исправлены проверки, способные
пропустить повторение этих ошибок, и найдены дополнительные дефекты
упаковки, зависимостей, потокового чтения и восстановления поиска.

## Область и основания

- Изучена история соседней задачи «Разобраться с MCP файлами», актуальные
  решения ADR-0030/0031, конфигурация Marketplace и исходники current runtime.
- Просмотрены границы 23 workspace packages, отдельные приложения,
  dependency locks, GitHub CI, release profile, MCP/OAuth/web adapters,
  D1/R2 persistence, background recovery, backup и схемы доказательств.
- Проверки выполняются в отдельном worktree от свежего `origin/main`.
  Незакоммиченные пользовательские изменения основного checkout не включены.
- Новые ошибки воспроизведены локальными negative tests, включая настоящий
  SQLite для повреждения индекса и Web Streams для отказов транспорта.
- Старое ревью от 2026-09-04 использовано как список направлений проверки.
  Его результаты не объявляются свежими hosted-наблюдениями. Незакрытые ниже
  пункты подтверждены чтением текущих путей кода; их полномасштабные fault
  injection и UAT сценарии не повторялись в этом пакете.

## Что произошло с MCP

1. Исторически существовали ordinary/Apps каталоги и два transport profile.
   Ordinary каталог скрывал `stage_bundle_file`, а Apps metadata ограничивала
   его `ui.visibility=["app"]`. Это две отдельные причины недоступности tool.
2. Плагин, account connector и подключение MCP — разные слои доставки. Старый
   установленный connector продолжал обращаться по уже удалённому адресу.
   Правильный `.mcp.json` на диске не обновляет такую запись автоматически.
3. Ошибки envelope, вызова `fetch` и длины R2 upload проявились позднее,
   когда запрос уже достигал инструмента. Они не объясняют исчезновение tool
   из model-visible каталога.
4. Текущий endpoint один: `/api/mcp`, протокол `2026-07-28`.
   `mind-diary-local` в Marketplace — локальный companion загрузки файла;
   он не второй удалённый content MCP. Удалять его как дубликат неверно.

История изменения подключения и ограничение старого каталога открытой задачи
сохранены в [предыдущем UAT report](2026-09-19-single-mcp-endpoint-uat.md).

## Исправления этого пакета

| Область | Дефект | Изменение и проверка |
| --- | --- | --- |
| MCP acceptance | Полный write каталог из 26 tools не проходил устаревшее ожидание default из 25. Изменение visibility, scopes или `fileParams` не меняло сравниваемые schema hashes | Один write inventory, отдельная существующая read-scope проекция из 24; hash полного descriptor; negative tests для metadata/security/annotations и настоящий HTTP `tools/list`. OAuth scenario действительно вызывается в conformance suite |
| Release artifact | Receipt хешировал только `server/index.js`; изменение импортируемого chunk, CSS, migration или hosting metadata не обнаруживалось | Manifest v2 перечисляет размер и SHA-256 каждого файла. Проверка отклоняет изменение, добавление, удаление и symlink. Упаковка выполняется после завершения Vinext: прежний `closeBundle` hook срабатывал до появления финальных manifests |
| CI и зависимости | Root gate не устанавливал и не собирал отдельный Site. Его lockfile имел 23 отмеченных audit узла: 16 high, 6 moderate, 1 low | Обновлены согласованные Vite/Vinext/Cloudflare/RSC зависимости; удалены неиспользуемые Drizzle и ESLint plugins. CI устанавливает оба активных dependency trees, проверяет audit, lint, реальную сборку Site и artifact manifest |
| Site lint | Команда существовала, но всегда завершалась ошибкой: ESLint 9 config отсутствовал | Добавлен flat config и запуск в CI; локальный lint проходит |
| Native file lifecycle | Отказ staging до начала iteration оставлял download открытым. Ожидание зависшего `cancel()` отменяло смысл timeout; provider exception мог раскрыть короткие частные значения | Явный идемпотентный `dispose`, освобождение в `finally`, cancellation без ожидания, наблюдаемый deadline и только фиксированные категории ошибок. Тесты quota rejection, HTTP failure, late response и зависшего cancel |
| Поисковый индекс | При частичной потере SQL rows query заменял состав ревизии surviving JOIN rows; следующий probe ошибочно видел ready | Неполный набор документов остаётся unavailable и сохраняет memberships для rebuild из canonical revision. Полный набор text rows по-прежнему может восстановить отсутствующие lexical rows. Два SQLite tests проверяют оба случая и restart/rebuild без потери результатов |
| HTTP admission | Web JSON и OAuth сначала читали всё тело; OAuth дополнительно считал UTF-16 characters вместо UTF-8 bytes. Multipart ждал завершения cancellation | Существующие limits применяются при чтении chunks. Общий web reader обслуживает JSON/multipart и освобождает lock. Тесты бесконечного stream, ложного Content-Length, multibyte UTF-8 и зависшего cancel |
| Документация | Ссылки на старую revision профиля и прежний 64 МиБ baseline выглядели текущими | Уточнена текущая исходная точка архитектуры, исправлена навигация ADR, описаны две установки зависимостей, полный artifact и условия backup tests |

Число audit findings — число отмеченных package nodes, включая транзитивные,
а не число самостоятельных уязвимостей. Возможность эксплуатации конкретного
UAT endpoint не проверялась. Первичные advisories:
[React RSC](https://github.com/react/react/security/advisories/GHSA-wx67-qw84-cm4g),
[Vite](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff).
Windows-specific риск Vite не выдаётся за доказанную уязвимость Mac/Worker.

## Оставшийся долг в порядке приоритета

### P1: удаление данных из канонического metadata journal

`SitesMetadataStore.#append` сохраняет вызовы и их arguments в
`md_metadata_events`. Удаление аккаунта меняет materialized state и удаляет
principal activity, но не удаляет прежние payloads bootstrap/profile events.
Следовательно, логическое удаление principal не доказывает физическое
удаление его email из D1. См.
[metadata adapter](../../packages/adapter-metadata-sites/src/index.ts).

Следующий отдельный пакет должен задать модель удаляемых PII, compaction/replay,
backup invalidation и физическую проверку после restart. Переписывать durable
journal поверхностной заменой строк опасно для восстановления. В этом пакете
ни пользовательские данные, ни журнал не переписывались.

### P1: атомарность OAuth refresh и code exchange

`rotateRefresh` расходует старый token отдельным UPDATE, затем `issueTokens`
создаёт новую пару. Аналогичное окно есть после расходования authorization
code. Отказ второй записи лишает клиента возможности повторить запрос.
30-секундная grace для конкурентного reuse не возвращает потерянные credentials.
Отдельная запись в authorization mirror добавляет ещё одну границу отказа.
См. [OAuth adapter](../../packages/adapter-oauth-sites/src/index.ts).

Нужно атомарное consume/create, обработка неопределённого результата и tests
для rollback, concurrent refresh, mirror failure и restart. Здесь rotation
policy не менялась; исправление ограничений body не закрывает этот пункт.

### P2: восстановление фоновых задач и наблюдаемость

`recoverBackground` перечисляет индексирование, invitations и exports, но не
pending/failed audit outbox. Начальные audit IDs передаются через process-local
очередь. Потеря isolate между commit и dispatch требует отдельного durable
recovery path. Обычный request recovery сознательно пропускает export/cleanup;
операторский full sweep остаётся эксплуатационной зависимостью.
См. [composition root](../../packages/composition-root/src/product-site.ts).

Нужны ограниченное перечисление recoverable outbox, возраст очереди,
claim/retry fencing и проверка рестарта. Наличие успешного commit не доказывает
доставку соответствующего audit event. Факт внешнего расписания не установлен.

### P2: OAuth availability и публичная регистрация

Успешная проверка OAuth token ожидает записи `last_used_at`: сбой
observational update способен оборвать аутентификацию. DCR создаёт новые
записи клиентов без локального срока хранения/бюджета накопления. Ограничения
на стороне Sites в этом ревью не установлены. Нужны отдельные failure tests,
явная policy наблюдаемой активности и контролируемое удаление неиспользуемых
registrations; нельзя произвольно запретить совместимые OAuth clients.

### P2: масштаб metadata и поиска

Metadata mutation по-прежнему копирует общий in-memory snapshot перед commit.
Поиск материализует все SQL matches и лишь позднее отрезает страницу;
cleanup digest rows не имеет отдельного индекса `(space_id, digest)`.
Исправление partial-index recovery не устраняет эти свойства.
См. [search adapter](../../packages/adapter-search-sites/src/index.ts) и
[MindSearch](../../packages/application-content/src/mind-search.ts).

Следующий шаг — воспроизводимый замер на выбранном размере corpus/history,
после него адресные SQL mutations и ограниченный набор search candidates.
Обещания о числе пользователей или p95 из чтения кода не следуют.

### P2: оставшиеся границы и исторические проверки

MCP JSON-RPC dispatcher по-прежнему использует `request.text()` до разбора.
Для него нужен согласованный byte budget, учитывающий весь принятый
changeset; перенос 64 КиБ web limit без такого анализа нарушит допустимый
контракт. Исправления OAuth/web не объявляются общей защитой всех inputs.

Часть release fixtures фиксирует Git blob целого документа в двух местах.
Это выявляет drift, но обычная правка пояснения требует ручного обновления
двух hashes. В дальнейшем следует разделить исторические доказательства и
current behavioral assertions. Архитектурный документ также сохраняет
длинные исторические разделы; верхняя текущая сводка не заменяет их будущую
тематическую разборку.

## Правила следующей итерации

1. Изменение endpoint/catalog/file contract включает negative test через
   настоящий dispatcher. Проверяются полный descriptor и права выполнения.
2. Источник Marketplace, установленный cache и account connector проверяются
   отдельно. Их рассинхронизация не исправляется новым параллельным endpoint.
3. Релиз связывает candidate, полный artifact, provider source mirror,
   saved version, deployment и read-back. Зелёный root gate не заменяет Site
   build или реальный клиентский вызов.
4. Документы разделяют действующий контракт, реализацию и датированную
   hosted-проверку. Необходимый scope/ACL/CAS или транспортный budget не
   удаляется вместе с ненужным ограничением выбора клиентского источника.
5. Долг выше закрывается отдельными пакетами с failure/restart tests.
   Он сохраняется в репозитории, чтобы не потеряться в соседнем разговоре.

## Проверки и пределы результата

Targeted tests MCP/native file, полного artifact, OAuth/web input и SQLite
search recovery прошли локально. Первый полный прогон на грязном checkout с
Homebrew Node выявил 6 failures: один stale documentation hash, два требования
clean source и три проверки переносимости Node. Hash обновлён по проверенному
содержимому; условия clean/portable source не ослаблены.

Окончательный CI и UAT результат добавляется после проверки закоммиченного
candidate. До этого этот раздел не утверждает успешную публикацию.
