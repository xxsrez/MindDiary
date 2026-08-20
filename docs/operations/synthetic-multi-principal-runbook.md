# Synthetic multi-principal release gate

Статус: accepted operational contract, 2026-08-20; capability implementation
принадлежит MD-237. Этот runbook задаёт blocking row
`dev.synthetic-multi-principal`, но не утверждает, что harness уже реализован
или прошёл на текущем candidate.

## Назначение и граница доказательства

Gate автоматически ловит regressions в account bootstrap, Personal Mind
isolation, visibility, invitations, memberships, ownership, current Web/MCP/
history access и cleanup. Он исполняется на exact candidate в отдельной
test-only composition и выпускает
`mind-diary/synthetic-multi-principal-evidence/v1`.

Gate не проверяет Sites identity headers, Sites audience/access policy,
реальные browser sessions, Marketplace cache или Desktop OAuth UI. Эти
surfaces наблюдает отдельный informational
[P9-Sites-Canary](uat-multi-principal-runbook.md).

`SyntheticPrincipal` — только actor label тестового плана и receipt. В domain
и storage после bootstrap существуют обычные `Principal`, Personal Mind,
membership и token records. Label не сохраняется в этих records и не даёт
capabilities.

## Test-only composition

```text
synthetic harness
  -> trusted test identity factory
     -> ActorContext.actor.synthetic_test_identity
        -> binding namespace synthetic-test
  -> normal session/bootstrap/control commands
  -> normal token issuance and MCP authentication
  -> normal Authorizer, ACL, CAS, history and deletion
  -> isolated metadata/object/index/audit adapters
```

Composition обязана быть structurally separate от Product Site, UAT и
production composition roots. Единственная activation boundary — direct import
и вызов test harness entry point из targeted command/runtime capability.

Запрещены:

- product route, test login page, header, cookie, body/query field;
- environment variable, deployment setting, feature flag или mere
  `NODE_ENV=test` switch;
- serialized identity/job payload и background `service` actor;
- client-supplied email, `principal_id`, role, membership или scopes;
- direct insert/update storage rows, fixture seed или ACL bypass;
- специальный issue/revoke/delete command, недоступный ordinary actor.

Architecture/import gate обязан доказать, что production Web/OAuth/MCP/
background composition не импортирует test identity factory или synthetic
binding resolver. Negative runtime check должен показать, что ordinary UAT/
production config не способен разрешить namespace `synthetic-test`.

## Ephemeral identities и данные

Harness создаёт cryptographically random run nonce и минимум два distinct
identity subjects: Owner и Participant. Человекочитаемые aliases при
необходимости exact-email invitation используют reserved `.invalid` domain и
живут только в памяти test process. Для persisted evidence harness независимо
создаёт один opaque `run_fingerprint` и `actor_fingerprints` — array минимум
двух distinct opaque values в stable actor order. Они не являются aliases,
emails или service IDs и не кодируют их.

Test identity factory строит `synthetic_test_identity` с namespace
`synthetic-test`; normal `bootstrap_account` создаёт для каждого отдельный
ordinary `Principal`, отдельный Personal Mind и sole-owner binding. Harness
сравнивает internal IDs только в памяти и немедленно отбрасывает их после
assertion.

Все canonical content — non-sensitive deterministic fixture. Store namespace,
object keys, handles, idempotency keys и OAuth clients получают run nonce, чтобы
parallel/retry execution не пересекались. Isolated store нельзя направить на
UAT или production bindings.

## Blocking scenario

Targeted capability выполняет одну последовательность без ручного input:

1. Создать clean isolated composition и два distinct
   `synthetic_test_identity`.
2. Через normal session/bootstrap commands создать два accounts; доказать
   разные principals, Personal Minds и отсутствие duplicate bootstrap при
   replay.
3. Через normal control command выпустить отдельные principal-bound MCP tokens;
   проверить binding и отсутствие shared credential.
4. Owner создаёт private ordinary Mind. Participant не видит metadata через
   Web, `list_minds`, exact private resolve или history.
5. Owner переключает Mind в `public`, затем `unlisted`; Participant получает
   только authenticated baseline read, не membership/write. Catalog и exact
   handle semantics проверяются раздельно. Возврат в `private` немедленно
   отзывает Web/MCP/history baseline grant.
