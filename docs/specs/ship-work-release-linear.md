# Linear adapter для `ship-work-release`

Статус: historical, superseded by
[`ship-work-release-task-manager-srez.md`](ship-work-release-task-manager-srez.md),
2026-08-23.

Этот документ сохранён для исторической трассировки старого rollout. Он не
является текущим adapter, project profile, scope selector или source of truth
для Mind Diary; старый Project ID из него использовать запрещено.

Документ задаёт только Linear-specific mapping общего
[`task-management adapter`](ship-work-release-task-manager.md). Универсальные
execution, pause, lane и release rules определяет
[`ship-work-release`](ship-work-release.md).

Runtime загружает Linear-specific reference только при
`task_management.adapter=linear`. Accepted contract остаётся в этом документе;
packaged reference является его bounded operational projection, а не второй
нормой рядом.

## 1. Adapter identity

```yaml
adapter: linear
contract: ship-work-release/task-manager-adapter/v1
specification: docs/specs/ship-work-release-linear.md
runtime_reference: references/task-manager-linear.md
```

Stable refs используют:

- `provider_instance_id` — immutable Linear workspace/organization ID;
- `collection_id` — immutable Linear project UUID;
- provider-scope `scope_id` — immutable milestone UUID;
- `item_id` — immutable issue UUID;
- `human_key` — display-only issue identifier вроде `AND-123`;
- `human name` и URL — только navigation metadata.

Project delivery profile обязан задавать exact project UUID. Display name
`Mind Diary`, project slug, URL или результат search не считаются collection
identity. Adapter сначала exact-read project по UUID и сверяет его provider
instance; mismatch блокирует run.

## 2. Scope selectors

Linear поддерживает три input forms:

```text
profile default: current_project_milestone | configured_milestone | configured_item_set
explicit:        scope=milestone:<milestone-uuid>
explicit:        scope=items:<issue-uuid>,<issue-uuid>,... [scope-anchor=<issue-uuid>]
```

Это syntactic forms selector envelope
`ship-work-release/task-manager-selector/v1`:

| Input | Normalized selector |
|---|---|
| profile default | `kind=profile_default`, один declared selector ID и parameters |
| `milestone:<id>` | `kind=provider_scope`, exact milestone UUID |
| `items:<ids>` | `kind=explicit_item_set`, exact issue UUID set |

Rules:

- collection всегда берётся как exact project UUID из profile либо exact
  user override, если такой override разрешён profile;
- milestone name и issue identifiers вроде `AND-123` не принимаются вместо
  UUID в authority selector;
- duplicate/empty IDs и смешение milestone/items дают `SELECTOR_INVALID`;
- все explicit issues должны exact-read-иться и принадлежать exact project;
- item-set canonicalizes UUIDs как отсортированное множество и получает
  deterministic digest scope ID;
- optional `scope-anchor=<uuid>` заполняет
  `projection_anchor_item_id`; anchor exact-read-ится и обязан принадлежать
  exact project, но не становится scope member автоматически;
- relation boundary items могут находиться вне project, но не становятся
  selected scope members;
- cohort, batch и UAT cut не создают Linear milestones или issues.

Linear profile defaults имеют exact semantics:

- `configured_milestone` требует exact milestone UUID parameter и разрешается
  как `milestone:<uuid>`;
- `configured_item_set` требует bounded exact issue UUIDs и разрешается как
  `items:<uuid,...>`;
- `current_project_milestone` получает все milestones exact project с полным
  pagination и строит полный snapshot issues каждого candidate. Milestone
  считается terminal только когда все его issues имеют disposition `accepted`
  либо authorized `excluded`; один только target date или UI progress terminal
  state не доказывает. Ровно один nonterminal candidate преобразуется в
  `scope=milestone:<exact-id>`. Ноль или несколько дают
  `IDENTITY_AMBIGUOUS`; adapter не выбирает milestone по имени, recency или
  старому receipt.

Проект с параллельными nonterminal milestones использует exact
`configured_milestone`/`configured_item_set` либо explicit invocation; он не
может объявлять ambiguous `current_project_milestone` своим default.

## 3. Linear entity mapping

