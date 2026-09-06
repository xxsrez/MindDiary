# План Personal description и маршрутизации

Статус: MD-394 и все пять дочерних задач Done, подтверждено Task Manager 2026-09-06.
Режим Issue Grinder Соло. Текущий результат и границы — в конце документа.
Project Mind Diary; live current Release 0.3; выбранный scope — MD-394 и его live подзадачи.

## Принятые требования пользователя

Нормативный источник — [режимы использования Mind](../specs/mind-usage-modes.md)
и [ADR-0025](../decisions/0025-personal-mind-description-routing.md).
Mode определяет возможность read/write, description — темы. Personal description
опционально и настраивается агентом через MCP по просьбе о настройке. Без него
Personal explicit-only; с ним — тематический. При совпадении с обоими Minds
читать оба и сохранять обсуждённое долговечное знание в оба, независимо.
Настройка не меняет mode/scopes. Personal-to-shared перенос извлечённых знаний
требует прямой просьбы. Дубликаты, background scanning и sync копий не нужны.

## План агента и зависимости

1. **Завершено (MD-395 Done).** Domain/storage: optional metadata, null migration, routing version CAS и
   сохранение personal identity/независимых generations.
2. **Завершено (MD-396 Done).** MCP: узкая Personal metadata operation и nullable enabled projection,
   auth/capability, idempotency, read-back, modern/compat parity. Зависит от 1.
3. **Завершено (MD-397 Done).** Site: projection/help и mode×description; настройка description остаётся
   MCP workflow. Зависит от 1.
4. **Завершено (MD-398 Done).** Plugin: инструкции выбора/настройки, два bounded reads и независимых
   saves/no-ops/reconciliation, source boundary и fresh-session scenarios.
   Зависит от 2. Hooks только если проверка покажет необходимость.
5. **Завершено (MD-399 Done).** Integrated acceptance: полный gate, dev smoke и exact-artifact UAT по
   [профилю доставки](../operations/ship-work-release-profile.md). Зависит от 2–4.

Реализуемое решение задачи 2: отдельная узкая credential capability
`personal:configure`, без автоматического расширения существующих grants.
Tool names и wire schema закреплены в API до реализации;
это изменяемая часть плана, не дополнительное требование пользователя.
Настройка независима от content usage mode и не раскрывает disabled corpus.

## Проверка результата

Доказать mode×null/nonempty description, explicit target, overlap/exclusions,
Personal-to-shared запрет, current ACL/scope/description race, migration/restart,
partial/unknown outcome и freshness после compaction. Два commits не атомарны
между Minds; rollback успешного первого не выполняется автоматически.
Исторический MD-382 — предшественник, не duplicate и не evidence новой реализации.

## История планирования и исполнения

Ниже сохранены прежние контрольные точки; их статусы и следующий шаг не
определяют текущую очередь. Итоговое сопоставление находится в конце.

### Первоначальное планирование

Контракт и ADR обновлены. В Task Manager созданы MD-394 (Epic) и пять
подзадач с Label Feature в релизе 0.3 (изначально Backlog):

| Task | Результат | Обязательные предшественники |
|---|---|---|
| MD-395 | Хранение description и актуальность routing | — |
| MD-396 | Настройка тем через MCP | MD-395 |
| MD-397 | Правила и режимы на Site | MD-395 |
| MD-398 | Тематическое использование в плагине | MD-396 |
| MD-399 | Полная проверка UAT | MD-396, MD-397, MD-398 |

Созданы шесть native `blocks` и одна `related` MD-394 ↔ MD-382.
Иерархия, labels, Release, статусы и направления связей подтверждены read-back.
Exact duplicate не найден; MD-382 остаётся завершённым предшествующим решением.
Пользовательских вложений нет. Authoritative статус реализации принадлежит трекеру.

MD-395–397 Done, MD-398 In Review, MD-399 In Progress.
Полный gate и CI на `9090dadf`: 1122/1122 code tests, 68/68 browser tests.
Dev и synthetic gates прошли. UAT 123 опубликован; часть hosted evidence
остаётся открытой, как перечислено в отчёте.

## Continuity Issue Grinder

- canonical_mode: solo; mode_origin: explicit; initial_main_model: gpt-6-astra;
  initial_main_effort: low; execution profile: current root; subagents: 0.
- Selector: MD-394 + native descendants, Project Mind Diary, Release 0.3.
  Backlog → Todo явно разрешён поручением пользователя начать реализацию.
