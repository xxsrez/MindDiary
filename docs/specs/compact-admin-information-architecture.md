# Компактная административная IA Mind Diary

Статус: accepted contract, обновлено 2026-08-27. Документ задаёт проверяемый
design handoff для compact Product Site shell. MD-355 уточняет внутри уже
принятой оболочки Settings IA, устойчивое положение Codex Help и поведение
прямых/legacy routes. Контракт определяет только информационную архитектуру,
компоновку и доступность Product Site. Его наличие не доказывает реализацию
или deployment.

## Уточнение редизайна от 2026-09-05

Принято пользователем: сохранить все действующие функции и перенять концепцию
раннего прототипа MD-331, без буквального копирования. Этот раздел заменяет
прежние размеры и приоритет крупных поясняющих блоков ниже.

- Постоянная панель — 208px; рабочая область занимает доступную ширину до
  1440px. Отступы — 16–24px, заголовок страницы — 24px, раздела — 18px.
  Интерфейс использует системный sans-serif; знак и фиолетовый акцент сохраняются.
- Список Minds открывает страницу. Имя, описание, роль, видимость и действие
  сравниваются по выровненным столбцам; Personal Mind остаётся первым.
  На узком экране поля переносятся с сохранением подписей и полного доступа.
- Настройка Codex для всего списка раскрывается отдельно после списка, а не
  вытесняет Minds с первого экрана. На странице Mind она остаётся доступной.
- Импорт, экспорт, подробное использование storage и передача владельца
  получают именованные раскрываемые разделы. Все формы, предупреждения,
  проверки текущих прав и подтверждения остаются внутри своей операции.
- Размеры интерактивных целей остаются не меньше 44px. Компактность достигается
  компоновкой и сокращением повторов, а не уменьшением безопасной цели нажатия.
- Проверки должны использовать настоящий renderer списка с включённой
  настройкой Codex, длинными именами и несколькими Minds, а не только shell fixture.

## Цель и источник направления

После регистрации человек должен быстро находить свой Personal Mind, список
доступных Minds, приглашения и настройки, не проходя через крупные
маркетинговые карточки. На широком экране это компактная административная
поверхность с постоянной левой навигацией; на узком — тот же порядок в
закрываемом drawer.

Task Manager используется только как ориентир для трёх качеств: явная
иерархия, высокая информационная плотность и предсказуемое положение
навигации. Mind Diary не копирует его цвета, форму контролов, названия,
компоненты, interaction details или визуальную композицию. Айдентика,
product language и copy остаются из [brand baseline](../brand.md).

Контракт не добавляет corpus viewer/editor, website AI, новый route, роль,
видимость, permission, token scope, binding rule или модель доступа. Raw
content по-прежнему не рендерится в control plane; `/me` и
`/{space_handle}` остаются management routes. Точные session, routing и
authorization semantics остаются в [MVP](mvp.md),
[personalized opening](personalized-opening.md) и
[Connections](connection-experience.md).

Для MD-347 этот более поздний узкий контракт заменяет только placement
ordinary Connections в верхней navigation из `connection-experience.md`:
route и actor-safe projection не меняются, но Connections становится child
Settings. Остальной Connections contract сохраняет силу.

## Состояния входа и account

Shell выбирается только из server-owned session projection. Клиентский URL,
email, `principal_id`, `space_id`, role или ранее показанный DOM не выбирают
состояние.

| Состояние | Shell и первое действие | Что запрещено показывать |
|---|---|---|
| `signed_out` | Статическая auth-страница: brand, UAT marker, один `h1`, краткая граница и `Sign in with ChatGPT`. | Левая навигация, названия/счётчики Minds, target route metadata, CSRF, account/profile hints. Все распознанные UI routes получают одинаковый shell. |
| `registration_required` | Brand + один `main`: создать новый isolated account; manual recovery — вторичное действие через исходный trusted channel. | Предположение о прежнем account, прежние права, verified email, автоматический relink/merge/transfer. |
| `bootstrapping` | Та же registration surface с `aria-busy="true"`, стабильным idempotency attempt и недоступной повторной primary action. | Навигация зарегистрированного пользователя и частично созданный Personal Mind. |
| `bootstrap_error` | Причинная ошибка, safe retry с тем же attempt, либо categorical manual recovery. | Ложный success и действие, способное намеренно создать второй account/Personal Mind. |
| `registered` | Компактный application shell; server-owned static navigation доступна до deferred page collection. | Corpus content, raw IDs, secrets и вывод прав из client state. |

