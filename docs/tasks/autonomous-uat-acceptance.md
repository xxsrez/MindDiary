# Автономная UAT-приёмка Mind Diary

Статус: реализация начата по прямому поручению пользователя, 2026-09-05.
Issue Grinder, режим Соло, одна execution lane без субагентов. Goal пересоздан
после удаления прежнего; выбран только MD-400, а не старый MD-394.
Task Manager: Epic MD-400, Project Mind Diary, Release 0.3. Семь дочерних задач
переведены из Backlog в Todo по поручению начать работу; MD-400 и MD-401
переведены в In Progress. Актуальный lifecycle принадлежит Task Manager.

## Требование пользователя

Агент должен сам создавать нескольких тестовых пользователей, проводить
сложные сценарии приёмки и завершать проверки без рутинного участия пользователя.
Пользователь не должен создавать новые аккаунты, вручную выпускать токены и
восстанавливать тестовые данные для каждого запуска.

## Что существует и почему этого недостаточно

Локальная synthetic composition уже подаёт trusted identity snapshot до
обычного bootstrap и выполняет нормальные application operations.
[ADR-0012](../decisions/0012-synthetic-principal-release-gates.md) исключает её
из Product Site/UAT bundle. [Доменная модель](../specs/domain-model.md) запрещает
выбор личности из произвольного header, cookie, runtime flag или запроса.
Предлагаемый ниже механизм требует новой принятой спецификации до реализации.

MD-282 отмечена Done и описывает пул трёх реальных Sites accounts. Это
существенный предшественник, а не готовое доказательство доступности сессий
сегодня. MD-401 проверяет её evidence и переиспользуемые capabilities, не
переоткрывая историческую задачу и не копируя её scope.
В текущем процессе отсутствуют три environment references для canary и ключ
корреляции performance. Это не доказывает отсутствия аккаунтов или ключа у
провайдера; нужна проверка способа их безопасного получения.

[Профиль доставки](../operations/ship-work-release-profile.md) требует
operator-directory canary и performance evidence. Есть противоречие:
machine profile запрещал bootstrap/product mutations, а
[runbook](../operations/uat-operator-directory-canary.md) и runner описывают
обычную регистрацию, выпуск токенов и очистку. MD-401 согласовала профиль с
runbook: normal idempotent bootstrap трёх аутентифицированных тестовых actors,
собственные временные Minds и краткоживущие read-only tokens. Входов ровно три
Sites session references; MCP tokens runner выпускает сам. Изменение provider
configuration по-прежнему запрещено; обязательность canary не снижена.

## Предлагаемая архитектура

Отдельный hosted target автоматической приёмки с собственными origin, базой,
объектным хранилищем и секретами. Исходный вариант — тот же Sites runtime;
возможность такого provisioning и штатного автоматического browser execution
сначала проверяется. Новый провайдер, AWS, внешние аккаунты и платные seats
не являются молчаливым fallback.

Отдельная тестовая сборка использует общие domain/application/storage/API/UI
модули, но отдельный identity adapter и entrypoint. Обычная сборка не содержит
тестового issuer/resolver или runtime-переключателя. Поскольку артефакты
различаются, evidence связывает digest общих модулей и отдельно identity
adapter; не заявляет, что test artifact идентичен обычному Site binary.

Контроллер запуска аутентифицируется ограниченной bootstrap capability из
управляемой ссылки на секрет. Сервер сам создаёт случайные subjects в
пространстве конкретного run, выдаёт короткие session leases с audience и
защитой от replay. Одноразовый обмен создаёт host-only HttpOnly web session.
Нельзя выбрать existing principal, чужую email identity или готовую роль
полем запроса. CSRF/Origin и current authorization сохраняются.

Затем обычная регистрация создаёт Principals и Personal Minds. Owner, Editor,
Reader и outsider получаются через настоящие create/invite/accept/transfer
flows. MCP credentials выдаются штатными control operations с реальными
scopes. Operator actor ограничен тестовым run и отдельным target. Никаких
прямых вставок ACL, токенов или memberships в storage.

Контроллер хранит закрытый recovery journal до первого изменения. Все ресурсы
имеют run ownership, срок жизни и квоты. Повторный запуск восстанавливает exact
unknown payloads, отзывает tokens и чистит только свои данные. Background
cleanup ограничен тестовыми ресурсами и не читает настоящий Personal corpus.

## Граница доказательств

| Проверка | Автономное evidence | Что остаётся отдельным |
|---|---|---|
| Bootstrap, роли, Personal isolation | Обычные product APIs на тестовых identities | Настоящая identity от Sites |
| Web forms, CSRF, session lifecycle | Автоматический browser с отдельными contexts | Доступность самого browser tool |
| MCP/OAuth/PKCE/scopes/revoke | Реальные протоколы, тестовая identity только на login boundary | Вход пользователя через Sites/внешний клиент |
| Persistence, CAS, history, OKF | Hosted store, точные revisions, redeploy | Идентичность test и обычного artifact не предполагается |
| Правила агента и compaction | Fresh package/model context и наблюдённые tool traces | Текст в skill сам по себе ничего не доказывает |
| Performance | Подписанные запросы, telemetry и точный fixture | Локальные timings не заменяют hosted measurement |

Настоящие Sites identity/audience/first-user canaries сохраняются обязательными
там, где изменяется соответствующая поверхность. Предлагается явная
prospective applicability matrix для routine product changes, а не отмена
неудобных проверок. Новый mapping принимается до использования для MD-399;
прошлые receipts не переписываются. Если платформа требует человеческий вход
и не даёт автоматическую capability, это остаётся ограничением, а не pass.

Отказ Codex Browser проверить admin-enforced policy — отдельный blocker
инструмента. Новый runner не используется как обход этого отказа. Его среда,
полномочия и поддерживаемый маршрут проверяются самостоятельным первым этапом.

## Этапы и зависимости

- **MD-401 — Утвердить контракт автономной приёмки и проверить возможности Sites.** Зависит от: нет.
- **MD-402 — Развернуть изолированную среду автоматической приёмки.** Зависит от: MD-401.
- **MD-403 — Выдавать краткоживущие сессии тестовым пользователям.** Зависит от: MD-401.
- **MD-404 — Управлять тестовыми данными и очисткой каждого запуска.** Зависит от: MD-403.
- **MD-405 — Запускать сценарии UI, MCP и поведения агента без пользователя.** Зависит от: MD-402, MD-404.
- **MD-406 — Связать автоматические отчёты с правилами приёмки и замерами.** Зависит от: MD-401, MD-404.
- **MD-407 — Подтвердить автономную приёмку повторным запуском и восстановлением.** Зависит от: MD-405, MD-406.

