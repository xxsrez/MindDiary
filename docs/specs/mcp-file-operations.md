# Универсальные файловые операции Content MCP

Статус: accepted, 2026-09-08. Нормативный контракт MD-409 для реализации
MD-414–MD-418.

## Причинный вывод

Эквивалентность локальным файловым инструментам достигается не расширением
существующего semantic `search`, а тремя отдельными детерминированными
read-only tools:

```text
list_files -> grep_files -> read_files
```

Они выполняют явно заданные операции над manifest одного разрешённого Mind и
одной immutable revision. Агент интерпретирует вопрос, выбирает patterns,
фильтры и следующий вызов; сервер не добавляет synonyms, stemming, исправление
опечаток, language analysis, entity resolution или ranking. Existing
`browse_entries`, `search` и `fetch` сохраняют прежнюю семантику и wire shape.

## Общая модель

Каждый вызов, кроме продолжения по opaque cursor, принимает обязательный
`mind` и optional `revision_selector`. Отсутствующий selector означает HEAD,
который один раз разрешается в `resolved_revision_id` до чтения. Cursor
конфиденциально фиксирует operation, нормализованный request, `space_id`,
`revision_id`, manifest hash и позицию; изменение аргументов, ACL, usage mode,
manifest либо target делает cursor недействительным. Historical operation
никогда не переходит на HEAD.

Порядок path — сравнение Unicode scalar values без locale, normalization или
case folding. Canonical manifest уже требует NFC и уникальный relative path.
В нём нет ambient filesystem, `.gitignore` или OS hidden-bit, поэтому tools
просматривают все manifest entries. Исключения задаются только exact paths,
`prefix`, `recursive`, `include_globs` и `exclude_globs`. Local differential
baseline использует `rg --hidden --no-ignore`.

Path glob subset:

- `/` — separator;
- `*` — zero or more non-`/` scalar values;
- `?` — exactly one non-`/` scalar value;
- `**` — zero or more scalar values including `/`;
- backslash, character classes, braces, extglobs and negated patterns are not
  supported; exclusion is an explicit `exclude_globs` array;
- at most 32 include and 32 exclude globs, each at most 256 characters.

## Текстовый профиль

Markdown всегда text и ограничен существующим 1 MiB/file contract. Opaque
BundleFile читается как text только при manifest `media_type`:

```text
text/*
application/json
application/yaml
application/x-yaml
application/xml
application/*+json
application/*+xml
```

Файл должен быть valid UTF-8 и иметь размер не больше 4 MiB для одной file
operation. MIME остаётся advisory admission metadata, но здесь служит explicit
consumer selection; `application/octet-stream` не sniff-ится как text. Binary,
unsupported media, invalid UTF-8 и oversized text возвращаются отдельным
per-item status и не попадают в model context. Файл не исполняется, не
распаковывается, не транскрибируется и не преобразуется.

Line splitting распознаёт `LF`, `CRLF` и последний line без terminator.
Returned `text` сохраняет исходные bytes и line endings внутри выбранного
range. Line numbers — 1-based. Byte ranges используют 0-based inclusive start
и exclusive end; обе границы обязаны совпадать с UTF-8 scalar boundaries.

## `list_files`

Назначение: эквивалент `rg --files`/bounded `ls` плюс детерминированная
manifest/metadata selection без чтения body, если metadata не запрошены.

Основные inputs:

- `mind`, `revision_selector`;
- optional `paths`, `prefix`, `recursive`, `include_globs`, `exclude_globs`;
- optional `kinds: markdown | opaque`, `media_types`;
- optional `where`, `select_metadata_fields`, `sort`;
- optional `aggregate: count | distinct`, `cursor`, `limit`,
  `max_output_bytes`.

Manifest fields: `path`, `kind`, `media_type`, `size`, `sha256`,
`revision_id`, `revision_committed_at`. `metadata.<dot.path>` обращается только
к explicit structured metadata:

- Markdown — parsed YAML frontmatter;
- JSON/YAML text BundleFile — top-level parsed value;
- другое содержимое получает `metadata_status=unsupported`;
- invalid document получает `metadata_status=invalid`, а не empty metadata.

Structured file больше 4 MiB не парсится и получает
`metadata_status=unsupported`; такой entry не удерживает cursor на месте.

Filter leaves: `exists`, `eq`, `in`, `lt`, `lte`, `gt`, `gte`; boolean nodes:
`all` и `any`. Maximum depth 4, maximum 16 leaves. Equality is exact JSON
value equality; string comparison is scalar-order and case-sensitive. Range
requires two values of the same scalar type. Missing differs from explicit
`null`.

Default sort is `path asc`. At most three sort keys may use manifest or
selected metadata fields; `path asc` is the final tie-breaker. `count` returns
the count for the scanned bounded page. `distinct` accepts one scalar field,
deduplicates exact values and sorts them deterministically. `incomplete=true`
and `next_cursor` mean that the aggregate is partial and the caller must
continue and combine pages.

## `grep_files`

Назначение: predictable `rg`-like content matching over the selected text
files. Inputs reuse the path/kind/media selection above and add:

- `patterns`: 1–8 patterns, at most 256 characters each, OR semantics;
- `syntax: literal | regex`;
- `case_sensitive`, `whole_word`, `whole_line`;
- `output: matches | files_with_matches | files_without_match | count`;
- `count_unit: matching_lines | occurrences`;
- `before_context`, `after_context`: 0–3;
- `cursor`, `limit`, `max_output_bytes`.

`literal` matches exact Unicode scalar sequences; optional case-insensitive
matching uses RE2 Unicode simple case folding
without normalization. `whole_word` defines word as `Unicode Letter | Number |
Mark | Connector_Punctuation`; it is not language morphology.

