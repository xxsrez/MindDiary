# План перехода

Статус документа: `proposal`; исполнимый порядок после критического прогона.

План отделяет внутреннюю работу от настоящих внешних blockers. Каждый
внутренний gate имеет owning Task и success signal в
[реестре блокеров](blocker-register.md). Ни один этап не считается доказанным
по одному status change.

## Фаза 0. Зафиксировать small-data Release 0.1

Owning Task: MD-292.

### Действия

1. Принять одну границу: Codex-first Markdown MVP на небольшом deterministic
   dataset.
2. Amend/supersede противоречащие claims в MVP, roadmap, ADR-0016,
   storage/import specification, traceability и release profile.
3. Обновить stale top-level Project/Release descriptions: убрать retired
   AND/Linear narrative и привести current release outcome к принятой границе.
4. После fresh Task Manager read-back атомарно убрать `Release blocker` 0.1 и
   active Release composition у:
   - MD-245, MD-249–MD-250;
   - MD-260, MD-266–MD-268;
   - MD-270, MD-272–MD-275;
   - MD-284, MD-288–MD-290.
5. Сохранить их hierarchy, relations, code и evidence в следующем milestone;
   ничего не удалять и не помечать Duplicate без exact основания.
6. Оставить MD-257/MD-261 supporting work только на случай измеренного
   small-data bottleneck MD-258.

### Gate

- accepted docs и Task Manager показывают один P0 scope;
- live Project/Release descriptions не содержат retired AND/Linear либо
  противоречащие Marketplace/OAuth claims;
- final gate не зависит от BundleFile, large corpus, Google Drive или universal
  ingress;
- post-MVP Tasks не имеют `Release blocker` 0.1.

### Recovery

Version conflict требует fresh read-back и повторного применения только
неустаревшей части решения. Partial reclassification не считается успехом и
не скрывается cleanup-ом.

## Фаза 1. Собрать один integration baseline

Owning Task: MD-301. MD-292 блокирует эту фазу.

### Действия

1. Зафиксировать common ancestor `eca3400`, `main` и candidate `1df46ec`.
2. Для каждого из 21 candidate commits записать disposition:
   `integrate | already superseded | post-MVP preserve | reject` с причиной.
3. Conflict-aware перенести применимые P0/reusable changes в `main`; не делать
   blind merge и не дублировать семантически пересекающиеся commits.
4. Сохранить Task Manager migration, operator, runtime, security и small-data
   performance contracts.
5. Выполнить `npm ci`, один полный `npm run check`, project-docs validator и
   `git diff --check` на exact tip.
6. Push `main`, выполнить remote read-back и объявить прежний candidate только
   historical input, не release truth.

### Gate

Существует один clean remote `main` SHA. MD-295–MD-300 и final UAT используют
только его потомков.

### Failure routing

- semantic overlap → ручной hunk-level integration с disposition note;
- failing targeted test → owning engineering change;
- failing full gate → MD-301 остаётся nonterminal;
- post-MVP commit → сохранить доступным, но не возвращать outcome в P0.

## Фаза 2. Параллельно закрыть существующие release gates

Эта фаза может идти параллельно с MD-294 после MD-292, но hosted evidence
выполняется только на потомке exact baseline MD-301.

### 2.1 Release authority — MD-285–MD-287

- завершить accepted Task Manager profile/conformance;
- доказать live Project/Release selector и bounded pagination/read-back;
- исключить active Shipliner/Linear execution dependency;
- сохранить production boundary.

### 2.2 Operator gate — MD-244, MD-280–MD-283

- использовать уже созданный bounded three-principal pool;
- самостоятельно выполнить setup/verify/cleanup и privacy receipt;
- не просить пользователя создавать principals повторно;
- запросить помощь только при interactive account action, недоступном agent-у.

### 2.3 Index recovery — MD-252

- воспроизвести missing/failed exact-revision index job;
- подтвердить bounded recovery без ручной durable-data mutation;
- проверить search/read-back на exact candidate.

### 2.4 Performance — MD-258

- использовать только небольшой `starter/small` fixture;
- отделить cold sample от не менее 20 warm samples;
- проверить принятые server/connector/page budgets;
- не требовать Brain-scale, mixed corpus или file-source graph.

### Gate

MD-244, MD-252, MD-258 и MD-285 имеют exact-candidate evidence либо остаются
открыты с причинным internal failure. Они не превращаются во «внешний blocker»
из-за отсутствующего тестового входа, который можно создать самим.

## Фаза 3. Закрыть IA/security contract до UI code

Owning Task: MD-294. MD-292 блокирует эту фазу.

### Зафиксированные решения

1. Routes: `/settings/connections`, opaque actor-owned detail route,
   `/settings/developer/mcp`, `/help/codex`; `/settings/mcp` совместим.
2. Raw grant/token IDs не попадают в URL; unknown/foreign connection одинаково
   возвращаются как 404 до metadata read.
3. OAuth read-first: initial grant — `content:read`; writable controls закрыты
   до native step-up, инициированного первой write intent в Codex.
4. Connections читает bounded active OAuth grants; Advanced MCP отдельно
   читает bounded active/inactive personal-token history. Retained revoked
   OAuth history не обещается без отдельной OAuth projection.
5. MVP credential hygiene — revoke + hide; hard delete и retention policy не
   входят в 0.1.
6. Automatic capture отсутствует в ordinary Connections/onboarding и остаётся
   Advanced/post-MVP capability.
7. Origin, CSRF, actor ownership, binding CAS, scopes и fail-closed revoke
   сохраняются.

### Gate

Specs и objective contract tests описывают route/ref/state/query boundaries.
После этого MD-294 разблокирует MD-295–MD-298 и MD-300.

