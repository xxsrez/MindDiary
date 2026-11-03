# Выбор ручных проверок для UAT

Обычные ручные проверки UAT выбираются из глубокого каталога. Автотесты,
CI, сборка, deployment и machine gates остаются отдельными механизмами.
Перенесены сценарии, а не команды публикации или старые результаты.

## Frontmatter и поиск

Основной способ выбора — read-only команда
[select-manual-checks.mjs](../../../scripts/select-manual-checks.mjs).
Она читает карточки, проверяет метаданные, выдаёт ID, путь и причину выбора;
тесты не исполняет, данные продукта и файлы не меняет.

```sh
node scripts/select-manual-checks.mjs --list-topics
node scripts/select-manual-checks.mjs --topics import_resume
node scripts/select-manual-checks.mjs --topics oauth --clients chatgpt
node scripts/select-manual-checks.mjs --topics ui_layout
node scripts/select-manual-checks.mjs --ids REG-01
node scripts/select-manual-checks.mjs --search автобусы
node scripts/select-manual-checks.mjs --mode deep --json
```

Агент читает scope/diff и выбирает конкретные темы из
[словаря](topics.json). Например, reload импорта — import_resume; изменение
полного import workflow — import,import_resume,import_validation,concurrency.
Тема означает изменённое поведение, а не любое упоминание слова в diff.
Для общего storage/identity изменения оценить затронутые вызовы и выбрать
несколько тем; команда не угадывает полный impact по имени файла.

Без --clients сохраняются обе интеграции; --clients chatgpt или codex сужает
только явно клиентские карточки. Общие проверки не исчезают. В плане указать
причину ограничения клиента; оно недопустимо, если изменение затрагивает оба.
Неизвестная тема/ID и пустое совпадение завершаются ошибкой, не планом из одного
smoke. Если подходящего случая нет — сначала добавить карточку.

Вывод — кандидаты: сверить шаги с конкретной задачей, зафиксировать выбранные
ID и исключения с причиной. Включить связанные ограничения (например ACL/CAS),
когда diff их затронул. Предварительный выбор не является результатом приёмки.
Обязательное ядро добавляется один раз, ID дедуплицируются.
Полный deep без фильтров возвращает все карточки, включая ревью кода.

```yaml
---
uat: when-changed
topics: ["import_resume"]
uat_when: "Изменились import/export или storage."
---
```

- `uat: always` — каждый product cut. Для docs-only без публикации не применяется.
- `uat: when-changed` — при выполнении `uat_when`: затронутом поведении или
  критерии задачи. Изменение общего файла не включает всю группу автоматически.
- `uat: extended` — по явно выбранному scope или обоснованному риску,
  указанному в `uat_when`, не при каждом релизе.
- Нет поля — deep-only по умолчанию. README и шаблоны не размечаются как случаи.

Из корня репозитория:

```sh
rg -l '^uat: ' docs/operations/manual-acceptance
rg -l '^uat: always$' docs/operations/manual-acceptance
rg -n '^uat(_when)?: ' docs/operations/manual-acceptance
```

Это поиск, не runner. Выбрать ID по условиям, diff и acceptance задачи.
Обязательное ядро: OPS-01 и UAT-01…03. UAT-02 выбирает изменённый journey
из функциональных карточек; если его нет — добавить до выполнения.
Не заводить отдельный неучтённый сценарий в release report.
Один результат на той же версии, клиенте и данных переиспользуется ссылкой.
ChatGPT и Codex не заменяют друг друга. UAT pass не означает полный deep pass.

## Соответствие обязательствам обычного релиза

| Проверка | Карточки |
| --- | --- |
| Candidate/artifact/CI/target/deployment read-back | [OPS-01](10-devops-mcp/ops-01.md); CI/deploy выполняет релизный workflow |
| Authenticated smoke | [UAT-01](13-uat/uat-01.md) |
| Изменённый journey и повторное чтение | [UAT-02](13-uat/uat-02.md) и выбранные функциональные ID |
| ACL/scopes/CAS/no-side-effects | [Доступ](06-access/README.md), [запись](03-writing/README.md), [routing](07-connections-routing/README.md), UAT-06/07 |
| Cleanup, версии, reuse и ограничения | [UAT-03](13-uat/uat-03.md) |
| Persistence/recovery по риску | UAT-04/09/10 |
| Реальный аккаунт при смене metadata/scopes/instructions | [CHATGPT-03](11-chatgpt/chatgpt-03.md) |
| Modern/compat MCP, настоящий Codex | [OPS-02](10-devops-mcp/ops-02.md), [Codex](12-codex/README.md); разные профили имеют отдельные результаты |

## Карта расширенных источников

| Источник | Ручные карточки | Что сохраняется отдельно |
| --- | --- | --- |
| [Admin shell](../admin-shell-browser-uat-runbook.md) | UAT-05, OPS-01 | Byte/hash machine evidence |
| [Mind admin](../mind-admin-browser-uat-runbook.md) | OPEN-01…05, ACCESS-01…05, UAT-04 | Playwright registry |
| [Access/admin](../release-0.3-access-admin-uat-runbook.md) | ACCESS-01…05, UAT-06/07/04 | Exact strict receipts |
| [Settings](../settings-connections-uat-runbook.md) | CONNECT-01/02, ROUTE-01…07, UAT-08/04 | Frozen schemas |
| [Authority](../release-0.3-authority-target-uat-runbook.md) | UAT-07, CONNECT-02, WRITE-01…04, ROUTE-01…07 | Исторические carriers/joins |
| [Import/export](../import-export-browser-uat-runbook.md) | IMPORT-01…07, EXPORT-01/02, UAT-11/12/04 | Автоматический quota/fault harness |
| [Multi-principal](../uat-multi-principal-runbook.md) | ACCESS-01…05, UAT-06/04 | Script setup/verify/cleanup |
| [Operator](../uat-operator-directory-canary.md) | UAT-13/14 | Machine canary и join |
| [Pilot operations](../uat-pilot-operations.md) | OPS-03/04, UAT-09/10 | Admission, incident procedures, market research |
| [Generated sources](../generated-source-uat-runbook.md) | FILE-03/04, EXPORT-01, UAT-04/03 | Hidden run_matrix с инъекциями — автоматический gate |
| [Drive](../google-drive-connector-object-uat.md) | FILE-01/03/04, EXPORT-01, UAT-04/03: общие пользовательские результаты | Provider-specific GD-UAT-001…016 остаются автоматическим gate; ручные карточки не доказывают их прохождение |
| [Acceptance runner](../autonomous-acceptance.md) | Общие функциональные и клиентские разделы | Шесть machine components и compaction |

Ссылки на UAT-04…14 находятся в [индексе UAT](13-uat/README.md).
Остальные ID доступны через [главный индекс](README.md).

Старые strict assertion sets сохранены для воспроизводимости, не как второй
каталог обычных ручных шагов. По прямому требованию старого strict gate
исполняется его полный контракт отдельно; ручное подмножество не даёт ему pass.
Устаревшие singleton/bind/unbind, обязательный description для explicit write
и фиксированные старые tool counts не перенесены: применять текущую спецификацию.

Исторические исходники перенесены в [архив](../legacy-acceptance/README.md);
прежние пути стали навигационными входами. CHATGPT-03 сохраняет требования
реального аккаунта из revision 11 профиля. Проверки продукта при переносе не запускались.
