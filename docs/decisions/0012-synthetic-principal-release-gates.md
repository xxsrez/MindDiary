# ADR-0012: SyntheticPrincipal и автоматические release gates

Статус: accepted, 2026-08-20. Решение уточняет validation carrier релиза 0.1,
не меняя product identity, OAuth или production boundaries из ADR-0010 и
ADR-0011.

## Контекст

Расширенная проверка collaboration и OAuth до сих пор зависела от двух
отдельных Sites sessions и fresh внешнего Codex account. Такой probe полезен
как platform/UX signal, но плохо подходит для обязательного release gate:
человеческие credentials недоступны автоматическому run, Marketplace cache и
Desktop UI меняются независимо от candidate, а ручной прогон трудно повторить
на каждом exact SHA.

Release 0.1 должен автоматически ловить большинство ошибок identity isolation,
current ACL, invite/role/ownership lifecycle, OAuth/PKCE, package wiring и MCP
transport. При этом test carrier не должен создавать product login, bypass ACL
или скрытую UAT authority.

## Решение

### SyntheticPrincipal — только label тестового прогона

`SyntheticPrincipal` означает actor class в test plan/evidence. Это не entity
доменной модели, не subtype `Principal`, не login account, не service actor и
не persisted discriminator. После normal account bootstrap тестовый actor
получает обычный внутренний `Principal`, обычный Personal Mind и обычные
memberships/tokens.

Отдельная trusted test composition подаёт ephemeral identity snapshot через
существующий `ProductSiteTrustedIdentityReader` и constructor-only generic
binding-provider dependency со значением `synthetic-test`. До bootstrap это
обычный trusted pre-registration identity context; отдельного domain actor kind
нет. Normal binding resolution сохраняет provider `synthetic-test`, после чего
создаётся обычный `Principal`.

Test composition активируется только прямым import/entry point отдельного test
harness. Её нельзя включить route, header, body, query, cookie, environment
variable, serialized job, deployment setting, `NODE_ENV=test` или другим
runtime flag. Generic dependency default-ится в composition root на
`openai-sites`; ordinary Product Worker не задаёт её и не содержит synthetic
provider, resolver, import или endpoint.

Harness вызывает normal application commands и protocol adapters. Он не seed-ит
`Principal`, binding, membership, token, grant или ACL напрямую в storage, не
подменяет current role/scopes и не получает privileged cleanup command. Cleanup
использует обычные revoke/delete operations; финальная negative scan проверяет
отсутствие test state в isolated store.

### P9 разделяется на blocking automation и Sites canary

- `P9-Synthetic` — обязательный blocking dev gate. Он создаёт минимум две
  ephemeral test identities в namespace `synthetic-test`, проходит normal
  bootstrap и полный collaboration/access lifecycle. Passing receipt имеет
  отдельную schema
  `mind-diary/synthetic-multi-principal-evidence/v1` и связан с exact candidate
  SHA.
- `P9-Sites-Canary` — informational owner observation на real UAT deployment с
  двумя platform-authenticated Sites sessions. Он продолжает проверять
  platform identity/audience behavior, которого synthetic composition не
  моделирует, но его отсутствие или failure не блокирует release 0.1.

Существующие `mind-diary/multi-principal-evidence/v1` receipts остаются
историческим UAT evidence. Они не переименовываются и не могут быть выданы за
новую synthetic schema.

### OAuth также получает две независимые проверки

- `dev.oauth-direct-plugin` — обязательный automated gate. Он проверяет direct
  package shape (`AVAILABLE + ON_USE`, без `apps`/`.app.json`, exact
  `.mcp.json`), fresh temporary Codex/plugin context, model-visible skill
  discovery через non-model `codex debug prompt-input` (не только cached
  `SKILL.md`), discovery/DCR, PKCE
  `S256`, exact redirect/resource/state, read grant, write step-up, expiry,
  refresh rotation/reuse detection, revoke/reconnect, modern/compatibility MCP
  и personal-token regression. Synthetic identity допускается только на
  trusted authorize/consent boundary test composition; token endpoint,
  application ACL/CAS и MCP transport остаются обычными.