MD-400 связан через related с MD-282 и MD-399. Эти связи не закрывают прежние
задачи и не создают автоматического переноса приёмки.

## MD-401: Утвердить контракт автономной приёмки и проверить возможности Sites

Результат: исполнимый контракт автоматической UAT-приёмки без ручного создания аккаунтов. Пользователь требует, чтобы агент сам создавал нескольких тестовых пользователей и проверял сценарии без его участия.

План агента: проверить evidence и безопасные ссылки на доступ MD-282, фактические возможности Sites для отдельного target, фоновых browser/API runs и получения test sessions. Проверить current provider capability без создания внешних аккаунтов, покупки seats или обхода browser policy. Сопоставить ADR-0012/0019, domain-model, architecture, release-profile и operator-directory runbook; устранить противоречие запрета bootstrap в profile и разрешения в runner/runbook. Описать изолированный test entrypoint и явно отличающийся identity adapter при одинаковых product modules. Реальные Sites login/audience/first-user claims вынести в отдельную матрицу применимости по изменённой поверхности.

Приёмка: ADR/spec и таблица доказательств явно определяют, какие проверки автономны, какие требуют платформенных capabilities; подтверждён маршрут provisioning, secret references, target/storage isolation и browser execution. Если Sites не поддерживает выбранный путь, зафиксирован конкретный отказ и предложен вариант для отдельного решения; никакого автоматического AWS fallback. До принятия ADR действующие product identity restrictions сохраняются. Исторические Done/receipts не переименовываются и не считаются текущими.

## MD-402: Развернуть изолированную среду автоматической приёмки

Результат: воспроизводимый отдельный UAT target для синтетических сценариев, не содержащий личных данных пользователя. Это позволяет агенту готовить тестовые прогоны без ручных действий.

План агента: после подтверждения платформы реализовать отдельный build/composition entrypoint и автоматизацию provision/build/deploy/read-back с отдельными D1/R2 либо подтверждёнными эквивалентами текущей платформы. Обычный Site и будущая production сборка не содержат тестового login endpoint, provider или ключей. Не переключать обычный Worker в тестовый режим runtime-флагом. В evidence связать candidate SHA, digest общих product modules, test adapter digest, target ID, deployment и schema migration. Артефакты тестовой и обычной сборки различаются — не объявлять их одним binary.

Приёмка: чистое развёртывание и redeploy воспроизводимы; persisted fixtures переживают redeploy; независимость базы, bucket, секретов и origin доказана отрицательными тестами. Ошибка target/audience не даёт доступа к обычной UAT или production. Ресурсные лимиты заданы конфигурацией, teardown затрагивает только выделенный target. Никаких новых облачных провайдеров, платных seats и неограниченных затрат без отдельного решения.

## MD-403: Выдавать краткоживущие сессии тестовым пользователям

Результат: автоматизация сама получает независимые тестовые личности и web sessions для одного запуска; обычная регистрация создаёт настоящие domain Principals и Personal Minds.

План агента: отдельная тестовая identity authority, доступная только в test composition. Защищённая bootstrap capability из управляемого secret reference; сервер выдаёт run-bound случайные subjects, короткий TTL и audience, не принимает произвольный существующий principal/email/role из клиента. Одноразовый обмен на secure host-only HttpOnly session, CSRF/Origin checks; rotation/revoke/replay protection и привязка к run. Namespace не пересекается с openai-sites. Тестовая сессия проходит обычные auth adapters и bootstrap; MCP tokens выдаются через нормальные control operations с реальными scopes. Operator identity разрешается отдельно только для созданного run actor и не расширяет обычную UAT.

Приёмка: минимум четыре независимых actor, expired/revoked/replayed/wrong-audience/wrong-run credentials отвергаются; произвольная impersonation и использование test credential на обычном Site невозможны. Старые MCP grants не расширяются. Нет прямого seed ACL/roles/tokens и универсального bearer-доступа. Secrets не печатаются и не попадают в Git/evidence. Первоначальный инфраструктурный setup отделён от полностью автономного повседневного запуска.

## MD-404: Управлять тестовыми данными и очисткой каждого запуска

Результат: один запуск получает воспроизводимых actor и fixtures, а после завершения или сбоя оставляет проверяемое чистое состояние без действий пользователя.

План агента: SDK setup/verify/cleanup/recover с run ID, lease, сроком жизни и лимитами. Actor aliases owner/editor/reader/outsider/operator/disposable создаются по сценарию; права формируются обычными create/invite/accept/transfer operations. Готовить малые OKF/BundleFile fixtures, independent Personal/ordinary lanes и revision histories через product APIs. Сохранять закрытый recovery journal до mutation, exact payload/key для unknown outcomes, leases и inventory принадлежащих запуску ресурсов. Cleanup обычными revoke/delete операциями, с read-back; sweeper после interruption использует ограниченный run-owned доступ. Не трогать чужие и личные данные.

Приёмка: crash в setup, после commit и во время cleanup; повторный recover идемпотентен, неизвестный результат reconcile-ится без дублей; два параллельных запуска не мешают друг другу; reaper не удаляет активный run. Отзыв credentials доказан следующим denied request. Сняты baseline/final counts, история и tombstones трактуются по реальному deletion contract; не заявлять удаление данных только по пустому списку tokens.

## MD-405: Запускать сценарии UI, MCP и поведения агента без пользователя

Результат: один управляющий запуск сам готовит пользователей и выполняет продуктовую матрицу через настоящие web/MCP interfaces на выделенном target.

План агента: переиспользовать существующие synthetic suites и общие assertions, добавить поддерживаемый автоматический browser runner с отдельными contexts. Не использовать его для обхода текущего отказа Codex browser security: отдельное разрешённое окружение исполнения и его capability проверяются первым этапом. Проверять UI forms включая opt-in personal:configure, modern/compat MCP, normal OAuth DCR/PKCE/consent/scopes/refresh/revoke, ACL isolation/roles/invitations, revision CAS/history/OKF, persistence-after-redeploy. Personal matrix: null/empty/described × disabled/read/read_write; overlap, exclusions, explicit target, no match, non-durable/no-op, description injection, Personal-to-shared negative case, independent commits и partial/unknown reconciliation.

