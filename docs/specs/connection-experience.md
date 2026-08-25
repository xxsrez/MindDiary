# Connections, Advanced MCP и Codex Help

Статус: accepted contract, 2026-08-25. Документ задаёт пользовательскую
information architecture и server-owned projection для Release 0.1. Реализация
и live UAT evidence проверяются отдельно; наличие этого контракта не является
утверждением о развёрнутом поведении.

## Цель и граница поверхностей

Обычный пользователь должен видеть подключение Mind Diary как три действия:

1. установить Mind Diary из доступного Marketplace;
2. при первом content request разрешить чтение и выбрать readable Minds;
3. только при первом write intent пройти отдельный native write step-up и при
   необходимости выбрать один writable Mind.

В основной flow не попадают MCP endpoint, OAuth protocol mechanics
(DCR/PKCE), scopes, grant/token/binding identifiers, personal-token archive и
automatic capture. `/help/codex` один раз называет пользовательский lifecycle
signal `OAuth on first use`, чтобы отделить установленный plugin от ещё не
созданной connection, но не объясняет протокол. Эти детали не нужны для ответа
на пользовательские вопросы «что подключено», «что можно читать», «куда можно
записывать» и «как отключить доступ».

Приняты четыре canonical routes:

| Route | Surface |
|---|---|
| `/settings/connections` | bounded список active OAuth connections текущего actor; ordinary navigation target |
| `/settings/connections/{connection_ref}` | actor-owned connection detail, readable Minds, optional writable Mind и revoke |
| `/settings/developer/mcp` | Advanced MCP: personal tokens и их bounded history, endpoint/config, diagnostics и protocol-oriented recovery |
| `/help/codex` | три пользовательских шага, ожидаемые Codex prompts и безопасное устранение ошибок |

Исторический `/settings/mcp` остаётся совместимым entrypoint. Для
аутентифицированного account `GET`/`HEAD` отвечает `308 Permanent Redirect` на
`/settings/developer/mcp`; signed-out request получает тот же безопасный sign-in
shell, что остальные распознанные UI routes. Он не остаётся второй canonical
страницей и не смешивает ordinary Connections с Advanced MCP.

## Canonical `/help/codex` guide

Guide сохраняет три top-level шага `Install Mind Diary` → `Authenticate for
reading` → `Choose readable Minds and start`. Над ними находится один
keyboard-accessible switch между `Desktop` и `CLI`; выбранный path меняет
только инструкции внутри тех же трёх шагов. Без JavaScript оба path остаются
читаемыми, а при активном script switch использует tab semantics, включая
Arrow/Home/End navigation и связанный tabpanel.

Desktop path показывает проверяемый текущий flow:

1. открыть Plugins, добавить Marketplace repository
   `https://github.com/xxsrez/marketplace`, найти `Mind Diary UAT` в
   `Srez Marketplace` и выбрать `Install`;
2. начать новую Task и отправить безопасный read-only smoke. Первый read
   открывает native `Authenticate`/`Connect`; пользователь входит тем же
   account/workspace, что использует текущий Mind Diary Site;
3. выбрать хотя бы один readable Mind и повторить smoke в fresh Task.

CLI path использует только поддержанные команды:

```bash
codex plugin marketplace add xxsrez/marketplace
codex plugin add mind-diary@srez-marketplace
```

После install пользователь запускает Codex, first read открывает
`Authenticate`, затем `/new` создаёт fresh Task для проверочного smoke. Guide
не утверждает, что `Installed` уже означает connection: `Installed` — success
signal package install, а появление app в `/settings/connections` после consent
— success signal OAuth connection.

Одинаковый copy-ready read smoke используется в обоих path:

```text
Use Mind Diary to list the Minds I can read. Do not create or change any Memory.
```

Успех означает bounded список readable Minds и отсутствие content mutation.
Для каждого checkpoint guide даёт один bounded recovery: сверить exact
Marketplace source/install state, выполнить read smoke в fresh Task, проверить
тот же account/workspace и current selection в Connections. Revoke/reconnect не
является default troubleshooting и предлагается только для уже unusable
connection. Empty Connections, authenticated footer и starter card `/me`
ссылаются на canonical `/help/codex`.

## Presentation identity и actor boundary

Каждый OAuth grant получает отдельный durable `connection_ref` в момент
создания. Это `conn_v1_` + lowercase hex ровно 16 random bytes, не
содержащий и не кодирующий `oauth_grant_id`, token ID, principal, client или
Mind. Он стабилен только в lifecycle одного grant, не является bearer secret и
никогда не переиспользуется после revoke/reconnect.
Existing grants получают ref при schema migration; новый ref создаётся
атомарно с grant metadata.

