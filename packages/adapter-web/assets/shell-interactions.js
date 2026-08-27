(() => {
  const shell = document.querySelector("[data-mind-diary-shell]");
  if (!shell) return;
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
