# Product Site source candidate на 2026-08-08

Статус: исторический repository evidence для `AND-149`. Candidate впоследствии
интегрирован, исправлен для Sites MCP routing и развёрнут на Site, который с
2026-08-09 официально классифицируется как **UAT**. Слова production/owner-only
ниже сохранены в их исходном историческом смысле; exact live evidence фиксирует
[capability report](2026-08-07-sites-mcp-capability-gate.md).

## Результат

Реализовано отдельное deployable приложение `apps/mind-diary-site`, а не
расширение `sites-probe`. Оно содержит собственные Vinext/Worker entrypoints,
D1 migration, package lock и `.openai/hosting.json`. Hosting manifest объявляет
созданный coordinator-owned Sites project, D1 `DB` и R2
`MIND_DIARY_BUCKET`; runtime secrets в repository не записываются.

Candidate composition соединяет:

- platform-authenticated Sites email identity с account bootstrap и
  authenticated `/`,
  `/me`, `/{space_handle}` и `/api/v1` control routes;
- exact-Origin и principal-bound CSRF для browser mutations;
- Bearer-authenticated Streamable HTTP `POST /mcp` с custom Mind-aware content
  tools без membership/control surface;
- D1 metadata/search/audit, R2 canonical objects/export и durable background
  work для index, export, audit, invitation и expiry flows.

Source repair `AND-149:c2` заменяет статическую product-страницу в exact Worker
handler на operable server-rendered control UI. Handler теперь использует уже
существующие onboarding, shell и MCP token-management renderers, сам отдаёт
fixed same-origin CSS/SVG/client assets и поддерживает:

- явное создание нового isolated account и Personal Mind для verified, но ещё
  не зарегистрированного Sites identity без relink/merge прежнего доступа;
- authenticated `/`, `/me` и `/settings/mcp` с server-owned safe projections;
- выпуск named MCP token, показ секрета ровно один раз и последующее отображение
  только безопасной metadata;
- отзыв token через существующий control operation.

Browser mutations сохраняют exact-Origin, principal-bound CSRF и idempotency
boundaries. Browser client не использует `Authorization`/Bearer, а content MCP
по-прежнему не публикует account, membership или token control tools.

Browser UI не читает и не рендерит raw Markdown. Incoming user token не
передаётся downstream. AWS, AgentCore и отдельный container не используются как
fallback.

## Runtime settings

Sites runtime должен предоставить независимые 32-byte base64url secrets:

- `MIND_DIARY_TOKEN_VERIFIER_KEY`;
- `MIND_DIARY_LOCATOR_KEY`;
- `MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY`;
- `MIND_DIARY_CSRF_KEY`.

Optional `MIND_DIARY_PUBLIC_ORIGIN` должен быть exact canonical HTTPS origin.
Runtime fail-closed отклоняет отсутствующие/невалидные keys и несовпадающий
request origin.

## Локальное evidence

На source candidate выполнены:

```bash
npm exec -- tsc -b apps/mind-diary-site packages/adapter-web packages/composition-root
node --test tests/unit/ui-shell.test.mjs tests/unit/onboarding-client.test.mjs tests/unit/mcp-token-management-ui.test.mjs tests/integration/product-site.test.mjs tests/conformance/product-site-packaging.test.mjs
node scripts/check-product-site.mjs
node scripts/check-docs.mjs
git diff --check
cd apps/mind-diary-site && npm run build
```

32 targeted tests проверяют production-handler wiring и packaging boundaries,
browser authentication/CSRF, registration-only bootstrap, safe control read
failures, show-once token response, scalar revoke routing и отсутствие control
tools в MCP. Отдельный `npm run build` в `apps/mind-diary-site` прошёл все пять
Vinext stages.

Real-browser smoke запускал скомпилированный `createProductWebHttpHandler` и его
production client asset через локальный synthetic identity/control fixture. Он
подтвердил bootstrap до `/me`, переход в `/settings/mcp`, show-once secret,
отсутствие secret после reload, metadata-only token list и revoke до empty
state без browser console errors. Fixture не использовал живую identity,
приватный content или настоящий credential. Это repository evidence, не live
Sites или real-client conformance.

Во время isolated `npm ci` product app npm audit сообщил 20 advisories: 1 low,
4 moderate и 15 high. Automatic dependency rewrite не выполнялся; оценка и
bounded upgrade принадлежат отдельному dependency/security follow-up и не
подменяют live release gate.

## Историческая граница candidate

На момент создания этого отчёта оставалось выполнить full gate, опубликовать
Sites project/version/deployment и зафиксировать:

- authenticated web/control smoke (`W`);
- persistence-after-redeploy (`P`);
- MCP Inspector для declared `2026-07-28` pair (`MI`);
- real Codex read/write/conflict/history/export flow (`CX`);
- release manifest с exact Git SHA, project, version, deployment и live URL
  (`R`).

Эта граница больше не является текущим status: UAT deployment выполнен
наследником candidate. Exact `/mcp` действительно оказался platform-reserved
до Worker; product MCP перенесён на `/api/mcp`, а default Codex получает
изолированный `/api/mcp/2025-11-25`. Исторические сомнения и последующий
положительный live gate сохранены в связанном capability report.
