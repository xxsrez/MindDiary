# ADR-0010: OAuth-коннектор и Marketplace pilot

Статус: accepted, 2026-08-17.

## Контекст

Personal `mdp_v1_` tokens доказали content MCP в Codex, но требуют ручного
копирования секрета и конфигурации endpoint. Для установки Mind Diary из уже
подключённого Srez Marketplace нужен отдельный registered connector с native
Authenticate flow. Он не должен ослаблять существующие principal, ACL, scope,
CAS и idempotency boundaries и не превращает текущий UAT Site в production.

Sites уже является authority для account bootstrap и binding
platform-authenticated identity к immutable внутреннему `principal_id`.
Поэтому отдельная OAuth account model создала бы риск расхождения identities и
непреднамеренного переноса доступа.

## Решение

- Текущий Mind Diary UAT публикует OAuth Authorization Server рядом с Product
  Site и content MCP. Он поддерживает authorization code, PKCE `S256`, dynamic
  client registration, protected-resource metadata, authorization-server
  metadata, token refresh и revocation.
- OAuth consent использует тот же trusted Sites identity resolver и тот же
  immutable `principal_id`, что и Web control plane. Unknown identity создаёт
  только новый isolated account через существующий bootstrap; automatic
  relink, merge и access transfer запрещены.
- Registered connector получает `content:read` при первом подключении.
  `content:write` запрашивается отдельным step-up consent; write включает read,
  write-only grant запрещён.
- Access token живёт не более 15 минут, authorization code — 5 минут,
  authorization request — 10 минут, rotating refresh token — не более 30
  дней. Повторное использование заменённого refresh token отзывает весь grant.
- Redirect URI и OAuth `resource` проверяются exact. Public clients не получают
  client secret; confidential client authentication в pilot не добавляется.
- OAuth secrets имеют отдельные opaque prefixes и сохраняются только как
  domain-separated keyed HMAC-SHA-256 verifiers. Plain/recoverable secrets не
  записываются.
- MCP принимает одновременно personal `mdp_v1_` и OAuth `mdo_access_` bearer
  tokens. Tools публикуют OAuth `securitySchemes`; `401` и недостаточный write
  scope возвращают protected-resource challenge для native reconnect/step-up.
- Каждый OAuth access token получает внутреннюю authorization mirror record в
  существующем token store. Application authorization заново читает эту запись
  внутри ACL/CAS/commit transaction; revoke, expiry и account deletion поэтому
  fail closed. Mirror records скрыты от personal-token UI.
- `/settings/mcp` показывает connected apps и позволяет немедленно отозвать
  grant. Personal tokens остаются отдельным advanced/direct-client path.
- Marketplace plugin использует новый registered app ID. Srez Marketplace,
  Task Manager plugin и его app ID не переиспользуются.
- Первый release — private `Mind Diary UAT` pilot. Production connector,
  публичный Plugin Directory и смена production access policy требуют
  отдельного provisioned target и явного решения пользователя.

## Последствия

- Установка из Marketplace может запускать native Authenticate без ручного MCP
  URL, client secret или personal token.
- Один OAuth connection по-прежнему видит только Minds, доступные текущему
  principal; каждый content call явно выбирает один Mind и revision.
- OAuth normalized tables добавляются отдельной D1 migration. Account deletion
  сначала выполняет authoritative product cascade, включая authorization
  mirrors, а затем best-effort удаляет уже не способные авторизоваться OAuth
  records.
- Fresh installation, read, write step-up, revoke/reconnect и оба existing
  personal-token MCP profiles остаются обязательным UAT evidence. Repository
  tests и direct curl не заменяют fresh connector smoke.

## Рассмотренные варианты

- **Скопировать personal token в plugin config.** Отклонено: секрет остаётся
  ручным и не появляется native install/auth lifecycle.
- **Выдать read+write при установке.** Отклонено для pilot: увеличение
  начального grant не требуется для browsing и ухудшает least privilege.
- **Создать отдельные OAuth accounts.** Отклонено: две identity authorities
  могут разойтись и ошибочно выдать доступ.
- **Хранить scopes только в OAuth tables.** Отклонено: application authorization
  повторно проверяет текущий token record внутри write transaction; обход этой
  проверки ослабил бы revoke/CAS boundary.
- **Сразу считать UAT production.** Отклонено: production не provisioned, а
  connector/client conformance ещё должен быть доказан live.

Связанные документы:
[plugin и connector](../specs/plugin-connector.md),
[API](../specs/api.md),
[архитектура](../architecture.md),
[MVP](../specs/mvp.md),
[ADR-0003](0003-user-scoped-mcp-and-direct-commits.md),
[ADR-0005](0005-mcp-token-secret-verifier.md) и
[ADR-0008](0008-dev-uat-production-delivery.md).
