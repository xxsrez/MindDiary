# ADR-0022: Site-controlled credential write target без read bindings

Статус: accepted, 2026-08-27. Решение MD-339 задаёт целевой access contract
Release 0.3. Оно является нормативным контрактом, но не утверждением о
реализованных storage records, routes, MCP schemas, migration или UAT
deployment.

ADR частично заменяет
[ADR-0013](0013-multiple-read-single-write-mind-bindings.md): отменяются
обязательные `read_bindings`, attach/detach как prerequisite content read,
MCP-управление write binding и fail-closed read только из-за пустого binding
set. Сохраняются credential-scoped owner, единственный writable destination,
fresh scope/ACL checks, versioned CAS, immutable stale fence, idempotency и
запрет implicit `/me`/last-used fallback. Historical Release 0.1/0.2 records и
evidence не переписываются задним числом.

## Контекст

ADR-0013 решал две разные задачи одним binding set: ограничивал источники
чтения и фиксировал единственный destination записи. В Release 0.3
пользовательская authority разделена иначе: Content MCP discover-ит и читает
каждый разрешённый Mind по explicit selector, а Sites control plane управляет
Connection/credential и выбирает единственный writable Mind.

Mutable read attachment больше не добавляет security boundary: current ACL,
visibility и `content:read` всё равно должны проверяться на каждом read. При
этом destination fence для model-driven commit остаётся необходимым: наличие
write ACL в нескольких Minds не должно позволять prompt/corpus переключить
target одного credential.

Нужен versioned переход, который не оживляет stale owner/binding, не переносит
target через reconnect/reissue и не выдаёт historical schema за уже
развёрнутое Release 0.3 behavior.

## Решение

1. Content read требует active credential с `content:read`, explicit Mind и
   revision selector и fresh current ACL либо baseline visibility grant.
   `public` discover-ится через authenticated catalog, `unlisted` — по exact
   handle, `private` — только по membership. Read-binding state отсутствует.
2. Каждый OAuth grant и каждый personal token получает отдельный immutable
   server-derived `binding_owner_id`. Один owner содержит versioned state с
   `0..1` active writable target. Rotating access/refresh tokens не меняют owner;
   reconnect и reissue создают новый owner с пустым target.
3. Select, switch и clear доступны только trusted Sites Web: ordinary
   Connection detail для OAuth и Advanced MCP для personal token. Там же живёт
   privacy-safe target inspect/read-back. Content MCP не имеет отдельного
   target inspection или mutation tool и не имеет administrative export
   authority; MD-337 владеет disposition MCP operations, MD-359 — Site export
   routes/projection. Corpus, prompt, model memory и read result target не
   выбирают.
4. Каждый material select/switch/clear увеличивает `target_version` и создаёт
   либо инвалидирует never-reused `target_generation`. Same-target select —
   idempotent no-op. Browser command использует actor-owned presentation ref,
   expected version, idempotency и server read-back; raw owner/credential/
   `space_id` не являются request authority. `select_write` требует current
   write scope, writer role и target eligibility. Recovery-safe `clear_write`
   требует credential-owner authority, active credential lifecycle, expected
   version и idempotency, но не target ACL/role/eligibility, поэтому остаётся
   доступен после target ACL/role loss или deletion без раскрытия target
   metadata. Revoked/expired credential не может выполнять clear: его
   owner/target уже unusable. Stale expected version получает MD-337 `409
   target_conflict`, zero state change и no last-write-wins.
5. Content commit передаёт explicit Mind, expected HEAD и idempotency key без
   `write_binding_id` или replacement generation field. Server разрешает и
   pin-ит current owner/target generation, а authoritative transaction требует
   тот же exact generation/Mind, `content:write`, current Editor/Admin/Owner,
   current target state и HEAD CAS. Любой stale, revoked, wrong-Mind,
   role-loss или unavailable-state case завершается без revision, HEAD, audit,
   index, staged-consumption или fallback side effect.
6. Automatic capture, если её operation остаётся после MD-337, является
   отдельной Sites-owned opt-in policy и pin-ится к тому же owner + exact
   target generation. Rebind/clear/revoke/delete disables it; visibility,
   scope, role, target generation и HEAD проверяются заново. Consent/payload не
   переносится в successor owner или generation.
7. Legacy owner начинает target-v1 migration в `pending_upgrade`. OAuth может
   сохранить target только после explicit re-consent внутри того же immutable
   grant и только при единственном непротиворечивом active legacy write target,
   current write scope/role и exact owner match. Иначе target становится
   пустым. Personal token требует reissue; новый token/owner всегда пуст.
   Reconnect также всегда пуст. Legacy read bindings не мигрируют в authority,
   old write IDs/staged refs не переводятся в новую generation, а ambiguous,
   corrupt или partially migrated state fail closed.

Полная record, lifecycle, migration, privacy, error и acceptance semantics
зафиксированы в
[credential writable-target specification](../specs/credential-write-target.md).
Exact keep/move/retire operation names, wire fields и canonical target errors
принадлежат MD-337; они не могут ослабить это решение. MD-339 использует
`expected_target_version`, `requires_writable_target`,
`writable_target_required`, `writable_target_mismatch` и
`writable_target_unavailable` без собственных конкурирующих aliases.
Site-only `target_conflict` также принадлежит MD-337 и не расширяет этот
трёхэлементный Content MCP error set.

## Последствия

- Пользователь может читать все текущие разрешённые Minds без обязательного
  attach onboarding, но один credential всё ещё не может записать в другой
  write-ACL Mind без явного Site switch.
- Target selection становится control-plane state, а не corpus-adjacent MCP
  mutation. Content surface не может расширить собственную destination
  authority.
- Reconnect/reissue требует нового явного выбора target. Это намеренная потеря
  удобства ради запрета скрытого переноса consent и pending payload.
- In-place OAuth preservation допустим только как same-owner migration после
  re-consent; наличие похожего principal, client, Mind name или old token не
  является достаточным доказательством.
- Historical ADR-0013 implementation/tests остаются evidence Release 0.1/0.2,
  но не доказывают Release 0.3 runtime или deployment.

## Отклонённые варианты

- **Оставить read bindings как optional security layer.** Два параллельных
  источника read authority создают drift и снова требуют attach onboarding;
  current ACL/visibility уже является authoritative boundary.
- **Разрешить MCP switch target.** Недоверенный corpus или prompt смог бы
  изменить destination непосредственно перед content write.
- **Principal-wide singleton.** Несвязанные grants/tokens одного пользователя
  меняли бы target друг другу и смешивали consent lifecycle.
- **Скопировать target при reconnect/reissue.** Новый credential owner не
  доказывает продолжение прежнего destination consent.
- **Принять legacy write ID как новую generation.** Он относится к другой
  schema/lifecycle и может оживить stale или ambiguous state.
- **Fallback на Personal Mind или единственный writable ACL Mind.** Такой
  fallback скрывает destination и превращает missing/corrupt state в write.
- **Сохранить capture при любой миграции target.** Destination consent не
  равен automatic-capture consent и не переносится между generations.
