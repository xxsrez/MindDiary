# План обновления runtime-регистрации Mind Diary plugin

Статус: planned, выполнение не начато.

Документ фиксирует обнаруженный 22 августа 2026 года разрыв между актуальным
Marketplace package и фактически загруженной в Codex runtime-регистрацией Mind
Diary. Это план ремонта клиентской установки и её проверки, а не разрешение на
удаление connector, отзыв OAuth grant, изменение данных Minds или product
deployment.

## Результат, который нужен

Заменить legacy registered connector Mind Diary на принятый direct MCP path из
`mind-diary@srez-marketplace`, не меняя UAT backend или содержимое Minds, и
доказать в новом Codex runtime, что:

- package установлен из актуального Srez Marketplace snapshot;
- первый доступ использует `AVAILABLE + ON_USE` и direct
  `https://mind-diary.example.invalid/api/mcp`;
- model-visible tools принадлежат новой установке, а не прежнему registered
  app;
- tool catalog соответствует текущему repository contract;
- read-only OAuth smoke работает после cold restart и в новой задаче.

## Наблюдаемая проблема

### Что актуально

На момент наблюдения `2026-08-21T23:31:40Z`:

- MindDiary checkout находится на
  `cf50d865cef0cf232817be511fe444d4fde2e8cc`;
- local Srez Marketplace snapshot и GitHub HEAD совпадают на
  `5ea655b0e46b846b329bf6c70b767db25056b3b0`;
- Marketplace и installed cache содержат одну версию
  `mind-diary@srez-marketplace` — `0.1.0+codex.20260820070820`;
- `diff -qr` не находит различий между Marketplace source и installed cache,
  а SHA-256 manifest, `.mcp.json` и `SKILL.md` попарно совпадают;
- live endpoint отвечает через OAuth: read-only `list_minds` завершился
  успешно;
- загружены все 12 canonical tools, и их descriptions, input/output schemas и
  annotations структурно совпадают с `MCP_TOOL_DEFINITIONS` текущего checkout.

Следовательно, это не outage UAT backend и не устаревший tool contract на
сервере.

### Что застряло

При этом model-visible runtime использует:

- namespace `mind_diary_uat.*`;
- connector ID `asdk_app_exampleb0edf6845c052387`;
- legacy remote-plugin wrapper `Mind Diary UAT final`.

Этот `asdk_app_*` — exact ID из старого `plugins/mind-diary/.app.json`.
Commit `d2646a9989ee91596e7f978c2d3d0d1355500b83` удалил `.app.json` и перевёл
package на direct MCP. Текущий accepted contract в
[ADR-0011](../decisions/0011-direct-mcp-plugin-oauth-on-use.md) прямо говорит,
что registered connector не является prerequisite Codex pilot 0.1.

Таким образом, package files обновились, но активная connector registration
не мигрировала. Сейчас это не портит schemas, потому что старый link читает
актуальный remote MCP, однако он обходит целевой install-before-OAuth path и
может скрывать будущие изменения package metadata, skill, endpoint или auth
policy.

## Что показал опыт Task Manager

User-observed incident Task Manager дал следующий результат:

1. Marketplace/package был обновлён, но Codex продолжал показывать старый
   runtime surface.
2. Обычное обновление не заменило активную connector registration.
3. Только удаление прежнего подключения и его повторное создание привезло
   новый runtime.
4. После пересоздания текущий Task Manager виден как
   `Task Manager — Srez Marketplace`, использует package-qualified namespace и
   экспортирует 42 tools, включая `add_task_comment`, `list_task_comments` и
   `get_task_thread`, которых не было в застрявшем snapshot.

Отдельный distribution run `ship-tasks` показал ещё два связанных свойства
Codex:

- `plugin add` до `marketplace upgrade` способен снова установить старую
  версию из локального Marketplace snapshot;
- уже открытая задача может удерживать прежний skill/tool snapshot даже после
  корректной переустановки, поэтому проверка выполняется в fresh App Server или
  новой задаче.

Урок переносится на Mind Diary как verification policy, но не как утверждение
об общей внутренней причине: точный механизм, из-за которого Codex сохраняет
legacy app-link, пока не установлен.

## Что подтверждает официальная документация Codex

Официальная документация разделяет операции:

- [`codex plugin marketplace upgrade`](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace)
  обновляет configured Git Marketplace snapshot;
