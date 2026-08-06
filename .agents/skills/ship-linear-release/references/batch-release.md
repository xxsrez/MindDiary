# Пакетная доставка milestone

Читай этот файл при сборке нескольких готовых feature refs в один проверенный
batch. Coordinator единолично владеет default branch, Linear, production Sites
deployment и release tags.
Workers владеют только своими worktree/branch, реализацией, commit и
`FEATURE_RECEIPT`; они не меняют default branch, Linear, Sites и tags.

Если Git hosting подтверждённо недоступен и пользователь явно разрешил
local-only progress, применяй [offline-delivery.md](offline-delivery.md).

## Сформировать batch

1. Восстанови состояние по [протоколу квитанций](receipts.md), закрепи exact
   milestone, `delivery_profile`, ожидаемый `origin/<default>` SHA, queue
   fingerprint и `batch_id`.
2. Выбери `FEATURE_RECEIPT` со статусом `ready`: refs существуют, scope
   актуален и dependencies выполнены. Пересечение ownership само по себе не
   исключает feature из batch, но требует последовательной интеграции и
   semantic conflict review. Неразрешимую зависимую либо конфликтующую feature
   отложи, не задерживая независимые.
3. Создай dedicated integration worktree и branch
   `codex/release/<milestone>-<batch>-g<generation>` от ожидаемого default
   branch.
   Никогда не собирай batch в пользовательском либо dirty checkout.
4. В топологическом устойчивом порядке добавляй exact feature SHAs. Перед
   каждым добавлением проверь ref, batch-root ancestry, записанные dependency
   SHAs, scope и конфликт путей. Stacked descendant добавляй только после его
   ancestors. После него выполняй только merge preflight, `git diff --check` и
   affected tests; не запускай полный suite после каждого merge.
5. Если feature не проходит preflight или ломает affected tests, оформи
   `DEFECT_CANDIDATE`, верни её issue в `In Progress` и исключи feature.
   Предпочти пересборку integration branch из того же base без плохого ref;
   если ref уже опубликован в общей истории и нельзя чисто исключить, сделай
   явный issue-scoped revert и проверь его. Остальные совместимые feature
   продолжай выпускать.
6. Если upstream feature исключена либо её receipt superseded, не используй
   downstream refs со старым dependency SHA. Исключи их вместе с upstream или
   дождись новых descendant SHAs и receipts; независимые lanes продолжай.

## Запечатать и проверить candidate

Когда состав перестал меняться, создай новую candidate generation и зафиксируй:

- ordered `issue -> base/dependency SHAs -> feature SHA -> origin ref`;
- `candidate_sha` и source tree OID (`candidate^{tree}`);
- `gate_contract_hash`: hash канонического списка обязательных commands,
  docs/code/security/OKF/MCP/UI gates, capability boundary, `not-available`
  gaps и применимых acceptance rules;
- `environment_fingerprint`: hash OS/arch, реально используемых toolchain и
  lockfile digests, validator/client/browser versions и иных влияющих на gate
  параметров.

После sealing не меняй source tree. Любая правка, merge, исключение либо revert
создаёт следующую generation.

Повторно используй успешный integrated gate только при точном совпадении
`source_tree_oid + gate_contract_hash + environment_fingerprint` и наличии
durable evidence. Это переиспользует только validation: exact-SHA CI и
default-branch CAS всегда проверяются для текущего batch; Sites deployment/live
smoke выполняются заново только для `delivery_profile=release`.

Для generation без подходящего evidence один раз выполни полный integrated gate
на exact candidate tree. Построй его из обязательных правил `AGENTS.md`, live
acceptance и реально существующих scripts/configs: project-docs validator и
`git diff --check` для docs, canonical build/test/lint/security commands для
кода, strict full-bundle validation для OKF fixtures, batch-wide integration,
UI flows и version-specific MCP/client conformance при применимости.

Недоступную external/client/platform проверку зафиксируй как `not-available`.
Она совместима с `gate-passed` только если live acceptance и выбранный profile
не требуют именно этого evidence. Не подменяй требуемый Sites/client gate
локальным smoke и не заявляй compatibility по отсутствию ошибки.

При провале классифицируй причину:

- маленькая локальная ошибка без нового решения — исправь на integration
  branch, выполни affected tests, reseal и повтори полный gate;
- дефект конкретной feature — переоткрой исходную работу, исправь тот же
  feature ref/worktree, замени ref в batch и собери новую generation;
- новый либо cross-feature дефект — coordinator создаёт Linear bug и либо
  исключает/revert-ит виновный scope, либо блокирует batch при обязательной
  зависимости.

Не считай retry доказательством успеха при недетерминированном результате:
необъяснённый flake блокирует candidate.

