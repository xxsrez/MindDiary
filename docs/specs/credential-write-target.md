# Credential-scoped writable target Release 0.3

Статус: historical early Release 0.3 contract, локально реализован MD-343,
2026-08-28; target authority superseded MD-373 в
[principal Mind usage contract](mind-usage-modes.md), 2026-08-30.
Документ MD-339 определяет access/binding replacement для Release 0.3.
Repository candidate включает durable state/migration, Sites REST/UI и
write-path generation fence; hosted UAT evidence для exact candidate остаётся
отдельным release gate. Exact disposition historical operation names/routes
принадлежит MD-337; его wire fields и target error taxonomy являются
authoritative для этой specification.

Ниже сохранён прежний credential-scoped design и его evidence. Он не задаёт
текущий target: mode теперь принадлежит principal, shared всеми credentials,
а отдельного writable-target/capture control нет. Историческое решение принято в
[ADR-0022](../decisions/0022-site-controlled-credential-write-target.md).
[Historical Mind bindings](mind-bindings.md) остаются evidence Release
0.1/0.2 и не являются target authority.

## Цель и границы

Contract разделяет две независимые проверки:

```text
effective_read = active credential
               ∩ content:read
               ∩ explicit Mind + exact resolved revision
               ∩ current membership or baseline visibility grant

effective_write = active credential
                ∩ content:write
                ∩ current Editor/Admin/Owner role
                ∩ exact owner + active target generation + exact Mind
                ∩ expected HEAD + idempotency
```

Read-binding/attach state в target model отсутствует. Writable target не даёт
membership, visibility, scope или role и не кэширует их. Он только сужает
destination уже существующей write authority одного credential.

MD-339 задаёт контракт, а MD-343 реализует runtime/storage migration и
actor-owned target projection/mutation. Конкретный общий tool catalog,
import/export disposition, token format, OAuth protocol redesign,
production/AWS deployment и новый automatic-capture product profile остаются
вне ownership MD-339.

## Read authorization без binding state

Каждый read call передаёт один explicit Mind. Revision selector может быть
omitted только как точное обозначение HEAD: server в начале call разрешает его
в immutable `resolved_revision_id`; historical selector также разрешается
ровно один раз. Затем server проверяет current credential, scope и доступ до
metadata/object/index read:

| Mind state | Authenticated caller read |
|---|---|
| Personal `/me` | Только собственный principal, разрешённый из trusted actor. |
| Ordinary `private` | Только current active membership с read capability. |
| Ordinary `unlisted` | Membership либо authenticated exact-handle resolve; catalog enumeration запрещена. |
| Ordinary `public` | Membership либо authenticated public catalog/exact resolve. |
| Historical revision | Те же current rules; старые ACL не восстанавливаются. |

`content:write` включает `content:read`, но write target не нужен для browse,
search, fetch, history, standalone validation или exact-revision BundleFile
read. Empty/missing/corrupt historical read-binding records не блокируют и не
расширяют read. Cross-Mind query отсутствует: каждый call всё равно выбирает
ровно один Mind.

## Authoritative owner и records

`binding_owner_id` остаётся internal server-derived identity stable
authorization artifact:

- OAuth owner принадлежит immutable grant, а не rotating access/refresh token;
- personal-token owner принадлежит immutable token record;
- два grants/tokens одного principal имеют независимые states;
- client не передаёт owner, credential ID, principal, role или `space_id`.

Целевая минимальная модель:

```text
CredentialWriteTargetState:
  binding_owner_id          # immutable, server-derived
  principal_id              # current owner principal, not request authority
  credential_kind           # oauth_grant | personal_token
  contract_version          # credential-write-target/v1
  lifecycle                 # active | pending_upgrade | revoked | deleted
  target_version            # monotonic unsigned integer, initial 0
  active_target_generation? # nullable, at most one
  created_at
  updated_at

WritableTargetGeneration:
  target_generation         # opaque immutable ID, never reused/reactivated
  binding_owner_id
  space_id
  generation_number         # monotonic within owner
  selected_at
  invalidated_at?
```

