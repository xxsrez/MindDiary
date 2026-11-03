---
uat: when-changed
topics: ["metadata","concurrency"]
uat_when: "Имя и description Mind, конфликт metadata; Конкурентные записи и CAS. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# OPEN-04 — Конфликт metadata в двух вкладках

Источник: [управление Minds](../../mind-admin-browser-uat-runbook.md). Данные: тестовый Mind открыт в двух вкладках на одной metadata version.

## Шаги

1. В первой вкладке изменить description.
2. Во второй сохранить отличающееся description из устаревшего состояния.
3. Обновить обе вкладки и сверить metadata и content HEAD.

## Ожидается

Первая правка не затирается молча; конфликт понятен, content HEAD от изменения description не меняется.
