(() => {
  const shell = document.querySelector("[data-connections-page],[data-connection-detail],[data-advanced-mcp],[data-codex-help]");
  if (!shell) return;

  const csrf = document.querySelector('meta[name="mind-diary-csrf-token"]')?.getAttribute("content") ?? "";
  const connectionRefPattern = /^conn_v1_[0-9a-f]{32}$/u;
  const cursorPattern = /^[A-Za-z0-9_-]{1,2048}$/u;

  const request = async (endpoint, method, body) => {
    const response = await fetch(endpoint, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": crypto.randomUUID(),
      },
      credentials: "same-origin",
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
    if (!Number.isSafeInteger(value.readable_mind_count) || value.readable_mind_count < 0) return null;
    if (typeof value.writable_mind_selected !== "boolean") return null;
    return value;
  };

  const connectionCard = (item) => {
    const href = `/settings/connections/${encodeURIComponent(item.connection_ref)}`;
    const article = node("article", "md-token-card");
    const heading = node("div", "md-token-card__heading");
    const title = node("div");
    const h3 = node("h3");
    const titleLink = node("a", "", item.client_name);
    titleLink.href = href;
    h3.append(titleLink);
    title.append(h3, node("p", "", "Connected app"));
    heading.append(title, node("span", "md-token-state md-token-state--active", "● Connected"));

    const metadata = node("dl", "md-token-card__metadata");
    metadata.append(
      definition("Can read", item.can_read ? `${item.readable_mind_count} selected` : "No"),
      definition("Can add and change", item.can_write ? (item.writable_mind_selected ? "One Mind selected" : "Not selected") : "No"),
      definition("Connected", dateLabel(item.created_at)),
      definition("Last used", dateLabel(item.last_used_at)),
    );
    const action = node("p");
    const manage = node("a", "md-button md-button--secondary", "Manage access");
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
    const grid = node("div", "md-token-grid");
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

  const mutate = async (panel, action, values = {}) => {
    const endpoint = panel.dataset.accessEndpoint ?? "";
    const expected = Number(panel.dataset.bindingVersion ?? "NaN");
    const status = panel.querySelector("[data-access-status]");
    if (!endpoint.startsWith("/api/v1/") || !Number.isSafeInteger(expected) || expected < 0) return;
    panel.setAttribute("aria-busy", "true");
    say(status, "Saving current Mind access…");
    try {
      await request(endpoint, "PATCH", { action, expected_binding_version: expected, ...values });
      location.reload();
    } catch (error) {
      say(status, error?.code === "write_step_up_required"
        ? "Ask Codex to add or change a Memory to start the separate write permission step."
        : error?.code?.includes("stale") || error?.code?.includes("conflict")
          ? "Access changed in another session. Reload before trying again."
          : error?.message ?? "Mind access could not be changed.");
      panel.removeAttribute("aria-busy");
    }
  };

  shell.addEventListener("submit", async (event) => {
    const accessForm = event.target.closest?.("[data-access-form]");
    if (accessForm) {
      event.preventDefault();
      const panel = accessForm.closest("[data-access-panel]");
      const action = accessForm.dataset.accessAction ?? "";
      const mindRef = new FormData(accessForm).get("mind_ref");
      if (panel && typeof mindRef === "string" && mindRef) await mutate(panel, action, { mind_ref: mindRef });
      return;
    }
    const tokenForm = event.target.closest?.("[data-personal-token-form]");
    if (!tokenForm) return;
    event.preventDefault();
    const data = new FormData(tokenForm);
    const name = String(data.get("name") ?? "");
    const scope = String(data.get("scope") ?? "");
    const days = Number(data.get("expiry_days") ?? "90");
    const status = tokenForm.querySelector("[data-token-form-status]");
    say(status, "Creating a personal token…");
    try {
      const payload = await request("/api/v1/mcp-tokens", "POST", {
        name,
        scopes: [scope],
        expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      });
      const dialog = shell.querySelector("[data-secret-dialog]");
      const value = dialog?.querySelector("[data-secret-value]");
      if (value) value.textContent = payload?.secret ?? "";
      if (dialog) {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
      say(status, "Token created. Copy the secret before closing.");
    } catch (error) {
      say(status, error?.message ?? "Token could not be created.");
    }
  });

  shell.addEventListener("click", async (event) => {
    const target = event.target.closest?.("button");
    if (!target) return;
    if (target.hasAttribute("data-connections-retry")) {
      target.disabled = true;
      await loadConnections();
      return;
    }
    const panel = target.closest("[data-access-panel]");
    const action = target.dataset.accessAction;
    if (panel && action) {
      const values = {};
      if (target.dataset.mindRef) values.mind_ref = target.dataset.mindRef;
      if (target.dataset.staleAccessRef) values.stale_access_ref = target.dataset.staleAccessRef;
      await mutate(panel, action, values);
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
    if (target.hasAttribute("data-close-secret")) {
      const dialog = target.closest("dialog");
      const value = dialog?.querySelector("[data-secret-value]");
      if (value) value.textContent = "";
      if (dialog) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
    }
  });

  if (shell.hasAttribute("data-connections-page")) void loadConnections();
})();
