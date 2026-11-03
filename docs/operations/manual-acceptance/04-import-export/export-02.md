---
uat: when-changed
topics: ["download_grants","acl"]
uat_when: "Одноразовые download grants, expiry и отзыв; Права чтения/записи и отзыв membership. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# EXPORT-02 — Отзыв доступа перед download

Источник: [import/export](../../import-export-browser-uat-runbook.md). Данные: тестовый Reader и Owner private Mind.

## Шаги

1. Reader создаёт export и дожидается готовности без скачивания.
2. Owner отзывает membership.
3. Reader повторяет status и download.

## Ожидается

Архив не выдаётся после отзыва; секретный URL не попадает в отчёт.
