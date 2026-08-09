# Mind Diary: самостоятельная рыночная оценка

Статус: датированный decision report на 2026-08-05. Описания repository и
deployment state ниже являются снимком на дату оценки, а не текущим status.

## Executive Summary

- **Узкий Codex-first pilot делать стоит.** Есть конкретный initial ICP и
  наблюдавшаяся проблема: часть пользователей умеет работать с Codex, но не
  справляется с установкой skill, ведением OKF bundle и сопровождением
  storage/access stack.
- **Полный roadmap до пользовательского сигнала строить не следует.** Формальный
  MVP шире минимального теста одного job-to-be-done; решение о продолжении
  должно приниматься по повторному использованию реальных Minds, а не по
  полноте архитектуры или факту deployment.
- **Конкуренция сильная, moat пока отсутствует.** GitHub, Notion, Tana, Anytype,
  native AI Projects и memory services уже закрывают значительную часть
  результата. Возможный wedge — managed simplicity плюс OKF portability,
  revisions и access boundary, но это ещё не доказанная причина платить.
- **Рекомендуемое решение — staged validation.** Сначала Sites + Codex проверяет
  managed OKF workflow; AWS начинается только после usage gate; website AI для
  нетехнической аудитории проходит отдельную проверку.

> **Вердикт:** Mind Diary имеет смысл делать как ограниченный четырёхнедельный
> validation experiment. Рассматривать его как подтверждённый SaaS business или
> сразу реализовывать весь roadmap оснований пока нет.

## Контекст оценки

На дату оценки у проекта есть:

- design-first bootstrap без реализованного сервисного кода и без
  deployment;
- принятая MVP direction: дешёвый Codex-first managed OKF workflow на
  OpenAI Sites;
- принятая post-MVP direction: основная AWS infrastructure после
  проверки MVP;
- принятая future direction: отдельная website AI surface, где backend
  сам вызывает model APIs и не требует от пользователя настройки
  Codex/MCP;
- явно запланированные post-MVP функции imports и named
  checkpoints;
- открытый вопрос по producer-defined non-Markdown files
  (`BundleFile` / `OpaqueAsset`): вероятная
  необходимость признаётся, но exact file profile, transport и security
  boundary пока не приняты.

### Что именно проверяется MVP

MVP не проверяет весь будущий продукт сразу. Его центральная гипотеза
уже сужена:

> Пользователям Codex может быть нужен hosted managed OKF workflow,
> который снимает установку и сопровождение local skill, bundle,
> storage/access stack и операционные детали вокруг knowledge base.

Это важно, потому что value proposition первой фазы строится не
вокруг «AI-продукта для всех», а вокруг managed knowledge layer для уже
существующей Codex-аудитории.

## Метод и источники

Оценка опирается на четыре типа материала:

1.  Принятые документы проекта: overview, roadmap, architecture, MVP,
    domain model, API assumptions и связанные ADR.
2.  Наблюдение владельца о существующем installable Codex skill, который
    уже умеет создавать и сопровождать local OKF store, но оказался сложным
    для части умеренно технических пользователей.
3.  Актуальные внешние substitutes и конкуренты в knowledge/AI/MCP
    сегменте.
4.  Проверенный статус Open Knowledge Format 0.2, включая важное
    ограничение: спецификация не задаёт нормативную `Asset`
    entity или universal binary manifest.

Границы метода:

- наблюдение о текущем precursor является qualitative evidence, а не
  cohort study;
- нет подтверждённых retention numbers, activation funnel или
  willingness-to-pay data;
- на дату оценки не существует работающего production MVP, поэтому
  оценка касается direction и вероятности useful experiment, а не уже
  показанного product-market fit.

## Кому это может быть нужно

### Initial ICP

Первичная аудитория — не expert developer и не массовый consumer. Это
пользователь, который:

- уже умеет ставить задачи Codex и обычно уже платит за agent
  access;
- хочет persistent corpus вместо повторного copy-paste контекста;
- способен понять Mind, revision, search и access;
- при этом не хочет вручную ставить skill, держать local bundle,
  разбираться в evolving OKF и обслуживать DIY stack.

