# ADR-0020: Connections IA и безопасные presentation projections

Статус: accepted, 2026-08-24. Решение уточняет Product Site часть
[ADR-0010](0010-oauth-marketplace-connector.md),
[ADR-0011](0011-direct-mcp-plugin-oauth-on-use.md) и
[ADR-0013](0013-multiple-read-single-write-mind-bindings.md), не меняя их
OAuth, ACL, scope, CAS, revoke или binding invariants.

## Контекст

Текущая `/settings/mcp` смешивает ordinary OAuth connection, personal tokens,
endpoint diagnostics, binding internals и automatic capture. Raw grant/token/
binding locators попадают в server-rendered forms. Это делает первый Codex
workflow протокольным, затрудняет безопасный actor-owned detail route и не
позволяет отдельно ограничить active OAuth list и credential history.

Release 0.1 должен проверять понятный Codex-first результат: установить,
разрешить чтение и отдельно повысить права при первой записи. Пользователь не
должен понимать DCR, PKCE, scopes или внутреннюю модель binding owner.

## Решение

- Canonical ordinary routes — `/settings/connections` и actor-owned
  `/settings/connections/{connection_ref}`. Advanced personal-token/protocol
  surface — `/settings/developer/mcp`, user help — `/help/codex`.
  `/settings/mcp` сохраняется как compatibility entrypoint в Advanced MCP.
- OAuth grant получает отдельный durable `conn_v1_` ref, а personal token —
  отдельный `ptok_v1_` ref; оба состоят из 16 random bytes в lowercase hex.
  Raw OAuth, token и binding IDs запрещены в URL/DOM/browser response. Unknown,
  foreign и revoked/hidden connection ref возвращают identical `404` до metadata.
- Ordinary list читает только bounded page active OAuth grants и bindings exact
  этой page. OAuth retained history не заявляется. Revoke означает revoke +
  hide; physical deletion и retention policy отложены.
- Personal-token active/revoked/expired history остаётся в Advanced MCP и имеет
  собственный bounded actor-bound cursor.
- Ordinary language — `Can read` и `Can add and change`. Write controls
  отсутствуют до native incremental step-up; после него binding сохраняет
  `0..1` writable Mind с current CAS.
- Основной onboarding содержит только install, read consent и optional write
  step-up. Automatic capture не показывается в ordinary Connections и не
  блокирует Release 0.1.
- Deterministic server step-up и fresh installed-host UX проверяются разными
  evidence rows. Если host не выполняет incremental consent, initial read+write
  OAuth либо изменение first-user claim требуют отдельного product decision;
  silent scope widening запрещён.

Полный route/state/query contract находится в
[Connections, Advanced MCP и Codex Help](../specs/connection-experience.md).

## Последствия

- Web adapter получает presentation projection вместо передачи persistence IDs
  в UI.
- OAuth active list и personal-token history реализуются отдельными bounded
  adapters; единый inactive-connections archive не появляется без новой модели.
- Existing `/settings/mcp` links остаются рабочими, но новая навигация ведёт на
  Connections и Advanced MCP раздельно.
- Contract tests доказывают actor/cursor/404/step-up invariants, а реальный
  browser gate — keyboard/mobile и пользовательские состояния.

## Отклонённые варианты

- **Оставить одну `/settings/mcp`.** Сохраняет протокольные детали и credential
  archive в основном flow.
- **Использовать `oauth_grant_id` как route ref.** Привязывает presentation к
  persistence identity и повышает риск metadata oracle.
- **Показывать disabled write selector до step-up.** Создаёт ложное обещание,
  что выбор уже доступен, и подталкивает к initial scope widening.
- **Считать revoked OAuth history уже поддержанной.** Current adapter имеет
  active projection, но не отдельную retained read model.
- **Fallback на initial read+write.** Это product/security decision, а не
  техническая деградация, и не может выполняться молча.
