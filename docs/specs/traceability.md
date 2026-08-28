# Traceability matrix MVP 0.1

Статус: executable baseline, обновлено 2026-08-24. Документ связывает
принятые критерии готовности с реализацией и обязательным evidence. Product Site
развёрнут как single-principal UAT в OpenAI Sites; базовые web/persistence и оба
Codex MCP profiles прошли live, но это не закрывает автоматически каждый
расширенный criterion матрицы.

UAT implementation переносит MCP с platform-reserved `/mcp` на
`/api/mcp`, добавляет isolated `/api/mcp/2025-11-25` для default
`codex-cli 0.147.0` и сохраняет одну per-request authorization boundary.
Pinned `codex-cli 0.147.0` прошёл live `list_minds` на обоих profiles (modern
через opt-in `mcp_2026_07_28`). Это создаёт базовое `CX`/`R` evidence, но не
заменяет полную Inspector matrix и расширенные write/conflict/history/export
сценарии ниже.

Исторический отказ, UAT resolution и границы доказанного зафиксированы в
[датированном report](../reports/2026-08-07-sites-mcp-capability-gate.md). Этот
report не меняет owning stories или полные `A<n>`, `W`, `P`, `MI`, `CX` и `R`
artifacts.

## Pilot-ready extension 2026-08-10

Историческая матрица критериев 1–29 и release 2026-08-09 сохраняются без
переписывания. Повторно открытый milestone добавляет dependency-aware
pilot-readiness слой; завершённый local owner не доказывает live UAT соседних
flows или финальный join-gate.

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| P0-SignedOut | Public Sites audience показывает signed-out `GET`/`HEAD` распознанного UI route как одинаковый safe HTML sign-in shell с exact `/signin-with-chatgpt`, без CSRF/product data или handle enumeration; REST/MCP остаются denied, identity outage остаётся `503`. | `MD-242` (contract `MD-241`) | Product HTTP integration + onboarding/unit + browser wide/mobile regression; exact status/content-type/header/body assertions для UI, REST и identity outage | `MD-243`: exact-candidate signed-out shell, signed-in return, anonymous REST/MCP denial и physical Telegram in-app browser canary |
| P1 | Все route из accepted Product Site map открывают правильный authenticated shell; header/footer, mobile/keyboard navigation, active state, UAT label и direct deep links согласованы; reserved/unknown routes fail closed и не падают в home. | `AND-150` | `product-site-navigation`: unit + product integration + browser route/navigation suite | `AND-161`: same-deployment authenticated Web smoke |
| P2 | Ordinary Mind проходит create/list/exact route/rename/delete и сохраняется после restart/redeploy; occupied, reserved и retired handle используют один `handle_unavailable` conflict. | `AND-151` | composed Product Site runtime create → restart → rename → restart → MCP discovery → deletion preview/delete → restart/retired-handle regression; ordinary Mind application/deletion and browser suites | `AND-161`: exact-candidate Web + persistence |
| P3 | `/invitations` и canonical ordinary-Mind route показывают только safe access metadata; exact registered-email invitation не даёт access до accept, retry создаёт одну membership, role CAS/revoke/leave немедленно меняют current Web/MCP/history access и сохраняются после runtime reconstruction. | `AND-157` | durable composed Product Site с двумя principals: unknown exact email, create/accept replay, pending denial, role stale conflict, restart, revoke и immediate Web/MCP denial; invitation lifecycle, membership capability matrix, product HTTP mapping и browser stale/escaping suite | Blocking P9-Synthetic; real second-principal Sites flow — informational P9-Sites-Canary |
| P4 | Visibility, catalog и ownership transfer применяют current access без metadata leakage; `public` discoverable только authenticated catalog, `unlisted` открывается только по exact handle, возврат в `private` немедленно снимает baseline Web/MCP/history grant. | `AND-154` | durable composed Product Site с тремя principals: public → unlisted → public, MCP baseline read, invitation acceptance, atomic transfer, private revoke и runtime reconstruction; visibility/catalog/ownership/history integration и browser suite | Blocking P9-Synthetic; real Sites identity/audience observation — informational P9-Sites-Canary |
| P5 | Account/profile/delete и manual recovery handoff fail closed без PII leakage или automatic relink. | `AND-153` | `account-deletion` foreign-tombstone/PII suite; `personal-mind-control`; `sites-identity-binding`; Product Site handler + durable runtime rename/fresh-impact/delete/reconstruction scenarios; account lifecycle UI/controller and browser fixture | Required single-owner UAT Web row + blocking P9-Synthetic identity isolation; real second account informational |
| P6 | `/settings/developer/mcp` (compatibility entrypoint `/settings/mcp`) выдаёт два exact-origin secret-free Codex config; one-time redacted self-check проверяет current account, modern discovery/read-only `list_minds` и isolated compatibility lifecycle/read-only `list_minds`, различает Sites audience и product Bearer boundaries и после закрытия не сохраняет secret или raw/private response. | `AND-152` | `mcp-token-management-ui`, Product Site handler/runtime setup/diagnostic regression, negative status/redaction fixtures + real `codex-cli 0.147.0` smoke обоих profiles | `AND-161`: exact-candidate Web + default/modern Codex |
| P7 | `/me`, `/help/codex` и `/settings/developer/mcp` дают copy-ready flow для Personal либо ordinary Mind: один strict three-file UTF-8 Markdown starter проходит fresh-HEAD commit, full-bundle `validate_mind`, index fetch, lexical search и exact fetch; concierge conversion остаётся bounded existing-tool workflow без import API. Setup completion и первый useful search измеряются closed-schema duration events без query/content/principal. | `AND-155` | strict checked-in starter fixture + source equality test; empty-account composed Product Site commit/validate/index/search/fetch E2E; onboarding/help/MCP copy contract; telemetry first-only/redaction assertions | `AND-161`: exact-candidate Codex starter flow и safe duration event |
| P8 | `/settings/developer/mcp` даёт copy-ready safe-write и restore/export playbooks: bounded preview + explicit confirmation до immediate commit, exact historical read-only selector, restore как новая HEAD revision, fresh-CAS retry и deterministic exact-revision export с integrity/access checks. Tool descriptions повторяют те же guardrails без нового restore schema или server draft. | `AND-156` | `mcp-token-management-ui`, `mcp-commit-export`, history/export/download integration и composed recovery flow | `AND-161`: exact-candidate Codex write → history → restore → export |
| CX0-Contract | Ordinary Connections, Advanced MCP и Codex Help имеют один принятый route/state/query contract: actor-owned `connection_ref`/`personal_token_ref`, bounded separate cursors, identical 404 и no silent write widening. | `MD-294` | ADR-0020 + `connection-experience.md` + docs/link/diff validation | Contract acceptance разблокирует implementation, но не является browser/UAT evidence |
| CX1-Implementation | `/settings/connections` и detail не показывают raw IDs/protocol archive, загружают bindings только visible OAuth page, скрывают write selector до step-up; Advanced MCP отдельно показывает bounded personal-token history, а onboarding содержит три шага. | `MD-295`–`MD-299` | route/projection/state/actor/cursor tests + product integration | `MD-300` real browser gate; exact deployment join в `MD-293` |
| P9-Synthetic | Blocking multi-principal boundary доказывает normal bootstrap/current access минимум двумя ordinary principals через test-only trusted identity composition без human credentials, storage seed, product login surface или ACL bypass. | `MD-237` | `npm run gate:synthetic-multi-principal -- --candidate-sha <exact-HEAD-sha> --evidence-out <private-temp-path>/evidence.json`; `tests/integration/synthetic-multi-principal-probe.test.mjs`, `tests/conformance/synthetic-principal-packaging.test.mjs`, `npm run check:product-site`; distinct account/Personal Mind/token, private isolation, public/unlisted baseline, invite Reader → Editor, ownership transfer, reconstructed-runtime persistence, immediate Web/MCP/history revoke, normal cleanup и production-negative import/config check; `mind-diary/synthetic-multi-principal-evidence/v1` | Synthetic artifact exact candidate SHA; capability unavailable/failed блокирует release |
| P9-Browser | Blocking server-bound browser composition повторяет normal Product Site bootstrap, real UI/API route matrix, direct negative API checks, operator UI/API boundary, restart persistence, revoke и cleanup минимум для двух ordinary principals. | `MD-276` / `MD-277` / `MD-278` / `MD-279` | `npm run gate:synthetic-browser -- --candidate-sha <exact-HEAD-sha> --evidence-out <private-temp-path>/evidence.json`; `tests/integration/synthetic-browser-gate.test.mjs`, `tests/conformance/synthetic-browser-gate.test.mjs`; `synthetic-browser-gate-runbook.md`; `mind-diary/synthetic-browser-evidence/v1` | Local exact-SHA receipt is blocking; no hosted browser claim, Sites canary remains informational |
| P9-Sites-Canary | Два real platform-authenticated Sites principals повторяют collaboration/redeploy/revoke flow без shared credentials. | `MD-158` | existing `scripts/run-uat-multi-principal-probe.mjs` и conformance redaction suite | informational `mind-diary/multi-principal-evidence/v1`; отсутствие/failure не блокирует 0.1 и не подменяет P9-Synthetic |
| O1-Automated | Blocking direct-plugin gate доказывает `AVAILABLE + ON_USE`, отсутствие private app, fresh temporary skill/tool discovery, OAuth DCR/PKCE/read/write-step-up/expiry/refresh/reuse/revoke/reconnect, modern/compatibility MCP и personal-token regression. | `MD-238` | `npm run gate:oauth-direct-plugin -- --candidate-sha <exact-HEAD-sha> --evidence-out <private-temp-path>/evidence.json`; actual `codex-cli 0.149.1` marketplace add/list/install, non-model `debug prompt-input` model-visible skill assertion и MCP resolution, strict fake D1 OAuth state machine, composed Product Site runtime и conformance receipt/redaction tests; synthetic identity только в trusted authorize/consent seam | Automated exact MindDiary/Marketplace HEAD/tree/package receipt; unavailable/failed capability блокирует release и не подменяет O1-FirstUser |
| O1-FirstUser | Fresh real Marketplace/Codex account проходит install-before-OAuth, read-first use, write step-up, singleton writable Mind, write/history/export и revoke на exact UAT candidate. | `MD-293` | real-account first-user runner + browser/client receipt без raw identity/credentials/content | blocking exact-candidate/deployment receipt; synthetic automation остаётся отдельным prerequisite, но не заменяет этот flow |
| P10a | Privacy-safe UAT operations показывают participant data/SLA/export/delete/credential boundaries до старта, подключают deployable closed-schema telemetry без corpus/query/email/credential/URL, дают bounded auth/MCP/storage diagnostics, exact rollback и emergency token/audience revoke path; deterministic export/restore drill выполняется на non-sensitive fixture corpus. | `AND-159` | Sites telemetry sink rejection/redaction tests, composed runtime metrics, fixture restore/export drill, participant UI contract и `operations/uat-pilot-operations.md` | `AND-161`: exact-candidate safe-log sample, rollback target и redacted operational smoke |
| P10b | Pilot protocol определяет assisted → external cohorts, один owner/channel, consent-aware сценарии и cadence, privacy-safe activation/return/friction/intent definitions, separated feedback template, sampling bias, safety stop, go/no-go/inconclusive review и linked offboarding без product analytics expansion. | `AND-160` | [`operations/uat-pilot-protocol.md`](../operations/uat-pilot-protocol.md) + docs topology/link validation + closed telemetry contract из `AND-159` | `AND-161` join-gate; actual four-week cohort results не являются release evidence 0.1 |
| P11 | Один exact candidate проходит canonical gate, blocking P9-Synthetic/O1 automation, three-principal operator boundary и required real-account first-user Web/MCP UAT rows одного deployment. | `MD-293` | canonical repository gate exact SHA + synthetic/OAuth automation + operator/privacy receipts | `W`, `P`, `MI`, `CX`, `R` связываются с exact deployment; O1-FirstUser входит в terminal condition 0.1 |

