---
uat: when-changed
topics: ["token"]
uat_when: "Personal token lifecycle. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# UAT-08 — Personal token и Help

## Шаги

1. На тестовом аккаунте проверить Help при отсутствии, наличии и отзыве подключения.
2. Создать отдельный named token; убедиться, что secret виден один раз, в UI нет credential-owned Mind selector.
3. Проверить scope narrowing через CONNECT-02, revoke и следующий denial; reissue не меняет principal modes.

## Ожидается

Навигация Help стабильна, token lifecycle не меняет выбор Minds; секреты не попадают в отчёт.
