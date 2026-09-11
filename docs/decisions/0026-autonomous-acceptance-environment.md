# ADR-0026: отдельная среда автономной приёмки

Статус: accepted implementation direction, 2026-09-05, MD-401 / Epic MD-400.
Пользователь поручил реализацию автономной приёмки и прямо разрешил настройку
тестовой среды и bypass tokens. Это принятие архитектуры, не утверждение о
готовности всего Epic. Текущие результаты и остаток — в
[плане исполнения](../tasks/autonomous-uat-acceptance.md).

## Причина

### Дополнение для ChatGPT acceptance, 2026-09-11

Пользователь прямо разрешил временный защищённый внешний MCP-вход только к
синтетическим disposable данным MD-442 с последующим отключением и очисткой.
Это исключение для отдельного acceptance Site, не изменение обычного UAT или
Production. До открытия транспорта проверяются отсутствие анонимного content
доступа и закрытость controller; исходная Sites audience восстанавливается после
проверки, в том числе при ошибке.

Обычный bearer/OAuth authentication, scopes, ACL и HEAD CAS не меняются.
Для клиента без `x-md-acceptance-run` controller может выдать отдельную durable
lease только зарегистрированному первому actor конкретного active collaboration
run. Lease выключена по умолчанию, действует не более 15 минут и срока run,
не продлевается повторным запросом и не разрешает других actors. Явно переданный
неверный run header не получает fallback. Истечение, отзыв run/actor или начало
cleanup немедленно закрывают admission; controller может отозвать lease раньше.
Cleanup удаляет её, inventory учитывает остаток. Product bundle не импортирует
этот механизм. Секреты не передаются в URL и публичные receipts.

Реальный ChatGPT проходит штатный OAuth consent с synthetic browser session,
полученной существующим одноразовым exchange. Это проверка настоящего host с
тестовой identity, не evidence настоящей Sites identity.

Три реальные Sites identity исторически проверены в MD-282, но их ручные
сессии не дают воспроизводимый способ создать произвольное число тестовых
пользователей. Локальные synthetic tests проверяют значительную часть продукта,
но не hosted persistence и браузерную приёмку. Действующий Product Worker не
должен получать скрытый переключатель личности.

## Решение и границы сборок

Создаём отдельный закрытый Sites target с собственными D1/R2 и секретами.
`apps/mind-diary-acceptance` имеет свой manifest и отдельный build entrypoint;
обычный `apps/mind-diary-site` не импортирует issuer, его routes или identity
resolver. Нет `NODE_ENV`, header или deployment flag, включающего test login
в обычной сборке. Shared domain/application/UI/protocol/storage modules
остаются общими. Test adapter и общие модули имеют отдельные digests в evidence;
тождество двух разных Worker artifacts не заявляется.

Это расширяет ADR-0012 только отдельной hosted test composition. Запрет test
login в обычном Product Worker, отсутствие synthetic domain entity и обычные
bootstrap/ACL/scopes/CAS/history сохраняются. Изолированная среда никогда не
связывается с существующими пользовательскими identities и хранилищами.

## Два независимых уровня входа

Sites bypass bearer проходит только платформенный Sign in with ChatGPT gate.
Он не означает product principal и не выдаёт роли. Контроллер хранит его вне
репозитория; CI получает отдельную секретную ссылку. Повторная генерация
ротирует этот token, поэтому её выполняют при provisioning/recovery, а не при
каждом тесте. Текущий tool contract не обещает TTL: проверка доступности и
явная ошибка обязательны. Разрешение пользователя охватывает дальнейшую
необходимую ротацию токенов этого тестового target.

Внутри отдельного Worker действует собственная controller capability с
независимым случайным секретом. Она управляет только запусками и выдачей test
sessions, не является content MCP token и не подменяет product commands.
Bearer не передаётся на другой origin, в query, Git, логи или reports.

## Контракт запуска и личности

- Сервер создаёт случайные run/actor IDs и уникальные synthetic subjects.
  В запросах создания нет email, principal ID, role или готовых scopes.
  Тестовый verified email формируется сервером в `.invalid` namespace; это
  служебный вход normal bootstrap, не адрес внешнего аккаунта.
- Начальные пределы: два одновременных runs, 4–8 actors на run, lease до часа,
  web session до 15 минут, одноразовый обмен до 60 секунд. Session expiry не
  может выходить за run expiry. Превышение квоты даёт явный отказ.
