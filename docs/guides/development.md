# Локальная разработка и проверки

Статус: engineering baseline, 2026-08-06. Команды и package graph в этом
документе реализованы. Исполняемый web/MCP service, Sites project и deployment
ещё не созданы; локальный build не доказывает совместимость с Sites или Codex.

## Toolchain

Baseline использует:

- Node.js `>=22.13.0`; локальная pinned-версия записана в `.nvmrc`;
- npm `10.9.2` и committed `package-lock.json`;
- TypeScript `5.9.3`, strict project references и ESM output;
- standard Web API types в service packages без Node runtime types.

Node minimum и Worker-compatible ESM direction согласованы с текущим bundled
Sites starter: он требует Node `>=22.13.0`, использует Vite и собирает
Cloudflare Worker-compatible ESM. Mind Diary пока не копирует starter, `vinext`
или Sites Vite plugin: deployable UI/runtime отсутствует, а platform binding
должен появиться только после отдельной реализации и compatibility gate.
Общая [документация Sites](https://learn.chatgpt.com/docs/sites) также требует
сначала подтвердить совместимость существующего project.

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

## Канонические команды

| Проверка | Команда |
|---|---|
| Build всех project references | `npm run build` |
| Unit tests | `npm run test:unit` |
| Integration tests | `npm run test:integration` |
| Protocol/exposure contract tests | `npm run test:conformance` |
| Весь выбранный OKF fixture | `npm run validate:fixtures` |
| Module/import/transitive graph | `npm run check:architecture` |
| Markdown links и локальная структура | `npm run check:docs` |
| Secrets и local config hygiene | `npm run check:secrets` |
| Полный локальный gate | `npm run check` |

`test:conformance` проверяет только repository contracts: разрешённый browser
route manifest, custom Mind-aware MCP tool list, target version
`2026-07-28` и отсутствие control tools в MCP. Это не MCP Inspector, не реальный
Codex test и не Sites compatibility evidence.

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
Fixture adapters являются только contract markers: они не реализуют storage,
security, application use cases или deployable service.

## Deterministic fixtures

`@mind-diary/test-fixtures` задаёт synthetic opaque IDs для principals, Minds и
revisions, fixed UTC clock и exact OKF bytes. Полный fixture находится в
`tests/fixtures/okf/basic`; manifest hash проверяется unit test, а
`validate:fixtures` обходит весь bundle, включая root `index.md`, `log.md` и
concepts. Fixtures не содержат verified email, token, private query или реальный
user content.

## Local config и secrets

`.env.example` содержит только non-secret defaults и пустой token key. Для
локальных значений разрешён ignored `.env.local`; plaintext bearer token нельзя
коммитить. Hosted values в будущем задаются через Sites settings, а не
`.openai/hosting.json`. Последний намеренно отсутствует, пока реальный Sites
project не создан.

`check:secrets` отклоняет tracked `.env*`, private keys и основные token/key
patterns. Это repository gate, а не доказательство отсутствия любого возможного
секрета; перед production release потребуется platform/repository scanning с
реальными policies.

## CI и граница доказанного

GitHub Actions повторяет `npm ci` и `npm run check` на Node `22.13.0`. Успех CI
доказывает воспроизводимость engineering baseline на commit, но не создаёт
production artifact. Sites project/version/deployment, live URL, persistence,
MCP Inspector и Codex conformance остаются отдельными release gates.
