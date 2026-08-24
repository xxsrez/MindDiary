# Критический архитектурный прогон

Статус документа: датированный review; `normative_status: not_applicable`.

Дата: 2026-08-24.

Исходный review artifact: `807c30884c63d8e88669fb9186742acadffcb95a`.
Предыдущий проверенный planning artifact:
`f96b3b70dbfafc4ddbc5324a6a4fbc95eff5ffe7`. Текущий second-review artifact
фиксируется commit/read-back после завершения этой правки.

Цель review — найти места, где recovery-plan невозможно честно реализовать,
проверить или принять в заявленном виде. Review не утверждает, что найденные
решения уже приняты, кроме явно отмеченных `Resolved` и выполненных planning
mutations. Текущая исполнимая disposition всех findings принадлежит
[реестру блокеров](blocker-register.md); нижние sections сохраняют причинный
диагноз до исправления плана.

## Итог

После исправления плана открытые вопросы больше не оставлены без владельца:

- MD-292 владеет definitive small-data boundary и accepted-doc amendment;
- MD-301 владеет объединением Git baseline;
- MD-294 фиксирует route identity, read-first/write-step-up и pagination;
- MD-300 в Todo владеет настоящим browser acceptance layer;
- MD-299/MD-293 требуют blocking fresh real-account canary.

Подтверждённых активных внешних blockers нет. UI implementation начинается
только после MD-292/MD-301/MD-294 gates.

## Disposition после исправления плана

| Finding | Текущая disposition |
|---|---|
| CR-1 | Internal gate MD-301; blocks implementation и final UAT |
| CR-2 | Internal gate MD-292; definitive small-data boundary, не новая развилка |
| CR-3 | Resolved: large-corpus performance minimum удалён |
| CR-4 | Internal + live gate: protocol определён, но fresh-host incremental consent ещё не доказан; MD-294/MD-296/MD-299 |
| CR-5 | Internal gate MD-300 в Todo, blocks MD-299 |
| CR-6 | Resolved in acceptance: fresh real-account canary blocking для first-user claim |
| CR-7 | Включён в MD-294/MD-295: opaque actor-owned ref и identical 404 |
| CR-8 | Включён в MD-294/MD-297: bounded server-side projections/cursors |
| CR-9 | Avoided: revoke + hide, physical deletion вне MVP |
| CR-10 | Avoided: automatic capture вне ordinary Connections/onboarding |
| CR-11 | Resolved: MD-299 напрямую blocks MD-293 |
| CR-12 | Включён в MD-299 на fixture `0 / 1 / page_size + 1` |

## P0 findings

### CR-1. `main` не содержит fresh integration candidate

Факт:

- `main` содержит planning/docs commits, точное число которых меняется при
  каждом обновлении review package;
- integration candidate: `1df46ec`;
- общий ancestor: `eca3400`;
- справа от divergence остаётся 21 engineering commit; левое число нельзя
  фиксировать как вечный факт и нужно читать fresh:
  `git rev-list --left-right --count main...1df46ec`.

Среди отсутствующих в `main` commits находятся recovery, performance gate,
capacity profile, hosted upload intents, generated/connector ingress hardening,
operator lifecycle и Task Manager migration commits.

Риск: новый UI может быть реализован на `main`, а final release — собран из
другой branch с иным runtime/profile contract. Exact candidate и evidence
перестанут быть однозначными.

Требуемое действие до реализации принадлежит MD-301: сделать `main`
единственным integration baseline и conflict-aware перенести либо явно
disposition-ить каждый из 21 commits `1df46ec`.

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

### CR-4. Частично разрешено: state machine определён, host step-up не доказан

Accepted OAuth flow выдаёт сначала `content:read`; `content:write` появляется
через native step-up при `set_write_mind_binding` либо commit.

Текущий Product Site:

- отключает writable select без `content:write`;
- при direct binding mutation возвращает `insufficient_scope`;
- не умеет инициировать grant-specific native OAuth step-up из web UI.

