# Automatic knowledge capture

Статус: accepted contract, 2026-08-22. Документ задаёт первый bounded
Codex-first capture profile. Binding сам capture не включает; реализация и UAT
evidence указываются отдельно.

## Назначение и граница

Automatic capture — opt-in agent workflow, который сохраняет одну небольшую
durable Memory в единственный active writable Mind credential-а без отдельного
подтверждения каждого routine additive write. Сервер Mind Diary не наблюдает
чат сам по себе: connected skill решает, когда предложить вызов, а сервер
enforce-ит consent state, exact destination, concurrency, disclosure profile и
структурные ограничения.

Обычный `commit_changeset` не становится автоматическим. Content, prompt,
source Mind, OAuth grant и model memory не могут включить capture, выбрать
target либо расширить допустимые операции.

## Trusted policy state

Policy принадлежит тому же stable `binding_owner_id`, что binding set OAuth
grant или personal token, но является отдельным consent state:

```text
mode: disabled | routine_non_sensitive
capture_write_binding_id: null | current immutable write_binding_id
binding_version: shared monotonic binding/policy CAS
updated_at
```

- default всегда `disabled`;
- enable/disable доступны только authenticated Sites control plane;
- MCP content tools не включают policy;
- enable требует current active write binding, `content:write`, write ACL и
  `private` target;
- policy закрепляется за exact `write_binding_id`, а не за handle/name;
- rebind/unbind/revoke/delete атомарно отключают policy и не переносят его на
  другой target;
- attach/detach read сохраняет policy, но меняет общий `binding_version`,
  поэтому in-flight capture перечитывает state;
- изменение visibility после enable не расширяет policy: каждый capture заново
  требует `private`; `unlisted`/`public` дают no-write до явного нового product
  decision.

Control mutation использует exact `expected_binding_version`, idempotency key и
server read-back. UI показывает `Off`, `On for <exact Mind>` либо blocked
recovery state рядом с credential и active write target.

## Eligible durable knowledge

Первый profile принимает только одну самостоятельную Memory одного из типов:

- `fact` — стабильный факт, полезный после текущего разговора;
- `decision` — принятое решение и краткая причина;
- `source_note` — bounded вывод из явно перечисленных источников.

Обязательны stable `capture_key`, короткие title/description и bounded Markdown
body. Skill обязан отличать durable knowledge от transient планов, команд,
чернового reasoning, small talk, неподтверждённых гипотез и данных, которые
нужны только для текущего ответа.

Model classification не является server security boundary. Поэтому initial
server profile дополнительно ограничивает target и source topology, размер и
операции. Skill не вызывает automatic capture для credentials/secrets,
authentication material, medical/health, legal, financial, employment/HR,
precise location, minors, intimate data, government identifiers или других
очевидно sensitive categories. Такие случаи требуют обычного explicit preview
и confirmation даже для private target.

## Provenance и disclosure

Input содержит `1..8` source refs без source bodies:

- `user_statement` — bounded факт сформулирован пользователем в текущем
  interaction;
- `target_entry` — exact `revision_id` и Markdown `path` того же target Mind.

Несколько `target_entry` разрешены и сохраняются в producer-defined
`capture.sources`. Источники другого Mind, внешние URL, private search snippets
и corpus bodies нельзя передать в automatic tool. Cross-Mind synthesis,
перенос из read-only/private source в shared target и broader disclosure дают
`capture_confirmation_required`; агент использует обычный explicit preview,
повторную authorization каждого source и `commit_changeset` только после
confirmation.

Source refs — provenance, а не authority. Current ACL и bindings проверяются
до source fetch; target content не может добавить или изменить refs.

## Bounded write

`capture_knowledge` создаёт только:

1. `concepts/captured/{capture_key}.md` через `create_file`;
2. одну `Capture` запись в существующий `log.md` через `add_log_entry`.

Memory использует OKF 0.2-compatible frontmatter `type`, `title`,
`description`, `status: draft` и producer extension `capture` с policy version,
kind, key и source refs. `index.md` автоматически не меняется: его rewrite,
как и любой replace/delete, substantial synthesis или visibility-impacting
изменение, остаётся explicit preview/confirmation flow.

Перед commit application проверяет:

- fresh binding/policy state и exact pinned `write_binding_id`;
- client `expected_binding_version`;
- current target ACL/scope/`private` visibility;
- fresh exact HEAD и `expected_revision`;
- source topology и bounded schema.

Commit проходит через обычный atomic `ChangesetCommitService`; capture
requirement повторно проверяется внутри metadata transaction. Любое изменение
policy/binding/ACL/HEAD останавливает attempt, payload не переносится и не
semantic-merge-ится.

## Deduplication и no-op

`capture_key` — стабильный semantic key, а не message ID. Он формирует exact
path. Правила:

- тот же idempotency key и тот же canonical request возвращают тот же result;
- тот же path и byte-identical generated Memory возвращают `no_op` без новой
  revision и без новой log entry;
- тот же path с другим content возвращает `capture_conflict`; automatic replace
  запрещён;
- stale HEAD или binding/policy state возвращают conflict до write.

## Audit и privacy

Обычный content commit audit дополняется controlled metadata:

- `capture_mode`, `capture_key`, captured path;
- source refs как kind + exact revision/path для same-target entries;
- без body, search query, prompt, token, email, URL или full private content.

Output сообщает outcome `captured | no_op`, exact target name/route,
binding/revision/path и validation/read-back state. Не возвращаются internal
principal/space IDs или source bodies.

## Wire surface

### Control plane

Existing `PATCH /api/v1/mind-bindings/{binding_owner_id}` получает actions
`enable_capture` и `disable_capture`. Enable не принимает target: server pin-ит
current active write generation. Unknown fields запрещены.

### MCP

`get_mind_bindings` добавляет privacy-safe `capture_policy`. Новый command
`capture_knowledge` требует:

- exact Mind selector и active `write_binding_id`;
- `expected_binding_version`, `expected_revision`, idempotency key;
- kind, capture key, title, description, Markdown body;
- declared `routine_non_sensitive` classification и source refs.

Основные no-write codes: `capture_disabled`, `capture_binding_stale`,
`capture_target_visibility_blocked`, `capture_confirmation_required`,
`capture_conflict`, обычные scope/ACL/binding/revision conflicts и validation
errors.

## Acceptance

- Routine eligible Memory появляется только в pinned active write target.
- Другой write-ACL Mind не меняется.
- Default/no binding/disabled/rebind/revoke/visibility/ACL/scope/conflict cases
  не создают revision.
- Duplicate exact capture даёт no-op.
- Replace/delete/index/cross-Mind/sensitive cases не проходят automatic tool.
- Product Site показывает policy и server read-back.
- Skill читает bindings/policy first, не включает policy и не переносит payload.
- Integration tests проверяют persistence, audit, no-op, races и privacy.
