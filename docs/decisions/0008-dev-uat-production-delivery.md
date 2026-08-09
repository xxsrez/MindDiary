# ADR-0008: dev, UAT и production как разные environments

Статус: accepted, 2026-08-09.

Решение supersede-ит production-target semantics ADR-0004. ADR-0004 остаётся
историческим описанием первоначального Sites-only решения.

## Контекст

Текущий single-principal OpenAI Site ранее назывался production, хотя живых
пользователей на нём нет и владелец использует его для наблюдения, проверки и
частых deployment-ов внутри одного work scope. Из-за этого одно слово обозначало и
prod-like validation surface, и будущую live environment реальных
пользователей.

Перед hosted release нужна отдельная dev boundary, на которой exact candidate
можно запустить локально и проверить всё, что не требует Sites.

## Решение

### Dev

- `dev` — локальная environment на `localhost`.
- Она использует изолированные local/test data и не получает production
  secrets или production data.
- Canonical dev command — `npm run dev`; он обязан сообщать exact local URL.
- Перед каждым UAT cut exact candidate проходит full repository gate, затем
  localhost smoke всех доступных web/control/MCP/persistence flows.
- Hosted identity, Sites routing и hosted persistence остаются UAT gates и не
  объявляются доказанными локально.

### UAT

- `UAT` — отдельная prod-like environment без живых production users.
- Текущий OpenAI Site Mind Diary
  `<https://mind-diary.example.invalid>` классифицируется как UAT.
- UAT использует отдельные UAT data, owner identity и явно созданные test
  principals. Production data туда не копируются автоматически.
- Default release target `ship-work-release` — UAT. Для Mind Diary default
  cadence — `continuous-uat`; `manual-uat` меняет cadence, но не target.
- UAT cut связывает exact Git SHA, CI, Sites project/version/deployment, live
  URL, localhost dev evidence, web/control, persistence и MCP profile matrix.
- Несколько UAT cuts внутри одного work scope являются нормальным workflow.
- UAT smoke или owner observation не выдаются за production promotion.

### Production

- `production` — отдельная live environment с реальными users и production
  data.
- Production target пока не provisioned и его platform не выбрана этим ADR.
- `ship-work-release` не имеет production deployment path и не получает его
  через параметр, alias или свободную формулировку.
- Production release возможен только отдельным manual workflow после явного
  prompt владельца. Перед external effect требуется повторное confirmation с
  exact candidate/artifact, target и rollback plan.
- Eligible production candidate уже прошёл полный work-scope acceptance в UAT.
  Promotion использует тот же exact artifact/SHA; rebuild drift запрещён.
- Пока production target не provisioned, любой production release fail closed.

Project-specific commands, targets и evidence matrix принадлежат
[delivery profile](../operations/ship-work-release-profile.md), который следует
[универсальному profile contract](../specs/ship-work-release-project-profile.md),
а не базовой specification skill.

### Семантика слов

- «release», обычный `$ship-work-release` и команда без environment qualifier
  означают release в UAT.
- `release to UAT`, «зарелизить на UAT» явно означают UAT.
- `production`, `prod`, «продакшн» и «прод» никогда не являются alias UAT.
- Production prompt внутри `ship-work-release` получает отказ и handoff в
  отдельный manual workflow; skill не deploy-ит production даже после полного
  scope UAT release.

## Последствия

- Исторические reports и receipts не переписываются. Их старое слово
  production относится к deployment, который теперь классифицирован как UAT.
- Нормативная терминология использует `UAT evidence`, `UAT cut` и `scope UAT
  release`; production claim хранится отдельно.
- Work item может завершиться после полного принятого UAT acceptance, если его
  criteria не требуют отдельного production evidence.
- Dev, UAT и production имеют отдельные configs, data и external-effect
  journals. Rollback не пересекает environments.
- Contract требует localhost launcher/smoke, environment-typed state и
  отсутствия production deployment path в `ship-work-release`.

## Рассмотренные варианты

- **Считать текущий Site production, но использовать его как UAT.** Отклонено:
  название скрывает реальную силу evidence и делает production prompt
  двусмысленным.
- **Один Sites target одновременно UAT и production.** Отклонено: environments
  должны отличаться данными, аудиторией, authority и release intent.
- **Разрешить skill automatic production после work scope.** Отклонено:
  production требует отдельного ручного решения владельца.
- **Проверять только full repository gate без localhost run.** Отклонено:
  dev должен ловить доступные runtime/integration проблемы до UAT deployment.

Связанные документы:
[delivery specification](../specs/ship-work-release.md),
[project profile contract](../specs/ship-work-release-project-profile.md),
[operator runbook](../operations/ship-work-release.md),
[MVP specification](../specs/mvp.md) и
[architecture](../architecture.md).
