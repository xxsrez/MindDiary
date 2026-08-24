# ADR-0019: Release 0.1 — Codex-first Markdown и small-data boundary

Статус: accepted, 2026-08-24. Решение уточняет terminal scope Release 0.1 и
частично заменяет release-applicability частей
[ADR-0015](0015-versioned-bundle-files.md),
[ADR-0016](0016-sites-storage-capacity-import.md) и
[ADR-0018](0018-file-ingress-contract-and-source-capability-matrix.md), а также
только validation-carrier classification real external first-user flow в
[ADR-0010](0010-oauth-marketplace-connector.md),
[ADR-0011](0011-direct-mcp-plugin-oauth-on-use.md) и
[ADR-0012](0012-synthetic-principal-release-gates.md).
Их технические, security и compatibility invariants сохраняются. Synthetic
automation остаётся blocking и дополняется, а не заменяется real-account flow.

## Контекст

Release 0.1 одновременно требовал first-user Codex workflow и три самостоятельных
расширения: `BundleFile`, Brain-scale storage/import/export и universal file
ingress. Из-за этого проверка небольшого Markdown-first MVP зависела от native
file transport, large-corpus capacity и source adapters, хотя принятый
performance gate уже использует небольшой детерминированный `starter/small`
dataset.

Эти расширения полезны, частично реализованы и имеют собственное evidence, но
не нужны, чтобы проверить основной пользовательский результат: человек
устанавливает Mind Diary, проходит read-first OAuth, явно выбирает readable
Minds и не более одного writable Mind, после write step-up читает и безопасно
изменяет Markdown knowledge corpus, видит историю и получает переносимый export.

## Решение

Terminal scope Release 0.1 ограничен Codex-first Markdown MVP на небольшом
детерминированном dataset. В обязательный P0 входят:

- Marketplace install и native read-first OAuth с отдельным write step-up;
- `0..N` явно подключённых readable Minds и `0..1` exact writable Mind;
- Markdown/OKF 0.2 read, browse, search, fetch, validate, immediate CAS write,
  immutable history, restore-as-new-revision и deterministic `MD-OKF-ZIP-1`
  export;
- index recovery и измеренный `starter/small` performance budget;
- three-principal authorization/operator evidence;
- единый Task Manager/Git integration baseline;
- Connections / Advanced MCP / Codex Help information architecture;
- один blocking real-account first-user UAT receipt на exact candidate и Sites
  deployment.

`BundleFile`, Brain-scale delta/capacity/import/export, universal file ingress,
Google Drive/provider adapters и их hosted canaries являются post-MVP graph.
Их код, Tasks, relations, contracts и evidence сохраняются; их отсутствие,
неполное UAT evidence или failure не блокируют terminal Release 0.1 и не входят
в его final receipt.

Canonical P0 Task set этого release boundary: `MD-244`, `MD-252`, `MD-258`,
`MD-280`–`MD-283`, `MD-285`–`MD-287`, `MD-291`–`MD-301`. Статусы этих Tasks
всегда читаются live; список фиксирует composition, а не historical status.
Backlog исключён. Tasks, перечисленные в recovery blocker register как
non-blocking, не возвращаются в 0.1 через code presence или conditional smoke.

MD-257 и MD-261 могут вернуться в P0 только как bounded supporting fix, если
измеренный `starter/small` MD-258 scenario показывает конкретный release-budget
gap. Large corpus, Brain-shaped fixture, mixed-file scenario, Google Drive или
generic ingress не могут использоваться как скрытый prerequisite этого gate.

## Последствия

- BF/FI/SI rows остаются технической post-MVP traceability, но не участвуют в
  вычислении Release 0.1 readiness.
- Реализованные file/scale capabilities не удаляются и не выдаются за hosted
  support без exact evidence.
- Release profile считает изменённой release surface только P0 capability;
  изменение сохранённого post-MVP кода само по себе не активирует UAT row 0.1.
- Project/Release descriptions Task Manager могут оставаться исторически
  устаревшими, пока adapter не предоставляет supported mutation. Они
  non-authoritative: current scope задают exact Release composition, relations,
  accepted repository contracts и live task read-back.
- Production остаётся не provisioned и manual-only; это решение относится
  только к UAT Release 0.1.

## Отклонённые варианты

- **Удалить уже реализованные file/scale capabilities.** Это уничтожило бы
  полезный post-MVP прогресс и не требуется для честной release boundary.
- **Оставить BF/FI/SI conditional gates.** Любая touched post-MVP path снова
  сделала бы расширение скрытым условием Markdown MVP.
- **Считать external first-user flow informational.** Release проверяет именно
  реальный first-use путь, поэтому synthetic automation остаётся необходимой,
  но не заменяет blocking real-account receipt.
- **Расширить 0.1 до production.** UAT не является product production;
  production требует отдельного target, workflow и явного подтверждения.
