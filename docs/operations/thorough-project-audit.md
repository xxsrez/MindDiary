# Полный тщательный аудит Mind Diary

Статус: accepted operational runbook, 2026-09-20. Этот документ задаёт
одноразовую проверку всего актуального продукта. Он не является release gate,
CI job, расписанием или заменой соразмерной приёмки.

## Право на запуск

Полный аудит запускается только после прямой просьбы пользователя тщательно
проверить весь проект. Крупный релиз, возраст прежнего отчёта, изменение
горячего пути, performance regression и команда `release` сами по себе такого
права не дают. До прямой просьбы допустимы только чтение этого runbook,
планирование и обычные targeted checks.

До дорогого действия controller сообщает оценку времени, локальных ресурсов и
внешних расходов. Production, реальные пользовательские данные, изменение
ACL/secrets и безвозвратные операции требуют отдельных полномочий. Hosted
проверки используют UAT и только run-owned fixtures с подтверждённым cleanup.

## Результат запуска

Аудит выпускает один каталог inventory, одну матрицу сценариев и один отчёт.
Каждая применимая строка матрицы имеет `pass | fail | blocked | not_run`, exact
Git SHA, среду, fixture, процедуру, измерения, критерий дефекта и ссылки на
evidence. `blocked` и `not_run` не считаются успехом. Абсолютная гарантия
отсутствия неизвестных дефектов запрещена.

Рекомендуемый private каталог evidence:

```text
<private-root>/<UTC-run-id>/
  inventory.json
  matrix.jsonl
  commands.jsonl
  measurements/
  receipts/
  failures/
  cleanup.json
  report.md
```

Private bodies, credentials, download URLs, verified email и реальные Mind
names не попадают в repository или публичный отчёт. Для каждого файла evidence
фиксируются SHA-256, producer command, UTC interval и candidate SHA.

## Фаза 0. Зафиксировать границы

1. Записать прямую просьбу, точный scope, разрешённые среды и расходы.
2. Создать отдельный clean checkout exact candidate. Зафиксировать `git
   rev-parse HEAD`, base SHA, `git status --short`, Node/npm versions и host.
3. Прочитать `AGENTS.md`, этот документ, delivery profile, performance gate,
   autonomous acceptance и спецификации затронутых surfaces.
4. Получить live Project/Release и сохранить только canonical refs/version.
5. До setup hosted fixtures получить полную baseline inventory. Остановиться,
   если exact candidate, UAT target, cleanup authority или rollback неясны.

## Фаза 1. Инвентаризация актуальной реализации

Инвентаризация строится заново из candidate, а не копируется из старого
отчёта. Для каждой строки сохранить source paths, public entrypoint, adapters,
durable records, background jobs, auth capability и существующие tests.

- web/control routes, REST endpoints, единственный `/api/mcp`, tools,
  resources и реальные producer profiles;
- account/Personal/ordinary Mind lifecycle, memberships, visibility, tokens,
  usage routing и current-authorization recheck;
- content read/write, preflight/commit/CAS/idempotency, history/as-of,
  browse/fetch/ranges, grep/search и revision indexes;
- staging, Markdown import, BundleFile, export/download grants, quota/capacity,
  cleanup/GC, deletion, backup/restore и migrations;
- D1/R2/search/audit adapters, queues, retry/replay/recovery и deployment
  composition;
- observability: error mapping, stage/reason, metrics, logs, telemetry privacy
  и partial-failure reporting.

Минимальные discovery-команды:

```bash
rg --files apps packages scripts tests docs
rg -n 'route|tool|resource|job|migration|transaction|cleanup|recovery' apps packages scripts
npm ci
npm run build
```

Готовый test list не заменяет source analysis. Любой найденный entrypoint без
сценария добавляется в matrix до выполнения проверок.

## Фаза 2. Построить матрицу

Каждая строка `matrix.jsonl` содержит:

```json
{
  "id": "stable-scenario-id",
  "surface": "web|control|rest|mcp|storage|background|deployment",
  "operation": "exact operation",
  "risk": "correctness|security|performance|concurrency|failure|observability",
  "fixture": "bounded reproducible fixture",
  "procedure": ["exact commands or requests"],
  "expected": ["observable invariants"],
  "metrics": ["operations", "bytes", "rows", "cpu", "memory", "latency"],
  "defect_when": ["explicit thresholds or invariant violation"],
  "layer": ["unit", "integration", "artifact", "UAT"],
  "status": "not_run",
  "evidence": []
}
```

По каждой операции сделать normal, empty, boundary и invalid варианты. Размер
файла, число файлов, revisions, Minds и principals варьировать независимо.
Обязательные data axes: Unicode и invalid UTF-8, длинная строка, большой файл,
много мелких файлов, глубокие links/dependencies, одинаковые digests и
различные visibility/role/scope состояния.

