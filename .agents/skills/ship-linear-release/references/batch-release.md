# Batch и UAT

Загружай перед первым batch cut и после изменения release surface.

## Boundary

Batch — связанный проверяемый product increment, а не число workers или
таймер. Закрой batch при одном из событий:

- готова связанная vertical slice;
- urgent fix должен быстро попасть в UAT;
- ready frontier исчерпан;
- накопился заметный набор небольших изменений;
- следующая задача существенно увеличивает risk surface.

Boundary не означает, что batch существует. До gate сначала проверь
current-run eligibility: есть хотя бы одна feature с подтверждённой цепочкой
`claim -> feature-ready -> integrate -> task-done` либо resolved forward-fix
уже зарегистрированного prerelease/UAT defect. Исторические Done, пустой ready
frontier, новый invocation и изменение самого release tooling не проходят эту
проверку. При пустом milestone верни `no-work` без gate, dev, CI и UAT.

## Gate

Для MindDiary exact candidate выполняй установленный `AGENTS.md` contract:

```bash
npm ci
npm run check
git diff --check '<previous-candidate>..<candidate>'
```

Не повторяй subcommands, уже входящие в aggregate. Local gate не является UAT
evidence. Не запускай aggregate «на всякий случай»: сначала должен существовать
eligible current-run batch.

## UAT

UAT release разрешён и является default cadence skill. Deployment и smoke
должны относиться к exact candidate SHA. В journal сохраняй только bounded
references: deployment ID/URL, observed SHA, result и timestamp; не сохраняй
tokens, cookies, private content или response bodies.

После canonical gate и до упаковки обязательно выполни profile-declared build
deployment surface из exact candidate. Для текущего MindDiary profile это:

```bash
npm --prefix apps/mind-diary-site run build
```

Проверь profile-declared deployable entrypoints в свежем `dist`, затем упакуй
именно этот output. Прохождение root aggregate само по себе не доказывает, что
Sites `dist` был пересобран. Не сохраняй version из ранее существовавшего
deployment output.

Saved Sites version для candidate SHA immutable. Если по этому SHA уже
сохранена version из stale либо неверного output, не пытайся заменить её новым
archive и не deploy-и её. Немедленно отметь batch failed, открой repair-first
flow и выпусти исправленную сборку под новым forward-fix candidate SHA.

Передавай в journal только HTTPS live URL без userinfo, query и fragment.
Ссылки с credentials или signed query helper отклоняет: сохраняй отдельный
нечувствительный canonical URL и redacted deployment ID.

Failed smoke оставляет batch failed и открывает repair-first flow. Не откатывай
UAT: следующий valid fix становится новым candidate и новым batch.

## Production

Production отсутствует в skill. Не интерпретируй `release`, `ship` или
milestone completion как production authorization. Даже passing UAT требует
отдельного ручного production workflow и явного запроса пользователя.
