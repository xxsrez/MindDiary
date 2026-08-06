# AGENTS.md

Инструкции действуют для всего репозитория.

## Текущее состояние

- Mind Diary находится на стадии design-first bootstrap: reproducible
  engineering baseline реализован, но исполняемый сервисный vertical slice ещё
  не реализован и ни одно развёртывание не считается выполненным.
- Репозиторий содержит принятый product baseline первого прототипа,
  предложения по его реализации и проверку актуального Open Knowledge Format
  (OKF).
- Единственная целевая production platform текущего MVP — OpenAI Sites. Это
  принятое направление, а не утверждение о уже выполненном deployment.
- MVP — дешёвая Codex-first проверка managed OKF workflow. Начальная аудитория
  умеет работать с Codex, но не обязательно умеет самостоятельно устанавливать
  skills, вести bundle, следить за OKF и собирать storage/access stack.
- Ограничения MVP не являются границами конечного продукта. Принятая staged
  direction: Sites + Codex validation, затем основная AWS infrastructure и
  отдельная website AI surface для более широкой аудитории.
- Основной язык проектной документации — русский. Английские имена протоколов,
  API и полей сохраняйте, когда перевод снижает точность.

## Что прочитать перед изменениями

1. [Обзор продукта](docs/overview.md).
2. [Roadmap и стратегию проверки](docs/roadmap.md) — перед product/market
   analysis, планированием post-MVP функций или трактовкой MVP non-goals.
3. [Базовую айдентику](docs/brand.md) — перед user-facing naming, UI или copy.
4. [Доменную модель и доступ](docs/specs/domain-model.md).
5. [URL-адресацию и персонализированное открытие](docs/specs/personalized-opening.md).
6. [Архитектуру](docs/architecture.md).
7. [Спецификацию первого прототипа](docs/specs/mvp.md).
8. [REST и MCP API](docs/specs/api.md) — перед изменением protocol surface,
   backend routes, schemas или error contracts.
9. [Проверку текущего OKF](docs/reports/2026-08-05-okf-status.md).
10. [Проверку платформенных предпосылок](docs/reports/2026-08-05-platform-status.md).

Архитектурные и specification-документы пока имеют статус proposal. Принятые
product decisions отделяйте от ещё не выбранных деталей реализации; ни то ни
другое не выдавайте за реализованный либо развёрнутый сервис.

## Неизменные границы

- Этот репозиторий — реализация сервиса, а не OKF bundle. Обычным проектным
  Markdown-файлам не нужно OKF-frontmatter.
- Принятая product language: `Mind Diary` — продукт, `Mind` — пользовательское
  имя `KnowledgeSpace`, `Memory` — пользовательский umbrella term для
  `KnowledgeEntry`. Security, storage и API продолжают использовать точные
  технические имена; `Memory` не означает conversation/model/AgentCore memory.
- Каноническое техническое имя репозитория и локальной папки — `MindDiary`.
  Пользовательское имя сайта — `Mind Diary`; preferred lowercase slug для
  платформ, package names и deployment identifiers — `mind-diary`. Slug
  продукта не заменяет `space_handle` отдельного Mind.
- Живая совместная сущность сервиса называется `KnowledgeSpace`. Переносимой
  канонической формой одной её revision остаётся `OKFBundle`. В первом прототипе
  это дерево исходных UTF-8 Markdown. OKF 0.2 не задаёт нормативную `Asset`
  entity или binary manifest; будущие producer-defined `BundleFile`/
  `OpaqueAsset` отложены и требуют отдельной specification. Memberships, ACL,
  account/service metadata, idempotency keys и состояние индекса не записываются
  в OKF-frontmatter.
- Каждый ordinary Space имеет immutable внутренний `space_id`, обязательный
  immutable в прототипе `space_handle` и изменяемое display `name`. Canonical
  URL имеет вид `https://{space-host}/{space_handle}`; handle уникален внутри
  verified host namespace и разрешается в `space_id` до authorization или
  object read. Personal Mind использует `/me` и скрытый service-managed handle.
