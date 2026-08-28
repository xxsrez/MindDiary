# Browser и UAT-проверка Settings / Connections

Статус: operational contract для MD-358, 2026-08-28. Локальная
детерминированная проверка реализована; hosted acceptance требует прямых
same-run наблюдений exact deployment через Sites connector, Codex in-app
Browser и fresh Codex/plugin client.

## Назначение и граница

Проверка соединяет обычный OAuth `Connections` и personal-token путь
`Advanced MCP` на одном exact candidate. Она подтверждает, что оба credential
profile получают одинаковый Site-owned lifecycle writable target, а ordinary
Connections не раскрывает protocol/credential internals.

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

## Локальный exact-candidate gate

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
   Codex client/version, не меняя shared OAuth direct-plugin profile;
3. исполняет точечные OAuth, personal-token, target-state, Product Site MCP,
   native staging и UI contract suites;
4. запускает pinned Playwright `1.62.1` и Chromium `151.0.7922.34` revision
   `1234` на существующем MD-300-style server-bound Connections fixture;
5. требует точный registry browser tests для empty/ready/paginated Connections,
   стабильного `/help/codex`, ACL-derived summary без read selector, Site-owned
   target controls, revoke/reconnect, personal-token show-once/target/history,
   redaction и fail-closed error states;
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
8. baseline, в котором нет per-run grant/token/target/Mind.

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
   concise current-ACL summary и не показывает read selector, attach/detach,
   raw IDs или protocol scopes.
3. Fresh/reconnected credential начинает с empty writable target.
4. На Site выбрать, переключить и очистить target через current
   `target_version`; Codex/MCP не управляет этим state.
5. После controlled redeploy connection и выбранный target сохраняются.
6. Revoke скрывает ordinary detail/list row, а следующий MCP request получает
   denial. Reconnect создаёт новый credential owner и empty target, не переносит
   прежнюю generation/capture.

### Advanced MCP personal token

1. Создать отдельный named token; secret доступен ровно один раз и не попадает
   в receipt.
2. Подтвердить empty target, затем Site select/switch/clear через independent
   token target version.
3. После controlled redeploy token и current target сохраняются.
4. Revoke закрывает следующий MCP request. Reissue создаёт новый owner с empty
   target и не переносит старую generation/capture.

### Privacy и cleanup

Ordinary projection сканируется на email, credential/token/grant/binding IDs,
owner/generation, raw body, cookie/header, private content и URL secrets.
Persisted evidence содержит только opaque actor/run fingerprints, classifications,
exact versions и hashes.

Cleanup продолжается после product failure и обязан доказать:

- revoke всех per-run OAuth grants и personal tokens;
- denial следующего request каждым credential;
- отсутствие credential и target на product side;
- отсутствие credential на provider side;
- удаление run Mind и exact route absence;
- возврат restricted pool к исходным role/token/audience/allowlist baselines.

Timeout или потерянный response сначала разрешается deployment/credential/
target/Mind read-back того же run fingerprint. До reconciliation повторная
выдача credential запрещена; classification — `unknown_external_outcome`.

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
Browser input schema
`mind-diary/settings-connections-in-app-browser-readback/v1` содержит closed
matrix Help/OAuth/personal-token/redeploy/privacy/cleanup и exact actor/plugin/
client lineage. Raw responses и secrets запрещены.

Join fail closed проверяет archive bytes, candidate/deployment/version,
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
