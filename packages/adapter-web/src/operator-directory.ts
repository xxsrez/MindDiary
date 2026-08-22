function escapeText(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timestamp(value: unknown, now: number): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return '<span class="md-caveat">Never</span>';
  }
  const elapsed = Math.max(0, now - Date.parse(value));
  const relative = elapsed < 60_000
    ? "less than a minute ago"
    : elapsed < 3_600_000
      ? `${Math.floor(elapsed / 60_000)}m ago`
      : elapsed < 86_400_000
        ? `${Math.floor(elapsed / 3_600_000)}h ago`
        : `${Math.floor(elapsed / 86_400_000)}d ago`;
  return `<time datetime="${escapeText(value)}" title="${escapeText(value)}">${escapeText(value)} UTC · ${escapeText(relative)}</time>`;
}

export function renderServiceOperatorDirectoryDocument(input: {
  readonly displayName: string;
  readonly page: unknown;
  readonly query?: Readonly<Record<string, string>>;
  readonly now?: number;
}): string {
  const page = record(input.page);
  if (page === null || !Array.isArray(page.principals)) {
    throw new TypeError("Service operator directory projection is unavailable");
  }
  const now = input.now ?? Date.now();
  const rows = page.principals.map((value) => {
    const principal = record(value);
    const activity = record(principal?.activity);
    if (
      principal === null ||
      typeof principal.principalId !== "string" ||
      typeof principal.displayName !== "string" ||
      typeof principal.verifiedEmail !== "string" ||
      typeof principal.registeredAt !== "string"
    ) throw new TypeError("Service operator principal projection is invalid");
    return `<tr>
      <td><strong>${escapeText(principal.displayName)}</strong><br><code>${escapeText(principal.principalId)}</code></td>
      <td>${escapeText(principal.verifiedEmail)}<br>${escapeText(principal.state)}</td>
      <td>${timestamp(principal.registeredAt, now)}</td>
      <td>${timestamp(activity?.lastWebSeenAt, now)}</td>
      <td>${timestamp(activity?.lastMcpSeenAt, now)}</td>
      <td>${escapeText(activity?.lastActivitySurface ?? "Never")} / ${escapeText(activity?.lastActivityKind ?? "Never")}</td>
      <td>${escapeText(principal.ownedMindCount ?? 0)} owned · ${escapeText(principal.participatingMindCount ?? 0)} participating · ${escapeText(principal.activeMcpCredentialCount ?? 0)} MCP</td>
    </tr>`;
  }).join("");
  const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (key !== "cursor") nextParams.set(key, value);
  }
  if (nextCursor !== null) nextParams.set("cursor", nextCursor);
  const nextLink = nextCursor === null
    ? ""
    : `<p><a class="md-button" href="/internal/operators/users?${escapeText(nextParams.toString())}">Next page</a></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UAT users · Mind Diary</title><link rel="stylesheet" href="/brand/mind-diary-tokens.css"><link rel="stylesheet" href="/ui/mind-diary-shell.css"></head>
<body><main class="md-main"><section class="md-hero"><p class="md-eyebrow">Internal · read only</p><h1>UAT users</h1><p>Signed in as ${escapeText(input.displayName)}. Last seen means a successful Mind Diary request, not online presence.</p></section>
<section class="md-card"><form method="get" class="md-token-grid">
<label>Exact email or display name <input name="query" maxlength="320"></label>
<label>Account state <select name="state"><option value="">Any</option><option value="active">Active</option><option value="deleted">Deleted</option></select></label>
<label>Registered from UTC <input name="registeredFrom" placeholder="2026-08-22T00:00:00.000Z"></label><label>Registered to UTC <input name="registeredTo" placeholder="2026-08-22T23:59:59.999Z"></label>
<label>Activity from UTC <input name="activityFrom" placeholder="2026-08-22T00:00:00.000Z"></label><label>Activity to UTC <input name="activityTo" placeholder="2026-08-22T23:59:59.999Z"></label>
<label><input type="checkbox" name="neverActive" value="true"> Never active</label>
<label>Sort <select name="sort"><option value="registered_at">Registered</option><option value="last_activity_at">Last activity</option><option value="display_name">Display name</option></select></label>
<label>Direction <select name="direction"><option value="desc">Newest / Z-A</option><option value="asc">Oldest / A-Z</option></select></label>
<label>Page size <input name="limit" type="number" min="1" max="100" value="50"></label>
<button class="md-button" type="submit">Apply bounded view</button></form></section>
<section class="md-card"><div style="overflow:auto"><table><thead><tr><th>Principal</th><th>Account</th><th>Registered</th><th>Last web</th><th>Last MCP</th><th>Last activity</th><th>Support counts</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No accounts match this bounded view.</td></tr>'}</tbody></table></div>${nextLink}</section>
</main></body></html>`;
}