Raw OAuth grant/access/refresh IDs, authorization mirrors и
`binding_owner_id` запрещены в browser URL, form value, DOM attribute,
telemetry и ordinary response. Presentation `connection_ref` допустим только в
route/form action и не отображается как пользовательская copy. Server сначала
связывает `connection_ref` с
current Sites principal и только затем читает client, scope или binding
metadata. Unknown, malformed, revoked/hidden и принадлежащий другому actor ref
возвращают один и тот же `404 connection_not_found` с одинаковой безопасной
формой до раскрытия metadata. Timing не является публичным oracle: handler не
делает actor-independent detail load с последующей authorization.

Revoke в Release 0.1 означает fail-closed revoke + hide из ordinary
Connections. Physical delete, retained OAuth history и retention policy не
заявляются. Reconnect создаёт новый grant, новый `connection_ref` и пустой
binding set.

## Ordinary Connections projection

### List query

```http
GET /api/v1/connections?limit=20&cursor=opaque
```

- default `limit=20`, maximum `50`; zero, negative, fractional, repeated либо
  unknown query fields отклоняются `400 invalid_request`;
- selection ограничена active OAuth grants current actor и упорядочена по
  `(created_at DESC, connection_ref DESC)`;
- opaque cursor связывает current actor, filter, limit, immutable upper
  boundary и последний sort key. Он не раскрывает IDs, не принимается другим
  actor/query и при неизменных данных продолжает page без duplicate/skip;
- revoked/expired между pages не возвращается снова; новая connection после
  upper boundary не вклинивается в текущий traversal;
- handler сначала получает одну bounded page grants и только затем одним
  bounded projection read загружает binding summaries для refs этой page.
  Bindings невидимой page не читаются;
- response содержит `items`, `next_cursor | null` и не возвращает total count,
  credential history или raw identifiers.

Один item содержит только `connection_ref`, safe client display name, created/
last-used timestamps, пользовательские capabilities `can_read`/`can_write` и
safe access summary. Ordinary copy отображает `Can read` и `Can add and change`,
а не protocol scopes. `can_write=false` не сопровождается selector или
disabled write controls: write surface отсутствует до успешного step-up.

### Detail query

```http
GET /api/v1/connections/{connection_ref}
```

Detail возвращает только actor-safe projection:

- client display name и active lifecycle;
- `Can read` и список `0..N` currently accessible readable Minds;
- `Can add and change` только после current `content:write` step-up, с одним
  writable Mind либо `Not selected`;
- transport-only `binding_version` для CAS; он не показывается как
  пользовательская copy;
- stale readable target как `Access unavailable` без name, route, `space_id`
  или internal binding ID;
- safe actions attach/detach read, select/switch/clear write и revoke.

Routes и responses не показывают credential, binding или capture mechanics.
Automatic capture остаётся Advanced/post-MVP capability и не блокирует 0.1
onboarding.

### Mutation boundary

```http
PATCH  /api/v1/connections/{connection_ref}/mind-access
DELETE /api/v1/connections/{connection_ref}
```

Browser mutations требуют same-origin `Origin`, session CSRF,
`Idempotency-Key`, actor ownership и exact `expected_binding_version`. Mutation
принимает ровно одно действие: `attach_read`, `detach_read`, `select_write`,
`clear_write`. Accessible target выбирается через canonical `mind_ref`; stale
read detach использует connection-owned opaque `stale_access_ref`, который не
раскрывает binding ID. Unknown fields и mixed actions запрещены.

`select_write` существует только при current `content:write`; insufficient
scope возвращает `409 write_step_up_required` без selector values и без
изменения state. Binding CAS, current ACL, fail-closed revoke и singleton write
invariant остаются authoritative. Success возвращает changed/replayed и fresh
safe projection; browser не выводит state из отправленного command.

## Advanced MCP projection

`/settings/developer/mcp` — единственная release-0.1 surface для personal
tokens, exact endpoints/config и redacted diagnostics. Каждый personal token
получает отдельный durable `personal_token_ref`: `ptok_v1_` + lowercase hex
16 random bytes. Raw `token_id`/`binding_owner_id` не попадает в URL/DOM.
Existing tokens получают ref при schema migration; новый ref создаётся
атомарно с token metadata и никогда не переиспользуется.

Personal token list использует отдельный bounded query:

```http
GET /api/v1/mcp-tokens?state=active|revoked|expired&limit=20&cursor=opaque
```

