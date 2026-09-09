# Project profile contract для `ship-work-release`

Статус: accepted schema specification, 2026-08-09.

Документ задаёт provider-neutral schema
`ship-work-release/project-profile/v1`. Базовый
[execution contract](ship-work-release.md) определяет orchestration semantics,
а project profile передаёт ему только проверяемые repository, environment и
provider capabilities. Конкретный профиль Mind Diary находится в
[operations](../operations/ship-work-release-profile.md).

С 2026-09-09 профиль Mind Diary revision 9 отдельно задаёт соразмерный обычный
UAT режим. Сохранённый YAML v1 — конфигурация полного режима, не автоматически
активный план. При выборе полного режима parser применяет все правила ниже
без narrative overrides. Обычная выборочная приёмка оформляется отчётом
coordinator, не выдаётся за успешное исполнение полного v1 profile и не требует
изменения schema или изготовления недостающих receipts.

## 1. Назначение и граница

Profile отвечает на пять вопросов:

1. какой exact work collection и default scope читать через выбранный
   task-manager adapter;
2. какими командами получить и проверить exact repository candidate;
3. как запустить, дождаться и остановить локальный `dev`;
4. как спроецировать exact candidate в CI и, если UAT настроен, опубликовать,
   reconcile и откатить его;
5. какие evidence rows обязательны и какие runtime bounds действуют.

Profile не содержит orchestration algorithm, work-item state machine,
provider credentials, shell snippets или production deploy authority. Эти
ограничения нельзя ослабить narrative-текстом рядом с payload.

## 2. Authoritative payload и identity

Authoritative payload — первый fenced YAML block в project profile, у которого
root field равен:

```yaml
schema: ship-work-release/project-profile/v1
```

Parser обязан:

- читать UTF-8 и отклонять duplicate keys, YAML tags, aliases и merge keys;
- отклонять неизвестные root и nested fields, если этот contract явно не
  разрешает extension map;
- считать scalar command arguments literal strings, а не shell source;
- вычислять `profile_sha256` по exact UTF-8 bytes fenced payload и сохранять
  его в run state и receipts;
- проверять `profile_id` по `^[a-z][a-z0-9-]{1,62}$`;
- проверять `profile_revision` как положительный integer. Revision растёт при
  несовместимом для незавершённого run изменении project values, но не заменяет
  schema version.

`profile_id`, `profile_revision`, `profile_sha256` и resolved stable refs вместе
идентифицируют конфигурацию конкретного run. Display name, URL или file path не
заменяют provider object ID.

## 3. Общие типы

### 3.1 Scalar и path

| Тип | Контракт |
|---|---|
| `Id` | Непустая стабильная строка; не display name. |
| `Sha256` | 64 lowercase hexadecimal characters. |
| `GitSha` | Полный 40-character lowercase commit SHA. Short SHA запрещён в authority/effects. |
| `Boolean` | Только YAML `true | false`; строки с теми же словами запрещены. |
| `StringSet` | Bounded array уникальных строк, canonicalized лексикографической сортировкой. |
| `Enum` | Строка из closed values, объявленных source/capability schema. |
| `DurationSeconds` | Integer `1..86400`, если более узкая граница не задана полем. |
| `RelativePath` | POSIX path от repository root; не absolute, не содержит пустой segment, `.` или `..`. Root обозначается строкой `.`. |
| `Url` | Absolute `https` URL; `http` разрешён только для loopback `dev`. Userinfo и fragment запрещены. |
| `JsonPointer` | RFC 6901 pointer внутри tracked JSON document. |

Любой path сначала разрешается относительно exact repository checkout, затем
проверяется на containment. Symlink, выводящий за repository root, блокирует
операцию.

### 3.2 StableRef

Внешняя сущность задаётся объектом `StableRef`:

```yaml
provider: task-manager
kind: project
id: 00000000-0000-0000-0000-000000000000
display_name: Example
```

Поля `provider`, `kind` и `id` обязательны. `display_name` nullable и служит
только человеку. Provider adapter обязан reread object по `id` и проверить его
kind; search result и совпадение display name не являются resolution.

