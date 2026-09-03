# Browser и UAT-проверка Settings / Connections

> **Current Web amendment MD-373/MD-375, 2026-08-30.** Выбор Minds теперь
> принадлежит principal: на странице каждого Mind задаётся
> `disabled | read | read_write`, одинаковый для всех OAuth connections и
> personal tokens. Connections и Advanced MCP показывают только lifecycle,
> credential scopes и derived effective capability; отдельные credential-owned
> Mind selection/capture controls удалены. Старые поля и assertion names
> квитанции MD-358 ниже сохранены только как историческая форма evidence и не
> подтверждают current Web contract.

Статус: operational contract для MD-358, 2026-08-28. Локальная
детерминированная проверка реализована; hosted acceptance требует прямых
same-run наблюдений exact deployment через Sites connector, Codex in-app
Browser и fresh Codex/plugin client.

## Назначение и граница

Проверка соединяет обычный OAuth `Connections`, personal-token путь
`Advanced MCP` и настройку Minds на одном exact candidate. Она подтверждает,
что оба credential profile получают одну principal-owned конфигурацию Minds,
а scopes только сужают effective capability. Ordinary Connections не выбирает
Mind и не раскрывает protocol/credential internals.

Локальная квитанция не подтверждает Sites deployment, real OAuth consent,
hosted persistence, provider cleanup или браузерную сессию пользователя. Даже
успешный offline join остаётся nonterminal: локальная программа может проверить
байты и форму входов, но не может аттестовать происхождение JSON из Sites и
in-app Browser.

Production, новые accounts, audience/allowlist mutation, реальные private
Minds и standing credentials исключены. Единственная human-only граница —
password/MFA/passkey существующего restricted-UAT account и явное подтверждение
нового persistent OAuth scope ровно в момент, когда fresh flow действительно
его требует.

Закрытый machine contract находится в
`tests/fixtures/settings-connections-uat/contract.v1.json`.

## Historical MD-358 local exact-candidate gate

Gate запускается после одного build на чистом `HEAD`. Output — новый файл в
существующем owner-only temporary directory с exact mode `0700`, вне repository
и всех его worktrees:

```bash
MD358_TEMP_ROOT=${TMPDIR:-/tmp}
MD358_EVIDENCE_DIR=$(mktemp -d "${MD358_TEMP_ROOT%/}/mind-diary-md358-evidence.XXXXXX")
npm run gate:settings-connections-local -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --evidence-out "$MD358_EVIDENCE_DIR/settings-connections-local.json"
```

Если clean Srez Marketplace checkout расположен не рядом с MindDiary, runner
принимает дополнительный `--marketplace-root <absolute-clean-checkout>`. Других
inputs нет: deployment ID, hosted status, actor, browser URL или approval через
CLI передать невозможно.

Runner последовательно:

1. сверяет exact clean candidate до и после выполнения;
2. в отдельном временном `CODEX_HOME` устанавливает fresh Marketplace/plugin и
   получает фактические HEAD/tree, plugin snapshot/version, MCP resolution и
   Codex client/version, не меняя shared OAuth direct-plugin profile; для
   Codex 0.150.1 установленный HTTP server обязан иметь
   `auth_status: o_auth`, что означает доступный OAuth flow, но не выполненный
   вход и не наличие сохранённой credential;
3. исполняет frozen OAuth, personal-token, historical target-state, Product
   Site MCP, native staging и UI contract suites MD-358;
4. запускает pinned Playwright `1.62.1` и Chromium `151.0.7922.34` revision
   `1234` на существующем MD-300-style server-bound Connections fixture;
5. требует frozen registry browser tests MD-358 для Connections, Help,
   personal-token lifecycle, redaction и fail-closed states;
6. закрывает fixture processes/browser contexts, уничтожает synthetic OAuth
   adapters и удаляет temporary inputs.

Receipt `mind-diary/settings-connections-local-evidence/v1` фиксирует exact
candidate, plugin/client/toolchain/source hashes, закрытые local assertions и
три разных каталога: default Product Site write `17`, read-only `16` и только
для verified native route полный `18`. Shared OAuth direct-plugin full-write
profile остаётся отдельным intentional `18`-tool contract.
Он всегда содержит:

```json
{
  "status": "passed",
  "hosted_evidence": false,
  "hosted_status": "not-run",
  "acceptance": "local-deterministic-only",
  "deployment_id": null
}
```

Локальный result не подменяет in-app Browser, real Codex OAuth или post-redeploy
read-back независимо от полноты synthetic matrix.

