# Трассируемость требований Release 0.3

Статус: accepted verification contract для MD-338, 2026-08-27.

Документ связывает целевой scope `MD-329`–`MD-335` с владельцами,
автоматическими локальными проверками и hosted UAT evidence. Канонический
машинный реестр —
`tests/fixtures/release-0.3-traceability/contract.v1.json`; его закрытую схему,
forward/reverse coverage и существование source/test/fixture paths проверяет
`tests/conformance/release-0.3-traceability-contract.test.mjs`.

Passing validator доказывает полноту verification contract, но не наличие ещё
не реализованного поведения и не пройденный UAT. Runtime claim возникает только
из passing local и hosted receipts одного exact candidate/deployment.

## Правило доказательства

У каждой requirement есть один owning Task, beneficiary outcome, accepted
decision, domain invariant, authorization boundary, диспозиция REST/MCP/UI/
migration, exact local evidence, hosted evidence и stable assertion ID.
Evidence row задаёт actors, fixtures, setup, cleanup, recovery,
unknown-outcome handling и independent read-back. Обратная ссылка evidence →
requirement обязательна; orphan requirement, evidence или assertion делает
validator красным.

Hosted runner сначала проверяет exact `candidate_sha`, `deployment_id` и pool
readiness receipt, затем создаёт run-owned state. Passing receipt имеет
закрытые поля `status`, `candidate_sha`, `deployment_id`, `runner_id`,
`actor_fingerprints`, `assertions`, `read_back`, `cleanup`, `artifact_sha256`.
Identity, email, session, credential secret, private corpus, local path и signed
URL в receipt запрещены.

## Forward matrix

Точные REST/MCP/UI/migration формулировки находятся в machine registry; таблица
показывает причинную связь и stable joins.

