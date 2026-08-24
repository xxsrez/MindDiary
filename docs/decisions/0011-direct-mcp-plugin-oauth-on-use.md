# ADR-0011: Direct MCP plugin и OAuth при первом использовании

Статус: accepted, 2026-08-20; compatibility transport уточнён 2026-08-24.
Частично заменяет distribution-решение
[ADR-0010](0010-oauth-marketplace-connector.md) для Codex Desktop/CLI pilot
релиза 0.1. Server-side OAuth и security boundaries ADR-0010 сохраняются.
Validation carrier fresh external account уточнён
[ADR-0012](0012-synthetic-principal-release-gates.md): blocking стала
automated package/OAuth/transport matrix. Validation classification real
external Desktop flow уточнена
[ADR-0019](0019-release-0-1-codex-first-small-data-boundary.md): один final
first-user UAT receipt теперь blocking.

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

Live capability gate затем подтвердил, что default Codex lifecycle требует
изолированный compatibility endpoint `/api/mcp/2025-11-25`, хотя canonical
OAuth resource и token audience остаются `/api/mcp`. Это уточнение не меняет
server-side OAuth или application semantics решения.

## Решение

- Plugin релиза 0.1 распространяет `skills` и direct `mcpServers` config, но не
  содержит `apps` и `.app.json`.
- `.mcp.json` задаёт проверенный default-Codex transport
  `https://mind-diary.example.invalid/api/mcp/2025-11-25` и отдельный
  canonical `oauth_resource`
  `https://mind-diary.example.invalid/api/mcp`.
- Srez Marketplace использует `installation: AVAILABLE` и
  `authentication: ON_USE`: установка завершается до OAuth, а native OAuth
  начинается при первом content tool call.
- OAuth продолжает использовать authorization code, PKCE `S256`, DCR, exact
  redirect/resource validation, read-first scopes, write step-up, refresh
  rotation и revoke. Identity binding, current ACL, token scope, immutable
  revisions, HEAD CAS и idempotency не меняются.
- Personal `mdp_v1_` tokens остаются advanced compatibility path. OAuth
  access token с canonical audience `/api/mcp` принимается как modern, так и
  изолированным default-Codex compatibility adapter; lifecycle двух profiles
  не смешивается внутри одного request.
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
- Transport URL и `oauth_resource` проверяются раздельно: первый фиксирует
  доказанный client lifecycle, второй — security audience. Равенство этих
  полей не является invariant.
- Blocking automated acceptance обязана раздельно доказать install-before-
  OAuth, first-use OAuth, skill/tool discovery в fresh temporary context,
  bounded read и revoke/reconnect. Real external-account first-user flow
  дополнительно доказывает host/UI lifecycle на exact UAT candidate и входит в
  terminal receipt 0.1. Install success сам по себе не доказывает OAuth
  lifecycle.
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
