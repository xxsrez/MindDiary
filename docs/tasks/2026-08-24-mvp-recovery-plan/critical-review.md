# Критический архитектурный прогон

Статус документа: датированный review; `normative_status: not_applicable`.

Дата: 2026-08-24.

Проверенный Git artifact: `807c30884c63d8e88669fb9186742acadffcb95a`.

Цель review — найти места, где recovery-plan невозможно честно реализовать,
проверить или принять в заявленном виде. Review не утверждает, что найденные
решения уже приняты, кроме явно отмеченных `Resolved` и выполненных planning
mutations.

## Итог

План задаёт правильное направление, но пока не является полностью исполнимым
release contract. До начала UI-реализации нужно закрыть три архитектурных
решения и один test-enablement blocker:

1. выбрать один Git baseline между `main` и integration candidate;
2. согласовать scope reset с уже accepted storage/import contract;
3. определить state machine OAuth write step-up и writable selection;
4. реализовать созданную MD-300 с настоящим browser acceptance layer.

Без этого можно реализовать новые страницы и снова застрять на приёмке.

## P0 findings

### CR-1. `main` не содержит свежий integration candidate

Факт:

- `main` после planning push: `807c308`;
- integration candidate: `1df46ec`;
- общий ancestor: `eca3400`;
- `main...1df46ec`: один planning commit слева и 21 engineering commit справа.

Среди отсутствующих в `main` commits находятся recovery, performance gate,
capacity profile, hosted upload intents, generated/connector ingress hardening,
operator lifecycle и Task Manager migration commits.

Риск: новый UI может быть реализован на `main`, а final release — собран из
другой branch с иным runtime/profile contract. Exact candidate и evidence
перестанут быть однозначными.

Требуемое решение до реализации:

- выбрать `main` как единственный integration baseline и перенести на него
  неповторяющиеся commits из `1df46ec`; либо
- объявить новый integration branch от `807c308` и формально заменить старый
  candidate.

Нельзя просто merge-ить обе линии целиком: `186878c`, `4de0a4a` и `457bc45`
семантически пересекаются с planning commit `807c308`. Нужен bounded commit
inventory и конфликт-aware integration.

Success signal: один exact branch tip содержит утверждённый planning package и
каждый required engineering commit ровно один раз; full gate проходит на этом
tip.

### CR-2. Scope reset конфликтует с accepted Release 0.1 contract

`docs/specs/sites-storage-capacity-import.md` имеет `normative_status:
accepted` и прямо называет Brain-scale storage/import частью Release 0.1.
Recovery proposal относит тот же graph к post-MVP.

Это не обычная очистка Task Manager. Вариант scope reset требует:

- superseding decision или amendment ADR-0016;
- обновления MVP/roadmap/traceability/profile;
- новой classification уже реализованного local behavior;
- явного решения, остаётся ли Markdown import в 0.1 отдельно от universal
  file-source expansion.

Пока MD-292 не завершён таким решением, массовое снятие Release blocker было бы
нормативно противоречивым.

### CR-3. Resolved: performance P0 ограничен небольшим dataset

Пользователь явно решил, что Release 0.1 не требует large-corpus/Brain-scale
minimum. MD-258 и accepted release profile обновлены: blocking gate использует
небольшой детерминированный `starter/small` fixture и достаточное число повторов
для latency. Большие capacity/performance scenarios остаются будущей
non-blocking проверкой и не влияют на terminal status MD-258.

Таким образом final gate больше не зависит от готовности MD-245 или полной
scale matrix. Число warm samples сохраняется, потому что оно отвечает за
статистическую устойчивость latency, а не за объём test data.

### CR-4. Обещанный writable selection не работает после read-only OAuth

Accepted OAuth flow выдаёт сначала `content:read`; `content:write` появляется
через native step-up при `set_write_mind_binding` либо commit.

Текущий Product Site:

- отключает writable select без `content:write`;
- при direct binding mutation возвращает `insufficient_scope`;
- не умеет инициировать grant-specific native OAuth step-up из web UI.

Поэтому формулировка «Install → Authenticate → Choose readable и writable
Minds» неоднозначна. Нужно принять один state machine:

1. основной путь выбирает только readable Minds; первый write в Codex запускает
   step-up и затем выбирает writable Mind;
2. initial OAuth сразу запрашивает read+write как явно принятый pilot
   compromise;
3. Product Site получает отдельный поддержанный step-up handoff, если platform
   действительно позволяет надёжно вернуться к exact connection.

До решения MD-294/MD-296 нельзя честно проектировать connection details и их
acceptance copy.

### CR-5. Existing synthetic browser gate не проверяет браузер

`npm run gate:synthetic-browser` создаёт server-bound HTTP contexts, читает
HTML строками и проверяет fragments через `includes`/regex. Он хорошо доказывает
identity, ACL, API/UI projection и cleanup, но не исполняет DOM как браузер.

Repository содержит browser fixture servers, однако:

- `npm run check` их не запускает;
- browser runner отсутствует в dependencies;
- нет автоматической проверки viewport, overflow, focus order, accessible
  names, dialogs и screen-reader semantics.

Следовательно MD-299 сейчас не может получить заявленное
accessibility/mobile/browser evidence.

Для этого создан отдельный independently deliverable outcome MD-300:

- реальный browser runner для deterministic fixtures;
- desktop и mobile viewport;
- keyboard-only journey;
- semantic heading/label/dialog checks;
- credential datasets 0 / 1 / 37+;
- exact hosted observation отдельно от deterministic local gate.

MD-300 напрямую блокирует MD-299. Пока runner не реализован, MD-299 не может
называть layout/accessibility автоматически доказанными.

### CR-6. MD-293 противоречит informational external canary contract

MD-293 обещает final first-user UAT с fresh Marketplace install и OAuth.
Accepted plugin/profile contract считает real external Marketplace/Codex UI
canary informational: его failure не блокирует Release 0.1 и запрещает только
claim о проверенном external-host UX.

Нужно выбрать одно:

- оставить external canary informational и переименовать terminal outcome в
  automated compatibility/security UAT, явно оставив first-user UX unverified;
- либо сделать real-account canary blocking для нового UX и гарантировать
  accounts, browser surface, Marketplace version и bounded cleanup.

Смешанный вариант приведёт к Done Task с более сильным названием, чем evidence.

## P1 findings

### CR-7. Dynamic connection route пока не существует как security contract

Product router знает только статический `/settings/mcp`. Recognized signed-out
routes перечислены exact set; `/settings/connections/{connection_ref}` сейчас
не является UI route.

Нужно определить:

- typed OAuth/personal-token connection reference;
- actor-owned exact lookup и одинаковый 404 для unknown/foreign;
- допустимость raw grant/token ID в URL либо отдельный opaque presentation ref;
- signed-out shell и reserved-route behavior;
- CSRF и optimistic-concurrency contract одной detail page.

Без этого route implementation легко создаст existence oracle или попадёт в
общий handle routing.

### CR-8. Client-side collapse не решит перегрузку и latency

Текущий handler сначала загружает все personal tokens, все active OAuth grants,
все доступные Minds и binding state каждого credential. Затем renderer строит
все cards.

Если MD-297 только скроет DOM через CSS/JavaScript:

- database/application reads останутся unbounded;
- HTML останется большим;
- binding N+1 сохранится;
- hidden inactive data продолжит попадать в page response.

Нужен server-side query contract:

- active connections с bounded page size;
- inactive personal-token history отдельным cursor;
- binding state только для показанной page или одной detail route;
- стабильная сортировка и cursor без principal/content leakage.

OAuth adapter сейчас возвращает только active grants; personal-token list —
источник основной revoked history. Эти две коллекции нельзя притворно свести к
одинаковой lifecycle model.

### CR-9. Cleanup credentials не имеет принятой retention policy

Inactive binding tombstones нужны, чтобы stale clients гарантированно fail
closed. `mind-bindings.md` оставляет срок их хранения открытым вопросом.

Поэтому MD-297 может безопасно реализовать hide/filter/pagination, но physical
cleanup нельзя принимать по одному naming heuristic. Для удаления нужны
отдельные retention, audit, owner и recovery rules. До этого test hygiene —
revoke + hide, а не hard delete.

### CR-10. Automatic capture снова усложняет ordinary surface

Binding contract прямо говорит, что binding не включает automatic capture.
Recovery target всё же оставляет capture controls на connection detail page.

Для минимального MVP лучше вынести capture в отдельный advanced section одной
connection или отложить его UI. Иначе новая «простая» страница снова объединит
access selection с отдельной content-ingestion policy и её privacy warnings.

### CR-11. Resolved: MD-299 напрямую блокирует final gate

Task Manager не доказал invariant «Epic нельзя закрыть, пока все children не
Done». Поэтому relation `MD-299 blocks MD-293` добавлена напрямую. Epic relation
остаётся для product grouping, а terminal UAT dependency теперь читается
машинно без предположения о lifecycle children.

### CR-12. Connections page отсутствует в performance evidence

Web performance recorder сейчас выделяет только home/stages. Новый главный
settings route может остаться медленным, даже если MCP budgets проходят.

Acceptance должен измерять:

- active connections page server time и rendered size;
- one connection detail page;
- inactive history page;
- cold/warm и dataset 1/37/100 credentials;
- верхнюю границу DB/binding reads.

## Рекомендуемый порядок разрешения

1. MD-292: принять нормативный scope; small-data performance boundary уже
   зафиксирована в MD-258 и release profile.
2. Выполнить commit inventory `main` против `1df46ec`, создать один exact
   integration baseline.
3. MD-294: принять route/reference/pagination/write-step-up/capture contract.
4. Реализовать MD-300 real-browser test enablement до MD-299.
5. Реализовать server-side bounded list/detail projections до renderer split.
6. Только после этого выполнять visual/copy разделение страниц.
7. Принять blocking либо informational статус external canary; прямая relation
   MD-299 → MD-293 уже добавлена.

## Что уже доказано

На `807c308` выполнены:

- `npm ci`;
- один полный `npm run check`: 689 tests, 689 passed;
- architecture, Product Site, fixtures, docs и secret/config checks;
- project-docs validator: 65 documents, 296 local links;
- `git diff --check origin/main^..origin/main` до push;
- remote read-back exact `807c308` на `refs/heads/main`.

Это доказывает repository integrity planning commit. Оно не доказывает UAT
deployment, новый UI или включение 21 commits из `1df46ec`.