6. Owner приглашает exact registered Participant как Reader; до accept access
   отсутствует, replay создаёт одну membership. После accept Reader читает, но
   не commit-ит.
7. Owner меняет Participant на Editor; fresh token/current ACL разрешает
   controlled fixture commit, stale HEAD получает conflict без partial state.
8. Owner передаёт ownership Participant: остаётся ровно один Owner, прежний
   Owner становится Admin.
9. Reconstruct composition над тем же isolated durable adapters, не seed-я
   state. Accounts, Personal Minds, owner/admin state, HEAD/history и token
   lifecycle сохраняются.
10. Новый Owner отзывает membership прежнего Admin. Следующие Web, MCP,
    `list_minds` и exact history requests fail closed без metadata leakage.
11. Обычными commands удалить ephemeral ordinary Mind, отозвать dedicated
    tokens и удалить test accounts, если normal lifecycle допускает это в
    chosen fixture order.
12. Выполнить negative scan isolated metadata/object/index/audit state:
    credentials и identity mappings отсутствуют, ordinary cleanup завершён,
    остались только разрешённые lifecycle markers вроде non-linkable retired
    handle. Затем уничтожить весь isolated test store.

Любой skipped assertion, unexpected partial state, unresolved cleanup или
отсутствующая runtime capability делает row failed. Retry не создаёт новый
nonce поверх неизвестного state: сначала выполняется reconciliation/cleanup
того же run.

## Receipt schema

Passing document:

```json
{
  "schema": "mind-diary/synthetic-multi-principal-evidence/v1",
  "status": "passed",
  "candidate_sha": "<exact-40-char-sha>",
  "actor_class": "synthetic-principal",
  "binding_namespace": "synthetic-test",
  "run_fingerprint": "run-<opaque-random>",
  "actor_fingerprints": [
    "actor-<opaque-random-owner>",
    "actor-<opaque-random-participant>"
  ],
  "started_at": "<utc>",
  "completed_at": "<utc>",
  "assertions": [
    { "id": "bootstrap.distinct-ordinary-principals", "status": "passed" }
  ],
  "artifact_sha256": "sha256:<redacted-document-hash>"
}
```

`assertions` — closed stable registry. Минимальные groups: `activation`,
`bootstrap`, `personal-isolation`, `private-non-enumeration`,
`visibility-baseline`, `invitation`, `role-transition`, `ownership-transfer`,
`restart-persistence`, `web-revoke`, `mcp-revoke`, `history-revoke`, `cleanup`
и `production-negative`.

`run_fingerprint` — единственный persisted opaque locator тестового run.
`actor_fingerprints` содержит минимум два distinct values и сохраняет только
stable actor order, необходимый assertions; aliases, emails, internal IDs и
actor mapping в него не кодируются.

Receipt запрещает alias/email, internal principal/Mind/revision/token/grant ID,
credential/verifier, cookie/header, content/path/query, raw request/response,
storage row и actor-to-principal mapping. Hash считается после redaction.

## OAuth authorize/consent seam

MD-238 может использовать тот же trusted test identity factory только в
authorize/consent boundary отдельной test composition. DCR, authorization
request, PKCE exchange, access/refresh lifecycle, MCP authentication, current
ACL/CAS и revoke идут через normal package/protocol surface.

Synthetic actor нельзя передать в `/oauth/authorize` через URL, form, header,
cookie или client metadata. Test harness связывает pending authorization с
`synthetic_test_identity` внутри trusted adapter так же, как Product Site
composition связала бы её с trusted Sites identity. Password grant, admin token
mint и pre-seeded OAuth records запрещены.

OAuth/package gate выпускает отдельный receipt; synthetic multi-principal
receipt не делает OAuth row passing и наоборот.

## Recovery

При interrupted run harness читает только собственный local state document с
run nonce и opaque locators, разрешает current Owner обычными queries и
выполняет normal revoke/delete operations. Если cleanup нельзя доказать,
targeted row остаётся failed, isolated store quarantined как transient test
artifact и release не продолжается до bounded reconciliation.

Никакой recovery step не меняет Sites audience/access policy, UAT data или
production state.
