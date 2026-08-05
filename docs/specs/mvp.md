# Спецификация первого прототипа

Статус: proposal, 2026-08-05. Product requirements ниже приняты; schemas,
storage и deployment ещё не реализованы.

## Цель

Доказать на production OpenAI Site end-to-end сценарий: authenticated
пользователь получает Personal Mind, создаёт и настраивает другие Minds,
подключает user-scoped MCP к Codex, читает разрешённые OKF files
и сразу commit-ит atomic changeset в выбранный Mind. Несколько Editors не
теряют данные благодаря immutable revisions и HEAD CAS.

Первый прототип — один vertical slice. Web UI является control plane, а
основная работа с content происходит через MCP.

## Обязательный scope

### Account bootstrap и Personal Mind

- Любой запрос к системе требует authenticated registered principal.
- Authenticated Sites bootstrap связывает проверенную external identity с immutable
  internal `principal_id`: exact normalized verified email возобновляет binding.
  Для неизвестного email пользователь явно создаёт новый изолированный account
  без прежних прав либо выбирает manual recovery. Автоматического relink/merge
  или переноса access нет.
- Account, Personal Mind и sole-owner binding создаются атомарно.
- Personal Mind доступен по `/me`, всегда private, имеет ровно одного
  participant-owner и не допускает invitation, transfer, publication или
  отдельного delete.
- Его display name следует за display name principal; URL handle создаётся
  сервисом и не показывается пользователю.
- Account deletion безвозвратно удаляет Personal Mind, все обычные Minds этого
  Owner вместе с историей, memberships/invitations в чужих Minds, MCP tokens,
  external binding, email и profile. Уже committed content в Minds других
  Owners остаётся и ссылается на non-PII `deleted-principal` tombstone.
- Перед подтверждением account deletion UI показывает точный cascade.

### Ordinary Mind lifecycle

- Создание требует display `name`; UI предлагает editable до create
  `space_handle` из имени.
- `space_id` immutable, `space_handle` globally unique within verified host и
  immutable в прототипе, display `name` mutable и non-unique. Canonical handle
  следует grammar и reserved registry из domain model; после удаления он
  навсегда retired и не может быть выдан другому Mind.
- Create atomically резервирует handle и создаёт sole Owner membership.
- Active ordinary Mind имеет ровно одного Owner.
- Ownership transfer разрешён только existing active participant: target
  становится Owner, source — Admin, одна transaction/audit event.
- Non-owner может выйти; Owner обязан transfer ownership или delete.
- Только Owner может немедленно и безвозвратно удалить Mind со всей историей,
  indexes, memberships и pending invitations.

### Invitations и roles

- Invite target должен быть уже зарегистрирован; lookup в baseline — exact
  verified email.
- Admin может предложить `reader`/`editor`; Owner также `admin`.
- Invitation требует accept/reject внутри Mind Diary, истекает через семь дней,
  может быть cancelled/reissued и не даёт access до acceptance.
- Email delivery, invite для незарегистрированного адресата и fuzzy global user
  search не входят в прототип.
- Роли: `reader`, `editor`, `admin`, `owner`. Editor включает read и полный
  create/update/delete content. Admin управляет Reader/Editor, Owner — Admin,
  visibility, transfer и deletion.
- Membership management доступен только через trusted Sites control plane, не
  через content MCP.

### Visibility и каталог

- Новый ordinary Mind по умолчанию `private`.
- Owner выбирает `private | unlisted | public`.
- `private`: non-member не получает access или различимую metadata.
- `unlisted`: authenticated non-member получает Reader-equivalent access по
  exact URL/handle; Mind не попадает в каталог. URL не считается secret.
- `public`: authenticated non-member получает Reader-equivalent access и видит
  Mind в global Public Minds catalog.
- Baseline reader может читать live HEAD и immutable history, но не становится
  participant и не получает content/control mutations.
- Anonymous access отсутствует во всех modes.
- Отдельного `published_revision` нет. Commit, ставший HEAD, сразу виден
  public/unlisted readers. Switch в private немедленно прекращает baseline
  access, но не отменяет уже состоявшееся раскрытие. Перед включением этих
  modes UI предупреждает, что они открывают live HEAD и всю immutable history.

### Canonical content и export

- Первый прототип принимает через changesets только UTF-8 Markdown paths и
  создаёт OKF 0.2; ZIP/local bundle import и upload/fetch producer-defined
  non-Markdown files в scope не входят.
- Проверка OKF 0.2 conformance отдельно от quality warnings.
- Неизвестные OKF types/fields сохраняются при read-modify-write и export.
- Legacy 0.1 import/migration отложен и в будущем потребует explicit policy без
  silent reinterpretation версии или lifecycle/status полей.