Storage enforces at most one active generation per owner. ACL, role,
visibility, scopes, HEAD, name и route не хранятся в generation как authority.
Inactive generations остаются tombstones достаточно долго для deterministic
stale denial; exact retention задаётся implementation policy без повторного
использования ID.

## Lifecycle и concurrency

| Event | Result |
|---|---|
| New OAuth grant/personal token | Active v1 owner, `target_version=0`, target `null`. |
| Select при empty target | Fresh scope/role check; создаётся new generation, version +1. |
| Switch на другой Mind | Previous generation invalidated и new generation created одной transaction, version +1. |
| Select exact same active Mind | Idempotent no-op; generation/version сохраняются. |
| Clear | Active generation invalidated, target `null`, version +1. |
| OAuth access/refresh rotation | Same grant owner и target сохраняются. |
| Revoke/expiry | Owner/target немедленно unusable; no fallback. |
| Reconnect | New grant/owner с empty target; old owner не оживает. |
| Personal token reissue | New token/owner с empty target; old target не копируется. |
| ACL/role loss | Target record может остаться для safe clear, но commit fail closed. |
| Visibility change | Read пересчитывается; write по-прежнему требует current writer membership. |
| Mind deletion | Generation unusable и затем reconciled/tombstoned; no replacement target. |
| Corrupt/unavailable state | Inspect/mutation/commit fail closed без guessed target. |

Каждая Site mutation требует canonical `expected_target_version` и idempotency
key. Transaction разрешает exact owner из trusted presentation ref и применяет
action-specific checks ниже. Idempotency namespace — `binding_owner_id +
writable-target-operation + key`. Exact replay возвращает прежний result;
changed payload — `idempotency_conflict`.

Stale `expected_target_version` всегда возвращает принадлежащий реестру MD-337
Site-only `409 target_conflict`: target state не меняется, target metadata не
раскрывается, last-write-wins запрещён. `target_conflict` не является четвёртой
Content MCP writable-target ошибкой и не переопределяется MD-339.

## Sites control plane

Select, switch и clear вызываются только authenticated trusted Web adapter.
Общие требования к обеим action: current Sites principal, actor-owned opaque
credential presentation ref, подтверждённая credential-owner authority,
`expected_target_version`, idempotency key и fresh server read-back.

Action-specific authorization намеренно различается:

- `select_write` (включая switch) требует server-resolved `mind_ref`, active
  credential lifecycle, current `content:write`, current
  `editor | admin | owner` role и eligibility выбранного target;
- `clear_write` не принимает `mind_ref`, но требует active credential
  lifecycle. Он не требует current target ACL, writer role или target
  eligibility. Exact owner active credential может очистить target после
  ACL/role loss или Mind deletion. Это recovery-safe reduction authority;
  response не раскрывает stale target metadata. Revoked/expired credential
  очистить target не может: его owner/target уже unusable и mutation fail
  closed без target metadata.

Surface остаётся Site-owned:

- ordinary OAuth — actor-owned Connection detail;
- personal token — actor-owned Advanced MCP detail;
- raw grant/token/owner/generation/`space_id` не попадает в browser URL, form,
  DOM, analytics или user-facing error;
- success заканчивается fresh server read-back; UI не строит state из request;
- stale CAS не меняет generation/version и не возвращает target metadata.

Connection detail показывает derived readable access projection, а не
persisted read bindings. Такой список — bounded snapshot current ACL/
visibility; он не является prerequisite content read и не переносится в MCP
как authority.

## MCP и content commit

Content MCP не публикует target-management или отдельный target-inspection
tool: MD-337 удаляет historical `get_mind_bindings`,
`set_read_mind_binding` и `set_write_mind_binding` из обоих catalogs. Current
target inspect/read-back живёт на actor-owned Site Connection/Advanced MCP
projection. Content tools только предъявляют explicit Mind и получают
canonical `writable_target_required | writable_target_mismatch |
writable_target_unavailable` без private target metadata. Capability report
использует canonical boolean `requires_writable_target`, не historical
`requires_write_binding`.

Административная export authority в Content MCP также отсутствует:
`start_export` и `get_export_status` удаляются из обоих catalogs по MD-337.
MD-359 владеет Site export routes и projection; MD-339 не дублирует их design.
Обычные explicit content reads/BundleFile delivery от этого не получают
административную export capability.

