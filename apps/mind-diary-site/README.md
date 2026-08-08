# Mind Diary product Site

Deployable OpenAI Sites application for the Mind Diary MVP. The Site owns its
hosting manifest, Vinext Worker entry, D1/R2 bindings, migrations and runtime
configuration contract. It is distinct from `apps/sites-probe`.

Run the repository build first, then from this directory run `npm ci` and
`npm run build`. Deployment secrets listed in `.env.example` must be supplied
by Sites runtime settings; they are never stored in hosting metadata.
