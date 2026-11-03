---
uat: when-changed
topics: ["ui_layout"]
uat_when: "Viewport, keyboard focus и admin shell. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# UAT-05 — Навигация и доступность admin UI

## Шаги

1. На /minds при 1440×900 проверить rail, доступность Settings и первой строки.
2. На Connections при 390×844 открыть drawer клавиатурой, проверить focus trap и Escape с возвратом фокуса.
3. На /me при 390×844 проверить private disclosure; на Advanced MCP при 1024×768 проверить current navigation и Back.

## Ожидается

Все четыре journey из admin-shell runbook наблюдались на настоящем UI; исторические assertion names не подменяют фактический результат.
