# UAT-контракт Google Drive `connector_object`

Статус: exact-provider contract определён MD-284, но не исполнен. Реальный
provider run, hosted evidence и terminal acceptance принадлежат MD-319.

## Назначение и граница

Эта процедура проверяет один exact candidate/deployment и один ограниченный
synthetic набор Google Drive objects. Она не разрешает использовать файлы
пользователя, расширять persistent scopes, менять provider configuration,
передавать данные внешнему получателю или принимать произвольный URL. OAuth,
provider mutation и browser launch выполняются только при отдельной authority
в owning task; наличие этого документа такой authority не создаёт.

Машинный contract:
[`tests/fixtures/google-drive-connector-uat/contract.v1.json`](../../tests/fixtures/google-drive-connector-uat/contract.v1.json).

## Предусловия

1. Зафиксированы exact `candidate_sha` и UAT `deployment_id`; deployment
   прочитан обратно из configured Sites provider.
2. Restricted-UAT account pool имеет `ready` receipt, а run-scoped provider
   grant и synthetic Drive objects созданы вне repository. В repository и Task
   Manager не сохраняются token, account, grant, object/revision ID или URL.
3. Test Mind и writable target принадлежат тому же synthetic principal.
   Existing user Minds, grants и provider objects не используются.
4. Private evidence directory находится вне repository и очищается после
   privacy-safe receipt derivation.

Если любое предусловие неизвестно, итог — `blocked` или `unknown`, а не
частичный `passed`.

## Фикстуры

- один обычный binary object с заранее вычисленными exact size/SHA-256;
- один Google Doc в synthetic shared drive с явным export snapshot
  `google-drive/docx`;
- один Google Sheet в synthetic shared drive с явным export snapshot
  `google-drive/xlsx`;
- одна Google Slides presentation в synthetic shared drive с явным export snapshot
  `google-drive/pptx`.

Для native objects исходные provider bytes не выдумываются: evidence относится
только к выбранному export snapshot. Дополнительный `google-drive/pdf` может
быть informational, но не заменяет три обязательных native formats.

## Blocking assertions

Runner выполняет все `GD-UAT-001`–`GD-UAT-016` из machine contract. В частности:

- принимает только один exact authorized object ID, никогда URL/query/folder;
- сверяет binary source и staged/downloaded bytes byte-for-byte по size и
  SHA-256;
- требует exact explicit export representation для Docs/Sheets/Slides;
- подтверждает shared-drive metadata path и native `files.export` по exact
  `fileId + mimeType` для всех трёх типов без неподдерживаемых query parameters;
- проверяет revoke, ownership/version mutation, export race, oversize, timeout
  и unknown provider result как fail-closed без existence leak;
- доказывает server-derived current writable target и current Mind write
  authorization до grant resolution/provider metadata read; runner не передаёт
  owner, generation или target version во ingress request;
- завершает общий lifecycle: staged ref → atomic commit → exact revision
  download/history → Sites-owned web export → redeploy read-back;
- отдельно подтверждает отсутствие administrative export у Content MCP.

Локальные fake-provider tests не заменяют ни один из этих hosted assertions.

## Локальный preflight

Перед hosted run создаётся только план, а не результат проверки:

```bash
MD319_TEMP_ROOT=${TMPDIR:-/tmp}
MD319_EVIDENCE_DIR=$(mktemp -d "${MD319_TEMP_ROOT%/}/mind-diary-md319-evidence.XXXXXX")
chmod 700 "$MD319_EVIDENCE_DIR"
npm run uat:prepare-google-drive-connector -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --deployment-id <current-appgdep-id> \
  --pool-readiness-receipt <private-ready-pool-receipt.json> \
  --evidence-out "$MD319_EVIDENCE_DIR/google-drive-plan.json"
```

Runner перечитывает clean `HEAD`, tracked Sites Project, exact deployment,
fresh pool receipt, machine contract и deterministic fixture plan. Output
создаётся атомарно только как новый `0600` file внутри owner-only `0700`
temporary directory вне repository и всех его worktrees.

Schema `mind-diary/google-drive-connector-uat-plan/v1` всегда содержит
`status: ready_for_hosted_execution`, `hosted_evidence: false`,
`acceptance: nonterminal`; у всех assertions и cleanup остаётся `not_run`.
Preflight не имеет provider credential CLI input, не открывает browser, не
обращается к Sites/Drive и не может быть terminal evidence.

Канонический synthetic recipe находится в
[`synthetic-fixture-plan.v1.json`](../../tests/fixtures/google-drive-connector-uat/synthetic-fixture-plan.v1.json).
Binary bytes задаются закрытым counter recipe с exact size/SHA-256. Для
Google-native fixtures repository фиксирует только synthetic semantic recipe и
export representation; exact DOCX/XLSX/PPTX bytes и digest возникают только
из реального `files.export` текущего run и не предсказываются локально.

