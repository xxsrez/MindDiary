# ADR-0006: автономная доставка Linear milestone без профилей

Статус: accepted, 2026-08-08.

## Контекст

Mind Diary использует repo-local skill `ship-linear-release`, чтобы разбирать
незавершённые задачи текущего Linear milestone, интегрировать результат и
закрывать задачи на основании проверяемых evidence. Ранний вариант skill
добавлял искусственные `design`, `build` и `release` profiles. Профиль выбирался
по содержимому checkout и мог объявить deployment «неприменимым», даже если он
уже требовался acceptance текущего milestone.

Эта модель создавала второй источник истины рядом с Linear, `AGENTS.md` и
репозиторным release contract. Она также превращала отсутствующую реализацию в
причину остановки вместо обычной работы: например, отсутствие deployment config
могло блокировать `release`, хотя задача конвейера как раз состояла в создании
недостающего vertical slice.

## Решение

- `ship-linear-release` всегда доставляет все незавершённые задачи exact current
  Linear milestone. У него нет target/delivery profile и отдельного intent
  `design | build | release`.
- Обязательства каждого cutoff выводятся только из acceptance вошедших задач,
  действующего `AGENTS.md`, tracked repository contract и существующего
  toolchain. Production deployment выполняется тогда и только тогда, когда он
  требуется этими источниками.
- Отсутствующая реализация, конфигурация, тест или deployment path внутри уже
  принятого scope — actionable gap. Skill переоткрывает owning issue либо
  создаёт дедуплицированную связанную задачу и продолжает работу.
- Остановка с запросом к пользователю допустима только для настоящего внешнего
  или смыслового blocker: требуется новое продуктовое решение, противоречат
  друг другу authoritative требования, недоступен обязательный внешний ресурс
  без безопасной замены, либо после recovery нельзя доказать единственного
  владельца mutable state.
- По умолчанию используется один issue worker. `workers=N` задаёт точную
  устойчивую ёмкость, а `workers=auto` — единственный адаптивный режим. Число
  worker-ов меняет способ исполнения, но не done criteria и не release scope.
- При одном worker coordinator и executor совмещены, но issue всё равно
  выполняется в отдельном worktree. При нескольких worker coordinator является
  отдельным control-plane участником; каждая issue получает собственные
  worktree, branch, claim и publication guard.
- Worker выполняет только issue-scoped targeted checks. Coordinator собирает
  immutable cutoffs, выполняет один full repository gate на generation,
  продвигает exact SHA в default branch и выполняет требуемые production gates.
- Несколько сессий одного репозитория не становятся несколькими
  координаторами. Repo-global CAS claim выбирает одного владельца; проигравшая
  сессия остаётся read-only. Параллельность обеспечивается worker pool
  выигравшего run. Разные репозитории независимы.

Нормативные детали находятся в
[спецификации доставки milestone](../specs/linear-milestone-delivery.md),
операторский порядок — в
[runbook `ship-linear-release`](../operations/ship-linear-release.md).

## Последствия

- Goal больше не содержит profile и не может сделать часть acceptance
  «неприменимой» метаданными запуска.
- Наличие только исходников или только UI никогда не считается production
  release, если milestone требует полный Sites vertical slice.
- Если текущий milestone не требует внешнего deployment, skill не придумывает
  deploy или tag: он интегрирует, проверяет и закрывает фактически принятый
  scope.
- Dirty primary checkout не обязан блокировать независимую работу: безопасные
  изменения пользователя остаются нетронутыми, а delivery идёт из isolated
  worktrees. Dirty control surface или недоказуемое пересечение fail closed.
- Любой быстрый coordinator repair проходит через новый immutable cutoff и full
  gate. «Мелкая правка прямо в main» не означает непроверенный commit.

## Отклонённые варианты

- **Сохранить profiles как подсказку.** Даже необязательная подсказка быстро
  становится competing source of truth и позволяет ошибочно ослабить gates.
- **Всегда требовать production deployment.** Это придумывает обязательства для
  milestones, где acceptance ограничен документацией или внутренней
  реализацией.
- **Позволить второй сессии присоединяться к чужому run.** Без общего runtime
  identity и надёжного mailbox это создаёт split-brain. Один repo-global owner
  с собственным worker pool проще восстановить и доказать.
- **Останавливать run при любой грязной рабочей копии.** Это безопасно, но
  излишне: isolated clean worktrees не зависят от несвязанных изменений
  пользователя. Остановка нужна только при влиянии на control surface или
  невозможности доказать изоляцию.