Целевая content commit shape содержит минимум:

```json
{
  "mind": "research-notes",
  "expected_revision": "rev_current",
  "idempotency_key": "01J...",
  "operations": []
}
```

`mind` остаётся explicit cross-check, но не authority. Client не передаёт
`binding_owner_id`, target generation/version, `write_binding_id`, role или
scope. Authoritative transaction:

1. аутентифицирует current credential и получает exact immutable owner;
2. требует `content:write`;
3. читает current active target state и pin-ит exact generation внутри trusted
   application context;
4. разрешает `mind` и требует совпадение `space_id`;
5. проверяет current active role `editor | admin | owner`;
6. внутри transaction повторно требует тот же owner + generation и проверяет
   staged refs/automatic policy against them;
7. проверяет `expected_revision`, validation, quotas и idempotency;
8. одной transaction создаёт revision, продвигает HEAD, consumes exact staged
   refs и пишет audit/outbox либо не меняет ничего.

Idempotency namespace включает owner + target generation + `space_id` +
operation + key. Rebind/clear/revoke между prepare и transaction, wrong Mind,
stale HEAD, scope/role loss или corrupt state не перенаправляют payload в
previous/current/Personal/«единственный доступный» Mind. No-write outcome не
создаёт reachable object, revision, HEAD, audit/outbox/index effect и не
consumes staged ref.

Historical `write_binding_id` и `expected_binding_version` удалены из target
content schemas, а replacement generation field не добавляется. Protocol
compatibility profiles могут иметь разные envelopes, но вызывают одну
semantics. MD-337 не сохраняет old MCP aliases: exact calls fail explicitly,
silent translation old ID или target mutation через MCP запрещены.

## Capture, staging и in-flight work

Automatic capture остаётся отдельным default-off Sites consent. Если operation
сохраняется после MD-337, policy record содержит exact
`binding_owner_id + target_generation`; enable требует active target,
`content:write`, writer role и private visibility. Capture transaction
повторяет owner/generation/scope/role/visibility/HEAD checks.

Switch, clear, revoke, expiry, delete или generation migration disables policy
до новой explicit Site action. Policy/payload никогда не переносится в new
generation/owner. ACL/scope/visibility drift даёт no-write даже если record ещё
существует.

Новые staged refs также pin-ятся к exact owner + target generation. Pre-v1
legacy staged refs не remap-ятся: пользователь заново stages bytes после
successful upgrade. Уже committed immutable revisions не меняются.

## Versioned migration Release 0.1/0.2 → 0.3

Rollout использует capability `credential-write-target/v1` и fail-closed
owner-level state. Target runtime cut не считается выполненным до joined
schema/application/client evidence.

### Общие правила

1. Каждый legacy owner сначала становится `pending_upgrade` и fail closed до
   explicit upgrade/re-consent/reissue. Ни discovery, ни content read не
   вычисляют доступные Minds из ACL/visibility для такого credential. Они
   возвращают один non-disclosing compatibility result с code
   `credential_access_upgrade_required`, schema
   `mind-diary/credential-access-upgrade-required/v1`, `retryable=false` и
   remediation только `upgrade | re-consent | reissue`; Mind ID, handle, name,
   visibility, revision и binding evidence в result отсутствуют.
2. Legacy `0..N` read records не становятся v1 authority, не ограничивают read
   fresh/upgraded credential и после safety window могут быть
   удалены/tombstoned. После успешного upgrade/re-consent/reissue read сразу
   использует current ACL/visibility без mutable read-binding state.
3. Old write binding ID, generation, target version и staged ref не принимаются
   в v1 commit. Pending/unknown historical attempt не возобновляется.
4. Уже committed revision/idempotency result остаётся историческим фактом и
   может быть reconciled как immutable result; migration не повторяет effect.
5. Ambiguous, duplicate, foreign-owner, corrupt, partially migrated или
   unavailable state получает empty target либо terminal unavailable error,
   но никогда guessed target.
6. First-party credential administration не превращает отсутствующий
   normalized owner record у уже principal-scoped active legacy credential в
   общий `403`: Connections показывает `re-consent required`, Advanced MCP —
   `reissue required`. До remediation обе проекции имеют empty target и не
   содержат ACL-derived Mind names, routes или selectable candidates.