Главный job-to-be-done первой фазы:

> Дать Codex готовый, постоянно доступный и переносимый Mind без
> необходимости самому поднимать и сопровождать knowledge
> infrastructure.

Формулировка намеренно уже, чем «second brain для всех», чтобы pilot проверял один наблюдаемый job-to-be-done.

### Что Mind Diary продаёт этой аудитории

Не сам термин OKF и не абстрактную «память для AI», а снятие
конкретной операционной сложности:

- bootstrap hosted corpus;
- validation и сохранение совместимости с evolving format;
- revision history;
- access boundary;
- exportability;
- снижение ручной работы вокруг DIY setup.

## Что говорит существующий precursor

У проекта уже есть рабочий precursor в виде installable Codex skill
для local OKF workflow. Ключевое наблюдение владельца: даже этот
относительно несложный flow оказался трудным для части умеренно
технических пользователей Codex.

Это наблюдение поддерживает две важные гипотезы:

1.  Между «умеет пользоваться Codex» и «умеет развернуть knowledge
    stack» есть реальный usability gap.
2.  Managed setup может быть самостоятельной product value даже до
    встроенного website AI.

Но evidence пока ограничен:

- неизвестно, сколько людей реально попробовали precursor;
- неизвестно, сколько завершили setup;
- неизвестно, вернулись ли они через неделю;
- неизвестно, готовы ли они платить;
- неизвестно, является ли difficulty разовой проблемой onboarding или
  постоянной operational pain.

Вывод: precursor поднимает prior полезности, но пока не превращает
идею в доказанный рынок.

## Конкуренты и substitutes

### Прямые и близкие substitutes

