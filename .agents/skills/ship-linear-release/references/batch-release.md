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

## Gate

Для MindDiary exact candidate выполняй установленный `AGENTS.md` contract:

```bash
npm ci
npm run check
git diff --check '<previous-candidate>..<candidate>'
```

Не повторяй subcommands, уже входящие в aggregate. Local gate не является UAT
evidence.

## UAT

UAT release разрешён и является default cadence skill. Deployment и smoke
должны относиться к exact candidate SHA. В journal сохраняй только bounded
references: deployment ID/URL, observed SHA, result и timestamp; не сохраняй
tokens, cookies, private content или response bodies.

Failed smoke оставляет batch failed и открывает repair-first flow. Не откатывай
UAT: следующий valid fix становится новым candidate и новым batch.

## Production

Production отсутствует в skill. Не интерпретируй `release`, `ship` или
milestone completion как production authorization. Даже passing UAT требует
отдельного ручного production workflow и явного запроса пользователя.