Отдельная оценка model behavior использует точный installed package и fresh model context, фиксированные synthetic inputs, реальные tool traces, oracle ожидаемых/запрещённых действий и budget. Compaction действительно выполняется и проверяется по последующему trace; статический поиск строки в skill не считается behavioral evidence. Не запускать скрытые subagents вопреки delivery mode.

Приёмка: сценарии исполняются без ручного ввода пользователя; преднамеренные ошибки вызывают failure; raw credentials/corpus не публикуются; model/CLI/package/candidate/deployment привязаны к trace. Platform login не называется проверенным synthetic OAuth сценарием.

## MD-406: Связать автоматические отчёты с правилами приёмки и замерами

Результат: агент получает проверяемые отчёты, позволяющие принимать продуктовые изменения без требования ручных аккаунтов для каждой неизменённой платформенной поверхности.

План агента: новые versioned receipts и validators для automated hosted target, identity adapter/common-module digests, assertions, fixture counts, credential isolation и cleanup. Автоматически получать ограниченный performance-correlation secret reference, собирать подписанные запросы и provider telemetry; минимум 20 warm samples и подходящие starter/small histories из существующего performance contract. Не заменять unavailable measurements синтетическими таймингами.

Обновить release profile, runbooks и join-validators после принятия ADR: explicit changed-surface applicability для настоящих Sites identity/audience/first-user canaries, сохраняя их blocking там, где они проверяют изменённую поверхность. Автоматические продуктовые tests не доказывают provider identity. Новая политика действует перспективно, не переписывает старые receipts/Done; перенос acceptance MD-399 выполняется отдельным явным mapping, без молчаливого снижения требований.

Приёмка: wrong SHA/deployment/adapter/package, отсутствующий assertion, forged telemetry, failed cleanup или неполная coverage дают fail. Real platform test остаётся required при изменении соответствующего adapter. В отчёте явно разделены product, platform, browser-tool и model-behavior результаты, неизвестное не становится passed.

## MD-407: Подтвердить автономную приёмку повторным запуском и восстановлением

Результат: полный цикл от создания тестовых пользователей до итоговой приёмки повторяем и не требует участия пользователя.

План агента: на exact candidate/package/deployment выполнить два последовательных чистых запуска, затем прерванный запуск и автоматический recover с повторной приёмкой. Включить overlapping runs, TTL expiry, revoked session, partial write, conflict и недоступность одного сервиса; управляющий процесс честно завершает failure либо продолжает с проверенной точки. Прогнать конкретную matrix MD-399 на новом тестовом target и отдельно применимые проверки обычной UAT. Зафиксировать одноразовые prerequisites/rotation и пригодную агенту команду запуска; не требовать выдачи новых пользовательских credentials на каждый run.

Приёмка: все обязательные assertions из утверждённого mapping имеют exact evidence, ноль рутинных действий пользователя, ресурсные и inference limits соблюдены, секреты не утекли, cleanup/recovery read-back подтверждён. Недоступный реальный Sites login или browser policy не маскируется product success. Epic закрывается только после этих проверок; MD-394/399 не закрывать только из-за создания инфраструктуры. Production и личный corpus исключены.

## MD-401: проверка возможностей, 2026-09-05

Проверено по текущему коду, описаниям подключённых Sites tools и живой истории
MD-282; сведения ниже не являются подтверждением нового deployment.

- MD-282 действительно завершена: её финальный комментарий от 2026-08-25
  подтверждает три independently authenticated Sites accounts, UAT version 58,
  candidate `b162713b5b20604fd80d21bd14d38098ec77d698` и cleanup. Ранее
  запрошенное участие пользователя было отменено последующими результатами.
  Текущая доступность этих сессий не подтверждена. Checked-in runbook пула
  описывает передачу сессий через внешний secret channel, но не содержит
  автоматического способа восстановления утраченного входа.
- Текущий каталог Sites tools имеет создание отдельного Site, собственные
  environment variables и private deployment. Инструмент создания внешних
  ChatGPT/Sites accounts в доступном каталоге не найден.
- `sites_generate_siwc_bypass_token` выдаёт bearer для **identity-less**
  requests в заголовке `OAI-Sites-Authorization`. Он проходит Sign in with
  ChatGPT gate, но не создаёт platform-authenticated actor. Повторная выдача
  немедленно инвалидирует прежний токен. TTL и автоматическое продление не
  гарантированы опубликованным tool contract; это нельзя приписывать сервису.
- Тот же tool contract требует: «Call this explicit token tool only when the
  user asks for a bypass token». Пользователь затем прямо разрешил bypass
  tokens и настройку среды. Токен нового Site выдан, прежний blocker снят.
- `scripts/lib/synthetic-browser-composition.mjs` уже использует обычную
  `createProductSiteRuntime`, отдельный trusted identity reader и
  constructor-only namespace `synthetic-test`. База и R2 здесь fake; локальный
  результат не доказывает hosted persistence. Этот код даёт существующий
  composition seam, но не готовый hosted issuer.
- Исправлена противоречивая authority declaration operator canary в профиле.
  `loadCredentialEnvironment` принимает три distinct Sites sessions; runner
  сам делает normal bootstrap, выдаёт read tokens на час, затем отзывает их
  и удаляет собственный temporary Mind. Обязательный статус canary сохранён.

### Конкретный вариант следующего этапа

Выделить новый закрытый Site `mind-diary-acceptance`, отдельные D1/R2 и секреты.
Platform bypass token используется только на нём; существующий пользовательский
UAT Site и его platform token не менять. В частном controller secret store
хранить ссылку на platform token и отдельную случайную bootstrap capability.
Ротация platform token — явная provisioning/recovery операция, а не шаг
каждого тестового запуска. Токен нельзя писать в Git, receipts, Task Manager,
CLI arguments, browser URL или передавать на другой origin.

Отдельный build entrypoint проверяет bootstrap capability, создаёт run и
случайные subjects; запрос не принимает email, principal или готовую роль.
Начальные пределы для реализации: до двух параллельных runs, 4–8 actors на
run, run lease до 60 минут, web session до 15 минут, одноразовый exchange до
60 секунд. Истечение run немедленно запрещает новые product requests, но
оставляет отдельную ограниченную возможность восстановить очистку своего run.
Replay exchange, wrong audience, expired/revoked run и actor из другого run
должны завершаться отказом до product bootstrap. Перезапуск Worker не должен
восстанавливать использованный exchange или отозванную сессию.