### Состояния `/settings/account`

`/settings/account` не является отдельным auth mode: это страница внутри
`registered` shell. Она различает следующие панели и никогда не заменяет ими
server session:

| Панель | Обязательный результат |
|---|---|
| `profile_idle` | Текущее безопасное display name, profile version только в transport metadata, primary action `Save`. |
| `profile_saving` | Контролы изменения имени недоступны, bounded status с `aria-busy`; navigation остаётся usable. |
| `profile_saved` | Точный server read-back и текстовый success signal, не только цвет. |
| `profile_error` | Stale success убран; retry повторяет exact command только когда это безопасно. |
| `profile_conflict` | Текущее состояние перечитывается; UI не угадывает новую version. |
| `deletion_impact_loading` | Danger zone уже имеет heading, но confirmation недоступна до fresh impact. |
| `deletion_impact_ready` | Exact cascade и необратимость находятся непосредственно перед confirmation field/action. |
| `deletion_impact_changed_or_expired` | Старое подтверждение недействительно; impact перечитывается. |
| `deleting` | Один bounded progress state без повторного destructive command. |

## Каноническая иерархия навигации

### Wide shell

При ширине viewport `>= 1024px` shell состоит из постоянного rail шириной
`208px` и content column. Rail занимает `100dvh`, остаётся видимым при
вертикальном scroll content и имеет два блока:

```text
┌──────────────────────┬─────────────────────────────────────────────┐
│ Mind Diary       UAT │ Page heading                    Primary CTA │
│                      │ supporting description                       │
│ My Mind              ├─────────────────────────────────────────────┤
│ ──────────────────── │ compact filters / contextual navigation     │
│ Minds                ├─────────────────────────────────────────────┤
│ Public Minds         │ compact row                                 │
│ Invitations          │ compact row                                 │
│                      │ compact row                                 │
│                      │ …                                           │
│ Help with Codex?     │                                             │
│ Settings             │                                             │
└──────────────────────┴─────────────────────────────────────────────┘
```

`My Mind` — особый первый item primary navigation, до разделителя и обычных
collection routes. Он всегда имеет label `My Mind`, route `/me` и не показывает
service-managed handle. Display name Personal Mind не используется как nav
label. Brand открывает `/`; отдельный `Home` item не добавляется.

`Settings` закреплён последним item в нижней части rail и открывает
`/settings/account`. Optional `Help with Codex` идёт непосредственно перед
Settings только когда canonical `/help/codex` присутствует в candidate;
отсутствие Help не сдвигает Settings с нижнего края. Connection и Advanced MCP pages принадлежат Settings и
используют contextual navigation внутри content, а не отдельные primary items.

### Medium и compact shell

При viewport `< 1024px` постоянный rail заменяется top app bar высотой `56px`.
Она содержит compact brand/mark, видимый `UAT` marker и menu button с
`aria-expanded`. Drawer повторяет desktop-порядок без дополнительной mobile IA:
`My Mind` first, collection routes, затем optional Help и pinned Settings.

Drawer:

- имеет ширину `min(320px, 88vw)` и высоту `100dvh`;
- закрыт до явного действия и не делает скрытые ссылки tabbable;
- при открытии получает focus на `My Mind`, удерживает focus внутри drawer,
  `Escape` закрывает его и возвращает focus menu button;
- не создаёт горизонтальный scroll document и не скрывает текущий heading от
  accessibility tree;
- использует один modal backdrop; motion не требуется для понимания state.

```text
┌─────────────────────────────────────┐
│ Mind Diary · UAT              Menu │ 56px
├─────────────────────────────────────┤
│ Page heading                        │
│ Supporting description             │
│ [Primary action]                    │
├─────────────────────────────────────┤
│ compact row / state                 │
│ compact row                         │
└─────────────────────────────────────┘

Open drawer:
┌───────────────────────┬─────────────┐
│ My Mind               │ backdrop    │
│ ────────────────────  │             │
│ Minds                 │             │
│ Public Minds          │             │
│ Invitations           │             │
│                       │             │
│ Help with Codex?      │             │
│ Settings              │             │
└───────────────────────┴─────────────┘
```

## Route и active-state map