- Каждая committed revision содержит immutable manifest и SHA-256 entries.
- Детерминированный export выбранной revision не содержит service metadata.
- Full export доступен любому Reader/baseline Reader с `content:read`, фиксирует
  exact revision и выдаётся через short-lived download URL с повторной
  authorization; отдельные rate/size limits не являются новой ACL.

### Retrieval и history

- `list_minds` возвращает Personal Mind, accepted memberships и public catalog;
  unlisted Mind появляется при membership либо exact resolve.
- Browse root `index.md` и paths без загрузки всего bundle.
- Lexical `search` по title, description, tags, headings и body внутри явно
  выбранного Mind/revision.
- `fetch` по opaque ID, bound к `space_id + revision_id + path`.
- История разрешается по exact `revision_id` или UTC `as_of`; `as_of` выбирает
  последнюю server-committed revision не позже указанного времени. Любой
  non-HEAD selector фиксирует exact revision и read-only. Named checkpoints не
  входят в первый прототип.
- Каждый read проверяет current membership либо current baseline visibility
  grant; historical ACL не восстанавливается.
- Удаление файла из HEAD оставляет его в старых revisions; отсутствие
  historical index никогда не приводит к fallback на HEAD.

### Immediate mutation

- MCP не создаёт отдельный server draft и не требует diff/approval artifact.
- Editor/Admin/Owner вызывает одну atomic command:

```text
commit_changeset(
  mind,
  expected_revision,
  idempotency_key,
  operations[]
)
```

- Operations включают create/replace/delete file, CAS replace `index.md` и
  semantic `add_log_entry` для newest-first/date-grouped OKF `log.md`.
- Concept + index + log обновляются одним multi-file changeset.
- Успех создаёт ровно одну immutable revision, продвигает HEAD и пишет audit.
- Stale `expected_revision` возвращает `409 Conflict` и current revision без
  скрытого merge или partial commit.
- Idempotency key namespaced по principal, Mind и operation и связан с canonical
  request hash. Retry с тем же key/payload возвращает тот же result и не
  дублирует log; тот же key с другим payload получает `409 Idempotency Conflict`.
- Derived search index либо соответствует requested revision, либо сообщает
  lag/unavailable; старые chunks не выдаются как текущие.

### MCP authentication

Первый прототип использует revocable opaque personal access token:

- token выпускается в authenticated Sites UI и связан с `principal_id`, не с
  конкретным Mind;
- пользователь может иметь несколько named tokens, например `Codex on Mac`;
- secret — не менее 256 random bits, показывается один раз;
- server хранит только cryptographic hash, short prefix и metadata;
- default expiry — 90 дней; token можно отозвать в любой момент;
- scopes первого прототипа: `content:read` и `content:write`; write включает
  read, write-only token не существует;
- `Authorization: Bearer <token>` передаётся MCP client через environment
  variable, а не сохраняется в repository/config plaintext;
- role, visibility и token status проверяются на каждом request;
- token не даёт control-plane operations и не логируется;
- account deletion отзывает все tokens.

OAuth 2.1 + PKCE остаётся целевой production authentication для polished plugin
integration, но собственный authorization server не входит в первый прототип.

### Sites control plane

Sites UI поддерживает:

- account/bootstrap и `/me`;
- list/create/rename/delete ordinary Minds;
- visibility и Public Minds catalog;
- invitations, acceptance/rejection, member list и role mutations;
- ownership transfer;
- named MCP token create/list/revoke;
- management links и destructive-action warnings.

Browser UI не получает raw content file editor/API. Web и MCP adapters вызывают
общий application core/internal API. Если их позже разделят на services,
internal REST получает service authentication и не становится customer API.
Routes `/me` и `/{space_handle}` в этом slice служат адресации и management;
revision-bound personalized content landing не входит в prototype scope.

## Первая MCP-поверхность

Все Mind-specific content calls принимают explicit `mind` selector (`/me`,
handle или opaque ID, полученный от server). Scope одного call — ровно один
Mind; general implicit cross-Mind search отсутствует.

```text
list_minds(cursor?, limit?)
resolve_mind(handle)
get_mind_info(mind, revision_selector?)
browse_entries(mind, revision_selector?, path?)
search(mind, revision_selector?, query)
fetch(id)
list_revisions(mind, before?, limit?)
get_revision(mind, revision_id)
validate_mind(mind, revision_selector?)
commit_changeset(mind, expected_revision, idempotency_key, operations[])
start_export(mind, revision_selector?)
get_export_status(job_id)
```

Сигнатуры выше задают product surface. Exact REST/MCP wire schemas, result
envelopes, pagination, errors, tool annotations и Resources contract находятся
в [API specification](api.md).