Архитектура принята в [ADR-0026](../decisions/0026-autonomous-acceptance-environment.md)
после проверки private transport и browser capability. Полная реализация
test identity/runtime и приёмка продукта остаются следующими задачами. Прежний отказ browser tool
из-за невозможности проверить admin policy не разрешает обходить его другим
клиентом. REST smoke без browser не может закрыть UI acceptance.

## Текущее состояние и следующий шаг

План и семь задач созданы; scope восстановлен. Работа MD-401 завершена:
исторический пул и доступный identity seam проверены, противоречие профиля
исправлено. Platform transport, persistence/redeploy/cleanup и browser
capability проверены; принят ADR-0026. Прямое разрешение на bypass token получено.
Следующий шаг — MD-402, общие product modules в отдельной сборке; затем MD-403,
краткоживущие test sessions. MD-402–MD-407 ещё не завершены.

Создан новый Site `appgprj_example8ca2ca9e5243cfd6`, ожидаемый origin
`https://mind-diary-acceptance.example.invalid`; это отдельная тестовая
среда, а не production продукта. Manifest записан в
`apps/mind-diary-acceptance/.openai/hosting.json`. В Sites настроен отдельный
secret `MD_ACCEPTANCE_CONTROLLER_KEY` (environment revision 1). Platform token
и controller key сохранены в закрытом локальном secret store вне Git.
Новые product users пока не созданы. Audience обычной UAT, production и
статусы MD-394 не менялись. Goal по инструменту пока имеет статус blocked:
`update_goal` не умеет resume; это ограничение управления Goal не препятствует
исполнению текущего прямого поручения пользователя.

Отдельный `apps/mind-diary-acceptance/worker.mjs` проверяет только platform
transport и D1/R2. Он не импортируется обычным Product Worker и не содержит
product identity adapter. `reserve` выдаёт случайный recovery ID до writes;
контроллер обязан сохранить его до setup. Setup повторяем, verify сравнивает
синтетический marker в D1/R2, cleanup удаляет только этот ID и подтверждает
отсутствие. Каждый API request требует controller key; чужой Origin запрещён.
Целевые negative tests: 3/3 passed. Полный repository gate: 1125 tests и 68
browser tests passed; CI `33990033364` passed на candidate
`0d273aeec4fda1435270c1e8fda02bdbbfd12c21`. Source mirror
`a7edb416ada7ff9dafc9cf5b6374ccf3c4df3d32` имеет exact subtree
`d36afb2dbe4b2e3f739cd74e57bd83227005cfab`. Версия тестового Site — 1;
deployment `appgdep_examplea127b98954bb14ff` и controlled redeploy
`appgdep_example8ef0c54b1da85c8c` succeeded, env revision 1.
Provider archive hash — `05b29b55d30a801cb05ae9bd6cb08669fc4004a2b465f871952ac8d210a874ca`.
Без platform token запрос вернул 401, без controller key — 401, с чужим
Origin — 403. D1/R2 marker совпал до и после redeploy. Cleanup и повторный
cleanup вернули `cleaned`; journal сохранён закрыто. Live D1 overview нового
Site показал только `md_acceptance_probe`, без product tables другого target.

Встроенный Codex Browser прошёл штатный owner login и показал страницу стенда.
`Target.createBrowserContext` через его CDP не поддержан. Отдельный CI workflow
`Acceptance platform capability`, run `33990514407`, успешно проверил два
изолированных headless browser contexts, отсутствие общей cookie и открытие
private Site с platform token. Runner SHA
`40e3596c0dd95e92ea1986d60a4d865932bde5f7`; это отдельный carrier от deployment
candidate. Ни эти результаты, ни принятый ADR не являются полной продуктовой
приёмкой или основанием закрыть MD-399.

## MD-402: отдельная product composition

MD-401 переведена в Done с read-back, MD-402 — в In Progress. Новый entrypoint
собирает обычные domain/application/UI/protocol/storage modules и общий
request-recovery/runtime-cache. Synthetic namespace задаётся только здесь;
до MD-403 identity reader всегда unauthenticated, включая запрос с
`oai-authenticated-user-email`. Локальный запуск реального bundle на isolated
fake D1/R2 подтвердил `401/authentication_required` для такого запроса.

Входной guard до обращения к probe/assets/runtime требует exact test origin,
environment project ID и public origin; внешний operator allowlist запрещён.
Четыре targeted negative tests прошли. Конфигурация run/session limits задана
в `runtime-target.mjs`; её enforcement относится к issuer MD-403, поскольку
эта итерация ещё не создаёт runs/actors. Secret environment revision 2 содержит
независимые product token/locator/export/CSRF/performance keys.

Build использует pinned esbuild 0.28.2 (npm audit: 0 vulnerabilities) и пишет
candidate/dirty state, отдельные common-module/test-adapter/dependency digests,
lock digest, exact input hashes и server SHA в `.openai/acceptance-build.json`.
`npm --prefix apps/mind-diary-acceptance run verify` проверяет clean exact HEAD,
manifest/bindings, bytes и все input hashes; dirty build уже отвергнут в
negative probe. Эти build/verify steps включены в CI после общего gate.
Полный gate прошёл: 1126 tests, 68 browser tests; CI `33991112972` succeeded.
Candidate `e9ddcd3abd60ec30227ef252c7cc7c2ac9c66777`, source mirror
`ac60f1cf934cb130040c36f619aec41bf9d11229`, subtree
`5ce7dd452b0065ba0745453ad726ab849f673c49`. Проверка 226 inputs прошла локально
и в CI с одинаковым server hash
`5426eec2df77c8b5dd1c3a4b8ddaa3f775498232a2a2824d8524534533cbf50d`;
намеренно изменённый серверный файл отвергнут, исходные bytes восстановлены
и снова проверены. Common digest
`dd4eec363c8e13efae6c9ebc39ab375140fbed4a7f1f87fbb2a73e1cdd254ffb`, adapter digest
`2cb17fa0621828d5441ea8e1d486317156d63ce63261e7aad1bbb84703235261`.