`StableRefSource` является tagged union. Когда stable ID хранится в tracked
provider manifest, используется `json_pointer`:

```yaml
provider: openai-sites
kind: project
id_source:
  kind: json_pointer
  document: apps/example/.openai/hosting.json
  pointer: /project_id
  expected_type: string
  expected_pattern: '^appgprj_[a-z0-9]+$'
display_name: Example UAT
```

Для provider instance, который нельзя безопасно хранить в repository,
используется exact read-only adapter capability:

```yaml
id_source:
  kind: adapter_capability
  capability: provider/instance.identity.read/v1
  expected_type: uuid
```

`json_pointer` требует `document`, `pointer`, `expected_type` и optional
`expected_pattern`. `adapter_capability` требует versioned `capability` и
`expected_type`; capability обязана вернуть ровно один immutable provider
instance ID и доказать принадлежность configured collection этому instance.
Другие fields для выбранного variant запрещены.

`id` и `id_source` mutually exclusive. Resolver сохраняет resolved ID, source
identity и evidence digest в preflight receipt и затем работает только с
resolved ID. Изменение source до external effect вызывает drift и повторный
preflight.

### 3.3 InputBinding

Provider operation inputs и command templates не используют произвольные
expressions. Значение имеет один из трёх видов:

```yaml
literal: fixed-value
value_from: run.candidate_sha
ref_from: uat.target
```

- `literal` хранит public non-secret value прямо в profile;
- `value_from` выбирает одно поле из объявленного contract context;
- `ref_from` передаёт уже resolved `StableRef`.

Разрешённые `value_from` публикует capability contract. Неизвестный source или
несовпадающий тип блокирует preflight. Доступ к environment variable через
`value_from` запрещён: names и classification объявляются отдельно в command
environment или provider session.

### 3.4 Contract context

Profile содержит machine-readable `context.bindings`. Это allowlist всех paths,
которые могут появляться в `value_from`, evidence `facts[].source` и assertion
operands. Каждый binding имеет:

```yaml
run.candidate_sha:
  source: canonical_run_state
  pointer: /candidate_sha
  type: git-sha
  nullable: false
```

Допустимые `source` в schema v1:

- `canonical_run_state`;
- `current_batch_manifest`;
- `task_manager_scope_snapshot`;
- `dev_launch_receipt`;
- `uat_predeploy_receipt`;
- `current_uat_cut`;
- `current_effect`;
- `scope_release_receipt`;
- `resolved_profile_ref`.

`pointer` является RFC 6901 pointer внутри versioned source schema. Binding
объявляет scalar `type` либо object `schema`, `nullable` и optional
`max_serialized_bytes`. Object можно передать operation только целиком в
declared bounded input либо читать через отдельно объявленные child bindings.
Path не наследует authority только потому, что у его prefix есть binding.
Для `type: enum` обязательна непустая closed `values`; для других типов она
запрещена.

До первого effect validator обязан доказать, что каждый использованный path
объявлен ровно один раз, source доступен в соответствующей lifecycle phase,
pointer существует в его schema, а тип совпадает с capability input/predicate.
На plan reducer создаёт immutable context snapshot с exact state revision,
source receipt/ref и digest. Drift инвалидирует plan; `current` всегда
разрешается по exact IDs из control/state, а не по времени.

## 4. Top-level schema

Все перечисленные root fields обязательны, даже когда их значение `null` или
`configured: false`:

| Field | Тип | Назначение |
|---|---|---|
| `schema` | constant | `ship-work-release/project-profile/v1`. |
| `profile_id` | `Id` | Стабильное имя project profile. |
| `profile_revision` | positive integer | Project configuration generation. |
| `context` | object | Typed allowlist operation/evidence paths и canonical source bindings. |
| `task_management` | object | Adapter, exact collection и default scope selector. |
| `repository` | object | Repository identity, integration ref и commands. |
| `ci` | object | Exact-candidate projection и required-run query либо явное отключение. |
| `release` | object | Default UAT cadence и review policy. |
| `dev` | object | Local launcher/readiness/smoke/cleanup contract. |
| `uat` | object | Hosted target и operations либо `configured: false`. |
| `production` | object | Manual-only handoff metadata; никогда не deploy authority skill. |
| `evidence` | object | Facts, redaction policies и stable evidence rows. |
| `runtime` | object | Grace, heartbeat, lane, retention и deadline bounds. |

