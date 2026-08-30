# ADR-0013: multiple-read/single-write Mind bindings

Статус: accepted historical Release 0.1/0.2, 2026-08-22; target semantics
superseded [ADR-0024](0024-principal-mind-usage-modes-and-automatic-save.md),
2026-08-30. Ранний Release 0.3 replacement через ADR-0022 также historical.
Решение изменяет
principal-wide content access из
[ADR-0003](0003-user-scoped-mcp-and-direct-commits.md), но сохраняет один MCP
connection на principal, explicit single-Mind operations и immediate commits.

Для Release 0.3 больше не действуют обязательные `read_bindings`, attach/detach
как prerequisite content read, MCP mutation binding state и denial content
read только из-за empty binding set. Сохраняются historical implementation и
evidence, а также credential-scoped singleton destination, fresh ACL/scope,
versioned CAS/idempotency, stale fence и запрет implicit fallback. Их целевая
форма задана ADR-0022; этот документ не переписывает историю 0.1/0.2.

## Контекст

До этого OAuth grant либо personal token с `content:write` позволял агенту
последовательно commit-ить в любой Mind, где principal имеет current write ACL.
Server ограничивал один call одним Mind, но не фиксировал единственный writable
target рабочего connection. Prompt/model мог выбрать другой разрешённый Mind,
а stable chat/session identity для authoritative selection у stateless MCP не
существует.

Нужна server-side destination boundary, не меняющая ACL и не создающая
principal-wide implicit cross-Mind retrieval.

## Решение

- Каждый stable authorization artifact владеет независимым binding set: OAuth
  использует immutable grant, personal-token path — immutable `token_id`.
- Binding set содержит `0..N` read targets и `0..1` active write target.
- Effective content read требует current ACL и read binding либо write binding;
  effective write дополнительно требует `content:write` и exact active immutable
  `write_binding_id`.
- Bind/rebind/unbind используют monotonic `binding_version`, expected-version
  CAS и idempotency. Rebind атомарно инвалидирует previous ID; старый ID никогда
  не оживает.
- Discovery доступных Minds остаётся отдельным от attachment. No binding не
  выбирает `/me` и не разрешает content access по прежнему principal-wide
  поведению.
- Modern и compatibility MCP profiles вызывают один application contract.
  Existing grants/tokens начинают с пустого state; старый client получает
  actionable fail-closed error, а не hidden fallback.
- Binding не включает automatic capture. Отдельная opt-in/privacy/provenance
  policy обязательна до автоматических writes.

Полный record, lifecycle, tool, error и rollout contract находится в
[specification Mind bindings](../specs/mind-bindings.md).

## Последствия

- ACL отвечает за maximum authority principal, binding — за narrower authority
  конкретного grant/token. Write ACL на нескольких Minds больше не означает,
  что один agent connection может писать во все сразу.
- Rebind race не перенаправляет подготовленный payload: commit со stale ID не
  пишет ни в старый, ни в новый Mind.
- Один principal может иметь несколько independent grants/tokens, каждый с
  собственным singleton target. Глобальный principal-wide singleton отклонён,
  потому что он связывал бы несвязанные clients и создавал неожиданные races.
- Service metadata, audit и persistence расширяются, но OKF/revisions/export не
  содержат binding records.
- Plugin/UI должны показывать exact active target и version; model memory,
  последний search и corpus instructions не могут выбирать destination.

## Отклонённые варианты

- **Principal-wide singleton.** Несвязанные clients меняли бы target друг
  другу; OAuth grant/token уже даёт stable server identity нужной granularity.
- **Chat/session-scoped state.** Current MCP profiles stateless и не доказывают
  stable, trusted chat ID.
- **Token scope или ACL как binding.** Они дают authority, но не однозначный
  destination и не решают wrong-Mind write.
- **Implicit Personal Mind.** Fail-open default скрывает destination и делает
  reconnect/revoke semantics неоднозначными.
- **Передавать только `mind` в commit.** Selector остаётся request input и не
  доказывает, что target всё ещё active после concurrent rebind.
- **Включить automatic capture одновременно.** Destination binding не решает
  consent, provenance, sensitivity или disclosure policy.