`state` по умолчанию `active` и принимает ровно одно enum value; revoked и
expired history листаются независимо. Default/max limit и actor-bound stable
cursor совпадают с Connections, но cursor namespace другой и никогда не
принимается OAuth list. Cursor фиксирует `as_of`, поэтому expiry classification
не меняется внутри одного traversal. Query может
показывать active/revoked/expired personal-token metadata; secret, verifier,
authorization mirror и OAuth history не возвращаются. Ordinary Connections не
вызывает этот endpoint.

Canonical Advanced mutations используют только presentation ref:

```http
PATCH  /api/v1/mcp-tokens/{personal_token_ref}/mind-access
DELETE /api/v1/mcp-tokens/{personal_token_ref}
```

Unknown/foreign ref возвращает actor-safe `404 personal_token_not_found` до
metadata. Personal-token access использует тот же `binding_version`, CAS,
Mind ACL и safe projection, но может показывать protocol scopes и lifecycle,
поскольку это Advanced surface. Legacy raw `binding_owner_id` route не
является browser contract и удаляется из Product Site calls.

Advanced MCP может объяснять `content:read`, `content:write`, modern/
compatibility endpoint и token recovery. Эти детали не перетекают в ordinary
navigation или `/help/codex`.

## Write step-up state machine

Deterministic server protocol и ещё не подтверждённый fresh-host UX signal
разделены.

| State | User-visible result | Allowed transition |
|---|---|---|
| `installed` | connection ещё не создана | first content request opens native read consent |
| `read_connected` | `Can read`; write row/selector отсутствуют | explicit Codex write intent requests incremental `content:write` |
| `write_step_up_pending` | host-owned consent; server state ещё read-only | approve -> merge scope into same active grant; deny/cancel -> `read_connected` |
| `write_enabled_unselected` | `Can add and change`; `Not selected` | select exactly one currently writable Mind |
| `write_enabled_selected` | exact writable Mind | switch/clear with binding CAS |
| `revoked_or_expired` | ordinary detail is hidden/404; safe reconnect guidance lives in Help/Advanced | reconnect creates a new empty grant |

Server-side DCR/PKCE, read-first grant, incremental scope merge, refresh,
revoke and reconnect are deterministic contract-test territory. Whether the
installed Codex host actually opens native incremental consent at first write
is separate fresh-host canary evidence. Failure of that canary must not widen
initial consent silently. Moving initial OAuth to read+write or changing the
first-user claim requires an explicit product decision.

## UI states and copy contract

Every canonical page preserves the authenticated shell and distinguishes:

| State | Contract |
|---|---|
| loading | bounded region with `aria-busy`; navigation remains usable |
| empty | Connections: install/use Codex next action; Advanced: create a personal token only when needed |
| ready | server-owned safe projection; no raw IDs or protocol copy in ordinary flow |
| retryable error | no stale success claim; bounded retry preserves route and actor context |
| revoked | disappears from ordinary list/detail; Advanced/Help gives reconnect guidance without retained OAuth history claim |
| stale CAS | refresh exact detail, explain changed access, never replay against a guessed version |
| insufficient scope | ordinary page has no write selector; Codex write intent is the only primary step-up path |
| forbidden/not found | identical `404 connection_not_found`, no client/account/Mind metadata |

Keyboard order follows heading, summary, access sections and destructive
revoke last. Mobile layout must not make read/write rows horizontal-only or
hide the capability label in color/icon. UAT remains visibly marked.

## Objective acceptance split

Before handler/UI implementation, repository specs and ADR must agree on route
map, presentation ref, query bounds, error equivalence and step-up states.
Implementation tasks then provide objective tests for:

1. page-size bound, actor/cursor binding, stable traversal and no binding read
   outside the visible page;
2. identical unknown/foreign/revoked detail `404` before metadata;
3. absence of raw grant/token/binding IDs and Advanced mechanics in ordinary
   HTML/JSON;
4. write selector absence before step-up and `0..1` CAS after it;
5. separate OAuth-active and personal-token-history adapters/cursors;
6. real browser keyboard/mobile/loading/error/revoke/reconnect flow.

Fresh external host canary remains required for native incremental-consent UX;
contract tests cannot substitute it.

## Связанные документы

- [ADR-0020](../decisions/0020-connections-ia-and-safe-projections.md)
- [MVP](mvp.md)
- [REST и MCP API](api.md)
- [Plugin и OAuth](plugin-connector.md)
- [Mind bindings](mind-bindings.md)
