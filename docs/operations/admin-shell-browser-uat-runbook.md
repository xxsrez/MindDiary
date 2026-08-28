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

Offline joiner получает candidate tree и tracked project из Git, считает
SHA-256 и размер переданного upload archive и server bundle. Текущий Sites
connector после загрузки `.tgz` возвращает identity нормализованного provider
`tar`, а не исходного upload archive: `save_site_version` и
`get_site_version` обязаны сообщить одинаковые provider format/hash/size и
file count, но эти значения сохраняются отдельно от upload archive
hash/size. Offline join не утверждает byte equality двух представлений и явно
оставляет `sites-normalized-archive-not-byte-identical-to-upload-offline` в
`unresolved_provenance`. Для текущего Sites source repository его
`source.commit_sha` является отдельным commit поддерева
`apps/mind-diary-site`, а не SHA монорепозитория. Joiner извлекает этот SHA из
provider read-back, требует доступный Git commit с subject
`Mirror MindDiary <candidate-sha>` и exact tree, равный
`<candidate-sha>:apps/mind-diary-site`; direct-candidate topology принимается
только при фактическом совпадении обоих SHA. Затем joiner
считает live asset hashes из raw bytes и требует exact byte equality с asset
composition того же Git candidate. Это доказывает согласованность байтов и
полей, но не доказывает, что JSON действительно вернули Sites connector и
in-app Browser: локальная программа не имеет platform attestation для такого
утверждения.

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
`scripts/join-admin-shell-uat-readback.mjs`; произвольное `approved`, ссылка на
скриншот или ручная очередь не принимаются.

Оба raw inputs и итоговый structural join хранятся только в private temporary
evidence storage. Raw asset bytes остаются только в browser input и не
переходят в join. В нём запрещены email, cookie, authorization/token,
principal/Mind/revision IDs, private content, download URL и screenshot path.
Команда создаёт mode `0600`
`mind-diary/admin-shell-uat-readback-join/v1`:

```bash
npm run join:admin-shell-uat-readback -- \
  --provider-readback <private-temp-directory>/provider-readback.json \
  --browser-readback <private-temp-directory>/browser-readback.json \
  --artifact-archive <exact-archive-passed-to-save-site-version> \
  --candidate-sha <exact-deployed-sha> \
  --join-out <private-temp-directory>/admin-shell-uat-readback-join.json
```

Join включает hashes обоих raw input, upload archive, нормализованного provider
archive, server bundle и live assets.
Любой изменённый byte, несогласованный ID, failed journey или unsafe evidence
завершает command ненулевым кодом. Даже успешная структурная проверка всегда
выдаёт только:

```json
{
  "status": "structurally_verified_readback",
  "hosted_evidence": false,
  "acceptance": "nonterminal",
  "provenance": "unverified-local-files"
}
```

Локальный join никогда не пишет `status: passed`, не создаёт hosted receipt и
не может повысить локальные lookalike JSON/archive до UAT evidence.

### Same-run hosted acceptance

Hosted acceptance может зафиксировать только тот orchestrating agent, который
в одном непрерывном run сам вызвал Sites connector для save/version/deploy/
terminal read-back и сам выполнил observations в Codex in-app Browser. Он
сохраняет raw outputs каждого Sites call и Browser read-back отдельно,
вычисляет их SHA-256, сопоставляет с structural join и ссылается на конкретные
same-run tool observations. Переданные файлы, старый task report или чужой
receipt не заменяют прямое наблюдение.

Такой agent-owned record использует schema
`mind-diary/admin-shell-uat-evidence/v3`, `status: passed`,
`hosted_evidence: true`, `provenance: direct-same-run-observation` и содержит:

- exact candidate/tree и structural join SHA-256;
- пять отдельных Sites operation refs с hashes их raw outputs;
- in-app Browser observation ref и hash его raw read-back;
- exact project/version/deployment/archive/server/live-asset lineage;
- четыре принятых journeys и числовые budgets.

Ни один local script в репозитории не создаёт и не валидирует этот `v3` как
hosted PASS: authority выводится из реально наблюдаемых tool calls текущего
orchestrator run, а не из формы файла. При отсутствии этих прямых observations
результат остаётся nonterminal независимо от совпадения всех hashes. Только
passing local browser receipt и direct same-run hosted acceptance завершают
browser-часть MD-347.
