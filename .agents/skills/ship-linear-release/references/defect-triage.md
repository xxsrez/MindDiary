# Repair-first triage

Загружай при failed prerelease guardrail или UAT smoke.

1. Приостанови новые ordinary dispatch.
2. Сохрани краткий redacted symptom и affected candidate.
3. Выбери один маршрут:
   - `coordinator`: мелкий локальный fix прямо в `main`;
   - `reopen`: дефект принадлежит одной исходной issue; reopen её и повысь
     priority;
   - `new-bug`: крупный integration defect; создай дедуплицированную high-priority
     bug issue.
4. Если свободного worker нет, coordinator берёт repair сам. Восстановление UAT
   и prerelease guardrails важнее новой обычной работы.
5. После fix повтори затронутые checks, canonical batch gate и UAT deployment.
6. Закрой defect только по проверенному forward-fix evidence.

UAT defect всегда входит в текущий milestone scope. Rollback не выполняется.
Failed UAT — рабочая среда для обнаружения дефектов, а не terminal failure run.
