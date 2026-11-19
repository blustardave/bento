/** The slim tools row under the title bar. */
import { el } from "./util";

/** 16×16 icons drawn with the shared 1.4px stroke style (see .ico in CSS). */
export const ICONS = {
  undo: '<path d="M5.75 3.75 3 6.5l2.75 2.75"/><path d="M3.25 6.5h6a3.5 3.5 0 0 1 0 7H7.5"/>',
  redo: '<path d="M10.25 3.75 13 6.5l-2.75 2.75"/><path d="M12.75 6.5h-6a3.5 3.5 0 0 0 0 7H8.5"/>',
  sortAsc: '<path d="M2.75 4h3.5M2.75 8h5M2.75 12h6.5"/><path d="M12.5 3.25v9.5M10.75 11l1.75 1.75L14.25 11"/>',
  sortDesc: '<path d="M2.75 4h6.5M2.75 8h5M2.75 12h3.5"/><path d="M12.5 3.25v9.5M10.75 11l1.75 1.75L14.25 11"/>',
  filter: '<path d="M2.75 3.5h10.5L9.25 8.25v4.5l-2.5-1.25V8.25Z"/>',
  freeze: '<rect x="2.5" y="3" width="11" height="10" rx="1.75"/><path d="M2.5 6.5h11"/><path d="M5.5 4.75h5" stroke-width="1.6"/>',
  insertRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M8 2.5v4.5M5.75 4.75h4.5"/>',
  insertCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M2.5 8H7M4.75 5.75v4.5"/>',
  deleteRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M6.25 3l3.5 3.5M9.75 3l-3.5 3.5"/>',
  deleteCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M3 6.25l3.5 3.5M6.5 6.25 3 9.75"/>',
  fitWidth: '<path d="M2.75 3v10M13.25 3v10M5 8h6M6.75 6.25 5 8l1.75 1.75M9.25 6.25 11 8l-1.75 1.75"/>',
  sum: '<path d="M11.75 3.5h-7.5L8.5 8l-4.25 4.5h7.5"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.25 13.25"/>',
  caret: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
  alignL: '<path d="M2.75 3.5h10.5M2.75 6.5h6.5M2.75 9.5h10.5M2.75 12.5h6.5"/>',
  alignC: '<path d="M2.75 3.5h10.5M4.75 6.5h6.5M2.75 9.5h10.5M4.75 12.5h6.5"/>',
  alignR: '<path d="M2.75 3.5h10.5M6.75 6.5h6.5M2.75 9.5h10.5M6.75 12.5h6.5"/>',
  vTop: '<path d="M2.75 2.75h10.5M8 13.25V5.75M5.5 8.25 8 5.75l2.5 2.5"/>',
  vMid: '<path d="M2.75 8h10.5M8 2.25v3.25M6.25 3.75 8 5.5l1.75-1.75M8 13.75V10.5M6.25 12.25 8 10.5l1.75 1.75"/>',
  vBot: '<path d="M2.75 13.25h10.5M8 2.75v7.5M5.5 7.75 8 10.25l2.5-2.5"/>',
  wrapOverflow: '<path d="M2.75 3v10M10.5 3v3M10.5 10v3M5 8h8.5M11.5 6l2 2-2 2"/>',
  wrapWrap: '<path d="M2.75 3v10M13.25 3v10M5.25 4.75h4.5a2.25 2.25 0 0 1 0 4.5h-3M8.25 7.75l-1.5 1.5 1.5 1.5M5.25 12.25h2.5"/>',
  wrapClip: '<path d="M2.75 3v10M10.5 3v10M5 8h5.5"/>',
  textColor: '<path d="M4.75 10.5 8 2.75l3.25 7.75M6 7.75h4"/><rect class="swatch" x="2.5" y="12.5" width="11" height="2.25" rx="0.75"/>',
  fill: '<path d="M3.25 6.75 7 3l4.25 4.25-3.6 3.6a1 1 0 0 1-1.4 0L3.25 8.15a1 1 0 0 1 0-1.4ZM3.5 7.25h7.5M12.5 7.75s1 1.15 1 1.75a1 1 0 0 1-2 0c0-.6 1-1.75 1-1.75Z"/><rect class="swatch" x="2.5" y="12.5" width="11" height="2.25" rx="0.75"/>',
  arrowL: '<path d="M10 8H4.5M6.5 6 4.5 8l2 2"/>',
  arrowR: '<path d="M4 8h5.5M7.5 6l2 2-2 2"/>',
  minus: '<path d="M4 8h8"/>',
  plus: '<path d="M8 4v8M4 8h8"/>',
  rotNone: '<path d="M4.25 9.75 7.25 2.75l3 7M5.4 7.25h3.7M2.75 13h9.75M11.25 11.5l1.5 1.5-1.5 1.5"/>',
  rotStack: '<path d="M5.5 2.75h2.5M5.5 6.25h2.5M5.5 9.75h2.5M5.5 13.25h2.5M11.5 3v10M10 11.5l1.5 1.5 1.5-1.5"/>',
  rotUp: '<g transform="rotate(-90 7 8)"><path d="M4 11 7 4l3 7M5.15 8.5h3.7"/></g><path d="M13 13V3M11.5 4.5 13 3l1.5 1.5"/>',
  link: '<path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.75.75M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.75-.75"/>',
  merge: '<path d="M2.75 3v10M13.25 3v10M4.5 8h2.5M9 8h2.5M5.5 6.25 7.25 8 5.5 9.75M10.5 6.25 8.75 8l1.75 1.75"/>',
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
        if (sw) { sw.style.fill = s.swatch ?? "transparent"; sw.style.stroke = s.swatch ? "none" : "currentColor"; sw.style.strokeWidth = "1"; }
      }
    },
  };
}

export const divider = () => el("span", { class: "div" });
export const grow = () => el("span", { class: "grow" });
