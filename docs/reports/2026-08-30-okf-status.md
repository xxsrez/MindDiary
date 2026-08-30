# Состояние Open Knowledge Format на 2026-08-30

Статус: verified report для MD-380. Проверены официальный repository,
актуальная история `SPEC.md`, exact commit и байты specification; runtime и
tests этого candidate проверяются отдельно.

## Вывод

Официальная версия остаётся **OKF 0.2**, но нормативный источник переехал из
`GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md` в отдельный repository
[`GoogleCloudPlatform/open-knowledge-format`][repository]. Последний commit,
меняющий `SPEC.md`, — [`0b87c52c6ef999286c745e19998fdfcd03d5dbee`][spec-commit]
от 2026-08-21. SHA-256 exact `SPEC.md` этого commit:
`26aa5da029278939f914e578107242d9607d4f2dc5fe153272b82f9ed1030101`.

На момент проверки `main` указывал на
`ad30107c31c06aec8a7d5636e0d1058118604e6f`; история exact `SPEC.md`
заканчивалась `0b87c52…`, поэтому codec pin-ит последний нормативный change,
а не несвязанный repository HEAD.

## Существенный diff относительно прежнего pin

Предыдущий аудит был закреплён на `3fcbb9f…` в старом repository. Версия
формата не изменилась, но guidance optional provenance/trust/lifecycle families
уточнён:

- каждый timestamp-valued key — ISO 8601 datetime с явным UTC offset;
- `stale_after` теперь absolute instant, а не date-only day;
- `sources[].last_modified` — datetime источника;
- shared или per-source `usage_window.from/to` — datetime range;
- `generated.at` и каждый `verified[].at` используют ту же temporal form;
- optional family defects остаются soft guidance для consumer: bundle нельзя
  отвергать только из-за них, unknown type/field также остаётся допустимым;
- producer, в отличие от permissive consumer, должен сформировать эти поля без
  quality warnings до публикации agent-generated revision.

Commit `0b87c52…` удалил дублирующий MUST из conformance section, но не отменил
temporal rule section 5: reference consumer по-прежнему игнорирует `stale_after`
без offset вместо timezone guess.

## Контракт Mind Diary

- `OKF_VERSION` остаётся `0.2`; unsupported version не интерпретируется как 0.2.
- `OKF_AUDITED_SPEC_REVISION` и hash фиксируют exact normative bytes.
- Consumer validation сохраняет разделение OKF conformance errors, service
  envelope errors и quality warnings. Malformed optional metadata сохраняется,
  а не удаляется и не превращается в authority.
- Producer validation дополнительно требует zero quality warnings. Это правило
  применяется к новым agent/service writes до commit. MCP `commit_changeset` и
  automatic capture включают trusted producer profile; обычное consumer-чтение
  и пользовательский import сохраняют permissive boundary.
- Producer preflight материализует и проверяет весь resulting Markdown bundle,
  включая неизменённые файлы, и учитывает cross-link warnings. Warning-bearing
  candidate не резервирует capacity, не пишет object и не двигает HEAD.
- Producer policy не входит в canonical idempotency payload: уже committed
  старый вызов можно безопасно read-back/replay после rollout без новой записи,
  но новый idempotency key проходит текущий строгий gate.
- Неизвестные types/fields остаются opaque и round-trip safe. `Attested
  Computation` не получает автоматическую runtime semantics.
- Full-bundle validation, immutable revision, HEAD CAS и export round-trip —
  application evidence, а не свойство самого OKF.

## Как проверялось

1. Прочитаны официальный repository и текущий `SPEC.md`.
2. Прочитана history exact `SPEC.md`; последний нормативный commit разрешён в
   полный SHA.
3. Exact raw bytes commit `0b87c52…` проверены локально через SHA-256.
4. `main` прочитан через remote ref, чтобы отделить repository HEAD от
   последнего изменения specification.
5. Temporal и conformance sections сопоставлены с local codec/tests.
6. Сквозной integration test провёл MCP producer proposal через full-bundle
   preflight, immutable revision, deterministic ZIP export и повторную producer
   validation извлечённых bytes; warning-bearing MCP call сохранил прежний HEAD.

## Ограничения

Аудит подтверждает официальный источник и принятый codec target на указанную
дату. Он не доказывает hosted MCP behavior или UAT. Новое изменение upstream
после `0b87c52…` требует повторного явного аудита и нового pin; автоматическое
следование `main` запрещено.

[repository]: https://github.com/GoogleCloudPlatform/open-knowledge-format
[spec]: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/0b87c52c6ef999286c745e19998fdfcd03d5dbee/SPEC.md
[spec-history]: https://github.com/GoogleCloudPlatform/open-knowledge-format/commits/main/SPEC.md
[spec-commit]: https://github.com/GoogleCloudPlatform/open-knowledge-format/commit/0b87c52c6ef999286c745e19998fdfcd03d5dbee