- [`codex plugin add/remove`](https://learn.chatgpt.com/docs/developer-commands#codex-plugin)
  отдельно устанавливает и удаляет plugin из local config/cache.

Документация не обещает, что Marketplace upgrade сам заменит уже активную
runtime-регистрацию или удалит ранее установленный registered app. Поэтому
процедура ниже считает refresh Marketplace, replacement установки и fresh
runtime verification тремя независимыми gates.

## Границы и запреты

В этот план не входят:

- изменение UAT Site, deployment, access policy или production;
- вызов `commit_changeset` и любые изменения Memories;
- удаление account, Mind, revision или product data;
- ручное удаление каталогов `~/.codex/plugins/cache`, app-tools cache или
  Marketplace clone;
- чтение, копирование, удаление или ремонт Keychain entries;
- перенос OAuth tokens через shell, clipboard, файлы или логи;
- восстановление старого `.app.json` как скрытый fallback;
- удаление всего `srez-marketplace` ради одного plugin.

Удаление plugin/connector и возможный revoke grant выполняются только после
отдельного явного разрешения пользователя на execution. Данные Minds не должны
затрагиваться: mutable scope ограничен клиентской установкой, connector link и
относящимся к нему OAuth grant.

## План выполнения

### Phase 0. Зафиксировать pre-state

До первого mutable действия сохранить privacy-safe receipt:

1. Codex build: `codex --version`.
2. MindDiary candidate SHA и clean/dirty state.
3. Remote и configured Marketplace revisions.
4. Marketplace package version, manifest hash, `.mcp.json` hash и skill hash.
5. Installed package version и source/cache equality.
6. `codex mcp list --json`: exact URL, enabled state и OAuth status без token
   values.
7. Fresh model-visible tool names, count, schemas hash, connector provenance и
   список duplicate Mind Diary sources.
8. Read-only `list_minds` result как success/failure без сохранения private
   Mind descriptors.

Internal cache path допустим только как дополнительная диагностика текущего
Codex build. Acceptance не должна зависеть от конкретного имени cache-файла.

### Phase 1. Доказать готовность direct MCP path до удаления

1. Проверить accepted package shape: manifest не содержит `apps`, `.app.json`
   отсутствует, `.mcp.json` содержит один exact UAT resource.
2. Запустить blocking repository gate в temporary evidence directory:

   ```bash
   npm run gate:oauth-direct-plugin -- \
     --candidate-sha cf50d865cef0cf232817be511fe444d4fde2e8cc \
     --evidence-out <private-temp-path>/evidence.json
   ```

3. Проверить `AVAILABLE + ON_USE`, install-before-OAuth, DCR/PKCE, read-first
   scopes, revoke/reconnect и fresh temporary discovery по redacted receipt.
4. Если gate не проходит, остановиться до удаления текущего подключения.

SHA в команде является observed candidate этого плана. При будущем execution
нужно подставить заново проверенный exact candidate, а не использовать его как
вечную константу.

### Phase 2. Обновить Marketplace snapshot

Выполнить до повторной установки:

```bash
codex plugin marketplace upgrade srez-marketplace --json
codex plugin list --available --json
```

Gate:

- upgrade завершился без `errors`;
- configured Marketplace revision совпадает с remote intended revision;
- каталог рекламирует intended immutable plugin version;
- source manifest, skill и `.mcp.json` соответствуют проверенному package.

Если payload package менялся после `0.1.0+codex.20260820070820`, сначала нужен
новый manifest version/cachebuster и pushed Marketplace commit. Если package не
менялся и исправляется только installation state, искусственный version bump не
требуется.

### Phase 3. Удалить только старую установку

После отдельного подтверждения пользователя:

```bash
codex plugin remove mind-diary@srez-marketplace --json
```

Затем проверить отдельно:

1. package больше не отображается installed/enabled;
2. plugin-owned MCP server исчез из нового runtime inventory;
3. legacy registered app/link с ID
   `asdk_app_exampleb0edf6845c052387` не остался installed/callable;
4. Task Manager и другие plugins не изменились.

`codex plugin remove` документирован как удаление local config/cache. Если
legacy remote app останется отдельно, удалить именно `Mind Diary UAT final` с
точной проверкой ID через поддержанную Plugin Management surface. Не удалять
его каталог вручную и не выбирать target только по похожему display name.

После удаления полностью перезапустить Codex/App Server. Состояние старой
задачи не является post-remove evidence.

### Phase 4. Установить direct MCP package заново

Выполнить после Phase 2 и cold restart:

```bash
codex plugin add mind-diary@srez-marketplace --json
```

Немедленный install gate:

- returned `pluginId` равен `mind-diary@srez-marketplace`;
- версия равна intended Marketplace version;
- `authPolicy` равен `ON_USE`;
- installation завершается без обращения к старому private `asdk_app_*`;
- source и installed cache совпадают по дереву и SHA-256;
- `codex mcp list --json` показывает только один Mind Diary direct MCP server с
  exact `/api/mcp` resource.

При первом read-only вызове разрешить native OAuth только через product flow.
Не вводить MCP URL, client secret или personal token вручную. Если consent
сразу требует `content:write`, старый connector ID или неизвестный resource,
остановиться и сохранить redacted failure evidence.

### Phase 5. Проверить новый runtime

Проверка выполняется в новой задаче после установки, а не в текущем чате:

1. `plugin list` показывает intended version как installed/enabled.
2. `mcp list` показывает exact URL, OAuth и отсутствие duplicate Mind Diary
   server.
3. Model-visible provenance больше не указывает на legacy
   `asdk_app_exampleb0edf6845c052387` или `Mind Diary UAT final`.
   Конкретное новое namespace выбирает host; проверяется источник, а не
   придуманная строка namespace.
4. Доступны ровно 12 canonical tools:
   `list_minds`, `resolve_mind`, `get_mind_info`, `browse_entries`, `search`,
   `fetch`, `list_revisions`, `get_revision`, `validate_mind`,
   `commit_changeset`, `start_export`, `get_export_status`.
5. Их descriptions, schemas и annotations совпадают с current
   `MCP_TOOL_DEFINITIONS`.
6. Read-only `list_minds` проходит с текущим principal.
7. `commit_changeset` не вызывается: наличие write tool проверяется через
   catalog, а не тестовой записью в пользовательский Mind.
8. После второго cold restart и ещё одной fresh task те же проверки повторно
   проходят без возврата legacy registration.

Только после этого connector считается обновлённым. Успешный `plugin add`,
совпавшие cache files или работающий старый `list_minds` по отдельности
недостаточны.

### Phase 6. Закрыть evidence и follow-up

Сохранить без credentials и private content:

- observed time, Codex version и fresh task/thread reference;
- MindDiary SHA, Marketplace revision и plugin version;
- pre/post connector provenance;
- source/cache hashes;
- exact MCP URL и auth state;
- tool count/catalog hash;
- `list_minds` success;
- cold-restart persistence result;
- любое unavailable evidence.

Если replacement подтвердит Codex defect, отдельно подготовить минимальный
reproduction для OpenAI: старая manifest topology, новая direct MCP topology,
ожидаемый replacement, фактическое сохранение legacy app ID и результат
remove/add. Не включать OAuth tokens, Mind descriptors или private tool
responses.

## Acceptance criteria

- [ ] Pre-state и exact targets зафиксированы до удаления.
- [ ] Direct MCP automated gate проходит на exact candidate.
- [ ] Marketplace snapshot обновлён до intended remote revision.
- [ ] Legacy registered app/link отсутствует в fresh installed/callable state.
- [ ] `mind-diary@srez-marketplace` установлен с intended immutable version и
      `ON_USE`.
- [ ] Installed tree совпадает с Marketplace source.
- [ ] Есть ровно один Mind Diary MCP source на exact UAT `/api/mcp`.
- [ ] Fresh runtime не ссылается на старый connector ID/name.
- [ ] Все 12 tools и их schemas совпадают с repository contract.
- [ ] Read-only OAuth `list_minds` проходит.
- [ ] Cold restart и вторая fresh task не возвращают legacy snapshot.
- [ ] Task Manager и другие plugins не изменились.
- [ ] Не было content writes, product deploy, cache surgery или secret access.

## Recovery

Если remove завершился, а reinstall или OAuth не прошли:

1. Не трогать product data и не запускать write smoke.
2. Повторно проверить Marketplace snapshot и exact package version.
3. Один раз повторить штатный `codex plugin add` для того же immutable package,
   затем открыть fresh task.
4. Если direct OAuth остаётся недоступен, зафиксировать blocker и сохранить
   plugin отключённым либо установленным, но не верифицированным — согласно
   фактическому состоянию.
5. Не восстанавливать `.app.json` и private registered connector автоматически.
   Такой rollback меняет accepted distribution boundary и требует отдельного
   решения пользователя.

Удаление connector может отозвать только относящийся к нему client grant; оно
не должно вызывать account/Mind deletion. После восстановления доступа
проверяется тот же principal и read-only видимость Minds, а не содержимое
через массовый export.

## Как обновлять plugin дальше

| Тип изменения | Обязательная процедура |
| --- | --- |
| Только server implementation, без изменения tool contract | deploy evidence + fresh tool/read smoke; package reinstall не предполагается автоматически |
| Tool descriptions/schemas/annotations | server release + fresh model-visible catalog comparison; при stale catalog — cold restart и replacement установки |
| `SKILL.md`, assets, manifest, `.mcp.json`, auth/install policy | immutable version/cachebuster → push Marketplace → marketplace upgrade → remove/add plugin → fresh task verification |
| Registered app ↔ direct MCP, смена endpoint/resource или OAuth topology | всегда clean replacement с pre-state, explicit removal, reconnect и cold-start acceptance; in-place update не считается достаточным |

Для будущего release gate стоит добавить fail-closed assertion: package/source
equality должна соединяться с model-visible connector provenance. Известный
legacy connector ID и отсутствие package/direct attribution должны делать
canary failed даже тогда, когда remote tools функционально актуальны.

## Открытые вопросы execution

- Удаляет ли текущий `codex plugin remove` связанный remote app/link или только
  local package state?
- Требуется ли отдельный revoke старого Mind Diary OAuth grant после удаления
  app-link?
- Какой stable public app-server field лучше использовать вместо
  version-specific app-tools cache для connector provenance?
- Нужно ли заводить upstream Codex bug после воспроизведения на clean
  remove/add cycle?
- Достаточно ли current plugin version для repair, или host deduplication
  потребует нового cachebuster даже при неизменном payload?

Эти вопросы разрешаются read-only preflight либо в ходе отдельно
авторизованного execution. Они не являются основанием сейчас удалять или
пересоздавать connector.
