---
uat: when-changed
topics: ["invitations"]
uat_when: "Приглашения, роли, transfer и leave. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# UAT-06 — Приглашения, Admin и самостоятельный выход

## Шаги

1. В тестовом private Mind создать invitation, сверить seven-day expires_at и отсутствие доступа до acceptance; отменить и переиздать.
2. Target отклоняет приглашение; затем принимает новое. Повтор acceptance не дублирует membership, старое cancelled не принимается.
3. Проверить Reader/Editor/Admin полномочия: Editor не управляет membership, Admin управляет Reader/Editor, не Owner/другим Admin.
4. После передачи ownership проверить единственного Owner, прежнего Admin; выполнить re-invite и leave тестового участника, повторить read/history.

## Ожидается

Каждый переход подтверждён свежими web/MCP reads; leave закрывает доступ. Проверка expires_at не заявляет фактическое ожидание семи дней. Используются только изолированные principals.
