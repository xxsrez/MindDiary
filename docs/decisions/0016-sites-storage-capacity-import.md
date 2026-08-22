# ADR-0016: Sites storage, capacity и Markdown import

Статус: accepted, 2026-08-22. Решение относится к Release 0.1 and Sites UAT;
implementation and live evidence остаются отдельными задачами MD-265–MD-268.

## Контекст

Текущий full-corpus commit повторно материализует и записывает каждый Markdown
object. Для Brain-scale Mind это делает малую правку O(total corpus), раздувает
D1/R2 history и не оставляет единой модели reservations, quota ownership,
historical search, temporary lifecycle или resumable import.

## Решение

- Canonical Markdown/BundleFile objects and immutable manifests are
  content-addressed and Space-scoped in R2; D1 хранит transactional revision
  refs, HEAD CAS, reachability, ledger, reservations and job/session state.
- New v3 manifest keeps v2 entry semantics but is a separately digested R2
  object. Delta commit reuses unchanged digests and writes only changed objects
  plus one manifest.
- Search is exact-revision derived state: HEAD eager, history on demand, no D1
  full-corpus duplication and no fallback to another revision.
- Accounting distinguishes logical HEAD/history, physical canonical,
  temporary, D1 and reserved bytes. Same-Space digest is physical once;
  cross-Space deduplication is forbidden. Usage is charged to sole Owner.
- Conservative per-Mind/principal/Site limits, `70%` warning, `85%` soft limit
  and `100%` hard stop are enforced through durable idempotent reservations and
  canonical reconcile.
- First productized import is Markdown-only and uses
  `plan -> reserve -> stage batches -> validate -> commit -> finalize`; one
  exact HEAD CAS publishes one revision or nothing. Its first policy is an
  exact Markdown snapshot of an already created/bound Mind; there is no
  per-file merge or create-Mind shortcut inside import.
- Export and cleanup are streaming/bounded with persisted cursors; no global
  synchronous R2 scan or whole archive in JSON-RPC/Worker memory.
- Logs/telemetry never contain content, paths, queries, credentials, signed
  URLs, provider IDs or object keys. Sites residency/backup claims remain
  limited to verified provider behavior.
- Migration uses dual read, bounded backfill, shadow verification and
  v3-aware rollback floor. AWS is future direction, not current fallback.

Full keys, invariants, numeric limits, lifecycle, migration sequence and
evidence are normative in the
[storage/capacity/import specification](../specs/sites-storage-capacity-import.md).

## Последствия

- MD-265 can implement small-delta commit without choosing storage semantics.
- MD-266 can build reconstructable accounting/admission instead of event-only
  counters.
- MD-267 cannot publish partial imports and MD-268 cannot use unbounded
  materialization/cleanup.
- A Site with unknown or smaller provider headroom fails closed for growth;
  delete/net-shrink/cleanup remain available.
- After the first v3 revision, rollback may target only dual-read/v3-aware code.

## Отклонённые варианты

- Full snapshot per revision.
- Cross-Mind global deduplication.
- Event-only usage counters.
- Synchronous import/export and foreground R2 scans.
- Partial HEAD publication per import batch.
- Automatic AWS migration or fallback.
