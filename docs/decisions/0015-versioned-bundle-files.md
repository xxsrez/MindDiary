# ADR-0015: versioned BundleFile и separate mixed export profile

Статус: accepted, 2026-08-22. Решение расширяет Release 0.1 после исходного
Markdown-only MVP и не меняет нормативный смысл OKF 0.2.

## Контекст

Mutable attachment рядом с revision нарушил бы exact historical read, HEAD
CAS, deletion semantics и portable export. Одновременно провайдерский file ID
или temporary URL не может быть domain identity, а silent extension
`MD-OKF-ZIP-1` сломала бы его byte-for-byte compatibility.

## Решение

- `BundleFile` — producer-defined opaque file Mind Diary, не OKF entity.
- Unified revision manifest v2 различает `markdown | opaque`; committed v1
  manifests остаются immutable и читаются как Markdown-only.
- Native file transport заканчивается в MCP adapter. Application receives only
  verified bytes/metadata and exact binding context; stage ref is portable and
  provider-neutral.
- Staging is quarantined, bounded, idempotent and pinned to exact write binding.
  Only successful atomic changeset consumes it and creates one revision.
- First slice allowlists PNG/JPEG/GIF/WebP, PDF and ZIP; everything else is
  denied. PDF/ZIP are attachment-only, ZIP is never extracted, no antivirus
  cleanliness is claimed.
- Historical read/download uses exact revision and fresh current access.
- Existing `fetch`/Resources stay Markdown-only and binary never enters JSON-RPC
  or model context automatically.
- `MD-OKF-ZIP-1` is unchanged. Mixed revisions require explicit deterministic
  `MD-BUNDLE-ZIP-1` with exact bytes and producer manifest.
- Exact limits, errors, lifecycle and evidence are normative in the
  [BundleFile specification](../specs/bundle-files.md).

## Последствия

- A Markdown link and its opaque target can be added/replaced/deleted in one
  immutable revision under existing ACL, idempotency and HEAD CAS.
- Current UAT stays Sites/R2; domain and application ports do not import Sites,
  OpenAI or AWS identities.
- Native-file client compatibility becomes an explicit per-profile UAT gate.
  Missing capability is a truthful blocker, not a base64/local-path fallback.
- Quotas count exact logical/reachable bytes and may require a later capacity
  tier; Release 0.1 values are deliberately bounded.

## Отклонённые варианты

- **Mutable attachment table outside revision.** Historical bytes and atomicity
  would be false.
- **Embed base64 in Markdown/JSON-RPC.** Inflates model context and bypasses
  streaming limits.
- **Persist OpenAI file IDs/URLs.** Couples canonical state to expiring provider
  transport and leaks bearer material.
- **Extend `MD-OKF-ZIP-1` in place.** Breaks deterministic compatibility and may
  silently change existing consumers.
- **Accept every opaque type and rely on Content-Disposition.** Too broad
  without malware/CDR and renderer evidence.
- **Treat ZIP as import.** Extraction/path traversal/bomb semantics require a
  separate import contract.
