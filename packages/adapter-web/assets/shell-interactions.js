(() => {
  const shell = document.querySelector("[data-mind-diary-shell]");
  if (!shell) return;
  const menu = shell.querySelector("[data-menu-button]");
  const navigation = shell.querySelector("[data-navigation]");
  const closeNavigation = () => {
    shell.dataset.navOpen = "false";
    menu?.setAttribute("aria-expanded", "false");
  };
  menu?.addEventListener("click", () => {
    const open = shell.dataset.navOpen !== "true";
    shell.dataset.navOpen = String(open);
    menu.setAttribute("aria-expanded", String(open));
    if (open) navigation?.querySelector("a")?.focus();
  });
  shell.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const openDialogs = shell.querySelectorAll("dialog[open]");
    const dialog = openDialogs.item(openDialogs.length - 1);
    if (dialog) {
      event.preventDefault();
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      return;
    }
    if (shell.dataset.navOpen === "true") {
      event.preventDefault();
      closeNavigation();
      menu?.focus();
    }
  });
})();
