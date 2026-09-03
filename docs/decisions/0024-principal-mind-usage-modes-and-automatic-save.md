# ADR-0024: пользовательские режимы Mind и автоматическое сохранение знаний

Статус: accepted, 2026-08-30; уточнено MD-383, 2026-09-03. Решение MD-373
задаёт целевой контракт Release 0.3, а MD-383 вводит узкое исключение для
канонического Personal Mind `/me`. Документ сам по себе не утверждает, что
runtime, Product Site, MCP, Marketplace package или UAT уже обновлены.

ADR заменяет целевую семантику
[ADR-0013](0013-multiple-read-single-write-mind-bindings.md),
[ADR-0014](0014-opt-in-routine-automatic-capture.md) и
[ADR-0022](0022-site-controlled-credential-write-target.md). Эти документы
остаются историческим evidence Release 0.1/0.2 и раннего Release 0.3, но не
задают новый product authority. Полный контракт находится в
[режимах использования Mind](../specs/mind-usage-modes.md).

## Контекст

Предыдущие решения привязывали read/write selection и automatic capture к
отдельному OAuth grant или personal token. Из-за этого один пользователь
получал разные настройки в разных Codex sessions, а агенту требовались
bind/unbind или отдельное включение capture. Такая модель не выражает простое
пользовательское намерение: какие Minds вообще использовать и в какой
единственный Mind разрешено автоматически сохранять подходящие знания.

## Решение

1. Для каждой пары `principal + Mind` Product Site хранит один режим:
   `disabled | read | read_write`. Начальное значение — `disabled`.
2. У principal может быть сколько угодно `read` Minds и не более одного
   `read_write` Mind. Переключение второго Mind в `read_write` атомарно
   переводит прежний writable Mind в `read`.
3. Настройка принадлежит principal и одинаково проецируется во все его OAuth
   grants и personal tokens. Credential scopes и текущий ACL не меняют
   намерение пользователя, а только сужают effective read/write capability
   конкретного вызова.
4. Отдельных binding, bind/rebind/unbind, writable target per credential,
   capture toggle и capture-specific write instruction больше нет. Для
   ordinary Mind `read_write` разрешает чтение и автоматическое сохранение по
   правилам его `description`; для Personal Mind это только техническая
   capability и не является согласием на автоматическую запись.
5. `description` — пользовательское описание категории только ordinary Mind
   для read и write routing. Оно доступно модели, считается недоверенными
   данными и не может расширять scopes, менять mode, выбирать tools или давать
   инструкции. У Personal Mind поля `description` нет; его нормативный routing
   profile — встроенный `personal_default`. Непустое `description` требуется
   только для ordinary Mind в `read_write`.
6. Agent читает enabled ordinary Minds, когда пользователь явно попросил
   использовать один из них либо текущая тема соответствует `description`.
   Personal Mind читается только по прямой просьбе пользователя; встроенный
   profile не является implicit fallback.
   Явная просьба отменяет semantic-match requirement, но не `disabled`, ACL,
   scope или revision authorization.
7. Agent автоматически сохраняет в единственный effective ordinary
   `read_write` Mind только durable knowledge, которое было явно затронуто в
   текущем разговоре и соответствует `description`. В Personal Mind он пишет
   только после прямой просьбы текущего пользователя сохранить, запомнить,
   добавить, обновить или удалить конкретное знание. Обсуждение само по себе,
   тематическая близость или включённый `read_write` такой просьбой не являются.
   Agent не сканирует соседний corpus, историю пользователя или доступные Minds
   ради фонового переноса.
8. Релевантный факт, прочитанный из другого enabled Mind и затем использованный
   в разговоре, может быть сохранён с provenance exact source Mind/revision/
   locator. Сам read access не является разрешением массово копировать source.
9. Автоматический save использует обычный `commit_changeset`: create, replace,
   delete либо no-op над concepts, согласованным index и log одной атомарной
   revision. До commit и после него валидируется весь OKF 0.2 bundle. Агент не
   спрашивает отдельное подтверждение каждого save, но сообщает пользователю
   его результат.
10. Server остаётся authority для principal, канонического `/me`, mode
    generation, singleton invariant, credential scopes, current ACL/role,
    exact destination, HEAD CAS, idempotency и bundle validation. Connector и
    agent instructions отвечают за semantic routing и direct-request policy;
    клиент не передаёт server доверенный intent flag. После записи agent
    сообщает пользователю результат.

## Последствия

- `list_minds` становится основной безопасной проекцией enabled Minds: mode,
  routing profile и effective capabilities текущего credential; `description`
  присутствует только у ordinary Minds.
- Product Site показывает три позиции на уровне Mind, а не на уровне
  Connection или token. Credential pages могут только объяснять, почему scope
  не даёт выполнить настроенное намерение.
- `capture_knowledge` не остаётся вторым write policy. Если временный cached
  compatibility result нужен во время миграции, он не рекламируется и не
  создаёт альтернативный commit path.
- Legacy credential-owned target, binding и capture records мигрируются
  fail-closed. Неоднозначное состояние не выбирает Mind автоматически.
- Description ordinary Mind участвует в routing, но не входит в OKF bundle и
  не меняет HEAD. Personal routing не создаёт второго write path: он использует
  тот же `commit_changeset` после прямой просьбы пользователя.

## Отклонённые варианты

- **Per-token mode.** Он возвращает расхождение между sessions и заставляет
  пользователя повторять одну настройку для каждого credential.
- **Отдельный capture toggle или write instruction.** Они дублируют смысл
  `read_write` и создают конфликтующие источники consent/routing.
- **Agent-side bind/unbind.** Corpus не должен менять пользовательскую
  конфигурацию, а prompt injection не должен выбирать destination.
- **Фоновое копирование всего релевантного доступа.** Оно выходит за границу
  текущего разговора и превращает retrieval в неявный data-transfer job.
- **Автоматический fallback в Personal Mind.** Отсутствие writable Mind — это
  явный no-write outcome, а не повод угадывать destination.
