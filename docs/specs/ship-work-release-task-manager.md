# Контракт task-management adapter для `ship-work-release`

Статус: accepted adapter contract, 2026-08-09.

Документ задаёт provider-neutral boundary между универсальным
[`ship-work-release`](ship-work-release.md) и task-management system. Конкретный
provider реализует этот contract в отдельной adapter specification и
отдельном operational runtime reference. Текущая mapping Mind Diary определена
в [`ship-work-release-task-manager-srez.md`](ship-work-release-task-manager-srez.md),
а её runtime procedure — в
[`operations/ship-work-release-task-manager-srez.md`](../operations/ship-work-release-task-manager-srez.md).
Исторические provider documents не являются current selector или authority.

Contract identity:

```text
ship-work-release/task-manager-adapter/v1
```

## 1. Ответственность adapter-а

Adapter обязан:

1. разрешить exact work collection и bounded work scope;
2. получить полный authoritative snapshot без silent truncation;
3. нормализовать items, provider lifecycle, readiness, acceptance,
   dependencies и parent/child relations;
4. построить ready frontier и объяснить каждый blocker;
5. объявить фактически доступные read/write/reconcile capabilities;
6. подготовить expected-old projection intent до любого remote write;
7. применить projection ровно к указанному target;
8. после timeout или потерянного acknowledgement сначала reconcile-ить
   provider state, а не повторять write вслепую;
9. вернуть typed outcome или typed error без угадывания результата.

Adapter не владеет router, lanes, worktrees, Git integration, CI, batches,
cohorts, dev/UAT cadence, production boundary или canonical run state. Remote
statuses, comments, labels и scope updates являются projections canonical
state и receipts, а не отдельной orchestration database.

## 2. Stable refs и identity

Любая authoritative entity имеет typed stable ref. Human-readable name, key,
URL или search result никогда не являются identity.

```yaml
adapter_ref:
  adapter_id: string
  contract: ship-work-release/task-manager-adapter/v1
  provider_instance_id: string

collection_ref:
  adapter_ref: AdapterRef
  collection_id: string
  human_key: string | null       # display-only
  canonical_url: string | null   # navigation-only

scope_ref:
  collection_ref: CollectionRef
  scope_kind: provider_scope | explicit_item_set
  scope_id: string               # provider ID or deterministic item-set digest
  human_key: string | null       # display-only

item_ref:
  collection_ref: CollectionRef
  item_id: string
  human_key: string | null       # display-only
  canonical_url: string | null   # navigation-only
```

`StableRef` означает tagged union `AdapterRef | CollectionRef | ScopeRef |
ItemRef`; variant всегда определяется структурой и не угадывается по форме
provider ID.

`provider_instance_id` различает независимые workspace/tenant/server instances
одного adapter-а. Adapter обязан либо получить его от provider-а, либо взять
из exact profile configuration. Отсутствующая или неоднозначная instance
identity блокирует mutation.

Ref/fingerprint сериализуется как RFC 8785 canonical JSON, кодируется UTF-8 и
получает digest `sha256:<64 lowercase hex>`. Identity projection ref-а содержит
только contract/adapter/provider-instance IDs, collection ID, scope kind/ID и
item ID соответствующего variant; `human_key` и `canonical_url` исключены.
Set-поля до сериализации сортируются лексикографически по canonical stable ref;
порядок semantic list сохраняется. Unknown field не отбрасывается молча:
schema reader сохраняет его либо отказывается нормализовать несовместимую
версию.

Item-set `scope_id` является digest объекта с contract ID, adapter ID,
provider instance ID, collection ID и отсортированным множеством exact item
IDs. Порядок ввода, display names и текущие URLs digest не меняют.

## 3. Selector envelope

Invocation передаёт adapter-у один typed selector envelope:

```yaml
schema: ship-work-release/task-manager-selector/v1
adapter_id: string
collection:
  id: string
scope:
  kind: profile_default | provider_scope | explicit_item_set
  selector_id: string | null     # только для declared profile default
  id: string | null              # только provider_scope
  item_ids: [string]             # только explicit_item_set
  projection_anchor_item_id: string | null
```

