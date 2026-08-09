# Обзор Mind Diary

Статус: proposal, обновлено 2026-08-09. Product behavior первого прототипа
принято; Product Site реализован, развёрнут как single-principal UAT в OpenAI
Sites и прошёл
authenticated web/control, persistence-after-redeploy и обязательные Codex MCP
compatibility gates. Расширенные read/write/history/export сценарии остаются
следующей product-validation стадией.

## Зачем проект существует

Mind Diary даёт пользователям и их агентам управляемый доступ к живым базам
знаний: обнаружить структуру, найти релевантные concepts, проверить источники,
добавить или исправить материал, зафиксировать новую revision и экспортировать
данные в переносимом Open Knowledge Format.

В product language один `KnowledgeSpace` называется **Mind**, а одна
пользовательская `KnowledgeEntry` — **Memory**. Технические документы используют
Space/Entry там, где важна точность API, ACL или OKF semantics.

Вторая цель проекта — пройти реальный cloud-контур на OpenAI Sites: identity,
object storage, transactional metadata, MCP runtime, асинхронная индексация и
observability, сохранив переносимость для основной post-MVP infrastructure
direction на AWS. Работа с AWS — также самостоятельная учебная цель проекта.

Начальная аудитория — пользователи Codex, которые умеют работать с агентом, но
не хотят самостоятельно устанавливать skill, создавать и сопровождать OKF
bundle, следить за версией формата и собирать storage/access workflow. Local
skill precursor уже показал качественную setup friction у такой аудитории.
Sites + Codex MVP должен дешёво проверить, снимает ли managed service эту
работу. Подробная последовательность фаз и граница этого evidence зафиксированы
в [roadmap](roadmap.md).

После подтверждения базового workflow product direction включает перенос core
на AWS, productized imports, named checkpoints и собственную AI-поверхность в
web UI с backend model API calls. Эта будущая поверхность должна позволить
работать без самостоятельной настройки Codex/MCP и тем самым открыть продукт
технически неподготовленной аудитории. Она не считается проверенной успехом
первого Codex pilot.

## Ментальная модель

Mind Diary не загружает весь Mind в prompt. Агент лениво использует MCP:
получает список доступных Minds, выбирает нужный по запросу пользователя,
просматривает `index.md`, ищет, fetch-ит конкретный concept/source и только затем
изменяет точные файлы. В контекст попадают результаты вызовов, а не весь corpus.

Каноническое знание — линейная история immutable revisions. Любой успешный
write immediately создаёт новую revision и продвигает HEAD с optimistic
concurrency. Ответы агента и персонализированная подача остаются derived output,
пока агент явно не сохранит их обычным authorized commit.

## Account и Personal Mind

Система доступна только зарегистрированным authenticated пользователям. Первый
hosted UAT MVP на Sites связывает platform-authenticated ChatGPT/Sites context с
внутренним `principal_id`. Initial email binding из server-side context
нормализуется;
exact match возвращает существующий account. Неизвестный email явно создаёт
новый изолированный account без прежних прав либо запускает ручной recovery с
независимой проверкой identity; automatic relink/merge запрещён.

При регистрации Mind Diary атомарно создаёт ровно один Personal Mind. Он жёстко
связан с account: пользователь является его единственным Owner, другие
participants запрещены, visibility всегда private, ownership не передаётся,
отдельное удаление невозможно. Personal Mind открывается по `/me`, а его display
name автоматически следует за именем пользователя.

Удаление account в первом прототипе безвозвратно удаляет Personal Mind, все
ordinary Minds этого Owner вместе с их историей и memberships пользователя в
чужих Minds, удаляет его pending invitations, external identity/profile и
отзывает MCP tokens. Commits в Minds других Owners остаются с opaque non-PII
`deleted-principal` author marker. Эта простая политика принята для MVP и будет
отдельно пересмотрена перед production-grade расширением за его пределы.

## Адресуемые Minds

Обычный Mind получает:

- immutable внутренний `space_id` для ACL, revisions, jobs и storage;
- immutable в прототипе уникальный `space_handle` для URL;
- mutable и неуникальный display `name`.

Canonical URL имеет вид `https://{space-host}/{space_handle}`. При создании UI
предлагает handle из имени и позволяет исправить его до подтверждения. Router
сначала разрешает handle в `space_id`, затем проверяет доступ; URL не является
authorization identity. Canonical handle имеет фиксированную ASCII grammar и
reserved registry; после удаления неразрешимый handle навсегда retired и не
может указывать на другой Mind.

Visibility выбирает только Owner:

- `private` — доступ только принятым participants;
- `unlisted` — authenticated non-member читает по точному URL, но Mind не
  появляется в каталоге; URL не является secret;
- `public` — authenticated non-member читает и видит Mind в Public Minds
  catalog.

