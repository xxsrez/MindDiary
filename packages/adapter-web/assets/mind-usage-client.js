(() => {
  const roots = [...document.querySelectorAll("[data-mind-usage-collection], [data-mind-usage-panel]")];
  if (roots.length === 0) return;
  const csrf = document.querySelector('meta[name="mind-diary-csrf-token"]')?.content ?? "";
  const modes = new Set(["disabled", "read", "read_write"]);
  const safeRef = (value) => typeof value === "string" && /^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value);
  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const request = async (method, path, body, idempotencyKey) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") {
      headers["x-csrf-token"] = csrf;
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    }
    const response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok !== true) {
      const error = new Error(payload?.error?.message ?? "Mind usage could not be completed.");
      error.code = payload?.error?.code ?? "operation_failed";
      throw error;
    }
    return payload.data;
  };
  const safeItem = (value) => {
    const personal = value?.is_personal === true;
    const descriptionShape = personal
      ? !Object.hasOwn(value, "description")
      : value?.description === null || (typeof value?.description === "string" && [...value.description].length <= 500);
    if (
      !value || typeof value !== "object" || !safeRef(value.mind_ref) ||
      typeof value.name !== "string" || value.name.length === 0 || value.name.length > 80 ||
      !descriptionShape ||
      typeof value.is_personal !== "boolean" ||
      value.routing_profile !== (personal ? "personal_default" : "description_based") ||
      (personal && value.mind_ref !== "/me") || (!personal && value.mind_ref === "/me") ||
      !["private", "unlisted", "public"].includes(value.visibility) ||
      !["reader", "editor", "admin", "owner"].includes(value.role) ||
      !modes.has(value.usage_mode) ||
      typeof value.effective?.can_read !== "boolean" ||
      typeof value.effective?.can_write !== "boolean" ||
      value.eligibility?.can_read !== true ||
      typeof value.eligibility?.can_write !== "boolean" ||
      typeof value.eligibility?.description_required !== "boolean"
    ) return null;
    return value;
  };
  const safeProjection = (value) => {
    if (
      !value || typeof value !== "object" ||
      value.contract_version !== "principal-mind-usage/v2" ||
      !Number.isSafeInteger(value.usage_version) || value.usage_version < 0 ||
      !Array.isArray(value.items)
    ) return null;
    const items = value.items.map(safeItem);
    if (items.some((item) => item === null)) return null;
    const refs = new Set(items.map((item) => item.mind_ref));
    const writable = items.filter((item) => item.usage_mode === "read_write");
    if (
      refs.size !== items.length ||
      writable.filter((item) => item.is_personal).length > 1 ||
      writable.filter((item) => !item.is_personal).length > 1
    ) return null;
    return { usageVersion: value.usage_version, items };
  };
  const modeLabel = (mode) => mode === "disabled"
    ? "Off"
    : mode === "read"
      ? "Read only"
      : "Read and write";
  const roleLabel = (role) => role.charAt(0).toUpperCase() + role.slice(1);
  const visibilityCopy = (visibility) => visibility === "private"
    ? "Private — current participants only"
    : visibility === "unlisted"
      ? "Unlisted — signed-in readers with the exact link"
      : "Public — listed for signed-in readers";
  const effectiveCopy = (item) => item.effective.can_write
    ? item.is_personal
      ? "Reading and specifically requested writes are effective for a write-scoped credential."
      : "Read and automatic writes are effective for a write-scoped credential."
    : item.effective.can_read
      ? "Reading is effective for a read-scoped credential; writing is not."
      : "Codex will not use this Mind.";
  const warningCopy = (item) => {
    const warnings = [];
    if (item.eligibility.description_required) {
      warnings.push("Add a routing description before choosing Read and write. Read only still works when you name this Mind directly.");
    }
    if (!item.eligibility.can_write && !item.eligibility.description_required) {
      warnings.push("Your current Mind role does not allow content writes. The configured intent never expands your rights.");
    }
    if (item.visibility !== "private") {
      warnings.push("New successful writes become visible immediately to everyone who has the current signed-in visibility access, including immutable history access.");
    }
    return warnings;
  };
  const modeOption = (item, mode, label, detail) => {
    const wrapper = node("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `usage-mode-${item.mind_ref.replaceAll("/", "-")}`;
    input.value = mode;
    input.checked = item.usage_mode === mode;
    input.disabled = mode === "read_write" && !item.eligibility.can_write;
    const copy = node("span");
    copy.append(node("strong", "", label), document.createElement("br"), document.createTextNode(detail));
    wrapper.append(input, copy);
    return wrapper;
  };
  const card = (root, projection, item) => {
    const article = node("article", "md-usage-card");
    article.dataset.mindUsageCard = item.mind_ref;
    const title = node("h3");
    const link = node("a", "", item.name);
    link.href = item.mind_ref;
    title.append(link);
    const description = node("p", "md-usage-copy", item.is_personal
      ? "My Mind is independent of the ordinary automatic-save destination. Codex uses it only when you name it, and writes only when you directly request a specific change."
      : item.description ?? "No routing description. Semantic matching is unavailable.");
    const metadata = node("dl", "md-card__metadata");
    const definition = (term, value) => {
      const group = node("div");
      group.append(node("dt", "", term), node("dd", "", value));
      return group;
    };
    metadata.append(
      definition("Configured intent", modeLabel(item.usage_mode)),
      definition("Current role", roleLabel(item.role)),
      definition("Effective now", item.effective.can_write ? "Read + write" : item.effective.can_read ? "Read" : "Off"),
      definition("Visibility", visibilityCopy(item.visibility)),
    );
    const form = node("form");
    form.dataset.mindUsageForm = "";
    form.dataset.mindRef = item.mind_ref;
    form.dataset.usageVersion = String(projection.usageVersion);
    form.dataset.currentMode = item.usage_mode;
    const fieldset = node("fieldset", "md-usage-mode");
    fieldset.append(
      node("legend", "", "Agent mode"),
      modeOption(item, "disabled", "Off", "Do not expose this Mind to Codex."),
      modeOption(item, "read", "Read only", item.is_personal
        ? "Use it when you name My Mind directly."
        : "Use it when you name it or its description matches the topic."),
      modeOption(item, "read_write", "Read and write", item.is_personal
        ? "Allow only the specific saves, updates, or deletions you directly ask Codex to make."
        : "Also save discussed durable knowledge that matches this description."),
    );
    const effective = node("p", "md-usage-effective", effectiveCopy(item));
    const warnings = warningCopy(item);
    const warningList = warnings.length === 0 ? null : node("div", "md-usage-warning");
    if (warningList) {
      const list = node("ul");
      for (const warning of warnings) list.append(node("li", "", warning));
      warningList.append(list);
    }
    const receipt = node("p", "md-usage-copy", item.is_personal
      ? "After a requested write, Codex should report what changed in My Mind after server read-back."
      : "After an automatic write, Codex should report what changed and which Mind received it, after server read-back.");
    const actions = node("div", "md-usage-actions");
    const submit = node("button", "md-button md-button--primary", "Save agent mode");
    submit.type = "submit";
    submit.disabled = true;
    const status = node("p", "md-form__status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.dataset.mindUsageStatus = "";
    actions.append(submit, status);
    form.append(fieldset, effective);
    if (warningList) form.append(warningList);
    form.append(receipt, actions);
    form.addEventListener("change", () => {
      const selected = form.querySelector('input[type="radio"]:checked')?.value ?? "";
      submit.disabled = !modes.has(selected) || selected === form.dataset.currentMode;
      const otherWritable = projection.items.find((candidate) =>
        candidate.usage_mode === "read_write" &&
        candidate.is_personal === item.is_personal &&
        candidate.mind_ref !== item.mind_ref);
      status.textContent = selected === "read_write" && otherWritable
        ? `Saving will atomically move ${otherWritable.name} to Read only.`
        : "";
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const selected = form.querySelector('input[type="radio"]:checked')?.value ?? "";
      const expected = Number(form.dataset.usageVersion);
      if (!modes.has(selected) || !Number.isSafeInteger(expected) || expected < 0) return;
      submit.disabled = true;
      fieldset.disabled = true;
      status.textContent = "Saving and reading back current account-wide intent…";
      const pathRef = item.mind_ref === "/me" ? "me" : item.mind_ref.slice(1);
      try {
        const result = await request(
          "PUT",
          `/api/v1/minds/${encodeURIComponent(pathRef)}/usage`,
          { usage_mode: selected, expected_usage_version: expected },
          `mind-usage:${crypto.randomUUID()}`,
        );
        const fresh = safeProjection(result?.projection);
        if (!fresh) throw new Error("The updated intent could not be read back safely.");
        render(root, fresh, result.changed === false
          ? "The server confirmed that this mode was already current."
          : "Agent intent saved and read back from the server.");
      } catch (error) {
        const conflict = error?.code === "usage_conflict";
        if (conflict) {
          await load(root, "Intent changed in another session. Current server settings were reloaded.");
          return;
        }
        fieldset.disabled = false;
        submit.disabled = false;
        status.textContent = error?.code === "description_required"
          ? "Add and save a routing description, then reload current settings before choosing Read and write."
          : error?.code === "usage_not_allowed"
            ? "Current access no longer allows this mode. Reload the page to review rights."
            : error?.message ?? "Agent intent was not changed.";
      }
    });
    article.append(title, description, metadata, form);
    return article;
  };
  const state = (root) => root.querySelector("[data-mind-usage-state]");
  const render = (root, projection, announcement = "") => {
    document.dispatchEvent(new CustomEvent("mind-diary:usage-updated", { detail: projection }));
    const exactRef = root.dataset.mindRef;
    const items = exactRef ? projection.items.filter((item) => item.mind_ref === exactRef) : projection.items;
    const current = state(root);
    if (!current || items.length === 0) throw new Error("Current Mind usage is unavailable.");
    const next = node("section");
    next.dataset.mindUsageState = "";
    next.dataset.usageVersion = String(projection.usageVersion);
    if (announcement) {
      const notice = node("p", "md-announcement", announcement);
      notice.setAttribute("role", "status");
      next.append(notice);
    }
    const grid = node("div", "md-usage-grid");
    for (const item of items) grid.append(card(root, projection, item));
    next.append(grid);
    current.replaceWith(next);
  };
  const renderError = (root, message) => {
    const current = state(root);
    if (!current) return;
    const next = node("section", "md-state md-state--error");
    next.dataset.mindUsageState = "";
    next.setAttribute("role", "alert");
    next.append(node("h3", "", "Agent intent is unavailable"), node("p", "", message));
    const retry = node("button", "md-button md-button--secondary", "Reload current settings");
    retry.type = "button";
    retry.addEventListener("click", () => void load(root));
    next.append(retry);
    current.replaceWith(next);
  };
  const load = async (root, announcement = "") => {
    const exactRef = root.dataset.mindRef;
    const endpoint = exactRef
      ? `/api/v1/minds/${encodeURIComponent(exactRef === "/me" ? "me" : exactRef.slice(1))}/usage`
      : "/api/v1/mind-usage";
    try {
      const projection = safeProjection(await request("GET", endpoint));
      if (!projection) throw new Error("Invalid Mind usage response.");
      render(root, projection, announcement);
    } catch {
      renderError(root, "Nothing was changed. Reload to check the current account-wide modes.");
    }
  };
  for (const root of roots) {
    const disclosure = root.closest("details[data-agent-settings-disclosure]");
    let started = false;
    const loadWhenVisible = () => {
      if (started || (disclosure && !disclosure.open)) return;
      started = true;
      disclosure?.removeEventListener("toggle", loadWhenVisible);
      void load(root);
    };
    disclosure?.addEventListener("toggle", loadWhenVisible);
    loadWhenVisible();
  }
})();
