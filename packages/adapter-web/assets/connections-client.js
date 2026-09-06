(() => {
  const shell = document.querySelector("[data-connections-page],[data-connection-detail],[data-advanced-mcp],[data-codex-help]");
  if (!shell) return;

  const csrf = document.querySelector('meta[name="mind-diary-csrf-token"]')?.getAttribute("content") ?? "";
  const connectionRefPattern = /^conn_v1_[0-9a-f]{32}$/u;
  const cursorPattern = /^[A-Za-z0-9_-]{1,2048}$/u;

  const request = async (endpoint, method, body) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") {
      headers["x-csrf-token"] = csrf;
      headers["idempotency-key"] = crypto.randomUUID();
    }
    const response = await fetch(endpoint, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message ?? "The request could not be completed.");
      error.code = payload?.error?.code ?? "operation_failed";
      throw error;
    }
    return payload?.data;
  };

  const say = (element, message) => {
    if (element) element.textContent = message;
  };

  for (const button of shell.querySelectorAll("[data-copy-code]")) {
    button.addEventListener("click", async () => {
      const codeId = button.dataset.copyCode ?? "";
      const code = codeId ? document.getElementById(codeId) : null;
      const region = button.closest("[data-copy-region],details,section,li");
      const status = region?.querySelector("[data-code-copy-status]");
      if (!code?.matches("[data-code-value]") || !status) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        say(status, "Copied. This text contains no token or Site credential.");
      } catch {
        say(status, "Copy was blocked. Select the text and copy it manually.");
        code.focus();
      }
    });
  }

  const clientTabs = [...shell.querySelectorAll("[data-codex-client-tab]")];
  const clientPanels = [...shell.querySelectorAll("[data-codex-client-panel]")];
  const activateClient = (selected, moveFocus) => {
    const client = selected.dataset.codexClientTab;
    for (const tab of clientTabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of clientPanels) panel.hidden = panel.dataset.codexClientPanel !== client;
    if (moveFocus) selected.focus();
  };
  clientTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateClient(tab, false));
    tab.addEventListener("keydown", (event) => {
      let next = null;
      if (event.key === "ArrowRight") next = clientTabs[(index + 1) % clientTabs.length];
      if (event.key === "ArrowLeft") next = clientTabs[(index - 1 + clientTabs.length) % clientTabs.length];
      if (event.key === "Home") next = clientTabs[0];
      if (event.key === "End") next = clientTabs[clientTabs.length - 1];
      if (next === null) return;
      event.preventDefault();
      activateClient(next, true);
    });
  });
  const initialClient = clientTabs.find((tab) => tab.getAttribute("aria-selected") === "true")
    ?? clientTabs[0];
  if (initialClient) activateClient(initialClient, false);

  const dateLabel = (value) => {
    if (value === null) return "Never";
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) return "Unavailable";
    return new Intl.DateTimeFormat("en", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(date);
  };

  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };

  const definition = (term, value) => {
    const wrapper = node("div");
    wrapper.append(node("dt", "", term), node("dd", "", value));
    return wrapper;
  };

  const safeConnection = (value) => {
    if (!value || typeof value !== "object") return null;
    if (!connectionRefPattern.test(value.connection_ref)) return null;
    if (typeof value.client_name !== "string" || value.client_name.length === 0 || value.client_name.length > 200) return null;
    if (typeof value.created_at !== "string" || value.created_at.length > 64) return null;
    if (value.last_used_at !== null && (typeof value.last_used_at !== "string" || value.last_used_at.length > 64)) return null;
    if (typeof value.can_read !== "boolean" || typeof value.can_write !== "boolean") return null;
    return value;
  };

  const connectionCard = (item) => {
    const href = `/settings/connections/${encodeURIComponent(item.connection_ref)}`;
    const article = node("article", "md-token-card md-entity-row md-connection-row");
    article.dataset.iaRow = "";
    const heading = node("div", "md-token-card__heading");
    const title = node("div");
    const h3 = node("h3");
    const titleLink = node("a", "", item.client_name);
    titleLink.href = href;
    h3.append(titleLink);
    title.append(h3);
    heading.append(title, node("span", "md-token-state md-token-state--active", "● Connected"));

    const metadata = node("dl", "md-token-card__metadata");
    metadata.append(
      definition("Read scope", item.can_read ? "Granted" : "No"),
      definition("Write scope", item.can_write ? "Granted" : "No"),
      definition("Connected", dateLabel(item.created_at)),
      definition("Last used", dateLabel(item.last_used_at)),
    );
    const action = node("p");
    const manage = node("a", "md-button md-button--secondary", "View connection");
    manage.href = href;
    action.append(manage);
    article.append(heading, metadata, action);
    return article;
  };

  const replaceConnections = (replacement) => {
    const current = shell.querySelector("[data-connections-collection]");
    if (current) current.replaceWith(replacement);
  };

  const renderConnectionsError = () => {
    const section = node("section", "md-state md-state--error");
    section.dataset.connectionsCollection = "";
    section.dataset.collectionState = "error";
    section.setAttribute("role", "alert");
    section.append(
      node("h2", "", "Connections are unavailable"),
      node("p", "", "Reload to check current connection access."),
    );
    const retry = node("button", "md-button md-button--secondary", "Try again");
    retry.type = "button";
    retry.dataset.connectionsRetry = "";
    section.append(retry);
    replaceConnections(section);
  };

  const renderConnections = (items, nextCursor) => {
    if (items.length === 0) {
      const section = node("section", "md-state md-state--empty");
      section.dataset.connectionsCollection = "";
      section.dataset.collectionState = "empty";
      section.append(
        node("h2", "", "No active connections"),
        node("p", "", "Install Mind Diary from the available Marketplace, then ask Codex to use one of your Minds. Codex will open the read consent when it first needs access."),
      );
      const guide = node("a", "md-button md-button--primary", "Open the three-step guide");
      guide.href = "/help/codex";
      section.append(guide);
      replaceConnections(section);
      return;
    }

    const section = node("section");
    section.dataset.connectionsCollection = "";
    section.dataset.collectionState = "ready";
    section.setAttribute("aria-labelledby", "connections-heading");
    const heading = node("h2", "", "Active connections");
    heading.id = "connections-heading";
    const grid = node("div", "md-token-grid md-settings-collection");
    grid.append(...items.map(connectionCard));
    section.append(heading, grid);
    if (nextCursor !== null) {
      const paragraph = node("p");
      const next = node("a", "md-button md-button--secondary", "Next connections");
      next.href = `/settings/connections?cursor=${encodeURIComponent(nextCursor)}`;
      paragraph.append(next);
      section.append(paragraph);
    }
    replaceConnections(section);
  };

  const loadConnections = async () => {
    const current = shell.querySelector("[data-connections-collection]");
    if (!current) return;
    current.setAttribute("aria-busy", "true");
    current.dataset.collectionState = "loading";
    const cursor = new URL(location.href).searchParams.get("cursor");
    const endpoint = cursor !== null && cursorPattern.test(cursor)
      ? `/api/v1/connections?cursor=${encodeURIComponent(cursor)}`
      : "/api/v1/connections";
    try {
      const payload = await request(endpoint, "GET");
      if (!Array.isArray(payload?.items) || payload.items.length > 50) throw new Error("Invalid connections response");
      const items = payload.items.map(safeConnection);
      if (items.some((item) => item === null)) throw new Error("Invalid connections response");
      const nextCursor = payload.next_cursor;
      if (nextCursor !== null && (typeof nextCursor !== "string" || !cursorPattern.test(nextCursor))) {
        throw new Error("Invalid connections cursor");
      }
      renderConnections(items, nextCursor);
    } catch {
      renderConnectionsError();
    }
  };

  shell.addEventListener("click", async (event) => {
    const target = event.target.closest?.("button");
    if (!target) return;
    if (target.hasAttribute("data-connections-retry")) {
      target.disabled = true;
      await loadConnections();
      return;
    }
    const revokeEndpoint = target.dataset.revokeEndpoint;
    if (revokeEndpoint) {
      const status = target.parentElement?.querySelector("[data-revoke-status]")
        ?? target.closest("section,article")?.querySelector("[data-revoke-status]");
      target.disabled = true;
      say(status, "Revoking…");
      try {
        await request(revokeEndpoint, "DELETE");
        if (target.hasAttribute("data-revoke-connection")) location.assign("/settings/connections");
        else location.reload();
      } catch (error) {
        target.disabled = false;
        say(status, error?.message ?? "Revocation could not be completed.");
      }
      return;
    }
  });

  if (shell.hasAttribute("data-connections-page")) void loadConnections();
})();