- [Tana](https://tana.inc/learn/features/mcp)
- [Anytype](https://developers.anytype.io/docs/examples/featured/mcp/)
- [Capacities](https://docs.capacities.io/reference/ai-chat-connectors)
- [Notion](https://www.notion.com/help/notion-mcp)
- [GitHub
  MCP](https://github.com/github/github-mcp-server)
- [ChatGPT
  Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [Claude
  Projects](https://support.anthropic.com/en/articles/9517075-what-are-projects)
- [Supermemory](https://supermemory.ai/pricing/)
- [Mem0](https://mem0.ai/pricing)

### Что они уже закрывают

- hosted notes/knowledge UI;
- persistent project context;
- agent access к существующему корпусу;
- versioning, portability или permissions в разных комбинациях;
- снижение setup friction внутри одного vendor ecosystem.

### Почему ответ «пусть просто используют Git» недостаточен

Для экспертной технической аудитории Git/Markdown действительно
остаётся сильным substitute. Но целевой initial ICP как раз находится
немного ниже этой планки: он уже получает value от Codex, но не хочет
обслуживать весь stack самостоятельно.

Если assisted onboarding, managed revisions и hosted access реально
делают подключение проще local skill + Git + manual bundle maintenance,
у Mind Diary есть шанс на нишевую полезность. Если нет, продукт
проигрывает и более зрелым hosted tools, и DIY stack одновременно.

### Где может появиться дифференциация

- OKF-compatible hosted workflow;
- чёткая revision/history модель;
- более прозрачная portability story;
- better fit именно для Codex workflow, а не для generic
  note-taking;
- управляемый access boundary для shared Minds.

Но это пока не moat. Почти всё перечисленное концептуально
копируемо.

## Что выглядит сильным

### 1. Проблема не выдумана

Проект не начинается с абстрактной идеи «сделать ещё одну память для
AI». Источник гипотезы — уже существующий полезный precursor и
наблюдавшаяся сложность использования.

### 2. Вход в эксперимент дешёвый

Первый MVP не обязан сразу нести собственную model inference
economics. Пользователь уже оплачивает Codex, поэтому можно тестировать
именно hosted workflow value.

### 3. Staged roadmap ограничивает преждевременные вложения

Принятая последовательность рациональна:

1.  Sites + Codex подтверждают managed corpus layer.
2.  AWS становится основной infrastructure direction после подтверждения
    ценности.
3.  Website AI появляется как отдельная фаза после проверки первой
    аудитории.

Это лучше, чем пытаться одновременно строить consumer AI product и
сложную knowledge platform.

### 4. Engineering value существует отдельно от business upside

Даже если рынок окажется нишевым, проект всё равно даёт полезный
результат как platform/architecture exercise: OKF codec, revisioned
corpus, access model, portable domain core, future AWS path.

Это не market proof, но как личный engineering investment проект
рационален.

## Что остаётся главным критическим риском

### 1. Формальный MVP всё ещё слишком широк как тест спроса

Текущий design baseline включает:

- account bootstrap;
- Personal Mind;
- ordinary Minds;
- четыре роли;
- invitations;
- `private` / `unlisted` /
  `public`;
- token lifecycle;
- immutable revisions;
- export jobs;
- Sites compatibility gate.

Это уже почти platform slice, а не узкая проверка одного JTBD. В
таком виде MVP может дать engineering satisfaction, но плохо ответить на
вопрос: нужен ли людям managed OKF workflow как продукт.

Практический вывод: для спроса важнее наблюдать usage на тонком
internal slice: private Mind, minimal setup, search/fetch, meaningful
write, history/export, быстрый revert.

### 2. Ближний круг легко даст ложноположительный сигнал

Friendly users:

- терпимее к шероховатому onboarding;
- помогают из симпатии к автору;
- реже формулируют жёсткий отказ;
- часто меряют не продуктовую ценность, а поддержку автора в
  настройке.

Поэтому assisted pilot на знакомых полезен как инструмент поиска
грубых дефектов, но не как достаточное доказательство внешнего
спроса.

### 3. Отсутствие productized import может испортить эксперимент

Пустой Mind не даёт честной проверки ценности. Если пользователь
должен сначала сам создать содержательный corpus, пилот будет измерять
терпение к bootstrap, а не ценность managed knowledge service.

Полный import pipeline не обязателен уже сейчас. Но нужен хотя бы
concierge import или одноразовый converter, чтобы у pilot user быстро
появлялась реальная база знаний.

### 4. Success в Codex wedge не доказывает website AI

Будущий web-native AI product — это другой рынок и другая
экономика:

- другой onboarding;
- другой cost structure;
- другой trust model;
- другой набор конкурентов;
- отдельные требования к citations, write safety и consent.

Нельзя автоматически переносить positive signal первой cohort на
более широкую нетехническую аудиторию.

### 5. Immediate writes могут стать adoption barrier

Текущая модель immediate commits с history и CAS технически
рациональна, но психологически может быть жёсткой: часть пользователей
не захочет давать агенту прямую mutation capability без удобного
diff/revert. История частично снижает риск, но ранний спрос на readable
diff и быстрый откат нужно измерять отдельно.

### 6. AWS path несёт риск самообмана

AWS migration может оказаться успешной с инженерной точки зрения и
при этом не означать наличия рынка. Это полезная учебная и архитектурная
цель, но она не должна подменять product evidence.

### 7. Managed simplicity пока существует только как гипотеза

Пользователь всё ещё должен пройти assisted account/MCP setup, выпустить bearer
token и настроить environment variable в Codex. Если этот путь не станет
существенно проще local skill + Git, центральное преимущество продукта исчезнет.

### 8. Sites gate может исказить market signal

Streamable HTTP MCP в Sites остаётся непроверенной platform capability. Провал
production gate не равен отсутствию пользовательской ценности, а успешный
deployment не равен наличию спроса. Workflow value и release readiness нужно
учитывать раздельно.

### 9. Distribution и monetization не подтверждены

Ближний круг является pilot pool, но не каналом роста. Оплата Codex показывает
готовность платить за agent inference, а не за Mind Diary. До payment experiment
нет evidence отдельного buyer, price corridor или acquisition channel.

### 10. `Mind Diary` уже занято в продуктовом и поисковом смысле

Название не просто абстрактно похоже на mood diary category. В Google Play уже
есть активное приложение, которое прямо представляется как
[Mind Diary](https://play.google.com/store/apps/details?id=com.inbnet.mind_diary):
это emotional diary компании inbnet Co., Ltd., обновлённое 28 октября 2025 года.
В App Store также доступен близкий по имени и категории
[Daily Mind Diary](https://apps.apple.com/ca/app/daily-mind-diary/id6736584024).

Следовательно, `Mind Diary` уже **занято как marketplace phrase и product
association**. Это создаёт три практических риска:

- поисковая выдача и app-store discovery будут смешивать knowledge service с
  mood, mindfulness и mental-health diaries;
- название само подталкивает аудиторию к неверной consumer category;
- defensibility бренда и доступность domains/handles будут слабее, даже если
  юридический конфликт не подтвердится.

Это evidence использования названия, но не trademark clearance. Отчёт не
проверял реестры товарных знаков по нужным jurisdictions/classes, права ранних
пользователей названия, domains и social handles. Поэтому нельзя честно
утверждать ни «название юридически свободно», ни «его юридически нельзя
использовать». Для закрытого pilot rename не обязателен; до публичного запуска
нужны naming shortlist, trademark/domain search и решение о новом имени.

## Assets и non-Markdown files

### Что здесь важно не перепутать

Open Knowledge Format 0.2 не задаёт нормативную `Asset`
entity, binary manifest, MIME policy или universal transport
contract.

Официальная спецификация: [OKF
SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

Следовательно, для Mind Diary будущие files и assets — это не «уже
готовая часть стандарта», а отдельная producer-defined product area.

### Что, вероятно, понадобится позже

- PDF;
- images;
- audio/video;
- office documents;
- CSV/JSON;
- notebooks, SQL, code и другие opaque files.

### Почему это не стоит смешивать с первым demand test

Поддержка files почти наверняка важна для серьёзного knowledge
product, но она тянет за собой отдельный большой slice:

- exact-byte round-trip;
- object storage;
- checksums и metadata;
- quotas;
- malware/sandbox policy;
- OCR/transcription как derived capabilities;
- download authorization;
- preview semantics.

Поэтому imports и checkpoints разумно проверять раньше, а full
asset/file profile проектировать отдельной фазой.

## Что может пойти не так по рынку

Самый опасный сценарий:

1.  Автор и знакомые видят, что hosted workflow «прикольный».
2.  Команда интерпретирует это как доказательство реального спроса.
3.  Начинается большая работа по AWS, AI surface и assets.
4.  Выясняется, что outside the circle люди либо довольствуются
    Projects/Notion, либо готовы использовать только совсем простой consumer
    product, а не managed corpus layer.

Это не делает идею плохой, но показывает, что без жёсткого usage gate
проект легко уходит в красивую platform-building exercise без
подтверждённой экономики.

## Рекомендуемый validation design

### Cohorts

- 6–8 пользователей ближнего круга для assisted pilot;
- затем минимум 3–5 внешних пользователей с тем же ICP;
- у каждого должен быть реальный knowledge workflow или existing
  corpus.

### Минимальный workflow, который надо проверить

1.  Assisted account/MCP setup.
2.  Concierge import или быстрый старт с подготовленным corpus.
3.  Реальный `search` / `fetch` в рабочем
    сценарии.
4.  Хотя бы один meaningful content write.
5.  Использование history, export и при необходимости revert.

### Предлагаемый gate через четыре недели

Это не принятый KPI framework, а рекомендуемый falsification
threshold:

- не менее 4 из 8 pilot users активны на четвёртой неделе;
- у половины retained users есть не только reads, но и meaningful
  writes, history/revert или export;
- минимум 3 пользователя называют конкретный workflow, где managed
  Mind лучше local skill, Git или ручного контекстирования;
- минимум 2–3 готовы продолжать за символические деньги или team
  budget;
- минимум 2 реально используют export или настойчиво требуют
  import/checkpoint по рабочей необходимости;
- onboarding и первый полезный search после подготовленного corpus
  укладываются примерно в 15 минут.

### Что будет негативным сигналом

- люди не возвращаются после первой демонстрации;
- продукт используется как read-only demo, но не как рабочее
  хранилище;
- никто не трогает history/export;
- ценность возникает только пока автор лично помогает с
  настройкой;
- пользователи предпочитают вернуться к local files, Projects, Notion
  или DIY.

## Оценка по измерениям

| Измерение | Оценка | Комментарий |
|---|---:|---|
| Реальность underlying problem | 8/10 | Есть precursor и наблюдавшаяся setup friction. |
| Связность staged strategy | 7/10 | Sites → AWS → website AI теперь образуют понятную последовательность. |
| Сила начального Codex wedge | 6/10 | Уже не чистая гипотеза, но cohort data пока нет. |
| Техническая архитектура | 8/10 | Portability, revisions и access boundaries соответствуют roadmap. |
| Эффективность полного текущего MVP как market test | 4/10 | Scope шире одного проверяемого JTBD. |
| Distribution в начальной аудитории | 5/10 | Есть ближний круг и Codex users, но внешнего канала ещё нет. |
| Monetization evidence | 2/10 | Нет прямых признаков willingness-to-pay. |
| Ценность узкого pilot | 9/10 | Эксперимент дешёвый и быстро опровергает центральную гипотезу. |
| Engineering/learning value | 9/10 | Даже при нишевом исходе проект даёт полезный технический результат. |

## Субъективные вероятности

Это judgment ranges, а не статистическая модель:

- вероятность найти регулярную полезность в выбранной Codex cohort:
  примерно 45–65%;
- вероятность после сужения получить небольшой платный niche product:
  примерно 25–40%;
- потенциал future website AI пока рано оценивать, потому что первая
  фаза его не измеряет.

## Итоговая рекомендация

Mind Diary **имеет смысл продолжать**, но только в
следующем режиме:

- как ограниченный Codex-first validation experiment;
- с жёстким разделением между product evidence и engineering
  progress;
- без преждевременной ставки на большой AWS/AI/assets build;
- с ранним concierge import, чтобы пилот не стартовал с пустого
  corpus;
- с обязательной проверкой на пользователях вне ближнего круга до
  крупных post-MVP инвестиций.

### Что было бы ошибкой

- считать assisted usage знакомых доказательством рынка;
- принимать успешный deployment за доказательство recurring
  value;
- трактовать потребность в future website AI как уже
  подтверждённую;
- строить full asset/file platform до подтверждения базовой полезности
  hosted managed Mind.

### Что было бы разумным следующим шагом

Собрать минимально жизнеспособный pilot вокруг реального corpus,
реального search/write/history workflow и измеряемого retention signal.
Если этот шаг не даёт usage beyond novelty, проект лучше остановить или
оставить как личный engineering exercise. Если даёт — тогда переход к
AWS, imports, checkpoints и дальнейшему productization становится
рациональным.

## Further Questions

- Какой один workflow считать главным JTBD первой cohort: hosted OKF
  maintenance, persistent context, agent writes или shared access?
- Какой минимальный concierge import нужен каждому pilot user?
- Насколько часто users реально используют history, revert и export?
- Требуется ли proposal/diff approval раньше collaboration features?
- Какой exact usage gate запускает AWS migration?
- Какая аудитория и цена отдельно подтверждают website AI?
- Нужно ли менять название перед привлечением внешних пользователей?

## Caveats and Assumptions

- Статус документа: report, 2026-08-05. Это decision memo, а не доказательство
  спроса, retention, deployment или будущей выручки.
- Наблюдение о local skill и setup friction предоставлено владельцем проекта и
  не подтверждено сохранённой cohort telemetry.
- Competitor pages подтверждают заявленные capabilities, но не дают сопоставимых
  retention, revenue или user-satisfaction data.
- Точного exhaustive census всех продуктов не проводилось; «полный аналог не
  найден» не является доказательством его несуществования.
- Числовые оценки, thresholds и probability ranges являются экспертным judgment
  при отсутствии usage и payment data.
- Анализ фиксирует рынок на 2026-08-05 и должен быть обновлён после pilot data
  либо существенных изменений OKF/MCP ecosystem.

Связанный product context: [roadmap](../roadmap.md),
[overview](../overview.md), [MVP](../specs/mvp.md),
[architecture](../architecture.md).