`extensions` в v1 отсутствует. Добавление неизвестного field требует следующей
schema version либо обратно совместимого изменения самого v1 contract.

## 5. Command ABI

Каждая repository команда имеет schema
`ship-work-release/command/v1` и следующую форму:

```yaml
schema: ship-work-release/command/v1
id: repository.full-gate
argv:
  - project-tool
  - full-gate
cwd: .
environment:
  inherit:
    - name: PATH
      classification: public-runtime
  set:
    CI: "true"
stdin: closed
timeout_seconds: 1800
exit:
  mode: finite
  success_codes: [0]
output:
  capture: bounded
  max_bytes_per_stream: 4194304
termination:
  soft_signal: SIGTERM
  soft_grace_seconds: 10
  hard_signal: SIGKILL
```

### 5.1 `argv`

Runner вызывает executable напрямую с argument vector. Он не запускает
`sh -c`, `bash -c`, `zsh -c`, PowerShell или эквивалент и не выполняет glob,
pipe, redirect, command substitution либо `$VAR` expansion.

Scalar element означает literal argument. Typed substitution выглядит так:

```yaml
- template: "{base_sha}..{candidate_sha}"
  variables: [base_sha, candidate_sha]
```

Каждая variable должна быть разрешена command context и пройти свой type
validator до substitution. `variables` обязана точно совпадать с placeholders
в template. После substitution результат остаётся одним argv element и не
интерпретируется shell-ом.

### 5.2 Environment

`environment.inherit` — исчерпывающий allowlist. Каждый entry содержит `name`
и classification `public-runtime | credential`. Значение credential доступно
только child process, не попадает в command receipt и всегда печатается как
`<redacted>`. `environment.set` разрешает только public literal strings.
Profile не содержит значения credentials.

Необъявленная переменная не наследуется. Если executable/runtime не способен
работать с таким environment, command не считается доступной.

### 5.3 Exit, timeout и output

- `stdin` в v1 всегда `closed`; интерактивная команда невалидна.
- `exit.mode` равен `finite` либо `long-running`.
- Для `finite` неперечисленный exit code, signal или timeout означает failure.
- Для `long-running` exit до cleanup означает failure независимо от code;
  допустимые cleanup codes задаются `exit.cleanup_codes`.
- Timeout не является доказательством отсутствия external effect. Для provider
  effects применяется reconcile protocol из раздела 9.
- Output хранится bounded. Truncation отмечается в receipt и не может удалить
  machine result, необходимый success predicate.

`termination` обязателен. Если platform не поддерживает указанные signals, она
должна предоставить семантически эквивалентное bounded process termination и
объявить capability на preflight.

## 6. Task management и repository

`task_management` содержит:

```yaml
adapter:
  id: task-manager
  contract: ship-work-release/task-manager-adapter/v1
  specification: docs/specs/ship-work-release-task-manager-srez.md
  runtime_reference: docs/specs/ship-work-release-task-manager-srez.md
provider_instance:
  id: immutable-provider-instance-id
  id_source: null
collection: { provider: task-manager, kind: project, id: stable-id }
default_scope:
  selector: configured_release
  parameters: {}
pagination:
  request_timeout_seconds: 60
  connections:
    scope_items: { page_size: 100, max_pages: 100, max_records: 10000 }
scope_fact_projection:
  mode: native_scope
  capability: provider/native-scope-facts/v1
  unavailable_behavior: block-terminal-projection
```

