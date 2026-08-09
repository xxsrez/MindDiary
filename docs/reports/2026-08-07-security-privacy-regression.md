# Security, privacy и threat regression на 2026-08-07

Статус: **локальный automated regression evidence для AND-86**. Отчёт
фиксирует проверенное поведение application/adapters на feature tree, но не
подтверждает UAT/production deployment, live OpenAI Sites boundary или совместимость
реального MCP client.

## Вывод

Локальная suite подтверждает fail-closed границы identity, browser mutation,
MCP token, immutable locator и content validation. Mutating web command не
достигает executor до проверки trusted Sites actor, exact configured HTTPS
Origin и principal-bound CSRF token. Origin, CSRF, token lifecycle, ACL и
locator denials проверены вместе с конечным состоянием: отказ не создаёт
mutation/revision и не читает защищённый object.

Недоверенный corpus не может добавить scope или control-plane tool. При этом
prompt injection **не устранён**: token с уже выданным `content:write` может
выполнить разрешённый immediate commit. Этот residual risk ограничивают
explicit write scope, current ACL, immutable history, idempotency, audit и
отсутствие control-plane tools в content MCP.

## Scope и метод

Suite использует production exports `adapter-web`, `adapter-mcp`,
`application-content`, `application-control`, in-memory ports и
`composition-root`. Все identity, content, query, CSRF, bearer и download
значения в evidence представлены только как синтетические redacted classes;
raw значения не сохраняются.

`privacy-safe-observer` проверяет log/trace/error synchronously, не сохраняет
raw event и отдаёт только счётчики по channel. При обнаружении защищённого
значения исключение содержит только channel и structural location, но не само
значение.

## Проверенные границы

| Threat boundary | Проверенное поведение | Exact error и конечное состояние |
|---|---|---|
| Sites identity/header spoofing | Browser headers/body/query и role claims не заменяют platform identity. | `authentication_required`; binding lookup `0`; actor отсутствует. |
| Origin + CSRF | Exact configured public origin сверяется и с URL, и с `Origin`; CSRF проверяется через principal-bound verifier. Credentials удаляются до executor. | Все missing/mismatch/spoof/verifier-failure cases: одинаковый `403 forbidden`; mutations `0`. Corrected retry: ровно `1`. |
| Token expiry/revoke/scope | Read-only token не видит/не вызывает commit; expired, revoked и unknown token неразличимы. | `insufficient_scope` либо generic `401 authentication_required`; commit count не меняется. |
| Opaque-ID enumeration | Private/missing locator и cross-revision reuse не раскрывают target metadata. | Exact `locator_not_found`; object reads `0`; HEAD и revision count неизменны. |
| Historical ACL | Locator старой immutable revision повторно проверяет current membership. | После revoke — `locator_not_found`; object reads `0`; старое право не «воскрешается». |
| Authorization-before-object | Denied locator прекращается до revision object read. | Object reads `0`; content отсутствует в error/evidence. |
| Path/UTF-8/reserved files | Traversal, encoded separator, invalid UTF-8, ordinary operation над `index.md`/`log.md` отклоняются. Double-encoded segment не декодируется второй раз. | `resource_not_found`, `invalid_path`, `invalid_utf8`, `reserved_path_requires_special_operation`; HEAD/revisions неизменны. |
| Safe web rendering | Corpus-shaped markup и event handlers экранируются; unsafe route становится `#`. | Нет executable `script/svg/img` или inline handler. |
| Corpus prompt injection | Client-supplied scopes/control-tool names не меняют actor/tool catalog. Read-only call denied; authorized write и exact retry разрешены. | Read-only final commits `0`; authorized idempotent retry оставляет commits `1`. Residual write risk сохранён явно. |
| Logs/traces/errors | Allowlisted request metadata остаётся, credentials redacted/omitted; private body/query/email/download grant отсутствуют. | Observer сохраняет только counts; generic failures не содержат raw protected values. |

## Воспроизведение

Feature gate выполняет только targeted checks из manifest:

```bash
npm exec tsc -- -b packages/adapter-web packages/composition-root
node --test tests/unit/web-control-request-security.test.mjs tests/integration/security-privacy-threat.test.mjs
node scripts/check-docs.mjs
git diff --check e92c8e6d7f188f39a8e6209bb437a93df383cd1d..HEAD
```

Локальный targeted test result на подготовленном feature tree: `12/12 pass`.
Full repository gate остаётся `deferred-to-cutoff` и не подменяется этой suite.

## Ограничения evidence

- CSRF verifier injected: suite проверяет обязательную fail-closed wiring и
  principal binding, но не заявляет проверенный Sites session-token transport.
- In-memory adapters подтверждают application boundary, а не production
  persistence, proxy или distributed race behavior.
- Live Sites MCP gate по-прежнему имеет отдельное отрицательное evidence в
  [capability report](2026-08-07-sites-mcp-capability-gate.md); AND-86 не меняет
  platform/client status.
- Claude Code, OAuth/public plugin, company-knowledge, anonymous access, AWS и
  post-MVP features не проверялись и не заявляются.

## Redacted evidence shape

Допустимый durable summary содержит только классы и counters:

```json
{
  "protected": [
    "[REDACTED:bearer]",
    "[REDACTED:csrf]",
    "[REDACTED:private-content]",
    "[REDACTED:private-query]",
    "[REDACTED:verified-email]",
    "[REDACTED:download-grant]"
  ],
  "targeted_tests": { "passed": 12, "failed": 0 },
  "full_gate": "deferred-to-cutoff"
}
```

Raw HTTP headers, token/verifier, content/query, email и download URL в этот
report не копируются.