- `space_handle` — внешний URL identifier, но не authorization identity.
  Durable records, ACL, revisions, jobs и audit используют `space_id`. Rename
  display name, смена HEAD или visibility не меняют URL; будущий rename
  handle требует tombstone и permanent redirect.
- Доступ к прототипу требует зарегистрированного authenticated principal;
  anonymous access отсутствует даже у `public` Mind. После разрешения URL
  server проверяет visibility и authorization до чтения metadata или objects.
- Account bootstrap атомарно создаёт principal, его единственный Personal Mind
  и owner membership. Personal Mind — обычный private `KnowledgeSpace` по
  storage schema, но с жёсткими service invariants: один participant-owner,
  route `/me`, service-managed handle, отсутствие transfer, publication и
  отдельного delete. Display name следует за именем principal.
- Initial Sites binding использует normalized verified email, но authorization
  опирается на immutable `principal_id`. Exact match возвращает existing account;
  unknown email явно создаёт новый isolated account без прежних прав либо идёт
  в manual identity recovery. Automatic relink/merge/access transfer запрещён.
- Обычные Minds поддерживают `private`, `unlisted` и `public`. Authenticated
  non-member получает reader-equivalent доступ к live HEAD и истории в
  `unlisted` по точному URL, а в `public` также через каталог. Это baseline
  visibility grant, не membership.
- Personal, group и community-wiki — сценарии одного Space, а не значения
  фиксированного `space_type`. Будущая anonymous web-publication остаётся
  отдельной моделью и не заменяет visibility прототипа.
- Первый прототип создаёт и изменяет только UTF-8 Markdown content в OKF 0.2.
  ZIP/local bundle import и non-Markdown file upload/fetch не входят в scope.
  Productized imports явно планируются post-MVP; exact formats и security
  boundary ещё не приняты. Codec сохраняет неизвестные OKF types/fields при
  чтении, изменении и export; будущий legacy 0.1 import потребует отдельной
  migration policy без silent version/status reinterpretation.
- Полнотекстовые, векторные и графовые индексы всегда производны и должны
  перестраиваться из выбранной канонической ревизии.
- Изменение создаёт новую immutable revision. Продвижение HEAD требует
  `expected_revision` или эквивалентной optimistic-concurrency проверки.
- Каждая успешно committed `SpaceRevision` остаётся доступной через историю по
  точному ID или UTC-времени commit. Checkpoints/tags не входят в первый
  прототип и не подменяют immutable revision IDs. Named checkpoints явно
  планируются post-MVP; их naming, mutability и API требуют отдельной
  specification.
- Исторический selector одного Mind разрешается в точный `revision_id` и всегда
  read-only, даже для Owner. Каждый historical read проверяет текущий доступ:
  membership либо актуальный baseline visibility grant; старые ACL не
  «воскрешаются».
- Первый прототип не поддерживает branches, moving tags, merge или запись поверх
  исторической revision. Удаление content из HEAD не стирает его из уже
  committed истории. Whole-Mind и account deletion в прототипе, напротив,
  немедленно удаляют всю историю; production retention/privacy model ещё не
  спроектирована.
- MCP content mutation сразу создаёт immutable revision и продвигает HEAD.
  Отдельных draft, diff confirmation и approval artifact в прототипе нет;
  безопасность обеспечивают authentication, current role, token scopes,
  idempotency, audit и HEAD CAS. MCP tool annotations остаются только UX-сигналом.
- `verified` и другие OKF trust signals не являются механизмом авторизации.
  Principal, выбранный Mind и права выводятся только из проверенного identity
  context и актуального server-side состояния.
- MCP делает Space лениво доступным через search/fetch/resources; он не
  помещает весь corpus в контекст модели автоматически.