| Requirement | Owner | Outcome и проверяемая граница | Local / hosted | Assertion |
|---|---|---|---|---|
| `R03-329-BOUNDARY` | `MD-336` | Один Site admin surface и content-only MCP; Site не читает corpus, MCP не получает control plane. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.authority.surface-separation` |
| `R03-329-DISPOSITION` | `MD-337` | Каждая операция имеет keep/change/move/remove; legacy route не возвращает удалённую authority. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.authority.operation-disposition` |
| `R03-329-TRACEABILITY` | `MD-338` | Requirement, owner, assertion и evidence образуют закрытый registry без private evidence. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.traceability.closed-registry` |
| `R03-330-CONTRACT` | `MD-339` | Reads выводятся из current ACL/visibility; credential имеет `0..1` Site-selected target, MCP не меняет target. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.target.accepted-contract` |
| `R03-330-STORAGE` | `MD-340` | Удаление read bindings не меняет authority; owner immutable, generations opaque и never reused. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.target.storage-migration` |
| `R03-330-READS` | `MD-341` | Видны ровно доступные сейчас Minds; один Mind/exact revision, historical read проверяет current access. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.reads.current-acl` |
| `R03-330-CATALOG` | `MD-342` | Fresh clients получают закрытый content-only catalog; retired names ничего не меняют. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.mcp.catalog-closed` |
| `R03-330-TARGET` | `MD-343` | Site select/switch/clear target через CAS; commit rechecks scope, role, generation, HEAD и idempotency. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.target.lifecycle` |
| `R03-330-UAT` | `MD-344` | ACL reads и singleton target доказаны на exact deployment без standing token или real data. | `L-AUTHORITY` / `U-AUTHORITY` | `r03.target.uat-joined` |
| `R03-331-IA` | `MD-345` | Compact shell сохраняет Personal Mind первым, Settings вторичным и безопасные direct routes. | `L-SHELL` / `U-SHELL` | `r03.shell.information-architecture` |
| `R03-331-SHELL` | `MD-346` | Site остаётся admin-only без content reader/editor; writes используют server session и CSRF. | `L-SHELL` / `U-SHELL` | `r03.shell.admin-only` |
| `R03-331-BROWSER` | `MD-347` | Desktop/mobile/keyboard flow работает без overflow/hidden focus; browser input не выбирает identity. | `L-SHELL` / `U-SHELL` | `r03.shell.browser-accessibility` |
| `R03-331-ACCOUNT` | `MD-365` | Signed-out и first-auth states ведут к sign-in или isolated bootstrap без access relink. | `L-SHELL` / `U-SHELL` | `r03.shell.account-entry` |
| `R03-332-DESCRIPTION` | `MD-348` | Description — metadata, не OKF/search/instruction; metadata CAS не меняет HEAD. | `L-MINDS` / `U-MINDS` | `r03.minds.description-metadata` |
| `R03-332-MANAGEMENT` | `MD-349` | List/detail/create/manage сохраняют Personal Mind и immutable handle invariants. | `L-MINDS` / `U-MINDS` | `r03.minds.management` |
| `R03-332-CATALOG` | `MD-350` | Owner видит immediate public/unlisted disclosure; только Owner меняет visibility. | `L-MINDS` / `U-MINDS` | `r03.minds.visibility-catalog` |
| `R03-332-UAT` | `MD-351` | Mind admin переживает redeploy и после run не оставляет Mind/credential. | `L-MINDS` / `U-MINDS` | `r03.minds.uat-joined` |
| `R03-333-ACCESS-UI` | `MD-352` | Members и pending invitations видны вместе; pending не membership, Admin/Owner authority различается. | `L-ACCESS` / `U-ACCESS` | `r03.access.overview` |
| `R03-333-MEMBERSHIP` | `MD-353` | Invite/accept/reject/reissue/revoke/leave дают immediate current-role result без duplicate replay. | `L-ACCESS` / `U-ACCESS` | `r03.access.membership-lifecycle` |
| `R03-333-UAT` | `MD-354` | Три stable actors последовательно исполняют roles без нового user/external email. | `L-ACCESS` / `U-ACCESS` | `r03.access.uat-joined` |
| `R03-333-TRANSFER` | `MD-366` | Ownership atomically переходит active participant; всегда ровно один Owner. | `L-ACCESS` / `U-ACCESS` | `r03.access.ownership-transfer` |
| `R03-334-NAV` | `MD-355` | Connections — optional Settings help, не blocking wizard; Mind flow не зависит от MCP setup. | `L-CONNECTIONS` / `U-CONNECTIONS` | `r03.connections.optional-navigation` |
| `R03-334-CONNECTION` | `MD-356` | OAuth status/revoke/target видны без IDs/secrets; cross-owner lookup indistinguishable. | `L-CONNECTIONS` / `U-CONNECTIONS` | `r03.connections.detail` |
| `R03-334-TOKENS` | `MD-357` | Advanced MCP управляет show-once token и независимым target; MCP не управляет credentials. | `L-CONNECTIONS` / `U-CONNECTIONS` | `r03.connections.personal-token` |
| `R03-334-UAT` | `MD-358` | Fresh plugin/OAuth и personal token доказывают target lifecycle с dedicated test state. | `L-CONNECTIONS` / `U-CONNECTIONS` | `r03.connections.uat-joined` |
| `R03-335-AUTHORITY` | `MD-359` | Bulk import/export остаются Site controls; MCP сохраняет per-file ingress/content operations. | `L-TRANSFER` / `U-TRANSFER` | `r03.transfer.web-authority` |
| `R03-335-IMPORT-RUNTIME` | `MD-360` | Generated Markdown snapshot создаёт одну revision либо ничего; plan pins base/quota/bytes. | `L-TRANSFER` / `U-TRANSFER` | `r03.transfer.import-runtime` |
| `R03-335-EXPORT-RUNTIME` | `MD-361` | Current/historical export выдаёт deterministic bytes; one-use grant rechecks access. | `L-TRANSFER` / `U-TRANSFER` | `r03.transfer.export-runtime` |
| `R03-335-IMPORT-UI` | `MD-362` | До confirm видны generated plan/conflicts/quota; file input не задаёт identity/authority. | `L-TRANSFER` / `U-TRANSFER` | `r03.transfer.import-ui` |
| `R03-335-UAT` | `MD-363` | Exact bytes/history/redeploy/cleanup проверяются без user file или visual compare. | `L-TRANSFER` / `U-TRANSFER` | `r03.transfer.uat-joined` |
| `R03-335-EXPORT-UI` | `MD-367` | Current/historical revision выбирается явно, verified download не двигает HEAD. | `L-TRANSFER` / `U-TRANSFER` | `r03.transfer.export-ui` |

## Evidence rows

