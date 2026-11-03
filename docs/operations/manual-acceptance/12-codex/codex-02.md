---
uat: when-changed
topics: ["file_companion"]
clients: ["codex"]
uat_when: "Локальная передача через companion. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# CODEX-02 — Локальный файл в Codex через companion

## Шаги

1. В выбранной версии Codex пройти штатный companion workflow для одного явно выбранного синтетического файла.
2. Завершить content commit в тестовый Mind, независимо получить сохранённый файл и сравнить hash.
3. Зафиксировать версию package/client и используемый transport.

## Ожидается

Проверен companion Codex; native support не заявляется. Проверка native bridge выбирается отдельно темой file_native.
