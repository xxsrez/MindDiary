# Локальная разработка и проверки

Статус: engineering baseline, обновлено 2026-09-19. Команды, package graph и
Product Site реализованы; single-principal UAT deployment и обязательный Codex
smoke подтверждены отдельно. Локальный build по-прежнему не является заменой
exact Sites/Codex UAT evidence.

## Toolchain

Baseline использует:

- Node.js `>=22.13.0`; локальная pinned-версия записана в `.nvmrc`;
- npm `10.9.2` и committed `package-lock.json`;
- TypeScript `5.9.3`, strict project references и ESM output;
- standard Web API types в service packages без Node runtime types.

Product application `apps/mind-diary-site` использует Node `>=22.13.0`, Vinext,
Vite и Cloudflare Worker-compatible ESM. Собственный hosting manifest объявляет
D1 binding `DB`, R2 binding `MIND_DIARY_BUCKET` и opaque Sites `project_id`;
runtime secrets в repository отсутствуют. Каждый следующий publish снова
проходит отдельный live compatibility gate.

## Clean-checkout path

```bash
npm ci
npm run check
```

`npm ci` использует только lockfile. `npm run check` сначала удаляет generated
TypeScript output, затем заново собирает все packages и запускает unit,
integration, conformance, OKF fixture, dependency graph, documentation и
secret/config hygiene gates. Generated output остаётся в `packages/*/dist`
этого checkout и не коммитится.

Полный gate включает упаковку offline recovery kit: запускать его нужно из
чистого закоммиченного checkout, поскольку kit архивирует именно `HEAD`.
Во время редактирования используются targeted tests; финальную проверку
чистого candidate выполняет CI. На macOS переносимый Node для backup tests
должен линковаться только с системными библиотеками. Если рабочий Node
установлен через Homebrew, задайте `MIND_DIARY_BACKUP_RUNTIME_NODE` абсолютным
путём к официальному standalone Node нужной версии; проверка переносимости
не отключается.

Product Site имеет собственный lockfile, поэтому root gate не проверяет его
dependency graph и сборку автоматически. GitHub CI дополнительно выполняет
`npm --prefix apps/mind-diary-site ci`, аудит обоих активных lockfiles с
`--audit-level=high`, ESLint, сборку Site и проверку полного artifact manifest на SHA
CI checkout. `apps/sites-probe` — исторический отдельный probe, не deployable
product. Обновление зависимостей Site требует его clean build и применимого
hosted smoke; `npm audit --omit=dev` недостаточен, поскольку bundler и RSC
dependencies участвуют в исполняемом Worker. Неиспользуемые Drizzle packages
удалены; SQL migrations по-прежнему версионируются в `drizzle/`.

## Канонические команды

| Проверка | Команда |
|---|---|
| Build всех project references | `npm run build` |
| Unit tests | `npm run test:unit` |
| Integration tests | `npm run test:integration` |
| Protocol/exposure contract tests | `npm run test:conformance` |
| Весь выбранный OKF fixture | `npm run validate:fixtures` |
| Module/import/transitive graph | `npm run check:architecture` |
| Product Site packaging contract | `npm run check:product-site` |
| Свежесть deployable Product Site artifact | `npm run check:product-site-artifact -- --candidate-sha <exact-HEAD-sha>` после vinext build в чистом release checkout |
| Markdown links и локальная структура | `npm run check:docs` |
| Secrets и local config hygiene | `npm run check:secrets` |
| Полный локальный gate | `npm run check` |
| Product Site package/build | `cd apps/mind-diary-site && npm ci && npm run build` |
| Product Site lint | `npm --prefix apps/mind-diary-site run lint` |

`test:conformance` проверяет только repository contracts: разрешённый browser
route manifest, custom Mind-aware MCP tool list, target version
`2026-07-28` и отсутствие control tools в MCP. Это не MCP Inspector, не реальный
Codex test и не Sites compatibility evidence.

## Full dev runtime на localhost

[Project delivery profile](../operations/ship-work-release-profile.md)
задаёт канонический launcher:

```bash
npm run dev
```

Он должен поднимать на `localhost` полный применимый web/control, persistence и
MCP runtime с изолированными local/test данными. Перед каждым UAT cut
`ship-work-release` запускает этот runtime, дожидается readiness и проверяет
все flows, которые можно надёжно выполнить локально. В UAT уходят только exact
candidate и dev receipt с URL, configuration fingerprint и результатами smoke.

## Package graph

Package manifests и TypeScript references кодируют направленность из
[границ реализации](../specs/implementation-boundaries.md):

```text
domain
okf-codec -> domain
application-contracts -> domain
application-ports -> domain + application-contracts
application-control -> domain + contracts + ports
application-content -> domain + okf-codec + contracts + ports
application-background -> domain + okf-codec + contracts + ports

adapter-web -> application-control
adapter-mcp -> application-content
adapter-background -> application-background
adapter-{metadata,object,search,security,audit}-* -> application-ports
composition-root -> application façades + selected adapters
test-fixtures -> domain + okf-codec
```

`check:architecture` требует exact manifest edges, совпадающие TypeScript
references, acyclic graph, отсутствие undeclared/cross-façade imports и
запрещённых direct/transitive runtime dependencies у `domain`/`okf-codec`.
Product composition выбирает D1/R2 и WebCrypto adapters; in-memory/local
adapters остаются test fixtures и не считаются UAT или production persistence.

## Deterministic fixtures

`@mind-diary/test-fixtures` задаёт synthetic opaque IDs для principals, Minds и
revisions, fixed UTC clock и exact OKF bytes. Полный fixture находится в
`tests/fixtures/okf/basic`; manifest hash проверяется unit test, а
`validate:fixtures` обходит весь bundle, включая root `index.md`, `log.md` и
concepts. Fixtures не содержат verified email, token, private query или реальный
user content.

## Local config и secrets

Root `.env.example` и product app `.env.example` содержат только non-secret
defaults/пустые placeholders. Для локальных значений разрешён ignored
`.env.local`; plaintext bearer token нельзя коммитить. Product hosting manifest
объявляет D1/R2 bindings и opaque Sites `project_id`, но не secrets. Hosted
secret values задаются через Sites runtime settings:

- `MIND_DIARY_TOKEN_VERIFIER_KEY`;
- `MIND_DIARY_LOCATOR_KEY`;
- `MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY`;
- `MIND_DIARY_CSRF_KEY`;
- optional canonical HTTPS `MIND_DIARY_PUBLIC_ORIGIN`.

Каждый cryptographic key — независимое 32-byte base64url значение; runtime
fail-closed отклоняет отсутствующие или неверные значения.

`check:secrets` отклоняет tracked `.env*`, private keys и основные token/key
patterns. Это repository gate, а не доказательство отсутствия любого возможного
секрета; перед UAT release требуется применимый scan, а перед production —
отдельная platform/repository проверка с production policies.

## CI и граница доказанного

GitHub Actions повторяет `npm ci` и `npm run check` на Node `22.13.0`. Успех CI
и отдельного Product Site build доказывает воспроизводимость source candidate
на commit, но не создаёт UAT или production artifact. Sites
project/version/deployment, live URL, persistence-after-redeploy, MCP Inspector
и Codex conformance остаются отдельными release gates.
