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
