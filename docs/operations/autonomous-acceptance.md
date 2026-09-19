# Автоматическая приёмка Mind Diary

Статус: accepted prospective contract MD-400, 2026-09-06. Реализация и живые
результаты отдельно отслеживаются в [плане](../tasks/autonomous-uat-acceptance.md).
Наличие этого документа не означает завершённую приёмку.

## Выбор объёма приёмки (2026-09-09)

Для обычных и возобновляемых UAT releases действует
[соразмерная приёмка профиля revision 9](ship-work-release-profile.md#обычный-uat-release-соразмерная-приёмка).
Ниже описан полный шестикомпонентный режим MD-400, а не обязательная программа
каждого релиза. `acceptance:run` и общий join остаются строгими и запускаются
только при обоснованном выборе полного режима. Наличие checkpoint такого run
не обязывает завершать ненужные компоненты: сначала закончить cleanup, затем
переиспользовать применимые результаты в обычном отчёте приёмки.

Для обычного UAT coordinator выбирает отдельные проверки изменённых сценариев
и фиксирует результаты, основания переиспользования и непроверенное. Полная
performance/model/recovery/persistence матрица не нужна по умолчанию. Broad
file mapping ниже — ориентир для анализа риска, не приказ запускать все canaries
при любом изменении Worker. Проверка реальной платформенной identity нужна
при изменении соответствующего binding/provider contract, не при каждой правке
product handler. Обязательные outcomes текущей задачи и границы безопасности
сохраняются с уточнениями профиля; synthetic проверка не становится реальной.

Код runner и schemas этой редакцией не меняются: неполный suite не получает
`passed`, старые failures не удаляются. Приёмка выбранного scope в отчёте и
успешный полный `join-acceptance-suite` — разные утверждения.

## Изоляция данных acceptance-run

В этом harness Personal write означает запись только в
`run-owned-personal-mind` disposable test principal, созданного самим run. Это
не разрешение писать в Personal Mind существующего пользователя. Обычные
мутации выполняются в `run-owned-ordinary-mind` того же изолированного run;
все создаваемые accounts, Minds, credentials, objects и indexes имеют run
ownership и входят в cleanup journal.

До setup controller получает полную baseline inventory, а после cleanup
сравнивает с ней итоговую inventory целиком. Успех возможен только при точном
совпадении; прерванный cleanup возобновляется по durable journal. Любой
`existing-user-mind` остаётся read-only и не может использоваться как fixture
или cleanup target. Публичные receipts не содержат приватные имена или bodies.
Общая граница закреплена в
`tests/fixtures/uat-smoke-data-isolation/contract.v1.json`.

## Применимость платформенных проверок

Управляющий запуск фиксирует exact base/candidate SHA, выбранные Task Manager
идентификаторы и факт изменения provider configuration. Команда
`node scripts/check-acceptance-applicability.mjs <input.json> <output.json>`
сама получает список изменённых файлов через Git. Нельзя подменять его списком
из отчёта проверяемого компонента. Provider configuration берётся из сохранённого
read-back среды; отсутствие данных не трактуется как `false`.

Изменения Sites identity binding, product composition и обычного Worker требуют
настоящей Sites identity проверки. Изменения операторского каталога и его
metadata adapter требуют проверки каталога. OAuth, token/connections UI и plugin
требуют настоящего первого подключения. Изменение provider configuration
активирует все три проверки. Неизвестная затронутая surface требует расширить
mapping перед приёмкой; исключать её по отсутствию regex нельзя.

Для MD-394/MD-399 прежний контракт сохраняется целиком. Новый join отклоняет
исторический scope и не закрывает эти задачи. Для новых scopes выключенная
проверка означает только отсутствие изменения её surface, а не проверенную
совместимость. Применимая проверка должна иметь отдельный receipt с обычного
UAT, настоящей OpenAI Sites identity, exact candidate/deployment и hashes
исходных свидетельств. Test Site с synthetic identity недостаточен.

## Общий результат

`node scripts/join-acceptance-suite.mjs <manifest.json> <report.json> <receipts...>`
проверяет ровно шесть components: product, browser, model, recovery, persistence,
performance; затем проверяет все применимые platform receipts. Ожидаемые hashes
задаёт закрытый журнал управляющего запуска. Самоподписанный JSON не является
независимым подтверждением происхождения.

Каждый component привязан к одному candidate, deployment, saved Site version,
archive digest, common modules и test adapter digest, а также к exact runner
SHA. Model дополнительно фиксирует exact установленный package digest, все
14 сценариев, фактическое сжатие контекста и соблюдение бюджета. Неполный запуск
может сохранить промежуточный receipt, но не общий `passed`.

Все components требуют проверенной очистки: полная inventory до и после
совпадает, включая OAuth records, индексы и объекты. Persistence требует другого
deployment того же artifact и точного чтения revision/content. Performance
перепроверяется прежним строгим gate по настоящим samples и provider telemetry;
порог и число измерений не ослабляются.

## Закрытые данные запуска

Секреты и исходные model traces хранятся только в private directory с правами
0700/0600. Controller использует стандартный `Authorization: Bearer`, Sites
bypass остаётся отдельным credential. Логи провайдера могут содержать request
headers: их нельзя выводить целиком. Публикуемый отчёт содержит только digest,
идентификаторы версии, результаты assertions и сводку очистки.

## Сохранность после публикации и восстановление

`node scripts/check-acceptance-persistence-hosted.mjs <tag> prepare <identity.json>`
создаёт обычным API fixture и сохраняет закрытый checkpoint с точными revision
и digest прочитанного содержимого. Агент повторно публикует тот же saved Site
version через Sites, проверяет terminal deployment и передаёт обновлённую
identity в `verify`. Команда отклоняет смену artifact или runner между фазами,
читает те же revisions/locators и очищает fixture. `cleanup` завершает
незаконченный checkpoint без заявления об успешной проверке.

`node scripts/check-acceptance-recovery-hosted.mjs <tag> <identity.json>`
теряет ответы после настоящих setup/bootstrap/commit/cleanup операций,
повторно открывает закрытый журнал и проверяет восстановление. Одновременно
существует второй run с реальным TTL 60 секунд; reaper должен очистить только
истёкший run, оставив активный доступным. Отдельно проверяются отзыв сессии и
MCP credential, повторная очистка и итоговая inventory. Недоступность сервиса
моделируется HTTP 503 в controller transport: receipt явно отличает эту
инъекцию от настоящего сбоя провайдера. Ни fake success, ни virtual TTL clock
в hosted runner не используются.

Каждая попытка controller cleanup получает отдельный product runtime. После
отмены предыдущего запроса повтор не должен наследовать его незавершённые
in-memory операции. Durable journal, lease и обычные product deletion APIs
остаются источником состояния; новый runtime не даёт права повторять чужую
операцию или обходить текущий доступ. Поздно завершившаяся попытка обязана
проверить свой lease перед следующим действием. Общий runtime измеряемых
пользовательских запросов и обычная сборка продукта этим не меняются.

## Соответствие продуктовой матрице MD-399

| Условие | Свидетельство нового запуска |
| --- | --- |
| Mode × description, настройка/очистка/conflict | product: 9 cells, metadata CAS, scope narrowing |
| Два тематических чтения, независимые записи/no-op | model: described-overlap-read, overlap-automatic-save, overlap-semantic-noop |
| Частичный успех и неизвестный результат | model: overlap-partial-write, overlap-unknown-commit; recovery: commit interruption |
| ACL/scopes/revoke, stale routing | product ACL/scope matrix; browser revoke; model read-only/disabled и повтор после compaction |
| Personal → shared запрет, недоверенный description | model: personal-to-shared-negative, description-injection |
| Modern/compat, история/OKF | browser self-check; product history/OKF; performance оба профиля |
| Restart и сохранность | persistence: same artifact redeploy и exact read-back |
| Установленный plugin и fresh session | model exact package digest и новый AppServer thread; отдельно применимый реальный Marketplace/Sites canary |

Этот mapping распределяет проверки нового scope. Он не закрывает MD-399 и не
заменяет его исторические требования migration/release/first-user evidence.

## Одна команда для управляющего агента

```text
npm run acceptance:run -- <unique-tag> <private-configuration.json>
```

Configuration содержит `identity`, результат applicability и `package_path`
установленного Mind Diary. Запуск требует чистый Git checkout и пустую полную
inventory тестового target. Configuration и runner SHA фиксируются в закрытом
журнале; повтор команды продолжает тот же запуск. Для нового независимого
прогона нужен новый tag.

Порядок: persistence prepare → повторная публикация точной saved version →
persistence verify → product → browser CI → model → recovery → performance →
provider telemetry → применимые реальные platform canaries → общий join.
Браузерная проверка запускается через GitHub workflow со stored secrets;
координатор получает только aggregate artifact по точному CI run ID.

Для Sites команда выдаёт `agent_checkpoint` с exact project/version и именем
закрытого файла результата. Управляющий агент вызывает поддерживаемый Sites
connector, сохраняет настоящий terminal deployment read-back либо полную
выгрузку таблицы измерений D1 и снова выполняет ту же команду. Эти точки предназначены
для агента и не требуют рутинного подтверждения пользователя.

При прерывании частично созданный component очищается по своему журналу,
проверяется inventory, увеличивается номер попытки и повторяется этот этап.
Подготовленная persistence fixture и завершённая performance sample сохраняются
для соответствующей контрольной точки. Завершённый component повторно
валидируется и сверяется с закреплённым hash; повреждённый artifact не пропускается.
Настоящие platform receipts передаёт управляющий агент после проверки источника;
из произвольного JSON самостоятельно вывести доверенное происхождение нельзя.

Полный живой цикл A4, повторные persistence/product/browser проверки B2 и
14 сценариев модели с возобновлённой очисткой подтверждены в
[итоге MD-400](../tasks/autonomous-uat-acceptance.md).
Пользователь затем прямо ограничил объём завершающей приёмки: дополнительные
performance/recovery B2 и третий полный цикл после прерывания координатора
не проводились. Не трактуйте их как passed. Выполненные recovery assertions
A4 и точные версии каждого runner сохранены отдельно.


Performance использует [ADR-0027](../decisions/0027-durable-acceptance-telemetry.md):
тестовый адаптер сохраняет исходные latency events общего runtime в D1 для
подписанных benchmark-запросов. После всех samples агент сначала читает
`sites_read_database_overview`, затем все страницы `md_acceptance_telemetry`
через `sites_read_database_table_rows`, binding `DB`, limit 15, начиная с offset 0
и следуя точному `model_projection.next_offset`. Максимум 256 страниц.
Инструмент допускает до 25 строк, но в живом capture 20/25 приводили к
truncation. Исторический A4 capture занимал 2100 events; после добавления
`list_files`, `grep_files` и `read_files` текущая закрытая matrix создаёт 3108
events и занимает 208 страниц по 15 строк. Новый предел оставляет ограниченный
запас до 3840 строк, не превращая чтение в неограниченный scan. Страницы по 15
строк сохраняют полный ответ без обрезки;
truncated ответ нельзя использовать или пропускать как полную страницу.
Массив настоящих structured responses сохраняется в закрытый
`performance-sites-d1.json`. Значения нельзя собирать заново по памяти или
заменять самостоятельно сформированными строками. Перед capture других
benchmark runs в таблице быть не должно.

Capture v3 явно указывает D1 source, проверяет полноту pagination, отсутствие
truncation, run/candidate/adapter и сохраняет hashes исходных ответов. Сам
performance gate сохраняет прежние бюджеты и полноту измерений. Запись D1
подтверждается до client response и увеличивает измеренную клиентом задержку,
а не исключается из неё. Сборщик и проверяющий component используют один
чистый runner SHA. Переоценка старых samples новым runner может дать отдельный
report, но не component для прежнего runner.


Внутри перспективного first-user canary assertions также выбираются по
изменённому компоненту. OAuth adapter требует настоящих read-first OAuth,
refresh rotation, revoke denial и cleanup. Token/connections UI требует
opt-in формы, modern self-check и cleanup. Изменение plugin/Marketplace
или provider configuration сохраняет полный first-user набор, включая свежую
установку. Исторические MD-394/399 всегда сохраняют полный прежний набор.
Sites identity подтверждается реальным входом и чтением зарегистрированного
аккаунта в штатном интерфейсе; это не утверждение, что браузер показал скрытый
внутренний principal ID. Такой ID нельзя выдумывать из имени пользователя.

## Совместимость с прежним сбором Worker logs

Для диагностики прежних artifacts отдельный runner поддерживает
`MD_ACCEPTANCE_TELEMETRY_SOURCE=worker_logs`. Этот режим обрабатывает не более
семи измерений подряд, затем ждёт полный
набор операций каждого запроса в закрытом JSONL-журнале настоящих ответов Sites.
Агент сохраняет каждый envelope сразу, до завершения всей выборки. Путь
можно передать через `MD_ACCEPTANCE_LOG_JOURNAL`; отдельный runner по умолчанию
читает `sites-log-captures.jsonl` в своей private run directory.

Ожидание длится не более 120 секунд для группы; вся выборка ограничена 45 минутами.
Оно происходит между измерениями, вне их временных окон, и фиксируется отдельным
collection receipt. Все 273 исходных запроса сохраняются, их задержки не
пересчитываются, пропуски не заменяются новыми samples. Это проверка задержек
последовательных обращений, а не измерение максимальной пропускной способности.
Конечный gate по-прежнему независимо требует полные provider events, подписи,
точные request IDs и прежние бюджеты. Само прохождение ожидания ничего не
доказывает и не превращает неполное покрытие в успешный результат.
