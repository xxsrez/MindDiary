# Product Site source candidate на 2026-08-08

Статус: repository evidence для `AND-149`; не deployment report и не live
Sites/MCP claim. Exact release SHA и production artifacts фиксирует
coordinator-owned sealed cutoff/release flow.

## Результат

Реализовано отдельное deployable приложение `apps/mind-diary-site`, а не
расширение `sites-probe`. Оно содержит собственные Vinext/Worker entrypoints,
D1 migration, package lock и `.openai/hosting.json`. Hosting manifest объявляет
созданный coordinator-owned Sites project, D1 `DB` и R2
`MIND_DIARY_BUCKET`; runtime secrets в repository не записываются.

Production composition соединяет:

- trusted Sites verified identity с account bootstrap и authenticated `/`,
  `/me`, `/{space_handle}` и `/api/v1` control routes;
- exact-Origin и principal-bound CSRF для browser mutations;
- Bearer-authenticated Streamable HTTP `POST /mcp` с custom Mind-aware content
  tools без membership/control surface;
- D1 metadata/search/audit, R2 canonical objects/export и durable background
  work для index, export, audit, invitation и expiry flows.

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
npm exec -- tsc -b apps/mind-diary-site packages/adapter-web packages/adapter-mcp packages/adapter-background packages/adapter-metadata-memory packages/adapter-metadata-sites packages/application-control packages/application-ports packages/composition-root
node --test tests/integration/product-site.test.mjs tests/conformance/product-site-packaging.test.mjs tests/integration/membership-control.test.mjs tests/integration/invitation-control.test.mjs tests/integration/control-read-services.test.mjs
node scripts/check-product-site.mjs
node scripts/check-architecture.mjs
node scripts/check-docs.mjs
```

Targeted tests проверяют packaging boundaries, browser authentication/CSRF,
registration-only bootstrap, отсутствие control tools в MCP, durable D1
reconstruction membership/invitation state и safe member/invitation read
projections. Отдельный `npm run build` в `apps/mind-diary-site` прошёл все пять
Vinext stages. Эти проверки являются repository evidence, не live Sites или
real-client conformance.

Во время isolated `npm ci` product app npm audit сообщил 20 advisories: 1 low,
4 moderate и 15 high. Automatic dependency rewrite не выполнялся; оценка и
bounded upgrade принадлежат отдельному dependency/security follow-up и не
подменяют live release gate.

## Что остаётся до production claim

Coordinator должен на одном exact candidate SHA выполнить sealed full gate,
опубликовать настоящий Sites project/version/deployment и зафиксировать:

- authenticated web/control smoke (`W`);
- persistence-after-redeploy (`P`);
- MCP Inspector для declared `2026-07-28` pair (`MI`);
- real Codex read/write/conflict/history/export flow (`CX`);
- release manifest с exact Git SHA, project, version, deployment и live URL
  (`R`).

Пока эти artifacts отсутствуют, Product Site считается deployable source
candidate, но не production deployment. Провал Sites/MCP capability gate
блокирует release и не разрешает AWS/container fallback.