`specification` и `runtime_reference` — repository-relative paths. Первый
указывает на accepted provider-specific contract, второй — на lazy-loaded
операционный reference внутри packaged skill. Reference обязан быть производным
от specification и не становится второй нормой.
Collection всегда `StableRef`; selector возвращает exact `scope_ref` и bounded
item set либо fail closed.

`provider_instance` задаёт либо literal immutable `id`, либо `id_source`, но не
оба сразу. `id_source.kind: adapter_capability` обязан вернуть один stable
workspace/tenant/server ID и доказать принадлежность collection этому instance;
resolved ID сохраняется в `AdapterRef` до mutation. Slug, URL и current user ID
не заменяют provider instance ID.

`pagination.connections` перечисляет каждую connection, которую adapter читает
для identity, scope, relations, closure, catalogs или reconciliation. Для
каждой обязательны positive `page_size`, `max_pages` и `max_records`, а общий
`request_timeout_seconds` конечен. Неперечисленная paginated connection либо
достижение любого bound до terminal cursor дают incomplete snapshot.

`scope_fact_projection` задаёт ровно один authoritative projection home:
`native_scope`, `designated_anchor` или `unavailable`. Первые два требуют exact
target resolver, versioned marker schema, write/reconcile capability и правило
сохранения созданного provider object ID. `unavailable` разрешает read-only и
независимую implementation работу, но блокирует terminal scope projection.

`repository` содержит:

- `root`, `repository_ref`, `integration.remote`, `integration.branch` и exact
  `integration.ref`;
- `integration.update_mode: expected-old-fast-forward`;
- named `commands.install`, `commands.full_gate` и `commands.diff_check`;
- `targeted_checks.source`.

`repository_ref` — provider `StableRef`, если CI/provider его требует.
`diff_check` обязан принимать `base_sha` и `candidate_sha` и проверять exact
range. Bare `git diff --check` без range невалиден.

`targeted_checks.source` в v1 имеет kind `capability`:

```yaml
source:
  kind: capability
  capability: ship-work-release/targeted-check-resolver/v1
  output_schema: ship-work-release/targeted-check-manifest/v1
  inputs:
    - run.work_item_acceptance
    - run.ownership_paths
    - repository.instructions
  empty_result: fail
```

Resolver возвращает bounded list полных `Command` objects и mapping command →
acceptance/path. Narrative command или пустой result не дают writer receipt.

## 7. Dev contract

`dev.configured` — boolean. При `false` `target_class`, `launch`,
`url_resolution`, `readiness`, `configuration_fingerprint`, `cleanup` и
`smoke_rows` равны `null` либо empty list по schema. Такой profile подходит
non-runnable library/CLI/documentation scope и не получает локальные runtime
claims.

При `dev.configured: true` Dev object содержит:

1. `target_class: localhost`;
2. `launch.command` с `exit.mode: long-running`;
3. machine-readable `url_resolution`;
4. `readiness` с отдельным timeout;
5. `configuration_fingerprint` без secret values;
6. `cleanup` exact launched-process tree;
7. `smoke_rows` — IDs evidence rows со stage `dev`.

Поддерживаемые `url_resolution.kind`:

- `fixed` — profile содержит loopback URL;
- `launcher_event` — launcher печатает одну JSON line объявленной schema, из
  которой JSON pointer выбирает URL.

При `launcher_event` regex scraping произвольного human log запрещён. Event
должен содержать `ready: true`, loopback URL и non-secret
`configuration_fingerprint`. Duplicate conflicting events дают failure.

`readiness` имеет kind `launcher_event`, `http` или `runtime_capability` и
обязательные `interval_seconds`, `timeout_seconds`, success predicate. Получение
URL не заменяет readiness, если profile объявляет отдельный probe.

`cleanup` имеет kind `launched_process_tree`, soft/hard termination и bounded
timeout. Coordinator выполняет cleanup после smoke, failure, pause и recovery.
Он не убивает процессы, identity которых не связана с сохранённым launch
receipt.

## 8. CI exact-candidate contract

`ci.required` — boolean. При `false` поля `provider`, `repository_ref`,
`workflow_ref`, `projection` и `query` равны `null`. Configured UAT в базовом
delivery contract требует `ci.required: true`.