Accepted route map и security boundary находятся в
[MVP specification](mvp.md#sites-control-plane). Для P1 page shell не считается
evidence P2-P6: соответствующий owner обязан подключить real use case, оставить
targeted tests и затем войти в P11 live matrix.

MD-237 добавляет executable P9-Synthetic capability, а MD-238 — отдельную O1
capability и exact-SHA receipt. Обе rows продолжают fail closed при unavailable,
failed или неполном evidence. Historical registry критериев 1–29 и live slots `W/P/MI/CX/R`
ниже сохраняются byte-for-contract: новые receipts не удаляют 29 критериев и
не переписывают historical evidence.

## Revision-index recovery extension 2026-08-24

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| IR1-Recovery | Product Worker после реального isolate restart bounded-восстанавливает exact current-HEAD index: атомарно чинит missing/partial job-state, requeues `ready` без physical projection, применяет exponential backoff и terminal attempt/age limits; concurrent/stale claims fenced, а сигналы privacy-safe. Публичного arbitrary repair endpoint нет. | `MD-252` | `audit-outbox-index-jobs`: backoff/attempt/age/stale-handler; `sites-persistence`: partial metadata + missing ready projection + concurrent repair/restart + durable mixed-candidate `>limit` presence-only scan; `product-site-mcp-runtime`: exported Worker `fetch` restart; `privacy-safe-observability`: terminal closed outcome | На свежем synthetic ordinary Mind сохранить exact revision, дождаться `ready`, получить один expected search hit и один no-hit на той же revision, затем обычный cleanup. Privileged corruption или internal repair trigger в UAT не требуется и не разрешён. |

## Service-operator directory extension 2026-08-24

[Accepted service-operator contract](service-operator-directory.md) отделяет
read-only UAT support capability от Mind roles и provider session history.
Локальный browser gate уже доказывает application boundary, но terminal hosted
claim требует три реальные Sites session, exact operator allowlist, provider
privacy classification и cleanup read-back. `MD-281` добавляет исполняемый
hosted canary: external accounts/access-policy остаются MD-282 authority, а
normal Product Site bootstrap и все canary-owned reversible resources
исполняются runner-ом.

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| OD0-Contract | Constructor-only allowlist открывает bounded read-only catalog только operator; Mind Owner/Admin и ordinary principal получают exact `404`, successful activity монотонна и privacy-minimized. | `MD-244` | `service-operator-directory` integration, Product Site runtime/browser regressions, `P9-Browser` operator assertions | `OD4-Join` exact candidate/deployment |
| OD1-Canary | Three-actor runner принимает только Sites sessions через environment, выполняет normal product bootstrap, создаёт temporary private Mind actor-ом `mind-role` как Owner, выпускает/revoke-ит phase-local one-hour `content:read` tokens, проверяет полный directory matrix и удаляет все canary-owned resources до receipt. | `MD-281` | `node --test tests/conformance/uat-operator-directory-canary.test.mjs`; [`uat-operator-directory-canary.md`](../operations/uat-operator-directory-canary.md); registration-required, read-only scope, token denial, Mind deletion и interrupted recovery fixtures | `npm run uat:operator-directory-canary` phases `setup`, `verify`, `cleanup`, `recovery` на одном exact deployment; canary schema `mind-diary/uat-operator-directory-canary-evidence/v1`, cleanup schema `mind-diary/uat-operator-directory-cleanup-evidence/v1` |
| OD2-Actors | Restricted UAT имеет три independently authenticated real external accounts, distinct durable product principals, exact custom audience, один operator allowlist principal и stable ordinary-Mind baseline `none`; canary Owner role создаётся только вместе с temporary Mind. | `MD-282` | redacted inventory/runbook contract и joinable readiness schema `mind-diary/uat-test-account-pool-readiness/v2`; automation не доказывает external account creation, MFA или audience state | explicit access-policy/account setup и exact candidate/deployment read-back; отсутствие authority или actor блокирует row |
| OD3-ProviderPrivacy | Application telemetry и provider request envelope классифицированы отдельно; raw provider fields/config/retention/access/deletion проверены без копирования PII в repository/evidence. | `MD-283` | privacy negative tests и classification-only receipt contract | exact provider configuration/read-back либо явный bounded UAT privacy decision; unknown boundary блокирует row |
| OD4-Join | Один exact candidate связывает operator canary, actor-pool/audience, provider privacy и hosted cleanup одного run; allowlist/audience подтверждаются unchanged, потому что runner их не мутирует. | `MD-280` | `node --test tests/conformance/uat-operator-directory-join.test.mjs`; fail-closed hash/lineage/status/run-fingerprint contract | `node scripts/run-uat-operator-directory-join.mjs ...`; schema `mind-diary/uat-operator-directory-join-evidence/v1`, exact candidate/deployment, provider `accepted_boundary`, production excluded |

## Mind bindings extension 2026-08-22

[ADR-0013](../decisions/0013-multiple-read-single-write-mind-bindings.md) и
[binding specification](mind-bindings.md) изменяют future content-access
contract, не переписывая historical release evidence. Contract (`MD-229`) и
локальный durable state slice (`MD-231`), MCP binding tools (`MD-230`) и hard
content enforcement (`MD-232`), а также Product Site/interaction guidance
(`MD-233`) подтверждены локально. Capture (`MD-234`) теперь также имеет local
candidate. `MD-235` добавляет blocking exact-candidate join в canonical profile;
hosted `uat.mind-bindings` всё ещё требует evidence конкретного deployment.

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| B0-Contract | OAuth grant/personal token — authoritative binding owner; `0..N` read, `0..1` write, exact lifecycle/CAS/errors и fail-closed migration согласованы. | `MD-229` | docs topology/link validation + `git diff --check`; это contract evidence, не runtime | not-applicable до implementation |
| B1-State | Durable binding state переживает restart, atomic rebind invalidates previous ID, revoke/delete fail closed. | `MD-231` | `mind-binding-state` application/CAS/idempotency/Sites-reconstruction/audit suite; `ordinary-mind-deletion`, `account-deletion` и `gate:synthetic-multi-principal` assertions `restart-persistence`, `mind-delete-invalidates-target`, `owner-revoke-invalidates-state` | blocking `uat.mind-bindings` exact deployment |
| B2-Tools | Оба MCP profiles публикуют deterministic inspection/read/write binding tools с current authorization. | `MD-230` | `mcp-binding-tools`, `mcp-tools`, `mcp-transport`; fresh-plugin OAuth gate и shared modern/compatibility state | blocking `uat.mind-bindings` exact deployment |
| B3-Enforcement | Bound reads и exact active write ID являются hard server boundary без wrong-Mind side effects. | `MD-232` | `mind-binding-enforcement` и synthetic exact-candidate assertions `current-target-exactly-one-revision`, `rebind-stale-no-side-effect`, `concurrent-rebind-cas`, `detach-unbind-fail-closed` | blocking `uat.mind-bindings` exact deployment |
| B4-UX | Product Site/plugin показывают current reads/exact write target и не infer-ят его из content/model state. | `MD-233` | UI/HTTP/browser suites; fresh Marketplace plugin receipt; OAuth connected-app revoke и clean reconnect-generation assertions | blocking `uat.mind-bindings` exact deployment |
| B5-Capture | Отдельная opt-in capture policy пишет только в active target с provenance/privacy constraints. | `MD-234` | `automatic-capture`, synthetic state matrix и fresh-plugin OAuth product-runtime capture/no-op assertions; Marketplace `181320e`, plugin `0.1.0+codex.20260822115002` | blocking `uat.mind-bindings` target-A capture and rebind fencing |
| B6-Join | Один exact candidate проходит concurrency/security/persistence/plugin/UAT matrix. | `MD-235` | blocking `dev.mind-bindings` joins exact-SHA `dev.synthetic-multi-principal` and `dev.oauth-direct-plugin` receipts with required assertion IDs | blocking `uat.mind-bindings` exact candidate/deployment/plugin/profile receipt |

## Post-MVP BundleFile extension 2026-08-22

[ADR-0015](../decisions/0015-versioned-bundle-files.md) и
[BundleFile specification](bundle-files.md) replace the old non-Markdown deny
with a bounded raster/PDF/ZIP post-MVP slice. Accepted contract does not prove
implementation. По ADR-0019 rows ниже не участвуют в readiness Release 0.1;
они становятся blocking только для отдельного BundleFile promotion.

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| BF0-Contract | Producer-defined manifest v2, v1 compatibility, path/type/limits/quarantine/staging/download/export/errors are exact and do not alter OKF 0.2 or `MD-OKF-ZIP-1`. | `MD-246` | affected docs + ADR-0015, docs topology/link validation and `git diff --check` | not-applicable until implementation |
| BF1-State | In-memory/Sites ports persist arbitrary bytes and staged lifecycle; mixed CAS consumes refs atomically, history/GC/quota/deletion preserve invariants. | `MD-247` | `tests/integration/bundle-files-core.test.mjs`: manifest v1/v2, MIME/signature deny, mixed commit/consume, historical bytes, Markdown-only index, staging/canonical GC, Space isolation and Sites reconstruction; full repository gate | exact-deployment persistence after redeploy |
| BF2-Ingress | Both advertised MCP profiles expose scoped native `stage_bundle_file`; provider transport terminates in adapter and image/PDF/ZIP bytes pass exact static gate. | `MD-248` | `tests/conformance/mcp-bundle-file-staging.test.mjs` and `tests/integration/bundle-files-core.test.mjs`: deterministic schema/annotations, read-only omission/direct denial, allowlisted host/redirect/bounded stream, provider-metadata termination, PNG/PDF/ZIP, MIME/size/foreign/expired/idempotency negatives and atomic mixed commit | pinned client/profile native-file stage evidence; unsupported profile is not pass |
| BF3-ReadExport | Bound reader lists/downloads exact revision, Markdown references validate, one-use grants fail closed and `MD-BUNDLE-ZIP-1` is deterministic while legacy export is unchanged. | `MD-249` | Implemented locally: current/historical pagination, atomic references, token/ACL/expiry/delete failures, one-use concurrency, image/PDF/ZIP headers, Sites restart/CAS and dual export byte fixtures | image/PDF/ZIP download SHA and export on exact deployment |
| BF4-Join | One exact candidate passes repository/security/dev gates and real Codex stage → commit → list → download/history/revoke/redeploy flow. | `MD-250` | clean `npm ci` + one `npm run check`, docs/diff, exact-SHA dev receipt | exact Sites version/deployment/tool inventory/client-plugin tuple and redacted native-file receipt; missing capability keeps nonterminal |

## Release 0.2 format-neutral BundleFile amendment 2026-08-25

[ADR-0021](../decisions/0021-format-neutral-bundle-files.md) supersedes only
the closed media/64 MiB parts of the historical BF rows. The old rows remain
evidence of the implemented bounded baseline, not current product limits.

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| BF7-Contract-v4 | Manifest v4 stores arbitrary regular `kind: opaque`, open header-safe media uses `application/octet-stream` fallback, v1/v2/v3 retain historical meaning, and OKF unknown producer fields survive unchanged. | `MD-303` | ADR-0021; product/domain/API/storage/traceability docs; `bundle-file-format-neutral-contract` + existing full-bundle OKF codec; docs validator and `git diff --check` | not-applicable; contract is not runtime proof |
| BF8-Core-runtime | Manifest v4 storage plus stage, SHA-256, quarantine, atomic commit, promotion, history, download, export and GC are one bounded-streaming object lifecycle through exact 256 MiB; +1 byte fails without reachable state. Arbitrary formats remain download-only except verified safe raster. | `MD-304` | v4 legacy fixtures; >146,215,108-byte synthetic stream; exact 256 MiB/+1 boundary; memory/chunk assertions; DOCX/HEIC/EPUB/OPUS/HTML/notebook/ZIP/unknown fixtures | exact-candidate persistence/redeploy and byte/digest read-back |
| BF9-Hosted-upload-intent | Local companion and workspace-generated sources use one hosted one-use upload-intent service with bounded HTTP/MCP metadata, authorization, expiry/replay/reconcile and path-free composition into MD-304 staging ports. It does not define another BundleFile object store, digest/quota rule or canonical lifecycle. | `MD-305` | intent issue/consume/expiry/replay/auth tests; HTTP/MCP schemas and metadata privacy; local/workspace composition against MD-304 streaming ports | exact deployed local/workspace stage → commit → download read-back; unsupported host remains non-passing |
| BF10-Incremental-OKF | One typed OKF Markdown entry with unknown producer fields and individually selected opaque files commits through ordinary operations without copying project/runtime state or introducing batch/archive import. | `MD-306` | synthetic full-bundle fixture, link normalization, exact second changeset/idempotent retry, installed connector packaging | joined into MD-275 exact UAT candidate |

## Release 0.2 readable-path ingress и post-MVP extensions

[ADR-0018](../decisions/0018-file-ingress-contract-and-source-capability-matrix.md)
и [единый file-ingress contract](file-ingress.md) фиксируют portable
`VerifiedFileInput`/`staged_file_ref`, adapter/application ownership, typed
errors, limits, lifecycle, idempotency и atomic commit. Release 0.2 выбирает
только packaged-companion `local_path` и `workspace/generated_artifact` поверх
MD-305 upload intent. Direct host/provider, connector и server-generated routes
остаются Release 0.3 `not_available`. Product Site candidate подключает bounded
generated bytes только как constructor-owned internal port; его public row
также остаётся `not_available` до поздней UAT-проверки, потому что repository
wiring не является support evidence.

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| FI0-Contract | Каждый file source сводится к verified bytes и service-owned staged ref без provider ID/URL, local path, silent fallback или partial multi-ref commit; capability status не выдаётся за implementation. | `MD-271` | `file-ingress-contract`, affected docs + ADR-0018, docs topology/link validation and `git diff --check` | not-applicable until source adapter/client implementation |
| FI1-LocalCompanion | Explicit regular local/workspace/generated file or bounded bytes passes the same path-free verified-input and atomic staging pipeline with safe path/symlink/special-file/size/MIME/SHA/idempotency/retry/cleanup checks; failures leave no revision. | `MD-272` | `tests/unit/local-file-companion.test.mjs` and `tests/integration/local-file-companion.test.mjs`; build, targeted contract/integration checks, architecture/docs/secrets checks and `git diff --check` | not-available: hosted upload intent/native client evidence is separate and remains pending |
| FI1-Generated | `bounded_in_memory` and `server_generated` use the shared MIME/SHA/size/quota/quarantine/idempotency gate; server-generated chunks are written through the storage writer, cancellation/limit/static failures leave no staged object, and commit remains an explicit atomic next step. | `MD-273` | `tests/unit/generated-artifacts.test.mjs`, `tests/unit/sites-object-store-streaming.test.mjs`, `tests/integration/bundle-files-core.test.mjs`, build and targeted diff check | hosted producer wiring and exact deployed stream evidence remain pending |
| FI1-BoundedComposition | Product Site exposes one constructor-owned trusted `bounded_in_memory` bytes port; 4 MiB succeeds, byte +1 and invalid provenance/filename/target fail before reachable content or HEAD change, shared ACL/quota/idempotency/expiry/reconcile remains authoritative, and only explicit commit publishes. Public HTTP/MCP capability stays unavailable and payload never enters logs, `structuredContent` or model context. | `MD-321` | `tests/unit/bounded-in-memory-ingress.test.mjs`, `tests/integration/product-site-bounded-in-memory-ingress.test.mjs`, `tests/conformance/md321-bounded-in-memory-contract.test.mjs`; build, Product Site, architecture/docs and diff checks | exact candidate/deployment late-UAT receipt remains pending under `MD-290`; no repository-only hosted claim |
| FI2-ReadablePath | One explicit absolute regular-file path on the current Codex host enters the same verified stage through the packaged companion; disk and trusted workspace provenance remain distinct, path never reaches hosted state, and observable failures do not invent cross-host/provider provenance. | `MD-312` | affected contract/docs, packaged companion schema, local no-follow/snapshot/limit/error tests and docs validation | MD-325 exact installed-client disk/workspace journey |
| FI3-CapabilityLayers | Hosted adapter availability, installed client companion inventory and admission of one concrete path are three separate facts; deferred Release 0.3 routes stay `not_available`. | `MD-313` | hosted capability schema/code and conformance tests; client inventory remains external evidence | MD-325 exact client/profile + companion inventory + hosted adapter/binding join |
| FI4-ReadablePathErrors | Missing/inaccessible, unsupported path/authority, changed snapshot and expired local ref have distinct path-free outcomes plus bounded remediation; pre-admission failures create no staged object or revision. | `MD-323` | packaged companion error mapping/tests and privacy checks | MD-325 negative path/snapshot/ref rows |
| FI5-DiskFirstJoin | Disk and workspace fixtures of representative and unknown formats pass stage, atomic commit, exact download, history/export and redeploy persistence on one candidate; negative rows stay fail closed. | `MD-325` | exact repository/plugin candidates, one full gate and diff checks | exact Git SHA, Sites version/deployment, installed plugin/client inventory, binding, revisions and privacy-safe hashes |
| FI6-ServerGeneratedComposition | Hosted composition exposes one trusted in-process producer-stream port with a 600 s lease and exact 256 MiB incremental size/SHA gate. The port derives credential owner + exact active target generation from current server state; producer-free reconcile returns a prior same-receipt staged ref, while transactional generation/target-version recheck makes clear/switch/revoke races fail without redirect. Expected MIME parameters normalize to one canonical essence; detected mismatch cleans the temporary writer/reservation before object promotion or idempotency completion, while cancellation, timeout, producer failure and +1 byte also fail closed. Success still requires the existing atomic commit and reuses history/download/Web export/cleanup without an MCP export or public capability claim. | `MD-322` | `server-generated-composition`: target-generation/CAS race, unit retry/cost boundary, MIME-equivalent replay and mismatch zero-state cleanup, hosted lifecycle integration and exposure conformance; targeted build/docs/architecture/diff checks | MD-290 privacy-safe installed producer route and exact-candidate late UAT |

## Post-MVP Brain-scale Sites storage/import extension 2026-08-22

[ADR-0016](../decisions/0016-sites-storage-capacity-import.md) and the
[accepted contract](sites-storage-capacity-import.md) define a post-MVP target.
SI1 is implemented in the current repository candidate; this matrix still
distinguishes local evidence from exact-deployment UAT availability, but SI0–SI5
do not participate in Release 0.1 readiness.

| ID | Наблюдаемый результат | Owner | Local evidence | UAT evidence |
|---|---|---|---|---|
| SI0-Contract | D1/R2 roles, Space-scoped objects/v3 manifests, exact historical search, usage ownership/limits/reservations, Markdown import, privacy and rollback are unambiguous. | `MD-264` | affected specs + ADR-0016, docs topology/link validation, `git diff --check` | not-applicable until implementation |
| SI1-Delta | Small edit reuses unchanged digests and writes touched objects + manifest under existing HEAD CAS; v1/v2 compatibility and safe orphan handling remain. | `MD-265` | `tests/integration/delta-revision-storage.test.mjs` plus manifest/CAS/idempotency/deletion/reconstruction regressions | exact-deployment small-delta and restart read-back |
| SI2-Capacity | Reconstructable ledger and durable reservations enforce per-Mind/principal/Site warning/soft/hard limits, fairness and cleanup. | `MD-266` | race/retry/shared-digest/reconcile/admission/telemetry tests | exact usage/headroom/quota/fairness receipt |
| SI3-Streaming | Export and R2 cleanup are streaming, persisted-cursor, bounded and safe against active roots/races. | `MD-268` | deterministic streaming export, concurrent commit/export/GC, restart/expiry tests | bounded memory/latency and cleanup receipt |
| SI4-Import | Markdown-only plan/reserve/stage/checkpoint/validate/commit is resumable and publishes one exact revision or nothing. | `MD-267` | invalid path/UTF-8/OKF/quota/conflict/retry/cancel/restart corpus tests | interrupt/resume/quota reject/final search/fetch on exact deployment |
| SI5-Join | One exact candidate passes all prerequisites and Brain-scale Sites capacity/import matrix. | `MD-260` | full repository/security/dev/performance gates | exact Sites version/deployment, private fixture fingerprints and SI1–SI4 live join |

## Как читать матрицу

Источник критериев — раздел
[«Критерии готовности»](mvp.md#критерии-готовности). `Owning story` — ровно одна
Task Manager task, которая обязана реализовать criterion и оставить executable
evidence. Сквозные stories `AND-85`–`AND-90` проверяют и собирают evidence для
критериев 1–27, но не подменяют их owners; для критериев 28–29 `AND-85` и
`AND-90` сами являются прямыми owners.

Ключи `AND-*` и `MD-*` в сохранённых строках — display/history keys. Перед
delivery они должны быть заново разрешены как canonical Task Manager Task refs;
сама матрица не является selector и не даёт права угадывать scope.

Типы executable evidence:

- `U/P` — deterministic unit/property tests доменных правил;
- `C` — schema/contract fixtures REST, MCP или OKF;
- `I` — integration tests application core и выбранных adapters;
- `B` — browser E2E first-party control plane;
- `S` — security/privacy regression;
- `F` — concurrency/failure-injection;
- `M` — MCP Inspector или real-client conformance;
- `L` — repeatable redacted live probe UAT candidate.

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
| 11 | Один principal token discover-ит несколько allowed Minds; content разрешает только bound target и ровно один Mind/revision без cross-Mind leakage. | `AND-74` | Historical explicit-selector evidence сохраняется; contract amended by `MD-229`–`MD-235`, local binding enforcement подтверждён в B1–B3. | Historical `A11 + MI + CX + R`; новый hosted claim только B6 |
| 12 | Expired/revoked token denied; issuance replay не раскрывает secret; write включает read, read-only не пишет; telemetry не содержит secret/body. | `AND-58` | `U/P, C, I, S, M`: expiry/revoke/scope/replay plus automated log redaction. | `A12 + MI + CX + R` |
| 13 | Reader/baseline Reader не commit-ит; Editor/Admin/Owner immediate commit-ит только при `content:write` и exact active write binding, без draft/approval. | `AND-65` | Historical role/scope evidence сохраняется; contract amended by `MD-229`–`MD-235`, local binding no-side-effect matrix подтверждена в B3. | Historical `A13 + MI + CX + R`; новый hosted claim только B6 |
| 14 | Current `expected_revision` создаёт одну new HEAD; stale revision возвращает conflict без reachable partial objects/revision. | `AND-67` | `U/P, I, F, M`: two-writer race, injected object-put→CAS fault и HEAD/object post-state. | `A14 + CX + P + R` |
| 15 | Same namespaced key/payload возвращает тот же revision и не дублирует log; другой payload даёт idempotency conflict. | `AND-69` | `U/P, I, F, M`: same/different payload replay, cross-principal/space isolation и concurrent retries. | `A15 + CX + P + R` |
| 16 | Concept, `index.md` и `log.md` появляются all-or-nothing; log остаётся valid newest-first/date-grouped OKF. | `AND-71` | `U/P, C, I, F, M`: clock-based log fixtures, invalid/stale operations и full-bundle post-validation. | `A16 + CX + P + R` |
| 17 | `fetch(id)` после HEAD move возвращает exact найденную immutable revision. | `AND-61` | `C, I, S, M`: opaque ID/continuation/resource binding before/after HEAD move and authorization recheck. | `A17 + MI + CX + R` |
| 18 | Historical selector всегда read-only и использует current access; public→private отзывает history у non-member. | `AND-62` | `U/P, C, I, S, M`: exact/as-of boundaries, Owner write denial и access transition. | `A18 + MI + CX + R` |
| 19 | File delete сохраняет старую revision; whole-Mind delete удаляет history/linked records, инвалидирует locators и навсегда retires non-linkable handle без forensic receipt. | `AND-52` | `U/P, I, F, B`: deletion impact, injected retry/race, old-file precondition и post-delete storage/locator scan. | `A19 + W + P + R` |
| 20 | Account delete выполняет весь cascade, отзывает identity/tokens и сохраняет foreign commits только с non-PII `deleted-principal`; UI показывает impact. | `AND-47` | `U/P, I, F, B`: fresh/stale preview, crash/retry, cross-aggregate reconciliation и PII-negative scan. | `A20 + W + P + R` |
| 21 | Changeset Release 0.1 принимает UTF-8 Markdown/OKF 0.2; BundleFile, universal file ingress и import остаются post-MVP без hidden fallback. | `AND-41` | `U/P, C, I`: OKF codec, changeset preflight, UTF-8/path/limit and no-partial-publication fixtures. | `A21 + CX + R` |
| 22 | Unknown OKF fields/types переживают read-modify-write/export; conformance errors отделены от quality warnings. | `AND-41` | `U/P, C, I`: audited OKF 0.2 round-trip corpus, byte/semantic diff и separate validation classes. | `A22 + CX + R` |
| 23 | Reader/baseline Reader exports exact allowed Markdown revision through reauthorized grant; `MD-OKF-ZIP-1` остаётся deterministic, access-checked и независимым от HEAD move. | `AND-72` | `C, I, S`: deterministic export, current-access reauthorization, expiry and download integrity fixtures. | `A23 + CX + P + R` |
| 24 | Search/fetch фильтруются по exact space/revision; missing historical index не подмешивает HEAD. | `AND-63` | `U/P, I, F, S, M`: seeded two-space/two-revision corpus, lag/missing index и result provenance. | `A24 + MI + CX + R` |
| 25 | Corpus не расширяет scopes и не получает control-plane tools; allowed-write prompt injection остаётся явно residual risk. | `AND-76` | `C, I, S, M`: adversarial corpus, direct tool calls, tool catalog and state/telemetry assertions. | `A25 + MI + CX + R` |
| 26 | MCP публикует custom Mind-aware profile без company-knowledge claim или user-openable content URLs. | `AND-76` | `C, S, M`: deterministic tool/resource catalog, absent standard/control surfaces и URI checks. | `A26 + MI + CX + R` |
| 27 | MCP Inspector проходит `/api/mcp` `2026-07-28`; pinned Codex проходит modern opt-in и default isolated `/api/mcp/2025-11-25` lifecycle. Claude support без отдельного test не заявляется. | `AND-77` | `M, L`: pinned client versions, discovery/initialize negotiation, Inspector suite и redacted Codex read/write/conflict/history/export flow с current authorization. | `A27 + MI + CX + R` |
| 28 | Validators, fixtures and docs checks проходят на одном commit; deployment не считается завершённым без live evidence. | `AND-85` | `C, I, S, F`: canonical full check и generated criterion→test/evidence report exact SHA. | `A28 + R` |
| 29 | UAT release связывает exact SHA с одним Sites deployment/live URL и на нём проходит полный authenticated web/control+persistence+MCP flow. | `AND-90` | `L`: same-deployment web/control, persistence, Inspector and Codex probes after publish/redeploy. | `A29 + W + P + MI + CX + R` |

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
    { "id": 11, "owner": "AND-74", "local_evidence": ["mind-discovery", "security-privacy-threat", "mind-binding-state", "mcp-binding-tools", "mind-binding-enforcement"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 12, "owner": "AND-58", "local_evidence": ["mcp-auth", "token-security"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 13, "owner": "AND-65", "local_evidence": ["changeset-preflight", "mcp-commit-export", "mind-binding-enforcement"], "live_evidence": ["MI", "CX"], "release_evidence": "R" },
    { "id": 14, "owner": "AND-67", "local_evidence": ["changeset-commit", "concurrency-failure"], "live_evidence": ["CX", "P"], "release_evidence": "R" },
    { "id": 15, "owner": "AND-69", "local_evidence": ["changeset-idempotency"], "live_evidence": ["CX", "P"], "release_evidence": "R" },
    { "id": 16, "owner": "AND-71", "local_evidence": ["changeset-preflight", "changeset-commit", "okf-conformance", "starter-mind"], "live_evidence": ["CX", "P"], "release_evidence": "R" },
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
    "mind-binding-state": { "title": "Durable versioned Mind binding state, audit and Sites CAS", "command": ["node", "--test", "tests/integration/mind-binding-state.test.mjs"], "paths": ["tests/integration/mind-binding-state.test.mjs"] },
    "mcp-binding-tools": { "title": "Modern and compatibility MCP binding tools", "command": ["node", "--test", "tests/conformance/mcp-binding-tools.test.mjs"], "paths": ["tests/conformance/mcp-binding-tools.test.mjs"] },
    "mind-binding-enforcement": { "title": "Hard read and exact-generation write binding enforcement", "command": ["node", "--test", "tests/integration/changeset-commit.test.mjs", "tests/integration/product-site-mcp-runtime.test.mjs"], "paths": ["packages/application-content/src/mind-bindings.ts", "packages/composition-root/src/product-site.ts", "tests/integration/changeset-commit.test.mjs", "tests/integration/product-site-mcp-runtime.test.mjs"] },
    "mcp-auth": { "title": "Per-request MCP token lifecycle and scope", "command": ["node", "--test", "tests/unit/mcp-auth.test.mjs"], "paths": ["tests/unit/mcp-auth.test.mjs"] },
    "token-security": { "title": "Token verifier and non-disclosure", "command": ["node", "--test", "tests/unit/token-security.test.mjs"], "paths": ["tests/unit/token-security.test.mjs"] },
    "changeset-preflight": { "title": "Changeset authorization, limits and full-bundle validation", "command": ["node", "--test", "tests/unit/changeset-preflight.test.mjs"], "paths": ["tests/unit/changeset-preflight.test.mjs"] },
    "mcp-commit-export": { "title": "Immediate MCP commit and asynchronous export contract", "command": ["node", "--test", "tests/conformance/mcp-commit-export-tools.test.mjs"], "paths": ["tests/conformance/mcp-commit-export-tools.test.mjs"] },
    "changeset-commit": { "title": "Atomic commit and HEAD CAS", "command": ["node", "--test", "tests/integration/changeset-commit.test.mjs"], "paths": ["tests/integration/changeset-commit.test.mjs"] },
    "concurrency-failure": { "title": "Seeded concurrency and failure injection", "command": ["node", "--test", "tests/integration/concurrency-failure-injection.test.mjs"], "paths": ["tests/integration/concurrency-failure-injection.test.mjs"] },
    "changeset-idempotency": { "title": "Changeset replay, isolation and conflict", "command": ["node", "--test", "tests/integration/changeset-idempotency.test.mjs"], "paths": ["tests/integration/changeset-idempotency.test.mjs"] },
    "okf-conformance": { "title": "Strict full-bundle OKF conformance fixtures", "command": ["node", "--test", "tests/conformance/okf-codec.test.mjs"], "paths": ["tests/conformance/okf-codec.test.mjs", "tests/fixtures/okf/basic/index.md", "tests/fixtures/okf/round-trip/index.md", "tests/fixtures/okf/starter/index.md"] },
    "starter-mind": { "title": "Strict starter and empty-account first useful result", "command": ["node", "--test", "tests/unit/starter-mind.test.mjs", "tests/integration/product-site-mcp-runtime.test.mjs"], "paths": ["packages/adapter-web/src/token-management.ts", "packages/adapter-web/src/onboarding.ts", "packages/adapter-web/src/ui-shell.ts", "packages/composition-root/src/product-site.ts", "tests/fixtures/okf/starter/index.md", "tests/unit/starter-mind.test.mjs", "tests/integration/product-site-mcp-runtime.test.mjs"] },
    "mind-browse": { "title": "Exact-revision browse, fetch and locator isolation", "command": ["node", "--test", "tests/integration/mind-browse.test.mjs"], "paths": ["tests/integration/mind-browse.test.mjs"] },
    "mcp-resources": { "title": "Immutable MCP Resources authorization", "command": ["node", "--test", "tests/conformance/mcp-resources.test.mjs"], "paths": ["tests/conformance/mcp-resources.test.mjs"] },
    "mind-history": { "title": "Snapshot selectors and current-access history", "command": ["node", "--test", "tests/integration/mind-history.test.mjs"], "paths": ["tests/integration/mind-history.test.mjs"] },
    "ordinary-mind-deletion": { "title": "Whole-Mind deletion and retired handle", "command": ["node", "--test", "tests/integration/ordinary-mind-deletion.test.mjs"], "paths": ["tests/integration/ordinary-mind-deletion.test.mjs"] },
    "account-deletion": { "title": "Account cascade, retry and PII-negative scan", "command": ["node", "--test", "tests/integration/account-deletion.test.mjs"], "paths": ["tests/integration/account-deletion.test.mjs"] },
    "okf-unit": { "title": "OKF 0.2 paths, UTF-8 and unknown field round-trip", "command": ["node", "--test", "tests/unit/okf-codec.test.mjs"], "paths": ["tests/unit/okf-codec.test.mjs"] },
    "file-ingress-contract": { "title": "MD-271 unified file-ingress source capability contract", "command": ["node", "--test", "tests/conformance/file-ingress-contract.test.mjs"], "paths": ["docs/specs/file-ingress.md", "docs/decisions/0018-file-ingress-contract-and-source-capability-matrix.md", "tests/conformance/file-ingress-contract.test.mjs"] },
    "server-generated-composition": { "title": "MD-322 trusted hosted server-generated stream composition", "command": ["node", "--test", "tests/unit/server-generated-ingress.test.mjs", "tests/integration/server-generated-composition.test.mjs", "tests/integration/bundle-files-core.test.mjs", "tests/conformance/server-generated-ingress-contract.test.mjs"], "paths": ["packages/application-content/src/server-generated-ingress.ts", "packages/composition-root/src/product-site.ts", "tests/unit/server-generated-ingress.test.mjs", "tests/integration/server-generated-composition.test.mjs", "tests/integration/bundle-files-core.test.mjs", "tests/conformance/server-generated-ingress-contract.test.mjs"] },
    "export-contract": { "title": "Deterministic MD-OKF-ZIP-1 contract", "command": ["node", "--test", "tests/conformance/export-contract.test.mjs"], "paths": ["tests/conformance/export-contract.test.mjs"] },
    "export-download-grants": { "title": "Reauthorized short-lived export downloads", "command": ["node", "--test", "tests/integration/export-download-grants.test.mjs"], "paths": ["tests/integration/export-download-grants.test.mjs"] },
    "mind-search": { "title": "Exact-space and exact-revision search", "command": ["node", "--test", "tests/integration/mind-search.test.mjs"], "paths": ["tests/integration/mind-search.test.mjs"] },
    "audit-index-jobs": { "title": "Index lag, audit, outbox and failure recovery", "command": ["node", "--test", "tests/integration/audit-outbox-index-jobs.test.mjs"], "paths": ["tests/integration/audit-outbox-index-jobs.test.mjs"] },
    "exposure-contract": { "title": "No unsupported browser, MCP or background surface", "command": ["node", "--test", "tests/conformance/exposure-contract.test.mjs"], "paths": ["tests/conformance/exposure-contract.test.mjs"] },
    "mcp-tools": { "title": "Custom Mind-aware JSON Schemas and tool catalog", "command": ["node", "--test", "tests/conformance/mcp-tools.test.mjs"], "paths": ["tests/conformance/mcp-tools.test.mjs"] },
    "mcp-transport": { "title": "Modern MCP 2026-07-28 and isolated Codex 2025-11-25 transport profiles", "command": ["node", "--test", "tests/conformance/mcp-transport.test.mjs"], "paths": ["tests/conformance/mcp-transport.test.mjs"] },
    "canonical-tests": { "title": "All unit, integration and conformance schemas", "command": ["node", "--test", "tests/unit/*.test.mjs", "tests/integration/*.test.mjs", "tests/conformance/*.test.mjs"], "paths": ["package.json"] },
    "fixture-validator": { "title": "Strict checked-in OKF bundle validator", "command": ["npm", "run", "validate:fixtures"], "paths": ["scripts/validate-okf-fixtures.mjs", "tests/fixtures/okf/basic/index.md", "tests/fixtures/okf/round-trip/index.md", "tests/fixtures/okf/starter/index.md"] },
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
    { "id": "imports", "claim": "BundleFile, Brain-scale and Markdown import capabilities are post-MVP and cannot satisfy Release 0.1 readiness.", "evidence": ["okf-unit", "changeset-preflight"] },
    { "id": "checkpoints", "claim": "Branches, merge, moving tags and named checkpoints are absent.", "evidence": ["mind-history"] },
    { "id": "bundle-file-expansion", "claim": "BundleFile and universal file-ingress surfaces are post-MVP and are not advertised as Release 0.1 support or used as a fallback.", "evidence": ["okf-unit", "changeset-preflight", "file-ingress-contract"] },
    { "id": "personalization", "claim": "Personalized landing and website AI are not exposed.", "evidence": ["exposure-contract"] },
    { "id": "oauth-company-knowledge", "claim": "ChatGPT Web/public-directory and company-knowledge profiles are not claimed by the direct Codex UAT plugin.", "evidence": ["mcp-transport", "mcp-tools"] },
    { "id": "claude-support", "claim": "Claude Code is not a supported client without its own conformance evidence.", "evidence": ["mcp-transport"] },
    { "id": "anonymous-access", "claim": "Anonymous access and publication remain absent.", "evidence": ["mind-routes"] },
    { "id": "draft-approval", "claim": "Server drafts and approval artifacts are absent from immediate commits.", "evidence": ["changeset-preflight", "mcp-commit-export"] }
  ]
}
```
<!-- readiness-registry:end -->

## Обязательные live flows

Ни один отдельный flow не является release сам по себе. Все flows выполняются
на одном exact UAT candidate и затем связываются через `R`.

### Web/control

1. Signed-out `GET`/`HEAD` каждого распознанного UI class показывает один safe
   sign-in shell с exact `/signin-with-chatgpt`, no-store headers и без CSRF,
   account/Mind/catalog/revision data или handle enumeration; anonymous REST
   и MCP остаются `401`, identity outage — `503`. После platform sign-in тот же
   UAT deployment показывает registration либо authenticated state. Отдельный
   physical Telegram in-app browser canary подтверждает реальный mobile entry;
   desktop/mobile emulation не заменяет его.
2. Authenticated entry показывает registration state; explicit isolated-account
   action создаёт account и единственный `/me`, retry возвращает тот же state.
3. Profile rename сохраняет `/me`; ordinary Mind create/rename показывает
   editable handle, private default и generic unavailable behavior.
4. Owner переключает visibility с обязательным disclosure; authenticated
   catalog и exact unlisted opening соответствуют server grants.
5. Registered-principal invitation проходит accept/reject/expiry path; role
   mutation, revoke/leave и ownership transfer показывают только разрешённые
   actions и итоговый state.
6. Named MCP token показывается один раз, list не раскрывает secret, revoke
   действует немедленно; UI даёт два exact-origin `bearer_token_env_var` config
   без plaintext в repository/config и, пока secret виден, redacted self-check
   current account + modern/default `list_minds`. DOM/evidence не содержит
   verified email, Mind metadata/content/query, credential или raw response.
7. Whole-Mind и account deletion используют свежий impact, strong confirmation
   и проверяемый irreversible post-state без обещания recovery/receipt.

### Persistence

`AND-89` подтверждает после нового deployment/redeploy тот же разрешённый
account binding, Personal/ordinary Minds, handles, memberships, visibility,
token metadata/status, HEAD и history, idempotency results, audit/outbox/index
state и durable export job. Probe проверяет также, что deleted aggregate не
воскресает, а retired handle не переиспользуется. Platform storage/bindings и
atomicity должны быть названы в evidence; process memory не засчитывается.

### MCP Inspector

На declared modern profile `2026-07-28` проверяются `POST /api/mcp`,
`server/discover`, matching headers и body `_meta`, current result/cache
metadata, JSON и request-scoped SSE, transport auth и application errors,
deterministic `tools/list`, JSON Schemas/annotations, all read/commit/export
tools, immutable Resources, read-only/denied cases, exact revision binding и
отсутствие session/legacy lifecycle assumptions.

### Codex

Один реальный pinned Codex build подключается через `bearer_token_env_var` к
обоим deployed URL. Для default `codex-cli 0.147.0` это
`/api/mcp/2025-11-25`: client предлагает `2025-06-18`, server выбирает
`2025-11-25`, затем проходят initialized/list/call без session. Для opt-in
`mcp_2026_07_28` тот же build проходит `/api/mcp` через `server/discover`.
Далее проверяются list/resolve multiple allowed Minds; browse, search, fetch и
validate exact revision; immediate controlled commit; stale conflict с
неизменным state; historical read after HEAD move; deterministic async export;
revocation/current-access denial. Каждый HTTP request заново проходит Bearer и
current authorization, каждый content call остаётся single-Mind, tools fallback
работает независимо от Resources UX.

## Post-MVP denylist

Следующие capabilities не могут появиться в code, schemas, navigation, release
notes или live evidence 0.1 как частично поддержанные:

| Capability | Граница 0.1 |
|---|---|
| AWS / AgentCore / отдельный production container | Planned post-MVP infrastructure, не fallback при провале Sites. |
| Brain-scale storage/import/export | Accepted post-MVP contract and local code do not participate in Release 0.1 readiness. |
| Named checkpoints/moving tags/branches/merge | История 0.1 использует только immutable revision IDs и `as_of`. |
| BundleFile и universal file ingress | Accepted post-MVP contracts require their own evidence and cannot be advertised as Release 0.1 support or fallback. |
| Personalized landing/`PersonalContext`/website AI | Отдельный будущий trusted use case; `/me` и handle routes в 0.1 — management. |
| ChatGPT Web registered connector, public Plugin Directory, company-knowledge profile | Direct Codex UAT plugin с OAuth не доказывает эти profiles; нужна отдельная verification/review. |
| Claude Code support | Не release gate и не supported client без отдельного adapter/client conformance test. |
| Anonymous publication/access | Все visibility modes 0.1 требуют registered authenticated principal. |
| Server drafts/diff/approval artifacts | Content MCP immediate commit-ит под scope, ACL, CAS и idempotency. |

Schema/route/tool, который делает любой пункт достижимым, — regression scope,
а не «подготовка на будущее».

## Implementation decisions и оставшееся evidence

Эти choices не являются новыми product capabilities. Большинство уже принято
и представлено в executable repository baseline, поэтому таблица различает
текущее repository behavior, датированное UAT evidence и ещё не закрытые
operational проверки. `Реализовано` означает только наличие code/tests на
проверяемом commit; `UAT baseline подтверждён` относится только к явно
зафиксированному live artifact и не расширяет его scope.

| Decision | Состояние | Task Manager owner | Следующее или обязательное evidence |
|---|---|---|---|
| Trusted Sites identity/session/CSRF и D1/R2 bindings в одном Site | Реализовано; базовые identity, persistence-after-redeploy и UAT composition подтверждены | `AND-37` (Spike) | Каждый release повторяет redacted probe exact Site version/deployment; расширенные transaction/failure cases остаются criterion-specific gates. |
| Non-reserved `/api/mcp` modern `2026-07-28`, isolated `/api/mcp/2025-11-25`, SSE/proxy behavior и Codex Bearer forwarding | Реализовано; оба профиля прошли базовый UAT Codex gate | `AND-37` (Spike) | Повторный live JSON/SSE/error probe и pinned Codex на exact candidate; `/mcp` остаётся pre-Worker platform route без automatic fallback. |
| Runtime/toolchain, package/module layout и canonical build/test/check commands | Реализовано в package graph, TypeScript references и root scripts | `AND-38` | Clean-checkout reproducibility, CI и dependency evidence на exact commit. |
| Opaque entry/continuation locators | Реализован versioned confidential/tamper-resistant exact-revision locator и current-access recheck | `AND-61` | Сохранять cross-space/revision, tamper, deletion и reauthorization fixtures; отдельную expiry/retention policy принимать только при изменении contract. |
| MCP token secret и verifier | Принято [ADR-0005](../decisions/0005-mcp-token-secret-verifier.md) и реализовано: exact 32-byte random secret, keyed HMAC-SHA-256 lookup verifier, 90-day maximum, без password KDF | `AND-57` (Spike) | Сохранять benchmark, exact grammar, secret-storage, rotation-boundary и constant-time regression tests. |
| MCP request/header/response limits и rate policies | Частично реализованы bounded parsing/payload limits; operational quotas требуют отдельного release/load evidence | `AND-73` | Transport abuse fixtures, representative payload/stream measurements и exact UAT rate policy до заявления production readiness. |
| File/operation/total-changeset limits | Реализованы и покрыты boundary fixtures | `AND-65` | Invalid/oversized commands должны по-прежнему оставлять no visible objects/revision на exact candidate. |
| Lexical ranking и pagination behavior | Реализованы в exact-revision search baseline | `AND-63` | Seeded relevance/isolation benchmark; изменение scoring/threshold считается contract change и требует новых fixtures. |
| Deterministic export container, filename и `Content-Disposition` | Реализованы как `MD-OKF-ZIP-1` с фиксированным filename | `AND-68` | Сохранять byte-for-byte repeatability, full-bundle validation и archive-safety fixtures. |
| Versioned BundleFile and mixed export | Release 0.2 format-neutral contract is accepted in ADR-0021; core runtime remains legacy until MD-304 and hosted local/workspace intent composition remains absent until MD-305 | `MD-245`, `MD-303`, `MD-304`, `MD-305`, `MD-249`, `MD-306`, `MD-275` | BF7 is contract evidence; BF8 owns core storage/streaming, BF9 owns hosted intent composition, BF10 owns incremental OKF, and MD-275 joins exact UAT. Release 0.1 history remains unchanged. |
| Brain-scale Sites storage/capacity/import | Post-MVP: accepted in ADR-0016; delta storage and reconstructable capacity/admission have local evidence, while joined UAT remains absent | `MD-260`, `MD-264`–`MD-268` | SI rows block only scale/import promotion, not Release 0.1. |
| Export size/expiry и durable job cleanup | Реализованы в repository baseline; representative load/UAT recovery ещё не выводится из local tests | `AND-70` | Restart/retry/load evidence с failed/expired/cleanup state; archive никогда не передаётся в JSON-RPC. |
| Optional MCP Resources UX в target Codex | Resources surface реализована; tools остаются обязательным fallback | `AND-77` | Pinned real-client evidence отдельно подтверждает UX; отсутствие Resources UX не может ломать required tools flow. |
| Manual identity recovery handoff | Fail-closed product boundary принят; полный operator workflow остаётся открытым | `AND-44` | Threat review и tests, доказывающие отсутствие automatic relink/merge/access transfer. |
| Immediate replicated/index deletion и whole-Mind erasure | Restartable repository lifecycle и failure-injection реализованы; physical UAT erasure требует live proof | `AND-52` | Retry и post-delete object/index/job scan на exact deployment; forensic receipt по принятой MVP policy отсутствует. |
| Account-wide cascade и foreign-commit tombstones | Repository lifecycle и PII-negative fixtures реализованы; расширенное live evidence остаётся release gate | `AND-47` | Cross-aggregate reconciliation и negative PII scan на exact candidate. |

ChatGPT Web/public-directory/company-knowledge, personalization, BundleFile,
universal ingress, Brain-scale/import, checkpoints, AWS и support других clients
не входят в terminal 0.1. Принятые post-MVP contracts сохраняются, но требуют
собственного promotion/evidence scope.

## Правило обновления

Изменение scope в `mvp.md`, wire contract в `api.md` или owning Task Manager task в
том же change обновляет соответствующие строки этой матрицы. Owner story
заменяет тип evidence на concrete test IDs/commands и durable artifact paths;
`AND-85` генерирует полный report на candidate SHA; `AND-90` фиксирует `R` и
проверяет, что все 29 строк ссылаются на тот же exact deployment. Закрытая
Task Manager task без этого evidence не делает criterion выполненным.