- Real external Marketplace/Codex installation и OAuth UI на UAT становятся
  informational canary. Такой canary нужен перед утверждением, что конкретный
  external-host UX проверен, но не является release blocker 0.1.

Test OAuth не добавляет password grant, admin token mint, client-selected
principal или special bearer. DCR client и package не могут выбрать synthetic
actor; identity предоставляет только test composition в точке, где product
runtime использовал бы trusted Sites identity.

### Hosted evidence и production boundary сохраняются

Обязательные single-owner UAT rows — exact artifact lineage,
authenticated Web/control, применимая persistence-after-redeploy и current
Codex MCP profiles — остаются release gates. Synthetic automation не считается
hosted evidence и не доказывает Sites audience, browser session или real
Marketplace/Desktop UI.

Текущий target остаётся restricted UAT. Это решение не создаёт production
target, не расширяет Sites audience/access policy, не разрешает production
deploy и не делает external canary production evidence.

## Evidence contract

`mind-diary/synthetic-multi-principal-evidence/v1` содержит только:

- exact `candidate_sha`, UTC window и один opaque `run_fingerprint`;
- actor class `synthetic-principal` и binding namespace `synthetic-test`;
- `actor_fingerprints` — array минимум двух distinct opaque values в stable
  actor order;
- bounded assertion IDs/statuses для normal bootstrap, isolation, ACL,
  collaboration, restart, revoke и cleanup;
- hash exact redacted receipt.

`run_fingerprint` и каждый element `actor_fingerprints` генерируются независимо
для evidence correlation, не кодируют alias/email/internal ID и не позволяют
восстановить actor mapping вне transient test process.

Receipt не содержит alias/email, internal principal/space/Mind/revision/token/
grant/invitation/membership/account/binding/audit/outbox/job/request/impact ID,
OAuth record ID, Personal Mind handle, content locator, object key,
token/grant/client secret или verifier, authorization header, cookie,
content/query, storage row, raw request/response или mapping actor → internal
identity. Closed assertion IDs и independent `run-…`/`actor-…` fingerprints не
считаются internal IDs.

Automated OAuth/package receipt отдельно фиксирует exact MindDiary SHA, exact
Marketplace/package snapshot, plugin version, client/version, protocol routes
и bounded assertions. Он не наследует synthetic multi-principal schema и не
подменяется внешним canary screenshot.

## Последствия

- Release 0.1 получает repeatable majority-bug gate без хранения человеческих
  credentials и без доступа к real user accounts.
- Synthetic gate доказывает application/protocol invariants, но не Sites или
  Desktop UI behavior; canaries сохраняют этот signal с честной
  `informational` классификацией.
- MD-237 реализует synthetic multi-principal capability, а MD-238 — отдельную
  OAuth/package capability; обе required rows fail closed при unavailable,
  failed либо неполном exact-candidate receipt.
- Historical readiness criteria 1–29 и live slots `W/P/MI/CX/R` сохраняются до
  implementation change; их нельзя молча заменить synthetic receipt.

## Рассмотренные варианты

- **Держать второй реальный account обязательным для каждого release.**
  Отклонено: gate зависит от человека, credentials и меняющейся внешней UI.
- **Seed-ить principals/ACL напрямую в test database.** Отклонено: это обходит
  bootstrap, binding, commands, audit и authorization — именно те ошибки,
  которые должен ловить gate.
- **Добавить test login route/header или включать его через `NODE_ENV`.**
  Отклонено: такая surface может попасть в UAT/production и стать identity
  bypass.
- **Считать synthetic automation полным UAT evidence.** Отклонено: она не
  проверяет Sites identity/audience и реальный Codex/Marketplace UI.
- **Убрать external canaries полностью.** Отклонено: platform regressions и UX
  incompatibility всё ещё важны для claims о конкретном external client.

Связанные документы:
[synthetic runbook](../operations/synthetic-multi-principal-runbook.md),
[release profile](../operations/ship-work-release-profile.md),
[UAT Sites canary](../operations/uat-multi-principal-runbook.md),
[implementation boundaries](../specs/implementation-boundaries.md),
[plugin и OAuth](../specs/plugin-connector.md),
[ADR-0010](0010-oauth-marketplace-connector.md) и
[ADR-0011](0011-direct-mcp-plugin-oauth-on-use.md).
