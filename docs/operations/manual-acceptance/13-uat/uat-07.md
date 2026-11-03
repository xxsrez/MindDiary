---
uat: when-changed
topics: ["mcp_catalog"]
uat_when: "Имена, схемы и границы MCP tools. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# UAT-07 — Границы MCP и режима Mind

## Шаги

1. Сверить modern/compat/read-only каталоги с актуальным inventory выбранной версии, не с историческим количеством tools.
2. Проверить отсутствие control-plane membership/visibility/ownership/import-export administration и безопасный отказ устаревшего вызова.
3. Проверить disabled нового тестового principal, одинаковые configured modes разных credentials, невозможность чтения/изменения чужого usage state.

## Ожидается

Content MCP не получает административные полномочия. Применяются текущие independent multi-Mind modes; singleton/bind/unbind ожидания из старых схем не возрождаются.
