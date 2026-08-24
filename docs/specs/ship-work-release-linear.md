# Linear adapter для `ship-work-release` — historical tombstone

Статус: retired historical tombstone, superseded 2026-08-24.

Полная Linear adapter specification удалена из active repository surface.
Этот короткий документ сохраняет только provenance пути и не является
исполняемой specification, selector, runtime reference или delivery authority.

Current Mind Diary delivery использует
[`Task Manager mapping`](ship-work-release-task-manager-srez.md) и её
[`operational runtime reference`](../operations/ship-work-release-task-manager-srez.md).
Причина и граница supersession зафиксированы в
[`ADR-0009 amendment`](../decisions/0009-task-manager-adapters.md#amendment-2026-08-24).

Исторический полный текст остаётся доступен через Git history этого path на
commit `eca34007eaa691e0913e0486955d5726c2959db1`. Он нужен только для audit
старых receipts. Нельзя брать из него provider IDs, status mapping, commands,
capabilities или mutation/reconcile procedure для current run.
