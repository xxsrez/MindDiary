---
name: mind-diary
description: Optional advanced guidance for Mind Diary. Use the portable reference or the bundled macOS exact-file companion when available. The skill is not required for basic MCP use.
---

# Mind Diary

Mind Diary's hosted MCP tools are self-describing and authoritative. Basic
discovery, bounded reads, exact-revision file operations, history, validation,
commit and reconciliation must work without this skill. Do not ask
the user to install a skill before an ordinary content call.

## Portable service guidance

Read [service guidance](references/service-guidance.md) for the complete
portable workflow: Mind selection, source-grounded reads, OKF file operations,
validation, commit, incremental typed transfer and recovery. Check the connected
server's catalog before using optional tools; this local reference may differ
from the server's current guidance.

When the connected server publishes `get_mind_diary_guidance`, call it once per
server guidance version when no skill is available or when the current service
rules are needed. A version or SHA-256 mismatch means the installed plugin is
stale; follow the current server guide for hosted operations and do not combine
the two texts.

## Optional host-specific companion

For one explicitly selected local regular file or a verified BundleFile
download, read [local companion](references/local-companion.md) only when the
current host actually exposes `prepare_local_file`, `upload_prepared_file` or
`download_bundle_file`. These tools are a Codex/macOS extension. They are not a
portable or required Mind Diary capability, and their absence does not shorten
or replace the portable service guidance.

If hosted tools are unavailable, use the host's native Mind Diary
connection/authentication flow. Never ask for a personal token or MCP URL as a
fallback. If an optional local tool is absent, report that the local transfer
is unavailable on this host; do not replace it with base64, a raw local path in
a hosted call, an arbitrary URL or a shell upload.