Checked-in `mind-diary/settings-connections-local-evidence/v1` и
`mind-diary/settings-connections-uat-contract/v1` появились до MD-373. Их
старые `target_*`, `*_empty_target` и похожие row names можно использовать
только для воспроизводимости уже собранного MD-358 evidence. Fresh acceptance
не трактует эти names как существующий UI или authority: current доказательство
даёт principal usage projection и отсутствие credential-specific controls.

### Current MD-375 local supplement

Перед UAT exact candidate проходит полный repository gate из
[release profile](ship-work-release-profile.md).
Дополнительно current Web evidence обязано включать passing results следующих
точечных consumers:

```bash
node --test \
  tests/unit/connections-experience-ui.test.mjs \
  tests/unit/mcp-token-management-ui.test.mjs \
  tests/integration/product-site.test.mjs
npx playwright test \
  tests/browser/connections/connections.spec.mjs \
  tests/browser/mind-usage/mind-usage.spec.mjs
```

Эти тесты проверяют scope/lifecycle-only credential pages, три account-wide
mode, singleton switch, CAS/read-back/conflict и отсутствие старых
credential-specific Mind controls. Они не являются hosted evidence.

## Hosted prerequisites

До первого mutable UAT action orchestrating agent в одном непрерывном run сам
получает:

1. passing local receipt exact candidate;
2. exact Sites archive этого candidate;
3. direct Sites read-back current project, saved version, source commit,
   archive size/hash и successful initial deployment;
4. controlled redeploy той же version с отличным deployment ID и terminal
   successful read-back;
5. fresh `mind-diary/uat-test-account-pool-readiness/v2` того же candidate и
   второго deployment;
6. accepted provider-boundary receipt той же project/version/deployment/archive;
7. short-lived sessions `UAT-MIND-ROLE` и `UAT-ORDINARY`, Codex in-app Browser
   и fresh Codex/plugin context exact version;
8. baseline, в котором нет per-run grant/token/Mind, а configured usage modes
   текущего principal прочитаны и зафиксированы без внутренних IDs.

Mismatch candidate, archive, deployment, actor fingerprint, plugin/client
version или baseline останавливает run до mutation. Переданный ID, старый
receipt, локальный Site lookalike, Safari/system browser, screenshot или manual
approval не являются prerequisite evidence.

## Hosted matrix

Все actions используют dedicated run fingerprint. Read-back предыдущего шага
является входом следующего; новый nonce поверх unknown outcome запрещён.

### Stable navigation и OAuth Connections

1. Проверить `/help/codex` в состояниях no connection, active и revoked:
   route/link/copy остаются доступны и не становятся wizard/progress state.
2. Fresh OAuth создаёт active connection на exact plugin/client, показывает
   client lifecycle и credential scopes и не показывает Mind selector,
   attach/detach, raw IDs или отдельную automatic-save policy.
3. На `/minds` прочитать все доступные Minds с name, routing profile,
   configured mode и effective availability. Personal `/me` не имеет
   description и допускает `read_write`, но каждый content write требует
   прямой текущей просьбы пользователя о конкретном знании. Ordinary Mind
   сохраняет обязательный routing description для `read_write`. Новый
   principal начинает с `disabled`.
4. Через current `expected_usage_version` включить несколько `read` Minds и
   один `read_write`. Переключение второго Mind в `read_write` атомарно
   переводит прежний writable Mind в `read`; Codex/MCP не меняет этот state.
5. Второй OAuth credential того же principal видит ту же configured projection.
   Read-only либо потерявший ACL credential получает только суженный effective
   result, не отдельную конфигурацию.
6. После controlled redeploy connection и principal usage modes сохраняются.
7. Revoke скрывает ordinary detail/list row, а следующий MCP request получает
   denial. Reconnect создаёт новый credential, но не сбрасывает и не копирует
   principal usage: fresh connection видит те же current modes.

### Advanced MCP personal token

1. Создать отдельный named token; secret доступен ровно один раз и не попадает
   в receipt.
2. Подтвердить, что token page показывает только lifecycle/scopes и ссылку на
   account-wide Mind modes, без отдельного Mind selector или automatic-save
   toggle.
3. Через `list_minds` прочитать ту же configured projection, что у OAuth
   connection. Для read-only token `usage_mode: read_write` остаётся видимым,
   но `effective.can_write=false`.
4. После controlled redeploy token и principal usage modes сохраняются.
5. Revoke закрывает следующий MCP request. Reissue меняет только credential
   lifecycle и scopes; principal usage modes остаются прежними.

### Privacy и cleanup

Ordinary projection сканируется на email, credential/token/grant/binding IDs,
owner/generation, raw body, cookie/header, private content и URL secrets. Также
проверяется отсутствие credential-owned Mind controls и внутренних Mind IDs в
mode read-back.
Persisted evidence содержит только opaque actor/run fingerprints, classifications,
exact versions и hashes.

