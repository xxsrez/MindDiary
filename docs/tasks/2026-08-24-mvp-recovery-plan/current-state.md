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

После третьего критического прогона и reconciliation в Project 215 Tasks:

| Состояние | Количество |
|---|---:|
| Done | 119 |
| Canceled | 56 |
| In Review | 22 |
| In Progress | 7 |
| Todo | 11 |
| Backlog | 0 |

В Release `0.1` находятся 140 Tasks: 119 Done и 21 незавершённая
(`Todo 11 / started 10 / Backlog 0`). Девятнадцать незавершённых file/scale
Tasks уже выведены из Release, но сохранены в Project с history, hierarchy и
evidence. Принятые product docs всё ещё противоречат этому small-data scope;
normative amendment остаётся внутренним gate MD-292.

### 21 незавершённая Release Task по реальному outcome

| Контур | Tasks | Смысл |
|---|---|---|
| Release/UAT governance и operator | MD-244, MD-280–MD-283, MD-285–MD-287 | Тестовые principals, operator evidence, privacy boundary и переход на Task Manager |
| Runtime и performance | MD-252, MD-258 | Recovery индекса и small-data latency gate |
| Recovery plan и connection UX | MD-291–MD-301 | Normative boundary, единый Git baseline, routes/access/pagination/onboarding, browser gate и final receipt |

### 19 активных post-MVP Tasks вне Release 0.1

| Контур | Tasks | Disposition |
|---|---|---|
| BundleFile | MD-245, MD-249–MD-250 | Сохранены в Project, `medium`, без `Release blocker` 0.1 |
| Scale/runtime | MD-257, MD-259–MD-261, MD-266–MD-268 | Scale Epic и supporting optimizations не удерживают MD-258 |
| Universal ingress | MD-270, MD-272–MD-275 | Сохранены для следующего milestone |
| Provider/capacity canaries | MD-284, MD-288–MD-290 | Сохранены для следующего milestone |

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
- Label `Release blocker` после reconciliation остался только у P0 Tasks;
  Google Drive/general file ingress больше не находятся в Release 0.1.
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

Базовый prototype contract остаётся Markdown-first Codex workflow, но более
поздние accepted ADR/spec/roadmap amendments добавили BundleFile и Brain-scale
import в Release 0.1. До planning reconciliation live Release также содержал:

- Brain-scale storage/import;
- local companion;
- generated artifact ingress;
- Google Drive `connector_object` adapter;
- multi-source reconciliation;
- large export/capacity profile для расширенного file workflow.

Эти инициативы полезны, а значительная часть уже инженерно реализована. Но их
полезность не делает их автоматическим условием первого пользовательского
результата. Task composition уже исправлена; accepted docs ещё нет. Следующий
обязательный шаг — нормативно привести их к тому же scope в MD-292.

## Acceptance ownership после третьего review

- Browser/Computer Use navigation, Marketplace/OAuth flow, hosted canaries,
  runner, cleanup, receipts и evidence-backed status transition принадлежат
  agent-у.
- Пользователь не выполняет отдельную ручную приёмку.
- Human-only остаются ввод password/MFA/passkey, OS security prompt и создание
  отсутствующей внешней identity.
- Persistent UAT audience/operator-allowlist либо OAuth-scope expansion требует
  одного at-action подтверждения; само действие и read-back затем выполняет
  agent.
- Production, новая privacy policy и fallback при отсутствии incremental OAuth
  consent остаются отдельными product decisions.

## Artifact и evidence drift

| Surface | Текущий сигнал |
|---|---|
| Local/remote `main` | clean planning baseline на момент fresh read; exact SHA меняется при обновлении review package и не является integrated candidate |
| Последний deployed UAT evidence | `eca3400`, Sites deployment 50 |
| Engineering candidate | `1df46ec`; справа остаётся 21 engineering commit, а изменяющееся число слева нужно читать fresh командой ниже |
| Hosted proof нового candidate | не доказан как единая full matrix |
| MCP Setup IA | одинакова в deployed baseline и integration candidate |

MD-301 обязан превратить две Git-линии в один exact `main` tip до UI code.
Repository checks не заменяют live UAT, но полный hosted matrix также не
повторяется для каждой внутренней Task: используется один exact batch cutoff и
одна консолидированная acceptance matrix.

Перед любой интеграцией текущий divergence проверяется заново:

```bash
git rev-list --left-right --count main...1df46ec
```

Датированные значения вроде прежних `2/21` или наблюдавшихся перед этим review
`4/21` не являются release contract и не должны копироваться в acceptance.