Test Site version 2: deployment `appgdep_example373017a764e95319` и
controlled redeploy `appgdep_exampled5f4e82d46eb3b49` succeeded, env
revision 2. Live `/_acceptance/build` совпал с artifact; session со spoofed
email и MCP без product credential дали 401. Обычная страница Connections
отрисована в Codex Browser в signed-out состоянии, без account bootstrap.
D1/R2 marker пережил redeploy; cleanup и повторный cleanup подтверждены.
CI browser run `33991356905` succeeded на том же candidate, два independent
contexts. MD-402 готова; следующий этап — MD-403. Продуктовые users/runs и
enforcement run/session limits ещё не реализованы и не объявлены готовыми.

## MD-403: краткоживущие тестовые сессии

MD-401 и MD-402 завершены с live read-back. MD-403 остаётся In Progress:
реализован отдельный controller API создания ограниченного run, случайных
actors и одноразового обмена на host-only HttpOnly cookie. D1 хранит только
хеши секретов; атомарный exchange защищён от конкурентного replay, ротация
отзывает предыдущую сессию. Run ограничивает web identity и дополнительно
сужает результат штатной MCP bearer-аутентификации; роли/scopes не выдаются
тестовым header. Operator profile эксклюзивен до очистки остальных runs.

Восемь новых локальных тестов прошли на SQLite с реальным product runtime:
четыре штатных bootstrap создали независимые principals/Personal Minds,
обычный MCP token работает только со своим активным run и отклоняется после
отзыва. Проверены replay/rotation, TTL, чужой audience/run, подмена identity,
controller/Origin и ограничение тела запроса. Полный repository gate прошёл.
Это пока локальная проверка: новый issuer ещё не опубликован в hosted target.
Очистка/recovery (MD-404), полная матрица агента (MD-405), отчёты/замеры
(MD-406) и два итоговых запуска с прерыванием (MD-407) остаются впереди.

## MD-404: восстановление очистки

MD-403 implementation candidate `167e1b6bb52e3faa2356a6f7095cd16bdca4e73a`
прошёл локальные 1134 tests / 68 browser tests и CI `33992744676`.
MD-403 ещё не закрыта: hosted actor acceptance будет выполнена вместе с
первым безопасно очищаемым стендом. MD-404 начата, поскольку её зависимость
реализована в integration base; это не подмена status MD-403.

Server cleanup сначала отзывает обычный доступ, затем по каждому actor
сохраняет deletion command перед штатным account DELETE. Lock и журнал
хранятся в отдельной test metadata. Для сбоя после удаления identity создан
узкий in-process port продолжения уже committed AccountDeletionService;
он отказывает для действующего аккаунта и не создаёт новый deletion intent.
Reaper выбирает только expired/revoked/cleaning runs, максимум два за вызов.

Локальные проверки: interruption после revoke, перед DELETE, после DELETE
и между actors; повторный журнал не дублирует commits, соседний active run
сохранён. Сквозной SQLite/product-runtime test искусственно прерывает R2 delete,
повторный cleanup завершает pending work; после четырёх аккаунтов R2 пуст,
MCP token отклонён, повторный cleanup возвращает сохранённый receipt.
Эти проверки не заменяют hosted acceptance, SDK fixtures, полную матрицу
пересечений и final/baseline counts. Задача остаётся In Progress.

### Hosted sessions и фактическое восстановление

Candidate `df001dbf605e45b1b482501030f19e9bb12c58e1`, CI `33993159765`
прошёл; 229 build inputs verified. Source mirror
`e6fb0e669ee7bc07d50f8478ee532323807158eb`, Site version 3, deployment
`appgdep_examplee355ae314debe841` succeeded, env revision 2.
Server hash `4dd9845cfb2e2884cc95e4c3f17f2af2abc5e80a9ba75b1989525da9ebf726ed`.
Archive provider hash `73f6ec7a2e637c6a22a6628416d17bb4ebdc535fdcceb89960837a97171c3181`.

На этом hosted target normal bootstrap создал четыре независимых principals
и Personal Minds. Normal read-scoped MCP token работает; repeated exchange,
wrong run и access после revoke отклонены. Запрос cleanup превысил клиентские
45 секунд: результат был unknown, а не failure/pass. Live journal показал три
завершённых actor и сохранённый успешный DELETE четвёртого. После read-back
продолжен тот же run, без повторного setup; получен final `cleaned` receipt на
четыре accounts. Штатная очистка отозвала token, удалила четыре indexed revisions
и два shared canonical objects. Прямой read-back D1: actors, sessions и cleanup
journal пусты. Это подтверждение данного сценария, не всей MD-404.

По результату hosted timeout следующий cut ограничивает cleanup request одним
actor. Клиент продолжает `state=cleaning` до final receipt. Добавлен private
SDK journal: exact create/mutation keys и payload сохраняются до запроса;
локальный тест потери ответа подтверждает повтор исходных keys и неизменного
payload; после сохранённого success повторный запрос не отправляется. Полная SDK fixture/matrix приёмка ещё впереди.

### Повторяемый набор данных и независимая сверка остатков

Реальный 60-секундный hosted run подтвердил expiry: web session и новый
exchange отклонены, затем run очищен. Дополнительный локальный тест собирает
настоящий ordinary Worker entrypoint (только неиспользуемый UI fallback заменён
заглушкой): валидная acceptance cookie даёт 401, test adapter отсутствует во
входах ordinary bundle. MD-403 переведена в In Review до фиксации этого теста.

Version 4 (`ce8ec73b1f93c687618b1f60b74743a5e8d072af`, CI `33993682124`)
опубликована: source `a69b2cad100d874fca2d68be7b3631cd7c67dd63`, deployment
`appgdep_example322911c03a7bfb66`, env revision 2. Cleanup выполняется
по одному actor; отдельная проверка с полным SDK fixture относится к следующему
cut, который также добавляет aggregate inventory.

SDK fixture создаёт четыре роли normal create/invite/accept, независимые
Personal/ordinary lanes и две content revisions каждой через настоящий MCP.
Сохранённый commit после потери ответа сначала разрешается через
`reconcile_changeset` с оригинальным payload. Сквозной локальный тест теряет
ответ уже committed изменения, пересоздаёт SDK из private journal и проверяет
ровно три revisions на lane (initial + create + replace), без лишнего commit.
Два overlapping runs не мешают друг другу: cleanup первого сохраняет доступ
во втором. После обоих cleanup complete inventory равен baseline: principals,
owned Minds, R2 objects/bytes, search, OAuth, actor/session/journal rows — ноль.