| Core concept | Linear source |
|---|---|
| work collection | exact project UUID |
| provider work scope | exact project milestone UUID |
| explicit work scope | deterministic set exact issue UUIDs |
| work item | issue UUID |
| human key | issue identifier, display-only |
| workflow owner | exact issue team UUID |
| parent closure | parent/sub-issue relation |
| dependency edge | `blocks` / `blocked by` relation |
| acceptance source | issue description plus exact linked accepted repository contracts |
| item lifecycle projection | exact issue status ID |
| item progress projection | bounded issue comment with effect marker |
| scope fact projection | `linear/project-status-update/v1` либо `linear/issue-anchor-comment/v1` |

Labels, assignee, priority, estimate и cycle входят в snapshot/fingerprint
только если project profile или accepted routing contract использует их.
Otherwise это display/routing metadata без authority.

## 4. Capability resolution

Adapter объявляет capability exact authenticated principal и exact project во
время preflight. Linear mapping поддерживает следующие modes, но не заявляет
их доступными без live check:

| Capability | Linear mapping |
|---|---|
| exact entity read | read по project/milestone/issue UUID |
| bounded full snapshot | полное cursor pagination всех обязательных connections |
| relation closure | exact reads related issues после полного чтения relation IDs |
| item status projection | mutation exact issue status ID при write permission |
| item progress projection | bounded issue comment при write permission |
| scope facts | exact project update либо configured exact issue anchor |
| expected-old | exact reread и compare непосредственно перед mutation; не atomic CAS |
| idempotency | provider-native key, если реально поддерживается callable surface, иначе stable adapter marker + reconcile |
| reconcile | exact target state comparison и exact effect marker search |
| provider revision | `updatedAt` вместе с field/relation fingerprint |
| permission preflight | доступный Linear permission/operation probe; coarse result так и маркируется |

Если callable Linear surface не позволяет exact-read/reconcile конкретный
write channel, capability для него равна `unavailable`. Наличие общего Linear
access или успешного search не доказывает mutation capability.

Linear status mutation не имеет assumed CAS. Mode
`compare_immediately_before_write` всегда сохраняется в capability receipt;
adapter rereads target до и после mutation, а concurrent drift превращает
result в conflict/ambiguous outcome, не в успешный projection.

## 5. Status normalization

Adapter использует Linear status `type` и exact status ID. Localized/custom
display name не меняет semantics.

| Linear status type | Lifecycle | Readiness | Effective status |
|---|---|---|---|
| `backlog` | `backlog` | `not_applicable` | `backlog` |
| `unstarted` | `ready` | derived | `ready` либо `blocked` |
| `started` | `active` | derived для diagnostics | `active` |
| `completed` | `done` | `not_applicable` | `done` |
| `canceled` | `canceled` | `not_applicable` | `canceled` |
| `duplicate` | `canceled` | `not_applicable` | `canceled` |

Custom status type вне этой таблицы даёт `VALIDATION_ERROR` до mutation, пока
adapter contract явно не расширен.

Linear workflow statuses принадлежат team, а не project. Snapshot поэтому
хранит exact `team_id` каждого selected/boundary issue и полный status catalog
каждой затронутой team. Desired lifecycle никогда не превращается в status по
display name. Projection request содержит exact target status ID; helper
resolution по normalized class допускается только детерминированно внутри
exact team catalog и сохраняется в plan:

- `active` — declared profile status ID либо status type `started` с наименьшей
  provider `position`;
- `done` — declared profile status ID либо status type `completed` с наименьшей
  provider `position`;
- `ready`/`backlog` — только declared exact target ID, если такой reverse
  transition вообще разрешён project contract;
- `canceled` — только exact target ID из authorized exclusion operation;
- ноль или несколько одинаково ranked targets дают `IDENTITY_AMBIGUOUS`.

Resolved status ID, team ID и status-catalog fingerprint входят в
expected-old plan. Изменение workflow catalog инвалидирует plan.

### 5.1 Derived `blocked` и round-trip

Linear не обязан иметь remote status `Blocked`. Для issue с type `unstarted`
adapter:

1. сохраняет provider lifecycle `ready` и exact remote status ID;
2. вычисляет readiness из acceptance, `blocked by`, обязательных external
   dependencies, hierarchy closure и permissions;
3. возвращает `effective_status=blocked` с exact `blocker_refs` либо
   `effective_status=ready`;
4. не меняет remote status только ради representation derived blocker.

Projection desired `blocked` проверяет, что remote status остаётся expected
`unstarted`, а blocker relations/fingerprint соответствуют intent. При
declared item-progress capability adapter может записать один bounded blocker
update, но он не становится источником blocked state. После снятия relations
следующий authoritative snapshot автоматически возвращает `ready`; отдельный
status write для «unblock» не нужен.