### OAuth grant

In-place target preservation разрешено только после explicit re-consent к v1
в том же immutable active grant и при одновременном выполнении всех условий:

- owner до и после upgrade совпадает byte-for-byte;
- существует ровно один active legacy write record и zero contradictory active
  generations;
- target разрешается в ровно один active Mind;
- current grant имеет `content:write`;
- current principal имеет writer role exact target;
- current state доступен и migration transaction может атомарно создать одну
  new v1 generation.

Сохраняется только `space_id`: old ID/version не переиспользуются. Any failed
condition даёт active v1 owner с empty target и требует Site select. Если OAuth
host не может re-consent внутри same grant, reconnect создаёт new owner empty;
target copy запрещён.

### Personal token

Legacy personal token не получает v1 write authority in place. Advanced MCP
показывает `reissue required`; новый token получает new immutable owner и empty
target. Старый token до revoke/expiry может читать по current scope/ACL, но его
commit fail closed с `writable_target_required`. Secret/token record,
target, capture consent и pending payload не копируются.

### Automatic capture migration

Default migration outcome — disabled. Same-owner OAuth preservation может
перепривязать policy к new generation только отдельной explicit Site
confirmation и только если old policy однозначно pin-илась к preserved old
write record, target остаётся private и current scope/role действуют. Без
любого условия policy disabled. Reconnect/reissue всегда disabled.

## Error semantics и privacy

| Code | Meaning |
|---|---|
| `credential_access_upgrade_required` | Credential ещё не перешёл на `credential-write-target/v1`; discovery/read fail closed без Mind metadata. Разрешённая remediation: upgrade/re-consent/reissue. |
| `writable_target_required` | Active v1 target отсутствует; включает `pending_upgrade`, а re-consent/reissue показывается как Site state/remediation, не отдельный code. |
| `writable_target_mismatch` | Explicit Mind не совпадает с current selected target; metadata другого target не раскрывается. |
| `writable_target_unavailable` | Owner revoked/expired/deleted, pinned generation stale, target/state corrupt/partial/unavailable либо target deleted. |

Это exact canonical set MD-337. Historical `write_binding_required`,
`write_binding_stale`, `binding_owner_revoked`, `binding_state_unavailable` и
собственные `write_target_*` aliases retired; они не map-ятся в hidden success
и не позволяют old IDs. Missing/foreign/wrong-owner/private denial остаётся
indistinguishable до authorization. Logs/audit/telemetry не содержат raw
credential/owner/generation IDs, private Mind metadata, prompt, content,
staged locator или target-selection request body.

Отдельный `target_conflict` принадлежит только Sites mutation register MD-337:
он означает stale `expected_target_version`, всегда даёт zero state change,
zero target metadata disclosure и запрещает last-write-wins. Он не добавляется
в таблицу Content MCP ошибок выше.

## Acceptance matrix

Machine-readable closed contract:
[`tests/fixtures/credential-write-target/contract.v1.json`](../../tests/fixtures/credential-write-target/contract.v1.json).
Минимальное objective evidence должно проверить:

1. private/member, public catalog, exact-handle unlisted и historical current-
   access read без read binding;
2. owner isolation для двух grants/tokens одного principal;
3. Site-only select/switch/clear/inspect, action-specific authorization,
   recovery-safe clear после ACL/role loss/deletion, version CAS,
   `target_conflict`, idempotent same-target и отсутствие MCP target
   inspection/mutation;
4. exact generation/Mind/scope/role/HEAD/idempotency commit и zero side effects
   для stale/revoke/wrong-Mind/access-loss/corrupt state;
5. OAuth refresh preservation, reconnect/reissue empty target и no owner copy;
6. explicit legacy re-consent/reissue, exact unambiguous same-owner preservation
   и ambiguous/corrupt fail-closed path;
7. capture/staged generation pinning, no transfer and fail-closed migration;
8. отсутствие administrative export authority в Content MCP с disposition в
   MD-337 и Site route/projection ownership в MD-359;
9. modern/compatibility protocol envelopes invoking one target-v1 application
   semantics without legacy ID/replacement-generation wire fields.