Команда `scripts/check-acceptance-fixture-hosted.mjs <run-tag>` получает secrets
из закрытых настроенных references и требует `MD_ACCEPTANCE_EXPECTED_SHA`.
Она сохраняет журнал до mutations, поддерживает явную проверку потери ответа
`MD_ACCEPTANCE_INJECT_LOST_COMMIT=1`, проверяет роли/историю и выполняет bounded
cleanup с отрицательным MCP probe и final/baseline inventory. Повтор того же tag
использует прежний журнал; новый tag означает новый изолированный run.

### Полный hosted fixture завершён

Candidate/runner `5641cb739b8ab93c10a98ae4252039219e121e3b`, CI `33994274005`,
source mirror `081d33b0630809e1f8a87b71af7f6791ac7c702c`, Site version 5,
deployment `appgdep_examplee517106e18d6a642` succeeded (env 2).
Server SHA `2fadad3b1efaaeeae29a93c651e9bd39618a473588517b0448604fb57a124a28`,
archive hash `afe29f172302241470d6dbfd96017dd9ede402fd5963d2bed0184bfd7bca2a24`.
Run tag `md404-fixture-recovery-20260905` завершился `verified=true`, `cleaned`:
четыре роли, две lanes, три revisions каждой, реальная потеря ответа committed
изменения и восстановление через reconcile без дубликата. Cleanup выполнил
четыре bounded steps, удалил пять Minds, отозвал token; следующий MCP запрос
отклонён. Complete final inventory совпал с нулевым baseline по principals,
owned Minds, R2 objects/bytes, search, OAuth, actors/sessions/cleanup journal.
Закрытый журнал хранит receipt; секреты операций удалены после cleanup.

Дополнительное локальное failure injection после normal bootstrap выявило
особенность: повтор POST регистрации после успешного создания даёт 401,
поэтому generic retry недостаточен. SDK теперь сначала читает session и
сохраняет подтверждённый normal principal/Personal read-back как reconciled
результат. Сквозной тест последовательно теряет ответы bootstrap и MCP commit,
пересоздаёт SDK после каждого и подтверждает отсутствие дублей и полный cleanup.
Это изменение клиента не меняет опубликованный Worker.

### Следующий этап: браузер и модель (MD-405, в работе)

Отдельный headless Chromium в существующем CI получает четыре изолированных
contexts. Platform bypass добавляется только к точному test origin; callback
OAuth перехватывается внутри context и не отправляется в сеть. Bootstrap,
создание personal token и consent выполняются настоящими формами. Один DCR
client служит постоянной тестовой настройкой; grants/tokens принадлежат run и
удаляются вместе с actors. Его registration не считается пользовательским login.

Модель под испытанием запускается через установленный Codex App Server в свежем
ephemeral thread с точным установленным skill и ограниченным набором proxy tools.
Это предмет испытания, не дополнительный исполнитель Issue Grinder. Глобальные
настройки Codex не меняются. Встроенные внешние инструменты, hooks и discovery
других skills отключаются только в этом процессе. Бюджет, реальные traces и
завершённое событие contextCompaction обязательны; текстовая имитация сжатия
не принимается. Пока подтверждён только запуск App Server и model/list.

Проверка capability затем выполнила настоящий tool call и завершённый
`contextCompaction` на `codex-cli 0.153.0`, `gpt-6-astra`. Пробный live model
runner `d135d0436040efa44aada50d90ea1ea39553c9ff` прочитал общий Mind и не
обращался к Personal без description: пять реальных MCP вызовов, включая fetch.
Исходный oracle ошибочно ожидал поле `mind` у fetch, хотя протокол передаёт
opaque `id`; исходный run оставлен failed, cleanup восстановил baseline.
Исправленный oracle связывает fetch с exact предшествующим search/browse и
отклоняет неизвестный locator, запрещённый источник и незапрошенную запись.
Повторная оценка сохранённой трассы прошла; это ещё не полный model run.

Локальная product matrix проверяет все девять `null/empty/described` ×
`disabled/read/read_write`, metadata conflict и exact replay configuration,
credential scope narrowing, revision conflict, reconcile, history и полный OKF
validation. Те же assertions доступны hosted runner; их локальный успех не
является hosted evidence. MD-401–404 завершены; MD-405 в работе, MD-406–407
остаются открытыми.

### Проверенное чтение моделью и обнаруженный OAuth cleanup defect

Runner `7c2293d4bd17e0a37272c4f371e8e51e1d7229d5` на test candidate
`5641cb739b8ab93c10a98ae4252039219e121e3b` завершил четыре live model cases:
Personal без description не выбран автоматически; overlap читает оба; явный
Personal запрос читает только его; посторонняя тема не вызывает corpus reads.
Overlap действительно прошёл compaction и повторный `list_minds` перед обоими
reads. Model `gpt-6-astra`, CLI `0.153.0`, installed package hash
`90a63cb105f12ebc29044f8c5efa4424c146ff0a6f869a2310bbd38345d3fc55`, skill hash
`36e1ed4c850ea065ee512b9950f2dd5cfcd5b2c1ce0c0df8e0e4ada8a895db79`.
Private tag `md405-model-read-v2-20260905`: passed, four cases, baseline restored.
Расширенные write/injection/no-op cases этим receipt не покрываются.

CI browser `33996861901` прошёл token opt-in формы и оба MCP self-check profiles.
Остановка OAuth/cleanup не объявляется успехом. Inventory после cleanup показал
один normalized OAuth grant при нулевых accounts/Minds/objects. Локальный
normal OAuth code exchange воспроизвёл оставшиеся rows после удаления account.
MD-404 повторно открыт: прежний personal-token fixture этого не проверял.

Исправление следует принятому ADR-0010: после authoritative account cascade
отдельный OAuth port удаляет normalized grants, authorization codes/requests,
access/refresh rows. In-process composition проверяет отсутствие account;
контроллер не пишет product SQL. Bounded orphan recovery восстанавливает
остатки прежних test cuts и пропускает active accounts. Локальные проверки
подтвердили обычный OAuth lifecycle, два сбоя purge с повторным cleanup,
восстановление legacy orphan, идемпотентный recover и сохранение active grant.
Inventory v2 включает также authorization codes/requests. Живая проверка
исправления требует нового test deployment и пока не выполнена.