Cleanup продолжается после product failure и обязан доказать:

- revoke всех per-run OAuth grants и personal tokens;
- denial следующего request каждым credential;
- отсутствие per-run credentials на product side;
- отсутствие credential на provider side;
- удаление run Mind и exact route absence;
- возврат restricted pool к исходным role/token/audience/allowlist baselines;
- read-back исходных principal usage modes либо отсутствие удалённого run Mind
  в usage projection.

Timeout или потерянный response сначала разрешается deployment/credential/
usage-version/Mind/HEAD read-back того же run fingerprint. До reconciliation
повторная выдача credential или mode mutation запрещена; classification —
`unknown_external_outcome`.

## Offline structural join

После прямых read-back можно проверить точную структурную согласованность:

```bash
npm run join:settings-connections-uat -- \
  --local-receipt "$MD358_EVIDENCE_DIR/settings-connections-local.json" \
  --provider-readback "$MD358_EVIDENCE_DIR/provider-readback.json" \
  --pool-readback "$MD358_EVIDENCE_DIR/pool-readback.json" \
  --provider-boundary-readback "$MD358_EVIDENCE_DIR/provider-boundary.json" \
  --browser-readback "$MD358_EVIDENCE_DIR/browser-readback.json" \
  --artifact-archive "$MD358_EVIDENCE_DIR/site.tgz" \
  --candidate-sha <exact-deployed-sha> \
  --join-out "$MD358_EVIDENCE_DIR/settings-connections-uat-join.json"
```

Provider input schema
`mind-diary/settings-connections-sites-provider-readback/v1` связывает exact
archive с candidate/version, initial deployment и distinct controlled redeploy.
Текущий Sites source `commit_sha` является отдельным subtree-mirror commit:
joiner извлекает его только из provider input, требует subject
`Mirror MindDiary <candidate-sha>` и exact tree
`<candidate-sha>:apps/mind-diary-site`. Mirror SHA не выдаётся за SHA
монорепозитория; direct-candidate topology принимается только при реальном
совпадении SHA.
Browser input schema
`mind-diary/settings-connections-in-app-browser-readback/v1` содержит closed
matrix Help/OAuth/personal-token/redeploy/privacy/cleanup и exact actor/plugin/
client lineage. Raw responses и secrets запрещены.

Поля этой v1 matrix с `target_*` names являются historical slots. Offline
joiner проверяет их форму для воспроизводимости MD-358, но не умеет сам
доказать current principal modes. Поэтому его result остаётся только
структурным дополнением к direct current Web/MCP read-back.

Join fail closed проверяет archive bytes, candidate, source mirror,
deployment/version,
readiness actors, provider boundary, local receipt, plugin/client versions,
все assertion IDs и полный cleanup. Output резервируется атомарно в private
temp и всегда имеет только:

```json
{
  "status": "structurally_verified_readback",
  "hosted_evidence": false,
  "acceptance": "nonterminal",
  "provenance": "unverified-local-files"
}
```

CLI не принимает `hosted-pass`, approval или actor override. Совпавшие
lookalike files не превращаются в UAT PASS.

## Terminal hosted evidence

Terminal record `mind-diary/uat-release-0.3-connections-evidence/v1` может
создать только orchestrating agent, который сам наблюдал в текущем run все
Sites calls, fresh Codex/plugin operations и in-app Browser journeys. Он
связывает hashes/refs raw tool outputs, local receipt и structural join с exact
candidate/version/deployments, actor/run fingerprints, закрытой matrix и
cleanup absence read-back.

Для current candidate закрытая matrix дополнительно включает default
`disabled`, несколько `read`, singleton/atomic switch `read_write`, одинаковую
configured projection разных credentials, scope/ACL narrowing, Personal
requested-only write и ordinary description gate, persistence after redeploy и
отсутствие Mind controls на обеих credential pages. Legacy target rows без этих
direct observations не дают terminal PASS.

Repository script намеренно не создаёт и не валидирует hosted PASS: authority
опирается на direct same-run observations, а не на форму файла. Без них MD-358
остаётся nonterminal даже при passing local gate и structural join.

## Failure classification

- `product_defect` — direct exact-deployment observation нарушил contract;
- `service_fault` — проверка не дошла до надёжного product outcome;
- `missing_external_capability` — отсутствует exact required Sites/Browser/
  Codex primitive;
- `credential_role_or_approval` — существующий restricted actor требует
  password/MFA/passkey или exact new persistent OAuth scope;
- `unknown_external_outcome` — mutation нельзя безопасно повторить до read-back;
- `blocked_by_dependency` — lineage, readiness или provider boundary не готов.

Незавершённый provider/product cleanup всегда остаётся blocker и не скрывается
остальными passing rows.