`aria-current="page"` устанавливается по server-resolved route, не по
string prefix в browser. В каждом именованном navigation landmark ровно один
current item; Settings pages поэтому могут иметь одновременно current
`Settings` в utility navigation и current child в отдельной contextual
navigation.

| Resolved route | Shell current | Context current | Примечание |
|---|---|---|---|
| `/` | Brand/home | — | Primary list не получает current item. |
| `/me` | `My Mind` | — | Особый Personal Mind item. |
| `/minds` | `Minds` | list/create mode при наличии tabs | Ordinary Minds collection. |
| `/{space_handle}` | `Minds` | exact Mind management section | Только после handle resolution и authorization. |
| `/public` | `Public Minds` | — | Authenticated catalog. |
| `/invitations` | `Invitations` | incoming/sent section по page state | Не раскрывает invitation count в shell. |
| `/settings/account` | `Settings` | `Account` | Default Settings destination. |
| `/settings/connections` | `Settings` | `Connections` | Active OAuth connections. |
| `/settings/connections/{connection_ref}` | `Settings` | `Connections` | Detail наследует parent current state. |
| `/settings/developer/mcp` | `Settings` | `Advanced MCP` | Protocol details остаются только здесь. |
| `/settings/mcp` | session-dependent | — | Authenticated `GET`/`HEAD` получает `308` на `/settings/developer/mcp`; signed-out request остаётся распознанным UI route и получает общий route-agnostic sign-in shell без target data. |
| `/help/codex` | `Help with Codex` | — | Optional utility item; не child Settings. |
| `/help` | none | — | Footer/deep-link route; не расширяет primary IA. |
| unknown/reserved/unauthorized | none | — | Safe not-found/forbidden без target metadata. |

## Settings IA и устойчивый Codex Help

Нижний `Settings` — один entrypoint административного контейнера, а не новый
onboarding flow. Он всегда ведёт прямо на `/settings/account`. На
канонических Settings pages отдельная contextual navigation содержит ровно
три пункта в стабильном порядке:

1. `Account` → `/settings/account`;
2. `Connections` → `/settings/connections`;
3. `Advanced MCP` → `/settings/developer/mcp`.

Account lifecycle content принадлежит отдельной implementation surface.
Connections сохраняет actor-safe ordinary projection. Personal tokens,
endpoint details и redacted diagnostics остаются внутри `Advanced MCP` и не
получают отдельного rail item. Этот IA contract не определяет OAuth detail,
token behavior или diagnostic semantics и не показывает credential, endpoint,
scope, binding ID либо другой protocol internal в обычной navigation/copy.

`Help with Codex` остаётся optional utility item непосредственно перед
`Settings`, а не четвёртым Settings child. Если canonical `/help/codex`
присутствует в candidate, ссылка на него строится из статического registered
shell и доступна на ordinary pages, Connections empty/loading/ready/error и
после revoke/reconnect одинаково. Её наличие, label, route и tab order не
зависят от connection count, connection lifecycle или personal-token state.
Страница не ставит и не читает `setup_complete`, progress/checklist,
completion, dismiss/nag или другой onboarding state.

Direct navigation на каждый canonical child и `/help/codex` сразу открывает
соответствующий server-resolved page/current state без wizard, forced redirect
chain или требования установленного Codex. Обычный browser Back возвращает на
предыдущий route; connection detail дополнительно сохраняет явную ссылку назад
на `/settings/connections`. Единственный legacy entrypoint этого IA —
`/settings/mcp`: authenticated `GET`/`HEAD` получает уже принятый `308` на
`/settings/developer/mcp`, а signed-out request — общий route-agnostic sign-in
shell. Compatibility route не рендерит вторую navigation или отдельную копию
Advanced MCP.

Административный Site остаётся самодостаточным без Codex: account, Mind,
membership, visibility и другие route-owned actions не требуют connection,
посещения Help или завершённого setup. Никакой новый wizard, redirect,
checklist, progress, completion либо nagging state этим контрактом не
добавляется.

## Component inventory

Имена ниже — стабильные contract roles, а не требование конкретной UI
библиотеки. MD-347 может дробить внутреннюю реализацию, но сохраняет семантику
и test hooks из machine-readable profile.