## Hosted execution и raw read-back

Orchestrating agent, а не локальный скрипт, в одном непрерывном run обязан
непосредственно наблюдать:

1. Sites project/version/deployment и exact archive hash до и после controlled
   redeploy;
2. actor-owned run-scoped Drive grant и создание четырёх run-owned objects по
   fixture plan без изменения persistent scopes;
3. metadata и content/export запросы каждого exact object, snapshot bytes и
   full negative matrix;
4. server-derived writable target, stage, atomic commit, immutable history,
   BundleFile download и Sites-owned web export;
5. persistence на новом deployment и reduce-only cleanup с absence read-back.

Environment-only credential reference и raw provider/product IDs остаются
только в текущем execution context. Redacted readbacks содержат opaque
SHA-256 fingerprints raw observations, но не token, grant/object/revision ID,
binding, URL, email, path, body или bytes.

Закрытая negative matrix включает URL/query/folder selector, revoke,
ownership/version drift, changed export bytes, binary/native size overflow,
timeout, unknown result, provider not-found/forbidden и missing/mismatched/
concurrently changed target. Каждая строка фиксирует canonical safe code,
retryability, был ли начат provider fetch, indistinguishable response, zero
staged state и zero HEAD change. Unknown mutation result сначала reconciles
тот же run fingerprint; новый nonce до read-back запрещён.

## Offline structural join

После прямых same-run observations их форму и byte lineage можно проверить:

```bash
npm run join:google-drive-connector-uat-readback -- \
  --plan-receipt "$MD319_EVIDENCE_DIR/google-drive-plan.json" \
  --sites-readback "$MD319_EVIDENCE_DIR/sites-readback.json" \
  --provider-readback "$MD319_EVIDENCE_DIR/drive-readback.json" \
  --product-readback "$MD319_EVIDENCE_DIR/product-readback.json" \
  --artifact-archive <exact-site-archive.tgz> \
  --candidate-sha <exact-deployed-sha> \
  --join-out "$MD319_EVIDENCE_DIR/google-drive-join.json"
```

Join пересчитывает archive SHA-256, проверяет candidate/project/version/both
deployment IDs, pool/fixture/run fingerprints, binary/native snapshots,
closed assertion registries, lifecycle, negative matrix и cleanup. `join-out`
использует тот же owner-private atomic output contract, что preflight.

Даже согласованные локальные файлы дают только:

```json
{
  "status": "structurally_verified_readback",
  "hosted_evidence": false,
  "acceptance": "nonterminal",
  "provenance": "unverified-local-files"
}
```

CLI не принимает approval/`hosted-pass`. Lookalike JSON может доказать форму,
но не происхождение observations.

## Blocker и recovery

Если hosted assertion не доказан, report выбирает ровно одну категорию:
`service_fault`, `product_defect`, `missing_external_capability`,
`credential_role_or_approval`, `unknown_external_outcome` или
`blocked_by_dependency`. Он содержит safe code, affected assertion IDs и один
наблюдаемый `resume_signal`; локальный `not_run` сам по себе не объявляется
product blocker.

- `product_defect` требует exact expected/observed product result и no-side-
  effect read-back.
- `missing_external_capability` требует fresh probe и exact отсутствующий
  primitive, а не общий вывод про Google Drive.
- `credential_role_or_approval` допустим только для нового persistent scope или
  реального password/MFA/passkey boundary; routine fixture run не отдаётся
  человеку.
- `unknown_external_outcome` требует reconcile provider, target, HEAD, staging
  и cleanup до retry.
- После interruption разрешены только read-back и reduce-only cleanup того же
  run fingerprint; новый run начинается после доказанного отсутствия state.

## Receipt и cleanup

Public/privacy-safe terminal receipt имеет schema
`mind-diary/google-drive-connector-uat-evidence/v1`,
`hosted_evidence: true`, `provenance: direct-same-run-observation`, exact
candidate/deployment lineage, runner ID, timestamps, stable assertions,
cleanup status и hashes/refs raw observations. Запрещены credentials,
authorization header, provider
grant/object/revision ID, binding ref, export/download URL, email, local path и
content.

Cleanup удаляет synthetic provider objects, отзывает run-scoped grant, удаляет
run Mind и выполняет отсутствие-read-back с обеих сторон. Любая непроверенная
часть cleanup делает итог не выше `unknown`; успешные product assertions не
компенсируют незакрытый cleanup.

Только один receipt со всеми `passed` на одном exact candidate/deployment и
успешным cleanup является MD-319 provider evidence. Сам contract и repository
conformance test, local plan и structural join фиксируют лишь форму будущей
проверки и не являются UAT acceptance. Terminal record создаёт только
orchestrating agent из прямых same-run Sites, Google Drive и product
observations; repository script намеренно не умеет его выпускать.