- Одноразовый код обменивается только на exact test origin, атомарно помечается
  использованным и выдаёт host-only Secure HttpOnly SameSite=Lax cookie.
  Для изменяющих запросов сохраняются Origin/CSRF checks. В базе хранятся
  verifiers, не session secrets. Wrong audience, replay, expiry и revocation
  проверяются до identity resolution; restart не оживляет код или сессию.
- Trusted identity reader выбирает только actor, связанного с проверенной
  сессией активного run. Его constructor-only binding namespace отличается
  от `openai-sites`. При bootstrap создаются обычный principal, Personal Mind
  и owner membership. Роли обычных Minds получаются normal invite/accept/transfer.
- Привязка actor к product principal устанавливается только по trusted
  результату normal bootstrap/session read-back; caller не задаёт её.
  Чтение этой test metadata не разрешает direct seed product identities/ACL.
- MCP/OAuth credentials выдаются normal control/consent operations. Run expiry
  и revoke запрещают также MCP, даже если credential ещё не истёк. При
  необходимости добавляется generic constructor-owned principal admission
  dependency после обычной проверки bearer, способная только отказать.
  Она не принимает caller principal и не заменяет подпись/verifier/scopes/ACL.
  Обычный Product Worker не задаёт test admission adapter. Cleanup отдельно
  отзывает credentials и проверяет отказ следующего запроса.

## Данные и восстановление

Wire contract тестового control plane: `POST /_acceptance/runs` принимает
только `actor_count` (4–8), `ttl_seconds` (60–3600) и preset `profile`
(`collaboration | operator`) с обязательным idempotency key. Сервер выбирает
случайные IDs/subjects. Повтор того же ключа с другим payload — conflict.
Operator preset назначает только первый созданный actor кандидатом на
constructor-owned operator allowlist после normal bootstrap. Он требует
эксклюзивного run: пока существует любой другой неочищенный run, такой preset
не создаётся; пока существует operator run, другие runs не создаются. Это
сохраняет настоящую глобальную directory semantics без раскрытия другого run.

`POST /_acceptance/runs/{run_id}/exchanges` получает exact actor ID из этого run
и выдаёт одноразовый код. `POST /_acceptance/session` обменивает этот код при
same-origin Origin; новый session token отзывает прежние web sessions actor.
`DELETE /_acceptance/runs/{run_id}` отзывает run, но не объявляет cleanup
product data. Чтение run и его ограниченного списка actors доступно только
controller capability. Внешний запрос не устанавливает principal binding.
MCP test carrier дополнительно передаёт `X-MD-Acceptance-Run`; проверенный
обычным authenticator principal должен принадлежать указанному активному run.
Это тестовая транспортная привязка, не изменение ordinary MCP contract.

Контроллер пишет закрытый recovery journal до первого изменения. Сервер хранит
bounded run/actor/session/exchange metadata отдельно от product tables. Журнал
позволяет повторить exact unknown operation, перечислить свои токены по
run-owned marker и удалить только свои Minds/accounts обычными API. Для
истёкшего run допускается отдельная ограниченная recovery authority; она не
возвращает обычный доступ к corpus и не затрагивает другой run.

Истечение, прерывание и ошибка не равны cleanup success. Финальный receipt
требует read-back отсутствия owned data и отрицательные credential probes.
Reaper работает только в отдельной среде, с лимитом ресурсов и журналом;
ошибка остаётся видимой. Failure injection проверяет interruption между
операциями, unknown response, overlap, expiry, revoke и повторный cleanup.

## Браузер и источники доказательств

Встроенный браузер Codex проверяет обычное открытие/вход. Его raw CDP не
поддерживает `Target.createBrowserContext`; это capability limitation, не
запрет доступа к тестовому Site. Независимые браузерные сессии исполняются
отдельным Playwright runner в существующем GitHub CI, в новых headless
contexts без подключения к профилю пользователя. Начальный workflow имеет
ручной запуск агентом, только main, read-only GitHub permissions, тайм-аут
пять минут и последовательные прогоны. Секрет передаётся environment reference;
исходящие browser requests ограничены test origin. Для OAuth callback позже
добавляется exact контролируемый маршрут без передачи platform bearer.

