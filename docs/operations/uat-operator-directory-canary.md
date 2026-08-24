# Hosted canary операторского каталога

Статус: accepted restricted-UAT procedure для `MD-281`, 2026-08-24.
Runbook исполняет capability
`mind-diary/uat-operator-directory-canary/v1` и проверяет hosted часть
[контракта service-operator directory](../specs/service-operator-directory.md).
Он не создаёт production operator model и не даёт полномочия добавлять Sites
audience, accounts, operator allowlist, memberships или credentials.

## Что доказывает canary

На одном exact candidate/deployment три независимо аутентифицированных actor:

- `operator` — единственный actor из текущего bounded constructor allowlist;
- `mind_role` — non-operator с `Owner` или `Admin` membership в ordinary Mind;
- `ordinary` — зарегистрированный non-operator без operator capability.

Runner использует только обычные hosted web/control и modern MCP requests. Он
проверяет distinct registered principals и Personal Minds в памяти, наличие
ordinary-Mind role у `mind_role`, успешную web/MCP activity для каждого actor,
stable bounded API projection минимум из трёх строк, operator HTML и exact
`404/not_found` на UI/API для обоих non-operators. Второй operator read-back
подтверждает, что denied requests не сдвинули их activity summary.

Canary не доказывает provider request-envelope privacy. Этот отдельный
provider/application boundary и его redacted read-back принадлежат `MD-283` и
остаются обязательным соседним evidence для terminal operator-directory Epic.

## Предусловия и authority boundary

1. Coordinator фиксирует exact 40-character candidate SHA, exact Sites
   deployment ID и rollback target. Product environment — только restricted
   UAT; production исключён.
2. Три реальные Sites identity заранее созданы и самостоятельно прошли вход.
   Их inclusion в custom audience — отдельная access-policy операция с явным
   owner authority. Runner не создаёт account и не выполняет bootstrap.
3. Exact `principal_id` operator заранее прочитан через trusted server-side
   setup и является единственной записью временного UAT allowlist. Значение не
   передаётся runner-у и не попадает в evidence.
4. `mind_role` заранее имеет active `Owner` или `Admin` membership хотя бы в
   одном ordinary Mind. `ordinary` не имеет operator capability. Эти состояния
   готовятся по принятой account-pool procedure `MD-282`; отсутствие готового
   pool означает внешний prerequisite, а не право runner-а выдумать identity.
5. Каждый actor предоставляет отдельную short-lived Sites session reference и
   отдельный read-only MCP token через локальный secret channel. Нельзя
   использовать один browser/session/token для нескольких actor.
6. Provider-log privacy classification/read-back подготовлен отдельно. Raw
   provider request logs, email-to-fingerprint mapping и credentials никогда не
   копируются в state, terminal transcript или release receipt.

Обязательные environment references:

```text
MIND_DIARY_UAT_OPERATOR_SITES_TOKEN
MIND_DIARY_UAT_OPERATOR_MCP_TOKEN
MIND_DIARY_UAT_MIND_ROLE_SITES_TOKEN
MIND_DIARY_UAT_MIND_ROLE_MCP_TOKEN
MIND_DIARY_UAT_ORDINARY_SITES_TOKEN
MIND_DIARY_UAT_ORDINARY_MCP_TOKEN
```

Значения не являются CLI arguments. Runner fail closed при отсутствующем,
повторно использованном или неверного типа credential. Не печатайте environment
и не сохраняйте shell transcript с exported values как evidence.

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
но не durable identity. Затем он:

1. получает три already-registered session projection без account bootstrap;
2. сравнивает distinct `principal_id` и Personal Mind ID только в памяти;
3. подтверждает ordinary `Owner`/`Admin` membership у `mind_role`;
4. выполняет successful web list и modern MCP `list_minds` каждым actor;
5. сохраняет только salted per-run actor fingerprints и status
   `ready_for_verify`.

Setup не создаёт Mind, membership, invitation, token, account или operator
grant. Единственный ожидаемый durable effect — обычная монотонная activity
summary от successful reads; по принятому contract она не откатывается.

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
directory блокирует pass. Successful artifact имеет schema
`mind-diary/uat-operator-directory-canary-evidence/v1`, exact candidate SHA и
deployment ID, actor source, один opaque run fingerprint, три actor class +
opaque fingerprint, закрытый список assertion IDs, UTC observation и
content hash. Receipt не содержит email, `principal_id`, Personal/ordinary
Mind ID, cursor, response body, token, session reference, headers или query.

`status: passed` относится только к runner matrix. Terminal `MD-280` требует
отдельно связать этот artifact с provider-privacy receipt, exact deployed
artifact lineage и фактическим external cleanup read-back.

## Cleanup и recovery

После успешного verify закройте локальный canary state:

```sh
npm run uat:operator-directory-canary -- \
  --phase cleanup \
  --state <private-temp-path>/operator-directory-state.json
```

Если setup или verify прерван:

```sh
npm run uat:operator-directory-canary -- \
  --phase recovery \
  --state <private-temp-path>/operator-directory-state.json
```

Обе phase идемпотентно меняют только local redacted state. Им не нужны
credentials: runner не создаёт product resources и не имеет authority менять
Sites/operator configuration. После этого authorized human/operator отдельно:

1. отзывает dedicated short-lived MCP tokens;
2. восстанавливает exact pre-run operator allowlist revision;
3. восстанавливает или подтверждает intended custom audience без groups и
   unexpected viewers;
4. сверяет provider privacy configuration/read-back по `MD-283`;
5. сохраняет только classification, configuration fingerprint и bounded
   before/after counts — без identities или raw provider logs.

Если credential скомпрометирован или actor должен быть немедленно удалён,
выполните emergency revoke из
[privacy-safe UAT operations](uat-pilot-operations.md#emergency-revoke).
Local `cleaned`/`recovered` state не является доказательством external cleanup.

State и evidence хранятся вне repository. После content-addressed handoff их
удаляют recoverable способом; identity mapping и secret values не архивируют.