- Один MCP connection аутентифицирует principal и даёт ему операции над всеми
  доступными Minds: `/me`, memberships, каталогом `public` и `unlisted` по
  точному handle. Каждая content operation явно выбирает один Mind и одну
  revision; неявное смешивание corpus нескольких Minds запрещено.
- Первый прототип публикует custom Mind-aware MCP tools и не заявляет OpenAI
  company-knowledge compatibility. Standard `search(query)` не имеет Mind
  selector, а `okf://` identifiers не являются user-openable content URLs.
- Роли Space — `reader`, `editor`, `admin`, `owner`. `editor` включает чтение и
  полный create/update/delete content. У active ordinary Mind ровно один Owner.
  Создатель становится им атомарно; transfer возможен только existing active
  participant, после чего прежний Owner становится Admin.
- Приглашать можно только зарегистрированного principal по exact verified
  email. Pending invitation требует acceptance, истекает через семь дней, не
  является membership и не может получить ownership. Admin приглашает только
  Reader/Editor, Owner также Admin.
- Первый MCP auth использует revocable named opaque bearer tokens principal:
  secret не менее 256 random bits показывается один раз, хранится только hash,
  default expiry 90 дней, scopes `content:read`/`content:write`.
  `content:write` всегда включает `content:read`; write-only token запрещён.
  Token не даёт control-plane capabilities и не привязан к одному Mind.
- Membership management остаётся в trusted Sites control plane и не
  публикуется рядом с corpus tools в content MCP.
- В прототипе `public`/`unlisted` открывают authenticated non-members весь live
  HEAD и immutable history с правами Reader; отдельного `published_revision`
  нет. Commit Editor немедленно виден этим читателям. Будущий `KnowledgeSite`
  и anonymous publication требуют новой спецификации.
- `unlisted` означает только отсутствие в каталоге, а не секретность URL.
  `space_handle` человекочитаем и не является access token; настоящая
  share-by-link capability потребует отдельного случайного секрета.
- Профиль посетителя, история разговора и generated answers не попадают в
  target `OKFBundle` автоматически. Target content считается недоверенным и не
  может формировать запросы к Personal Mind, выбирать personal fields или
  расширять scopes. Любая композиция нескольких Minds требует явного trusted
  use case и отдельной проверки доступа к каждому из них.
- После Codex-first validation product direction включает собственную AI
  surface в web UI: backend вызывает model APIs, а пользователю не требуется
  самостоятельно настраивать Codex/MCP. Provider, billing, consent, retrieval,
  citations и write safety пока не приняты и не входят в MVP.
- Доменное ядро и OKF codec не импортируют AWS SDK, Sites bindings, HTTP
  framework или конкретный поисковый движок. Инфраструктура подключается через
  узкие порты и адаптеры.
- Whole-Mind deletion удаляет content/history и target-linked service records;
  остаётся только non-linkable retired-handle marker. Account deletion удаляет
  external identity/profile, но commits в Minds других Owners сохраняют opaque
  non-PII `deleted-principal` tombstone.
- Не исполняйте `Attested Computation` автоматически до отдельной спецификации
  sandbox, attester ABI, receipts и threat model.

## Платформенные правила

- Текущая стабильная целевая версия MCP — `2026-07-28`. Изолированный
  compatibility profile `2025-11-25` сохраняйте только для реально
  проверенного клиента, который ещё требует legacy initialize/session flow.
  Не смешивайте lifecycle двух версий и не заявляйте поддержку без conformance
  tests на конкретном adapter/client pair.
- OpenAI Sites — единственный production target MVP для web/admin UI,
  application core, persistence и Streamable HTTP MCP. Размещение MCP в Sites
  остаётся непроверенной platform capability до реального compatibility gate;
  провал gate блокирует production release, а не разрешает молчаливый fallback
  в отдельный container или AWS.
- AWS, включая Bedrock AgentCore Runtime, S3, DynamoDB и OpenSearch, — основная
  planned infrastructure direction и самостоятельная учебная цель после
  подтверждения MVP. Это не текущая release surface и не автоматический
  fallback. Domain core и adapters проектируйте переносимыми и без AWS SDK в
  доменном ядре.