### Уточнение browser runner и закрытия одноразового токена

CI runner принимает OAuth callback настоящим listener на `127.0.0.1:1455`:
Playwright не маршрутизирует следующий запрос в HTTP redirect chain. Исходный
POST отправляется с platform header отдельно, с `maxRedirects: 0`; браузерный
переход на callback не получает этот header. Loopback handler отвергает
credential headers. Отдельный локальный browser probe подтвердил реальный
callback без переноса platform credential. Это не изменение OAuth authority.

Закрытие окна одноразового токена должно немедленно стирать secret и запускать
не более одной перезагрузки: click и dialog close могут произойти оба. Локальное
исполнение текущего browser asset воспроизвело две перезагрузки. Исправление
должно сохранить wipe при каждом close, но потреблять refresh flag однократно.

Test cut v6 (`39f89e28d9b09a6d22df7f60ca9c90def9e53540`, deployment
`appgdep_example099442449e0ce969`) прошёл локальный полный gate
(1150 tests + 68 browser checks) и CI `33997529179`. Live orphan recovery удалил
один оставшийся grant и один code; полный inventory v2 вернулся к нулю.
CI `33997824494` и `33998257100` также подтвердили cleanup до baseline после
неуспешной browser проверки. Это подтверждение OAuth cleanup, не полная MD-405.

### Контракт объединённого отчёта MD-406

Новый `mind-diary/acceptance-suite/v1` действует только для явного autonomous
scope. Исторические receipts и требования MD-399 не переписываются. Каждый
компонент связывает candidate, project, deployment, common-module и test-adapter
hashes с точным runner SHA. Model component дополнительно содержит проверенный
installed package hash, полный список cases и настоящий compaction trace.
Объединение требует product, browser, model, recovery, persistence и performance
components; missing/failed assertion или cleanup, duplicate component и любое
несовпадение identity отклоняются. Hash отчёта обеспечивает целостность, но сам
по себе не подтверждает происхождение: ожидаемые hashes исходных receipts
должны поступать из закрытого журнала управляющего запуска, а не из проверяемого
отчёта. Performance использует существующий строгий gate и provider capture;
локальные или придуманные measurements не подходят.

Проверка model partial-write делает первый обычный commit, затем меняет режим
второго Mind штатным control API на `read` перед второй попыткой. Oracle требует
настоящий отказ второго commit, сохранённый и проверенный первый результат,
а также сообщение о частичном отказе. Потерянный ответ проверяется отдельно
через выполненный сервером commit и exact `reconcile_changeset`.

MD-404 повторно завершена после CI browser `33998378523`: настоящий OAuth
code exchange, code replay denial, refresh/revoke и полный cleanup прошли.
MD-405 и MD-406 в работе, MD-407 пока Todo. Исправление повторного reload
токен-диалога `7417ece5e29dee78f3a4ee8cdfa2f6ddae004987` прошло полный локальный
gate; этот новый UI asset ещё не опубликован в test target.

Performance fixture создаёт два обычных accounts; у каждого Personal и
ordinary Mind, история обоих Minds равна соответственно 1 или 10 revisions.
Число файлов и bytes берётся из реальных manifest summaries, fixture bindings
и opaque fetch locator — из обычного MCP. Provisioning correlation использует
сохранённый idempotency key настоящего create/token request, read-back —
server request ID. `cookie_env` — optional backward-compatible transport
extension scenario v3 только для web; inline Cookie и cookie на MCP запрещены.

Для Sites logs новый capture v2 фиксирует digest фактического tool response,
provider event IDs и единственную provider script version. API не возвращает
control-plane request ID, поэтому runner его не придумывает. Отбираются только
метрики с подтверждённым сервером подписанным benchmark correlation. V1 receipts
сохраняют прежнюю проверку. Без внешнего capture замер не может стать passed.

Команды для управляющего агента (файлы только в private evidence directory):

```text
node scripts/check-acceptance-performance-hosted.mjs <tag> sample <identity.json>
node scripts/check-acceptance-performance-hosted.mjs <tag> finalize <sites-log-response.json>
node scripts/check-acceptance-performance-hosted.mjs <tag> cleanup
node scripts/join-acceptance-suite.mjs <manifest.json> <report.json> <six-component-files...>
```

Между `sample` и `finalize` агент получает настоящие Sites worker logs через
connector и сохраняет его result; длинный замер требует bounded captures во
время исполнения, чтобы не потерять начало выборки. `sample` сохраняет каждый
измеренный request до перехода к следующему; после записи выборки run остаётся
активен до join/cleanup. При падении доступен тот же закрытый recovery journal.
Это пока реализованные команды и локальные проверки, не live performance pass.

### Устойчивость после расширенного model run

Unknown-response case реально выполнил Personal commit, затем независимый
ordinary commit, затем exact Personal reconcile. Прежний oracle ошибочно
считал любой intervening commit слепым retry. Запрет уточнён: до reconcile
нельзя повторять mutation того же Mind; независимый второй канал разрешён.
Сохранённый trace не подменяет новый полный run.

Большой cleanup пережил клиентский timeout, а server lock ещё действовал.
SDK повторяет только 503 и transport timeout по тому же run, максимум 16
обращений/пять минут с backoff до 15 секунд. Неизвестные ошибки и 401 не
повторяются; журнал остаётся пригодным для восстановления. Tests могут явно
отключить retry для моделирования прерывания процесса.

Проверка provider logs показала, что нестандартный controller header не
редактируется платформой. Controller capability переводится на стандартный
`Authorization: Bearer` только на test control endpoints; прежний header
больше не принимается. Ключ ротируется в Sites и CI, затем проверяется отказ
старого значения. Значения секретов в evidence не сохраняются. При анализе
provider logs управляющий агент извлекает только безопасные поля и не выводит
целый request headers object.

### Проверка test v7 и общий контракт, 2026-09-06

Candidate `8daaaa137d1e824f494e874860fda22f5fe1a66b` опубликован как test v7,
deployment `appgdep_example1a4a5e9cb106bdb2`, environment revision 3.
CI `33999662215`, полный локальный gate и dev restart smoke прошли. Новый
controller credential принят; старый получил HTTP 401. После возобновления
прерванной очистки расширенного model run независимая inventory вернулась к нулю.