- Initial scope count: 6; base: 9c0e8a6723ed9978dbce5c12bc6c181e22943421.
- Root checkout main используется как exclusive serial lane; dirty docs
  принадлежат этому разговору. Startup inventory: 4 доступных checkout,
  прочие три clean и unrelated; 93 missing/prunable записи не изменялись;
  193 branches, matching MD-394–399 candidates отсутствуют.
- Goal active в текущем thread; MD-394/399 In Progress, MD-395–397 Done, MD-398 In Review.
- Frontier: MD-399 hosted acceptance и оставшиеся scenarios MD-398.
- Marketplace source: `../Srez Marketplace/plugins/mind-diary`, package
  `0.1.0+codex.20260905180700`. Canonical skill/plugin validators прошли;
  policy/schema tests 21/21; route/storage 23/23; browser base case 1/1.
  Publication/cache/fresh prompt-input подтверждены на Codex 0.153.0.
- Реализация: description update атомарно меняет поколение только своего Mind;
  no-op/replay без изменения. Modern/compat config-only token, CAS/restart/clear
  проверены; OAuth suite 6/6, usage storage suite 14/14 (memory и Sites).
- Проверка реализации продолжается: local evidence отделяется от ещё
  не подтверждённых CI/dev/UAT и установленного пакета.

## Текущая контрольная точка

Код и пакет пунктов 1–4 реализованы и опубликованы: candidate `9090dadf`, UAT 123,
package `0.1.0+codex.20260905180700`. Пункт 5 остаётся In Progress:
локальная и synthetic приёмка прошла, hosted configuration/performance и
применимые canary ещё требуют доказательств. Полный перечень результатов и
ограничений — [отчёт](../reports/2026-09-05-personal-description-routing.md).
Goal остаётся активным; завершённой поставкой всей MD-394 это не объявляется.

## Возобновление после разрешения UAT-токенов

Пользователь явно разрешил создавать временные UAT credentials и выполнять
синтетику. Goal снова active. Три тестовых токена имеют срок один час и
подлежат отзыву после проверки. Positive config-only MCP update/read/replay/CAS
на UAT 123 прошёл; исходные Personal mode и description восстановлены.
Проверка combined scopes выявила закрытые старые validators и пропущенный
checkbox scope в browser payload. MD-396/397 переоткрыты In Progress.
Regression воспроизводит empty discovery до исправления и проходит после;
browser checkbox regression также проходит. Следующий frontier — новый exact
candidate/full gate/UAT cut, затем повторение всей hosted matrix и cleanup.

Новый candidate `d54718de` прошёл full gate, CI и три synthetic gates.
Сборка и локальный Sites mirror подготовлены. Source push остановлен runtime
approval policy `never` до запуска команды; обходов не предпринималось.
Все временные UAT tokens отозваны, настройки восстановлены. Пользовательское
разрешение на UAT тесты больше не является blocker; нужен доступ инструмента
к отправке подготовленного source. Goal остаётся active до blocked audit.

## Актуальный результат после включения Custom

Source push завершён, исправленный candidate `d54718de` опубликован в UAT 124;
deployment `appgdep_example4e0213a4ab443261` succeeded. Этап нового
выпуска завершён. Локальные проверки и CI подтверждены отдельно в отчёте.
Настройка Custom устранила прежний отказ shell; его больше не считать blocker.

Остаются незавершёнными положительные hosted проверки исправленных combined
scopes и browser checkbox, performance/canary и поведенческие сценарии
MD-398. In-app Browser сейчас не допускает открытие UAT: невозможно проверить
admin-enforced policy. Старый native MCP credential корректно не имеет нового
scope. Новые credentials не созданы; ни обхода браузерного отказа, ни изменений
пользовательского corpus не выполнялось. MD-396/397/399 и Epic In Progress,
MD-398 In Review, MD-395 Done. Полная приёмка остаётся открытой.


## Итоговая приёмка исходного результата

2026-09-06 исходный MD-394 возобновлён после ошибочной остановки на MD-400.
MD-396/397 переоткрывались из-за combined scopes и checkbox; исправления уже
в UAT127 и подтверждены повторными hosted проверками. MD-398 закрывает реальные
14 model scenarios и compaction. Для MD-399 выполнено отдельное
[сопоставление каждого критерия с источниками](../reports/2026-09-05-personal-description-routing.md#итоговое-сопоставление-md-394md-399-2026-09-06).
Полные длительные повторения не запускались. Все пять пунктов плана технически
выполнены. После native comments и read-back подтверждены MD-399 Done v6
и MD-394 Done v10; MD-395–398 также Done.
Прежние browser/approval/token blockers больше не являются текущими.
