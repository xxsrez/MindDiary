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

Одна команда использует зафиксированные `@playwright/test@1.62.1` и
`@playwright/browser-chromium@1.62.1`, поднимает fixture на случайном loopback
port, запускает один isolated headless Chromium worker и после suite завершает
server. User Chrome profile, extensions, login и system/default browser не
используются.

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

До journeys необходимо связать одну lineage:

- exact candidate Git SHA и его tree SHA;
- tracked Sites project ID из
  `apps/mind-diary-site/.openai/hosting.json`;
- exact saved Site version ID и deployed deployment ID после current read-back;
- SHA-256 опубликованного archive и `server/index.js` из release artifact;
- SHA-256 live bytes `/ui/mind-diary-shell.css` и
  `/ui/mind-diary-shell-client.js` на том же deployment.

Live asset digest вычисляется из bytes, а не из URL, cache label или visual
similarity. В Browser на UAT origin используется следующий bounded same-origin
collector:

```js
async (paths) => {
  const hex = (bytes) => [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const result = {};
  for (const path of paths) {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    result[path] = `sha256:${hex(await crypto.subtle.digest("SHA-256", await response.arrayBuffer()))}`;
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

Receipt хранится только в private temporary evidence storage. В нём запрещены
email, cookie, authorization/token, principal/Mind/revision IDs, private
content, download URL и screenshot path. После формирования проверка выполняется
на том же checkout:

```bash
npm run verify:admin-shell-uat -- \
  --receipt <private-temp-directory>/admin-shell-uat.json \
  --candidate-sha <exact-deployed-sha> \
  --site-version-id <exact-saved-version-id> \
  --deployment-id <exact-current-deployment-id>
```

Verifier read-back-ит tracked project identity и Git tree, требует четыре
journeys/asset digests, проверяет budgets, lineage и canonical receipt digest.
Любой missing/mismatched field, failed journey или unsafe evidence завершает
command ненулевым кодом. Только passing local receipt плюс passing hosted
receipt относятся к завершённой browser-части MD-347.