Правила:

- `collection.id` обязателен и является stable provider ID;
- `profile_default` принимает только selector, объявленный exact project
  profile; произвольный query string запрещён;
- `provider_scope` требует один exact immutable provider scope ID;
- `explicit_item_set` требует непустой bounded список exact item IDs;
- duplicate IDs, смешение вариантов и неизвестные поля дают
  `SELECTOR_INVALID`;
- optional `projection_anchor_item_id` является exact item ID declared profile
  либо explicit invocation; adapter exact-read-ит его, но не добавляет в
  selected item set, если anchor не был выбран как scope item;
- human names или human item keys нельзя подставлять вместо IDs;
- adapter подтверждает, что resolved scope и все selected items принадлежат
  exact collection;
- default selector до mutation преобразуется в exact `provider_scope` либо
  `explicit_item_set`; исходный selector и exact result сохраняются в snapshot
  и run card.

Resolution возвращает:

```yaml
resolved_selector:
  input: TaskManagerSelectorEnvelope
  exact_collection_ref: CollectionRef
  exact_scope_ref: ScopeRef
  exact_item_refs: [ItemRef]
  resolution_proof:
    query_fingerprint: string
    candidate_refs: [ScopeRef]
    pages_read: integer
    terminal_cursor_observed: boolean
    observed_at: RFC3339 UTC
```

Ноль или несколько результатов для default selector дают fail-closed error;
adapter не выбирает «самый похожий», первый или исторически использованный
scope. Для explicit selector `candidate_refs` содержит ровно exact requested
scope либо canonical item-set ref.

## 4. Capability declaration

После identity/permission preflight adapter возвращает capabilities exact
principal и exact collection. Capability — observed fact текущего run, а не
общая рекламная возможность provider-а.

```yaml
capabilities:
  exact_entity_read: available | unavailable
  bounded_full_snapshot: available | unavailable
  relation_closure: full | partial | unavailable
  item_status_projection: supported | unavailable
  item_progress_projection: supported | unavailable
  scope_fact_projection: native_scope | designated_anchor | unavailable
  expected_old: atomic | compare_immediately_before_write | unavailable
  idempotency: provider_native | adapter_marker_and_reconcile | unavailable
  reconcile: exact_effect_lookup | exact_state_comparison | unavailable
  provider_revision: opaque_revision | updated_at | field_fingerprint | unavailable
  permission_preflight: exact | coarse | unavailable
```

Обязательные для read-only snapshot capabilities — exact entity read, bounded
full snapshot и достаточная relation closure. Write path дополнительно требует
item/scope projection, expected-old, idempotency и reconcile capabilities для
планируемых effects.

`compare_immediately_before_write` не называется atomic CAS. Adapter повторно
читает target прямо перед write и проверяет expected-old, но post-read всё
равно обязан обнаруживать concurrent drift. Если риск конкретного projection
не разрешён project profile или adapter не может установить результат,
mutation fail closed.

Capability `unavailable` нельзя обходить prose-комментарием или best-effort
write. Run может продолжать read-only либо выполнять независимую работу, но
terminal claim, требующий отсутствующую projection, остаётся заблокированным.

## 5. Полный snapshot и pagination proof

Authoritative `snapshot(scope)` содержит:

- exact adapter, collection и scope refs;
- canonical resolved selector;
- scope metadata и projection home;
- полный selected item set;
- exact boundary nodes, нужные для dependency/parent closure;
- provider status catalog и permissions;
- normalized items, edges и dispositions;
- capabilities;
- completeness proof;
- snapshot fingerprint и UTC observation time.

Любой list/search response является discovery data, пока adapter не выполнит
exact reads по stable IDs. Adapter полностью исчерпывает pagination items,
relations, comments/evidence и status catalogs, если эти данные влияют на
normalization или projection.