Если после batch пользователь сообщает regression, переоткрой исходную issue
либо создай deduplicated linked Bug. Не превращай отсутствие нужной platform
или client проверки во время предыдущего batch в доказательство совместимости
или в причину скрыть новый fail.

## Проверить candidate до default branch

После локального integrated gate проверь, поддерживает ли уже существующая
CI-конфигурация exact-SHA run для candidate branch, pull request или
manual dispatch. Если поддерживает, запусти его до default branch и запиши
bounded `PREPUSH_CI` evidence. Не создавай PR и не меняй CI/infrastructure
только ради ускорения без уже имеющегося разрешённого path.

До запуска раздели checks:

- `portable` — docs/unit/type/build/security/OKF/protocol checks, которые имеют
  одинаковый contract на runner OS;
- `platform-bound` — cloud bindings, real client/browser/device, pixel и
  performance baselines конкретной среды.

Не запускай platform-bound baseline на несовместимом runner и не ослабляй
threshold ради зелёного CI. При отсутствии подходящего pre-push path запиши
`PREPUSH_CI: not-available` и продолжай по локальному gate; configured required
CI exact default SHA остаётся обязательным после push.

## Продвинуть exact candidate

Ниже описан online path. В offline mode не имитируй fetch/push/CI: локально
интегрируй batch и публикуй накопленную очередь только по отдельному протоколу.

1. Fetch-ом потребуй `origin/<default> == expected_default_sha` и fast-forward
   ancestry `expected_default_sha -> candidate_sha`.
2. Push exact candidate в default branch без force. Считай server-side ref
   update CAS: при drift перечитай refs и пересобери/revalidate candidate; не
   переписывай чужую историю.
3. Дождись required CI именно для `candidate_sha`, если required CI настроен.
   Не подменяй его pre-push run или проверкой другого commit с тем же
   содержимым. При совпавшем validation key не повторяй локальный full gate.
   Проверяй job компактным status snapshot раз в 45–60 секунд, не streaming
   watcher-ом. Полный failing log читай один раз и только для упавшего job.
   Один явно stalled/infra-flake run можно cancel/retry на неизменном SHA;
   повторная необъяснённая нестабильность — external gap, а не бесконечный
   retry. Отсутствие configured CI запиши как `none`.
4. Для `delivery_profile=design|build` запиши deployments/tag как
   `not-applicable` и не создавай их. После полного доказательства acceptance,
   integrated gate, default ref и configured CI можно закрыть вошедшие issue;
   такой batch называется `integrated`, а не production release.
5. Для `delivery_profile=release` разреши exact production OpenAI Site по
   tracked `.openai/hosting.json` и runbook. Web/control, persistence и `/mcp`
   — обязательные flows одного Sites release; отдельный container и AWS не
   являются fallback.
6. Найди существующий Sites artifact этого SHA или один раз создай его из exact
   validated build, затем deploy ровно один раз. Повторный ход продолжай по
   сохранённым version/deployment IDs, не создавая дубликаты.
7. Дождись terminal success и выполни live authenticated web/control, storage
   persistence и required MCP client gates одного Site.
8. Только после успешного live smoke создай immutable annotated tag на exact
   `candidate_sha`, если tracked version policy требует tag. Не выводи SemVer
   из произвольного имени milestone; при отсутствии однозначной policy спроси
   до первого deploy. Не двигай, не удаляй и не переиспользуй release tags.
9. Upsert-ни `BATCH_RELEASE_RECEIPT`, затем issue receipts/comments и переведи
   в `Done` только issue с полностью доказанным acceptance. После свежего
   milestone snapshot очисти только task-owned worktrees/refs, чьи commits уже
   достижимы из default branch или immutable tag.

До первого deploy определи `previous_stable` Sites version и exact rollback
artifact. Если связь с reachable Git SHA и рабочими web + MCP flows нельзя
доказать, не выдумывай baseline и остановись до deploy за одним продуктовым
решением.

## Провал production smoke

Не создавай tag и не переводи release-scoped issue в `Done`. Сохрани failed
Sites artifact/deployment как evidence, оформи `DEFECT_CANDIDATE` и redeploy
exact saved version из `previous_stable`. Дождись terminal success и проверь
прежние критические web/control и MCP flows.

Так как default branch уже содержит failed candidate, не строй новый batch
поверх известного дефекта молча. Примени ту же классификацию: маленький direct
fix, возврат в исходную feature branch или новый Linear Bug; при необходимости
сделай явный whole-batch/issue revert новым commit. Исправление всегда получает
новый commit, candidate generation, новый artifact/deployment и immutable
version по tracked policy. Невиновные feature можно выпустить отдельным batch;
production fail одной feature не удерживает их без dependency-причины.
