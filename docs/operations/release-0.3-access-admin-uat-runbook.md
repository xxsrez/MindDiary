# Проверка access-admin lifecycle в Release 0.3 UAT

Статус: accepted procedure MD-354, 2026-08-28. Процедура относится только к
restricted UAT Mind Diary. Она не создаёт external accounts, не меняет Sites
audience/operator allowlist и не разрешает production.

## Результат и граница доказательства

Один exact candidate и один exact UAT deployment должны пройти полный access
lifecycle на трёх уже существующих actors из
[restricted-UAT pool](uat-test-account-pool.md): `UAT-OPERATOR`,
`UAT-MIND-ROLE` и `UAT-ORDINARY`. Роли исполняются последовательно теми же
actors; новый пользователь, email-получатель или standing credential не нужны.

Проверка связывает четыре независимых источника:

1. exact-candidate local receipt из трёх-principal synthetic browser carrier,
   synthetic multi-principal carrier и targeted invitation/membership/transfer
   suites;
2. fresh `mind-diary/uat-test-account-pool-readiness/v2` receipt с exact тремя
   ordered actor fingerprints;
3. live Sites candidate/deployment read-back;
4. same-run in-app Browser, REST и content MCP observations с cleanup.

Local gate всегда пишет `hosted_status=not-run`. Offline join всегда остаётся
`hosted_evidence=false`, `acceptance=nonterminal`: он проверяет shape, hashes и
lineage, но не аутентифицирует происхождение Sites/Browser observation. Только
root release owner, сохранивший прямой live tool provenance, может признать UAT
row terminal.

## Local exact-candidate gate

Из clean exact candidate создайте private temporary directory с mode `0700` и
передайте новый, ещё не существующий output path:

```sh
npm run gate:release-0.3-access-admin -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --evidence-out <private-0700-directory>/access-admin-local.json
```

Runner принимает только SHA и private output path. Identity, email, session,
URL, token, Mind name/ID, role или fixture content не являются CLI inputs.
Внутри он запускает:

- `synthetic-multi-principal` для current ACL, Web/MCP/history revoke,
  ownership, restart и negative cleanup;
- `synthetic-browser` для трёх ephemeral principals, server-bound pages,
  REST/MCP, visibility, reader/editor/transfer и operator boundary;
- targeted invitation lifecycle, role/leave, ownership, visibility/catalog и
  closed MCP exposure suites.

Local receipt связывает exact SHA с hashes carrier receipts, test stdout и
каждого исполняемого source. Он не считается Sites, browser-session или
three-account pool evidence.

## Hosted setup

Перед первой mutation root release owner:

1. сверяет exact candidate, Sites project/version/deployment и успешное
   состояние deployment через Sites control plane;
2. получает fresh pool readiness receipt для того же candidate/deployment;
3. проверяет ровно три distinct short-lived session references через private
   environment; значения не печатаются и не попадают в receipt;
4. перечитывает pool baseline: нет временных ordinary Mind roles и per-run MCP
   tokens, audience и operator allowlist точны;
5. создаёт deterministic run fingerprint только для transient recovery и fresh
   private ordinary Mind через `UAT-MIND-ROLE` normal Site command;
6. выпускает отдельные one-hour `content:read`/`content:write` tokens только
   там, где текущая роль это допускает; show-once secrets остаются в памяти.

Runner никогда не provision-ит account, не вводит password/MFA/passkey, не
добавляет audience viewer, не меняет operator allowlist и не использует
существующий personal token. `UAT-OPERATOR` остаётся nonmember обычного Mind и
используется для bounded operator/pool read-back.

## Same-run последовательность

Каждый пункт заканчивается свежим Browser page, REST metadata и MCP/content
read-back. Следующий пункт не использует прежний UI snapshot или cached role.

1. `UAT-MIND-ROLE` создаёт private Mind и является единственным Owner.
   `UAT-ORDINARY` получает одинаковый non-enumerating denial через exact page,
   REST, MCP discovery/resolve и history/content read.
2. Owner создаёт Reader invitation для exact registered `UAT-ORDINARY`.
   Pending invitation имеет server-issued seven-day `expires_at`, не является
   membership и не даёт access. Owner отменяет её, перечитывает terminal
   `cancelled`, затем reissue создаёт ровно одну новую pending invitation со
   fresh seven-day expiry; старая не может быть принята.
3. Target reject-ит отдельную pending invitation; state становится `rejected`,
   membership не появляется. Новый exact invite принимается один раз; replay
   не создаёт duplicate membership.
4. В Reader state Browser/REST/MCP/content read разрешены, write target,
   content commit и membership management запрещены.