Project profile задаёт finite maximum records/pages для каждой connection.
Достижение bound до terminal cursor даёт `SCOPE_UNBOUNDED`, а не частичный
snapshot. Повышение bound требует новой preflight configuration и повторного
snapshot; adapter не продолжает с уже начатым mutation path.

```yaml
completeness_proof:
  query_fingerprint: string
  observed_at: RFC3339 UTC
  collections:
    - name: items | dependencies | children | evidence | status_catalog
      pages_read: integer
      records_read: integer
      terminal_cursor_observed: boolean
      provider_total: integer | null
      total_matches: true | false | unknown
  truncation_detected: boolean
```

Snapshot допустим только если для каждой обязательной collection:

- terminal page/cursor доказан;
- declared provider total совпадает, если provider его возвращает;
- response limit, permission filter или API cap не оставляют неизвестный хвост;
- все referenced boundary nodes exact-read либо явно представлены как
  `unresolved` и блокируют затронутый frontier;
- `truncation_detected=false`.

`unknown` completeness, частично прочитанная relation или permission-filtered
gap дают `SNAPSHOT_INCOMPLETE`. Adapter не заменяет недостающие данные прежним
snapshot без явно валидного provider revision.

## 6. Normalized scope и item

```yaml
normalized_snapshot:
  schema: ship-work-release/task-manager-snapshot/v1
  adapter_ref: AdapterRef
  collection_ref: CollectionRef
  scope: NormalizedScope
  items: [NormalizedItem]
  boundary_items: [NormalizedItem]
  required_evidence_capability_ids: [string]
  observed_at: RFC3339 UTC
  fingerprint: string
  completeness_proof: CompletenessProof

normalized_scope:
  ref: ScopeRef
  selector: ResolvedSelector
  collection_ref: CollectionRef
  item_refs: [ItemRef]
  boundary_refs: [ItemRef]
  dependency_edges: [DependencyEdge]
  hierarchy_edges: [HierarchyEdge]
  projection_home: ProjectionHome | null
  capabilities: Capabilities
  completion: open | satisfied | blocked | incoherent
  fingerprint: string
  completeness_proof: CompletenessProof

normalized_item:
  ref: ItemRef
  scope_member: boolean
  title: string
  acceptance:
    source_refs: [string]
    fingerprint: string
    state: known | missing | ambiguous
  provider_status:
    id: string
    type: string
    name: string
    revision: string | null
  lifecycle: backlog | ready | active | done | canceled
  readiness: ready | blocked | not_applicable | unknown
  effective_status: backlog | ready | active | blocked | done | canceled
  blocker_refs: [ItemRef]
  parent_refs: [ItemRef]
  child_refs: [ItemRef]
  disposition: pending | accepted | excluded | unsuccessful | incoherent
  exclusion: ExclusionDecision | null
  evidence_refs: [string]
  projection_metadata: object
  fingerprint: string
```

`fingerprint` включает все authoritative fields, влияющие на scope membership,
acceptance, readiness, dependencies, hierarchy, routing, projection
expected-old или terminal disposition. Display-only title/name/URL включаются
только если adapter считает их acceptance source; это объявляется явно.

`required_evidence_capability_ids` — отсортированное bounded множество
versioned capability IDs, прямо выведенных из exact scope/item acceptance
(например, `multi-principal`). Adapter не добавляет их по эвристике; source refs
и mapping входят в snapshot fingerprint. Unknown requirement блокирует
acceptance вместо silent omission.

## 7. Lifecycle, readiness и disposition

Provider lifecycle, derived readiness и scope disposition — разные оси.

| Ось | Назначение |
|---|---|
| `lifecycle` | Нормализует remote workflow status. |
| `readiness` | Показывает, можно ли безопасно dispatch-ить item сейчас. |
| `effective_status` | Даёт compact core/status-card class. |
| `disposition` | Определяет, удовлетворяет ли item successful scope completion. |

