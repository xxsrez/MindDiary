# Mind Diary без служебных отчётов

Дата: 2026-09-12. Статус: опубликовано в UAT, настройки реального ChatGPT
обновлены и перечитаны.

По прямой просьбе владельца обычное использование Mind Diary больше не требует
объявлений о discovery, проверках, чтении, успешной записи или no-op. Правило
действует для промежуточного и итогового ответа. Исключения: прямой вопрос о
сервисе или неустранённая проблема, существенно влияющая на запрос либо требующая
действия пользователя. Внутренние commit/read-back/reconciliation сохранены.

Изменены рекомендуемые Custom Instructions, центральные MCP instructions,
описание `commit_changeset` и раздел Agent notification в
[спецификации режимов](../specs/mind-usage-modes.md#agent-notification).
Schemas, scopes, ACL, режимы Minds и approval settings не менялись.

## Публикация и проверки

- Product candidate: `86d3d5d556d60659994b018e7b1be132361111ff`.
- Sites subtree mirror: `517b6d9e965e88e7ad756a3d2de963e07137619a`.
- [CI exact candidate](https://github.com/xxsrez/MindDiary/actions/runs/34698583568): success.
- Targeted instruction/UI tests: 17 pass; исправленные source/help expectations:
  4 pass; clipboard/client-switch browser scenario: 1 pass.
- Build и exact-candidate artifact check: pass; docs validator и diff check: pass.
- UAT version 159: `appgprj_example1428fe59b5d8381c~appgver_example3651d86195caf6e6`.
- Deployment `appgdep_example441bae5bcedefb78`: succeeded.
- [Живая страница подключения](https://mind-diary.example.invalid/help/codex):
  authenticated read-back; опубликованный шаблон из 1493 символов точно совпал
  с новым блоком настроек аккаунта.
- Реальные Custom Instructions сохранены и перечитаны после reload; остальной
  текст пользователя сохранён. Полный личный текст в отчёт не копируется.
- Существующее подключение Mind Diary UAT: после Refresh каталог показывает
  новое описание `commit_changeset` без прежнего требования `notify the user`.
  OAuth connection сохранён, reconnect и расширение scopes не требовались.

## Проверка ответа модели и границы

В новом обычном ChatGPT-разговоре об абстрактных игровых классах наблюдался
успешный `list_minds` (`ok: true`) без служебного объявления в ответе. Проверка
использовала сохранённые инструкции аккаунта и реальное подключение; запись
была запрещена самим тестовым запросом.

В отдельном ходе того же разговора смоделированы успешный commit и read-back;
итоговый ответ также не упоминал сервис. Это проверка формулировки после
смоделированной записи, а не доказательство живого write flow. Реальные записи
в пользовательские Minds ради smoke не выполнялись. Два ответа не гарантируют
детерминированное соблюдение инструкции во всех будущих разговорах.

Результаты ответов получены после сохранения Custom Instructions; последующий
server deployment дополнительно устранил противоречащие MCP instructions.
Результат Refresh проверен уже после deployment. Production не затрагивался.