При `true` profile задаёт:

- provider adapter и stable repository/workflow refs;
- projection exact `candidate_sha` в exact remote ref с
  `expected_old_sha` precondition;
- read operation для reconciliation remote ref;
- query required workflow/run только по exact candidate SHA;
- terminal success/failure states, polling interval и timeout.

Projection operation обязана иметь capability с compare-and-set semantics.
Read-before-write без atomic expected-old update недостаточен. После timeout
или lost acknowledgement coordinator сначала читает exact remote ref. Blind
повтор update запрещён.

CI query не принимает “последний run ветки”. Selector обязан включать exact
repository, workflow identity, ref и `head_sha == candidate_sha`. Несколько
подходящих run-ов разрешаются declared deterministic policy либо дают
ambiguity. Только declared terminal success даёт CI evidence.

## 9. Provider operation ABI

CI и UAT effects используют `ProviderOperation`:

```yaml
id: uat.deployment.deploy
provider: example-provider
capability: example/deployment.create/v1
effect: true
inputs:
  target: { ref_from: uat.target }
  artifact_sha: { value_from: run.candidate_sha }
timeout_seconds: 900
result:
  schema: example/deployment-result/v1
  identity_fields: [deployment_id]
  success:
    path: status
    operator: eq
    value: succeeded
replay:
  policy: reconcile-before-retry
  reconcile_operation: uat.deployment.find
```

Rules:

- `id` уникален во всём profile и стабилен между revisions, пока семантика
  operation не изменилась;
- capability resolver выбирается по exact provider/capability, а не natural
  language;
- `effect: true` требует effect intent, expected-old/precondition, idempotency
  key, если capability его поддерживает, и reconciliation operation;
- `effect: false` не получает mutation authority;
- result schema, identity fields и success predicate обязательны;
- timeout/retry не считаются failure либо absence, пока reconciliation не дал
  authoritative result;
- `replay.policy` равен `never`, `idempotent-key` либо
  `reconcile-before-retry`. Последний является default для provider effects;
- unavailable capability блокирует только путь, который её требует, до первой
  mutation; profile не заменяет её похожей командой или browser gesture.

Provider session/connector владеет authentication. Profile может называть
credential reference и classification, но никогда secret value, cookie,
bearer token или authorization header.

## 10. UAT contract

`uat.configured` — boolean. `release.default_cadence` имеет значение
`continuous-uat | manual-uat | none`; `none` обязательно при отключённом UAT,
а первые два допустимы только при configured UAT.

При `false` `product_environment`, `platform_deployment_class`, `target`,
`source`, `url`, `provider`, `operations`, `rollback` и `smoke_rows` равны
`null` или empty list по schema. Coordinator не делает hosted release и не
использует production как fallback.

При `true` обязательны:

- `product_environment: uat` как constant product authority class;
- непустой provider-defined `platform_deployment_class`;
- provider adapter и target `StableRef`/`StableRefSource`;
- exact source path или provider artifact resolver;
- deploy authority `ship-work-release`;
- structured operations для build/save version, deploy, current-state read и
  reconciliation;
- resolved live URL;
- `smoke_rows` evidence IDs;
- rollback capability и bootstrap policy.

`platform_deployment_class` сохраняет официальный либо adapter-defined термин
hosting provider-а для созданного deployment. Он является evidence metadata и
не участвует в выборе product environment или deploy authority. В частности,
provider class со словом `production` не меняет
`product_environment: uat`, не создаёт production target и не разрешает
production release.

`rollback` содержит:

```yaml
supported: true
stable_selector:
  kind: last-compatible-stable-receipt
  match: [profile_id, target.provider, target.kind, target.id]
bootstrap:
  when_missing_stable_receipt: require-explicit-current-baseline
deploy_operation: uat.deployment.deploy
reconcile_operation: uat.deployment.get
post_rollback_rows: [uat.baseline.web-control]
```

