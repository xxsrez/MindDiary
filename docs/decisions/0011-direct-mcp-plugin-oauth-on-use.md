# ADR-0011: Direct MCP plugin и OAuth при первом использовании

Статус: accepted, 2026-08-20. Частично заменяет distribution-решение
[ADR-0010](0010-oauth-marketplace-connector.md) для Codex Desktop/CLI pilot
релиза 0.1. Server-side OAuth и security boundaries ADR-0010 сохраняются.
Validation carrier fresh external account уточнён
[ADR-0012](0012-synthetic-principal-release-gates.md): blocking стала
automated package/OAuth/transport matrix, а real external Desktop UI —
informational canary.

## Контекст

Первый Marketplace package Mind Diary ссылался на private registered app через
`.app.json` и требовал `authentication: ON_INSTALL`. Для внешнего pilot account,
который не состоит в workspace разработчика, такая схема создаёт install-time
зависимость от доступа к private `asdk_app_*` ещё до product OAuth.

Mind Diary уже публикует exact UAT MCP resource
`https://mind-diary.example.invalid/api/mcp`, OAuth protected-resource
metadata, Authorization Server metadata и public-client DCR. Поэтому Codex
Desktop/CLI может устанавливать package без registered app и начинать native
OAuth непосредственно при первом обращении к MCP.

## Решение

- Plugin релиза 0.1 распространяет `skills` и direct `mcpServers` config, но не
  содержит `apps` и `.app.json`.
- `.mcp.json` задаёт один exact UAT `url` и такой же `oauth_resource`:
  `https://mind-diary.example.invalid/api/mcp`.
- Srez Marketplace использует `installation: AVAILABLE` и
  `authentication: ON_USE`: установка завершается до OAuth, а native OAuth
  начинается при первом content tool call.
- OAuth продолжает использовать authorization code, PKCE `S256`, DCR, exact
  redirect/resource validation, read-first scopes, write step-up, refresh
  rotation и revoke. Identity binding, current ACL, token scope, immutable
  revisions, HEAD CAS и idempotency не меняются.
- Personal `mdp_v1_` tokens и оба MCP transport profiles остаются advanced
  compatibility path и не подменяют OAuth незаметно.
- Registered connector не является prerequisite Codex pilot 0.1. Отдельный
  connector может быть рассмотрен позднее только для ChatGPT Web или public
  Plugin Directory после отдельной OpenAI verification/review и нового
  принятого решения.
- Текущий target остаётся restricted Mind Diary UAT. Решение не provision-ит
  production, не расширяет Sites audience и не публикует plugin публично.

## Последствия

- Внешний pilot user не должен получать install-time запрос к private
  `/aip/connectors/asdk_app_*`; доступ к UAT и данным всё равно определяется
  Sites audience, product OAuth и текущими Mind ACL.
- Plugin version/cache snapshot становится частью exact cross-repository
  evidence наряду с MindDiary SHA и Sites deployment.
- Blocking automated acceptance обязана раздельно доказать install-before-
  OAuth, first-use OAuth, skill/tool discovery в fresh temporary context,
  bounded read и revoke/reconnect. Real external-account flow сохраняет эти
  наблюдения как informational UX canary. Install success сам по себе не
  доказывает OAuth lifecycle.
- Write smoke допустим только в явно выбранном UAT test Mind с
  `content:write`, fresh `expected_revision`, idempotency и отдельным
  подтверждением тестового изменения.

## Рассмотренные варианты

- **Оставить private registered app и добавить pilot в workspace.** Отклонено:
  это скрывает distribution defect и расширяет внешние authority boundaries.
- **Запрашивать OAuth при установке direct MCP package.** Отклонено для Codex
  pilot: package уже может установиться без data access, а `ON_USE` отделяет
  installation от authorization и соответствует фактической зависимости.
- **Ослабить OAuth или вернуть personal token как default.** Отклонено:
  packaging defect не требует менять product security model.
- **Считать direct UAT plugin production/public integration.** Отклонено:
  production не provisioned, а public-directory и ChatGPT Web conformance не
  доказаны.

Связанные документы:
[plugin и OAuth](../specs/plugin-connector.md),
[API](../specs/api.md),
[архитектура](../architecture.md),
[MVP](../specs/mvp.md),
[ADR-0010](0010-oauth-marketplace-connector.md),
[ADR-0012](0012-synthetic-principal-release-gates.md) и
[ADR-0008](0008-dev-uat-production-delivery.md).
