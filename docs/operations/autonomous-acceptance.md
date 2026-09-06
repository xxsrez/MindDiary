# Автоматическая приёмка Mind Diary

Статус: accepted prospective contract MD-400, 2026-09-06. Реализация и живые
результаты отдельно отслеживаются в [плане](../tasks/autonomous-uat-acceptance.md).
Наличие этого документа не означает завершённую приёмку.

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
connector, сохраняет настоящий terminal deployment read-back либо worker log
result и снова выполняет ту же команду. Во время performance sample агент
собирает bounded logs, не дожидаясь потери начала окна. Эти точки предназначены
для агента и не требуют рутинного подтверждения пользователя.

При прерывании частично созданный component очищается по своему журналу,
проверяется inventory, увеличивается номер попытки и повторяется этот этап.
Подготовленная persistence fixture и завершённая performance sample сохраняются
для соответствующей контрольной точки. Завершённый component повторно
валидируется и сверяется с закреплённым hash; повреждённый artifact не пропускается.
Настоящие platform receipts передаёт управляющий агент после проверки источника;
из произвольного JSON самостоятельно вывести доверенное происхождение нельзя.

Реализация команды требует живой проверки полного цикла MD-407. До двух полных
прогонов и interruption/recovery это не заявление о завершённой автоматизации.


Sites logs выдаются не более чем по 100 событий. Performance capture принимает
массив настоящих ответов connector, сохраняет digest каждого envelope и всего
массива, объединяет события по provider event ID и отклоняет противоречащие
дубликаты. Это несколько запросов, а не выдуманный единый provider query.
Сборщик и проверяющий component должны использовать один чистый runner SHA;
переоценка старых samples новой версией может дать отдельный report, но не
приёмочный component для прежнего runner.


Перед performance команда требует свежий `capture-started.json` с точным
project ID и временем начала (не старше 60 секунд). Агент сначала начинает
получать Sites logs каждые 12 секунд с limit 100, затем сохраняет marker и
продолжает команду. Сбор ведётся до завершения samples. Marker — оркестрационная
проверка порядка, а не evidence: итог всё равно требует настоящих событий для
каждого подписанного запроса. Потерянное начало окна приводит к failed coverage,
даже если все клиентские measurements существуют.
