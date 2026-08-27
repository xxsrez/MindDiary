# Browser-проверка управления Minds

Статус: accepted evidence procedure для MD-351, 2026-08-27. Процедура
разделяет детерминированный local Playwright gate и hosted UAT acceptance.
Локальный результат не доказывает поведение OpenAI Sites.

## Local exact-candidate gate

Gate запускается на чистом `HEAD`; переданный SHA обязан совпасть с ним:

```bash
npm run gate:mind-admin-browser -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --evidence-out <private-temp-directory>/mind-admin-browser.json
```

Runner проверяет package/lock integrity, фактические Playwright CLI, Chromium
version/revision и SHA-256 выполненного browser binary. Receipt также связывает
candidate tree и SHA-256 config, spec, reporter и runner. Используются один
headless Chromium worker, `UTC`, `en-US`, два isolated browser contexts и
server-bound synthetic actors; user browser profile, real account и private
content не используются.

Fixture сам создаёт оба account, Personal Minds, private ordinary Mind,
invitation и membership через shipped web/API surface. Closed assertion
registry содержит ровно:

- Personal projection и отсутствие ordinary controls;
- private create и отрицательный non-member read;
- rename, description update/clear и two-context metadata conflict;
- private→unlisted warning, exact-route read и отсутствие в каталоге;
- public catalog read-back и public→private future-access warning;
- Reader/Admin/Owner projections;
- runtime reconstruction поверх сохранённых adapters;
- Personal mutation запрет и non-disclosure чужого Personal Mind;
- deletion impact, exact phrase, no-recovery acknowledgement и `404` read-back
  обоими actors.

Обычный Mind удаляется до завершения, затем contexts/listeners закрываются и
изолированные Fake D1/R2 уничтожаются. Receipt
`mind-diary/mind-admin-browser-evidence/v1` не содержит emails, handles,
principal/Mind/revision IDs или corpus. Даже при `status: passed` в нём всегда:

```json
{
  "hosted_evidence": false,
  "acceptance": "local-only",
  "provenance": "exact-local-playwright-composition"
}
```

## Hosted UAT complement

Hosted run выполняется после integration exact candidate, полного repository
gate, сборки exact Sites archive, save/deploy и terminal provider read-back.
Интерактивная surface — Codex in-app Browser. Runner создаёт уникальный
run-owned ordinary Mind и synthetic test actors доступным UAT test seam,
исполняет тот же closed registry и удаляет ordinary Mind. До mutable journeys
он снимает authoritative credential inventory baseline, затем создаёт
отдельный именованный personal token с expiry не более часа, один раз использует
его для разрешённого content read и сохраняет только hash случайного run label,
expiry и HTTP status — secret не попадает в evidence. Существующий Personal
Mind разрешено только читать; менять или удалять его запрещено.

До cleanup сохраняются private raw inputs:

1. `provider-readback.json` schema
   `mind-diary/mind-admin-sites-provider-readback/v1`: exact results
   `get_site`, `save_site_version`, `get_site_version`, initial deploy и
   terminal successful deployment read-back; archive hash/size и candidate SHA
   должны совпасть.
2. `browser-readback.json` schema
   `mind-diary/mind-admin-in-app-browser-readback/v1`: direct in-app Browser
   observations тринадцати journeys, exact candidate/tree, hash local receipt,
   metadata versions, negative HTTP statuses, persistence и cleanup facts.
   Тринадцатая journey `admin.cleanup-credential-baseline` содержит baseline
   credential count и SHA-256 нормализованного inventory до/после, нулевое
   количество run credential после revoke, успешный status его единственного
   use и `401` следующего запроса после revoke. Raw credential name и secret
   запрещены.
3. Exact archive, переданный `save_site_version`, и local receipt того же
   candidate.

Offline consistency check:

```bash
npm run join:mind-admin-uat-readback -- \
  --local-receipt <private-temp-directory>/mind-admin-browser.json \
  --provider-readback <private-temp-directory>/provider-readback.json \
  --browser-readback <private-temp-directory>/browser-readback.json \
  --artifact-archive <exact-archive-passed-to-save-site-version> \
  --candidate-sha <exact-deployed-sha> \
  --join-out <private-temp-directory>/mind-admin-uat-readback-join.json
```

Join проверяет candidate/tree, local receipt digest и registry, provider
lineage, archive bytes, timestamps, browser journey registry и bounded facts.
Email, token/cookie/authorization, internal IDs, private content, download URL,
raw bodies и screenshot paths запрещены. Однако локальный процесс не способен
аутентифицировать происхождение файлов. Поэтому успешный join всегда имеет
только:

```json
{
  "status": "structurally_verified_readback",
  "hosted_evidence": false,
  "acceptance": "nonterminal",
  "provenance": "unverified-local-files"
}
```

Он никогда не создаёт и не валидирует hosted PASS.

## Same-run hosted acceptance

Terminal hosted evidence может записать только orchestrating agent, который в
одном непрерывном run сам наблюдал Sites connector save/version/deploy/read-back
и journeys в Codex in-app Browser. Запись
`mind-diary/mind-admin-uat-evidence/v1` должна иметь `status: passed`,
`hosted_evidence: true`, `provenance: direct-same-run-observation`, exact
candidate/tree/archive/deployment, hashes и refs каждого raw tool output,
structural join hash, тринадцать journey rows и cleanup absence read-back.

Cleanup считается завершённым только после revoke run token, authoritative
token-list read-back с `run_credential_count_after=0`, равенства baseline
count/inventory hash, отказа следующего token request, удаления ordinary Mind и
owner/participant `404` плюс catalog absence. Закрытие browser context или
отсутствие Mind само по себе credential cleanup не доказывает.

Переданные JSON, opaque provider IDs, старый deployment, screenshot, manual
approval или полностью совпавший offline join не заменяют прямые observations.
Если controlled redeploy, negative authorization или cleanup не подтверждены,
hosted результат остаётся nonterminal.