| Component role | Семантика | Обязательные состояния |
|---|---|---|
| `AuthShell` | Signed-out/registration brand + one `main`; без application nav. | signed out, registration, progress, error. |
| `AppShell` | Wide rail либо compact app bar/drawer + `main`. | ready shell до deferred data. |
| `SkipLink` | Первый tabbable элемент, переводит focus на `#main-content`. | always visible on focus. |
| `BrandHome` | Mind Diary lockup/mark, route `/`, UAT соседним textual badge. | current на `/`. |
| `PrimaryNavigation` | `My Mind`, divider, Minds, Public Minds, Invitations. | один current item либо none на `/settings/**`. |
| `UtilityNavigation` | Optional Help и нижний Settings. | один current item либо none. |
| `MobileNavigation` | Menu button, modal drawer, backdrop, focus return. | closed/open/reduced-motion. |
| `PageHeader` | Один `h1`, bounded description, optional primary action. | narrow/wide; long untrusted title. |
| `ContextNavigation` | Settings children либо page-local modes. | один current child; horizontal wrap/scroll внутри region only. |
| `CompactCollection` | List/table semantics для bounded metadata, не card wall. | loading, empty, ready, retryable error. |
| `EntityRow` | Primary label, bounded secondary metadata, status and actions. | default, current/selected, unavailable, destructive action gated. |
| `StatusText` | Text + optional icon; цвет никогда не единственный signal. | neutral/success/warning/error. |
| `Disclosure` | Visibility/privacy/UAT/destructive constraint возле решения. | informative/warning/danger. |
| `Dialog` | Bounded mutation confirmation с focus trap/return. | opening, submitting, error, closed. |
| `RouteState` | Loading/empty/error/forbidden внутри текущего shell. | не заменяет navigation и `h1`. |

## Измеримый layout contract

### Breakpoints и размеры

| Token | Значение | Contract |
|---|---:|---|
| compact | `320–767px` | Top app bar + drawer; one-column content. |
| medium | `768–1023px` | Top app bar + drawer; content может использовать две bounded columns. |
| wide | `>= 1024px` | Persistent `208px` rail + content. |
| content max | `1440px` | Main inner column; центрируется в оставшейся ширине. |
| page inline padding | `16px` compact, `24px` medium, `32px` wide | Не уменьшается из-за длинного текста. |
| rail item / control hit target | минимум `44×44px` | Включая icon-only controls. |
| compact desktop row | `44–56px` | Базовая metadata row без раскрытого content. |
| compact mobile row | минимум `56px` | Label и secondary metadata могут занять две строки. |
| dialog | `min(640px, viewport - 32px)` | `max-height: calc(100dvh - 32px)`, internal scroll. |

Поддерживаемая минимальная ширина viewport — `320px`; `min-width` на `body`
не должен принудительно расширять document. Стандартная spacing scale:
`4, 8, 12, 16, 24, 32, 48px`. Новый arbitrary spacing token допускается
только с отдельным обоснованием; `20px` остаётся card radius из brand baseline,
а не spacing step.

### Плотность и строки

- Collection page по умолчанию использует rows, не большие promo cards.
- На wide viewport primary label, status, bounded metadata и primary row action
  находятся в одной row; вторичные действия уходят в one-menu disclosure.
- На compact viewport label/status идут первой строкой, metadata/actions —
  следующей; порядок чтения DOM остаётся label → status → metadata → actions.
- В row не больше двух status badges и одного постоянно видимого action.
- Long display names оборачиваются максимум на две visual lines; route,
  permission или destructive state не исчезают только из-за truncation.
- Deferred collection не меняет высоту page header и не сдвигает focus.

### Overflow budget

Для каждого acceptance viewport:

```text
document.scrollWidth <= document.clientWidth + 1px
body.scrollWidth     <= document.clientWidth + 1px
```

`main`, rail/drawer, collection, row, dialog и disclosure также не могут иметь
скрытый horizontal overflow больше `1px`. Допустимый horizontal scroll
ограничен явным `pre/code` либо contextual tab strip с доступным label; он не
расширяет document. Неподконтрольные display names, safe client names и error
copy используют `min-width: 0` и `overflow-wrap: anywhere`.

### First viewport

- `1440×900`: видны весь rail от brand до Settings, один `h1`, primary action
  (если доступен) и минимум первая complete data row либо complete empty/error
  action без вертикального scroll.
- `1024×768`: Settings остаётся видимым в rail; `h1` и начало первого route
  state/row находятся в viewport. Secondary description может обернуться.