План выбирает первый state machine: initial OAuth даёт read access, ordinary UI
не обещает writing, первая write intent в Codex запускает native step-up, после
которого становится доступен выбор 0..1 writable Mind. MD-294 фиксирует
contract, MD-296 реализует его.

Однако это ещё не полный resolution. Repository contract и deterministic tests
не доказывают, что свежий установленный Marketplace plugin в текущем Codex host
надёжно покажет incremental consent. Это блокирующий row MD-299 real-account
canary. Если host не предлагает step-up после refresh/reinstall и bounded retry,
нужен явный product decision: расширить initial grant до read+write и изменить
обещание либо снять write claim для этого profile. Silent fallback запрещён.

### CR-5. Existing synthetic browser gate не проверяет браузер

`npm run gate:synthetic-browser` создаёт server-bound HTTP contexts, читает
HTML строками и проверяет fragments через `includes`/regex. Он хорошо доказывает
identity, ACL, API/UI projection и cleanup, но не исполняет DOM как браузер.

Repository содержит browser fixture servers, однако:

- `npm run check` их не запускает;
- browser runner отсутствует в dependencies;
- не выбраны runner/version, CI browser-binary install/cache strategy и
  deterministic fixture lifecycle;
- нет автоматической проверки viewport, overflow, focus order, accessible
  names, dialogs и screen-reader semantics.

Следовательно MD-299 сейчас не может получить заявленное
accessibility/mobile/browser evidence.

Для этого создан отдельный independently deliverable outcome MD-300:

- реальный browser runner для deterministic fixtures;
- desktop и mobile viewport;
- keyboard-only journey;
- semantic heading/label/dialog checks;
- bounded credential fixtures `0 / 1 / page_size + 1`;
- exact hosted observation отдельно от deterministic local gate.

MD-300 напрямую блокирует MD-299. Пока runner не реализован, MD-299 не может
называть layout/accessibility автоматически доказанными.

### CR-6. Resolved in plan: real-account canary blocking для UX claim

MD-293 обещает final first-user UAT с fresh Marketplace install и OAuth.
Accepted plugin/profile contract считает real external Marketplace/Codex UI
canary informational: его failure не блокирует Release 0.1 и запрещает только
claim о проверенном external-host UX.

Исправленный plan выбирает второй вариант: MD-299 и MD-293 не получают Done без
fresh real-account Marketplace/OAuth canary. Внешним blocker это становится
только после самостоятельных refresh/reinstall/deploy/reconcile попыток и
требует exact actor/action/resume signal.

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

Ordinary Connections поэтому показывает bounded active OAuth grants. Bounded
active/inactive history относится к personal tokens в Advanced MCP. Retained
revoked OAuth archive не входит в MVP без новой adapter projection.

### CR-9. Resolved by exclusion: hard delete вне MVP

Inactive binding tombstones нужны, чтобы stale clients гарантированно fail
closed. `mind-bindings.md` оставляет срок их хранения открытым вопросом.

MD-297 реализует hide/filter/pagination и test hygiene `revoke + hide`.
Physical cleanup требует отдельной retention/audit policy, но больше не
блокирует Release 0.1.

### CR-10. Resolved by exclusion: capture вне ordinary flow

Binding contract прямо говорит, что binding не включает automatic capture.
Первоначальный recovery target всё же оставлял capture controls на connection
detail page.

Исправленный plan не показывает automatic capture в ordinary Connections или
onboarding. Existing capability остаётся Advanced/post-MVP и не блокирует MVP.

### CR-11. Resolved: MD-299 напрямую блокирует final gate

Task Manager не доказал invariant «Epic нельзя закрыть, пока все children не
Done». Поэтому relation `MD-299 blocks MD-293` добавлена напрямую. Epic relation
остаётся для product grouping, а terminal UAT dependency теперь читается
машинно без предположения о lifecycle children.

### CR-12. Resolved in acceptance: bounded page evidence

Web performance recorder сейчас выделяет только home/stages. Новый главный
settings route может остаться медленным, даже если MCP budgets проходят.

