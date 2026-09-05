(() => {
  const shell = document.querySelector("[data-mind-diary-shell]");
  if (!shell) return;
  if (shell.matches('[data-management-view="list"]')) {
    // One top-layer tooltip: no sticky per-icon disclosure or ancestor clipping.
    const statusTooltip = document.createElement("div");
    statusTooltip.id = "mind-status-tooltip";
    statusTooltip.className = "md-mind-status__tooltip";
    statusTooltip.setAttribute("role", "tooltip");
    statusTooltip.setAttribute("popover", "manual");
    document.body.append(statusTooltip);
    let statusTrigger = null;
    let hoveredStatus = null;
    let suppressedHover = null;
    const hideStatusTooltip = () => {
      statusTrigger?.removeAttribute("aria-describedby");
      statusTrigger = null;
      if (statusTooltip.matches(":popover-open")) statusTooltip.hidePopover();
    };
    const statusButton = target => target instanceof Element
      ? target.closest("button.md-mind-status") : null;
    const showStatusTooltip = button => {
      if (!button || !shell.contains(button)) return;
      if (statusTrigger === button && statusTooltip.matches(":popover-open")) return;
      hideStatusTooltip();
      statusTrigger = button;
      statusTooltip.textContent = button.getAttribute("aria-label");
      button.setAttribute("aria-describedby", statusTooltip.id);
      statusTooltip.showPopover();
      const anchor = button.getBoundingClientRect();
      const tip = statusTooltip.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - tip.width - 8, anchor.left + (anchor.width - tip.width) / 2));
      const preferredTop = anchor.top - tip.height - 6;
      const top = preferredTop >= 8 ? preferredTop : anchor.bottom + 6;
      statusTooltip.style.left = `${left}px`;
      statusTooltip.style.top = `${Math.max(8, Math.min(innerHeight - tip.height - 8, top))}px`;
    };
    const hoverStatus = event => {
      if (event.pointerType === "touch") return;
      const button = statusButton(event.target);
      if (!button) return;
      if (hoveredStatus !== button) suppressedHover = null;
      hoveredStatus = button;
      if (suppressedHover !== button) showStatusTooltip(button);
    };
    shell.addEventListener("pointerover", hoverStatus);
    shell.addEventListener("pointermove", hoverStatus);
    shell.addEventListener("pointerout", event => {
      if (event.pointerType === "touch") return;
      const button = statusButton(event.target);
      if (button && !button.contains(event.relatedTarget)) {
        if (hoveredStatus === button) hoveredStatus = null;
        if (suppressedHover === button) suppressedHover = null;
        if (statusTrigger === button) hideStatusTooltip();
      }
    });
    shell.addEventListener("focusin", event => {
      const button = statusButton(event.target);
      showStatusTooltip(button);
    });
    shell.addEventListener("focusout", event => {
      const button = statusButton(event.target);
      if (button === statusTrigger && button !== hoveredStatus) hideStatusTooltip();
    });
    document.addEventListener("click", event => {
      const button = statusButton(event.target);
      if (button) {
        suppressedHover = null;
        showStatusTooltip(button);
      } else hideStatusTooltip();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        suppressedHover = hoveredStatus;
        hideStatusTooltip();
      }
    });
    document.addEventListener("scroll", hideStatusTooltip, true);
    window.addEventListener("resize", hideStatusTooltip);
  }
  const menu = shell.querySelector("[data-menu-button]");
  const navigation = shell.querySelector("[data-navigation]");
  const backdrop = shell.querySelector("[data-navigation-backdrop]");
  const wide = window.matchMedia("(min-width: 1024px)");
  const focusable = () => navigation
    ? [...navigation.querySelectorAll("[data-ia-nav-item]")]
      .filter((element) => !element.hasAttribute("disabled"))
    : [];
  const syncNavigation = (open = shell.dataset.navOpen === "true") => {
    if (!menu || !navigation) return;
    if (wide.matches) {
      shell.dataset.navOpen = "false";
      menu.setAttribute("aria-expanded", "false");
      navigation.removeAttribute("inert");
      navigation.removeAttribute("aria-hidden");
      if (backdrop) backdrop.hidden = true;
      return;
    }
    shell.dataset.navOpen = String(open);
    menu.setAttribute("aria-expanded", String(open));
    navigation.toggleAttribute("inert", !open);
    navigation.setAttribute("aria-hidden", String(!open));
    if (backdrop) backdrop.hidden = !open;
  };
  const closeNavigation = (returnFocus = false) => {
    syncNavigation(false);
    if (returnFocus) menu?.focus();
  };
  syncNavigation(false);
  wide.addEventListener?.("change", () => syncNavigation(false));
  const toggleNavigation = () => {
    const open = shell.dataset.navOpen !== "true";
    syncNavigation(open);
    if (open) requestAnimationFrame(() => requestAnimationFrame(() => {
      navigation
        ?.querySelector("[data-ia-nav-item='my-mind']")
        ?.focus({ preventScroll: true });
    }));
  };
  menu?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleNavigation();
  });
  menu?.addEventListener("click", () => {
    toggleNavigation();
  });
  backdrop?.addEventListener("click", () => closeNavigation(true));
  navigation?.addEventListener("click", (event) => {
    if (!wide.matches && event.target instanceof Element && event.target.closest("a")) {
      closeNavigation(false);
    }
  });
  shell.addEventListener("keydown", (event) => {
    const openDialogs = shell.querySelectorAll("dialog[open]");
    const dialog = openDialogs.item(openDialogs.length - 1);
    if (event.key === "Escape" && dialog) {
      event.preventDefault();
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      return;
    }
    if (!wide.matches && shell.dataset.navOpen === "true") {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation(true);
        return;
      }
      if (event.key === "Tab") {
        const items = focusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  });
})();
