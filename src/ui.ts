import { el } from "./util";

export type MenuItem =
  | { label: string; key?: string; action?: () => void; disabled?: boolean; checked?: boolean; danger?: boolean; font?: string; icon?: string; children?: MenuItem[] }
  | { heading: string }
  | "sep";

let openMenu: { close: () => void } | null = null;

export function closeMenus() {
  openMenu?.close();
}

const CHEVRON = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M6.25 4.5 9.75 8l-3.5 3.5"/></svg>';

interface Level {
  el: HTMLElement;
  buttons: HTMLButtonElement[];
  hot: number;
  setHot(i: number): void;
  child: Level | null;
  parent: Level | null;
  /** Which button opened the child. */
  childOf: number;
  items: MenuItem[];
}

/**
 * Show a popup menu at (x, y). Closes on pick, Escape, or click outside.
 * Items with `children` open a submenu to the right (or the left, when
 * there isn't room).
 */
export function showMenu(items: MenuItem[], x: number, y: number, onClose?: () => void, dir: "down" | "up" = "down") {
  closeMenus();
  let switchTimer = 0;
  const levels: Level[] = [];

  function build(list: MenuItem[], parent: Level | null): Level {
    const menu = el("div", { class: "menu" + (parent ? " sub" : ""), role: "menu" });
    const lvl: Level = { el: menu, buttons: [], hot: -1, setHot: () => {}, child: null, parent, childOf: -1, items: list };
    const hasChecks = list.some((i) => typeof i === "object" && "label" in i && i.checked !== undefined);
    const hasIcons = list.some((i) => typeof i === "object" && "label" in i && i.icon);
    for (const it of list) {
      if (it === "sep") { menu.append(el("div", { class: "sep" })); continue; }
      if ("heading" in it) { menu.append(el("div", { class: "heading", text: it.heading })); continue; }
      const icon = hasIcons ? el("span", { class: "icon" }) : null;
      if (icon && it.icon) icon.innerHTML = it.icon;
      const more = it.children ? el("span", { class: "more" }) : null;
      if (more) more.innerHTML = CHEVRON;
      const b = el("button", { class: "item" + (it.danger ? " danger" : "") + (it.children ? " parent" : ""), role: "menuitem" },
        hasChecks ? el("span", { class: "check", text: it.checked ? "✓" : "" }) : null,
        icon,
        el("span", { class: "label", text: it.label, ...(it.font ? { style: `font-family: "${it.font}", var(--font-ui)` } : {}) }),
        it.key ? el("span", { class: "key", text: it.key }) : null,
        more,
      );
      if (it.disabled) b.disabled = true;
      const idx = lvl.buttons.length;
      b.addEventListener("click", () => {
        if (it.children) { openChild(lvl, idx, true); return; }
        close(); it.action?.();
      });
      b.addEventListener("mouseenter", () => {
        lvl.setHot(idx);
        clearTimeout(switchTimer);
        // A short pause, so moving diagonally into an open submenu doesn't
        // close it on the way past other items.
        switchTimer = window.setTimeout(() => {
          if (it.children && !it.disabled) openChild(lvl, idx, false);
          else closeChild(lvl);
        }, lvl.child ? 160 : it.children ? 60 : 0);
      });
      lvl.buttons.push(b);
      menu.append(b);
    }
    lvl.setHot = (i: number) => {
      lvl.buttons.forEach((b, j) => b.classList.toggle("hot", j === i));
      lvl.hot = i;
    };
    // Leaving the menu clears the highlight (keyboard navigation sets it again),
    // except on the item whose submenu is open.
    menu.addEventListener("mouseleave", () => { if (!lvl.child) lvl.setHot(-1); });
    menu.addEventListener("mouseenter", () => {
      clearTimeout(switchTimer);
      if (lvl.parent) lvl.parent.setHot(lvl.parent.childOf);
    });
    document.body.append(menu);
    levels.push(lvl);
    return lvl;
  }

  function closeChild(lvl: Level) {
    if (!lvl.child) return;
    closeChild(lvl.child);
    lvl.child.el.remove();
    levels.splice(levels.indexOf(lvl.child), 1);
    lvl.buttons[lvl.childOf]?.classList.remove("open");
    lvl.child = null;
    lvl.childOf = -1;
  }

  function openChild(lvl: Level, idx: number, focusFirst: boolean) {
    if (lvl.childOf === idx && lvl.child) { if (focusFirst) firstHot(lvl.child); return; }
    closeChild(lvl);
    const it = lvl.items.filter((i) => i !== "sep" && !("heading" in (i as object)))[idx] as Extract<MenuItem, { label: string }>;
    if (!it?.children) return;
    const child = build(it.children, lvl);
    lvl.child = child;
    lvl.childOf = idx;
    const btn = lvl.buttons[idx];
    btn.classList.add("open");
    const br = btn.getBoundingClientRect();
    const pr = lvl.el.getBoundingClientRect();
    const r = child.el.getBoundingClientRect();
    // Right of the parent if it fits, else to its left.
    let left = pr.right + 4;
    if (left + r.width > window.innerWidth - 6) left = Math.max(6, pr.left - r.width - 4);
    const top = Math.max(6, Math.min(br.top - 5, window.innerHeight - r.height - 6));
    child.el.style.left = left + "px";
    child.el.style.top = top + "px";
    if (focusFirst) firstHot(child);
  }

  function firstHot(lvl: Level) {
    const i = lvl.buttons.findIndex((b) => !b.disabled);
    if (i >= 0) lvl.setHot(i);
  }

  const root = build(items, null);
  const menu = root.el;

  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  const vx = Math.min(x, window.innerWidth - r.width - 6);
  const vy = dir === "up" ? Math.max(6, y - r.height) : y + r.height > window.innerHeight - 6 ? Math.max(6, y - r.height) : y;
  menu.style.left = Math.max(6, vx) + "px";
  menu.style.top = vy + "px";

  /** The deepest level with a highlighted item (keyboard focus). */
  function focused(): Level {
    let l = root;
    while (l.child && l.child.hot >= 0) l = l.child;
    return l;
  }

  function onKey(e: KeyboardEvent) {
    const lvl = focused();
    const enabled = lvl.buttons.filter((b) => !b.disabled);
    const it = lvl.hot >= 0 ? (lvl.items.filter((i) => i !== "sep" && !("heading" in (i as object)))[lvl.hot] as Extract<MenuItem, { label: string }>) : null;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (lvl.parent) { const p = lvl.parent; closeChild(p); p.setHot(p.hot); } else close();
    }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      if (!enabled.length) return;
      const cur = enabled.indexOf(lvl.buttons[lvl.hot]);
      const next = e.key === "ArrowDown" ? (cur + 1) % enabled.length : (cur - 1 + enabled.length) % enabled.length;
      lvl.setHot(lvl.buttons.indexOf(enabled[next]));
      if (lvl.child) closeChild(lvl);
    }
    else if (e.key === "ArrowRight" && it?.children && !it.disabled) { e.preventDefault(); e.stopPropagation(); openChild(lvl, lvl.hot, true); }
    else if (e.key === "ArrowLeft" && lvl.parent) { e.preventDefault(); e.stopPropagation(); const p = lvl.parent; closeChild(p); }
    else if (e.key === "Enter" && lvl.hot >= 0) { e.preventDefault(); e.stopPropagation(); lvl.buttons[lvl.hot].click(); }
  }
  function onDown(e: PointerEvent) { if (!levels.some((l) => l.el.contains(e.target as Node))) close(); }
  function close() {
    if (!menu.isConnected) return;
    clearTimeout(switchTimer);
    for (const l of levels) l.el.remove();
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
