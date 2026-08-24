# ADR-0018: единый file-ingress contract и source capability matrix

Статус: accepted technical contract, 2026-08-23. Portable boundary и security
invariants сохраняются, но включение universal file ingress в terminal Release
0.1 частично заменено
[ADR-0019](0019-release-0-1-codex-first-small-data-boundary.md): capability
относится к post-MVP и не блокирует Markdown-first 0.1. Это contract decision
MD-271; implementation/evidence каждой source capability остаются отдельными
claims и child tasks.

## Контекст

ADR-0015 принял `BundleFile` и adapter-only OpenAI native ingress. Этот
baseline уже даёт один безопасный путь `stage_bundle_file`, но не задаёт
portable boundary для local disk, workspace/generated artifacts, authorized
connector objects, bounded in-memory bytes или server-generated output. Без
единого решения следующие adapters могли бы протащить provider ID/URL,
absolute path или raw bytes в domain identity, либо незаметно заменить
неподдержанный native input base64/arbitrary URL transport.

MD-271 требует свести шесть source kinds к одной модели и сохранить совместную
revision/atomicity с уже принятыми Markdown и BundleFile operations. При этом
документ не должен превращать local companion или native client capability в
проверенную реализацию без exact evidence.

## Решение

1. Portable application принимает только adapter-produced
   `VerifiedFileInput` с closed `source_kind`, exact bytes, safe display
   filename, detected media type, size и SHA-256. Provider identifiers,
   temporary URLs, absolute paths, workspace paths, connector credentials and
   raw request bodies terminate before the application port.
2. Staging использует service-owned `staged_file_ref`, pinned to
   `binding_owner_id + space_id + write_binding_id`. Record stores safe
   `source_kind`, exact integrity/quota metadata and lifecycle state, but never
   source locator or secret. Canonical identity remains `revision_id + path`.
3. The source capability matrix in
   [file-ingress specification](../specs/file-ingress.md) is normative for
   source classes, limits, TTLs, verification ownership, typed errors,
   fallback prohibition and implementation/evidence status.
4. Existing `session_attachment`, `bounded_in_memory` and `server_generated`
   have local source profiles, while MD-272 supplies a repository-local
   companion for `local_path` and `workspace/generated_artifact`. Both MCP
   profiles may advertise the native `file` parameter only when their pinned
   client/profile capability is proven. Missing native support returns
   `native_file_input_unsupported`; there is no silent base64, local-path or
   arbitrary-URL fallback.
5. Local adapters prove only their bounded repository behavior. Hosted upload
   intent, provider-native capability, hosted producer wiring and UAT remain
   separate evidence; `connector_object` remains an accepted contract slot,
   not a shipped capability, until its adapter and exact evidence exist.
6. One staged ref belongs to one BundleFile target path in one changeset. A
   changeset may contain multiple refs and Markdown operations, but successful
   commit consumes all refs in one existing HEAD-CAS transaction. Unknown
   stage/commit outcomes replay the exact key/payload; changed payloads produce
   idempotency conflict; stale/failing commits never publish a partial revision.
7. The existing BundleFile allowlist, path policy, quotas, historical bytes,
   Markdown-only import profile and deterministic export profiles remain
   unchanged. This ADR does not add archive import, generic binary formats,
   browser raw-content endpoints or production malware-cleanliness claims.

## Consequences

- Future source adapters can share staging, authorization, quota, integrity,
  audit and commit semantics without making source locators portable.
- Capability negotiation is explicit: a client either supplies the required
  native file/intent/inline profile or receives a typed unavailable result.
- The current candidate can claim local `session_attachment`, bounded-inline
  and server-generated writer code/tests plus MD-272's local companion code;
  MD-250 is still required before claiming exact native client/profile UAT,
  hosted upload-intent/producer use remains unproven, and MD-274 owns the
  mixed-source coordinator. Эти rows не являются terminal prerequisites 0.1.
- Local snapshots may hash before network I/O for user feedback, but the
  application recomputes digest/size/MIME; client declarations never become
  authority. Provider and local path secrecy remains an adapter invariant.
- Multi-source commits retain one immutable revision and one HEAD transition,
  while shared digest/quota semantics continue to be governed by the lower
  applicable BundleFile/Mind/principal/Site limits.

## Отклонённые варианты

- **Put provider IDs or URLs in `BundleFile`/domain records.** This leaks
  transport identity, prevents provider migration and makes durable state
  depend on short-lived capabilities.
- **Pass absolute local/workspace paths through MCP.** A hosted service cannot
  read a caller's disk safely, and path disclosure violates the portable
  boundary; a separately authorized companion is required.
- **Use base64 or arbitrary remote URLs as universal fallback.** This bypasses
  host capability negotiation, creates unbounded memory/SSRF risk and changes
  the native client contract silently.
- **Commit one source at a time.** It exposes partial revisions and breaks the
  existing atomic Markdown+BundleFile changeset semantics.
- **Treat source kind as authorization identity.** Authorization remains
  principal/binding/Space/ACL based; provenance class cannot grant access.