Для issue с lifecycle `active` новый blocker отражается как
`readiness=blocked`, но compact effective status остаётся `active`, чтобы не
скрывать уже начатую работу. Ready frontier такую issue не возвращает; status
card отдельно показывает active-with-blocker count.

### 5.2 `done`, `canceled` и exclusion

Linear `completed` нормализуется в lifecycle `done`, но
`disposition=accepted` требует exact acceptance, repository evidence и
applicable release evidence. Completed issue без этих доказательств имеет
`disposition=incoherent` и блокирует successful scope completion.

Linear `canceled` и reserved `duplicate` по умолчанию имеют
`disposition=unsuccessful`. Они становятся admissible terminal
`disposition=excluded` только при explicit
`ExclusionDecision` из provider-neutral contract:

- authority — пользователь текущего run либо accepted scope contract;
- exact issue UUID и fingerprint;
- bounded reason;
- immutable receipt reference.

Reserved status type `duplicate`, Linear `duplicateOf` relation, label/comment,
cancel actor или похожий issue сами по себе не являются exclusion authority.
Exact duplicate target включается в boundary snapshot, но scope закрывается
только после explicit exclusion decision и reconciliation target disposition.
Adapter никогда не закрывает scope только потому, что все remaining issues
имеют status type `canceled` либо `duplicate`.

## 6. Snapshot и completeness proof

Один Linear snapshot содержит:

- exact workspace/organization и project UUID;
- exact milestone UUID либо canonical explicit item-set digest;
- issue UUID, identifier, title и `updatedAt`;
- exact issue team UUID;
- exact status ID/type/name и status catalog;
- description и exact repository acceptance refs;
- parent/sub-issue IDs;
- `blocks`/`blocked by` relation IDs;
- assignee, labels, project/milestone binding и другие declared routing fields;
- exact permissions/capabilities;
- projection homes;
- boundary issue states, необходимые для closure;
- pagination/completeness proof и normalized fingerprint.

Adapter обязан полностью исчерпать pagination отдельно для:

1. project milestones при default resolution;
2. scope issues;
3. issue relations;
4. sub-issues/children;
5. evidence comments или project updates при reconcile;
6. status catalog каждой затронутой team, если callable surface его page-ит.

Для каждой connection receipt хранит query fingerprint, page count, record
count, final `hasNextPage=false`/terminal cursor и provider total при наличии.
Exact issue reread по UUID следует после discovery/list. Missing terminal cursor,
provider cap, permission-filtered relation или total mismatch дают
`SNAPSHOT_INCOMPLETE`; truncated search results не являются authority.

Fingerprint включает project/milestone binding, status ID/type, description
acceptance hash, sorted relation IDs/states, parent/children, declared routing
fields и projection-home ref. Изменение любого authoritative field после claim
инвалидирует publication authority и требует re-plan либо fenced preservation
готовых bytes.

## 7. Closure за пределами scope

Linear relation nodes вне selected milestone/item set exact-read-ятся как
boundary nodes и не добавляются в product scope.

- external `blocked by` issue блокирует selected issue, пока не имеет
  `accepted` либо authorized `excluded` disposition;
- external issue, которое selected issue блокирует, не блокирует completion
  selected issue;
- parent вне scope не получает automatic status change;
- direct child вне scope считается completion-required для selected parent,
  если issue description/accepted project contract явно не снимает это
  требование;
- selected child может завершиться независимо от external parent, но adapter
  не закрывает parent без отдельной authority;
- unknown/deleted/inaccessible relation target даёт
  `DEPENDENCY_UNRESOLVED`, а не assumed completion;
- boundary issue status никогда не меняется этим run без отдельного exact
  scope selector/authority.

Parent issue становится `accepted` только после собственного acceptance и
closure всех completion-required children. Child cancellation без explicit
exclusion decision closure не удовлетворяет.

## 8. Ready frontier

Linear ready frontier состоит только из exact selected issues, у которых:

- provider lifecycle `ready`;
- acceptance source known и unambiguous;
- все blocking dependencies accepted/excluded;
- required parent/child preconditions satisfied;
- issue остаётся в exact project и scope;
- declared permissions/capabilities доступны;
- disposition `pending`.

Deterministic ordering:

1. accepted explicit priority/routing rank, если он объявлен profile;
2. dependency topological order;
3. immutable issue UUID как final tie-breaker.

Issue identifier или API response order не используется как tie-breaker.
Cycle в dependency graph возвращает blockers для всех затронутых items и
`DEPENDENCY_UNRESOLVED` diagnostic; adapter не разрывает cycle самостоятельно.

## 9. Projection homes

### 9.1 Item facts

- lifecycle home — exact issue `status_id`;
- progress/evidence home — bounded comment exact issue;
- comment содержит stable non-secret effect marker и receipt link/summary;
- raw logs, retries, polling, tokens и private source content не публикуются.

Derived blocker сохраняется в relations/fingerprint. Optional blocker comment
является только human projection и не заменяет relation authority.

### 9.2 Scope facts

Resolution выбирает ровно один scope fact home и сохраняет его в scope
fingerprint:

1. `native_scope`, capability ID `linear/project-status-update/v1`: exact Linear
   project status update, если callable integration
   поддерживает stable update ID, exact reread, write и reconcile; scope marker
   содержит exact milestone UUID либо item-set digest;
2. `designated_anchor`, capability ID
   `linear/issue-anchor-comment/v1`: exact issue UUID из
   `projection_anchor_item_id` либо заранее declared profile configuration, с
   одним bounded scope receipt comment;
3. `unavailable`: если ни один exact reconciliable channel не доступен.

Adapter не выбирает произвольный issue во время write и не размазывает scope
facts по всем issues. `unavailable` блокирует final task-manager scope
projection и scope-complete claim, но не подменяет canonical receipts.

Scope projection содержит только durable facts: exact candidate SHA, gate/CI,
UAT cut/evidence refs, unresolved acceptance и terminal rationale. Cohort,
polling heartbeat и lane internals в Linear не проецируются.

## 10. Linear write protocol

Только coordinator имеет Linear write authority. Worker, scout и reviewer
используют read-only snapshot.

Каждый effect intent содержит:

- exact issue/project-update/anchor target ref;
- expected `updatedAt`, exact status ID и authoritative fingerprint;
- desired status ID либо bounded update body;
- stable `effect_id`/idempotency key;
- source receipt refs;
- selected projection home.

Перед write adapter exact-rereads target и relevant relations. Expected-old
mismatch возвращает `conflict_expected_old` без mutation.

Linear write outcomes следуют общему contract:

- `applied` — post-read доказал exact desired state;
- `already_applied` — exact desired state либо exact effect marker уже
  присутствует и authoritative fields не drifted;
- `conflict_expected_old` — target changed, нужен fresh snapshot/re-plan;
- `rejected` — Linear validation/permission отказ;
- `failed_no_effect` — отсутствие mutation доказано;
- `indeterminate` — timeout/lost acknowledgement, нужен reconcile.

Status transition является state-convergent effect: при reconcile unchanged
material fingerprint и exact desired status ID могут доказать
`applied_exact`, даже если отдельного comment marker нет. Любой competing
acceptance/relation/status drift даёт `conflict_other_effect`, не adoption.

Comment/project-update effect использует exact non-secret marker. Reconcile
полностью page-ит соответствующий update channel:

- один exact marker + desired bounded content → `applied_exact`;
- old state и отсутствие marker → `not_applied`;
- competing state/update → `conflict_other_effect`;
- duplicate markers, incomplete pagination или неразличимый result →
  `ambiguous`;
- невозможность exact reread → `unavailable`.

После `ambiguous` или `unavailable` blind replay запрещён. Technical retry,
polling и lane heartbeat не создают новые Linear comments. Один meaningful
transition создаёт не более одного bounded update.

## 11. Scope completion и projection

Успешный Linear scope требует:

- все selected issues имеют disposition `accepted` либо authorized `excluded`;
- ни один canceled issue не принят как успех без exclusion receipt;
- dependency и parent/child closure reconciled, включая boundary nodes;
- authoritative final snapshot полон;
- exact candidate/UAT evidence связан с exact scope projection home;
- final projection reread/reconciled;
- remote milestone state сам по себе не считается release artifact.

Milestone можно закрывать/обновлять только если exact project profile
разрешает такой projection, expected-old совпадает и scope acceptance уже
удовлетворён. Adapter не выводит product completion из milestone date/name.

## 12. User-visible status

Milestone scope card показывает:

- `adapter=linear`, exact project UUID/name;
- `scope_kind=provider_scope`, exact milestone UUID/name;
- total selected issues;
- lifecycle counts и effective ready/blocked counts;
- accepted/excluded/unsuccessful/incoherent dispositions;
- external boundary blockers;
- current item/lane, batch, candidate, UAT cut и terminal claim;
- snapshot age/completeness и scope projection capability/home.

Explicit issue-set card вместо вымышленного milestone показывает:

- `scope_kind=explicit_item_set`;
- deterministic scope digest;
- item count;
- bounded human-key list и exact UUIDs в verbose form;
- те же status/disposition/boundary/evidence fields.

Временный `/side` task по plain-text запросу `status` выполняет fresh bounded
Linear read, но не меняет status, comments, project updates, claims или
coordinator state. Отдельной operator command для этого нет; slash-command
`/status` также имеет другую семантику.

## 13. Error mapping

Linear errors нормализуются в common taxonomy:

| Linear condition | Normalized code |
|---|---|
| invalid/unknown UUID selector | `SELECTOR_INVALID` либо `ENTITY_NOT_FOUND` |
| project/milestone/name ambiguity | `IDENTITY_AMBIGUOUS` |
| incomplete `pageInfo`/relation visibility | `SNAPSHOT_INCOMPLETE` |
| unauthorized read/write | `PERMISSION_DENIED` |
| missing exact scope projection target | `PROJECTION_HOME_MISSING` |
| `updatedAt`/status/relation drift | `EXPECTED_OLD_CONFLICT` либо `SNAPSHOT_DRIFT` |
| GraphQL validation rejection | `VALIDATION_ERROR` |
| rate limit with provider retry hint | `PROVIDER_RATE_LIMITED` |
| timeout after request dispatch | `EFFECT_INDETERMINATE` |
| incomplete/duplicate-marker reconcile | `RECONCILE_AMBIGUOUS` |
| unavailable Linear API/tool | `PROVIDER_UNAVAILABLE` |

Provider response body сохраняется только как bounded redacted diagnostic
artifact. Error message не содержит auth headers, tokens, private issue content
или unrestricted URLs.

## 14. Cross-provider mapping

Если Linear является source или target cross-provider mapping между
task-management systems, mapping использует только exact
workspace/project/milestone/issue UUID refs и fingerprints. Display project
name, milestone name и issue identifier не являются identity. Authority на
target refs принимается только по explicit mapping receipt и reconciliation из
provider-neutral contract; unmapped/ambiguous issues блокируют transfer.
Run/cohort/lane state и состояние прежнего skill этот mapping не переносит.

## 15. Packaging и conformance

`SKILL.md` выбирает adapter по exact project profile, загружает общий adapter
contract и `references/task-manager-linear.md`. Packaged reference обязан быть
проверяемо производным от этого accepted document и не вводить отдельную норму
для status types, selectors, pagination, projection homes или reconcile
behavior.

Linear adapter tests покрывают дополнительно к common conformance:

1. project UUID identity при совпадающих display names;
2. `current_project_milestone` с 0/1/2 candidates и configured exact defaults;
3. exact `milestone:<uuid>` и `items:<uuid,...>` selectors, включая optional
   exact scope anchor;
4. issue/relation/sub-issue pagination;
5. derived blocked → ready round-trip без remote Blocked status;
6. active-with-blocker diagnostics;
7. completed issue без acceptance evidence;
8. canceled/duplicate issue без и с explicit exclusion authority;
9. external dependency и external child closure;
10. native project status update, designated issue anchor и unavailable
    projection;
11. pre-write `updatedAt`/fingerprint conflict;
12. status state-comparison и comment-marker reconcile;
13. explicit issue-set status card;
14. exact Linear refs в cross-provider mapping.

Добавление другого task-management provider-а создаёт отдельные tracked adapter
specification и packaged `references/task-manager-<provider>.md`. Оно не меняет
router, lanes, pause, cohorts, dev/UAT или production boundary.

## 16. Официальные Linear references

- [GraphQL API и exact entity operations](https://linear.app/developers/graphql)
- [Relay-style pagination](https://linear.app/developers/pagination)
- [Workflow status categories](https://linear.app/docs/configuring-workflows)
- [Agent interaction and started-status guidance](https://linear.app/developers/agent-best-practices)
- [Project milestones](https://linear.app/docs/project-milestones)
- [Rate limits и provider retry hints](https://linear.app/developers/rate-limiting)