`blocked` по умолчанию является derived readiness, а не требованием наличия
одноимённого remote status. Для nonterminal item adapter сохраняет remote
lifecycle и вычисляет `readiness` из acceptance/dependency/permission facts.
`effective_status=blocked`, когда item иначе мог бы войти в frontier, но имеет
объяснимый blocker. Projection `blocked` не должна выдумывать provider status:
adapter либо использует declared blocker projection home, либо оставляет remote
status неизменным и возвращает derived state из следующего snapshot.

Terminal semantics:

- `done` означает provider terminal status, но становится
  `disposition=accepted` только после exact acceptance и required evidence;
- `done` без достаточного evidence даёт `disposition=incoherent` и не считается
  successful completion;
- `canceled` по умолчанию даёт `disposition=unsuccessful`;
- `canceled` становится `disposition=excluded` только при exact
  `ExclusionDecision` с authority, reason, item fingerprint и receipt;
- простое remote cancel, duplicate label, comment или исчезновение item из
  query не является exclusion authority;
- `pending`, `unsuccessful` и `incoherent` не удовлетворяют scope completion.

```yaml
exclusion_decision:
  decision_id: string
  item_ref: ItemRef
  item_fingerprint: string
  authority: user | accepted_scope_contract
  reason: string
  decided_at: RFC3339 UTC
  receipt_ref: string
```

Adapter не создаёт exclusion decision самостоятельно. Изменение item после
decision инвалидирует старый fingerprint и требует нового решения.

## 8. Dependency и hierarchy closure на границе scope

Selected item set не расширяется молча. Relation nodes вне scope читаются как
`boundary_refs` и помечаются `scope_member=false`.

```yaml
dependency_edge:
  blocker_ref: ItemRef
  blocked_ref: ItemRef
  blocker_in_scope: boolean
  blocked_in_scope: boolean
  state: satisfied | unsatisfied | excluded | unresolved

hierarchy_edge:
  parent_ref: ItemRef
  child_ref: ItemRef
  parent_in_scope: boolean
  child_in_scope: boolean
  completion_required: boolean
```

Правила closure:

- upstream dependency вне scope не добавляется в scope, но блокирует selected
  item, пока не имеет accepted/excluded disposition;
- downstream dependent вне scope не блокирует completion selected item;
- parent вне scope не становится scope member и не получает automatic status
  projection из этого run;
- child вне scope блокирует completion selected parent, если provider/accepted
  scope contract считает child обязательным для parent closure;
- parent/child или dependency relation с неизвестным target даёт
  `unresolved`, а не предполагаемый terminal state;
- exclusion boundary item требует ту же explicit authority, что и selected
  item;
- adapter не меняет status boundary item без отдельного exact scope authority.

Scope удовлетворён только когда все selected items имеют disposition
`accepted` или `excluded`, обязательные boundary edges reconciled и snapshot
остаётся полным.

## 9. Ready frontier

`ready_frontier(snapshot)` возвращает stable ordered set item refs и по каждому
item — решение router-а:

```yaml
frontier_decision:
  item_ref: ItemRef
  eligible: boolean
  lifecycle: string
  readiness: string
  blocker_codes: [string]
  blocker_refs: [ItemRef]
  item_fingerprint: string
```

Ordering задаётся adapter specification и должен быть deterministic. Item
eligible только при known acceptance, подходящем lifecycle, satisfied closure,
write/read permissions для планируемого пути и отсутствии terminal
disposition. `unknown` не нормализуется в `ready`.

## 10. Projection homes

Каждый remote fact имеет один exact home:

```yaml
projection_home:
  kind: native_scope | designated_anchor | item
  target_ref: ScopeRef | ItemRef
  channel: status | comment | update | field
  stable_remote_id: string | null
```

- item lifecycle проецируется только в exact item status target;
- item progress/evidence пишется в declared item channel;
- scope candidate, UAT evidence и terminal rationale пишутся в один exact
  `native_scope` либо `designated_anchor` home;
- произвольный «item или scope» выбор во время write запрещён;
- если provider не имеет native scope facts, profile/selector обязан задать
  exact designated anchor, а capability объявляется `designated_anchor`;