- Большой export не передавайте внутри JSON-RPC: используйте object storage и
  короткоживущий download URL. Upload intents, archive import и non-Markdown
  file transport не проектируйте до отдельного решения; вероятная будущая
  поддержка не означает уже принятого file profile.

## Релизный контракт

- Фразы «зарелизить на продакшн», «зарелизить на прод» и `release to
  production` без дополнительного уточнения означают: собрать и проверить
  exact commit, опубликовать его в production OpenAI Site Mind Diary и
  подтвердить live-состояние этого Site.
- Production release MVP охватывает весь обязательный vertical slice на Sites:
  authenticated web/control UI, persistence и доступный клиентам content MCP.
  Обязательный client gate первого release — Codex. Claude Code и другие clients
  не блокируют MVP и не называются supported до отдельного conformance test.
  Успех только UI или локального MCP не является production release.
- До появления проверенного Sites project/config deployment не считается
  существующим. После появления release evidence должен связывать exact Git
  SHA, Sites project/version/deployment, live URL и smoke web + MCP flows.
- Не deploy-те текущий MVP в AWS, AgentCore или отдельный portable runtime без
  нового явного решения пользователя. AWS portability — архитектурное
  ограничение, а не текущая production surface.

## Документация и качество

- Следуйте ленивой структуре `project-docs`: не создавайте пустые каталоги или
  документы-заглушки, каждый новый документ связывайте с `docs/README.md`.
- Явно различайте проверенный внешний факт, требование пользователя,
  архитектурное предложение, гипотезу и открытый вопрос.
- При product/market analysis оценивайте отдельно Codex-first wedge, будущий
  website AI и engineering/learning value. Не считайте MVP exclusions отказом
  от roadmap и не переносите сигнал assisted ближнего круга на массовый рынок.
- Для изменений поведения сначала обновляйте спецификацию; значимые принятые
  решения фиксируйте отдельным ADR только после их принятия.
- Не заявляйте conformance, сборку, тесты, deployment или live-интеграцию без
  проверки на текущем commit.
- После изменений документации запускайте project-docs validator и
  `git diff --check`.
- Канонический toolchain baseline: Node.js `>=22.13.0`, npm lockfile и
  TypeScript project references. После `npm ci` используйте `npm run build`,
  `npm run test:unit`, `npm run test:integration`,
  `npm run test:conformance`, `npm run check:docs` и полный `npm run check`.
  Не называйте эти contract tests live Sites/MCP compatibility.
- После появления OKF fixtures валидируйте весь выбранный bundle, а не только
  `wiki/`, официальным или эквивалентным строгим validator.

## Безопасность

- Spaces по умолчанию приватны. Не логируйте содержимое приватных concepts,
  chunks, source content, access tokens или download URLs.
- Переключать `private | unlisted | public` может только Owner. Для `public` и
  `unlisted` live HEAD и вся immutable history по определению сразу читаемы
  authenticated non-members; интерфейс обязан явно предупреждать Owner и
  writers об обоих эффектах. Возврат в `private` не отменяет уже состоявшееся
  раскрытие.
- Любой read/search/write проверяет authenticated principal и доступ к Mind до
  обращения к каноническому объекту или производному индексу; MCP-вызов также
  проверяет token status и scopes.
- Не используйте клиентские `principal_id`, `space_id` или role как источник
  истины и не передавайте входящий user token downstream-сервисам.
- Содержимое базы считается недоверенным input, а не server authority. Оно не
  может само расширить scopes или получить control-plane capability, но может
  попытаться через prompt injection склонить модель к разрешённому content
  write. Immediate commits сознательно принимают этот остаточный риск; его
  ограничивают explicit write scope, current ACL, immutable history, audit и
  отсутствие control-plane tools в content MCP.
- Web UI не рендерит недоверенный HTML или script без безопасной изоляции.
