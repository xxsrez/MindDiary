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
