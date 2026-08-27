const visibilityShell = document.querySelector("[data-mind-diary-visibility-catalog]");
const visibilityElement = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const safeCatalogCursor = (value) =>
  value === null || (typeof value === "string" && /^mdc1_[A-Za-z0-9_-]{1,251}$/.test(value))
    ? value
    : undefined;
const visibilityRequest = async (cursor = null) => {
  const path = `/api/v1/public-minds?limit=24${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok || payload?.ok !== true) throw new Error("Public Minds are unavailable");
  const nextCursor = safeCatalogCursor(payload.next_cursor);
  if (!Array.isArray(payload.data?.minds) || nextCursor === undefined) {
    throw new Error("Invalid Public Mind catalog");
  }
  return { minds: payload.data.minds, nextCursor };
};
const safePublicMind = (value) => {
  if (
    !value || typeof value !== "object" ||
    typeof value.mind_id !== "string" ||
    typeof value.name !== "string" || value.name.length === 0 ||
    typeof value.route !== "string" || !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.route) ||
    typeof value.summary !== "string" || [...value.summary].length > 180 ||
    value.is_personal !== false || value.visibility !== "public" ||
    value.discovery !== "public_catalog"
  ) return null;
  return { id: value.mind_id, name: value.name, route: value.route, summary: value.summary };
};
const publicCollection = (kind, minds = [], nextCursor = null) => {
  const section = visibilityElement(
    "section",
    kind === "error" ? "md-state md-state--error" : kind === "empty" ? "md-state md-state--empty" : "",
  );
  section.dataset.publicCatalogCollection = "";
  section.setAttribute("aria-labelledby", "public-minds-heading");
  if (kind === "ready") {
    const heading = visibilityElement("div", "md-section-heading");
    const copy = visibilityElement("div");
    copy.append(visibilityElement("p", "md-eyebrow", "Authenticated catalog"));
    const h2 = visibilityElement("h2", "", "Public Minds");
    h2.id = "public-minds-heading";
    copy.append(h2);
    heading.append(copy);
    const grid = visibilityElement("div", "md-card-grid");
    grid.dataset.publicMindList = "";
    for (const mind of minds) {
      const article = visibilityElement("article", "md-card md-entity-row");
      article.dataset.publicMindCard = mind.id;
      const topline = visibilityElement("div", "md-card__topline");
      const state = visibilityElement("span", "md-status md-status--public");
      const icon = visibilityElement("span", "md-status__icon", "Globe");
      icon.setAttribute("aria-hidden", "true");
      state.append(icon, document.createTextNode(" Public — signed-in readers"));
      topline.append(state);
      const title = visibilityElement("h3");
      const link = visibilityElement("a", "", mind.name);
      link.href = mind.route;
      title.append(link);
      article.append(
        topline,
        title,
        visibilityElement("p", "md-card__description", mind.summary),
        visibilityElement(
          "p",
          "md-caveat",
          "Live HEAD and immutable history are readable. Content changes remain unavailable without Editor membership.",
        ),
      );
      grid.append(article);
    }
    section.append(heading, grid);
    if (nextCursor !== null) {
      const more = visibilityElement("button", "md-button md-button--secondary", "Load more");
      more.type = "button";
      more.dataset.publicCatalogMore = "";
      section.append(more);
    }
    return section;
  }
  if (kind === "error") section.setAttribute("role", "alert");
  const symbol = visibilityElement("span", "md-state__symbol", kind === "error" ? "!" : "◎");
  symbol.setAttribute("aria-hidden", "true");
  const heading = visibilityElement("h2", "", kind === "error" ? "We couldn’t open Public Minds" : "No Public Minds yet");
  heading.id = "public-minds-heading";
  section.append(
    symbol,
    heading,
    visibilityElement(
      "p",
      "",
      kind === "error"
        ? "Public Minds are unavailable. No private metadata was returned."
        : "Private, unlisted, and Personal Minds never appear here.",
    ),
  );
  if (kind === "error") {
    const retry = visibilityElement("button", "md-button md-button--secondary", "Try again");
    retry.type = "button";
    retry.dataset.publicCatalogRetry = "";
    section.append(retry);
  }
  return section;
};
let publicPending = false;
let publicMinds = [];
let publicNextCursor = null;
const loadPublicMinds = async (append = false) => {
  const current = visibilityShell?.querySelector("[data-public-catalog-collection]");
  if (!current || publicPending) return;
  publicPending = true;
  const button = current.querySelector("[data-public-catalog-more]");
  if (button) button.disabled = true;
  try {
    const page = await visibilityRequest(append ? publicNextCursor : null);
    const pageMinds = page.minds.map(safePublicMind).filter(Boolean);
    const candidates = append ? [...publicMinds, ...pageMinds] : pageMinds;
    const seen = new Set();
    publicMinds = candidates.filter((mind) => {
      const identity = `${mind.id}\u0000${mind.route}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    publicNextCursor = page.nextCursor;
    current.replaceWith(publicCollection(publicMinds.length === 0 ? "empty" : "ready", publicMinds, publicNextCursor));
  } catch {
    publicMinds = [];
    publicNextCursor = null;
    current.replaceWith(publicCollection("error"));
  } finally {
    publicPending = false;
  }
};
visibilityShell?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("[data-public-catalog-retry]")) void loadPublicMinds(false);
  if (target?.closest("[data-public-catalog-more]") && publicNextCursor !== null) void loadPublicMinds(true);
});
if (visibilityShell?.dataset.pageKind === "catalog") void loadPublicMinds(false);