- `390×844`: app bar, полный `h1`, primary action и начало first route
  state/row находятся в viewport; drawer первоначально закрыт.
- `320×568`: brand/UAT, `h1` и primary action или единственное auth action
  доступны без horizontal scroll; data rows могут требовать vertical scroll.
- Loading skeleton/status занимает те же page region и не вытесняет heading.

## Landmarks, headings и keyboard

- Первый tabbable control — `SkipLink`; target `#main-content` программно
  focusable.
- Registered wide shell: brand → primary nav top-to-bottom → optional Help →
  Settings → page controls. Visual и DOM order совпадают.
- Registered compact shell в закрытом состоянии не включает drawer links в
  tab order. После open focus попадает на `My Mind`; `Tab` не выходит за
  drawer, `Escape` закрывает и возвращает focus trigger.
- Page имеет ровно один `h1`. Collection/major panels получают `h2`; row labels
  не создают пропуски heading levels и обычно являются links или `h3` только
  когда row — самостоятельная section.
- Registered shell содержит один `main`, `nav aria-label="Primary"` и
  `nav aria-label="Utility"`; Settings contextual nav имеет отдельный точный
  label `Settings sections`.
- Icon glyphs decorative и имеют `aria-hidden="true"`; accessible name
  задаётся видимым text. Icon-only control получает точный `aria-label`.
- Focus indicator — минимум `3px`, контрастный к соседним цветам и не
  обрезается overflow container. Active state не заменяет focus.
- Dialog удерживает focus, `Escape` закрывает недеструктивный dialog и после
  close возвращает focus invoker. Destructive submit не происходит по Escape.
- Loading region использует bounded `aria-busy`; outcome объявляется в
  `role="status"` или `role="alert"` один раз, без live-region flooding.

## Brand, responsive и system preferences

- Используются canonical `Ink`, `Paper`, `Memory Plum`, `Living Coral`,
  `Quiet Brass`, `Quiet Sage`, `White` и текущие brand assets. `Living Coral`,
  `Quiet Brass` и `Quiet Sage` не становятся цветом мелкого текста на `Paper`.
- Fraunces остаётся для brand/коротких headings; Inter/system fallback — для
  navigation, rows и controls. Компактность не достигается уменьшением base
  text ниже `16px` или hit targets ниже `44px`.
- Status, selection, error и visibility имеют текст/форму, не только цвет.
- При `forced-colors: active` rail boundaries, current item, focus, rows,
  dialogs и disclosure используют system colors; decorative backgrounds могут
  исчезнуть без потери meaning.
- При `prefers-reduced-motion: reduce` drawer, disclosure и dialog меняют state
  без пространственной animation. Auto-playing, looping и decorative motion
  отсутствуют в любом режиме.
- Zoom `200%` при CSS viewport `>= 320px` сохраняет все actions и не создаёт
  page-level horizontal scroll.

## Placement disclosures

| Disclosure | Точное место | Ожидаемый эффект |
|---|---|---|
| `UAT` | Всегда рядом с brand в signed-out, registration и registered chrome; не только footer. | Пользователь отличает тестовую среду до любого действия. |
| Personal Mind | На `/me` сразу после heading: `Private — only you`; sharing, publication, transfer и separate delete controls отсутствуют. | Не возникает ложного ожидания sharing/publication/separate deletion. |
| `unlisted` / `public` | Непосредственно перед visibility mutation: live HEAD + immutable history, URL not secret для unlisted, возврат в private не отменяет раскрытие. | Visibility command недоступна до отображения полного предупреждения. |
| Account deletion | В account danger zone: disclosure → exact cascade → confirmation field → destructive action. | Action недоступна без fresh impact и exact confirmation; success удаляет account по accepted cascade. |
| Mind deletion | В exact Mind danger zone: disclosure → exact impact → confirmation field → destructive action. | Action недоступна без fresh impact и exact confirmation; success удаляет весь Mind и историю. |
| Connection revoke | В connection detail: readable/writable summary → revoke disclosure → confirmation/action. | Revoke fail-closed закрывает grant и убирает connection из ordinary list. |
| Advanced MCP | Protocol scopes/endpoints/token lifecycle только внутри `/settings/developer/mcp`. | Protocol details не попадают в ordinary shell или Connections list. |
| Retryable/stale state | В affected collection/panel; stale success и mutation actions убираются до read-back. | UI сначала перечитывает authoritative state и не повторяет guessed mutation. |

