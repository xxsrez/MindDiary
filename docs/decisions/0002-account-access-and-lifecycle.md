# ADR-0002: account, доступ и lifecycle Minds

Статус: accepted, 2026-08-05.

## Контекст

Первому прототипу нужна однозначная модель пользователя, его личного знания,
совместных Minds и доступа authenticated non-members. Прежний proposal допускал
designated Personal Space, нескольких Owners и отдельную future publication
revision, из-за чего bootstrap, transfer, visibility и deletion не имели
однозначного поведения.

## Решение

- Система доступна только зарегистрированным authenticated principals;
  anonymous access отсутствует.
- Account bootstrap атомарно создаёт internal principal и ровно один Personal
  Mind. Он всегда private, имеет единственного participant-owner, открывается по
  `/me`, не передаётся, не расшаривается и не удаляется отдельно.
- Ordinary Mind получает immutable `space_id`, immutable в prototype unique
  `space_handle` и mutable non-unique display `name`.
- У active ordinary Mind ровно один Owner. Ownership передаётся только existing
  active participant; target становится Owner, source — Admin.
- Роли: `reader`, `editor`, `admin`, `owner`. Editor имеет read и полный content
  write. Admin управляет Reader/Editor; Owner — Admin, visibility, transfer и
  deletion.
- Приглашать можно только зарегистрированного пользователя по exact verified
  email. Invitation требует acceptance, живёт семь дней и до acceptance не
  является membership.
- Owner выбирает `private`, `unlisted` или `public`. Public/unlisted дают
  authenticated non-member Reader-equivalent доступ к live HEAD и history;
  public также появляется в каталоге. Это baseline grant, не membership.
- В первом прототипе Owner delete и account delete немедленно и безвозвратно
  удаляют весь описанный cascade, включая committed history. Политика
  сознательно временная и должна быть пересмотрена до production.

## Последствия

- Нельзя создать active ownerless Mind или второго Owner обычной role mutation.
- Personal Mind использует обычный OKF/revision storage, но отдельные service
  invariants и account lifecycle.
- `public` не означает anonymous и не использует отдельный
  `published_revision`: успешный content commit сразу виден baseline readers.
- Control plane обязан показывать invitation state, destructive-action cascade
  и предупреждение о live visibility.
- Email пока является проверенным lookup/binding signal Sites, но не должен
  молча становиться immutable internal identity; relink требует отдельного
  platform решения.

## Отклонённые варианты

- Lazy creation Personal Mind: не даёт пользы, потому что `/me` нужен в первом
  пользовательском сценарии.
- Несколько Owners: усложняют transfer/exit semantics и не соответствуют
  принятой модели одного владельца.
- Автоматическое membership без acceptance: даёт пользователю неожиданную
  связь и доступ; pending invitation делает intent явным.
- Anonymous public access: не нужен агентному сценарию прототипа и расширяет
  identity/threat surface.

Полная operational semantics находится в
[доменной спецификации](../specs/domain-model.md).
