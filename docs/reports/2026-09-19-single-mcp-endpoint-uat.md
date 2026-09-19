# Один MCP endpoint: UAT 2026-09-19

Статус: опубликовано в UAT; production не затронут. Решение —
[ADR-0031](../decisions/0031-single-mcp-endpoint.md).

## Изменение

Единственный content endpoint — `/api/mcp`, протокол `2026-07-28`.
Legacy handler, второй клиентский config, выбор профиля и legacy ветви
активных проверок удалены. Файловый input, ACL, scopes и stored data contracts
сохранены. Исторические отчёты не переписывались.

## Проверенный artifact

- Monorepo candidate: `9d4f5ce4f8ff1ae45422f18a4cc7c9c1cc1c6725`.
- Full CI: [35437459716](https://github.com/xxsrez/MindDiary/actions/runs/35437459716),
  success: 1276 tests passed, 3 skipped; 70 browser tests passed; прочие
  aggregate checks и separate acceptance artifact passed.
- Source mirror: `17c24fc824d7ad7a8144255e3ee593301bc8fc5c`;
  tree `3d1475d6a94c1e2f81fce1ea2f50ac4776094bc1` совпадает с candidate subtree.
- Site project: `appgprj_example1428fe59b5d8381c`.
- Saved version: 184,
  `appgprj_example1428fe59b5d8381c~appgver_exampled0575516df4db760`.
- Deployment: `appgdep_exampled7657e85fd230f1d`, succeeded.
- Local upload SHA-256: `a92e613b14268bfcfad39b6a7dbce9b363258bddd9bdf3d5de957b7c48750d68`.
- Provider archive SHA-256: `c6c874bbdd82fb401567a2bacd1bf653354b613ed2db5be28536a86aa3064e29`,
  56 files; save и read-back совпали. Provider нормализует upload archive.
- Product artifact gate подтвердил candidate/tree/server hash и clean checkout.

## Live read-back и подключение

На [UAT](https://mind-diary.example.invalid) проверены:

- GET и POST обоих удалённых адресов — 404 `route_not_found`.
- GET `/api/mcp` — 405 stateless POST-only; POST без Bearer — 401.
- Authenticated browser UI и ChatGPT help показывают один URL `/api/mcp`.
- Старый установленный ChatGPT custom app всё ещё использовал legacy URL;
  его реальный вызов получил 404. URL этой записи не редактируется в UI.
- Уже существующий modern app `asdk_app_example7751478055590638`
  подключён через OAuth, сохранён под именем `Mind Diary UAT` с прежним
  рабочим описанием. Refresh actions вернул HTTP 200 и 26 инструментов,
  включая `stage_bundle_file`. Его URL read-back — `/api/mcp`.
- Старый plugin `asdk_app_example00fe5a61e7e90d1b` удалён из
  установленных. Его developer definition не удалялось безвозвратно.
- Локальная конфигурация Codex уже указывает на `/api/mcp` с OAuth.

Ограничение: каталог tools открытой задачи остался привязан к удалённому
plugin и после переключения получил `Unknown tool`. Свежий model tool call
через заменённую запись в этой задаче не проверен; successful Refresh actions
доказывает hosted discovery/catalog, но не такой вызов и не запись файла.
Локальный полный прогон до коммита также встретил ограничения backup tests
(dirty checkout и непереносимый Homebrew Node); полный exact-candidate CI
на штатном Node/Linux прошёл.