- отсутствие required home даёт `PROJECTION_HOME_MISSING` до effect intent.

Projection home входит в scope fingerprint. Его drift инвалидирует старый
plan. Bounded human-readable update может ссылаться на immutable receipt, но не
заменяет canonical evidence.

## 11. Projection protocol

### 11.1 Plan

`plan_projection` является pure/read-only operation:

```yaml
projection_request:
  run_id: string
  adapter_ref: AdapterRef
  target_ref: ScopeRef | ItemRef
  projection_kind: item_status | item_progress | scope_facts
  expected_old:
    provider_revision: string | null
    field_values: object
    fingerprint: string
  desired_state: object
  source_receipt_refs: [string]
  idempotency_key: string

effect_intent:
  effect_id: string
  request: ProjectionRequest
  exact_operation: object
  projection_home: ProjectionHome
  planned_at: RFC3339 UTC
```

`idempotency_key` уникален для logical effect, но стабилен при recovery того же
effect. Изменённый desired state создаёт новый effect и key. Intent сохраняется
в canonical external-effect journal до remote write.

### 11.2 Apply

Непосредственно перед mutation adapter rereads exact target. Несовпавший
expected-old возвращает conflict без write. Apply возвращает один outcome:

```text
applied
already_applied
conflict_expected_old
rejected
failed_no_effect
indeterminate
```

- `applied` включает exact remote identity/revision и post-write fingerprint;
- `already_applied` доказывает тот же idempotency marker или exact desired
  state, а не просто похожий comment/status;
- `conflict_expected_old` требует fresh snapshot/re-plan;
- `rejected` означает provider validation/permission/capability refusal;
- `failed_no_effect` допустим только когда отсутствие write доказано;
- network timeout, lost acknowledgement или неизвестный provider result всегда
  дают `indeterminate`, а не `failed_no_effect`.

### 11.3 Reconcile

После `indeterminate` единственный следующий remote operation —
`reconcile_projection(effect_intent)`:

```text
applied_exact
not_applied
conflict_other_effect
ambiguous
unavailable
```

`applied_exact` закрывает исходный effect без нового write. `not_applied`
разрешает retry только после свежего expected-old check с тем же logical
idempotency key. `conflict_other_effect` требует re-plan. `ambiguous` и
`unavailable` сохраняют hold; blind retry запрещён.

Adapter никогда не трактует совпавший display text как доказательство exact
effect, если текст мог быть создан независимо. Для adapter-side idempotency
используется stable non-secret effect marker и exact target/state comparison.

## 12. Typed errors

Каждая ошибка имеет envelope:

```yaml
error:
  code: string
  operation: string
  retryable: boolean
  remote_effect: none | possible | confirmed
  refs: [StableRef]
  message: string
  provider_detail_ref: string | null
```

Нормативные codes:

| Code | Значение |
|---|---|
| `CONFIGURATION_INVALID` | Adapter/profile configuration неполна или противоречива. |
| `CAPABILITY_UNSUPPORTED` | Required provider capability отсутствует. |
| `SELECTOR_INVALID` | Selector envelope malformed или не exact. |
| `IDENTITY_AMBIGUOUS` | Stable entity нельзя разрешить однозначно. |
| `ENTITY_NOT_FOUND` | Exact ref отсутствует. |
| `PERMISSION_DENIED` | Exact principal не имеет required capability. |
| `SCOPE_EMPTY` | Exact scope не содержит selected items. |
| `SCOPE_UNBOUNDED` | Scope или response превышает declared bound. |
| `SNAPSHOT_INCOMPLETE` | Pagination/relations/completeness не доказаны. |
| `SNAPSHOT_DRIFT` | Authoritative fingerprint изменился. |
| `DEPENDENCY_UNRESOLVED` | Required relation target/state неизвестен. |
| `PROJECTION_HOME_MISSING` | Required exact remote home не задан. |
| `EXPECTED_OLD_CONFLICT` | Target не совпал с planned old state. |
| `EFFECT_INDETERMINATE` | Write мог состояться, нужен reconcile. |
| `RECONCILE_AMBIGUOUS` | Exact outcome установить нельзя. |
| `PROVIDER_RATE_LIMITED` | Provider сообщил bounded retry condition. |
| `PROVIDER_UNAVAILABLE` | Read/reconcile capability временно недоступна. |
| `VALIDATION_ERROR` | Provider отклонил exact desired state. |