Anonymous доступа нет даже у public Mind. Public/unlisted reader видит live HEAD
и immutable history так же, как Reader membership. Отдельного
`published_revision` в первом прототипе нет: новый commit сразу становится
видим всем читателям, которым visibility даёт доступ. Owner UI предупреждает,
что это открывает также всю историю и что возврат в private прекращает будущий
доступ, но не отменяет уже состоявшееся раскрытие.

## Участники и роли

У active ordinary Mind всегда ровно один Owner. Создатель становится им
атомарно. Owner может передать ownership только existing active participant;
target становится Owner, прежний Owner — Admin. Non-owner может выйти сам,
Owner обязан сначала передать Mind либо удалить его.

Роли:

- `reader` — browse, search, fetch и history;
- `editor` — Reader плюс полное create/update/delete content;
- `admin` — Editor плюс управление Reader/Editor и обычными settings;
- `owner` — Admin плюс Admin role, visibility, ownership transfer и deletion.

Admin не управляет Admin/Owner. Owner не создаёт второго Owner — ownership
меняется только атомарным transfer.

Приглашать можно только зарегистрированных пользователей по exact verified
email. Invitation появляется внутри Mind Diary, роль выбирается при создании,
живёт семь дней и требует accept/reject. До acceptance это не membership.

## Content и revisions

Каждая revision материализуется как дерево UTF-8 Markdown в OKF 0.2 без
memberships, ACL, tokens и service indexes. Обычная работа идёт по отдельным
файлам; ZIP/local bundle import и upload/fetch producer-defined non-Markdown
files в первый прототип не входят. Выбранную revision можно детерминированно
экспортировать как
`OKFBundle`.

Основная write-команда принимает `expected_revision`, `idempotency_key` и набор
операций. Все операции применяются атомарно и создают ровно одну revision.
Stale writer получает conflict с current HEAD, перечитывает данные и строит
изменение заново. Automatic semantic merge в первой версии не нужен.
Idempotency key связан с principal, Mind, operation и canonical request hash:
повтор того же payload возвращает прежний result, другой payload с тем же key
получает conflict.

`index.md` изменяется специальной server-side CAS operation. `log.md`
обновляется semantic operation `add_log_entry`, которая сохраняет OKF
newest-first/date grouping; это не literal byte append. Добавление concept,
обновление index и log должно быть одним changeset.

Удаление файла меняет только новую HEAD: старые immutable revisions сохраняются.
Удаление всего Mind Owner или каскад account deletion, напротив, в прототипе
физически удаляет всю историю. Единственный сохраняемый marker — non-linkable
retired handle; target-linked audit/idempotency records и forensic deletion
receipt также не сохраняются. Это сознательный временный trade-off delete-all
прототипа.

## MCP и web control plane

Один MCP connection аутентифицирует пользователя, а не отдельный Mind. Он
может работать со всеми Minds, доступными этому principal:

- Personal Mind `/me`;
- accepted memberships;
- public catalog;
- unlisted Mind по известному exact handle.

Агент выбирает Mind по запросу пользователя, но каждый content call содержит
явный selector одного Mind. Неявный cross-Mind search или смешивание corpora не
происходит.

MCP сразу commit-ит authorized изменения; отдельного server draft, diff
approval или ручного подтверждения commit нет. Server всё равно проверяет
token, current role/visibility, scopes, HEAD CAS и idempotency на каждом
вызове. `content:write` включает read; write-only token не существует.

Первый прототип использует custom Mind-aware MCP tools. Он не заявляет
company-knowledge compatibility: стандартный `search(query)` не выбирает Mind,
а его результаты требуют user-openable content URL, которого здесь нет.
Недоверенный content не расширяет server scopes или control plane, но может
склонить модель вызвать уже разрешённый write; explicit write scope, history и
audit ограничивают, а не устраняют этот риск.

Sites отвечает за account/control plane: создание Minds, visibility,
invitations, roles, ownership, deletion, настройки и выпуск MCP tokens. Content
files через browser UI не читаются и не редактируются. Web и MCP adapters
используют общий application core/internal API; raw REST не является
пользовательской поверхностью.

Для первого прототипа MCP authentication — revocable personal bearer token,
который пользователь выпускает на сайте и передаёт клиенту через environment
variable. Token связан с principal, а не Mind; default lifetime 90 дней, secret
показывается один раз, на сервере хранится hash. OAuth 2.1 + PKCE остаётся
следующим шагом для polished plugin integration.

Пользователь оплачивает inference своего Codex/Claude client. Mind Diary в этом
пути предоставляет MCP, storage и server-side operations, но не вызывает LLM от
своего имени.

## Основной сценарий

1. Пользователь входит через Sites; account и Personal Mind создаются атомарно.
2. На сайте он создаёт ordinary Mind, принимает предложенный handle или меняет
   его и становится единственным Owner.
3. Owner/Admin приглашает зарегистрированных пользователей как Reader/Editor;
   Owner также может пригласить Admin.
4. Пользователь выпускает named MCP token и подключает Codex; Claude Code
   становится поддерживаемым client только после отдельного conformance test.