Hosted run `md405-product-matrix-v7-20260905` прошёл все 9 сочетаний
null/empty/described и disabled/read/read_write, credential narrowing,
metadata/revision CAS, history/OKF, editor/reader/outsider ACL и lost-commit
reconciliation. Четыре actors удалены, полная inventory v2 после очистки
совпала с пустой baseline. Это product evidence, не полный MD-400 pass.

Перспективная применимость платформенных canaries вынесена в profile revision 8.
Исторические MD-394/MD-399 не могут быть закрыты новым join. Пока остаются
полный объединённый model run, реальные performance measurements, persistence
и recovery components и два полных повторяемых запуска MD-407.


Model run `md405-model-partial-v7-20260906` на test v7 и чистом runner
`bb63b31f3bd9ba2878dcefedfdcc3254e3a158b0` прошёл `overlap-partial-write`:
23 tool calls, 232344 tokens из лимита 400000; первый commit проверен,
вторая запись отклонена после реального изменения режима, частичный отказ
сообщён. Cleanup подтвердил baseline restored. Это отдельный case, не полный
14-case receipt. Запущен отдельный настоящий performance run; результат пока
не объявлен.


### Проверка обычной UAT и первого performance run

Обычная UAT обновлена до version 125: candidate
`8daaaa137d1e824f494e874860fda22f5fe1a66b`, source
`2f9464217383841ac0a99ad5e044d99dc7ec787e`, deployment
`appgdep_example13d378d195b6573c` (succeeded, environment revision 4).
Audience public сохранена. Artifact проверен для exact candidate; отдельный
Sites build прошёл. Во встроенном браузере выполнен настоящий вход через
правильный ChatGPT account, открылись Home и Account. Bypass без пользовательской
сессии возвращает product 401; это ожидаемое разделение platform bypass и identity.
Прямой browser navigation к JSON session API заблокирован browser client;
его результат не назван product failure. Полный first-user canary ещё не завершён.

`md406-performance-v7-20260906` собрал все 273 настоящих samples (13 × 21),
00:40:47.953–00:52:04.235 UTC. Report failed: начало provider capture потеряло
37 correlation IDs из-за позднего старта и лимита 100 событий; дополнительно
строгое сравнение UTC выявило смещение серверных часов относительно Mac
(например +39 ms после клиентского receive при совпадающих request/correlation).
Это не performance pass и не основание объявлять regression продукта.
Cleanup восстановил baseline полностью. Новый coordinator требует запустить
capture до samples; report v4 отдельно проверяет измеренные границы clock
offset, сохраняя durations, бюджеты, coverage и старый report v3 без изменения.


Первый hosted recovery run прошёл lost setup/bootstrap/commit, overlapping run
и настоящий TTL expiry, но ошибочно остановился на промежуточном HTTP 503
reaper: cleanup по контракту обрабатывает один actor за вызов. Оба runs
полностью очищены, исходный report остаётся failed. SDK теперь ограниченно
продолжает sweep и читает фактические состояния заданных runs; интеграционный
тест подтвердил несколько chunks и сохранение соседнего active run.

### Проверка восстановления и первый общий прогон

На runner `d22e3afab7e65dfbfc9f0263ce1e022a97108702` hosted recovery
`md405-recovery-v7b-20260906` прошёл lost setup/bootstrap/commit/cleanup,
настоящий TTL, сохранение соседнего active run, revoke и ограниченную
HTTP 503-инъекцию. Полная inventory восстановлена; component
`855d17f6e7d8ff7ca44965a16c6fe9cd694aafa9f9007588fbbdb8035552b180`.

На обычной UAT нативный Codex AppServer успешно выполнил read-only OAuth,
обновил refresh credential и получил отказ после отзыва. Opt-in token forms
добавляли `personal:configure` только при выбранной галочке; оба токена прошли
modern/compat self-check. Оба временных токена и новый OAuth grant отозваны,
локальная credential удалена; 12 прежних подключений сохранены. Личный corpus
не читался и не изменялся. Это применимые перспективные platform canaries,
а не полный исторический Marketplace gate MD-399.

Первый общий запуск `md407-full-a-20260906` подтвердил точные revisions и
content после повторной публикации той же saved version: deployment
`appgdep_example22dbae9c31df6579`, persistence component
`b9f609524e02f1ae96539e66db6f9a55f4219b0b0afb36524c6917ed86d81ca9`.
Затем прошли product 9-cell matrix, ACL, history/OKF и очистка.

Browser CI `34004941809` завершился failed на bootstrap: runner ждал `/`,
хотя продукт после регистрации открывает `/me`. Отдельно созданный response
waiter мог отклониться раньше ожидающего click и аварийно завершить процесс
до `finally`. Ожидания ответа, перехода и клика объединяются в `Promise.all`,
ожидаемый URL приведён к действующему контракту. Неудачный запуск не считается
чистым полным проходом; его CI fixture очищен по точному run ID, полная
inventory снова нулевая.

### Повтор браузера и полная model matrix

Browser CI `34005427820` на runner
`1db24c6b4f4bdd60482c52ee2b7d93e215531010` прошёл все формы, четыре contexts,
modern/compat self-check, OAuth PKCE/code replay/refresh/revoke и очистку.
После перехода по ссылке runner также ждёт `DOMContentLoaded`, чтобы не
взаимодействовать с формой раньше загрузки её module script. Общий CI
`34005418077` прошёл.

Новый проход `md407-full-a2-20260906` выполнил persistence после deployment
`appgdep_examplef09bb8a8798934b6`, затем product matrix и browser CI
`34006423795`. Все три компонента прошли и очистились. Model matrix прошла
12 сценариев, включая настоящий compaction, инъекцию в description,
Personal-to-shared negative, независимую автоматическую запись и no-op.

Сценарий unknown commit был отклонён oracle с `unexpected_read_source`:
модель использовала обычный `handle` из `list_minds`, который сервер принимает,
но oracle сопоставлял только route и Mind ID. Каталог теперь также связывает
свой непустой handle с canonical route. Неизвестный handle, чужой Personal ID
и непрослеживаемый locator по-прежнему отклоняются; шесть unit tests прошли.
Сохранённый trace успешно переоценён, однако первоначальный model run остаётся
failed с 12 cases и подтверждённой полной очисткой. Он не считается полным
чистым проходом; итоговая приёмка требует нового запуска на исправленном runner.
