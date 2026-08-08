# OpenAI Sites + MCP capability gate на 2026-08-07

Статус: **live gate выполнен с отрицательным результатом; release 0.1
blocked**. Этот report фиксирует локально проверенную поверхность AND-37,
exact production probe, повторную проверку exact product deployment в AND-77
и воспроизводимый отказ Sites/Codex boundary. Он не подтверждает совместимость
Codex с endpoint.

## Вывод

В `apps/sites-probe` реализован отдельный явно non-product Sites probe. Локально
подтверждены Worker routing, presence-only identity response, D1/R2 round-trip,
stateless MCP `2026-07-28`, JSON и request-scoped SSE, per-request Bearer auth,
CAS concurrency, idempotent retry и итоговое состояние после errors.

Exact production probe успешно собран и развёрнут owner-only в OpenAI Sites,
но обязательный Codex MCP flow не проходит. Последняя product version 2
подтвердила authenticated web/control slice, включая account bootstrap,
Personal Mind и lifecycle smoke для MCP token. При этом exact `POST /mcp`
снова получил `404 Not found` без соответствующего Worker event; соседние
не-exact paths прошли через обычную Sites authentication boundary с HTTP 401.
Эта совокупность наблюдений поддерживает inference о специальной обработке
exact `/mcp` до deployed Worker, но не раскрывает недокументированное устройство
платформы. Ранее проверенный `codex-cli 0.147.0` также не прошёл этот boundary.

Поэтому production release 0.1 явно blocked. Live D1/R2 persistence, JSON/SSE
и application challenge нельзя честно подтвердить через недостижимый endpoint.
Провал gate не разрешает fallback в AWS, AgentCore или отдельный container.

## Граница probe

Probe не реализует Mind Diary service: в нём нет accounts, Minds, ACL, OKF
content, revisions, search, export или control plane. Его endpoints:

| Endpoint | Что проверяет | Что не возвращает |
|---|---|---|
| `GET /probe/identity` | presence documented Sites identity headers | значения identity headers |
| `GET\|POST /probe/state` | D1 counter/CAS и R2 object round-trip | bearer credential и object body |
| `POST /mcp` | `2026-07-28` discovery, headers/body, tool call, JSON/SSE | credential, identity values и private data |

`.openai/hosting.json` объявляет logical bindings `DB` и `PROBE_BUCKET` и
фиксирует exact Sites `project_id`, созданный coordinator-ом один раз.

## Проверенные внешние контракты

По состоянию на 2026-08-07 официальный MCP `2026-07-28` требует отдельный POST
на каждое сообщение, per-request `_meta`, `MCP-Protocol-Version`, `Mcp-Method`,
`Mcp-Name` для применимых methods, обязательный `server/discover`, JSON либо
request-scoped SSE и `202 Accepted` для принятой notification. GET stream и
protocol session удалены. Probe поддерживает этот modern path и намеренно
возвращает negative response на legacy GET/DELETE/session traffic.

Текущая публичная документация Sites обещает server-side
`oai-authenticated-user-email` и optional
`oai-authenticated-user-full-name`. Она не обещает stable external subject.
Поэтому live gate требует `email_present: true`, считает full name optional, а
`user_id_present` фиксирует только как наблюдение; значения не записываются.
Durable authorization identity будущего сервиса по-прежнему должна быть
внутренним `principal_id`.

Sites также документирует D1/R2 logical bindings, добавление `project_id` после
provisioning и отдельные saved version/deployment stages. Наличие bindings в
manifest само по себе не доказывает persistence.

По состоянию на 2026-08-08 актуальная официальная страница Sites описывает
hosting websites, web apps и games, D1/R2, identity, access, secrets, versions
и deployments. Она не документирует hosting внешнего MCP endpoint или особое
поведение `/mcp`. Это граница опубликованного контракта, а не доказательство
внутреннего устройства Sites dispatcher.