Regex is the single-line RE2 common subset shared with pinned ripgrep fixtures:
literals, escapes, `.`, character classes, `^`, `$`, capturing groups,
alternation and bounded/unbounded quantifiers. The linear-time RE2JS engine is
the execution boundary. Lookaround, backreferences, named/noncapturing groups,
inline flags, backtracking control and `\\C` are rejected as
`unsupported_pattern`. Multiline and dot-all are unsupported.
Zero-length matches are allowed but count at most once per scalar boundary.

`matches` returns one result per matching line with all non-overlapping spans,
1-based line number, 0-based UTF-8 byte start/end for the line, exact line text
without its terminator and bounded before/after context. A line appears once
even when several patterns match it. Context can overlap across neighboring
results and is not counted as a match. `matching_lines` counts result lines;
`occurrences` counts all spans. File-only modes deduplicate by path.
Every file result returns both counters plus `count`, whose value is selected
by `count_unit`; the response repeats the effective `count_unit` so pagination
and aggregation remain auditable.

Response budget учитывает text совпадения и возвращённый before/after context.
Если одна строка вместе с context не помещается даже в пустой response с
заданным `max_output_bytes`, call завершается явным
`file_operation_budget_exhausted`; cursor с неизменной позицией не выдаётся.

## `read_files`

Назначение: exact `cat`/`head`/`tail`/line-range/byte-range read for 1–32 exact
paths. Each item is one of:

```text
{ path, mode: whole }
{ path, mode: head | tail, count }
{ path, mode: lines, start_line, end_line }
{ path, mode: bytes, start_byte, end_byte }
```

Line end is inclusive; byte end is exclusive. Out-of-range line/byte
coordinates return a per-item `range_out_of_bounds` without changing other
items. An empty file can be read whole but has no valid line or nonempty byte
range. Output includes path, kind, media type, SHA-256, exact revision, selected
line/byte range, original `text`, `truncated` and a resumable next range when
the total response budget ends. Ordering equals request ordering; duplicate
paths are allowed only when their range requests differ.

`head` reads the object-store stream only through the requested line boundary
and then cancels it, so the tail is not required. Because discovering the total
line count would itself require that tail, `line_range.total` is `null` for a
partial `head`; it is exact when the read reaches EOF. Other modes return an
exact total.

## Budgets, partial results и ошибки

Server constants:

| Boundary | Value |
|---|---:|
| manifest entries per revision | existing 10,000 |
| one text BundleFile scan/read | 4 MiB |
| bytes scanned per `grep_files` page | 16 MiB |
| bytes parsed for `list_files` metadata per page | 4 MiB |
| paths in one exact selector | 100 |
| read requests per `read_files` call | 32 |
| returned rows per page | default 20, max 100 |
| returned text/structured payload budget | default 64 KiB, max 1 MiB |
| wall-clock application budget | 15 s |

The service checks an `AbortSignal` between files and lines. A reached scan,
time, row or response boundary returns `incomplete=true`, the exact reason and
`next_cursor` where continuation is safe. It never turns partial into empty or
successfully complete. Unsupported text file and per-path failures remain in
`items[].error`; target-level invalid request, authorization, revision
integrity and cursor failure remain tool errors.

Deadline имеет `incomplete_reason=time_budget`, если уже существует безопасная
позиция продолжения. Abort входящего MCP request и deadline во время зависшего
object stream отменяют reader и возвращают retryable
`file_operation_budget_exhausted`, не удерживая Worker.

Canonical safe codes added by this contract:

```text
invalid_file_operation
invalid_glob
invalid_metadata_filter
invalid_sort
unsupported_pattern
file_not_found
file_not_text
unsupported_text_encoding
file_scan_limit_exceeded
range_out_of_bounds
utf8_boundary_required
file_operation_cursor_invalid
file_operation_budget_exhausted
```

## Authorization и privacy

Каждый call требует `content:read`, enabled `read | read_write` usage and
current membership or visibility grant before manifest/object read. The same
authorization stamp is rechecked after materialization and before returning a
page. Private denial is indistinguishable from missing Mind. Cursor and
returned file reference are locators, not capabilities.

Logs, telemetry, UAT evidence and Task Manager comments never contain query
patterns, paths, metadata values, text, locators, tokens or object keys.
Allowed metrics are operation, outcome, duration, scanned file/byte counts,
returned row/byte counts and bounded reason.

## Compatibility и composition

Modern and compatibility direct profiles advertise all three tools with the
same schemas. MCP Apps adds its existing picker/stage projection but does not
change file-read semantics. Plugin guidance uses:

1. `list_minds` and one explicit Mind;
2. `list_files` to narrow paths/metadata;
3. `grep_files` with those exact paths;
4. `read_files` for selected ranges;
5. existing `commit_changeset` only when separately authorized.

No arbitrary pipeline language, shell, SQL or server-side code execution is
introduced. Client composition is explicit structured data between calls.

## Проверка

Synthetic corpus includes Markdown frontmatter, JSON, YAML, plain text, code,
logs, empty files, Unicode and special path characters, LF/CRLF, a long line,
invalid UTF-8, unsupported binary and a text file above the operation limit.
Differential runner executes the common subset against pinned
`ripgrep 15.2.0` plus byte/line reference readers and the MCP application over
the same immutable bytes. It compares exact ordered paths, match lines/spans,
counts and selected bytes, then exercises pagination, revoke, exact historical
revision, invalid cursor, limits and cleanup.

UAT acceptance additionally binds exact Git SHA, Sites version/deployment,
modern/compat catalogs and a fresh installed plugin journey. It records only
hashes, counts, timings (`p50`/`p95`), I/O and response sizes; synthetic corpus
bytes and paths stay out of durable evidence.