## Account bootstrap и account lifecycle shell

MD-365 применяет общий compact shell к полному account lifecycle, не вводя
второй onboarding wizard или отдельную password identity:

| Состояние | Видимая поверхность | Разрешённое действие | Fail-closed граница |
|---|---|---|---|
| signed out | Один route-agnostic `AuthShell` с Mind Diary/UAT и exact `/signin-with-chatgpt`. | Передать управление platform sign-in. | Нет CSRF, application navigation, account/Mind/target metadata или отражения исходного route. |
| authenticated, binding unknown | Registration shell с suggested display name, если он дан trusted platform context. | Exact `create_isolated_account` с одним idempotency key либо отдельный manual recovery handoff. | Mind Diary не создаёт password, не показывает normalized email и не relink/merge/transfer-ит прежний account автоматически. |
| bootstrap pending/error | Bounded progress либо causal error без partial account projection. | Только stable retry того же attempt, когда он безопасен. | Один submit in flight; conflict требует authoritative reload, а не нового guessed attempt. |
| registered `/me` | Обычный `AppShell`, Personal Mind и профиль. | Сразу открыть `/me`; по желанию перейти в стабильный Codex install/connect guide или Connections. | Setup guide не является обязательным wizard и не блокирует повторное открытие account. |
| registered `/settings/account` | Safe current sign-in label, profile CAS, отдельный recovery handoff и danger zone. | Rename profile, открыть Codex/Connections, загрузить fresh deletion impact. | UI не показывает email/raw IDs; identity recovery не смешивается с routine edit. |
| deletion ready | Disclosure → exact expiring cascade → exact confirmation → destructive action. | Удалить account только по fresh impact и `delete-account`. | Changed/expired impact инвалидирует confirmation; ambiguous result повторяет exact idempotent command; private content не входит в preview. |

`Current sign-in` означает только безопасную категорию `ChatGPT through OpenAI
Sites`; она не делает email authorization identity и не требует возвращать email
в session projection. На `/me` optional install/connect action ведёт в принятый
`/help/codex`, где stable Marketplace source и connection success signal уже
зафиксированы. Отсутствие установки не меняет account readiness.

Объективная приёмка этого slice объединяет существующие application tests
атомарности/idempotency и Personal Mind invariants с browser path
`signed out → registration → bootstrap → reopen/back → account settings → exact
deletion → registration`. Browser path дополнительно проверяет mobile keyboard
navigation, конфликт без stale success и отсутствие email, raw identifiers и
private fixture content в DOM.

## No-data-leak contract

- Application rail содержит только статические labels и routes. Он не делает
  eager read names/counts of private Minds, invitations или connections.
- `signed_out` и `registration_required` не получают application shell markup
  даже hidden/inert, и не содержат target-specific title/description.
- Unknown, reserved и unauthorized `/{space_handle}` имеют один safe state без
  target name, summary, membership, visibility или existence signal.
- Presentation refs допустимы только в actor-owned route/form action по
  соответствующему accepted contract; raw grant/token/binding/internal IDs,
  credentials и download URLs не появляются в visible copy, DOM attributes,
  telemetry или test snapshots.
- Untrusted name/error/client text всегда escaped и не используется как HTML,
  CSS class, route authority или accessible label без server allowlist.
- Shell не читает content API и не включает raw Memory body, query, snippet,
  file path или revision content в navigation, disclosure или analytics.

## Automated mapping для MD-347

Машинно-читаемая часть контракта находится в
[`tests/fixtures/compact-admin-ia/contract.v1.json`](../../tests/fixtures/compact-admin-ia/contract.v1.json).
MD-347 должна реализовать указанные `data-ia-*` hooks как test-only stable
semantic roles; copy и internal CSS class не становятся selectors.
Fixture содержит закрытые route/session/account/privacy/destructive matrices,
per-viewport first-visible expectations, navigation pinning, landmarks/focus,
system-preference и brand/forbidden-visual contracts. Новое состояние или
визуальный flag требует явного обновления версии контракта, а не silent
fallback в implementation test.

