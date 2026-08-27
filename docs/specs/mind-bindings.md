# Multiple-read/single-write Mind bindings

Статус: accepted historical Release 0.1/0.2 as-built/evidence contract,
обновлено 2026-08-27; target replacement принят MD-339 в
[credential writable-target contract](credential-write-target.md), а exact
operation disposition ожидает MD-337. Локальные
durable state/application/persistence (`MD-231`), одинаковый binding tool
surface для modern/compatibility MCP (`MD-230`) и hard content enforcement
(`MD-232`) подтверждены. Product UI и exact Marketplace plugin guidance
(`MD-233`) подтверждены локально. Canonical release profile содержит blocking
`dev.mind-bindings` и `uat.mind-bindings` join (`MD-235`); UAT evidence остаётся
привязанным к конкретному candidate/deployment и не выводится из local tests.

Этот документ остаётся historical Release 0.1/0.2 as-built contract и evidence
source. Он не определяет target authority Release 0.3: read не требует
explicit binding/attach, а единственный writable target выбирается и меняется
только через Sites control plane. Content MCP может discover/read explicit
Mind и commit-ить в server-approved exact target, но не управляет binding/
Connection state. Exact replacement records, migration and compatibility
зафиксированы в новом target contract; keep/move/retire disposition existing
operations — MD-337. До runtime migration historical implementation и UAT
receipts ниже сохраняют прежнюю semantics без silent migration.

## Historical Release 0.1/0.2 назначение

Mind ACL и token scopes отвечают на вопрос, **что principal в принципе может
сделать**. Binding state отвечает на другой вопрос: **какие Minds конкретный
agent connection сейчас использует для content read и куда он единственно
может писать**. Binding не создаёт membership, не расширяет visibility grant и
не заменяет fresh authorization.

Принятый инвариант:

```text
read_bindings: Set<space_id>    # 0..N
write_binding: space_id | null  # 0..1

effective_read  = current ACL read
                ∩ (read_bindings ∪ write_binding)
effective_write = current ACL write
                ∩ effective content:write scope
                ∩ exact active write_binding
```

Writable target неявно доступен для необходимого read-before-write. Отдельная
read binding на него допустима, но не обязательна. Rebind не меняет множество
read bindings. Предыдущий target после rebind остаётся readable только при
отдельной active read binding. Fallback на Personal Mind, последний открытый
Mind, похожее имя или любой другой доступный Mind запрещён.

## Authoritative owner и scope

Binding set принадлежит одному stable server-side authorization artifact, а не
principal целиком и не недоказанному chat/session ID:

- для OAuth — immutable `oauth_grant_id`, сохраняющийся при access-token expiry
  и refresh rotation;
- для advanced personal-token path — immutable `token_id` до revoke/expiry.

Server создаёт opaque `binding_owner_id` из trusted authentication result.
Client не передаёт owner, principal, role или internal `space_id`. Два grants
или два personal tokens одного principal имеют независимые binding sets; в
каждом из них действует singleton write invariant. Reconnect создаёт новый
grant и новый пустой binding set, а не оживляет прежний.

MCP protocol profile не является owner. Modern `2026-07-28` и isolated
compatibility `2025-11-25` разрешают один и тот же binding owner и вызывают один
application contract, сохраняя разный transport lifecycle.

## Service records

Binding metadata не входит в OKF, `SpaceRevision`, export или search index.
Минимальная authoritative модель:

```text
MindBindingSet:
  binding_owner_id
  principal_id
  binding_version          # monotonic unsigned integer, initial 0
  status                    # active | revoked | deleted
  created_at
  updated_at

ReadMindBinding:
  read_binding_id           # immutable, never reused
  binding_owner_id
  space_id
  created_at
  invalidated_at?

WriteMindBinding:
  write_binding_id          # immutable, never reused or reactivated
  binding_owner_id
  space_id
  generation                # equals binding_version at activation
  created_at
  invalidated_at?
```

Storage enforces uniqueness of one active read record per owner/space and at
most one active write record per owner. ACL, role, visibility, HEAD и scopes не
кэшируются в records как authority. Они перечитываются при mutation и каждой
content operation.

`binding_version` увеличивается ровно один раз при каждом effective attach,
detach, bind, rebind или unbind. Идемпотентный no-op возвращает current state и
не увеличивает version. Каждый успешно replaced/unbound write record остаётся
неактивным tombstone на период, достаточный для deterministic stale denial;
его ID никогда не назначается снова.

## Lifecycle

Начальное состояние каждого нового OAuth grant или personal token пустое:
`binding_version = 0`, read bindings отсутствуют, write binding отсутствует.
Сам факт OAuth consent либо наличие `content:write` не выбирает Mind.

