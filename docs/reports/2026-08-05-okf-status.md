# Состояние Open Knowledge Format на 2026-08-05

Статус: report. Наблюдение выполнено 2026-08-05; внешнее состояние после этой
даты может измениться.

## Вывод

Последняя официально объявленная версия — **OKF 0.2**. Текущий нормативный
`okf/SPEC.md` совпадает с зафиксированным snapshot
`3fcbb9f828c2f23d109c855ee403c3a4c81f3a96`; обновлений формата после него на
момент проверки нет.

Следовательно, выбранная для Mind Diary базовая версия OKF 0.2 остаётся
актуальной и не требует пересмотра из-за нового релиза. Сервис всё равно должен
сохранять явную version boundary, потому что будущая версия может появиться
позже. Первый прототип пишет только 0.2; legacy import/migration потребует
отдельной policy и не должен silently менять semantics.

## Как проверялось

- Прочитан текущий официальный [OKF specification][spec-main].
- История `okf/` сравнена с audited commit [`3fcbb9f…`][final-02].
- Проверено официальное [сравнение snapshot с `main`][compare].
- Сопоставлены SHA-256 текущего и snapshot `SPEC.md`.
- Проверены официальный [анонс OKF 0.2][announcement] и наличие GitHub
  tags/releases.

## Факты

- Commit [`780fe9d…`][introduce-02] от 2026-07-24 16:45:07 UTC внёс основное
  обновление 0.2.
- Commit [`3fcbb9f…`][final-02] от 2026-07-24 16:45:43 UTC изменил заголовок
  `Version 0.2 (Draft)` на `Version 0.2`. Это последний commit, затрагивающий
  `okf/` на момент проверки.
- После него в `main` находились два commit — [`599a240…`][post-1] от 2026-08-04
  и [`930b65f…`][post-2] от 2026-08-05. Они меняли `toolbox/mdcode`, но не
  `okf/`.
- SHA-256 обоих проверенных вариантов `SPEC.md`:
  `5a3311d270bebb16d558010e75064f5b75323f284992641732b1c8097511f948`.
- У репозитория не было GitHub tags или releases; актуальная версия заявлена в
  самой спецификации.
- Typed relationships, agent-routing hints, `.okfignore` и erasure profile в
  анонсе названы направлениями дальнейшей работы, но в нормативный OKF 0.2 не
  входят.

## Что важно для Mind Diary

Нормативный OKF определяет переносимое дерево Markdown concepts и позволяет им
ссылаться на underlying resources и producer-defined files. Он не определяет
нормативную `Asset` entity, binary manifest или transport и также не определяет:

- storage и serving;
- query/search API или MCP;
- transactions, revisions, locks и merge semantics;
- account/Space isolation, ACL и sharing;
- runtime/attester ABI, sandboxing и cache receipts.

Поэтому Mind Diary обязан проектировать эти механизмы как собственный envelope,
не изменяя смысл OKF. В первом прототипе changesets работают только с UTF-8
Markdown, а канонический export сохраняет files/paths и неизвестные types/fields.
ZIP/local import и producer-defined non-Markdown file transport в scope не
входят. Search index производен, а ACL и revision metadata находятся вне
frontmatter.

`index.md` даёт естественную основу progressive disclosure: агент сначала
получает карту, затем выбранный concept и только потом source. `verified` и
derived trust tier полезны в ответах, но никогда не заменяют authorization.

`index.md` и `log.md` являются canonical authored files, но OKF не задаёт
multi-writer protocol. Поэтому Mind Diary может безопасно предоставить
service-level operations: заменить `index.md` под общим HEAD CAS и семантически
добавить запись в newest-first/date-grouped `log.md`. Эти операции должны
материализовать валидные OKF files и не выдаваться за часть спецификации OKF.

Неизвестный type, включая Attested Computation, reader должен сохранить при
round-trip и может отдать как обычный concept без type-specific semantics.
Первый прототип не реализует специальное исполнение Attested Computation:
автоматический runtime откладывается, потому что OKF 0.2 не стандартизирует
полный protocol, sandboxing и attester ABI.

## Ограничения проверки

Проверка подтверждает состояние официального репозитория на указанную дату. Она
не доказывает совместимость будущей реализации Mind Diary: conformance будет
проверяться отдельно на changeset, codec и export fixtures.

[spec-main]: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
[introduce-02]: https://github.com/GoogleCloudPlatform/knowledge-catalog/commit/780fe9d30b5bbca8931256edf1d0290d6bda5462
[final-02]: https://github.com/GoogleCloudPlatform/knowledge-catalog/commit/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96
[compare]: https://github.com/GoogleCloudPlatform/knowledge-catalog/compare/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96...main
[post-1]: https://github.com/GoogleCloudPlatform/knowledge-catalog/commit/599a24029400b32436bc58c425d722e8ad8d221f
[post-2]: https://github.com/GoogleCloudPlatform/knowledge-catalog/commit/930b65fc3f5619d5d0591f88c72ebae8b848d60d
[announcement]: https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals
