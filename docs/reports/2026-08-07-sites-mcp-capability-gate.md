# OpenAI Sites + MCP capability gate на 2026-08-07

Статус: **live gate выполнен с отрицательным результатом; release 0.1
blocked**. Этот report фиксирует локально проверенную поверхность AND-37,
exact production probe и воспроизводимый отказ Sites/Codex boundary. Он не
подтверждает совместимость Codex с endpoint.

## Вывод

В `apps/sites-probe` реализован отдельный явно non-product Sites probe. Локально
подтверждены Worker routing, presence-only identity response, D1/R2 round-trip,
stateless MCP `2026-07-28`, JSON и request-scoped SSE, per-request Bearer auth,
CAS concurrency, idempotent retry и итоговое состояние после errors.

Exact production probe успешно собран и развёрнут owner-only в OpenAI Sites,
но обязательный Codex MCP flow не проходит. Внешний `POST /mcp` с valid
application Bearer получает dispatcher-level `404 Not found` и не достигает
Worker. Реальный `codex-cli 0.146.1` дополнительно начинает transport с
`initialize`, то есть не использует требуемый stateless
`server/discover` profile `2026-07-28`.

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
