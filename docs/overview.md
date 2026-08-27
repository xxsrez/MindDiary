# Обзор Mind Diary

Статус: proposal, обновлено 2026-08-27. Product behavior первого прототипа
принято; Product Site реализован, развёрнут как single-principal UAT в OpenAI
Sites и прошёл
authenticated web/control, persistence-after-redeploy и обязательные Codex MCP
compatibility gates. Расширенные read/write/history/export сценарии остаются
следующей product-validation стадией. Release 0.1 возвращён к Codex-first
Markdown/OKF 0.2 workflow на небольшом детерминированном dataset. Принятые и
частично реализованные BundleFile, Brain-scale storage/import/export и universal
file-ingress capabilities сохраняются как post-MVP graph и не входят в
terminal receipt 0.1.

Release 0.2 принимает format-neutral `BundleFile` target: arbitrary regular
non-Markdown files до 256 MiB сохраняются byte-for-byte как `kind: opaque`, а
MIME/preview support не управляет admission. Текущий runtime всё ещё реализует
legacy raster/PDF/ZIP + 64 MiB baseline; MD-304 должен доставить manifest v4 и
streaming implementation до claim о поддержке 0.2.

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
на AWS, расширение принятого Markdown-only import до других profiles, named
checkpoints и собственную AI-поверхность в web UI с backend model API calls.
Эта будущая поверхность должна позволить
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

Каждая revision разрешается через единый immutable service manifest exact
files. Terminal Release 0.1 использует Markdown/OKF 0.2 content.
Producer-defined `BundleFile` Release 0.2 contract хранит любой явно выбранный
regular non-Markdown file как opaque exact bytes и не становится нормативной
OKF entity. Unknown/conflicting media получает `application/octet-stream`;
только безопасный raster subset может иметь inline preview, всё остальное —
download-only. Обычная работа идёт по отдельным files; ZIP остаётся attachment
и не означает ZIP/local bundle import. Markdown и BundleFile могут изменяться
одним atomic changeset. Полный
contract manifest, staging, downloads, limits и export находится в
[BundleFile specification](specs/bundle-files.md).

Post-MVP Brain-scale contract добавляет отдельно digested manifest v3 в R2: новая
revision переиспользует unchanged Space-scoped object digests и пишет только
delta + manifest перед одним D1 HEAD CAS. D1 остаётся authority для revision,
HEAD, reachability, accounting и reservations, но не хранит full Markdown
corpus. Markdown-only import использует resumable
`plan → reserve → stage → validate → commit → finalize` и публикует один HEAD
либо ничего. Полная модель и её local-implemented/UAT-pending status находятся в
[Sites storage/capacity/import specification](specs/sites-storage-capacity-import.md).

Markdown-only revision экспортируется прежним byte-for-byte
`MD-OKF-ZIP-1`. Post-MVP mixed revision требует explicit `MD-BUNDLE-ZIP-1`, который
сохраняет exact files и producer manifest без ACL/service identities. Уже
развёрнутый UAT остаётся Markdown-only до exact-SHA cut local candidate и
native-file client gate.

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

## Product authority после Release 0.1

Release 0.3 принимает одно однозначное разделение пользовательских полномочий.
Это целевой product contract, а не утверждение о уже изменённых routes, tool
schemas, persistence или deployment:

| Поверхность | Единственная ответственность |
|---|---|
| **Sites web control plane** | Account и profile; создание и metadata Minds; visibility, invitations, memberships, roles и ownership; Connections; выбор единственного writable Mind для connection/credential; выпуск и revoke tokens; import/export workflows и их status/download; destructive lifecycle account, Mind, connection и credential. |
| **Content MCP / Codex plugin** | Discovery разрешённых Minds; browse/search/fetch exact content; history и standalone validation; один ordinary atomic content commit в заранее разрешённый exact target. |

Read path не требует обязательного onboarding шага «прикрепить Mind»: агент
discover-ит разрешённые Minds и явно выбирает один Mind/revision в каждом read,
а server заново проверяет current access. Выбор, switch и clear writable target
выполняются только на Site; corpus, prompt и MCP tools не могут изменить этот
target. Bulk import/export и административные destructive actions также не
являются content MCP capabilities.

Standalone validation означает явную проверку выбранного Mind/revision через
content surface. Проверка staged bytes и bundle перед Site import commit —
внутренний gate единой import operation, а не второй пользовательский validate
или generic content-write surface. Финальная публикация import revision также
остаётся частью Site-owned import lifecycle, даже если application core
переиспользует те же domain validation и HEAD CAS invariants.

Replace/delete внутри exact-target content commit остаются content semantics:
они создают новую immutable revision под ACL, scope, validation, idempotency и
HEAD CAS. Они не дают MCP полномочий удалить account/Mind, изменить metadata,
visibility, участников, Connection, token, writable target или управлять
import/export lifecycle.

Exact disposition существующих REST/MCP operations принадлежит MD-337, а
точная access/binding модель, migration и wire compatibility приняты MD-339 в
[credential writable-target contract](specs/credential-write-target.md). До
их runtime-реализации нынешний runtime сохраняет проверенное historical
0.1/0.2 поведение; эта specification не заявляет его автоматическое
переключение.
Description semantics, website AI, anonymous publication, token redesign и
production/AWS изменения этим решением не принимаются.

## Release 0.1: MCP и web control plane as-built

