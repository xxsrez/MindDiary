# ADR-0021: format-neutral BundleFile и безопасное serving

Статус: accepted, 2026-08-25. Решение MD-303 заменяет closed MIME admission и
64 MiB limit в [ADR-0015](0015-versioned-bundle-files.md), а также соответствующую
static-policy часть [ADR-0018](0018-file-ingress-contract-and-source-capability-matrix.md).
Immutable revision, staged-ref, exact-byte, authorization, source-boundary,
atomic commit и deterministic export invariants этих ADR сохраняются. Текущий
repository runtime всё ещё реализует legacy bounded baseline; MD-304 владеет
v4/runtime migration и не считается выполненной этим ADR.

## Контекст

Реальный Brain содержит DOC/DOCX, HEIC, EPUB, OPUS, HTML, CSV/TSV, JSON, Python,
notebooks, ZIP и неизвестные payloads. Closed raster/PDF/ZIP allowlist связывает
каноническое хранение с возможностями preview и не позволяет Mind Diary быть
byte-preserving destination. Наибольший измеренный файл в исходном Brain —
146,215,108 bytes; прежние 64 MiB и 128 MiB per-changeset cap не допускают его.

MIME, extension и renderer support не являются достаточной identity или
security boundary. Безопасность должна обеспечиваться exact size/digest,
streaming, path policy, quarantine, authorization и attachment-only serving, а
не потерей неизвестных форматов.

## Решение

1. `BundleFile` остаётся producer-defined `kind: opaque`, не OKF entity и не
   `KnowledgeEntry`. Любой явно выбранный regular non-Markdown file допускается
   после path, authorization, quota, streaming-integrity и staging checks.
2. Новые commits после MD-304 используют explicit
   `mind-diary-revision-manifest-v4`. V4 сохраняет v3 Space-scoped manifest
   storage, `path + kind + sha256 + size + media_type` и deterministic ordering,
   но делает `media_type` открытой advisory string.
3. Header-safe canonical media type — lowercase ASCII MIME essence
   `type/subtype`: exactly one slash, nonempty sides made only of letters,
   digits and RFC `tchar` punctuation, максимум 127 bytes. Parameters are
   parsed away; whitespace, controls and other response-header syntax are not
   stored. Missing, unknown, invalid или conflicting evidence даёт
   `application/octet-stream`. Declared MIME/extension never override exact
   bytes and never block storage.
4. V1 remains Markdown-only with implicit `kind: markdown`; v2/v3 retain their
   historical closed-media meaning. Old manifest bytes/hashes are never
   rewritten or re-sniffed. The first ordinary child commit may materialize v4;
   unknown future manifest format fails closed rather than being guessed.
5. One file is accepted up to and including 268,435,456 bytes (256 MiB); byte
   268,435,457 fails. Staged bytes referenced by one changeset are raised from
   128 MiB to 256 MiB so one maximum-size file is representable. Outstanding
   verified bytes per binding owner remain 256 MiB; TTL is 60 minutes; orphan
   safety window is 24 hours; one GC pass remains at most 100 objects / 256 MiB.
6. Upload, hashing, quarantine write, canonical promotion, historical download
   and export use bounded chunks. No layer may require a full-file buffer,
   concatenate all chunks or retain memory proportional to file size.
7. Storage admission and serving are independent. Only PNG/JPEG/GIF/WebP may
   become inline after fresh safe-raster verification. SVG, HTML, JavaScript,
   executables, archives, Office, audio/video, HEIC and octet-stream remain
   attachment/download-only with `nosniff`, private `no-store`, exact length,
   digest ETag and safe `Content-Disposition`; nothing is executed or extracted.
8. Markdown remains the only indexed/fetched knowledge content. Unknown OKF
   types and producer fields remain exact Markdown bytes. Provider IDs, local
   paths, temporary URLs and source credentials never enter manifest/domain
   identity.

## Последствия

- DOCX, HEIC, EPUB, OPUS, HTML, notebooks, ZIP and unknown binary can survive
  stage → revision → history → download/export even when media detection returns
  only `application/octet-stream`.
- A MIME mismatch becomes a quality diagnostic/fallback, not
  `unsupported_bundle_file_type`. That error remains only for reconciliation
  with legacy pre-v4 candidates and cannot be emitted solely for an unknown v4
  format.
- Safe inline preview is least privilege and may degrade to download without
  changing canonical bytes. Format-neutral storage does not claim malware/CDR
  cleanliness or renderer support.
- Existing 1 GiB resulting-revision and 2 GiB retained-Space limits remain;
  larger quotas or resumable uploads need a later accepted decision.
- MD-306 can move typed OKF Markdown plus individually selected linked regular
  files by ordinary changesets. This decision does not add an OKF `Asset`, a
  directory/glob/batch/archive importer or whole-Brain transaction.

## Отклонённые варианты

- **Keep the closed MIME allowlist.** It confuses preview support with canonical
  persistence and loses unknown producer files.
- **Trust client MIME or extension.** It permits header/renderer confusion and
  makes transport metadata authority.
- **Inline every stored type.** `Content-Disposition` alone is not sufficient
  to render active or complex formats safely.
- **Encode unknown files as base64 Markdown.** It breaks exact-byte streaming,
  inflates context and bypasses object/quota boundaries.
- **Reuse manifest v3 with new semantics.** Historical readers would silently
  reinterpret the same version; explicit v4 keeps compatibility deterministic.
- **Introduce an OKF Asset type or bulk importer here.** OKF 0.2 does not define
  it, and incremental migration/import semantics belong to MD-306 and separate
  import contracts.
