import { el } from "./util";

export type MenuItem =
  | { label: string; key?: string; action?: () => void; disabled?: boolean; checked?: boolean; danger?: boolean; font?: string }
  | { heading: string }
  | "sep";

let openMenu: { close: () => void } | null = null;

export function closeMenus() {
  openMenu?.close();
}

/** Show a popup menu at (x, y). Closes on pick, Escape, or click outside. */
export function showMenu(items: MenuItem[], x: number, y: number, onClose?: () => void, dir: "down" | "up" = "down") {
  closeMenus();
  const menu = el("div", { class: "menu", role: "menu" });
  const buttons: HTMLButtonElement[] = [];
  const hasChecks = items.some((i) => typeof i === "object" && "label" in i && i.checked !== undefined);
  for (const it of items) {
    if (it === "sep") { menu.append(el("div", { class: "sep" })); continue; }
    if ("heading" in it) { menu.append(el("div", { class: "heading", text: it.heading })); continue; }
    const b = el("button", { class: "item" + (it.danger ? " danger" : ""), role: "menuitem" },
      hasChecks ? el("span", { class: "check", text: it.checked ? "✓" : "" }) : null,
      el("span", { class: "label", text: it.label, ...(it.font ? { style: `font-family: "${it.font}", var(--font-ui)` } : {}) }),
      it.key ? el("span", { class: "key", text: it.key }) : null,
    );
    if (it.disabled) b.disabled = true;
    b.addEventListener("click", () => { close(); it.action?.(); });
    b.addEventListener("mouseenter", () => setHot(buttons.indexOf(b)));
    buttons.push(b);
    menu.append(b);
  }
  // Leaving the menu clears the highlight (keyboard navigation sets it again).
  menu.addEventListener("mouseleave", () => setHot(-1));
  document.body.append(menu);

  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  const vx = Math.min(x, window.innerWidth - r.width - 6);
  const vy = dir === "up" ? Math.max(6, y - r.height) : y + r.height > window.innerHeight - 6 ? Math.max(6, y - r.height) : y;
  menu.style.left = Math.max(6, vx) + "px";
  menu.style.top = vy + "px";

  let hot = -1;
  function setHot(i: number) {
    buttons.forEach((b, j) => b.classList.toggle("hot", j === i));
    hot = i;
  }
  function onKey(e: KeyboardEvent) {
    const enabled = buttons.filter((b) => !b.disabled);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      const cur = enabled.indexOf(buttons[hot]);
      const next = e.key === "ArrowDown" ? (cur + 1) % enabled.length : (cur - 1 + enabled.length) % enabled.length;
      setHot(buttons.indexOf(enabled[next]));
    } else if (e.key === "Enter" && hot >= 0) { e.preventDefault(); e.stopPropagation(); buttons[hot].click(); }
  }
  function onDown(e: PointerEvent) { if (!menu.contains(e.target as Node)) close(); }
  function close() {
    if (!menu.isConnected) return;
    menu.remove();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("blur", close);
    if (openMenu?.close === close) openMenu = null;
    onClose?.();
  }
  setTimeout(() => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", close);
  });
  openMenu = { close };
}

export interface ModalButton<T> { label: string; value: T; primary?: boolean }

/** A small dialog. Resolves with the chosen button's value, or null on Escape. */
export function modal<T>(title: string, message: string, buttons: ModalButton<T>[]): Promise<T | null> {
  closeMenus();
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null;
    const foot = el("div", { class: "foot" });
    const box = el("div", { class: "modal", role: "dialog" }, el("h3", { text: title }), el("p", { text: message }), foot);
    const scrim = el("div", { class: "scrim" }, box);
    let primary: HTMLButtonElement | null = null;
    for (const b of buttons) {
      const btn = el("button", { class: "btn" + (b.primary ? " primary" : ""), text: b.label });
      btn.addEventListener("click", () => done(b.value));
      if (b.primary) primary = btn;
      foot.append(btn);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && primary) { e.preventDefault(); e.stopPropagation(); primary.click(); }
      else e.stopPropagation();
    }
    function done(v: T | null) {
      scrim.remove();
      window.removeEventListener("keydown", onKey, true);
      prev?.focus();
      resolve(v);
    }
    window.addEventListener("keydown", onKey, true);
    document.body.append(scrim);
    (primary ?? foot.querySelector("button"))?.focus();
  });
}

let toastTimer = 0;
export function toast(msg: string, error = false) {
  document.querySelector(".toast")?.remove();
  const t = el("div", { class: "toast" + (error ? " error" : ""), text: msg });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), error ? 5000 : 2400);
}

let openPop: { close: () => void } | null = null;

/** A floating panel under an anchor. Closes on Escape or a click outside. */
export function showPopover(anchor: HTMLElement, content: HTMLElement, onClose?: () => void): () => void {
  closeMenus();
  openPop?.close();
  const pop = el("div", { class: "panel popover" }, content);
  document.body.append(pop);
  const a = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(a.left, window.innerWidth - r.width - 6)) + "px";
  pop.style.top = a.bottom + 4 + "px";
  anchor.classList.add("open");
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }
  function onDown(e: PointerEvent) { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); }
  function close() {
    if (!pop.isConnected) return;
    pop.remove();
    anchor.classList.remove("open");
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
    if (openPop?.close === close) openPop = null;
    onClose?.();
  }
  setTimeout(() => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
  });
  openPop = { close };
  return close;
}
