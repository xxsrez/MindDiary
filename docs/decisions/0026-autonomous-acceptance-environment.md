# ADR-0026: отдельная среда автономной приёмки

Статус: accepted implementation direction, 2026-09-05, MD-401 / Epic MD-400.
Пользователь поручил реализацию автономной приёмки и прямо разрешил настройку
тестовой среды и bypass tokens. Это принятие архитектуры, не утверждение о
готовности всего Epic. Текущие результаты и остаток — в
[плане исполнения](../tasks/autonomous-uat-acceptance.md).

## Причина

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