| Contract role | Stable hook |
|---|---|
| application shell | `data-ia-shell` |
| main content | `data-ia-main` |
| skip link | `data-ia-skip-link` |
| persistent wide rail | `data-ia-rail` |
| primary navigation | `data-ia-nav="primary"` |
| utility navigation | `data-ia-nav="utility"` |
| Settings contextual navigation | `data-ia-nav="settings"` |
| pinned Settings item | `data-ia-settings-item` |
| compact menu trigger | `data-ia-mobile-trigger` |
| compact drawer | `data-ia-mobile-drawer` |
| UAT marker | `data-ia-uat-marker` |
| page header | `data-ia-page-header` |
| page primary action | `data-ia-primary-action` |
| route loading/empty/error/forbidden state | `data-ia-route-state` |
| bounded collection | `data-ia-collection` |
| compact row | `data-ia-row` |
| adjacent disclosure | `data-ia-disclosure` |

| Acceptance ID | Объективная проверка MD-347 |
|---|---|
| `IA-SESSION-01` | На всех распознанных routes signed-out HTML одинаков по application-data regions: нет `[data-ia-shell]`, navigation, target label, CSRF. |
| `IA-SESSION-02` | Registration/progress/error states сохраняют isolated-account и stable-retry contract, не показывают registered nav. |
| `IA-NAV-01` | Wide: Personal first, Settings last lower item, route/current map совпадает с fixture. |
| `IA-NAV-02` | Compact: closed drawer links не tabbable; open → My Mind focus; Escape → trigger focus. |
| `IA-NAV-03` | Settings parent и exact context child current в разных named nav; authenticated legacy `/settings/mcp` redirect-ится, signed-out legacy request получает общий safe sign-in shell. |
| `IA-SETTINGS-01` | Lower-left Settings всегда ведёт на `/settings/account`; contextual order ровно Account → Connections → Advanced MCP, diagnostics не становятся отдельным rail item. |
| `IA-SETTINGS-02` | Stable `/help/codex` link присутствует на каждом registered shell независимо от Connections empty/loading/ready/error и connection revoke/reconnect; Help не становится Settings child. |
| `IA-SETTINGS-03` | Direct canonical routes и browser Back работают без wizard/redirect chain; единственный legacy `/settings/mcp` использует принятый session-dependent transition без второй IA. |
| `IA-GEOMETRY-01` | Fixture viewports проходят document/body/major-region overflow budget `<= 1px`. |
| `IA-GEOMETRY-02` | Rail `208px` на wide, drawer `min(320px, 88vw)`, content `<= 1440px`, hit targets `>= 44px`. |
| `IA-DENSITY-01` | Ready collections используют bounded rows: `44–56px` wide, `>=56px` compact; no card wall. |
| `IA-FIRST-01` | Геометрические assertions подтверждают first-viewport expectations на всех fixture viewports. |
| `IA-A11Y-01` | Landmarks, one `h1`, heading order, skip focus, DOM/visual order и dialog focus return. |
| `IA-A11Y-02` | Playwright projects `forcedColors: active` и `reducedMotion: reduce` сохраняют state/focus/controls. |
| `IA-BRAND-01` | Только canonical assets/tokens; no external font request; text contrast baseline не регрессирует. |
| `IA-PRIVACY-01` | Long malicious labels escaped; signed-out/unauthorized snapshots не содержат private data или raw IDs. |
| `IA-DISCLOSURE-01` | Visibility/destructive/Personal/connection disclosures находятся в required adjacent regions. |

Минимальные Playwright viewports: `320×568`, `390×844`, `768×1024`,
`1024×768`, `1440×900`. Geometry assertions являются terminal evidence;
screenshots допустимы для review, но не заменяют DOM, accessibility и overflow
checks. Existing header-shell tests должны быть обновлены на этот contract в
MD-347, а не сохранены ценой второго параллельного navigation shell.

## Вне scope

- реализация CSS/HTML/client behavior и перенос существующих страниц;
- изменение route/API/error schemas, server projections или lazy-load policy;
- новый content viewer/editor, Memory preview, search, website AI или chat;
- изменение Personal Mind invariants, visibility, memberships, ownership,
  OAuth/personal-token scopes, binding или authorization;
- новый production theme, dark mode, внешняя font delivery и illustration set;
- pixel-perfect clone Task Manager или иной сторонней поверхности.

## Связанные документы

- [Базовая айдентика](../brand.md)
- [MVP](mvp.md)
- [URL-адресация и Personal Mind](personalized-opening.md)
- [Connections, Advanced MCP и Codex Help](connection-experience.md)
