# План Personal description и маршрутизации

Статус: реализация начата 2026-09-05, Issue Grinder Соло.
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

1. Domain/storage: optional metadata, null migration, routing version CAS и
   сохранение personal identity/независимых generations.
2. MCP: узкая Personal metadata operation и nullable enabled projection,
   auth/capability, idempotency, read-back, modern/compat parity. Зависит от 1.
3. Site: projection/help и mode×description; настройка description остаётся
   MCP workflow. Зависит от 1.
4. Plugin: инструкции выбора/настройки, два bounded reads и независимых
   saves/no-ops/reconciliation, source boundary и fresh-session scenarios.
   Зависит от 2. Hooks только если проверка покажет необходимость.
5. Integrated acceptance: полный gate, dev smoke и exact-artifact UAT по
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

## Статус текущего планирования

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

MD-395–398 In Review после локальной реализации и targeted tests. MD-399 In Progress.
Полный gate и dev/UAT ещё впереди.

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
- Goal active в текущем thread; MD-394/395 In Progress, MD-396–399 Todo.
- Frontier: MD-399 integrated acceptance. MD-395–398 In Review.
- Marketplace source: `../Srez Marketplace/plugins/mind-diary`, package
  `0.1.0+codex.20260905180700`. Canonical skill/plugin validators прошли;
  policy/schema tests 21/21; route/storage 23/23; browser base case 1/1.
  Publication/cache/fresh session ещё не подтверждены.
- Реализация: description update атомарно меняет поколение только своего Mind;
  no-op/replay без изменения. Modern/compat config-only token, CAS/restart/clear
  проверены; OAuth suite 6/6, usage storage suite 14/14 (memory и Sites).
- Checks на начале: только documentation validator и diff whitespace;
  implementation/full/dev/UAT проверки ещё впереди.