| Event | Binding outcome |
| --- | --- |
| Attach read | При current read access создаёт один active read record. |
| Detach read | Инвалидирует exact read record; write binding не меняется. |
| Bind при zero write | При current write ACL + `content:write` создаёт новый immutable write ID. |
| Bind при active write | Атомарно инвалидирует previous и создаёт новый ID; это rebind. |
| Bind того же active target | Идемпотентный no-op, current ID/version сохраняются. |
| Unbind | Атомарно инвалидирует active write; zero target становится явным state. |
| Access-token refresh | Binding set того же OAuth grant сохраняется. |
| Grant/token revoke или expiry | Owner и все bindings немедленно unusable; hidden fallback отсутствует. |
| Reconnect/new personal token | Новый пустой owner; старые IDs не оживают. |
| ACL/visibility loss | Следующий call fail closed; inspection не раскрывает уже недоступный target. |
| Mind deletion | Target bindings становятся unusable и затем идемпотентно tombstone/delete-ятся. |
| Account deletion | Все binding owners и target-linked records удаляются общим cascade. |
| Corrupt state | Mutation/content call возвращает safe unavailable error, не выбирает fallback. |

Изменение `public | unlisted | private` само по себе не отменяет binding, если
current principal всё ещё имеет нужную capability. Оно всегда вызывает fresh
authorization и может сделать binding unusable для non-member baseline reader.

## Concurrency и idempotency

Каждая binding mutation обязана передать `expected_binding_version` и
`idempotency_key`. Atomic transaction:

1. разрешает trusted binding owner и current record;
2. сверяет expected version;
3. разрешает target и проверяет current ACL/scope;
4. инвалидирует previous record и/или создаёт новый;
5. увеличивает `binding_version` один раз;
6. сохраняет canonical result + request hash и privacy-safe audit/outbox.

Idempotency namespace — `binding_owner_id + operation + key`. Replay exact
payload возвращает исходный result даже после последующих transitions; тот же
key с другим payload получает `idempotency_conflict`. Stale expected version не
перетирает новый state и возвращает `binding_version_conflict` с current
version, но без metadata недоступных Minds.

`commit_changeset` передаёт immutable `write_binding_id`, explicit `mind` и
`expected_revision`. Authoritative commit path внутри metadata transaction
проверяет, что ID всё ещё active, указывает на exact resolved Mind и принадлежит
текущему binding owner, затем повторяет scope/ACL и HEAD CAS. Rebind между
preparation и commit возвращает `write_binding_stale`; payload не переносится
ни в previous, ни в current target и не создаёт revision/audit/index side
effect. Content idempotency namespace дополнительно включает
`write_binding_id`, поэтому replay не пересекает generation.

## MCP tool surface

Binding management — service metadata внутри content MCP, но не Mind content и
не membership/control plane. Приняты exact names:

### `get_mind_bindings`

Read-only inspection current owner. Требует `content:read`. Возвращает
`binding_version`, active read bindings и active write binding. Для current
accessible target допустимы safe `MindDescriptor`; потерявший доступ target
возвращается только как redacted `unavailable` state либо уже отсутствует после
reconcile.

### `set_read_mind_binding`

Input: `action: attach | detach`, explicit `mind`,
`expected_binding_version`, `idempotency_key`. Требует `content:read`. Attach
проверяет current read capability. Detach exact inaccessible/stale target
остаётся idempotent и не раскрывает metadata.

### `set_write_mind_binding`

Input: `action: bind | unbind`, `mind` только для bind,
`expected_binding_version`, `idempotency_key`. Bind требует effective
`content:write` и current write ACL; unbind требует current owner, но не
сохранившийся ACL target. Response всегда показывает `previous` и `current` в
privacy-safe форме, новый `binding_version` и active `write_binding_id` либо
`null`. Rebind — обычный `bind` при уже active target.

Mutation schemas запрещают unknown fields и array write targets. Annotations
честно отражают service-state mutation; corpus text, fetched instructions и
model memory не являются authorization evidence для tool call.

Discovery `list_minds`, `resolve_mind` и safe `get_mind_info` по-прежнему
показывают targets, которые principal может подключить. Browse, search, fetch,
history, validation, Resources и export требуют active read binding либо exact
write binding. Discovery не считается attach. Arbitrary `mind` selector не
является write authority.

## Product Site control projection

Authenticated `/settings/connections/{connection_ref}` показывает authoritative
binding set active OAuth grant через actor-owned presentation projection, а
`/settings/developer/mcp` отдельно показывает personal-token control:

- `Attached read-only Minds` — `0..N` current read bindings;
- `Active writable Mind` — один exact target либо `Not bound`;
- current `binding_version`, name, route и visibility только для Minds, которые
  current Sites principal ещё вправе видеть;
- `Access unavailable` без `space_id`, name или route после ACL/visibility
  loss; credential-owned opaque read binding остаётся removable;
- revoked/expired OAuth connection скрыта из ordinary detail; Advanced
  personal-token history может показать lifecycle/recovery metadata, но без
  mutation controls.

