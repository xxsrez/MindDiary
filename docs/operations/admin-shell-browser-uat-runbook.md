# Browser-проверка компактного admin shell

Статус: accepted evidence procedure для MD-347, 2026-08-27. Runbook разделяет
детерминированное local browser evidence и обязательный hosted UAT complement.
Local fixture не доказывает Sites deployment, а UAT observation не заменяет
полный repository gate.

## Local exact-candidate gate

Gate запускается только на чистом `HEAD`; переданный SHA обязан совпасть с ним:

```bash
npm run gate:admin-shell-browser -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --evidence-out <private-temp-directory>/admin-shell-browser.json
```

Одна команда сверяет root package, lock integrity, установленные packages и
фактический `playwright --version`, затем запускает и сверяет фактический
Chromium binary `151.0.7922.34` revision `1234`. Только этот проверенный binary
передаётся Playwright как explicit executable; receipt содержит выполненные
версии и SHA-256 binary, а не пересказ `package.json`. После этого gate
поднимает fixture на случайном loopback port, запускает один isolated headless
Chromium worker и завершает server. User Chrome profile, extensions, login и
system/default browser не используются.

Closed assertion registry охватывает signed-out/registration/registered
sessions, wide и compact navigation, direct/back, loading/empty/forbidden/
not-found/conflict/server-error, Personal Mind, dialog, keyboard/focus,
landmarks/headings/current state, forced colors, reduced motion, пять
acceptance viewports, overflow, hit targets и first-viewport density.
Отсутствующий либо дублированный assertion делает receipt invalid даже при
нулевом exit code Playwright.

Failure завершается ненулевым кодом и в output содержит exact
`route=<path> viewport=<width>x<height> assertion=<criterion>`. Screenshot
создаётся только для упавшего synthetic fixture case в отдельном temporary
diagnostic directory. Он не входит в receipt и не является acceptance
evidence; trace и video отключены. Успешный run удаляет diagnostic directory и
пишет mode `0600` receipt `mind-diary/admin-shell-browser-evidence/v1`.

## Hosted UAT complement

Hosted observation выполняется после exact candidate integration, полного
gate, Sites artifact build/save/deploy и current-deployment read-back. Surface
для интерактивной проверки — только Codex in-app Browser. Safari, system
default browser и обычный Chrome не запускаются; Chrome допустим лишь после
отдельно установленного in-app ограничения по общему browser policy.

До journeys сохраняются два private raw read-back input и exact archive:

- `provider-readback.json` schema
  `mind-diary/admin-shell-sites-provider-readback/v1` содержит только exact
  connector results `get_site`, `save_site_version`, `get_site_version`,
  initial deploy и terminal successful `get_deployment_status`. Поля `site`,
  `saved_version`, `version`, `deployment_start`, `deployment` копируются из
  этих пяти результатов, `generator` равен
  `codex-sites-connector-readback/v1`; ID не вводятся отдельно в CLI;
- exact archive, переданный `save_site_version`; remote-build fallback не
  образует достаточной MD-347 lineage, потому что verifier обязан сам прочитать
  `dist/server/index.js` из этого archive;
- `browser-readback.json` schema
  `mind-diary/admin-shell-in-app-browser-readback/v1` содержит raw asset bytes
  и четыре DOM/accessibility/geometry journeys из одного approved in-app
  Browser observation после provider read-back.

Verifier сам получает candidate tree и tracked project из Git, считает archive
и server bundle SHA-256, сверяет archive hash/size с `get_site_version`, а
candidate SHA — с его `source.commit_sha`. Затем он считает live asset hashes
из raw bytes и требует exact byte equality с asset composition того же Git
candidate. Самозаявленные digest, version/deployment ID или готовый receipt в
CLI не принимаются.

Live asset digest вычисляется из bytes, а не из URL, cache label или visual
similarity. В Browser на UAT origin используется следующий bounded same-origin
collector:

```js
async (paths) => {
  const hex = (bytes) => [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const result = [];
  for (const path of paths) {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    result.push({
      path,
      response_url: response.url,
      status: response.status,
      content_type: response.headers.get("content-type"),
      body_base64: btoa(binary),
      body_sha256: `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`,
    });
  }
  return result;
}
```

Обязательны ровно четыре critical journeys:

| ID | Route и viewport | Проверяемый результат |
|---|---|---|
| `wide-minds` | `/minds`, `1440×900` | rail видим, Settings в viewport, первая row полностью видима |
| `narrow-settings` | `/settings/connections`, `390×844` | drawer закрыт; keyboard open фокусирует My Mind; focus trap и Escape возвращают focus |
| `personal-mind` | `/me`, `390×844` | adjacent private-only disclosure; нет share/transfer/separate-delete controls |
| `direct-settings-and-back` | `/settings/developer/mcp`, `1024×768` | Settings + Advanced MCP current; Back восстанавливает current Minds |

Для каждой строки Browser снимает не visual verdict, а DOM/accessibility/
geometry facts: exact route и viewport, `h1_count`, current items, page header
bottom, first key content top, document/body overflow и минимальный размер
проверенных navigation/action targets. Бюджеты: overflow `0..1px`, один `h1`,
hit target `>=44px`, header полностью и key content начало внутри viewport.
Названия обязательных checks и exact JSON shape задаёт
`scripts/verify-admin-shell-uat-receipt.mjs`; произвольное `approved`, ссылка на
скриншот или ручная очередь не принимаются.

Оба raw inputs и итоговый receipt хранятся только в private temporary evidence
storage. Raw asset bytes остаются только в browser input и не переходят в
receipt. В итоговом документе запрещены email, cookie, authorization/token,
principal/Mind/revision IDs, private content, download URL и screenshot path.
Verifier не принимает заранее сформированный receipt: он создаёт новый mode
`0600` `mind-diary/admin-shell-uat-evidence/v2` на том же checkout:

```bash
npm run verify:admin-shell-uat -- \
  --provider-readback <private-temp-directory>/provider-readback.json \
  --browser-readback <private-temp-directory>/browser-readback.json \
  --artifact-archive <exact-archive-passed-to-save-site-version> \
  --candidate-sha <exact-deployed-sha> \
  --receipt-out <private-temp-directory>/admin-shell-uat.json
```

Final receipt cryptographically включает hashes обоих raw input, archive,
server bundle и обоих live assets. Любой изменённый byte, подставленный ID,
missing/mismatched field, failed journey или unsafe evidence завершает command
ненулевым кодом. Local JSON, созданный без реальных Sites connector calls и
in-app Browser observation, не является hosted evidence даже при правильной
форме; approved surfaces являются authority источника, verifier обеспечивает
целостность и exact join после capture. Только passing local receipt плюс
passing hosted receipt относятся к завершённой browser-части MD-347.