5. Owner повышает target до Editor. Fresh read-back разрешает content write и
   отдельный deterministic commit, но не membership management. Stale role,
   HEAD или write target не создают partial revision.
6. Owner повышает target до Admin. Fresh read-back разрешает только базовое
   Reader/Editor management; другой Admin и Owner остаются недоступны.
7. Owner атомарно передаёт ownership этому active Admin. Сразу после команды
   существует ровно один Owner; прежний Owner становится Admin. HEAD/history
   и controlled fixture commit остаются неизменными.
8. Новый Owner отзывает прежнего Admin. Следующие Browser/REST/MCP/content и
   exact history requests получают private non-enumerating denial.
9. Новый Owner повторно приглашает прежнего Owner как Reader. После accept
   Reader получает только read, затем normal `leave` немедленно возвращает его
   в private nonmember denial.
10. Новый Owner переключает Mind `public → unlisted → private`. В `public` и по
    exact `unlisted` route authenticated nonmember имеет только
    reader-equivalent live HEAD/history access: ни content write, ни member,
    visibility или ownership mutation. Public catalog и unlisted exact-only
    semantics проверяются отдельно. Возврат в private закрывает access на
    следующем request без existence leak.
11. Modern content MCP `tools/list` должен совпасть с закрытым exact inventory.
    В нём отсутствуют membership/invitation/visibility/ownership mutations;
    REST/Site остаётся единственной control-plane authority.
12. Runtime restart либо controlled same-candidate redeploy не меняет current
    role/visibility/HEAD. После него повторяются sole-owner, private revoke и
    content read-back.

`expires_at` в hosted row доказывает pending expiry policy и отсутствие access,
а executable local lifecycle suite отдельно исполняет фактический expiry job с
управляемыми часами. Hosted run не ждёт семь дней и не добавляет clock-control
surface в product.

## Hosted observation contract

Private observation имеет schema
`mind-diary/uat-release-0.3-access-admin-observation/v1` и содержит только:

- exact candidate/deployment/project/version status;
- pool receipt hash и три ordered opaque actor fingerprints;
- exact 18-name content MCP catalog;
- закрытые state/invitation/assertion rows;
- boolean read-back и cleanup matrix;
- UTC observation time и artifact hash.

Запрещены email/alias mapping, account/principal/Mind/member/invitation/token ID,
session reference, bearer/cookie, URL, private name, content/path, raw request,
response body или provider envelope. Product IDs сравниваются только в памяти;
receipt сохраняет лишь Sites project/version/deployment lineage и независимые
pool fingerprints.

## Cleanup и recovery

Успешный и аварийный run применяют один порядок:

1. остановить новые writes и разрешить любой unknown outcome read-only
   members/invitations/token/Mind read-back того же run;
2. revoke все per-run tokens и доказать denial следующего MCP request;
3. cancel оставшиеся pending invitations, revoke/leave все run roles и
   перечитать sole Owner до deletion;
4. проверить private visibility и deterministic run Mind, затем удалить только
   его normal Owner command;
5. доказать exact Mind absence, отсутствие временных roles/tokens и fresh pool
   baseline;
6. отдельно перечитать unchanged audience и operator allowlist;
7. удалить private browser profiles/files и transient secret references.

Новый nonce поверх `unknown_external_outcome` запрещён. Сначала выполняется
same-run reconcile и reduce-only cleanup. Drift sole Owner, visibility,
candidate/deployment или pool fingerprints останавливает deletion и требует
fresh read-back.

## Offline structural join

Все inputs и output находятся в private `0700` temp directory; input/output
files имеют exact mode `0600` и не являются symlinks:

```sh
npm run join:release-0.3-access-admin -- \
  --local-evidence <private-path>/access-admin-local.json \
  --pool-evidence <private-path>/pool-readiness.json \
  --hosted-observation <private-path>/access-admin-hosted.json \
  --output <new-private-path>/access-admin-join.json
```

Join fail closed проверяет hashes, exact three-actor order, candidate/deployment,
pool receipt binding, closed role/invitation/surface rows, exact MCP catalog,
cleanup и privacy. Даже полный structural join не заменяет direct live Sites и
in-app Browser provenance и не разрешает production.

## Оставшиеся hosted rows до terminal MD-354

- exact candidate и succeeded UAT deployment read-back;
- fresh exact three-account pool readiness receipt;
- same-run Browser/REST/MCP/content observation всей последовательности;
- run-owned token/Mind/role cleanup и fresh pool-baseline read-back;
- root-held live tool provenance, связывающий observation с этим run.
