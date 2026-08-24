# Hosted canary операторского каталога

Статус: accepted restricted-UAT procedure для `MD-281`, 2026-08-24.
Runbook исполняет capability
`mind-diary/uat-operator-directory-canary/v1` и проверяет hosted часть
[контракта service-operator directory](../specs/service-operator-directory.md).
Он не создаёт production operator model, external identities и не даёт
полномочия менять Sites audience или operator allowlist. В product boundary
runner выполняет обычный idempotent account bootstrap, выпускает собственные
короткоживущие read-only MCP tokens и создаёт/удаляет только deterministic
temporary private Mind.

## Что доказывает canary

На одном exact candidate/deployment три независимо аутентифицированных actor:

- `operator` — единственный actor из текущего bounded constructor allowlist;
- `mind_role` — non-operator, который создаёт canary-owned ordinary Mind и
  получает в нём `Owner`;
- `ordinary` — зарегистрированный non-operator без operator capability.

Runner использует только обычные hosted web/control и modern MCP requests. Он
проверяет distinct registered principals и Personal Minds в памяти, creator
`Owner` role у `mind_role`, успешную web/MCP activity для каждого actor, stable
bounded API projection минимум из трёх строк, operator HTML и exact
`404/not_found` на UI/API для обоих non-operators. Hosted REST projection
нормализуется из exact snake-case wire fields; camel-case test double не
считается evidence. Canary также проверяет limit-1 cursor без повторной строки,
exact display-name search, `registered_at` / `last_activity_at` / `display_name`
в обоих направлениях, inclusive UTC registration/activity ranges и impossible
synthetic empty query. Второй operator read-back подтверждает, что denied
requests не сдвинули activity summary обоих non-operators.

`never_active=true` не требует искусственно создавать ещё один account. Если
такие строки есть, у каждой `activity` обязана быть `null`; ноль строк является
корректным bounded result только вместе с отдельным успешным UI assertion,
который показывает `Never` либо явный empty-state. Display name для exact
search берётся из live row только в памяти, а synthetic empty query не содержит
identity. Ни один query, cursor, row или sort value не входит в state/receipt.

Canary не доказывает provider request-envelope privacy. Этот отдельный
provider/application boundary и его redacted read-back принадлежат `MD-283` и
остаются обязательным соседним evidence для terminal operator-directory Epic.

## Предусловия и authority boundary

1. Coordinator фиксирует exact 40-character candidate SHA, exact Sites
   deployment ID и rollback target. Product environment — только restricted
   UAT; production исключён.
2. Три реальные Sites identity заранее созданы и самостоятельно прошли вход.
   Их inclusion в custom audience — отдельная access-policy операция с явным
   owner authority. Runner не создаёт external account и не проходит MFA.
3. Exact `principal_id` operator заранее прочитан через trusted server-side
   setup и является единственной записью временного UAT allowlist. Значение не
   передаётся runner-у и не попадает в evidence.
4. Все три actor имеют stable baseline без ordinary-Mind membership;
   `ordinary` не имеет operator capability. Runner сам создаёт temporary
   private Mind actor-ом `mind_role`, проверяет creator `Owner` и удаляет Mind
   после verify или recovery. Отсутствие готового identity/audience/allowlist
   pool остаётся внешним prerequisite; отсутствие product registration — нет.
5. Каждый actor предоставляет отдельную short-lived Sites session reference
   через локальный secret channel. Нельзя использовать одну browser/session для
   нескольких actor. MCP secrets и token IDs не являются входами runner-а.
6. Provider-log privacy classification/read-back подготовлен отдельно. Raw
   provider request logs, email-to-fingerprint mapping и credentials никогда не
   копируются в state, terminal transcript или release receipt.

Обязательные environment references:

```text
MIND_DIARY_UAT_OPERATOR_SITES_TOKEN
MIND_DIARY_UAT_MIND_ROLE_SITES_TOKEN
MIND_DIARY_UAT_ORDINARY_SITES_TOKEN
```

Значения не являются CLI arguments. Runner fail closed при отсутствующем или
повторно использованном credential. Он выпускает для каждой actor/phase named
MCP token с TTL один час и exact `content:read`, держит secret только в памяти,
revoke-ит token и проверяет следующий MCP request как `401`. Не печатайте
environment и не сохраняйте shell transcript с exported values как evidence.

## Phase A: setup

В clean checkout exact candidate:

```sh
npm run uat:operator-directory-canary -- \
  --phase setup \
  --candidate-sha <exact-40-char-sha> \
  --deployment-id <exact-appgdep-id> \
  --state-out <private-temp-path>/operator-directory-state.json
```

До первого hosted request runner пишет mode-`0600` redacted state со status
`setup_started`. Поэтому interrupted setup всегда оставляет recovery carrier,
но не identity. Run nonce генерируется самим runner-ом как 128 random bits,
не принимается через CLI и служит только для уникальных canary-owned имён и
idempotency keys. Затем он:

