# Mind Diary product Site

Deployable OpenAI Sites application for the Mind Diary MVP. The Site owns its
hosting manifest, Vinext Worker entry, D1/R2 bindings, migrations and runtime
configuration contract. It is distinct from `apps/sites-probe`.

The tracked hosting manifest is a public example. For the owner's configured
UAT, run `npm run private:setup` and `npm run site:build:uat` at repository root.
These commands read workspace-local `.private/config`, excluded from Git; the real target is
written only to ignored build output. See the
[private configuration guide](../../docs/operations/public-repository-preparation.md#приватные-настройки-после-переезда).

Run `npm ci` at the repository root and in this directory, then run
`npm test` here. The command builds the deployable Vinext artifact, rebuilds
the shared TypeScript packages, runs the focused product Site runtime tests and
checks the packaged Sites metadata. Deployment secrets listed in `.env.example`
must be supplied by Sites runtime settings; they are never stored in hosting
metadata.

The accepted release profile launches isolated local dev from the repository
root with `npm run dev`. That wrapper delegates to this package, waits for the
actual loopback URL to answer, and emits one non-secret machine-readable
`ship-work-release/dev-ready/v1` event for release evidence and cleanup.