Fresh-host incremental OAuth consent остаётся live gate, а не доказанным
свойством contract tests. Silent fallback на initial read+write запрещён; если
host не поддерживает step-up, требуется явное product decision до изменения
scopes или user-facing claim.

## Фаза 4. Реализовать bounded product flow

Prerequisites: MD-301 и MD-294.

### MD-295 — routes и server projections

- физически разделить Connections, detail, Advanced MCP и Codex Help;
- сохранить `/settings/mcp` entrypoint;
- реализовать identical 404, signed-out behavior и reserved routes;
- не включать personal-token history или bindings невидимой page в response.

### MD-296 — access UX и write step-up

- показывать readable Minds после initial OAuth;
- не показывать writable access как доступный до `content:write`;
- первая write intent запускает step-up;
- после него разрешить 0..1 writable Mind с current binding CAS;
- не показывать automatic capture в ordinary access editor.

### MD-297 — credential history

- bounded active OAuth query для Connections;
- separate active/inactive personal-token queries для Advanced MCP;
- bounded page size и opaque stable cursor;
- binding state только для visible page или exact detail;
- test fixtures `0 / 1 / page_size + 1`;
- revoke + hide вместо physical cleanup.

### MD-298 — onboarding

- primary flow: Install → Authenticate for reading → Choose readable Minds;
- write-step-up объяснять только рядом с первой записью;
- personal tokens, protocol mechanics и capture убрать из primary copy;
- starter/recovery material оставить в Help.

### Gate

Targeted unit/integration/security tests проходят на одном MD-301 baseline.
Client-side collapse без bounded server reads не считается выполнением.

## Фаза 5. Добавить настоящий browser gate

Owning Task: MD-300. Prerequisites: MD-301 и MD-294.

### Действия

1. Запустить реальный browser DOM против deterministic fixture server.
2. Зафиксировать runner/version, browser-binary install/cache strategy и
   deterministic fixture lifecycle в CI, без зависимости от локального
   browser state.
3. Проверить desktop/mobile, keyboard, focus order, accessibility-tree names,
   headings/dialogs и overflow.
4. Пройти четыре routes на fixtures `0 / 1 / page_size + 1`.
5. Включить non-zero gate в repository acceptance path.
6. Сохранять только privacy-safe result; не включать corpus, credentials,
   email или durable user IDs.

### Gate

MD-300 passing evidence блокирует MD-299. HTTP/regex synthetic gate остаётся
полезным security test, но не подменяет browser acceptance.

## Фаза 6. Выпустить и проверить connection flow

Owning Task: MD-299.

### Candidate sequence

1. Freeze exact descendant MD-301 baseline.
2. Project-profile dev smoke P0 web/control/MCP flows.
3. Publish exact candidate в UAT и reconcile deployment identity.
4. Refresh Marketplace/plugin snapshot и открыть fresh Codex context.
5. Выполнить MD-300 deterministic browser evidence.
6. Выполнить fresh real-account Marketplace install/OAuth canary.
7. Проверить, что incremental consent действительно появляется на first write;
   не подменять failure более широким initial scope без принятого решения.
8. Проверить read-first, first-write step-up, rebind, stale binding и revoke.
9. Проверить active OAuth list, token history/detail page time, rendered size и
   bounded reads.
10. Сохранить redacted exact SHA/deployment/package receipt.

### Gate

Без fresh real-account canary user-facing claim остаётся blocked. Renderer,
synthetic principals и contract tests его не подменяют.

### Failure routing

- route/DOM/accessibility failure → MD-295/MD-300;
- access/binding/scopes failure → MD-296;
- paging/latency/unbounded reads → MD-297;
- copy/journey failure → MD-298;
- stale package/catalog → refresh/reinstall/reconcile до blocker-report;
- account consent/MFA/approval, недоступные agent-у → внешний blocker по форме
  из `blocker-register.md`.
- host не предлагает incremental consent после fresh install/retry →
  platform-boundary report и явное product decision; silent fallback запрещён.

## Фаза 7. Провести final first-user UAT

Owning Task: MD-293.

### Required incoming gates

- MD-292 normative boundary;
- MD-301 integration baseline;
- MD-244 operator outcome;
- MD-252 index recovery;
- MD-258 small-data performance;
- MD-285 release authority;
- MD-299 connection UAT.

### Final matrix

1. Fresh package/skill/tool catalog.
2. Read-only OAuth reads and cannot write.
3. First write triggers step-up; `write_binding_id` ограничивает один Mind.
4. Three-principal isolation.
5. Starter read/search/write/history/export на небольшом Mind.
6. UI/MCP access parity, stale binding и immediate revoke.
7. Exact artifact/deployment/package provenance и privacy-safe receipt.
8. Все remaining nonterminal Tasks явно принадлежат post-MVP milestone.

### Terminal conditions

- ordinary setup физически состоит из трёх понятных действий;
- credentials, access settings и developer material разделены;
- один exact UAT candidate проходит deterministic и real-account matrices;
- Release 0.1 не содержит post-MVP blockers;
- каждый P0 Task имеет owning evidence и terminal status;
- production не заявляется и не deploy-ится.

## Внешний blocker policy

Подтверждённых внешних blockers на момент плана нет. Agent обязан сначала
самостоятельно выполнить кодовый fix, создать bounded test input, refresh
connector, deploy/reconcile UAT и классифицировать browser/product failure.

Если после этого остаётся внешняя граница, blocker-report содержит Tasks,
проверенные альтернативы, одного actor, одно минимальное действие и observable
resume signal. Общая просьба «проверь вручную» запрещена.
