# Целевое состояние MVP

Статус документа: `proposal`.

Этот документ уточняет пользовательскую и release-модель. Он не supersede-ит
accepted security/API contracts до отдельного принятого решения.

## Один outcome Release 0.1

Новый зарегистрированный пользователь без знания MCP терминологии:

1. устанавливает Mind Diary из Srez Marketplace;
2. при первом content action проходит native read-only OAuth;
3. видит понятный список подключений и выбирает readable Minds;
4. через Codex получает первый read result, а первая write intent запускает
   native step-up; только после него выбирается не более одного writable Mind;
5. создаёт или изменяет Memory, видит историю и получает export;
6. может немедленно отозвать connection и убедиться, что следующий вызов fail
   closed.

Это terminal product result. Operator, synthetic principals, performance и
deployment evidence нужны для доказательства этого результата, но не являются
самостоятельным пользовательским MVP.

## Целевая информационная архитектура

### 1. Connections — обычная пользовательская поверхность

Canonical route: `/settings/connections`.

`/settings/mcp` на переходный период остаётся совместимым entrypoint и ведёт
на Connections без потери понятного back navigation.

Страница содержит:

- один primary call to action `Install Mind Diary` или `Connect another app`;
- компактный список только active connections;
- client name, read/write access, last used и понятный state;
- краткую сводку `Can read: N Minds`, `Can write: <Mind | none>`;
- действия `Manage access` и `Revoke`;
- collapsed `Inactive connections` с pagination, а не полный архив в main
  flow.

Страница не показывает MCP endpoints, DCR, PKCE, protocol versions,
environment-variable snippets, raw grant IDs, `write_binding_id` или recovery
playbooks.

### 2. Connection details — управление доступом одной credential

Route: `/settings/connections/{connection_ref}`.

Здесь пользователь:

- выбирает ноль или несколько readable Minds;
- до write step-up видит read-only state без ложного writable control;
- после `content:write` выбирает ноль или один writable Mind;
- видит явный эффект переключения writable Mind;
- отзывает connection;
- получает human-readable stale/revoked/error recovery.

Server продолжает использовать current binding version и opaque
`write_binding_id`, но UI не выдаёт внутренний ID за пользовательское понятие.
Фраза `Mind bindings` заменяется на `Access to your Minds`; `Attach read-only`
— на `Allow reading`; `Bind writable Mind` — на `Allow writing to this Mind`.
Automatic capture не входит в ordinary detail page Release 0.1; существующая
capability остаётся Advanced/post-MVP и не блокирует onboarding.

### 3. Advanced MCP — personal tokens и protocol diagnostics

Route: `/settings/developer/mcp`.

Это явно advanced surface:

- создание, список и revoke personal tokens;
- active tokens по умолчанию, revoked/expired history по фильтру;
- compatibility/modern endpoints и secret-free configs;
- redacted self-check и protocol troubleshooting;
- UAT environment warning.

Personal token остаётся поддерживаемым compatibility/recovery path, но не
конкурирует с OAuth как основной способ подключения Marketplace plugin.

### 4. Codex Help — first result и recovery guides

Route: `/help/codex`.

Основной блок — ровно три шага:

1. install;
2. authenticate for reading;
3. choose readable Minds and ask Codex for the starter flow.

Write step-up объясняется рядом с первым write scenario, а не выдаётся за уже
полученное initial permission.

Starter, safe-write, restore/export и bounded conversion playbooks остаются
доступны ниже по отдельным сценариям, но не рендерятся на странице управления
credentials.

## Credential hygiene

- Revoked и expired credentials скрыты по умолчанию.
- Active list и inactive history имеют отдельные bounded server-side
  projections/cursors; скрытые rows и bindings не попадают в response.
- UAT automation использует именованные credentials, revoke и hide.
- Physical credential deletion и retention policy не входят в MVP; обычные
  пользовательские credentials не удаляются по naming heuristic.
- Каждый active OAuth grant остаётся отдельной revocable connection и получает
  безопасную различимую display label из client name и времени создания/last
  used. Consolidation нескольких grants в одну identity не входит в MVP.

## Release scope

### P0 — обязательно для MVP 0.1

- Marketplace install + OAuth on use;
- current identity/ACL/scope enforcement;
- human-readable connection access and singleton writable Mind;
- Markdown read/search/fetch/write/history/export;
- index recovery, bounded performance и exact hosted evidence;
- three-principal authorization canary;
- Task Manager как текущий release source of truth;
- новая Connections / Advanced / Help information architecture;
- один final end-to-end UAT receipt на exact deployment.

### Supporting work — только по измеренному P0 gap

- MD-257/MD-261 и другие runtime fixes используются, только если small-data
  MD-258 gate указывает на принадлежащий им bottleneck;
- они не создают отдельный release cutoff при уже достаточном consolidated
  receipt.

### Post-MVP expansion

- Brain-scale resumable import;
- BundleFile vertical slice;
- universal local/generated/provider connector ingress;
- Google Drive-specific adapter;
- multi-source reconcile coordinator;
- large-file capacity/admission profile сверх принятого MVP envelope.

Эти Tasks сохраняются: выполненный код и инженерное знание не удаляются. Но
после принятия release boundary они должны перейти в отдельный milestone или
Backlog и потерять `Release blocker` для 0.1.

## Acceptance signals

Release считается готовым только при одновременном выполнении:

1. exact Git SHA связан с exact Sites deployment и plugin package version;
2. fresh Codex context видит skill и полный ожидаемый tool catalog;
3. новый пользователь проходит Install → OAuth без personal token;
4. initial read-only grant не пишет; первый write intent запускает native
   step-up, после которого выбирается не более одного writable Mind;
5. UI показывает тот же read/write access, который реально enforce-ит MCP;
6. write использует current `write_binding_id`, stale binding/version fail
   closed;
7. three-principal matrix не даёт cross-principal leakage;
8. starter read/write/search/history/export проходит на одном выбранном Mind;
9. revoke останавливает следующий call; reconnect не оживляет старый grant;
10. Connections остаётся пригодной на mobile и с keyboard/screen-reader;
11. advanced details не находятся в primary onboarding;
12. list/detail/history используют bounded server-side reads на небольшом
    fixture `0 / 1 / page_size + 1`;
13. fresh real-account Marketplace/OAuth canary проходит; deterministic tests
    не подменяют этот user-facing signal;
14. privacy receipt не содержит corpus, credentials, email или raw provider
    payload.