## Фаза 3. Обязательные классы проверок

### Корректность и безопасность

- immutable history, manifest/object integrity, exact revision/as-of и HEAD
  CAS; отсутствие silent overwrite или записи поверх history;
- current ACL после revoke/transfer/visibility/token change, cross-Mind
  isolation, role/scope boundaries и запрет client-supplied authority;
- prompt-injection/untrusted content, HTML/script rendering, path/URL/locator
  confusion, privacy-safe errors/logs/export;
- legacy formats и migration: read compatibility, fail-closed corruption,
  restart и rollback без reinterpretation данных.

Проверять наблюдаемое поведение и stored state, а не наличие guard в source.

### Масштабирование и ресурсы

Для каждой адресной операции измерить visited records, SQL statements/rows,
object requests/bytes, hashes, copies, serialization bytes, writes и peak
memory. Ищутся O(N) вместо lookup, O(N²), N+1, повторный full scan/rebuild,
offset pagination, no-op writes, amplification и event-loop blocking.

Использовать детерминированные counters рядом с временем. Для timing записать
warm/cold state, размеры `1x/10x/100x`, повторы, median/tail и шум. Обязательно
проверить MD-473—MD-482: producer validation, metadata snapshots/read queue,
capacity ledger, index build/cleanup/search, grep, history и ranged reads.

### Конкурентность и отказы

- одновременные commits одного и разных Minds, lost update/CAS, revoke race,
  HEAD/cursor snapshot, fairness/starvation и queue saturation;
- slow/hung D1, R2, search и model/client; deadline, cancellation и
  backpressure без утечки reader/connection;
- partial write, unknown commit outcome, retry/idempotency, crash между
  стадиями, restart/replay, stale/missing index и cleanup resume;
- повреждение metadata, manifest, body, derived index и backup; доказанный
  recovery либо точный fail-closed result.

Сценарии используют barriers/fault injection и counters, а не нестабильные
`sleep`-сравнения.

### End-to-end и hosted

После локальных доказательств собрать exact artifact и проверить применимый
vertical slice: authenticated web/control, persistence после redeploy и
доступный Codex MCP. Проверять реальные producer profiles, import/export,
history, browse/fetch/search и recovery только на run-owned UAT data.

Hosted performance выполняется по `performance-gate.md`; autonomous suite — по
`autonomous-acceptance.md`. Их receipts принимаются только при совпадении exact
candidate/deployment и восстановленном baseline. Недоступная платформа или
credential даёт `blocked`, а не synthetic `pass`. Production не используется.

## Фаза 4. Канонические команды

Из clean checkout:

```bash
npm ci
npm run check
git diff --check <base-sha>..<candidate-sha>
npm --prefix apps/mind-diary-site ci
npm --prefix apps/mind-diary-site run lint
npm --prefix apps/mind-diary-site run build
npm audit --audit-level=high
npm --prefix apps/mind-diary-site audit --audit-level=high
npm run benchmark:local-mind-scale
```

Затем выполняются matrix-specific deterministic probes и fault tests. Команды
UAT, artifact packaging/deployment/read-back берутся только из current
`ship-work-release-profile.md`; этот runbook не дублирует target или secrets.
Ни одна команда выше сама по себе не доказывает полный аудит.

## Фаза 5. Разбор каждого failure

Для дефекта сохранить минимальное end-to-end воспроизведение и фактическую
историю событий. Отчёт отделяет:

1. наблюдаемый факт и evidence;
2. подтверждённую причину либо явно помеченную гипотезу;
3. последствия и затронутые границы;
4. severity/priority;
5. минимальную автоматическую регрессию;
6. остаточный риск и неизвестное.

Новые классы дефектов добавляются в каталог matrix; заранее известные задачи
не ограничивают поиск.

## Фаза 6. Cleanup и отчёт

Остановленный или упавший run сначала возобновляет cleanup journal. Успех
hosted cleanup требует exact equality baseline/final inventory и отсутствия
run-owned credentials, Minds, objects, indexes и jobs. Неизвестный объект не
удаляется.

`report.md` начинается с решения, затем перечисляет coverage, failures,
blocked/not-run, environment/evidence и cleanup. Утверждение «всё проверено»
допустимо только как «все применимые строки этой версии matrix получили
pass»; это не гарантия отсутствия неизвестных ошибок.

## Обычная разработка — отдельный режим

Targeted tests, `npm run check`, обычный UAT smoke и выбранный performance gate
не запускают этот runbook и не получают статус полного аудита. Этот документ
не включается в `npm run check`, CI schedule, automation или release trigger.
После изменения runbook выполняются только `npm run check:docs` и
`git diff --check`, если задача не затрагивает код.
