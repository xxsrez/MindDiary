---
uat: when-changed
topics: ["client_instructions","mcp_catalog","oauth","routing"]
clients: ["chatgpt"]
uat_when: "Инструкции и metadata существующего клиентского аккаунта; Имена, схемы и границы MCP tools; OAuth подключение, scopes, refresh и revoke; Выбор Mind по modes/description. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# CHATGPT-03 — Существующее подключение после изменения сервера

## Шаги

1. До изменения проверить реальный аккаунт и точное существующее подключение Mind Diary UAT: endpoint, сохранённые tools, auth/scopes и относящийся к продукту фрагмент Custom Instructions. Disposable приложение и инструкции одного тестового разговора не заменяют эту проверку.
2. После server deployment выполнить штатный Refresh для устаревшего каталога; перечитать names/descriptions/schemas/annotations. Нажатие кнопки не является read-back.
3. Проверить scopes и RECONNECT NEEDED. Reconnect выполнять только при необходимости и данных полномочиях; новое consent требует владельца, Always allow не включать.
4. При разрешённом обновлении сверить только фрагмент Mind Diary с MIND_DIARY_CHATGPT_CUSTOM_INSTRUCTIONS из packages/adapter-web/src/connections.ts выбранного candidate и help UI. Сохранить прочие инструкции; при сокращении из-за лимита поля сохранить смысловые ограничения. Повторно открыть настройки и перечитать сохранённое. Также сверить описание подключения.
5. В новом разговоре с этим подключением выполнить read-only list_minds и проверить необходимые effective capabilities. Не писать в существующие пользовательские Minds.
6. Записать отдельно server deployment, metadata read-back, instructions read-back, auth/scopes и live read. При login/consent или недоступной настройке назвать оставшийся шаг; не объявлять его pass.

## Ожидается

Установлено, что существующий аккаунт использует актуальную конфигурацию. Disposable тест не заменяет этот результат; чужие инструкции не копируются в отчёт.