1. получает три session projection; при exact `409/registration_required`
   вызывает normal `create_isolated_account` с deterministic idempotency key и
   повторяет session read;
2. сравнивает distinct `principal_id` и Personal Mind ID только в памяти;
3. actor-ом `mind_role` создаёт deterministic temporary private ordinary Mind,
   проверяет creator role exact `Owner` и отсутствие Mind у двух других actor;
4. выпускает три phase-local read-only tokens, выполняет successful web list и
   modern MCP `list_minds`, revoke-ит tokens и проверяет denial;
5. сохраняет только salted per-run actor fingerprints, deterministic safe
   resource names и status `ready_for_verify`.

Normal product account + Personal Mind, созданные bootstrap-ом, становятся
durable pool state MD-282 и не удаляются. Setup не создаёт invitation, чужую
membership или operator grant. Canary-owned temporary Mind и named tokens —
единственные reversible product resources; монотонная activity summary от
successful reads не откатывается.

## Phase B: verify и receipt

На том же deployment:

```sh
npm run uat:operator-directory-canary -- \
  --phase verify \
  --deployment-id <same-exact-appgdep-id> \
  --state <private-temp-path>/operator-directory-state.json \
  --evidence-out <private-temp-path>/operator-directory-evidence.json
```

Изменившийся deployment, actor session или отсутствие любого actor в bounded
directory блокирует pass. Pagination/search/sort/range/empty/never-active
failure также оставляет canary nonterminal. Перед passing receipt verify
повторно подтверждает exact `Owner` temporary Mind через `access.role`; один
положительный directory `participating_mind_count` не заменяет эту проверку.
Затем verify
выпускает fresh phase-local read-only tokens, повторяет MCP activity, выполняет
directory matrix, revoke-ит tokens с denial read-back и удаляет temporary Mind
через deletion-impact contract. Поэтому assertion
`cleanup.no_ephemeral_product_resources` относится к фактическому hosted
состоянию, а не к локальному флагу.

Successful artifact имеет schema
`mind-diary/uat-operator-directory-canary-evidence/v1`, exact candidate SHA и
deployment ID, actor source, один opaque run fingerprint, три actor class +
opaque fingerprint, закрытый список assertion IDs, UTC observation и content
hash. Receipt не содержит email, `principal_id`, Personal/ordinary Mind ID,
cursor, response body, token, session reference, headers или query.

## Cleanup и recovery

После successful verify выполните independent idempotent read-back:

```sh
npm run uat:operator-directory-canary -- \
  --phase cleanup \
  --deployment-id <same-exact-appgdep-id> \
  --state <private-temp-path>/operator-directory-state.json \
  --evidence-out <private-temp-path>/operator-directory-cleanup.json
```

Если setup или verify прерван:

```sh
npm run uat:operator-directory-canary -- \
  --phase recovery \
  --deployment-id <same-exact-appgdep-id> \
  --state <private-temp-path>/operator-directory-state.json \
  --evidence-out <private-temp-path>/operator-directory-recovery.json
```

Обе phase требуют те же три Sites session references, перечисляют tokens по
deterministic safe name prefix, revoke-ят active leftovers, удаляют exact
temporary Mind, повторяют absence/read-back и только затем пишут local state.
Artifact schema —
`mind-diary/uat-operator-directory-cleanup-evidence/v1`; он связывает exact
candidate, deployment и тот же run fingerprint с закрытым cleanup assertion
set. Local `cleaned` без hosted read-back невозможен.

Runner никогда не меняет Sites/operator configuration. Authorized
human/operator отдельно подтверждает unchanged exact pre-run operator allowlist
и intended custom audience без groups/unexpected viewers, а также сверяет
provider privacy configuration/read-back по `MD-283`. Сохраняются только
classification, configuration fingerprint и bounded before/after counts — без
identities или raw provider logs.

Если credential скомпрометирован или actor должен быть немедленно удалён,
выполните emergency revoke из
[privacy-safe UAT operations](uat-pilot-operations.md#emergency-revoke).
Cleanup receipt доказывает только canary-owned product resources. Он не
подменяет external unchanged audience/allowlist и provider privacy read-back.

## OD4 exact-lineage join

Terminal `MD-280` собирается машинно:

```sh
node scripts/run-uat-operator-directory-join.mjs \
  --canary-evidence <private-path>/operator-directory-evidence.json \
  --pool-evidence <private-path>/account-pool-readiness.json \
  --provider-evidence <private-path>/provider-privacy.json \
  --cleanup-evidence <private-path>/operator-directory-cleanup.json \
  --evidence-out <private-path>/operator-directory-join.json
```

Join fail closed проверяет hashes и exact candidate/deployment всех четырёх
receipts, same canary/cleanup run fingerprint, `ready` pool, provider status
`accepted_boundary`, cleanup pass и `production_excluded=true`. Output schema —
`mind-diary/uat-operator-directory-join-evidence/v1`.

State и evidence хранятся вне repository. После content-addressed handoff их
удаляют recoverable способом; identity mapping и secret values не архивируют.