5. Агент вызывает `list_minds`, выбирает `/me` или другой доступный Mind,
   просматривает index/search/fetch.
6. Editor/Admin/Owner отправляет atomic changeset с current HEAD revision.
7. Server валидирует OKF, создаёт immutable revision, CAS-продвигает HEAD,
   пишет audit event и запускает rebuild derived index.
8. Public/unlisted readers сразу видят новую HEAD; historical selector остаётся
   привязан к exact старой revision и read-only.
9. Любой Reader/baseline Reader может получить детерминированный OKF export
   exact разрешённой revision через повторно авторизованный download URL.

## Product principles

- **Authenticated only.** Visibility расширяет доступ зарегистрированным
  пользователям, но не создаёт anonymous surface.
- **Private by default.** Новый Mind и Personal Mind начинаются private.
- **Portable by construction.** OKF 0.2 representation и deterministic export —
  основной контракт данных.
- **Progressive disclosure.** Индекс, search и fetch вместо полного corpus в
  model context.
- **Live knowledge.** Public/unlisted readers видят текущую HEAD сразу после
  успешного commit.
- **Safe concurrent writes.** Immutable revisions, idempotency и HEAD CAS без
  last-writer-wins.
- **Explicit authority.** Single Owner, принятые memberships и capability
  checks; content не управляет ACL.
- **Replaceable infrastructure.** Domain и OKF codec не зависят от Sites, AWS
  SDK, HTTP framework или search engine.

## Границы первого прототипа

В scope входят authenticated account, автоматический Personal Mind, ordinary
Minds, unique handles, roles, invitation acceptance, три visibility modes,
Public Minds catalog, user-scoped MCP, personal bearer tokens, individual-file
OKF access, immediate CAS commits, immutable history и export.

Не входят anonymous access, приглашения незарегистрированных пользователей,
email delivery, fuzzy global user search, granular file permissions, branches,
automatic semantic merge, legal retention/recovery model, billing,
organization administration и general cross-Mind synthesis.
Также отложены ZIP/local bundle import, transport producer-defined non-Markdown
files, legacy 0.1 migration, named checkpoints и company-knowledge compatibility
profile.

Imports и named checkpoints не просто исключены из MVP, а явно запланированы в
post-MVP roadmap. Support non-Markdown files/assets вероятно потребуется, но
его producer profile и первый поддерживаемый slice пока не приняты. Ограничения
этого раздела нельзя трактовать как полные границы будущего продукта; см.
[roadmap](roadmap.md).

Personalized content landing из ограниченного PersonalContext остаётся частью
product direction, но не входит в критерии первого прототипа. В этом slice
`/me` и `/{space_handle}` нужны для адресации и management; raw content и
основная работа с ним доступны через MCP. UI, consent и generation policy для
landing требуют отдельного принятого scope.

## Платформенный путь

- **Product Site:** shared application core, authenticated browser/control
  routes, Streamable HTTP MCP, D1/R2 adapters и Worker background jobs собраны
  в отдельном Sites-compatible приложении и развёрнуты как UAT.
- **Sites MVP UAT:** обязательный Codex gate пройден на двух endpoint:
  `/api/mcp/2025-11-25` для default lifecycle и `/api/mcp` для opt-in modern
  profile. Exact `/mcp` остаётся platform-reserved path и не принадлежит
  product router.
- **Primary post-MVP AWS path:** Bedrock AgentCore Runtime, S3 canonical objects,
  DynamoDB transactional metadata и optional derived OpenSearch index. Это
  будущая основная infrastructure direction и учебная цель, не текущая release
  surface.

Текущий environment contract разделяет три поверхности. `dev` — полный
локальный запуск на `localhost`; `UAT` — prod-like OpenAI Site Mind Diary и
default hosted release target; `production` — отдельная среда для живых
пользователей. Обычный delivery run публикует exact проверенный commit только в
UAT и подтверждает live web + MCP flows. Production release выполняется вне
`ship-work-release`, только после явного prompt и отдельного подтверждения;
пока production target не provisioned, такой release невозможен.

## Что означает успех

- У каждого нового account есть рабочий `/me`, который невозможно расшарить или
  удалить отдельно.
- Single-owner и transfer invariants выдерживают concurrent mutations.
- Public/private/unlisted одинаково проверяют authenticated identity и дают
  ожидаемые baseline права.
- Проверенный Codex client через один user token находит доступные Minds, читает
  exact revision и immediate commit-ит изменения с CAS; каждый дополнительный
  client, включая Claude Code, заявляется только после своего conformance test.
- Два concurrent Editors не теряют изменения: stale attempt получает conflict.
- Исторический read не смешивается с HEAD и проверяет current access.
- Export проходит OKF validation и сохраняет неизвестные fields/types.
- Будущий перенос Sites → AWS меняет adapters, но не domain, API semantics или
  OKF representation.