MD-299 теперь измеряет:

- active connections page server time и rendered size;
- one connection detail page;
- inactive history page;
- cold/warm и fixtures `0 / 1 / page_size + 1`;
- верхнюю границу DB/binding reads.

## Рекомендуемый порядок разрешения

1. MD-292: amend accepted scope и reclassify post-MVP graph.
2. MD-301: собрать один exact `main` baseline.
3. MD-294: записать уже выбранный route/query/write-step-up contract.
4. MD-295–MD-298 и MD-300: реализовать bounded product и browser gates.
5. MD-299: deterministic + fresh real-account connection UAT.
6. MD-244/MD-252/MD-258/MD-285 + MD-299: разблокировать MD-293.
7. MD-293: один final first-user receipt без post-MVP scope.

## Что уже доказано

На историческом artifact `e39375b` до последующих правок плана были выполнены:

- `npm ci`;
- один полный `npm run check`: 689 tests, 689 passed;
- architecture, Product Site, fixtures, docs и secret/config checks;
- project-docs validator: 66 documents, 297 local links;
- `git diff --check` до push;
- remote read-back exact `e39375b` на `refs/heads/main`.

Это историческое evidence доказывает repository integrity только того
planning commit. Оно не доказывает текущий second-review artifact, UAT
deployment, новый UI, MD-300 или включение 21 commits из `1df46ec`.

## Findings второго критического прогона

### CR-13. Top-level Task Manager context противоречит recovery scope

Fresh read показал, что descriptions Project и Release всё ещё рассказывают про
retired AND/Linear era, одновременно исключают OAuth/public plugin из Release
0.1 и перечисляют scope, противоречащий текущему recovery graph.

Это не безопасная cosmetic mutation: top-level descriptions — часть
нормативного scope. Исправление добавлено в MD-292 и должно выполняться вместе
с accepted-doc amendment и atomic Task reclassification. До этого live
Project/Release context нельзя использовать как непротиворечивый acceptance
source.

### CR-14. План обещал несуществующую общую inactive-connections model

Первый вариант target показывал `Inactive connections` в ordinary
Connections. Реальный OAuth adapter возвращает active grants, а retained
revoked/expired history существует у personal tokens. Общий archive без новой
OAuth projection был бы ложным обещанием и мог бы вернуть unbounded page.

Исправлено в плане и Tasks MD-294/MD-297: ordinary Connections читает только
bounded active OAuth grants; Advanced MCP владеет bounded personal-token
history. OAuth archive не обещается в MVP.

### CR-15. Визуальная карта содержала фактические и accessibility-дефекты

Во второй проверке найдены неверный общий масштаб burden chart, схематические
ширины scope lanes без маркировки, неполный dependency graph, растягивающиеся
mobile sequence markers, семантически скрытые дочерние элементы risk chart и
двойной closing `main`. Эти дефекты исправлены в HTML и повторно проверяются в
desktop/mobile/browser runtime до commit.

## Явные unresolved gates после второго review

| Проблема | Почему не исправляется только документом | Владелец / signal |
|---|---|---|
| Normative Task Manager drift | Нужны принятые scope amendments и atomic reclassification | MD-292; docs и live Project/Release дают один scope |
| Integration divergence | Нужен disposition и перенос engineering commits, а не новая цифра в плане | MD-301; один remote `main` и full gate |
| Browser runner/CI mechanics | Нужно выбрать и внедрить runner, binary cache/install и fixture lifecycle | MD-300; non-zero deterministic browser gate |
| Incremental OAuth consent | Свойство внешнего host доказывается только fresh installed-plugin canary | MD-299; first write вызывает реальный step-up |
| Hosted release evidence | Нужны exact publish/read-back и consolidated UAT | MD-299/MD-293; SHA/deployment/package receipt |

Подтверждённых активных внешних blockers всё ещё нет: перечисленные пункты —
внутренние gates либо потенциальные platform boundaries до фактической
самостоятельной попытки.