Provider-specific codes сохраняются только как redacted diagnostic detail и
не заменяют normalized code. Retry допускается лишь когда normalized outcome
и adapter policy явно разрешают его; `retryable=true` не отменяет
reconcile-before-retry.

## 13. Status card и scope forms

Status card показывает:

- adapter и provider instance;
- exact collection ref;
- scope kind и exact ref;
- selector resolution result;
- total selected items и count каждого lifecycle/effective status/disposition;
- boundary blocker count;
- snapshot time/freshness и completeness state;
- projection capability и exact scope projection home;
- current item/lane, batch, candidate, UAT cut и terminal claim.

Provider-scope и explicit-item-set cards различаются явно. Для explicit set
нельзя показывать вымышленный milestone/sprint/release; вместо него выводятся
`scope_kind=explicit_item_set`, item count и bounded list/digest exact refs.

## 14. Cross-provider mapping

Смена task-management provider-а не меняет identity существующих refs
автоматически. Одинаковые names, URLs или human keys не являются mapping.

Перенос normalized scope/item refs между двумя task-management systems требует
отдельный mapping receipt:

```yaml
cross_provider_mapping:
  mapping_id: string
  source_adapter_ref: AdapterRef
  target_adapter_ref: AdapterRef
  source_scope_ref: ScopeRef
  target_scope_ref: ScopeRef
  item_pairs:
    - source_ref: ItemRef
      source_fingerprint: string
      target_ref: ItemRef
      target_fingerprint: string
  unmapped_source_refs: [ItemRef]
  unmapped_target_refs: [ItemRef]
  authority_receipt_ref: string
  reconciled_at: RFC3339 UTC
```

Mapping может быть принят только после exact snapshots обеих сторон, explicit
authority и reconciliation всех selected items/relations. Unmapped либо
ambiguous refs блокируют authority transfer. Это только identity mapping между
task managers: он не переносит run/cohort/lane state и не задаёт migration
какого-либо прежнего skill или orchestration implementation.

## 15. Conformance

Каждый provider adapter имеет fixtures/scenarios как минимум на:

1. exact collection/scope resolution и отказ от display-name identity;
2. default selector с нулём, одним и несколькими результатами;
3. explicit provider scope и bounded explicit item set с native/missing/exact
   designated projection anchor;
4. multi-page items и independently paginated relations;
5. incomplete cursor/permission-filtered snapshot;
6. stable ref serialization и item-set digest;
7. lifecycle/readiness/effective-status normalization;
8. derived blocker, внешний dependency и внешний child parent closure;
9. `done` без evidence и `canceled` без/с exclusion authority;
10. exact item and scope projection homes;
11. expected-old success и conflict;
12. provider-native либо adapter-marker idempotency;
13. timeout before write, after write и lost acknowledgement;
14. каждый reconcile outcome без blind retry;
15. permission/capability drift между snapshot и write;
16. explicit-item-set status card;
17. cross-provider mapping с exact, missing и ambiguous pairs.

Adapter conformance не доказывает router, Git, CI, dev/UAT или live provider
deployment. Live capability claims требуют bounded check exact
adapter/provider-instance/principal pair.

## 16. Packaging

В tracked skill этот contract переносится в
`references/task-management.md`. Provider reference
`references/task-manager-<provider>.md` содержит только mapping, selectors,
capabilities, pagination, projection homes, provider outcomes и API/tool
details. `SKILL.md` загружает общий contract и ровно один adapter reference,
выбранный exact project profile.