Ordinary browser mutation идёт через
`PATCH /api/v1/connections/{connection_ref}/mind-access` с same-origin CSRF,
`Idempotency-Key`, exact action и `expected_binding_version`. Route parameter —
отдельный presentation locator: server разрешает его внутри current actor и
заново подтверждает ownership, active lifecycle и
effective scope exact credential. `mind_ref` разрешается server-side; browser
не передаёт `space_id`, principal, role или grant claim. Attach/bind повторяют
fresh ACL authorization; detach/unbind не требуют сохранившегося target ACL,
но остаются bound к exact current owner/version.

Success возвращает safe changed/replayed/version projection, после чего page
делает full server read-back. `binding_version_conflict`, revoke, scope/ACL
loss и storage unavailable не приводят к automatic rebind или переносу
payload. UI отдельно предупреждает: switch немедленно снимает write authority
с previous target; `unlisted`/`public` visibility делает новые commits
доступными соответствующим authenticated readers, а binding не меняет этот
visibility effect.

Raw OAuth grant, token и binding-owner IDs запрещены в ordinary URL/DOM;
unknown, foreign и revoked refs возвращают identical `404` до metadata. Exact
list/detail/cursor/state contract находится в
[Connections, Advanced MCP и Codex Help](connection-experience.md).

Advanced personal-token mutation использует отдельный actor-owned
`personal_token_ref` в
`PATCH /api/v1/mcp-tokens/{personal_token_ref}/mind-access`; raw token ID и
`binding_owner_id` не являются Product Site route contract. Internal adapter
разрешает presentation ref в exact binding owner только после actor scope и
затем применяет тот же `binding_version`/CAS.

## Errors

Application codes одинаковы в обоих protocol profiles:

| Code | Meaning |
| --- | --- |
| `mind_binding_required` | Content read target не подключён. |
| `write_binding_required` | Active writable target отсутствует. |
| `write_binding_stale` | Переданный write ID больше не active/exact. |
| `binding_version_conflict` | Mutation построена на stale binding version. |
| `binding_owner_revoked` | Grant/token больше не может использовать bindings. |
| `binding_state_unavailable` | Persisted state malformed или временно недоступен. |
| `mind_unavailable` | Target отсутствует, недоступен либо неразличим по privacy policy. |

Scope/ACL/HEAD/idempotency errors сохраняют существующие codes. Modern и
compatibility adapters меняют только protocol envelope, не application
semantics.

## Compatibility и rollout

Переход — versioned fail-closed capability `mind-bindings/v1`, без silent
Personal Mind default:

1. Сначала deploy-ятся storage/application/tool schemas и обновлённый plugin
   skill как один exact candidate.
2. Existing OAuth grants и personal tokens получают empty binding set при
   первом read; credential lifecycle и scopes не мигрируют и не меняются.
3. Старый client/tool snapshot может продолжать discovery, но content call без
   binding получает actionable `mind_binding_required`; commit без immutable
   ID — `write_binding_required`. Server не имитирует прежний principal-wide
   content access.
4. На переходном wire contract `commit_changeset.mind` сохраняется как explicit
   cross-check, а `write_binding_id` становится обязательным. После отдельного
   versioned API решения redundant selector может быть удалён.
5. Modern и compatibility `tools/list` публикуют одинаковые binding schemas;
   OAuth direct package остаётся на modern route, personal-token clients могут
   использовать оба доказанных profiles.
6. Production не затрагивается. UAT promotion требует persistence,
   concurrency, revoke/delete, no-side-effect и fresh plugin evidence.

## Automatic capture и provenance boundary

Binding разрешает destination selection, но **не включает automatic capture**.
Отдельный [automatic-capture contract](automatic-capture.md) теперь локально
реализован как per-credential opt-in state, pinned к exact active
`write_binding_id`. Content, prompt, source Mind или OAuth grant по-прежнему не
могут включить capture.

Initial profile допускает только bounded additive routine/non-sensitive Memory
в private target. Private/read-only source нельзя автоматически переносить в
другой, unlisted или public target только потому, что principal имеет доступ к
обоим. Rebind/unbind/revoke/delete отключают policy; visibility/ACL/HEAD либо
общий binding-version drift останавливают attempt. Payload никогда не
переносится в новый target автоматически. Replace/delete/index и
visibility-impacting действия сохраняют отдельную preview/confirmation boundary.

## Открытые вопросы вне этого решения

- Срок хранения inactive binding tombstones после того, как все supported
  clients гарантированно перестанут посылать старые IDs.
- Нужна ли future UI-managed grouping нескольких grants в один user-visible
  workspace; release 0.1 сохраняет независимый state каждого authorization
  artifact.
- Future sensitive profiles, external/cross-Mind provenance и capture в
  non-private targets требуют отдельных product решений.
