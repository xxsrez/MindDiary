# Текущее состояние

Статус документа: `not_applicable` как specification; это датированный
аналитический срез.

## Краткий диагноз

Продуктовая проблема не сводится к тому, что страница `MCP setup` плохо
свёрстана. В одном интерфейсе и одном release graph одновременно живут четыре
разных режима:

1. обычный пользователь впервые подключает Mind Diary;
2. пользователь управляет уже подключёнными приложениями и их доступом;
3. разработчик вручную настраивает legacy/compatibility MCP и personal token;
4. release operator хранит и проверяет тестовые credentials, protocol profiles,
   playbooks и UAT evidence.

Отсюда два системных эффекта:

- основной путь Marketplace → OAuth → first useful result визуально теряется;
- release не имеет одного terminal outcome: каждая новая инфраструктурная
  инициатива становится ещё одним blocker рядом с пользовательским MVP.

## Task Manager

На момент среза в Project 204 Tasks:

| Состояние | Количество |
|---|---:|
| Done | 119 |
| Canceled | 56 |
| In Review | 22 |
| In Progress | 7 |
| Todo / Backlog | 0 |

В Release `0.1` находятся 148 Tasks: 119 Done и все 29 незавершённых. Это
означает, что release scope фактически равен всему активному хвосту проекта,
а не минимальному набору результатов, необходимых для первого прототипа.

### 29 незавершённых Tasks по реальному outcome

| Контур | Tasks | Смысл |
|---|---|---|
| Release/UAT governance и operator | MD-244, MD-280–MD-283, MD-285–MD-287 | Тестовые principals, operator evidence, privacy boundary и переход на Task Manager |
| Runtime и performance | MD-252, MD-257–MD-259, MD-261 | Recovery индекса, устранение N+1, latency gate и scale reliability |
| BundleFile, scale и universal ingress | MD-245, MD-249–MD-250, MD-260, MD-266–MD-268, MD-270, MD-272–MD-275, MD-284, MD-288–MD-290 | Attachments, large import/export, quotas, local/generated/Google Drive sources и общий coordinator |

В незавершённом scope нет отдельной Task, которая владеет простым результатом
«обычный пользователь за три шага подключил Codex и понял, какие Minds доступны
для чтения и записи». Исторические MD-83, MD-152, MD-226 и MD-233 закрыты, но
они последовательно добавляли разные эпохи setup, не заменив старую
информационную архитектуру.

### Почему текущие статусы вводят в заблуждение

- `In Review` часто означает «engineering-ready, но нет exact hosted receipt»,
  а не обычный code review.
- `In Progress` одновременно используется для product epic, release
  orchestration и отсутствующего внешнего тестового входа.
- Label `Release blocker` назначен как обязательному MVP evidence, так и
  Google Drive/general file ingress expansion.
- Completed Task MD-161 уже называется exact pilot-ready release, хотя после
  неё в ту же Release добавлен большой новый graph. Поэтому её статус не может
  служить актуальным terminal signal.

## Фактический MCP Setup

Deployed page и integration source формируют один длинный document из шести
верхнеуровневых sections:

1. `Connected apps`;
2. `Your tokens`;
3. `Create an MCP token`;
4. manual Codex setup для compatibility и modern profiles;
5. starter и concierge playbooks;
6. safe-write, restore и export playbooks.

Для каждого OAuth grant и каждого personal token рендерится собственная
панель Mind bindings. В ней находятся read attachments, singleton writable
Mind, automatic capture и формы rebind/unbind. Revoked credentials остаются в
том же основном списке.

Snapshot, снятый ранее 2026-08-24 на authenticated UAT account:

| Наблюдение | Значение |
|---|---:|
| OAuth connections | 9 |
| Personal tokens | 28 |
| Revoked personal tokens | 26 |
| Credential cards / binding panels | 37 / 37 |
| Buttons | 52 |
| Видимый текст основного content | около 41 000 символов |

Это ожидаемое следствие source composition, а не аномальные данные одного
аккаунта. Даже чистый аккаунт получает manual protocol setup и playbooks рядом
с обычным OAuth onboarding, а использованный UAT account дополнительно
разворачивает историю credentials в десятки повторяющихся binding editors.

## Что в текущей модели правильно

Security model bindings сама по себе нужна:

- одна credential может иметь `0..N` read bindings;
- не более одного active write binding;
- write не имеет fallback на Personal Mind;
- commit передаёт и проверяет `write_binding_id` и current binding version;
- revoke и rebind fail closed.

Проблема не в этих инвариантах, а в их представлении. Пользователю нужен ответ
«что приложение может читать и куда оно может писать», а не 37 одновременно
раскрытых редакторов, protocol terminology и opaque identifiers.

## Несогласованность MVP scope

Принятые product docs определяют первый прототип как Markdown-first
Codex workflow и прямо относят productized import и non-Markdown files за
границу MVP. Текущий Release, напротив, блокируется на:

- Brain-scale storage/import;
- local companion;
- generated artifact ingress;
- Google Drive `connector_object` adapter;
- multi-source reconciliation;
- large export/capacity profile для расширенного file workflow.

Эти инициативы полезны, а значительная часть уже инженерно реализована. Но их
полезность не делает их автоматическим условием первого пользовательского
результата. Пока release boundary не принят заново, команда будет продолжать
закрывать расширение продукта вместо завершения MVP.

## Artifact и evidence drift

| Surface | Текущий сигнал |
|---|---|
| Local `main` | `cf50d86`, dirty; не release candidate |
| Последний deployed UAT evidence | `eca3400`, Sites deployment 50 |
| Свежий integration candidate | `1df46ec`; содержит поздние hardening commits |
| Hosted proof нового candidate | не доказан как единая full matrix |
| MCP Setup IA | одинакова в deployed baseline и integration candidate |

Поэтому нельзя закрывать Tasks только по repository checks и нельзя считать
live UAT соответствующим самому свежему коду. Но также нельзя требовать полный
hosted matrix заново для каждой внутренней Task: нужен один exact batch cutoff
и одна консолидированная acceptance matrix.