Если `supported: false`, automated UAT cut, требующий rollback по базовому
execution contract, fail closed. `require-explicit-current-baseline` разрешает
первый cut только после read-only resolution current deployment и отдельного
подтверждения, что он является stable baseline; отсутствие current deployment
фиксируется как `empty-target`, а не выдуманный previous deployment.

Rollback повторно deploy-ит exact stable provider version/artifact. Он не
пересобирает source и не выбирает “предыдущий” объект по времени без receipt
compatibility check.

## 11. Evidence matrix

`evidence` содержит `facts`, `redaction_policies` и `rows`.

### 11.1 Facts и conditions

Каждый fact имеет stable ID, type и authoritative source:

```yaml
facts:
  - id: run.changed_capabilities
    type: string-set
    source: run.batch_manifest.changed_capability_ids
  - id: run.scope_required_capabilities
    type: string-set
    source: run.scope_snapshot.required_evidence_capability_ids
```

Conditions являются AST, а не строкой-expression:

```yaml
when:
  any:
    - fact: run.changed_capabilities
      operator: contains
      value: mcp.compat.2025-11-25
    - fact: run.scope_required_capabilities
      operator: contains
      value: mcp.compat.2025-11-25
```

Допустимы `always`, `all`, `any`, `not` и leaf operators `eq`, `ne`, `exists`,
`contains`, `intersects`. Unknown fact или type mismatch является profile/run
error, не `false`.

### 11.2 EvidenceRow

Каждая row имеет:

| Field | Contract |
|---|---|
| `id` | Уникальный immutable ID внутри `profile_id`; regex `^[a-z0-9][a-z0-9.-]+$`. |
| `stage` | `dev | ci | uat | rollback | handoff`. |
| `requirement` | `required | conditional | informational | owner-observation`. |
| `when` | Condition AST; required row использует `always: true`. |
| `probe` | `command`, `provider_operation`, `runtime_capability`, `receipt_assertion` или `manual_observation`. |
| `success` | Predicate AST над typed probe result. |
| `artifact` | Schema/media type, bounded storage mode и content hash. |
| `redaction_policy` | Stable policy ID из того же profile. |

`runtime_capability` содержит exact capability ID/version и typed inputs.
Неразрешённый capability блокирует row; его нельзя считать `not-applicable`.
`receipt_assertion` читает только typed receipts exact run. `manual_observation`
не удовлетворяет automated deployment gate и хранит только явно введённый
verdict.

Required row обязана завершиться `passed`. Conditional row получает
`not-applicable` только когда её `when` вычислился в `false`; при `true` правила
те же, что у required. `failed`, `not-run`, unresolved artifact или truncated
machine result не дают успешного cut.

### 11.3 Artifact и redaction

Artifact descriptor объявляет:

- `schema` и `media_type`;
- `storage: inline-bounded | content-addressed-reference`;
- `max_bytes`;
- обязательные identity/result fields;
- SHA-256 exact stored bytes.

Redaction policy работает allowlist-first. Она отдельно запрещает secret
values, authorization/cookie headers, private Mind content, download URLs и
сырой request/response body, если конкретная row не имеет более узкой безопасной
schema. Actor/credential evidence хранит actor class и opaque credential
reference/fingerprint, никогда credential value.

Redaction выполняется до persistence. Ссылка на unredacted transient log не
считается release artifact.

## 12. Production metadata

`production.ship_work_release_deploy_allowed` в schema v1 всегда `false`.
Никакая другая комбинация полей не может дать skill production authority.

При `configured: false`:

- `target`, `url` и `promotion_workflow_ref` равны `null`;
- `deploy_authority` равен `manual-only`;
- handoff requirements могут быть заполнены, но deploy operation отсутствует.

При `configured: true` target является `StableRef`, а
`promotion_workflow_ref` — tracked repository path или immutable external
workflow ref. Даже тогда skill только формирует handoff exact artifact и
evidence. Production workflow обязан отдельно получить explicit user prompt и
последнее подтверждение exact target/artifact непосредственно перед effect.

## 13. Runtime parameters

`runtime` содержит:

```yaml
grace:
  default_seconds: 300
  min_seconds: 30
  max_seconds: 900
quiet_heartbeat_seconds: 600
lanes:
  default_writable: 1
  max_writable: 3
retention:
  receipts:
    policy: keep-until-explicit-prune
    terminal_min_days: 30
  transient_logs_days: 7
deadline_enforcement:
  required_for_bounded_grace: true
  capability: codex/runtime-active-deadline/v1
  unavailable_behavior: reject-bounded-grace
```

Rules:

- `min <= default <= max`;
- `1 <= default_writable <= max_writable`;
- heartbeat находится в `60..3600` seconds;
- retention не удаляет receipts active run;
- `keep-until-explicit-prune` запрещает automatic destructive cleanup;
- deadline capability должна уметь независимо от следующего model turn
  зафиксировать истечение writer grace и fence late publication;
- при `reject-bounded-grace` coordinator предлагает checkpoint/hard-pause
  semantics, но не обещает bounded graceful pause;
- gate, CI, deploy и smoke используют собственные timeouts; writer grace их не
  обрывает и не расширяет.

## 14. Nullability и cross-field invariants

| Условие | Обязательное следствие |
|---|---|
| Любой `value_from`, fact source или assertion path | Exact path существует в `context.bindings`; type/source phase совместимы. |
| `ci.required=true` | Provider, stable refs, projection, reconcile и exact-SHA query non-null. |
| `ci.required=false` | Все provider/projection/query fields null. |
| `dev.configured=true` | Launch/readiness/cleanup и dev smoke rows non-null. |
| `dev.configured=false` | Остальные dev fields null/empty; dev evidence/claims запрещены. |
| `uat.configured=true` | `product_environment=uat`, `platform_deployment_class` non-null, `dev.configured=true` и `ci.required=true`; target/source/url/operations/rollback/smoke rows non-null; release cadence не `none`. |
| `uat.configured=false` | Product/platform classes null, UAT effects отсутствуют, cadence=`none`; production не используется как fallback. |
| `rollback.supported=true` | Stable selector, bootstrap, deploy/reconcile operation IDs и post-rollback rows существуют. |
| `production.configured=false` | Target/url/workflow null. |
| `production.configured=true` | Target/workflow non-null, но deploy-allowed всё равно false. |
| Evidence `required` | `when.always=true`; probe не manual. |
| Evidence `conditional` | Machine condition присутствует; prose condition запрещена. |
| Command `finite` | `success_codes` non-empty; `cleanup_codes` отсутствует. |
| Command `long-running` | Readiness consumer и cleanup contract существуют. |

Ссылка на отсутствующий command, operation, fact, row, redaction policy или
provider capability является hard validation error.

## 15. Fail-closed validation

До task-manager claim, Git ref mutation, process launch или provider effect
coordinator последовательно выполняет:

1. strict YAML parse и schema/version validation;
2. type/nullability/cross-field validation;
3. repository path containment и tracked-source resolution;
4. stable provider ref resolution read-by-ID;
5. command executable/environment/timeout validation без запуска commands;
6. task-manager, CI, dev-probe, UAT и deadline capability negotiation;
7. evidence graph validation: unique IDs, resolvable probes, acyclic
   references и total conditions;
8. profile hash и resolved-ref receipt.

Stable error classes:

- `PROFILE_PARSE_INVALID`;
- `PROFILE_SCHEMA_UNSUPPORTED`;
- `PROFILE_FIELD_INVALID`;
- `PROFILE_REF_UNRESOLVED`;
- `PROFILE_COMMAND_UNSAFE`;
- `PROFILE_CAPABILITY_UNAVAILABLE`;
- `PROFILE_EVIDENCE_INVALID`;
- `PROFILE_CONTRADICTION`.

Validation failure не запускает “best effort” fallback и не разрешает
coordinator-у угадывать command, target, secret, workflow, URL или evidence.
После drift profile bytes, sourced stable ID или provider capability preflight
повторяется на новой exact snapshot.
