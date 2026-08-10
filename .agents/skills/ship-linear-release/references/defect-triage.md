# Repair-first triage

Загружай при failed prerelease guardrail или UAT smoke.

1. Приостанови новые ordinary dispatch.
2. Сохрани краткий redacted symptom и affected candidate.
3. Выбери один маршрут:
   - `coordinator`: мелкий локальный fix прямо в `main`; при регистрации передай
     от одного до четырёх непересекающихся ожидаемых repair paths через
     повторяемый `--path`;
   - `reopen`: дефект принадлежит одной исходной issue; reopen её и повысь
     priority;
   - `new-bug`: крупный integration defect; создай дедуплицированную high-priority
     bug issue.
4. Если свободного worker нет, coordinator берёт repair сам. Восстановление UAT
   и prerelease guardrails важнее новой обычной работы.
   В parallel mode такой coordinator repair не создаёт дополнительный worker
   lane: coordinator делает bounded fix прямо в `main`, запускает checks,
   обновляет exact Linear issue/bug и затем refresh-ит `plan`.
5. После fix повтори затронутые checks, canonical batch gate и UAT deployment.
6. Закрой defect только по проверенному forward-fix evidence.

`coordinator` — исполнимый ограниченный budget. Сразу зарегистрируй границу:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py defect \
  --repo "$PWD" --run '<run-id>' --route coordinator \
  --summary '<redacted symptom>' \
  --path '<implementation-path>' --path '<test-path>'
```

После каждого failed repair check вызывай assessment с `--result failed`. При
расширении diff вызывай его с `--result pending`; для uncommitted repair не
передавай `--head`, чтобы helper учёл committed, staged и untracked files:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py defect-assess \
  --repo "$PWD" --run '<run-id>' --defect '<defect-id>' --result failed
```

Helper требует Linear reclassification при выходе за repair paths, более чем
12 changed files, более чем двух implementation components или третьем failed
attempt. Это sticky state: продолжать тихий coordinator fix и закрывать defect
запрещено. Сначала реально reopen исходную issue либо создай дедуплицированную
high-priority bug в exact milestone, затем запиши её stable ID:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py defect-reclassify \
  --repo "$PWD" --run '<run-id>' --defect '<defect-id>' \
  --route new-bug --linear-issue-id '<stable-linear-issue-id>'
```

Перед закрытием `defect-resolve` сам повторно оценивает committed diff от
affected candidate и fail closed с `DEFECT_RECLASSIFICATION_REQUIRED`. Маршрут
`reopen`/`new-bug` не снимает repair-first priority: linked issue всё равно
должна быть проверена и закрыта forward fix-ом.
Pre-existing open `coordinator` defect без `repair_paths` считается unbounded и
тоже требует Linear reclassification; старый journal не даёт bypass.

UAT defect всегда входит в текущий milestone scope. Rollback не выполняется.
Failed UAT — рабочая среда для обнаружения дефектов, а не terminal failure run.
Повторная регистрация того же open Linear defect возвращает существующую
journal запись; не создавай дублирующую bug issue.
