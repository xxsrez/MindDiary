# Traceability matrix MVP 0.1

Статус: executable baseline, обновлено 2026-08-08. Документ связывает
принятые критерии готовности с реализацией и обязательным evidence. Product Site
source candidate и targeted repository tests существуют; это не утверждение о
production OpenAI Site или live deployment.

Текущий состав source candidate и незакрытые live gates зафиксированы в
[датированном report](../reports/2026-08-08-product-site-candidate.md). Этот
report не меняет owning stories или обязательные `A<n>`, `W`, `P`, `MI`, `CX`
и `R` artifacts.

## Как читать матрицу

Источник критериев — раздел
[«Критерии готовности»](mvp.md#критерии-готовности). `Owning story` — ровно одна
Linear story, которая обязана реализовать criterion и оставить executable
evidence. Сквозные stories `AND-85`–`AND-90` проверяют и собирают evidence для
критериев 1–27, но не подменяют их owners; для критериев 28–29 `AND-85` и
`AND-90` сами являются прямыми owners.

Типы executable evidence:

- `U/P` — deterministic unit/property tests доменных правил;
- `C` — schema/contract fixtures REST, MCP или OKF;
- `I` — integration tests application core и выбранных adapters;
- `B` — browser E2E first-party control plane;
- `S` — security/privacy regression;
- `F` — concurrency/failure-injection;
- `M` — MCP Inspector или real-client conformance;
- `L` — repeatable redacted live probe production candidate.

Release evidence использует один набор ссылок:

- `A<n>` — строка criterion `<n>` в generated trace report `AND-85`, связанная
  с exact candidate Git SHA и конкретными test/evidence IDs;
- `W` — authenticated web/control smoke `AND-89`/`AND-90`;
- `P` — persistence-after-redeploy probe `AND-89`;
- `MI` — MCP Inspector report `AND-77`;
- `CX` — real Codex report `AND-77`/`AND-90`;
- `R` — release manifest `AND-90`: exact Git SHA, Sites project, version,
  deployment, live URL и время проверки.

`A<n>` и `R` обязательны для каждой строки. Остальные обозначения показывают,
какой live artifact дополнительно должен подтвердить criterion. Evidence
сохраняется redacted: без token, private content/query, verified email, CSRF
secret и download URL.

## Критерии 1–29

| № | Наблюдаемый criterion | Owning story | Executable evidence | Release evidence |
|---:|---|---|---|---|
| 1 | Explicit Sites account creation атомарно создаёт principal, `/me` и sole Owner; retry/concurrency не дублирует их, unknown identity не наследует access. | `AND-45` | `U/P, I, F, B`: bootstrap success/retry/race, isolated identity и итоговое состояние после fault. | `A1 + W + P + R` |
| 2 | Personal Mind недоступен другому principal и не допускает share, transfer, visibility change или отдельный delete. | `AND-46` | `U/P, I, B`: все ordinary lifecycle commands denied, owner/visibility state неизменен. | `A2 + W + R` |
| 3 | Rename principal меняет только display name Personal Mind; `space_id`, HEAD/history и `/me` стабильны. | `AND-46` | `U/P, I, B`: metadata CAS, stale conflict и invariant snapshot до/после. | `A3 + W + P + R` |
| 4 | Create ordinary Mind требует name, canonical handle и sole Owner; occupied/reserved/retired одинаково дают `handle_unavailable`, display names не unique. | `AND-48` | `U/P, I, F, B`: validation, concurrent reservation, rollback и generic error fixtures. | `A4 + W + P + R` |
| 5 | Transfer existing active participant атомарно оставляет одного Owner, source становится Admin; pending target denied. | `AND-56` | `U/P, I, F, B`: success, pending/invalid/stale и concurrent transfer с post-state assertions. | `A5 + W + P + R` |
| 6 | Admin управляет только Reader/Editor; Owner — Admin и visibility; revoke/leave сразу убирает stale access. | `AND-55` | `U/P, I, F, B`: role capability matrix, stale CAS, revoke/leave и повторная authorization. | `A6 + W + P + R` |
| 7 | Registered-principal invitation не даёт access до acceptance, expires через семь дней и не создаёт duplicate membership при retry. | `AND-54` | `U/P, I, F, B`: clock fixtures, accept/reject/cancel/reissue, replay/race и resulting membership. | `A7 + W + P + R` |
| 8 | Anonymous доступ отсутствует; authenticated private member, public и exact-handle unlisted caller получают только свои rights. | `AND-50` | `U/P, I, S, B`: visibility matrix, non-enumeration, anonymous denial и baseline read-only post-state. | `A8 + W + CX + R` |
| 9 | Catalog содержит только public Minds; private switch закрывает baseline reads; UI объясняет live HEAD/history exposure и что unlisted URL не secret. | `AND-81` | `C, I, B`: catalog/transition contract, disclosure acknowledgement, stale cache/access regression. | `A9 + W + P + R` |
| 10 | `list_minds` показывает `/me`, memberships и public catalog; private скрыт, unlisted без membership требует exact resolve. | `AND-60` | `C, I, M`: pagination/discovery fixtures, private/missing indistinguishability и exact resolve. | `A10 + MI + CX + R` |
| 11 | Один principal token работает с несколькими allowed Minds, но каждый call разрешает ровно один Mind/revision без cross-Mind leakage. | `AND-74` | `C, I, S, M`: explicit selector, mismatched opaque IDs/cursors и multi-Mind isolation. | `A11 + MI + CX + R` |
| 12 | Expired/revoked token denied; issuance replay не раскрывает secret; write включает read, read-only не пишет; telemetry не содержит secret/body. | `AND-58` | `U/P, C, I, S, M`: expiry/revoke/scope/replay plus automated log redaction. | `A12 + MI + CX + R` |
| 13 | Reader/baseline Reader не commit-ит; Editor/Admin/Owner с `content:write` immediate commit-ит без draft/approval. | `AND-65` | `U/P, C, I, M`: effective role∩scope matrix, direct call denial и отсутствие state после error. | `A13 + MI + CX + R` |
| 14 | Current `expected_revision` создаёт одну new HEAD; stale revision возвращает conflict без reachable partial objects/revision. | `AND-67` | `U/P, I, F, M`: two-writer race, injected object-put→CAS fault и HEAD/object post-state. | `A14 + CX + P + R` |
| 15 | Same namespaced key/payload возвращает тот же revision и не дублирует log; другой payload даёт idempotency conflict. | `AND-69` | `U/P, I, F, M`: same/different payload replay, cross-principal/space isolation и concurrent retries. | `A15 + CX + P + R` |
| 16 | Concept, `index.md` и `log.md` появляются all-or-nothing; log остаётся valid newest-first/date-grouped OKF. | `AND-71` | `U/P, C, I, F, M`: clock-based log fixtures, invalid/stale operations и full-bundle post-validation. | `A16 + CX + P + R` |
| 17 | `fetch(id)` после HEAD move возвращает exact найденную immutable revision. | `AND-61` | `C, I, S, M`: opaque ID/continuation/resource binding before/after HEAD move and authorization recheck. | `A17 + MI + CX + R` |
| 18 | Historical selector всегда read-only и использует current access; public→private отзывает history у non-member. | `AND-62` | `U/P, C, I, S, M`: exact/as-of boundaries, Owner write denial и access transition. | `A18 + MI + CX + R` |
| 19 | File delete сохраняет старую revision; whole-Mind delete удаляет history/linked records, инвалидирует locators и навсегда retires non-linkable handle без forensic receipt. | `AND-52` | `U/P, I, F, B`: deletion impact, injected retry/race, old-file precondition и post-delete storage/locator scan. | `A19 + W + P + R` |
| 20 | Account delete выполняет весь cascade, отзывает identity/tokens и сохраняет foreign commits только с non-PII `deleted-principal`; UI показывает impact. | `AND-47` | `U/P, I, F, B`: fresh/stale preview, crash/retry, cross-aggregate reconciliation и PII-negative scan. | `A20 + W + P + R` |
| 21 | Changeset принимает только UTF-8 Markdown и пишет OKF 0.2; ZIP/import и non-Markdown transport отсутствуют. | `AND-41` | `U/P, C, I`: canonical path/UTF-8/full-bundle fixtures и negative API/MCP schema checks. | `A21 + CX + R` |
| 22 | Unknown OKF fields/types переживают read-modify-write/export; conformance errors отделены от quality warnings. | `AND-41` | `U/P, C, I`: audited OKF 0.2 round-trip corpus, byte/semantic diff и separate validation classes. | `A22 + CX + R` |
| 23 | Reader/baseline Reader экспортирует exact allowed revision через повторно авторизованный short-lived download без service metadata. | `AND-72` | `C, I, F, M`: access change build→grant, expiry, deterministic archive inspection и no-URL logging. | `A23 + CX + P + R` |
| 24 | Search/fetch фильтруются по exact space/revision; missing historical index не подмешивает HEAD. | `AND-63` | `U/P, I, F, S, M`: seeded two-space/two-revision corpus, lag/missing index и result provenance. | `A24 + MI + CX + R` |
| 25 | Corpus не расширяет scopes и не получает control-plane tools; allowed-write prompt injection остаётся явно residual risk. | `AND-76` | `C, I, S, M`: adversarial corpus, direct tool calls, tool catalog and state/telemetry assertions. | `A25 + MI + CX + R` |
| 26 | MCP публикует custom Mind-aware profile без company-knowledge claim или user-openable content URLs. | `AND-76` | `C, S, M`: deterministic tool/resource catalog, absent standard/control surfaces и URI checks. | `A26 + MI + CX + R` |
| 27 | MCP Inspector и real Codex проходят declared `2026-07-28` adapter/client pair; Claude support без отдельного test не заявляется. | `AND-77` | `M, L`: pinned client versions, Inspector suite и redacted Codex read/write/conflict/history/export flow. | `A27 + MI + CX + R` |
| 28 | Validators, fixtures and docs checks проходят на одном commit; deployment не считается завершённым без live evidence. | `AND-85` | `C, I, S, F`: canonical full check и generated criterion→test/evidence report exact SHA. | `A28 + R` |
| 29 | Production release связывает exact SHA с одним Sites deployment/live URL и на нём проходит полный authenticated web/control+persistence+MCP flow. | `AND-90` | `L`: same-deployment web/control, persistence, Inspector and Codex probes after publish/redeploy. | `A29 + W + P + MI + CX + R` |

## Machine-readable evidence registry

Блок ниже — authoritative input для
`node scripts/generate-readiness-report.mjs`. Generator читает его из exact
candidate commit, сверяет с human-readable matrix, проверяет tracked paths и
canonical commands и выпускает один reproducible JSON report. `pending` local
gate или отсутствующий live receipt никогда не превращается в `passed`.

Live receipts сохраняются по указанным candidate-scoped paths и используют
schema `mind-diary/readiness-evidence/v1`. Каждый receipt содержит exact
`candidate_sha`, `slot`, `status` и одну deployment identity:
`site_project_id`, `site_version_id`, `deployment_id`, `live_url`. Receipt с
другим SHA, malformed contract или identity, не совпадающей с `R`, является
failure; отсутствующий receipt остаётся pending.

<!-- readiness-registry:start -->
```json
{
  "schema": "mind-diary/readiness-registry/v1",
  "criteria": [
    { "id": 1, "owner": "AND-45", "local_evidence": ["account-bootstrap", "sites-identity-binding"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 2, "owner": "AND-46", "local_evidence": ["personal-mind-control"], "live_evidence": ["W"], "release_evidence": "R" },
    { "id": 3, "owner": "AND-46", "local_evidence": ["personal-mind-control"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 4, "owner": "AND-48", "local_evidence": ["ordinary-mind-control", "handle-registry"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 5, "owner": "AND-56", "local_evidence": ["ownership-transfer"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 6, "owner": "AND-55", "local_evidence": ["membership-control"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 7, "owner": "AND-54", "local_evidence": ["invitation-control", "invitation-lifecycle"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 8, "owner": "AND-50", "local_evidence": ["mind-routes", "security-privacy-threat"], "live_evidence": ["W", "CX"], "release_evidence": "R" },
    { "id": 9, "owner": "AND-81", "local_evidence": ["public-minds-catalog", "visibility-catalog-ui"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 10, "owner": "AND-60", "local_evidence": ["mind-discovery"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 11, "owner": "AND-74", "local_evidence": ["mind-discovery", "security-privacy-threat"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 12, "owner": "AND-58", "local_evidence": ["mcp-auth", "token-security"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 13, "owner": "AND-65", "local_evidence": ["changeset-preflight", "mcp-commit-export"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 14, "owner": "AND-67", "local_evidence": ["changeset-commit", "concurrency-failure"], "live_evidence": ["CX", "P"], "release_evidence": "R" },
    { "id": 15, "owner": "AND-69", "local_evidence": ["changeset-idempotency"], "live_evidence": ["CX", "P"], "release_evidence": "R" },
    { "id": 16, "owner": "AND-71", "local_evidence": ["changeset-preflight", "changeset-commit", "okf-conformance"], "live_evidence": ["CX", "P"], "release_evidence": "R" },
    { "id": 17, "owner": "AND-61", "local_evidence": ["mind-browse", "mcp-resources"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 18, "owner": "AND-62", "local_evidence": ["mind-history"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 19, "owner": "AND-52", "local_evidence": ["ordinary-mind-deletion"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 20, "owner": "AND-47", "local_evidence": ["account-deletion"], "live_evidence": ["W", "P"], "release_evidence": "R" },
    { "id": 21, "owner": "AND-41", "local_evidence": ["okf-unit", "okf-conformance", "changeset-preflight"], "live_evidence": ["CX"], "release_evidence": "R" },
    { "id": 22, "owner": "AND-41", "local_evidence": ["okf-unit", "okf-conformance", "export-contract"], "live_evidence": ["CX"], "release_evidence": "R" },
    { "id": 23, "owner": "AND-72", "local_evidence": ["export-download-grants", "export-contract"], "live_evidence": ["CX", "P"], "release_evidence": "R" },
    { "id": 24, "owner": "AND-63", "local_evidence": ["mind-search", "mind-browse", "audit-index-jobs"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 25, "owner": "AND-76", "local_evidence": ["security-privacy-threat", "exposure-contract"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 26, "owner": "AND-76", "local_evidence": ["exposure-contract", "mcp-tools", "mcp-resources"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 27, "owner": "AND-77", "local_evidence": ["mcp-transport"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 28, "owner": "AND-85", "local_evidence": ["canonical-tests", "fixture-validator", "architecture-check", "docs-check", "secrets-check", "readiness-report"], "live_evidence": [], "release_evidence": "R" },
    { "id": 29, "owner": "AND-90", "local_evidence": [], "live_evidence": ["W", "P", "MI", "CX"], "release_evidence": "R" }
  ],
  "local_evidence": {
    "account-bootstrap": { "title": "Atomic account and Personal Mind bootstrap", "command": ["node", "--test", "tests/integration/account-bootstrap.test.mjs"], "paths": ["tests/integration/account-bootstrap.test.mjs"] },
    "sites-identity-binding": { "title": "Fail-closed Sites identity binding", "command": ["node", "--test", "tests/unit/sites-identity-binding.test.mjs"], "paths": ["tests/unit/sites-identity-binding.test.mjs"] },
    "personal-mind-control": { "title": "Personal Mind invariants and profile rename", "command": ["node", "--test", "tests/integration/personal-mind-control.test.mjs"], "paths": ["tests/integration/personal-mind-control.test.mjs"] },
    "ordinary-mind-control": { "title": "Ordinary Mind create and rename", "command": ["node", "--test", "tests/integration/ordinary-mind-control.test.mjs"], "paths": ["tests/integration/ordinary-mind-control.test.mjs"] },
    "handle-registry": { "title": "Handle reservation, race and retirement", "command": ["node", "--test", "tests/integration/handle-registry.test.mjs"], "paths": ["tests/integration/handle-registry.test.mjs"] },
    "ownership-transfer": { "title": "Atomic ownership transfer", "command": ["node", "--test", "tests/integration/ownership-transfer.test.mjs"], "paths": ["tests/integration/ownership-transfer.test.mjs"] },
    "membership-control": { "title": "Role, revoke and leave capability matrix", "command": ["node", "--test", "tests/integration/membership-control.test.mjs"], "paths": ["tests/integration/membership-control.test.mjs"] },
    "invitation-control": { "title": "Invitation creation and authorization", "command": ["node", "--test", "tests/integration/invitation-control.test.mjs"], "paths": ["tests/integration/invitation-control.test.mjs"] },
    "invitation-lifecycle": { "title": "Invitation retry, expiry and races", "command": ["node", "--test", "tests/integration/invitation-lifecycle.test.mjs"], "paths": ["tests/integration/invitation-lifecycle.test.mjs"] },
    "mind-routes": { "title": "Authenticated routes and visibility grants", "command": ["node", "--test", "tests/integration/mind-routes.test.mjs"], "paths": ["tests/integration/mind-routes.test.mjs"] },
    "security-privacy-threat": { "title": "Security and privacy threat regression", "command": ["node", "--test", "tests/integration/security-privacy-threat.test.mjs"], "paths": ["tests/integration/security-privacy-threat.test.mjs"] },
    "public-minds-catalog": { "title": "Public catalog and visibility races", "command": ["node", "--test", "tests/integration/public-minds-catalog.test.mjs"], "paths": ["tests/integration/public-minds-catalog.test.mjs"] },
    "visibility-catalog-ui": { "title": "Visibility disclosure UI contract", "command": ["node", "--test", "tests/unit/visibility-catalog-ui.test.mjs"], "paths": ["tests/unit/visibility-catalog-ui.test.mjs"] },
    "mind-discovery": { "title": "Single-Mind discovery and exact resolve", "command": ["node", "--test", "tests/integration/mind-discovery.test.mjs"], "paths": ["tests/integration/mind-discovery.test.mjs"] },
    "mcp-auth": { "title": "Per-request MCP token lifecycle and scope", "command": ["node", "--test", "tests/unit/mcp-auth.test.mjs"], "paths": ["tests/unit/mcp-auth.test.mjs"] },
    "token-security": { "title": "Token verifier and non-disclosure", "command": ["node", "--test", "tests/unit/token-security.test.mjs"], "paths": ["tests/unit/token-security.test.mjs"] },
    "changeset-preflight": { "title": "Changeset authorization, limits and full-bundle validation", "command": ["node", "--test", "tests/unit/changeset-preflight.test.mjs"], "paths": ["tests/unit/changeset-preflight.test.mjs"] },
    "mcp-commit-export": { "title": "Immediate MCP commit and asynchronous export contract", "command": ["node", "--test", "tests/conformance/mcp-commit-export-tools.test.mjs"], "paths": ["tests/conformance/mcp-commit-export-tools.test.mjs"] },
    "changeset-commit": { "title": "Atomic commit and HEAD CAS", "command": ["node", "--test", "tests/integration/changeset-commit.test.mjs"], "paths": ["tests/integration/changeset-commit.test.mjs"] },
    "concurrency-failure": { "title": "Seeded concurrency and failure injection", "command": ["node", "--test", "tests/integration/concurrency-failure-injection.test.mjs"], "paths": ["tests/integration/concurrency-failure-injection.test.mjs"] },
    "changeset-idempotency": { "title": "Changeset replay, isolation and conflict", "command": ["node", "--test", "tests/integration/changeset-idempotency.test.mjs"], "paths": ["tests/integration/changeset-idempotency.test.mjs"] },
    "okf-conformance": { "title": "Strict full-bundle OKF conformance fixtures", "command": ["node", "--test", "tests/conformance/okf-codec.test.mjs"], "paths": ["tests/conformance/okf-codec.test.mjs", "tests/fixtures/okf/basic/index.md", "tests/fixtures/okf/round-trip/index.md"] },
    "mind-browse": { "title": "Exact-revision browse, fetch and locator isolation", "command": ["node", "--test", "tests/integration/mind-browse.test.mjs"], "paths": ["tests/integration/mind-browse.test.mjs"] },
    "mcp-resources": { "title": "Immutable MCP Resources authorization", "command": ["node", "--test", "tests/conformance/mcp-resources.test.mjs"], "paths": ["tests/conformance/mcp-resources.test.mjs"] },
    "mind-history": { "title": "Snapshot selectors and current-access history", "command": ["node", "--test", "tests/integration/mind-history.test.mjs"], "paths": ["tests/integration/mind-history.test.mjs"] },
    "ordinary-mind-deletion": { "title": "Whole-Mind deletion and retired handle", "command": ["node", "--test", "tests/integration/ordinary-mind-deletion.test.mjs"], "paths": ["tests/integration/ordinary-mind-deletion.test.mjs"] },
    "account-deletion": { "title": "Account cascade, retry and PII-negative scan", "command": ["node", "--test", "tests/integration/account-deletion.test.mjs"], "paths": ["tests/integration/account-deletion.test.mjs"] },
    "okf-unit": { "title": "OKF 0.2 paths, UTF-8 and unknown field round-trip", "command": ["node", "--test", "tests/unit/okf-codec.test.mjs"], "paths": ["tests/unit/okf-codec.test.mjs"] },
    "export-contract": { "title": "Deterministic MD-OKF-ZIP-1 contract", "command": ["node", "--test", "tests/conformance/export-contract.test.mjs"], "paths": ["tests/conformance/export-contract.test.mjs"] },
    "export-download-grants": { "title": "Reauthorized short-lived export downloads", "command": ["node", "--test", "tests/integration/export-download-grants.test.mjs"], "paths": ["tests/integration/export-download-grants.test.mjs"] },
    "mind-search": { "title": "Exact-space and exact-revision search", "command": ["node", "--test", "tests/integration/mind-search.test.mjs"], "paths": ["tests/integration/mind-search.test.mjs"] },
    "audit-index-jobs": { "title": "Index lag, audit, outbox and failure recovery", "command": ["node", "--test", "tests/integration/audit-outbox-index-jobs.test.mjs"], "paths": ["tests/integration/audit-outbox-index-jobs.test.mjs"] },
    "exposure-contract": { "title": "No unsupported browser, MCP or background surface", "command": ["node", "--test", "tests/conformance/exposure-contract.test.mjs"], "paths": ["tests/conformance/exposure-contract.test.mjs"] },
    "mcp-tools": { "title": "Custom Mind-aware JSON Schemas and tool catalog", "command": ["node", "--test", "tests/conformance/mcp-tools.test.mjs"], "paths": ["tests/conformance/mcp-tools.test.mjs"] },
    "mcp-transport": { "title": "Stateless MCP 2026-07-28 transport profile", "command": ["node", "--test", "tests/conformance/mcp-transport.test.mjs"], "paths": ["tests/conformance/mcp-transport.test.mjs"] },
    "canonical-tests": { "title": "All unit, integration and conformance schemas", "command": ["node", "--test", "tests/unit/*.test.mjs", "tests/integration/*.test.mjs", "tests/conformance/*.test.mjs"], "paths": ["package.json"] },
    "fixture-validator": { "title": "Strict checked-in OKF bundle validator", "command": ["npm", "run", "validate:fixtures"], "paths": ["scripts/validate-okf-fixtures.mjs", "tests/fixtures/okf/basic/index.md", "tests/fixtures/okf/round-trip/index.md"] },
    "architecture-check": { "title": "Architecture import-boundary check", "command": ["npm", "run", "check:architecture"], "paths": ["scripts/check-architecture.mjs"] },
    "docs-check": { "title": "Documentation topology and link check", "command": ["npm", "run", "check:docs"], "paths": ["scripts/check-docs.mjs"] },
    "secrets-check": { "title": "Secrets and unsafe configuration check", "command": ["npm", "run", "check:secrets"], "paths": ["scripts/check-secrets.mjs"] },
    "readiness-report": { "title": "Exact-SHA acceptance report contract", "command": ["node", "--test", "tests/conformance/readiness-report.test.mjs"], "paths": ["scripts/generate-readiness-report.mjs", "tests/conformance/readiness-report.test.mjs", "docs/specs/traceability.md"] }
  },
  "live_evidence": {
    "W": { "owner": "AND-89", "artifact_path": "docs/evidence/releases/{candidate_sha}/W.json" },
    "P": { "owner": "AND-89", "artifact_path": "docs/evidence/releases/{candidate_sha}/P.json" },
    "MI": { "owner": "AND-77", "artifact_path": "docs/evidence/releases/{candidate_sha}/MI.json" },
    "CX": { "owner": "AND-77", "artifact_path": "docs/evidence/releases/{candidate_sha}/CX.json" },
    "R": { "owner": "AND-90", "artifact_path": "docs/evidence/releases/{candidate_sha}/R.json" }
  },
  "post_mvp_denylist": [
    { "id": "aws-runtime", "claim": "AWS, AgentCore and a separate production runtime are not the Sites MVP fallback.", "evidence": ["architecture-check"] },
    { "id": "imports", "claim": "ZIP/local import and legacy migration are absent.", "evidence": ["okf-unit", "changeset-preflight"] },
    { "id": "checkpoints", "claim": "Branches, merge, moving tags and named checkpoints are absent.", "evidence": ["mind-history"] },
    { "id": "non-markdown-assets", "claim": "Non-Markdown Asset transport is absent.", "evidence": ["okf-unit", "changeset-preflight"] },
    { "id": "personalization", "claim": "Personalized landing and website AI are not exposed.", "evidence": ["exposure-contract"] },
    { "id": "oauth-company-knowledge", "claim": "OAuth/public-plugin and company-knowledge profiles are not claimed.", "evidence": ["mcp-transport", "mcp-tools"] },
    { "id": "claude-support", "claim": "Claude Code is not a supported client without its own conformance evidence.", "evidence": ["mcp-transport"] },
    { "id": "anonymous-access", "claim": "Anonymous access and publication remain absent.", "evidence": ["mind-routes"] },
    { "id": "draft-approval", "claim": "Server drafts and approval artifacts are absent from immediate commits.", "evidence": ["changeset-preflight", "mcp-commit-export"] }
  ]
}
```
<!-- readiness-registry:end -->

## Обязательные live flows

Ни один отдельный flow не является release сам по себе. Все flows выполняются
на одном exact production candidate и затем связываются через `R`.

### Web/control

1. Authenticated entry показывает registration state; explicit isolated-account
   action создаёт account и единственный `/me`, retry возвращает тот же state.
2. Profile rename сохраняет `/me`; ordinary Mind create/rename показывает
   editable handle, private default и generic unavailable behavior.
3. Owner переключает visibility с обязательным disclosure; authenticated
   catalog и exact unlisted opening соответствуют server grants.
4. Registered-principal invitation проходит accept/reject/expiry path; role
   mutation, revoke/leave и ownership transfer показывают только разрешённые
   actions и итоговый state.
5. Named MCP token показывается один раз, list не раскрывает secret, revoke
   действует немедленно; UI даёт `bearer_token_env_var` setup без plaintext в
   repository/config.
6. Whole-Mind и account deletion используют свежий impact, strong confirmation
   и проверяемый irreversible post-state без обещания recovery/receipt.

### Persistence

`AND-89` подтверждает после нового deployment/redeploy тот же разрешённый
account binding, Personal/ordinary Minds, handles, memberships, visibility,
token metadata/status, HEAD и history, idempotency results, audit/outbox/index
state и durable export job. Probe проверяет также, что deleted aggregate не
воскресает, а retired handle не переиспользуется. Platform storage/bindings и
atomicity должны быть названы в evidence; process memory не засчитывается.

### MCP Inspector

На declared profile `2026-07-28` проверяются `POST /mcp`, matching headers и
body `_meta`, JSON и request-scoped SSE, transport auth и application errors,
deterministic `tools/list`, JSON Schemas/annotations, all read/commit/export
tools, immutable Resources, read-only/denied cases, exact revision binding и
отсутствие session/legacy lifecycle assumptions.

### Codex

Один реальный Codex build подключается к deployed URL через
`bearer_token_env_var`: list/resolve multiple allowed Minds; browse, search,
fetch и validate exact revision; immediate controlled commit; stale conflict с
неизменным state; historical read after HEAD move; deterministic async export;
revocation/current-access denial. Каждый content call остаётся single-Mind,
tools fallback работает независимо от Resources UX.

## Post-MVP denylist

Следующие capabilities не могут появиться в code, schemas, navigation, release
notes или live evidence 0.1 как частично поддержанные:

| Capability | Граница 0.1 |
|---|---|
| AWS / AgentCore / отдельный production container | Planned post-MVP infrastructure, не fallback при провале Sites. |
| Productized imports, ZIP/local bundle import, legacy 0.1 migration | Отложены до отдельного format, conflict, quota и security contract. |
| Named checkpoints/moving tags/branches/merge | История 0.1 использует только immutable revision IDs и `as_of`. |
| `Asset`/`BundleFile`/`OpaqueAsset`, non-Markdown upload/fetch | Модель, manifest, safety и transport не приняты; 0.1 создаёт только Markdown. |
| Personalized landing/`PersonalContext`/website AI | Отдельный будущий trusted use case; `/me` и handle routes в 0.1 — management. |
| OAuth 2.1 + PKCE, public plugin, company-knowledge profile | Не часть personal-token custom MCP; нельзя заявлять compatibility. |
| Claude Code support | Не release gate и не supported client без отдельного adapter/client conformance test. |
| Anonymous publication/access | Все visibility modes 0.1 требуют registered authenticated principal. |
| Server drafts/diff/approval artifacts | Content MCP immediate commit-ит под scope, ACL, CAS и idempotency. |

Schema/route/tool, который делает любой пункт достижимым, — regression scope,
а не «подготовка на будущее».

## Implementation decisions до кода

Это implementation choices, а не новые product capabilities. Owner обязан
сохранить benchmark/spike evidence и обновить specification; значимое принятое
решение требует ADR только после выбора.

| Decision | Linear owner | Required evidence |
|---|---|---|
| Trusted Sites identity/session/CSRF, доступные D1/R2 bindings и их transaction semantics в одном Site | `AND-37` (Spike) | Redacted live probe exact Site version/deployment; failure блокирует Sites-specific implementation. |
| Stateless MCP `2026-07-28` headers, SSE/proxy behavior и Codex bearer forwarding на Sites | `AND-37` (Spike) | Live JSON/SSE/error probes и pinned Codex build; без automatic fallback. |
| Runtime/toolchain, package/module layout и canonical build/test/check commands | `AND-38` | Clean-checkout reproducibility и CI/dependency evidence. |
| Opaque entry/continuation ID encoding, signing/lookup и retention | `AND-61` | Threat analysis plus cross-space/revision, tamper, expiry/deletion contract fixtures. |
| Token format, lookup strategy, hash/KDF, max expiry и verification latency | `AND-57` (Spike) | Reproducible threat analysis/benchmark; secret-storage and constant-time tests; ADR при значимом выборе. |
| MCP request/header/response limits and rate policies | `AND-73` | Transport abuse fixtures and representative payload/stream measurements; constants fixed before conformance. |
| File/operation/total-changeset limits | `AND-65` | Boundary fixtures prove invalid/oversized commands leave no visible objects/revision. |
| Lexical ranking, threshold и pagination behavior | `AND-63` | Seeded benchmark with relevance, exact-revision isolation and no-HEAD-fallback cases. |
| Deterministic export container, filename and `Content-Disposition` | `AND-68` | Byte-for-byte fixtures across repeated builds, full-bundle validation and archive safety review. |
| Export size/rate/expiry and durable job cleanup policies | `AND-70` | Restart/retry/load fixtures with observable failed/expired/cleanup state; no archive in JSON-RPC. |
| Availability/quality of optional MCP Resources UX in target Codex | `AND-77` | Pinned real-client result; required tools fallback remains release-blocking path. |
| Manual identity recovery handoff | `AND-44` | Fail-closed threat review and tests proving no automatic relink/merge/access transfer. |
| Immediate replicated/index deletion and proof of whole-Mind erasure | `AND-52` | Failure-injection, retry and post-delete object/index/job scan; no forensic receipt. |
| Account-wide cascade ordering and proof of PII removal with foreign commit tombstones | `AND-47` | Cross-aggregate failure-injection, reconciliation and negative PII scan. |

OAuth/company-knowledge, personalization, assets, imports, checkpoints, AWS и
Claude support не являются open implementation decisions 0.1: это denylist,
которому понадобится новый explicit product/specification scope.

## Правило обновления

Изменение scope в `mvp.md`, wire contract в `api.md` или owning Linear story в
том же change обновляет соответствующие строки этой матрицы. Owner story
заменяет тип evidence на concrete test IDs/commands и durable artifact paths;
`AND-85` генерирует полный report на candidate SHA; `AND-90` фиксирует `R` и
проверяет, что все 29 строк ссылаются на тот же exact deployment. Закрытая
Linear story без этого evidence не делает criterion выполненным.
