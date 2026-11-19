/** The slim tools row under the title bar. */
import { el } from "./util";

/** 16×16 icons drawn with the shared 1.4px stroke style (see .ico in CSS). */
export const ICONS = {
  // All drawn on a 16px grid, kept inside roughly 2.5–13.5 so they share one optical size.
  undo: '<path d="M6 3.75 3.25 6.5 6 9.25"/><path d="M3.5 6.5h6a3.25 3.25 0 0 1 0 6.5H7.5"/>',
  redo: '<path d="M10 3.75 12.75 6.5 10 9.25"/><path d="M12.5 6.5h-6a3.25 3.25 0 0 0 0 6.5h2"/>',
  sortAsc: '<path d="M2.75 4.5h3.5M2.75 8h5M2.75 11.5h6.5"/><path d="M12.25 3.5v9M10.5 10.75l1.75 1.75L14 10.75"/>',
  sortDesc: '<path d="M2.75 4.5h6.5M2.75 8h5M2.75 11.5h3.5"/><path d="M12.25 3.5v9M10.5 10.75l1.75 1.75L14 10.75"/>',
  filter: '<path d="M2.75 3.75h10.5l-4 4.75v3.75l-2.5 1.25v-5Z"/>',
  freeze: '<rect x="2.5" y="3" width="11" height="10" rx="1.75"/><path d="M2.5 6.5h11"/>',
  insertRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M8 2.5v4.5M5.75 4.75h4.5"/>',
  insertCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M2.5 8H7M4.75 5.75v4.5"/>',
  deleteRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M6.25 3l3.5 3.5M9.75 3l-3.5 3.5"/>',
  deleteCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M3 6.25l3.5 3.5M6.5 6.25 3 9.75"/>',
  fitWidth: '<path d="M2.75 3.5v9M13.25 3.5v9M5 8h6M6.75 6.25 5 8l1.75 1.75M9.25 6.25 11 8l-1.75 1.75"/>',
  sum: '<path d="M11.5 3.5h-7L8.25 8 4.5 12.5h7"/>',
  search: '<circle cx="7.25" cy="7.25" r="4"/><path d="m10.25 10.25 3 3"/>',
  caret: '<path d="M5.5 6.75 8 9.25l2.5-2.5"/>',
  alignL: '<path d="M3 4h10M3 6.67h6.5M3 9.33h10M3 12h6.5"/>',
  alignC: '<path d="M3 4h10M4.75 6.67h6.5M3 9.33h10M4.75 12h6.5"/>',
  alignR: '<path d="M3 4h10M6.5 6.67H13M3 9.33h10M6.5 12H13"/>',
  vTop: '<path d="M3 3h10M8 13V6M5.75 8.25 8 6l2.25 2.25"/>',
  vMid: '<path d="M3 8h10M8 2.5v3M6.5 4 8 5.5 9.5 4M8 13.5v-3M6.5 12 8 10.5 9.5 12"/>',
  vBot: '<path d="M3 13h10M8 3v7M5.75 7.75 8 10l2.25-2.25"/>',
  wrapOverflow: '<path d="M3 3.5v9M10.5 3.5v2.75M10.5 9.75v2.75M5.25 8h8M11.25 6l2 2-2 2"/>',
  wrapWrap: '<path d="M3 3.5v9M13 3.5v9M5.5 5h4a2 2 0 0 1 0 4H7M8.25 7.75 7 9l1.25 1.25M5.5 11.5h2"/>',
  wrapClip: '<path d="M3 3.5v9M10.5 3.5v9M5.25 8h5.25"/>',
  rotNone: '<path d="M4.25 9.5 7 3l2.75 6.5M5.25 7.25h3.5M3 12.5h9M11 11l1.5 1.5L11 14"/>',
  rotStack: '<path d="M5 3.25h3M5 6.25h3M5 9.25h3M5 12.25h3M11.5 3.5v9M10 11l1.5 1.5L13 11"/>',
  rotUp: '<path d="M9.5 4.5 3 7.25l6.5 2.75M7.25 5.5v3.5M12.5 12.5v-9M11 5l1.5-1.5L14 5"/>',
  link: '<path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.75.75M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.75-.75"/>',
  merge: '<path d="M2.75 3.5v9M13.25 3.5v9M4.5 8h2.25M9.25 8h2.25M5.5 6.25 7.25 8 5.5 9.75M10.5 6.25 8.75 8l1.75 1.75"/>',
  // Colour icons: glyph above, a swatch bar along the bottom.
  textColor: '<path d="M4.75 10 8 2.75 11.25 10M5.9 7.5h4.2"/><rect class="swatch" x="3" y="12.25" width="10" height="2" rx="1"/>',
  fill: '<path d="M7 2.75 11.25 7l-4 4a1 1 0 0 1-1.4 0L3.4 8.6a1 1 0 0 1 0-1.4Z"/><path d="M3.25 7.5h7.75M13 7.75c.55.85.9 1.45.9 1.95a.9.9 0 0 1-1.8 0c0-.5.35-1.1.9-1.95Z"/><rect class="swatch" x="3" y="12.25" width="10" height="2" rx="1"/>',
  arrowL: '<path d="M12 8.5H4.5M6.75 6.25 4.5 8.5l2.25 2.25"/>',
  arrowR: '<path d="M4 8.5h7.5M9.25 6.25l2.25 2.25-2.25 2.25"/>',
  minus: '<path d="M4.5 8h7"/>',
  plus: '<path d="M8 4.5v7M4.5 8h7"/>',
  clearFormat: '<path d="M4 3.25h8M8 3.25 6 12.75M3 13.25l10-10" />',
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGElement {
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstElementChild as SVGElement;
}

export interface ToolButton {
  el: HTMLButtonElement;
  set(state: { disabled?: boolean; on?: boolean; text?: string; icon?: IconName; swatch?: string | null }): void;
}

export function toolButton(opts: {
  icon?: IconName;
  text?: string;
  /** A styled letter (B, I, U, S) instead of an icon. */
  glyph?: string;
  glyphClass?: string;
  title: string;
  caret?: boolean;
  onClick: (b: HTMLButtonElement) => void;
}): ToolButton {
  const b = el("button", { class: "tb", title: opts.title, "aria-label": opts.title });
  let ico: SVGElement | null = opts.icon ? icon(opts.icon) : null;
  if (ico) b.append(ico);
  if (opts.glyph) b.append(el("span", { class: "glyph " + (opts.glyphClass ?? ""), text: opts.glyph }));
  const txt = opts.text !== undefined ? el("span", { class: "txt", text: opts.text }) : null;
  if (txt) b.append(txt);
  if (opts.caret) { const c = icon("caret", 10); c.classList.add("caret"); b.append(c); }
  // Keep keyboard focus in the grid when clicking toolbar buttons.
  b.addEventListener("pointerdown", (e) => e.preventDefault());
  b.addEventListener("click", () => opts.onClick(b));
  return {
    el: b,
    set(s) {
      if (s.disabled !== undefined) b.disabled = s.disabled;
      if (s.on !== undefined) b.classList.toggle("on", s.on);
      if (s.text !== undefined && txt) txt.textContent = s.text;
      if (s.icon && ico) { const n = icon(s.icon); ico.replaceWith(n); ico = n; }
      if (s.swatch !== undefined && ico) {
        const sw = ico.querySelector<SVGRectElement>(".swatch");
        if (sw) { sw.style.fill = s.swatch ?? "var(--line-strong)"; sw.style.stroke = "none"; }
      }
    },
  };
}

export const divider = () => el("span", { class: "div" });
export const grow = () => el("span", { class: "grow" });
