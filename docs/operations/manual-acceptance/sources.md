# Перенос прежних сценариев

Ручные UAT-обязательства сведены в [карту соответствия](uat-selection.md).
Она дополняет первоначальный перенос ниже и определяет выбор по frontmatter.

Просмотрено 2026-09-21. Канонический источник обычных ручных карточек теперь
этот каталог. Старые документы сохраняют отдельные назначения: продуктовые
требования, воспроизводимость автоматизации, исторические доказательства,
pilot research или строгие release-specific процедуры. Их старые успешные
результаты не становятся результатами новых карточек.

| Прежний материал | Что перенесено | Что остаётся отдельно |
| --- | --- | --- |
| [Import/export runbook](../import-export-browser-uat-runbook.md) | [Импорт и экспорт](04-import-export/README.md): замена, cancel, reload, сеть, stale HEAD, invalid UTF-8, лимиты, exact bytes и отзыв download | Frozen assertion registry, программная загрузка, receipt schemas, команды gate/join и старые prerequisites |
| [Mind admin runbook](../mind-admin-browser-uat-runbook.md) | [Открытие](01-opening/README.md) и [доступ](06-access/README.md): rename, metadata conflict, Personal, visibility, роли и deletion | Playwright и строгая историческая схема свидетельств |
| [Settings / Connections](../settings-connections-uat-runbook.md) | [Подключения](07-connections-routing/README.md): credentials, effective scopes, revoke, общие modes | Старые machine slots и receipts; singleton writable и обязательное ordinary description не перенесены: их заменяет текущая спецификация |
| [Файловая приёмка MD-418](../../reports/2026-09-09-file-operations-acceptance.md) | [READ-05](02-reading/read-05.md), [READ-06](02-reading/read-06.md): list/grep/read, полнота и exact revision | Исторические результаты, latency samples и differential automation |
| [ChatGPT host](../../reports/2026-09-10-release-0.4-chatgpt-host-acceptance.md) | [READ-05](02-reading/read-05.md), [FILE-04](05-files/file-04.md): восстановление и реальные PDF/ZIP bytes | Старые grants/hashes и разрешения; новая проверка использует синтетические данные, не прежний Personal corpus |
| [Multi-Mind ChatGPT](../../reports/2026-09-11-multi-mind-chatgpt-acceptance.md) | [ROUTE-02](07-connections-routing/route-02.md), [ROUTE-06](07-connections-routing/route-06.md): несколько назначений, только в A, no-op | Исторический approval и cleanup; не переносить временные разрешения прошлого run |
| [Полная автоматическая приёмка](../autonomous-acceptance.md) | [Запись](03-writing/README.md), [routing](07-connections-routing/README.md): unknown commit, scope/ACL, partial success, injection и Personal → shared | Шестикомпонентный runner, compaction, recovery injection, redeploy и performance telemetry остаются автоматической системой |
| [Assisted pilot](../uat-pilot-protocol.md) | Пользовательская последовательность connect → полезное чтение → запись → история → export представлена CONNECT-01, READ-01, WRITE-01, READ-03, EXPORT-01 | Cohorts, consent, 4-недельные наблюдения и исследование спроса — другой процесс |

У новых обычных ручных прогонов шаги и результаты ведутся по карточкам,
не второй копией списка в release report. Отчёт ссылается на ID и результат.
Frozen matrices старых gates здесь не удалены и не ослаблены: их удаление
изменило бы автоматическую систему и могло бы затронуть параллельный релиз.
Для явно запрошенного старого strict gate продолжает действовать его контракт.

Это первичный перенос выбранных источников, не аудит всех исторических
отчётов проекта. Не перенесённые compaction, redeploy, expiry, полный набор
viewport и provider failure не считаются покрытыми этим каталогом.