Это custom Mind-aware tool profile для Codex и отдельно проверяемых clients.
Первый прототип не
заявляет OpenAI company-knowledge compatibility: стандартный read-only
`search(query)` не имеет Mind selector, а его результаты требуют
user-openable web URL, которого у content surface прототипа нет. Отдельный
стандартный `search`/`fetch` profile потребует нового design decision.

`fetch(id)` читает exact immutable revision, закодированную server-side в opaque
ID, даже если HEAD уже сдвинулась. Resource URI не содержит token:

```text
okf://spaces/{space-id}/revisions/{revision-id}/index
okf://spaces/{space-id}/revisions/{revision-id}/entries/{path}
```

Import в первом прототипе отсутствует. Все account/member/visibility/ownership/
token operations остаются вне content MCP. Tool annotations честно обозначают
mutations, но не заменяют server authorization. Недоверенный corpus может
повлиять на модель и склонить её вызвать уже разрешённый content write; этот
residual risk ограничивается explicit write scope, current ACL, history и audit,
но не считается устранённым.

## Internal application API

Логические command/query contracts разделены по назначению:

- **control:** account, Minds metadata, catalog, visibility, invitations,
  memberships, roles, transfer, deletion, tokens;
- **content:** browse/search/fetch/history/export и atomic changesets;
- **background:** index jobs, garbage collection недостижимых incomplete
  objects, audit delivery.

Физически production MVP держит Web adapter, MCP adapter и core в одном OpenAI
Site. Это сохраняет внутреннюю границу без предположения о private service
network, которого Sites пока не обещает. Если Streamable HTTP MCP не проходит
реальную compatibility gate, MVP production release остаётся незавершённым до
нового решения; автоматического fallback в portable runtime нет.

## Критерии готовности

1. Первое explicit account creation после authenticated Sites entry атомарно
   создаёт principal, `/me` и sole-owner binding; retry не создаёт второй
   Personal Mind. Unknown verified email не наследует прежний principal: explicit
   create даёт новый изолированный account, а relink/merge возможен только через
   manual recovery.
2. Personal Mind нельзя открыть чужому principal, расшарить, transfer-нуть,
   сделать public/unlisted или удалить отдельно.
3. Rename user display name обновляет Personal Mind name, не меняя `space_id`,
   history или route `/me`.
4. Ordinary Mind нельзя создать без name/canonical handle/sole Owner; occupied,
   reserved и retired handles дают одинаковый `handle_unavailable`, одинаковые
   display names разрешены.
5. Owner transfer existing participant атомарно оставляет ровно одного Owner и
   превращает source в Admin; pending invitation target отклоняется.
6. Admin управляет Reader/Editor, но не Admin/Owner; Owner управляет Admin и
   visibility. Non-owner leave не оставляет stale access.
7. Invitation зарегистрированному principal не даёт access до acceptance,
   expires через семь дней и не создаёт duplicate membership при retry.
8. Anonymous request не получает system access. Authenticated public,
   unlisted-by-exact-handle и private member получают строго описанные rights.
9. Public catalog содержит public, но не unlisted/private Minds. Переключение в
   private немедленно закрывает baseline reads; UI заранее объясняет, что
   unlisted не secret и что прежнее раскрытие HEAD/history необратимо.
10. `list_minds` одного MCP principal показывает `/me`, memberships и public
    catalog; чужой private Mind отсутствует, unlisted без exact resolve не
    обнаруживается.
11. Один token работает с несколькими allowed Minds, но каждый call явно
    выбирает один; content другого Mind не попадает в results.
12. Revoked/expired token отклоняется; server logs не содержат secret или
    private body. Retry token issuance не раскрывает прежний secret. Token с
    `content:write` также читает, token только с `content:read` не пишет.
13. Reader/baseline grant не commit-ит; Editor/Admin/Owner immediate commit-ит
    без draft/approval, если имеет `content:write`.
14. Current `expected_revision` создаёт одну new HEAD. Stale revision получает
    conflict и не пишет partial objects/revision.
15. Retry с тем же namespaced idempotency key и payload возвращает тот же
    revision ID; `add_log_entry` не дублируется. Повтор key с другим payload
    получает `409 Idempotency Conflict`.
16. Concept + `index.md` + `log.md` видны либо все в новой HEAD, либо ни один.
    `log.md` сохраняет OKF newest-first/date grouping.
17. `fetch(id)` после смены HEAD возвращает exact найденную старую revision.
18. Historical selector read-only даже для Owner и проверяет current access;
    переключение public → private отнимает history у non-member.
19. Удаление file сохраняет старую revision. Whole-Mind deletion удаляет всю
    history и target-linked records; object IDs больше не разрешаются, а
    non-linkable retired handle никогда не назначается заново. Forensic deletion
    receipt не сохраняется; UI обязан предупредить об этом до действия.
