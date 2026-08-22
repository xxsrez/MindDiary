# ADR-0014: opt-in routine automatic capture

Статус: accepted, 2026-08-22. Решение дополняет ADR-0013, не меняя explicit
write semantics обычного `commit_changeset`.

## Контекст

Singleton write binding однозначно задаёт destination, но не даёт consent на
автоматические writes и не решает provenance, sensitivity, disclosure или
deduplication. Codex-first pilot всё же должен проверить, полезно ли routine
durable knowledge накапливать без отдельного подтверждения каждой additive
Memory.

## Решение

- Capture — отдельный default-off policy state per OAuth grant/personal token.
- Policy включает только Sites control plane и pin-ит к current immutable
  `write_binding_id`; rebind/unbind/revoke не переносят consent.
- Первый profile `routine_non_sensitive` работает только с `private` target,
  user statement и same-target entry provenance.
- Серверный `capture_knowledge` создаёт deterministic new Memory и log entry;
  replace/delete/index rewrite отсутствуют.
- Capture reuses normal ACL, scope, binding, revision CAS, idempotency,
  validation, immutable history, audit и derived-index flow.
- Duplicate exact content — no-op; path collision с другим content требует
  explicit workflow.
- Cross-Mind, unlisted/public и sensitive/substantial changes остаются за
  preview/confirmation boundary.

Полный contract находится в
[automatic-capture specification](../specs/automatic-capture.md).

## Последствия

- «Automatic» означает поведение connected agent после explicit opt-in, а не
  скрытое наблюдение server-side чата.
- Model classification помогает выбрать routine knowledge, но не подменяет
  enforceable target/source/operation limits.
- Initial profile намеренно консервативен; broader disclosure потребует нового
  accepted policy, а не ослабления existing tool.
- Policy и binding разделены семантически, но используют общий binding CAS для
  fencing in-flight capture.

## Отклонённые варианты

- **Binding автоматически включает capture.** Нет отдельного consent и риск
  неожиданного накопления content.
- **Обычный commit помечается client flag.** Нельзя enforce-ить additive-only и
  provenance contract независимо от generic write.
- **Principal-wide capture target.** Переносил бы consent между credentials и
  конфликтовал с ADR-0013.
- **Cross-Mind automatic synthesis сразу.** Требует ещё не принятой disclosure
  и sensitivity policy.
- **Implicit Personal Mind fallback.** Скрывает destination и fail-open при
  no binding.