Ниже сохранён historical contract первого прототипа. Один MCP connection
аутентифицирует пользователя, а не отдельный Mind. Он
может discover-ить все Minds, доступные этому principal:

- Personal Mind `/me`;
- accepted memberships;
- public catalog;
- unlisted Mind по известному exact handle.

Для content work connection имеет server-side binding set: `0..N` read Minds и
`0..1` active writable Mind. Agent явно attach-ит read sources и bind-ит
единственный write target; ACL и scopes остаются верхней границей authority.
Каждый content call содержит selector одного Mind, а commit также exact
immutable `write_binding_id`. Rebind атомарно делает прежний ID stale. Неявный
fallback на Personal Mind, cross-Mind search или смешивание corpora не
происходит. Полный contract — в [Mind bindings](specs/mind-bindings.md).

MCP сразу commit-ит authorized изменения; отдельного server draft, diff
approval или ручного подтверждения commit нет. Server всё равно проверяет
token, current binding, current role/visibility, scopes, HEAD CAS и idempotency
на каждом вызове. `content:write` включает read, но без active write binding не
разрешает commit; write-only token не существует.

Первый прототип использует custom Mind-aware MCP tools. Он не заявляет
company-knowledge compatibility: стандартный `search(query)` не выбирает Mind,
а его результаты требуют user-openable content URL, которого здесь нет.
Недоверенный content не расширяет server scopes или control plane, но может
склонить модель вызвать уже разрешённый write; explicit write scope, history и
audit ограничивают, а не устраняют этот риск.

В историческом контракте Release 0.1 Sites отвечает за account/control plane:
создание Minds, visibility, invitations, roles, ownership, deletion, настройки
и выпуск MCP tokens. Content files через browser UI не читаются и не
редактируются. Web и MCP adapters используют общий application core/internal
API; raw REST не является пользовательской поверхностью.

Первый прототип сохраняет revocable personal bearer token как advanced direct-
client path и поддерживает OAuth 2.1 + PKCE для Marketplace plugin. В Codex
Desktop/CLI pilot package устанавливается без private registered app, а OAuth
начинается при первом MCP use. Оба bearer profile связаны с principal, а не
Mind, и не меняют current ACL, scope, CAS или idempotency boundaries.

Основной пользовательский путь использует ordinary `Connections`: active
OAuth connection показывается через actor-owned opaque presentation ref,
пользователь видит только `Can read` и, после отдельного write step-up,
`Can add and change`. Personal tokens, endpoints и protocol diagnostics
вынесены в `Advanced MCP`; полный UX/security contract находится в
[Connections, Advanced MCP и Codex Help](specs/connection-experience.md).

Пользователь оплачивает inference своего Codex/Claude client. Mind Diary в этом
пути предоставляет MCP, storage и server-side operations, но не вызывает LLM от
своего имени.

## Целевой основной сценарий Release 0.3

1. Пользователь входит через Sites; account и Personal Mind создаются атомарно.
2. На сайте он создаёт ordinary Mind, принимает предложенный handle или меняет
   его и становится единственным Owner.
3. Owner/Admin приглашает зарегистрированных пользователей как Reader/Editor;
   Owner также может пригласить Admin.
4. Пользователь устанавливает direct MCP plugin и проходит OAuth при первом
   use либо выпускает named personal token для advanced setup; другие clients
   становятся supported только после отдельного conformance test.
5. На Site пользователь управляет Connection, readable access projection и
   выбирает единственный writable Mind; MCP не меняет этот выбор.
6. Агент discover-ит разрешённые Minds без обязательного read-attach шага,
   явно выбирает один Mind/revision и использует browse/search/fetch/history.
7. Editor/Admin/Owner отправляет atomic changeset в server-approved exact
   writable target с current HEAD revision.
8. Server валидирует OKF и producer file contract, создаёт immutable revision, CAS-продвигает HEAD,
   пишет audit event и запускает rebuild derived index.
9. Public/unlisted readers сразу видят новую HEAD; historical selector остаётся
   привязан к exact старой revision и read-only.
10. Reader/baseline Reader запускает на Site детерминированный export exact
    разрешённой revision; control plane повторно авторизует status/download.
    BundleFile exact-revision read остаётся content read, но не превращается в
    административный export workflow.

## Product principles

- **Authenticated only.** Visibility расширяет доступ зарегистрированным
  пользователям, но не создаёт anonymous доступ к Mind data, catalog, history
  или control operations. Public Sites audience может показать signed-out
  посетителю только статическую страницу входа без product data; это entry
  surface, а не anonymous product session.
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
Для terminal 0.1 также были отложены BundleFile/file ingress, Brain-scale storage/import/export,
ZIP/local bundle import, legacy 0.1 migration, named checkpoints и
company-knowledge compatibility profile. Release 0.2 теперь принимает
format-neutral storage contract; его runtime/UAT status нельзя выводить из
legacy raster/PDF/ZIP implementation или terminal Release 0.1. Extraction,
execution, rich previews/OCR и bulk/archive import остаются будущими решениями.
Ограничения
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
- Mixed revision после implementation 0.2 сохраняет DOCX, HEIC, EPUB, OPUS,
  HTML, notebook, ZIP и unknown binary exact bytes в history, authorized
  download и deterministic `MD-BUNDLE-ZIP-1`, не меняя `MD-OKF-ZIP-1`.
- Будущий перенос Sites → AWS меняет adapters, но не domain, API semantics или
  OKF representation.
