# Synthetic browser Product Site gate

Статус: accepted test-only operational contract для MD-276/MD-277/MD-278/MD-279,
2026-08-23. Gate блокирует local exact-candidate release row и не является
hosted Sites/browser evidence.

## Назначение

`npm run gate:synthetic-browser` поднимает настоящий `Product Site` runtime над
изолированными Fake D1/R2 adapters и создаёт три обычных ephemeral principal:
Owner, Participant и service operator. Каждый actor получает свой loopback HTTP
listener, замыкающий server-bound trusted identity snapshot. Запрос не может
выбрать identity через route, query, body, cookie или client header; listener
сам связывает request с runtime identity reader. Все account, membership, ACL,
MCP, revision, index, audit и cleanup операции проходят через обычные Product
Site commands.

Это local blocking composition, а не product login, test user, impersonation,
storage seed, hosted deployment или production switch. `synthetic-test` можно
выбрать только constructor-only harness; default Product Site provider остаётся
`openai-sites`.

## Запуск

В clean exact candidate:

```bash
npm run gate:synthetic-browser -- \
  --candidate-sha <exact-HEAD-sha> \
  --evidence-out <private-temp-path>/synthetic-browser-evidence.json
```

CLI принимает только `candidate_sha` и private `evidence_out`. SHA обязан
совпадать с текущим `HEAD`. Receipt пишется с mode `0600` и schema
`mind-diary/synthetic-browser-evidence/v1`; он не содержит email, token,
cookie/header, internal ID, content, query, path, signed URL или actor mapping.

## Blocking matrix

Gate проверяет реальный Product Site HTML и HTTP API:

1. page-first registration/CSRF bootstrap, distinct ordinary principals и
   Personal Minds; spoofed identity headers не меняют server-bound session;
2. private non-enumeration через exact route/UI и API, `public` catalog,
   `unlisted` exact route и immediate private revoke;
3. pending invitation denial, accept Reader, Reader write denial, Editor
   binding/commit и atomic ownership transfer;
4. reconstruction над теми же D1/R2 adapters с сохранением account, ACL,
   HEAD/history и UI;
5. operator UI и API с pagination, search/sort, empty/never-active states;
   ordinary principal и ordinary-Mind role fail closed, а denied request не
   меняет activity projection;
6. membership revoke после restart, ordinary Mind deletion, token/account
   cleanup, background drain и negative state scan.

Каждая проверка входит в закрытый registry в
`scripts/run-synthetic-browser-gate.mjs`. Пропущенная проверка, browser/API
failure, stale state или недоказанный cleanup означает `failed`.

## Evidence и hosted boundary

`dev.synthetic-browser` — required blocking local row. Его artifact связывается
с exact candidate SHA и не может быть заменён source assertion или старым
receipt. Browser APIs/hosted session в локальном runner не подменяются: ручной
Sites canary остаётся отдельным informational `P9-Sites-Canary` из
[`uat-multi-principal-runbook.md`](uat-multi-principal-runbook.md), с двумя
реальными platform-authenticated sessions и отдельной persistence/revoke
проверкой.

При остановке процесса runtime закрывает listeners и isolated adapters. Если
negative scan или close не доказаны, row остаётся failed; UAT/production state
не затрагивается.