Недоступный browser runner остаётся failure. Запрет политики браузера нельзя
обходить сменой инструмента. HTTP, screenshot, static skill checks и local
timings не заменяют реальные UI/model/hosted-performance assertions.

| Surface | Автономное доказательство | Отдельная проверка |
|---|---|---|
| Domain, ACL, scopes, CAS, history | Обычные модули, synthetic identity только на входе | Реальная Sites identity |
| D1/R2 и redeploy | Exact test artifact/deployment и persistence read-back | Обычный UAT deployment |
| Web/control | Изолированные CI browser contexts, реальные формы | Вход через Sites и доступность Codex Browser |
| MCP/OAuth | Обычные bearer/PKCE/rotation/revoke handlers | Реальная установка внешнего клиента |
| Agent routing/compaction | Реальный model-under-test, fresh package, tool traces | Текст skill не доказывает поведение |

Применимость real-Sites canaries для будущих изменений принадлежит MD-406.
До отдельного versioned mapping сохраняются текущие обязательные gates.
MD-394/399 и исторические receipts автоматически не закрываются. Production,
реальный Personal corpus, внешний account provisioning, AWS и платные seats
не входят в решение.

## Уточнение recovery contract (MD-404)

Приёмка OAuth выявила оставшиеся normalized grants после удаления account.
По принятому ADR-0010 они удаляются после authoritative cascade, а не только
помечаются revoked. Общий OAuth adapter предоставляет узкую in-process операцию
удаления records exact principal; composition вызывает её лишь после проверки
отсутствия active account. Тестовый cleanup не отмечает actor завершённым, пока
этот шаг не выполнен. DCR client остаётся отдельной постоянной настройкой.

Для исторических остатков старого test deployment controller `recover` также
проверяет ограниченную выборку principal IDs из OAuth tables. Он использует
тот же защищённый composition port и пропускает active accounts. Это доступно
только внутри isolated target, в котором все product identities создаются
test-session adapter-ом; ordinary Worker не получает такого HTTP endpoint.
Нет клиентского principal selector или прямого удаления product rows контроллером.
Inventory отдельно считает grants, access/refresh tokens, authorization requests
и codes, чтобы неполная очистка не скрывалась за пустым списком accounts.

Cleanup сначала переводит run в `cleaning`, прекращая обычный web/MCP доступ.
Контроллер не получает recovery cookie: сервер создаёт in-process requests
только для session/account preview/delete на identity принадлежащего run actor.
Эта identity хранится в памяти по самому объекту Request, не в клиентском
header, и не используется для content operations. Exact deletion payload и
idempotency key сохраняются до DELETE. После потери ответа перечитывается
состояние аккаунта; успешное исчезновение identity само по себе не доказывает
завершение очистки объектов.

Для уже committed account deletion общий runtime предоставляет узкий
constructor-owned recovery port. Он принимает exact principal/impact/key,
проверяет существующий pending cleanup record и повторяет штатный
AccountDeletionService; не создаёт новый deletion intent и не публикуется
через обычные HTTP/MCP routes. Test controller выбирает эти аргументы только
из собственного сохранённого журнала. Отсутствие pending work подтверждается
отдельным read-back; OAuth cleanup также завершается. Это позволяет восстановить
сбой после удаления identity без её повторного создания и без прямых product
DB mutations. Cleanup retries ограничены run lease и server-side lock;
истёкший lock допускает возобновление, активный run reaper не трогает.

Hosted-проверка первой реализации показала, что очистка четырёх accounts может
пережить клиентский timeout, оставив честный persisted progress. Поэтому один
cleanup request обрабатывает максимум одного ещё неочищенного actor и
возвращает `state=cleaning` с количеством оставшихся. Клиент продолжает тот же
run; `cleaned` выдаётся только после полного read-back и записи receipt.
`POST /_acceptance/recover` применяет тот же bounded step к максимум двум
просроченным или отозванным runs. Активные runs он не отзывает.

Controller-only `GET /_acceptance/inventory` возвращает bounded aggregate
baseline/final counts: текущие principals/owned Minds из штатного metadata
projection, число R2 objects и bytes, search/OAuth/session/cleanup rows.
Email, IDs, keys и corpus не возвращаются. Результат помечается неполным, если
предел страницы исчерпан; неполный snapshot не доказывает отсутствие остатков.
Это read-only диагностическая поверхность отдельной test composition.
