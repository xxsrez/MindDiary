---
uat: extended
topics: ["operator"]
uat_when: "Каталог оператора. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# UAT-13 — Каталог оператора и обычные роли

## Шаги

1. Для трёх заранее разрешённых principals operator/mind-owner/ordinary проверить успешные web/MCP reads.
2. Operator проверяет UI/API projection, limit-1 pagination без дублей, exact-name search, sort по name/registration/activity в обе стороны и inclusive UTC ranges.
3. Проверить impossible empty query и never-active: null activity либо явное пустое состояние.
4. У двух non-operators проверить non-enumerating denial и отсутствие изменения activity от denied requests.

## Ожидается

Роли Mind не дают operator capability; projection bounded и не раскрыта посторонним. Не создавать operator grant/allowlist ради теста. Сырые строки каталога не сохранять в Git.