Первичные источники:

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [OpenAI Sites](https://learn.chatgpt.com/docs/sites)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## Локальное evidence

Проверено 2026-08-07 в issue worktree до commit:

| Проверка | Результат |
|---|---|
| `npm run lint` внутри probe | pass |
| `npm test` внутри probe | build pass; 9 tests pass |
| `npm run gate:live` против isolated local vinext URL | pass; D1 `0 → 2`, R2 digest verified, race `200/409`, JSON/SSE `200`, session `400`, GET/DELETE `405` |

Tests используют настоящие Miniflare D1/R2 bindings. Они покрывают positive,
invalid, missing/invalid Bearer, synthetic denied tool result, retry,
idempotency conflict, concurrent CAS и восстановление после synthetic R2
failure без второго D1 increment. Identity canary values не появляются в
response body. Это local evidence, не Sites или Codex conformance.

## Выполненный live gate

### Exact artifact и deployment

- Git SHA: `bd277bd216a606df738f88a9a70552dc8cdddeee`;
- source tree: `2956f894231ea3838382d02d9b5c6e65aebfc0a3`;
- Sites project:
  `appgprj_examplefedbece6fe98eb62`;
- saved version: 1,
  `appgprj_examplefedbece6fe98eb62~appgver_exampleb2c6f0fa7c77d94f`;
- deployment:
  `appgdep_example5d92ca2b94f7082e`, `succeeded`;
- live URL:
  `https://mind-diary-capability-probe.example.invalid`;
- access: `custom`, owner-only, no external visitors или groups;
- runtime env revision: 1; Bearer value хранится как Sites secret и в evidence
  не записан.

Deployment Worker log подтверждает успешный `GET /` и presence
`oai-authenticated-user-email`,
`oai-authenticated-user-full-name` и encoding header; значения были
platform-redacted. `oai-authenticated-user-id` в наблюдаемом request
отсутствовал. Это подтверждает identity header presence на deployment-owned
authenticated request, но не обещает stable external subject.

### Наблюдаемый отказ

В 2026-08-07T02:27:33Z:

- unauthenticated `GET /probe/identity` получил dispatcher-level `401`;
- `POST /mcp` с valid probe Bearer, required MCP headers и body получил
  dispatcher-level `404 Not found`;
- в bounded Worker logs отсутствует `/mcp` invocation, поэтому Bearer не
  достиг application auth boundary;
- `codex-cli 0.146.1` с
  `bearer_token_env_var = "MIND_DIARY_SITES_PROBE_TOKEN"` и
  `required = true` завершился до session start: Streamable HTTP client
  получил `HTTP 404: Not found` при попытке `initialize`;
- credential, authorization header, identity values и private prompt/query в
  evidence не сохранены.

Это repeatable negative evidence двух независимых несовместимостей: текущий
owner-only Sites dispatch не пропускает personal Bearer MCP request к Worker,
а проверенный Codex build ещё использует initialize lifecycle вместо принятого
stateless `2026-07-28` profile.

## Повторная проверка product deployment в AND-77

### Product version 1: исходная проверка

Проверка выполнена 2026-08-08 на exact product candidate, а не на раннем
non-product probe:

- Git/main: `31bd5b8c2770ec0d954ce48674987678274591dc`;
- Sites project:
  `appgprj_example1428fe59b5d8381c`;
- saved version 1:
  `appgprj_example1428fe59b5d8381c~appgver_example55fdbe7d5526298f`;
- deployment:
  `appgdep_example3c6fb0a6d8d6580f`;
- owner-only URL: `https://mind-diary.example.invalid`;
- runtime env revision: 1.

Authenticated browser открыл `/` с HTTP 200 без console errors. Product
response сообщил только безопасный для report факт
`registration_required=true`; account bootstrap не выполнялся, поэтому
product MCP bearer token отсутствовал. Identity values, cookies и request IDs
не сохранялись.

### Достигает ли `POST /mcp` product Worker

Нет. В `2026-08-08T13:24:07Z` POST с application Bearer header получил до
Worker HTTP 404, `text/plain`, body `Not found`. Bounded Worker logs примерно в
13:33Z содержали только два authenticated GET event (`/` и `/me`) и не
содержали соответствующего `POST /mcp`.

Независимый credential-free recheck отправил корректно размеченный
`server/discover` request принятого profile, чтобы отсутствие product token не
подменять выдуманным secret:

```bash
curl --request POST 'https://mind-diary.example.invalid/mcp' \
  --header 'content-type: application/json' \
  --header 'accept: application/json, text/event-stream' \
  --header 'MCP-Protocol-Version: 2026-07-28' \
  --header 'Mcp-Method: server/discover' \
  --data '<redacted non-private server/discover JSON>'
```

В `2026-08-08T13:35:16Z` результат снова был HTTP 404,
`text/plain; charset=utf-8`, 9 bytes, body `Not found`, SHA-256
`e3ebaa16dd9d9b9fc107c42183fb6cf9d22927e1af03dbbdfa0ccc38e4e4ac31`.
Следующая bounded выборка Worker logs за пять минут вернула
`event_count=0`. Если бы request достиг application auth boundary, отсутствие
Bearer должно было проверяться Worker-ом; фактические 404 и zero Worker events
классифицируют отказ как dispatcher-level.

### Текущие клиенты

Проверенные version commands и результаты:

```text
$ npm view @modelcontextprotocol/inspector version bin --json
{"version":"2.1.0","bin":{"mcp-inspector":"clients/launcher/build/index.js"}}

$ codex --version
codex-cli 0.147.0
```

Current MCP Inspector 2.1.0 был запущен ephemeral из task-owned npm cache без
изменения repository `package.json` или lockfile. Credential-free bounded CLI
probe против exact product URL:

```bash
npm exec --yes --package @modelcontextprotocol/inspector@2.1.0 -- \
  mcp-inspector --cli \
  --server-url 'https://mind-diary.example.invalid/mcp' \
  --transport http --method tools/list \
  --connect-timeout 15000 --format json
```

В 2026-08-08T13:40Z Inspector завершился с
`{"error":{"message":"Error POSTing to endpoint: Not found","status":404}}`.
Он не достиг protocol discovery или tools list; это fail, а не conformance
pass.

Для current Codex выполнен ephemeral credential-free startup только против
exact product URL, без записи server config и без private prompt/query:

```bash
env -u MIND_DIARY_MCP_TOKEN codex exec \
  --ephemeral --ignore-user-config --ignore-rules \
  --skip-git-repo-check --sandbox read-only \
  -c 'mcp_servers.mind_diary_product.url="https://mind-diary.example.invalid/mcp"' \
  -c 'mcp_servers.mind_diary_product.required=true' \
  '<non-private readiness prompt>'
```

В `2026-08-08T13:35:50Z` `codex-cli 0.147.0` отправил legacy
`initialize` и завершил startup с `HTTP 404: Not found`; required MCP server не
инициализировался. Таким образом, обновление с проверенного ранее 0.146.1 до
0.147.0 не дало positive resolution lifecycle gap.

### Итог version 1

Этот recheck не дал основания закрыть AND-77. Positive resolution dispatcher и
lifecycle gaps отсутствовал; Inspector и authenticated product conformance не
были пройдены.
Без account bootstrap и product token нельзя честно проверить discovery,
tools/resources, list/resolve, browse/search/fetch, history, validation,
controlled commit, stale conflict, export, denials, revocation и post-state.
Story остаётся open/blocked. AWS/container fallback, bypass tokens, SIWC
bypass, cookies и выдуманные bearer secrets не использовались.

### Product version 2: текущее release evidence

Последний recheck выполнен на exact production Site Mind Diary:

- source/main Git SHA:
  `0a060ad85e4f8ecb075dea548213b11543b934a7`;
- Sites project:
  `appgprj_example1428fe59b5d8381c`;
- saved version 2:
  `appgprj_example1428fe59b5d8381c~appgver_examplebe9740dff0987eb0`;
- deployment:
  `appgdep_examplebdfbef1311c64261`;
- owner-only URL: `https://mind-diary.example.invalid`.

Authenticated browser/control smoke прошёл без console errors. Подтверждены
account bootstrap, private Personal Mind `/me`, выпуск named MCP token с
show-once secret и его revoke. После smoke активного smoke token не осталось;
secret, identity values, cookies, CSRF и private content в report не записаны.

#### Exact route-boundary probe

В `2026-08-08T15:04:50Z` один и тот же redacted non-private raw POST probe дал
следующую матрицу:

| Request | Наблюдаемый ответ |
|---|---|
| `POST /mcp` | HTTP 404, `text/plain; charset=utf-8`, 9 bytes, body `Not found`, SHA-256 `e3ebaa16dd9d9b9fc107c42183fb6cf9d22927e1af03dbbdfa0ccc38e4e4ac31` |
| `POST /mcp?route_probe=1` | тот же HTTP 404, content type, length, body и digest |
| `POST /mcp/` | HTTP 401, `text/html`, обычная Sites authentication boundary |
| `POST /api/mcp` | HTTP 401, `text/html`, обычная Sites authentication boundary |
| `POST /__mind_diary_route_probe` | HTTP 401, `text/html`, обычная Sites authentication boundary |

Bounded Worker logs не содержат matching exact `POST /mcp`, тогда как
authenticated web/control requests достигают Worker. Это не доказывает
конкретную реализацию Sites dispatcher, но вместе с отличием exact `/mcp` от
соседних paths поддерживает inference: exact route перехватывается или иначе
специально обрабатывается до deployed product Worker.

Repository-owned path не объясняет наблюдаемый 404. Product
[Worker entry](../../apps/mind-diary-site/worker/index.ts) вызывает shared
runtime до Vinext fallback, а
[composition root](../../packages/composition-root/src/product-site.ts)
перехватывает pathname `/mcp` до web handler. В tracked Sites hosting config
есть project и D1/R2 bindings, но нет отдельной repository-owned route map;
проверка source/config не нашла пропущенного правила, которое должно было бы
доставить exact `/mcp` в Worker.

Ограничение evidence существенно: authenticated raw `POST /mcp` на version 2
не доказан. Использованная browser automation могла пройти web/control UI, но
не могла отправить такой raw authenticated request; создавать SIWC bypass для
этого запрещено release contract. Поэтому 404 нельзя выдавать за результат
application Bearer auth, а web smoke — за MCP conformance.

#### Итог version 2 и статус AND-77

Positive MCP Inspector + Codex conformance gate остаётся blocked: route boundary
не даёт positive evidence, что external client достигает product MCP adapter,
а protocol operations и required positive/negative/post-state matrix на этом
deployment не пройдены. AND-77 остаётся open. Отрицательный route probe не
закрывает story и не разрешает fallback в AWS, AgentCore, отдельный container,
public access или SIWC bypass.

## Repeatable live procedure после platform/client change

### 1. Зафиксировать deployment identity

Coordinator повторно использует tracked Site из `apps/sites-probe`; новый
Site не создаётся. Для нового approved version/deployment до test записываются:

- exact Git SHA и tree;
- Sites `project_id`;
- saved version ID;
- deployment ID;
- live HTTPS URL;
- access policy;
- UTC deployment time.

Не использовать preview/UI-only success как доказательство MCP.

### 2. Проверить runtime secret

Убедиться, что Sites хранит `SITES_PROBE_BEARER_TOKEN` как secret, не помещая
значение в prompt, repository, report или shell history. Не ротировать его без
отдельной причины и разрешения. На client установить то же значение только в
`MIND_DIARY_SITES_PROBE_TOKEN`. Не включать shell tracing и verbose HTTP
output.

### 3. Проверить identity presence

В signed-in Sites browser открыть `/probe/identity`. Записать только booleans:

```json
{
  "user_id_present": false,
  "email_present": true,
  "full_name_present": false,
  "full_name_encoding_present": false,
  "full_name_encoding_valid": false
}
```

Пример показывает допустимую redacted shape, а не фактический result. Gate
требует `email_present: true`; full name optional. Raw response не копировать,
если platform добавит новые поля.

### 4. Запустить HTTP/storage gate

Из `apps/sites-probe` установить переменные без печати значений и выполнить:

```bash
npm run gate:live
```

Script требует `SITES_PROBE_URL` и `MIND_DIARY_SITES_PROBE_TOKEN`. Optional
`SITES_PROBE_VERIFY_OPERATION_ID` повторно проверяет R2 marker предыдущего run.
Script выводит только counters, opaque operation ID, R2 SHA-256 и statuses. Он
проверяет:

- missing/invalid/valid Bearer и safe `WWW-Authenticate`;
- `server/discover`, `tools/list`, positive/denied `tools/call`;
- positive и mismatched headers/body metadata, JSON и request-scoped SSE;
- GET/DELETE/session rejection;
- D1/R2 positive, invalid, retry, idempotency conflict и concurrent CAS;
- неизменность counter после invalid/denied paths.

### 5. Проверить persistence после redeploy

Сохранить redacted summary первого `gate:live`, установить его
`persisted_operation_id` в `SITES_PROBE_VERIFY_OPERATION_ID`, выполнить новый
approved Sites redeploy и запустить script снова. После redeploy:

- starting counter равен ending counter предыдущего run;
- ранее выданный operation ID всё ещё возвращает `r2_present: true`,
  `r2_matches: true` и тот же digest;
- новый successful run увеличивает counter ровно на два.

Если project/version change создаёт новые bindings вместо прежних, это fail
для требуемой persistence, а не основание переписать evidence.

### 6. Проверить реальный Codex

Записать exact output `codex --version`, затем добавить конфигурацию без
секрета:

```toml
[mcp_servers.mind_diary_sites_probe]
url = "https://mind-diary-capability-probe.example.invalid/mcp"
bearer_token_env_var = "MIND_DIARY_SITES_PROBE_TOKEN"
required = true
```

В новом Codex process подтвердить discovery/tool list и вызвать
`probe_capabilities` в positive mode. Зафиксировать только build, tool name,
HTTP/result statuses и redacted result booleans. Не сохранять token, raw auth
header, identity values, private prompt/query или client config с secret.

## Live evidence

| Поле/capability | Фактическое evidence |
|---|---|
| Git SHA/tree | exact values above |
| Sites project/version/deployment | version 1; deployment succeeded |
| Live HTTPS URL и access policy | exact URL above; custom owner-only |
| Identity booleans | email/full-name/encoding present in redacted Worker log; user ID absent |
| D1/R2 before/after request | blocked before Worker; not verified live |
| D1/R2 after redeploy | blocked before Worker; not verified live |
| JSON и request-scoped SSE | blocked before Worker; not verified live |
| GET/DELETE/session negative cases | local only; live endpoint unreachable |
| Bearer challenge/invalid/valid | Sites dispatcher returns 404 before application challenge |
| Codex exact build + `bearer_token_env_var` | `codex-cli 0.146.1`; required server failed on HTTP 404 during initialize |
| Domain/proxy/challenge behavior | owner-only dispatcher: identity 401; MCP 404; no Worker invocation |

Этот report является release-blocking evidence AND-37, а не доказательством
Sites MCP compatibility.

## Ограничения

- Local Miniflare не моделирует Sites proxy buffering, private access gateway,
  production domain или binding lifecycle.
- Synthetic SSE завершается после одного final response; отсутствие buffering
  доказывается только live timing/stream observation.
- Probe Bearer secret — test-only gate credential, не продуктовый MCP token
  contract.
- Probe deliberately rejects `Mcp-Session-Id` как requested negative case;
  normative `2026-07-28` backward-compatibility guidance рекомендует modern
  server игнорировать legacy session header. Это различие нужно учитывать при
  проектировании product adapter и не выдавать probe behavior за conformance.
- Повтор gate требует нового platform/client capability или явного
  product/access решения. Нельзя автоматически делать Site public, создавать
  SIWC bypass token либо менять target protocol ради зелёного результата.
- Claude Code, OAuth/public plugin и company-knowledge profile не проверяются.