| Evidence | Owner | Exact command или runner | Основной read-back |
|---|---|---|---|
| `L-AUTHORITY` | `MD-338` | `npm run build --silent && node --test tests/conformance/release-0.3-operation-disposition-contract.test.mjs tests/conformance/credential-write-target-contract.test.mjs tests/integration/synthetic-multi-principal-probe.test.mjs` | closed catalogs, ACL/target/restart/cleanup |
| `U-AUTHORITY` | `MD-344` | `ship-work-release/uat-release-0.3-authority-target/v1` | deployment catalogs, ACL/target/reconnect/cleanup |
| `L-SHELL` | `MD-347` | exact Node + Playwright command in machine registry | DOM, accessibility tree, direct routes, bootstrap |
| `U-SHELL` | `MD-347` | `ship-work-release/uat-release-0.3-admin-shell/v1` | hosted DOM/session/bootstrap/direct-route reload |
| `L-MINDS` | `MD-351` | exact ordinary-Mind/visibility/catalog command in registry | metadata, catalog, HEAD and exact absence |
| `U-MINDS` | `MD-351` | `ship-work-release/uat-release-0.3-minds-admin/v1` | run Mind, redeploy persistence and cleanup |
| `L-ACCESS` | `MD-354` | exact invitation/membership/transfer command in registry | pending/roles/next-request/sole owner |
| `U-ACCESS` | `MD-354` | `ship-work-release/uat-release-0.3-access-admin/v1` | sequential roles, revoke and pool baseline |
| `L-CONNECTIONS` | `MD-358` | exact token/OAuth/target/plugin command in registry | target generation, provider/product absence |
| `U-CONNECTIONS` | `MD-358` | `ship-work-release/uat-release-0.3-connections/v1` | fresh client, target/revoke/provider join |
| `L-TRANSFER` | `MD-363` | exact import/export/bytes/hash/grant command in registry | revision, bytes/hash, grant, HEAD and cleanup |
| `U-TRANSFER` | `MD-363` | `ship-work-release/uat-release-0.3-import-export/v1` | browser plan, bytes/history/redeploy/absence |

Hosted runner IDs — stable check-definition identifiers. Их implementation и
passing receipts принадлежат downstream Tasks; MD-338 не выдаёт их за уже
выполненный UAT. Каждый runner получает `candidate_sha`, `deployment_id`, pool
readiness receipt и private evidence directory; `U-CONNECTIONS` также получает
provider-boundary receipt.

## Actors, fixtures, cleanup и recovery

Повторно используются:

- `MD-237`: synthetic multi-principal ACL/history/persistence/cleanup gate;
- `MD-282`: максимум три restricted-UAT actors — `UAT-OPERATOR`,
  `UAT-MIND-ROLE`, `UAT-ORDINARY` — и privacy-safe pool receipt;
- `MD-299`: fresh real-account/plugin OAuth и exact-deployment receipt join;
- `MD-300`: deterministic Chromium, DOM/accessibility/viewport fixtures и
  закрытие run-owned browser contexts.

Роли выполняются последовательно на тех же трёх actors. Runner не создаёт
external account и не меняет audience/allowlist. Для run создаются отдельные
Mind, OAuth client/grant, personal token и namespaced job IDs. Browser files
генерируются во временном private directory вне repository; user-selected file,
private corpus и local path в receipt запрещены.

Успешный и аварийный cleanup отзывает credentials, проверяет denial следующего
request, отменяет/сверяет jobs, удаляет run Mind, browser files/profiles и
делает absence read-back. При interruption runner прекращает новые writes,
сохраняет lineage/fingerprint, читает provider/product/deployment state и
только затем cleanup/retry. Неизвестный результат получает
`unknown_external_outcome`; новый nonce поверх неизвестного state запрещён.

## External prerequisite и blocker taxonomy

Единственная штатная внешняя предпосылка hosted rows — short-lived sessions
существующих restricted-UAT accounts. Владелец external identity вводит
password/MFA/passkey и подтверждает fresh pool read-back. Resume signal:
`three_distinct_short_lived_session_references_and_fresh_pool_read_back_are_available`.

Automation не расширяет OAuth authority. Если fresh action требует новый
persistent scope, runner останавливается в точке действия с
`credential_role_or_approval`; resume signal — exact scope grant/read-back, не
общее «нужно участие пользователя». Routine test run, file selection, visual
confirmation, private data, external recipient и vague user acceptance
запрещены. Review завершается только `pass` или `concrete_defect`.

Blocker использует ровно одну категорию: `service_fault`, `product_defect`,
`missing_external_capability`, `credential_role_or_approval`,
`unknown_external_outcome`, `blocked_by_dependency`. Для отсутствующей
capability нужны fresh probe, exact missing primitive, affected assertion и
observable resume signal.

`MD-290`, `MD-311`, `MD-317`, `MD-319`, `MD-344`, `MD-347`, `MD-351`,
`MD-354`, `MD-358` и `MD-363` не содержат routine user-run step. Fixtures,
Minds, credentials, local/browser/hosted execution, reconciliation и cleanup
принадлежат агенту; reviewer сообщает только concrete defect.

## Проверка registry

```bash
npm run build --silent
node --test tests/conformance/release-0.3-traceability-contract.test.mjs
ruby /home/example/.codex/skills/project-docs/scripts/validate_docs.rb .
npm run check:docs
npm run check:architecture
git diff --check
```

Validator проверяет exact owners, paths, max-three actor policy, generated
browser files, dedicated OAuth/provider state, blocker taxonomy и обратное
покрытие. Requirement/evidence без обеих связей добавить невозможно.