20. Account deletion каскадно удаляет Personal Mind и owned Minds, убирает
    memberships/pending invitations в остальных Minds, identity/profile и
    отзывает tokens; commits в Minds других Owners остаются с non-PII
    `deleted-principal` tombstone. UI до действия перечисляет affected Minds.
21. Changeset принимает только UTF-8 Markdown и создаёт OKF 0.2; ZIP/local
    bundle import и transport producer-defined non-Markdown files отсутствуют.
22. Unknown OKF fields/types сохраняются при read-modify-write и deterministic
    export; conformance errors отделены от quality warnings.
23. Reader и baseline Reader могут экспортировать exact разрешённую revision;
    download повторно авторизуется и не раскрывает service metadata.
24. Search/fetch ограничены exact space/revision. Missing historical index не
    подмешивает HEAD.
25. Target content не расширяет server scopes и не получает control-plane
    tools; тесты фиксируют residual prompt-injection risk разрешённых content
    writes, а не заявляют его полное устранение.
26. MCP публикует custom Mind-aware tools и не заявляет company-knowledge
    compatibility или user-openable content URLs.
27. MCP Inspector и Codex conformance tests проходят для заявленной MCP версии.
    Claude Code не блокирует первый production MVP и объявляется supported
    только после отдельной проверки своего adapter/client pair.
28. Все validators, fixtures и docs checks проходят на одном commit; никакой
    deployment не объявляется завершённым без live evidence.
29. Production release связывает exact Git SHA с одним Sites
    version/deployment и live URL; на нём проходят authenticated web/control и
    required MCP client flows. Local, preview или UI-only deployment не
    засчитывается.

## Compatibility gate для Sites и MCP

Sites production MVP считается завершённым только после live-проверки:

- authenticated Sites headers и устойчивый account binding;
- stable HTTPS Streamable HTTP `/mcp`;
- lifecycle целевого MCP profile, `tools/list` и все обязательные tools;
- Bearer token через environment configuration Codex; Claude Code проверяется
  отдельной non-blocking gate до заявления его поддержки;
- streaming/error behavior без proxy buffering;
- D1/R2 либо выбранная persistence после нового deployment;
- domain/challenge requirements реального OpenAI integration.

Если endpoint не проходит gate, production release MVP блокируется. Отдельный
portable container и AWS/AgentCore не используются без нового принятого
решения. OAuth discovery/PKCE остаётся отдельной gate polished public plugin и
не блокирует personal-token MVP.

## Не входит в первый прототип

- anonymous access и anonymous KnowledgeSite publication;
- revision-bound personalized content landing и PersonalContext generation;
- invite/onboarding незарегистрированных пользователей и email delivery;
- fuzzy/global display-name user search;
- granular path/type permissions и ingest-only human role;
- branches, moving tags, named checkpoints, automatic semantic merge и
  historical writes;
- separate drafts, diff approval и commit approval artifacts;
- ZIP/local bundle import, upload/fetch producer-defined non-Markdown files и
  legacy 0.1 migration;
- OpenAI company-knowledge `search`/`fetch` compatibility profile;
- legal retention, recovery, soft delete и production privacy erasure model;
- billing, organization administration и server-paid inference;
- mandatory vector search, crawling, OCR, transcription и Attested Computation;
- general cross-Mind search/synthesis и multiple Personal Minds;
- AWS/AgentCore deployment и отдельный production MCP container runtime;
- raw browser content viewer/editor, autonomous external actions и outbound
  push.

Этот список ограничивает только первый prototype release. Product roadmap явно
сохраняет imports и named checkpoints как запланированные post-MVP функции,
website AI — как отдельную фазу расширения аудитории, а AWS — как основную
post-MVP infrastructure direction. Модель non-Markdown files/assets остаётся
открытым решением. См. [roadmap](../roadmap.md).

## Измерения перед следующими решениями

- Assisted setup completion, time-to-first-useful search и
  time-to-first-meaningful commit.
- Retention первой и четвёртой недели отдельно для ближнего круга и внешней
  pilot cohort.
- Доля реального usage с writes, history/revert и export, а не только reads и
  демонстрационными вызовами.
- Выбор managed Mind вместо local skill/Git/manual context для конкретного
  повторяющегося workflow.
- Запросы на import, named checkpoint и non-Markdown source files из реальной
  работы, а не из feature voting.
- Готовность продолжать использование и отдельно willingness-to-pay; оплата
  Codex не считается оплатой Mind Diary.
- MCP client compatibility и auth setup completion rate.
- Search/fetch p50/p95, context size и citation success rate.
- Доля запросов, решённых lexical search без embeddings.
- Revision conflict rate и index lag.
- Public catalog discovery и unlisted exact-link usage.
- Invitation acceptance/expiry rate без хранения private content в analytics.
- Storage/query cost для 1k, 10k и 100k concepts.
- Frequency и blast radius удаления account/Mind перед проектированием
  retention/recovery.
