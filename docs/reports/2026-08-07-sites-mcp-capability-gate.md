# OpenAI Sites + MCP capability gate на 2026-08-07

Статус: **локальный probe готов; live gate не выполнен**. Этот report фиксирует
локально проверенную поверхность AND-37 и repeatable live procedure. Он не
подтверждает создание Site, deployment, доступность live URL или совместимость
Codex с endpoint.

## Вывод

В `apps/sites-probe` реализован отдельный явно non-product Sites probe. Локально
подтверждены Worker routing, presence-only identity response, D1/R2 round-trip,
stateless MCP `2026-07-28`, JSON и request-scoped SSE, per-request Bearer auth,
CAS concurrency, idempotent retry и итоговое состояние после errors.

Production release 0.1 остаётся blocked, пока coordinator не создаст Site и не
заполнит live evidence ниже. Провал live gate не разрешает fallback в AWS,
AgentCore или отдельный container.

## Граница probe

Probe не реализует Mind Diary service: в нём нет accounts, Minds, ACL, OKF
content, revisions, search, export или control plane. Его endpoints:

| Endpoint | Что проверяет | Что не возвращает |
|---|---|---|
| `GET /probe/identity` | presence documented Sites identity headers | значения identity headers |
| `GET\|POST /probe/state` | D1 counter/CAS и R2 object round-trip | bearer credential и object body |
| `POST /mcp` | `2026-07-28` discovery, headers/body, tool call, JSON/SSE | credential, identity values и private data |

`.openai/hosting.json` объявляет logical bindings `DB` и `PROBE_BUCKET` без
`project_id`. Реальную связь с Sites project добавляет только coordinator после
создания Site.

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

## Repeatable live procedure

### 1. Зафиксировать deployment identity

Coordinator создаёт Site из `apps/sites-probe`, сохраняет добавленный Sites
`project_id` отдельным commit и до test записывает:

- exact Git SHA и tree;
- Sites `project_id`;
- saved version ID;
- deployment ID;
- live HTTPS URL;
- access policy;
- UTC deployment time.

Не использовать preview/UI-only success как доказательство MCP.

### 2. Добавить runtime secret

В Sites settings добавить `SITES_PROBE_BEARER_TOKEN` как secret, не помещая
значение в prompt, repository, report или shell history, затем redeploy
одобренную saved version. На client установить то же значение только в
`MIND_DIARY_SITES_PROBE_TOKEN`. Не включать shell tracing и verbose HTTP output.

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
url = "https://<pending-live-host>/mcp"
bearer_token_env_var = "MIND_DIARY_SITES_PROBE_TOKEN"
required = true
```

В новом Codex process подтвердить discovery/tool list и вызвать
`probe_capabilities` в positive mode. Зафиксировать только build, tool name,
HTTP/result statuses и redacted result booleans. Не сохранять token, raw auth
header, identity values, private prompt/query или client config с secret.

## Live evidence — pending

| Поле/capability | Фактическое evidence |
|---|---|
| Git SHA/tree | pending |
| Sites project/version/deployment | pending |
| Live HTTPS URL и access policy | pending |
| Identity booleans | pending |
| D1/R2 before/after request | pending |
| D1/R2 after redeploy | pending |
| JSON и request-scoped SSE | pending |
| GET/DELETE/session negative cases | pending |
| Bearer challenge/invalid/valid | pending |
| Codex exact build + `bearer_token_env_var` | pending |
| Domain/proxy/challenge behavior | pending |

Пока хотя бы одно обязательное поле pending, report не подтверждает Sites MCP
capability и AND-37 не может служить release evidence 0.1.

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
- Claude Code, OAuth/public plugin и company-knowledge profile не проверяются.
