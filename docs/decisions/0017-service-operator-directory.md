# ADR-0017: read-only service-operator directory

Статус: accepted, 2026-08-22. Решение относится к Release 0.1 и текущему Sites
UAT; implementation и hosted evidence остаются отдельными claims MD-244.

## Контекст

Pilot operator должен отличать зарегистрированный, never-active и недавно
использованный account, не получая доступ к private corpus и не вводя
surveillance subsystem. Роли Owner/Admin ограничены одним Mind и не могут
становиться service-wide authority.

## Решение

- Service operator — отдельная constructor-only allowlist внутренних opaque
  `principal_id`; membership, роль, token scope и browser input её не создают.
- Internal UI/API fail closed и выглядят отсутствующими для всех остальных.
- Последняя активность — одна durable монотонная success-only summary на
  principal, разделённая на web/MCP; request journal не хранится.
- Read-only directory возвращает bounded support metadata, verified email,
  activity summary и aggregate counts без обращения к content objects/index.
- Каждый разрешённый read audit-ится только opaque actor/operation/time;
  query и результат не записываются.
- Account deletion удаляет linkable summary; summary никогда не участвует в
  authorization или продуктовых решениях.

Полный contract полей, фильтров, privacy denylist и verification задан в
[спецификации операторского каталога](../specs/service-operator-directory.md).

## Последствия

- UAT operator configuration требует заранее известный internal principal ID
  и не может быть выведена из публичного email или Mind ownership.
- Activity write остаётся best-effort observability: её отказ не ломает
  успешную product operation, а UI обязан честно показывать `Never/unknown`.
- Для будущей production support model потребуется отдельное решение об
  identity, least privilege, retention и incident access; этот ADR её не
  утверждает.

## Отклонённые варианты

- Owner/Admin любого Mind как service operator: privilege escalation.
- Plain-email allowlist: переносит PII в deployment configuration и связывает
  authority с mutable external identifier.
- Access timestamp из provider sign-in: недоступен как canonical product факт.
- Полный request/clickstream log: не нужен для pilot support и нарушает
  minimization.
- Activity как authorization signal: превращает observational projection в
  security authority.
